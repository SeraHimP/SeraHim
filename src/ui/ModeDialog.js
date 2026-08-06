/**
 * ModeDialog.js
 * 模式切换窗口：沙盒模式（现有自由玩法）与对战模式（地图系统）二选一，互斥运行。
 */
import { paneHtml } from './dialogShell.js';

export const ModeDialog = {
  open(deps, logFn) {
    const { mapSystem } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '🗺️ 游戏模式';

    // v43 Q1：套用模板编辑器那套外壳（左侧栏 + 右侧单页）。
    // 这个窗口只有两段内容，本来"够用了"，但一个应用里两种导航语言就是两套要学的东西 ——
    // 用户要的是"所有窗口统一"，所以这里也统一，哪怕它自己并不需要。
    const SECS = [{ key: 'mode', label: '🎮 模式' }, { key: 'map', label: '🗺️ 地图' }];
    if (!this._sec) this._sec = 'mode';
    const render = () => {
      const maps = mapSystem.getAvailableMaps();
      const sec = (k, inner) => `<div style="display:${k === this._sec ? '' : 'none'};">${inner}</div>`;
      const body = `
        ${sec('mode', `
        <div class="editor-section">
          <h4>当前模式：${mapSystem.active ? '⚔️ 对战模式' : '🗺️ 沙盒模式'}</h4>
          <p style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">
            沙盒模式：自由建塔、自由添加小兵，原有玩法。<br>
            对战模式：双方阵营在地图上对线，小兵沿固定路径行走，摧毁水晶后该方转为持续刷超级兵。
          </p>
          <div class="slider-row"><label>切换到</label>
            <button id="switchSandboxBtn" style="flex:1;" ${!mapSystem.active ? 'disabled' : ''}>🗺️ 沙盒模式</button>
            <button id="switchBattleBtn" style="flex:1;" ${mapSystem.active ? 'disabled' : ''}>⚔️ 对战模式</button>
          </div>
        </div>`)}
        ${sec('map', `
        <div class="editor-section">
          <h4>选择地图</h4>
          <div class="pick-grid">
            ${maps.map(m => `<div class="pick-card ${mapSystem.currentMap?.id === m.id ? 'selected' : ''}" data-map-id="${m.id}">
              <div class="pick-icon">🗺️</div><div class="pick-label">${m.label}</div>
            </div>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-mute);margin-top:6px;">选择地图会重新加载对战模式（清空当前对战单位）。</div>
        </div>`)}
      `;
      document.getElementById('modalBody').innerHTML = paneHtml({
        groups: [{ items: SECS }], activeKey: this._sec, body, navAttr: 'modenav',
      });
      document.querySelectorAll('[data-modenav]').forEach(b => b.addEventListener('click', () => {
        this._sec = b.dataset.modenav; render();
      }));
      bindEvents();
    };

    const bindEvents = () => {
      const sandboxBtn = document.getElementById('switchSandboxBtn');
      const battleBtn = document.getElementById('switchBattleBtn');
      if (sandboxBtn) sandboxBtn.addEventListener('click', () => {
        mapSystem.clearCurrentMap();
        logFn('🗺️ 已切换到沙盒模式', 'spawn');
        render();
        deps.onModeChanged?.();
      });
      if (battleBtn) battleBtn.addEventListener('click', () => {
        mapSystem.loadMap();
        logFn('⚔️ 已切换到对战模式', 'spawn');
        render();
        deps.onModeChanged?.();
      });
      document.querySelectorAll('[data-map-id]').forEach(card => {
        card.addEventListener('click', () => {
          mapSystem.loadMap(card.dataset.mapId);
          logFn(`🗺️ 已加载地图：${card.querySelector('.pick-label').textContent}`, 'spawn');
          render();
          deps.onModeChanged?.();
        });
      });
    };

    render();
    // 统一页脚。切模式/换地图是**立刻发生**的重动作（会重建整张地图），
    // 没有"改了还没生效"的中间态，所以这里的"取消"不做回滚（回滚等于再重建一次地图，
    // 那不是点取消想要的），只关窗；"应用"同理无事可做，故只留【确定 / 取消】两个。
    // 判据见 dialogFooter.js 顶部：有中间态才配三按钮，硬套只会造出没作用的按钮。
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
