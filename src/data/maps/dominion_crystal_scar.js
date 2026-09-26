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
 * ==================== 拓扑：7 节点环形（7 个都是可占领据点）====================
 * 原版是一张圆形地图，5 个据点沿圆周分布：风车(Windmill)在正上方、离两个基地
 * 都最远；精炼厂(Refinery)/采石场(Quarry) 对称分列风车两侧；兽骨场(Boneyard)/
 * 钻机(Drill) 紧邻两个基地。这里把两个基地节点也当成环上的节点，7 个节点等角度
 * （360°/7 ≈ 51.43°）分布在同一个圆上。
 *
 * 环上顺序（按角度递增，风车=0°为环的"正上方"）：
 *   兽骨场(-154.3°) → 商栈(-102.9°) → 精炼厂(-51.4°) → 风车(0°)
 *   → 采石场(+51.4°) → 望塔(+102.9°) → 钻机(+154.3°) → (绕回兽骨场)
 *
 * ==================== 2026-09-26 第五轮：召唤水晶撤编，改成 7 个据点全部可占领 ====================
 * 用户定稿"这个地图没有召唤水晶，把原有的召唤水晶改为普通的据点。然后打通
 * 水晶枢纽和环的通道，出兵在水晶枢纽处出兵，水晶枢纽无法被小兵攻击，水晶
 * 枢纽继承召唤水晶的攻击"——原来"商栈"/"望塔"这两个节点是 kind:'base'
 * （固定归属、不可争夺，专门用来放召唤水晶 nexus_lane），现在它们撤掉召唤
 * 水晶、改成跟另外 5 个一样的 kind:'point'（中立起手，可被任意一方占领/
 * 争夺）——地图上再也没有"谁的地盘天生就是谁的"这种节点了，7 个据点完全对等。
 *
 * 水晶枢纽（nexus_main）原来的"挪到环内侧、完全不在任何路径上"设计作废——
 * 见下面"打通水晶枢纽与环的通道"一节。出兵位置也从"商栈/望塔的环上位置"
 * 改成"水晶枢纽自己的位置"（DOMINION_NODES 新增 kind:'nexus' 这两个节点，
 * DominionSystem._tickWaves 认这个 kind 当出兵源）。
 *
 * ==================== 打通水晶枢纽与环的通道 ====================
 * 水晶枢纽沿原来"商栈/望塔"那个角度、径向缩进 NEXUS_INSET 的位置不变，但
 * 现在额外画一条从这个位置直插环上（同角度）的直线走廊（跟环本身的走廊
 * 同宽），把水晶枢纽正式接入 navgrid 的可行走连通图——这不是画面装饰，是
 * 出兵机制真正需要的：出兵改成"在水晶枢纽处出兵"之后，小兵的出生点位就在
 * 环外面，LaneMovementSystem 用"投影到最近折线点 + 沿切线前瞻"驱动巡线，
 * 出生点离折线远到超过 LANE_KEEP(150px) 时会切换成 MapSystem.laneFlowDir()
 * 的"回流场下山"逻辑（BFS 距离场，沿 navgrid 能走的格子找回兵线的最短路），
 * 这套逻辑本来就是给"小兵意外被挤出兵线"设计的通用寻路兜底，水晶枢纽只要
 * 落在跟环连通的可走区域内，小兵就会自己顺着这条新走廊走出来汇入环形兵线，
 * 不需要另外发明"两条兵线在某点交接"这种新概念——如果这条走廊没打通（不
 * 连通），回流场会判定"不可达"（laneFlowDir 返回 null），小兵会卡在水晶
 * 枢纽附近走不出来，所以这条走廊是功能性必需品，不是可选的视觉修饰。
 *
 * 水晶枢纽变得可以主动攻击（继承原召唤水晶 nexus_lane 的攻击力/攻速，射程
 * 按"从环到水晶枢纽的距离"设定），但因为它天生不在小兵会主动巡逻/索敌的
 * 路径终点上（小兵的巡线目标永远是环本身，不会主动折返进这条走廊），加上
 * DominionSystem.initMap() 显式给它标了 `_untargetable`（isStructureProtected
 * 认这个标记，无条件让任何索敌判定跳过它——用户定稿"水晶枢纽无法被场上的
 * 小兵所攻击"，做成硬性规则而不是指望"小兵天生走不到"这个自然结果），场上
 * 的小兵完全打不到它——它的血量只由 DominionSystem._tickNexusDrain()（据点
 * 数差驱动的持续掉血）决定，跟直接的近战/远程命中无关，跟改动前的胜负判定
 * 口径完全一致，只是现在它自己也能反过来主动咬人。
 *
 * 用户追加定稿"确保正常情况下水晶枢纽干扰不到正常推线的小兵"——NEXUS_INSET
 * 从 380 加大到 420（水晶枢纽往环心方向多缩进 40）。攻击距离最初直接照抄
 * NEXUS_INSET（本意是"射程刚好够到环边"），但用户实机测试后反馈这个值
 * 打得太远，把 NEXUS_ATTACK_RANGE 从等于 NEXUS_INSET 改成独立的固定值 220
 * ——射程和缩进距离本来就是两件事（前者是"打多远"，后者是"摆多偏"），只是
 * 定稿时偷懒让它们相等，这次拆开成两个独立常量，互不影响。220 比 420 小
 * 了近一半，只够碰到环上贴着走廊口最近的一小段弧，比原来更不容易干扰到
 * 正常推线的小兵。
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
 * 空地（据点周围留出建筑摆放和战斗空间，跟 howling_abyss.js 桥两端变宽
 * 的处理思路一致），水晶枢纽和它到环的连接走廊同一套画法再叠一遍。
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
// "blue_base"/"red_base" 这两个 id 是历史遗留（第四轮之前它们是 kind:'base'
// 的固定归属节点），第五轮撤编召唤水晶之后它们已经是跟其余 5 个完全对等的
// kind:'point'——继续用这两个 id 只是为了不用连带改 insetNexusPos() 等一批
// 内部查找逐个改名，不影响任何对外行为（node.id 从不显示给玩家，显示的是
// 下面 NODE_META 里的 name）。
const RING_ORDER = ['boneyard', 'blue_base', 'refinery', 'windmill', 'quarry', 'red_base', 'drill'];
const NODE_META = {
  boneyard: { name: '兽骨场', kind: 'point' },
  // 2026-09-26 第五轮：占位名，用户没有指定具体叫什么——原来的"蓝方基地"/
  // "红方基地"名字暗示"天生归属蓝/红"，现在这两个节点中立起手、可被任意
  // 一方占领，继续叫"XX基地"会误导玩家以为它自带归属，改成跟其余 5 个一样
  // 中性的地名。如果想要别的名字，这两个字符串随时可以改，不影响任何逻辑。
  blue_base: { name: '商栈', kind: 'point' },
  refinery: { name: '精炼厂', kind: 'point' },
  windmill: { name: '风车', kind: 'point' },
  quarry: { name: '采石场', kind: 'point' },
  red_base: { name: '望塔', kind: 'point' },
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

// ==================== 水晶枢纽位置 + 与环的连接走廊 ====================
// 2026-09-26 第五轮：380 → 420（用户定稿"可以适当把水晶枢纽往里面挪一挪……
// 确保正常情况下水晶枢纽干扰不到正常推线的小兵"）——挪得更深一点，留更多缓冲。
const NEXUS_INSET = 420; // 水晶枢纽相对环上同角度位置【向环心方向】缩进的半径（世界单位）
function insetNexusPos(nodeId) {
  const n = NODES.find((x) => x.id === nodeId);
  return polar(n.angle, RING_R - NEXUS_INSET);
}
const blueNexusMainPos = insetNexusPos('blue_base');
const redNexusMainPos = insetNexusPos('red_base');
// 用户定稿"水晶枢纽变得可以攻击"，射程最初直接等于 NEXUS_INSET（水晶枢纽到
// 环上最近点的直线距离，同角度、半径差，几何上正好相等，图省事就设成一样）。
// 2026-09-26：用户实机测试后反馈这个射程太远，改成独立的固定值 220——
// 跟 NEXUS_INSET 不再是同一个数字，改缩进距离不会再连带改到射程，反之亦然。
const NEXUS_ATTACK_RANGE = 220;

// dominionNodes 分两类：
//   kind:'point' —— 环上 7 个据点，占领/争夺/出兵编排全部对等，见文件头注。
//   kind:'nexus' —— 水晶枢纽出兵锚点（第五轮新增，替代原来的 kind:'base'），
//     只用来给 DominionSystem._tickWaves 提供"这一波兵从哪个位置、往哪两个
//     方向出"，不参与占领/争夺（不会出现在 blueCount/redCount 的统计里）。
const DOMINION_POINT_NODES = NODES.map((n) => ({
  id: n.id,
  name: n.name,
  kind: n.kind,
  pos: n.pos,
  segForward: { laneId: RING_LANE_ID, direction: 'forward' },
  segReverse: { laneId: RING_LANE_ID, direction: 'reverse' },
}));
const DOMINION_NEXUS_NODES = [
  { id: 'blue_nexus', name: '蓝方水晶枢纽', kind: 'nexus', faction: FACTIONS.BLUE, pos: blueNexusMainPos,
    segForward: { laneId: RING_LANE_ID, direction: 'forward' }, segReverse: { laneId: RING_LANE_ID, direction: 'reverse' } },
  { id: 'red_nexus', name: '红方水晶枢纽', kind: 'nexus', faction: FACTIONS.RED, pos: redNexusMainPos,
    segForward: { laneId: RING_LANE_ID, direction: 'forward' }, segReverse: { laneId: RING_LANE_ID, direction: 'reverse' } },
];
const DOMINION_NODES = [...DOMINION_POINT_NODES, ...DOMINION_NEXUS_NODES];

/** 世界坐标 → navgrid 格子坐标，与 MapSystem.isWalkable 同一换算（世界是正方形，两轴系数相同）。 */
function toGrid(p) { return { x: p.x / WORLD.w * NAV_N, y: p.y / WORLD.h * NAV_N }; }

function buildNavgrid() {
  const bits = new Uint8Array(NAV_N * NAV_N);
  const hwGrid = CORRIDOR_HALF / WORLD.w * NAV_N;
  paintPolyline(bits, NAV_N, RING_WAYPOINTS.map(toGrid), hwGrid, 1);
  const bulgeGrid = NODE_BULGE / WORLD.w * NAV_N;
  for (const n of NODES) { const g = toGrid(n.pos); paintCircle(bits, NAV_N, g.x, g.y, bulgeGrid, 1); }
  // 水晶枢纽本身的空地 + 打通到环的直线走廊（见文件头注"打通水晶枢纽与环的
  // 通道"）——走廊是一段直线（同角度、从环上位置到水晶枢纽位置），跟环本身
  // 走廊同宽，画法一致（paintPolyline 的两点折线）。
  for (const nexusPos of [blueNexusMainPos, redNexusMainPos]) {
    const g = toGrid(nexusPos);
    paintCircle(bits, NAV_N, g.x, g.y, bulgeGrid, 1);
  }
  const blueRingMouth = NODES.find((n) => n.id === 'blue_base').pos;
  const redRingMouth = NODES.find((n) => n.id === 'red_base').pos;
  paintPolyline(bits, NAV_N, [toGrid(blueRingMouth), toGrid(blueNexusMainPos)], hwGrid, 1);
  paintPolyline(bits, NAV_N, [toGrid(redRingMouth), toGrid(redNexusMainPos)], hwGrid, 1);
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

const blueBaseNode = NODES.find((n) => n.id === 'blue_base');
const redBaseNode = NODES.find((n) => n.id === 'red_base');

const DOMINION_CONFIG = {
  id: 'dominion_crystal_scar_v1',
  label: '统治战场·水晶之痕',
  factions: [FACTIONS.BLUE, FACTIONS.RED],

  visualStyle: 'stylized',
  paletteId: 'desert',

  // ==================== 本图全局光环（用户定稿）====================
  // "新增地图级光环，水晶之痕光环——所有单位伤害增幅+33%"——跟扭曲丛林/
  // 嚎哭深渊冰封版同一套机制（MapSystem._applyGlobalAura），"所有单位"同样
  // 含防御塔与水晶（跟那两张图的既有口径一致，不用另开分支）。damageAmpPct
  // 是 CombatSystem 里现成的"攻击方全伤害增幅"字段（见 performAttackDirect
  // 的 dmgAmp 取值），不是新造的属性——用户没有指定这是不是随时间增长的，
  // 直接给固定值 33，不套 twisted_treeline 那种 perMinute 累进写法。
  globalAura: {
    name: '水晶之痕光环', icon: '💎',
    effects: [
      { statKey: 'damageAmpPct', flat: 33, label: '伤害增幅' },
    ],
  },

  // ==================== 第三轮：让"不可走区域"变成真峡谷，不是一块纯色背景 ====================
  // 用户转述的 GPT 评估："它把'不可行走区域'做成了一个巨大的黑洞……而不是
  // '这里是一片不可通行的巨大峡谷/岩丘/荒漠地貌'"——复用 TerrainEdgeLayer.js
  // 这个通用件（howling_abyss_frost.js 已经在用同一套机制，设计文档写明
  // "这一层是通用件，不是冰封图专用"）：不可走区域会被挖空，另在更低的
  // waterY 铺一张深渊面，沿可走边界画一圈外倾斜坡——陆地因此第一次有了真实
  // 的高度落差，而不是跟不可走区域完全同一个平面。
  // 颜色全部从 CONFIG.stylizedPalettes.desert 的 corridorColor/groundColor
  // 用同一套"同色系压暗"规则派生（跟 DominionPropsLayer.js 的
  // deriveDesertRamp() 是同一个来源、同一条规则，不是另起一套配色）：
  //   slopeColor = corridorColor(#c9915a) × 0.75 → #976d44（岸坡：地面色的
  //     背光面，TerrainEdgeLayer 的既有约定"必须取地面色压暗一档，不能取
  //     石色"）；
  //   abyssColor = groundColor(#3a2410) × 0.55 → #201409（深渊面：整张图
  //     最暗的一档，比原来纯色背景的 groundColor 本身更暗，读出"往下凹"）。
  // 其余参数（落差/外扩/抖动/分段）沿用 TerrainEdgeLayer 的默认值——那套
  // 默认值本来就是给"通用地图边界"调的，没有这张图专属到需要另调的理由。
  terrainEdge: {
    waterY: -22,
    slopeColor: '#976d44',
    abyssColor: '#201409',
  },

  baseCenters: { blue: blueBaseNode.pos, red: redBaseNode.pos },
  baseCircleRadius: NODE_BULGE,

  lanes: [RING_LANE],

  // 2026-09-26 新增：模板编辑器"出兵编排"页按 map.lanes 生成路页签
  // （laneLabels.js 的 mapLaneIds()），这张图物理上只有一条环形兵线
  // （lanes.length===1，id='ring'），页签因此只会显示一格——但用户定稿
  // "分为4条线路：红蓝方×顺逆时针"，要求能分别编辑"顺时针"和"逆时针"两个
  // 方向各自的出兵编制。两个方向共用同一条物理兵线，没有第二条真实 lane 可用，
  // 于是给两个方向各发一个不对应任何真实 LaneMovementSystem 兵线的"伪路 id"
  // （ring_fwd/ring_rev），只用于出兵编排的 (阵营×路) 二维网格定位——
  // DominionSystem._spawnPointWave() 按小兵的实际方向把这两个伪 id 之一
  // 传给 compositionFor()，跟 CONFIG.gameRules.laneWaveCompositionByLane 的
  // 默认编排（见该文件头注）是同一套键。mapLaneIds() 优先读这个字段，
  // 没声明时才退回 map.lanes（其它地图都是这种情况，不受影响）。
  waveEditorLaneIds: ['ring_fwd', 'ring_rev'],

  // 每方一座水晶枢纽（nexus_main）建筑，落在环内侧空地、有一条走廊接入环
  // （见文件头注）。第五轮撤编了召唤水晶（nexus_lane）——不再单独建它，
  // 水晶枢纽自己继承了原来召唤水晶的攻击数值（见下面 tierStats）。
  buildings: [
    { faction: FACTIONS.BLUE, tier: 'nexus_main', pos: blueNexusMainPos, weapon: null, skills: [] },
    { faction: FACTIONS.RED, tier: 'nexus_main', pos: redNexusMainPos, weapon: null, skills: [] },
  ],

  // ==================== 本图专属建筑数值 ====================
  // 水晶枢纽：HP 早前定稿"设置为500，并且默认不含任何技能和状态"，
  // 2026-09-26 用户追加定稿"为了增加对局时长，将双方的水晶枢纽的最大生命值
  // 由500增加到750"——用户给了具体数字，不是起草值。双抗/固定护盾/生命恢复
  // 都清零——这些防御数值现在更加无关紧要，因为第五轮定稿"水晶枢纽无法被
  // 场上的小兵所攻击"（DominionSystem.initMap() 给它标 `_untargetable`，
  // isStructureProtected 无条件放行），它的血量只由据点数差驱动的持续掉血
  // （+30分钟后新增的热寂平推，见 CONFIG.dominion.nexusHeatDeathDrainPerSec）
  // 决定，从不吃直接命中，双抗数值不管填多少都不会有任何效果，留 0 只是
  // 不给"看起来有意义"的数字添误导。
  //
  // 攻击力/攻速/射程：用户定稿"水晶枢纽继承召唤水晶的攻击"——直接搬第四轮
  // 调出来的召唤水晶(nexus_lane)攻击力 700、攻速 1.4（原样照抄，不是重新
  // 起草）；射程用独立常量 NEXUS_ATTACK_RANGE（定义处见上面，用户实机测试
  // 后定稿为固定值 220），不沿用召唤水晶原来的 260——那是配合"就在环上"这个
  // 位置调的，水晶枢纽现在挪进了环内侧，用同一个数字没有意义。
  // 全局 CONFIG.towerTierWeapon.nexus_main 固定是 'none'（所有地图的水晶
  // 枢纽默认无武器，不该为了这一张图去改），所以这里的 weapon:null 只是
  // 常规装配路径的占位——真正给它装 weapon_piercing 由 DominionSystem.
  // initMap() 手动调 equipSkill() 完成，跟原来给召唤水晶装的是同一份代码。
  tierStats: {
    nexus_main: {
      maxHP: 750, shieldFixedMax: 0, healthRegen: 0, armor: 0, magicResist: 0,
      attackDamage: 700, attackRange: NEXUS_ATTACK_RANGE, baseAttackSpeed: 1.4,
    },
  },

  // 本图的占领/出兵/水晶掉血节点表——DominionSystem.initMap() 读这个字段激活整套
  // 机制；MapSystem/LaneWaveSystem 等既有系统完全不认识这个字段，读不到就是没有。
  dominionNodes: DOMINION_NODES,
};

export const dominion_crystal_scar = composeMap({ terrain: DOMINION_TERRAIN, config: DOMINION_CONFIG });
