/**
 * MapEditorDialog.js —— 地图编辑器阶段三 MVP：navgrid 笔刷 + 保存/加载
 *
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.2/§3.5/§6 阶段三，任务 #109/#113~#116。
 *
 * ==================== 为什么用独立的俯视 2D 画布，不叠加在 3D 场景上 ====================
 * §3.1 原始设计设想"叠加在现有渲染层上的一个模式"，交互复用 CanvasController 现有的
 * `armPlaceMode` 选位机制。但 `armPlaceMode` 只支持单次点击回调（见 CanvasController.js
 * pointerup 里 `if (this._placeMode && !this.dragMoved)` 那段），笔刷需要的是"按住拖动
 * 期间持续采样世界坐标"——这不是回调形状不够、是它管理的那套状态机（isDragging/
 * dragMoved/_pinch 双指缩放/方位角旋转换算……）整个是为"相机拖拽 vs 单击选位/建塔"
 * 这两件事服务的，硬塞第三种"拖动=连续笔刷采样"的语义进去，等于让一份状态机同时说
 * 三件不同的事——这正是 docs/DEVELOPMENT.md 反复点名的"同一件事被迫做成两种不同的东西"
 * 那类坑的镜像版本（这次是反过来，一个东西被迫做两件不相关的事）。
 *
 * 改用一块完全独立的 `<canvas>`（本文件自己创建、自己绑事件、自己画像素），
 * 与 CanvasController/ThreeRenderer 零交互面：笔刷画的是内存里的 Uint8Array，
 * 不碰 Three.js 场景，"所见即所得"降级成"画完存下、存完可以一键加载预览"——
 * 用户仍然能在同一会话里马上看到笔刷效果套上真实地形渲染，只是不是逐笔实时的。
 * 真正的"笔刷所见即所得叠加在 3D 场景上"留给设计报告阶段四/五做（那时候再决定
 * 是重新设计 CanvasController 的多模式状态机，还是继续用独立画布叠一层半透明 overlay
 * ——现在数据还没稳定，不必现在就把交互框架焊死）。
 *
 * ==================== 本次范围 ====================
 * 做：navgrid 圆形笔刷（画/擦）、折线造墙笔刷（点选顶点连成带状墙体，画/擦通用）、
 *     去毛刺（清理孤立噪点/1格尖刺）、建筑拖拽摆放（吸附兵线 + 实时校验红线）、
 *     区域参数表单（基地圈半径、龙坑/男爵坑中心+半径，画布半透明预览）、
 *     兵路径编辑（路点拖动/点空白插入/删除，整条路增删，见下方"路径编辑"一节）、
 *     克隆已有地图作为起点、保存到 CONFIG.customMaps、加载预览、删除自制地图。
 * 不做（设计报告后续阶段）：高度笔刷（用户明确定稿暂缓）。
 *
 * ==================== 路径编辑为什么放在建筑摆放之后单独做 ====================
 * map.lanes 不只是画面上一条线——LaneMovementSystem/LaneWaveSystem 靠它算小兵怎么走，
 * mapEditorCore.js 的 snapBuildingPos 靠它算建筑吸附点，mapValidate.js 的间距/对称
 * 校验也全部读它。改动面比"往 navgrid 位图上刷格子"或"挪一座建筑"都大，所以放在
 * 地形笔刷/建筑摆放/区域参数表单全部做完、摸清了这套"克隆草稿→改草稿→随
 * buildCustomMapPayload 落盘"的模式确实稳之后再做，而不是一开始就跟建筑摆放混在一起改。
 * `draftMapForValidate()` 现在把 `lanes: draftLanes` 一起传出去——路径编辑模式改了路点后，
 * 建筑摆放模式的吸附/校验必须立刻读到新路径，不能还拿着编辑前的 baseMap.lanes 判定，
 * 否则会出现"编辑器里两个模式对同一条路的认知不一致"这种编辑器自己制造的 bug。
 *
 * ==================== 建筑摆放为什么复用同一块画布，不叠一层 overlay ====================
 * 地形笔刷和建筑摆放【互斥使用同一块画布区域】而不是两块画布叠放：叠放需要绝对定位、
 * 需要在"地形模式下点击穿透到下层画布、建筑模式下拦截点击"之间来回切 pointer-events，
 * 徒增一层状态要跟地形笔刷的 painting 状态保持同步。改成一个 editMode 开关
 * （'terrain'|'buildings'）决定 redrawCanvas() 多画一层建筑标记、
 * 决定 pointer 事件是拖笔刷还是拖建筑，两种模式的状态天然不会同时存在。
 */
import { paneHtml } from './dialogShell.js';
import { CTX } from '../core/GameContext.js';
import { CONFIG } from '../data/Config.js';
import { paintCircle, paintPolyline, despeckle } from '../data/navgrid.js';
import { imageToNavgrid } from '../data/imageImport.js';
import { STRUCT_TIERS, RULE_FIELDS, compositionFor, whenOptionGroups } from '../data/waveComposition.js';
import { baseCircleCenter } from '../data/baseCircle.js';
import {
  decodeBaseBits, buildCustomMapPayload, cloneBuildingsForEdit,
  freeBuildingPos, withBuildingMoved, validateDraftMap, autoDetectTiers,
  cloneRegionsForEdit, defaultPitFor,
  cloneLanesForEdit, withWaypointMoved, withWaypointInserted, withWaypointRemoved,
  withLaneAdded, withLaneRemoved, laneBuildingCount, nearestSegmentIndex,
  cloneFactionsForEdit, withFactionAdded, withFactionRemoved, pruneMapDataForRemovedFaction,
  withRuleAdded, withRuleRemoved, withRuleMoved, withRuleFieldSet,
  cloneNeutralCampsForEdit, withCampSpawnPointFieldSet, withCampSpawnPointAdded, withCampSpawnPointRemoved,
} from '../data/mapEditorCore.js';
import { allMinionTypes, minionLabel, minionIcon } from '../data/customContent.js';
import { NEUTRAL_UNIT_TYPES } from '../systems/NeutralCampSystem.js';

const FAC_COLOR = { blue: '#4a9eff', red: '#ff5a5a' };   // 与 UIManager.js 的 FAC_DOT 同一套配色

// 画布 CSS 显示尺寸（正方形）；内部像素分辨率=n，靠 image-rendering:pixelated 放大不糊边。
// 用户："窗口做的大一些"——地图编辑器弹窗改用单独的 .modal-box.mapEditorWide 尺寸变体
// （960px 而不是全局默认的 620px 上限，见 index.html），画布跟着放大到 560。
// 560 仍留出边距：960 宽的弹窗还要塞下画布右侧"笔刷模式/半径/保存"这些常用控件，
// 不能整个宽度都给画布。
const CANVAS_DISPLAY_PX = 560;

export const MapEditorDialog = {
  open(deps, logFn) {
    const { mapSystem, renderer3d } = deps;
    // 编辑时游戏不运行：进弹窗就暂停，退出恢复成进来之前的暂停状态
    // （不是无脑续玩——你进来之前手动暂停着，出去也该还是暂停）。
    const _pausedBefore = CTX.gamePaused;
    CTX.gamePaused = true;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalBox').classList.add('mapEditorWide');
    document.getElementById('modalTitle').textContent = '🗺️✏️ 地图编辑器（地形笔刷 + 建筑摆放）';

    // ---------- 编辑状态（整个弹窗生命周期内持续，只有切换起点地图才重置） ----------
    let baseId = mapSystem.currentBaseMapId || mapSystem.getAvailableMaps()[0]?.id;
    let baseMap = mapSystem.getMapById(baseId);
    let { n, bits } = decodeBaseBits(baseMap);
    let brushMode = 'draw';   // 'draw'=画可走 | 'erase'=擦成不可走
    let brushShape = 'circle';   // 'circle'=圆形笔刷（拖动连续画） | 'polyline'=折线造墙（点选顶点，完成后一次性画）
    let brushRadius = CONFIG.mapEditor.brushRadiusGridDefault;   // 圆形半径 / 折线半宽，共用同一个值和同一条滑杆
    let polylinePoints = [];      // 折线造墙模式下已点选的顶点（格子坐标）
    let polylineHover = null;     // 鼠标当前位置（格子坐标）——画"橡皮筋"预览线用，不是真正的顶点
    let painting = false;
    let statusMsg = '';
    let editMode = 'terrain';           // 'terrain'=地形笔刷 | 'buildings'=建筑摆放
    let draftBuildings = cloneBuildingsForEdit(baseMap);
    let draggingBuildingIndex = -1;
    let selectedBuildingIndex = -1;     // 点选一座建筑后可在下方手动改档位（覆盖自动识别）
    let draftRegions = cloneRegionsForEdit(baseMap);   // 区域参数草稿：{baseCircleRadius, pits:{baron?,dragon?}}
    let draftLanes = cloneLanesForEdit(baseMap);        // 路径编辑（阶段六）草稿：[{id, waypoints:[{x,y}...]}]
    let selectedLaneId = draftLanes[0]?.id ?? null;     // 当前正在编辑哪条路
    let draggingWaypointIndex = -1;
    let selectedWaypointIndex = -1;                     // 点选一个路点后可在下方"删除选中路点"

    // ---- 配置模式（第四节 Part A）：阵营管理 + 出兵开关，见 mapEditorCore.js 对应函数头注 ----
    let draftFactions = cloneFactionsForEdit(baseMap);        // ['blue','red',...]
    let draftSpawnEnabled = { ...(baseMap.spawnEnabled || {}) };  // {[兵种]: boolean}，未声明=默认开

    // ---- 配置模式（第四节 Part B）：出兵编排，按路独立，见 mapEditorCore.js "出兵编排" 节头注 ----
    // 稀疏表：只有被在这个面板里打开过的路才有 key（"打开=开始编辑这条路的独立编排"，
    // 没打开过的路继续读共享基准，不会因为看了一眼就被存成一份跟基准一模一样的覆写——
    // 除了已经打开过之后：那之后哪怕没真的改动也会按当前值存下去，这是刻意接受的
    // 简化，见 renderWaveOrderPanel 头注）。
    let draftLaneComposition = { ...(baseMap.laneWaveCompositionByLane || {}) };
    // 广播规则（v51.33，技能触发）不在这一批的编辑范围内（见头注），但也不能因为
    // 打开这条路编辑就把它们弄丢——从共享基准里摘出来的广播规则原样存这里，
    // 保存时原样拼回去，不参与本面板任何编辑操作。
    let draftLaneBroadcast = {};
    let selectedWaveLaneId = draftLanes[0]?.id ?? null;
    let draggingRuleIndex = -1;

    // ---- 配置模式（第四节 Part D）：中立营地，见 mapEditorCore.js "中立营地" 节头注 ----
    let draftNeutralCamps = cloneNeutralCampsForEdit(baseMap);
    let neutralCampStatus = '';

    // ---- 图片自动识别导入（第四节，见 src/data/imageImport.js 头注） ----
    let imgImportOpen = false;         // 是否展开这个子面板
    let imgImportImageData = null;     // 原图整份像素（{data,width,height}），只存在内存里，不进 HTML
    let imgImportSrcDisplayW = 0, imgImportSrcDisplayH = 0;   // 原图预览画布的显示像素尺寸（等比缩放后）
    let imgImportSampleColor = null;   // 用户点选的"可走"参考色 {r,g,b}
    let imgImportTolerancePct = CONFIG.mapEditor.imageImportTolerancePctDefault;
    let imgImportResult = null;        // 最近一次算出的 {n,bits}，供"应用"按钮落盘

    const isCustomMap = (id) => !!(CONFIG.customMaps && CONFIG.customMaps[id]);
    // 校验只关心结构（lanes/world/walls/useNavgrid）+ 当前草稿建筑，navgrid 笔刷改的
    // 地形位图跟这套结构性规则无关，不需要把 bits 也塞进去。
    // ⚠️ lanes 必须用 draftLanes（草稿）不是 baseMap.lanes（原始）——路径编辑模式改动
    // 路点之后，建筑摆放模式的吸附/校验如果还读原始 lanes，会拿着"编辑前的路"去吸附/
    // 校验"编辑后的路应该在的位置"，两边就对不上了。
    const draftMapForValidate = () => ({ ...baseMap, buildings: draftBuildings, lanes: draftLanes });

    // ---------- 画布：只重画像素，不重建 DOM（拖动期间每帧都会调，必须轻量） ----------
    const redrawCanvas = () => {
      const canvas = document.getElementById('mapEditorCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(n, n);
      for (let i = 0; i < n * n; i++) {
        const o = i * 4;
        if (bits[i]) { img.data[o] = 206; img.data[o + 1] = 224; img.data[o + 2] = 188; img.data[o + 3] = 255; } // 可走：浅草绿
        else { img.data[o] = 46; img.data[o + 1] = 48; img.data[o + 2] = 56; img.data[o + 3] = 255; }             // 不可走：深灰
      }
      ctx.putImageData(img, 0, 0);
      drawRegionOverlays(ctx);
      if (editMode === 'terrain' && brushShape === 'polyline') drawPolylinePreview(ctx);
      if (editMode === 'buildings') drawBuildingMarkers(ctx);
      if (editMode === 'paths') drawLanePaths(ctx);
    };

    // ---------- 图片自动识别导入：算一遍识别结果（不碰 DOM，纯数据） ----------
    // 目标分辨率固定用当前草稿的 n——识别结果要能直接换掉 bits，两者必须同一个格子数，
    // 不然还要另外一步"重采样对齐"，没必要把这一步的复杂度也加进来。
    const recomputeImgImportPreview = () => {
      if (!imgImportImageData || !imgImportSampleColor) { imgImportResult = null; return; }
      // 容差滑杆是 0~100 的百分比，imageToNavgrid 要的是 RGB 欧氏距离（0~441.7，
      // 255×√3 是 RGB 立方体对角线长度）——换算公式见 Config.js 里这个字段旁边的注释。
      const tolerance = (imgImportTolerancePct / 100) * 441.7;
      imgImportResult = imageToNavgrid(imgImportImageData, { n, sampleColor: imgImportSampleColor, tolerance });
    };

    // ---------- 图片自动识别导入：重绘原图/结果两块预览画布 ----------
    const redrawImgImportPreview = () => {
      const src = document.getElementById('mapEditorImgImportSrcCanvas');
      if (src && imgImportImageData) {
        const sctx = src.getContext('2d');
        sctx.clearRect(0, 0, src.width, src.height);
        // 用一块临时画布持有原图原始像素，再整体缩放画到显示尺寸——getImageData 拿到的
        // 是 ImageData 对象，不能直接 drawImage，得先 putImageData 到同尺寸的画布上。
        const full = document.createElement('canvas');
        full.width = imgImportImageData.width; full.height = imgImportImageData.height;
        full.getContext('2d').putImageData(imgImportImageData, 0, 0);
        sctx.drawImage(full, 0, 0, src.width, src.height);
        if (imgImportSampleColor) {
          sctx.fillStyle = `rgb(${imgImportSampleColor.r},${imgImportSampleColor.g},${imgImportSampleColor.b})`;
          sctx.strokeStyle = '#fff'; sctx.lineWidth = 2;
          sctx.fillRect(4, 4, 16, 16); sctx.strokeRect(4, 4, 16, 16); // 左上角画一块取样色小样块
        }
      }
      const prev = document.getElementById('mapEditorImgImportPreviewCanvas');
      if (prev && imgImportResult) {
        const pctx = prev.getContext('2d');
        const img = pctx.createImageData(imgImportResult.n, imgImportResult.n);
        for (let i = 0; i < imgImportResult.bits.length; i++) {
          const o = i * 4;
          if (imgImportResult.bits[i]) { img.data[o] = 206; img.data[o + 1] = 224; img.data[o + 2] = 188; img.data[o + 3] = 255; }
          else { img.data[o] = 46; img.data[o + 1] = 48; img.data[o + 2] = 56; img.data[o + 3] = 255; }
        }
        pctx.putImageData(img, 0, 0);
      }
      // 应用按钮的 disabled 是 render() 整页重渲时按当时的 imgImportResult 写死的一次性属性；
      // 取样/拖动容差这两条走的是轻量更新（不调 render()，避免弹窗重渲的画布/输入框状态被打断），
      // 不在这里手动同步就会一直卡在"识别结果已经算出来了，按钮却还是灰的"——
      // 跟 updatePathStatus() 同步删除路点按钮 disabled 状态是同一类问题、同一种修法。
      const applyBtn = document.getElementById('mapEditorImgImportApplyBtn');
      if (applyBtn) applyBtn.disabled = !imgImportResult;
    };

    // 路径编辑（阶段六）：画全部路（未选中的路淡色，方便看出彼此的相对位置），
    // 选中的路加粗高亮，路点画成小圆点，被选中/正在拖动的路点额外描白边。
    const LANE_COLOR = ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#8338ec'];
    const drawLanePaths = (ctx) => {
      draftLanes.forEach((lane, li) => {
        const isSel = lane.id === selectedLaneId;
        const color = LANE_COLOR[li % LANE_COLOR.length];
        ctx.strokeStyle = color;
        ctx.globalAlpha = isSel ? 1 : 0.35;
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.beginPath();
        lane.waypoints.forEach((wp, i) => {
          const { gx, gy } = worldToGrid(wp.x, wp.y);
          if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
        });
        ctx.stroke();
        if (isSel) {
          lane.waypoints.forEach((wp, i) => {
            const { gx, gy } = worldToGrid(wp.x, wp.y);
            const highlighted = i === draggingWaypointIndex || i === selectedWaypointIndex;
            ctx.beginPath();
            ctx.arc(gx, gy, highlighted ? 4 : 2.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            if (highlighted) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
          });
        }
        ctx.globalAlpha = 1;
      });
    };

    // ---- 出兵编排（第四节 Part B）：地图缩略图画兵线，点线选路 ----
    // 复用地形笔刷同一套地形画法 + drawLanePaths 同一套配色/坐标换算（worldToGrid），
    // 只是选中态换成 selectedWaveLaneId（这个面板自己的"正在编哪条路"，跟路径编辑
    // 模式的 selectedLaneId 是两件独立的事——你可能在编 A 路的地形路点，同时想看
    // B 路的出兵编排）。
    const drawWaveLaneThumbnail = () => {
      const canvas = document.getElementById('mapEditorWaveThumb');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(n, n);
      for (let i = 0; i < n * n; i++) {
        const o = i * 4;
        if (bits[i]) { img.data[o] = 206; img.data[o + 1] = 224; img.data[o + 2] = 188; img.data[o + 3] = 255; }
        else { img.data[o] = 46; img.data[o + 1] = 48; img.data[o + 2] = 56; img.data[o + 3] = 255; }
      }
      ctx.putImageData(img, 0, 0);
      draftLanes.forEach((lane, li) => {
        const isSel = lane.id === selectedWaveLaneId;
        ctx.strokeStyle = LANE_COLOR[li % LANE_COLOR.length];
        ctx.globalAlpha = isSel ? 1 : 0.4;
        ctx.lineWidth = isSel ? 3 : 1.5;
        ctx.beginPath();
        lane.waypoints.forEach((wp, i) => {
          const { gx, gy } = worldToGrid(wp.x, wp.y);
          if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
        });
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    };

    /** 点到线段的最短距离（缩略图点选最近的路用）——纯几何，跟哪条路无关。 */
    const pointToSegmentDist = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };

    /** 缩略图上离 (gx,gy) 最近的那条路的 id——点选用。 */
    const nearestLaneAtGridPoint = (gx, gy) => {
      let best = null, bestDist = Infinity;
      for (const lane of draftLanes) {
        for (let i = 0; i < lane.waypoints.length - 1; i++) {
          const a = worldToGrid(lane.waypoints[i].x, lane.waypoints[i].y);
          const b = worldToGrid(lane.waypoints[i + 1].x, lane.waypoints[i + 1].y);
          const d = pointToSegmentDist(gx, gy, a.gx, a.gy, b.gx, b.gy);
          if (d < bestDist) { bestDist = d; best = lane.id; }
        }
      }
      return best;
    };

    /**
     * 第一次真正编辑某条路的出兵队列时，把它从"继承共享基准"挪成"这条路自己的
     * 草稿"——只看一眼、没做任何改动的路不会被这一步碰到（调用点全部在会真的
     * 改数组的那几个事件处理器里，不在渲染/选中路径那几处）。
     * 广播规则（kind:'broadcast'，见 waveComposition.js v51.33）不在这批编辑范围内，
     * 摘出来单独存一份、原样带回保存结果，不参与这里任何增删拖拽。
     */
    const ensureWaveDraft = (laneId) => {
      if (draftLaneComposition[laneId]) return;
      const full = compositionFor(null, CONFIG.gameRules, laneId);
      draftLaneComposition[laneId] = full.filter(r => r.type);
      draftLaneBroadcast[laneId] = full.filter(r => r.kind === 'broadcast');
    };

    const renderRuleCard = (r, i, whenGroups) => {
      const whenDef = whenGroups.flatMap(g => g.items).find(it => it.value === (r.when || ''));
      return `
        <div class="wave-rule-card" draggable="true" data-rule-index="${i}"
          style="display:flex;align-items:center;gap:6px;padding:4px 6px;margin-bottom:4px;flex-wrap:wrap;
                 border:1px solid var(--border-color,#444);border-radius:4px;background:rgba(255,255,255,0.03);">
          <span style="cursor:grab;color:var(--text-mute);" title="拖动调整出兵顺序">⠿</span>
          <select data-rule-field="type" data-rule-index="${i}" style="width:88px;">
            ${allMinionTypes().map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${minionIcon(t)} ${minionLabel(t)}</option>`).join('')}
          </select>
          ${Object.entries(RULE_FIELDS).map(([k, meta]) => `
          <label style="font-size:10px;color:var(--text-mute);display:flex;align-items:center;gap:2px;">
            ${meta.label}
            <input type="number" data-rule-field="${k}" data-rule-index="${i}" min="${meta.min}" step="${meta.step}"
              value="${r[k] ?? meta.def}" style="width:42px;">
          </label>`).join('')}
          <select data-rule-field="when" data-rule-index="${i}" style="flex:1;min-width:90px;">
            ${whenGroups.map(g => `<optgroup label="${g.label}">
              ${g.items.map(it => `<option value="${it.value}" ${it.value === (r.when || '') ? 'selected' : ''}>${it.label}</option>`).join('')}
            </optgroup>`).join('')}
          </select>
          ${whenDef?.arg ? `
          <input type="number" data-rule-field="whenArg" data-rule-index="${i}" title="${whenDef.arg.label}"
            min="${whenDef.arg.min}" step="${whenDef.arg.step}" value="${r.whenArg ?? whenDef.arg.def}" style="width:56px;">` : ''}
          <button data-rule-remove="${i}" style="font-size:11px;padding:2px 6px;">✖</button>
        </div>`;
    };

    const renderWaveOrderPanel = () => {
      const laneId = selectedWaveLaneId;
      const overridden = !!draftLaneComposition[laneId];
      const rules = draftLaneComposition[laneId]
        || compositionFor(null, CONFIG.gameRules, laneId).filter(r => r.type);
      const whenGroups = whenOptionGroups();
      return `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-color,#444);">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">出兵编排（按路独立）</div>
        <div style="font-size:10px;color:var(--text-mute);margin-bottom:6px;">
          点缩略图上的一条路（或用下拉选）选中要编的路，拖卡片"⠿"调整出兵顺序。
          技能广播规则（v51.33）暂不支持在这里编辑——已有的会原样保留，不受这里的改动影响，
          要改请去全局的"出兵编排"页。
        </div>
        <div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start;">
          <canvas id="mapEditorWaveThumb" width="${n}" height="${n}"
            style="width:170px;height:170px;image-rendering:pixelated;cursor:pointer;flex-shrink:0;
                   border:1px solid var(--border-color,#444);border-radius:4px;"></canvas>
          <div style="flex:1;">
            <select id="mapEditorWaveLaneSelect" style="width:100%;padding:4px;margin-bottom:6px;">
              ${draftLanes.map(l => `<option value="${l.id}" ${l.id === laneId ? 'selected' : ''}>${l.id}${draftLaneComposition[l.id] ? '（已覆写）' : ''}</option>`).join('')}
            </select>
            <div style="font-size:11px;color:var(--text-mute);">
              ${overridden ? '✏️ 这条路已有独立编排，会存进这张图。' : '↩️ 当前继承共享基准（还没改过这条路）。'}
            </div>
            ${overridden ? `<button id="mapEditorWaveClearBtn" style="margin-top:4px;font-size:11px;">🧹 清除覆写，改回继承</button>` : ''}
          </div>
        </div>
        <div id="mapEditorWaveRuleList">
          ${rules.map((r, i) => renderRuleCard(r, i, whenGroups)).join('')
            || '<div style="font-size:11px;color:var(--text-mute);">这条路目前没有任何出兵规则。</div>'}
        </div>
        <button id="mapEditorWaveAddRuleBtn" style="margin-top:4px;">➕ 新增规则</button>
      </div>`;
    };

    // ---- 中立营地（第四节 Part D）：出生地/出生路径可配，骨架目前只有巨龙接了生成器 ----
    const renderSpawnPointRow = (campId, sp, idx, total) => {
      const resolved = sp.pit || (sp.pitRef ? mapSystem.getPit?.(sp.pitRef) : null) || {};
      return `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
        <span style="font-size:10px;color:var(--text-mute);width:16px;">#${idx + 1}</span>
        <label style="font-size:10px;display:flex;align-items:center;gap:2px;">X
          <input type="number" data-camp-id="${campId}" data-sp-index="${idx}" data-sp-field="x" value="${resolved.x ?? ''}" style="width:64px;"></label>
        <label style="font-size:10px;display:flex;align-items:center;gap:2px;">Y
          <input type="number" data-camp-id="${campId}" data-sp-index="${idx}" data-sp-field="y" value="${resolved.y ?? ''}" style="width:64px;"></label>
        <label style="font-size:10px;display:flex;align-items:center;gap:2px;">路
          <select data-camp-id="${campId}" data-sp-index="${idx}" data-sp-field="laneMatch" style="width:72px;">
            ${draftLanes.map(l => `<option value="${l.id}" ${l.id === sp.laneMatch ? 'selected' : ''}>${l.id}</option>`).join('')}
          </select></label>
        <label style="font-size:10px;display:flex;align-items:center;gap:2px;">方向
          <select data-camp-id="${campId}" data-sp-index="${idx}" data-sp-field="direction" style="width:78px;">
            <option value="forward" ${sp.direction === 'forward' ? 'selected' : ''}>forward</option>
            <option value="reverse" ${sp.direction === 'reverse' ? 'selected' : ''}>reverse</option>
          </select></label>
        ${sp.pitRef ? `<span style="font-size:9px;color:var(--text-mute);" title="还没手动改过坐标，跟着 ${sp.pitRef} 坑位走">继承${sp.pitRef}坑</span>` : ''}
        <button data-camp-remove-sp="${campId}:${idx}" ${total <= 1 ? 'disabled' : ''} title="删除这个出生点" style="font-size:10px;padding:0 4px;">✖</button>
      </div>`;
    };
    const renderCampCard = (camp) => `
      <div style="border:1px solid var(--border-color,#444);border-radius:4px;padding:6px;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:600;margin-bottom:4px;">${NEUTRAL_UNIT_TYPES[camp.unitType]?.label || camp.unitType}（${camp.id}）</div>
        ${camp.spawnPoints.map((sp, i) => renderSpawnPointRow(camp.id, sp, i, camp.spawnPoints.length)).join('')}
        <button data-camp-add-sp="${camp.id}" style="font-size:10px;">➕ 新增出生点</button>
      </div>`;
    const renderNeutralCampsPanel = () => `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-color,#444);">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">中立营地</div>
        <div style="font-size:10px;color:var(--text-mute);margin-bottom:6px;">
          每个营地是一个中立单位类型的出生配置：在哪（坐标）/走哪条路/往哪个方向。
          目前只有巨龙接了真正的生成逻辑（一直存在的元素/远古轮换、龙魂这些机制不动，
          这里只管它在这张图上从哪出生），其它单位类型是留给以后的骨架，编辑器里还选不了。
        </div>
        ${draftNeutralCamps.map(renderCampCard).join('')}
        <div id="mapEditorNeutralCampStatus" style="font-size:11px;color:var(--text-mute);margin-top:4px;">${neutralCampStatus}</div>
      </div>`;

    // 折线造墙：画布坐标系就是 navgrid 的 n×n 格子坐标系（与其它重绘函数一致），
    // 点选顶点时直接存格子坐标，这里不需要再做世界↔格子的换算。
    const drawPolylinePreview = (ctx) => {
      if (!polylinePoints.length) return;
      ctx.strokeStyle = brushMode === 'draw' ? '#78c878' : '#ff5a5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      polylinePoints.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      if (polylineHover) ctx.lineTo(polylineHover.x, polylineHover.y);   // 橡皮筋：预览"再点一下会连到哪"
      ctx.stroke();
      polylinePoints.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#ffd700' : '#fff';   // 起点用金色区分，方便确认闭合/走向
        ctx.fill();
      });
    };

    // 区域参数（阶段四剩余）：基地圈半径 + 龙坑/男爵坑画成半透明预览圈，两种编辑模式下
    // 都画（不像建筑标记那样只在 buildings 模式画）——这几个数值改起来影响的是整张地图的
    // 地形观感，笔刷模式下也需要看见它们在哪，才知道笔刷该往哪画/避开哪。
    const drawRegionOverlays = (ctx) => {
      if (draftRegions.baseCircleRadius) {
        const gr = draftRegions.baseCircleRadius / (baseMap.world?.w || 1) * n;
        for (const fac of ['blue', 'red']) {
          const c = baseCircleCenter(baseMap, fac);
          if (!c) continue;
          const { gx, gy } = worldToGrid(c.x, c.y);
          ctx.beginPath();
          ctx.arc(gx, gy, gr, 0, Math.PI * 2);
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = FAC_COLOR[fac] || '#ccc';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      for (const name of ['baron', 'dragon']) {
        const pit = draftRegions.pits[name];
        if (!pit) continue;
        const { gx, gy } = worldToGrid(pit.x, pit.y);
        const gr = pit.r / (baseMap.world?.w || 1) * n;
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fillStyle = name === 'baron' ? 'rgba(150,80,220,.28)' : 'rgba(255,160,40,.28)';
        ctx.fill();
        ctx.strokeStyle = name === 'baron' ? '#9650dc' : '#ffa028';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    // 建筑标记画在 navgrid 的 n×n 像素坐标系里（与 redrawCanvas 的 putImageData 同一
    // 坐标系），世界坐标按 world.w/world.h 分别换算——与 MapSystem.isWalkable 的
    // "i=x/W.w*n, j=y/W.h*n"用的是同一条换算规则，非正方形世界（如扭曲丛林）也不会错位。
    const worldToGrid = (wx, wy) => ({
      gx: wx / (baseMap.world?.w || 1) * n,
      gy: wy / (baseMap.world?.h || 1) * n,
    });

    const drawBuildingMarkers = (ctx) => {
      // n 随 switchBase() 换起点地图而变（不同地图 navgrid 分辨率不同），标记半径
      // 必须每次重画时用【当前】n 现算，写成挂在外层作用域的 const 会在切图后画错大小。
      const markerR = CONFIG.mapEditor.buildingMarkerRadiusPx / CANVAS_DISPLAY_PX * n;
      const result = validateDraftMap(draftMapForValidate());
      draftBuildings.forEach((b, i) => {
        const { gx, gy } = worldToGrid(b.pos.x, b.pos.y);
        const bad = result.offLaneIds.has(b.id ?? i)
          || result.spacingViolations.some(v => v.faction === b.faction && v.laneId === b.laneId
              && (v.tierA === b.tier || v.tierB === b.tier));
        if (bad) {
          ctx.beginPath();
          ctx.arc(gx, gy, markerR + 3, 0, Math.PI * 2);
          ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(gx, gy, markerR, 0, Math.PI * 2);
        ctx.fillStyle = FAC_COLOR[b.faction] || '#ccc';
        ctx.fill();
        const highlighted = i === draggingBuildingIndex || i === selectedBuildingIndex;
        ctx.lineWidth = highlighted ? 2 : 1;
        ctx.strokeStyle = highlighted ? '#fff' : 'rgba(0,0,0,.5)';
        ctx.stroke();
      });
    };

    const clientToWorld = (canvas, clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const fracX = (clientX - rect.left) / rect.width, fracY = (clientY - rect.top) / rect.height;
      return { x: fracX * (baseMap.world?.w || 0), y: fracY * (baseMap.world?.h || 0) };
    };

    const paintAt = (clientX, clientY) => {
      const canvas = document.getElementById('mapEditorCanvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const gx = (clientX - rect.left) / rect.width * n;
      const gy = (clientY - rect.top) / rect.height * n;
      paintCircle(bits, n, gx, gy, brushRadius, brushMode === 'draw');
      redrawCanvas();
    };

    const findBuildingNear = (canvas, clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return -1;
      const hitPx = CONFIG.mapEditor.buildingHitRadiusPx;
      let best = -1, bestD = hitPx;
      draftBuildings.forEach((b, i) => {
        const px = b.pos.x / (baseMap.world?.w || 1) * rect.width + rect.left;
        const py = b.pos.y / (baseMap.world?.h || 1) * rect.height + rect.top;
        const d = Math.hypot(px - clientX, py - clientY);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    const dragBuildingTo = (clientX, clientY) => {
      if (draggingBuildingIndex < 0) return;
      const canvas = document.getElementById('mapEditorCanvas');
      const world = clientToWorld(canvas, clientX, clientY);
      if (!world) return;
      const pos = freeBuildingPos(draftMapForValidate(), world.x, world.y);
      draftBuildings = withBuildingMoved(draftBuildings, draggingBuildingIndex, pos);
      redrawCanvas();
      updateValidationStatus();
    };

    // 路径编辑（阶段六）：只在【当前选中的那条路】上找最近的路点——不同路之间线段
    // 可能离得很近甚至交叉，命中判定不分路的话，拖着拖着可能拖到另一条路的点上去。
    const findWaypointNear = (canvas, clientX, clientY) => {
      const lane = draftLanes.find(l => l.id === selectedLaneId);
      if (!lane) return -1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return -1;
      const hitPx = CONFIG.mapEditor.buildingHitRadiusPx;   // 复用建筑摆放同一个命中半径，同一种"点选精度"心智模型
      let best = -1, bestD = hitPx;
      lane.waypoints.forEach((wp, i) => {
        const px = wp.x / (baseMap.world?.w || 1) * rect.width + rect.left;
        const py = wp.y / (baseMap.world?.h || 1) * rect.height + rect.top;
        const d = Math.hypot(px - clientX, py - clientY);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    const dragWaypointTo = (clientX, clientY) => {
      if (draggingWaypointIndex < 0 || !selectedLaneId) return;
      const canvas = document.getElementById('mapEditorCanvas');
      const world = clientToWorld(canvas, clientX, clientY);
      if (!world) return;
      const clampX = Math.max(0, Math.min(baseMap.world?.w || 0, world.x));
      const clampY = Math.max(0, Math.min(baseMap.world?.h || 0, world.y));
      draftLanes = withWaypointMoved(draftLanes, selectedLaneId, draggingWaypointIndex, { x: clampX, y: clampY });
      redrawCanvas();
    };

    // 点在选中路的空白处（没命中任何既有路点）：在离点击处最近的那一段中间插入新路点，
    // 插完立刻把它设成"正在拖动"的点——用户点哪就是想在那附近加个弯，允许接着拖精确摆放，
    // 不用"先点插入、再单独点一次去拖"这两步。
    const insertWaypointAt = (clientX, clientY) => {
      const lane = draftLanes.find(l => l.id === selectedLaneId);
      const canvas = document.getElementById('mapEditorCanvas');
      if (!lane || !canvas) return;
      const world = clientToWorld(canvas, clientX, clientY);
      if (!world) return;
      const afterIndex = nearestSegmentIndex(lane.waypoints, world.x, world.y);
      draftLanes = withWaypointInserted(draftLanes, selectedLaneId, afterIndex, world);
      draggingWaypointIndex = afterIndex + 1;
      selectedWaypointIndex = afterIndex + 1;
      redrawCanvas();
    };

    const updatePathStatus = () => {
      // 删除按钮的 disabled 只在 render() 整体重渲时按当时的 selectedWaypointIndex
      // 写死进 HTML；点选/插入路点走的是轻量的 redrawCanvas()（不整体重渲画布下方
      // 这块常用控件区，拖动/点选期间没必要每次都重建整个弹窗 DOM），所以按钮状态
      // 必须在这里手动同步，否则选中了路点、按钮却还停在上一次 render() 时的disabled。
      const btn = document.getElementById('mapEditorDeleteWaypointBtn');
      if (btn) btn.disabled = selectedWaypointIndex < 0;
      const delLaneBtn = document.getElementById('mapEditorDeleteLaneBtn');
      if (delLaneBtn) delLaneBtn.disabled = !selectedLaneId;
      const el = document.getElementById('mapEditorPathStatus');
      if (!el) return;
      const lane = draftLanes.find(l => l.id === selectedLaneId);
      if (!lane) { el.textContent = '还没有任何路，点"新增一条路"开始'; return; }
      el.textContent = `${lane.id} 共 ${lane.waypoints.length} 个路点`
        + (selectedWaypointIndex >= 0 ? `，已选中第 ${selectedWaypointIndex + 1} 个` : '');
    };

    const updateValidationStatus = () => {
      const el = document.getElementById('mapEditorValidationStatus');
      if (!el) return;
      const r = validateDraftMap(draftMapForValidate());
      if (r.ok) { el.textContent = '✅ 结构校验全部通过'; el.style.color = 'var(--text-mute)'; return; }
      const msgs = [];
      if (!r.symmetric) msgs.push('蓝红建筑构成不对称');
      if (r.offLaneIds.size) msgs.push(`${r.offLaneIds.size} 座建筑离开走廊/基地圈`);
      if (r.spacingViolations.length) msgs.push(`${r.spacingViolations.length} 处同阵营塔间距过近`);
      if (r.crossViolations.length) msgs.push('敌我攻击塔射程圈有交集');
      el.textContent = `⚠️ ${msgs.join('；')}`;
      el.style.color = '#ff8080';
    };

    // 点选一座建筑后，在画布下方展示它的档位并允许手动改（覆盖自动识别的结果）。
    // 用户定稿："档位自动识别为主，允许手动覆盖"——这里就是那个"手动覆盖"入口，
    // 独立于画布重绘（每次拖拽/选中都只替换这一小块 DOM，不走整弹窗 render()）。
    const updateSelectionPanel = () => {
      const el = document.getElementById('mapEditorSelectionPanel');
      if (!el) return;
      const b = selectedBuildingIndex >= 0 ? draftBuildings[selectedBuildingIndex] : null;
      if (!b) {
        el.innerHTML = `<div style="font-size:11px;color:var(--text-mute);">点选画布上的一座建筑可查看/手动改它的档位。</div>`;
        return;
      }
      const facLabel = b.faction === 'blue' ? '蓝方' : (b.faction === 'red' ? '红方' : b.faction);
      el.innerHTML = `<div class="slider-row"><label style="width:auto;">${facLabel}${b.laneId ? '/' + b.laneId : ''}：</label>
        <select id="mapEditorTierSelect" style="flex:1;">
          ${STRUCT_TIERS.map(t => `<option value="${t.key}" ${t.key === b.tier ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select></div>`;
      document.getElementById('mapEditorTierSelect').addEventListener('change', (e) => {
        draftBuildings = draftBuildings.map((x, i) => (i === selectedBuildingIndex ? { ...x, tier: e.target.value } : x));
        redrawCanvas();
        updateValidationStatus();
      });
    };

    // 折线模式下把 client 坐标换算成格子坐标——与 paintAt 内联的那行算法一致，
    // 单独抽出来是因为点选顶点、画橡皮筋预览两处都要用，不想抄两遍。
    const clientToGrid = (canvas, clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: (clientX - rect.left) / rect.width * n, y: (clientY - rect.top) / rect.height * n };
    };

    const bindCanvasEvents = () => {
      const canvas = document.getElementById('mapEditorCanvas');
      if (!canvas) return;
      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        if (editMode === 'buildings') {
          draggingBuildingIndex = findBuildingNear(canvas, e.clientX, e.clientY);
          selectedBuildingIndex = draggingBuildingIndex;
          updateSelectionPanel();
          if (draggingBuildingIndex >= 0) dragBuildingTo(e.clientX, e.clientY);
        } else if (editMode === 'paths') {
          const idx = findWaypointNear(canvas, e.clientX, e.clientY);
          if (idx >= 0) { draggingWaypointIndex = idx; selectedWaypointIndex = idx; }
          else insertWaypointAt(e.clientX, e.clientY);
          updatePathStatus();
          redrawCanvas();
        } else if (brushShape === 'polyline') {
          const g = clientToGrid(canvas, e.clientX, e.clientY);
          if (g) { polylinePoints.push(g); updatePolylineStatus(); redrawCanvas(); }
        } else {
          painting = true;
          paintAt(e.clientX, e.clientY);
        }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (editMode === 'buildings') { if (draggingBuildingIndex >= 0) dragBuildingTo(e.clientX, e.clientY); }
        else if (editMode === 'paths') { if (draggingWaypointIndex >= 0) dragWaypointTo(e.clientX, e.clientY); }
        else if (brushShape === 'polyline') { polylineHover = clientToGrid(canvas, e.clientX, e.clientY); redrawCanvas(); }
        else if (painting) paintAt(e.clientX, e.clientY);
      });
      const stop = () => { painting = false; draggingBuildingIndex = -1; draggingWaypointIndex = -1; redrawCanvas(); };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      canvas.addEventListener('pointerleave', stop);
    };

    const updatePolylineStatus = () => {
      const el = document.getElementById('mapEditorPolylineStatus');
      if (el) el.textContent = polylinePoints.length ? `已点选 ${polylinePoints.length} 个顶点` : '点击画布开始造墙';
    };

    // ---------- 配置模式（第四节 Part A）：阵营管理 + 出兵开关 + 快捷跳转 ----------
    // 不用画布——这个模式管的是"这张图声明哪些阵营/哪些兵种能出兵"，不是地形/坐标，
    // 画布留着反而是摆设。地形模板本身仍然是上面"起点地图"选择器决定的（同一个
    // 下拉框两种模式共用，见 render() 顶部注释），这里不重复一份。
    // 塔位/兵线的详细编辑复用已有的"建筑摆放"/"路径编辑"两个模式（这两个模式本来
    // 就已经是通用实现，不因为阵营数变多而需要改），这里只放跳转入口，不重新做一遍。
    const renderConfigModeBody = () => `
      <div style="font-size:11px;color:var(--text-mute);margin-bottom:8px;">
        地形（上面的"起点地图"）与这里的阵营/出兵配置是两层独立的东西——同一份地形可以
        配出不同的打法。塔位用"🏗️ 建筑摆放"编、兵线路径用"🛣️ 路径编辑"编，这两个模式
        已经是通用实现，不用在这里重做一遍。
      </div>
      <div style="margin-bottom:10px;">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">阵营</div>
        ${draftFactions.length > 2 ? '' : `<div style="font-size:10px;color:var(--text-mute);margin-bottom:4px;">至少保留两个阵营才能对战。</div>`}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
          ${draftFactions.map(f => `
            <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border:1px solid var(--border-color,#444);border-radius:4px;font-size:12px;">
              ${f}
              <button data-remove-faction="${f}" ${draftFactions.length <= 2 ? 'disabled' : ''}
                style="font-size:10px;padding:0 4px;line-height:16px;" title="删除该阵营（连带删掉它的建筑，兵线里打向它/由它出发的出兵流也会一并摘掉）">✖</button>
            </span>`).join('')}
        </div>
        <div style="display:flex;gap:6px;">
          <input id="mapEditorNewFactionInput" type="text" placeholder="新阵营 id（如 green）" style="flex:1;">
          <button id="mapEditorAddFactionBtn">➕ 新增阵营</button>
        </div>
        <div id="mapEditorFactionStatus" style="font-size:11px;color:var(--text-mute);margin-top:4px;"></div>
        <div style="font-size:10px;color:var(--text-mute);margin-top:4px;">
          新增阵营的规则判定（索敌/结构校验/记分/出兵目标）已经是通用实现，立即可用；
          单位描边色/小地图光点色暂时会显示成灰色占位（这层泛化不在本批范围内）。
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <button id="mapEditorJumpBuildingsBtn" style="flex:1;">🏗️ 去建筑摆放</button>
        <button id="mapEditorJumpPathsBtn" style="flex:1;">🛣️ 去路径编辑</button>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">出兵开关</div>
        <div style="font-size:10px;color:var(--text-mute);margin-bottom:4px;">
          关掉的兵种这张图不会出兵（两种阵型都不出）。哪一波出什么、出多少，
          在下面"出兵编排"里按路单独调。
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${allMinionTypes().map(t => `
            <label style="display:flex;align-items:center;gap:4px;font-size:12px;border:1px solid var(--border-color,#444);border-radius:4px;padding:2px 6px;">
              <input type="checkbox" data-spawn-enabled="${t}" ${draftSpawnEnabled[t] === false ? '' : 'checked'}>
              ${minionIcon(t)} ${minionLabel(t)}
            </label>`).join('')}
        </div>
      </div>
      ${renderWaveOrderPanel()}
      ${renderNeutralCampsPanel()}`;

    // ---------- 结构性重绘（切起点地图/保存/删除后调用；笔刷拖动期间绝不调这个） ----------
    const render = () => {
      const maps = mapSystem.getAvailableMaps();
      const suggestedId = isCustomMap(baseId) ? baseId : `${baseId}_custom`;
      const suggestedLabel = isCustomMap(baseId) ? baseMap.label : `${baseMap.label}（自制）`;
      const customEntries = Object.values(CONFIG.customMaps || {});

      const body = `
        <div class="editor-section">
          <h4>起点地图</h4>
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
            笔刷改的是地形（navgrid），路径/建筑/技能覆写等其它结构原样克隆自起点地图——
            从零徒手画一张全新地图（路径/出兵点）是后续阶段的事，这一批只做地形。
          </div>
          <select id="mapEditorBaseSelect" style="width:100%;padding:6px;">
            ${maps.map(m => `<option value="${m.id}" ${m.id === baseId ? 'selected' : ''}>${m.label}${isCustomMap(m.id) ? '（自制）' : ''}</option>`).join('')}
          </select>
        </div>

        <div class="editor-section">
          <h4>编辑</h4>
          <div class="slider-row"><label>画布用途</label>
            <div style="display:flex;gap:6px;">
              <button id="mapEditorEditModeTerrain" class="${editMode === 'terrain' ? 'primary' : ''}">🖌️ 地形笔刷</button>
              <button id="mapEditorEditModeBuildings" class="${editMode === 'buildings' ? 'primary' : ''}">🏗️ 建筑摆放</button>
              <button id="mapEditorEditModePaths" class="${editMode === 'paths' ? 'primary' : ''}">🛣️ 路径编辑</button>
              <button id="mapEditorEditModeConfig" class="${editMode === 'config' ? 'primary' : ''}">⚙️ 配置模式</button>
            </div>
          </div>
          ${editMode === 'terrain' ? `
          <div class="slider-row"><label>模式</label>
            <div style="display:flex;gap:6px;">
              <button id="mapEditorModeDraw" class="${brushMode === 'draw' ? 'primary' : ''}">🟩 画（可走）</button>
              <button id="mapEditorModeErase" class="${brushMode === 'erase' ? 'primary' : ''}">⬛ 擦（不可走）</button>
            </div>
          </div>
          <div class="slider-row"><label>笔刷形状</label>
            <div style="display:flex;gap:6px;">
              <button id="mapEditorShapeCircle" class="${brushShape === 'circle' ? 'primary' : ''}">⚪ 圆形（拖动画）</button>
              <button id="mapEditorShapePolyline" class="${brushShape === 'polyline' ? 'primary' : ''}">📐 折线造墙（点选顶点）</button>
            </div>
          </div>
          <div class="slider-row"><label>${brushShape === 'polyline' ? '墙体半宽' : '笔刷半径'}</label>
            <input id="mapEditorBrushSlider" type="range"
              min="${CONFIG.mapEditor.brushRadiusGridMin}" max="${CONFIG.mapEditor.brushRadiusGridMax}"
              value="${brushRadius}" style="flex:1;">
            <span id="mapEditorBrushLabel">${brushRadius} 格</span>
          </div>
          ${brushShape === 'polyline' ? `
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:4px;">
            在画布上依次点选墙体的顶点（金点=起点），移动鼠标能看到下一段的橡皮筋预览；
            点完按"完成造墙"一次性画到地形上（画/擦由上面的"模式"决定），或"取消"放弃这次。
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span id="mapEditorPolylineStatus" style="font-size:11px;color:var(--text-mute);">点击画布开始造墙</span>
            <div style="display:flex;gap:6px;">
              <button id="mapEditorPolylineUndo">↩️ 撤销上一点</button>
              <button id="mapEditorPolylineCancel">✖ 取消</button>
              <button id="mapEditorPolylineCommit" class="primary">✅ 完成造墙</button>
            </div>
          </div>` : ''}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button id="mapEditorDespeckleBtn">🧹 去毛刺</button>
            <span style="font-size:10px;color:var(--text-mute);">清理孤立噪点/1格尖刺，不够干净可以多点几次</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button id="mapEditorImgImportToggle" class="${imgImportOpen ? 'primary' : ''}">🖼️ 导入图片识别地形</button>
          </div>
          ${imgImportOpen ? `
          <div style="border:1px solid var(--border-color,#444);border-radius:4px;padding:8px;margin-bottom:8px;">
            <input id="mapEditorImgImportFile" type="file" accept="image/*" style="margin-bottom:6px;display:block;">
            <div id="mapEditorImgImportStatus" style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
              选一张地图图片，然后点它上面的可行走区域取样颜色。
            </div>
            ${imgImportImageData ? `
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
              <div>
                <div style="font-size:10px;color:var(--text-mute);margin-bottom:2px;">原图（点击取样）</div>
                <canvas id="mapEditorImgImportSrcCanvas" width="${imgImportSrcDisplayW}" height="${imgImportSrcDisplayH}"
                  style="cursor:crosshair;border:1px solid var(--border-color,#444);border-radius:4px;"></canvas>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-mute);margin-bottom:2px;">识别结果预览</div>
                <canvas id="mapEditorImgImportPreviewCanvas" width="${n}" height="${n}"
                  style="width:${imgImportSrcDisplayW}px;height:${imgImportSrcDisplayH}px;image-rendering:pixelated;
                         border:1px solid var(--border-color,#444);border-radius:4px;"></canvas>
              </div>
            </div>
            <div class="slider-row">
              <label>颜色容差</label>
              <input id="mapEditorImgImportTolerance" type="range"
                min="${CONFIG.mapEditor.imageImportTolerancePctMin}" max="${CONFIG.mapEditor.imageImportTolerancePctMax}"
                value="${imgImportTolerancePct}" style="flex:1;">
              <span id="mapEditorImgImportToleranceLabel">${imgImportTolerancePct}%</span>
            </div>` : ''}
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px;">
              <button id="mapEditorImgImportCancelBtn">✖ 取消</button>
              <button id="mapEditorImgImportApplyBtn" class="primary" ${imgImportResult ? '' : 'disabled'}>✅ 应用到当前地形</button>
            </div>
          </div>` : ''}` : editMode === 'buildings' ? `
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:4px;">
            拖动一座建筑可以随意摆放。红圈标出违反结构规则的建筑。
          </div>
          <div id="mapEditorValidationStatus" style="font-size:12px;margin-bottom:4px;"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button id="mapEditorAutoDetectBtn">🔍 自动识别档位</button>
            <span style="font-size:10px;color:var(--text-mute);">离召唤水晶最近=水晶防御塔，最远=外塔，没有路的塔=枢纽防御塔</span>
          </div>
          <div id="mapEditorSelectionPanel" style="margin-bottom:6px;">
            <div style="font-size:11px;color:var(--text-mute);">点选画布上的一座建筑可查看/手动改它的档位。</div>
          </div>` : editMode === 'paths' ? `
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:4px;">
            点一个已有路点=拖动它；点路径上的空白处=在最近的一段中间插入新路点（插完可以
            接着拖精确摆放）。改的是当前选中的这条路——路径改了，建筑摆放模式的"吸附兵线"
            和结构校验会立刻跟着用新的路径判定，两边不会各说各话。
          </div>
          <div class="slider-row"><label>正在编辑</label>
            <select id="mapEditorLaneSelect" style="flex:1;">
              ${draftLanes.map(l => `<option value="${l.id}" ${l.id === selectedLaneId ? 'selected' : ''}>${l.id}（${l.waypoints.length} 点）</option>`).join('')}
            </select>
          </div>
          <div id="mapEditorPathStatus" style="font-size:12px;margin-bottom:4px;color:var(--text-mute);"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button id="mapEditorDeleteWaypointBtn" ${selectedWaypointIndex < 0 ? 'disabled' : ''}>🗑️ 删除选中路点</button>
            <div style="display:flex;gap:6px;">
              <input id="mapEditorNewLaneIdInput" type="text" placeholder="新路 id" style="width:90px;">
              <button id="mapEditorAddLaneBtn">➕ 新增一条路</button>
              <button id="mapEditorDeleteLaneBtn" ${!selectedLaneId ? 'disabled' : ''}>🗑️ 删除整条路</button>
            </div>
          </div>` : ''}
          ${editMode !== 'config' ? `
          <div style="display:flex;justify-content:center;margin:8px 0;">
            <canvas id="mapEditorCanvas" width="${n}" height="${n}"
              style="width:${CANVAS_DISPLAY_PX}px;height:${CANVAS_DISPLAY_PX}px;image-rendering:pixelated;
                     border:1px solid var(--border-color,#444);cursor:crosshair;touch-action:none;border-radius:4px;"></canvas>
          </div>
          <div style="font-size:11px;color:var(--text-mute);text-align:center;">
            ${editMode === 'terrain' ? `按住拖动连续绘制；分辨率 ${n}×${n} 格。`
              : editMode === 'buildings' ? '按住一座建筑拖动即可移动。'
              : '点路点拖动，点空白处插入新路点。'}
          </div>` : renderConfigModeBody()}
        </div>

        <div class="editor-section">
          <h4>区域参数</h4>
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
            基地圈半径决定基地光环范围与高地地形隆起大小（画布上两方各一圈虚线预览）；
            龙坑/男爵坑决定巨龙/男爵刷新点与地形凹陷范围（半透明圆形预览）。
            没有龙坑/男爵坑的地图（如嚎哭深渊/扭曲丛林）可以按需新增。
          </div>
          <div class="slider-row"><label>基地圈半径</label>
            <input id="mapEditorBaseRadiusInput" type="number" min="1" style="flex:1;"
              value="${draftRegions.baseCircleRadius ?? ''}" placeholder="未声明">
          </div>
          ${['baron', 'dragon'].map((name) => {
            const pit = draftRegions.pits[name];
            const label = name === 'baron' ? '男爵坑' : '龙坑';
            return `
            <div class="slider-row"><label>${label}</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;">
                <input type="checkbox" id="mapEditorPit${name}Enable" ${pit ? 'checked' : ''}> 启用
              </label>
            </div>
            ${pit ? `
            <div class="slider-row"><label>　X</label><input id="mapEditorPit${name}X" type="number" value="${pit.x}" style="flex:1;"></div>
            <div class="slider-row"><label>　Y</label><input id="mapEditorPit${name}Y" type="number" value="${pit.y}" style="flex:1;"></div>
            <div class="slider-row"><label>　半径</label><input id="mapEditorPit${name}R" type="number" min="1" value="${pit.r}" style="flex:1;"></div>
            ` : ''}`;
          }).join('')}
        </div>

        <div class="editor-section">
          <h4>保存</h4>
          <div class="slider-row"><label>地图 ID</label>
            <input id="mapEditorIdInput" type="text" value="${suggestedId}" style="flex:1;" ${isCustomMap(baseId) ? 'title="正在编辑已保存的自制地图，保存会覆盖它"' : ''}>
          </div>
          <div class="slider-row"><label>显示名</label>
            <input id="mapEditorLabelInput" type="text" value="${suggestedLabel}" style="flex:1;">
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="mapEditorSaveBtn" class="primary">💾 保存为自制地图</button>
            <span id="mapEditorStatus" style="font-size:12px;color:var(--text-mute);">${statusMsg}</span>
          </div>
        </div>

        ${customEntries.length ? `
        <div class="editor-section">
          <h4>已保存的自制地图</h4>
          <div class="pick-grid">
            ${customEntries.map(m => `
              <div class="pick-card">
                <div class="pick-icon">🗺️</div><div class="pick-label">${m.label}</div>
                <div style="display:flex;gap:4px;margin-top:4px;">
                  <button data-edit-custom-id="${m.id}" title="加载到笔刷继续编辑">✏️</button>
                  <button data-preview-custom-id="${m.id}" title="加载预览（进入对战查看效果）">🔍</button>
                  <button data-del-custom-id="${m.id}" title="删除">🗑️</button>
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}
      `;
      document.getElementById('modalBody').innerHTML = paneHtml({ groups: [], body });
      bindEvents();
      bindCanvasEvents();
      redrawCanvas();
      if (editMode === 'buildings') { updateValidationStatus(); updateSelectionPanel(); }
      if (editMode === 'terrain' && brushShape === 'polyline') updatePolylineStatus();
      if (editMode === 'paths') updatePathStatus();
      if (imgImportOpen && imgImportImageData) redrawImgImportPreview();
      if (editMode === 'config') drawWaveLaneThumbnail();
    };

    const setStatus = (msg) => {
      statusMsg = msg;
      const el = document.getElementById('mapEditorStatus');
      if (el) el.textContent = msg;
    };

    const switchBase = (id) => {
      baseId = id;
      baseMap = mapSystem.getMapById(baseId);
      ({ n, bits } = decodeBaseBits(baseMap));
      draftBuildings = cloneBuildingsForEdit(baseMap);
      selectedBuildingIndex = -1;   // 建筑数组重建了，旧下标不再指向同一座塔
      draftRegions = cloneRegionsForEdit(baseMap);   // 换了起点地图，区域参数草稿也要跟着重来
      polylinePoints = []; polylineHover = null;   // n/bits 重建了，旧顶点的格子坐标不再有意义
      draftLanes = cloneLanesForEdit(baseMap);
      selectedLaneId = draftLanes[0]?.id ?? null;
      draggingWaypointIndex = -1; selectedWaypointIndex = -1;
      draftFactions = cloneFactionsForEdit(baseMap);
      draftSpawnEnabled = { ...(baseMap.spawnEnabled || {}) };
      draftLaneComposition = { ...(baseMap.laneWaveCompositionByLane || {}) };
      draftLaneBroadcast = {};
      selectedWaveLaneId = draftLanes[0]?.id ?? null;
      draggingRuleIndex = -1;
      draftNeutralCamps = cloneNeutralCampsForEdit(baseMap);
      neutralCampStatus = '';
      statusMsg = '';
      render();
    };

    const bindEvents = () => {
      document.getElementById('mapEditorBaseSelect').addEventListener('change', (e) => switchBase(e.target.value));

      document.getElementById('mapEditorEditModeTerrain').addEventListener('click', () => { editMode = 'terrain'; render(); });
      document.getElementById('mapEditorEditModeBuildings').addEventListener('click', () => { editMode = 'buildings'; render(); });
      document.getElementById('mapEditorEditModePaths').addEventListener('click', () => { editMode = 'paths'; render(); });
      document.getElementById('mapEditorEditModeConfig').addEventListener('click', () => { editMode = 'config'; render(); });

      // 配置模式：阵营管理 + 出兵开关 + 跳转（元素只在 editMode==='config' 时存在，
      // 用可选链跳过，同一套 bindEvents() 在别的模式下调用是无害的）。
      document.getElementById('mapEditorJumpBuildingsBtn')?.addEventListener('click', () => { editMode = 'buildings'; render(); });
      document.getElementById('mapEditorJumpPathsBtn')?.addEventListener('click', () => { editMode = 'paths'; render(); });
      document.getElementById('mapEditorAddFactionBtn')?.addEventListener('click', () => {
        const input = document.getElementById('mapEditorNewFactionInput');
        try {
          draftFactions = withFactionAdded(draftFactions, input.value);
          render();
        } catch (err) {
          const el = document.getElementById('mapEditorFactionStatus');
          if (el) el.textContent = `⚠️ ${err.message}`;
        }
      });
      document.querySelectorAll('[data-remove-faction]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.removeFaction;
          try {
            draftFactions = withFactionRemoved(draftFactions, id);
            ({ buildings: draftBuildings, lanes: draftLanes } =
              pruneMapDataForRemovedFaction({ buildings: draftBuildings, lanes: draftLanes }, id));
            selectedBuildingIndex = -1;   // 建筑数组可能被删过元素，旧下标不再可信
            logFn(`🗑️ 已删除阵营「${id}」（连带清理它的建筑与相关出兵流）`, 'spawn');
            render();
          } catch (err) {
            const el = document.getElementById('mapEditorFactionStatus');
            if (el) el.textContent = `⚠️ ${err.message}`;
          }
        });
      });
      document.querySelectorAll('[data-spawn-enabled]').forEach(cb => {
        cb.addEventListener('change', (e) => {
          draftSpawnEnabled[cb.dataset.spawnEnabled] = e.target.checked;
        });
      });

      // 出兵编排（第四节 Part B）：缩略图点线选路 + 下拉选路 + 清除覆写 + 规则卡片
      // 增删/拖拽排序/改字段。元素只在 editMode==='config' 时存在，可选链跳过。
      document.getElementById('mapEditorWaveThumb')?.addEventListener('click', (e) => {
        const g = clientToGrid(e.target, e.clientX, e.clientY);
        if (!g) return;
        const laneId = nearestLaneAtGridPoint(g.x, g.y);
        if (laneId) { selectedWaveLaneId = laneId; render(); }
      });
      document.getElementById('mapEditorWaveLaneSelect')?.addEventListener('change', (e) => {
        selectedWaveLaneId = e.target.value;
        render();
      });
      document.getElementById('mapEditorWaveClearBtn')?.addEventListener('click', () => {
        delete draftLaneComposition[selectedWaveLaneId];
        delete draftLaneBroadcast[selectedWaveLaneId];
        render();
      });
      document.getElementById('mapEditorWaveAddRuleBtn')?.addEventListener('click', () => {
        ensureWaveDraft(selectedWaveLaneId);
        draftLaneComposition[selectedWaveLaneId] = withRuleAdded(draftLaneComposition[selectedWaveLaneId], {
          type: allMinionTypes()[0], count: 1, fromWave: 0, everyN: 1,
        });
        render();
      });
      document.querySelectorAll('[data-rule-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          ensureWaveDraft(selectedWaveLaneId);
          draftLaneComposition[selectedWaveLaneId] =
            withRuleRemoved(draftLaneComposition[selectedWaveLaneId], Number(btn.dataset.ruleRemove));
          render();
        });
      });
      document.querySelectorAll('[data-rule-field]').forEach(el => {
        el.addEventListener('change', (e) => {
          const idx = Number(el.dataset.ruleIndex);
          const field = el.dataset.ruleField;
          const value = (field === 'type' || field === 'when') ? e.target.value : (Number(e.target.value) || 0);
          ensureWaveDraft(selectedWaveLaneId);
          draftLaneComposition[selectedWaveLaneId] =
            withRuleFieldSet(draftLaneComposition[selectedWaveLaneId], idx, field, value);
          // 只有"条件"这一项会改变卡片上要不要多画一个参数输入框（whenDef.arg），
          // 其它字段改了就是纯数值/文本，不需要重渲染（不打断输入框的焦点/滚动位置）。
          if (field === 'when') render();
        });
      });
      document.querySelectorAll('.wave-rule-card').forEach(card => {
        card.addEventListener('dragstart', () => {
          draggingRuleIndex = Number(card.dataset.ruleIndex);
        });
        card.addEventListener('dragover', (e) => { e.preventDefault(); });
        card.addEventListener('drop', (e) => {
          e.preventDefault();
          if (draggingRuleIndex < 0) return;
          const toIndex = Number(card.dataset.ruleIndex);
          ensureWaveDraft(selectedWaveLaneId);
          draftLaneComposition[selectedWaveLaneId] =
            withRuleMoved(draftLaneComposition[selectedWaveLaneId], draggingRuleIndex, toIndex);
          draggingRuleIndex = -1;
          render();
        });
      });

      // 中立营地（第四节 Part D）：出生点字段改动 + 新增/删除出生点。
      // 元素只在 editMode==='config' 时存在，可选链/存在性判断天然跳过其它模式。
      document.querySelectorAll('[data-camp-id][data-sp-field]').forEach(el => {
        el.addEventListener('change', (e) => {
          const campId = el.dataset.campId;
          const spIndex = Number(el.dataset.spIndex);
          const field = el.dataset.spField;
          const value = (field === 'x' || field === 'y') ? (Number(e.target.value) || 0) : e.target.value;
          draftNeutralCamps = withCampSpawnPointFieldSet(draftNeutralCamps, campId, spIndex, field, value);
          if (field === 'laneMatch' || field === 'direction') render();
          // x/y 是数字输入框：跟出兵编排规则卡片同样的道理，不整页重渲，
          // 避免用户正在打字时输入框被打断（见 renderRuleCard 那边同款处理）。
        });
      });
      document.querySelectorAll('[data-camp-add-sp]').forEach(btn => {
        btn.addEventListener('click', () => {
          const campId = btn.dataset.campAddSp;
          // 默认坐标给世界正中心（pit.x/y 是世界坐标，不是 navgrid 格子坐标——
          // 跟 defaultPitFor() 龙坑/男爵坑新增时的默认值同一个坐标系）。
          const W = baseMap.world || { w: 0, h: 0 };
          draftNeutralCamps = withCampSpawnPointAdded(draftNeutralCamps, campId, {
            pit: { x: W.w / 2, y: W.h / 2 }, laneMatch: draftLanes[0]?.id || 'mid', direction: 'forward',
          });
          render();
        });
      });
      document.querySelectorAll('[data-camp-remove-sp]').forEach(btn => {
        btn.addEventListener('click', () => {
          const [campId, idx] = btn.dataset.campRemoveSp.split(':');
          try {
            draftNeutralCamps = withCampSpawnPointRemoved(draftNeutralCamps, campId, Number(idx));
            render();
          } catch (err) {
            neutralCampStatus = `⚠️ ${err.message}`;
            const el = document.getElementById('mapEditorNeutralCampStatus');
            if (el) el.textContent = neutralCampStatus;
          }
        });
      });

      // 路径编辑：只在 paths 模式下渲染这几个元素
      document.getElementById('mapEditorLaneSelect')?.addEventListener('change', (e) => {
        selectedLaneId = e.target.value;
        selectedWaypointIndex = -1;
        redrawCanvas();
        updatePathStatus();
      });
      document.getElementById('mapEditorDeleteWaypointBtn')?.addEventListener('click', () => {
        if (!selectedLaneId || selectedWaypointIndex < 0) return;
        const before = draftLanes.find(l => l.id === selectedLaneId).waypoints.length;
        draftLanes = withWaypointRemoved(draftLanes, selectedLaneId, selectedWaypointIndex);
        const after = draftLanes.find(l => l.id === selectedLaneId).waypoints.length;
        if (after === before) {
          logFn('⚠️ 这条路只剩 2 个路点了，至少要保留起点和终点', 'spawn');
        } else {
          logFn(`🗑️ 已删除 ${selectedLaneId} 的第 ${selectedWaypointIndex + 1} 个路点`, 'spawn');
        }
        selectedWaypointIndex = -1;
        render();
      });
      document.getElementById('mapEditorAddLaneBtn')?.addEventListener('click', () => {
        const id = document.getElementById('mapEditorNewLaneIdInput').value.trim();
        if (!id) { logFn('⚠️ 请先填写新路的 id', 'spawn'); return; }
        // 默认给一条蓝方基地到红方基地的直线（用户新建后自己往里插路点改形状）——
        // 用世界对角当默认端点，比"两个点都在原点"更有用，至少一开局就是条能走的路。
        const W = baseMap.world || { w: 0, h: 0 };
        try {
          draftLanes = withLaneAdded(draftLanes, { id, waypoints: [{ x: 0, y: W.h }, { x: W.w, y: 0 }] });
          selectedLaneId = id;
          selectedWaypointIndex = -1;
          logFn(`🛣️ 已新增一条路：${id}`, 'spawn');
          render();
        } catch (err) {
          logFn(`⚠️ ${err.message}`, 'spawn');
        }
      });
      document.getElementById('mapEditorDeleteLaneBtn')?.addEventListener('click', () => {
        if (!selectedLaneId) return;
        const usedBy = laneBuildingCount(draftBuildings, selectedLaneId);
        if (usedBy > 0) {
          logFn(`⚠️ 还有 ${usedBy} 座建筑挂在 ${selectedLaneId} 上，请先去"建筑摆放"模式移走/删除它们再删这条路`, 'spawn');
          return;
        }
        draftLanes = withLaneRemoved(draftLanes, selectedLaneId);
        selectedLaneId = draftLanes[0]?.id ?? null;
        selectedWaypointIndex = -1;
        logFn('🗑️ 已删除这条路', 'spawn');
        render();
      });

      // 自动识别档位：只在建筑模式下渲染
      document.getElementById('mapEditorAutoDetectBtn')?.addEventListener('click', () => {
        draftBuildings = autoDetectTiers(draftMapForValidate(), draftBuildings);
        redrawCanvas();
        updateValidationStatus();
        updateSelectionPanel();
        logFn('🔍 已按位置自动识别全部建筑档位（手动改过的也会被重算，如需保留请改完再点这个）', 'spawn');
      });

      // 画/擦切换、笔刷半径滑杆只在地形模式下渲染，建筑模式下这几个元素不存在
      document.getElementById('mapEditorModeDraw')?.addEventListener('click', () => { brushMode = 'draw'; render(); });
      document.getElementById('mapEditorModeErase')?.addEventListener('click', () => { brushMode = 'erase'; render(); });

      const slider = document.getElementById('mapEditorBrushSlider');
      slider?.addEventListener('input', () => {
        brushRadius = Number(slider.value) || CONFIG.mapEditor.brushRadiusGridDefault;
        document.getElementById('mapEditorBrushLabel').textContent = `${brushRadius} 格`;
      });

      // 笔刷形状切换：换形状时把还没提交的折线顶点扔掉（半成品墙留着容易误以为已经生效）。
      document.getElementById('mapEditorShapeCircle')?.addEventListener('click', () => {
        brushShape = 'circle'; polylinePoints = []; polylineHover = null; render();
      });
      document.getElementById('mapEditorShapePolyline')?.addEventListener('click', () => { brushShape = 'polyline'; render(); });

      document.getElementById('mapEditorPolylineUndo')?.addEventListener('click', () => {
        polylinePoints.pop(); updatePolylineStatus(); redrawCanvas();
      });
      document.getElementById('mapEditorPolylineCancel')?.addEventListener('click', () => {
        polylinePoints = []; updatePolylineStatus(); redrawCanvas();
      });
      document.getElementById('mapEditorPolylineCommit')?.addEventListener('click', () => {
        if (polylinePoints.length >= 2) {
          paintPolyline(bits, n, polylinePoints, brushRadius, brushMode === 'draw');
          logFn(`📐 已把 ${polylinePoints.length} 个顶点连成的墙体${brushMode === 'draw' ? '画成可走' : '擦成不可走'}`, 'spawn');
        }
        polylinePoints = [];
        updatePolylineStatus();
        redrawCanvas();
      });

      document.getElementById('mapEditorDespeckleBtn')?.addEventListener('click', () => {
        despeckle(bits, n);
        redrawCanvas();
        logFn('🧹 已清理一遍孤立噪点/尖刺（效果不够可以多点几次）', 'spawn');
      });

      document.getElementById('mapEditorImgImportToggle')?.addEventListener('click', () => {
        imgImportOpen = !imgImportOpen;
        if (!imgImportOpen) { imgImportImageData = null; imgImportSampleColor = null; imgImportResult = null; }
        render();
      });
      document.getElementById('mapEditorImgImportCancelBtn')?.addEventListener('click', () => {
        imgImportOpen = false; imgImportImageData = null; imgImportSampleColor = null; imgImportResult = null;
        render();
      });
      document.getElementById('mapEditorImgImportFile')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const img = new Image();
        img.onload = () => {
          const off = document.createElement('canvas');
          off.width = img.naturalWidth; off.height = img.naturalHeight;
          const octx = off.getContext('2d');
          octx.drawImage(img, 0, 0);
          imgImportImageData = octx.getImageData(0, 0, off.width, off.height);
          // 预览画布按显示上限等比缩放，不直接拿原图分辨率（有的截图几千像素宽，
          // 撑爆弹窗）——上限跟主画布同一档（CANVAS_DISPLAY_PX），足够点着取样。
          const scale = Math.min(1, CANVAS_DISPLAY_PX / Math.max(off.width, off.height));
          imgImportSrcDisplayW = Math.round(off.width * scale);
          imgImportSrcDisplayH = Math.round(off.height * scale);
          imgImportSampleColor = null;
          imgImportResult = null;
          render();
        };
        img.onerror = () => { setStatus('⚠️ 图片读取失败'); };
        img.src = URL.createObjectURL(file);
      });
      document.getElementById('mapEditorImgImportSrcCanvas')?.addEventListener('click', (e) => {
        if (!imgImportImageData) return;
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        // 显示画布是原图等比缩放后的尺寸，点击坐标要换算回原图像素坐标才能取对颜色。
        const dispX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const dispY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const srcX = Math.floor(dispX * (imgImportImageData.width / canvas.width));
        const srcY = Math.floor(dispY * (imgImportImageData.height / canvas.height));
        const idx = (Math.min(imgImportImageData.height - 1, Math.max(0, srcY)) * imgImportImageData.width
          + Math.min(imgImportImageData.width - 1, Math.max(0, srcX))) * 4;
        imgImportSampleColor = {
          r: imgImportImageData.data[idx], g: imgImportImageData.data[idx + 1], b: imgImportImageData.data[idx + 2],
        };
        recomputeImgImportPreview();
        redrawImgImportPreview();
      });
      document.getElementById('mapEditorImgImportTolerance')?.addEventListener('input', (e) => {
        imgImportTolerancePct = Number(e.target.value) || CONFIG.mapEditor.imageImportTolerancePctDefault;
        document.getElementById('mapEditorImgImportToleranceLabel').textContent = `${imgImportTolerancePct}%`;
        recomputeImgImportPreview();
        redrawImgImportPreview();
      });
      document.getElementById('mapEditorImgImportApplyBtn')?.addEventListener('click', () => {
        if (!imgImportResult) return;
        // 识别结果本来就是按当前地形分辨率（n）算出来的（见 recomputeImgImportPreview），
        // 直接整份换掉 bits 就行，不用像切换起点地图那样重建整个草稿状态。
        bits = imgImportResult.bits;
        imgImportOpen = false; imgImportImageData = null; imgImportSampleColor = null; imgImportResult = null;
        logFn('🖼️ 已把图片识别结果应用为当前地形（可以接着用笔刷/去毛刺微调）', 'spawn');
        render();
      });

      // 区域参数表单：基地圈半径改动只重画预览圈（不结构性重渲，输入框失焦体验更好）；
      // 龙坑/男爵坑的"启用"勾选框会增删表单里的 X/Y/半径三个输入框，必须走结构性 render()。
      document.getElementById('mapEditorBaseRadiusInput').addEventListener('input', (e) => {
        const v = Number(e.target.value);
        draftRegions.baseCircleRadius = Number.isFinite(v) && v > 0 ? v : null;
        redrawCanvas();
      });
      for (const name of ['baron', 'dragon']) {
        document.getElementById(`mapEditorPit${name}Enable`).addEventListener('change', (e) => {
          if (e.target.checked) draftRegions.pits[name] = draftRegions.pits[name] || defaultPitFor(baseMap, name);
          else delete draftRegions.pits[name];
          render();
        });
        const xEl = document.getElementById(`mapEditorPit${name}X`);
        const yEl = document.getElementById(`mapEditorPit${name}Y`);
        const rEl = document.getElementById(`mapEditorPit${name}R`);
        xEl?.addEventListener('input', () => { draftRegions.pits[name].x = Number(xEl.value) || 0; redrawCanvas(); });
        yEl?.addEventListener('input', () => { draftRegions.pits[name].y = Number(yEl.value) || 0; redrawCanvas(); });
        rEl?.addEventListener('input', () => { draftRegions.pits[name].r = Math.max(1, Number(rEl.value) || 1); redrawCanvas(); });
      }

      document.getElementById('mapEditorSaveBtn').addEventListener('click', () => {
        const id = document.getElementById('mapEditorIdInput').value.trim();
        const label = document.getElementById('mapEditorLabelInput').value.trim();
        if (!id) { setStatus('⚠️ 请填写地图 ID'); return; }
        try {
          // 出兵编排（第四节 Part B）：draftLaneComposition 只装了"刷兵"规则
          // （ensureWaveDraft 摘出去的），保存时把原样保留的广播规则拼回同一条路，
          // 拼的顺序不影响判定（buildWaveOrder/buildBroadcastOrder 各自只认自己
          // 关心的那种规则，见 compositionFor 头注）。
          const laneWaveCompositionByLane = {};
          for (const laneId of Object.keys(draftLaneComposition)) {
            laneWaveCompositionByLane[laneId] =
              [...draftLaneComposition[laneId], ...(draftLaneBroadcast[laneId] || [])];
          }
          const payload = buildCustomMapPayload(baseMap, {
            id, label, n, bits, buildings: draftBuildings,
            baseCircleRadius: draftRegions.baseCircleRadius, pits: draftRegions.pits,
            lanes: draftLanes, factions: draftFactions, spawnEnabled: draftSpawnEnabled,
            laneWaveCompositionByLane, neutralCamps: draftNeutralCamps,
          });
          if (!CONFIG.customMaps || typeof CONFIG.customMaps !== 'object') CONFIG.customMaps = {};
          CONFIG.customMaps[id] = payload;
          logFn(`🗺️ 已保存自制地图：${payload.label}（id=${id}）`, 'spawn');
          statusMsg = `✅ 已保存（${new Date().toLocaleTimeString()}）`;
          render();
        } catch (err) {
          setStatus(`⚠️ 保存失败：${err.message}`);
        }
      });

      document.querySelectorAll('[data-edit-custom-id]').forEach(btn => {
        btn.addEventListener('click', () => switchBase(btn.dataset.editCustomId));
      });
      document.querySelectorAll('[data-preview-custom-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.previewCustomId;
          mapSystem.loadMap(id);
          // 同 id 覆盖保存后重新加载 = "同一张地图 navgrid 数据变了"，必须显式失效缓存
          // （见 ThreeRenderer.invalidateTerrain 头注列的四处"同地图 id 跳过重建"缓存）；
          // 不同 id 首次加载本来就会自然重建，这里一并调用是无害的多余一次清空。
          renderer3d?.invalidateTerrain?.();
          logFn(`🔍 已加载自制地图预览：${id}`, 'spawn');
          deps.onMapChanged?.();
        });
      });
      document.querySelectorAll('[data-del-custom-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.delCustomId;
          if (CONFIG.customMaps) delete CONFIG.customMaps[id];
          logFn(`🗑️ 已删除自制地图：${id}`, 'spawn');
          if (baseId === id) switchBase(mapSystem.getAvailableMaps()[0]?.id);
          else render();
        });
      });
    };

    render();
    document.getElementById('modalActions').innerHTML = `<button id="mapEditorCloseBtn" class="primary">关闭</button>`;
    document.getElementById('mapEditorCloseBtn').addEventListener('click', () => {
      overlay.classList.remove('open');
      document.getElementById('modalBox').classList.remove('mapEditorWide');
      CTX.gamePaused = _pausedBefore;
    });
  },
};
