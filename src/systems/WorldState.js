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
import { DAY_PERIOD } from '../presentation/DayNight.js';

// 昼夜相位与 DayNight.js 的关键帧同口径：0=黎明 0.25=正午 0.5=黄昏 0.75=午夜。
// 因此 [0, 0.5) 是白天（黎明→正午→黄昏），[0.5, 1) 是夜晚（黄昏→午夜→黎明）。
// 相位在这里【自己算】而不是从 dayNightAt 取 —— 那个函数只返回光照参数，不含相位。
const NIGHT_FROM = 0.5;
const phaseOf = (t, period) => ((t / Math.max(1, period)) % 1 + 1) % 1;

export class WorldState {
  constructor({ weather = null, dragons = null, entities = null } = {}) {
    this.weather = weather;
    this.dragons = dragons;
    this.entities = entities;
    // 熵：0 = 绝对秩序，1 = 绝对混乱，0.5 = 中性。未实现前恒为中性。
    this.entropy = { value: 0.5, black: 0, white: 0, red: 0 };
    this.daynight = { phase: 0.5, isNight: false, label: '正午' };
    this.souls = { blue: [], red: [] };
    this._enabled = true;
  }

  setEnabled(on) { this._enabled = !!on; return this._enabled; }
  get enabled() { return this._enabled; }

  /** 每帧推进。**只在这里做系统间耦合**，且严格单向。 */
  update(dt, gameTime) {
    if (!this._enabled) return;
    const cfg = CONFIG.world || {};
    const cp = cfg.couplings || {};

    // ---- ① 昼夜相位（渲染层已在用同一个函数，这里只是把它数值化）----
    const period = (typeof window !== 'undefined' && window.CTX?.__dayPeriod) || DAY_PERIOD;
    const phase = phaseOf(gameTime || 0, period);
    this.daynight.phase = phase;
    this.daynight.isNight = phase >= NIGHT_FROM;
    this.daynight.label = this.daynight.isNight ? '夜晚' : '白天';

    // ---- ② 熵 → 天气（预留：熵越高，极端天气的均值回复目标越高）----
    // 熵未实现前 value 恒 0.5，下面这行等价于不改动天气，行为与现状一致。
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

    // ---- 昼夜 → 阵营非对称（用户定稿：蓝=秩序，白天占优；红=混乱，夜晚占优）----
    if (cp.dayNightFaction) {
      const fac = entity._mapFaction || entity.faction;
      const g = cfg.dayNightBonus || {};
      const favored = this.daynight.isNight ? 'red' : 'blue';
      if (fac === favored) {
        add('moveSpeed', 0, g.moveSpeedPct ?? 0);
        add('attackDamage', 0, g.attackDamagePct ?? 0);
      }
    }

    // ---- 熵 → 全局（预留。中性值 0.5 时下面全为 0，等价于未启用）----
    if (cp.entropyToUnits) {
      const k = (this.entropy.value - 0.5) * 2;      // -1（极秩序） .. +1（极混乱）
      const g = cfg.entropyBonus || {};
      const fac = entity._mapFaction || entity.faction;
      // 混乱侧（红）在高熵时受益，秩序侧（蓝）在低熵时受益 —— 非对称的核心
      const sign = fac === 'red' ? k : -k;
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

    if (cp.dayNightFaction) {
      const favored = this.daynight.isNight ? 'red' : 'blue';
      const g = cfg.dayNightBonus || {};
      if (fac === favored) {
        rows.push({ source: `昼夜 · ${this.daynight.label}`,
                    detail: `${favored === 'blue' ? '蓝方' : '红方'}优势 +${g.moveSpeedPct ?? 0}% 移速 / +${g.attackDamagePct ?? 0}% 攻击力` });
      } else {
        rows.push({ source: `昼夜 · ${this.daynight.label}`, detail: '本方无加成' });
      }
    }
    if (cp.entropyToUnits) {
      rows.push({ source: `熵 ${(this.entropy.value * 100).toFixed(0)}%`,
                  detail: this.entropy.value === 0.5 ? '中性（熵系统未启用实现）' : '非对称修正生效中' });
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
