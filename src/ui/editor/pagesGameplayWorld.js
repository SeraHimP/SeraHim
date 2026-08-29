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
import { DRAGON_ELEMENTS } from '../../systems/DragonSystem.js';
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

    // ---- 每个元素一行：击杀数 + 双方的巨龙之力层数 ----
    const cap = CONFIG.dragonPower?.maxStacks ?? 4;
    const powerOf = (fac, el) => (ds.powerStacks?.[fac]?.[el] ?? ds._powerStacks?.[fac]?.[el] ?? null);
    const rows = ELS.map(([el, def]) => {
      const bk = st.factionKills?.blue?.[el] || 0;
      const rk = st.factionKills?.red?.[el] || 0;
      const bp = powerOf('blue', el), rp = powerOf('red', el);
      return `<tr>
        <td style="padding:3px 6px;white-space:nowrap;color:${def.color};">${def.icon} ${def.label}</td>
        <td style="padding:3px 4px;"><input type="number" class="dg-kill-field" data-fac="blue" data-el="${el}"
             value="${bk}" min="0" style="width:52px;"></td>
        <td style="padding:3px 4px;"><input type="number" class="dg-kill-field" data-fac="red" data-el="${el}"
             value="${rk}" min="0" style="width:52px;"></td>
        <td style="padding:3px 6px;font-size:11px;color:var(--text-dim);white-space:nowrap;">
          ${bp === null && rp === null ? '按击杀数发放' : `🔵${bp ?? 0} / 🔴${rp ?? 0}`} · 上限 ${cap}
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="panel-sec">对局态势</div>
      <div class="attrs">
        <div class="a"><label>下一条龙</label><span>${st.soulResolved ? '🐲 远古龙' : '🐉 元素龙'} ${fmt(nextIn)}</span></div>
        <div class="a"><label>成魂门槛</label><span>${thr} 条</span></div>
        ${situation}
      </div>
      <div class="pick-desc-box" style="font-size:11px;line-height:1.7;">
        成魂规则：**任意元素**的龙先攒到 <b>${thr}</b> 条即刻成魂（先到先得），
        魂的元素取该阵营**击杀最多**的那一种，并列时随机。
        每杀一条龙先给一层对应元素的【巨龙之力】（纯属性，上限 ${cap} 层，作用于**全部单位**）；
        成魂后额外解锁该元素的机制（作用于**塔与大型小兵**）。
        远古之力限时 <b>${CONFIG.dragonSouls?.ancient?.durationSec ?? 240}</b> 秒，其余永久。
      </div>

      <div class="panel-sec">击杀数 · 巨龙之力</div>
      <div style="max-height:280px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <tr style="color:var(--text-mute);font-size:10px;">
            <td style="padding:2px 6px;">元素</td><td style="padding:2px 4px;">🔵击杀</td>
            <td style="padding:2px 4px;">🔴击杀</td><td style="padding:2px 6px;">巨龙之力层数</td>
          </tr>
          ${rows}
        </table>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
        <button class="dg-set-kills" data-fac="blue">✅ 应用蓝方击杀</button>
        <button class="dg-set-kills" data-fac="red">✅ 应用红方击杀</button>
      </div>

      ${this._renderGameplayDragonSoulPool(ds)}

      <div class="panel-sec">开关</div>
      <div class="slider-row"><label>巨龙生成</label>
        <button id="dgToggleSpawn" style="flex:1;">${CONFIG.dragonToggles?.spawn !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
      </div>
      <div class="slider-row"><label title="关掉后龙仍会刷，但不再造成/享受任何龙魂加成、宿怨、斩杀等效果">巨龙效果</label>
        <button id="dgToggleEffect" style="flex:1;">${CONFIG.dragonToggles?.effect !== false ? '✅ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
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
   * ==================== v51.5：批量指定龙魂改成卡片池样式 ====================
   * 用户："批量添加龙魂的界面我想要的是这种的（截图：单位编辑窗口的龙魂 tab—
   *        已生效效果 + 巨龙增益池 + 龙魂池，卡片网格，可同时装备多个）。"
   *
   * 原来是下拉框 + 装上/卸下按钮，且语义上"单一替换"（ds.souls[fac] = [soulId]，
   * 一次只能有一条）——现在改成卡片池 + 点击切换，与单位编辑窗口那个 tab
   * 视觉/交互统一，并且真正支持"同时给一方装备多个不同龙魂"：
   *   · 装备走 DragonSystem._toggleSoul（"多选叠加版"，装备/卸下某个龙魂不影响
   *     其它已装备的龙魂——这个方法本来就是为单位编辑窗口那个多选穿梭框写的，
   *     这里换成对**全场该阵营的每个符合条件的单位**都调一遍）；
   *   · 不再用 _equipSoul（"单一替换版"，本来是给"击杀 4 条龙自动成魂"这条
   *     真实规则用的，语义上就是"一次只能有一条"，用在这里天然限制成单选）。
   *
   * 针对性优化（用户："然后你再针对性优化"）：
   *   ① 每张卡片显示"该方当前有多少个单位持有这条魂"的计数——多选之后"点了到底
   *      生不生效"不再需要靠猜；
   *   ② 悬浮显示这条魂的真实说明文案（复用 renderSkillDescription，与单位编辑
   *      窗口那个 tab 同一个数据源，不会各写各的漂出去）；
   *   ③ 新增"清空该方全部龙魂"按钮——原来只能一条条卸，多选之后一条条卸太慢。
   *
   * ⚠️ 这是手动测试工具，不是真实的"击杀 4 条龙自动成魂"那条规则：广播只覆盖
   * 【当前在场】的单位，不写 ds.souls[fac]/ds.soulOwner（那两个字段是自动成魂
   * 规则的状态，手动多选覆盖它们会把"真实进度"污染成假数据）。所以后续新出生的
   * 单位不会自动继承手动点的这些魂——如果需要"这一局从此都有这条魂"，那是
   * 上面"击杀数"那栏该做的事（改到位后会真正触发 _resolveSoul，进正规状态）。
   */
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

  _renderGameplayDragonSoulPool(ds) {
    const ELS = Object.entries(DRAGON_ELEMENTS);
    const pools = ['blue', 'red'].map(fac => {
      const counts = this._dgFactionActiveSouls(ds, fac);
      const cards = ELS.map(([el, d]) => {
        const def = SkillLibrary[d.soul];
        const n = counts[d.soul] || 0;
        return `<div class="pick-card ${n > 0 ? 'selected' : ''}" data-dgsoul-fac="${fac}" data-dgsoul-id="${d.soul}">
          <div class="pick-icon">${def?.icon || d.icon}</div>
          <div class="pick-label">${def?.name || d.label}${n > 0 ? `（${n}）` : ''}</div>
        </div>`;
      }).join('');
      return `
        <div class="panel-sec" style="margin-top:10px;">${fac === 'blue' ? '🔵 蓝方龙魂池' : '🔴 红方龙魂池'}</div>
        <div class="pick-grid">${cards}</div>
        <button class="dg-clear-all-soul" data-fac="${fac}" style="margin-top:4px;">🚫 清空${fac === 'blue' ? '蓝方' : '红方'}全部龙魂</button>`;
    }).join('');
    return `
      <div class="panel-sec">批量指定龙魂（点击切换，双方各自可同时装备多个不同龙魂）</div>
      ${pools}
      <div class="pick-desc-box" id="dgSoulDescBox">点击某项对全场该阵营广播装备/卸下；括号里的数字是该方当前持有这条魂的单位数。</div>`;
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

    overlay.querySelectorAll('.dg-set-kills').forEach(btn => {
      btn.addEventListener('click', () => {
        const fac = btn.dataset.fac;
        ds.factionKills[fac] = ds.factionKills[fac] || {};
        let total = 0;
        overlay.querySelectorAll(`.dg-kill-field[data-fac="${fac}"]`).forEach(inp => {
          const v = Math.max(0, parseInt(inp.value, 10) || 0);
          ds.factionKills[fac][inp.dataset.el] = v;
          total += v;
        });
        ds.factionTotals[fac] = total;
        // 手动改完数值后，按真实规则重新判定一次是否该立即成魂——
        // 不然会出现"手动改到4条了，但要等下一次真实击杀才触发结算"的错觉。
        if (!ds.soulResolved && total >= (ds._soulRule?.threshold ?? 4)) ds._resolveSoul(fac);
        logFn(`🐲 ${fac === 'blue' ? '蓝方' : '红方'}击杀数已手动设置（合计 ${total}）`, 'spawn');
        refresh();
      });
    });
    // v51.5：卡片池点击切换（多选叠加，走 _toggleSoul，与单位编辑窗口那个 tab
    // 同一套语义），悬浮显示真实说明文案，外加"清空该方全部龙魂"快捷按钮。
    overlay.querySelectorAll('[data-dgsoul-id]').forEach(card => {
      card.addEventListener('click', () => {
        const fac = card.dataset.dgsoulFac;
        const soulId = card.dataset.dgsoulId;
        const def = ds.skills[soulId];
        // _toggleSoul 是【逐个单位】各自翻转自己的状态——如果直接对全场广播调用，
        // 场上原本"有的有、没的没"（比如之前单独在某个单位身上手动装过）会被
        // 各自反着翻一次，点一下卡片却出现"有人装上、有人卸下"的混乱结果。
        // 按钮该有的是干净的"全场统一开/关"：先看这条魂当前是不是【一个都没有】，
        // 没有就统一装上；只要有任何一个单位持有，就统一卸给它清空——不看单个
        // 单位自己的状态，只看这次点击该把全场带向哪个方向。
        const before = this._dgFactionActiveSouls(ds, fac)[soulId] || 0;
        const turnOn = before === 0;
        let changed = 0, total = 0;
        ds._grantAll(fac, (e) => {
          total++;
          const has = (e._skillInstances || []).some(i => i.skillId === soulId);
          if (turnOn === !has) { ds._toggleSoul(e, soulId); changed++; }
        });
        logFn(`🐉 ${fac === 'blue' ? '蓝方' : '红方'}龙魂【${def?.name || soulId}】已${turnOn ? '装备' : '卸下'}：影响 ${changed}/${total} 个单位`, 'spawn');
        refresh();
      });
      card.addEventListener('mouseenter', () => {
        const def = ds.skills[card.dataset.dgsoulId];
        const descBox = overlay.querySelector('#dgSoulDescBox');
        if (descBox && def) descBox.textContent = renderSkillDescription(def, null, {}) || def.description || '';
      });
    });
    overlay.querySelectorAll('.dg-clear-all-soul').forEach(btn => {
      btn.addEventListener('click', () => {
        const fac = btn.dataset.fac;
        let n = 0;
        ds._grantAll(fac, (e) => {
          for (const inst of [...(e._skillInstances || [])]) {
            if (inst.skillId.startsWith('dragonsoul_') && inst.skillId !== 'dragonsoul_ancient') {
              ds._toggleSoul(e, inst.skillId); n++;
            }
          }
        });
        logFn(`🚫 ${fac === 'blue' ? '蓝方' : '红方'}全部龙魂已清空（卸下 ${n} 个实例）`, 'spawn');
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
