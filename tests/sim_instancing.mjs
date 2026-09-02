// v51.30：小兵本体合批（InstancedMesh）——docs/Q4-RENDERING-REDESIGN.md §1.2 记的数：
// 44 塔 + 100~200 小兵同屏时每个单位各自一次 draw call。小兵数量是大头，且几何 key
// （`m|${type}|${faction}`）本来就已经把同类型同阵营小兵的颜色/造型正确归到同一份
// 共享几何——不需要为自定义兵种皮肤做 instanceColor 改造（验证过：自定义兵种的
// `e.type` 本身就是唯一模板 id，颜色天然不会跨兵种混进同一个几何 key）。
// 塔的 key 空间已经很碎（tier×faction×损毁档×废墟，见 UnitMeshFactory.towerMesh），
// 真正能合批的量很少，且要拆水晶发光风险不小，所以塔/龙不参与合批
//（UnitLayer._isInstancedType 判据）。
//
// 这里分两块测：
//   ① InstancedMinionLayer.js 本身：不依赖 document，可以在 headless Node 里真实
//      实例化几何/材质/InstancedMesh 做行为验证（不是只读源码正则）。
//   ② UnitLayer.js 的接线：这个文件 import 了 three 且 `_makeEntry` 会
//      `document.createElement('canvas')`，headless 下不能真实 new UnitLayer(scene)
//      ——这是本仓库既有的测试边界（sim_lightring.mjs 头注写明了同样的限制，
//      UnitLayer 相关测试一律走"从 prototype 借方法"或源码形态断言，这里延续同一约定）。
import { srcOf, scoreboard } from './_harness.mjs';
import * as THREE from '../vendor/three.module.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

const { MinionInstancer, InstancedUnitProxy } = await import('../src/presentation/InstancedMinionLayer.js');
const { UnitLayer } = await import('../src/presentation/UnitLayer.js');

const { T, done } = scoreboard('小兵合批（InstancedMesh）');

// ==================== 一、MinionInstancer / InstancedUnitProxy：真实构建 ====================
{
  const scene = new THREE.Scene();
  const inst = new MinionInstancer(scene);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();

  const proxies = [];
  for (let i = 0; i < 8; i++) {
    const p = new InstancedUnitProxy(inst);
    p.bindSlot('m|melee|blue', geo, mat);
    p.position.set(i * 10, 1, i * -3);
    p.scale.set(1, 1, 1);
    proxies.push(p);
  }
  T('同 key 的多个单位只产生 1 个 scene child（合批生效，不是各自一个 Mesh）', scene.children.length === 1);
  T('InstancedUnitProxy 标记 isInstancedProxy=true（UnitLayer 靠这个判断走哪条分支）', proxies[0].isInstancedProxy === true);

  const bucket = inst.buckets.get('m|melee|blue');
  T('桶的 InstancedMesh.count 跟着已分配槽位数走', bucket.mesh.count === 8);
  T('frustumCulled 关闭（单位散布满全图，不是聚在几何中心——照抄 VegetationLayer 的教训）',
    bucket.mesh.frustumCulled === false);

  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  bucket.mesh.getMatrixAt(3, m4);
  m4.decompose(pos, q, s);
  T('写入的矩阵能正确解出位置', Math.abs(pos.x - 30) < 1e-6 && Math.abs(pos.y - 1) < 1e-6 && Math.abs(pos.z - (-9)) < 1e-6);
  T('写入的矩阵能正确解出缩放', Math.abs(s.x - 1) < 1e-6 && Math.abs(s.y - 1) < 1e-6);

  // 旋转：rotation.y + rotation.z 要按 Object3D 默认欧拉序('XYZ')叠加，而不是互相覆盖
  const p9 = new InstancedUnitProxy(inst);
  p9.bindSlot('m|melee|blue', geo, mat);
  p9.position.set(0, 0, 0);
  p9.rotation.y = 0.6;
  p9.rotation.z = 0.2;
  p9.scale.set(2, 2, 2);
  bucket.mesh.getMatrixAt(p9._slot.index, m4);
  const expected = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0.2, 'XYZ')),
    new THREE.Vector3(2, 2, 2));
  let matDiff = 0;
  for (let i = 0; i < 16; i++) matDiff = Math.max(matDiff, Math.abs(m4.elements[i] - expected.elements[i]));
  T('rotation.y + rotation.z 按 Object3D 默认欧拉序合成（不是互相覆盖）', matDiff < 1e-6);

  // 释放 + 复用
  const freedIndex = proxies[2]._slot.index;
  proxies[2].releaseSlot();
  T('释放后的槽位被置成零缩放矩阵（GPU 侧不再可见，但仍在 count 范围内、不做索引搬迁）', (() => {
    bucket.mesh.getMatrixAt(freedIndex, m4);
    m4.decompose(pos, q, s);
    return s.x === 0 && s.y === 0 && s.z === 0;
  })());
  const p10 = new InstancedUnitProxy(inst);
  p10.bindSlot('m|melee|blue', geo, mat);
  T('新单位复用刚释放的槽位（自由表生效，不会无限增长 capacity）', p10._slot.index === freedIndex);

  // 不同 key → 不同桶
  const p11 = new InstancedUnitProxy(inst);
  p11.bindSlot('m|ranged|red', geo, mat);
  T('不同几何 key 落在不同的桶（不会把不同类型/阵营的小兵混进同一个 InstancedMesh）',
    inst.buckets.get('m|ranged|red') !== bucket);
  T('不同桶各自新增一个 scene child', scene.children.length === 2);

  // 换 key（模拟阵营变化等场景）：旧槽位应该被释放
  const oldBucketUsed = bucket.used;
  p11.bindSlot('m|melee|blue', geo, mat);   // 从 ranged|red 换到 melee|blue
  T('换桶后旧桶的槽位数不变（released 进自由表，没有额外分配）',
    inst.buckets.get('m|ranged|red').free.length === 1);

  // 容量增长：超过初始容量应该自动扩容且矩阵数据不丢
  const growBucketKey = 'm|super|neutral';
  const growProxies = [];
  for (let i = 0; i < 40; i++) {   // 超过 INITIAL_CAPACITY(24)
    const p = new InstancedUnitProxy(inst);
    p.bindSlot(growBucketKey, geo, mat);
    p.position.set(i, 0, 0);
    growProxies.push(p);
  }
  const growBucket = inst.buckets.get(growBucketKey);
  T('超过初始容量后自动扩容', growBucket.capacity >= 40);
  growBucket.mesh.getMatrixAt(growProxies[10]._slot.index, m4);
  m4.decompose(pos, q, s);
  T('扩容后早期写入的矩阵数据保留（没有在换 InstancedMesh 时丢失）', Math.abs(pos.x - 10) < 1e-6);

  // 阴影档位：整批一份，不是逐实例
  inst.setShadowLevel(true, true);
  T('setShadowLevel 对已存在的桶立即生效', bucket.mesh.castShadow === true && bucket.mesh.receiveShadow === true);
  const p12 = new InstancedUnitProxy(inst);
  p12.bindSlot('m|totem|blue', geo, mat);   // 新建的桶
  T('setShadowLevel 之后新建的桶也带着当前档位（不是只对已存在的桶生效）',
    inst.buckets.get('m|totem|blue').mesh.castShadow === true);

  inst.dispose();
  T('dispose 后所有桶的 Mesh 都从 scene 里摘除', scene.children.length === 0);
}

// ==================== 二、UnitLayer.js 接线：源码形态 + 可安全借用的纯函数 ====================
{
  const src = srcOf('src/presentation/UnitLayer.js');
  T('导入了 MinionInstancer/InstancedUnitProxy', /import \{ MinionInstancer, InstancedUnitProxy \} from '\.\/InstancedMinionLayer\.js'/.test(src));
  T('构造函数里建了 this.minionInst', /this\.minionInst = new MinionInstancer\(this\.scene\)/.test(src));
  T('_isInstancedType 排除塔和龙（数量少/几何 key 已经很碎，不值得合批）',
    /_isInstancedType\(e\) \{ return e\.type !== 'tower' && e\.type !== 'dragon'; \}/.test(src));
  T('vis-key 变化时，合批类型走 InstancedUnitProxy 分支', /else if \(this\._isInstancedType\(e\)\)/.test(src));
  T('合批分支调用 bindSlot(vis.key, vis.geo, vis.mat)', /en\.unit\.bindSlot\(vis\.key, vis\.geo, vis\.mat\)/.test(src));
  T('_applyUnitShadow 对合批单位提前返回（阴影整批设置，不逐实例 traverse）',
    /_applyUnitShadow\(en\) \{\s*if \(en\.unit\.isInstancedProxy\) return;/.test(src));
  T('setShadowLevel 里同步调用 minionInst.setShadowLevel', /this\.minionInst\.setShadowLevel\(level === 'all', level !== 'off'\)/.test(src));
  T('remove(id) 里合批单位走 releaseSlot 而不是 scene.remove', /if \(en\.unit\.isInstancedProxy\) en\.unit\.releaseSlot\(\);/.test(src));
  T('dispose() 里释放 minionInst', /this\.minionInst\.dispose\(\)/.test(src));
  T('没有外部文件依赖 en.unit 是真实 Object3D（否则合批换成代理对象会在别处炸）',
    !/\.unit\.(position|rotation|scale|matrixWorld|getWorldPosition)/.test(srcOf('src/presentation/ThreeRenderer.js'))
    && !/\.unit\.(position|rotation|scale|matrixWorld|getWorldPosition)/.test(srcOf('src/ui/CanvasController.js')));

  // _isInstancedType 是纯函数（不摸 this 上任何东西以外的字段），可以直接借出来单测
  const fn = UnitLayer.prototype._isInstancedType;
  T('_isInstancedType(melee) → true（走合批）', fn.call({}, { type: 'melee' }) === true);
  T('_isInstancedType(自定义兵种) → true（合批不区分内置/自定义，key 天然按 type 分桶）', fn.call({}, { type: 'my_custom_wolf' }) === true);
  T('_isInstancedType(tower) → false（塔不合批）', fn.call({}, { type: 'tower' }) === false);
  T('_isInstancedType(dragon) → false（龙不合批）', fn.call({}, { type: 'dragon' }) === false);
}

done();
