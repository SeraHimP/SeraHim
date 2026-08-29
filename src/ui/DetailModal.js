import { shellHtml } from './dialogShell.js';
import { CONFIG } from '../data/Config.js';
import { renderSkillDescription } from '../core/SkillLibrary.js';

// 属性名 → 中文标签（共享常量：UIManager 的天气影响行也用它，避免两处定义漂移）
export const STAT_LABELS = {
  attackDamage: '攻击力', maxHP: '最大生命', armor: '护甲', magicResist: '魔抗',
  moveSpeed: '移速', attackRange: '攻击距离', bonusAttackSpeedPct: '攻速',
  damageReduction: '伤害减免', damageAmpPct: '伤害增幅', allStatsPct: '全属性',
  // v51.6：生命偷取全局改名为"全能吸血"（用户定稿）——lifeStealPct 这个字段名不变，
  // 只改中文显示标签，物理/法术/全能三件套里它一直就是"全部伤害类型都算"的那一档，
  // 改名之后名字才真正对上语义。
  lifeStealPct: '全能吸血', healShieldPowerPct: '治疗护盾强度',
  armorPenFlat: '固定护甲穿透', armorPenPercent: '护甲穿透',
  magicPenFlat: '固定法穿', magicPenPercent: '法术穿透',
  healthRegen: '生命回复', onHitPercentDamage: '攻击特效',
  shieldFixedMax: '固定护盾', baseAttackSpeed: '基础攻速',
  // v51：新增属性
  abilityPower: '法术强度', skillAmpPct: '技能增幅', critChance: '暴击率', critDamagePct: '暴击伤害加成',
  adaptiveForce: '适应之力', physicalVampPct: '物理吸血', spellVampPct: '法术吸血',
  evasionPct: '闪避率', tenacityPct: '韧性',
  maxMana: '最大法力', manaRegen: '法力回复',
};


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
    const desc = renderSkillDescription(def, entity, ctx);
    const disabled = instance && instance._disabled;
    const lines = [
      `📌 ${def.name}${disabled ? '（因装备特殊攻击方式武器而禁用）' : ''}`,
      ``,
      desc || def.description || '无',
    ];
    const html = `<pre style="white-space:pre-wrap;font-size:13px;line-height:1.9;">${lines.join('\n')}</pre>`;
    this._showModal(`技能详情 - ${def.name}`, html);
  },

  showEffectGroup(name, effects) {
    const statNames = STAT_LABELS;
    let stacks = 1, hasStack = false;
    const lines = [];
    for (const e of effects) {
      const bp = e.blueprint;
      if (bp.stackable && e.stacks > stacks) { stacks = e.stacks; hasStack = true; }
      if (bp.kind === 'stat' && bp.statKey) {
        const label = statNames[bp.statKey] || bp.statKey;
        const flat = e.totalFlat || 0, pct = e.totalPercent || 0;
        const parts = [];
        if (flat) parts.push((flat > 0 ? '+' : '') + Math.round(flat * 10) / 10);
        if (pct) parts.push((pct > 0 ? '+' : '') + Math.round(pct * 10) / 10 + '%');
        lines.push(`　${label}：${parts.join('，') || '—'}`);
      } else if (bp.kind === 'dot') {
        lines.push(`　持续伤害（${bp.damageType === 'true' ? '真实' : bp.damageType === 'physical' ? '物理' : '魔法'}）`);
      } else if (bp.kind === 'stun') {
        lines.push(`　眩晕：无法行动`);
      } else if (bp.kind === 'display') {
        lines.push(`　${bp.description || ''}`);
      }
    }
    const remain = effects.reduce((m, e) => Math.max(m, e.remainingTime), 0);
    const permanent = effects.some(e => e.permanent || e.blueprint.duration <= 0);
    const header = [
      `📌 ${name}${hasStack ? `（${stacks}层）` : ''}`,
      permanent ? '持续：常驻' : `剩余：${remain === Infinity ? '永久' : remain.toFixed(1) + 's'}`,
      '',
      '效果：',
      ...lines,
    ];
    const html = `<pre style="white-space:pre-wrap;font-size:13px;line-height:1.9;">${header.join('\n')}</pre>`;
    this._showModal(`效果详情 - ${name}`, html);
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
      `HP: ${Math.round(entity.currentHP)} / ${Math.round(stats.maxHP)}`,
      `护盾: 固定 ${Math.round(entity.shieldFixedCurrent || 0)} / ${Math.round(stats.shieldFixedMax || 0)}  |  临时 ${Math.round(entity.tempShield || 0)}`,
      `攻击力: ${Math.round(stats.attackDamage)}`,
      `攻速: ${stats.baseAttackSpeed.toFixed(2)} (加成 ${Math.round(stats.bonusAttackSpeedPct)}%)`,
      `护甲: ${Math.round(stats.armor)}  |  魔抗: ${Math.round(stats.magicResist)}`,
      `穿透: ${Math.round(stats.armorPenPercent)}% + ${Math.round(stats.armorPenFlat)}  |  法穿: ${Math.round(stats.magicPenPercent)}% + ${Math.round(stats.magicPenFlat)}`,
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

  _showModal(title, contentHtml) {
    // 移除已存在的模态框
    const existing = document.querySelector('.modal-overlay:last-child');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    // v43 Q1：与模板编辑器同一套外框（.editor-container + h4 + .tpl-pane）。
    // 这个框只有一页内容，所以**不摆侧边栏** —— 一个只有一项的导航是纯装饰，
    // 比没有更糟。统一的是外框、字号与滚动行为，不是"每个窗口都必须有侧栏"。
    modal.innerHTML = shellHtml({
      title, body: contentHtml, crumb: '',
      footer: '<div class="modal-actions"><button id="detailCloseBtn" class="primary">关闭</button></div>',
    });
    document.body.appendChild(modal);
    modal.querySelector('#detailCloseBtn').addEventListener('click', () => modal.remove());
  }
};