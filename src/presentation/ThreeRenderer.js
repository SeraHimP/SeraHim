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
import { buildTerrainLayer } from './TerrainLayer.js';
import { UnitLayer } from './UnitLayer.js';
import { ModelLibrary } from './ModelLibrary.js';
import { WallLayer } from './WallLayer.js';
import { VegetationLayer } from './VegetationLayer.js';
import { WaterLayer } from './WaterLayer.js';
import { compositeTerrain, loadTexture } from './TerrainMaterial.js';
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
const AMBIENT_SHARE = 0.40;              // 环境占比：低了太硬、高了发灰，0.4 是低多边形常用区间
const SUN_ELEV_DEG = 55;                 // 太阳仰角（比摄像机 45° 高，投影不会长得盖住画面）
const SUN_AZIM_DEG = 135;                // 方位：左上打光
const SUN_DIST = 2000;                   // 光源到视野中心的距离（仅影响阴影相机 near/far 余量）
const SHADOW_MAP_SIZE = 2048;
const SKY_COLOR = 0xa8c4e0, GROUND_COLOR = 0x40485a; // 半球光上下色，冷调，贴合现有暗蓝底
import { EffectsLayer } from './EffectsLayer.js';
// P1 视觉优化：后处理管线（Bloom 辉光 + ACES 色调映射 + FXAA 抗锯齿）。插件本地 vendor（离线）。
import { EffectComposer } from '../../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/postprocessing/OutputPass.js';
import { ShaderPass } from '../../vendor/postprocessing/ShaderPass.js';
import { FXAAShader } from '../../vendor/shaders/FXAAShader.js';

// 默认仰角。取值理由：45° 是本次交付的起点值，压缩系数 0.71；
// LOL 实际约 56°（压缩 0.83）。取定手感后把最终值写死在这里，并在本行记录理由。
export const CAM_ELEVATION_DEG = 45;

const DEG = Math.PI / 180;

// 正交摄像机下"摄像机离目标多远"不影响成像大小，只影响深度范围。
// 取一个远大于世界尺寸（3552）的值，保证任何仰角下地面都落在 near/far 之间。
const CAM_DIST = 20000;

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
    this.gl.setPixelRatio(window.devicePixelRatio || 1);
    // P1 画质选项。电影级色调（ACES）默认【开启】（用户定稿）；可在设置里关。
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.composer = null; this.bloomPass = null; this.fxaaPass = null;
    this.postFX = true;      // 后处理总开关（关则直渲，Bloom/FXAA 一并失效）
    this.bloomOn = true;     // 辉光
    this.fxaaOn = true;      // 抗锯齿
    this.toneMapOn = true;   // 电影级色调（ACES）

    this.scene = new THREE.Scene();
    // 与 2D 画布 CSS 背景 #0a0d12 一致，切换时不闪底色
    this.scene.background = new THREE.Color(0x0a0d12);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAM_DIST * 3);
    this.elevationDeg = CAM_ELEVATION_DEG;
    this.azimuthDeg = 0;   // C 组·方位角（绕 Y 偏航）。0 = 原视角（无偏航）。

    this._buildLights();
    this.walls = new WallLayer(this.scene);
    this.veg = new VegetationLayer(this.scene);   // P1：野区植被（散布树/岩/灌木）
    this.vegOn = true;
    this.water = new WaterLayer(this.scene);      // P1：河道水面（涟漪法线 + 滚动 UV）
    this.tex = { ground: null, plateau: null, cliff: null };
    this._texTheme = null;
    this._loadMaterials(ThreeRenderer.themeOf(mapSystem?.currentMap));
    this.units = new UnitLayer(this.scene);
    // A：GLB 模型库（LOL 模型）。异步加载并烘焙（unlit→受光、烘骨架成静态、取挂点作炮口）。未完成时
    // UnitLayer.forTower 返回 null → 回退程序化几何；完成后 visKey 自然改变 → 下一帧自动换模型。
    // 用户定夺：LOL 模型美术问题（半透穿模等）暂搁置，默认【关闭】改用旧程序化几何。
    // 运行时可用 CTX.__useModels(true/false) 热切换（UnitLayer 按 visKey 逐帧重建，切回程序化亦即时生效）。
    this.models = new ModelLibrary();
    this.units.mapSystem = mapSystem;   // A：塔按兵线朝敌方定向要读车道/基地几何
    this._modelsLoadStarted = false;
    this.useModels = false;             // 默认关（旧模型）；置 true（或调 setUseModels(true)）启用 LOL 模型
    this.setUseModels(this.useModels);
    this.fx = new EffectsLayer(this.scene);
    this._target = new THREE.Vector3();
    this._terrainMesh = null;
    this._terrainMapId = null;
    this._terrainDirty = true;

    this.width = 0;
    this.height = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // 切图后地面必须整体重建（贴图尺寸、世界尺寸都变了）
    eventBus?.on?.('map:loaded', () => { this._loadMaterials(ThreeRenderer.themeOf(mapSystem?.currentMap)); this._terrainDirty = true; this.units.clear(); this.fx.markStaticDirty(); });
    // 清理保险 A：死亡事件即时删（保险 B = UnitLayer.update 里的帧戳兜底扫描）
    eventBus?.on?.('entity:death', ({ entityId }) => this.units.remove(entityId));
  }

  /**
   * 异步加载三张材质贴图。加载是并行的，全部落地后才标脏重建一次地形——
   * 逐张重建会让切图那一刻连闪三次。任何一张失败都不阻塞：compositeTerrain
   * 收到 null 就跳过那一层，画面退回纯程序化配色，不会白屏。
   */
  /** 地图 id → 主题名。同一峡谷的快速版共用一套材质，不必各存一份。 */
  static themeOf(map) {
    return map?.theme || String(map?.id || '').replace(/_quick/, '').replace(/_v\d+$/, '') || 'default';
  }

  async _loadMaterials(theme = 'default') {
    if (this._texTheme === theme) return;
    this._texTheme = theme;
    // 先找主题目录，缺哪张就回落到 assets/textures/ 根目录的通用图。
    // 这样新增一张地图时，没画材质也不会白屏，只是沿用通用质感。
    // 'default'（地图加载前的初始主题）没有专属目录，直接取根图——省掉启动时 3 次
    //  assets/textures/default/*.png 的必然 404（纯控制台噪声，会掩盖真正的报错）。
    const pick = async (name) =>
      (theme !== 'default' && await loadTexture(`assets/textures/${theme}/${name}.png`, true))
      || (await loadTexture(`assets/textures/${name}.png`));
    const [ground, plateau, cliff] = await Promise.all([pick('ground'), pick('plateau'), pick('cliff')]);
    if (this._texTheme !== theme) return;   // 期间又切了图，丢弃这批结果
    this.tex = { ground, plateau, cliff };
    // 必须连地图 id 缓存一起作废：_rebuildTerrain 开头有 "同一张图就跳过" 的守卫，
    // 只置 _terrainDirty 会被它挡回去 —— 症状正是"贴图要切一次图才出现"。
    this._terrainMapId = null;
    if (cliff) {
      const t = new THREE.CanvasTexture(cliff);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;      // 只横向重复；v 方向贴一遍，绕开该图的上下接缝
      t.wrapT = THREE.ClampToEdgeWrapping;
      this.walls.setCliffTexture(t);
    }
    this._terrainDirty = true;
  }

  /**
   * 光照统一入口（为将来的天气系统 / 昼夜交替预留）。
   * 传入的项才改，其余保持。sunElevation 只影响【光照与投影方向】，不动摄像机。
   * normalize=true（默认）会把总辐照度重新标定回 π —— 即"改色不改亮度"，
   * 想做黄昏压暗、阴天发灰这类效果时传 false，自己给绝对强度。
   * fog 传数值即启用线性雾（世界单位），传 null 关闭。
   */
  setLighting(opt = {}) {
    const { sunColor, ambientSky, ambientGround, sunElevation, ambientShare, exposure, fog, background, normalize = true } = opt;
    if (background !== undefined && this.scene.background) this.scene.background.set(background); // C 组·天空：昼夜给天穹/边界底色染色
    if (sunColor !== undefined) this.sun.color.set(sunColor);
    if (ambientSky !== undefined) this.hemi.color.set(ambientSky);
    if (ambientGround !== undefined) this.hemi.groundColor.set(ambientGround);
    if (sunElevation !== undefined) {
      const e = Math.max(5, Math.min(89, sunElevation)) * DEG;
      this._sunDir.set(Math.cos(SUN_AZIM_DEG * DEG) * Math.cos(e), Math.sin(e),
                       Math.sin(SUN_AZIM_DEG * DEG) * Math.cos(e)).normalize();
    }
    if (normalize) {
      const share = ambientShare ?? (this.hemi.intensity / IRRADIANCE_TARGET);
      const total = IRRADIANCE_TARGET * (exposure ?? 1);
      this.hemi.intensity = total * share;
      this.sun.intensity = total * (1 - share) / Math.max(0.05, this._sunDir.y);
    }
    if (fog !== undefined) {
      this.scene.fog = fog ? new THREE.Fog(this.scene.background, fog.near ?? 500, fog.far ?? 4000) : null;
    }
    return { hemi: this.hemi.intensity, sun: this.sun.intensity, sunY: this._sunDir.y };
  }

  /** 排查用：关/开材质贴图后重建地形。用于二分"画面问题出在贴图还是别处"。 */
  setTexturesEnabled(on) {
    this._terrainMapId = null;   // 同上：绕开"同图跳过"守卫
    if (on && !this._texBackup) return this._texOn = true;
    if (!on) { this._texBackup = this._texBackup || this.tex; this.tex = { ground: null, plateau: null, cliff: null }; }
    else { this.tex = this._texBackup; this._texBackup = null; }
    this._terrainDirty = true;
    return on;
  }

  _buildLights() {
    const dirShare = 1 - AMBIENT_SHARE;
    const sinSun = Math.sin(SUN_ELEV_DEG * DEG);

    // 半球光而非纯环境光：法线朝上取天空色、朝下取地色，墙面与单位侧面自带冷暖过渡，
    // 低多边形风格靠这个才不会显得死板。地面法线恒 +Y，故其贡献恰为 skyColor 强度。
    this.hemi = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR,
                                          IRRADIANCE_TARGET * AMBIENT_SHARE);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff,
                                          IRRADIANCE_TARGET * dirShare / sinSun);
    this.sun.castShadow = false;   // 由 setShadowLevel 决定
    const sh = this.sun.shadow;
    sh.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sh.bias = -0.0005;
    sh.normalBias = 1.5;           // 世界单位；本场景尺度以 px 计，1~2 能压住自阴影条纹
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.shadowLevel = 'off';      // 'all' | 'static' | 'off'
    this._sunDir = new THREE.Vector3(
      Math.cos(SUN_AZIM_DEG * DEG) * Math.cos(SUN_ELEV_DEG * DEG),
      sinSun,
      Math.sin(SUN_AZIM_DEG * DEG) * Math.cos(SUN_ELEV_DEG * DEG),
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
    if (this._terrainMesh) this._terrainMesh.receiveShadow = lv !== 'off';
    this.units?.setShadowLevel?.(lv);
    this.walls?.setShadowLevel?.(lv);
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
    const zoom = controller?.zoom || 1;
    const sinP = Math.sin(this.elevationDeg * DEG) || 1;
    const halfW = (this.width / 2) / zoom;
    const halfD = (this.height / 2) / zoom / sinP;   // 纵向被 sin(仰角) 压缩，反除回去
    const r = Math.hypot(halfW, halfD) * 1.1;        // 10% 余量，防边缘物体投影被裁掉

    const t = this._target;
    this.sun.target.position.copy(t);
    this.sun.position.set(t.x + this._sunDir.x * SUN_DIST,
                          this._sunDir.y * SUN_DIST,
                          t.z + this._sunDir.z * SUN_DIST);
    // normalBias 必须随阴影贴图的【世界像素尺寸】走：视锥越大每贴图像素覆盖越多世界单位，
    // 固定 bias 在全图视角下压不住大平面（高地顶面）的自阴影，整片会发黑。
    this.sun.shadow.normalBias = (2 * r / SHADOW_MAP_SIZE) * 2.2;
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
  }

  // P1：后处理管线。Bloom 让自发光水晶/粒子/明亮昼夜辉光起来；ACES 由 OutputPass 收尾；FXAA 抗锯齿。
  _buildComposer() {
    const w = this.width, h = this.height;
    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.4, 0.82); // strength/radius/threshold
    this.bloomPass.enabled = this.bloomOn;
    this.composer.addPass(this.bloomPass);
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.fxaaPass.enabled = this.fxaaOn;
    this.composer.addPass(this.fxaaPass);
    this.outputPass = new OutputPass();        // 色调映射（按 gl.toneMapping）+ sRGB 转码，管线末端唯一一次
    this.composer.addPass(this.outputPass);
    this._sizeComposer(w, h);
  }

  _sizeComposer(w, h) {
    if (!this.composer || !w || !h) return;
    const pr = this.gl.getPixelRatio();
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.fxaaPass.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }

  // ==== P1 画质开关（设置面板）。Pass.enabled 是 three 后处理的标准开关，切换零重建。====
  setPostFX(on) { this.postFX = !!on; return this.postFX; }
  setBloom(on) { this.bloomOn = !!on; if (this.bloomPass) this.bloomPass.enabled = this.bloomOn; return this.bloomOn; }
  setFXAA(on) { this.fxaaOn = !!on; if (this.fxaaPass) this.fxaaPass.enabled = this.fxaaOn; return this.fxaaOn; }
  setToneMapping(on) {
    this.toneMapOn = !!on;
    this.gl.toneMapping = this.toneMapOn ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    // OutputPass 的着色器按 toneMapping 编译，改后必须让它重编（否则切换不生效）。
    if (this.outputPass) this.outputPass.material.needsUpdate = true;
    return this.toneMapOn;
  }
  setVegetation(on) {
    this.vegOn = on !== false;
    if (this.vegOn) this.veg.build(this.mapSystem); else this.veg.clear();
    return this.vegOn;
  }
  setParticles(on) { this.units.particlesOn = on !== false; return this.units.particlesOn; }
  setWater(on) { const v = this.water.setEnabled(on); if (v) this.water.build(this.mapSystem); return v; }

  setElevation(deg) {
    this.elevationDeg = Math.max(1, Math.min(90, Number(deg) || 0));
    return this.elevationDeg;
  }

  // C 组·方位角：绕地图中心偏航（度）。0=原视角。取模到 [0,360)。
  setAzimuth(deg) {
    this.azimuthDeg = ((Number(deg) || 0) % 360 + 360) % 360;
    return this.azimuthDeg;
  }

  // LOL 模型总开关。on=true 用 GLB 模型（首次启用才懒加载烘焙，避免关着也去拉 16 个 GLB）；
  // on=false 把 units.models 置空 → _visualOf 回退旧程序化几何。切换即时生效：UnitLayer 逐帧比对
  // visKey，模型态↔程序化态的重建在下一帧的 sync 里自动完成（见 UnitLayer 的 visKey 分支）。
  setUseModels(on) {
    this.useModels = !!on;
    this.units.models = this.useModels ? this.models : null;
    if (this.useModels && !this._modelsLoadStarted) {
      this._modelsLoadStarted = true;
      this.models.load().catch(e => console.warn('[ThreeRenderer] 模型库加载失败：', e?.message || e));
    }
    return this.useModels;
  }

  // 强制重建地形（含墙体重采样 isWalkable）。用于河道可行走开关切换后刷新开挖的河道。
  // 必须把 _terrainMapId 置空——否则 _rebuildTerrain 开头的"同一张图就跳过"守卫会挡回（陷阱#6）。
  invalidateTerrain() { this._terrainMapId = null; this._terrainDirty = true; }

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
    this._target.set(tx, 0, tz);

    const cam = this.camera;
    cam.left = -W / 2; cam.right = W / 2;
    cam.top = H / 2; cam.bottom = -H / 2;
    cam.zoom = zoom;
    cam.near = 1; cam.far = CAM_DIST * 3;
    // 摄像机站在目标的 +Z 一侧向目标看；方位角把这一"站位"绕目标（绕 Y）转过 az。
    cam.position.set(tx + CAM_DIST * cosP * sa, CAM_DIST * sinP, tz + CAM_DIST * cosP * ca);
    // up 显式给出（同样绕 az 旋转），避免仰角 90° 时与视线共线导致 lookAt 退化
    cam.up.set(-sinP * sa, cosP, -sinP * ca);
    cam.lookAt(this._target);
    cam.updateProjectionMatrix();
  }

  // ==================== 地面 ====================
  _disposeTerrain() {
    if (!this._terrainMesh) return;
    this.scene.remove(this._terrainMesh);
    this._terrainMesh.geometry.dispose();
    // 纹理来自 TerrainLayer 的模块级缓存画布，dispose 只释放 GPU 侧句柄，不动那张离屏画布
    this._terrainMesh.material.map?.dispose();
    this._terrainMesh.material.dispose();
    this._terrainMesh = null;
    this._terrainMapId = null;
  }

  _rebuildTerrain() {
    this._terrainDirty = false;
    const ms = this.mapSystem;
    const map = ms?.currentMap;
    // 与 CanvasRenderer.render() 里的地形层条件保持同一口径
    const want = !!(ms?.hasWalls?.() && map?.world);
    if (!want) { this._disposeTerrain(); return; }
    if (this._terrainMesh && this._terrainMapId === map.id) return;
    this._disposeTerrain();

    const { w: WW, h: WH } = map.world;
    // 第 6.5 步：先按区域把材质合成进地形画布，再上传为贴图。
    // 墙体网格此刻可能还没建（首次进来），故用上一轮的 grid；随后 walls.rebuild 会刷新它，
    // 下次切图即对齐——首帧材质分区略有偏差，肉眼不可辨，换取不做两遍采样。
    // 顺序有讲究：先建墙体拿到可走网格，再据它分区合成，最后把成品贴图回填给顶面。
    // 首版是"先合成再建墙"，于是首次进图时网格还是 null → 高地材质整轮缺席，
    // 要等下一次切图才出现。这类"第一次不对、第二次才对"的时序坑最难查。
    this.walls.rebuild(this.mapSystem, null);
    const gr = this.walls.grid;
    const composed = compositeTerrain(buildTerrainLayer(map, gr, ms), map.world,
                                      gr?.walk || null, gr?.nx || 0, gr?.ny || 0,
                                      this.tex.ground, this.tex.plateau);
    const tex = new THREE.CanvasTexture(composed);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;          // 全图视角下贴图缩小 5 倍以上，没 mipmap 会闪成一片噪点
    tex.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());

    // PlaneGeometry 默认在 XY 平面。rotateX(-90°) 把它放平到 XZ：局部 +Y → 世界 -Z。
    // 于是 uv(0,0)（贴图左下）落在世界 (0, WH)，uv(1,1) 落在世界 (WW, 0)——
    // 正好对上离屏画布"像素 (0,0) = 世界 (0,0)"加上 three 默认 flipY=true 的翻转，无需再手动翻。
    // C 组·台阶地形：细分地面并按 heightAt 抬/沉顶点。P1：段 48→24px 加密，台阶边缘与斜坡更利落（顶点数×4，仍是一次性构建）；
    // 抬沉后重算法线，台阶侧面才吃光（否则整片平面法线、阶梯看不出）。WallLayer 丛林崖体不经此处。
    const segX = Math.max(1, Math.round(WW / 24)), segZ = Math.max(1, Math.round(WH / 24));
    const geo = new THREE.PlaneGeometry(WW, WH, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    if (ms?.heightAt) {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, ms.heightAt(WW / 2 + pos.getX(i), WH / 2 + pos.getZ(i)));
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
    // 第 6.1 步：改为受光材质。灯组标定到总辐照度 = π，故平面地面的出射色
    // 与此前 MeshBasicMaterial 时代逐像素相同——本步是刻意的"视觉空操作"。
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = this.shadowLevel !== 'off';
    mesh.position.set(WW / 2, 0, WH / 2);
    this.scene.add(mesh);
    this._terrainMesh = mesh;
    this._terrainMapId = map.id;
    // 第 6.2 步：墙体与地面同源同贴图，必须在同一处重建，避免两者错位一帧
    if (this.walls.top) {           // 回填顶面贴图（几何已在上面建好）
      this.walls.top.material.map = tex;
      this.walls.top.material.needsUpdate = true;
    }
    if (this.vegOn) this.veg.build(this.mapSystem);   // P1：野区植被随地形一同重建（自带同图跳过守卫）
    this.water.build(this.mapSystem);                 // P1：河道水面同上
  }

  // ===== 第 5 步：接手 CanvasController 面向渲染器的接口 =====
  // 摘除 Canvas 后 CanvasController 的 this.renderer 指向本类。这几个成员是它唯一
  // 需要的东西：点选要实体容器与命中半径，fitToWorld 要画布尺寸（width/height 已有）。
  // viewZoom/viewOffsetX/viewOffsetY 是 2D 时代的回写字段，3D 侧直接读 controller，
  // 这里只作为无害的落点保留，避免 updateView 里再加分支。
  get entities() { return this.deps?.entities || null; }
  getBuildingSize(t) { return buildingSize(t); }
  getMinionSize(m) { return minionSize(m); }

  render(controller) {
    if (!this.width || !this.height) return;
    if (this._terrainDirty) this._rebuildTerrain();
    if (controller) this.syncCameraFrom(controller);
    this._fitShadowToView(controller);
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
                     (x, z) => this.units.muzzleY(x, z));
    }
    this.water.update(window.gameTime || 0);   // P1：水面滚动 UV
    // P1：走后处理管线（Bloom+ACES+FXAA）；关掉后处理或管线未就绪时回退直渲。
    if (this.postFX) {
      if (!this.composer) this._buildComposer();
      this.composer.render();
    } else {
      this.gl.render(this.scene, this.camera);
    }
  }

  // 长跑验收用：scene.children 应 = 地面(0/1) + 活体单位×2（本体+血条），稳定不涨
  sceneStats() {
    return { children: this.scene.children.length, tracked: this.units.map.size,
             walls: this.walls.buildStats(),
             infoObjs: this.units.infoObjs,   // 第 3.7 步 E 组对象；children = 2×tracked + infoObjs + fx 网格 + 地面
             texCache: this.units._texCache.size, fx: this.fx.stats() };
  }
}
