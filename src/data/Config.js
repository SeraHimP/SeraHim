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
      // 蚀骨兵：近战，血量高于普通近战，小范围内所有敌人双抗【逐秒递减】。
      // 用户定稿修正：上一版我把"叠层直满层"理解成"一次施加即满层"，
      // 结果站进范围瞬间就 -30 双抗，等于一个 AoE 的即时破甲 —— 强得离谱且没有博弈。
      // 正确口径是【每秒 -1，最高 -30】：要站在附近持续 30 秒才吃满，
      // 离开就随层数过期而消退，于是"要不要绕开蚀骨兵"变成一个真实选择。
      corrupt: {
        radius: 110,             // "小范围"
        resistPerStack: 1,       // 每层降低的护甲/魔抗
        maxStacks: 30,           // 满层数（→ 最高 -30 双抗）
        stackIntervalSec: 1,     // 每隔多少秒叠一层
        stackDurationSec: 3,     // 单层持续时间（离开范围后逐层过期）
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
    //   · 蚀骨 ×1             第 2 波起每 3 波。近战破甲，走在近战之后
    //   · 术士 ×1             第 3 波起每 4 波。增伤光环，要有兵可增才有意义
    //   · 图腾 ×1             第 4 波起每 4 波。续航/减伤，最后到场
    //   · 攻城车 ×1           第 3 波起每 15 波（罕见的攻城事件）
    // 用户定稿修正：起始波次整体前移（原 4/6/8/5）—— 原来的门槛意味着开局十几分钟
    // 只有近战+远程+炮兵，三个刚重做的兵种要等很久才看得到，试都不好试。
    //   · 超级兵 ×1           水晶陷落后每波，取代炮兵
    // 蚀骨/术士/图腾的周期互质（3/4/4 且起始波错开），所以三者同时到场的波次很少，
    // 出现时也确实该是一波强攻 —— 这是有意的节奏起伏，不是失控。
    laneWaveComposition: [
      { type: 'super',   count: 1, when: 'nexusDown' },
      { type: 'melee',   count: 3 },
      { type: 'corrupt', count: 1, fromWave: 2, everyN: 3 },
      { type: 'siege',   count: 1, everyN: 3, when: '!nexusDown' },
      { type: 'ranged',  count: 3 },
      { type: 'warlock', count: 1, fromWave: 3, everyN: 4 },
      { type: 'totem',   count: 1, fromWave: 4, everyN: 4 },
      { type: 'ram',     count: 1, fromWave: 3, everyN: 15 },
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
    // ==================== 巨龙：刷新节奏与强度曲线 ====================
    // 这里原本是七个键（dragonFirstDelay / dragonInterval / dragonHpScale /
    // dragonAttrScale / dragonKillsToUnlock / ancientDragonHpScale /
    // ancientDragonAttrScale）—— **全仓库没有任何一处读它们**。它们是"龙按波次
    // 长数值"那版旧公式的遗物，那版公式因为龙按固定时间表刷新、数值却按
    // window.waveNumber 算而失控（见 DragonSystem._dragonStats 顶部注释），
    // 早已被"按第几条龙算"的版本取代，键却留了下来。
    // 于是编辑器一旦把它们摆出来，用户改多少都没反应 —— 正是本项目反复出事的那类"死配置"。
    // 现在删掉那七个键，换成 DragonSystem **真正读取**的这一份：
    // 原先写死在 DragonSystem 源码里的每一个魔数都搬到了这里，数值逐个保持不变。
    dragon: {
      firstDelay: 60,                    // 首条元素龙的出现时间（秒）
      elementIntervals: [420, 480, 540], // 第 2/3/4 条元素龙的间隔；再往后沿用最后一项
      ancientFirstDelay: 300,            // 成魂结算后，首条远古龙的间隔
      ancientInterval: 600,              // 之后每条远古龙的间隔
      // 强度曲线按【第几条龙】算，与游戏波次无关。
      // 取值 = w<=knee ? base+(w-1)*step : base+(knee-1)*step+(w-knee)*lateStep，再按 cap 截顶。
      // 默认值复刻原源码：生命 1200→3000、双抗 -40→200、攻击 23→252（第 1→4 条）。
      curve: {
        maxHP:        { base: 1200, step: 600,       knee: 4, lateStep: 500, cap: null },
        resist:       { base: -40,  step: 80,        knee: 4, lateStep: 30,  cap: 500 },
        attackDamage: { base: 23,   step: 229 / 3,   knee: 4, lateStep: 60,  cap: null },
      },
      // 远古龙在同序号曲线上的额外修正（原源码：hp*1.15、双抗+40、攻击*1.1）
      ancient: { hpMult: 1.15, resistAdd: 40, adMult: 1.1 },
    },
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
  // ==================== 表现层可调项（不影响任何玩法数值）====================
  // 放在 CONFIG 里而不是散在各渲染文件的常量里，是为了守住"一切软编码"这条规矩：
  // 这些数是要反复调手感的，写死在源码里等于每次调都改代码。
  ui: {
    // 射程圈：常显是画面最大的噪音源（22 座塔 ×2 阵营全亮着）。
    // mode: 'auto'（选中 或 半径内有敌人）/ 'always'（旧行为）/ 'selected'（只看选中）
    // 射程圈（用户定稿）：敌人进到"射程 + fadeOuter"开始渐显，
    // 进到"射程 + fadeInner"时完全显示；选中的塔恒为完全显示。
    // 改版前是布尔开关 + 滞回 —— 圈整片"啪"地出现，边界上只能靠滞回压抖。
    // 现在透明度跟着最近敌人的距离连续变化，滞回就不需要了（距离本身是平滑的）。
    rangeRing: {
      mode: 'auto',         // 'auto' | 'always'（常驻，旧行为）| 'selected'（只有选中时）
      probeInterval: 0.25,  // 敌人探测节流（秒）。每帧给 44 座塔查一次纯属白烧
      // ==================== 渐显/渐隐（用户定稿，取代了按距离插值）====================
      // 用户："设置这个必须按照渐显渐隐的方式，而不再是根据单位的距离了，
      //        只要出现目标或者是点了，就渐显，消失了就渐隐。"
      // 于是强度只有 0/1 两个目标值（射程内有敌人 ‖ 被选中），平滑全部交给时间。
      // 上一版按距离插值（fadeOuter 220 → fadeInner 30）已删除：那套让敌人还在射程外
      // 470px 就把圈点亮，满地图半亮的圈，而且亮度跟着走位一直抖。
      fadeIn: 0.22,         // 渐显时间常数（秒）
      fadeOut: 0.45,        // 渐隐时间常数（秒）。比渐显慢——目标死了圈"啪"地消失最扎眼
      fade: 0.18,           // 兜底：fadeIn/fadeOut 缺省时用它
      fillAlpha: 0.059,     // 圈内填充的满强度不透明度（0x0f/255，与改版前一致）
      edgeAlpha: 0.2,       // 圈边线的满强度不透明度（0x33/255，与改版前一致）
      // ==================== 贴合地形（用户："让射程浮在地形上"）====================
      // 圈原来是一张【平的】面片，整片按塔脚那一点的高度摆，地形一有高低差就被
      // 高的那半边地面挡掉一块（用户："只要出现了高低差就会被吞掉一部分"）。
      // 现在逐顶点按 heightAt 抬沉，让圈贴着坡爬。
      drape: {
        enabled: true,
        segments: 72,       // 角向分段。250 半径时顶点间距约 22px，与地面网格（24px 一段）相当
        radialSteps: 10,    // 填充盘的径向分段（边线只有内外两圈，用不到）
        // 采高度时取【邻域最大值】的探针距离（px）。地面网格是 24px 线性插值、
        // 而 heightAt 在台阶处是阶跃的：只取本点，台阶低侧那一圈会被插值出来的地面盖住，
        // 等于没修。取半格的邻域最大值 = 让圈在台阶边缘提前抬起来。
        probe: 12,
      },
    },
    // 塔的夜间照明（用户："塔可以照亮射程+50 的范围，像根火柴，从中心往外越暗"）。
    //
    // ⚠️ 单位坑（第一版就栽在这里，改前请读完）：Three.js r155 起 PointLight 的
    // intensity 是**坎德拉**，照度按 1/d^decay 衰减。第一版写的是
    // `intensity = 0.55 × 夜色 × (半径/250)` ≈ 0.66 —— 在 150px 处照度只有
    // 0.66/150² ≈ 3e-5，而场景方向光是 2.3。差了约 5 个数量级，画面上**完全看不见**，
    // 于是看起来像"这功能没做"。凡是给 PointLight 填强度，都必须把半径的 decay 次方乘回去。
    //
    // 现在的口径是反过来算：你填"在半径边缘还想剩多少照度"（edgeLux），
    // 代码用 intensity = edgeLux × 半径^decay 反推坎德拉。这样这几个数是可直接理解的。
    // 塔顶水晶与绕它公转的粒子（用户："水晶和粒子的旋转速度改为不同，那么看起来更好"）。
    // 单位是弧度/秒，正负号 = 转向。
    // ⚠️ 粒子是水晶 Mesh 的**子节点**，默认继承水晶的旋转 —— 不给它相对角速度的话
    // 两者严丝合缝一起转，看起来像焊死的。实现里给的是 (particleSpin − spin)，
    // 于是这里填的 particleSpin 就是粒子的【世界】转速，两个数各调各的互不影响。
    crystal: {
      spin: 0.6,           // 水晶本体（保持原值，改动前就是这个数）
      particleSpin: -0.42, // 粒子。反向 + 约 0.7 倍速 —— 反向比"同向但快一点"容易看出来得多
    },
    towerLight: {
      enabled: true,
      poolSize: 20,         // 真光源数量（恒定！数量一变全场材质重编译，见实现注释）
      rangeExtra: 50,       // 照明半径 = 射程 + 此值（用户定稿；不再是乘系数）
      // 下面三个数是**按夜间实拍逐档比出来的**（截图见提交信息），不是拍脑袋：
      //   edgeLux 0.16（上一版）→ 地面完全没被照亮，只有塔身微微发光 = 用户说的"照明太弱"
      //   edgeLux 1.6 / 灯高+10 → 地面亮了，但塔身过曝成一团白
      //   edgeLux 3.0 / 灯高+100 / decay 1.1（采用）→ 地形纹理清晰可见、塔身不过曝
      // 关键不在"调亮"，在**把灯抬高**：灯离塔身太近时，中心与边缘的照度比是
      // (斜距/灯高)^decay = 8.8 倍，塔脚必然先过曝；抬到 +100 后降到 3.2 倍，光池就平了。
      decay: 1.1,           // 衰减指数。2=物理正确但中心过曝/边缘断崖；越小光池越平
      edgeLux: 3.0,         // 【地面半径边缘】处的照度目标。调亮整体就调它（场景方向光约 2.3 可作参照）
      centerClampLux: 20,   // 中心照度上限，防射程特别大的塔中心糊成死白。当前配置下中心约 9.6，不触发
      nightOnly: true,      // false = 全天亮着（调试/截图用）
      lightInterval: 0.2,   // 重新挑塔的节流（秒）。每帧重排会让灯在两座塔之间跳
      fade: 0.35,           // 强度淡入淡出（秒）
      heightBias: 100,      // 灯高于炮口多少。太低塔身过曝、太高地面吃不到光（见上面的比值）
      colorBlue: '#bcd8ff', colorRed: '#ffc9bc', colorNeutral: '#ffe6b8',
      emissiveNight: 1.8,   // 夜间塔顶自发光强度（>1 才会被 Bloom 抓到，见 hdr 注释）
    },
    // 真 HDR 输出（用户点名要）。
    // 现有管线【内部本来就是 HDR】：EffectComposer 用 HalfFloatType 渲染目标 + ACES 色调映射。
    // 缺的是两件事：① 场景里没有任何东西超过 1.0（自发光只有 0.7），HDR 的余量完全没被用上；
    //              ② 最终输出仍被压回 SDR 的 [0,1]，HDR 显示器上看不到真正的高光。
    // 这里管的是 ②。①在 towerLight.emissiveNight 与 bloomThreshold 里。
    //
    // ⚠️ 诚实的边界：我无法验证 ②。这个环境是 headless、没有 HDR 显示器。
    // 所以采用【自动探测】：只有浏览器支持 configureHighDynamicRange
    // 且 matchMedia('(dynamic-range: high)') 报告显示器真的是 HDR 时才启用。
    // SDR 屏上自动保持关闭 → 不会把你现在的画面搞灰。手动开关在设置·画质里。
    hdr: {
      auto: true,           // 自动探测（支持 + 显示器是 HDR 才开）
      force: null,          // true/false 强制覆盖 auto（调试用）
      headroom: 2.0,        // 高光超出 SDR 白点的倍数。太大在 HDR 屏上会刺眼
      bloomThreshold: 1.0,  // Bloom 阈值。原 0.82 会把所有亮色都糊开（偏"脏"），
                            // 提到 1.0 只抓真正过曝的东西
    },
  },

  world: {
    couplings: {
      // 用户定稿的默认值：昼夜【默认开】，熵的三条【默认全关】（熵开发已暂停）。
      // 键名从 dayNightFaction 改为 dayNight —— 语义已从"按阵营"变成"按单位类别"，
      // 留着旧名字做新的事就是骗人。旧存档里的 dayNightFaction 会被忽略（不在白名单读取点）。
      dayNight: true,           // 昼夜 → 白天小兵占优 / 夜晚防御塔占优（双方对称）
      entropyToUnits: false,    // 熵 → 单位属性
      entropyToWeather: false,  // 熵 → 天气分布
      entropyToDayNight: false, // 熵 → 昼夜（熵越高夜晚越长）
    },
    // 昼夜加成（用户定稿：白天【小兵】占优、夜晚【防御塔】占优，双方对称）。
    // 这不再是先手优势，而是节奏开关：白天适合推，夜晚适合守。
    // 幅度刻意保守 —— 昼夜周期只有 6 分钟，给太多会让对局变成"等天亮"。
    dayNightBonus: {
      day:   { moveSpeedPct: 6, attackDamagePct: 5 },              // 小兵：推得更快、更能打
      night: { attackDamagePct: 8, attackRangeFlat: 15 },          // 防御塔：更疼、覆盖更远
    },
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
    // ==================== 走廊居中力（Q6：三路排队不一致）====================
    // 用户观察到"上路乖乖排队、中/下路散开"。量出来的原因不是阵营也不是随机，
    // 是**路点间距**：_advanceAlongLane 的期望方向是"指向当前路点"，所以横向偏移
    // 只在经过路点时才被顺带纠正。实测三路的段长：
    //   上路 10 段：2106,300,136,135,136,136,135,136,300,2116
    //   中路  1 段：4131                       ← 整条路只有一段
    //   下路 10 段：2137,300,136,135,136,136,135,136,300,2127
    // 中路只有一段，目标永远是那个远端点 —— 被塔挤到旁边多少像素，方向都不变，
    // 偏移**永远不会被纠正**，于是散开是永久的。上/下路走在中间那八段（135~300px）时，
    // 下一个路点很近，绕过塔之后立刻被拉回折线 → 恢复纵队；走在两头那两段 2100px
    // 直路上时和中路一样散。所以"哪一路乖"取决于**当前推到了哪一段**。
    // 回流场也帮不上：它要偏离中线 80~100px 以上才接管（源半径 50 + 最小步数），
    // 而绕塔的典型偏移是 30~70px，正好落在它管不到的窗口里。
    //
    // 修法：加一个显式的"朝兵线折线垂足"的力，权重随偏移量增长，不再指望路点密度。
    // deadZone 留一段不纠正的余量 —— 一路纠到零偏移会得到一条几何直线，
    // 既不自然，又会和分离力打架（一个往外推、一个往里拽，来回抖）。
    // 参数是**量出来的**，不是拍的。8 分钟真实对局采样"小兵离兵线折线多远"，
    // 取三路的中位/p90（单位 px，越小越像纵队）：
    //   关闭：      中位 top 9 / mid 21 / bot 11　三路 p90 极差 9　合计中位 13.3
    //   34/90/0.55：中位 9 / 20 / 11　　　　　　 极差 8　合计中位 13.2  ← 几乎没变
    //   12/60/0.70：中位 8 / 18 /  8　　　　　　 极差 13　合计中位 10.8
    //   8/45/0.90： 中位 7 / 15 /  7　　　　　　 极差 5　 合计中位 8.8   ← 采用
    // 第一版 deadZone 取 34 完全没效果：实测偏移的中位数只有 9~21px，
    // **整个差异都发生在死区以内**，力压根没机会启动。凭直觉设阈值就会这样，
    // 一定要先量分布再定死区。
    // 残留：中路中位仍是另两路的约 2 倍（15 vs 7），那是"整条路只有一段"的底子，
    // 只靠这个力压不平；要彻底一致得给中路加中间路点（改地图数据，本次没动）。
    // ==================== 走廊居中力 / 排队感（Q6：三路排队不一致）====================
    // 这几个数控制 LaneMovementSystem._steer 里那段"向走廊中心线回归"的力。
    // ⚠️ 它**不是新加的力**——那段力从 v39 就在（注释写着"排队感"），
    // 问题是权重上限只有 0.275（原式 min(0.5, dist/140) × 0.55），
    // 在典型的 20~50px 偏移处仅 0.08~0.20，压根压不住分离力。第一版我差点又写了
    // 第二份同样的力加在 _advanceAlongLane 里 —— 那就是本仓库反复出事的"抄第二份"。
    //
    // 参数是量出来的：8 分钟真实对局采样"小兵离兵线折线多远"（px，越小越像纵队）：
    //   （见 tests 与提交信息里的对照表；死区必须小于实测偏移中位数，否则力永远不启动）
    // 基地圈是否画出来（用户："基地圈可以不显示，但是要有效果（基地光环）"）。
    // ⚠️ 只管【画不画那个圈】。基地光环是玩法效果（towerPassives 的基地增益），
    // 走的是另一条路，与这个开关无关 —— 关掉圈不会影响任何数值。
    // 默认 false：地形改 navgrid 之后，那个平铺的圆和真实高地形状对不上，画出来只会误导。
    showBaseCircle: false,
    // 路点到达半径（px）。小兵一帧走 speed×dt ≈ 3.9px，到达圈必须比一帧大，
    // 否则"踩不中"——判据只剩"离下一个路点更近"，而那一条在急转弯处永远不成立
    // （它以两个路点的垂直平分线为界；84° 的弯里，沿来向越过路点后离下一个反而更远）。
    // 于是小兵绕着转角那个点无限打转：实测扭曲丛林基地口，一个兵 150 秒走了 11738px、
    // 净位移只有 465px。峡谷最大转角 16°，一直没暴露这条。
    // 24 ≈ 6 帧的位移，配合"必须已越过该路点"的前提，既踩得中又不会提前抄内角。
    waypointArriveRadius: 24,
    laneCentering: {
      enabled: true,
      // 参数是量出来的。8 分钟真实对局，采样"每个小兵离本路兵线折线多远"（px）：
      //                        三路中位        三路 p90     中位极差  合计中位  兵墙测试
      //   完全关闭：          17 / 46 / 28   57 / 78 / 80     29      29.0     6/6
      //   0.275/70（= v39）：  9 / 21 / 11   52 / 61 / 57     12      13.3     6/6
      //   0.500/40（采用）：   6 / 16 /  7   52 / 70 / 54     10       9.4     6/6
      //   0.700/40：          12 / 15 / 10   51 / 52 / 52      4      12.6     5/6 ✗
      //   0.900/30：           6 / 12 /  6   47 / 56 / 48      6       6.4     5/6 ✗
      // 关闭那一行就是用户看到的现象：中路中位 46px 是上路的 2.7 倍 —— "上路乖乖排队、
      // 另两路散开"确实存在，而且不是随机也不是阵营，是路点几何（见上面的段长）。
      //
      // 为什么不取"中位极差最小"的 0.7/40：它让 tests/sim_wall.mjs 的
      // "近战全部越过兵墙"从 6/6 掉到 5/6。那个用例是把关，不该为了另一项指标好看就放它过。
      // 顺带一个观察：兵墙用例在 5/6 与 6/6 之间**随参数微调来回跳**、且不单调
      //（0.275/70 过、0.275/40 不过、0.5/40 过、0.55/40 不过），说明它是个刀尖上的用例。
      // 所以选参数的标准是"在它通过的那些档里挑最好的"，而不是调到它刚好通过 ——
      // 后者等于在拟合噪声。
      //
      // 残留：中路中位仍是另两路的 2 倍多（16 vs 6/7）。那是"整条路只有一段"的底子，
      // 靠这个力压不平；要彻底一致得给中路加中间路点（改地图数据，本次没动）。
      deadZone: 6,      // 偏移小于此值不纠正（v39 原值）
      rampTo: 40,       // 偏移到这么多时达到满权重（v39 是 70）
      weight: 0.5,      // 满权重（相对期望力 1.0；v39 是 0.275，压不住分离力）
    },
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
