// 第 6.3 + 6.5 验证：程序化三维单位、共享缓存、贴图接入
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (t[k] ??= mkStub())),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => mkStub() }) };
globalThis.window = globalThis.window || {}; window.gameTime = 0;

const THREE = await import('./vendor/three.module.js');
const { UnitLayer } = await import('./src/presentation/UnitLayer.js');
const MF = await import('./src/presentation/UnitMeshFactory.js');
const { CONFIG } = await import('./src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

// ============ 1. 几何本身：立体、原点在底、共享 ============
{
  MF.disposeMeshCache();
  const a = MF.towerMesh('k1', '#5b9bd5', 28, 'weapon_lightning', 'tower', false);
  const p = a.geo.getAttribute('position');
  let minY = Infinity, maxY = -Infinity, maxR = 0;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)));
  }
  T('塔几何非空且是三维体', p.count > 100 && maxY > 0, `${p.count} 顶点`);
  T('原点在底面（贴地站稳，不半陷）', Math.abs(minY) < 1e-6, `minY=${minY.toFixed(4)}`);
  T('topY 与几何实际高度一致', Math.abs(a.topY - maxY) < 0.5, `topY=${a.topY.toFixed(1)} maxY=${maxY.toFixed(1)}`);
  T('横向尺寸与 bSize 同量级（不会撑爆走廊）', maxR < 28 * 1.3, `maxR=${maxR.toFixed(1)}`);
  T('带顶点色（多部件配色靠它，单 draw call）', !!a.geo.getAttribute('color'));
  T('法线齐全', a.geo.getAttribute('normal').count === p.count);

  const b = MF.towerMesh('k1', '#5b9bd5', 28, 'weapon_lightning', 'tower', false);
  T('同 key 复用同一份几何（显存不随单位数增长）', a.geo === b.geo);
  const c = MF.towerMesh('k2', '#e0473f', 28, 'weapon_sniper', 'tower', false);
  T('不同 key 产出不同几何', c.geo !== a.geo);

  // 武器标记已移除（用户拍板）：塔身高度不再随武器变化，炮口改由 GLB 挂点提供
  const noW = MF.towerMesh('k3', '#5b9bd5', 28, '', 'tower', false);
  T('武器标记已移除（有无武器塔身等高）', Math.abs(a.topY - noW.topY) < 1e-9, `${a.topY.toFixed(1)} vs ${noW.topY.toFixed(1)}`);

  // 水晶造型
  const gem = MF.towerMesh('k4', '#5b9bd5', 40, '', 'gem', false);
  T('水晶走宝石造型（几何不同于普通塔）', gem.geo !== noW.geo && gem.topY > 0);

  // 小兵：有头有身体 → 高度明显大于半径
  const mm = MF.minionMesh('m1', '#5b9bd5', 12, 'blue');
  const mp = mm.geo.getAttribute('position');
  let mMaxY = 0, mMaxR = 0;
  for (let i = 0; i < mp.count; i++) { mMaxY = Math.max(mMaxY, mp.getY(i)); mMaxR = Math.max(mMaxR, Math.hypot(mp.getX(i), mp.getZ(i))); }
  T('小兵是立姿（高 > 宽）', mMaxY > mMaxR * 1.5, `高 ${mMaxY.toFixed(1)} / 半宽 ${mMaxR.toFixed(1)}`);

  const dm = MF.dragonMesh('d1', '#c0392b', true);
  T('巨龙几何非空且大于小兵', dm.geo.getAttribute('position').count > 100 && dm.topY > mm.topY);

  T('材质共享（实心/幽灵各一份）', MF.unitMaterial(false) === MF.unitMaterial(false)
    && MF.unitMaterial(true) !== MF.unitMaterial(false));
  T('幽灵材质半透明', MF.unitMaterial(true).transparent && MF.unitMaterial(true).opacity < 1);
}

// ============ 2. UnitLayer：网格装配、血条上浮、生命周期不回退 ============
{
  const scene = new THREE.Scene();
  const L = new UnitLayer(scene);
  let towers = [], minions = [];
  const deps = {
    entities: { getAllTowers: (a) => a ? towers.filter(t => t.alive) : towers, getAllMinions: () => minions },
    attrCalc: { calc: () => ({ maxHP: 100, attackRange: 250 }) },
    effects: { getEffects: () => [] },
    getSelectedId: () => null,
  };
  const inv = () => scene.children.length === 2 * L.map.size + L.infoObjs;
  const mkT = (id, o = {}) => ({ id, type: 'tower', alive: true, pos: { x: id * 100, y: 50 },
    currentHP: 100, _skillInstances: [{ skillId: 'weapon_lightning' }],
    _mapFaction: 'blue', _mapTier: 'outer', _laneId: 1, ...o });
  const mkM = (id, type) => ({ id, type, alive: true, pos: { x: id * 30, y: 300 },
    currentHP: 100, _skillInstances: [], _mapFaction: 'red' });

  towers = [mkT(1)]; minions = [mkM(50, 'melee'), mkM(51, 'ranged')];
  L.update(deps, 2.0, 0);
  const en = L.map.get(1);
  T('单位本体是 Mesh 而非 Sprite', en.unit.isMesh === true && !en.unit.isSprite);
  T('几何已装配（非空壳）', en.unit.geometry.getAttribute('position').count > 100);
  T('深度测试开启（立体单位需与墙体/彼此正确遮挡）', en.unit.material.depthTest !== false);
  T('血条浮在模型顶端而非地面', en.bar.position.y > 10 && Math.abs(en.bar.position.y - en.topY) < 1e-6,
    `barY=${en.bar.position.y.toFixed(1)} topY=${en.topY.toFixed(1)}`);
  T('小兵也已网格化', L.map.get(50).unit.isMesh && L.map.get(50).unit.geometry.getAttribute('position').count > 50);
  T('场景不变量成立', inv());

  // 阴影档位下传到已在场单位
  L.setShadowLevel('static');
  T("'static'：塔投影、小兵不投", L.map.get(1).unit.castShadow === true && L.map.get(50).unit.castShadow === false);
  L.setShadowLevel('all');
  T("'all'：小兵也投影", L.map.get(50).unit.castShadow === true);
  L.setShadowLevel('off');
  T("'off'：都不投影", !L.map.get(1).unit.castShadow && !L.map.get(50).unit.castShadow);

  // 换武器 → 换几何（key 语义保持）
  const g0 = L.map.get(1).unit.geometry;
  towers[0]._skillInstances = [{ skillId: 'weapon_sniper' }];
  L.update(deps, 2.0, 0);
  T('换武器触发换模型（key 机制照旧生效）', L.map.get(1).unit.geometry !== g0);

  // 移除单位不得释放共享几何
  const shared = L.map.get(50).unit.geometry;
  minions = [mkM(51, 'ranged')];
  L.update(deps, 2.0, 0);
  T('单位移除后共享几何仍可用（未被误 dispose）',
    shared.getAttribute('position') && shared.getAttribute('position').count > 0 && inv());

  // 长跑
  let ok = true;
  for (let f = 0; f < 1500; f++) {
    for (const t of towers) if (f % 97 === 0) t.alive = !t.alive;
    L.update(deps, f % 3 === 0 ? 1.0 : 2.0, f * 0.033);
    if (!inv()) { ok = false; break; }
  }
  T('1500 帧长跑不变量成立', ok);
  const geoN = MF.meshCacheSize();
  for (let i = 60; i < 90; i++) minions.push(mkM(i, ['melee','ranged','siege','super'][i % 4]));
  L.update(deps, 2.0, 0);
  T('30 个新单位不新增几何（按 key 复用）', MF.meshCacheSize() <= geoN + 4,
    `缓存 ${geoN} → ${MF.meshCacheSize()}`);
  L.dispose();
  T('dispose 后场景归零', scene.children.length === 0);
}

// ============ 3. 深度语义：贴地贴花受墙体遮挡，UI 覆盖层不受 ============
{
  const scene = new THREE.Scene();
  const L = new UnitLayer(scene);
  let towers = [{ id: 1, type: 'tower', alive: true, pos: { x: 100, y: 100 }, currentHP: 100,
                  _skillInstances: [{ skillId: 'weapon_lightning' }], _mapFaction: 'blue',
                  _mapTier: 'outer', _laneId: 1 }];
  let sel = 1;
  const deps = {
    entities: { getAllTowers: (a) => a ? towers : towers, getAllMinions: () => [] },
    attrCalc: { calc: () => ({ maxHP: 100, attackRange: 250 }) },
    effects: { getEffects: () => [] }, getSelectedId: () => sel,
  };
  L.update(deps, 2.0, 0);
  const en = L.map.get(1);
  for (const [name, o] of [['射程圈', en.rangeFill], ['选中光圈', en.selCore]]) {
    T(`${name}参与深度测试（会被抬高的墙挡住）`, o.material.depthTest === true);
    T(`${name}不写深度（贴花之间不互相遮挡）`, o.material.depthWrite === false);
    T(`${name}抬离地面（不与地面平面 z-fighting）`, o.position.y > 0 && o.position.y < 3,
      `y=${o.position.y}`);
  }
  T('血条仍是永远可见的 UI 覆盖层（不参与深度）', en.bar.material.depthTest === false);
  T('单位本体参与深度测试', en.unit.material.depthTest !== false);
  L.dispose();
}

// ============ 4. 贴图资源就位 ============
{
  const fs = await import('fs');
  for (const f of ['ground', 'plateau', 'cliff']) {
    const p = new URL(`./assets/textures/${f}.png`, import.meta.url);
    const sz = fs.statSync(p).size;
    T(`材质贴图 ${f}.png 就位`, sz > 10000, `${(sz / 1024).toFixed(0)}KB`);
  }
}

console.log(`\n第6.3+6.5: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
