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
import { WeatherLayer } from './WeatherLayer.js';
import { CorrosionLayer } from './CorrosionLayer.js';
import { WaterLayer } from './WaterLayer.js';
import { compositeTerrain, loadTexture } from './TerrainMaterial.js';
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
    this.weatherFx = new WeatherLayer(this.scene); // 天气可视化（雨/雪/雾/风/晴的粒子与薄纱）
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
    // v43 Q8：腐蚀型的 3D 雾（常驻射程球 + 有敌时按攻速发出的扩散波）。
    // 单独成层是因为它要的是真网格（双面低透明球才有体积感），
    // 而 EffectsLayer 是三角批 —— 两者的资源生命周期完全不同。
    this.corrosionFx = new CorrosionLayer(this.scene);
    this._target = new THREE.Vector3();
    this._terrainMesh = null;
    this._terrainMapId = null;
    this._terrainDirty = true;

    this.width = 0;
    this.height = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 真 HDR 输出：按【显示器能力】自动判定（SDR 屏上自动保持关闭，见 setHDR 的长注释）
    this.hdrOn = false; this._hdrConfigured = false;
    this.setHDR(null);

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

    // ==================== 塔灯光池（夜间照亮周围，含小兵）====================
    // 为什么是【固定大小的池】而不是"给每座塔挂一个灯"：
    // Three 的前向渲染把光源数量编进着色器，**数量一变就要重编译所有材质** ——
    // 对战地图有 44 座塔，按需增删灯会在每次开关灯时卡一下，比不做还糟。
    // 所以池子在初始化时一次性建好、数量恒定，之后只改位置/强度/距离；
    // 用不到的灯把 intensity 设 0（仍然参与着色器，但不产生亮度）。
    // 池子只服务【离镜头最近的 N 座】塔，远处塔靠地面光晕贴花示意（见 UnitLayer）。
    this.towerLights = [];
    const _tl = CONFIG.ui?.towerLight || {};
    const poolSize = Math.max(0, (_tl.poolSize ?? 20) | 0);
    for (let i = 0; i < poolSize; i++) {
      // decay：2 = 物理正确的平方反比，但中心过曝、边缘断崖；1.2~1.5 才是"火柴"那种
      // 平滑扩散（用户要的就是这个）。distance 每帧按"射程 + rangeExtra"设，超出即无贡献。
      const l = new THREE.PointLight(0xffffff, 0, 100, _tl.decay ?? 1.35);
      l.castShadow = false;         // 44 座塔的阴影贴图不现实，且夜间光池本就该柔和
      this.scene.add(l);
      this.towerLights.push(l);
    }

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
    // HDR 绘制缓冲跟着尺寸重设 —— 不重设的话缓冲还是旧分辨率，画面会被拉伸
    if (this.hdrOn) { try { this._applyHDRBuffer(); } catch (e) { /* 降级不致命 */ } }
  }

  // P1：后处理管线。Bloom 让自发光水晶/粒子/明亮昼夜辉光起来；ACES 由 OutputPass 收尾；FXAA 抗锯齿。
  _buildComposer() {
    const w = this.width, h = this.height;
    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // 阈值软编码：原来写死 0.82，会把所有偏亮的颜色都糊开（画面偏"脏"）。
    // 提到 1.0 之后只抓【真正过曝】的东西 —— 前提是场景里真的有超过 1.0 的东西，
    // 这正是 towerLight.emissiveNight 要把自发光推到 1.8 的原因。
    const bt = CONFIG.ui?.hdr?.bloomThreshold ?? 0.82;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.4, bt); // strength/radius/threshold
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
    this.gl.toneMappingExposure = trueHDR ? (c.headroom ?? 2.0) : 1.0;
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
  setFXAA(on) { this.fxaaOn = !!on; if (this.fxaaPass) this.fxaaPass.enabled = this.fxaaOn; return this.fxaaOn; }
  setToneMapping(on) {
    this.toneMapOn = !!on;
    this.gl.toneMapping = this.toneMapOn ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    // OutputPass 的着色器按 toneMapping 编译，改后必须让它重编（否则切换不生效）。
    if (this.outputPass) this.outputPass.material.needsUpdate = true;
    return this.toneMapOn;
  }
  setWeatherFx(on) { this.weatherFx?.setEnabled(on); }

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

  /**
   * 塔灯光池的每帧分配（用户定稿：塔在夜晚照亮射程 ×1.2 的范围，**要照到小兵**）。
   *
   * 池子大小恒定（见 _buildLights 的长注释：数量一变就要重编译所有材质），
   * 这里只做三件事：挑塔 → 摆位 → 给强度。用不上的灯 intensity=0。
   *
   * 挑哪些塔：夜间 × 存活 × 有武器，按【离视野中心的距离】取最近的 poolSize 座。
   * 不按"离摄像机"是因为正交相机没有透视距离概念，视野中心才是玩家在看的地方。
   *
   * 节流：分配每 lightInterval 秒做一次（默认 0.2s）。每帧重排会让灯在两座塔之间
   * 反复跳；而灯的位置突变比"晚 0.2 秒亮起"难看得多。
   * 强度的**淡入淡出仍然每帧插值**，所以切换是渐变的，不会闪。
   */
  _syncTowerLights(controller) {
    const pool = this.towerLights;
    if (!pool || !pool.length) return;
    const c = CONFIG.ui?.towerLight || {};
    if (c.enabled === false) { for (const l of pool) l.intensity = 0; return; }

    // 夜晚程度：0=白天完全不亮，1=午夜最亮。取相位在 [0.5,1) 上的正弦包，
    // 黄昏/黎明处自然渐入渐出（用阶跃的话天一黑所有灯"啪"一下全开）。
    // 相位走 resolveDayPhase —— 与 HUD、WorldState 的数值耦合**同一口径**。
    // 原来这里读 `CTX.__world.daynight.phase` 并要求 `ws.enabled`：那是第二个取值口，
    // WorldState 被关掉（或还没跑第一帧）时相位就是 null → 灯永远不亮，
    // 而 HUD 上明明显示着"夜晚"。同一个量两处取值，是本仓库反复出事的形状。
    const ws = (typeof window !== 'undefined') ? window.CTX?.__world : null;
    const phase = resolveDayPhase(window.gameTime || 0,
                                  (typeof window !== 'undefined' ? window.CTX : null),
                                  ws?.weather ? ws.weather.enabled : true).phase;
    let night = (Number.isFinite(phase) && phase >= 0.5) ? Math.sin((phase - 0.5) / 0.5 * Math.PI) : 0;
    if (c.nightOnly === false) night = 1;

    // 节流分配
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const every = c.lightInterval ?? 0.2;
    if (!this._lightPick || now - (this._lightPickAt || 0) >= every) {
      this._lightPickAt = now;
      this._lightPick = [];
      if (night > 0.001 && this.deps?.entities) {
        const cx = this._target.x, cz = this._target.z;
        const cand = [];
        for (const e of this.deps.entities.getAllTowers(true)) {
          if (!e.pos) continue;
          if (!(e._skillInstances || []).some(sk => sk.skillId.startsWith('weapon_'))) continue;
          const dx = e.pos.x - cx, dz = e.pos.y - cz;
          cand.push({ e, d2: dx * dx + dz * dz });
        }
        cand.sort((a, b) => a.d2 - b.d2);
        this._lightPick = cand.slice(0, pool.length).map(x => x.e);
      }
    }

    const picked = this._lightPick || [];
    const extra = c.rangeExtra ?? 50;
    const decay = c.decay ?? 1.35;
    const edgeLux = c.edgeLux ?? 0.16;
    const clampLux = c.centerClampLux ?? 3.2;
    const fade = Math.min(1, (this._lightDt ?? 0.016) / Math.max(0.01, c.fade ?? 0.35));
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i], e = picked[i];
      let want = 0;
      if (e && this.deps?.attrCalc) {
        const range = this.deps.attrCalc.calc(e, this.deps.effects.getEffects(e.id)).attackRange || 250;
        const R = range + extra;                       // 用户定稿：照亮"射程 + 50"（这是【地面上】的半径）
        // 灯挂在塔顶上方而不是地面：放地面的话光只往外糊一圈，
        // 站在塔边的小兵反而被自己脚下的暗部吃掉；挂太低则塔身离灯太近会过曝。
        const ly = (this.units.muzzleYOf?.(e.id) ?? 40) + (c.heightBias ?? 10);
        // ⚠️ distance 必须按【灯到地面边缘的斜距】给，不是地面半径 R。
        // 灯在空中 ly 高处，地面上半径 R 处那一点离灯是 √(R²+ly²)。
        // 直接把 distance 设成 R 的话，超出的部分被 Three 截成 0 —— 灯抬得越高，
        // 地面被照到的圈越小；抬到 200 时地面几乎全黑（实测截图就是这么发现的）。
        const dEdge = Math.hypot(R, ly);
        l.distance = dEdge;
        l.decay = decay;
        l.position.set(e.pos.x, ly, e.pos.y);
        const col = e._mapFaction === 'blue' ? c.colorBlue : e._mapFaction === 'red' ? c.colorRed : c.colorNeutral;
        l.color.set(col || '#ffe6b8');
        // ==================== 强度换算（这里曾经错了 5 个数量级）====================
        // r155 起 PointLight 的 intensity 是【坎德拉】，照度 = intensity / d^decay。
        // 第一版写成 `0.55 × 夜色 × (半径/250)` ≈ 0.66 —— 150px 处照度约 3e-5，
        // 而场景方向光是 2.3，等于完全看不见，看起来就像"这功能没做"。
        // 现在：从"地面边缘要剩多少照度"反推坎德拉，用的是斜距 dEdge（与 distance 同一个量）。
        want = edgeLux * Math.pow(dEdge, decay) * night;
        // 中心（塔脚正下方，离灯 ly）与边缘的照度比 = (dEdge/ly)^decay。
        // 这个比值就是"光池均不均匀"：ly 越高、decay 越小，池子越平。
        // clampLux 是最后一道保险，防某些塔的射程特别大时中心糊成死白。
        const centerLux = want / Math.pow(Math.max(12, ly), decay);
        if (centerLux > clampLux) want *= clampLux / centerLux;
      }
      l.intensity += (want - l.intensity) * fade;
      if (l.intensity < 1e-4) l.intensity = 0;
    }
  }

  render(controller) {
    if (!this.width || !this.height) return;
    {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      this._lightDt = this._lastRenderAt ? Math.min(0.1, t - this._lastRenderAt) : 0.016;
      this._lastRenderAt = t;
    }
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
                     (id) => this.units.muzzleYOf(id));   // v43 P0-③：只按实体 id 查（坐标查已删）
      // v43 Q8：腐蚀雾。复用 EffectsLayer 的武器缓存（同一份 WeakMap，别再查第二遍），
      // dt 走**墙钟**——暂停时雾该继续飘，与 WeatherLayer 同口径。
      if (this.corrosionFx) {
        this.corrosionFx.update(this.deps, this._lightDt || 0.016, (t) => this.fx._weaponOf(t));
      }
    }
    this._syncTowerLights(controller);
    this.water.update(window.gameTime || 0);   // P1：水面滚动 UV
    // 天气可视化：粒子盒跟着镜头走，尺寸 = 当前可见世界范围。
    // 正交相机下可见世界宽 = W/zoom；纵深要把仰角压缩还原回去（屏幕上 Z 被压了 sin(仰角)）。
    // dt 用【墙钟】而不是 gameTime —— 游戏暂停时雨该继续下（那是天，不是战斗）。
    if (this.weatherFx) {
      const z = controller ? (controller.zoom || 1) : 1;
      const sinP = Math.max(0.15, Math.sin(this.elevationDeg * DEG));
      // v43 Q6：方位角必须一起传下去。可见区域是一个**绕 Y 旋转过的**矩形，
      // 天气层原先按轴对齐盒子铺粒子，转视角后四个角落在盒外 → 那几块没有雨雪。
      this.weatherFx.update(window.__weather || null, this._target,
                            this.width / z, (this.height / z) / sinP,
                            this._lightDt || 0.016, this.azimuthDeg || 0);
    }
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
