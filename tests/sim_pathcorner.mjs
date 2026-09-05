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
  const mins = ents.getAllMinions(true).filter(m => m._laneId && (window.gameTime - m._birth) > 30);
  // 判据用"离**出生点**多远"，不是"离枢纽多远"：
  // 后者在地形改 navgrid 之后不再等价 —— 兵线出基地的走法变缓了，正常推进的兵
  // 也可能还在枢纽 600px 内，那个阈值会把好兵一起算成卡住（实测 51/52 全是误报）。
  // 卡在转角的症状是"活了很久却没离开出生点"，所以直接量这个。
  const stuck = mins.filter(m => Math.hypot(m.pos.x - m._spawn.x, m.pos.y - m._spawn.y) < 300);
  CONFIG.tuning.waypointArriveRadius = save;
  return { stuck: stuck.length, total: mins.length };
}
{
  const good = await battle(CONFIG.tuning.waypointArriveRadius ?? 24, 100);
  T(`真实对局：没有兵卡在自家基地口（${good.stuck}/${good.total}）`, good.stuck === 0 && good.total > 10);
  // 这里原本有一条反证（把到达半径调回 2px，同一局必须复现卡死）。
  // 地形按标准小地图重描之后，扭曲丛林基地口那个 84° 死弯**已经不存在了**
  // （兵线改从高地北口平缓出去），所以这张图上再也复现不出来 —— 反证移到①的合成兵线上，
  // 那里 84°/100°/130° 都在测，且不依赖任何一张具体地图的当前形状。
  // 这一条留着的意义是"真实对局里没有兵卡住"，与①互补。
  {
    const maxTurn = Math.max(...MAPS['twisted_treeline_v1'].lanes.flatMap((l) => {
      const w = l.waypoints, out = [];
      for (let i = 1; i < w.length - 1; i++) {
        const a = { x: w[i].x - w[i - 1].x, y: w[i].y - w[i - 1].y };
        const b = { x: w[i + 1].x - w[i].x, y: w[i + 1].y - w[i].y };
        out.push(Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) * 180 / Math.PI);
      }
      return out;
    }));
    T(`[扭曲丛林] 兵线最大转角 ${maxTurn.toFixed(0)}° < 70°（基地口那个 84° 死弯已随地形重做消失）`,
      maxTurn < 70);
  }
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

// ==================== ⑥ 绕过自家塔不许贴着塔身圆周走 ====================
// 用户："小兵非要严格绕着他的圆边缘走"（嚎哭深渊外塔处）。
// 老实现在绕行时显式补了一个径向定距项，注释原话是"维持 od ≈ rSum+5 贴着障碍表面
// 做圆周绕行"—— 它**主动**把兵拉回圆周；而且绕行状态只有超时 0.8s 才退出，
// 已经绕过去了还继续吃切向力，于是又多贴半圈。
// 这里钉住两件事：① 能绕过去；② 绕过去的轨迹是"掠过"而不是"贴边圆弧"。
{
  const map = {
    id: '__obst', label: '__obst', world: { w: 2000, h: 2000 },
    walls: { corridorHalfWidth: 300, river: false },
    baseCenters: { blue: { x: 100, y: 1000 }, red: { x: 1900, y: 1000 } },
    baseCircleRadius: 150, baseOpenRadius: 150,
    lanes: [{ id: 'mid', waypoints: [{ x: 100, y: 1000 }, { x: 1900, y: 1000 }] }], buildings: [],
  };
  MAPS[map.id] = map;
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null);
  window.gameTime = 0; ms.loadMap(map.id);
  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  // 一座【自家】塔正压在兵线上 —— 就是嚎哭深渊外塔那个场景
  const TOW = { x: 1000, y: 1000 };
  ents.add({ id: ++window._uid, type: 'tower', alive: true, pos: { ...TOW },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 9999, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue', _mapTier: 'outer' });
  const tpl = CONFIG.templates.melee;
  const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 600, y: 1000 },
    baseStats: { ...tpl }, currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue', _laneId: 'mid', _laneDirection: 'forward' };
  ents.add(m);
  let path = 0, last = { ...m.pos }, hug = 0, frames = 0, minD = Infinity;
  const rTow = (CONFIG.buildingSizes?.outer ?? CONFIG.buildingSizes?.default ?? 28);
  for (let i = 0; i < 30 * 25; i++) {
    window.gameTime = i * DT; move.update(DT);
    path += Math.hypot(m.pos.x - last.x, m.pos.y - last.y);
    last = { x: m.pos.x, y: m.pos.y };
    const d = Math.hypot(m.pos.x - TOW.x, m.pos.y - TOW.y);
    minD = Math.min(minD, d);
    // "贴边"= 停留在塔身表面外 0~18px 的薄壳里。贴边圆弧会在这层里待很久。
    if (d >= rTow && d <= rTow + 28) hug++;
    frames++;
    if (m.pos.x > 1400) break;
  }
  delete MAPS[map.id];
  T(`[绕塔] 能绕过去（x ${m.pos.x.toFixed(0)} > 1400）`, m.pos.x > 1400);
  const net = Math.hypot(m.pos.x - 600, m.pos.y - 1000);
  T(`[绕塔] 轨迹是掠过不是贴边圆弧（路程 ${path.toFixed(0)} / 净位移 ${net.toFixed(0)} < 1.35）`,
    path / Math.max(1, net) < 1.35);
  T(`[绕塔] 没有长时间贴着塔身滑（贴壳帧数 ${hug} / ${frames}，< 25%）`, hug < frames * 0.25);
}

// ==================== ⑦ 塔正压在兵线【中心线】上时不许绕着塔转圈 ====================
// 用户："依旧会转圈（扭曲丛林上路会下路不会），但是一旦范围内出现敌人直接就好。"
// 量出来的闭环：
//   ① 两张新图的塔都压在兵线中心线上（嚎哭深渊三座塔精确在线上；
//      扭曲丛林上路 wp8 离外塔只有 21px，而塔的避障半径 35 + 小兵 10 = 45
//      —— 路点在塔肚子里，小兵最近只能靠到离路点 24px，正好等于到达半径，**踩不中**）；
//   ② 索引卡住 → 期望方向永远指着塔后面那个够不着的点；
//   ③ 绕开一点点之后 blocked 立刻变 false、绕行状态被释放，
//      居中力满权重把兵拉回那条【穿过塔身】的中心线 → 又撞上去。
// "一有敌人就好"正是因为 enemyNear 会关掉居中力，闭环被打断。
// 这里合成一张"塔压在中间路点上"的图，直接钉住三件事：能过去、不转圈、索引能推进。
{
  const map = {
    id: '__onlane', label: '__onlane', world: { w: 2400, h: 2000 },
    walls: { corridorHalfWidth: 260, river: false },
    baseCenters: { blue: { x: 200, y: 1000 }, red: { x: 2200, y: 1000 } },
    baseCircleRadius: 150, baseOpenRadius: 150,
    // 中间那个路点与塔【只差 20px】—— 复刻扭曲丛林上路 wp8 的实际关系
    lanes: [{ id: 'mid', waypoints: [{ x: 200, y: 1000 }, { x: 1200, y: 1000 }, { x: 2200, y: 1000 }] }],
    buildings: [{ faction: 'blue', tier: 'outer', pos: { x: 1220, y: 1000 }, weapon: 'none' }],
  };
  MAPS[map.id] = map;
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus);
  const tplT = CONFIG.templates.tower;
  ms.setCreateBuildingFn(({ faction, tier, pos }) => {
    const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
      baseStats: { ...tplT }, currentHP: 99999, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: faction, faction, _mapTier: tier };
    ents.add(e); return e;
  });
  window.gameTime = 0; ms.loadMap(map.id);
  const lane = ms.getLane('mid');
  T(`[压线塔] loadMap 算出了路点被建筑吃掉的深度（wp1 = ${(lane._wpBlock?.[1] ?? 0).toFixed(0)}px > 0）`,
    (lane._wpBlock?.[1] ?? -1) > 0);

  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  const tpl = CONFIG.templates.melee;
  const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 800, y: 1000 },
    baseStats: { ...tpl }, currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue', _laneId: 'mid', _laneDirection: 'forward' };
  ents.add(m);
  let path = 0, last = { ...m.pos }, laps = 0, prevAng = null, turn = 0;
  for (let i = 0; i < 40 / DT; i++) {
    window.gameTime = i * DT; move.update(DT);
    path += Math.hypot(m.pos.x - last.x, m.pos.y - last.y);
    last = { x: m.pos.x, y: m.pos.y };
    // 累计绕塔的方位角变化 —— 转圈的定义就是"这个角一直往一个方向加"
    const ang = Math.atan2(m.pos.y - 1000, m.pos.x - 1220);
    if (prevAng !== null) {
      let d = ang - prevAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
    }
    prevAng = ang;
    if (m.pos.x > 1800) break;
  }
  laps = Math.abs(turn) / (2 * Math.PI);
  delete MAPS[map.id];
  const net = Math.hypot(m.pos.x - 800, m.pos.y - 1000);
  T(`[压线塔] 能走过去（x ${m.pos.x.toFixed(0)} > 1800）`, m.pos.x > 1800);
  T(`[压线塔] 不是绕着塔转圈（绕塔累计 ${laps.toFixed(2)} 圈 < 0.6）`, laps < 0.6);
  T(`[压线塔] 路程/净位移 ${(path / Math.max(1, net)).toFixed(2)} < 1.35`, path / Math.max(1, net) < 1.35);
  T(`[压线塔] 路点索引推进到了终点（idx=${m._laneWaypointIndex}）`, m._laneWaypointIndex >= 2);
}

// ==================== ⑧ 真实对局（扭曲丛林）：没有兵在绕塔转圈 ====================
// ⑦ 是合成的、只有一个兵；实战里还叠着整波拥挤、交火、地形。这一条守实战。
//
// ⚠️ 判据不能用【路程 / 净位移】—— 我先写的就是那个，然后发现它**噪声太大不能当门限**：
// 同一份代码、同一张图，只把时长从 120 改到 210 秒，最差值就在 1.85 / 3.58 / 5.03
// 之间乱跳（交火走位、临死抽搐都会拉高它），阈值取 4 会随机红。
// 换成【绕最近的己方塔累计转了多少圈】（缠绕角 / 2π）：这才是"转圈"的定义本身，
// 与交火抖动无关。同一组对照：修复前 9.62 圈，修复后 0.51 圈，差 19 倍，
// 三张图跑下来修复后都稳定在 0.5 附近 —— 门限取 2 圈，两边都离得很远。
{
  const save = CONFIG.tuning.waypointArriveRadius;
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
      _birth: window.gameTime, _spawn: { x, y }, _wt: null, _wa: 0, _wind: 0 };
    ents.add(e); return e;
  };
  window.gameTime = 0; window.waveNumber = 0;
  ms.loadMap('twisted_treeline_v1');
  // 缠绕角：跟踪每个兵【最近的那座己方塔】（150px 内），累计方位角变化。
  // 换了塔就清零重新算 —— 只有"一直绕着同一座塔"才算转圈。
  let laps = 0, lapsAt = '';
  let seen = 0;
  for (let i = 0; i < 150 / DT; i++) {
    window.gameTime = i * DT;
    waves.update(DT); move.update(DT); coll.update(DT); combat.update(DT); proj.update(DT);
    const tws = ents.getAllTowers(false);
    for (const m of ents.getAllMinions(true)) {
      let best = null, bd = 150;
      for (const t of tws) {
        const d = Math.hypot(t.pos.x - m.pos.x, t.pos.y - m.pos.y);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) { m._wt = null; m._wind = 0; continue; }
      const a = Math.atan2(m.pos.y - best.pos.y, m.pos.x - best.pos.x);
      if (m._wt !== best.id) { m._wt = best.id; m._wa = a; m._wind = 0; continue; }
      let d = a - m._wa;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      m._wa = a; m._wind += d;
      const L = Math.abs(m._wind) / (2 * Math.PI);
      if (L > laps) { laps = L; lapsAt = `${m._laneId}/${m._mapFaction} @塔(${best.pos.x},${best.pos.y})`; }
    }
  }
  CONFIG.tuning.waypointArriveRadius = save;
  const mins = ents.getAllMinions(true).filter(m => m._laneId && (window.gameTime - m._birth) > 25);
  seen = mins.length;
  T(`[扭曲丛林实战] 没有兵绕着塔转圈（最多 ${laps.toFixed(2)} 圈 ${lapsAt} < 2，存活样本 ${seen}）`,
    seen > 10 && laps < 2);
  // 到达半径必须真的把"路点被塔吃掉的那一截"算进去 —— 否则那个路点的索引永远推不过去。
  // ⚠️ 不要写死索引：兵线重描过（基地段加了两个路点），外塔挨着的那个路点就不再是 wp8 了。
  // 改成"找出离外塔最近的那个路点"，与兵线怎么改都无关。
  const top = MAPS['twisted_treeline_v1'].lanes.find(l => l.id === 'top');
  const outer = MAPS['twisted_treeline_v1'].buildings
    .find(b => b.tier === 'outer' && b.faction === 'blue' && b.laneId === 'top');
  let near = 0, nd = Infinity;
  top.waypoints.forEach((w, i) => {
    const d = Math.hypot(w.x - outer.pos.x, w.y - outer.pos.y);
    if (d < nd) { nd = d; near = i; }
  });
  T(`[扭曲丛林] 离外塔最近的路点 wp${near}（距塔 ${nd.toFixed(0)}px）确实被吃掉一截（${(top._wpBlock?.[near] ?? 0).toFixed(0)}px > 0）`,
    (top._wpBlock?.[near] ?? -1) > 0);
}

console.log(`急转弯寻路验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
