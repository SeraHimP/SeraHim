import { BASE_WEATHERS, EXTREME_WEATHERS, TARGET_MATCHERS, CLIMATE_TEMPLATES, tierOf, tierOfExtreme, INTENSITY_TIERS } from '../data/Weather.js';

// v35 性能：极端天气条目静态缓存——充能方程每步都要遍历全部极端天气，
// 前向模拟一次跑 240+ 步，每步 Object.entries 重建数组是纯浪费（15ms → ~4ms）。
const EXTREME_ENTRIES = Object.entries(EXTREME_WEATHERS);
import { CONFIG } from '../data/Config.js';

/**
 * WeatherSystem.js —— 全局天气系统
 *
 * ==================== 核心模型 ====================
 * 天气不是离散状态机，而是一组【连续演化的权重】。任意时刻天气都是
 * "晴 62% / 雨 25% / 雾 8% / 风 4% / 雪 1%" 这样的分布，没有开关式切换。
 * 所谓"当前天气"只是权重最大的那个——是权重表的【读出结果】，不是被设定的状态。
 *
 * 演化算法：Ornstein-Uhlenbeck 过程 + Softmax
 *   每种基础天气有一个"潜在分数" x_i，做带均值回归的随机游走：
 *       dx_i = θ·(μ_i − x_i)·dt + σ·√dt·N(0,1)
 *   · θ（回归力）：把分数拉回均值的强度 → 决定天气变化的【快慢】
 *   · σ（波动率）：随机扰动的强度 → 决定天气变化的【剧烈程度】
 *   · μ_i（倾向）：该天气的长期均值 → 决定它有多【常见】
 *   占比 = softmax(x)，天然归一化到 1、平滑连续、无跳变。
 *
 *   为什么是 OU 而不是纯随机游走：纯游走会让某个天气无限漂移不回头。
 *   OU 的均值回归让极端占比【难以长期维持】——偶尔会有一场持续很久的大雨，
 *   但概率随时长指数衰减。这正是真实天气的统计特性，也是为什么
 *   不需要硬性的占比上限（用户明确要求不加上限）。
 *
 * ==================== 极端天气 ====================
 * 不参与游走，而是基础权重跨过阈值时【自动涌现】：
 *       强度 = min over 条件 of (占比 − 阈值) / (1 − 阈值)
 * 刚过阈值时极弱，占比越高越猛——连续，无突兀跳变。
 *
 * ==================== 预报 ====================
 * OU 是马尔可夫过程，可以从当前状态往前推演。系统用一个【独立的推演副本】
 * 提前算出未来 FORECAST_HORIZON 秒的权重曲线，滚动条据此渲染。
 * 预报是"真的"——未来确实会那样走（除非玩家中途改了参数）。
 */

const SAMPLE_INTERVAL = 2;      // 预报采样间隔（秒）
const SHARPNESS = 1.2;          // softmax 尖锐度：>1 放大占比差距，让主导天气鲜明、极端天气可达
const MU_GAIN = 1.2;            // mu(-1~+1) → OU 潜在分数的放大系数，让模板性格鲜明
const OSC_AMPLITUDE = 1.2;      // 天气系统过境：给演化加一点周期性节奏（辅助角色）
const OSC_SHARPNESS = 4;        // 尖峰陡度：越大，每种天气"当家"的窗口越短越集中
const DOMINANCE_HYSTERESIS = 0.06; // 主导天气迟滞：新天气需领先 6 个百分点才算易主（滤抖动，不影响底层权重）
const FORECAST_HORIZON = 240;   // 预报时长（秒）——滚动条能看到未来 4 分钟
const TIMELINE_LENGTH = 7200;   // 预生成的时间线长度（秒）＝2小时，远超一局时长

export class WeatherSystem {
  constructor(eventBus) {
    this.eventBus = eventBus;
    // 用户定稿：天气【默认开启】。昼夜默认跟随天气开关（见 resolveDayPhase），
    // 所以这一行同时决定了开局有没有昼夜循环。
    this.enabled = true;
    this.baseIds = Object.keys(BASE_WEATHERS);
    this.disabledWeathers = new Set(); // 用户可在面板里单独禁用某些天气

    // ==================== 充能条（用户 Q1：类比闪电杖） ====================
    // 每种天气（含极端天气）有一个 0~1 的充能值：
    //   · 占比 ≥ CHARGE_MIN_RATIO 时【充能】，速率 ∝ 占比（天气越剧烈充得越快）
    //   · 占比跌破阈值时【放电】，速率固定且比充能慢（"影响慢慢消散"而非立即消失）
    //   · 档位由【充能值】决定（不是占比！）：15/30/60/80% → 轻微/有限/中等/严重
    //   · 效果强度 = 该档位的系数（25/50/75/100%）× 效果表的满档值
    // 于是天气的影响有了"积累—爆发—消退"的节奏，而不是跟着占比瞬时抖动。
    this._charge = {};             // { weatherId: 0~1 }
    this._extremeCharge = {};      // 极端天气的充能条（同一套机制）
    this._mu = {};                 // 各天气的均值倾向（-1~+1）：出现概率的旋钮，可实时调
    this._template = 'random';     // 当前气候模板
    this._x = {};                  // 当前潜在分数（从时间线采样得到）
    this._timeline = null;         // 预生成的整条时间线（开局即确定的未来）
    this._extremeHistory = [];     // v34 Q4：过去的极端充能快照（预报条左侧用）
    this._fcVersion = 0;           // v34 Q4：预报缓存版本（时间线/开关变更时++）
    this._fcCache = null;
    this._clock = 0;

    this.reset();
  }

  /**
   * 重新随机化（每次载入地图调用）。
   * 用户要求：不仅起始权重随机，连"天气变化的快慢"本身也随机——
   * 于是有的局天气 60 秒一变，有的局能沉闷十分钟。每张图的天气性格都不同。
   */
  reset(seed = null) {
    this._extremeHistory = [];
    this._fcCache = null;
    this._invalidateForecast();
    this._rng = _makeRng(seed ?? (Math.random() * 1e9) | 0);

    // θ 决定主导天气的平均持续时长。经验关系：持续时长 ≈ 1/θ 量级。
    // 取值范围让持续时长落在 60s ~ 600s（10分钟）之间（用户指定）。
    const tMin = 60, tMax = 600;
    const targetDuration = tMin + this._rng() * (tMax - tMin);
    this.theta = 1 / targetDuration;
    // σ 与 θ 配比决定波动幅度：σ/√(2θ) 是 OU 的稳态标准差。
    // 取 1.6：稳态标准差越大，各天气的潜在分数拉得越开，softmax 后占比对比度越高。
    // （实测 0.8 时占比长期挤在 20~28% 区间，主导天气频繁易主、极端天气永远触发不了。）
    this.sigma = 0.9 * Math.sqrt(2 * this.theta);

    this._initMu();
    this._clock = 0;
    this._dominantId = null;
    // Q3 根因修复：整条天气时间线在 reset 时【一次性预生成】。
    //
    // 原实现的错误：把"OU 是马尔可夫过程、可以从当前状态往前推"当成了"可以预报未来"，
    // 但【未来的随机数还没生成】——推演时我另开了一条随机序列去猜，猜的当然不准
    // （实测：t=0 预报 t=60 的雨是 40.9%，实际走到 t=60 是 14.3%），
    // 而且每 8 秒重推一次、每次种子不同 → 同一未来时刻的预报值来回变
    //   → 这就是用户看到的"天气突然刷新、不连续"。
    //
    // 正确做法：天气的整条时间线开局即确定（用固定种子一次性生成），
    // 未来不是"猜"出来的，而是"已经写好但还没走到"。于是：
    //   · 预报 100% 准确（它读的就是真实的未来）
    //   · 永不刷新（时间线不再重算）
    //   · 演化仍然随机（种子随机 + 每局 θ 随机）
    // 这也符合"天气预报"的物理直觉：预报之所以能报，正因大气演化是确定性的。
    this._initOscillation();
    for (const id of this.baseIds) this._charge[id] = 0;
    for (const id of Object.keys(EXTREME_WEATHERS)) this._extremeCharge[id] = 0;
    this._timeline = this._generateTimeline();
    this._x = { ...this._timeline[0].x };
  }

  /**
   * 一次性生成整条天气时间线。
   * 采样点间隔 SAMPLE_INTERVAL 秒，覆盖 TIMELINE_LENGTH 秒（远超一局时长）。
   * 任意时刻的权重 = 在相邻两个采样点之间线性插值 → 连续、无跳变。
   */
  /**
   * 初始化各天气的 mu（均值倾向 = 出现概率旋钮）。
   *   · 模板 = random → 每种天气的 mu 在 [-0.5, +0.8] 随机抽（每局天气性格不同）
   *   · 选了气候模板 → 用模板值，并做 ±0.15 的随机扰动
   *     （所以同一个"沙漠"每局也不完全一样）
   */
  /** 天气系统过境的振荡参数（每种天气一条慢周期，相位不同 → 轮流当家） */
  _initOscillation() {
    this._oscAmp = {}; this._oscFreq = {}; this._oscPhase = {};
    for (const id of this.baseIds) {
      // 振幅：与 MU_GAIN 同量级，才能把低 mu 的天气短暂顶上来
      this._oscAmp[id] = OSC_AMPLITUDE * (0.7 + this._rng() * 0.6);
      // 周期 180~480 秒（3~8 分钟）
      const period = 180 + this._rng() * 300;
      this._oscFreq[id] = (2 * Math.PI) / period;
      this._oscPhase[id] = this._rng() * Math.PI * 2;
    }
  }

  _initMu() {
    const tpl = CLIMATE_TEMPLATES[this._template];
    for (const id of this.baseIds) {
      if (tpl?.mu) {
        this._mu[id] = _clamp(tpl.mu[id] + (this._rng() - 0.5) * 0.3, -1, 1);
      } else {
        this._mu[id] = _clamp(-0.5 + this._rng() * 1.3, -1, 1); // 全随机
      }
    }
  }

  /**
   * 生成时间线。startFrom 给定时可【只重算未来】——过去的曲线不需要重算，
   * 省一半开销（改 mu 时用得上：4.27ms → 约 2ms）。
   */
  _generateTimeline(startFrom = 0) {
    const line = [];
    let x;
    if (startFrom > 0 && this._timeline) {
      // 从当前时刻的实际权重接续 → 当下的天气不会跳变，只是往后的走向变了
      x = { ...this._sampleTimeline(startFrom) };
      const keep = this._timeline.filter(p => p.t < startFrom);
      line.push(...keep);
    } else {
      x = {};
      for (const id of this.baseIds) {
        x[id] = this._mu[id] + (this._rng() - 0.5) * 1.5; // 起始分数在均值附近撒开
      }
    }
    const t0 = startFrom > 0 ? Math.floor(startFrom / SAMPLE_INTERVAL) * SAMPLE_INTERVAL : 0;
    for (let t = t0; t <= TIMELINE_LENGTH; t += SAMPLE_INTERVAL) {
      line.push({ t, x: { ...x } });
      this._stepOU(x, SAMPLE_INTERVAL, this._rng, t);
    }
    return line;
  }

  // ==================== 演化：沿已确定的时间线推进 ====================
  update(dt) {
    if (!this.enabled) return;
    this._clock += dt;
    this._x = this._sampleTimeline(this._clock);
    this._updateCharges(dt);
  }

  /**
   * 推进所有充能条（基础 + 极端）。
   *
   * 充能：占比 ≥ CHARGE_MIN_RATIO 时，速率 = (占比 / 参考占比) / 满充秒数。
   *       占比越高充得越快 —— 这正是"天气越剧烈，影响积累越快"。
   * 放电：占比不足时，按固定速率衰减（放空秒数 > 满充秒数 → 消散比积累慢）。
   */
  _updateCharges(dt) {
    // v34（Q4）：充能方程抽成纯函数 _stepCharges，真实演化与预报前向模拟【共用同一份代码】——
    // 两处各写一份迟早漂移，预报又会不准。
    this._stepCharges(this._charge, this._extremeCharge, this.getWeights(), dt);

    // v34（Q4）：记录过去的极端充能快照（对齐 SAMPLE_INTERVAL 网格）。
    // 充能是路径依赖的（一阶惯性），过去无法从时间线反推，只能实时记账；
    // 天气条游标左侧（过去 40s）的极端段用这份历史画。
    const grid = Math.floor(this._clock / 2) * 2;
    if (this._extremeHistory.length === 0 || this._extremeHistory[this._extremeHistory.length - 1].t < grid) {
      this._extremeHistory.push({ t: grid, ex: { ...this._extremeCharge } });
      if (this._extremeHistory.length > 40) this._extremeHistory.shift(); // 保留 80s，够覆盖条上的过去段
    }
  }

  /**
   * 充能方程（纯函数，就地修改传入的 base/extreme 两个充能表）。
   *
   * 基础天气：充能【趋向一个由占比决定的平衡值】，而不是无脑充满。
   *   平衡值 = 占比（占比 30% → 充能稳定在 30% → 有限档；占比 85% → 严重档）。
   *   上升用 FULL 秒时间常数、下降用 DRAIN 秒（DRAIN > FULL）→ "影响慢慢消散"。
   * 极端天气：触发条件用【基础充能】判断；权重降低实际阈值；
   *   平衡值 = 条件富余程度 drive（刚过阈值停低档，条件越充分档位越高）。
   */
  _stepCharges(base, extreme, w, dt) {
    const T = CONFIG.tuning || {};
    const MIN = T.weatherChargeMinRatio ?? 0.15;   // 开始充能的占比门槛
    const FULL = T.weatherChargeFullSec ?? 20;     // 参考占比下充满需要的秒数
    const DRAIN = T.weatherDrainSec ?? 30;         // 从满充放空需要的秒数

    for (const id of this.baseIds) {
      // 关掉的天气一律不充能。正常路径下它的占比已经是严格 0（_softmax 把它剔出候选集），
      // 这一条是**兜底**：占比表可以由外部传入（预报前向模拟、测试桩），不能假定它一定归了零。
      // 唯一的例外是"全部拉到底"时被 _softmax 兜底留下的那一个 —— 它虽然 _isOff 为真，
      // 但占比是 1，必须允许充能，否则会"占比 100% 却永远充不上能"。
      const off = this._isOff(id) && id !== this._fallbackId;
      const ratio = off ? 0 : (w[id] || 0);
      const target = ratio >= MIN ? ratio : 0;   // 占比不足门槛 → 目标为 0（开始放电）
      const c = base[id] || 0;
      const tau = target > c ? FULL : DRAIN;     // 上升用充能时间常数，下降用放电时间常数
      base[id] = Math.max(0, Math.min(1, c + (target - c) * (dt / tau)));
    }

    for (const [id, def] of EXTREME_ENTRIES) {
      let met = !this._isOff(id);
      let drive = 1; // 触发条件的"富余程度"，决定充能速率
      if (met) {
        for (const [baseId, rawThreshold] of Object.entries(def.trigger)) {
          const th = this._extremeThreshold(id, rawThreshold);
          const bc = base[baseId] || 0;
          if (bc < th) { met = false; break; }
          const headroom = 1 - th;
          const excess = headroom > 0 ? (bc - th) / headroom : 1;
          drive = Math.min(drive, 0.35 + 0.65 * excess);
        }
      }
      const c = extreme[id] || 0;
      const target = met ? Math.min(1, drive) : 0;
      const tau = target > c ? FULL : DRAIN;
      extreme[id] = Math.max(0, Math.min(1, c + (target - c) * (dt / tau)));
    }
  }

  /**
   * v34（Q4）：极端天气预报 = 从【当前真实充能状态】出发，沿预生成时间线
   * 前向积分同一套充能方程，得到未来每个采样点的极端充能。
   *
   * 旧实现为什么不准（用户实测）：预报用"未来占比"直接判定极端（甚至重构后
   * getActiveExtremes 连参数都不收了——整条未来轴平铺的是【当前】状态）；
   * 而实际触发是充能驱动的一阶惯性系统（上升 20s / 放电 30s 时间常数 + 权重修正阈值），
   * 两套口径必然错位：占比刚达标时预报说"有"、实际充能还要爬几十秒；
   * 占比回落后预报立刻消失、实际放电慢还挂着。
   *
   * 时间线是开局预生成的确定性序列 → 前向模拟就是精确解（1s 步进 × 240s × 20 种
   * 天气 ≈ 5000 次运算，跨采样网格才重算一次，可忽略）。
   * 返回 Map<网格时刻, {extremeId: charge}>。
   */
  _forecastExtremes() {
    const gridNow = Math.floor(this._clock / 2) * 2;
    if (this._fcCache && this._fcCache.grid === gridNow && this._fcCache.ver === this._fcVersion) {
      return this._fcCache.map;
    }
    const base = { ...this._charge };
    const extreme = { ...this._extremeCharge };
    const map = new Map();
    map.set(gridNow, { ...extreme });
    const STEP = 1;
    const horizon = 240 + 4; // FORECAST_HORIZON + 余量
    for (let t = this._clock; t <= this._clock + horizon; t += STEP) {
      this._stepCharges(base, extreme, this._softmax(this._sampleTimeline(t + STEP)), STEP);
      const g = Math.floor((t + STEP) / 2) * 2;
      if (!map.has(g)) map.set(g, { ...extreme });
    }
    this._fcCache = { grid: gridNow, ver: this._fcVersion, map };
    return map;
  }

  /** 预报缓存失效：时间线重算 / 天气开关变化时调用 */
  _invalidateForecast() { this._fcVersion = (this._fcVersion || 0) + 1; }

  /**
   * 极端天气的实际触发阈值：固定条件 × 全局难度旋钮，不再有逐条可调的权重
   *（v51.6 删除，见 data/Weather.js 头注）。
   *
   * weatherExtremeThresholdScale 是整体难度旋钮（用户："可以适当增加进入极端天气的门槛"）。
   * 它乘在【原始阈值】上，所以各极端天气之间的相对难易不变，只是整条线一起抬高。
   * 下限维持 0.15：低于这个值意味着"基础天气充能一点点就能进极端"，门槛形同虚设。
   *
   * ⚠️ 这里【没有冷却】，也不打算加 —— 用户定稿："极端天气不要冷却，随即成啥样就是啥样"。
   * 排查过了：改动前也从来没有过冷却机制，极端天气纯粹由充能与阈值决定。
   */
  _extremeThreshold(id, rawThreshold) {
    const T = CONFIG.tuning || {};
    const scale = T.weatherExtremeThresholdScale ?? 1;
    return Math.max(0.15, Math.min(0.98, rawThreshold * scale));
  }

  /** 某天气的当前充能值（0~1） */
  getCharge(id) {
    return this._charge[id] ?? this._extremeCharge[id] ?? 0;
  }

  /** 某天气的当前档位。极端天气实体可达第 5 档"极端"（≥88% 充能，150%）。 */
  getTier(id) {
    if (EXTREME_WEATHERS[id]) return tierOfExtreme(this._extremeCharge[id] || 0);
    return tierOf(this._charge[id] || 0);
  }

  /** 在时间线上采样（相邻采样点之间线性插值，保证连续无跳变） */
  _sampleTimeline(t) {
    const line = this._timeline;
    if (!line || !line.length) return this._x;
    const idx = Math.floor(t / SAMPLE_INTERVAL);
    if (idx >= line.length - 1) return { ...line[line.length - 1].x }; // 超出时间线：停在末态
    const a = line[idx], b = line[idx + 1];
    const frac = (t - a.t) / SAMPLE_INTERVAL;
    const out = {};
    for (const id of this.baseIds) out[id] = a.x[id] + (b.x[id] - a.x[id]) * frac;
    return out;
  }

  _stepOU(x, dt, rng, t = 0) {
    const sqrtDt = Math.sqrt(dt);
    for (const id of this.baseIds) {
      // 可实时调的均值倾向。MU_GAIN 放大 mu 的影响力——
      // mu 的语义范围是 -1~+1（UI 滑条），但 OU 的潜在分数经 softmax 后，
      // ±1 的差距只能造成很小的占比差异。乘以 MU_GAIN 拉到 softmax 敏感的区间。
      const baseMu = (this._mu[id] ?? BASE_WEATHERS[id].mu) * MU_GAIN;

      // 【天气系统过境】：给 mu 叠加一个慢周期的尖峰振荡（周期 3~8 分钟、相位错开），
      // 让天气演化有"某个系统控制一段时间、然后让位"的节奏感。
      //
      // 注意：解决"极地永远不放晴"的【不是】这个振荡，而是 MU_GAIN 的取值。
      // 排查过程：mu 差距（极地雪 +1.0 vs 晴 -0.4）经 MU_GAIN 放大后进 softmax，
      // 差距是碾压性的——任何叠加项都撼不动。实测 MU_GAIN=2.2 时极地"晴>25%"的
      // 时长只有 4%，加振荡也没用。把 MU_GAIN 降到 1.2 后：极地雪仍主导 60%（还是极地），
      // 但放晴时长升到 13%、极端天气从 55% 降到 22%（不再是常态）。
      // 教训：模板应该给出"倾向"，而不是"独裁"。
      // 振荡用【尖峰函数】而非正弦：正弦让所有天气同时都在"中位"，高 mu 的永远压着低 mu 的。
      // 尖峰函数（(1+sin)/2 的高次幂）让每种天气【大部分时间处于低位、少数时间冲上高位】——
      // 相位错开后，就形成"轮流当家"：即使极地的晴天 mu 很低，轮到它的窗口时也能顶上来。
      // 这才是真实大气环流的样子：某个系统控制一段时间，然后让位给下一个。
      const phase = (Math.sin(t * this._oscFreq[id] + this._oscPhase[id]) + 1) / 2; // 0~1
      const spike = Math.pow(phase, OSC_SHARPNESS);   // 大部分时间接近 0，少数时间接近 1
      const mu = baseMu + this._oscAmp[id] * spike;

      const drift = this.theta * (mu - x[id]) * dt;
      const noise = this.sigma * sqrtDt * _gaussian(rng);
      x[id] += drift + noise;
    }
  }

  // ==================== 权重读出 ====================
  /** 当前基础天气占比（softmax，和为 1）。被禁用的天气占比恒为 0。 */
  getWeights() {
    return this._softmax(this._x);
  }

  /**
   * 某个天气是不是被【彻底关掉】了。
   *
   * ==================== 为什么需要这条 ====================
   * 用户："除了晴之外所有权重调到最低了，但是天气还是啥都有。"
   * 根因：占比走的是 **softmax**，而 softmax 的值域是开区间 (0,1) —— 它**永远不会给 0**。
   * mu 拉到 −1 只是把那个天气的潜在分数压低，占比仍有十几个百分点，
   * 越过充能门槛照样能积累到"中等/严重"。滑条拉到底 ≠ 关掉，这不符合直觉。
   * 现在：mu ≤ muOff（默认 −0.995，即滑条拉到最左端）= **从 softmax 的候选集里剔除**，
   * 占比严格 0，充能目标恒 0 —— 拉到底就是真的没有。
   *
   * v51.6：极端天气不再有权重滑条这条"拉到底=关闭"的旁路了（见 data/Weather.js
   * 头注），关闭极端天气只剩 disabledWeathers 那一条唯一入口（配置面板的"启用/禁用"
   * 按钮），上面那句已经处理过了，这里对极端天气直接返回 false。
   */
  _isOff(id) {
    if (this.disabledWeathers.has(id)) return true;
    if (EXTREME_WEATHERS[id]) return false;
    const off = CONFIG.tuning?.weatherOffAt ?? -0.995;
    return (this._mu[id] ?? BASE_WEATHERS[id]?.mu ?? 0) <= off;
  }

  _softmax(x) {
    let active = this.baseIds.filter(id => !this._isOff(id));
    // 兜底：全都被拉到底时保留 mu 最高的那一个。天气占比之和必须是 1，
    // 全空会让"当前天气"变成 null，界面与效果链路都没有定义这种状态。
    // 记住是谁被兜底留下的：_stepCharges 要放它一马，否则会出现
    // "占比 100% 却永远充不上能"（两处口径打架）。
    this._fallbackId = null;
    if (!active.length) {
      let best = this.baseIds[0];
      for (const id of this.baseIds) if ((this._mu[id] ?? 0) > (this._mu[best] ?? 0)) best = id;
      active = [best];
      this._fallbackId = best;
    }
    // 温度 T<1 让分布更"尖锐"：占比差距被放大，主导天气更鲜明、极端天气有机会触发。
    // T=1（标准 softmax）时五种天气的占比长期挤在 20~28%，谁都不占优——那不叫天气，
    // 叫五种天气的平均值。SHARPNESS 就是这个"尖锐度"旋钮。
    const T = 1 / SHARPNESS;
    const max = Math.max(...active.map(id => x[id]));
    const exps = {};
    let sum = 0;
    for (const id of active) {
      exps[id] = Math.exp((x[id] - max) / T); // 减最大值防溢出
      sum += exps[id];
    }
    const out = {};
    for (const id of this.baseIds) out[id] = exps[id] === undefined ? 0 : exps[id] / sum;
    return out;
  }

  /**
   * 当前主导天气（占比最大的基础天气）——只是读出结果，不是内部状态。
   *
   * 带【迟滞】：新天气必须领先当前主导 DOMINANCE_HYSTERESIS 个百分点才算易主。
   * 原因（实测）：两个天气占比 30% vs 29% 时，最大值会每隔几秒抖动易主一次，
   * 显示上就是"天气疯狂横跳"，但底层权重曲线其实非常平滑（900秒里只有 1 次
   * 真正的主导更替，其余 46 次都是接近时的抖动）。迟滞把这种抖动滤掉，
   * 让"当前天气"的读数与人的直觉一致，同时【不改动任何底层权重】——
   * buff 强度始终按真实占比计算，迟滞只影响显示。
   */
  getDominant() {
    const w = this.getWeights();
    let best = null, bestW = -1;
    for (const [id, v] of Object.entries(w)) {
      if (v > bestW) { bestW = v; best = id; }
    }
    if (!best) return null;
    if (this._dominantId && this._dominantId !== best) {
      const curW = w[this._dominantId] || 0;
      if (bestW - curW < DOMINANCE_HYSTERESIS) {
        // 领先不够，维持原主导（抖动过滤）
        return { ...BASE_WEATHERS[this._dominantId], weight: curW };
      }
    }
    this._dominantId = best;
    return { ...BASE_WEATHERS[best], weight: bestW };
  }

  /**
   * 当前激活的极端天气及其强度。
   * 强度 = min over 触发条件 of (占比 − 阈值)/(1 − 阈值)，即"最勉强满足的条件"决定强度。
   */
  /**
   * 当前激活的极端天气（充能 > 0 的）。intensity = 充能档位系数。
   * 触发条件基于【基础天气的充能值】，权重高的极端天气阈值更低（更容易出现）。
   */
  getActiveExtremes() {
    const out = [];
    for (const [id, scale] of Object.entries(this.getExtremeStrengths())) {
      out.push({ ...EXTREME_WEATHERS[id], intensity: scale, charge: this._extremeCharge[id] || 0 });
    }
    return out.sort((a, b) => b.intensity - a.intensity);
  }


  /**
   * 各天气的【生效强度】= 其充能档位的系数（0.25 / 0.5 / 0.75 / 1.0）。
   *
   * 与旧实现（按占比 + 67% 预算截断）的区别（用户 Q1）：
   *   · 强度不再跟占比连续联动，而是由【充能档位】决定 —— 四档，离散、可读。
   *   · 占比的作用变成"充能速率"：占比高 → 充得快 → 更快升到高档位。
   *   · 天气回落后，充能【缓慢放电】→ 影响渐进消散，而不是瞬间消失。
   * 效果预算截断不再需要：档位机制本身就滤掉了短暂/微弱的天气
   * （占比不足 15% 根本不充能，短暂冒头的天气充不到高档）。
   *
   * 返回 { weatherId: scale }，只含 scale > 0 的。基础与极端天气一并返回。
   */
  getEffectiveStrengths() {
    const out = {};
    for (const id of this.baseIds) {
      if (this.disabledWeathers.has(id)) continue;
      const scale = tierOf(this._charge[id] || 0).scale;
      if (scale > 0) out[id] = scale;
    }
    return out;
  }

  /** 极端天气的生效强度（同样是档位系数） */
  getExtremeStrengths() {
    const out = {};
    for (const id of Object.keys(EXTREME_WEATHERS)) {
      if (this.disabledWeathers.has(id)) continue;
      // 极端天气用 5 档表：充能 ≥88% 进入"极端"档（150%）
      const scale = tierOfExtreme(this._extremeCharge[id] || 0).scale;
      if (scale > 0) out[id] = scale;
    }
    return out;
  }

  // ==================== 属性注入 ====================
  /**
   * 计算某个实体当前受到的天气属性修正。
   * 返回 { statKey: { flat, percent } }，由 AttributeCalculator 合并进最终属性。
   *
   * 为什么不走 EffectRegistry：每帧给每个单位 apply 效果是几百上千次调用，
   * 而且短时效果反复刷新会让进度环闪成筛子（塔成长那批踩过的坑）。
   * 天气是【全局连续场】，做成属性合成时的一个 O(1) 修正层才对。
   * 代价是效果列表里看不到天气——所以 UI 单独显示一行"当前天气影响"。
   */
  getModifiers(entity) {
    if (!this.enabled || !entity) return null;
    const w = this.getWeights();
    const mods = {};

    const applyTable = (def, strength) => {
      if (strength <= 0) return;
      for (const eff of def.effects) {
        const matcher = TARGET_MATCHERS[eff.targets];
        if (!matcher || !matcher(entity)) continue;
        const m = mods[eff.statKey] || (mods[eff.statKey] = { flat: 0, percent: 0 });
        if (eff.flat) m.flat += eff.flat * strength;
        if (eff.percent) m.percent += eff.percent * strength;
      }
    };

    // 第一层：基础天气，强度 = 充能档位系数
    for (const [id, scale] of Object.entries(this.getEffectiveStrengths())) {
      applyTable(BASE_WEATHERS[id], scale);
    }
    // 第二层：极端天气，强度 = 其自身充能档位系数
    for (const [id, scale] of Object.entries(this.getExtremeStrengths())) {
      applyTable(EXTREME_WEATHERS[id], scale);
    }

    return Object.keys(mods).length ? mods : null;
  }

  /**
   * 按【天气】拆分的修正明细——供属性面板显示"这个天气对这个单位做了什么"。
   * 返回 [{ def, strength, extreme, mods: {statKey:{flat,percent}} }]，按强度降序。
   *
   * 与 getModifiers（合并后的总修正）的区别：那个用于属性计算，这个用于展示归因。
   * 两者共用同一套强度（getEffectiveStrengths），数字永远对得上。
   */
  getModifierBreakdown(entity) {
    if (!this.enabled || !entity) return [];
    const out = [];

    const collect = (def, strength) => {
      if (strength <= 0) return null;
      const mods = {};
      for (const eff of def.effects) {
        const matcher = TARGET_MATCHERS[eff.targets];
        if (!matcher || !matcher(entity)) continue;
        const m = mods[eff.statKey] || (mods[eff.statKey] = { flat: 0, percent: 0 });
        if (eff.flat) m.flat += eff.flat * strength;
        if (eff.percent) m.percent += eff.percent * strength;
      }
      return Object.keys(mods).length ? mods : null;
    };

    for (const [id, scale] of Object.entries(this.getEffectiveStrengths())) {
      const def = BASE_WEATHERS[id];
      const mods = collect(def, scale);
      if (mods) out.push({ def, strength: scale, charge: this._charge[id] || 0,
                           tier: tierOf(this._charge[id] || 0), extreme: false, mods });
    }
    for (const [id, scale] of Object.entries(this.getExtremeStrengths())) {
      const def = EXTREME_WEATHERS[id];
      const mods = collect(def, scale);
      if (mods) out.push({ def, strength: scale, charge: this._extremeCharge[id] || 0,
                           tier: tierOfExtreme(this._extremeCharge[id] || 0), extreme: true, mods });
    }
    return out.sort((a, b) => b.strength - a.strength);
  }

  // ==================== 预报（滚动条数据源） ====================
  /**
   * 预报：直接读【已经确定的时间线】——不是推演，不是猜测，就是未来本身。
   * 因此预报 100% 准确、永不刷新。
   */
  getForecast() {
    const out = [];
    // 采样点【对齐到固定的时间网格】，不随时钟漂移（Q2 修复）。
    // 原来从 this._clock 起按 2 秒步进——_clock 是连续的，每帧起点都不同，
    // 导致最后一个采样点在窗口右边缘反复进出 → 右端一小块一直在闪。
    // 对齐到网格后，采样点集合只在跨过整格时才变一个，色带表现为平滑整体左移。
    // 两端各多取一格，保证边缘之外也有数据可画（切掉超出部分即可，不会露白）。
    // 覆盖【过去 + 未来】：天气条的游标在 20% 处，左侧要显示已发生的天气。
    const PAST = 40; // 略多于条上显示的 36s，边缘不露白
    const gridStart = Math.floor((this._clock - PAST) / SAMPLE_INTERVAL) * SAMPLE_INTERVAL - SAMPLE_INTERVAL;
    const end = this._clock + FORECAST_HORIZON + SAMPLE_INTERVAL;
    // v34（Q4）：极端段改用【充能口径】——与实际触发同一套方程。
    //   t ≤ 现在：查实时记录的历史快照（充能路径依赖，无法反推）；
    //   t > 现在：前向模拟（_forecastExtremes，确定性时间线上的精确解）。
    // 显示门槛 = 有限档（0.28）：预报条只标"已成气候"的极端段，轻微档的毛刺不画。
    const SHOW_AT = INTENSITY_TIERS[2].threshold; // limited 0.28
    const fc = this._forecastExtremes();
    const gridNow = Math.floor(this._clock / 2) * 2;
    const histAt = (t) => {
      for (let i = this._extremeHistory.length - 1; i >= 0; i--) {
        if (this._extremeHistory[i].t <= t) return this._extremeHistory[i].ex;
      }
      return null;
    };
    for (let t = gridStart; t <= end; t += SAMPLE_INTERVAL) {
      if (t < 0) continue;
      const weights = this._softmax(this._sampleTimeline(t));
      const ex = t <= gridNow ? histAt(t) : (fc.get(t) || null);
      const extremes = [];
      if (ex) {
        for (const [id, charge] of Object.entries(ex)) {
          if (charge >= SHOW_AT) extremes.push({ id, intensity: tierOfExtreme(charge).scale / 1.5 });
        }
      }
      out.push({ t, weights, extremes });
    }
    return out;
  }

  get clock() { return this._clock; }

  // ==================== 配置面板接口 ====================
  // v51.6：extreme 权重（getExtremeWeight/setExtremeWeight）整个删掉了——
  // 见 data/Weather.js 头注，用户确认极端天气不需要这条可调项，只按固定 trigger
  // 条件 + 全局难度旋钮判定，启用/禁用走 disabledWeathers（下面 setWeatherDisabled）。

  /** 某天气的 mu（出现概率倾向，-1~+1） */
  getMu(id) { return this._mu[id] ?? BASE_WEATHERS[id]?.mu ?? 0; }

  /**
   * 调整某天气的 mu，并【立即重算未来的时间线】。
   *
   * 为什么必须重算：时间线是开局一次性预生成的（这样预报才能 100% 准确、永不刷新），
   * mu 是生成时的参数。改了 mu 却不重算，等于改了规则却沿用旧的未来 —— 滑条会毫无效果。
   * 重算从【当前时刻】接续（当下权重不变），所以天气不会跳变，只是往后的走向变了。
   * 成本约 2ms（只重算未来那一半）。UI 侧对滑条做防抖，拖动过程不触发。
   */
  setMu(id, value) {
    this._mu[id] = _clamp(value, -1, 1);
    this._timeline = this._generateTimeline(this._clock);
    this._invalidateForecast(); // v34 Q4：时间线变 → 预报重算
  }

  /** 套用气候模板（mu 一次性全部替换），并重算未来 */
  setTemplate(templateId) {
    if (!CLIMATE_TEMPLATES[templateId]) return;
    this._template = templateId;
    this._initMu();
    this._timeline = this._generateTimeline(this._clock);
    this._invalidateForecast(); // v34 Q4：时间线变 → 预报重算
  }

  get template() { return this._template; }

  setEnabled(on) {
    this.enabled = !!on;
    this.eventBus?.emit('weather:toggled', { enabled: this.enabled });
  }

  setWeatherDisabled(id, disabled) {
    this._invalidateForecast(); // v34 Q4：开关直接改充能方程行为
    // 只影响 softmax 的读出（被禁用的天气占比恒为 0），不改动底层时间线——
    // 所以禁用/启用天气不会"洗牌"未来，只是把某种天气从分配中剔除。
    if (disabled) this.disabledWeathers.add(id);
    else this.disabledWeathers.delete(id);
  }

  isWeatherDisabled(id) { return this.disabledWeathers.has(id); }

  /** 主导天气的平均持续时长（秒）——面板展示用，让玩家知道这局天气多变还是沉闷 */
  get averageDuration() { return Math.round(1 / this.theta); }
}

// ==================== 工具 ====================
// 可复现的伪随机（mulberry32）——预报推演需要确定性
function _makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller：均匀分布 → 标准正态
function _gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
