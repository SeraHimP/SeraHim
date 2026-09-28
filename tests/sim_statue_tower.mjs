// 雕像守卫塔（towerStatue.js）：按部件掉块的损毁、杖顶水晶与炮口偏移、碎石堆废墟。
// 用户定稿：原型 B（石环 + 立柱 + 持杖守卫），"蓝色庄重、沉稳，红色混沌、尖锐"；
// 损毁"再极端一些"但"重损雕像的头不要掉"；"水晶改为在雕像手上的柱子上"；
// "塔废墟的模型就是一个倒塌的塔的碎石堆"。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { statueTower, partsBox } = await import('../src/presentation/towerStatue.js');
const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
const { T, done } = scoreboard('雕像守卫塔');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

const F = { stone: '#b9c6d6', trim: '#eaf2fd' };
const TIERS = ['outer', 'inner', 'base', 'hq_tower'];
const R = 32;

{
  const S = CONFIG.ui.statueTower;
  T('①造型开关、四档规模、碎块散布、颜色都在 CONFIG.ui.statueTower（软编码）',
    ['statue', 'classic'].includes(S.style) && TIERS.every((t) => S.statueScale[t] > 0 && S.columnExtra[t] >= 0)
    && S.rubbleDist.length === 2 && S.rubbleScale > 0 && S.colors.blue && S.colors.red && S.ruin);
}

for (const fac of ['blue', 'red']) {
  for (const tier of TIERS) {
    const st = statueTower(R, tier, fac, F);
    const [s0, s1, s2] = st.stages;
    const tag = `${fac}/${tier}`;
    T(`②${tag}：损毁逐档累加（轻损拿掉的部件重损里全都还是拿掉的）`, s0.length === 0 && s1.every((id) => s2.includes(id)));
    T(`③${tag}：重损比轻损极端得多（拿掉的部件至少是轻损的两倍：${s1.length} → ${s2.length}）`, s1.length >= 5 && s2.length >= s1.length * 2);
    T(`④${tag}：重损掉一整边肩膀连手臂`, s2.includes('pauldron-1') && s2.includes('arm-1'));
    T(`⑤${tag}：头不掉（兜帽/角盔和帽尖都不在任何一档里）`, ![...s1, ...s2].some((id) => id === 'hood' || id === 'hoodTip'));
    // 水晶在杖顶：水平偏离中轴、偏移量三档一致（本来就只算一次），且在杖顶托爪之上
    const off = Math.hypot(st.crystalX, st.crystalZ);
    T(`⑥${tag}：水晶在守卫手里的杖顶上，不在头顶中轴（水平偏移 ${off.toFixed(1)}）`, off > R * 0.3 && st.crystalZ > 0);
    const prongs = st.model.order.filter((id) => /^prong\d$/.test(id));
    const prongTop = Math.max(...prongs.map((id) => partsBox(st.model.pieceParts(id)).max.y));
    T(`⑦${tag}：水晶悬在杖顶托爪之上（底面不低于托爪尖，不穿模）`, st.crystalCy - st.crystalR >= prongTop - R * 0.02);
    T(`⑧${tag}：重损只断杖头的一根托爪，杖和其余托爪都在（水晶始终在杖上）`,
      prongs.filter((id) => s2.includes(id)).length === 1 && prongs.length >= 3);
    // 掉下来的部件都落在地面上、塔脚附近
    const rubbleOk = s2.every((id) => {
      const rm = st.model.rubbleMatrix(id);
      const bb = partsBox(st.model.pieceParts(id).map((q) => ({ geo: q.geo, matrix: rm.clone().multiply(q.matrix) })));
      const c = new THREE.Vector3(); bb.getCenter(c);
      return bb.min.y > -1e-3 && bb.min.y < R * 0.05 && Math.hypot(c.x, c.z) < R * 1.8;
    });
    T(`⑨${tag}：碎块都躺在塔脚地面上（不悬空、不入土、不飞远）`, rubbleOk);
    // 废墟是一堆碎石：比完好的塔矮得多，但不是空的
    const intactTop = st.crystalCy + st.crystalR;
    const ruinBox = partsBox(st.ruin);
    T(`⑩${tag}：废墟是矮矮的一堆（高 ${ruinBox.max.y.toFixed(0)}，完好 ${intactTop.toFixed(0)}）`,
      ruinBox.max.y < intactTop * 0.35 && st.ruin.length > 40);
  }
}

{
  // 父部件掉了，长在它上面的部件不留残根（否则残根悬在半空）
  const st = statueTower(R, 'outer', 'blue', F);
  const m = st.model;
  const kids = m.order.filter((id) => m.pieces.get(id).parent === 'torso');
  const stubCount = kids.filter((id) => m.pieces.get(id).stub > 0).length;
  // 躯干本身不留残根、它的零件整块变碎块（零件数不变），所以两者之差正好是孩子们的残根数
  T(`⑪躯干也掉了时，长在躯干上的部件不再留残根（${stubCount} 个残根被省掉）`,
    stubCount > 0 && m.parts(kids).length - m.parts(['torso', ...kids]).length === stubCount);
  T('⑫同样入参两次建模逐位相同（可缓存、无随机）',
    JSON.stringify(statueTower(R, 'inner', 'red', F).stages) === JSON.stringify(statueTower(R, 'inner', 'red', F).stages)
    && partsBox(statueTower(R, 'inner', 'red', F).ruin).max.y === partsBox(statueTower(R, 'inner', 'red', F).ruin).max.y);
}

{
  // towerMesh 接入：水晶偏移随几何一起交出去，三档一致
  const prev = CONFIG.ui.statueTower.style;
  CONFIG.ui.statueTower.style = 'statue';
  const ms = [0, 1, 2].map((d) => towerMesh(`statue-test|${d}`, '#5b9bd5', R, '', 'tower', false, false, 'outer', 'blue', d, null));
  T('⑬towerMesh 交出水晶的水平偏移（cx/cz），三档一致',
    ms.every((m) => m.crystal && Math.hypot(m.crystal.cx, m.crystal.cz) > R * 0.3 && m.crystal.cx === ms[0].crystal.cx && m.crystal.cz === ms[0].crystal.cz));
  const ruin = towerMesh('statue-test|ruin', '#5b9bd5', R, '', 'tower', false, true, 'outer', 'blue', 0, null);
  T('⑭废墟没有水晶', !ruin.crystal);
  CONFIG.ui.statueTower.style = 'classic';
  const cl = towerMesh('statue-test|classic', '#5b9bd5', R, '', 'tower', false, false, 'outer', 'blue', 0, null);
  T('⑮切回 classic 仍是原来的塔楼（水晶在中轴上）', cl.crystal && !cl.crystal.cx && !cl.crystal.cz);
  CONFIG.ui.statueTower.style = prev;
}

{
  // 炮口跟着水晶走：红线、光束、子弹都从水晶出发
  const ul = src('presentation/UnitLayer.js'), fx = src('presentation/EffectsLayer.js'), tr = src('presentation/ThreeRenderer.js');
  T('⑯UnitLayer 按塔的朝向把水晶偏移转到世界里，并对外提供 muzzleOffsetOf',
    /muzzleOffsetOf\(entityId\)/.test(ul) && /_crystalOffset\(en\)/.test(ul) && /en\.faceFixed/.test(ul));
  T('⑰ThreeRenderer 把 muzzleOffsetOf 交给特效层', /this\.units\.muzzleOffsetOf\(id\)/.test(tr));
  T('⑱塔的攻击红线从水晶出发', /t\.pos\.x \+ aox/.test(fx));
  T('⑲闪电杖光束从水晶出发（攻击者没了用快照）', /const bsx = b\.startX \+ box/.test(fx) && /offOf\(b, b\.attackerId\)/.test(fx));
  T('⑳子弹出膛在水晶处，飞行中并回弹道', /x \+= pox \* \(1 - done\)/.test(fx));
}

done();
