import { BASE_WEATHERS, EXTREME_WEATHERS, TARGET_MATCHERS, CLIMATE_TEMPLATES, TEMP_AXIS_COUPLING, tierOf, tierOfExtreme, INTENSITY_TIERS } from '../data/Weather.js';
import { WEATHER_SKILL_MODS } from '../data/weatherSkillMods.js';
// v54 第二轮重做 §9.6：天气×昼夜联动只需要读太阳仰角，DayNight.js 是纯函数
// （颜色插值用 THREE.Color，但不碰场景/渲染），headless Node 环境下同样可以
// 安全 import——sim_daynight.mjs 早就这么用了。WeatherSystem 不反向被 DayNight
// 依赖，不会形成循环 import。
import { resolveDayPhase } from '../presentation/DayNight.js';

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

// ==================== 气象轴 v1（用户 + GPT 讨论定稿，见 docs/Q4-WEATHER-REDESIGN.md §5）====================
// 只做一条轴：温度。比 5 种天气自身的演化慢得多，代表"这局比赛的气候基调"。
// AXIS_IDS 单独存在（不并入 baseIds）：softmax/权重/极端天气触发等一切现有逻辑
// 只认 baseIds，温度轴不会被这些循环意外吃进去；同时把它设计成数组（不是单个
// 字符串常量）是为将来可能追加的第二条轴（湿度等，本轮明确不做）留位置。
const AXIS_IDS = ['temp'];
// ==================== v54 §9.7：趋势尺度压缩（原 15~30 分钟太慢） ====================
// 用户实机验收反馈"气象轴看不出效果"——两轮 GPT 复核一致认为根因不是隐藏设计
// 本身错了，是【趋势尺度太长】：一局约 35 分钟，15~30 分钟的周期只够走半个弧线，
// 玩家几乎感受不到"正在变热/变冷"这类趋势。压到 10~14 分钟（平均约 12 分钟），
// 一局能看到至少一次完整的冷暖趋势，同时依然明显慢于天气自身 60~600秒 的回归
// 周期，保留"季节感而非又一条天气曲线"这条设计初衷。
const AXIS_TARGET_DURATION_MIN = 600, AXIS_TARGET_DURATION_MAX = 840;
const AXIS_SIGMA_COEF = 0.5;    // 稳态标准差系数（同 sigma/theta 的换算方式），让 T 大部分时间落在目标附近 ±0.8 左右

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

    // ==================== v51.26：占比/强度读出按帧缓存一次 ====================
    // 用户报"开天气之后更卡"——排查结论：getWeights()/getEffectiveStrengths()/
    // getExtremeStrengths() 跟"是哪个单位"完全无关，是这一帧的全局天气状态，
    // 理论上整局每步只用算一次；但 AttributeCalculator 给每个实体算属性时都会调
    // 到它们（getModifiers(entity) 内部又各调一次），单位一多就是把一份 O(1) 的
    // 全局计算重复算几百遍（softmax 里的 Math.exp、档位查表都不算贵，但架不住
    // 单位数 × 每帧调用次数）。三个方法各自缓存，命中同一次 update() 步进内的
    // 重复调用；见下面 _invalidateWeatherReadout() 及其调用点（与既有的
    // _invalidateForecast() 挂在同一批"状态真的变了"的入口上，外加 update() 本身，
    // 因为 _x 只在 update() 里重新采样）。
    this._weightsCache = null;
    this._effStrCache = null;
    this._extStrCache = null;

    this.reset();
  }

  /** 见构造函数里那段大注释：状态一变就清掉这一步的缓存，下次调用重算。 */
  _invalidateWeatherReadout() {
    this._weightsCache = null;
    this._effStrCache = null;
    this._extStrCache = null;
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
    this._invalidateWeatherReadout(); // v51.26：重开一局，天气从零算起，缓存不能带着上一局的值
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

    // 气象轴 v1：温度自己一条独立的 θ/σ，比天气本身慢得多（见 AXIS_TARGET_DURATION_*
    // 头注），也是每局单独随机一次——同一张图不会每局温度轴节奏都一样。
    const axisDuration = AXIS_TARGET_DURATION_MIN
      + this._rng() * (AXIS_TARGET_DURATION_MAX - AXIS_TARGET_DURATION_MIN);
    this.thetaAxis = 1 / axisDuration;
    this.sigmaAxis = AXIS_SIGMA_COEF * Math.sqrt(2 * this.thetaAxis);

    this._initMu();
    this._initMuT();
    this._clock = 0;
    this._tempLagTracker = null; // 气象轴 v1：新局重新开始追踪，不带上一局的滞后值
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
   * 气象轴 v1：温度轴的目标值（μ_T）。用户 + GPT 定稿："气候模板必须直接决定温度轴
   * 的长期目标值，不能只给初始随机倾向"——否则"沙漠"模板完全可能在单局里恰好抽到
   * 一条偏冷的随机轨迹，"选了沙漠却下雪"。与 _initMu 同一套写法（模板值 ± 扰动，
   * 无模板/random 时全随机），只是只有一个标量、没有 baseIds 循环。
   */
  _initMuT() {
    const tpl = CLIMATE_TEMPLATES[this._template];
    if (tpl && tpl.muT != null) {
      this._muT = _clamp(tpl.muT + (this._rng() - 0.5) * 0.3, -1, 1);
    } else {
      this._muT = _clamp((this._rng() - 0.5) * 2, -1, 1); // 全随机：-1~+1 均匀
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
      // 气象轴 v1：起点在 μ_T 附近小幅撒开（同一空间：×MU_GAIN，见 _stepOU 头注），
      // 撒开幅度比天气本身小——轴代表"这局的气候基调"，开局就该比较接近模板目标，
      // 不需要像单条天气那样大幅度随机起跳。
      x.temp = this._muT * MU_GAIN + (this._rng() - 0.5) * 0.6;
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
    // 气象轴 v1：温度的滞后追踪值，供 getTemperatureHint() 判断"是否正在明显变化"。
    // 平滑常数取 400 秒——比温度轴自身回归周期（15~30分钟）短、比天气本身
    // （1~10分钟）长，专门卡在"能看出温度轴走向"这个时间尺度上。
    {
      const cur = this.getTemperature();
      if (this._tempLagTracker == null) this._tempLagTracker = cur;
      else {
        const tau = 400;
        const alpha = 1 - Math.exp(-dt / tau);
        this._tempLagTracker += (cur - this._tempLagTracker) * alpha;
      }
    }
    // v51.26：_x 换了，权重/强度缓存必须失效——放在 _updateCharges 之前，
    // 好让它内部那次 getWeights() 用新 _x 重算并把新值缓存下来；
    // _effStrCache/_extStrCache 这里清空后，一直空到 _updateCharges 改完
    // _charge/_extremeCharge 为止，之后外部（AttributeCalculator 等）第一次
    // 调用 getEffectiveStrengths()/getExtremeStrengths() 时才会用新充能值重算。
    this._invalidateWeatherReadout();
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
    // v51.26：_charge/_extremeCharge 刚被 _stepCharges 就地改过，getEffectiveStrengths()/
    // getExtremeStrengths() 的缓存必须跟着失效——放在这里（而不是只放 update()）是因为
    // _updateCharges 本身也会被外部直接调用（如测试里绕过 update() 手动推进充能），
    // 缓存失效点必须钉在"真正改了 _charge"这一步，不能假定调用方一定走 update()。

    // v34（Q4）：记录过去的极端充能快照（对齐 SAMPLE_INTERVAL 网格）。
    // 充能是路径依赖的（一阶惯性），过去无法从时间线反推，只能实时记账；
    // 天气条游标左侧（过去 40s）的极端段用这份历史画。
    const grid = Math.floor(this._clock / 2) * 2;
    if (this._extremeHistory.length === 0 || this._extremeHistory[this._extremeHistory.length - 1].t < grid) {
      this._extremeHistory.push({ t: grid, ex: { ...this._extremeCharge } });
      if (this._extremeHistory.length > 40) this._extremeHistory.shift(); // 保留 80s，够覆盖条上的过去段
    }

    this._invalidateWeatherReadout();
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
    const base = Math.max(0.15, Math.min(0.98, rawThreshold * scale));
    const mul = this._dayNightCompatibility(id);
    // Hard veto：基础充能最高只能到 1.0，给一个远超 1 的哨兵值保证【永远】不满足
    // `bc < th` 之外的条件——不是"很难触发"，是"这一刻物理上不可能触发"。
    if (mul === Infinity) return 999;
    return Math.max(0.15, Math.min(0.98, base * mul));
  }

  /**
   * v54 §9.6：天气×昼夜联动（Weather Compatibility）。
   *
   * 不给 15 种极端天气逐条写权重表（GPT 复核明确建议过），只用一个通用环境信号
   * + 每条极端天气可选的 `dayNightRule` 做判定：
   *   · Hard veto（rule.veto === 'day'）：夜晚时返回 Infinity，_extremeThreshold
   *     会把它变成一个永远达不到的阈值——物理上不可能触发。
   *   · Soft penalty（未来可加 rule.nightMul/rule.dayMul 之类的字段）：目前只有
   *     "烈日"配置了 veto，其余 14 条没有配置 dayNightRule，直接走下面的
   *     Neutral 分支返回 1（不调整阈值）——避免给每条都发明一份没人验收过的
   *     权重数字。
   *   · Neutral：返回 1。
   *
   * ==================== 判定信号：相位，不是太阳仰角 ====================
   * 原计划用 dayNightAt() 的 sunElevation 判断昼夜（GPT 建议的"太阳高度函数"
   * 比布尔 isDay 更细腻）。实测后发现这个游戏的昼夜光照表是**风格化**的，
   * 太阳仰角在"午夜"这个关键帧也只是趋于一个较小的正值（14°），从不真正跌到
   * 地平线以下——直接查 DayNight.js 的 KEYS 表就能看到，不是我猜的。用
   * `sunElevation<=0` 做夜晚判据在这里永远为 false，veto 形同虚设。
   * 改用【相位】本身：resolveDayPhase 已经把 gameTime 换算成 phase∈[0,1)，
   * [0,0.5) 是白天、[0.5,1) 是夜晚（DAY_LEN/NIGHT_LEN 的定义本身就是这么分的），
   * 这才是这个游戏"昼夜"真正的判据，比另外接一个太阳仰角阈值更直接可靠。
   */
  _dayNightCompatibility(id) {
    const rule = EXTREME_WEATHERS[id]?.dayNightRule;
    if (!rule) return 1;
    const gameTime = (typeof window !== 'undefined') ? (window.gameTime || 0) : 0;
    const ctx = (typeof window !== 'undefined') ? window.CTX : null;
    const dp = resolveDayPhase(gameTime, ctx, this.enabled);
    if (!dp.active) return 1; // 昼夜被锁定在固定时刻时不做限制
    const isNight = dp.phase >= 0.5;
    if (rule.veto === 'day' && isNight) return Infinity;
    if (rule.veto === 'night' && !isNight) return Infinity;
    return 1;
  }

  /** 某天气的当前充能值（0~1） */
  getCharge(id) {
    return this._charge[id] ?? this._extremeCharge[id] ?? 0;
  }

  /**
   * 气象轴 v1：当前温度读数（-1 最冷 ~ +1 最热），钳位后的"物理"数值。
   * 用户 + GPT 定稿：这个数值本身【永远不在 UI 上显示】，只给环境色调微调/
   * 天气面板的文字叙事提示（"寒意正在加深"这类）这两处内部消费者使用。
   */
  getTemperature() {
    if (!this.enabled) return 0;
    const t = this._x.temp;
    if (t == null) return 0;
    return Math.max(-1, Math.min(1, t / MU_GAIN));
  }

  /**
   * 气象轴 v1："三层感知"的第三层——偶尔一句文字叙事，永不显示数值（用户 + GPT
   * 定稿，见 docs/Q4-WEATHER-REDESIGN.md §5）。只有出现【明显趋势】或到了寒潮/
   * 酷热的量级时才返回文字，平时返回 null（不需要"每帧都有话说"）。
   *
   * 趋势判据：一条比温度轴本身（15~30分钟回归周期）更短、又比天气本身
   * （1~10分钟）更长的滞后追踪值（_tempLagTracker，见 update() 里的指数平滑），
   * 当前读数与它偏离够多就是"正在明显变化"；偏离不大但绝对值已经很极端，就报
   * "正笼罩/正蒸腾"这类持续态描述。
   */
  getTemperatureHint() {
    if (!this.enabled) return null;
    const cur = this.getTemperature();
    const lag = this._tempLagTracker ?? cur;
    const delta = cur - lag;
    const TREND = 0.12, EXTREME = 0.55;
    if (delta <= -TREND) return '寒意正在加深';
    if (delta >= TREND) return '气温正在回暖';
    if (cur <= -EXTREME) return '寒潮笼罩战场';
    if (cur >= EXTREME) return '暑气蒸腾战场';
    return null;
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
    for (const id of AXIS_IDS) out[id] = a.x[id] + (b.x[id] - a.x[id]) * frac;
    return out;
  }

  _stepOU(x, dt, rng, t = 0) {
    const sqrtDt = Math.sqrt(dt);

    // ==================== 气象轴 v1：温度（先于 5 种天气步进）====================
    // 纯 OU，不挂"天气系统过境"振荡——那个振荡代表"某个天气短暂当家"，温度轴要的
    // 是持续平滑的季节感，不是轮流登场。θ/σ 用独立的 thetaAxis/sigmaAxis（比天气
    // 本身慢得多，见 reset() 与 AXIS_TARGET_DURATION_* 头注）。
    const driftT = this.thetaAxis * (this._muT * MU_GAIN - x.temp) * dt;
    const noiseT = this.sigmaAxis * sqrtDt * _gaussian(rng);
    x.temp += driftT + noiseT;
    // 换算成对天气 μ 的偏移时钳在 [-1,1]——轴本身允许尾部偶尔越界（纯 OU 无硬边界），
    // 但不能让极端尾部把某个天气的 μ 顶到失真（GPT 评审提的点）。
    const Tc = Math.max(-1, Math.min(1, x.temp / MU_GAIN));

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
      // 气象轴 v1：温度对该天气 μ 的偏移（雪强/晴中/雨弱，雾风不挂——见 Weather.js
      // 的 TEMP_AXIS_COUPLING 头注，用户 + GPT 定稿的不对称耦合，避免温度轴退化成
      // 一个隐藏的"晴/雪二选一开关"）。轴权重全 0 时 axisShift 恒为 0，与本轮改动前
      // 逐位一致。
      const axisShift = (TEMP_AXIS_COUPLING[id] || 0) * Tc * MU_GAIN;
      const mu = baseMu + this._oscAmp[id] * spike + axisShift;

      const drift = this.theta * (mu - x[id]) * dt;
      const noise = this.sigma * sqrtDt * _gaussian(rng);
      x[id] += drift + noise;
    }
  }

  // ==================== 权重读出 ====================
  /** 当前基础天气占比（softmax，和为 1）。被禁用的天气占比恒为 0。 */
  getWeights() {
    if (this._weightsCache) return this._weightsCache;
    return (this._weightsCache = this._softmax(this._x));
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
   * v51.26：当前"实际生效"的主导天气——按【充能】选，不是占比。
   *
   * getDominant() 答的是"接下来天气会往哪个方向走"（占比，反应快、随 OU 抖动，
   * 只挡了几个百分点的迟滞）；这个方法答的是"屏幕上现在真正在下什么、玩法数值
   * 现在真正吃的是哪个天气"（充能，一阶惯性、有积累—消退的节奏，跟
   * WeatherLayer 的可视化、getEffectiveStrengths() 的数值加成走的是**同一个量**，
   * 见 WeatherLayer.js 头注"强度取充能不取占比"）。
   *
   * 用户报的真实症状："天气上面显示晴，但是可视化效果竟然有雨和雪"——根因是
   * HUD 原来用 getDominant()（占比，天气一换几乎瞬时跳标签）当"当前天气"，
   * 画面/数值却是充能驱动的（消退要 20~30 秒）：天气快速切换时标签几秒内就跳到
   * "晴"，屏幕上那场雨却还要慢慢收几十秒才谢幕——标签和画面各读各的量，看着
   * 就像"标签说晴，天上却在下雨"。HUD 改读这个方法后，标签跟画面是同一个量，
   * 不会再对不上（见 WeatherPanel._renderNow）。
   *
   * 开局或天气刚 reset 时所有充能都是 0（还没来得及积累），这时"谁充能最高"
   * 没有意义（谁都是 0，选出来的只是遍历顺序），退回 getDominant()——占比好歹
   * 能告诉用户"现在正朝哪边走"，不会让标签在开局头几秒显示得莫名其妙。
   */
  getChargeDominant() {
    let best = null, bestC = -1;
    for (const id of this.baseIds) {
      const c = this.getCharge(id);
      if (c > bestC) { bestC = c; best = id; }
    }
    if (!best || bestC <= 1e-6) return this.getDominant();
    return { ...BASE_WEATHERS[best], weight: bestC };
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
    if (this._effStrCache) return this._effStrCache;
    const out = {};
    for (const id of this.baseIds) {
      if (this.disabledWeathers.has(id)) continue;
      const scale = tierOf(this._charge[id] || 0).scale;
      if (scale > 0) out[id] = scale;
    }
    return (this._effStrCache = out);
  }

  /** 极端天气的生效强度（同样是档位系数） */
  getExtremeStrengths() {
    if (this._extStrCache) return this._extStrCache;
    const out = {};
    for (const id of Object.keys(EXTREME_WEATHERS)) {
      if (this.disabledWeathers.has(id)) continue;
      // 极端天气用 5 档表：充能 ≥88% 进入"极端"档（150%）
      const scale = tierOfExtreme(this._extremeCharge[id] || 0).scale;
      if (scale > 0) out[id] = scale;
    }
    return (this._extStrCache = out);
  }

  // ==================== 结构性机制读数（Q4 天气重做） ====================
  /**
   * 读出某条"结构性机制"（不是普通的 statKey 数值修正，是索敌半径/转身速度这类
   * 不经过 AttributeCalculator 合并管线的全局杠杆）当前的生效百分比。
   *
   * 与 getModifiers() 同一套强度模型（基础天气档位系数 + 极端天气档位系数相加），
   * 只是读的是 Weather.js 里每条基础天气的 def.structural[key]（满档值），
   * 不是 def.effects。
   *
   * 极端天气【不需要】自己再写一份 structural——组合/单基础极端天气的 trigger
   * 字段本来就写明了它由哪些基础天气构成（如 haze_surge 的 trigger 是
   * {fog:0.26, wind:0.26}），这里直接按 trigger 里出现的基础天气 id 去查它们
   * 各自的 structural[key]，用极端天气自己的档位强度缩放——组合极端天气因此
   * 自动叠加两条基础机制，单基础极端天气自动继承并放大（因为极端档能到 150%）
   * 唯一的一条，完全对应文档"组合现有5套即可，不需要为15种极端天气各写一套"
   * 那句话，不用在 EXTREME_WEATHERS 里手写 15 份重复数据。
   *
   * 晴天的"主动关闭"：用户定稿"晴天……主动关闭上述几种天气各自的结构性机制"——
   * 这半句不是"晴天自己贡献了什么"，是"晴天压低了别人"，所以晴天自身的贡献
   * （clear.structural[key]）不参与下面这个抑制，只有雨/雾/风/雪四条会被晴天的
   * 当前档位系数做乘法抑制（晴天越盛，其它天气的结构性机制越接近失效）。
   */
  getStructuralFactor(key) {
    if (!this.enabled) return 0;
    let clearTotal = 0;
    let othersTotal = 0;
    for (const [id, scale] of Object.entries(this.getEffectiveStrengths())) {
      const v = BASE_WEATHERS[id]?.structural?.[key];
      if (!v) continue;
      if (id === 'clear') clearTotal += v * scale;
      else othersTotal += v * scale;
    }
    for (const [id, scale] of Object.entries(this.getExtremeStrengths())) {
      const def = EXTREME_WEATHERS[id];
      for (const baseId of Object.keys(def.trigger || {})) {
        if (baseId === 'clear') continue; // 晴天没有会被"极化/组合"进极端天气的结构性机制
        const v = BASE_WEATHERS[baseId]?.structural?.[key];
        if (v) othersTotal += v * scale;
      }
      // v54 §9.8：极端天气【自己】也可以再叠加一份 structural（例如雪盲的额外
      // 索敌收缩、浓雾比普通雾更狠的收缩、飓风的额外转向惩罚）——这是在上面
      // "继承自 trigger 里的基础天气"之外的独立加成，不是自动继承的那一份。
      const own = def.structural?.[key];
      if (own) othersTotal += own * scale;
    }
    // 晴天的抑制系数：直接复用 getEffectiveStrengths() 里 clear 的档位系数
    // （0~1，禁用晴天时该值为 undefined→0，抑制自动失效，与其它读数口径一致），
    // 封顶在 1（不会出现"压成负数反而增益"的怪异结果）。
    const suppress = Math.min(1, this.getEffectiveStrengths().clear || 0);
    return othersTotal * (1 - suppress) + clearTotal;
  }

  // ==================== 天气→特定技能定向修正（框架，v1 表为空） ====================
  /**
   * 读出某个天气对某个技能的某个 defaultParams 参数的定向修正（满档值 × 档位系数，
   * 与 effects/structural 同一套缩放语义）。数据源见 data/weatherSkillMods.js
   * 头注——那张表目前是空的，这个方法先把"读出机制"落地、跑通。
   *
   * 与 getStructuralFactor 不同：极端天气【不】自动从 trigger 继承——skill mod
   * 条目是任意的、针对具体技能的例外规则，不是"这个天气的通用性格"，没有
   * "组合天气自动继承基础天气机制"这个语义，条目要对哪个天气生效就显式写哪个
   * weatherId（可以是基础天气 id，也可以直接写某个极端天气 id）。
   *
   * @returns {{flat:number, percent:number}|null} 没有任何条目匹配时返回 null
   *   （调用方据此判断"这个技能这个参数完全不受天气影响"，不必额外判断 0 与
   *   "没有规则"的区别）。
   */
  getSkillParamMod(skillId, paramKey) {
    if (!this.enabled) return null;
    if (!WEATHER_SKILL_MODS.length) return null;
    const baseStr = this.getEffectiveStrengths();
    const extStr = this.getExtremeStrengths();
    let flat = 0, percent = 0, found = false;
    for (const m of WEATHER_SKILL_MODS) {
      if (m.skillId !== skillId || m.paramKey !== paramKey) continue;
      const scale = baseStr[m.weatherId] ?? extStr[m.weatherId];
      if (!scale) continue;
      found = true;
      if (m.flat) flat += m.flat * scale;
      if (m.percent) percent += m.percent * scale;
    }
    return found ? { flat, percent } : null;
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
    this._invalidateWeatherReadout(); // v51.26：同一批状态变更也让占比/强度读出缓存失效
  }

  /** 套用气候模板（mu 一次性全部替换），并重算未来 */
  setTemplate(templateId) {
    if (!CLIMATE_TEMPLATES[templateId]) return;
    this._template = templateId;
    this._initMu();
    this._timeline = this._generateTimeline(this._clock);
    this._invalidateForecast(); // v34 Q4：时间线变 → 预报重算
    this._invalidateWeatherReadout(); // v51.26：同一批状态变更也让占比/强度读出缓存失效
  }

  get template() { return this._template; }

  setEnabled(on) {
    this.enabled = !!on;
    this.eventBus?.emit('weather:toggled', { enabled: this.enabled });
  }

  setWeatherDisabled(id, disabled) {
    this._invalidateForecast(); // v34 Q4：开关直接改充能方程行为
    this._invalidateWeatherReadout(); // v51.26：同上
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
