import { shellHtml } from './dialogShell.js';
import { CONFIG } from '../data/Config.js';
import { renderSkillDescription } from '../core/SkillLibrary.js';
import { soulStatMods } from '../core/skills/dragonSouls.js';

// 属性名 → 中文标签（共享常量：UIManager 的天气影响行也用它，避免两处定义漂移）
export const STAT_LABELS = {
  attackDamage: '攻击力', maxHP: '最大生命', armor: '护甲', magicResist: '魔法抗性',
  moveSpeed: '移速', attackRange: '攻击距离', bonusAttackSpeedPct: '攻速',
  damageReduction: '伤害减免', damageAmpPct: '伤害增幅', allStatsPct: '全属性',
  // v51.6：生命偷取全局改名为"全能吸血"（用户定稿）——lifeStealPct 这个字段名不变，
  // 只改中文显示标签，物理/法术/全能三件套里它一直就是"全部伤害类型都算"的那一档，
  // 改名之后名字才真正对上语义。
  lifeStealPct: '全能吸血', healShieldPowerPct: '治疗护盾强度',
  armorPenFlat: '固定护甲穿透', armorPenPercent: '护甲穿透',
  magicPenFlat: '固定法术穿透', magicPenPercent: '法术穿透',
  healthRegen: '生命回复', onHitPercentDamage: '攻击特效',
  shieldFixedMax: '固定护盾', baseAttackSpeed: '基础攻速',
  // v51：新增属性
  abilityPower: '法术强度', skillAmpPct: '技能增幅', critChance: '暴击率', critDamagePct: '暴击伤害',
  adaptiveForce: '适应之力', physicalVampPct: '物理吸血', spellVampPct: '法术吸血',
  evasionPct: '闪避率', tenacityPct: '韧性',
  maxMana: '最大法力', manaRegen: '法力回复',
  // v51.6 修复：这四个键在龙之力/龙魂常驻加持里都用得到（风龙之力的 attackSpeedRatio、
  // 霜龙/龙魂的 damageBlock、血龙之力的 damageConvertPct、星龙之力的 bulletSpeed），
  // 之前这张表没覆盖，落进 modsGridHtml 的 `STAT_LABELS[k] || k` 兜底，原样显示了英文
  // 字段名（用户报的"风龙之力"悬浮预览截图里那个"attackSpeedRatio"就是这个）。
  attackSpeedRatio: '攻速系数', damageBlock: '格挡值',
  damageConvertPct: '伤害转化', bulletSpeed: '子弹速度',
};

// v51.6：这些属性本身就是"百分比量纲"的真实属性（键名多以 Pct/Percent 结尾），
// 但 core/statMod.js 判定"键本身是不是真属性"时把它们归进**固定值**（flat）分支——
// 那条判据对"防止百分比属性被静默丢弃"是对的，只是 modsGridHtml 原来对 flat 值一律
// 不加 % 后缀，于是这些属性的常驻加成显示成"+4.0"而不是"+4.0%"（用户报"风龙之力"
// 截图里的攻速那一行）。这张表只是记录"这些已有属性的显示单位是百分比"，不是新增属性。
const PERCENT_UNIT_KEYS = new Set([
  'bonusAttackSpeedPct', 'damageAmpPct', 'lifeStealPct', 'healShieldPowerPct', 'allStatsPct',
  'skillAmpPct', 'damageConvertPct', 'tenacityPct', 'evasionPct', 'onHitPercentDamage',
  'critDamagePct', 'physicalVampPct', 'spellVampPct', 'damageReduction',
  'armorPenPercent', 'magicPenPercent', 'critChance',
]);

/**
 * ==================== v51.6：属性加成的统一展示块（共享实现） ====================
 * 用户："技能/状态/天气等所有点开窗口中，关于属性的加减，都用天气属性那一套UI中
 * 属性加减那个块。" ——天气/世界效应/状态详情三个弹窗都要用同一份，不能各写一份、
 * 迟早走样。UIManager._modsGridHtml 直接委托这里，避免同一段渲染逻辑抄两遍。
 * mods 形如 { statKey: { flat, percent } }；为空时返回空字符串，调用方自己决定
 * 空状态怎么显示（"无增益"之类）。
 */
export function modsGridHtml(mods) {
  const entries = Object.entries(mods || {});
  if (!entries.length) return '';
  return entries.map(([k, m]) => {
    const label = STAT_LABELS[k] || k;
    const parts = [];
    if (m.flat) {
      // v51.6 修复：< 1 的量原来也按 1 位小数显示，attackSpeedRatio 这类小数值
      // （如 +0.02）会被四舍五入成"+0.0"，看起来像完全没有效果——补一档 2 位小数。
      const av = Math.abs(m.flat);
      const v = av < 1 ? m.flat.toFixed(2) : av < 10 ? m.flat.toFixed(1) : Math.round(m.flat);
      // 键名本身是百分比量纲（如 bonusAttackSpeedPct）时，flat 增量也要带 % ——
      // 否则会显示成"+4.0"，看不出这是攻速百分比还是别的什么数。
      const unit = PERCENT_UNIT_KEYS.has(k) ? '%' : '';
      parts.push((m.flat > 0 ? '+' : '') + v + unit);
    }
    if (m.percent) parts.push((m.percent > 0 ? '+' : '') + m.percent.toFixed(1) + '%');
    return `<div class="a"><label>${label}</label><span>${parts.join(' ')}</span></div>`;
  }).join('');
}


/**
 * ==================== v51.6：技能数值说明——LoL 式颜色标注 + 简洁/详细切换 ====================
 * 用户举例：【唯一被动——加固城防：防御塔获得（25%=10%【默认颜色】+5%法术强度【紫色】+
 * 10%攻击力【橙色】+10%魔法抗性【亮蓝色】+5%护甲【皮革色】）伤害减免】，"参考 LoL 中
 * 关于技能数值的描述，并且可选简洁显示、详细显示。简洁显示就省略计算公式"。
 *
 * 本仓库几乎所有 descTemplate 都已经统一用（数值=公式）这个括号形状写公式
 * （Q5 定稿：外层【】已删，只剩这层圆括号），所以不需要每条技能单独改写——
 * 提取一个通用的括号解析器就能覆盖全部技能，不用逐条技能手工加颜色标记。
 *
 * 颜色只认**已有属性**（STAT_LABELS 这份表——攻击力/护甲/魔抗等都是游戏里本来就有的
 * 属性，不是为了上色新造的名字），公式里认不出的部分（固定数字、运算符、"×层数"
 * 这类非属性文字）保持默认色，不强行上色。
 */
export const STAT_COLORS = {
  abilityPower: '#b388ff',   // 法术强度——紫色
  attackDamage: '#f0a03c',   // 攻击力——橙色（与属性面板"正向修正"同一个橙，含义一致）
  magicResist: '#4fc3f7',    // 魔法抗性/魔抗——亮蓝色
  armor: '#c19a6b',          // 护甲——皮革色
};

// 括号里"（数值=公式）"这个统一形状；数值段不含 = ( ) 三个字符，公式段允许任意字符
// （护甲×7%这类算式、"每层1点+0.25%"这类连接词都要整段保留，只处理其中的属性名）。
const FORMULA_RE = /（([^（）=]+)=([^（）]+)）/g;

// 长名字优先匹配，避免"魔法抗性"被"抗性"之类的子串抢先命中（当前 STAT_LABELS
// 里没有这种前缀重叠，这里排序是防止未来加新属性名时悄悄踩坑）。
const _colorNames = Object.keys(STAT_COLORS)
  .map((k) => [STAT_LABELS[k], STAT_COLORS[k]])
  .filter(([label]) => label)
  .sort((a, b) => b[0].length - a[0].length);

function _colorizeFormula(formula) {
  let html = formula;
  for (const [label, color] of _colorNames) {
    html = html.split(label).join(`<span style="color:${color};">${label}</span>`);
  }
  return html;
}

/**
 * 把技能描述文本里的每一处"（数值=公式）"转成 HTML。
 * concise=true（简洁）：整个括号连同公式一起吞掉，只留数值本身；
 * concise=false（详细，默认）：保留括号，公式里认得出的属性按专属颜色标出。
 * 返回的是 **HTML**，只能用在本来就走 innerHTML 的语境（弹窗/悬浮预览）——
 * 编辑器里那几处技能描述预览框用的是 textContent，会把 <span> 原样显示成文字，
 * 那些地方不要调用这个函数，直接用 renderSkillDescription 的纯文本结果即可。
 */
export function formatSkillFormulasHtml(text, { concise = false } = {}) {
  if (!text) return text;
  return text.replace(FORMULA_RE, (_, val, formula) => (concise ? val : `（${val}=${_colorizeFormula(formula)}）`));
}

// statSummary()（dragonSouls.js）拼在描述末尾的那一句人话固定形状："　常驻加持：……。"
// 这个全角空格 + 固定前缀是它唯一的识别标记，见该函数最后一行 `return ... 常驻加持：...`。
const SOUL_TAIL_RE = /　常驻加持：.*$/;

/**
 * ==================== v51.6：龙魂"常驻加持"从文字尾巴换成统一网格块 ====================
 * 用户："龙魂常驻加持的描述目前还是走的文字，改成统一的那种块。"——参考效果详情弹窗
 * （如"术法贯通"）护甲穿透/法术穿透那种两列网格。
 *
 * description/descTemplate 本身的纯文本口径不动（sim_skilldesc.mjs 靠文本里的数字核对
 * "文案数值与实际效果一致"；编辑器里几处预览框是 textContent，塞 HTML 只会显示成
 * 一堆 <span> 字面量）——只在弹窗/悬浮预览这类走 innerHTML 的地方，把这句尾巴换掉。
 * 网格数据来自 soulStatMods()，与真正挂给实体的效果（soulStatBlueprints）同一套
 * statMod() 翻译规则，不会出现"网格写的和实际生效的对不上"。
 *
 * 点开详情弹窗（showSkillDetail）与悬浮预览（UIManager._hoverBodyForSkill）都调用它，
 * 不重复写一份判断逻辑。
 */
export function skillDescHtmlParts(def, rawDesc, { concise = false } = {}) {
  let text = rawDesc;
  let gridHtml = '';
  if (def && typeof def.id === 'string' && def.id.startsWith('dragonsoul_') && SOUL_TAIL_RE.test(text)) {
    const el = def.id.slice('dragonsoul_'.length);
    const grid = modsGridHtml(soulStatMods(el));
    if (grid) {
      text = text.replace(SOUL_TAIL_RE, '').trimEnd();
      gridHtml = `<div style="font-size:10px;color:var(--text-dim);margin:8px 0 4px;">常驻加持</div>`
        + `<div class="attrs" style="display:grid;">${grid}</div>`;
    }
  }
  return { textHtml: formatSkillFormulasHtml(text, { concise }), gridHtml };
}

// 简洁/详细是查看偏好，不是游戏数值——不进 Config.js（那是给"能改变数值行为"的
// 参数用的），跨弹窗记住这一个会话内的选择即可，刷新页面重置回默认"详细"。
let _skillDescMode = 'detail';
export function getSkillDescMode() { return _skillDescMode; }
export function setSkillDescMode(mode) { _skillDescMode = mode === 'concise' ? 'concise' : 'detail'; }

/**
 * ==================== v51.6：效果分组的共享折算逻辑（点击弹窗与悬浮预览都用它） ====================
 * 用户报的 bug："状态的悬浮显示窗口目前只显示了属性变化，如果有其他文字说明也要一并
 * 显示"——之前只有 showEffectGroup（点击弹窗）会把 dot/stun/display 这类"不是属性数值"
 * 的效果折算成文字说明，UIManager._hoverBodyForEffect（悬浮预览）另写了一份，只处理了
 * kind:'stat'，把这些说明漏掉了。抽出来共用，不留第三份不同步的实现。
 */
export function effectGroupBreakdown(effects) {
  const mods = {};
  const otherLines = [];
  for (const e of effects) {
    const bp = e.blueprint;
    if (bp.kind === 'stat' && bp.statKey) {
      const flat = e.totalFlat || 0, pct = e.totalPercent || 0;
      if (!flat && !pct) continue;
      const m = mods[bp.statKey] || (mods[bp.statKey] = { flat: 0, percent: 0 });
      m.flat += flat; m.percent += pct;
    } else if (bp.kind === 'dot') {
      otherLines.push(`持续伤害（${bp.damageType === 'true' ? '真实' : bp.damageType === 'physical' ? '物理' : '魔法'}）`);
    } else if (bp.kind === 'stun') {
      otherLines.push('眩晕：无法行动');
    } else if (bp.kind === 'display') {
      otherLines.push(bp.description || '');
    }
  }
  return { gridHtml: modsGridHtml(mods), otherLines };
}

export const DetailModal = {
  showTowerDetail(id, entityContainer, effectRegistry, attrCalc) {
    const tower = entityContainer.get(id);
    if (!tower) return;
    const stats = attrCalc.calc(tower, effectRegistry.getEffects(id));
    const effs = effectRegistry.getEffects(id);
    this._showDetail('塔', tower, stats, effs);
  },

  showMinionDetail(id, entityContainer, effectRegistry, attrCalc) {
    const minion = entityContainer.get(id);
    if (!minion) return;
    const stats = attrCalc.calc(minion, effectRegistry.getEffects(id));
    const effs = effectRegistry.getEffects(id);
    this._showDetail('小兵', minion, stats, effs);
  },

  showSkillDetail(def, instance, entity, ctx) {
    const desc = renderSkillDescription(def, entity, ctx) || def.description || '无';
    const disabled = instance && instance._disabled;
    // v51.6 追补：标题图标原来写死📌，与技能栏格子里的真实图标（def.icon）对不上
    // ——同一处用户报过的"悬浮图标不匹配"这里也顺手一起改掉。
    const title = `${def.icon || '🔹'} ${def.name}${disabled ? '（因装备特殊攻击方式武器而禁用）' : ''}`;
    // v51.6：龙魂的"常驻加持"从文字尾巴换成网格块（skillDescHtmlParts，Q15），
    // 与点开效果详情（showEffectGroup）、悬浮预览三处共用同一份 modsGridHtml 视觉语言。
    const renderBody = (mode) => {
      const { textHtml, gridHtml } = skillDescHtmlParts(def, desc, { concise: mode === 'concise' });
      return `<pre style="white-space:pre-wrap;font-size:13px;line-height:1.9;margin:0;">${textHtml}</pre>${gridHtml}`;
    };
    const mode = getSkillDescMode();
    const body = `<div id="skillDescBody">${renderBody(mode)}</div>`;
    // v51.6 追补：用户"点开窗口的简洁详细按钮合并成一个，显示当前的模式，点一下切换到
    // 另一个模式。位置改到左下角。"——原来是两颗按钮各占一个模式，现在合成一颗，
    // 按钮文字就是"当前处于哪个模式"，点一下切到另一个；margin-right:auto 把它推到
    // .modal-actions（justify-content:flex-end）这排的最左边，右边的"关闭"不受影响。
    const footerExtra = `<button id="skillModeToggle" class="skill-mode-toggle-single" style="margin-right:auto;"
      data-mode="${mode}">${mode === 'concise' ? '简洁' : '详细'}</button>`;
    this._showModal(`技能详情 - ${def.name}`, body, {
      footerExtra,
      afterMount: (modal) => {
        const bodyEl = modal.querySelector('#skillDescBody');
        const btn = modal.querySelector('#skillModeToggle');
        btn.addEventListener('click', () => {
          const next = btn.dataset.mode === 'concise' ? 'detail' : 'concise';
          setSkillDescMode(next);
          btn.dataset.mode = next;
          btn.textContent = next === 'concise' ? '简洁' : '详细';
          bodyEl.innerHTML = renderBody(next);
        });
      },
    });
  },

  /**
   * ==================== v51.6：状态详情改走天气弹窗那一套网格样式 ====================
   * 用户："状态窗口中属性变化那种我也想弄成天气窗口那种形式。" ——原来是纯文本
   * 的 <pre> 逐行罗列（"　攻击力：+10"），现在属性类效果（kind:'stat'）走共用的
   * modsGridHtml 网格；持续伤害/眩晕/展示类效果不是"属性数值"，没法塞进网格，
   * 仍以文字说明列在网格下方。
   */
  showEffectGroup(name, effects) {
    let stacks = 1, hasStack = false;
    for (const e of effects) {
      if (e.blueprint.stackable && e.stacks > stacks) { stacks = e.stacks; hasStack = true; }
    }
    const { gridHtml, otherLines } = effectGroupBreakdown(effects);
    const remain = effects.reduce((m, e) => Math.max(m, e.remainingTime), 0);
    const permanent = effects.some(e => e.permanent || e.blueprint.duration <= 0);
    const body = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:var(--text-dim);">
        ${hasStack ? `<span>${stacks} 层</span>` : ''}
        <span>${permanent ? '持续：常驻' : `剩余：${remain === Infinity ? '永久' : remain.toFixed(1) + 's'}`}</span>
      </div>
      ${gridHtml ? `<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">属性变化</div>
        <div class="attrs" style="display:grid;">${gridHtml}</div>` : ''}
      ${otherLines.length ? `<p style="font-size:12px;line-height:1.8;margin:${gridHtml ? '10px' : '0'} 0 0;">${otherLines.join('<br>')}</p>` : ''}
      ${!gridHtml && !otherLines.length ? `<p style="font-size:12px;color:var(--text-mute);margin:0;">（无属性变化）</p>` : ''}
    `;
    this._showModal(`效果详情 - ${name}`, body);
  },

  showEffectDetail(effect) {
    const lines = [
      `📌 ${effect.blueprint.name}`,
      `描述：${effect.blueprint.description || '无'}`,
      `类型：${effect.blueprint.kind}`,
      `剩余时间：${effect.remainingTime === Infinity ? '永久' : effect.remainingTime.toFixed(1) + 's'}`,
      `层数：${effect.stacks}`,
      `来源：${effect.sourceId}`,
    ];
    const html = `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.8;">${lines.join('\n')}</pre>`;
    this._showModal(`效果详情 - ${effect.blueprint.name}`, html);
  },

  _showDetail(label, entity, stats, effects) {
    const lines = [
      `#${entity.id} ${CONFIG.templates[entity.type]?.label || entity.type}`,
      `──────────────`,
      `生命值: ${Math.round(entity.currentHP)} / ${Math.round(stats.maxHP)}`,
      `护盾: 固定 ${Math.round(entity.shieldFixedCurrent || 0)} / ${Math.round(stats.shieldFixedMax || 0)}  |  临时 ${Math.round(entity.tempShield || 0)}  |  护盾 ${Math.round(entity.plainShield || 0)}`,
      `攻击力: ${Math.round(stats.attackDamage)}`,
      `攻速: ${stats.baseAttackSpeed.toFixed(2)} (加成 ${Math.round(stats.bonusAttackSpeedPct)}%)`,
      `护甲: ${Math.round(stats.armor)}  |  魔法抗性: ${Math.round(stats.magicResist)}`,
      `穿透: ${Math.round(stats.armorPenPercent)}% + ${Math.round(stats.armorPenFlat)}  |  法术穿透: ${Math.round(stats.magicPenPercent)}% + ${Math.round(stats.magicPenFlat)}`,
      `伤害减免: ${Math.round(stats.damageReduction)}%  |  格挡: ${Math.round(stats.damageBlock)}`,
      `伤害转化: ${Math.round(stats.damageConvertPct)}%  |  全能吸血: ${Math.round(stats.lifeStealPct)}%`,
      `攻击特效: 固定 ${Math.round(stats.onHitDamage)}  |  %当前生命 ${Math.round(stats.onHitPercentDamage)}%`,
      `治疗护盾强度: ${Math.round(stats.healShieldPowerPct)}%  |  全属性加成: ${Math.round(stats.allStatsPct)}%`,
      `移速: ${Math.round(stats.moveSpeed)}  |  攻击距离: ${Math.round(stats.attackRange)}`,
      `子弹速度: ${Math.round(stats.bulletSpeed)}`,
      `──────────────`,
      `当前效果 (${effects.length}个):`,
      ...(effects.length ? effects.map(e => {
        const detail = e.stacks > 1 ? ` (层数 ${e.stacks})` : '';
        return `  ${e.blueprint.icon} ${e.blueprint.name}${detail} (${e.remainingTime === Infinity ? '永久' : e.remainingTime.toFixed(1) + 's'})`;
      }) : ['  (无)']),
    ];
    const html = `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.8;">${lines.join('\n')}</pre>`;
    this._showModal(`📋 ${label} 详情`, html);
  },

  _showModal(title, contentHtml, opts = {}) {
    // 移除已存在的模态框
    const existing = document.querySelector('.modal-overlay:last-child');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    // v43 Q1：与模板编辑器同一套外框（.editor-container + h4 + .tpl-pane）。
    // 这个框只有一页内容，所以**不摆侧边栏** —— 一个只有一项的导航是纯装饰，
    // 比没有更糟。统一的是外框、字号与滚动行为，不是"每个窗口都必须有侧栏"。
    // opts.footerExtra：塞进关闭按钮左边的额外控件（目前只有 showSkillDetail 的
    // 简洁/详细切换按钮用）。用 margin-right:auto 把它推到 .modal-actions
    // （justify-content:flex-end）这一排的最左边，不用整体改这个共用类的对齐方式。
    modal.innerHTML = shellHtml({
      title, body: contentHtml, crumb: '',
      footer: `<div class="modal-actions">${opts.footerExtra || ''}<button id="detailCloseBtn" class="primary">关闭</button></div>`,
    });
    document.body.appendChild(modal);
    // v51.6：技能详情的简洁/详细切换按钮需要在挂载后另外接线（重新渲染 body 里
    // 那段 <pre>），这段挂载逻辑只有 showSkillDetail 用得到，所以做成可选回调，
    // 不强加给其它走 _showModal 的调用方（它们不传就什么都不多做）。
    if (opts.afterMount) opts.afterMount(modal);
    modal.querySelector('#detailCloseBtn').addEventListener('click', () => modal.remove());
  }
};