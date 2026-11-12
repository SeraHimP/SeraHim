/**
 * WorldMist.js —— 峡谷里的雾层 + 冰原上的冰棱（深渊图）。
 *
 * 雾层：峡谷里从上到下叠几张很大的水平薄片，每张是一层缓缓流动的雾（噪声决定哪里浓哪里淡）。
 * 地形 / 桥墩 / 崖面自己已经按高度融进雾色里（worldShading.patchAbyssFog），这几层薄片补的是"雾在动、
 * 雾有层次"：桥墩一截一截地被吞掉，越往下越看不清 —— 用户："桥两侧的那个雾可以加重一些显示出万丈深渊的感觉"。
 * 薄片比实地低，实地自然把它挡住，所以只在峡谷里看得见。
 *
 * 冰棱：冰原上不长树（用户："每张地图要有自己的设计语言……外围都是雷同一堆树，放在冰原 / 沙漠地图很违和"），
 * 实地的不可走区和地图外面零星立着几丛冰棱，仅此而已，宁缺毋滥。
 * 参数在主题的 abyssMist / spires。
 */
import * as THREE from '../../../vendor/three.module.js';
import { fbm, hash2 } from '../../data/noise.js';
import { FX_PARTICLE_LAYER } from '../PostFX.js';
import { worldUniforms, patchWorldMaterial, patchAbyssFog } from './worldShading.js';
import { worldNoiseTexture } from './worldTextures.js';

function mistMaterial(color, L) {
  const U = worldUniforms();
  if (!U.tWNoise.value) U.tWNoise.value = worldNoiseTexture();
  return new THREE.ShaderMaterial({
    uniforms: {
      uWTime: U.uWTime, tWNoise: U.tWNoise, uWDay: U.uWDay, uWWind: U.uWWind,
      uColor: { value: new THREE.Color(color) },
      uK: { value: new THREE.Vector4(L.alpha ?? 0.5, L.scale ?? 0.0016, L.speed ?? 0.012, L.cover ?? 0.35) },
    },
    vertexShader: /* glsl */`
      varying vec3 vP;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tWNoise; uniform float uWTime, uWDay; uniform vec3 uColor, uWWind; uniform vec4 uK;
      varying vec3 vP;
      void main() {
        vec2 drift = (uWWind.xy * (0.6 + uWWind.z) + vec2(0.3, 0.17)) * uWTime * uK.z;
        float n = texture2D(tWNoise, vP.xz * uK.y + drift).r * 0.6 + texture2D(tWNoise, vP.xz * uK.y * 2.7 - drift * 1.6 + 0.37).g * 0.4;
        float a = smoothstep(uK.w, uK.w + 0.42, n) * uK.x;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor * (0.16 + 0.84 * uWDay), a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

function spireGeometry(seed) {
  // 一丛冰棱：一根主棱 + 两三根斜着的小棱，硬棱面
  const parts = [];
  const n = 3 + ((hash2(seed, 1) * 3) | 0);
  for (let i = 0; i < n; i++) {
    const main = i === 0, h = main ? 1 : 0.35 + hash2(seed, i + 2) * 0.4, r = (main ? 0.2 : 0.11) + hash2(seed, i + 9) * 0.05;
    const g = new THREE.ConeGeometry(r, h, 5, 1);
    g.translate(0, h / 2, 0);
    if (!main) { g.rotateZ((hash2(seed, i + 13) - 0.5) * 1.1); g.rotateY(hash2(seed, i + 17) * 6.28); g.translate((hash2(seed, i + 21) - 0.5) * 0.36, 0, (hash2(seed, i + 23) - 0.5) * 0.36); }
    parts.push(g.toNonIndexed());
  }
  let total = 0; for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3); let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/** 冰棱的站位（纯数据）：实地上、不可走、离可走区有一段距离，成丛出现。返回 [{ x, y, h, s, r, v }] */
export function placeSpires(field, S = {}) {
  const out = [];
  if (!field.landAt) return out;
  const step = S.step ?? 46, reach = S.outerReach ?? 700, hQ = field.terrainHeightAt || field.heightAt;
  for (let gy = Math.floor(-reach / step); gy * step < field.H + reach; gy++) for (let gx = Math.floor(-reach / step); gx * step < field.W + reach; gx++) {
    const x = (gx + hash2(gx, gy, 61)) * step, y = (gy + hash2(gx, gy, 62)) * step;
    if (fbm(x * (S.clusterFreq ?? 0.0042), y * (S.clusterFreq ?? 0.0042), 2, 67) < (S.threshold ?? 0.6)) continue;   // 成丛
    if (hash2(gx, gy, 63) > (S.density ?? 0.5)) continue;
    const land = field.landAt(x, y);
    if (land.L < 1 || land.dc > -(S.cliffClear ?? 30)) continue;
    if (field.sdAt(x, y) < (S.walkClear ?? 46)) continue;
    const h = hQ(x, y);
    if (field.normalAt(x, y, 14)[1] < 0.6) continue;
    out.push({ x, y, h, s: (S.size?.[0] ?? 42) + hash2(gx, gy, 64) * ((S.size?.[1] ?? 110) - (S.size?.[0] ?? 42)), r: hash2(gx, gy, 65) * 6.28, v: hash2(gx, gy, 66) });
    if (out.length >= (S.max ?? 260)) return out;
  }
  return out;
}

export function buildWorldMist(field, theme) {
  const A = theme.abyssFog, M = theme.abyssMist, S = theme.spires;
  const group = new THREE.Group(); group.name = 'worldMist';
  const disp = [];
  let sheets = 0;
  if (A && M && M.enabled !== false && field.landmass) {
    const size = Math.max(field.W, field.H) + 2 * (M.reach ?? 2200);
    const geo = new THREE.PlaneGeometry(size, size, 1, 1); geo.rotateX(-Math.PI / 2);
    disp.push(geo);
    for (const L of (M.layers || [])) {
      const mat = mistMaterial(L.color || A.color || '#c2d2e2', L);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(field.W / 2, L.y ?? -80, field.H / 2); m.updateMatrix(); m.matrixAutoUpdate = false;
      m.frustumCulled = false; m.renderOrder = 3; m.layers.set(FX_PARTICLE_LAYER); m.name = 'abyssMist';
      group.add(m); disp.push(mat); sheets++;
    }
  }
  let spires = 0;
  if (S && S.enabled !== false) {
    const list = placeSpires(field, S);
    if (list.length) {
      const mat = patchAbyssFog(patchWorldMaterial(new THREE.MeshStandardMaterial({
        color: new THREE.Color(S.color ?? '#cfeaff'), emissive: new THREE.Color(S.glow ?? '#3a78b8'), emissiveIntensity: S.glowK ?? 0.22,
        roughness: S.roughness ?? 0.16, metalness: 0, flatShading: true, transparent: true, opacity: S.opacity ?? 0.93,
      }), { dust: false }), theme);
      const geos = [spireGeometry(1), spireGeometry(5), spireGeometry(9)];
      const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler();
      geos.forEach((g, gi) => {
        const mine = list.filter((o) => ((o.v * geos.length) | 0) === gi);
        if (!mine.length) return;
        const inst = new THREE.InstancedMesh(g, mat, mine.length);
        mine.forEach((o, i) => { E.set((o.v - 0.5) * 0.24, o.r, (hash2(o.x, o.y, 3) - 0.5) * 0.24); Q.setFromEuler(E); SC.set(o.s, o.s * (0.9 + o.v * 0.5), o.s); V.set(o.x, o.h - o.s * 0.06, o.y); inst.setMatrixAt(i, M4.compose(V, Q, SC)); });
        inst.castShadow = true; inst.receiveShadow = true; inst.matrixAutoUpdate = false; inst.computeBoundingSphere(); inst.name = 'iceSpires';
        group.add(inst);
      });
      disp.push(mat, ...geos); spires = list.length;
    }
  }
  if (!sheets && !spires) return null;
  return { group, counts: { sheets, spires }, dispose() { for (const d of disp) d.dispose(); } };
}
