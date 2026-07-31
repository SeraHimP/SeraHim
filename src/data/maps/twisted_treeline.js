import { FACTIONS } from '../../systems/FactionSystem.js';
import { TT_NAVGRID } from './map_navgrids.js';

/**
 * twisted_treeline.js —— 扭曲丛林（双路 + 中间野区）
 *
 * 参考图：assets/maps/Twisted_Treeline_Minimap.png（标准小地图 752×752）
 *
 * ==================== 地形：逐像素描图，不是走廊模型 ====================
 * 走廊模型（折线 + 半宽 + 基地圆）**画不出野区**：野区是一整片开阔地里散着 9 块草丛/岩壁，
 * 不是"几条走廊"。而且基地是一块被弧形墙围住、上下两个口子的高地，也不是一个圆。
 * 所以本图改用 navgrid，地形从小地图逐像素描出来，
 * walls.corridorHalfWidth / baseCircleRadius / baseOpenRadius / baseCenters 全部删除。
 *
 * 从小地图上认出来的结构（用户确认）：
 *   · 整体是**花生 / 沙漏**：两端宽、腰部窄（兵线到中轴的距离：基地端 123px、腰部 73px）
 *   · 上下两条兵线贴着外缘走，**中间整片是野区**，野区里 9 块棕色 = 草丛/岩壁（不可走）
 *   · 左右两端各一块**高地**，被弧形墙围住，**入口在上下两侧**（即高地塔所在处）
 *   · 蓝方高地里：水晶枢纽（青色菱形）在右，**枢纽塔紧贴它左边** —— 用户原话
 *     "枢纽塔的位置靠着水晶枢纽（蓝方在左，红方在右）"
 *
 * 世界坐标：采样矩形 [0,236]-[751,582] = 752×347 → world 3008×1388（整 ×4，不拉伸）。
 *   world_x = img_x × 4，world_y = (img_y − 236) × 4
 * 地图中轴（img y=402）落在 world y = 664。左右镜像轴 world x = 1504。
 */

const M = (p) => ({ x: 3008 - p.x, y: p.y });     // 红方 = 左右镜像（本图左右对称，不是中心对称）
const AXIS = 664;                                  // 上下镜像轴
const F = (p) => ({ x: p.x, y: 2 * AXIS - p.y });  // 上下镜像

// 上路兵线（蓝半程 + 腰部），路点是从小地图逐列量出来的兵线中心线。
// 起点先从高地出口(600,336)出去再上行——直接从枢纽拉一条到 (592,172) 会形成 84° 的死弯。
// 高地北口的位置是**扫出来的**，不是估的：沿 x 扫可走区间，
//   x=520 → y 36-600 / 608-696   x=560 → y 20-696（整列通）   x=600 → y 20-320 / 452-696
// 也就是弧墙在 x≈600 处挡住 y 320~452，而 x≈556 是那个口子。走 600 会直接撞墙
// （第一版就是这样：上路 9% 的采样点落在墙里，小兵到高地口就走不动）。
const TOP_HALF = [
  { x: 584, y: 676 },                       // 蓝方水晶枢纽
  { x: 556, y: 520 }, { x: 556, y: 300 },   // 穿过高地北口（x≈556 整列可走）
  { x: 592, y: 172 }, { x: 720, y: 160 }, { x: 848, y: 176 },
  // 腰部：中间那块大草丛把可走区切成上下两条（x=1504 处：上 36~300、下 372~604）。
  // 上路必须走【上面那条】—— 我按小地图量的 y=372 正好压在草丛边缘上，
  // 小兵一到腰部就撞墙（实测上路 4% 的采样点在墙里）。可走区间是扫出来的，不是估的。
  { x: 976, y: 232 }, { x: 1104, y: 240 }, { x: 1232, y: 230 },
  { x: 1360, y: 210 }, { x: 1504, y: 190 },
];
const LANE_TOP = [
  ...TOP_HALF,
  ...TOP_HALF.slice(0, -1).reverse().map(M),
];
const LANE_BOT = LANE_TOP.map(F);

// 蓝方建筑。水晶枢纽/枢纽塔是从小地图上直接读出来的像素位置。
const B = {
  nexus_main: { x: 584, y: 676 },   // 青色菱形，img(146,405)
  hq_tower:   { x: 460, y: 672 },   // 紧贴枢纽左侧的圆盘，img(115,404)；距枢纽 124 < 射程 180
};

export const twisted_treeline = {
  id: 'twisted_treeline_v1',
  label: '扭曲丛林',
  world: { w: 3008, h: 1388 },

  // ==================== 地形 ====================
  useNavgrid: true,
  navgrid: TT_NAVGRID,
  walls: { river: false },

  // 基地光环圈：**只是玩法/视觉的圈，不再参与地形判定**（地形归 navgrid 管，
  // MapSystem.isWalkable 走 navgrid 分支时根本不看这两个字段）。
  // 不声明的话 getBaseCircleRadius 会退回"按世界角点反推"，画出一个跟基地毫不相干的
  // 巨圈 —— 用户看到的"基地圈可视化乱七八糟"就是这个。圆心显式给到水晶枢纽上。
  baseCenters: { blue: { x: 584, y: 676 }, red: { x: 2424, y: 676 } },
  baseCircleRadius: 300,

  // === 波次节奏 ===
  waveInterval: 35,
  firstWaveDelay: 25,
  spawnGap: 0.55,
  nexusRespawnTime: 240,

  // 本图专属建筑数值（用户指定，本次地形重做未改动）
  tierStats: {
    outer:      { maxHP: 1750, shieldFixedMax: 0, healthRegen: 0,  armor: 100, magicResist: 100, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0,  armor: 100, magicResist: 100, attackDamage: 170, baseAttackSpeed: 1.25 },
    hq_tower:   { maxHP: 3750, shieldFixedMax: 0, healthRegen: 10, armor: 100, magicResist: 100, attackDamage: 150, baseAttackSpeed: 2.50 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 10, armor: 20,  magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 10, armor: 0,   magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 成长：只有攻击力成长、从开局起算（用户指定）
  skillOverrides: {
    'tower:outer':    { passive_growth_outer: { adStartT: 0 } },
    'tower:base':     { passive_growth_base:  { adStartT: 0 } },
    'tower:hq_tower': { passive_growth_hq:    { adStartT: 0 } },
  },

  lanes: [
    { id: 'top', waypoints: LANE_TOP },
    { id: 'bot', waypoints: LANE_BOT },
  ],

  // ⚠️ 本次只重做地形。除水晶枢纽/枢纽塔（从小地图直接读出）外，
  // 各路的外塔/水晶塔/召唤水晶仍按沿兵线弧长临时摆放，等地形定稿后再按小地图逐个对位。
  buildings: (() => {
    const L = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const acc = [0];
    for (let i = 1; i < LANE_TOP.length; i++) acc.push(acc[i - 1] + L(LANE_TOP[i - 1], LANE_TOP[i]));
    const at = (s) => {
      for (let i = 1; i < acc.length; i++) {
        if (acc[i] >= s) {
          const t = (s - acc[i - 1]) / (acc[i] - acc[i - 1]);
          return { x: Math.round(LANE_TOP[i - 1].x + (LANE_TOP[i].x - LANE_TOP[i - 1].x) * t),
                   y: Math.round(LANE_TOP[i - 1].y + (LANE_TOP[i].y - LANE_TOP[i - 1].y) * t) };
        }
      }
      return LANE_TOP[LANE_TOP.length - 1];
    };
    const spots = { nexus_lane: at(640), base: at(800), outer: at(1180) };
    const out = [];
    for (const [tier, w, sk] of [['outer', 'piercing', 'passive_growth_outer'],
                                 ['base', 'piercing', 'passive_growth_base'],
                                 ['nexus_lane', null, null]]) {
      for (const lane of ['top', 'bot']) {
        const p = lane === 'top' ? spots[tier] : F(spots[tier]);
        out.push({ faction: FACTIONS.BLUE, tier, laneId: lane, pos: p, weapon: w, skills: sk ? [sk] : undefined });
        out.push({ faction: FACTIONS.RED, tier, laneId: lane, pos: M(p), weapon: w, skills: sk ? [sk] : undefined });
      }
    }
    out.push({ faction: FACTIONS.BLUE, tier: 'hq_tower', laneId: null, pos: B.hq_tower, weapon: 'piercing', skills: ['passive_growth_hq'] });
    out.push({ faction: FACTIONS.RED, tier: 'hq_tower', laneId: null, pos: M(B.hq_tower), weapon: 'piercing', skills: ['passive_growth_hq'] });
    out.push({ faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: null, pos: B.nexus_main, weapon: null });
    out.push({ faction: FACTIONS.RED, tier: 'nexus_main', laneId: null, pos: M(B.nexus_main), weapon: null });
    return out;
  })(),
};
