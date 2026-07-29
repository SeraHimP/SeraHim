// 技能全局参数覆写验收（CONFIG.skillOverrides）。
//
// 「编辑器改了不生效」是本项目反复出现的症状，根因永远是"编辑器写 A、运行时读 B"。
// 所以这套用例的核心不是"UI 能不能显示"，而是**改完之后战斗里真的读到了**，
// 并且三层叠加顺序（出厂值 → 全局覆写 → 地图覆写）严格成立 ——
// 用户明确要求过"同一技能在不同地图上可能表现为数值/机制不同"，
// 那条能力就靠地图层压在全局层之上，顺序反了这条需求就没了。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

function mk(skillId, entPatch = {}) {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const inst = { id: ++window._uid, skillId, state: {} };
  const e = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 500,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [inst],
    _mapFaction: 'blue', faction: 'blue', ...entPatch,
  };
  ents.add(e);
  return { bus, ents, fx, combat, e, inst };
}
const reset = () => { CONFIG.skillOverrides = {}; SkillLibrary._mapOverrides = null; };

// ---- ① 没有覆写时用出厂值 ----
reset();
const SKILL = 'passive_melee_rend';
const DEF = { ...SkillLibrary[SKILL].defaultParams };
T(`目标技能声明了 defaultParams（${Object.keys(DEF).join(',')}）`, Object.keys(DEF).length > 0);
{
  const { combat, inst } = mk(SKILL);
  combat.update(1 / 30);
  T('无覆写 → _params 等于出厂值',
    JSON.stringify(inst._params) === JSON.stringify(DEF));
}

// ---- ② 全局覆写必须真的进到 _params（"改了要生效"）----
{
  reset();
  const key = Object.keys(DEF)[0];
  CONFIG.skillOverrides[SKILL] = { [key]: 12345 };
  const { combat, inst } = mk(SKILL);
  combat.update(1 / 30);
  T(`全局覆写生效（${key}: ${DEF[key]} → ${inst._params?.[key]}）`, inst._params?.[key] === 12345);
  T('未覆写的其它键仍是出厂值',
    Object.keys(DEF).filter(k => k !== key).every(k => inst._params[k] === DEF[k]));
}

// ---- ③ 地图覆写压过全局覆写（顺序不能反）----
{
  reset();
  const key = Object.keys(DEF)[0];
  CONFIG.skillOverrides[SKILL] = { [key]: 111 };
  SkillLibrary._mapOverrides = { melee: { [SKILL]: { [key]: 222 } } };
  const { combat, inst } = mk(SKILL);
  combat.update(1 / 30);
  T(`地图层压过全局层（全局 111 / 地图 222 → ${inst._params?.[key]}）`, inst._params?.[key] === 222);
}

// ---- ④ 地图只覆写了一部分键时，其余键仍走全局层 ----
// 这条最容易写错成"有地图覆写就整体替换"，那样全局层会被静默丢掉。
{
  const keys = Object.keys(DEF);
  if (keys.length >= 2) {
    reset();
    CONFIG.skillOverrides[SKILL] = { [keys[0]]: 111, [keys[1]]: 333 };
    SkillLibrary._mapOverrides = { melee: { [SKILL]: { [keys[0]]: 222 } } };
    const { combat, inst } = mk(SKILL);
    combat.update(1 / 30);
    T('地图只覆写部分键时，其余键仍取全局层（不是整体替换）',
      inst._params[keys[0]] === 222 && inst._params[keys[1]] === 333);
  } else {
    T('（该技能只有一个参数，跳过部分覆写用例）', true);
  }
}

// ---- ⑤ 没有 defaultParams 的技能也能被全局覆写 ----
// 原实现是 `if (!inst._params && def.defaultParams)`，于是未声明 defaultParams 的
// 技能永远拿不到覆写 —— 改了没反应。修好后这里必须成立。
{
  reset();
  const bare = Object.entries(SkillLibrary).find(([id, d]) =>
    d && typeof d === 'object' && d.id && !d.defaultParams && (d.onFrame || d.onHit));
  if (bare) {
    const [bid] = bare;
    CONFIG.skillOverrides[bid] = { __probe: 7 };
    const { combat, inst } = mk(bid);
    combat.update(1 / 30);
    T(`未声明 defaultParams 的技能（${bid}）也能拿到覆写`, inst._params?.__probe === 7);
  } else {
    T('（找不到未声明 defaultParams 的技能，跳过）', true);
  }
}

// ---- ⑥ 覆写为空对象时不应凭空造出 _params ----
{
  reset();
  const noParam = Object.entries(SkillLibrary).find(([id, d]) =>
    d && typeof d === 'object' && d.id && !d.defaultParams && (d.onFrame || d.onHit));
  if (noParam) {
    const { combat, inst } = mk(noParam[0]);
    combat.update(1 / 30);
    T('无出厂值且无覆写 → 不创建 _params（保持原行为）', inst._params === undefined);
  } else { T('（跳过）', true); }
}

// ---- ⑦ 编辑器侧：写入/清除/空壳清理 ----
{
  reset();
  const { AttributeEditor: A } = await import('../src/ui/AttributeEditor.js');
  const list = A._skillsWithParams();
  T(`可调技能列表非空（${list.length} 个）`, list.length > 0);
  T('列表只含声明了 defaultParams 的技能',
    list.every(s => s.params && Object.keys(s.params).length > 0));

  // 模拟面板：两个输入框，一个填值一个留空
  const key = Object.keys(DEF)[0];
  const inputs = [
    { dataset: { skill: SKILL, param: key }, value: '42' },
    { dataset: { skill: SKILL, param: '__zzz' }, value: '' },
  ];
  const overlay = { querySelectorAll: (sel) => (sel === '.skillparam-input' ? inputs : []) };
  A._applySkillParamsChanges(overlay, () => {});
  T('面板写入进 CONFIG.skillOverrides', CONFIG.skillOverrides[SKILL][key] === 42);

  // 全部留空 → 该技能的覆写应被整体删掉，不留 `"id": {}` 这种噪音
  inputs[0].value = '';
  A._applySkillParamsChanges(overlay, () => {});
  T('全部留空后不留空壳（存档里不攒无信息量的 {}）',
    CONFIG.skillOverrides[SKILL] === undefined);

  // 非法输入不该写坏配置
  inputs[0].value = 'abc';
  A._applySkillParamsChanges(overlay, () => {});
  T('非法输入被忽略（不写入 NaN）', CONFIG.skillOverrides[SKILL] === undefined);
}

// ---- ⑧ 覆写进存档 ----
{
  reset();
  CONFIG.skillOverrides[SKILL] = { [Object.keys(DEF)[0]]: 55 };
  const { exportTemplates, importTemplates } = await import('../src/data/templateIO.js');
  const snap = exportTemplates(CONFIG);
  CONFIG.skillOverrides = {};
  importTemplates(CONFIG, snap);
  T('技能覆写可存档并原样读回', CONFIG.skillOverrides[SKILL][Object.keys(DEF)[0]] === 55);
}

reset();
console.log(`技能全局参数覆写验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
