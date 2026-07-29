/**
 * schema/index.js —— 可编辑对象注册表（P1 地基）
 *
 * ============ 这个模块要解决什么问题 ============
 * 本项目里反复出现同一类事故：**编辑器写 A，运行时读 B**。已发生至少三次：
 *   ① 分层塔被动 —— 编辑器写 CONFIG.templates.tower._templateSkills，
 *                   而 createBuilding 读的是硬编码的默认装配；
 *   ② 分层塔武器 —— 编辑器写 _templateWeapon，createBuilding 读地图的 weapon 字段；
 *   ③ 出兵规则 —— 编辑器写 gameRules.wave*Count，对战出兵读 laneWaveComposition。
 * 三次都不是手滑，是缺少「编辑器字段 ↔ 运行时读取点」的强制绑定机制：
 * 两边各写各的取值代码，谁也不知道对方在读哪。
 *
 * 解法：把"什么可编辑"从 UI 里抽出来变成数据（Schema），每个字段自带一对
 * **get/set 存取器**，而且【运行时也用同一对】。于是"两边不一致"从可能变成不可能。
 *
 * ============ 怎么用 ============
 *   import { SCHEMA, listGroups, getField, readField, writeField } from './schema/index.js';
 *   readField('tower.outer', 'attackDamage', { faction: 'blue' })
 *   writeField('tower.outer', 'attackDamage', 200, { faction: 'blue' })
 *
 * UI 只负责"把 group 的字段列表渲染成控件"，不再关心任何存取路径。
 * 新增可编辑项 = 加一条 Schema，不用碰 UI 代码。
 *
 * ============ 不变量（由 tests/sim_schema.mjs 守住）============
 *   1. 每个字段 write 之后 read 必须拿回同一个值（往返一致）；
 *   2. 每个字段声明的 runtime 读取点必须真的存在（防止 Schema 与运行时脱节）；
 *   3. 数值字段必须有 min/max，且默认值落在区间内。
 */
import { CONFIG } from '../Config.js';

// ==================== 存取器：塔按层级 ====================
// 与 main.js createBuilding 的解析顺序【严格同序】：
//   地图 tierStats（初始值） → CONFIG.towerTierOverrides[tier] → factionOverrides[faction]['tower_'+tier]
// 这段顺序只在这里写一次，createBuilding 与编辑器都从这里取。
export function towerTierBase(tier) {
  const map = (typeof window !== 'undefined' && window.CTX?.__app?.mapSystem?.currentMap) || null;
  const fromMap = (map?.tierStats && map.tierStats[tier]) || {};
  return { ...(CONFIG.templates.tower || {}), ...fromMap };
}

export function towerTierEffective(tier, faction) {
  const shared = CONFIG.towerTierOverrides?.[tier] || {};
  const fac = (faction && faction !== 'shared')
    ? (CONFIG.factionOverrides?.[faction]?.['tower_' + tier] || {}) : {};
  return { ...towerTierBase(tier), ...shared, ...fac };
}

function towerStatGet(tier, key, ctx) {
  return towerTierEffective(tier, ctx?.faction)[key];
}

function towerStatSet(tier, key, v, ctx) {
  // 覆写层只存"与上一层不同的字段"：改回原值自动清除，不留垃圾。
  const base = towerTierBase(tier);
  const fac = ctx?.faction;
  let store;
  if (!fac || fac === 'shared') {
    CONFIG.towerTierOverrides = CONFIG.towerTierOverrides || {};
    store = CONFIG.towerTierOverrides[tier] = CONFIG.towerTierOverrides[tier] || {};
  } else {
    CONFIG.factionOverrides[fac] = CONFIG.factionOverrides[fac] || {};
    store = CONFIG.factionOverrides[fac]['tower_' + tier] = CONFIG.factionOverrides[fac]['tower_' + tier] || {};
  }
  if (v === base[key]) delete store[key]; else store[key] = v;
}

// ==================== 存取器：小兵按类型 ====================
function minionStatGet(type, key, ctx) {
  const base = CONFIG.templates[type] || {};
  const fac = ctx?.faction;
  const ovr = (fac && fac !== 'shared') ? (CONFIG.factionOverrides?.[fac]?.[type] || {}) : {};
  return ({ ...base, ...ovr })[key];
}

function minionStatSet(type, key, v, ctx) {
  const base = CONFIG.templates[type] || {};
  const fac = ctx?.faction;
  if (!fac || fac === 'shared') { base[key] = v; return; }
  CONFIG.factionOverrides[fac] = CONFIG.factionOverrides[fac] || {};
  const ovr = CONFIG.factionOverrides[fac][type] = CONFIG.factionOverrides[fac][type] || {};
  if (v === base[key]) delete ovr[key]; else ovr[key] = v;
}

function growthGet(type, key) {
  const g = CONFIG.battleGrowth?.[type] || CONFIG.battleGrowth?._default || {};
  return g[key];
}
function growthSet(type, key, v) {
  CONFIG.battleGrowth = CONFIG.battleGrowth || {};
  CONFIG.battleGrowth[type] = CONFIG.battleGrowth[type] || {};
  CONFIG.battleGrowth[type][key] = v;
}

// ==================== 字段元数据 ====================
// label/min/max/step 是给 UI 用的；runtime 是"这个字段最终在哪被消费"的可追溯记录，
// 由测试校验其存在性，防止 Schema 与运行时脱节。
const NUM = (key, label, min, max, step = 1) => ({ key, label, type: 'number', min, max, step });

const TOWER_STATS = [
  NUM('maxHP', '最大生命', 1, 50000, 50),
  NUM('armor', '护甲', -100, 500, 1),
  NUM('magicResist', '魔法抗性', -100, 500, 1),
  NUM('attackDamage', '攻击力', 0, 3000, 1),
  NUM('baseAttackSpeed', '基础攻速', 0, 10, 0.01),
  NUM('attackRange', '攻击距离', 0, 1000, 5),
  NUM('healthRegen', '生命恢复', -100, 500, 1),
  NUM('shieldFixedMax', '固定护盾', 0, 10000, 50),
];

const MINION_STATS = [
  NUM('maxHP', '最大生命', 1, 50000, 10),
  NUM('armor', '护甲', -100, 500, 1),
  NUM('magicResist', '魔法抗性', -100, 500, 1),
  NUM('attackDamage', '攻击力', 0, 3000, 1),
  NUM('baseAttackSpeed', '基础攻速', 0, 10, 0.01),
  NUM('attackRange', '攻击距离', 0, 1000, 5),
  NUM('moveSpeed', '移动速度', 0, 500, 1),
  NUM('healthRegen', '生命恢复', -100, 500, 1),
];

const GROWTH_FIELDS = [
  NUM('hp', '最大生命 /波', 0, 200, 0.1),
  NUM('ad', '攻击力 /波', 0, 50, 0.05),
  NUM('res', '双抗 /波', 0, 20, 0.05),
];

const TOWER_TIERS = [
  ['outer', '外塔'], ['inner', '内塔'], ['base', '水晶塔'],
  ['hq_tower', '枢纽塔'], ['nexus_lane', '召唤水晶'], ['nexus_main', '水晶枢纽'],
];
const MINION_TYPES = [
  ['melee', '近战兵'], ['ranged', '远程兵'], ['siege', '炮兵'], ['super', '超级兵'],
  ['totem', '图腾兵'], ['warlock', '术士兵'], ['corrupt', '蚀骨兵'], ['ram', '攻城车'],
];

// ==================== 注册表 ====================
export const SCHEMA = {};

for (const [tier, label] of TOWER_TIERS) {
  SCHEMA['tower.' + tier] = {
    id: 'tower.' + tier,
    category: 'tower',
    label,
    scopes: ['shared', 'blue', 'red'],       // 支持阵营覆写
    runtime: 'main.js createBuilding',        // 这些字段最终在哪被消费
    fields: TOWER_STATS.map(f => ({
      ...f,
      get: (ctx) => towerStatGet(tier, f.key, ctx),
      set: (ctx, v) => towerStatSet(tier, f.key, v, ctx),
      base: () => towerTierBase(tier)[f.key],
    })),
  };
}

for (const [type, label] of MINION_TYPES) {
  SCHEMA['minion.' + type] = {
    id: 'minion.' + type,
    category: 'minion',
    label,
    scopes: ['shared', 'blue', 'red'],
    runtime: 'main.js createMinion',
    fields: MINION_STATS.map(f => ({
      ...f,
      get: (ctx) => minionStatGet(type, f.key, ctx),
      set: (ctx, v) => minionStatSet(type, f.key, v, ctx),
      base: () => (CONFIG.templates[type] || {})[f.key],
    })),
  };
  SCHEMA['growth.' + type] = {
    id: 'growth.' + type,
    category: 'growth',
    label: label + ' · 对战成长',
    scopes: ['shared'],                       // 成长表暂不分阵营
    runtime: 'main.js battleGrowthFlat',
    fields: GROWTH_FIELDS.map(f => ({
      ...f,
      get: () => growthGet(type, f.key),
      set: (_ctx, v) => growthSet(type, f.key, v),
      base: () => growthGet(type, f.key),
    })),
  };
}

// ==================== 对外 API ====================
export function listGroups(category) {
  const all = Object.values(SCHEMA);
  return category ? all.filter(g => g.category === category) : all;
}

export function getField(groupId, key) {
  return SCHEMA[groupId]?.fields.find(f => f.key === key) || null;
}

export function readField(groupId, key, ctx) {
  const f = getField(groupId, key);
  return f ? f.get(ctx || {}) : undefined;
}

export function writeField(groupId, key, value, ctx) {
  const f = getField(groupId, key);
  if (!f) return false;
  let v = value;
  if (f.type === 'number') {
    v = Number(v);
    if (!Number.isFinite(v)) return false;
    v = Math.max(f.min, Math.min(f.max, v));   // 就地钳制：越界值永远进不了配置
  }
  f.set(ctx || {}, v);
  return true;
}

/** 把一个分组的全部字段读成普通对象（供 UI 一次性渲染） */
export function readGroup(groupId, ctx) {
  const g = SCHEMA[groupId];
  if (!g) return null;
  const out = {};
  for (const f of g.fields) out[f.key] = f.get(ctx || {});
  return out;
}
