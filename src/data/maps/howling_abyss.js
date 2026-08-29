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

  // 基地光环圈：**只是玩法/视觉的圈，不再参与地形判定**（地形归 navgrid 管）。
  // 不声明的话 getBaseCircleRadius 会退回"按世界角点反推"，画出一个跟基地毫不相干的
  // 巨圈 —— 用户看到的"基地圈可视化乱七八糟"就是这个。圆心显式给到水晶枢纽上。
  baseCenters: { blue: { x: 292, y: 2033 }, red: { x: 2033, y: 292 } },
  baseCircleRadius: 330,

  // ⚠️ 本图**没有高低差**（用户定稿："嚎哭深渊无高低差但是有基地环"）——它就是一座平桥。
  // 声明成空对象而不是干脆不写：不写的话 heightAt 会退回"按基地圈抬一个圆台"的老分支，
  // 而上面那个 baseCircleRadius:330 又是为光环圈保留的，于是桥两端会凭空鼓起两个包。
  // 空对象走的是新分支，blue/red 都取不到 → 全图高度恒 0，正是要的。
  // 基地光环（玩法效果）不受影响，它走 towerPassives，与地形高度无关。
  highground: {},

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
  // （原来这里有 minionNoRend: true —— 本图小兵不装屠戮。用户本轮定稿
  //   "所有地图小兵默认装备屠戮"，该开关已删除，本图与召唤师峡谷同规则。）

  // 本图专属建筑数值（Q9 指定）。
  //
  // ⚠️ healthRegen 这一列**全是 0**，一个都不许写在这里。用户定稿：
  // "水晶塔默认无生命恢复，水晶和枢纽生命恢复都是10，而是都从XX防御塔加固城防/水晶恢复来实现"。
  // 原来 nexus_lane / nexus_main 各写了 10，而技能层的"水晶再生"**又给了一份 10**
  // —— 实测这两座拿到的是 **20**，召唤师峡谷同位置却是正确的 10。
  // 恢复的唯一来源改成技能层之后，这类"两处各加一份"的双计不可能再发生。
  tierStats: {
    outer:      { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 152, baseAttackSpeed: 0.833 },
    // 用户本轮定稿：水晶塔(base) 3750 → 5100、枢纽塔(hq_tower) 2750 → 4750
    base:       { maxHP: 5100, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 0.833 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 用户定稿："嚎哭深渊所有塔无生命恢复" —— 指四类【攻击塔】，
  // 召唤水晶/水晶枢纽仍由"水晶再生"给 10（用户确认："不包括，水晶仍然 10"）。
  // 加固城防的出厂恢复（水晶塔 1、枢纽塔 3）在这里按图覆写为 0；
  // 外塔/内塔版出厂就是 0，无需写。
  // v51.5：钢铁防线的限时/永久版合并成一条技能（passive_iron_line），
  // 这张图原来靠单独一条 passive_iron_line_ha 拿永久版，现在改成对同一条技能
  // 覆写 durationSec（<=0 = 永久），与下面 fortify 的 regen 覆写走同一套机制。
  skillOverrides: {
    'tower:base':     { passive_base_fortify: { regen: 0 }, passive_iron_line: { durationSec: 0 } },
    'tower:hq_tower': { passive_hq_fortify:   { regen: 0 } },
  },

  // ==================== 本图全局光环（用户定稿）====================
  // "嚎哭深渊所有单位（现有+待生成）持有光环（永久状态）：
  //   嚎哭深渊光环：所有单位治疗与护盾强度减少80%。"
  // "所有单位"= 真的所有（含防御塔与水晶，用户确认）。挂载与刷新见 MapSystem._applyGlobalAura。
  // 治疗与护盾强度是【接受方】的属性（见 core/healing.js 头注），所以 −80% 会同时压住
  // 生命恢复、固定护盾上限、生命偷取、伤害转化以及一切技能治疗 —— 本图的定位就是"血难回"。
  globalAura: {
    name: '嚎哭深渊光环', icon: '❄️',
    effects: [
      { statKey: 'healShieldPowerPct', flat: -80, label: '治疗与护盾强度' },
    ],
  },

  // 兵线 = 桥心那条直线（全长 2462）。桥是直的，两个端点就够，不需要中间路点。
  lanes: [
    { id: 'mid', waypoints: [BLUE_NEXUS, R(BLUE_NEXUS)] },
  ],

  buildings: [
    // ========== 蓝方（左下） ==========
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: B.outer,      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: B.base,       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: B.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_a,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_b,       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: 'mid', pos: BLUE_NEXUS,   weapon: null },
    // ========== 红方（右上，中心对称） ==========
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: R(B.outer),      weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: R(B.base),       weapon: 'piercing', skills: ['passive_growth_ha', 'passive_iron_line'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: R(B.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_a),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_b),       weapon: 'piercing', skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: 'mid', pos: R(BLUE_NEXUS),   weapon: null },
  ],
};
