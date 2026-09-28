// v55.9 修复验收：WaterLayer.js 河道水面随气温降温变色
//
// 用户看实机截图反馈"这个水和环境是割裂的"——WaterLayer 原来只有一个固定色
// （0x35707c），寒潮/大雪把全图压成白/冷色调后这块饱和色的水面完全不参与环境
// 变化，显得像贴上去的一块色块。用户选定方向"降温变色"：保持液态水材质，天冷
// 时颜色往 CONFIG.ui.water.coldColor 混，见 DayNight.js applyWeatherTempTint 的
// waterColdness 输出（那部分纯逻辑测试在 sim_weather.mjs）。这里测 WaterLayer
// 本身：真实构建材质 + setColdness() 的颜色混合是否符合预期。
//
// WaterLayer 内部用 document.createElement('canvas') 建涟漪法线贴图和河带遮罩，
// headless Node 没有真实 DOM——跟 sim_groundtracelayer.mjs 同一个套路，用一个
// 最小 fake canvas 顶上。
import { scoreboard } from './_harness.mjs';
import * as THREE from '../vendor/three.module.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

function makeFakeCanvas() {
  return {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }),
  };
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : {}) };

const { WaterLayer } = await import('../src/presentation/WaterLayer.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('WaterLayer（河道水面）v55.9 降温变色验收');

const mapSystem = {
  hasWalls: () => true,
  riverFactor: (x, y) => (Math.abs(x - y) < 200 ? 1 : 0),
  currentMap: { id: 'test_map', world: { w: 4000, h: 4000 }, heightZones: { riverDepth: -10 } },
};

{
  const scene = new THREE.Scene();
  const layer = new WaterLayer(scene);
  layer.build(mapSystem);
  const baseHex = CONFIG.ui?.water?.color ?? '#35707c';
  T('①-建好后水面材质初始颜色就是 CONFIG.ui.water.color（常温色）',
    layer.mesh.material.color.getHexString() === baseHex.replace('#', ''));

  layer.setColdness(1);
  const coldHex = CONFIG.ui?.water?.coldColor ?? '#8199a3';
  T('②-setColdness(1) 后颜色变成 CONFIG.ui.water.coldColor（满冷）',
    layer.mesh.material.color.getHexString() === coldHex.replace('#', ''));

  layer.setColdness(0);
  T('③-setColdness(0) 能变回常温色（不是单向不可逆的染色）',
    layer.mesh.material.color.getHexString() === baseHex.replace('#', ''));

  layer.setColdness(0.5);
  const mid = layer.mesh.material.color.getHexString();
  T('④-setColdness(0.5) 是介于常温色和冷色之间的过渡色（不是非黑即白的开关）',
    mid !== baseHex.replace('#', '') && mid !== coldHex.replace('#', ''));
}

{
  // 换图重建材质（build() 第二次调用会先 clear 再重建）：之前设置的 coldness
  // 应该在新材质上立即生效，不能一换图就跳回常温色（用户实机会先看到"啪"一下）。
  const scene = new THREE.Scene();
  const layer = new WaterLayer(scene);
  layer.build(mapSystem);
  layer.setColdness(1);
  const mapSystem2 = {
    hasWalls: () => true,
    riverFactor: mapSystem.riverFactor,
    currentMap: { id: 'test_map_2', world: { w: 3000, h: 3000 }, heightZones: { riverDepth: -8 } },
  };
  layer.build(mapSystem2); // 换图，触发 clear() + 重新 build()
  const coldHex = CONFIG.ui?.water?.coldColor ?? '#8199a3';
  T('⑤-换图重建材质后，之前设置的 coldness 状态被保留（不会跳回常温色）',
    layer.mesh.material.color.getHexString() === coldHex.replace('#', ''));
}

{
  // setColdness 边界钳位 + mesh 未建好时不抛异常。
  const scene = new THREE.Scene();
  const layer = new WaterLayer(scene);
  layer.setColdness(0.7); // mesh 还没建，不应该抛异常
  T('⑥-mesh 未建好时调用 setColdness 不抛异常（只是没有可视效果）', true);
  layer.build(mapSystem);
  layer.setColdness(5); // 超出 0~1 范围
  const coldHex = CONFIG.ui?.water?.coldColor ?? '#8199a3';
  T('⑦-setColdness 传入超过1的值会被钳到1（不会混出范围外的颜色）',
    layer.mesh.material.color.getHexString() === coldHex.replace('#', ''));
}

done();
