// v51.30/v51.31：单位本体合批（InstancedMesh，小兵 + 塔）——
// docs/Q4-RENDERING-REDESIGN.md §1.2 记的数：44 塔 + 100~200 小兵同屏时每个单位各自
// 一次 draw call。小兵数量是大头，几何 key（`m|${type}|${faction}`）本来就已经把
// 同类型同阵营小兵的颜色/造型正确归到同一份共享几何——不需要为自定义兵种皮肤做
// instanceColor 改造（验证过：自定义兵种的 `e.type` 本身就是唯一模板 id，颜色天然
// 不会跨兵种混进同一个几何 key）。
//
// v51.31：塔也接进同一套机制。塔的几何 key（tier×faction×损毁档×废墟）本来就已经
// 很碎，真正能合批的量不大，但架构上塔和小兵走的是同一套"vis.key 变了就 bindSlot
// 换桶"，损毁档跳变/幽灵/废墟这些"换几何"场景天然由这套机制处理，不需要额外代码；
// 塔的水晶（自转/发光/攻击充能，逐塔独立数据）不参与合批，改成场景里的独立顶层
// Mesh，位置/朝向由 UnitLayer 每帧显式同步（不再靠"是 Group 子物体"自动继承）。
// 龙不合批（数量少、颜色任意导致 key 天然碎，合批收益趋近于零）。
//
// 这里分两块测：
//   ① InstancedBodyLayer.js 本身：不依赖 document，可以在 headless Node 里真实
//      实例化几何/材质/InstancedMesh 做行为验证（不是只读源码正则），含塔小兵
//      各自的阴影规则要按桶区分这件事。
//   ② UnitLayer.js 的接线：这个文件 import 了 three 且 `_makeEntry` 会
//      `document.createElement('canvas')`，headless 下不能真实 new UnitLayer(scene)
//      ——这是本仓库既有的测试边界（sim_lightring.mjs 头注写明了同样的限制，
//      UnitLayer 相关测试一律走"从 prototype 借方法"或源码形态断言，这里延续同一约定）。
import { srcOf, scoreboard } from './_harness.mjs';
import * as THREE from '../vendor/three.module.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

const { BodyInstancer, InstancedUnitProxy } = await import('../src/presentation/InstancedBodyLayer.js');
const { UnitLayer } = await import('../src/presentation/UnitLayer.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('单位本体合批（InstancedMesh，小兵+塔）');

// ==================== 一、BodyInstancer / InstancedUnitProxy：真实构建 ====================
{
  const scene = new THREE.Scene();
  const inst = new BodyInstancer(scene);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();

  const proxies = [];
  for (let i = 0; i < 8; i++) {
    const p = new InstancedUnitProxy(inst);
    p.bindSlot('m|melee|blue', geo, mat, false);
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
  p9.bindSlot('m|melee|blue', geo, mat, false);
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
  p10.bindSlot('m|melee|blue', geo, mat, false);
  T('新单位复用刚释放的槽位（自由表生效，不会无限增长 capacity）', p10._slot.index === freedIndex);

  // 不同 key → 不同桶
  const p11 = new InstancedUnitProxy(inst);
  p11.bindSlot('m|ranged|red', geo, mat, false);
  T('不同几何 key 落在不同的桶（不会把不同类型/阵营的小兵混进同一个 InstancedMesh）',
    inst.buckets.get('m|ranged|red') !== bucket);
  T('不同桶各自新增一个 scene child', scene.children.length === 2);

  // 换 key（模拟阵营变化等场景）：旧槽位应该被释放
  p11.bindSlot('m|melee|blue', geo, mat, false);   // 从 ranged|red 换到 melee|blue
  T('换桶后旧桶的槽位数不变（released 进自由表，没有额外分配）',
    inst.buckets.get('m|ranged|red').free.length === 1);

  // 容量增长：超过初始容量应该自动扩容且矩阵数据不丢
  const growBucketKey = 'm|super|neutral';
  const growProxies = [];
  for (let i = 0; i < 40; i++) {   // 超过 INITIAL_CAPACITY(24)
    const p = new InstancedUnitProxy(inst);
    p.bindSlot(growBucketKey, geo, mat, false);
    p.position.set(i, 0, 0);
    growProxies.push(p);
  }
  const growBucket = inst.buckets.get(growBucketKey);
  T('超过初始容量后自动扩容', growBucket.capacity >= 40);
  growBucket.mesh.getMatrixAt(growProxies[10]._slot.index, m4);
  m4.decompose(pos, q, s);
  T('扩容后早期写入的矩阵数据保留（没有在换 InstancedMesh 时丢失）', Math.abs(pos.x - 10) < 1e-6);

  // ==================== 阴影：塔与小兵走不同规则，逐桶而不是全局一份 ====================
  const towerProxy = new InstancedUnitProxy(inst);
  towerProxy.bindSlot('t|blue|outer', geo, mat, true);   // isTower=true
  const towerBucket = inst.buckets.get('t|blue|outer');

  inst.setShadowLevel('static');
  T('static 档：塔桶投影（cast=true）', towerBucket.mesh.castShadow === true);
  T('static 档：小兵桶不投影（cast=false，和塔不是同一条规则）', bucket.mesh.castShadow === false);
  T('static 档：两者都接收阴影（recv 与 isTower 无关）', towerBucket.mesh.receiveShadow === true && bucket.mesh.receiveShadow === true);

  inst.setShadowLevel('all');
  T('all 档：小兵桶也投影了', bucket.mesh.castShadow === true);

  inst.setShadowLevel('off');
  T('off 档：两者都不投影也不接收', towerBucket.mesh.castShadow === false && bucket.mesh.receiveShadow === false);

  const p12 = new InstancedUnitProxy(inst);
  p12.bindSlot('m|totem|blue', geo, mat, false);   // 新建的桶：off 档下不应该被开
  T('setShadowLevel 之后新建的桶也带着当前档位（不是只对已存在的桶生效）',
    inst.buckets.get('m|totem|blue').mesh.castShadow === false);

  inst.dispose();
  T('dispose 后所有桶的 Mesh 都从 scene 里摘除', scene.children.length === 0);
}

// ==================== 一b、塔的落雪：改用 getSnowTarget（v55.8 修复） ====================
// 用户报"下雪天塔的颜色会跟随旁边小兵走过后出现变化"——排查确认塔原来跟地面/植被
// 一样查会被踩踏侵蚀的实际雪深（sampleSnowGrid/getSnowCover），小兵一走近塔就把
// 塔坐标点的雪深带低了。修法是塔改查 sampleSnowTarget/getSnowTarget（不含侵蚀的
// 目标雪深，见 GroundTraceSystem.js 头注）。这里只提供 getSnowTarget，故意不提供
// getSnowCover——如果以后有人不小心把塔的调用改回旧接口，这条测试会直接抛异常
// 或读到 undefined 而失败，而不是安静地退回错误行为。
{
  const scene = new THREE.Scene();
  const inst = new BodyInstancer(scene);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const towerProxy = new InstancedUnitProxy(inst);
  towerProxy.bindSlot('t|blue|outer', geo, mat, true);
  towerProxy.position.set(100, 0, 100);

  const fakeGroundTraceSystem = {
    getSnowTarget: () => ({
      resolution: 4, worldW: 400, worldH: 400,
      globalTarget: 0.8, zoneMix: null, jungleMaxMul: 1,
    }),
  };
  inst.updateSnow(10, fakeGroundTraceSystem); // dt 远超节流间隔，保证这一帧真的刷新
  const bucket = inst.buckets.get('t|blue|outer');
  const attr = bucket.geo.getAttribute('instanceSnow');
  const maxBlend = CONFIG.ui?.towerSnowFx?.maxBlend ?? 0.55;
  T('塔落雪①-塔的 instanceSnow 按 getSnowTarget 的全局目标值刷新（约等于 globalTarget×maxBlend）',
    Math.abs(attr.array[0] - 0.8 * maxBlend) < 0.02);
  T('塔落雪②-只提供 getSnowTarget、不提供 getSnowCover 也能正常工作（没有偷偷调用旧接口）',
    attr.array[0] > 0);
  inst.dispose();
}

// ==================== 一c、塔损毁档切换换槽时立即补雪，不等节流周期（v55.9 修复） ====================
// 用户报"塔更换损毁模型的时候，如果被雪覆盖了这时候会先变成原模型后闪一下才变为
// 雪的模型"——根因：损毁档切换会让 vis.key 变化，InstancedUnitProxy.bindSlot 因此
// 分配一个全新槽位，新槽位的 instanceSnow 初始是 Float32Array 默认值 0（见
// BodyBucket 构造函数），要等下一次 updateSnow() 节流周期（默认0.75秒）才会被
// 刷新成正确值——这段空档期塔先以"无雪"外观画出来，之后再跳变成有雪。
// 修法：bindSlot 换槽的那一刻立即调用 seedTowerSnow 补一次单点采样。这里验证：
// 一次完整的节流刷新之后（塔已经有正确的雪量），紧接着换到一个全新的损毁档
// key（模拟tier切换），换槽瞬间不应该读到0——不用等下一次 updateSnow 节流周期。
{
  const scene = new THREE.Scene();
  const inst = new BodyInstancer(scene);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const towerProxy = new InstancedUnitProxy(inst);
  towerProxy.bindSlot('t|blue|outer|tier0', geo, mat, true);
  towerProxy.position.set(200, 0, 200);

  const fakeGroundTraceSystem = {
    getSnowTarget: () => ({
      resolution: 4, worldW: 400, worldH: 400,
      globalTarget: 0.9, zoneMix: null, jungleMaxMul: 1,
    }),
  };
  inst.updateSnow(10, fakeGroundTraceSystem); // 先跑一次完整节流周期，塔已经有正确雪量

  // 模拟损毁档切换：换到一个全新几何/材质 key（新槽位，新桶）。
  const damagedGeo = new THREE.BoxGeometry(1, 1, 1);
  const damagedMat = new THREE.MeshBasicMaterial();
  towerProxy.bindSlot('t|blue|outer|tier1_damaged', damagedGeo, damagedMat, true);

  const newBucket = inst.buckets.get('t|blue|outer|tier1_damaged');
  const newAttr = newBucket.geo.getAttribute('instanceSnow');
  const maxBlend = CONFIG.ui?.towerSnowFx?.maxBlend ?? 0.55;
  T('塔落雪③-损毁档切换到新槽位的瞬间，instanceSnow 已经被立即补上正确值（不是刚分配时的默认0）',
    Math.abs(newAttr.array[0] - 0.9 * maxBlend) < 0.02);
  inst.dispose();
}

// ==================== 二、UnitLayer.js 接线：源码形态 + 可安全借用的纯函数 ====================
{
  const src = srcOf('src/presentation/UnitLayer.js');
  T('导入了 BodyInstancer/InstancedUnitProxy（从改名后的 InstancedBodyLayer.js）',
    /import \{ BodyInstancer, InstancedUnitProxy \} from '\.\/InstancedBodyLayer\.js'/.test(src));
  T('构造函数里建了 this.bodyInst', /this\.bodyInst = new BodyInstancer\(this\.scene\)/.test(src));
  T('_isInstancedType 只排除龙（塔已经并入合批，v51.31）',
    /_isInstancedType\(e\) \{ return e\.type !== 'dragon'; \}/.test(src));
  T('vis-key 变化时，合批类型走 InstancedUnitProxy 分支', /if \(this\._isInstancedType\(e\)\)/.test(src));
  T('合批分支调用 bindSlot(vis.key, vis.geo, vis.mat, en.isTower)——第4参数区分塔/小兵阴影规则',
    /en\.unit\.bindSlot\(vis\.key, vis\.geo, vis\.mat, en\.isTower\)/.test(src));
  T('水晶分支与本体合批分支解耦（独立的 if (vis.crystal) 块，不再嵌在本体 if/else 里）',
    /if \(vis\.crystal\) \{[\s\S]{0,400}this\.scene\.add\(cm\); this\.infoObjs\+\+;/.test(src));
  T('水晶创建时记录 crystalLocalY（每帧同步位置要用，水晶不再是子物体自动继承）',
    /en\.crystalLocalY = vis\.crystal\.cy/.test(src));
  T('_disposeCrystal 显式把水晶从 scene 里摘除（不再靠父物体 Group 被移除带走）',
    /_disposeCrystal\(en\) \{\s*if \(!en\.crystal\) return;\s*this\.scene\.remove\(en\.crystal\); this\.infoObjs--;/.test(src));
  T('_applyUnitShadow 单独给水晶下发阴影（水晶不归 en.unit 管了）',
    /_applyUnitShadow\(en\) \{[\s\S]{0,200}if \(en\.crystal\) \{[\s\S]{0,200}en\.crystal\.castShadow/.test(src));
  T('_applyUnitShadow 对合批本体提前返回（阴影按桶设置，不逐实例 traverse）',
    /if \(en\.unit\.isInstancedProxy\) return;/.test(src));
  T('setShadowLevel 里同步调用 bodyInst.setShadowLevel(level)（传原始档位字符串，不是预算好的布尔值——逐桶区分塔/小兵要靠桶自己判断 isTower）',
    /this\.bodyInst\.setShadowLevel\(level\)/.test(src));
  T('remove(id) 里合批单位走 releaseSlot 而不是 scene.remove', /if \(en\.unit\.isInstancedProxy\) en\.unit\.releaseSlot\(\);/.test(src));
  T('dispose() 里释放 bodyInst', /this\.bodyInst\.dispose\(\)/.test(src));
  T('水晶每帧同步位置（gy+walkBob+crystalLocalY），不再靠父子关系自动继承',
    /en\.crystal\.position\.set\(e\.pos\.x, gy \+ walkBob \+ \(en\.crystalLocalY \|\| 0\), e\.pos\.y\)/.test(src));
  T('没有外部文件依赖 en.unit 是真实 Object3D（否则合批换成代理对象会在别处炸）',
    !/\.unit\.(position|rotation|scale|matrixWorld|getWorldPosition)/.test(srcOf('src/presentation/ThreeRenderer.js'))
    && !/\.unit\.(position|rotation|scale|matrixWorld|getWorldPosition)/.test(srcOf('src/ui/CanvasController.js')));

  // _isInstancedType 是纯函数（不摸 this 上任何东西以外的字段），可以直接借出来单测
  const fn = UnitLayer.prototype._isInstancedType;
  T('_isInstancedType(melee) → true（走合批）', fn.call({}, { type: 'melee' }) === true);
  T('_isInstancedType(自定义兵种) → true（合批不区分内置/自定义，key 天然按 type 分桶）', fn.call({}, { type: 'my_custom_wolf' }) === true);
  T('_isInstancedType(tower) → true（v51.31：塔也合批了）', fn.call({}, { type: 'tower' }) === true);
  T('_isInstancedType(dragon) → false（龙不合批：数量少、颜色任意，合批收益趋近于零）', fn.call({}, { type: 'dragon' }) === false);
}

done();
