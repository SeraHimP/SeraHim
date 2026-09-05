import { FACTIONS } from '../../systems/FactionSystem.js';
import { HA_NAVGRID_FROST_WIDE } from './map_navgrids.js';
import { unpackBits, packBits } from '../navgrid.js';

/**
 * howling_abyss_frost.js —— 嚎哭深渊·冰封风格重做
 *
 * 设计文档：docs/MAP-DESIGN-howling-abyss-frost.md（v0.2，用户已确认待定项）。
 * 原图 `howling_abyss.js`（`howling_abyss_v1`）**完全不动**——这是它的风格化副本，
 * 与 `demo_stylized.js` 相对于三张老地图的关系完全一样：新地图不改变已验证过的
 * 原图数值/测试，两条数据/两套渲染分支并存。
 *
 * ==================== 地形/玩法数据：逐字段照抄 howling_abyss.js ====================
 * 桥的形状、建筑位置、塔属性、光环、出兵节奏——这次不评估/不改动任何这些数值，
 * 直接复用一份已知能跑的配置（同 demo_stylized.js 头注"数值照抄……这次不评估
 * 数值"的原则）。唯一的差别是新增的画面相关字段：`visualStyle`/`paletteId`/
 * `frostBridge`（见下方）。
 *
 * ==================== frostBridge：桥体装饰的参数化坐标 ====================
 * 用户拍板：墙不是连续一整条，是一段段的，中间用插进地面的石柱子连接；柱子
 * 摆在桥上已有的 13 处"缺口"弧长位置旁边（`obstacles` 数组用的同一组 d 值，
 * 已用 AskUserQuestion 向用户确认过）——相邻两根柱子之间接一段墙，柱子位置
 * 同时也是"缺口"（豁口+散落瓦砾）出现的地方。
 *
 * 这份数据直接算出**世界坐标**（而不是让渲染层重新推导桥的方向/半宽），跟本
 * 项目"地图声明什么，系统就画什么"的既有约定一致（buildings/obstacles 都是这
 * 么做的）。渲染由 `src/presentation/HowlingAbyssDecor.js` 消费，那边不认识
 * "弧长"这个概念，只认这里给出的具体点位。
 */

// 沿桥单位向量（蓝→红）与其法向——与 howling_abyss.js 完全相同的桥体参数化，
// 逐行照抄（这两个文件必须用同一套桥体坐标系，否则装饰会对不上真实桥形）。
const U = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
const Nrm = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
const BLUE_NEXUS = { x: 292, y: 2033 };
const P = (d, off = 0) => ({
  x: Math.round(BLUE_NEXUS.x + U.x * d + Nrm.x * off),
  y: Math.round(BLUE_NEXUS.y + U.y * d + Nrm.y * off),
});
const R = (p) => ({ x: 2325 - p.x, y: 2325 - p.y });

const B = {
  hq_a:       P(110, +57),
  hq_b:       P(110, -57),
  nexus_lane: P(370),
  base:       P(480),
  outer:      P(850),
};

// 与 HA_TERRAIN.obstacles 用的是同一组弧长值（见 howling_abyss.js 头注"缺口"）。
const GAP_D = [280, 440, 600, 760, 920, 1080, 1240, 1400, 1560, 1720, 1880, 2040, 2180];
const BASE_GAP_OFF = 140; // 原始偏移——obstacles 数组的破口位置仍然对齐这个（缺口数据本身不改）

// ==================== v0.7：墙线内收 + 可走区域收到墙线 + 缺口处断墙（用户拍板方案） ====================
// 用户："把桥的宽度向两边略微扩大，墙也跟着外移，把墙作为体积碰撞的边界"（v0.6），
// 之后连续三轮实机反馈把这套做法逐条修正到现在这个样子，每一条都是用户明确
// 拍板过的，不是猜的：
//
// ① 墙必须是直线，不能逐根柱子去贴真实边界
//    v0.6 第一版让每根柱子各自量一次 navgrid 上的真实边界（`edgeOffset`），
//    贴合度最高，但手描位图在像素级别不平滑，相邻弧长量出来的值来回跳，
//    墙因此一段段拐来拐去。用户："要原先那样的平直的"。
//    → 每一侧只用**一个**偏移量，整条墙是一条直线。
//
// ② 这个偏移量取中位数，不取平均值，更不取最大值
//    取最大值墙会离水岸老远（用户："墙都浮在水面上了"）；取平均值会被那一处
//    真实缺口（见③）往下拽。取**中位数**对少数极端值免疫，量出来的就是"这条桥
//    绝大多数地方的半宽"——实测 sign+1 侧 233、sign-1 侧 214。
//
// ③ 墙往桥内侧回收 `WALL_INSET`，不贴着水岸走
//    用户："墙再往回收一些！现在贴着桥的边缘不好看！"。回收量经用户选定为 25。
//    回收还顺带解决了一个画面问题：墙线正好压在中位半宽上时，位图本身的锯齿
//    会让真实边界在十来处地方微微低于墙线，墙看起来是毛的；回收 25 之后这些
//    锯齿全部落在墙线外侧，墙是干净的一条直线（实测：内收 0 会碎出 10 段假
//    断口，内收 15 以上就只剩下③说的那一处真缺口）。
//
// ④ 可走区域收到墙线——"墙即碰撞边界"这条要求在回收之后依然成立
//    用户选定"不能走，可走区域收到墙线"。于是墙外侧那圈桥沿是看得见、走不上去
//    的装饰地面，墙重新是真正的碰撞边界。注意内收 25 之后的墙线（208/189）
//    与**原图**的桥半宽（207/188）几乎重合——也就是说可走宽度回到了原图水平，
//    并没有因为这次回收而比原来更窄，v0.6 拓宽出来的那一圈正好变成墙外的桥沿。
//    两个基地圈（半径 `BASE_CIRCLE_R`）不参与收边，否则圆形基地平台会被削成条状。
//
// ⑤ 断墙位置由几何决定，不再是概率
//    这是这一轮最大的认知纠正：**全桥只有一处真正的"缺口"**——sign-1 侧弧长
//    1240~1400 处，桥沿向内凹进去 67 个单位（原图就有，v0.6 的膨胀完整保留了
//    它）。用户圈红的就是这一处。此前几版把 `GAP_D` 这 13 个**柱子间距**弧长
//    误当成"13 处缺口"，先按 55% 概率、后按 100% 必断地在每根柱子旁边拆墙，
//    完全是建立在错误前提上的机制（用户："我指的桥上的缺口是我画红圈的地方"）。
//    正确的规则只有一句话：**墙脚下没有桥的地方，这段墙就不摆**。墙沿直线走，
//    走到那处凹进去的缺口上方时下面是水，于是那一段自然断开——其余地方墙连续
//    不断、与柱子严丝合缝（`WALL_GAP_CHANCE`/`WALL_GAP_BLOCKS` 两个常量连同
//    整套概率机制已删除）。判定放在渲染层逐块做（见 HowlingAbyssDecor.js），
//    这里只负责把判定需要的两样东西算好交出去：`inward`（指向桥内侧的单位
//    法向）和 `groundProbe`（往内侧探多远去采样地面）。
const NAV_N = HA_NAVGRID_FROST_WIDE.n;
const NAV_BITS = unpackBits(HA_NAVGRID_FROST_WIDE.bits, NAV_N);
const WORLD = 2325;
const RED_NEXUS = R(BLUE_NEXUS);
const BRIDGE_LEN = Math.hypot(RED_NEXUS.x - BLUE_NEXUS.x, RED_NEXUS.y - BLUE_NEXUS.y);
// 基地圈半径——与下面 map.baseCircleRadius 是同一个数，必须共用一个常量：
// 收边逻辑要靠它避开基地平台，两处各写一份迟早会漂移。
const BASE_CIRCLE_R = 330;
const WALL_INSET = 25;        // 墙线从中位半宽往桥内侧回收多少（用户选定）
const WALL_GROUND_PROBE = 12; // 判"墙脚下有没有桥"时往内侧探的距离（约 1.3 个 navgrid 格）

function bitsWalkable(bits, x, y) {
  const gx = Math.floor(x / WORLD * NAV_N), gy = Math.floor(y / WORLD * NAV_N);
  if (gx < 0 || gy < 0 || gx >= NAV_N || gy >= NAV_N) return false;
  return bits[gy * NAV_N + gx] === 1;
}
/** 沿弧长 d 处的法向，从中线向 sign（+1/-1）方向扫描，找可走区域的真实边界（世界单位）。 */
function edgeOffset(d, sign) {
  const STEP = 2, MAX_OFF = 420;
  let off = 0;
  while (off < MAX_OFF) {
    const p = P(d, sign * (off + STEP));
    if (!bitsWalkable(NAV_BITS, p.x, p.y)) break;
    off += STEP;
  }
  return off;
}

// 桥身中段的采样弧长：两端各让开一个基地圈 + 一段过渡带（基地圈与桥交接处
// 边界是斜着收进来的，采到那一段会把中位数拉高）。
const EDGE_SAMPLE_MARGIN = 30, EDGE_SAMPLE_STEP = 10;
const MID_SAMPLE_D = [];
for (let d = BASE_CIRCLE_R + EDGE_SAMPLE_MARGIN; d <= BRIDGE_LEN - BASE_CIRCLE_R - EDGE_SAMPLE_MARGIN; d += EDGE_SAMPLE_STEP) {
  MID_SAMPLE_D.push(d);
}
const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const WALL_OFF_LEFT = median(MID_SAMPLE_D.map((d) => edgeOffset(d, +1))) - WALL_INSET;
const WALL_OFF_RIGHT = median(MID_SAMPLE_D.map((d) => edgeOffset(d, -1))) - WALL_INSET;

// ==================== 可走区域收到墙线（见头注④）====================
// 只削桥身段，两个基地圈原样保留。削出来的这份才是地图真正发布的 navgrid，
// `HA_NAVGRID_FROST_WIDE` 从此只是它的原料（也仍然是量墙线用的那份底图）。
const TRIMMED_BITS = NAV_BITS.slice();
for (let gy = 0; gy < NAV_N; gy++) {
  for (let gx = 0; gx < NAV_N; gx++) {
    const i = gy * NAV_N + gx;
    if (!TRIMMED_BITS[i]) continue;
    const wx = (gx + 0.5) / NAV_N * WORLD, wy = (gy + 0.5) / NAV_N * WORLD;
    const rx = wx - BLUE_NEXUS.x, ry = wy - BLUE_NEXUS.y;
    const d = rx * U.x + ry * U.y;
    if (d <= BASE_CIRCLE_R || d >= BRIDGE_LEN - BASE_CIRCLE_R) continue;   // 基地圈不动
    const off = rx * Nrm.x + ry * Nrm.y;
    if (Math.abs(off) > (off >= 0 ? WALL_OFF_LEFT : WALL_OFF_RIGHT)) TRIMMED_BITS[i] = 0;
  }
}
const HA_NAVGRID_FROST = { n: NAV_N, bits: packBits(TRIMMED_BITS) };

/**
 * 生成一侧（sign=+1 或 -1）的柱子序列与相邻柱子间的墙段——整侧统一用 `off`
 * 这一个偏移量（见头注①：墙是直线，不逐柱子贴合每一像素的凹凸）。
 *
 * 柱子本身也过一遍"脚下有没有桥"（用发布版 navgrid 判，与渲染层同一份数据）：
 * 当前这份地形下 13 根柱子全部站得住（缺口两端那两根正好踩在凹口的唇边上，
 * 于是"柱子还立着、中间的墙塌了"这个观感是几何自然出来的，不是摆出来的），
 * 这道过滤是防止以后改 navgrid 时悄悄冒出一根浮在水面上的柱子。
 * @returns { pillars: [{x,y,d}], segments: [{from,to,mid,len,angle}], inward, groundProbe }
 */
function bridgeSide(sign, off) {
  const inward = { x: -sign * Nrm.x, y: -sign * Nrm.y };
  const pillars = GAP_D
    .map((d) => ({ ...P(d, sign * off), d }))
    .filter((p) => bitsWalkable(TRIMMED_BITS,
      p.x + inward.x * WALL_GROUND_PROBE, p.y + inward.y * WALL_GROUND_PROBE));
  const segments = [];
  for (let i = 0; i < pillars.length - 1; i++) {
    const a = pillars[i], b = pillars[i + 1];
    segments.push({
      from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y },
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      len: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x), // 世界坐标系里的朝向（弧度），渲染层换算成 Three.js 的 rotation.y
    });
  }
  return { pillars, segments, inward, groundProbe: WALL_GROUND_PROBE };
}

const leftSide = bridgeSide(+1, WALL_OFF_LEFT);
const rightSide = bridgeSide(-1, WALL_OFF_RIGHT);

export const FROST_BRIDGE = {
  // 两侧分开存（渲染层需要区分"墙面朝哪个方向"来贴合桥沿，不能揉成一个数组）。
  left: leftSide,
  right: rightSide,
};

export const howling_abyss_frost = {
  id: 'howling_abyss_frost_v1',
  label: '嚎哭深渊·冰封',
  factions: [FACTIONS.BLUE, FACTIONS.RED],
  visualStyle: 'stylized',   // 复用风格化渲染分支（TerrainLayer/VegetationLayer 的 stylized 分支）
  paletteId: 'frost',        // 见 CONFIG.stylizedPalettes.frost

  world: { w: 2325, h: 2325 },
  useNavgrid: true,
  // v0.6 起改用略微加宽的位图（原图的形态学膨胀版本，只给这张图用，见
  // map_navgrids.js 里 HA_NAVGRID_FROST_WIDE 的头注）——原图 howling_abyss_v1
  // 的 navgrid 完全不受影响，这张图从此不再"逐位复用原图"，是它自己的一份数据。
  // v0.7 起发布的是在它基础上"收到墙线"的版本（见上面头注④）：墙外侧那圈桥沿
  // 看得见但走不上去，墙重新是真正的碰撞边界。
  navgrid: HA_NAVGRID_FROST,
  // 只用来画地面形状的位图（见 TerrainLayer.visualWalkOf 头注）：地面按**收边前**
  // 的宽度画，可走判定按上面收过边的 navgrid 走——于是石墙外侧留着一圈看得见、
  // 走不上去的桥沿，墙看起来是站在桥面上的，不是贴在桥的最外沿。
  visualNavgrid: HA_NAVGRID_FROST_WIDE,
  walls: { river: false },
  highground: {},            // 本图无高低差，逐位照抄原图

  // obstacles 仍然对齐 BASE_GAP_OFF（原始 140，跟原图完全一致）——这份数据描述的是
  // "桥本来在哪变窄"，是原始桥形的属性，不随这次装饰用的墙外移而改变（而且这个
  // 字段本身当前没有被任何仿真/渲染代码消费，纯粹是历史沿革数据，见设计文档 v0.2）。
  obstacles: GAP_D.flatMap((d) => [{ ...P(d, +BASE_GAP_OFF), r: 26 }, { ...P(d, -BASE_GAP_OFF), r: 26 }]),

  frostBridge: FROST_BRIDGE,
  // 火炬光源坐标——直接复用 26 根石柱的位置。`torchPoints()`（见
  // src/presentation/torchPlacement.js）"地图自己声明的优先"，声明了这个字段
  // 之后就不会再对本图做程序化撒点（程序化撒点只会撒在可走区域=桥面上，
  // 跟火炬实际挂在墙上的位置对不上）。这样火炬的光照直接接入现成的
  // 火炬灯光池（ThreeRenderer.torchLights/_syncTorchLights），不用另起一套。
  torches: [...FROST_BRIDGE.left.pillars, ...FROST_BRIDGE.right.pillars].map((p) => ({ x: p.x, y: p.y })),

  baseCenters: { blue: { x: 292, y: 2033 }, red: { x: 2033, y: 292 } },
  baseCircleRadius: BASE_CIRCLE_R,

  neutralCamps: [{
    id: 'dragon', unitType: 'dragon', label: '巨龙',
    spawnPoints: [
      { pitRef: 'baron', laneMatch: 'top', direction: 'reverse' },
      { pitRef: 'dragon', laneMatch: 'bot', direction: 'forward' },
    ],
  }],

  waveInterval: 30,
  firstWaveDelay: 30,
  spawnGap: 0.55,
  nexusRespawnTime: 300,

  tierStats: {
    outer:      { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 5100, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 0.833 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  skillOverrides: {
    'tower:base':     { passive_base_fortify: { regen: 0 }, passive_iron_line: { durationSec: 0 } },
    'tower:hq_tower': { passive_hq_fortify:   { regen: 0 } },
  },

  globalAura: {
    name: '嚎哭深渊光环', icon: '❄️',
    effects: [
      { statKey: 'healShieldPowerPct', flat: -80, label: '治疗与护盾强度' },
      { statKey: 'manaGainPct', flat: -50, label: '法力获取' },
    ],
  },

  lanes: [
    {
      id: 'mid',
      waypoints: [BLUE_NEXUS, R(BLUE_NEXUS)],
      spawns: [
        { faction: FACTIONS.BLUE, direction: 'forward', targetFactions: [FACTIONS.RED] },
        { faction: FACTIONS.RED, direction: 'reverse', targetFactions: [FACTIONS.BLUE] },
      ],
    },
  ],

  buildings: [
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: B.outer,      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: B.base,       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: B.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_a,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_b,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: 'mid', pos: BLUE_NEXUS,   weapon: null },
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: R(B.outer),      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: R(B.base),       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: R(B.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_a),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_b),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: 'mid', pos: R(BLUE_NEXUS),   weapon: null },
  ],
};
