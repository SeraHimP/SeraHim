import { BASE_WEATHERS, EXTREME_WEATHERS, CLIMATE_TEMPLATES } from '../data/Weather.js';

/**
 * WeatherPanel.js —— 天气 UI
 *
 * 两部分：
 *   1) 滚动预报条：一条横向堆叠色带。左端 = 现在，向右 = 未来。整条从右向左滚动。
 *      每个时刻画一条纵向切片，按各天气占比分配颜色高度（堆叠面积图）。
 *      玩家能看到"雨的蓝色正在变粗"——即将下雨。极端天气在带子上方打标记。
 *   2) 配置面板：总开关 + 每种天气的独立开关 + 当前占比/极端天气实时读数。
 */
// 天气条：总窗口 3 分钟，游标在 20% 处 → 左侧 36s 是【已发生的天气】，右侧 144s 是未来。
const WINDOW_SECONDS = 180;
const CURSOR_RATIO = 0.20;                       // 游标位置（占条宽的比例）
const PAST_SECONDS = WINDOW_SECONDS * CURSOR_RATIO;      // 36s 过去
const FUTURE_SECONDS = WINDOW_SECONDS * (1 - CURSOR_RATIO); // 144s 未来

export const WeatherPanel = {
  _canvas: null,
  _ctx: null,
  _weather: null,

  init(weatherSystem) {
    this._weather = weatherSystem;
    this._canvas = document.getElementById('weatherBar');
    if (this._canvas) this._ctx = this._canvas.getContext('2d');
    // 整条天气带都是配置入口（原来是条上的一个小按钮，太隐蔽）
    const wrap = document.getElementById('weatherWrap');
    if (wrap) wrap.addEventListener('click', () => this.openConfig());
  },

  /** 每帧调用：渲染滚动预报条（天气关闭时隐藏整条） */
  update() {
    const wrap = document.getElementById('weatherWrap');
    if (!wrap || !this._weather) return;
    if (!this._weather.enabled) {
      if (wrap.style.display !== 'none') wrap.style.display = 'none';
      return;
    }
    if (wrap.style.display === 'none') wrap.style.display = '';
    this._renderBar();
    this._renderNow();
  },

  /**
   * 天气条（Q3 重做，追求"好看"）：
   *
   * 视觉层次（从下到上）：
   *   1. 刻度网格：1 分钟一格、共 3 分钟。【锚定在画布上，不动】。
   *   2. 天气色带：堆叠面积图，从右向左滚动。用垂直渐变让每层有体积感，
   *      层与层之间加一道细分隔线，不再是糊成一片的色块。
   *   3. 极端天气：深色覆盖块 + 顶部图标。
   *      图标【锚定在该极端天气时段的中点】，随色带一起平移 —— 不再每帧重算
   *      "画在哪个像素"（那正是图标闪烁的根因）。时段完全滚出左边界才消失。
   *   4. "现在"游标：左端一道亮线 + 小三角。
   */
  _renderBar(cvOverride = null, ctxOverride = null) {
    const ctx = ctxOverride || this._ctx, cv = cvOverride || this._canvas;
    if (!ctx || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 260, cssH = cv.clientHeight || 26;
    if (cv.width !== cssW * dpr || cv.height !== cssH * dpr) {
      cv.width = cssW * dpr; cv.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const forecast = this._weather.getForecast();
    if (!forecast.length) return;
    const now = this._weather.clock;
    // 游标在 20% 处：t=now 映射到 x=0.2W；过去在左、未来在右
    const xOf = (t) => cssW * (CURSOR_RATIO + (t - now) / WINDOW_SECONDS);

    ctx.save();
    // 圆角裁剪：色带不会溢出边框，边缘干净
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(cssW - r, 0);
    ctx.quadraticCurveTo(cssW, 0, cssW, r); ctx.lineTo(cssW, cssH - r);
    ctx.quadraticCurveTo(cssW, cssH, cssW - r, cssH); ctx.lineTo(r, cssH);
    ctx.quadraticCurveTo(0, cssH, 0, cssH - r); ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.clip();

    // ---- 底：深色背景 ----
    ctx.fillStyle = 'rgba(10,13,18,0.85)';
    ctx.fillRect(0, 0, cssW, cssH);

    // ---- 天气色带：每层画成【一条连续路径】，整条 fill 一次 ----
    //
    // 根治"密密麻麻的竖线像星星一样闪"：原来把色带切成 90 个独立的小四边形
    // （每个才 3.1px 宽），每个单独 fill —— 相邻四边形之间的【半像素接缝】就是那些竖线，
    // 而亚像素位置每帧漂移让接缝忽隐忽现 = 闪烁。顺带每帧还创建 450 个渐变对象（纯浪费）。
    // 改成整条路径一次 fill：没有接缝，自然没有竖线，也没有闪烁。
    const ids = Object.keys(BASE_WEATHERS);
    const cum = forecast.map(() => 0);   // 各采样点的累计高度（堆叠用）
    for (const id of ids) {
      const col = BASE_WEATHERS[id].color;
      ctx.beginPath();
      // 上沿：从左到右
      let started = false;
      for (let i = 0; i < forecast.length; i++) {
        const x = xOf(forecast[i].t);
        const y = cum[i];
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      // 下沿：从右到左（累加本层高度）
      for (let i = forecast.length - 1; i >= 0; i--) {
        const h = (forecast[i].weights[id] || 0) * cssH;
        cum[i] += h;
        ctx.lineTo(xOf(forecast[i].t), cum[i]);
      }
      ctx.closePath();
      ctx.fillStyle = col + 'd9';
      ctx.fill();
    }

    // ---- 极端天气：深色覆盖 + 图标（图标锚定在时段中点，随色带平移，不闪） ----
    // 先把连续的同种极端天气归并成【时段】，图标画在时段中点 —— 这样图标的位置
    // 由"时段中点在时间轴上的位置"决定，随色带一起匀速左移；而不是每帧
    // 在窗口里重新挑一个采样点来画（那会导致图标在相邻采样点之间反复跳 = 闪烁）。
    const segments = [];
    let cur = null;
    for (const f of forecast) {
      const exs = f.extremes || [];
      const top = exs.length ? exs.reduce((a, b) => (b.intensity > a.intensity ? b : a)) : null;
      if (top && cur && cur.id === top.id) {
        cur.tEnd = f.t;
        cur.peak = Math.max(cur.peak, top.intensity);
      } else {
        if (cur) segments.push(cur);
        cur = top ? { id: top.id, tStart: f.t, tEnd: f.t, peak: top.intensity } : null;
      }
    }
    if (cur) segments.push(cur);

    for (const seg of segments) {
      const def = EXTREME_WEATHERS[seg.id];
      if (!def) continue;
      const x0 = xOf(seg.tStart), x1 = xOf(seg.tEnd);
      if (x1 < 0 || x0 > cssW) continue;
      // 深色覆盖块：强度越高越重
      const grad = ctx.createLinearGradient(0, 0, 0, cssH);
      grad.addColorStop(0, def.color + 'cc');
      grad.addColorStop(1, def.color + '77');
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.45 + 0.45 * seg.peak;
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), cssH);
      ctx.globalAlpha = 1;
      // 边界高亮
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, cssH);
      ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, cssH);
      ctx.stroke();
    }

    // ---- 刻度：只画 4 条（20/40/60/80%），锚定画布不动，加粗以便看清 ----
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 2;
    for (const pct of [0.2, 0.4, 0.6, 0.8]) {
      const x = Math.round(pct * cssW);
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, cssH);
      ctx.stroke();
    }
    ctx.restore();

    // ---- 极端天气图标（画在裁剪区之外，才不会被圆角切掉） ----
    // 极端天气图标。防闪烁的两条规则：
    //   ① 是否画，只看【时段的时长（秒）】—— 这是时段的固有属性，不随滚动变化。
    //      原来用"渲染宽度 < 10px"判断：时段边界会随采样点进出而跳动，宽度和中点跟着抖，
    //      于是图标在"画/不画"之间反复横跳 = 闪。窄时段（< MIN_SEG_SECONDS）干脆不画，
    //      只留深色块——它本来也放不下图标。
    //   ② 边缘用【淡出】而不是硬切：图标接近左右边界时透明度渐变到 0，
    //      而不是越过某个像素就突然消失。
    const MIN_SEG_SECONDS = 12;   // 短于 12 秒的极端天气不画图标（画了也看不清）
    const FADE_PX = 14;           // 边缘淡出宽度
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const seg of segments) {
      const def = EXTREME_WEATHERS[seg.id];
      if (!def) continue;
      if (seg.tEnd - seg.tStart < MIN_SEG_SECONDS) continue; // ①：按时长判断，稳定
      const xm = (xOf(seg.tStart) + xOf(seg.tEnd)) / 2;
      if (xm < -FADE_PX || xm > cssW + FADE_PX) continue;
      // ②：边缘淡出
      let edgeFade = 1;
      if (xm < FADE_PX) edgeFade = Math.max(0, xm / FADE_PX);
      else if (xm > cssW - FADE_PX) edgeFade = Math.max(0, (cssW - xm) / FADE_PX);
      const alpha = (0.6 + 0.4 * seg.peak) * edgeFade;
      if (alpha < 0.05) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(def.icon, xm, cssH / 2);
      ctx.globalAlpha = 1;
    }

    // ---- "现在"游标（20% 处，比刻度更粗更亮） ----
    const cx = Math.round(CURSOR_RATIO * cssW);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cssH);
    ctx.stroke();
    // 顶部小三角，标示"现在"
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, 4); ctx.lineTo(cx - 3.5, 0); ctx.lineTo(cx + 3.5, 0);
    ctx.closePath(); ctx.fill();

    // 外框
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r, 0.5); ctx.lineTo(cssW - r, 0.5);
    ctx.quadraticCurveTo(cssW - 0.5, 0.5, cssW - 0.5, r);
    ctx.lineTo(cssW - 0.5, cssH - r);
    ctx.quadraticCurveTo(cssW - 0.5, cssH - 0.5, cssW - r, cssH - 0.5);
    ctx.lineTo(r, cssH - 0.5);
    ctx.quadraticCurveTo(0.5, cssH - 0.5, 0.5, cssH - r);
    ctx.lineTo(0.5, r);
    ctx.quadraticCurveTo(0.5, 0.5, r, 0.5);
    ctx.stroke();
  },

  /**
   * 主界面只显示【当前天气】——极简。所有数字（占比%、极端强度%）都在配置面板里。
   * 有极端天气生效时优先显示极端天气（它比主导天气更重要，也更少见）。
   */
  _renderNow() {
    const el = document.getElementById('weatherNow');
    if (!el) return;
    const ex = this._weather.getActiveExtremes();
    let icon, name, color;
    if (ex.length) {
      // 多个极端天气并存时显示强度最高的那个
      const top = ex.reduce((a, b) => (b.intensity > a.intensity ? b : a));
      icon = top.icon; name = top.name; color = top.color;
    } else {
      const dom = this._weather.getDominant();
      if (!dom) return;
      icon = dom.icon; name = dom.name; color = dom.color;
    }
    const key = icon + name;
    if (el.dataset.k !== key) {
      el.dataset.k = key;
      el.innerHTML = `<span style="font-size:14px;">${icon}</span><span>${name}</span>`;
      el.style.color = color;
    }
  },

  // ==================== 配置面板 ====================
  openConfig() {
    const ws = this._weather;
    if (!ws) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:640px;max-height:86vh;display:flex;flex-direction:column;">
        <div class="modal-header" style="flex-shrink:0;">
          <h3>🌦️ 天气系统</h3>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" id="weatherCfgBody" style="overflow-y:auto;flex:1;min-height:0;">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
            <button id="wxToggle" style="flex:1;">${ws.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
            <button id="wxReroll" style="flex:1;">🎲 重新随机本局天气</button>
          </div>
          <p style="color:var(--text-dim);font-size:11px;line-height:1.7;margin:6px 0 12px;">
            天气是<b>连续演化的权重场</b>：占比驱动【充能】，充能档位决定效果强度
            （轻微25% / 有限50% / 中等75% / 严重100%）。<b>极端天气</b> = 两种基础天气充能同时达标时涌现
            或【单一基础天气独自极端化】（充能达严重档附近）时涌现——
            组合极端 10 种 + 单基础极端 5 种（烈日/洪涝/浓雾/飓风/寒潮），共 15 种；
            均独享第 5 档【极端 150%】（充能≥88%，重辉光）。<br>
            本局天气性格：平均主导时长约 <b>${ws.averageDuration}s</b>（每次载入地图重新随机）。
          </p>
          <h4 style="margin:2px 0 6px;font-size:13px;">📊 天气预报（堆叠图）</h4>
          <canvas id="wxBigBar" style="width:100%;height:64px;display:block;margin-bottom:12px;"></canvas>
          <div id="wxLive" style="font-size:12px;line-height:1.8;font-variant-numeric:tabular-nums;background:rgba(0,0,0,0.25);
            border-radius:8px;padding:8px 10px;margin-bottom:12px;"></div>
          <h4 style="margin:10px 0 6px;font-size:13px;">🌍 气候模板</h4>
          <p style="color:var(--text-dim);font-size:10px;margin:0 0 6px;">
            按真实世界的地貌选择气候。套用后各天气的出现倾向一次性替换（并做随机扰动，
            所以同一个"沙漠"每局也不完全一样）。默认「全随机」。
          </p>
          <div id="wxTemplates" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;"></div>

          <h4 style="margin:10px 0 6px;font-size:13px;">基础天气（参与演化）</h4>
          <p style="color:var(--text-dim);font-size:10px;margin:0 0 6px;">
            滑条 = 该天气的<b>出现倾向</b>（-1 ~ +1，越高越常见）。调整后<b>立即重算未来</b>——
            当下的天气不跳变，但往后的走向会按新规则演化（预报条右侧会重画一次）。
          </p>
          <div id="wxBase"></div>
          <h4 style="margin:14px 0 6px;font-size:13px;">极端天气（阈值涌现）</h4>
          <div id="wxExtreme"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const renderRows = () => {
      const baseBox = overlay.querySelector('#wxBase');
      const exBox = overlay.querySelector('#wxExtreme');
      const w = ws.getWeights();
      const activeEx = new Map(ws.getActiveExtremes().map(e => [e.id, e.intensity]));

      // 气候模板
      const tplBox = overlay.querySelector('#wxTemplates');
      if (tplBox) {
        tplBox.innerHTML = Object.values(CLIMATE_TEMPLATES).map(t => `
          <button data-tpl="${t.id}" class="editor-tab ${ws.template === t.id ? 'active' : ''}"
            title="${t.desc}" style="font-size:11px;padding:4px 9px;">${t.icon} ${t.name}</button>`).join('');
        tplBox.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
          ws.setTemplate(b.dataset.tpl);
          renderRows();
        }));
      }

      baseBox.innerHTML = Object.values(BASE_WEATHERS).map(def => {
        const pct = Math.round((w[def.id] || 0) * 100);
        const off = ws.isWeatherDisabled(def.id);
        const mu = ws.getMu(def.id);
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;
          background:rgba(255,255,255,0.03);margin-bottom:4px;${off ? 'opacity:0.4;' : ''}">
          <span style="font-size:16px;">${def.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:${def.color};font-weight:600;">${def.name}
              <span style="color:var(--text-dim);font-weight:400;">${off ? '（已禁用）' : ' · 当前 ' + pct + '%'}</span></div>
            <div style="font-size:10px;color:var(--text-dim);">${def.desc}</div>
            <div style="height:3px;background:rgba(255,255,255,0.08);border-radius:2px;margin:3px 0;">
              <div style="width:${off ? 0 : pct}%;height:100%;background:${def.color};border-radius:2px;"></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
              <span style="font-size:9px;color:var(--text-dim);white-space:nowrap;">出现倾向</span>
              <input type="range" data-mu="${def.id}" min="-1" max="1" step="0.05" value="${mu.toFixed(2)}"
                style="flex:1;height:3px;" ${off ? 'disabled' : ''} />
              <span data-muval="${def.id}" style="font-size:9px;color:${def.color};width:32px;text-align:right;
                font-variant-numeric:tabular-nums;">${mu >= 0 ? '+' : ''}${mu.toFixed(2)}</span>
            </div>
          </div>
          <button data-wx="${def.id}" style="font-size:11px;padding:3px 8px;">${off ? '启用' : '禁用'}</button>
        </div>`;
      }).join('');

      // mu 滑条：拖动时只更新数字（零开销），松手 120ms 后才重算时间线（约 2-6ms，无感）。
      // 不做防抖的话，拖动会每帧触发一次整条时间线重算 → 掉帧。
      let muTimer = null;
      baseBox.querySelectorAll('[data-mu]').forEach(sl => {
        sl.addEventListener('input', () => {
          const id = sl.dataset.mu;
          const v = parseFloat(sl.value);
          const lab = baseBox.querySelector(`[data-muval="${id}"]`);
          if (lab) lab.textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
          clearTimeout(muTimer);
          muTimer = setTimeout(() => {
            ws.setMu(id, v);
            ws._template = 'custom_'; // 手动调过 → 不再属于任何模板
          }, 120);
        });
      });

      exBox.innerHTML = Object.values(EXTREME_WEATHERS).map(def => {
        const on = activeEx.has(def.id);
        const tier = ws.getTier(def.id);
        const off = ws.isWeatherDisabled(def.id);
        const wt = ws.getExtremeWeight(def.id);
        const cond = Object.entries(def.trigger)
          .map(([b, t]) => `${BASE_WEATHERS[b].icon}充能≥${Math.round(ws._extremeThreshold(def.id, t) * 100)}%`).join(' 且 ');
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;
          background:${on ? 'rgba(255,215,94,0.10)' : 'rgba(255,255,255,0.03)'};margin-bottom:4px;${off ? 'opacity:0.4;' : ''}">
          <span style="font-size:16px;">${def.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:${def.color};font-weight:600;">${def.name}
              ${on ? `<span style="color:#ffd75e;font-size:10px;${tier.isExtremeTier ? 'text-shadow:0 0 6px rgba(255,215,94,0.9);font-weight:700;' : ''}"> · ${tier.name}档（${Math.round(tier.scale * 100)}%）</span>` : ''}</div>
            <div style="font-size:10px;color:var(--text-dim);">${def.desc}</div>
            <div style="font-size:9px;color:var(--text-mute,#6b7480);margin-top:2px;">触发：${cond}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
              <span style="font-size:9px;color:var(--text-dim);white-space:nowrap;">出现倾向</span>
              <input type="range" data-exw="${def.id}" min="-1" max="1" step="0.05" value="${wt.toFixed(2)}"
                style="flex:1;height:3px;" ${off ? 'disabled' : ''} />
              <span data-exwval="${def.id}" style="font-size:9px;color:${def.color};width:32px;text-align:right;
                font-variant-numeric:tabular-nums;">${wt >= 0 ? '+' : ''}${wt.toFixed(2)}</span>
            </div>
          </div>
          <button data-wx="${def.id}" style="font-size:11px;padding:3px 8px;">${off ? '启用' : '禁用'}</button>
        </div>`;
      }).join('');

      // 极端天气出现倾向：权重越高 → 触发阈值越低 → 越容易出现。
      // 不需要防抖（不重算时间线，只影响阈值判定）。
      exBox.querySelectorAll('[data-exw]').forEach(sl => {
        sl.addEventListener('input', () => {
          const id = sl.dataset.exw;
          const v = parseFloat(sl.value);
          const lab = exBox.querySelector(`[data-exwval="${id}"]`);
          if (lab) lab.textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
          ws.setExtremeWeight(id, v);
        });
      });

      overlay.querySelectorAll('[data-wx]').forEach(b => {
        b.addEventListener('click', () => {
          const id = b.dataset.wx;
          ws.setWeatherDisabled(id, !ws.isWeatherDisabled(id));
          renderRows();
        });
      });
    };

    const bigBar = overlay.querySelector('#wxBigBar');
    const bigCtx = bigBar ? bigBar.getContext('2d') : null;
    const tick = () => {
      if (!document.body.contains(overlay)) return;
      if (bigCtx && ws.enabled) this._renderBar(bigBar, bigCtx); // v33：详细堆叠预报图在配置面板里
      const live = overlay.querySelector('#wxLive');
      if (live) {
        const w = ws.getWeights();
        const rows = Object.entries(w).sort((a, b) => b[1] - a[1])
          .map(([id, v]) => {
            const def = BASE_WEATHERS[id];
            const n = Math.round(v * 40);
            return `<span style="color:${def.color}">${def.icon} ${def.name.padEnd(2, '　')} ${'█'.repeat(n)}${'░'.repeat(40 - n)} ${(v * 100).toFixed(1)}%</span>`;
          }).join('<br>');
        const ex = ws.getActiveExtremes();
        live.innerHTML = rows + (ex.length
          ? '<br><br>' + ex.map(e => `<span style="color:${e.color}">${e.icon} <b>${e.name}</b> 强度 ${(e.intensity * 100).toFixed(0)}%</span>`).join('<br>')
          : '<br><br><span style="color:var(--text-dim)">（无极端天气）</span>');
      }
      requestAnimationFrame(tick);
    };

    overlay.querySelector('#wxToggle').addEventListener('click', (e) => {
      ws.setEnabled(!ws.enabled);
      e.target.textContent = ws.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）';
    });
    overlay.querySelector('#wxReroll').addEventListener('click', () => {
      ws.reset();
      renderRows();
    });

    renderRows();
    tick();
  },
};
