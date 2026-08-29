import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { resolveMergedIds } from '../core/skills/_helpers.js';
import { AttributeEditor } from './AttributeEditor.js';
import * as WEATHER_DEFS from '../data/Weather.js';
import { DetailModal, STAT_LABELS } from './DetailModal.js';
import { statDoc } from '../data/statDocs.js';
import { shellHtml } from './dialogShell.js';
import { extAttrGroups, BASE_ATTR_ROWS } from './statPanelLayout.js';
import { resourceInfoOf, RESOURCE_COLORS, HIDDEN_STATUS_EFFECT_NAMES } from '../core/resourceBar.js';
import { stepTrail } from '../presentation/barTrail.js';

export class UIManager {
  constructor(entityContainer, effectRegistry, attrCalc) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.attrCalc = attrCalc;
    // 常驻双侧卡片列表已移除（每帧 O(单位数) DOM 读写是主线程头号杀手之一）。
    // LoL 式点选：CanvasController 点击命中单位 → selectEntity → 左上角面板单卡实时刷新。
    this.selPanel = document.getElementById('selectionPanel');
    this._bindPanelOffset();
    this.selCard = document.getElementById('selectionCard');
    this.selTitle = document.getElementById('selectionTitle');
    this.logArea = document.getElementById('logArea');
    this.selectedId = null;
    this._selCardEl = null;
    this._txtCache = {}; // 顶栏文本脏检查缓存：值没变就不碰 DOM
    this.bindCardEvents();
    // v44：属性行点击 → 说明弹窗。
    // 必须用**事件委托**绑在容器上：属性行是每帧重建 innerHTML 的，
    // 逐行 addEventListener 会在下一帧连同旧节点一起被丢掉（本项目的老坑，
    // 技能栏/效果栏当年就是因此改成 diff 式渲染的）。
    if (this.selCard) {
      this.selCard.addEventListener('click', (e) => {
        const row = e.target.closest?.('.stat-doc[data-stat]');
        if (!row || !this.selCard.contains(row)) return;
        e.stopPropagation();
        this._showStatDoc(row.dataset.stat, this.entities.get(this.selectedId));
      });
    }
    // v33（Q11）：✕ 关闭按钮已移除——点击画布空白处取消选中（CanvasController 负责）
    // v45：selectionBadge 已删（阵营与单位类型合并到 selectionTitle 左上角）。
    this.selActions = document.getElementById('selectionActions');
  }

  /**
   * ==================== v47：属性面板永远贴在左上角那块面板的正下方 ====================
   * 用户："别忘了点开单位属性栏可能出现遮挡的情况。"
   *
   * 左上角那一块的高度**不是常数**：世界状态里的天气段与熵段各自会显隐，
   * 窄窗口下读数那一行还会换行。CSS 里写一个 `top: 104px` 只能挡住我当时想到的那一种情形 ——
   * 熵一开、或者窗口一窄，属性面板就被压在它底下（而且是"平时看不出来"的那种，最难查）。
   *
   * 所以改成**量出来**：ResizeObserver 盯着 #topbarLeft 的实际高度，
   * 高度一变就把属性面板的 top 与 max-height 一起推下去。
   * 这样将来往左上角再加一行东西，也不需要回来改这里的数字。
   *
   * 拿不到 ResizeObserver（老环境/headless）时什么都不做 —— CSS 里的 top 仍在，
   * 退化成改动前的固定值，不会崩。
   */
  _bindPanelOffset() {
    const bar = document.getElementById('topbarLeft');
    if (!this.selPanel || !bar || typeof ResizeObserver === 'undefined') return;
    const GAP = 8;      // 面板与顶栏之间的呼吸位
    const TOP = 10;     // #topbarLeft 自己距屏幕顶的距离（与 CSS 里那份一致）
    const apply = () => {
      const top = TOP + bar.offsetHeight + GAP;
      this.selPanel.style.top = top + 'px';
      this.selPanel.style.maxHeight = `calc(100% - ${top + 12}px)`;
    };
    apply();
    this._panelRO = new ResizeObserver(apply);
    this._panelRO.observe(bar);
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

  /**
   * 属性面板血条的掉血拖尾。
   *
   * 用户："画面中进度条的拖尾特效和属性栏进度条的拖尾特效并不统一，
   *        统一为画面中的拖尾特效。"
   * 缓动与贴齐一律走 barTrail.stepTrail（画面里那条用的就是它），参数不再各写一份。
   * 颜色与 CSS 里那层多余的 transition 也一并对齐了，见 barTrail.js 里的逐项对照表。
   *
   * 贴齐阈值取 1/300：面板里的条约 300px 宽，差不到一个像素就直接贴齐 ——
   * 与画面里取 1/BAR_W 是同一条理由。
   */
  _stepTrailBar(el, hpFrac) {
    if (!el) return;
    const nowTs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (el._frac === undefined) { el._frac = hpFrac; el._lastTs = nowTs; }
    const dt = Math.min(0.05, (nowTs - (el._lastTs || nowTs)) / 1000);
    el._lastTs = nowTs;
    const tr = stepTrail(el._frac, hpFrac, dt, 1 / 300);
    el._frac = tr.disp;
    el.style.width = (Math.max(0, Math.min(1, el._frac)) * 100) + '%';
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
    // v51.2（Q2）："充能攻击这类不要显示，这个应该是和塔武器/小兵类型相绑定的"——
    // 上一版只把它从批量加技能池里排除了，技能栏这里漏了。攻击方式（category:'attackmode'）
    // 本来就不是玩家会主动查看/替换的"技能"，是武器的一个内置属性，这里统一按分类排除，
    // 不用逐个技能 id 写死（以后再加别的攻击方式也自动盖住）。
    const visible = instances.filter(i => !merged.has(i.skillId) && SkillLibrary[i.skillId]?.category !== 'attackmode');
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
    box.innerHTML = rows.map((r, i) => {
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
        <div class="wx-tri${cls}" data-worldidx="${i}" title="${tip}">
          <svg viewBox="0 0 34 30" class="wx-tri-svg">
            <polygon points="17,3 32,27 2,27" fill="${col}22" stroke="none"/>
            ${edgeHtml}
          </svg>
          <span class="wx-tri-ic">${icon}</span>
        </div>`;
    }).join('');

    // 点击弹窗（用户定稿：应该像天气行一样可点，且窗口 UI 与其它详情窗统一，
    // 走同一个 shellHtml 外壳，不是另起一套样式）——绑定一次，不随每帧重建
    box.querySelectorAll('[data-worldidx]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = rows[Number(el.dataset.worldidx)];
        if (row) this._showWorldDetail(row);
      });
    });
  }

  /**
   * 世界效应详情窗（昼夜/熵/龙魂）——点击 .world-row 里的三角图标弹出。
   * 用户定稿："窗口 UI 必须统一"：与 _showWeatherDetail 走同一个 shellHtml 外壳，
   * 只是正文按 WorldState.getBreakdown() 返回的 {source, detail} 简化展示
   * （World 侧目前没有像天气那样逐项 stat 的 mods 明细，只有一句话总结）。
   */
  _showWorldDetail(row) {
    const old = document.getElementById('worldDetailOverlay');
    if (old) old.remove();

    const head = row.source.replace(/[ ·].*$/, '').slice(0, 2);
    const ICONS = { 昼夜: '🕓', 熵: '🌀', 龙魂: '🐉' };
    const icon = ICONS[head] || '🌍';

    const body = `
      <p style="font-size:12px;line-height:1.8;margin:0 0 10px;">${row.detail}</p>
      <p style="font-size:10px;color:var(--text-mute,#6b7480);line-height:1.6;margin:10px 0 0;">
        世界效应随昼夜/熵/龙魂的当前状态实时变化，具体数值取决于本方阵营与当前世界状态——
        点开这个窗口看到的是【当前选中单位】此刻实际吃到的那一份。
      </p>`;

    const overlay = document.createElement('div');
    overlay.id = 'worldDetailOverlay';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = shellHtml({
      title: `${icon} ${row.source}`,
      body, crumb: '', width: '480px',
      footer: '<div class="modal-actions"><button class="wd-detail-close primary">关闭</button></div>',
    });
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.wd-detail-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
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


  /**
   * 属性区写入：**值没变就不碰 DOM**。
   *
   * v44 加这个的直接原因：属性行现在可以点击了，而它原本是每帧无条件
   * `innerHTML = ...` 全量重建的 —— 节点每帧都是新的，
   * 一次点击的 mousedown 与 mouseup 很可能落在两个不同的节点上，点击因此丢失。
   * （自动化测试里表现为 "element was detached from the DOM, retrying"，
   *   真人手上表现为"点了没反应"。）
   *
   * 技能栏与效果栏当年就是为同样的理由改成 diff 式渲染的，这里补上属性栏这一块。
   */
  _setAttrs(el, html) {
    if (!el || el._lastHtml === html) return;
    el._lastHtml = html;
    el.innerHTML = html;
  }

  /**
   * ==================== v44：弹窗统一到 dialogShell ====================
   * 用户："属性栏点击的天气窗口还是旧版本的……属性栏点击出现的窗口 UI 应是统一的。"
   *
   * 这个弹窗此前是自己拼一套 `.modal / .modal-header / .modal-body` ——
   * v43 Q1 把全部弹窗统一到模板编辑器那套外框时**漏了它**（它藏在 UIManager 里，
   * 不在 src/ui/*Dialog.js 那一批里，搜"Dialog"搜不到）。
   * 表现就是用户截图里的样子：标题图标与关闭按钮各占一行、字号与别的窗口对不上。
   * 现在与详情框走同一个 shellHtml，正文一行没动，换的只是外框。
   */
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

    const body = `
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
      </p>`;

    const overlay = document.createElement('div');
    overlay.id = 'wxDetailOverlay';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = shellHtml({
      title: `<span style="color:${def.color};">${def.icon} ${def.name}</span>`
           + (extreme ? '<span style="font-size:11px;color:#ffd75e;margin-left:6px;">极端天气</span>' : ''),
      body, crumb: '', width: '480px',
      footer: '<div class="modal-actions"><button class="wx-detail-close primary">关闭</button></div>',
    });
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.wx-detail-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  /**
   * ==================== v44：属性值的统一显示口径 ====================
   * 用户定稿（原话）："攻击力：182（152+30）。括号里的内容为（原始 + 通过任何渠道
   * 修正的数值和，也可能为负），如果没有修正就不显示括号。如果修正值大于 0，
   * 182 就显示为橙色，无修正就默认颜色，负修正为红色。"
   *
   * 为什么值得单独抽一个函数：面板上十几行属性 + 说明弹窗的抬头，都要按同一套规则显示。
   * 抄两份的话，下次改配色只会改到其中一处 —— 本项目"编辑器写 A、运行时读 B"那类
   * 问题的同一个成因。
   *
   * 口径：**基础值 = entity.baseStats[key]**（模板/地图/覆写解析完的那个），
   * **最终值 = attrCalc.calc() 的结果**（叠了技能/状态/世界修正之后）。
   * 两者之差就是"通过任何渠道修正的数值和" —— 不需要去逐条累加各个来源，
   * 那样反而会与真正的属性管线漂移。
   */
  _statParts(key, entity, stats) {
    const now = stats ? stats[key] : undefined;
    const base = entity && entity.baseStats ? entity.baseStats[key] : undefined;
    if (!Number.isFinite(now)) return null;
    const r = (v) => (Math.abs(v) < 10 ? Math.round(v * 100) / 100 : Math.round(v));
    if (!Number.isFinite(base)) return { now: r(now), base: null, delta: 0, cls: '' };
    const delta = now - base;
    // 浮点噪声：0.005 以内当作"没修正"，否则 40 会显示成 40（40+0）
    const clean = Math.abs(delta) < 0.005 ? 0 : delta;
    return {
      now: r(now), base: r(base), delta: r(clean),
      cls: clean > 0 ? 'stat-up' : clean < 0 ? 'stat-down' : '',
    };
  }

  /** 面板里一行属性的值（带颜色，无括号——括号明细在点开的说明弹窗里）。 */
  _statValueHtml(key, entity, stats, suffix = '') {
    const p = this._statParts(key, entity, stats);
    if (!p) return '';
    return `<span class="${p.cls}">${p.now}${suffix}</span>`;
  }

  /**
   * ==================== v47：攻速这一行为什么要单独算 ====================
   * 用户："攻速加成为负的时候，攻速并没有显示为红色。其他属性显示也可能存在这个bug，自行排查。"
   *
   * 排查结果：面板上**有三个格子根本没走 `_statValueHtml`**，
   * 它们直接把数字塞进模板字符串，因此永远是默认色 —— 不是"负值判错了"，
   * 而是这三格从来就没有着色这回事：
   *   · 攻速（塔卡片 + 兵卡片）    `calcAttackSpeedOf(stats).toFixed(2)`
   *   · 移速（兵卡片）             `Math.round(stats.moveSpeed)`
   *   · 攻击距离（兵卡片）         `Math.round(stats.attackRange)`
   * 后两个改起来只是换成 `_statValueHtml`；攻速不行 ——
   * 面板显示的 0.62 **不是任何一个属性字段**，它是 baseAttackSpeed / bonusAttackSpeedPct /
   * attackSpeedRatio 三者算出来的派生量，`_statParts('bonusAttackSpeedPct')` 拿到的
   * 是 −42 这个加成值，不是 0.62。所以这里按同一口径**重算一次基础攻速**：
   *   基础 = calcAttackSpeedOf(entity.baseStats)，最终 = calcAttackSpeedOf(stats)
   * 差值即"各渠道修正之和"，与其它属性完全同一套语义（正橙 / 负红 / 无修正默认色）。
   *
   * 顺带说明为什么不能图省事直接给 `bonusAttackSpeedPct` 的颜色抄过来：
   * 攻速还会被 allStatsPct 经由 baseAttackSpeed 放大（见 calcAttackSpeedOf 的头注），
   * 那条通路里 bonusAttackSpeedPct 一动不动。抄颜色的话"全属性加成拉满"时
   * 攻速明明涨了却是默认色 —— 又一个"面板与实际不一致"。
   */
  /**
   * ==================== v51：常驻属性区（塔/兵共用同一份，不再各写一遍）====================
   * 用户："属性的显示也需要重排一下，默认显示攻击力，法强，护甲，魔法抗性，攻速，暴击率。"
   * 顺序/字段唯一来源是 statPanelLayout.js 的 BASE_ATTR_ROWS——之前塔卡片和兵卡片
   * 各写了一份四格的模板字符串，这次顺手把它们并成一份，不然改一处又会漏另一处
   * （本仓库的老毛病，扩展属性区那份 _extAttrsHtml 当年就是被这个坑改成了共用）。
   */
  /**
   * ==================== v51：单位属性窗口的资源条 ====================
   * 用户："每个单位新增法力条/能量条/充能条等（为一个，但是类型可能不同）……
   *        显示在单位属性窗口的血条下面。"
   * 再补充："塔/攻城车的话那个条就显示穿透型子弹的升温（1/4）/闪电杖的闪电充能/
   *        攻城车的攻击充能进度。"
   * 所以这不是单纯的"法力条"——是同一个槽位，按单位实际持有的资源类型显示不同东西：
   *   ① 装了 category:'active' 技能 → 显示法力（ManaSystem 驱动）；
   *   ② 没有主动技能、但装了穿透型/闪电杖/充能型攻击方式 → 显示各自的进度；
   *   ③ 都没有 → 整行隐藏（不是"显示恒为0的空条"，那是噪音）。
   * 返回 null = 不显示；否则 { frac, label }。
   */
  _updateResourceBar(card, prefix, id, entity) {
    const row = card.querySelector(`#${prefix}-resrow-${id}`);
    const textEl = card.querySelector(`#${prefix}-restext-${id}`);
    const regenEl = card.querySelector(`#${prefix}-resregen-${id}`);
    if (!row) return;
    const info = resourceInfoOf(entity, { skillLibrary: SkillLibrary, attrCalc: this.attrCalc, effects: this.effects });
    row.classList.toggle('show', !!info);
    if (!info) return;
    const fill = row.querySelector('.bar-res');
    if (fill) {
      fill.style.width = (info.frac * 100) + '%';
      fill.style.background = RESOURCE_COLORS[info.kind] || RESOURCE_COLORS.mana;
    }
    if (textEl) textEl.textContent = info.label;
    // 用户："法力条右侧显示每秒被动获得法力的值，如果没有就显示为0。"——只有法力
    // 类型才有这个概念（充能/升温/闪电充能都是"进度"而不是"每秒获得多少"）。
    if (regenEl) regenEl.textContent = info.regenText || '';
  }

  _baseAttrsHtml(E, stats) {
    return BASE_ATTR_ROWS.map(({ key, label }) => {
      const val = key === 'bonusAttackSpeedPct' ? this._attackSpeedHtml(E, stats)
        : key === 'critChance' ? this._statValueHtml(key, E, stats, '%')
        : this._statValueHtml(key, E, stats);
      return `<div class="a stat-doc" data-stat="${key}" title="点击查看说明"><label>${label}</label><span>${val}</span></div>`;
    }).join('');
  }

  _attackSpeedHtml(entity, stats) {
    const now = this.attrCalc.calcAttackSpeedOf(stats);
    const bs = entity && entity.baseStats;
    const txt = now.toFixed(2);
    if (!bs || !Number.isFinite(bs.baseAttackSpeed)) return txt;
    const base = this.attrCalc.calcAttackSpeedOf(bs);
    const d = now - base;
    // 攻速的量级只有个位数，沿用 _statParts 的 0.005 噪声门槛会把 0.01 的差判成有修正；
    // 这里按显示精度（两位小数）定门槛：显示出来看不出差别的就不该染色。
    const cls = d > 0.005 ? 'stat-up' : d < -0.005 ? 'stat-down' : '';
    return `<span class="${cls}">${txt}</span>`;
  }

  /**
   * ==================== v47：塔/兵"展开更多"的**唯一**一份布局 ====================
   * 用户："塔展开更多里新增射程显示。然后塔/兵的展开更多里面的属性顺序进行排列，
   *        就是一个方面放在一块。兵的移速那里显示塔的子弹速度。"
   *
   * 改动前塔和兵各写了一份 14 行的模板字符串，除了最后两格以外**逐字相同** ——
   * 又是本仓库那条老毛病"同一件事实现了两遍"：塔那份少了攻击距离，
   * 兵那份少了子弹速度，谁也没发现，因为没人会把两段几乎一样的字符串并排读。
   * 现在合成一份，差异只剩下最后一格（兵=移速 / 塔=子弹速度），由 kind 决定。
   *
   * 分组：按"一个方面放在一块"。每组一个小标题（整行），组内两列。
   * 组内条目为奇数时，最后一格自动横跨两列 —— 否则下一组的第一格会被顶到上一组
   * 的空位里，"分组"就白做了。
   */
  _extAttrsHtml(E, stats) {
    let html = '';
    for (const g of extAttrGroups(E.type === 'tower' ? 'tower' : 'minion')) {
      // 该组一个格子都渲染不出来时（属性表里没有这些键）连标题一起省掉，
      // 免得留下一个空标题。自制单位模板可能确实没有某一整组属性。
      const cells = g.rows.map(({ key, label, suffix }) => {
        const v = this._statValueHtml(key, E, stats, suffix);
        return v === '' ? '' :
          `<div class="a stat-doc" data-stat="${key}" title="点击查看说明"><label>${label}</label><span>${v}</span></div>`;
      }).filter(Boolean);
      if (!cells.length) continue;
      // 奇数格 → 最后一格横跨两列，否则下一组的第一格会被塞进这一组留下的空位里。
      if (cells.length % 2 === 1) {
        cells[cells.length - 1] = cells[cells.length - 1].replace('class="a stat-doc"', 'class="a stat-doc span2"');
      }
      html += `<div class="attr-group">${g.title}</div>` + cells.join('');
    }
    return html;
  }

  /**
   * 属性说明弹窗（点属性面板上任意一行）。
   * 用户："属性（攻击力，攻速等都可以点击）描述这个属性。"
   *
   * 文字住在 src/data/statDocs.js，与公式同源 —— 说明写在渲染函数里的话，
   * 下次改公式的人根本不会想到还要去改一段模板字符串。
   */
  _showStatDoc(key, entity) {
    const doc = statDoc(key);
    if (!doc) return;
    const old = document.getElementById('statDocOverlay');
    if (old) old.remove();

    let live = '';
    // v51：desc 支持传函数（护甲/魔抗/伤害减免等要按当前数值写出具体文案），
    // 提到外层作用域，好让下面渲染 body 时也能拿到同一份实时属性表。
    let liveStats = null;
    if (entity) {
      const stats = this.attrCalc.calc(entity, this.effects.getEffects(entity.id));
      liveStats = stats;
      const p = this._statParts(key, entity, stats);
      if (p) {
        // 用户定稿的格式：攻击力：182（152+30）。没有修正就不显示括号。
        const paren = p.delta === 0 ? ''
          : `<span class="stat-break">（${p.base}${p.delta > 0 ? '+' : '−'}${Math.abs(p.delta)}）</span>`;
        live = `<div class="pick-desc-box" style="margin-bottom:10px;font-size:14px;">
            ${doc.label}：<b class="${p.cls}">${p.now}</b>${paren}
            ${p.delta !== 0 ? '<div style="font-size:11px;color:var(--text-mute);margin-top:4px;">'
              + '括号内为（基础值 ' + (p.delta > 0 ? '+' : '−') + ' 各渠道修正之和）。修正来自技能、状态、世界影响（天气/昼夜/熵）与龙之奖励。</div>' : ''}
          </div>`;
      }
    }

    // v44：攻击力这一条额外写清**这个单位打出来是什么伤害类型**。
    // 用户："攻击力详细窗口里也写上伤害类型（物理/魔法/真实/魔法+真实/等等）。"
    // 类型不是一个常量：模板给基准（v43 起塔默认魔法），武器技能可以再改或再加一股
    //（腐蚀型是魔法 + 真实两股 DoT、闪电杖满充无视防御）。所以这里从**实体身上**读，
    // 而不是从模板表里查 —— 查模板的话手动改过伤害类型的单位会显示错的。
    let dmgType = '';
    if (key === 'attackDamage' && entity) {
      // v51.1：补上 'adaptive'——用户新增的攻击类型逻辑，这个弹窗原来只认
      // physical/magic/true 三种，'adaptive' 落进 else 分支被误判成物理伤害。
      // 自适应要显示的是【这一刻】真实解析出来的类型（按当前法术强度 vs 攻击力），
      // 不是"自适应"这四个字本身——那样看不出它现在到底在打什么伤害。
      const TYPE_LABEL = { physical: '⚔️ 物理伤害', magic: '✨ 魔法伤害', true: '💠 真实伤害' };
      const rawType = entity.baseStats?.attackType;
      const base = rawType === 'adaptive'
        ? `🔄 自适应（当前：${TYPE_LABEL[this.attrCalc.resolveAttackType(liveStats || {})] || '物理伤害'}）`
        : (TYPE_LABEL[rawType] || TYPE_LABEL.physical);
      const extras = [];
      for (const inst of (entity._skillInstances || [])) {
        const def = SkillLibrary[inst.skillId];
        if (!def || !inst.skillId.startsWith('weapon_')) continue;
        if (def.extraDamageTypes) extras.push(...def.extraDamageTypes);
        else if (inst.skillId === 'weapon_corrosion') extras.push('✨ 魔法 DoT', '💠 真实 DoT');
        else if (inst.skillId === 'weapon_lightning') extras.push('满充能时按比例无视防御');
      }
      dmgType = `<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">伤害类型</div>
        <p style="font-size:12px;line-height:1.8;margin:0 0 10px;"><b>${base}</b>${
          extras.length ? `　<span style="color:var(--text-mute);">＋ ${extras.join(' ＋ ')}</span>` : ''}
        </p>`;
    }

    const descText = typeof doc.desc === 'function' ? doc.desc(liveStats) : doc.desc;
    const body = `${live}${dmgType}
      <p style="font-size:12px;line-height:1.8;margin:0 0 10px;">${descText}</p>
      ${doc.formula ? `<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">结算规则</div>
        <p style="font-size:11px;color:var(--text-dim);line-height:1.8;margin:0 0 10px;">${doc.formula}</p>` : ''}
      ${doc.tip ? `<p style="font-size:11px;color:var(--text-mute,#6b7480);line-height:1.7;margin:0;">${doc.tip}</p>` : ''}`;

    const overlay = document.createElement('div');
    overlay.id = 'statDocOverlay';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = shellHtml({
      title: `📊 ${doc.label}`, body, crumb: '', width: '460px',
      footer: '<div class="modal-actions"><button class="stat-doc-close primary">关闭</button></div>',
    });
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.stat-doc-close').addEventListener('click', close);
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
      // ==================== v49b：进度型状态（充能）====================
      // 用户："攻城车状态栏里应该有个带进度的状态表示充能进度，目前没有。"
      //
      // 这个环原本只表达"还剩多少时间"（按 remainingTime/duration 算）。
      // 充能不是倒计时，是**从 0 涨到 1** 的进度，而且它的值不在效果自己身上 ——
      // 所以蓝图里加一个 progressOf(entity)：谁想画进度就自己说进度是多少。
      // 复用同一个环而不是新做一个部件：状态栏里再多一种视觉语言只会更乱，
      // 而"这一格里有个环在动"玩家已经认识了。
      const progFn = e.blueprint.progressOf;
      if (typeof progFn === 'function') {
        const unit = this.entities.get(this.selectedId);
        const frac = Math.max(0, Math.min(1, progFn(unit) || 0));
        const deg = Math.round(frac * 360);
        // 与倒计时相反：充能是**亮起来**的（画已完成的那一段），倒计时是压暗剩余。
        bg = `conic-gradient(rgba(246,201,74,0.55) ${deg}deg, transparent ${deg}deg 360deg)`;
      } else if (e.permanent || e.remainingTime === Infinity || e.maxDuration <= 0) {
        bg = 'none';
      } else {
        // v51.5（Q1 修复）：这里原来除的是 e.blueprint.duration —— 那是蓝图上的
        // 【出厂设计值】，不是这个实例真正的总时长。DragonSystem._grantSlayer 把
        // 临时龙魂从"永久"改成"限时 N 秒"时，只改了 remainingTime/maxDuration，
        // 没有（也不该）去改 blueprint.duration——那是共享对象，改了会连累同一个
        // 龙魂的其它实例。于是这里除的分母一直是 Infinity（龙魂展示效果出厂就是永久），
        // remainingTime / Infinity 恒为 0，环永远画成"已耗尽的满环"，玩家看起来就是
        // "没有进度条"。EffectRegistry 创建每个效果实例时本来就同步写了 maxDuration
        // （EffectRegistry.js 头注就写着"圆形进度条所需的 remainingTime/maxDuration
        // 数据"——这里却一直没用它），改用这个【实例级】字段就是这条环真正该读的值，
        // 且不需要 DragonSystem 那边再做任何改动。
        const elapsedFrac = Math.max(0, Math.min(1, 1 - (e.remainingTime / e.maxDuration)));
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
    // v45：标题与右侧徽标合并。
    // 用户："左上角那个就显示为 [阵营色圆圈] 单位类型。不要显示文字的阵营和右侧的＃编号"
    // 合并前左边写「🏰 #1 防御塔」、右边写「🔵 蓝方 · 外塔」，两处说的是同一件事，
    // 而且"防御塔"和"外塔"还互相重复。现在**只留一处**：一个阵营色圆点 + 单位类型。
    // 阵营改用颜色而不是文字——颜色本来就是这个游戏里识别敌我的方式，写成文字反而占地方。
    // ⚠️ 阵营是三值的（blue/red/neutral），任何按它分叉的地方都必须有三个分支：
    // v43 修过一次「没有第三档的三元」，中立塔被显示成红方塔。
    const FAC_DOT = { blue: '#4a9eff', red: '#ff5a5a', neutral: '#4caf50' };
    const dot = FAC_DOT[e._mapFaction] || '#8a93a3';
    const typeName = e.type === 'tower'
      ? (tierLabels[e._mapTier] || '防御塔')
      : (e.baseStats?.label || e.type);
    this.selTitle.innerHTML =
      `<span class="fac-dot" style="background:${dot};"></span>${typeName}`;
    if (this.selActions) {
      this.selActions.innerHTML = e.type === 'tower'
        ? `<button data-action="towerEdit" data-id="${e.id}" title="编辑">✏️</button>
           <button data-action="towerDelete" data-id="${e.id}" title="删除">🗑</button>`
        : `<button data-action="minionEdit" data-id="${e.id}" title="编辑">✏️</button>
           <button data-action="minionKill" data-id="${e.id}" title="击杀">✕</button>`;
    }
    this.selPanel.classList.add('show');
    // v51.6 修复：window.__app 从未被赋值过（全仓库只有 window.CTX.__app 是真的），
    // 之前这两处裸用它导致选中/取消选中单位时，3D 场景里的高亮框从未真正同步过。
    const _appSel = window.CTX?.__app || window.__app;
    if (_appSel?.renderer) _appSel.renderer.selectedId = id;
  }

  clearSelection() {
    this.selectedId = null;
    this._selCardEl = null;
    this.selCard.innerHTML = '';
    this.selPanel.classList.remove('show');
    const _appSel = window.CTX?.__app || window.__app;
    if (_appSel?.renderer) _appSel.renderer.selectedId = null;
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
      <div class="bar-row bar-res-row" id="tower-resrow-${tower.id}">
        <div class="bar-track"><div class="bar-res" id="tower-res-${tower.id}"></div></div>
      </div>
      <div class="bar-res-text">
        <span id="tower-restext-${tower.id}"></span>
        <span class="bar-res-regen" id="tower-resregen-${tower.id}"></span>
      </div>
      <div class="panel-sec">属性</div>
      <div class="attrs" id="tower-attrs-${tower.id}"></div>
      <div class="attrs-ext" id="tower-attrs-ext-${tower.id}"></div>
      <button class="toggle-ext" data-action="toggleAttrs" data-id="${tower.id}">▼ 展开更多</button>
      <div class="panel-sec">技能</div>
      <div class="skill-slot-row" id="tower-skills-${tower.id}"></div>
      <div class="panel-sec">状态</div>
      <div class="effect-row" id="tower-effects-${tower.id}"></div>
      <div class="panel-sec">世界影响</div>
      <div class="state-row">
        <div class="weather-row" id="tower-weather-${tower.id}"></div>
        <div class="world-row" id="tower-world-${tower.id}"></div>
      </div>
    `;
    // v33（Q11）：底部"编辑/删除"按钮行已删除——图标化后移至面板右上角（selectionActions）
    return card;
  }

  updateTowerCard(card, tower) {
    const id = tower.id;
    const stats = this.attrCalc.calc(tower, this.effects.getEffects(id));
    const maxHP = stats.maxHP || 1;
    const hpFrac = Math.max(0, Math.min(1, tower.currentHP / maxHP));

    // 拖尾（血条宽度由下方比例逻辑统一设置）。v47：缓动/贴齐/配色与画面里那条统一，
    // 实现只剩 barTrail.stepTrail 一处（见 _stepTrailBar 与 barTrail.js 的对照表）。
    this._stepTrailBar(card.querySelector(`#tower-trail-${id}`), hpFrac);

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
    if (hpText) hpText.textContent = `${Math.round(tower.currentHP)}/${Math.round(maxHP)}`;   // v47：去掉 HP 前缀（条本身就是血条），并居中显示
    this._updateResourceBar(card, 'tower', id, tower);

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
    const E = tower;   // v44：属性值统一走 _statValueHtml（基础/修正着色），需要实体本身
    const attrsContainer = card.querySelector(`#tower-attrs-${id}`);
    if (attrsContainer) {
      this._setAttrs(attrsContainer, this._baseAttrsHtml(E, stats));
    }

    // 扩展属性（默认折叠）。布局与兵卡片共用同一份（见 _extAttrsHtml 头注）。
    const attrsExtContainer = card.querySelector(`#tower-attrs-ext-${id}`);
    if (attrsExtContainer) this._setAttrs(attrsExtContainer, this._extAttrsHtml(E, stats));

    // 技能栏（diff式渲染，避免每帧重建导致点击失效）
    const skillContainer = card.querySelector(`#tower-skills-${id}`);
    this._updateSkillSlots(skillContainer, tower._skillInstances || [], tower);

    // 效果栏（diff式渲染）。v51.2（Q3）：升温/闪电充能/充能已经有专属资源条了，
    // 状态栏这里不再重复显示（见 resourceBar.js 的 HIDDEN_STATUS_EFFECT_NAMES 头注）。
    const effectsContainer = card.querySelector(`#tower-effects-${id}`);
    this._updateEffectIcons(effectsContainer, this.effects.getEffects(id).filter(e => !HIDDEN_STATUS_EFFECT_NAMES.has(e.blueprint.name)));
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
      <div class="bar-row bar-res-row" id="minion-resrow-${minion.id}">
        <div class="bar-track"><div class="bar-res" id="minion-res-${minion.id}"></div></div>
      </div>
      <div class="bar-res-text">
        <span id="minion-restext-${minion.id}"></span>
        <span class="bar-res-regen" id="minion-resregen-${minion.id}"></span>
      </div>
      <div class="panel-sec">属性</div>
      <div class="attrs" id="minion-attrs-${minion.id}"></div>
      <div class="attrs-ext" id="minion-attrs-ext-${minion.id}"></div>
      <button class="toggle-ext" data-action="toggleAttrs" data-id="${minion.id}">▼ 展开更多</button>
      <div class="panel-sec">技能</div>
      <div class="skill-slot-row" id="minion-skills-${minion.id}"></div>
      <div class="panel-sec">状态</div>
      <div class="effect-row" id="minion-effects-${minion.id}"></div>
      <div class="panel-sec">世界影响</div>
      <div class="state-row">
        <div class="weather-row" id="minion-weather-${minion.id}"></div>
        <div class="world-row" id="minion-world-${minion.id}"></div>
      </div>
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

    this._stepTrailBar(card.querySelector(`#minion-trail-${id}`), hpFrac);

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
    if (hpText) hpText.textContent = `${Math.round(minion.currentHP)}/${Math.round(maxHP)}`;   // 同上
    this._updateResourceBar(card, 'minion', id, minion);
    const shieldText = card.querySelector(`#minion-shieldtext-${id}`);
    if (shieldText) shieldText.textContent = `🛡 ${Math.round(shieldTotal)}`;

    const E = minion;   // 同上
    const attrsContainer = card.querySelector(`#minion-attrs-${id}`);
    if (attrsContainer) {
      this._setAttrs(attrsContainer, this._baseAttrsHtml(E, stats));
    }

    const attrsExtContainer = card.querySelector(`#minion-attrs-ext-${id}`);
    if (attrsExtContainer) this._setAttrs(attrsExtContainer, this._extAttrsHtml(E, stats));

    // 技能栏（diff式渲染）
    const skillContainer = card.querySelector(`#minion-skills-${id}`);
    this._updateSkillSlots(skillContainer, minion._skillInstances || [], minion);

    // 效果栏（diff式渲染）。v51.2（Q3）：同上，已有资源条的三种展示效果不重复显示。
    const effectsContainer = card.querySelector(`#minion-effects-${id}`);
    this._updateEffectIcons(effectsContainer, this.effects.getEffects(id).filter(e => !HIDDEN_STATUS_EFFECT_NAMES.has(e.blueprint.name)));
    this._updateWeatherRow(card, minion);
    this._updateWorldRow(card, minion);
  }

  updateTopBar() {
    // 波次显示按当前模式选择数据源：之前永远读 window.waveNumber（沙盒专属全局变量），
    // 对战模式下这个变量不再更新（沙盒的 WaveSystem 被暂停），导致左上角波次显示冻结。
    // 现在对战模式下改读 laneWaveSystem 自己的独立波次计数与倒计时。
    // v51.6 修复：window.__app 从未被赋值过（全仓库只有 window.CTX.__app 是真的）——
    // 上面注释说"对战模式下改读 laneWaveSystem"，但因为这个 bug，mapSystem/
    // laneWaveSystem 恒为 undefined，条件永远走不到 if 分支，实际上对战模式下
    // 顶栏波次显示从来没有真正切换过，一直在读沙盒的冻结变量。
    const app = window.CTX?.__app || window.__app;
    const mapSystem = app?.mapSystem;
    const laneWaveSystem = app?.laneWaveSystem;
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
      // v44：顶栏只显示推塔数（用户定稿）。击杀数照常统计，只是不占顶栏那一格。
      this._setText('scoreBlue', `${sc.blue.towers}`);
      this._setText('scoreRed', `${sc.red.towers}`);
    }

    // 龙魂提示条
    const ds = app?.dragonSystem;

    // ==================== v51.6：左上角"推塔数"格在有龙的地图上换成巨龙信息 ====================
    // 用户："左上角UI……改为巨龙下次刷新时间和红蓝方巨龙之力数量统计（如果某一方获得了
    // 龙魂旧显示某一方都获得了什么龙魂），如果该地图中不主动刷新巨龙旧还是显示原来的。"
    // mapAllowsDragon() 是地图自己声明的开关（目前只有召唤师峡谷 dragon.enabled:true），
    // 不满足就完全不碰这两个元素，保留原来的推塔数显示——两块面板互斥显隐。
    {
      const scoreBoard = document.getElementById('scoreBoard');
      const dragonBoard = document.getElementById('dragonStatBoard');
      const hasDragonMap = !!(ds && ds.mapAllowsDragon());
      if (scoreBoard && this._txtCache._dragonMapMode !== hasDragonMap) {
        this._txtCache._dragonMapMode = hasDragonMap;
        scoreBoard.style.display = hasDragonMap ? 'none' : '';
        if (dragonBoard) dragonBoard.style.display = hasDragonMap ? '' : 'none';
      }
      if (hasDragonMap) {
        const fmt = (sec) => {
          const s2 = Math.max(0, Math.ceil(sec || 0));
          return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
        };
        this._setText('dragonNextTimer', fmt(ds.nextDragonTime));
        const souls = ds.getSouls ? ds.getSouls() : { blue: [], red: [] };
        const powerOf = (fac) => Object.values(ds.factionKills?.[fac] || {}).reduce((a, b) => a + b, 0);
        const sideText = (fac) => {
          const soulIds = souls[fac] || [];
          if (soulIds.length) {
            // 已成魂：改显示龙魂本身（可能不止一条——远古龙魂与常驻元素龙魂可以并存）。
            return soulIds.map(id => `${SkillLibrary[id]?.icon || '🐉'}${SkillLibrary[id]?.name || id}`).join(' ');
          }
          return String(powerOf(fac)); // 未成魂：显示巨龙之力层数（已击杀的元素龙条数）
        };
        this._setText('dragonPowerBlue', sideText('blue'));
        this._setText('dragonPowerRed', sideText('red'));
      }
    }
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