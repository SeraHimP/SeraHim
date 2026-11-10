/**
 * trees.js —— 阶段 0 原型的树：树干（树皮贴图）+ 树冠（带透明贴图的叶片卡片簇），实例化。
 * 不是实心球：树冠由几十张随机朝向的叶片卡片组成，光从叶间穿过，影子是碎的。
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { fbm } from './terrain.js';

function hash(x, y, s = 0) { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); }

/** 一种树的几何：{ trunk, canopy }（局部坐标，树根在原点，高约 H） */
export function treeGeometry(seed, H = 70) {
  const r0 = H * 0.055;
  const trunk = new THREE.CylinderGeometry(r0 * 0.55, r0, H * 0.55, 9, 6);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + H * 0.275, k = 1 + (fbm(p.getX(i) * 0.2 + seed, y * 0.05, 2, 3) - 0.5) * 0.35;
    p.setXYZ(i, p.getX(i) * k, y, p.getZ(i) * k);
  }
  trunk.computeVertexNormals();
  // 几根主枝
  const parts = [trunk];
  for (let b = 0; b < 4; b++) {
    const a = b / 4 * Math.PI * 2 + hash(seed, b) * 0.8, L = H * (0.22 + hash(seed, b + 9) * 0.1);
    const g = new THREE.CylinderGeometry(r0 * 0.18, r0 * 0.38, L, 6, 1);
    g.translate(0, L / 2, 0);
    g.rotateZ(0.9 + hash(seed, b + 3) * 0.5); g.rotateY(a);
    g.translate(0, H * (0.38 + hash(seed, b + 5) * 0.12), 0);
    parts.push(g);
  }
  const trunkGeo = mergeGeometries(parts.map((g) => g.index ? g.toNonIndexed() : g), false);
  // 树冠：叶片卡片
  const cards = [];
  const cardN = 42, cy = H * 0.68, rx = H * 0.36, ry = H * 0.3;
  for (let i = 0; i < cardN; i++) {
    const u = hash(seed, i * 3), v = hash(seed, i * 3 + 1), w = hash(seed, i * 3 + 2);
    const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1), rad = Math.cbrt(w) * 0.95;
    const x = rx * rad * Math.sin(ph) * Math.cos(th), y = cy + ry * rad * Math.cos(ph), z = rx * rad * Math.sin(ph) * Math.sin(th);
    const s = H * (0.22 + hash(seed, i + 77) * 0.14);
    const g = new THREE.PlaneGeometry(s, s);
    g.rotateX((hash(seed, i + 11) - 0.5) * 1.6); g.rotateY(hash(seed, i + 13) * Math.PI * 2); g.rotateZ((hash(seed, i + 17) - 0.5) * 1.2);
    g.translate(x, y, z);
    cards.push(g.index ? g.toNonIndexed() : g);
  }
  const canopyGeo = mergeGeometries(cards, false);
  return { trunk: trunkGeo, canopy: canopyGeo };
}

export function buildTrees(sampler, region, placements, barkTex, leafTex, seedBase = 1) {
  const kinds = [0, 1, 2].map((k) => treeGeometry(seedBase + k * 17, 62 + k * 10));
  const trunkMat = new THREE.MeshStandardMaterial({ map: barkTex.map, normalMap: barkTex.normalMap, roughnessMap: barkTex.roughnessMap, roughness: 1, color: 0xcfc3b4 });
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff });
  // 叶片背光透一点（简化的次表面）
  leafMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.12;');
  };
  leafMat.customProgramCacheKey = () => 'lookdev-leaf-1';
  const group = new THREE.Group();
  const byKind = [[], [], []];
  for (const pl of placements) byKind[pl.kind].push(pl);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
  byKind.forEach((list, k) => {
    if (!list.length) return;
    const ti = new THREE.InstancedMesh(kinds[k].trunk, trunkMat, list.length);
    const ci = new THREE.InstancedMesh(kinds[k].canopy, leafMat, list.length);
    list.forEach((pl, i) => {
      E.set(0, pl.rot, (hash(pl.x, pl.y, 5) - 0.5) * 0.12); Q.setFromEuler(E); S.setScalar(pl.scale); P.set(pl.x, pl.h - 1, pl.y);
      M.compose(P, Q, S); ti.setMatrixAt(i, M); ci.setMatrixAt(i, M);
    });
    ti.castShadow = ci.castShadow = true; ti.receiveShadow = ci.receiveShadow = true;
    group.add(ti); group.add(ci);
  });
  return group;
}

/** 在切片里选树位：野区地面（离兵线远）、崖顶、延伸世界密林 */
export function placeTrees(sampler, region, count, seed = 3) {
  const out = []; let tries = 0;
  const { x0, y0, x1, y1 } = region;
  while (out.length < count && tries++ < count * 30) {
    const x = x0 + hash(tries, 1, seed) * (x1 - x0), y = y0 + hash(tries, 2, seed) * (y1 - y0);
    const k = sampler.kind(x, y);
    const wm = sampler.wallMask(x, y);
    let ok = false, scale = 1;
    if (k === 4) { ok = hash(tries, 3, seed) < 0.9; scale = 1.1 + hash(tries, 4, seed) * 0.5; }
    else if (k === 3) { ok = wm > 0.85 && hash(tries, 3, seed) < 0.35; scale = 0.8 + hash(tries, 4, seed) * 0.4; }
    else if (k === 2) { ok = sampler.laneDist(x, y) > 125 && wm < 0.08 && hash(tries, 3, seed) < 0.22; scale = 0.85 + hash(tries, 4, seed) * 0.4; }
    if (!ok) continue;
    // 不要挤在一起
    let near = false; for (const o of out) { if ((o.x - x) ** 2 + (o.y - y) ** 2 < 42 * 42 * scale) { near = true; break; } }
    if (near) continue;
    out.push({ x, y, h: sampler.h(x, y), rot: hash(tries, 6, seed) * Math.PI * 2, scale, kind: (hash(tries, 7, seed) * 3) | 0 });
  }
  return out;
}
