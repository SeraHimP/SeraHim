import { FACTIONS } from '../../systems/FactionSystem.js';
import { SR_PITS } from './sr_navgrid.js';

/**
 * summoners_rift.js
 * 召唤师峡谷复刻（上/中/下三路，野区暂缺）。
 *
 * ==================== 坐标来源与定标 ====================
 * 不再用几何规则凭空生成——直接采用真实 LoL 地图（14800×14800 游戏内坐标系）的
 * 防御塔/水晶/枢纽坐标，按 SCALE = 180/750 = 0.24 缩放（塔射程 180 : 真实塔射程 750
 * 严格等比），y 轴翻转适配画布坐标系（LoL 原点在左下、画布 y 向下）。
 * 世界尺寸 WORLD = 14800 × 0.24 = 3552。
 *
 * 红方全部坐标 = 蓝方坐标绕地图中心 180° 旋转（真实峡谷即中心对称，非镜像对称），
 * 旋转后上下路互换（蓝方下路旋转过去就是红方上路）。
 *
 * ==================== 兵线路径设计（直线版）====================
 * 索敌重构（仇恨半径 200、允许脱轨追击）后路径只是行军参考线，不再需要
 * 逐建筑压线。因此改为简洁直线：中路 = 纯对角线（4 点）；上/下路 = 直线主体 +
 * 左上/右下角 520 半径圆弧倒角（13 点）。竖直/水平段位置按己方四塔坐标拟合
 * （x≈290 / y≈300）。脚本验证：全部建筑到所属路径 ≤117px（索敌半径 200 内，
 * 塔射程 180 也覆盖路过兵线），枢纽双塔仍在上/下路径上。
 * 例外：枢纽双塔只在上/下路的末段路径上（各守一座），中路从两塔正中间穿过。
 * （历史注：曾因索敌半径=攻击射程导致中路近战兵打不到枢纽塔；LaneMovementSystem
 * 重构后索敌半径固定 200、允许脱轨追击，该限制已不存在，建筑也不再必须严格压线。）
 *
 * 路点数量与性能无关：LaneMovementSystem 每帧每个小兵只检查当前一个路点，O(1)。
 *
 * ==================== 验证记录（脚本自动核对）====================
 * - 全部路点在 [0, 3552] 界内；相邻路点最小间距 134px（远大于 4px 的到达判定阈值）。
 * - 全部 24 座分路建筑到所属路径的偏差 < 1px。
 * - 4 座枢纽塔到最近路径距离 = 0px（在射程 180 内）。
 * - 下路 = rot(上路) 逐点核对通过（中心对称）。
 */

// 三路的出兵流完全一样（蓝方 forward 打红方、红方 reverse 打蓝方），抽成常量避免三份重复。
// 见 FactionSystem.laneSpawnsOf 的头注——这就是它未声明时的兜底值，写出来是当模板。
const LANE_SPAWNS_2F = [
  { faction: FACTIONS.BLUE, direction: 'forward', targetFactions: [FACTIONS.RED] },
  { faction: FACTIONS.RED, direction: 'reverse', targetFactions: [FACTIONS.BLUE] },
];

export const WORLD_SIZE = 3552;

export const summoners_rift = {
  id: 'summoners_rift_v1',
  label: '召唤师峡谷',
  world: { w: WORLD_SIZE, h: WORLD_SIZE },
  // 多阵营地基（docs/REPORT-2026-09-03-multifaction.md §3）：地图声明支持哪些阵营，
  // 对局中固定不变。这张图只有蓝红两阵营，显式写出来是给以后的 N 阵营地图当模板——
  // 不写也不影响现有行为（FactionSystem.mapFactionsOf 未声明时兜底就是这两个）。
  factions: [FACTIONS.BLUE, FACTIONS.RED],

  // === Building tier stats (classic defaults, self-contained) ===
  // v51.6：用户定稿属性修正——"外塔HP5000，双抗40。内塔HP4000，双抗70。水晶塔HP3500，
  // 双抗55。"（"水晶塔"= tier:'base'，见 FactionSystem.js 的既定口径："水晶塔（高地塔，
  // tier='base'）"、"外塔→内塔→水晶塔→召唤水晶"分路链，两处都明确把水晶塔钉在 base 这一档，
  // 不是 nexus_main/hq_tower 那几档）。三档改动：
  //   outer：4000→5000（双抗40不变，本来就是40）
  //   inner：3500→4000，双抗 55→70
  //   base（水晶塔）：3300→3500，双抗 70→55
  // v51.18：简单的平衡性调整（用户定稿，跳过测试）——
  //   外塔：maxHP 5000→3300，双抗 40→15（开局更脆，靠下面新增的 tierEffects
  //         临时状态补前期）
  //   内塔：maxHP 4000→3750
  //   高地塔（base）：maxHP 3500→4000，攻速 2.5→4.0
  //   枢纽塔（hq_tower）：+7 格挡（damageBlock，直接进默认属性，见下方那一行）
  tierStats: {
    outer:      { maxHP: 3300, shieldFixedMax: 0, healthRegen: 0, armor: 15, magicResist: 15, attackDamage: 152, baseAttackSpeed: 0.833 },
    inner:      { maxHP: 3750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    base:       { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 55, magicResist: 55, attackDamage: 170, baseAttackSpeed: 4.00 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 110, attackDamage: 150, baseAttackSpeed: 4.00, damageBlock: 7 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 用户定稿（Q4 修正版）："内塔+800护盾，+50固定护盾。给周围友军单位+50护盾。"
  // 内塔已经默认装 passive_inner_bulwark（钢铁烈阳护盾，见 towerPassives.js），
  // 不需要另开一条新技能/新属性——走既有的"地图级技能参数覆写"通道（skillParams.js）
  // 把这张图上内塔那份的 selfPlainValue/selfFixedValue 改成 800/50；分享给友军的
  // allyPlainValue 留着出厂默认 50 不动。全局默认（其它地图/编辑器新建的内塔）不受影响。
  //
  // 外塔开局限时护甲/魔抗（原来叫"前期城防"）：v51.18 配合外塔双抗砍到15的改动，
  // 加了这条开局前10分钟+25/+25 的补偿，让前期双抗等效40（与改动前持平），到期后
  // 回落到砍过的15。v51.26 用户定稿把它从"地图级默认状态（tierEffects，跟塔有没有
  // 装技能无关，无条件糊上）"收进 passive_outer_fortify 技能本身——"前期城防整个到
  // 技能（加固城防）里面，不再默认装配在地图上，只有加固城防的技能的塔才会有这个
  // 开局加成"。数值走跟内塔护盾同一套 defaultParams 覆写通道（见 towerPassives.js
  // 的 _makeFortify/_fortifyRecalc），出厂默认是 0（不生效），这里覆写成 25/600
  // 才让召唤师峡谷的外塔真的拿到——其它地图的外塔维持出厂默认，不受影响。
  skillOverrides: {
    'tower:inner': { passive_inner_bulwark: { selfPlainValue: 800, selfFixedValue: 50 } },
    'tower:outer': { passive_outer_fortify: { earlyDefenseBonus: 25, earlyDefenseDuration: 600 } },
  },

  // === Wave timing (classic defaults) ===
  waveInterval: 30,
  firstWaveDelay: 30,
  spawnGap: 0.55,

  // === System rules ===
  nexusRespawnTime: 300,

  // v34/v35（Q4）：地图墙壁（走廊模型，参照 LoL 小地图）。
  // 可行走区域 = 三路走廊（兵线折线 ± corridorHalfWidth）∪ 双方基地高地区（基地圈）。
  // 半宽 95 → 130（v35 用户定稿）：LoL 路面约占图宽 6.4%，旧 190/3552=5.3% 偏窄且硬墙缘
  // 无草地过渡视觉更细；260/3552≈7.3% 对齐。塔射程 180 仍 > 半宽 → 高地口卡位保留。
  walls: { corridorHalfWidth: 130 },

  // v34（Q1）：基地圈半径改为显式声明的固定值（原为"由高地建筑位置反推"——
  // 但高地塔现在要按"距入口180px"摆放，位置依赖圈、圈又依赖位置，形成循环。
  // 定死半径后：入口位置固定，高地塔=入口沿走廊内推180，射程外沿恰好卡在入口）。
  // 数值取切换前的计算值（1274.7 取整），视觉零变化。
  baseCircleRadius: 1185, // v39（Q1）：基地光环圈半径改为与高地地形半径(baseOpenRadius)一致——所见即所得（视觉+光环效果同步）
  // v36（Q6）：入口收束段（entrance funnel）——旧实现里 baseCircleRadius 圆内一律
  // 全开放（无墙），导致高地塔（距入口180，仍在圆内 1100+ 处）周围完全没有可见墙壁，
  // 射程圈只能在入口那一个切点"擦"到走廊墙，看不出"贴墙"的封锁感（用户画图指出的问题）。
  // 现在圆内再分两层：baseOpenRadius 以内才是完全开放的老家（水晶/枢纽正常自由走动），
  // baseOpenRadius ~ baseCircleRadius 这一圈保持【走廊宽度】（可行走区仍是 hw 内），
  // 视觉上画出真实的两侧墙壁——高地塔（距入口180，落在此收束段内）射程圈因此会
  // 实际穿过两侧墙壁，形成入口被封锁的观感。半径按"塔在收束段内、水晶在开放区内"
  // 各留约 50px 余量选取（塔径向距角 1102，水晶 997 → 取 1050）。
  // v38（用户第三次修正，方向定稿）：960→1230。
  // v37 做反了：把 openRadius 缩到 960 等于用墙夹着高地塔、把塔关进走廊里。
  // 正确语义（对齐 LoL 召唤师峡谷 + 用户原话"高地塔应该在高地范围里"）：
  //   高地 = 一整片开放区，三路走廊在高地边缘开口，高地塔站在开口【内侧】的高地上，
  //   射程覆盖整个开口 → "封锁入口"。
  // 取值依据：用户认可的"光环圈"= baseCircleRadius = 1275（渲染层半透明扇形填充与
  //   基地光环共用同一半径），墙以它为准"略微往里缩"→ 1275-45 = 1230。
  // 自洽：塔距角 1103 < 1230（塔在高地内 ✔）；1230 < 1103+180=1283（墙开口落在塔射程圈内，
  //   射程盖住入口约 53px ✔）。红蓝共用同一参数，四路天然对称。
  // v38.1（用户第四次修正）：1230→1185。用户圈出上/下路"外侧墙角"仍在塔射程圈外。
  // 定量根因：上/下路走廊【不是径向】的（走廊方向与"角点→塔"方向有夹角），高地圆斜切走廊，
  // 两侧墙角到塔的距离差很大：R=1230 时 上路 159/206、中路 183/181、下路 207/157——
  // 六个墙角有四个超出射程 180 → 入口两侧留缺口。R=1185 时六角为 137/173/155/154/175/137，
  // 全部落进射程并留几 px 交叠 → 三路入口两侧墙角都被射程"咬住"。塔位置未动。
  baseOpenRadius: 1185,

  // 守着基地开口的是哪一档塔（测试按这个字段找"高地塔"）。峡谷是水晶塔。
  // 之所以要显式声明：嚎哭深渊重做后把口的换成了枢纽塔，写死 'base' 会验错对象。
  gateTier: 'base',

  // C 组·台阶地形（用户 Q1）：高地平台抬升 + 明显陡台阶，边缘外扩到画线处（纯渲染，仿真不读）。
  // plateauFull/Edge 是 baseOpenRadius(1185) 的比例：满高核心到 0.97(≈1149)，陡降到 0 在 1.055(≈1250，红线处)；
  // 抬升高度 40（原默认 20，更"明显"）。窄坡宽(≈100)＝台阶感；河床沿用默认。
  heightZones: { plateauHeight: 40, plateauFull: 0.97, plateauEdge: 1.055 },

  // 真实峡谷地形（navgrid）：可行走区改由 src/data/maps/sr_navgrid.js 的位图判定
  // （自 assets/maps/preview.jpg 导航图描出）——野区可走、野区墙体成形、河道连通，
  // 并带龙坑/男爵坑。置 false 可退回旧的"三路走廊"模型。
  useNavgrid: true,
  // v45：只有这张图有龙（用户定稿："只有在召唤师峡谷中才有龙的生成！其他地图没有！"）。
  // 与下面的 pits 同一个口径：**地图自己声明自己有什么**，引擎不按 id 猜。
  // 嚎哭深渊 / 扭曲丛林不写这一项 → DragonSystem.mapAllowsDragon() 为 false，不自动刷龙。
  dragon: { enabled: true },
  // v44：龙坑归**地图**所有，不再由 MapSystem 按 useNavgrid 一律发 SR 的坑。
  // 原实现是 `getPit = useNavgrid ? SR_PITS : null` —— 于是嚎哭深渊和扭曲丛林
  // 这两张同样用 navgrid 的图，也被挖了召唤师峡谷的两个坑（坐标在那两张图上毫无意义）。
  // 之前没被发现，只是因为旧坑位恰好落在没人采样的地方；v44 把坑挪到河段重心之后，
  // 嚎哭深渊的"全图零高差"断言当场就红了。
  pits: SR_PITS,

  // 兵线路点（Q1 拉直）：枢纽端原有贴着枢纽塔的中转点导致参考线/行军在枢纽处折一下，
  // 已删除，枢纽 → 主线为纯直线（中路即枢纽对枢纽两点直线）。
  lanes: [
    {
      id: 'top',
      waypoints: [
        { x: 305, y: 3226 },
        { x: 290, y: 1120 },
        { x: 290, y: 820 },
        { x: 308, y: 685 },
        { x: 360, y: 560 },
        { x: 442, y: 452 },
        { x: 550, y: 370 },
        { x: 675, y: 318 },
        { x: 810, y: 300 },
        { x: 1110, y: 300 },
        { x: 3226, y: 305 },
      ],
      spawns: LANE_SPAWNS_2F,
    },
    {
      id: 'mid',
      waypoints: [
        { x: 305, y: 3226 },
        { x: 3226, y: 305 },
      ],
      spawns: LANE_SPAWNS_2F,
    },
    {
      id: 'bot',
      waypoints: [
        { x: 305, y: 3226 },
        { x: 2442, y: 3252 },
        { x: 2742, y: 3252 },
        { x: 2877, y: 3234 },
        { x: 3002, y: 3182 },
        { x: 3110, y: 3100 },
        { x: 3192, y: 2992 },
        { x: 3244, y: 2867 },
        { x: 3262, y: 2732 },
        { x: 3262, y: 2432 },
        { x: 3226, y: 305 },
      ],
      spawns: LANE_SPAWNS_2F,
    },
  ],

  buildings: [
    // ========== 蓝方（左下基地） ==========
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'top', pos: { x: 235, y: 1046 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'inner',      laneId: 'top', pos: { x: 363, y: 1944 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'top', pos: { x: 300, y: 2492 }, weapon: 'lightning' },  // v34 Q1：距高地入口精确180（射程外沿=入口）
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'top', pos: { x: 301, y: 2602 }, weapon: null },  // 距水晶塔 110（贴其后方）

    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: { x: 1403, y: 2017 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'inner',      laneId: 'mid', pos: { x: 1212, y: 2397 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: { x: 764, y: 2767 }, weapon: 'lightning' },  // v34 Q1：距高地入口精确180
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: { x: 686, y: 2845 }, weapon: null },  // 距水晶塔 110

    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'bot', pos: { x: 2521, y: 3305 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'inner',      laneId: 'bot', pos: { x: 1661, y: 3196 }, weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'bot', pos: { x: 1056, y: 3235 }, weapon: 'lightning' },  // v34 Q1：距高地入口精确180
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'bot', pos: { x: 946, y: 3234 }, weapon: null },  // 距水晶塔 110

    // 枢纽双塔 + 水晶枢纽
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: null,  pos: { x: 349, y: 3107 }, weapon: 'lightning' },  // v34 Q1：×0.82收角（用户：往里调一些）
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: null,  pos: { x: 427, y: 3191 }, weapon: 'lightning' },  // 双塔间距≈115 < 射程180（贴打一塔另一塔够得着）
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: null,  pos: { x: 305, y: 3226 }, weapon: null },  // v34 Q1：收角

    // ========== 红方（右上基地，蓝方坐标 180° 旋转） ==========
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'top', pos: { x: 1031, y: 247 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'inner',      laneId: 'top', pos: { x: 1891, y: 356 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'top', pos: { x: 2492, y: 300 }, weapon: 'lightning' },  // v34 Q1：蓝方转置
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'top', pos: { x: 2602, y: 301 }, weapon: null },  // 距水晶塔 110（贴其后方）

    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: { x: 2149, y: 1535 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'inner',      laneId: 'mid', pos: { x: 2340, y: 1155 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: { x: 2767, y: 764 }, weapon: 'lightning' },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: { x: 2845, y: 686 }, weapon: null },  // 距水晶塔 110

    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'bot', pos: { x: 3317, y: 2506 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'inner',      laneId: 'bot', pos: { x: 3189, y: 1608 }, weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'bot', pos: { x: 3235, y: 1056 }, weapon: 'lightning' },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'bot', pos: { x: 3234, y: 946 }, weapon: null },  // 距水晶塔 110

    // 枢纽双塔 + 水晶枢纽
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: null,  pos: { x: 3107, y: 349 }, weapon: 'lightning' },  // v34 Q1：×0.82收角
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: null,  pos: { x: 3191, y: 427 }, weapon: 'lightning' },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: null,  pos: { x: 3226, y: 305 }, weapon: null },  // v34 Q1：收角

  ],
};