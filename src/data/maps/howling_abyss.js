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
  // 布局复刻 LoL：抑制器（召唤水晶）在基地口外的桥上，抑制塔（水晶塔）在它前面护着，外塔推在前线。
  // 塔射程 180。相邻攻击塔沿线间距 380 > 2×180，射程圈完全分开（本项目一贯要求）。
  //
  // 重做（用户："高地那里水晶塔/召唤水晶往外一些"）：沿线距离
  //   召唤水晶 320 → 470，水晶塔 428 → 580。外塔不动（960）、枢纽双塔不动。
  // 于是"水晶塔→外塔"间距从 532 收到 380（仍 > 360，射程圈不重叠），
  // 而"基地口→召唤水晶"拉开了 —— 高地那一段不再挤成一坨，推高地要真的走一段桥。
  //
  // ⚠️ 枢纽双塔（hq_a/hq_b）第一版被我一起往外挪了 —— 那是错的。
  // 它们是【刻意成对】的：间距 114.6 < 射程 180，所以贴脸打其中一座的近战会被另一座打到
  // （峡谷的注释里写的是同一条设计，见 sim_accept 的"一塔可掩护另一塔"）。
  // 挪到偏移 ±95 后间距变成 189.5 > 180，互相掩护当场失效，而画面上完全看不出来。
  // 用户要往外挪的是水晶塔/召唤水晶，不是枢纽塔。已还原为偏移 ±57.3（沿线 d=124）。
  nexus_main: { x: 164,  y: 2161 },
  hq_a:       { x: 292,  y: 2114 },  // 沿线 d=124，垂直偏移 +57.3（双塔间距 114.6 < 射程 180）
  hq_b:       { x: 211,  y: 2033 },  // 沿线 d=124，垂直偏移 −57.3
  nexus_lane: { x: 496,  y: 1829 },  // d=470（原 320）
  base:       { x: 574,  y: 1751 },  // d=580（原 428），距召唤水晶 110
  outer:      { x: 843,  y: 1482 },  // d=960，距水晶塔 380 > 360
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
  // ==================== 重做：它是一座【窄桥】，不是两块大平台 ====================
  // 改动前 baseOpenRadius = 788：可行走区 = 走廊 ∪ 两个半径 788 的大圆，
  // 于是双方基地各有一块直径 1576 的巨型开阔地 —— 那不是嚎哭深渊，是"两个广场中间连了根线"。
  // 参考图 assets/maps/Howling_Abyss_map.png 上很清楚：整张图就是一条窄桥横跨深渊，
  // 基地只是桥两端的一小块平台，桥外全是掉下去的虚空。
  //
  // ⚠️ 第一版我改成了 300，那也是错的：基地圈的**圆心是世界角点 (0,2325)，不是水晶枢纽**
  // （枢纽本身就离角点 232）。于是 300 的圈连两座枢纽塔（离角点 360）都装不下，
  // 我却在注释里按"离枢纽 130"算，得出"装得下"的结论 —— 量错了基准点。
  // 现在取 460：枢纽塔（360）稳稳在圈内、离圈沿 100；两侧墙角离塔 149 ≤ 射程 180
  // （入口被火力封锁）；而召唤水晶离角点 701 > 460，仍在圈外的桥面上。
  // 顺带说明旧值 788 为什么一定错：788 > 701，召唤水晶被广场吞进去了，
  // 「抑制器在桥上」这条 ARAM 的基本形态根本没成立过。
  walls: { corridorHalfWidth: 135, river: false }, // 桥面半宽（全图唯一可走的带）
  baseCircleRadius: 460,
  baseOpenRadius: 460,
  // 守着基地开口的是哪一档塔。峡谷是水晶塔(base)；本图水晶塔已被挪到桥上，
  // 把口的换成了枢纽塔(hq_tower)。测试按这个字段找"高地塔"，不再假定一定是 base。
  gateTier: 'hq_tower',
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
