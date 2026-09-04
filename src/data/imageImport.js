/**
 * imageImport.js —— 2D 地图图片自动识别导入（阶段一：只识别可行走地形）
 *
 * 见 docs/REQUIREMENTS-2026-09-03.md 第四节。用户："最好做一个自动识别导入图片
 * 的模块，给一张标准 2D 地图能直接识别导入。" 用户拍板先只做"可行走地形"识别——
 * 这正是 `src/data/maps/map_navgrids.js` 头注描述的那条手工流程（"拿参考图 →
 * Python/PIL 逐像素判色 → 闭运算去毛刺 → 连通块过滤 → 位打包 → 手动粘贴 base64"）
 * 的自动化版本，算法照抄那条已经验证过能产出可用 navgrid 的流程，只是从离线
 * Python 脚本搬进浏览器现场跑。
 *
 * ==================== 为什么是纯函数、为什么单独一个文件 ====================
 * 与 navgrid.js/mapEditorCore.js 同一个理由：图片像素分类/降噪/连通块过滤这些
 * 逻辑不该埋在 DOM 层（`<canvas>`/`FileReader` 那部分），否则 headless 测试
 * 一行都跑不到。这里的输入是一个纯 `{data, width, height}` 形状的对象
 * （浏览器里就是 `CanvasRenderingContext2D.getImageData()` 的返回值，但测试里
 * 可以直接手工构造一份同形状的假数据，不需要真的起一个 canvas）。
 *
 * 用户点选"这个颜色代表可走"（例如小地图上的浅色路面），而不是让算法瞎猜——
 * 参考图从来不是标准配色表，硬编码一套"什么颜色算可走"的阈值规则，换一张图
 * 大概率就不准；让用户在预览图上点一下取样，判色阈值只处理"多接近这个颜色"，
 * 是本仓库一贯的"不替用户瞎猜，给一个可控的输入"风格（呼应 towerFacing.js
 * 头注里"如果我读反了，改一个值就能整体翻转"那条设计取向）。
 */
import { despeckle } from './navgrid.js';

/**
 * 把整张图片降采样成 n×n 网格，每格取该区域像素的平均色。
 * @param {{data:Uint8ClampedArray, width:number, height:number}} imageData RGBA 四通道
 * @param {number} n 目标网格边长
 * @returns {{r:Uint8Array,g:Uint8Array,b:Uint8Array}} 每个通道长度 n*n，按行优先排列
 */
export function downsampleToGrid(imageData, n) {
  const { data, width, height } = imageData;
  const r = new Uint8Array(n * n), g = new Uint8Array(n * n), b = new Uint8Array(n * n);
  const cellW = width / n, cellH = height / n;
  for (let gy = 0; gy < n; gy++) {
    const y0 = Math.floor(gy * cellH), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.floor(gx * cellW), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let py = y0; py < y1 && py < height; py++) {
        for (let px = x0; px < x1 && px < width; px++) {
          const idx = (py * width + px) * 4;
          sr += data[idx]; sg += data[idx + 1]; sb += data[idx + 2];
          cnt++;
        }
      }
      const k = gy * n + gx;
      if (cnt > 0) { r[k] = sr / cnt; g[k] = sg / cnt; b[k] = sb / cnt; }
    }
  }
  return { r, g, b };
}

/**
 * 按"跟取样色的欧氏距离 ≤ 容差"判定每格是否可走。
 * @param {{r:Uint8Array,g:Uint8Array,b:Uint8Array}} grid downsampleToGrid 的返回值
 * @param {{r:number,g:number,b:number}} sampleColor 用户点选的"可走"参考色
 * @param {number} tolerance 颜色距离容差（0~441.7，即 RGB 立方体对角线长度；
 *   工具层通常用户填的是 0~100 的百分比，换算成这个绝对值再传进来）
 * @returns {Uint8Array} 每格 0/1，长度与 grid 一致
 */
export function classifyWalkable(grid, sampleColor, tolerance) {
  const { r, g, b } = grid;
  const bits = new Uint8Array(r.length);
  const tol2 = tolerance * tolerance;
  for (let k = 0; k < r.length; k++) {
    const dr = r[k] - sampleColor.r, dg = g[k] - sampleColor.g, db = b[k] - sampleColor.b;
    bits[k] = (dr * dr + dg * dg + db * db <= tol2) ? 1 : 0;
  }
  return bits;
}

/**
 * 只保留最大的一块 4 邻域连通可走区域，其余全部判成不可走——过滤掉图例色块、
 * 图片边角噪点、跟主战场不连通的孤立同色区域这类"颜色蒙对了但位置不对"的
 * 误判（呼应 map_navgrids.js 手工流程里的"连通块过滤"那一步）。
 * @param {Uint8Array} bits @param {number} n
 * @returns {Uint8Array} 新数组，不修改输入（与 despeckle 的"原地改"不同——
 *   这一步要先找出全部连通块再比大小，天然需要一份独立于输入的记账，
 *   顺手返回新数组而不是复用输入省一次分配，读起来更直接）。
 */
export function largestConnectedComponent(bits, n) {
  const visited = new Uint8Array(bits.length);
  let bestComp = null, bestSize = 0;
  const stack = [];
  for (let start = 0; start < bits.length; start++) {
    if (bits[start] !== 1 || visited[start]) continue;
    const comp = [];
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % n, y = (i - x) / n;
      const neighbors = [];
      if (x > 0) neighbors.push(i - 1);
      if (x < n - 1) neighbors.push(i + 1);
      if (y > 0) neighbors.push(i - n);
      if (y < n - 1) neighbors.push(i + n);
      for (const j of neighbors) {
        if (bits[j] === 1 && !visited[j]) { visited[j] = 1; stack.push(j); }
      }
    }
    if (comp.length > bestSize) { bestSize = comp.length; bestComp = comp; }
  }
  const out = new Uint8Array(bits.length);
  if (bestComp) for (const i of bestComp) out[i] = 1;
  return out;
}

/**
 * 整条流程：图片 → navgrid。与 map_navgrids.js 手工流程的四步一一对应：
 * 降采样判色（① Python 逐像素判色的浏览器版）→ 连通块过滤（③）→ 去毛刺（②，
 * despeckle 复用 navgrid.js 已有实现，顺序上放在连通块过滤之后——先去掉整块
 * 不该有的杂色区域，再对留下来这块的边缘做锯齿打磨，比反过来更不容易把噪点
 * 判成"小块独立区域"钉在结果里）→ 位打包（④，调用方拿到 bits 后自行调
 * navgrid.js 的 packBits，这里不做——保持"这个模块只管从像素到 0/1 网格"的
 * 单一职责，位打包已经有唯一实现，不重复）。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} imageData
 * @param {{n:number, sampleColor:{r:number,g:number,b:number}, tolerance:number}} opts
 * @returns {{n:number, bits:Uint8Array}}
 */
export function imageToNavgrid(imageData, opts) {
  const { n, sampleColor, tolerance } = opts;
  const grid = downsampleToGrid(imageData, n);
  let bits = classifyWalkable(grid, sampleColor, tolerance);
  bits = largestConnectedComponent(bits, n);
  bits = despeckle(bits, n);
  return { n, bits };
}
