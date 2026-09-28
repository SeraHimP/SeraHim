// 地标：坑（坑底 + 立石圈 + 朝兵线的缺口）、水晶枢纽脚下的铺石广场。按地图声明开启。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { MAPS } = await import('../src/data/maps/index.js');
const { landmarkPlan, landmarkConfig, inPitFloor } = await import('../src/data/landmarks.js');
const { projectOntoPolyline } = await import('../src/data/mapValidate.js');
const { CONFIG } = await import('../src/data/Config.js');
const { T, done } = scoreboard('地标');

const list = Array.isArray(MAPS) ? MAPS : Object.values(MAPS);
const byId = (id) => list.find((m) => m.id === id);
const sr = byId('summoners_rift_v1'), tt = byId('twisted_treeline_v1');

{
  const p = landmarkPlan(sr, null);
  T('①召唤师峡谷：两个坑、两块广场', p.pits.length === 2 && p.plazas.length === 2);
  T('②广场落在各自的水晶枢纽上', p.plazas.every((z) => sr.buildings.some((b) =>
    b.tier === 'nexus_main' && b.faction === z.faction && b.pos.x === z.x && b.pos.y === z.y)));
  // 缺口朝向：男爵坑出兵走上路，缺口方向应当指向上路上离坑心最近的点。
  const baron = p.pits.find((x) => x.name === 'baron');
  const top = sr.lanes.find((l) => l.id === 'top');
  const q = projectOntoPolyline(top.waypoints, baron.x, baron.y);
  const want = Math.atan2(q.y - baron.y, q.x - baron.x);
  T('③男爵坑的缺口朝着上路', Math.abs(Math.atan2(Math.sin(baron.gaps[0] - want), Math.cos(baron.gaps[0] - want))) < 1e-6);
  const gapHalf = CONFIG.ui.landmarks.pitGapDeg * Math.PI / 180;
  const inGap = (s) => baron.gaps.some((g) => {
    const a = Math.atan2(s.y - baron.y, s.x - baron.x);
    return Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < gapHalf * 0.9;
  });
  T('④缺口里没有立石（兵能看得出从哪进坑）', baron.stones.length > 0 && !baron.stones.some(inGap));
  T('⑤立石都在坑沿附近', baron.stones.every((s) => Math.abs(Math.hypot(s.x - baron.x, s.y - baron.y) - baron.r) < baron.r * 0.1));
  T('⑥同一张图两次规划结果逐位相同（确定性，不随刷新变）', JSON.stringify(p) === JSON.stringify(landmarkPlan(sr, null)));
  T('⑦坑心不盖水、坑外照常盖水', inPitFloor(p, baron.x, baron.y) === 1 && inPitFloor(p, baron.x + baron.r * 2, baron.y) === 0);
}
{
  const p = landmarkPlan(tt, null);
  T('⑧扭曲丛林：只有广场（没声明坑），广场半径吃地图覆写', p.pits.length === 0 && p.plazas.length === 2 && p.plazas[0].r === 170);
  T('⑨map.landmarks 逐项覆写 CONFIG.ui.landmarks 基表', landmarkConfig(tt).plazaRadius === 170 && landmarkConfig(tt).plazaRings === CONFIG.ui.landmarks.plazaRings);
}
{
  const others = list.filter((m) => !m.landmarks);
  T('⑩没声明 landmarks 的地图（冰封、水晶之痕……）一律不生成',
    others.some((m) => m.id === 'howling_abyss_frost_v1') && others.some((m) => m.id === 'dominion_crystal_scar_v1')
    && others.every((m) => landmarkPlan(m, null) === null));
  const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
  T('⑪地形底图、水面、立体层三处都读同一个 landmarkPlan',
    /landmarkPlan\(/.test(src('presentation/TerrainLayer.js')) && /landmarkPlan\(/.test(src('presentation/WaterLayer.js'))
    && /landmarkPlan\(/.test(src('presentation/LandmarkLayer.js')));
  T('⑫渲染器接了 LandmarkLayer，并且换地形时会重建', /this\.landmarks\.build\(this\.mapSystem\)/.test(src('presentation/ThreeRenderer.js'))
    && /this\.landmarks\._mapId = null/.test(src('presentation/ThreeRenderer.js')));
}

done();
