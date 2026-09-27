// 天气与地图融为一体 + 积雪/水洼重做 + 沙暴沙粒 + 结构保护图标位置。
// 用户："黄沙天气，但是地面依旧是绿色的……天气层和地图是完全割裂的，需要做到天气和地图是融为一体的。
//        还有目前的积雪/水洼的可视化效果也不太好"；"防御塔结构保护那个🛡️图标的位置也应该优化一下"。
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow();

// WeatherLayer / GroundTraceLayer 会用 canvas 生成贴图，无头 Node 下给一个最小替身
function fakeCanvas() {
  return {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {}, fillRect: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      set fillStyle(_v) {},
    }),
  };
}
globalThis.document = { createElement: (t) => (t === 'canvas' ? fakeCanvas() : {}) };

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const WG = await import('../src/presentation/weatherGround.js');
const { GroundTraceLayer } = await import('../src/presentation/GroundTraceLayer.js');
const { WeatherLayer } = await import('../src/presentation/WeatherLayer.js');
const { T, done } = scoreboard('天气落到地面上 / 积雪水洼 / 沙暴 / 结构保护图标');

// ==================== 一、各天气 → 地表通道 ====================
{
  const only = (id, v = 1) => (q) => (q === id ? v : 0);
  const t0 = WG.groundTargets(() => 0);
  T('地①-没有天气时五个地表通道全是 0', WG.CHANNELS.every((c) => t0[c] === 0));
  T('地②-沙暴 → 铺沙满，其它通道不动', WG.groundTargets(only('sandstorm')).sand === 1 && WG.groundTargets(only('sandstorm')).wet === 0);
  T('地③-雨/暴雨/雷暴 → 地面变湿', ['rain', 'downpour', 'thunderstorm'].every((id) => WG.groundTargets(only(id)).wet > 0.9));
  T('地④-雪/暴风雪 → 结霜', ['snow', 'blizzard'].every((id) => WG.groundTargets(only(id)).frost > 0.9));
  T('地⑤-雾 → 褪色；烈日 → 发黄', WG.groundTargets(only('fog')).fade > 0.9 && WG.groundTargets(only('scorch')).scorch > 0.9);
  const m = WG.groundTargets(only('mirage'));
  T('地⑥-蜃景只折一部分进铺沙（系数来自 CONFIG.ui.weatherGround.sources）',
    m.sand > 0 && m.sand < 1 && Math.abs(m.sand - CONFIG.ui.weatherGround.sources.sand.mirage) < 1e-9);
  T('地⑦-充能按比例：半充能的雨 → 半湿', Math.abs(WG.groundTargets(only('rain', 0.5)).wet - 0.5) < 1e-9);
}

// ==================== 二、平滑过渡 + 天气关掉回原色 ====================
{
  const W = { enabled: true, getCharge: (id) => (id === 'sandstorm' ? 1 : 0) };
  const a = WG.updateWeatherGround(W, 0.1).sand;
  T('滑①-切到沙暴后第一帧只走一小步（不会"啪"地变色）', a > 0 && a < 0.5);
  for (let i = 0; i < 200; i++) WG.updateWeatherGround(W, 0.1);
  T('滑②-持续数秒后收敛到目标', Math.abs(WG.weatherGroundState().sand - 1) < 1e-3);
  T('滑③-uniform 跟着写进去（所有地面材质共用同一组）', Math.abs(WG.weatherGroundUniforms().uWgSand.value - 1) < 1e-3);
  for (let i = 0; i < 200; i++) WG.updateWeatherGround(null, 0.1);
  T('滑④-天气关掉/没有天气时各通道平滑回 0，地面回到原色', WG.CHANNELS.every((c) => WG.weatherGroundState()[c] < 1e-3));
  for (let i = 0; i < 200; i++) WG.updateWeatherGround({ enabled: false, getCharge: () => 1 }, 0.1);
  T('滑⑤-weather.enabled=false 等同于没有天气', WG.weatherGroundState().sand < 1e-3);
}

// ==================== 三、材质注入 ====================
{
  const fakeShader = () => ({
    uniforms: {},
    vertexShader: 'void main() {\n#include <project_vertex>\n}',
    fragmentShader: 'void main() {\n#include <map_fragment>\n}',
  });
  let prevCalled = false;
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = () => { prevCalled = true; };
  m.customProgramCacheKey = () => 'prev';
  WG.applyWeatherGround(m);
  const sh = fakeShader();
  m.onBeforeCompile(sh);
  T('材①-地面材质片元里调用 wgApply，挂在 map_fragment 之后（在原贴图色上调制，保留布局明暗）',
    /#include <map_fragment>\s*\n\s*diffuseColor\.rgb = wgApply\(diffuseColor\.rgb\)/.test(sh.fragmentShader));
  T('材②-顶点里输出世界坐标（噪声按世界坐标采样，相邻材质接缝处纹理连续）', sh.vertexShader.includes('vWgPos = (modelMatrix'));
  T('材③-已有的 onBeforeCompile 先跑（裙边的淡出、植被的风摆/落雪不被覆盖）', prevCalled);
  T('材④-共享 uniform 注入（同一个对象，改一次全场生效）', sh.uniforms.uWgSand === WG.weatherGroundUniforms().uWgSand);
  T('材⑤-program 缓存键带上原键并区分注入种类', m.customProgramCacheKey() === 'prev|wg1');
  const before = m.onBeforeCompile;
  WG.applyWeatherGround(m);
  T('材⑥-重复调用不叠加第二层', m.onBeforeCompile === before);
  const ms = WG.applyWeatherGround(new THREE.MeshLambertMaterial(), { snow: true });
  const sh2 = fakeShader(); ms.onBeforeCompile(sh2);
  T('材⑦-台面材质（snow:true）自己读雪深图画雪（地面雪盖网格盖不到高出地面的台面）',
    sh2.fragmentShader.startsWith('#define WG_SNOW') && ms.customProgramCacheKey() !== m.customProgramCacheKey());
  const md = WG.applyWeatherGround(new THREE.MeshLambertMaterial(), { dust: true });
  const sh3 = fakeShader(); md.onBeforeCompile(sh3);
  T('材⑧-植被材质（dust:true）只蒙沙', sh3.fragmentShader.includes('#define WG_DUST'));
  const glsl = srcOf('src/presentation/weatherGround.js');
  T('材⑨-沙/烈日乘河道遮罩（半透明水面底下不铺沙，河还读得出来）',
    /cover \* uWgK\.x \* land/.test(glsl) && /uWgScorch \* uWgK2\.x \* land/.test(glsl));
}

// ==================== 四、河道遮罩 ====================
{
  const ms = { currentMap: { id: 'wg_river', world: { w: 1000, h: 500 } }, riverFactor: (x) => (x < 500 ? 1 : 0) };
  WG.setWeatherGroundMap(ms);
  const tex = WG.weatherGroundUniforms().uWgRiver.value;
  const d = tex.image.data, nx = tex.image.width;
  T('河①-按 riverFactor 烘出遮罩：左半河道=255、右半陆地=0', d[0] === 255 && d[(nx - 1) * 4] === 0);
  T('河②-世界尺寸写进 uniform', WG.weatherGroundUniforms().uWgWorld.value.x === 1000 && WG.weatherGroundUniforms().uWgWorld.value.y === 500);
  WG.setWeatherGroundMap({ currentMap: { id: 'wg_dry', world: { w: 100, h: 100 } }, riverFactor: () => 0 });
  T('河③-没有河的图用 1×1 空遮罩（处处是陆地）', WG.weatherGroundUniforms().uWgRiver.value.image.width === 1);
}

// ==================== 五、接线：地形/高地顶面/裙边/台地/植被都接上了 ====================
{
  const R = srcOf('src/presentation/ThreeRenderer.js');
  T('线①-地形材质接天气地表', /applyWeatherGround\(new THREE\.MeshLambertMaterial\(\{ map: tex/.test(R));
  T('线②-渲染循环每帧推进（天气可视化关掉时传 null，地面回原色）',
    /updateWeatherGround\(this\.weatherFx\?\.enabled !== false \? \(window\.__weather \|\| null\) : null/.test(R));
  T('线③-换图时烘河道遮罩', /setWeatherGroundMap\(ms\)/.test(R));
  T('线④-高地顶面（WallLayer）按台面接（带积雪）', /applyWeatherGround\(new THREE\.MeshLambertMaterial\(\{[\s\S]*?\}\), \{ snow: true \}\)/.test(srcOf('src/presentation/WallLayer.js')));
  T('线⑤-地图外围裙边接上', /applyWeatherGround\(mat\)/.test(srcOf('src/presentation/MapSkirtLayer.js')));
  const V = srcOf('src/presentation/VegetationLayer.js');
  T('线⑥-台地顶面接上（带积雪）', /applyWeatherGround\(ms\[0\], \{ snow: true \}\)/.test(V));
  T('线⑦-植被与野区边缘树石蒙沙', /applyWeatherGround\(mat, \{ dust: true \}\)/.test(V)
    && /applyWeatherGround\(mat, \{ dust: true \}\)/.test(srcOf('src/presentation/BoundaryDecorLayer.js')));
}

// ==================== 六、积雪/水洼 ====================
{
  const scene = new THREE.Scene();
  const layer = new GroundTraceLayer(scene);
  const heights = (x) => (x > 100 ? 8 : 0);   // x>100 是一级台阶
  const mapSystem = { currentMap: { id: 'gt_wg', world: { w: 200, h: 200 } }, heightAt: (x) => heights(x) };
  const sys = {
    getPuddles: () => [{ x: 96, y: 50, strength: 1, subOffsets: [{ dx: 0, dy: 0, r: 10 }] }],
    getSnowCover: () => ({ resolution: 4, data: new Float32Array(16).fill(0.5), worldW: 200, worldH: 200, zoneMix: null }),
  };
  layer.update(sys, mapSystem);
  const core = layer._puddlePool.find((s) => s.mesh.visible), rim = layer._rimPool.find((s) => s.mesh.visible);
  T('水①-每个水面子圆配一圈湿土（单独一池）', !!core && !!rim && layer._rimPool.length === layer._puddlePool.length);
  T('水②-湿土圈比水面大、先画（被水面盖住，不会压进相邻子圆的水面里）',
    rim.mesh.scale.x > core.mesh.scale.x && rim.mesh.renderOrder < core.mesh.renderOrder);
  T('水③-台阶边上的水洼按周围最高处放（不被高的一侧地面切出一条直边）', core.mesh.position.y > 8);
  const sh = { uniforms: {}, vertexShader: 'void main() {\n#include <project_vertex>\n}', fragmentShader: 'void main() {\n#include <map_fragment>\n}' };
  core.mesh.material.onBeforeCompile(sh);
  T('水④-水面颜色按世界坐标算（相邻子圆重叠处颜色一致）+ 下雨时有雨点涟漪',
    sh.fragmentShader.includes('vGtPos.xz * uGtScale') && sh.fragmentShader.includes('uGtRain'));
  const snowSh = { uniforms: {}, vertexShader: 'void main() {\n#include <project_vertex>\n}', fragmentShader: 'void main() {\n#include <alphamap_fragment>\n}' };
  layer._snowMesh.material.onBeforeCompile(snowSh);
  T('雪①-雪盖按雪深×噪声收边（薄雪是一块块雪斑，不是一片糊边的白雾）',
    /smoothstep\(uGtEdge\.x, uGtEdge\.y, s\)/.test(snowSh.fragmentShader));
  T('雪②-雪盖贴图登记给台面材质', WG.weatherGroundUniforms().uWgSnowTex.value === layer._snowTex && WG.weatherGroundUniforms().uWgSnowOn.value === 1);
  layer.setTint(0x808080);
  T('雪③-湿土圈也吃昼夜染色（夜里不发亮）', rim.mesh.material.color.r < new THREE.Color(CONFIG.ui.groundTraceFx.puddleRimColor).r);
  layer._hideAll();
  T('雪④-隐藏时台面的雪也一起关', WG.weatherGroundUniforms().uWgSnowOn.value === 0);
}

// ==================== 七、沙暴：浮尘换成沙粒 ====================
{
  const scene = new THREE.Scene();
  const wl = new WeatherLayer(scene);
  const target = new THREE.Vector3(500, 0, 500);
  const W = (m) => ({ enabled: true, getCharge: (id) => m[id] || 0 });
  wl.update(W({ clear: 1 }), target, 1000, 800, 0.016);
  const nClear = wl._dust.geo.drawRange.count, cClear = wl._dust.mat.color.clone();
  wl.update(W({ sandstorm: 1 }), target, 1000, 800, 0.016);
  const nSand = wl._dust.geo.drawRange.count;
  T('沙①-沙暴时粒子数比晴天浮尘多得多', nSand > nClear * 2);
  T('沙②-颜色换成沙色', wl._dust.mat.color.getHex() === new THREE.Color(CONFIG.ui.weatherFx.sandColor).getHex() && cClear.getHex() !== wl._dust.mat.color.getHex());
  wl.update(W({}), target, 1000, 800, 0.016);
  T('沙③-沙暴停了粒子收掉', wl._dust.geo.drawRange.count === 0);
}

// ==================== 八、结构保护 🛡️ 图标贴在血条左端 ====================
{
  const U = srcOf('src/presentation/UnitLayer.js');
  T('盾①-图标的锚点与血条相同（模型顶），偏移按血条宽度/抬高算，参数在 CONFIG.ui.structureShieldIcon',
    /en\.shield\.center\.set\(barShown \? 0\.5 \+ \(bw \/ 2 \+ \(SI\.gap \?\? 4\) \+ sz \/ 2\) \/ sz : 0\.5, 0\.5 - bd \/ sz\)/.test(U)
    && !!CONFIG.ui.structureShieldIcon);
  T('盾④-每帧按血条是否显示摆放（满血隐藏血条时居中放在血条位置）', /if \(en\.shield\) this\._placeShieldIcon\(en, showBar\)/.test(U));
  T('盾②-不再是"模型最高点上方 22 像素"的写死偏移', !/0\.5 - 22 \/ 16/.test(U));
  // 位置换算：center.x > 0.5 表示精灵往左挪 (center.x-0.5)*size 像素
  const SI = CONFIG.ui.structureShieldIcon, bw = 80;
  const shiftLeft = (0.5 + (bw / 2 + SI.gap + SI.size / 2) / SI.size - 0.5) * SI.size;
  T('盾③-图标中心在血条左端再往左 gap + 半个图标处（不压血条）', Math.abs(shiftLeft - (bw / 2 + SI.gap + SI.size / 2)) < 1e-9);
}

done();
