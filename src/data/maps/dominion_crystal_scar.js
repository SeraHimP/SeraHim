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
 * （360°/7 ≈ 51.43°）分布在同一个圆上——用户原话"兵是绕整个环走一圈"，等角环
 * 结构使得"沿环相邻节点一段段走"天然等价于"绕环走一圈"。
 *
 * 环上顺序（按角度递增，风车=0°为环的"正上方"）：
 *   兽骨场(-154.3°) → 蓝方基地(-102.9°) → 精炼厂(-51.4°) → 风车(0°)
 *   → 采石场(+51.4°) → 红方基地(+102.9°) → 钻机(+154.3°) → (绕回兽骨场)
 * 7 条边（lane）各连接相邻两个节点；每个节点记录它两侧邻边的 {laneId,direction}
 * 存进 `dominionNodes`（DominionSystem._spawnBudget 出兵时用它决定"往哪个
 * 相邻方向出兵"，见用户定稿"朝相邻两个方向都出"）。
 *
 * ==================== 出兵为什么不给 lane 挂 spawns ====================
 * 7 条边全部把 `spawns` 显式声明成空数组。原因：FactionSystem.laneSpawnsOf()
 * 对没声明 spawns 的 lane 会兜底成"蓝方 forward / 红方 reverse"各一条——那是
 * 给"一条路直连两个基地"的传统地图设计准备的默认值，套在"据点之间的一小段
 * 环边"上完全不对（一条环边没有"哪头是蓝哪头是红"这种固定意义，出兵节奏也
 * 另有一套由 CONFIG.dominion 驱动的 DominionSystem._tickWaves 控制）。显式给
 * 空数组，laneWaveSystem 每次扫描这条边都会因为没有出兵流而什么也不做。
 *
 * ==================== navgrid：程序化生成的环形走廊 ====================
 * 跟嚎哭深渊/召唤师峡谷冰封版一样用 navgrid（逐格可走位图），但那两张图是
 * 从小地图美术图逐像素描出来的，这张图没有美术图可描——直接用 paintPolyline
 * 沿 7 段边的路点画一条固定半宽的环形走廊，再在每个节点上叠一个更大的圆形
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

const ARC_STEPS = 4; // 每条边中间插几个弧线点，只影响路点密度/画面弧度，不影响拓扑
const EDGES = RING_ORDER.map((a, i) => {
  const b = RING_ORDER[(i + 1) % N];
  const angleA = baseAngle(i);
  const angleB = i === N - 1 ? baseAngle(0) + 360 : baseAngle(i + 1); // 最后一条边跨越角度零点，展开成连续角度
  return {
    id: `seg_${a}_${b}`,
    waypoints: arcPoints(angleA, angleB, RING_R, ARC_STEPS),
    spawns: [], // 见头注"出兵为什么不给 lane 挂 spawns"
  };
});

// dominionNodes：每个节点记两侧邻边——segForward 是环上"下一个"方向（edge[i]，
// 本节点是它的起点，direction:'forward'），segReverse 是"上一个"方向
// （edge[i-1]，本节点是它的终点，direction:'reverse'）。
const DOMINION_NODES = NODES.map((n, i) => ({
  id: n.id,
  name: n.name,
  kind: n.kind,
  pos: n.pos,
  segForward: { laneId: EDGES[i].id, direction: 'forward' },
  segReverse: { laneId: EDGES[(i - 1 + N) % N].id, direction: 'reverse' },
}));

/** 世界坐标 → navgrid 格子坐标，与 MapSystem.isWalkable 同一换算（世界是正方形，两轴系数相同）。 */
function toGrid(p) { return { x: p.x / WORLD.w * NAV_N, y: p.y / WORLD.h * NAV_N }; }

function buildNavgrid() {
  const bits = new Uint8Array(NAV_N * NAV_N);
  const hwGrid = CORRIDOR_HALF / WORLD.w * NAV_N;
  for (const edge of EDGES) paintPolyline(bits, NAV_N, edge.waypoints.map(toGrid), hwGrid, 1);
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
// "水晶枢纽应该不在路径上，把目前水晶枢纽那个位置改为召唤水晶（具体玩法我
// 一会再想）"——basе 节点原来的落点（环上、走廊内）现在放【召唤水晶】
// （nexus_lane，跟 SR/HA 的"分路水晶"同一档），水晶枢纽（nexus_main）挪到
// 环内侧的空地里（沿基地节点同一角度、半径缩小到走廊内圈以内，稳稳落在
// 环中央那片完全没有 navgrid 走廊覆盖的空地上，不在任何小兵能走到的路径上）。
// 水晶枢纽这里具体挂什么玩法（用户原话"具体玩法我一会再想"）本次不处理，
// 这里只是先把"塔位从路径上挪开"这一条落实成数据。
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

  lanes: EDGES,

  // 每方两座"水晶类"建筑：召唤水晶(nexus_lane) 落在基地节点原来的路径位置上
  // （小兵仍然从这里出发/沿环占领），水晶枢纽(nexus_main) 挪到环内侧空地、
  // 不在任何路径上（见上面"用户定稿：水晶枢纽不在路径上"）。都不挂 laneId
  // ——两个基地各自相邻的环边命名不对称（'seg_blue_base_refinery' vs
  // 'seg_red_base_drill'），挂了反而会让 buildingCountsSymmetric 这类
  // "按 tier+laneId 分组"的通用校验误判成"两方建筑构成不对称"。laneId 只影响
  // LaneMovementSystem"回家维修"时的同路筛选，不影响占领/出兵（那套走
  // DominionSystem，见 dominionNodes）。
  buildings: [
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', pos: blueBaseNode.pos, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', pos: blueNexusMainPos, weapon: null },
    { faction: FACTIONS.RED, tier: 'nexus_lane', pos: redBaseNode.pos, weapon: null },
    { faction: FACTIONS.RED, tier: 'nexus_main', pos: redNexusMainPos, weapon: null },
  ],

  // 本图的占领/出兵/水晶掉血节点表——DominionSystem.initMap() 读这个字段激活整套
  // 机制；MapSystem/LaneWaveSystem 等既有系统完全不认识这个字段，读不到就是没有。
  dominionNodes: DOMINION_NODES,
};

export const dominion_crystal_scar = composeMap({ terrain: DOMINION_TERRAIN, config: DOMINION_CONFIG });
