/**
 * noise.js —— 确定性的值噪声（同一坐标每次、每台机器都一样）。
 * 地形高度、河道弯曲、植被散布都靠它：地形是"算出来的"，不是存的，必须可复现，
 * 否则逻辑层查到的地面高度和画出来的地面会对不上。
 */
export function hash2(x, y, s = 0) {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
const fade = (t) => t * t * (3 - 2 * t);
export function vnoise(x, y, s = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
  const a = hash2(x0, y0, s), b = hash2(x0 + 1, y0, s), c = hash2(x0, y0 + 1, s), d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** 分形噪声，返回 0..1（均值约 0.5）。 */
export function fbm(x, y, oct = 4, s = 0) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f, s + i * 17) * a; n += a; a *= 0.5; f *= 2; }
  return v / n;
}
/** 脊状噪声（山脊 / 岩层），返回 0..1。 */
export function ridged(x, y, oct = 4, s = 0) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { const r = 1 - Math.abs(vnoise(x * f, y * f, s + i * 13) * 2 - 1); v += r * r * a; n += a; a *= 0.5; f *= 2; }
  return v / n;
}
export const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9))); return t * t * (3 - 2 * t); };
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
