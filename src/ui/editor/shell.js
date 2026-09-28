/**
 * shell.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 阵营/应用作用域 + 模板面板骨架与「渲染-绑定-应用」三条分发
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { towerTierBase, towerTierEffective } from '../../data/schema/index.js';

export const EDITOR_SHELL = {
  // ==================== 阵营作用域（对战模式：改一方不影响另一方） ====================
  // 数据模型：CONFIG.templates[type] 为共享基础；CONFIG.factionOverrides[faction][type]
  // 只存"与基础不同的字段"。作用域=共享时读写基础（旧行为）；作用域=蓝/红时读合并值、
  // 保存时把与基础不同的字段写入覆写层、与基础相同的字段自动从覆写层清除。
  // 仅"属性"tab 参与阵营覆写（技能/武器/状态等 tab 保持双方共享）。
  _factionScope: 'shared',

  // 分层塔的"当前有效数值"：地图 tierStats → 共享覆写 → 阵营覆写（与 createBuilding 同一叠加顺序）
  // P1：分层塔的数值解析【全部转调 Schema】，编辑器不再自己写一份。
  // 这两个函数原先是解析顺序的第【四】份实现（createBuilding 一份、Schema 一份、
  // 运维改层级一份、这里一份）。同一套顺序抄四遍，正是"编辑器写 A 运行时读 B"
  // 这类事故的温床 —— 抄的时候对，改的时候只改一处就错。
  _tierBase(tier) { return towerTierBase(tier); },
  _tierEffective(tier) { return towerTierEffective(tier, this._factionScope); },

  _scopedTpl(type) {
    const base = CONFIG.templates[type];
    if (this._factionScope === 'shared' || !base) return base;
    const ovr = CONFIG.factionOverrides?.[this._factionScope]?.[type] || {};
    return { ...base, ...ovr };
  },

  _factionLabel() {
    return this._factionScope === 'shared' ? '双方共享'
         : (this._factionScope === 'blue' ? '🔵 仅蓝方' : '🔴 仅红方');
  },
  _applyRangeLabel() {
    return ({ template: '仅模板（影响之后新生成的单位）',
              field: '仅场上已有单位（不动模板，新生成的仍用旧值）',
              both: '模板 + 场上已有单位一起改' })[this._applyScope] || '';
  },

  // 作用域说明行。**只描述这一页真的会读的维度** ——
  // 一页压根不看阵营，却在标题下写着"阵营：仅红方"，那是面板在撒谎。
  _pageScopeNote(P) {
    const bits = [];
    bits.push(P.faction ? `阵营：${this._factionLabel()}` : '阵营：本页对双方共同生效');
    if (P.apply) bits.push(`应用范围：${this._applyRangeLabel()}`);
    if (P.action === 'instant') bits.push('本页控件即点即生效，无需点【应用】');
    if (P.action === 'none') bits.push('本页只读');
    return bits.join('　｜　');
  },

  // 应用范围条：仅模板 / 仅场上目标 / 两者（用户定稿）
  _renderApplyScopeBar() {
    const a = this._applyScope;
    const btn = (k, txt) => `<button class="editor-tab ${a === k ? 'active' : ''}" data-applyscope="${k}">${txt}</button>`;
    return `<div class="editor-tabs" style="margin-top:6px;">
      ${btn('template', '📐 仅模板（影响新生成）')}${btn('field', '🎯 仅场上目标')}${btn('both', '🔗 模板 + 场上')}
    </div>`;
  },

  // withClear=false 用于「出兵编排」页：那一页的覆写不是按 type 存的
  // （它存在 factionOverrides[阵营].laneWaveComposition），通用的"清除该阵营覆写"
  // 会去删 factionOverrides[阵营]['wave'] —— 一个根本不存在的键，点了什么也不会发生。
  // 该页自己带了一个语义正确的 #woClearFaction。
  _renderFactionScopeBar(withClear = true) {
    const f = this._factionScope;
    const btn = (k, txt) => `<button class="editor-tab ${f === k ? 'active' : ''}" data-tplscope="${k}">${txt}</button>`;
    return `<div class="editor-tabs" style="margin-top:6px;">
      ${btn('shared', '⚖️ 共享（双方）')}${btn('blue', '🔵 仅蓝方')}${btn('red', '🔴 仅红方')}
      ${(withClear && f !== 'shared') ? `<button class="editor-tab" data-tplscope-clear="1">🧹 清除该阵营覆写</button>` : ''}
    </div>`;
  },

  _renderTemplateEditor(logFn, returnCallback) {
    let overlay = document.getElementById('templateEditorOverlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'templateEditorOverlay';
    overlay.className = 'modal-overlay open';

    const st = this._tplState;
    const category = st.category;
    const pages = this._pagesOf(category);
    if (!pages.includes(st.tab)) st.tab = pages[0];
    const page = st.tab;
    const P = this._effPage(page, category);
    // 传给各 render/apply 函数的"当前对象"：塔恒为 'tower'（层级另走 st.tier），
    // 小兵为具体兵种，其余大类用大类名占位（那几页根本不看它）。
    const type = category === 'minion' ? (st.type || 'melee')
               : (category === 'tower' ? 'tower' : category);
    const nodeKey = this._curNodeKey();

    // ---------- 左：导航树 ----------
    // 改版前是三层横排页签（大类 → 类型 → 内容页），一屏最多four行胶囊按钮，
    // 而且"我现在在编辑谁"要横着读三行才拼得出来。纵向树把"位置感"这件事
    // 一次性交代清楚，右侧就只剩一件事：这一页在编辑什么。
    // 有子项的节点【只在展开时】列出子项。全展开的话 6 层塔 + 8 个兵种 + 巨龙 +
    // 3 条全局规则 = 18 行，超出可视高度，"全局规则"那一组直接掉到折叠线以下 ——
    // 用户看不见的入口等于不存在。折叠后常态只有 5~11 行，一屏装得下。
    let nav = '';
    for (const g of this._tplNav()) {
      nav += `<div class="tpl-nav-group"><div class="tpl-nav-title">${g.title}</div>`;
      for (const it of g.items) {
        const kids = it.children || [];
        const open = kids.length > 0 && category === it.key;
        const on = !kids.length && nodeKey === it.key;
        const caret = kids.length ? `<span class="tpl-caret">${open ? '▾' : '▸'}</span>` : '';
        nav += `<button class="tpl-nav-item ${on ? 'active' : ''}${open ? ' open' : ''}" data-tplnode="${it.key}">${caret}${it.label}</button>`;
        if (!open) continue;
        for (const c of kids) {
          nav += `<button class="tpl-nav-item child ${nodeKey === c.key ? 'active' : ''}" data-tplnode="${c.key}">${c.label}</button>`;
        }
      }
      nav += `</div>`;
    }

    // ---------- 右：页签 + 作用域条 + 内容 ----------
    const tabs = pages.length > 1
      ? `<div class="editor-tabs" style="margin-bottom:8px;">${pages.map(k => {
          const d = this._TPL_PAGES[k];
          return `<button class="editor-tab ${k === page ? 'active' : ''}" data-tpltab="${k}">${d.icon} ${d.label}</button>`;
        }).join('')}</div>`
      : '';
    // 作用域条【只在该页真读它时】才画 —— 见 _TPL_PAGES 顶部那段。
    // v51.1：用户"模板编辑器上面这块逻辑很混乱，优化"——排查结论：页签（属性/武器/…）、
    // 作用域条（阵营/应用范围）、内容自己的分类 tab（核心/攻击/…）三层控件此前共用同一个
    // .editor-tabs 胶囊按钮样式，视觉上完全无法区分"这一排是切页面"还是"这一排是切范围"，
    // 于是读起来是一整墙同款按钮。现在把作用域条包进 .tpl-scope-bars（独立的浅色卡片、
    // 更小的字号），与上面的页签、下面内容自己的分类 tab 在视觉权重上分出层次。
    const scopeBarsInner = (P.faction ? this._renderFactionScopeBar(page !== 'wave') : '')
                    + (P.apply ? this._renderApplyScopeBar() : '');
    const scopeBars = scopeBarsInner ? `<div class="tpl-scope-bars">${scopeBarsInner}</div>` : '';
    const head = `<div class="tpl-pane-head">
      <span class="tpl-crumb">${this._nodeLabel()} · ${P.icon} ${P.label}</span>
      ${P.action === 'instant' ? '<span class="tpl-instant">⚡ 即点即生效</span>' : ''}
    </div>`;
    const note = this._pageScopeNote(P);

    overlay.innerHTML = `
      <div class="modal-box" style="max-width:880px;">
        <div class="editor-container">
          <h4>📐 模板编辑器</h4>
          <div class="tpl-layout">
            <div class="tpl-nav">${nav}</div>
            <div class="tpl-pane">
              ${head}${tabs}${scopeBars}
              <div class="tpl-scope-note" id="tplScopeHint">${note}</div>
              <div id="templateContent">${this._renderPage(page, type)}</div>
            </div>
          </div>
          <div class="editor-actions" style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #2d3540;padding-top:12px;">
            <button id="tplSaveBtn" title="保存为本地文件（支持覆盖上次保存的那个文件）">💾 保存</button>
            <button id="tplOpenBtn" title="从本地文件读取配置">📂 打开</button>
            <button id="tplImportBtn" title="粘贴 JSON 导入 / 复制 JSON 导出">📋 JSON</button>
            ${P.action === 'apply'
              ? `<button id="templateApplyBtn" class="primary" title="${note}">应用 → ${this._nodeLabel()}·${P.writes}</button>`
              : ''}
            <button id="templateCloseBtn">关闭</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 左树：换节点
    overlay.querySelectorAll('[data-tplnode]').forEach(b => b.addEventListener('click', () => {
      this._selectNode(b.dataset.tplnode);
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    // 页签：换页。整屏重绘而不是只换 #templateContent —— 面包屑、两条作用域条、
    // 【应用】按钮上的文字都随页面变，只换内容会让它们停在上一页的状态。
    overlay.querySelectorAll('[data-tpltab]').forEach(b => b.addEventListener('click', () => {
      this._tplState.tab = b.dataset.tpltab;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    overlay.querySelectorAll('[data-tplscope]').forEach(b => b.addEventListener('click', () => {
      this._factionScope = b.dataset.tplscope;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    overlay.querySelectorAll('[data-applyscope]').forEach(b => b.addEventListener('click', () => {
      this._applyScope = b.dataset.applyscope;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    overlay.querySelector('[data-tplscope-clear]')?.addEventListener('click', () => {
      // 塔的阵营覆写按层级存成 'tower_<tier>'，小兵/其它按类型存。
      const t = category === 'tower' ? 'tower_' + (st.tier || 'outer') : type;
      if (CONFIG.factionOverrides?.[this._factionScope]) delete CONFIG.factionOverrides[this._factionScope][t];
      logFn(`🧹 已清除 ${this._factionScope === 'blue' ? '蓝方' : '红方'} 对 ${t} 的覆写`, 'spawn');
      this._renderTemplateEditor(logFn, returnCallback);
    });

    this._bindPage(page, overlay, type, logFn, returnCallback);
    overlay.querySelector('#templateApplyBtn')?.addEventListener('click', () => {
      this._applyPage(page, overlay, type, logFn);
      // 应用后【不再关闭】编辑器：调参是连续动作（改一项→看效果→再改一项），
      // 每次应用都弹回上级菜单正是"编辑器难用"的主因之一。原地重绘显示回写后的真实值。
      this._renderTemplateEditor(logFn, returnCallback);
    });

    this._bindTemplateIO(overlay, logFn, returnCallback);

    const closeAndReturn = () => {
      overlay.remove();
      if (returnCallback) returnCallback();
    };
    document.getElementById('templateCloseBtn').addEventListener('click', closeAndReturn);
  },

  // 页面内容分发。**只有这一处**知道"哪一页调哪个 render" ——
  // 旧代码在"首次渲染"和"切页"两条路径上各写了一份，于是属性页首次显示的是分层塔的
  // 真实数值、从别的页切回来却换成了未分层的通用模板值，同一个面板前后给两个答案。
  _renderPage(page, type) {
    const tier = this._tplState.tier || 'outer';
    const isTower = this._categoryOfType(type) === 'tower';
    switch (page) {
      case 'attr': {
        const src = isTower ? this._tierEffective(tier) : this._scopedTpl(type);
        if (!src) return `<div style="color:#8b949e;font-size:12px;padding:12px;">该类型没有可编辑的模板。</div>`;
        return this._renderAttrContent(src, true, isTower ? { tier } : null);
      }
      case 'weapon':     return this._renderTemplateWeaponContent(type, tier);
      case 'skill':      return this._renderTemplateSkillContent(type, tier);
      case 'effect':     return this._renderTemplateEffectContent(type, tier);
      case 'soul':       return this._renderTemplateSoulContent(type);
      case 'growth':     return this._renderGrowthContent(type);
      case 'wave':       return this._renderWaveOrderContent();
      case 'param':      return this._renderSkillParamsContent();
      case 'bsize':      return this._renderBuildingSizeContent();
      case 'dragonrule': return this._renderDragonRuleContent();
      case 'skillgrant': return this._renderGameplaySkillGrantContent();
      case 'stategrant': return this._renderGameplayStateGrantContent();
      case 'dragonstate':return this._renderGameplayDragonContent();
      case 'weather':    return this._renderGameplayWeatherContent();
      case 'entropy':    return this._renderGameplayEntropyContent();
      default:           return '';
    }
  },

  _bindPage(page, overlay, type, logFn, returnCallback) {
    const tier = this._tplState.tier || 'outer';
    const isTower = this._categoryOfType(type) === 'tower';
    switch (page) {
      case 'attr':
        this._bindAttrEvents(overlay, isTower ? this._tierEffective(tier) : this._scopedTpl(type), logFn, true);
        break;
      case 'weapon': this._bindTemplateWeaponEvents(overlay, type, logFn); break;
      case 'skill':  this._bindTemplateSkillEvents(overlay, type, logFn); break;
      case 'effect': this._bindTemplateEffectEvents(overlay, type, logFn, tier); break;
      case 'soul':   this._bindTemplateSoulEvents(overlay, type, logFn); break;
      case 'wave':   this._bindWaveOrderEvents(overlay, logFn); break;
      case 'param':  this._bindSkillParamsEvents(overlay, logFn, returnCallback); break;
      case 'skillgrant': this._bindGameplaySkillGrantEvents(overlay, logFn); break;
      case 'stategrant': this._bindGameplayStateGrantEvents(overlay, logFn); break;
      case 'dragonstate': this._bindGameplayDragonEvents(overlay, logFn); break;
      case 'weather': this._bindGameplayWeatherEvents(overlay, logFn); break;
      case 'entropy': this._bindGameplayEntropyEvents(overlay, logFn); break;
      default: break;   // growth / bsize / dragonrule 只有输入框，点应用时统一读
    }
  },

  _applyPage(page, overlay, type, logFn) {
    switch (page) {
      case 'attr':       this._applyTemplateAttrChanges(overlay, type, logFn); break;
      case 'weapon':     this._applyTemplateWeaponChanges(overlay, type, logFn); break;
      case 'skill':      this._applyTemplateSkillChanges(overlay, type, logFn); break;
      case 'effect':     this._applyTemplateEffectChanges(overlay, type, logFn); break;
      case 'growth':     this._applyGrowthChanges(overlay, type, logFn); break;
      case 'wave':       this._applyWaveOrderChanges(overlay, logFn); break;
      case 'param':      this._applySkillParamsChanges(overlay, logFn); break;
      case 'bsize':      this._applyBuildingSizeChanges(overlay, logFn); break;
      case 'dragonrule': this._applyDragonRuleChanges(overlay, logFn); break;
      case 'skillgrant': this._applyGameplaySkillGrantChanges(overlay, logFn); break;
      case 'stategrant': this._applyGameplayStateGrantChanges(overlay, logFn); break;
      case 'weather':    this._applyGameplayWeatherChanges(overlay, logFn); break;
      case 'entropy':    this._applyGameplayEntropyChanges(overlay, logFn); break;
      default: break;
    }
  },
};
