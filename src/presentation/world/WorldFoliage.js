/**
 * WorldFoliage.js —— 植被：树（树干 + 叶片卡片树冠）、灌木、草丛，全部实例化。
 *
 * 树冠不是实心球：由几十张随机朝向的带透明贴图的叶片卡片组成，光从叶间穿过，影子是碎的
 * （用户认可的阶段 0 原型的做法，几何原样沿用）。
 * 分布：崖顶成林（把可走区围成"林间峡谷"）、野地零星几棵、地图之外是密林，一直铺进雾里。
 * 兵线、建筑、河道、营地附近不种东西。
 * 按地图分区成组（视锥外的组不画）；远处密林用简化的树、不投影。
 * 风：顶点着色器里按高度摆动，强度跟天气的风走（worldUniforms.uWWind）。
 */
import * as THREE from '../../../vendor/three.module.js';
import { mergeGeometries } from '../../../vendor/BufferGeometryUtils.js';
import { CONFIG } from '../../data/Config.js';
import { fbm, hash2 } from '../../data/noise.js';
import { barkTexture, leafTexture } from './worldTextures.js';
import { patchWorldMaterial, worldUniforms } from './worldShading.js';

/** 一种树的几何：{ trunk, canopy }（局部坐标，树根在原点，高约 H）。lod = true 时是远景用的简化版。 */
export function treeGeometry(seed, H = 70, shape = {}, lod = false) {
  const r0 = H * (shape.trunkR ?? 0.055), trunkH = H * (shape.trunkH ?? 0.55);
  const trunk = new THREE.CylinderGeometry(r0 * 0.55, r0, trunkH, lod ? 5 : 9, lod ? 1 : 6);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + trunkH / 2, k = 1 + (fbm(p.getX(i) * 0.2 + seed, y * 0.05, 2, 3) - 0.5) * 0.35;
    p.setXYZ(i, p.getX(i) * k, y, p.getZ(i) * k);
  }
  trunk.computeVertexNormals();
  const parts = [trunk];
  if (!lod) for (let b = 0; b < 4; b++) {          // 几根主枝
    const a = b / 4 * Math.PI * 2 + hash2(seed, b) * 0.8, L = H * (0.22 + hash2(seed, b + 9) * 0.1);
    const g = new THREE.CylinderGeometry(r0 * 0.18, r0 * 0.38, L, 6, 1);
    g.translate(0, L / 2, 0);
    g.rotateZ(0.9 + hash2(seed, b + 3) * 0.5); g.rotateY(a);
    g.translate(0, H * (0.38 + hash2(seed, b + 5) * 0.12), 0);
    parts.push(g);
  }
  const trunkGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  // 树冠：叶片卡片。conical = 针叶树（上尖下宽）
  const cards = [];
  const cardN = lod ? 14 : (shape.cards ?? 42), cy = H * (shape.crownY ?? 0.68), rx = H * (shape.crownRX ?? 0.36), ry = H * (shape.crownRY ?? 0.3);
  for (let i = 0; i < cardN; i++) {
    const u = hash2(seed, i * 3), v = hash2(seed, i * 3 + 1), w = hash2(seed, i * 3 + 2);
    const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1), rad = Math.cbrt(w) * 0.95;
    let x = rx * rad * Math.sin(ph) * Math.cos(th), y = cy + ry * rad * Math.cos(ph), z = rx * rad * Math.sin(ph) * Math.sin(th);
    if (shape.conical) { const t = Math.max(0, Math.min(1, (y - (cy - ry)) / (2 * ry))); x *= 1.25 * (1 - t * 0.85); z *= 1.25 * (1 - t * 0.85); }
    const s = H * (0.22 + hash2(seed, i + 77) * 0.14) * (lod ? 1.5 : 1) * (shape.cardK ?? 1);
    const g = new THREE.PlaneGeometry(s, s);
    g.rotateX((hash2(seed, i + 11) - 0.5) * 1.6); g.rotateY(hash2(seed, i + 13) * Math.PI * 2); g.rotateZ((hash2(seed, i + 17) - 0.5) * 1.2);
    g.translate(x, y, z);
    cards.push(g.index ? g.toNonIndexed() : g);
  }
  return { trunk: trunkGeo, canopy: mergeGeometries(cards, false) };
}

/** 风摆：按顶点高度往风向偏，每棵树相位不同。swayH = 多高的顶点摆到满幅。 */
function patchSway(mat, swayH, amp) {
  const U = worldUniforms();
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uWWind = U.uWWind; sh.uniforms.uWTime = U.uWTime;
    sh.vertexShader = 'uniform vec3 uWWind; uniform float uWTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float swK = clamp(position.y / ${swayH.toFixed(1)}, 0.0, 1.0); swK *= swK;
    #ifdef USE_INSTANCING
      float swPh = instanceMatrix[3].x * 0.031 + instanceMatrix[3].z * 0.047;
    #else
      float swPh = 0.0;
    #endif
    float swA = ${amp.toFixed(2)} * (0.35 + 2.2 * uWWind.z);
    float sw = sin(uWTime * (1.3 + uWWind.z * 2.0) + swPh) * 0.6 + sin(uWTime * 2.7 + swPh * 1.7 + position.x * 0.05) * 0.4;
    transformed.x += uWWind.x * swA * swK * (sw + uWWind.z * 1.5);
    transformed.z += uWWind.y * swA * swK * (sw + uWWind.z * 1.5);
  }`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|sway' + swayH.toFixed(0);
  return mat;
}

function leafMaterial(tex, tint) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: new THREE.Color(tint ?? '#ffffff') });
  // 叶片背光透一点（简化的次表面）
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.12;');
  };
  mat.customProgramCacheKey = () => 'world-leaf-1';
  return mat;
}

/** 选树位。返回 [{ x, y, h, rot, scale, kind, far }] */
function placeTrees(field, map, F) {
  const out = [], W = field.W, H = field.H;
  const cellSz = 64, grid = new Map();
  const near = (x, y, d) => {
    const gx = Math.floor(x / cellSz), gy = Math.floor(y / cellSz);
    for (let j = gy - 1; j <= gy + 1; j++) for (let i = gx - 1; i <= gx + 1; i++) {
      const l = grid.get(i + ',' + j); if (!l) continue;
      for (const o of l) if ((o.x - x) ** 2 + (o.y - y) ** 2 < d * d) return true;
    }
    return false;
  };
  const put = (o) => { const k = Math.floor(o.x / cellSz) + ',' + Math.floor(o.y / cellSz); (grid.get(k) || grid.set(k, []).get(k)).push(o); out.push(o); };
  // 建筑 / 营地 / 龙坑附近不种
  const keep = [];
  for (const b of (map.buildings || [])) { const p = b.pos || b; if (Number.isFinite(p.x)) keep.push({ x: p.x, y: p.y, r: 120 }); }
  for (const c of (map.neutralCamps || [])) { const p = c.pos || c; if (Number.isFinite(p?.x)) keep.push({ x: p.x, y: p.y, r: 110 }); }
  for (const p of field.pits) keep.push({ x: p.x, y: p.y, r: p.r * 1.7 });
  for (const b of field.bases) keep.push({ x: b.c.x, y: b.c.y, r: Math.min(b.r * 0.55, 470) });
  const blocked = (x, y) => { for (const k of keep) if ((k.x - x) ** 2 + (k.y - y) ** 2 < k.r * k.r) return true; return false; };
  const ext = F.outerReach ?? 950, step = F.gridStep ?? 30, drop = field.mode === 'drop';
  const K = CONFIG.terrain.cliff;
  for (let gy = Math.floor(-ext / step); gy * step < H + ext; gy++) for (let gx = Math.floor(-ext / step); gx * step < W + ext; gx++) {
    const x = (gx + hash2(gx, gy, 41)) * step, y = (gy + hash2(gx, gy, 42)) * step;
    const outside = x < 0 || y < 0 || x > W || y > H;
    const r = hash2(gx, gy, 43);
    let ok = false, scale = 1, far = false;
    const rf = field.riverAt(x, y);
    if (rf > 0.02) continue;
    if (outside) {
      const h = field.heightAt(x, y);
      if (drop && h < -30) continue;                              // 深渊里不长树
      const slope = field.normalAt(x, y, 12)[1];
      ok = slope > 0.72 && r < (F.outerDensity ?? 0.5); scale = 1.1 + hash2(gx, gy, 44) * 0.5; far = true;
    } else {
      const sd = field.sdAt(x, y);
      if (drop) continue;
      if (sd > K.width * 0.9) { ok = r < (F.cliffTopDensity ?? 0.42); scale = 0.8 + hash2(gx, gy, 44) * 0.45; }
      else if (sd < -26 && field.laneAt(x, y) > (F.laneClear ?? 150) && !blocked(x, y)) { ok = r < (F.jungleDensity ?? 0.05); scale = 0.85 + hash2(gx, gy, 44) * 0.4; }
    }
    if (!ok || near(x, y, (F.minGap ?? 40) * Math.sqrt(scale))) continue;
    put({ x, y, h: field.heightAt(x, y), rot: hash2(gx, gy, 46) * Math.PI * 2, scale, kind: (hash2(gx, gy, 47) * 3) | 0, far });
  }
  return out;
}

export function buildWorldFoliage(field, theme) {
  const F = { ...(CONFIG.terrain.foliage || {}), ...(theme.foliage || {}) };
  const group = new THREE.Group(); group.name = 'worldFoliage';
  const disposables = [];
  if (F.trees === false) return { group, dispose() {} };
  const T = F.tree || {};
  const bark = barkTexture(T.bark || { dark: '#3a2e24', mid: '#5c4a3a', light: '#7c6650' });
  const leaf = leafTexture(T.leaf || { dark: '#264e1c', light: '#5c8c30' }, T.leafShape || 'broad', 256, 2);
  const H0 = T.height ?? 62, shape = T.shape || {};
  const kinds = [0, 1, 2].map((k) => treeGeometry(1 + k * 17, H0 + k * 10, shape, false));
  const kindsFar = [0, 1, 2].map((k) => treeGeometry(1 + k * 17, H0 + k * 10, shape, true));
  const trunkMat = patchWorldMaterial(new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughness: 0.95, color: new THREE.Color(T.barkTint ?? '#cfc3b4') }));
  const leafMat = patchSway(patchWorldMaterial(leafMaterial(leaf, T.leafTint)), H0, T.sway ?? 1.6);
  patchSway(trunkMat, H0 * 2.2, (T.sway ?? 1.6) * 0.5);
  disposables.push(trunkMat, leafMat, ...kinds.flatMap((k) => [k.trunk, k.canopy]), ...kindsFar.flatMap((k) => [k.trunk, k.canopy]));

  const trees = placeTrees(field, field.map, F);
  const SEC = F.sector ?? 700, buckets = new Map();
  for (const t of trees) {
    const key = Math.floor(t.x / SEC) + ',' + Math.floor(t.y / SEC) + ',' + t.kind + ',' + (t.far ? 1 : 0);
    (buckets.get(key) || buckets.set(key, []).get(key)).push(t);
  }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
  for (const [key, list] of buckets) {
    const [, , kind, far] = key.split(',').map(Number);
    const g = far ? kindsFar[kind] : kinds[kind];
    const ti = new THREE.InstancedMesh(g.trunk, trunkMat, list.length), ci = new THREE.InstancedMesh(g.canopy, leafMat, list.length);
    list.forEach((t, i) => {
      E.set(0, t.rot, (hash2(t.x, t.y, 5) - 0.5) * 0.12); Q.setFromEuler(E); S.setScalar(t.scale); P.set(t.x, t.h - 1, t.y);
      M.compose(P, Q, S); ti.setMatrixAt(i, M); ci.setMatrixAt(i, M);
    });
    for (const m of [ti, ci]) { m.castShadow = !far; m.receiveShadow = true; m.matrixAutoUpdate = false; m.computeBoundingSphere(); group.add(m); }
  }
  return { group, count: trees.length, dispose() { for (const d of disposables) d.dispose(); } };
}
