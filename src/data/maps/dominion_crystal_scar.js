import { FACTIONS } from '../../systems/FactionSystem.js';
import { packBits, paintPolyline, paintCircle } from '../navgrid.js';
import { composeMap } from '../mapComposition.js';

/**
 * dominion_crystal_scar.js —— 统治战场·水晶之痕（Dominion / Crystal Scar 复刻）
 *
 * 设计依据：docs/DOMINION-CRYSTAL-SCAR-DESIGN.md。用户定稿"照抄原版规模和据点
 * 名字，先出设计文档"，随后又定稿"直接做水晶之痕地图，为黄沙风格得地图"。
 * 占领/动态出兵/水晶掉血这些**行为**全部在 DominionSystem.js 里实现——本文件
 * 只是纯地形 + 建筑数据，不包含任何行为逻辑（跟 howling_abyss.js 等老地图的
 * 分工一致：地图文件只回答"这张图长什么样"）。
 *
 * ==================== 拓扑：7 节点环形（5 据点 + 2 基地）====================
 * 原版是一张圆形地图，5 个据点沿圆周分布：风车(Windmill)在正上方、离两个基地
 * 都最远；精炼厂(Refinery)/采石场(Quarry) 对称分列风车两侧；兽骨场(Boneyard)/
 * 钻机(Drill) 紧邻两个基地。这里把两个基地也当成环上的节点，7 个节点等角度
 * （360°/7 ≈ 51.43°）分布在同一个圆上。
 *
 * 环上顺序（按角度递增，风车=0°为环的"正上方"）：
 *   兽骨场(-154.3°) → 蓝方基地(-102.9°) → 精炼厂(-51.4°) → 风车(0°)
 *   → 采石场(+51.4°) → 红方基地(+102.9°) → 钻机(+154.3°) → (绕回兽骨场)
 *
 * ==================== 2026-09-26 返工：整环一条闭合兵线，不是 7 段各自独立 ====================
 * 用户看了第一版截图后否掉了"7 条独立短边、出兵只走一跳就停"的设计："整个兵线
 * 应该是环形游走的（逆时针或顺时针），而不是在某处停下……应该是个完整的圆。"
 *
 * 现在把 7 段边按环上顺序首尾相接、去掉重复的共享端点，拼成【一条闭合的环形
 * 兵线】（首尾都在兽骨场，形成一个真正的圆）。据点/基地出兵时只需要在这一条
 * 共享兵线上声明"顺时针"或"逆时针"，不用再各自记一条邻边 id——
 * LaneMovementSystem 的 pure-pursuit 推进（projectOntoPolyline + 前瞻）本来就是
 * "先把当前位置投影到折线最近点，再沿声明方向走"，不关心小兵是不是从折线的
 * 端点出发，所以小兵在环上任意一个节点位置汇入这条共享兵线、一路走到折线
 * 首尾相接处（约等于绕完整个环）完全不需要改动那套系统——这也是选"首尾相接
 * 成一个圈"而不是"7 段各自独立"的原因：一条足够长的折线本身就能让"走完自己
 * 出发点之外的几乎一整圈"这件事自然发生，不需要真正的"折线成环、走到头绕回
 * 开头"这种额外支持。
 *
 * ==================== 出兵为什么不给 lane 挂 spawns ====================
 * 唯一这一条环形兵线把 `spawns` 显式声明成空数组。原因：FactionSystem.
 * laneSpawnsOf() 对没声明 spawns 的 lane 会兜底成"蓝方 forward / 红方 reverse"
 * 各一条——那是给"一条路直连两个基地"的传统地图设计准备的默认值，套在"环上
 * 一条所有据点共用的兵线"上完全不对（出兵节奏由 CONFIG.dominion 驱动的
 * DominionSystem._tickWaves 单独控制）。显式给空数组，laneWaveSystem 扫描这条
 * 兵线时会因为没有出兵流而什么也不做。
 *
 * ==================== navgrid：程序化生成的环形走廊 ====================
 * 跟嚎哭深渊/召唤师峡谷冰封版一样用 navgrid（逐格可走位图），但那两张图是
 * 从小地图美术图逐像素描出来的，这张图没有美术图可描——直接用 paintPolyline
 * 沿环形兵线的路点画一条固定半宽的环形走廊，再在每个节点上叠一个更大的圆形
 * 空地（据点/基地周围留出建筑摆放和战斗空间，跟 howling_abyss.js 桥两端变宽
 * 的处理思路一致）。
 *
 * ==================== 画面：黄沙风格 ====================
 * 用户定稿"为黄沙风格得地图"——新增 CONFIG.stylizedPalettes.desert（见
 * Config.js 头注），vegetationMode:'none'（沙漠据点，不长树），走
 * visualStyle:'stylized' 分支（与 frost/magicForest 同一条渲染路径）。
 *
 * ==================== 世界尺寸怎么定 ====================
 * 设计文档 §5.4：按小兵真实移速 78/s 反推"绕一整圈该花多久"，落在 2000~2400
 * 世界单位见方的区间——这里取 2200×2200，环半径 780（含节点变宽区后离世界边缘
 * 还留 ~90px 边距，不会画到地图外面）。
 */

const WORLD = { w: 2200, h: 2200 };
const CENTER = { x: WORLD.w / 2, y: WORLD.h / 2 };
const RING_R = 780;          // 环半径（节点都落在这个圆上）
const CORRIDOR_HALF = 140;   // 环形走廊半宽（世界单位）
const NODE_BULGE = 230;      // 节点周围额外撑开的圆形空地半径（供塔位/混战用）
const NAV_N = 256;           // navgrid 分辨率，与三张内置图一致

const N = 7;
const STEP = 360 / N;          // ≈51.428571°
const START = -3 * STEP;       // 兽骨场角度，7 个节点角度从这里每步 +STEP

// 环上顺序（下标 i 对应角度 START + i*STEP）
const RING_ORDER = ['boneyard', 'blue_base', 'refinery', 'windmill', 'quarry', 'red_base', 'drill'];
const NODE_META = {
  boneyard: { name: '兽骨场', kind: 'point' },
  blue_base: { name: '蓝方基地', kind: 'base', faction: FACTIONS.BLUE },
  refinery: { name: '精炼厂', kind: 'point' },
  windmill: { name: '风车', kind: 'point' },
  quarry: { name: '采石场', kind: 'point' },
  red_base: { name: '红方基地', kind: 'base', faction: FACTIONS.RED },
  drill: { name: '钻机', kind: 'point' },
};

/** θ=0 为"正上方"（世界 y 减小的方向），与 howling_abyss.js 的世界坐标系（y 向下增大）一致。 */
function polar(angleDeg, r) {
  const rad = angleDeg * Math.PI / 180;
  return { x: Math.round(CENTER.x + r * Math.sin(rad)), y: Math.round(CENTER.y - r * Math.cos(rad)) };
}
function baseAngle(i) { return START + i * STEP; }
/** 沿圆弧在两个角度之间等距取点（含两端），用于让环边看起来是弧线而不是直线弦。 */
function arcPoints(angleA, angleB, r, steps) {
  const pts = [];
  for (let s = 0; s <= steps; s++) pts.push(polar(angleA + (angleB - angleA) * (s / steps), r));
  return pts;
}

const NODES = RING_ORDER.map((id, i) => ({
  id, ...NODE_META[id],
  angle: baseAngle(i),
  pos: polar(baseAngle(i), RING_R),
}));

// ==================== 一条闭合的环形兵线（RING_LANE） ====================
// 按 RING_ORDER 顺序把相邻两节点之间的弧线依次拼接，最后一段（drill→boneyard）
// 绕回起点，首尾相接形成一个完整的圆——'forward' 方向 = 角度递增方向（顺时针，
// 见 polar() 头注的坐标系），'reverse' = 逆时针。全部节点共用同一条 laneId，
// 出兵时只需要挑 forward/reverse 两个方向之一，不需要再关心具体挨着哪条边。
const RING_LANE_ID = 'ring';
const ARC_STEPS = 4; // 每段节点间插几个弧线点，只影响路点密度/画面弧度，不影响拓扑
const RING_WAYPOINTS = [];
for (let i = 0; i < N; i++) {
  const angleA = baseAngle(i);
  const angleB = i === N - 1 ? baseAngle(0) + 360 : baseAngle(i + 1); // 最后一段跨越角度零点，展开成连续角度
  const pts = arcPoints(angleA, angleB, RING_R, ARC_STEPS);
  // 每段的起点与上一段的终点是同一个节点，跳过重复点，首段保留起点（兽骨场）。
  RING_WAYPOINTS.push(...(i === 0 ? pts : pts.slice(1)));
}
// loop:true 交给 LaneMovementSystem 处理"走到折线末尾（首尾同一坐标）该怎么办"——
// 首尾相接的闭合折线原样复用"到达终点就停"的旧逻辑会卡死在接缝处并诱发乱飘
// （sim_pathcorner.mjs①⑤ 抓到的回归，见 LaneMovementSystem._advanceAlongLane 头注
// 的 wrap() 那段详细案发过程）：这个开关只对声明了它的 lane 生效（当前只有这条
// 环形兵线），其它地图的 lane 没有这个字段，行为不受任何影响。
const RING_LANE = { id: RING_LANE_ID, waypoints: RING_WAYPOINTS, spawns: [], loop: true };

// dominionNodes：每个节点在同一条环形兵线上标两个出兵方向——forward（顺时针）
// 与 reverse（逆时针），出兵时朝这两个方向各出一批，小兵各自沿环走到几乎绕
// 完一整圈为止（而不是走一跳就停），见文件头注"整环一条闭合兵线"。
const DOMINION_NODES = NODES.map((n) => ({
  id: n.id,
  name: n.name,
  kind: n.kind,
  // 2026-09-26 修复：之前这里没有把 NODE_META 里的 faction 字段带过来——
  // kind:'base' 节点因此拿到 undefined 的 faction，DominionSystem._spawnBudget
  // 的 `if (!this.createMinion || !faction) return;` 直接早退，表现为"双方
  // 召唤水晶每 3 波该出的兵完全不出"（用户报"目前初始根本默认不会出兵"）。
  faction: n.faction,
  pos: n.pos,
  segForward: { laneId: RING_LANE_ID, direction: 'forward' },
  segReverse: { laneId: RING_LANE_ID, direction: 'reverse' },
}));

/** 世界坐标 → navgrid 格子坐标，与 MapSystem.isWalkable 同一换算（世界是正方形，两轴系数相同）。 */
function toGrid(p) { return { x: p.x / WORLD.w * NAV_N, y: p.y / WORLD.h * NAV_N }; }

function buildNavgrid() {
  const bits = new Uint8Array(NAV_N * NAV_N);
  const hwGrid = CORRIDOR_HALF / WORLD.w * NAV_N;
  paintPolyline(bits, NAV_N, RING_WAYPOINTS.map(toGrid), hwGrid, 1);
  const bulgeGrid = NODE_BULGE / WORLD.w * NAV_N;
  for (const n of NODES) { const g = toGrid(n.pos); paintCircle(bits, NAV_N, g.x, g.y, bulgeGrid, 1); }
  return { n: NAV_N, bits: packBits(bits) };
}

const DOMINION_TERRAIN = {
  world: WORLD,
  useNavgrid: true,
  navgrid: buildNavgrid(),
  // river:false 必须显式给——MapSystem.riverFactor() 在没有 'top'/'bot' 两条命名兵线
  // 时 `_insideLaneRing` 会兜底返回 true，河道判定就会退化成"沿世界对角线 x=y
  // 画一条河"，在这张环形图上会凭空切出一条不存在的河带（howling_abyss.js 同一处
  // 头注也是这么处理"这张图本来就没有河"的情形）。
  walls: { river: false },
};

const blueBaseNode = DOMINION_NODES.find((n) => n.id === 'blue_base');
const redBaseNode = DOMINION_NODES.find((n) => n.id === 'red_base');

// ==================== 用户定稿：水晶枢纽不在路径上 ====================
// "水晶枢纽应该不在路径上，把目前水晶枢纽那个位置改为召唤水晶"——基地节点
// 原来的落点（环上、走廊内）现在放【召唤水晶】（nexus_lane），水晶枢纽
// （nexus_main）挪到环内侧的空地里（沿基地节点同一角度、半径缩小到走廊内圈
// 以内，稳稳落在环中央那片完全没有 navgrid 走廊覆盖的空地上，不在任何小兵
// 能走到的路径上）。
const NEXUS_INSET = 380; // 水晶枢纽相对基地节点【向环心方向】缩进的半径（世界单位）
function insetNexusPos(nodeId) {
  const n = NODES.find((x) => x.id === nodeId);
  return polar(n.angle, RING_R - NEXUS_INSET);
}
const blueNexusMainPos = insetNexusPos('blue_base');
const redNexusMainPos = insetNexusPos('red_base');

const DOMINION_CONFIG = {
  id: 'dominion_crystal_scar_v1',
  label: '统治战场·水晶之痕',
  factions: [FACTIONS.BLUE, FACTIONS.RED],

  visualStyle: 'stylized',
  paletteId: 'desert',

  baseCenters: { blue: blueBaseNode.pos, red: redBaseNode.pos },
  baseCircleRadius: NODE_BULGE,

  lanes: [RING_LANE],

  // 2026-09-26：召唤水晶重生时间从通用默认的 300s 改成 120s（用户定稿
  // "召唤水晶2分钟后重生"）——这是既有的 MapSystem.NEXUS_RESPAWN_TIME
  // 通用机制（HA/SR/TT 各自也用这个字段覆写），不是新写的重生逻辑。
  nexusRespawnTime: 120,

  // 每方两座"水晶类"建筑：召唤水晶(nexus_lane) 落在基地节点原来的路径位置上
  // （小兵仍然从这里出发/沿环占领，自带穿透型子弹+物理攻击，见下面 tierStats），
  // 水晶枢纽(nexus_main) 挪到环内侧空地、不在任何路径上（见上面"用户定稿：
  // 水晶枢纽不在路径上"），HP 固定 500、不带默认技能/被动（skills:[]，见
  // tierStats 同一处注释）。
  // 召唤水晶必须挂 laneId——MapSystem.beginNexusRespawn() 的重生入队判定
  // `if (!laneId) return false` 直接依赖它，没有 laneId 的召唤水晶被摧毁后
  // 永远不会重生（这条踩过一次：最初为了让 buildingCountsSymmetric 的
  // "按 tier+laneId 分组"通用校验通过，两个基地节点相邻的环边命名各不相同，
  // 干脆没给召唤水晶挂 laneId——但改成整环一条共享兵线之后，双方召唤水晶
  // 现在可以共用同一个 laneId='ring'，两个问题一起解决：对称性检查看到的是
  // 同一个 key，重生判定也拿到了非空 laneId）。
  buildings: [
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: RING_LANE_ID, pos: blueBaseNode.pos, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', pos: blueNexusMainPos, weapon: null, skills: [] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: RING_LANE_ID, pos: redBaseNode.pos, weapon: null },
    { faction: FACTIONS.RED, tier: 'nexus_main', pos: redNexusMainPos, weapon: null, skills: [] },
  ],

  // ==================== 本图专属建筑数值 ====================
  // 水晶枢纽：用户定稿"生命值设置为500，并且默认不含任何技能和状态"——HP 砍到
  // 500（远低于通用默认的 5500），双抗/固定护盾/生命恢复都清零（不给"技能带来
  // 的状态"留口子，加固城防/水晶再生这类被动本来就只在 buildings 数组不显式
  // 传 skills 时才会自动装配，这里已经显式传了 skills:[] 挡掉了，这里的 0 只是
  // 避免"万一以后又给它接了被动"时还留着一份看似有意义的双抗数值）。
  //
  // 召唤水晶：用户定稿"召唤水晶自带穿透型子弹和物理攻击"——但 CONFIG.
  // towerTierWeapon.nexus_lane 全局固定为 'none'（所有地图的召唤水晶默认无
  // 武器，这是全局配置，不该为了这一张图去改，会连带 SR/HA/TT 的召唤水晶一起
  // 变得能开火），所以这里不能靠 buildings[].weapon 走常规装配路径——
  // DominionSystem.initMap() 里对这两座召唤水晶单独调 equipSkill(...,
  // 'weapon_piercing', ...) 绕开那道全局闸门，这里的 tierStats 只负责给它
  // 攻击力/射程/攻速这几个数值（照抄 TIER_STATS.outer 的攻击强度，作为
  // "正常一座塔"的基准，不是特别削弱/强化）。
  tierStats: {
    nexus_main: { maxHP: 500, shieldFixedMax: 0, healthRegen: 0, armor: 0, magicResist: 0, attackDamage: 0, baseAttackSpeed: 0 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0, attackDamage: 152, attackRange: 180, baseAttackSpeed: 0.833 },
  },

  // 本图的占领/出兵/水晶掉血节点表——DominionSystem.initMap() 读这个字段激活整套
  // 机制；MapSystem/LaneWaveSystem 等既有系统完全不认识这个字段，读不到就是没有。
  dominionNodes: DOMINION_NODES,
};

export const dominion_crystal_scar = composeMap({ terrain: DOMINION_TERRAIN, config: DOMINION_CONFIG });
