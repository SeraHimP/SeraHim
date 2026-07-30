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
    // ==================== 支援兵种数值（用户定稿的重做）====================
    // 三个兵种的定位：图腾=续航/减伤、术士=增伤/破防、蚀骨=近战破甲。
    // 全部软编码，源码里不留魔数。
    supportUnits: {
      // 图腾兵：周期性治疗【已损生命】百分比 + 减伤/护盾光环 + 自身高额固定护盾
      totem: {
        healIntervalSec: 15,   // 治疗周期（秒）
        healMissingPct: 3,     // 每次治疗量 = 目标【已损生命】的百分比
        auraDamageReduction: 10, // 光环：伤害减免（%）
        auraShieldFlat: 25,      // 光环：固定护盾
        selfShieldFlat: 900,     // 自身固定护盾（"高额"）
      },
      // 术士兵：给友军双穿+增伤光环；自身高额双穿
      warlock: {
        auraPenPct: 13,        // 光环：护甲穿透% / 魔法穿透%（双穿）
        auraDamageAmpPct: 7,   // 光环：伤害增幅（%）
        selfPenPct: 70,        // 自身双穿（%）
      },
      // 蚀骨兵：近战，血量高于普通近战，小范围内所有敌人双抗降低（一次即满层）
      corrupt: {
        radius: 110,           // "小范围"
        resistPerStack: 6,     // 每层降低的护甲/魔抗
        maxStacks: 5,          // 满层数（一次施加即满）
      },
    },
    // 塔是否可以互相攻击（用户："塔之前也可以相互攻击（我方塔打敌方塔）"）。
    // 仍受结构保护约束、且塔的索敌优先级最低（不会为了打塔而无视拆自己的小兵）。
    towerAttacksTower: true,
    // 阵营龙魂规则（用户定稿："6 条龙 + ≥4 击杀才成魂、都不到 4 则无魂、之后出远古龙"）
    elementDragonTotal: 6,     // 元素龙总条数，打完即结算龙魂
    dragonSoulThreshold: 4,    // 成魂门槛（阵营击杀数）；双方都达标时按击杀多者，同分则无魂
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
    // 出兵编排（数组顺序 = 出兵先后）。用户："让所有兵种都会默认生成，你看怎么编排合适"。
    //
    // 编排思路：前排承伤 → 中段输出 → 后排支援，且支援兵种【错开波次】，
    // 免得同一波里同时冒出图腾+术士+蚀骨，一波兵变成一支全能小队、兵线直接推穿。
    //   · 近战 ×3 / 远程 ×3   每波必出，兵线的骨架
    //   · 炮兵 ×1             每 3 波（水晶未陷落时），攻城主力
    //   · 蚀骨 ×1             第 4 波起每 3 波。近战破甲，走在近战之后
    //   · 术士 ×1             第 6 波起每 4 波。增伤光环，要有兵可增才有意义
    //   · 图腾 ×1             第 8 波起每 4 波。续航/减伤，最后到场
    //   · 攻城车 ×1           第 5 波起每 15 波（罕见的攻城事件）
    //   · 超级兵 ×1           水晶陷落后每波，取代炮兵
    // 蚀骨/术士/图腾的周期互质（3/4/4 且起始波错开），所以三者同时到场的波次很少，
    // 出现时也确实该是一波强攻 —— 这是有意的节奏起伏，不是失控。
    laneWaveComposition: [
      { type: 'super',   count: 1, when: 'nexusDown' },
      { type: 'melee',   count: 3 },
      { type: 'corrupt', count: 1, fromWave: 4, everyN: 3 },
      { type: 'siege',   count: 1, everyN: 3, when: '!nexusDown' },
      { type: 'ranged',  count: 3 },
      { type: 'warlock', count: 1, fromWave: 6, everyN: 4 },
      { type: 'totem',   count: 1, fromWave: 8, everyN: 4 },
      { type: 'ram',     count: 1, fromWave: 5, everyN: 15 },
    ],
    // ⚠️ 死配置（保留仅为兼容旧存档，全仓库无人读取，tests/sim_tplio.mjs 有断言守着）：
    // 对战出兵全部由上面的 laneWaveComposition 驱动，图腾兵的节奏由其中那条规则的
    // fromWave/everyN 决定。已从模板编辑器面板移除，请勿再新增读取点。
    battleTotemFromWave: 10,
    battleTotemInterval: 3,
    // 各兵种"是否生成"总开关（沙盒+对战都生效；模板编辑器「出兵编排」里可切）。
    // 用户要求"让所有兵种都会默认生成"，所以全部为 true。
    // 注意 ram（攻城车）没有 GLB 模型，会回退到程序化几何 —— 能玩，只是不好看。
    //
    // ⚠️ 这个键此前在同一个对象字面量里被声明了【两次】（另一处在上方约 30 行处），
    // 后声明的静默覆盖前面的，改前面那份毫无效果 —— 又一个"改了没反应"。
    // 已删除重复声明，这里是唯一一处。
    spawnEnabled: { melee: true, ranged: true, siege: true, super: true, totem: true, warlock: true, corrupt: true, ram: true },
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
  // 分层防御塔的【默认武器】覆写。undefined = 沿用地图给该建筑配的武器；
  // 'none' = 不装武器（不攻击）。用户定稿（Q4）：
  //   所有建筑（含召唤水晶/水晶枢纽）都【可以】装配武器进行攻击，
  //   只是召唤水晶/水晶枢纽默认无武器。默认值即写在这里，改这里就能让水晶开火。
  towerTierWeapon: { nexus_lane: 'none', nexus_main: 'none' },
  // 程序化塔/水晶的【视觉放大系数】。渲染层按它把模型画大，避障也必须按它算半径，
  // 否则小兵会按"未放大的半径"贴到塔面上 —— 画面上就是穿进模型里（Q4 废墟穿模的根因，
  // 活体塔同理，只是废墟没有血条/射程圈遮挡所以最容易被看出来）。
  // UnitLayer 与 LaneMovementSystem 共读这一份，改一处两边同步。
  towerVizScale: { nexus_lane: 1.10, nexus_main: 1.10, default: 1.25 },

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

  // ==================== 世界状态（P3：天气/昼夜/熵/龙魂 的统一落点）====================
  // 每条耦合都是【独立开关】，且**默认全关** —— 打开任意一条才会改变现有平衡，
  // 关掉全部时行为与接入前逐位一致。数值先给保守值，等批量模拟脚本出来再校准。
  world: {
    couplings: {
      dayNightFaction: false,   // 昼夜 → 阵营非对称（白天蓝方优势 / 夜晚红方优势）
      entropyToUnits: false,    // 熵 → 单位属性（熵系统实现后才有意义）
      entropyToWeather: false,  // 熵 → 天气分布（熵越高极端天气越频繁）
      entropyToDayNight: false, // 熵 → 昼夜（熵越高夜晚越长）
    },
    // 昼夜给"当前占优阵营"的加成（用户定稿的方向：蓝=秩序=白天，红=混乱=夜晚）
    dayNightBonus: { moveSpeedPct: 5, attackDamagePct: 4 },
    // 熵的非对称加成幅度（|熵-0.5|×2 为系数，中性时恒为 0）
    entropyBonus: { attackDamagePct: 8, armorFlat: 6 },
    // P5 熵/三核。全部软编码 —— 这套数值必然要反复调，写死在代码里等于每次调都改源码。
    // 平衡风险见 EntropySystem.js 顶部注释（正反馈 + 三道刹车）。
    entropy: {
      enabled: true,        // 三核是否推进（与耦合开关分开：可以只观测不生效）
      // 用户定稿：三核**总数恒为 8**，互相争夺（black + white + red ≡ coreTotal）。
      // 开局 8 颗全是未归属（红核）。每颗核 = 6.25% 的熵，要推满得连夺 8 次，
      // 且红核拿光后必须从对方手里抢 —— 滚雪球在数学上不可能（总数守恒）。
      coreTotal: 8,
      // 下面三个数是【实测标定】的，不是估的。用 tools/killrate 探针量过真实对局：
      // 稳态下每方约 35 次击杀/分钟（≈0.6/s），镜像对局两方净差仅约 1 次/分钟。
      //   · chargeDecayPerSec 必须【低于】基准击杀率，否则衰减吃光充能、熵永远不动
      //     —— 上一版取 1.5/s（是基准的 2.5 倍），实测 10 分钟对局终局熵恒为 0.500，
      //     五个加成档位的推进度差一模一样，机制等于不存在。
      //   · 也不能太低，否则回到"红方占优太快"（用户最初的反馈）。
      //     取 0.3/s ≈ 基准的一半：基准表现净攒 0.3/s，压制方更快，被压制方几乎攒不动。
      //   · chargePerCore 60 → 基准约 3.3 分钟夺一颗核，一局能推动几颗，量级合适。
      chargePerCore: 60,
      chargeDecayPerSec: 0.3,
      coreReturnSec: 120,   // 每隔多少秒把优势方的一颗核归还未归属（慢速均值回复）
      clampMin: 0,          // 熵值下限（8 颗全白 = 0）
      clampMax: 1,          // 熵值上限（8 颗全黑 = 1）
      gainMinion: 1,        // 击杀小兵的充能
      gainTower: 20,        // 摧毁建筑的充能
      gainDragon: 30,       // 保留字段；巨龙实际是【归还一颗己方核】而非充能
      volatilityPct: 12,    // 未归属核为 0 时对非对称【幅度】的放大（%）
      nightStretchPct: 30,  // entropyToDayNight：熵满时夜晚相位延长（%）
    },
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
