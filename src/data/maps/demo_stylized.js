import { FACTIONS } from '../../systems/FactionSystem.js';

/**
 * demo_stylized.js —— 风格化画面 demo 地图（探路，非正式地图）
 *
 * 2026-09-04：用户想直接看一版"低多边形+纯色+粗描边"方向落到 SeraHim 现有渲染
 * 管线上的效果，衡量成本大不大，同时明确表示"可以新建地图（不是像 LoL 那种的），
 * 这都随便"——所以这张图不追求召唤师峡谷式的三路野区迷宫，走最简单的单路走廊
 * 模型（跟 howling_abyss.js 同一套 `walls.corridorHalfWidth` 机制，不需要逐像素
 * 描 navgrid 位图），世界故意留宽，两侧留出大片"野区"给风格化的树/岩装饰。
 *
 * 只有这张图把 `visualStyle` 设成 'stylized'——渲染层（VegetationLayer/
 * TerrainLayer/WallLayer）按这个字段分支，三张正式地图这个字段是 undefined，
 * 走原来的分支，画面逐位不变（见 CONFIG.stylizedVisuals 头注）。
 *
 * 建筑/塔位数值直接照抄 howling_abyss.js 的档位表——不是这次要评估的东西，
 * 复用一份已经验证过间距/校验规则的配置，省得给一张 demo 图重新调数值。
 */

const WORLD = { w: 4200, h: 1500 };
const BLUE_NEXUS = { x: 300, y: 750 };
const RED_NEXUS = { x: 3900, y: 750 };
const LANE = [BLUE_NEXUS, RED_NEXUS];

/** 沿蓝→红方向、弧长 d 处的世界坐标（单路水平直线，公式与 howling_abyss.js 的 P() 同款） */
const P = (d) => ({ x: BLUE_NEXUS.x + d, y: 750 });
const R = (p) => ({ x: WORLD.w - p.x, y: p.y });   // 红方 = 沿世界中轴镜像

const B = {
  hq_a: { x: P(300).x, y: 700 },
  hq_b: { x: P(300).x, y: 800 },
  nexus_lane: P(560),
  base: P(760),
  // 1400：sim_maps.mjs 的通用地图几何校验要求①同阵营同路相邻攻击塔档位间距
  // > 2×射程(360)（base→outer 需要 outer_d − base_d > 360）②双方外塔射程圈无
  // 交集且中间留出真正的战斗区（净空 > 400）。1400 落在两条约束的合法区间
  // (1120, 1600) 中间，留了余量，不是卡着边界。这条校验适用于所有地图，
  // 不是这张 demo 图的特例——被它拦下说明地图数据本身不合理，不是测试要迁就。
  outer: P(1400),
};

export const demo_stylized = {
  id: 'demo_stylized_v1',
  label: '风格化 Demo',
  factions: [FACTIONS.BLUE, FACTIONS.RED],
  visualStyle: 'stylized',   // 唯一驱动这张图走风格化渲染分支的字段

  world: WORLD,
  walls: { corridorHalfWidth: 110 },
  baseCenters: { blue: BLUE_NEXUS, red: R(BLUE_NEXUS) },
  baseCircleRadius: 340,

  // 数值照抄 howling_abyss.js 的 tierStats/skillOverrides——这张图不评估数值，
  // 直接复用一份已知能跑的配置。
  tierStats: {
    outer:      { maxHP: 2250, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 152, baseAttackSpeed: 0.833 },
    base:       { maxHP: 5100, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 0.833 },
    hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 0.833 },
    nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
    nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  },

  lanes: [
    {
      id: 'mid',
      waypoints: LANE,
      spawns: [
        { faction: FACTIONS.BLUE, direction: 'forward', targetFactions: [FACTIONS.RED] },
        { faction: FACTIONS.RED, direction: 'reverse', targetFactions: [FACTIONS.BLUE] },
      ],
    },
  ],

  buildings: [
    { faction: FACTIONS.BLUE, tier: 'outer',      laneId: 'mid', pos: B.outer,      weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'base',       laneId: 'mid', pos: B.base,       weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'nexus_lane', laneId: 'mid', pos: B.nexus_lane, weapon: null },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_a,       weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'hq_tower',   laneId: 'mid', pos: B.hq_b,       weapon: 'piercing' },
    { faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: 'mid', pos: BLUE_NEXUS,   weapon: null },
    { faction: FACTIONS.RED, tier: 'outer',      laneId: 'mid', pos: R(B.outer),      weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'base',       laneId: 'mid', pos: R(B.base),       weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'nexus_lane', laneId: 'mid', pos: R(B.nexus_lane), weapon: null },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_a),       weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'hq_tower',   laneId: 'mid', pos: R(B.hq_b),       weapon: 'piercing' },
    { faction: FACTIONS.RED, tier: 'nexus_main', laneId: 'mid', pos: R(BLUE_NEXUS),   weapon: null },
  ],
};
