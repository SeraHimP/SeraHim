// 阵营龙魂规则验收（用户定稿）：
//   「6 条龙 + ≥4 击杀才成魂、都不到 4 则无魂、之后出远古龙」
//
// 改这块之前是**按塔**结算的（每座塔各攒 4 条解锁自己的魂）。那条路径下
// "都不到 4 则无魂"永远不可能发生 —— 每座塔各算各的，总有塔能攒到 4。
// 所以本套用例的重点是把三种结局都钉死：一方成魂 / 平局无魂 / 双方都不达标无魂。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
const { CONFIG } = await import('../src/data/Config.js');
const { DragonSystem, DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

function mk() {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const towers = {};
  for (const fac of ['blue', 'red']) {
    towers[fac] = [];
    for (let i = 0; i < 2; i++) {
      const t = {
        id: ++window._uid, type: 'tower', alive: true, pos: { x: i * 10, y: fac === 'blue' ? 0 : 500 },
        baseStats: { ...CONFIG.templates.tower }, currentHP: 1000,
        _skillInstances: [], _mapFaction: fac, faction: fac, _mapTier: 'outer',
      };
      ents.add(t);
      towers[fac].push(t);
    }
  }
  // 造一条龙、指定伤害归属、然后杀掉
  let dragonSeq = 0;
  const killBy = (fac, element) => {
    ds.elementDragonSpawned++;               // 模拟"这条龙已刷新"
    const d = {
      id: ++window._uid, type: 'dragon', alive: false, pos: { x: 250, y: 250 },
      baseStats: { ...CONFIG.templates.tower }, currentHP: 0,
      _element: element, _isAncient: false, _skillInstances: [],
      _damagers: new Set(towers[fac].map(t => t.id)),
    };
    dragonSeq++;
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
  };
  return { bus, ents, fx, ds, towers, killBy };
}

const RULE = { total: CONFIG.gameRules.elementDragonTotal, threshold: CONFIG.gameRules.dragonSoulThreshold };
T(`规则软编码：总数 ${RULE.total} / 门槛 ${RULE.threshold}`, RULE.total === 6 && RULE.threshold === 4);

// ---- ① getSouls 必须存在 ----
// WorldState 里写的是 dragons?.getSouls?.()，可选调用会把"方法根本不存在"静默吞掉，
// 于是"龙魂已接入世界状态层"一直是空转。这条断言就是防止它再退回去。
{
  const { ds } = mk();
  T('getSouls() 存在且返回双阵营结构', typeof ds.getSouls === 'function'
    && Array.isArray(ds.getSouls().blue) && Array.isArray(ds.getSouls().red));
  T('未成魂时两方都为空', ds.getSouls().blue.length === 0 && ds.getSouls().red.length === 0);
}

// ---- ② 一方达标 → 成魂，另一方什么都没有 ----
{
  const { ds, towers, killBy } = mk();
  const seen = [];
  ds.eventBus.on('dragon:soulResolved', (d) => seen.push(d));
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');   // 蓝 4
  T('第 4 条龙时尚未结算（要等 6 条打完）', ds.soulResolved === false);
  killBy('red', 'water');                                // 红 1
  T('第 5 条龙仍未结算', ds.soulResolved === false);
  killBy('red', 'water');                                // 红 2 → 共 6 条
  T('第 6 条龙触发结算', ds.soulResolved === true);
  T(`蓝方 4 : 2 红方 → 蓝方成魂（owner=${ds.soulOwner}）`, ds.soulOwner === 'blue');
  T('魂的元素 = 该阵营击杀最多的那种（炎龙）',
    ds.getSouls().blue[0] === DRAGON_ELEMENTS.fire.soul);
  T('另一方无魂', ds.getSouls().red.length === 0);
  T('成魂阵营的每座塔都装上了魂',
    towers.blue.every(t => t._skillInstances.some(s => s.skillId === DRAGON_ELEMENTS.fire.soul)));
  T('未成魂阵营没有任何塔装上魂',
    towers.red.every(t => !t._skillInstances.some(s => s.skillId.startsWith('dragonsoul_'))));
  T('结算事件只发一次且带阵营与比分', seen.length === 1 && seen[0].owner === 'blue'
    && seen[0].factionTotals.blue === 4 && seen[0].factionTotals.red === 2);
  T('结算后进入远古龙阶段', ds.soulUnlocked === true && ds.ancientSpawned === 0);
}

// ---- ③ 3:3 平局 → 无魂（这是合法结局，不是需要兜底的边界）----
{
  const { ds, towers, killBy } = mk();
  let ev = null;
  ds.eventBus.on('dragon:soulResolved', (d) => { ev = d; });
  for (let i = 0; i < 3; i++) killBy('blue', 'fire');
  for (let i = 0; i < 3; i++) killBy('red', 'water');
  T('3:3 时已结算', ds.soulResolved === true);
  T('3:3 → 无人成魂（都未达到门槛 4）', ds.soulOwner === null);
  T('3:3 → 双方都没有魂', ds.getSouls().blue.length === 0 && ds.getSouls().red.length === 0);
  T('3:3 → 任何塔都没装魂',
    [...towers.blue, ...towers.red].every(t => !t._skillInstances.some(s => s.skillId.startsWith('dragonsoul_'))));
  T('3:3 → 结算事件如实报告 owner=null', ev && ev.owner === null);
  T('3:3 → 依然进入远古龙阶段（用户定稿）', ds.soulUnlocked === true);
}

// ---- ④ 双方都达标（如 6 条里蓝 4 红 2 不可能同时达标，这里放宽门槛制造该情形）----
{
  const saved = CONFIG.gameRules.dragonSoulThreshold;
  CONFIG.gameRules.dragonSoulThreshold = 2;
  const { ds, killBy } = mk();
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');
  for (let i = 0; i < 2; i++) killBy('red', 'water');
  T('双方都达标时按击杀多者成魂', ds.soulOwner === 'blue');

  const g = mk();
  for (let i = 0; i < 3; i++) g.killBy('blue', 'fire');
  for (let i = 0; i < 3; i++) g.killBy('red', 'water');
  T('双方都达标且同分 → 无魂（平局不白送任何一方）', g.ds.soulOwner === null);
  CONFIG.gameRules.dragonSoulThreshold = saved;
}

// ---- ⑤ 阶段推进用【已刷新数】而不是【已击杀数】----
// 按击杀数算的话，只要有一条龙没被杀掉，阶段就永远结束不了、远古龙永不出现。
{
  const { ds, killBy } = mk();
  for (let i = 0; i < 5; i++) killBy('blue', 'fire');
  ds.elementDragonSpawned = 6;              // 第 6 条刷了但没人杀
  T('第 6 条未被击杀时仍未结算（结算发生在下一次击杀判定）', ds.soulResolved === false);
  killBy('blue', 'fire');                   // 再来一条被杀 → spawned=7 ≥ 6
  T('已刷新数越过总数即结算', ds.soulResolved === true);
}

// ---- ⑥ 重建的塔要补发本阵营已有的魂 ----
{
  const { ds, ents, towers, killBy } = mk();
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');
  for (let i = 0; i < 2; i++) killBy('red', 'water');
  const fresh = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 99, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 1000,
    _skillInstances: [], _mapFaction: 'blue', faction: 'blue', _mapTier: 'nexus_lane',
  };
  ents.add(fresh);
  T('新建塔默认没有魂', !fresh._skillInstances.some(s => s.skillId.startsWith('dragonsoul_')));
  T('equipExistingSoul 补发成功', ds.equipExistingSoul(fresh) === true
    && fresh._skillInstances.some(s => s.skillId === DRAGON_ELEMENTS.fire.soul));
  const redFresh = { ...fresh, id: ++window._uid, _skillInstances: [], _mapFaction: 'red', faction: 'red' };
  T('未成魂阵营的新塔补发返回 false 且不装魂',
    ds.equipExistingSoul(redFresh) === false && redFresh._skillInstances.length === 0);
  // 幂等：重复补发不该叠出两个魂
  ds.equipExistingSoul(fresh);
  ds.equipExistingSoul(fresh);
  T('重复补发幂等（不会叠出多个魂）',
    fresh._skillInstances.filter(s => s.skillId.startsWith('dragonsoul_')).length === 1);
}

// ---- ⑦ 旧的按塔解锁旁路必须已删除 ----
// 留着它就等于留了一条语义相反的入口，以后随便谁调一下就把阵营规则绕过去了。
{
  const { ds } = mk();
  T('_unlockSoulForTower 已删除（语义与阵营规则相反）', ds._unlockSoulForTower === undefined);
}

// ---- ⑧ 沙盒模式（无阵营标记）不做阵营结算，也不该崩 ----
{
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const t = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 1000,
    _skillInstances: [], _mapTier: 'outer',   // 无 _mapFaction
  };
  ents.add(t);
  for (let i = 0; i < 7; i++) {
    ds.elementDragonSpawned++;
    const d = { id: ++window._uid, type: 'dragon', alive: false, pos: { x: 1, y: 1 },
                baseStats: {}, currentHP: 0, _element: 'fire', _skillInstances: [],
                _damagers: new Set([t.id]) };
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
  }
  T('沙盒模式无阵营击杀计数', ds.factionTotals.blue === 0 && ds.factionTotals.red === 0);
  T('沙盒模式无人成魂但仍进入远古阶段', ds.soulOwner === null && ds.soulUnlocked === true);
  T('沙盒模式塔仍拿到元素增益（那一层不分阵营）',
    fx.getEffects(t.id).some(e => e.blueprint?.stackKey?.startsWith('dragon_fire')));
}

// ---- ⑨ getState 暴露规则状态供 UI 读取 ----
{
  const { ds, killBy } = mk();
  for (let i = 0; i < 2; i++) killBy('blue', 'fire');
  const st = ds.getState();
  T('getState 含阵营比分与规则参数',
    st.factionTotals.blue === 2 && st.elementDragonTotal === 6 && st.soulThreshold === 4
    && st.soulResolved === false && st.soulOwner === null && !!st.souls);
}

console.log(`阵营龙魂规则验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
