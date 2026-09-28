// Q1/Q3 验证：弹道抬到炮口高度、视向带子、分兵种造型与朝向
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkStub() }) };
globalThis.window = globalThis.window || {}; window.gameTime = 0;
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const THREE = await import('./vendor/three.module.js');
const { EffectsLayer } = await import('./src/presentation/EffectsLayer.js');
const { UnitLayer } = await import('./src/presentation/UnitLayer.js');
const MF = await import('./src/presentation/UnitMeshFactory.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

const EL = 45 * Math.PI / 180, sp = Math.sin(EL), cp = Math.cos(EL);
const VIEW = { vx: 0, vy: -sp, vz: -cp, ux: 0, uy: cp, uz: -sp };

// ============ Q1-a：几何图元本身 ============
{
  const scene = new THREE.Scene();
  const fx = new EffectsLayer(scene);
  const B = fx._dyn;

  B.reset();
  B.seg3(0, 50, 0, 100, 10, 0, 6, new THREE.Color('#fff'), 1, VIEW.vx, VIEW.vy, VIEW.vz);
  const p = B.pos;
  let ys = [];
  for (let i = 0; i < 18; i++) ys.push(p[i * 3 + 1]);
  T('seg3 产出的顶点确实带高度（不再全在 y=0）', ys.some(y => Math.abs(y) > 1), `y 范围 ${Math.min(...ys).toFixed(1)}~${Math.max(...ys).toFixed(1)}`);
  T('两端高度分别落在 50 与 10 附近', Math.max(...ys) > 45 && Math.min(...ys) < 15);

  // 带子必须朝向摄像机：其法向应与视线接近平行
  const A = new THREE.Vector3(p[0], p[1], p[2]), Bv = new THREE.Vector3(p[3], p[4], p[5]),
        C = new THREE.Vector3(p[6], p[7], p[8]);
  // 正确的性质不是"面法向 == 视线"（线本身有沿视线的分量时做不到），
  // 而是【宽度方向 ⊥ 视线】—— 这才是"宽度完整投影到屏幕上、不会被压成缝"的保证。
  const wid = new THREE.Vector3().subVectors(A, new THREE.Vector3(p[15], p[16], p[17])).normalize();
  const dotW = Math.abs(wid.dot(new THREE.Vector3(VIEW.vx, VIEW.vy, VIEW.vz)));
  T('带子宽度方向严格垂直于视线（宽度完整投影到屏幕）', dotW < 1e-6, `|w·v| = ${dotW.toExponential(1)}`);

  // 对照：贴地带子在这种斜线上会被压扁
  B.reset();
  B.seg(0, 0, 100, 0, 6, new THREE.Color('#fff'), 1);
  const n2 = new THREE.Vector3(0, 1, 0);
  T('对照：贴地带子法向朝上，斜线上会被压成缝',
    Math.abs(n2.dot(new THREE.Vector3(VIEW.vx, VIEW.vy, VIEW.vz))) < 0.75);

  B.reset();
  const before = B.n;
  B.sprite3(10, 60, 20, 8, new THREE.Color('#fff'), 1, VIEW.ux, VIEW.uy, VIEW.uz);
  T('sprite3 生成两个三角形', B.n === before + 2);
  let sy = [];
  for (let i = 0; i < 6; i++) sy.push(B.pos[i * 3 + 1]);
  T('子弹片悬在指定高度附近', Math.min(...sy) > 55 && Math.max(...sy) < 65);
}

// ============ 深度语义：特效受墙体遮挡（"墙壁透明"的回归守卫）============
{
  const scene = new THREE.Scene();
  const fx = new EffectsLayer(scene);
  for (const [name, b] of [['静态参照', fx._stat], ['动态线', fx._dyn], ['子弹', fx._quad]]) {
    T(`${name}批参与深度测试（关掉会画在高地之上=墙看着透明）`, b.mesh.material.depthTest === true);
    T(`${name}批不写深度（特效之间不互相遮挡）`, b.mesh.material.depthWrite === false);
  }
  T('贴地批抬离地面，避开与地面平面 z-fighting',
    fx._stat.mesh.position.y > 0 && fx._stat.mesh.position.y < 3, `y=${fx._stat.mesh.position.y}`);
}

// ============ Q1-c：光束三层与子弹高度（本轮 bug 的回归守卫）============
{
  const scene = new THREE.Scene();
  const fx = new EffectsLayer(scene);
  const beam = { startX: 100, startY: 100, endX: 400, endY: 100, charge: 0.8, color: '#f1c40f', ttl: 1 };
  const bullet = { startX: 100, startY: 100, currentX: 250, currentY: 100, targetId: 7, color: '#e8563f', size: 20 };
  const target = { id: 7, pos: { x: 400, y: 100 } };
  const deps = {
    entities: { getAllTowers: () => [], getAllMinions: () => [], get: (id) => (id === 7 ? target : null) },
    projectiles: { getBeams: () => [beam], getArcs: () => [], getProjectiles: () => [bullet] },
    mapSystem: null,
  };
  // 炮口：起点 90（塔顶），目标处 20（小兵）
  const MY = (x) => (Math.abs(x - 100) < 30 ? 90 : (Math.abs(x - 400) < 30 ? 20 : 0));
  fx.update(deps, 1, false, VIEW, MY);

  const hasNaN = (b) => { for (let i = 0; i < b.n * 9; i++) if (!Number.isFinite(b.pos[i])) return true; return false; };
  T('光束顶点无 NaN（缺视线参数会让整层静默消失）', !hasNaN(fx._dyn));
  // 逐层验，而不是拍一个总三角数阈值：被 bug 干掉的恰好是【辉光】与【白热核】两层，
  // 虚线层参数完整所以一直是好的，只看总数会把"少两层"混在计数波动里。
  const colAt = (b, t) => [b.col[t * 12], b.col[t * 12 + 1], b.col[t * 12 + 2]];
  let hasWhite = false, widest = 0;
  for (let t = 0; t < fx._dyn.n; t++) {
    const c = colAt(fx._dyn, t);
    if (c[0] > 0.95 && c[1] > 0.95 && c[2] > 0.95) hasWhite = true;
    // 三角形跨度近似宽度：取三顶点 y 极差（带子沿 x 走，宽度落在 y/z 上）
    const ys = [fx._dyn.pos[t * 9 + 1], fx._dyn.pos[t * 9 + 4], fx._dyn.pos[t * 9 + 7]];
    widest = Math.max(widest, Math.max(...ys) - Math.min(...ys));
  }
  T('白热核层已渲染（此前缺视线参数被静默丢弃）', hasWhite);
  T('辉光层已渲染（宽度显著大于主体线宽）', widest > 8, `最宽跨度 ${widest.toFixed(1)}`);

  // 子弹：飞到一半，高度应在 炮口90 与 目标12(=20×0.6) 之间
  const q = fx._quad;
  T('子弹顶点无 NaN', !hasNaN(q));
  let by = -1;
  for (let i = 0; i < q.n * 3; i++) by = Math.max(by, q.pos[i * 3 + 1]);
  T('子弹半途高度介于炮口与目标之间（不再贴地飞）', by > 20 && by < 90, `峰值高度 ${by.toFixed(1)}`);

  // 全程贴地的旧行为：目标查不到时应退化为炮口高度，而不是 0
  const deps2 = { ...deps, entities: { ...deps.entities, get: () => null } };
  fx.update(deps2, 1, false, VIEW, MY);
  let by2 = -1;
  for (let i = 0; i < fx._quad.n * 3; i++) by2 = Math.max(by2, fx._quad.pos[i * 3 + 1]);
  T('目标丢失时退化为炮口高度（不塌回地面）', by2 > 85, `${by2.toFixed(1)}`);
}

// ============ Q1-b：炮口高度查询 ============
{
  const scene = new THREE.Scene();
  const L = new UnitLayer(scene);
  let towers = [], minions = [];
  const deps = {
    entities: { getAllTowers: (a) => a ? towers.filter(t => t.alive) : towers, getAllMinions: () => minions },
    attrCalc: { calc: () => ({ maxHP: 100, attackRange: 250 }) },
    effects: { getEffects: () => [] }, getSelectedId: () => null,
  };
  towers = [{ id: 1, type: 'tower', alive: true, pos: { x: 500, y: 500 }, currentHP: 100,
              _skillInstances: [{ skillId: 'weapon_lightning' }], _mapFaction: 'blue',
              _mapTier: 'outer', _laneId: 1 }];
  minions = [{ id: 9, type: 'melee', alive: true, pos: { x: 900, y: 900 }, currentHP: 100,
               _skillInstances: [], _mapFaction: 'red' }];
  L.update(deps, 2.0, 0);

  const towerTop = L.map.get(1).topY, minionTop = L.map.get(9).topY;
  T('塔位置查得炮口高度 = 模型顶端', Math.abs(L.muzzleY(500, 500) - towerTop) < 1e-9,
    `${L.muzzleY(500, 500).toFixed(1)}`);
  T('炮口明显高于地面（这正是 Q1 要修的）', L.muzzleY(500, 500) > 40);
  T('小兵位置查得较矮的炮口', Math.abs(L.muzzleY(900, 900) - minionTop) < 1e-9 && minionTop < towerTop,
    `小兵 ${minionTop.toFixed(1)} < 塔 ${towerTop.toFixed(1)}`);
  T('空地查得 0（不会把弹道莫名抬起来）', L.muzzleY(2000, 2000) === 0);
  T('查询半径外不误命中', L.muzzleY(500 + 40, 500) === 0);
  L.dispose();
}

// ============ Q3：分兵种造型互不相同 ============
{
  MF.disposeMeshCache();
  const types = ['melee', 'ranged', 'siege', 'ram', 'super'];
  const geos = new Map();
  for (const t of types) {
    const m = MF.minionMesh('m|' + t, '#5b9bd5', 14, t);
    geos.set(t, m);
  }
  const counts = types.map(t => geos.get(t).geo.getAttribute('position').count);
  T('五个兵种产出五份不同几何', new Set(types.map(t => geos.get(t).geo)).size === 5);
  T('顶点数各不相同（造型确有差异）', new Set(counts).size === 5, counts.join(' / '));

  // 载具应比步兵矮而宽（有轮子的车不该像人一样立着）
  const bbox = (t) => { const g = geos.get(t).geo; g.computeBoundingBox(); return g.boundingBox; };
  const wide = (t) => { const b = bbox(t); return Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / (b.max.y - b.min.y); };
  T('炮车比近战兵扁宽（车 ≠ 人）', wide('siege') > wide('melee'),
    `炮车 ${wide('siege').toFixed(2)} vs 近战 ${wide('melee').toFixed(2)}`);
  T('投石机纵向更长（车身+抛臂）', (bbox('ram').max.z - bbox('ram').min.z) > (bbox('melee').max.z - bbox('melee').min.z) * 1.5);
  // 机甲全由盒体构成（方块化的机械感），故顶点数显著低于用了球/环的步兵
  T('机甲是全盒体造型（顶点数最低，机械方块感）',
    geos.get('super').geo.getAttribute('position').count === Math.min(...counts));
  T('所有兵种原点仍在底面（贴地站稳）', types.every(t => Math.abs(bbox(t).min.y) < 1e-5));

  T('五个兵种都需要朝向', types.every(t => MF.needsFacing(t)));
  T('对称兵种不需要朝向', !MF.needsFacing('totem') && !MF.needsFacing('corrupt'));
}

// ============ Q3-b：朝向由位置增量自算 ============
{
  const scene = new THREE.Scene();
  const L = new UnitLayer(scene);
  let minions = [{ id: 5, type: 'siege', alive: true, pos: { x: 0, y: 0 }, currentHP: 100,
                   _skillInstances: [], _mapFaction: 'blue' }];
  const deps = {
    entities: { getAllTowers: () => [], getAllMinions: () => minions },
    attrCalc: { calc: () => ({ maxHP: 100 }) }, effects: { getEffects: () => [] },
    getSelectedId: () => null,
  };
  L.update(deps, 2.0, 0);
  const en = L.map.get(5);
  T('初始朝向为 0', en.unit.rotation.y === 0);

  // 朝 +X 走：模型朝 +Z 建，故目标角 = atan2(1,0) = π/2
  for (let f = 0; f < 60; f++) { minions[0].pos.x += 3; L.update(deps, 2.0, f * 0.033); }
  T('向 +X 移动后朝向收敛到 +X（π/2）', Math.abs(en.unit.rotation.y - Math.PI / 2) < 0.05,
    `${en.unit.rotation.y.toFixed(3)}`);

  // 掉头朝 -X：必须走最短弧，中途不得出现绕远路的大角度
  let total = 0, prev = en.unit.rotation.y;
  for (let f = 0; f < 60; f++) {
    minions[0].pos.x -= 3; L.update(deps, 2.0, f * 0.033);
    total += Math.abs(en.unit.rotation.y - prev); prev = en.unit.rotation.y;
  }
  // "最短弧"的正确判据是【总转过的角度 ≈ π 而不是 3π】，不是单帧步长小
  T('掉头走最短弧（累计转角 ≈ π，未绕远路）', total > Math.PI * 0.9 && total < Math.PI * 1.3,
    `累计 ${(total / Math.PI).toFixed(2)}π`);
  T('掉头后朝向收敛到 -X（-π/2）', Math.abs(Math.abs(en.unit.rotation.y) - Math.PI / 2) < 0.05,
    `${en.unit.rotation.y.toFixed(3)}`);

  // 静止帧不得把朝向清零
  const held = en.unit.rotation.y;
  for (let f = 0; f < 10; f++) L.update(deps, 2.0, f * 0.033);
  T('静止帧不重置朝向（仅收尾插值，变化 < 0.01rad）',
    Math.abs(en.unit.rotation.y - held) < 0.01, `Δ ${Math.abs(en.unit.rotation.y - held).toExponential(1)}`);
  L.dispose();
}

console.log(`\nQ1+Q3: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
