// v51.27/v51.29：地图外围裙边 + 自动雾效——用户："咱们现在的地图说白了就是个纸片子，
// 空白地方加个背景图片？？？还是啥。" 根因是地形贴合世界边界的硬边、边界外直接是
// 纯色虚空。MapSkirtLayer 铺一圈更大的裙边贴图（没配背景图时纯色兜底），用自定义
// fadeAlpha 顶点属性做径向淡出软化这条边，ThreeRenderer._autoFog 再叠一层近实远虚的
// 线性雾。
//
// v51.29：接入用户真提供的背景图后连续排查出两个真 bug（详见 MapSkirtLayer.js 头注）：
// ① vertexColors:true(itemSize4 RGBA) + material.map 这个组合在这套 three.js 里根本
//    不渲染——改用 onBeforeCompile 注入自定义 fadeAlpha(itemSize1) 属性绕开；
// ② MeshLambertMaterial 会把裙边压到源图 1/4~1/5 亮度，跟同样很暗的背景撞在一起，
//    肉眼看着跟"没渲染"一模一样——改用 MeshBasicMaterial（不吃光照）+ setTint()
//    手动做昼夜响应。
// 这里还捎带测出第三件事：THREE.TextureLoader 内部靠 document.createElementNS 建
// <img>，headless Node（没有 DOM）里 .load() 会【同步】抛错——用 try/catch 兜底。
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
  T('_rebuildTerrain 里建裙边', /this\.skirt\.build\(this\.mapSystem\)/.test(src));
  T('_disposeTerrain 里清裙边', /this\.skirt\?\.dispose\(\)/.test(src));
  T('setLighting 没传 fog 时走自动雾效', /this\._autoFog\(\)/.test(src));
  T('setLighting 里给裙边调用 setTint（MeshBasicMaterial 不吃光照，靠这个做昼夜响应）',
    /this\.skirt\.setTint\(unitTint\)/.test(src));
}
{
  const src = srcOf('src/data/Config.js');
  T('Config 里有 mapSkirt 软编码块', /mapSkirt:\s*\{/.test(src));
  T('Config 里有 mapFog 软编码块', /mapFog:\s*\{/.test(src));
  T('mapSkirt.texturePath 已经指向用户提供的背景图', /texturePath:\s*'assets\/textures\/env\/skirt_horizon\.png'/.test(src));
}
{
  const src = srcOf('src/presentation/MapSkirtLayer.js');
  T('贴图加载包了 try/catch（非浏览器环境 TextureLoader.load 会同步抛错，必须兜住）',
    /try\s*\{[\s\S]*_texLoader\.load\([\s\S]*\}\s*catch/.test(src));
  T('材质是 MeshBasicMaterial（不是 Lambert——排查记录 #2：Lambert 会把裙边压暗到看不见）',
    /new THREE\.MeshBasicMaterial\(/.test(src));
  T('用 onBeforeCompile 注入自定义 fadeAlpha 属性（排查记录 #1：绕开 vertexColors+map 的渲染 bug）',
    /onBeforeCompile/.test(src) && /fadeAlpha/.test(src));
  T('没有背景图时用 1×1 纯色 DataTexture 兜底（material.map 恒定有值，不分叉）',
    /_solidTexture/.test(src) && /new THREE\.DataTexture/.test(src));
}

// ==================== MapSkirtLayer：真实构建（几何/材质是纯 CPU 计算，不需要 WebGL 上下文）====================
{
  const scene = new THREE.Scene();
  const skirt = new MapSkirtLayer(scene);
  const mapA = { id: 'mapA', world: { w: 2000, h: 1000 } };

  skirt.build({ currentMap: mapA });
  T('build 后有 mesh', !!skirt.mesh);
  T('mesh 已经加进 scene', scene.children.includes(skirt.mesh));
  T('材质是 MeshBasicMaterial + 透明（径向 alpha 淡出要靠这个）',
    skirt.mesh.material.type === 'MeshBasicMaterial' && skirt.mesh.material.transparent === true);
  T('material.map 恒定有值（headless 下背景图加载必然失败，落到 1×1 纯色贴图兜底，不是 null）',
    !!skirt.mesh.material.map);
  T('几何没有 color 属性了（不再走 vertexColors 那条路径，改用 fadeAlpha）',
    !skirt.mesh.geometry.attributes.color);

  const pos = skirt.mesh.geometry.attributes.position;
  const fade = skirt.mesh.geometry.attributes.fadeAlpha;
  T('fadeAlpha 属性存在且是单分量', !!fade && fade.itemSize === 1);
  let minA = Infinity, maxA = -Infinity, nanCount = 0, centerA = null, edgeA = null;
  const WW = mapA.world.w, WH = mapA.world.h;
  for (let i = 0; i < pos.count; i++) {
    const a = fade.getX(i);
    if (Number.isNaN(a)) nanCount++;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    const lx = pos.getX(i) / WW, lz = pos.getZ(i) / WH;
    if (Math.abs(lx) < 1e-6 && Math.abs(lz) < 1e-6) centerA = a;             // 地图正中心
    if (Math.abs(Math.abs(lx) - 1.5) < 0.02 && Math.abs(lz) < 0.02) edgeA = a; // 裙边最外圈（scale=3 时 |lx| 最大到 1.5）
  }
  T('fadeAlpha 全部是有限数字（没有 NaN，halfExtra 除法没算挂）', nanCount === 0);
  T('地图正中心 fadeAlpha=1（贴着地形，完全不透明）', centerA !== null && Math.abs(centerA - 1) < 1e-6);
  T('裙边最外圈 fadeAlpha=0（完全透出后面的场景）', edgeA !== null && edgeA < 1e-6);
  T('fadeAlpha 覆盖了从 1 到 0 的完整范围（径向淡出确实在起作用，不是恒定值）', minA < 0.01 && maxA > 0.99);

  T('mesh 位置对齐地图中心（与地形同一套坐标系）', skirt.mesh.position.x === WW / 2 && skirt.mesh.position.z === WH / 2);
  T('mesh 比地形低（避免共面 z-fighting），用的是 Config 的 yOffset', skirt.mesh.position.y === (CONFIG.ui.mapSkirt.yOffset ?? -15));

  // setTint：材质色是乘数，跟 VegetationLayer.setTint 同一手法
  skirt.setTint('#804020');
  T('setTint 直接写材质色（MeshBasicMaterial 不吃光照，昼夜响应靠这个手动补）',
    skirt.mesh.material.color.getHexString() === '804020');

  // 同一张图重复 build：应该是 no-op（不重新分配 mesh，避免每帧重建的浪费）
  const meshBefore = skirt.mesh;
  skirt.build({ currentMap: mapA });
  T('同一张图重复 build 不重新分配 mesh（幂等）', skirt.mesh === meshBefore);

  // 换图：应该重建（旧 mesh 从 scene 里移除，新 mesh 加进去），且当前染色要补回去
  const mapB = { id: 'mapB', world: { w: 3000, h: 3000 } };
  skirt.build({ currentMap: mapB });
  T('切图后重建出新的 mesh', skirt.mesh !== meshBefore);
  T('旧 mesh 已经从 scene 里移除', !scene.children.includes(meshBefore));
  T('新 mesh 尺寸跟着新地图的边长变化', skirt.mesh.position.x === mapB.world.w / 2);
  T('切图重建后昼夜染色没有丢（不会闪回白色）', skirt.mesh.material.color.getHexString() === '804020');

  // dispose：mesh 清空，scene 里也没有了
  const meshC = skirt.mesh;
  skirt.dispose();
  T('dispose 后 mesh 置空', skirt.mesh === null);
  T('dispose 后 scene 里也没有了', !scene.children.includes(meshC));

  // enabled:false：不建
  const origEnabled = CONFIG.ui.mapSkirt.enabled;
  CONFIG.ui.mapSkirt.enabled = false;
  skirt.build({ currentMap: mapA });
  T('mapSkirt.enabled=false 时不建裙边', skirt.mesh === null);
  CONFIG.ui.mapSkirt.enabled = origEnabled;

  // 没有 currentMap.world（比如地图还没加载）：优雅跳过，不报错
  skirt.build({ currentMap: null });
  T('没有当前地图时优雅跳过（不炸）', skirt.mesh === null);

  // 自定义 innerColor：换个颜色应该体现在纯色兜底贴图上
  const origInner = CONFIG.ui.mapSkirt.innerColor;
  CONFIG.ui.mapSkirt.innerColor = '#ff0000';
  skirt.build({ currentMap: mapA });
  const px = skirt.mesh.material.map.image.data;
  T('innerColor 软编码：改配置后纯色兜底贴图跟着变（不是写死的常量）', px[0] === 255 && px[1] === 0);
  CONFIG.ui.mapSkirt.innerColor = origInner;
  skirt.dispose();
}

// ==================== 贴图路径异常也不该崩：错误路径 / try-catch 兜底真的生效 ====================
{
  const scene = new THREE.Scene();
  const skirt = new MapSkirtLayer(scene);
  const origPath = CONFIG.ui.mapSkirt.texturePath;

  CONFIG.ui.mapSkirt.texturePath = 'assets/textures/env/does-not-exist.png';
  let threw = false;
  try { skirt.build({ currentMap: { id: 'mapErr', world: { w: 2000, h: 2000 } } }); }
  catch (_) { threw = true; }
  T('贴图路径不存在时 build() 本身不抛错（headless 下就是同步抛错→被 catch 吞掉）', !threw && !!skirt.mesh);
  T('加载失败时 material.map 仍然有值（纯色兜底没被清空）', !!skirt.mesh.material.map);

  CONFIG.ui.mapSkirt.texturePath = origPath;
  skirt.dispose();
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
