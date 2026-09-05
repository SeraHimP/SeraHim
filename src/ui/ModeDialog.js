/**
 * ModeDialog.js
 * 地图/模式切换窗口。
 *
 * v51.20：用户定稿"游戏地图作为框架，游戏模式在框架上进行进一步修正"——
 * 地图（召唤师峡谷/嚎哭深渊/扭曲丛林）与模式（普通/经典）是两条独立的轴，
 * 不再是"经典模式"混在地图列表里当第四张图选。先选模式、再选地图（或反过来，
 * 两组选卡各自即选即生效，不分先后，跟原来"选地图立刻重载"这条既有设计一致——
 * 见下面页脚注释，这里没有"应用"这个中间态）。
 *
 * 原来还带一个"沙盒模式/对战模式"切换（本项目最早的自由玩法，与对战模式的地图
 * 系统二选一、互斥运行），已删除——沙盒模式整个玩法都被拿掉了。
 */
import { paneHtml } from './dialogShell.js';

export const ModeDialog = {
  open(deps, logFn) {
    const { mapSystem } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '🗺️ 游戏模式 / 地图';

    // 只有两组选卡，不摆侧边栏——跟原来一样，一个只有一两项的导航是纯装饰。
    const render = () => {
      const modes = mapSystem.getAvailableModes();
      const maps = mapSystem.getAvailableMaps();
      const body = `
        <div class="editor-section">
          <h4>选择模式</h4>
          <div class="pick-grid">
            ${modes.map(m => `<div class="pick-card ${mapSystem.currentMode === m.id ? 'selected' : ''}" data-mode-id="${m.id}">
              <div class="pick-icon">${m.id === 'classic' ? '📜' : '⚔️'}</div><div class="pick-label">${m.label}</div>
            </div>`).join('')}
          </div>
        </div>
        <div class="editor-section">
          <h4>选择地图</h4>
          <div class="pick-grid">
            ${maps.map(m => `<div class="pick-card ${mapSystem.currentBaseMapId === m.id ? 'selected' : ''}" data-map-id="${m.id}">
              <div class="pick-icon">🗺️</div><div class="pick-label">${m.label}</div>
            </div>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-mute);margin-top:6px;">选择模式或地图都会立刻重新加载对战（清空当前场上单位）。</div>
        </div>`;
      document.getElementById('modalBody').innerHTML = paneHtml({ groups: [], body });
      bindEvents();
    };

    const bindEvents = () => {
      document.querySelectorAll('[data-mode-id]').forEach(card => {
        card.addEventListener('click', () => {
          const modeId = card.dataset.modeId;
          if (modeId === mapSystem.currentMode) return;
          mapSystem.loadMap(mapSystem.currentBaseMapId, modeId);
          logFn(`🗺️ 已切换模式：${card.querySelector('.pick-label').textContent}`, 'spawn');
          render();
          deps.onMapChanged?.();
        });
      });
      document.querySelectorAll('[data-map-id]').forEach(card => {
        card.addEventListener('click', () => {
          const mapId = card.dataset.mapId;
          if (mapId === mapSystem.currentBaseMapId) return;
          mapSystem.loadMap(mapId, mapSystem.currentMode);
          logFn(`🗺️ 已加载地图：${card.querySelector('.pick-label').textContent}`, 'spawn');
          render();
          deps.onMapChanged?.();
        });
      });
    };

    render();
    // 统一页脚。换地图/模式是**立刻发生**的重动作（会重建整张地图），
    // 没有"改了还没生效"的中间态，所以这里的"取消"不做回滚，只关窗；
    // "应用"同理无事可做，故只留【确定/取消】。
    document.getElementById('modalActions').innerHTML =
      `<button id="modeOkBtn" class="primary">确定</button><button id="modeCloseBtn">取消</button>`;
    document.getElementById('modeOkBtn').addEventListener('click', () => overlay.classList.remove('open'));
    document.getElementById('modeCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  },
};
