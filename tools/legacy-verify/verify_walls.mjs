// 第 6.2 步验证：墙体几何与碰撞判据同源、构建成本、切图重建
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
// 需要真的 ImageData/putImageData 语义 → 用可记录的假画布
function fakeCanvas() {
  const c = { width: 0, height: 0, _data: null };
  c.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { c._data = img; },
  });
  return c;
}
globalThis.document = { createElement: () => fakeCanvas() };
globalThis.window = globalThis.window || {}; window.gameTime = 0;

const THREE = await import('./vendor/three.module.js');
const { WallLayer } = await import('./src/presentation/WallLayer.js');
const { EntityContainer } = await import('./src/core/EntityContainer.js');
const { EventBus } = await import('./src/utils/EventBus.js');
const { MapSystem } = await import('./src/systems/MapSystem.js');
const { CONFIG } = await import('./src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

// ---- 真 MapSystem，真地图 ----
const bus = new EventBus(), ents = new EntityContainer(bus);
const mapSys = new MapSystem(ents, bus);
mapSys.setCreateBuildingFn(({ faction, tier, laneId, pos, stats }) => {
  const tpl = CONFIG.templates.tower, s = stats || {};
  const e = { id: ++window._uid || (window._uid = 1), type: 'tower', alive: true, pos: { ...pos },
    baseStats: { ...tpl, maxHP: s.maxHP ?? tpl.maxHP, attackDamage: s.attackDamage ?? 0,
                 baseAttackSpeed: s.baseAttackSpeed ?? 0 },
    currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: faction, _mapTier: tier, _laneId: laneId || null, faction };
  ents.add(e); return e;
});
mapSys.loadMap();
T('地图已加载且声明了墙', mapSys.hasWalls(), `world ${mapSys.currentMap.world.w}`);

const scene = new THREE.Scene();
const L = new WallLayer(scene);
const tex = new THREE.Texture();

L.rebuild(mapSys, tex);
const st = L.buildStats();
console.log(`  构建：${st.cells} 格，其中墙格 ${st.wallCells}（${(st.wallCells / st.cells * 100).toFixed(0)}%），崖面 ${st.cliffTris} 三角，耗时 ${st.buildMs.toFixed(0)}ms`);

T('顶面与崖面都已入场景', !!L.top && !!L.cliff && scene.children.length === 2);
T('构建耗时在切图可接受范围（< 500ms）', st.buildMs < 500, `${st.buildMs.toFixed(0)}ms`);
T('崖面三角数可控（< 60k）', st.cliffTris < 60000, `${st.cliffTris}`);
T('墙格占比合理（30%~85%，走廊不至于淹没或消失）',
  st.wallCells / st.cells > 0.3 && st.wallCells / st.cells < 0.85);

// ---- 核心：几何与碰撞判据同源 ----
{
  // 遮罩 alpha 必须与 isWalkable 逐格一致
  const img = document.createElement('canvas'); // 取最近一次 putImageData
  const mask = L.top.material.alphaMap.image._data;
  const WW = mapSys.currentMap.world.w, WH = mapSys.currentMap.world.h;
  const nx = mask.width, ny = mask.height;
  const cell = Math.ceil(WW / nx) === 8 ? 8 : WW / nx;
  let bad = 0, checked = 0;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let n = 0; n < 4000; n++) {
    const i = Math.floor(rnd() * nx), j = Math.floor(rnd() * ny);
    const walkable = mapSys.isWalkable((i + 0.5) * cell, (j + 0.5) * cell);
    // 必须断言【绿色通道】——three 的 alphaMap 只读 .g。首版断言读 alpha 通道，
    // 于是"我写进去的数据"被验证为正确，而 three 的解读完全不同，顶面整片消失却全绿通过。
    const opaque = mask.data[(j * nx + i) * 4 + 1] > 127;
    checked++;
    if (walkable === opaque) bad++;   // 可走处必须透明，墙处必须不透明
  }
  T('遮罩与 isWalkable 逐格一致（4000 点抽样）', bad === 0, `不一致 ${bad}/${checked}`);
}

// ---- 分层采样必须与暴力采样逐字节相同（守住"无极窄走廊"的前提）----
{
  const WW = mapSys.currentMap.world.w, WH = mapSys.currentMap.world.h;
  const nx = Math.ceil(WW / 8), ny = Math.ceil(WH / 8);
  const t1 = performance.now();
  const brute = L._sampleBrute(mapSys, nx, ny);
  const bruteMs = performance.now() - t1;
  const t2 = performance.now();
  const fast = L._sample(mapSys, nx, ny);
  const fastMs = performance.now() - t2;
  let diff = 0;
  for (let k = 0; k < brute.length; k++) if (brute[k] !== fast[k]) diff++;
  console.log(`  采样：暴力 ${bruteMs.toFixed(0)}ms → 分层 ${fastMs.toFixed(0)}ms（${(bruteMs / fastMs).toFixed(1)}×）`);
  T('分层采样与暴力采样逐字节相同', diff === 0, `不同 ${diff}/${brute.length}`);
}

// ---- 崖面全部位于墙/可走边界上 ----
{
  const p = L.cliff.geometry.getAttribute('position');
  let offBoundary = 0, samples = 0;
  const cell = 8;
  for (let v = 0; v < p.count; v += 6) {   // 每 6 顶点 = 一片墙皮
    let cx = 0, cz = 0;
    for (let k = 0; k < 6; k++) { cx += p.getX(v + k); cz += p.getZ(v + k); }
    cx /= 6; cz /= 6;
    samples++;
    // 墙皮中心两侧 ±半格，必须一侧可走一侧不可走
    const n = L.cliff.geometry.getAttribute('normal');
    const nxv = n.getX(v), nzv = n.getZ(v);
    const inSide = mapSys.isWalkable(cx - nxv * cell * 0.6, cz - nzv * cell * 0.6);
    const outSide = mapSys.isWalkable(cx + nxv * cell * 0.6, cz + nzv * cell * 0.6);
    if (inSide || !outSide) offBoundary++;
    if (samples > 3000) break;
  }
  T('崖面均立在"墙内→可走"的边界上', offBoundary === 0,
    `越界 ${offBoundary}/${samples}`);
}

// ---- 绕序：three 判正面看绕序不看法线属性，反了就会被 FrontSide 整片剔除 ----
{
  const p = L.cliff.geometry.getAttribute('position'), n = L.cliff.geometry.getAttribute('normal');
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), g = new THREE.Vector3(), N = new THREE.Vector3();
  let bad = 0;
  for (let t = 0; t < p.count / 3; t++) {
    A.fromBufferAttribute(p, t * 3); B.fromBufferAttribute(p, t * 3 + 1); C.fromBufferAttribute(p, t * 3 + 2);
    e1.subVectors(B, A); e2.subVectors(C, A); g.crossVectors(e1, e2).normalize();
    N.fromBufferAttribute(n, t * 3);
    if (g.dot(N) <= 0) bad++;
  }
  T('崖面绕序与外法线一致（反了会被背面剔除，墙皮整片消失）', bad === 0,
    `反向 ${bad}/${p.count / 3}`);
  T('材质保持 FrontSide（不用 DoubleSide 掩盖绕序错误）',
    L.cliff.material.side === THREE.FrontSide);
}

// ---- 竖直性与高度 ----
{
  const p = L.cliff.geometry.getAttribute('position');
  let ys = new Set();
  for (let v = 0; v < Math.min(p.count, 600); v++) ys.add(p.getY(v));
  const arr = [...ys].sort((a, b) => a - b);
  T('崖面只有上下两个 y（严格竖直）', arr.length === 2 && arr[0] === 0,
    `y = ${arr.join(', ')}`);
  T('顶面高度与崖面顶端一致', Math.abs(L.top.position.y - arr[1]) < 1e-9);
}

// ---- 阴影档位 ----
{
  L.setShadowLevel('static');
  T("'static' 档：墙体投影且接收", L.top.castShadow && L.cliff.castShadow && L.cliff.receiveShadow);
  L.setShadowLevel('off');
  T("'off' 档：墙体不投影", !L.top.castShadow && !L.cliff.castShadow);
}

// ---- 重建不泄漏 ----
{
  L.setShadowLevel('static');
  for (let i = 0; i < 5; i++) L.rebuild(mapSys, tex);
  T('反复重建后场景仍只有 2 个网格（无泄漏）', scene.children.length === 2);
  L.clear();
  T('clear 后场景归零', scene.children.length === 0 && !L.top && !L.cliff);
}

// ---- 无墙地图（沙盒）不产生几何 ----
{
  L.rebuild({ hasWalls: () => false, currentMap: null }, tex);
  T('无墙地图不生成任何墙体', scene.children.length === 0);
}

console.log(`\n第6.2步 墙体挤出: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
