// v55.4/v55.5 修复验收：GroundTraceLayer.js（雪盖渲染层）
//
// 今天排查的真根因（用户报"野区依旧没有雪覆盖"，SR/TT 两张森林风格地图都复现）：
// 雪盖是一整块固定 Y 值的平面（旧版 Y=snowCoverLift≈0.4），而森林风格地图的野区
// 台阶地形用 heightAt 抬升，实测能到 6~10 世界单位——雪盖平面比野区地面矮了一大截，
// 深度测试里雪盖被地形整个挡住，根本没画出来，跟纹理数据里雪深/颜色/alpha 写没
// 写对毫无关系（这也是这次排查踩的坑：只查 Canvas 纹理数据本身，没有连着实际
// 3D 合成结果一起核对，才把"贴图对了"误判成"整条链路都对了"，见 GroundTraceLayer.js
// _ensureSnowMesh 头注 v55.5 记录）。
//
// 这里补两类回归测试：
//   ① 幾何跟随 heightAt——这是今天真正的 bug 本体，源码正则测不出"平面到底有没有
//      抬到地形高度"，必须真的构建 PlaneGeometry 检查顶点 Y 值。
//   ② 野区不透明度上限提升（snowCoverJungleAlphaBoost）——纹理 alpha 通道的具体
//      数值计算，同样是必须真跑一遍 update() 才能钉住的行为。
//
// GroundTraceLayer 内部用 document.createElement('canvas') 建纹理画布，headless
// Node 没有真实 DOM——用一个最小 fake canvas（够用的 getContext('2d') 子集：
// createImageData/putImageData/fillRect/createRadialGradient）顶上，不引入完整
// DOM 环境（这个仓库目前没有先例这么测 canvas 纹理层，其它同类文件都是走"源码
// 形态断言"绕开，但那种测法测不出这次的真根因——纯正则测不出"平面到底有没有
// 抬到地形高度"，这里改用真实构建 geometry + 查顶点数据）。
import { scoreboard, srcOf } from './_harness.mjs';
import * as THREE from '../vendor/three.module.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

function makeFakeCanvas() {
  return {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      set fillStyle(_v) {},
    }),
  };
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : {}) };

const { GroundTraceLayer } = await import('../src/presentation/GroundTraceLayer.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('GroundTraceLayer（雪盖渲染层）v55.4/v55.5 修复验收');

// ==================== 一、雪盖平面几何跟随 heightAt（今天的真根因） ====================
{
  const scene = new THREE.Scene();
  const layer = new GroundTraceLayer(scene);
  const mapSystem = {
    currentMap: { id: 'forest_map', world: { w: 400, h: 400 } },
    heightAt: (x) => (x > 200 ? 8 : 0), // 模拟森林野区（x>200）比路面（x<=200）高出8世界单位
  };
  layer._ensureSnowMesh(mapSystem, 8);
  const pos = layer._snowMesh.geometry.attributes.position;
  let maxY = -Infinity, minY = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    maxY = Math.max(maxY, y); minY = Math.min(minY, y);
  }
  T('几何①-有 heightAt 时，雪盖顶点高度跟着地形起伏（不再是单一固定Y值）',
    maxY - minY > 5);
  T('几何②-雪盖最高处顶点的Y值接近野区地形高度（8）+ 离地量，而不是卡在 0.4',
    maxY > 7);
  T('几何③-mesh 自身 position.y 归零（高度已经烘焙进每个顶点，不再靠整体平移）',
    layer._snowMesh.position.y === 0);
}
{
  // 没有 heightAt（老式地图/纯平地图）时保持逐位不变：整块平面还是单一固定 Y。
  const scene = new THREE.Scene();
  const layer = new GroundTraceLayer(scene);
  const mapSystem = { currentMap: { id: 'flat_map', world: { w: 400, h: 400 } } }; // 没有 heightAt
  layer._ensureSnowMesh(mapSystem, 8);
  const pos = layer._snowMesh.geometry.attributes.position;
  const lift = CONFIG.ui?.groundTraceFx?.snowCoverLift ?? 0.4;
  let allFlat = true;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getY(i)) > 1e-6) allFlat = false; // 顶点局部Y未被抬升，离地量交给 mesh.position.y
  }
  T('几何④-没有 heightAt 的老地图，雪盖仍是整块单一高度的平面（画面不变）', allFlat);
  T('几何⑤-没有 heightAt 时 mesh.position.y 仍是 snowCoverLift（跟改动前逐位一致）',
    Math.abs(layer._snowMesh.position.y - lift) < 1e-6);
}

// ==================== 二、野区不透明度上限提升（snowCoverJungleAlphaBoost） ====================
{
  const scene = new THREE.Scene();
  const layer = new GroundTraceLayer(scene);
  const mapSystem = { currentMap: { id: 'zone_map', world: { w: 32, h: 32 } } }; // 无 heightAt，平地，只测 alpha
  const resolution = 4;
  // 4x4 网格：idx0 zoneMix=0（路面），idx1 zoneMix=1（野区），雪深都拉满=1。
  const grid = new Float32Array(resolution * resolution).fill(1);
  const zoneMix = new Float32Array(resolution * resolution).fill(0);
  zoneMix[1] = 1; // 野区格
  const groundTraceSystem = {
    getPuddles: () => [],
    getSnowCover: () => ({ resolution, data: grid, worldW: mapSystem.currentMap.world.w, worldH: mapSystem.currentMap.world.h, zoneMix }),
  };
  layer.update(groundTraceSystem, mapSystem);
  const data = layer._snowImgData.data;
  const pathAlpha = data[0 * 4 + 3];   // idx0：路面格
  const jungleAlpha = data[1 * 4 + 3]; // idx1：野区格
  const snowCoverAlpha = CONFIG.ui?.groundTraceFx?.snowCoverAlpha ?? 0.6;
  const boost = CONFIG.ui?.groundTraceFx?.snowCoverJungleAlphaBoost ?? 1;
  T('野区①-路面格（zoneMix=0）满雪深时不透明度就是原始 snowCoverAlpha，不受这次改动影响',
    Math.abs(pathAlpha / 255 - snowCoverAlpha) < 0.01);
  T('野区②-野区格（zoneMix=1）满雪深时不透明度比路面更高（snowCoverJungleAlphaBoost>1 时生效）',
    boost > 1 ? jungleAlpha > pathAlpha : jungleAlpha === pathAlpha);
  T('野区③-野区不透明度上限约等于 snowCoverAlpha × snowCoverJungleAlphaBoost（今天报告的0.6→0.9那档）',
    Math.abs(jungleAlpha / 255 - Math.min(1, snowCoverAlpha * boost)) < 0.02);
  T('野区④-material.opacity 固定为1（真正的上限已经编码进纹理 alpha 通道本身）',
    layer._snowMesh.material.opacity === 1);
}

// ==================== 四、2026-09-26 修复：夜里雪盖/水洼跟着昼夜变暗 ====================
// 用户报"雪覆盖的时候，夜晚已经看不出来是夜晚了，依旧亮堂堂的"——根因是水洼/雪盖
// 用 MeshBasicMaterial，不吃场景光照，昼夜系统压暗光源对它们没用。修法是跟
// MapSkirtLayer/VegetationLayer 同一套：昼夜系统算出的 tint 颜色乘进 material.color。
{
  const scene = new THREE.Scene();
  const layer = new GroundTraceLayer(scene);
  const mapSystem = { currentMap: { id: 'tint_map', world: { w: 16, h: 16 } } };
  const resolution = 2;
  const groundTraceSystem = {
    getPuddles: () => [{ x: 8, y: 8, strength: 1, r: 4, subOffsets: [{ dx: 0, dy: 0, r: 4 }] }],
    getSnowCover: () => ({ resolution, data: new Float32Array(resolution * resolution).fill(1), worldW: 16, worldH: 16, zoneMix: null }),
  };
  layer.update(groundTraceSystem, mapSystem); // 先建出雪盖 mesh + 至少一个可见水洼槽位

  T('夜①-GroundTraceLayer 导出了 setTint 方法（跟 VegetationLayer/MapSkirtLayer 同一套接口）',
    typeof layer.setTint === 'function');

  // THREE.Color 的颜色管理会把 hex 当 sRGB 转成线性值再存——0x808080 存出来是
  // ≈0.2159，不是天真按 8 位比例算出来的 0.5（这是 three.js 本身的颜色管线，
  // 不是这里的换算逻辑）。拿真实的 THREE.Color 转换结果当期望值，不要在测试里
  // 重新发明一套换算公式。
  const expected = new THREE.Color(0x808080).r;
  layer.setTint(0x808080); // 半灰：夜晚场景常见的暗淡 tint
  const snowColor = layer._snowMesh.material.color;
  T('夜②-setTint 后雪盖材质颜色被压暗（不再是满值白色 1,1,1）',
    snowColor.r < 0.99 && snowColor.g < 0.99 && snowColor.b < 0.99);
  T('夜③-雪盖颜色约等于白色×tint',
    Math.abs(snowColor.r - expected) < 0.01 && Math.abs(snowColor.g - expected) < 0.01 && Math.abs(snowColor.b - expected) < 0.01);

  const visiblePuddle = layer._puddlePool.find((s) => s.mesh.visible);
  T('夜④-水洼材质颜色同样被压暗（同一个坑，两处一起修，不能只修雪盖漏水洼）',
    !!visiblePuddle && visiblePuddle.mesh.material.color.r < 0.99);

  // 模拟"换图后雪盖 mesh 被重建"：重建时新材质默认是满值白，_applyTint 必须在
  // update() 里跟着重新调用一遍，不能指望外部再手动调一次 setTint。
  layer._disposeSnowMesh();
  layer.update(groundTraceSystem, mapSystem);
  const rebuiltColor = layer._snowMesh.material.color;
  T('夜⑤-雪盖 mesh 重建后（换图场景）tint 依然生效，不会退回满值白色',
    Math.abs(rebuiltColor.r - expected) < 0.01);

  // ThreeRenderer 没法在 headless Node 里真的 new 出来（需要真实 WebGL 上下文），
  // 跟 veg/skirt 的接线一样只能走源码级断言，钉住"setLighting 里确实调用了
  // groundTrace.setTint"这条接线，不是只改了 GroundTraceLayer 自己却忘了接进
  // 昼夜系统唯一的光照入口。
  const trSrc = srcOf('src/presentation/ThreeRenderer.js');
  T('夜⑥-ThreeRenderer.setLighting() 接了 groundTrace.setTint(unitTint)（跟 veg/skirt 同一条 unitTint 分支里）',
    /if \(this\.groundTrace\?\.setTint\) this\.groundTrace\.setTint\(unitTint\);/.test(trSrc));
}

done();
