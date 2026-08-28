/**
 * statPanelLayout.js —— 单位面板「展开更多」的**分组与顺序**（唯一一份）
 *
 * 用户："塔展开更多里新增射程显示。然后塔/兵的展开更多里面的属性顺序进行排列，
 *        就是一个方面放在一块。兵的移速那里显示塔的子弹速度。"
 *        "不要在展开更多里显示攻速加成了，用生命恢复代替。"
 *
 * ==================== 为什么单独一个文件 ====================
 * 改动前塔卡片和兵卡片各写了一份 14 行的模板字符串，除了最后两格以外**逐字相同**。
 * 后果不是"多打了几行字"，而是两份悄悄长歪了：塔那份没有攻击距离、兵那份没有子弹速度，
 * 而且谁都不会把两段几乎一样的字符串并排读一遍，所以没人发现。
 * 这是本仓库反复出现的"同一件事实现了两遍"，修法一律是抽成一份、两边都调它。
 *
 * 而且更重要的一点：**布局如果只以模板字符串的形式存在，headless 测试只能去正则源码**。
 * 正则源码钉的是"源码长什么样"而不是"面板显示什么"，一改写法就红、真出问题反而不红
 *（火炬那次"世界尺寸取错字段"就是这样漏出去的）。
 * 现在布局是一张可 import 的表，断言直接读这张表 —— 钉的是行为形状。
 *
 * ==================== 分组原则 ====================
 * 「一个方面放在一块」。面板是两列网格：每组一个整行小标题，组内按表的顺序左右铺开；
 * 组内条目为奇数时最后一格横跨两列（CSS 的 .a.span2），
 * 否则下一组的第一格会被塞进上一组留下的空位里，分组就白做了。
 *
 * 注：攻击力/攻速/护甲/魔抗四项在**折叠区之上**的常驻属性区，不在这张表里。
 */

/** 兵看移速、塔看子弹速度：塔的 moveSpeed 恒为 0（模板里就是 0），显示它毫无信息量。 */
function mobilityRow(kind) {
  return kind === 'tower'
    ? { key: 'bulletSpeed', label: '子弹速度', suffix: '' }
    : { key: 'moveSpeed', label: '移速', suffix: '' };
}

/**
 * @param kind 'tower' | 其它（小兵/龙等）
 * @returns [{ title, rows: [{ key, label, suffix }] }]
 */
export function extAttrGroups(kind) {
  return [
    // 攻速加成这一格已删除（用户定稿）：【攻速】那一格显示的就是把加成算进去之后的值，
    // 连正负着色都跟着走，再列一次加成百分比是重复信息。
    // 它的说明弹窗仍挂在【攻速】那一格的 data-stat 上，公式没有丢。
    { title: '进攻', rows: [
      { key: 'attackRange', label: '攻击距离', suffix: '' },
      { key: 'damageAmpPct', label: '伤害增幅%', suffix: '%' },
      { key: 'onHitDamage', label: '攻击特效(固定)', suffix: '' },
      { key: 'onHitPercentDamage', label: '攻击特效(%当前生命)', suffix: '%' },
    ] },
    { title: '穿透', rows: [
      { key: 'armorPenFlat', label: '固定穿甲', suffix: '' },
      { key: 'armorPenPercent', label: '护甲穿透%', suffix: '%' },
      { key: 'magicPenFlat', label: '固定法穿', suffix: '' },
      { key: 'magicPenPercent', label: '法术穿透%', suffix: '%' },
    ] },
    { title: '防御', rows: [
      { key: 'damageReduction', label: '伤害减免', suffix: '%' },
      { key: 'damageBlock', label: '伤害格挡', suffix: '' },
    ] },
    // 生命恢复顶掉了原来攻速加成的位置。它一直没在面板上出现过，
    // 而加固城防（水晶 1、枢纽 3）与潮之力这一路改的正是它 —— 看不见就等于没有。
    { title: '续航', rows: [
      { key: 'healthRegen', label: '生命恢复', suffix: '' },
      { key: 'lifeStealPct', label: '生命偷取%', suffix: '%' },
      { key: 'damageConvertPct', label: '伤害转化%', suffix: '%' },
      { key: 'healShieldPowerPct', label: '治疗与护盾强度%', suffix: '%' },
    ] },
    { title: '增益与机动', rows: [
      { key: 'allStatsPct', label: '全属性加成%', suffix: '%' },
      mobilityRow(kind),
    ] },
  ];
}

/**
 * 常驻属性区（折叠区之上）的六格。data-stat 用于点开说明弹窗。
 * v51：用户定稿"默认显示攻击力，法强，护甲，魔法抗性，攻速，暴击率"——从四格
 * 扩到六格，顺序按这句原话来，不是随手排的。
 */
export const BASE_ATTR_ROWS = [
  { key: 'attackDamage', label: '攻击力' },
  // 用户 Q7 定稿："不要写法强，要写法术强度！"——面板寸土寸金但必须用全称，不再缩写。
  { key: 'abilityPower', label: '法术强度' },
  { key: 'armor', label: '护甲' },
  { key: 'magicResist', label: '魔抗' },
  // 攻速这一格的 data-stat 指向 bonusAttackSpeedPct —— 面板显示的是算完的攻速，
  // 而"这个数是怎么来的"那份说明写在攻速加成里。
  { key: 'bonusAttackSpeedPct', label: '攻速' },
  { key: 'critChance', label: '暴击率' },
];

/** 这张表里出现的全部 statKey（含常驻区），供断言逐个查说明文案。 */
export function allPanelStatKeys(kind = 'tower') {
  const ks = BASE_ATTR_ROWS.map(r => r.key);
  for (const g of extAttrGroups(kind)) for (const r of g.rows) ks.push(r.key);
  return ks;
}
