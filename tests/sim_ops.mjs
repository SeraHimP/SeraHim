// Q3 运维操作验收：死亡塔可选中之后，复活 / 击杀 / 改阵营 / 改层级 的连锁副作用。
//
// 这几个操作看着简单，但每个都牵动别处的状态：重生队列、结构保护、当前目标、
// 空间网格的收录条件。漏掉任何一条都会出灵异 bug（凭空多一座塔、继续攻击原队友、
// 网格查询结果陈旧）。这里逐条钉住。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { AttributeEditor } = await import('../src/ui/AttributeEditor.js');
const { CONFIG } = await import('../src/data/Config.js');
const { summoners_rift: M } = await import('../src/data/maps/summoners_rift.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const bus = new EventBus(), ents = new EntityContainer(bus);
const logs = []; const log = (m) => logs.push(m);
const app = { entityContainer: ents, mapSystem: { currentMap: M, _respawnQueue: [] } };

const mk = () => {
  const t = {
    id: ++window._uid, type: 'tower', alive: false, pos: { x: 100, y: 100 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000 }, currentHP: 0,
    _skillInstances: [], _mapFaction: 'blue', faction: 'blue',
    _mapTier: 'outer', _ruin: true, targetId: 999,
  };
  ents.add(t); return t;
};

// ---- ① 废墟进网格（可选中的前提）----
const t = mk();
AttributeCalculator.tick(); ents.rebuildGridIfNeeded(AttributeCalculator._frame);
T('废墟在空间网格中（死亡塔可被点选）',
  ents.findInRadius(100, 100, 30, null, false).some(e => e.id === t.id));

// ---- ② 复活：满血 + 清废墟标记 + 撤重生队列 + 清目标 ----
app.mapSystem._respawnQueue.push({ at: 10, blueprint: {}, corpseId: t.id });
AttributeEditor._applyOps(t, 'revive', null, ents, app, log);
T('复活：alive 且满血', t.alive === true && t.currentHP === t.baseStats.maxHP);
T('复活：清掉废墟/重生标记', !t._ruin && !t._respawnAt);
T('复活：撤销重生队列项（否则时间一到凭空多一座）', app.mapSystem._respawnQueue.length === 0);
T('复活：清空当前目标', t.targetId === null);

// ---- ③ 改阵营：两个字段同步 + 清目标（否则继续打原队友）----
AttributeEditor._applyOps(t, 'fac', 'red', ents, app, log);
T('改阵营：_mapFaction 与 faction 同步', t._mapFaction === 'red' && t.faction === 'red');
T('改阵营：清空当前目标', t.targetId === null);

// ---- ④ 改层级：按 地图 → 分层覆写 → 阵营覆写 重解析，且保持血量百分比 ----
t.currentHP = Math.round(t.baseStats.maxHP * 0.5);
AttributeEditor._applyOps(t, 'tier', 'hq_tower', ents, app, log);
const hq = M.tierStats.hq_tower;
T('改层级：_mapTier 已更新', t._mapTier === 'hq_tower');
T(`改层级：属性按新层级重解析（maxHP ${t.baseStats.maxHP} = ${hq.maxHP}，魔抗 ${t.baseStats.magicResist} = ${hq.magicResist}）`,
  t.baseStats.maxHP === hq.maxHP && t.baseStats.magicResist === hq.magicResist);
T('改层级：保持血量百分比（约 50%）',
  Math.abs(t.currentHP / t.baseStats.maxHP - 0.5) < 0.02);

// ---- ⑤ 击杀：地图建筑留废墟（否则会被 purgeDead 直接清掉，废墟就没了）----
AttributeEditor._applyOps(t, 'kill', null, ents, app, log);
T('击杀：alive=false 且留下废墟标记', t.alive === false && t._ruin === true);
ents.markDirty(); ents.rebuildGridIfNeeded(AttributeCalculator._frame + 1);
T('击杀后仍在网格中（作为静态障碍）',
  ents.findInRadius(100, 100, 30, null, false).some(e => e.id === t.id));
T('击杀后 purgeDead 不会清掉废墟', (ents.purgeDead(), !!ents.get(t.id)));

// ---- ⑥ 编辑器操作不计分（用户定稿），日志带 [编辑器] 前缀 ----
T('所有运维日志带 [编辑器] 前缀（与对局事件区分）', logs.every(l => l.startsWith('[编辑器]')));
T('运维操作不触发 entity:death 事件（不污染比分/重生/超级兵）',
  (() => { let fired = 0; bus.on('entity:death', () => fired++);
           const t2 = mk(); AttributeEditor._applyOps(t2, 'kill', null, ents, app, log);
           return fired === 0; })());

console.log(`运维操作验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
