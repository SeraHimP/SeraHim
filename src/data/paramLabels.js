/**
 * paramLabels.js —— 技能参数键 → 中文名（模板编辑器"技能数值"页用）。
 * Q1 UI 审查：那一页原来直接把参数键（radius / pctPerSec / durationSec……）当标签显示。
 * 同一个键在不同技能里含义一致时共用一条；没收录的键退回显示键名本身。
 */
export const PARAM_LABELS = {
  chargeTimeAtAS1: '充满耗时(秒，攻速1时)', tickPct: '每跳伤害(%法强)', tickPerSec: '每秒跳数',
  attackShare: '攻击特效效率', maxMult: '满充能倍率(%)', maxPenPct: '满充能无视防御(%)',
  bonusVsShieldPct: '对护盾目标加伤(%)', slowPct: '减速(%)', ampDownPct: '降低伤害增幅(%)',
  asDownPct: '降低攻速(%)', grievousPct: '重伤(%)',
  attackDamagePct: '物理攻击(%)', radius: '半径',
  perStackAdPct: '每层伤害(%物攻/秒)', poisonMaxStacks: '中毒最大层数', slowPctPerStack: '每层减速(%)',
  slowMaxStacks: '减速最大层数', atkSpeedDownPctPerStack: '每层减攻速(%)', atkSpeedDownMaxStacks: '减攻速最大层数',
  preDamageMultPct: '单发伤害(%)', onHitEffPct: '攻击特效效率(%)', baseAttackSpeedBonusPct: '基础攻速加成(%)',
  stackPct: '每层攻速(%)', maxStacks: '最大层数', maxMultPct: '满充能伤害(%)',
  statPct: '继承属性(%)', leashRadius: '活动半径', maxAlive: '同时存在上限', baseRespawnSec: '复活等待(秒)',
  respawnGrowthPct: '每次死亡复活等待增加(%)', idleClearance: '待机位距塔边缘', outOfCombatHealPowerPct: '脱战治疗与护盾强度(%)',
  maxBranches: '最多目标数', basePct: '基础(%)', falloffPctPerExtra: '每多一个目标降低(%)', minBranchPct: '单条下限(%)',
  chargeSecAt1AS: '充满耗时(秒，攻速1时)', damagePct: '伤害(%)', decayPctPerSec: '打断后每秒衰减(%)', onlyVs: '只对哪类目标充能',
  regen: '生命恢复/秒', earlyDefenseBonus: '前期额外双抗', earlyDefenseDuration: '前期加成持续(秒)',
  selfPlainValue: '自身护盾', selfFixedValue: '自身固定护盾', allyPlainValue: '友军护盾', perTick: '每跳护盾', cap: '上限',
  tickInterval: '间隔(秒)', durationSec: '持续(秒)',
  adStartT: '攻击成长开始(秒)', stepAD: '每步物攻', totalSteps: '总步数', armorPerStep: '每步双抗', resistGrowthStartT: '双抗成长开始(秒)',
  bonusVsTowerPct: '对塔加伤(%)', perSpiritPct: '每只幻灵加成(%)', reductionPct: '减伤(%)',
  pct: '比例(%)', base: '基数',
  onHitSlowPct: '命中减速(%)', onHitSlowSec: '命中减速持续(秒)', shieldChancePct: '护盾触发几率(%)',
  shieldCooldownSec: '护盾冷却(秒)', shieldAmount: '护盾量',
  convertPct: '伤害转化(%)', bonusApPct: '额外伤害(%法强)', apScalePct: '法强加成(%)', pctPerSec: '每秒(%当前生命)',
  flatBase: '固定值', reflectPct: '反弹(%)', damageReductionPct: '减伤(%)', hpScalePct: '属性比例(%)',
  drainPctPerSec: '每秒衰减(%最大生命)', damageAmpPct: '伤害增幅(%)',
};

export const paramLabel = (k) => PARAM_LABELS[k] || k;
