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
 * 做：navgrid 圆形笔刷（画/擦）、建筑拖拽摆放（吸附兵线 + 实时校验红线）、
 *     区域参数表单（基地圈半径、龙坑/男爵坑中心+半径，画布半透明预览）、
 *     克隆已有地图作为起点、保存到 CONFIG.customMaps、加载预览、删除自制地图。
 * 不做（设计报告后续阶段）：画线/折线造墙模式、去毛刺整理、路径编辑、高度笔刷。
 * 这些各自是独立的阶段四剩余/五/六，不在这一批一起做——单批改动越大，出问题时越难
 * 定位是哪一步引入的。
 *
 * ==================== 建筑摆放为什么复用同一块画布，不叠一层 overlay ====================
 * 地形笔刷和建筑摆放【互斥使用同一块画布区域】而不是两块画布叠放：叠放需要绝对定位、
 * 需要在"地形模式下点击穿透到下层画布、建筑模式下拦截点击"之间来回切 pointer-events，
 * 徒增一层状态要跟地形笔刷的 painting 状态保持同步。改成一个 editMode 开关
 * （'terrain'|'buildings'）决定 redrawCanvas() 多画一层建筑标记、
 * 决定 pointer 事件是拖笔刷还是拖建筑，两种模式的状态天然不会同时存在。
 */
import { paneHtml } from './dialogShell.js';
import { CONFIG } from '../data/Config.js';
import { paintCircle } from '../data/navgrid.js';
import { STRUCT_TIERS } from '../data/waveComposition.js';
import { baseCircleCenter } from '../data/baseCircle.js';
import {
  decodeBaseBits, buildCustomMapPayload, cloneBuildingsForEdit,
  snapBuildingPos, withBuildingMoved, validateDraftMap, autoDetectTiers,
  cloneRegionsForEdit, defaultPitFor,
} from '../data/mapEditorCore.js';

const FAC_COLOR = { blue: '#4a9eff', red: '#ff5a5a' };   // 与 UIManager.js 的 FAC_DOT 同一套配色

// 画布 CSS 显示尺寸（正方形）；内部像素分辨率=n，靠 image-rendering:pixelated 放大不糊边。
// 380 而不是更大：弹窗共用 index.html 里 #modalBox 的全局尺寸上限（其它弹窗，如设置面板，
// 内容超高时本来就是靠 overflow-y:auto 滚动查看——这里沿用同一惯例，不新开一套弹窗尺寸逻辑），
// 画布调小一点能让"笔刷模式/半径/画布/保存"这几块常用控件尽量在不滚动的情况下就看得见。
const CANVAS_DISPLAY_PX = 380;

export const MapEditorDialog = {
  open(deps, logFn) {
    const { mapSystem, renderer3d } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '🗺️✏️ 地图编辑器（地形笔刷 + 建筑摆放）';

    // ---------- 编辑状态（整个弹窗生命周期内持续，只有切换起点地图才重置） ----------
    let baseId = mapSystem.currentBaseMapId || mapSystem.getAvailableMaps()[0]?.id;
    let baseMap = mapSystem.getMapById(baseId);
    let { n, bits } = decodeBaseBits(baseMap);
    let brushMode = 'draw';   // 'draw'=画可走 | 'erase'=擦成不可走
    let brushRadius = CONFIG.mapEditor.brushRadiusGridDefault;
    let painting = false;
    let statusMsg = '';
    let editMode = 'terrain';           // 'terrain'=地形笔刷 | 'buildings'=建筑摆放
    let draftBuildings = cloneBuildingsForEdit(baseMap);
    let draggingBuildingIndex = -1;
    let selectedBuildingIndex = -1;     // 点选一座建筑后可在下方手动改档位（覆盖自动识别）
    let draftRegions = cloneRegionsForEdit(baseMap);   // 区域参数草稿：{baseCircleRadius, pits:{baron?,dragon?}}

    const isCustomMap = (id) => !!(CONFIG.customMaps && CONFIG.customMaps[id]);
    // 校验只关心结构（lanes/world/walls/useNavgrid）+ 当前草稿建筑，navgrid 笔刷改的
    // 地形位图跟这套结构性规则无关，不需要把 bits 也塞进去。
    const draftMapForValidate = () => ({ ...baseMap, buildings: draftBuildings });

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
      if (editMode === 'buildings') drawBuildingMarkers(ctx);
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
      const b = draftBuildings[draggingBuildingIndex];
      const pos = snapBuildingPos(draftMapForValidate(), b, world.x, world.y);
      draftBuildings = withBuildingMoved(draftBuildings, draggingBuildingIndex, pos);
      redrawCanvas();
      updateValidationStatus();
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
        } else {
          painting = true;
          paintAt(e.clientX, e.clientY);
        }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (editMode === 'buildings') { if (draggingBuildingIndex >= 0) dragBuildingTo(e.clientX, e.clientY); }
        else if (painting) paintAt(e.clientX, e.clientY);
      });
      const stop = () => { painting = false; draggingBuildingIndex = -1; redrawCanvas(); };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      canvas.addEventListener('pointerleave', stop);
    };

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
            </div>
          </div>
          ${editMode === 'terrain' ? `
          <div class="slider-row"><label>模式</label>
            <div style="display:flex;gap:6px;">
              <button id="mapEditorModeDraw" class="${brushMode === 'draw' ? 'primary' : ''}">🟩 画（可走）</button>
              <button id="mapEditorModeErase" class="${brushMode === 'erase' ? 'primary' : ''}">⬛ 擦（不可走）</button>
            </div>
          </div>
          <div class="slider-row"><label>笔刷半径</label>
            <input id="mapEditorBrushSlider" type="range"
              min="${CONFIG.mapEditor.brushRadiusGridMin}" max="${CONFIG.mapEditor.brushRadiusGridMax}"
              value="${brushRadius}" style="flex:1;">
            <span id="mapEditorBrushLabel">${brushRadius} 格</span>
          </div>` : `
          <div style="font-size:11px;color:var(--text-mute);margin-bottom:4px;">
            拖动一座建筑：分路的塔（外塔/内塔/水晶防御塔）会被吸附纠正回自己那条兵线上，
            不分路的建筑（水晶枢纽/枢纽防御塔）自由摆放。红圈标出违反结构规则的建筑
            （同一套判定见 tests/sim_maps.mjs，编辑器和发布前验收用的是同一个 mapValidate.js）。
          </div>
          <div id="mapEditorValidationStatus" style="font-size:12px;margin-bottom:4px;"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button id="mapEditorAutoDetectBtn">🔍 自动识别档位</button>
            <span style="font-size:10px;color:var(--text-mute);">离召唤水晶最近=水晶防御塔，最远=外塔，没有路的塔=枢纽防御塔</span>
          </div>
          <div id="mapEditorSelectionPanel" style="margin-bottom:6px;">
            <div style="font-size:11px;color:var(--text-mute);">点选画布上的一座建筑可查看/手动改它的档位。</div>
          </div>`}
          <div style="display:flex;justify-content:center;margin:8px 0;">
            <canvas id="mapEditorCanvas" width="${n}" height="${n}"
              style="width:${CANVAS_DISPLAY_PX}px;height:${CANVAS_DISPLAY_PX}px;image-rendering:pixelated;
                     border:1px solid var(--border-color,#444);cursor:crosshair;touch-action:none;border-radius:4px;"></canvas>
          </div>
          <div style="font-size:11px;color:var(--text-mute);text-align:center;">
            ${editMode === 'terrain' ? `按住拖动连续绘制；分辨率 ${n}×${n} 格（自适应公式，见 CONFIG.mapEditor）。`
              : '按住一座建筑拖动即可移动。'}
          </div>
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
      statusMsg = '';
      render();
    };

    const bindEvents = () => {
      document.getElementById('mapEditorBaseSelect').addEventListener('change', (e) => switchBase(e.target.value));

      document.getElementById('mapEditorEditModeTerrain').addEventListener('click', () => { editMode = 'terrain'; render(); });
      document.getElementById('mapEditorEditModeBuildings').addEventListener('click', () => { editMode = 'buildings'; render(); });

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
          const payload = buildCustomMapPayload(baseMap, {
            id, label, n, bits, buildings: draftBuildings,
            baseCircleRadius: draftRegions.baseCircleRadius, pits: draftRegions.pits,
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
    document.getElementById('mapEditorCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  },
};
