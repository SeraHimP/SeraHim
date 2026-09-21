import { FACTIONS } from '../../systems/FactionSystem.js';

/**
 * tower_balance_test.js —— 防御塔强度横向测试场
 *
 * ==================== 这张图是干什么的 ====================
 * 用户原话："再做一个塔平衡的脚本，在这个测试中，红蓝方中随机某一方为进攻方，
 * 进攻方的所有防御塔获得90%伤害减免并且获得1000%伤害增幅（进攻方所有防御塔
 * 武器设置为闪电杖），进攻方所有小兵额外获得33%伤害减免。防守方一切正常。
 * 这个地图是用来测试防御塔强度的，就是通过设置防守方所有防御塔的武器类型来
 * 横向判断防御塔的武器强度。"
 *
 * 设计思路：真正"横向对照防御塔武器强度"的那把尺子（谁是进攻方、进攻方拿什么
 * 增益、防守方这一局用哪种塔武器）**不属于地图本身**——进攻方是每局随机指派的
 * 蓝或红，不是这张图能静态声明的东西；防守方武器是"每一档测哪种"，同一张图
 * 要跑 8 档（塔武器一共 8 种），也不该往地图文件里塞 8 份。这些全部交给配套的
 * tools/balance_tower.mjs 在跑起来之后按局覆写（与 balance_matrix.mjs 现有的
 * "地图是中立舞台，覆写在脚本里按档位施加"是同一个架构，不是新发明一套）。
 *
 * 所以这张图本身其实就是一张**干净、对称、只服务于这一个测试目的**的最小地图——
 * 不需要好看，也不需要野区/多路这类复杂度，双方各一路、几档塔够把"外塔→内塔→
 * 高地→水晶枢纽"这条推进链跑全就行。结构直接照抄 demo_stylized.js 那张同样是
 * "探路/工具用途、不用来正常游玩"的最小地图（单路走廊、6 建筑/每方），
 * 只重新起了 id/label，塔位坐标沿用同一套间距公式（同阵营同路相邻攻击塔档位
 * 间距需 > 2×射程，双方外塔射程圈不重叠且留净空——sim_maps.mjs 的通用地图
 * 几何校验会钉住这条，新地图加进 MAPS 自动被检查，不需要在这个文件里重新讲一遍）。
 *
 * weapon 字段都先给 'piercing' 当占位默认值——不是测试要用的值，只是让这张图
 * 在没有 balance_tower.mjs 介入的情况下（比如在地图编辑器里手动打开看一眼）
 * 也是一张能正常跑的合法地图，真正的武器覆写完全由脚本按档位施加。
 */

const WORLD = { w: 4200, h: 1500 };
const BLUE_NEXUS = { x: 300, y: 750 };
const RED_NEXUS = { x: 3900, y: 750 };
const LANE = [BLUE_NEXUS, RED_NEXUS];

const P = (d) => ({ x: BLUE_NEXUS.x + d, y: 750 });
const R = (p) => ({ x: WORLD.w - p.x, y: p.y });

const B = {
  hq_a: { x: P(300).x, y: 700 },
  hq_b: { x: P(300).x, y: 800 },
  nexus_lane: P(560),
  base: P(760),
  outer: P(1400),
};

export const tower_balance_test = {
  id: 'tower_balance_test_v1',
  label: '防御塔强度测试场',
  factions: [FACTIONS.BLUE, FACTIONS.RED],

  world: WORLD,
  walls: { corridorHalfWidth: 110 },
  baseCenters: { blue: BLUE_NEXUS, red: R(BLUE_NEXUS) },
  baseCircleRadius: 340,

  // 数值照抄 demo_stylized.js / howling_abyss.js 的 tierStats——这张图不评估
  // 这套基础数值本身，评估的是"武器"这一个维度，复用一份已知能跑的配置。
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
