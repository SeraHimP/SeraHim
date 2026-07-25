import { CONFIG } from '../data/Config.js';
import { DebugLogger } from '../utils/DebugLogger.js';

/**
 * SettingsDialog.js
 * 设置窗口：整合此前散落在顶栏的操作按钮，并新增小兵/巨龙波次的独立暂停与间隔设置。
 */
// Q5：按阵营规则行（统一 / 仅蓝 / 仅红三键）。
// 语义：「统一」= 一键同开同关；「仅蓝/仅红」= 单独切换该阵营。
// 沙盒模式的塔没有阵营标记，读取时任一方开启即视为开启（见 window.__towerRuleFor）。
function _fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
}

function _ruleRow(kind, label, icon, defaultOn = false) {
  const r = window.__towerRules?.[kind] || { blue: defaultOn, red: defaultOn };
  const chip = (scope, txt, on) =>
    `<button data-rule="${kind}" data-scope="${scope}" class="editor-tab ${on ? 'active' : ''}"
      style="flex:1;font-size:11px;">${txt}</button>`;
  const bothOn = r.blue && r.red;
  return `<div class="slider-row" style="align-items:flex-start;">
    <label style="padding-top:5px;">${icon} ${label}</label>
    <div style="flex:1;display:flex;gap:4px;">
      ${chip('both', bothOn ? '全部开' : '全部关', bothOn)}
      ${chip('blue', `🔵 ${r.blue ? '开' : '关'}`, r.blue)}
      ${chip('red', `🔴 ${r.red ? '开' : '关'}`, r.red)}
    </div>
  </div>`;
}

export const SettingsDialog = {
  open(deps, logFn) {
    const { waveSystem, dragonSystem, entityContainer, mapSystem, laneWaveSystem } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '⚙️ 设置';

    const render = () => {
      document.getElementById('modalBody').innerHTML = `
        <!-- v33（Q3）设置界面重构：全局区 + 当前模式专属区。
             只显示当前模式的设置（对战模式看不到沙盒波次，反之亦然），
             并砍掉了重复的"波次生成间隔"（此前全局区和对战区各有一个，改谁都心里没底）。 -->
        <div class="editor-section">
          <h4>⏱ 全局</h4>
          <!-- v39（Q6）：详细游戏参数 -->
          <div class="slider-row"><label>游戏进行时间</label>
            <div style="flex:1;font-family:monospace;font-size:14px;padding:5px 0;">
              ${_fmtTime(window.gameTime || 0)}
              <span style="opacity:.6;font-size:11px;">（${Math.floor(window.gameTime || 0)}s）</span>
            </div>
          </div>
          <div class="slider-row"><label>当前波次</label>
            <div style="flex:1;font-size:13px;padding:5px 0;">
              ${mapSystem?.active
                ? `对战 第 <b>${laneWaveSystem?.waveNumber || 0}</b> 波　│　下一波 <b>${Math.ceil(laneWaveSystem?.nextWaveTime || 0)}</b>s`
                : `沙盒 第 <b>${waveSystem?.waveNumber || 0}</b> 波`}
            </div>
          </div>
          <div class="slider-row"><label>游戏暂停</label>
            <button id="setGamePauseBtn" style="flex:1;">${window.gamePaused ? '▶ 继续' : '⏸ 暂停'}</button>
          </div>
          <div class="slider-row"><label>游戏速度</label>
            <div style="flex:1;display:flex;gap:4px;">
              ${[0.5, 1, 2].map(v => `<button data-speed="${v}" class="editor-tab ${(window.__gameSpeed || 1) === v ? 'active' : ''}" style="flex:1;">${v}x</button>`).join('')}
            </div>
          </div>
          <div class="slider-row"><label>快进（加速模拟真实跑完）</label>
            <div style="flex:1;display:flex;gap:4px;">
              <button data-ff="30" style="flex:1;">⏩ 30s</button>
              <button data-ff="300" style="flex:1;">⏩⏩ 300s</button>
            </div>
          </div>
          ${(window.__ffRemain > 0) ? `<div class="slider-row"><label>快进中</label>
            <div style="flex:1;font-size:12px;color:#f6c94a;">剩余 ${Math.ceil(window.__ffRemain)}s（战斗照常结算）</div>
          </div>` : ''}
          ${_ruleRow('invincible', '防御塔无敌', '🛡')}
          ${_ruleRow('attackOff', '防御塔停火', '🚫')}
          <div class="slider-row"><label>清屏（移除全部小兵）</label>
            <button id="setClearAllBtn" class="danger" style="flex:1;">💀 清屏</button>
          </div>
          <div class="slider-row"><label>阴影质量</label>
            <button id="setShadowBtn" style="flex:1;">${{ all: '🌑 全部投影', static: '🏛️ 仅建筑投影', off: '⭕ 关闭阴影' }[window.__three?.shadowLevel || 'off']}</button>
          </div>
          <div class="slider-row"><label>画质·后处理总开关</label>
            <button id="setPostFXBtn" style="flex:1;">${window.__three?.postFX !== false ? '✨ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>画质·辉光 Bloom</label>
            <button id="setBloomBtn" style="flex:1;">${window.__three?.bloomOn !== false ? '🌟 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>画质·电影级色调 ACES</label>
            <button id="setToneBtn" style="flex:1;">${window.__three?.toneMapOn ? '🎬 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>画质·抗锯齿 FXAA</label>
            <button id="setFxaaBtn" style="flex:1;">${window.__three?.fxaaOn !== false ? '🔷 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>画质·水晶粒子</label>
            <button id="setPartBtn" style="flex:1;">${window.__three?.units?.particlesOn !== false ? '✦ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>画质·野区植被</label>
            <button id="setVegBtn" style="flex:1;">${window.__three?.vegOn !== false ? '🌲 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>性能面板</label>
            <button id="setPerfBtn" style="flex:1;">${document.getElementById('perfHud')?.classList.contains('show') ? '📊 已显示（点击隐藏）' : '📊 显示性能面板'}</button>
          </div>
          <div class="slider-row"><label>天气系统</label>
            <button id="setWeatherToggleBtn" style="flex:1;">${window.__weather?.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
            <button id="setWeatherCfgBtn" style="flex:1;">⚙️ 天气配置…</button>
          </div>
          <div class="slider-row"><label>调试日志（${DebugLogger.entries.length}条）</label>
            <button id="setExportLogBtn" style="flex:1;">💾 导出日志文件</button>
          </div>
        </div>

        <div class="editor-section">
          <h4>🐉 巨龙波次</h4>
          <div class="slider-row"><label>巨龙波次生成</label>
            <button id="setToggleDragonBtn" style="flex:1;">${dragonSystem.paused ? '▶ 恢复' : '⏸ 暂停'}</button>
          </div>
          <div class="slider-row"><label>首条龙延迟（秒）</label>
            <input type="number" id="setDragonFirstDelay" class="editor-number" value="${dragonSystem.nextDragonTime || 60}" min="5" step="5">
          </div>
        </div>

        ${mapSystem?.active ? `
        <div class="editor-section">
          <h4>⚔️ 对战模式</h4>
          <div class="slider-row"><label>双方波次生成</label>
            <button id="setToggleLaneWaveBtn" style="flex:1;">${laneWaveSystem?.paused ? '▶ 恢复' : '⏸ 暂停'}</button>
            <button id="setSkipLaneWaveBtn" style="flex:1;">⏭ 立即下一波</button>
          </div>
          ${_ruleRow('waveOn', '小兵随波次生成', '🌊', true)}
          <div class="slider-row"><label>波次生成间隔（秒）</label>
            <input type="number" id="setLaneWaveInterval" class="editor-number" value="${laneWaveSystem?.waveInterval || 30}" min="5" step="1">
          </div>
          ${mapSystem.hasWalls?.() ? `
          <div class="slider-row"><label>显示小兵轨迹</label>
            <button id="setLanePathBtn" style="flex:1;">${window.__showLanePaths ? '👁 已显示（点击隐藏）' : '🙈 已隐藏（点击显示）'}</button>
          </div>` : ''}
        </div>` : `
        <div class="editor-section">
          <h4>🗺️ 沙盒模式 · 小兵波次</h4>
          <div class="slider-row"><label>小兵波次生成</label>
            <button id="setToggleWaveBtn" style="flex:1;">${waveSystem.paused ? '▶ 恢复' : '⏸ 暂停'}</button>
            <button id="setSkipWaveBtn" style="flex:1;">⏭ 立即下一波</button>
          </div>
          <div class="slider-row"><label>波次间隔（秒）</label>
            <input type="number" id="setWaveInterval" class="editor-number" value="${CONFIG.gameRules.waveInterval || 45}" min="5" step="1">
          </div>
          <div class="slider-row"><label>重置波次</label>
            <button id="setResetWaveBtn" style="flex:1;">🔄 重置到第0波</button>
          </div>
        </div>`}
      `;
      bindEvents();
    };

    const bindEvents = () => {
      // 天气系统入口（此前只做在天气条上，而天气条在关闭时是隐藏的 → 开关自己把自己藏起来了，
      // 用户根本无从开启。入口必须放在【永远可达】的设置面板里。）
      // Q12：性能面板开关从画布按钮移到设置里
      const perfBtn = document.getElementById('setPerfBtn');
      if (perfBtn) perfBtn.addEventListener('click', () => {
        const hud = document.getElementById('perfHud');
        if (!hud) return;
        hud.classList.toggle('show');
        perfBtn.textContent = hud.classList.contains('show') ? '📊 已显示（点击隐藏）' : '📊 显示性能面板';
      });

      // 第 6.1 步：阴影三档循环切换（全部 → 仅建筑 → 关闭）。小兵是同屏数量最大的一类，
      // "仅建筑"档把它们排除掉，性能收益最大而观感损失最小，故作为默认。
      // P1 画质开关：统一的"读当前值 → 取反下发 → 按实际生效值刷新文案"三段式。
      // 一律以渲染器【返回的实际值】刷新按钮，避免 UI 与真实状态脱节（如渲染器为 null 时）。
      const bindFx = (id, get, set, onLabel, offLabel) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', () => {
          const r = window.__three;
          if (!r) return;
          const applied = set(r, !get(r));
          btn.textContent = applied ? onLabel : offLabel;
        });
      };
      bindFx('setPostFXBtn', r => r.postFX !== false, (r, v) => r.setPostFX(v),
             '✨ 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setBloomBtn', r => r.bloomOn !== false, (r, v) => r.setBloom(v),
             '🌟 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setToneBtn', r => !!r.toneMapOn, (r, v) => r.setToneMapping(v),
             '🎬 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setFxaaBtn', r => r.fxaaOn !== false, (r, v) => r.setFXAA(v),
             '🔷 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setPartBtn', r => r.units?.particlesOn !== false, (r, v) => r.setParticles(v),
             '✦ 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setVegBtn', r => r.vegOn !== false, (r, v) => r.setVegetation(v),
             '🌲 已开启（点击关闭）', '⭕ 已关闭（点击开启）');

      const shadowBtn = document.getElementById('setShadowBtn');
      if (shadowBtn) shadowBtn.addEventListener('click', () => {
        const order = ['all', 'static', 'off'];
        const labels = { all: '🌑 全部投影', static: '🏛️ 仅建筑投影', off: '⭕ 关闭阴影' };
        const cur = window.__three?.shadowLevel || 'off';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        const applied = window.__three?.setShadowLevel?.(next) || next;
        shadowBtn.textContent = labels[applied];
      });

      const wxToggle = document.getElementById('setWeatherToggleBtn');
      if (wxToggle) wxToggle.addEventListener('click', () => {
        const ws = window.__weather;
        if (!ws) return;
        ws.setEnabled(!ws.enabled);
        wxToggle.textContent = ws.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）';
        logFn(ws.enabled ? `🌦️ 天气系统已开启（本局平均主导时长约 ${ws.averageDuration}s）` : '⭕ 天气系统已关闭', 'spawn');
      });
      const wxCfg = document.getElementById('setWeatherCfgBtn');
      if (wxCfg) wxCfg.addEventListener('click', () => {
        window.__weatherPanel?.openConfig();
      });

      // v39（Q6）：游戏速度 0.5x / 1x / 2x
      overlay.querySelectorAll('[data-speed]').forEach(btn => {
        btn.addEventListener('click', () => {
          window.__gameSpeed = parseFloat(btn.dataset.speed);
          logFn(`⏱ 游戏速度 → ${window.__gameSpeed}x`, 'spawn');
          render();
        });
      });
      // v39（Q6）：快进——加速模拟真实跑完（非跳时钟，战斗照常发生）
      overlay.querySelectorAll('[data-ff]').forEach(btn => {
        btn.addEventListener('click', () => {
          const sec = parseInt(btn.dataset.ff, 10);
          window.__ffRemain = (window.__ffRemain || 0) + sec;
          logFn(`⏩ 快进 ${sec}s（加速模拟，战斗照常结算）`, 'spawn');
          render();
        });
      });

      // Q5：按阵营规则开关（统一 / 仅蓝 / 仅红）
      overlay.querySelectorAll('[data-rule]').forEach(btn => {
        btn.addEventListener('click', () => {
          const kind = btn.dataset.rule;
          const scope = btn.dataset.scope;   // 'both' | 'blue' | 'red'
          const rules = window.__towerRules[kind];
          if (scope === 'both') {
            const allOn = rules.blue && rules.red;
            rules.blue = rules.red = !allOn;
          } else {
            rules[scope] = !rules[scope];
          }
          const label = { invincible: '防御塔无敌', attackOff: '防御塔停火', waveOn: '小兵波次生成' }[kind];
          logFn(`⚙️ ${label}：🔵${rules.blue ? '开' : '关'} 🔴${rules.red ? '开' : '关'}`, 'spawn');
          this.open({ waveSystem, dragonSystem, entityContainer, mapSystem, laneWaveSystem }, logFn); // 重开刷新状态
        });
      });

      document.getElementById('setClearAllBtn').addEventListener('click', () => {
        const minions = entityContainer.getAllMinions(true);
        for (const m of minions) { m.alive = false; m.currentHP = 0; }
        entityContainer.purgeDead();
        logFn(`💀 清屏: 移除 ${minions.length} 个小兵`, 'death');
      });
      document.getElementById('setToggleWaveBtn')?.addEventListener('click', () => {
        waveSystem.paused = !waveSystem.paused;
        logFn(waveSystem.paused ? '⏸ 小兵波次已暂停' : '▶ 小兵波次已恢复', 'spawn');
        render();
      });
      document.getElementById('setSkipWaveBtn')?.addEventListener('click', () => {
        waveSystem.skipToNextWave();
        logFn('⏭ 跳过等待', 'spawn');
      });
      document.getElementById('setWaveInterval')?.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v) && v > 0) {
          CONFIG.gameRules.waveInterval = v;
          // 若当前剩余等待时间比新设置的间隔还长，直接收紧到新间隔，让修改立刻感知到效果
          if (waveSystem.nextWaveTime > v) waveSystem.nextWaveTime = v;
          logFn(`✅ 小兵波次间隔已设为 ${v}秒`, 'spawn');
        }
      });
      document.getElementById('setResetWaveBtn')?.addEventListener('click', () => {
        if (confirm('重置波次到第0波？')) {
          window.waveNumber = 0;
          waveSystem.waveNumber = 0;
          waveSystem.nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
          logFn('🔄 波次已重置', 'spawn');
        }
      });
      document.getElementById('setToggleDragonBtn').addEventListener('click', () => {
        dragonSystem.paused = !dragonSystem.paused;
        logFn(dragonSystem.paused ? '⏸ 巨龙波次已暂停' : '▶ 巨龙波次已恢复', 'spawn');
        render();
      });
      document.getElementById('setDragonFirstDelay').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v) && v >= 0) {
          dragonSystem.nextDragonTime = v;
          logFn(`✅ 下一条龙将在 ${v}秒后刷新`, 'spawn');
        }
      });
      document.getElementById('setExportLogBtn').addEventListener('click', () => {
        const ok = DebugLogger.downloadAsFile();
        logFn(ok ? '💾 日志已导出' : '❌ 日志导出失败', ok ? 'spawn' : 'death');
      });
      // v33（Q14）：日志精简为"一键导出文件"——复制按钮删除（导出文件覆盖同一用途且更可靠）
      document.getElementById('setSkipLaneWaveBtn')?.addEventListener('click', () => {
        if (laneWaveSystem) { laneWaveSystem.nextWaveTime = 0; logFn('⏭ 对战模式：立即生成下一波', 'spawn'); }
      });
      document.getElementById('setLanePathBtn')?.addEventListener('click', () => {
        window.__showLanePaths = !window.__showLanePaths;
        logFn(window.__showLanePaths ? '👁 小兵轨迹已显示' : '🙈 小兵轨迹已隐藏', 'spawn');
        render();
      });
      const toggleLaneWaveBtn = document.getElementById('setToggleLaneWaveBtn');
      if (toggleLaneWaveBtn) toggleLaneWaveBtn.addEventListener('click', () => {
        laneWaveSystem.paused = !laneWaveSystem.paused;
        logFn(laneWaveSystem.paused ? '⏸ 对战模式波次已暂停' : '▶ 对战模式波次已恢复', 'spawn');
        render();
      });
      const laneWaveIntervalInput = document.getElementById('setLaneWaveInterval');
      if (laneWaveIntervalInput) laneWaveIntervalInput.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v) && v > 0) {
          laneWaveSystem.waveInterval = v;
          if (laneWaveSystem.nextWaveTime > v) laneWaveSystem.nextWaveTime = v;
          logFn(`✅ 对战模式波次间隔已设为 ${v}秒`, 'spawn');
        }
      });
    };

    render();

    document.getElementById('modalActions').innerHTML = `<button id="settingsCloseBtn" class="primary">关闭</button>`;
    document.getElementById('settingsCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    if (!overlay._settingsCloseBound) {
      overlay._settingsCloseBound = true;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    }
  },
};
