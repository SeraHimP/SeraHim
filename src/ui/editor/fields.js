/**
 * fields.js —— 属性字段元数据（v43 P1-4 从 AttributeEditor.js 拆出）
 *
 * 中文标签 + 滑块范围 + 步长。拆出来是因为拆分后有好几块都要用它，
 * 留在任何一块里都会让其余块反向依赖那一块。
 */
// 属性字段元数据：中文标签 + 滑块范围 + 步长（供动态滑块条使用）
export const FIELD_META = {
  maxHP:              { label: '最大生命', min: 0, max: 20000, step: 50 },
  currentHP:          { label: '当前生命', min: 0, max: 20000, step: 50 },
  healthRegen:        { label: '生命回复/秒', min: 0, max: 200, step: 1 },
  baseHealthRegenMod: { label: '生命回复系数', min: 0, max: 5, step: 0.1 },
  attackDamage:       { label: '攻击力', min: 0, max: 2000, step: 5 },
  baseAttackSpeed:    { label: '基础攻速', min: 0.1, max: 5, step: 0.05 },
  bonusAttackSpeedPct:{ label: '攻速加成%', min: -100, max: 500, step: 5 },
  attackSpeedRatio:   { label: '攻速系数', min: 0, max: 2, step: 0.05 },
  attackRange:        { label: '攻击距离', min: 0, max: 800, step: 10 },
  bulletSpeed:        { label: '子弹速度', min: 0, max: 1200, step: 20 },
  armor:              { label: '护甲', min: -100, max: 500, step: 5 },
  magicResist:        { label: '魔法抗性', min: -100, max: 500, step: 5 },
  damageReduction:    { label: '伤害减免%', min: 0, max: 100, step: 1 },
  damageBlock:        { label: '格挡值', min: 0, max: 500, step: 5 },
  shieldFixedMax:     { label: '固定护盾上限', min: 0, max: 5000, step: 50 },
  plainShieldFlat:    { label: '护盾', min: 0, max: 5000, step: 50 },
  tempShieldDecayPct: { label: '临时护盾衰减%', min: 0, max: 100, step: 1 },
  armorPenFlat:       { label: '固定护甲穿透', min: 0, max: 500, step: 5 },
  armorPenPercent:    { label: '百分比护甲穿透%', min: 0, max: 100, step: 1 },
  magicPenFlat:       { label: '固定法术穿透', min: 0, max: 500, step: 5 },
  magicPenPercent:    { label: '百分比法术穿透%', min: 0, max: 100, step: 1 },
  onHitDamage:        { label: '攻击特效固定伤害', min: 0, max: 1000, step: 5 },
  onHitPercentDamage: { label: '攻击特效%当前生命', min: 0, max: 50, step: 0.5 },
  damageConvertPct:   { label: '伤害转化%', min: 0, max: 100, step: 1 },
  lifeStealPct:       { label: '全能吸血%', min: 0, max: 100, step: 1 },
  healShieldPowerPct: { label: '治疗护盾强度%', min: -100, max: 200, step: 5 },
  allStatsPct:        { label: '全属性加成%', min: -100, max: 300, step: 5 },
  coreStatsPct:       { label: '核心属性加成%', min: -100, max: 300, step: 5 },
  damageAmpPct:       { label: '伤害增幅%', min: -100, max: 300, step: 5 },
  moveSpeed:          { label: '移动速度', min: 0, max: 300, step: 5 },
  // ==================== v51：新增属性 ====================
  abilityPower:       { label: '法术强度', min: 0, max: 1000, step: 5 },
  skillAmpPct:        { label: '技能增幅%', min: -100, max: 300, step: 5 },
  critChance:         { label: '暴击率%', min: 0, max: 100, step: 1 },
  critDamagePct:      { label: '暴击伤害%', min: 0, max: 300, step: 5 },
  adaptiveForce:       { label: '适应之力', min: 0, max: 500, step: 5 },
  physicalVampPct:    { label: '物理吸血%', min: 0, max: 100, step: 1 },
  spellVampPct:       { label: '法术吸血%', min: 0, max: 100, step: 1 },
  evasionPct:         { label: '闪避率%', min: 0, max: 100, step: 1 },
  tenacityPct:        { label: '韧性%', min: 0, max: 100, step: 1 },
  maxMana:            { label: '最大法力', min: 0, max: 2000, step: 10 },
  manaRegen:          { label: '法力回复/秒', min: 0, max: 200, step: 1 },
  manaStart:          { label: '出场法力', min: 0, max: 2000, step: 10 },
  manaFloor:          { label: '法力下限', min: 0, max: 2000, step: 10 },
};
export const fieldLabel = (k) => FIELD_META[k]?.label || k;
