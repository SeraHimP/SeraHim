/**
 * WorldHud.js —— 主界面右上角的世界状态小窗（时间 · 天气 · 熵）
 *
 * 天气段由 WeatherPanel 负责（它已有成熟的滚动预报条实现，不重写）；
 * 本模块负责【时间/昼夜】与【熵】两段，并统一三段的显隐。
 *
 * 设计语言（三段必须看起来是一组）：
 *   每行 = [固定宽标签] [150×14 色带] [固定宽读数]，行高/字号/圆角三段一致。
 *   主界面只放"当前值"，明细一律在各自的配置面板里 —— 这是天气段定下的规矩，
 *   新增的两段照办，否则小窗会重新长成一堆数字。
 *
 * 挂钟 vs gameTime：色带上的位置代表【游戏内时间】，所以用 gameTime；
 * 但任何呼吸/闪烁动画必须用挂钟（gameTime 会被暂停/倍速影响，暂停时动画会僵住）。
 */
import { CONFIG } from '../data/Config.js';
import { DAY_PERIOD, resolveDayPhase, phaseLabelOf } from '../presentation/DayNight.js';

// 昼夜色带的关键帧配色，与 DayNight 的相位口径一致：0=黎明 .25=正午 .5=黄昏 .75=午夜
const PHASE_STOPS = [
  { p: 0.00, c: '#e8a06a', label: '黎明', icon: '🌅' },
  { p: 0.25, c: '#7ec8f2', label: '正午', icon: '☀️' },
  { p: 0.50, c: '#e0764f', label: '黄昏', icon: '🌇' },
  { p: 0.75, c: '#2b3a6b', label: '午夜', icon: '🌙' },
];

const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
};

function phaseInfo(phase) {
  // 取最近的关键帧作为文字/图标（相位是连续的，标签只需要够用）
  let best = PHASE_STOPS[0], bd = Infinity;
  for (const st of PHASE_STOPS) {
    const d = Math.min(Math.abs(phase - st.p), 1 - Math.abs(phase - st.p));
    if (d < bd) { bd = d; best = st; }
  }
  return best;
}

export const WorldHud = {
  _world: null,
  _onEntropyClick: null,

  init(worldState, { onEntropyClick = null } = {}) {
    this._world = worldState;
    this._onEntropyClick = onEntropyClick;
    const row = document.getElementById('whEntropyRow');
    if (row && onEntropyClick) row.addEventListener('click', onEntropyClick);
    // 天气段的点击（打开天气配置）由 WeatherPanel 自己绑，这里不抢。
  },

  /** 每帧调用。 */
  update(gameTime) {
    this._renderTime(gameTime || 0);
    this._renderEntropy();
  },

  // ==================== 时间 / 昼夜 ====================
  _renderTime(gameTime) {
    const cv = document.getElementById('whTimeBar');
    const clock = document.getElementById('whClock');
    const icon = document.getElementById('whPhaseIcon');
    if (!cv) return;

    // 相位优先取 WorldState 的（熵→昼夜耦合开启时它会被拉伸）；没有 WorldState
    // 时退回 resolveDayPhase —— 这两条路径现在是同一个口径。
    // 【原来这里写的是 `window.CTX?.__dayPeriod || DAY_PERIOD`，而那是个 setter
    //   函数，函数 truthy 导致 period 变成函数、相位恒为 NaN：时间条游标永远不动、
    //   标签永远显示"黎明"。用户报的"时间条不动"就是这个。】
    const ws = this._world;
    const phase = (ws && ws.enabled && ws.daynight && Number.isFinite(ws.daynight.phase))
      ? ws.daynight.phase
      : resolveDayPhase(gameTime, window.CTX, true).phase;
    const pi = phaseInfo(phase);
    // 文案走 phaseLabelOf（与 DayNight / 调试面板同一套措辞），不再自己定一套名字
    const label = phaseLabelOf(phase);

    if (clock) clock.textContent = fmtClock(gameTime);
    if (icon && icon.dataset.k !== label) {
      icon.dataset.k = label;
      icon.innerHTML = `<span style="font-size:13px;">${pi.icon}</span><span style="font-size:10px;">${label}</span>`;
      icon.style.color = pi.c;
    }

    const ctx = this._ctx(cv);
    if (!ctx) return;
    const { w, h } = this._size(cv);
    ctx.clearRect(0, 0, w, h);

    // 一整天的渐变：把 4 个关键帧铺成横向渐变（首尾同色以便循环）
    const g = ctx.createLinearGradient(0, 0, w, 0);
    for (const st of PHASE_STOPS) g.addColorStop(st.p, st.c);
    g.addColorStop(1, PHASE_STOPS[0].c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // 夜段（相位 ≥0.5）压暗。用**渐变**而不是一块平涂：平涂会在黄昏处留下一条
    // 生硬的直边，而那里恰好是颜色最暖的位置，看着像贴了块补丁。
    const nd = ctx.createLinearGradient(w * 0.5, 0, w, 0);
    nd.addColorStop(0, 'rgba(0,0,0,0)');
    nd.addColorStop(0.35, 'rgba(0,0,0,0.30)');
    nd.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = nd;
    ctx.fillRect(w * 0.5, 0, w * 0.5, h);

    // 关键时刻刻度（正午/黄昏/午夜）：细竖线，给"现在大概几点"一个参照。
    // 没有刻度的话游标停在哪都看不出意义。
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    for (const p of [0.25, 0.5, 0.75]) {
      const tx = Math.round(w * p) + 0.5;
      ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, h); ctx.stroke();
    }

    this._cursor(ctx, w, h, phase);
    this._frame(ctx, w, h);
  },

  /**
   * 当前位置游标：顶部小三角 + 全高细线，并且**先描一层深色再描白色**。
   * 单画一条白线时，游标走到正午那段浅蓝底色上会几乎看不见 —— 描边是为了
   * 让它在整条渐变的任意亮度上都读得出来。
   */
  _cursor(ctx, w, h, t) {
    const x = Math.max(1, Math.min(w - 1, w * t));
    const xr = Math.round(x) + 0.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(xr, 0); ctx.lineTo(xr, h); ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(xr, 0); ctx.lineTo(xr, h); ctx.stroke();
    // 顶部三角：小窗只有 14px 高，纯竖线不够抓眼，三角给一个明确的"就是这里"
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(xr, 3.5); ctx.lineTo(xr - 3, 0); ctx.lineTo(xr + 3, 0);
    ctx.closePath(); ctx.fill();
  },

  /** 统一的内描边：让三条色带看起来是同一个组件（否则各自像贴上去的图片）。 */
  _frame(ctx, w, h) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  },

  // ==================== 熵 / 三核 ====================
  _renderEntropy() {
    const row = document.getElementById('whEntropyRow');
    const cv = document.getElementById('whEntBar');
    const val = document.getElementById('whEntVal');
    const icon = document.getElementById('whEntIcon');
    if (!row || !cv) return;

    const ws = this._world;
    const cp = CONFIG.world?.couplings || {};
    // 熵没有任何耦合开启时不占地方 —— 显示一条对世界毫无影响的信息只是噪音。
    const on = !!ws && ws.enabled
      && (cp.entropyToUnits || cp.entropyToWeather || cp.entropyToDayNight);
    if (!on) { if (row.style.display !== 'none') row.style.display = 'none'; return; }
    if (row.style.display === 'none') row.style.display = '';

    const e = ws.entropy || {};
    const total = e.total || CONFIG.world?.entropy?.coreTotal || 8;
    const black = e.black || 0, white = e.white || 0, red = Math.max(0, total - black - white);
    const v = e.value ?? 0.5;

    if (val) val.textContent = `${(v * 100).toFixed(0)}%`;
    // 三行统一版式：左侧一律 [图标 + 中文名]，数值一律在右列。
    // 核数改放 tooltip —— 把 "3·0·5" 摆在名字的位置，那一列就不再是名字了。
    const side = v > 0.5 ? '混乱' : (v < 0.5 ? '秩序' : '中性');
    if (icon && icon.dataset.k !== side) {
      icon.dataset.k = side;
      icon.innerHTML = `<span style="font-size:13px;">🌀</span><span style="font-size:10px;">${side}</span>`;
      icon.style.color = v > 0.5 ? '#e0473f' : (v < 0.5 ? '#5b9bd5' : '#8b949e');
    }
    row.title = `三核 白${white}·未归属${red}·黑${black}（共 ${total}）　熵 ${(v * 100).toFixed(1)}%\n点击打开世界设置`;

    const ctx = this._ctx(cv);
    if (!ctx) return;
    const { w, h } = this._size(cv);
    ctx.clearRect(0, 0, w, h);

    // 8 颗核画成 8 个格子：左端白核（秩序/蓝方）→ 中间未归属 → 右端黑核（混乱/红方）。
    // 画成【离散格子】而不是连续进度条，是因为核本身就是离散的（总数恒 8）——
    // 用连续条会让人误以为熵是平滑变化的，实际每次跳变都是整整一颗核。
    const gap = 2;
    const cw = (w - gap * (total - 1)) / total;
    for (let i = 0; i < total; i++) {
      const x = i * (cw + gap);
      let fill;
      if (i < white) fill = '#5b9bd5';                 // 白核：秩序侧
      else if (i >= total - black) fill = '#e0473f';    // 黑核：混乱侧
      else fill = 'rgba(255,255,255,0.13)';            // 未归属
      ctx.fillStyle = fill;
      ctx.fillRect(x, 0, cw, h);
    }

    // 双方的夺核进度：在各自那一端画一条细进度线，看得出"下一颗快被谁抢走"
    const ch = e.charge || { black: 0, white: 0 };
    const barH = 2;
    if (ch.white > 0) {
      ctx.fillStyle = '#5b9bd5';
      ctx.fillRect(0, h - barH, Math.max(1, w * 0.5 * ch.white), barH);
    }
    if (ch.black > 0) {
      ctx.fillStyle = '#e0473f';
      const bw = Math.max(1, w * 0.5 * ch.black);
      ctx.fillRect(w - bw, h - barH, bw, barH);
    }

    // 中线：中性参考位
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    const mx = Math.round(w / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();
    this._frame(ctx, w, h);
  },

  // ==================== 画布尺寸（DPR 感知，与天气条同款）====================
  _ctx(cv) {
    if (!cv._c2d) cv._c2d = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 150, h = cv.clientHeight || 14;
    const nw = Math.round(w * dpr), nh = Math.round(h * dpr);
    if (cv.width !== nw || cv.height !== nh) {
      cv.width = nw; cv.height = nh;
      cv._c2d = cv.getContext('2d');
      cv._c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return cv._c2d;
  },
  _size(cv) {
    return { w: cv.clientWidth || 150, h: cv.clientHeight || 14 };
  },
};
