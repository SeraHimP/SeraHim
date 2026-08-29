/**
 * events.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 事件绑定 + 应用修改（含「写模板 / 写场上目标」两条落地路径）
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary } from '../../core/SkillLibrary.js';

export const EDITOR_EVENTS = {
  // ==================== 事件绑定 ====================
  _bindEditorEvents(overlay) {
    const entity = overlay._entity;
    const logFn = overlay._logFn;

    // v44：实体编辑器换成了「左侧栏 + 右侧单页」的统一外壳，导航按钮的 class 从
    // .editor-tab 变成了 .tpl-nav-item（dialogShell 生成，navAttr:'tab' 让 data 属性名不变）。
    // 选择器因此放宽到 **[data-tab]**，不再绑死某个 class —— 分发逻辑一行没动，
    // 换外壳时也就不必跟着改一遍。
    overlay.querySelectorAll('[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        overlay.querySelectorAll('[data-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        // 面包屑跟着切（统一外壳里右侧顶部那一行）
        const crumb = overlay.querySelector('.tpl-crumb');
        if (crumb) crumb.textContent = (tab.textContent || '').trim();
        const content = overlay.querySelector('#editorContent');
        if (tabName === 'attr') {
          content.innerHTML = this._renderAttrContent(entity);
          this._bindAttrEvents(overlay, entity, logFn);
        } else if (tabName === 'weapon') {
          content.innerHTML = this._renderWeaponContent(entity);
          this._bindWeaponEvents(overlay, entity, logFn);
        } else if (tabName === 'skill') {
          content.innerHTML = this._renderSkillContent(entity);
          this._bindSkillEvents(overlay, entity, logFn);
        } else if (tabName === 'effect') {
          content.innerHTML = this._renderEffectContent(entity);
          this._bindEffectEvents(overlay, entity, logFn);
        } else if (tabName === 'soul') {
          content.innerHTML = this._renderSoulContent(entity);
          this._bindSoulEvents(overlay, entity, logFn);
        } else if (tabName === 'ops') {
          content.innerHTML = this._renderOpsContent(entity);
          this._bindOpsEvents(overlay, entity, logFn);
        }
      });
    });

    this._bindAttrEvents(overlay, entity, logFn);

    overlay.querySelector('#editorApplyBtn').addEventListener('click', () => {
      // v44 外壳改造把导航按钮的 class 从 .editor-tab 换成了 .tpl-nav-item（见本文件顶部说明），
      // 这里当时漏改，选择器还锁着旧 class，导致查不到 .active 元素、这个按钮点了永远没反应
      // ——不只是武器，attr/weapon/skill/effect 全部 tab 都受影响。
      const activeTab = overlay.querySelector('[data-tab].active');
      if (!activeTab) return;
      const tabName = activeTab.dataset.tab;
      if (tabName === 'attr') this._applyAttrChanges(overlay, entity, logFn);
      else if (tabName === 'weapon') this._applyWeaponChanges(overlay, entity, logFn);
      else if (tabName === 'skill') this._applySkillChanges(overlay, entity, logFn);
      else if (tabName === 'effect') this._applyEffectChanges(overlay, entity, logFn);
      else if (tabName === 'soul') logFn('🐉 龙魂点击即时生效，无需点应用', 'spawn');
    });

    overlay.querySelector('#editorResetBtn').addEventListener('click', () => {
      const title = entity.type === 'tower' ? `塔 #${entity.id}` : `${CONFIG.templates[entity.type]?.label || entity.type} #${entity.id}`;
      if (confirm(`重置 ${title} 为模板默认值？`)) {
        const tpl = CONFIG.templates[entity.type];
        if (tpl) {
          entity.baseStats = { ...tpl };
          entity.currentHP = tpl.maxHP;
          entity.shieldFixedCurrent = tpl.shieldFixedMax || 0;
          entity.tempShield = 0;
          logFn(`🔄 ${title} 已重置为模板默认值`, 'spawn');
          overlay.remove();
        }
      }
    });

    overlay.querySelector('#editorCloseBtn').addEventListener('click', () => overlay.remove());
  },

  _bindAttrEvents(overlay, target, logFn, isTemplate = false) {
    overlay.querySelectorAll('.editor-tab[data-group]').forEach(tab => {
      tab.addEventListener('click', () => {
        const group = tab.dataset.group;
        overlay.querySelectorAll('.editor-tab[data-group]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        overlay.querySelectorAll('.editor-group').forEach(g => g.style.display = g.dataset.group === group ? '' : 'none');
      });
    });
    const firstTab = overlay.querySelector('.editor-tab[data-group]');
    if (firstTab) firstTab.classList.add('active');

    overlay.querySelectorAll('.editor-number').forEach(inp => {
      inp.addEventListener('input', () => {
        const slider = overlay.querySelector(`.editor-slider[data-key="${inp.dataset.key}"]`);
        if (slider) slider.value = inp.value;
      });
    });
    // 滑块 → 数字框 反向同步
    overlay.querySelectorAll('.editor-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const inp = overlay.querySelector(`.editor-number[data-key="${slider.dataset.key}"]`);
        if (inp) inp.value = slider.value;
      });
    });
  },

  _bindWeaponEvents(overlay, entity, logFn) {
    overlay.querySelectorAll('.pick-card[data-weapon]').forEach(el => {
      el.addEventListener('click', () => {
        overlay.querySelectorAll('.pick-card[data-weapon]').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        const key = el.dataset.weapon; // 已经是完整 skillId（如 weapon_piercing / none），不需要再拼前缀
        const descBox = overlay.querySelector('#weaponDescBox');
        if (descBox) {
          const def = SkillLibrary[key];
          descBox.textContent = key === 'none' ? '无武器：塔不会攻击。' : (def?.description || def?.descTemplate || '');
        }
      });
    });
  },

  _bindSkillEvents(overlay, entity, logFn) {
    overlay.querySelectorAll('.pick-card[data-skill]').forEach(el => {
      el.addEventListener('click', () => {
        el.classList.toggle('selected');
        const key = el.dataset.skill;
        const def = SkillLibrary[key];
        const descBox = overlay.querySelector('#skillDescBox');
        if (descBox) {
          const isEquipped = el.classList.contains('selected');
          descBox.textContent = `${isEquipped ? '✅ 已装备' : '⭕ 未装备'} — ${def?.description || def?.descTemplate || ''}`;
        }
      });
    });
  },

  _bindEffectEvents(overlay, entity, logFn) {
    // v51.6 修复：window.__app 从未被赋值过（全仓库只有 window.CTX.__app 是真的），
    // 这里之前裸用它——"添加状态"和"移除状态"两个按钮实际上从来没真正生效过
    // （effectRegistry 恒为 undefined，apply/remove 调用直接被 ?. 短路成空操作）。
    const app = window.CTX?.__app || window.__app;
    overlay.querySelectorAll('.remove-effect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.effectId);
        if (!isNaN(id) && app?.effectRegistry) {
          app.effectRegistry.remove(id);
          const content = overlay.querySelector('#editorContent');
          if (content) content.innerHTML = this._renderEffectContent(entity);
          this._bindEffectEvents(overlay, entity, logFn);
        }
      });
    });

    overlay.querySelector('#addEffectBtn').addEventListener('click', () => {
      const box = overlay.querySelector('#effectPickerBox');
      if (box.style.display === 'block') {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.innerHTML = this._renderEffectPicker();
      this._bindEffectPicker(box);
      box.querySelector('#effectConfirmBtn').addEventListener('click', () => {
        const effect = this._buildEffectBlueprintFromPicker(box);
        app?.effectRegistry.apply(entity.id, effect, 'custom_' + Date.now());
        logFn(`✅ 已添加自定义状态到 #${entity.id}`, 'spawn');
        const content = overlay.querySelector('#editorContent');
        if (content) content.innerHTML = this._renderEffectContent(entity);
        this._bindEffectEvents(overlay, entity, logFn);
        box.style.display = 'none';
      });
    });
  },

  // ==================== 应用修改 ====================
  _applyAttrChanges(overlay, entity, logFn) {
    let changed = 0;
    const numbers = overlay.querySelectorAll('.editor-number');
    for (const inp of numbers) {
      const key = inp.dataset.key;
      const val = parseFloat(inp.value);
      const orig = parseFloat(inp.dataset.orig);
      if (isNaN(val)) continue;
      // 只写回真正改动过的字段
      if (!isNaN(orig) && val === orig) continue;
      if (key === 'currentHP') entity[key] = Math.min(val, entity.baseStats.maxHP || 1);
      else entity.baseStats[key] = val;
      changed++;
    }
    const selects = overlay.querySelectorAll('.editor-select');
    for (const sel of selects) {
      if (sel.dataset.orig !== undefined && sel.value === sel.dataset.orig) continue;
      entity.baseStats[sel.dataset.key] = sel.value;
      changed++;
    }
    if (entity.currentHP > entity.baseStats.maxHP) entity.currentHP = entity.baseStats.maxHP;
    // v33（Q13）：塔模型大小——留空恢复该档全局尺寸，填数字则本塔独享
    const msInput = overlay.querySelector('#editorModelSize');
    if (msInput) {
      const raw = msInput.value.trim();
      if (raw === '') {
        if (entity._modelSize !== undefined) { delete entity._modelSize; changed++; }
      } else {
        const v = Math.max(8, Math.min(80, parseFloat(raw) || 28));
        if (entity._modelSize !== v) { entity._modelSize = v; changed++; }
      }
    }
    logFn(`✅ 属性已更新（修改 ${changed} 项）`, 'spawn');
    overlay.remove();
  },

  _applyWeaponChanges(overlay, entity, logFn) {
    // v51.6 修复：同 _bindEffectEvents 那处一样，window.__app 恒为 undefined——
    // 换武器时 onUnequip/onEquip 拿到的 ctx 里 entityContainer/effectRegistry/
    // eventBus/attrCalc 全是 undefined，凡是依赖这几个字段的武器换装逻辑
    // （比如清理旧武器挂的效果、给新武器初始化状态）都悄悄没有真正执行。
    const app = window.CTX?.__app || window.__app;
    const selected = overlay.querySelector('.pick-card.selected[data-weapon]');
    if (!selected) return;
    const weaponId = selected.dataset.weapon;
    const oldInst = entity._skillInstances?.find(s => s.skillId.startsWith('weapon_'));
    if (oldInst) {
      const oldDef = SkillLibrary[oldInst.skillId];
      if (oldDef?.onUnequip) oldDef.onUnequip(entity.id, oldInst, {
        entityContainer: app?.entityContainer,
        effectRegistry: app?.effectRegistry,
      });
      entity._skillInstances = entity._skillInstances.filter(s => s !== oldInst);
    }
    if (weaponId !== 'none') {
      const newInst = { id: ++window._uid, skillId: weaponId, state: {} };
      entity._skillInstances.push(newInst);
      const newDef = SkillLibrary[weaponId];
      if (newDef?.onEquip) newDef.onEquip(entity.id, newInst, {
        entityContainer: app?.entityContainer,
        effectRegistry: app?.effectRegistry,
        eventBus: app?.eventBus,
        waveNumber: window.waveNumber || 0,
        attrCalc: app?.attrCalc,
      });
      entity.weaponType = weaponId.replace('weapon_', '');
    } else {
      entity.weaponType = 'none';
      entity.weaponIcon = '❌';
    }
    logFn(`🔧 塔 #${entity.id} 换武器为 ${weaponId}`, 'spawn');
    overlay.remove();
  },

  _applySkillChanges(overlay, entity, logFn) {
    // v51.6 修复：同上，window.__app 恒为 undefined 的问题。
    const app = window.CTX?.__app || window.__app;
    const selected = overlay.querySelectorAll('.pick-card.selected[data-skill]');
    const selectedSkills = new Set();
    selected.forEach(el => selectedSkills.add(el.dataset.skill));

    // 之前这里是硬编码的4个被动（缺 passive_overheat/vampire/phase），
    // 导致"移除旧技能"环节漏掉不在这个过时列表里的技能，永远无法被正确替换，
    // 造成技能栏重复累积同名技能实例（这正是"技能栏重复显示"bug的根因）。
    // 改用 _SKILLS_BY_TYPE 这个唯一、完整的数据源，且按实体实际类型取，不再对所有类型都套塔的列表。
    const allPassives = this._SKILLS_BY_TYPE[entity.type]?.passives || [];
    const toRemove = entity._skillInstances?.filter(s => allPassives.includes(s.skillId)) || [];
    for (const inst of toRemove) {
      const def = SkillLibrary[inst.skillId];
      if (def?.onUnequip) def.onUnequip(entity.id, inst, {
        entityContainer: app?.entityContainer,
        effectRegistry: app?.effectRegistry,
      });
      entity._skillInstances = entity._skillInstances.filter(s => s !== inst);
    }
    for (const key of selectedSkills) {
      const inst = { id: ++window._uid, skillId: key, state: {} };
      entity._skillInstances.push(inst);
      const def = SkillLibrary[key];
      if (def?.onEquip) def.onEquip(entity.id, inst, {
        entityContainer: app?.entityContainer,
        effectRegistry: app?.effectRegistry,
        eventBus: app?.eventBus,
        waveNumber: window.waveNumber || 0,
        attrCalc: app?.attrCalc,
      });
    }
    logFn(`🛡️ 塔 #${entity.id} 被动技能已更新`, 'spawn');
    overlay.remove();
  },

  _applyEffectChanges(overlay, entity, logFn) {
    overlay.remove();
  },

  // 把面板读到的字段应用出去。三条正交的维度（用户定稿）：
  //   ① 对象：分层塔(tier) 还是 小兵/塔模板(type)
  //   ② 阵营：共享 / 仅蓝 / 仅红   —— 塔与小兵都生效
  //   ③ 应用范围：仅模板 / 仅场上目标 / 两者
  _applyTemplateAttrChanges(overlay, type, logFn) {
    const isTower = this._categoryOfType(type) === 'tower';
    const tier = this._tplState?.tier || 'outer';
    const scope = this._factionScope;          // shared | blue | red
    const apply = this._applyScope || 'both';  // template | field | both

    const readPairs = [];
    for (const inp of overlay.querySelectorAll('.editor-number')) {
      const val = parseFloat(inp.value);
      if (!isNaN(val)) readPairs.push([inp.dataset.key, val]);
    }
    for (const sel of overlay.querySelectorAll('.editor-select')) readPairs.push([sel.dataset.key, sel.value]);
    if (!readPairs.length) { logFn('（没有可应用的字段）', 'spawn'); return; }

    let tplMsg = '', fieldMsg = '';

    // ---------- ① 写模板/覆写层 ----------
    if (apply !== 'field') {
      if (isTower) {
        // 分层塔：只存与"地图初始值"不同的字段（模板覆盖地图，改回原值自动清除）
        const base = this._tierBase(tier);
        let store;
        if (scope === 'shared') {
          CONFIG.towerTierOverrides = CONFIG.towerTierOverrides || {};
          store = CONFIG.towerTierOverrides[tier] = CONFIG.towerTierOverrides[tier] || {};
        } else {
          CONFIG.factionOverrides[scope] = CONFIG.factionOverrides[scope] || {};
          store = CONFIG.factionOverrides[scope]['tower_' + tier] = CONFIG.factionOverrides[scope]['tower_' + tier] || {};
        }
        for (const [k, v] of readPairs) { if (v === base[k]) delete store[k]; else store[k] = v; }
        tplMsg = `模板：${this._tierLabel(tier)}（${scope === 'shared' ? '双方' : (scope === 'blue' ? '仅蓝' : '仅红')}，${Object.keys(store).length} 个覆写字段）`;
      } else {
        const base = CONFIG.templates[type];
        if (scope === 'shared') {
          for (const [k, v] of readPairs) base[k] = v;
          tplMsg = `模板：${type}（双方共享基础值）`;
        } else {
          CONFIG.factionOverrides[scope] = CONFIG.factionOverrides[scope] || {};
          const ovr = CONFIG.factionOverrides[scope][type] = CONFIG.factionOverrides[scope][type] || {};
          for (const [k, v] of readPairs) { if (v === base[k]) delete ovr[k]; else ovr[k] = v; }
          if (Object.keys(ovr).length === 0) delete CONFIG.factionOverrides[scope][type];
          tplMsg = `模板：${type}（${scope === 'blue' ? '仅蓝' : '仅红'}覆写 ${Object.keys(CONFIG.factionOverrides[scope]?.[type] || {}).length} 字段）`;
        }
      }
    }

    // ---------- ② 改场上已有单位 ----------
    if (apply !== 'template') {
      const n = this._applyToFieldUnits({ isTower, tier, type, scope, readPairs });
      fieldMsg = `场上：命中 ${n} 个单位`;
    }
    logFn(`✅ 已应用　${[tplMsg, fieldMsg].filter(Boolean).join('　｜　')}`, 'spawn');
  },

  _tierLabel(tier) {
    return (this._TPL_TOWER_TIERS.find(t => t.key === tier) || {}).label || tier;
  },

  // 把字段直接写到场上已有单位的 baseStats。maxHP 变化时按比例保留当前血量百分比，
  // 免得"调高上限"反而让单位显示成残血、或"调低上限"后当前血超过上限。
  _applyToFieldUnits({ isTower, tier, type, scope, readPairs }) {
    const ec = window.CTX?.__app?.entityContainer;
    if (!ec || !ec.getAll) return 0;
    let hit = 0;
    for (const e of ec.getAll()) {
      if (!e || !e.alive || !e.baseStats) continue;
      if (isTower) {
        if (e.type !== 'tower') continue;
        if ((e._mapTier || 'outer') !== tier) continue;
      } else {
        if (e.type !== type) continue;
      }
      if (scope !== 'shared' && (e._mapFaction || e.faction) !== scope) continue;
      const frac = e.baseStats.maxHP > 0 ? (e.currentHP / e.baseStats.maxHP) : 1;
      for (const [k, v] of readPairs) e.baseStats[k] = v;
      if (e.baseStats.maxHP > 0) e.currentHP = Math.max(1, Math.min(e.baseStats.maxHP, Math.round(e.baseStats.maxHP * frac)));
      hit++;
    }
    return hit;
  },

  // 被动技能同样走三条正交维度：对象（塔层级 / 小兵类型）、阵营筛选、应用范围。
  _applyTemplateSkillChanges(overlay, type, logFn) {
    const isTower = this._categoryOfType(type) === 'tower';
    const tier = this._tplState?.tier || 'outer';
    const apply = this._applyScope || 'both';
    const scope = this._factionScope;

    const picked = [];
    overlay.querySelectorAll('.pick-card.selected[data-skill]').forEach(el => {
      if (!picked.includes(el.dataset.skill)) picked.push(el.dataset.skill);
    });

    let tplMsg = '', fieldMsg = '';
    if (apply !== 'field') {
      if (isTower) {
        CONFIG.towerTierSkills = CONFIG.towerTierSkills || {};
        CONFIG.towerTierSkills[tier] = [...picked];
        tplMsg = `模板：${this._tierLabel(tier)} 默认被动 ${picked.length} 项`;
      } else {
        CONFIG.templates[type]._templateSkills = [...picked];
        tplMsg = `模板：${type} 默认被动 ${picked.length} 项`;
      }
    }
    if (apply !== 'template') {
      const n = this._applyToFieldSkills({ isTower, tier, type, scope, picked });
      fieldMsg = `场上：重装 ${n} 个单位的被动`;
    }
    logFn(`✅ 已应用　${[tplMsg, fieldMsg].filter(Boolean).join('　｜　')}`, 'spawn');
  },

  // 把勾选的被动重装到场上已有单位：只动"本清单管辖范围内"的被动槽（pool），
  // 核心/武器/龙魂等其它技能实例一律保留，避免误删塔的身份技能与武器。
  _applyToFieldSkills({ isTower, tier, type, scope, picked }) {
    const app = window.CTX?.__app || window.__app;
    const ec = app?.entityContainer;
    if (!ec || !ec.getAll) return 0;
    const pool = new Set(isTower
      ? (this._SKILLS_BY_TIER[tier] || [])
      : (this._SKILLS_BY_TYPE[type]?.passives || []));
    const ctx = {
      entityContainer: ec, effectRegistry: app?.effectRegistry, eventBus: app?.eventBus,
      waveNumber: window.CTX?.waveNumber || window.waveNumber || 0, attrCalc: app?.attrCalc,
    };
    let hit = 0;
    for (const e of ec.getAll()) {
      if (!e || !e.alive || !Array.isArray(e._skillInstances)) continue;
      if (isTower) {
        if (e.type !== 'tower') continue;
        if ((e._mapTier || 'outer') !== tier) continue;
      } else if (e.type !== type) continue;
      if (scope !== 'shared' && (e._mapFaction || e.faction) !== scope) continue;

      for (const inst of e._skillInstances) {
        if (!pool.has(inst.skillId)) continue;
        const def = SkillLibrary[inst.skillId];
        if (def?.onUnequip) def.onUnequip(e.id, inst, ctx);
      }
      e._skillInstances = e._skillInstances.filter(i => !pool.has(i.skillId));
      for (const key of picked) {
        const inst = { id: ++(window.CTX._uid), skillId: key, state: {} };
        e._skillInstances.push(inst);
        const def = SkillLibrary[key];
        if (def?.onEquip) def.onEquip(e.id, inst, ctx);
      }
      hit++;
    }
    return hit;
  },

  _applyTemplateEffectChanges(overlay, type, logFn) {
    // 列表在绑定里已经就地改好（塔=towerTierEffects[tier]，小兵=tpl._templateEffects）。
    // 这里只补"应用到场上目标"这一维度：立刻把清单里的状态施加到符合筛选的单位上。
    const isTower = this._categoryOfType(type) === 'tower';
    const tier = this._tplState?.tier || 'outer';
    const list = this._effectListFor(type, tier);
    if ((this._applyScope || 'both') === 'template') {
      logFn(`✅ 默认状态已更新（${list.length} 项，仅影响新生成的单位）`, 'spawn');
      return;
    }
    const app = window.CTX?.__app || window.__app;
    const ec = app?.entityContainer;
    let hit = 0;
    for (const e of (ec?.getAll?.() || [])) {
      if (!e || !e.alive) continue;
      if (isTower) {
        if (e.type !== 'tower' || (e._mapTier || 'outer') !== tier) continue;
      } else if (e.type !== type) continue;
      if (this._factionScope !== 'shared' && (e._mapFaction || e.faction) !== this._factionScope) continue;
      for (const bp of list) app.effectRegistry.apply(e.id, { ...bp }, 'template_effect_apply');
      hit++;
    }
    logFn(`✅ 默认状态已更新（${list.length} 项）　｜　场上：施加到 ${hit} 个单位`, 'spawn');
  }
};
