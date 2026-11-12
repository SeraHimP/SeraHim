/**
 * WorldRocks.js —— 崖线上的岩块：沿可走区与岩壁的交界撒一圈大石头（实例化）。
 * 高度场只能表达"一个 x,z 一个高度"，单靠它崖面是光滑的斜坡；压上一圈不规则的巨石，
 * 崖壁才是一块块垒起来的石头（用户认可的阶段 0 原型就是这个做法）。
 * 按地图分区成组，视锥外的组不画。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { fbm, hash2 } from '../../data/noise.js';
import { patchWorldMaterial, patchAbyssFog } from './worldShading.js';

function boulderGeometry(detail, seed) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.75 + fbm(x * 1.7 + 3 + seed, y * 1.7 + z * 1.3, 3, 33) * 0.6;
    p.setXYZ(i, x * k * 1.3, y * k * 0.8, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function rockMaterial(tex, color, theme) {
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normalMap, roughness: 0.9, metalness: 0, color });
  // 三向投影贴图（岩块是随机旋转的球体，UV 会拉伸）。切线基在顶点里算好（含实例矩阵）。
  const snow = theme?.rockSnow ?? 0, sc = new THREE.Color(theme?.rockSnowColor ?? '#eef3fa');
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vOP; varying vec3 vON; varying vec3 vTv; varying vec3 vBv; varying vec3 vSnowN;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vOP = position; vON = normal;
#ifdef USE_INSTANCING
  vSnowN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
#else
  vSnowN = mat3(modelMatrix) * normal;
#endif`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  vec3 tT = normalize(cross(vec3(0.0, 1.0, 0.0) + 0.01, normal)); vec3 tB = cross(normal, tT);
#ifdef USE_INSTANCING
  tT = mat3(instanceMatrix) * tT; tB = mat3(instanceMatrix) * tB;
#endif
  vTv = normalize(normalMatrix * tT); vBv = normalize(normalMatrix * tB);`);
    sh.fragmentShader = `varying vec3 vOP; varying vec3 vON; varying vec3 vTv; varying vec3 vBv; varying vec3 vSnowN;
vec4 tri4(sampler2D t, vec3 p, vec3 n, float s){ vec3 w = abs(n); w = w*w; w /= (w.x+w.y+w.z); return texture2D(t, p.yz*s)*w.x + texture2D(t, p.xz*s)*w.y + texture2D(t, p.xy*s)*w.z; }
` + sh.fragmentShader
      .replace('#include <map_fragment>', 'vec4 rk = tri4(map, vOP, normalize(vON), 0.35); diffuseColor.rgb *= rk.rgb;' + (snow > 0
        // 冰原上的石头顶上常年盖着雪（按世界朝上的程度）
        ? ` { float sn = smoothstep(0.35, 0.75, normalize(vSnowN).y + (rk.a - 0.5) * 0.5) * ${snow.toFixed(2)}; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${sc.r.toFixed(3)}, ${sc.g.toFixed(3)}, ${sc.b.toFixed(3)}), sn); }` : ''))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * rk.a;')
      .replace('#include <normal_fragment_maps>', `vec3 tn = tri4(normalMap, vOP, normalize(vON), 0.35).xyz * 2.0 - 1.0; tn.xy *= 1.5;
  normal = normalize(normalize(vTv) * tn.x + normalize(vBv) * tn.y + normalize(vNormal) * tn.z);`);
  };
  mat.customProgramCacheKey = () => 'world-rock-2|' + snow + sc.getHexString();
  return patchAbyssFog(patchWorldMaterial(mat), theme);
}

/**
 * @param field 高度场  @param tex 岩石贴图 { map, normalMap }  @param theme 主题  @param keepOut [{ x, y, r }] 这些圆里不放石头
 */
export function buildWorldRocks(field, tex, theme, keepOut = []) {
  const C = CONFIG.terrain.rocks || {}, K = CONFIG.terrain.cliff;
  const group = new THREE.Group(); group.name = 'worldRocks';
  const spacing = C.spacing ?? 19, sMin = C.sizeMin ?? 10, sMax = C.sizeMax ?? 30;
  const drop = field.mode === 'drop';
  const inner = drop ? -2 : -3, outer = drop ? (C.dropBand ?? 30) : K.width + (C.bandExtra ?? 8);
  const SEC = C.sector ?? 640, buckets = new Map();
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
  let n = 0;
  for (let gy = 0; gy * spacing < field.H; gy++) for (let gx = 0; gx * spacing < field.W; gx++) {
    const x = (gx + hash2(gx, gy, 5)) * spacing, y = (gy + hash2(gx, gy, 6)) * spacing;
    const sd = field.sdAt(x, y);
    // 有陆块的深渊图：岩块只垒在实地上（可走区的边 + 崖线的沿），桥边没有 —— 桥是悬空的，边上不会堆着石头
    const land = field.landAt ? field.landAt(x, y) : null;
    const lip = land && sd > 0 && land.dc > -(C.lipBand ?? 34) && land.dc < (C.lipOver ?? 26);
    if (land && land.L < 0.5 && !lip) continue;
    if ((sd < inner || sd > outer) && !lip) continue;
    if (hash2(gx, gy, 7) > (C.density ?? 0.8)) continue;
    if (keepOut.some((k) => (k.x - x) ** 2 + (k.y - y) ** 2 < k.r * k.r)) continue;   // 给场景物让位（据点的风车、钻机……不埋在石头堆里）
    if (field.riverAt(x, y) > 0.35 && sd < 6) continue;          // 不把河道堵死
    const s = sMin + hash2(gx, gy, 8) * (sMax - sMin) * (0.45 + 0.55 * Math.min(1, Math.max(0, sd + 6) / 22));   // 崖脚的小、崖身的大
    const h = (field.terrainHeightAt || field.heightAt)(x, y);
    E.set(hash2(gx, gy, 9) * 6.28, hash2(gx, gy, 10) * 6.28, hash2(gx, gy, 11) * 6.28); Q.setFromEuler(E);
    S.set(s, s * (0.7 + hash2(gx, gy, 12) * 0.6), s); P.set(x, h - s * 0.3, y);
    M.compose(P, Q, S);
    const key = Math.floor(x / SEC) + ',' + Math.floor(y / SEC) + ',' + ((hash2(gx, gy, 13) * 2) | 0);
    (buckets.get(key) || buckets.set(key, []).get(key)).push(M.clone());
    n++;
  }
  const geos = [boulderGeometry(C.detail ?? 1, 0), boulderGeometry(C.detail ?? 1, 7.3)];
  const mat = rockMaterial(tex, new THREE.Color(theme.rockTint ?? '#c9c3b8'), theme);
  for (const [key, list] of buckets) {
    const kind = +key.split(',')[2];
    const inst = new THREE.InstancedMesh(geos[kind], mat, list.length);
    for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
    inst.castShadow = true; inst.receiveShadow = true; inst.matrixAutoUpdate = false;
    inst.computeBoundingSphere();
    group.add(inst);
  }
  return { group, count: n, dispose() { geos.forEach((g) => g.dispose()); mat.dispose(); } };
}
