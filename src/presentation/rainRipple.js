/**
 * rainRipple.js —— 雨点涟漪（着色器版），水洼和河道水面共用同一段代码、同一组 uniform。
 *
 * 用户（2026-09-28）："水洼中的雨滴特效应该同步到水面中"。水洼里的雨点涟漪是着色器按世界坐标
 * 逐格生成的（每格一个随机位置/相位的扩散小环，密度随雨量）。两者都调这里：同一个时间、同一个雨量、
 * 同样的格子——水洼和河面上的雨点是一回事。河面原来那池二十几个大波纹环（RainRippleLayer）
 * 已按用户要求删除（"把原先在水面上存在的简陋波纹特效删除"）。
 *
 * 雨量 = 天气地表的"湿"通道（weatherGround.js，已按天气充能平滑）；参数在 CONFIG.ui.rainRipple。
 */
import { CONFIG } from '../data/Config.js';

const cfg = () => CONFIG.ui?.rainRipple || {};

export const rippleUniforms = {
  uRrTime: { value: 0 }, uRrRain: { value: 0 },
  uRrCell: { value: 9 }, uRrSpeed: { value: 0.8 },
};

/** 每帧调一次：墙钟秒 + 雨量（0..1） */
export function updateRainRipple(timeSec, rain) {
  const C = cfg();
  rippleUniforms.uRrTime.value = timeSec;
  rippleUniforms.uRrRain.value = C.enabled === false ? 0 : Math.max(0, Math.min(1, rain || 0));
  rippleUniforms.uRrCell.value = C.cell ?? 9;
  rippleUniforms.uRrSpeed.value = C.speed ?? 0.8;
}

/** 片元里用：rrRing(worldXZ) → 0..1 的环亮度（没下雨时恒 0） */
export const RIPPLE_GLSL = /* glsl */`
uniform float uRrTime, uRrRain, uRrCell, uRrSpeed;
float rrRing(vec2 wp) {
  if (uRrRain < 0.01) return 0.0;
  vec2 q = wp / uRrCell, id = floor(q), f = fract(q) - 0.5;
  float h = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
  vec2 off = vec2(fract(h * 17.0), fract(h * 31.0)) - 0.5;
  float t = fract(uRrTime * (uRrSpeed + h * 0.6) + h);
  float dd = length(f - off * 0.4);
  return (1.0 - smoothstep(0.0, 0.07, abs(dd - t * 0.42))) * (1.0 - t) * step(h, uRrRain);
}
`;

/**
 * 给水面材质接上雨点涟漪（Lambert/Basic 均可，已有 onBeforeCompile 的先跑原来的）。
 * 环叠加在漫反射色上，亮度 = strength × 材质本色（夜里跟着水面一起暗）。
 */
export function applyRainRipple(material, strength) {
  if (!material || material.userData.rrPatched) return material;
  material.userData.rrPatched = true;
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, rippleUniforms, { uRrStrength: { value: strength ?? cfg().waterStrength ?? 0.9 } });
    shader.vertexShader = 'varying vec3 vRrPos;\n' + shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vRrPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'uniform float uRrStrength;\nvarying vec3 vRrPos;\n' + RIPPLE_GLSL
      + shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n  diffuseColor.rgb += rrRing(vRrPos.xz) * uRrStrength * diffuse;');
  };
  material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|rr1';
  material.needsUpdate = true;
  return material;
}
