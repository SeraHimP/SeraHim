// 巨龙的刷新节奏与强度曲线 —— DragonSystem 与模板编辑器**共用这一份实现**。
//
// 为什么单独拆一个模块：编辑器要给出"改完这条龙会变多强"的预览，而预览一旦
// 自己抄一份公式，就迟早和引擎跑偏（本仓库出过四份抄写的塔层级解析，
// 抄的时候都对、改的时候只改一处就错）。所以走 waveComposition.js 同样的路子：
// 引擎和面板导入同一个函数，预览不可能骗人。
//
// 这里的默认值是从 DragonSystem 源码里搬过来的写死值，逐位不变；
// CONFIG.gameRules.dragon 缺项时回落到它们，所以老存档导进来行为也一致。
import { CONFIG } from './Config.js';

export const DRAGON_DEFAULTS = {
  firstDelay: 300,   // v51.4：60 → 300，与 CONFIG.gameRules.dragon.firstDelay 保持同一份默认值
  elementIntervals: [420, 480, 540],
  ancientFirstDelay: 300,
  ancientInterval: 600,
  curve: {
    // 用户定稿：上调前期龙强度——起始值(base)整体调高。
    // 攻击力这次单独给了 3 个校准点（第1/4/8条=102/270/500），按这三点反解
    // 出 step/lateStep：knee=4 时 step=(270-102)/3=56，lateStep=(500-270)/4=57.5——
    // 两段增幅接近持平（56→57.5），不是明显收窄的"上升幅度下降"，因为这条曲线
    // 引擎只支持两段折线（base+step 到 knee，之后换 lateStep），三个点里只要
    // 中间那个不在正中央，两段斜率就很难差很多；如果要更明显的减速增长需要
    // 三段式或非线性曲线，那是另一次改动，这次先按给定的三个校准点原样实现。
    maxHP:        { base: 1600, step: 600,     knee: 4, lateStep: 500, cap: null },
    resist:       { base: -15,  step: 80,      knee: 4, lateStep: 30,  cap: 500 },
    attackDamage: { base: 102,  step: 56,      knee: 4, lateStep: 57.5, cap: null },
  },
  ancient: { hpMult: 1.15, resistAdd: 40, adMult: 1.1 },
};

/** 当前生效的巨龙配置（未配的键回落到出厂值）。 */
export function dragonCfg() {
  const d = (CONFIG.gameRules && CONFIG.gameRules.dragon) || {};
  return {
    firstDelay: d.firstDelay ?? DRAGON_DEFAULTS.firstDelay,
    elementIntervals: (Array.isArray(d.elementIntervals) && d.elementIntervals.length)
      ? d.elementIntervals : DRAGON_DEFAULTS.elementIntervals,
    ancientFirstDelay: d.ancientFirstDelay ?? DRAGON_DEFAULTS.ancientFirstDelay,
    ancientInterval: d.ancientInterval ?? DRAGON_DEFAULTS.ancientInterval,
    curve: {
      maxHP: { ...DRAGON_DEFAULTS.curve.maxHP, ...(d.curve?.maxHP || {}) },
      resist: { ...DRAGON_DEFAULTS.curve.resist, ...(d.curve?.resist || {}) },
      attackDamage: { ...DRAGON_DEFAULTS.curve.attackDamage, ...(d.curve?.attackDamage || {}) },
    },
    ancient: { ...DRAGON_DEFAULTS.ancient, ...(d.ancient || {}) },
  };
}

/**
 * 分段线性曲线：拐点 knee 之前每条 +step，之后每条 +lateStep，最后按 cap 截顶。
 * 三条属性（生命/双抗/攻击）形状相同、只有系数不同，所以只写一次。
 */
export function dragonCurveAt(spec, w) {
  const knee = spec.knee ?? 4;
  const v = w <= knee
    ? spec.base + (w - 1) * spec.step
    : spec.base + (knee - 1) * spec.step + (w - knee) * spec.lateStep;
  return (spec.cap == null) ? v : Math.min(v, spec.cap);
}

/**
 * 第 dragonIndex 条龙的绝对属性。
 * 注意 index 是【第几条龙】而不是游戏波次 —— 早期版本用 window.waveNumber 算，
 * 而龙是按固定时间表刷的，7 分钟后刷第 2 条龙时波次可能已到 10+，
 * 数值直接失控（双抗几百）。这个口径不要再改回去。
 */
export function dragonStatsAt(dragonIndex, isAncient) {
  const c = dragonCfg();
  const w = Math.max(1, dragonIndex);
  let hp = dragonCurveAt(c.curve.maxHP, w);
  let res = dragonCurveAt(c.curve.resist, w);
  let ad = dragonCurveAt(c.curve.attackDamage, w);
  if (isAncient) {                                   // 远古龙仅轻微上升
    hp *= c.ancient.hpMult; res += c.ancient.resistAdd; ad *= c.ancient.adMult;
  }
  return {
    maxHP: Math.round(hp), armor: Math.round(res),
    magicResist: Math.round(res), attackDamage: Math.round(ad),
  };
}

/**
 * 下一条龙的刷新间隔（秒）。elementSpawned/ancientSpawned 是"已刷新条数"。
 * 元素龙的间隔按下标取，越界沿用最后一项 —— 用户往数组里多加/少加几项都不会
 * 拿到 undefined（那会让 nextDragonTime 变 NaN，龙永远刷不出来且不报任何错）。
 */
export function dragonIntervalAt({ soulUnlocked, elementSpawned = 0, ancientSpawned = 0 }) {
  const c = dragonCfg();
  if (soulUnlocked) return ancientSpawned <= 1 ? c.ancientFirstDelay : c.ancientInterval;
  const arr = c.elementIntervals;
  const n = Math.max(1, elementSpawned);
  return arr[Math.min(n - 1, arr.length - 1)];
}
