// Q2 验证：光束流动相位在充能变化时连续（旧式绝对时间×速度会瞬移）
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkStub() }) };
globalThis.window = globalThis.window || {};

let fakeNow = 3_600_000;                       // 开页已 1 小时：正是旧式跳变最凶的场景
globalThis.performance = { now: () => fakeNow };

const THREE = await import('./vendor/three.module.js');
const { EffectsLayer } = await import('./src/presentation/EffectsLayer.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n); };

const scene = new THREE.Scene();
const fx = new EffectsLayer(scene);

// 只关心 dashed 的 phase 参数 → 拦截 _dyn.dashed 记录每帧相位
const dashPhases = [];
// 第 6.3 步后光束走三维虚线 dashed3（端点带炮口高度），探针跟着改
const origDashed = Object.getPrototypeOf(fx._dyn).dashed3;
Object.getPrototypeOf(fx._dyn).dashed3 = function (ax, ay, az, bx, by, bz, w, col, a, dash, gap, phase, ...v) {
  dashPhases.push({ phase, period: dash + gap });
  return origDashed.call(this, ax, ay, az, bx, by, bz, w, col, a, dash, gap, phase, ...v);
};

const beam = { startX: 0, startY: 0, endX: 300, endY: 0, charge: 0, color: '#f1c40f', ttl: 1 };
const projectiles = { getBeams: () => [beam], getArcs: () => [], getProjectiles: () => [] };
const entities = { getAllTowers: () => [], getAllMinions: () => [] };
const deps = { entities, projectiles, mapSystem: null };

// 充能从 0 连续爬到 0.6（gap>0.4 区间，走虚线分支），每帧 16ms
for (let f = 0; f < 60; f++) {
  fakeNow += 16;
  beam.charge = Math.min(0.6, f * 0.01);
  fx.update(deps, 1, false, null, () => 0);
}

T('虚线分支确实被走到（采样 > 50 帧）', dashPhases.length > 50);

// 相位在环上的逐帧位移：连续流动应恒 ≈ flowSpeed×dt（≤ 4px/帧），绝不出现半个周期级瞬移
let worst = 0, worstIdx = -1;
for (let i = 1; i < dashPhases.length; i++) {
  const { phase: p1, period } = dashPhases[i];
  const p0 = dashPhases[i - 1].phase;
  // 相位为负值（流动方向），比较环上最短距离
  let d = Math.abs((p1 - p0) % period);
  d = Math.min(d, period - d);
  if (d > worst) { worst = d; worstIdx = i; }
}
console.log(`  最大单帧环上位移 = ${worst.toFixed(3)}px（帧 ${worstIdx}）`);
T('充能全程无瞬移（单帧位移 < 5px）', worst < 5);

// 对照：旧式公式在同一序列下会跳成什么样
let oldWorst = 0;
let prevOld = null;
for (let f = 0; f < 60; f++) {
  const charge = Math.min(0.6, f * 0.01);
  const dashLen = 5 + charge * 20, gap = dashLen * (1 - charge) * 0.9 + (1 - charge) * 3;
  const period = dashLen + gap;
  const flowSpeed = 60 + charge * 160;
  const wallT = (3_600_000 + (f + 1) * 16) / 1000;
  const ph = -((wallT * flowSpeed) % 100000);
  if (prevOld !== null) {
    let d = Math.abs((ph - prevOld) % period);
    d = Math.min(d, period - d);
    if (d > oldWorst) oldWorst = d;
  }
  prevOld = ph;
}
console.log(`  对照：旧式公式最大单帧环上位移 = ${oldWorst.toFixed(3)}px`);
T('对照组确认旧式确有瞬移（> 新式 3 倍）', oldWorst > worst * 3);

// 恒定充能下流动速率正确：charge=0 → flowSpeed 60px/s，16ms → ≈0.96px/帧
dashPhases.length = 0;
beam.charge = 0;
for (let f = 0; f < 20; f++) { fakeNow += 16; fx.update(deps, 1, false); }
const period0 = dashPhases[0].period;
let sum = 0;
for (let i = 1; i < dashPhases.length; i++) {
  let d = Math.abs((dashPhases[i].phase - dashPhases[i - 1].phase) % period0);
  d = Math.min(d, period0 - d);
  sum += d;
}
const avg = sum / (dashPhases.length - 1);
console.log(`  恒定充能平均速率 = ${(avg / 0.016).toFixed(1)}px/s（期望 60）`);
T('恒定充能流动速率 = flowSpeed（±5%）', Math.abs(avg / 0.016 - 60) < 3);

// 大间隔钳制：切标签页回来不瞬移
dashPhases.length = 0;
fakeNow += 30_000;                              // 30 秒空档
fx.update(deps, 1, false, null, () => 0); fx.update(deps, 1, false, null, () => 0);
fakeNow += 16; fx.update(deps, 1, false);
let jump = Math.abs((dashPhases[1].phase - dashPhases[0].phase) % period0);
jump = Math.min(jump, period0 - jump);
T('30s 空档后单帧位移被钳制（< 7px）', jump < 7);

// ---- 流向：必须与 2D 一致，由塔流向目标 ----
// 采样步长必须远小于虚线周期，否则混叠会把方向判反（诊断时栽过一次）。
{
  const seg = [];
  const proto2 = Object.getPrototypeOf(fx._dyn);
  const o2 = proto2.seg3;
  proto2.seg3 = function (ax, ay, az, bx, by, bz, w, ...r) {
    if (w > 1.5 && w < 3) seg.push((ax - beam.startX) / (beam.endX - beam.startX));
    return o2.call(this, ax, ay, az, bx, by, bz, w, ...r);
  };
  beam.charge = 0.3;
  fx.update(deps, 1, false);
  let prev = null, fwd = 0, back = 0;
  const period = 11 + (11 * 0.7 * 0.9 + 0.7 * 3);
  for (let k = 0; k < 40; k++) {
    seg.length = 0; fakeNow += 16; fx.update(deps, 1, false);
    const cand = seg.filter(v => v > 0.2 && v < 0.8).sort((a, b) => a - b);
    if (!cand.length) continue;
    if (prev !== null) {
      let best = cand[0], bd = Infinity;
      for (const c of cand) { const d = Math.abs(c - prev); if (d < bd) { bd = d; best = c; } }
      const dPix = (best - prev) * (beam.endX - beam.startX);
      if (Math.abs(dPix) < period * 0.4) (dPix > 0 ? fwd++ : back++);
      prev = best;
    } else prev = cand[0];
  }
  proto2.seg3 = o2;
  T('虚线由塔流向目标（与 2D 同向）', fwd > 5 && back === 0, `前进 ${fwd} / 后退 ${back}`);
}

console.log(`\nQ2 光束流动: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
