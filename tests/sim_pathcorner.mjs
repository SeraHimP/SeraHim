// 兵线急转弯验收。
//
// 用户报的现象是"扭曲丛林小兵绕圈，不往前走"。定位到的真因**不在地图，在寻路**：
//
//   `_advanceAlongLane` 推进路点索引只有两条判据：
//     ① 离下一个路点比离当前路点更近（以两个路点的【垂直平分线】为界）
//     ② 离当前路点 < 4px
//   ①在急转弯处**永远不成立**：沿来向越过 wp[i] 之后，离 wp[i+1] 反而更远，
//   想走多远都跳不了。于是只剩②，而小兵一帧只走 speed×dt ≈ 3.9px，
//   4px 的到达圈比一步还小 —— 稍微被推挤一下就踩不中，绕着转角那个点无限打转。
//   实测扭曲丛林基地口：一个兵 150 秒走了 11738px，净位移只有 465px。
//
// 峡谷/深渊最大转角只有 16°/0°，所以这条坑埋了很久没被踩到。**新地图一带急转弯就会中招**，
// 因此这套用例不依赖任何具体地图，直接合成一条带急转弯的兵线来钉。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
window.__towerRuleFor = (kind) => kind === 'waveOn';   // 只放行出兵，无敌/停火一律关
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const DT = 1 / 30;

/** 造一张只有一条兵线的最小地图，转角角度可调 */
function cornerMap(id, turnDeg) {
  const a = turnDeg * Math.PI / 180;
  // 来向朝 +x，转角后偏转 turnDeg
  const wp = [{ x: 200, y: 1000 }, { x: 1000, y: 1000 },
              { x: 1000 + 800 * Math.cos(a), y: 1000 + 800 * Math.sin(a) }];
  return {
    id, label: id, world: { w: 2600, h: 2600 },
    walls: { corridorHalfWidth: 150, river: false },
    baseCenters: { blue: { x: 200, y: 1000 }, red: { x: wp[2].x, y: wp[2].y } },
    baseCircleRadius: 200, baseOpenRadius: 200,
    lanes: [{ id: 'mid', waypoints: wp }], buildings: [],
  };
}

/**
 * 放一个兵在转角前，跑 sec 秒，返回它最终到达的路点索引与位置。
 * jitter>0 时每帧给一个随机横向推挤 —— 这才是真实场景（拥挤/交火），
 * 也正是老实现踩不中 4px 到达圈的那一刻。
 */
function walk(map, sec, jitter) {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus);
  ms.setCreateBuildingFn(() => null);
  MAPS[map.id] = map;
  window.gameTime = 0;
  ms.loadMap(map.id);
  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  const tpl = CONFIG.templates.melee;
  const m = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: 700, y: 1000 },
    baseStats: { ...tpl }, currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue', _laneId: 'mid', _laneDirection: 'forward',
  };
  ents.add(m);
  let path = 0, last = { ...m.pos };
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < sec / DT; i++) {
    window.gameTime = i * DT;
    move.update(DT);
    if (jitter) { m.pos.x += rnd() * jitter; m.pos.y += rnd() * jitter; }
    path += Math.hypot(m.pos.x - last.x, m.pos.y - last.y);
    last = { x: m.pos.x, y: m.pos.y };
  }
  delete MAPS[map.id];
  const end = map.lanes[0].waypoints[2];
  return { idx: m._laneWaypointIndex, pos: m.pos, path, left: Math.hypot(m.pos.x - end.x, m.pos.y - end.y) };
}

// ==================== ① 各种转角都必须能过 ====================
// 老实现里 90° 以上必卡；这里从平缓一路测到接近折返。
for (const deg of [10, 30, 60, 84, 100, 130]) {
  const r = walk(cornerMap('__corner' + deg, -deg), 40, 0);
  T(`转角 ${deg}° 能通过（最终路点 ${r.idx}，位置 ${r.pos.x.toFixed(0)},${r.pos.y.toFixed(0)}）`, r.idx >= 2);
}

// ==================== ② 真实对局：不许有兵卡在自家基地口的路点上 ====================
// 合成兵线里【复现不出来】这个 bug（单兵/十二兵、加不加抖动都能过弯）——
// 真实场景里还叠着整波同时到弯、走廊约束、交火停步。所以这一条直接跑真实对局，
// 并配反证：把到达半径调回"小于一帧位移"，同一局必须复现卡住。
// 这也是为什么①那种合成用例不能单独作数：它守的是"判据与转角无关"，
// 守不住"实战里踩不踩得中"。
async function battle(arriveR, seconds) {
  const save = CONFIG.tuning.waypointArriveRadius;
  CONFIG.tuning.waypointArriveRadius = arriveR;
  const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
  const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
  const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const proj = new ProjectileSystem(ents, bus, combat); combat.setProjectileSystem(proj);
  const ms = new MapSystem(ents, bus); ms.setEffectRegistry(fx);
  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  const coll = new CollisionSystem(ents, ms);
  const waves = new LaneWaveSystem(ents, bus, ms);
  ms.setCreateBuildingFn(({ faction, tier, laneId, pos, stats, weapon, isNexus }) => {
    const tpl = CONFIG.templates.tower, st = { ...(stats || {}) };
    const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
      baseStats: { ...tpl, ...st, attackRange: st.attackRange ?? tpl.attackRange },
      currentHP: st.maxHP ?? tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
      _inCombat: false, _attackerCount: 0, _mapFaction: faction, _mapTier: tier,
      _laneId: laneId || null, faction };
    const w = isNexus ? 'none' : weapon;
    if (w && w !== 'none') e._skillInstances.push({ id: ++window._uid, skillId: 'weapon_' + w, state: {} });
    ents.add(e); return e;
  });
  waves.createMinion = (type, x, y, faction, laneId, direction) => {
    const tpl = CONFIG.templates[type]; if (!tpl) return null;
    const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...tpl },
      currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [], _inCombat: false,
      _mapFaction: faction, faction, _laneId: laneId, _laneDirection: direction,
      _birth: window.gameTime, _spawn: { x, y } };
    ents.add(e); return e;
  };
  window.gameTime = 0; window.waveNumber = 0;
  ms.loadMap('twisted_treeline_v1');
  for (let i = 0; i < seconds / DT; i++) {
    window.gameTime = i * DT;
    waves.update(DT); move.update(DT); coll.update(DT); combat.update(DT); proj.update(DT);
  }
  // "卡在基地口"= 活过 30 秒、还没离开自家基地圈两倍半径的范围
  const tt = MAPS['twisted_treeline_v1'];
  const mins = ents.getAllMinions(true).filter(m => m._laneId && (window.gameTime - m._birth) > 30);
  const stuck = mins.filter(m => {
    const c = tt.baseCenters[m._mapFaction];
    return Math.hypot(m.pos.x - c.x, m.pos.y - c.y) < tt.baseOpenRadius * 2;
  });
  CONFIG.tuning.waypointArriveRadius = save;
  return { stuck: stuck.length, total: mins.length };
}
{
  const good = await battle(CONFIG.tuning.waypointArriveRadius ?? 24, 100);
  T(`真实对局：没有兵卡在自家基地口（${good.stuck}/${good.total}）`, good.stuck === 0 && good.total > 10);
  const bad = await battle(2, 100);   // 2px < 一帧位移 3.9px，等价于修复前
  T(`反证：到达半径小于一帧位移时确实复现（卡住 ${bad.stuck}/${bad.total}）`, bad.stuck > 0);
}

// ==================== ④ 到达半径不许提前抄内角 ====================
// 到达圈放大的副作用是"还没走到就算到了"，会把弯抄近。所以推进的前提是
// **已沿来向越过该路点**。这里验：兵在路点【前方】30px（还没到）时不许推进。
{
  const map = cornerMap('__early', -84);
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null);
  MAPS[map.id] = map; window.gameTime = 0; ms.loadMap(map.id);
  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  const tpl = CONFIG.templates.melee;
  const mk = (x, y) => {
    const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x, y }, baseStats: { ...tpl },
      currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'blue', faction: 'blue',
      _laneId: 'mid', _laneDirection: 'forward' };
    ents.add(m); move.update(DT); return m;
  };
  const before = mk(980, 1000);   // 转角前 20px：在到达圈内，但【没越过】
  T(`路点前方 20px（未越过）不推进索引（idx=${before._laneWaypointIndex}）`, before._laneWaypointIndex === 1);
  const after = mk(1015, 1000);   // 越过转角 15px：到达圈内且已越过 → 应推进
  T(`越过路点 15px 就推进索引（idx=${after._laneWaypointIndex}）`, after._laneWaypointIndex === 2);
  delete MAPS[map.id];
}

// ==================== ⑤ 真实地图：每条兵线都要走得通 ====================
// 合成图能过不代表真图能过（走廊宽度、基地圈、路点密度都不同）。
for (const map of Object.values(MAPS)) {
  for (const lane of map.lanes) {
    const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
    const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
    const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null);
    window.gameTime = 0; ms.loadMap(map.id);
    const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
    const tpl = CONFIG.templates.melee;
    const wp = lane.waypoints;
    const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x: wp[0].x, y: wp[0].y },
      baseStats: { ...tpl }, currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: 'blue', faction: 'blue', _laneId: lane.id, _laneDirection: 'forward' };
    ents.add(m);
    let seed = 999;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const total = wp.reduce((s, p, i) => i ? s + Math.hypot(p.x - wp[i - 1].x, p.y - wp[i - 1].y) : 0, 0);
    // 给足时间：全长 / 速度 × 2.5 的余量（绕行、走廊约束都会拖慢）
    const secs = (total / (tpl.moveSpeed || 100)) * 2.5;
    for (let i = 0; i < secs / DT; i++) {
      window.gameTime = i * DT; move.update(DT);
      m.pos.x += rnd() * 3; m.pos.y += rnd() * 3;   // 持续推挤
    }
    const end = wp[wp.length - 1];
    const left = Math.hypot(m.pos.x - end.x, m.pos.y - end.y);
    T(`[${map.label}/${lane.id}] 被推挤下仍能走完全程（离终点 ${left.toFixed(0)} < 250，全长 ${total.toFixed(0)}）`, left < 250);
  }
}

console.log(`急转弯寻路验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
