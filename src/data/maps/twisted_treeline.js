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
// （上下镜像函数已删除：小地图上两条路并不对称，下路必须单独量）

// 上路兵线（蓝半程 + 腰部）。路点 = 从小地图逐列采样【浅色路面】取的中心线。
//
// ⚠️ 用户指出："上路不是从最顶上那个路走的！那个是野区！从上面的第二条路走！"
// 小地图上有两种蓝：**浅紫白 = 兵线路面**，**中蓝 = 野区**。到了地图中段，
// 浅色那条会【从上方那块草丛的下面绕过去】，而草丛【上面】贴着外墙的那条是野区。
// 我第一版量对了（腰部 img y≈356），第二版发现 y=372 world 压在草丛边缘上，
// 就把腰部整段往上挪到 world 190 —— 那正好挪进了野区，错得更离谱。
// 正确值是 world 480（img 356）：在草丛【下面】那条带里，离边界很远。
//
// 高地北口的位置是扫出来的：沿 x 扫可走区间，x=600 处弧墙挡住 y 320~452，x≈556 整列通。
// ⚠️ 基地段（前 5 个点）**重描过一次**。用户："高地那里贴地形太近了，特别容易卡小兵"，
// 并画了参考线。量出来的确实如此 —— 沿兵线逐点采样"到最近墙格的距离"（净空）：
//     旧上路 高地北口段：36px      旧下路 高地南口段：42~48px
//     其余路段：72~144px           小兵半径 10、队形横向间距 20~30
// 也就是说那两段只有别处的 1/3，一波兵挤进去必卡。
// 根因是旧线沿 x=556 直上直下，正好擦着高地弧墙向西鼓出来的那一块（墙边在 x≈592）。
// 新线改走【基地开阔区的脊线】：对每一行 y 扫出净空最大的 x，那条脊在 x≈420~500，
// 净空 150~250px。这里取比脊线略偏东一点，让水晶塔/召唤水晶落在兵线【旁边】
// 55~60px 处（LoL 里塔本来就贴着兵线站），而不是像旧线那样离 124~137px 远得像野塔。
// 重描后：上路基地段净空 108~150px、下路 120~138px，最大转角 41°/42°（仍 < 70°）。
const TOP_HALF = [
  { x: 584, y: 676 },                       // 蓝方水晶枢纽
  { x: 520, y: 604 }, { x: 490, y: 486 },   // 沿开阔区脊线向西北，绕开弧墙的鼓包
  { x: 474, y: 362 }, { x: 496, y: 252 },   // 经过水晶塔(432,292)东侧 55px
  { x: 572, y: 194 }, { x: 650, y: 172 },   // 出口拐弯拆两段，单角 < 45°
  { x: 720, y: 168 }, { x: 848, y: 192 },
  { x: 976, y: 280 }, { x: 1104, y: 336 }, { x: 1232, y: 392 },
  { x: 1360, y: 456 }, { x: 1504, y: 480 },   // 腰部：从中间那块大草丛【下面】绕过去
];
// 下路**单独量**，不是上路的上下镜像 —— 小地图上这两条并不严格对称
// （img x=372 处：上路中心离中轴 46px、下路 100px）。镜像出来的下路有 21% 的采样点落在墙里。
const BOT_HALF = [
  { x: 584, y: 676 },                       // 蓝方水晶枢纽
  { x: 520, y: 752 }, { x: 490, y: 870 },   // 与上路同理走脊线（数值仍是分别量的，不是镜像）
  { x: 474, y: 994 }, { x: 500, y: 1100 },  // 经过召唤水晶(428,896)/水晶塔(428,1060)东侧 58~60px
  { x: 576, y: 1152 }, { x: 652, y: 1170 },
  { x: 720, y: 1176 }, { x: 848, y: 1168 },
  { x: 976, y: 1144 }, { x: 1104, y: 1120 }, { x: 1232, y: 1104 },
  { x: 1360, y: 1072 }, { x: 1504, y: 1064 },  // 腰部：从下面那块大草丛【上面】绕过去
];
const mirror = (half) => [...half, ...half.slice(0, -1).reverse().map(M)];
const LANE_TOP = mirror(TOP_HALF);
const LANE_BOT = mirror(BOT_HALF);

// 蓝方基地里的 6 个点位 —— **全部是从标准小地图上量出来的像素位置**（用户在图上圈出并确认）：
//   红圈：青色菱形 = 水晶枢纽 img(146,405)；紧贴它左边的小圆 = 枢纽塔 img(121,403)
//   橙圈（4 个，上下各一对，x 都在 107~108）：外侧的是水晶塔、内侧的是召唤水晶
//     上外 img(108,309) 上内 img(108,349) ／ 下内 img(107,460) 下外 img(107,501)
// 换算 world_x = img_x×4，world_y = (img_y−236)×4。
//
// ⚠️ 注意这张图的基地布局和 LoL 常规**相反**：水晶枢纽在最前（靠敌方），
// 枢纽塔、水晶塔、召唤水晶依次在它【后方】。这是用户反复确认过的图上事实，不是笔误。
const B = {
  nexus_main: { x: 584, y: 676 },   // 红圈·青色菱形
  hq_tower:   { x: 484, y: 668 },   // 红圈·贴着菱形左侧的小圆；距枢纽 100 < 射程 180
  top: { base: { x: 432, y: 292 }, nexus_lane: { x: 432, y: 452 } },   // 橙圈①②
  bot: { nexus_lane: { x: 428, y: 896 }, base: { x: 428, y: 1060 } },  // 橙圈③④
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

  // 高地范围。用户定稿："扭曲丛林你可以做一个圆"、"效果就是从水晶塔前面就是斜坡，
  // 枢纽那里都是高地"。**圆心放水晶枢纽**，满高半径 420、外扩 140 斜坡（总半径 560）。
  // 420 是反推的，不是拍的：
  //   水晶塔离枢纽 413（上 hypot(152,384) / 下 hypot(156,384)）→ 必须落在满高区内 → full > 413
  //   枢纽塔 100、召唤水晶 270、水晶枢纽 0 —— 全在满高区
  //   兵线从外面进基地依次经过离枢纽 499 → 452 → 357，正好走完一整段斜坡
  // 上一版用的是"过水晶塔的一条竖线"半平面，位置对不上用户画的圆，已改。
  highground: {
    blue: { center: { x: 584, y: 676 }, full: 420 },
    red:  { center: { x: 2424, y: 676 }, full: 420 },
    ramp: 140,
  },

  // === 波次节奏 ===
  waveInterval: 35,
  firstWaveDelay: 25,
  spawnGap: 0.55,
  nexusRespawnTime: 240,

  // 本图专属建筑数值（用户指定）。
  // 用户本轮定稿：水晶塔(base) 双抗 100 → 125、枢纽塔(hq_tower) 双抗 100 → 200。
  tierStats: {
    outer:      { maxHP: 1750, shieldFixedMax: 0, healthRegen: 0,  armor: 100, magicResist: 100, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0,  armor: 125, magicResist: 125, attackDamage: 170, baseAttackSpeed: 1.25 },
    hq_tower:   { maxHP: 3750, shieldFixedMax: 0, healthRegen: 10, armor: 200, magicResist: 200, attackDamage: 150, baseAttackSpeed: 2.50 },
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

  // 塔位：水晶枢纽/枢纽塔/水晶塔/召唤水晶 **全部从标准小地图逐个量出**（见上面 B）；
  // 只有外塔小地图上没标，仍按沿兵线弧长取点。
  buildings: (() => {
    // 每条路各自沿【自己的】折线按弧长取点 —— 上下两条不是镜像关系（见上面的说明），
    // 用上路的点镜像下来会落在墙里。
    const atOn = (wps) => {
      const L = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
      const acc = [0];
      for (let i = 1; i < wps.length; i++) acc.push(acc[i - 1] + L(wps[i - 1], wps[i]));
      return (s) => {
        for (let i = 1; i < acc.length; i++) {
          if (acc[i] >= s) {
            const t = (s - acc[i - 1]) / (acc[i] - acc[i - 1]);
            return { x: Math.round(wps[i - 1].x + (wps[i].x - wps[i - 1].x) * t),
                     y: Math.round(wps[i - 1].y + (wps[i].y - wps[i - 1].y) * t) };
          }
        }
        return wps[wps.length - 1];
      };
    };
    const at = { top: atOn(LANE_TOP), bot: atOn(LANE_BOT) };
    const out = [];
    // 水晶塔 / 召唤水晶：**直接用从小地图量出来的坐标**，不再按弧长估。
    for (const lane of ['top', 'bot']) {
      for (const [tier, sk] of [['base', 'passive_growth_base'], ['nexus_lane', null]]) {
        const p = B[lane][tier];
        const w = tier === 'base' ? 'piercing' : null;
        out.push({ faction: FACTIONS.BLUE, tier, laneId: lane, pos: p, weapon: w, skills: sk ? [sk] : undefined });
        out.push({ faction: FACTIONS.RED, tier, laneId: lane, pos: M(p), weapon: w, skills: sk ? [sk] : undefined });
      }
    }
    // 外塔仍按弧长取点（小地图上没标外塔）。用户："现有的外塔位置稍微往内侧移动一些"
    // → 弧长 1180 收到 1010（往自家方向挪约 170）。
    // ⚠️ 基地段重描之后弧长口径变了：新线绕开高地弧墙走了个更大的弧，
    // 从枢纽到出口比旧线长了约 96px。若继续用 1010，外塔会跟着往自家方向再缩 90px ——
    // 而用户这次只要求改兵线、没要求动塔位。所以把 OUTER_D 重锚到 1106，
    // 让两条路的外塔**落回原来那两个点**（上路 1085,328 / 下路 1128,1117，实测偏差 1px）。
    const OUTER_D = 1106;
    for (const lane of ['top', 'bot']) {
      const p = at[lane](OUTER_D);
      out.push({ faction: FACTIONS.BLUE, tier: 'outer', laneId: lane, pos: p, weapon: 'piercing', skills: ['passive_growth_outer'] });
      out.push({ faction: FACTIONS.RED, tier: 'outer', laneId: lane, pos: M(p), weapon: 'piercing', skills: ['passive_growth_outer'] });
    }
    out.push({ faction: FACTIONS.BLUE, tier: 'hq_tower', laneId: null, pos: B.hq_tower, weapon: 'piercing', skills: ['passive_growth_hq'] });
    out.push({ faction: FACTIONS.RED, tier: 'hq_tower', laneId: null, pos: M(B.hq_tower), weapon: 'piercing', skills: ['passive_growth_hq'] });
    out.push({ faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: null, pos: B.nexus_main, weapon: null });
    out.push({ faction: FACTIONS.RED, tier: 'nexus_main', laneId: null, pos: M(B.nexus_main), weapon: null });
    return out;
  })(),
};
