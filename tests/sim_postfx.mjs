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
import { ThreeRenderer } from '../src/presentation/ThreeRenderer.js';
import { CONFIG } from '../src/data/Config.js';

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

// ==================== Week3·Day13-14：移动端分辨率自适应 + 画质分档 ====================
T('设③-画质面板按 low/medium/high/auto 四档渲染按钮（含每档的中文标签）',
  /\['low', 'medium', 'high', 'auto'\]/.test(settings)
  && /data-quality="\$\{k\}"/.test(settings)
  && /low: '🔋 低', medium: '⚖️ 中', high: '💎 高', auto: '🤖 自动'/.test(settings));
T('设④-档位按钮接了点击绑定，调用 setQualityPreset', /r\.setQualityPreset\(btn\.dataset\.quality\)/.test(settings));

T('置①-CONFIG.ui.qualityPresets 定义了低/中/高三档，且分辨率随档位递增（低最省，高最清晰）',
  (() => {
    const P = CONFIG.ui?.qualityPresets;
    return !!P && P.low && P.medium && P.high
      && P.low.resolutionScale < P.medium.resolutionScale
      && P.medium.resolutionScale <= P.high.resolutionScale;
  })());

// _autoAdjustQuality 是纯 JS 状态机（不摸 WebGL），可以直接从 prototype 摘出来，
// 绑一个假的 this 单测——不需要真的 new 一个 ThreeRenderer（那需要真实 WebGL 上下文，
// 在 headless Node 里创建不出来，ThreeRenderer.create() 在这种环境下就是设计成返回 null 的）。
{
  const adjust = ThreeRenderer.prototype._autoAdjustQuality;
  const T_ = CONFIG.ui.qualityPresets;
  const mkFake = (tier) => ({
    qualityAuto: true, _autoTier: tier, _autoDownStreak: 0, _autoUpStreak: 0,
    _applied: [],
    setQualityPreset(preset) { this._applied.push(preset === 'auto' ? this._autoTier : preset); return preset; },
  });

  // 非自动模式：不管帧时多差都不该动档位（用户手动选的档，不该被偷偷改掉）。
  const offR = mkFake('medium'); offR.qualityAuto = false;
  adjust.call(offR, 999);
  T('自①-qualityAuto=false 时 _autoAdjustQuality 完全不生效（不偷改用户手动选的档）',
    offR._autoTier === 'medium' && offR._applied.length === 0);

  // 单次超预算：还没攒够连续次数，不该立刻降档（迟滞——抄的是天气主导迟滞那套教训）。
  const r1 = mkFake('medium');
  adjust.call(r1, T_.autoDownMs + 1);
  T('自②-单次超帧时预算不会立刻降档（需要连续 autoDownTicks 次才降，防抖动）',
    r1._autoTier === 'medium' && r1._applied.length === 0);

  // 连续 autoDownTicks 次超预算：应该真的降一档（medium → low），且降档后 streak 清零。
  const r2 = mkFake('medium');
  for (let i = 0; i < T_.autoDownTicks; i++) adjust.call(r2, T_.autoDownMs + 1);
  T('自③-连续 autoDownTicks 次超预算后从中档降到低档', r2._autoTier === 'low' && r2._applied.includes('low'));
  T('自④-降档后连续超预算计数清零（不会累加到下一档接着触发）', r2._autoDownStreak === 0);

  // 已经在最低档：继续超预算也不能再往下降（没有比 low 更低的档）。
  const r3 = mkFake('low');
  for (let i = 0; i < T_.autoDownTicks * 2; i++) adjust.call(r3, T_.autoDownMs + 1);
  T('自⑤-已经是最低档时不会继续降档（没有更低的档可去）', r3._autoTier === 'low');

  // 连续 autoUpTicks 次帧时很宽裕：应该升一档（medium → high）。
  const r4 = mkFake('medium');
  for (let i = 0; i < T_.autoUpTicks; i++) adjust.call(r4, T_.autoUpMs - 1);
  T('自⑥-连续 autoUpTicks 次帧时远低于预算后从中档升到高档', r4._autoTier === 'high' && r4._applied.includes('high'));

  // 已经在最高档：继续宽裕也不能再往上升。
  const r5 = mkFake('high');
  for (let i = 0; i < T_.autoUpTicks * 2; i++) adjust.call(r5, T_.autoUpMs - 1);
  T('自⑦-已经是最高档时不会继续升档（没有更高的档可去）', r5._autoTier === 'high');

  // 帧时落在 up/down 两条阈值之间（既不算超预算也不算宽裕）：应该清零两个计数器，
  // 不能让"之前攒的 3 次超预算"和"这次不算数的正常帧"混在一起继续累加。
  const r6 = mkFake('medium');
  adjust.call(r6, T_.autoDownMs + 1); // streak 攒到 1
  adjust.call(r6, (T_.autoDownMs + T_.autoUpMs) / 2); // 中间值，应该清零
  T('自⑧-帧时回落到阈值中间地带时会清零连续计数（不是"曾经攒过就一直算数"）',
    r6._autoDownStreak === 0 && r6._autoUpStreak === 0 && r6._applied.length === 0);
}

done();
