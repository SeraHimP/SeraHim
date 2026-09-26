/**
 * Weather.js —— 天气系统的数据定义（v54 第二轮重做：角色化数值上限 + 机制 Signature）
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
 *
 * ==================== v54：第二轮重做（docs/Q4-WEATHER-REDESIGN.md §九）====================
 * 用户实机验收后反馈"数值加成太单调/太寡淡"两个极端都试过，最终定稿【分层】：
 *   · 基础天气：数值只在 1~2 个维度小幅发言（±4~8% 或小固定值），不再同时动
 *     输出/防御/恢复/攻速四个维度——每种天气该有清晰的"主题"，不是数值大杂烩。
 *   · 极端天气：最多 1 个主数值轴 + 1 个次级数值轴（±12~20% 或中等固定值），
 *     不是把基础天气的一堆 buff 打个折。
 *   · 机制类效果（moveSpeed/attackRange/bulletSpeed/turnRate/aggroRange，以及
 *     地面痕迹层的水洼/雪盖）不受这条数值上限约束，按各自设计幅度保留——判定
 *     标准是"没有这个数字，这个天气还能不能成立"：能成立的是数值 buff，该砍；
 *     不能成立的是天气节奏本身的一部分（如风的 moveSpeed），该留。
 *   · 极端天气新增 `signature` 字段：一段只读的元数据，供渲染/机制层
 *     （PostFX/GroundTraceSystem/SnowCoverSystem/ThreeRenderer）在对应极端天气
 *     激活时查表触发"标志性表现"——状态反转/环境视觉/系统耦合三类之一，不能是
 *     伪装成机制的数值 buff（详见设计文档 §9.8 的定稿表）。
 *   · 极端天气新增可选的 `structural` 字段：在 getStructuralFactor() 自动继承
 *     （由 trigger 里的基础天气 id 带来）之外，允许某条极端天气【自己】再叠加
 *     一份结构性机制（比如雪盲的额外索敌收缩）——见 WeatherSystem.getStructuralFactor
 *     的第三段循环。
 *   · 新增 `tags` 字段（语义标签，供天气×昼夜联动用，见 §9.6）：LUMINANCE（光照）/
 *     THERMAL（温度）/ PRECIPITATION（降水）/ VISIBILITY（能见度）/ COLD（严寒）。
 *   · 新增可选 `dayNightRule` 字段：目前只有"烈日"用到 `{ veto: 'day' }`——物理上
 *     不可能在夜里触发，其余 14 条极端天气都没有配置（保持 Neutral，见设计文档
 *     "只对物理不可能的做硬否决，其余留白"，没有为每条发明权重）。
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
  // Bug 修复（用户定稿："天气效果应该也对巨龙生效，目前并未生效"）：原来这里排除了
  // dragon，而下面几乎所有天气效果条目的 targets 都写的是 'minions'/'towers'
  // 二选一，没有单独的 'dragon' 分类——巨龙排除在 minions 之外，就意味着它只吃得到
  // 少数几条 targets:'all' 的极端天气效果，普通天气（雨/雪/雾…）对它完全没作用。
  // 巨龙是会动的中立单位，语义上更接近"小兵"而非"塔"，直接把它并入 minions。
  minions: (e) => e.type !== 'tower',
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

// ==================== 第一层：基础天气（v54：角色化数值上限） ====================
// 效果表给出【严重档】数值；实际生效 = 满档值 × 档位系数（0.25/0.5/0.75/1.0）。
export const BASE_WEATHERS = {
  // ☀️ 晴：全员轻微加成——阳光普照，人人受益，但不改变对局结构。
  //
  // ==================== 结构性机制（晴，Q4 天气重做落地）====================
  // 用户："晴天不该是没有负面效果的天气，而应该是主动关闭上述几种天气各自的
  // 结构性机制、只保留一条很小的全局增益（比如索敌半径微涨）"（见
  // docs/Q4-WEATHER-REDESIGN.md §3.5）。"主动关闭"这半句不是晴天自己的效果表能
  // 表达的（它是"压低别人"，不是"给自己加成"），实现在 WeatherSystem.
  // getStructuralFactor() 里：雨/雾/风/雪四条的结构性数值会按晴天自身的档位系数
  // 做乘法抑制（晴天越盛，其它天气的结构性机制越接近失效）；这里的 structural
  // 字段只承担"很小的全局增益"那半句。
  clear: {
    id: 'clear', name: '晴', icon: '☀️', color: '#f6c94a',
    mu: 0.5,
    desc: '阳光普照。全体单位获得轻微加成，视野与索敌恢复正常水准，战场生机勃勃。',
    // v54：单一主题（温暖/生机），数值从 damageAmpPct+8/healthRegen+2 收窄到只留
    // 一条小幅 damageAmpPct，moveSpeed 是机制类效果不受数值上限约束、幅度不动。
    effects: [
      { targets: 'all', statKey: 'damageAmpPct', flat: 5 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 8 },
    ],
    structural: {
      // 很小的全局增益：索敌半径微涨（满档 +8%）。
      aggroRangeScalePct: 8,
    },
    tags: ['LUMINANCE', 'THERMAL'],
  },
  // 🌧️ 雨：塔优势——塔在雨幕中愈战愈勇，兵线泥泞迟缓、装甲锈蚀。
  rain: {
    id: 'rain', name: '雨', icon: '🌧️', color: '#5b9bd5',
    mu: 0.2,
    desc: '雨幕滋养防线。塔的火力小幅提升，兵线泥泞迟缓、装甲略微锈蚀。',
    // v54：主题"水+节奏"，砍掉 healthRegen/healShieldPowerPct（跟塔攻击力同一个
    // "塔优势"意思，留一条就够），armor/magicResist 从 -12 收窄到 -4，moveSpeed
    // 是雨天节奏的核心机制、幅度不动。
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 7 },
      { targets: 'minions', statKey: 'armor', flat: -4 },
      { targets: 'minions', statKey: 'magicResist', flat: -4 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
    tags: ['PRECIPITATION'],
  },
  // 🌫️ 雾：兵优势——塔变瞎，小兵在雾中变硬变凶。
  //
  // ==================== 结构性机制（雾，Q4 天气重做落地）====================
  // 用户否决了"雾天让双方擦肩而过"的方向，要求"改成让远程单位攻击距离大幅度降低"，
  // 并追加一条候选一起上（见 docs/Q4-WEATHER-REDESIGN.md §3.2，已定稿）：
  //   A：远程/炮兵攻击距离大幅缩水，近战不受影响——挂在已有的 attackRange 属性上，
  //      走的是 AttributeCalculator 的通用 flat/percent 合并管线（与其它天气数值
  //      效果同一条路），不需要新增任何管线。-55% 是按"砍到接近近战射程量级"这句
  //      话反推的：远程 150→67.5、炮兵 127.5→57.4，后者已经落到
  //      MELEE_RANGE_THRESHOLD(60) 以内，前者也远比原来贴近近战。
  //   B：索敌半径也跟着一起收缩到接近攻击距离的量级——这个不是任何单位的
  //      "属性"，是 LaneMovementSystem 里的全局仇恨获取半径常量，走不了 A 那条
  //      属性合并管线，所以单独开一张 structural 表，由 WeatherSystem.
  //      getStructuralFactor() 统一读出（见该方法的头注）。
  fog: {
    id: 'fog', name: '雾', icon: '🌫️', color: '#9aa3ae',
    mu: 0.1,
    desc: '能见度极低。防御塔的火力打了折扣，小兵借雾掩护变得坚硬，且必须靠得很近才能发现彼此。',
    // v54：主题"视野收缩"，数值从 attackDamage-30/armor+25/magicResist+25/
    // healthRegen+2/damageAmpPct+10 收窄到只留 attackDamage 和 armor/magicResist
    // 一条（算同一个"防御硬化"主题），attackRange 是雾天视野机制的核心，幅度不动。
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -10 },
      { targets: 'minions', statKey: 'armor', flat: 7 },
      { targets: 'minions', statKey: 'magicResist', flat: 7 },
      // A：远程/炮兵攻击距离大幅缩水，近战不受影响。
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -55 },
    ],
    structural: {
      // B：索敌半径整体收缩（满档时 -60%），单位是"占满档效果的百分比"，
      // 由 getStructuralFactor() 按当前档位系数（25/50/75/100%）再打折。
      aggroRangeScalePct: -60,
    },
    tags: ['VISIBILITY'],
  },
  // 💨 风：平衡·节奏加快——大家一起快，谁也不占谁便宜。
  //
  // ==================== 结构性机制（风，Q4 天气重做落地）====================
  // 用户弃用了"弹道偏移"（观感偏随机），定稿两条同时生效（见
  // docs/Q4-WEATHER-REDESIGN.md §3.3）：
  //   A：子弹飞行速度变慢（风阻，不改落点只改飞行时长）——挂在已有的 bulletSpeed
  //      属性上，同样走通用 flat/percent 合并管线，零新增管线。塔的子弹也一起打折
  //      （用户原话没有排除塔，"风阻"对谁都成立）。
  //   B：转身速度大幅下降（顶风转身费力）——FacingSystem 直接读
  //      baseStats.turnRateDeg，不经过属性合并管线，同样开 structural 表。
  wind: {
    id: 'wind', name: '风', icon: '💨', color: '#7ee0c0',
    mu: 0.15,
    desc: '大风席卷战场。兵线借风提速，子弹被吹得又慢又飘，顶风转身也更费力。',
    // v54：攻速数值从 25/15 收窄到 8/8（同一个"轻微提速"主题），moveSpeed/
    // bulletSpeed 是风天节奏的核心机制，幅度不动。
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 8 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: 8 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 25 },
      // A：子弹飞行速度变慢（全体，塔与兵都吃风阻）。
      { targets: 'all', statKey: 'bulletSpeed', percent: -30 },
    ],
    structural: {
      // B：转身速度下降（满档时 -40%），由 getStructuralFactor() 按档位系数缩放。
      turnRateScalePct: -40,
    },
    tags: [],
  },
  // ❄️ 雪：平衡·节奏减慢——全场冻结，战线凝滞。
  snow: {
    id: 'snow', name: '雪', icon: '❄️', color: '#dbe9f4',
    mu: 0.08,
    desc: '风雪封锁。兵线动作略微迟滞，地面开始积雪——踩进雪盖里会更慢，走出的小径稍好走一些。',
    // v54：移除了原来的"小兵 moveSpeed -35%"全局减速——雪天的减速这次改由
    // GroundTraceSystem 的雪盖机制（区域性、随雪盖累积/踏出小径变化）承担，
    // 更有"世界在真实运行"的质感，不再是一个跟位置无关的隐藏 debuff；两者叠加
    // 会显得过重。这里只留一条小幅攻速迟滞（-20→-6）作为雪天"手也冻僵了"的
    // 风味数值。
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -6 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -6 },
    ],
    tags: ['COLD'],
  },
};

// ==================== 第二层：极端天气（v54：1 主轴 + 1 次轴 + 机制 Signature） ====================
// trigger：{ 基础天气id: 最低充能值 }（两成分都要达标——触发条件是固定的，不随机）。
// 极端天气可达第 5 档"极端"（充能≥88%，效果 150%），显示自带辉光。
//
// v51.6：这里原来每条还有一个 weight（出现倾向，-1~+1，配置面板可调，权重越高
// 触发阈值越低）字段，整个删掉了。用户："极端天气的产生不是有固定条件吗？极端
// 天气的权重到底有没有实际意义？如果没有的话可以直接删除。"——权重机制本身没
// 问题（WeatherSystem._extremeThreshold 确实拿它去压低阈值），但它和"触发条件
// 已经写死"这件事叠在一起，面板上一个滑块 + 一段固定条件文字同时存在，反而让人
// 分不清"到底是固定的还是可调的"，用户也确认这条不需要保留。极端天气现在只由
// 固定的 trigger 条件 + 全局难度旋钮 CONFIG.tuning.weatherExtremeThresholdScale
// 决定，不再有逐条可调的权重。基础天气的 mu（出现倾向）不受影响，那是完全独立
// 的另一套、用户明确说"不受影响"。
//
// v54：每条只保留 1 个主数值轴 + 最多 1 个次级数值轴（判定标准见文件头注），
// 机制类效果（moveSpeed/attackRange/bulletSpeed）按"继承对应基础天气 + 适度
// 强化"手写（不自动继承——只有 structural 里的 aggroRange/turnRate 才自动继承，
// 见 WeatherSystem.getStructuralFactor 头注），`signature` 字段是这条极端天气
// 的"标志性表现"元数据，供渲染/机制层查表消费，不参与属性合并管线。
export const EXTREME_WEATHERS = {
  // 晴+雨 → 太阳雨：水洼高周转——生成更密集、干得也快
  sunshower: {
    id: 'sunshower', name: '太阳雨', icon: '🌦️', color: '#8fd0a8',
    trigger: { clear: 0.26, rain: 0.26 },
    desc: '晴空落雨，水洼来得快、干得也快。塔的火力小幅提升，兵线依旧泥泞。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 16 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
    // Signature（状态反转类的近亲：节奏反转）：水洼生成更密集、生命周期缩短，
    // 视觉上快速出现/消失；GroundTraceSystem 读取这条 active 时应用。
    signature: { kind: 'puddleHighTurnover', spawnMul: 1.8, lifetimeMul: 0.5 },
  },
  // 晴+雾 → 蜃景：兵优势极化，空气看起来在热浪中扭曲
  mirage: {
    id: 'mirage', name: '蜃景', icon: '🌫', color: '#c9b37e',
    trigger: { clear: 0.26, fog: 0.26 },
    desc: '烈日蒸腾出扭曲的幻象。塔的弹道被折射带偏，兵线借幻影长驱直入。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -14 },
      { targets: 'minions', statKey: 'damageAmpPct', flat: 14 },
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -65 },
    ],
    // Signature（环境视觉）：雾 PostFX 加一层轻微 UV 位移，做出热浪扭曲感。
    signature: { kind: 'fogUvWobble', wobbleStrength: 0.6 },
  },
  // 晴+风 → 沙暴：风的语义发生反转——从顺风加速变成逆风阻碍
  sandstorm: {
    id: 'sandstorm', name: '沙暴', icon: '🏜️', color: '#d4a05a',
    trigger: { clear: 0.26, wind: 0.26 },
    desc: '干燥狂风卷起黄沙。塔的穿甲被废，兵线在沙尘里顶风艰难推进——风不再是助力，是阻力。',
    effects: [
      { targets: 'towers', statKey: 'armorPenPercent', flat: -18 },
      { targets: 'all', statKey: 'bulletSpeed', percent: -40 },
      // 状态反转：普通风天 moveSpeed 是 +25%（顺风），沙暴里直接反号——
      // 不是"再减速一点"，是这条数值的方向本身变了，这才是记忆点。
      { targets: 'minions', statKey: 'moveSpeed', percent: -20 },
    ],
    // Signature（状态反转 + 环境视觉）：moveSpeed 反号已经体现在 effects 里；
    // 视觉上复用雾通道渲染成土黄色沙尘层。
    signature: { kind: 'sandstormReversal', dustColor: '#c9a15a' },
  },
  // 晴+雪 → 雪盲：雪地反光刺眼，跟雾的"暗到看不清"形成对照
  snowblind: {
    id: 'snowblind', name: '雪盲', icon: '🕶️', color: '#e8f0f8',
    trigger: { clear: 0.26, snow: 0.26 },
    desc: '烈日照雪，反光刺目。塔与兵都睁不开眼，索敌范围也跟着收缩。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -14 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -14 },
    ],
    // 额外叠加一份自己的结构性机制（不是继承来的）：反光致盲也会收缩索敌——
    // 见 getStructuralFactor 第三段循环（极端天气自带的 structural 覆写）。
    structural: { aggroRangeScalePct: -20 },
    // Signature（环境视觉）：雪面眩光——环境亮度上升、对比度略降、雪面高亮泛光，
    // 跟雾的"暗到看不清"形成对照。
    signature: { kind: 'snowGlare', brightnessBoost: 0.12 },
  },
  // 雨+雾 → 暴雨：雨幕——近处能看清，远处被雨线切断
  downpour: {
    id: 'downpour', name: '暴雨', icon: '🌧', color: '#3d7ea6',
    trigger: { rain: 0.26, fog: 0.26 },
    desc: '倾盆大雨裹着水雾，形成一道雨幕。塔的射速提升，兵线在雨中浑身湿透、寸步难行。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 18 },
      { targets: 'minions', statKey: 'armor', flat: -10 },
      { targets: 'minions', statKey: 'magicResist', flat: -10 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -35 },
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -65 },
    ],
    // Signature（环境视觉）：雨粒子池在充能=1时已经是满密度，没有再往上加的空间——
    // "雨幕"效果改由触发条件本身天然满足：暴雨要求雨+雾同时够格，雨粒子层和
    // 伪体积雾层本来就会同时渲染，两者叠加已经是"近处能看清、远处被遮"的效果，
    // 不需要再新增一层密度提升逻辑。
    signature: { kind: 'rainCurtain' },
  },
  // 雨+风 → 雷暴：偶发全屏闪电，纯视觉、不带机制惩罚
  thunderstorm: {
    id: 'thunderstorm', name: '雷暴', icon: '⛈️', color: '#7c5cff',
    trigger: { rain: 0.26, wind: 0.26 },
    desc: '电闪雷鸣、狂风怒号。塔的射速与火力双双提升，偶尔一道闪电划过战场。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: 18 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 14 },
      { targets: 'all', statKey: 'bulletSpeed', percent: -45 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -15 },
    ],
    // Signature（环境视觉）：纯视觉的偶发全屏闪光，不带任何机制惩罚——
    // 极短、稀疏、不可预测（具体频率/亮度见 CONFIG.ui.weatherFx.thunderFlash）。
    signature: { kind: 'lightningFlash' },
  },
  // 雨+雪 → 冻雨：水洼和雪盖同时存在，视觉上"雨落成冰"
  freezing_rain: {
    id: 'freezing_rain', name: '冻雨', icon: '🧊', color: '#7fb8d8',
    trigger: { rain: 0.26, snow: 0.26 },
    desc: '雨落成冰。兵线被冰壳裹住，行动僵硬；塔趁势小幅提速收割。',
    effects: [
      { targets: 'minions', statKey: 'moveSpeed', percent: -50 },
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: 12 },
    ],
    // Signature（环境视觉）：不新增第三层减速规则（水洼+雪盖已经足够重）——
    // 只把水洼贴花换成带霜感的材质，表现"雨落成冰"。
    signature: { kind: 'icyPuddle' },
  },
  // 雾+风 → 霾潮：快节奏的兵优势——雾带有了方向感
  haze_surge: {
    id: 'haze_surge', name: '霾潮', icon: '🌪️', color: '#8a9a6b',
    trigger: { fog: 0.26, wind: 0.26 },
    desc: '狂风卷着浓霾扑向防线。塔看不清也拦不住，兵线在霾中高速推进。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -16 },
      { targets: 'minions', statKey: 'moveSpeed', percent: 20 },
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -65 },
      { targets: 'all', statKey: 'bulletSpeed', percent: -35 },
    ],
    // Signature（环境视觉）：噪声在固定方向被拉伸变形——现在风只有强度没有
    // 方向，做不了真正的定向雾带，这是折中版的"方向感"，留着以后接真实风向。
    signature: { kind: 'directionalFog', stretch: 1.6 },
  },
  // 雾+雪 → 白茫：全场最慢+塔最瞎，远景向白色退化
  whiteout: {
    id: 'whiteout', name: '白茫', icon: '🌨️', color: '#cfd8e0',
    trigger: { fog: 0.26, snow: 0.26 },
    desc: '白茫茫一片，天地不分。塔近乎失明，兵线在深雪中蠕行，远景渐渐融进白色。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -18 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -25 },
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -65 },
    ],
    // Signature（环境视觉）：距离渐变发白——近处正常、中景淡白、远景全白。
    signature: { kind: 'distanceWhiteout' },
  },
  // 风+雪 → 暴风雪：雪盖增长速度挂到风强度上（系统耦合）
  blizzard: {
    id: 'blizzard', name: '暴风雪', icon: '🌨', color: '#c3dbf0',
    trigger: { wind: 0.26, snow: 0.26 },
    desc: '白毛风横扫战场。全线冻结，雪盖在风力助推下越积越快——最慢的消耗局。',
    effects: [
      { targets: 'towers', statKey: 'bonusAttackSpeedPct', flat: -16 },
      { targets: 'minions', statKey: 'bonusAttackSpeedPct', flat: -16 },
      { targets: 'minions', statKey: 'moveSpeed', percent: -55 },
      { targets: 'all', statKey: 'bulletSpeed', percent: -40 },
    ],
    // Signature（系统耦合）：雪盖增长速度也挂到风强度上（复用雾-风耦合同一套
    // 技术思路），SnowCoverSystem 读这条 active 时把增长速度乘上风充能，
    // 并设响应上限（growthCap）避免风一大瞬间铺满全图。
    signature: { kind: 'snowCoverWindBoost', growthMul: 1.8, growthCap: 2.5 },
  },

  // ==================== 单基础极端（v33 追加，5 种） ====================
  // 触发 = 单个基础天气充能 ≥0.62（严重档附近才涌现）；主题 = 该基础定位的极化。

  // 晴 → 烈日：全员轻微加成 → 极化为"晒得亢奋"，仅白天可触发
  scorch: {
    id: 'scorch', name: '烈日', icon: '🔥', color: '#f2a13c',
    trigger: { clear: 0.62 },
    desc: '万里无云，烈日当空。全场晒得亢奋——火力与手速提升，恢复被高温蒸干。夜里不会出现。',
    effects: [
      { targets: 'all', statKey: 'attackDamage', percent: 18 },
      { targets: 'all', statKey: 'bonusAttackSpeedPct', flat: 10 },
      { targets: 'all', statKey: 'healthRegen', flat: -3 },
    ],
    // Signature（环境视觉）：复用现成的晴天浮尘可视化，强度拉满，不叠加更多效果。
    signature: { kind: 'dustMax' },
    // ==================== 天气×昼夜联动（v54 §9.6）====================
    // 烈日在语义上跟"阳光暴晒"强绑定，物理上不可能出现在夜里——这是目前唯一一条
    // 配置了 Hard veto 的极端天气（见 WeatherSystem._dayNightCompatibility）：
    // 夜晚（昼夜相位 ≥0.5）时触发阈值被推到不可能达到的量级，直接不能触发。
    // 原计划用太阳仰角判夜晚，实测这个游戏的昼夜光照是风格化的，仰角从不真正
    // 跌到 0 以下——改用相位本身判定，见 WeatherSystem._dayNightCompatibility。
    // 其余 14 条极端天气没有配置这个字段，保持 Neutral——不给每条都发明一份
    // 权重表（GPT 复核明确建议过"只做几个最违和的硬性排除"，不是逐条配表）。
    dayNightRule: { veto: 'day' },
    tags: ['LUMINANCE', 'THERMAL'],
  },
  // 雨 → 洪涝：塔优势 → 极化为"兵线泡在水里"，水洼连成连续积水带
  flood: {
    id: 'flood', name: '洪涝', icon: '🌊', color: '#4a8fbf',
    trigger: { rain: 0.62 },
    desc: '雨势失控，峡谷成河。兵线在连成一片的积水里寸步难行，高处的塔稳坐钓鱼台。',
    effects: [
      { targets: 'minions', statKey: 'moveSpeed', percent: -35 },
      { targets: 'towers', statKey: 'healthRegen', flat: 6 },
    ],
    // Signature（状态质变）：不是水洼数量翻倍，是合并距离阈值大幅放宽，水洼直接
    // 连成连续积水带——GroundTraceSystem 读这条 active 时套用。
    signature: { kind: 'floodMerge', mergeDistanceMul: 3 },
  },
  // 雾 → 浓雾：兵优势 → 极化为"塔近乎失明"
  densefog: {
    id: 'densefog', name: '浓雾', icon: '🌁', color: '#9aa7b5',
    trigger: { fog: 0.62 },
    desc: '伸手不见五指。塔的索敌近乎瘫痪，兵线在雾中放开手脚（近战单位仍能正常接战）。',
    effects: [
      { targets: 'towers', statKey: 'attackDamage', percent: -22 },
      { targets: 'minions', statKey: 'damageAmpPct', flat: 14 },
      { targets: 'minion_ranged_siege', statKey: 'attackRange', percent: -70 },
    ],
    // 额外叠加自己的结构性机制：索敌范围比普通雾更狠。
    // ==================== 安全约束（设计文档 §9.10）====================
    // 自动沙盒没有玩家手动介入，`aggroRangeScalePct` 无论被压缩到多狠，
    // WeatherSystem.getStructuralFactor 的消费端（LaneMovementSystem）都必须
    // clamp 住一个"近战单位仍可正常接战"的下限——否则双方 AI 会永远找不到
    // 彼此，整局停滞。这个下限在消费端实现，不在这里的数值本身。
    structural: { aggroRangeScalePct: -15 },
    // Signature（环境视觉）：雾的最大浓度上限临时抬高，超出日常水位。
    signature: { kind: 'maxFogStrength', strengthMul: 1.25 },
  },
  // 风 → 飓风：节奏加快 → 极化为"全场狂飙"，植被摆动拉满
  hurricane: {
    id: 'hurricane', name: '飓风', icon: '🌀', color: '#6fc7c0',
    trigger: { wind: 0.62 },
    desc: '狂风撕扯战场。所有单位被吹得飞快，树木在狂风中剧烈摇晃。',
    effects: [
      { targets: 'all', statKey: 'moveSpeed', percent: 30 },
      { targets: 'all', statKey: 'bonusAttackSpeedPct', flat: 14 },
      { targets: 'all', statKey: 'bulletSpeed', percent: -45 },
    ],
    structural: { turnRateScalePct: -15 },
    // Signature（环境视觉）：不叠加新数值效果，复用现成的风吹植被摆动机制拉满；
    // 若同时有雾，流速也跟着拉满。
    signature: { kind: 'vegetationMax', fogSpeedMul: 1.5 },
  },
  // 雪 → 寒潮：节奏减慢 → 极化为"全场冻结"（一切都慢，包括死亡）
  coldsnap: {
    id: 'coldsnap', name: '寒潮', icon: '🥶', color: '#a8c8e8',
    trigger: { snow: 0.62 },
    desc: '气温骤降，万物冻僵。全场动作迟滞，但寒冷也让伤口凝住——死亡同样变慢。',
    effects: [
      { targets: 'all', statKey: 'moveSpeed', percent: -30 },
      { targets: 'all', statKey: 'damageReduction', flat: 10 },
    ],
    // 第一版无 Signature——"寒潮触发时反推气象轴温度往负极走"的点子被 GPT 否决：
    // 天气→轴→更多同类天气→轴会形成正反馈 runaway，破坏 OU 连续性架构，
    // 见设计文档 §9.8 表格最后一行。天气效果只能读轴（TEMP_AXIS_COUPLING），
    // 不能写轴。
    signature: null,
  },
};

// 便捷合集（UI 遍历用）
export const ALL_WEATHERS = { ...BASE_WEATHERS, ...EXTREME_WEATHERS };

// ==================== 气候模板（按真实世界的地貌/气候带） ====================
// v52（气象轴 v1）：每个模板新增 muT——温度轴的目标值（-1冷~+1热）。
// 用户 + GPT 定稿："气候模板必须直接决定温度轴的长期目标值，不能只给初始随机
// 倾向"——不然"沙漠"这个模板完全可能在单局里恰好抽到一条偏冷的随机轨迹，
// 玩家会觉得"明明选了沙漠怎么下雪了"。muT 数值取自与 GPT 讨论时定的参考表。
export const CLIMATE_TEMPLATES = {
  random: {
    id: 'random', name: '全随机', icon: '🎲',
    desc: '每局完全随机的天气性格（默认）。',
    mu: null, muT: null,
  },
  temperate: {
    id: 'temperate', name: '温带', icon: '🏞️',
    desc: '四季分明、天气均衡。各类天气都有机会出现。',
    mu: { clear: 0.35, rain: 0.15, fog: 0.0, wind: -0.05, snow: -0.25 },
    muT: 0,
  },
  desert: {
    id: 'desert', name: '沙漠', icon: '🏜️',
    desc: '撒哈拉。常年烈日当空，几乎不下雨；大风卷起沙暴。',
    mu: { clear: 1.0, rain: -0.9, fog: -0.8, wind: 0.05, snow: -1.0 },
    muT: 0.75,
  },
  rainforest: {
    id: 'rainforest', name: '热带雨林', icon: '🌴',
    desc: '亚马逊。几乎天天下雨，雷暴频发。',
    mu: { clear: -0.3, rain: 1.0, fog: 0.15, wind: -0.5, snow: -1.0 },
    muT: 0.45,
  },
  polar: {
    id: 'polar', name: '极地', icon: '🏔️',
    desc: '南极。风雪常态，暴风雪与白茫轮番上阵，战局极度缓慢。',
    mu: { clear: -0.4, rain: -0.8, fog: -0.1, wind: 0.25, snow: 1.0 },
    muT: -0.75,
  },
  oceanic: {
    id: 'oceanic', name: '海洋性', icon: '🌊',
    desc: '英伦。阴雨连绵、大雾弥漫，暴雨多发。',
    mu: { clear: -0.15, rain: 0.55, fog: 0.7, wind: 0.05, snow: -0.3 },
    muT: 0.05,
  },
  plateau: {
    id: 'plateau', name: '高原', icon: '⛰️',
    desc: '青藏。烈日与强风并存，偶有风雪。',
    mu: { clear: 0.55, rain: -0.35, fog: -0.5, wind: 0.5, snow: 0.1 },
    muT: -0.35,
  },
  steppe: {
    id: 'steppe', name: '草原', icon: '🌾',
    desc: '蒙古。大风是常态，干燥少雨，沙暴多发。',
    mu: { clear: 0.25, rain: -0.45, fog: -0.6, wind: 0.8, snow: -0.1 },
    muT: 0.15,
  },
};

// ==================== 气象轴 v1：温度对各天气 μ 的偏移系数 ====================
// 用户 + GPT 定稿：雪强、晴中、雨弱的不对称耦合——温度轴主要负责"冷暖"这一件事，
// 不能让它退化成一个隐藏的"晴/雪二选一开关"（GPT 原话）。雾/风不挂温度，
// 不强行给每种天气都找一个因果关系。
// T 的取值域是 [-1,1]（-1 最冷，+1 最热），axisShift_i = TEMP_AXIS_COUPLING[i] × T，
// 与 baseMu 同一空间相加（见 WeatherSystem._stepOU）。
// v54 §9.7：用户反馈"看不出气象轴效果"，这里小幅调大（不对称比例不变，snow 仍是
// clear 的约 2 倍强度），配合趋势尺度压缩（AXIS_TARGET_DURATION_MIN/MAX）和
// tempTintStrength 的小幅提升，让轴的存在感分摊在多个渠道上一起变明显，
// 而不是单独把某一个数字调猛。
export const TEMP_AXIS_COUPLING = {
  snow: -0.85,  // 强：越冷雪越容易上
  clear: 0.4,   // 中：越热越容易晴，但不能强到让"热=晴"变成必然
  rain: 0.15,   // 弱：暖雨比冷雨略常见，弱关联
  fog: 0,
  wind: 0,
};

// ==================== v55.2：天气系统重构——"系统驱动"核心机制 ====================
// 用户实机反馈两个问题："效果看不出来"（5 条基础天气强制权重恒和为1，谁都冲不高，
// 永远是稀释过的混合汁）和"物理别扭"（雨/雪是两条独立游走的轴，只靠弱耦合系数
// 偏一下彼此的目标值，能同时冲到"盛夏暴雪"这种说不通的组合）。跟用户+GPT反复
// 讨论后定的新模型：不再是"5个各自摇骰子的独立变量"，改成"有没有一个天气系统
// 正在经过"——系统有生命周期（起→峰→落），风/降水强度/温度骤变全部是"这个系统
// 现在走到哪一步了"的同一份读数派生出来的，不是各自独立摇骰子。
//
// ==================== 与旧模型的兼容策略（不是推倒重来）====================
// 没有改变 WeatherSystem 对外的公开契约——getCharge('rain')/getCharge('snow')/
// getEffectiveStrengths()/getModifiers()/getStructuralFactor()/getSkillParamMod()
// 全部照旧返回同样形状的数据，EXTREME_WEATHERS 的 trigger 表（认 rain/snow/fog/
// wind/clear 这五个 id）、WEATHER_SKILL_MODS、GroundTraceSystem._rainScale()/
// _snowScale()、PostFX/ThreeRenderer 的天气可视化——一个字都不用改。变的只是
// WeatherSystem 内部【怎么算出这五个 id 各自现在多强】：旧的是 5 条独立 OU +
// softmax，新的是"天气系统事件"驱动，降水强度和风强度由系统的包络曲线给出，
// rain/snow 这两个 id 现在是【同一份降水强度】按【当前温度】拆出来的两半
// （temperature 决定"这团正在下落的水汽是雨还是雪"），不再是两条各自独立的轴——
// "盛夏暴雪"这种物理不成立的组合，现在结构上就不可能出现了。
// clear 这个 id 也从"第5个要抢预算的选手"变成派生量（= 1 − 降水 − 雾 的近似），
// fog 只在"没有系统在场"的空当里由气候基线生成。
//
// ==================== 原型（archetype）====================
// 首批 5 种，覆盖度足够（GPT 复核建议的起始规模）。每个原型的"形状"（包络曲线）
// 都是 riseFrac + peakFrac + fallFrac = 1（起势占比例+驻峰占比例+回落占比例，
// 三段吃满整个生命周期，不留"已经归零但还占着位置"的死尾巴）——见
// WeatherSystem._archetypeEnvelope 的纯函数实现。durationSec 是这局35分钟游戏
// 时长里的【游戏设计参数】，不是真实气象系统的实际持续时间（GPT 原话）。
// precipPeak/windPeak：满强度（strength=1）时驻峰阶段能冲到的降水/风强度上限
// （0~1）。deltaT：满强度时驻峰阶段把温度往哪个方向推多少（气候基线单位，
// 与 TEMP_AXIS_COUPLING 同一空间）。affinity(mu, muT)：这个原型在当前气候
// 倾向下被抽中的相对权重，复用现有的 CLIMATE_TEMPLATES.mu/muT（不新增气候
// 字段，气候模板与编辑器面板的 mu 滑条因此不用改一行代码就能继续控场——见
// WeatherSystem._pickArchetype 头注）。
//
// ⚠️ 数值是这次重构给出的第一版合理值（时长范围/强度峰值/ΔT幅度/亲和度公式），
// 不是用 balance_matrix 复核过的精确数字——跟这个项目其它"先给可编辑默认值、
// 有问题随时调"的口径一致，后续要用 node tools/balance_matrix.mjs 实机验证手感。
export const WEATHER_ARCHETYPES = {
  // 冷锋：快、猛、转冷，风先来，降水集中在前沿——"天气突然变了"的那种系统。
  coldFront: {
    id: 'coldFront', name: '冷锋', icon: '🌬️', color: '#6f9bc7',
    durationSec: [300, 480],   // 5~8 分钟
    // v55.2 实测调整：驻峰占比 0.15 时，即便冷锋是当前气候被抽中最多的原型，
    // 整条事件时间线里它"真正猛"的时间也太短——大部分时间都在缓慢起势/消散，
    // 长期统计下来"晴"（谁的缓坡时段都会往这边记）反而比"风"更常见，草原模板测出
    // 来主导天气是晴不是风。把驻峰段拉长到 0.40（起势/回落相应缩短），冷锋经过时
    // "真的在刮大风"这件事占的时间比例更高，草原这类偏爱冷锋的气候，风才能立起来。
    envelope: { riseFrac: 0.15, peakFrac: 0.40, fallFrac: 0.45 },
    precipPeak: 0.95,
    windPeak: 1.0,             // 风在冷锋自己的前沿最强，这是它的招牌特征
    deltaT: [-0.55, -0.25],    // 转冷
    // v55.2 实测调整：草原模板（mu.wind 很高、mu.rain/snow 都是负的）原本测出"晴"
    // 反而比"风"更常见——因为原来的亲和度公式完全没提 mu.wind，"风"只是别的降水
    // 系统的副产品，草原的高 mu.wind 无处生根。冷锋本身就是"风在前沿最强"的原型
    // （见 windPeak），加一条 mu.wind 项，让"喜欢刮风"的气候真的更容易抽到它。
    affinity: (mu, muT) => 0.4 + Math.max(0, mu.rain) * 0.22 + Math.max(0, mu.snow) * 0.1 + Math.max(0, mu.wind) * 0.6 + Math.max(0, -muT) * 0.2,
  },
  // 暖锋：缓慢转暖，降水绵长，起落都比冷锋温和——"连绵阴雨"的那种系统。
  warmFront: {
    id: 'warmFront', name: '暖锋', icon: '🌦️', color: '#7fae8f',
    durationSec: [420, 660],   // 7~11 分钟
    envelope: { riseFrac: 0.35, peakFrac: 0.30, fallFrac: 0.35 },
    precipPeak: 0.9,
    windPeak: 0.4,
    deltaT: [0.2, 0.45],       // 转暖
    affinity: (mu, muT) => 0.4 + Math.max(0, mu.rain) * 0.5 + Math.max(0, muT) * 0.2,
  },
  // 对流雷暴：短、猛、脉冲式——起势快、驻峰短、回落也快，整个系统本身持续时间就短。
  thunderstorm: {
    id: 'thunderstorm', name: '对流雷暴', icon: '⛈️', color: '#7c5cff',
    durationSec: [120, 240],   // 2~4 分钟
    envelope: { riseFrac: 0.20, peakFrac: 0.30, fallFrac: 0.50 },
    precipPeak: 1.0,           // 单位时间内最猛的降水
    windPeak: 0.85,
    deltaT: [-0.1, 0.1],       // 温度冲击不大，主戏是降水+风
    affinity: (mu, muT) => 0.25 + Math.max(0, mu.rain) * 0.3 + Math.max(0, muT) * 0.25, // 暖湿地区更容易对流
  },
  // 稳定高压：平静期/晴朗期，长时间维持、起落都很平缓——"什么都没发生"的那种系统，
  // 天气叙事里"事件之间的空当"本身就是它，不是没有天气，是天气正好是"晴"。
  highPressure: {
    id: 'highPressure', name: '稳定高压', icon: '☀️', color: '#f6c94a',
    durationSec: [420, 720],   // 7~12 分钟
    envelope: { riseFrac: 0.15, peakFrac: 0.70, fallFrac: 0.15 },
    precipPeak: 0,             // 不带降水
    windPeak: 0.1,
    deltaT: [0, 0],            // 不主动推温度——平静期温度自己缓慢漂回气候基调
    // v55.2 实测调整：海洋性模板（mu.fog 很高）原本测出"风"比"雾"更常见——雾只在
    // "没有系统压阵"的平静期由气候基线生成（见 WeatherSystem._ratiosFromSample），
    // 而稳定高压是唯一制造这种平静期的原型，它原来只认 mu.clear，海洋性那种
    // "常年阴湿多雾但没什么大太阳"的气候完全没有多余的平静期可用。稳定高压不是
    // "只代表晴"，是"没有强系统经过"这件事本身，加一条 mu.fog 项后，喜欢起雾的
    // 气候也会更频繁地进入这种平静期，雾才有地方长出来。
    affinity: (mu, muT) => 0.4 + Math.max(0, mu.clear) * 0.6 + Math.max(0, mu.fog) * 0.5,
  },
  // 寒潮：快速降温、长时间维持低温——核心是温度骤降本身，降水是中等量的伴生物
  // （温度会被推得很低，同一份降水强度经温度拆分后几乎全部落成雪）。
  coldWave: {
    id: 'coldWave', name: '寒潮', icon: '🥶', color: '#a8c8e8',
    durationSec: [480, 840],   // 8~14 分钟
    // v55.2 实测调整：驻峰段拉到 0.65（起势相应缩短）——寒潮的性格就是"来了就赖着不走"，
    // 比冷锋更需要长时间维持满强度，不然极地模板测出来"晴"比"雪"更常见（漂移到
    // "晴"的缓坡时段被记太多）。
    envelope: { riseFrac: 0.12, peakFrac: 0.65, fallFrac: 0.23 },
    precipPeak: 1.0,           // 满强度时驻峰阶段几乎全是降水——寒潮期间不该还有大片"晴"
    windPeak: 0.3,
    deltaT: [-0.9, -0.6],      // 大幅转冷，这是寒潮的核心
    affinity: (mu, muT) => 0.3 + Math.max(0, mu.snow) * 0.6 + Math.max(0, -muT) * 0.3,
  },
};

// ==================== 降水形态：纯粹是"当前温度"的函数 ====================
// 系统只决定"有没有抬升、抬升多猛"（precip 强度），温度决定"抬升出来的水汽变成
// 什么"——这样同一个系统经过的过程中会自然出现"雨→雨夹雪→雪"这种形态演变，
// 不是硬阈值瞬间变脸。返回 0~1：0=全是雨，1=全是雪；连续插值，中间是雨夹雪。
// 阈值参考真实体感：temp<-0.15（气候基调偏冷）时开始明显偏雪，temp<-0.5 时几乎全雪；
// temp 的取值域是 [-1,1]，与 WeatherSystem.getTemperature() 同一空间。
export function snowFractionAt(temp) {
  const t = Math.max(-1, Math.min(1, temp));
  // 用一段线性斜坡把 [-0.55, 0.15] 映射到 [1, 0]（越界钳位），中心落在"体感转折点"
  // 略偏冷侧——真实世界里 0°C 左右才开始有雨夹雪，不是温度轴的正中点。
  const hi = -0.55, lo = 0.15;
  if (t <= hi) return 1;
  if (t >= lo) return 0;
  return (lo - t) / (lo - hi);
}
