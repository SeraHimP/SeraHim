/**
 * WorldGroundCover.js —— 地被与环境生物：草丛、野花、灌木、芦苇、碎石（全部实例化）+ 夜里的萤火虫。
 *
 * 摆放规则在 data/groundCover.js（纯数据）；这里只管"长什么样"：
 *   · 草丛 / 野花 / 芦苇：几张交叉的面片 + 带透明通道的贴图，法线一律朝上（受光和脚下的草地一样，不会一片亮一片暗）；
 *   · 灌木：一团叶片卡片（和树冠同一种贴图）；
 *   · 碎石：崖线巨石同一种石头，缩小了撒；
 *   · 萤火虫：一批点，在锚点附近慢慢游、一明一灭，只在夜里出现。
 * 风摆走世界共用的风（worldUniforms.uWWind）。都不参与碰撞。按分区成组，视锥外的组不画；草丛不投影。
 */
import * as THREE from '../../../vendor/three.module.js';
import { mergeGeometries } from '../../../vendor/BufferGeometryUtils.js';
import { CONFIG } from '../../data/Config.js';
import { fbm, hash2 } from '../../data/noise.js';
import { placeGroundCover, placeAmbientAnchors } from '../../data/groundCover.js';
import { leafTexture, softDotTexture } from './worldTextures.js';
import { patchWorldMaterial, worldUniforms } from './worldShading.js';
import { FX_PARTICLE_LAYER } from '../PostFX.js';

const _texCache = new Map();
/** 草叶 / 野花 / 芦苇的贴图：从底边中间往上散开的一丛叶子（透明底）。kind: 'tuft' | 'flower' | 'reed' */
function bladeTexture(kind, pal, N = 128) {
  const key = kind + JSON.stringify(pal);
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  const n = kind === 'reed' ? 9 : kind === 'flower' ? 12 : 18;
  const tips = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, lean = (t - 0.5) * (kind === 'reed' ? 0.5 : 1.5) + (hash2(i, 3, 5) - 0.5) * 0.3;
    const len = N * (kind === 'reed' ? 0.8 + hash2(i, 4, 5) * 0.18 : 0.5 + hash2(i, 4, 5) * 0.45), x0 = N * (0.5 + (t - 0.5) * 0.36);
    const x1 = x0 + lean * len * 0.6, y1 = N - len, w = N * (kind === 'reed' ? 0.022 : 0.034);
    const grd = g.createLinearGradient(0, N, 0, y1);
    grd.addColorStop(0, pal.dark); grd.addColorStop(1, hash2(i, 6, 5) > 0.7 ? pal.dry || pal.light : pal.light);   // 调色板是 sRGB 十六进制，画布也是 sRGB：直接用
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(x0 - w, N); g.quadraticCurveTo(x0 + lean * len * 0.15 - w * 0.5, N - len * 0.55, x1, y1);
    g.quadraticCurveTo(x0 + lean * len * 0.15 + w * 0.8, N - len * 0.5, x0 + w, N); g.fill();
    tips.push([x1, y1]);
  }
  if (kind === 'flower') {
    const cols = pal.petals || ['#ffffff', '#ffe066', '#c79bff'];
    tips.forEach(([x, y], i) => {
      if (i % 2) return;
      g.fillStyle = cols[i % cols.length];
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; g.beginPath(); g.arc(x + Math.cos(a) * N * 0.03, y + Math.sin(a) * N * 0.03, N * 0.028, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#f2b632'; g.beginPath(); g.arc(x, y, N * 0.018, 0, Math.PI * 2); g.fill();
    });
  }
  if (kind === 'reed') tips.forEach(([x, y], i) => { if (i % 3) return; g.fillStyle = pal.head || '#6b4a2e'; g.beginPath(); g.ellipse(x, y + N * 0.06, N * 0.018, N * 0.075, 0, 0, Math.PI * 2); g.fill(); });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  _texCache.set(key, tex);
  return tex;
}

/** 一丛：n 张绕竖轴错开的面片，底边在地面，法线朝上。 */
function crossCards(w, h, n = 3) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); g.rotateY(i / n * Math.PI + 0.3);
    const nr = g.attributes.normal; for (let k = 0; k < nr.count; k++) nr.setXYZ(k, 0, 1, 0);
    parts.push(g.toNonIndexed());
  }
  return mergeGeometries(parts, false);
}
/** 灌木：一团叶片卡片（压扁的球），贴着地。 */
function bushGeometry(seed, R) {
  const cards = [];
  for (let i = 0; i < 16; i++) {
    const u = hash2(seed, i * 3), v = hash2(seed, i * 3 + 1), w = hash2(seed, i * 3 + 2);
    const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1), rad = Math.cbrt(w);
    const s = R * (0.75 + hash2(seed, i + 77) * 0.5);
    const g = new THREE.PlaneGeometry(s, s);
    g.rotateX((hash2(seed, i + 11) - 0.5) * 1.6); g.rotateY(hash2(seed, i + 13) * Math.PI * 2);
    g.translate(R * rad * Math.sin(ph) * Math.cos(th), R * 0.5 + R * 0.45 * rad * Math.cos(ph), R * rad * Math.sin(ph) * Math.sin(th));
    cards.push(g.toNonIndexed());
  }
  return mergeGeometries(cards, false);
}
function pebbleGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.7 + fbm(p.getX(i) * 1.9 + seed, p.getY(i) * 1.9 + p.getZ(i), 2, 33) * 0.6;
    p.setXYZ(i, p.getX(i) * k * 1.2, Math.max(-0.2, p.getY(i) * k * 0.62), p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}
/** 风摆（地被版）：顶点越高摆得越多，每丛相位不同。 */
function sway(mat, hTop, amp) {
  const U = worldUniforms(), prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uWWind = U.uWWind; sh.uniforms.uWTime = U.uWTime;
    sh.vertexShader = 'uniform vec3 uWWind; uniform float uWTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float gk = clamp(position.y / ${hTop.toFixed(1)}, 0.0, 1.0); gk *= gk;
    float gph = instanceMatrix[3].x * 0.07 + instanceMatrix[3].z * 0.05;
    float gs = sin(uWTime * (1.6 + uWWind.z * 2.5) + gph) * 0.7 + sin(uWTime * 3.1 + gph * 1.9) * 0.3;
    float ga = ${amp.toFixed(2)} * (0.3 + 2.4 * uWWind.z);
    transformed.x += uWWind.x * ga * gk * (gs + uWWind.z * 1.4);
    transformed.z += uWWind.y * ga * gk * (gs + uWWind.z * 1.4);
  }`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|gsway' + hTop.toFixed(0);
  return mat;
}

/** 萤火虫：点在锚点附近游走、明灭。uNight 控制出没。 */
function fireflies(anchors, C) {
  const n = anchors.length, per = C.perAnchor ?? 2, N = n * per;
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = anchors[(i / per) | 0];
    pos[i * 3] = a.x; pos[i * 3 + 1] = a.h + 8 + hash2(i, 1, 3) * 22; pos[i * 3 + 2] = a.y;
    seed[i * 3] = hash2(i, 2, 3); seed[i * 3 + 1] = hash2(i, 3, 3); seed[i * 3 + 2] = hash2(i, 4, 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  geo.computeBoundingSphere(); geo.boundingSphere.radius += 80;
  const U = worldUniforms();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uWTime: U.uWTime, uNight: { value: 0 }, uPx: { value: 1 }, uMap: { value: softDotTexture() },
      uColor: { value: new THREE.Color(C.color || '#d8ff7a') }, uRoam: { value: C.roam ?? 46 }, uSize: { value: C.size ?? 3.2 }, uGain: { value: C.gain ?? 2.4 } },
    vertexShader: /* glsl */`
      attribute vec3 aSeed; uniform float uWTime, uNight, uPx, uRoam, uSize; varying float vA;
      void main() {
        float t = uWTime * (0.12 + aSeed.x * 0.14);
        vec3 p = position + vec3(sin(t + aSeed.y * 40.0) + 0.5 * sin(t * 2.3 + aSeed.z * 17.0), 0.25 * sin(t * 1.7 + aSeed.x * 31.0), cos(t * 0.9 + aSeed.z * 40.0) + 0.5 * cos(t * 2.1 + aSeed.y * 23.0)) * uRoam * 0.5;
        float blink = smoothstep(0.35, 0.9, sin(uWTime * (0.7 + aSeed.y * 1.3) + aSeed.z * 50.0) * 0.5 + 0.5);
        vA = blink * uNight * step(aSeed.x, 0.25 + 0.75 * uNight);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * uPx * (0.6 + 0.8 * aSeed.z) * (600.0 / max(60.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec3 uColor; uniform float uGain; varying float vA;
      void main() { if (vA < 0.01) discard; float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(uColor * uGain * a * vA, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat); pts.layers.set(FX_PARTICLE_LAYER); pts.renderOrder = 7; pts.matrixAutoUpdate = false;
  return { pts, geo, mat };
}

/** @returns { group, counts, update(ctx), dispose() } */
export function buildWorldGroundCover(field, theme) {
  const C = { ...(CONFIG.terrain?.cover || {}), ...(theme.cover || {}) };
  const group = new THREE.Group(); group.name = 'worldGroundCover';
  const disp = [];
  const cover = placeGroundCover(field, field.map, theme);
  const gp = theme.layers?.ground?.palette || {};
  const pal = { dark: C.bladeDark || gp.mid || '#5c752f', light: C.bladeLight || gp.light || '#86a83e', dry: gp.dry, petals: C.petals, head: C.reedHead };
  const leafPal = theme.foliage?.tree?.leaf || { dark: '#264e1c', light: '#5c8c30' };
  const SEC = C.sector ?? 900;
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
  const counts = {};
  /** 一种地被：geos = 几种变体的几何，mat 共用；size(o) → 缩放；sink 往地里埋多少 */
  const scatter = (kind, geos, mat, { scale, sink = 0, cast = false, tilt = 0 }) => {
    const list = cover[kind]; counts[kind] = list.length;
    if (!list.length) return;
    const buckets = new Map();
    for (const o of list) {
      const key = Math.floor(o.x / SEC) + ',' + Math.floor(o.y / SEC) + ',' + Math.min(geos.length - 1, (o.v * geos.length) | 0);
      (buckets.get(key) || buckets.set(key, []).get(key)).push(o);
    }
    for (const [key, items] of buckets) {
      const inst = new THREE.InstancedMesh(geos[+key.split(',')[2]], mat, items.length);
      items.forEach((o, i) => {
        E.set((o.v - 0.5) * tilt, o.r, (hash2(o.x, o.y, 9) - 0.5) * tilt); Q.setFromEuler(E);
        const s = scale * o.s; S.set(s, s * (0.85 + o.v * 0.3), s); P.set(o.x, o.h - sink * s, o.y);
        M.compose(P, Q, S); inst.setMatrixAt(i, M);
      });
      inst.castShadow = cast; inst.receiveShadow = true; inst.matrixAutoUpdate = false; inst.computeBoundingSphere();
      group.add(inst);
    }
    disp.push(mat, ...geos);
  };
  // 面片两面都画，但法线一律按"朝上"算（背面不翻转）：否则背对太阳的那一面是黑的，一丛草成了一撮黑毛
  const upNormal = (mat) => {
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(mat, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
    };
    mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|up';
    return mat;
  };
  const cardMat = (tex, hTop, amp) => upNormal(sway(patchWorldMaterial(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95 }), { dust: false, wetRough: 0.75, lightDir: false }), hTop, amp));
  if (typeof document !== 'undefined') {
    scatter('tuft', [crossCards(1.5, 1, 3), crossCards(1.2, 1.25, 2)], cardMat(bladeTexture('tuft', pal), 1, 0.16), { scale: C.tuftSize ?? 11 });
    // flowerGlow > 0：花自己发一点光（魔法森林的荧光花）
    const flowerTex = bladeTexture('flower', pal), flowerMat = cardMat(flowerTex, 1, 0.14);
    if ((C.flowerGlow ?? 0) > 0) { flowerMat.emissive = new THREE.Color('#ffffff'); flowerMat.emissiveMap = flowerTex; flowerMat.emissiveIntensity = C.flowerGlow; }
    scatter('flower', [crossCards(1.4, 1, 3)], flowerMat, { scale: C.flowerSize ?? 10 });
    scatter('reed', [crossCards(0.9, 1, 3)], cardMat(bladeTexture('reed', { ...pal, dark: C.reedDark || '#4a5a2a', light: C.reedLight || '#9aa24e' }), 1, 0.2), { scale: C.reedSize ?? 22, sink: 0.08 });
    const bushMat = sway(patchWorldMaterial(new THREE.MeshStandardMaterial({ map: leafTexture(leafPal, theme.foliage?.tree?.leafShape || 'broad', 256, 5), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9,
      color: new THREE.Color(C.bushTint || '#e6f2d2') }), { wetRough: 0.7, lightDir: false }), 1.2, 0.05);
    scatter('bush', [bushGeometry(3, 1), bushGeometry(11, 1), bushGeometry(23, 1)], bushMat, { scale: C.bushSize ?? 15, sink: 0.12, cast: true });
  }
  const rp = theme.layers?.rock?.palette || {};
  const pebMat = patchWorldMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(C.pebbleColor || rp.mid || '#8a8378'), roughness: 0.92, flatShading: true }));
  scatter('pebble', [pebbleGeometry(0), pebbleGeometry(5.1), pebbleGeometry(9.7)], pebMat, { scale: C.pebbleSize ?? 3.2, sink: 0.25, cast: true, tilt: 0.6 });

  // 萤火虫
  const A = { ...(CONFIG.terrain?.ambient || {}), ...(theme.ambient || {}) };
  let fly = null;
  if (A.enabled !== false && A.fireflies !== false && typeof document !== 'undefined') {
    const anchors = placeAmbientAnchors(field, field.map, theme);
    if (anchors.length) { fly = fireflies(anchors, A); group.add(fly.pts); disp.push(fly.geo, fly.mat); counts.fireflies = anchors.length; }
  }
  return {
    group, counts,
    update(ctx) {
      if (!fly) return;
      // 入夜才出来；下雨、刮大风时躲起来
      const calm = 1 - Math.min(1, (ctx.weather?.wet || 0) * 1.5 + (ctx.wind?.strength || 0));
      fly.mat.uniforms.uNight.value = Math.max(0, Math.min(1, ((ctx.night || 0) - 0.35) / 0.4)) * calm;
      fly.mat.uniforms.uPx.value = ctx.pixelRatio || 1;
      fly.pts.visible = fly.mat.uniforms.uNight.value > 0.01;
    },
    dispose() { for (const d of disp) d.dispose(); },
  };
}
