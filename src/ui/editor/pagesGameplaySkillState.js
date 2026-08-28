/**
 * pagesGameplaySkillState.js —— "游戏性"大 tab 下的两个新页面：批量加技能 / 批量加状态。
 *
 * 用户定稿的产品需求："设置窗口里应该只包含对该系统的设置，而不包含游戏性的设置，
 * 所有游戏性的设置都整合到模板编辑器里"。这个文件只负责这两个全新页面；
 * 出兵编排/巨龙与龙魂/天气/熵是从别处搬迁+修 bug，在各自的文件里。
 *
 * 矩阵设计（用户定稿）：阵营×单位类型铺平成一张表直接勾格子，不做"先选阵营
 * 再切类型"的两级联动——15 行（8 种小兵 + 6 层塔 + 龙）× 2 列（蓝/红）够小，
 * 摊平一次性看到全貌比来回切页更直观。
 *
 * 技能池按 applicableTypes 分组过滤（用户定稿："筛选技能就是标注上哪种单位能
 * 用"）：矩阵里勾了哪些类型，技能池就只显示"至少能用于其中一种类型"的技能；
 * 应用时逐格判定——某个技能对某一勾中的类型不适用就跳过那一格，不会出现
 * "给全体近战兵装了一个只有攻城车能用的技能"这种错配。
 *
 * 状态页复用 pagesSkillEffect.js 现成的自定义效果构建器（_renderEffectPicker /
 * _buildEffectBlueprintFromPicker），不重新发明一套表单。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary, renderSkillDescription } from '../../core/SkillLibrary.js';

export const EDITOR_PAGES_GAMEPLAY_SKILLSTATE = {
  // 矩阵的行定义：小兵类型走 _TPL_MINION_TYPES（含自制兵种），塔按层拆开
  // （塔的技能池本来就按层区分，不能笼统当成一个"tower"行），龙单独一行。
  _gpMatrixRows() {
    const rows = this._TPL_MINION_TYPES.map(t => ({ key: t, applicable: t, label: `${this._iconOf(t)} ${this._labelOf(t)}` }));
    for (const t of this._TPL_TOWER_TIERS) rows.push({ key: 'tower:' + t.key, applicable: 'tower', label: `${t.icon} ${t.label}` });
    rows.push({ key: 'dragon', applicable: 'dragon', label: '🐲 巨龙' });
    return rows;
  },
  _gpFactions: [{ key: 'blue', label: '🔵' }, { key: 'red', label: '🔴' }],

  _gpMatrixHtml(cellSet, idPrefix) {
    const rows = this._gpMatrixRows();
    const head = `<tr><th></th>${this._gpFactions.map(f => `<th>${f.label}</th>`).join('')}</tr>`;
    const body = rows.map(r => `<tr><td class="gp-row-label">${r.label}</td>${
      this._gpFactions.map(f => {
        const k = `${r.key}|${f.key}`;
        return `<td><input type="checkbox" class="${idPrefix}-cell" data-cell="${k}" ${cellSet.has(k) ? 'checked' : ''}></td>`;
      }).join('')
    }</tr>`).join('');
    return `<table class="gp-matrix">${head}${body}</table>`;
  },

  _gpSelectedApplicableSet(cellSet) {
    // 从勾中的格子反推出涉及了哪些"applicable"标签（tower/dragon/melee/...），
    // 用于过滤技能/给应用范围里的"模板"分支定位该写哪个 CONFIG 位置。
    const rows = this._gpMatrixRows();
    const rowByKey = new Map(rows.map(r => [r.key, r]));
    const set = new Set();
    for (const cell of cellSet) {
      const [rowKey] = cell.split('|');
      const r = rowByKey.get(rowKey);
      if (r) set.add(r.applicable);
    }
    return set;
  },

  // ==================== 批量加技能 ====================
  _renderGameplaySkillGrantContent() {
    this._gpSkillGrant = this._gpSkillGrant || { cells: new Set(), skillId: null };
    const st = this._gpSkillGrant;
    const applicable = this._gpSelectedApplicableSet(st.cells);

    // 技能池按 4 桶分组：通用（无 applicableTypes 交集限制的没有，这里"通用"指
    // 同时对多种类型都适用的技能）/ 塔 / 兵 / 龙。用 category 排除身份技能与
    // 龙魂奖励技能——那两类各有专门的装备入口，不该出现在这里被随手勾选。
    const pool = Object.entries(SkillLibrary).filter(([, def]) =>
      def && typeof def === 'object' && Array.isArray(def.applicableTypes)
      && def.category !== 'core' && def.category !== 'dragonsoul');
    const visible = applicable.size === 0 ? pool
      : pool.filter(([, def]) => def.applicableTypes.some(t => applicable.has(t)));

    const poolHtml = visible.map(([id, def]) => `
      <div class="pick-card ${st.skillId === id ? 'selected' : ''}" data-gpskill="${id}">
        <div class="pick-icon">${def.icon || '🔹'}</div>
        <div class="pick-label">${def.name || id}</div>
      </div>`).join('') || `<div class="transfer-active-empty">先在上面矩阵里勾至少一格</div>`;

    const skillDef = st.skillId ? SkillLibrary[st.skillId] : null;
    const desc = skillDef ? (renderSkillDescription(skillDef, {}, {}) || skillDef.description || '') : '';

    return `
      <div class="gp-matrix-wrap">${this._gpMatrixHtml(st.cells, 'gpskillcell')}</div>
      <div class="pick-grid" style="margin-top:10px;">${poolHtml}</div>
      <div class="pick-desc-box" id="gpSkillDescBox">${desc}</div>
    `;
  },

  _bindGameplaySkillGrantEvents(overlay, logFn) {
    const st = this._gpSkillGrant;
    overlay.querySelectorAll('.gpskillcell-cell').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) st.cells.add(cb.dataset.cell); else st.cells.delete(cb.dataset.cell);
        overlay.querySelector('#templateContent').innerHTML = this._renderGameplaySkillGrantContent();
        this._bindGameplaySkillGrantEvents(overlay, logFn);
      });
    });
    overlay.querySelectorAll('[data-gpskill]').forEach(card => {
      card.addEventListener('click', () => {
        st.skillId = card.dataset.gpskill;
        overlay.querySelector('#templateContent').innerHTML = this._renderGameplaySkillGrantContent();
        this._bindGameplaySkillGrantEvents(overlay, logFn);
      });
    });
  },

  _applyGameplaySkillGrantChanges(overlay, logFn) {
    const st = this._gpSkillGrant;
    if (!st?.skillId || !st.cells.size) { logFn('⚠️ 先勾格子、再选一个技能', 'error'); return; }
    const def = SkillLibrary[st.skillId];
    const scope = this._applyScope || 'both';
    const rows = new Map(this._gpMatrixRows().map(r => [r.key, r]));
    let tplHits = 0, fieldHits = 0, skipped = 0;

    for (const cell of st.cells) {
      const [rowKey, faction] = cell.split('|');
      const row = rows.get(rowKey);
      if (!row || !def.applicableTypes.includes(row.applicable)) { skipped++; continue; }

      if (scope !== 'field') {
        if (rowKey.startsWith('tower:')) {
          const tier = rowKey.slice(6);
          CONFIG.towerTierSkills = CONFIG.towerTierSkills || {};
          CONFIG.towerTierSkills[tier] = CONFIG.towerTierSkills[tier] || [];
          if (!CONFIG.towerTierSkills[tier].includes(st.skillId)) CONFIG.towerTierSkills[tier].push(st.skillId);
        } else if (rowKey !== 'dragon') {
          const tpl = CONFIG.templates[rowKey];
          if (tpl) {
            if (!Array.isArray(tpl._templateSkills)) tpl._templateSkills = [];
            if (!tpl._templateSkills.includes(st.skillId)) tpl._templateSkills.push(st.skillId);
          }
        }
        // 龙的默认技能是天生的（factories.js createDragon 里固定挂），批量赋予的
        // "模板"分支对龙没有意义，只处理"场上"——所以这里龙不落模板、只落场上。
        tplHits++;
      }
      if (scope !== 'template') {
        fieldHits += this._gpApplyToField(rowKey, faction, st.skillId);
      }
    }
    const skipMsg = skipped ? `（${skipped} 格因类型不适用被跳过）` : '';
    logFn(`✅ 技能已赋予　模板 ${tplHits} 处｜场上 ${fieldHits} 个单位${skipMsg}`, 'spawn');
  },

  // 给场上已有单位追加一个技能实例（不去重复判断是否已装，重复点"应用"会重复挂——
  // 这与其它"批量应用"页面的幂等策略不同，因为技能允许同一单位多份同类被动叠加
  // 的场景本来就存在，交给使用者自己判断要不要点第二次）。
  _gpApplyToField(rowKey, faction, skillId) {
    const app = window.CTX?.__app || window.__app;
    const ec = app?.entityContainer;
    if (!ec?.getAll) return 0;
    const ctx = {
      entityContainer: ec, effectRegistry: app?.effectRegistry, eventBus: app?.eventBus,
      waveNumber: window.CTX?.waveNumber || 0, attrCalc: app?.attrCalc, combat: app?.combatSystem,
    };
    const isTower = rowKey.startsWith('tower:');
    const tier = isTower ? rowKey.slice(6) : null;
    const type = isTower ? 'tower' : rowKey;
    const def = SkillLibrary[skillId];
    let hit = 0;
    for (const e of ec.getAll()) {
      if (!e || !e.alive || !Array.isArray(e._skillInstances)) continue;
      if (isTower) { if (e.type !== 'tower' || (e._mapTier || 'outer') !== tier) continue; }
      else if (e.type !== type) continue;
      if (faction !== 'shared' && (e._mapFaction || e.faction) !== faction) continue;
      const inst = { id: ++(window.CTX._uid), skillId, state: {} };
      e._skillInstances.push(inst);
      if (def?.onEquip) def.onEquip(e.id, inst, ctx);
      hit++;
    }
    return hit;
  },

  // ==================== 批量加状态 ====================
  _renderGameplayStateGrantContent() {
    this._gpStateGrant = this._gpStateGrant || { cells: new Set() };
    const st = this._gpStateGrant;
    return `
      <div class="gp-matrix-wrap">${this._gpMatrixHtml(st.cells, 'gpstatecell')}</div>
      <div style="margin-top:10px;">
        <button id="gpAddStateBtn" class="primary">+ 添加状态</button>
        <div id="gpStatePickerBox" style="display:none;margin-top:8px;padding:12px;background:var(--surface-2);border-radius:6px;"></div>
      </div>
    `;
  },

  _bindGameplayStateGrantEvents(overlay, logFn) {
    const st = this._gpStateGrant;
    overlay.querySelectorAll('.gpstatecell-cell').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) st.cells.add(cb.dataset.cell); else st.cells.delete(cb.dataset.cell);
      });
    });
    overlay.querySelector('#gpAddStateBtn')?.addEventListener('click', () => {
      const box = overlay.querySelector('#gpStatePickerBox');
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = this._renderEffectPicker();
      box.querySelector('.effect-type-select')?.addEventListener('change', (e) => {
        box.querySelector('.effect-params').innerHTML = this._renderEffectParams(e.target.value);
      });
      box.querySelector('#effectConfirmBtn').addEventListener('click', () => {
        if (!st.cells.size) { logFn('⚠️ 先勾至少一格', 'error'); return; }
        const blueprint = this._buildEffectBlueprintFromPicker(box);
        this._applyGameplayStateGrant(st.cells, blueprint, logFn);
        box.style.display = 'none';
      });
    });
  },

  _applyGameplayStateGrant(cellSet, blueprint, logFn) {
    const scope = this._applyScope || 'both';
    const rows = new Map(this._gpMatrixRows().map(r => [r.key, r]));
    let tplHits = 0, fieldHits = 0;
    for (const cell of cellSet) {
      const [rowKey, faction] = cell.split('|');
      const row = rows.get(rowKey);
      if (!row) continue;

      if (scope !== 'field' && rowKey !== 'dragon') {
        // 自定义状态的"模板默认"复用 _effectListFor 同一个存储位置
        // （塔按层 CONFIG.towerTierEffects[tier]，小兵 tpl._templateEffects）。
        if (rowKey.startsWith('tower:')) {
          const tier = rowKey.slice(6);
          CONFIG.towerTierEffects = CONFIG.towerTierEffects || {};
          CONFIG.towerTierEffects[tier] = CONFIG.towerTierEffects[tier] || [];
          CONFIG.towerTierEffects[tier].push({ ...blueprint });
        } else {
          const tpl = CONFIG.templates[rowKey];
          if (tpl) { tpl._templateEffects = tpl._templateEffects || []; tpl._templateEffects.push({ ...blueprint }); }
        }
        tplHits++;
      }
      if (scope !== 'template') {
        fieldHits += this._gpApplyStateToField(rowKey, faction, blueprint);
      }
    }
    logFn(`✅ 状态已赋予　模板 ${tplHits} 处｜场上 ${fieldHits} 个单位`, 'spawn');
    // 矩阵勾选状态特意不清空：方便连续给同一批目标再加下一条状态，不用重新勾格子。
  },

  _gpApplyStateToField(rowKey, faction, blueprint) {
    const app = window.CTX?.__app || window.__app;
    const ec = app?.entityContainer, fx = app?.effectRegistry;
    if (!ec?.getAll || !fx?.apply) return 0;
    const isTower = rowKey.startsWith('tower:');
    const tier = isTower ? rowKey.slice(6) : null;
    const type = isTower ? 'tower' : rowKey;
    let hit = 0;
    for (const e of ec.getAll()) {
      if (!e || !e.alive) continue;
      if (rowKey === 'dragon') { if (e.type !== 'dragon') continue; }
      else if (isTower) { if (e.type !== 'tower' || (e._mapTier || 'outer') !== tier) continue; }
      else if (e.type !== type) continue;
      if (faction !== 'shared' && (e._mapFaction || e.faction) !== faction) continue;
      fx.apply(e.id, { ...blueprint }, `gameplay_state_${blueprint.stackKey || Date.now()}`);
      hit++;
    }
    return hit;
  },
};
