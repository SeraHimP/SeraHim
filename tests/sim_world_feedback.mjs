// 2026-11 画面反馈批次（用户实机看过写实版之后的一轮意见），钉住每一条的"形状"：
//   · 火焰方向不跟视角走；兵线虚线贴着地形走（它被起伏的地面吃成一段段，被看成了"路面黑缝"）；
//   · 红方塔和蓝方塔同一副骨架、塔芯不发光；破损要一眼看得出；废墟要矮、不悬空；
//   · 火炬真的照亮路面，光带方向；龙坑不再是石台、塔脚不铺石板；河两岸没有整条白边；
//   · 嚎哭深渊：两块悬崖实地 + 一道峡谷 + 一座真正悬空的石桥；冰原 / 沙漠不种树；扭曲丛林是紫色的、树干是拧的；
//   · 水晶之痕：每个据点按名字立一组场景物（风车 / 钻机 / 兽骨场 / 采石场 / 精炼厂 + 商栈 / 望塔）、归属旗、砂岩巨岩。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { citadelTower } = await import('../src/presentation/buildingModels.js');
const { partsBox } = await import('../src/presentation/towerStatue.js');
const { deckOutline, bridgeLayout } = await import('../src/presentation/world/WorldBridge.js');
const { placeSpires } = await import('../src/presentation/world/WorldMist.js');
const { treeGeometry } = await import('../src/presentation/world/WorldFoliage.js');
const { SCENES, dominionSites, placeMonoliths, buildWorldDominion } = await import('../src/presentation/world/WorldDominion.js');
const { mergeParts } = await import('../src/presentation/UnitMeshFactory.js');
const { RESOURCE_COLORS } = await import('../src/core/resourceBar.js');
const { T, done } = scoreboard('画面反馈批次：火焰 / 塔 / 照明 / 河 / 深渊石桥 / 地图主题');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const TH = CONFIG.terrain.themes;

// ==================== 一、火焰与兵线虚线 ====================
{
  const wl = src('presentation/world/WorldLights.js'), fx = src('presentation/EffectsLayer.js');
  T('火①火苗的面片只绕竖轴转向相机（横轴 = 相机右方向压到水平面，竖轴 = 世界的上），不整张贴在屏幕上',
    /vec3 right = normalize\(vec3\(camR\.x, 0\.0, camR\.z\)/.test(wl) && /aFlame\.xyz \+ right \* p\.x \+ vec3\(0\.0, p\.y, 0\.0\)/.test(wl));
  T('火②风把火苗吹歪用的是世界里的风向（与视角无关），幅度在 CONFIG.terrain.lights.flameLean', /vec3\(uWWind\.x, 0\.0, uWWind\.y\) \* lean/.test(wl) && CONFIG.terrain.lights.flameLean.length === 2);
  T('线①静态参照层的贴地图元跟着地形高度走（hAt），不再躺在 y = 0 上被起伏的地面吃掉',
    /const h = this\.hAt;\s*if \(h\) this\._tri3\(ax, h\(ax, az\), az/.test(fx) && /B\.hAt = mapSystem\?\.heightAt \?/.test(fx));
  T('线②兵线虚线的样子在 CONFIG.ui.lanePathLine（软编码）', CONFIG.ui.lanePathLine.width > 0 && CONFIG.ui.lanePathLine.dash > 0 && /LP\.width \?\? 3/.test(fx));
}

// ==================== 二、双方防御塔 ====================
{
  const R = 32, blue = citadelTower(R, 'blue'), red = citadelTower(R, 'red');
  const ids = (t) => [...t.model.pieces.keys()].filter((id) => !id.startsWith('deb'));
  const bi = ids(blue), ri = ids(red);
  T(`塔①红方塔和蓝方塔是同一副骨架（部件清单只多出台脚的碎岩：蓝 ${bi.length} / 红 ${ri.length}）`,
    bi.every((id) => ri.includes(id)) && ri.filter((id) => !bi.includes(id)).every((id) => id.startsWith('spur')));
  const glow = (t) => ids(t).filter((id) => t.model.pieces.get(id).parts.some((p) => p.mat === 'glow'));
  T(`塔②红方塔芯不发光：发光的只有四道窄窗（${glow(red).join(',')}），和蓝方一样`, glow(red).length === 4 && glow(red).every((id) => id.startsWith('slit')) && glow(blue).join() === glow(red).join());
  T('塔③红方不是换色：垛口 / 爪 / 旗的几何和蓝方不同',
    ['mer0', 'claw0', 'flag1', 'shield0'].every((id) => red.model.pieces.get(id).parts.map((p) => p.geo.attributes.position.count).join() !== blue.model.pieces.get(id).parts.map((p) => p.geo.attributes.position.count).join()));
  for (const [name, t] of [['蓝', blue], ['红', red]]) {
    const [, s1, s2] = t.stages, all = ids(t).length;
    T(`损①-${name}方：轻损 / 重损掉的部件一档比一档多，重损掉了三成以上（${s1.length} → ${s2.length} / ${all}）`, s1.length >= 12 && s2.length > s1.length * 2 && s2.length >= all * 0.3 && s1.every((id) => s2.includes(id)));
    T(`损②-${name}方：轻损就改轮廓（断一只爪、少垛口、塌一道扶壁），重损再塌一段冠台和腰箍、只剩两只爪`,
      s1.some((id) => id.startsWith('claw')) && s1.some((id) => id.startsWith('fin')) && s1.filter((id) => id.startsWith('mer')).length >= 2
      && s2.some((id) => id.startsWith('corbel')) && s2.some((id) => id.startsWith('belt')) && s2.filter((id) => id.startsWith('claw')).length === 2);
    // 伤集中在同一侧：轻损掉的石块，方位角大多落在同一个半圈里
    const ang = s1.filter((id) => /^[cu]\d_/.test(id)).map((id) => { const c = new THREE.Vector3(); partsBox(t.model.pieces.get(id).parts).getCenter(c); return Math.atan2(c.z, c.x); });
    const side = ang.filter((a) => a > Math.PI * 0.4 && a < Math.PI * 1.1).length;
    T(`损③-${name}方：轻损掉的石块集中在同一侧（${side} / ${ang.length}），不是东一块西一块`, side >= ang.length * 0.7);
    const full = partsBox(t.model.parts([])).max.y, ruinTop = partsBox(t.ruin).max.y;
    T(`墟①-${name}方：废墟是矮矮的一堆（高 ${(ruinTop / R).toFixed(2)}R，不到塔高 ${(full / R).toFixed(2)}R 的三分之一）`, ruinTop < full / 3 && ruinTop > t.keepBelow);
  }
  const K = CONFIG.ui.citadel;
  T('墟②落点往脚下最低处贴（lowK）、后落的几乎不垫高（stack 小）：堆不起来、也不悬空；参数在 CONFIG.ui.citadel',
    K.collapse.lowK >= 0.5 && K.collapse.stack <= 0.15 && K.ruin.moundHeight <= 0.3 && K.ruin.stumpHeight <= 0.35
    && /g = lo \* lowK \+ g \* \(1 - lowK\)/.test(src('presentation/towerStatue.js')));
}

// ==================== 三、照明 ====================
{
  const L = CONFIG.terrain.lights, S = CONFIG.terrain.shading, G = CONFIG.terrain.ground, ws = src('presentation/world/worldShading.js');
  const F = L.falloff, at = (t) => { for (let i = 1; i < F.length; i++) if (t <= F[i][0]) { const k = (t - F[i - 1][0]) / (F[i][0] - F[i - 1][0]); return F[i - 1][1] + (F[i][1] - F[i - 1][1]) * k; } return 0; };
  T('光①火炬光的衰减是软编码的一条单调曲线：从 1 降到 0', F[0][1] === 1 && F[F.length - 1][1] === 0 && F.every((p, i) => i === 0 || (p[0] > F[i - 1][0] && p[1] <= F[i - 1][1])));
  const toMid = G.pathHalf + L.shoulder;   // 火炬立在路肩外，到路中间的距离
  T(`光②火炬照得到路中间：离火炬 ${toMid} 处还有 ${(at(toMid / L.torchRadius) * 100).toFixed(0)}% 的亮度（原来 4%）`, at(toMid / L.torchRadius) >= 0.15);
  T('光③夜里局部光比白天强得多（白天日光下几乎看不出）', S.lightNight >= S.lightDay * 6);
  T('光④局部光带方向：由光照图的亮度梯度估出光从哪边来，朝光的面亮、背光的面暗；斜的程度看相对梯度（不出亮环）',
    /vec3 wLocalLightN\(vec3 p, vec3 n\)/.test(ws) && /gl \/ max\(l0, 0\.03\)/.test(ws) && /float ndl = clamp\(dot\(normalize\(n\), L\)/.test(ws));
  T('光⑤叶片 / 草这类薄片不按法线分明暗（lightDir: false），其余材质按法线', /opts\.lightDir === false \? 'wLocalLight\(vWPos\)'/.test(ws)
    && /lightDir: false/.test(src('presentation/world/WorldFoliage.js')) && /wLocalLightN\(vWPos, wn\)/.test(src('presentation/world/WorldTerrain.js')));
  T('光⑥水晶照亮的范围比一支火炬大', L.crystal.towerRadius >= L.torchRadius && L.crystal.gemRadius > L.crystal.orbRadius && L.crystal.orbRadius > L.crystal.towerRadius);
}

// ==================== 四、峡谷：龙坑、塔脚、河 ====================
const sims = {};
const fieldOf = (id) => { if (!sims[id]) { const sim = createSimulation(); sim.mapSystem.loadMap(id); sims[id] = { ms: sim.mapSystem, f: sim.mapSystem.terrainField() }; } return sims[id]; };
{
  const { f } = fieldOf('summoners_rift_v1'), P = CONFIG.terrain.paving, R = CONFIG.terrain.river;
  T('铺①塔脚不铺石板圆盘、龙坑不铺石台（structK / pitK = 0），基地广场仍然铺', P.structK === 0 && P.pitK === 0 && P.baseK > 0);
  const pit = f.pits[0];
  const hc = f.heightAt(pit.x, pit.y);
  T(`坑①龙坑是一片刚露出水面的浅滩（中心高 ${hc.toFixed(1)}，水面 ${R.level}），不是高出地面的台子`, hc > R.level && hc < 1.5);
  // 沿 24 个方向量滩的边（高度落到水面的地方）：一圈下来不一样远，不是正圆
  const rs = [];
  for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; let r = 0; while (r < pit.r * 2 && f.heightAt(pit.x + Math.cos(a) * r, pit.y + Math.sin(a) * r) > R.level) r += 3; rs.push(r); }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  T(`坑②滩的轮廓不规则（各方向半径 ${Math.min(...rs)} ~ ${Math.max(...rs)}，差 ${((Math.max(...rs) - Math.min(...rs)) / mean * 100).toFixed(0)}%）`, (Math.max(...rs) - Math.min(...rs)) / mean > 0.2);
  const ww = src('presentation/world/WorldWater.js'), W = CONFIG.terrain.water;
  T('河①两岸没有那条恒定的白边了：泡沫只剩被波纹打碎的零星几缕，浓度可调', !/\* 0\.7\);\s*\n\s*float ring/.test(ww) && !/foam = max\(foam,/.test(ww) && W.foam <= 0.5);
  T('河②岸线是淡出去的：最浅处几乎全透明，越深越不透明', W.alphaMin <= 0.15 && W.alphaMax >= 0.8 && /smoothstep\(-0\.1, uWaterS\.w, vDepth\)/.test(ww));
  T('河③水面有顺着流向走的亮纹（水在流）', /float streak = /.test(ww) && /dot\(vWPos\.xz, fdir\)/.test(ww) && W.streak > 0 && W.streakSpeed > 0);
  T('河④河面参数都在 CONFIG.terrain.water（软编码）', ['cell', 'outerReach', 'clarity', 'alphaMin', 'alphaMax', 'shoreFade', 'foam', 'foamWidth', 'streak', 'flowSpeed', 'roughness'].every((k) => Number.isFinite(W[k])));
}

// ==================== 五、嚎哭深渊：两块悬崖 + 峡谷 + 石桥 ====================
{
  const { ms, f } = fieldOf('howling_abyss_frost_v1'), th = TH.frost, LM = th.landmass;
  T('渊①冰原声明了陆块，高度场认得（landAt / hTerrain / terrainHeightAt）', !!f.landmass && typeof f.landAt === 'function' && f.hTerrain !== f.h);
  const [b0, b1] = f.bases.map((b) => b.c), len = Math.hypot(b1.x - b0.x, b1.y - b0.y), ux = (b1.x - b0.x) / len, uy = (b1.y - b0.y) / len;
  const on = (s, o = 0) => ({ x: b0.x + ux * s - uy * o, y: b0.y + uy * s + ux * o });
  T('渊②两个基地都在实地上', f.bases.every((b) => f.landAt(b.c.x, b.c.y).L === 1));
  const mid = on(len / 2);
  T(`渊③桥中间：逻辑高度是桥面（${f.heightAt(mid.x, mid.y).toFixed(1)}），画出来的地形在桥下是峡谷（${f.terrainHeightAt(mid.x, mid.y).toFixed(0)}）—— 桥是悬空的`,
    ms.isWalkable(mid.x, mid.y) && f.landAt(mid.x, mid.y).L === 0 && Math.abs(f.heightAt(mid.x, mid.y)) < 2 && f.terrainHeightAt(mid.x, mid.y) < -th.dropHeight * 0.8);
  // 桥边：可走区最外沿的逻辑高度仍是桥面（单位不会陷下去）
  let edge = 0; while (ms.isWalkable(on(len / 2, edge + 4).x, on(len / 2, edge + 4).y)) edge += 4;
  const e = on(len / 2, edge);
  T(`渊④站在桥边（离中线 ${edge}）不会往下陷：那里的逻辑高度还是 ${f.heightAt(e.x, e.y).toFixed(1)}`, Math.abs(f.heightAt(e.x, e.y)) < 2);
  // 基地周围的不可走区：实地，不下沉
  let landWall = 0, sunk = 0;
  for (let k = 0; k < f.h.length; k += 5) {
    if (f.sd[k] < 30) continue;
    const x = (k % f.nx) * f.cell, y = Math.floor(k / f.nx) * f.cell;
    if (f.landAt(x, y).L < 1) continue;
    landWall++; if (f.hTerrain[k] < -5) sunk++;
  }
  T(`渊⑤基地周围的不可走区是实地（${landWall} 个采样里下沉的 ${sunk} 个）：基地不是立在深渊里的孤岛`, landWall > 500 && sunk === 0);
  // 峡谷一直延伸到地图外面
  const out = on(len / 2, 2600);
  T(`渊⑥峡谷往两头延伸到地图外面（桥中线外 2600 处地形 ${f.terrainHeightAt(out.x, out.y).toFixed(0)}）`, (out.x < 0 || out.y < 0 || out.x > f.W || out.y > f.H) && f.terrainHeightAt(out.x, out.y) < -th.dropHeight * 0.6);
  const behind = on(-900);
  T('渊⑦基地背后（地图外）是往上长的雪山，不是深渊', f.terrainHeightAt(behind.x, behind.y) > 20);

  const B = th.bridge, dk = deckOutline(f, B);
  let bad = 0;
  for (const [x, z] of dk.top) if (f.sdAt(x, z) > B.over + dk.step * 1.5 || f.landAt(x, z).L > 0.999) bad++;
  T(`桥①桥面沿可走区的轮廓铺（${dk.top.length / 3} 个三角形，越界的顶点 ${bad} 个），只铺在峡谷上空`, dk.top.length > 3000 && bad === 0);
  T(`桥②桥面有一圈轮廓（${dk.edges.length} 段），每段都带朝外的方向`, dk.edges.length > 200 && dk.edges.every((s) => Math.abs(Math.hypot(s[4], s[5]) - 1) < 1e-6));
  // 桥面盖住了峡谷上空全部的可走区
  let hole = 0, tot = 0;
  const g = B.cell;
  const covered = new Set(); for (const [x, z] of dk.top) covered.add(Math.round(x / g) + ',' + Math.round(z / g));
  for (let s = f.landmass.cliffDist + 80; s < len - f.landmass.cliffDist - 80; s += 37) for (let o = -120; o <= 120; o += 40) {
    const p = on(s, o); if (!ms.isWalkable(p.x, p.y)) continue; tot++;
    if (!covered.has(Math.round(p.x / g) + ',' + Math.round(p.y / g)) && !covered.has(Math.floor(p.x / g) + ',' + Math.floor(p.y / g)) && !covered.has(Math.ceil(p.x / g) + ',' + Math.ceil(p.y / g))) hole++;
  }
  T(`桥③桥面没有窟窿（峡谷上空 ${tot} 个可走采样点都在桥面里）`, tot > 100 && hole === 0);
  const lay = bridgeLayout(f, B);
  T(`桥④桥下是连拱：${lay.piers.length} 座桥墩、${lay.spans.length} 跨，墩和跨首尾相接、拱有矢高（${lay.rise.toFixed(0)}）`,
    lay.piers.length === B.piers && lay.spans.length === B.piers + 1 && lay.rise > 40
    && lay.piers.every((p, i) => Math.abs(p[0] - lay.spans[i][1]) < 1e-6 && Math.abs(p[1] - lay.spans[i + 1][0]) < 1e-6));
  T('桥⑤桥下结构比桥面窄（藏在檐下），拱脚伸进两边的崖体', lay.half > 40 && lay.spans[0][0] < lay.s0 && lay.spans[lay.spans.length - 1][1] > lay.s1);
  const single = bridgeLayout(f, { ...B, piers: 0 });
  T('桥⑥piers = 0 时没有桥墩，整座桥一跨悬空（可调，不用改代码）', single.piers.length === 0 && single.spans.length === 1);
  T('桥⑦雾：越深越浓（top 高于 bottom），几层流动的雾从上到下一层比一层浓',
    th.abyssFog.top > th.abyssFog.bottom && th.abyssFog.k > 0.9 && th.abyssMist.layers.length >= 2
    && th.abyssMist.layers.every((l, i, a) => i === 0 || (l.y < a[i - 1].y && l.alpha >= a[i - 1].alpha)));
  T('地①冰原的基地是正常的地面：不铺石板广场、踩出来的路是冻土（dirt）不是石板', th.paving.baseK === 0 && th.layers.path.kind === 'dirt' && th.layers.ground.kind === 'snow');
  const sp = placeSpires(f, th.spires);
  T(`地②冰棱只立在实地的不可走区，不超过上限（${sp.length} / ${th.spires.max}）`, sp.length > 10 && sp.length <= th.spires.max && sp.every((o) => f.landAt(o.x, o.y).L === 1 && f.sdAt(o.x, o.y) >= th.spires.walkClear));
  void LM;
}

// ==================== 五·二、水晶之痕：每个据点按名字立一组场景物 ====================
{
  const { ms, f } = fieldOf('dominion_crystal_scar_v1'), map = ms.currentMap, D = CONFIG.terrain.dominion;
  const pts = map.dominionNodes.filter((n) => n.kind === 'point');
  const names = Object.fromEntries(pts.map((n) => [n.id, n.name]));
  T(`据①原版水晶之痕的五个据点都在，各有一组场景物：${['windmill', 'drill', 'boneyard', 'quarry', 'refinery'].map((k) => names[k]).join(' / ')}`,
    ['windmill', 'drill', 'boneyard', 'quarry', 'refinery'].every((k) => names[k] && typeof SCENES[k] === 'function'));
  T(`据②这张图自己的两个据点（${names.blue_base} / ${names.red_base}）也有场景物；七个据点一个不落`, pts.length === 7 && pts.every((n) => typeof SCENES[n.id] === 'function'));
  const sites = dominionSites(map);
  T('据③场景物摆在据点朝外的一侧、落在可走的空地上、躲开环形走廊（离兵线中线比走廊半宽远）',
    sites.points.every((s) => s.scene && f.sdAt(s.px, s.py) < -10 && f.laneAt(s.px, s.py) > 150 && (s.px - s.x) * s.ax + (s.py - s.y) * s.ay > 0));
  // 每组场景物是个像样的"场景"：几百个顶点以上、有高度、各不相同
  const sig = [];
  let small = 0;
  for (const id of Object.keys(SCENES)) {
    const sc = SCENES[id](), g = mergeParts(sc.parts); g.computeBoundingBox();
    const b = g.boundingBox; sig.push(g.attributes.position.count + ':' + Math.round(b.max.y));
    if (g.attributes.position.count < 500 || b.max.y < 35 || b.min.y < -4) small++;
  }
  T(`据④七组场景物各不相同、都有体量（顶点数:高度 ${sig.join(' ')}）`, new Set(sig).size === 7 && small === 0);
  T('据⑤风车的风轮和钻机的钻杆是单独的、会转的部件', SCENES.windmill().spin.length === 1 && SCENES.windmill().spin[0].axis === 'x' && SCENES.drill().spin.length === 1 && SCENES.drill().spin[0].axis === 'y');
  T('据⑥水晶枢纽两侧各一面战旗', sites.nexus.length === 2 && sites.nexus.every((n) => n.flags.length === 2 && ['blue', 'red'].includes(n.faction)));
  const mono = placeMonoliths(f);
  T(`岩①砂岩巨岩只立在不可走的沙地里，整块离可走区有一段距离，不超过上限（${mono.length} / ${D.monoliths.max}）`,
    mono.length >= 8 && mono.length <= D.monoliths.max && mono.every((o) => f.sdAt(o.x, o.y) >= o.r + D.monoliths.walkClear - 1e-6));
  // 归属旗跟着占领状态变色
  const world = buildWorldDominion(f, TH.desert, null);
  const hex = (c) => '#' + c.getHexString();
  const node = pts[0], fl = world.flags.find((q) => q.x === node.pos.x && q.y === node.pos.y);
  const fake = (owner) => ({ deps: { entities: { getAllTowers: () => [{ isCapturePoint: true, pos: { x: node.pos.x, y: node.pos.y }, _captureOwner: owner }] } }, time: 3 });
  world.update(fake(null)); const c0 = hex(fl.banner.material.color);
  world.update(fake('blue')); const c1 = hex(fl.banner.material.color);
  world.update(fake('red')); const c2 = hex(fl.banner.material.color);
  T(`旗①每个据点一面归属旗（${world.flags.length} 面），颜色跟着占领状态走：中立 ${c0} → 蓝 ${c1} → 红 ${c2}`,
    world.flags.length === 7 && c0 === hex(new THREE.Color(RESOURCE_COLORS.capture_neutral)) && c1 === hex(new THREE.Color(RESOURCE_COLORS.capture_blue)) && c2 === hex(new THREE.Color(RESOURCE_COLORS.capture_red)));
  T('旗②只改那一面旗（别的据点的旗不跟着变）', world.flags.filter((q) => q !== fl).every((q) => hex(q.banner.material.color) === c0));
  T(`景①建出来的数量对得上：${JSON.stringify(world.counts)}`, world.counts.scenes === 7 && world.counts.nexusFlags === 4 && world.counts.spinners === 2);
  T('景②没有 dominionNodes 的地图什么都不建', buildWorldDominion(fieldOf('summoners_rift_v1').f, TH.forest, null) === null);
  {
    const { SCENE_IDS, dominionKeepOut } = await import('../src/data/dominionSites.js');
    T('景④位置数据（data/dominionSites）和造型（WorldDominion.SCENES）登记的是同一批据点', SCENE_IDS.slice().sort().join() === Object.keys(SCENES).sort().join());
    // 场景物有一半探出可走的台面：脚下的地垫平了，不悬空
    const pads = dominionKeepOut(map);
    let low = 0, n = 0;
    for (const k of pads) for (let a = 0; a < 12; a++) { const x = k.x + Math.cos(a / 12 * 6.283) * k.r * 0.9, y = k.y + Math.sin(a / 12 * 6.283) * k.r * 0.9; n++; if (f.heightAt(x, y) < -8) low++; }
    T(`景⑤场景物脚下的地是垫平的（${pads.length} 处、${n} 个采样点里下沉的 ${low} 个）`, pads.length === 7 && low === 0);
  }
  T('景③摆放参数在 CONFIG.terrain.dominion（软编码）', D.propOffset > 140 && D.flagPole > 0 && D.flagSize.length === 2 && D.monoliths.radius.length === 2);
  world.dispose();
}

// ==================== 六、每张地图自己的语言 ====================
{
  T('树①冰原和沙漠不种树（外围不再是清一色的树林）', TH.frost.foliage.trees === false && TH.desert.foliage.trees === false);
  const leaf = new THREE.Color(TH.magicForest.foliage.tree.leaf.light), grass = new THREE.Color(TH.magicForest.layers.ground.palette.mid);
  T('树②扭曲丛林是紫色的：树冠和草地都是红蓝压过绿', leaf.r > leaf.g && leaf.b > leaf.g && grass.b > grass.g && grass.r > grass.g * 0.9);
  const fleaf = new THREE.Color(TH.forest.foliage?.tree?.leaf?.light || '#5c8c30');
  T('树③召唤师峡谷仍是绿林（两张森林图不是同一套颜色）', fleaf.g > fleaf.r && fleaf.g > fleaf.b);
  // 拧着长的树干：树冠的重心被带偏
  const cx = (g) => { const p = g.canopy.attributes.position; let sx = 0, sz = 0; for (let i = 0; i < p.count; i++) { sx += p.getX(i); sz += p.getZ(i); } return Math.hypot(sx / p.count, sz / p.count); };
  const straight = treeGeometry(1, 70, {}, false), twisted = treeGeometry(1, 70, { twist: TH.magicForest.foliage.tree.shape.twist }, false);
  T(`树④扭曲丛林的树干是拧的（树冠重心偏出 ${cx(twisted).toFixed(1)}，直树 ${cx(straight).toFixed(1)}）`, TH.magicForest.foliage.tree.shape.twist > 0 && cx(twisted) > cx(straight) * 2);
  T('树⑤扭曲丛林的火炬是幽蓝的灵火、花会发光', new THREE.Color(TH.magicForest.torch.flame).b > new THREE.Color(TH.magicForest.torch.flame).r && TH.magicForest.cover.flowerGlow > 0);
}

done();
