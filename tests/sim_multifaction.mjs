// sim_multifaction.mjs —— 多阵营地基（阶段一）：map.factions / lane.spawns 数据模型验收
//
// 见 docs/REPORT-2026-09-03-multifaction.md §3、§8 阶段1。这一步纯粹是"加字段 + 加
// 读字段的兜底函数"，不改任何现有系统的运行时行为——断言分两块：
//   ① FactionSystem.mapFactionsOf/laneSpawnsOf 这两个纯函数本身（未声明兜底 + 显式覆写）；
//   ② 三张现有地图确实按方案 A 把字段显式写出来了，且值与"未声明时的兜底值"逐位一致
//      （这条防的是"手填的时候打错方向/打错目标阵营"——兜底值是从旧版
//      LaneWaveSystem._enqueueForFaction 的行为原样搬来的，两边不一致就是回归）。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
import { FACTIONS, mapFactionsOf, laneSpawnsOf, towerRuleFor, scorerFactionOf } from '../src/systems/FactionSystem.js';
import { summoners_rift } from '../src/data/maps/summoners_rift.js';
import { twisted_treeline } from '../src/data/maps/twisted_treeline.js';
import { howling_abyss } from '../src/data/maps/howling_abyss.js';
import { EntityContainer } from '../src/core/EntityContainer.js';
import { EventBus } from '../src/utils/EventBus.js';
import { MapSystem } from '../src/systems/MapSystem.js';
import { LaneWaveSystem } from '../src/systems/LaneWaveSystem.js';
import { buildingCountsSymmetric, attackTowerSpacingOk, crossFactionTowerSpacingOk } from '../src/data/mapValidate.js';
import { CONFIG } from '../src/data/Config.js';
import { DragonSystem } from '../src/systems/DragonSystem.js';
import { EffectRegistry } from '../src/core/EffectRegistry.js';
import { SkillLibrary } from '../src/core/SkillLibrary.js';
import { AttributeCalculator } from '../src/core/AttributeCalculator.js';
import { CombatSystem } from '../src/systems/CombatSystem.js';
import { WorldState } from '../src/systems/WorldState.js';
import { towerFacingRad } from '../src/presentation/towerFacing.js';

const { T, done } = scoreboard('多阵营地基（map.factions / lane.spawns）验收');

// ==================== ① 纯函数本身 ====================
{
  T('mapFactionsOf(undefined) 兜底为 [blue,red]',
    JSON.stringify(mapFactionsOf(undefined)) === JSON.stringify([FACTIONS.BLUE, FACTIONS.RED]));
  T('mapFactionsOf({}) 兜底为 [blue,red]（地图对象存在但没声明 factions）',
    JSON.stringify(mapFactionsOf({})) === JSON.stringify([FACTIONS.BLUE, FACTIONS.RED]));
  T('mapFactionsOf 显式声明时原样返回（不套兜底）',
    JSON.stringify(mapFactionsOf({ factions: ['blue', 'red', 'green'] })) === JSON.stringify(['blue', 'red', 'green']));

  const fallback = laneSpawnsOf({});
  T('laneSpawnsOf({}) 兜底为两条（蓝forward打红 + 红reverse打蓝）', fallback.length === 2);
  T('laneSpawnsOf 兜底①：蓝方 forward 打红方',
    fallback[0].faction === FACTIONS.BLUE && fallback[0].direction === 'forward' &&
    JSON.stringify(fallback[0].targetFactions) === JSON.stringify([FACTIONS.RED]));
  T('laneSpawnsOf 兜底②：红方 reverse 打蓝方',
    fallback[1].faction === FACTIONS.RED && fallback[1].direction === 'reverse' &&
    JSON.stringify(fallback[1].targetFactions) === JSON.stringify([FACTIONS.BLUE]));
  T('laneSpawnsOf(undefined) 同样兜底（lane 本身不存在时不炸）',
    laneSpawnsOf(undefined).length === 2);

  const custom = [{ faction: 'green', direction: 'forward', targetFactions: ['blue', 'red'] }];
  T('laneSpawnsOf 显式声明时原样返回（不套兜底）',
    laneSpawnsOf({ spawns: custom }) === custom);
}

// ==================== ② 三张现有地图：显式声明与兜底值逐位一致 ====================
const MAPS = [
  ['summoners_rift', summoners_rift],
  ['twisted_treeline', twisted_treeline],
  ['howling_abyss', howling_abyss],
];
for (const [name, map] of MAPS) {
  T(`${name}：显式声明了 factions:[blue,red]`,
    Array.isArray(map.factions) && JSON.stringify(map.factions) === JSON.stringify([FACTIONS.BLUE, FACTIONS.RED]));
  T(`${name}：mapFactionsOf(地图) 与显式声明一致（没有意外触发兜底）`,
    JSON.stringify(mapFactionsOf(map)) === JSON.stringify(map.factions));

  for (const lane of map.lanes) {
    const declared = laneSpawnsOf(lane);
    const implicitDefault = laneSpawnsOf({}); // 未声明时的兜底值，逐位一致才算没打错
    T(`${name}/${lane.id}：显式声明了 spawns 字段`, Array.isArray(lane.spawns) && lane.spawns.length === 2);
    T(`${name}/${lane.id}：spawns 与"未声明时的兜底值"逐位一致（手填没打错方向/目标）`,
      JSON.stringify(declared) === JSON.stringify(implicitDefault));
  }
}

// ==================== ③ towerRuleFor：未声明阵营的兜底方向 ====================
{
  const rules = { invincible: { blue: false, red: false }, attackOff: { blue: false, red: false }, waveOn: { blue: true, red: true } };
  T('towerRuleFor：已声明的阵营原样返回（blue/waveOn=true）', towerRuleFor(rules, 'waveOn', 'blue') === true);
  T('towerRuleFor：未声明阵营 + waveOn → 兜底 true（新阵营不该被默认静音）',
    towerRuleFor(rules, 'waveOn', 'green') === true);
  T('towerRuleFor：未声明阵营 + invincible → 兜底 false（选中才生效的表，默认不生效才对）',
    towerRuleFor(rules, 'invincible', 'green') === false);
  T('towerRuleFor：未声明阵营 + attackOff → 兜底 false', towerRuleFor(rules, 'attackOff', 'green') === false);
  T('towerRuleFor：kind 本身不存在（表都没有）→ 非 waveOn 兜底 false',
    towerRuleFor(rules, 'notAKind', 'blue') === false);
  T('towerRuleFor：kind 本身不存在但是 waveOn → 兜底 true',
    towerRuleFor({}, 'waveOn', 'green') === true);
}

// ==================== ④ MapSystem：阵营淘汰判定 + census 泛化 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer();
  const mapSys = new MapSystem(ents, bus);
  // 手动搭一张三阵营地图，绕开 loadMap（那要求地图先注册进 MAPS/index.js）——
  // isFactionEliminated/structureCensus 都是只读 currentMap/entities 的纯查询，
  // 不依赖 loadMap 走的那整条建筑创建流程。
  mapSys.currentMap = {
    factions: ['blue', 'red', 'green'],
    lanes: [{
      id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      spawns: [{ faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] }],
    }],
  };
  mapSys.nexusDestroyed = {};

  let uid = 0;
  const mkNexus = (faction, alive) => ents.add({
    id: ++uid, type: 'tower', alive, _mapFaction: faction, _mapTier: 'nexus_main',
  });
  mkNexus('blue', true);
  mkNexus('red', true);
  const greenMain = mkNexus('green', true);

  T('isFactionEliminated：三方都还活着，都不算淘汰',
    !mapSys.isFactionEliminated('blue') && !mapSys.isFactionEliminated('red') && !mapSys.isFactionEliminated('green'));
  T('isFactionEliminated：没有 nexus_main 声明的阵营（比如中立）不算淘汰',
    !mapSys.isFactionEliminated('neutral'));

  greenMain.alive = false;
  T('isFactionEliminated：唯一的 nexus_main 死了 → 该阵营已淘汰', mapSys.isFactionEliminated('green'));
  T('isFactionEliminated：淘汰是按阵营算的，不影响其它阵营', !mapSys.isFactionEliminated('blue'));

  const census = mapSys.structureCensus();
  T('structureCensus：动态按 map.factions 建表，含第三阵营（不再写死 {blue,red}）',
    'green' in census && 'blue' in census && 'red' in census);
  T('structureCensus：第三阵营的建筑没有被静默丢弃', census.green.all.nexus_main?.total === 1 && census.green.all.nexus_main?.alive === 0);
}

// ==================== ⑤ LaneWaveSystem：阵营淘汰 → 停止出兵 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer();
  const mapSys = new MapSystem(ents, bus);
  const lane = {
    id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
  };
  mapSys.currentMap = { factions: ['blue', 'red', 'green'], lanes: [lane], spawnEnabled: undefined };
  mapSys.nexusDestroyed = {};

  let uid = 100;
  const mkNexus = (faction) => ents.add({ id: ++uid, type: 'tower', alive: true, _mapFaction: faction, _mapTier: 'nexus_main' });
  const blueMain = mkNexus('blue');
  const redMain = mkNexus('red');
  const greenMain = mkNexus('green');

  const lw = new LaneWaveSystem(ents, bus, mapSys);
  let spawned;
  lw.setCreateMinion((type) => { spawned.push(type); return { id: ++uid, alive: true }; });

  // 场景①：三方全活——blue 打 [red, green] 应该正常出兵
  spawned = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] }, lane);
  T('①三方全活：blue 出兵流正常入队（有兵种被丢进出兵顺序）', lw._spawnQueue.length > 0);
  lw._spawnQueue = [];

  // 场景②：出兵方自己被淘汰 → 完全不出兵
  blueMain.alive = false;
  spawned = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] }, lane);
  T('②出兵方自己被淘汰 → 该出兵流不再入队任何兵', lw._spawnQueue.length === 0);
  blueMain.alive = true; // 复位

  // 场景③：全部目标都被淘汰 → 该路不再出兵（即使出兵方自己没死）
  redMain.alive = false;
  greenMain.alive = false;
  spawned = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] }, lane);
  T('③攻击目标（红+绿）全部淘汰 → blue 这条出兵流不再入队', lw._spawnQueue.length === 0);

  // 场景④：目标只淘汰一部分（red 死，green 活）→ 仍应正常出兵（打向还活着的 green）
  redMain.alive = false;
  greenMain.alive = true;
  spawned = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] }, lane);
  T('④目标部分淘汰（red 死/green 活）→ 仍正常出兵（还有活的目标）', lw._spawnQueue.length > 0);
}

// ==================== ⑥ mapValidate.js：校验放开对 3+ 阵营地图生效 ====================
{
  // 三阵营、故意不对称（蓝2座/红1座/绿1座）——两阵营规则下这张图"不合规"，
  // 但对三阵营地图，"对称"本来就没有唯一答案，应该直接放行。
  const map3 = {
    world: { w: 1000, h: 1000 },
    factions: ['blue', 'red', 'green'],
    lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }] }],
    buildings: [
      { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 10, y: 10 } },
      { faction: 'blue', tier: 'inner', laneId: 'mid', pos: { x: 20, y: 20 } },
      { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 500, y: 500 } },
      { faction: 'green', tier: 'outer', laneId: 'mid', pos: { x: 900, y: 900 } },
    ],
  };
  T('buildingCountsSymmetric：3 阵营地图直接放行（不套两阵营对称规则）',
    buildingCountsSymmetric(map3) === true);

  // 两阵营地图：对称规则原样生效（行为不变）——蓝2座/红1座就该判不对称。
  const map2unbalanced = { ...map3, factions: ['blue', 'red'] };
  T('buildingCountsSymmetric：2 阵营地图规则原样生效（蓝2红1判不对称）',
    buildingCountsSymmetric(map2unbalanced) === false);
  const map2balanced = {
    ...map3,
    factions: ['blue', 'red'],
    buildings: [
      { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 10, y: 10 } },
      { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 500, y: 500 } },
    ],
  };
  T('buildingCountsSymmetric：2 阵营地图对称时判 true', buildingCountsSymmetric(map2balanced) === true);

  // attackTowerSpacingOk：3 阵营时每个阵营各自的同路间距都要查（不再只查蓝红）。
  const closeMap3 = {
    ...map3,
    buildings: [
      { faction: 'green', tier: 'outer', laneId: 'mid', pos: { x: 10, y: 10 } },
      { faction: 'green', tier: 'inner', laneId: 'mid', pos: { x: 15, y: 15 } }, // 间距极近
    ],
  };
  T('attackTowerSpacingOk：第三阵营（green）的同路间距违规也会被查出来（不再被排除在外）',
    attackTowerSpacingOk(closeMap3, 180, ['outer', 'inner']).some(v => v.faction === 'green'));

  // crossFactionTowerSpacingOk：三阵营任意两两组合都要查，不再只查 blue↔red。
  const crossMap3 = {
    ...map3,
    buildings: [
      { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 10, y: 10 } },
      { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 900, y: 900 } },   // 离蓝很远，不违规
      { faction: 'green', tier: 'outer', laneId: 'mid', pos: { x: 15, y: 15 } },  // 离蓝很近，违规
    ],
  };
  const crossV = crossFactionTowerSpacingOk(crossMap3, 180, ['outer']);
  T('crossFactionTowerSpacingOk：查出 blue↔green 违规（第三阵营的跨阵营间距也纳入检查）',
    crossV.some(v => (v.factionA === 'blue' && v.factionB === 'green') || (v.factionA === 'green' && v.factionB === 'blue')));
  T('crossFactionTowerSpacingOk：blue↔red 因为够远没有违规',
    !crossV.some(v => (v.factionA === 'blue' && v.factionB === 'red') || (v.factionA === 'red' && v.factionB === 'blue')));

  // 两阵营时行为逐位不变：只有一对组合，超标时报一条。
  const crossMap2 = { ...map2balanced };
  T('crossFactionTowerSpacingOk：2 阵营地图行为不变（够远时零违规）',
    crossFactionTowerSpacingOk(crossMap2, 180, ['outer']).length === 0);
}

// ==================== ⑦ CombatSystem.recordLastHit：第三阵营能被记为最后一击 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer();
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  let uid = 0;
  const mkTower = (fac) => ents.add({
    id: ++uid, type: 'tower', alive: true, _mapFaction: fac, faction: fac,
    baseStats: { ...CONFIG.templates.tower }, currentHP: 99999, shieldFixedCurrent: 0, tempShield: 0,
    _skillInstances: [],
  });
  const mkDragon = () => ents.add({
    id: ++uid, type: 'dragon', alive: true, _mapFaction: 'neutral', faction: 'neutral',
    baseStats: { ...CONFIG.templates.dragon }, currentHP: 99999, shieldFixedCurrent: 0, tempShield: 0,
    _skillInstances: [],
  });

  const blueTower = mkTower('blue');
  const greenTower = mkTower('green');
  const neutralAttacker = mkTower('neutral');
  const dragon = mkDragon();

  combat.performAttackDirect(blueTower.id, dragon.id, 10, 'physical');
  T('①blue 打龙 → _lastHitFaction 记为 blue（两阵营行为不变）', dragon._lastHitFaction === 'blue');

  combat.performAttackDirect(greenTower.id, dragon.id, 10, 'physical');
  T('②第三阵营（green）打龙 → _lastHitFaction 更新为 green（改动前会被写死的 blue/red 判定挡住，不记录）',
    dragon._lastHitFaction === 'green');

  combat.performAttackDirect(neutralAttacker.id, dragon.id, 10, 'physical');
  T('③中立单位打龙 → 不顶掉上一位非中立攻击者的归属（green 仍然保留）',
    dragon._lastHitFaction === 'green');
}

// ==================== ⑧ DragonSystem：第三阵营击杀巨龙也能正常结算（击杀方独享） ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  let uid = 1000;
  const mkUnit = (type, fac, tier) => {
    const e = { id: ++uid, type, alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.tower) }, currentHP: 1000,
      _skillInstances: [], _mapFaction: fac, faction: fac };
    if (tier) e._mapTier = tier;
    ents.add(e); return e;
  };
  const greenTower = mkUnit('tower', 'green', 'outer');
  const greenSiege = mkUnit('siege', 'green'); // 大型小兵，该拿巨龙之力奖励
  const hasFirePower = (e) => fx.getEffects(e.id).some(x => x.blueprint?.stackKey?.startsWith('dragon_fire'));
  const killByGreen = (element) => {
    ds.elementDragonSpawned++;
    const d = { id: ++uid, type: 'dragon', alive: false, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.dragon }, currentHP: 0,
      _element: element, _isAncient: false, _skillInstances: [],
      _lastHitBy: greenTower.id, _lastHitFaction: 'green' };
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
  };
  killByGreen('fire');
  T('第三阵营击杀元素龙 → factionKills/factionTotals 正常记账（改动前的 blue/red 门会直接丢弃）',
    ds.factionTotals.green === 1 && ds.factionKills.green.fire === 1);
  T('第三阵营的塔与大型小兵都拿到了巨龙之力（击杀方独享奖励，不再被写死的两阵营判定挡住）',
    hasFirePower(greenTower) && hasFirePower(greenSiege));
  // 拿满门槛（默认4条）→ 独享成魂，另外两阵营（blue/red，本场景压根没打过任何一条龙）应该毫无所获
  killByGreen('fire'); killByGreen('fire'); killByGreen('fire');
  T('第三阵营拿满门槛 → 独享成魂（soulOwner=green）', ds.soulOwner === 'green');
  T('魂只发给击杀方——blue/red 全程没打过，击杀数仍是预置的 0（没有被误记）',
    ds.factionTotals.blue === 0 && ds.factionTotals.red === 0);
}

// ==================== ⑨ scorerFactionOf：计分板归属（每阵营一栏，用户拍板） ====================
{
  const twoF = ['blue', 'red'];
  const threeF = ['blue', 'red', 'green'];
  T('①两阵营·有最后一击记录：记给最后一击方（红死于蓝打，分记给蓝——与改动前"死者的对面"结果相同）',
    scorerFactionOf({ _mapFaction: 'red', _lastHitFaction: 'blue' }, twoF) === 'blue');
  T('②两阵营·没有最后一击记录（DOT/环境死亡）：兜底成死者的对面，与改动前逐位一致',
    scorerFactionOf({ _mapFaction: 'red' }, twoF) === 'blue');
  T('③三阵营·有最后一击记录：记给真正打死它的那个阵营（不是死者阵营表里"另一个"那种猜测）',
    scorerFactionOf({ _mapFaction: 'red', _lastHitFaction: 'green' }, threeF) === 'green');
  T('④最后一击记录等于死者自己（异常数据兜底）：不采信，改用兜底逻辑',
    scorerFactionOf({ _mapFaction: 'red', _lastHitFaction: 'red' }, twoF) === 'blue');
}

// ==================== ⑩ WorldState：熵-阵营耦合在 3+ 阵营地图上禁用（用户拍板） ====================
{
  const world = new WorldState({});
  const mkUnit = (fac) => ({
    id: 1, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 500,
    _skillInstances: [], _mapFaction: fac, faction: fac,
  });
  const _prevEntropyToUnits = CONFIG.world.couplings.entropyToUnits;
  const _prevDayNight = CONFIG.world.couplings.dayNight;
  CONFIG.world.couplings.entropyToUnits = true;
  CONFIG.world.couplings.dayNight = false; // 隔离变量：只看熵这一条耦合，昼夜默认开会一起掺进 attackDamage
  world.entropy.value = 0.9; // 偏离中性，两阵营地图下这条耦合该生效

  // 默认（没有 window.CTX.__mapSystem，兜底两阵营）：耦合正常生效，行为不变。
  const rowTwoF = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('熵'));
  T('两阵营（默认兜底）：熵耦合正常生效', rowTwoF && rowTwoF.favored === true);
  const modsTwoF = world.getModifiers(mkUnit('red'));
  T('两阵营：getModifiers 产生了攻击力修正', (modsTwoF.attackDamage?.pct || 0) !== 0);

  // 三阵营地图：整条耦合禁用——getBreakdown 里干脆不出现"熵"这一行，getModifiers 零修正。
  window.CTX = window.CTX || {};
  window.CTX.__mapSystem = { currentMap: { factions: ['blue', 'red', 'green'] } };
  const rowThreeF = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('熵'));
  T('三阵营地图：熵-阵营耦合被禁用，getBreakdown 里不出现"熵"这一行',
    rowThreeF === undefined);
  const modsThreeF = world.getModifiers(mkUnit('red'));
  T('三阵营地图：getModifiers 对熵这条零修正（其它耦合不受影响，这里没开别的所以整体应为空）',
    !modsThreeF.attackDamage && !modsThreeF.armor);

  // 清理，避免影响同进程内其它断言。
  delete window.CTX.__mapSystem;
  CONFIG.world.couplings.entropyToUnits = _prevEntropyToUnits;
  CONFIG.world.couplings.dayNight = _prevDayNight;
}

// ==================== ⑪ towerFacing.js：塔朝向按 lane.spawns 声明的目标阵营取，不再猜"另一个" ====================
{
  // 三阵营合成地图：A 在左，B 在右，C 在上；一条路声明 A 的出兵目标是 B（不是 C）。
  const map3 = {
    world: { w: 1000, h: 1000 },
    factions: ['A', 'B', 'C'],
    lanes: [{
      id: 'mid',
      waypoints: [{ x: 0, y: 500 }, { x: 1000, y: 500 }],
      spawns: [{ faction: 'A', direction: 'forward', targetFactions: ['B'] }],
    }],
    buildings: [
      { faction: 'A', tier: 'nexus_main', pos: { x: 0, y: 500 } },
      { faction: 'B', tier: 'nexus_main', pos: { x: 1000, y: 500 } },
      { faction: 'C', tier: 'nexus_main', pos: { x: 500, y: 0 } }, // 在 A 正上方，若朝向算错会指向这里
    ],
  };
  const towerA = { pos: { x: 100, y: 500 }, _mapFaction: 'A', _laneId: 'mid', _mapTier: 'outer' };
  const rad = towerFacingRad(towerA, map3);
  const deg = (r) => Math.round(r * 180 / Math.PI);
  // 面板正朝 +x（B 在右侧）应该约等于 90°（模型正面 atan2(dx,dy) 的约定，见文件头注）；
  // 若沿用旧逻辑"猜另一个"可能瞎猜到 C（在正上方，dx=0），这里只要不是那个方向即可，
  // 更直接地断言：朝向向量在 B 方向（+x）上的投影 > 0，在 C 方向（-y，即"上方"）上的投影 ≈ 0。
  const dotB = Math.sin(rad) * 1 + Math.cos(rad) * 0; // B 在 +x 方向
  const dotC = Math.sin(rad) * 0 + Math.cos(rad) * -1; // C 在 -y 方向（世界坐标 y 变小）
  T('towerFacingRad：A 塔朝向 lane.spawns 声明的目标阵营 B（不是瞎猜到 C）', dotB > 0.9);
  T('towerFacingRad：确实不是朝着 C（三阵营下不再是"随便挑一个不是自己的"）', Math.abs(dotC) < 0.2);

  // 两阵营地图（无 lane.spawns 声明，走兜底）：行为与改动前一致——朝敌方（另一个声明的阵营）。
  const map2 = {
    world: { w: 1000, h: 1000 },
    factions: ['blue', 'red'],
    lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 500 }, { x: 1000, y: 500 }] }],
    buildings: [
      { faction: 'blue', tier: 'nexus_main', pos: { x: 0, y: 500 } },
      { faction: 'red', tier: 'nexus_main', pos: { x: 1000, y: 500 } },
    ],
  };
  const towerBlue = { pos: { x: 100, y: 500 }, _mapFaction: 'blue', _laneId: 'mid', _mapTier: 'outer' };
  const rad2 = towerFacingRad(towerBlue, map2);
  T('两阵营地图（无 lane.spawns 声明）：兜底朝向敌方，与改动前逐位一致',
    Math.sin(rad2) > 0.9);
}

done();
