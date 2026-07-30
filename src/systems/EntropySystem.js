/**
 * EntropySystem.js —— 熵 / 三核（用户定稿：**三核总数恒为 8，互相争夺**）
 *
 * ============ 模型 ============
 * 世界上只有 8 颗核，一颗不多一颗不少。每颗核处于三种归属之一：
 *
 *   · 红核（red）   **未归属**。开局 8 颗全是红核 —— 世界是中性的。
 *   · 黑核（black） 归属混乱侧（红方）。
 *   · 白核（white） 归属秩序侧（蓝方）。
 *
 *   black + white + red ≡ 8    （不变量，任何操作后都必须成立）
 *   熵值   = 0.5 + (black − white) / (2 × 8)     → [0, 1]，8 黑=1.0，8 白=0.0
 *   波动   = 1 + (1 − red/8) × volatilityPct     → 未归属的核越少，世界越极化
 *
 * 争夺方式：击杀积累"充能"，每攒满 chargePerCore 点就**夺取一颗核**——
 * 优先从红核（未归属）里拿；红核拿光了就从对方手里抢。所以后期是真正的拉锯：
 * 想再前进一步，必须把对方已经拿到的核抢回来。
 *
 * ============ 为什么改成这个模型（上一版的问题）============
 * 上一版是三个**无上限的累加器** + 除以 scale 归一化。实测下来两个毛病：
 *   ① 用户反馈"红方占优太快"——摧毁一座塔 +25、scale 只有 100，
 *      推掉两座塔熵就顶到上限了，而衰减 0.6/s 根本追不上；
 *   ② 无上限意味着后期双方的核都是几千，差值主导一切，前期的争夺毫无意义。
 * 固定总数 8 从**结构上**解决这两点：熵值天然被 8 颗核量化（每颗核 = 6.25%），
 * 想推满必须连续夺取 8 次，而且每一次都越来越难（要从对方手里抢）。
 * 滚雪球在数学上不可能——总数守恒，一方的每一分优势都是另一方的损失。
 *
 * 默认 CONFIG.world.couplings.* 全关，全关时本模块只做统计、不产生任何修正。
 */
import { CONFIG } from '../data/Config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class EntropySystem {
  constructor(bus = null, entities = null) {
    this._bus = bus;
    this._entities = entities;
    this.reset();
    if (bus?.on) {
      this._onDeath = (payload) => this.onDeath(payload);
      bus.on('entity:death', this._onDeath);
    }
  }

  /** 读配置（全部软编码；缺项走这里的出厂值，不散落在各处）。 */
  get cfg() {
    const c = (CONFIG.world && CONFIG.world.entropy) || {};
    return {
      enabled: c.enabled !== false,
      coreTotal: c.coreTotal ?? 8,
      chargePerCore: c.chargePerCore ?? 120,
      chargeDecayPerSec: c.chargeDecayPerSec ?? 1.5,
      coreReturnSec: c.coreReturnSec ?? 90,
      min: c.clampMin ?? 0,
      max: c.clampMax ?? 1,
      gainMinion: c.gainMinion ?? 1,
      gainTower: c.gainTower ?? 20,
      gainDragon: c.gainDragon ?? 30,
      volatilityPct: c.volatilityPct ?? 12,
      nightStretchPct: c.nightStretchPct ?? 30,
    };
  }

  reset() {
    const total = this.cfg.coreTotal;
    // 开局 8 颗全未归属 —— 世界是中性的，谁也没有优势
    this.black = 0;
    this.white = 0;
    this.red = total;
    this._charge = { black: 0, white: 0 };
    this._returnTimer = 0;
  }

  /**
   * 夺取一颗核给 side。优先从未归属的红核拿；红核拿光了就从对方手里抢。
   * 返回是否真的夺到（双方都拿不出核时返回 false —— 已经推满了）。
   * **总数守恒**：这个函数是唯一改动核归属的地方，不变量只需在这里守住。
   */
  _takeCore(side) {
    const other = side === 'black' ? 'white' : 'black';
    if (this.red > 0) { this.red--; this[side]++; return true; }
    if (this[other] > 0) { this[other]--; this[side]++; return true; }
    return false;   // 8 颗全在自己手里，到顶了
  }

  /** 归还一颗核给未归属（均值回复）。从优势方手里拿，把世界推回中性。 */
  _returnCore() {
    const lead = this.black > this.white ? 'black' : (this.white > this.black ? 'white' : null);
    if (!lead || this[lead] <= 0) return false;
    this[lead]--; this.red++;
    return true;
  }

  /**
   * 一次死亡事件 → 给击杀方一侧充能。
   * 归因给【击杀方】而不是死亡方：熵衡量的是"谁在推动局面"，
   * 按死亡方记会把含义反过来（被打崩的一方反而推高自己的核）。
   */
  onDeath({ entityId, entity, faction, type } = {}) {
    const g = this.cfg;
    if (!g.enabled) return;
    // 总线上的 entity:death 只带 entityId（见 CombatSystem），阵营/类型得自己查。
    // 事件是在 purgeDead 之前发的，此刻实体还在容器里，查得到。
    const e = entity || (entityId != null ? this._entities?.get?.(entityId) : null);
    const victimFac = faction || e?._mapFaction || e?.faction;
    const victimType = type || e?.type;
    if (!victimFac) return;
    const killerFac = victimFac === 'blue' ? 'red' : 'blue';
    const side = killerFac === 'red' ? 'black' : 'white';

    let amount;
    if (victimType === 'tower') amount = g.gainTower;
    else if (victimType === 'dragon') amount = g.gainDragon;
    else amount = g.gainMinion;

    // 巨龙特例（报告里的"秩序压制混乱"）：击杀巨龙不是给自己充能，
    // 而是**归还一颗自己的核**，主动把世界推回中性。
    if (victimType === 'dragon') {
      if (this[side] > 0) { this[side]--; this.red++; }
      return;
    }

    this._charge[side] += amount;
    while (this._charge[side] >= g.chargePerCore) {
      this._charge[side] -= g.chargePerCore;
      // 夺不到核（已推满）时把充能清掉，不留着无限堆积 ——
      // 否则一旦对方抢回一颗，这边会瞬间连夺好几颗，观感是"突然翻盘"。
      if (!this._takeCore(side)) { this._charge[side] = 0; break; }
    }
  }

  /**
   * 每帧推进：充能衰减 + 定期归还核。
   * 两级衰减是有意的：充能衰减快（不持续压制就攒不满），核归还慢
   * （已经拿到的优势不会瞬间蒸发，但也不会永远保持）。
   */
  update(dt) {
    const g = this.cfg;
    if (!g.enabled) return;
    const d = g.chargeDecayPerSec * (dt || 0);
    this._charge.black = Math.max(0, this._charge.black - d);
    this._charge.white = Math.max(0, this._charge.white - d);

    if (this.red < g.coreTotal) {
      this._returnTimer += (dt || 0);
      // 减掉一个周期而不是清 0：dt 是 1/30 这种不精确的数，清 0 会让实际
      // 周期比设定值偏长并持续漂移（behaviorVM 里踩过同一个坑）。
      if (this._returnTimer >= g.coreReturnSec) {
        this._returnTimer -= g.coreReturnSec;
        this._returnCore();
      }
    } else {
      this._returnTimer = 0;
    }
  }

  /** 当前熵值（0..1）。每颗核 = 1/(2×总数) 的熵，8 核时一颗 = 6.25%。 */
  get value() {
    const g = this.cfg;
    const total = Math.max(1, g.coreTotal);
    return clamp(0.5 + (this.black - this.white) / (2 * total), g.min, g.max);
  }

  /** 波动放大系数（1.0 = 不放大）。未归属的核越少，世界越极化。 */
  get volatility() {
    const g = this.cfg;
    const total = Math.max(1, g.coreTotal);
    return 1 + (1 - this.red / total) * (g.volatilityPct / 100);
  }

  /** 夜晚拉伸比例（entropyToDayNight 用）。熵越高，夜越长。 */
  get nightStretch() {
    const g = this.cfg;
    return 1 + (this.value - 0.5) * 2 * (g.nightStretchPct / 100);
  }

  /** 距离下一次夺核的进度（0..1），供 UI 画进度条。 */
  chargeProgress(side) {
    const g = this.cfg;
    return Math.min(1, (this._charge[side] || 0) / Math.max(1e-6, g.chargePerCore));
  }

  /** 可解释：这个熵值是怎么来的。 */
  describe() {
    const v = this.value;
    const side = v > 0.5 ? '混乱（红方）占优' : v < 0.5 ? '秩序（蓝方）占优' : '中性';
    return `黑核 ${this.black} / 白核 ${this.white} / 未归属 ${this.red}（共 ${this.cfg.coreTotal}）` +
           ` → 熵 ${(v * 100).toFixed(1)}%（${side}），波动 ×${this.volatility.toFixed(2)}`;
  }

  /** 调试/存档用快照。 */
  snapshot() {
    return {
      black: this.black, white: this.white, red: this.red,
      total: this.cfg.coreTotal, value: this.value, volatility: this.volatility,
      charge: { black: this.chargeProgress('black'), white: this.chargeProgress('white') },
    };
  }

  dispose() {
    if (this._bus?.off && this._onDeath) this._bus.off('entity:death', this._onDeath);
  }
}
