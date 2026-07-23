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

//               相位   太阳色     天空色(半球上)  地面反照色     太阳仰角  曝光   环境占比   天穹/边界底色
const KEYS = [
  { p: 0.00, sun: '#ffb066', sky: '#f2a06a', gnd: '#5a4a3a', elev: 10, exp: 0.72, amb: 0.42, bg: '#241f2e' }, // 黎明
  { p: 0.25, sun: '#fff6e8', sky: '#8fbce6', gnd: '#6b7a5a', elev: 82, exp: 1.00, amb: 0.30, bg: '#1a2740' }, // 正午
  { p: 0.50, sun: '#ff8a4d', sky: '#e88a5a', gnd: '#4e3f34', elev: 10, exp: 0.70, amb: 0.44, bg: '#2a181c' }, // 黄昏
  { p: 0.75, sun: '#6f86c9', sky: '#1b2440', gnd: '#182034', elev:  8, exp: 0.34, amb: 0.62, bg: '#070912' }, // 午夜
  { p: 1.00, sun: '#ffb066', sky: '#f2a06a', gnd: '#5a4a3a', elev: 10, exp: 0.72, amb: 0.42, bg: '#241f2e' }, // 回到黎明（闭合）
];

export const DAY_PERIOD = 180;   // 一整天 = 180s 游戏时间（可由 CTX.__dayPeriod 改）

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
  if (phase < 0.15 || phase >= 0.9) return '黎明';
  if (phase < 0.4) return '白昼';
  if (phase < 0.6) return '黄昏';
  return '夜晚';
}
