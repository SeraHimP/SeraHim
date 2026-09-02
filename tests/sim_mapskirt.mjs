// v51.27：地图外围裙边 + 自动雾效——用户："咱们现在的地图说白了就是个纸片子，
// 空白地方加个背景图片？？？还是啥。" 根因是地形贴合世界边界的硬边、边界外直接是
// 纯色虚空。MapSkirtLayer 用复用地形贴图的延伸拉伸 + 顶点 alpha 径向淡出软化这条边，
// ThreeRenderer._autoFog 再叠一层近实远虚的线性雾。两者都是零新增美术资源的默认方案，
// 且都给以后接真背景图 / 手调雾效范围留了软编码入口。
import { srcOf, scoreboard } from './_harness.mjs';
import * as THREE from '../vendor/three.module.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

const { MapSkirtLayer } = await import('../src/presentation/MapSkirtLayer.js');
const { ThreeRenderer } = await import('../src/presentation/ThreeRenderer.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('地图裙边 + 自动雾效');

// ==================== 源码形态：接线确实存在 ====================
{
  const src = srcOf('src/presentation/ThreeRenderer.js');
  T('导入了 MapSkirtLayer', /import \{ MapSkirtLayer \} from '\.\/MapSkirtLayer\.js'/.test(src));
  T('构造函数里建了 this.skirt', /this\.skirt = new MapSkirtLayer/.test(src));
  T('_rebuildTerrain 里建裙边（复用刚合成的地形贴图）', /this\.skirt\.build\(this\.mapSystem, tex\)/.test(src));
  T('_disposeTerrain 里清裙边', /this\.skirt\?\.dispose\(\)/.test(src));
  T('setLighting 没传 fog 时走自动雾效', /this\._autoFog\(\)/.test(src));
}
{
  const src = srcOf('src/data/Config.js');
  T('Config 里有 mapSkirt 软编码块', /mapSkirt:\s*\{/.test(src));
  T('Config 里有 mapFog 软编码块', /mapFog:\s*\{/.test(src));
}

// ==================== MapSkirtLayer：真实构建（几何/材质是纯 CPU 计算，不需要 WebGL 上下文）====================
{
  const scene = new THREE.Scene();
  const skirt = new MapSkirtLayer(scene);
  const fakeTex = new THREE.Texture();
  const mapA = { id: 'mapA', world: { w: 2000, h: 1000 } };

  skirt.build({ currentMap: mapA }, fakeTex);
  T('build 后有 mesh', !!skirt.mesh);
  T('mesh 已经加进 scene', scene.children.includes(skirt.mesh));
  T('材质复用了传入的地形贴图（零新增美术资源的默认方案）', skirt.mesh.material.map === fakeTex);
  T('材质开了顶点色 + 透明（径向 alpha 淡出要靠这个）', skirt.mesh.material.vertexColors === true && skirt.mesh.material.transparent === true);

  const pos = skirt.mesh.geometry.attributes.position;
  const col = skirt.mesh.geometry.attributes.color;
  let minA = Infinity, maxA = -Infinity, nanCount = 0, centerA = null, edgeA = null;
  const WW = mapA.world.w, WH = mapA.world.h;
  for (let i = 0; i < pos.count; i++) {
    const a = col.getW(i);
    if (Number.isNaN(a)) nanCount++;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    const lx = pos.getX(i) / WW, lz = pos.getZ(i) / WH;
    if (Math.abs(lx) < 1e-6 && Math.abs(lz) < 1e-6) centerA = a;             // 地图正中心
    if (Math.abs(Math.abs(lx) - 1.5) < 0.02 && Math.abs(lz) < 0.02) edgeA = a; // 裙边最外圈（scale=3 时 |lx| 最大到 1.5）
  }
  T('顶点 alpha 全部是有限数字（没有 NaN，halfExtra 除法没算挂）', nanCount === 0);
  T('地图正中心 alpha=1（贴着地形，完全不透明）', centerA !== null && Math.abs(centerA - 1) < 1e-6);
  T('裙边最外圈 alpha=0（完全透出后面的纯色背景）', edgeA !== null && edgeA < 1e-6);
  T('alpha 覆盖了从 1 到 0 的完整范围（径向淡出确实在起作用，不是恒定值）', minA < 0.01 && maxA > 0.99);

  T('mesh 位置对齐地图中心（与地形同一套坐标系）', skirt.mesh.position.x === WW / 2 && skirt.mesh.position.z === WH / 2);
  T('mesh 比地形低（避免共面 z-fighting），用的是 Config 的 yOffset', skirt.mesh.position.y === (CONFIG.ui.mapSkirt.yOffset ?? -15));

  // 同一张图重复 build：应该是 no-op（不重新分配 mesh，避免每帧重建的浪费）
  const meshBefore = skirt.mesh;
  skirt.build({ currentMap: mapA }, fakeTex);
  T('同一张图重复 build 不重新分配 mesh（幂等）', skirt.mesh === meshBefore);

  // 换图：应该重建（旧 mesh 从 scene 里移除，新 mesh 加进去）
  const mapB = { id: 'mapB', world: { w: 3000, h: 3000 } };
  skirt.build({ currentMap: mapB }, fakeTex);
  T('切图后重建出新的 mesh', skirt.mesh !== meshBefore);
  T('旧 mesh 已经从 scene 里移除', !scene.children.includes(meshBefore));
  T('新 mesh 尺寸跟着新地图的边长变化', skirt.mesh.position.x === mapB.world.w / 2);

  // dispose：mesh 清空，scene 里也没有了
  const meshC = skirt.mesh;
  skirt.dispose();
  T('dispose 后 mesh 置空', skirt.mesh === null);
  T('dispose 后 scene 里也没有了', !scene.children.includes(meshC));

  // enabled:false：不建
  const origEnabled = CONFIG.ui.mapSkirt.enabled;
  CONFIG.ui.mapSkirt.enabled = false;
  skirt.build({ currentMap: mapA }, fakeTex);
  T('mapSkirt.enabled=false 时不建裙边', skirt.mesh === null);
  CONFIG.ui.mapSkirt.enabled = origEnabled;

  // 没有地形贴图（terrainTex 为 null，比如地形本身没建出来）：优雅跳过，不报错
  skirt.build({ currentMap: mapA }, null);
  T('没有地形贴图时优雅跳过（不炸）', skirt.mesh === null);
}

// ==================== _autoFog：纯 JS 计算（跟 _autoAdjustQuality 一样摘 prototype 单测）====================
{
  const autoFog = ThreeRenderer.prototype._autoFog;
  const mkFake = (ww, wh) => ({ scene: new THREE.Scene(), mapSystem: ww ? { currentMap: { world: { w: ww, h: wh } } } : { currentMap: null } });
  const F = CONFIG.ui.mapFog;

  const small = mkFake(2000, 2000);
  autoFog.call(small);
  T('小图也会起雾', !!small.scene.fog);

  const big = mkFake(6000, 6000);
  autoFog.call(big);
  const halfDiagSmall = Math.hypot(2000, 2000) / 2, halfDiagBig = Math.hypot(6000, 6000) / 2;
  T('near 与地图尺寸无关（只取决于相机距离与 nearOffset，不该随地图变）', small.scene.fog.near === big.scene.fog.near);
  T('far 随地图对角线变大而变远（大图完全雾化的位置更远）', big.scene.fog.far > small.scene.fog.far);
  T('far-near 之差按半对角线线性变化（公式：halfDiag + farOffset - nearOffset）',
    Math.abs((big.scene.fog.far - big.scene.fog.near) - (halfDiagBig + (F.farOffset ?? 7000) - (F.nearOffset ?? 800))) < 1
    && Math.abs((small.scene.fog.far - small.scene.fog.near) - (halfDiagSmall + (F.farOffset ?? 7000) - (F.nearOffset ?? 800))) < 1);

  const noMap = mkFake(0, 0);
  autoFog.call(noMap);
  T('没有当前地图时不报错，用默认半对角线兜底', !!noMap.scene.fog);

  const colored = mkFake(2000, 2000);
  colored.scene.background = new THREE.Color('#112233');
  autoFog.call(colored);
  T('雾色取自当前 scene.background（昼夜/天气怎么染色，雾跟着染，不用另开一条通路）',
    colored.scene.fog.color.getHexString() === '112233');

  const orig = CONFIG.ui.mapFog.enabled;
  CONFIG.ui.mapFog.enabled = false;
  const off = mkFake(2000, 2000);
  autoFog.call(off);
  T('mapFog.enabled=false 时不设雾', off.scene.fog === null);
  CONFIG.ui.mapFog.enabled = orig;
}

done();
