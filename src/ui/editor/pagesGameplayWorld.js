/**
 * pagesGameplayWorld.js —— "游戏性"大 tab 下的三个搬迁页面：巨龙与龙魂 / 天气 / 熵。
 *
 * 用户定稿："设置窗口里应该只包含对该系统的设置，而不包含游戏性的设置。"
 * 这三块原来分别在 SettingsDialog（龙魂状态、熵）和独立的 WeatherPanel 浮层里，
 * 现在收进模板编辑器，和批量加技能/加状态、出兵编排放在同一个"游戏性"分组。
 *
 * 巨龙与龙魂页顺带修了两个 bug（用户点名"现有的有功能性问题"）：
 *   ① 文案写的是旧规则"N 条元素龙打完统一结算"，实际早就是"谁先攒到阈值立即
 *      成魂"（DragonSystem._onDragonKilled 里当帧判定）——文案和真实规则不一致。
 *   ② "元素 X/6" 的 /6 是误导性的伪上限：elementDragonTotal 只用于展示，
 *      从未在生成逻辑里真正限制过第 7、8 条元素龙的出现——spawnDragon() 并没有
 *      读它做截断判断，只是文档化的期望值。
 * 新增的细粒度控制：单独给某一方装/卸某个具体龙魂、单独调某个元素的击杀计数。
 */
import { CONFIG } from '../../data/Config.js';
import { WeatherPanel } from '../WeatherPanel.js';
import { DRAGON_ELEMENTS, DragonSystem } from '../../systems/DragonSystem.js';
import { SkillLibrary, renderSkillDescription } from '../../core/SkillLibrary.js';

export const EDITOR_PAGES_GAMEPLAY_WORLD = {
  // ==================== 巨龙与龙魂 ====================
  /**
   * ==================== v50：巨龙与龙魂页重做 ====================
   * 用户："新做的龙魂窗口不好，套用现有的单位属性编辑窗口中的样式比较好。
   *        并且龙魂窗口上红蓝方都拿了多少条龙，下一条龙啥时候等等等。
   *        并且你原有的窗口只写了龙魂，没写巨龙之力！"
   *
   * 三处改动：
   *   ① **补上巨龙之力** —— 这是最大的缺口：之前整页没有任何入口能看到/改层数，
   *      而力是每杀一条龙就给的过程奖励，比魂出现得早得多。
   *   ② 顶部一条**对局态势**：双方各拿了几条、还差几条成魂、下一条龙的倒计时、当前魂。
   *   ③ 样式套用单位属性面板那套（.attrs 的 chip 网格 + .panel-sec 小标题），
   *      不再是一排排 slider-row 的数字输入框。
   *
   * 元素表从 DRAGON_ELEMENTS 现取而不是写死 —— v50 一次加了六个元素，
   * 写死的话每加一个都要回来补一次（而且漏了不会报错，只会"这个元素在界面上不存在"）。
   */
  _renderGameplayDragonContent() {
    const app = window.CTX?.__app;
    const ds = app?.dragonSystem;
    if (!ds) return `<div class="pick-desc-box">（巨龙系统未接入，进入对局后显示）</div>`;

    const st = ds.getState ? ds.getState() : ds;
    const ELS = Object.entries(DRAGON_ELEMENTS);
    const soulName = (id) => {
      const hit = ELS.find(([, d]) => d.soul === id);
      return hit ? `${hit[1].icon} ${SkillLibrary[id]?.name || hit[1].label}` : (id === 'dragonsoul_ancient' ? '🐲 远古之力' : '（无）');
    };
    const fmt = (sec) => {
      const s2 = Math.max(0, Math.ceil(sec || 0));
      return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
    };

    // ---- 顶部：对局态势 ----
    const nextIn = Math.max(0, (ds.nextDragonTime ?? 0));
    const thr = st.soulThreshold ?? 4;
    const situation = ['blue', 'red'].map((fac) => {
      const total = st.factionTotals?.[fac] ?? 0;
      const soul = st.souls?.[fac]?.[0] || null;
      const need = Math.max(0, thr - total);
      return `<div class="a">
        <label>${fac === 'blue' ? '🔵 蓝方' : '🔴 红方'}</label>
        <span>${total} 条${st.soulResolved ? '' : `<span style="font-size:10px;color:var(--text-mute);"> / 还差 ${need}</span>`}</span>
      </div>
      <div class="a"><label>${fac === 'blue' ? '蓝方龙魂' : '红方龙魂'}</label>
        <span style="font-size:12px;">${soul ? soulName(soul) : '（无）'}</span></div>`;
    }).join('');

    return `
      <div class="panel-sec">对局态势</div>
      <div class="attrs">
        <div class="a"><label>下一条龙</label><span>${st.soulResolved ? '🐲 远古龙' : '🐉 元素龙'} ${fmt(nextIn)}</span></div>
        <div class="a"><label>成魂门槛</label><span>${thr} 条</span></div>
        ${situation}
      </div>

      ${this._renderGameplayDragonSoulPool(ds)}

      <div class="panel-sec">开关</div>
      <div class="slider-row"><label>巨龙生成</label>
        <button id="dgToggleSpawn" style="flex:1;">${CONFIG.dragonToggles?.spawn !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
      </div>
      <div class="slider-row"><label title="关掉后龙仍会刷，但不再造成/享受任何龙魂加成、宿怨、斩杀等效果">巨龙效果</label>
        <button id="dgToggleEffect" style="flex:1;">${CONFIG.dragonToggles?.effect !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
      </div>

      <div class="panel-sec">参数</div>
      <div class="slider-row"><label title="用户定稿：所有龙魂作用增加的吸血（物理/魔法/全能）对防御塔这种单位的数值减少至此比例。只影响龙魂，不影响巨龙之力。">龙魂吸血·塔缩放(%)</label>
        <input type="number" id="dgVampTowerScale" min="0" max="100" step="1" value="${CONFIG.dragonSouls?.vampTowerScalePct ?? 33}" style="width:70px;">
        <button id="dgVampTowerScaleApply">应用</button>
      </div>

      <div class="panel-sec">快捷操作</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button id="dgForceElement">🐉 立刻刷一条元素龙</button>
        <button id="dgForceAncient">🐲 立刻刷一条远古龙</button>
        <button id="dgKillAll" class="danger">💀 清场（走正常死亡结算，照常发奖励）</button>
        <button id="dgResetProgress" class="danger">↺ 清空巨龙进度</button>
      </div>`;
  },

  /**
   * ==================== v51.6：批量龙魂重做——完全对齐单位编辑窗口那套 ====================
   * 用户第一版反馈（v51.5）："我想要的是这种的（截图）"——那版做的是卡片池，
   * 但用户第二版反馈依旧不满意："模板编辑器里龙魂编辑页面依旧乱七八糟。我要求
   * 你参考现有的界面……如图片所示。把我画圈中没用的文字和乱七八糟的UI删除，
   * 就按照我说的这么做：【蓝方龙魂池】（里面显示蓝方正在生效的）【红方龙魂池】
   * 【全部生效/蓝方/红方（复选框，因为可能以后涉及其他阵营）】【巨龙之力池】
   * 【龙魂池】。【巨龙之力池】【龙魂池】点击之后就加到【红蓝方龙魂池中】，
   * 在红蓝方龙魂池中减少某个龙魂等。"
   *
   * 与 v51.5 那版的关键差异：
   *   ① 巨龙之力池/龙魂池不再各自按阵营复制一份（v51.5 是蓝/红各一套 13 张卡，
   *      共 26 张）——现在只有**一份共享池**，点哪个阵营生效由下面的复选框决定，
   *      卡片数量减半，也更贴近"先选目标、再选要素"的操作顺序。
   *   ② "已生效"从"卡片右上角数字"改回真正的**已生效 chip 条**（与单位编辑
   *      窗口的"✨已生效效果"完全同构），点 chip 上的 ✕ 直接移除，不用再去
   *      对应的池子里反着点一次。
   *   ③ 删掉了"击杀数"表格和成魂规则说明文字（用户画圈标记的"没用的文字和
   *      乱七八糟的UI"）——巨龙之力池点击即可直接叠层，不需要靠手填击杀数
   *      再点应用去间接触发。
   *
   * ⚠️ 这是手动测试工具，不是真实的"击杀 4 条龙自动成魂"那条规则：广播只覆盖
   * 【当前在场】的单位，不写 ds.souls[fac]/ds.soulOwner（那两个字段是自动成魂
   * 规则的状态，手动操作覆盖它们会把"真实进度"污染成假数据）。所以后续新出生的
   * 单位不会自动继承手动点的这些效果——真实的"这一局从此都有这条魂"要靠正常的
   * 击杀积累触发 _resolveSoul。
   */
  // 当前所有可对战阵营——复选框组"全部生效"依赖这份列表。用户点名"以后可能涉及
  // 其他阵营"：这里单独列成一个数组而不是散着写 ['blue','red']，以后加阵营
  // （目前引擎其它地方，比如 FactionSystem.FACTIONS，也还只声明了这两个）
  // 只需要改这一处。
  _DG_FACTIONS: ['blue', 'red'],

  _dgFactionActiveSouls(ds, fac) {
    const ec = window.CTX?.__app?.entityContainer;
    const counts = {};
    if (!ec?.getAll) return counts;
    for (const e of ec.getAll(true)) {
      if ((e._mapFaction || e.faction) !== fac) continue;
      for (const inst of (e._skillInstances || [])) {
        if (!inst.skillId.startsWith('dragonsoul_') || inst.skillId === 'dragonsoul_ancient') continue;
        counts[inst.skillId] = (counts[inst.skillId] || 0) + 1;
      }
    }
    return counts;
  },

  // 巨龙之力是【逐个单位】各自积累的（新单位入场时按 factionKills 补发，不保证
  // 每个单位层数一致）——这里取"当前存活单位里出现过的最高层数"当代表值，
  // 只是给这个手动测试工具一个参考，不是精确的"全队统一层数"。
  _dgFactionActivePower(fac) {
    const ec = window.CTX?.__app?.entityContainer;
    const fx = window.CTX?.__app?.effectRegistry;
    const out = {};
    if (!ec?.getAll || !fx) return out;
    for (const e of ec.getAll(true)) {
      if ((e._mapFaction || e.faction) !== fac) continue;
      for (const [el] of Object.entries(DRAGON_ELEMENTS)) {
        const eff = fx.getEffects(e.id).find(x => x.sourceId === `dragon_buff_${el}_0`);
        if (eff && eff.stacks > (out[el] || 0)) out[el] = eff.stacks;
      }
    }
    return out;
  },

  _dgActiveChipsHtml(ds, fac) {
    const powerCounts = this._dgFactionActivePower(fac);
    const soulCounts = this._dgFactionActiveSouls(ds, fac);
    const chips = [];
    for (const [el, d] of Object.entries(DRAGON_ELEMENTS)) {
      const n = powerCounts[el] || 0;
      if (n > 0) {
        chips.push(`<div class="transfer-chip" data-dg-remove-kind="power" data-dg-remove-fac="${fac}" data-dg-remove-el="${el}">
          <span class="chip-icon">${d.icon}</span><span>${d.label}之力（${n}层）</span><span class="chip-remove">✕</span>
        </div>`);
      }
    }
    for (const [el, d] of Object.entries(DRAGON_ELEMENTS)) {
      if ((soulCounts[d.soul] || 0) > 0) {
        const def = SkillLibrary[d.soul];
        chips.push(`<div class="transfer-chip" data-dg-remove-kind="soul" data-dg-remove-fac="${fac}" data-dg-remove-el="${el}">
          <span class="chip-icon">${def?.icon || d.icon}</span><span>${def?.name || d.label}</span><span class="chip-remove">✕</span>
        </div>`);
      }
    }
    return chips.length ? chips.join('') : `<div class="transfer-active-empty">尚未生效任何巨龙之力或龙魂。</div>`;
  },

  _renderGameplayDragonSoulPool(ds) {
    const ELS = Object.entries(DRAGON_ELEMENTS);
    const factionRows = this._DG_FACTIONS.map(fac => `
      <div class="panel-sec" style="margin-top:10px;">${fac === 'blue' ? '🔵 蓝方龙魂池（当前生效）' : '🔴 红方龙魂池（当前生效）'}</div>
      <div class="transfer-active-list">${this._dgActiveChipsHtml(ds, fac)}</div>`).join('');

    const scopeRow = `
      <div class="panel-sec">广播目标</div>
      <div style="display:flex;gap:16px;padding:2px 2px 8px;">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;">
          <input type="checkbox" class="dg-scope" value="all" checked>全部生效</label>
        ${this._DG_FACTIONS.map(fac => `<label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;">
          <input type="checkbox" class="dg-scope" value="${fac}">${fac === 'blue' ? '蓝方' : '红方'}</label>`).join('')}
      </div>`;

    const powerPoolHtml = ELS.map(([el, d]) => `<div class="pick-card" data-dgp-kind="power" data-dgp-el="${el}">
        <div class="pick-icon">${d.icon}</div><div class="pick-label">${d.label}之力</div>
      </div>`).join('');
    const soulPoolHtml = ELS.map(([el, d]) => {
      const def = SkillLibrary[d.soul];
      return `<div class="pick-card" data-dgp-kind="soul" data-dgp-el="${el}" data-dgp-soulid="${d.soul}">
        <div class="pick-icon">${def?.icon || d.icon}</div><div class="pick-label">${def?.name || d.label}</div>
      </div>`;
    }).join('');

    return `
      ${factionRows}
      ${scopeRow}
      <div class="panel-sec">巨龙之力池（点击 +1 层）</div>
      <div class="pick-grid">${powerPoolHtml}</div>
      <div class="panel-sec">龙魂池（点击切换）</div>
      <div class="pick-grid">${soulPoolHtml}</div>
      <div class="pick-desc-box" id="dgSoulDescBox">点击巨龙之力/龙魂池，对勾选的阵营广播；点击上方"当前生效"里的条目可以移除。</div>`;
  },

  /** 读取"广播目标"复选框当前勾选的阵营集合。 */
  _dgScopeFactions(overlay) {
    const boxes = [...overlay.querySelectorAll('.dg-scope')];
    const allBox = boxes.find(b => b.value === 'all');
    if (allBox?.checked) return [...this._DG_FACTIONS];
    const picked = boxes.filter(b => b.value !== 'all' && b.checked).map(b => b.value);
    return picked;
  },

  _bindGameplayDragonEvents(overlay, logFn) {
    const app = window.CTX?.__app;
    const ds = app?.dragonSystem;
    if (!ds) return;
    const refresh = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplayDragonContent();
      this._bindGameplayDragonEvents(overlay, logFn);
    };

    // ==================== v51 bug 修复：打开这页之后数据不刷新 ====================
    // 用户："打开这个界面里面的数据根本不刷新（非实时情况）。"
    // 排查结论：这一页此前和面板里其它"即点即生效"的页一样，只在**用户自己点了
    // 某个按钮**（改击杀数/指定龙魂/切换开关）之后才会重绘——而这一页展示的
    // "下一条龙倒计时"、"击杀数"、"巨龙之力层数"是随游戏时钟持续变化的**只读态势**，
    // 光坐在那不点任何东西，界面就会停在打开那一刻的快照上，一直不动，看起来像坏了。
    // 修法：这一页开着的时候每秒自重绘一次；用户正在某个击杀数输入框里打字时跳过
    // 那一次，免得输入到一半被刷掉。计时器挂在 this（不是 overlay）上，每次重新
    // 绑定时先清掉上一个——刷新本身会重新调用这个函数、重新起一个计时器，
    // 天然自我延续；page 切走或窗口关掉（overlay 从 DOM 摘除）时自己停。
    if (this._dgLiveTimer) clearInterval(this._dgLiveTimer);
    this._dgLiveTimer = setInterval(() => {
      if (!overlay.isConnected || this._tplState?.tab !== 'dragonstate') {
        clearInterval(this._dgLiveTimer);
        this._dgLiveTimer = null;
        return;
      }
      const active = document.activeElement;
      if (active && active.tagName === 'INPUT' && overlay.contains(active)) return;
      refresh();
    }, 1000);

    // v51.6：广播目标复选框——"全部生效"与单独的阵营勾选没有互斥逻辑（不强制
    // 只能选一个），读取时 _dgScopeFactions 统一处理："全部生效"打钩就直接算全部
    // 阵营，不看其它框；没打钩就取单独勾了的那些。改动本身不需要重绘，下次点池子
    // 卡片时现读。
    overlay.querySelectorAll('.dg-scope').forEach(box => {
      box.addEventListener('change', () => {});
    });

    // 巨龙之力池 / 龙魂池：点击对"广播目标"里勾选的每个阵营生效。
    overlay.querySelectorAll('[data-dgp-kind]').forEach(card => {
      card.addEventListener('click', () => {
        const facs = this._dgScopeFactions(overlay);
        if (!facs.length) { logFn('⚠️ 先在"广播目标"里勾选至少一个阵营', 'error'); return; }
        const kind = card.dataset.dgpKind;
        const el = card.dataset.dgpEl;
        const def = DRAGON_ELEMENTS[el];
        if (!def) return;
        if (kind === 'power') {
          // 力发给全部单位（POWER_REWARD_OK），不是只给塔+大型小兵那条 SOUL_REWARD_OK——
          // 与 _grantSlayer 里真实击杀走的广播范围（DragonSystem.js:330）保持一致。
          let total = 0;
          for (const fac of facs) total += ds._grantAll(fac, (e) => ds._applyElementBuff(e, el), DragonSystem.POWER_REWARD_OK);
          logFn(`🔥 ${def.label}之力 +1 层：已广播给 ${facs.map(f => f === 'blue' ? '蓝方' : '红方').join('/')}（共 ${total} 个单位）`, 'spawn');
        } else if (kind === 'soul') {
          const soulId = card.dataset.dgpSoulid;
          // 与 v51.5 那版同样的道理：每个阵营各自按"当前是不是一个都没有"决定
          // 这次点击是统一装上还是统一卸下，不逐单位各自反转——否则场上"有的有
          // 有的没有"时点一下会出现更混乱的中间态。两个阵营的开关方向各自独立判断
          // （比如同时勾了蓝红两方广播，蓝方可能是"装上"、红方可能是"卸下"）。
          let changedTotal = 0, unitsTotal = 0;
          const dirs = [];
          for (const fac of facs) {
            const before = this._dgFactionActiveSouls(ds, fac)[soulId] || 0;
            const turnOn = before === 0;
            let changed = 0, total = 0;
            ds._grantAll(fac, (e) => {
              total++;
              const has = (e._skillInstances || []).some(i => i.skillId === soulId);
              if (turnOn === !has) { ds._toggleSoul(e, soulId); changed++; }
            });
            changedTotal += changed; unitsTotal += total;
            dirs.push(`${fac === 'blue' ? '蓝方' : '红方'}${turnOn ? '装备' : '卸下'}`);
          }
          const def2 = ds.skills[soulId];
          logFn(`🐉 龙魂【${def2?.name || soulId}】：${dirs.join('、')}（影响 ${changedTotal}/${unitsTotal} 个单位）`, 'spawn');
        }
        refresh();
      });
      card.addEventListener('mouseenter', () => {
        const descBox = overlay.querySelector('#dgSoulDescBox');
        if (!descBox) return;
        if (card.dataset.dgpKind === 'soul') {
          const def = ds.skills[card.dataset.dgpSoulid];
          if (def) descBox.textContent = renderSkillDescription(def, null, {}) || def.description || '';
        } else {
          const def = DRAGON_ELEMENTS[card.dataset.dgpEl];
          if (def) descBox.textContent = `${def.label}之力：击杀获得的永久元素增益，点击可叠加层数（每层独立生效，作用于全部单位）。`;
        }
      });
    });

    // 已生效 chip：点击移除（power 扣 1 层/整条移除，soul 直接卸下），只作用于
    // chip 所在的那一个阵营，不受"广播目标"复选框影响——这是"针对性移除"，不是广播。
    overlay.querySelectorAll('[data-dg-remove-kind]').forEach(chip => {
      chip.addEventListener('click', () => {
        const kind = chip.dataset.dgRemoveKind;
        const fac = chip.dataset.dgRemoveFac;
        const el = chip.dataset.dgRemoveEl;
        const def = DRAGON_ELEMENTS[el];
        if (!def) return;
        if (kind === 'power') {
          // 一个元素的巨龙之力可能同时挂着不止一条属性（_applyElementBuff 按
          // dragonPowerBuffs(el) 的每一项各开一条 dragon_buff_${el}_${i}，层数
          // 永远同步增减）——只扣 _0 那一条会把其余索引的层数甩在后面，扣几次
          // 之后就会出现"某条属性还剩层数、另一条已经归零"的不一致态。这里改成
          // 一次性把**同一元素的全部索引**都扣 1 层/清空。
          let n = 0;
          ds._grantAll(fac, (e) => {
            const effs = ds.effects.getEffects(e.id).filter(x => x.sourceId && x.sourceId.startsWith(`dragon_buff_${el}_`));
            if (!effs.length) return;
            for (const eff of effs) {
              if (eff.stacks > 1) { eff.stacks -= 1; ds.effects._recalcEffectValues(eff); ds.effects._updateDescription(eff); }
              else ds.effects.remove(eff.id);
            }
            n++;
          }, DragonSystem.POWER_REWARD_OK);
          logFn(`🔻 ${fac === 'blue' ? '蓝方' : '红方'} ${def.label}之力 -1 层（${n} 个单位）`, 'spawn');
        } else if (kind === 'soul') {
          let n = 0;
          ds._grantAll(fac, (e) => {
            if ((e._skillInstances || []).some(i => i.skillId === def.soul)) { ds._toggleSoul(e, def.soul); n++; }
          });
          logFn(`🚫 ${fac === 'blue' ? '蓝方' : '红方'} 已卸下龙魂【${SkillLibrary[def.soul]?.name || def.soul}】（${n} 个单位）`, 'spawn');
        }
        refresh();
      });
    });
    overlay.querySelector('#dgForceElement')?.addEventListener('click', () => {
      ds.nextDragonTime = 0;
      logFn('🐲 下一次刷新将提前生成一条元素龙', 'spawn');
    });
    overlay.querySelector('#dgForceAncient')?.addEventListener('click', () => {
      ds.soulUnlocked = true; ds.nextDragonTime = 0;
      logFn('🐉 下一次刷新将提前生成一条远古龙', 'spawn');
    });
    overlay.querySelector('#dgToggleSpawn')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.spawn = CONFIG.dragonToggles.spawn === false;
      logFn(`🐲 巨龙生成：${CONFIG.dragonToggles.spawn ? '开' : '关'}`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgToggleEffect')?.addEventListener('click', () => {
      CONFIG.dragonToggles = CONFIG.dragonToggles || {};
      CONFIG.dragonToggles.effect = CONFIG.dragonToggles.effect === false;
      logFn(`🐉 巨龙效果：${CONFIG.dragonToggles.effect ? '开' : '关'}`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgVampTowerScaleApply')?.addEventListener('click', () => {
      const inp = overlay.querySelector('#dgVampTowerScale');
      const v = parseFloat(inp?.value);
      if (!Number.isFinite(v) || v < 0 || v > 100) { logFn('⚠️ 龙魂吸血·塔缩放需要 0~100 之间的数字', 'error'); return; }
      CONFIG.dragonSouls = CONFIG.dragonSouls || {};
      CONFIG.dragonSouls.vampTowerScalePct = v;
      logFn(`🩸 龙魂吸血·塔缩放已更新为 ${v}%（暗/毒/血三条魂的吸血类加成对塔生效值随即改变）`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgKillAll')?.addEventListener('click', () => {
      // 走正常的 entity:death 结算，不是直接 splice 数组——绕过去的话"编辑器杀的龙
      // 不给击杀奖励"，玩家清场调试后回来发现进度没变化，会以为清场按钮是坏的。
      const ec = app?.entityContainer;
      const dragons = ec?.getAll ? ec.getAll(true).filter(e => e.type === 'dragon') : [];
      for (const d of dragons) {
        d.currentHP = 0; d.alive = false;
        app?.eventBus?.emit?.('entity:death', { entityId: d.id });
      }
      logFn(`💀 已清场 ${dragons.length} 条龙（正常死亡结算，奖励照发）`, 'spawn');
      refresh();
    });
    overlay.querySelector('#dgResetProgress')?.addEventListener('click', () => {
      ds.resetRun?.();
      logFn('↺ 巨龙进度已清空', 'spawn');
      refresh();
    });
  },

  // ==================== 天气 ====================
  // 内容/交互全部还在 WeatherPanel.js 里（_renderConfigBody/_bindConfigBody），
  // 这里只是把它接到模板编辑器的页面容器上，不重复实现一遍。预报图原样保留。
  _renderGameplayWeatherContent() {
    return WeatherPanel._renderConfigBody();
  },
  _bindGameplayWeatherEvents(overlay, logFn) {
    WeatherPanel._bindConfigBody(overlay, logFn);
  },

  // ==================== 熵 · 世界耦合 ====================
  _COUPLINGS: [
    { key: 'dayNight',          label: '昼夜 → 攻守', hint: '白天小兵占优 / 夜晚防御塔占优（双方对称）' },
    { key: 'entropyToUnits',    label: '熵 → 单位',   hint: '高熵利红（混乱）、低熵利蓝（秩序）' },
    { key: 'entropyToWeather',  label: '熵 → 天气',   hint: '熵越高极端天气越频繁' },
    { key: 'entropyToDayNight', label: '熵 → 昼夜',   hint: '熵越高夜晚越长' },
  ],
  _WORLD_FIELDS: [
    { path: 'dayPeriodSec', label: '一天时长(秒)', step: 30 },
    { path: 'dayNightBonus.day.moveSpeedPct',    label: '白天·小兵移速(%)', step: 1 },
    { path: 'dayNightBonus.day.attackDamagePct', label: '白天·小兵攻击(%)', step: 1 },
    { path: 'dayNightBonus.night.attackDamagePct', label: '夜晚·塔攻击(%)', step: 1 },
    { path: 'dayNightBonus.night.attackRangeFlat', label: '夜晚·塔射程', step: 5 },
    { path: 'entropyBonus.attackDamagePct', label: '熵·攻击幅度(%)', step: 1 },
    { path: 'entropyBonus.armorFlat',       label: '熵·护甲幅度',     step: 1 },
    { path: 'entropy.coreTotal',    label: '核总数（恒定）', step: 1 },
    { path: 'entropy.chargePerCore', label: '夺一核所需充能', step: 10 },
    { path: 'entropy.chargeDecayPerSec', label: '充能每秒衰减', step: 0.1 },
    { path: 'entropy.coreReturnSec', label: '归还一核间隔(秒)', step: 10 },
    { path: 'entropy.gainMinion',   label: '充能·击杀小兵', step: 1 },
    { path: 'entropy.gainTower',    label: '充能·摧毁建筑', step: 5 },
    { path: 'entropy.volatilityPct', label: '红核·波动放大(%)', step: 1 },
    { path: 'entropy.nightStretchPct', label: '熵·夜晚延长(%)', step: 5 },
  ],
  // v51.1：全局法力回复（用户："全局生效，每个单位每次受击获得2，每次攻击获得1……
  // 先都按这个写，可修改"）。放在这一页是因为它和上面的世界数值一样，都是
  // 直接改 CONFIG 上某条路径的全局调参，复用同一套 _getPath/_setPath 逻辑，
  // 不用为了两个数字再建一整个新页面。
  _MANA_TUNING_FIELDS: [
    { path: 'tuning.mana.onAttack', label: '全局·每次攻击回复法力', step: 0.5 },
    { path: 'tuning.mana.onHitTaken', label: '全局·每次受击回复法力', step: 0.5 },
  ],
  _getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },
  _setPath(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const t = ks.reduce((o, k) => (o[k] = o[k] || {}), obj);
    t[last] = v;
  },

  _renderGameplayEntropyContent() {
    const W = CONFIG.world || {};
    const cp = W.couplings || {};
    const ws = window.CTX?.__world;
    const live = ws
      ? `<div class="pick-desc-box" style="margin-bottom:8px;font-size:11px;">
           ${ws.entropySystem ? ws.entropySystem.describe() : ''}<br>
           昼夜：${ws.daynight.label}（相位 ${ws.daynight.phase.toFixed(2)}）
         </div>`
      : `<div class="pick-desc-box" style="margin-bottom:8px;font-size:11px;">（世界状态未接入，进入对战后显示实时值）</div>`;

    const toggles = this._COUPLINGS.map(c => {
      const on = cp[c.key] === true;
      return `<div class="slider-row"><label title="${c.hint}">${c.label}</label>
        <button class="editor-tab ${on ? 'active' : ''}" data-coupling="${c.key}" style="flex:1;font-size:11px;">
          ${on ? '✅ 已开启' : '⭕ 已关闭'}</button></div>`;
    }).join('');

    const fields = this._WORLD_FIELDS.map(f => {
      const v = this._getPath(W, f.path);
      if (v === undefined) return '';
      return `<div class="slider-row"><label style="font-size:11px;">${f.label}</label>
        <input type="number" class="world-field" data-path="${f.path}" step="${f.step}" value="${v}" style="width:90px;"></div>`;
    }).join('');
    const manaFields = this._MANA_TUNING_FIELDS.map(f => {
      const v = this._getPath(CONFIG, f.path);
      if (v === undefined) return '';
      return `<div class="slider-row"><label style="font-size:11px;">${f.label}</label>
        <input type="number" class="mana-tuning-field" data-path="${f.path}" step="${f.step}" value="${v}" style="width:90px;"></div>`;
    }).join('');

    // 用户定稿：不用再有言语描述——原来这里有一段"每条耦合独立开关…
    // 熵：0=绝对秩序 0.5=中性 1=绝对混乱"的说明段落，含义已经在 _COUPLINGS 各条
    // 的 title/hint 里、以及下面滑条本身的取值范围里，去掉重复的大段文字。
    return `
      ${live}
      ${toggles}
      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        ${fields}
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button id="setWorldApplyBtn" style="flex:1;">✅ 应用世界数值</button>
          <button id="setWorldResetEntropyBtn" style="flex:1;">↺ 三核归零</button>
        </div>
      </div>
      <div style="margin-top:8px;border-top:1px solid #2d3540;padding-top:8px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">法力（全局，用户定稿"先都按这个写，可修改"）</div>
        ${manaFields}
        <button id="setManaTuningApplyBtn" style="margin-top:6px;width:100%;">✅ 应用法力回复数值</button>
      </div>`;
  },

  _bindGameplayEntropyEvents(overlay, logFn) {
    const render = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderGameplayEntropyContent();
      this._bindGameplayEntropyEvents(overlay, logFn);
    };
    overlay.querySelectorAll('[data-coupling]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.coupling;
      CONFIG.world.couplings[k] = !CONFIG.world.couplings[k];
      logFn(`🌍 耦合「${k}」：${CONFIG.world.couplings[k] ? '开' : '关'}`, 'spawn');
      render();
    }));
    overlay.querySelector('#setWorldApplyBtn')?.addEventListener('click', () => {
      let n = 0;
      overlay.querySelectorAll('.world-field').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { this._setPath(CONFIG.world, inp.dataset.path, v); n++; }
      });
      logFn(`🌍 世界数值已更新（${n} 项）`, 'spawn');
      render();
    });
    overlay.querySelector('#setWorldResetEntropyBtn')?.addEventListener('click', () => {
      window.CTX?.__world?.entropySystem?.reset();
      logFn('↺ 三核已归零（熵回到中性）', 'spawn');
      render();
    });
    overlay.querySelector('#setManaTuningApplyBtn')?.addEventListener('click', () => {
      let n = 0;
      overlay.querySelectorAll('.mana-tuning-field').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v >= 0) { this._setPath(CONFIG, inp.dataset.path, v); n++; }
      });
      logFn(`⚡ 全局法力回复数值已更新（${n} 项）`, 'spawn');
      render();
    });
  },
};
