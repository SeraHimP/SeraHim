/**
 * unitSurface.js —— 单位 / 建筑表面的材质语言：每个零件声明自己是什么材料（石 / 金属 / 金 / 布 / 木 / 皮……），
 * 合并几何时把"粗糙度、金属度、颗粒感、自发光"写进顶点属性 aMat，材质着色器按它出效果。
 *
 * 为什么要有这个：原来全场单位共用一个"粗糙度 1、金属度 0、不吃环境光"的材质，石头、盔甲、布看起来
 * 是同一种塑料（用户："我想要特别真实高清的画面而不是这种卡通的画面"）。现在同一个网格里
 * 金属会反射天空、石头有颗粒和细小凹凸、布是哑光的，仍然是一个网格一次绘制。
 *
 * 另外在这里接上局部光（火炬 / 水晶的光照图）：夜里站在火炬旁边的兵和塔会被照亮。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { patchWorldMaterial, worldUniforms } from './world/worldShading.js';

/** 材料 → [粗糙度, 金属度, 颗粒感, 自发光]。可在 CONFIG.ui.unitSurface.kinds 里覆写 / 增加。 */
const KINDS = {
  default: [0.85, 0.0, 0.5, 0],
  stone:   [0.93, 0.0, 1.0, 0],
  marble:  [0.55, 0.0, 0.45, 0],
  dark:    [0.8, 0.05, 0.8, 0],     // 玄武岩 / 黑曜石
  metal:   [0.42, 0.85, 0.2, 0],
  iron:    [0.62, 0.4, 0.5, 0],     // 生铁 / 黑铁：金属度压低，不然在暗处只反射出一片黑
  gold:    [0.32, 0.95, 0.12, 0],
  cloth:   [0.97, 0.0, 0.35, 0],
  leather: [0.72, 0.0, 0.45, 0],
  wood:    [0.86, 0.0, 0.85, 0],
  skin:    [0.65, 0.0, 0.15, 0],
  bone:    [0.6, 0.0, 0.4, 0],
  scale:   [0.5, 0.12, 0.6, 0],     // 龙鳞：有一点光泽
  glow:    [0.4, 0.0, 0.0, 1],      // 符文 / 能量槽 / 眼睛：按零件颜色自发光
};
export function surfaceParams(kind) {
  const over = CONFIG.ui?.unitSurface?.kinds;
  return (over && over[kind]) || KINDS[kind] || KINDS.default;
}
/** 给合并函数用：往 Float32Array 里写一个顶点的 aMat（4 个分量） */
export function writeSurface(arr, o, kind) {
  const p = surfaceParams(kind);
  arr[o] = p[0]; arr[o + 1] = p[1]; arr[o + 2] = p[2]; arr[o + 3] = p[3];
}

/**
 * 给单位材质（MeshStandardMaterial，顶点色）装上"按 aMat 出材质"的补丁 + 局部光。
 * 可叠在别的 onBeforeCompile 之后（动画注入）。
 */
export function patchUnitSurface(mat) {
  const S = () => CONFIG.ui?.unitSurface || {};
  const U = worldUniforms();
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  const uK = { value: new THREE.Vector4(S().grainAlbedo ?? 0.3, S().grainBump ?? 0.5, S().grainScale ?? 0.02, S().glowGain ?? 2.4) };
  mat.userData.uSurfK = uK;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uSurfK = uK; sh.uniforms.tWNoise = U.tWNoise;
    sh.vertexShader = 'attribute vec4 aMat; varying vec4 vUMat; varying vec3 vUPos;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', 'vUMat = aMat; vUPos = position;\n#include <begin_vertex>');
    sh.fragmentShader = 'varying vec4 vUMat; varying vec3 vUPos; uniform vec4 uSurfK;\n#ifndef WORLD_SHADING_HEAD\nuniform sampler2D tWNoise;\n#endif\nfloat uGrain;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
  {
    vec3 gp = vUPos * uSurfK.z;
    vec4 ga = texture2D(tWNoise, gp.xy), gb = texture2D(tWNoise, gp.yz + 0.37), gc = texture2D(tWNoise, gp.zx + 0.71);
    vec3 gw = abs(normalize(vNormal)); gw /= (gw.x + gw.y + gw.z);
    // 两个尺度：大块的色差（风化、水渍）+ 细颗粒
    uGrain = (ga.r * gw.z + gb.r * gw.x + gc.r * gw.y) * 0.55 + (ga.b * gw.z + gb.b * gw.x + gc.b * gw.y) * 0.45;
    diffuseColor.rgb *= 1.0 + (uGrain - 0.5) * uSurfK.x * 2.0 * vUMat.z;
  }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vUMat.x * (1.0 + (uGrain - 0.5) * 0.5 * vUMat.z), 0.06, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vUMat.y;')
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
  {
    // 颗粒的细小凹凸：用屏幕空间导数把高度差转成法线扰动（不需要切线）
    vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
    vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
    float det = dot(sx, r1);
    vec3 grad = sign(det) * (dFdx(uGrain) * r1 + dFdy(uGrain) * r2);
    // 面正好侧对着镜头时 det = 0、grad = 0，整个向量是零，归一化得 NaN（后处理把它置成黑点）：
    // 单位和建筑的轮廓边上会出现一小段一小段的细黑线。零向量时保持原法线
    vec3 pn = abs(det) * normal - grad * uSurfK.y * vUMat.z * 3.0;
    if (dot(pn, pn) > 1e-12) normal = normalize(pn);
  }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vUMat.w * uSurfK.w;');
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|surf2';
  patchWorldMaterial(mat, { wet: false, dust: false, sunLimit: true });
  mat.needsUpdate = true;
  return mat;
}
