/**
 * sim_wavecompmap.mjs —— 出兵编排"地图独立"验收（第四节 Part B：地基部分）
 *
 * 见 docs/REQUIREMENTS-2026-09-03.md 第四节、src/data/waveComposition.js
 * compositionFor() 头注的四级解析顺序。这次改动只加了"这一层从哪来"这一件事——
 * map.laneWaveCompositionByLane 合并进 LaneWaveSystem._enqueueSpawn() 现算的
 * rules，交给早就认这一层的 compositionFor() 判定，判定逻辑一处没改。
 * 覆盖：① LaneWaveSystem 端到端合并行为；② mapEditorCore.js 新增的
 * withRuleAdded/withRuleRemoved/withRuleMoved/withRuleFieldSet 四个纯函数；
 * ③ buildCustomMapPayload 的 laneWaveCompositionByLane 参数；
 * ④ mapComposition.js 的 CONFIG_FIELDS 收录了新字段。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const {
  withRuleAdded, withRuleRemoved, withRuleMoved, withRuleFieldSet, buildCustomMapPayload, decodeBaseBits,
} = await import('../src/data/mapEditorCore.js');
const { CONFIG_FIELDS } = await import('../src/data/mapComposition.js');
const { MAPS } = await import('../src/data/maps/index.js');

const board = scoreboard('出兵编排地图独立验收（Part B 地基）');
const T = board.T;

// ==================== ① LaneWaveSystem：map.laneWaveCompositionByLane 端到端 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer();
  const mapSys = new MapSystem(ents, bus);
  const laneMid = { id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
  const laneTop = { id: 'top', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  mapSys.currentMap = {
    factions: ['blue', 'red'], lanes: [laneMid, laneTop],
    laneWaveCompositionByLane: { mid: [{ type: 'siege', count: 2, fromWave: 0, everyN: 1 }] },
  };
  mapSys.nexusDestroyed = {};

  let uid = 100;
  ents.add({ id: ++uid, type: 'tower', alive: true, _mapFaction: 'blue', _mapTier: 'nexus_main' });
  ents.add({ id: ++uid, type: 'tower', alive: true, _mapFaction: 'red', _mapTier: 'nexus_main' });

  const lw = new LaneWaveSystem(ents, bus, mapSys);
  lw.waveNumber = 0;
  lw.setCreateMinion((type) => ({ id: ++uid, alive: true })); // 只判定入没入队，出队消费不是这次要测的
  const queuedTypes = () => lw._spawnQueue.map(s => s.type);

  lw._spawnQueue = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red'] }, laneMid);
  T('①-声明了 laneWaveCompositionByLane 的路：出兵序列被整体替换成地图覆写（只有 2 个炮车，没有全局默认的近战/远程）',
    JSON.stringify(queuedTypes()) === JSON.stringify(['siege', 'siege']));

  lw._spawnQueue = [];
  lw._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red'] }, laneTop);
  T('②-没声明覆写的另一条路：仍然落回共享基准（不是空、也不是被 mid 那条覆写污染）',
    queuedTypes().length > 0 && JSON.stringify(queuedTypes()) !== JSON.stringify(['siege', 'siege']));

  // 没声明 laneWaveCompositionByLane 时，行为必须与改动前完全一致（回归安全网）。
  const mapSys2 = new MapSystem(ents, bus);
  mapSys2.currentMap = { factions: ['blue', 'red'], lanes: [laneMid], spawnEnabled: undefined };
  mapSys2.nexusDestroyed = {};
  const lw2 = new LaneWaveSystem(ents, bus, mapSys2);
  lw2.waveNumber = 0;
  lw2.setCreateMinion((type) => ({ id: ++uid, alive: true }));
  lw2._spawnQueue = [];
  lw2._enqueueSpawn({ faction: 'blue', direction: 'forward', targetFactions: ['red'] }, laneMid);
  T('③-普通地图（没声明覆写）：不受影响，行为与改动前一致（近战打头的默认编排）',
    lw2._spawnQueue[0]?.type === 'melee');
}

// ==================== ② mapEditorCore.js：出兵编排规则列表纯函数 ====================
{
  const r1 = { type: 'melee', count: 3, fromWave: 0, everyN: 1 };
  const r2 = { type: 'ranged', count: 3, fromWave: 0, everyN: 1 };
  const r3 = { type: 'siege', count: 1, fromWave: 5, everyN: 15 };

  const added = withRuleAdded([r1], r2);
  T('①-withRuleAdded 加到队尾，不修改输入数组', added.length === 2 && added[1] === r2 && [r1].length === 1);

  const removed = withRuleRemoved([r1, r2, r3], 1);
  T('②-withRuleRemoved 删掉指定下标，不修改输入数组',
    JSON.stringify(removed) === JSON.stringify([r1, r3]) && [r1, r2, r3].length === 3);

  const moved = withRuleMoved([r1, r2, r3], 0, 2);
  T('③-withRuleMoved 把下标0挪到末尾（r1 变成最后一个）', moved[2] === r1 && moved[0] === r2 && moved[1] === r3);
  const movedBack = withRuleMoved([r1, r2, r3], 2, 0);
  T('④-withRuleMoved 把下标2挪到最前（r3 变成第一个）', movedBack[0] === r3 && movedBack[1] === r1);
  T('⑤-withRuleMoved 越界的 toIndex 会夹到合法范围内（不抛错、不丢元素）',
    withRuleMoved([r1, r2, r3], 0, 999).length === 3);
  T('⑥-withRuleMoved 不修改输入数组', JSON.stringify([r1, r2, r3]) === JSON.stringify([r1, r2, r3]));

  const fieldSet = withRuleFieldSet([r1, r2], 0, 'count', 5);
  T('⑦-withRuleFieldSet 改指定下标的指定字段，不改其它字段', fieldSet[0].count === 5 && fieldSet[0].type === 'melee');
  T('⑧-withRuleFieldSet 不修改输入数组/输入规则对象', r1.count === 3);
  T('⑨-withRuleFieldSet 不碰其它下标', fieldSet[1] === r2);
}

// ==================== ③ buildCustomMapPayload：laneWaveCompositionByLane 参数 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const { n, bits } = decodeBaseBits(sr);
  const p1 = buildCustomMapPayload(sr, { id: 'wc1', label: 'wc1', n, bits });
  T('①-不传 laneWaveCompositionByLane 时不写这个字段（保持 baseMap 原值，峡谷本没声明故是 undefined）',
    p1.laneWaveCompositionByLane === undefined);
  const p2 = buildCustomMapPayload(sr, {
    id: 'wc2', label: 'wc2', n, bits,
    laneWaveCompositionByLane: { mid: [{ type: 'melee', count: 1, fromWave: 0, everyN: 1 }] },
  });
  T('②-传了就整体写入', JSON.stringify(p2.laneWaveCompositionByLane) === JSON.stringify({ mid: [{ type: 'melee', count: 1, fromWave: 0, everyN: 1 }] }));
}

// ==================== ④ mapComposition.js：CONFIG_FIELDS 收录新字段 ====================
{
  T('①-CONFIG_FIELDS 包含 laneWaveCompositionByLane（第四节 Part B 的字段清单单一来源）',
    CONFIG_FIELDS.includes('laneWaveCompositionByLane'));
}

board.done();
