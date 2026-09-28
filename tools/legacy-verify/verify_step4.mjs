// 第 4 步 headless 验证：屏幕↔世界换算、拖拽补偿、选中光圈
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkStub() }) };
globalThis.window = globalThis.window || {}; window.gameTime = 0;

const THREE = await import('./vendor/three.module.js');
const { ThreeCameraController } = await import('./src/presentation/ThreeCameraController.js');
const { UnitLayer } = await import('./src/presentation/UnitLayer.js');
const { CONFIG } = await import('./src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

const W = 1600, H = 900, DEG = Math.PI / 180, CAM_DIST = 20000;

// 复刻 ThreeRenderer.syncCameraFrom 的相机装配（同一套公式，避免为测试引入 WebGL）
function mkCam(elevationDeg, zoom, offsetX, offsetY) {
  const p = elevationDeg * DEG, sinP = Math.sin(p), cosP = Math.cos(p);
  const tx = (W / 2 - offsetX) / zoom, tz = (H / 2 - offsetY) / zoom;
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, CAM_DIST * 3);
  cam.zoom = zoom;
  cam.position.set(tx, CAM_DIST * sinP, tz + CAM_DIST * cosP);
  cam.up.set(0, cosP, -sinP);
  cam.lookAt(new THREE.Vector3(tx, 0, tz));
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  return { cam, tx, tz, sinP };
}
const mkCtl = (elevationDeg, cam) => new ThreeCameraController(
  { camera: cam, elevationDeg },
  { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  () => true,
);

// ============ 1. 屏幕中心 → 摄像机目标点（任意仰角/缩放/偏移都成立）============
{
  let ok = true, worst = 0;
  for (const el of [30, 45, 60, 90]) {
    for (const z of [0.15, 0.5, 1, 3]) {
      for (const [ox, oy] of [[0, 0], [-500, 300], [220, -140]]) {
        const { cam, tx, tz } = mkCam(el, z, ox, oy);
        const w = mkCtl(el, cam).screenToWorld(W / 2, H / 2);
        const d = Math.hypot(w.x - tx, w.y - tz);
        worst = Math.max(worst, d);
        if (d > 0.01) ok = false;
      }
    }
  }
  T('屏幕中心恒等于摄像机目标点（36 组仰角×缩放×偏移）', ok, `最大误差 ${worst.toExponential(1)}px`);
}

// ============ 2. 与 2D 反算的一致性：仰角 90° 时两者必须逐点相同 ============
{
  const z = 0.8, ox = -300, oy = 150;
  const { cam } = mkCam(90, z, ox, oy);
  const ctl = mkCtl(90, cam);
  let worst = 0;
  for (const [sx, sy] of [[10, 10], [800, 450], [1590, 890], [400, 700]]) {
    const w3 = ctl.screenToWorld(sx, sy);
    const w2 = { x: (sx - ox) / z, y: (sy - oy) / z };   // CanvasController.screenToWorld 的公式
    worst = Math.max(worst, Math.hypot(w3.x - w2.x, w3.y - w2.y));
  }
  T('仰角 90° 下 3D 换算 == 2D 反算（对位验证的原理）', worst < 0.01, `最大误差 ${worst.toExponential(1)}px`);
}

// ============ 3. 45° 下横向严格 1:1、纵向按 sin 压缩（与相机映射注释一致）============
{
  const el = 45, z = 1, { cam, tx, tz, sinP } = mkCam(el, z, 0, 0);
  const ctl = mkCtl(el, cam);
  const dxPix = 200, dyPix = 200;
  const wx = ctl.screenToWorld(W / 2 + dxPix, H / 2);
  const wy = ctl.screenToWorld(W / 2, H / 2 + dyPix);
  T('横向：200px 屏幕位移 = 200 世界单位（1:1）', Math.abs((wx.x - tx) - dxPix / z) < 0.01,
    `实测 ${(wx.x - tx).toFixed(2)}`);
  T('纵向：200px 屏幕位移 = 200/sin(45°) ≈ 283 世界单位', Math.abs((wy.y - tz) - dyPix / z / sinP) < 0.01,
    `实测 ${(wy.y - tz).toFixed(2)}，期望 ${(dyPix / z / sinP).toFixed(2)}`);
}

// ============ 4. 拖拽补偿：offsetY += dy/sin 后，画面位移与鼠标严格 1:1 ============
{
  for (const el of [30, 45, 60, 90]) {
    const z = 0.7, dy = 137;
    const ctl = mkCtl(el, mkCam(el, z, 0, 0).cam);
    const ky = ctl.panScaleY();
    // 拖前/拖后：同一世界点在屏幕上应恰好移动 dy 像素
    const before = mkCam(el, z, 0, 0);
    const after = mkCam(el, z, 0, dy * ky);
    const wp = new THREE.Vector3(1000, 0, 1200);
    const sy = (c) => { const v = wp.clone().project(c); return (1 - v.y) / 2 * H; };
    const moved = sy(after.cam) - sy(before.cam);
    T(`拖拽补偿 @仰角${el}°：屏幕位移 == 鼠标位移`, Math.abs(moved - dy) < 0.02,
      `鼠标 ${dy}px → 画面 ${moved.toFixed(2)}px（补偿系数 ${ky.toFixed(3)}）`);
  }
}

// ============ 5. 选中光圈：出现/跟随/切换/清除，且不破坏场景不变量 ============
{
  const scene = new THREE.Scene();
  const L = new UnitLayer(scene);
  let sel = null;
  let towers = [], minions = [];
  const deps = {
    entities: { getAllTowers: (a) => a ? towers.filter(t => t.alive) : towers, getAllMinions: () => minions },
    attrCalc: { calc: (e) => ({ maxHP: 100, attackRange: 250 }) },
    effects: { getEffects: () => [] },
    getSelectedId: () => sel,
  };
  const inv = () => scene.children.length === 2 * L.map.size + L.infoObjs;
  const mkT = (id, o = {}) => ({ id, type: 'tower', alive: true, pos: { x: id * 100, y: 50 },
    currentHP: 100, _skillInstances: [], _mapFaction: 'blue', _mapTier: 'outer', _laneId: 1, ...o });

  towers = [mkT(1), mkT(2)];
  L.update(deps, 2.0, 0);
  T('未选中时无光圈', !L.map.get(1).selCore && inv());

  sel = 1; L.update(deps, 2.0, 0);
  T('选中 → 双层光圈出现', !!L.map.get(1).selCore && !!L.map.get(1).selGlow && inv());
  const bSize = (CONFIG.buildingSizes || {}).outer || (CONFIG.buildingSizes || {}).default || 28;
  T('光圈半径与 2D 同值（bSize + 8）', L.map.get(1).selKey === String(bSize + 8),
    `selKey=${L.map.get(1).selKey}`);

  towers[0].pos.x = 777; L.update(deps, 2.0, 0);
  T('光圈跟随单位移动', L.map.get(1).selCore.position.x === 777);

  sel = 2; L.update(deps, 2.0, 0);
  T('切换选中 → 旧光圈摘除、新光圈出现',
    !L.map.get(1).selCore && !!L.map.get(2).selCore && inv());

  sel = null; L.update(deps, 2.0, 0);
  T('取消选中 → 光圈全部摘除', !L.map.get(2).selCore && inv());

  // 选中期间单位死亡：entry 被兜底清理，光圈不得残留
  sel = 1; L.update(deps, 2.0, 0);
  const before = scene.children.length;
  towers[0].alive = false; L.update(deps, 2.0, 0);
  T('选中单位阵亡 → 光圈随 entry 一并回收', !L.map.get(1) && inv() && scene.children.length < before);

  // 长跑：反复切换选中不泄漏
  towers = [mkT(1), mkT(2), mkT(3)];
  for (let f = 0; f < 600; f++) { sel = (f % 4 === 3) ? null : (f % 3) + 1; L.update(deps, 2.0, f * 0.033); }
  T('600 帧反复切换选中：不变量成立、缓存有界', inv() && L._geoCache.size < 40);
  L.dispose();
  T('dispose 归零', scene.children.length === 0 && L.infoObjs === 0);
}

console.log(`\n第4步验证: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
