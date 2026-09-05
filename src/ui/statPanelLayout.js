/**
 * statPanelLayout.js —— 单位面板「展开更多」的**分组与顺序**（唯一一份）
 *
 * 用户："塔展开更多里新增射程显示。然后塔/兵的展开更多里面的属性顺序进行排列，
 *        就是一个方面放在一块。兵的移速那里显示塔的子弹速度。"
 *        "不要在展开更多里显示攻速加成了，用生命恢复代替。"
 *
 * v51.6：用户改稿——"子弹速度放在攻击力里，所有单位统一展开更多的最后一个格为
 * 移速（目前的塔为子弹速度）。"推翻了上面那条"塔看子弹速度、兵看移速各显示各的"
 * 的旧规则：子弹速度搬进【进攻】组（塔的攻击方式本来就属于"怎么打出去"，和攻击距离/
 * 伤害增幅放一块更合理），最后一格（原来的 mobilityRow）统一固定显示移速——塔的
 * moveSpeed 恒为 0（模板里就是 0），这一格对塔而言就是"确认塔不会动"，信息量不大
 * 但至少三种单位类型的面板形状完全一致，不用再记"塔这里显示的是另一种东西"。
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
 *
 * v51.6 追补：子弹速度已从这张表里整个删除（用户："子弹速度已经整合到攻击力窗口了，
 * 把属性界面遗留的子弹速度删掉"）——它只保留在 RELATED_STATS.attackDamage 里，
 * 点开【攻击力】的说明弹窗才看得到，不再在"展开更多"网格里单独占一格。
 * 塔与小兵的表因此**完全一致**，函数不再需要按单位类型分支，故不再接收参数。
 */

/** @returns [{ title, rows: [{ key, label, suffix }] }] */
export function extAttrGroups() {
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
      { key: 'armorPenFlat', label: '固定护甲穿透', suffix: '' },
      { key: 'armorPenPercent', label: '护甲穿透%', suffix: '%' },
      { key: 'magicPenFlat', label: '固定法术穿透', suffix: '' },
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
      { key: 'lifeStealPct', label: '全能吸血%', suffix: '%' },
      { key: 'damageConvertPct', label: '伤害转化%', suffix: '%' },
      { key: 'healShieldPowerPct', label: '治疗与护盾强度%', suffix: '%' },
    ] },
    { title: '增益与机动', rows: [
      // v51.22：用户"属性面板中全属性加成那个改成核心属性加成，全属性加成塞到
      // 点开的窗口里面（两者互换一下位置）"——这一格与下面 RELATED_STATS 的
      // coreStatsPct/allStatsPct 那条一起换，主格子从 allStatsPct 换成 coreStatsPct，
      // allStatsPct 挪进点开窗口的关联属性区。两个字段的说明文案（statDocs.js）本来
      // 就各自独立、不依赖"谁是主格子"，不用跟着改。
      { key: 'coreStatsPct', label: '核心属性加成%', suffix: '%' },
      // v51.6：最后一格统一固定显示移速（用户定稿），子弹速度已经搬进上面的【进攻】组，
      // 不再由 kind 决定"这一格显示什么"——三种单位类型的面板形状因此完全一致。
      { key: 'moveSpeed', label: '移速', suffix: '' },
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
  { key: 'magicResist', label: '魔法抗性' },
  // 攻速这一格的 data-stat 指向 bonusAttackSpeedPct —— 面板显示的是算完的攻速，
  // 而"这个数是怎么来的"那份说明写在攻速加成里。
  { key: 'bonusAttackSpeedPct', label: '攻速' },
  { key: 'critChance', label: '暴击率' },
];

/** 这张表里出现的全部 statKey（含常驻区），供断言逐个查说明文案。 */
export function allPanelStatKeys() {
  const ks = BASE_ATTR_ROWS.map(r => r.key);
  for (const g of extAttrGroups()) for (const r of g.rows) ks.push(r.key);
  return ks;
}

/**
 * ==================== v51.6：关联属性弹窗 ====================
 * 用户："由于目前单位的各种属性特别多，很难显示全，所以未显示的属性在相关联属性的
 * 单位属性窗口点某属性弹出的窗口中显示。比如点开暴击窗口，里面额外显示暴击伤害。
 * 生命偷取里额外显示物理吸血和法术吸血……生命恢复里额外显示基础生命值恢复。等等。"
 *
 * 面板格子数量有限（两列网格，塞不下所有属性），有些属性因此从来没有自己的格子——
 * 玩家只能去编辑器里翻才知道它们存在。这张表不新增格子，而是把"没有自己格子"的
 * 属性挂到主题相近的**已有**格子的说明弹窗里，点开就能看到，不占面板空间。
 *
 * 前三条是用户点名的例子，原样落地；法强/攻击力两条是同一个思路下按主题就近安排的：
 *   法术强度 → 技能增幅（都是"魔法输出"范畴）
 *   攻击力   → 适应之力（适应之力两边都能转，攻击力这边正好没有别的关联项）
 * 闪避率/韧性最初也是按"就近主题"分到了护甲/魔抗（同属"减伤/抗性"范畴），但 v51.12
 * 里用户直接点名重新指定了归属："韧性显示在移速里，闪避率显示在伤害减免"——不再是
 * 主题就近，是用户自己的分类口径，按此改掉，不要再按"减伤类"的直觉挪回去。
 * 每条独立展示一次，不重复安排到两个宿主格子里。
 */
export const RELATED_STATS = {
  critChance: ['critDamagePct'],
  lifeStealPct: ['physicalVampPct', 'spellVampPct'],
  healthRegen: ['baseHealthRegenMod'],
  abilityPower: ['skillAmpPct'],
  // v51.6：用户"子弹速度是写到攻击力点开的窗口里的"——bulletSpeed 本身已经在
  // extAttrGroups 的"进攻"组里有自己的格子（塔专属），这里额外把它也带进攻击力
  // 的关联属性区块，方便点开攻击力时一并看到。
  attackDamage: ['adaptiveForce', 'bulletSpeed'],
  // v51.12：Q8——用户"补充关联属性……韧性显示在移速里，闪避率显示在伤害减免"，
  // 这是用户自己重新指定的归属，跟上面 v51 注释写的"护甲→闪避、魔抗→韧性"那版
  // 分类是两回事：闪避率从护甲搬到伤害减免，韧性从魔抗搬到移速。damageReduction/
  // moveSpeed 这两格原来没有关联属性区块，这里各自新增一条。
  damageReduction: ['evasionPct'],
  moveSpeed: ['tenacityPct'],
  // v51.9：用户"【核心属性加成】显示在全属性加成的点开窗口里"——最初核心属性加成
  // （coreStatsPct）没有自己的格子，挂到全属性加成（allStatsPct）说明弹窗里。
  // v51.22：用户反过来定稿，两者互换位置——核心属性加成现在是主格子（见上面
  // extAttrGroups），全属性加成改挂进核心属性加成的点开窗口。
  coreStatsPct: ['allStatsPct'],
  // v51.12：Q7——"攻速"点开窗口现在显示的是算完的实际攻速（次/秒），原来直接
  // 显示的【攻速加成】百分比和【攻击速度收益率】换算系数挪到关联属性区块里，
  // 而不是消失。bonusAttackSpeedPct 关联到它自己这件事是有意的：主区块显示的
  // 已经不是这个键的原始值了（见 UIManager._showStatDoc 对这个 key 的特判），
  // 所以还需要单独一行把它的原始百分比带出来。
  bonusAttackSpeedPct: ['bonusAttackSpeedPct', 'attackSpeedRatio'],
};
