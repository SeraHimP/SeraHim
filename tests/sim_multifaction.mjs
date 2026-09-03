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
import { FACTIONS, mapFactionsOf, laneSpawnsOf, towerRuleFor } from '../src/systems/FactionSystem.js';
import { summoners_rift } from '../src/data/maps/summoners_rift.js';
import { twisted_treeline } from '../src/data/maps/twisted_treeline.js';
import { howling_abyss } from '../src/data/maps/howling_abyss.js';
import { EntityContainer } from '../src/core/EntityContainer.js';
import { EventBus } from '../src/utils/EventBus.js';
import { MapSystem } from '../src/systems/MapSystem.js';
import { LaneWaveSystem } from '../src/systems/LaneWaveSystem.js';

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

done();
