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

  init(weatherSystem, onOpenConfig) {
    this._weather = weatherSystem;
    this._canvas = document.getElementById('weatherBar');
    if (this._canvas) this._ctx = this._canvas.getContext('2d');
    // 整条天气带都是配置入口（原来是条上的一个小按钮，太隐蔽）。
    // 天气段现在是世界状态小窗里的一行，不再是独立浮窗。
    // Bug 修复（用户定稿）："设置窗口只留系统设置，游戏性的设置整合到模板编辑器里"——
    // 天气配置原来自己开一个 modal-overlay（第三套窗口壳），现在改成打开模板编辑器
    // 的"游戏性→天气"页。打开动作交给调用方传入的回调（main.js 那边接
    // AttributeEditor.openTemplateEditor），WeatherPanel 自己不反向 import
    // AttributeEditor——两个 UI 模块不该互相依赖，main.js 才是接线的地方。
    const wrap = document.getElementById('whWeatherRow');
    if (wrap && onOpenConfig) wrap.addEventListener('click', onOpenConfig);
  },

  /** 每帧调用：渲染滚动预报条（天气关闭时隐藏整条） */
  update() {
    const wrap = document.getElementById('whWeatherRow');
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
    const cssW = cv.clientWidth || 104, cssH = cv.clientHeight || 3;
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
    // ==================== v47：细条模式 ====================
    // 世界状态条重做成"胶囊底边的一条 3px 细线"（见 index.html 那段注释）。
    // 这条预报带原来是 26px 高的：里面有 4 条刻度、极端天气的图标与边界高亮。
    // 在 3px 上照画，12px 的图标会盖住整条、刻度把色带戳成虚线、
    // 圆角半径 4 比条本身还高 —— 结果是一条看不出任何信息的糊线。
    // 细条只保留**堆叠色带本身**（那才是"现在是什么天气"这条信息），其余全部跳过。
    const thin = cssH <= 6;
    // 圆角裁剪：色带不会溢出边框，边缘干净
    const r = thin ? Math.min(1.5, cssH / 2) : 4;
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
      if (thin) continue;   // 见上：3px 上再描边界线就只剩线了
      // 边界高亮
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, cssH);
      ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, cssH);
      ctx.stroke();
    }

    // ---- 刻度：只画 4 条（20/40/60/80%），锚定画布不动，加粗以便看清 ----
    if (!thin) {
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 2;
      for (const pct of [0.2, 0.4, 0.6, 0.8]) {
        const x = Math.round(pct * cssW);
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, cssH);
        ctx.stroke();
      }
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
    for (const seg of (thin ? [] : segments)) {   // 细条不画图标：12px 的字比条本身高四倍
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
    ctx.lineWidth = thin ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cssH);
    ctx.stroke();
    if (!thin) {
      // 顶部小三角，标示"现在"。细条上它会盖住整条，所以只留竖线（见细条模式的注释）
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(cx, 4); ctx.lineTo(cx - 3.5, 0); ctx.lineTo(cx + 3.5, 0);
      ctx.closePath(); ctx.fill();
    }

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
      // 与世界状态小窗另两行【同一版式】：左边固定是 [图标 + 中文名]，
      // 数值一律放右侧的 .wh-val 列。三行版式不统一时，小窗看起来就像三个
      // 拼在一起的东西而不是一组信息（用户明确提过"这三个显示文字不统一"）。
      el.innerHTML = `<span style="font-size:13px;">${icon}</span><span style="font-size:10px;">${name}</span>`;
      el.style.color = color;
    }
    // 右列数值：极端天气显示强度，否则显示主导天气的占比 —— 与时间行的时钟、
    // 熵行的百分比同为"一个数"，不再是空白。
    const val = document.getElementById('whWeatherVal');
    if (val) {
      const pct = ex.length
        ? Math.round(ex.reduce((a, b) => (b.intensity > a.intensity ? b : a)).intensity * 100)
        : Math.round((this._weather.getDominant()?.weight || 0) * 100);
      const txt = pct + '%';
      if (val.textContent !== txt) val.textContent = txt;
    }
  },

  // ==================== 配置面板 ====================
  // ==================== 配置面板内容（v43 Q1 统一到模板编辑器壳，现在整块搬进
  // "游戏性→天气"页，不再自己开一个 modal-overlay）====================
  // 拆成"渲染内容 _renderConfigBody"+"绑定事件 _bindConfigBody"两半，供
  // pagesGameplayWorld.js 直接调用；原来 openConfig() 自己起的那层
  // .modal-box/.modal-close 外壳交给模板编辑器统一的页面容器负责，这里不再重复。
  //
  // 用户定稿："预报图不需要精简；其余的一堆滑块条进行简化，不用再有言语描述"——
  // 原来在【基础天气】【气候模板】两段上方各有一段说明文字，现在都拿掉，
  // 含义搬进这里的注释：
  //   · 基础天气的滑条 = 该天气的"出现倾向"（-1~+1，越高越常见）；调整后立即
  //     重算未来的演化，当下天气不跳变，预报条会跟着重画。
  //   · 气候模板按真实世界的地貌一次性替换全部天气的出现倾向（并做随机扰动，
  //     同一个模板每局不完全一样）。
  //   · 顶部原来那段"天气是连续演化的权重场…充能档位…组合10种+单基础5种=15种"
  //     的说明同样只留在这里：占比驱动【充能】，充能档位决定效果强度
  //     （轻微25%/有限50%/中等75%/严重100%），极端天气由两种基础天气充能同时
  //     达标、或单一基础天气独自充到严重档附近涌现，共 15 种，均独享第5档
  //     【极端150%】（充能≥88%，重辉光）。
  _renderConfigBody() {
    const ws = this._weather;
    if (!ws) return '';
    // ==================== v50：天气配置页重构 ====================
    // 用户："天气界面你是直接给我套用了，有两列 tab 菜单，我要的是天气界面的完全重构，
    //        现有的样式不要！不好看！！！！"
    //
    // "两列 tab" 的直接原因就在这里：这个函数自己又渲染了一整套 `.tpl-layout + .tpl-nav`，
    // 而它本身已经被塞进模板编辑器的页面容器里 —— **导航列套导航列**。
    // 现在整块去掉内层导航，四段并成**一页**，用 .panel-sec 小标题分隔
    //（与单位属性面板同一套语言）。
    // this._cfgSec 连同它的切页事件一并删除：没有内层导航了，那个状态没有意义。
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <button id="wxToggle" style="flex:1;">${ws.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）'}</button>
        <button id="wxReroll" style="flex:1;">🎲 重新随机本局天气</button>
      </div>

      <div class="panel-sec">实时与预报</div>
      <canvas id="wxBigBar" style="width:100%;height:64px;display:block;margin-bottom:10px;border-radius:6px;"></canvas>
      <div id="wxLive" style="font-size:12px;line-height:1.8;font-variant-numeric:tabular-nums;
        background:rgba(0,0,0,0.25);border-radius:8px;padding:8px 10px;"></div>

      <div class="panel-sec">气候模板</div>
      <div id="wxTemplates" style="display:flex;flex-wrap:wrap;gap:4px;"></div>

      <div class="panel-sec">基础天气</div>
      <div id="wxBase"></div>

      <div class="panel-sec">极端天气</div>
      <div id="wxExtreme"></div>`;
  },

  _bindConfigBody(container, logFn) {
    const ws = this._weather;
    if (!ws) return;
    // v50：内层导航已删除（四段并成一页），这里原来那段切页绑定一并去掉。

    // v51.6：极端天气行拆成独立函数，供 tick() 每帧调用——它现在是纯只读展示
    // （没有滑条/输入框了，见下方 renderExtreme 里的说明），每帧整体重绘不会像
    // baseBox 那样打断正在拖动的 mu 滑条，充能进度条才能看起来是"实时"的。
    const renderExtreme = () => {
      const exBox = container.querySelector('#wxExtreme');
      if (!exBox) return;
      const activeEx = new Map(ws.getActiveExtremes().map(e => [e.id, e.intensity]));
      exBox.innerHTML = Object.values(EXTREME_WEATHERS).map(def => {
        const on = activeEx.has(def.id);
        const tier = ws.getTier(def.id);
        const off = ws.isWeatherDisabled(def.id);
        const chargePct = Math.round(ws.getCharge(def.id) * 100);
        const cond = Object.entries(def.trigger)
          .map(([b, t]) => `${BASE_WEATHERS[b].icon}充能≥${Math.round(ws._extremeThreshold(def.id, t) * 100)}%`).join(' 且 ');
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;
          background:${on ? 'rgba(255,215,94,0.10)' : 'rgba(255,255,255,0.03)'};margin-bottom:4px;${off ? 'opacity:0.4;' : ''}">
          <span style="font-size:16px;">${def.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:${def.color};font-weight:600;">${def.name}
              ${on ? `<span style="color:#ffd75e;font-size:10px;${tier.isExtremeTier ? 'text-shadow:0 0 6px rgba(255,215,94,0.9);font-weight:700;' : ''}"> · ${tier.name}档（${Math.round(tier.scale * 100)}%）</span>`
                   : `<span style="color:var(--text-dim);font-weight:400;">${off ? '（已禁用）' : ' · 充能 ' + chargePct + '%'}</span>`}</div>
            <div style="font-size:9px;color:var(--text-mute,#6b7480);margin-top:2px;">触发：${cond}</div>
            <div style="height:5px;background:rgba(255,255,255,0.07);border-radius:3px;margin-top:4px;overflow:hidden;">
              <div style="width:${off ? 0 : chargePct}%;height:100%;border-radius:3px;background:${def.color};
                box-shadow:0 0 6px ${def.color}80;transition:width 0.3s ease;"></div>
            </div>
          </div>
          <button data-wx="${def.id}" style="font-size:11px;padding:3px 8px;">${off ? '启用' : '禁用'}</button>
        </div>`;
      }).join('');
      exBox.querySelectorAll('[data-wx]').forEach(b => {
        b.addEventListener('click', () => {
          ws.setWeatherDisabled(b.dataset.wx, !ws.isWeatherDisabled(b.dataset.wx));
          renderExtreme();
        });
      });
    };

    const renderRows = () => {
      const baseBox = container.querySelector('#wxBase');

      const tplBox = container.querySelector('#wxTemplates');
      if (tplBox) {
        tplBox.innerHTML = Object.values(CLIMATE_TEMPLATES).map(t => `
          <button data-tpl="${t.id}" class="editor-tab ${ws.template === t.id ? 'active' : ''}"
            title="${t.desc}" style="font-size:11px;padding:4px 9px;">${t.icon} ${t.name}</button>`).join('');
        tplBox.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
          ws.setTemplate(b.dataset.tpl);
          renderRows();
        }));
      }

      // ==================== v51.24：基础天气行改成 MIUI 风格胶囊滑块 ====================
      // 用户："天气窗口中基础天气上面显示了静止不动的'当前数值'，把这个删掉和上面的
      // 重复了（与上方【实时与预报】的只读百分比列表是同一个数，念两遍）。然后基础
      // 天气的滑块条这部分大改一下，把这个整体做成MINI那种胶囊的样式，进度条在胶囊
      // 里面填充（并且可以滑动进度），文字和图标都在胶囊里显示。"
      //
      // 旧版一行三层：① 图标+中文名+"当前XX%"文字（只读实况，与上面 #wxLive 重复）
      // ② 一条只读发光条（同一个只读实况的第二次呈现）③ 原生 <input type=range> 滑条
      // +独立数字（真正在编辑的出现倾向 mu，-1~+1）。三样东西挤在一行，其中①②纯粹
      // 是重复信息。现在只留"你在编辑什么"这一件事：一颗胶囊，填充比例与胶囊内的
      // 百分比文字都是 mu（映射到 0~100% 的可视填充：mu=-1 空、mu=0 半、mu=+1 满），
      // 图标+百分比一起显示在胶囊正中。"现在实际出现的占比"这个只读数只在上面
      // 【实时与预报】的 #wxLive 列表里出现一次，不再重复。
      //
      // 交互：点/拖胶囊【任意位置】直接把值跳到手指/指针位置（不留独立圆点把手），
      // 更贴近 MIUI 那种"胶囊本身就是把手"的滑块观感，在触屏（平板）上也更好点中。
      baseBox.innerHTML = Object.values(BASE_WEATHERS).map(def => {
        const off = ws.isWeatherDisabled(def.id);
        const mu = ws.getMu(def.id);
        const fillPct = Math.round(((mu + 1) / 2) * 100);
        const label = (mu >= 0 ? '+' : '') + Math.round(mu * 100) + '%';
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <div class="wx-pill" data-pill="${def.id}" style="position:relative;flex:1;height:28px;
            border-radius:14px;background:rgba(255,255,255,0.06);overflow:hidden;touch-action:none;
            user-select:none;${off ? 'opacity:0.4;pointer-events:none;' : 'cursor:pointer;'}">
            <div class="wx-pill-fill" style="position:absolute;left:0;top:0;bottom:0;width:${fillPct}%;
              background:${def.color};opacity:0.55;"></div>
            <div style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;
              gap:5px;font-size:12px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.7);
              pointer-events:none;">
              <span style="font-size:14px;">${def.icon}</span>
              <span class="wx-pill-label" style="font-variant-numeric:tabular-nums;">${label}</span>
            </div>
          </div>
          <button data-wx="${def.id}" style="font-size:11px;padding:3px 8px;flex:none;">${off ? '启用' : '禁用'}</button>
        </div>`;
      }).join('');

      // 拖动时只更新这一颗胶囊的填充宽度与文字（零开销），松手/移动中防抖 120ms 后
      // 才重算时间线（约 2-6ms，无感）——不做防抖的话，拖动会每帧触发一次整条时间线
      // 重算，在平板上尤其容易掉帧。多颗胶囊共用同一个防抖计时器，与旧版原生滑条
      // 的既有行为一致（连续拖两颗时后一颗会顶掉前一颗还没提交的那次，不是新引入的）。
      let muTimer = null;
      baseBox.querySelectorAll('.wx-pill[data-pill]').forEach(pill => {
        const id = pill.dataset.pill;
        if (ws.isWeatherDisabled(id)) return; // 禁用态 pointer-events:none 已经挡了交互，不用再绑
        const fillEl = pill.querySelector('.wx-pill-fill');
        const labelEl = pill.querySelector('.wx-pill-label');
        const applyFromClientX = (clientX) => {
          const rect = pill.getBoundingClientRect();
          const frac = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
          const v = Math.round((frac * 2 - 1) * 100) / 100; // -1..1，百分点精度
          fillEl.style.width = (frac * 100) + '%';
          labelEl.textContent = (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
          clearTimeout(muTimer);
          muTimer = setTimeout(() => {
            ws.setMu(id, v);
            ws._template = 'custom_'; // 手动调过 → 不再属于任何模板
          }, 120);
        };
        pill.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          pill.setPointerCapture?.(e.pointerId);
          applyFromClientX(e.clientX);
          const onMove = (ev) => applyFromClientX(ev.clientX);
          const onUp = () => {
            pill.removeEventListener('pointermove', onMove);
            pill.removeEventListener('pointerup', onUp);
            pill.removeEventListener('pointercancel', onUp);
          };
          pill.addEventListener('pointermove', onMove);
          pill.addEventListener('pointerup', onUp);
          pill.addEventListener('pointercancel', onUp);
        });
      });

      // 基础天气的启用/禁用按钮——极端天气那部分现在完全归 renderExtreme() 管
      // （它是纯只读展示，见上面那个函数头的说明），这里只需要管 baseBox 自己这些按钮。
      baseBox.querySelectorAll('[data-wx]').forEach(b => {
        b.addEventListener('click', () => {
          const id = b.dataset.wx;
          ws.setWeatherDisabled(id, !ws.isWeatherDisabled(id));
          renderRows();
        });
      });

      renderExtreme();
    };

    const bigBar = container.querySelector('#wxBigBar');
    const bigCtx = bigBar ? bigBar.getContext('2d') : null;
    // v51.6：极端天气充能条要"看起来实时"，但没必要真的按 60fps 重建 15 行 HTML——
    // 节流到约 3 次/秒，肉眼分不出差别，且是纯只读展示（没有输入框），不用担心
    // 像 baseBox 那样打断正在拖动的滑条。
    let exTickAccum = 0, lastTickTime = null;
    const tick = () => {
      if (!document.body.contains(container)) return; // 容器被移除（页面切走/窗口关闭）就停
      const now = performance.now();
      const dt = lastTickTime === null ? 0 : (now - lastTickTime) / 1000;
      lastTickTime = now;
      exTickAccum += dt;
      if (exTickAccum >= 0.33) { exTickAccum = 0; renderExtreme(); }
      if (bigCtx && ws.enabled) this._renderBar(bigBar, bigCtx); // 预报图原样保留，不精简
      const live = container.querySelector('#wxLive');
      if (live) {
        const w = ws.getWeights();
        // v51.6 修复：用户报"天气界面我画圈处的进度条样式还是没有改！这种的不好看！"——
        // 这里原来是用 █/░ 两种字符手搓的"进度条"（Unicode 方块字符，一大截实心方块
        // 接一截浅色方块，看起来像老式终端仪表，和 #wxBase 那套已经改成"6px 圆角+
        // 内发光"的进度条完全是两套视觉语言）。改成同一套：图标+名称+圆角发光条+
        // 百分比数字，与下面【基础天气】的条形样式统一。
        const rows = Object.entries(w).sort((a, b) => b[1] - a[1])
          .map(([id, v]) => {
            const def = BASE_WEATHERS[id];
            const pct = v * 100;
            return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">
              <span style="font-size:14px;width:18px;text-align:center;flex:none;">${def.icon}</span>
              <span style="font-size:12px;color:${def.color};width:28px;flex:none;">${def.name}</span>
              <div style="flex:1;height:6px;background:rgba(255,255,255,0.07);border-radius:4px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;border-radius:4px;background:${def.color};
                  box-shadow:0 0 6px ${def.color}80;"></div>
              </div>
              <span style="font-size:11px;color:${def.color};width:46px;text-align:right;flex:none;">${pct.toFixed(1)}%</span>
            </div>`;
          }).join('');
        // v51.24：用户"实时预报下面的极端天气那里，把有充能的极端天气放在里面
        // （如果暂未生效的就变灰），生效了之后才正常显示"——原来这里只列**已生效**
        // 的极端天气，充能中但还没触发的完全不出现，玩家在这个紧凑摘要里看不到
        // "快下暴雨了"这种预兆，得翻到下面单独的【极端天气】大列表才看得到充能进度。
        // 现在把"有充能（>0%）"的都列进来：已生效的正常高亮显示强度，充能中但还
        // 没生效的整行变灰、显示充能进度条+百分比，一触发就自动切换成正常样式
        // （下一次 tick 重绘时 activeEx 里就有它了）。
        const activeEx = new Map(ws.getActiveExtremes().map(e => [e.id, e]));
        const exRows = Object.values(EXTREME_WEATHERS)
          .map(def => {
            const act = activeEx.get(def.id);
            const chargePct = Math.round((act ? act.intensity : ws.getCharge(def.id)) * 100);
            if (!act && chargePct <= 0) return null; // 没生效也完全没充能 → 不占地方
            return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;${act ? '' : 'opacity:0.45;'}">
              <span style="font-size:14px;width:18px;text-align:center;flex:none;">${def.icon}</span>
              <span style="font-size:12px;color:${def.color};min-width:28px;flex:none;">${def.name}</span>
              <div style="flex:1;height:6px;background:rgba(255,255,255,0.07);border-radius:4px;overflow:hidden;">
                <div style="width:${chargePct}%;height:100%;border-radius:4px;background:${def.color};
                  ${act ? `box-shadow:0 0 6px ${def.color}80;` : ''}"></div>
              </div>
              <span style="font-size:11px;color:${def.color};width:64px;text-align:right;flex:none;">${act ? '强度 ' : '充能 '}${chargePct}%</span>
            </div>`;
          })
          .filter(Boolean);
        const exHtml = exRows.length ? exRows.join('')
          : `<div style="color:var(--text-dim);">（无极端天气）</div>`;
        live.innerHTML = rows + `<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);">${exHtml}</div>`;
      }
      requestAnimationFrame(tick);
    };

    container.querySelector('#wxToggle').addEventListener('click', (e) => {
      ws.setEnabled(!ws.enabled);
      e.target.textContent = ws.enabled ? '🌦️ 已开启（点击关闭）' : '⭕ 已关闭（点击开启）';
    });
    container.querySelector('#wxReroll').addEventListener('click', () => {
      ws.reset();
      renderRows();
      logFn?.('🎲 本局天气已重新随机', 'spawn');
    });

    renderRows();
    tick();
  },
};
