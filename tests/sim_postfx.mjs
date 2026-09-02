// 渲染重构 Week2·Day8-10：轮廓描边 + SSAO 验收。
//
// docs/Q4-RENDERING-REDESIGN.md 第 8 节明确"渲染层没有、也不该有 sim_*.mjs 覆盖"——
// 那条针对的是【Three.js/WebGL 场景图本身】（画面对不对、深度/法线算得准不准这类
// 只有肉眼能判断的东西，headless Node 里没有真实 WebGL 上下文，测不出意义）。
// 但这次新增的不只是 shader：ThreeRenderer.js 的 setOutline/setSSAO 开关方法、
// SettingsDialog.js 的按钮 UI 与点击绑定，都是普通 JS/DOM，跟 setBloom/setFXAA
// 一样可以用源码正则钉住——钉的是"这层薄薄的开关/UI 胶水代码没有脱节"，不是
// "画面好不好看"，两者不冲突。PostFX.js 内部的 GLSL 数学本身仍然不测（同样测不出）。
import { srcOf, scoreboard } from './_harness.mjs';

const { T, done } = scoreboard('PostFX 验收');

const renderer = srcOf('src/presentation/ThreeRenderer.js');
const postfx = srcOf('src/presentation/PostFX.js');
const settings = srcOf('src/ui/SettingsDialog.js');

// ==================== ThreeRenderer 开关方法 ====================
T('渲①-ThreeRenderer 声明 outlineOn/ssaoOn 默认状态字段', /this\.outlineOn\s*=\s*true/.test(renderer) && /this\.ssaoOn\s*=\s*true/.test(renderer));
T('渲②-setOutline(on) 方法存在且写回 outlinePass.enabled', /setOutline\(on\)\s*\{[^}]*outlinePass[^}]*enabled[^}]*\}/.test(renderer));
T('渲③-setSSAO(on) 方法存在且写回 ssaoPass.enabled', /setSSAO\(on\)\s*\{[^}]*ssaoPass[^}]*enabled[^}]*\}/.test(renderer));
T('渲④-_buildComposer 里描边/SSAO 的 enabled 初值来自 outlineOn/ssaoOn（不是永远开）',
  /this\.ssaoPass\.enabled\s*=\s*this\.ssaoOn/.test(renderer) && /this\.outlinePass\.enabled\s*=\s*this\.outlineOn/.test(renderer));
T('渲⑤-法线+深度预渲染 Pass（NormalDepthPrepass）接进了 composer 的 pass 链',
  /this\.composer\.addPass\(this\.normalDepthPrepass\)/.test(renderer));
T('渲⑥-每帧渲染前会同步 SSAO 的相机 uniform（正交相机缩放会改变有效视锥，不同步就会算错）',
  /this\.ssaoPass\?\.\_syncCamera\?\.\(\)/.test(renderer));

// ==================== PostFX.js 导出面 ====================
T('模①-PostFX.js 导出 NormalDepthPrepass / createSSAOPass / createOutlinePass 三个接口',
  /export\s*\{\s*NormalDepthPrepass[^}]*\}/.test(postfx)
  && /export function createSSAOPass/.test(postfx)
  && /export function createOutlinePass/.test(postfx));
T('模②-NormalDepthPrepass 用 MeshNormalMaterial 编码视空间法线（SSAO/描边都要这个口径）',
  /new THREE\.MeshNormalMaterial\(\)/.test(postfx));
T('模③-NormalDepthPrepass 是"只产出纹理、不参与主色彩链"的旁路（needsSwap=false）',
  /this\.needsSwap\s*=\s*false/.test(postfx));
T('模④-正交相机的视空间坐标重建公式已经处理了 camera.zoom（不是直接拿 left/right/top/bottom）',
  /effectiveOrthoBounds/.test(postfx) && /2 \* camera\.zoom/.test(postfx));
T('模⑤-outline 的深度边缘阈值是"保守"档位（≥0.002），不是当初踩过坑的 0.0006（会把平地的深度量化噪声也测成一堆假边缘）',
  (() => {
    const m = postfx.match(/depthBias:\s*\{\s*value:\s*([\d.]+)\s*\}/);
    return !!m && parseFloat(m[1]) >= 0.002;
  })());

// ==================== SettingsDialog UI ====================
T('设①-画质面板有轮廓描边/SSAO 两个按钮', /id="setOutlineBtn"/.test(settings) && /id="setSsaoBtn"/.test(settings));
T('设②-两个按钮都接了 bindFx，读写的是 outlineOn/ssaoOn 和 setOutline/setSSAO（不是只有个摆设按钮）',
  /bindFx\('setOutlineBtn',\s*r => r\.outlineOn !== false,\s*\(r, v\) => r\.setOutline\(v\)/.test(settings)
  && /bindFx\('setSsaoBtn',\s*r => r\.ssaoOn !== false,\s*\(r, v\) => r\.setSSAO\(v\)/.test(settings));

done();
