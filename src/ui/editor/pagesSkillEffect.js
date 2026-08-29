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
    // v43 P1-4：拆分前这里写的是 `AttributeEditor._customEffectSeq`（同文件里的模块级引用）。
    // 拆出来之后本文件已经看不到那个名字了，改成 `this.` —— 计数器仍然落在合并后的
    // 那**同一个对象**上，唯一的差别是不再需要反向 import 整个 AttributeEditor（那会成环）。
    // 全部调用点都是 `X._newCustomStackKey()` 形式（this 就是 AttributeEditor），行为一致。
    this._customEffectSeq = (this._customEffectSeq || 0) + 1;
    return `custom_${Date.now().toString(36)}_${this._customEffectSeq}`;
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
      'shieldFixedMax', 'tempShieldDecayPct',
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
};
