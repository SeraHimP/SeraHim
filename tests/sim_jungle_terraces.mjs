// 野区"台地 + 分片树林"布局（jungleTerraces）：两张图都走这一版。
// 用户定稿（2026-09-27）："还是弄有悬崖（抬高地形）的那种吧……密密麻麻的一样的树太丑了"，
// 看过截图后："就是这种的，做出森林的不同层次。"
// 断言钉形状：东西摆在该摆的地方、有台地、有两种树成片、有疏有密、结果确定。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation } = await import('../src/simulation.js');
const { terracePlan } = await import('../src/data/jungleTerraces.js');
const { baseWallLookup } = await import('../src/data/baseCircle.js');
const { navgridOf } = await import('../src/data/navgrid.js');
const { isLaneCell } = await import('../src/data/mapValidate.js');
const { CONFIG, stylizedPaletteOf } = await import('../src/data/Config.js');
const { T, done } = scoreboard('野区台地 + 分片树林');

const load = (id) => { const s = createSimulation(); s.mapSystem.loadMap(id); return s; };
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const plans = {};

for (const id of ['summoners_rift_v1', 'twisted_treeline_v1']) {
  const sim = load(id), ms = sim.mapSystem, map = ms.currentMap;
  const tag = id === 'summoners_rift_v1' ? '峡谷' : '扭曲丛林';
  const walk = (x, y) => ms.isWalkable(x, y);
  const wall = baseWallLookup(map, navgridOf(map), CONFIG.ui.baseWall.wallFraction);
  const river = (x, y) => ms.riverFactor(x, y);
  const plan = terracePlan(map, walk, wall, river, 256, null);
  plans[id] = plan;

  T(`①${tag}：树和石头全都落在不可走区`, [...plan.trees.map((t) => [t.x, t.y]), ...plan.rocks].every(([x, y]) => !walk(x, y)));
  // 灌木三种：草地上贴林边的（能走）、林间空地的（不可走）、台面上的（带台面高度，不可走）。
  T(`②${tag}：灌木不上兵线路面；台面灌木都在台地上`,
    plan.bushes.every(([x, y, , , top]) => (top === undefined ? !(walk(x, y) && isLaneCell(map, x, y)) : !walk(x, y))));
  T(`③${tag}：基地石墙占的地方不摆树`, plan.trees.every((t) => !wall || !wall(t.x, t.y)));

  const C = { ...CONFIG.ui.jungleTerraces, ...(stylizedPaletteOf(map).terraceOverrides || {}) };
  T(`④${tag}：有台地（${plan.outcrops.length} 块），崖高都在配置范围内、轮廓是闭合环`,
    plan.outcrops.length >= 3 && plan.outcrops.every((o) => o.height >= C.outcropHeightMin && o.height <= C.outcropHeightMax
      && o.loops.length > 0 && o.loops.every((l) => l.length >= 3)));
  T(`⑤${tag}：不可走区分成了台地 / 树林两类以上`, plan.biomes.outcrop > 0 && plan.biomes.grove > 0);

  const sizes = plan.trees.map((t) => t.s);
  T(`⑥${tag}：树有大有小（最大/最小 = ${(Math.max(...sizes) / Math.min(...sizes)).toFixed(2)}）`,
    Math.max(...sizes) / Math.min(...sizes) > 1.5);

  // 有疏有密：抽查不可走区的点，一部分附近有树、一部分是林间空地/台面，不是"盖满"。
  const { w: WW, h: WH } = map.world;
  let probes = 0, covered = 0;
  for (let x = 40; x < WW - 40; x += 97) for (let y = 40; y < WH - 40; y += 89) {
    if (walk(x, y) || (wall && wall(x, y))) continue;
    probes++;
    if (plan.trees.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < 36 * 36)) covered++;
  }
  const cov = covered / Math.max(1, probes);
  T(`⑦${tag}：不可走区有疏有密（抽查 ${probes} 点，${(cov * 100).toFixed(0)}% 附近有树）`, probes > 20 && cov > 0.25 && cov < 0.95);
  T(`⑧${tag}：同一张图两次规划逐位相同`, JSON.stringify(plan) === JSON.stringify(terracePlan(map, walk, wall, river, 256, null)));
}

{
  const sr = plans.summoners_rift_v1.trees;
  const con = sr.filter((t) => t.species === 'conifer').length / sr.length;
  T(`⑨峡谷两种树成片：针叶 ${(con * 100).toFixed(0)}%，两种都不少于 15%`, con > 0.15 && con < 0.85);
  // 成片而不是撒胡椒面：一棵树最近的 3 棵邻居里，同种的比例明显高于随机混种。
  let same = 0, tot = 0;
  for (let i = 0; i < sr.length; i += 7) {
    const a = sr[i];
    const nn = sr.filter((b) => b !== a).map((b) => [(b.x - a.x) ** 2 + (b.y - a.y) ** 2, b]).sort((p, q) => p[0] - q[0]).slice(0, 3);
    for (const [, b] of nn) { tot++; if (b.species === a.species) same++; }
  }
  const expect = con * con + (1 - con) * (1 - con);
  T(`⑩峡谷树种成片（近邻同种 ${(same / tot * 100).toFixed(0)}%，随机混种约 ${(expect * 100).toFixed(0)}%）`, same / tot > expect + 0.1);
}
{
  const P = CONFIG.stylizedPalettes;
  T('⑪扭曲丛林用 terraceOverrides 放宽了台地门槛（格子只有峡谷的约 1/3）',
    P.magicForest.terraceOverrides?.outcropMaxCells > CONFIG.ui.jungleTerraces.outcropMaxCells);
  // 改参数必须立刻反映到规划上（缓存键带着参数）。
  const sim = load('summoners_rift_v1'), ms = sim.mapSystem, map = ms.currentMap;
  const walk = (x, y) => ms.isWalkable(x, y), key = ms._navgrid().bits;
  const a = terracePlan(map, walk, null, null, 256, key).trees.length;
  const old = CONFIG.ui.jungleTerraces.treeStep;
  CONFIG.ui.jungleTerraces.treeStep = old * 2;
  const b = terracePlan(map, walk, null, null, 256, key).trees.length;
  CONFIG.ui.jungleTerraces.treeStep = old;
  T(`⑫改 treeStep 立即生效（${a} → ${b} 棵），不被缓存吃掉`, b < a * 0.6);
}
{
  const vg = src('presentation/VegetationLayer.js');
  T('⑬VegetationLayer 按 terraces 布局摆树、建台地', /terracePlan\(/.test(vg) && /_buildOutcrops\(/.test(vg));
  T('⑭TerrainLayer 把 terraces 布局的不可走区画成树林地面',
    /SV\.jungleLayout === 'terraces'/.test(src('presentation/TerrainLayer.js')));
}

done();
