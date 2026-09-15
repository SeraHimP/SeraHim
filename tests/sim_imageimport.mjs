// sim_imageimport.mjs —— 2D 地图图片自动识别导入（imageImport.js）验收
//
// 见 src/data/imageImport.js 头注。这里的输入用手工构造的 {data,width,height}
// 假 RGBA 数据代替真实 <canvas>.getImageData()——形状完全一致，headless 也能测
// 到"降采样判色/连通块过滤/去毛刺"这套核心算法，不需要真的起一个 canvas/图片。
import { scoreboard } from './_harness.mjs';
import {
  downsampleToGrid, classifyWalkable, largestConnectedComponent, imageToNavgrid,
} from '../src/data/imageImport.js';

const { T, done } = scoreboard('图片自动识别导入（imageImport.js）验收');

/** 造一张 W×H 的纯色底图，RGBA 四通道，方便测试里再往上画色块。 */
function mkImage(width, height, bg = { r: 0, g: 0, b: 0 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg.r; data[i * 4 + 1] = bg.g; data[i * 4 + 2] = bg.b; data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}
/** 把矩形区域 [x0,x1) × [y0,y1) 涂成指定颜色。 */
function fillRect(img, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const idx = (y * img.width + x) * 4;
      img.data[idx] = color.r; img.data[idx + 1] = color.g; img.data[idx + 2] = color.b; img.data[idx + 3] = 255;
    }
  }
}

// ==================== ① downsampleToGrid：分块取平均色 ====================
{
  // 8×8 图，左半涂白、右半涂黑，降采样到 2×2：左列该接近白、右列该接近黑。
  const img = mkImage(8, 8, { r: 0, g: 0, b: 0 });
  fillRect(img, 0, 0, 4, 8, { r: 255, g: 255, b: 255 });
  const grid = downsampleToGrid(img, 2);
  T('①downsampleToGrid：左列（原白色区域）平均色接近白', grid.r[0] > 200 && grid.r[2] > 200); // k=0(0,0) k=2(0,1)
  T('①downsampleToGrid：右列（原黑色区域）平均色接近黑', grid.r[1] < 50 && grid.r[3] < 50); // k=1(1,0) k=3(1,1)
}

// ==================== ② classifyWalkable：颜色距离阈值 ====================
{
  const grid = { r: new Uint8Array([255, 200, 0]), g: new Uint8Array([255, 200, 0]), b: new Uint8Array([255, 200, 0]) };
  const sample = { r: 255, g: 255, b: 255 };
  const bits = classifyWalkable(grid, sample, 100); // 容差 100：255 与 200 的欧氏距离 ≈ 95(*sqrt3)... 用具体数字校验
  T('②classifyWalkable：与取样色完全一致 → 可走', bits[0] === 1);
  T('②classifyWalkable：与取样色相差很远（0 vs 255）→ 不可走', bits[2] === 0);
  // 200 与 255 三通道距离 = sqrt(3*55^2) ≈ 95.3，容差 100 时应判可走；容差 50 时应判不可走。
  const bitsWide = classifyWalkable(grid, sample, 100);
  const bitsNarrow = classifyWalkable(grid, sample, 50);
  T('②classifyWalkable：容差调宽 → 相近色判可走', bitsWide[1] === 1);
  T('②classifyWalkable：容差调窄 → 同一格判不可走', bitsNarrow[1] === 0);
}

// ==================== ③ largestConnectedComponent：只留最大连通块 ====================
{
  // 5×5 网格：左上 2×2 一块可走（4格，连通），右下角单独 1 格可走（不连通，应该被滤掉）。
  const n = 5;
  const bits = new Uint8Array(n * n);
  const at = (x, y) => y * n + x;
  bits[at(0, 0)] = 1; bits[at(1, 0)] = 1; bits[at(0, 1)] = 1; bits[at(1, 1)] = 1; // 2x2 块，4格
  bits[at(4, 4)] = 1; // 孤立 1 格
  const out = largestConnectedComponent(bits, n);
  T('③largestConnectedComponent：最大连通块（2x2）保留', out[at(0, 0)] === 1 && out[at(1, 1)] === 1);
  T('③largestConnectedComponent：孤立小块（右下角单格）被滤掉', out[at(4, 4)] === 0);
  T('③largestConnectedComponent：不修改输入数组（返回新数组）', bits[at(4, 4)] === 1);
}

// ==================== ④ imageToNavgrid：整条流程端到端 ====================
{
  // 16×16 图：中间画一个白色十字（连通的可走区），四角各点一个孤立白点（噪点，应被过滤）。
  const img = mkImage(16, 16, { r: 0, g: 0, b: 0 });
  fillRect(img, 6, 0, 10, 16, { r: 255, g: 255, b: 255 }); // 竖条
  fillRect(img, 0, 6, 16, 10, { r: 255, g: 255, b: 255 }); // 横条（与竖条相交成十字，连通）
  fillRect(img, 0, 0, 1, 1, { r: 255, g: 255, b: 255 });   // 左上角孤立噪点
  fillRect(img, 15, 15, 16, 16, { r: 255, g: 255, b: 255 }); // 右下角孤立噪点

  const { n, bits } = imageToNavgrid(img, { n: 16, sampleColor: { r: 255, g: 255, b: 255 }, tolerance: 30 });
  T('④imageToNavgrid：n 原样传回', n === 16);
  T('④imageToNavgrid：十字中心（连通主体）判可走', bits[8 * n + 8] === 1);
  T('④imageToNavgrid：四角孤立噪点被连通块过滤掉（不是主体的一部分）',
    bits[0] === 0 && bits[n * n - 1] === 0);
  T('④imageToNavgrid：背景（黑色区域）判不可走', bits[0 * n + 0] === 0 && bits[2 * n + 2] === 0);
}

done();
