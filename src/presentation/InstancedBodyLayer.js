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
import { applySnowTint } from './VegetationShaderPatch.js';
import { CONFIG } from '../data/Config.js';
import { sampleSnowTarget } from '../systems/GroundTraceSystem.js';

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
    this.isTower = isTower;
    this.capacity = INITIAL_CAPACITY;
    // ==================== v55.3：塔"被雪覆盖"效果 ====================
    // 用户要求"塔也有被雪覆盖的效果"，跟野区植被同一套 applySnowTint/
    // updateSnowInstances（VegetationShaderPatch.js，本来就是通用工具，不是
    // 植被专属）。但这里的 geo/mat 是 UnitMeshFactory 按 key 全局共享的缓存
    // （见文件头注），直接在共享对象上加 instanceSnow 属性/onBeforeCompile 会
        // 波及同一份缓存的其它消费者（比如编辑器里的幽灵预览塔可能复用同一把
    // 几何/材质，但没有走 InstancedMesh、没有这个属性，会导致 shader 编译要求
    // 的 attribute 缺失）。只对塔桶克隆一份专属 geo/mat 再挂雪效——塔数量少
    // （≤44，且文件头注已经说"塔的几何 key 本来就很碎，大部分互不共享"），
    // 克隆的额外开销可以忽略；小兵桶继续用共享对象，不受影响，逐位不变。
    this.geo = isTower ? geo.clone() : geo;
    this.mat = isTower ? mat.clone() : mat;
    if (isTower) {
      this.geo.setAttribute('instanceSnow', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1));
      applySnowTint(this.geo, this.mat);
      this._snowPosArr = new Float32Array(this.capacity * 3); // 每槽位缓存一份世界坐标，updateSnow 时不用每次都解矩阵算三角函数
    }
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.capacity);
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
    if (this.isTower) {
      const newSnowAttr = new Float32Array(cap);
      const oldSnowAttr = this.geo.getAttribute('instanceSnow')?.array;
      if (oldSnowAttr) newSnowAttr.set(oldSnowAttr);
      this.geo.setAttribute('instanceSnow', new THREE.InstancedBufferAttribute(newSnowAttr, 1));
      const newPos = new Float32Array(cap * 3);
      newPos.set(this._snowPosArr);
      this._snowPosArr = newPos;
    }
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

  /**
   * 每帧调用（isTower 桶才有意义，setMatrix 里顺带记一份世界坐标，供节流刷新雪深时
   * 直接查表，不用每次都从矩阵里解出平移分量）。
   */
  _recordSnowPos(idx, x, y, z) {
    if (!this._snowPosArr) return;
    this._snowPosArr[idx * 3] = x;
    this._snowPosArr[idx * 3 + 1] = y;
    this._snowPosArr[idx * 3 + 2] = z;
  }

  /** 节流刷新这一桶里所有塔实例的落雪程度（塔不动，坐标从 _snowPosArr 直接查表）。 */
  updateSnow(sampleFn, maxBlend) {
    if (!this.isTower) return;
    const attr = this.geo.getAttribute('instanceSnow');
    if (!attr) return;
    const arr = attr.array;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.free.includes(i)) continue; // 已释放的空槽位不用算，反正缩放为0不可见
      const x = this._snowPosArr[i * 3], z = this._snowPosArr[i * 3 + 2];
      const depth = Math.max(0, Math.min(1, sampleFn(x, z)));
      arr[i] = depth * maxBlend;
    }
    attr.needsUpdate = true;
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
    this._recordSnowPos(idx, x, y, z);
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
    // 塔桶例外：this.geo/this.mat 在构造时已经各自 clone 过一份专属的（见构造函数
    // 的 v55.3 注释），不是共享缓存，这里必须自己释放，否则每次重建地图都会泄漏。
    if (this.isTower) { this.geo.dispose(); this.mat.dispose(); }
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

  /**
   * 塔的积雪效果，节流刷新，口径与 VegetationLayer.updateSnow 完全一致（见
   * Config.js ui.towerSnowFx 头注：塔数量少不是不节流的理由，两处保持同一套习惯）。
   * groundTraceSystem 为空（还没进对局/天气系统未接线）时直接跳过，不报错。
   */
  updateSnow(dt, groundTraceSystem) {
    // v55.9 修复："塔更换损毁模型时会先变成原模型闪一下才变雪模型"的根因——
    // 这里缓存一份最新引用，供 seedTowerSnow() 在损毁档切换（bindSlot 换新
    // 槽位）的那一瞬间立即取用，不用等下面这个节流周期真正跑到。
    this._groundTraceSystem = groundTraceSystem;
    const cfg = (CONFIG.ui && CONFIG.ui.towerSnowFx) || {};
    const interval = cfg.updateIntervalSec ?? 0.75;
    this._snowT = (this._snowT || 0) + dt;
    if (this._snowT < interval) return;
    this._snowT = 0;
    // v55.8 修复：塔改读 getSnowTarget()（不含侵蚀的目标雪深），不再用
    // getSnowCover() 那份会被小兵踩踏侵蚀的实际地面雪深——否则小兵一从塔附近
    // 走过，塔坐标点的雪深就被一起压低，塔的落雪程度跟着诡异地闪烁（见
    // GroundTraceSystem.js sampleSnowTarget 头注的完整根因记录）。
    if (!groundTraceSystem || !groundTraceSystem.getSnowTarget) return;
    const snow = groundTraceSystem.getSnowTarget();
    if (!snow) return;
    const maxBlend = cfg.maxBlend ?? 0.55;
    const sampleFn = (x, z) => sampleSnowTarget(snow, x, z);
    for (const b of this.buckets.values()) {
      if (b.isTower) b.updateSnow(sampleFn, maxBlend);
    }
  }

  /**
   * v55.9 修复：塔损毁档位切换（vis.key 变化）会经 InstancedUnitProxy.bindSlot
   * 分配一个全新槽位——新槽位的 instanceSnow 是 Float32Array 默认值 0（见
   * BodyBucket 构造函数/_grow），要等下一次上面 updateSnow() 的节流周期
   * （默认0.75秒）才会被刷新成正确值。这段时间里塔先以"完全无雪"的样子画
   * 出来，再在节流周期到时"啪"地一下跳变成有雪——用户报"先变成原模型后闪
   * 一下才变为雪的模型"，正是这个空档期。
   * 修法：在 bindSlot 换槽的那一刻立即用【当前】groundTraceSystem 算一次
   * 这一个槽位该有的雪量并写入，不等节流周期——只在换槽这个低频事件发生时
   * 多做一次单点采样，成本可以忽略，跟节流刷新（照顾"雪随时间累积/消退"
   * 这个持续过程）不冲突，两者管的是不同的时机。
   */
  seedTowerSnow(slot, x, z) {
    if (!slot || !slot.bucket.isTower) return;
    const gts = this._groundTraceSystem;
    if (!gts || !gts.getSnowTarget) return;
    const snow = gts.getSnowTarget();
    if (!snow) return;
    const attr = slot.bucket.geo.getAttribute('instanceSnow');
    if (!attr) return;
    const cfg = (CONFIG.ui && CONFIG.ui.towerSnowFx) || {};
    const maxBlend = cfg.maxBlend ?? 0.55;
    const depth = Math.max(0, Math.min(1, sampleSnowTarget(snow, x, z)));
    attr.array[slot.index] = depth * maxBlend;
    attr.needsUpdate = true;
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
    // v55.9 修复：塔损毁档切换换槽的瞬间立即补一次雪深采样，不等节流周期，
    // 见 BodyInstancer.seedTowerSnow 头注（"先变原模型再闪一下变雪模型"的根因）。
    // 用换槽前就已知道的位置（_x/_z 在损毁档切换时基本不变，_flush 会随即
    // 再同步一次），不需要等外部再传一次坐标进来。
    if (isTower) this._instancer.seedTowerSnow(this._slot, this._x, this._z);
  }

  releaseSlot() {
    if (this._slot) { this._instancer.release(this._slot); this._slot = null; }
  }

  _flush() {
    if (!this._slot) return;
    this._slot.bucket.setMatrix(this._slot.index, this._x, this._y, this._z, this._rotY, this._rotZ, this._sx, this._sy, this._sz);
  }
}
