// 地被（草丛 / 野花 / 灌木 / 芦苇 / 碎石）与萤火虫锚点的摆放：src/data/groundCover.js。
// 用户："地图要有呼吸感，要像真正的峡谷一样，有那些装饰品瀑布，植被等等。"
// 断言钉形状：该长的地方有、不该长的地方没有（路面 / 建筑脚下 / 河心）、数量有上限、可复现、可以关。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { createSimulation } = await import('../src/simulation.js');
const { CONFIG } = await import('../src/data/Config.js');
const { placeGroundCover, placeAmbientAnchors } = await import('../src/data/groundCover.js');
const { terrainThemeOf } = await import('../src/data/terrainField.js');
const { T, done } = scoreboard('地被与环境生物的摆放');

const C = CONFIG.terrain.cover, G = CONFIG.terrain.ground, K = CONFIG.terrain.cliff;
const IDS = ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1', 'dominion_crystal_scar_v1',
  'summoners_rift_organic_v1', 'confluence_v1', 'demo_stylized_v1'];
for (const id of IDS) {
  const sim = createSimulation(); sim.mapSystem.loadMap(id);
  const ms = sim.mapSystem, map = ms.currentMap, f = ms.terrainField(), theme = terrainThemeOf(map);
  const cv = placeGroundCover(f, map, theme);
  const all = Object.values(cv).flat();
  T(`被①-${id}：每种都不超过上限（${Object.entries(cv).map(([k, l]) => k + ' ' + l.length).join('，')}）`, Object.entries(cv).every(([k, l]) => l.length <= C.max[k]));
  T(`被②-${id}：全部在地图里、高度是有限数`, all.every((o) => o.x > 0 && o.y > 0 && o.x < f.W && o.y < f.H && Number.isFinite(o.h)));
  T(`被③-${id}：草丛和野花不长在路面上`, [...cv.tuft, ...cv.flower].every((o) => f.laneAt(o.x, o.y) >= G.pathHalf + 22 - 1e-6));
  const B = (map.buildings || []).map((b) => b.pos || b).filter((p) => Number.isFinite(p?.x));
  T(`被④-${id}：建筑脚下不长草、不长灌木`, [...cv.tuft, ...cv.flower, ...cv.bush].filter((o) => f.sdAt(o.x, o.y) < 0).every((o) => B.every((b) => Math.hypot(b.x - o.x, b.y - o.y) >= C.buildingClear - 1e-6)));
  T(`被⑤-${id}：芦苇只长在河岸的浅水边`, cv.reed.every((o) => { const r = f.riverAt(o.x, o.y); return r > 0.03 && r < C.reedBand + 1e-6; }));
  T(`被⑥-${id}：草丛、野花、芦苇不长进岩壁里`, [...cv.tuft, ...cv.flower, ...cv.reed].every((o) => f.sdAt(o.x, o.y) < 0));
  T(`被⑦-${id}：两次算出来一样（可复现）`, JSON.stringify(placeGroundCover(f, map, theme)) === JSON.stringify(cv));
  const an = placeAmbientAnchors(f, map, theme);
  T(`萤①-${id}：萤火虫的锚点都在能走的野地上、不在路上（${an.length} 个）`, an.length <= CONFIG.terrain.ambient.count && an.every((a) => f.sdAt(a.x, a.y) <= -6 && f.laneAt(a.x, a.y) >= G.pathHalf + 30));
  if (id === 'summoners_rift_v1') {
    T('被⑧：峡谷里五种地被都有', Object.values(cv).every((l) => l.length > 20));
    T('被⑨：灌木贴着崖脚或长在崖顶，不长在野地正中', cv.bush.every((o) => { const sd = f.sdAt(o.x, o.y); return sd > -C.bushBand - 1e-6; }));
    T('萤②：峡谷里有萤火虫的锚点', an.length > 50);
    const prev = C.enabled; C.enabled = false;
    T('开关：CONFIG.terrain.cover.enabled = false 时什么都不摆', Object.values(placeGroundCover(f, map, theme)).every((l) => l.length === 0));
    C.enabled = prev;
  }
}
done();
