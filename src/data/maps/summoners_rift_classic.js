import { summoners_rift } from './summoners_rift.js';

/**
 * summoners_rift_classic.js —— 经典模式（召唤师峡谷·无技能版）
 *
 * 用户定稿：
 *   · 删除原有的 Quick Mode，由本图接替它在地图列表里的位置
 *   · **所有小兵无任何技能**
 *   · **所有塔的武器都是穿透型**
 *   · 技能只有四层塔各自的【加固城防】，除此之外也无技能
 *   · 外塔 2250/双抗70/攻速1.083；内塔 1750/80/1.083；
 *     水晶塔 3150/90/1.083/1 生命恢复；枢纽塔 2550/100/1.083/3 生命恢复
 *   · 屠戮没了，所以小兵攻击力大幅提高：近战 20+、远程 40+、炮车 70+
 *     （"炮车中期甚至可以达到 100"）
 *   · 兵种只有 近战/远程/炮兵/超级兵，其余不生成
 *   · 默认不生成龙
 *
 * ==================== 几处"不用新做"的说明 ====================
 * ① **生命恢复走的是现成的加固城防**。用户说的"通过状态实现"正是它的做法：
 *    passive_base_fortify 的 regen 就是 1、passive_hq_fortify 就是 3 —— 与用户给的数
 *    逐位吻合，所以这两项一个字都不用改，只要把技能留着。
 *    外塔/内塔那两个 fortify 的 regen 本来就是 0（只提供 33/67/100 的生命节点封顶），
 *    与用户只给水晶/枢纽标了恢复值也吻合。
 * ② **给建筑写 skills: [] 不会把加固城防一起清掉**。createBuilding 里有一段专门的补丁：
 *    地图显式给了 skills 时仍然会把该层的 fortify 补回去（那是身份技能，面板上写了就必须有）。
 *    所以"只有加固城防"这件事写 `skills: []` 就成立，不需要逐座塔列技能名。
 * ③ **炮车"中期到 100"不需要成长被动**。波次成长（gameRules 的 attrFixedPerWave 3.5%
 *    + attrCompPctPerWave 0.4% 复利）在第 10 波前后正好把 70 抬到约 98。
 *    也就是说初始值给 70，用户要的曲线自然就出来了 —— 不必为此再加一条技能，
 *    而"所有小兵无任何技能"这条硬约束也就保住了。
 */

/** 四层塔的耐打面（用户给的数）。攻击力**沿用召唤师峡谷原值**（用户定稿：没提到的不动）。 */
const CLASSIC_TIER = {
  outer:      { maxHP: 2250, armor: 70,  magicResist: 70,  baseAttackSpeed: 1.083 },
  inner:      { maxHP: 1750, armor: 80,  magicResist: 80,  baseAttackSpeed: 1.083 },
  base:       { maxHP: 3150, armor: 90,  magicResist: 90,  baseAttackSpeed: 1.083 },
  hq_tower:   { maxHP: 2550, armor: 100, magicResist: 100, baseAttackSpeed: 1.083 },
};

export const summoners_rift_classic = {
  ...summoners_rift,
  id: 'summoners_rift_classic_v1',
  label: '经典模式',

  // 龙：**不声明 dragon 字段** = 这张图不生成龙（判据见 DragonSystem.mapAllowsDragon）。
  // 刻意写成"不写"而不是 `dragon: { enabled: false }` —— 与另两张图保持同一个口径：
  // 只有召唤师峡谷声明了 dragon。多一种表达同一件事的写法，就多一处将来会读岔的地方。
  dragon: undefined,

  // ==================== 塔属性 ====================
  // 只覆盖用户给的四项（HP/护甲/魔抗/攻速）；attackDamage 与召唤水晶/水晶枢纽的血量
  // 由 `...summoners_rift.tierStats` 原样带过来。
  tierStats: Object.fromEntries(
    Object.entries(summoners_rift.tierStats || {}).map(([tier, base]) => [
      tier, { ...base, ...(CLASSIC_TIER[tier] || {}) },
    ]),
  ),

  // ==================== 建筑：全部穿透型 + 只留加固城防 ====================
  // 布局（坐标/层级/路）完全沿用召唤师峡谷，只改两件事：
  //   · weapon 一律 'piercing'（原图水晶塔/枢纽塔是闪电杖）
  //   · skills: [] —— 成长被动、过载、钢铁防线、镀层、护盾全部不装；
  //     加固城防由 createBuilding 自动补回（见头注②）。
  //     召唤水晶/水晶枢纽（isNexus）不会被补 fortify，所以它们是真的一个技能都没有。
  buildings: (summoners_rift.buildings || []).map((b) => ({
    ...b,
    weapon: (b.tier === 'nexus_lane' || b.tier === 'nexus_main') ? null : 'piercing',
    skills: [],
  })),

  // ==================== 小兵：无技能 ====================
  // 八个兵种全部置空。只写用得上的四种是不够的 ——
  // 万一将来有人在编辑器里手动放一个术士进来，它仍会带默认被动，
  // 而这张图的立意是"没有任何技能"。全部置空才是这条规则本身。
  minionDefaultPassives: {
    melee: [], ranged: [], siege: [], super: [],
    totem: [], warlock: [], corrupt: [], ram: [],
  },

  // ==================== 小兵属性 ====================
  // 用户定稿："初始近战 20+，远程 40+，炮车 70+，炮车中期攻击力甚至可以达到 100。"
  // 只改攻击力，血量/移速沿用原版 —— 用户说的是"攻击力大幅提高"，别顺手改别的。
  //
  // ⚠️ 远程(40) 比近战(20) 高一倍，与原版（近战 9 > 远程 6.5）**反过来**。
  // 这是用户明确给的数，不是笔误的可能性很高：没有屠戮之后，远程兵靠射程和站位
  // 输出，近战兵靠数量和抗伤，两者的定位本来就该分开。照填。
  //
  // 超级兵**不改**（仍 208）：它本来就没有屠戮被动（屠戮只有近战/远程/炮兵三种），
  // 所以不存在"要补偿"的问题。改它反而会凭空加强破basis之后的滚雪球。
  minionTemplates: {
    melee:  { attackDamage: 20 },
    ranged: { attackDamage: 40 },
    siege:  { attackDamage: 70 },
  },

  // ==================== 出兵：只出四种 ====================
  // 关掉的四种在默认编排里都有条目（腐蚀/术士/图腾/攻城车），
  // 靠 spawnEnabled 的闸门拦下来 —— 比重写一份编排更稳：
  // 编排是用户在编辑器里会调的东西，重写一份等于把他的调整覆盖掉。
  spawnEnabled: {
    melee: true, ranged: true, siege: true, super: true,
    totem: false, warlock: false, corrupt: false, ram: false,
  },
};
