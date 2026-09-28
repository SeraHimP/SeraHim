// 召唤师峡谷 / 扭曲丛林的野区与高地城墙：每块不能走的地方都要看得出为什么不能走。
// 用户定稿（2026-09-27）：不可走区盖满树、边缘夹石头；草地干净，只贴着树林放矮灌木；
// 地面三层；峡谷高地是城墙；路面上的不可走噪点删掉；基地广场保留但弱化。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation } = await import('../src/simulation.js');
const { canopyPlan } = await import('../src/data/jungleCanopy.js');
const { baseWallMask, baseWallRuns, baseWallLookup } = await import('../src/data/baseCircle.js');
const { unpackBits, navgridOf } = await import('../src/data/navgrid.js');
const { isLaneCell } = await import('../src/data/mapValidate.js');
const { CONFIG } = await import('../src/data/Config.js');
const { T, done } = scoreboard('野区树冠 + 高地城墙');

const load = (id) => { const s = createSimulation(); s.mapSystem.loadMap(id); return s; };
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

for (const id of ['summoners_rift_v1', 'twisted_treeline_v1']) {
  const sim = load(id), map = sim.mapSystem.currentMap;
  const walk = (x, y) => sim.mapSystem.isWalkable(x, y);
  const wall = baseWallLookup(map, navgridOf(map), CONFIG.ui.baseWall.wallFraction);
  const plan = canopyPlan(map, walk, wall);
  const tag = id === 'summoners_rift_v1' ? '峡谷' : '扭曲丛林';
  const trees = [...plan.interior, ...plan.edgeTrees];
  T(`①${tag}：树和边缘石头全都落在不可走区（能走的地方一棵树都没有）`,
    [...trees, ...plan.edgeRocks].every(([x, y]) => !walk(x, y)));
  T(`②${tag}：灌木只在能走的草地上，兵线路面上一株都没有`,
    plan.bushes.every(([x, y]) => walk(x, y) && !isLaneCell(map, x, y)));
  T(`③${tag}：边缘有石头夹在树里（树为主）`, plan.edgeRocks.length > 0 && plan.edgeTrees.length > plan.edgeRocks.length * 2);
  // "盖满"：抽查不可走区（非墙）的点，附近一定有树冠。
  const all = [...trees, ...plan.edgeRocks];
  const { w: WW, h: WH } = map.world;
  let probes = 0, covered = 0;
  for (let x = 40; x < WW - 40; x += 97) for (let y = 40; y < WH - 40; y += 89) {
    if (walk(x, y) || (wall && wall(x, y))) continue;
    probes++;
    if (all.some(([tx, ty]) => (tx - x) ** 2 + (ty - y) ** 2 < 36 * 36)) covered++;
  }
  T(`④${tag}：不可走区被树冠盖满（抽查 ${probes} 点，${covered} 点 36 单位内有树/石）`, probes > 20 && covered / probes > 0.97);
  T(`⑤${tag}：同一张图两次规划逐位相同`, JSON.stringify(plan) === JSON.stringify(canopyPlan(map, walk, wall)));
}

{
  // 城墙：只有声明了 baseWalls 的图才有；墙只砌在不可走格上；中线落在墙带里。
  const sr = load('summoners_rift_v1').mapSystem.currentMap, tt = load('twisted_treeline_v1').mapSystem.currentMap;
  const NG = navgridOf(sr), bits = unpackBits(NG.bits, NG.n);
  const mask = baseWallMask(sr, bits, NG.n, CONFIG.ui.baseWall.wallFraction);
  T('⑥峡谷声明了 baseWalls，扭曲丛林没有（它没有高地墙，环带里的是树林）',
    !!mask && baseWallMask(tt, unpackBits(navgridOf(tt).bits, navgridOf(tt).n), navgridOf(tt).n) === null);
  let bad = 0; for (let k = 0; k < mask.length; k++) if (mask[k] && bits[k]) bad++;
  T('⑦墙只砌在不可走格上（墙的形状 = 挡人的形状）', bad === 0 && mask.some((v) => v));
  const runs = baseWallRuns(sr, mask, NG.n, CONFIG.ui.baseWall.blockLength);
  const lookup = baseWallLookup(sr, NG, CONFIG.ui.baseWall.wallFraction);
  T(`⑧峡谷两边一共 ${runs.length} 截墙，每截墙的中线都在墙带里`, runs.length >= 6 && runs.every((r) => r.every((p) => lookup(p.x, p.y))));
  const ws = src('presentation/BaseWallLayer.js');
  T('⑨城墙：错缝分层、垛口、两端墩台，金色只在墩台顶（墙顶用石色压顶线）',
    /c % 2\) \* block \/ 2/.test(ws) && /merlonH/.test(ws) && /pillarExtra/.test(ws)
    && /copingHex/.test(ws) && /goldHex/.test(ws) && typeof CONFIG.ui.baseWall.copingColor === 'string');
}

{
  // 路面上的不可走噪点已从地形数据里删掉
  const sim = load('twisted_treeline_v1');
  const w = (x, y) => sim.mapSystem.isWalkable(x, y);
  T('⑩扭曲丛林上路那几块噪点现在能走了', w(1003, 385) && w(809, 270) && w(2031, 383) && w(2243, 260));
  const map = sim.mapSystem.currentMap, NG = navgridOf(map), n = NG.n, bits = unpackBits(NG.bits, n);
  const seen = new Uint8Array(n * n); let small = 0;
  for (let s = 0; s < n * n; s++) {
    if (bits[s] || seen[s]) continue;
    const q = [s]; seen[s] = 1; let cnt = 0, border = false;
    while (q.length) {
      const k = q.pop(); cnt++; const x = k % n, y = (k / n) | 0;
      if (!x || !y || x === n - 1 || y === n - 1) border = true;
      for (const kk of [k - 1, k + 1, k - n, k + n]) if (kk >= 0 && kk < n * n && !bits[kk] && !seen[kk] && Math.abs((kk % n) - x) <= 1) { seen[kk] = 1; q.push(kk); }
    }
    if (!border && cnt <= 60) small++;
  }
  T('⑪扭曲丛林不再有 60 格以下、被可走区包住的不可走小岛', small === 0);
}

{
  const P = CONFIG.stylizedPalettes;
  // 两张图现在走台地布局（jungleTerraces，见 sim_jungle_terraces）；树冠布局仍可由调色板选用。
  T('⑫两张图地面三层：土路 / 草地 / 树林地面，都走台地布局',
    ['forest', 'magicForest'].every((k) => P[k].jungleLayout === 'terraces' && P[k].forestFloorColor && P[k].jungleColor && P[k].corridorColor));
  T('⑬TerrainLayer 在树冠布局下把可走区只分成路/草地、不可走区一律是树林地面',
    /if \(canopy\) lab = on \? \(lab === 0 \? 0 : 2\) : 3;/.test(src('presentation/TerrainLayer.js')));
  T('⑭BoundaryDecorLayer 在树冠布局下不再往草地边上额外撒树石', /if \(canopyLayout\) continue;/.test(src('presentation/BoundaryDecorLayer.js')));
  const L = CONFIG.ui.landmarks;
  T('⑮基地广场"保留但弱化"：没有同心圈/放射线，颜色只向石色混一小步',
    L.plazaRings === undefined && L.plazaSpokes === undefined && L.plazaBlend > 0 && L.plazaBlend < 0.5 && L.plazaFeather > 0);
}

done();
