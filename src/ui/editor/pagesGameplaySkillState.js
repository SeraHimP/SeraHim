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
import { matrixHtml, skillPoolHtml, entitiesOfCells, triState, triClass, stripOtherWeapons } from './gpMatrix.js';

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

  // v50：矩阵改走共用组件（见 gpMatrix.js 的头注）——
  // 一二级菜单（小兵/防御塔/巨龙）+ 每行一个全选，两页共用同一份实现。
  _gpMatrixHtml(cellSet, idPrefix) {
    return matrixHtml(this._gpMatrixRows(), this._gpFactions, cellSet, idPrefix);
  },

  /** 矩阵的交互（格子点击 / 折叠 / 全选）——两页共用，绑一次。 */
  _gpBindMatrix(overlay, idPrefix, cellSet, rerender) {
    overlay.querySelectorAll(`[data-${idPrefix}cell]`).forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset[`${idPrefix}cell`];
        if (cellSet.has(k)) cellSet.delete(k); else cellSet.add(k);
        rerender();
      });
    });
    overlay.querySelectorAll(`[data-${idPrefix}fold]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const g = btn.dataset[`${idPrefix}fold`];
        const open = btn.textContent === '▾';
        btn.textContent = open ? '▸' : '▾';
        overlay.querySelectorAll(`[data-${idPrefix}grp="${g}"]`)
          .forEach(tr => { tr.style.display = open ? 'none' : ''; });
      });
    });
    const rows = this._gpMatrixRows();
    overlay.querySelectorAll(`[data-${idPrefix}all]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const g = btn.dataset[`${idPrefix}all`];
        const test = g === 'tower' ? (r) => r.applicable === 'tower'
                   : g === 'dragon' ? (r) => r.applicable === 'dragon'
                   : (r) => r.applicable !== 'tower' && r.applicable !== 'dragon';
        const keys = rows.filter(test).flatMap(r => this._gpFactions.map(f => `${r.key}|${f.key}`));
        const allOn = keys.every(k => cellSet.has(k));
        for (const k of keys) { if (allOn) cellSet.delete(k); else cellSet.add(k); }
        rerender();
      });
    });
    overlay.querySelectorAll(`[data-${idPrefix}rowall]`).forEach(btn => {
      btn.addEventListener('click', () => {
        const rk = btn.dataset[`${idPrefix}rowall`];
        const keys = this._gpFactions.map(f => `${rk}|${f.key}`);
        const allOn = keys.every(k => cellSet.has(k));
        for (const k of keys) { if (allOn) cellSet.delete(k); else cellSet.add(k); }
        rerender();
      });
    });
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
  /**
   * ==================== v50：批量加技能页重做 ====================
   * 用户："上面的复选框按照分类显示，然后弄成那种一二级菜单，并且右侧列添加全选的按钮。
   *        并且应该读取选中的单位持有的技能，如果共有的就显示选中（实线），
   *        有的没有的显示半选中（虚线），都没有的显示未选中。
   *        并且武器类型塔只能选一个，所以新选的武器会覆盖旧的武器。"
   *
   * 改动前是"选一张技能卡 → 点应用"，单向、看不出现状：你不知道选中的那批单位
   * 到底已经有没有这个技能，点两次就叠两份（技能允许重复叠加，见下面那段老注释）。
   * 现在是**三态复选框**：直接反映现状，点一下把整批拉齐 —— 加和减用同一个入口。
   */
  _renderGameplaySkillGrantContent() {
    this._gpSkillGrant = this._gpSkillGrant || { cells: new Set() };
    const st = this._gpSkillGrant;
    const applicable = this._gpSelectedApplicableSet(st.cells);
    const ec = (window.CTX?.__app || window.__app)?.entityContainer;
    const targets = entitiesOfCells(st.cells, ec);

    // 技能池：按 category 排除身份技能与龙魂奖励（那两类各有专门的装备入口）。
    const pool = Object.entries(SkillLibrary).filter(([, def]) =>
      def && typeof def === 'object' && Array.isArray(def.applicableTypes)
      && def.category !== 'core' && def.category !== 'dragonsoul');
    const visible = applicable.size === 0 ? pool
      : pool.filter(([, def]) => def.applicableTypes.some(t => applicable.has(t)));

    return `
      <div class="gp-matrix-wrap">${this._gpMatrixHtml(st.cells, 'gpskill')}</div>
      <div class="pick-desc-box" style="font-size:11px;">
        ${targets.length
          ? `选中 <b>${targets.length}</b> 个场上单位。复选框三态：实线 = 全都有，虚线 = 只有一部分有，空 = 都没有；点一下把整批拉齐。`
          : '先在上面勾至少一格目标（勾完这里会显示匹配到多少个单位）。'}
      </div>
      <div class="gp-pool">${skillPoolHtml(visible, targets, 'gpskill')}</div>
    `;
  },

  _bindGameplaySkillGrantEvents(overlay, logFn) {
    const st = this._gpSkillGrant;
    const rerender = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplaySkillGrantContent();
      this._bindGameplaySkillGrantEvents(overlay, logFn);
    };
    this._gpBindMatrix(overlay, 'gpskill', st.cells, rerender);

    overlay.querySelectorAll('[data-gpskillpoolfold]').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = btn.dataset.gpskillpoolfold;
        const open = btn.textContent === '▾';
        btn.textContent = open ? '▸' : '▾';
        const body = overlay.querySelector(`[data-gpskillpoolgrp="${g}"]`);
        if (body) body.style.display = open ? 'none' : '';
      });
    });

    overlay.querySelectorAll('[data-gpskillskill]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.gpskillskill;
        const ec = (window.CTX?.__app || window.__app)?.entityContainer;
        const targets = entitiesOfCells(st.cells, ec);
        if (!targets.length) { logFn('⚠️ 先勾至少一格目标', 'error'); return; }
        // 'all' → 全部摘掉；'none'/'some' → 全部补齐（把这一批拉成一致）
        const want = el.dataset.state !== 'all';
        const n = this._gpSetSkill(targets, id, want);
        logFn(`${want ? '➕' : '➖'} ${SkillLibrary[id]?.name || id}：${n} 个单位`, 'spawn');
        rerender();
      });
    });
  },

  /**
   * 把一批单位的某个技能拉齐到 want（true=都有 / false=都没有）。
   * 返回实际改动的个数。
   *
   * 武器互斥在这里落地（用户定稿："新选的武器会覆盖旧的武器"）——
   * 放在这一处而不是调用点，是因为**任何**给单位装武器的批量入口都该守这条。
   */
  _gpSetSkill(targets, skillId, want) {
    const app = window.CTX?.__app || window.__app;
    const ctx = {
      entityContainer: app?.entityContainer, effectRegistry: app?.effectRegistry,
      eventBus: app?.eventBus, waveNumber: window.CTX?.waveNumber || 0,
      attrCalc: app?.attrCalc, combat: app?.combatSystem,
    };
    const def = SkillLibrary[skillId];
    if (!def) return 0;
    let n = 0;
    for (const e of targets) {
      if (!Array.isArray(e._skillInstances)) continue;
      const had = e._skillInstances.some(i => i.skillId === skillId);
      if (want && !had) {
        stripOtherWeapons(e, skillId, ctx);   // 武器互斥
        const inst = { id: ++(window.CTX._uid), skillId, state: {} };
        e._skillInstances.push(inst);
        if (def.onEquip) def.onEquip(e.id, inst, ctx);
        n++;
      } else if (!want && had) {
        for (const inst of e._skillInstances.filter(i => i.skillId === skillId)) {
          if (def.onUnequip) def.onUnequip(e.id, inst, ctx);
        }
        e._skillInstances = e._skillInstances.filter(i => i.skillId !== skillId);
        n++;
      }
    }
    return n;
  },

  /**
   * v50：技能页改成**即点即生效**（三态复选框），不再有"点应用"这一步。
   * 底部的应用按钮仍然会调到这里，所以保留一个明确的说明而不是静默无事发生 ——
   * 静默的话用户会以为自己刚才的操作没保存。
   */
  _applyGameplaySkillGrantChanges(overlay, logFn) {
    logFn('ℹ️ 批量技能是点一下即生效的（复选框三态），不需要再点应用', 'spawn');
  },

  // ==================== 批量加状态 ====================
  /**
   * ==================== v50：批量加状态页重做 ====================
   * 用户："批量添加状态的也显示该类型单位所持有的共有的/非共有的，选择逻辑还是上面的那种。"
   * 与技能页共用同一套组件（gpMatrix.js）：同样的一二级目标矩阵、同样的三态、同样的全选。
   *
   * 状态与技能的差别只有一处：技能有固定的 id 可以枚举，而状态是**用户临时拼出来的蓝图**。
   * 所以这里的三态列表列的是"选中单位身上**现有**的状态（按名字归并）"——
   * 你能看到它们共有哪些、谁多了什么，点一下就能把某个状态从整批身上摘掉；
   * 新增仍然走下面的"+ 添加状态"（拼一个新蓝图再发下去）。
   */
  _renderGameplayStateGrantContent() {
    this._gpStateGrant = this._gpStateGrant || { cells: new Set() };
    const st = this._gpStateGrant;
    const app = window.CTX?.__app || window.__app;
    const targets = entitiesOfCells(st.cells, app?.entityContainer);
    const reg = app?.effectRegistry;

    // 收集这批单位身上出现过的状态名（按名字归并 —— 状态栏也是按名字聚合的，口径一致）
    const names = new Map();
    if (reg) {
      for (const e of targets) {
        for (const eff of reg.getEffects(e.id)) {
          const n = eff.blueprint.name;
          if (!names.has(n)) names.set(n, eff.blueprint.icon || '🔹');
        }
      }
    }
    const rows = [...names.entries()].map(([n, icon]) => {
      const t = triState(targets, (e) => reg.getEffects(e.id).some(x => x.blueprint.name === n));
      return `<label class="gp-pool-item">
        <span class="${triClass(t.state)}" data-gpstatename="${n}" data-state="${t.state}"></span>
        <span class="gp-pool-ic">${icon}</span>
        <span class="gp-pool-name">${n}</span>
        <span class="gp-pool-cnt">${t.hit}/${t.count}</span>
      </label>`;
    }).join('');

    return `
      <div class="gp-matrix-wrap">${this._gpMatrixHtml(st.cells, 'gpstate')}</div>
      <div class="pick-desc-box" style="font-size:11px;">
        ${targets.length
          ? `选中 <b>${targets.length}</b> 个场上单位。下面列的是它们身上**现有**的状态：`
            + '实线 = 全都有，虚线 = 只有一部分有；点一下把整批摘掉。'
          : '先在上面勾至少一格目标。'}
      </div>
      <div class="gp-pool">${rows || `<div class="transfer-active-empty">${targets.length ? '这批单位身上没有任何状态' : ''}</div>`}</div>
      <div style="margin-top:10px;">
        <button id="gpAddStateBtn" class="primary">+ 添加状态</button>
        <div id="gpStatePickerBox" style="display:none;margin-top:8px;padding:12px;background:var(--surface-2);border-radius:6px;"></div>
      </div>
    `;
  },

  _bindGameplayStateGrantEvents(overlay, logFn) {
    const st = this._gpStateGrant;
    const rerender = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplayStateGrantContent();
      this._bindGameplayStateGrantEvents(overlay, logFn);
    };
    this._gpBindMatrix(overlay, 'gpstate', st.cells, rerender);

    // 三态：点一下把这个状态从整批身上摘掉（新增走下面的选择器）
    overlay.querySelectorAll('[data-gpstatename]').forEach(el => {
      el.addEventListener('click', () => {
        const app = window.CTX?.__app || window.__app;
        const reg = app?.effectRegistry;
        const name = el.dataset.gpstatename;
        const targets = entitiesOfCells(st.cells, app?.entityContainer);
        let n = 0;
        for (const e of targets) {
          for (const eff of reg.getEffects(e.id)) {
            if (eff.blueprint.name === name) { reg.remove(eff.id); n++; }
          }
        }
        logFn(`➖ 已移除【${name}】：${n} 条`, 'spawn');
        rerender();
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
        rerender();
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
