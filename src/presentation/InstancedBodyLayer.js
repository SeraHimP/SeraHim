/**
 * InstancedBodyLayer.js —— 单位本体合批（v51.30 小兵，v51.31 加入塔，渲染重构 Week3·Day11-12）
 *
 * docs/Q4-RENDERING-REDESIGN.md §1.2 记的数：44 塔 + 100~200 小兵同屏时，每个单位
 * 各自一次 draw call。小兵是数量大头，且小兵的几何 key（`m|${type}|${faction}`，见
 * UnitLayer._visualOf）本来就已经把颜色/造型正确归到同一份共享几何里——同类型同阵营
 * 的小兵，材质/几何完全一致，是 InstancedMesh 的教科书场景，不需要像最初担心的那样
 * 为自定义兵种皮肤单独做 instanceColor 改造（验证过：自定义兵种的 `e.type` 本身就是
 * 唯一的模板 id，`CONFIG.customMinions[type]` 一个 type 只对应一种颜色，key 里已经
 * 带了 type，颜色天然不会跨兵种混在一个桶里）。
 *
 * ==================== v51.31：塔也合批 ====================
 * 用户明确要求"塔也一起做"。排查过塔的几何 key（`t|${color}|${wid}|${kind}|${tier}|
 * ${faction}|${size}|${dmg}|${flags}`，见 UnitMeshFactory.towerMesh）本来就很碎——
 * 大部分塔已经互不共享几何，真正能合批的量不大，但架构上塔和小兵走的是**同一套**
 * 分桶/槽位机制（vis.key 变了就 bindSlot 到新桶，损毁档跳变/幽灵/废墟这些"换几何"
 * 的场景，恰好都是 vis.key 变化，天然由 bindSlot 处理，不需要额外的迁移代码），
 * 所以直接复用，没有为塔单独写一套。
 *
 * 塔的水晶（发光/自转/攻击充能）**不参与合批**——它需要逐塔独立写
 * `material.emissiveIntensity`（攻击蓄力发光），这本来就不是能共享材质的东西，合批前
 * 就已经是"塔身共享几何、水晶逐塔独立材质"的结构（见 UnitLayer._syncOne 里
 * `vis.crystal` 分支）。合批只是把"塔身"从 Group 的子 Mesh 换成 InstancedMesh 的一个
 * 槽位，水晶从 Group 子物体改成场景里的独立顶层 Mesh（位置/朝向由 UnitLayer 每帧显式
 * 同步，不再靠父子关系自动继承）。塔数量少（≤44），水晶不合批的开销可以忽略。
 *
 * ==================== 设计 ====================
 * 每个几何 key 一个 `BodyBucket`（= 一个 InstancedMesh + 一个空槽位自由表）。
 * 槽位释放走【零缩放矩阵 + 回收进自由表】，不做"和最后一个交换再收缩 count"那种
 * 索引搬迁——那需要额外一层"谁持有这个 index"的反向映射，正确性风险与实现量都更大；
 * 零缩放的槽位在 GPU 侧只是几个退化三角形，成本可以忽略，用简单换安全完全值得。
 * count 只增不减（复用 VegetationLayer"静态野区一次建好"之外的另一种简单模型：
 * 这里是动态的，但"曾经出现过的槽位数"通常就是这一局的稳态峰值，没必要来回缩容）。
 *
 * 阴影是【逐桶】而不是全局一份：塔和小兵的阴影规则本来就不同
 *（`static` 档只有塔投影，小兵不投影，见 UnitLayer._applyUnitShadow 原判据），
 * 桶创建时记下 `isTower`，setShadowLevel 按这个标志逐桶重算 cast/recv。
 *
 * 照抄 VegetationLayer.js 的两条已验证经验：
 *   · `frustumCulled = false`——单位散布满全图，不是聚在几何中心附近，
 *     默认包围球会把大量本该可见的实例错误剔除。
 *   · 材质色是【整批共享的一个乘数】，不是逐实例数据——日夜染色（setUnitTint）走的
 *     UnitMeshFactory.unitMaterial() 共享材质本来就是这个模型，InstancedMesh 不改变它。
 */
import * as THREE from '../../vendor/three.module.js';

const INITIAL_CAPACITY = 24;

const _m4 = new THREE.Matrix4();
const _euler = new THREE.Euler(0, 0, 0, 'XYZ');
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _zeroM4 = new THREE.Matrix4().makeScale(0, 0, 0);

/** 阴影规则与 UnitLayer._applyUnitShadow 原判据同一口径：塔在 static 档才投影，小兵不投影。 */
function shadowFor(level, isTower) {
  return { cast: level === 'all' || (level === 'static' && isTower), recv: level !== 'off' };
}

class BodyBucket {
  constructor(scene, geo, mat, isTower, level) {
    this.scene = scene;
    this.geo = geo; this.mat = mat;
    this.isTower = isTower;
    this.capacity = INITIAL_CAPACITY;
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.frustumCulled = false;
    const { cast, recv } = shadowFor(level, isTower);
    this.mesh.castShadow = cast; this.mesh.receiveShadow = recv;
    this.mesh.count = 0;
    this.free = [];
    this.used = 0;
    scene.add(this.mesh);
  }

  _grow(minCap) {
    let cap = this.capacity;
    while (cap < minCap) cap *= 2;
    if (cap === this.capacity) return;
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    mesh.frustumCulled = false;
    mesh.castShadow = old.castShadow; mesh.receiveShadow = old.receiveShadow;
    for (let i = 0; i < old.count; i++) { old.getMatrixAt(i, _m4); mesh.setMatrixAt(i, _m4); }
    mesh.count = old.count;
    this.scene.remove(old);
    old.dispose();
    this.scene.add(mesh);
    this.mesh = mesh;
    this.capacity = cap;
  }

  alloc() {
    if (this.free.length) return this.free.pop();
    const idx = this.used++;
    if (idx >= this.capacity) this._grow(idx + 1);
    if (idx >= this.mesh.count) this.mesh.count = idx + 1;
    return idx;
  }

  release(idx) {
    this.mesh.setMatrixAt(idx, _zeroM4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(idx);
  }

  setMatrix(idx, x, y, z, rotY, rotZ, sx, sy, sz) {
    _pos.set(x, y, z);
    _euler.set(0, rotY, rotZ, 'XYZ');   // 与 Object3D 默认欧拉序一致，精确复刻原来 en.unit.rotation.{y,z} 叠加的效果
    _quat.setFromEuler(_euler);
    _scl.set(sx, sy, sz);
    _m4.compose(_pos, _quat, _scl);
    this.mesh.setMatrixAt(idx, _m4);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setLevel(level) {
    const { cast, recv } = shadowFor(level, this.isTower);
    this.mesh.castShadow = cast;
    this.mesh.receiveShadow = recv;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    // geometry/material 是 UnitMeshFactory 按 key 全局共享的缓存，这里不释放——
    // 与 UnitLayer.remove() 头注"共享资源随 disposeMeshCache 统一释放"同一个约定。
  }
}

export class BodyInstancer {
  constructor(scene) {
    this.scene = scene;
    this.buckets = new Map();   // geo/mat key -> BodyBucket
    this._level = 'off';        // 与 UnitLayer 构造函数里 shadowLevel 的默认值一致
  }

  _bucket(key, geo, mat, isTower) {
    let b = this.buckets.get(key);
    if (!b) { b = new BodyBucket(this.scene, geo, mat, isTower, this._level); this.buckets.set(key, b); }
    return b;
  }

  /** 分配一个新槽位。调用方负责在拿到新槽位后释放旧槽位（见 InstancedUnitProxy.bindSlot）。 */
  alloc(key, geo, mat, isTower) {
    const b = this._bucket(key, geo, mat, isTower);
    return { bucket: b, index: b.alloc() };
  }

  release(slot) {
    if (slot) slot.bucket.release(slot.index);
  }

  setShadowLevel(level) {
    this._level = level;
    for (const b of this.buckets.values()) b.setLevel(level);
  }

  dispose() {
    for (const b of this.buckets.values()) b.dispose();
    this.buckets.clear();
  }
}

/**
 * `en.unit` 的合批版替身。对外暴露与 THREE.Object3D 相同的三个写入面
 *（position.set / rotation.y·z / scale.set），UnitLayer._syncOne 里那几行
 * `en.unit.position.set(...)` / `en.unit.rotation.z = ...` 完全不用改——
 * 这是刻意的：真正会动的那部分渲染逻辑（走路摆动/攻击脉冲/受击挤压/朝向平滑）
 * 全部原样保留，只在"这个量最终写到哪"这一层换了实现，出问题时排查面不会扩大。
 */
export class InstancedUnitProxy {
  constructor(instancer) {
    this.isInstancedProxy = true;
    this._instancer = instancer;
    this._slot = null;
    this._x = 0; this._y = 0; this._z = 0;
    this._rotY = 0; this._rotZ = 0;
    this._sx = 1; this._sy = 1; this._sz = 1;
    const self = this;
    this.position = { set(x, y, z) { self._x = x; self._y = y; self._z = z; self._flush(); } };
    this.scale = { set(x, y, z) { self._sx = x; self._sy = y; self._sz = z; self._flush(); } };
    this.rotation = {
      get y() { return self._rotY; }, set y(v) { self._rotY = v; self._flush(); },
      get z() { return self._rotZ; }, set z(v) { self._rotZ = v; self._flush(); },
    };
  }

  /** 换几何/材质 key（含首次装配）：分配新槽位，再释放旧槽位——保证任意时刻只占一个槽。 */
  bindSlot(key, geo, mat, isTower) {
    const old = this._slot;
    this._slot = this._instancer.alloc(key, geo, mat, isTower);
    if (old) this._instancer.release(old);
    this._flush();
  }

  releaseSlot() {
    if (this._slot) { this._instancer.release(this._slot); this._slot = null; }
  }

  _flush() {
    if (!this._slot) return;
    this._slot.bucket.setMatrix(this._slot.index, this._x, this._y, this._z, this._rotY, this._rotZ, this._sx, this._sy, this._sz);
  }
}
