/**
 * sim_runtime.mjs —— 动态冒烟（运行时崩溃检测）
 *
 * 存在的理由（v25 事故）：
 *   CombatSystem 里写了 `entity._mapFaction`，但那个循环的变量叫 tower——
 *   每帧抛 ReferenceError、游戏完全卡死（视角不能动、倒计时不走、加不了兵）。
 *   而当时 12 套仿真【全绿】：它们都是直接 import 子系统做单元测试，
 *   从不把【真实的游戏循环】跑起来，所以每帧崩溃的代码可以大摇大摆通过。
 *
 * 静态分析（手写正则做作用域检查）试过，误报率太高、不可用。
 * 真正有效的办法就是：把游戏真跑起来。
 *
 * 做法：用最小 DOM 桩（canvas / document / window）让 main.js 能加载，
 *       然后驱动真实的游戏循环跑若干帧，覆盖启动即成局 + 换图 + 天气开启。
 *       任何运行时错误都会被 try-catch 捕获并报告。
 */
import fs from 'fs';

let pass = 0, fail = 0;
const T = (n, c, err) => { c ? pass++ : (fail++, console.log('✗', n, err ? '\n    ' + err : '')); };

// ==================== 最小 DOM 桩 ====================
function makeCtx2D() {
  const noop = () => {};
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'canvas') return { width: 1200, height: 800, clientWidth: 1200, clientHeight: 800 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient')
        return () => ({ addColorStop: noop });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof k === 'string' && /^(fill|stroke|begin|move|line|arc|rect|close|save|restore|translate|scale|rotate|clip|set|clear|draw|put|quadratic|bezier|ellipse|transform|reset)/.test(k))
        return noop;
      return undefined; // 属性读取（fillStyle 等）返回 undefined，写入走 set
    },
    set: () => true,
  });
}

function makeElement(id = '') {
  const el = {
    id, tagName: 'DIV', style: {}, dataset: {}, classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    children: [], _listeners: {},
    width: 1200, height: 800, clientWidth: 1200, clientHeight: 800,
    textContent: '', innerHTML: '', value: '', disabled: false,
    addEventListener(t, f) { (this._listeners[t] ||= []).push(f); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    getContext() { return makeCtx2D(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; },
    focus() {}, blur() {}, click() {},
    setAttribute() {}, getAttribute() { return null; },
    closest() { return null; },
    insertAdjacentHTML() {},
    scrollIntoView() {},
    prepend() {}, append() {}, before() {}, after() {},
    replaceChildren() {}, cloneNode() { return makeElement(); },
    contains() { return false; },
    getElementsByClassName() { return []; },
    getElementsByTagName() { return []; },
    hasAttribute() { return false; }, removeAttribute() {},
    set innerText(v) {}, get innerText() { return ''; },
    get parentElement() { return _elements.get('canvasWrap') || makeElement('canvasWrap'); },
    get firstChild() { return null; },
  };
  return el;
}

const _elements = new Map();
function getEl(id) {
  if (!_elements.has(id)) _elements.set(id, makeElement(id));
  return _elements.get(id);
}

globalThis.document = {
  getElementById: (id) => getEl(id),
  createElement: (tag) => makeElement(),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: makeElement('body'),
  documentElement: makeElement('html'),
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
globalThis.requestAnimationFrame = () => 0; // 主循环由测试手动驱动，不让它自转
globalThis.devicePixelRatio = 1;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    configurable: true, writable: true,
  });
} catch { /* Node 22+ 的 navigator 是只读 getter，忽略即可 */ }
globalThis.Blob = class Blob {};
globalThis.URL = globalThis.URL || { createObjectURL: () => '', revokeObjectURL: () => {} };
globalThis.setInterval = () => 0;   // 天气 HUD 的定时器：不让它在测试里自转
globalThis.HTMLElement = class {};

// ==================== 加载游戏 ====================
let loadErr = null;
try {
  await import('../src/main.js');
} catch (e) {
  loadErr = e;
}
T('main.js 能被加载（模块顶层无运行时错误）', !loadErr, loadErr?.message);
if (loadErr) {
  console.log(`运行时冒烟: ${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

// ==================== 驱动真实的游戏循环 ====================
// main.js 的 gameLoop 通过 requestAnimationFrame 自驱动，测试里我们手动调它。
// 由于 gameLoop 不是导出的，改为直接驱动它调用的 stepSimulation 链路——
// 通过 window 上暴露的系统实例（main.js 已挂载 __weather / __score 等）。
// 更直接的办法：main.js 把 gameLoop 挂到 window 上供测试驱动。
const runFrames = (n, dtMs = 33) => {
  let err = null;
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    try {
      if (typeof window.CTX.__gameLoop === 'function') window.CTX.__gameLoop(start + i * dtMs);
    } catch (e) {
      err = e;
      break;
    }
  }
  return err;
};

T('游戏循环已导出供测试驱动（window.CTX.__gameLoop）', typeof window.CTX.__gameLoop === 'function');

// ---- 启动即成局：main.js 已经在启动时直接加载召唤师峡谷，跑 100 帧 ----
{
  const err = runFrames(100);
  T('启动即成局：游戏循环 100 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
}

// ---- 切换地图后跑 200 帧（覆盖出兵、战斗、碰撞、移动） ----
{
  let err = null;
  try {
    window.CTX.__mapSystem?.loadMap('summoners_rift_v1');
  } catch (e) { err = e; }
  T('对战模式：地图加载无崩溃', !err, err?.message);
  if (!err) {
    err = runFrames(200);
    T('对战模式：游戏循环 200 帧无崩溃（覆盖出兵/战斗/碰撞/移动）', !err,
      err?.stack?.split('\n').slice(0, 3).join('\n    '));
  }
}

// ---- 天气开启后再跑 100 帧 ----
{
  window.CTX.__weather?.setEnabled(true);
  const err = runFrames(100);
  T('天气开启：游戏循环 100 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
  window.CTX.__weather?.setEnabled(false);
}

// ---- 按阵营规则开关（v25 事故的直接触发点）----
{
  window.CTX.__towerRules.attackOff.blue = true;
  let err = runFrames(60);
  T('仅蓝方停火：60 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
  window.CTX.__towerRules.attackOff.blue = false;

  window.CTX.__towerRules.invincible.red = true;
  err = runFrames(60);
  T('仅红方无敌：60 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
  window.CTX.__towerRules.invincible.red = false;

  window.CTX.__towerRules.waveOn.blue = false;
  err = runFrames(60);
  T('关闭蓝方波次：60 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
  window.CTX.__towerRules.waveOn.blue = true;
}

// ---- 选中单位 + 天气开启（v26 事故：属性面板的天气行传错了变量，每帧崩） ----
// 教训：运行时冒烟必须【覆盖 UI 交互】，不能只跑游戏循环——
// UIManager.update() 只有在【有选中单位】时才会走进卡片刷新的代码路径。
{
  const ents = window.CTX.__entityContainer;
  const ui = window.CTX.__uiManager;
  T('实体容器与 UIManager 已导出供测试', !!ents && !!ui);

  if (ents && ui) {
    window.CTX.__weather?.setEnabled(true);

    // 选中一座塔 → 跑帧（覆盖 updateTowerCard → _updateWeatherRow）
    const tower = ents.getAllTowers(true)[0];
    let err = null;
    try {
      ui.selectEntity(tower.id);
      err = runFrames(60);
    } catch (e) { err = e; }
    T('选中防御塔 + 天气开启：60 帧无崩溃（属性面板天气行）', !err,
      err?.stack?.split('\n').slice(0, 3).join('\n    '));

    // 选中一个小兵 → 跑帧（覆盖 updateMinionCard → _updateWeatherRow）
    // 波次要 30 秒才出兵，测试里直接手动生成一个（走真实的 createMinion）
    if (!ents.getAllMinions(true).length && typeof window.CTX.createMinion === 'function') {
      window.CTX.createMinion('melee', 500, 500, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
    }
    const minion = ents.getAllMinions(true)[0];
    if (minion) {
      try {
        ui.selectEntity(minion.id);
        err = runFrames(60);
      } catch (e) { err = e; }
      T('选中小兵 + 天气开启：60 帧无崩溃（属性面板天气行）', !err,
        err?.stack?.split('\n').slice(0, 3).join('\n    '));
    } else {
      T('选中小兵 + 天气开启：60 帧无崩溃（属性面板天气行）', false, '没有小兵可选');
    }

    // 天气关闭后再跑（覆盖天气行的隐藏分支）
    window.CTX.__weather?.setEnabled(false);
    err = runFrames(30);
    T('天气关闭 + 选中单位：30 帧无崩溃', !err, err?.message);

    ui.clearSelection?.();
  }
}

// ---- 嚎哭深渊 ----
{
  let err = null;
  try {
    window.CTX.__mapSystem?.loadMap('howling_abyss_v1');
  } catch (e) { err = e; }
  T('嚎哭深渊：地图加载无崩溃', !err, err?.message);
  if (!err) {
    err = runFrames(150);
    T('嚎哭深渊：游戏循环 150 帧无崩溃', !err, err?.stack?.split('\n').slice(0, 3).join('\n    '));
  }
}

console.log(`运行时冒烟: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
