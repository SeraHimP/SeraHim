// 不穿模：建筑碰撞半径 ≥ 模型实际外轮廓。
// 用户："模型的碰撞就是按照模型的实际尺寸来计算的！"；"塔和小兵穿模了！！！！不要出现任何穿模！！！！"
// 根因：碰撞按名义半径（buildingSizes × towerVizScale）算，雕像塔底座 / 塔基台面、枢纽台阶都比它宽，
// 小兵贴着名义半径站就已经插进底座里。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { structureRadius } = await import('../src/data/structureRadius.js');
const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
const { footprintRadius } = await import('../src/presentation/UnitLayer.js');
const { IO_GROUPS } = await import('../src/data/templateIO.js');
const { T, done } = scoreboard('不穿模（建筑碰撞 = 模型外轮廓）');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

const bs = CONFIG.buildingSizes, vz = CONFIG.towerVizScale, fd = CONFIG.ui.towerFoundation;
const prevT = CONFIG.ui.statueTower.style, prevS = CONFIG.ui.crystalShrine.style;
CONFIG.ui.statueTower.style = 'statue'; CONFIG.ui.crystalShrine.style = 'statue';
const bad = [];
for (const [kind, tier] of [['tower', 'outer'], ['tower', 'inner'], ['tower', 'base'], ['tower', 'hq_tower'], ['orb', 'nexus_lane'], ['gem', 'nexus_main']]) {
  for (const fac of ['blue', 'red']) for (const dmg of [0, 1, 2]) {
    const R = (bs[tier] || bs.default) * (vz[tier] ?? vz.default);
    const m = towerMesh(`clip|${kind}|${tier}|${fac}|${dmg}`, '#5b9bd5', R, '', kind, false, false, tier, fac, dmg,
      { foundation: fd?.enabled ? { ...fd, ground: '#2b3647' } : null, fx: { standing: true } });
    const foot = footprintRadius(m.geo, 0.3);   // 小兵身高范围内（模型下 30%）的外轮廓；地上的碎块不挡路，不算
    if (structureRadius(tier) < foot - 0.01) bad.push(`${tier}/${fac}/${dmg}: 碰撞 ${structureRadius(tier).toFixed(1)} < 外轮廓 ${foot.toFixed(1)}`);
  }
}
CONFIG.ui.statueTower.style = prevT; CONFIG.ui.crystalShrine.style = prevS;
T(`①所有建筑（6 种层级 × 蓝红 × 三个损毁档）碰撞半径 ≥ 模型实际外轮廓${bad.length ? '：' + bad.join('；') : ''}`, bad.length === 0);
T('②显示不变：外轮廓系数只乘在碰撞上（模型大小仍按 buildingSizes × towerVizScale）',
  !/buildingFootprintK/.test(src('presentation/UnitLayer.js')) && /structureRadius/.test(src('systems/LaneMovementSystem.js')));
T('③避障与寻路阻挡用同一个半径（structureRadius），不再各算一份',
  /const rSum = rSelf \+ structureRadius\(o\._mapTier, o\._modelSize\)/.test(src('systems/LaneMovementSystem.js'))
  && /const r = structureRadius\(b\.tier\)/.test(src('systems/MapSystem.js')));
T('④外轮廓系数软编码，可在编辑器配置导入导出里改', !!CONFIG.buildingFootprintK && IO_GROUPS.includes('buildingFootprintK'));

// 行为：真跑仿真，敌兵去打塔（近战 / 远程 / 炮车），全程没有兵钻进塔的外轮廓
{
  const { createSimulation } = await import('../src/simulation.js');
  const { MINION_SIZES } = await import('../src/data/Config.js');
  const sim = createSimulation(); sim.mapSystem.loadMap('summoners_rift_v1');
  const tower = sim.entityContainer.getAllTowers(true).find((t) => t._mapFaction === 'blue' && t._mapTier === 'outer' && t._laneId === 'mid');
  tower.currentHP = tower.baseStats.maxHP = 1e9;   // 别让塔被推掉，测的是站位
  const R = structureRadius(tower._mapTier, tower._modelSize);
  const made = [];
  let k = 0;
  for (const type of ['melee', 'melee', 'melee', 'melee', 'ranged', 'ranged', 'siege', 'super']) {
    const a = k++ * 0.7;
    const m = sim.laneWaveSystem.createMinion(type, tower.pos.x + 160 + Math.cos(a) * 30, tower.pos.y - 120 + Math.sin(a) * 30, 'red', 'mid', 'reverse');
    if (m) { m.currentHP = m.baseStats.maxHP = 1e9; made.push(m); }
  }
  let worst = Infinity, who = '', attacked = false;
  const hp0 = tower.currentHP;
  for (let i = 0; i < 30 * 20; i++) {
    sim.step(1 / 30);
    for (const m of made) {
      const gap = Math.hypot(m.pos.x - tower.pos.x, m.pos.y - tower.pos.y) - R - (MINION_SIZES[m.type] ?? 10) * 0.5;
      if (gap < worst) { worst = gap; who = m.type; }
    }
  }
  attacked = tower.currentHP < hp0;
  T(`⑤实跑 20 秒：${made.length} 个敌兵打塔（塔掉血：${attacked}），没有兵钻进塔的外轮廓（最近 ${worst.toFixed(1)}，${who}）`, attacked && worst >= -0.5);
}
done();
