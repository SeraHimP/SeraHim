// 地形高度场（src/data/terrainField.js）+ 河道形状（MapSystem.riverFactor）验收。
// 2026-11 画面重构：地形从"地图数据推出来的一张高度场"建，画面和 MapSystem.heightAt 读同一份。
// 断言钉形状，不钉具体高度：可走区平缓、岩壁 / 深渊方向对、河连续不断流、渡口浅、龙坑是石台、地图外没有边缘、结果确定。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { createSimulation } = await import('../src/simulation.js');
const { CONFIG } = await import('../src/data/Config.js');
const { buildTerrainField, terrainThemeOf } = await import('../src/data/terrainField.js');
const { T, done } = scoreboard('地形高度场 + 河道形状');

const C = CONFIG.terrain, G = C.ground, R = C.river, K = C.cliff;
const load = (id) => { const sim = createSimulation(); sim.mapSystem.loadMap(id); return sim.mapSystem; };

// ==================== 一、七张图都能建场，耗时有上限 ====================
const IDS = ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1', 'dominion_crystal_scar_v1',
  'summoners_rift_organic_v1', 'confluence_v1', 'demo_stylized_v1'];
const fields = {};
for (const id of IDS) {
  const ms = load(id);
  const t0 = performance.now();
  const f = ms.terrainField();
  const dt = performance.now() - t0;
  fields[id] = { ms, f };
  T(`建①-${id}：建得出高度场（${f?.nx}×${f?.ny}，${dt.toFixed(0)}ms）`, !!f && f.h.length === f.nx * f.ny && f.h.every(Number.isFinite));
  T(`建②-${id}：建场耗时 < 4 秒（切图时同步算，太慢会卡住）`, dt < 4000);
  T(`建③-${id}：MapSystem.terrainField() 有缓存（第二次拿到同一个对象）`, ms.terrainField() === f);
}

// ==================== 二、可走区平缓；岩壁 / 深渊方向对 ====================
for (const id of IDS) {
  const { ms, f } = fields[id];
  const theme = terrainThemeOf(ms.currentMap);
  const platMax = (ms.currentMap.heightZones?.plateauHeight ?? 20) * (G.plateauK ?? 1);
  const swing = G.rollAmp + G.bumpAmp + G.pathDip;
  let walkSum = 0, walkN = 0, walkMin = Infinity, walkMax = -Infinity, wallSum = 0, wallN = 0;
  for (let k = 0; k < f.h.length; k += 7) {
    if (f.river[k] > 0.02) continue;
    if (f.sd[k] < -f.cell * 2) { walkSum += f.h[k]; walkN++; walkMin = Math.min(walkMin, f.h[k]); walkMax = Math.max(walkMax, f.h[k]); }
    else if (f.sd[k] > K.width * 1.5) { wallSum += f.h[k]; wallN++; }
  }
  T(`坡①-${id}：可走区（河道以外）高度落在台地高度 ± 起伏幅度之内（${walkMin.toFixed(1)} ~ ${walkMax.toFixed(1)}）`,
    walkN > 0 && walkMin >= -swing - 1 && walkMax <= platMax + swing + 1);
  if (!wallN) continue;
  const walkAvg = walkSum / walkN, wallAvg = wallSum / wallN;
  if (f.mode === 'rise') {
    T(`坡②-${id}（岩壁图）：不可走区隆起成岩壁（墙体平均 ${wallAvg.toFixed(0)} > 可走区 ${walkAvg.toFixed(0)} + 半个崖高）`,
      wallAvg > walkAvg + (theme.cliffHeight ?? K.height) * 0.5);
  } else {
    T(`坡②-${id}（深渊图）：不可走区下沉（墙体平均 ${wallAvg.toFixed(0)} < 可走区 ${walkAvg.toFixed(0)} − 1/3 下沉深度）`,
      wallAvg < walkAvg - (theme.dropHeight ?? 50) / 3);
  }
}

// ==================== 三、河：连续不断流，渡口浅，龙坑是湖心石台 ====================
{
  const { ms, f } = fields.summoners_rift_v1;
  const W = f.W, lvl = f.waterLevel;
  T('河①-召唤师峡谷有河，水面高度来自 CONFIG.terrain.river.level', f.hasRiver && lvl === R.level);
  // 沿河轴（x=y）走一遍：除了两个坑的石台，处处都是河
  const pits = f.pits;
  let gaps = 0, n = 0;
  for (let t = 60; t < W - 60; t += 25) {
    if (pits.some((p) => Math.hypot(t - p.x, t - p.y) < p.r * 1.2)) continue;
    n++; if (ms.riverFactor(t, t) < 0.5) gaps++;
  }
  T(`河②-河沿对角线贯穿全图，不被兵线切断（抽样 ${n} 处，断流 ${gaps} 处）`, n > 50 && gaps === 0);
  T('河③-河流出地图之后还在（延伸世界的山谷里继续流，没有"地图边缘"）', ms.riverFactor(-300, -300) > 0.5 && ms.riverFactor(W + 300, W + 300) > 0.5);
  // 三条兵线过河处：水浅（渡口），且确实有水
  const ankle = (R.level - R.fordBed) + 1.5;
  for (const lane of ms.currentMap.lanes) {
    let best = null;
    const wp = lane.waypoints;
    for (let i = 0; i + 1 < wp.length; i++) {
      const a = wp[i], b = wp[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let s = 0; s <= L; s += 8) {
        const x = a.x + (b.x - a.x) * s / L, y = a.y + (b.y - a.y) * s / L, rf = ms.riverFactor(x, y);
        if (!best || rf > best.rf) best = { x, y, rf };
      }
    }
    const depth = lvl - ms.heightAt(best.x, best.y);
    T(`河④-${lane.id} 路过河处有水（河道强度 ${best.rf.toFixed(2)}）`, best.rf > 0.8);
    T(`河⑤-${lane.id} 路过河处是浅滩渡口（水深 ${depth.toFixed(1)}，不超过"没过脚踝" ${ankle.toFixed(1)}）`, depth > 0 && depth <= ankle);
  }
  for (const p of pits) {
    T(`河⑥-${p.x > W / 2 ? '小龙坑' : '男爵坑'}台面高于水面（湖心石台，${ms.heightAt(p.x, p.y).toFixed(1)} > ${lvl}）`, ms.heightAt(p.x, p.y) > lvl);
  }
  // 野地里没有莫名其妙的水洼：河道之外的地面不低于水面
  let puddles = 0;
  for (let k = 0; k < f.h.length; k += 5) if (f.river[k] === 0 && f.h[k] < lvl) puddles++;
  T(`河⑦-河道之外的地面不低于水面（不会冒出没来由的一摊水，违例 ${puddles} 格）`, puddles === 0);
  T('河⑧-没有河的图不建水面（扭曲丛林 waterLevel 为 null）', fields.twisted_treeline_v1.f.waterLevel === null && !fields.twisted_treeline_v1.f.hasRiver);
}

// ==================== 四、地图之外：越远越高，没有边缘 ====================
for (const id of ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1', 'dominion_crystal_scar_v1']) {
  const { f } = fields[id];
  // 从左上角往外（避开对角线上的河谷）
  const ray = (d) => f.heightAt(-d * 0.8, -d * 0.6 + f.H * 0.5);
  const near = ray(150), mid = ray(900), far = ray(1900);
  T(`外①-${id}：地图外越远越高（150 → 900 → 1900：${near.toFixed(0)} / ${mid.toFixed(0)} / ${far.toFixed(0)}）`, far > mid && far > near);
  let maxIn = -Infinity; for (let k = 0; k < f.h.length; k += 3) maxIn = Math.max(maxIn, f.h[k]);
  T(`外②-${id}：远处的山比图内最高处还高（被雾吃掉之前地平线是山，不是虚空）`, far > maxIn);
  T(`外③-${id}：高度场在地图外处处有定义（不是 NaN / 0）`, [-2000, -500, f.W + 500, f.W + 2400].every((x) => Number.isFinite(f.heightAt(x, f.H * 0.3))));
}

// ==================== 五、确定、一致 ====================
{
  const { ms, f } = fields.summoners_rift_v1;
  const f2 = buildTerrainField(ms);
  let diff = 0; for (let k = 0; k < f.h.length; k++) diff = Math.max(diff, Math.abs(f.h[k] - f2.h[k]));
  T(`定①-同一张图建两次，高度场逐格一致（最大差 ${diff}）`, diff === 0);
  let bad = 0;
  for (let j = 0; j < f.ny; j += 37) for (let i = 0; i < f.nx; i += 41) if (Math.abs(f.heightAt(i * f.cell, j * f.cell) - f.h[j * f.nx + i]) > 1e-4) bad++;
  T(`定②-heightAt 在格点上就是高度场的值（双线性取值没有偏移，违例 ${bad}）`, bad === 0);
  T('定③-MapSystem.heightAt 读的就是这张场（逻辑层和画面同一份数据）', ms.heightAt(1234.5, 2345.6) === f.heightAt(1234.5, 2345.6));
  ms.invalidateNav();
  T('定④-换位图（invalidateNav）后高度场重建', ms.terrainField() !== f);
  const flat = createSimulation().mapSystem; flat.currentMap = null;
  T('定⑤-没有地图时 heightAt 返回 0，不报错', flat.heightAt(10, 10) === 0);
}

// ==================== 六、编辑器入口（第 2 条铁律：新数值要在编辑器里可改）====================
{
  const { EDITOR_PAGES_GAMEPLAY_WORLD: P0 } = await import('../src/ui/editor/pagesGameplayWorld.js').then((m) => ({ EDITOR_PAGES_GAMEPLAY_WORLD: Object.values(m)[0] }));
  const P = P0;
  const F = P._RENDER_TUNING_FIELDS;
  T('编①-字段表里每一项都对得上 CONFIG 里真实存在的数值', F.length > 20 && F.every((f) => typeof P._getPath(CONFIG, f.path) === 'number'));
  T('编②-地形高度场的关键参数都有入口（路 / 河 / 龙坑 / 岩壁 / 深渊 / 地图外 / 分辨率）',
    ['terrain.ground.pathHalf', 'terrain.river.level', 'terrain.river.fordBed', 'terrain.pit.floor', 'terrain.cliff.height', 'terrain.drop.width', 'terrain.outer.peakHeight', 'terrain.field.targetN']
      .every((p) => F.some((f) => f.path === p)));
  const calls = { invalidate: 0, aa: 0 };
  const fakeR = { aaOn: true, invalidateTerrain: () => calls.invalidate++, setAA: () => calls.aa++, sky: { _key: 'x' },
    ssaoPass: { aoMat: { uniforms: { radius: { value: 0 } } }, compMat: { uniforms: { aoStrength: { value: 0 } } } } };
  window.CTX = { __three: fakeR };
  const keep = { level: CONFIG.terrain.river.level, samples: CONFIG.postfx.aa.samples, radius: CONFIG.postfx.ssao.radius, fov: CONFIG.ui.camera.fovDeg, sky: CONFIG.ui.sky.intensity };
  const inp = (path, value) => ({ value: String(value), dataset: { path } });
  const n1 = P._applyRenderTuning([inp('terrain.river.level', keep.level - 1), inp('ui.camera.fovDeg', keep.fov)]);
  T('编③-只写真正改了的项（视场角没改，不算）', n1 === 1 && CONFIG.terrain.river.level === keep.level - 1);
  T('编④-改了地形参数会触发地形整体重建', calls.invalidate === 1);
  P._applyRenderTuning([inp('postfx.aa.samples', keep.samples + 2), inp('postfx.ssao.radius', keep.radius + 3)]);
  T('编⑤-改了抗锯齿采样数会刷新渲染目标，但不重建地形', calls.aa === 1 && calls.invalidate === 1);
  T('编⑥-SSAO 半径直接写进着色器 uniform（它只在构造时读一次配置）', fakeR.ssaoPass.aoMat.uniforms.radius.value === keep.radius + 3);
  P._applyRenderTuning([inp('ui.sky.intensity', CONFIG.ui.sky.intensity + 0.1)]);
  T('编⑦-改了天空参数会让天空下一帧重算（清掉缓存键）', fakeR.sky._key === '');
  T('编⑧-非数字输入被忽略', P._applyRenderTuning([inp('terrain.river.level', 'abc')]) === 0);
  CONFIG.terrain.river.level = keep.level; CONFIG.postfx.aa.samples = keep.samples; CONFIG.postfx.ssao.radius = keep.radius;
  CONFIG.ui.sky.intensity = keep.sky;
}

done();
