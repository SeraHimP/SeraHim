/**
 * CanvasController —— 视口与输入控制（第 5 步后驱动 WebGL 画布）
 *
 * 类名保留不改：它控制的仍然是一个 <canvas> 元素，只是内容从 2D 上下文换成了 WebGL。
 * 改名会波及 sim_v24 的两条源码文本断言（测试改动需单独报批），收益仅为字面美观。
 *
 * this.renderer 现在指向 ThreeRenderer（无 WebGL 时为 null，故所有访问都带保护）。
 * 视口状态（zoom/offsetX/offsetY）的唯一来源仍在本类，渲染器每帧从这里读。
 */
import { CAM_ELEVATION_DEG } from '../presentation/ThreeRenderer.js';

export class CanvasController {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.zoom = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;

    this.isDragging = false;
    this.dragMoved = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartOffsetX = 0;
    this.dragStartOffsetY = 0;

    this._placeMode = false;
    this._placeCallback = null;

    // 3D 输入换算适配器（main.js 注入）。为 null 时退回平面反算——
    // 那是【无 WebGL 环境】的降级路径，不再是"2D 模式"（2D 渲染器已于第 5 步摘除）。
    this.view3d = null;

    this.setupEvents();
    this.updateView();
  }

  // 开启"点击画布放置"模式：下一次画布点击（非拖拽）会调用 callback(worldX, worldY)
  armPlaceMode(callback) {
    this._placeMode = true;
    this._placeCallback = callback;
    this.canvas.parentElement.style.cursor = 'crosshair';
  }

  cancelPlaceMode() {
    this._placeMode = false;
    this._placeCallback = null;
    this.canvas.parentElement.style.cursor = 'grab';
  }

  // 两指间距（用于捏合缩放的相对倍率），不足两指返回 0
  _pinchDist() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  // 画布可视区域的 CSS 像素尺寸——与 offsetX/offsetY 同一套坐标系
  // （ThreeRenderer.resize 按父容器 getBoundingClientRect 算，这里保持同口径；
  // renderer 不存在时——无 WebGL 的降级路径——退回自己量一次）。
  _viewSize() {
    if (this.renderer?.width && this.renderer?.height) {
      return { w: this.renderer.width, h: this.renderer.height };
    }
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    return { w: rect?.width || window.innerWidth, h: rect?.height || window.innerHeight };
  }

  // 用户："目前视角放大是聚焦于左上角进行放大的。正确放大应该是聚焦于窗口中心。"
  // 根因：所有缩放入口（滚轮/±按钮/滑杆/双指捏合）过去只改 this.zoom，offsetX/offsetY
  // 原地不动——而 screen = offset + world*zoom 这套变换里，offsetX/offsetY 对应的正是
  // 世界坐标原点在屏幕上的落点，缩放不改它就等于"永远绕世界原点缩放"，画面看起来就是
  // 死死地朝左上角（或当前 pan 到的那个点）聚焦，跟画布中心毫无关系。
  // 做法：缩放前先反算"当前画布中心对应哪个世界坐标"（syncCameraFrom 用的就是这同一个
  // 公式，见 ThreeRenderer 头注），缩放后把 offsetX/offsetY 重新配平，让那个世界坐标
  // 仍然落在画布中心——视觉上就是"以画面中心为锚点缩放"。
  _zoomAt(newZoom) {
    const { w: W, h: H } = this._viewSize();
    const z0 = this.zoom || 1;
    const wx = (W / 2 - this.offsetX) / z0;
    const wy = (H / 2 - this.offsetY) / z0;
    this.zoom = Math.max(0.15, Math.min(3.0, newZoom));
    this.offsetX = W / 2 - wx * this.zoom;
    this.offsetY = H / 2 - wy * this.zoom;
  }

  setupEvents() {
    const wrap = this.canvas.parentElement;

    // 平板适配：改用 Pointer Events（鼠标/触摸/触控笔统一走同一套事件），
    // 不再需要区分 mouse/touch 写两份逻辑。拖拽/点选/放置模式核心逻辑不变，
    // 只是坐标来源从 mousedown/mousemove/mouseup 换成 pointerdown/move/up，
    // 且用 setPointerCapture 代替"监听 window"来接住画布外的移动/抬起。
    this._pointers = new Map(); // pointerId -> {x, y}，用于识别双指捏合
    this._pinch = null;         // {startDist, startZoom}

    // Safari 的双指缩放走独立的 GestureEvent（非标准，仅 WebKit），不经过
    // touch/pointer 事件流，touch-action:none 管不到它——必须单独拦截，
    // 否则 iPad Safari 上仍会缩放整个网页而不是画布内容。
    wrap.addEventListener('gesturestart', (e) => e.preventDefault());
    wrap.addEventListener('gesturechange', (e) => e.preventDefault());
    wrap.addEventListener('gestureend', (e) => e.preventDefault());

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 触摸/触控笔的 button 恒为 0，与鼠标左键判断天然兼容
      // 事件来自悬浮层（选中面板/缩放按钮/性能HUD）时完全忽略：
      // 否则 pointerdown 启动拖拽、pointerup 触发点选命中，点面板按钮会被画布逻辑抢先处理
      if (e.target !== this.canvas) return;
      wrap.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size === 2) {
        // 第二根手指落下：从单指拖拽切到双指捏合缩放，记录初始指距与起始 zoom
        this.isDragging = false;
        this.dragMoved = true; // 已进入多指手势，抬指时绝不能再当作点选
        this._pinch = { startDist: this._pinchDist(), startZoom: this.zoom };
        return;
      }
      if (this._pointers.size > 2) return; // 三指及以上不处理，忽略即可

      this.isDragging = true;
      this.dragMoved = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartOffsetX = this.offsetX;
      this.dragStartOffsetY = this.offsetY;
      if (!this._placeMode) wrap.style.cursor = 'grabbing';
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size === 2 && this._pinch) {
        const dist = this._pinchDist();
        if (dist > 0 && this._pinch.startDist > 0) {
          const scale = dist / this._pinch.startDist;
          this._zoomAt(this._pinch.startZoom * scale);
          this.updateView();
        }
        return;
      }

      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true;
      if (this._placeMode) return; // 放置模式下不拖动视角，避免误触
      // v2.5D 第4步：3D 下世界 Z 在屏幕上被压缩 sin(仰角)，纵向要反除回去才跟手（横向无压缩）
      const ky = this.view3d?.active() ? this.view3d.panScaleY() : 1;
      // C 组·方位角：偏航后把屏幕拖拽量按方位角旋转到世界对齐的 offset 增量，拖拽仍跟手。
      // az=0 时 ca=1/sa=0 → 退化为原来的直接赋值，无偏航行为逐像素不变。
      //
      // v51.6 修复：用户报"改变方位后，视角的拖拽乱了，不是按照当前的视角进行拖拽
      // 计算的，还是按照原先的视角"。旧公式 (mdx*ca − mdy*sa, mdx*sa + mdy*ca) 的
      // 旋转方向和 ThreeRenderer.syncCameraFrom 里相机绕目标的站位方向正好相反
      // ——两处各自实现了一份"方位角怎么转"，方向没对上，是本仓库常见的"同一件事
      // 两处实现"那类坑。按 syncCameraFrom 的真实几何重新推一遍：
      //   相机相对目标的站位 ∝ (sin(az), cos(az))（该函数里 cam.position 那行），
      //   于是屏幕右方向在世界 XZ 里是 (cos(az), −sin(az))，屏幕下方向是
      //   (sin(az), cos(az))（az=0 时分别退化为 +X / +Z，与旧公式的退化基准一致，
      //   已用 0°/90°/180°/270° 四个整角逐一手工验证过，见 sim_visual.mjs）。
      //   世界坐标平移量 = −(screen方向) × 拖拽量（"抓住地面拖"的直觉：鼠标右移，
      //   目标点要往屏幕右方向的反方向挪，画面内容才会跟着鼠标往右走）。
      //   换算成 offsetX/offsetY（tx=(W/2−offsetX)/zoom 是线性反比关系）之后就是
      //   下面这两行——与旧公式相比，两个交叉项的符号都翻了过来。
      const az = ((this.renderer?.azimuthDeg || 0) * Math.PI) / 180;
      const ca = Math.cos(az), sa = Math.sin(az);
      const mdx = dx, mdy = dy * ky;
      this.offsetX = this.dragStartOffsetX + (mdx * ca + mdy * sa);
      this.offsetY = this.dragStartOffsetY + (mdy * ca - mdx * sa);
      this.updateView();
    });

    const endPointer = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;

      if (this._pointers.size === 1) {
        // 双指捏合中松开一根：用剩下那根手指的当前位置重新起算单指拖拽，
        // 避免因起点还停留在松开的那根手指位置上而发生画面跳变
        const p = [...this._pointers.values()][0];
        this.isDragging = true;
        this.dragMoved = true; // 前面已经是手势操作，抬起剩余手指不应触发点选
        this.dragStartX = p.x;
        this.dragStartY = p.y;
        this.dragStartOffsetX = this.offsetX;
        this.dragStartOffsetY = this.offsetY;
        return;
      }

      if (this._pointers.size === 0 && this.isDragging) {
        this.isDragging = false;
        // 放置模式下：视为一次点击（未明显拖动）则放置
        if (this._placeMode && !this.dragMoved) {
          const world = this.screenToWorld(e.clientX, e.clientY);
          const cb = this._placeCallback;
          this.cancelPlaceMode();
          if (cb) cb(world.x, world.y);
        } else if (!this._placeMode && !this.dragMoved) {
          // 点选单位（LoL 式）：命中最近的单位，回调 onSelect；点空地则清除选中
          this._handleSelectClick(e.clientX, e.clientY);
          wrap.style.cursor = 'grab';
        } else {
          wrap.style.cursor = this._placeMode ? 'crosshair' : 'grab';
        }
      }
    };
    wrap.addEventListener('pointerup', endPointer);
    wrap.addEventListener('pointercancel', endPointer);

    wrap.addEventListener('wheel', (e) => {
      if (e.target !== this.canvas) return; // 面板内滚动是滚面板，不是缩放画布
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      this._zoomAt(this.zoom + delta);
      this.updateView();
    }, { passive: false });

    // Q12：🎯 = 重置视角为【整个地图的视角】（原来是重置到 zoom=1.0 的左上角，
    // 在 3552 的世界里只能看到一小块，等于没用）。
    // 追加需求："缩放，视角角度，东南西北等所有的都重置，不光重置缩放"——原来这里
    // 只调 fitToWorld（只碰 zoom/offset），俯仰角/方位角是用户之前调过就一直留着的。
    // 这既不符合"重置"这个词该有的语义，也是"重置后地图看起来还是很小"的一半根因：
    // 如果之前把俯仰角压得很低，fitToWorld 算出来的缩放是照着那个歪视角凑的，
    // 观感自然不对。这里先把俯仰角/方位角都归位到出厂默认（45°/正北），再算适配缩放。
    // elevSlider/azimSlider 的滑杆位置与文字标签由 main.js 的 applyElev/applyAzim 维护
    // （监听各自的 'input' 事件）——这里用 dispatchEvent 复用那份逻辑，不在这个类里
    // 另起一份"角度怎么换算成东南西北文字"的重复实现。
    document.getElementById('resetViewBtn').addEventListener('click', () => {
      if (this.renderer) {
        const elevSl = document.getElementById('elevSlider');
        if (elevSl) { elevSl.value = String(CAM_ELEVATION_DEG); elevSl.dispatchEvent(new Event('input', { bubbles: true })); }
        const azimSl = document.getElementById('azimSlider');
        if (azimSl) { azimSl.value = '0'; azimSl.dispatchEvent(new Event('input', { bubbles: true })); }
        // 新增的视角高度也是"重置视角"要归位的一部分——"所有的都重置，不光重置缩放"，
        // 这条不是加了才想起来补的特例，是同一条规则自然覆盖的第三个滑杆。
        const lookHeightSl = document.getElementById('lookHeightSlider');
        if (lookHeightSl) { lookHeightSl.value = '0'; lookHeightSl.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      const map = this.mapSystem?.currentMap;
      if (map?.world) {
        this.fitToWorld(map.world.w, map.world.h);
      } else {
        this.zoom = 1.0; this.offsetX = 0; this.offsetY = 0; this.updateView(); // 防御性兜底：地图理论上不会未加载
      }
    });

    document.getElementById('zoomInBtn').addEventListener('click', () => {
      this._zoomAt(this.zoom + 0.1);
      this.updateView();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      this._zoomAt(this.zoom - 0.1);
      this.updateView();
    });
    // v51.6：缩放行统一成【图标】【−】【滑杆】【+】【🎯】的形状，缩放原来只有
    // −/+ 两个按钮、没有滑杆——现在补上，updateView() 里一并把滑杆值同步回去，
    // 不管是拖滑杆、点 −/+、滚轮还是双指捏合，四条路径最终都收敛到这一处同步。
    const zoomSl = document.getElementById('zoomSlider');
    if (zoomSl) {
      zoomSl.addEventListener('input', () => {
        this._zoomAt(Number(zoomSl.value) || 1);
        this.updateView();
      });
    }

    // 全屏按钮：浏览器出于安全策略要求“用户手势”才能进全屏，无法在页面加载时
    // 自动触发——这也是没装 PWA 时唯一能收起地址栏的办法。按钮态跟随实际全屏状态，
    // 同时监听 fullscreenchange（系统手势退出全屏时，比如安卓返回键，图标要跟着变回来）。
    const fsBtn = document.getElementById('fullscreenBtn');
    if (fsBtn) {
      const syncFsIcon = () => {
        fsBtn.textContent = document.fullscreenElement ? '🗗' : '⛶';
        fsBtn.title = document.fullscreenElement ? '退出全屏' : '全屏（收起浏览器地址栏）';
      };
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen?.();
        } else {
          (document.documentElement.requestFullscreen?.() || Promise.reject())
            .catch(() => { /* 部分浏览器不支持或被拒绝，静默失败即可，不影响其它功能 */ });
        }
      });
      document.addEventListener('fullscreenchange', syncFsIcon);
      syncFsIcon();
    }
  }

  // 相机自适应：把 worldW×worldH 的世界完整装进当前画布（留 5% 边距）。
  // 对战模式加载地图时调用——世界 3552×3552，默认 zoom=1 只能看到左上角一小块，
  // 必须自动缩放到全图，否则每次进对战模式都要手动缩放拖拽。
  fitToWorld(worldW, worldH) {
    // v51.6 修复：用户报"点完重置视角按钮后，实际显示的大小还是很小，应该根据当前
    // 窗口自适应"。renderer.width/height 平时靠 window resize 事件被动更新——如果
    // 画布容器尺寸是因为别的原因变化的（比如某个面板开关改变了布局，而不是浏览器
    // 窗口本身缩放），resize 事件根本不会触发，这两个字段就停在旧值上，"重置视角"
    // 算出来的缩放于是照着一个过时的、可能偏小的画布尺寸走。这里先主动 resize()
    // 一次拿到当前真实尺寸，"重置视角"这种不追求高频的操作调一次没有性能顾虑。
    this.renderer?.resize?.();
    const w = this.renderer?.width, h = this.renderer?.height;
    if (!w || !h || !worldW || !worldH) return;
    // 追加需求排查："点完重置视角后，这个地图看起来还是很小。" 除了上面调用方那半
    // （俯仰角/方位角没跟着重置）之外，这里的公式本身也有漏洞：世界的 Z 深度轴在
    // 当前俯仰角下会先乘 sin(elevationDeg) 才映射到屏幕像素（见 ThreeRenderer.
    // syncCameraFrom 头注的推导："屏幕偏移 = ((px-tx)*z, (pz-tz)*sin(p)*z)"——X 轴
    // 没有这个因子，Z 轴有）。原来 h / worldH 等于假装俯仰角是 90°（正俯视，
    // sin=1），默认 45° 视角下 sin(45°)≈0.707，Z 方向实际能塞进屏幕的世界范围比
    // 这个式子算出来的大了 1/0.707≈1.41 倍——"全图适配"因此永远比真正能达到的
    // 缩放更保守。X 轴的 offsetX 推导本来就不含 sinP（下面这行不用改），只有
    // zoom 这一行需要补上这个因子。
    const sinP = Math.max(0.05, Math.sin((this.renderer?.elevationDeg ?? 45) * Math.PI / 180));
    this.zoom = Math.min(w / worldW, h / (worldH * sinP)) * 0.95;
    this.offsetX = (w - worldW * this.zoom) / 2;
    this.offsetY = (h - worldH * this.zoom) / 2;
    // Q11：记住"全图缩放"，渲染器据此做【相对】LOD 判断——
    // 不同尺寸的地图，"全图视角"对应的绝对缩放值本就不同，LOD 阈值必须相对它。
    this._fitZoom = this.zoom;
    if (this.renderer) this.renderer._fitZoom = this.zoom;
    this.updateView();
  }

  // 点选命中检测：屏幕坐标 → 世界坐标，在附近实体中找"距离-命中半径"最小者。
  // 命中半径 = 单位显示半径 + 缩放补偿（缩得越小、手指/鼠标容差越大，最少 8px 世界距离）。
  _handleSelectClick(clientX, clientY) {
    if (!this.onSelect) return;
    const ents = this.renderer?.entities;
    if (!ents) return;
    const world = this.screenToWorld(clientX, clientY);
    const slack = Math.max(8, 10 / this.zoom);
    let best = null, bestScore = Infinity;
    const consider = (e) => {
      if (!e.pos) return;
      const r = e.type === 'tower'
        ? (this.renderer?.getBuildingSize ? this.renderer.getBuildingSize(e) : 28)
        : (this.renderer?.getMinionSize ? this.renderer.getMinionSize(e) : 10);
      const d = Math.hypot(e.pos.x - world.x, e.pos.y - world.y) - r;
      if (d <= slack && d < bestScore) { bestScore = d; best = e; }
    };
    // Q3：一次查询搞定活体 + 静态障碍（塔废墟 / 待重生水晶）。
    // 网格现在也索引这两类（见 EntityContainer.rebuildGridIfNeeded），
    // 所以 aliveOnly=false 终于是真的了，原来那段"必须单独全量扫描幽灵"的兜底已删。
    // 死亡的塔同样可选中 —— 选中后可在属性编辑器里查看/改属性、改阵营、复活或击杀。
    for (const e of ents.findInRadius(world.x, world.y, 80 + slack, null, false)) {
      if (e.alive || e._ruin || e._respawnAt) consider(e);
    }
    if (best) this.onSelect(best.id);
    else if (this.onDeselect) this.onDeselect(); // Q3 回调：点空地重新恢复"关闭面板"行为
  }

  updateView() {
    if (this.renderer) {
      this.renderer.viewZoom = this.zoom;
      this.renderer.viewOffsetX = this.offsetX;
      this.renderer.viewOffsetY = this.offsetY;
    }
    // v51.6：#zoomLabel（百分比读数）已删除，用户定稿"视角大小不需要数值，放重置
    // 视角按钮"。缩放滑杆本身要跟着 this.zoom 同步——不只是拖滑杆自己触发的那次
    // input 事件，−/+按钮、滚轮、双指捏合、fitToWorld() 改的 zoom 都要能反映到
    // 滑杆位置上，不然滑杆会停在原地不跟手。
    const zoomSl = document.getElementById('zoomSlider');
    if (zoomSl && Number(zoomSl.value) !== this.zoom) zoomSl.value = String(this.zoom);
  }

  screenToWorld(screenX, screenY) {
    // 屏幕→世界 = "射线打 y=0 地面平面"，不是平面反算。
    // 命中逻辑（_handleSelectClick）在世界坐标里工作，故无需任何改动。
    // 射线与地面平行等退化情形返回 null，此时落到下方平面反算兜底，绝不把 null 传下去。
    if (this.view3d?.active()) {
      const w3 = this.view3d.screenToWorld(screenX, screenY);
      if (w3) return w3;
    }
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width / window.devicePixelRatio;
    const scaleY = this.canvas.height / rect.height / window.devicePixelRatio;
    const canvasX = (screenX - rect.left) * scaleX;
    const canvasY = (screenY - rect.top) * scaleY;
    return {
      x: (canvasX - this.offsetX) / this.zoom,
      y: (canvasY - this.offsetY) / this.zoom,
    };
  }
}