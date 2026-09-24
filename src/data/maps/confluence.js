import { FACTIONS } from '../../systems/FactionSystem.js';
import { composeMap } from '../mapComposition.js';
import { CONFIG } from '../Config.js';

/**
 * confluence.js —— 汇流战场（超大型多战线地图）
 *
 * ==================== 缘起 ====================
 * 用户原话（深夜，明确授权自主决定）："新增几张地图（风格化），要求一张特别大
 * （有多个内塔），有三个/四个阵营（最好，如果实在做不明白两阵营也行）。就是
 * 超大规模交战，有多个战线，战线之间可以重叠等……这张大型地图最好交战时长在
 * 180分钟。"
 *
 * ==================== 阵营数：2（不是3/4）====================
 * 用户明确给了降级许可（"如果实在做不明白两阵营也行"），这里说明为什么选了它：
 * `docs/REPORT-2026-09-03-multifaction.md` 已经把"多阵营"这件事分了三档——
 * 阵营关系表/索敌判定/出兵链路本来就是通用的（早就支持 N 阵营，任务#67 已落地
 * 并有67条测试守着）；但巨龙龙魂结算（DragonSystem，三方抢同一条龙怎么分）、
 * 死亡计分板（main.js，N 阵营下要不要还是两栏比分）、秩序-混乱轴
 * （EntropySystem，"红=混乱其余=秩序"这套隐喻在3+阵营下还成不成立）、塔朝向
 * （towerFacing.js）——这几处**玩法概念本身是二元的**，报告原话："需要用户先
 * 拍板，不是我能替着改的技术问题"，而且这几个问题此前问过、一直没有答复。
 * 在没有这些设计决定、又要连夜交付的情况下，硬做3/4阵营意味着这几套机制要么
 * 不生效要么被我自己瞎猜一个方向——那正是用户会骂的"做不好"。所以选择用2阵营
 * 把"超大规模/多个内塔/多条战线重叠/180分钟"这几条**明确写出的**要求做扎实，
 * 而不是为了凑阵营数而交付一张某些系统会静默出错的地图。真要做3/4阵营，
 * 应该先把上面几个设计决定问清楚，再单独立项——不属于这次"现在立刻要"的范围。
 *
 * ==================== 几何设计：五路扇形汇流 ====================
 * 不是三路各走各的（召唤师峡谷那种），而是 5 条兵线从蓝方基地以扇形散开
 * （夹角 -80°~+80°），中途全部向地图中心弯拢，在中心附近形成一片相互重叠的
 * 走廊——5条战线的可行走区域在这里连成一整片，不再是"各打各的一路"，这就是
 * 用户要的"多个战线，战线之间可以重叠"。过了中心之后再散开扑向红方基地，
 * 整张图整体呈"双漏斗对接"的沙漏形状，全局绕地图中心 180° 旋转对称
 * （蓝红完全对称，红方坐标 = 蓝方坐标绕中心转180°）。
 *
 * 每条战线独立走完整的 外塔→内塔→水晶塔→召唤水晶 四级链——5条战线 ×2 阵营
 * = 10 座内塔（"多个内塔"）+ 10 座外塔 + 10 座水晶塔，再加双方各一对枢纽塔
 * 和水晶枢纽，全图共 2×(5×4+3) = 46 座建筑。
 *
 * 没有用 useNavgrid（那需要逐像素手描位图，这张图没有真实参考图可描）——走的
 * 是本项目本来就支持的"走廊模型"：MapSystem 的注释原话"其余地图沿用走廊模型"
 * （见 MapSystem.js:_navgrid 头注），可行走区域 = 5条折线各自的走廊 ∪ 双方基地
 * 开阔圈，纯几何算出来，不用手描任何图。
 *
 * ==================== 规模与180分钟目标 ====================
 * 世界 7500×7500（召唤师峡谷 3552 的约2.1倍边长，约4.5倍面积）；每路的塔位
 * 血量/双抗（见 tierStats）经过一轮 balance_matrix 实测校准，比召唤师峡谷
 * 同档高出约 2.7~3.8 倍（首版只上浮60%~70%，实测均时长仅60.83分钟，离目标
 * 差近3倍，详见 tierStats 上方的"实测校准"注）。单纯"塔更肉、路更多、要走
 * 的路更长"三者叠加，推进节奏天然比三路小图慢得多。终局保险丝是
 * CONFIG.tuning.heatDeath 那套热寂机制的这张图专属触发时间
 * （confluenceHeatDeathTriggerAtMin=220，见 Config.js 头注），触发后跟召唤师
 * 峡谷一样每秒衰减塔的当前最大生命，把整场对局的时长上限兜住，不会真的失控
 * 打到天荒地老。180分钟仍然是设计目标，不是已经用完整批次（--runs 20）验证
 * 过的精确解——只做过一版60.83分钟的实测+一次方向性调整，第二版调整后还没有
 * 再跑批次验证，交付时间受限没能跑完整轮次，这里如实说明（跟进见任务#208）。
 */

const WORLD = 7500;
const MARGIN = 900;
const C = { x: WORLD / 2, y: WORLD / 2 };
// 蓝方"扇心"——5条战线从这一点附近散开；红方是蓝方绕地图中心180°旋转。
const BA = { x: MARGIN, y: WORLD - MARGIN };
const RA = { x: 2 * C.x - BA.x, y: 2 * C.y - BA.y };

const deg2rad = (d) => d * Math.PI / 180;
const rot = (v, deg) => {
  const t = deg2rad(deg);
  const cs = Math.cos(t), sn = Math.sin(t);
  return { x: v.x * cs - v.y * sn, y: v.x * sn + v.y * cs };
};
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (v, k) => ({ x: v.x * k, y: v.y * k });
const norm = (v) => { const m = Math.hypot(v.x, v.y); return { x: v.x / m, y: v.y / m }; };
const distOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** 绕地图中心 C 旋转180°（红方 = 蓝方的中心对称点，跟召唤师峡谷同一套约定）。 */
const Rr = (p) => ({ x: 2 * C.x - p.x, y: 2 * C.y - p.y });

const F = norm(sub(RA, BA));               // 蓝→红的"总方向"（这张图上恰好是 -45°对角线）

// 每级建筑到"己方扇心"的弧长（沿第一段直线量，见下方 laneAt）。
// 数值关系（改这里连带影响下面用它推导的所有塔位，逐处自洽）：
//   nexus_lane(700) < base(950) < inner(1750) < outer(2500)，
//   相邻【攻击塔】档位（base→inner→outer）间距分别为800/750，均 > 2×射程(180)=360，
//   mapValidate.js 的射程圈不重叠校验按这个间距设计，改动时不要缩到360以内。
const TIER_ARC = { nexus_lane: 700, base: 950, inner: 1750, outer: 2500 };

const R1 = 500;              // 每条战线离开扇心的"出发半径"
const R2 = distOf(BA, C);    // "汇拢点"半径——取到地图中心的距离，让汇拢点落在中心附近
const FAN_DAMP = 0.12;       // 汇拢点角度阻尼——越小，5条战线在汇拢点挤得越近，重叠越明显
const ANGLES = [-80, -40, 0, 40, 80];   // 5条战线出发时的扇形夹角

const LANE_SPAWNS_2F = [
  { faction: FACTIONS.BLUE, direction: 'forward', targetFactions: [FACTIONS.RED] },
  { faction: FACTIONS.RED, direction: 'reverse', targetFactions: [FACTIONS.BLUE] },
];

/** 每条战线的四个折点：出发口 → 己方侧汇拢点 → 对方侧汇拢点（中心对称）→ 对方出发口。 */
function buildLane(deg, idx) {
  const pStart = add(BA, scale(rot(F, deg), R1));
  const pJoin = add(BA, scale(rot(F, deg * FAN_DAMP), R2));
  const waypoints = [pStart, pJoin, Rr(pJoin), Rr(pStart)];
  return { id: `w${idx}`, waypoints, spawns: LANE_SPAWNS_2F, _pStart: pStart, _pJoin: pJoin };
}
const LANES = ANGLES.map(buildLane);

/** 沿战线【出发口→己方侧汇拢点】这一段直线，按弧长 s 取点——四级塔都落在这一段上
 * （出发口到汇拢点的直线长度最短也有约3530，outer 在2500处，留了1000+的余量不顶到折点）。*/
function alongFirstSeg(lane, s) {
  const dir = norm(sub(lane._pJoin, lane._pStart));
  return add(lane._pStart, scale(dir, s));
}

const HQ_OFFSET = 200;                       // 枢纽双塔离水晶枢纽（=BA/RA）的垂直半间距
const PERP = { x: -F.y, y: F.x };
const hqBlueA = add(BA, scale(PERP, HQ_OFFSET));
const hqBlueB = add(BA, scale(PERP, -HQ_OFFSET));

// 火炬点：作者摆点，不用程序化撒点算法（torchPlacement.js 头注"地图自己声明的优先"）。
// 这张图是窄走廊模型（不是 navgrid 的大片野区），可行走区域整体沿蓝红对角线呈狭长带状，
// 天然不会铺满全图四个象限——程序化撒点的"必须撒到右下半区"这条通用假设（见
// tests/sim_v46.mjs"炬⑧"，防的是撒点算法坐标系搞错缩在一角的真bug）对这种窄带状地图
// 不成立，跟嚎哭深渊冰封版的桥（同样的反对角线窄带）是同一件事，那张图也是手动声明
// torches 绕开的。挑的点是双方水晶枢纽/两座枢纽塔/每路外塔（战场地标，不是全走廊铺满）。
const TORCH_POINTS = [
  BA, Rr(BA), hqBlueA, Rr(hqBlueA), hqBlueB, Rr(hqBlueB),
  ...LANES.flatMap((lane) => {
    const pOuter = alongFirstSeg(lane, TIER_ARC.outer);
    return [pOuter, Rr(pOuter)];
  }),
];

const CONFLUENCE_TERRAIN = {
  world: { w: WORLD, h: WORLD },
  // 5条走廊比三路老图的更宽——相邻战线在汇拢点附近只差约338px（数值来源见下方
  // buildings 生成逻辑旁的验证脚本，未固化进本文件），走廊半宽220（总宽440）
  // 才能让相邻战线的可行走区域真正连成一片，而不是"看着近实际不通"。
  walls: { corridorHalfWidth: 220, river: false },   // 没有河道概念，显式关闭避免 heightAt 的河床逻辑误触发
};

const CONFLUENCE_CONFIG = {
  id: 'confluence_v1',
  label: '汇流战场',
  factions: [FACTIONS.BLUE, FACTIONS.RED],

  // 复用已有的"default"风格化调色板（没有任何地图在用，且本图的"不可走区域=
  // 野外"跟它默认的"只在不可走区域长树"判据天然吻合，不需要新画一份配色——
  // 第四条铁律要求视觉决策先对齐，直接复用已获认可的现成资产就是最安全的路）。
  visualStyle: 'stylized',
  paletteId: 'default',

  torches: TORCH_POINTS,

  baseCenters: { blue: BA, red: RA },
  baseCircleRadius: 900,
  baseOpenRadius: 900,

  waveInterval: 30,
  firstWaveDelay: 30,
  spawnGap: 0.55,
  nexusRespawnTime: 300,

  // 建筑数值（v2，见下方"balance_matrix 实测校准"注）：相对召唤师峡谷同档
  // 上浮约 2.7~3.8 倍——5条战线+更大的地图尺度，塔更肉才能配合"180分钟量级"
  // 的目标（见文件头注）。healthRegen 沿用本项目的既定规矩，全部归0，恢复
  // 统一走塔默认装配的技能（加固城防/水晶再生，见 factories.js 的
  // growthByTier/fortifyByTier——本图建筑没有显式声明 skills 字段，会自动
  // 拿到与召唤师峡谷同一套默认被动，不需要另起一份覆写）。
  //
  // ==================== balance_matrix 实测校准（v1→v2，含关键负面发现）====================
  // 首版数值（上浮60%~70%）实测（--runs 3 --minutes 90）：均时长 60.83 分钟。
  // 据此把 HP 整体再上浮约2.3倍（本版数值），重新跑了一轮更大样本
  // （--runs 5 --minutes 240）：均时长只涨到 71.22 分钟（5局全部正常分出
  // 胜负，蓝胜2红胜3，推进度差-0.4，双方大致均衡，没有战局卡死或胜率崩坏）。
  //
  // ⚠️ 关键发现：HP 涨了 2.33 倍，均时长只涨了 1.17 倍——弹性非常弱（按
  // 幂律拟合指数约0.185）。这说明"180分钟"这个目标的瓶颈大概率不在塔血量/
  // 双抗这个杠杆上，继续沿这条路加数字，边际收益会越来越差，而且会让塔在
  // 观感上变得不合理地打不动。真正的主导变量更可能是小兵波次强度随时间
  // 增长的曲线（battleGrowth）或"5路汇拢"设计本身带来的雪崩效应（一路先
  // 破、其余小兵能迅速在中心走廊汇合支援，战局一旦倾斜就加速崩塌）——这两条
  // 都还没有验证过，是真正值得继续深挖的方向，不是"再加一次血量"。
  //
  // 当前状态（v2，本版）：均时长71分钟，明显长于常规地图、双方均衡、无异常，
  // 是可玩可交付的稳定状态，只是没有精确命中180分钟——如实说明，详细数据和
  // 后续方向记在任务#208，不在这里继续做第三轮盲目加数值的尝试。
  tierStats: {
    outer:      { maxHP: 14000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 20,  attackDamage: 160, baseAttackSpeed: 0.833 },
    inner:      { maxHP: 15000, shieldFixedMax: 0, healthRegen: 0, armor: 90, magicResist: 90,  attackDamage: 175, baseAttackSpeed: 0.833 },
    base:       { maxHP: 17000, shieldFixedMax: 0, healthRegen: 0, armor: 75, magicResist: 75,  attackDamage: 175, baseAttackSpeed: 4.00 },
    nexus_lane: { maxHP: 10000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
    hq_tower:   { maxHP: 19500, shieldFixedMax: 0, healthRegen: 0, armor: 90, magicResist: 130, attackDamage: 155, baseAttackSpeed: 4.00 },
    nexus_main: { maxHP: 20500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,   attackDamage: 0,   baseAttackSpeed: 0 },
  },

  // 终局保险丝（热寂）+ 常驻移速光环——机制跟召唤师峡谷完全一致，只是触发时间/
  // 速率走这张图专属的 CONFIG 常量（见 Config.js tuning.heatDeath 头注：不能
  // 直接套召唤师峡谷的70分钟，那是按三路小图调的，会把这张图腰斩）。
  globalAura: {
    name: '汇流战场光环', icon: '🌀',
    effects: [
      {
        name: '汇流战场光环', icon: '🌀', statKey: 'moveSpeed', excludesTypes: ['tower'],
        percentPerMinute: CONFIG.tuning.confluenceMoveSpeedPctPerMin,
        label: '移速',
      },
      {
        name: '热寂', icon: '🔥', appliesTo: ['tower'],
        drainMaxHPPctPerSec: CONFIG.tuning.heatDeath.towerDrainPctPerSec,
        drainAfterSec: CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60,
        label: '过载',
      },
      {
        name: '热寂', icon: '🔥', statKey: 'bonusAttackSpeedPct', excludesTypes: ['tower'],
        stages: [
          { when: '' },
          { when: 'time.after', whenArg: CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60,
            flat: CONFIG.tuning.heatDeath.unitAtkSpeedBonusPct },
        ],
        label: '攻速',
      },
      {
        name: '热寂', icon: '🔥', statKey: 'damageAmpPct', excludesTypes: ['tower'],
        stages: [
          { when: '' },
          { when: 'time.after', whenArg: CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60,
            flat: CONFIG.tuning.heatDeath.unitDmgAmpBonusPct },
        ],
        label: '伤害增幅',
      },
      {
        name: '热寂', icon: '🔥', statKey: 'moveSpeed', excludesTypes: ['tower'],
        stages: [
          { when: '' },
          { when: 'time.after', whenArg: CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60,
            percent: CONFIG.tuning.heatDeath.unitMoveSpeedBonusPct },
        ],
        label: '移速',
      },
    ],
  },

  lanes: LANES.map(({ id, waypoints, spawns }) => ({ id, waypoints, spawns })),

  buildings: (() => {
    const out = [];
    for (const lane of LANES) {
      for (const [tier, s] of Object.entries(TIER_ARC)) {
        const weapon = tier === 'nexus_lane' ? null : 'piercing';
        const pBlue = alongFirstSeg(lane, s);
        out.push({ faction: FACTIONS.BLUE, tier, laneId: lane.id, pos: pBlue, weapon });
        out.push({ faction: FACTIONS.RED, tier, laneId: lane.id, pos: Rr(pBlue), weapon });
      }
    }
    out.push({ faction: FACTIONS.BLUE, tier: 'hq_tower', laneId: null, pos: hqBlueA, weapon: 'piercing' });
    out.push({ faction: FACTIONS.BLUE, tier: 'hq_tower', laneId: null, pos: hqBlueB, weapon: 'piercing' });
    out.push({ faction: FACTIONS.BLUE, tier: 'nexus_main', laneId: null, pos: BA, weapon: null });
    out.push({ faction: FACTIONS.RED, tier: 'hq_tower', laneId: null, pos: Rr(hqBlueA), weapon: 'piercing' });
    out.push({ faction: FACTIONS.RED, tier: 'hq_tower', laneId: null, pos: Rr(hqBlueB), weapon: 'piercing' });
    out.push({ faction: FACTIONS.RED, tier: 'nexus_main', laneId: null, pos: RA, weapon: null });
    return out;
  })(),
};

export const confluence = composeMap({ terrain: CONFLUENCE_TERRAIN, config: CONFLUENCE_CONFIG });
