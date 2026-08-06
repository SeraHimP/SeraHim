import { CONFIG } from '../data/Config.js';
import { paneHtml } from './dialogShell.js';
import { TOWER_MODEL_ROLES, towerModelTier } from '../data/towerModels.js';
import { SkillLibrary } from '../core/SkillLibrary.js';

/**
 * UnitAddDialog.js
 * 统一添加窗口（顶部横排按钮 tab 风格，与编辑器/模板编辑器视觉统一，不用卡片网格跳转）。
 *
 * 顶部一级 tab：防御塔 / 小兵 / 龙
 * 顶部二级 tab（仅"小兵"）：近战/远程/炮兵/超级兵/图腾/术士/蚀骨
 * 下方是该类型的详情配置区。
 *
 * 塔不参与穿梭框清单：点"建造防御塔"按钮走独立流程（选武器/被动 → 点击画布放置），
 * 与批量清单分开，因为每个塔都要单独选位置，批量意义不大。
 * 小兵与龙可以反复"加入清单"，最后一次性"批量生成"。
 */

const MINION_TYPES = ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram'];

const TYPE_META = {
  melee:   { label: '近战兵', icon: '🗡️', info: '近战攻击，高攻速，低血量' },
  ranged:  { label: '远程兵', icon: '🏹', info: '远程魔法攻击，中等属性' },
  siege:   { label: '炮兵', icon: '💣', info: '远程高伤，受塔伤害-30%，为周围小兵提供+20双抗光环' },
  super:   { label: '超级兵', icon: '🦾', info: '高血量高攻击，对塔有额外伤害，提供双抗+攻速光环' },
  totem:   { label: '图腾兵', icon: '🗿', info: '辅助型，图腾守护（护盾）、图腾光环（全属性）、图腾滋养（治疗强度）' },
  warlock: { label: '术士兵', icon: '🧙', info: '远程魔法，术法光环给周围普通小兵+攻击力+固定法穿' },
  corrupt: { label: '蚀骨兵', icon: '🦇', info: '攻击给塔叠加腐蚀（唯一被动，减双抗）' },
  ram:     { label: '攻城车', icon: '🛠️', info: '专职破塔：锁定建筑后进入攻城模式（攻速-50%/对建筑伤害+270%/每击自损20%最大生命），射程超过防御塔，对小兵-33%，受近战单位伤害+100%' },
};

const WEAPONS = {
  none: { label: '无武器', icon: '🚫' },
  // v33：增幅型已删除（"升温"并入穿透型）
  piercing: { label: '穿透型', icon: '🔷' },
  lightning: { label: '闪电杖', icon: '⚡' },
  explosive: { label: '爆炸型', icon: '💥' },
  corrosion: { label: '腐蚀型', icon: '🌿' },
};

const TOWER_PASSIVES = [
  'passive_heavy_defense', 'passive_thorns', 'passive_frost_plating',
  'passive_armor_plating', 'passive_overheat', 'passive_vampire', 'passive_phase',
];

export const UnitAddDialog = {
  _state: { mainTab: 'minion', minionType: 'melee' },
  _queue: [],

  open(callbacks) {
    this._callbacks = callbacks || {};
    this._state = { mainTab: 'minion', minionType: 'melee' };
    this._queue = [];
    this._render();
  },

  _render() {
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalTitle').textContent = '➕ 添加单位';

    const st = this._state;
    const mainTabs = [
      { key: 'tower', label: '🏰 防御塔' },
      { key: 'minion', label: '⚔️ 小兵' },
      { key: 'dragon', label: '🐉 巨龙' },
    ];

    // v43 Q1：主分类从横排页签改成左侧栏（与模板编辑器一致）；
    // 小兵的兵种子页签沿用**模板编辑器的做法**——作为侧栏里的子项缩进列出，
    // 而不是在右侧再摆一排横页签。两层横排正是改版前"我在编辑谁要横着读两行才拼得出来"的来源。
    let subTabsHtml = '';

    let detailHtml;
    if (st.mainTab === 'tower') detailHtml = this._renderTowerDetail() + this._renderTowerModelSelector() + this._renderTowerFactionSelector();
    else if (st.mainTab === 'dragon') detailHtml = this._renderDragonDetail();
    else detailHtml = this._renderMinionDetail(st.minionType) + this._renderBattleSelectors();

    // 侧栏条目：三个主分类；选中"小兵"时把兵种作为**子项缩进**列在它下面
    //（学模板编辑器的导航树，而不是在右侧再摆一排横页签）。
    const items = [];
    for (const t of mainTabs) {
      const open = t.key === 'minion' && st.mainTab === 'minion';
      const caret = open ? '<span class="tpl-caret">▾</span>'
                  : (t.key === 'minion' ? '<span class="tpl-caret">▸</span>' : '');
      items.push({ key: t.key, label: caret + t.label });
      if (!open) continue;
      for (const m of MINION_TYPES) {
        items.push({ key: 'minion:' + m, child: true,
                     label: `${TYPE_META[m].icon} ${TYPE_META[m].label}` });
      }
    }
    const activeKey = st.mainTab === 'minion' ? 'minion:' + st.minionType : st.mainTab;
    const crumb = st.mainTab === 'minion'
      ? `${TYPE_META[st.minionType].icon} ${TYPE_META[st.minionType].label}`
      : (mainTabs.find(t => t.key === st.mainTab) || {}).label;
    const body = `
      ${subTabsHtml}
      <div id="uadDetailContent">${detailHtml}</div>
      ${st.mainTab !== 'tower' ? `
        <div class="uad-queue-box">
          <div class="uad-queue-title">📋 待生成清单（${this._queue.length}）</div>
          <div class="uad-queue-list">${this._renderQueueList()}</div>
        </div>
      ` : `<div style="margin-top:10px;font-size:11px;color:var(--text-mute);">防御塔单独建造：确认后请在画布上点击选择位置（不进入批量清单）</div>`}
    `;
    document.getElementById('modalBody').innerHTML = paneHtml({
      groups: [{ items }], activeKey, crumb, body, navAttr: 'uadnav',
    });

    let actions = '';
    if (st.mainTab === 'tower') {
      actions += `<button id="uadBuildTowerBtn" class="primary">🏗️ 建造防御塔</button>`;
    } else {
      actions += `<button id="uadAddToQueueBtn" class="success">＋ 加入清单</button>`;
      actions += `<button id="uadGenerateBtn" class="primary" ${this._queue.length === 0 ? 'disabled' : ''}>🚀 批量生成（${this._queue.length}）</button>`;
    }
    actions += `<button id="uadCancelBtn">关闭</button>`;
    document.getElementById('modalActions').innerHTML = actions;

    this._bindEvents(overlay);
  },

  _bindEvents(overlay) {
    // v43 Q1：侧栏导航统一走 dialogShell 的 data-uadnav。
    // 主分类的 key 就是 mainTab；兵种子项的 key 是 'minion:<兵种>'（一套 key 两层含义，
    // 免得再开第二个属性，也就不会出现"点了子项但主分类没跟着切"的错位）。
    overlay.querySelectorAll('[data-uadnav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.uadnav;
        if (k.startsWith('minion:')) {
          this._state.mainTab = 'minion';
          this._state.minionType = k.slice(7);
        } else {
          this._state.mainTab = k;
          if (k === 'minion' && !this._state.minionType) this._state.minionType = 'melee';
        }
        this._render();
      });
    });

    const cancelBtn = document.getElementById('uadCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));

    if (this._state.mainTab === 'tower') {
      this._bindTowerDetailEvents(overlay);
      const buildBtn = document.getElementById('uadBuildTowerBtn');
      overlay.querySelectorAll('[data-uadtowerfaction]').forEach(b => b.addEventListener('click', () => { this._state.towerFaction = b.dataset.uadtowerfaction; this._render(); }));
      overlay.querySelectorAll('[data-uadmodel]').forEach(b => b.addEventListener('click', () => {
        this._state.towerModel = b.dataset.uadmodel;
        // 换到"防御塔"时把勾选清掉：它没有对应档位，留着一个勾住但不可选的框最误导
        if (!towerModelTier(this._state.towerModel)) this._state.towerModelStats = false;
        this._render();
      }));
      const msBox = document.getElementById('uadModelStats');
      if (msBox) msBox.addEventListener('change', () => {
        this._state.towerModelStats = msBox.checked; this._render();
      });
      if (buildBtn) buildBtn.addEventListener('click', () => {
        const weaponType = overlay._selectedWeapon || 'piercing'; // v33：默认穿透型
        const passiveKeys = Array.from(overlay._selectedPassives || []);
        const faction = this._callbacks?.isBattle?.() ? (this._state.towerFaction || 'neutral') : null;
        const model = this._state.towerModel || 'tower';
        const modelStats = !!this._state.towerModelStats
          && !!towerModelTier(model);
        this._callbacks.onBuildTower?.(weaponType, passiveKeys, faction, { model, modelStats });
        overlay.classList.remove('open');
      });
    } else {
      const addBtn = document.getElementById('uadAddToQueueBtn');
      if (addBtn) addBtn.addEventListener('click', () => this._addCurrentToQueue());
      const genBtn = document.getElementById('uadGenerateBtn');
      if (genBtn) genBtn.addEventListener('click', () => {
        if (this._queue.length === 0) return;
        this._generateAll();
        overlay.classList.remove('open');
      });
      overlay.querySelectorAll('[data-uadfaction]').forEach(b => b.addEventListener('click', () => { this._state.faction = b.dataset.uadfaction; this._render(); }));
      overlay.querySelectorAll('[data-uadlane]').forEach(b => b.addEventListener('click', () => { this._state.laneId = b.dataset.uadlane; this._render(); }));
      const spawnRuleBtn = document.getElementById('uadSpawnRuleBtn');
      if (spawnRuleBtn) spawnRuleBtn.addEventListener('click', () => {
        this._callbacks.onEditSpawnRule?.(this._state.minionType, () => this._render());
      });
      overlay.querySelectorAll('.uad-queue-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._queue.splice(parseInt(btn.dataset.idx, 10), 1);
          this._render();
        });
      });
    }

    if (!overlay._uadCloseBound) {
      overlay._uadCloseBound = true;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    }
  },

  // 对战模式建塔阵营选择（EQ2）：蓝/红/中立。中立=独立一方，打红蓝也被红蓝打，画布显示灰白色。
  _renderTowerFactionSelector() {
    if (!this._callbacks?.isBattle?.()) return '';
    const f = this._state.towerFaction || 'neutral';
    const btn = (k, txt) => `<button class="editor-tab ${f === k ? 'active' : ''}" data-uadtowerfaction="${k}">${txt}</button>`;
    return `<div style="margin-top:10px;">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">⚔️ 对战模式建塔阵营（中立：与红蓝双方互为敌对）</div>
      <div class="editor-tabs">${btn('blue', '🔵 蓝方')}${btn('red', '🔴 红方')}${btn('neutral', '⚪ 中立')}</div>
    </div>`;
  },

  // 对战模式选择器：阵营 + 分路（沙盒模式不渲染，行为完全不变）
  _renderBattleSelectors() {
    if (!this._callbacks?.isBattle?.()) return '';
    const f = this._state.faction || 'blue';
    const l = this._state.laneId || 'mid';
    const fBtn = (k, txt) => `<button class="editor-tab ${f === k ? 'active' : ''}" data-uadfaction="${k}">${txt}</button>`;
    const lBtn = (k, txt) => `<button class="editor-tab ${l === k ? 'active' : ''}" data-uadlane="${k}">${txt}</button>`;
    return `<div style="margin-top:10px;">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">⚔️ 对战模式：出生点为所选阵营的水晶枢纽，沿所选分路推线</div>
      <div class="editor-tabs">${fBtn('blue', '🔵 蓝方')}${fBtn('red', '🔴 红方')}</div>
      <div class="editor-tabs" style="margin-top:4px;">${lBtn('top', '上路')}${lBtn('mid', '中路')}${lBtn('bot', '下路')}</div>
    </div>`;
  },

  _addCurrentToQueue() {
    const st = this._state;
    if (st.mainTab === 'dragon') {
      const element = document.getElementById('uadDragonElement')?.value || null;
      const ancient = document.getElementById('uadDragonAncient')?.checked || false;
      const els = window.__app?.DRAGON_ELEMENTS || {};
      const label = ancient ? '远古巨龙' : (element ? els[element]?.label : '随机元素龙');
      this._queue.push({ category: 'dragon', label: '巨龙', icon: '🐉', summary: label, config: { element, ancient } });
    } else {
      const count = Math.max(1, Math.round(parseFloat(document.getElementById('uadMinionCount')?.value) || 1));
      const growth = document.getElementById('uadMinionGrowth')?.checked || false;
      const meta = TYPE_META[st.minionType] || {};
      const battle = this._callbacks?.isBattle?.();
      const faction = battle ? (st.faction || 'blue') : null;
      const laneId = battle ? (st.laneId || 'mid') : null;
      const fTag = faction ? (faction === 'blue' ? '🔵' : '🔴') + `→${{ top: '上', mid: '中', bot: '下' }[laneId]}路 ` : '';
      this._queue.push({
        category: 'minion', unitType: st.minionType, label: meta.label || st.minionType, icon: meta.icon || '❓',
        summary: `${fTag}数量×${count}${growth ? '（波次成长）' : ''}`, config: { count, growth, faction, laneId },
      });
    }
    this._render();
  },

  _renderQueueList() {
    if (this._queue.length === 0) return `<div class="uad-queue-empty">尚未添加任何单位。配置后点"加入清单"。</div>`;
    return this._queue.map((item, idx) => `
      <div class="uad-queue-item">
        <span class="uad-queue-icon">${item.icon}</span>
        <span class="uad-queue-label">${item.label}</span>
        <span class="uad-queue-summary">${item.summary}</span>
        <button class="uad-queue-remove" data-idx="${idx}">✕</button>
      </div>
    `).join('');
  },

  _generateAll() {
    for (const item of this._queue) {
      if (item.category === 'dragon') this._callbacks.onAddDragon?.(item.config.element, item.config.ancient);
      else this._callbacks.onAddMinion?.(item.unitType, item.config.count, item.config.growth, item.config.faction, item.config.laneId);
    }
    this._queue = [];
  },

  // 建塔的模型选择（用户定稿：**外观** + 一个可选的"套用该档位数值"勾选框）。
  // 选项来自 ModelLibrary.TOWER_MODEL_ROLES —— 这里不抄第二份清单，
  // 否则以后加了新模型，界面上看不见 = 等于没做。
  _renderTowerModelSelector() {
    const cur = this._state.towerModel || 'tower';
    const applyStats = !!this._state.towerModelStats;
    const btn = (r) => `<button class="editor-tab ${r.key === cur ? 'active' : ''}" data-uadmodel="${r.key}">${r.icon} ${r.label}</button>`;
    const meta = TOWER_MODEL_ROLES.find(r => r.key === cur) || TOWER_MODEL_ROLES[0];
    return `
      <div class="option-group" style="margin-top:14px;">
        <label class="uad-section-label">🎨 建筑模型（只影响外观）</label>
        <div class="editor-tabs" style="margin-bottom:6px;">${TOWER_MODEL_ROLES.map(btn).join('')}</div>
        <div class="editor-checkbox-row">
          <input type="checkbox" id="uadModelStats" ${applyStats ? 'checked' : ''}
                 ${meta.tier ? '' : 'disabled'} style="accent-color:var(--accent-2);width:16px;height:16px;cursor:pointer;">
          <label for="uadModelStats" style="cursor:pointer;">
            同时套用该档位的数值${meta.tier ? `（${meta.label}的生命/双抗/射程等）` : '（防御塔没有对应档位，此项不可选）'}
          </label>
        </div>
        <div class="pick-desc-box" style="margin-top:6px;">
          默认<b>只换外观</b>：数值、武器、被动仍由上面的选择决定。<br>
          勾上则额外把该档位在当前地图上的数值套到这座塔上（层级也会被设为
          <code>${meta.tier || '—'}</code>，于是它在结构保护/推进度统计里也按那一档算）。
        </div>
      </div>`;
  },

  _renderTowerDetail() {
    return `
      <div class="option-group">
        <label class="uad-section-label">⚔️ 武器（点击选择）</label>
        <div class="pick-grid" id="uadWeaponIcons"></div>
        <div class="pick-desc-box" id="uadWeaponDesc"></div>
      </div>
      <div class="option-group" style="margin-top:14px;">
        <label class="uad-section-label">🛡️ 被动技能（可多选，点击切换）</label>
        <div class="pick-grid" id="uadPassiveIcons"></div>
        <div class="pick-desc-box" id="uadPassiveDesc"></div>
      </div>
    `;
  },

  _renderMinionDetail(type) {
    const meta = TYPE_META[type] || {};
    return `
      <div class="option-group">
        <div class="pick-desc-box">${meta.icon || ''} ${meta.label || type} — ${meta.info || ''}</div>
      </div>
      <div class="option-group" style="margin-top:12px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;">
          <label style="color:var(--text-dim);font-size:12px;">📊 数量</label>
          <input type="number" id="uadMinionCount" value="1" min="1" step="1" class="editor-number" style="width:70px;">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="uadMinionGrowth" checked style="accent-color:var(--accent-2);width:16px;height:16px;cursor:pointer;">
          <label style="color:var(--text-dim);font-size:12px;cursor:pointer;">应用波次成长</label>
        </div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--glass-border);">
        <button id="uadSpawnRuleBtn" style="background:var(--surface-3);border:1px solid var(--glass-border);color:var(--text);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;">
          ⚙️ 编辑「${meta.label || type}」的自动生成规则
        </button>
      </div>
    `;
  },

  _renderDragonDetail() {
    const els = window.__app?.DRAGON_ELEMENTS || {};
    const keys = Object.keys(els);
    return `
      <div class="option-group">
        <div class="pick-desc-box">手动生成一条巨龙用于测试。可指定元素，或留空随机。</div>
      </div>
      <div class="option-group" style="margin-top:10px;">
        <label class="uad-section-label">元素（可选）</label>
        <select id="uadDragonElement" class="editor-select">
          <option value="">随机</option>
          ${keys.map(k => `<option value="${k}">${els[k].icon} ${els[k].label}</option>`).join('')}
        </select>
      </div>
      <div class="option-group" style="margin-top:10px;">
        <label style="display:flex;align-items:center;gap:6px;color:var(--text-dim);font-size:12px;cursor:pointer;">
          <input type="checkbox" id="uadDragonAncient" style="accent-color:var(--accent-2);width:16px;height:16px;">
          生成为远古巨龙
        </label>
      </div>
    `;
  },

  _bindTowerDetailEvents(overlay) {
    overlay._selectedWeapon = overlay._selectedWeapon || 'piercing'; // v33：默认穿透型
    overlay._selectedPassives = overlay._selectedPassives || new Set();

    const weaponContainer = document.getElementById('uadWeaponIcons');
    const renderWeapons = () => {
      weaponContainer.innerHTML = Object.entries(WEAPONS).map(([key, val]) =>
        `<div class="pick-card ${key === overlay._selectedWeapon ? 'selected' : ''}" data-weapon="${key}" title="${val.label}">
          <div class="pick-icon">${val.icon}</div>
          <div class="pick-label">${val.label}</div>
        </div>`
      ).join('');
      weaponContainer.querySelectorAll('[data-weapon]').forEach(el => {
        el.addEventListener('click', () => {
          overlay._selectedWeapon = el.dataset.weapon;
          renderWeapons();
          updateDesc();
        });
      });
    };

    const passiveContainer = document.getElementById('uadPassiveIcons');
    const renderPassives = () => {
      passiveContainer.innerHTML = TOWER_PASSIVES.map(key => {
        const def = SkillLibrary[key];
        if (!def) return '';
        const active = overlay._selectedPassives.has(key);
        return `<div class="pick-card ${active ? 'selected' : ''}" data-passive="${key}" title="${def.name}">
          <div class="pick-icon">${def.icon || '🔹'}</div>
          <div class="pick-label">${def.name || key}</div>
        </div>`;
      }).join('');
      passiveContainer.querySelectorAll('[data-passive]').forEach(el => {
        el.addEventListener('click', () => {
          const key = el.dataset.passive;
          if (overlay._selectedPassives.has(key)) overlay._selectedPassives.delete(key);
          else overlay._selectedPassives.add(key);
          renderPassives();
          updateDesc();
        });
      });
    };

    const updateDesc = () => {
      const wDesc = document.getElementById('uadWeaponDesc');
      const pDesc = document.getElementById('uadPassiveDesc');
      const wDef = SkillLibrary['weapon_' + overlay._selectedWeapon];
      if (wDesc) wDesc.textContent = overlay._selectedWeapon === 'none' ? '无武器：塔不会攻击' : (wDef?.description || wDef?.descTemplate || '');
      if (pDesc) {
        if (overlay._selectedPassives.size === 0) pDesc.textContent = '点击选择被动技能（可多选）';
        else pDesc.textContent = '已选：' + Array.from(overlay._selectedPassives).map(k => SkillLibrary[k]?.name || k).join('、');
      }
    };

    renderWeapons();
    renderPassives();
    updateDesc();
  },
};
