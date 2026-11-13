/**
 * skyLight.js —— 程序化天空：一张等距圆柱图（太阳光晕 + 天顶到地平线的渐变 + 地面反照），
 * 既当 IBL（PMREM → scene.environment）给所有 PBR 材质做环境光，也当背景。
 *
 * 为什么不用半球光撑环境光：半球光只有"上色 / 下色"两个常数，材质对环境没有任何方向性响应，
 * 金属 / 水晶 / 湿地面都是死的。IBL 让这些材质真的反射天空。
 * 一天里天空颜色随昼夜变化，PMREM 要重算——每次约几毫秒，按"太阳位置 / 颜色变化超过阈值"才重算，
 * 不是每帧。参数在 CONFIG.ui.sky。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const cfg = () => CONFIG.ui?.sky || {};

/** 等距圆柱天空图（浮点，线性）。sunDir：世界方向（单位向量）；颜色是线性 RGB 数组。 */
export function buildSkyEquirect(W, H, { sunDir, zenith, horizon, ground, sunColor, sunGlow = 0.35, sunDisc = 6, gain = 1 }) {
  const data = new Float32Array(W * H * 4);
  const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
  for (let y = 0; y < H; y++) {
    const theta = (0.5 - y / H) * Math.PI;           // 仰角
    const up = Math.sin(theta), ct = Math.cos(theta);
    const t = Math.max(0, up), k = Math.pow(t, 0.45);
    const r0 = horizon[0] + (zenith[0] - horizon[0]) * k, g0 = horizon[1] + (zenith[1] - horizon[1]) * k, b0 = horizon[2] + (zenith[2] - horizon[2]) * k;
    for (let x = 0; x < W; x++) {
      const phi = (x / W) * Math.PI * 2 - Math.PI;
      const cx = ct * Math.cos(phi), cz = ct * Math.sin(phi);
      const cosS = cx * sx + up * sy + cz * sz;
      const glow = Math.pow(Math.max(0, cosS), 8) * sunGlow + Math.pow(Math.max(0, cosS), 220) * sunDisc;
      let r = r0 + sunColor[0] * glow, g = g0 + sunColor[1] * glow, b = b0 + sunColor[2] * glow;
      if (up < 0) { const d = Math.min(1, -up * 3); r = r * (1 - d) + ground[0] * d; g = g * (1 - d) + ground[1] * d; b = b * (1 - d) + ground[2] * d; }
      const i = (y * W + x) * 4;
      data[i] = r * gain; data[i + 1] = g * gain; data[i + 2] = b * gain; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _c = new THREE.Color();
const lin = (hex) => { _c.set(hex); return [_c.r, _c.g, _c.b]; };

export class SkyLight {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this._key = '';
    this._env = null; this._bg = null;
  }

  /**
   * 按当前光照参数更新天空。参数变化很小时跳过（避免每帧重算 PMREM）。
   * @param {object} L  { sunDir: Vector3, skyZenith, skyHorizon, ground, sunColor, gain, intensity }
   */
  update(L) {
    const C = cfg();
    const q = C.quantize ?? 0.03;
    const key = [L.sunDir.x, L.sunDir.y, L.sunDir.z].map((v) => Math.round(v / q)).join(',')
      + '|' + L.skyZenith + '|' + L.skyHorizon + '|' + L.sunColor + '|' + (Math.round((L.gain ?? 1) * 20));
    this.scene.environmentIntensity = L.intensity ?? (C.intensity ?? 1);
    if (key === this._key) return false;
    this._key = key;
    const tex = buildSkyEquirect(C.width ?? 256, C.height ?? 128, {
      sunDir: L.sunDir, zenith: lin(L.skyZenith), horizon: lin(L.skyHorizon), ground: lin(L.ground || '#3a3a36'),
      sunColor: lin(L.sunColor), sunGlow: C.sunGlow ?? 0.35, sunDisc: C.sunDisc ?? 6, gain: L.gain ?? 1,
    });
    const env = this.pmrem.fromEquirectangular(tex).texture;
    if (this._env) this._env.dispose();
    if (this._bg) this._bg.dispose();
    this._env = env; this._bg = tex;
    this.scene.environment = env;
    if (C.background !== false) this.scene.background = tex;
    return true;
  }

  dispose() { this.pmrem.dispose(); this._env?.dispose(); this._bg?.dispose(); }
}
