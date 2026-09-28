/**
 * fogNoise.js —— 体积雾共用的噪声贴图：256² 可无缝平铺的平滑分形噪声（fBm）。
 *
 * 用户（2026-09-27）："虽然体积雾做出来了，但是看起来很粗糙"。原来的雾噪声是 64² 的纯随机值、
 * 靠双线性插值放大——出来是一格一格的方块和菱形纹，满屏细颗粒像砂纸。
 * 现在：五层平滑值噪声叠加（每层频率翻倍、振幅减半），双三次缓动插值（smoothstep），周期与贴图对齐所以能平铺。
 *   R = 主雾团，G = 另一组种子（给着色器做域扭曲，让雾团被拉成丝缕），B = 高频细节，A = 1。
 * 用确定性哈希而不是 Math.random：同一局、同一台机器每次看到的雾纹都一样，截图可复现。
 * 天气雾（PostFX.createFogPass）与腐蚀塔毒雾（CorrosionLayer）共用这一张。
 */
import * as THREE from '../../vendor/three.module.js';

const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
const fade = (t) => t * t * (3 - 2 * t);

/** 周期为 period 格的平滑值噪声，在 [0,1) × [0,1) 上采样（u, v 为 0..1） */
function valueNoise(u, v, period, seed) {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const w = (i, j) => hash(((x0 + i) % period + period) % period, ((y0 + j) % period + period) % period, seed);
  const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(u, v, base, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0, p = base;
  for (let o = 0; o < octaves; o++) { sum += valueNoise(u, v, p, seed + o * 13) * amp; norm += amp; amp *= 0.5; p *= 2; }
  return sum / norm;
}

let _tex = null;
export function fogNoiseTexture() {
  if (_tex) return _tex;
  const N = 256, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = (y * N + x) * 4;
      data[i] = Math.round(fbm(u, v, 4, 5, 1) * 255);
      data[i + 1] = Math.round(fbm(u, v, 4, 5, 101) * 255);
      data[i + 2] = Math.round(fbm(u, v, 16, 3, 201) * 255);
      data[i + 3] = 255;
    }
  }
  _tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  _tex.wrapS = _tex.wrapT = THREE.RepeatWrapping;
  _tex.magFilter = THREE.LinearFilter;
  _tex.minFilter = THREE.LinearMipmapLinearFilter;
  _tex.generateMipmaps = true;
  _tex.needsUpdate = true;
  return _tex;
}
