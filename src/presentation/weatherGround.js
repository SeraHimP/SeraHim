/**
 * weatherGround.js —— 天气落到地面上：地表随当前天气变色/变质感。
 *
 * 用户（2026-09-27）："天气可视化不同天气对应的地图路径我觉得也应该改下，因为你看上面的黄沙天气，
 * 但是地面依旧是绿色的，看起来很怪，就是天气层和地图是完全割裂的，需要做到天气和地图是融为一体的。"
 * 原来天气只画在空中（雨丝、雪花、雾/沙尘后处理），地面贴图是开图时烘好的一张静态画布，天气怎么变它都不动。
 *
 * 做法：给地面材质（地形、高地顶面、地图外围裙边）注入同一段片元代码，读一组全场共享的 uniform：
 *   sand   沙暴/蜃景 —— 按世界坐标的噪声一片片盖上沙色，沿风向拉长成沙纹；充能越高盖得越满
 *   wet    雨类      —— 地面整体压暗、饱和度略升、偏冷（湿土/湿草），低洼处（噪声低谷）更湿
 *   frost  雪类      —— 整体偏冷、去饱和，并撒一层细碎白霜；真正的积雪厚度仍由 GroundTraceLayer 雪盖负责
 *   fade   雾/霾     —— 去饱和、提一点灰，地面"被雾吃掉颜色"
 *   scorch 烈日      —— 草色发黄、偏暖偏干
 * 各项取对应天气充能的最大值（映射表在 CONFIG.ui.weatherGround.sources，可改），
 * 再按 response 秒做一阶平滑，强制切天气时地面不会"啪"地一下变色。
 * 噪声用体积雾那张共享贴图（fogNoise.js），同一片地在雾里和地上的纹理出自同一张图。
 *
 * 地图原有的明暗布局（路亮、野区暗、阵营圈）保留：各项都是在原色基础上按亮度调制，不是整片刷成一种颜色。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { fogNoiseTexture } from './fogNoise.js';

const cfg = () => (CONFIG.ui && CONFIG.ui.weatherGround) || {};

let _u = null;
/** 全场共享的 uniform（所有地面材质引用同一组对象，改一次全部生效） */
export function weatherGroundUniforms() {
  if (_u) return _u;
  const C = cfg();
  _u = {
    uWgNoise: { value: null },
    uWgSand: { value: 0 }, uWgWet: { value: 0 }, uWgFrost: { value: 0 }, uWgFade: { value: 0 }, uWgScorch: { value: 0 },
    uWgSandCol: { value: new THREE.Color(C.sandColor ?? '#d2ab6c') },
    uWgFrostCol: { value: new THREE.Color(C.frostColor ?? '#eef4fa') },
    uWgWind: { value: new THREE.Vector2(1, 0.35) },
    uWgScale: { value: C.noiseScale ?? 0.0016 },
    uWgK: { value: new THREE.Vector4(C.sandMax ?? 0.88, C.wetDarken ?? 0.32, C.frostMix ?? 0.5, C.fadeDesat ?? 0.45) },
    uWgK2: { value: new THREE.Vector4(C.scorchMix ?? 0.55, C.wetSat ?? 0.25, C.frostSpeck ?? 0.35, C.sandRipple ?? 0.1) },
    // 世界尺寸 + 河道遮罩（沙不铺进河里）+ 积雪深度图（GroundTraceLayer 的雪盖贴图，给高出地面的台面用）
    uWgWorld: { value: new THREE.Vector2(1, 1) },
    uWgRiver: { value: null },
    uWgSnowTex: { value: null }, uWgSnowOn: { value: 0 },
    uWgDust: { value: C.vegDust ?? 0.35 },
    uWgSideSnow: { value: C.sideSnow ?? 0.25 },   // 立面（墙身、柱身）的积雪比例，顶面为 1   // 植被（树冠/灌木/岩石）在沙暴里蒙一层沙的比例
  };
  _u.uWgRiver.value = _blankTex();
  _u.uWgSnowTex.value = _blankTex();
  return _u;
}

let _blank = null;
function _blankTex() {
  if (!_blank) { _blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); _blank.needsUpdate = true; }
  return _blank;
}

let _riverTex = null, _riverMapId = null;
/**
 * 换图时调：记下世界尺寸，按 MapSystem.riverFactor 烘一张低分辨率河道遮罩
 * （沙暴/烈日不往水面下的河床上铺，否则半透明水面底下一片黄沙，河就读不出来了）。
 */
export function setWeatherGroundMap(mapSystem) {
  const u = weatherGroundUniforms();
  const map = mapSystem?.currentMap;
  if (!map?.world) return;
  u.uWgWorld.value.set(map.world.w, map.world.h);
  if (_riverMapId === map.id) return;
  _riverMapId = map.id;
  if (_riverTex) { _riverTex.dispose(); _riverTex = null; }
  u.uWgRiver.value = _blankTex();
  if (typeof mapSystem.riverFactor !== 'function') return;
  const R = cfg().riverMaskRes ?? 128;
  const nx = R, ny = Math.max(8, Math.round(R * map.world.h / map.world.w));
  const data = new Uint8Array(nx * ny * 4);
  let any = false;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = Math.max(0, Math.min(1, mapSystem.riverFactor((i + 0.5) / nx * map.world.w, (j + 0.5) / ny * map.world.h) || 0));
    if (v > 0) any = true;
    data[(j * nx + i) * 4] = Math.round(v * 255);
  }
  if (!any) return;
  _riverTex = new THREE.DataTexture(data, nx, ny);   // DataTexture 不翻 Y：第 j 行 = 世界 y 的第 j 段
  _riverTex.magFilter = THREE.LinearFilter; _riverTex.minFilter = THREE.LinearFilter;
  _riverTex.needsUpdate = true;
  u.uWgRiver.value = _riverTex;
}

/** GroundTraceLayer 建好雪盖贴图后登记进来（它的 CanvasTexture 是 flipY 的，着色器里按此取 v） */
export function setWeatherGroundSnow(tex, on) {
  const u = weatherGroundUniforms();
  u.uWgSnowTex.value = tex || _blankTex();
  u.uWgSnowOn.value = tex && on ? 1 : 0;
}

/**
 * 把各天气充能折算成五个地表通道（纯函数，便于测试）。
 * @param {(id:string)=>number} charge 取某天气充能（0..1）
 * @param {object} sources  { sand: {sandstorm:1, mirage:0.5}, ... }
 */
export function groundTargets(charge, sources = cfg().sources || DEFAULT_SOURCES) {
  const out = {};
  for (const ch of CHANNELS) {
    let v = 0;
    const m = sources[ch] || {};
    for (const id in m) v = Math.max(v, Math.max(0, Math.min(1, charge(id) || 0)) * m[id]);
    out[ch] = Math.min(1, v);
  }
  return out;
}

export const CHANNELS = ['sand', 'wet', 'frost', 'fade', 'scorch'];
export const DEFAULT_SOURCES = {
  sand: { sandstorm: 1, mirage: 0.45 },
  wet: { rain: 1, downpour: 1, thunderstorm: 1, flood: 1, freezing_rain: 0.8, sunshower: 0.6 },
  frost: { snow: 1, blizzard: 1, whiteout: 1, snowblind: 1, freezing_rain: 0.6 },
  fade: { fog: 1, haze_surge: 1, densefog: 1 },
  scorch: { scorch: 1 },
};

const _cur = { sand: 0, wet: 0, frost: 0, fade: 0, scorch: 0 };
/**
 * 每帧调一次（墙钟 dt——暂停时天气画面照常过渡，同 WeatherLayer 口径）。
 * weather 为空或天气可视化关闭时，各通道平滑回 0。
 */
export function updateWeatherGround(weather, dt, windDir = null) {
  const u = weatherGroundUniforms();
  const C = cfg();
  const on = C.enabled !== false && !!weather && weather.enabled !== false;
  const tgt = on && weather.getCharge ? groundTargets((id) => weather.getCharge(id)) : null;
  const a = 1 - Math.exp(-Math.max(0, dt) / Math.max(0.01, C.response ?? 1.5));
  for (const ch of CHANNELS) {
    const t = tgt ? tgt[ch] : 0;
    _cur[ch] += (t - _cur[ch]) * a;
    if (Math.abs(_cur[ch] - t) < 1e-4) _cur[ch] = t;
  }
  u.uWgSand.value = _cur.sand; u.uWgWet.value = _cur.wet; u.uWgFrost.value = _cur.frost;
  u.uWgFade.value = _cur.fade; u.uWgScorch.value = _cur.scorch;
  if (windDir) u.uWgWind.value.set(windDir.x, windDir.y);
  return _cur;
}

/** 当前（平滑后）的地表通道值，只读 */
export function weatherGroundState() { return { ..._cur }; }

const GLSL_HEAD = /* glsl */`
uniform sampler2D uWgNoise;
uniform float uWgSand, uWgWet, uWgFrost, uWgFade, uWgScorch, uWgScale;
uniform vec3 uWgSandCol, uWgFrostCol;
uniform vec2 uWgWind;
uniform vec4 uWgK, uWgK2;
uniform vec2 uWgWorld;
uniform sampler2D uWgRiver, uWgSnowTex;
uniform float uWgSnowOn, uWgDust, uWgSideSnow;
varying vec3 vWgPos;
varying float vWgNy;
vec3 wgApply(vec3 c) {
#ifdef WG_DUST
  // 植被：沙暴里蒙一层沙（不铺沙纹、不做积雪——树上的雪另有 VegetationShaderPatch 负责）
  if (uWgSand > 0.001) c = mix(c, uWgSandCol * (0.55 + 0.6 * dot(c, vec3(0.299, 0.587, 0.114))), uWgSand * uWgDust);
  return c;
#endif
  if (uWgSand + uWgWet + uWgFrost + uWgFade + uWgScorch + uWgSnowOn < 0.002) return c;
  vec2 p = vWgPos.xz * uWgScale;
  vec4 n = texture2D(uWgNoise, p);
  vec2 wuv = vWgPos.xz / uWgWorld;
  float river = texture2D(uWgRiver, wuv).r;
#ifdef WG_SNOW
  float land = 1.0;   // 台面高出水面，河道遮罩不管它
#else
  float land = 1.0 - smoothstep(0.05, 0.4, river);
#endif
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // 烈日：草色发黄、偏暖偏干
  if (uWgScorch > 0.001) {
    vec3 dry = vec3(lum) * vec3(1.18, 1.02, 0.66) + 0.03;
    c = mix(c, dry, uWgScorch * uWgK2.x * land);
  }
  // 雨：压暗、饱和略升、偏冷；低洼处（噪声低谷）更湿
  if (uWgWet > 0.001) {
    float pool = 1.0 - smoothstep(0.30, 0.62, n.r);
    float w = uWgWet * (0.65 + 0.55 * pool);
    float l2 = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l2), c, 1.0 + uWgK2.y * w);
    c *= 1.0 - uWgK.y * w;
    c *= mix(vec3(1.0), vec3(0.92, 0.97, 1.06), w);
  }
  // 雪：偏冷去饱和 + 细碎白霜（积雪厚度另由雪盖层负责）
  if (uWgFrost > 0.001) {
    float l2 = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 cold = vec3(l2) * vec3(0.94, 1.0, 1.1) * 1.12 + 0.04;
    c = mix(c, cold, uWgFrost * uWgK.z);
    float speck = smoothstep(0.52, 0.72, n.b + (n.r - 0.5) * 0.6);
    c = mix(c, uWgFrostCol, speck * uWgFrost * uWgK2.z);
  }
  // 沙暴：一片片沙色盖上来，沿风向拉长成沙纹；充能越高盖得越满，原有明暗按亮度保留一部分
  if (uWgSand > 0.001) {
    vec2 wd = normalize(uWgWind + vec2(1e-4));
    vec2 q = vec2(dot(vWgPos.xz, wd), dot(vWgPos.xz, vec2(-wd.y, wd.x)));
    float drift = texture2D(uWgNoise, vec2(q.x * uWgScale * 0.35, q.y * uWgScale * 2.2)).g;
    float cover = smoothstep(1.02 - uWgSand * 1.25, 1.18 - uWgSand * 1.25, drift * 0.55 + n.r * 0.6);
    float ripple = 0.5 + 0.5 * sin(q.x * 0.35 + drift * 4.0);   // 沙纹与风向垂直
    vec3 sand = uWgSandCol * (0.78 + 0.55 * lum + uWgK2.w * (ripple - 0.5) + (n.b - 0.5) * 0.18);
    c = mix(c, sand, cover * uWgK.x * land);
  }
#ifdef WG_SNOW
  // 高出地面的台面（台地顶、高地顶面）：地面雪盖是贴着 heightAt 的一张网格，盖不到它们，
  // 这里直接读同一张雪深贴图、用同一套噪声收边，雪量与周围地面一致
  if (uWgSnowOn > 0.5) {
    float d = texture2D(uWgSnowTex, vec2(wuv.x, 1.0 - wuv.y)).a;
    float nn = clamp((n.r - 0.5) * 2.6 + 0.5, 0.0, 1.0);
    float s = d * (0.25 + 1.5 * nn);
    float cov = smoothstep(0.05, 0.13, s) * clamp(d * 2.2, 0.0, 1.0);
    // 朝上的面积满雪，立面只挂一层薄霜（墙头、柱顶白，墙身仍看得出石头）
    cov *= mix(uWgSideSnow, 1.0, smoothstep(0.35, 0.8, vWgNy));
    vec3 snowC = mix(vec3(0.85, 0.9, 0.98), vec3(1.0), smoothstep(0.08, 0.45, d)) * (0.94 + 0.1 * n.b);
    c = mix(c, snowC, cov);
  }
#endif
  // 雾/霾：去饱和、提一点灰
  if (uWgFade > 0.001) {
    float l2 = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l2) * 1.04 + 0.03, uWgFade * uWgK.w);
  }
  return c;
}
`;

/**
 * 给地面材质接上天气地表（Lambert/Basic 都可；已有 onBeforeCompile 的会先跑原来的）。
 * 同一材质重复调用无副作用。opts.snow：高出地面雪盖的表面（台面），自己读雪深图画雪；
 * opts.dust：植被，只在沙暴里蒙一层沙。
 */
export function applyWeatherGround(material, opts = {}) {
  if (!material || material.userData.wgPatched) return material;
  material.userData.wgPatched = true;
  const u = weatherGroundUniforms();
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    if (!u.uWgNoise.value) u.uWgNoise.value = fogNoiseTexture();
    Object.assign(shader.uniforms, u);
    // 世界坐标与世界法线的 y（朝上的面才积雪）；实例化网格要先乘 instanceMatrix
    shader.vertexShader = 'varying vec3 vWgPos;\nvarying float vWgNy;\n' + shader.vertexShader.replace('#include <project_vertex>',
      `#include <project_vertex>
  vec4 wgP = vec4(transformed, 1.0);
  vec3 wgN = normal;
#ifdef USE_INSTANCING
  wgP = instanceMatrix * wgP;
  wgN = mat3(instanceMatrix) * wgN;
#endif
  vWgPos = (modelMatrix * wgP).xyz;
  vWgNy = normalize(mat3(modelMatrix) * wgN).y;`);
    shader.fragmentShader = (opts.snow ? '#define WG_SNOW\n' : '') + (opts.dust ? '#define WG_DUST\n' : '') + GLSL_HEAD + shader.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb = wgApply(diffuseColor.rgb);');
    // ⚠️ 挂在 color_fragment（顶点色相乘）之后，不是 map_fragment 之后：顶点色材质（基地石墙、城墙柱、
    // 风格化树）在 map 之后还要乘一次顶点色，挂早了白雪 × 石头色 = 石头色，积雪/蒙沙等于没做
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + (opts.snow ? '|wg1s' : opts.dust ? '|wg1d' : '|wg1');
  material.needsUpdate = true;
  return material;
}
