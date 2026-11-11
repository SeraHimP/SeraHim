/**
 * worldShading.js —— 世界里所有受光材质共用的一组 uniform 和一段着色器补丁。
 *
 * 解决两件事：
 *  ① 局部光（火炬、水晶）：不用真的点光源。几十盏点光源意味着每个片元都要循环几十次，而且数量一变
 *     所有材质都要重编译。这里把静态光源烘成一张俯视的"光照图"（lightField.js），材质按世界坐标查一次，
 *     想放多少盏火炬都是同样的开销，拉远看全图时每一盏的光池也都在。
 *  ② 天气落到物体上：湿（压暗 + 变光滑）、沙尘（蒙一层沙色）。积雪只落在地面上（WorldTerrain 自己处理），
 *     不往树和建筑上刷白 —— 用户："下雪的时候，树和塔就变白，这个太丑了并且不符合实际"。
 *
 * 用法：patchWorldMaterial(material, { light, wet, dust })。地形有自己的完整着色器，只引用这里的 uniform 和 GLSL 片段。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { worldNoiseTexture } from './worldTextures.js';

const cfg = () => CONFIG.terrain?.shading || {};
let _blank = null;
function blankTex() {
  if (!_blank) { _blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); _blank.needsUpdate = true; }
  return _blank;
}

let _u = null;
/** 全场共享的 uniform 对象（材质引用同一组对象，改一次全部生效）。 */
export function worldUniforms() {
  if (_u) return _u;
  _u = {
    uWTime: { value: 0 },
    uWWet: { value: 0 }, uWSnow: { value: 0 }, uWSand: { value: 0 }, uWFade: { value: 0 }, uWScorch: { value: 0 },
    tWLight: { value: blankTex() },                       // 局部光照图（火炬 + 水晶），覆盖地图矩形
    uWRect: { value: new THREE.Vector4(0, 0, 1, 1) },     // 世界矩形：(x0, z0, 1/宽, 1/高)
    uWLightK: { value: 1 },                               // 局部光强度（夜里更显）
    tWNoise: { value: null },
    tWSnow: { value: blankTex() }, uWSnowOn: { value: 0 },   // 积雪深度图（GroundTraceLayer 的雪盖）
    uWLevel: { value: -1e4 },                             // 水面高度（没有水的地图给一个很低的值）
    uWWind: { value: new THREE.Vector3(1, 0.4, 0) },      // xy = 风向（世界 xz），z = 强度 0..1
    uWSandCol: { value: new THREE.Color('#d2ab6c') },
    uWSnowCol: { value: new THREE.Color('#eef3fa') },
    uWWaterTint: { value: new THREE.Color('#2f6f73') },
  };
  return _u;
}
function ensureNoise() { const u = worldUniforms(); if (!u.tWNoise.value) u.tWNoise.value = worldNoiseTexture(); return u; }

/**
 * 每帧更新。state = weatherGroundState()（各通道已做过平滑）；night 0..1。
 */
export function updateWorldShading(timeSec, state, night, wind) {
  const u = ensureNoise(), C = cfg();
  u.uWTime.value = timeSec;
  u.uWWet.value = state?.wet || 0; u.uWSnow.value = state?.frost || 0; u.uWSand.value = state?.sand || 0;
  u.uWFade.value = state?.fade || 0; u.uWScorch.value = state?.scorch || 0;
  // 火光白天也在烧，但日光下几乎看不出来；按夜色把它的份量提上去
  u.uWLightK.value = (C.lightDay ?? 0.3) + ((C.lightNight ?? 1.0) - (C.lightDay ?? 0.3)) * Math.max(0, Math.min(1, night || 0));
  if (wind) u.uWWind.value.set(wind.x, wind.y, wind.strength || 0);
}
export function setWorldRect(W, H) { worldUniforms().uWRect.value.set(0, 0, 1 / W, 1 / H); }
export function setWorldLightMap(tex) { worldUniforms().tWLight.value = tex || blankTex(); }
export function setWorldSnowMap(tex, on) { const u = worldUniforms(); u.tWSnow.value = tex || blankTex(); u.uWSnowOn.value = on && tex ? 1 : 0; }
export function setWorldWater(level, tint) { const u = worldUniforms(); u.uWLevel.value = level == null ? -1e4 : level; if (tint) u.uWWaterTint.value.set(tint); }
export function setWorldTints({ sand, snow } = {}) { const u = worldUniforms(); if (sand) u.uWSandCol.value.set(sand); if (snow) u.uWSnowCol.value.set(snow); }

/** uniform 声明 + 工具函数（片元）。 */
export const WORLD_FRAG_HEAD = /* glsl */`
#ifndef WORLD_SHADING_HEAD
#define WORLD_SHADING_HEAD
uniform float uWTime, uWWet, uWSnow, uWSand, uWFade, uWScorch, uWLightK, uWSnowOn, uWLevel;
uniform sampler2D tWLight, tWNoise, tWSnow;
uniform vec4 uWRect; uniform vec3 uWWind, uWSandCol, uWSnowCol, uWWaterTint;
varying vec3 vWPos;
vec2 wRectUv(vec3 p) { return (p.xz - uWRect.xy) * uWRect.zw; }
/** 局部光（火炬 / 水晶）：查光照图，火焰轻微摇曳。地图矩形之外没有光。 */
vec3 wLocalLight(vec3 p) {
  vec2 uv = wRectUv(p);
  vec3 l = texture2D(tWLight, clamp(uv, 0.0, 1.0)).rgb;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float fl = 0.9 + 0.1 * sin(uWTime * 9.0 + p.x * 0.07 + p.z * 0.05) * sin(uWTime * 5.3 + p.z * 0.09);
  return l * l * (uWLightK * fl * inside);
}
#endif
`;
export const WORLD_VERT_HEAD = /* glsl */`
#ifndef WORLD_SHADING_VHEAD
#define WORLD_SHADING_VHEAD
varying vec3 vWPos;
#endif
`;
/** 顶点里算世界坐标（放在 project_vertex 之前：此时 transformed 已经是最终的局部坐标）。 */
export const WORLD_VERT_POS = /* glsl */`
  {
    vec4 wPosW = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      wPosW = instanceMatrix * wPosW;
    #endif
    vWPos = (modelMatrix * wPosW).xyz;
  }
`;

/**
 * 给一个 three 内置受光材质（Standard / Lambert / Phong）打补丁。
 * opts.light  接局部光（默认 true）
 * opts.wet    下雨时压暗、变光滑（默认 true；只有 Standard 材质有粗糙度）
 * opts.dust   沙暴时蒙沙（默认 true）
 * 可与别的 onBeforeCompile 补丁叠加（先调用已有的，再追加）。
 */
export function patchWorldMaterial(material, opts = {}) {
  const light = opts.light !== false, wet = opts.wet !== false, dust = opts.dust !== false;
  const U = ensureNoise();
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  const tag = `|world:${light ? 'l' : ''}${wet ? 'w' : ''}${dust ? 'd' : ''}`;
  material.onBeforeCompile = (sh, renderer) => {
    if (prev) prev.call(material, sh, renderer);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = WORLD_VERT_HEAD + sh.vertexShader.replace('#include <project_vertex>', WORLD_VERT_POS + '#include <project_vertex>');
    let fs = WORLD_FRAG_HEAD + sh.fragmentShader;
    let color = '';
    if (wet) color += 'diffuseColor.rgb *= 1.0 - 0.28 * uWWet;\n';
    if (dust) color += '{ float du = uWSand * (0.35 + 0.4 * texture2D(tWNoise, vWPos.xz * 0.004).g); diffuseColor.rgb = mix(diffuseColor.rgb, uWSandCol * 0.8, clamp(du, 0.0, 0.7)); }\n';
    if (color) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + color);
    if (wet && fs.includes('#include <roughnessmap_fragment>')) fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.35), uWWet);');
    if (light) fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directDiffuse += wLocalLight(vWPos) * diffuseColor.rgb;');
    sh.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + tag;
  material.needsUpdate = true;
  return material;
}
