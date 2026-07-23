/**
 * CanvasController —— 视口与输入控制（第 5 步后驱动 WebGL 画布）
 *
 * 类名保留不改：它控制的仍然是一个 <canvas> 元素，只是内容从 2D 上下文换成了 WebGL。
 * 改名会波及 sim_v24 的两条源码文本断言（测试改动需单独报批），收益仅为字面美观。
 *
 * this.renderer 现在指向 ThreeRenderer（无 WebGL 时为 null，故所有访问都带保护）。
 * 视口状态（zoom/offsetX/offsetY）的唯一来源仍在本类，渲染器每帧从这里读。
 */
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

  setupEvents() {
    const wrap = this.canvas.parentElement;

    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 事件来自悬浮层（选中面板/缩放按钮/性能HUD）时完全忽略：
      // 否则 mousedown 启动拖拽、mouseup 触发点选命中，点面板按钮会被画布逻辑抢先处理
      if (e.target !== this.canvas) return;
      this.isDragging = true;
      this.dragMoved = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartOffsetX = this.offsetX;
      this.dragStartOffsetY = this.offsetY;
      if (!this._placeMode) wrap.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true;
      if (this._placeMode) return; // 放置模式下不拖动视角，避免误触
      // v2.5D 第4步：3D 下世界 Z 在屏幕上被压缩 sin(仰角)，纵向要反除回去才跟手（横向无压缩）
      const ky = this.view3d?.active() ? this.view3d.panScaleY() : 1;
      // C 组·方位角：偏航后把屏幕拖拽量按方位角旋转到世界对齐的 offset 增量，拖拽仍跟手。
      // az=0 时 ca=1/sa=0 → 退化为原来的直接赋值，无偏航行为逐像素不变。
      const az = ((this.renderer?.azimuthDeg || 0) * Math.PI) / 180;
      const ca = Math.cos(az), sa = Math.sin(az);
      const mdx = dx, mdy = dy * ky;
      this.offsetX = this.dragStartOffsetX + (mdx * ca - mdy * sa);
      this.offsetY = this.dragStartOffsetY + (mdx * sa + mdy * ca);
      this.updateView();
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) {
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
    });

    wrap.addEventListener('wheel', (e) => {
      if (e.target !== this.canvas) return; // 面板内滚动是滚面板，不是缩放画布
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      this.zoom = Math.max(0.15, Math.min(3.0, this.zoom + delta));
      this.updateView();
    }, { passive: false });

    // Q12：🎯 = 重置视角为【整个地图的视角】（原来是重置到 zoom=1.0 的左上角，
    // 在 3552 的世界里只能看到一小块，等于没用）。
    document.getElementById('resetViewBtn').addEventListener('click', () => {
      const map = this.mapSystem?.currentMap;
      if (map?.world) {
        this.fitToWorld(map.world.w, map.world.h);
      } else {
        this.zoom = 1.0; this.offsetX = 0; this.offsetY = 0; this.updateView(); // 沙盒模式：无地图
      }
    });

    document.getElementById('zoomInBtn').addEventListener('click', () => {
      this.zoom = Math.min(3.0, this.zoom + 0.1);
      this.updateView();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      this.zoom = Math.max(0.15, this.zoom - 0.1);
      this.updateView();
    });
  }

  // 相机自适应：把 worldW×worldH 的世界完整装进当前画布（留 5% 边距）。
  // 对战模式加载地图时调用——世界 3552×3552，默认 zoom=1 只能看到左上角一小块，
  // 必须自动缩放到全图，否则每次进对战模式都要手动缩放拖拽。
  fitToWorld(worldW, worldH) {
    const w = this.renderer?.width, h = this.renderer?.height;
    if (!w || !h || !worldW || !worldH) return;
    this.zoom = Math.min(w / worldW, h / worldH) * 0.95;
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
    // 活体：走空间网格
    for (const e of ents.findInRadius(world.x, world.y, 80 + slack, null, true)) consider(e);
    // Q4：等待重生的召唤水晶幽灵（alive=false + _respawnAt）也要能点选查看属性。
    // 必须单独扫描——空间网格【只索引活体】（rebuildGridIfNeeded 里 `if (!e.alive) continue`），
    // 所以给 findInRadius 传 aliveOnly=false 是空头支票，永远拿不到幽灵。这就是"点不到"的根因。
    // 幽灵数量极少（最多每方三路），全量扫描零性能负担。
    for (const e of ents.getAllTowers(false)) {
      if (!e.alive && e._respawnAt) consider(e);
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
    document.getElementById('zoomLabel').textContent = Math.round(this.zoom * 100) + '%';
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