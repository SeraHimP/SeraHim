// 召唤水晶 / 水晶枢纽新造型（crystalShrines.js）：三尊守卫托举 / 守卫圣殿，按部件掉块，水晶本身缺角。
// 用户定稿："水晶枢纽/召唤水晶的模型需要完全推倒重来"，两组方案里各选了 A。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { crystalShrine, crystalGeoOf, ruinShardsGeo } = await import('../src/presentation/crystalShrines.js');
const { partsBox } = await import('../src/presentation/towerStatue.js');
const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
const { T, done } = scoreboard('召唤水晶 / 水晶枢纽');

const F = { stone: '#b9c6d6', trim: '#eaf2fd' };
{
  const S = CONFIG.ui.crystalShrine;
  // 用户："把水晶枢纽的模型做的大一些！（面积大一些）"、"模型的碰撞就是按照模型的实际尺寸来计算的！"
  // 所以放大走 buildingSizes（画面与碰撞同源），并且碰撞半径（× towerVizScale）要盖住圣殿台面。
  const bs = CONFIG.buildingSizes, vz = CONFIG.towerVizScale;
  T('①b枢纽明显比召唤水晶、塔大（面积大）', bs.nexus_main >= bs.nexus_lane * 1.5 && bs.nexus_main >= bs.outer * 1.6);
  T('①c枢纽碰撞半径盖住圣殿台面（台面外沿 1.3R）', (vz.nexus_main ?? vz.default) >= 1.3);
  T('①开关、守卫大小、水晶半径、缺角位置、废墟参数都在 CONFIG.ui.crystalShrine（软编码）',
    ['statue', 'classic'].includes(S.style) && S.bearerScale > 0 && S.guardianScale > 0 && S.orbCrystalR > 0 && S.gemCrystalR > 0
    && S.ruinShards.count > 0 && S.ruin);
}

for (const [kind, R, name] of [['orb', 34, '召唤水晶'], ['gem', 44, '水晶枢纽']]) {
  for (const fac of ['blue', 'red']) {
    const sh = crystalShrine(kind, R, fac, F);
    const [s0, s1, s2] = sh.stages;
    const tag = `${name}/${fac}`;
    T(`②${tag}：损毁逐档累加`, s0.length === 0 && s1.length > 0 && s1.every((id) => s2.includes(id)));
    T(`③${tag}：重损比轻损极端得多（${s1.length} → ${s2.length}）`, s2.length >= s1.length * 2);
    T(`④${tag}：守卫的头不掉（没有 hood 类部件被拿掉）`, !s2.some((id) => /hood/.test(id)));
    const figures = new Set(sh.model.order.map((id) => id.split('.')[0]).filter((p) => /^[fg]\d$/.test(p)));
    T(`⑤${tag}：${kind === 'orb' ? '三尊托举守卫' : '四尊圣殿守卫'}（${figures.size}）`, figures.size === (kind === 'orb' ? 3 : 4));
    // 用户："水晶枢纽的守卫不是完全在底座上，有一半是悬空的……不要让守卫悬空！！！"
    const hang = sh.figures.filter((f) => Math.hypot(f.x, f.z) + f.r > sh.support.r + 1e-6 || Math.abs(f.y - sh.support.y) > 1e-6);
    T(`④b${tag}：每尊守卫的脚下整个落在台面上（不悬空：${hang.length} 尊越界）`, sh.figures.length > 0 && hang.length === 0);
    const body = partsBox(sh.model.parts([]));
    T(`⑥${tag}：水晶悬在建筑之上、在中轴（底面高于守卫手/柱顶的大半）`, sh.crystalCy - sh.crystalR > body.max.y * 0.45);
    const ruin = partsBox(sh.ruin);
    T(`⑦${tag}：废墟是矮矮的一堆碎石（高 ${ruin.max.y.toFixed(0)}）`, ruin.max.y < (sh.crystalCy + sh.crystalR) * 0.45 && sh.ruin.length > 40);
    T(`⑧${tag}：确定性（两次建模清单与废墟高度逐位相同）`,
      JSON.stringify(crystalShrine(kind, R, fac, F).stages) === JSON.stringify(sh.stages)
      && partsBox(crystalShrine(kind, R, fac, F).ruin).max.y === ruin.max.y);
  }
  // 用户："正常/轻损/重损的水晶模型不要变！水晶不要掉块！"——几何只由 (kind, 半径) 决定，与损毁无关，就是原来那颗
  const g = crystalGeoOf(kind, 10), n0 = kind === 'gem' ? 8 * 3 : 20 * 3;
  T(`⑨${name}：水晶几何完整、就是原来那颗（${kind === 'gem' ? '八面体' : '二十面体'}）`, g.attributes.position.count === n0);
}

{
  const prev = CONFIG.ui.crystalShrine.style;
  CONFIG.ui.crystalShrine.style = 'statue';
  for (const kind of ['orb', 'gem']) {
    const ms = [0, 1, 2].map((d) => towerMesh(`shrine-test|${kind}|${d}`, '#5b9bd5', 40, '', kind, false, false, 'nexus', 'blue', d, null));
    T(`⑩${kind}：towerMesh 接入后三档 topY / muzzleY 逐位相等（炮口不跳）`,
      ms.every((m) => m.topY === ms[0].topY && m.muzzleY === ms[0].muzzleY));
    const cnt = (m) => m.crystal.geo.attributes.position.count;
    T(`⑪${kind}：三档水晶一模一样（不掉块），水晶在中轴上`,
      ms.every((m) => cnt(m) === cnt(ms[0]) && m.crystal.r === ms[0].crystal.r) && ms.every((m) => !m.crystal.cx && !m.crystal.cz));
    const ruinM = towerMesh(`shrine-test|${kind}|ruin`, '#5b9bd5', 40, '', kind, false, true, 'nexus', 'blue', 0, null);
    if (kind === 'orb') {
      // 用户："召唤水晶的损毁模型……应该还包含悬浮在半空中的水晶碎片在缓慢旋转（象征一会重生）"
      T('⑫召唤水晶等待重生：碎石堆上方悬着几块碎晶（按水晶画 = 正常水晶的材质），转得比正常水晶慢',
        !!ruinM.crystal && ruinM.crystal.spinK < 1 && cnt(ruinM) === 8 * 3 * CONFIG.ui.crystalShrine.ruinShards.count);
      ruinM.crystal.geo.computeBoundingBox();
      const pileTop = partsBox([{ geo: ruinM.geo, matrix: new THREE.Matrix4() }]).max.y;
      const shardLow = ruinM.crystal.cy + ruinM.crystal.geo.boundingBox.min.y;
      T(`⑫b碎晶是悬空的：最低一块的底（${shardLow.toFixed(1)}）高过碎石堆顶（${pileTop.toFixed(1)}）`, shardLow > pileTop);
    } else {
      T('⑫水晶枢纽被摧毁（一局结束）：没有悬浮碎晶', !ruinM.crystal);
    }
  }
  CONFIG.ui.crystalShrine.style = 'classic';
  const cl = towerMesh('shrine-test|classic', '#5b9bd5', 40, '', 'gem', false, false, 'nexus', 'blue', 0, null);
  T('⑬切回 classic 仍是原来的祭坛（水晶是正八面体、不缺角）', cl.crystal && cl.crystal.geo.type === 'OctahedronGeometry');
  CONFIG.ui.crystalShrine.style = prev;
}

{
  // 用户："更改完模型大小后，为了确保显示效果，所有地图相应的塔位需要调整防止穿模"、
  // "模型的碰撞就是按照模型的实际尺寸来计算的！"——
  // 占地半径取模型真实包围（石台外沿）与碰撞半径（buildingSizes × towerVizScale）的较大者，
  // 所有内置地图上任意两座建筑的占地圈不相交、也不压到不可走的地面上。
  const { createSimulation } = await import('../src/simulation.js');
  const { MAPS } = await import('../src/data/maps/index.js');
  const { statueTower } = await import('../src/presentation/towerStatue.js');
  const footK = {};
  // 真实水平半径：逐顶点变换后取离中轴最远的那个（包围盒会被旋转过的八角台放大约 √2 倍）
  const horiz = (parts) => {
    let r = 0; const v = new THREE.Vector3();
    for (const q of parts) {
      const p = q.geo.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(q.matrix); r = Math.max(r, Math.hypot(v.x, v.z)); }
    }
    return r;
  };
  for (const t of ['outer', 'inner', 'base', 'hq_tower']) footK[t] = Math.max(...['blue', 'red'].map((f) => horiz(statueTower(1, t, f, F).model.base) ));
  footK.nexus_lane = Math.max(...['blue', 'red'].map((f) => horiz(crystalShrine('orb', 1, f, F).model.base)));
  footK.nexus_main = Math.max(...['blue', 'red'].map((f) => horiz(crystalShrine('gem', 1, f, F).model.base)));
  const vz = CONFIG.towerVizScale, bs = CONFIG.buildingSizes;
  T(`⑭碰撞半径盖住模型占地（碰撞系数 ≥ 石台外沿：${Object.entries(footK).map(([k, v]) => k + ' ' + v.toFixed(2)).join('，')}）`,
    Object.entries(footK).every(([t, k]) => (vz[t] ?? vz.default) >= k - 0.02));
  let bad = [], blocked = [];
  for (const id of Object.keys(MAPS)) {
    const sim = createSimulation(); sim.mapSystem.loadMap(id);
    const bl = sim.entityContainer.getAll().filter((e) => e.type === 'tower');
    const rad = (e) => (e._modelSize || bs[e._mapTier] || bs.default) * Math.max(footK[e._mapTier] ?? footK.outer, vz[e._mapTier] ?? vz.default);
    for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) {
      const a = bl[i], b = bl[j];
      if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < rad(a) + rad(b)) bad.push(`${id}:${a._mapTier}↔${b._mapTier}`);
    }
    for (const e of bl) {
      const r = (e._modelSize || bs[e._mapTier] || bs.default) * (footK[e._mapTier] ?? footK.outer);
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2;
        if (!sim.mapSystem.isWalkable(e.pos.x + Math.cos(a) * r, e.pos.y + Math.sin(a) * r)) { blocked.push(`${id}:${e._mapTier}#${e.id}`); break; }
      }
    }
  }
  T(`⑮所有内置地图上建筑之间不穿模（${bad.join(' ') || '无重叠'}）`, bad.length === 0);
  T(`⑯所有内置地图上建筑的石台不压进悬崖/树林（${blocked.join(' ') || '无'}）`, blocked.length === 0);
}

done();
