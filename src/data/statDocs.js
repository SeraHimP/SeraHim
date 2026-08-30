/**
 * statDocs.js —— 属性说明（点属性面板上的任意一项即可看到）
 *
 * 用户："属性（攻击力，攻速等都可以点击）描述这个属性。"
 *
 * ==================== 为什么单独一个文件 ====================
 * 这些文字**必须与引擎里的真实公式一致**，否则就是在骗人 —— 而说明一旦写进
 * 某个渲染函数的模板字符串里，下次改公式的人根本不会想到去改它。
 * 放在这里（data 层、与 Config/schema 同级）有两个好处：
 *   ① 与数值一样是**软编码**的，编辑器以后想让用户改也有入口；
 *   ② 一个文件就能把"引擎当前的全部结算规则"读完，本身就是份文档。
 *
 * ⚠️ 下面每条 formula 都是照着源码抄的，不是凭印象写的。改公式时请一并改这里：
 *   · 攻速         AttributeCalculator.calcAttackSpeed
 *   · 护甲/魔抗     AttributeCalculator.calcDamageMultiplier / calcEffectiveResist
 *   · 减伤/格挡     CombatSystem.performAttackDirect 的 mitigated 分支
 */

/**
 * key = 属性面板上那一行的 statKey。
 * label 只作为兜底 —— 面板上显示什么由面板决定，这里不抢。
 */
export const STAT_DOCS = {
  maxHP: {
    label: '最大生命',
    desc: '这个单位能承受的生命上限。',
    formula: '最大生命变化时，当前生命会**同步跟随**：+500 上限就 +500 当前生命，'
           + '增益消失时同样扣回（扣到 0 会死亡）。',
    tip: '这条同步是 v44 才补上的 —— 在那之前加上限只会让血条的分母变大，血量百分比反而下降。',
  },
  currentHP: {
    label: '当前生命',
    desc: '当前剩余生命。归零即死亡。',
    formula: '受到的伤害先扣临时护盾、再扣固定护盾，最后才扣生命。',
  },
  healthRegen: {
    label: '生命回复/秒',
    desc: '每秒自动回复的生命值。',
    formula: '受【治疗与护盾强度】加成。建筑身上还可能有「加固城防」的**节点上限**，'
           + '回复到该节点就停 —— 那是上限不是速度，调再高也越不过去。',
  },
  attackDamage: {
    label: '攻击力',
    desc: '每次普通攻击的基础伤害。',
    formula: '最终伤害 = (攻击力 + 攻击特效) × (1 + 伤害增幅%) → 再经目标的抗性/减伤/格挡结算。',
  },
  baseAttackSpeed: {
    label: '基础攻速',
    desc: '不含任何加成时每秒的攻击次数。',
    formula: '实际攻速 = 基础攻速 × (1 + 有效攻速加成%)，上限 5.0 次/秒、下限 0.05。',
  },
  bonusAttackSpeedPct: {
    label: '攻速加成%',
    desc: '面板上的攻速加成百分比。',
    formula: '**面板值不等于实际值**：有效加成 = 正值 × 攻速系数(默认 0.667) + 负值。'
           + '也就是说面板 +33% 实际约 +22%；而**减速不打折**，面板 −33% 就是 −33%。',
    tip: '本项目反复出过"面板加了、子弹没加快"的问题，根因多是某处直接读了模板值而没走这条公式。',
  },
  attackSpeedRatio: {
    label: '攻速系数',
    desc: '攻速加成的收益率。只作用于**正值**加成。',
    formula: '见「攻速加成%」。系数越低，堆攻速的边际收益越差。',
  },
  attackRange: {
    label: '攻击距离',
    desc: '能够攻击到目标的最大距离。',
    formula: '同时也是索敌半径的下限 —— 射程比索敌半径远的单位（如攻城车）不会出现'
           + '"看不见却打得到"的情况。',
  },
  bulletSpeed: {
    label: '子弹速度',
    desc: '弹道飞行速度。0 = 近身瞬时命中，不走弹道。',
    formula: '伤害在**命中那一刻**结算，用的是那一刻的抗性/护盾。主目标中途死亡时，'
           + '子弹仍会飞到落点：直伤不结算，但溅射照常对其他单位生效。',
  },
  armor: {
    label: '护甲',
    // v51：用户要求描述要具体——"护甲就写减免50%即将到来的物理伤害"。desc 支持传函数
    // (stats) => 文案，_showStatDoc 会用命中那一刻的实时属性表调它；不传 stats（极端情况）
    // 就退回静态描述，不会崩。
    desc: (stats) => {
      const armor = stats ? (stats.armor || 0) : null;
      if (armor === null) return '减免【物理伤害】。';
      const mult = armor >= 0 ? 100 / (100 + armor) : (2 - 100 / (100 - armor));
      const pct = Math.round((1 - mult) * 100);
      return armor >= 0
        ? `减免约 ${pct}% 即将到来的物理伤害。`
        : `护甲为负：即将到来的物理伤害会被放大约 ${Math.abs(pct)}%。`;
    },
    formula: '护甲 ≥ 0：伤害 × 100/(100+护甲)。护甲 < 0：伤害 × (2 − 100/(100−护甲))，'
           + '也就是**负护甲本身就是增伤**（−50 护甲 ≈ 承受 1.33 倍）。',
  },
  magicResist: {
    label: '魔法抗性',
    desc: (stats) => {
      const mr = stats ? (stats.magicResist || 0) : null;
      if (mr === null) return '减免【魔法伤害】。';
      const mult = mr >= 0 ? 100 / (100 + mr) : (2 - 100 / (100 - mr));
      const pct = Math.round((1 - mult) * 100);
      return mr >= 0
        ? `减免约 ${pct}% 即将到来的魔法伤害。`
        : `魔法抗性为负：即将到来的魔法伤害会被放大约 ${Math.abs(pct)}%。`;
    },
    formula: '与护甲同一套公式，只是作用于魔法伤害。',
  },
  damageReduction: {
    label: '伤害减免%',
    desc: (stats) => {
      const dr = stats ? (stats.damageReduction || 0) : null;
      if (dr === null) return '在抗性之后再乘一次的百分比减伤。';
      return dr >= 0
        ? `在抗性结算之后，再减免约 ${Math.round(dr)}% 即将到来的伤害（真实伤害除外）。`
        : `为负：在抗性结算之后，即将到来的伤害会再被放大约 ${Math.round(-dr)}%（真实伤害除外）。`;
    },
    formula: '伤害 × (1 − 减免%)。**真实伤害不吃这一层**（与抗性同理）。',
  },
  damageBlock: {
    label: '格挡值',
    desc: '每次被命中固定扣除的伤害值。',
    formula: '在减伤之后减去。⚠️ 它对**小攻击力单位近乎免疫** —— 近战兵攻击力只有个位数，'
           + '格挡给到 7 就等于把对方整条兵线的输出删掉。调这个数要格外小心。',
  },
  shieldFixedMax: {
    label: '固定护盾上限',
    desc: '可再生的护盾上限。护盾先于生命被消耗。',
    formula: '按【护盾回复速率】再生，受【治疗与护盾强度】加成。',
  },
  tempShieldDecayPct: { label: '临时护盾衰减%', desc: '临时护盾每秒自然衰减的比例。', formula: '临时护盾先于固定护盾被消耗。' },
  armorPenFlat: {
    label: '固定护甲穿透',
    desc: '按固定值削减目标护甲。',
    formula: '结算顺序：**先百分比穿透、后固定穿透**。且穿透**不能**把正护甲打成负数'
           + '（会夹到 0）—— 否则穿透就成了无上限的增伤放大器。目标护甲本来就是负的时，穿透不再往下打。',
  },
  armorPenPercent: { label: '百分比护甲穿透%', desc: '按百分比削减目标护甲。', formula: '见「固定护甲穿透」的顺序说明。' },
  magicPenFlat: { label: '固定法术穿透', desc: '按固定值削减目标魔法抗性。', formula: '与护甲穿透同一套顺序与夹取规则。' },
  magicPenPercent: { label: '百分比法术穿透%', desc: '按百分比削减目标魔法抗性。', formula: '与护甲穿透同一套顺序与夹取规则。' },
  onHitDamage: { label: '攻击特效固定伤害', desc: '每次命中额外造成的固定伤害。', formula: '计入基础伤害后再走抗性结算，不是独立的一段。' },
  onHitPercentDamage: {
    label: '攻击特效%当前生命',
    desc: '每次命中额外造成【目标当前生命】百分比的伤害。',
    formula: '基数是目标**当前**生命而非最大生命 —— 越是满血的目标吃得越多，残血目标反而少。',
  },
  // v51.6 修复：这条描述文案与真实实现早就对不上了（曾经描述的是"转成另一种伤害
  // 类型结算"，但 CombatSystem._applyDamageConversion 从 v33 Q10 起就是防御向的
  // "把受到的伤害转一部分回临时护盾"，两回事）。用户："伤害转化的描述有问题，应该
  // 为：将受到的实际伤害按百分比转化为临时护盾。"——按真实实现（finalDamage ×
  // damageConvertPct% → grantTempShield）改成准确的文案。
  damageConvertPct: { label: '伤害转化%', desc: '将受到的实际伤害按百分比转化为临时护盾。', formula: '基数是【实际扣血部分】（finalDamage，护盾吸收掉的不算），转化出的护盾量受【治疗与护盾强度】加成。' },
  // v51.6：生命偷取全局改名为"全能吸血"（用户定稿）——字段 lifeStealPct 不变，
  // 只改中文标签；与 physicalVampPct/spellVampPct 并列时，"全能"准确表达了
  // "不挑伤害类型，物理魔法真实都算"这个语义，比"生命偷取"更贴切。
  lifeStealPct: { label: '全能吸血%', desc: '按造成伤害的百分比回复自身生命。', formula: '受【治疗与护盾强度】加成；同样受建筑的回复节点上限约束。' },
  healShieldPowerPct: {
    label: '治疗与护盾强度%',
    desc: '放大自身产生的一切治疗与护盾。',
    formula: '贯通全部来源：生命回复、全能吸血、护盾再生、技能治疗、龙魂回血都吃这一项。',
  },
  allStatsPct: { label: '全属性加成%', desc: '同时放大多项基础属性。', formula: '作用在基础属性上，与各属性自己的百分比加成相乘。' },
  damageAmpPct: {
    label: '伤害增幅%',
    desc: '放大自己造成的全部伤害。',
    formula: '在**抗性结算之前**乘上，所以对**真实伤害同样生效**（这一点与伤害减免相反）。',
  },
  moveSpeed: { label: '移动速度', desc: '每秒移动的世界单位数。', formula: '建筑恒为 0。脱战时部分增益会更高（如风魂）。' },
  baseHealthRegenMod: {
    label: '基础生命回复',
    desc: '对该单位【生命回复】的修正系数，百分比，默认 100%。不包含治疗与护盾强度等其它渠道的加成。',
  },

  // ==================== v51：新增属性 ====================
  abilityPower: {
    label: '法术强度',
    desc: '法术强度。具体每个主动技能怎么用它，由技能自己的公式决定，不是统一换算。',
    formula: '引擎只把这个数暴露成一个可读的属性；伤害/治疗强度公式写在各个主动技能的源码里'
           + '（src/core/skills/actives.js）。',
  },
  skillAmpPct: {
    label: '技能增幅%',
    desc: '放大【技能】造成的一切数值——伤害、持续伤害、治疗都算，普通攻击不算。',
    formula: '自动生效：只要一次伤害/效果能追溯到某个施法者（casterId），就会被这个数放大，'
           + '不需要技能作者手动接。普通攻击、以及"技术上走技能路径但其实是普攻"的两三处'
           + '（闪电杖分帧伤害、腐蚀 DoT）不吃这一层。真实伤害同样吃这一层。',
  },
  critChance: {
    label: '暴击率%',
    desc: '普通攻击的暴击概率。默认 0。',
    formula: '暴击伤害 = 基础暴击倍率(默认200%) + 暴击伤害加成。持有【技能暴击】状态时，'
           + '技能也能按这个概率暴击，但暴击倍率改用单独更低的一档。',
  },
  critDamagePct: {
    label: '暴击伤害%',
    desc: '叠加在基础暴击倍率（200%）之上的额外暴击伤害。',
    formula: '最终暴击倍率 = 200% + 本属性。只对普通攻击的暴击生效——技能暴击用固定的'
           + '「技能暴击伤害」档位，不叠这个加成。',
  },
  adaptiveForce: {
    label: '适应之力',
    desc: '按【攻击力】和【法术强度】哪个更高，自动转化成那一个（持平时按适应方向）。',
    formula: '1 点适应之力 = 0.6 攻击力，或 1 点法术强度（与 LoL 现行比例一致）。'
           + '判据是【总法术强度】vs【总攻击力】，没有过渡带，打平时看 adaptiveDefault 字段。',
  },
  physicalVampPct: { label: '物理吸血%', desc: '按造成的【物理伤害】百分比回复自身生命/护盾。', formula: '与全能吸血叠加；命中群体目标（溅射/连锁/分裂）时按 20% 效率结算。' },
  spellVampPct: { label: '法术吸血%', desc: '按造成的【魔法伤害】百分比回复自身生命/护盾。', formula: '与全能吸血叠加；命中群体目标时同样打 20% 效率折扣。' },
  evasionPct: {
    label: '闪避率%',
    desc: '完全躲开一次普通攻击的概率（伤害归零，不触发任何后续结算）。',
    formula: '只对普通攻击生效——技能是判定命中之后的数值结算，不会被闪避。',
  },
  tenacityPct: {
    label: '韧性%',
    desc: '缩短受到的控制（眩晕/沉默/缴械）与减速效果的持续时间。',
    formula: '新持续时间 = 原持续时间 × (1 − 韧性%)。对光环型/永久型效果不生效。',
  },
  maxMana: { label: '最大法力', desc: '资源条（法力/能量/充能，统称法力）的上限。', formula: '没有装备任何"主动"类技能的单位，法力恒为 0，这个数填多少都不生效。' },
  manaRegen: { label: '法力回复/秒', desc: '每秒自动回复的法力。', formula: '同样受"没装主动技能就恒为0"这条规则约束。' },
  manaStart: { label: '出场法力', desc: '单位出场时的初始法力。', formula: '不超过最大法力。' },
  manaFloor: { label: '法力下限', desc: '释放主动技能后法力回落到的值。', formula: '默认 0（清空）。' },
  // v51.1：manaOnAttack/manaOnHitTaken 已改成全局值（CONFIG.tuning.mana），
  // 不再是每个模板各自的字段，这里的说明条目随之删除——不然会有一条"点了却查
  // 无此 statKey"的说明，正是本仓库反复强调要避免的死配置。
};

/** 取某个属性的说明；没有登记过就返回 null（调用方据此决定要不要做成可点击）。 */
export function statDoc(key) {
  return STAT_DOCS[key] || null;
}
