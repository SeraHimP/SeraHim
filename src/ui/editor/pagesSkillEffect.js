/**
 * pagesSkillEffect.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 模板页：被动技能组 / 初始状态组的渲染、绑定与状态蓝图选择器
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary } from '../../core/SkillLibrary.js';
import { DEFAULT_MINION_PASSIVES } from '../../core/defaultMinionPassives.js';
import { fieldLabel } from './fields.js';

export const EDITOR_PAGES_SKILLEFFECT = {
  // ==================== 模板技能/状态渲染 ====================
  // 各类型的"硬编码默认被动"——与 factories.js 里 createMinion 消费的那份
  // 是**同一份**（v51.5 之前这里手抄了一份副本，早就漂移过：v51 系列加的
  // 四条主动技能、图腾兵重做后的新三件套都只进了 factories.js 那份，这里
  // 从未跟上，导致模板编辑器首次打开时回填的"默认装配"是过时数据）。
  // 模板技能面板首次打开时（tpl._templateSkills 尚未被显式设置过），
  // 需要用这份默认值回填勾选状态，否则界面显示"全部未装备"，
  // 点击应用后会把空配置写回 _templateSkills，导致以后生成的单位真的丢失默认被动（Q2 bug）。
  _DEFAULT_PASSIVE_MAP: DEFAULT_MINION_PASSIVES,

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
    // v51.26 修复：与出兵编排页（pagesWave.js）同一次排查发现的同型 bug——这里原来
    // 只读全局 _DEFAULT_PASSIVE_MAP（= DEFAULT_MINION_PASSIVES），从没合并
    // mapSystem.currentMap?.minionDefaultPassives。真正装配技能的 factories.js
    // createMinion 是 `{...DEFAULT_MINION_PASSIVES, ...mapMinionPassives}` 合并、
    // 地图覆写优先，经典模式把这张表整个清空了（"所有小兵无技能"），这里却仍然把
    // 全局默认技能标成★"游戏实际默认"——是本仓库 v51.5 修过一次的"编辑器默认表
    // 与真正消费的清单各存一份、会漂移"那次的同型复发，上次统一的是数值本身，
    // 这次漏掉的是"地图覆写"这一层合并，一并补上。
    const app = window.CTX?.__app || window.__app;
    const mapPassives = app?.mapSystem?.currentMap?.minionDefaultPassives || {};
    const defaults = mapPassives[type] || this._DEFAULT_PASSIVE_MAP[type] || [];
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
      this._bindEffectPicker(box);
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
    // v43 P1-4：拆分前这里写的是 `AttributeEditor._customEffectSeq`（同文件里的模块级引用）。
    // 拆出来之后本文件已经看不到那个名字了，改成 `this.` —— 计数器仍然落在合并后的
    // 那**同一个对象**上，唯一的差别是不再需要反向 import 整个 AttributeEditor（那会成环）。
    // 全部调用点都是 `X._newCustomStackKey()` 形式（this 就是 AttributeEditor），行为一致。
    this._customEffectSeq = (this._customEffectSeq || 0) + 1;
    return `custom_${Date.now().toString(36)}_${this._customEffectSeq}`;
  },
  _buildEffectBlueprintFromPicker(box) {
    const type2 = box.querySelector('[data-efftype].active')?.dataset.efftype || 'stat';
    const permanentChecked = box.querySelector('.effect-permanent')?.checked || false;
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
    if (type2 === 'silence') {
      const duration = isNaN(parsedDur) ? 1 : parsedDur;
      return {
        name: '沉默', icon: '🔇', kind: 'silence', color: '#9b59b6', stackKey,
        duration: Math.max(0.1, duration), stackPolicy: 'refresh',
        description: '被沉默，无法施放技能',
      };
    }
    if (type2 === 'disarm') {
      const duration = isNaN(parsedDur) ? 1 : parsedDur;
      return {
        name: '缴械', icon: '🚫', kind: 'disarm', color: '#e67e22', stackKey,
        duration: Math.max(0.1, duration), stackPolicy: 'refresh',
        description: '被缴械，无法进行普通攻击',
      };
    }
    if (type2 === 'dot') {
      const damageType = box.querySelector('.effect-dot-type')?.value || 'magic';
      const flatValue = parseFloat(box.querySelector('.effect-flat-value')?.value) || 10;
      // v51.12：持续伤害现在也带"永久"勾选框（之前没有——旧版持续伤害只能靠填一个很
      // 大的秒数模拟"永久"，和护盾/属性两种状态的永久勾选框不对称）。
      const isPermanent = permanentChecked || (!isNaN(parsedDur) && parsedDur <= 0);
      const duration = isPermanent ? Infinity : (isNaN(parsedDur) ? 5 : parsedDur);
      return {
        name: '持续伤害', icon: '🩸', kind: 'dot', damageType, stackKey,
        flatValue, tickInterval: 1, duration: Math.max(1, duration), permanent: isPermanent,
        stackable: false, stackPolicy: 'refresh',
        description: `每秒${flatValue}点${damageType === 'magic' ? '魔法' : damageType === 'physical' ? '物理' : '真实'}伤害`,
      };
    }
    // stat（默认）
    const statKey = box.querySelector('.effect-stat-key')?.value || 'attackDamage';
    const flatValue = parseFloat(box.querySelector('.effect-flat-value')?.value) || 0;
    const percentValue = parseFloat(box.querySelector('.effect-percent-value')?.value) || 0;
    // v51.6：永久现在有一个显式的"永久"勾选框（用户："加状态的UI……要求有现代化的
    // UI并且功能易用"，≤0=永久这条隐性约定不好发现）；勾选框和"填≤0"两条路都认，
    // 后者是兼容旧习惯，不是必须记住的隐藏规则。
    const isPermanent = permanentChecked || (!isNaN(parsedDur) && parsedDur <= 0);
    const duration = isPermanent ? Infinity : (isNaN(parsedDur) ? 5 : parsedDur);
    // v51.12："护盾"从独立 tab 移进了"属性修正"的卡片网格，选中哨兵键 __shield__
    // 时这里的"数值修正"输入框实际填的是护盾值，产出的效果类型也要是 kind:'shield'
    // 而不是 kind:'stat'（护盾走 EffectRegistry 的 shieldRemaining 独立记账，不能
    // 当成普通属性修正处理）。
    if (statKey === '__shield__') {
      return {
        name: '护盾', icon: '🛡️', kind: 'shield', stackKey,
        flatValue, duration, permanent: isPermanent, stackable: false, stackPolicy: 'refresh',
        description: `护盾+${flatValue}`,
      };
    }
    return {
      name: '默认状态', icon: '📌', kind: 'stat', statKey, flatValue, percentValue, stackKey,
      duration, permanent: isPermanent, stackable: false, stackPolicy: 'refresh',
      description: `${fieldLabel(statKey)} ${flatValue !== 0 ? (flatValue > 0 ? '+' : '') + flatValue : ''}${percentValue !== 0 ? (percentValue > 0 ? '+' : '') + percentValue + '%' : ''}${isPermanent ? ' (永久)' : ''}`,
    };
  },

  // ==================== v51.6：加状态面板重做（现代化 UI）====================
  // 用户："加状态的UI你根本没有重做……图片是老版本的，这种根本不好用。我要求有现代
  //        化的UI并且功能易用。"这个面板被三处共用（单位编辑器手动加状态、模板编辑器
  //        批量加状态、模板编辑器"小兵/塔→状态"tab 的默认状态），改一次三处一起好。
  // 三点改动：
  //   ① 类型从原生 <select> 换成三个胶囊 tab（.editor-tab，与编辑器别处的 tab 同款），
  //      只有 3 个选项，点一下比展开下拉框更直接。
  //   ② "属性"从一个列出 28 个原始字段名（attackDamage/baseHealthRegenMod……）、没有
  //      中文、不能搜索的 <select> 换成可搜索的卡片网格（.pick-grid/.pick-card，与
  //      武器/被动技能选择器同一套组件），标签换成 fieldLabel() 的中文名。
  //   ③ 所有输入框统一用 .editor-number（原来是手写的内联深色样式，和面板其它输入框
  //      对不上），DOT 的伤害类型同样从 <select> 换成 3 个 tab。
  //   ④ 持续时间新增独立的"永久"勾选框，不再是"填 ≤0 就是永久"这条要靠猜的隐藏规则。
  _EFFECT_TYPE_TABS: [
    { key: 'stat', label: '属性修正' },
    { key: 'stun', label: '眩晕（控制）' },
    { key: 'silence', label: '沉默（控制）' },
    { key: 'disarm', label: '缴械（控制）' },
    { key: 'dot', label: '持续伤害（DOT）' },
  ],
  // 与 CONFIG.templates 的实际字段 + AttributeCalculator 认得的条件字段对齐
  // （此前漏了 baseAttackSpeed / baseHealthRegenMod / 护盾三项 / 溅射 / 弹速 / 哀兵两项；
  //  v51 护盾三分类那次又漏了法强/技能增幅/暴击/适应之力/双吸血/闪避/韧性/法力两项，
  //  这批是那次事后自查补的——"添加效果"面板和真正的属性系统长期不同步，以后加新
  //  stat 字段时记得回来对一眼这份列表）。
  _EFFECT_STAT_KEYS: [
    'attackDamage', 'abilityPower', 'maxHP', 'healthRegen', 'baseHealthRegenMod', 'armor', 'magicResist',
    'moveSpeed', 'attackRange', 'baseAttackSpeed', 'bonusAttackSpeedPct', 'attackSpeedRatio',
    'critChance', 'critDamagePct', 'adaptiveForce',
    'damageAmpPct', 'skillAmpPct', 'damageReduction', 'damageBlock',
    'lifeStealPct', 'physicalVampPct', 'spellVampPct',
    'healShieldPowerPct', 'allStatsPct', 'coreStatsPct', 'damageConvertPct',
    'armorPenFlat', 'armorPenPercent', 'magicPenFlat', 'magicPenPercent',
    'onHitDamage', 'onHitPercentDamage',
    'evasionPct', 'tenacityPct',
    'maxMana', 'manaRegen',
    'shieldFixedMax', 'tempShieldDecayPct',
    'splashRadius', 'bulletSpeed',
    'avengerVsMinionAmpPct', 'avengerVsMinionRedPct',
  ],

  // v51.21 起：任何"自己就是一个百分比数字"的属性（技能增幅%、伤害增幅%、伤害减免%……），
  // 都不该再对它做百分比修正——用户原话"增长率不能再有'增长率'"，给一个百分比数再套
  // 一层百分比修正在概念上说不通。
  //
  // v51.21 最初只锁了 allStatsPct/coreStatsPct 这两个（当时正在查它们的显示 bug，
  // 顺手做的）。用户后来追问"是不是所有百分比的属性都这样，这个你做了吗"——查了一遍
  // 才发现漏了一大片：本仓库另一处（src/core/statMod.js，早前修暗之力/风魂失效那次）
  // 已经确立了同一条判据——"键名本身就是一个真实属性 → 按固定值加；键名去掉 Pct 后缀
  // 才是真实属性 → 才按百分比加"——但那是给 CONFIG 驱动的龙魂/龙威用的，这个手填的
  // "添加状态"编辑器一直没跟上，一个字段都没锁，用户能在这里对着 skillAmpPct 这类
  // 字段随手填百分比修正，填了跟没填一样（AttributeCalculator 通用公式是
  // `(基础值+flat)×(1+percent%)`，这批字段的基础值在全部单位模板里都是 0，
  // 光填百分比修正算出来恒等于 0——不是"数值算错"，是这条效果自己整个不生效，
  // 比原来那个 allStatsPct 的 bug 还彻底：那个好歹底层数值算对了、只是自己格子
  // 显示成 0；这批字段是真的连底层都没生效）。
  //
  // 名单按 src/ui/editor/fields.js 里 label 以"%"结尾的字段取（这是本仓库自己筛选
  // "这是不是一个百分比属性"的现成基准，逐个手动判断容易漏），另加两个 fields.js
  // 没收录但同样是"自身即百分比"的字段：onHitPercentDamage（攻击特效%当前生命）、
  // avengerVsMinionAmpPct/RedPct（哀兵机制，对小兵增伤/减伤%）。
  // 不锁的两类：① armorPenFlat/magicPenFlat/damageBlock/onHitDamage/adaptiveForce
  //   这些是"数量"不是"百分比"（穿透点数、格挡点数、适应之力点数），percent 修正对
  //   它们语义上没问题，只是恰好基础值也是 0——那是另一个"基础值恒为0所以百分比
  //   修正用不上"的普适现象，不属于"给百分比套百分比"这条概念性铁律，不在这次范围内。
  //   ② attackSpeedRatio（攻击速度收益率）：数值上是个系数（0.667），不是"XX%"，
  //   界面上也没有 % 后缀，且各模板基础值都非 0，不算这一类。
  _EFFECT_STAT_NO_PERCENT: new Set([
    'allStatsPct', 'coreStatsPct',
    'bonusAttackSpeedPct', 'damageReduction', 'tempShieldDecayPct',
    'armorPenPercent', 'magicPenPercent', 'damageConvertPct', 'lifeStealPct',
    'healShieldPowerPct', 'damageAmpPct', 'skillAmpPct', 'critChance', 'critDamagePct',
    'physicalVampPct', 'spellVampPct', 'evasionPct', 'tenacityPct',
    'onHitPercentDamage', 'avengerVsMinionAmpPct', 'avengerVsMinionRedPct',
  ]),

  _renderEffectPicker() {
    const tabs = this._EFFECT_TYPE_TABS.map((t, i) => `
      <button type="button" class="editor-tab ${i === 0 ? 'active' : ''}" data-efftype="${t.key}">${t.label}</button>
    `).join('');
    return `
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">${tabs}</div>
        <div class="effect-params">${this._renderEffectParams('stat')}</div>
        <button id="effectConfirmBtn" class="success" style="align-self:flex-start;">✅ 确认添加</button>
      </div>
    `;
  },

  /** 绑定 _renderEffectPicker 产出的整块（类型 tab + 参数区），三处调用方共用一份。 */
  _bindEffectPicker(box) {
    box.querySelectorAll('[data-efftype]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        box.querySelectorAll('[data-efftype]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        box.querySelector('.effect-params').innerHTML = this._renderEffectParams(btn.dataset.efftype);
        this._bindEffectParams(box);
      });
    });
    this._bindEffectParams(box);
  },

  /** 参数区内部控件（属性卡片网格+搜索 / DOT 伤害类型 tab / 永久勾选框），每次参数区重绘都要重新绑一遍。 */
  _bindEffectParams(box) {
    const grid = box.querySelector('.effect-stat-grid');
    if (grid) {
      const hidden = box.querySelector('.effect-stat-key');
      const percentRow = box.querySelector('.effect-percent-row');
      const flatLabel = box.querySelector('.effect-flat-label');
      const percentInput = box.querySelector('.effect-percent-value');
      const syncShieldMode = (key) => {
        const isShield = key === '__shield__';
        // v51.21：allStatsPct/coreStatsPct 只能用数值修正——见上面 _EFFECT_STAT_NO_PERCENT
        // 头注，跟护盾一样直接隐藏"百分比修正"整行，不是禁用输入框（免得用户以为
        // 灰掉的框还能填、只是暂时点不动）。
        const noPercent = this._EFFECT_STAT_NO_PERCENT.has(key);
        const hide = isShield || noPercent;
        if (percentRow) percentRow.style.display = hide ? 'none' : '';
        // 隐藏之后把输入框清零：不清的话，用户先在别的属性上填过百分比、再切到
        // allStatsPct，这一行虽然看不见了，但 DOM 里的旧值还在，_buildEffectBlueprintFromPicker
        // 照样会把它读出来塞进 percentValue——UI 上"锁住"了，蓝图里其实没锁住。
        if (hide && percentInput) percentInput.value = '0';
        if (flatLabel) flatLabel.textContent = isShield ? '护盾值' : '数值修正';
      };
      grid.querySelectorAll('[data-effstat]').forEach(card => {
        card.addEventListener('click', () => {
          grid.querySelectorAll('[data-effstat]').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          if (hidden) hidden.value = card.dataset.effstat;
          syncShieldMode(card.dataset.effstat);
        });
      });
      syncShieldMode(hidden?.value);
      const filterInput = box.querySelector('.effect-stat-filter');
      filterInput?.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        grid.querySelectorAll('[data-effstat]').forEach(card => {
          const hit = !q || card.dataset.effstat.toLowerCase().includes(q) || card.textContent.toLowerCase().includes(q);
          card.style.display = hit ? '' : 'none';
        });
      });
    }
    box.querySelectorAll('[data-effdot]').forEach(btn => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('[data-effdot]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const hidden = box.querySelector('.effect-dot-type');
        if (hidden) hidden.value = btn.dataset.effdot;
      });
    });
    const permCk = box.querySelector('.effect-permanent');
    const durInput = box.querySelector('.effect-duration');
    if (permCk && durInput) {
      durInput.disabled = permCk.checked;
      permCk.addEventListener('change', () => { durInput.disabled = permCk.checked; });
    }
  },

  _renderEffectParams(type) {
    if (type === 'stun') {
      return `
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.1" class="effect-duration editor-number" value="1">
        </div>
        <div class="pick-desc-box">眩晕期间目标停止一切行动（攻击/移动/技能）。</div>
      `;
    }
    if (type === 'silence') {
      return `
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.1" class="effect-duration editor-number" value="1">
        </div>
        <div class="pick-desc-box">沉默期间目标无法施放技能，仍可移动和普通攻击。</div>
      `;
    }
    if (type === 'disarm') {
      return `
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.1" class="effect-duration editor-number" value="1">
        </div>
        <div class="pick-desc-box">缴械期间目标无法进行普通攻击，仍可移动和施放技能。</div>
      `;
    }
    // v51.12：用户"状态添加的窗口里，持续时间默认5秒改为300秒，并且默认选中永久
    // 生效"——原来 5 秒默认值太短，编辑器里加个状态测试/调试经常还没看清楚就
    // 自己过期了；默认勾"永久"之后，持续时间那个数字只在取消勾选时才用得上
    // （下面几处保存逻辑本来就是"勾了永久就忽略具体秒数"）。stun/silence/disarm
    // 三种控制效果默认 1 秒不受影响——那三个是"短暂打断"用的，默认永久反而不合理。
    // 护盾原来是独立的第 6 个顶层 tab，用户："把添加状态中的护盾移动到属性修正里
    // 面"——现在改成"属性修正"卡片网格里的第一张卡（data-effstat="__shield__"，
    // 见下面 stat 分支），不再单独占一个 tab；具体的"护盾值/持续时间/永久"输入框
    // 直接复用 stat 分支已有的 数值修正/持续时间/永久（见 _bindEffectParams 里
    // 选中该卡时隐藏"百分比修正"、把"数值修正"标签换成"护盾值"的逻辑）。
    if (type === 'dot') {
      const dotTabs = [
        { key: 'magic', label: '魔法' }, { key: 'physical', label: '物理' }, { key: 'true', label: '真实' },
      ].map((d, i) => `<button type="button" class="editor-tab ${i === 0 ? 'active' : ''}" data-effdot="${d.key}">${d.label}</button>`).join('');
      return `
        <div class="panel-sec">伤害类型</div>
        <div style="display:flex;gap:6px;">${dotTabs}</div>
        <input type="hidden" class="effect-dot-type" value="magic">
        <div class="slider-row" style="margin-top:8px;"><label>每次伤害</label>
          <input type="number" step="1" class="effect-flat-value editor-number" value="10">
        </div>
        <div class="slider-row"><label>持续时间(秒)</label>
          <input type="number" step="0.5" class="effect-duration editor-number" value="300">
        </div>
        <div class="slider-row"><label>永久</label>
          <input type="checkbox" class="effect-permanent" checked style="accent-color:var(--accent-2);width:16px;height:16px;cursor:pointer;">
        </div>
      `;
    }
    // stat（默认）
    // "护盾"卡片放最前面，data-effstat 用 __shield__ 这个不进 AttributeCalculator 的
    // 哨兵键——选中它时不是加一条 kind:'stat' 的属性修正，而是建一条 kind:'shield'
    // 效果（见 _buildEffectBlueprintFromPicker 里的分支），复用下面同一套 数值修正
    // （此时含义变成"护盾值"）/持续时间/永久 输入框，_bindEffectParams 里会在选中
    // 它时隐藏用不上的"百分比修正"行。
    const shieldCard = `
      <div class="pick-card" data-effstat="__shield__">
        <span class="pick-label">护盾</span>
      </div>`;
    const cards = shieldCard + this._EFFECT_STAT_KEYS.map((k, i) => `
      <div class="pick-card ${i === 0 ? 'selected' : ''}" data-effstat="${k}">
        <span class="pick-label">${fieldLabel(k)}</span>
      </div>`).join('');
    return `
      <div class="panel-sec">属性</div>
      <input type="text" class="effect-stat-filter editor-number" placeholder="🔍 搜索属性…" style="width:100%;">
      <div class="pick-grid effect-stat-grid" style="max-height:160px;overflow-y:auto;margin-top:6px;">${cards}</div>
      <input type="hidden" class="effect-stat-key" value="${this._EFFECT_STAT_KEYS[0]}">
      <div class="slider-row" style="margin-top:6px;"><label class="effect-flat-label">数值修正</label>
        <input type="number" step="0.5" class="effect-flat-value editor-number" value="0">
      </div>
      <div class="slider-row effect-percent-row"><label>百分比修正</label>
        <input type="number" step="0.5" class="effect-percent-value editor-number" value="0">
      </div>
      <div class="slider-row"><label>持续时间(秒)</label>
        <input type="number" step="0.5" class="effect-duration editor-number" value="300">
      </div>
      <div class="slider-row"><label>永久</label>
        <input type="checkbox" class="effect-permanent" checked style="accent-color:var(--accent-2);width:16px;height:16px;cursor:pointer;">
      </div>
    `;
  },
};
