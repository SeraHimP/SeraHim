// 第 6.1 步验证：光照标定（地面外观必须不变）+ 阴影相机跟随 + 三档开关
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkStub() }) };
globalThis.window = globalThis.window || {};

const THREE = await import('./vendor/three.module.js');
const { ThreeRenderer } = await import('./src/presentation/ThreeRenderer.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

// ThreeRenderer 的构造要真 WebGL，headless 建不了。但 _buildLights / _fitShadowToView
// 只依赖 this.scene / this.gl / this._target 等少数成员，故用最小载体直接调原型方法——
// 测的是【真代码】，不是复刻的公式。
const P = ThreeRenderer.prototype;
const rig = () => {
  const o = {
    scene: new THREE.Scene(),
    gl: { shadowMap: {} },
    width: 1600, height: 900,
    elevationDeg: 45,
    _target: new THREE.Vector3(1776, 0, 1776),
    _terrainMesh: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial()),
    units: { setShadowLevel(l) { this.level = l; } },
  };
  P._buildLights.call(o);
  return o;
};

// ============ 1. 辐照度标定：平面地面出射 == 无光照时代 ============
{
  const o = rig();
  // three r169 已核对：BRDF_Lambert = 漫反射/π，环境与半球辐照度不乘 π。
  // 地面法线恒 +Y → 半球取天空色全额、平行光取 sin(太阳仰角)。
  const sinSun = o._sunDir.y;
  const irradiance = o.hemi.intensity + o.sun.intensity * sinSun;
  T('地面总辐照度 == π（外观与 MeshBasic 时代逐像素相同）',
    Math.abs(irradiance - Math.PI) < 1e-9,
    `实测 ${irradiance.toFixed(9)}，π = ${Math.PI.toFixed(9)}`);

  const ambientShare = o.hemi.intensity / Math.PI;
  T('环境/平行分配落在低多边形常用区间（0.25~0.55）',
    ambientShare > 0.25 && ambientShare < 0.55, `环境占比 ${(ambientShare * 100).toFixed(0)}%`);
  T('太阳仰角高于摄像机仰角（投影不会长到盖住画面）',
    Math.asin(sinSun) / Math.PI * 180 > o.elevationDeg,
    `太阳 ${(Math.asin(sinSun) / Math.PI * 180).toFixed(0)}° vs 摄像机 ${o.elevationDeg}°`);
  T('光源方向为单位向量', Math.abs(o._sunDir.length() - 1) < 1e-9);
}

// ============ 2. 三档开关 ============
{
  const o = rig();
  T('默认档位 off（未显式设置前不产生阴影开销）', o.shadowLevel === 'off');

  P.setShadowLevel.call(o, 'all');
  T("'all'：阴影开、单位投影", o.gl.shadowMap.enabled === true
    && P.unitsCastShadow.call(o) === true && P.staticCastShadow.call(o) === true);
  T("'all' 档位下传到 UnitLayer", o.units.level === 'all');
  T("'all'：地面接收阴影", o._terrainMesh.receiveShadow === true);

  P.setShadowLevel.call(o, 'static');
  T("'static'：阴影开、但单位不投影", o.gl.shadowMap.enabled === true
    && P.unitsCastShadow.call(o) === false && P.staticCastShadow.call(o) === true);

  P.setShadowLevel.call(o, 'off');
  T("'off'：阴影关、地面不再接收", o.gl.shadowMap.enabled === false
    && P.staticCastShadow.call(o) === false && o._terrainMesh.receiveShadow === false);

  T('非法档位回落到 off', P.setShadowLevel.call(o, '乱写') === 'off');
}

// ============ 3. 阴影相机跟随视野 ============
{
  const o = rig();
  P.setShadowLevel.call(o, 'static');
  const cam = o.sun.shadow.camera;

  P._fitShadowToView.call(o, { zoom: 1 });
  const r1 = cam.right;
  P._fitShadowToView.call(o, { zoom: 2 });
  const r2 = cam.right;
  T('拉近一倍 → 阴影视锥缩小一半（分辨率随之翻倍）',
    Math.abs(r1 / r2 - 2) < 1e-6, `zoom1 半径 ${r1.toFixed(0)} → zoom2 半径 ${r2.toFixed(0)}`);

  // 全图视角（3552 世界装进 1600×900）下必须真的罩住可见区域
  const fitZoom = Math.min(1600 / 3552, 900 / 3552) * 0.95;
  P._fitShadowToView.call(o, { zoom: fitZoom });
  const sinP = Math.sin(o.elevationDeg * Math.PI / 180);
  const needHalfW = (o.width / 2) / fitZoom, needHalfD = (o.height / 2) / fitZoom / sinP;
  T('全图视角下视锥罩住整个可见矩形',
    cam.right >= Math.hypot(needHalfW, needHalfD) - 1e-6,
    `视锥半径 ${cam.right.toFixed(0)} ≥ 外接圆 ${Math.hypot(needHalfW, needHalfD).toFixed(0)}`);

  T('光源与其目标点同步跟随视野中心',
    Math.abs(o.sun.target.position.x - o._target.x) < 1e-9
    && Math.abs(o.sun.target.position.z - o._target.z) < 1e-9);
  T('光源高于地面（方向向下照）', o.sun.position.y > 0);
  T('近远裁剪面能包住光源到地面的距离',
    cam.far > o.sun.position.distanceTo(o._target) && cam.near > 0);

  // 关档时不做无谓计算
  P.setShadowLevel.call(o, 'off');
  const before = cam.right;
  P._fitShadowToView.call(o, { zoom: 99 });
  T('关档后跳过视锥计算（零开销）', cam.right === before);
}

// ============ 4. 灯全部挂进场景，且不污染单位计数 ============
{
  const o = rig();
  const lights = o.scene.children.filter(c => c.isLight);
  T('半球光 + 平行光已入场景', lights.length === 2);
  T('平行光的 target 也已入场景（否则朝向不生效）',
    o.scene.children.includes(o.sun.target));
}

console.log(`\n第6.1步 光照基座: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
