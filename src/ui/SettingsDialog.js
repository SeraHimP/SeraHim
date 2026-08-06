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

  /**
   * ==================== v43：巨龙面板重做 ====================
   * 用户："设置里的巨龙面板重做，目前的啥功能也没有。"
   *
   * 说得对。改版前整块只有两样东西：一个暂停按钮 + 一个"首条龙延迟"输入框，
   * 而且那个输入框写的是 `dragonSystem.nextDragonTime`（**倒计时剩余值**，不是配置），
   * 面板一重开数字就变了 —— 看起来像个设置项，其实是个会自己乱跳的只读量。
   *
   * 现在按"看得见 + 改得动 + 立刻能验"三件事重做：
   *   ① 实时状态：下一条龙倒计时/类型、已刷数量、场上现存龙
   *   ② 争夺进度：双方元素龙击杀数、离成魂还差几条、已成的魂
   *   ③ 开关：生成 / 效果 两个独立开关（CONFIG.dragonToggles）+ 暂停
   *   ④ 节奏：首条延迟、元素龙间隔、远古龙间隔（都写回 CONFIG，不是写倒计时）
   *   ⑤ 即时操作：立刻刷一条（元素/远古）、把龙魂直接判给某方、清空巨龙进度
   * 只读量与可写配置在版式上分开，不再混成一片。
   */
  _dragonPanelHtml(ds, ents) {
    if (!ds) return '';
    const st = ds.getState ? ds.getState() : {};
    const D = (CONFIG.gameRules && CONFIG.gameRules.dragon) || {};
    const tg = CONFIG.dragonToggles || {};
    const spawnOn = tg.spawn !== false, fxOn = tg.effect !== false;
    const alive = ents ? ents.getAll(true).filter(e => e.type === 'dragon') : [];
    const nextIsAncient = !!st.soulResolved;
    const soulTxt = (f) => {
      const arr = (st.souls && st.souls[f]) || [];
      return arr.length ? arr.map(id => (window.__app?.SkillLibrary?.[id]?.icon || '🐉')).join('') : '—';
    };
    const need = Math.max(0, (st.soulThreshold ?? 4) - (st.factionTotals?.blue ?? 0));
    const needR = Math.max(0, (st.soulThreshold ?? 4) - (st.factionTotals?.red ?? 0));

    return `<div class="editor-section">
      <h4>🐉 巨龙</h4>

      <div class="pick-desc-box" style="margin-bottom:8px;font-size:11px;line-height:1.8;">
        下一条：<b>${ds.paused ? '⏸ 已暂停' : (spawnOn ? `${nextIsAncient ? '🐲 远古龙' : '🐉 元素龙'} · ${_fmtTime(ds.nextDragonTime || 0)}` : '⛔ 生成已关闭')}</b>
        　｜　已刷：元素 <b>${st.elementDragonSpawned ?? 0}</b>/<b>${st.elementDragonTotal ?? 6}</b>　远古 <b>${ds.ancientSpawned ?? 0}</b>
        　｜　场上：<b>${alive.length}</b> 条<br>
        🔵 蓝方击杀 <b>${st.factionTotals?.blue ?? 0}</b>（还差 ${need} 条成魂）　魂：${soulTxt('blue')}<br>
        🔴 红方击杀 <b>${st.factionTotals?.red ?? 0}</b>（还差 ${needR} 条成魂）　魂：${soulTxt('red')}<br>
        <span style="color:var(--text-mute);">成魂规则：${st.elementDragonTotal ?? 6} 条元素龙打完结算一次，
        ≥${st.soulThreshold ?? 4} 条者成魂；都不到则无魂。成魂后只刷远古龙。击杀数只算元素龙。</span>
      </div>

      <div class="slider-row"><label>巨龙生成</label>
        <button id="setToggleDragonBtn" style="flex:1;">${ds.paused ? '▶ 恢复计时' : '⏸ 暂停计时'}</button>
        <button id="setDragonSpawnBtn" style="flex:1;">${spawnOn ? '✅ 允许生成' : '⛔ 禁止生成'}</button>
      </div>
      <div class="slider-row"><label title="关掉后龙仍会刷，但击杀不再发放巨龙之力/龙魂">龙之奖励效果</label>
        <button id="setDragonFxBtn" style="flex:1;">${fxOn ? '✅ 已开启' : '⭕ 已关闭'}</button>
      </div>

      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">节奏（写入 CONFIG，立即生效于下一次计时）</div>
        <div class="slider-row"><label style="font-size:11px;">首条龙延迟(秒)</label>
          <input type="number" class="dragon-cfg" data-k="firstDelay" step="10" min="0" value="${D.firstDelay ?? 60}" style="width:90px;"></div>
        <div class="slider-row"><label style="font-size:11px;">元素龙间隔(秒)</label>
          <input type="number" class="dragon-cfg" data-k="elementInterval" step="10" min="10" value="${(D.elementIntervals && D.elementIntervals[0]) ?? 300}" style="width:90px;"></div>
        <div class="slider-row"><label style="font-size:11px;">远古龙间隔(秒)</label>
          <input type="number" class="dragon-cfg" data-k="ancientInterval" step="10" min="10" value="${D.ancientInterval ?? 300}" style="width:90px;"></div>
        <div class="slider-row"><label style="font-size:11px;">当前倒计时(秒)</label>
          <input type="number" id="setDragonCountdown" step="5" min="0" value="${Math.round(ds.nextDragonTime || 0)}" style="width:90px;">
          <span style="font-size:11px;color:var(--text-mute);">只改这一次，不改配置</span></div>
      </div>

      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">即时操作（不计入比分，日志标 [编辑器]）</div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button id="setDragonSpawnNowBtn" style="flex:1;">🐉 立刻刷一条</button>
          <button id="setDragonKillAllBtn" style="flex:1;">💀 清掉场上的龙</button>
        </div>
        <div style="display:flex;gap:6px;">
          <button id="setDragonSoulBlueBtn" style="flex:1;">🔵 直接判给蓝方</button>
          <button id="setDragonSoulRedBtn" style="flex:1;">🔴 直接判给红方</button>
          <button id="setDragonResetBtn" style="flex:1;">↺ 清空巨龙进度</button>
        </div>
      </div>
    </div>` + `` ;
  },

  _bindDragonEvents(overlay, ds, ents, logFn, render) {
    if (!ds) return;
    const tag = '[编辑器]';
    const $ = (id) => document.getElementById(id);
    $('setToggleDragonBtn')?.addEventListener('click', () => {
      ds.paused = !ds.paused;
      logFn(ds.paused ? '⏸ 巨龙计时已暂停' : '▶ 巨龙计时已恢复', 'spawn');
      render();
    });
    $('setDragonSpawnBtn')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.spawn = CONFIG.dragonToggles.spawn === false;
      logFn(CONFIG.dragonToggles.spawn ? '✅ 巨龙生成已允许' : '⛔ 巨龙生成已禁止', 'spawn');
      render();
    });
    $('setDragonFxBtn')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.effect = CONFIG.dragonToggles.effect === false;
      logFn(CONFIG.dragonToggles.effect ? '✅ 龙之奖励已开启' : '⭕ 龙之奖励已关闭', 'spawn');
      render();
    });
    overlay.querySelectorAll('.dragon-cfg').forEach(inp => inp.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      const k = e.target.dataset.k;
      CONFIG.gameRules.dragon = CONFIG.gameRules.dragon || {};
      // elementIntervals 是个数组（支持"每条龙间隔不同"），面板只暴露第一项 ——
      // 想要逐条不同的节奏走模板编辑器的巨龙页，那里是完整数组。
      if (k === 'elementInterval') CONFIG.gameRules.dragon.elementIntervals = [v];
      else CONFIG.gameRules.dragon[k] = v;
      logFn(`${tag} 🐉 ${k} → ${v}s`, 'spawn');
    }));
    $('setDragonCountdown')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        ds.nextDragonTime = v;
        logFn(`${tag} ⏱ 下一条龙将在 ${v}s 后刷新（只改这一次）`, 'spawn');
      }
    });
    $('setDragonSpawnNowBtn')?.addEventListener('click', () => {
      ds.nextDragonTime = 0;
      const before = (ds.elementDragonSpawned || 0) + (ds.ancientSpawned || 0);
      ds.spawnDragon?.();
      const after = (ds.elementDragonSpawned || 0) + (ds.ancientSpawned || 0);
      logFn(after > before ? `${tag} 🐉 已立刻刷出一条龙` : `${tag} ⚠️ 刷龙失败（生成开关关着？）`, 'spawn');
      render();
    });
    $('setDragonKillAllBtn')?.addEventListener('click', () => {
      let n = 0;
      for (const e of ents.getAll(true)) {
        if (e.type !== 'dragon') continue;
        e.alive = false; e.currentHP = 0; n++;
        // 走 entity:death 而不是直接 remove：死亡归属/奖励发放都挂在那个事件上，
        // 绕过去的话"编辑器杀的龙不给奖励"，与自然死亡两套行为。
        ds.eventBus?.emit?.('entity:death', { entityId: e.id });
      }
      logFn(`${tag} 💀 清掉了场上 ${n} 条龙`, 'death');
      render();
    });
    const grant = (fac) => {
      ds._resolveSoul?.(fac);
      logFn(`${tag} 🐉 龙魂已直接判给${fac === 'blue' ? '蓝方' : '红方'}`, 'spawn');
      render();
    };
    $('setDragonSoulBlueBtn')?.addEventListener('click', () => grant('blue'));
    $('setDragonSoulRedBtn')?.addEventListener('click', () => grant('red'));
    $('setDragonResetBtn')?.addEventListener('click', () => {
      ds.resetRun?.();
      logFn(`${tag} ↺ 巨龙进度已清空（击杀数、龙魂、计时）`, 'spawn');
      render();
    });
  },

  // 用户反馈"目前的设置界面太杂乱了，按TAB标签分类显示"：
  // 一屏 30+ 行全糊在一起，画质开关和波次参数混排。改为四个标签页，
  // 当前页记在 _tab 上，重开设置面板会停在上次那一页。
  _TABS: [
    { key: 'flow',    label: '⏱ 流程' },
    { key: 'quality', label: '🎨 画质' },
    { key: 'wave',    label: '🌊 波次' },
    { key: 'world',   label: '🌍 世界 · 调试' },
  ],
  _tab: 'flow',

  // ==================== 🌍 世界耦合 · 熵（P5）====================
  // 这几项此前【只能改源码】。用户的规矩是"所有的都不要硬编码，都应该是可编辑的软编码"，
  // 而熵是全局非对称机制，调它的频率只会比别的更高，没有面板等于没法用。
  //
  // 每条耦合独立开关、默认全关；全关时世界层不产生任何修正，行为与接入前逐位一致。
  _COUPLINGS: [
    { key: 'dayNight',          label: '昼夜 → 攻守', hint: '白天小兵占优 / 夜晚防御塔占优（双方对称）' },
    { key: 'entropyToUnits',    label: '熵 → 单位',   hint: '高熵利红（混乱）、低熵利蓝（秩序）' },
    { key: 'entropyToWeather',  label: '熵 → 天气',   hint: '熵越高极端天气越频繁' },
    { key: 'entropyToDayNight', label: '熵 → 昼夜',   hint: '熵越高夜晚越长' },
  ],
  // 数值项集中在这里声明，渲染与回写共用同一份，不会出现"面板改 A、运行时读 B"。
  _WORLD_FIELDS: [
    { path: 'dayPeriodSec', label: '一天时长(秒)', step: 30 },
    { path: 'dayNightBonus.day.moveSpeedPct',    label: '白天·小兵移速(%)', step: 1 },
    { path: 'dayNightBonus.day.attackDamagePct', label: '白天·小兵攻击(%)', step: 1 },
    { path: 'dayNightBonus.night.attackDamagePct', label: '夜晚·塔攻击(%)', step: 1 },
    { path: 'dayNightBonus.night.attackRangeFlat', label: '夜晚·塔射程', step: 5 },
    { path: 'entropyBonus.attackDamagePct', label: '熵·攻击幅度(%)', step: 1 },
    { path: 'entropyBonus.armorFlat',       label: '熵·护甲幅度',     step: 1 },
    { path: 'entropy.coreTotal',    label: '核总数（恒定）', step: 1 },
    { path: 'entropy.chargePerCore', label: '夺一核所需充能', step: 10 },
    { path: 'entropy.chargeDecayPerSec', label: '充能每秒衰减', step: 0.1 },
    { path: 'entropy.coreReturnSec', label: '归还一核间隔(秒)', step: 10 },
    { path: 'entropy.gainMinion',   label: '充能·击杀小兵', step: 1 },
    { path: 'entropy.gainTower',    label: '充能·摧毁建筑', step: 5 },
    { path: 'entropy.volatilityPct', label: '红核·波动放大(%)', step: 1 },
    { path: 'entropy.nightStretchPct', label: '熵·夜晚延长(%)', step: 5 },
  ],
  _getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },
  _setPath(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const t = ks.reduce((o, k) => (o[k] = o[k] || {}), obj);
    t[last] = v;
  },

  _renderWorldSection() {
    const W = CONFIG.world || {};
    const cp = W.couplings || {};
    const ws = window.CTX?.__world;
    // 实时快照：调这些数值时最需要的就是"现在到底是多少"，否则纯盲调。
    const live = ws
      ? `<div class="pick-desc-box" style="margin-bottom:8px;font-size:11px;">
           ${ws.entropySystem ? ws.entropySystem.describe() : ''}<br>
           昼夜：${ws.daynight.label}（相位 ${ws.daynight.phase.toFixed(2)}）
         </div>`
      : `<div class="pick-desc-box" style="margin-bottom:8px;font-size:11px;">（世界状态未接入，进入对战后显示实时值）</div>`;

    const toggles = this._COUPLINGS.map(c => {
      const on = cp[c.key] === true;
      return `<div class="slider-row"><label title="${c.hint}">${c.label}</label>
        <button class="editor-tab ${on ? 'active' : ''}" data-coupling="${c.key}" style="flex:1;font-size:11px;">
          ${on ? '✅ 已开启' : '⭕ 已关闭'}</button></div>`;
    }).join('');

    const fields = this._WORLD_FIELDS.map(f => {
      const v = this._getPath(W, f.path);
      if (v === undefined) return '';
      return `<div class="slider-row"><label style="font-size:11px;">${f.label}</label>
        <input type="number" class="world-field" data-path="${f.path}" step="${f.step}" value="${v}" style="width:90px;"></div>`;
    }).join('');

    return `<div class="editor-section">
      <h4>🌍 世界耦合 · 熵</h4>
      ${live}
      <div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
        每条耦合独立开关，默认全关；全关时世界层不产生任何修正。
        熵：0=绝对秩序（利蓝） 0.5=中性 1=绝对混乱（利红）。
      </div>
      ${toggles}
      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">数值（改完点下方【应用世界数值】）</div>
        ${fields}
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button id="setWorldApplyBtn" style="flex:1;">✅ 应用世界数值</button>
          <button id="setWorldResetEntropyBtn" style="flex:1;">↺ 三核归零</button>
        </div>
      </div>
    </div>`;
  },

  _bindWorldEvents(overlay, logFn, render) {
    overlay.querySelectorAll('[data-coupling]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.coupling;
      CONFIG.world.couplings[k] = !CONFIG.world.couplings[k];
      logFn(`🌍 耦合「${k}」：${CONFIG.world.couplings[k] ? '开' : '关'}`, 'spawn');
      render();
    }));
    document.getElementById('setWorldApplyBtn')?.addEventListener('click', () => {
      let n = 0;
      overlay.querySelectorAll('.world-field').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { this._setPath(CONFIG.world, inp.dataset.path, v); n++; }
      });
      logFn(`🌍 世界数值已更新（${n} 项）`, 'spawn');
      render();
    });
    document.getElementById('setWorldResetEntropyBtn')?.addEventListener('click', () => {
      window.CTX?.__world?.entropySystem?.reset();
      logFn('↺ 三核已归零（熵回到中性）', 'spawn');
      render();
    });
  },

  open(deps, logFn) {
    const { waveSystem, dragonSystem, entityContainer, mapSystem, laneWaveSystem } = deps;
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
              ${mapSystem?.active
                ? `对战 第 <b>${laneWaveSystem?.waveNumber || 0}</b> 波　│　下一波 <b>${Math.ceil(laneWaveSystem?.nextWaveTime || 0)}</b>s`
                : `沙盒 第 <b>${waveSystem?.waveNumber || 0}</b> 波`}
            </div>
          </div>
          <div class="slider-row"><label>游戏暂停</label>
            <button id="setGamePauseBtn" style="flex:1;">${window.gamePaused ? '▶ 继续' : '⏸ 暂停'}</button>
          </div>
          <div class="slider-row"><label title="真实加速模拟：战斗照常结算，不是跳时钟">游戏速度</label>
            <div style="flex:1;display:flex;gap:4px;">
              ${[1, 2, 4, 8].map(v => `<button data-speed="${v}" class="editor-tab ${(window.__gameSpeed || 1) === v ? 'active' : ''}" style="flex:1;">${v}x</button>`).join('')}
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

        ${TAB === 'wave' ? `
        ${mapSystem?.active ? `
        <div class="editor-section">
          <h4>⚔️ 对战模式 · 小兵波次</h4>
          <div class="slider-row"><label>双方波次生成</label>
            <button id="setToggleLaneWaveBtn" style="flex:1;">${laneWaveSystem?.paused ? '▶ 恢复' : '⏸ 暂停'}</button>
            <button id="setSkipLaneWaveBtn" style="flex:1;">⏭ 立即下一波</button>
          </div>
          ${_ruleRow('waveOn', '小兵随波次生成', '🌊', true)}
          <div class="slider-row"><label>波次生成间隔（秒）</label>
            <input type="number" id="setLaneWaveInterval" class="editor-number" value="${laneWaveSystem?.waveInterval || 30}" min="5" step="1">
          </div>
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
        ${SettingsDialog._dragonPanelHtml(dragonSystem, entityContainer)}` : ''}

        ${TAB === 'world' ? `
        <div class="editor-section">
          <h4>🌦️ 天气 · 昼夜</h4>
          <div class="slider-row"><label>天气系统（昼夜随其开关）</label>
            <button id="setWeatherToggleBtn" style="flex:1;">${window.__weather?.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
            <button id="setWeatherCfgBtn" style="flex:1;">⚙️ 天气配置…</button>
          </div>
        </div>
        ${this._renderWorldSection()}
        <div class="editor-section">
          <h4>🛠 调试</h4>
          <div class="slider-row"><label>性能面板</label>
            <button id="setPerfBtn" style="flex:1;">${document.getElementById('perfHud')?.classList.contains('show') ? '📊 已显示（点击隐藏）' : '📊 显示性能面板'}</button>
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
      if (this._tab === 'world') this._bindWorldEvents(overlay, logFn, render);

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
      // v43：巨龙面板整块重做，事件绑定收进 _bindDragonEvents（渲染与绑定一一对应，
      // 不再散在这个几百行的大 handler 里）。
      SettingsDialog._bindDragonEvents(overlay, dragonSystem, entityContainer, logFn, render);
      document.getElementById('setExportLogBtn')?.addEventListener('click', () => {
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
      // 基地圈只管画不画；基地光环是玩法效果（towerPassives），与这个开关无关。
      document.getElementById('setBaseCircleBtn')?.addEventListener('click', () => {
        CONFIG.tuning.showBaseCircle = !CONFIG.tuning.showBaseCircle;
        logFn(CONFIG.tuning.showBaseCircle ? '👁 基地圈已显示（光环效果不受影响）' : '🙈 基地圈已隐藏（光环效果照常）', 'spawn');
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

    // 渲染器侧开关的回推口。取消回滚时必须调它 —— 那些开关的权威值在渲染器实例上，
    // 快照只还原了 CONFIG 与 window.__* 那部分。
    const applyRendererFlags = () => {
      const t = window.__three;
      if (t && t.setHDR) t.setHDR(CONFIG.ui?.hdr?.force ?? null);
    };

    render();

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
    if (!overlay._settingsCloseBound) {
      overlay._settingsCloseBound = true;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    }
  },
};
