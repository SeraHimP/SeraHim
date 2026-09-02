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
// v51.26：太阳方位角（azim）随时段扫动——用户："光线的角度要模拟真实的"。原来
// 方位角是 ThreeRenderer.js 里的一个死常量（135°，"左上打光"），太阳只会升降、
// 一天到头都从同一个水平方向照过来，不是真实天体运动。
// 现在给一个【温和的】扫动（105°→135°→165°，跨度 60°），不做成东升西落那种
// 满 180° 的大摆动——这是俯视策略游戏，玩家会靠阴影方向读地形高低/立体感，
// 摆动太大会让同一片地形在一天里阴影来回大幅摆动，读图变累；温和摆动既能让人
// 看出"太阳真的在移动"，又不至于扰乱既有的阴影阅读习惯。夜晚方位角随便给
// （太阳此时贡献趋近于 0，方向已经不重要），延续午夜前一个关键帧收尾。
//               相位   太阳色     天空色(半球上)  地面反照色     太阳仰角 太阳方位角  曝光   环境占比   天穹/边界底色
const KEYS = [
  { p: 0.00, sun: '#ffc48c', sky: '#e0a888', gnd: '#6a5a48', elev: 16, azim: 105, exp: 0.86, amb: 0.52, bg: '#2e2838' }, // 黎明（偏东）
  { p: 0.25, sun: '#fff6e8', sky: '#8fbce6', gnd: '#6b7a5a', elev: 82, azim: 135, exp: 1.00, amb: 0.30, bg: '#1a2740' }, // 正午（居中，与改动前的固定值一致）
  { p: 0.50, sun: '#ff9d6a', sky: '#d99a78', gnd: '#5c4d40', elev: 16, azim: 165, exp: 0.84, amb: 0.54, bg: '#33222a' }, // 黄昏（偏西）
  { p: 0.75, sun: '#a8b6e2', sky: '#3a4468', gnd: '#2c3450', elev: 14, azim: 165, exp: 0.66, amb: 0.68, bg: '#151b30' }, // 午夜（太阳贡献趋零，方位不重要）
  { p: 1.00, sun: '#ffc48c', sky: '#e0a888', gnd: '#6a5a48', elev: 16, azim: 105, exp: 0.86, amb: 0.52, bg: '#2e2838' }, // 回到黎明（闭合）
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
    sunAzimuth: a.azim + (b.azim - a.azim) * t,
    exposure: a.exp + (b.exp - a.exp) * t,
    ambientShare: a.amb + (b.amb - a.amb) * t,
    background: _lerpHex(a.bg, b.bg, t),
    unitTint: unitTintOf(_lerpHex(a.sky, b.sky, t), a.exp + (b.exp - a.exp) * t),
    normalize: true,
  };
}

/**
 * ==================== v47：单位也要融入环境光 ====================
 * 用户："兵并不会融入地形的光照，就是黑暗中很突兀的有着兵。"
 *        "任何单位，兵/塔/龙等都要融入地形光照。"
 *
 * 先说清楚**它不是灯光没接上** —— 单位用的是 MeshLambertMaterial，与地形同一组灯，
 * 光照本来就一视同仁。真正的成因是**反照率**：地形的漫反射来自地图贴图（暗绿/暗褐），
 * 而单位的顶点色是石灰白（蓝方 #8e9aa8、红方 #9a8478）与队伍色。
 * 同样的照度下，反照率高三四倍的东西当然会跳出来 —— 夜里画面整体压暗之后尤其明显，
 * 于是就成了"黑地图上一堆发白的小人"。
 *
 * 所以补的不是灯，是**色调**：给单位材质一个随昼夜变化的乘性染色
 * （MeshLambert 的 material.color 会与顶点色相乘），越黑的时段压得越狠、
 * 并且往当时的天空色偏一点，单位于是和环境同一个色温。
 *
 * 强度由曝光反推：`k = (1 − exposure) × strength`。
 *   · 正午 exposure = 1.00 → k = 0 → **纯白，一点不改**（白天的观感与改动前逐位一致）
 *   · 黎明 0.86 → k ≈ 0.22    · 黄昏 0.84 → k ≈ 0.26    · 午夜 0.66 → k ≈ 0.54
 * 这个反推是刻意的：曝光本来就是这张表里"这个时段有多暗"的度量，
 * 单独再写一列夜色强度，等于同一件事写两遍，下次调表必然只改一处。
 *
 * 关掉 CONFIG.ui.unitLighting.enabled 即完全恢复改动前的样子（tint 恒为白）。
 */
export function unitTintOf(skyHex, exposure) {
  const c = (CONFIG.ui && CONFIG.ui.unitLighting) || {};
  if (c.enabled === false) return '#ffffff';
  const strength = c.strength ?? 1.6;
  const k = Math.max(0, Math.min(c.maxMix ?? 0.62, (1 - (exposure ?? 1)) * strength));
  if (k <= 0) return '#ffffff';
  return _lerpHex('#ffffff', skyHex, k);
}

/**
 * v51.26：天气驱动的阴天压光。用户："如果有雨的话，云层是不是就遮住阳光了。"
 *
 * 不改 dayNightAt() 本身——那是【纯昼夜函数】，不依赖天气，也是 resolveDayPhase
 * 头注强调的"三处必须读同一个函数"里的那个唯一口径，掺进天气状态会破坏它的
 * 纯函数性质、也会让"只想看纯昼夜效果"的调用方（如果以后有）被迫捎带天气。
 * 所以单开一个函数：吃 dayNightAt() 算出的参数 + WeatherSystem，
 * 吐出【叠加了阴天效果之后】的新参数，main.js 里两个函数串着调用一次。
 *
 * 强度用的是【充能】不是占比——跟 WeatherLayer 的可视化、getEffectiveStrengths()
 * 的数值加成走同一个量（这次会话早些时候刚为了"标签/画面对不上"这个坑修过一次，
 * 这里不重蹈覆辙）：云层要挡多久太阳，跟"雨这场下了多久、真下透了没"是同一件事，
 * 不该跟着占比的瞬时抖动一起闪烁。
 *
 * 只有雨/雾/雪算"云"，风和晴本身不遮光（大晴天刮风依然是大晴天）。
 */
const _cA = new THREE.Color(), _cB = new THREE.Color();
export function weatherOvercastFactor(weatherSystem) {
  if (!weatherSystem || !weatherSystem.enabled || !weatherSystem.getCharge) return 0;
  const W = (CONFIG.ui && CONFIG.ui.weatherLighting) || {};
  const rain = weatherSystem.getCharge('rain') * (W.rainWeight ?? 1.0);
  const fog = weatherSystem.getCharge('fog') * (W.fogWeight ?? 0.5);
  const snow = weatherSystem.getCharge('snow') * (W.snowWeight ?? 0.8);
  return Math.max(0, Math.min(1, rain + fog + snow));
}

/** 把 dayNightAt() 算出的参数，按当前天气的"云量"再压一层阴天效果。 */
export function applyWeatherOvercast(params, weatherSystem) {
  const cover = weatherOvercastFactor(weatherSystem);
  if (cover <= 0) return params;
  const W = (CONFIG.ui && CONFIG.ui.weatherLighting) || {};
  // 阴天三件套：曝光降（云层挡光，直射变弱）、环境光占比升（光被云层散射成柔光，
  // 不再是"一面亮一面黑"的硬光）、太阳与天空色都往灰调拉（阴天没有蓝天也没有
  // 夕阳橙，颜色本身就是被云层"漂白"过的）——跟 v45 那次"黎明/黄昏/夜晚整体
  // 抬亮"改的是同一套三个杠杆，只是这次是压暗而不是抬亮，道理相通。
  const exposure = params.exposure * (1 - cover * (W.exposureDrop ?? 0.35));
  const ambientShare = Math.min(W.maxAmbientShare ?? 0.9, params.ambientShare + cover * (W.ambientBoost ?? 0.28));
  const grey = W.overcastColor ?? '#a4abb6';
  const mix = cover * (W.desaturate ?? 0.7);
  const sunColor = '#' + _cA.set(params.sunColor).lerp(_cB.set(grey), mix).getHexString();
  const ambientSky = '#' + _cA.set(params.ambientSky).lerp(_cB.set(grey), mix * 0.6).getHexString();
  return {
    ...params,
    exposure, ambientShare, sunColor, ambientSky,
    // 单位色调也要跟着阴天一起变暗变灰，否则会出现"天暗了、兵却还是原来那么亮"的
    // 半截状态——跟 unitTintOf 本来就要解决的问题（v47 那条）同一个道理。
    unitTint: unitTintOf(ambientSky, exposure),
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
