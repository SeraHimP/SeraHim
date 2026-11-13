/**
 * texgen.js —— 阶段 0 看图用的程序化 PBR 贴图（草 / 泥路 / 岩石 / 苔藓 / 树皮 / 叶片簇）。
 *
 * 这些不是最终贴图：真正的写实贴图要用照片级 CC0 资源（见 docs/VISUAL-REWORK-REPORT.md §5）。
 * 这里只是让阶段 0 的原型能先把相机、光照、地形结构、边界处理看出来。
 * 每种材质给 albedo + normal（由同一份高度场算 Sobel）+ roughness。
 */
import * as THREE from '../../vendor/three.module.js';

// 确定性哈希噪声（同一台机器每次一样，截图可复现）
function hash2(x, y, s) { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); }
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(u, v, period, seed) {
  const x = u * period, y = v * period, x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
  const w = (i, j) => hash2(((x0 + i) % period + period) % period, ((y0 + j) % period + period) % period, seed);
  const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(u, v, base, oct, seed, gain = 0.5) {
  let s = 0, a = 0.5, n = 0, p = base;
  for (let o = 0; o < oct; o++) { s += vnoise(u, v, p, seed + o * 13) * a; n += a; a *= gain; p *= 2; }
  return s / n;
}
function ridged(u, v, base, oct, seed) {
  let s = 0, a = 0.5, n = 0, p = base;
  for (let o = 0; o < oct; o++) { const r = 1 - Math.abs(vnoise(u, v, p, seed + o * 7) * 2 - 1); s += r * r * a; n += a; a *= 0.55; p *= 2; }
  return s / n;
}

/** 由高度场（0..1）算法线贴图（切线空间，Y 向上）。strength 越大起伏越明显。 */
function normalFromHeight(h, N, strength) {
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const L = h[y * N + ((x - 1 + N) % N)], R = h[y * N + ((x + 1) % N)];
    const U = h[((y - 1 + N) % N) * N + x], D = h[((y + 1) % N) * N + x];
    let nx = (L - R) * strength, ny = (U - D) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * N + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
  return t;
}
function rgbTex(rgb, N, srgb = true) {
  const t = new THREE.DataTexture(rgb, N, N); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
  return t;
}
const clamp = (v) => Math.max(0, Math.min(255, v));

/** 返回 { map, normalMap, roughnessMap } */
function build(N, fn, nStrength) {
  const h = new Float32Array(N * N), rgb = new Uint8Array(N * N * 4), rough = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, k = y * N + x;
    const o = fn(u, v);
    h[k] = o.h;
    rgb[k * 4] = clamp(o.r); rgb[k * 4 + 1] = clamp(o.g); rgb[k * 4 + 2] = clamp(o.b); rgb[k * 4 + 3] = 255;
    const rg = clamp(o.rough * 255); rough[k * 4] = rg; rough[k * 4 + 1] = rg; rough[k * 4 + 2] = rg; rough[k * 4 + 3] = 255;
  }
  return { map: rgbTex(rgb, N), normalMap: normalFromHeight(h, N, nStrength), roughnessMap: rgbTex(rough, N, false) };
}

export function grassTexture(N = 1024) {
  return build(N, (u, v) => {
    const big = fbm(u, v, 3, 3, 11);                 // 大片的明暗（干湿）
    const clump = fbm(u, v, 24, 4, 21);              // 草丛团块
    const blade = ridged(u * 1 + big * 0.02, v, 160, 2, 31);   // 细草叶
    const h = clump * 0.6 + blade * 0.4;
    const t = clump * 0.7 + blade * 0.3;
    const dry = fbm(u, v, 6, 2, 41);
    const r = 64 + 56 * t + 34 * dry * dry, g = 88 + 58 * t + 14 * dry, b = 34 + 26 * t;   // 偏橄榄的自然草色，不要荧光绿
    return { h, r, g, b, rough: 0.85 + 0.1 * (1 - t) };
  }, 2.2);
}
export function dirtTexture(N = 1024) {
  return build(N, (u, v) => {
    const base = fbm(u, v, 5, 4, 51);
    const pebble = ridged(u, v, 48, 3, 61);
    const crack = 1 - Math.pow(ridged(u, v, 10, 3, 71), 3);
    const h = base * 0.5 + pebble * 0.35 + crack * 0.15;
    const t = base * 0.6 + pebble * 0.4;
    const r = 104 + 50 * t, g = 84 + 40 * t, b = 60 + 28 * t;
    return { h, r, g, b, rough: 0.92 - 0.1 * pebble };
  }, 2.6);
}
export function rockTexture(N = 1024) {
  return build(N, (u, v) => {
    const strata = ridged(u * 0.4 + fbm(u, v, 3, 2, 81) * 0.15, v, 14, 4, 91);
    const chip = ridged(u, v, 60, 3, 101);
    const h = strata * 0.7 + chip * 0.3;
    const t = strata * 0.65 + chip * 0.35;
    const warm = fbm(u, v, 4, 2, 111);
    const r = 96 + 70 * t + 18 * warm, g = 92 + 62 * t + 10 * warm, b = 88 + 52 * t;
    return { h, r, g, b, rough: 0.75 + 0.2 * (1 - t) };
  }, 4.0);
}
export function mossTexture(N = 1024) {
  return build(N, (u, v) => {
    const pad = fbm(u, v, 12, 4, 121), fine = fbm(u, v, 90, 2, 131);
    const h = pad * 0.7 + fine * 0.3, t = pad * 0.6 + fine * 0.4;
    const r = 48 + 50 * t, g = 84 + 70 * t, b = 34 + 22 * t;
    return { h, r, g, b, rough: 0.95 };
  }, 2.0);
}
export function barkTexture(N = 512) {
  return build(N, (u, v) => {
    const fiber = ridged(u, v * 0.25, 18, 3, 141);     // 竖向纤维
    const knot = fbm(u, v, 5, 3, 151);
    const h = fiber * 0.75 + knot * 0.25, t = fiber * 0.7 + knot * 0.3;
    const r = 58 + 46 * t, g = 46 + 34 * t, b = 36 + 24 * t;
    return { h, r, g, b, rough: 0.9 };
  }, 3.5);
}
export function sandTexture(N = 1024) {
  return build(N, (u, v) => {
    const ripple = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 28 + fbm(u, v, 4, 2, 161) * 6);
    const grain = fbm(u, v, 120, 2, 171);
    const h = ripple * 0.6 + grain * 0.4, t = ripple * 0.5 + grain * 0.5;
    const r = 160 + 45 * t, g = 140 + 40 * t, b = 100 + 30 * t;
    return { h, r, g, b, rough: 0.9 };
  }, 1.6);
}

/**
 * 叶片簇（alpha 贴图）：一张图上很多片带叶脉的叶子，随机朝向，边缘透明。
 * 当作树冠的"叶片卡片"贴图用，alphaTest 裁掉透明区。
 */
export function leafClusterTexture(N = 512, seed = 1) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.clearRect(0, 0, N, N);
  const rnd = (k) => hash2(k, seed, 7);
  const leaves = 90;
  for (let i = 0; i < leaves; i++) {
    const cx = N * 0.5 + (rnd(i * 3) - 0.5) * N * 0.78, cy = N * 0.5 + (rnd(i * 3 + 1) - 0.5) * N * 0.78;
    const len = N * (0.07 + rnd(i * 3 + 2) * 0.07), wid = len * 0.42, ang = rnd(i * 5) * Math.PI * 2;
    const shade = 0.55 + rnd(i * 7) * 0.5;
    g.save(); g.translate(cx, cy); g.rotate(ang);
    const grd = g.createLinearGradient(-len, 0, len, 0);
    grd.addColorStop(0, `rgb(${(38 * shade) | 0},${(78 * shade) | 0},${(28 * shade) | 0})`);
    grd.addColorStop(1, `rgb(${(92 * shade) | 0},${(140 * shade) | 0},${(48 * shade) | 0})`);
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(-len, 0);
    g.quadraticCurveTo(0, -wid, len, 0); g.quadraticCurveTo(0, wid, -len, 0); g.fill();
    g.strokeStyle = `rgba(20,40,14,${0.5 * shade})`; g.lineWidth = 1; g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

/** 天空：带太阳光晕和地平线雾的等距圆柱图，用来做 IBL（PMREM）和背景。 */
export function skyEquirect(W = 1024, H = 512, opt = {}) {
  const sunAz = opt.sunAz ?? 0.6, sunEl = opt.sunEl ?? 0.45;   // 弧度：方位、仰角
  const zen = opt.zenith || [0.26, 0.42, 0.72], hor = opt.horizon || [0.78, 0.80, 0.86], sunC = opt.sun || [1.0, 0.95, 0.85];
  const gain = opt.gain ?? 1.0;
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const phi = (x / W) * Math.PI * 2 - Math.PI, theta = (0.5 - y / H) * Math.PI;   // theta: 仰角
    const up = Math.sin(theta), cx = Math.cos(theta) * Math.cos(phi), cz = Math.cos(theta) * Math.sin(phi);
    const sx = Math.cos(sunEl) * Math.cos(sunAz), sy = Math.sin(sunEl), sz = Math.cos(sunEl) * Math.sin(sunAz);
    const cosS = cx * sx + up * sy + cz * sz;
    const t = Math.max(0, up);
    const k = Math.pow(t, 0.45);
    let r = hor[0] + (zen[0] - hor[0]) * k, g = hor[1] + (zen[1] - hor[1]) * k, b = hor[2] + (zen[2] - hor[2]) * k;
    const glow = Math.pow(Math.max(0, cosS), 8) * 0.35 + Math.pow(Math.max(0, cosS), 200) * 6.0;
    r += sunC[0] * glow; g += sunC[1] * glow; b += sunC[2] * glow;
    if (up < 0) { const d = Math.min(1, -up * 3); r = r * (1 - d) + 0.32 * d; g = g * (1 - d) + 0.30 * d; b = b * (1 - d) + 0.26 * d; }
    const i = (y * W + x) * 4; data[i] = r * gain; data[i + 1] = g * gain; data[i + 2] = b * gain; data[i + 3] = 1;
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true;
  return t;
}
