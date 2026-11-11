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
import * as THREE from '../vendor/three.module.js';
import { ThreeRenderer } from '../src/presentation/ThreeRenderer.js';
import { CONFIG } from '../src/data/Config.js';

const { T, done } = scoreboard('PostFX 验收');

const renderer = srcOf('src/presentation/ThreeRenderer.js');
const postfx = srcOf('src/presentation/PostFX.js');
const settings = srcOf('src/ui/SettingsDialog.js');

// ==================== ThreeRenderer 开关方法 ====================
// v51.28：outline 有画面 bug，默认值改成了 false（禁用），bug 修好前不该被这条断言逼着改回 true。
// 2026-09-05：描边那个"画面 bug"已查实真根因并修复（雨/雪/尘/雾被法线深度预渲染
// 当成不透明物体 → 满屏黑麻点，见 PostFX.js 里 FX_PARTICLE_LAYER 的头注），
// 所以这条断言从"默认关"翻过来钉"默认开、且默认值走 CONFIG 软编码"。
// 2026-11 画面重构：轮廓描边随卡通风格一起删除（写实画面没有描边）。
T('渲①-描边已删除：渲染器里没有 outlinePass / outlineOn，CONFIG 里没有 outline 块',
  !/outlinePass/.test(renderer) && !/this\.outlineOn/.test(renderer) && CONFIG.outline === undefined
  && /this\.ssaoOn\s*=\s*true/.test(renderer));
T('渲①b-SSAO 的观感参数（半径/容差/曲线/强度/半分辨率）全部从 CONFIG.postfx.ssao 取',
  (() => {
    const c = CONFIG.postfx?.ssao || {};
    return typeof c.radius === 'number' && typeof c.bias === 'number' && typeof c.strength === 'number'
      && /const c = CONFIG\.postfx\?\.ssao \|\| \{\};/.test(postfx);
  })());
T('渲②-setOutline 保留为空操作（旧存档调它不炸），不再写任何 pass', /setOutline\(\) \{ return false; \}/.test(renderer));
T('渲③-setSSAO(on) 方法存在且写回 ssaoPass.enabled', /setSSAO\(on\)\s*\{[^}]*ssaoPass[^}]*enabled[^}]*\}/.test(renderer));
T('渲④-_buildComposer 里 SSAO 的 enabled 初值来自 ssaoOn（不是永远开）',
  /this\.ssaoPass\.enabled\s*=\s*this\.ssaoOn/.test(renderer));
T('渲⑤-ScenePass（MSAA + 深度贴图）是 composer 的第一个 pass，没有单独的法线深度预渲染',
  /this\.composer\.addPass\(this\.scenePass\)/.test(renderer) && !/normalDepthPrepass|NormalDepthPrepass|RenderPass\(/.test(renderer)
  && renderer.indexOf('this.composer.addPass(this.scenePass)') < renderer.indexOf('this.composer.addPass(this.ssaoPass)'));
T('渲⑥-每帧渲染前会同步 SSAO 的相机 uniform（透视相机的投影矩阵随缩放变，不同步就会算错）',
  /this\.ssaoPass\?\.\_syncCamera\?\.\(\)/.test(renderer));

// ==================== PostFX.js 导出面 ====================
T('模①-PostFX.js 导出 ScenePass / createSSAOPass / createFogPass（描边、预渲染接口已删）',
  /export\s*\{\s*ScenePass\s*\}/.test(postfx) && !/NormalDepthPrepass/.test(postfx)
  && /export function createSSAOPass/.test(postfx)
  && /export function createFogPass/.test(postfx)
  && !/createOutlinePass/.test(postfx));
T('模②-SSAO 的法线由深度差分重建（取深度差更小的一侧，跨物体边缘不翻）',
  /normalize\(cross\(ddx, ddy\)\)/.test(postfx) && /abs\(pr\.z\) < abs\(pl\.z\)/.test(postfx) && !/tNormal/.test(postfx));
T('模③-抗锯齿用 MSAA（渲染目标 samples），没有 FXAA',
  /samples,\s*\n?\s*depthTexture: new THREE\.DepthTexture/.test(postfx) && !/FXAA/.test(renderer.replace(/setFXAA[^\n]*\n/g, '').replace(/\/\/[^\n]*|\*[^\n]*/g, '')));
T('模④-视空间坐标重建走投影逆矩阵（透视 / 正交通用），不再按正交视锥的 left/right 线性插值',
  /projectionMatrixInverse \* clip/.test(postfx) && !/effectiveOrthoBounds/.test(postfx));
T('模⑤-SSAO 半分辨率算遮蔽 + 深度感知模糊后再乘回画面（不是全分辨率裸采样）',
  /class SSAOPass extends Pass/.test(postfx) && /abs\(d1 - d0\) < 0\.002/.test(postfx) && /aoStrength/.test(postfx));

// ==================== SettingsDialog UI ====================
T('设①-画质面板有 SSAO 按钮、没有描边按钮', !/id="setOutlineBtn"/.test(settings) && /id="setSsaoBtn"/.test(settings));
T('设②-SSAO 按钮接了 bindFx，读写的是 ssaoOn 和 setSSAO（不是只有个摆设按钮）',
  /bindFx\('setSsaoBtn',\s*r => r\.ssaoOn !== false,\s*\(r, v\) => r\.setSSAO\(v\)/.test(settings));

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


// ==================== v54：割裂感整改（A1 描边 / A2 太阳压低 / A4 接地暗斑）====================
// 诊断见 docs/MAP-DESIGN-howling-abyss-frost.md 第 10 节。
// 这三条都是**很容易被下一个人顺手关掉**的开关，所以逐条钉住。
{
  const q = CONFIG.ui.qualityPresets;
  // v51.28 因为描边有 bug 把三档全关了；bug 已在 f83a3c1 修好（透明物体不进法线深度预渲染），
  // 这里把 medium/high 开回来。描边是"把 3D 单位和 2D 地面缝在一起"最强的一招。
  T('缝①-画质档位表里没有描边项（描边已删）、SSAO 只在高档开',
    !('outline' in q.medium) && q.high.ssao === true && q.low.ssao === false);

  const L = CONFIG.ui.lighting;
  T(`缝②-太阳仰角上限 ${L.maxSunElevDeg}° 不到正头顶（透视相机下影子仍要有长度才能把物体钉在地上）`,
    L.maxSunElevDeg <= 70);

  const gcfg = CONFIG.ui.groundContact;
  T('缝③-接地暗斑已软编码且默认开启', gcfg && gcfg.enabled === true
    && typeof gcfg.radiusK === 'number' && typeof gcfg.opacity === 'number');

  const ul = srcOf('src/presentation/UnitLayer.js');
  // 暗斑必须用**不带 walkBob 的地面高度**。跟着走路起伏一起上下跳的"影子"会立刻穿帮。
  T('缝④-接地暗斑贴在地面高度上，不跟随走路起伏（跟着跳就穿帮了）',
    /this\._pushContact\(e\.pos\.x, CONTACT_LIFT \+ gy, e\.pos\.y, cr\)/.test(ul));
  // 它是"影子"，必须压在射程圈/归属环之下。
  T('缝⑤-暗斑的渲染次序压在贴地环之下',
    /const ORDER_CONTACT = (\d+);/.test(ul)
    && Number(ul.match(/const ORDER_CONTACT = (\d+);/)[1]) < 5);
  T('缝⑥-幽灵单位不画暗斑（预览摆放的塔不该在地上留影子）',
    /gc\.enabled !== false && !ghost/.test(ul));
}

// ==================== 任务 #178：伪体积雾 ====================
{
  const fogSrc = postfx.slice(postfx.indexOf('const FogShader'));
  T('雾①-PostFX.js 导出 createFogPass', /export function createFogPass/.test(postfx));
  T('雾②-噪声用重建出的【世界坐标 XZ】采样，不是屏幕 UV（否则雾团会贴着镜头滑）',
    /worldPos\.xz \* noiseScale/.test(fogSrc)
    // v54：蜃景 Signature 新增了一路用 vUv 采样 tNoise 的屏幕空间"UV 位移"（有意如此，
    // 做热浪扭曲用，跟雾浓度本身的世界空间噪声是两码事）——钉住"浓度噪声"那一路
    // 仍然只用 worldPos.xz，不能钉"整个 fogSrc 里完全不出现 vUv 采样 tNoise"。
    && !/float n1 = texture2D\(tNoise,\s*vUv/.test(fogSrc));
  T('雾③-世界坐标由 viewMatrixInverse（camera.matrixWorld）把重建出的视空间坐标转回去',
    /viewMatrixInverse \* vec4\(viewPos, 1\.0\)/.test(postfx)
    && /pass\.uniforms\.viewMatrixInverse\.value\.copy\(camera\.matrixWorld\)/.test(postfx));
  T('雾④-高度雾：随世界 Y 指数衰减；深度衰减：随视空间距离指数吸收（Beer-Lambert）',
    /exp\(-h \* heightFalloff\)/.test(postfx) && /exp\(-dist \* density\)/.test(postfx));
  T('雾⑤-读 ScenePass 主渲染的深度贴图，没有另开一个预渲染 Pass',
    /pass\.uniforms\.tDepth\.value = scenePass\.depthTexture/.test(postfx.slice(postfx.indexOf('createFogPass'))));
  T('雾⑥-fogStrength<=0 时整个 pass 直通原图（关掉/无雾时零视觉影响）',
    /if \(fogStrength <= 0\.0001\) \{ gl_FragColor = base; return; \}/.test(postfx));
  T('雾⑦-setStrength(v) 把 0..1 的充能映射到 maxStrength 软上限（可再乘浓雾 Signature 的临时倍数），不是直接写 1',
    /pass\.setStrength = \(v\) => \{ pass\.uniforms\.fogStrength\.value = Math\.max\(0, Math\.min\(1, v \|\| 0\)\) \* maxStrength \* extraStrengthMul; \}/.test(postfx));

  T('渲⑦-ThreeRenderer 的 fogOn 默认值走 CONFIG.volumetricFog.enabled（不硬编码）',
    /this\.fogOn = CONFIG\.volumetricFog\?\.enabled !== false/.test(renderer));
  T('渲⑧-setFog(on) 方法存在且写回 fogPass.enabled', /setFog\(on\)\s*\{[^}]*fogPass[^}]*enabled[^}]*\}/.test(renderer));
  T('渲⑨-_buildComposer 里雾的 enabled 初值来自 fogOn（不是永远开）',
    /this\.fogPass\.enabled\s*=\s*this\.fogOn/.test(renderer));
  T('渲⑩-雾接进了 composer 的 pass 链，且在 SSAO 之后、Bloom 之前',
    (() => {
      const iSsao = renderer.indexOf('this.composer.addPass(this.ssaoPass)');
      const iFog = renderer.indexOf('this.composer.addPass(this.fogPass)');
      const iBloom = renderer.indexOf('this.composer.addPass(this.bloomPass)');
      return iSsao > 0 && iFog > iSsao && iBloom > iFog;
    })());
  T('渲⑪-每帧雾强度读 ws.getCharge(\'fog\')（与风吹植被 windCharge 同一口径：强度取充能不取占比；v54 沙暴 Signature 借用同一通道时取两者较大值驱动）',
    /const fogCharge = ws\?\.getCharge \? \(ws\.getCharge\('fog'\) \|\| 0\) : 0;/.test(renderer)
    && /this\.fogPass\.setStrength\(Math\.max\(fogCharge, sandstormCharge\)\)/.test(renderer));
  T('渲⑫-画质分档 setQualityPreset 里雾也被一起切换（不是漏掉的新开关）',
    /this\.setFog\(p\.fog\)/.test(renderer));

  T('置②-CONFIG.volumetricFog 定义了观感参数（颜色/高度衰减/密度/噪声/强度上限）全部软编码',
    (() => {
      const c = CONFIG.volumetricFog;
      return !!c && typeof c.color === 'string' && typeof c.heightFalloff === 'number'
        && typeof c.density === 'number' && typeof c.noiseScale === 'number'
        && typeof c.noiseStrength === 'number' && typeof c.maxStrength === 'number'
        && c.maxStrength > 0 && c.maxStrength <= 1;
    })());
  T('置③-画质分档里雾跟描边同一档位分布：低档关、中/高档开',
    (() => {
      const q = CONFIG.ui.qualityPresets;
      return q.low.fog === false && q.medium.fog === true && q.high.fog === true;
    })());

  // ==================== v54 第二轮重做 §9.3/§9.8：雾-风联动 + Signature 挂钩 ====================
  T('雾⑧-噪声流速随风充能提速（_advanceNoise 接收第二个参数 windCharge，windBoostFactor 软编码）',
    /pass\._advanceNoise = \(dt, windCharge = 0\) => \{/.test(postfx)
    && /const speed = noiseSpeed \* \(1 \+ Math\.max\(0, Math\.min\(1, windCharge\)\) \* windBoostFactor\)/.test(postfx)
    && typeof CONFIG.volumetricFog.windBoostFactor === 'number');
  T('雾⑨-PostFX 暴露蜃景/霾潮/浓雾/沙暴四条 Signature 的专用 setter',
    /pass\.setUvWobble = /.test(postfx) && /pass\.setNoiseStretch = /.test(postfx)
    && /pass\.setMaxStrengthMul = /.test(postfx) && /pass\.setColor = /.test(postfx));
  T('渲⑬-ThreeRenderer 每帧把雾-风联动 + 四条 Signature 的充能接进 fogPass',
    /this\.fogPass\._advanceNoise\?\.\(this\._lightDt \|\| 0\.016, windCharge\)/.test(renderer)
    && /this\.fogPass\.setUvWobble\?\.\(exCharge\('mirage'\)/.test(renderer)
    // 2026-09-27：沙暴也走这条拉伸（一股股沙带），写法变成 max(霾潮, 沙暴)，意图不变
    && /this\.fogPass\.setNoiseStretch\?\.\(1 \+ Math\.max\(exCharge\('haze_surge'\)/.test(renderer)
    && /this\.fogPass\.setMaxStrengthMul\?\.\(1 \+ exCharge\('densefog'\)/.test(renderer));
  T('渲⑭-雷暴 Signature：_updateLightning 方法存在，充能过低时清空计时器（不是常驻挂着的空闪）',
    /_updateLightning\(dt\)\s*\{/.test(renderer)
    && /if \(!cfg \|\| cfg\.enabled === false \|\| thunderCharge <= 0\.05\)/.test(renderer));
  T('置④-CONFIG.ui.thunderFlash 软编码闪光节奏参数', (() => {
    const c = CONFIG.ui?.thunderFlash;
    return !!c && typeof c.minGapSec === 'number' && typeof c.maxGapSec === 'number'
      && typeof c.peakAlpha === 'number' && typeof c.fadeSec === 'number';
  })());

  T('设⑤-画质面板有体积雾按钮', /id="setFogBtn"/.test(settings));
  T('设⑥-体积雾按钮接了 bindFx，读写的是 fogOn 和 setFog',
    /bindFx\('setFogBtn',\s*r => r\.fogOn !== false,\s*\(r, v\) => r\.setFog\(v\)/.test(settings));
}

// ==================== ScenePass：MSAA 采样数 / 开关 / 尺寸（直接实例化跑）====================
// 用户反馈"画面看起来有些模糊"：根因是 FXAA 把贴图细节一起抹掉（实测关掉后清晰度指标翻倍），
// 换成 MSAA 场景 Pass。这里钉行为：采样数随像素比与开关变化、尺寸同步、深度贴图可供 SSAO / 雾读取。
{
  const { ScenePass } = await import('../src/presentation/PostFX.js');
  const sp = new ScenePass(new THREE.Scene(), new THREE.PerspectiveCamera(), 640, 360, 4);
  T('场①-ScenePass 的颜色目标是多重采样的，且带深度贴图', sp.rt.samples === 4 && !!sp.depthTexture && sp.depthTexture === sp.rt.depthTexture);
  sp.setSamples(0);
  T('场②-setSamples(0) 关掉多重采样（抗锯齿开关）', sp.samples === 0 && sp.rt.samples === 0);
  sp.setSize(800, 450);
  T('场③-setSize 同步颜色目标与深度贴图的尺寸', sp.rt.width === 800 && sp.rt.height === 450 && sp.depthTexture.image.width === 800);

  const aa = ThreeRenderer.prototype._aaSamples;
  const fake = (on, pr, max) => ({ aaOn: on, gl: { getPixelRatio: () => pr, capabilities: { maxSamples: max } } });
  const A = CONFIG.postfx.aa;
  T('场④-普通屏用 CONFIG.postfx.aa.samples', aa.call(fake(true, 1, 16)) === A.samples);
  T('场⑤-高分屏（像素比 ≥ hiDpiRatio）用更少的采样数', aa.call(fake(true, A.hiDpiRatio, 16)) === A.samplesHiDpi && A.samplesHiDpi < A.samples);
  T('场⑥-抗锯齿关掉时采样数为 0', aa.call(fake(false, 1, 16)) === 0);
  T('场⑦-不超过显卡支持的最大采样数', aa.call(fake(true, 1, 2)) === 2);
  T('场⑧-setFXAA 保留为 setAA 的别名（旧存档和画质面板还在调它）', /setFXAA\(on\) \{ return this\.setAA\(on\); \}/.test(renderer));
  T('场⑨-_sizeComposer 把渲染器的像素比同步给 composer（分辨率缩放后后处理链不被拉伸）',
    /this\.composer\.setPixelRatio\(this\.gl\.getPixelRatio\(\)\)/.test(renderer));
}

// ==================== 大气透视（自动线性雾）：摘 _autoFog 原型方法直接跑 ====================
// 原在 sim_mapskirt（地图裙边已随旧地形层删除，见 2026-11 画面重构），挪到这里。
{
  // 2026-11 画面重构：透视相机下，大气透视按【机位距离】给（近处清晰、远处融进天光），不再按地图对角线。
  const autoFog = ThreeRenderer.prototype._autoFog;
  const mkFake = (camDist, fogColor) => ({ scene: new THREE.Scene(), _camDist: camDist, _fogColor: fogColor });
  const F = CONFIG.ui.mapFog;

  const near = mkFake(1000);
  autoFog.call(near);
  T('会起雾（线性雾）', !!near.scene.fog && near.scene.fog.isFog === true);

  const far = mkFake(4000);
  autoFog.call(far);
  T('机位越远，雾的起止距离越远（拉远看全图时地图本身不能被雾吃掉）',
    far.scene.fog.near > near.scene.fog.near && far.scene.fog.far > near.scene.fog.far);
  T('起止距离 = 机位距离 × nearK / farK（两个系数在 CONFIG.ui.mapFog）',
    Math.abs(near.scene.fog.near - 1000 * F.nearK) < 1e-6 && Math.abs(near.scene.fog.far - 1000 * F.farK) < 1e-6);
  T('雾从机位到注视点的距离之外才开始（注视点附近是清晰的）', F.nearK >= 1 && F.farK > F.nearK);

  const noDist = mkFake(undefined);
  autoFog.call(noDist);
  T('还没同步过机位时不报错，用默认距离兜底', !!noDist.scene.fog);

  const colored = mkFake(1000, '#112233');
  autoFog.call(colored);
  T('雾色取自 setLighting 传下来的地平线色（昼夜/天气怎么染色，雾跟着染）',
    colored.scene.fog.color.getHexString() === '112233');

  const orig = CONFIG.ui.mapFog.enabled;
  CONFIG.ui.mapFog.enabled = false;
  const off = mkFake(1000);
  autoFog.call(off);
  T('mapFog.enabled=false 时不设雾', off.scene.fog === null);
  CONFIG.ui.mapFog.enabled = orig;
}

T('雾-render 每帧调用 _autoFog（机位距离一变雾就跟着变）', /this\._autoFog\(\);/.test(srcOf('src/presentation/ThreeRenderer.js')));

// ==================== 显卡出问题时别静默黑屏 ====================
// 用户在自己机器上黑屏、控制台每帧刷"glGetProgramiv: Program object expected"（上下文丢失后还在用旧着色器编号）；
// 开发环境是软件渲染，复现不了。所以：丢失时停渲染 + 弹诊断框，并提供网址开关让用户在自己机器上二分。
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  const mainSrc = srcOf('src/main.js');
  T('诊①-监听 webglcontextlost 并 preventDefault（浏览器才会尝试恢复上下文）',
    /addEventListener\('webglcontextlost', \(e\) => \{\s*e\.preventDefault\(\);\s*diag\.lost = true;/.test(tr));
  T('诊②-上下文丢了就不再渲染（不再每帧调 GL 刷错）', /render\(controller\) \{[\s\S]{0,120}if \(this\.gpuDiag\?\.lost\) return;/.test(tr));
  T('诊③-恢复后自动刷新，但同一会话只刷一次（防止循环刷新）', /webglcontextrestored[\s\S]{0,300}sessionStorage[\s\S]{0,200}if \(n < 1\) location\.reload\(\);/.test(tr));
  T('诊④-着色器编译失败时记下驱动给的日志（debug.onShaderError），并照常打到控制台',
    /this\.gl\.debug\.onShaderError = /.test(tr) && /getShaderInfoLog\(fs\)/.test(tr) && /console\.error\('THREE\.WebGLProgram: Shader Error'/.test(tr));
  T('诊⑤-网址开关：aa / post / shadow / ssao / fog / bloom / world / res 都接上了，且只在写了时生效',
    ['aa', 'post', 'shadow', 'ssao', 'fog', 'bloom', 'world'].every((k) => new RegExp("off\\('" + k + "'\\)").test(mainSrc))
    && /q\.get\(k\) === '0'/.test(mainSrc) && /parseFloat\(q\.get\('res'\)\)/.test(mainSrc) && /applyDebugSwitches\(renderer3d\);/.test(mainSrc));
  T('诊⑥-?world=0 真的能跳过新地形（_rebuildTerrain 认 world.disabled，并关掉加载界面）', /this\.world\.disabled\) \{ this\.world\.dispose\(\); this\._finishLoading\(\); return; \}/.test(tr));
}

// ==================== 黑块闪烁 / 抗锯齿自动降级 / 可复现 ====================
// 用户："移动画面的时候，偶发黑色大块闪（大概占屏幕的 1/9）"，关掉后处理就没有。
// 实测水面正对太阳时场景缓冲里的高光到了 500~700，半精度再碰巧溢出成无穷大 / NaN，泛光把它糊成大块黑。
{
  const pfx = srcOf('src/presentation/PostFX.js'), tr = srcOf('src/presentation/ThreeRenderer.js'), mainSrc = srcOf('src/main.js');
  T('闪①-场景拷出时清掉 NaN、把值夹在 [0, sceneMax]（进泛光前）',
    /any\(isnan\(c\.rgb\)\) \? vec3\(0\.0\) : clamp\(c\.rgb, 0\.0, uMax\)/.test(pfx) && /uMax: \{ value: CONFIG\.postfx\?\.sceneMax/.test(pfx));
  T('闪②-上限软编码，而且远高于正常画面的亮度（对正常像素是空操作）', typeof CONFIG.postfx.sceneMax === 'number' && CONFIG.postfx.sceneMax >= 16);
  T('复①-SSAO 的采样核与噪声图用固定种子（不再每次刷新都随机，截图对比可复现）',
    /seededRandom\(1013\)/.test(pfx) && /seededRandom\(2027\)/.test(pfx) && !/=\s*Math\.random\(\)|\(Math\.random\(\)/.test(pfx));
  T('降①-开着多重采样时丢了上下文，记下"下次自动关抗锯齿"', /aaWasOn[\s\S]{0,120}localStorage\.setItem\('seraAAFallback', '1'\)/.test(tr));
  T('降②-下次加载读到记录就关抗锯齿；?aa=1 强制再开并清掉记录',
    /localStorage\.getItem\('seraAAFallback'\) === '1'/.test(mainSrc) && /q\.get\('aa'\) === '1'\) localStorage\.removeItem\('seraAAFallback'\)/.test(mainSrc)
    && /if \(off\('aa'\) \|\| aaFallback\) r\.setAA\(false\);/.test(mainSrc));
}

// ==================== 进图加载界面（分帧建图）====================
// 用户："进地图需要卡一会"。建图拆成若干步、每帧一步，期间显示加载界面、暂停仿真，最后异步编译着色器再揭开。
{
  const tr = srcOf('src/presentation/ThreeRenderer.js'), mainSrc = srcOf('src/main.js'), wd = srcOf('src/presentation/world/World.js');
  T('载①-加载中 render 只推进一步建图、不画场景', /if \(this\._loading && this\._stepLoading\(\)\) return;/.test(tr));
  T('载②-开始加载的那一帧先只显示界面（否则界面要等第一步卡完才出来）', /if \(!L\.shown\) \{ L\.shown = true; return true; \}/.test(tr));
  T('载③-最后用 compileAsync 预编译着色器，并有超时兜底（超时时长软编码）',
    /this\.gl\.compileAsync\(this\.scene, this\.camera\)/.test(tr) && /CONFIG\.ui\?\.loading\?\.compileTimeoutMs/.test(tr) && typeof CONFIG.ui.loading.compileTimeoutMs === 'number');
  T('载④-加载中仿真暂停（兵不会在加载界面后面先走出去）', /if \(!CTX\.gamePaused && !renderer3d\?\.isLoading\?\.\(\)\)/.test(mainSrc));
  T('载⑤-只有换图才弹加载界面（地图编辑器笔刷改位图仍是同步重建）', /'map:loaded', \(\) => \{ this\._terrainDirty = true; this\._loadingUI = true;/.test(tr)
    && /if \(!withUI\) \{ this\.world\.build\(ms, opts\);/.test(tr));
  T('载⑥-"这张图已建好"要等全部步骤做完（建到一半再触发一次换图不会把半成品当成品）',
    /builtFor\(map\) \{ return !!this\.field && this\._map === map && this\._complete === true; \}/.test(wd) && /this\._complete = !!field;/.test(wd));
  const { World } = await import('../src/presentation/world/World.js');
  const steps = new World(new THREE.Scene()).buildSteps({ currentMap: null, terrainField: () => null });
  T('载⑦-一次性建图与分帧建图走同一份步骤（高度场 → 地表 → 岩壁 → 水 → 树）',
    steps.map((x) => x.label).join('/') === '计算地形高度场/生成地表/堆砌岩壁/注水/种树' && /for \(const st of this\.buildSteps\(ms, opts\)\) st\.run\(\);/.test(wd));
}

done();
