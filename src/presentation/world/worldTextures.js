/**
 * worldTextures.js —— 程序化 PBR 贴图（可平铺）：地表五层（地面 / 路 / 岩 / 点缀 / 铺石）+ 树皮 / 叶片 / 水面法线。
 *
 * 每种材质一次生成两张图：
 *   albedo：RGB = 颜色（sRGB），A = 粗糙度
 *   normal：切线空间法线（由同一份高度算出来），A = 高度（给着色器做"按高度混合"用，过渡边才不是一条糊边）
 * 配色全部由调色板参数给（CONFIG.terrain.themes[*].palette），四套主题共用同一批生成函数。
 * 这些是程序化贴图；以后要换照片级素材，按同样的两张图替换 getWorldTextureSet 的返回值即可，着色器不用动。
 */
import * as THREE from '../../../vendor/three.module.js';

// ---------- 可平铺噪声 ----------
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
/** 可平铺的蜂窝噪声：返回 [到最近点的距离, 到次近点的距离, 最近点的随机值]（距离按格归一）。 */
function worley(u, v, period, seed) {
  const x = u * period, y = v * period, xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 9, d2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, wx = ((cx % period) + period) % period, wy = ((cy % period) + period) % period;
    const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 5);
    const d = Math.hypot(px - x, py - y);
    if (d < d1) { d2 = d1; d1 = d; id = hash2(wx, wy, seed + 9); } else if (d < d2) d2 = d;
  }
  return [d1, d2, id];
}
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// 调色板写的是 sRGB 十六进制；THREE.Color 内部存的是线性值，这里要的是 sRGB 的 0..255（贴图按 sRGB 存）。
// 直接拿 Color.r 会把线性值当 sRGB 写进贴图，采样时再解一次码，整张图暗一大截。
const hexRGB = (hex) => { const n = new THREE.Color(hex).getHex(THREE.SRGBColorSpace); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function finish(tex, srgb, aniso) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
/** fn(u, v) → { c:[r,g,b] 0..255, h: 0..1 高度, rough: 0..1 }；返回 { map, normalMap } */
function build(N, fn, nStrength, aniso = 8) {
  const h = new Float32Array(N * N), alb = new Uint8Array(N * N * 4), nrm = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x, o = fn(x / N, y / N);
    h[k] = o.h;
    alb[k * 4] = clamp255(o.c[0]); alb[k * 4 + 1] = clamp255(o.c[1]); alb[k * 4 + 2] = clamp255(o.c[2]); alb[k * 4 + 3] = clamp255(o.rough * 255);
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const L = h[y * N + ((x - 1 + N) % N)], R = h[y * N + ((x + 1) % N)], U = h[((y - 1 + N) % N) * N + x], D = h[((y + 1) % N) * N + x];
    let nx = (L - R) * nStrength, ny = (U - D) * nStrength, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * N + x) * 4;
    nrm[i] = (nx * 0.5 + 0.5) * 255; nrm[i + 1] = (ny * 0.5 + 0.5) * 255; nrm[i + 2] = (nz * 0.5 + 0.5) * 255; nrm[i + 3] = clamp255(h[y * N + x] * 255);
  }
  return { map: finish(new THREE.DataTexture(alb, N, N), true, aniso), normalMap: finish(new THREE.DataTexture(nrm, N, N), false, aniso) };
}

// ---------- 各种地表 ----------
/** 草地：团块 + 细叶纹理，带枯黄斑。pal = { dark, mid, light, dry } */
function grass(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), dry = hexRGB(pal.dry);
  return build(N, (u, v) => {
    const clump = fbm(u, v, 14, 4, 21), blade = ridged(u + clump * 0.03, v, 110, 2, 31), fine = vnoise(u, v, 200, 37);
    const patch = fbm(u, v, 4, 3, 41);
    const t = clump * 0.55 + blade * 0.3 + fine * 0.15;
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, dry, sstep(0.55, 0.8, patch) * 0.55);
    return { c, h: clump * 0.5 + blade * 0.5, rough: 0.88 + 0.1 * (1 - t) };
  }, 2.4);
}
/** 泥路：压实的土 + 嵌在里面的碎石 + 车辙状的浅沟。pal = { dark, mid, light, stone } */
function dirt(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), st = hexRGB(pal.stone);
  return build(N, (u, v) => {
    const base = fbm(u, v, 6, 4, 51), grit = vnoise(u, v, 180, 53);
    const [d1, d2, id] = worley(u, v, 22, 61);
    const pebble = sstep(0.34, 0.2, d1) * (id > 0.45 ? 1 : 0);      // 稀疏嵌着的石子
    const crack = Math.pow(1 - Math.min(1, (d2 - d1) * 3.2), 6) * (1 - pebble) * 0.35;
    const t = base * 0.7 + grit * 0.3;
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, mix3(st, lt, id * 0.5), pebble * 0.85);
    c = mix3(c, dk, crack);
    return { c, h: base * 0.45 + grit * 0.1 + pebble * 0.45 - crack * 0.3, rough: 0.93 - 0.2 * pebble };
  }, 3.0);
}
/** 岩石：层理 + 裂隙 + 风化色斑。pal = { dark, mid, light, stain }；strata 越大层理越明显 */
function rock(N, pal, strata = 0.6) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), stn = hexRGB(pal.stain);
  return build(N, (u, v) => {
    const warp = fbm(u, v, 3, 3, 81) * 0.12;
    const layers = ridged(u * 0.35 + warp, v + warp * 0.6, 9, 4, 91);
    const chips = ridged(u, v, 40, 3, 101), grain = vnoise(u, v, 160, 103);
    const [d1, d2] = worley(u + warp * 0.3, v, 7, 107);
    const fissure = Math.pow(1 - Math.min(1, (d2 - d1) * 2.4), 8);
    const hgt = layers * strata + chips * (1 - strata) * 0.8 + grain * 0.08 - fissure * 0.5;
    const t = Math.max(0, Math.min(1, layers * 0.55 + chips * 0.3 + grain * 0.15));
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, stn, sstep(0.5, 0.78, fbm(u, v, 5, 3, 111)) * 0.45);
    c = mix3(c, dk, fissure * 0.8);
    return { c, h: Math.max(0, hgt), rough: 0.78 + 0.18 * (1 - t) };
  }, 4.2);
}
/** 苔藓 / 林下落叶：软垫状。pal = { dark, mid, light, speck } */
function moss(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), sp = hexRGB(pal.speck);
  return build(N, (u, v) => {
    const pad = fbm(u, v, 10, 4, 121), fine = fbm(u, v, 80, 2, 131);
    const [d1, , id] = worley(u, v, 34, 137);
    const leaf = sstep(0.3, 0.12, d1) * (id > 0.6 ? 1 : 0);          // 零星的落叶 / 小花
    const t = pad * 0.6 + fine * 0.4;
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, sp, leaf * 0.8);
    return { c, h: pad * 0.7 + fine * 0.2 + leaf * 0.1, rough: 0.95 };
  }, 2.0);
}
/** 铺石（基地广场 / 塔座 / 龙坑台面）：不规则石板 + 缝。pal = { dark, mid, light, gap } */
function paving(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), gp = hexRGB(pal.gap);
  return build(N, (u, v) => {
    const [d1, d2, id] = worley(u + fbm(u, v, 4, 2, 141) * 0.04, v, 6, 151);
    const edge = d2 - d1, gap = sstep(0.09, 0.02, edge);
    const wear = fbm(u, v, 30, 3, 161), grain = vnoise(u, v, 170, 163);
    const t = Math.max(0, Math.min(1, id * 0.55 + wear * 0.3 + grain * 0.15));
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, gp, gap);
    const bevel = sstep(0.02, 0.2, edge);
    return { c, h: bevel * (0.75 + id * 0.25) + wear * 0.08, rough: 0.72 + 0.2 * gap + 0.08 * wear };
  }, 5.0);
}
/** 雪：风纹 + 细颗粒闪点。pal = { shade, mid, light } */
function snow(N, pal) {
  const sh = hexRGB(pal.shade), md = hexRGB(pal.mid), lt = hexRGB(pal.light);
  return build(N, (u, v) => {
    const drift = fbm(u, v * 0.6, 5, 4, 171), grain = vnoise(u, v, 190, 173), crust = ridged(u, v, 16, 3, 177);
    const t = Math.max(0, Math.min(1, drift * 0.6 + crust * 0.25 + grain * 0.15));
    const c = t < 0.5 ? mix3(sh, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    return { c, h: drift * 0.75 + crust * 0.2 + grain * 0.05, rough: 0.55 + 0.25 * grain };
  }, 1.5);
}
/** 冰：通透的蓝，内部裂纹和气泡。pal = { deep, mid, light, crack } */
function ice(N, pal) {
  const dp = hexRGB(pal.deep), md = hexRGB(pal.mid), lt = hexRGB(pal.light), ck = hexRGB(pal.crack);
  return build(N, (u, v) => {
    const body = fbm(u, v, 4, 4, 181);
    const [d1, d2] = worley(u + body * 0.08, v + body * 0.05, 5, 187);
    const crack = Math.pow(1 - Math.min(1, (d2 - d1) * 5.0), 10);
    const [b1] = worley(u, v, 40, 191);
    const bubble = sstep(0.16, 0.06, b1) * 0.6;
    let c = body < 0.5 ? mix3(dp, md, body * 2) : mix3(md, lt, (body - 0.5) * 2);
    c = mix3(c, ck, Math.min(1, crack + bubble));
    return { c, h: body * 0.3 + crack * 0.4, rough: 0.12 + 0.3 * crack + 0.2 * bubble };
  }, 1.4);
}
/** 沙：风成波纹。pal = { dark, mid, light } */
function sand(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light);
  return build(N, (u, v) => {
    const warp = fbm(u, v, 3, 3, 201);
    const ripple = 0.5 + 0.5 * Math.sin((v * 22 + warp * 2.2 + Math.sin(u * Math.PI * 2 * 2) * 0.12) * Math.PI * 2);
    const grain = vnoise(u, v, 200, 203), drift = fbm(u, v, 6, 3, 207);
    const t = Math.max(0, Math.min(1, ripple * 0.4 + drift * 0.4 + grain * 0.2));
    const c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    return { c, h: ripple * 0.55 + drift * 0.35 + grain * 0.1, rough: 0.9 };
  }, 1.8);
}
/** 龟裂的干土。pal = { dark, mid, light, crack } */
function cracked(N, pal) {
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light), ck = hexRGB(pal.crack);
  return build(N, (u, v) => {
    const [d1, d2, id] = worley(u + fbm(u, v, 5, 2, 211) * 0.03, v, 9, 213);
    const crack = sstep(0.07, 0.01, d2 - d1), grain = fbm(u, v, 60, 3, 217);
    const t = Math.max(0, Math.min(1, id * 0.4 + grain * 0.6));
    let c = t < 0.5 ? mix3(dk, md, t * 2) : mix3(md, lt, (t - 0.5) * 2);
    c = mix3(c, ck, crack);
    return { c, h: (1 - crack) * (0.7 + id * 0.3) * sstep(0, 0.3, d2 - d1) + grain * 0.1, rough: 0.92 };
  }, 3.6);
}
const GEN = { grass, dirt, rock, moss, paving, snow, ice, sand, cracked };

const _setCache = new Map();
/**
 * 一套主题的五层地表贴图。layers = { ground, path, rock, accent, paved }，每项 { kind, palette, strata? }。
 * 按内容缓存：两张地图用同一套参数时共用同一批贴图。
 */
export function getWorldTextureSet(layers, N = 512, aniso = 8) {
  const out = {};
  for (const slot of ['ground', 'path', 'rock', 'accent', 'paved']) {
    const L = layers[slot];
    const key = `${N}|${L.kind}|${JSON.stringify(L.palette)}|${L.strata ?? ''}`;
    let t = _setCache.get(key);
    if (!t) { t = GEN[L.kind](N, L.palette, L.strata); t.map.anisotropy = t.normalMap.anisotropy = aniso; _setCache.set(key, t); }
    out[slot] = t;
  }
  return out;
}

// ---------- 其它共用贴图 ----------
let _noiseTex = null;
/** 大尺度变化用的噪声图：R / G / B 三个不同尺度的分形噪声，A = 蜂窝（给水洼、雪斑的不规则边界用）。 */
export function worldNoiseTexture(N = 256) {
  if (_noiseTex) return _noiseTex;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    d[i] = fbm(u, v, 4, 4, 301) * 255; d[i + 1] = fbm(u, v, 9, 4, 311) * 255; d[i + 2] = fbm(u, v, 24, 3, 321) * 255;
    d[i + 3] = Math.min(1, worley(u, v, 8, 331)[0]) * 255;
  }
  _noiseTex = finish(new THREE.DataTexture(d, N, N), false, 4);
  return _noiseTex;
}

let _waterN = null;
/** 水面法线（两层不同尺度的波纹叠在一张图里）。 */
export function waterNormalTexture(N = 256) {
  if (_waterN) return _waterN;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    h[y * N + x] = vnoise(u, v, 6, 401) * 0.45 + vnoise(u, v, 13, 403) * 0.3 + vnoise(u, v, 31, 407) * 0.17 + vnoise(u, v, 64, 409) * 0.08;
  }
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const L = h[y * N + ((x - 1 + N) % N)], R = h[y * N + ((x + 1) % N)], U = h[((y - 1 + N) % N) * N + x], D = h[((y + 1) % N) * N + x];
    let nx = (L - R) * 7, ny = (U - D) * 7, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * N + x) * 4; d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = h[y * N + x] * 255;
  }
  _waterN = finish(new THREE.DataTexture(d, N, N), false, 4);
  return _waterN;
}

const _barkCache = new Map();
/** 树皮：竖向沟纹。pal = { dark, mid, light } */
export function barkTexture(pal, N = 256) {
  const key = JSON.stringify(pal);
  if (_barkCache.has(key)) return _barkCache.get(key);
  const dk = hexRGB(pal.dark), md = hexRGB(pal.mid), lt = hexRGB(pal.light);
  const t = build(N, (u, v) => {
    const fiber = ridged(u, v * 0.22, 14, 3, 501), knot = fbm(u, v, 5, 3, 511);
    const k = Math.max(0, Math.min(1, fiber * 0.7 + knot * 0.3));
    const c = k < 0.5 ? mix3(dk, md, k * 2) : mix3(md, lt, (k - 0.5) * 2);
    return { c, h: fiber * 0.8 + knot * 0.2, rough: 0.92 };
  }, 3.6, 4);
  _barkCache.set(key, t);
  return t;
}

const _leafCache = new Map();
/**
 * 叶片簇（带透明通道）：一张图上很多片带叶脉的叶子，当树冠"叶片卡片"的贴图，alphaTest 裁掉透明区。
 * shape: 'broad' 阔叶 | 'needle' 针叶 | 'frond' 羽状 | 'twisted' 稀疏枯叶
 */
export function leafTexture(pal, shape = 'broad', N = 256, seed = 1) {
  const key = JSON.stringify(pal) + shape + N + seed;
  if (_leafCache.has(key)) return _leafCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  const rnd = (k) => hash2(k, seed, 7);
  const A = hexRGB(pal.dark), B = hexRGB(pal.light);
  const col = (t, shade) => `rgb(${(mix(A[0], B[0], t) * shade) | 0},${(mix(A[1], B[1], t) * shade) | 0},${(mix(A[2], B[2], t) * shade) | 0})`;
  const count = shape === 'needle' ? 160 : shape === 'twisted' ? 46 : shape === 'frond' ? 26 : 96;
  for (let i = 0; i < count; i++) {
    const r0 = Math.sqrt(rnd(i * 3)) * N * 0.42, a0 = rnd(i * 3 + 1) * Math.PI * 2;
    const cx = N * 0.5 + Math.cos(a0) * r0, cy = N * 0.5 + Math.sin(a0) * r0;
    const shade = 0.6 + rnd(i * 7) * 0.5, t = rnd(i * 11);
    // 叶片大致朝外长，再带一点随机
    const ang = a0 + (rnd(i * 5) - 0.5) * 1.6;
    g.save(); g.translate(cx, cy); g.rotate(ang);
    if (shape === 'needle') {
      const len = N * (0.07 + rnd(i * 13) * 0.06);
      g.strokeStyle = col(t, shade); g.lineWidth = Math.max(1.2, N / 170); g.lineCap = 'round';
      g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke();
      for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(k * len / 4, 0); g.lineTo(k * len / 4 + len * 0.22, (k % 2 ? 1 : -1) * len * 0.3); g.stroke(); }
    } else if (shape === 'frond') {
      const len = N * (0.16 + rnd(i * 13) * 0.1);
      g.strokeStyle = col(t * 0.5, shade * 0.8); g.lineWidth = Math.max(1, N / 220);
      g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke();
      g.fillStyle = col(t, shade);
      for (let k = 0; k < 12; k++) {
        const px = -len + (k + 0.5) * (2 * len / 12), w = len * 0.26 * Math.sin((k + 0.5) / 12 * Math.PI);
        for (const sgn of [-1, 1]) { g.beginPath(); g.ellipse(px, sgn * w * 0.55, len / 14, w * 0.55, 0, 0, Math.PI * 2); g.fill(); }
      }
    } else {
      const len = N * (shape === 'twisted' ? 0.05 + rnd(i * 13) * 0.05 : 0.065 + rnd(i * 13) * 0.065), wid = len * (shape === 'twisted' ? 0.34 : 0.46);
      const grd = g.createLinearGradient(-len, 0, len, 0);
      grd.addColorStop(0, col(t * 0.4, shade * 0.75)); grd.addColorStop(1, col(0.4 + t * 0.6, shade));
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(-len, 0); g.quadraticCurveTo(0, -wid, len, 0); g.quadraticCurveTo(0, wid, -len, 0); g.fill();
      g.strokeStyle = col(0, shade * 0.55); g.lineWidth = Math.max(0.8, N / 300);
      g.beginPath(); g.moveTo(-len, 0); g.lineTo(len, 0); g.stroke();
    }
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  _leafCache.set(key, tex);
  return tex;
}

let _softDot = null;
/** 柔边圆点（火焰 / 萤火 / 水雾 / 尘粒粒子共用）。 */
export function softDotTexture(N = 64) {
  if (_softDot) return _softDot;
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, N, N);
  _softDot = new THREE.CanvasTexture(c);
  return _softDot;
}
