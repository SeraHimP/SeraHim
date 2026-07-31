import { FACTIONS } from '../../systems/FactionSystem.js';
import { HA_NAVGRID } from './map_navgrids.js';

/**
 * howling_abyss.js —— 嚎哭深渊（单路，一条横跨深渊的冰桥）
 *
 * 参考图：assets/maps/Howling_Abyss_Minimap.png（标准小地图 512×512）
 *
 * ==================== 地形：逐像素描图，不是走廊模型 ====================
 * 用户原话："真正的嚎哭深渊两端有那个圆吗？？难道不是变成更宽的桥了吗？？"
 * ——**没有圆**。之前两端那两个圆是【走廊模型】硬造出来的：
 * 走廊模型 = 一条折线 + 半宽 + 两端各一个 baseCircleRadius 的圆，
 * 它**结构上就画不出**"等宽直桥 + 两端变宽"这种形状，调什么参数都没用。
 *
 * 现在改成 navgrid（和召唤师峡谷同一套）：地形直接从小地图逐像素描出来，
 * 走廊半宽 / 基地圈这几个字段一并删除（留着只会与 navgrid 打架）。
 *
 * 从小地图上量出来的桥（沿桥 s = (x−y)/√2，垂直 t = (x+y)/√2，图 512×512）：
 *   · 桥心 t = 362 恒定 —— 桥是**笔直**的，正好压在图的反对角线上
 *   · 中段（|s| ≲ 190）宽 84~88 px
 *   · 两端（|s| 216~290）宽 145~146 px  ← 这就是"变宽的那一截"，即基地
 *   · 再往外收成尖角（99 → 51 → 3），桥端斜切收口
 *   · 全长 s∈[−360, +360] = 720 px
 * 桥两侧那一串棕色方块 = 用户说的"上桥的缺口"，见下面 obstacles。
 *
 * 世界坐标：采样矩形是 510×510 的正方形 → world 也必须是正方形，取 2325²（比例 4.5588）。
 * 换算后桥心 = 世界反对角线 **x + y = 2325**，蓝方在左下、红方在右上。
 */

// 沿桥单位向量（蓝→红）与其法向
const U = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };   // (0.7071, −0.7071)
const Nrm = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
const BLUE_NEXUS = { x: 292, y: 2033 };            // s = −270（两端变宽段的中间）
/** 沿桥弧长 d、垂直偏移 off 处的世界坐标 */
const P = (d, off = 0) => ({
  x: Math.round(BLUE_NEXUS.x + U.x * d + Nrm.x * off),
  y: Math.round(BLUE_NEXUS.y + U.y * d + Nrm.y * off),
});
const R = (p) => ({ x: 2325 - p.x, y: 2325 - p.y });   // 红方 = 绕地图中心 180° 旋转

// 建筑沿桥位置（弧长 d）。相邻攻击塔间距 > 2×射程(360)，射程圈不重叠 —— 本项目一贯要求。
//   枢纽塔 110（双塔垂直偏移 ±57，间距 113 < 射程 180，可互相掩护）
//   召唤水晶 370 ／ 水晶塔 480（贴水晶后方 110）／ 外塔 850（距水晶塔 370 > 360）
const B = {
  hq_a:       P(110, +57),
  hq_b:       P(110, -57),
  nexus_lane: P(370),
  base:       P(480),
  outer:      P(850),
};

export const howling_abyss = {
  id: 'howling_abyss_v1',
  label: '嚎哭深渊',
  world: { w: 2325, h: 2325 },

  // ==================== 地形 ====================
  // useNavgrid + 自带位图：MapSystem 逐格判可走，不再有走廊/基地圈。
  useNavgrid: true,
  navgrid: HA_NAVGRID,
  walls: { river: false },   // 深渊是冰桥，没有河道（地形层据此不画水带）

  // 桥两侧的缺口 —— 小地图上那一串棕色方块。用户："上桥的缺口（用障碍物替代）"。
  // 贴着桥的两条边、沿桥等距排布；按沿桥弧长 d + 垂直偏移 off 声明，r = 碰撞半径。
  // 偏移 ±175：桥中段半宽 ≈ 196（图上 86px ÷2 ×4.56），所以这一排刚好贴在桥沿内侧，
  // 每隔一段把桥面掐窄一次 —— 这才是"缺口"的作用。
  //（第一版误把图像像素当世界单位填了 ±58，结果两排障碍压在兵线上。）
  // 偏移取 ±140：桥中段偏窄处 ±150 以上会有两个点掉出桥面（实测扫过 120/130/140 全在桥上，150/160 各掉 2 个），
  // 落在虚空里的障碍等于没有。这里用地图自己的 isWalkable 逐个验过。
  obstacles: [280, 440, 600, 760, 920, 1080, 1240, 1400, 1560, 1720, 1880, 2040, 2180]
    .flatMap((d) => [{ ...P(d, +140), r: 26 }, { ...P(d, -140), r: 26 }]),

  // === 波次节奏 ===
  waveInterval: 30,
  firstWaveDelay: 30,
  spawnGap: 0.55,
  nexusRespawnTime: 300,
  minionNoRend: true,        // Q9：本图小兵不装配屠戮被动

  // 本图专属建筑数值（Q9 指定，未随本次地形重做改动）
  tierStats: {
    outer:      { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 3750, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    hq_tower:   { maxHP: 2750, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 0.833 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 10, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 10, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 兵线 = 桥心那条直线（全长 2462）。桥是直的，两个端点就够，不需要中间路点。
  lanes: [
    { id: 'mid', waypoints: [BLUE_NEXUS, R(BLUE_NEXUS)] },
  ],

  buildings: [
    // ========== 蓝方（左下） ==========
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: B.outer,      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: B.base,       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: B.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_a,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_b,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: 'mid', pos: BLUE_NEXUS,   weapon: null },
    // ========== 红方（右上，中心对称） ==========
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: R(B.outer),      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: R(B.base),       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: R(B.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_a),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_b),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: 'mid', pos: R(BLUE_NEXUS),   weapon: null },
  ],
};
