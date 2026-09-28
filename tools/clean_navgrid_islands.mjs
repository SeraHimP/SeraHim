// 清掉 navgrid 里的"不可走噪点"：被可走区完全包住、面积小于阈值的不可走小岛。
//
// 这些是描地形时留下的残渣（扭曲丛林上路路面上就有几块），会真实地挡住小兵，
// 画面上却看不出任何理由。基地高地围墙那一圈（isInBaseWallRing）一律保留。
//
//   node tools/clean_navgrid_islands.mjs --map twisted_treeline_v1 --max-cells 60          # 只报告
//   node tools/clean_navgrid_islands.mjs --map twisted_treeline_v1 --max-cells 60 --write  # 改写地图数据文件
//
// 只改数据文件里那一串 base64，不在运行时清理——运行时清理会把地图编辑器里
// 用户故意画的小障碍一起抹掉。
import fs from 'fs';
import { setupWindow } from '../tests/_harness.mjs';
setupWindow();

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const MAP = arg('map', 'twisted_treeline_v1');
const MAX = +arg('max-cells', 60);
const WRITE = process.argv.includes('--write');

const { MAPS } = await import('../src/data/maps/index.js');
const { unpackBits, packBits } = await import('../src/data/navgrid.js');
const { isInBaseWallRing } = await import('../src/data/baseCircle.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');

const map = (Array.isArray(MAPS) ? MAPS : Object.values(MAPS)).find((m) => m.id === MAP);
if (!map) { console.error('没有这张图：' + MAP); process.exit(1); }
const NG = map.navgrid || SR_NAVGRID;
const n = NG.n, bits = unpackBits(NG.bits, n);
const cw = map.world.w / n, ch = map.world.h / n;

const seen = new Uint8Array(n * n), removed = [];
for (let s = 0; s < n * n; s++) {
  if (bits[s] || seen[s]) continue;
  const q = [s], cells = []; seen[s] = 1; let border = false;
  while (q.length) {
    const k = q.pop(); cells.push(k);
    const x = k % n, y = (k / n) | 0;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) border = true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
      const kk = Y * n + X;
      if (!bits[kk] && !seen[kk]) { seen[kk] = 1; q.push(kk); }
    }
  }
  if (border || cells.length > MAX) continue;
  const inRing = cells.some((k) => isInBaseWallRing(map, (k % n + 0.5) * cw, (((k / n) | 0) + 0.5) * ch));
  if (inRing) continue;
  let cx = 0, cy = 0;
  for (const k of cells) { cx += (k % n + 0.5) * cw; cy += (((k / n) | 0) + 0.5) * ch; bits[k] = 1; }
  removed.push({ cells: cells.length, x: Math.round(cx / cells.length), y: Math.round(cy / cells.length) });
}

console.log(`${MAP}：阈值 ${MAX} 格，清掉 ${removed.length} 块`);
for (const r of removed) console.log(`  ${r.cells} 格 @ (${r.x}, ${r.y})`);

if (WRITE && removed.length) {
  const file = map.navgrid ? 'src/data/maps/map_navgrids.js' : 'src/data/maps/sr_navgrid.js';
  const url = new URL('../' + file, import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  if (src.split(NG.bits).length !== 2) { console.error(`${file} 里找不到唯一一处原始位图，没有改写`); process.exit(1); }
  const out = src.replace(NG.bits, packBits(bits));   // 先算完新内容再写
  fs.writeFileSync(url, out);
  console.log('已改写 ' + file);
}
