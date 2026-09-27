/**
 * dayCycle.js —— 昼夜时钟：gameTime → 相位（0..1）的唯一换算口径。
 *
 * 从 presentation/DayNight.js 拆出来：WeatherSystem / WorldState 是逻辑层，它们要的
 * 只是"现在是白天还是夜晚"，却因为这几个函数住在渲染模块里而 import 了一个带 THREE
 * 的文件。逻辑层不该依赖渲染层（headless 平衡工具也会被迫加载 THREE）。
 * 颜色/曝光/太阳角那张 KEYS 表仍在 DayNight.js，它从这里读相位。
 */
import { CONFIG } from '../data/Config.js';

// ==================== 昼夜时长：白天/夜晚分开计（用户定稿：15分钟一轮，白天8/夜晚7）====================
// 权威值在 CONFIG.world.dayLenSec / nightLenSec（默认 480/420）；这里的常量只是
// 模块自己的兜底（Config 缺字段时用）与测试参照。DAY_PERIOD 保留为两者之和，
// 供只关心"总周期多长"的旧调用点（phaseLabel 的默认参数等）使用，不拆分调用方。
//
// 关键设计：只改"相位走过去要花多久"，不重标 KEYS 那张颜色/曝光/太阳仰角表——
// 5 个关键帧仍然卡在相位 0/0.25/0.5/0.75/1.0 这五个点（黎明/正午/黄昏/午夜/黎明），
// dayNightAt() 本身完全不用动；变的只是 resolveDayPhase() 怎么把 gameTime 换算成
// 相位——gameTime∈[0,dayLen) 线性映到相位∈[0,0.5)（白天），
// gameTime∈[dayLen,dayLen+nightLen) 线性映到相位∈[0.5,1.0)（夜晚），不对称都体现
// 在"走相位的速度"上。WorldState 的昼夜加成读的是同一个 resolveDayPhase 相位，
// 自动继承新比例，不用在那边另外改。
export const DAY_LEN = 480, NIGHT_LEN = 420;
export const DAY_PERIOD = DAY_LEN + NIGHT_LEN;

/**
 * 当前生效的白天/夜晚时长（秒）。CTX.__dayPeriodSec 仍然是运行时调试杠杆，
 * 但语义变成"整体等比缩放"——按住白天:夜晚的既有比例，把总时长缩放到这个值，
 * 而不是新开一对调试杠杆分别覆写白天/夜晚。
 */
function _dayNightLens(ctx = null) {
  const c = ctx || (typeof window !== 'undefined' ? window.CTX : null) || {};
  const dayLen = CONFIG.world?.dayLenSec ?? DAY_LEN;
  const nightLen = CONFIG.world?.nightLenSec ?? NIGHT_LEN;
  const override = c.__dayPeriodSec;
  if (override) {
    const baseTotal = dayLen + nightLen;
    const scale = Math.max(5, override) / Math.max(1, baseTotal);
    return { dayLen: dayLen * scale, nightLen: nightLen * scale };
  }
  return { dayLen, nightLen };
}

/** 当前生效的一天总时长（秒）＝白天+夜晚。所有只关心"总周期"的地方走这里。 */
export function dayPeriodSec(ctx = null) {
  const { dayLen, nightLen } = _dayNightLens(ctx);
  return dayLen + nightLen;
}

/** gameTime（秒）→ 相位（0..1），按白天/夜晚各自的时长分段线性映射。 */
function _gameTimeToPhase(gameTime, dayLen, nightLen) {
  const period = Math.max(1, dayLen + nightLen);
  const t = ((gameTime % period) + period) % period;
  return t < dayLen ? (t / Math.max(1, dayLen)) * 0.5
                     : 0.5 + ((t - dayLen) / Math.max(1, nightLen)) * 0.5;
}

/** 相位（0..1）对应的一天时刻标签，供 UI/调试显示。 */
export function phaseLabel(gameTime, period = DAY_PERIOD) {
  const phase = ((gameTime / Math.max(1, period)) % 1 + 1) % 1;
  return phaseLabelOf(phase);
}

/** 同上，但直接吃相位（0..1）。UI 已经有相位时不该再乘回时间去绕一圈。 */
export function phaseLabelOf(phase) {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.15 || p >= 0.9) return '黎明';
  if (p < 0.4) return '白昼';
  if (p < 0.6) return '黄昏';
  return '夜晚';
}

/**
 * 昼夜相位的【唯一解析口径】。
 *
 * 光照、WorldState 的数值化昼夜、HUD 时间条 —— 三处必须读同一个函数。
 * 这不是洁癖：三处各算一遍时，"画面是白天而数值判定是夜晚"这种不一致
 * 不会报任何错，只会让人怀疑自己的眼睛。
 *
 * 而且这里刚修过一个真实 bug：WorldState 与 WorldHud 都写了
 * `window.CTX?.__dayPeriod || DAY_PERIOD`，但 `CTX.__dayPeriod` 是一个
 * **setter 函数**（真正的秒数在 `CTX.__dayPeriodSec`）。函数是 truthy，
 * 于是 period 变成函数、`Math.max(1, fn)` 得到 NaN、相位恒为 NaN。
 * 表现是：HUD 时间条游标永远不动、标签永远显示"黎明"，
 * 而昼夜的数值耦合（isNight 永远 false）其实一直没生效过。
 *
 * @param gameTime 游戏时间（秒）
 * @param ctx      CTX（省略则取 window.CTX）
 * @param weatherEnabled 天气是否开启（昼夜默认跟随天气；__dayNightForce 可覆盖）
 * @returns { phase, period, active }  active=false 表示昼夜被锁定在固定时刻
 */
export function resolveDayPhase(gameTime, ctx = null, weatherEnabled = true) {
  const c = ctx || (typeof window !== 'undefined' ? window.CTX : null) || {};
  const { dayLen, nightLen } = _dayNightLens(c);
  const period = dayLen + nightLen;
  // 手动定格优先（调试用）
  if (c.__dayPhaseOverride != null) {
    return { phase: Math.max(0, Math.min(1, c.__dayPhaseOverride)), period, active: true };
  }
  const active = c.__dayNightForce != null ? !!c.__dayNightForce : !!weatherEnabled;
  // 关闭昼夜时锁定在 1/3 相位（约下午 2 点）：正午太阳近乎直射几乎无阴影，
  // 14 点约 58° 有像样的斜影 —— 与渲染层原有的取值保持一致。
  if (!active) return { phase: 1 / 3, period, active: false };
  return { phase: _gameTimeToPhase(gameTime, dayLen, nightLen), period, active: true };
}
