import { FACTIONS } from '../../systems/FactionSystem.js';

/**
 * howling_abyss.js（Q9）
 * 嚎哭深渊：单路地图，可理解为召唤师峡谷中路的简化版。
 *
 * 布局（每方从外到内）：外塔 → 水晶塔 → 召唤水晶 → 枢纽塔×2 → 水晶枢纽。
 * 世界尺寸与峡谷一致（3552²），兵线 = 枢纽对枢纽的对角直线；建筑沿线分布，
 * 枢纽双塔垂直于兵线两侧对称布置（偏移 95px，在塔射程 180 内覆盖兵线）。
 * 红方坐标 = 蓝方绕中心 180° 旋转（(x,y) → (3552-x, 3552-y)）。
 *
 * 数值（Q9 指定，经 tierStats 覆写全局默认）：
 *   外塔    增幅型  HP2250 双抗70 AD152 攻速0.833 回复0
 *   水晶塔  穿透型  HP3750 双抗70 AD170 攻速0.833 回复0 + 钢铁防线(永久30%减伤)
 *   枢纽塔  穿透型  HP2750 双抗70 AD150 攻速0.833 回复0
 *   （最新确认：全图除外塔为增幅型外均为穿透型；所有塔攻速统一 0.833）
 *   召唤水晶 HP4000 回复10 护甲20 魔抗0
 *   水晶枢纽 HP5500 回复10 双抗0
 * 塔成长统一为 passive_growth_ha：每分钟 +9攻击力/+1护甲/+1魔抗，开局起算，封顶14层。
 * 小兵沿用峡谷模板与波次成长，但不装配屠戮被动（minionNoRend）。
 */

const B = { // 蓝方沿线坐标（线方向 (0.7071,-0.7071)；d=距蓝枢纽的沿线距离，off=垂直偏移）
  // 布局复刻 LoL：抑制器（召唤水晶）紧贴基地口，抑制塔（水晶塔）就在它前面护着，外塔推在前线。
  // 塔射程 180。相邻攻击塔沿线间距 380 → 实际距离 379~396 > 2×180，射程圈完全分开（用户要求）。
  nexus_main: { x: 164,  y: 2161 },  // v34 Q1：收角（×0.82）
  hq_a:       { x: 292,  y: 2114 },  // v34 Q1：收角
  hq_b:       { x: 211,  y: 2033 },  // v34 Q1：收角
  nexus_lane: { x: 390,  y: 1935 },  // v34 Q1：距水晶塔 110（贴其后方）
  base:       { x: 467,  y: 1858 },  // v34 Q1：距高地入口精确180（射程外沿=入口）
  outer:      { x: 843,  y: 1482 },  // d=910（距水晶塔 379 > 360，两塔攻击圈无交集）
};
const R = (p) => ({ x: 2325 - p.x, y: 2325 - p.y }); // 180° 旋转（世界 2325）

export const howling_abyss = {
  id: 'howling_abyss_v1',
  label: '嚎哭深渊',
  // 几何按 LoL 复刻并经用户确认：
  //   · 中间战斗区 = 双方外塔【射程圈之间的净空】= 543px（= 4.5×射程 的 67%）
  //     → 双方外塔距离 = 543 + 2×180 = 904px
  //   · 相邻攻击塔间距 > 2×射程(360)，射程圈完全分开（此前 331/221 有轻微重叠）
  // 兵线全长 2723，世界 2325。
  world: { w: 2325, h: 2325 },

  // === Wave timing (classic defaults) ===
  waveInterval: 30,
  firstWaveDelay: 30,
  spawnGap: 0.55,
  nexusRespawnTime: 300,

  // v33（Q8）：嚎哭深渊同样启用走廊墙壁（单路，桥面略宽于峡谷路面）。
  // v34：river:false —— 深渊是冰桥，没有河道，地形层不画水带（用户 Q补充）。
  walls: { corridorHalfWidth: 135, river: false }, // v35 Q4：桥面 110→135
  baseCircleRadius: 788, // v39（Q1）：基地光环圈半径改为与高地地形半径(baseOpenRadius)一致——所见即所得（视觉+光环效果同步） // v34 Q1：显式声明（同峡谷，见 SR 注释）
  baseOpenRadius: 788, // v38.1：795→788——同 SR 规则（走廊两侧墙角 176/176 ≤ 射程180，全部贴住；塔距角 660 仍在高地内）
  minionNoRend: true, // Q9：本图小兵不装配屠戮被动

  // 本图专属建筑数值（覆盖 MapSystem 的全局 TIER_STATS）
  tierStats: {
    outer:      { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 3750, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    hq_tower:   { maxHP: 2750, shieldFixedMax: 0, healthRegen: 0,  armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 0.833 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 10, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 10, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  lanes: [
    { id: 'mid', waypoints: [ { x: 164, y: 2161 }, { x: 2161, y: 164 } ] }, // v35：端点同步新枢纽位置
  ],

  buildings: [
    // ========== 蓝方（左下） ==========
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: B.outer,      weapon: 'piercing', /* v33：增幅型已删除 */    skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: B.base,       weapon: 'piercing',  skills: ['passive_growth_ha', 'passive_iron_line_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: B.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_a,       weapon: 'piercing',  skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_b,       weapon: 'piercing',  skills: ['passive_growth_ha'] },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: 'mid', pos: B.nexus_main, weapon: null },
    // ========== 红方（右上，中心对称） ==========
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: R(B.outer),      weapon: 'piercing', /* v33：增幅型已删除 */    skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: R(B.base),       weapon: 'piercing',  skills: ['passive_growth_ha', 'passive_iron_line_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: R(B.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_a),       weapon: 'piercing',  skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_b),       weapon: 'piercing',  skills: ['passive_growth_ha'] },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: 'mid', pos: R(B.nexus_main), weapon: null },
  ],
};
