/**
 * DayNight.js —— 昼夜交替（C 组·天气扩展）。
 *
 * 纯函数：给定游戏时间与一天周期，返回一组 ThreeRenderer.setLighting() 的参数。
 * setLighting 是灯光的唯一入口（辐照度默认标定回 π，压暗走 exposure）——本模块只产参数，
 * 由 main.js 的渲染帧调用 renderer3d.setLighting(dayNightAt(...))。headless 下渲染器为 null、
 * 不会被调用；模块本身只依赖 THREE.Color 的插值，导入安全。
 *
 * 关键帧（相位 0..1）：黎明→正午→黄昏→午夜→黎明。因为受光材质已接入（塔/地形都吃光），
 * 昼夜会真实地改变整场明暗与色温，而不是像 unlit 时代那样白天黑夜一个样。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

// ==================== v45：黎明/黄昏/夜晚整体抬亮 ====================
// 用户："晚上和黎明傍晚的效果太差了，看起来很阴间，白天还好。"
//
// 三处一起改，缺一条都不够：
//   ① exp（曝光）：低阳三档全部抬。黎明 0.72→0.86、黄昏 0.70→0.84、午夜 0.52→0.66。
//   ② amb（环境光占比）：太阳压得越低，画面越该靠环境光撑起来，否则**只有**被
//      太阳直射的那一面有亮度，背光面直接黑成剪影 —— 那正是"阴间"的观感来源。
//   ③ elev（太阳仰角）：黎明/黄昏从 10° 抬到 16°。10° 时几乎所有立面都是掠射，
//      地形的高低差全糊成一片黑；16° 仍然是长影，但立面能吃到光。
//   ④ sky/gnd 往中性方向拉一点：原来的黎明天空色 #f2a06a 饱和度很高，
//      配上低曝光会把整场染成橙黑，正是扭曲丛林夜里"看起来很怪"的那种脏。
// 另外还有一处**不在这个表里**的真 bug（塔灯在黎明前半段直接灭掉），
// 已在 ThreeRenderer._syncTowerLights 修 —— 光调这张表是治不好"纯黑"的。
//               相位   太阳色     天空色(半球上)  地面反照色     太阳仰角  曝光   环境占比   天穹/边界底色
const KEYS = [
  { p: 0.00, sun: '#ffc48c', sky: '#e0a888', gnd: '#6a5a48', elev: 16, exp: 0.86, amb: 0.52, bg: '#2e2838' }, // 黎明
  { p: 0.25, sun: '#fff6e8', sky: '#8fbce6', gnd: '#6b7a5a', elev: 82, exp: 1.00, amb: 0.30, bg: '#1a2740' }, // 正午
  { p: 0.50, sun: '#ff9d6a', sky: '#d99a78', gnd: '#5c4d40', elev: 16, exp: 0.84, amb: 0.54, bg: '#33222a' }, // 黄昏
  { p: 0.75, sun: '#a8b6e2', sky: '#3a4468', gnd: '#2c3450', elev: 14, exp: 0.66, amb: 0.68, bg: '#151b30' }, // 午夜
  { p: 1.00, sun: '#ffc48c', sky: '#e0a888', gnd: '#6a5a48', elev: 16, exp: 0.86, amb: 0.52, bg: '#2e2838' }, // 回到黎明（闭合）
];

// 一整天的游戏秒数。**权威值在 CONFIG.world.dayPeriodSec**（用户定稿默认 480 = 8 分钟）；
// 这里的常量只是模块自己的兜底（Config 缺字段时用），以及给测试当参照。
// 覆盖优先级：CTX.__dayPeriodSec（运行时调试杠杆） > CONFIG.world.dayPeriodSec > DAY_PERIOD。
export const DAY_PERIOD = 480;

/** 当前生效的一天时长（秒）。所有读周期的地方都必须走这里，不要各自 `|| DAY_PERIOD`。 */
export function dayPeriodSec(ctx = null) {
  const c = ctx || (typeof window !== 'undefined' ? window.CTX : null) || {};
  return c.__dayPeriodSec || CONFIG.world?.dayPeriodSec || DAY_PERIOD;
}

const _a = new THREE.Color(), _b = new THREE.Color();
const _lerpHex = (x, y, t) => '#' + _a.set(x).lerp(_b.set(y), t).getHexString();

/** 返回某时刻的 setLighting 参数。period=一天秒数。 */
export function dayNightAt(gameTime, period = DAY_PERIOD) {
  const phase = ((gameTime / Math.max(1, period)) % 1 + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 1 && phase > KEYS[i + 1].p) i++;
  const a = KEYS[i], b = KEYS[Math.min(i + 1, KEYS.length - 1)];
  const t = Math.max(0, Math.min(1, (phase - a.p) / Math.max(1e-6, b.p - a.p)));
  return {
    sunColor: _lerpHex(a.sun, b.sun, t),
    ambientSky: _lerpHex(a.sky, b.sky, t),
    ambientGround: _lerpHex(a.gnd, b.gnd, t),
    sunElevation: a.elev + (b.elev - a.elev) * t,
    exposure: a.exp + (b.exp - a.exp) * t,
    ambientShare: a.amb + (b.amb - a.amb) * t,
    background: _lerpHex(a.bg, b.bg, t),
    normalize: true,
  };
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
  const period = dayPeriodSec(c);
  // 手动定格优先（调试用）
  if (c.__dayPhaseOverride != null) {
    return { phase: Math.max(0, Math.min(1, c.__dayPhaseOverride)), period, active: true };
  }
  const active = c.__dayNightForce != null ? !!c.__dayNightForce : !!weatherEnabled;
  // 关闭昼夜时锁定在 1/3 相位（约下午 2 点）：正午太阳近乎直射几乎无阴影，
  // 14 点约 58° 有像样的斜影 —— 与渲染层原有的取值保持一致。
  if (!active) return { phase: 1 / 3, period, active: false };
  return { phase: ((gameTime / Math.max(1, period)) % 1 + 1) % 1, period, active: true };
}
