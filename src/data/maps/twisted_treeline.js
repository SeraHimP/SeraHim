import { FACTIONS } from '../../systems/FactionSystem.js';

/**
 * twisted_treeline.js —— 扭曲丛林（双路）
 *
 * 参考图：assets/maps/Twisted_Treeline_Minimap.webp（小地图，主依据）
 *        assets/maps/Twisted_Treeline_Map_Preview.jpg（俯视预览）
 *
 * 形状是**花生 / 沙漏**：两端各一个圆形基地"叶"，两条路贴着叶子的外缘绕出去，
 * 到地图中间【收窄】会合；中间是野区。蓝方在左、红方在右（图上是紫方，本项目统一叫红方）。
 *
 * ⚠️ 第一版我把形状做反了：写成了"从基地鼓出、中间最宽"的柳叶眼形。
 * 小地图上量得清清楚楚 —— 兵线到中轴的距离在基地端是 123px、在腰部只有 73px，
 * 也就是**两端宽、中间窄**。反过来做，整张图的推进节奏就全错了：
 * 中间本该是狭窄的遭遇战区，做成了最开阔的地方。
 *
 * 塔位（用户确认的编制）：**每路 2 塔 + 每路 1 召唤水晶 + 1 枢纽塔 + 水晶枢纽**
 *   每方 5 座会攻击的建筑：上/下路各外塔+水晶塔，基地前 1 座枢纽塔。
 *
 * ⚠️ 坐标是**量出来+算出来的，不是手填的**（换算过程见本文件末尾）。
 * 手填 xy 的坏处是"塔离兵线多远、相邻塔间距多少"全靠肉眼 ——
 * 旧的 midlane_v1 就是用几何规则算错、双方外塔越过中线互换了半区，肉眼完全看不出来。
 */

// 兵线折线。上路 y<700、下路 y>700，两条都从蓝枢纽走到红枢纽。
// 中间的路点是从小地图逐列量出来的兵线中心线（每 32 图像 px 一个采样点）。
const LANE_TOP = [
  { x: 500, y: 700 },                                          // 蓝方水晶枢纽
  { x: 510, y: 166 }, { x: 649, y: 153 }, { x: 788, y: 170 },  // 绕过蓝方基地叶的外缘
  { x: 927, y: 231 }, { x: 1066, y: 274 }, { x: 1205, y: 314 },
  { x: 1344, y: 366 }, { x: 1500, y: 383 },                    // 腰部（最靠近中轴处）
  { x: 1656, y: 366 }, { x: 1795, y: 314 }, { x: 1934, y: 274 },
  { x: 2073, y: 231 }, { x: 2212, y: 170 }, { x: 2351, y: 153 }, { x: 2490, y: 166 },
  { x: 2500, y: 700 },                                         // 红方水晶枢纽
];
const LANE_BOT = LANE_TOP.map(p => ({ x: p.x, y: 1400 - p.y }));   // 上下镜像

// 蓝方塔位：沿上路弧长 560 / 760 / 1150 处取点（下路 = 上下镜像，红方 = 左右镜像）。
// 用户指定：以左侧蓝方为例，**水晶枢纽在右、枢纽塔在左**（枢纽塔在枢纽后方，不是前方）。
// 我第一版按"塔总在枢纽前面挡着"的惯例摆反了。两者间距仍取 170 < 射程 180，塔护得住枢纽。
// 兵线端点 / 出兵点仍在基地圈心 (500,700)，位于两者之间，出兵不会压在建筑上。
const B = {
  hq_tower:   { x: 480, y: 700 },   // 左（基地深处）
  nexus_main: { x: 650, y: 700 },   // 右（朝向敌方），离枢纽塔 170 < 射程 180
  // 每路 2 塔 = 外塔 + 水晶塔（用户在数值表里点名的是"水晶塔"，即 base 档，不是内塔）
  top: { nexus_lane: { x: 536, y: 164 }, base: { x: 735, y: 163 }, outer: { x: 1103, y: 285 } },
};
B.bot = Object.fromEntries(Object.entries(B.top).map(([k, p]) => [k, { x: p.x, y: 1400 - p.y }]));
const M = (p) => ({ x: 3000 - p.x, y: p.y });   // 左右镜像（不是 180° 旋转 —— 本图是左右对称，不是中心对称）

export const twisted_treeline = {
  id: 'twisted_treeline_v1',
  label: '扭曲丛林',
  // 长宽比 3000:1400 ≈ 2.14，与小地图上可行走区的 680:319 一致。
  // （第一版用的 3000×2000 太"方"了，整张图看着不像扭曲丛林。）
  world: { w: 3000, h: 1400 },

  // === 波次节奏 ===
  // 比峡谷快一档：地图小、只有两条路，节奏本该更紧凑。
  waveInterval: 35,
  firstWaveDelay: 25,
  spawnGap: 0.55,
  nexusRespawnTime: 240,   // 比峡谷的 300 短：图小，被压制的一方需要更快的翻盘窗口

  // 走廊模型（不用 navgrid —— 那是峡谷描图专用，本图用规则走廊即可）：
  // 可行走 = 两条兵线走廊 ∪ 双方基地圈。中间"野区"在本引擎里就是走廊之间的空隙，
  // 小兵不会主动穿野区（走廊外不可走），符合参考图里两条路各走各的的观感。
  // 半宽 150：腰部两条走廊之间还留 334px 野区（1400−2×383−2×150），不会连成一片。
  walls: { corridorHalfWidth: 150, river: false },
  // ⚠️ 基地圈的圆心默认取【世界角点】（蓝=左下、红=右上）—— 那是峡谷/深渊的巧合。
  // 本图的基地在左右两侧的【中点】，不声明的话基地圈会被甩到 (0,1400) 的空地上：
  // 光环画在没建筑的地方、+20 的高地地形长在空地上、可行走区凭空多出两块无用扇形，
  // 而基地自己反倒没有开阔地。画面上不报错，只是看着莫名其妙。见 src/data/baseCircle.js。
  baseCenters: { blue: { x: 500, y: 700 }, red: { x: 2500, y: 700 } },
  baseCircleRadius: 330,
  baseOpenRadius: 330,
  // 本图**不声明** gateTier：它没有"单一入口被一座塔封锁"的高地形态。
  // 两条路在基地口就分岔了，而用户定的编制是每方只有 1 座枢纽塔，它到任一入口都 > 射程 180——
  // 硬要它同时封两个口只能加塔，那就改了用户定的编制。所以这条几何契约在本图不适用，
  // 而不是"没做到"。它守的是水晶枢纽本身（距枢纽 170 < 180）。

  // 本图专属建筑数值（用户指定）。血薄、双抗厚（100/100）、越靠里攻速越快。
  //   外塔  HP1750 双抗100 攻速0.833 回复0
  //   水晶塔 HP2250 双抗100 攻速1.25  回复0
  //   枢纽塔 HP3750 双抗100 攻速2.50  回复10
  //   召唤水晶 HP4000 护甲20 魔抗0 回复10 ／ 水晶枢纽 HP5500 双抗0 回复10（与嚎哭深渊共用）
  //
  // ⚠️ attackDamage 用户没给。按"参考召唤师峡谷的攻击力成长"取峡谷同档的**起步攻击力**
  // （外塔152 / 水晶塔170 / 枢纽塔150）—— 峡谷的 tierStats.attackDamage 与成长技能的
  // startAD 本来就是同一个数，照搬过来成长曲线才对得上。要改就改这三个数。
  tierStats: {
    outer:      { maxHP: 1750, shieldFixedMax: 0, healthRegen: 0,  armor: 100, magicResist: 100, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0,  armor: 100, magicResist: 100, attackDamage: 170, baseAttackSpeed: 1.25 },
    hq_tower:   { maxHP: 3750, shieldFixedMax: 0, healthRegen: 10, armor: 100, magicResist: 100, attackDamage: 150, baseAttackSpeed: 2.50 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 10, armor: 20,  magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 10, armor: 0,   magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 成长：**只有攻击力成长，且从开局起算**（用户指定）。
  // 直接复用峡谷那三个成长技能（每分钟 +9，档位上限也照搬），只把起算时间覆写成 0——
  // 它们本来就只长攻击力（armorPerStep=0、无 resistGrowthStartT），不用另造技能。
  // 这正是 skillOverrides / inst._params 那套地图级覆写的用途，见 docs/DEVELOPMENT.md §4。
  skillOverrides: {
    'tower:outer':    { passive_growth_outer: { adStartT: 0 } },
    'tower:base':     { passive_growth_base:  { adStartT: 0 } },
    'tower:hq_tower': { passive_growth_hq:    { adStartT: 0 } },
  },

  lanes: [
    { id: 'top', waypoints: LANE_TOP },
    { id: 'bot', waypoints: LANE_BOT },
  ],

  buildings: [
    // ========== 蓝方（左） ==========
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'top', pos: B.top.outer,      weapon: 'piercing', skills: ['passive_growth_outer'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'top', pos: B.top.base,       weapon: 'piercing', skills: ['passive_growth_base'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'top', pos: B.top.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'bot', pos: B.bot.outer,      weapon: 'piercing', skills: ['passive_growth_outer'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'bot', pos: B.bot.base,       weapon: 'piercing', skills: ['passive_growth_base'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'bot', pos: B.bot.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: null,  pos: B.hq_tower,       weapon: 'piercing', skills: ['passive_growth_hq'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: null,  pos: B.nexus_main,     weapon: null },
    // ========== 红方（右，左右镜像） ==========
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'top', pos: M(B.top.outer),      weapon: 'piercing', skills: ['passive_growth_outer'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'top', pos: M(B.top.base),       weapon: 'piercing', skills: ['passive_growth_base'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'top', pos: M(B.top.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'bot', pos: M(B.bot.outer),      weapon: 'piercing', skills: ['passive_growth_outer'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'bot', pos: M(B.bot.base),       weapon: 'piercing', skills: ['passive_growth_base'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'bot', pos: M(B.bot.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: null,  pos: M(B.hq_tower),       weapon: 'piercing', skills: ['passive_growth_hq'] },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: null,  pos: M(B.nexus_main),     weapon: null },
  ],
};

/*
 * 坐标是怎么来的（改图时照这个改，别手动挪 xy）：
 *
 * ① 从 assets/maps/Twisted_Treeline_Minimap.webp（752×752）逐列采样"浅色路面"像素，
 *    取每列上/下两条兵线的中心 y，再取二者到中轴 y=402 的**平均**距离 off，强制上下对称。
 *    量到的 off（图像 px）：x=148→123、180→126、212→122、244→108、
 *                           276→98、308→89、340→77、372→73
 *    → 两端 123、腰部 73：**两端宽、中间窄的花生形**，不是柳叶眼形。
 *
 * ② 换算：蓝/红水晶枢纽在图上是 (145.7,402) / (606.3,402)，间距 460.6px，
 *    定为世界坐标 (500,700) / (2500,700)，间距 2000 → 比例 k = 2000/460.6 = 4.342 世界/图像。
 *      world_x = 500 + (img_x − 145.7) × k
 *      world_y = 700 − off × k
 *    可行走区在图上是 680×319，×k ≈ 2953×1385 → 世界取 3000×1400。
 *
 * ③ 塔按【沿兵线的弧长】取点（单条兵线全长 3122）：
 *      召唤水晶 d=560、水晶塔 d=760、外塔 d=1150
 *    校验（tests/sim_maps.mjs 会重跑这几条）：
 *      · 水晶塔→外塔 实距 388 > 2×射程(360) → 两塔射程圈不重叠（本项目一贯要求）
 *      · 双方外塔沿线净空 3122 − 2×1150 = 822 > 400 → 中间有真正的拉扯空间
 *      · 三座塔到本路兵线的垂距 < 0.5px（就在线上），远小于走廊半宽 150
 *      · 召唤水晶离基地圈心 537 > 基地圈 330 → 抑制器在路上，不在基地里
 *      · 枢纽塔离水晶枢纽 170 < 射程 180 → 真的护得住枢纽
 */
