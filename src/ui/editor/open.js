/**
 * open.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 打开入口（实体编辑器 / 模板编辑器）、技能数值页、导航树与页面注册表
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary } from '../../core/SkillLibrary.js';
import { allMinionTypes, minionLabel, minionIcon } from '../../data/customContent.js';

export const EDITOR_OPEN = {
  // ==================== 实体编辑器 ====================
  openEntityEditor(entityId, entityContainer, effectRegistry, attrCalc, logFn) {
    const entity = entityContainer.get(entityId);
    if (!entity) { logFn('❌ 实体不存在', 'death'); return; }
    const isTower = entity.type === 'tower';
    const title = isTower ? `塔 #${entity.id}` : `${CONFIG.templates[entity.type]?.label || entity.type} #${entity.id}`;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:640px;">
        <div class="editor-container">
          <h4>✏️ 编辑 ${title}</h4>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;border-bottom:1px solid #2d3540;padding-bottom:8px;">
            <button class="editor-tab active" data-tab="attr">属性</button>
            ${isTower ? `<button class="editor-tab" data-tab="weapon">武器</button>` : ''}
            <button class="editor-tab" data-tab="skill">被动技能</button>
            <button class="editor-tab" data-tab="effect">状态</button>
            ${isTower ? `<button class="editor-tab" data-tab="soul">🐉 龙魂</button>` : ''}
            <button class="editor-tab" data-tab="ops">🛠 运维</button>
          </div>
          <div id="editorContent">
            ${this._renderAttrContent(entity)}
          </div>
          <div class="editor-actions" style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #2d3540;padding-top:12px;">
            <button id="editorApplyBtn" class="primary">应用</button>
            <button id="editorResetBtn" class="danger">重置为模板默认</button>
            <button id="editorCloseBtn">关闭</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay._entity = entity;
    overlay._logFn = logFn;
    overlay._entityContainer = entityContainer;
    overlay._effectRegistry = effectRegistry;
    overlay._attrCalc = attrCalc;

  // ============================================================
  //  SECTION 4: Event bindings + apply helpers (shared)
  // ============================================================

    this._bindEditorEvents(overlay);
  },

  // ==================== 模板编辑器 ====================
  // ==================== 模板编辑器（顶部横排按钮 tab，风格与实体编辑器统一） ====================
  // 布局：一级 tab（防御塔/小兵/巨龙）+ 二级 tab（仅小兵展开7个具体类型）+ 三级 tab（属性/武器/被动/状态/龙魂/生成规则），
  // 全部以顶部横排按钮堆叠显示，不使用卡片网格跳转。
  // ============================================================
  //  SECTION 2: 模板编辑器 —— 新单位的出厂默认值
  // ============================================================

  openTemplateEditorRoot(logFn, returnCallback) {
    this._tplState = { category: 'tower', type: 'tower', tier: 'outer', tab: 'attr' };
    this._renderTemplateEditor(logFn, returnCallback);
  },

  // page 可选：直接落到某一页。沙盒的"编辑生成规则"按钮就是靠它落到「沙盒节奏」——
  // 不指定的话会落在「属性」，用户点了一个写着"生成规则"的按钮却看到一堆攻防数值。
  openTemplateEditor(type, logFn, returnCallback, page) {
    // 兼容旧调用（直接指定具体类型，如 'tower' 或某个小兵类型）
    const category = this._categoryOfType(type);
    const pages = this._pagesOf(category);
    this._tplState = { category, type, tier: this._tplState?.tier || 'outer',
                       tab: pages.includes(page) ? page : pages[0] };
    this._renderTemplateEditor(logFn, returnCallback);
  },

  _categoryOfType(type) {
    if (type === 'tower') return 'tower';
    if (type === 'dragon') return 'dragon';
    if (type === 'skill' || type === 'skillparam') return 'skillparam';
    return 'minion';
  },

  // ==================== ✨ 技能数值编辑器 ====================
  // 技能的数值此前**只能改源码**（写在各技能的 defaultParams 里），
  // 或者改地图模块的 skillOverrides —— 前者要翻文件，后者只能整张地图一起改。
  // 现在有了全局层 CONFIG.skillOverrides，面板可改、进存档、且不影响地图级覆写
  // （地图更具体，仍然压在全局之上；见 CombatSystem 的三层叠加注释）。
  //
  // 只列出**声明了 defaultParams 的技能** —— 没声明的技能，其数值是写死在
  // 函数体里的字面量，没有可覆写的键；列出来只会给人"改了却没反应"的错觉。
  _skillsWithParams() {
    const out = [];
    for (const [id, def] of Object.entries(SkillLibrary)) {
      if (!def || typeof def !== 'object') continue;
      const dp = def.defaultParams;
      if (!dp || typeof dp !== 'object' || Object.keys(dp).length === 0) continue;
      out.push({ id, def, params: dp });
    }
    return out.sort((a, b) => (a.def.category || '').localeCompare(b.def.category || '') || a.id.localeCompare(b.id));
  },

  _renderSkillParamsContent() {
    const list = this._skillsWithParams();
    const ovr = CONFIG.skillOverrides || {};
    let html = `<div class="pick-desc-box" style="margin-bottom:10px;">
      ✨ 技能参数的叠加顺序：<b>技能出厂值 → 这里的全局覆写 → 地图级覆写</b>（后者压前者）。<br>
      改这里等于改"所有地图上的基准值"；某张地图要不一样，仍然在该地图模块的
      <code>skillOverrides</code> 里单独写（这就是"同一技能在不同地图上数值可以不同"的做法）。<br>
      留空 = 不覆写，用出厂值。改完点【应用】。
    </div>`;

    if (!list.length) {
      html += `<div style="color:#8b949e;font-size:12px;">当前没有声明了可覆写参数的技能。</div>`;
      return html;
    }
    html += `<div style="font-size:11px;color:var(--text-mute);margin-bottom:8px;">
      共 ${list.length} 个技能可调。只列出声明了可覆写参数的技能 ——
      其余技能的数值是写死在函数体里的字面量，列出来只会给人"改了没反应"的错觉。</div>`;

    for (const { id, def, params } of list) {
      const o = ovr[id] || {};
      const dirty = Object.keys(o).length > 0;
      html += `<div style="margin-bottom:10px;border:1px solid ${dirty ? '#58a6ff' : '#2d3540'};border-radius:4px;padding:8px;">
        <div style="font-size:12px;margin-bottom:6px;">
          ${def.icon || '✨'} <b>${def.name || id}</b>
          <span style="font-size:10px;color:#8b949e;">${id}</span>
          ${dirty ? '<span style="font-size:9px;color:#58a6ff;border:1px solid #58a6ff;border-radius:3px;padding:0 3px;">已覆写</span>' : ''}
        </div>`;
      for (const [k, base] of Object.entries(params)) {
        const cur = o[k];
        html += `<div class="slider-row">
          <label style="font-size:11px;" title="出厂值 ${base}">${k}</label>
          <input type="number" class="skillparam-input" data-skill="${id}" data-param="${k}"
                 step="${Math.abs(base) < 1 ? 0.05 : 1}" value="${cur ?? ''}"
                 placeholder="${base}（出厂）" style="width:100px;">
        </div>`;
      }
      if (dirty) {
        html += `<button class="skillparam-clear" data-skill="${id}"
          style="margin-top:4px;font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;">🧹 清除该技能的覆写</button>`;
      }
      html += `</div>`;
    }
    return html;
  },

  _bindSkillParamsEvents(overlay, logFn, returnCallback) {
    overlay.querySelectorAll('.skillparam-clear').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.skill;
      if (CONFIG.skillOverrides) delete CONFIG.skillOverrides[id];
      logFn(`🧹 已清除「${id}」的全局覆写（回到出厂值）`, 'spawn');
      this._renderTemplateEditor(logFn, returnCallback);
    }));
  },

  _applySkillParamsChanges(overlay, logFn) {
    CONFIG.skillOverrides = CONFIG.skillOverrides || {};
    let set = 0, cleared = 0;
    overlay.querySelectorAll('.skillparam-input').forEach(inp => {
      const id = inp.dataset.skill, k = inp.dataset.param;
      const raw = inp.value.trim();
      if (raw === '') {
        // 留空 = 取消该键的覆写。整个技能没有覆写项了就把空壳也删掉，
        // 否则存档里会攒出一堆 `"weapon_x": {}` 这种没有信息量的噪音。
        if (CONFIG.skillOverrides[id] && k in CONFIG.skillOverrides[id]) {
          delete CONFIG.skillOverrides[id][k];
          cleared++;
          if (Object.keys(CONFIG.skillOverrides[id]).length === 0) delete CONFIG.skillOverrides[id];
        }
        return;
      }
      const v = parseFloat(raw);
      if (isNaN(v)) return;
      CONFIG.skillOverrides[id] = CONFIG.skillOverrides[id] || {};
      CONFIG.skillOverrides[id][k] = v;
      set++;
    });
    logFn(`✅ 技能全局覆写已更新（写入 ${set} 项，清除 ${cleared} 项）。已在场上的单位下一帧生效`, 'spawn');
  },

  _TPL_LABELS: { tower: '防御塔', melee: '近战兵', ranged: '远程兵', siege: '炮兵', totem: '图腾兵', super: '超级兵', warlock: '术士兵', corrupt: '蚀骨兵', ram: '攻城车', dragon: '巨龙', skill: '技能' },
 _TPL_ICONS: { melee: '🗡️', ranged: '🏹', siege: '💣', super: '🦾', totem: '🗿', warlock: '🧙', corrupt: '🦇', ram: '🛠️' },
  // 兵种列表【不再写死】：自制兵种必须和内置兵种一样出现在页签、出兵编排、
  // 成长表里。写死的话用户做出来的兵在界面上根本看不见 —— 等于没做出来。
  // 名称/图标同理走 customContent 的统一查询，内置的仍从上面两张表取。
  get _TPL_MINION_TYPES() { return allMinionTypes(); },
  _labelOf(type) { return this._TPL_LABELS[type] || minionLabel(type); },
  _iconOf(type) { return this._TPL_ICONS[type] || minionIcon(type); },
  // 分层防御塔：模板编辑器"防御塔"下的二级 tab。tier 与地图 tierStats / 生成建筑的 _mapTier 同键。
  _TPL_TOWER_TIERS: [
    { key: 'outer',      label: '外塔',     icon: '🗼' },
    { key: 'inner',      label: '内塔',     icon: '🏯' },
    { key: 'base',       label: '水晶塔',   icon: '🏛️' },
    { key: 'hq_tower',   label: '枢纽塔',   icon: '🏰' },
    { key: 'nexus_lane', label: '召唤水晶', icon: '🔮' },
    { key: 'nexus_main', label: '水晶枢纽', icon: '💎' },
  ],
  // 应用范围（用户定稿）：仅模板 / 仅场上目标 / 两者。阵营筛选对【塔与小兵都生效】。
  _applyScope: 'both',

  // ==================== 导航树 + 页面注册表 ====================
  // 这张表是"面板长什么样"的【唯一来源】：左树条目、右侧页签、两条作用域条出不出现、
  // 【应用】按钮存不存在与写到哪 —— 全部由它推导，渲染函数里不再写第二份 if。
  //
  // 为什么必须由页面自己声明：改版前面板对**每一页**都无条件画出【阵营】和
  // 【应用范围】两条作用域条，而真正会去读它们的只有 属性/武器/被动/状态 四页。
  // 用户在「建筑体积」页把阵营切到 🔴仅红方 再改尺寸，改掉的是双方共享的
  // CONFIG.buildingSizes，面板却明晃晃写着"仅红方"。
  // 控件摆在那儿却不起作用，比没有这个控件糟得多 —— 它让人相信了一件假事。
  //
  // 字段：
  //   faction  该页是否真的读 _factionScope（false 则不画阵营条）
  //   apply    该页是否真的读 _applyScope（false 则不画应用范围条）
  //   action   'apply' 改完要点应用 ｜ 'instant' 点了就生效 ｜ 'none' 只读
  //   writes   点【应用】究竟写到哪，直接印在按钮上，用户不必猜
  _TPL_PAGES: {
    attr:       { label: '属性',       icon: '📊', faction: true,  apply: true,  action: 'apply',   writes: '属性数值' },
    weapon:     { label: '武器',       icon: '🔫', faction: true,  apply: true,  action: 'apply',   writes: '默认武器' },
    skill:      { label: '被动技能',   icon: '🌀', faction: true,  apply: true,  action: 'apply',   writes: '被动技能组' },
    effect:     { label: '初始状态',   icon: '🧪', faction: true,  apply: true,  action: 'apply',   writes: '初始状态组' },
    soul:       { label: '龙魂',       icon: '🐉', faction: false, apply: false, action: 'instant', writes: '' },
    growth:     { label: '成长与屠戮', icon: '📈', faction: false, apply: false, action: 'apply',   writes: '成长/屠戮' },
    sandbox:    { label: '沙盒节奏',   icon: '🏖️', faction: false, apply: false, action: 'apply',   writes: '沙盒生成节奏' },
    wave:       { label: '出兵编排',   icon: '🧬', faction: true,  apply: false, action: 'apply',   writes: '对战出兵编排' },
    param:      { label: '技能数值',   icon: '✨', faction: false, apply: false, action: 'apply',   writes: '技能全局覆写' },
    bsize:      { label: '建筑体积',   icon: '🏗️', faction: false, apply: false, action: 'apply',   writes: '建筑体积' },
    dragonrule: { label: '刷新与强度', icon: '🐲', faction: false, apply: false, action: 'apply',   writes: '巨龙节奏与曲线' },
  },

  // 每个大类有哪几页（数组顺序 = 页签顺序）。
  // 「出兵编排」从"小兵 → 某个兵种 → 页签"提到了顶层：它本来就是**全局**规则，
  // 挂在某个兵种底下会让人以为"这是近战兵的编排"，而它管的是所有兵种。
  // 「沙盒节奏」反过来是**逐兵种**的，所以留在兵种节点下，两者不再同屏。
  _pagesOf(category) {
    switch (category) {
      case 'tower':      return ['attr', 'weapon', 'skill', 'effect', 'soul'];
      case 'minion':     return ['attr', 'skill', 'effect', 'growth', 'sandbox'];
      case 'dragon':     return ['attr', 'dragonrule'];
      case 'wave':       return ['wave'];
      case 'skillparam': return ['param'];
      case 'bsize':      return ['bsize'];
      default:           return ['attr'];
    }
  },

  // 左树。节点键：'tower:<tier>' / 'minion:<type>'，其余大类直接用大类名。
  _tplNav() {
    return [
      { title: '单位模板', items: [
        { key: 'tower', label: '🏰 防御塔',
          children: this._TPL_TOWER_TIERS.map(t => ({ key: 'tower:' + t.key, label: `${t.icon} ${t.label}` })) },
        { key: 'minion', label: '⚔️ 小兵',
          children: this._TPL_MINION_TYPES.map(t => ({ key: 'minion:' + t, label: `${this._iconOf(t)} ${this._labelOf(t)}` })) },
        { key: 'dragon', label: '🐉 巨龙' },
      ] },
      { title: '全局规则', items: [
        { key: 'wave',       label: '🧬 出兵编排' },
        { key: 'skillparam', label: '✨ 技能数值' },
        { key: 'bsize',      label: '🏗️ 建筑体积' },
      ] },
    ];
  },

  _curNodeKey() {
    const st = this._tplState || {};
    if (st.category === 'tower') return 'tower:' + (st.tier || 'outer');
    if (st.category === 'minion') return 'minion:' + (st.type || 'melee');
    return st.category || 'tower';
  },

  _selectNode(key) {
    const st = this._tplState;
    if (key.startsWith('tower:'))       { st.category = 'tower';  st.type = 'tower'; st.tier = key.slice(6); }
    else if (key.startsWith('minion:')) { st.category = 'minion'; st.type = key.slice(7); }
    else if (key === 'tower')           { st.category = 'tower';  st.type = 'tower'; st.tier = st.tier || 'outer'; }
    else if (key === 'minion')          { st.category = 'minion'; st.type = (st.type && st.type !== 'tower' && st.type !== 'dragon') ? st.type : 'melee'; }
    else                                { st.category = key;      st.type = (key === 'dragon') ? 'dragon' : key; }
    // 换节点后原来停留的那一页可能在新节点上不存在（塔有"武器"，小兵没有）。
    // 不校正的话 st.tab 会指向一个不存在的页，右侧直接空白 —— 旧面板"点着点着就没内容了"就是这么来的。
    const pages = this._pagesOf(st.category);
    if (!pages.includes(st.tab)) st.tab = pages[0];
  },

  // 当前节点在面包屑与【应用】按钮上的短名
  _nodeLabel() {
    const st = this._tplState || {};
    if (st.category === 'tower') return this._tierLabel(st.tier || 'outer');
    if (st.category === 'minion') return this._labelOf(st.type || 'melee');
    return ({ dragon: '巨龙', wave: '全局', skillparam: '全局', bsize: '全局' })[st.category] || '';
  },

  // 页面的**有效**声明。巨龙是中立野怪、不分阵营，所以它的属性页要把阵营条摘掉，
  // 否则又多一个"切了但不起作用"的控件。
  _effPage(page, category) {
    const P = this._TPL_PAGES[page] || this._TPL_PAGES.attr;
    return (category === 'dragon') ? { ...P, faction: false } : P;
  },
};
