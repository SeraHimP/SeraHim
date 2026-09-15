import { SkillLibrary } from '../../core/SkillLibrary.js';

/**
 * gpMatrix.js —— 「批量加技能 / 批量加状态」两页共用的选择组件
 *
 * 用户定稿：
 *   Q2「批量添加技能窗口中，上面的复选框按照分类显示，然后弄成那种一二级菜单，
 *      并且右侧列添加全选的按钮。并且应该读取选中的单位持有的技能，如果共有的就显示
 *      选中（实线），有的没有的显示半选中（虚线），都没有的显示未选中。
 *      并且武器类型塔只能选一个，所以新选的武器会覆盖旧的武器。」
 *   Q3「批量添加状态的也显示该类型单位所持有的共有的/非共有的，选择逻辑还是上面的那种。」
 *
 * ==================== 为什么单独一个文件 ====================
 * 两页要的是**同一套**交互（同样的目标矩阵、同样的三态、同样的全选）。
 * 抄一份过去的话，下次改三态的判据就要改两处 —— 本仓库最常见的那类 bug 就是这么来的
 *（同一条规则实现两遍，先做的改对了、后做的没人想起来）。
 *
 * ==================== 三态的判据 ====================
 * 这两页写的是**场上活着的实体**（见 _gpApplyToField），不是模板。
 * 所以"持有"= 选中的那些格子里、活着的实体身上有没有这个技能/状态：
 *   全都有 → 'all'（实线选中）    一部分有 → 'some'（虚线半选）    都没有 → 'none'
 * 没有任何实体匹配时返回 'none' 且 count=0，界面据此显示"（无匹配单位）"，
 * 而不是让人对着一堆永远点不动的复选框猜为什么。
 */

/** 一个格子（行|阵营）匹配哪些活着的实体。 */
export function entitiesOfCell(cellKey, entityContainer) {
  if (!entityContainer?.getAll) return [];
  const [rowKey, faction] = cellKey.split('|');
  const isTower = rowKey.startsWith('tower:');
  const tier = isTower ? rowKey.slice(6) : null;
  const type = isTower ? 'tower' : rowKey;
  const out = [];
  for (const e of entityContainer.getAll()) {
    if (!e || !e.alive) continue;
    if (isTower) { if (e.type !== 'tower' || (e._mapTier || 'outer') !== tier) continue; }
    else if (e.type !== type) continue;
    if (faction !== 'shared' && (e._mapFaction || e.faction) !== faction) continue;
    out.push(e);
  }
  return out;
}

/** 选中的全部格子涉及的实体（去重）。 */
export function entitiesOfCells(cellSet, entityContainer) {
  const seen = new Map();
  for (const c of cellSet) for (const e of entitiesOfCell(c, entityContainer)) seen.set(e.id, e);
  return [...seen.values()];
}

/**
 * 三态。has(e) 说"这个实体算不算持有"——技能页传"有没有这个 skillId"，
 * 状态页传"有没有这个名字的状态"，判据由调用方给，组件只管数数。
 */
export function triState(entities, has) {
  if (!entities.length) return { state: 'none', count: 0, hit: 0 };
  let hit = 0;
  for (const e of entities) if (has(e)) hit++;
  return { state: hit === 0 ? 'none' : (hit === entities.length ? 'all' : 'some'), count: entities.length, hit };
}

/** 三态 → 复选框的 class / 属性（实线 / 虚线 / 空）。 */
export function triClass(state) {
  return state === 'all' ? 'gp-chk on' : state === 'some' ? 'gp-chk partial' : 'gp-chk';
}

/**
 * 目标矩阵：一二级菜单（小兵 / 防御塔 / 巨龙），每个阵营列一个全选。
 * @param rows      [{ key, applicable, label }]
 * @param factions  [{ key, label }]
 */
export function matrixHtml(rows, factions, cellSet, idPrefix) {
  // 一级分组：按 applicable 归堆。顺序固定，别用 Object.keys 的偶然顺序。
  const groups = [
    { key: 'minion', label: '⚔ 小兵', test: (r) => r.applicable !== 'tower' && r.applicable !== 'dragon' },
    { key: 'tower', label: '🏯 防御塔', test: (r) => r.applicable === 'tower' },
    { key: 'dragon', label: '🐲 巨龙', test: (r) => r.applicable === 'dragon' },
  ];
  const cell = (rowKey, facKey) => {
    const k = `${rowKey}|${facKey}`;
    return `<td style="text-align:center;"><span class="${cellSet.has(k) ? 'gp-chk on' : 'gp-chk'}"
      data-${idPrefix}cell="${k}"></span></td>`;
  };
  let html = `<table class="gp-matrix"><tr>
      <th style="text-align:left;">目标</th>
      ${factions.map(f => `<th>${f.label}</th>`).join('')}
      <th style="width:1%;"></th>
    </tr>`;
  for (const g of groups) {
    const rs = rows.filter(g.test);
    if (!rs.length) continue;
    // 一级：分组标题 + 折叠 + 该组的整组全选
    html += `<tr class="gp-group"><td colspan="${factions.length + 2}">
        <button class="gp-fold" data-${idPrefix}fold="${g.key}">▾</button>
        <span>${g.label}</span>
        <button class="gp-all" data-${idPrefix}all="${g.key}">全选</button>
      </td></tr>`;
    // 二级：组内各行
    for (const r of rs) {
      html += `<tr class="gp-item" data-${idPrefix}grp="${g.key}">
        <td class="gp-row-label">${r.label}</td>
        ${factions.map(f => cell(r.key, f.key)).join('')}
        <td><button class="gp-all" data-${idPrefix}rowall="${r.key}">全选</button></td>
      </tr>`;
    }
  }
  html += '</table>';
  return html;
}

/** 技能池：按 category 分组的一二级菜单，每项带三态复选框。 */
export function skillPoolHtml(entries, entities, idPrefix) {
  const CAT = [
    { key: 'weapon', label: '🔫 武器（互斥，只能有一件）' },
    { key: 'attackmode', label: '🔋 攻击方式' },
    { key: 'passive', label: '🧩 被动' },
    { key: 'other', label: '📦 其它' },
  ];
  const catOf = (def) => (['weapon', 'attackmode', 'passive'].includes(def.category) ? def.category : 'other');
  let html = '';
  for (const c of CAT) {
    const list = entries.filter(([, def]) => catOf(def) === c.key);
    if (!list.length) continue;
    html += `<div class="gp-pool-group">
      <button class="gp-fold" data-${idPrefix}poolfold="${c.key}">▾</button><span>${c.label}</span></div>`;
    html += `<div class="gp-pool-body" data-${idPrefix}poolgrp="${c.key}">`;
    for (const [id, def] of list) {
      const t = triState(entities, (e) => (e._skillInstances || []).some(i => i.skillId === id));
      html += `<label class="gp-pool-item">
        <span class="${triClass(t.state)}" data-${idPrefix}skill="${id}" data-state="${t.state}"></span>
        <span class="gp-pool-ic">${def.icon || '🔹'}</span>
        <span class="gp-pool-name">${def.name || id}</span>
        <span class="gp-pool-cnt">${t.count ? `${t.hit}/${t.count}` : ''}</span>
      </label>`;
    }
    html += '</div>';
  }
  return html || `<div class="transfer-active-empty">先在上面勾至少一格目标</div>`;
}

/**
 * 武器互斥：装一件武器前，先把该实体身上其它 category==='weapon' 的技能摘掉。
 * 用户定稿："武器类型塔只能选一个，所以新选的武器会覆盖旧的武器。"
 */
export function stripOtherWeapons(entity, keepSkillId, ctx) {
  if (!entity?._skillInstances) return;
  const keep = SkillLibrary[keepSkillId];
  if (!keep || keep.category !== 'weapon') return;
  for (const inst of [...entity._skillInstances]) {
    if (inst.skillId === keepSkillId) continue;
    const def = SkillLibrary[inst.skillId];
    if (!def || def.category !== 'weapon') continue;
    if (def.onUnequip) def.onUnequip(entity.id, inst, ctx);
    entity._skillInstances = entity._skillInstances.filter(x => x !== inst);
  }
}
