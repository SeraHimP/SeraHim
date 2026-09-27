// navgrid 地图地面边界平滑：类别边界从格子台阶变成等值线，细条保留，开关关掉回到逐格。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { smoothLabelsToRGBA, sampleFieldRGBA } = await import('../src/presentation/smoothLabels.js');
const { CONFIG } = await import('../src/data/Config.js');
const { T, done } = scoreboard('地面边界平滑');

const PAL = [[255, 0, 0, 255], [0, 0, 255, 255]];
const isA = (px, W, x, y) => px[(y * W + x) * 4] === 255;

{
  // 45° 台阶：格 (i,j) 在 i<j 时为 1。放大 8 倍后，每行的边界位置应当逐行平移约 1 像素，
  // 而不是每 8 行跳 8 像素（最近邻放大的样子）。
  const n = 16, S = 8, W = n * S;
  const lab = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lab[j * n + i] = i < j ? 1 : 0;
  const px = smoothLabelsToRGBA(lab, n, n, PAL, W, W);
  const edge = [];
  for (let y = 16; y < W - 16; y++) { let x = 0; while (x < W && !isA(px, W, x, y)) x++; edge.push(x); }
  const maxJump = Math.max(...edge.slice(1).map((e, i) => Math.abs(e - edge[i])));
  T(`①45° 台阶放大后边界逐行平移（最大跳变 ${maxJump} 像素，最近邻会是 ${S}）`, maxJump <= 2);
}
{
  // 1 格宽的细条（例如野区里的窄墙）不能被磨掉。
  const n = 12, S = 8, W = n * S;
  const lab = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) lab[j * n + 6] = 1;
  const px = smoothLabelsToRGBA(lab, n, n, PAL, W, W);
  let ok = true;
  for (let j = 1; j < n - 1; j++) ok = ok && !isA(px, W, 6 * S + S / 2, j * S + S / 2);
  T('②1 格宽的细条保留下来', ok);
  // 孤立单格噪点被磨掉（这正是想要的：逐格数据里的零星毛刺）
  const lab2 = new Uint8Array(n * n); lab2[5 * n + 5] = 1;
  const px2 = smoothLabelsToRGBA(lab2, n, n, PAL, W, W);
  T('③孤立的单格噪点被磨掉', isA(px2, W, 5 * S + S / 2, 5 * S + S / 2));
  const px3 = smoothLabelsToRGBA(lab2, n, n, PAL, W, W, 0);
  T('④blur=0 时单格保留（只插值不模糊）', !isA(px3, W, 5 * S + S / 2, 5 * S + S / 2));
}
{
  // 格心处颜色与该格类别一致（大块区域内部不变色）
  const n = 8, S = 4, W = n * S;
  const lab = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) lab[k] = (k % n) < 4 ? 0 : 1;
  const px = smoothLabelsToRGBA(lab, n, n, PAL, W, W);
  T('⑤大块内部颜色与格类别一致', isA(px, W, 2, 10) && !isA(px, W, W - 3, 10));
  T('⑥输出 alpha 取调色板（挖空类别能透明）',
    smoothLabelsToRGBA(new Uint8Array(4), 2, 2, [[1, 2, 3, 0]], 4, 4)[3] === 0);
}
{
  const f = sampleFieldRGBA((x) => (x < 50 ? 1 : 0), 10, 1, 10, 10, [60, 120, 150], 0.35);
  T('⑦河道场采样：强度按 maxAlpha 缩放', f[3] === Math.round(255 * 0.35) && f[4 * 9 + 3] === 0);
}
{
  const ts = CONFIG.ui.terrainSmooth;
  T('⑧开关和参数都在 CONFIG.ui.terrainSmooth', ts && ts.enabled === true && typeof ts.blur === 'number' && typeof ts.riverSampleWorld === 'number');
  const src = fs.readFileSync(new URL('../src/presentation/TerrainLayer.js', import.meta.url), 'utf8');
  T('⑨TerrainLayer 在开关打开时走 smoothLabelsToRGBA，关闭时保留逐格最近邻路径',
    /if \(smooth\)[\s\S]{0,300}smoothLabelsToRGBA/.test(src) && /imageSmoothingEnabled = false/.test(src));
  T('⑩地面形状按原生 navgrid 重采样（不是从 8 单位格二次量化）', /smoothNavWalk\(map, grid, paint0\)/.test(src));
  const dlg = fs.readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url), 'utf8');
  T('⑪设置面板有开关，并且会重建地形缓存', /setTerrainSmoothBtn/.test(dlg) && /invalidateTerrain/.test(dlg));
  const w = CONFIG.ui.water;
  T('⑫水面涟漪的波数与强度可配', w.rippleWaves === 4 && typeof w.rippleStrength === 'number');
}

done();
