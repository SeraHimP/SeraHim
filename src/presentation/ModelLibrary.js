/**
 * ModelLibrary.js —— GLB 单位模型的运行时烘焙与缓存（A：单位模型接入）
 *
 * 纯浏览器模块。headless（无 WebGL / 无纹理解码）下不会被实例化——ThreeRenderer.create()
 * 在 Node 里返回 null，故 UnitLayer 与本库都不加载，程序化几何原样作为回退。
 *
 * 每个 GLB 的处理（对拍交接文档「已知陷阱」与「任务清单 A」）：
 *   ① 【unlit → 受光】：源材质全是 KHR_materials_unlit（GLTFLoader 产出 MeshBasicMaterial，
 *      无视光照/阴影/将来的昼夜）。烘焙时改成 MeshLambertMaterial，复用已解码的贴图，
 *      与程序化单位（同为 Lambert）同一套受光口径。—— 这条不做，白天黑夜一个样。
 *   ② 【烘掉骨架变静态网格】：SkinnedMesh 逐顶点 applyBoneTransform 到静止姿势，落成普通
 *      BufferGeometry，丢弃骨骼与动画。合并后重算法线（unlit 源的法线不保证有效）。
 *   ③ 【保留挂点】：取 Buffbone_Glb_Weapon_1 的世界坐标作为炮口高度（子弹从水晶射出）。
 *      烘骨架前先把它读出来——骨架丢了就取不到了。
 *   ④ 【底面对齐 y=0、居中 x/z】：与 UnitMeshFactory.pack 同一不变量，单位才贴地站稳。
 *   ⑤ 【按 bSize 缩放】：base 模板归一化到高度 1，按 tier 的 bSize×系数派生带尺寸的模板。
 *
 * draw call：塔系模型每个 ≤2 张贴图（多数面用图0、少数用图1），故烘焙后每模型 ≤2 个 Mesh。
 * 全场塔约十余座 → 二十余 draw call，性能预算（帧均 0.74ms）绰绰有余。
 */
import * as THREE from '../../vendor/three.module.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';

const MUZZLE_BONE = 'Buffbone_Glb_Weapon_1';

// 归一化模板（高度=1）→ 目标 topY 的系数，按 tier 角色。与程序化造型的观感大致对齐。
const TOPY_FACTOR = { tower: 2.4, tower_ruin: 1.7, lane_crystal: 2.0, nexus: 2.3 };

// _mapTier → 模型角色。外/内/水晶塔/枢纽塔都用 tower.glb；两类水晶各有其模型。
function tierRole(tier) {
  if (tier === 'nexus_lane') return 'lane_crystal';
  if (tier === 'nexus_main') return 'nexus';
  return 'tower';
}

// —— 单个 Mesh/SkinnedMesh 烘焙成世界空间静态几何（非索引，含 position/uv）——
function bakeMeshWorld(o) {
  const src = o.geometry;
  const pos = src.getAttribute('position');
  const uvA = src.getAttribute('uv');
  const count = pos.count;
  const g = new THREE.BufferGeometry();
  const outPos = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  const skinned = o.isSkinnedMesh;
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i);
    if (skinned) o.applyBoneTransform(i, v);   // 静止姿势下的蒙皮结果（模型局部空间）
    v.applyMatrix4(o.matrixWorld);             // → 世界空间
    outPos[i * 3] = v.x; outPos[i * 3 + 1] = v.y; outPos[i * 3 + 2] = v.z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  // uv 不受蒙皮影响，原样搬运；缺失则补零，保证同组几何属性一致可合并
  const outUv = new Float32Array(count * 2);
  if (uvA) for (let i = 0; i < count; i++) { outUv[i * 2] = uvA.getX(i); outUv[i * 2 + 1] = uvA.getY(i); }
  g.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  if (src.index) g.setIndex(Array.from(src.index.array));
  return src.index ? g.toNonIndexed() : g;   // 全部非索引 → 属性一致，可 mergeGeometries
}

// —— 把整份 gltf 烘成归一化 base：{ parts:[{geo,material}], muzzleYNorm } ——
function bakeBase(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // ③ 挂点世界坐标——必须在丢骨架前取
  let muzzle = null;
  root.traverse(o => {
    if (!muzzle && o.name === MUZZLE_BONE) { muzzle = new THREE.Vector3(); o.getWorldPosition(muzzle); }
  });

  // ② 逐 Mesh 烘焙，按源贴图分组（塔系 ≤2 张图 → ≤2 组）
  const byMap = new Map();  // THREE.Texture|null -> { map, geos:[] }
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const geo = bakeMeshWorld(o);
    const map = (o.material && o.material.map) || null;
    if (!byMap.has(map)) byMap.set(map, { map, geos: [] });
    byMap.get(map).geos.push(geo);
  });

  // 合并每组 + 计算整体包围盒
  const merged = [];
  const box = new THREE.Box3();
  for (const { map, geos } of byMap.values()) {
    const g = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    if (!g) continue;
    g.computeBoundingBox();
    box.union(g.boundingBox);
    merged.push({ geo: g, map });
  }
  if (!merged.length) return null;

  // ④ 居中 x/z、底面对齐 y=0；再归一化到高度 1
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, minY = box.min.y;
  const height = Math.max(1e-6, box.max.y - box.min.y);
  const inv = 1 / height;
  const parts = [];
  for (const m of merged) {
    m.geo.translate(-cx, -minY, -cz);
    m.geo.scale(inv, inv, inv);
    m.geo.computeVertexNormals();   // ① 受光：unlit 源无有效法线响应，非索引烘焙后重算 = 平面着色
    m.geo.computeBoundingBox();
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({
      map: m.map || null,
      color: m.map ? 0xffffff : 0xcfd4dc,
    });
    parts.push({ geo: m.geo, material });
  }
  const muzzleYNorm = muzzle ? (muzzle.y - minY) * inv : null;
  return { parts, muzzleYNorm };
}

// —— 由 base 派生一个带尺寸的模板 Group（几何按目标高度缩放；实例 clone 共享几何/材质）——
function buildScaled(base, target) {
  const group = new THREE.Group();
  let maxY = 0;
  for (const { geo, material } of base.parts) {
    const g = geo.clone();
    g.scale(target, target, target);
    g.computeBoundingBox();
    maxY = Math.max(maxY, g.boundingBox.max.y);
    const mesh = new THREE.Mesh(g, material);   // 材质共享（阵营已烘进各自贴图，无需染色）
    group.add(mesh);
  }
  const muzzleY = base.muzzleYNorm != null ? base.muzzleYNorm * target : maxY;
  return { group, topY: maxY, muzzleY };
}

export class ModelLibrary {
  constructor(baseUrl = './assets/models/') {
    this.base = baseUrl;
    this._baseCache = new Map();    // 'faction|role' -> bakeBase 结果
    this._scaled = new Map();       // 'faction|role|bSize' -> buildScaled 结果（模板）
    this.ready = false;
    this._loading = null;
    this._manifest = null;
  }

  /** 异步加载 manifest 里的全部 GLB 并烘成 base 模板。返回一个 Promise。可重复调用（幂等）。 */
  load() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const loader = new GLTFLoader();
      this._manifest = await fetch(this.base + 'manifest.json').then(r => r.json());
      const jobs = [];
      for (const [faction, roles] of Object.entries(this._manifest)) {
        for (const [role, file] of Object.entries(roles)) {
          jobs.push(loader.loadAsync(this.base + file).then(gltf => {
            const b = bakeBase(gltf);
            if (b) this._baseCache.set(faction + '|' + role, b);
          }).catch(e => console.warn('[ModelLibrary] 烘焙失败', faction, role, e?.message || e)));
        }
      }
      await Promise.all(jobs);
      this.ready = true;
    })();
    return this._loading;
  }

  /**
   * 取塔系单位的模型模板。未加载完成 → 返回 null（UnitLayer 回退到程序化几何）。
   * @returns { key, template(Group), topY, muzzleY } | null
   */
  forTower(tier, faction, ruin, bSize) {
    if (!faction) return null;
    let role = tierRole(tier);
    if (ruin && role === 'tower') role = 'tower_ruin';
    // 水晶暂无损毁模型 → 复用正常模型占位（用户定稿），待真实损毁模型到位直接替换。
    let base = this._baseCache.get(faction + '|' + role);
    if (!base && ruin && role !== 'tower_ruin') base = this._baseCache.get(faction + '|' + role);
    if (!base) return null;
    const sk = faction + '|' + role + '|' + bSize;
    let tpl = this._scaled.get(sk);
    if (!tpl) {
      const target = bSize * (TOPY_FACTOR[role] || 2.2);
      tpl = buildScaled(base, target);
      this._scaled.set(sk, tpl);
    }
    return { key: 'M|' + sk, template: tpl.group, topY: tpl.topY, muzzleY: tpl.muzzleY };
  }

  dispose() {
    for (const b of this._baseCache.values()) for (const p of b.parts) { p.geo.dispose(); p.material.dispose(); }
    for (const t of this._scaled.values()) t.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this._baseCache.clear();
    this._scaled.clear();
  }
}
