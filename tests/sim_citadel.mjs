// 写实造型（buildingModels.js）：防御塔 / 召唤水晶 / 水晶枢纽，每方一套；连贯倒塌（部件塌成废墟，废墟不从地下冒出来）。
// 用户："塔只需要做两种模型，蓝方/红方……某一方所有塔的模型都是一样的不需要再做区分了"；
//       "我要求塔/塔掉落的块/废墟的模型的动画是相互关联的"；
//       "倒塌的模型可以消失一部分块，还是要原来废墟的那样的损毁模型"。
// 断言钉形状：每方一套、不分档；基座以上全是部件；废墟 = 基座 + 碎石丘 + 落在丘上的部件；倒塌动画的起点是原位、终点正好是废墟里的位置。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { citadelTower, citadelShrine, citadelColors } = await import('../src/presentation/buildingModels.js');
const { partsBox } = await import('../src/presentation/towerStatue.js');
const { towerMesh, buildingPiecesOf, buildingStyleOf, mergeParts } = await import('../src/presentation/UnitMeshFactory.js');
const { modeOf, collapsePose, fallPose, BuildingFx } = await import('../src/presentation/buildingFx.js');
const { surfaceParams } = await import('../src/presentation/unitSurface.js');
const { T, done } = scoreboard('写实建筑造型 + 连贯倒塌');

T('默认造型是写实（citadel）：防御塔 / 召唤水晶 / 水晶枢纽', buildingStyleOf('tower') === 'citadel' && buildingStyleOf('orb') === 'citadel' && buildingStyleOf('gem') === 'citadel');
{
  const C = CONFIG.ui.citadel;
  T('配色、废墟、堆法都在 CONFIG.ui.citadel（软编码）', ['blue', 'red', 'neutral'].every((f) => C.colors[f].stone && C.colors[f].trim && C.colors[f].glow)
    && C.ruin.tint > 0 && C.ruin.moundHeight > 0 && C.ruin.spread > 0 && C.ruin.pieceScale > 0 && C.collapse.sink >= 0 && C.rubbleDist.length === 2);
  T('蓝红两方配色不同', citadelColors('blue').stone !== citadelColors('red').stone && citadelColors('blue').glow !== citadelColors('red').glow);
}
const F = { stone: '#b9c6d6', trim: '#eaf2fd' };
const same = buildingPiecesOf('tower', 32, 'outer', 'blue', F) === buildingPiecesOf('tower', 32, 'hq_tower', 'blue', F);
T('同一方的防御塔不分档位：外塔和枢纽塔拿到的是同一个模型', same);

const eqM = (a, b, eps = 1e-4) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < eps * Math.max(1, Math.abs(v)));
const DEFS = [['tower', 32, (f) => citadelTower(32, f)], ['orb', 34, (f) => citadelShrine('orb', 34, f)], ['gem', 57, (f) => citadelShrine('gem', 57, f)]];
const NAME = { tower: '防御塔', orb: '召唤水晶', gem: '水晶枢纽' };
for (const [kind, R, make] of DEFS) {
  for (const fac of ['blue', 'red']) {
    const tag = `${fac === 'blue' ? '蓝' : '红'}方${NAME[kind]}`;
    const b = make(fac), m = b.model;
    T(`${tag}：建得出来，部件够多（${m.order.length} 块）`, m.order.length >= 20 && m.base.length >= 2);
    T(`${tag}：三档损毁清单逐档累加、不重名、都是真部件`, b.stages.length === 3 && b.stages[0].length === 0 && b.stages[1].length >= 3
      && b.stages[2].length > b.stages[1].length && b.stages[1].every((id) => b.stages[2].includes(id))
      && new Set(b.stages[2]).size === b.stages[2].length && b.stages[2].every((id) => m.pieces.has(id)));
    // 基座以上全是部件：主体（不登记成部件的）都不高过"留下的基座"
    T(`${tag}：基座以上全是部件（倒塌时没有哪块会留在半空）`, m.base.every((p) => partsBox([p]).max.y <= b.keepBelow + 1e-6));
    const all = partsBox(m.parts([]));
    T(`${tag}：水晶在建筑上方、整颗悬着`, b.crystalR > R * 0.2 && b.crystalCy > b.keepBelow + b.crystalR && b.crystalCy < all.max.y + b.crystalR * 3);
    const cg = b.crystalGeo();
    T(`${tag}：水晶有自己的几何（双尖晶柱）`, cg.attributes.position.count >= 30);
    // 材料：每个零件的材料名都认得
    const mats = new Set(m.parts([]).map((p) => p.mat));
    T(`${tag}：用了不止一种材料（石 / 金属 / 布 / 发光……）`, mats.size >= 3 && [...mats].every((k) => surfaceParams(k).length === 4));
    // ---- 废墟 ----
    const fallen = new Set(b.stages[2]);
    T(`${tag}：掉档时掉下去的部件早就消失了，废墟里没有它们`, b.stages[2].every((id) => !m._ruin.has(id)) && !b.ruin.some((p) => b.stages[2].some((id) => m.pieces.get(id).parts.some((q) => q.geo === p.geo))));
    const vanish = m.order.filter((id) => m.pieces.get(id).vanish && !fallen.has(id));
    T(`${tag}：有一部分大块在倒塌时碎没了（${vanish.length} 块），废墟里没有它们`, vanish.length >= 1 && vanish.length < m.order.length * 0.5);
    T(`${tag}：废墟带一座碎石丘`, b.ruinKit.mound.length >= 5 && (kind !== 'tower' || b.ruinKit.stump.length >= 1));
    const keptBase = m.base.filter((p) => partsBox([p]).max.y <= b.keepBelow).length;
    const pieceParts = m.order.filter((id) => !vanish.includes(id) && !fallen.has(id)).reduce((n, id) => n + m.pieces.get(id).parts.length, 0);
    T(`${tag}：废墟 = 留下的基座 + 碎石丘 + 断桩 + 没碎掉的部件（零件数对得上）`, b.ruin.length === keptBase + pieceParts + b.ruinKit.mound.length + b.ruinKit.stump.length);
    const rb = partsBox(b.ruin);
    T(`${tag}：废墟比完好时矮、不陷到地面以下、不散到很远`, rb.max.y < all.max.y * 0.8 && rb.min.y > -R * 0.35
      && Math.max(rb.max.x, -rb.min.x, rb.max.z, -rb.min.z) < R * 2.4);
    // ---- 连贯：倒塌动画的起点是原位，终点正好是废墟里的位置 ----
    const ids = m.order.filter((id) => !fallen.has(id)).slice(0, 12);
    T(`${tag}：倒塌一开始部件在原位（单位矩阵）`, ids.every((id) => eqM(collapsePose(m.ruinParams(id), 0, R, 1.3), new THREE.Matrix4())));
    T(`${tag}：倒塌播完部件正好落在废墟里的位置（换成静态废墟不会跳）`, ids.every((id) => eqM(collapsePose(m.ruinParams(id), 1, R, 1.3), m.ruinMatrix(id), 2e-3)));
    T(`${tag}：掉档动画播完部件正好落在塔脚（与静态碎块重合）`, b.stages[2].slice(0, 6).every((id) => eqM(fallPose(m.rubbleParams(id), 1, R, 0.7), m.rubbleMatrix(id), 2e-3)));
    const mid = ids.map((id) => new THREE.Vector3().setFromMatrixPosition(collapsePose(m.ruinParams(id), 0.5, R, 1.3)));
    T(`${tag}：倒塌途中每块的位置都是有限数`, mid.every((v) => Number.isFinite(v.x + v.y + v.z)));
    T(`${tag}：两次建出来的废墟一样（可复现）`, JSON.stringify(make(fac).ruin.map((p) => p.matrix.elements.map((v) => +v.toFixed(4)))) === JSON.stringify(b.ruin.map((p) => p.matrix.elements.map((v) => +v.toFixed(4)))));
    // ---- 进渲染：三档 + 废墟 ----
    const mk = (d, ruin) => towerMesh(`cit|${kind}|${fac}|${d}|${ruin}`, '#5b9bd5', R, '', kind, false, ruin, kind === 'tower' ? 'outer' : kind === 'orb' ? 'nexus_lane' : 'nexus_main', fac, d, {});
    const m0 = mk(0, false), m2 = mk(2, false), mr = mk(0, true);
    T(`${tag}：三档损毁炮口高度一致（水晶就是炮口，弹道原点不能跳）`, Math.abs(m0.muzzleY - m2.muzzleY) < 1e-6 && m0.crystal && m2.crystal);
    T(`${tag}：网格带材料属性 aMat（粗糙度 / 金属度 / 颗粒 / 自发光）`, m0.geo.attributes.aMat?.itemSize === 4);
    T(`${tag}：废墟没有攻击水晶${kind === 'orb' ? '（召唤水晶等重生时悬着几块碎晶）' : ''}`, kind === 'orb' ? !!mr.crystal : !mr.crystal);
  }
  const gb = mergeParts(make('blue').model.parts([]), false), gr = mergeParts(make('red').model.parts([]), false);
  T(`${NAME[kind]}：蓝红两方是两个不同的模型`, gb.attributes.position.count !== gr.attributes.position.count);
}

// ---- 这一帧怎么画 ----
{
  const e0 = modeOf([{ type: 'explode', t: 0.01, dur: 1.7 }], true), e9 = modeOf([{ type: 'explode', t: 1.69, dur: 1.7 }], true);
  T('连贯倒塌：播放中不画静态网格（部件在接力），而且没有"从地下升起"', e0.hidden === true && e0.offsetY === 0 && e9.hidden === true && e9.offsetY === 0);
  T('连贯倒塌：播完（事件收掉）恢复正常画法', modeOf([], true).hidden === false);
  const r0 = modeOf([{ type: 'respawn', t: 0.01, dur: 1.5 }], true), r9 = modeOf([{ type: 'respawn', t: 1.49, dur: 1.5 }], true);
  T('连贯重生：开头只画基座（部件在飞回来）、不从地下升起、水晶最后才长出来', r0.assemble && r0.offsetY === 0 && r0.crystalK === 0 && !r9.assemble && r9.crystalK > 0.99);
  const legacy = modeOf([{ type: 'explode', t: 0, dur: 1.5 }], false);
  T('旧造型的画法不受影响（仍是原来那套）', legacy.hidden === false && legacy.offsetY <= -0.99);
  const fx = new BuildingFx(new THREE.Scene());
  const e = { id: 7, type: 'tower', _mapTier: 'outer', alive: true, currentHP: 100, baseStats: { maxHP: 100 } };
  fx.observe(e, false, false);
  e.alive = false; e.currentHP = 0;
  const md = fx.observe(e, false, true);
  T('被摧毁那一帧：认出倒塌，并把静态网格藏起来', fx.byId.get(7).events.some((ev) => ev.type === 'explode') && md.hidden === true);
}
done();
