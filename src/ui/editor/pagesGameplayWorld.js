/**
 * pagesGameplayWorld.js —— "游戏性"大 tab 下的三个搬迁页面：巨龙与龙魂 / 天气 / 熵。
 *
 * 用户定稿："设置窗口里应该只包含对该系统的设置，而不包含游戏性的设置。"
 * 这三块原来分别在 SettingsDialog（龙魂状态、熵）和独立的 WeatherPanel 浮层里，
 * 现在收进模板编辑器，和批量加技能/加状态、出兵编排放在同一个"游戏性"分组。
 *
 * 巨龙与龙魂页顺带修了两个 bug（用户点名"现有的有功能性问题"）：
 *   ① 文案写的是旧规则"N 条元素龙打完统一结算"，实际早就是"谁先攒到阈值立即
 *      成魂"（DragonSystem._onDragonKilled 里当帧判定）——文案和真实规则不一致。
 *   ② "元素 X/6" 的 /6 是误导性的伪上限：elementDragonTotal 只用于展示，
 *      从未在生成逻辑里真正限制过第 7、8 条元素龙的出现——spawnDragon() 并没有
 *      读它做截断判断，只是文档化的期望值。
 * 新增的细粒度控制：单独给某一方装/卸某个具体龙魂、单独调某个元素的击杀计数。
 */
import { CONFIG } from '../../data/Config.js';
import { WeatherPanel } from '../WeatherPanel.js';

export const EDITOR_PAGES_GAMEPLAY_WORLD = {
  // ==================== 巨龙与龙魂 ====================
  _renderGameplayDragonContent() {
    const app = window.CTX?.__app;
    const ds = app?.dragonSystem;
    if (!ds) return `<div class="pick-desc-box">（巨龙系统未接入，进入对局后显示）</div>`;

    const st = ds.getState ? ds.getState() : ds;
    const soulNames = { fire: '炎魂', water: '潮魂', earth: '山魂', thunder: '雷魂',
      wind: '风魂', dark: '暗魂', poison: '毒魂', ancient: '远古之力' };

    const factionBlock = (fac, label) => {
      const kills = st.factionKills?.[fac] || {};
      const total = st.factionTotals?.[fac] ?? 0;
      const soul = st.souls?.[fac]?.[0] || null;
      const need = Math.max(0, (st.soulThreshold ?? 4) - total);
      const killRows = Object.entries(soulNames).filter(([k]) => k !== 'ancient').map(([k, name]) => `
        <div class="slider-row"><label style="font-size:11px;">${name}击杀</label>
          <input type="number" class="dg-kill-field" data-fac="${fac}" data-el="${k}" value="${kills[k] || 0}" min="0" style="width:60px;">
        </div>`).join('');
      return `<div class="editor-section">
        <h4>${label}</h4>
        <div class="pick-desc-box" style="font-size:11px;">
          击杀 ${total} 条${st.soulResolved ? '' : `（还差 ${need} 条成魂）`}　龙魂：${soul ? soulNames[soul] : '（无）'}
        </div>
        ${killRows}
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="dg-set-kills" data-fac="${fac}">✅ 应用击杀数</button>
          <select class="dg-soul-select" data-fac="${fac}" style="flex:1;">
            <option value="">－ 直接指定龙魂 －</option>
            ${Object.entries(soulNames).map(([k, n]) => `<option value="${k}" ${soul === k ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
          <button class="dg-set-soul" data-fac="${fac}">装上</button>
          <button class="dg-clear-soul" data-fac="${fac}">卸下</button>
        </div>
      </div>`;
    };

    return `
      <div class="pick-desc-box" style="font-size:11px;line-height:1.7;">
        成魂规则：任意一方先攒到 <b>${st.soulThreshold ?? 4}</b> 条元素龙击杀即刻成魂
        （先到先得，不是所有元素龙打完才统一结算）；并列时取击杀最多的元素类型，
        全部只有 1 层则随机选一个。远古之力限时 <b>${CONFIG.dragonSouls?.ancient?.durationSec ?? 240}</b> 秒，
        其余 7 条永久。
      </div>
      ${factionBlock('blue', '🔵 蓝方')}
      ${factionBlock('red', '🔴 红方')}
      <div class="editor-section">
        <h4>⚙️ 生成 / 效果开关</h4>
        <div class="slider-row"><label>巨龙生成</label>
          <button id="dgToggleSpawn" style="flex:1;">${CONFIG.dragonToggles?.spawn !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
        </div>
        <div class="slider-row"><label title="关掉后龙仍会刷，但不再造成/享受任何龙魂加成、宿怨、斩杀等效果">巨龙效果</label>
          <button id="dgToggleEffect" style="flex:1;">${CONFIG.dragonToggles?.effect !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
        </div>
      </div>
      <div class="editor-section">
        <h4>⚙️ 快捷操作</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button id="dgForceElement">🐲 立刻刷一条元素龙</button>
          <button id="dgForceAncient">🐉 立刻刷一条远古龙</button>
          <button id="dgKillAll" class="danger">💀 清场（走正常死亡结算，照常发奖励）</button>
          <button id="dgResetProgress" class="danger">↺ 清空巨龙进度（击杀数/龙魂/计时）</button>
        </div>
      </div>`;
  },

  _bindGameplayDragonEvents(overlay, logFn) {
    const app = window.CTX?.__app;
    const ds = app?.dragonSystem;
    if (!ds) return;
    const refresh = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplayDragonContent();
      this._bindGameplayDragonEvents(overlay, logFn);
    };

    overlay.querySelectorAll('.dg-set-kills').forEach(btn => {
      btn.addEventListener('click', () => {
        const fac = btn.dataset.fac;
        ds.factionKills[fac] = ds.factionKills[fac] || {};
        let total = 0;
        overlay.querySelectorAll(`.dg-kill-field[data-fac="${fac}"]`).forEach(inp => {
          const v = Math.max(0, parseInt(inp.value, 10) || 0);
          ds.factionKills[fac][inp.dataset.el] = v;
          total += v;
        });
        ds.factionTotals[fac] = total;
        // 手动改完数值后，按真实规则重新判定一次是否该立即成魂——
        // 不然会出现"手动改到4条了，但要等下一次真实击杀才触发结算"的错觉。
        if (!ds.soulResolved && total >= (ds._soulRule?.threshold ?? 4)) ds._resolveSoul(fac);
        logFn(`🐲 ${fac === 'blue' ? '蓝方' : '红方'}击杀数已手动设置（合计 ${total}）`, 'spawn');
        refresh();
      });
    });
    overlay.querySelectorAll('.dg-set-soul').forEach(btn => {
      btn.addEventListener('click', () => {
        const fac = btn.dataset.fac;
        const sel = overlay.querySelector(`.dg-soul-select[data-fac="${fac}"]`);
        const el = sel?.value;
        if (!el) { logFn('⚠️ 先选一个龙魂', 'error'); return; }
        ds.souls[fac] = [el];
        ds.soulOwner = fac;
        ds.soulResolved = true;
        logFn(`🐉 ${fac === 'blue' ? '蓝方' : '红方'}龙魂已手动指定`, 'spawn');
        refresh();
      });
    });
    overlay.querySelectorAll('.dg-clear-soul').forEach(btn => {
      btn.addEventListener('click', () => {
        const fac = btn.dataset.fac;
        ds.souls[fac] = [];
        if (ds.soulOwner === fac) { ds.soulOwner = null; ds.soulResolved = false; }
        logFn(`🐉 ${fac === 'blue' ? '蓝方' : '红方'}龙魂已卸下`, 'spawn');
        refresh();
      });
    });
    overlay.querySelector('#dgForceElement')?.addEventListener('click', () => {
      ds.nextDragonTime = 0;
      logFn('🐲 下一次刷新将提前生成一条元素龙', 'spawn');
    });
    overlay.querySelector('#dgForceAncient')?.addEventListener('click', () => {
      ds.soulUnlocked = true; ds.nextDragonTime = 0;
      logFn('🐉 下一次刷新将提前生成一条远古龙', 'spawn');
    });
    overlay.querySelector('#dgToggleSpawn')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.spawn = CONFIG.dragonToggles.spawn === false;
      logFn(`🐲 巨龙生成：${CONFIG.dragonToggles.spawn ? '开' : '关'}`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgToggleEffect')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.effect = CONFIG.dragonToggles.effect === false;
      logFn(`🐉 巨龙效果：${CONFIG.dragonToggles.effect ? '开' : '关'}`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgKillAll')?.addEventListener('click', () => {
      // 走正常的 entity:death 结算，不是直接 splice 数组——绕过去的话"编辑器杀的龙
      // 不给击杀奖励"，玩家清场调试后回来发现进度没变化，会以为清场按钮是坏的。
      const ec = app?.entityContainer;
      const dragons = ec?.getAll ? ec.getAll(true).filter(e => e.type === 'dragon') : [];
      for (const d of dragons) {
        d.currentHP = 0; d.alive = false;
        app?.eventBus?.emit?.('entity:death', { entityId: d.id });
      }
      logFn(`💀 已清场 ${dragons.length} 条龙（正常死亡结算，奖励照发）`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgResetProgress')?.addEventListener('click', () => {
      ds.resetRun?.();
      logFn('↺ 巨龙进度已清空', 'spawn');
      refresh();
    });
  },

  // ==================== 天气 ====================
  // 内容/交互全部还在 WeatherPanel.js 里（_renderConfigBody/_bindConfigBody），
  // 这里只是把它接到模板编辑器的页面容器上，不重复实现一遍。预报图原样保留。
  _renderGameplayWeatherContent() {
    return WeatherPanel._renderConfigBody();
  },
  _bindGameplayWeatherEvents(overlay, logFn) {
    WeatherPanel._bindConfigBody(overlay, logFn);
  },

  // ==================== 熵 · 世界耦合 ====================
  _COUPLINGS: [
    { key: 'dayNight',          label: '昼夜 → 攻守', hint: '白天小兵占优 / 夜晚防御塔占优（双方对称）' },
    { key: 'entropyToUnits',    label: '熵 → 单位',   hint: '高熵利红（混乱）、低熵利蓝（秩序）' },
    { key: 'entropyToWeather',  label: '熵 → 天气',   hint: '熵越高极端天气越频繁' },
    { key: 'entropyToDayNight', label: '熵 → 昼夜',   hint: '熵越高夜晚越长' },
  ],
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

  _renderGameplayEntropyContent() {
    const W = CONFIG.world || {};
    const cp = W.couplings || {};
    const ws = window.CTX?.__world;
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

    // 用户定稿：不用再有言语描述——原来这里有一段"每条耦合独立开关…
    // 熵：0=绝对秩序 0.5=中性 1=绝对混乱"的说明段落，含义已经在 _COUPLINGS 各条
    // 的 title/hint 里、以及下面滑条本身的取值范围里，去掉重复的大段文字。
    return `
      ${live}
      ${toggles}
      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        ${fields}
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button id="setWorldApplyBtn" style="flex:1;">✅ 应用世界数值</button>
          <button id="setWorldResetEntropyBtn" style="flex:1;">↺ 三核归零</button>
        </div>
      </div>`;
  },

  _bindGameplayEntropyEvents(overlay, logFn) {
    const render = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplayEntropyContent();
      this._bindGameplayEntropyEvents(overlay, logFn);
    };
    overlay.querySelectorAll('[data-coupling]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.coupling;
      CONFIG.world.couplings[k] = !CONFIG.world.couplings[k];
      logFn(`🌍 耦合「${k}」：${CONFIG.world.couplings[k] ? '开' : '关'}`, 'spawn');
      render();
    }));
    overlay.querySelector('#setWorldApplyBtn')?.addEventListener('click', () => {
      let n = 0;
      overlay.querySelectorAll('.world-field').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { this._setPath(CONFIG.world, inp.dataset.path, v); n++; }
      });
      logFn(`🌍 世界数值已更新（${n} 项）`, 'spawn');
      render();
    });
    overlay.querySelector('#setWorldResetEntropyBtn')?.addEventListener('click', () => {
      window.CTX?.__world?.entropySystem?.reset();
      logFn('↺ 三核已归零（熵回到中性）', 'spawn');
      render();
    });
  },
};
