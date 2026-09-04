import { FACTIONS } from '../../systems/FactionSystem.js';

/**
 * demo_stylized.js —— 风格化画面地图（低多边形+纯色+圆润树冠这条方向的落地图）
 *
 * 2026-09-04：用户对照 Thronefall 实机截图核实过画面方向后，先要了一版最小可跑的
 * demo（世界 4200×1500）验证成本，看完直接反馈"不用局限于特别小的地图，可以把
 * 地图做大，留很多余量"——这版把世界放大到 9000×5000，单路两侧留出大片开阔"野区"
 * 给风格化的树/岩铺开，不再是挤出来的一条窄带。仍然走最简单的单路走廊模型
 * （跟 howling_abyss.js 同一套 `walls.corridorHalfWidth` 机制，不需要逐像素描
 * navgrid 位图）——用户明确表示不追求召唤师峡谷式的三路野区迷宫，"我们游戏的
 * 核心是打来打去，舍弃 LoL 那种地图设计都无所谓"。
 *
 * 只有这张图把 `visualStyle` 设成 'stylized'——渲染层（VegetationLayer/
 * TerrainLayer/WallLayer）按这个字段分支，三张正式地图这个字段是 undefined，
 * 走原来的分支，画面逐位不变（见 CONFIG.stylizedVisuals 头注）。
 *
 * 建筑档位数值（tierStats/skillOverrides）直接照抄 howling_abyss.js——不是这次
 * 要评估的东西，复用一份已经验证过的配置，只重新摆了塔位坐标（间距规则见下面
 * outer 的注释）。
 */

const WORLD = { w: 9000, h: 5000 };
const BLUE_NEXUS = { x: 600, y: 2500 };
const RED_NEXUS = { x: 8400, y: 2500 };
const LANE = [BLUE_NEXUS, RED_NEXUS];

/** 沿蓝→红方向、弧长 d 处的世界坐标（单路水平直线，公式与 howling_abyss.js 的 P() 同款） */
const P = (d) => ({ x: BLUE_NEXUS.x + d, y: 2500 });
const R = (p) => ({ x: WORLD.w - p.x, y: p.y });   // 红方 = 沿世界中轴镜像

const B = {
  hq_a: { x: P(400).x, y: 2440 },
  hq_b: { x: P(400).x, y: 2560 },
  nexus_lane: P(750),
  base: P(1050),
  // 1900：sim_maps.mjs 的通用地图几何校验要求①同阵营同路相邻攻击塔档位间距
  // > 2×射程(360)（base→outer 需要 outer_d − base_d > 360，这里 850，余量很大）
  // ②双方外塔射程圈无交集且中间留出真正的战斗区（净空 > 400，这里净空 4000，
  // 留了"留很多余量"要求的那种量级）。这条校验适用于所有地图，不是这张图的
  // 特例——被它拦下说明地图数据本身不合理，不是测试要迁就。
  outer: P(1900),
};

export const demo_stylized = {
  id: 'demo_stylized_v1',
  label: '风格化地图',
  factions: [FACTIONS.BLUE, FACTIONS.RED],
  visualStyle: 'stylized',   // 唯一驱动这张图走风格化渲染分支的字段

  world: WORLD,
  walls: { corridorHalfWidth: 140 },
  baseCenters: { blue: BLUE_NEXUS, red: R(BLUE_NEXUS) },
  baseCircleRadius: 480,

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
