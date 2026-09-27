// 基地城墙"只有墙体挡人"：设计数据里的围墙带打开，城墙实际占的格子封回去。
// 用户："高地墙往里的那一块，地面是不可走有一大块，实际的墙就薄薄一层。"
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation } = await import('../src/simulation.js');
const { unpackBits, navgridOf } = await import('../src/data/navgrid.js');
const { baseWallMask, baseWallFootprint, baseCircleCenter } = await import('../src/data/baseCircle.js');
const { projectOntoPolyline } = await import('../src/data/mapValidate.js');
const { CONFIG } = await import('../src/data/Config.js');
const { T, done } = scoreboard('基地城墙碰撞');

const load = (id) => { const s = createSimulation(); s.mapSystem.loadMap(id); return s; };
const sim = load('summoners_rift_v1'), ms = sim.mapSystem, m = ms.currentMap;
const NG = navgridOf(m), n = NG.n, raw = unpackBits(NG.bits, n), rt = ms._navgrid().bits;
const W = CONFIG.ui.baseWall;
const mask = baseWallMask(m, raw, n, W.wallFraction);
const foot = baseWallFootprint(m, mask, n, W);

let opened = 0, wallBlocked = true, outsideSame = true;
for (let k = 0; k < n * n; k++) {
  if (mask[k] && rt[k]) opened++;
  if (foot[k] && mask[k] && rt[k]) wallBlocked = false;
  if (!mask[k] && raw[k] !== rt[k]) outsideSame = false;
}
T(`①围墙带里大部分格子打开了（${opened} 格）`, opened > 200);
T('②城墙实际占的格子仍然挡人', wallBlocked && foot.some((v) => v));
T('③围墙带以外一格都没变（野区、兵线、河道不受影响）', outsideSame);
T('④三条兵线的路点全都能走', m.lanes.every((l) => l.waypoints.every((p) => ms.isWalkable(p.x, p.y))));

{
  // ⑤ 不能绕开兵线口子从野区进基地：去掉兵线走廊后，没有哪块连通区域同时连着基地内部和远处野区。
  const cw = m.world.w / n, ch = m.world.h / n, hw = m.walls?.corridorHalfWidth ?? 130;
  const r0 = m.baseOpenRadius || m.baseCircleRadius;
  const corridor = new Uint8Array(n * n), inBase = new Uint8Array(n * n), far = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const x = (k % n + 0.5) * cw, y = (((k / n) | 0) + 0.5) * ch;
    const dl = Math.min(...m.lanes.map((l) => projectOntoPolyline(l.waypoints, x, y).dist));
    let db = Infinity;
    for (const f of ['blue', 'red']) { const c = baseCircleCenter(m, f); db = Math.min(db, Math.hypot(x - c.x, y - c.y)); }
    inBase[k] = db < r0 - 40 ? 1 : 0; corridor[k] = (dl <= hw && !inBase[k]) ? 1 : 0; far[k] = db > r0 + 250 ? 1 : 0;
  }
  const lab = new Int32Array(n * n).fill(-1);
  let bad = 0, id = 0;
  for (let s = 0; s < n * n; s++) {
    if (!rt[s] || corridor[s] || lab[s] >= 0) continue;
    const q = [s]; lab[s] = id; let hb = false, hf = false;
    while (q.length) {
      const k = q.pop(); if (inBase[k]) hb = true; if (far[k]) hf = true;
      const x = k % n;
      for (const kk of [k - 1, k + 1, k - n, k + n]) {
        if (kk < 0 || kk >= n * n || Math.abs((kk % n) - x) > 1 || lab[kk] >= 0 || !rt[kk] || corridor[kk]) continue;
        lab[kk] = id; q.push(kk);
      }
    }
    if (hb && hf) bad++;
    id++;
  }
  T('⑤不能绕开兵线口子从野区直接进基地', bad === 0);
}

{
  const sav = CONFIG.gameRules.baseWallThinCollision;
  CONFIG.gameRules.baseWallThinCollision = false;
  const s2 = load('summoners_rift_v1');
  const rt2 = s2.mapSystem._navgrid().bits;
  T('⑥开关关掉 = 改动前的玩法（整条围墙带不能走）', rt2.every((v, k) => v === raw[k]));
  CONFIG.gameRules.baseWallThinCollision = sav;
  const tt = load('twisted_treeline_v1');
  const tNG = navgridOf(tt.mapSystem.currentMap), traw = unpackBits(tNG.bits, tNG.n);
  T('⑦没声明 baseWalls 的图（扭曲丛林）不受影响', tt.mapSystem._navgrid().bits.every((v, k) => v === traw[k]));
}

{
  const ws = fs.readFileSync(new URL('../src/presentation/BaseWallLayer.js', import.meta.url), 'utf8');
  T('⑧画出来的墙和挡人的墙用同一个厚度函数', /baseWallThickness\(p\.width, W\)/.test(ws));
  const tl = fs.readFileSync(new URL('../src/presentation/TerrainLayer.js', import.meta.url), 'utf8');
  T('⑨地面按运行时位图画（墙后打开的地方画成正常地面）', /mapSystem\?\._navgrid\?\.\(\)/.test(tl));
}

done();
