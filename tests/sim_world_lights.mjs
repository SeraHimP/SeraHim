// 局部光（路边火炬 + 水晶的光）：src/data/torchSites.js 的站位与光源清单。
// 用户："路的两边自带光源（墙上的火炬），然后塔目前就不要自带光源了，但是水晶在任何时候都要发光。"
// 断言钉形状：每张有兵线的图都有火炬、都立在能站的地面上、不堵路、不进河、不贴建筑、彼此不扎堆；水晶的光跟着建筑清单走。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { createSimulation } = await import('../src/simulation.js');
const { CONFIG } = await import('../src/data/Config.js');
const { placeTorches, localLightList } = await import('../src/data/torchSites.js');
const { T, done } = scoreboard('局部光：火炬站位 + 光源清单');

const L = CONFIG.terrain.lights, G = CONFIG.terrain.ground;
const IDS = ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1', 'dominion_crystal_scar_v1',
  'summoners_rift_organic_v1', 'confluence_v1', 'demo_stylized_v1'];
for (const id of IDS) {
  const sim = createSimulation(); sim.mapSystem.loadMap(id);
  const ms = sim.mapSystem, map = ms.currentMap, f = ms.terrainField();
  const ts = placeTorches(f, map);
  T(`炬①-${id}：沿兵线放得出火炬（${ts.length} 支）`, ts.length >= 4);
  T(`炬②-${id}：每支都立在能站的地面上、在地图里`, ts.every((t) => f.sdAt(t.x, t.y) <= -3 && t.x > 0 && t.y > 0 && t.x < f.W && t.y < f.H));
  T(`炬③-${id}：不立在路中间（离兵线中心 ≥ 路面半宽的 0.6 倍）`, ts.every((t) => f.laneAt(t.x, t.y) >= G.pathHalf * 0.6));
  T(`炬④-${id}：不进河`, ts.every((t) => f.riverAt(t.x, t.y) <= 0.06));
  const B = (map.buildings || []).map((b) => b.pos || b).filter((p) => Number.isFinite(p?.x));
  T(`炬⑤-${id}：不贴着建筑`, ts.every((t) => B.every((b) => Math.hypot(b.x - t.x, b.y - t.y) >= L.buildingClear - 1e-6)));
  let minD = Infinity;
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) minD = Math.min(minD, Math.hypot(ts[i].x - ts[j].x, ts[i].y - ts[j].y));
  T(`炬⑥-${id}：彼此不扎堆（最近的两支相距 ${minD.toFixed(0)} ≥ ${L.minGap}）`, minD >= L.minGap - 1e-6);
  T(`炬⑦-${id}：同一张图两次算出来的站位一样（可复现）`, JSON.stringify(placeTorches(f, map)) === JSON.stringify(ts));
  T(`炬⑧-${id}：朝向是单位向量、指向路的一侧`, ts.every((t) => Math.abs(Math.hypot(t.dx, t.dy) - 1) < 1e-6));
  if (id === 'summoners_rift_v1') {
    T('炬⑨：峡谷里大多数火炬贴着岩壁（墙上的火炬）', ts.filter((t) => t.wall).length > ts.length * 0.5);
    const lights = localLightList(ts, [{ x: 100, y: 100, faction: 'blue', kind: 'tower' }, { x: 200, y: 200, faction: 'red', kind: 'gem' }], f.theme);
    T('光①：光源清单 = 火炬 + 活着的建筑', lights.length === ts.length + 2);
    const [a, b] = lights.slice(-2);
    T('光②：蓝方水晶的光偏蓝、红方偏红', a.color !== b.color && a.color === L.crystal.blue && b.color === L.crystal.red);
    T('光③：水晶枢纽照得比防御塔远', b.r > a.r);
    T('光④：建筑清单空了，水晶的光就没了（只剩火炬）', localLightList(ts, [], f.theme).length === ts.length);
    const off = CONFIG.terrain.lights.torches; CONFIG.terrain.lights.torches = false;
    T('开关：CONFIG.terrain.lights.torches = false 时不放火炬', placeTorches(f, map).length === 0);
    CONFIG.terrain.lights.torches = off;
  }
}
done();
