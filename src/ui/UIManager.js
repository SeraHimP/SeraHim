import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { resolveMergedIds } from '../core/skills/_helpers.js';
import { AttributeEditor } from './AttributeEditor.js';
import * as WEATHER_DEFS from '../data/Weather.js';
import { DetailModal, STAT_LABELS } from './DetailModal.js';

export class UIManager {
  constructor(entityContainer, effectRegistry, attrCalc) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.attrCalc = attrCalc;
    // 常驻双侧卡片列表已移除（每帧 O(单位数) DOM 读写是主线程头号杀手之一）。
    // LoL 式点选：CanvasController 点击命中单位 → selectEntity → 左上角面板单卡实时刷新。
    this.selPanel = document.getElementById('selectionPanel');
    this.selCard = document.getElementById('selectionCard');
    this.selTitle = document.getElementById('selectionTitle');
    this.logArea = document.getElementById('logArea');
    this.selectedId = null;
    this._selCardEl = null;
    this._txtCache = {}; // 顶栏文本脏检查缓存：值没变就不碰 DOM
    this.bindCardEvents();
    // v33（Q11）：✕ 关闭按钮已移除——点击画布空白处取消选中（CanvasController 负责）
    this.selBadge = document.getElementById('selectionBadge');
    this.selActions = document.getElementById('selectionActions');
  }

  bindCardEvents() {
    // 选中卡片事件（原塔/小兵两个列表的委托合并到这一个容器上，按钮行为原样保留）
    this.selPanel.addEventListener('click', (e) => {
      // 按钮事件
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id);
        if (isNaN(id)) return;
        if (action === 'towerDelete') { this._deleteEntity(id); this.clearSelection(); }
        else if (action === 'towerDetail') { DetailModal.showTowerDetail(id, this.entities, this.effects, this.attrCalc); }
        else if (action === 'towerEdit') { AttributeEditor.openEntityEditor(id, this.entities, this.effects, this.attrCalc, this.log.bind(this)); }
        else if (action === 'minionKill') { this._killMinion(id); this.clearSelection(); }
        else if (action === 'minionDetail') { DetailModal.showMinionDetail(id, this.entities, this.effects, this.attrCalc); }
        else if (action === 'minionEdit') { AttributeEditor.openEntityEditor(id, this.entities, this.effects, this.attrCalc, this.log.bind(this)); }
        else if (action === 'toggleAttrs') { this._toggleAttrs(e.target.closest('.unit-card')); }
      }
      // 技能图标点击（修复：使用 closest 正确捕获）
      const skillSlot = e.target.closest('.skill-slot');
      if (skillSlot) {
        const skillId = parseInt(skillSlot.dataset.skillId, 10);
        if (!isNaN(skillId)) {
          const unitId = parseInt(skillSlot.closest('.unit-card').dataset.id, 10);
          if (!isNaN(unitId)) {
            const unit = this.entities.get(unitId);
            if (unit) {
              const inst = unit._skillInstances?.find(s => s.id === skillId);
              if (inst) {
                const def = SkillLibrary[inst.skillId];
                if (def) {
                  DetailModal.showSkillDetail(def, inst, unit, { entityContainer: this.entities, effectRegistry: this.effects, attrCalc: this.attrCalc });
                  e.stopPropagation();
                }
              }
            }
          }
        }
      }
      // 效果图标点击：按效果名聚合展示该技能的所有属性修正
      const effIcon = e.target.closest('.effect-icon');
      if (effIcon) {
        const effName = effIcon.dataset.effectName;
        const unitCard = effIcon.closest('.unit-card');
        if (effName && unitCard) {
          const unitId = parseInt(unitCard.dataset.id, 10);
          const unit = this.entities.get(unitId);
          if (unit) {
            const group = this.effects.getEffects(unitId).filter(x => x.blueprint.name === effName);
            if (group.length) { DetailModal.showEffectGroup(effName, group); e.stopPropagation(); }
          }
        }
      }
    });

    // （小兵卡片监听器已并入上方选中卡监听器）

  }

  _toggleAttrs(card) {
    if (!card) return;
    const attrsExt = card.querySelector('.attrs-ext');
    const toggleBtn = card.querySelector('[data-action="toggleAttrs"]');
    if (!attrsExt || !toggleBtn) return;
    const isOpen = attrsExt.classList.contains('open');
    if (isOpen) {
      attrsExt.classList.remove('open');
      toggleBtn.textContent = '▼ 展开更多';
    } else {
      attrsExt.classList.add('open');
      toggleBtn.textContent = '▲ 收起';
    }
  }

  // 技能栏：只有当装备的技能实例集合发生变化时才重建 DOM，
  // 避免每帧（60次/秒）无条件 innerHTML 重建导致技能图标在点击瞬间被替换。
  _updateSkillSlots(container, instances) {
    if (!container) return;
    // v37（Q1 定稿）：技能栏回归【平铺】。身份技能（core_tier_*）声明 mergedSkills——
    // 加固城防与塔成长的文案已合并进身份技能描述，对应实例仍真实装配生效
    //（节点封顶/成长/状态栏效果照常），但技能栏不再为它们单独出格。
    // 其余被动（钢铁防线/镀层/钢铁烈阳护盾/绝望反击/过载/武器）保持独立技能格。
    // 隐藏集合必须按【这座塔真的装了什么】算，不能照 def.mergedSkills 那份写死的清单：
    // 嚎哭深渊用 passive_growth_ha 换掉了 passive_growth_outer，照写死的算会让替身
    // 既被合并进身份技能的文案、又单独占一格（重复展示）。见 _helpers.resolveMergedIds。
    const pseudo = { _skillInstances: instances };
    const merged = new Set();
    for (const inst of instances) {
      const def = SkillLibrary[inst.skillId];
      if (def?.mergedSkills) for (const k of resolveMergedIds(def, pseudo)) merged.add(k);
    }
    const visible = instances.filter(i => !merged.has(i.skillId));
    const sig = visible.map(i => i.id + (i._disabled ? 'd' : '')).join(',');
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;
    if (visible.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = visible.map(inst => {
      const def = SkillLibrary[inst.skillId];
      if (!def) return '';
      const disabled = inst._disabled ? ' disabled' : '';
      const dtitle = inst._disabled ? '（不兼容特殊攻击方式武器，已禁用）' : '';
      return `<div class="skill-slot has-skill${disabled}" data-skill-id="${inst.id}" title="${def.name}${dtitle}" style="border-color:${def.color || '#5b9bd5'};">
        <span style="font-size:16px;">${def.icon || '🔹'}</span>
      </div>`;
    }).join('');
  }

  // 效果栏：效果集合不变时只更新倒计时环/提示文字，不重建 DOM 节点，
  // 保证点击目标在动画帧之间保持稳定。
  /**
   * 天气影响行（选中单位的属性面板）。
   *
   * 天气不进 EffectRegistry（全局连续场，每帧给上千单位 apply 既慢又会让进度环闪烁），
   * 所以效果栏里看不到它——这一行就是它的展示位。
   *
   * 关键：必须【按选中单位实时计算】。不同单位吃的修正完全不同——
   * 同样是雨天，闪电杖塔拿 +25 法穿、普通塔只有 +15、小兵反而掉 60% 吸血。
   * 所以这里调 getModifiers(该单位)，而不是显示一张全局表。
   *
   * 样式与效果栏(.effect-row)统一：同款 34px 图标格 + 角标，一种天气一个格，
   * 角标显示该天气当前占比；hover 显示它对本单位的具体修正。
   */
  /**
   * 天气影响行（Q2 重做）：三角形图标 + 3 格进度，样式对齐技能/状态栏。
   *
   * 关键设计：
   *   · 三角形代表天气，【边上】有 3 格进度（不是填充三角形内部）：
   *     轻微=0格 / 有限=1格 / 中等=2格 / 严重=3格。
   *   · 不再常驻显示数值修正 —— 点击图标弹窗查看（像技能那样）。
   *   · 【只在档位变化时才重建 DOM】。用户提醒过："之前模仿效果系统做的时候，
   *     鼠标移上去一直在刷新，可能导致无法点击"——根因就是每帧重建 innerHTML，
   *     把正在 hover/点击的元素换掉了。现在脏检查的 key 只含档位，
   *     档位不变就完全不碰 DOM，hover 和点击都稳定。
   */
  /**
   * 世界影响行（昼夜 / 熵 / 龙魂）。
   *
   * 用户："我目前看不出来熵对世界有啥影响，在单位属性栏里也加上熵修正的描述"。
   * 熵和天气一样【不进 EffectRegistry】（全局连续场），所以效果栏里看不到它，
   * 必须有自己的展示位 —— 否则一个悄悄改属性的机制对玩家完全不可见。
   *
   * 视觉语言与上面的天气行【完全一致】（同款 34px 三角格 + 边框点亮 + 图标 + 悬停明细）：
   * 天气与熵都属于"世界给这个单位的修正"，同一类信息用两种控件表达，用户得学两遍。
   * 差别只在颜色语义：蓝=秩序侧（蓝方）受益 / 红=混乱侧（红方）受益 / 灰=无修正。
   *
   * 数据来源是 WorldState.getBreakdown(entity)【按选中单位实时计算】——
   * 同一时刻蓝红两方拿到的修正是反的，显示一张全局表就会有一半人看到错的。
   */
  _updateWorldRow(card, entity) {
    const box = card?.querySelector?.('.world-row');
    if (!box || !entity) return;
    const ws = window.CTX?.__world;
    const rows = (ws && ws.enabled) ? ws.getBreakdown(entity) : [];
    if (!rows.length) {
      if (box.dataset.on !== '0') { box.dataset.on = '0'; box.innerHTML = ''; box.style.display = 'none'; }
      return;
    }
    box.style.display = '';
    box.dataset.on = '1';

    // 节流 0.5s + 脏检查：与天气行同款。用户提醒过每帧重建 innerHTML 会把正在
    // hover/点击的元素换掉，导致"鼠标移上去一直在刷新、点不动"。
    const nowMs = performance.now();
    if (box._nextAt && nowMs < box._nextAt) return;
    box._nextAt = nowMs + 500;

    const key = rows.map(r => r.source + '|' + r.detail).join('#');
    if (box.dataset.key === key) return;
    box.dataset.key = key;

    const fac = entity._mapFaction || entity.faction;
    const ICONS = { 昼夜: '🕓', 熵: '🌀', 龙魂: '🐉' };
    box.innerHTML = rows.map(r => {
      const head = r.source.replace(/[ ·].*$/, '').slice(0, 2);
      const icon = ICONS[head] || (r.source.startsWith('熵') ? '🌀' : '🌍');
      // 边框点亮格数 = 这条修正的强弱（0~3）。熵按偏离中性的程度，其余给满。
      let lit = 3, cls = '';
      if (r.source.startsWith('熵')) {
        const v = ws.entropy?.value ?? 0.5;
        const dev = Math.abs(v - 0.5) * 2;                 // 0（中性）~ 1（推满）
        lit = dev < 0.02 ? 0 : (dev < 0.4 ? 1 : (dev < 0.75 ? 2 : 3));
        // 本方是受益还是受罚：高熵利红、低熵利蓝
        const favored = v > 0.5 ? 'red' : (v < 0.5 ? 'blue' : null);
        if (favored && fac) cls = (fac === favored) ? ' wx-chaos' : ' wx-order';
      }
      const col = r.source.startsWith('熵')
        ? ((ws.entropy?.value ?? 0.5) > 0.5 ? '#e0473f' : '#5b9bd5')
        : '#8ab4f8';
      const EDGES = ['M17,3 L32,27', 'M32,27 L2,27', 'M2,27 L17,3'];
      const edgeHtml = EDGES.map((d, i) =>
        `<path d="${d}" fill="none" stroke="${i < lit ? col : 'rgba(255,255,255,0.14)'}"
           stroke-width="${i < lit ? 2.2 : 1.2}" stroke-linecap="round"/>`).join('');
      // title 里放完整明细：三核构成 + 本方最终加成，"为什么我的属性变了"当场能答
      const tip = `${r.source} — ${r.detail}`.replace(/"/g, '&quot;');
      return `
        <div class="wx-tri${cls}" title="${tip}">
          <svg viewBox="0 0 34 30" class="wx-tri-svg">
            <polygon points="17,3 32,27 2,27" fill="${col}22" stroke="none"/>
            ${edgeHtml}
          </svg>
          <span class="wx-tri-ic">${icon}</span>
        </div>`;
    }).join('');
  }

  _updateWeatherRow(card, entity) {
    const box = card?.querySelector?.('.weather-row');
    if (!box || !entity) return;
    const ws = window.__weather;
    if (!ws || !ws.enabled) {
      if (box.dataset.on !== '0') { box.dataset.on = '0'; box.innerHTML = ''; box.style.display = 'none'; }
      return;
    }
    box.style.display = '';
    box.dataset.on = '1';

    // 节流 0.5s：不是为了性能（getModifiers 单次仅 6.6μs），而是可读性——
    // 天气充能连续变化，不节流的话档位边界附近会反复抖动。
    const nowMs = performance.now();
    if (box._nextAt && nowMs < box._nextAt) return;
    box._nextAt = nowMs + 500;

    const rows = ws.getModifierBreakdown(entity);

    // 脏检查只看【档位】——档位不变就不碰 DOM（防止 hover/点击被打断）
    const key = rows.map(r => r.def.id + ':' + r.tier.id).join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;

    if (!rows.length) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML = rows.map(r => {
      const lit = r.tier.pips;    // 点亮边数：轻微0 / 有限1 / 中等2 / 严重(及极端)3
      const col = r.def.color;
      // v33（Q2）：档位 = 外边框分段点亮，逆时针 右→底→左。
      // 三角顶点：(17,3) 顶 / (32,27) 右下 / (2,27) 左下。
      //   边1（右）：顶 → 右下；边2（底）：右下 → 左下；边3（左）：左下 → 顶。
      // 未点亮的边用暗色描出轮廓；第 5 档"极端"靠重辉光区分（tier-extreme class）。
      const EDGES = [
        'M17,3 L32,27',   // 右
        'M32,27 L2,27',   // 底
        'M2,27 L17,3',    // 左
      ];
      const edgeHtml = EDGES.map((d, i) =>
        `<path d="${d}" fill="none" stroke="${i < lit ? col : 'rgba(255,255,255,0.14)'}"
           stroke-width="${i < lit ? 2.2 : 1.2}" stroke-linecap="round"/>`).join('');
      const tierExtreme = r.tier.isExtremeTier ? ' tier-extreme' : '';
      return `
        <div class="wx-tri${r.extreme ? ' extreme' : ''}${tierExtreme}"
             data-wxid="${r.def.id}"
             title="${r.def.name} · ${r.tier.name}">
          <svg viewBox="0 0 34 30" class="wx-tri-svg">
            <polygon points="17,3 32,27 2,27" fill="${col}22" stroke="none"/>
            ${edgeHtml}
          </svg>
          <span class="wx-tri-ic">${r.def.icon}</span>
        </div>`;
    }).join('');

    // 点击弹窗（像技能那样）——绑定一次，不随每帧重建
    box.querySelectorAll('[data-wxid]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.wxid;
        const row = ws.getModifierBreakdown(entity).find(r => r.def.id === id);
        if (row) this._showWeatherDetail(row);
      });
    });
  }

  /** 天气详情弹窗（点击三角形图标后显示） */
  _showWeatherDetail(row) {
    const { def, tier, charge, mods, extreme } = row;
    const old = document.getElementById('wxDetailOverlay');
    if (old) old.remove();

    const effLines = Object.entries(mods).map(([k, m]) => {
      const label = STAT_LABELS[k] || k;
      const parts = [];
      if (m.flat) {
        const v = Math.abs(m.flat) < 10 ? m.flat.toFixed(1) : Math.round(m.flat);
        parts.push((m.flat > 0 ? '+' : '') + v);
      }
      if (m.percent) parts.push((m.percent > 0 ? '+' : '') + m.percent.toFixed(1) + '%');
      return `<div class="a"><label>${label}</label><span>${parts.join(' ')}</span></div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'wxDetailOverlay';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div class="modal-header">
          <h3><span style="color:${def.color};">${def.icon} ${def.name}</span>
            ${extreme ? '<span style="font-size:11px;color:#ffd75e;margin-left:6px;">极端天气</span>' : ''}</h3>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:11px;color:var(--text-dim);line-height:1.7;margin:0 0 10px;">${def.desc}</p>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;
            padding:7px 9px;background:rgba(255,255,255,0.04);border-radius:6px;
            ${tier.isExtremeTier ? 'box-shadow:0 0 10px rgba(255,215,94,0.55);border:1px solid rgba(255,215,94,0.5);' : ''}">
            <span style="font-size:12px;font-weight:600;color:${tier.isExtremeTier ? '#ffd75e' : def.color};">${tier.name}</span>
            <span style="flex:1;display:flex;gap:3px;">
              ${[0, 1, 2].map(i => `<span style="flex:1;height:4px;border-radius:2px;
                background:${i < tier.pips ? def.color : 'rgba(255,255,255,0.10)'};"></span>`).join('')}
            </span>
            <span style="font-size:10px;color:var(--text-dim);">强度 ${Math.round(tier.scale * 100)}%</span>
          </div>
          <div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">对该单位的影响</div>
          <div class="attrs" style="display:grid;">${effLines}</div>
          <p style="font-size:10px;color:var(--text-mute,#6b7480);line-height:1.6;margin:10px 0 0;">
            天气影响按【充能条】积累：天气越剧烈，充能越快；档位（轻微25%/有限50%/中等75%/严重100%，
            极端天气充能≥88%时进入第5档【极端150%】）决定效果强度。天气回落后影响会缓慢消散，而非立即消失。
          </p>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  /** 该天气的效果表里是否有条目命中此单位 */
  _weatherAffects(def, entity) {
    if (!entity || !def?.effects) return false; // 防御：调用方传错参时不要整个游戏循环崩掉
    for (const eff of def.effects) {
      const m = WEATHER_DEFS.TARGET_MATCHERS[eff.targets];
      if (m && m(entity)) return true;
    }
    return false;
  }

  _updateEffectIcons(container, effs) {
    if (!container) return;
    const grouped = new Map();
    for (const e of effs) {
      // 按效果名聚合：同一技能的所有属性修正合并成一个图标（Q1）。
      // 特殊效果（DOT/眩晕等独立命名的）自然各自成组。
      const key = e.blueprint.name;
      if (grouped.has(key)) {
        const g = grouped.get(key);
        g._members.push(e);
        g.remainingTime = Math.max(g.remainingTime, e.remainingTime);
        g.permanent = g.permanent || e.permanent || e.blueprint.duration <= 0;
        // 层数取组内最大（叠层效果）
        if (e.blueprint.stackable && e.stacks > g.stacks) g.stacks = e.stacks;
      } else {
        grouped.set(key, { ...e, _members: [e], _stackable: !!e.blueprint.stackable });
      }
    }
    for (const g of grouped.values()) {
      g._stackable = g._members.some(m => m.blueprint.stackable);
      g._alwaysShowStacks = g._members.some(m => m.blueprint.alwaysShowStacks); // Q2：塔成长层数从第1层就显示
    }
    const merged = Array.from(grouped.values());

    // 性能关键：不再用 querySelectorAll/querySelector 每帧重新查找 DOM，
    // 而是用 container._iconMap（Map<效果名, {el, ring, badge}>）直接持有引用。
    // 之前的写法是"每帧、每个单位、每个效果"都做 DOM 查询，这是真实卡顿的根因——
    // 之前所有性能压测都在 Node 环境跑纯逻辑系统，从未测过真实 DOM 查询的开销，
    // 导致这个问题一直没被发现（单位数量少也会卡，因为查询次数是"单位数×效果数"，
    // 不是"单位数的平方"，但 querySelector 本身的常数开销在浏览器里不可忽略）。
    if (!container._iconMap) container._iconMap = new Map();
    const iconMap = container._iconMap;
    const seen = new Set();

    for (const e of merged) {
      const name = e.blueprint.name;
      seen.add(name);
      const isDebuff = e.blueprint.type === 'debuff';
      const stackText = ((e._alwaysShowStacks && e.stacks >= 1) || (e._stackable && e.stacks > 1)) ? String(e.stacks) : '';

      let entry = iconMap.get(name);
      if (!entry) {
        // 新建图标（唯一需要用到 DOM 查询/创建的地方，且只在效果第一次出现时发生一次）
        const el = document.createElement('div');
        el.className = 'effect-icon' + (isDebuff ? ' debuff' : '');
        el.dataset.effectName = name;
        el.innerHTML = `<span class="effect-icon-glyph">${e.blueprint.icon || '🔹'}</span><div class="effect-cd-ring"></div>`;
        const ring = el.querySelector('.effect-cd-ring');
        container.appendChild(el);
        entry = { el, ring, badge: null, lastBg: null, lastBadgeText: null };
        iconMap.set(name, entry);
      }

      // 层数徽标：仅在需要时创建/移除，避免常驻空节点
      if (stackText) {
        if (!entry.badge) {
          entry.badge = document.createElement('span');
          entry.badge.className = 'effect-badge-value';
          entry.el.appendChild(entry.badge);
        }
        if (entry.lastBadgeText !== stackText) {
          entry.badge.textContent = stackText;
          entry.lastBadgeText = stackText;
        }
      } else if (entry.badge) {
        entry.badge.remove();
        entry.badge = null;
        entry.lastBadgeText = null;
      }

      // 倒计时环：直接用缓存的引用更新，不查 DOM
      let bg;
      if (e.permanent || e.remainingTime === Infinity || e.blueprint.duration <= 0) {
        bg = 'none';
      } else {
        const elapsedFrac = Math.max(0, Math.min(1, 1 - (e.remainingTime / e.blueprint.duration)));
        const deg = Math.round(elapsedFrac * 360);
        bg = `conic-gradient(rgba(0,0,0,0.72) ${deg}deg, transparent ${deg}deg 360deg)`;
      }
      if (entry.lastBg !== bg) {
        entry.ring.style.background = bg;
        entry.lastBg = bg;
      }
    }

    // 移除已经消失的效果图标
    for (const [name, entry] of iconMap) {
      if (!seen.has(name)) {
        entry.el.remove();
        iconMap.delete(name);
      }
    }
  }

  // 根据阵营切换血条颜色 class：blue → faction-blue（蓝），red → faction-red（红），
  // 沙盒模式（无阵营）不加任何 class，用 CSS 默认色（塔默认蓝、小兵默认绿）。
  // 这里取代了之前"血量低于30%变红"的逻辑——2D画布和卡片UI都用这一套阵营配色，保持统一。
  _applyFactionHpClass(hpBarEl, entity) {
    const faction = entity._mapFaction || entity.faction;
    hpBarEl.classList.remove('faction-blue', 'faction-red', 'low');
    if (faction === 'blue') hpBarEl.classList.add('faction-blue');
    else if (faction === 'red') hpBarEl.classList.add('faction-red');
  }

  _deleteEntity(id) {
    const entity = this.entities.get(id);
    if (entity && confirm(`确定删除 #${id} 吗？`)) {
      entity.alive = false;
      this.entities.purgeDead();
      this.log(`🗑️ 删除 #${id}`, 'death');
    }
  }

  _killMinion(id) {
    const minion = this.entities.get(id);
    if (minion) {
      minion.alive = false;
      this.entities.purgeDead();
      this.log(`✕ 手动击杀小兵 #${id}`, 'death');
    }
  }

  update() {
    // 每帧 DOM 工作量从 O(单位数) 降为 O(1)：顶栏（带脏检查）+ 至多一张选中卡片。
    this.updateTopBar();
    this.updateSelection();
  }

  // ==================== 点选面板（替代常驻列表） ====================
  /**
   * 能否被选中。**唯一判据** —— selectEntity / updateSelection 都读它，
   * 且与 CanvasController._handleSelectClick 的命中条件保持同一口径
   * （`e.alive || e._ruin || e._respawnAt`）。三处各写一份就会出现
   * "点得中但打不开""打开了下一帧又消失"这类无声故障。
   */
  _selectable(e) {
    return !!(e && (e.alive || e._ruin || e._respawnAt));
  }

  selectEntity(id) {
    const e = this.entities.get(id);
    // 可选中的三种"非存活"实体：重生中的水晶尸体、塔废墟、待重生的任何东西。
    // 这里原来只放行 _respawnAt，于是**塔废墟点了没反应** ——
    // CanvasController 的命中检测早就放行了 _ruin，命中也算出来了，是这一句把它拦掉的。
    // 症状是"点了完全没动静"，最难查的那种：两处判断口径不一致，谁都没报错。
    if (!e || !this._selectable(e)) return;
    this.selectedId = id;
    this.selCard.innerHTML = '';
    const card = e.type === 'tower' ? this.createTowerCard(e) : this.createMinionCard(e);
    this.selCard.appendChild(card);
    this._selCardEl = card;
    const tierLabels = { outer: '外塔', inner: '内塔', base: '高地塔', nexus_lane: '召唤水晶', hq_tower: '枢纽塔', nexus_main: '水晶枢纽' };
    // v33（Q11）：标题只留 #id 单位名（左）；【蓝方·高地塔】徽标移到右侧；
    // 编辑/删除简化为纯图标按钮放右上角。
    this.selTitle.textContent = e.type === 'tower'
      ? `🏰 #${e.id} 防御塔`
      : `${e.baseStats?.label || e.type} #${e.id}`;
    if (this.selBadge) {
      const fac = e._mapFaction;
      this.selBadge.innerHTML = fac
        ? `<span class="type-tag" style="background:${fac === 'blue' ? 'rgba(74,158,255,0.18);color:#4a9eff' : 'rgba(255,90,90,0.18);color:#ff5a5a'};">${fac === 'blue' ? '🔵 蓝方' : '🔴 红方'}${e.type === 'tower' && e._mapTier ? ' · ' + (tierLabels[e._mapTier] || e._mapTier) : ''}</span>`
        : '';
    }
    if (this.selActions) {
      this.selActions.innerHTML = e.type === 'tower'
        ? `<button data-action="towerEdit" data-id="${e.id}" title="编辑">✏️</button>
           <button data-action="towerDelete" data-id="${e.id}" title="删除">🗑</button>`
        : `<button data-action="minionEdit" data-id="${e.id}" title="编辑">✏️</button>
           <button data-action="minionKill" data-id="${e.id}" title="击杀">✕</button>`;
    }
    this.selPanel.classList.add('show');
    if (window.__app?.renderer) window.__app.renderer.selectedId = id;
  }

  clearSelection() {
    this.selectedId = null;
    this._selCardEl = null;
    this.selCard.innerHTML = '';
    this.selPanel.classList.remove('show');
    if (window.__app?.renderer) window.__app.renderer.selectedId = null;
  }

  updateSelection() {
    if (this.selectedId === null) return;
    const e = this.entities.get(this.selectedId);
    // 与 selectEntity 同一个判据。只改上面那处的话，废墟能点开、但下一帧就被这里清掉。
    if (!e || !this._selectable(e)) {
      this.log(`选中单位 #${this.selectedId} 已阵亡/移除`);
      this.clearSelection();
      return;
    }
    if (!this._selCardEl) return;
    if (e.type === 'tower') this.updateTowerCard(this._selCardEl, e);
    else this.updateMinionCard(this._selCardEl, e);
  }

  // 顶栏文本脏检查：textContent 赋值即使同值也会触发样式脏标记，攒起来很可观
  _setText(id, v) {
    if (this._txtCache[id] === v) return;
    this._txtCache[id] = v;
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // ==================== 塔卡片（单卡构建/更新，供点选面板复用） ====================
  createTowerCard(tower) {
    const card = document.createElement('div');
    card.className = 'unit-card tower-card';
    card.dataset.id = tower.id;
    // v33（Q11）：右上角"普通塔"卡片与阵营徽标已移除/上移到面板头部——卡片头只留血条以上内容
    card.innerHTML = `
      <div class="bar-row">
        <div class="bar-track tower-bar" id="tower-bar-${tower.id}">
          <div class="bar-hp-trail" id="tower-trail-${tower.id}"></div>
          <div class="bar-hp" id="tower-hp-${tower.id}"></div>
          <div class="bar-shield-fixed" id="tower-sf-${tower.id}"></div>
          <div class="bar-shield-temp" id="tower-st-${tower.id}"></div>
        </div>
      </div>
      <div class="bar-text">
        <span id="tower-hptext-${tower.id}"></span>
        <span class="shield-total" id="tower-shieldtext-${tower.id}"></span>
      </div>
      <div class="attrs" id="tower-attrs-${tower.id}"></div>
      <div class="attrs-ext" id="tower-attrs-ext-${tower.id}"></div>
      <button class="toggle-ext" data-action="toggleAttrs" data-id="${tower.id}">▼ 展开更多</button>
      <div class="skill-slot-row" id="tower-skills-${tower.id}"></div>
      <div class="effect-row" id="tower-effects-${tower.id}"></div>
      <div class="weather-row" id="tower-weather-${tower.id}"></div>
      <div class="world-row" id="tower-world-${tower.id}"></div>
    `;
    // v33（Q11）：底部"编辑/删除"按钮行已删除——图标化后移至面板右上角（selectionActions）
    return card;
  }

  updateTowerCard(card, tower) {
    const id = tower.id;
    const stats = this.attrCalc.calc(tower, this.effects.getEffects(id));
    const maxHP = stats.maxHP || 1;
    const hpFrac = Math.max(0, Math.min(1, tower.currentHP / maxHP));

    // 拖尾（血条宽度由下方比例逻辑统一设置）——用真实时间差插值，不受 UI 刷新频率影响
    const nowTs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const trailBar = card.querySelector(`#tower-trail-${id}`);
    if (trailBar) {
      if (trailBar._frac === undefined) { trailBar._frac = hpFrac; trailBar._lastTs = nowTs; }
      const dtSec = Math.min(0.5, (nowTs - (trailBar._lastTs || nowTs)) / 1000);
      trailBar._lastTs = nowTs;
      if (hpFrac < trailBar._frac) {
        const rate = 1 - Math.pow(0.05, dtSec); // 时间越长追得越多，帧率无关
        trailBar._frac += (hpFrac - trailBar._frac) * rate;
      } else {
        trailBar._frac = hpFrac;
      }
      trailBar.style.width = (Math.max(0, Math.min(1, trailBar._frac)) * 100) + '%';
    }

    const sfCur = tower.shieldFixedCurrent || 0, stCur = tower.tempShield || 0;
    const shieldTotal = sfCur + stCur;
    // 与 2D 画板一致的比例逻辑：HP+护盾同条，总和超过最大值时整体按比例压缩
    const sfFracRaw = sfCur / maxHP, stFracRaw = stCur / maxHP;
    let hpDraw = hpFrac, sfDraw = sfFracRaw, stDraw = stFracRaw;
    const totalFrac = hpFrac + sfFracRaw + stFracRaw;
    if (totalFrac > 1) {
      const scale = 1 / totalFrac;
      hpDraw *= scale; sfDraw *= scale; stDraw *= scale;
    }
    const hpBar2 = card.querySelector(`#tower-hp-${id}`);
    if (hpBar2) {
      hpBar2.style.width = (hpDraw * 100) + '%';
      this._applyFactionHpClass(hpBar2, tower);
    }
    const sfBar = card.querySelector(`#tower-sf-${id}`);
    if (sfBar) { sfBar.style.left = (hpDraw * 100) + '%'; sfBar.style.width = (sfDraw * 100) + '%'; }
    const stBar = card.querySelector(`#tower-st-${id}`);
    if (stBar) { stBar.style.left = ((hpDraw + sfDraw) * 100) + '%'; stBar.style.width = (stDraw * 100) + '%'; }

    const hpText = card.querySelector(`#tower-hptext-${id}`);
    if (hpText) hpText.textContent = `HP ${Math.round(tower.currentHP)}/${Math.round(maxHP)}`;

    // v33（Q16）：装备"防御塔镀层"的塔，属性条上用 | 标出下一个镀层节点（与画布血条一致）
    const barTrack = card.querySelector(`#tower-bar-${id}`);
    if (barTrack) {
      const platingInst = (tower._skillInstances || []).find(i => i.skillId === 'passive_armor_plating');
      let node = null;
      if (platingInst) {
        const broken = platingInst.state?.broken || [false, false, false, false];
        for (const [i, th] of [0.8, 0.6, 0.4, 0.2].entries()) { if (!broken[i]) { node = th; break; } }
      }
      let tick = barTrack.querySelector('.plating-tick');
      if (node !== null) {
        if (!tick) {
          tick = document.createElement('div');
          tick.className = 'plating-tick';
          tick.style.cssText = 'position:absolute;top:-2px;bottom:-2px;width:2px;background:#fff;box-shadow:0 0 3px rgba(0,0,0,0.8);pointer-events:none;';
          barTrack.style.position = 'relative';
          barTrack.appendChild(tick);
        }
        tick.style.left = (node * 100) + '%';
      } else if (tick) {
        tick.remove();
      }
    }
    const shieldText = card.querySelector(`#tower-shieldtext-${id}`);
    if (shieldText) shieldText.textContent = `🛡 ${Math.round(shieldTotal)}`;

    // 核心属性
    const attrsContainer = card.querySelector(`#tower-attrs-${id}`);
    if (attrsContainer) {
      attrsContainer.innerHTML = `
        <div class="a"><label>攻击力</label><span>${Math.round(stats.attackDamage)}</span></div>
        <div class="a"><label>攻速</label><span>${this.attrCalc.calcAttackSpeedOf(stats).toFixed(2)}</span></div>
        <div class="a"><label>护甲</label><span>${Math.round(stats.armor)}</span></div>
        <div class="a"><label>魔抗</label><span>${Math.round(stats.magicResist)}</span></div>
      `;
    }

    // 扩展属性（默认折叠）
    const attrsExtContainer = card.querySelector(`#tower-attrs-ext-${id}`);
    if (attrsExtContainer) {
      // v33（Q17）：穿透一类一行——固定值在左列、百分比在右列（网格两列，顺序即位置）。
      // 顺带修正旧版的标签张冠李戴（"魔抗削减"标着 magicPenFlat、"固定法穿%"标着百分比）。
      attrsExtContainer.innerHTML = `
        <div class="a"><label>固定穿甲</label><span>${Math.round(stats.armorPenFlat)}</span></div>
        <div class="a"><label>护甲穿透%</label><span>${Math.round(stats.armorPenPercent)}%</span></div>
        <div class="a"><label>固定法穿</label><span>${Math.round(stats.magicPenFlat)}</span></div>
        <div class="a"><label>法术穿透%</label><span>${Math.round(stats.magicPenPercent)}%</span></div>
        <div class="a"><label>伤害减免</label><span>${Math.round(stats.damageReduction)}%</span></div>
        <div class="a"><label>伤害格挡</label><span>${Math.round(stats.damageBlock)}</span></div>
        <div class="a"><label>伤害转化%</label><span>${Math.round(stats.damageConvertPct)}%</span></div>
        <div class="a"><label>生命偷取%</label><span>${Math.round(stats.lifeStealPct)}%</span></div>
        <div class="a"><label>攻击特效(固定)</label><span>${Math.round(stats.onHitDamage)}</span></div>
        <div class="a"><label>攻击特效(%当前生命)</label><span>${Math.round(stats.onHitPercentDamage)}%</span></div>
        <div class="a"><label>治疗与护盾强度%</label><span>${Math.round(stats.healShieldPowerPct)}%</span></div>
        <div class="a"><label>攻速加成%</label><span>${Math.round(stats.bonusAttackSpeedPct)}%</span></div>
        <div class="a"><label>全属性加成%</label><span>${Math.round(stats.allStatsPct)}%</span></div>
        <div class="a"><label>子弹速度</label><span>${Math.round(stats.bulletSpeed)}</span></div>
      `;
    }

    // 技能栏（diff式渲染，避免每帧重建导致点击失效）
    const skillContainer = card.querySelector(`#tower-skills-${id}`);
    this._updateSkillSlots(skillContainer, tower._skillInstances || []);

    // 效果栏（diff式渲染）
    const effectsContainer = card.querySelector(`#tower-effects-${id}`);
    this._updateEffectIcons(effectsContainer, this.effects.getEffects(id));
    this._updateWeatherRow(card, tower);
    this._updateWorldRow(card, tower);
  }

  // ==================== 小兵卡片 ====================
  createMinionCard(minion) {
    const card = document.createElement('div');
    card.className = 'unit-card minion-card';
    card.dataset.id = minion.id;
    // v33（Q11）：卡片头徽标已上移到面板头部
    card.innerHTML = `
      <div class="bar-row">
        <div class="bar-track" id="minion-bar-${minion.id}">
          <div class="bar-hp-trail" id="minion-trail-${minion.id}"></div>
          <div class="bar-hp" id="minion-hp-${minion.id}"></div>
          <div class="bar-shield-fixed" id="minion-sf-${minion.id}"></div>
          <div class="bar-shield-temp" id="minion-st-${minion.id}"></div>
        </div>
      </div>
      <div class="bar-text">
        <span id="minion-hptext-${minion.id}"></span>
        <span class="shield-total" id="minion-shieldtext-${minion.id}"></span>
      </div>
      <div class="attrs" id="minion-attrs-${minion.id}"></div>
      <div class="attrs-ext" id="minion-attrs-ext-${minion.id}"></div>
      <button class="toggle-ext" data-action="toggleAttrs" data-id="${minion.id}">▼ 展开更多</button>
      <div class="skill-slot-row" id="minion-skills-${minion.id}"></div>
      <div class="effect-row" id="minion-effects-${minion.id}"></div>
      <div class="weather-row" id="minion-weather-${minion.id}"></div>
      <div class="world-row" id="minion-world-${minion.id}"></div>
    `;
    // v33（Q11）：底部按钮行已删除——图标化后移至面板右上角
    return card;
  }

  updateMinionCard(card, minion) {
    const id = minion.id;
    const stats = this.attrCalc.calc(minion, this.effects.getEffects(id));
    const maxHP = stats.maxHP || 1;
    const hpFrac = Math.max(0, Math.min(1, minion.currentHP / maxHP));
    const sfCur = minion.shieldFixedCurrent || 0, stCur = minion.tempShield || 0;
    const shieldTotal = sfCur + stCur;

    const trailBar = card.querySelector(`#minion-trail-${id}`);
    if (trailBar) {
      const nowTs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (trailBar._frac === undefined) { trailBar._frac = hpFrac; trailBar._lastTs = nowTs; }
      const dtSec = Math.min(0.5, (nowTs - (trailBar._lastTs || nowTs)) / 1000);
      trailBar._lastTs = nowTs;
      if (hpFrac < trailBar._frac) {
        const rate = 1 - Math.pow(0.05, dtSec);
        trailBar._frac += (hpFrac - trailBar._frac) * rate;
      } else {
        trailBar._frac = hpFrac;
      }
      trailBar.style.width = (Math.max(0, Math.min(1, trailBar._frac)) * 100) + '%';
    }

    // 与 2D 画板一致：HP+护盾同条，超过最大值整体按比例压缩
    const sfFracRaw = sfCur / maxHP, stFracRaw = stCur / maxHP;
    let hpDraw = hpFrac, sfDraw = sfFracRaw, stDraw = stFracRaw;
    const totalFrac = hpFrac + sfFracRaw + stFracRaw;
    if (totalFrac > 1) {
      const scale = 1 / totalFrac;
      hpDraw *= scale; sfDraw *= scale; stDraw *= scale;
    }
    const hpBar = card.querySelector(`#minion-hp-${id}`);
    if (hpBar) {
      hpBar.style.width = (hpDraw * 100) + '%';
      this._applyFactionHpClass(hpBar, minion);
    }
    const sfBar = card.querySelector(`#minion-sf-${id}`);
    if (sfBar) { sfBar.style.left = (hpDraw * 100) + '%'; sfBar.style.width = (sfDraw * 100) + '%'; }
    const stBar = card.querySelector(`#minion-st-${id}`);
    if (stBar) { stBar.style.left = ((hpDraw + sfDraw) * 100) + '%'; stBar.style.width = (stDraw * 100) + '%'; }

    const hpText = card.querySelector(`#minion-hptext-${id}`);
    if (hpText) hpText.textContent = `HP ${Math.round(minion.currentHP)}/${Math.round(maxHP)}`;
    const shieldText = card.querySelector(`#minion-shieldtext-${id}`);
    if (shieldText) shieldText.textContent = `🛡 ${Math.round(shieldTotal)}`;

    const attrsContainer = card.querySelector(`#minion-attrs-${id}`);
    if (attrsContainer) {
      attrsContainer.innerHTML = `
        <div class="a"><label>攻击力</label><span>${Math.round(stats.attackDamage)}</span></div>
        <div class="a"><label>攻速</label><span>${this.attrCalc.calcAttackSpeedOf(stats).toFixed(2)}</span></div>
        <div class="a"><label>护甲</label><span>${Math.round(stats.armor)}</span></div>
        <div class="a"><label>魔抗</label><span>${Math.round(stats.magicResist)}</span></div>
      `;
    }

    const attrsExtContainer = card.querySelector(`#minion-attrs-ext-${id}`);
    if (attrsExtContainer) {
      // v33（Q17）：与塔卡片同款列布局（固定值左列、百分比右列，一类一行）
      attrsExtContainer.innerHTML = `
        <div class="a"><label>固定穿甲</label><span>${Math.round(stats.armorPenFlat)}</span></div>
        <div class="a"><label>护甲穿透%</label><span>${Math.round(stats.armorPenPercent)}%</span></div>
        <div class="a"><label>固定法穿</label><span>${Math.round(stats.magicPenFlat)}</span></div>
        <div class="a"><label>法术穿透%</label><span>${Math.round(stats.magicPenPercent)}%</span></div>
        <div class="a"><label>伤害减免</label><span>${Math.round(stats.damageReduction)}%</span></div>
        <div class="a"><label>伤害格挡</label><span>${Math.round(stats.damageBlock)}</span></div>
        <div class="a"><label>伤害转化%</label><span>${Math.round(stats.damageConvertPct)}%</span></div>
        <div class="a"><label>生命偷取%</label><span>${Math.round(stats.lifeStealPct)}%</span></div>
        <div class="a"><label>攻击特效(固定)</label><span>${Math.round(stats.onHitDamage)}</span></div>
        <div class="a"><label>攻击特效(%当前生命)</label><span>${Math.round(stats.onHitPercentDamage)}%</span></div>
        <div class="a"><label>治疗与护盾强度%</label><span>${Math.round(stats.healShieldPowerPct)}%</span></div>
        <div class="a"><label>攻速加成%</label><span>${Math.round(stats.bonusAttackSpeedPct)}%</span></div>
        <div class="a"><label>全属性加成%</label><span>${Math.round(stats.allStatsPct)}%</span></div>
        <div class="a"><label>移速</label><span>${Math.round(stats.moveSpeed)}</span></div>
        <div class="a"><label>攻击距离</label><span>${Math.round(stats.attackRange)}</span></div>
      `;
    }

    // 技能栏（diff式渲染）
    const skillContainer = card.querySelector(`#minion-skills-${id}`);
    this._updateSkillSlots(skillContainer, minion._skillInstances || []);

    // 效果栏（diff式渲染）
    const effectsContainer = card.querySelector(`#minion-effects-${id}`);
    this._updateEffectIcons(effectsContainer, this.effects.getEffects(id));
    this._updateWeatherRow(card, minion);
    this._updateWorldRow(card, minion);
  }

  updateTopBar() {
    // 波次显示按当前模式选择数据源：之前永远读 window.waveNumber（沙盒专属全局变量），
    // 对战模式下这个变量不再更新（沙盒的 WaveSystem 被暂停），导致左上角波次显示冻结。
    // 现在对战模式下改读 laneWaveSystem 自己的独立波次计数与倒计时。
    const mapSystem = window.__app?.mapSystem;
    const laneWaveSystem = window.__app?.laneWaveSystem;
    if (mapSystem?.active && laneWaveSystem) {
      this._setText('waveNum', String(laneWaveSystem.waveNumber || 0));
      this._setText('waveTimer', Math.max(0, laneWaveSystem.nextWaveTime || 0).toFixed(1) + 's');
    } else {
      this._setText('waveNum', String(window.waveNumber || 0));
      this._setText('waveTimer', Math.max(0, window._nextWaveTime || 0).toFixed(1) + 's');
    }
    // 单位计数（原属两侧列表更新，列表移除后归口到这里）
    this._setText('towerCount', String(this.entities.getAllTowers(true).length));
    this._setText('minionCount', String(this.entities.getAllMinions(true).length));
    // 对战计分板（击杀/推塔）；沙盒模式显示占位
    const sc = window.__score;
    if (sc) {
      this._setText('scoreBlue', `${sc.blue.kills}/${sc.blue.towers}`);
      this._setText('scoreRed', `${sc.red.kills}/${sc.red.towers}`);
    }

    // 龙魂提示条
    const ds = window.__app?.dragonSystem;
    // Q4：巨龙横幅隐藏（巨龙系统默认暂停、待大改，横幅先不显示；恢复时删掉这个 return 即可）
    { const b = document.getElementById('dragonBanner'); if (b) b.classList.remove('show'); }
    if (true) return;
    const banner = document.getElementById('dragonBanner');
    if (ds && banner) {
      const st = ds.getState();
      const aliveDragons = this.entities.getByType('dragon', true);
      const txt = document.getElementById('dragonBannerText');
      const timer = document.getElementById('dragonBannerTimer');
      if (aliveDragons.length > 0) {
        const d = aliveDragons[0];
        banner.classList.add('show');
        this._setText('dragonBannerText', `${d._dragonIcon || '🐉'} ${d.baseStats?.label || '巨龙'} 出现！集中火力击杀`);
        const maxHP = this.attrCalc.calc(d, this.effects.getEffects(d.id)).maxHP || 1;
        this._setText('dragonBannerTimer', `HP ${Math.round(d.currentHP)}/${Math.round(maxHP)}`);
      } else {
        banner.classList.add('show');
        const label = st.soulUnlocked ? '🐲 远古巨龙' : '🐉 巨龙';
        this._setText('dragonBannerText', st.soulUnlocked
          ? `${label} 即将降临 · 已解锁龙魂`
          : `${label} 即将降临 · 击杀${st.totalKills}/4解锁龙魂`);
        this._setText('dragonBannerTimer', `${Math.max(0, st.nextDragonTime).toFixed(0)}s`);
      }
    }
  }

  log(message, className = '') {
    const entry = document.createElement('div');
    entry.className = 'log-entry' + (className ? ' ' + className : '');
    const time = window.gameTime ? window.gameTime.toFixed(1) : '0.0';
    entry.innerHTML = `<span class="time">[${time}s]</span> ${message}`;
    this.logArea.prepend(entry);
    while (this.logArea.children.length > 200) {
      this.logArea.removeChild(this.logArea.lastChild);
    }
  }
}