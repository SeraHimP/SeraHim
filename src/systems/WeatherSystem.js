import { BASE_WEATHERS, EXTREME_WEATHERS, TARGET_MATCHERS, CLIMATE_TEMPLATES, WEATHER_ARCHETYPES, snowFractionAt, tierOf, tierOfExtreme, INTENSITY_TIERS } from '../data/Weather.js';
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
 * ==================== v55.2：核心模型换血——"系统驱动" ====================
 * 用户实机反馈两个问题：① "效果看不出来"——5 条基础天气的占比强制走 softmax、
 * 恒和为 1，谁都冲不高，永远是稀释过的混合汁；② "物理别扭"——雨/雪原来是两条
 * 各自独立游走的轴，只靠一个弱耦合系数互相偏一下目标值，能同时冲到"盛夏暴雪"
 * 这种说不通的组合。跟用户 + GPT 反复讨论后定的新模型：天气不再是"5 个各自
 * 摇骰子的独立变量"，而是"有没有一个天气系统正在经过"——像真实气象一样，
 * 降水强度、风强度、温度骤变，全部是"这个系统现在走到生命周期哪一步了"这
 * 同一份读数派生出来的，不是各自独立摇骰子。
 *
 * 新机制（见 data/Weather.js 的 WEATHER_ARCHETYPES 头注）：开局一次性预生成
 * 整条【天气系统事件时间线】——冷锋/暖锋/对流雷暴/稳定高压/寒潮，每个事件
 * 有起止时刻、强度、一条"起势→驻峰→回落"的包络曲线。任意时刻的降水强度/
 * 风强度 = 当前活跃事件（最多同时 2 个，小幅重叠）按各自包络值加总。
 * 降水的【形态】（雨还是雪）不再是独立天气，而是降水强度按【当前温度】
 * 连续拆分出来的两半（snowFractionAt()）——同一份水汽，温度决定它是雨是雪，
 * "盛夏暴雪"这种组合现在结构上就不可能出现。雾只在"没有系统经过"的平静期由
 * 气候基线生成（系统经过时自然压制雾）。clear（晴）不是被抢预算的第 6 个选手，
 * 是"降水+风+雾都不活跃"时的leftover——calm 本身就该显示成"晴"。
 *
 * ==================== 与旧模型的兼容策略（不是推倒重来） ====================
 * WeatherSystem 对外的公开契约【一字未改】——getCharge/getEffectiveStrengths/
 * getModifiers/getStructuralFactor/getSkillParamMod/getForecast/getDominant/
 * getMu/setMu/setTemplate/isWeatherDisabled/setWeatherDisabled/averageDuration
 * 全部保留同样的签名和返回形状；EXTREME_WEATHERS 的 trigger 表、
 * WEATHER_SKILL_MODS、GroundTraceSystem、PostFX/ThreeRenderer、WeatherPanel.js
 * ——这些下游消费者一个字都不用改。变的只是内部【怎么算出 rain/snow/fog/
 * wind/clear 这五个 id 各自现在多强】。`_mu[id]`（UI 滑条的"出现倾向"）仍然
 * 是每个 id 独立的旋钮：mu.rain/mu.snow 偏置哪些天气系统更容易被抽中
 * （见 WEATHER_ARCHETYPES[*].affinity），mu.fog/mu.wind 直接缩放各自的
 * 派生强度，mu.clear 偏置"稳定高压"（calm）被抽中的概率——滑条的用户体感
 * （"往右拖，这种天气明显变多"）没有变，只是内部路由换了机制。
 *
 * ==================== 极端天气 ====================
 * 不参与调度，而是基础充能跨过阈值时【自动涌现】，这部分完全没动
 * （见下方 _stepCharges/_extremeThreshold，机制与之前逐字一致）。
 *
 * ==================== 预报 ====================
 * 事件时间线开局即【预生成完毕】，未来不是"猜"出来的，是已经写好但还没走到——
 * 预报只是读时间线的未来段，100% 准确、永不刷新，这条设计不变。
 */

const SAMPLE_INTERVAL = 2;      // 预报采样间隔（秒）
const MU_GAIN = 1.2;            // muT(-1~+1) → 温度轴内部数值空间的放大系数，让气候模板性格鲜明（v55.2：现在只用于温度轴，5 种基础天气不再走这条缩放）
const DOMINANCE_HYSTERESIS = 0.06; // 主导天气迟滞：新天气需领先 6 个百分点才算易主（滤抖动，不影响底层权重）
const FORECAST_HORIZON = 240;   // 预报时长（秒）——滚动条能看到未来 4 分钟
const TIMELINE_LENGTH = 7200;   // 预生成的时间线长度（秒）＝2小时，远超一局时长

// ==================== 气象轴 v1（用户 + GPT 讨论定稿，见 docs/Q4-WEATHER-REDESIGN.md §5）====================
// 只做一条轴：温度。比天气系统事件本身的演化慢得多，代表"这局比赛的气候基调"。
// v55.2：温度轴的 OU 步进机制完全没动（见下方 _generateTimeline），只是把原来
// 静态的回归目标 muT，换成了"气候基线 + 当前系统事件的 ΔT 贡献"这个随时间变化
// 的目标——一场冷锋经过时温度轴会真的被推低，不再是温度轴和天气系统各算各的。
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

    // 气象轴 v1：温度自己一条独立的 θ/σ，比天气系统事件慢得多（见 AXIS_TARGET_DURATION_*
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
    // Q3 根因修复（沿用至今）：整条天气时间线在 reset 时【一次性预生成】。
    //
    // 原实现（OU 随机游走）的错误：把"马尔可夫过程可以从当前状态往前推"当成了
    // "可以预报未来"，但【未来的随机数还没生成】——推演时另开一条随机序列去猜，
    // 猜的当然不准，而且每次重推种子都不同 → 同一未来时刻的预报值来回变，
    // 这就是当年用户看到的"天气突然刷新、不连续"。
    //
    // 正确做法：天气的整条时间线开局即确定（用固定种子一次性生成），
    // 未来不是"猜"出来的，而是"已经写好但还没走到"——这条设计原则在 v55.2
    // 换成"系统事件调度"之后依然成立：事件列表本身就是开局一次性生成的，
    // 预报读的是同一份事件表，不是另开一次模拟。
    for (const id of this.baseIds) this._charge[id] = 0;
    for (const id of Object.keys(EXTREME_WEATHERS)) this._extremeCharge[id] = 0;
    this._timeline = this._generateTimeline();
    this._x = { precip: this._timeline[0].precip, windSys: this._timeline[0].windSys, temp: this._timeline[0].temp, tempBase: this._timeline[0].tempBase };
  }

  /**
   * 初始化各天气的 mu（均值倾向 = 出现概率旋钮）。
   *   · 模板 = random → 每种天气的 mu 在 [-0.5, +0.8] 随机抽（每局天气性格不同）
   *   · 选了气候模板 → 用模板值，并做 ±0.15 的随机扰动
   *     （所以同一个"沙漠"每局也不完全一样）
   */
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
   * v55.2：生成整条时间线——【天气系统事件表】+【温度轨迹】两部分。
   * startFrom 给定时可【只重算未来】：已经开始的事件保留（"当下权重不变"），
   * 只重新调度 startFrom 之后的新事件；温度轨迹同理，从当前实际值接续。
   */
  _generateTimeline(startFrom = 0) {
    if (startFrom > 0 && this._events) {
      // 保留已经在进行中的事件（哪怕它会跨过 startFrom 继续到未来）——
      // 它是在旧 mu 下已经"确定发生"的，改 mu 不能让它凭空消失或掐头。
      const past = this._events.filter(ev => ev.start < startFrom);
      this._events = past.concat(this._generateSystemEvents(startFrom));
    } else {
      this._events = this._generateSystemEvents(0);
    }

    const line = [];
    let tempBase;
    if (startFrom > 0 && this._timeline) {
      tempBase = this._sampleTimeline(startFrom).tempBase;
      const keep = this._timeline.filter(p => p.t < startFrom);
      line.push(...keep);
    } else {
      // 起点在 μ_T 附近小幅撒开（同一空间：×MU_GAIN）——轴代表"这局的气候基调"，
      // 开局就该比较接近模板目标，不需要像具体天气事件那样大幅度随机起跳。
      tempBase = this._muT * MU_GAIN + (this._rng() - 0.5) * 0.6;
    }
    // ==================== 温度 = 慢速气候基线 + 天气系统的即时推力 ====================
    // 实现时发现：如果把系统的 ΔT 只当成"慢速轴回归目标的一个分量"（第一版做法），
    // 慢轴的回归周期长达 10~14 分钟，一场 2~14 分钟的天气系统还没把基线拉动多少就
    // 已经过境了——实测：mu.rain 拉满后，一场暖锋经过时"温度"几乎纹丝不动，降水
    // 该拆成雨的时候仍然全部落成雪（因为气候基线本身偏冷）。这在物理上也不对：
    // 真实的冷锋/暖锋恰恰以【过境时段温度骤变】著称，不该被"气候基调"完全压住。
    // 改法：气候基线（tempBase）仍然按原有的慢速 OU 机制独立演化（只回归气候模板
    // 的静态 muT，不再被系统事件牵着走）；系统当下的 ΔT 贡献【直接叠加】在基线上，
    // 跟随包络曲线实时起落，不经过慢轴的惯性——"这场暴风雪正在让这里更冷"这件事
    // 应该立刻体现，而不是要等基线慢慢挪过去。weatherSystemTempPushGain 是这份
    // 直接叠加的整体力度旋钮（软编码，默认 1，降水形态是否够敏感由此微调）。
    const pushGain = (CONFIG.tuning || {}).weatherSystemTempPushGain ?? 1;
    const t0 = startFrom > 0 ? Math.floor(startFrom / SAMPLE_INTERVAL) * SAMPLE_INTERVAL : 0;
    for (let t = t0; t <= TIMELINE_LENGTH; t += SAMPLE_INTERVAL) {
      const sys = this._deriveSystemsAt(this._events, t);
      const temp = tempBase + sys.deltaT * MU_GAIN * pushGain;
      line.push({ t, precip: sys.precip, windSys: sys.windSys, temp, tempBase });
      const drift = this.thetaAxis * (this._muT * MU_GAIN - tempBase) * SAMPLE_INTERVAL;
      const noise = this.sigmaAxis * Math.sqrt(SAMPLE_INTERVAL) * _gaussian(this._rng);
      // v55.2 新增的钳位：旧模型里 x.temp 允许纯 OU 无硬边界地偶尔越界，因为它只通过
      // 【钳位后】的 Tc 去做很弱的 mu 偏移（见旧版 TEMP_AXIS_COUPLING 头注），越界多少
      // 不影响下游。现在温度直接决定降水形态（snowFractionAt），不钳位的话，一次
      // 正常的 OU 长期游走就可能把基线甩到 −1.8 这种物理上没有意义的读数，
      // 天气系统自身的 ΔT 推力（至多 ±1 量级）再怎么推也拉不回来——实测过：
      // mu.rain 拉满后暖锋经过时基线恰好甩到深冷尾部，降水依然 100% 判成雪。
      // 把基线本身钳在物理范围内（±MU_GAIN，对应 getTemperature() 的 ±1），
      // 天气系统的 ΔT 推力才能真的够到"让这一刻的降水改判"这件事。
      tempBase = Math.max(-MU_GAIN, Math.min(MU_GAIN, tempBase + drift + noise));
    }
    return line;
  }

  /**
   * 调度一串【天气系统事件】，覆盖 [fromT, TIMELINE_LENGTH]。
   * 每个事件：{start, dur, archetypeId, strength, direction}。
   * fromT=0（全新开局）时额外往负方向撒一点起点，避免每局开局前几秒
   * 都必然"什么都没有"；fromT>0（mu 改变后只重算未来）时从 fromT 正常起排。
   */
  _generateSystemEvents(fromT = 0) {
    const T = CONFIG.tuning || {};
    // v55.2 排查记录：第一版在事件之间插了 60~420s 的"平静间隔"（外加强度越高间隔
    // 越长），想法是"刚经历一场大的，缓一缓"。实测下来这是个重复设计——高压
    // （highPressure）本身就是一个时长 7~12 分钟、driving as "calm/clear" 的天气
    // 系统原型，专门用来表示平静期；再叠加一段"事件之间强制留白"，等于把"平静"
    // 算了两遍：极地模板测出来 clear 反而是全局占比最高的那个（1960 处断言里 7 处
    // 因此失败），因为不管抽中哪个原型，大段留白时间总归全部记成 clear。
    // 改法：事件【首尾相接调度】，"平静"完全交给 highPressure 自己的出现概率和
    // 时长去表达——某个气候容易平静，是因为 affinity() 让 highPressure 更容易被
    // 抽中/占的时长更长，不是靠一段游离在事件表之外的强制空白。只留一点点随机的
    // 首尾重叠/错位（overlapMaxFrac）用于让过渡不生硬，不是常态化的大段留白。
    const overlapMaxFrac = T.weatherSystemOverlapMaxFrac ?? 0.15;
    const ids = Object.keys(WEATHER_ARCHETYPES);
    const events = [];
    let t = fromT;
    if (fromT <= 0) t -= this._rng() * 300; // 只有全新开局需要这个"已经进行到一半"的错位，避免每局开局都从同一个相位起算
    while (t < TIMELINE_LENGTH) {
      const archId = this._pickArchetype(ids);
      const arch = WEATHER_ARCHETYPES[archId];
      const dur = arch.durationSec[0] + this._rng() * (arch.durationSec[1] - arch.durationSec[0]);
      const strength = 0.55 + this._rng() * 0.45; // 每次系统经过的强度不同：0.55~1.0
      const direction = this._rng() * Math.PI * 2;
      const start = t;
      events.push({ start, dur, archetypeId: archId, strength, direction });
      // 首尾衔接，只留一点小幅重叠（"新系统已经起势、旧系统还没完全消散"的过渡感），
      // 不再有独立于任何原型之外的大段强制留白。
      const overlap = dur * overlapMaxFrac * this._rng();
      t = start + dur - overlap;
    }
    return events;
  }

  /** 按 affinity(mu, muT) 做加权随机抽取一个天气系统原型 id。 */
  _pickArchetype(ids) {
    const weights = ids.map(id => Math.max(0.001, WEATHER_ARCHETYPES[id].affinity(this._mu, this._muT)));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = this._rng() * sum;
    for (let i = 0; i < ids.length; i++) {
      r -= weights[i];
      if (r <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  /**
   * 给定时刻 t，把所有【当前活跃】的天气系统事件按包络曲线加总，得到这一刻的
   * 降水强度/风强度/温度推力。
   *
   * 不区分"主系统/副系统"、不做强度封顶——设计讨论稿里 GPT 建议的"副系统强度
   * 硬封顶在 0.35~0.45"在实现时发现会引入真实的不连续：两个事件重叠时哪个算
   * "副系统"是由起始时间早晚决定的，主系统结束的那一瞬间，原来的副系统会突然
   * "转正"、封顶跟着消失——如果它当时的包络值已经超过封顶，这一帧就会跳变。
   * 直接把活跃事件（结构上最多同时 2 个，重叠幅度被 overlapMaxFrac 卡得很小）的
   * 贡献加总、交给 _ratiosFromSample 里"总量超过 1 就按比例收窄"那一步去处理，
   * 效果上仍然是"新来的系统不会让总强度爆表"，但整条曲线处处连续——见
   * _archEnvelope 的头注：包络在事件首尾两端本来就是 0，天然衔接。
   */
  _deriveSystemsAt(events, t) {
    let precip = 0, wind = 0, deltaT = 0;
    for (const ev of events) {
      if (t < ev.start) break; // events 按 start 严格递增排列，后面不会再有更早的了
      if (t >= ev.start + ev.dur) continue;
      const arch = WEATHER_ARCHETYPES[ev.archetypeId];
      const phase = Math.max(0, Math.min(1, (t - ev.start) / ev.dur));
      const env = _archEnvelope(arch.envelope, phase);
      const str = ev.strength * env;
      precip += (arch.precipPeak || 0) * str;
      wind += (arch.windPeak || 0) * str;
      const dtRange = arch.deltaT || [0, 0];
      deltaT += ((dtRange[0] + dtRange[1]) / 2) * str;
    }
    return { precip: Math.min(1, precip), windSys: Math.min(1, wind), deltaT };
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
      this._stepCharges(base, extreme, this._softmax(this._ratiosFromSample(this._sampleTimeline(t + STEP))), STEP);
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
    if (idx >= line.length - 1) { const last = line[line.length - 1]; return { precip: last.precip, windSys: last.windSys, temp: last.temp, tempBase: last.tempBase }; } // 超出时间线：停在末态
    const a = line[idx], b = line[idx + 1];
    const frac = (t - a.t) / SAMPLE_INTERVAL;
    return {
      precip: a.precip + (b.precip - a.precip) * frac,
      windSys: a.windSys + (b.windSys - a.windSys) * frac,
      temp: a.temp + (b.temp - a.temp) * frac,
      tempBase: a.tempBase + (b.tempBase - a.tempBase) * frac,
    };
  }

  /**
   * v55.2：把"这一刻的系统读数"（降水强度/系统自带风强度/温度）换算成
   * 五种基础天气各自的【原始占比】（未做禁用过滤、未必严格和为 1——那一步交给
   * _softmax）。这是新旧模型之间真正的翻译层。
   *
   * · 降水按 snowFractionAt(温度) 连续拆成 rain/snow 两半——同一份水汽，
   *   温度决定它是雨是雪，这是这次重构要解决的核心问题（不再是两条独立轴）。
   * · 风 = 系统自带的风强度，被 mu.wind 现场缩放（正值放大、负值收窄）——
   *   保留旧滑条"这个天气出现得更多/更少"的直觉，但不再是另开一条独立游走轴。
   * · 雾只在"没有系统压阵"的平静空当里由气候基线（mu.fog）生成——系统经过时
   *   降水/风越活跃，雾的空间被自然压缩，不需要额外互斥判定。
   * · 降水+风+雾的原始强度之和一旦超过 1，按比例收窄——physically "不可能同时
   *   把所有天气现象都堆到满格"，clear 因此永远是非负的 leftover。
   */
  _ratiosFromSample(sample) {
    const T = CONFIG.tuning || {};
    const fogMu = this._mu.fog ?? BASE_WEATHERS.fog?.mu ?? 0;
    const windMu = this._mu.wind ?? BASE_WEATHERS.wind?.mu ?? 0;
    const precip = Math.max(0, Math.min(1, sample.precip || 0));
    const sysWind = Math.max(0, Math.min(1, sample.windSys || 0));

    const windGain = T.weatherWindMuGain ?? 0.6;
    let wind = sysWind * Math.max(0, 1 + windMu * windGain);

    const fogMax = T.weatherFogBaselineMax ?? 0.55;
    const fogPotential = Math.max(0, Math.min(1, 0.5 + fogMu * 0.5)) * fogMax;
    const calmness = Math.max(0, 1 - precip * 1.6 - wind * 1.2); // 降水/风越猛，平静度越低，雾潜力被自然压制
    let fog = fogPotential * calmness;

    let precipR = precip;
    const sum = precipR + wind + fog;
    if (sum > 1) { const k = 1 / sum; precipR *= k; wind *= k; fog *= k; }
    const clear = Math.max(0, 1 - precipR - wind - fog);

    const snowFrac = snowFractionAt(sample.temp != null ? sample.temp / MU_GAIN : 0);
    const rain = precipR * (1 - snowFrac);
    const snow = precipR * snowFrac;
    return { clear, rain, fog, wind, snow };
  }

  // ==================== 权重读出 ====================
  /** 当前基础天气占比（和为 1）。被禁用的天气占比恒为 0。 */
  getWeights() {
    if (this._weightsCache) return this._weightsCache;
    return (this._weightsCache = this._softmax(this._ratiosFromSample(this._x)));
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

  /**
   * v55.2：不再是字面意义的 softmax——输入已经是 _ratiosFromSample 算好、
   * 大致和为 1 的原始占比，这里只做【禁用过滤 + 重新归一化】。方法名保留
   * "_softmax"没有改（对外全是私有方法，调用方只是同一个仓库里的测试桩，
   * 见 tests/sim_v34.mjs 对 ws._softmax 的 monkey-patch），避免无谓的改名扩散。
   */
  _softmax(raw) {
    let active = this.baseIds.filter(id => !this._isOff(id));
    // 兜底：全都被拉到底时保留 mu 最高的那一个。天气占比之和必须是 1，
    // 全空会让"当前天气"变成 null，界面与效果链路都没有定义这种状态。
    // 记住是谁被兜底留下的：_stepCharges 要放它一马，否则会出现
    // "占比 100% 却永远充不上能"（两处口径打架）。
    this._fallbackId = null;
    if (!active.length) {
      let best = this.baseIds[0];
      for (const id of this.baseIds) if ((this._mu[id] ?? 0) > (this._mu[best] ?? 0)) best = id;
      const out = {};
      for (const id of this.baseIds) out[id] = id === best ? 1 : 0;
      this._fallbackId = best;
      return out;
    }
    let sum = 0;
    for (const id of active) sum += Math.max(0, raw[id] || 0);
    const out = {};
    if (sum <= 1e-9) {
      // 激活集合都恰好是 0（比如降水/风/雾都没有，clear 又被禁用）——按 mu 兜底
      // 分配，避免除 0，同时保持"总有一个在当家"的既有语义。
      let best = active[0];
      for (const id of active) if ((this._mu[id] ?? 0) > (this._mu[best] ?? 0)) best = id;
      for (const id of this.baseIds) out[id] = id === best ? 1 : 0;
      return out;
    }
    for (const id of this.baseIds) out[id] = active.includes(id) ? Math.max(0, raw[id] || 0) / sum : 0;
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
      const weights = this._softmax(this._ratiosFromSample(this._sampleTimeline(t)));
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

  /**
   * 主导天气的平均持续时长（秒）——面板展示用，让玩家知道这局天气多变还是沉闷。
   * v55.2：不再有全局 theta 这个概念，改成本局实际调度出来的天气系统事件
   * 的平均时长——比原来"1/theta 的理论估计"更直接：这就是本局事件表的真实统计量。
   */
  get averageDuration() {
    if (!this._events || !this._events.length) return 0;
    let sum = 0;
    for (const ev of this._events) sum += ev.dur;
    return Math.round(sum / this._events.length);
  }
}

// ==================== 工具 ====================
/**
 * v55.2：天气系统事件的包络曲线——起势→驻峰→回落三段吃满整个 [0,1] 相位区间
 * （riseFrac+peakFrac+fallFrac=1，不留"已经归零但还占着位置"的死尾巴），
 * 纯函数、只依赖相位，方便预报路径和真实演化共用同一份计算（同 _stepCharges
 * 的"纯函数抽出来，两处不会漂移"思路）。
 */
function _archEnvelope(env, phase) {
  const riseFrac = env.riseFrac || 0;
  const peakEnd = riseFrac + (env.peakFrac || 0);
  if (riseFrac > 0 && phase < riseFrac) return phase / riseFrac;
  if (phase < peakEnd) return 1;
  const fallFrac = Math.max(1e-6, 1 - peakEnd);
  return Math.max(0, 1 - (phase - peakEnd) / fallFrac);
}
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
