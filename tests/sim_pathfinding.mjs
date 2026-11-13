// 寻路：网格 + 建筑障碍 + 兵线距离场 + A* 追击（src/systems/NavPlanner.js）。
// 用户："这三个地方特别容易卡住小兵。还是我们目前的寻路机制太落后了"；
//       "由于更改了塔的模型，现在经常出现兵在塔附近打转"。
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { NavPlanner } = await import('../src/systems/NavPlanner.js');
const { createSimulation } = await import('../src/simulation.js');
const { T, done } = scoreboard('寻路（建筑障碍 / 兵线距离场 / A* 追击）');

// ==================== 一、合成地形：C 形凹口 + 一座建筑 ====================
// 64×64 格、每格 10 单位。C 形墙开口朝左：目标在口袋外面右侧，直线冲过去会一头扎进口袋。
{
  const n = 64, bits = new Uint8Array(n * n).fill(1);
  const wall = (i, j) => { bits[j * n + i] = 0; };
  for (let j = 20; j <= 44; j++) wall(40, j);          // 右边竖墙
  for (let i = 24; i <= 40; i++) { wall(i, 20); wall(i, 44); }   // 上下两条横墙
  const lane = { id: 'L', waypoints: [{ x: 50, y: 560 }, { x: 590, y: 560 }] };   // 兵线在 C 形墙下方
  const ents = [{ id: 7, type: 'tower', alive: true, pos: { x: 150, y: 560 }, _mapTier: 'outer' }];
  const mapSystem = {
    currentMap: { id: 'syn', world: { w: 640, h: 640 }, lanes: [lane] }, active: true,
    _navgrid: () => ({ n, bits }), hasWalls: () => true, isWalkable: () => true,
    getLane: (id) => (id === 'L' ? lane : null),
    _nearestOnLane: (l, x, y) => { const px = Math.max(50, Math.min(590, x)); return { dist: Math.hypot(x - px, y - 560) }; },
  };
  const entities = { getAll: () => ents };
  const nav = new NavPlanner(mapSystem, entities);
  nav.sync();
  T('合①-建筑按碰撞半径 + 小兵半径标成障碍', !nav.isFree(150, 560) && nav.isFree(150, 560 - 90));
  T('合②-视线：穿过 C 形墙的直线不通', !nav.clear(300, 320, 480, 320));
  T('合③-视线：追的就是这座建筑时，它自己不算挡', nav.clear(80, 560, 150, 560, 7) && !nav.clear(80, 560, 150, 560));
  T('合④-起点站在建筑障碍圈里往外走不算被挡（刚出生/贴着建筑）', nav.clear(150, 560 - 40, 150, 560 - 150));
  const t0 = Date.now();
  const p = nav.pathTo(300, 320, 480, 320, 15);
  T('合⑤-A* 从口袋里绕出去找到路', !!p && p.points.length > 0);
  T('合⑥-路径绕开了墙（比直线长），且每一步都在可走格', !!p && p.length > 180 && p.points.every((q) => nav.isFree(q.x, q.y)));
  T('合⑦-路径终点在目标附近', !!p && Math.hypot(p.points.at(-1).x - 480, p.points.at(-1).y - 320) <= 15 + 10);
  T('合⑧-被完全围死的目标：返回 null（不会死循环）', (() => {
    for (let i = 52; i <= 60; i++) { bits[2 * n + i] = 0; bits[10 * n + i] = 0; }
    for (let j = 2; j <= 10; j++) { bits[j * n + 52] = 0; bits[j * n + 60] = 0; }
    nav._mapKey = null; nav.sync();
    return nav.pathTo(300, 320, 565, 65, 5) === null;
  })());
  const d = nav.laneDir('L', true, 95, 560);
  T('合⑨-兵线距离场：贴在建筑正前方时往侧面绕（不是顶着建筑）', !!d && Math.abs(d.y) > 0.7 && d.x < 0.5);
  // 顺着场走：从建筑前方出发，每步 5 单位，应该绕过建筑继续前进，且全程不进障碍
  let x = 60, y = 560, ok = true;
  for (let i = 0; i < 200 && x < 300; i++) {
    const v = nav.laneDir('L', true, x, y);
    if (!v) { ok = false; break; }
    x += v.x * 5; y += v.y * 5;
    if (!nav.isFree(x, y)) { ok = false; break; }
  }
  T(`合⑨b-顺着场走能绕过建筑继续向前（走到 x=${x | 0}）`, ok && x >= 300);
  const d2 = nav.laneDir('L', true, 300, 540);
  T('合⑩-开阔处的下坡方向基本就是沿兵线向前', !!d2 && d2.x > 0.8);
  T('合⑪-距离场用双精度（Float32 会把代价舍入，两格互相"改进"死循环——实际踩过）',
    /new Float64Array\(N\)\.fill\(Infinity\)/.test(srcOf('src/systems/NavPlanner.js')) && Date.now() - t0 < 5000);
}

// ==================== 二、接线 ====================
{
  const L = srcOf('src/systems/LaneMovementSystem.js');
  T('线①-行军：正前方被挡才改走距离场（开阔路面行为不变）',
    /const blockedAhead = !this\.nav\.clear\(px, py, px \+ mx \* probe, py \+ my \* probe\)/.test(L) && /this\.nav\.laneDir\(minion\._laneId, forward, px, py\)/.test(L));
  T('线②-追击：没有直线通路才走 A*；不可达就放弃目标', /this\._chaseViaPath\(minion, target, reachR\)/.test(L) && /unreachableIgnoreSec/.test(L));
  T('线③-参数软编码（CONFIG.tuning.nav）且编辑器可改', !!CONFIG.tuning.nav && /tuning\.nav\./.test(srcOf('src/ui/editor/pagesGameplayWorld.js')));
}

// ==================== 三、真跑：召唤师峡谷，兵不再在己方建筑前打转 ====================
// 下路路点从枢纽直连外塔，中间穿过己方枢纽水晶和基地塔；中路对角直线直穿内塔。
// 原来：兵在这些建筑前左右换边打转（8 分钟仿真卡住事件 148 次，大多在出生口）。
{
  const sim = createSimulation();
  sim.mapSystem.loadMap('summoners_rift_v1');
  const towers = sim.entityContainer.getAll().filter((e) => e.type === 'tower');
  const nearOwnBase = (m) => towers.some((t) => (t._mapTier === 'nexus_lane' || t._mapTier === 'base' || t._mapTier === 'nexus_main')
    && t._mapFaction === m._mapFaction && Math.hypot(t.pos.x - m.pos.x, t.pos.y - m.pos.y) < 260);
  const hist = new Map();
  let stuckAtBase = 0, spawned = 0;
  for (let f = 0; f < 30 * 75; f++) {
    sim.step(1 / 30);
    if (f % 15) continue;
    const t = f / 30;
    for (const m of sim.entityContainer.getAllMinions(true)) {
      if (!m._laneId || m.type === 'healer' || m.type === 'engineer') continue;
      let h = hist.get(m.id); if (!h) { h = []; hist.set(m.id, h); spawned++; }
      h.push({ t, x: m.pos.x, y: m.pos.y, a: !!m._anchored || !!m.targetId });
      while (h.length && h[0].t < t - 3) h.shift();
      if (h.length >= 6 && h.every((q) => !q.a) && Math.hypot(h[0].x - m.pos.x, h[0].y - m.pos.y) < 12 && nearOwnBase(m) && !m._stuckCounted) {
        m._stuckCounted = true; stuckAtBase++;
      }
    }
  }
  T(`真①-75 秒对局里出过兵（${spawned} 个）`, spawned > 20);
  T(`真②-没有兵在己方基地建筑前原地打转 3 秒以上（实测 ${stuckAtBase} 个）`, stuckAtBase === 0);
}

done();
