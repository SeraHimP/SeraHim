/**
 * ModeDialog.js
 * 地图切换窗口。原来还带一个"沙盒模式/对战模式"切换（本项目最早的自由玩法，
 * 与对战模式的地图系统二选一、互斥运行），已删除——沙盒模式整个玩法都被拿掉了，
 * 现在游戏只有对战模式这一条路，这个窗口自然收窄成单纯的"选地图"。
 */
import { paneHtml } from './dialogShell.js';

export const ModeDialog = {
  open(deps, logFn) {
    const { mapSystem } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '🗺️ 游戏地图';

    // 只剩"选地图"一页内容，不摆侧边栏——一个只有一项的导航是纯装饰，比没有更糟。
    const render = () => {
      const maps = mapSystem.getAvailableMaps();
      const body = `
        <div class="editor-section">
          <h4>选择地图</h4>
          <div class="pick-grid">
            ${maps.map(m => `<div class="pick-card ${mapSystem.currentMap?.id === m.id ? 'selected' : ''}" data-map-id="${m.id}">
              <div class="pick-icon">🗺️</div><div class="pick-label">${m.label}</div>
            </div>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-mute);margin-top:6px;">选择地图会重新加载对战（清空当前场上单位）。</div>
        </div>`;
      document.getElementById('modalBody').innerHTML = paneHtml({ groups: [], body });
      bindEvents();
    };

    const bindEvents = () => {
      document.querySelectorAll('[data-map-id]').forEach(card => {
        card.addEventListener('click', () => {
          mapSystem.loadMap(card.dataset.mapId);
          logFn(`🗺️ 已加载地图：${card.querySelector('.pick-label').textContent}`, 'spawn');
          render();
          deps.onMapChanged?.();
        });
      });
    };

    render();
    // 统一页脚。换地图是**立刻发生**的重动作（会重建整张地图），没有"改了还没生效"的中间态，
    // 所以这里的"取消"不做回滚，只关窗；"应用"同理无事可做，故只留【确定/取消】。
    document.getElementById('modalActions').innerHTML =
      `<button id="modeOkBtn" class="primary">确定</button><button id="modeCloseBtn">取消</button>`;
    document.getElementById('modeOkBtn').addEventListener('click', () => overlay.classList.remove('open'));
    document.getElementById('modeCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    if (!overlay._modeCloseBound) {
      overlay._modeCloseBound = true;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    }
  },
};
