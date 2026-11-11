/**
 * WorldTerrain.js —— 地形网格：高度场（terrainField）→ 分块网格 + 五层 PBR 混合材质。
 *
 *  · 核心区（地图矩形）按高度场分辨率建网格，切成若干块，视锥外的块不画。
 *  · 延伸世界（地图之外）用粗网格往外铺到雾里，同一套材质，所以没有"地图边缘"。
 *  · 每个顶点带混合权重（地面 / 路 / 岩 / 点缀 + 铺石、水下、遮蔽），片元里按贴图高度做混合，
 *    过渡边是犬牙交错的自然边界，不是一条插值出来的糊边；岩石用三向投影，陡崖不拉伸。
 *  · 天气直接写在这份着色器里：湿（压暗、变光滑）、积雪（按法线朝上的程度 + 积雪深度图）、沙尘。
 *  · 局部光（火炬 / 水晶）查光照图，见 worldShading.js。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { fbm, smoothstep, clamp01 } from '../../data/noise.js';
import { structureRadius } from '../../data/structureRadius.js';
import { getWorldTextureSet } from './worldTextures.js';
import { worldUniforms, WORLD_FRAG_HEAD } from './worldShading.js';

const CHUNK = 64;   // 每块的格数（一边）

/** 顶点混合权重：返回 [ground, path, rock, accent, paved, under, ao]（0..1） */
function makeSplat(field, map) {
  const G = CONFIG.terrain.ground, K = CONFIG.terrain.cliff, P = CONFIG.terrain.paving || {};
  const level = field.waterLevel, drop = field.mode === 'drop';
  // 铺石区：基地广场、每座建筑的基座、龙坑台面
  const pads = [];
  for (const b of field.bases) pads.push({ x: b.c.x, y: b.c.y, r: Math.min(b.r * (P.baseK ?? 0.5), P.baseMax ?? 430), f: P.baseFeather ?? 60 });
  for (const b of (map.buildings || [])) {
    const pos = b.pos || b; if (!Number.isFinite(pos.x)) continue;
    let r = 46; try { r = structureRadius(b.tier || b._mapTier || 'outer') || 46; } catch (e) { /* 未知档位用默认 */ }
    pads.push({ x: pos.x, y: pos.y, r: r * (P.structK ?? 1.5), f: P.structFeather ?? 22 });
  }
  for (const p of field.pits) pads.push({ x: p.x, y: p.y, r: p.r * 0.9, f: 16 });
  // 空间哈希，免得每个顶点扫一遍所有建筑
  const cellSz = 300, grid = new Map();
  for (const p of pads) {
    const R = p.r + p.f;
    for (let gy = Math.floor((p.y - R) / cellSz); gy <= Math.floor((p.y + R) / cellSz); gy++)
      for (let gx = Math.floor((p.x - R) / cellSz); gx <= Math.floor((p.x + R) / cellSz); gx++) {
        const k = gx + ',' + gy; (grid.get(k) || grid.set(k, []).get(k)).push(p);
      }
  }
  const pavedAt = (x, y) => {
    const list = grid.get(Math.floor(x / cellSz) + ',' + Math.floor(y / cellSz));
    if (!list) return 0;
    let v = 0;
    for (const p of list) v = Math.max(v, 1 - smoothstep(p.r, p.r + p.f, Math.hypot(x - p.x, y - p.y)));
    return v;
  };
  return (x, y, hgt, ny, sdv, ld, rf, outside) => {
    const slope = 1 - ny;
    let rock = smoothstep(0.16, 0.42, slope);
    let path = 0, accent = 0, paved = 0;
    if (!outside) {
      if (sdv < 6) path = 1 - smoothstep(G.pathHalf * 0.72, G.pathHalf + G.pathFeather * 0.7, ld);
      if (drop && sdv < 2) path = Math.max(path, 0.75);                         // 桥 / 台地：整个可走面都是人工路面
      paved = sdv < 4 ? pavedAt(x, y) : 0;
      if (sdv > K.width * 0.7) accent = 0.55 + 0.45 * fbm(x * 0.012, y * 0.012, 2, 83);   // 崖顶长苔 / 落叶
      else if (sdv <= 0) accent = smoothstep(0.56, 0.72, fbm(x * 0.0075, y * 0.0075, 3, 87)) * (1 - path) * 0.85;   // 野地里的斑块
      if (rf > 0.02) path = Math.max(path, smoothstep(0.02, 0.5, rf) * 0.8);     // 河滩 / 河床：碎石
    } else {
      accent = smoothstep(0.5, 0.75, fbm(x * 0.004, y * 0.004, 3, 89)) * 0.6;
      if (rf > 0.02) path = smoothstep(0.02, 0.5, rf) * 0.8;
    }
    rock = Math.max(rock, 0);
    path *= 1 - rock; accent *= 1 - rock; paved *= 1 - rock;
    path *= 1 - paved; accent *= 1 - paved;
    accent *= 1 - path;
    const ground = Math.max(0, 1 - rock - path - accent - paved);
    const under = level == null ? 0 : clamp01((level - hgt) / 6);
    // 崖脚 / 窄缝的遮蔽：贴着岩壁的地面压暗一点，物体才"长在地上"
    let ao = 1;
    if (!outside && !drop) { if (sdv <= 0) ao = 0.82 + 0.18 * smoothstep(0, 40, -sdv); else ao = 0.86 + 0.14 * smoothstep(0, K.width, sdv); }
    return [ground, path, rock, accent, paved, under, ao, rf > 0 ? Math.min(1, rf * 2.5) : 0];
  };
}

function terrainMaterial(tex, theme, shadows) {
  const T = theme.tile || {};
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const U = worldUniforms();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, {
      tA0: { value: tex.ground.map }, tN0: { value: tex.ground.normalMap },
      tA1: { value: tex.path.map }, tN1: { value: tex.path.normalMap },
      tA2: { value: tex.rock.map }, tN2: { value: tex.rock.normalMap },
      tA3: { value: tex.accent.map }, tN3: { value: tex.accent.normalMap },
      tA4: { value: tex.paved.map }, tN4: { value: tex.paved.normalMap },
      uTile: { value: new THREE.Vector4(1 / (T.ground ?? 150), 1 / (T.path ?? 130), 1 / (T.rock ?? 190), 1 / (T.accent ?? 140)) },
      uTileP: { value: 1 / (T.paved ?? 110) },
      uSnowLine: { value: new THREE.Vector2(theme.snowLine ?? 1e5, theme.snowLineFade ?? 120) },
    });
    sh.vertexShader = `attribute vec4 aSplat; attribute vec4 aAux; varying vec4 vSplat; varying vec4 vAux; varying vec3 vWPos; varying vec3 vWNrm;\n`
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vSplat = aSplat; vAux = aAux; vWPos = (modelMatrix * vec4(position, 1.0)).xyz; vWNrm = normalize(mat3(modelMatrix) * normal);');
    sh.fragmentShader = WORLD_FRAG_HEAD + /* glsl */`
uniform sampler2D tA0, tN0, tA1, tN1, tA2, tN2, tA3, tN3, tA4, tN4;
uniform vec4 uTile; uniform float uTileP; uniform vec2 uSnowLine;
varying vec4 vSplat; varying vec4 vAux; varying vec3 vWNrm;
` + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
  vec3 wn0 = normalize(vWNrm);
  vec4 nzA = texture2D(tWNoise, vWPos.xz * 0.0013);       // 大尺度变化
  vec4 nzB = texture2D(tWNoise, vWPos.xz * 0.0094);       // 边界打散
  vec4 wS = vSplat; float wPv = vAux.x; float under = vAux.y; float vAO = vAux.z;
  // 路 / 斑块的边界用噪声打散：顶点插值出来的是一条软边，自然界里是犬牙交错的
  wS.y = smoothstep(0.30, 0.70, wS.y + (nzB.g - 0.5) * 0.55 * step(0.02, wS.y) * step(wS.y, 0.98));
  wS.w = smoothstep(0.25, 0.75, wS.w + (nzB.b - 0.5) * 0.6 * step(0.02, wS.w));
  wPv = smoothstep(0.35, 0.65, wPv + (nzB.r - 0.5) * 0.25 * step(0.02, wPv) * step(wPv, 0.98));
  vec4 a0 = texture2D(tA0, vWPos.xz * uTile.x), n0 = texture2D(tN0, vWPos.xz * uTile.x);
  vec4 a1 = texture2D(tA1, vWPos.xz * uTile.y), n1 = texture2D(tN1, vWPos.xz * uTile.y);
  vec4 a3 = texture2D(tA3, vWPos.xz * uTile.w), n3 = texture2D(tN3, vWPos.xz * uTile.w);
  vec4 a4 = texture2D(tA4, vWPos.xz * uTileP), n4 = texture2D(tN4, vWPos.xz * uTileP);
  // 岩石：三向投影（陡崖用侧面投影，不拉伸）
  vec4 a2 = vec4(0.5, 0.5, 0.5, 0.8), n2 = vec4(0.5, 0.5, 1.0, 0.5);
  vec3 tw = abs(wn0); tw = tw * tw * tw; tw /= (tw.x + tw.y + tw.z);
  if (wS.z > 0.004) {
    float ts = uTile.z;
    a2 = texture2D(tA2, vWPos.zy * ts) * tw.x + texture2D(tA2, vWPos.xz * ts) * tw.y + texture2D(tA2, vWPos.xy * ts) * tw.z;
    n2 = texture2D(tN2, vWPos.zy * ts) * tw.x + texture2D(tN2, vWPos.xz * ts) * tw.y + texture2D(tN2, vWPos.xy * ts) * tw.z;
  }
  // 按贴图高度混合：高的地方（石子、草丛）先露出来
  float w0 = wS.x * (0.35 + n0.a), w1 = wS.y * (0.35 + n1.a), w2 = wS.z * (0.5 + n2.a), w3 = wS.w * (0.35 + n3.a), w4 = wPv * (0.5 + n4.a);
  w0 *= 1.0 - wPv; w1 *= 1.0 - wPv; w3 *= 1.0 - wPv;
  w0 = pow(w0, 2.2); w1 = pow(w1, 2.2); w2 = pow(w2, 2.2); w3 = pow(w3, 2.2); w4 = pow(w4, 2.2);
  float wSum = w0 + w1 + w2 + w3 + w4 + 1e-5;
  w0 /= wSum; w1 /= wSum; w2 /= wSum; w3 /= wSum; w4 /= wSum;
  vec3 alb = a0.rgb * w0 + a1.rgb * w1 + a2.rgb * w2 + a3.rgb * w3 + a4.rgb * w4;
  float rgh = a0.a * w0 + a1.a * w1 + a2.a * w2 + a3.a * w3 + a4.a * w4;
  vec3 tn = (n0.xyz * w0 + n1.xyz * w1 + n2.xyz * w2 + n3.xyz * w3 + n4.xyz * w4) * 2.0 - 1.0;
  // 大尺度明暗 + 冷暖变化，打破平铺感
  alb *= 0.86 + 0.30 * nzA.r;
  alb = mix(alb, alb * vec3(1.10, 1.02, 0.86), (nzA.g - 0.5) * 0.9 * w0);
  // 烈日把草晒黄；雾霾吃掉颜色
  alb = mix(alb, alb * vec3(1.22, 1.08, 0.72), uWScorch * 0.5 * w0);
  alb = mix(alb, vec3(dot(alb, vec3(0.299, 0.587, 0.114))) * 1.05, uWFade * 0.4);
  // 水下：河床被水染色、压暗；水面波纹把阳光聚成一道道亮纹
  if (under > 0.001) {
    alb = mix(alb, alb * uWWaterTint * 1.6, under * 0.75);
    vec2 cu = vWPos.xz * 0.045;
    float c1 = texture2D(tWNoise, cu + vec2(uWTime * 0.021, uWTime * 0.013)).a, c2 = texture2D(tWNoise, cu * 1.7 - vec2(uWTime * 0.017, -uWTime * 0.019)).a;
    alb += vec3(0.20, 0.24, 0.22) * pow(1.0 - abs(c1 - c2), 12.0) * under * (1.0 - under * 0.6);
    rgh = mix(rgh, 0.5, under);
  }
  float dry = 1.0 - smoothstep(0.0, 0.25, under);
  // 湿：压暗、变光滑；岸边一圈常年是湿的
  float shore = (1.0 - smoothstep(0.2, 2.6, vWPos.y - uWLevel)) * vAux.w * dry;   // 只有河边才有常湿的岸
  float wetK = clamp(uWWet * (0.75 + 0.5 * nzB.a) + shore * 0.8, 0.0, 1.0) * dry;
  alb *= 1.0 - 0.38 * wetK * (1.0 - 0.5 * w2);
  rgh = mix(rgh, 0.28, wetK * 0.75);
  // 沙尘
  float sandK = clamp(uWSand * (0.45 + 0.9 * nzA.b) * smoothstep(0.3, 0.8, wn0.y), 0.0, 0.85) * dry;
  alb = mix(alb, uWSandCol * (0.85 + 0.3 * nzB.g), sandK);
  // 积雪：只落在朝上的面上，斑驳地盖；路面被踩过，薄一些。高处（雪线以上）常年有雪。
  float snowTex = texture2D(tWSnow, clamp(wRectUv(vWPos), 0.0, 1.0)).r * uWSnowOn;
  float snowAmt = max(uWSnow * 0.55, snowTex) * (1.0 - 0.45 * w1 - 0.3 * w4);
  snowAmt = max(snowAmt, smoothstep(uSnowLine.x, uSnowLine.x + uSnowLine.y, vWPos.y + (nzA.g - 0.5) * 90.0));
  float snowK = clamp(smoothstep(0.42, 0.86, wn0.y) * smoothstep(0.25, 0.75, snowAmt * 1.5 + (nzB.b + n0.a * 0.5 - 0.75) * 0.9), 0.0, 1.0) * dry;
  alb = mix(alb, uWSnowCol * (0.90 + 0.10 * nzB.r), snowK);
  rgh = mix(rgh, 0.62, snowK);
  tn = mix(tn, vec3(0.0, 0.0, 1.0), snowK * 0.7);
  diffuseColor.rgb *= alb * vAO;
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(roughness * rgh, 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', /* glsl */`
  tn.xy *= 1.35;
  // 把切线空间的扰动转到世界空间：地面大体朝上，用世界 x / z 当切线基；陡面由三向投影的主轴决定
  vec3 upT = abs(wn0.y) > 0.6 ? vec3(1.0, 0.0, 0.0) : (tw.x > tw.z ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0));
  vec3 tT = normalize(upT - wn0 * dot(upT, wn0)), tB = cross(wn0, tT);
  vec3 wn = normalize(tT * tn.x + tB * tn.y + wn0 * max(tn.z, 0.2));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
`)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directDiffuse += wLocalLight(vWPos) * diffuseColor.rgb;');
  };
  mat.customProgramCacheKey = () => 'world-terrain-1';
  mat.shadowSide = THREE.FrontSide;
  return mat;
}

/**
 * 建地形。返回 { group, material, dispose }。
 * @param field   buildTerrainField 的结果
 * @param theme   CONFIG.terrain.themes[*]
 * @param opts    { shadows, anisotropy }
 */
export function buildWorldTerrain(field, theme, opts = {}) {
  const { nx, ny, cell, W, H } = field;
  const O = CONFIG.terrain.outer;
  const tex = getWorldTextureSet(theme.layers, CONFIG.terrain.textureSize ?? 512, opts.anisotropy ?? 8);
  const mat = terrainMaterial(tex, theme, opts.shadows);
  const group = new THREE.Group(); group.name = 'worldTerrain';
  const splat = makeSplat(field, field.map);
  const geos = [];

  // ---------- 核心区 ----------
  const N = nx * ny, pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), spl = new Uint8Array(N * 4), aux = new Uint8Array(N * 4);
  const hAt = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? field.h[j * nx + i] : field.heightAt(i * cell, j * cell));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = i * cell, y = j * cell, hgt = field.h[k];
    const gx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell), gz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
    const l = Math.hypot(gx, 1, gz), nyv = 1 / l;
    pos[k * 3] = x; pos[k * 3 + 1] = hgt; pos[k * 3 + 2] = y;
    nrm[k * 3] = -gx / l; nrm[k * 3 + 1] = nyv; nrm[k * 3 + 2] = -gz / l;
    const s = splat(x, y, hgt, nyv, field.sd[k], field.lane[k], field.river[k], false);
    spl[k * 4] = s[0] * 255; spl[k * 4 + 1] = s[1] * 255; spl[k * 4 + 2] = s[2] * 255; spl[k * 4 + 3] = s[3] * 255;
    aux[k * 4] = s[4] * 255; aux[k * 4 + 1] = s[5] * 255; aux[k * 4 + 2] = s[6] * 255; aux[k * 4 + 3] = s[7] * 255;
  }
  for (let cj = 0; cj < ny - 1; cj += CHUNK) for (let ci = 0; ci < nx - 1; ci += CHUNK) {
    const i1 = Math.min(nx - 1, ci + CHUNK), j1 = Math.min(ny - 1, cj + CHUNK), cw = i1 - ci + 1, ch = j1 - cj + 1, M = cw * ch;
    const p = new Float32Array(M * 3), n = new Float32Array(M * 3), s = new Uint8Array(M * 4), a = new Uint8Array(M * 4);
    for (let j = 0; j < ch; j++) {
      const src = (cj + j) * nx + ci, dst = j * cw;
      p.set(pos.subarray(src * 3, (src + cw) * 3), dst * 3); n.set(nrm.subarray(src * 3, (src + cw) * 3), dst * 3);
      s.set(spl.subarray(src * 4, (src + cw) * 4), dst * 4); a.set(aux.subarray(src * 4, (src + cw) * 4), dst * 4);
    }
    const idx = new Uint32Array((cw - 1) * (ch - 1) * 6); let q = 0;
    for (let j = 0; j < ch - 1; j++) for (let i = 0; i < cw - 1; i++) {
      const v0 = j * cw + i, v1 = v0 + 1, v2 = v0 + cw, v3 = v2 + 1;
      idx[q++] = v0; idx[q++] = v2; idx[q++] = v1; idx[q++] = v1; idx[q++] = v2; idx[q++] = v3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(s, 4, true));
    geo.setAttribute('aAux', new THREE.BufferAttribute(a, 4, true));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = true; mesh.matrixAutoUpdate = false;
    group.add(mesh); geos.push(geo);
  }

  // ---------- 延伸世界 ----------
  {
    const ext = O.extent, ocx = W / Math.max(1, Math.round(W / O.cell)), ocy = H / Math.max(1, Math.round(H / O.cell));
    const ex = Math.ceil(ext / ocx), ey = Math.ceil(ext / ocy), cxn = Math.round(W / ocx), cyn = Math.round(H / ocy);
    const gx0 = -ex, gy0 = -ey, gnx = cxn + 2 * ex + 1, gny = cyn + 2 * ey + 1;
    const M = gnx * gny, p = new Float32Array(M * 3), n = new Float32Array(M * 3), s = new Uint8Array(M * 4), a = new Uint8Array(M * 4);
    const d = Math.min(ocx, ocy);
    for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) {
      const k = j * gnx + i, x = (gx0 + i) * ocx, y = (gy0 + j) * ocy;
      const inner = x > 0 && x < W && y > 0 && y < H;       // 压在核心区下面的那一圈（只为盖住接缝）
      const hgt = field.heightAt(x, y) - (inner ? 16 : 0);
      const gx = (field.heightAt(x + d, y) - field.heightAt(x - d, y)) / (2 * d), gz = (field.heightAt(x, y + d) - field.heightAt(x, y - d)) / (2 * d);
      const l = Math.hypot(gx, 1, gz);
      p[k * 3] = x; p[k * 3 + 1] = hgt; p[k * 3 + 2] = y;
      n[k * 3] = -gx / l; n[k * 3 + 1] = 1 / l; n[k * 3 + 2] = -gz / l;
      const sp = splat(x, y, hgt, 1 / l, 60, 1e6, field.riverAt(x, y), true);
      s[k * 4] = sp[0] * 255; s[k * 4 + 1] = sp[1] * 255; s[k * 4 + 2] = sp[2] * 255; s[k * 4 + 3] = sp[3] * 255;
      a[k * 4] = 0; a[k * 4 + 1] = sp[5] * 255; a[k * 4 + 2] = 255; a[k * 4 + 3] = sp[7] * 255;
    }
    // 16 块共用同一组顶点缓冲（只各有各的索引）
    const aP = new THREE.BufferAttribute(p, 3), aN = new THREE.BufferAttribute(n, 3), aS = new THREE.BufferAttribute(s, 4, true), aA = new THREE.BufferAttribute(a, 4, true);
    // 分成 4×4 大块；完全落在核心区里面的格子不要
    const SP = 4, bw = Math.ceil((gnx - 1) / SP), bh = Math.ceil((gny - 1) / SP);
    for (let bj = 0; bj < SP; bj++) for (let bi = 0; bi < SP; bi++) {
      const idx = [];
      for (let j = bj * bh; j < Math.min(gny - 1, (bj + 1) * bh); j++) for (let i = bi * bw; i < Math.min(gnx - 1, (bi + 1) * bw); i++) {
        const x0 = (gx0 + i) * ocx, y0 = (gy0 + j) * ocy;
        if (x0 >= ocx - 1e-3 && x0 + ocx <= W - ocx + 1e-3 && y0 >= ocy - 1e-3 && y0 + ocy <= H - ocy + 1e-3) continue;
        const v0 = j * gnx + i, v1 = v0 + 1, v2 = v0 + gnx, v3 = v2 + 1;
        idx.push(v0, v2, v1, v1, v2, v3);
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', aP); geo.setAttribute('normal', aN); geo.setAttribute('aSplat', aS); geo.setAttribute('aAux', aA);
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
      // 包围球只按这一块用到的顶点算（几何共享整张顶点表）
      const box = new THREE.Box3(), v = new THREE.Vector3();
      for (let t = 0; t < idx.length; t += 3) { v.set(p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]); box.expandByPoint(v); }
      geo.boundingBox = box; geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      geo.boundingSphere.radius += Math.hypot(ocx, ocy) * 2;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false;
      group.add(mesh); geos.push(geo);
    }
  }

  return {
    group, material: mat,
    dispose() { for (const g of geos) g.dispose(); mat.dispose(); },
  };
}
