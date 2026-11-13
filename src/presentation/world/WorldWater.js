/**
 * WorldWater.js —— 河面。
 *
 * 网格只铺在"真的有水"的地方（地面低于水面的格子），每个顶点带水深，所以：
 *   · 浅处清澈见底、深处是水体的颜色，岸线由河床自己的形状决定，不是一块矩形水面切出来的；
 *   · 岸线是淡出去的（越浅越透），只有零星几缕泡沫；水面有顺着流向走的亮纹。
 * 水深来自地形高度场而不是屏幕深度图：稳定，也不需要为水单独渲染一遍深度。
 * 反射走天空环境贴图（PBR 材质自带菲涅尔 + 太阳高光），所以昼夜、天气变了水面自动跟着变。
 * 法线是两层沿流向滚动的波纹；下雨时叠雨点涟漪（rainRipple.js，和水洼是同一段代码）。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { waterNormalTexture } from './worldTextures.js';
import { worldUniforms, WORLD_FRAG_HEAD, WORLD_VERT_HEAD } from './worldShading.js';
import { RIPPLE_GLSL, rippleUniforms } from '../rainRipple.js';

export function buildWorldWater(field, theme) {
  const level = field.waterLevel, wc = theme.water;
  if (level == null || !wc) return null;
  const C = CONFIG.terrain.water || {};
  const step = C.cell ?? 12, reach = C.outerReach ?? 2200, margin = C.margin ?? 0.9;
  const x0 = -reach, y0 = -reach, gnx = Math.ceil((field.W + 2 * reach) / step) + 1, gny = Math.ceil((field.H + 2 * reach) / step) + 1;
  // 只在河道附近取高度（全图逐点取太慢）：河道强度 > 0 或离对角线不远才算
  const depth = new Float32Array(gnx * gny).fill(-1);
  const band = (field.map.heightZones?.riverHalfWidth ?? 200) * 1.3 + 220;
  for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) {
    const x = x0 + i * step, y = y0 + j * step;
    if (Math.abs(x - y) * Math.SQRT1_2 > band) continue;
    depth[j * gnx + i] = level - field.heightAt(x, y);
  }
  const idxOf = new Int32Array(gnx * gny).fill(-1), pos = [], aux = [], index = [];
  const vert = (i, j) => {
    const k = j * gnx + i;
    if (idxOf[k] >= 0) return idxOf[k];
    const x = x0 + i * step, y = y0 + j * step, d = depth[k];
    idxOf[k] = pos.length / 3; pos.push(x, level, y); aux.push(Math.max(-1, Math.min(14, d)));
    return idxOf[k];
  };
  for (let j = 0; j < gny - 1; j++) for (let i = 0; i < gnx - 1; i++) {
    const d0 = depth[j * gnx + i], d1 = depth[j * gnx + i + 1], d2 = depth[(j + 1) * gnx + i], d3 = depth[(j + 1) * gnx + i + 1];
    if (Math.max(d0, d1, d2, d3) < -margin + 0.9) continue;      // 四个角都在岸上
    if (Math.min(d0, d1, d2, d3) < -6) continue;                 // 贴着陡崖 / 没取过高度的格子
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    index.push(a, c, b, b, c, d);
  }
  if (!index.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(aux, 1));
  geo.setIndex(index);
  const nrm = new Float32Array(pos.length); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: C.roughness ?? 0.07, metalness: 0, transparent: true, depthWrite: false });
  const U = worldUniforms();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, rippleUniforms, {
      tWaterN: { value: waterNormalTexture() },
      uShallow: { value: new THREE.Color(wc.shallow) }, uDeep: { value: new THREE.Color(wc.deep) },
      uFoam: { value: new THREE.Color(wc.foam ?? '#e6f1f1') },
      uFlow: { value: new THREE.Vector2(Math.SQRT1_2, Math.SQRT1_2).multiplyScalar(C.flowSpeed ?? 9) },
      uWaterK: { value: new THREE.Vector4(C.clarity ?? 0.42, C.alphaMin ?? 0.06, C.alphaMax ?? 0.9, C.foamWidth ?? 0.7) },
      // x = 泡沫浓度，y = 水流亮纹的强度，z = 亮纹往下游走的速度，w = 岸线从多浅处开始淡出
      uWaterS: { value: new THREE.Vector4(C.foam ?? 0.3, C.streak ?? 0.5, C.streakSpeed ?? 0.03, C.shoreFade ?? 0.3) },
    });
    sh.vertexShader = WORLD_VERT_HEAD + 'attribute float aDepth; varying float vDepth;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vDepth = aDepth; vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = WORLD_FRAG_HEAD + RIPPLE_GLSL + /* glsl */`
uniform sampler2D tWaterN; uniform vec3 uShallow, uDeep, uFoam; uniform vec2 uFlow; uniform vec4 uWaterK, uWaterS;
varying float vDepth;
` + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
  if (vDepth < -0.35) discard;
  float wD = max(vDepth, 0.0);
  float dk = 1.0 - exp(-wD * uWaterK.x);
  vec2 fl = uFlow * uWTime;
  vec4 wn1 = texture2D(tWaterN, (vWPos.xz - fl) * 0.011), wn2 = texture2D(tWaterN, (vWPos.xz * 1.9 - fl * 1.6).yx * 0.011 + 0.37);
  vec4 wn3 = texture2D(tWaterN, (vWPos.xz - fl * 0.5) * 0.047);
  // 水在流：顺着流向拉长的亮纹慢慢往下游走。没有它，河面只是一块会反光的色片，看不出是河
  vec2 fdir = normalize(uFlow + 1e-5), fperp = vec2(-fdir.y, fdir.x);
  vec2 sp = vec2(dot(vWPos.xz, fdir), dot(vWPos.xz, fperp));
  float st1 = texture2D(tWNoise, vec2(sp.x * 0.0030 - uWTime * uWaterS.z, sp.y * 0.018)).r;
  float st2 = texture2D(tWNoise, vec2(sp.x * 0.0052 - uWTime * uWaterS.z * 1.7 + 0.4, sp.y * 0.034 + 0.2)).g;
  float streak = smoothstep(0.46, 0.9, st1 * 0.6 + st2 * 0.5) * smoothstep(0.3, 1.6, wD) * uWaterS.y;
  // 泡沫只剩贴着岸的零星几缕（被波纹打碎）。原来沿着两岸各有一整条白边，用户："两边那个白色的泡沫……完全不像河道"
  float foam = (1.0 - smoothstep(0.0, uWaterK.w, wD)) * smoothstep(0.6, 0.82, wn3.a * 0.6 + wn1.a * 0.4 + 0.12) * uWaterS.x;
  float ring = rrRing(vWPos.xz);
  vec3 body = mix(uShallow, uDeep, dk);
  diffuseColor.rgb = mix(body, uFoam, clamp(foam, 0.0, 1.0)) + (uShallow * 0.5 + 0.12) * streak * 0.35 + ring * 0.25;
  // 岸线：水越浅越透，一直淡到看不见，露出底下湿的河滩 —— 岸是河床自己的形状，不是一条画出来的边
  diffuseColor.a = clamp(mix(uWaterK.y, uWaterK.z, dk) + foam * 0.5 + streak * 0.08 + ring * 0.3, 0.0, 1.0) * smoothstep(-0.1, uWaterS.w, vDepth);
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.6, clamp(foam, 0.0, 1.0));')
      .replace('#include <normal_fragment_maps>', /* glsl */`
  vec3 wtn = (wn1.xyz * 2.0 - 1.0) + (wn2.xyz * 2.0 - 1.0) * 0.7 + (wn3.xyz * 2.0 - 1.0) * 0.35;
  wtn.xy *= 0.55 + 0.6 * uWWind.z; wtn.xy += vec2(dFdx(ring), dFdy(ring)) * 6.0;
  wtn.xy += fdir * (streak - 0.15) * 0.5;
  vec3 wwn = normalize(vec3(wtn.x, 2.2, wtn.y));
  normal = normalize((viewMatrix * vec4(wwn, 0.0)).xyz);
`)
      // 反射（高光 + 天空）不该被"水很清"的透明度吃掉：按反射亮度把不透明度补回来
      .replace('#include <opaque_fragment>', /* glsl */`
  float wSpec = dot(reflectedLight.directSpecular + reflectedLight.indirectSpecular, vec3(0.3333));
  diffuseColor.a = clamp(diffuseColor.a + wSpec * 1.4, 0.0, 1.0);
  outgoingLight += wLocalLight(vWPos) * diffuseColor.rgb * 0.6;
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'world-water-3';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true; mesh.renderOrder = 2; mesh.matrixAutoUpdate = false; mesh.name = 'worldWater';
  const group = new THREE.Group(); group.add(mesh);
  return { group, mesh, dispose() { geo.dispose(); mat.dispose(); } };
}
