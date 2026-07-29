import { CONFIG } from '../data/Config.js';
import { SkillLibrary, renderSkillDescription } from '../core/SkillLibrary.js';
import { buildWaveOrder, WHEN_OPTIONS } from '../data/waveComposition.js';

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
  openTemplateEditorRoot(logFn, returnCallback) {
    this._tplState = { category: this._TPL_CATEGORIES[0].key, type: 'tower', tier: 'outer' };
  // ============================================================
  //  SECTION 2: Template Editor ? defaults for new units
  // ============================================================

    this._renderTemplateEditor(logFn, returnCallback);
  },

  openTemplateEditor(type, logFn, returnCallback) {
    // 兼容旧调用（直接指定具体类型，如 'tower' 或某个小兵类型）
    const category = this._categoryOfType(type);
    this._tplState = { category, type, tier: this._tplState?.tier || 'outer' };
    this._renderTemplateEditor(logFn, returnCallback);
  },

  _categoryOfType(type) {
    if (type === 'tower') return 'tower';
    if (type === 'dragon') return 'dragon';
    return 'minion';
  },

  _TPL_LABELS: { tower: '防御塔', melee: '近战兵', ranged: '远程兵', siege: '炮兵', totem: '图腾兵', super: '超级兵', warlock: '术士兵', corrupt: '蚀骨兵', ram: '攻城车', dragon: '巨龙' },
 _TPL_ICONS: { melee: '🗡️', ranged: '🏹', siege: '💣', super: '🦾', totem: '🗿', warlock: '🧙', corrupt: '🦇', ram: '🛠️' },
  _TPL_MINION_TYPES: ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram'],
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
  _TPL_CATEGORIES: [
    { key: 'tower', label: '🏰 防御塔' },
    { key: 'minion', label: '⚔️ 小兵' },
    { key: 'dragon', label: '🐉 巨龙' },
  ],

  // ==================== 阵营作用域（对战模式：改一方不影响另一方） ====================
  // 数据模型：CONFIG.templates[type] 为共享基础；CONFIG.factionOverrides[faction][type]
  // 只存"与基础不同的字段"。作用域=共享时读写基础（旧行为）；作用域=蓝/红时读合并值、
  // 保存时把与基础不同的字段写入覆写层、与基础相同的字段自动从覆写层清除。
  // 仅"属性"tab 参与阵营覆写（技能/武器/状态等 tab 保持双方共享）。
  _factionScope: 'shared',

  // 分层塔的"当前有效数值"：地图 tierStats → 共享覆写 → 阵营覆写（与 createBuilding 同一叠加顺序）
  _tierBase(tier) {
    const map = window.CTX?.__app?.mapSystem?.currentMap;
    const fromMap = (map?.tierStats && map.tierStats[tier]) || {};
    const tplTower = CONFIG.templates.tower || {};
    // 地图只给了部分字段，其余落回塔模板，保证面板每项都有初值
    return { ...tplTower, ...fromMap };
  },
  _tierEffective(tier) {
    const shared = CONFIG.towerTierOverrides?.[tier] || {};
    const fac = this._factionScope !== 'shared'
      ? (CONFIG.factionOverrides?.[this._factionScope]?.['tower_' + tier] || {}) : {};
    return { ...this._tierBase(tier), ...shared, ...fac };
  },

  _scopedTpl(type) {
    const base = CONFIG.templates[type];
    if (this._factionScope === 'shared' || !base) return base;
    const ovr = CONFIG.factionOverrides?.[this._factionScope]?.[type] || {};
    return { ...base, ...ovr };
  },

  _scopeHint() {
    const A = { template: '仅写入模板（影响之后新生成的单位）',
                field: '仅改场上已有单位（不动模板，新生成的仍用旧值）',
                both: '模板 + 场上已有单位一起改' }[this._applyScope];
    const F = this._factionScope === 'shared' ? '双方'
            : (this._factionScope === 'blue' ? '仅🔵蓝方' : '仅🔴红方');
    return `应用范围：${A}　｜　阵营：${F}`;
  },
  _scopeHintLegacy() {
    if (this._factionScope === 'shared') return '修改将影响所有新生成的该类型单位（双方共享基础值）';
    const label = this._factionScope === 'blue' ? '🔵蓝方' : '🔴红方';
    return `当前编辑【仅${label}】：保存时与共享基础不同的字段写入该阵营覆写层，另一方完全不受影响`;
  },

  // 应用范围条：仅模板 / 仅场上目标 / 两者（用户定稿）
  _renderApplyScopeBar() {
    const a = this._applyScope;
    const btn = (k, txt) => `<button class="editor-tab ${a === k ? 'active' : ''}" data-applyscope="${k}">${txt}</button>`;
    return `<div class="editor-tabs" style="margin-top:6px;">
      ${btn('template', '📐 仅模板（影响新生成）')}${btn('field', '🎯 仅场上目标')}${btn('both', '🔗 模板 + 场上')}
    </div>`;
  },

  _renderFactionScopeBar() {
    const f = this._factionScope;
    const btn = (k, txt) => `<button class="editor-tab ${f === k ? 'active' : ''}" data-tplscope="${k}">${txt}</button>`;
    return `<div class="editor-tabs" style="margin-top:6px;">
      ${btn('shared', '⚖️ 共享（双方）')}${btn('blue', '🔵 仅蓝方')}${btn('red', '🔴 仅红方')}
      ${f !== 'shared' ? `<button class="editor-tab" data-tplscope-clear="1">🧹 清除该阵营覆写</button>` : ''}
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
    const type = category === 'minion' ? (st.type || 'melee') : category; // tower/dragon 类别本身就是类型

    const tpl = CONFIG.templates[type];
    const isTower = type === 'tower';
    const isDragon = type === 'dragon';
    const isMinion = !isTower && !isDragon;

    let detailHtml = '';
    if (tpl) {
      detailHtml = `
        <div class="editor-tabs">
          <button class="editor-tab active" data-tpltab="attr">属性</button>
          ${isTower ? `<button class="editor-tab" data-tpltab="weapon">武器</button>` : ''}
          <button class="editor-tab" data-tpltab="skill">被动技能</button>
          <button class="editor-tab" data-tpltab="effect">状态</button>
          ${isTower ? `<button class="editor-tab" data-tpltab="soul">🐉 龙魂</button>` : ''}
          ${isTower ? `<button class="editor-tab" data-tpltab="bsize">建筑体积</button>` : ''}
          ${isMinion ? `<button class="editor-tab" data-tpltab="spawnrule">生成规则</button>` : ''}
          ${isMinion ? `<button class="editor-tab" data-tpltab="waveorder">🧬 出兵顺序</button>` : ''}
        </div>
        ${isDragon ? '' : this._renderFactionScopeBar()}
        ${isDragon ? '' : this._renderApplyScopeBar()}
        <p style="color:#8b949e;font-size:11px;margin:8px 0;" id="tplScopeHint">${this._scopeHint()}</p>
        <div id="templateContent">${this._renderAttrContent(isTower ? this._tierEffective(st.tier) : this._scopedTpl(type), true)}</div>
      `;
    } else {
      detailHtml = `<div style="color:#8b949e;font-size:12px;padding:12px;">巨龙暂无可编辑的固定模板（属性由波次/元素动态计算）。</div>`;
    }

    overlay.innerHTML = `
      <div class="modal-box" style="max-width:640px;">
        <div class="editor-container">
          <h4>📐 模板编辑器</h4>
          <div class="editor-tabs">
            ${this._TPL_CATEGORIES.map(c => `<button class="editor-tab ${c.key === category ? 'active' : ''}" data-tplcat="${c.key}">${c.label}</button>`).join('')}
          </div>
          ${category === 'minion' ? `
            <div class="editor-tabs" style="margin-top:8px;">
              ${this._TPL_MINION_TYPES.map(t => `<button class="editor-tab ${t === type ? 'active' : ''}" data-tpltype="${t}">${this._TPL_ICONS[t]} ${this._TPL_LABELS[t]}</button>`).join('')}
            </div>
          ` : ''}
          ${category === 'tower' ? `
            <div class="editor-tabs" style="margin-top:8px;">
              ${this._TPL_TOWER_TIERS.map(t => `<button class="editor-tab ${t.key === st.tier ? 'active' : ''}" data-tpltier="${t.key}">${t.icon} ${t.label}</button>`).join('')}
            </div>
          ` : ''}
          <div style="margin-top:12px;">${detailHtml}</div>
          <div class="editor-actions" style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #2d3540;padding-top:12px;">
            ${tpl ? `<button id="templateApplyBtn" class="primary">应用</button>` : ''}
            <button id="templateCloseBtn">关闭</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 一级：大类切换
    overlay.querySelectorAll('[data-tplcat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.tplcat;
        // tier 必须带上：丢了它，防御塔页签下 st.tier 会变 undefined，
        // 属性/技能面板就会去查 _SKILLS_BY_TIER[undefined] 而整片空白。
        this._tplState = { category: key, type: key === 'minion' ? 'melee' : key, tier: this._tplState?.tier || 'outer' };
        this._renderTemplateEditor(logFn, returnCallback);
      });
    });
    // 二级：小兵具体类型切换
    overlay.querySelectorAll('[data-tpltype]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._tplState = { category: 'minion', type: btn.dataset.tpltype, tier: this._tplState?.tier || 'outer' };
        this._renderTemplateEditor(logFn, returnCallback);
      });
    });

    if (tpl) {
      this._bindTemplateDetailTabs(overlay, type, logFn, returnCallback);
      // 切换层级/阵营/应用范围、以及点"应用"后都会整体重渲染；
      // 这里把用户停留的那个 tab 重新点回来，免得每次操作都被弹回"属性"。
      const want = st.tab;
      if (want && want !== 'attr') {
        const btn = overlay.querySelector(`.editor-tab[data-tpltab="${want}"]`);
        if (btn) btn.click(); else st.tab = 'attr';
      }
    }

    const closeAndReturn = () => {
      overlay.remove();
      if (returnCallback) returnCallback();
    };
    document.getElementById('templateCloseBtn').addEventListener('click', closeAndReturn);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndReturn(); });
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

  _bindTemplateDetailTabs(overlay, type, logFn, returnCallback) {
    const tpl = CONFIG.templates[type];
    this._bindAttrEvents(overlay, tpl, logFn, true);

    overlay.querySelectorAll('.editor-tab[data-tpltab]').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.editor-tab[data-tpltab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tpltab;
        this._tplState.tab = tabName;
        const content = overlay.querySelector('#templateContent');
        if (tabName === 'weapon') {
          content.innerHTML = this._renderTemplateWeaponContent(type, this._tplState.tier);
          this._bindTemplateWeaponEvents(overlay, type, logFn);
        } else if (tabName === 'skill') {
          content.innerHTML = this._renderTemplateSkillContent(type, this._tplState.tier);
          this._bindTemplateSkillEvents(overlay, type, logFn);
        } else if (tabName === 'effect') {
          content.innerHTML = this._renderTemplateEffectContent(type, this._tplState.tier);
          this._bindTemplateEffectEvents(overlay, type, logFn, this._tplState.tier);
        } else if (tabName === 'soul') {
          content.innerHTML = this._renderTemplateSoulContent(type);
          this._bindTemplateSoulEvents(overlay, type, logFn);
        } else if (tabName === 'spawnrule') {
          content.innerHTML = this._renderSpawnRuleContent(type);
          this._bindSpawnRuleEvents(overlay, type, logFn);
        } else if (tabName === 'waveorder') {
          content.innerHTML = this._renderWaveOrderContent();
          this._bindWaveOrderEvents(overlay, logFn);
        } else if (tabName === 'bsize') {
          content.innerHTML = this._renderBuildingSizeContent();
        } else {
          content.innerHTML = this._renderAttrContent(this._scopedTpl(type), true);
          this._bindAttrEvents(overlay, this._scopedTpl(type), logFn, true);
        }
      });
    });

    overlay.querySelectorAll('[data-tplscope]').forEach(b => b.addEventListener('click', () => {
      this._factionScope = b.dataset.tplscope;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    overlay.querySelectorAll('[data-applyscope]').forEach(b => b.addEventListener('click', () => {
      this._applyScope = b.dataset.applyscope;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    overlay.querySelectorAll('[data-tpltier]').forEach(b => b.addEventListener('click', () => {
      this._tplState.tier = b.dataset.tpltier;
      this._renderTemplateEditor(logFn, returnCallback);
    }));
    const clearBtn = overlay.querySelector('[data-tplscope-clear]');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      // 塔的阵营覆写按层级存成 'tower_<tier>'，小兵/其它按类型存。
      // （旧代码这里引用了 _renderTemplateEditor 的局部变量 category/st，
      //   在本函数作用域里根本不存在 —— 点"清除覆写"必抛 ReferenceError。）
      const t = this._categoryOfType(type) === 'tower' ? 'tower_' + (this._tplState?.tier || 'outer') : type;
      if (CONFIG.factionOverrides?.[this._factionScope]) delete CONFIG.factionOverrides[this._factionScope][t];
      logFn(`🧹 已清除 ${this._factionScope === 'blue' ? '蓝方' : '红方'} 对 ${t} 的覆写`, 'spawn');
      this._renderTemplateEditor(logFn, returnCallback);
    });

    const applyBtn = overlay.querySelector('#templateApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      const activeTab = overlay.querySelector('.editor-tab[data-tpltab].active');
      const tabName = activeTab ? activeTab.dataset.tpltab : 'attr';
      if (tabName === 'weapon') this._applyTemplateWeaponChanges(overlay, type, logFn);
      else if (tabName === 'skill') this._applyTemplateSkillChanges(overlay, type, logFn);
      else if (tabName === 'effect') this._applyTemplateEffectChanges(overlay, type, logFn);
      else if (tabName === 'soul') logFn('🐉 龙魂默认配置点击即时生效，无需点应用', 'spawn');
      else if (tabName === 'spawnrule') this._applySpawnRuleChanges(overlay, type, logFn);
      else if (tabName === 'waveorder') this._applyWaveOrderChanges(overlay, logFn);
      else if (tabName === 'bsize') this._applyBuildingSizeChanges(overlay, logFn);
      else this._applyTemplateAttrChanges(overlay, type, logFn);
      // 应用后【不再关闭】编辑器：调参是连续动作（改一项→看效果→再改一项），
      // 每次应用都弹回上级菜单正是"编辑器难用"的主因之一。改为原地刷新当前 tab，
      // 让面板显示回写后的真实值；关闭仍走"关闭"按钮/点遮罩。
      this._tplState.tab = tabName;
      this._renderTemplateEditor(logFn, returnCallback);
    });
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
      sniper: { label: '狙击型', icon: '🎯' }, corrosion: { label: '腐蚀型', icon: '🌿' },
    };
    const who = isTower ? this._tierLabel(tier) : (this._TPL_LABELS[type] || type);
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
        tplMsg = `模板：${this._TPL_LABELS[type] || type} → ${key}`;
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
      : `<div class="transfer-active-empty">新生成的${this._TPL_LABELS[type]}默认不装备任何龙魂。点击下方池中的按钮即可默认装备。</div>`;

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
        <p style="color:var(--text-dim);font-size:11px;">新生成的${this._TPL_LABELS[type]}将默认装备下方"已生效"框内的龙魂（可多选，不受击杀解锁限制，用于快速配置）</p>
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
        logFn(`🚫 ${this._TPL_LABELS[type]}默认龙魂已移除：${SkillLibrary[soulId]?.name || soulId}`, 'spawn');
      } else {
        tpl._templateSouls.push(soulId);
        logFn(`✅ ${this._TPL_LABELS[type]}默认龙魂已添加：${SkillLibrary[soulId]?.name || soulId}`, 'spawn');
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

  _renderSpawnRuleContent(type) {
    const meta = this._spawnRuleMeta(type);
    const gr = CONFIG.gameRules;
    let html = `<div style="padding:4px 0;">`;
    html += `<div class="pick-desc-box" style="margin-bottom:10px;">ℹ️ 数量/间隔类字段影响【沙盒模式】波次；标注"对战模式"的字段影响对战出兵（v33：图腾兵已接入对战）。兵种开关对两种模式都生效。</div>`;
    // v33（Q4）：是否生成该兵种（沙盒+对战通用总开关）
    const enabled = (gr.spawnEnabled || {})[type] !== false;
    html += `<div class="slider-row"><label>是否生成该兵种</label>
      <button class="editor-tab ${enabled ? 'active' : ''}" data-spawn-toggle="${type}" style="flex:1;font-size:12px;">
        ${enabled ? '✅ 生成中（点击停用）' : '⛔ 已停用（点击启用）'}
      </button>
    </div>`;
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
    // v33（Q4）：对战模式专属字段（当前仅图腾兵）
    if (meta.battleFromKey) {
      html += `<div class="slider-row"><label>${meta.battleFromLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.battleFromKey}" min="1" step="1" value="${gr[meta.battleFromKey] ?? meta.battleFromDefault}" style="width:90px;">
      </div>`;
      html += `<div class="slider-row"><label>${meta.battleIntvLabel}</label>
        <input type="number" class="spawnrule-input" data-key="${meta.battleIntvKey}" min="1" step="1" value="${gr[meta.battleIntvKey] ?? meta.battleIntvDefault}" style="width:90px;">
      </div>`;
    }
    if (!meta.countKey && !meta.intervalKey) {
      html += `<div style="color:#8b949e;font-size:12px;">该类型暂无可编辑的生成规则。</div>`;
    }
    // ==================== Q2：对战成长 + 屠戮（软编码，可按兵种改）====================
    // 这两组数值原先硬编码在 main.js / 技能文件里，改平衡要翻源码。现在住在 CONFIG，
    // 面板改完立刻对【之后生成】的小兵生效（已出场的沿用出生时的成长快照）。
    const G = CONFIG.battleGrowth?.[type];
    if (G) {
      html += `<div style="margin-top:14px;border-top:1px solid #2d3540;padding-top:10px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">📈 对战成长（每波固定增量）</div>
        <div class="slider-row"><label>最大生命 /波</label>
          <input type="number" class="growth-input" data-gkey="hp" step="0.1" value="${G.hp}" style="width:90px;"></div>
        <div class="slider-row"><label>攻击力 /波</label>
          <input type="number" class="growth-input" data-gkey="ad" step="0.05" value="${G.ad}" style="width:90px;"></div>
        <div class="slider-row"><label>双抗 /波</label>
          <input type="number" class="growth-input" data-gkey="res" step="0.05" value="${G.res}" style="width:90px;"></div>
      </div>`;
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
    html += `<div style="margin-top:10px;font-size:11px;color:var(--text-mute);">修改后立即影响后续波次的生成节奏。</div>`;
    html += `</div>`;
    return html;
  },

  _bindSpawnRuleEvents(overlay, type, logFn) {
    // v33（Q4）：兵种总开关即点即生效
    overlay.querySelectorAll('[data-spawn-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.spawnToggle;
        CONFIG.gameRules.spawnEnabled = CONFIG.gameRules.spawnEnabled || {};
        const now = CONFIG.gameRules.spawnEnabled[t] !== false;
        CONFIG.gameRules.spawnEnabled[t] = !now;
        btn.classList.toggle('active', !now);
        btn.textContent = !now ? '✅ 生成中（点击停用）' : '⛔ 已停用（点击启用）';
        logFn(`⚙️ 「${t}」生成开关：${!now ? '开' : '关'}（沙盒+对战通用）`, 'spawn');
      });
    });
  },

  // ==================== 出兵顺序（对战模式，全局；用户："再加'出兵顺序'自定义"）====================
  // 数据就是 CONFIG.gameRules.laneWaveComposition —— 数组顺序即出兵先后。
  // 面板直接编排这个数组：上下移动 / 增删条目 / 改兵种·数量·起始波次·周期·触发条件，
  // 再配一个"第 N 波会出什么"的实时预览（预览与真实出兵共用 buildWaveOrder，不会骗人）。
  _waveOrderPreviewWave: 1,
  _waveOrderPreviewNexusDown: false,

  _renderWaveOrderContent() {
    const gr = CONFIG.gameRules;
    gr.laneWaveComposition = gr.laneWaveComposition || [];
    const list = gr.laneWaveComposition;
    const types = this._TPL_MINION_TYPES;
    const EN = gr.spawnEnabled || {};

    const cell = (rule, i, key, min, step) =>
      `<input type="number" class="wo-field" data-idx="${i}" data-field="${key}" min="${min}" step="${step}"
              value="${rule[key] ?? ''}" placeholder="${key === 'count' ? 1 : (key === 'everyN' ? 1 : 0)}"
              style="width:62px;">`;

    let html = `<div class="pick-desc-box" style="margin-bottom:10px;">
      🧬 <b>数组顺序 = 出兵先后</b>。每条规则命中当前波次时，就按"数量"往队列里追加该兵种。<br>
      「起始波次」之前不出；之后每「每几波」出一次。「条件」用于超级兵（水晶陷落）与炮兵（水晶未陷落）。<br>
      被「生成规则 → 是否生成该兵种」关掉的兵种，无论这里怎么排都不会出（下表会标灰）。
    </div>`;

    html += `<div style="display:flex;gap:6px;font-size:10px;color:#8b949e;padding:0 4px 4px;">
      <span style="width:52px;">顺序</span><span style="width:96px;">兵种</span>
      <span style="width:62px;">数量</span><span style="width:62px;">起始波</span>
      <span style="width:62px;">每几波</span><span style="flex:1;">条件</span><span style="width:28px;"></span>
    </div>`;

    if (list.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">编排为空 —— 当前对战不会生成任何小兵。</div>`;
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const off = EN[r.type] === false;
      html += `<div class="slider-row" style="gap:6px;align-items:center;opacity:${off ? 0.45 : 1};">
        <span style="width:52px;display:flex;gap:2px;">
          <button class="wo-move" data-idx="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} style="width:24px;">▲</button>
          <button class="wo-move" data-idx="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} style="width:24px;">▼</button>
        </span>
        <select class="wo-field" data-idx="${i}" data-field="type" style="width:96px;">
          ${types.map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${this._TPL_ICONS[t] || ''} ${this._TPL_LABELS[t] || t}</option>`).join('')}
        </select>
        ${cell(r, i, 'count', 0, 1)}${cell(r, i, 'fromWave', 0, 1)}${cell(r, i, 'everyN', 1, 1)}
        <select class="wo-field" data-idx="${i}" data-field="when" style="flex:1;">
          ${WHEN_OPTIONS.map(o => `<option value="${o.value}" ${(r.when || '') === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <button class="wo-del" data-idx="${i}" style="width:28px;background:#b33a3a;border:none;color:#fff;border-radius:4px;cursor:pointer;">✕</button>
      </div>`;
    }

    html += `<div style="margin-top:8px;"><button id="woAddBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加一条</button>
      <button id="woResetBtn" style="margin-left:6px;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">↺ 恢复默认编排</button></div>`;

    // ---- 实时预览 ----
    const w = this._waveOrderPreviewWave, nd = this._waveOrderPreviewNexusDown;
    const order = buildWaveOrder(w, nd, gr);
    html += `<div style="margin-top:14px;border-top:1px solid #2d3540;padding-top:10px;">
      <div class="slider-row" style="gap:8px;">
        <label style="width:auto;">预览第</label>
        <input type="number" id="woPreviewWave" min="0" step="1" value="${w}" style="width:70px;">
        <label style="width:auto;">波</label>
        <button id="woPreviewNexus" class="editor-tab ${nd ? 'active' : ''}" style="flex:1;font-size:11px;">
          ${nd ? '💥 本路水晶已陷落' : '🔮 本路水晶完好'}
        </button>
      </div>
      <div class="pick-desc-box" style="margin-top:6px;">
        共 <b>${order.length}</b> 个单位：${order.length
          ? order.map(t => `${this._TPL_ICONS[t] || ''}${this._TPL_LABELS[t] || t}`).join(' → ')
          : '（本波无兵）'}
      </div>
    </div>`;
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-mute);">改完点【应用】写入；下一波起生效。</div>`;
    return html;
  },

  _bindWaveOrderEvents(overlay, logFn) {
    const gr = CONFIG.gameRules;
    const rerender = () => {
      const content = overlay.querySelector('#templateContent');
      content.innerHTML = this._renderWaveOrderContent();
      this._bindWaveOrderEvents(overlay, logFn);
    };
    // 结构性操作（上下移/删/加/恢复默认）即点即改数组并重绘；
    // 重绘前先把当前所有输入框的值收回数组，否则移动一行会把没点应用的编辑丢掉。
    const flush = () => this._readWaveOrderInputs(overlay);

    overlay.querySelectorAll('.wo-move').forEach(b => b.addEventListener('click', () => {
      flush();
      const i = +b.dataset.idx, d = +b.dataset.dir, j = i + d;
      if (j < 0 || j >= gr.laneWaveComposition.length) return;
      const a = gr.laneWaveComposition;
      [a[i], a[j]] = [a[j], a[i]];
      rerender();
    }));
    overlay.querySelectorAll('.wo-del').forEach(b => b.addEventListener('click', () => {
      flush();
      gr.laneWaveComposition.splice(+b.dataset.idx, 1);
      rerender();
    }));
    overlay.querySelector('#woAddBtn')?.addEventListener('click', () => {
      flush();
      gr.laneWaveComposition.push({ type: 'melee', count: 1 });
      rerender();
    });
    overlay.querySelector('#woResetBtn')?.addEventListener('click', () => {
      gr.laneWaveComposition = this._DEFAULT_WAVE_COMPOSITION.map(r => ({ ...r }));
      logFn('↺ 出兵编排已恢复默认', 'spawn');
      rerender();
    });
    // 字段改动即时反映到预览
    overlay.querySelectorAll('.wo-field').forEach(el => el.addEventListener('change', () => { flush(); rerender(); }));

    overlay.querySelector('#woPreviewWave')?.addEventListener('change', (e) => {
      this._waveOrderPreviewWave = Math.max(0, parseInt(e.target.value, 10) || 0);
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
    const list = CONFIG.gameRules.laneWaveComposition || [];
    overlay.querySelectorAll('.wo-field').forEach(el => {
      const r = list[+el.dataset.idx];
      if (!r) return;
      const f = el.dataset.field;
      if (f === 'type') { r.type = el.value; return; }
      if (f === 'when') { if (el.value) r.when = el.value; else delete r.when; return; }
      const raw = el.value.trim();
      if (raw === '') { delete r[f]; return; }
      const v = parseInt(raw, 10);
      if (!isNaN(v)) r[f] = Math.max(f === 'everyN' ? 1 : 0, v);
    });
    return list;
  },

  _applyWaveOrderChanges(overlay, logFn) {
    const list = this._readWaveOrderInputs(overlay);
    const w = this._waveOrderPreviewWave;
    const n = buildWaveOrder(w, this._waveOrderPreviewNexusDown).length;
    logFn(`✅ 出兵编排已应用（${list.length} 条规则；第 ${w} 波将出 ${n} 个单位）`, 'spawn');
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
    logFn(`✅ 「${type}」生成规则/成长/屠戮已更新（${changed}项）`, 'spawn');
  },

  // ==================== 渲染方法 ====================
  // ============================================================
  //  SECTION 1: Live Entity Editor ? attributes, weapons, passives, effects
  // ============================================================

  _renderAttrContent(target, isTemplate = false) {
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
            <label title="${key}">${label}</label>
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

  _renderWeaponContent(entity) {
    const current = entity._skillInstances?.find(s => s.skillId.startsWith('weapon_'))?.skillId || 'weapon_piercing'; // v33
    const weaponMeta = {
      weapon_piercing: { label: '穿透型', icon: '🔷' },
      weapon_lightning: { label: '闪电杖', icon: '⚡' },
      weapon_explosive: { label: '爆炸型', icon: '💥' },
      weapon_sniper: { label: '狙击型', icon: '🎯' },
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
      weapons: ['weapon_piercing', 'weapon_lightning', 'weapon_explosive', 'weapon_sniper', 'weapon_corrosion'],
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
      // 重生队列里若还挂着这具尸体，撤掉——否则时间一到会再"重生"一次（凭空多一座）
      // 无条件清扫队列：不能用 e._respawnAt 当守卫 —— 尸体上没有这个标记、
      // 而队列里仍挂着条目的情形是存在的（标记被别处清过），那样就会漏撤、时间一到凭空多一座。
      const q = app?.mapSystem?._respawnQueue;
      if (q) for (let i = q.length - 1; i >= 0; i--) if (q[i].corpseId === e.id) q.splice(i, 1);
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
      logFn(`${tag} 💀 ${name} 已击杀（不计入比分）`, 'death');

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
      title: tpl.label || this._TPL_LABELS[type] || type,
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
      ? this._tierLabel(tier) : (CONFIG.templates[type]?.label || this._TPL_LABELS[type] || type);

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
  _buildEffectBlueprintFromPicker(box) {
    const type2 = box.querySelector('.effect-type-select').value;
    const rawDur = box.querySelector('.effect-duration')?.value;
    const parsedDur = parseFloat(rawDur);

    if (type2 === 'stun') {
      const duration = isNaN(parsedDur) ? 1 : parsedDur;
      return {
        name: '眩晕', icon: '💫', kind: 'stun', color: '#f1c40f',
        duration: Math.max(0.1, duration), stackPolicy: 'refresh',
        description: '被眩晕，无法行动',
      };
    }
    if (type2 === 'dot') {
      const damageType = box.querySelector('.effect-dot-type')?.value || 'magic';
      const flatValue = parseFloat(box.querySelector('.effect-flat-value')?.value) || 10;
      const duration = isNaN(parsedDur) ? 5 : parsedDur;
      return {
        name: '持续伤害', icon: '🩸', kind: 'dot', damageType,
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
      name: '默认状态', icon: '📌', kind: 'stat', statKey, flatValue, percentValue,
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
