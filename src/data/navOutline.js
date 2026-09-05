/**
 * navOutline.js —— navgrid 位图 → 边界多边形 → 简化/平滑后的折线
 *
 * 设计文档：docs/MAP-DESIGN-howling-abyss-frost.md §8.2.5。
 * 与 `navgrid.js` 同一层的定位：**不依赖 DOM / three / canvas 的纯函数**，
 * 可以在无头 Node 里直接跑断言。渲染是上面一层（TerrainEdgeLayer）的事，
 * 这里只回答一个问题：「可走区域的边界，画成折线长什么样」。
 *
 * ==================== 为什么必须简化，不能逐格摆 ====================
 * navgrid 是 2325/256 ≈ 9 世界单位一格的位图，逐格描出来的边界是**锯齿台阶**
 *（实机截图里肉眼可见）。设计文档 §8.2.4 写死了这条要求：
 *
 *   > 崖壁**绝不能逐 navgrid 格摆**，那样只会把锯齿放大成锯齿墙。
 *
 * 所以这里的流水线是三段，缺一不可：
 *   ① 边界跟踪（收集单位边再串环，见 traceLoops）→ 逐格的闭合环，带一圈锯齿；
 *   ② Douglas–Peucker 简化 → 把台阶压成干净的斜切直线（这一步才是消锯齿的关键）；
 *   ③ Chaikin 圆角（可选）→ 拐角轻微倒角，避免简化后过于生硬。
 *
 * ==================== 坐标约定 ====================
 * 与 `MapSystem._navgrid()` / `paintCircle` 一致：格 (gx, gy) 的**中心**对应世界坐标
 *   wx = (gx + 0.5) * world / n,  wy = (gy + 0.5) * world / n
 * 输出一律是**世界坐标**的点列，调用方不用再自己换算（换算写两遍必然会错一遍）。
 */
import { unpackBits } from './navgrid.js';

/**
 * 边界跟踪：**先收集"内外分界的单位边"，再把边串成环**。
 *
 * ⚠️ 这里原本写的是 Moore 邻域跟踪（沿着格子走），实测**顶点数是应有的 9 倍**
 *    —— 环在细颈处会沿原路折返，同一段边被走两遍，于是 Douglas–Peucker 完全失效
 *   （eps 从 1.2 调到 4.0，顶点只从 16264 掉到 13166，等于没简化）。
 *    根因是"沿格子走"这件事本身：一个格可能被边界经过两次，而折返段的弦长为 0，
 *    DP 对它无能为力。
 *
 * 换成现在这个做法就没有这个问题：边界是**格子之间的缝**，每条缝只存在一次，
 * 天然不会重复；串起来的环每个顶点度数为 2，走一遍就闭合。
 *
 * 顶点用**格点坐标**（0..n），不是格中心：边界本来就落在格与格的缝上。
 *
 * @param {Uint8Array|number[]} bits 每格 0/1，长度 n*n
 * @param {number} n 边长（格）
 * @returns {Array<Array<[number, number]>>} 每条环是格点坐标数组（首尾不重复）
 */
export function traceLoops(bits, n) {
  if (!bits || !n) return [];
  const at = (x, y) => (x < 0 || y < 0 || x >= n || y >= n) ? 0 : bits[y * n + x];
  // 有向边：起点 -> 终点。方向统一取"内部在左手边"，于是外环与洞的绕向相反，
  // 靠 signedArea2 的符号就能分辨内外环，不用另写包含判定。
  //
  // ⚠️⚠️ 这里必须是**多重映射**（一个起点挂一串出边），不能是"起点 → 单条出边"。
  //     两块地在对角相接时（十字细颈），公共的那个格点是**两条**边界边的起点。
  //     v55 初版写成 Map<起点, 单边>、第二条塞进数组的 .alt 字段，而串环的循环
  //     压根没读过 .alt —— 边被静默丢掉，链条于是从一条环的中间窜到另一条环上。
  //     实测后果：冰封图应有 2 条环（两块大陆经桥连成一体 + 洞），实际串出 13 条，
  //     其中 8 条是零面积的横向碎片，环面积代数和 -4275，而正确值必须等于
  //     可走格数 20113。表现就是崖壁"在图上乱飘"—— 一半的崖壁块脚下没有地面。
  const out = new Map();                // "x,y" -> [[x2, y2], ...]
  const key = (x, y) => x + ',' + y;
  const push = (x1, y1, x2, y2) => {
    const k = key(x1, y1);
    const a = out.get(k);
    if (a) a.push([x2, y2]); else out.set(k, [[x2, y2]]);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) push(x + 1, y, x, y);          // 上缝：向 -x
      if (!at(x + 1, y)) push(x + 1, y + 1, x + 1, y);  // 右缝：向 -y
      if (!at(x, y + 1)) push(x, y + 1, x + 1, y + 1);  // 下缝：向 +x
      if (!at(x - 1, y)) push(x, y, x, y + 1);          // 左缝：向 +y
    }
  }
  // ⚠️ 消费的是**边**不是点：同一个格点会被两条环各经过一次，按点标记会让第二条环
  //    刚起步就撞上"已用"而中断。
  const usedEdge = new Set();           // "x1,y1>x2,y2"
  const loops = [];
  for (const [k0, list] of out) {
    for (const e0 of list) {
      if (usedEdge.has(k0 + '>' + key(e0[0], e0[1]))) continue;
      const loop = [];
      let [cx, cy] = k0.split(',').map(Number);
      let tx = e0[0], ty = e0[1];
      let guard = 0;
      while (guard++ < 4 * n * n) {
        const ek = key(cx, cy) + '>' + key(tx, ty);
        if (usedEdge.has(ek)) break;
        usedEdge.add(ek);
        loop.push([cx, cy]);
        const dx = tx - cx, dy = ty - cy;
        const cand = out.get(key(tx, ty));
        if (!cand || !cand.length) break;
        let pick = null;
        if (cand.length === 1) {
          pick = cand[0];
        } else {
          // 十字细颈：公共格点有两条出边，选哪条决定了"对角相接的两块地"算一块还是两块。
          // 固定取**最右转**（叉积最小）：在"内部在左手边"的绕向下，最右转让每块地
          // 各自闭合成一环；取最左转会把两块串成一个 8 字，面积互相抵消。
          let best = Infinity;
          for (const c of cand) {
            const ex = c[0] - tx, ey = c[1] - ty;
            if (ex === -dx && ey === -dy) continue;     // 不原路折返
            const cross = dx * ey - dy * ex;            // >0 左转，0 直行，<0 右转
            if (cross < best) { best = cross; pick = c; }
          }
          if (!pick) pick = cand[0];
        }
        cx = tx; cy = ty; tx = pick[0]; ty = pick[1];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** 点到线段的距离平方（Douglas–Peucker 内部用）。 */
function distSq(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a[0] + t * vx - p[0], dy = a[1] + t * vy - p[1];
  return dx * dx + dy * dy;
}

/**
 * Douglas–Peucker 简化。**这一步才是消锯齿的关键**——把逐格台阶压成斜切直线。
 * @param {Array<[number, number]>} pts 折线（不闭合）
 * @param {number} eps 容差（与点坐标同单位）
 */
export function simplify(pts, eps) {
  if (!pts || pts.length < 3 || !(eps > 0)) return pts ? pts.slice() : [];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const e2 = eps * eps;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bd = e2;
    for (let k = i + 1; k < j; k++) {
      const d = distSq(pts[k], pts[i], pts[j]);
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Chaikin 圆角（闭合环版）。每跑一遍，每条边被 1/4、3/4 两点取代，拐角变钝。
 * 跑太多遍环会整体缩水且顶点爆炸，默认只跑 1 遍。
 *
 * @param {(p:[number,number]) => boolean} [locked] 返回 true 的顶点**原样保留**，不被磨圆。
 *        用途见 navOutline：贴着地图边界的那些直角不是真实地形边缘，是地图自身的裁剪线，
 *        磨圆它们会把两个基地的角啃掉一块（实测漏掉 417 个可走格，全在两个角上）。
 *        不传则行为与原来逐位一致。
 */
export function chaikinClosed(pts, passes = 1, locked = null) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) return cur;
    const out = [];
    const m = cur.length;
    // 逐**顶点**产出它的替代点，而不是逐边产出两点 —— 两者在无锁定时完全等价
    // （顶点 a 被"前一条边的 3/4 点"和"后一条边的 1/4 点"取代），但只有按顶点写
    // 才能对单个顶点做"锁定"。
    for (let i = 0; i < m; i++) {
      const a = cur[i];
      if (locked && locked(a)) { out.push([a[0], a[1]]); continue; }
      const prev = cur[(i - 1 + m) % m], b = cur[(i + 1) % m];
      out.push([prev[0] * 0.25 + a[0] * 0.75, prev[1] * 0.25 + a[1] * 0.75]);
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    }
    cur = out;
  }
  return cur;
}

/** 闭合环的有符号面积×2（>0 = 逆时针）。用来剔掉太小的环、以及判定内外环。 */
export function signedArea2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** 闭合环的周长。 */
export function perimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

/**
 * 主入口：navgrid 位图 → **世界坐标**的平滑闭合轮廓。
 *
 * @param {Uint8Array|number[]} bits
 * @param {number} n
 * @param {number} world 地图世界边长（正方形）
 * @param {object} [opt]
 * @param {number} [opt.simplifyCells=2.2] DP 容差，单位是**格**（换算成世界单位后再用）
 * @param {number} [opt.smoothPasses=1]    Chaikin 遍数
 * @param {number} [opt.minAreaCells=64]   小于这个面积（格²）的环丢掉（噪点/孤格）
 * @param {number} [opt.minLoopCells=8]    环的最小格数
 * @returns {Array<{ pts: Array<[number, number]>, area: number, length: number }>}
 *          按面积从大到小排序，pts 为世界坐标闭合环（首尾不重复）
 */
export function navOutline(bits, n, world, opt = {}) {
  // world 允许是数字，也允许是地图里那种 { w, h }（本仓库的地图都写成后者）。
  // 这里踩过：直接 world / n 会得到 NaN，而 NaN 会一路传到几何里，
  // 表现是"崖壁一块都没有"而不是报错 —— 静默失败最难查，所以显式兼容两种形状。
  const W = (typeof world === 'number') ? world : (world?.w ?? 0);
  const H = (typeof world === 'number') ? world : (world?.h ?? W);
  const cell = W / n, cellY = H / n;
  const simplifyCells = opt.simplifyCells ?? 2.2;
  const smoothPasses = opt.smoothPasses ?? 1;
  const minAreaCells = opt.minAreaCells ?? 64;
  const loops = traceLoops(bits, n);
  const out = [];
  for (const loop of loops) {
    // 面积按**格坐标**算，阈值才好写成"多少格²"，与分辨率无关。
    if (Math.abs(signedArea2(loop)) / 2 < minAreaCells) continue;
    // 简化在格坐标下做，容差直接就是"几格"，直观。
    // ⚠️ DP 对**闭合环**要先断开成折线，否则首尾那一段永远不会被简化。
    //    这里把起点复制到末尾当锚点，简化完再去掉。
    //
    // ⚠️⚠️ 接缝点不能随便取。DP 恒定保留首尾两点，而首尾就是接缝 ——
    //     接缝落在一条直边中间时，**紧挨着它的那个真角会被并进闭合段里丢掉**。
    //     实测：一个 320×240 的矩形，顶点数对（4 个）、包围盒也对，但第一个点是
    //     [170,200] 而不是角点 [160,200]，周长 1110 而不是 1120 —— 角被切了。
    //     修法：先把环旋到「离质心最远的点」当接缝。那个点必定在凸包上、必定是角，
    //     DP 一定会保留它，于是不会有角被接缝吃掉。
    let cx0 = 0, cy0 = 0;
    for (const q of loop) { cx0 += q[0]; cy0 += q[1]; }
    cx0 /= loop.length; cy0 /= loop.length;
    let far = 0, farD = -1;
    for (let i = 0; i < loop.length; i++) {
      const d = (loop[i][0] - cx0) ** 2 + (loop[i][1] - cy0) ** 2;
      if (d > farD) { farD = d; far = i; }
    }
    const rot = loop.slice(far).concat(loop.slice(0, far));
    const open = rot.concat([rot[0]]);
    let s = simplify(open, simplifyCells);
    if (s.length > 1 && s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1]) s.pop();
    if (s.length < 3) continue;
    // 贴着地图边界的顶点锁死：那条边是地图自身的裁剪线，不是地形边缘，磨圆它
    // 等于把基地的角啃掉（见 chaikinClosed 的 locked 参数头注）。
    const EDGE_EPS = 1e-6;
    const onBorder = (q) => q[0] <= EDGE_EPS || q[1] <= EDGE_EPS
                         || q[0] >= n - EDGE_EPS || q[1] >= n - EDGE_EPS;
    if (smoothPasses > 0) s = chaikinClosed(s, smoothPasses, onBorder);
    // 格点 → 世界。注意这里是**格点**（格与格的缝）不是格中心：
    // 边界本来就落在缝上，用格中心会让崖壁整体内缩半格。
    const pts = s.map(([gx, gy]) => [gx * cell, gy * cellY]);
    out.push({ pts, area: Math.abs(signedArea2(pts)) / 2, length: perimeter(pts) });
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * `mapOutline` 的默认参数。**只此一份**——地面底图和崖壁必须用同一条边界，
 * 各自带一套默认值迟早会飘。地图可以在 `terrainEdge` 里覆写。
 */
export const OUTLINE_DEF = { simplifyCells: 2.2, smoothPasses: 1 };

const _outlineCache = new Map();   // map.id -> { map, loops }

/**
 * 地图 → 陆地轮廓（世界坐标闭合环），**全工程唯一的一条陆地边界**。
 *
 * ==================== 为什么必须共用 ====================
 * v55 初版让三处各画各的边界，实测后果（都是量出来的，不是猜的）：
 *   · 能不能走：`map.navgrid`，256 格 = 9.08 世界单位/格；
 *   · 地面底图：`WallLayer` 的 CELL=8 采样网格，从 256 格最近邻重采样
 *     —— 9.08 与 8 两次量化频率不同，会打出**拍频**，锯齿比单纯的台阶更难看；
 *   · 崖壁：在 256 格上追边 → DP → Chaikin 的平滑折线。
 * 平滑折线与 8 单位台阶最大偏离 23 世界单位，而崖壁块厚度只有 16 —— 沿轮廓密采样
 * 2620 点，**29.6% 落在被挖空的地方**，也就是崖壁脚下没有地面。用户看到的现象是
 * "那个条在图上乱飘"。根子是"同一条边界存了三份"，不是参数没调好。
 *
 * 现在这个函数是唯一入口：`TerrainLayer`（画地面）与 `TerrainEdgeLayer`（摆崖壁）
 * 都从这里取，物理上不可能再错开。
 *
 * 轮廓跟着**看得见的地面**走（`visualNavgrid`）而不是可走区域：这两者可以不同，
 * 冰封图故意让视觉地面比可走区域宽一圈，好在墙外留一条不可走的檐。
 *
 * @param {object} map 地图定义；未声明 `terrainEdge` 的地图返回 null（老地图逐位不变）
 * @returns {Array<{pts, area, length}>|null}
 */
export function mapOutline(map) {
  if (!map || !map.terrainEdge) return null;
  const hit = _outlineCache.get(map.id);
  if (hit && hit.map === map) return hit.loops;
  const g = map.visualNavgrid || map.navgrid;
  if (!g || !g.bits || !g.n) return null;
  const bits = unpackBits(g.bits, g.n);
  if (!bits) return null;
  const loops = navOutline(bits, g.n, map.world, {
    simplifyCells: map.terrainEdge.simplifyCells ?? OUTLINE_DEF.simplifyCells,
    smoothPasses: map.terrainEdge.smoothPasses ?? OUTLINE_DEF.smoothPasses,
  });
  _outlineCache.set(map.id, { map, loops });
  return loops;
}

/** 编辑器改了地形要丢缓存（与 TerrainLayer 的 invalidateTerrain 同一时机）。 */
export function invalidateMapOutline(mapId) {
  if (mapId == null) _outlineCache.clear(); else _outlineCache.delete(mapId);
}
