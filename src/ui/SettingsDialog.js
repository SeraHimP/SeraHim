import { paneHtml } from './dialogShell.js';
import { CONFIG } from '../data/Config.js';
import { mountDialogFooter, makeSnapshotter } from './dialogFooter.js';
import { DebugLogger } from '../utils/DebugLogger.js';

/**
 * SettingsDialog.js
 * 设置窗口：整合此前散落在顶栏的操作按钮，并新增小兵/巨龙波次的独立暂停与间隔设置。
 */
// Q5：按阵营规则行（统一 / 仅蓝 / 仅红三键）。
// 语义：「统一」= 一键同开同关；「仅蓝/仅红」= 单独切换该阵营。
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
  /**
   * ==================== v43：HDR 提示从"笼统"改成"说清卡在哪一关" ====================
   * 用户："设置中的 HDR 开启不了，提示浏览器不支持，但是我用 HDR 测试网站提示支持 HDR。"
   *
   * 旧提示只有一句「🚫 浏览器不支持」—— 它既没说是哪一项不支持，也没说怎么办，
   * 而且当时的检测本身就查错了 API（见 ThreeRenderer.hdrSupported 的头注释），
   * 于是用户拿着一个"我的浏览器明明支持"的正确认知，对着一句错误的断言，无从下手。
   *
   * 现在四种情况分开说，每种都给出下一步动作；再配一块逐项 ✓✗ 的诊断读数。
   */
  _hdrLabel() {
    const r = (typeof window !== 'undefined') && window.__three;
    if (!r || !r.hdrDiagnose) return '—';
    const d = r.hdrDiagnose();
    if (!d.ok && !r.hdrOn) {
      if (d.reason === 'no-gl' || d.reason === 'no-drawingBufferStorage') return '🚫 浏览器太旧（缺 WebGL2 HDR 缓冲）';
      // 检测不过也可以点：强制开启会真去试一次，试不成会退到广色域。
      if (d.reason === 'no-colorSpace' || d.reason === 'colorSpace-rejected') return '🔒 需开 Chrome 实验功能（可点击强制尝试）';
      return '🚫 不可用（' + d.reason + '）';
    }
    if (r.hdrOn) {
      // 强制开启可能只落到 display-p3（广色域，不是真 HDR）——照实说，不冒充。
      return /^rec2100/.test(r.hdrMode || '') ? '🌈 已开启（点击关闭）'
                                              : '🎨 广色域已开（非真 HDR，点击关闭）';
    }
    return d.display ? '⭕ 已关闭（点击开启）' : '⭕ 已关闭（未检测到 HDR 屏，可强制开）';
  },

  _hdrDiagHtml() {
    const r = (typeof window !== 'undefined') && window.__three;
    if (!r || !r.hdrDiagnose) return '';
    const d = r.hdrDiagnose();
    const m = (ok, s) => `<span style="color:${ok ? '#4caf50' : '#f85149'};">${ok ? '✓' : '✗'} ${s}</span>`;
    let tip = '';
    if (d.reason === 'colorSpace-rejected' || d.reason === 'no-colorSpace') {
      tip = `<br><span style="color:var(--text-mute);">在地址栏打开 <b>chrome://flags/#enable-experimental-web-platform-features</b>
             设为 Enabled 并重启浏览器。这是浏览器的门槛，不是本项目能绕过的。</span>`;
    } else if (!d.display && d.ok) {
      tip = `<br><span style="color:var(--text-mute);">显示器未报告 HDR：自动模式会跳过，点上面的按钮可强制开启。</span>`;
    }
    const modeTxt = r.hdrOn
      ? `　<b style="color:#4caf50;">当前：${r.hdrMode || '?'}</b>`
      : '';
    return `${m(d.buffer, 'RGBA16F 绘制缓冲')}　${m(d.colorSpace, 'rec2100 色彩空间')}　${m(d.display, 'HDR 显示器')}${modeTxt}${tip}
      <br><span style="color:var(--text-mute);">注：HDR 测试网站测的多是 HDR 视频/图片，与 WebGL 画布 HDR 输出是两套能力。</span>`;
  },

  // ==================== v48：这两项在并入的构建里丢了，设置窗口因此整页空白 ====================
  // 用户："原有的设置窗口变成空白了。"
  //
  // 根因很直接：`render()` 里读 `this._tab` 决定渲染哪一页、读 `this._TABS` 渲染左侧导航，
  // 而这两个字段的**定义**在把「波次 / 世界」两页搬进游戏性编辑器那一轮被一起删掉了，
  // 只剩下两处引用。于是：
  //   · `this._tab` === undefined → 三个 `TAB === 'xxx'` 全不成立 → **正文是空字符串**；
  //   · `this._TABS` === undefined → paneHtml 的 groups[0].items 为 undefined → 左侧导航也空。
  // 两件事叠在一起就是"打开设置什么都没有"。
  //
  // 这里按**现在真正还渲染着的三页**重建（flow / quality / debug）——
  // 不要照抄旧版那四页：wave 与 world 的正文确实已经搬走了，写回去会得到两个空页签。
  _TABS: [
    { key: 'flow',    label: '⏱ 流程' },
    { key: 'quality', label: '🎨 画质' },
    { key: 'debug',   label: '🛠 调试' },
  ],
  _tab: 'flow',

  open(deps, logFn) {
    const { dragonSystem, entityContainer, mapSystem, laneWaveSystem } = deps;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '⚙️ 设置';

    const render = () => {
      const TAB = this._tab;
      // v43 Q1：统一到模板编辑器那套「左侧栏 + 右侧单页」。
      // 改动前是四个横排页签铺在正文上方，与模板编辑器的纵向导航是两种语言。
      // 正文一行没动 —— 换的只是它被摆进哪个容器。
      const body = `
        ${TAB === 'flow' ? `
        <div class="editor-section">
          <h4>⏱ 时间与流程</h4>
          <div class="slider-row"><label>游戏进行时间</label>
            <div style="flex:1;font-family:monospace;font-size:14px;padding:5px 0;">
              ${_fmtTime(window.gameTime || 0)}
              <span style="opacity:.6;font-size:11px;">（${Math.floor(window.gameTime || 0)}s）</span>
            </div>
          </div>
          <div class="slider-row"><label>当前波次</label>
            <div style="flex:1;font-size:13px;padding:5px 0;">
              第 <b>${laneWaveSystem?.waveNumber || 0}</b> 波　│　下一波 <b>${Math.ceil(laneWaveSystem?.nextWaveTime || 0)}</b>s
            </div>
          </div>
          <div class="slider-row"><label>游戏暂停</label>
            <button id="setGamePauseBtn" style="flex:1;">${window.gamePaused ? '▶ 继续' : '⏸ 暂停'}</button>
          </div>
          <div class="slider-row"><label title="真实加速模拟：战斗照常结算，不是跳时钟">游戏速度</label>
            <div style="flex:1;display:flex;gap:4px;">
              ${(CONFIG.tuning?.simSpeedOptions ?? [1, 2, 4, 8]).map(v => `<button data-speed="${v}" class="editor-tab ${(window.__gameSpeed || 1) === v ? 'active' : ''}" style="flex:1;">${v}x</button>`).join('')}
            </div>
          </div>
          <div class="pick-desc-box" style="font-size:11px;line-height:1.7;">
            v44：「快进 N 秒」已并入倍率（8x 就是它）。同时把每帧的模拟预算从
            <b>固定步数</b> 改成 <b>墙钟毫秒</b>（CONFIG.tuning.simBudgetMs = ${CONFIG.tuning?.simBudgetMs ?? 12}ms）——
            原来限步数，而单步耗时随单位数增长，满场时同样的步数就是几百毫秒的卡顿。
            现在倍率再高也只会「跑得慢一点」，不会卡住。
          </div>
        </div>
        <div class="editor-section">
          <h4>🛡 战场规则</h4>
          ${_ruleRow('invincible', '防御塔无敌', '🛡')}
          ${_ruleRow('attackOff', '防御塔停火', '🚫')}
          <div class="slider-row"><label>清屏（移除全部小兵）</label>
            <button id="setClearAllBtn" class="danger" style="flex:1;">💀 清屏</button>
          </div>
          <div class="slider-row"><label title="按当前地图与当前所有属性/覆写设置，从头重开一局">重置本局</label>
            <button id="setResetRunBtn" class="danger" style="flex:1;">🔄 重置本局</button>
          </div>
          <div style="font-size:11px;color:var(--text-mute);margin-top:2px;line-height:1.6;">
            重置会清空：全部单位与建筑、飞行中的弹道、对局时钟与波次、比分、巨龙进度（含已获得的龙魂）。<br>
            <b>不会</b>动你在模板编辑器里改过的任何数值（分层塔覆写、出兵编排、技能参数、天气权重…）。
          </div>
        </div>` : ''}

        ${TAB === 'quality' ? `
        <div class="editor-section">
          <h4>🎨 渲染</h4>
          <div class="slider-row"><label>阴影质量</label>
            <button id="setShadowBtn" style="flex:1;">${{ all: '🌑 全部投影', static: '🏛️ 仅建筑投影', off: '⭕ 关闭阴影' }[window.__three?.shadowLevel || 'off']}</button>
          </div>
          <div class="slider-row"><label>后处理总开关</label>
            <button id="setPostFXBtn" style="flex:1;">${window.__three?.postFX !== false ? '✨ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>辉光 Bloom</label>
            <button id="setBloomBtn" style="flex:1;">${window.__three?.bloomOn !== false ? '🌟 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>电影级色调 ACES</label>
            <button id="setToneBtn" style="flex:1;">${window.__three?.toneMapOn ? '🎬 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label title="WebGL 画布的 HDR 输出。注意它与「HDR 视频/图片能不能播」是两套不同的能力——测试网站说支持的通常是后者。">HDR 输出</label>
            <button id="setHdrBtn" style="flex:1;">${SettingsDialog._hdrLabel()}</button>
          </div>
          <div class="pick-desc-box" id="setHdrDiag" style="margin:-4px 0 8px;font-size:11px;line-height:1.7;">${SettingsDialog._hdrDiagHtml()}</div>
          <div class="slider-row"><label title="夜晚塔会照亮射程×1.2 的范围（真光源，能照到小兵）">塔夜间照明</label>
            <button id="setTowerLightBtn" style="flex:1;">${CONFIG.ui?.towerLight?.enabled !== false ? '🔦 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label title="auto=选中或有敌人时显示；always=一直显示（旧行为）；selected=只看选中">射程圈显示</label>
            <button id="setRingModeBtn" style="flex:1;">${
              ({ auto: '🎯 智能（选中/有敌人）', always: '👁 一直显示', selected: '🖱 只看选中' })[CONFIG.ui?.rangeRing?.mode || 'auto']
            }</button>
          </div>
          <div class="slider-row"><label>抗锯齿 FXAA</label>
            <button id="setFxaaBtn" style="flex:1;">${window.__three?.fxaaOn !== false ? '🔷 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label title="给模型边缘加一圈描边，低多边形风格化的关键一步">轮廓描边</label>
            <button id="setOutlineBtn" style="flex:1;">${window.__three?.outlineOn !== false ? '✏️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label title="环境光遮蔽：缝隙/接缝处自动变暗，让模型有实体感">环境光遮蔽 SSAO</label>
            <button id="setSsaoBtn" style="flex:1;">${window.__three?.ssaoOn !== false ? '🌑 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
        </div>
        <div class="editor-section">
          <h4>🌿 场景元素</h4>
          <div class="slider-row"><label>水晶粒子</label>
            <button id="setPartBtn" style="flex:1;">${window.__three?.units?.particlesOn !== false ? '✦ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>河道水面</label>
            <button id="setWaterBtn" style="flex:1;">${window.__three?.water?.enabled !== false ? '🌊 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>野区植被</label>
            <button id="setVegBtn" style="flex:1;">${window.__three?.vegOn !== false ? '🌲 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>天气可视化</label>
            <button id="setWfxBtn" style="flex:1;">${window.__three?.weatherFx?.enabled !== false ? '🌧️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>地面参考网格</label>
            <button id="setGridBtn" style="flex:1;">${window.__gridOn ? '▦ 已显示（点击隐藏）' : '⭕ 已隐藏（点击显示）'}</button>
          </div>
        </div>
        <div class="editor-section">
          <h4>🧭 小兵寻路</h4>
          <p style="color:#8b949e;font-size:11px;margin:4px 0 8px;">两项都是地形卡死的解药，独立开关；关掉可对照观察。</p>
          <div class="slider-row"><label>预判式地形避障</label>
            <button id="setTerrAvoidBtn" style="flex:1;">${window.__terrainAvoid !== false ? '👀 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          <div class="slider-row"><label>兵线回流场（脱困）</label>
            <button id="setLaneFlowBtn" style="flex:1;">${window.__laneFlow !== false ? '🧲 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
          </div>
          ${mapSystem?.hasWalls?.() ? `
          <div class="slider-row"><label>小兵轨迹线</label>
            <button id="setLanePathBtn" style="flex:1;">${window.__showLanePaths ? '👁 已显示（点击隐藏）' : '🙈 已隐藏（点击显示）'}</button>
          </div>` : ''}
          <div class="slider-row"><label>基地圈</label>
            <button id="setBaseCircleBtn" style="flex:1;">${CONFIG.tuning?.showBaseCircle ? '👁 已显示（点击隐藏）' : '🙈 已隐藏（点击显示）'}</button>
          </div>
        </div>` : ''}

        ${TAB === 'debug' ? `
        <div class="editor-section">
          <h4>🛠 调试</h4>
          <div class="slider-row"><label>性能面板</label>
            <button id="setPerfBtn" style="flex:1;">${document.getElementById('perfHud')?.classList.contains('show') ? '📊 已显示（点击隐藏）' : '📊 显示性能面板'}</button>
          </div>
          <!-- v47：顶栏的【📜 日志】按钮删掉之后搬到这里（用户定稿"移动到设置里"）。
               操作的仍是同一个 #logArea，行为一字未改，只是换了个入口。 -->
          <div class="slider-row"><label title="屏幕底部的事件日志条">事件日志</label>
            <button id="setLogAreaBtn" style="flex:1;">${document.getElementById('logArea')?.classList.contains('show') ? '📜 已显示（点击隐藏）' : '📜 显示事件日志'}</button>
          </div>
          <div class="slider-row"><label>调试日志（${DebugLogger.entries.length}条）</label>
            <button id="setExportLogBtn" style="flex:1;">💾 导出日志文件</button>
          </div>
        </div>` : ''}
      `;
      document.getElementById('modalBody').innerHTML = paneHtml({
        groups: [{ items: this._TABS }], activeKey: TAB, body, navAttr: 'settab',
      });
      bindEvents();
    };

    const bindEvents = () => {
      // 标签页切换（只换正文，标题/底部按钮不动）
      overlay.querySelectorAll('[data-settab]').forEach(btn => {
        btn.addEventListener('click', () => { this._tab = btn.dataset.settab; render(); });
      });
      // 熵/世界耦合/天气/波次运行控制已搬到"游戏性"（模板编辑器），这里不再绑定。

      // 游戏暂停：此前这个按钮只有外观、没有任何监听器，点了毫无反应。
      document.getElementById('setGamePauseBtn')?.addEventListener('click', () => {
        window.gamePaused = !window.gamePaused;
        logFn(window.gamePaused ? '⏸ 游戏已暂停' : '▶ 游戏已继续', 'spawn');
        render();
      });

      // 地面参考网格（用户："地面上会显示格子，不要显示格子" → 默认关，这里可按需打开）。
      // 网格画在静态批里，改完必须让静态层重建才会真正消失/出现。
      const bindFlag = (id, key, on, off) => {
        document.getElementById(id)?.addEventListener('click', () => {
          window[key] = window[key] === false;
          logFn(window[key] !== false ? on : off, 'spawn');
          render();
        });
      };
      bindFlag('setTerrAvoidBtn', '__terrainAvoid', '👀 预判式地形避障已开启', '⭕ 预判式地形避障已关闭');
      bindFlag('setLaneFlowBtn', '__laneFlow', '🧲 兵线回流场已开启', '⭕ 兵线回流场已关闭');

      document.getElementById('setGridBtn')?.addEventListener('click', () => {
        window.__gridOn = !window.__gridOn;
        window.__three?.fx?.markStaticDirty?.();
        logFn(window.__gridOn ? '▦ 地面网格已显示' : '⭕ 地面网格已隐藏', 'spawn');
        render();
      });
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
      // v47：事件日志开关（原顶栏 #toggleLogBtn）。
      const logAreaBtn = document.getElementById('setLogAreaBtn');
      if (logAreaBtn) logAreaBtn.addEventListener('click', () => {
        const la = document.getElementById('logArea');
        if (!la) return;
        la.classList.toggle('show');
        logAreaBtn.textContent = la.classList.contains('show') ? '📜 已显示（点击隐藏）' : '📜 显示事件日志';
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
      bindFx('setOutlineBtn', r => r.outlineOn !== false, (r, v) => r.setOutline(v),
             '✏️ 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setSsaoBtn', r => r.ssaoOn !== false, (r, v) => r.setSSAO(v),
             '🌑 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      // HDR：手动切换要同时写 CONFIG.ui.hdr.force，否则下次自动判定会把它覆盖回去。
      document.getElementById('setHdrBtn')?.addEventListener('click', (ev) => {
        const r = window.__three;
        if (!r) return;
        // v43：不再因为"检测说不支持"就静默 return。
        // 用户："HDR 那里设置可以强制开启。" —— 检测再准也只是我们的判断，
        // 而这次的教训正是检测本身查错了 API。所以按钮永远可点：
        // 检测通过就正常开；检测不通过就走强制路径（setHDR 里 force===true 会跳过能力检查
        // 直接试一次），真开不了会被 try/catch 接住降级，画面不会坏。
        const supported = r.hdrSupported?.();
        const want = !r.hdrOn;
        CONFIG.ui.hdr.force = want;
        const applied = r.setHDR(want);
        // 文案与诊断读数都走同一份实现，避免"按钮说开了、读数说没开"这种自相矛盾
        ev.target.textContent = SettingsDialog._hdrLabel();
        const diag = document.getElementById('setHdrDiag');
        if (diag) diag.innerHTML = SettingsDialog._hdrDiagHtml();
        if (want && !applied) {
          const d = r.hdrDiagnose?.();
          logFn(d && (d.reason === 'colorSpace-rejected' || d.reason === 'no-colorSpace')
            ? '⚠️ 强制开启失败：浏览器拒绝了 HDR 色彩空间。请在 chrome://flags 开启「Experimental Web Platform features」后重启浏览器'
            : '⚠️ HDR 开启失败，已降级为 SDR（见控制台与上方诊断读数）', 'spawn');
        } else if (want && applied && !supported) {
          logFn('🌈 HDR 已强制开启（能力检测本判定为不支持，实际试成功了）', 'spawn');
        }
      });
      document.getElementById('setTowerLightBtn')?.addEventListener('click', (ev) => {
        CONFIG.ui.towerLight.enabled = CONFIG.ui.towerLight.enabled === false;
        ev.target.textContent = CONFIG.ui.towerLight.enabled
          ? '🔦 已开启（点击关闭）' : '⭕ 已关闭（点击开启）';
      });
      document.getElementById('setRingModeBtn')?.addEventListener('click', (ev) => {
        const order = ['auto', 'always', 'selected'];
        const cur = CONFIG.ui.rangeRing.mode || 'auto';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        CONFIG.ui.rangeRing.mode = next;
        ev.target.textContent = ({ auto: '🎯 智能（选中/有敌人）', always: '👁 一直显示', selected: '🖱 只看选中' })[next];
      });
      bindFx('setPartBtn', r => r.units?.particlesOn !== false, (r, v) => r.setParticles(v),
             '✦ 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setVegBtn', r => r.vegOn !== false, (r, v) => r.setVegetation(v),
             '🌲 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setWaterBtn', r => r.water?.enabled !== false, (r, v) => r.setWater(v),
             '🌊 已开启（点击关闭）', '⭕ 已关闭（点击开启）');
      bindFx('setWfxBtn', r => r.weatherFx?.enabled !== false, (r, v) => r.setWeatherFx(v),
             '🌧️ 已开启（点击关闭）', '⭕ 已关闭（点击开启）');

      const shadowBtn = document.getElementById('setShadowBtn');
      if (shadowBtn) shadowBtn.addEventListener('click', () => {
        const order = ['all', 'static', 'off'];
        const labels = { all: '🌑 全部投影', static: '🏛️ 仅建筑投影', off: '⭕ 关闭阴影' };
        const cur = window.__three?.shadowLevel || 'off';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        const applied = window.__three?.setShadowLevel?.(next) || next;
        shadowBtn.textContent = labels[applied];
      });

      // 熵/天气/波次相关的运行时控制与巨龙面板已整体搬到"游戏性"（模板编辑器），
      // 这里不再绑定 setWeatherToggleBtn / setWeatherCfgBtn / setToggleWaveBtn 等。

      // v39（Q6）：游戏速度 0.5x / 1x / 2x
      overlay.querySelectorAll('[data-speed]').forEach(btn => {
        btn.addEventListener('click', () => {
          window.__gameSpeed = parseFloat(btn.dataset.speed);
          logFn(`⏱ 游戏速度 → ${window.__gameSpeed}x`, 'spawn');
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
          this.open({ dragonSystem, entityContainer, mapSystem, laneWaveSystem }, logFn); // 重开刷新状态
        });
      });

      // v43：重置本局。走 CTX.__resetRun（唯一实现，见 main.js 那段注释）——
      // UI 只负责问一句、调一下、重绘，不在这里另写一套清场逻辑。
      document.getElementById('setResetRunBtn')?.addEventListener('click', () => {
        const app = window.CTX || window.__app;
        if (!app?.__resetRun) { logFn('⚠️ 重置入口不可用', 'death'); return; }
        app.__resetRun();
        logFn('🔄 已重置本局', 'spawn');
        render();
      });
      document.getElementById('setClearAllBtn')?.addEventListener('click', () => {
        const minions = entityContainer.getAllMinions(true);
        for (const m of minions) { m.alive = false; m.currentHP = 0; }
        entityContainer.purgeDead();
        logFn(`💀 清屏: 移除 ${minions.length} 个小兵`, 'death');
      });
      document.getElementById('setExportLogBtn')?.addEventListener('click', () => {
        const ok = DebugLogger.downloadAsFile();
        logFn(ok ? '💾 日志已导出' : '❌ 日志导出失败', ok ? 'spawn' : 'death');
      });
      // v33（Q14）：日志精简为"一键导出文件"——复制按钮删除（导出文件覆盖同一用途且更可靠）
      document.getElementById('setLanePathBtn')?.addEventListener('click', () => {
        window.__showLanePaths = !window.__showLanePaths;
        logFn(window.__showLanePaths ? '👁 小兵轨迹已显示' : '🙈 小兵轨迹已隐藏', 'spawn');
        render();
      });
      // 基地圈只管画不画；基地光环是玩法效果（towerPassives），与这个开关无关。
      document.getElementById('setBaseCircleBtn')?.addEventListener('click', () => {
        CONFIG.tuning.showBaseCircle = !CONFIG.tuning.showBaseCircle;
        logFn(CONFIG.tuning.showBaseCircle ? '👁 基地圈已显示（光环效果不受影响）' : '🙈 基地圈已隐藏（光环效果照常）', 'spawn');
        render();
      });
    };

    // 渲染器侧开关的回推口。取消回滚时必须调它 —— 那些开关的权威值在渲染器实例上，
    // 快照只还原了 CONFIG 与 window.__* 那部分。
    const applyRendererFlags = () => {
      const t = window.__three;
      if (t && t.setHDR) t.setHDR(CONFIG.ui?.hdr?.force ?? null);
    };

    render();

    // Bug 修复（用户定稿）：这个面板的击杀计数只在"点了面板里的按钮"时才会重画，
    // 龙魂的实际结算（DragonSystem._resolveSoul）本身是杀龙的当帧立即生效的、没有延迟——
    // 面板显示跟不上是纯粹的"没人告诉它该重画"，不是计数漏加。之前只要杀龙时这个面板正开着
    // 又没点任何按钮，看到的数字就是打开那一刻的旧值，直到用户凑巧点了点别的才刷新，
    // 表现成"杀满第4条没反应，多杀几条后忽然跳上去"。
    // 现在订阅 dragon:killed / dragon:soulResolved，面板开着的时候杀龙会实时刷新。
    // 用 overlay 上挂一份"当前钩子"引用，每次 open() 都先解绑旧的再绑新的，避免设置面板
    // 反复打开导致监听器越叠越多（同一条击杀最终触发好几次 render）。
    const bus = dragonSystem.eventBus;
    if (bus) {
      if (overlay._dragonRenderHook) {
        bus.off('dragon:killed', overlay._dragonRenderHook);
        bus.off('dragon:soulResolved', overlay._dragonRenderHook);
      }
      const hook = () => { if (overlay.classList.contains('open')) render(); };
      overlay._dragonRenderHook = hook;
      bus.on('dragon:killed', hook);
      bus.on('dragon:soulResolved', hook);
    }

    // ==================== 统一页脚：应用 / 确定 / 取消（用户定稿）====================
    // 本窗口的开关是**即时预览**的（阴影/泛光/水面点一下就能看到效果），那是它们的价值，
    // 不改成"要按应用才生效"。所以"取消"必须靠快照回滚才有意义 ——
    // 否则点开设置、乱翻一通、点取消，改动全留着，那个按钮就是个谎。
    // 快照要覆盖本窗口会动的**全部**状态；漏一个 = 那一项取消不掉，比没有取消更糟。
    const snap = makeSnapshotter({ CONFIG, window },
      ['CONFIG.world.couplings', 'CONFIG.world.dayNightBonus', 'CONFIG.world.entropy',
       'CONFIG.ui.towerLight.enabled', 'CONFIG.ui.rangeRing.mode', 'CONFIG.ui.hdr.force',
       'CONFIG.gameRules.waveInterval', 'CONFIG.gameRules.firstWaveDelay', 'CONFIG.tuning.showBaseCircle',
       'window.__gameSpeed', 'window.__gridOn', 'window.__showLanePaths',
       // v44：快照键表里去掉了那个已删的「快进剩余秒数」字段。
      // ⚠️ 注释必须**独占一行**：_harness 的 stripComments 只剥整行注释，
      // 行尾注释会留在断言看到的文本里 —— 本仓库第 N 次栽在自证式断言上，
      // 这次就是我把「已删」两个字写在行尾，结果断言自己匹配到了自己。
      'window.__laneFlow', 'window.__terrainAvoid', 'window.__towerRules']);
    mountDialogFooter('modalActions', {
      applyLabel: '应用设置',
      snapshot: snap.snapshot,
      restore: (b) => { snap.restore(b); applyRendererFlags(); },
      rerender: render,
      close: () => overlay.classList.remove('open'),
    });
  },
};
