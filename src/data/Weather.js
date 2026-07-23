/**
 * Weather.js —— 天气系统的数据定义（v33 全表重做，旧效果全部废弃）
 *
 * 两层结构：
 *   第一层【基础天气】5 种：参与 OU 随机游走，权重恒和为 1，连续演化。
 *     定位（用户定稿）：晴=全员轻微加成 / 雨=塔优势 / 雾=兵优势 /
 *                       风=平衡·节奏加快 / 雪=平衡·节奏减慢。
 *   第二层【极端天气】15 种 = 10 组合 + 5 单基础：
 *     · 组合极端（10）：5 种基础两两组合（C(5,2)=10，一对不缺），双方充能同时达标时涌现；
 *     · 单基础极端（5，v33 追加）：某一种基础天气【独自极端化】（充能达严重档附近）时涌现，
 *       主题 = 该基础定位的极化放大。触发阈值（0.62）远高于组合的单边阈值（0.26）——
 *       组合极端靠"两股势力交汇"，单基础极端靠"一股势力独大"，两者可以并存。
 *     均不参与游走，由基础天气充能驱动。
 *
 * 强度档位（v33 定稿）：
 *   轻微25% / 有限50% / 中等75% / 严重100% / 极端150%
 *   第 5 档【极端】只有极端天气实体能达到（充能 ≥88%）；基础天气封顶严重档。
 */

// ==================== 目标筛选器 ====================
export const TARGET_MATCHERS = {
  all: () => true,

  // 建筑
  towers: (e) => e.type === 'tower',
  tower_lightning: (e) => e.type === 'tower' && _hasWeapon(e, 'weapon_lightning'),
  tower_piercing: (e) => e.type === 'tower' && _hasWeapon(e, 'weapon_piercing'),
  tower_outer: (e) => e.type === 'tower' && e._mapTier === 'outer',
  tower_inner: (e) => e.type === 'tower' && e._mapTier === 'inner',
  tower_base: (e) => e.type === 'tower' && e._mapTier === 'base',
  tower_hq: (e) => e.type === 'tower' && e._mapTier === 'hq_tower',

  // 小兵
  minions: (e) => e.type !== 'tower' && e.type !== 'dragon',
  minion_melee: (e) => e.type === 'melee',
  minion_ranged: (e) => e.type === 'ranged',
  minion_siege: (e) => e.type === 'siege',
  minion_super: (e) => e.type === 'super',
  minion_ranged_siege: (e) => e.type === 'ranged' || e.type === 'siege',
};

function _hasWeapon(entity, weaponId) {
  return (entity._skillInstances || []).some(i => i.skillId === weaponId);
}

// ==================== 强度档位（v33：新增第 5 档"极端"） ====================
// 档位由【充能值】决定（不是占比）。第 5 档只对极端天气实体开放：
// tierOf(charge) 用于基础天气（封顶严重），tierOfExtreme(charge) 用于极端天气。
export const INTENSITY_TIERS = [
  { id: 'none',     name: '无',   threshold: 0.00, scale: 0.00, pips: 0 },
  { id: 'slight',   name: '轻微', threshold: 0.15, scale: 0.25, pips: 0 },
  { id: 'limited',  name: '有限', threshold: 0.28, scale: 0.50, pips: 1 },
  { id: 'moderate', name: '中等', threshold: 0.45, scale: 0.75, pips: 2 },
  { id: 'severe',   name: '严重', threshold: 0.65, scale: 1.00, pips: 3 },
];
// 第 5 档：仅极端天气实体。充能 ≥88% 触发，效果 150%（超额，体现"极端"）。
export const EXTREME_TIER = { id: 'extreme', name: '极端', threshold: 0.88, scale: 1.50, pips: 3, isExtremeTier: true };

/** 基础天气的档位（封顶：严重） */
export function tierOf(charge) {
  let t = INTENSITY_TIERS[0];
  for (const tier of INTENSITY_TIERS) {
    if (charge >= tier.threshold) t = tier;
  }
  return t;
}

/** 极端天气实体的档位（可达第 5 档"极端"） */
export function tierOfExtreme(charge) {
  if (charge >= EXTREME_TIER.threshold) return EXTREME_TIER;
  return tierOf(charge);
}

// ==================== 第一层：基础天气（v33 新表，满档值） ====================
// 效果表给出【严重档】数值；实际生效 = 满档值 × 档位系数（0.25/0.5/0.75/1.0）。
export const BASE_WEATHERS = {
  // ☀️ 晴：全员轻微加成——阳光普照，人人受益，但不改变对局结构。
  clear: {
    id: 'clear', name: '晴', icon: '☀️', color: '#f6c94a',
    mu: 0.5,
    desc: '阳光普照。全体单位获得轻微加成，战场生机勃勃。',
    effects: [
      { targets: 'all', statKey: 'damageAmpPct', flat: 8 },
      { targets: 'all', statKey: 'healthRegen', flat: 2 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 8 },
    ],
  },
  // 🌧️ 雨：塔优势——塔在雨幕中愈战愈勇，兵线泥泞迟缓、装甲锈蚀。
  rain: {
    id: 'rain', name: '雨', icon: '🌧️', color: '#5b9bd5',
    mu: 0.2,
    desc: '雨幕滋养防线。塔的火力与恢复提升，兵线泥泞迟缓、装甲锈蚀。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 20 },
      { targets: 'towers', statKey: 'healthRegen', flat: 4 },
      { targets: 'towers', statKey: 'healShieldPowerPct', flat: 33 },
      { targets: 'minions', statKey: 'armor', flat: -12 },
      { targets: 'minions', statKey: 'magicResist', flat: -12 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
  },
  // 🌫️ 雾：兵优势——塔变瞎，小兵在雾中变硬变凶。
  fog: {
    id: 'fog', name: '雾', icon: '🌫️', color: '#9aa3ae',
    mu: 0.1,
    desc: '能见度极低。防御塔难以瞄准，小兵借雾掩护变得坚硬凶悍。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -30 },
      { targets: 'minions', statKey: 'armor', flat: 25 },
      { targets: 'minions', statKey: 'magicResist', flat: 25 },
      { targets: 'minions', statKey: 'healthRegen', flat: 2 },
      { targets: 'minions', statKey: 'damageAmpPct', flat: 10 },
    ],
  },
  // 💨 风：平衡·节奏加快——大家一起快，谁也不占谁便宜。
  wind: {
    id: 'wind', name: '风', icon: '💨', color: '#7ee0c0',
    mu: 0.15,
    desc: '大风席卷战场。塔与兵线全面提速，战斗节奏加快。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 25 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 25 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: 15 },
    ],
  },
  // ❄️ 雪：平衡·节奏减慢——全场冻结，战线凝滞。
  snow: {
    id: 'snow', name: '雪', icon: '❄️', color: '#dbe9f4',
    mu: 0.08,
    desc: '风雪封锁。塔与兵线全面减速，战线陷入凝滞。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -20 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -35 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -20 },
    ],
  },
};

// ==================== 第二层：极端天气（v33：10 组合 + 5 单基础 = 15 种） ====================
// trigger：{ 基础天气id: 最低充能值 }（两成分都要达标）。
// weight：出现倾向（-1~+1，配置面板可调）——权重越高实际触发阈值越低。
// 极端天气可达第 5 档"极端"（充能≥88%，效果 150%），显示自带辉光。
export const EXTREME_WEATHERS = {
  // 晴+雨 → 太阳雨：塔优势放大 + 全员滋养
  sunshower: {
    id: 'sunshower', name: '太阳雨', icon: '🌦️', color: '#8fd0a8',
    trigger: { clear: 0.26, rain: 0.26 }, weight: 0.1,
    desc: '晴空落雨，万物疯长。塔的火力与恢复暴涨，兵线也被雨水滋养。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 35 },
      { targets: 'towers', statKey: 'healthRegen', flat: 6 },
      { targets: 'towers', statKey: 'healShieldPowerPct', flat: 60 },
      { targets: 'minions', statKey: 'healthRegen', flat: 4 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
  },
  // 晴+雾 → 蜃景：兵优势极化
  mirage: {
    id: 'mirage', name: '蜃景', icon: '🌫', color: '#c9b37e',
    trigger: { clear: 0.26, fog: 0.26 }, weight: 0.1,
    desc: '烈日蒸腾出扭曲的幻象。塔的弹道被折射带偏，兵线借幻影长驱直入。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -45 },
      { targets: 'minions', statKey: 'armor', flat: 35 },
      { targets: 'minions', statKey: 'magicResist', flat: 35 },
      { targets: 'minions', statKey: 'damageAmpPct', flat: 15 },
    ],
  },
  // 晴+风 → 沙暴（保留）
  sandstorm: {
    id: 'sandstorm', name: '沙暴', icon: '🏜️', color: '#d4a05a',
    trigger: { clear: 0.26, wind: 0.26 }, weight: 0.15,
    desc: '干燥狂风卷起黄沙。弹头磨损、塔穿甲被废，沙尘成为兵线的掩护与顺风。',
    effects: [
      { targets: 'towers', statKey: 'armorPenPercent', flat: -50 },
      { targets: 'towers', statKey: 'attackDamage', percent: -15 },
      { targets: 'minions', statKey: 'armor', flat: 30 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 30 },
    ],
  },
  // 晴+雪 → 雪盲：雪地反光刺眼，双方都打折的慢局
  snowblind: {
    id: 'snowblind', name: '雪盲', icon: '🕶️', color: '#e8f0f8',
    trigger: { clear: 0.26, snow: 0.26 }, weight: 0.05,
    desc: '烈日照雪，反光刺目。塔与兵都睁不开眼，攻势全面萎靡。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -30 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -15 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -30 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
  },
  // 雨+雾 → 暴雨（保留）
  downpour: {
    id: 'downpour', name: '暴雨', icon: '🌧', color: '#3d7ea6',
    trigger: { rain: 0.26, fog: 0.26 }, weight: 0.15,
    desc: '倾盆大雨裹着水雾。塔在雨中愈发迅捷，兵线浑身湿透、寸步难行。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 35 },
      { targets: 'towers', statKey: 'healthRegen', flat: 4 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -35 },
      { targets: 'minions', statKey: 'armor', flat: -25 },
      { targets: 'minions', statKey: 'magicResist', flat: -25 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -30 },
    ],
  },
  // 雨+风 → 雷暴（吞并旧"雷雨交加"；闪电杖特供改为通用双穿——雷电击穿，谁都吃）
  thunderstorm: {
    id: 'thunderstorm', name: '雷暴', icon: '⛈️', color: '#7c5cff',
    trigger: { rain: 0.26, wind: 0.26 }, weight: 0.2,
    desc: '电闪雷鸣、狂风怒号。塔的射速与火力双双暴涨，雷电击穿一切防御。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 40 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 45 },
      { targets: 'towers', statKey: 'armorPenPercent', flat: 20 },
      { targets: 'towers', statKey: 'magicPenPercent', flat: 20 },
      { targets: 'minions', statKey: 'armor', flat: -30 },
      { targets: 'minions', statKey: 'magicResist', flat: -30 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -30 },
    ],
  },
  // 雨+雪 → 冻雨：冰壳裹身，兵线又慢又脆
  freezing_rain: {
    id: 'freezing_rain', name: '冻雨', icon: '🧊', color: '#7fb8d8',
    trigger: { rain: 0.26, snow: 0.26 }, weight: 0.1,
    desc: '雨落成冰。兵线被冰壳裹住，行动僵硬、护甲冻裂；塔趁势提速收割。',
    effects: [
      { targets: 'minions', statKey: 'moveSpeed', percent: -50 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -25 },
      { targets: 'minions', statKey: 'armor', flat: -20 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 15 },
    ],
  },
  // 雾+风 → 霾潮：快节奏的兵优势——最危险的推进天气
  haze_surge: {
    id: 'haze_surge', name: '霾潮', icon: '🌪️', color: '#8a9a6b',
    trigger: { fog: 0.26, wind: 0.26 }, weight: 0.1,
    desc: '狂风卷着浓霾扑向防线。塔看不清也拦不住，兵线在霾中高速推进。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -30 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 20 },
      { targets: 'minions', statKey: 'armor', flat: 25 },
      { targets: 'minions', statKey: 'magicResist', flat: 25 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 30 },
    ],
  },
  // 雾+雪 → 白茫（whiteout）：全场最慢+塔最瞎——铁王八局之王
  whiteout: {
    id: 'whiteout', name: '白茫', icon: '🌨️', color: '#cfd8e0',
    trigger: { fog: 0.26, snow: 0.26 }, weight: 0.05,
    desc: '白茫茫一片，天地不分。塔近乎失明，兵线在深雪中蠕行。铁王八局之王。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -40 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -25 },
      { targets: 'minions', statKey: 'armor', flat: 30 },
      { targets: 'minions', statKey: 'magicResist', flat: 30 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -40 },
    ],
  },
  // 风+雪 → 暴风雪（保留）
  blizzard: {
    id: 'blizzard', name: '暴风雪', icon: '🌨', color: '#c3dbf0',
    trigger: { wind: 0.26, snow: 0.26 }, weight: 0.1,
    desc: '白毛风横扫战场。全线冻结，最慢的消耗局。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -40 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -55 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -35 },
    ],
  },

  // ==================== 单基础极端（v33 追加，5 种） ====================
  // 触发 = 单个基础天气充能 ≥0.62（严重档附近才涌现）；主题 = 该基础定位的极化。

  // 晴 → 烈日：全员轻微加成 → 极化为"晒得亢奋但脱水"——全员输出大涨、恢复转负
  scorch: {
    id: 'scorch', name: '烈日', icon: '🔥', color: '#f2a13c',
    trigger: { clear: 0.62 }, weight: 0.1,
    desc: '万里无云，烈日当空。全场晒得亢奋——火力与手速大涨，但恢复被高温蒸干。',
    effects: [
      { targets: 'all', statKey: 'attackDamage', percent: 25 },
      { targets: 'all', statKey: 'bonusAttackSpeedPct', flat: 15 },
      { targets: 'all', statKey: 'healthRegen', flat: -4 },
    ],
  },
  // 雨 → 洪涝：塔优势 → 极化为"兵线泡在水里挣扎"
  flood: {
    id: 'flood', name: '洪涝', icon: '🌊', color: '#4a8fbf',
    trigger: { rain: 0.62 }, weight: 0.1,
    desc: '雨势失控，峡谷成河。兵线在水中寸步难行，高处的塔稳坐钓鱼台。',
    effects: [
      { targets: 'minions', statKey: 'moveSpeed', percent: -35 },
      { targets: 'minions', statKey: 'armor', flat: -25 },
      { targets: 'minions', statKey: 'magicResist', flat: -25 },
      { targets: 'towers', statKey: 'healthRegen', flat: 8 },
      { targets: 'towers', statKey: 'healShieldPowerPct', flat: 40 },
    ],
  },
  // 雾 → 浓雾：兵优势 → 极化为"塔近乎失明"
  densefog: {
    id: 'densefog', name: '浓雾', icon: '🌁', color: '#9aa7b5',
    trigger: { fog: 0.62 }, weight: 0.1,
    desc: '伸手不见五指。塔的索敌近乎瘫痪，兵线在雾中放开手脚。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -50 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -25 },
      { targets: 'minions', statKey: 'damageAmpPct', flat: 20 },
      { targets: 'minions', statKey: 'damageReduction', flat: 10 },
    ],
  },
  // 风 → 飓风：节奏加快 → 极化为"全场狂飙但站不稳"
  hurricane: {
    id: 'hurricane', name: '飓风', icon: '🌀', color: '#6fc7c0',
    trigger: { wind: 0.62 }, weight: 0.1,
    desc: '狂风撕扯战场。所有单位被吹得飞快——出手快、跑得快、也站不稳。',
    effects: [
      { targets: 'all', statKey: 'moveSpeed', percent: 45 },
      { targets: 'all', statKey: 'bonusAttackSpeedPct', flat: 25 },
      { targets: 'all', statKey: 'armor', flat: -15 },
      { targets: 'all', statKey: 'magicResist', flat: -15 },
    ],
  },
  // 雪 → 寒潮：节奏减慢 → 极化为"全场冻结"（一切都慢，包括死亡）
  coldsnap: {
    id: 'coldsnap', name: '寒潮', icon: '🥶', color: '#a8c8e8',
    trigger: { snow: 0.62 }, weight: 0.1,
    desc: '气温骤降，万物冻僵。全场动作迟滞，但寒冷也让伤口凝住——死亡同样变慢。',
    effects: [
      { targets: 'all', statKey: 'moveSpeed', percent: -40 },
      { targets: 'all', statKey: 'bonusAttackSpeedPct', flat: -30 },
      { targets: 'all', statKey: 'damageReduction', flat: 15 },
    ],
  },
};

// 便捷合集（UI 遍历用）
export const ALL_WEATHERS = { ...BASE_WEATHERS, ...EXTREME_WEATHERS };

// ==================== 气候模板（按真实世界的地貌/气候带） ====================
export const CLIMATE_TEMPLATES = {
  random: {
    id: 'random', name: '全随机', icon: '🎲',
    desc: '每局完全随机的天气性格（默认）。',
    mu: null,
  },
  temperate: {
    id: 'temperate', name: '温带', icon: '🏞️',
    desc: '四季分明、天气均衡。各类天气都有机会出现。',
    mu: { clear: 0.35, rain: 0.15, fog: 0.0, wind: -0.05, snow: -0.25 },
  },
  desert: {
    id: 'desert', name: '沙漠', icon: '🏜️',
    desc: '撒哈拉。常年烈日当空，几乎不下雨；大风卷起沙暴。',
    mu: { clear: 1.0, rain: -0.9, fog: -0.8, wind: 0.05, snow: -1.0 },
  },
  rainforest: {
    id: 'rainforest', name: '热带雨林', icon: '🌴',
    desc: '亚马逊。几乎天天下雨，雷暴频发。',
    mu: { clear: -0.3, rain: 1.0, fog: 0.15, wind: -0.5, snow: -1.0 },
  },
  polar: {
    id: 'polar', name: '极地', icon: '🏔️',
    desc: '南极。风雪常态，暴风雪与白茫轮番上阵，战局极度缓慢。',
    mu: { clear: -0.4, rain: -0.8, fog: -0.1, wind: 0.25, snow: 1.0 },
  },
  oceanic: {
    id: 'oceanic', name: '海洋性', icon: '🌊',
    desc: '英伦。阴雨连绵、大雾弥漫，暴雨多发。',
    mu: { clear: -0.15, rain: 0.55, fog: 0.7, wind: 0.05, snow: -0.3 },
  },
  plateau: {
    id: 'plateau', name: '高原', icon: '⛰️',
    desc: '青藏。烈日与强风并存，偶有风雪。',
    mu: { clear: 0.55, rain: -0.35, fog: -0.5, wind: 0.5, snow: 0.1 },
  },
  steppe: {
    id: 'steppe', name: '草原', icon: '🌾',
    desc: '蒙古。大风是常态，干燥少雨，沙暴多发。',
    mu: { clear: 0.25, rain: -0.45, fog: -0.6, wind: 0.8, snow: -0.1 },
  },
};
