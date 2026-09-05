import { FACTIONS } from '../../systems/FactionSystem.js';
import { HA_NAVGRID_FROST_WIDE } from './map_navgrids.js';
import { unpackBits } from '../navgrid.js';

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

// ==================== v0.6：桥面拓宽，墙跟着外移，墙即碰撞边界（用户拍板方案） ====================
// 用户："把桥的宽度向两边略微扩大，墙也跟着外移，把墙作为体积碰撞的边界"。
// 已用 AskUserQuestion 跟用户对齐技术方案：新描一份更宽的 navgrid 只给冰封版用
// （`HA_NAVGRID_FROST_WIDE`，原图 navgrid 完全不动，见 map_navgrids.js 头注）。
//
// 柱子/墙的偏移量**不是**一个写死的常量（比如"140+27"）——手描的真实桥形本来
// 就不是恒定半宽（越靠近两个基地越宽，中段本身也有 ±20 左右的自然起伏，
// 见设计文档 v0.5 的实测记录），钉死一个常量会让墙在某些弧长位置贴着可走区域
// （太挤，看着像在桥面上），在另一些位置又离得老远（太空，起不到"边界"作用）。
// 改成**直接从新 navgrid 数据里量出每个缺口弧长处的真实可走边界**：沿 `P(d, ·)`
// 的法向从中线向外扫描，扫到第一个不可走格就是这个弧长处的真实半宽——柱子/
// 墙紧贴这条量出来的边界摆，天然贴合每一段桥自己的宽度，不需要单独维护一份
// "每个缺口该留多少偏移"的表。这份量出来的边界只在**模块加载时算一次**（13
// 个弧长 × 2 侧 = 26 次扫描，每次最多几百步，可忽略的开销），不是每帧算。
const NAV_N = HA_NAVGRID_FROST_WIDE.n;
const NAV_BITS = unpackBits(HA_NAVGRID_FROST_WIDE.bits, NAV_N);
const WORLD = 2325;
function navWalkable(x, y) {
  const gx = Math.floor(x / WORLD * NAV_N), gy = Math.floor(y / WORLD * NAV_N);
  if (gx < 0 || gy < 0 || gx >= NAV_N || gy >= NAV_N) return false;
  return NAV_BITS[gy * NAV_N + gx] === 1;
}
/** 沿弧长 d 处的法向，从中线向 sign（+1/-1）方向扫描，找可走区域的真实边界（世界单位）。 */
function edgeOffset(d, sign) {
  const STEP = 2, MAX_OFF = 380;
  let off = 0;
  while (off < MAX_OFF) {
    const p = P(d, sign * (off + STEP));
    if (!navWalkable(p.x, p.y)) break;
    off += STEP;
  }
  return off;
}

/**
 * 生成一侧（sign=+1 或 -1）的柱子序列与相邻柱子间的墙段——每根柱子的偏移量
 * 都是从新 navgrid 单独量出来的（见上面 edgeOffset），不是统一的常量。
 * @returns { pillars: [{x,y,d}], segments: [{from,to,mid,angle}] }
 */
function bridgeSide(sign) {
  const pillars = GAP_D.map((d) => ({ ...P(d, sign * edgeOffset(d, sign)), d }));
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
  return { pillars, segments };
}

const leftSide = bridgeSide(+1);
const rightSide = bridgeSide(-1);

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
  navgrid: HA_NAVGRID_FROST_WIDE,
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
  baseCircleRadius: 330,

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
