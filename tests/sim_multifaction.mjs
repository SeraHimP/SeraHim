// sim_multifaction.mjs —— 多阵营地基（阶段一）：map.factions / lane.spawns 数据模型验收
//
// 见 docs/REPORT-2026-09-03-multifaction.md §3、§8 阶段1。这一步纯粹是"加字段 + 加
// 读字段的兜底函数"，不改任何现有系统的运行时行为——断言分两块：
//   ① FactionSystem.mapFactionsOf/laneSpawnsOf 这两个纯函数本身（未声明兜底 + 显式覆写）；
//   ② 三张现有地图确实按方案 A 把字段显式写出来了，且值与"未声明时的兜底值"逐位一致
//      （这条防的是"手填的时候打错方向/打错目标阵营"——兜底值是从旧版
//      LaneWaveSystem._enqueueForFaction 的行为原样搬来的，两边不一致就是回归）。
import { scoreboard } from './_harness.mjs';
import { FACTIONS, mapFactionsOf, laneSpawnsOf } from '../src/systems/FactionSystem.js';
import { summoners_rift } from '../src/data/maps/summoners_rift.js';
import { twisted_treeline } from '../src/data/maps/twisted_treeline.js';
import { howling_abyss } from '../src/data/maps/howling_abyss.js';

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

done();
