export const CONFIG = {
  gameRules: {
    waveInterval: 45,
    firstWaveDelay: 20,
    hpFixedPerWave: 2,
    hpCompPctPerWave: 0.3,
    attrFixedPerWave: 3.5,
    attrCompPctPerWave: 0.4,
    shieldRegenDelay: 8,
    onHitArmorPen: 30,
    lifeStealToHealth: 50,
    lifeStealToShield: 50,
    waveMeleeCount: 3,
    waveRangedCount: 3,
    waveSiegeSuperInterval: 2,
    waveSuperFromWave: 20,
    waveTotemInterval: 5,
    // v33：对战模式特殊兵种生成规则（模板编辑器"生成规则"可改；目前只接入图腾兵）
    battleTotemFromWave: 10,   // 第几波起开始生成图腾兵（对战模式）
    battleTotemInterval: 3,    // 每几波生成一次（对战模式）
    // v33：兵种生成总开关（沙盒+对战通用；模板编辑器"生成规则"里可切）
    spawnEnabled: { melee: true, ranged: true, siege: true, super: true, totem: false, warlock: true, corrupt: true, ram: false }, // v35：图腾默认不生成；攻城车(ram)默认不生成——暂无模型（编辑器可开）
    waveShieldInterval: 4,
    waveWarlockInterval: 6,
    waveCorruptInterval: 7,
    waveRamInterval: 15,       // v40：攻城车每几波生成一次
    ramMinWave: 5,             // v40：攻城车最早生成波次
    milestoneEveryWaves: 10,
    // ==================== 对战模式·每波出兵编排（软编码，模板编辑器可改）====================
    // 数组【顺序即出兵顺序】（越靠后出得越晚、位置越靠后）；每项一条规则：
    //   type   兵种；count 本波该兵种个数
    //   fromWave 第几波起开始（默认 0 = 一直）；everyN 每几波一次（默认 1 = 每波）
    //   触发判据统一为： wave >= fromWave && (wave - fromWave) % everyN === 0
    //   when   'nexusDown'（己方水晶已陷落时才出）/ '!nexusDown'（未陷落时才出）/ 省略 = 不限
    // 默认值【逐条等价于此前的硬编码】，因此不改参数时对战节奏完全不变：
    //   super: 水晶陷落才出 1 个；melee×3；siege 每 3 波 1 个(未陷落)；ranged×3；
    //   totem 第10波起每3波1个；ram 第5波起每15波1个。
    laneWaveComposition: [
      { type: 'super',  count: 1, when: 'nexusDown' },
      { type: 'melee',  count: 3 },
      { type: 'siege',  count: 1, everyN: 3, when: '!nexusDown' },
      { type: 'ranged', count: 3 },
      { type: 'totem',  count: 1, fromWave: 10, everyN: 3 },
      { type: 'ram',    count: 1, fromWave: 5,  everyN: 15 },
    ],
    // v33 Q4：对战模式特殊兵生成规则（模板编辑器"生成规则"可改）。目前只接入图腾兵。
    battleTotemFromWave: 10,   // 第几波起开始生成
    battleTotemInterval: 3,    // 每几波生成一次
    // v33 Q4：各兵种"是否生成"总开关（沙盒+对战都生效；模板编辑器"生成规则"里可切）
    spawnEnabled: { melee: true, ranged: true, siege: true, super: true, totem: false, warlock: true, corrupt: true, ram: false }, // v35：图腾默认不生成；攻城车(ram)默认不生成——暂无模型（编辑器可开）
    dragonFirstDelay: 60,
    dragonInterval: 90,
    dragonHpScale: 12,
    dragonAttrScale: 3,
    dragonKillsToUnlock: 4,
    ancientDragonHpScale: 25,
    ancientDragonAttrScale: 5,
  },
  // 建筑渲染体积（半径 px）：LoL 中水晶枢纽 > 防御塔 > 召唤水晶，按 tier 区分。
  // 可在统一模板编辑器的"建筑体积"区块调整；沙盒手建塔无 tier，用 default。
  // 阵营模板覆写层：battle 模式生成单位时按 {...templates[type], ...factionOverrides[faction][type]} 合并。
  // 只存"与共享基础不同的字段"（模板编辑器按阵营页签写入/清除），改一方不影响另一方。
  // 分层防御塔覆写层（模板编辑器"防御塔" 下的 外/内/水晶/枢纽塔、召唤水晶、水晶枢纽）。
  // 语义：【模板覆盖地图】——地图 tierStats 作初始值，这里只存"用户改过的字段"，
  // 生成建筑时按 地图 tierStats → towerTierOverrides → factionOverrides['tower_'+tier] 依次覆盖。
  // 不改就是空对象 → 完全沿用地图数值，行为不变。
  towerTierOverrides: { outer: {}, inner: {}, base: {}, hq_tower: {}, nexus_lane: {}, nexus_main: {} },
  // 分层防御塔的【默认被动覆写】。undefined = 沿用 main.js createBuilding 的硬编码默认装配；
  // 一旦模板编辑器"被动技能"tab 点过应用，就变成显式数组（空数组 = 该层级不装任何被动），
  // 从此完全由这里决定，不再受代码默认与波次门槛影响（与小兵 _templateSkills 语义一致）。
  towerTierSkills: {},
  // 分层防御塔的【默认状态效果】。数组元素是 EffectRegistry 的 blueprint 对象；
  // 新生成的该层级建筑会在入场时自动施加一次。undefined/空数组 = 不施加。
  towerTierEffects: {},

  // ==================== 对战成长表（Q2：从 main.js 的硬编码常量搬到这里）====================
  // 纯固定值/波，杜绝复利后期爆炸；只动 最大生命/攻击力/双抗。
  // 地图可用 map.minionGrowth 按兵种覆写（浅合并，只写要改的字段）——
  // 同一兵种在不同地图上可以有完全不同的成长曲线。
  //
  // Q2 定稿：双抗成长 0.1 → 近战0.5 / 远程0.4 / 超级兵0.5（炮车 0.30 保持上一轮的结论）。
  // 原来的 0.1/波 意味着 60 分钟（120波）近战双抗只从 15 涨到 27，等于没有成长；
  // 现在同期涨到 75，防御塔后期确实打不动小兵了，对应"30分钟后小兵占优"。
  battleGrowth: {
    melee:  { hp: 7,  ad: 0.3,   res: 0.5 },
    ranged: { hp: 5,  ad: 0.375, res: 0.4 },
    siege:  { hp: 10, ad: 0.9,   res: 0.30 },
    // 超级兵【故意不跟这轮双抗提升】：它只在水晶陷落后才出场，正好是用户嫌"推上高地就马上结束"
    // 的那一段。给它同样的 0.5/波 等于把收尾推得更快，与目标相反。只从 0.1 微调到 0.15。
    super:  { hp: 20, ad: 1.875, res: 0.15 },
    // 攻城车：生命正常成长，攻击力成长极慢，双抗不成长（影响力随时间自然衰减）
    ram:    { hp: 10, ad: 0.1,   res: 0 },
    _default: { hp: 8, ad: 0.375, res: 0.1 },
  },

  // 屠戮（近战/远程/炮火）参数。base 决定【伤害基数取什么】：
  //   'template' = 该兵种的模板基础生命（不随波次成长膨胀）  ← Q2 定稿
  //   'current'  = 自身当前生命（旧行为）
  //
  // 为什么改 base：屠戮本来的用意是"加快前期小兵互殴"（用户原话），
  // 但基数取当前生命、而生命也随波次成长，两者同步 → 兵杀兵所需时间【永远恒定 14.4 秒】。
  // 波间隔 30 秒，于是两波兵永远在半个周期内互相清完，永远聚不起来，
  // 高地也就永远推不动。改成模板基础生命后：前期屠戮占比仍然很高（快速清线的初衷保留），
  // 后期随生命成长自然稀释，兵杀兵 TTK 17.6s → 28.8s，逼近波间隔 → 后期开始堆叠。
  //
  // 地图覆写：map.skillOverrides['melee'].passive_melee_rend = { pct, base }，
  // 数值与机制都能改（base 甚至可以在某张图上切回 'current'）。
  rend: {
    melee:  { pct: 0.04, base: 'template' },
    ranged: { pct: 0.06, base: 'template' },
    siege:  { pct: 0.07, base: 'template' },
  },

  factionOverrides: { blue: {}, red: {} },

  // ==================== 对战调参表（技术债清偿：原散落在各系统源码里的硬编码） ====================
  // 改这里即可调平衡，各系统启动时读取；缺省值与系统内兜底一致。
  tuning: {
    acquisitionRange: 200,        // 小兵仇恨获取半径（≈ LoL 800 × 0.24）
    chaseDropFactor: 1.2,         // 追击放弃距离 = 仇恨半径 × 此系数
    collisionOverlapAllow: 0.85,  // 碰撞：重叠容忍（×半径和）
    collisionMoverFactor: 0.25,   // 碰撞：移动单位修正比例
    collisionAnchorFactor: 0.02,  // 碰撞：锚定单位修正比例
    collisionMaxPush: 2.0,        // 碰撞：移动单位单步位移上限（px）
    collisionMaxPushAnchor: 0.3,  // 碰撞：锚定单位单步位移上限（px）
    nexusRespawnTime: 300,        // 召唤水晶重生（秒）
    spawnGap: 0.55,               // v41：加大出兵间隔，防止出生时立即触发避障
    // 天气效果预算：多种天气并存时，效果生效强度的总上限（按占比降序累计，超出部分截断）。
    // 单一天气不受此限（可全额生效，模拟极端天气）。只影响【效果强度】，不影响天气占比显示。
    // 天气充能条（Q1：四档强度 + 渐进消散）
    weatherChargeMinRatio: 0.15,   // 占比达到多少才开始充能
    weatherChargeRefRatio: 0.5,    // 参考占比：占比等于它时按 weatherChargeFullSec 充满
    weatherChargeFullSec: 20,      // 参考占比下充满需要的秒数
    weatherDrainSec: 35,           // 从满充放空需要的秒数（> 充满秒数 → 消散比积累慢）
    weatherExtremeWeightInfluence: 0.65, // 极端天气权重对触发阈值的影响力
    // Q2：召唤水晶重生前多少秒停止生成超级兵（水晶快复活了 → 超级兵红利提前结束）
    // （v33：30 → 45，用户定稿）
    superMinionCutoffBeforeRespawn: 45,
    lockOnWindup: 0.3,            // v33（Q14）：锁定新目标的攻击前摇（秒），塔和小兵通用，腐蚀型除外
  },

  buildingSizes: {
    outer: 28, inner: 28, base: 28, hq_tower: 24,
    nexus_lane: 20, nexus_main: 40, default: 28,
  },

  templates: {
    tower: {
      label: '防御塔', type: 'tower',
      // v35（Q5）：所有防御塔默认 生命恢复/固定护盾 = 0（用户定稿，沙盒塔模板同样适用；
      // 恢复与护盾一律由被动提供）
      maxHP: 9000, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 0, attackRange: 180,
      attackDamage: 152, baseAttackSpeed: 0.833, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 40, magicResist: 40,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0  , shieldRegenRate: 8, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', bulletSpeed: 400,
    },
    melee: {
      label: '近战兵', type: 'melee',
      isLargeMinion: false, isMonster: false,
      // v33：350→500。基准：对战开局外塔（穿透型，含破甲+升温逐发爬升 ×1.0/×1.3/×1.6）
      // 恰好 3 发击杀（2 发打不死），仿真校验（tests/sim_v33.mjs）。
      maxHP: 500, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 30,
      attackDamage: 9, baseAttackSpeed: 1.25, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 15, magicResist: 15,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 300, queueSpacing: 20,
    },
    ranged: {
      label: '远程兵', type: 'ranged',
      isLargeMinion: false, isMonster: false,
      maxHP: 200, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 150,
      attackDamage: 6.5, baseAttackSpeed: 0.667, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 5, magicResist: 5,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'magic', spawnDistance: 300, queueSpacing: 20,
    },
    siege: {
      label: '炮兵', type: 'siege',
      isLargeMinion: true, isMonster: false,
      maxHP: 1088, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 127.5,
      attackDamage: 17.5, baseAttackSpeed: 1.0, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 40, magicResist: 40,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 320, queueSpacing: 20,
    },
    totem: {
      label: '图腾兵', type: 'totem',
      isLargeMinion: false, isMonster: false,
      maxHP: 150, healthRegen: 1, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 180,
      attackDamage: 7.5, baseAttackSpeed: 0.422, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 5, magicResist: -10,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 600, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'magic', spawnDistance: 300, queueSpacing: 20,
    },
    super: {
      label: '超级兵', type: 'super',
      isLargeMinion: true, isMonster: false,
      maxHP: 2750, healthRegen: 7, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 50,   // v40（Q1 修复）：20→50。超级兵体型14+近战兵10=24 已超过原射程20，
      // 判定上永远够不着目标 → "打不到人"。50 仍 ≤ 近战阈值60，超级兵依然算近战单位。
      attackDamage: 208, baseAttackSpeed: 0.833, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 100, magicResist: -30,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 300, queueSpacing: 20,
    },
    warlock: {
      label: '术士兵', type: 'warlock',
      isLargeMinion: true, isMonster: false,
      maxHP: 520, healthRegen: 1, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 170,
      attackDamage: 14, baseAttackSpeed: 0.7, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 20, magicPenPercent: 0,
      armor: 25, magicResist: 25,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'magic', spawnDistance: 300, queueSpacing: 20, bulletSpeed: 320,
    },
    corrupt: {
      label: '蚀骨兵', type: 'corrupt',
      isLargeMinion: true, isMonster: false,
      maxHP: 620, healthRegen: 1, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 20,
      attackDamage: 13, baseAttackSpeed: 1.0, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 25, magicResist: 25,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 300, queueSpacing: 20,
    },
    // v39（Q4 节奏）：攻城车——专职破塔的攻城单位。用户定稿数值。
    // 血 800（远高于远程兵，但双抗 0 且被近战克制）、AD 35、攻速 0.25（4秒一发）、
    // 射程 260（> 塔的 180，可越塔输出，塔打不到它）。
    ram: {
      label: '攻城车', type: 'ram',
      isLargeMinion: true, isMonster: false,
      maxHP: 800, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 78, attackRange: 312,   // v40：260 → +20% = 312
      attackDamage: 60, baseAttackSpeed: 0.25,   // v40：35 → 60（远高于炮兵17.5） bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 0, magicResist: 0,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 300, queueSpacing: 20,
      splashRadius: 60,  // v39：普攻溅射（爆炸型子弹的一半左右）
    },
    dragon: {
      label: '巨龙', type: 'dragon',
      isLargeMinion: true, isMonster: true,
      maxHP: 8000, healthRegen: 0, baseHealthRegenMod: 1.0,
      moveSpeed: 0, attackRange: 0,
      attackDamage: 0, baseAttackSpeed: 0.5, bonusAttackSpeedPct: 0, attackSpeedRatio: 0.667,
      armorPenFlat: 0, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0,
      armor: 40, magicResist: 40,
      damageReduction: 0, damageBlock: 0,
      shieldFixedMax: 0, shieldRegenRate: 5, tempShieldDecayPct: 5,
      onHitDamage: 0, onHitPercentDamage: 0,
      damageConvertPct: 0, lifeStealPct: 0, damageAmpPct: 0, allStatsPct: 0,
      healShieldPowerPct: 0,
      attackType: 'physical', spawnDistance: 0, queueSpacing: 0,
    }
  }
};

// 小兵在画布上的显示半径——CanvasRenderer（视觉）与 CollisionSystem（碰撞半径）
// 共用同一份数据，避免两处各写一份数字、改了一处忘了另一处导致"看起来很小但碰撞体积很大"。
// v34（Q3 定稿）：体积整体加大（渲染与碰撞共用）。LoL 小兵碰撞体积约 48~65 units，
// 按本图 0.24 缩放对应 12~16px；取略小值保证走廊（半宽95）还装得下双线对冲。
// 半径过小（旧值 7）是"堆叠过密 → 挤压失稳 → 混战团膨胀"的帮凶之一。
// v39（Q4）："近战单位"的统一判据 = 攻击距离 ≤ 此阈值。
// 命中：近战兵30 / 超级兵20 / 蚀骨兵20；排除：炮车127.5 / 远程150 / 术士170 / 图腾180 / 防御塔180 / 攻城车260。
export const MELEE_RANGE_THRESHOLD = 60;

export const MINION_SIZES = {
  melee: 10,
  ranged: 10,
  siege: 12,
  super: 14,
  totem: 11,
  shield: 12,
  warlock: 10,
  corrupt: 10,
  ram: 14,     // v39：攻城车（体型与超级兵相当）
};
