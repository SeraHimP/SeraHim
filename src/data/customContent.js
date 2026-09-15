/**
 * customContent.js —— 自制内容注册表（用户"自己做一个"的落点）
 *
 * ============ 它解决什么 ============
 * 编辑器此前只能**改现有东西的数值**。用户要的是**做出一件原本不存在的东西**：
 * 一种状态、一种兵、一把塔武器/技能。这两件事的差别不在 UI，在于
 * "新东西从哪里进入引擎"——以前根本没有这个入口，只能改源码。
 *
 * 本模块就是那个入口。三类自制内容都住在 CONFIG 里（所以自动进存档）：
 *   CONFIG.customEffects[id]  状态蓝图（纯数据，EffectRegistry 本来就吃这个形状）
 *   CONFIG.customSkills[id]   技能/武器规格（声明式，交给 behaviorVM 编译）
 *   CONFIG.customMinions[id]  兵种模板（纯数据，形状与 CONFIG.templates.* 一致）
 *
 * ============ 为什么要"注册"这一步 ============
 * 状态和兵种是纯数据，读的时候查一下就行。技能不是：引擎读的是
 * SkillLibrary 里的 `{ onHit, onFrame, ... }` 函数形状。所以自制技能必须在
 * 载入后编译一次并注册进 SkillLibrary。这一步就是 syncAll()。
 *
 * 幂等是硬要求：导入存档会重复调用，注册两次不能出现"同一技能挂两遍"。
 */
import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { compileSpec, validateSpec } from '../core/behaviorVM.js';

/** 三类自制内容在 CONFIG 上的键名。也是 templateIO 白名单要带上的键。 */
export const CUSTOM_GROUPS = ['customEffects', 'customSkills', 'customMinions'];

export function ensureCustomGroups() {
  for (const g of CUSTOM_GROUPS) {
    if (!CONFIG[g] || typeof CONFIG[g] !== 'object' || Array.isArray(CONFIG[g])) CONFIG[g] = {};
  }
  return CONFIG;
}

// ==================== 状态（最简单：纯数据）====================

/**
 * 状态蓝图的必要字段校验。
 * EffectRegistry.apply 吃的是纯数据，所以"做一个状态"真的只是填一个对象；
 * 但字段填错不会报错、只会静默不生效（比如 kind 写错就永远不影响属性），
 * 所以这里替用户挡一道。
 */
export function validateEffect(bp) {
  const errors = [];
  if (!bp || typeof bp !== 'object') return { ok: false, errors: ['状态不是一个对象'] };
  if (!bp.id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(bp.id)) {
    errors.push('缺少合法 id（只能用字母数字下划线，字母开头）');
  }
  if (!bp.name) errors.push('缺少 name（显示名称）');
  const kinds = ['stat', 'dot', 'hot', 'control', 'shield', 'marker'];
  if (!bp.kind) errors.push(`缺少 kind，可选：${kinds.join(' / ')}`);
  else if (!kinds.includes(bp.kind)) errors.push(`kind「${bp.kind}」不合法，可选：${kinds.join(' / ')}`);
  if (bp.kind === 'stat') {
    if (!bp.statKey) errors.push('kind 为 stat 时必须指定 statKey（要改哪个属性）');
    else if (CONFIG.templates.melee[bp.statKey] === undefined
          && CONFIG.templates.tower[bp.statKey] === undefined) {
      errors.push(`statKey「${bp.statKey}」不是模板里的字段`);
    }
    if (!bp.flatValue && !bp.percentValue) {
      errors.push('kind 为 stat 时 flatValue 和 percentValue 不能都为空（否则这个状态什么都不做）');
    }
  }
  if (bp.duration == null && !bp.permanent && !bp.aura) {
    errors.push('必须指定 duration（秒），或标记 permanent / aura');
  }
  if (bp.stackable && !(bp.maxStacks > 0)) errors.push('可叠加的状态必须指定 maxStacks > 0');
  return { ok: errors.length === 0, errors };
}

export function saveEffect(bp) {
  const v = validateEffect(bp);
  if (!v.ok) return v;
  ensureCustomGroups();
  // 补上 EffectRegistry 需要但用户不必关心的默认值。
  // 不补的话行为会因为"没写"而变得难以预料（例如 stackPolicy 缺省是 refresh，
  // 但一个可叠加的状态显然想要 stack）。
  const full = {
    icon: '✨', color: '#8ab4f8', stackPolicy: bp.stackable ? 'stack' : 'refresh',
    description: bp.name, descTemplate: `${bp.name}（自制状态）`,
    ...bp, _isCustom: true,
  };
  if (bp.stackable) {
    full.perStackFlat = bp.perStackFlat ?? bp.flatValue ?? 0;
    full.perStackPercent = bp.perStackPercent ?? bp.percentValue ?? 0;
  }
  CONFIG.customEffects[bp.id] = full;
  return { ok: true, errors: [] };
}

export function deleteEffect(id) {
  ensureCustomGroups();
  // 先查有没有技能在用它。删掉被引用的状态会让那个技能的 applyEffect
  // 变成静默空转 —— 用户会以为技能坏了，而根本不会想到是状态被删了。
  const used = Object.values(CONFIG.customSkills || {}).filter(s =>
    (s.rules || []).some(r => (r.do || []).some(a => a.act === 'applyEffect' && a.effect === id))
  ).map(s => s.name || s.id);
  if (used.length) {
    return { ok: false, errors: [`状态「${id}」正被这些技能使用：${used.join('、')}。请先改掉它们。`] };
  }
  delete CONFIG.customEffects[id];
  return { ok: true, errors: [] };
}

// ==================== 技能 / 武器 ====================

export function saveSkill(spec) {
  const v = validateSpec(spec);
  if (!v.ok) return v;
  ensureCustomGroups();
  CONFIG.customSkills[spec.id] = JSON.parse(JSON.stringify(spec));
  // 存完立刻注册，界面上"保存"之后就能直接装备试打，不必刷新页面
  const errs = [];
  const def = compileSpec(spec, (e) => errs.push(...e));
  if (!def) return { ok: false, errors: errs };
  SkillLibrary.register(spec.id, def);
  return { ok: true, errors: [] };
}

export function deleteSkill(id) {
  ensureCustomGroups();
  delete CONFIG.customSkills[id];
  // SkillLibrary 没有 unregister；这里直接从内部表摘掉。
  // 不摘的话已装备的实体会继续跑一个"配置里已经不存在"的技能，
  // 存档导出时看不到它、行为却还在，是最难查的一类幽灵。
  SkillLibrary._registry.delete(id);
  delete SkillLibrary[id];
  return { ok: true, errors: [] };
}

// ==================== 兵种 ====================

/** 自制兵种：形状与 CONFIG.templates.melee 一致，缺的字段从 melee 兜底。 */
export function saveMinion(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['兵种不是一个对象'] };
  if (!def.id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.id)) errors.push('缺少合法 id');
  else if (CONFIG.templates[def.id] && !CONFIG.customMinions?.[def.id]) {
    errors.push(`id「${def.id}」与内置兵种冲突，请换一个`);
  }
  if (!def.name) errors.push('缺少 name（显示名称）');
  for (const k of ['maxHP', 'attackDamage']) {
    if (!(def.stats?.[k] > 0)) errors.push(`${k} 必须大于 0`);
  }
  if (errors.length) return { ok: false, errors };

  ensureCustomGroups();
  CONFIG.customMinions[def.id] = JSON.parse(JSON.stringify(def));
  syncMinionTemplates();
  return { ok: true, errors: [] };
}

export function deleteMinion(id) {
  ensureCustomGroups();
  delete CONFIG.customMinions[id];
  delete CONFIG.templates[id];
  delete CONFIG.battleGrowth?.[id];
  // 出兵编排里引用了它的规则要一起清掉，否则 buildWaveOrder 会拿到一个
  // CONFIG.templates 里已经不存在的类型，创建小兵时静默返回 null ——
  // 表现是"这一波少了几个兵"，而没人会想到是因为删了一个兵种。
  const gr = CONFIG.gameRules;
  if (Array.isArray(gr?.laneWaveComposition)) {
    gr.laneWaveComposition = gr.laneWaveComposition.filter(r => r.type !== id);
  }
  if (gr?.spawnEnabled) delete gr.spawnEnabled[id];
  return { ok: true, errors: [] };
}

/** 把自制兵种展开进 CONFIG.templates，让所有读模板的地方无需知道"自制"这回事。 */
export function syncMinionTemplates() {
  ensureCustomGroups();
  const base = CONFIG.templates.melee || {};
  for (const [id, m] of Object.entries(CONFIG.customMinions)) {
    // 缺的字段从近战兵兜底：模板字段有几十个，让用户全填完是不现实的，
    // 而缺字段在引擎里多半不报错、只是行为静默变样（最难查的那类问题）。
    CONFIG.templates[id] = { ...base, ...(m.stats || {}) };
    CONFIG.battleGrowth = CONFIG.battleGrowth || {};
    if (m.growth) CONFIG.battleGrowth[id] = { ...m.growth };
    else if (!CONFIG.battleGrowth[id]) CONFIG.battleGrowth[id] = { ...(CONFIG.battleGrowth._default || {}) };
  }
}

/** 所有兵种类型（内置 + 自制）。UI 与出兵编排的唯一来源。 */
export function allMinionTypes() {
  ensureCustomGroups();
  return [...BUILTIN_MINION_TYPES, ...Object.keys(CONFIG.customMinions)];
}

export const BUILTIN_MINION_TYPES = ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram'];

/** 兵种的显示名/图标（内置写死，自制取用户填的）。 */
export function minionLabel(type) {
  const BUILT = { melee: '近战兵', ranged: '远程兵', siege: '炮兵', totem: '图腾兵',
                  super: '超级兵', warlock: '术士兵', corrupt: '蚀骨兵', ram: '攻城车' };
  return BUILT[type] || CONFIG.customMinions?.[type]?.name || type;
}
export function minionIcon(type) {
  const BUILT = { melee: '🗡️', ranged: '🏹', siege: '💣', super: '🦾',
                  totem: '🗿', warlock: '🧙', corrupt: '🦇', ram: '🛠️' };
  return BUILT[type] || CONFIG.customMinions?.[type]?.icon || '⚔️';
}

// ==================== 载入后的一次性同步 ====================

/**
 * 把 CONFIG 里的自制内容全部装进引擎。
 * 启动时调一次，每次导入存档后再调一次。**幂等**（register 会覆盖同名，
 * 兵种模板是整体重写），所以重复调用安全。
 * 返回 { skills, minions, effects, errors } 便于界面如实汇报。
 */
export function syncAll() {
  ensureCustomGroups();
  const errors = [];
  let skills = 0;
  for (const [id, spec] of Object.entries(CONFIG.customSkills)) {
    const errs = [];
    const def = compileSpec(spec, (e) => errs.push(...e));
    if (def) { SkillLibrary.register(id, def); skills++; }
    else errors.push(`技能「${spec?.name || id}」载入失败：${errs.join('；')}`);
  }
  syncMinionTemplates();
  return {
    skills,
    minions: Object.keys(CONFIG.customMinions).length,
    effects: Object.keys(CONFIG.customEffects).length,
    errors,
  };
}
