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
 * 做：navgrid 圆形笔刷（画/擦）、克隆已有地图作为起点、保存到 CONFIG.customMaps、
 *     加载预览、删除自制地图。
 * 不做（设计报告后续阶段）：画线/折线造墙模式、去毛刺整理、建筑摆放、路径编辑、
 *     高度笔刷、实时校验红线。这些各自是独立的阶段三剩余项/阶段四/五/六，
 *     不在这一批一起做——单批改动越大，出问题时越难定位是哪一步引入的。
 */
import { paneHtml } from './dialogShell.js';
import { CONFIG } from '../data/Config.js';
import { paintCircle } from '../data/navgrid.js';
import { decodeBaseBits, buildCustomMapPayload } from '../data/mapEditorCore.js';

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
    document.getElementById('modalTitle').textContent = '🗺️✏️ 地图编辑器（地形笔刷）';

    // ---------- 编辑状态（整个弹窗生命周期内持续，只有切换起点地图才重置） ----------
    let baseId = mapSystem.currentBaseMapId || mapSystem.getAvailableMaps()[0]?.id;
    let baseMap = mapSystem.getMapById(baseId);
    let { n, bits } = decodeBaseBits(baseMap);
    let brushMode = 'draw';   // 'draw'=画可走 | 'erase'=擦成不可走
    let brushRadius = CONFIG.mapEditor.brushRadiusGridDefault;
    let painting = false;
    let statusMsg = '';

    const isCustomMap = (id) => !!(CONFIG.customMaps && CONFIG.customMaps[id]);

    // ---------- 画布：只重画像素，不重建 DOM（笔刷拖动时每帧都会调，必须轻量） ----------
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

    const bindCanvasEvents = () => {
      const canvas = document.getElementById('mapEditorCanvas');
      if (!canvas) return;
      canvas.addEventListener('pointerdown', (e) => {
        painting = true;
        canvas.setPointerCapture(e.pointerId);
        paintAt(e.clientX, e.clientY);
      });
      canvas.addEventListener('pointermove', (e) => { if (painting) paintAt(e.clientX, e.clientY); });
      const stop = () => { painting = false; };
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
          <h4>地形笔刷</h4>
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
          </div>
          <div style="display:flex;justify-content:center;margin:8px 0;">
            <canvas id="mapEditorCanvas" width="${n}" height="${n}"
              style="width:${CANVAS_DISPLAY_PX}px;height:${CANVAS_DISPLAY_PX}px;image-rendering:pixelated;
                     border:1px solid var(--border-color,#444);cursor:crosshair;touch-action:none;border-radius:4px;"></canvas>
          </div>
          <div style="font-size:11px;color:var(--text-mute);text-align:center;">按住拖动连续绘制；分辨率 ${n}×${n} 格（自适应公式，见 CONFIG.mapEditor）。</div>
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
      statusMsg = '';
      render();
    };

    const bindEvents = () => {
      document.getElementById('mapEditorBaseSelect').addEventListener('change', (e) => switchBase(e.target.value));

      document.getElementById('mapEditorModeDraw').addEventListener('click', () => { brushMode = 'draw'; render(); });
      document.getElementById('mapEditorModeErase').addEventListener('click', () => { brushMode = 'erase'; render(); });

      const slider = document.getElementById('mapEditorBrushSlider');
      slider.addEventListener('input', () => {
        brushRadius = Number(slider.value) || CONFIG.mapEditor.brushRadiusGridDefault;
        document.getElementById('mapEditorBrushLabel').textContent = `${brushRadius} 格`;
      });

      document.getElementById('mapEditorSaveBtn').addEventListener('click', () => {
        const id = document.getElementById('mapEditorIdInput').value.trim();
        const label = document.getElementById('mapEditorLabelInput').value.trim();
        if (!id) { setStatus('⚠️ 请填写地图 ID'); return; }
        try {
          const payload = buildCustomMapPayload(baseMap, { id, label, n, bits });
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
