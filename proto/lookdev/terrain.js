/**
 * terrain.js —— 阶段 0 原型的地形：高度场 + 多层 PBR 混合 + 崖壁岩块 + 延伸世界。
 *
 * 高度从 MapSystem 的地形判定推出来（可走 / 不可走 / 河道 / 到兵线距离），不另造一套布局：
 *   河床（-18）< 兵线路面（-2，踩出来的泥路）< 野区地面（+4，带起伏）< 野区岩壁（+60，顶上长苔藓）
 * 岩壁边缘用噪声侵蚀，再沿崖线撒一圈岩块（实例化），崖面就不是"挤出来的柱子"了。
 * 可玩区之外（延伸世界）：高度随距离上升成山壁，被雾吃掉，相机看不到地形尽头。
 */
import * as THREE from '../../vendor/three.module.js';

function hash(x, y, s = 0) { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); }
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, oct = 4, s = 0) { let v = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f, s + i) * a; n += a; a *= 0.5; f *= 2; } return v / n; }

/**
 * 高度采样器。bounds = 可玩区切片 {x0,y0,x1,y1}；map 判定来自 MapSystem。
 * 返回 { h(x,y), kind(x,y) }，kind: 0 河床 1 路面 2 野区地 3 岩壁 4 延伸世界
 */
export function makeHeightSampler(ms, P) {
  const lanes = ms.currentMap.lanes;
  const laneDist = (x, y) => { let d = Infinity; for (const l of lanes) d = Math.min(d, ms._nearestOnLane(l, x, y).dist); return d; };
  // 岩壁遮罩：不可走格 → 1，用噪声扭曲采样点让边缘不规则，再按距离软化
  const wallMask = (x, y) => {
    const wx = x + (fbm(x * 0.012, y * 0.012, 3, 5) - 0.5) * 36, wy = y + (fbm(x * 0.012, y * 0.012, 3, 9) - 0.5) * 36;
    // 对 5×5 邻域采样取平均 → 0..1 的软遮罩（崖面有坡度而不是 90° 直壁）
    let s = 0, n = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { s += ms.isWalkable(wx + i * 7, wy + j * 7) ? 0 : 1; n++; }
    return s / n;
  };
  const h = (x, y) => {
    const inPlay = x >= P.x0 && x <= P.x1 && y >= P.y0 && y <= P.y1;
    // 延伸世界：越远越高，成山壁；叠大尺度噪声
    const dOut = Math.max(P.x0 - x, x - P.x1, P.y0 - y, y - P.y1, 0);
    let base = 0;
    const wm = wallMask(x, y);
    const rf = ms.riverFactor(x, y);
    const ld = laneDist(x, y);
    const jungle = fbm(x * 0.02, y * 0.02, 3, 1) * 6;
    // 路面：离兵线 ≤ 95 是踩出来的泥路，略低；向野区地面过渡
    const laneT = Math.max(0, Math.min(1, (ld - 70) / 60));
    base = -2 + (4 + jungle) * laneT;
    base = base * (1 - rf) + (-26 - 4 * fbm(x * 0.05, y * 0.05, 2, 3)) * rf;   // 河床：最深处水面下 17
    // 岩壁：软遮罩 → 高度，顶部再叠噪声
    const wallH = 74 + fbm(x * 0.03, y * 0.03, 3, 4) * 16;
    const cliff = Math.pow(Math.max(0, Math.min(1, wm)), 2.2);
    let out = base * (1 - cliff) + wallH * cliff;
    if (dOut > 0) {
      const k = Math.min(1, dOut / 520);
      out = out * (1 - k) + (60 + 220 * Math.pow(k, 1.6) + fbm(x * 0.004, y * 0.004, 4, 6) * 90) * k + fbm(x * 0.03, y * 0.03, 3, 7) * 10 * k;
    }
    return out;
  };
  const kind = (x, y) => {
    const dOut = Math.max(P.x0 - x, x - P.x1, P.y0 - y, y - P.y1, 0);
    if (dOut > 60) return 4;
    if (wallMask(x, y) > 0.5) return 3;
    if (ms.riverFactor(x, y) > 0.35) return 0;
    if (laneDist(x, y) < 80) return 1;
    return 2;
  };
  return { h, kind, wallMask, laneDist };
}

/**
 * 地形网格 + 混合材质。每顶点属性 aSplat = (草, 泥路, 岩石, 苔藓)，片元里再用噪声打散边界，
 * 岩石用三向投影（陡坡不拉伸）。基于 MeshStandardMaterial 注入，保留 PBR 光照和阴影。
 */
export function buildTerrain(sampler, region, step, tex) {
  const { x0, y0, x1, y1 } = region;
  const nx = Math.ceil((x1 - x0) / step), ny = Math.ceil((y1 - y0) / step);
  const geo = new THREE.PlaneGeometry(x1 - x0, y1 - y0, nx, ny);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, N = pos.count;
  const splat = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const wx = pos.getX(i) + (x0 + x1) / 2, wz = pos.getZ(i) + (y0 + y1) / 2;
    const hgt = sampler.h(wx, wz);
    pos.setY(i, hgt);
    // 坡度（数值梯度）
    const d = 3, gx = (sampler.h(wx + d, wz) - sampler.h(wx - d, wz)) / (2 * d), gz = (sampler.h(wx, wz + d) - sampler.h(wx, wz - d)) / (2 * d);
    const slope = Math.min(1, Math.hypot(gx, gz) * 1.3);
    const rf = sampler.laneDist(wx, wz);
    let grass = 1, dirt = 0, rock = 0, moss = 0;
    dirt = Math.max(0, 1 - Math.max(0, rf - 38) / 42) * (hgt < 30 ? 1 : 0);           // 兵线上的泥路（约 80 宽），边缘毛糙由片元噪声打散
    if (hgt < -4) { dirt = Math.max(dirt, 0.7); }                                        // 河床：泥 + 卵石
    dirt *= 0.75 + 0.5 * fbm(wx * 0.015, wz * 0.015, 3, 29);                               // 路边缘不要一条直线
    rock = Math.max(rock, slope);                                                        // 陡坡全是岩
    if (hgt > 40) moss = 0.55 + 0.45 * fbm(wx * 0.03, wz * 0.03, 3, 21);                 // 岩壁顶上长苔藓
    if (hgt > 90) { rock = Math.max(rock, 0.6); moss *= 0.5; }                            // 延伸世界的山壁
    grass = Math.max(0, 1 - dirt - rock - moss);
    const s = grass + dirt + rock + moss || 1;
    splat[i * 4] = grass / s; splat[i * 4 + 1] = dirt / s; splat[i * 4 + 2] = rock / s; splat[i * 4 + 3] = moss / s;
  }
  pos.needsUpdate = true;
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tGrass = { value: tex.grass.map }; sh.uniforms.nGrass = { value: tex.grass.normalMap }; sh.uniforms.rGrass = { value: tex.grass.roughnessMap };
    sh.uniforms.tDirt = { value: tex.dirt.map }; sh.uniforms.nDirt = { value: tex.dirt.normalMap }; sh.uniforms.rDirt = { value: tex.dirt.roughnessMap };
    sh.uniforms.tRock = { value: tex.rock.map }; sh.uniforms.nRock = { value: tex.rock.normalMap }; sh.uniforms.rRock = { value: tex.rock.roughnessMap };
    sh.uniforms.tMoss = { value: tex.moss.map }; sh.uniforms.nMoss = { value: tex.moss.normalMap }; sh.uniforms.rMoss = { value: tex.moss.roughnessMap };
    sh.uniforms.uTile = { value: 1 / 160 };   // 一张贴图铺 160 世界单位
    sh.vertexShader = `attribute vec4 aSplat; varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWNrm;\n` + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vSplat = aSplat; vWPos = (modelMatrix * vec4(position, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * normal);');
    sh.fragmentShader = `
uniform sampler2D tGrass, nGrass, rGrass, tDirt, nDirt, rDirt, tRock, nRock, rRock, tMoss, nMoss, rMoss; uniform float uTile;
varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWNrm;
float hashf(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hashf(i), hashf(i+vec2(1,0)), f.x), mix(hashf(i+vec2(0,1)), hashf(i+vec2(1,1)), f.x), f.y); }
vec3 triplanar(sampler2D t, vec3 p, vec3 n, float s){ vec3 w = abs(n); w = w*w; w /= (w.x+w.y+w.z);
  return texture2D(t, p.yz*s).rgb*w.x + texture2D(t, p.xz*s).rgb*w.y + texture2D(t, p.xy*s).rgb*w.z; }
` + sh.fragmentShader
      .replace('#include <map_fragment>', `
  vec2 uvw = vWPos.xz * uTile;
  float nz = vn(vWPos.xz * 0.05) * 0.5 + vn(vWPos.xz * 0.013) * 0.5;
  vec4 w = vSplat;
  // 用噪声把顶点插值出来的软边打散：权重小的地方被噪声压掉，边界变成犬牙状
  w.x = max(0.0, w.x + (nz - 0.5) * 0.5); w.y = max(0.0, w.y + (0.5 - nz) * 0.6); w.w = max(0.0, w.w + (nz - 0.5) * 0.5);
  w = pow(w, vec4(2.5)); w /= (w.x + w.y + w.z + w.w + 1e-4);
  vec3 cG = texture2D(tGrass, uvw).rgb, cD = texture2D(tDirt, uvw * 1.3).rgb, cM = texture2D(tMoss, uvw * 1.1).rgb;
  vec3 cR = triplanar(tRock, vWPos, vWNrm, uTile * 0.9);
  vec3 col = cG * w.x + cD * w.y + cR * w.z + cM * w.w;
  float macro = 0.85 + 0.3 * vn(vWPos.xz * 0.004);   // 大尺度明暗，打破平铺感
  diffuseColor.rgb *= col * macro;
  float rgh = texture2D(rGrass, uvw).r * w.x + texture2D(rDirt, uvw * 1.3).r * w.y + 0.8 * w.z + texture2D(rMoss, uvw * 1.1).r * w.w;
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * rgh;')
      .replace('#include <normal_fragment_maps>', `
  vec3 tn = (texture2D(nGrass, uvw).xyz * w.x + texture2D(nDirt, uvw * 1.3).xyz * w.y + texture2D(nRock, vWPos.xz * uTile * 0.9).xyz * w.z + texture2D(nMoss, uvw * 1.1).xyz * w.w) * 2.0 - 1.0;
  tn.xy *= 1.2;
  // 切线空间近似：地形大体朝上，用世界 xz 当切线基
  vec3 T = normalize(cross(vec3(0.0, 0.0, 1.0), vWNrm)), B = normalize(cross(vWNrm, T));
  vec3 wn = normalize(T * tn.x + B * tn.y + vWNrm * tn.z);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
`);
  };
  mat.customProgramCacheKey = () => 'lookdev-terrain-1';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((x0 + x1) / 2, 0, (y0 + y1) / 2);
  mesh.receiveShadow = true; mesh.castShadow = true;
  return mesh;
}

/** 沿崖线撒岩块（实例化），每块按噪声扭成不规则形状。 */
export function buildCliffRocks(sampler, region, tex, count = 900) {
  const base = new THREE.IcosahedronGeometry(1, 2);
  const p = base.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.75 + fbm(x * 1.7 + 3, y * 1.7 + z * 1.3, 3, 33) * 0.6;
    p.setXYZ(i, x * k * 1.3, y * k * 0.8, z * k);
  }
  base.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex.rock.map, normalMap: tex.rock.normalMap, roughnessMap: tex.rock.roughnessMap, roughness: 1, metalness: 0, color: 0xb8b2a8 });
  // 三向投影贴图（岩块是随机旋转的球体，UV 会拉伸）
  mat.onBeforeCompile = (sh) => {
    // 三向投影的切线基在顶点里算好（含实例矩阵），片元只做合成——片元着色器里没有 modelMatrix
    sh.vertexShader = 'varying vec3 vOP; varying vec3 vON; varying vec3 vTv; varying vec3 vBv;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vOP = position; vON = normal;')
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  vec3 tT = normalize(cross(vec3(0.0, 1.0, 0.0) + 0.01, normal)); vec3 tB = cross(normal, tT);
#ifdef USE_INSTANCING
  tT = mat3(instanceMatrix) * tT; tB = mat3(instanceMatrix) * tB;
#endif
  vTv = normalize(normalMatrix * tT); vBv = normalize(normalMatrix * tB);`);
    sh.fragmentShader = `varying vec3 vOP; varying vec3 vON; varying vec3 vTv; varying vec3 vBv;
vec3 tri3(sampler2D t, vec3 p, vec3 n, float s){ vec3 w = abs(n); w = w*w; w /= (w.x+w.y+w.z); return texture2D(t, p.yz*s).rgb*w.x + texture2D(t, p.xz*s).rgb*w.y + texture2D(t, p.xy*s).rgb*w.z; }
` + sh.fragmentShader
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= tri3(map, vOP, normalize(vON), 0.35);')
      .replace('#include <normal_fragment_maps>', `vec3 tn = tri3(normalMap, vOP, normalize(vON), 0.35) * 2.0 - 1.0; tn.xy *= 1.5;
  normal = normalize(normalize(vTv) * tn.x + normalize(vBv) * tn.y + normalize(vNormal) * tn.z);`);
  };
  mat.customProgramCacheKey = () => 'lookdev-rock-1';
  const inst = new THREE.InstancedMesh(base, mat, count);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), E = new THREE.Euler();
  let n = 0, tries = 0;
  const { x0, y0, x1, y1 } = region;
  while (n < count && tries++ < count * 40) {
    const x = x0 + hash(tries, 1, 5) * (x1 - x0), y = y0 + hash(tries, 2, 5) * (y1 - y0);
    const wm = sampler.wallMask(x, y);
    if (wm < 0.1 || wm > 0.92) continue;     // 只在崖线附近
    const h = sampler.h(x, y);
    const s = 10 + hash(tries, 3, 5) * 20;
    E.set(hash(tries, 4, 5) * 6.28, hash(tries, 5, 5) * 6.28, hash(tries, 6, 5) * 6.28); Q.setFromEuler(E);
    S.set(s, s * (0.7 + hash(tries, 7, 5) * 0.6), s); Pv.set(x, h - s * 0.35, y);
    M.compose(Pv, Q, S); inst.setMatrixAt(n++, M);
  }
  inst.count = n; inst.castShadow = true; inst.receiveShadow = true;
  return inst;
}
