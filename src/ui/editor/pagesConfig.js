/**
 * pagesConfig.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 模板页：导入导出 / 建筑体积 / 默认武器 / 默认龙魂
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary, renderSkillDescription } from '../../core/SkillLibrary.js';
import { exportTemplates, importTemplates, suggestedFileName } from '../../data/templateIO.js';
import { syncAll as syncCustomContent } from '../../data/customContent.js';

export const EDITOR_PAGES_CONFIG = {
  // ==================== 模板配置导入/导出 ====================
  // 面板改完的东西刷新一下就没了 —— 调了半小时平衡，手滑刷新全白费。
  // 导出/导入让整套配置能存盘、能对比、能发给别人复现。
  // 真正的序列化逻辑在 src/data/templateIO.js（可 headless 回归），这里只管交互。
  // 上次保存/打开的文件句柄（File System Access API）。留着它，再点"保存"就是
  // **覆盖同一个文件**而不是每次都往下载目录扔一个新文件 —— 调平衡是"改一点存一次"
  // 的循环，每次都新文件的话十分钟后下载目录里会有二十个同名带序号的 json，
  // 根本分不清哪个是最新的。
  _fileHandle: null,
  get _canUseFS() { return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'; },

  async _writeToHandle(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  },

  _downloadFallback(text, name) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  _bindTemplateIO(overlay, logFn, returnCallback) {
    // ---- 💾 保存到本地文件 ----
    overlay.querySelector('#tplSaveBtn')?.addEventListener('click', async () => {
      const text = JSON.stringify(exportTemplates(CONFIG), null, 2);
      const kb = (text.length / 1024).toFixed(1);
      const name = suggestedFileName();
      if (this._canUseFS) {
        try {
          if (!this._fileHandle) {
            this._fileHandle = await window.showSaveFilePicker({
              suggestedName: name,
              types: [{ description: 'SeraHim 配置', accept: { 'application/json': ['.json'] } }],
            });
          }
          await this._writeToHandle(this._fileHandle, text);
          logFn(`💾 已保存到 ${this._fileHandle.name}（${kb} KB）。再点保存会覆盖同一文件`, 'spawn');
          return;
        } catch (e) {
          // 用户点了取消：这不是错误，静默返回，别把它当失败去走降级流程弹下载框。
          if (e && e.name === 'AbortError') return;
          // 句柄失效（文件被移走/权限撤销）时清掉，下次重新问一次路径
          this._fileHandle = null;
          logFn(`⚠️ 保存到文件失败（${e?.message || e}），改用下载`, 'spawn');
        }
      }
      try {
        this._downloadFallback(text, name);
        logFn(`💾 已导出 ${name}（${kb} KB）`, 'spawn');
      } catch (e) {
        this._showJsonBox(overlay, text, null, logFn);
        logFn('💾 浏览器未允许下载，已改为文本框展示，请自行复制', 'spawn');
      }
    });

    // ---- 📂 从本地文件打开 ----
    overlay.querySelector('#tplOpenBtn')?.addEventListener('click', async () => {
      const apply = (text) => {
        let data;
        try { data = JSON.parse(text); }
        catch (e) { logFn(`❌ 打开失败：JSON 解析错误（${e.message}）`, 'spawn'); return; }
        const r = importTemplates(CONFIG, data);
        if (!r.ok) { logFn(`❌ 打开失败：${r.error}`, 'spawn'); return; }
        // 自制内容光是躺在 CONFIG 里还不算存在：技能得编译注册进 SkillLibrary、
        // 兵种得展开进 templates。不同步的话导入后看着有、用起来没有。
        const sy = syncCustomContent();
        if (sy.skills || sy.minions || sy.effects) {
          logFn(`✨ 自制内容已载入：技能 ${sy.skills} / 兵种 ${sy.minions} / 状态 ${sy.effects}`, 'spawn');
        }
        for (const e of sy.errors) logFn('⚠️ ' + e, 'spawn');
        logFn(`📂 已载入 ${r.groups.length} 组配置：${r.groups.join('、')}` +
              (r.skipped.length ? `（忽略 ${r.skipped.length} 个未知键）` : ''), 'spawn');
        this._renderTemplateEditor(logFn, returnCallback);
      };
      if (typeof window.showOpenFilePicker === 'function') {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{ description: 'SeraHim 配置', accept: { 'application/json': ['.json'] } }],
          });
          // 打开的文件同时成为后续"保存"的目标：打开→改→保存 是最常见的循环，
          // 不接上的话保存又会去问一次路径，很容易存到另一个文件去。
          this._fileHandle = h;
          apply(await (await h.getFile()).text());
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          logFn(`⚠️ 打开文件失败（${e?.message || e}），改用文件选择框`, 'spawn');
        }
      }
      // 降级：传统 <input type=file>
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => apply(String(rd.result || ''));
        rd.readAsText(f);
      });
      inp.click();
    });

    // ---- 📋 JSON 文本框：既能复制走当前配置，也能粘贴新的进来 ----
    // 预填当前配置而不是留空：这一个框同时服务"我想看看现在存了什么"和
    // "我想粘一份进来"两种诉求，留空的话前者还得再点一次导出。
    overlay.querySelector('#tplImportBtn')?.addEventListener('click', () => {
      this._showJsonBox(overlay, JSON.stringify(exportTemplates(CONFIG), null, 2), (text) => {
        let data;
        try { data = JSON.parse(text); }
        catch (e) { logFn(`❌ 导入失败：JSON 解析错误（${e.message}）`, 'spawn'); return false; }
        const r = importTemplates(CONFIG, data);
        if (!r.ok) { logFn(`❌ 导入失败：${r.error}`, 'spawn'); return false; }
        const sy = syncCustomContent();
        if (sy.skills || sy.minions || sy.effects) {
          logFn(`✨ 自制内容已载入：技能 ${sy.skills} / 兵种 ${sy.minions} / 状态 ${sy.effects}`, 'spawn');
        }
        for (const e of sy.errors) logFn('⚠️ ' + e, 'spawn');
        logFn(`📥 已导入 ${r.groups.length} 组配置：${r.groups.join('、')}` +
              (r.skipped.length ? `（忽略了 ${r.skipped.length} 个未知键：${r.skipped.join('、')}）` : ''), 'spawn');
        this._renderTemplateEditor(logFn, returnCallback);
        return true;
      }, logFn);
    });
  },

  // 一个极简的 JSON 文本框弹层。onConfirm 为 null 时是只读展示（导出降级用）。
  _showJsonBox(overlay, initial, onConfirm, logFn) {
    const box = document.createElement('div');
    box.className = 'modal-overlay open';
    box.style.zIndex = '10000';
    box.innerHTML = `
      <div class="modal-box" style="max-width:560px;">
        <div class="editor-container">
          <h4>${onConfirm ? '📋 配置 JSON' : '📤 导出模板配置'}</h4>
          <p style="color:#8b949e;font-size:11px;margin:6px 0;">
            ${onConfirm
              ? '下面是当前的全部配置，可直接全选复制走。也可以粘一份进来再点【导入】——'
                + '导入是【深合并】：文件里没写的字段保持现值，不会被抹掉。'
              : '复制下面的全部内容并自行保存为 .json 文件。'}
          </p>
          <textarea id="jsonBoxArea" spellcheck="false" style="width:100%;height:280px;font-family:monospace;
            font-size:11px;background:#0d1117;color:#c9d1d9;border:1px solid #2d3540;border-radius:4px;padding:8px;"
            ${onConfirm ? '' : 'readonly'}>${initial.replace(/</g, '&lt;')}</textarea>
          <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
            ${onConfirm ? '<button id="jsonBoxOk" class="primary">导入</button>' : ''}
            <button id="jsonBoxCancel">${onConfirm ? '取消' : '关闭'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(box);
    const area = box.querySelector('#jsonBoxArea');
    if (!onConfirm) { area.focus(); area.select(); }
    box.querySelector('#jsonBoxCancel').addEventListener('click', () => box.remove());
    box.querySelector('#jsonBoxOk')?.addEventListener('click', () => {
      // 只有导入成功才关闭：失败还关掉的话，用户辛苦粘进来的内容就没了。
      if (onConfirm(area.value)) box.remove();
    });
  },

  // ==================== 建筑体积（各档建筑的渲染半径）====================
  // LoL 中水晶枢纽/防御塔/召唤水晶体积不同，这里按 tier 提供可调半径。
  // 写入 CONFIG.buildingSizes；渲染器的塔精灵缓存 key 含尺寸，改动后新尺寸精灵
  // 会惰性重新烘焙，无需手动清缓存，画面即时生效。
  // v51.35：base/hq_tower 改名"水晶防御塔"/"枢纽防御塔"，见 waveComposition.js
  // STRUCT_TIERS 头注（全局统一改名的唯一理由说明，不在每处重复）。
  _BSIZE_TIERS: [
    ['outer', '外塔'], ['inner', '内塔'], ['base', '水晶防御塔'],
    ['hq_tower', '枢纽防御塔'], ['nexus_lane', '召唤水晶'], ['nexus_main', '水晶枢纽'],
    // 手动建塔（添加单位→建造防御塔）不走地图分层，没有 _mapTier，用这一档兜底。
    ['default', '手动建塔（默认）'],
  ],

  _renderBuildingSizeContent() {
    const sizes = CONFIG.buildingSizes || {};
    return `
      <p style="color:#8b949e;font-size:11px;margin:4px 0 10px;">各档建筑在画布上的渲染半径（px）。仅影响显示与血条位置，不影响攻击范围/碰撞。</p>
      ${this._BSIZE_TIERS.map(([k, label]) => `
        <div class="editor-field" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <label style="width:130px;">${label}</label>
          <input type="number" min="8" max="80" step="1" data-bsize="${k}" value="${sizes[k] ?? 28}" style="width:80px;">
        </div>
      `).join('')}
    `;
  },

  _applyBuildingSizeChanges(overlay, logFn) {
    CONFIG.buildingSizes = CONFIG.buildingSizes || {};
    let changed = 0;
    overlay.querySelectorAll('[data-bsize]').forEach(input => {
      const k = input.dataset.bsize;
      const v = Math.max(8, Math.min(80, parseFloat(input.value) || 28));
      if (CONFIG.buildingSizes[k] !== v) { CONFIG.buildingSizes[k] = v; changed++; }
    });
    if (logFn) logFn(`📐 建筑体积已更新（${changed} 项修改）`, 'spawn');
  },

  // 模板"武器"tab：设置该模板新建单位默认装备的武器。
  // Q4：防御塔按【层级】存 —— 编辑器原先写 CONFIG.templates.tower._templateWeapon，
  // 而对战建筑是 createBuilding 生成的、只读地图字段，所以"改了武器不生效"。
  // 现在写 CONFIG.towerTierWeapon[tier]，与 createBuilding 读的是同一处。
  _tierWeaponOf(tier) {
    CONFIG.towerTierWeapon = CONFIG.towerTierWeapon || {};
    if (CONFIG.towerTierWeapon[tier] !== undefined) return CONFIG.towerTierWeapon[tier];
    // 未设过：显示该层级在当前地图上的实际武器（水晶类默认无武器）
    const map = window.CTX?.__app?.mapSystem?.currentMap;
    const b = (map?.buildings || []).find(x => x.tier === tier);
    if (tier === 'nexus_lane' || tier === 'nexus_main') return 'none';
    return b?.weapon || 'piercing';
  },

  _renderTemplateWeaponContent(type, tier) {
    const isTower = this._categoryOfType(type) === 'tower';
    const tpl = CONFIG.templates[type];
    const current = isTower ? this._tierWeaponOf(tier) : (tpl._templateWeapon || 'piercing');
    const weaponMeta = {
      none: { label: '无武器', icon: '🚫' }, piercing: { label: '穿透型', icon: '🔷' },
      lightning: { label: '闪电杖', icon: '⚡' }, explosive: { label: '爆炸型', icon: '💥' },
      corrosion: { label: '腐蚀型', icon: '🌿' },
    };
    const who = isTower ? this._tierLabel(tier) : (this._labelOf(type));
    let html = `<p style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">新生成的${who}默认装备该武器`
      + (isTower ? `（所有建筑都能装武器；召唤水晶/水晶枢纽默认无武器，装上即可开火）` : '') + `</p><div class="pick-grid">`;
    for (const [key, meta] of Object.entries(weaponMeta)) {
      const active = key === current;
      html += `<div class="pick-card ${active ? 'selected' : ''}" data-tplweapon="${key}">
        <div class="pick-icon">${meta.icon}</div>
        <div class="pick-label">${meta.label}</div>
      </div>`;
    }
    html += `</div>`;
    const currentDef = SkillLibrary['weapon_' + current];
    html += `<div class="pick-desc-box" id="tplWeaponDescBox">${current === 'none' ? '无武器：塔不会攻击。' : (currentDef?.description || currentDef?.descTemplate || '')}</div>`;
    return html;
  },

  _bindTemplateWeaponEvents(overlay, type, logFn) {
    overlay.querySelectorAll('[data-tplweapon]').forEach(el => {
      el.addEventListener('click', () => {
        overlay.querySelectorAll('[data-tplweapon]').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        const key = el.dataset.tplweapon;
        const descBox = overlay.querySelector('#tplWeaponDescBox');
        if (descBox) {
          const def = SkillLibrary['weapon_' + key];
          descBox.textContent = key === 'none' ? '无武器：塔不会攻击。' : (def?.description || def?.descTemplate || '');
        }
      });
    });
  },

  _applyTemplateWeaponChanges(overlay, type, logFn) {
    const selected = overlay.querySelector('[data-tplweapon].selected');
    const key = selected ? selected.dataset.tplweapon : 'piercing';
    const isTower = this._categoryOfType(type) === 'tower';
    const tier = this._tplState?.tier || 'outer';
    const apply = this._applyScope || 'both';

    let tplMsg = '', fieldMsg = '';
    if (apply !== 'field') {
      if (isTower) {
        CONFIG.towerTierWeapon = CONFIG.towerTierWeapon || {};
        CONFIG.towerTierWeapon[tier] = key;
        tplMsg = `模板：${this._tierLabel(tier)} → ${key}`;
      } else {
        CONFIG.templates[type]._templateWeapon = key;
        tplMsg = `模板：${this._labelOf(type)} → ${key}`;
      }
    }
    if (apply !== 'template') {
      fieldMsg = `场上：换装 ${this._applyToFieldWeapon({ isTower, tier, type, key })} 个单位`;
    }
    logFn(`✅ 武器已应用　${[tplMsg, fieldMsg].filter(Boolean).join('　｜　')}`, 'spawn');
  },

  // 给场上已有单位换武器：卸掉旧的 weapon_*，装上新的（'none' 则只卸不装）。
  // 与被动那边同口径 —— 只动武器槽，身份技能/被动/龙魂一律保留。
  _applyToFieldWeapon({ isTower, tier, type, key }) {
    const app = window.CTX?.__app || window.__app;
    const ec = app?.entityContainer;
    if (!ec || !ec.getAll) return 0;
    const ctx = {
      entityContainer: ec, effectRegistry: app?.effectRegistry, eventBus: app?.eventBus,
      waveNumber: window.CTX?.waveNumber || 0, attrCalc: app?.attrCalc,
    };
    const tplTower = CONFIG.templates.tower;
    let hit = 0;
    for (const e of ec.getAll()) {
      if (!e || !e.alive || !Array.isArray(e._skillInstances)) continue;
      if (isTower) {
        if (e.type !== 'tower' || (e._mapTier || 'outer') !== tier) continue;
      } else if (e.type !== type) continue;
      if (this._factionScope !== 'shared' && (e._mapFaction || e.faction) !== this._factionScope) continue;

      for (const inst of e._skillInstances) {
        if (!inst.skillId?.startsWith('weapon_')) continue;
        const d = SkillLibrary[inst.skillId];
        if (d?.onUnequip) d.onUnequip(e.id, inst, ctx);
      }
      e._skillInstances = e._skillInstances.filter(i => !i.skillId?.startsWith('weapon_'));
      if (key && key !== 'none') {
        const inst = { id: ++(window.CTX._uid), skillId: 'weapon_' + key, state: {} };
        e._skillInstances.push(inst);
        const d = SkillLibrary['weapon_' + key];
        if (d?.onEquip) d.onEquip(e.id, inst, ctx);
        // 同 createBuilding：水晶类攻击力/攻速为 0 时回落到塔模板，否则装了也打不出来
        if (!(e.baseStats.attackDamage > 0)) e.baseStats.attackDamage = tplTower.attackDamage;
        if (!(e.baseStats.baseAttackSpeed > 0)) e.baseStats.baseAttackSpeed = tplTower.baseAttackSpeed;
      }
      e.attackCooldown = 0; e.targetId = null;
      hit++;
    }
    return hit;
  },

  // 模板"龙魂"tab：设置该模板（塔）新建单位默认装备的龙魂
  _renderTemplateSoulContent(type) {
    const tpl = CONFIG.templates[type];
    // v51.6 修复：同 pagesEntity.js 那处一样，window.__app 从未被赋值过（全仓库只有
    // window.CTX.__app 是真的），裸用它会让 DRAGON_ELEMENTS 恒为 {}——这个模板默认
    // 龙魂选择器的卡片池因此一直是空的，一张卡都点不到。
    const DRAGON_ELEMENTS = (window.CTX?.__app || window.__app)?.DRAGON_ELEMENTS || {};
    // 迁移旧的单一 _templateSoul 字段为数组 _templateSouls（支持多选叠加，与实体编辑器一致）
    if (!Array.isArray(tpl._templateSouls)) {
      tpl._templateSouls = tpl._templateSoul ? [tpl._templateSoul] : [];
    }
    const equipped = new Set(tpl._templateSouls);

    const activeChips = Object.entries(DRAGON_ELEMENTS)
      .filter(([, el]) => equipped.has(el.soul))
      .map(([key, el]) => {
        const def = SkillLibrary[el.soul];
        return { key, icon: def?.icon || el.icon, label: def?.name || el.label };
      });
    const activeHtml = activeChips.length
      ? activeChips.map(c => `<div class="transfer-chip" data-tplsoul-remove="${c.key}">
          <span class="chip-icon">${c.icon}</span><span>${c.label}</span><span class="chip-remove">✕</span>
        </div>`).join('')
      : `<div class="transfer-active-empty">新生成的${this._labelOf(type)}默认不装备任何龙魂。点击下方池中的按钮即可默认装备。</div>`;

    const poolHtml = Object.entries(DRAGON_ELEMENTS).map(([key, el]) => {
      const def = SkillLibrary[el.soul];
      const active = equipped.has(el.soul);
      return `<div class="pick-card ${active ? 'selected' : ''}" data-tplsoul="${el.soul}">
        <div class="pick-icon">${def?.icon || el.icon}</div>
        <div class="pick-label">${def?.name || el.label}</div>
      </div>`;
    }).join('');

    return `
      <div class="transfer-box">
        <p style="color:var(--text-dim);font-size:11px;">新生成的${this._labelOf(type)}将默认装备下方"已生效"框内的龙魂（可多选，不受击杀解锁限制，用于快速配置）</p>
        <div class="transfer-active-zone">
          <div class="transfer-active-title">✨ 默认装备（点击移除）</div>
          <div class="transfer-active-list">${activeHtml}</div>
        </div>
        <div class="transfer-pool-section">
          <div class="transfer-pool-title">🐉 龙魂池（点击设为默认装备，可多选）</div>
          <div class="pick-grid">${poolHtml}</div>
        </div>
        <div class="pick-desc-box" id="tplSoulDescBox">点击某项查看说明。</div>
      </div>
    `;
  },

  _bindTemplateSoulEvents(overlay, type, logFn) {
    const tpl = CONFIG.templates[type];
    const rerender = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderTemplateSoulContent(type);
      this._bindTemplateSoulEvents(overlay, type, logFn);
    };
    const toggle = (soulId) => {
      const idx = tpl._templateSouls.indexOf(soulId);
      if (idx >= 0) {
        tpl._templateSouls.splice(idx, 1);
        logFn(`🚫 ${this._labelOf(type)}默认龙魂已移除：${SkillLibrary[soulId]?.name || soulId}`, 'spawn');
      } else {
        tpl._templateSouls.push(soulId);
        logFn(`✅ ${this._labelOf(type)}默认龙魂已添加：${SkillLibrary[soulId]?.name || soulId}`, 'spawn');
      }
      rerender();
    };
    overlay.querySelectorAll('[data-tplsoul]').forEach(card => {
      card.addEventListener('click', () => toggle(card.dataset.tplsoul));
      card.addEventListener('mouseenter', () => {
        const def = SkillLibrary[card.dataset.tplsoul];
        const descBox = overlay.querySelector('#tplSoulDescBox');
        // v51.5 修复：同一处 ReferenceError（entity/ctx 从未声明过，见
        // pagesEntity.js._bindSoulEvents 的对照修复）。模板编辑没有具体持有者，
        // entity 传 null——renderSkillDescription 对 entity 缺失有安全回退。
        if (descBox) descBox.textContent = renderSkillDescription(def, null, {}) || def?.description || '';
      });
    });
    overlay.querySelectorAll('[data-tplsoul-remove]').forEach(chip => {
      chip.addEventListener('click', () => toggle(chip.dataset.tplsoulRemove));
    });
  },
};
