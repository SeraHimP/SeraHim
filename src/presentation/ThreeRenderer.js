/**
 * ThreeRenderer.js —— 2.5D 渲染层（迁移第 1、2 步）
 *
 * 第1步：空场景 + 正交摄像机，与现有 Canvas 渲染并存（F9 切换，非叠加）。
 * 第2步：地面贴图（复用 TerrainLayer 的离屏画布）+ 摄像机与 CanvasController 的映射桥。
 *
 * 逻辑层零改动：本文件只读实体/地图数据，不写任何实体字段。
 *
 * ============ 关于"俯角"这个词：一次性说清楚，避免继续混用 ============
 * 迁移计划 v1 和之前的问答里，"pitch/俯角"被当成了两个相反的量用：
 *   - 讨论压缩系数时说"sin(pitch)，45°→0.71、LOL≈56°→0.83" → 这是【从地平面起算的仰角】
 *   - 讨论对位验证时说"pitch=0 即纯俯视"                    → 这是【从垂直向下起算的偏离角】
 * 两者互补（相加 90°）。本文件统一采用【仰角】口径，并把常量改名为
 * CAM_ELEVATION_DEG 以杜绝歧义：
 *   90° = 摄像机正上方垂直向下 = 纯俯视 = 与 2D 视图逐像素重合（对位验证用这个值）
 *   45° = 默认交付值
 *   56° ≈ LOL 实际视角
 * 地面纵向压缩系数 = sin(仰角)：90°→1.00、56°→0.83、45°→0.71。
 * 纯 pitch，零 yaw：地图不旋转，蓝方仍在左下，与 2D 视图同朝向。
 *
 * 【调试脚手架，第5步随 Canvas 一起删】
 *   CTX.__setElevation(deg)  控制台实时调仰角（在 45~60 之间滑一下取手感）
 *   CTX.__checkProjection()  见 ProjectionCheck.js
 */
import * as THREE from '../../vendor/three.module.js';
import { UnitLayer } from './UnitLayer.js';
import { WeatherLayer } from './WeatherLayer.js';
import { CorrosionLayer } from './CorrosionLayer.js';
import { GroundTraceLayer } from './GroundTraceLayer.js';
import { updateWeatherGround, setWeatherGroundMap, weatherGroundState } from './weatherGround.js';
import { World } from './world/World.js';
import { LoadingScreen } from '../ui/LoadingScreen.js';
import { updateRainRipple } from './rainRipple.js';
import { CONFIG } from '../data/Config.js';
import { resolveDayPhase } from './DayNight.js';
import { buildingSize, minionSize } from './UnitInfo.js';

// ===== 第 6.1 步：光照基座 =====
// 量纲推导（three r169，已核对 vendor 内的着色器源码）：
//   BRDF_Lambert = 漫反射色 / π，环境/半球辐照度不额外乘 π（物理量纲模式）。
//   => 出射 = 漫反射色 × 辐照度 / π
//   地面是平面，法线恒为 +Y，辐照度 = 半球光(天空色) + 平行光 × sin(太阳仰角)。
//   令其精确等于 π，地面外观与"无光照 MeshBasic"时代【逐像素相同】。
//   这正是本步的验收标准：光照铺好，画面不变。有体积的东西（第 6.2 墙体、
//   第 6.3 单位）法线不是 +Y，才会显出明暗——那时才该看见变化。
const IRRADIANCE_TARGET = Math.PI;
// v54：以下五项从写死的模块常量改为读 CONFIG.ui.lighting（软编码，编辑器可改）。
// **默认值与参数化前逐位一致**，本次改的只是"从哪里取"，不是取到什么。
// 之所以做成取值函数而不是模块顶层求值：CONFIG 可能在运行时被编辑器改，
// 顶层求值会把开局那一刻的值永久钉死（这个坑本仓库在 towerTierSkills 上踩过）。
const LIGHT = () => CONFIG.ui?.lighting || {};
const AMBIENT_SHARE_OF = () => LIGHT().ambientShare ?? 0.40;
const SUN_ELEV_OF = () => LIGHT().sunElevDeg ?? 55;   // 太阳仰角（DayNight 接管前）
const SUN_AZIM_OF = () => LIGHT().sunAzimDeg ?? 135;  // 方位：左上打光
const SHADOW_MAP_OF = () => LIGHT().shadowMapSize ?? 2048;
const SKY_COLOR_OF = () => LIGHT().skyColor ?? '#a8c4e0';
const GROUND_COLOR_OF = () => LIGHT().groundColor ?? '#40485a';
const SUN_DIST = 2000;                   // 光源到视野中心的距离（仅影响阴影相机 near/far 余量）
import { EffectsLayer } from './EffectsLayer.js';
// 后处理管线（场景 MSAA + SSAO + 体积雾 + 泛光 + 色调映射）。插件本地 vendor（离线）。
import { EffectComposer } from '../../vendor/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from '../../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/postprocessing/OutputPass.js';
import { setUnitTint } from './UnitMeshFactory.js';
// 渲染重构 Week2·Day8-10：轮廓描边 + SSAO，见 PostFX.js 头注。
import { ScenePass, createSSAOPass, createFogPass, HUD_SPRITE_LAYER, FX_PARTICLE_LAYER } from './PostFX.js';
import { SkyLight } from './skyLight.js';

// 默认仰角。取值理由：45° 是本次交付的起点值，压缩系数 0.71；
// LOL 实际约 56°（压缩 0.83）。取定手感后把最终值写死在这里，并在本行记录理由。
// 透视相机的默认俯仰角。LoL / Dota2 都是 55–60° 的俯视透视：近处单位有透视缩放、远处略小，
// 这一项就去掉了正交相机那种"摆在桌上的模型"的观感（docs/VISUAL-REWORK-REPORT.md §2）。
export const CAM_ELEVATION_DEG = CONFIG.ui?.camera?.elevationDeg ?? 57;
const CAM_FOV_OF = () => CONFIG.ui?.camera?.fovDeg ?? 45;

const DEG = Math.PI / 180;

// 缩放语义不变：controller.zoom 仍是"目标点处每世界单位占多少 CSS 像素"。
// 透视相机下机位距离由它反推：D = (H/2) / (zoom · tan(fov/2))。
const camDistOf = (zoom, H) => (H / 2) / (Math.max(0.01, zoom) * Math.tan(CAM_FOV_OF() * DEG / 2));


/**
 * CONFIG.toneMapping.mode（字符串）→ three 的色调映射枚举。
 * 认不出来的值退回 Neutral 而不是抛错——配置写错了不该让整个渲染器起不来。
 * 见 Config.js 里 toneMapping 那段头注：为什么从 ACES 换成 Neutral。
 */
function toneMappingModeOf(mode) {
  switch (String(mode || '').toLowerCase()) {
    case 'none':     return THREE.NoToneMapping;
    case 'aces':     return THREE.ACESFilmicToneMapping;
    case 'reinhard': return THREE.ReinhardToneMapping;
    case 'cineon':   return THREE.CineonToneMapping;
    case 'agx':      return THREE.AgXToneMapping;
    case 'neutral':
    default:         return THREE.NeutralToneMapping;
  }
}

export class ThreeRenderer {
  /**
   * 两层探测的静态工厂——探测不过一律返回 null，调用方用 renderer3d?.render() 兜底。
   *   第一层：全局 WebGLRenderingContext 是否存在。挡掉 Node 测试环境
   *           （sim_runtime 的 DOM 桩里 getContext() 不看参数、一律返回 2D Proxy，
   *            直接 new WebGLRenderer 会炸，等于给基线凭空加一条失败）。
   *   第二层：把构造整个包进 try/catch。浏览器里 WebGLRenderingContext 这个全局【永远存在】，
   *           但显卡黑名单 / WebGL 被用户禁用 / 上下文数量耗尽时 new WebGLRenderer() 照样 throw。
   * 两层合起来，测试环境和真浏览器降级走同一条路。
   */
  static create(canvas, mapSystem, eventBus, deps) {
    if (typeof WebGLRenderingContext === 'undefined') return null;
    try {
      return new ThreeRenderer(canvas, mapSystem, eventBus, deps);
    } catch (e) {
      console.warn('[ThreeRenderer] WebGL 初始化失败，2.5D 渲染层已禁用：', e?.message || e);
      return null;
    }
  }

  constructor(canvas, mapSystem, eventBus, deps) {
    this.canvas = canvas;
    this.mapSystem = mapSystem;
    this.deps = deps; // { entities, attrCalc, effects } —— UnitLayer 每帧读实体数据用（只读）

    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this._installGpuDiagnostics(canvas);
    this._devicePixelRatio = window.devicePixelRatio || 1;
    this.resolutionScale = 1;    // Week3·Day13-14：移动端分辨率自适应，见 setResolutionScale
    // qualityPreset 留 null（不是随便挑一个如 'high' 当默认）——开局的实际画质组合
    // （阴影 off + Bloom/描边/SSAO 全开 + 分辨率 100%）本来就不严格等于三档预设表里
    // 的任何一档，硬说它是"高"是骗自己；null 意味着"还没套用过任何预设，当前是
    // 逐项开关攒出来的自定义组合"，画质面板上三个按钮谁都不高亮，如实反映这一点。
    this.qualityPreset = null;
    this.qualityAuto = false;
    this.gl.setPixelRatio(this._devicePixelRatio);
    // P1 画质选项。色调映射默认【开启】（用户定稿），曲线由 CONFIG.toneMapping.mode
    // 决定——2026-09-05 从 ACES 换成 Khronos PBR Neutral，理由见 Config.js 那段头注
    // （ACES 把饱和冷色压成灰绿，与这套平涂高饱和的美术方向相冲）。
    this.gl.toneMapping = toneMappingModeOf(CONFIG.toneMapping?.mode);
    this.gl.toneMappingExposure = CONFIG.toneMapping?.exposure ?? 1.0;
    this.composer = null; this.bloomPass = null;
    this.scenePass = null; this.ssaoPass = null;
    this.fogPass = null;     // 任务 #178：伪体积雾
    this.postFX = true;      // 后处理总开关（关则直渲，泛光 / SSAO / 雾一并失效）
    this.bloomOn = true;     // 辉光
    this.aaOn = true;        // 抗锯齿（MSAA）
    this.toneMapOn = true;   // 色调映射（曲线见 CONFIG.toneMapping.mode）
    this.ssaoOn = true;      // Week2·Day9-10：SSAO，默认开
    // 任务 #178：伪体积雾，默认值走 CONFIG.volumetricFog.enabled（第 2 条铁律，与 CONFIG.outline 同级）。
    this.fogOn = CONFIG.volumetricFog?.enabled !== false;

    this.scene = new THREE.Scene();
    // 与 2D 画布 CSS 背景 #0a0d12 一致，切换时不闪底色
    this.scene.background = new THREE.Color(0x0a0d12);

    // 透视相机（2026-11 画面重构）。near/far 每帧按机位距离给，见 syncCameraFrom。
    this.camera = new THREE.PerspectiveCamera(CAM_FOV_OF(), 1, 10, 20000);
    // 主相机（beauty pass）要能看见血条/护盾图标这类 HUD 精灵——只有法线/深度预渲染
    // 那个专用相机会在渲染时临时关掉这个 layer（PostFX.js 头注），不影响这里。
    this.camera.layers.enable(HUD_SPRITE_LAYER);
    // ⚠️ 粒子/薄纱用 layers.set(FX_PARTICLE_LAYER) 把自己从默认的 0 层挪走了，
    // 主相机必须显式 enable，否则它们在正式渲染里也会一起消失（不只是描边预渲染）。
    this.camera.layers.enable(FX_PARTICLE_LAYER);
    this.elevationDeg = CAM_ELEVATION_DEG;
    this.azimuthDeg = 0;   // C 组·方位角（绕 Y 偏航）。0 = 原视角（无偏航）。
    this.lookHeightOffset = 0;   // 视角高度：机位+目标点同步沿世界 Y 轴平移的偏移量，见 setLookHeight 头注。

    this._buildLights();
    // 天空 IBL：所有 PBR 材质的环境光来源，随昼夜重算（skyLight.js）
    this.sky = new SkyLight(this.gl, this.scene);
    this._skyParams = { sunDir: this._sunDir.clone(), skyZenith: '#5f8fd0', skyHorizon: '#c7d3de', ground: '#4a4a44', sunColor: '#fff2dc', gain: 1, intensity: 1 };
    this.sky.update(this._skyParams);
    // 地图的全部"景"（地形 / 水 / 植被 / 摆件 / 局部光）：world/World.js
    this.world = new World(this.scene);
    this.weatherFx = new WeatherLayer(this.scene); // 天气可视化（雨/雪/雾/风/晴的粒子与薄纱）
    this.groundTrace = new GroundTraceLayer(this.scene); // Q4 天气重做：水洼贴花+雪盖遮罩
    this.units = new UnitLayer(this.scene);
    // v44：GLB 模型库整条删除（用户定稿："全部程序化，删 GLB"）。
    // 值得记一笔的是它**默认就是关的**（useModels = false）——
    // 也就是说这一年里屏幕上跑的一直是程序化几何，那 8 个 .glb 是个默认关闭的旁路。
    // 用户说"现有的模型很烂"指的正是程序化那套，所以要动的也是它（见 UnitMeshFactory）。
    this.units.mapSystem = mapSystem;   // 塔按兵线定向 / 地形取高都要读车道几何
    this.fx = new EffectsLayer(this.scene);
    // v43 Q8：腐蚀型的 3D 雾（常驻射程球 + 有敌时按攻速发出的扩散波）。
    // 单独成层是因为它要的是真网格（双面低透明球才有体积感），
    // 而 EffectsLayer 是三角批 —— 两者的资源生命周期完全不同。
    this.corrosionFx = new CorrosionLayer(this.scene);
    this.corrosionFx.camera = this.camera;       // 体积雾要视线方向
    this.corrosionFx.mapSystem = mapSystem;      // 与地面求交（地面以下的那段雾不算）
    this._target = new THREE.Vector3();
    this._terrainDirty = true;

    this.width = 0;
    this.height = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 真 HDR 输出：按【显示器能力】自动判定（SDR 屏上自动保持关闭，见 setHDR 的长注释）
    this.hdrOn = false; this._hdrConfigured = false;
    this.setHDR(null);

    // 切图后地面必须整体重建（贴图尺寸、世界尺寸都变了）
    eventBus?.on?.('map:loaded', () => { this._terrainDirty = true; this._loadingUI = true; this.units.clear(); this.fx.markStaticDirty();
      // 建筑动画（掉块 / 爆炸 / 重生）的特效材质先编译好，事件那一刻不再现编译着色器（会卡一下）
      this.units.bfx.prewarm(this.gl, this.camera); });
    // 清理保险 A：死亡事件即时删（保险 B = UnitLayer.update 里的帧戳兜底扫描）
    // 塔死后留成废墟（EntityContainer.purgeDead 豁免它），渲染条目不能在死亡这一刻摘掉：
    // 摘掉会连带 bfx.forget，下一帧废墟被当成"第一次见到"，被摧毁的爆炸就永远不播
    // （用户："塔生命值掉光爆炸的动画没有"）。废墟由 UnitLayer.update 的死亡结构扫描接着画。
    eventBus?.on?.('entity:death', ({ entityId }) => {
      if (this.deps?.entities?.get?.(entityId)?.type === 'tower') return;
      this.units.remove(entityId);
    });
  }

  /**
   * 显卡出问题时别静默黑屏：把原因直接显示在画面上（用户报"黑屏、控制台刷 glGetProgramiv: Program object expected"，
   * 那串刷屏是上下文丢失之后渲染器还拿着旧的着色器编号在用，真正的原因在它之前，而且我们的软件渲染复现不出来）。
   *  · 着色器编译 / 链接失败：记下编译日志（three 的 debug.onShaderError），照常打到控制台。
   *  · WebGL 上下文丢失：停止渲染（不再每帧刷错），弹出诊断框；浏览器恢复上下文后自动刷新一次（同一会话只自动刷新一次，防止循环）。
   * 诊断框里有显卡型号、第一条报错和可以逐个试的网址开关（见 main.js 的 applyDebugSwitches）。
   */
  _installGpuDiagnostics(canvas) {
    const diag = this.gpuDiag = { lost: false, errors: [], gpu: '' };
    try {
      const ctx = this.gl.getContext();
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      diag.gpu = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    } catch (e) { /* 拿不到显卡型号不影响运行 */ }
    this.gl.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n').trim();
      const msg = '着色器编译 / 链接失败：' + (log || '（驱动没有给出日志）');
      console.error('THREE.WebGLProgram: Shader Error', log);
      if (diag.errors.length < 5) diag.errors.push(msg.slice(0, 1200));
      this._showGpuDiag('有着色器在这块显卡上编译失败，画面可能不完整');
    };
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      diag.lost = true;
      // 已知：部分 Windows 显卡在"多重采样抗锯齿 + 新地形"时会让驱动重置上下文（用户实测 ?aa=0 就正常）。
      // 开着多重采样时丢了上下文，就记下来，下次加载自动关掉抗锯齿（网址里写 ?aa=1 可以强制再开、并清掉这条记录）。
      const aaWasOn = this.aaOn && (this.scenePass?.samples || 0) > 0;
      if (aaWasOn) { try { localStorage.setItem('seraAAFallback', '1'); } catch (er) { /* 存不了就算了 */ } }
      this._showGpuDiag('显卡把这个页面的渲染状态重置了（WebGL 上下文丢失），画面已停止'
        + (aaWasOn ? '。下次加载会自动关闭抗锯齿（多重采样）' : ''));
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      let n = 0;
      try { n = +(sessionStorage.getItem('seraGpuRestoreReload') || 0); sessionStorage.setItem('seraGpuRestoreReload', String(n + 1)); } catch (e) { n = 1; }
      if (n < 1) location.reload();
      else this._showGpuDiag('上下文又恢复了，但同一会话里已经自动刷新过一次，为防止循环不再自动刷新');
    }, false);
  }

  _showGpuDiag(title) {
    if (typeof document === 'undefined') return;
    const d = this.gpuDiag;
    let box = document.getElementById('gpuDiagBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gpuDiagBox';
      box.style.cssText = 'position:fixed;left:16px;right:16px;top:16px;z-index:99999;max-height:70vh;overflow:auto;'
        + 'background:rgba(20,22,28,0.96);color:#e8e8e8;border:1px solid #c0504d;border-radius:8px;padding:12px 14px;'
        + 'font:13px/1.6 system-ui,sans-serif;white-space:pre-wrap;user-select:text;';
      document.body.appendChild(box);
    }
    const q = (typeof location !== 'undefined') ? location.search : '';
    box.textContent = [
      '⚠️ ' + title,
      '显卡：' + (d.gpu || '未知'),
      '浏览器：' + (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      '当前网址开关：' + (q || '（无）'),
      d.errors.length ? '报错：\n' + d.errors.join('\n---\n') : '报错：没有捕获到着色器报错（多半是驱动重置或显存不够）',
      '',
      '可以逐个试下面这些网址开关（加在 index.html 后面），看哪个能让画面恢复，把结果和这段文字一起发给开发者：',
      '  ?aa=0       关抗锯齿（多重采样）',
      '  ?post=0     关全部后处理（抗锯齿 / SSAO / 雾 / 泛光）',
      '  ?shadow=0   关阴影',
      '  ?world=0    不建新地形（只看单位和建筑）',
      '  ?res=0.5    半分辨率渲染',
      '  可以组合，例如 ?aa=0&shadow=0',
    ].join('\n');
  }

  /**
   * 光照统一入口（为将来的天气系统 / 昼夜交替预留）。
   * 传入的项才改，其余保持。sunElevation 只影响【光照与投影方向】，不动摄像机。
   * normalize=true（默认）会把总辐照度重新标定回 π —— 即"改色不改亮度"，
   * 想做黄昏压暗、阴天发灰这类效果时传 false，自己给绝对强度。
   * fog 传数值即启用线性雾（世界单位），传 null 关闭。
   */
  setLighting(opt = {}) {
    const { sunColor, ambientSky, ambientGround, sunElevation, sunAzimuth, ambientShare, exposure, fog, background, unitTint, waterColdness, normalize = true } = opt;
    // v47：单位（塔/兵/龙）跟着环境一起变色，否则夜里满地图发白的小人（见 DayNight.unitTintOf）。
    // 走 setLighting 是因为**这里已经是光照的唯一入口** —— 再开一条并行的通道，
    // 就会出现"改了灯没改单位"的半截状态。
    if (unitTint !== undefined) {
      setUnitTint(unitTint);
      // 2026-09-26 修复：雪盖/水洼同样是 MeshBasicMaterial（不吃场景光照），
      // 用户报"雪覆盖时夜晚看不出来是夜晚，依旧亮堂堂的"——跟裙边同一个坑，
      // 见 GroundTraceLayer.setTint 头注。
      if (this.groundTrace?.setTint) this.groundTrace.setTint(unitTint);
    }
    // 天空 IBL 跟着光照走：天顶 / 地平线取昼夜给的天空色与底色，太阳色与方向同步；
    // 环境光占比映射成 environmentIntensity（半球光只保留很小一份，立面冷暖过渡仍在）
    if (this.sky) {
      const P = this._skyParams;
      if (ambientSky !== undefined) P.skyZenith = ambientSky;
      if (background !== undefined) P.skyHorizon = background;
      if (ambientGround !== undefined) P.ground = ambientGround;
      if (sunColor !== undefined) P.sunColor = sunColor;
      if (opt.skyZenith) P.skyZenith = opt.skyZenith;
      if (opt.skyHorizon) P.skyHorizon = opt.skyHorizon;
      P.gain = opt.skyGain ?? P.gain;
      const share = ambientShare ?? (this.hemi.intensity / IRRADIANCE_TARGET);
      P.intensity = (CONFIG.ui?.sky?.intensity ?? 1) * (exposure ?? 1) * Math.max(0.2, share * (CONFIG.ui?.sky?.shareK ?? 3.0));
    }
    if (sunColor !== undefined) this.sun.color.set(sunColor);
    if (ambientSky !== undefined) this.hemi.color.set(ambientSky);
    if (ambientGround !== undefined) this.hemi.groundColor.set(ambientGround);
    // v51.26：太阳方位角现在也能随时段扫动（原来固定死在 SUN_AZIM_DEG，太阳只会
    // 升降不会横移）。sunAzimuth 不传时退回原来的固定常量——这条分支单独存在
    // 就是为了保这个兜底：老调用点（不知道这个新参数的）行为不变。
    if (sunElevation !== undefined || sunAzimuth !== undefined) {
      const e = Math.max(5, Math.min(89, sunElevation ?? (Math.asin(this._sunDir.y) / DEG))) * DEG;
      const az = (sunAzimuth ?? SUN_AZIM_OF()) * DEG;
      this._sunDir.set(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)).normalize();
    }
    if (this.sky) { this._skyParams.sunDir.copy(this._sunDir); this.sky.update(this._skyParams); }
    if (normalize) {
      const share = ambientShare ?? (this._ambientShare ?? AMBIENT_SHARE_OF());
      this._ambientShare = share;
      const total = IRRADIANCE_TARGET * (exposure ?? 1);
      // 环境光主要由天空 IBL 提供（见上），半球光只留 hemiShare 这一小份做立面冷暖
      this.hemi.intensity = total * share * (CONFIG.ui?.sky?.hemiShare ?? 0.25);
      this.sun.intensity = total * (1 - share) * (CONFIG.ui?.lighting?.sunGain ?? 1.6) / Math.max(0.25, this._sunDir.y);
    }
    if (background !== undefined) this._fogColor = background;   // 大气透视的颜色 = 地平线天色
    if (fog !== undefined) {
      this.scene.fog = fog ? new THREE.Fog(new THREE.Color(this._fogColor || '#bcd4ec'), fog.near ?? 500, fog.far ?? 4000) : null;
    } else {
      // v51.27：调用方（main.js）不知道相机离场景多远，这条自动雾效自己算——见 _autoFog 头注。
      this._autoFog();
    }
    return { hemi: this.hemi.intensity, sun: this.sun.intensity, sunY: this._sunDir.y };
  }

  /**
   * v51.27：自动线性雾——用户提过"地图是个纸片子"，缺一层近实远虚的深度线索。
   *
   * 不能直接照抄 setLighting() 文档注释里写的那对旧默认值（near=500, far=4000）：
   * 相机实际上离目标点恒定 CAM_DIST(=20000) 那么远（见 _syncCamera 里 `cam.position.set`），
   * 且是【正交相机】——near/far 比的是相机到每个片元的真实视空间距离，不是屏幕上看起来的远近。
   * 500~4000 这个区间完全落在"比相机近得多"的地方，真接上会把整个场景雾成一片纯色，
   * 这套默认值显然是早年占位、从没跟这台相机的实际距离对过。
   *
   * 所以雾效范围要以 CAM_DIST 为基准、按当前地图对角线动态算：只在地图最远角落才开始
   * 起一点点雾（nearOffset 很保守），完全雾化的位置留在裙边淡出区之外（farOffset 给得
   * 足够远）——核心玩法区域几乎不受影响，只在地图边缘/裙边区域添一层大气纵深感，
   * 不会因为起雾而看不清对局。
   */
  _autoFog() {
    const F = (CONFIG.ui && CONFIG.ui.mapFog) || {};
    if (F.enabled === false) { this.scene.fog = null; return; }
    // 透视相机：大气透视按机位距离给——近处清晰，远处（延伸世界、地图远角）逐渐融进天光。
    // 机位距离随缩放变，所以 render() 每帧同步一次 near/far（只是两个数，没有重建开销）。
    const D = this._camDist || 1000;
    const near = D * (F.nearK ?? 1.1), far = D * (F.farK ?? 4.5);
    if (!this.scene.fog || !this.scene.fog.isFog) this.scene.fog = new THREE.Fog(new THREE.Color(this._fogColor || '#bcd4ec'), near, far);
    else { this.scene.fog.near = near; this.scene.fog.far = far; }
    if (this._fogColor !== undefined) this.scene.fog.color.set(this._fogColor);
  }

  _buildLights() {
    const dirShare = 1 - AMBIENT_SHARE_OF();
    const sinSun = Math.sin(SUN_ELEV_OF() * DEG);

    // 半球光而非纯环境光：法线朝上取天空色、朝下取地色，墙面与单位侧面自带冷暖过渡，
    // 低多边形风格靠这个才不会显得死板。地面法线恒 +Y，故其贡献恰为 skyColor 强度。
    this.hemi = new THREE.HemisphereLight(new THREE.Color(SKY_COLOR_OF()), new THREE.Color(GROUND_COLOR_OF()),
                                          IRRADIANCE_TARGET * AMBIENT_SHARE_OF());
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff,
                                          IRRADIANCE_TARGET * dirShare / sinSun);
    this.sun.castShadow = false;   // 由 setShadowLevel 决定
    const sh = this.sun.shadow;
    sh.mapSize.set(SHADOW_MAP_OF(), SHADOW_MAP_OF());
    sh.bias = -0.0005;
    sh.normalBias = 1.5;           // 世界单位；本场景尺度以 px 计，1~2 能压住自阴影条纹
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // 局部光（火炬 / 水晶）不用点光源：烘成光照图由材质按世界坐标查，见 world/worldShading.js。
    this.shadowLevel = 'off';      // 'all' | 'static' | 'off'
    this._sunDir = new THREE.Vector3(
      Math.cos(SUN_AZIM_OF() * DEG) * Math.cos(SUN_ELEV_OF() * DEG),
      sinSun,
      Math.sin(SUN_AZIM_OF() * DEG) * Math.cos(SUN_ELEV_OF() * DEG),
    ).normalize();
  }

  /**
   * 阴影档位。'all' = 全部投影；'static' = 只有塔与墙投影，小兵不投；'off' = 关闭。
   * 分档的意义：小兵是同屏数量级最大的一类（90~200），把它们排除掉能省下绝大部分
   * 阴影绘制开销，而画面上"建筑有影子"的观感几乎全部保留。
   * 各层在建网格时读 unitsCastShadow() / staticCastShadow() 决定自己的 castShadow。
   */
  setShadowLevel(level) {
    const lv = ['all', 'static', 'off'].includes(level) ? level : 'off';
    this.shadowLevel = lv;
    this.gl.shadowMap.enabled = lv !== 'off';
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.sun.castShadow = lv !== 'off';
    this.units?.setShadowLevel?.(lv);
    this.gl.shadowMap.needsUpdate = true;
    return lv;
  }

  unitsCastShadow()  { return this.shadowLevel === 'all'; }
  staticCastShadow() { return this.shadowLevel !== 'off'; }

  /**
   * 阴影相机跟随视野，而不是罩住整张地图。
   * 世界 3552 见方，若用一张 2048 贴图罩全图，每贴图像素 ≈1.7 世界单位，小兵直接糊成方块。
   * 跟随视野后分辨率随缩放自适应：全图视角本来就看不清细节，拉近时反而最清晰。
   * 取视野矩形的外接圆做正方形视锥——摄像机不旋转，一次算好即可，无需考虑光源朝向。
   */
  _fitShadowToView(controller) {
    if (!this.sun.castShadow) return;
    // 透视相机：阴影视锥罩住"相机视锥与地面相交的区域"（看不到地面的方向按一段距离截断）
    const D = this._camDist || 1000;
    const corners = this._groundCorners(D * (CONFIG.ui?.lighting?.shadowFarK ?? 2.2));
    const t = this._target;
    let r = 0;
    for (const c of corners) r = Math.max(r, Math.hypot(c.x - t.x, c.z - t.z));
    r = Math.min(r * 1.08, CONFIG.ui?.lighting?.shadowMaxRadius ?? 2600);
    this.sun.target.position.copy(t);
    this.sun.position.set(t.x + this._sunDir.x * SUN_DIST, this._sunDir.y * SUN_DIST, t.z + this._sunDir.z * SUN_DIST);
    // normalBias 随阴影贴图的世界像素尺寸走（视锥越大每像素覆盖越多世界单位）
    this.sun.shadow.normalBias = (2 * r / SHADOW_MAP_OF()) * 2.2;
    const c = this.sun.shadow.camera;
    c.left = -r; c.right = r; c.top = r; c.bottom = -r;
    c.near = 1; c.far = SUN_DIST * 2.5;
    c.updateProjectionMatrix();
  }

  // 与 CanvasRenderer.resize 同口径：按父容器 CSS 尺寸算，DPR 交给 setPixelRatio
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    this.width = width;
    this.height = height;
    this.gl.setSize(width, height, true);
    this._sizeComposer(width, height);
    // HDR 绘制缓冲跟着尺寸重设 —— 不重设的话缓冲还是旧分辨率，画面会被拉伸
    if (this.hdrOn) { try { this._applyHDRBuffer(); } catch (e) { /* 降级不致命 */ } }
  }

  /**
   * 后处理管线：场景（MSAA，带深度贴图）→ SSAO → 体积雾 → 泛光 → 输出（色调映射 + sRGB）。
   * SSAO 先把遮蔽处压暗，泛光抓到的亮度才是"压完 AO 之后"的值；雾在泛光之前，雾后面的发光水晶仍能透出一点光。
   * 抗锯齿用 MSAA（只在几何边缘多采样），不用 FXAA —— FXAA 会把贴图细节一起抹糊。
   */
  _aaSamples() {
    if (!this.aaOn) return 0;
    const A = CONFIG.postfx?.aa || {};
    // 高分屏每个 CSS 像素已经有 4 个以上物理像素，采样数减半就够，省一半的多重采样带宽
    const n = this.gl.getPixelRatio() >= (A.hiDpiRatio ?? 1.75) ? (A.samplesHiDpi ?? 2) : (A.samples ?? 4);
    return Math.min(n, this.gl.capabilities.maxSamples || n);
  }
  _buildComposer() {
    const w = this.width, h = this.height;
    this.composer = new EffectComposer(this.gl);
    this.scenePass = new ScenePass(this.scene, this.camera, w, h, this._aaSamples());
    this.composer.addPass(this.scenePass);

    this.ssaoPass = createSSAOPass(this.scenePass, this.camera, w, h);
    this.ssaoPass.enabled = this.ssaoOn;
    this.composer.addPass(this.ssaoPass);

    this.fogPass = createFogPass(this.scenePass, this.camera, w, h);
    this.fogPass.enabled = this.fogOn;
    this.composer.addPass(this.fogPass);

    // 泛光只抓【真正过曝】的东西（水晶、火焰、弹道），不是把偏亮的地面也糊开
    const B = CONFIG.postfx?.bloom || {};
    const bt = B.threshold ?? CONFIG.ui?.hdr?.bloomThreshold ?? 1.0;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), B.strength ?? 0.35, B.radius ?? 0.5, bt);
    this.bloomPass.enabled = this.bloomOn;
    this.composer.addPass(this.bloomPass);
    this.outputPass = new OutputPass();        // 色调映射（按 gl.toneMapping）+ sRGB 转码，管线末端唯一一次
    this.composer.addPass(this.outputPass);
    this._sizeComposer(w, h);
  }

  _sizeComposer(w, h) {
    if (!this.composer || !w || !h) return;
    // composer 的像素比是建的时候抄的一份；分辨率缩放改了渲染器的像素比之后要同步过去，
    // 否则后处理链还按旧分辨率画，再被拉伸到画布上
    this.composer.setPixelRatio(this.gl.getPixelRatio());
    this.composer.setSize(w, h);
    this.scenePass?.setSamples(this._aaSamples());
  }

  /**
   * ==================== 真 HDR 输出 ====================
   *
   * 先厘清一件事：这个管线**内部本来就是 HDR** —— EffectComposer 用
   * HalfFloatType 渲染目标，Bloom 在线性空间做，ACES 在末端收尾。
   * 缺的只是最后一步：输出仍被压回 SDR 的 [0,1]，HDR 显示器上看不到真高光。
   * 这个方法补的就是这一步。
   *
   * 做法（Chrome 的 WebGL HDR 路径）：
   *   ① canvas.configureHighDynamicRange({ mode:'extended' }) —— 让画布进入扩展动态范围
   *   ② gl.drawingBufferStorage(RGBA16F, w, h)               —— 绘制缓冲改半浮点，>1 的值才存得住
   *   ③ toneMappingExposure 乘 headroom                       —— 把高光顶到 SDR 白点之上
   *
   * ⚠️ 我无法验证这一条。这个开发环境是 headless、没有 HDR 显示器。
   * 所以采用【显示器能力自动探测】而不是默认开启：
   *   matchMedia('(dynamic-range: high)') 报告显示器真的是 HDR 时才启用。
   * SDR 屏上永远保持关闭 → 不会把现有画面搞灰/搞怪。
   * 想强制开关走 CONFIG.ui.hdr.force（true/false），设置·画质里有入口。
   *
   * 任何一步不支持都静默降级回 SDR，绝不因为"想要 HDR"而把画面搞坏。
   */
  /**
   * ==================== v43：HDR 检测查错了 API（我的 bug）====================
   * 用户："设置中的 HDR 开启不了，提示浏览器不支持，但是我用 HDR 测试网站提示支持
   *        HDR 啊，并且系统设置里我也打开 HDR 了。"
   *
   * 原实现第一句就是 `typeof this.canvas.configureHighDynamicRange !== 'function'`。
   * 那是 Chrome **从未正式发布**的实验 API —— 现代 Chrome 上它是 undefined。
   * 于是这个函数在任何浏览器上都返回 false，HDR 永远开不了，与显示器无关。
   * 更糟的是上面那段注释里我自己写着"⚠️ 我无法验证 ②"，那是一个没验证就写死成
   * "永远不支持"的猜测。猜错了就该按事实改，不是留着注释免责。
   *
   * 现在按【真的试一次】来判定：WebGL 的 HDR 输出需要两样，缺一不可 ——
   *   ① gl.drawingBufferStorage（把绘制缓冲换成 RGBA16F）
   *   ② gl.drawingBufferColorSpace 能被设成 rec2100-*（HDR 传输函数）
   * ② 只能试、不能查：Chrome 141 上这个属性**存在**，但赋 'rec2100-hlg' 会抛
   * TypeError（需要 chrome://flags 的实验性网页平台功能）。只看属性在不在，
   * 又会得到一个反方向的错误答案。
   *
   * configureHighDynamicRange 降级为"存在就顺带调一下"的兼容分支，不再当闸门。
   *
   * 还要说清一件事：**HDR 测试网站说"支持"和这里不是一回事。** 那些网站测的是
   * HDR 视频/图片播放（(dynamic-range: high) + HDR video/AVIF）。系统 HDR 和
   * 显示器 HDR 保证的是那个；WebGL **画布**输出 HDR 是另一套能力，默认关着。
   */
  hdrSupported() { return this.hdrDiagnose().ok; }

  /**
   * 逐项诊断，供设置面板显示"到底卡在哪一关"。
   * 返回 { ok, buffer, colorSpace, display, legacyApi, reason }。
   * 有这个读数，下次再出问题一眼看得见，不用像这次一样靠猜。
   */
  hdrDiagnose() {
    const out = { ok: false, buffer: false, colorSpace: false, display: false,
                  legacyApi: false, reason: '' };
    try {
      out.display = this.hdrDisplay();
      out.legacyApi = typeof this.canvas?.configureHighDynamicRange === 'function';
      const ctx = this.gl?.getContext?.();
      if (!ctx) { out.reason = 'no-gl'; return out; }
      out.buffer = typeof ctx.drawingBufferStorage === 'function';
      if (!out.buffer) { out.reason = 'no-drawingBufferStorage'; return out; }
      if (!('drawingBufferColorSpace' in ctx)) { out.reason = 'no-colorSpace'; return out; }
      // 真的试一次：设进去再读回来，读回来是它才算数（有的实现会静默忽略）。
      const want = (CONFIG.ui?.hdr?.colorSpace) || 'rec2100-hlg';
      const prev = ctx.drawingBufferColorSpace;
      try {
        ctx.drawingBufferColorSpace = want;
        out.colorSpace = (ctx.drawingBufferColorSpace === want);
      } catch (e) {
        out.colorSpace = false;
      } finally {
        try { ctx.drawingBufferColorSpace = prev; } catch (e) { /* 还原失败不致命 */ }
      }
      if (!out.colorSpace) { out.reason = 'colorSpace-rejected'; return out; }
      out.ok = true;
      return out;
    } catch (e) { out.reason = 'throw:' + (e?.name || 'Error'); return out; }
  }

  /** 显示器本身是不是 HDR（SDR 屏上开 HDR 只会更难看，所以这条是自动模式的闸门）。 */
  hdrDisplay() {
    try {
      return typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(dynamic-range: high)').matches;
    } catch (e) { return false; }
  }

  /** on 传 null = 走 CONFIG 的 auto/force 判定。返回最终是否启用。 */
  setHDR(on = null) {
    const c = CONFIG.ui?.hdr || {};
    let want;
    if (on !== null) want = !!on;
    else if (c.force !== null && c.force !== undefined) want = !!c.force;
    else want = (c.auto !== false) && this.hdrDisplay();

    // v43：force === true 时**不做能力检查，直接试**。
    // 用户："HDR 那里设置可以强制开启。"
    // 理由：能力检测再准也只是"我们以为浏览器能不能做"，而真相只有试一次才知道 ——
    // 这次的教训正是检测本身查错了 API、把所有人都挡在门外。强制开启是那道保险：
    // 检测说不行、用户觉得行，就让它真去试。失败会被下面的 try/catch 接住并降级，
    // 控制台留一条 warn，画面不会坏。
    const forced = (on === null || on === undefined) ? (c.force === true) : (!!on && c.force === true);
    if (want && !forced && !this.hdrSupported()) want = false;   // 非强制时静默降级
    this.hdrOn = want;

    try {
      const ctx = this.gl.getContext();
      if (want) {
        // 老的实验 API 存在就顺带调（早期 Chrome 需要它），不存在也不影响现代路径。
        if (typeof this.canvas.configureHighDynamicRange === 'function') {
          this.canvas.configureHighDynamicRange({ mode: c.mode || 'extended' });
        }
        this._applyHDRBuffer();
        // 现代路径的关键一步：HDR 传输函数。缓冲换成 RGBA16F 只是给了精度，
        // 不设色彩空间的话输出仍然被当成 sRGB 压回 SDR —— 那就是"开了但看不出来"。
        //
        // 强制开启时给一条退路：rec2100-*（真 HDR）被拒 → 退到 display-p3。
        // display-p3 **不是 HDR**，它只是广色域 + 16F 精度，但它在默认 Chrome 上就能用，
        // 画面确实会比 sRGB/8bit 好一点。这样"强制开启"至少能落到某个真实的东西上，
        // 而不是点完什么也没发生。落到哪一档记在 this.hdrMode 上，面板照实说。
        const want1 = c.colorSpace || 'rec2100-hlg';
        this.hdrMode = null;
        for (const cs of [want1, 'display-p3']) {
          try {
            ctx.drawingBufferColorSpace = cs;
            if (ctx.drawingBufferColorSpace === cs) { this.hdrMode = cs; break; }
          } catch (e) { /* 下一个候选 */ }
        }
        if (!this.hdrMode) throw new Error('浏览器拒绝了所有 HDR/广色域色彩空间');
      } else if (this._hdrConfigured) {
        // 关回 SDR：画布模式、色彩空间、曝光都要还原，否则会留在半亮不亮的状态
        if (typeof this.canvas.configureHighDynamicRange === 'function') {
          this.canvas.configureHighDynamicRange({ mode: 'standard' });
        }
        try { ctx.drawingBufferColorSpace = 'srgb'; } catch (e) { /* 还原失败不致命 */ }
        this.hdrMode = null;
      }
      this._hdrConfigured = want;
    } catch (e) {
      console.warn('[HDR] 配置失败，已降级为 SDR：', e?.message || e);
      this.hdrOn = false; this._hdrConfigured = false;
    }
    // 曝光：HDR 下把高光顶到 SDR 白点之上；SDR 下恢复 1.0
    // 曝光只在**真 HDR**（rec2100-*）下顶高光。退到 display-p3 时顶上去只会过曝 ——
    // 那一档没有 SDR 白点之上的余量可用。
    const trueHDR = this.hdrOn && /^rec2100/.test(this.hdrMode || '');
    this.gl.toneMappingExposure = trueHDR ? (c.headroom ?? 2.0) : (CONFIG.toneMapping?.exposure ?? 1.0);
    if (this.outputPass) { this.outputPass.material.needsUpdate = true; }
    return this.hdrOn;
  }

  /** 绘制缓冲改 RGBA16F。尺寸变化后要重来一次，否则缓冲还是旧分辨率。 */
  _applyHDRBuffer() {
    const ctx = this.gl.getContext();
    const pr = this.gl.getPixelRatio();
    const w = Math.max(1, Math.round(this.width * pr)), h = Math.max(1, Math.round(this.height * pr));
    // RGBA16F 的枚举值：WebGL2 常量，取不到就用字面量（0x881A）兜底
    const RGBA16F = ctx.RGBA16F ?? 0x881A;
    ctx.drawingBufferStorage(RGBA16F, w, h);
  }

  // ==== P1 画质开关（设置面板）。Pass.enabled 是 three 后处理的标准开关，切换零重建。====
  setPostFX(on) { this.postFX = !!on; return this.postFX; }
  setBloom(on) { this.bloomOn = !!on; if (this.bloomPass) this.bloomPass.enabled = this.bloomOn; return this.bloomOn; }
  /** 抗锯齿开关（MSAA）。setFXAA 是旧名字，画质面板和存档还在用，留作别名。 */
  setAA(on) { this.aaOn = !!on; this.scenePass?.setSamples(this._aaSamples()); return this.aaOn; }
  setFXAA(on) { return this.setAA(on); }
  get fxaaOn() { return this.aaOn; }
  // 轮廓描边已随画面重构删除（写实画面没有描边）；setOutline 保留为空操作，旧的设置存档调它不炸。
  setOutline() { return false; }
  setSSAO(on) { this.ssaoOn = !!on; if (this.ssaoPass) this.ssaoPass.enabled = this.ssaoOn; return this.ssaoOn; }
  // 任务 #178：伪体积雾独立开关，同一批"每项可独立开关"的先例。
  setFog(on) { this.fogOn = !!on; if (this.fogPass) this.fogPass.enabled = this.fogOn; return this.fogOn; }

  /**
   * v54 §9.8：雷暴 Signature——偶发全屏闪光，纯视觉、不带任何机制惩罚。
   * 用一个覆盖在 canvas 上的 DOM 层做淡入淡出，不进 WebGL 管线（不需要为一个
   * 稀疏的纯视觉效果新开一条 ShaderPass）。雷暴充能降到接近 0 时清空计时器，
   * 不会在充能刚好卡在阈值附近时连续触发。
   */
  _updateLightning(dt) {
    const thunderCharge = window.__weather?.getCharge ? (window.__weather.getCharge('thunderstorm') || 0) : 0;
    const cfg = CONFIG.ui?.thunderFlash;
    if (!cfg || cfg.enabled === false || thunderCharge <= 0.05) {
      if (this._lightningEl) this._lightningEl.style.opacity = '0';
      this._lightningTimer = 0;
      return;
    }
    if (!this._lightningEl) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:5;';
      this.canvas.parentElement.appendChild(el);
      this._lightningEl = el;
    }
    this._lightningTimer = (this._lightningTimer || 0) - dt;
    if (this._lightningTimer <= 0) {
      const minGap = cfg.minGapSec ?? 4, maxGap = cfg.maxGapSec ?? 12;
      this._lightningTimer = minGap + Math.random() * (maxGap - minGap);
      const peakAlpha = (cfg.peakAlpha ?? 0.55) * thunderCharge;
      const fadeSec = cfg.fadeSec ?? 0.35;
      this._lightningEl.style.transition = 'none';
      this._lightningEl.style.opacity = String(peakAlpha);
      requestAnimationFrame(() => {
        if (!this._lightningEl) return;
        this._lightningEl.style.transition = `opacity ${fadeSec}s ease-out`;
        this._lightningEl.style.opacity = '0';
      });
    }
  }

  /**
   * Week3·Day13-14：渲染分辨率缩放（移动端/低端设备用）。
   * scale=1 时行为与改动前完全一致（devicePixelRatio 原样用）；scale<1 时
   * 按比例调低实际渲染像素数——GPU 每帧要画的像素点是 (宽×高×DPR)²级别的开销，
   * 缩到 0.6 大约只画 36% 的像素，这是"平板卡"这类问题里性价比最高的一刀
   * （降分辨率对观感的伤害远小于关阴影/关后处理，尤其在小屏上几乎看不出）。
   */
  setResolutionScale(scale) {
    this.resolutionScale = Math.max(0.4, Math.min(1, scale || 1));
    this.gl.setPixelRatio(this._devicePixelRatio * this.resolutionScale);
    this._sizeComposer(this.width, this.height);
    return this.resolutionScale;
  }

  /**
   * Week3·Day13-14：画质分档——低/中/高一键切一整套（阴影/Bloom/描边/SSAO/分辨率）。
   * 数值表在 CONFIG.ui.qualityPresets（软编码，改那张表就能重新定义每档具体是什么）。
   * 'auto' 不在这三档字面量里——它是"自动模式"的标记，实际画质由
   * _autoAdjustQuality() 按帧时动态选一档落地，这里只记下"当前处于自动模式"。
   */
  setQualityPreset(preset) {
    this.qualityAuto = preset === 'auto';
    if (this.qualityAuto) {
      // 自动模式的起点档：从"中"开始试探，比从"高"开始更不容易让用户先看到一次卡顿。
      this._autoTier = this._autoTier || 'medium';
      this._autoDownStreak = 0; this._autoUpStreak = 0;
      preset = this._autoTier;
    }
    const table = CONFIG.ui?.qualityPresets || {};
    const p = table[preset] || table.medium;
    if (!p) return this.qualityPreset;
    this.qualityPreset = this.qualityAuto ? 'auto' : preset;
    this.setShadowLevel(p.shadow);
    this.setBloom(p.bloom);
    this.setSSAO(p.ssao);
    this.setFog(p.fog);
    this.setResolutionScale(p.resolutionScale);
    return this.qualityPreset;
  }

  /**
   * 自动模式的帧时判据：main.js 每 250ms 用 PERF.render 的窗口均值调这个方法一次
   * （复用既有的性能面板采样，不另开一条测量通道）。带连续命中次数的迟滞——
   * 直接照抄 WeatherSystem.getDominant() 的 DOMINANCE_HYSTERESIS 教训：单次超阈值
   * 就切档会在临界值附近来回抖动，画质一会儿高一会儿低比稳定在中档更打扰人。
   */
  _autoAdjustQuality(avgRenderMs) {
    if (!this.qualityAuto || !Number.isFinite(avgRenderMs)) return;
    const T = CONFIG.ui?.qualityPresets || {};
    const downMs = T.autoDownMs ?? 16, upMs = T.autoUpMs ?? 8;
    const downTicks = T.autoDownTicks ?? 2, upTicks = T.autoUpTicks ?? 4;
    const LADDER = ['low', 'medium', 'high'];
    const idx = LADDER.indexOf(this._autoTier);

    if (avgRenderMs > downMs) {
      this._autoDownStreak++; this._autoUpStreak = 0;
      if (this._autoDownStreak >= downTicks && idx > 0) {
        this._autoTier = LADDER[idx - 1];
        this._autoDownStreak = 0;
        this.setQualityPreset('auto'); // 重新走一遍，落地新档且保持 auto 标记
      }
    } else if (avgRenderMs < upMs) {
      this._autoUpStreak++; this._autoDownStreak = 0;
      if (this._autoUpStreak >= upTicks && idx < LADDER.length - 1) {
        this._autoTier = LADDER[idx + 1];
        this._autoUpStreak = 0;
        this.setQualityPreset('auto');
      }
    } else {
      this._autoDownStreak = 0; this._autoUpStreak = 0;
    }
  }
  setToneMapping(on) {
    this.toneMapOn = !!on;
    this.gl.toneMapping = this.toneMapOn ? toneMappingModeOf(CONFIG.toneMapping?.mode) : THREE.NoToneMapping;
    // OutputPass 的着色器按 toneMapping 编译，改后必须让它重编（否则切换不生效）。
    if (this.outputPass) this.outputPass.material.needsUpdate = true;
    return this.toneMapOn;
  }
  setWeatherFx(on) { this.weatherFx?.setEnabled(on); }

  setVegetation(on) { this.world.toggles.foliage = on !== false; this._terrainDirty = true; this.world._map = null; return this.world.toggles.foliage; }
  setMapSkirt() { return true; }   // 地图外围现在是地形的一部分（延伸世界），没有单独的裙边可关
  setParticles(on) { this.units.particlesOn = on !== false; return this.units.particlesOn; }
  setWater(on) { this.world.toggles.water = on !== false; this._terrainDirty = true; this.world._map = null; return this.world.toggles.water; }

  setElevation(deg) {
    // v51.6：下限从 1 改成 0（用户定稿"俯仰角调节改为0-90"）。0° 本身是安全的——
    // panScaleY()/等处理近似水平视角除零的地方早就有 Math.sin<=1e-3 时退回 1 的
    // 兜底（见 ThreeCameraController.panScaleY），不需要靠这里的下限去规避除零。
    this.elevationDeg = Math.max(0, Math.min(90, Number(deg) || 0));
    return this.elevationDeg;
  }

  // C 组·方位角：绕地图中心偏航（度）。0=原视角。取模到 [0,360)。
  setAzimuth(deg) {
    this.azimuthDeg = ((Number(deg) || 0) % 360 + 360) % 360;
    return this.azimuthDeg;
  }

  /**
   * ==================== 视角高度（追加需求）====================
   * 用户确认："看的位置上下移，镜头角度/朝向不变——比如把视线抬高去看塔顶/建筑
   * 上半部分，或者压低去看地面/兵线。" 不是俯仰角（那个是转角度），也不是镜头
   * 远近（正交摄像机下移动机位对成像没有任何视觉影响，纯属做了个不生效的假滑杆）。
   * 实现是把摄像机整个机位（cam.position）和看向的目标点（_target）沿世界 Y
   * 轴平移同一个量——两者一起动，相对几何关系（角度、距离）完全不变，纯粹是把
   * 整套机位挪到另一个高度去看，等价于"仰头/低头看"里"头的位置上下移"那种感觉，
   * 不是"头转动角度"。范围 ±250（塔身高度量级的几倍，够用来看塔顶或压到地面
   * 视角，太大会把目标点甩出地形合理范围）。
   */
  setLookHeight(h) {
    this.lookHeightOffset = Math.max(-250, Math.min(250, Number(h) || 0));
    return this.lookHeightOffset;
  }

  /**
   * 强制重建世界。用于河道可行走开关切换、地图编辑器的地形笔刷改完位图之后刷新画面。
   * 编辑会话里地图对象是同一个，所以高度场缓存和"同图跳过"的守卫都要显式作废。
   */
  invalidateTerrain() {
    this._terrainDirty = true;
    this.world._map = null;
    const ms = this.mapSystem;
    if (ms) { ms._tfield = null; ms._tfieldMap = null; }
  }

  /**
   * 摄像机映射桥（第2步的临时件，第4步 ThreeCameraController 会取代它）。
   *
   * 目标：与 2D 视口变换 `screen = offset + world * zoom` 在【水平方向严格 1:1】，
   * 纵向按 sin(仰角) 压缩（仰角 90° 时两者逐像素相同 —— 这就是对位验证的原理）。
   *
   * 推导（正交摄像机，视锥取 CSS 像素单位 left=-W/2 … top=H/2，camera.zoom = z）：
   *   屏幕上距画布中心的像素偏移 = (u_cam * z, -v_cam * z)
   *   地面点 P=(px,0,pz) 相对目标点 T 的相机空间坐标：
   *     u_cam = px - tx
   *     v_cam = (pz - tz) * (-sin p)      // 相机 up = (0, cos p, -sin p)
   *   => 屏幕偏移 = ((px-tx)*z, (pz-tz)*sin(p)*z)
   *   2D 侧：屏幕偏移 = ((px-xc)*zoom, (py-yc)*zoom)，其中画布中心对应的世界点
   *     xc = (W/2 - offsetX)/zoom, yc = (H/2 - offsetY)/zoom
   *   令 T=(xc,0,yc)、z=zoom，则 X 恒等，Y 差一个 sin(p) 因子。
   */
  syncCameraFrom(controller) {
    const W = this.width, H = this.height;
    if (!W || !H) return;
    const zoom = controller.zoom || 1;
    const p = this.elevationDeg * DEG;
    const sinP = Math.sin(p), cosP = Math.cos(p);
    const az = (this.azimuthDeg || 0) * DEG, ca = Math.cos(az), sa = Math.sin(az);

    const tx = (W / 2 - controller.offsetX) / zoom;
    const tz = (H / 2 - controller.offsetY) / zoom;
    const ly = this.lookHeightOffset || 0;
    this._target.set(tx, ly, tz);

    const cam = this.camera;
    const D = camDistOf(zoom, H);
    this._camDist = D;
    cam.fov = CAM_FOV_OF(); cam.aspect = W / H;
    // near/far 跟着机位距离走：near 太小浪费深度精度（SSAO / 雾都靠深度重建），far 要装下延伸世界
    cam.near = Math.max(2, D * (CONFIG.ui?.camera?.nearK ?? 0.04));
    cam.far = D * (CONFIG.ui?.camera?.farK ?? 8) + 3000;
    // 摄像机站在目标的 +Z 一侧向目标看；方位角把这一"站位"绕目标（绕 Y）转过 az。
    cam.position.set(tx + D * cosP * sa, D * sinP + ly, tz + D * cosP * ca);
    cam.up.set(-sinP * sa, cosP, -sinP * ca);
    cam.lookAt(this._target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  /** 相机视锥与地面（y=0）相交的四个角，看不到地面（视线过地平线）的角按 maxDist 截断 */
  _groundCorners(maxDist) {
    const cam = this.camera, out = [];
    const ray = new THREE.Ray(), dir = new THREE.Vector3(), ndc = new THREE.Vector3();
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ndc.set(x, y, 0.5).unproject(cam);
      dir.copy(ndc).sub(cam.position).normalize();
      ray.set(cam.position, dir);
      const t = dir.y < -1e-4 ? -cam.position.y / dir.y : Infinity;
      const d = Math.min(t, maxDist);
      out.push(new THREE.Vector3().copy(cam.position).addScaledVector(dir, d));
    }
    return out;
  }

  // ==================== 地面 ====================
  /**
   * 重建世界。两种走法：
   *  · 换图（map:loaded）：拆成若干步、每帧做一步，期间显示加载界面并暂停仿真（isLoading），
   *    最后用 compileAsync 把场景里所有材质的着色器在显卡上编译好再揭开画面——
   *    不然进图后第一次转镜头、第一次看到某种东西时还会再卡一下。
   *  · 其它（地图编辑器笔刷改了位图、开关水面 / 植被）：一次性同步建完，不弹加载界面。
   */
  _rebuildTerrain() {
    this._terrainDirty = false;
    const ms = this.mapSystem, map = ms?.currentMap;
    const withUI = this._loadingUI; this._loadingUI = false;
    if (!(ms?.hasWalls?.() && map?.world) || this.world.disabled) { this.world.dispose(); this._finishLoading(); return; }
    if (this.world.builtFor(map)) { this._finishLoading(); return; }
    setWeatherGroundMap(ms);   // 天气地表：世界尺寸 + 河道遮罩
    const opts = { anisotropy: Math.min(8, this.gl.capabilities.getMaxAnisotropy()) };
    if (!withUI) { this.world.build(ms, opts); this.gl.shadowMap.needsUpdate = true; return; }
    this._loading = { steps: this.world.buildSteps(ms, opts), i: 0, compiling: false, done: false, shown: false };
    LoadingScreen.show(map.label || map.id);
    LoadingScreen.progress(0, '准备中');
  }

  /** 加载中（仿真应暂停，main.js 的游戏循环读它）。 */
  isLoading() { return !!this._loading; }

  /** 每帧推进一步加载。返回 true 表示这一帧还在加载（不画场景）。 */
  _stepLoading() {
    const L = this._loading;
    if (!L) return false;
    const total = L.steps.length + 1;   // 最后一步是着色器编译
    // 第一帧什么都不做：先把加载界面画出来，再开始卡主线程的建图（否则界面要等第一步做完才显示）
    if (!L.shown) { L.shown = true; return true; }
    if (L.i < L.steps.length) {
      const st = L.steps[L.i++];
      try { st.run(); } catch (e) { console.error('[加载] ' + st.label + ' 失败：', e); }
      const next = L.steps[L.i];
      LoadingScreen.progress(L.i / total, next ? next.label : '编译着色器');
      return true;
    }
    if (!L.compiling) {
      L.compiling = true;
      this.gl.shadowMap.needsUpdate = true;
      const done = () => { L.done = true; };
      try {
        const p = this.gl.compileAsync ? this.gl.compileAsync(this.scene, this.camera) : null;
        if (p && p.then) p.then(done, done); else done();
      } catch (e) { done(); }
      // 兜底：驱动不支持并行编译时 compileAsync 可能很久才回来，最多等这么久就先揭开
      setTimeout(done, CONFIG.ui?.loading?.compileTimeoutMs ?? 8000);
      return true;
    }
    if (!L.done) return true;
    this._finishLoading();
    return false;
  }

  _finishLoading() {
    if (!this._loading && !LoadingScreen.isVisible()) return;
    this._loading = null;
    LoadingScreen.progress(1, '');
    LoadingScreen.hide();
  }

  // ===== 第 5 步：接手 CanvasController 面向渲染器的接口 =====
  // 摘除 Canvas 后 CanvasController 的 this.renderer 指向本类。这几个成员是它唯一
  // 需要的东西：点选要实体容器与命中半径，fitToWorld 要画布尺寸（width/height 已有）。
  // viewZoom/viewOffsetX/viewOffsetY 是 2D 时代的回写字段，3D 侧直接读 controller，
  // 这里只作为无害的落点保留，避免 updateView 里再加分支。
  get entities() { return this.deps?.entities || null; }
  getBuildingSize(t) { return buildingSize(t); }
  getMinionSize(m) { return minionSize(m); }

  /**
   * ==================== 夜色程度（0=白天 1=午夜）====================
   * 塔灯与火炬**都读这一个函数**。两处各算一遍是本仓库反复出事的形状 ——
   * 昼夜相位本身就因为"三处各算一遍"栽过一次（见 resolveDayPhase 的头注）。
   *
   * v45 修的真 bug：原式是 `phase >= 0.5 ? sin((phase-0.5)/0.5·π) : 0`，
   * 一个**半开区间**。而 phaseLabelOf 判定的"黎明"是 `p < 0.15 || p >= 0.9`，
   * 一段**跨零点**的区间。于是相位 0.90→1.00 那半段黎明灯还亮着（约 0.59），
   * 一过零点进入 0.00→0.15 那半段就 `phase < 0.5` → 灯**瞬间全灭**；
   * 而此时太阳仰角只有 16°、曝光 0.86 —— 画面纯黑，正是用户报的现象。
   * 同一句"天黑了"，HUD 和灯光各画了一条曲线。
   *
   * 现在以**离正午(0.25)的角距**为准：天然跨零点连续，午夜为 1、正午为 0，
   * 黎明两半严丝合缝。dawnFloor 是第二层保险：太阳压得很低的两段（黎明/黄昏）
   * 自然衰减仍偏暗，给个地板比整体提曝光更准 —— 只影响该亮灯的时候。
   */
  _nightLevel() {
    const ws = (typeof window !== 'undefined') ? window.CTX?.__world : null;
    const phase = resolveDayPhase(window.gameTime || 0,
                                  (typeof window !== 'undefined' ? window.CTX : null),
                                  ws?.weather ? ws.weather.enabled : true).phase;
    if (!Number.isFinite(phase)) return 0;
    const c = CONFIG.ui?.towerLight || {};
    const d = ((phase - 0.25) % 1 + 1) % 1;              // 0=正午，0.5=午夜
    const away = 1 - Math.abs(d - 0.5) / 0.5;            // 0=正午 1=午夜
    let night = Math.max(0, 1 - Math.cos(away * Math.PI / 2) ** 1.5);
    if (away > 0.45) night = Math.max(night, c.dawnFloor ?? 0.35);     // 低阳段地板
    return Math.max(0, Math.min(1, night));
  }

  render(controller) {
    if (!this.width || !this.height) return;
    if (this.gpuDiag?.lost) return;   // 上下文丢了：别再每帧调 GL（只会刷一屏"Program object expected"）
    {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      this._lightDt = this._lastRenderAt ? Math.min(0.1, t - this._lastRenderAt) : 0.016;
      this._lastRenderAt = t;
    }
    if (this._terrainDirty) this._rebuildTerrain();
    if (this._loading && this._stepLoading()) return;   // 加载中：这一帧只做一步建图，不画场景（加载界面盖着）
    if (controller) this.syncCameraFrom(controller);
    this._fitShadowToView(controller);
    this._autoFog();   // 大气透视的远近跟着机位距离走
    if (this.deps) {
      const rel = controller ? (controller.zoom / (controller._fitZoom || 1)) : 1;
      // 正交相机：可见世界高度 = (top−bottom)/zoom = H/zoom → 像素/世界单位 = zoom×DPR。
      // 水晶粒子按它把世界尺寸换算成 gl_PointSize（像素），否则缩放时粒子尺寸恒定、糊成一团。
      this.units.pxPerUnit = (controller ? (controller.zoom || 1) : 1) * this.gl.getPixelRatio();
      this.units.update(this.deps, rel, window.gameTime || 0);
      // 第3.5步：弹道/指示线/静态参照。lodDots 与 2D 的档2 同阈值（rel < 1.02）
      // 摄像机不偏航、只有仰角，故视线与上方向是常量，每帧算一次传给特效层。
      // 视线用于把光束/红线做成朝向摄像机的带子；上方向用于把子弹做成面向摄像机的片。
      // C 组·方位角：视线/上/右三基向量随仰角 + 方位角（绕 Y）旋转，每帧算一次传给特效层。
      // 右向量供子弹广告牌用（原先硬编码"右=世界+X"，偏航后必须改成摄像机右向）。
      const pr = this.elevationDeg * DEG, sp = Math.sin(pr), cp = Math.cos(pr);
      const az = (this.azimuthDeg || 0) * DEG, ca = Math.cos(az), sa = Math.sin(az);
      this.fx.update(this.deps, controller ? controller.zoom : 1, rel < 1.02,
                     { vx: -cp * sa, vy: -sp, vz: -cp * ca, ux: -sp * sa, uy: cp, uz: -sp * ca,
                       rx: ca, ry: 0, rz: -sa },
                     (id) => this.units.muzzleYOf(id),    // v43 P0-③：只按实体 id 查（坐标查已删）
                     (id) => this.units.muzzleOffsetOf(id));
      // v43 Q8：腐蚀雾。复用 EffectsLayer 的武器缓存（同一份 WeakMap，别再查第二遍），
      // dt 走**墙钟**——暂停时雾该继续飘，与 WeatherLayer 同口径。
      if (this.corrosionFx) {
        // 毒雾的圆心 = 塔杖顶的水晶（用户："腐蚀性武器的体积雾的圆心应该是塔手杖上的水晶"）；只是画面，毒圈生效范围不变
        this.corrosionFx.update(this.deps, this._lightDt || 0.016, (t) => this.fx._weaponOf(t), (t) => {
          const off = this.units.muzzleOffsetOf(t.id) || [0, 0], y = this.units.muzzleYOf(t.id);
          return y == null ? null : { x: t.pos.x + off[0], y, z: t.pos.y + off[1] };
        });
      }
    }
    // 天气可视化：粒子盒跟着镜头走，尺寸 = 当前可见世界范围。
    // 正交相机下可见世界宽 = W/zoom；纵深要把仰角压缩还原回去（屏幕上 Z 被压了 sin(仰角)）。
    // dt 用【墙钟】而不是 gameTime —— 游戏暂停时雨该继续下（那是天，不是战斗）。
    if (this.weatherFx) {
      const z = controller ? (controller.zoom || 1) : 1;
      // ==================== v45：视角拉低时下面缺一条带 ====================
      // 用户：「视角拉低的时候下面依旧有一块不显示天气的可视化效果。」
      //
      // 根因是几何算错，不是粒子不够。viewD = 屏幕高 / sin(仰角) 只对【地面上】
      // （y=0）的点成立；而雨雪是从 ceiling(约 520) 高处往下落的。
      // 高度 y 的粒子在屏幕上的纵坐标正比于 z·sin + y·cos，
      // 所以屏幕【底边】那一行对应的高空粒子，其地面投影落在盒子近边【之外】
      // 约 ceiling·cot(仰角) 处 —— 仰角越低这个量越大，缺的带就越宽，完全对上现象。
      //
      // 另外 Math.max(0.15, sin) 这个下限在仰角小于 8.6 度时会把 viewD【算小】，
      // 是同一症状的第二个来源（本该更深，反而更浅）。一并去掉：
      // 现在下限只用于防除零，真正的兜底是下面这条 cot 余量。
      const sinP = Math.max(1e-3, Math.sin(this.elevationDeg * DEG));
      const cotP = Math.cos(this.elevationDeg * DEG) / sinP;
      const ceilY = CONFIG.ui?.weatherFx?.ceiling ?? 520;
      const depthPad = Math.min(ceilY * cotP, ceilY * 12);   // 极低仰角 cot 会爆，夹一下
      // v43 Q6：方位角必须一起传下去。可见区域是一个**绕 Y 旋转过的**矩形，
      // 天气层原先按轴对齐盒子铺粒子，转视角后四个角落在盒外 → 那几块没有雨雪。
      this.weatherFx.update(window.__weather || null, this._target,
                            this.width / z, (this.height / z) / sinP + depthPad,
                            this._lightDt || 0.016, this.azimuthDeg || 0);
    }
    // 天气落到地面上（沙暴铺沙、雨天地湿、雪天结霜、雾天褪色），见 weatherGround.js 头注。
    // 天气可视化关掉时各通道平滑回 0，地面回到原色。
    {
      const wg = CONFIG.ui?.weatherGround?.windDir || [1, 0.57];
      updateWeatherGround(this.weatherFx?.enabled !== false ? (window.__weather || null) : null,
                          this._lightDt || 0.016, { x: wg[0], y: wg[1] });
      // 雨点涟漪（水洼 + 河面）：雨量跟地面湿度同一个量（已平滑），时间走墙钟
      updateRainRipple(performance.now() / 1000, weatherGroundState().wet);
    }
    // Q4 天气重做：水洼贴花+雪盖遮罩——GroundTraceSystem 自己管生成/合并/消退的节奏
    // （在 main.js 的仿真步进里推进，不是墙钟驱动），这里只负责按它的当前状态画。
    if (this.groundTrace) {
      this.groundTrace.update(window.__groundTrace || null, this.mapSystem);
    }
    // 世界（地形 / 水 / 植被 / 摆件 / 局部光）：时间走墙钟，暂停时风照吹、水照流
    {
      const ws0 = window.__weather;
      const ch = (id) => (ws0?.getCharge ? (ws0.getCharge(id) || 0) : 0);
      const wg = CONFIG.ui?.weatherGround?.windDir || [1, 0.57];
      this.world.update({
        time: performance.now() / 1000, dt: this._lightDt || 0.016,
        weather: weatherGroundState(), night: this._nightLevel(),
        wind: { x: wg[0], y: wg[1], strength: Math.max(ch('wind'), ch('hurricane'), ch('sandstorm')) },
        camera: this.camera, target: this._target, camDist: this._camDist || 1000, deps: this.deps,
      });
    }
    // 建筑动画特效材质的预热要跟着"着色器签名里的场景状态"走：场景雾（setLighting 在切图之后才挂上）、
    // 后处理（画进离屏缓冲 = 线性输出、不做色调映射）、阴影开关都在签名里。原来只在切图那一刻编译一次，
    // 那时还没有雾，真正爆炸时签名对不上，照样现编译——"塔播放损毁动画的时候依然会出现小卡顿"。
    if (this.units?.bfx) {
      const f = this.scene.fog;
      const sig = `${f ? (f.isFogExp2 ? 'e' : 'l') : 'n'}|${this.postFX ? 1 : 0}|${this.gl.shadowMap.enabled ? 1 : 0}|${this.mapSystem?.currentMap?.id || ''}`;
      if (sig !== this._bfxWarmSig) { this._bfxWarmSig = sig; this.units.bfx.prewarm(this.gl, this.camera); }
    }
    // 走后处理管线；关掉后处理或管线未就绪时回退直渲。
    if (this.postFX) {
      if (!this.composer) this._buildComposer();
      // 投影矩阵随缩放每帧都可能变，SSAO / 雾的位置重建要用本帧的
      this.ssaoPass?._syncCamera?.();
      // 任务 #178：强度读同一个口径的天气充能（见上方风吹植被 windCharge 的头注：
      // "强度取充能不取占比"），dt 走墙钟——暂停时雾也该继续缓慢呼吸。
      if (this.fogPass) {
        const ws = window.__weather;
        const fogCharge = ws?.getCharge ? (ws.getCharge('fog') || 0) : 0;
        // v54 §9.8：极端天气 Signature——按 id 直接查表，不用扫描全部激活极端天气。
        const exCharge = (id) => (ws?.getCharge ? (ws.getCharge(id) || 0) : 0);
        // 飓风 Signature：若同时有雾，流速也跟着拉满（取风充能与飓风充能较大者）。
        const sandstormCharge = exCharge('sandstorm');
        // 沙暴：沙流跟着风跑（流速按满风算），并沿风向拉长成一股股沙带，而不是一层均匀的黄
        const windCharge = Math.max(ws?.getCharge ? (ws.getCharge('wind') || 0) : 0, exCharge('hurricane'),
          sandstormCharge * (CONFIG.volumetricFog?.sandstormFlow ?? 1));
        // 沙暴借用雾通道当沙尘层——两个来源取更强的那个驱动浓度，不是相加。
        this.fogPass.setStrength(Math.max(fogCharge, sandstormCharge));
        this.fogPass.setColor?.(sandstormCharge > fogCharge
          ? (CONFIG.volumetricFog?.sandstormColor ?? '#c9a15a')
          : (CONFIG.volumetricFog?.color ?? '#c9d4de'));
        // v54 §9.3：雾-风联动——流速随风充能提速（见 PostFX.js._advanceNoise 头注）。
        this.fogPass._advanceNoise?.(this._lightDt || 0.016, windCharge);
        this.fogPass._syncCamera?.();
        this.fogPass.setUvWobble?.(exCharge('mirage') * 1.5); // 蜃景：热浪扭曲
        this.fogPass.setNoiseStretch?.(1 + Math.max(exCharge('haze_surge') * 2.2,
          sandstormCharge * (CONFIG.volumetricFog?.sandstormStretch ?? 2.6))); // 霾潮 / 沙暴：方向感
        this.fogPass.setMaxStrengthMul?.(1 + exCharge('densefog') * 0.25); // 浓雾：浓度上限抬高
      }
      // 雷暴 Signature（lightningFlash）：纯视觉、不带机制惩罚的偶发全屏闪光。
      this._updateLightning(this._lightDt || 0.016);
      this.composer.render();
    } else {
      this.gl.render(this.scene, this.camera);
    }
  }

  // 长跑验收用：scene.children 应 = 地面(0/1) + 活体单位×2（本体+血条），稳定不涨
  sceneStats() {
    return { children: this.scene.children.length, tracked: this.units.map.size,
             world: this.world.stats(),
             infoObjs: this.units.infoObjs,   // 第 3.7 步 E 组对象；children = 2×tracked + infoObjs + fx 网格 + 地面
             texCache: this.units._texCache.size, fx: this.fx.stats() };
  }
}
