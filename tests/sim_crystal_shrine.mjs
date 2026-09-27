// 召唤水晶 / 水晶枢纽新造型（crystalShrines.js）：三尊守卫托举 / 守卫圣殿，按部件掉块，水晶本身缺角。
// 用户定稿："水晶枢纽/召唤水晶的模型需要完全推倒重来"，两组方案里各选了 A。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { crystalShrine, chippedCrystal } = await import('../src/presentation/crystalShrines.js');
const { partsBox } = await import('../src/presentation/towerStatue.js');
const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
const { T, done } = scoreboard('召唤水晶 / 水晶枢纽');

const F = { stone: '#b9c6d6', trim: '#eaf2fd' };
{
  const S = CONFIG.ui.crystalShrine;
  T('①开关、守卫大小、水晶半径、缺角位置、废墟参数都在 CONFIG.ui.crystalShrine（软编码）',
    ['statue', 'classic'].includes(S.style) && S.bearerScale > 0 && S.guardianScale > 0 && S.orbCrystalR > 0 && S.gemCrystalR > 0
    && S.dentsLight.length && S.dentsHeavy.length && S.ruin);
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
    const body = partsBox(sh.model.parts([]));
    T(`⑥${tag}：水晶悬在建筑之上、在中轴（底面高于守卫手/柱顶的大半）`, sh.crystalCy - sh.crystalR > body.max.y * 0.45);
    const ruin = partsBox(sh.ruin);
    T(`⑦${tag}：废墟是矮矮的一堆碎石（高 ${ruin.max.y.toFixed(0)}）`, ruin.max.y < (sh.crystalCy + sh.crystalR) * 0.45 && sh.ruin.length > 40);
    T(`⑧${tag}：确定性（两次建模清单与废墟高度逐位相同）`,
      JSON.stringify(crystalShrine(kind, R, fac, F).stages) === JSON.stringify(sh.stages)
      && partsBox(crystalShrine(kind, R, fac, F).ruin).max.y === ruin.max.y);
  }
  // 水晶本身缺角：顶点被压进去（包围半径不变或变小），三档形状不同
  const g = [0, 1, 2].map((d) => chippedCrystal(kind, 10, d));
  const maxR = (geo) => { let r = 0; const p = geo.attributes.position; for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i), p.getZ(i))); return r; };
  const minR = (geo) => { let r = Infinity; const p = geo.attributes.position; for (let i = 0; i < p.count; i++) r = Math.min(r, Math.hypot(p.getX(i), p.getY(i), p.getZ(i))); return r; };
  T(`⑨${name}：水晶随损毁缺角（完好的顶点都在半径上，轻损、重损越压越深）`,
    Math.abs(minR(g[0]) - 10) < 1e-3 && minR(g[1]) < 9 && minR(g[2]) <= minR(g[1]) && maxR(g[2]) <= 10 + 1e-6);
}

{
  const prev = CONFIG.ui.crystalShrine.style;
  CONFIG.ui.crystalShrine.style = 'statue';
  for (const kind of ['orb', 'gem']) {
    const ms = [0, 1, 2].map((d) => towerMesh(`shrine-test|${kind}|${d}`, '#5b9bd5', 40, '', kind, false, false, 'nexus', 'blue', d, null));
    T(`⑩${kind}：towerMesh 接入后三档 topY / muzzleY 逐位相等（炮口不跳）`,
      ms.every((m) => m.topY === ms[0].topY && m.muzzleY === ms[0].muzzleY));
    T(`⑪${kind}：三档水晶几何不同（缺角），水晶在中轴上`,
      ms[0].crystal.geo !== ms[2].crystal.geo && ms.every((m) => !m.crystal.cx && !m.crystal.cz));
    T(`⑫${kind}：废墟没有水晶`, !towerMesh(`shrine-test|${kind}|ruin`, '#5b9bd5', 40, '', kind, false, true, 'nexus', 'blue', 0, null).crystal);
  }
  CONFIG.ui.crystalShrine.style = 'classic';
  const cl = towerMesh('shrine-test|classic', '#5b9bd5', 40, '', 'gem', false, false, 'nexus', 'blue', 0, null);
  T('⑬切回 classic 仍是原来的祭坛（水晶是正八面体、不缺角）', cl.crystal && cl.crystal.geo.type === 'OctahedronGeometry');
  CONFIG.ui.crystalShrine.style = prev;
}

done();
