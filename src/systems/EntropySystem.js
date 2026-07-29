/**
 * EntropySystem.js —— 熵 / 三核（P5）
 *
 * ============ 这是什么 ============
 * 熵是一个 0..1 的全局标量：0 = 绝对秩序，1 = 绝对混乱，0.5 = 中性。
 * 它不由时间驱动，而是**由对局里实际发生的事驱动** —— 打得越凶、某一方压得越狠，
 * 世界就越偏离中性。三个"核"是它的三个来源通道：
 *
 *   · 白核（white）秩序侧积累。蓝方每完成一次击杀就长一点。
 *   · 黑核（black）混乱侧积累。红方每完成一次击杀就长一点。
 *   · 红核（red）  冲突烈度。**不分阵营**，任何死亡都喂它。
 *
 *   熵值 = 0.5 + (黑核 − 白核) / (2 × scale)        ← 谁压得狠，世界就往谁那边偏
 *   波动放大 = 红核 / scale × volatilityPct          ← 打得越凶，非对称的幅度越大
 *
 * 白/黑决定**方向**，红决定**幅度**。三者都随时间向 0 衰减（均值回复），
 * 否则一局打到后面必然撞死在上下限上、熵变成一个恒定值，也就失去了意义。
 *
 * ============ 必须说清的平衡风险 ============
 * 这个模型天然带**正反馈**：红方多杀 → 熵升高 → 红方拿到加成 → 杀得更多。
 * 不加约束会滚雪球，先手优势被无限放大，对局在前十分钟就定型。
 * 现在的三道刹车：
 *   ① 衰减（decayPerSec）——不持续压制就会自动回落到中性；
 *   ② 熵值上下限（clamp）——极端值不可达，加成有硬顶；
 *   ③ 加成量本身很小（默认 8% 攻击 / 6 护甲，且要熵到极值才拿满）。
 * 这三条都是软编码的，而且 tools/balance_matrix.mjs --sweep entropy 可以直接量出
 * 胜率/推进度随熵档位的曲线 —— 报告里把批量模拟列为熵的开工前置，就是为了这个。
 *
 * 默认 CONFIG.world.couplings.* 全关，全关时本模块只做统计、不产生任何修正。
 */
import { CONFIG } from '../data/Config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class EntropySystem {
  constructor(bus = null, entities = null) {
    this.black = 0;
    this.white = 0;
    this.red = 0;
    this._bus = bus;
    this._entities = entities;
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
      scale: c.scale ?? 100,
      decayPerSec: c.decayPerSec ?? 0.6,
      min: c.clampMin ?? 0.05,
      max: c.clampMax ?? 0.95,
      gainMinion: c.gainMinion ?? 1,
      gainTower: c.gainTower ?? 25,
      gainDragon: c.gainDragon ?? 40,
      redFromConflict: c.redFromConflict ?? 0.5,
      volatilityPct: c.volatilityPct ?? 12,
      nightStretchPct: c.nightStretchPct ?? 30,
    };
  }

  /**
   * 一次死亡事件。
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

    let amount;
    if (victimType === 'tower') amount = g.gainTower;
    else if (victimType === 'dragon') amount = g.gainDragon;
    else amount = g.gainMinion;

    if (killerFac === 'red') this.black += amount;
    else this.white += amount;
    // 红核不分阵营：它衡量的是烈度，不是立场
    this.red += amount * g.redFromConflict;

    // 巨龙特例：击杀巨龙【降低】击杀方一侧的极化（报告里的"秩序压制混乱"）。
    // 上面已按常规加过一次，这里反向多扣一份，净效果是压回中性。
    if (victimType === 'dragon') {
      if (killerFac === 'red') this.black -= amount * 2;
      else this.white -= amount * 2;
    }

    if (this.black < 0) this.black = 0;
    if (this.white < 0) this.white = 0;
  }

  /** 每帧衰减（均值回复）。不衰减的话核值单调增，一局打到后面必然顶死在上下限。 */
  update(dt) {
    const g = this.cfg;
    if (!g.enabled) return;
    const d = g.decayPerSec * (dt || 0);
    this.black = Math.max(0, this.black - d);
    this.white = Math.max(0, this.white - d);
    this.red = Math.max(0, this.red - d);
  }

  /** 当前熵值（0..1，已限幅）。 */
  get value() {
    const g = this.cfg;
    const raw = 0.5 + (this.black - this.white) / (2 * Math.max(1e-6, g.scale));
    return clamp(raw, g.min, g.max);
  }

  /** 波动放大系数（1.0 = 不放大）。红核越高，非对称的幅度越大。 */
  get volatility() {
    const g = this.cfg;
    return 1 + Math.min(1, this.red / Math.max(1e-6, g.scale)) * (g.volatilityPct / 100);
  }

  /** 夜晚拉伸比例（entropyToDayNight 用）。熵越高，夜越长。 */
  get nightStretch() {
    const g = this.cfg;
    return 1 + (this.value - 0.5) * 2 * (g.nightStretchPct / 100);
  }

  /** 可解释：这个熵值是怎么来的。 */
  describe() {
    const v = this.value;
    const side = v > 0.52 ? '混乱（红方）占优' : v < 0.48 ? '秩序（蓝方）占优' : '中性';
    return `黑核 ${this.black.toFixed(0)} / 白核 ${this.white.toFixed(0)} / 红核 ${this.red.toFixed(0)}` +
           ` → 熵 ${(v * 100).toFixed(0)}%（${side}），波动 ×${this.volatility.toFixed(2)}`;
  }

  reset() { this.black = this.white = this.red = 0; }

  dispose() {
    if (this._bus?.off && this._onDeath) this._bus.off('entity:death', this._onDeath);
  }
}
