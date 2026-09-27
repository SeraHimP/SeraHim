// 基地出口不卡兵（两个用户实拍的 bug）：
//   ① "水晶枢纽和枢纽塔之间距离太小，我手动生成兵会卡住出不去"——根因：手动生成的兵原来生在枢纽正中心，
//      枢纽放大（碰撞半径 76）后一出生就被挤进枢纽与枢纽塔之间十来单位宽的缝里。现在从出兵点出。
//   ② "城墙的两侧会和小兵穿模重合，把墙往里面收一收，不要在路线上"——墙头（连墩台）离兵线中线
//      只有 87~128，走廊半宽 130。现在每截墙两头离兵线中线至少 CONFIG.ui.baseWall.laneClear。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation } = await import('../src/simulation.js');
const { CONFIG } = await import('../src/data/Config.js');
const { baseWallMask, baseWallRuns, baseWallFootprint } = await import('../src/data/baseCircle.js');
const { unpackBits, navgridOf } = await import('../src/data/navgrid.js');
const { projectOntoPolyline } = await import('../src/data/mapValidate.js');
const { T, done } = scoreboard('基地出口不卡兵');
const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

T('①手动生成的兵从这条路的出兵点出（与正常波次同一个），不再生在枢纽正中心',
  /laneWaveSystem\.spawnPointFor\(resolvedLaneId, dir\)/.test(mainSrc) && /createMinion\(type, sp\.x/.test(mainSrc));

for (const id of ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1']) {
  const sim = createSimulation(); sim.mapSystem.loadMap(id);
  const map = sim.mapSystem.currentMap;
  const nex = sim.entityContainer.getAll().filter((e) => e._mapTier === 'nexus_main');
  // 按手动生成的做法：每条路、每个阵营、几个兵种各生一小队
  const made = [];
  for (const lane of map.lanes) {
    for (const [fac, dir] of [['blue', 'forward'], ['red', 'reverse']]) {
      const sp = sim.laneWaveSystem.spawnPointFor(lane.id, dir);
      for (const type of ['melee', 'ranged', 'siege']) {
        for (let k = 0; k < 2; k++) {
          const m = sim.laneWaveSystem.createMinion(type, sp.x + (k - 0.5) * 8, sp.y + (k - 0.5) * 8, fac, lane.id, dir);
          if (m) made.push(m);
        }
      }
    }
  }
  for (let i = 0; i < 30 * 20; i++) sim.step(1 / 30);
  const stuck = made.filter((m) => m.alive && nex.some((n) => n._mapFaction === m.faction && Math.hypot(m.pos.x - n.pos.x, m.pos.y - n.pos.y) < 240));
  T(`②${id}：手动生成的 ${made.length} 个兵 20 秒后都离开了自家枢纽附近（卡住 ${stuck.length} 个）`, made.length > 0 && stuck.length === 0);
}

{
  const sim = createSimulation(); sim.mapSystem.loadMap('summoners_rift_v1');
  const m = sim.mapSystem.currentMap, NG = navgridOf(m), bits = unpackBits(NG.bits, NG.n), W = CONFIG.ui.baseWall;
  const mask = baseWallMask(m, bits, NG.n, W.wallFraction);
  const runs = baseWallRuns(m, mask, NG.n, W.blockLength, W.laneClear);
  const d = (p) => Math.min(...m.lanes.map((l) => projectOntoPolyline(l.waypoints, p.x, p.y).dist));
  const ends = runs.flatMap((r) => [r[0], r[r.length - 1]]);
  T(`③laneClear 软编码且大于兵线走廊半宽 + 墩台半宽（${W.laneClear}）`, W.laneClear >= (m.walls?.corridorHalfWidth ?? 130) + W.pillarSize / 2);
  T(`④每截墙两头都离兵线中线 ≥ laneClear（最近 ${Math.min(...ends.map(d)).toFixed(0)}）`, runs.length > 0 && ends.every((p) => d(p) >= W.laneClear));
  // 碰撞与画面同源：挡人的墙格也都在走廊外
  const foot = baseWallFootprint(m, mask, NG.n, W);
  const cw = m.world.w / NG.n;
  let inCorridor = 0;
  for (let k = 0; k < foot.length; k++) {
    if (!foot[k]) continue;
    const x = (k % NG.n + 0.5) * cw, y = ((k / NG.n | 0) + 0.5) * cw;
    if (d({ x, y }) < (m.walls?.corridorHalfWidth ?? 130)) inCorridor++;
  }
  T(`⑤挡人的墙格没有一格在兵线走廊里（${inCorridor} 格）`, inCorridor === 0);
  T('⑥画墙与碰撞传同一个 laneClear', /baseWallRuns\(map, mask, NG\.n, block, W\.laneClear \?\? 0\)/.test(fs.readFileSync(new URL('../src/presentation/BaseWallLayer.js', import.meta.url), 'utf8')));
}

done();
