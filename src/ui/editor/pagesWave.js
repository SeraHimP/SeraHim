/**
 * pagesWave.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 模板页：小兵生成规则 / 巨龙刷新与强度 / 成长与屠戮 / 出兵编排
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { mapLaneIds, laneLabel } from '../laneLabels.js';
import { buildWaveOrder, WAVE_CONDITIONS, whenOptionGroups, hasFactionComposition, hasLaneComposition } from '../../data/waveComposition.js';
import { dragonCfg, dragonStatsAt, dragonIntervalAt, rangeMid } from '../../data/dragonCurve.js';

export const EDITOR_PAGES_WAVE = {
  // ==================== 巨龙：刷新节奏与强度曲线 ====================
  // 这一页此前是**空的**（"巨龙暂无可编辑的固定模板"），而 DragonSystem 里刷新时间表
  // 和三条属性曲线全是写死的魔数；CONFIG.gameRules 里倒是躺着七个 dragonXxx 键，
  // 却没有任何一处代码读它们 —— 摆出来只会让人改了没反应。
  // 现在那七个死键已删除，真正生效的参数搬进 CONFIG.gameRules.dragon，这一页是它的入口。
  //
  // 预览用的是 dragonStatsAt / dragonIntervalAt —— 和引擎**同一个函数**（data/dragonCurve.js），
  // 所以"面板显示第 3 条龙 2400 血、实际刷出来不是"这种事在结构上就不可能发生。
  _renderDragonRuleContent() {
    const d = (CONFIG.gameRules.dragon = CONFIG.gameRules.dragon || {});
    const c = dragonCfg();
    const num = (k, label, v, step, hint) => `<div class="slider-row">
      <label style="width:150px;" title="${hint || ''}">${label}</label>
      <input type="number" class="dragonrule-input" data-dkey="${k}" step="${step}"
             value="${v === null || v === undefined ? '' : v}" style="width:100px;"></div>`;
    // v51.9：刷新节奏改成随机区间（用户定稿：首条 60~480s、之后每条 240~360s），
    // 复用 elementIntervals 这个输入框原本就是的"逗号分隔文本框"形态——只是语义从
    // "按位置取固定值、越界沿用最后一项"改成"每次都在区间内独立随机取一个值"。
    const range = (k, label, v, hint) => `<div class="slider-row">
      <label style="width:150px;" title="${hint || ''}">${label}</label>
      <input type="text" class="dragonrule-input" data-dkey="${k}" data-drange="1"
             value="${v[0]}, ${v[1]}" style="width:100px;"
             placeholder="最小, 最大"></div>`;

    let html = `<div class="pick-desc-box" style="margin-bottom:10px;">
      🐲 巨龙的强度按<b>第几条龙</b>算，与游戏波次无关。<br>
      早期版本是按 <code>window.waveNumber</code> 算的，而龙按固定时间表刷新 ——
      7 分钟后刷第 2 条龙时波次可能已经到 10+，双抗直接飙到几百。这个口径不要改回去。
    </div>`;

    html += `<div style="font-size:12px;color:var(--text-dim);margin:10px 0 4px;">
      刷新节奏（秒，随机区间——每局/每次都在【最小,最大】里独立取一个值，不是固定时间表）</div>`;
    html += range('firstDelay', '首条巨龙', c.firstDelay, '开局多久后刷第一条，每局在区间内随机取一次');
    html += range('elementIntervals', '元素龙后续间隔', c.elementIntervals, '第2条起的每一条元素龙，各自独立随机取');
    html += range('ancientFirstDelay', '首条远古龙', c.ancientFirstDelay, '成魂结算后到第一条远古龙');
    html += range('ancientInterval', '远古龙后续间隔', c.ancientInterval, '');

    const CURVES = [['maxHP', '生命'], ['resist', '双抗（护甲=魔法抗性）'], ['attackDamage', '攻击力']];
    html += `<div style="font-size:12px;color:var(--text-dim);margin:14px 0 4px;border-top:1px solid #2d3540;padding-top:10px;">
      强度曲线　<span style="font-size:10px;color:var(--text-mute);">
      第 w 条 = w≤拐点 ? 起点+(w−1)×前段增量 : 起点+(拐点−1)×前段增量+(w−拐点)×后段增量，再按上限截顶</span></div>`;
    for (const [key, label] of CURVES) {
      const sp = c.curve[key];
      html += `<div style="border:1px solid #2d3540;border-radius:4px;padding:8px;margin-bottom:8px;">
        <div style="font-size:12px;margin-bottom:6px;">${label}</div>
        ${num(`curve.${key}.base`, '第 1 条的值', sp.base, 1, '')}
        ${num(`curve.${key}.step`, '拐点前每条 +', sp.step, 1, '')}
        ${num(`curve.${key}.knee`, '拐点（第几条）', sp.knee, 1, '')}
        ${num(`curve.${key}.lateStep`, '拐点后每条 +', sp.lateStep, 1, '')}
        ${num(`curve.${key}.cap`, '上限（留空 = 不封顶）', sp.cap, 1, '留空表示不截顶')}
      </div>`;
    }

    html += `<div style="font-size:12px;color:var(--text-dim);margin:10px 0 4px;">远古龙修正（同序号曲线之上）</div>`;
    html += num('ancient.hpMult', '生命 ×', c.ancient.hpMult, 0.05, '');
    html += num('ancient.resistAdd', '双抗 +', c.ancient.resistAdd, 5, '');
    html += num('ancient.adMult', '攻击 ×', c.ancient.adMult, 0.05, '');

    // ---- 预览：与引擎共用 dragonStatsAt/dragonIntervalAt ----
    // v51.9：刷新节奏改成随机区间之后，预览没法再画出唯一确定的时间表——这里改用
    // 区间中点（dragonIntervalAt 现在返回的就是中点）当代表值，标题也说清楚这只是
    // "大致节奏"，实际每局会在区间内浮动。
    let t = rangeMid(c.firstDelay), rows = '';
    for (let i = 1; i <= 6; i++) {
      const st = dragonStatsAt(i, false);
      const mm = `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
      rows += `<tr><td style="padding:2px 8px;">第 ${i} 条</td><td style="padding:2px 8px;">${mm}</td>
        <td style="padding:2px 8px;">${st.maxHP}</td><td style="padding:2px 8px;">${st.armor}</td>
        <td style="padding:2px 8px;">${st.attackDamage}</td></tr>`;
      t += dragonIntervalAt({ soulUnlocked: false, elementSpawned: i });
    }
    const anc = dragonStatsAt(1, true);
    html += `<div style="margin-top:14px;border-top:1px solid #2d3540;padding-top:10px;">
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">预览（按<b>已保存</b>的配置、取区间中点算出的大致节奏——实际每局会在区间内随机浮动，点【应用】后刷新）</div>
      <table style="font-size:11px;width:100%;"><tr style="color:#8b949e;">
        <td style="padding:2px 8px;">序号</td><td style="padding:2px 8px;">出现时刻（中点估算）</td>
        <td style="padding:2px 8px;">生命</td><td style="padding:2px 8px;">双抗</td><td style="padding:2px 8px;">攻击</td></tr>
        ${rows}</table>
      <div style="font-size:11px;color:var(--text-mute);margin-top:6px;">
        首条远古龙：生命 ${anc.maxHP}／双抗 ${anc.armor}／攻击 ${anc.attackDamage}。
        成魂规则：任意一方先攒到 ${CONFIG.gameRules.dragonSoulThreshold ?? 4} 条元素龙击杀
        即刻成魂（先到先得），并列时取击杀最多的元素——不是"打完一批统一结算"。
        更细的双方进度/龙魂管理见「游戏性→巨龙与龙魂」页。</div>
    </div>`;
    return html;
  },

  _applyDragonRuleChanges(overlay, logFn) {
    const d = (CONFIG.gameRules.dragon = CONFIG.gameRules.dragon || {});
    d.curve = d.curve || {}; d.ancient = d.ancient || {};
    let changed = 0, bad = 0;
    overlay.querySelectorAll('.dragonrule-input').forEach(inp => {
      const key = inp.dataset.dkey;
      const raw = (inp.value || '').trim();
      if (inp.dataset.drange === '1') {
        // v51.9：firstDelay/elementIntervals/ancientFirstDelay/ancientInterval
        // 统一走"随机区间"输入：要求恰好两个正数、且最小值不大于最大值（顺序反了
        // 就自动交换，不当错误拒绝——用户体验优先，不用为了顺序重填一遍）。
        // 解析失败/数量不对时退回出厂区间，不把会让 nextDragonTime 变 NaN 的
        // 半成品状态存进配置（同 v51.8 之前 elementIntervals 那条老规矩）。
        const nums = raw.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (nums.length !== 2 || nums.some(v => !(v > 0) && v !== 0)) { bad++; return; }
        const [a, b] = nums;
        d[key] = a <= b ? [a, b] : [b, a];
        changed++;
        return;
      }
      const path = key.split('.');
      // 上限留空 = 不封顶（null），这是合法取值，不能当"没填"跳过
      const isCap = path[path.length - 1] === 'cap';
      let v;
      if (raw === '') { if (!isCap) return; v = null; }
      else { v = parseFloat(raw); if (isNaN(v)) { bad++; return; } }
      let node = d;
      for (let i = 0; i < path.length - 1; i++) node = (node[path[i]] = node[path[i]] || {});
      node[path[path.length - 1]] = v;
      changed++;
    });
    logFn(`🐲 巨龙规则已更新（${changed} 项${bad ? `，${bad} 项填写无效已跳过` : ''}）。已在场上的龙不追溯`, 'spawn');
  },

  // ==================== 成长与屠戮（战斗数值，与"什么时候出兵"无关）====================
  // Q2：这两组数值原先硬编码在 main.js / 技能文件里，改平衡要翻源码。现在住在 CONFIG，
  // 面板改完立刻对【之后生成】的小兵生效（已出场的沿用出生时的成长快照）。
  _renderGrowthContent(type) {
    let html = `<div style="padding:4px 0;">`;
    html += `<div class="pick-desc-box" style="margin-bottom:10px;">
      📈 这里只管【单位有多强】，不管【什么时候出多少】—— 后者在「出兵编排」tab。<br>
      成长按<b>波次</b>线性累加，单位出生时结算一次并写死；已经在场上的兵不会追溯。
    </div>`;
    const G = CONFIG.battleGrowth?.[type];
    if (G) {
      html += `<div style="border-top:1px solid #2d3540;padding-top:10px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">📈 对战成长（每波固定增量）</div>
        <div class="slider-row"><label>最大生命 /波</label>
          <input type="number" class="growth-input" data-gkey="hp" step="0.1" value="${G.hp}" style="width:90px;"></div>
        <div class="slider-row"><label>攻击力 /波</label>
          <input type="number" class="growth-input" data-gkey="ad" step="0.05" value="${G.ad}" style="width:90px;"></div>
        <div class="slider-row"><label>双抗 /波</label>
          <input type="number" class="growth-input" data-gkey="res" step="0.05" value="${G.res}" style="width:90px;"></div>
        <div class="slider-row"><label>法术强度 /波</label>
          <input type="number" class="growth-input" data-gkey="ap" step="0.1" value="${G.ap ?? 0}" style="width:90px;"></div>
        <div style="font-size:11px;color:var(--text-mute);margin-top:4px;">
          第 N 波的加值 = 上面四项 ×(N−1)。当前第 <b>${Math.max(1, window.waveNumber || 1)}</b> 波，
          该兵种加值：生命 +${(G.hp * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}、
          攻击 +${(G.ad * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}、
          双抗 +${(G.res * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}、
          法术强度 +${((G.ap ?? 0) * Math.max(0, (window.waveNumber || 1) - 1)).toFixed(1)}。</div>
      </div>`;
    } else {
      html += `<div style="color:#8b949e;font-size:12px;">该兵种未配置对战成长（每波数值恒定）。</div>`;
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
    html += `<div style="margin-top:10px;font-size:11px;color:var(--text-mute);">改完点【应用】写入，对之后生成的单位生效。</div>`;
    html += `</div>`;
    return html;
  },

  // ==================== 出兵顺序（对战模式，全局；用户："再加'出兵顺序'自定义"）====================
  // 数据就是 CONFIG.gameRules.laneWaveComposition —— 数组顺序即出兵先后。
  // 面板直接编排这个数组：上下移动 / 增删条目 / 改兵种·数量·起始波次·周期·触发条件，
  // 再配一个"第 N 波会出什么"的实时预览（预览与真实出兵共用 buildWaveOrder，不会骗人）。
  _waveOrderPreviewWave: 1,
  _waveOrderPreviewNexusDown: false,
  // 分路条件（外/内/水晶塔/召唤水晶）得指明看哪一路，否则"本路"没有着落
  _waveOrderPreviewLane: 'mid',

  // v43 Q5：编排的第二个维度 —— 路。'all' = 该阵营的全部路（原有行为）。
  // 具体路 id 由**当前地图**决定（峡谷 top/mid/bot、扭曲丛林 top/bot、嚎哭深渊 mid），
  // 所以页签是现生成的，不写死。
  _waveLaneScope: 'all',

  /** 当前地图的路列表（拿不到地图时退回三路，单测下也有东西可显示）。 */
  // v46：这两个方法搬到 ui/laneLabels.js 了 —— 添加单位窗口也要用同一套判据，
  // 而它原来把 top/mid/bot 写死在模板字符串里（扭曲丛林没有中路，照样显示三条）。
  // 抄一份过去就是第三份实现，所以抽成共用的，两边都调它。
  _mapLaneIds() { return mapLaneIds(); },
  _laneLabel(id) { return laneLabel(id); },

  /**
   * 当前作用域下【要编辑哪一份编排】。作用域是二维的：阵营 × 路。
   *   共享 + 全部路 → CONFIG.gameRules.laneWaveComposition            （最笼统，出厂基准）
   *   共享 + 某一路 → CONFIG.gameRules.laneWaveCompositionByLane[路]
   *   蓝/红 + 全部路 → CONFIG.factionOverrides[阵营].laneWaveComposition
   *   蓝/红 + 某一路 → CONFIG.factionOverrides[阵营].laneWaveCompositionByLane[路]
   * 读写共用这一个入口，避免"面板改 A、出兵读 B"。
   * create=false（只读渲染）时，某一格还没有自己的编排就**显示它实际会生效的那一份**
   *（顺序与 waveComposition.compositionFor 完全一致），一旦真的动手改才复制成本格专属。
   */
  _woList(create = false) {
    const gr = CONFIG.gameRules;
    gr.laneWaveComposition = gr.laneWaveComposition || [];
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const isLane = lane && lane !== 'all';
    // ==================== v51 bug 修复："删光所有兵种后突然恢复默认编排" ====================
    // 用户："出兵排版……要是把所有兵删除之后就突然恢复默认值了，要求也可以没有
    //       （相当于不出兵）。"
    //
    // 根因在这里原来的 `nonEmpty`：它用 **length** 判"这一格有没有自己的编排"——
    // `(Array.isArray(a) && a.length) ? a : null`。用户把某一格的编排逐条删空之后，
    // `box.laneWaveComposition` 变成了一个**长度为 0 的真实数组**（不是没有），
    // 但 `nonEmpty([])` 因为 `a.length` 是 0（假值）而判它"不算有"，于是 `_woList`
    // 掉进"本格还没有 → 用继承来的那份"分支，界面立刻弹回默认编排——
    // 用户删的操作看起来像是"没生效，自动还原了"。
    //
    // 治本：改成只认**这个键是不是数组**（存不存在），不看长度。空数组本身就是
    // 一个合法的、用户主动选择的"这一格不出兵"状态，与"从没编辑过、该看继承值"
    // 是两件事，必须用两个不同的判据区分——不能用同一个"数组是否非空"去猜。
    const owned = (a) => Array.isArray(a) ? a : null;

    // ---- 本格已经有自己的编排？直接用（哪怕是空数组）----
    let box;
    if (isFac) {
      CONFIG.factionOverrides = CONFIG.factionOverrides || {};
      CONFIG.factionOverrides[f] = CONFIG.factionOverrides[f] || {};
      box = CONFIG.factionOverrides[f];
    } else {
      box = gr;
    }
    if (isLane) {
      const own = owned(box.laneWaveCompositionByLane?.[lane]);
      if (own) return own;
    } else if (isFac) {
      const own = owned(box.laneWaveComposition);
      if (own) return own;
    } else {
      return gr.laneWaveComposition;   // 共享 + 全部路 = 出厂基准本身（这一格向来就是"数组本身"，不受这条 bug 影响）
    }

    // ---- 本格从没被编辑过：按 compositionFor 的顺序找出"实际生效的那一份"作为继承基准 ----
    const inherited =
         (isLane && isFac && owned(CONFIG.factionOverrides?.[f]?.laneWaveComposition))
      || (isLane && owned(gr.laneWaveCompositionByLane?.[lane]))
      || gr.laneWaveComposition;
    if (!create) return inherited;   // 只读时显示继承来的那份

    // 首次编辑本格：从继承来的那份复制一份，之后各改各的
    const copy = inherited.map(r => ({ ...r }));
    if (isLane) {
      box.laneWaveCompositionByLane = box.laneWaveCompositionByLane || {};
      box.laneWaveCompositionByLane[lane] = copy;
    } else {
      box.laneWaveComposition = copy;
    }
    return copy;
  },
  _woSetList(arr) {
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const box = isFac
      ? ((CONFIG.factionOverrides = CONFIG.factionOverrides || {},
          CONFIG.factionOverrides[f] = CONFIG.factionOverrides[f] || {}))
      : CONFIG.gameRules;
    if (lane && lane !== 'all') {
      box.laneWaveCompositionByLane = box.laneWaveCompositionByLane || {};
      box.laneWaveCompositionByLane[lane] = arr;
    } else {
      box.laneWaveComposition = arr;
    }
  },
  /** 清掉当前这一格的专属编排（回到它继承的那一份）。 */
  _woClearCell() {
    const f = this._factionScope, lane = this._waveLaneScope;
    const isFac = f && f !== 'shared';
    const box = isFac ? CONFIG.factionOverrides?.[f] : CONFIG.gameRules;
    if (!box) return;
    if (lane && lane !== 'all') { if (box.laneWaveCompositionByLane) delete box.laneWaveCompositionByLane[lane]; }
    else if (isFac) delete box.laneWaveComposition;
  },
  /** 当前格子有没有自己的编排（决定角标与"清除本格"按钮）。 */
  _woCellOwned() {
    const f = this._factionScope, lane = this._waveLaneScope;
    if (lane && lane !== 'all') return hasLaneComposition(f, lane);
    return f && f !== 'shared' ? hasFactionComposition(f) : false;
  },

  _renderWaveOrderContent() {
    const gr = CONFIG.gameRules;
    const list = this._woList(false);
    const types = this._TPL_MINION_TYPES;
    const app = window.CTX?.__app || window.__app;
    const laneWaveSystem = app?.laneWaveSystem;
    // v51.26 修复：用户报"经典模式下出兵是对的（没有攻城车/术士兵之类的），但模板
    // 编辑器-出兵编排窗口里显示的不正常"——排查结论：这里原来只读全局
    // CONFIG.gameRules.spawnEnabled，从没读过 mapSystem.currentMap?.spawnEnabled。
    // 真正驱动出兵的 LaneWaveSystem.js 会把地图覆写摊平合并进规则、且地图覆写优先
    // （见该文件 `_mapSE ? {...gr, spawnEnabled:{...gr.spawnEnabled, ..._mapSE}}`），
    // 经典模式下术士/蚀骨/攻城车/图腾被地图层关掉了，这里却仍显示全局默认"已启用"——
    // 不只是显示错，这几个开关是即点即生效的控件，点了在经典模式下真的没反应
    // （地图覆写永远赢，合并顺序见下面 EN 的算法，与 LaneWaveSystem 保持同一个口径）。
    const mapSE = app?.mapSystem?.currentMap?.spawnEnabled || null;
    const EN = { ...(gr.spawnEnabled || {}), ...(mapSE || {}) };

    const cell = (rule, i, key, min, step) =>
      `<input type="number" class="wo-field" data-idx="${i}" data-field="${key}" min="${min}" step="${step}"
              value="${rule[key] ?? ''}" placeholder="${key === 'count' ? 1 : (key === 'everyN' ? 1 : 0)}">`;

    // 用户定稿："设置窗口只留系统设置，游戏性设置整合到模板编辑器里"——
    // 小兵波次的运行时控制（暂停/立即下一波/间隔秒数）原来在设置面板的"波次"tab，
    // 现在搬到这里，紧挨着它管的这份编排数据，不再和流程/画质那些纯系统设置混在一起。
    const runtime = `
      <div class="editor-section">
        <h4>⚔️ 运行时控制</h4>
        <div class="slider-row"><label>双方波次生成</label>
          <button id="woToggleLaneWaveBtn" style="flex:1;">${laneWaveSystem?.paused ? '▶ 恢复' : '⏸ 暂停'}</button>
          <button id="woSkipLaneWaveBtn" style="flex:1;">⏭ 立即下一波</button>
        </div>
        <div class="slider-row"><label>波次生成间隔（秒）</label>
          <input type="number" id="woLaneWaveInterval" class="editor-number" value="${laneWaveSystem?.waveInterval || 30}" min="5" step="1">
        </div>
      </div>`;

    // ==================== v51：整页按 .editor-section 分卡片（用户："出兵排版的界面
    // 我觉得好乱"）====================
    // 排查结论：CSS 本身（.wo-row 的列宽）v43 就已经统一过、没有错位；"乱"来自
    // ①兵种总开关 / ②出兵编排 / 预览 这几大块此前只用内联样式的小标题分隔，视觉上
    // 是一整面墙。这里改成与上面"运行时控制"（runtime 变量）同一套 .editor-section
    // + <h4> 卡片，读起来是几张边界清楚的卡片，不是一整页平铺的控件。
    let html = runtime + `<div class="pick-desc-box" style="margin-bottom:10px;">
      🧬 出什么兵、按什么顺序出，全在这一页。分两段：<br>
      　<b>① 兵种总开关</b>　关掉的兵种下面怎么排都不会出。<br>
      　<b>② 出兵编排</b>　数组顺序 = 出兵先后。
    </div>`;

    // ---- ① 兵种总开关（原「生成规则」里逐个类型翻页才能看到，现在一屏全景）----
    // v51.26：被当前地图/模式覆写锁住的兵种（如经典模式关掉的术士/蚀骨/攻城车/图腾）
    // 显式标成🔒锁定态，不响应点击——不能让玩家点了没反应却看不出原因（见上面 EN 的注释）。
    html += `<div class="editor-section"><h4>① 兵种总开关</h4>
    <div class="editor-tabs" style="flex-wrap:wrap;">
      ${types.map(t => {
        const on = EN[t] !== false;
        const locked = mapSE && Object.prototype.hasOwnProperty.call(mapSE, t);
        const title = locked
          ? `当前地图/模式已将此项强制${on ? '启用' : '关闭'}，这里改不了`
          : (on ? '点击停用' : '点击启用');
        return `<button class="editor-tab ${on ? 'active' : ''}" data-spawn-toggle="${t}"
                 ${locked ? 'data-spawn-locked="1"' : ''} title="${title}"
                 style="font-size:11px;${locked ? 'opacity:0.7;cursor:not-allowed;' : ''}">
          ${locked ? '🔒' : (on ? '✅' : '⛔')} ${this._iconOf(t)}${this._labelOf(t)}
        </button>`;
      }).join('')}
    </div></div>`;

    const _f = this._factionScope;
    const _lane = this._waveLaneScope || 'all';
    const _own = this._woCellOwned();
    const _who = _f === 'blue' ? '🔵蓝方' : _f === 'red' ? '🔴红方' : '双方共享';
    const _laneTxt = _lane === 'all' ? '全部路' : this._laneLabel(_lane);
    // v43 Q5：路的页签。**按当前地图的 lanes 现生成** —— 峡谷 3 路、扭曲丛林 2 路、
    // 嚎哭深渊 1 路，写死三路的话在后两张图上会摆出根本不存在的页签
    //（用户："每个地图的路数不同，UI上记得做区分！"）。
    const _laneIds = this._mapLaneIds();
    const _mapLabel = ((window.CTX?.__app || window.__app)?.mapSystem?.currentMap?.label) || '当前地图';
    html += `<div class="editor-section"><h4 style="display:flex;align-items:center;gap:8px;">
      <span>② 出兵编排（数组顺序 = 出兵先后）</span>
      <span style="font-size:10px;font-weight:400;color:${_own ? '#58a6ff' : 'var(--text-mute)'};">
        作用域：${_who} × ${_laneTxt}${_own ? '（本格已有独立编排）' : '（当前显示继承来的那份，一改就会复制成本格专属）'}
      </span>
      ${_own ? `<button id="woClearFaction" style="margin-left:auto;font-size:10px;padding:1px 8px;border-radius:4px;cursor:pointer;">🧹 清除本格编排</button>` : ''}
      </h4>`;
    html += `<div class="editor-tabs" style="flex-wrap:wrap;margin-bottom:6px;">
      <span style="font-size:10px;color:var(--text-mute);align-self:center;margin-right:6px;">路（${_mapLabel}，${_laneIds.length} 条）：</span>
      <button class="editor-tab ${_lane === 'all' ? 'active' : ''}" data-wo-lane="all" style="font-size:11px;">🌐 全部路</button>
      ${_laneIds.map(id => `<button class="editor-tab ${_lane === id ? 'active' : ''}" data-wo-lane="${id}" style="font-size:11px;">${this._laneLabel(id)}${hasLaneComposition(_f, id) ? ' ●' : ''}</button>`).join('')}
    </div>`;
    html += `<div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
      解析顺序（先命中先用）：<b>本阵营·本路</b> → <b>本阵营·全部路</b> → <b>共享·本路</b> → <b>共享·基准</b>。
      页签上的 ● 表示那一格有自己的编排。</div>`;
    html += `<div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">
      「起始波」之前不出；之后每「每几波」出一次；「生效条件」再叠一层门槛（三者是<b>与</b>的关系）。<br>
      条件里的<b>本路</b>指这条规则当前正在为之出兵的那一路；枢纽塔/水晶枢纽不分路，按<b>全场</b>算。
      条件不成立的规则本波直接跳过，不影响同一编排里的其它规则。</div>`;

    // 表头与每一行走**同一套 grid 列宽**（--wo-cols）。原来两边各写一串固定 px，
    // 表头 52/96/62/62/62 和行里的按钮/输入框实际宽度对不上，列标题整体左偏 ——
    // 用户说的"UI 显示格式有些混乱"就是这个。现在列宽只有一处定义，不可能再错位。
    html += `<div class="wo-row wo-head">
      <span>顺序</span><span>兵种</span><span>数量</span><span>起始波</span>
      <span>每几波</span><span>生效条件</span><span></span>
    </div>`;

    if (list.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">编排为空 —— 当前对战不会生成任何小兵。</div>`;
    }
    const groups = whenOptionGroups();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const off = EN[r.type] === false;
      const cond = WAVE_CONDITIONS[r.when || ''] || WAVE_CONDITIONS[''];
      // 需要参数的条件（"游戏已进行 ≥ N 秒"）才显示那个数值框。
      // 无条件显示的话，用户会对着一个"总是"规则旁边的空数字框琢磨半天它管什么。
      const argBox = cond.arg
        ? `<input type="number" class="wo-field wo-arg" data-idx="${i}" data-field="whenArg"
                  min="${cond.arg.min ?? 0}" step="${cond.arg.step ?? 1}"
                  value="${r.whenArg ?? ''}" placeholder="${cond.arg.def}"
                  title="${cond.arg.label}">`
        : '';
      html += `<div class="wo-row${off ? ' wo-off' : ''}">
        <span class="wo-move-cell">
          <button class="wo-move" data-idx="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="wo-move" data-idx="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
        </span>
        <select class="wo-field" data-idx="${i}" data-field="type">
          ${types.map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${this._iconOf(t)} ${this._labelOf(t)}</option>`).join('')}
        </select>
        ${cell(r, i, 'count', 0, 1)}${cell(r, i, 'fromWave', 0, 1)}${cell(r, i, 'everyN', 1, 1)}
        <span class="wo-when-cell">
          <select class="wo-field" data-idx="${i}" data-field="when">
            ${groups.map(g => `<optgroup label="${g.label}">${g.items.map(o =>
              `<option value="${o.value}" ${(r.when || '') === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</optgroup>`).join('')}
          </select>${argBox}
        </span>
        <button class="wo-del" data-idx="${i}" title="删除这条规则">✕</button>
      </div>`;
    }

    html += `<div style="margin-top:8px;"><button id="woAddBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加一条</button>
      <button id="woResetBtn" style="margin-left:6px;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">↺ 恢复默认编排</button></div>
      </div>`; // 关闭 ② 出兵编排 的 .editor-section

    // ---- 实时预览 ----
    const w = this._waveOrderPreviewWave, nd = this._waveOrderPreviewNexusDown;
    // 预览必须带世界快照。不带的话，依赖建筑/时间的条件按"未知即放行"处理，
    // 预览就会报出实战不会出现的兵 —— 正是这个面板当初要解决的"预览骗人"。
    // 时间由波次推算：对战首波 firstWaveDelay 秒，之后每 waveInterval 秒一波，
    // 与 LaneWaveSystem 读的是同两个键，所以推算口径和实战一致。
    const _wi = window.CTX?.__app?.laneWaveSystem;
    const _first = _wi?.firstWaveDelay ?? CONFIG.gameRules.firstWaveDelay ?? 20;
    const _every = _wi?.waveInterval ?? CONFIG.gameRules.waveInterval ?? 45;
    const _pvTime = Math.max(0, _first + Math.max(0, w - 1) * _every);
    // 建筑普查取【场上真实状态】。没在对战里（没有地图）时给 null，
    // 那些条件就退回"放行"，并在下面的说明里如实写出来，而不是假装算准了。
    const _census = window.CTX?.__app?.mapSystem?.structureCensus?.() || null;
    // 预览按【当前作用域的阵营】算 —— 不传 faction 的话，编了红方专属编排却预览共享的，
    // 就又回到"预览骗人"那个老问题上了。
    const _pf = (this._factionScope && this._factionScope !== 'shared') ? this._factionScope : null;
    const order = buildWaveOrder(w, nd, gr, _pf, {
      gameTime: _pvTime, laneId: this._waveOrderPreviewLane, census: _census,
    });
    html += `<div class="editor-section"><h4>🔍 出兵预览</h4>
      <div class="slider-row" style="gap:8px;">
        <label style="width:auto;">预览第</label>
        <input type="number" id="woPreviewWave" min="0" step="1" value="${w}" style="width:70px;">
        <label style="width:auto;">波，路</label>
        <select id="woPreviewLane" style="width:80px;">
          ${(window.CTX?.__app?.mapSystem?.currentMap?.lanes || [{ id: 'top' }, { id: 'mid' }, { id: 'bot' }])
            .map(l => `<option value="${l.id}" ${l.id === this._waveOrderPreviewLane ? 'selected' : ''}>${l.id}</option>`).join('')}
        </select>
        <button id="woPreviewNexus" class="editor-tab ${nd ? 'active' : ''}" style="flex:1;font-size:11px;">
          ${nd ? '💥 本路水晶已陷落' : '🔮 本路水晶完好'}
        </button>
      </div>
      <div class="pick-desc-box" style="margin-top:6px;">
        共 <b>${order.length}</b> 个单位：${order.length
          ? order.map(t => `${this._iconOf(t)}${this._labelOf(t)}`).join(' → ')
          : '（本波无兵）'}
      </div>
      <div style="font-size:10px;color:var(--text-mute);margin-top:4px;">
        按第 ${w} 波 ≈ 开局 ${Math.floor(_pvTime / 60)}分${String(Math.round(_pvTime % 60)).padStart(2, '0')}秒 推算
        （首波 ${_first}s，之后每 ${_every}s 一波）。
        ${_census
          ? `建筑条件按<b>当前场上</b>的存活情况判定（本路：${this._waveOrderPreviewLane}）。`
          : `<b>当前不在对战中</b>，读不到建筑存活情况 —— 依赖建筑的条件在预览里一律按"成立"算，实战中会真判。`}
      </div>
    </div>`;
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-mute);">
      ①即点即生效；②改完点【应用】写入，下一波起生效。</div>`;
    return html;
  },

  // 兵种总开关：即点即生效（它只是个布尔，没有"批量应用"的必要）。
  // v51.26：锁定态（当前地图/模式覆写了这一项）点击直接短路——改的是全局
  // CONFIG.gameRules.spawnEnabled，但地图覆写在 LaneWaveSystem 里合并时永远赢，
  // 点了也不会真的生效，与其让玩家困惑不如干脆不响应，配合上面渲染时的 title 说明。
  _bindSpawnToggles(overlay, logFn, rerender) {
    overlay.querySelectorAll('[data-spawn-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.spawnLocked) {
          logFn(`🔒 「${this._labelOf(btn.dataset.spawnToggle)}」被当前地图/模式强制锁定，改不了`, 'error');
          return;
        }
        const t = btn.dataset.spawnToggle;
        CONFIG.gameRules.spawnEnabled = CONFIG.gameRules.spawnEnabled || {};
        const now = CONFIG.gameRules.spawnEnabled[t] !== false;
        CONFIG.gameRules.spawnEnabled[t] = !now;
        logFn(`⚙️ 「${this._labelOf(t)}」生成开关：${!now ? '开' : '关'}`, 'spawn');
        // 重绘：编排表里该兵种的行要跟着变灰/变亮，预览也要重算
        if (rerender) rerender(); else {
          btn.classList.toggle('active', !now);
        }
      });
    });
  },

  _bindWaveOrderEvents(overlay, logFn) {
    const gr = CONFIG.gameRules;
    // 只重绘内容区，不整屏重绘 —— 整屏重绘会重建左树并让滚动位置跳回顶部，
    // 而这一页的结构性操作（上移/下移/删/加）是连续动作，跳一次就得重新找位置。
    const rerender = () => {
      overlay.querySelector('#templateContent').innerHTML = this._renderWaveOrderContent();
      this._bindWaveOrderEvents(overlay, logFn);
    };
    this._bindSpawnToggles(overlay, logFn, rerender);
    // 运行时控制（暂停/立即下一波/间隔）：从设置面板搬过来，行为逐位不变。
    const app = window.CTX?.__app || window.__app;
    const laneWaveSystem = app?.laneWaveSystem;
    overlay.querySelector('#woToggleLaneWaveBtn')?.addEventListener('click', () => {
      laneWaveSystem.paused = !laneWaveSystem.paused;
      logFn(laneWaveSystem.paused ? '⏸ 波次已暂停' : '▶ 波次已恢复', 'spawn');
      rerender();
    });
    overlay.querySelector('#woSkipLaneWaveBtn')?.addEventListener('click', () => {
      if (laneWaveSystem) { laneWaveSystem.nextWaveTime = 0; logFn('⏭ 立即生成下一波', 'spawn'); }
    });
    overlay.querySelector('#woLaneWaveInterval')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0 && laneWaveSystem) {
        laneWaveSystem.waveInterval = v;
        if (laneWaveSystem.nextWaveTime > v) laneWaveSystem.nextWaveTime = v;
        logFn(`✅ 波次间隔已设为 ${v}秒`, 'spawn');
      }
    });
    // 结构性操作（上下移/删/加/恢复默认）即点即改数组并重绘；
    // 重绘前先把当前所有输入框的值收回数组，否则移动一行会把没点应用的编辑丢掉。
    const flush = () => this._readWaveOrderInputs(overlay);

    overlay.querySelectorAll('.wo-move').forEach(b => b.addEventListener('click', () => {
      flush();
      const i = +b.dataset.idx, d = +b.dataset.dir, j = i + d;
      const a = this._woList(true);
      if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
      rerender();
    }));
    overlay.querySelectorAll('.wo-del').forEach(b => b.addEventListener('click', () => {
      flush();
      this._woList(true).splice(+b.dataset.idx, 1);
      rerender();
    }));
    overlay.querySelector('#woAddBtn')?.addEventListener('click', () => {
      flush();
      this._woList(true).push({ type: 'melee', count: 1 });
      rerender();
    });
    overlay.querySelectorAll('[data-wo-lane]').forEach(b => b.addEventListener('click', () => {
      flush();
      this._waveLaneScope = b.dataset.woLane;
      // 预览也跟着切到这一路：否则会出现"在上路页签上看着中路的预览"
      if (this._waveLaneScope !== 'all') this._waveOrderPreviewLane = this._waveLaneScope;
      rerender();
    }));
    overlay.querySelector('#woClearFaction')?.addEventListener('click', () => {
      const f = this._factionScope, lane = this._waveLaneScope || 'all';
      this._woClearCell();
      const who = f === 'blue' ? '蓝方' : f === 'red' ? '红方' : '共享';
      const where = lane === 'all' ? '全部路' : this._laneLabel(lane);
      logFn(`🧹 已清除【${who} × ${where}】的独立出兵编排（回到它继承的那一份）`, 'spawn');
      rerender();
    });
    overlay.querySelector('#woResetBtn')?.addEventListener('click', () => {
      this._woSetList(this._DEFAULT_WAVE_COMPOSITION.map(r => ({ ...r })));
      logFn('↺ 出兵编排已恢复默认', 'spawn');
      rerender();
    });
    // 字段改动即时反映到预览
    overlay.querySelectorAll('.wo-field').forEach(el => el.addEventListener('change', () => { flush(); rerender(); }));

    overlay.querySelector('#woPreviewWave')?.addEventListener('change', (e) => {
      this._waveOrderPreviewWave = Math.max(0, parseInt(e.target.value, 10) || 0);
      flush(); rerender();
    });
    overlay.querySelector('#woPreviewLane')?.addEventListener('change', (e) => {
      this._waveOrderPreviewLane = e.target.value;
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
    // 走 _woList(true)：一旦在蓝/红作用域下动了输入框，就复制成该阵营专属编排。
    // 写回共享基准的话，改红方会连蓝方一起改掉 —— 正是这条需求要避免的事。
    const list = this._woList(true);
    overlay.querySelectorAll('.wo-field').forEach(el => {
      const r = list[+el.dataset.idx];
      if (!r) return;
      const f = el.dataset.field;
      if (f === 'type') { r.type = el.value; return; }
      if (f === 'when') {
        if (el.value) r.when = el.value; else delete r.when;
        const arg = WAVE_CONDITIONS[el.value]?.arg;
        // 换成不吃参数的条件时把 whenArg 一并清掉 —— 留着它会在导出的 JSON 里
        // 攒出一堆没人读的字段，下一个人看到会以为这条规则还带着时间门槛。
        if (!arg) delete r.whenArg;
        // 反过来：选了吃参数的条件就【把声明的默认值真的写进去】。
        // 只把它当 placeholder 显示是个陷阱 —— 框里灰着 600、实际按 0 判定，
        // 于是"游戏满 10 分钟才出的兵"第 1 波就出来了，而面板看着完全正常。
        else if (r.whenArg == null) r.whenArg = arg.def;
        return;
      }
      const raw = el.value.trim();
      if (raw === '') {
        // whenArg 清空 → 回到该条件声明的默认值，而不是变成"没有门槛"
        // （"不要门槛"的表达方式是把条件本身换成「总是」）。
        const arg = WAVE_CONDITIONS[r.when || '']?.arg;
        if (f === 'whenArg' && arg) r.whenArg = arg.def; else delete r[f];
        return;
      }
      const v = parseFloat(raw);
      if (!isNaN(v)) r[f] = Math.max(f === 'everyN' ? 1 : 0, f === 'whenArg' ? v : Math.round(v));
    });
    return list;
  },

  _applyWaveOrderChanges(overlay, logFn) {
    const list = this._readWaveOrderInputs(overlay);
    const w = this._waveOrderPreviewWave;
    // 按【当前作用域的阵营】算。不传 faction 的话，编的是红方专属编排、
    // 回执里报的却是共享基准的条数 —— 又一处"面板说的和实际发生的不是一回事"。
    const f = (this._factionScope && this._factionScope !== 'shared') ? this._factionScope : null;
    const n = buildWaveOrder(w, this._waveOrderPreviewNexusDown, CONFIG.gameRules, f).length;
    const who = f ? (f === 'blue' ? '🔵蓝方' : '🔴红方') : '双方共享';
    logFn(`✅ 出兵编排已应用（${who}，${list.length} 条规则；第 ${w} 波将出 ${n} 个单位）`, 'spawn');
  },

  // P2：成长/屠戮从原「生成规则」里拆出来单独应用。它们是战斗数值，
  // 跟"什么时候出多少兵"没有任何关系，塞在一起是原编辑器最误导的一处。
  _applyGrowthChanges(overlay, type, logFn) {
    let changed = 0;
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
    logFn(`✅ 「${this._labelOf(type)}」成长/屠戮已更新（${changed}项）`, 'spawn');
  },
};
