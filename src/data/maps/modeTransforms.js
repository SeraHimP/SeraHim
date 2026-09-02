import { summoners_rift } from './summoners_rift.js';

/**
 * modeTransforms.js —— 游戏模式：在地图（框架）之上做二次修正
 *
 * v51.20：用户定稿"游戏地图作为框架，游戏模式在框架上进行进一步修正"——
 *   地图（召唤师峡谷/嚎哭深渊/扭曲丛林）与模式（普通/经典）是两条独立可选的轴，
 *   先选模式再选地图，经典模式对任意一张地图都生效。
 *
 * 原来的"经典模式"是一张完全独立的地图文件（summoners_rift_classic.js，
 * 靠 `...summoners_rift` 展开+覆写数值实现），只能选、不能跟别的地图组合。
 * 现在改成一个**变换函数**：拿任意 base map，产出该图的经典模式版本——
 * 地图列表回到只有三张"真地图"，经典模式是套在任意一张上的修正层。
 *
 * ==================== 经典模式的内容（用户定稿，四条硬约束）====================
 *   · 所有小兵无任何技能（minionDefaultPassives 全清空）
 *   · 所有塔的武器都是穿透型（召唤水晶/水晶枢纽本来就没有武器，不动）
 *   · 塔的技能只留各层的【加固城防】——因为是身份技能，createBuilding 会在
 *     `skills: []` 之上自动补回（见该文件头注），这里只要清空显式技能列表即可
 *   · 塔的属性大幅减少
 * 用户特别澄清："经典模式不是那种给个限制说装不了。只是默认不装"——
 * 也就是说这是"默认装配表清空"，不是新增一条"经典模式禁止XX技能"的硬限制，
 * 跟 createBuilding 现有"地图可显式指定技能覆盖默认"的机制完全对得上，不用改。
 */

/** 召唤师峡谷经典模式四层塔数值——用户当时专门给的精确数（v51 定稿），原样保留。 */
const SR_CLASSIC_TIER = {
  outer:    { maxHP: 2250, armor: 70,  magicResist: 70,  baseAttackSpeed: 1.083 },
  inner:    { maxHP: 1750, armor: 80,  magicResist: 80,  baseAttackSpeed: 1.083 },
  base:     { maxHP: 3150, armor: 90,  magicResist: 90,  baseAttackSpeed: 1.083 },
  hq_tower: { maxHP: 2550, armor: 100, magicResist: 100, baseAttackSpeed: 1.083 },
};

// 嚎哭深渊/扭曲丛林经典模式的塔数值：用户目前没有专门给这两张图的经典数值
// ("你先弄个差不多的数，后期我填，经典模式不是那种给个限制说装不了，只是默认不装")。
//
// 本来想按"召唤师峡谷经典/召唤师峡谷普通"逐项算比例、套到这两张图自己的普通值上，
// 但实测这条路走不通：SR_CLASSIC_TIER 是早期定稿的一份静态数，之后 v51.18 又单独
// 砍过一轮 SR **普通模式**的塔（outer 护甲 40→15 等），两份数据不再是同一批调出来的、
// 比例已经不能反映"经典模式该长什么样"——算出来 outer 护甲比例高达 4.67 倍，HA/TT
// 经典模式的塔反而比普通模式更肉，跟"属性被大幅减少"这条硬约束正好相反。
// 改成一个简单、方向明确的占位削减比例：耐打面（HP/护甲/魔抗）统一砍到 60%，
// 攻速不动（SR 自己三层塔的攻速方向都不一致，没有可推广的规律，宁可不碰）。
// 这只是"差不多的数"，后续用户会给准确值替换掉。
const APPROX_CLASSIC_CUT = { maxHP: 0.6, armor: 0.6, magicResist: 0.6 };
const CUT_TIERS = ['outer', 'inner', 'base', 'hq_tower'];

const CLASSIC_MINION_TEMPLATES = {
  // 用户定稿："屠戮没了，所以小兵攻击力大幅提高：近战 20+、远程 40+、炮车 70+。"
  // 全局共用同一份 CONFIG.templates 基础攻击力（各地图目前都没有覆写它），
  // 所以这份数值对三张图直接复用，不用按图再算一次比例。
  melee:  { attackDamage: 20 },
  ranged: { attackDamage: 40 },
  siege:  { attackDamage: 70 },
};
const CLASSIC_SPAWN_ENABLED = {
  melee: true, ranged: true, siege: true, super: true,
  totem: false, warlock: false, corrupt: false, ram: false,
};
const CLASSIC_MINION_PASSIVES = {
  melee: [], ranged: [], siege: [], super: [],
  totem: [], warlock: [], corrupt: [], ram: [],
};

// 单下划线：故意跟旧版 summoners_rift_classic_v1 的形状（<base>_classic_v1）兼容——
// ThreeRenderer.themeOf() 剥主题后缀时先剥 `_classic` 再剥 `_v\d+`，两条正则没改，
// 用这个后缀套上去能直接复用同一套材质映射（经典模式视觉上还是那张图，不用新增主题）。
export const CLASSIC_ID_SUFFIX = '_classic';

export const MODES = {
  normal:  { id: 'normal',  label: '普通模式' },
  classic: { id: 'classic', label: '经典模式' },
};

/** 拿一张"普通模式"的 base map，产出它的经典模式版本。 */
export function applyClassicMode(baseMap) {
  const isSR = baseMap.id === summoners_rift.id;

  const tierStats = Object.fromEntries(
    Object.entries(baseMap.tierStats || {}).map(([tier, stats]) => {
      if (isSR && SR_CLASSIC_TIER[tier]) return [tier, { ...stats, ...SR_CLASSIC_TIER[tier] }];
      if (!CUT_TIERS.includes(tier)) return [tier, stats]; // 经典模式不改这一层（如召唤水晶/水晶枢纽）
      const out = { ...stats };
      for (const k of Object.keys(APPROX_CLASSIC_CUT)) if (out[k] != null) out[k] = Math.round(out[k] * APPROX_CLASSIC_CUT[k] * 1000) / 1000;
      return [tier, out];
    }),
  );

  const buildings = (baseMap.buildings || []).map(b => ({
    ...b,
    weapon: (b.tier === 'nexus_lane' || b.tier === 'nexus_main') ? null : 'piercing',
    skills: [],
  }));

  return {
    ...baseMap,
    id: `${baseMap.id}${CLASSIC_ID_SUFFIX}`,
    label: `${baseMap.label}（经典）`,
    // 不声明 dragon 字段 = 这个模式不生成龙，与"只有声明了才生成"的既有口径一致。
    dragon: undefined,
    tierStats,
    buildings,
    minionDefaultPassives: CLASSIC_MINION_PASSIVES,
    minionTemplates: CLASSIC_MINION_TEMPLATES,
    spawnEnabled: CLASSIC_SPAWN_ENABLED,
  };
}
