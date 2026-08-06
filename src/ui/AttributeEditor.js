import { CONFIG } from '../data/Config.js';
import { SkillLibrary, renderSkillDescription } from '../core/SkillLibrary.js';
import { buildWaveOrder, WAVE_CONDITIONS, whenOptionGroups, hasFactionComposition, hasLaneComposition } from '../data/waveComposition.js';
import { dragonCfg, dragonStatsAt, dragonIntervalAt, DRAGON_DEFAULTS } from '../data/dragonCurve.js';
import { towerTierBase, towerTierEffective, towerTierSource } from '../data/schema/index.js';
import { exportTemplates, importTemplates, suggestedFileName } from '../data/templateIO.js';
import { syncAll as syncCustomContent, allMinionTypes, minionLabel, minionIcon } from '../data/customContent.js';

// 属性字段元数据：中文标签 + 滑块范围 + 步长（供动态滑块条使用）
const FIELD_META = {
  maxHP:              { label: '最大生命', min: 0, max: 20000, step: 50 },
  currentHP:          { label: '当前生命', min: 0, max: 20000, step: 50 },
  healthRegen:        { label: '生命回复/秒', min: 0, max: 200, step: 1 },
  baseHealthRegenMod: { label: '生命回复系数', min: 0, max: 5, step: 0.1 },
  attackDamage:       { label: '攻击力', min: 0, max: 2000, step: 5 },
  baseAttackSpeed:    { label: '基础攻速', min: 0.1, max: 5, step: 0.05 },
  bonusAttackSpeedPct:{ label: '攻速加成%', min: -100, max: 500, step: 5 },
  attackSpeedRatio:   { label: '攻速系数', min: 0, max: 2, step: 0.05 },
  attackRange:        { label: '攻击距离', min: 0, max: 800, step: 10 },
  bulletSpeed:        { label: '子弹速度', min: 0, max: 1200, step: 20 },
  armor:              { label: '护甲', min: -100, max: 500, step: 5 },
  magicResist:        { label: '魔抗', min: -100, max: 500, step: 5 },
  damageReduction:    { label: '伤害减免%', min: 0, max: 100, step: 1 },
  damageBlock:        { label: '格挡值', min: 0, max: 500, step: 5 },
  shieldFixedMax:     { label: '固定护盾上限', min: 0, max: 5000, step: 50 },
  shieldRegenRate:    { label: '护盾回复速率', min: 0, max: 100, step: 1 },
  tempShieldDecayPct: { label: '临时护盾衰减%', min: 0, max: 100, step: 1 },
  armorPenFlat:       { label: '固定护甲穿透', min: 0, max: 500, step: 5 },
  armorPenPercent:    { label: '百分比护甲穿透%', min: 0, max: 100, step: 1 },
  magicPenFlat:       { label: '固定法术穿透', min: 0, max: 500, step: 5 },
  magicPenPercent:    { label: '百分比法术穿透%', min: 0, max: 100, step: 1 },
  onHitDamage:        { label: '攻击特效固定伤害', min: 0, max: 1000, step: 5 },
  onHitPercentDamage: { label: '攻击特效%当前生命', min: 0, max: 50, step: 0.5 },
  damageConvertPct:   { label: '伤害转化%', min: 0, max: 100, step: 1 },
  lifeStealPct:       { label: '生命偷取%', min: 0, max: 100, step: 1 },
  healShieldPowerPct: { label: '治疗护盾强度%', min: -100, max: 200, step: 5 },
  allStatsPct:        { label: '全属性加成%', min: -100, max: 300, step: 5 },
  damageAmpPct:       { label: '伤害增幅%', min: -100, max: 300, step: 5 },
  moveSpeed:          { label: '移动速度', min: 0, max: 300, step: 5 },
};
const fieldLabel = (k) => FIELD_META[k]?.label || k;

export const AttributeEditor = {
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
    const scopeBars = (P.faction ? this._renderFactionScopeBar(page !== 'wave') : '')
                    + (P.apply ? this._renderApplyScopeBar() : '');
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
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndReturn(); });
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
      case 'sandbox':    return this._renderSandboxContent(type);
      case 'wave':       return this._renderWaveOrderContent();
      case 'param':      return this._renderSkillParamsContent();
      case 'bsize':      return this._renderBuildingSizeContent();
      case 'dragonrule': return this._renderDragonRuleContent();
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
      default: break;   // growth / sandbox / bsize / dragonrule 只有输入框，点应用时统一读
    }
  },

  _applyPage(page, overlay, type, logFn) {
    switch (page) {
      case 'attr':       this._applyTemplateAttrChanges(overlay, type, logFn); break;
      case 'weapon':     this._applyTemplateWeaponChanges(overlay, type, logFn); break;
      case 'skill':      this._applyTemplateSkillChanges(overlay, type, logFn); break;
      case 'effect':     this._applyTemplateEffectChanges(overlay, type, logFn); break;
      case 'growth':     this._applyGrowthChanges(overlay, type, logFn); break;
      case 'sandbox':    this._applySpawnRuleChanges(overlay, type, logFn); break;
      case 'wave':       this._applyWaveOrderChanges(overlay, logFn); break;
      case 'param':      this._applySkillParamsChanges(overlay, logFn); break;
      case 'bsize':      this._applyBuildingSizeChanges(overlay, logFn); break;
      case 'dragonrule': this._applyDragonRuleChanges(overlay, logFn); break;
      default: break;
    }
  },

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

  // ==================== 建筑体积（对战模式各档建筑的渲染半径）====================
  // LoL 中水晶枢纽/防御塔/召唤水晶体积不同，这里按 tier 提供可调半径。
  // 写入 CONFIG.buildingSizes；渲染器的塔精灵缓存 key 含尺寸，改动后新尺寸精灵
  // 会惰性重新烘焙，无需手动清缓存，画面即时生效。
  _BSIZE_TIERS: [
    ['outer', '外塔'], ['inner', '内塔'], ['base', '高地塔'],
    ['hq_tower', '枢纽塔'], ['nexus_lane', '召唤水晶'], ['nexus_main', '水晶枢纽'],
    ['default', '沙盒塔（默认）'],
  ],

  _renderBuildingSizeContent() {
    const sizes = CONFIG.buildingSizes || {};
    return `
      <p style="color:#8b949e;font-size:11px;margin:4px 0 10px;">对战模式各档建筑在画布上的渲染半径（px）。仅影响显示与血条位置，不影响攻击范围/碰撞。</p>
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
    const DRAGON_ELEMENTS = window.__app?.DRAGON_ELEMENTS || {};
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
        if (descBox) descBox.textContent = renderSkillDescription(def, entity, ctx) || def?.description || '';
      });
    });
    overlay.querySelectorAll('[data-tplsoul-remove]').forEach(chip => {
      chip.addEventListener('click', () => toggle(chip.dataset.tplsoulRemove));
    });
  },

  // ==================== 小兵生成规则 ====================
  // ============================================================
  //  SECTION 3: Spawn Rules + Building Size
  // ============================================================

  _spawnRuleMeta(type) {
    // 每种小兵对应 CONFIG.gameRules 里控制其生成节奏的字段
    const map = {
      melee:   { countKey: 'waveMeleeCount', countLabel: '每波生成数量', countDefault: 3 },
      ranged:  { countKey: 'waveRangedCount', countLabel: '每波生成数量', countDefault: 3 },
      siege:   { intervalKey: 'waveSiegeSuperInterval', intervalLabel: '每几波生成一次', intervalDefault: 2,
                 extraKey: 'waveSuperFromWave', extraLabel: '第几波起改为超级兵', extraDefault: 20 },
      totem:   { intervalKey: 'waveTotemInterval', intervalLabel: '每几波生成一次（沙盒）', intervalDefault: 5,
                 battleFromKey: 'battleTotemFromWave', battleFromLabel: '对战模式：第几波起生成', battleFromDefault: 10,
                 battleIntvKey: 'battleTotemInterval', battleIntvLabel: '对战模式：每几波生成一次', battleIntvDefault: 3 },
      warlock: { intervalKey: 'waveWarlockInterval', intervalLabel: '每几波生成一次', intervalDefault: 6,
                 minWaveKey: 'warlockMinWave', minWaveLabel: '最早生成波次', minWaveDefault: 12 },
      corrupt: { intervalKey: 'waveCorruptInterval', intervalLabel: '每几波生成一次', intervalDefault: 7,
                minWaveKey: 'corruptMinWave', minWaveLabel: '最早生成波次', minWaveDefault: 15 },
      ram:     { intervalKey: 'waveRamInterval', intervalLabel: '每几波生成一次', intervalDefault: 15,
                 minWaveKey: 'ramMinWave', minWaveLabel: '最早生成波次', minWaveDefault: 5 },
      super:   { intervalKey: 'waveSiegeSuperInterval', intervalLabel: '每几波生成一次（与炮兵共用节奏）', intervalDefault: 2 },
    };
    return map[type] || {};
  },

  // P2：原「生成规则」tab 已拆掉。用户原话是"目前的生成顺序和生成规则就是冲突或者是重合的" ——
  // 病根在于那一个 tab 里塞了四件互不相干的事：①沙盒出兵节奏 ②兵种总开关
  // ③对战成长 ④屠戮。而【对战】的出兵完全由另一个 tab 的 laneWaveComposition 决定。
  // 于是同一屏上"每波生成数量=3"和出兵编排里的"近战兵 ×3"看着是一回事，
  // 改前者在对战里纹丝不动 —— 这不是排版乱，是两套规则在同一个名字下打架。
  // 现在：成长/屠戮 → 独立的「成长与屠戮」tab（它们本来就跟生成无关，是战斗数值）；
  //       出兵的一切（对战编排 + 兵种开关 + 沙盒节奏）→ 合并进唯一的「出兵编排」tab，
  //       内部按模式分区并标明"这一段只管沙盒 / 这一段只管对战"。
  // 结论：现在"哪里改出兵"只有一个答案。
  _renderSandboxRuleRows(type) {
    const meta = this._spawnRuleMeta(type);
    const gr = CONFIG.gameRules;
    let html = '';
    if (meta.countKey) {
      const v = gr[meta.countKey] ?? meta.countDefault;
      html += `<div class="slider-row"><label>${meta.countLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.countKey}" min="0" step="1" value="${v}" style="width:90px;">
      </div>`;
    }
    if (meta.intervalKey) {
      const v = gr[meta.intervalKey] ?? meta.intervalDefault;
      html += `<div class="slider-row"><label>${meta.intervalLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.intervalKey}" min="1" step="1" value="${v}" style="width:90px;">
      </div>`;
    }
    if (meta.minWaveKey) {
      const v = gr[meta.minWaveKey] ?? meta.minWaveDefault;
      html += `<div class="slider-row"><label>${meta.minWaveLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.minWaveKey}" min="0" step="1" value="${v}" style="width:90px;">
      </div>`;
    }
    if (meta.extraKey) {
      const v = gr[meta.extraKey] ?? meta.extraDefault;
      html += `<div class="slider-row"><label>${meta.extraLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.extraKey}" min="0" step="1" value="${v}" style="width:90px;">
      </div>`;
    }
    // P2：这里原先还有两个标着"对战模式：第几波起生成 / 每几波生成一次"的框
    // （battleTotemFromWave / battleTotemInterval）。它们是【死配置】——
    // 全仓库除了 Config 的定义和一句过时注释，没有任何代码读取；对战出兵早已
    // 全部改由 laneWaveComposition 驱动，默认编排里那条
    // { type:'totem', count:1, fromWave:10, everyN:3 } 正是同一条规则的第二份表述。
    // 用户改了这两个框会毫无反应 —— 这就是"生成顺序和生成规则重合"的原型。
    // 已从面板移除；要调图腾兵的对战节奏请改上面②里那条规则。
    if (meta.battleFromKey) {
      // 「上面②」是旧版式的说法 —— 那时对战编排和沙盒节奏挤在同一页。
      // 现在编排在左侧的独立节点上，指路要指对地方，否则用户会在本页上下找一个不存在的②。
      html += `<div style="font-size:11px;color:var(--text-mute);padding:4px 0;">
        ${this._labelOf('totem')}的<b>对战</b>节奏由左侧「🧬 出兵编排」里那条规则的
        起始波/每几波决定，此处不再重复提供。</div>`;
    }
    if (!meta.countKey && !meta.intervalKey) {
      html += `<div style="color:#8b949e;font-size:12px;padding:4px 0;">该兵种在沙盒模式下没有独立的节奏参数。</div>`;
    }
    return html;
  },

  // ==================== 巨龙：刷新节奏与强度曲线 ====================
  // 这一页此前是**空的**（"巨龙暂无可编辑的固定模板"），而 DragonSystem 里刷新时间表
  // 和三条属性曲线全是写死的魔数；CONFIG.gameRules 里倒是躺着七个 dragonXxx 键，
  // 却没有任何一处代码读它们 —— 摆出来只会让人改了没反应。
  // 现在那七个死键已删除，真正生效的参数搬进 CONFIG.gameRules.dragon，这一页是它的入口。
  //
  // 预览用的是 dragonStatsAt / dragonIntervalAt —— 和引擎**同一个函数**（data/dragonCurve.js），
  // 所以"面板显示第 3 条龙 2400 血、实际刷出来不是"这种事在结构上就不可能发生。
  _renderDragonRuleContent() {
    const d = (CONFIG.gameRules.dragon = CONFIG.gameRules.dragon || {});
    const c = dragonCfg();
    const num = (k, label, v, step, hint) => `<div class="slider-row">
      <label style="width:150px;" title="${hint || ''}">${label}</label>
      <input type="number" class="dragonrule-input" data-dkey="${k}" step="${step}"
             value="${v === null || v === undefined ? '' : v}" style="width:100px;"></div>`;

    let html = `<div class="pick-desc-box" style="margin-bottom:10px;">
      🐲 巨龙的强度按<b>第几条龙</b>算，与游戏波次无关。<br>
      早期版本是按 <code>window.waveNumber</code> 算的，而龙按固定时间表刷新 ——
      7 分钟后刷第 2 条龙时波次可能已经到 10+，双抗直接飙到几百。这个口径不要改回去。
    </div>`;

    html += `<div style="font-size:12px;color:var(--text-dim);margin:10px 0 4px;">刷新节奏（秒）</div>`;
    html += num('firstDelay', '首条元素龙', c.firstDelay, 5, '开局多久后刷第一条');
    html += `<div class="slider-row"><label style="width:150px;" title="第 2/3/4… 条元素龙的间隔，逗号分隔；条数超出则沿用最后一项">元素龙后续间隔</label>
      <input type="text" class="dragonrule-input" data-dkey="elementIntervals"
             value="${c.elementIntervals.join(', ')}" style="flex:1;"></div>`;
    html += num('ancientFirstDelay', '首条远古龙', c.ancientFirstDelay, 10, '成魂结算后到第一条远古龙');
    html += num('ancientInterval', '远古龙间隔', c.ancientInterval, 10, '');

    const CURVES = [['maxHP', '生命'], ['resist', '双抗（护甲=魔抗）'], ['attackDamage', '攻击力']];
    html += `<div style="font-size:12px;color:var(--text-dim);margin:14px 0 4px;border-top:1px solid #2d3540;padding-top:10px;">
      强度曲线　<span style="font-size:10px;color:var(--text-mute);">
      第 w 条 = w≤拐点 ? 起点+(w−1)×前段增量 : 起点+(拐点−1)×前段增量+(w−拐点)×后段增量，再按上限截顶</span></div>`;
    for (const [key, label] of CURVES) {
      const sp = c.curve[key];
      html += `<div style="border:1px solid #2d3540;border-radius:4px;padding:8px;margin-bottom:8px;">
        <div style="font-size:12px;margin-bottom:6px;">${label}</div>
        ${num(`curve.${key}.base`, '第 1 条的值', sp.base, 1, '')}
        ${num(`curve.${key}.step`, '拐点前每条 +', sp.step, 1, '')}
        ${num(`curve.${key}.knee`, '拐点（第几条）', sp.knee, 1, '')}
        ${num(`curve.${key}.lateStep`, '拐点后每条 +', sp.lateStep, 1, '')}
        ${num(`curve.${key}.cap`, '上限（留空 = 不封顶）', sp.cap, 1, '留空表示不截顶')}
      </div>`;
    }

    html += `<div style="font-size:12px;color:var(--text-dim);margin:10px 0 4px;">远古龙修正（同序号曲线之上）</div>`;
    html += num('ancient.hpMult', '生命 ×', c.ancient.hpMult, 0.05, '');
    html += num('ancient.resistAdd', '双抗 +', c.ancient.resistAdd, 5, '');
    html += num('ancient.adMult', '攻击 ×', c.ancient.adMult, 0.05, '');

    // ---- 预览：与引擎共用 dragonStatsAt/dragonIntervalAt ----
    let t = c.firstDelay, rows = '';
    for (let i = 1; i <= 6; i++) {
      const st = dragonStatsAt(i, false);
      const mm = `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
      rows += `<tr><td style="padding:2px 8px;">第 ${i} 条</td><td style="padding:2px 8px;">${mm}</td>
        <td style="padding:2px 8px;">${st.maxHP}</td><td style="padding:2px 8px;">${st.armor}</td>
        <td style="padding:2px 8px;">${st.attackDamage}</td></tr>`;
      t += dragonIntervalAt({ soulUnlocked: false, elementSpawned: i });
    }
    const anc = dragonStatsAt(1, true);
    html += `<div style="margin-top:14px;border-top:1px solid #2d3540;padding-top:10px;">
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">预览（按<b>已保存</b>的配置算，点【应用】后刷新）</div>
      <table style="font-size:11px;width:100%;"><tr style="color:#8b949e;">
        <td style="padding:2px 8px;">序号</td><td style="padding:2px 8px;">出现时刻</td>
        <td style="padding:2px 8px;">生命</td><td style="padding:2px 8px;">双抗</td><td style="padding:2px 8px;">攻击</td></tr>
        ${rows}</table>
      <div style="font-size:11px;color:var(--text-mute);margin-top:6px;">
        首条远古龙：生命 ${anc.maxHP}／双抗 ${anc.armor}／攻击 ${anc.attackDamage}。
        元素龙共 ${CONFIG.gameRules.elementDragonTotal ?? 6} 条，
        某方击杀 ≥ ${CONFIG.gameRules.dragonSoulThreshold ?? 4} 条才成魂，都不到则无魂。</div>
    </div>`;
    return html;
  },

  _applyDragonRuleChanges(overlay, logFn) {
    const d = (CONFIG.gameRules.dragon = CONFIG.gameRules.dragon || {});
    d.curve = d.curve || {}; d.ancient = d.ancient || {};
    let changed = 0, bad = 0;
    overlay.querySelectorAll('.dragonrule-input').forEach(inp => {
      const key = inp.dataset.dkey;
      const raw = (inp.value || '').trim();
      if (key === 'elementIntervals') {
        const arr = raw.split(/[,，\s]+/).filter(Boolean).map(Number).filter(v => v > 0);
        // 空数组会让 dragonIntervalAt 取到 undefined → nextDragonTime 变 NaN → 龙永远不刷、
        // 且不报任何错。宁可退回出厂间隔，也不要把这种静默失效存进配置。
        if (!arr.length) { bad++; return; }
        d.elementIntervals = arr; changed++;
        return;
      }
      const path = key.split('.');
      // 上限留空 = 不封顶（null），这是合法取值，不能当"没填"跳过
      const isCap = path[path.length - 1] === 'cap';
      let v;
      if (raw === '') { if (!isCap) return; v = null; }
      else { v = parseFloat(raw); if (isNaN(v)) { bad++; return; } }
      let node = d;
      for (let i = 0; i < path.length - 1; i++) node = (node[path[i]] = node[path[i]] || {});
      node[path[path.length - 1]] = v;
      changed++;
    });
    logFn(`🐲 巨龙规则已更新（${changed} 项${bad ? `，${bad} 项填写无效已跳过` : ''}）。已在场上的龙不追溯`, 'spawn');
  },

  // ==================== 成长与屠戮（战斗数值，与"什么时候出兵"无关）====================
  // Q2：这两组数值原先硬编码在 main.js / 技能文件里，改平衡要翻源码。现在住在 CONFIG，
  // 面板改完立刻对【之后生成】的小兵生效（已出场的沿用出生时的成长快照）。
  _renderGrowthContent(type) {
    let html = `<div style="padding:4px 0;">`;
    html += `<div class="pick-desc-box" style="margin-bottom:10px;">
      📈 这里只管【单位有多强】，不管【什么时候出多少】—— 后者在「出兵编排」tab。<br>
      成长按<b>波次</b>线性累加，单位出生时结算一次并写死；已经在场上的兵不会追溯。
    </div>`;
    const G = CONFIG.battleGrowth?.[type];
    if (G) {
      html += `<div style="border-top:1px solid #2d3540;padding-top:10px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">📈 对战成长（每波固定增量）</div>
        <div class="slider-row"><label>最大生命 /波</label>
          <input type="number" class="growth-input" data-gkey="hp" step="0.1" value="${G.hp}" style="width:90px;"></div>
        <div class="slider-row"><label>攻击力 /波</label>
          <input type="number" class="growth-input" data-gkey="ad" step="0.05" value="${G.ad}" style="width:90px;"></div>
        <div class="slider-row"><label>双抗 /波</label>
          <input type="number" class="growth-input" data-gkey="res" step="0.05" value="${G.res}" style="width:90px;"></div>
        <div style="font-size:11px;color:var(--text-mute);margin-top:4px;">
          第 N 波的加值 = 上面三项 ×(N−1)。当前第 <b>${Math.max(1, window.waveNumber || 1)}</b> 波，
          该兵种加值：生命 +${(G.hp * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}、
          攻击 +${(G.ad * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}、
          双抗 +${(G.res * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}。</div>
      </div>`;
    } else {
      html += `<div style="color:#8b949e;font-size:12px;">该兵种未配置对战成长（每波数值恒定）。</div>`;
    }
    const R = CONFIG.rend?.[type];
    if (R) {
      html += `<div style="margin-top:12px;border-top:1px solid #2d3540;padding-top:10px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">🩸 屠戮</div>
        <div class="slider-row"><label>百分比（%）</label>
          <input type="number" class="rend-input" data-rkey="pct" step="0.5" value="${(R.pct * 100).toFixed(2)}" style="width:90px;"></div>
        <div class="slider-row"><label>伤害基数</label>
          <select class="rend-input" data-rkey="base" style="flex:1;">
            <option value="template" ${R.base !== 'current' ? 'selected' : ''}>模板基础生命（不随成长膨胀）</option>
            <option value="current" ${R.base === 'current' ? 'selected' : ''}>自身当前生命（旧行为）</option>
          </select></div>
        <div style="font-size:11px;color:var(--text-mute);margin-top:4px;">
          基数取"当前生命"时，屠戮会与生命同步膨胀，兵杀兵耗时永远恒定、两波兵永远互相清完聚不起来。
          取"模板基础生命"则前期照样快速清线、后期自然稀释。</div>
      </div>`;
    }
    html += `<div style="margin-top:10px;font-size:11px;color:var(--text-mute);">改完点【应用】写入，对之后生成的单位生效。</div>`;
    html += `</div>`;
    return html;
  },

  // ==================== 出兵顺序（对战模式，全局；用户："再加'出兵顺序'自定义"）====================
  // 数据就是 CONFIG.gameRules.laneWaveComposition —— 数组顺序即出兵先后。
  // 面板直接编排这个数组：上下移动 / 增删条目 / 改兵种·数量·起始波次·周期·触发条件，
  // 再配一个"第 N 波会出什么"的实时预览（预览与真实出兵共用 buildWaveOrder，不会骗人）。
  _waveOrderPreviewWave: 1,
  _waveOrderPreviewNexusDown: false,
  // 分路条件（外/内/水晶塔/召唤水晶）得指明看哪一路，否则"本路"没有着落
  _waveOrderPreviewLane: 'mid',

  // v43 Q5：编排的第二个维度 —— 路。'all' = 该阵营的全部路（原有行为）。
  // 具体路 id 由**当前地图**决定（峡谷 top/mid/bot、扭曲丛林 top/bot、嚎哭深渊 mid），
  // 所以页签是现生成的，不写死。
  _waveLaneScope: 'all',

  /** 当前地图的路列表（拿不到地图时退回三路，单测/沙盒下也有东西可显示）。 */
  _mapLaneIds() {
    const m = (window.CTX?.__app || window.__app)?.mapSystem?.currentMap;
    const ids = (m?.lanes || []).map(l => l.id).filter(Boolean);
    return ids.length ? ids : ['top', 'mid', 'bot'];
  },
  _laneLabel(id) {
    return ({ top: '⬆️ 上路', mid: '➡️ 中路', bot: '⬇️ 下路' })[id] || id;
  },

  /**
   * 当前作用域下【要编辑哪一份编排】。作用域是二维的：阵营 × 路。
   *   共享 + 全部路 → CONFIG.gameRules.laneWaveComposition            （最笼统，出厂基准）
   *   共享 + 某一路 → CONFIG.gameRules.laneWaveCompositionByLane[路]
   *   蓝/红 + 全部路 → CONFIG.factionOverrides[阵营].laneWaveComposition
   *   蓝/红 + 某一路 → CONFIG.factionOverrides[阵营].laneWaveCompositionByLane[路]
   * 读写共用这一个入口，避免"面板改 A、出兵读 B"。
   * create=false（只读渲染）时，某一格还没有自己的编排就**显示它实际会生效的那一份**
   *（顺序与 waveComposition.compositionFor 完全一致），一旦真的动手改才复制成本格专属。
   */
  _woList(create = false) {
    const gr = CONFIG.gameRules;
    gr.laneWaveComposition = gr.laneWaveComposition || [];
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const isLane = lane && lane !== 'all';
    const nonEmpty = (a) => (Array.isArray(a) && a.length) ? a : null;

    // ---- 本格已经有自己的编排？直接用 ----
    let box;
    if (isFac) {
      CONFIG.factionOverrides = CONFIG.factionOverrides || {};
      CONFIG.factionOverrides[f] = CONFIG.factionOverrides[f] || {};
      box = CONFIG.factionOverrides[f];
    } else {
      box = gr;
    }
    if (isLane) {
      const own = nonEmpty(box.laneWaveCompositionByLane?.[lane]);
      if (own) return own;
    } else if (isFac) {
      const own = nonEmpty(box.laneWaveComposition);
      if (own) return own;
    } else {
      return gr.laneWaveComposition;   // 共享 + 全部路 = 出厂基准本身
    }

    // ---- 本格还没有：按 compositionFor 的顺序找出"实际生效的那一份" ----
    const inherited =
         (isLane && isFac && nonEmpty(CONFIG.factionOverrides?.[f]?.laneWaveComposition))
      || (isLane && nonEmpty(gr.laneWaveCompositionByLane?.[lane]))
      || gr.laneWaveComposition;
    if (!create) return inherited;   // 只读时显示继承来的那份

    // 首次编辑本格：从继承来的那份复制一份，之后各改各的
    const copy = inherited.map(r => ({ ...r }));
    if (isLane) {
      box.laneWaveCompositionByLane = box.laneWaveCompositionByLane || {};
      box.laneWaveCompositionByLane[lane] = copy;
    } else {
      box.laneWaveComposition = copy;
    }
    return copy;
  },
  _woSetList(arr) {
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const box = isFac
      ? ((CONFIG.factionOverrides = CONFIG.factionOverrides || {},
          CONFIG.factionOverrides[f] = CONFIG.factionOverrides[f] || {}))
      : CONFIG.gameRules;
    if (lane && lane !== 'all') {
      box.laneWaveCompositionByLane = box.laneWaveCompositionByLane || {};
      box.laneWaveCompositionByLane[lane] = arr;
    } else {
      box.laneWaveComposition = arr;
    }
  },
  /** 清掉当前这一格的专属编排（回到它继承的那一份）。 */
  _woClearCell() {
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const box = isFac ? CONFIG.factionOverrides?.[f] : CONFIG.gameRules;
    if (!box) return;
    if (lane && lane !== 'all') { if (box.laneWaveCompositionByLane) delete box.laneWaveCompositionByLane[lane]; }
    else if (isFac) delete box.laneWaveComposition;
  },
  /** 当前格子有没有自己的编排（决定角标与"清除本格"按钮）。 */
  _woCellOwned() {
    const f = this._factionScope, lane = this._waveLaneScope;
    if (lane && lane !== 'all') return hasLaneComposition(f, lane);
    return f && f !== 'shared' ? hasFactionComposition(f) : false;
  },

  _renderWaveOrderContent() {
    const gr = CONFIG.gameRules;
    const list = this._woList(false);
    const types = this._TPL_MINION_TYPES;
    const EN = gr.spawnEnabled || {};

    const cell = (rule, i, key, min, step) =>
      `<input type="number" class="wo-field" data-idx="${i}" data-field="${key}" min="${min}" step="${step}"
              value="${rule[key] ?? ''}" placeholder="${key === 'count' ? 1 : (key === 'everyN' ? 1 : 0)}">`;

    // P2：出兵的一切都收在这一个 tab 里，但【必须】按模式分区并写明各自管谁 ——
    // 两套规则同屏而不标注模式，正是用户说的"冲突或者是重合"。
    let html = `<div class="pick-desc-box" style="margin-bottom:10px;">
      🧬 <b>对战模式</b>出什么兵、按什么顺序出，全在这一页。分两段：<br>
      　<b>① 兵种总开关</b>　对<b>沙盒+对战</b>都生效，关掉的兵种下面怎么排都不会出。<br>
      　<b>② 对战编排</b>　只管<b>对战模式</b>：数组顺序 = 出兵先后。<br>
      沙盒模式的出兵节奏是<b>逐兵种</b>的，在左侧对应兵种的「🏖️ 沙盒节奏」页 ——
      它和这里的编排是两套互不相干的规则，同屏摆着正是用户说的"生成顺序和生成规则冲突或者重合"。
    </div>`;

    // ---- ① 兵种总开关（原「生成规则」里逐个类型翻页才能看到，现在一屏全景）----
    html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">① 兵种总开关（沙盒 + 对战通用）</div>`;
    html += `<div class="editor-tabs" style="flex-wrap:wrap;margin-bottom:12px;">
      ${types.map(t => {
        const on = EN[t] !== false;
        return `<button class="editor-tab ${on ? 'active' : ''}" data-spawn-toggle="${t}"
                 title="${on ? '点击停用' : '点击启用'}" style="font-size:11px;">
          ${on ? '✅' : '⛔'} ${this._iconOf(t)}${this._labelOf(t)}
        </button>`;
      }).join('')}
    </div>`;

    const _f = this._factionScope;
    const _lane = this._waveLaneScope || 'all';
    const _own = this._woCellOwned();
    const _who = _f === 'blue' ? '🔵蓝方' : _f === 'red' ? '🔴红方' : '双方共享';
    const _laneTxt = _lane === 'all' ? '全部路' : this._laneLabel(_lane);
    // v43 Q5：路的页签。**按当前地图的 lanes 现生成** —— 峡谷 3 路、扭曲丛林 2 路、
    // 嚎哭深渊 1 路，写死三路的话在后两张图上会摆出根本不存在的页签
    //（用户："每个地图的路数不同，UI上记得做区分！"）。
    const _laneIds = this._mapLaneIds();
    const _mapLabel = ((window.CTX?.__app || window.__app)?.mapSystem?.currentMap?.label) || '当前地图';
    html += `<div style="font-size:12px;color:var(--text-dim);margin:0 0 4px;border-top:1px solid #2d3540;padding-top:10px;">
      ② 对战编排（数组顺序 = 出兵先后）　
      <span style="font-size:10px;color:${_own ? '#58a6ff' : 'var(--text-mute)'};">
        作用域：${_who} × ${_laneTxt}${_own ? '（本格已有独立编排）' : '（当前显示继承来的那份，一改就会复制成本格专属）'}
      </span>
      ${_own ? `<button id="woClearFaction" style="float:right;font-size:10px;padding:1px 8px;border-radius:4px;cursor:pointer;">🧹 清除本格编排</button>` : ''}
      </div>`;
    html += `<div class="editor-tabs" style="flex-wrap:wrap;margin-bottom:6px;">
      <span style="font-size:10px;color:var(--text-mute);align-self:center;margin-right:6px;">路（${_mapLabel}，${_laneIds.length} 条）：</span>
      <button class="editor-tab ${_lane === 'all' ? 'active' : ''}" data-wo-lane="all" style="font-size:11px;">🌐 全部路</button>
      ${_laneIds.map(id => `<button class="editor-tab ${_lane === id ? 'active' : ''}" data-wo-lane="${id}" style="font-size:11px;">${this._laneLabel(id)}${hasLaneComposition(_f, id) ? ' ●' : ''}</button>`).join('')}
    </div>`;
    html += `<div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
      解析顺序（先命中先用）：<b>本阵营·本路</b> → <b>本阵营·全部路</b> → <b>共享·本路</b> → <b>共享·基准</b>。
      页签上的 ● 表示那一格有自己的编排。</div>`;
    html += `<div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
      「起始波」之前不出；之后每「每几波」出一次；「生效条件」再叠一层门槛（三者是<b>与</b>的关系）。<br>
      条件里的<b>本路</b>指这条规则当前正在为之出兵的那一路；枢纽塔/水晶枢纽不分路，按<b>全场</b>算。
      条件不成立的规则本波直接跳过，不影响同一编排里的其它规则。</div>`;

    // 表头与每一行走**同一套 grid 列宽**（--wo-cols）。原来两边各写一串固定 px，
    // 表头 52/96/62/62/62 和行里的按钮/输入框实际宽度对不上，列标题整体左偏 ——
    // 用户说的"UI 显示格式有些混乱"就是这个。现在列宽只有一处定义，不可能再错位。
    html += `<div class="wo-row wo-head">
      <span>顺序</span><span>兵种</span><span>数量</span><span>起始波</span>
      <span>每几波</span><span>生效条件</span><span></span>
    </div>`;

    if (list.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">编排为空 —— 当前对战不会生成任何小兵。</div>`;
    }
    const groups = whenOptionGroups();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const off = EN[r.type] === false;
      const cond = WAVE_CONDITIONS[r.when || ''] || WAVE_CONDITIONS[''];
      // 需要参数的条件（"游戏已进行 ≥ N 秒"）才显示那个数值框。
      // 无条件显示的话，用户会对着一个"总是"规则旁边的空数字框琢磨半天它管什么。
      const argBox = cond.arg
        ? `<input type="number" class="wo-field wo-arg" data-idx="${i}" data-field="whenArg"
                  min="${cond.arg.min ?? 0}" step="${cond.arg.step ?? 1}"
                  value="${r.whenArg ?? ''}" placeholder="${cond.arg.def}"
                  title="${cond.arg.label}">`
        : '';
      html += `<div class="wo-row${off ? ' wo-off' : ''}">
        <span class="wo-move-cell">
          <button class="wo-move" data-idx="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="wo-move" data-idx="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
        </span>
        <select class="wo-field" data-idx="${i}" data-field="type">
          ${types.map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${this._iconOf(t)} ${this._labelOf(t)}</option>`).join('')}
        </select>
        ${cell(r, i, 'count', 0, 1)}${cell(r, i, 'fromWave', 0, 1)}${cell(r, i, 'everyN', 1, 1)}
        <span class="wo-when-cell">
          <select class="wo-field" data-idx="${i}" data-field="when">
            ${groups.map(g => `<optgroup label="${g.label}">${g.items.map(o =>
              `<option value="${o.value}" ${(r.when || '') === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</optgroup>`).join('')}
          </select>${argBox}
        </span>
        <button class="wo-del" data-idx="${i}" title="删除这条规则">✕</button>
      </div>`;
    }

    html += `<div style="margin-top:8px;"><button id="woAddBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加一条</button>
      <button id="woResetBtn" style="margin-left:6px;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">↺ 恢复默认编排</button></div>`;

    // ---- 实时预览 ----
    const w = this._waveOrderPreviewWave, nd = this._waveOrderPreviewNexusDown;
    // 预览必须带世界快照。不带的话，依赖建筑/时间的条件按"未知即放行"处理，
    // 预览就会报出实战不会出现的兵 —— 正是这个面板当初要解决的"预览骗人"。
    // 时间由波次推算：对战首波 firstWaveDelay 秒，之后每 waveInterval 秒一波，
    // 与 LaneWaveSystem 读的是同两个键，所以推算口径和实战一致。
    const _wi = window.CTX?.__app?.laneWaveSystem;
    const _first = _wi?.firstWaveDelay ?? CONFIG.gameRules.firstWaveDelay ?? 20;
    const _every = _wi?.waveInterval ?? CONFIG.gameRules.waveInterval ?? 45;
    const _pvTime = Math.max(0, _first + Math.max(0, w - 1) * _every);
    // 建筑普查取【场上真实状态】。没在对战里（没有地图）时给 null，
    // 那些条件就退回"放行"，并在下面的说明里如实写出来，而不是假装算准了。
    const _census = window.CTX?.__app?.mapSystem?.structureCensus?.() || null;
    // 预览按【当前作用域的阵营】算 —— 不传 faction 的话，编了红方专属编排却预览共享的，
    // 就又回到"预览骗人"那个老问题上了。
    const _pf = (this._factionScope && this._factionScope !== 'shared') ? this._factionScope : null;
    const order = buildWaveOrder(w, nd, gr, _pf, {
      gameTime: _pvTime, laneId: this._waveOrderPreviewLane, census: _census,
    });
    html += `<div style="margin-top:14px;border-top:1px solid #2d3540;padding-top:10px;">
      <div class="slider-row" style="gap:8px;">
        <label style="width:auto;">预览第</label>
        <input type="number" id="woPreviewWave" min="0" step="1" value="${w}" style="width:70px;">
        <label style="width:auto;">波，路</label>
        <select id="woPreviewLane" style="width:80px;">
          ${(window.CTX?.__app?.mapSystem?.currentMap?.lanes || [{ id: 'top' }, { id: 'mid' }, { id: 'bot' }])
            .map(l => `<option value="${l.id}" ${l.id === this._waveOrderPreviewLane ? 'selected' : ''}>${l.id}</option>`).join('')}
        </select>
        <button id="woPreviewNexus" class="editor-tab ${nd ? 'active' : ''}" style="flex:1;font-size:11px;">
          ${nd ? '💥 本路水晶已陷落' : '🔮 本路水晶完好'}
        </button>
      </div>
      <div class="pick-desc-box" style="margin-top:6px;">
        共 <b>${order.length}</b> 个单位：${order.length
          ? order.map(t => `${this._iconOf(t)}${this._labelOf(t)}`).join(' → ')
          : '（本波无兵）'}
      </div>
      <div style="font-size:10px;color:var(--text-mute);margin-top:4px;">
        按第 ${w} 波 ≈ 开局 ${Math.floor(_pvTime / 60)}分${String(Math.round(_pvTime % 60)).padStart(2, '0')}秒 推算
        （首波 ${_first}s，之后每 ${_every}s 一波）。
        ${_census
          ? `建筑条件按<b>当前场上</b>的存活情况判定（本路：${this._waveOrderPreviewLane}）。`
          : `<b>当前不在对战中</b>，读不到建筑存活情况 —— 依赖建筑的条件在预览里一律按"成立"算，实战中会真判。`}
      </div>
    </div>`;
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-mute);">
      ①即点即生效；②改完点【应用】写入，下一波起生效。</div>`;
    return html;
  },

  // 沙盒节奏：**逐兵种**，所以它住在该兵种的节点下，而不是和全局编排挤在同一页。
  // 这两者曾经同屏，于是"每波生成数量=3"和编排里的"近战兵 ×3"看着是一回事，
  // 改前者在对战里纹丝不动 —— 那不是排版乱，是两套规则顶着同一个名字打架。
  _renderSandboxContent(type) {
    return `<div class="pick-desc-box" style="margin-bottom:10px;">
        🏖️ 这一页<b>只影响沙盒模式</b>。对战模式的出兵完全由左侧「🧬 出兵编排」决定，
        改这里在对战里看不到任何变化。
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">
        当前兵种：${this._iconOf(type)}${this._labelOf(type)}</div>
      ${this._renderSandboxRuleRows(type)}
      <div style="margin-top:10px;font-size:11px;color:var(--text-mute);">改完点【应用】写入。</div>`;
  },

  // 兵种总开关：即点即生效（它只是个布尔，没有"批量应用"的必要）。
  _bindSpawnToggles(overlay, logFn, rerender) {
    overlay.querySelectorAll('[data-spawn-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.spawnToggle;
        CONFIG.gameRules.spawnEnabled = CONFIG.gameRules.spawnEnabled || {};
        const now = CONFIG.gameRules.spawnEnabled[t] !== false;
        CONFIG.gameRules.spawnEnabled[t] = !now;
        logFn(`⚙️ 「${this._labelOf(t)}」生成开关：${!now ? '开' : '关'}（沙盒+对战通用）`, 'spawn');
        // 重绘：编排表里该兵种的行要跟着变灰/变亮，预览也要重算
        if (rerender) rerender(); else {
          btn.classList.toggle('active', !now);
        }
      });
    });
  },

  _bindWaveOrderEvents(overlay, logFn) {
    const gr = CONFIG.gameRules;
    // 只重绘内容区，不整屏重绘 —— 整屏重绘会重建左树并让滚动位置跳回顶部，
    // 而这一页的结构性操作（上移/下移/删/加）是连续动作，跳一次就得重新找位置。
    const rerender = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderWaveOrderContent();
      this._bindWaveOrderEvents(overlay, logFn);
    };
    this._bindSpawnToggles(overlay, logFn, rerender);
    // 结构性操作（上下移/删/加/恢复默认）即点即改数组并重绘；
    // 重绘前先把当前所有输入框的值收回数组，否则移动一行会把没点应用的编辑丢掉。
    const flush = () => this._readWaveOrderInputs(overlay);

    overlay.querySelectorAll('.wo-move').forEach(b => b.addEventListener('click', () => {
      flush();
      const i = +b.dataset.idx, d = +b.dataset.dir, j = i + d;
      const a = this._woList(true);
      if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
      rerender();
    }));
    overlay.querySelectorAll('.wo-del').forEach(b => b.addEventListener('click', () => {
      flush();
      this._woList(true).splice(+b.dataset.idx, 1);
      rerender();
    }));
    overlay.querySelector('#woAddBtn')?.addEventListener('click', () => {
      flush();
      this._woList(true).push({ type: 'melee', count: 1 });
      rerender();
    });
    overlay.querySelectorAll('[data-wo-lane]').forEach(b => b.addEventListener('click', () => {
      flush();
      this._waveLaneScope = b.dataset.woLane;
      // 预览也跟着切到这一路：否则会出现"在上路页签上看着中路的预览"
      if (this._waveLaneScope !== 'all') this._waveOrderPreviewLane = this._waveLaneScope;
      rerender();
    }));
    overlay.querySelector('#woClearFaction')?.addEventListener('click', () => {
      const f = this._factionScope, lane = this._waveLaneScope || 'all';
      this._woClearCell();
      const who = f === 'blue' ? '蓝方' : f === 'red' ? '红方' : '共享';
      const where = lane === 'all' ? '全部路' : this._laneLabel(lane);
      logFn(`🧹 已清除【${who} × ${where}】的独立出兵编排（回到它继承的那一份）`, 'spawn');
      rerender();
    });
    overlay.querySelector('#woResetBtn')?.addEventListener('click', () => {
      this._woSetList(this._DEFAULT_WAVE_COMPOSITION.map(r => ({ ...r })));
      logFn('↺ 出兵编排已恢复默认', 'spawn');
      rerender();
    });
    // 字段改动即时反映到预览
    overlay.querySelectorAll('.wo-field').forEach(el => el.addEventListener('change', () => { flush(); rerender(); }));

    overlay.querySelector('#woPreviewWave')?.addEventListener('change', (e) => {
      this._waveOrderPreviewWave = Math.max(0, parseInt(e.target.value, 10) || 0);
      flush(); rerender();
    });
    overlay.querySelector('#woPreviewLane')?.addEventListener('change', (e) => {
      this._waveOrderPreviewLane = e.target.value;
      flush(); rerender();
    });
    overlay.querySelector('#woPreviewNexus')?.addEventListener('click', () => {
      this._waveOrderPreviewNexusDown = !this._waveOrderPreviewNexusDown;
      flush(); rerender();
    });
  },

  // 默认编排（= Config.js 里的出厂值），供「恢复默认」使用
  _DEFAULT_WAVE_COMPOSITION: [
    { type: 'super',  count: 1, when: 'nexusDown' },
    { type: 'melee',  count: 3 },
    { type: 'siege',  count: 1, everyN: 3, when: '!nexusDown' },
    { type: 'ranged', count: 3 },
    { type: 'totem',  count: 1, fromWave: 10, everyN: 3 },
    { type: 'ram',    count: 1, fromWave: 5,  everyN: 15 },
  ],

  // 把面板上所有 .wo-field 的当前值收回 laneWaveComposition。
  // 留空的数值字段一律删除该键（回到规则默认：count=1 / fromWave=0 / everyN=1），
  // 免得存下一堆 NaN 让 buildWaveOrder 静默漏兵。
  _readWaveOrderInputs(overlay) {
    // 走 _woList(true)：一旦在蓝/红作用域下动了输入框，就复制成该阵营专属编排。
    // 写回共享基准的话，改红方会连蓝方一起改掉 —— 正是这条需求要避免的事。
    const list = this._woList(true);
    overlay.querySelectorAll('.wo-field').forEach(el => {
      const r = list[+el.dataset.idx];
      if (!r) return;
      const f = el.dataset.field;
      if (f === 'type') { r.type = el.value; return; }
      if (f === 'when') {
        if (el.value) r.when = el.value; else delete r.when;
        const arg = WAVE_CONDITIONS[el.value]?.arg;
        // 换成不吃参数的条件时把 whenArg 一并清掉 —— 留着它会在导出的 JSON 里
        // 攒出一堆没人读的字段，下一个人看到会以为这条规则还带着时间门槛。
        if (!arg) delete r.whenArg;
        // 反过来：选了吃参数的条件就【把声明的默认值真的写进去】。
        // 只把它当 placeholder 显示是个陷阱 —— 框里灰着 600、实际按 0 判定，
        // 于是"游戏满 10 分钟才出的兵"第 1 波就出来了，而面板看着完全正常。
        else if (r.whenArg == null) r.whenArg = arg.def;
        return;
      }
      const raw = el.value.trim();
      if (raw === '') {
        // whenArg 清空 → 回到该条件声明的默认值，而不是变成"没有门槛"
        // （"不要门槛"的表达方式是把条件本身换成「总是」）。
        const arg = WAVE_CONDITIONS[r.when || '']?.arg;
        if (f === 'whenArg' && arg) r.whenArg = arg.def; else delete r[f];
        return;
      }
      const v = parseFloat(raw);
      if (!isNaN(v)) r[f] = Math.max(f === 'everyN' ? 1 : 0, f === 'whenArg' ? v : Math.round(v));
    });
    return list;
  },

  _applyWaveOrderChanges(overlay, logFn) {
    const list = this._readWaveOrderInputs(overlay);
    const w = this._waveOrderPreviewWave;
    // 按【当前作用域的阵营】算。不传 faction 的话，编的是红方专属编排、
    // 回执里报的却是共享基准的条数 —— 又一处"面板说的和实际发生的不是一回事"。
    const f = (this._factionScope && this._factionScope !== 'shared') ? this._factionScope : null;
    const n = buildWaveOrder(w, this._waveOrderPreviewNexusDown, CONFIG.gameRules, f).length;
    const who = f ? (f === 'blue' ? '🔵蓝方' : '🔴红方') : '双方共享';
    logFn(`✅ 出兵编排已应用（${who}，${list.length} 条规则；第 ${w} 波将出 ${n} 个单位）`, 'spawn');
  },

  _applySpawnRuleChanges(overlay, type, logFn) {
    const inputs = overlay.querySelectorAll('.spawnrule-input');
    let changed = 0;
    inputs.forEach(inp => {
      const key = inp.dataset.key;
      const val = parseFloat(inp.value);
      if (!isNaN(val) && key) {
        CONFIG.gameRules[key] = val;
        changed++;
      }
    });
    if (changed) logFn(`✅ 「${this._labelOf(type)}」沙盒节奏已更新（${changed}项）`, 'spawn');
  },

  // P2：成长/屠戮从原「生成规则」里拆出来单独应用。它们是战斗数值，
  // 跟"什么时候出多少兵"没有任何关系，塞在一起是原编辑器最误导的一处。
  _applyGrowthChanges(overlay, type, logFn) {
    let changed = 0;
    // Q2：对战成长表
    if (CONFIG.battleGrowth?.[type]) {
      overlay.querySelectorAll('.growth-input').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { CONFIG.battleGrowth[type][inp.dataset.gkey] = v; changed++; }
      });
    }
    // Q2：屠戮（百分比按 % 输入，存成小数）
    if (CONFIG.rend?.[type]) {
      overlay.querySelectorAll('.rend-input').forEach(inp => {
        const k = inp.dataset.rkey;
        if (k === 'base') { CONFIG.rend[type].base = inp.value; changed++; return; }
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { CONFIG.rend[type].pct = v / 100; changed++; }
      });
    }
    logFn(`✅ 「${this._labelOf(type)}」成长/屠戮已更新（${changed}项）`, 'spawn');
  },

  // ==================== 渲染方法 ====================
  // ============================================================
  //  SECTION 1: Live Entity Editor ? attributes, weapons, passives, effects
  // ============================================================

  // srcCtx（可选，仅分层塔用）：{ tier }。给每个字段标出"这个数是从叠加链的哪一层来的"。
  // 塔的数值要穿过 模板 → 地图 tierStats → 共享覆写 → 阵营覆写 四层，面板过去只显示最终值，
  // 于是"我改了怎么没变"（被更靠后的层压住）和"我没改它怎么是这个数"（地图带了 tierStats）
  // 两类问题都无法自查 —— 这是模板编辑器最费解的一处。
  _renderAttrContent(target, isTemplate = false, srcCtx = null) {
    // 实体编辑：currentHP 存在 entity 上而非 baseStats，需合并进显示数据源，
    // 否则"当前生命"会显示 0（此前的 bug）。
    const data = isTemplate ? { ...target } : { ...target.baseStats, currentHP: target.currentHP };
    // v33（Q13）：塔实体可编辑【模型大小】（渲染半径，仅显示与血条位置，不影响攻击范围/碰撞）。
    // 留空 = 沿用该档建筑的全局尺寸（CONFIG.buildingSizes）。
    const modelSizeRow = (!isTemplate && target.type === 'tower') ? `
      <div class="editor-field" style="display:flex;align-items:center;gap:8px;margin:2px 0 8px;">
        <label style="width:130px;">📐 模型大小(px)</label>
        <input type="number" id="editorModelSize" min="8" max="80" step="1"
          value="${target._modelSize ?? ''}" placeholder="${(CONFIG.buildingSizes || {})[target._mapTier] ?? (CONFIG.buildingSizes || {}).default ?? 28}（默认）"
          style="width:110px;">
        <span style="font-size:10px;color:#8b949e;">留空=用该档建筑的全局尺寸</span>
      </div>` : '';
    const allKeys = Object.keys(data).filter(k => typeof data[k] === 'number');

    const coreKeys = ['maxHP', 'currentHP', 'healthRegen', 'baseHealthRegenMod'];
    const attackKeys = ['attackDamage', 'baseAttackSpeed', 'bonusAttackSpeedPct', 'attackSpeedRatio', 'attackRange', 'attackType', 'bulletSpeed'];
    const defenseKeys = ['armor', 'magicResist', 'damageReduction', 'damageBlock', 'shieldFixedMax', 'shieldRegenRate', 'tempShieldDecayPct'];
    const penKeys = ['armorPenFlat', 'armorPenPercent', 'magicPenFlat', 'magicPenPercent'];
    const effectKeys = ['onHitDamage', 'onHitPercentDamage', 'damageConvertPct', 'lifeStealPct', 'healShieldPowerPct', 'allStatsPct'];
    const allDefinedKeys = [...coreKeys, ...attackKeys, ...defenseKeys, ...penKeys, ...effectKeys];

    const groups = {
      '核心': coreKeys,
      '攻击': attackKeys,
      '防御': defenseKeys,
      '穿透': penKeys,
      '特效': effectKeys,
      '其他': allKeys.filter(k => !allDefinedKeys.includes(k))
    };

    let html = `<div class="editor-tabs">`;
    let firstGroup = true;
    for (const g of Object.keys(groups)) {
      if (groups[g].length) {
        html += `<div class="editor-tab${firstGroup ? ' active' : ''}" data-group="${g}">${g}</div>`;
        firstGroup = false;
      }
    }
    html += `</div><div class="editor-body">`;
    for (const [g, keys] of Object.entries(groups)) {
      if (!keys.length) continue;
      html += `<div class="editor-group" data-group="${g}" style="display:${g === '核心' ? '' : 'none'};">`;
      for (const key of keys) {
        const value = data[key] ?? 0;
        const label = fieldLabel(key);
        if (key === 'attackType') {
          html += `<div class="slider-row"><label title="${key}">${label}</label><select data-key="${key}" data-orig="${value}" class="editor-select">`;
          for (const opt of [['physical','物理'],['magic','魔法'],['true','真实']]) {
            html += `<option value="${opt[0]}" ${value === opt[0] ? 'selected' : ''}>${opt[1]}</option>`;
          }
          html += `</select></div>`;
        } else {
          const meta = FIELD_META[key] || { min: 0, max: Math.max(100, value * 2), step: (key === 'currentHP' ? 1 : 0.1) };
          html += `<div class="slider-row">
            <label title="${key}">${label}${this._srcBadge(srcCtx, key)}</label>
            <div class="slider-wrap">
              <input type="range" class="editor-slider" data-key="${key}" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="${Math.min(meta.max, Math.max(meta.min, value))}">
              <input type="number" class="editor-number" data-key="${key}" data-orig="${value}" step="${meta.step}" value="${value}">
            </div>
          </div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>`;
    return modelSizeRow + html;
  },

  // 取值来源角标。只在分层塔的模板页显示；只有一层时不显示（没有信息量，纯噪音）。
  _SRC_COLOR: { '模板': '#8b949e', '地图': '#d29922', '共享覆写': '#58a6ff', '蓝方覆写': '#58a6ff', '红方覆写': '#f85149' },
  _srcBadge(srcCtx, key) {
    if (!srcCtx?.tier) return '';
    let r;
    try { r = towerTierSource(srcCtx.tier, key, this._factionScope); } catch (e) { return ''; }
    if (!r.chain.length || r.chain.length === 1) return '';
    // 被压住的层按顺序列进 title，用户一眼能看出"我改的那层排在第几、被谁盖了"
    const overridden = r.chain.slice(0, -1).map(c => `${c.layer} ${c.value}`).join(' → ');
    const color = this._SRC_COLOR[r.source] || '#8b949e';
    return `<span style="margin-left:4px;font-size:9px;color:${color};border:1px solid ${color};
      border-radius:3px;padding:0 3px;vertical-align:middle;"
      title="生效层：${r.source}（${r.value}）&#10;被覆盖：${overridden}">${r.source}</span>`;
  },

  _renderWeaponContent(entity) {
    const current = entity._skillInstances?.find(s => s.skillId.startsWith('weapon_'))?.skillId || 'weapon_piercing'; // v33
    const weaponMeta = {
      weapon_piercing: { label: '穿透型', icon: '🔷' },
      weapon_lightning: { label: '闪电杖', icon: '⚡' },
      weapon_explosive: { label: '爆炸型', icon: '💥' },
      weapon_corrosion: { label: '腐蚀型', icon: '🌿' },
    };
    const weaponIds = this._SKILLS_BY_TYPE.tower.weapons;
    const weapons = [{ id: 'none', label: '无武器', icon: '🚫' }, ...weaponIds.map(id => ({ id, ...weaponMeta[id] }))];
    let html = `<div class="pick-grid">`;
    for (const w of weapons) {
      const isSelected = (w.id === 'none' && (!current || current === 'none')) || w.id === current;
      html += `<div class="pick-card ${isSelected ? 'selected' : ''}" data-weapon="${w.id}">
        <div class="pick-icon">${w.icon}</div>
        <div class="pick-label">${w.label}</div>
      </div>`;
    }
    html += `</div>`;
    const currentDef = SkillLibrary[current];
    html += `<div class="pick-desc-box" id="weaponDescBox">${current === 'none' ? '无武器：塔不会攻击。' : (currentDef?.description || currentDef?.descTemplate || '')}</div>`;
    return html;
  },

  // 统一的"每类型可用技能"清单——实体编辑器与模板编辑器共用同一份，
  // 避免此前两处列表各写一份、又漏掉新增类型/新增技能的问题（Q3）。
  _SKILLS_BY_TYPE: {
    tower: {
      weapons: ['weapon_piercing', 'weapon_lightning', 'weapon_explosive', 'weapon_corrosion'],
      // 沙盒通用被动 + 对战实战塔被动。此前这里只有前 7 个沙盒被动，对战里塔真正装的那批
      // （加固城防/成长/过载/钢铁防线/镀层/烈阳护盾/水晶再生/基地光环）一个都没列 —— 这正是
      // 用户反馈"技能清单已经过时"的根因。现按 main.js 的实际装配逐条补齐。
      passives: [
        'passive_heavy_defense', 'passive_thorns', 'passive_frost_plating', 'passive_armor_plating',
        'passive_overheat', 'passive_vampire', 'passive_phase',
        'passive_overload', 'passive_iron_line',
        'passive_outer_fortify', 'passive_inner_fortify', 'passive_base_fortify', 'passive_hq_fortify',
        'passive_growth_outer', 'passive_growth_inner', 'passive_growth_base', 'passive_growth_hq',
        'passive_inner_bulwark', 'passive_base_bulwark',
        'passive_nexus_regen', 'passive_home_aura',
      ],
    },
    // 近战/远程此前是空列表，但它们默认就带屠戮被动（main.js defaultPassiveMap）—— 补上。
    melee:  { weapons: [], passives: ['passive_melee_rend'] },
    ranged: { weapons: [], passives: ['passive_ranged_rend'] },
    siege: { weapons: [], passives: ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend'] },
    super: { weapons: [], passives: ['passive_super_commander'] },
    totem: { weapons: [], passives: ['passive_totem_guardian', 'passive_totem_awaken', 'passive_totem_nourish', 'passive_totem_aura', 'passive_totem_sacrifice'] },
    warlock: { weapons: [], passives: ['passive_warlock_aura'] },
    corrupt: { weapons: [], passives: ['passive_corrupt_strike'] },
    ram:     { weapons: [], passives: ['passive_siege_weapon'] },
  },

  // 分层塔的技能清单：★ = main.js 里该层级的【默认装配】，其余为该层级可选。
  // 与 main.js createBuilding 的装配分支逐条对应，改那边就要同步这里。
  _SKILLS_BY_TIER: {
    outer:      ['passive_outer_fortify', 'passive_growth_outer', 'passive_iron_line', 'passive_overload',
                 'passive_armor_plating', 'passive_inner_bulwark', 'passive_thorns', 'passive_frost_plating'],
    inner:      ['passive_inner_fortify', 'passive_growth_inner', 'passive_inner_bulwark', 'passive_overload',
                 'passive_armor_plating', 'passive_iron_line', 'passive_thorns', 'passive_frost_plating'],
    base:       ['passive_base_fortify', 'passive_growth_base', 'passive_armor_plating', 'passive_overload',
                 'passive_base_bulwark', 'passive_iron_line', 'passive_heavy_defense', 'passive_thorns'],
    hq_tower:   ['passive_hq_fortify', 'passive_growth_hq', 'passive_overload',
                 'passive_armor_plating', 'passive_iron_line', 'passive_heavy_defense'],
    nexus_lane: ['passive_nexus_regen', 'passive_base_bulwark', 'passive_heavy_defense'],
    nexus_main: ['passive_nexus_regen', 'passive_home_aura', 'passive_heavy_defense'],
  },
  // main.js 中各层级的默认装配（用于在清单里标 ★ 默认）
  _TIER_DEFAULT_SKILLS: {
    outer:      ['passive_growth_outer', 'passive_outer_fortify', 'passive_iron_line', 'passive_overload'],
    inner:      ['passive_growth_inner', 'passive_inner_fortify', 'passive_inner_bulwark', 'passive_overload'],
    base:       ['passive_growth_base', 'passive_base_fortify', 'passive_armor_plating', 'passive_overload'],
    hq_tower:   ['passive_growth_hq', 'passive_hq_fortify', 'passive_overload'],
    nexus_lane: ['passive_nexus_regen'],
    nexus_main: ['passive_nexus_regen', 'passive_home_aura'],
  },

  _renderSkillContent(entity) {
    // 按单位类型区分被动列表：不同类型有各自专属的被动技能。
    const allPassives = this._SKILLS_BY_TYPE[entity.type]?.passives || [];
    const equipped = new Set(entity._skillInstances?.filter(s => allPassives.includes(s.skillId)).map(s => s.skillId) || []);

    if (allPassives.length === 0) {
      return `<div class="pick-desc-box">该单位类型没有可装备的被动技能。</div>`;
    }

    let html = `<div class="pick-grid">`;
    for (const key of allPassives) {
      const def = SkillLibrary[key];
      if (!def) continue;
      const isEquipped = equipped.has(key);
      html += `<div class="pick-card ${isEquipped ? 'selected' : ''}" data-skill="${key}">
        <div class="pick-icon">${def.icon || '🔹'}</div>
        <div class="pick-label">${def.name || key}</div>
      </div>`;
    }
    html += `</div>`;
    html += `<div class="pick-desc-box" id="skillDescBox">点击某个被动查看说明；再次点击可切换装备/卸载。</div>`;
    return html;
  },

  // ==================== Q3：运维操作（复活 / 击杀 / 改阵营 / 改层级）====================
  // 死亡的塔现在可被选中（网格已索引废墟），这一页让它可以被真正"运维"。
  // 每个操作都有连锁副作用，全部在 _applyOps 里显式处理，不留隐式状态。
  _renderOpsContent(entity) {
    const isTower = entity.type === 'tower';
    const dead = !entity.alive;
    const fac = entity._mapFaction || entity.faction || '（无阵营）';
    const facLabel = { blue: '🔵 蓝方', red: '🔴 红方' }[fac] || fac;
    const state = dead ? (entity._respawnAt ? '💤 等待重生' : (entity._ruin ? '🪦 废墟' : '☠️ 已死亡')) : '✅ 存活';

    let html = `<div style="padding:4px 0;">`;
    html += `<div class="pick-desc-box" style="margin-bottom:10px;">
      当前状态：<b>${state}</b>　｜　阵营：<b>${facLabel}</b>${isTower && entity._mapTier ? `　｜　层级：<b>${this._tierLabel(entity._mapTier)}</b>` : ''}
      <br><span style="color:var(--text-mute);font-size:11px;">编辑器操作不计入比分，日志里会标 [编辑器]。</span>
    </div>`;

    html += `<div class="slider-row"><label>存活状态</label>
      <div style="flex:1;display:flex;gap:6px;">
        <button class="editor-tab ${!dead ? 'active' : ''}" data-op="revive" ${!dead ? 'disabled' : ''}>❤️ 复活（满血）</button>
        <button class="editor-tab ${dead ? 'active' : ''}" data-op="kill" ${dead ? 'disabled' : ''}>💀 击杀</button>
      </div></div>`;

    html += `<div class="slider-row"><label>阵营</label>
      <div style="flex:1;display:flex;gap:6px;">
        <button class="editor-tab ${fac === 'blue' ? 'active' : ''}" data-op="fac" data-v="blue">🔵 蓝方</button>
        <button class="editor-tab ${fac === 'red' ? 'active' : ''}" data-op="fac" data-v="red">🔴 红方</button>
      </div></div>`;

    if (isTower) {
      html += `<div class="slider-row" style="align-items:flex-start;"><label style="padding-top:5px;">层级</label>
        <div style="flex:1;display:flex;gap:4px;flex-wrap:wrap;">
          ${this._TPL_TOWER_TIERS.map(t => `<button class="editor-tab ${t.key === entity._mapTier ? 'active' : ''}" data-op="tier" data-v="${t.key}" style="font-size:11px;">${t.icon} ${t.label}</button>`).join('')}
        </div></div>`;
      html += `<div style="font-size:11px;color:var(--text-mute);margin-top:8px;">
        改层级会按新层级重新解析属性与默认被动/武器（地图数值 → 分层覆写 → 阵营覆写）。
      </div>`;
    }

    html += `<div style="margin-top:12px;font-size:11px;color:var(--text-mute);line-height:1.7;">
      ⚠️ 这些操作会连锁影响：<br>
      · <b>结构保护</b>按"外层建筑是否存活"判定，复活/击杀会改变【其它塔】的可选中与免伤状态；<br>
      · 召唤水晶若在<b>重生队列</b>里，手动复活会把队列项一并撤掉，不会二次重生；<br>
      · 改阵营会清空当前目标（否则它会继续攻击原队友），并刷新模型颜色。
    </div>`;
    html += `</div>`;
    return html;
  },

  _bindOpsEvents(overlay, entity, logFn) {
    const app = window.CTX?.__app || window.__app;
    const ec = overlay._entityContainer || app?.entityContainer;
    const rerender = () => {
      overlay.querySelector('#editorContent').innerHTML = this._renderOpsContent(entity);
      this._bindOpsEvents(overlay, entity, logFn);
    };
    overlay.querySelectorAll('[data-op]').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => {
        const op = btn.dataset.op, v = btn.dataset.v;
        this._applyOps(entity, op, v, ec, app, logFn);
        rerender();
      });
    });
  },

  /**
   * 运维操作的唯一入口。所有连锁副作用都写在这里，避免"改了标记但别处没跟上"。
   * 刻意【不走 entity:death 事件】：那条链路会计分、会入重生队列、会触发超级兵，
   * 而编辑器操作是调试手段，不该污染对局状态（用户定稿：不计分，日志标 [编辑器]）。
   */
  _applyOps(e, op, v, ec, app, logFn) {
    const tag = '[编辑器]';
    const name = e.type === 'tower' ? `塔 #${e.id}` : `${CONFIG.templates[e.type]?.label || e.type} #${e.id}`;

    if (op === 'revive') {
      const maxHP = e.baseStats?.maxHP || 1;
      e.alive = true;
      e.currentHP = maxHP;
      e.shieldFixedCurrent = e.baseStats?.shieldFixedMax || 0;
      e.tempShield = 0;
      e.attackCooldown = 0;
      e.targetId = null;
      delete e._ruin;
      // 撤销重生：队列项 + _respawnAt 标记 + ⏳「重生中」状态**三样一起清**。
      // 这里原来是编辑器自己写的一小段，只清了前两样，于是复活之后那颗
      // ⏳ 状态还挂在水晶上、描述里的秒数继续往下走 —— 用户看到的
      // "设置为存活了，倒计时依旧存在"就是它。现在统一走 MapSystem.cancelNexusRespawn，
      // 那边还会顺带刷新"这一路是否算陷落"（一路可能有多座水晶）。
      const ms = app?.mapSystem;
      if (ms?.cancelNexusRespawn) ms.cancelNexusRespawn(e.id);
      else {
        const q = ms?._respawnQueue;
        if (q) for (let i = q.length - 1; i >= 0; i--) if (q[i].corpseId === e.id) q.splice(i, 1);
      }
      delete e._respawnAt; delete e._respawnProgress; delete e._respawnRemain;
      ec?.markDirty?.();
      logFn(`${tag} ❤️ ${name} 已复活（满血 ${maxHP}）`, 'spawn');

    } else if (op === 'kill') {
      e.alive = false;
      e.currentHP = 0;
      e.targetId = null;
      // 地图建筑死亡后保留为废墟（与 MapSystem 同口径），否则会被 purgeDead 直接清掉
      if (e._mapTier) e._ruin = true;
      ec?.markDirty?.();
      // 召唤水晶要进重生倒计时。刻意不走 entity:death 是为了不计分，
      // 但"不计分"不等于"不进入游戏状态"—— 原实现连重生一起跳过了，
      // 手动打掉的召唤水晶就永远躺在那儿，既不重生也不触发超级兵。
      let extra = '';
      if (e._mapTier === 'nexus_lane' && app?.mapSystem?.beginNexusRespawn) {
        if (app.mapSystem.beginNexusRespawn(e)) {
          const t = app.mapSystem.NEXUS_RESPAWN_TIME;
          const laneDown = app.mapSystem.isNexusDestroyed(e._mapFaction, e._laneId);
          extra = `，${t}s 后重生${laneDown ? '；本路召唤水晶已全灭' : '；本路还有存活的召唤水晶，尚不算陷落'}`;
        }
      }
      logFn(`${tag} 💀 ${name} 已击杀（不计入比分）${extra}`, 'death');

    } else if (op === 'fac') {
      if (v !== 'blue' && v !== 'red') return;
      e._mapFaction = v; e.faction = v;
      e.targetId = null;          // 不清目标它会继续打原来的队友
      if (e._ramLockId) e._ramLockId = null;
      logFn(`${tag} 🎌 ${name} 阵营 → ${v === 'blue' ? '蓝方' : '红方'}`, 'spawn');

    } else if (op === 'tier') {
      if (e.type !== 'tower') return;
      e._mapTier = v;
      // 按新层级重新解析数值：地图 tierStats → 分层覆写 → 阵营覆写（与 createBuilding 同序）
      const map = app?.mapSystem?.currentMap;
      const base = (map?.tierStats && map.tierStats[v]) || {};
      const shared = CONFIG.towerTierOverrides?.[v] || {};
      const facOvr = CONFIG.factionOverrides?.[e._mapFaction]?.['tower_' + v] || {};
      const merged = { ...base, ...shared, ...facOvr };
      const frac = e.baseStats?.maxHP > 0 ? e.currentHP / e.baseStats.maxHP : 1;
      Object.assign(e.baseStats, merged);
      if (e.baseStats.maxHP > 0) e.currentHP = Math.max(1, Math.round(e.baseStats.maxHP * frac));
      logFn(`${tag} 🏯 ${name} 层级 → ${this._tierLabel(v)}（属性已按新层级重解析）`, 'spawn');
    }
  },

  _renderEffectContent(entity) {
    const effs = window.__app?.effectRegistry?.getEffects(entity.id) || [];
    let html = `<div style="margin:8px 0;max-height:300px;overflow-y:auto;">`;
    if (effs.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">暂无状态效果</div>`;
    } else {
      for (const e of effs) {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:#0d1013;border-radius:4px;margin-bottom:4px;">
          <span style="font-size:18px;">${e.blueprint.icon || '🔹'}</span>
          <span style="flex:1;font-size:12px;">${e.blueprint.name}</span>
          <span style="font-size:10px;color:#8b949e;">${e.stacks > 1 ? `x${e.stacks}` : ''}</span>
          <span style="font-size:10px;color:#8b949e;">${e.remainingTime === Infinity ? '永久' : e.remainingTime.toFixed(1) + 's'}</span>
          <button class="remove-effect-btn" data-effect-id="${e.id}" style="background:#b33a3a;border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;">移除</button>
        </div>`;
      }
    }
    html += `</div>`;
    html += `<div style="margin-top:8px;">
      <button id="addEffectBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加状态</button>
      <div id="effectPickerBox" style="display:none;margin-top:8px;padding:12px;background:#0d1013;border-radius:4px;"></div>
    </div>`;
    return html;
  },

  // ==================== 龙魂（每塔独立） ====================
  _renderSoulContent(tower) {
    const app = window.__app;
    const DRAGON_ELEMENTS = app?.DRAGON_ELEMENTS || {};
    const SkillLibrary = app?.SkillLibrary || {};
    const effReg = app?.effectRegistry;

    // 已装备的龙魂（多个，来自 _skillInstances，不再是单一 _currentSoul）
    const equippedSouls = new Set((tower._skillInstances || []).filter(s => s.skillId.startsWith('dragonsoul_')).map(s => s.skillId));

    // ---- 已生效效果（穿梭框上方）：元素增益（有层数>0的）+ 已装备的所有龙魂 ----
    const activeChips = [];
    for (const [key, el] of Object.entries(DRAGON_ELEMENTS)) {
      const sampleEff = effReg ? effReg.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_0`) : null;
      if (sampleEff && sampleEff.stacks > 0) {
        activeChips.push({ kind: 'buff', key, icon: el.icon, label: `${el.label}之力（${sampleEff.stacks}层）` });
      }
    }
    for (const [key, el] of Object.entries(DRAGON_ELEMENTS)) {
      if (equippedSouls.has(el.soul)) {
        const def = SkillLibrary[el.soul];
        activeChips.push({ kind: 'soul', key, icon: def?.icon || '🐉', label: def?.name || el.soul });
      }
    }

    const activeHtml = activeChips.length
      ? activeChips.map(c => `<div class="transfer-chip" data-remove-kind="${c.kind}" data-remove-key="${c.key}">
          <span class="chip-icon">${c.icon}</span><span>${c.label}</span><span class="chip-remove">✕</span>
        </div>`).join('')
      : `<div class="transfer-active-empty">尚未生效任何巨龙增益或龙魂。点击下方池中的按钮即可生效。</div>`;

    // ---- 巨龙增益池（下方，全部8种，每次点击 +1 层，可无限叠加，非开关） ----
    const buffPoolHtml = Object.entries(DRAGON_ELEMENTS).map(([key, el]) => {
      const sampleEff = effReg ? effReg.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_0`) : null;
      const stacks = sampleEff ? sampleEff.stacks : 0;
      return `<div class="pick-card ${stacks > 0 ? 'has-stacks' : ''}" data-pool-kind="buff" data-pool-key="${key}">
        <div class="pick-icon">${el.icon}</div>
        <div class="pick-label">${el.label}之力${stacks > 0 ? `（${stacks}）` : ''}</div>
      </div>`;
    }).join('');

    // ---- 龙魂池（下方，全部8种，唯一开关：装备/卸下） ----
    const soulPoolHtml = Object.entries(DRAGON_ELEMENTS).map(([key, el]) => {
      const def = SkillLibrary[el.soul];
      const active = equippedSouls.has(el.soul);
      return `<div class="pick-card ${active ? 'selected' : ''}" data-pool-kind="soul" data-pool-key="${key}">
        <div class="pick-icon">${def?.icon || el.icon}</div>
        <div class="pick-label">${def?.name || el.label}</div>
      </div>`;
    }).join('');

    return `
      <div class="transfer-box">
        <div class="transfer-active-zone">
          <div class="transfer-active-title">✨ 已生效效果（点击 -1 层 / 卸下）</div>
          <div class="transfer-active-list">${activeHtml}</div>
        </div>
        <div class="transfer-pool-section">
          <div class="transfer-pool-title">🔥 巨龙增益池（点击 +1 层，可无限叠加）</div>
          <div class="pick-grid">${buffPoolHtml}</div>
        </div>
        <div class="transfer-pool-section">
          <div class="transfer-pool-title">🐉 龙魂池（唯一开关，可同时装备多个不同龙魂）</div>
          <div class="pick-grid">${soulPoolHtml}</div>
        </div>
        <div class="pick-desc-box" id="soulDescBox">点击某项查看说明。</div>
      </div>
    `;
  },

  _bindSoulEvents(overlay, tower, logFn) {
    const app = window.__app;
    const DRAGON_ELEMENTS = app?.DRAGON_ELEMENTS || {};
    const SkillLibrary = app?.SkillLibrary || {};
    const rerender = () => {
      overlay.querySelector('#editorContent').innerHTML = this._renderSoulContent(tower);
      this._bindSoulEvents(overlay, tower, logFn);
    };

    // 减少某元素增益 1 层（层数减到 0 时彻底移除该效果）
    const decrementBuff = (key, el) => {
      let stillHasLayers = false;
      for (let i = 0; i < el.buff.length; i++) {
        const eff = app.effectRegistry.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_${i}`);
        if (!eff) continue;
        if (eff.stacks > 1) { eff.stacks -= 1; app.effectRegistry._recalcEffectValues(eff); app.effectRegistry._updateDescription(eff); stillHasLayers = true; }
        else app.effectRegistry.remove(eff.id);
      }
      return stillHasLayers;
    };

    // 点击池中"巨龙增益"按钮：每次点击 +1 层（可无限叠加，不是开关）
    overlay.querySelectorAll('[data-pool-kind="buff"]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.poolKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        app.dragonSystem._applyElementBuffToTower(tower, key);
        logFn(`✨ 塔 #${tower.id} ${el.label}之力 +1 层`, 'spawn');
        rerender();
      });
      card.addEventListener('mouseenter', () => {
        const el = DRAGON_ELEMENTS[card.dataset.poolKey];
        const descBox = overlay.querySelector('#soulDescBox');
        if (descBox && el) descBox.textContent = `${el.label}之力：击杀获得的永久元素增益，点击可叠加层数（每层独立生效）。`;
      });
    });

    // 点击池中"龙魂"按钮：单层开关（装备/卸下），与增益池不同
    overlay.querySelectorAll('[data-pool-kind="soul"]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.poolKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        const equipped = app.dragonSystem._toggleSoul(tower, el.soul);
        logFn(`${equipped ? '✨' : '🚫'} 塔 #${tower.id} ${equipped ? '已装备' : '已卸下'}龙魂：${SkillLibrary[el.soul]?.name || el.soul}`, 'spawn');
        rerender();
      });
      card.addEventListener('mouseenter', () => {
        const el = DRAGON_ELEMENTS[card.dataset.poolKey];
        const def = el ? SkillLibrary[el.soul] : null;
        const descBox = overlay.querySelector('#soulDescBox');
        if (descBox) descBox.textContent = renderSkillDescription(def, entity, ctx) || def?.description || '';
      });
    });

    // 点击上方已生效 chip：增益 -1 层；龙魂直接卸下
    overlay.querySelectorAll('[data-remove-kind]').forEach(chip => {
      chip.addEventListener('click', () => {
        const kind = chip.dataset.removeKind;
        const key = chip.dataset.removeKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        if (kind === 'buff') {
          decrementBuff(key, el);
          logFn(`🔻 塔 #${tower.id} ${el.label}之力 -1 层`, 'spawn');
        } else if (kind === 'soul') {
          app.dragonSystem._toggleSoul(tower, el.soul);
          logFn(`🚫 塔 #${tower.id} 已卸下龙魂：${SkillLibrary[el.soul]?.name || el.soul}`, 'spawn');
        }
        rerender();
      });
    });
  },

  // ==================== 模板技能/状态渲染 ====================
  // 各类型的"硬编码默认被动"——与 main.js 里的 defaultPassiveMap 保持一致。
  // 模板技能面板首次打开时（tpl._templateSkills 尚未被显式设置过），
  // 需要用这份默认值回填勾选状态，否则界面显示"全部未装备"，
  // 点击应用后会把空配置写回 _templateSkills，导致以后生成的单位真的丢失默认被动（Q2 bug）。
  _DEFAULT_PASSIVE_MAP: {
    siege: ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend'],
    super: ['passive_super_commander'],
    totem: ['passive_totem_guardian', 'passive_totem_awaken', 'passive_totem_nourish', 'passive_totem_aura'],
    warlock: ['passive_warlock_aura'],
    corrupt: ['passive_corrupt_strike'],
    ram:     ['passive_siege_weapon'],
  },

  // 防御塔按【层级】取技能清单与默认装配（塔模板本身不再是一个整体）；
  // 小兵仍按类型。返回 { pool, equipped, defaults, title }。
  _skillSetFor(type, tier) {
    if (this._categoryOfType(type) === 'tower') {
      const pool = this._SKILLS_BY_TIER[tier] || [];
      const defaults = this._TIER_DEFAULT_SKILLS[tier] || [];
      CONFIG.towerTierSkills = CONFIG.towerTierSkills || {};
      // 首次打开：用 main.js 的实际默认装配回填，避免显示成"全部未装备"、
      // 一点应用就把默认被动清空（这是小兵那边曾经踩过的 Q2 坑）。
      if (!Array.isArray(CONFIG.towerTierSkills[tier])) CONFIG.towerTierSkills[tier] = [...defaults];
      return { pool, defaults, equipped: new Set(CONFIG.towerTierSkills[tier]), title: this._tierLabel(tier) };
    }
    const tpl = CONFIG.templates[type];
    const defaults = this._DEFAULT_PASSIVE_MAP[type] || [];
    if (tpl._templateSkills === undefined) tpl._templateSkills = [...defaults];
    return {
      pool: this._SKILLS_BY_TYPE[type]?.passives || [],
      defaults, equipped: new Set(tpl._templateSkills || []),
      title: tpl.label || this._labelOf(type),
    };
  },

  _renderTemplateSkillContent(type, tier) {
    const { pool, defaults, equipped, title } = this._skillSetFor(type, tier);
    const defSet = new Set(defaults);

    let html = `<p style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">新生成的 ${title} 将自动装备选中的被动技能（★ = 代码里的原始默认装配）</p>`;
    if (pool.length === 0) {
      html += `<div class="pick-desc-box">该类型没有可配置的被动技能。</div>`;
      return html;
    }
    html += `<div class="pick-grid">`;
    for (const key of pool) {
      const def = SkillLibrary[key];
      if (!def) continue;
      const isEquipped = equipped.has(key);
      html += `<div class="pick-card ${isEquipped ? 'selected' : ''}" data-skill="${key}">
        <div class="pick-icon">${def.icon || '🔹'}</div>
        <div class="pick-label">${defSet.has(key) ? '★ ' : ''}${def.name || key}</div>
      </div>`;
    }
    html += `</div>`;
    html += `<div class="pick-desc-box" id="tplSkillDescBox">点击某个被动查看说明；再次点击可切换是否默认装备。</div>`;
    return html;
  },

  // 状态效果的存放位置：塔按层级存 CONFIG.towerTierEffects[tier]，小兵按类型存 tpl._templateEffects。
  _effectListFor(type, tier) {
    if (this._categoryOfType(type) === 'tower') {
      CONFIG.towerTierEffects = CONFIG.towerTierEffects || {};
      CONFIG.towerTierEffects[tier] = CONFIG.towerTierEffects[tier] || [];
      return CONFIG.towerTierEffects[tier];
    }
    const tpl = CONFIG.templates[type];
    tpl._templateEffects = tpl._templateEffects || [];
    return tpl._templateEffects;
  },

  _renderTemplateEffectContent(type, tier) {
    const list = this._effectListFor(type, tier);
    const title = this._categoryOfType(type) === 'tower'
      ? this._tierLabel(tier) : (CONFIG.templates[type]?.label || this._labelOf(type));

    let html = `<p style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">新生成的 ${title} 入场时自动获得下列状态</p>`;
    html += `<div style="margin:8px 0;max-height:300px;overflow-y:auto;">`;
    if (list.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">暂无默认状态效果</div>`;
    } else {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:#0d1013;border-radius:4px;margin-bottom:4px;">
          <span style="font-size:18px;">${e.icon || '🔹'}</span>
          <span style="flex:1;font-size:12px;">${e.name || '未命名'}</span>
          <span style="font-size:10px;color:#8b949e;">${e.duration === Infinity ? '永久' : e.duration + 's'}</span>
          <button class="template-remove-effect" data-index="${i}" style="background:#b33a3a;border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;">移除</button>
        </div>`;
      }
    }
    html += `</div>`;
    html += `<div style="margin-top:8px;">
      <button id="templateAddEffectBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加默认状态</button>
      <div id="templateEffectPickerBox" style="display:none;margin-top:8px;padding:12px;background:#0d1013;border-radius:4px;"></div>
    </div>`;
    return html;
  },

  // ==================== 模板技能/状态事件绑定 ====================
  _bindTemplateSkillEvents(overlay, type, logFn) {
    overlay.querySelectorAll('.pick-card[data-skill]').forEach(el => {
      el.addEventListener('click', () => {
        el.classList.toggle('selected');
        const isEquipped = el.classList.contains('selected');
        const key = el.dataset.skill;
        const def = SkillLibrary[key];
        const descBox = overlay.querySelector('#tplSkillDescBox');
        if (descBox) descBox.textContent = `${isEquipped ? '✅ 默认装备' : '⭕ 不默认装备'} — ${def?.description || def?.descTemplate || ''}`;
      });
    });
  },

  _bindTemplateEffectEvents(overlay, type, logFn, tier) {
    const list = this._effectListFor(type, tier);
    const rerender = () => {
      const content = overlay.querySelector('#templateContent');
      content.innerHTML = this._renderTemplateEffectContent(type, tier);
      this._bindTemplateEffectEvents(overlay, type, logFn, tier);
    };

    overlay.querySelectorAll('.template-remove-effect').forEach(btn => {
      btn.addEventListener('click', () => {
        list.splice(parseInt(btn.dataset.index), 1);
        rerender();
      });
    });

    overlay.querySelector('#templateAddEffectBtn').addEventListener('click', () => {
      const box = overlay.querySelector('#templateEffectPickerBox');
      if (box.style.display === 'block') {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.innerHTML = this._renderEffectPicker();
      box.querySelector('.effect-type-select')?.addEventListener('change', (e) => {
        const type2 = e.target.value;
        box.querySelector('.effect-params').innerHTML = this._renderEffectParams(type2);
      });
      box.querySelector('#effectConfirmBtn').addEventListener('click', () => {
        list.push(this._buildEffectBlueprintFromPicker(box));
        logFn(`✅ 已添加默认状态到 ${this._categoryOfType(type) === 'tower' ? this._tierLabel(tier) : type} 模板`, 'spawn');
        box.style.display = 'none';
        rerender();
      });
    });
  },

  // 根据"添加状态"面板的选中类型，构建对应的效果 blueprint（stat/stun/dot 共用）
  /**
   * 手动添加的状态：造蓝图。
   *
   * ==================== v43 Q5：为什么每条都必须自带 stackKey ====================
   * 用户："同一种类的属性（比如攻击力等）无法叠加，①+20%攻击力 ②+5%攻击力，
   *        正常是 +25% 但是只生效 5%，第一个被覆盖了。"
   * 根因：EffectRegistry 的合并键是 `blueprint.stackKey || name::statKey`，
   * 而这里造出来的蓝图**名字恒为 '默认状态'**、stackPolicy 又是 'refresh'。
   * 于是两条都是 `默认状态::attackDamage` —— 第二条把第一条 refresh 掉了。
   * 单个实体手动加时还能靠 sourceId 分开，但"模板默认状态"那几条路径
   *（main.js 的 template_effect_tower/tier/<type>、编辑器的 template_effect_apply）
   * 用的是**同一个常量 sourceId**，于是必然互相顶掉。
   * 现在每条蓝图诞生时就领一个唯一 stackKey，天生互不相干；想要"同名互斥"的
   * 语义仍然可以手写 stackKey（技能层就是那么做的），这里只管手动添加的那类。
   */
  _newCustomStackKey() {
    AttributeEditor._customEffectSeq = (AttributeEditor._customEffectSeq || 0) + 1;
    return `custom_${Date.now().toString(36)}_${AttributeEditor._customEffectSeq}`;
  },
  _buildEffectBlueprintFromPicker(box) {
    const type2 = box.querySelector('.effect-type-select').value;
    const rawDur = box.querySelector('.effect-duration')?.value;
    const parsedDur = parseFloat(rawDur);
    const stackKey = this._newCustomStackKey();

    if (type2 === 'stun') {
      const duration = isNaN(parsedDur) ? 1 : parsedDur;
      return {
        name: '眩晕', icon: '💫', kind: 'stun', color: '#f1c40f', stackKey,
        duration: Math.max(0.1, duration), stackPolicy: 'refresh',
        description: '被眩晕，无法行动',
      };
    }
    if (type2 === 'dot') {
      const damageType = box.querySelector('.effect-dot-type')?.value || 'magic';
      const flatValue = parseFloat(box.querySelector('.effect-flat-value')?.value) || 10;
      const duration = isNaN(parsedDur) ? 5 : parsedDur;
      return {
        name: '持续伤害', icon: '🩸', kind: 'dot', damageType, stackKey,
        flatValue, tickInterval: 1, duration: Math.max(1, duration),
        stackable: false, stackPolicy: 'refresh',
        description: `每秒${flatValue}点${damageType === 'magic' ? '魔法' : damageType === 'physical' ? '物理' : '真实'}伤害`,
      };
    }
    // stat（默认）
    const statKey = box.querySelector('.effect-stat-key')?.value || 'attackDamage';
    const flatValue = parseFloat(box.querySelector('.effect-flat-value')?.value) || 0;
    const percentValue = parseFloat(box.querySelector('.effect-percent-value')?.value) || 0;
    const isPermanent = !isNaN(parsedDur) && parsedDur <= 0;
    const duration = isNaN(parsedDur) ? 5 : (isPermanent ? Infinity : parsedDur);
    return {
      name: '默认状态', icon: '📌', kind: 'stat', statKey, flatValue, percentValue, stackKey,
      duration, permanent: isPermanent, stackable: false, stackPolicy: 'refresh',
      description: `${statKey} ${flatValue !== 0 ? (flatValue > 0 ? '+' : '') + flatValue : ''}${percentValue !== 0 ? (percentValue > 0 ? '+' : '') + percentValue + '%' : ''}${isPermanent ? ' (永久)' : ''}`,
    };
  },

  _renderEffectPicker() {
    return `
      <div style="display:grid;gap:8px;">
        <div class="slider-row"><label>类型</label>
          <select class="effect-type-select" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
            <option value="stat">属性修正</option>
            <option value="stun">眩晕（控制）</option>
            <option value="dot">持续伤害（DOT）</option>
          </select>
        </div>
        <div class="effect-params">${this._renderEffectParams('stat')}</div>
        <button id="effectConfirmBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;">确认添加</button>
      </div>
    `;
  },

  _renderEffectParams(type) {
    // 与 CONFIG.templates 的实际字段 + AttributeCalculator 认得的条件字段对齐
    // （此前漏了 baseAttackSpeed / baseHealthRegenMod / 护盾三项 / 溅射 / 弹速 / 哀兵两项）。
    const statKeys = [
      'attackDamage', 'maxHP', 'healthRegen', 'baseHealthRegenMod', 'armor', 'magicResist',
      'moveSpeed', 'attackRange', 'baseAttackSpeed', 'bonusAttackSpeedPct', 'attackSpeedRatio',
      'damageAmpPct', 'damageReduction', 'damageBlock', 'lifeStealPct',
      'healShieldPowerPct', 'allStatsPct', 'damageConvertPct',
      'armorPenFlat', 'armorPenPercent', 'magicPenFlat', 'magicPenPercent',
      'onHitDamage', 'onHitPercentDamage',
      'shieldFixedMax', 'shieldRegenRate', 'tempShieldDecayPct',
      'splashRadius', 'bulletSpeed',
      'avengerVsMinionAmpPct', 'avengerVsMinionRedPct',
    ];
    if (type === 'stun') {
      return `
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.1" class="effect-duration" value="1" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
        <div style="font-size:11px;color:#8b949e;">眩晕期间目标停止一切行动（攻击/移动/技能）。</div>
      `;
    }
    if (type === 'dot') {
      return `
        <div class="slider-row"><label>伤害类型</label>
          <select class="effect-dot-type" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
            <option value="magic">魔法</option>
            <option value="physical">物理</option>
            <option value="true">真实</option>
          </select>
        </div>
        <div class="slider-row"><label>每次伤害</label>
          <input type="number" step="1" class="effect-flat-value" value="10" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.5" class="effect-duration" value="5" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
      `;
    }
    if (type === 'stat') {
      return `
        <div class="slider-row"><label>属性</label>
          <select class="effect-stat-key" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
            ${statKeys.map(k => `<option value="${k}">${k}</option>`).join('')}
          </select>
        </div>
        <div class="slider-row"><label>数值修正</label>
          <input type="number" step="0.5" class="effect-flat-value" value="0" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
        <div class="slider-row"><label>百分比修正</label>
          <input type="number" step="0.5" class="effect-percent-value" value="0" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
        <div class="slider-row"><label>持续时间(秒，≤0永久)</label>
          <input type="number" step="0.5" class="effect-duration" value="5" style="flex:1;background:#0d1013;border:1px solid #2d3540;color:#e6edf3;padding:2px 6px;border-radius:3px;">
        </div>
      `;
    }
    return '';
  },

  // ==================== 事件绑定 ====================
  _bindEditorEvents(overlay) {
    const entity = overlay._entity;
    const logFn = overlay._logFn;

    overlay.querySelectorAll('.editor-tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        overlay.querySelectorAll('.editor-tab[data-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
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
      const activeTab = overlay.querySelector('.editor-tab[data-tab].active');
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
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
        const key = el.dataset.weapon;
        const descBox = overlay.querySelector('#weaponDescBox');
        if (descBox) {
          const def = SkillLibrary['weapon_' + key];
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
    overlay.querySelectorAll('.remove-effect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.effectId);
        if (!isNaN(id) && window.__app?.effectRegistry) {
          window.__app.effectRegistry.remove(id);
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
      box.querySelector('.effect-type-select')?.addEventListener('change', (e) => {
        const type = e.target.value;
        box.querySelector('.effect-params').innerHTML = this._renderEffectParams(type);
      });
      box.querySelector('#effectConfirmBtn').addEventListener('click', () => {
        const effect = this._buildEffectBlueprintFromPicker(box);
        window.__app?.effectRegistry.apply(entity.id, effect, 'custom_' + Date.now());
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
    const selected = overlay.querySelector('.pick-card.selected[data-weapon]');
    if (!selected) return;
    const weaponId = selected.dataset.weapon;
    const oldInst = entity._skillInstances?.find(s => s.skillId.startsWith('weapon_'));
    if (oldInst) {
      const oldDef = SkillLibrary[oldInst.skillId];
      if (oldDef?.onUnequip) oldDef.onUnequip(entity.id, oldInst, {
        entityContainer: window.__app?.entityContainer,
        effectRegistry: window.__app?.effectRegistry,
      });
      entity._skillInstances = entity._skillInstances.filter(s => s !== oldInst);
    }
    if (weaponId !== 'none') {
      const newInst = { id: ++window._uid, skillId: weaponId, state: {} };
      entity._skillInstances.push(newInst);
      const newDef = SkillLibrary[weaponId];
      if (newDef?.onEquip) newDef.onEquip(entity.id, newInst, {
        entityContainer: window.__app?.entityContainer,
        effectRegistry: window.__app?.effectRegistry,
        eventBus: window.__app?.eventBus,
        waveNumber: window.waveNumber || 0,
        attrCalc: window.__app?.attrCalc,
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
        entityContainer: window.__app?.entityContainer,
        effectRegistry: window.__app?.effectRegistry,
      });
      entity._skillInstances = entity._skillInstances.filter(s => s !== inst);
    }
    for (const key of selectedSkills) {
      const inst = { id: ++window._uid, skillId: key, state: {} };
      entity._skillInstances.push(inst);
      const def = SkillLibrary[key];
      if (def?.onEquip) def.onEquip(entity.id, inst, {
        entityContainer: window.__app?.entityContainer,
        effectRegistry: window.__app?.effectRegistry,
        eventBus: window.__app?.eventBus,
        waveNumber: window.waveNumber || 0,
        attrCalc: window.__app?.attrCalc,
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
