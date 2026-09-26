// 第 3.7 步 headless 验证（临时脚手架，不入 tests/）。真 THREE 对象，DOM 最小桩。
// 万能 2D 桩：任何方法调用返回同类桩（gradient.addColorStop 等链式安全），属性可读写
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'width' ? 0 : (k === Symbol.toPrimitive ? undefined : (t[k] ??= mkStub()))),
  set: (t, k, v) => (t[k] = v, true),
  apply: () => mkStub(),
});
const ctxStub = mkStub();
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }) };
globalThis.window = globalThis.window || {};

const THREE = await import('./vendor/three.module.js');
const { UnitLayer } = await import('./src/presentation/UnitLayer.js');

let pass = 0, fail = 0;
const T = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✓' : '✗') + ' ' + name); };

const scene = new THREE.Scene();
const L = new UnitLayer(scene);
const attrCalc = { calc: (e) => ({ maxHP: e.maxHP || 100, attackRange: e._range || 250 }) };
const effects = { getEffects: () => [] };
let towers = [], minions = [];
const entities = {
  getAllTowers: (alive) => alive ? towers.filter(t => t.alive) : towers,
  getAllMinions: () => minions,
};
const deps = { entities, attrCalc, effects };
const inv = () => scene.children.length === 2 * L.map.size + L.infoObjs;

const mkTower = (id, o = {}) => ({ id, type: 'tower', alive: true, pos: { x: id * 10, y: 5 },
  currentHP: 100, maxHP: 100, _skillInstances: [], _mapFaction: 'blue', ...o });

// --- E3 射程圈 + LOD ---
const t1 = mkTower(1, { _skillInstances: [{ skillId: 'weapon_cannon' }], _mapTier: 'outer', _laneId: 1 });
towers = [t1];
L.update(deps, 2.0, 0);                       // rel>=1.35 → 圈显示
let en = L.map.get(1);
T('E3 有武器高缩放：fill+edge 存在', !!en.rangeFill && !!en.rangeEdge && inv());
L.update(deps, 1.0, 0);                       // LOD 档1 → 圈隐藏
T('E3 LOD 档1 抑制：圈被摘除', !en.rangeFill && !en.rangeEdge && inv());
L.update(deps, 2.0, 0);
T('E3 恢复缩放圈回来', !!L.map.get(1).rangeFill && inv());

// --- E3 半径量化：±3px 内不重建，越档才换几何 ---
en = L.map.get(1);
const meshBefore = en.rangeFill;
t1._range = 253;  L.update(deps, 2.0, 0);     // 250→252 档 = 253→252 档，同 key
T('E3 量化：253 与 250 同档不重建', L.map.get(1).rangeFill === meshBefore);
t1._range = 258;  L.update(deps, 2.0, 0);     // → 260 档
T('E3 量化：258 越档重建且不变量保持', L.map.get(1).rangeFill !== meshBefore && inv());
const geoCount = L._geoCache.size;
t1._range = 250;  L.update(deps, 2.0, 0);
T('E3 几何缓存复用：回到旧档缓存零增长', L._geoCache.size === geoCount);

// --- E3 条件：枢纽塔 / 无武器不画 ---
const t2 = mkTower(2, { _skillInstances: [{ skillId: 'weapon_laser' }], _mapTier: 'nexus_main' });
const t3 = mkTower(3, { _mapTier: 'outer', _laneId: 2 });   // 无武器
towers = [t1, t2, t3];
L.update(deps, 2.0, 0);
T('E3 枢纽塔不画圈', !L.map.get(2).rangeFill);
T('E3 无武器不画圈', !L.map.get(3).rangeFill && inv());

// --- E5 归属环：有阵营无层级才画 ---
const t4 = mkTower(4, {});                    // _mapFaction=blue, 无 _mapTier → 画
towers = [t1, t2, t3, t4];
L.update(deps, 2.0, 0);
T('E5 手建对战塔画归属环', !!L.map.get(4).own && inv());
T('E5 地图层级塔不画归属环', !L.map.get(1).own);
t4._mapFaction = null; L.update(deps, 2.0, 0);
T('E5 失去阵营环被摘除', !L.map.get(4).own && inv());
t4._mapFaction = 'blue';

// --- E4 龙魂金环开关 ---
t1._skillInstances.push({ skillId: 'dragonsoul_infernal' });
L.update(deps, 2.0, 0);
T('E4 有龙魂画金环', !!L.map.get(1).soul && inv());
t1._skillInstances = t1._skillInstances.filter(s => !s.skillId.startsWith('dragonsoul_'));
L.update(deps, 2.0, 0);
T('E4 龙魂移除金环摘除', !L.map.get(1).soul && inv());

// --- E2 结构保护盾牌：inner 受 outer 同路存活保护 ---
const inner = mkTower(5, { _mapTier: 'inner', _laneId: 1 });
towers = [t1, t2, t3, t4, inner];             // t1 = outer lane1 存活 → inner 受保护
L.update(deps, 2.0, 0);
T('E2 受保护塔有盾牌 sprite', !!L.map.get(5).shield && inv());
t1.alive = false;                             // 前置塔阵亡 → 保护消失
L.update(deps, 2.0, 0);
T('E2 保护解除盾牌摘除（含前置塔 entry 被兜底清理）', !L.map.get(5).shield && !L.map.get(1) && inv());
t1.alive = true;

// --- E1 镀层节点线：脏 key + 纹理版本 ---
const tp = mkTower(6, { _skillInstances: [{ skillId: 'passive_armor_plating', state: { broken: [false, false, false, false] } }], _mapTier: 'outer', _laneId: 3 });
towers = [t1, t2, t3, t4, inner, tp];
L.update(deps, 2.0, 0);
en = L.map.get(6);
T('E1 节点值进脏 key（p0.8）', en.barKey.endsWith('|p0.8'));
const v0 = en.barTex.version;
for (let i = 0; i < 100; i++) L.update(deps, 2.0, i * 0.033);
T('E1 无变化 100 帧零重绘', en.barTex.version === v0);
tp._skillInstances[0].state.broken = [true, false, false, false];
L.update(deps, 2.0, 0);
T('E1 破第一节点：恰好一次重绘且 key 变 p0.6', en.barTex.version === v0 + 1 && en.barKey.endsWith('|p0.6'));
tp._skillInstances[0].state.broken = [true, true, true, true];
L.update(deps, 2.0, 0);
T('E1 全破：key 收敛 pnull 不再标记', en.barKey.endsWith('|pnull'));

// --- 塔转幽灵：E 组必须清干净 ---
const cry = mkTower(7, { _mapTier: 'nexus_lane', _laneId: 1, _skillInstances: [{ skillId: 'weapon_beam' }] });
towers = [...towers, cry];
L.update(deps, 2.0, 0);
cry.alive = false; cry._respawnAt = 999; cry._respawnProgress = 0.3;
L.update(deps, 2.0, 0);
en = L.map.get(7);
T('幽灵水晶仍被追踪且 E 组全空', !!en && !en.rangeFill && !en.own && !en.soul && !en.shield && inv());

// --- 3000 帧随机生灭长跑：不变量逐帧 + 缓存有界 ---
let ok = true; let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let f = 0; f < 3000; f++) {
  for (const t of towers) { if (rnd() < 0.02) t.alive = !t.alive; if (rnd() < 0.02) t._range = 220 + Math.floor(rnd() * 20) * 4; }
  L.update(deps, rnd() < 0.3 ? 1.0 : 2.0, f * 0.033);
  if (!inv()) { ok = false; break; }
}
T('3000 帧长跑：children == 2×tracked + infoObjs 逐帧成立', ok);
T('几何缓存有界（<40 项）', L._geoCache.size < 40);
T('材质缓存有界（<20 项）', L._matCache.size < 20);

// --- 清场 ---
L.dispose();
T('dispose 后场景归零', scene.children.length === 0 && L.infoObjs === 0);

console.log(`\n3.7 headless: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
