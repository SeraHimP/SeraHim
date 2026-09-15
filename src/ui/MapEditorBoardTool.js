/**
 * MapEditorBoardTool.js —— 地图编辑器：直接在主 3D 画面上编辑（阶段四）。
 *
 * 用户定稿："地图编辑器（笔刷）最好是直接在显示的画板上直接刷而不是单独弄个窗口
 * （你目前这个也保留）……弄个那种地形编辑/塔位编辑那种工具栏，里面有笔刷，移动，
 * 添加塔等工具"。这是与 MapEditorDialog.js（独立 2D 俯视弹窗）**并列**的第二个入口，
 * 两者共享同一份草稿（见 mapEditorSession.js）——在这里画一笔，弹窗打开时看得见；
 * 弹窗里存的档，这里刷新后也是同一份数据。
 *
 * ==================== 三个交互决策（都问过用户，不是自己猜的） ====================
 * ① 建筑标记：直接拖真实塔模型（entityContainer 里的 tower 实体），不是另画一个
 *    扁平标记点。好处是所见即所得；代价是要接触真实实体——拖动时直接改
 *    entity.pos.x/y（UnitLayer 每帧按 entity.pos 画，改了就跟着动，不用碰渲染代码），
 *    松手后把最终位置同步回草稿（session.draftBuildings）。
 * ② 地形笔刷：拖动期间只在屏幕空间画半透明笔刷轨迹（不重建真实地形——
 *    ThreeRenderer._rebuildTerrain() 单次就要重算约 148×148 顶点的地面网格 + 重烘焙
 *    贴图，per-frame 调用扛不住），松开手才把整笔画的位图变化提交真地形、触发一次
 *    真正的重建。
 * ③ 入口：新增一个独立按钮（#mapEditorBoardBtn，紧挨着弹窗入口 #mapEditorBtn），
 *    两个入口并列存在，谁都不替代谁。
 *
 * ==================== 为什么用一块独立的透明 overlay，不直接监听 canvasWrap ====================
 * #glCanvas 所在的 wrap（#canvasWrap）已经被 CanvasController 绑了一整套
 * pointerdown/move/up（相机拖拽/缩放、_placeMode 单击选位、_handleSelectClick 点选
 * 单位）。工具激活时如果直接在同一个元素上再叠一份监听，两边的处理器会同时跑——
 * 拖一座塔的同时相机也在跟着拖，或者点一下同时触发了游戏内选中面板，谁都理不清。
 * 这正是 MapEditorDialog.js 头注里"一个东西被迫做两件不相关的事"的同一类坑。
 * 改用一块绝对定位、覆盖在 #glCanvas 之上的透明 `<div>`（内嵌一块 2D `<canvas>`
 * 专画笔刷轨迹反馈）：工具关闭时 `pointer-events:none`，事件穿透到下面正常玩游戏；
 * 工具打开时 `pointer-events:auto`，浏览器的事件命中测试会把指针事件派给最上层的
 * 这块 overlay，CanvasController 自己那套监听根本收不到事件——零改动、零冲突，
 * 和弹窗当年"改用独立 canvas、不碰 CanvasController"是同一个思路的主画面版。
 *
 * ==================== 结构性变化 vs 连续交互：什么时候真正同步 ====================
 * - 挪动一座已有塔：拖动中直接改 entity.pos（零延迟跟手），松手后写回草稿——
 *   不需要 syncLiveMap()，场上那座塔本来就是"真塔"，位置变了它自己就在新位置。
 * - 添加一座新塔：调 MapSystem.addBuildingLive()（现场造一座，不清场重建），
 *   同时把这条建筑描述追加进 session.draftBuildings，两边保持一致。
 * - 地形笔刷：拖动中只画屏幕空间轨迹反馈，松手时 commitTerrainLive()（改
 *   currentMap.navgrid + 失效地形缓存，不清场——地形变化不影响已经造好的塔）。
 * 三种情况都不需要整份 syncLiveMap()（那是"清场重建全部塔"的重活）——
 * 唯一需要它的时机是**工具刚激活、场上还没有任何与草稿对应的塔**的那一次。
 */
import { CTX } from '../core/GameContext.js';
import { CONFIG } from '../data/Config.js';
import { paintCircle } from '../data/navgrid.js';
import { snapBuildingPos, freeBuildingPos, autoDetectTiers } from '../data/mapEditorCore.js';
import {
  ensureSession, getSession, syncLiveMap, commitTerrainLive,
} from './mapEditorSession.js';

const FAC_COLOR = { blue: '#4a9eff', red: '#ff5a5a' };   // 与 UIManager.js 的 FAC_DOT 同一套配色

export const MapEditorBoardTool = {
  _active: false,
  _tool: 'brush',        // 'brush' | 'move' | 'add'
  _brushMode: 'draw',     // 'draw' | 'erase'（同弹窗）
  _brushRadius: null,     // 现算，见 enable()（软编码默认值）
  _faction: 'blue',       // 'add' 工具用：新塔归哪一方
  _deps: null,            // { mapSystem, renderer3d, canvasController, entityContainer, logFn }
  _painting: false,
  _strokePoints: [],      // 本次拖动画过的屏幕点（用于结束时重播成真实笔刷）
  _draggingEntity: null,  // 'move' 工具正在拖的真实塔实体
  _entityToIndex: null,   // Map<entityId, draftBuildings下标>，syncLiveMap/addBuildingLive 后维护
  _pausedBefore: false,   // enable() 时进来之前的暂停状态，disable() 时恢复成这个值

  /** 打开工具条（deps 见上）。已经开着时相当于把工具条带到最新状态。 */
  enable(deps) {
    this._deps = deps;
    // 编辑时游戏不运行：进工具条就暂停，退出恢复成进来之前的暂停状态。
    // 只在【从关到开】这一刻记一次"进来之前是不是已经暂停着"——enable() 在已经开着时
    // 还会被调用（头注"已经开着时相当于把工具条带到最新状态"），此时 CTX.gamePaused
    // 已经是我们自己强制置的 true，再记一次会把"进来之前"的原始状态覆盖掉。
    if (!this._active) this._pausedBefore = CTX.gamePaused;
    CTX.gamePaused = true;
    this._brushRadius = CONFIG.mapEditor.brushRadiusGridDefault;
    const session = ensureSession(deps.mapSystem);
    this._buildOverlay();
    // 首次激活：场上还没有任何与草稿对应的塔，整份同步一次（见文件头注）。
    if (this._needsInitialSync(session)) {
      syncLiveMap(deps.mapSystem, deps.renderer3d);
      this._rebuildIndexAfterSync(session);
    } else {
      this._entityToIndex = this._entityToIndex || new Map();
    }
    this._active = true;
    this._render();
    this._setOverlayInteractive(true);
  },

  /** 关闭工具条：草稿留着（下次开工具条或打开弹窗都还在），只是不再拦截主画面输入。 */
  disable() {
    this._active = false;
    this._painting = false;
    this._draggingEntity = null;
    this._setOverlayInteractive(false);
    this._clearStrokeVisual();
    CTX.gamePaused = this._pausedBefore;
    const panel = document.getElementById('mapEditorBoardToolbar');
    if (panel) panel.remove();
  },

  toggle(deps) {
    if (this._active) this.disable();
    else this.enable(deps);
  },

  /** 场上当前地图是否已经是这份草稿的实时版本（见文件头注"什么时候才整份同步"）。 */
  _needsInitialSync(session) {
    const cur = this._deps.mapSystem.currentMap;
    return !cur || cur.id !== session.__liveId;
  },

  /** syncLiveMap 之后，按创建顺序把场上塔与 draftBuildings 下标一一对上。
   * 依据：MapSystem.loadMap() 是 `for (const b of map.buildings)` 顺序建塔，
   * 与 syncLiveMap 存进去的 buildings 数组（=draftBuildings）逐位对应；
   * 实体 id 是 ++_uid 单调递增分配的，按 id 排序就还原了创建顺序。 */
  _rebuildIndexAfterSync(session) {
    const towers = this._deps.entityContainer.getAllTowers(false).slice().sort((a, b) => a.id - b.id);
    this._entityToIndex = new Map();
    towers.forEach((e, i) => { if (session.draftBuildings[i]) this._entityToIndex.set(e.id, i); });
    session.__liveId = this._deps.mapSystem.currentMap?.id;
  },

  // ==================== 覆盖层 DOM ====================
  _buildOverlay() {
    let ov = document.getElementById('mapEditorBoardOverlay');
    if (!ov) {
      const wrap = document.getElementById('canvasWrap');
      ov = document.createElement('canvas');
      ov.id = 'mapEditorBoardOverlay';
      // ⚠️ background:transparent 必须显式写：CSS 里 `#canvasWrap canvas` 这条规则
      // （给 3D 画布用的）会连坐到这块新画布上，塞一个不透明的深色背景——不显式盖掉的话
      // 这块 overlay 会变成一块完全遮住 3D 场景（以及 HUD）的黑幕，笔刷轨迹画不画都看不出来。
      ov.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:50;'
        + 'touch-action:none;cursor:crosshair;background:transparent;';
      wrap.appendChild(ov);
      this._bindOverlayEvents(ov);
    }
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    ov.width = rect.width; ov.height = rect.height;
  },

  _setOverlayInteractive(on) {
    const ov = document.getElementById('mapEditorBoardOverlay');
    if (ov) ov.style.pointerEvents = on ? 'auto' : 'none';
  },

  _bindOverlayEvents(ov) {
    ov.addEventListener('pointerdown', (e) => {
      ov.setPointerCapture(e.pointerId);
      if (this._tool === 'brush') { this._painting = true; this._strokePoints = []; this._sampleStroke(e); }
      else if (this._tool === 'move') { this._startDrag(e); }
      else if (this._tool === 'add') { this._addTowerAt(e); }
    });
    ov.addEventListener('pointermove', (e) => {
      if (this._tool === 'brush' && this._painting) this._sampleStroke(e);
      else if (this._tool === 'move' && this._draggingEntity) this._dragTo(e);
    });
    const stop = () => {
      if (this._tool === 'brush' && this._painting) this._commitStroke();
      this._painting = false;
      this._draggingEntity = null;
    };
    ov.addEventListener('pointerup', stop);
    ov.addEventListener('pointercancel', stop);
    ov.addEventListener('pointerleave', stop);
  },

  // ==================== 地形笔刷 ====================
  _sampleStroke(e) {
    this._strokePoints.push({ x: e.clientX, y: e.clientY });
    this._paintStrokeVisual();
  },

  /** 屏幕空间画半透明轨迹（不碰真实地形，见文件头注②）。 */
  _paintStrokeVisual() {
    const ov = document.getElementById('mapEditorBoardOverlay');
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    const rect = ov.getBoundingClientRect();
    ctx.fillStyle = this._brushMode === 'draw' ? 'rgba(120,200,120,.45)' : 'rgba(40,40,50,.55)';
    const r = CONFIG.mapEditor.boardBrushTrailRadiusPx; // 只是视觉粗细，非精确笔刷半径
    for (const p of this._strokePoints) {
      ctx.beginPath();
      ctx.arc(p.x - rect.left, p.y - rect.top, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  _clearStrokeVisual() {
    const ov = document.getElementById('mapEditorBoardOverlay');
    if (!ov) return;
    ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  },

  /** 松手：把整笔轨迹重播成真实笔刷改动，一次性提交地形（见文件头注②）。 */
  _commitStroke() {
    const session = getSession();
    const { mapSystem, canvasController, renderer3d } = this._deps;
    for (const p of this._strokePoints) {
      const world = canvasController.screenToWorld(p.x, p.y);
      const gx = world.x / (session.baseMap.world?.w || 1) * session.n;
      const gy = world.y / (session.baseMap.world?.h || 1) * session.n;
      paintCircle(session.bits, session.n, gx, gy, this._brushRadius, this._brushMode === 'draw');
    }
    this._strokePoints = [];
    this._clearStrokeVisual();
    commitTerrainLive(mapSystem, renderer3d);
  },

  // ==================== 移动已有塔 ====================
  _startDrag(e) {
    const { canvasController, entityContainer } = this._deps;
    const world = canvasController.screenToWorld(e.clientX, e.clientY);
    const slack = Math.max(8, 40 / (canvasController.zoom || 1));
    let best = null, bestD = Infinity;
    for (const t of entityContainer.getAllTowers(true)) {
      const d = Math.hypot(t.pos.x - world.x, t.pos.y - world.y);
      if (d <= slack && d < bestD) { bestD = d; best = t; }
    }
    this._draggingEntity = best;
  },

  _dragTo(e) {
    const session = getSession();
    const { canvasController } = this._deps;
    const world = canvasController.screenToWorld(e.clientX, e.clientY);
    const entity = this._draggingEntity;
    const pos = freeBuildingPos(session.baseMap, world.x, world.y);
    entity.pos.x = pos.x; entity.pos.y = pos.y;
    // 松手前先把草稿也同步上——中途切到弹窗查看时不该看到旧位置。
    const idx = this._entityToIndex?.get(entity.id);
    if (session && idx != null && session.draftBuildings[idx]) {
      session.draftBuildings[idx] = { ...session.draftBuildings[idx], pos: { x: pos.x, y: pos.y } };
    }
  },

  // ==================== 添加新塔 ====================
  _addTowerAt(e) {
    const session = getSession();
    const { mapSystem, canvasController } = this._deps;
    const world = canvasController.screenToWorld(e.clientX, e.clientY);
    // 就近吸附到离点击点最近的那条路（跨全部 lane 找最近投影点）。
    const lanes = session.baseMap.lanes || [];
    let bestLane = null, bestD = Infinity, bestPos = world;
    for (const lane of lanes) {
      const near = snapBuildingPos(session.baseMap, { laneId: lane.id }, world.x, world.y);
      const d = Math.hypot(near.x - world.x, near.y - world.y);
      if (d < bestD) { bestD = d; bestLane = lane.id; bestPos = near; }
    }
    if (!bestLane) return;
    // 先给个占位档位（'inner'），插入草稿后立刻按位置自动识别——新塔在链里该是
    // 外/内/水晶防御塔完全取决于它落在哪，不用用户自己选（用户定稿"自动识别为主"）。
    const draft = { faction: this._faction, tier: 'inner', laneId: bestLane, pos: bestPos, weapon: 'piercing' };
    session.draftBuildings = autoDetectTiers(session.baseMap, [...session.draftBuildings, draft]);
    const added = session.draftBuildings[session.draftBuildings.length - 1];
    const entity = mapSystem.addBuildingLive(added);
    if (entity) {
      this._entityToIndex.set(entity.id, session.draftBuildings.length - 1);
      this._deps.logFn?.(`➕ 已在${this._faction === 'blue' ? '蓝方' : '红方'}${bestLane}路添加一座塔`, 'spawn');
    }
    this._updateStatus();
  },

  // ==================== 工具条 UI ====================
  _render() {
    let panel = document.getElementById('mapEditorBoardToolbar');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mapEditorBoardToolbar';
      panel.className = 'hud-panel';
      panel.style.cssText = 'position:absolute;left:12px;top:12px;z-index:60;padding:8px;display:flex;flex-direction:column;gap:6px;max-width:220px;';
      document.getElementById('canvasWrap').appendChild(panel);
    }
    panel.innerHTML = `
      <div style="display:flex;gap:4px;">
        <button class="icon-btn ${this._tool === 'brush' ? 'primary' : ''}" id="mbtToolBrush" title="地形笔刷">🖌️</button>
        <button class="icon-btn ${this._tool === 'move' ? 'primary' : ''}" id="mbtToolMove" title="移动建筑">✥</button>
        <button class="icon-btn ${this._tool === 'add' ? 'primary' : ''}" id="mbtToolAdd" title="添加塔">➕</button>
        <button class="icon-btn" id="mbtClose" title="关闭">✖</button>
      </div>
      ${this._tool === 'brush' ? `
      <div style="display:flex;gap:4px;">
        <button class="icon-btn ${this._brushMode === 'draw' ? 'primary' : ''}" id="mbtBrushDraw" title="画可走">🟩</button>
        <button class="icon-btn ${this._brushMode === 'erase' ? 'primary' : ''}" id="mbtBrushErase" title="擦不可走">⬛</button>
        <input id="mbtBrushRadius" type="range" min="${CONFIG.mapEditor.brushRadiusGridMin}" max="${CONFIG.mapEditor.brushRadiusGridMax}" value="${this._brushRadius}" style="flex:1;">
      </div>` : ''}
      ${this._tool === 'add' ? `
      <div style="display:flex;gap:4px;">
        <button class="icon-btn ${this._faction === 'blue' ? 'primary' : ''}" id="mbtFacBlue" title="蓝方">🔵</button>
        <button class="icon-btn ${this._faction === 'red' ? 'primary' : ''}" id="mbtFacRed" title="红方">🔴</button>
      </div>` : ''}
      <div id="mbtStatus" style="font-size:10px;color:var(--text-mute);"></div>
    `;
    document.getElementById('mbtToolBrush').addEventListener('click', () => { this._tool = 'brush'; this._render(); });
    document.getElementById('mbtToolMove').addEventListener('click', () => { this._tool = 'move'; this._render(); });
    document.getElementById('mbtToolAdd').addEventListener('click', () => { this._tool = 'add'; this._render(); });
    document.getElementById('mbtClose').addEventListener('click', () => this.disable());
    document.getElementById('mbtBrushDraw')?.addEventListener('click', () => { this._brushMode = 'draw'; this._render(); });
    document.getElementById('mbtBrushErase')?.addEventListener('click', () => { this._brushMode = 'erase'; this._render(); });
    document.getElementById('mbtBrushRadius')?.addEventListener('input', (e) => {
      this._brushRadius = Number(e.target.value) || CONFIG.mapEditor.brushRadiusGridDefault;
    });
    document.getElementById('mbtFacBlue')?.addEventListener('click', () => { this._faction = 'blue'; this._render(); });
    document.getElementById('mbtFacRed')?.addEventListener('click', () => { this._faction = 'red'; this._render(); });
    this._updateStatus();
  },

  _updateStatus() {
    const el = document.getElementById('mbtStatus');
    if (!el) return;
    const hint = { brush: '按住拖动画地形，松手生效', move: '拖动一座塔即可移动', add: '点一下就近落在最近的路上' };
    el.textContent = hint[this._tool] || '';
  },
};
