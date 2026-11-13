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
    uWLightStep: { value: new THREE.Vector2(1 / 512, 1 / 512) },   // 估光源方向时往旁边偏多远取样（光照图 uv）
    uWLightY: { value: new THREE.Vector2(-1e5, -1e5 - 1) },        // 局部光只照到这个高度：x 以上全亮，往下到 y 淡没（桥上的火炬照不到桥墩脚下）
    uWUnitSun: { value: 1 },                              // 单位 / 建筑吃多少直射光（太阳压得很低时收一些，见 setWorldUnitSun）
    uWLightDir: { value: new THREE.Vector3(0.14, 0.6, 0.3) },      // x = 相对亮度梯度多大算"斜着照"，y = 光源有多高（越大越像从头顶照），z = 背光面保留多少
    uWDay: { value: 1 },                                  // 白天程度 1 = 正午，0 = 午夜（不受光的东西按它压暗：深渊里的雾、水雾）
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
  u.uWDay.value = 1 - Math.max(0, Math.min(1, night || 0));
  if (wind) u.uWWind.value.set(wind.x, wind.y, wind.strength || 0);
}
export function setWorldRect(W, H) { worldUniforms().uWRect.value.set(0, 0, 1 / W, 1 / H); }
export function setWorldLightMap(tex) {
  const u = worldUniforms(), C = cfg();
  u.tWLight.value = tex || blankTex();
  const n = tex?.image?.width || 512, k = C.lightDirStep ?? 2.5;
  u.uWLightStep.value.set(k / n, k / n);
  u.uWLightDir.value.set(C.lightDirGrad ?? 0.14, C.lightDirUp ?? 0.6, C.lightWrap ?? 0.3);
}
/** 局部光照到多低：top 以上全亮，往下到 bottom 淡没。不传 = 不限（没有深渊的图）。 */
export function setWorldLightFloor(top, bottom) { const v = worldUniforms().uWLightY.value; if (top == null) v.set(-1e5, -1e5 - 1); else v.set(top, bottom ?? top - 60); }
/** 单位 / 建筑吃几成直射光（1 = 全吃）。渲染器按太阳高度给：正午 1，黎明 / 黄昏收到 CONFIG.ui.unitLighting.lowSun.k。 */
export function setWorldUnitSun(k) { worldUniforms().uWUnitSun.value = Math.max(0, Math.min(1, k)); }
/** 太阳高度（度）→ 单位吃几成直射光。纯函数，便于测试。 */
export function unitSunOf(elevDeg) {
  const L = CONFIG.ui?.unitLighting?.lowSun || {};
  if (L.enabled === false) return 1;
  const [e0, e1] = L.elev || [10, 40], k = L.k ?? 0.5;
  const t = Math.max(0, Math.min(1, (elevDeg - e0) / Math.max(1e-6, e1 - e0)));
  return k + (1 - k) * t * t * (3 - 2 * t);
}
export function setWorldSnowMap(tex, on) { const u = worldUniforms(); u.tWSnow.value = tex || blankTex(); u.uWSnowOn.value = on && tex ? 1 : 0; }
export function setWorldWater(level, tint) { const u = worldUniforms(); u.uWLevel.value = level == null ? -1e4 : level; if (tint) u.uWWaterTint.value.set(tint); }
export function setWorldTints({ sand, snow } = {}) { const u = worldUniforms(); if (sand) u.uWSandCol.value.set(sand); if (snow) u.uWSnowCol.value.set(snow); }

/** uniform 声明 + 工具函数（片元）。 */
export const WORLD_FRAG_HEAD = /* glsl */`
#ifndef WORLD_SHADING_HEAD
#define WORLD_SHADING_HEAD
uniform float uWTime, uWWet, uWSnow, uWSand, uWFade, uWScorch, uWLightK, uWSnowOn, uWLevel, uWDay, uWUnitSun;
uniform sampler2D tWLight, tWNoise, tWSnow;
uniform vec4 uWRect; uniform vec3 uWWind, uWSandCol, uWSnowCol, uWWaterTint, uWLightDir; uniform vec2 uWLightStep, uWLightY;
varying vec3 vWPos;
vec2 wRectUv(vec3 p) { return (p.xz - uWRect.xy) * uWRect.zw; }
/** 局部光（火炬 / 水晶）：查光照图，火焰轻微摇曳。地图矩形之外没有光。 */
vec3 wLocalLight(vec3 p) {
  vec2 uv = wRectUv(p);
  vec3 l = texture2D(tWLight, clamp(uv, 0.0, 1.0)).rgb;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float fl = 0.9 + 0.1 * sin(uWTime * 9.0 + p.x * 0.07 + p.z * 0.05) * sin(uWTime * 5.3 + p.z * 0.09);
  return l * l * (uWLightK * fl * inside * smoothstep(uWLightY.y, uWLightY.x, p.y));
}
/**
 * 带方向的局部光：n = 世界空间法线。光照图只记了"这里有多亮"，光从哪边来由亮度的梯度估出来（往亮处走就是光源），
 * 于是朝着火炬的岩面是亮的、背着的是暗的，地面离火炬越远光越斜、越淡 —— 火炬是在"照"，不是给地面刷了一层颜色。
 */
vec3 wLocalLightN(vec3 p, vec3 n) {
  vec2 uv = wRectUv(p);
  vec2 cu = clamp(uv, 0.0, 1.0);
  vec3 l = texture2D(tWLight, cu).rgb;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float l0 = dot(l, vec3(0.3333));
  float lx = dot(texture2D(tWLight, clamp(cu + vec2(uWLightStep.x, 0.0), 0.0, 1.0)).rgb, vec3(0.3333));
  float lz = dot(texture2D(tWLight, clamp(cu + vec2(0.0, uWLightStep.y), 0.0, 1.0)).rgb, vec3(0.3333));
  vec2 g = vec2(lx - l0, lz - l0);
  float gl = length(g);
  // 斜的程度看"相对梯度"（梯度 / 亮度）：离光源越远它越大，光越斜。只看梯度本身的话，光池最外圈梯度趋近 0，
  // 会被当成"从头顶照下来"而比里面一圈还亮，路面上出现一道亮环。
  vec3 L = normalize(vec3(g.x, 0.0, g.y) / max(gl, 1e-5) * smoothstep(0.0, uWLightDir.x, gl / max(l0, 0.03)) + vec3(0.0, uWLightDir.y, 0.0));
  vec3 nn = dot(n, n) > 1e-8 ? normalize(n) : vec3(0.0, 1.0, 0.0);   // 零法线归一化是 NaN（后处理会把它置成黑点）
  float ndl = clamp(dot(nn, L) * (1.0 - uWLightDir.z) + uWLightDir.z, 0.0, 1.0);
  float fl = 0.9 + 0.1 * sin(uWTime * 9.0 + p.x * 0.07 + p.z * 0.05) * sin(uWTime * 5.3 + p.z * 0.09);
  return l * l * (uWLightK * fl * inside * ndl * smoothstep(uWLightY.y, uWLightY.x, p.y));
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
  const tag = `|world:${opts.sunLimit ? 's' : ''}${light ? (opts.lightDir === false ? 'l' : 'L') : ''}${wet ? 'w' + (opts.wetRough ?? '') : ''}${dust ? 'd' : ''}`;
  material.onBeforeCompile = (sh, renderer) => {
    if (prev) prev.call(material, sh, renderer);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = WORLD_VERT_HEAD + sh.vertexShader.replace('#include <project_vertex>', WORLD_VERT_POS + '#include <project_vertex>');
    let fs = WORLD_FRAG_HEAD + sh.fragmentShader;
    let color = '';
    if (wet) color += 'diffuseColor.rgb *= 1.0 - 0.28 * uWWet;\n';
    if (dust) color += '{ float du = uWSand * (0.35 + 0.4 * texture2D(tWNoise, vWPos.xz * 0.004).g); diffuseColor.rgb = mix(diffuseColor.rgb, uWSandCol * 0.8, clamp(du, 0.0, 0.7)); }\n';
    if (color) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + color);
    // wetRough：淋湿后最光滑到多少。叶片给高一点（0.7）——叶片卡片朝向杂乱，太光滑的话雨天满树都是一道道白色反光
    if (wet && fs.includes('#include <roughnessmap_fragment>')) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, min(roughnessFactor, ${(opts.wetRough ?? 0.35).toFixed(2)}), uWWet);`);
    // lightDir：按法线分明暗（默认）。叶片 / 草这类朝向杂乱的薄片给 false——它们整丛被照亮，不该一片亮一片黑
    // sunLimit：直射光乘 uWUnitSun（单位 / 建筑用）。太阳贴着地平线时，立面正对着太阳、地面几乎照不到，
    // 塔会比脚下的地亮好几倍，像是另一个世界搬来的（用户："塔特别亮的就矗立在地图中，显得特别违和"）
    if (opts.sunLimit) fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directDiffuse *= uWUnitSun; reflectedLight.directSpecular *= uWUnitSun;');
    if (light) fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directDiffuse += '
      + (opts.lightDir === false ? 'wLocalLight(vWPos)' : 'wLocalLightN(vWPos, (vec4(normal, 0.0) * viewMatrix).xyz)') + ' * diffuseColor.rgb;');
    sh.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + tag;
  material.needsUpdate = true;
  return material;
}

/**
 * 深渊里的雾：越往下越浓，到 bottom 处最浓（k）。桥墩、崖面、掉进峡谷的石头都按自己的高度融进雾里，看不见底。
 * 参数来自主题的 abyssFog = { top, bottom, k, color }；主题没有这一项时什么也不做。地形的着色器里有同一段（WorldTerrain）。
 * 要求材质已经有 vWPos（patchWorldMaterial 会加）。
 */
export function patchAbyssFog(material, theme) {
  const A = theme?.abyssFog;
  if (!A) return material;
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(material, sh, r);
    sh.uniforms.uAbyss = { value: new THREE.Vector3(A.top ?? -1e5, A.bottom ?? -2e5, A.k ?? 0) };
    sh.uniforms.uAbyssCol = { value: new THREE.Color(A.color ?? '#9fb4c8') };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAbyss, uAbyssCol;')
      .replace('#include <opaque_fragment>', `{
    float ak = smoothstep(uAbyss.x, uAbyss.y, vWPos.y + (texture2D(tWNoise, vWPos.xz * 0.0021 + uWTime * 0.004).r - 0.5) * 60.0) * uAbyss.z;
    outgoingLight = mix(outgoingLight, uAbyssCol * (0.16 + 0.84 * uWDay), ak);
  }
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|abyss';
  material.needsUpdate = true;
  return material;
}
