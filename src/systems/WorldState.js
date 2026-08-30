/**
 * WorldState.js —— 世界状态聚合层（P3 地基）
 *
 * ============ 为什么需要这一层 ============
 * 天气 / 昼夜 / 熵 / 龙魂 这四个系统此前各自为政：
 *   · 天气   —— WeatherSystem 直接把修正塞进 AttributeCalculator（唯一真正生效的）
 *   · 昼夜   —— 只驱动光照，**零数值影响**
 *   · 熵     —— 只有设计文档，零实现
 *   · 龙魂   —— 走技能系统，与前三者毫无交集
 * 于是"白天蓝方有优势、夜晚红方有优势""熵越高极端天气越频繁"这类联动，
 * 在代码里【没有任何地方可以挂】—— 因为不存在一个"世界现在长什么样"的共同表述。
 *
 * 本模块就是那个表述。约定：
 *   1. **单一出口**：所有世界级修正只从 getModifiers(entity) 出。
 *      调试时一个断点看得到全部来源，不必在四个系统里翻。
 *   2. **可解释**：getBreakdown(entity) 返回逐项来源，直接喂给 UI 属性面板。
 *      "为什么我的攻速变了"必须能当场答出来。
 *   3. **单向求值**：系统之间【禁止互相 import】。耦合一律在 update() 里
 *      按 熵→天气→昼夜→阵营 的固定顺序单向计算，杜绝环形依赖与求值顺序玄学。
 *   4. **每条耦合独立开关**：CONFIG.world.couplings.*，关掉任意一条其余仍自洽。
 *
 * 熵尚未实现，但接口在此预留（entropy 恒为中性 0.5，所有读它的地方都已就位）。
 * 龙魂同理：souls 已接入统计，规则（6 龙 ≥4 成魂）待实现。
 */
import { CONFIG } from '../data/Config.js';
import { DAY_PERIOD, resolveDayPhase } from '../presentation/DayNight.js';
import { EntropySystem } from './EntropySystem.js';

// 昼夜相位与 DayNight.js 的关键帧同口径：0=黎明 0.25=正午 0.5=黄昏 0.75=午夜。
// 因此 [0, 0.5) 是白天（黎明→正午→黄昏），[0.5, 1) 是夜晚（黄昏→午夜→黎明）。
// 相位在这里【自己算】而不是从 dayNightAt 取 —— 那个函数只返回光照参数，不含相位。
const NIGHT_FROM = 0.5;
const phaseOf = (t, period) => ((t / Math.max(1, period)) % 1 + 1) % 1;

export class WorldState {
  constructor({ weather = null, dragons = null, entities = null, bus = null } = {}) {
    this.weather = weather;
    this.dragons = dragons;
    this.entities = entities;
    // P5：熵由 EntropySystem 驱动（事件累积 + 均值回复）。WorldState 是它唯一的持有者 ——
    // 三核不对外暴露可写引用，其它系统只能通过本层的 getModifiers 间接受影响。
    this.entropySystem = new EntropySystem(bus, entities);
    // 兼容既有读法：this.entropy 是一份【只读快照】，每帧 update 时刷新。
    // （P3 时期这里是个恒定中性的占位对象，读它的地方都已就位，改成快照后无需改调用方。）
    this.entropy = { value: 0.5, black: 0, white: 0, red: 8, total: 8, volatility: 1,
                     charge: { black: 0, white: 0 } };
    this.daynight = { phase: 0.5, isNight: false, label: '正午' };
    this.souls = { blue: [], red: [] };
    this._enabled = true;
  }

  setEnabled(on) { this._enabled = !!on; return this._enabled; }
  get enabled() { return this._enabled; }

  /** 把熵钉死在某个值（批量模拟扫档用）。传 null 恢复由三核自然推进。 */
  forceEntropy(v) { this._forcedEntropy = (v === null || v === undefined) ? null : v; }

  /**
   * 把"夜"在时间轴上拉长，白天相应压缩，总周期不变。
   *
   * 相位 phase 随时间线性推进，isNight 的判据是 phase ≥ 0.5。要让夜更长，
   * 就得让相位【更早】越过 0.5、并且在 ≥0.5 停留更久。所以分段线性映射是：
   *   原始 [0, dayCut)  → 映射 [0, 0.5)     ← 白天，占用的真实时间被压短
   *   原始 [dayCut, 1)  → 映射 [0.5, 1)     ← 夜晚，占用的真实时间被拉长
   * 其中 dayCut = 0.5/k，k>1 时 dayCut<0.5。
   *
   * （写反过一次：把 [0,0.5) 映到 [0,dayCut)，那是把白天的相位【压缩】而不是
   *   把它占的时间压缩 —— 结果同一时刻的相位反而更早，夜晚变短了。）
   */
  _stretchNight(phase, k) {
    const kk = Math.max(0.1, k || 1);
    const dayCut = Math.min(0.999, Math.max(0.001, 0.5 / kk));
    if (phase < dayCut) return (phase / dayCut) * 0.5;
    return 0.5 + ((phase - dayCut) / (1 - dayCut)) * 0.5;
  }

  /** 每帧推进。**只在这里做系统间耦合**，且严格单向。 */
  update(dt, gameTime) {
    if (!this._enabled) return;
    const cfg = CONFIG.world || {};
    const cp = cfg.couplings || {};

    // ---- ① 熵推进（必须排在最前：后面两条耦合都读它，顺序错了会用到上一帧的值）----
    // 注意 FORCE 通道：批量模拟要把熵钉死在某个档位扫曲线，那时不推进累积。
    if (this._forcedEntropy === null || this._forcedEntropy === undefined) {
      this.entropySystem.update(dt);
      this.entropy.value = this.entropySystem.value;
    } else {
      this.entropy.value = this._forcedEntropy;
    }
    this.entropy.black = this.entropySystem.black;
    this.entropy.white = this.entropySystem.white;
    this.entropy.red = this.entropySystem.red;
    this.entropy.total = this.entropySystem.cfg.coreTotal;
    this.entropy.volatility = this.entropySystem.volatility;
    this.entropy.charge = {
      black: this.entropySystem.chargeProgress('black'),
      white: this.entropySystem.chargeProgress('white'),
    };

    // ---- ② 昼夜相位（渲染层已在用同一个函数，这里只是把它数值化）----
    // 熵 → 昼夜：熵越高夜越长。做法是拉伸【夜的那一半】而不是改整个周期速度 ——
    // 改周期速度会让白天也跟着变长，"高熵夜更长"就变成了"高熵一切都更慢"。
    // 相位走 resolveDayPhase（与光照、HUD 同一口径）。
    // 这里原先自己写 `window.CTX?.__dayPeriod || DAY_PERIOD` —— 而那个字段是个
    // **setter 函数**（秒数在 __dayPeriodSec），函数 truthy 导致 period 变成函数、
    // 相位恒为 NaN、isNight 永远 false，昼夜的数值耦合其实一直没生效过。
    let phase = resolveDayPhase(gameTime || 0, (typeof window !== 'undefined' ? window.CTX : null),
                                this.weather ? this.weather.enabled : true).phase;
    if (cp.entropyToDayNight) phase = this._stretchNight(phase, this.entropySystem.nightStretch);
    this.daynight.phase = phase;
    this.daynight.isNight = phase >= NIGHT_FROM;
    this.daynight.label = this.daynight.isNight ? '夜晚' : '白天';

    // ---- ③ 熵 → 天气（熵越高，极端天气的均值回复目标越高）----
    if (cp.entropyToWeather && this.weather?.setEntropyBias) {
      this.weather.setEntropyBias(this.entropy.value);
    }

    // ---- ③ 龙魂统计（规则待实现，先把数据接上，让 UI 与修正层有东西可读）----
    if (this.dragons?.getSouls) {
      const s = this.dragons.getSouls();
      this.souls.blue = s.blue || [];
      this.souls.red = s.red || [];
    }
  }

  /**
   * 世界级属性修正。返回 { statKey: { flat, pct } }，由 AttributeCalculator 合并。
   * 注意：**天气不在这里**——它已经有自己成熟的通道（getModifiers + 负恢复独立通道），
   * 强行搬过来只会平添一次回归风险。本层负责的是天气【之外】的三项，
   * 以及未来把四者统一时的落点。
   */
  getModifiers(entity) {
    const out = {};
    if (!this._enabled || !entity) return out;
    const cfg = CONFIG.world || {};
    const cp = cfg.couplings || {};
    const add = (key, flat = 0, pct = 0) => {
      const e = out[key] || (out[key] = { flat: 0, pct: 0 });
      e.flat += flat; e.pct += pct;
    };

    // ---- 昼夜 → 兵种/建筑非对称（用户定稿改动：白天【小兵】占优，夜晚【防御塔】占优）----
    // 注意这与上一版完全不同：上一版是按【阵营】给（白天蓝方 / 夜晚红方），
    // 那是把昼夜做成了先手优势，双方都吃亏一半时间；现在按【单位类别】给，
    // 双方对称，昼夜变成"什么时候适合推、什么时候适合守"的节奏开关。
    if (cp.dayNight) {
      const g = cfg.dayNightBonus || {};
      const side = this.daynight.isNight ? (g.night || {}) : (g.day || {});
      const isTower = entity.type === 'tower';
      // 白天利兵、夜晚利塔；巨龙不吃这条（它不属于任何一方的推进/防守）
      const favored = this.daynight.isNight ? isTower : (!isTower && entity.type !== 'dragon');
      if (favored) {
        if (side.moveSpeedPct) add('moveSpeed', 0, side.moveSpeedPct);
        if (side.attackDamagePct) add('attackDamage', 0, side.attackDamagePct);
        if (side.attackRangeFlat) add('attackRange', side.attackRangeFlat, 0);
        if (side.armorFlat) add('armor', side.armorFlat, 0);
      }
    }

    // ---- 熵 → 全局（中性值 0.5 时下面全为 0，等价于未启用）----
    if (cp.entropyToUnits) {
      const k = (this.entropy.value - 0.5) * 2;      // -1（极秩序） .. +1（极混乱）
      const g = cfg.entropyBonus || {};
      const fac = entity._mapFaction || entity.faction;
      // 混乱侧（红）在高熵时受益，秩序侧（蓝）在低熵时受益 —— 非对称的核心。
      // 红核（冲突烈度）只放大幅度、不改变方向：打得越凶，这份非对称越明显。
      const sign = (fac === 'red' ? k : -k) * (this.entropy.volatility || 1);
      add('attackDamage', 0, sign * (g.attackDamagePct ?? 0));
      add('armor', sign * (g.armorFlat ?? 0), 0);
    }

    return out;
  }

  /**
   * 逐项来源，供 UI 解释"我这条属性为什么变了"。
   * 这是本层的硬性要求之一：不可解释的全局修正等于不可调试。
   */
  getBreakdown(entity) {
    const rows = [];
    if (!this._enabled || !entity) return rows;
    const cfg = CONFIG.world || {};
    const cp = cfg.couplings || {};
    const fac = entity._mapFaction || entity.faction;

    if (cp.dayNight) {
      const g = cfg.dayNightBonus || {};
      const night = this.daynight.isNight;
      const side = night ? (g.night || {}) : (g.day || {});
      const isTower = entity.type === 'tower';
      const favored = night ? isTower : (!isTower && entity.type !== 'dragon');
      const who = night ? '防御塔' : '小兵';
      // v51.6：结构化的逐项修正（{statKey: {flat, percent}}），供 UI 按天气弹窗那套
      // 网格样式渲染——不再只给一句拼好的话。本单位吃不到这条时 mods 是空对象，
      // UI 据此显示"无增益"，不再说"XX占优（本单位不吃这条）"（用户定稿：删掉这句）。
      const mods = {};
      if (favored) {
        if (side.moveSpeedPct) mods.moveSpeed = { percent: side.moveSpeedPct };
        if (side.attackDamagePct) mods.attackDamage = { percent: side.attackDamagePct };
        if (side.attackRangeFlat) mods.attackRange = { flat: side.attackRangeFlat };
        if (side.armorFlat) mods.armor = { flat: side.armorFlat };
      }
      rows.push({
        source: `昼夜 · ${this.daynight.label}`,
        detail: favored ? `${who}占优` : '无增益',
        favored, mods,
      });
    }
    if (cp.entropyToUnits) {
      const k = (this.entropy.value - 0.5) * 2;
      const g = cfg.entropyBonus || {};
      const sign = (fac === 'red' ? k : -k) * (this.entropy.volatility || 1);
      const favored = Math.abs(sign) >= 1e-6;
      rows.push({
        source: `熵 ${(this.entropy.value * 100).toFixed(0)}%`,
        detail: favored
          ? `${this.entropySystem.describe()} → 本方 ${sign > 0 ? '+' : ''}${(sign * (g.attackDamagePct ?? 0)).toFixed(1)}% 攻击力、` +
            `${sign > 0 ? '+' : ''}${(sign * (g.armorFlat ?? 0)).toFixed(1)} 护甲`
          : '中性（无修正）',
        favored,
        mods: favored ? {
          attackDamage: { percent: Math.round(sign * (g.attackDamagePct ?? 0) * 10) / 10 },
          armor: { flat: Math.round(sign * (g.armorFlat ?? 0) * 10) / 10 },
        } : {},
      });
    }
    if (this.souls[fac]?.length) {
      rows.push({ source: '龙魂', detail: this.souls[fac].join('、') });
    }
    return rows;
  }

  /** 调试/UI 用的世界快照 */
  snapshot() {
    return {
      enabled: this._enabled,
      daynight: { ...this.daynight },
      entropy: { ...this.entropy },
      souls: { blue: [...this.souls.blue], red: [...this.souls.red] },
      weather: this.weather?.getDominant?.()?.label || null,
    };
  }
}
