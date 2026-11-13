// Q8：生命统计窗口需要的数据。用户："属性面板点开的生命统计窗口太粗糙了，需要做的更加精细化……
// 里面显示的各项属性应该非常的全面"。这一套只钉数据层（界面另行确认后再做）。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { createSimulation } = await import('../src/simulation.js');
const { readTimeline, TIMELINE_SEC } = await import('../src/core/damageAttribution.js');
const { applyHeal } = await import('../src/core/healing.js');
const { T, done } = scoreboard('生命统计数据');

const sim = createSimulation();
sim.mapSystem.loadMap('summoners_rift_v1');
const W = sim.mapSystem.currentMap.world;
const mk = (fac, dx) => {
  const e = sim.factories.createMinion('melee', W.w / 2 + dx, W.h / 2, 1, 1, { faction: fac, laneId: 'mid', direction: fac === 'blue' ? 'forward' : 'reverse' });
  e.baseStats.moveSpeed = 0; e._skillInstances = [];
  return e;
};
const a = mk('blue', 0), b = mk('red', 25);
b.baseStats.maxHP = b.currentHP = 1e6; b.baseStats.attackDamage = 0;
b.tempShield = 30;
for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60);
T(`①受击次数（${b._hitsTaken}）与最大单次伤害（${Math.round(b._maxHitTaken || 0)}）`, b._hitsTaken > 0 && b._maxHitTaken > 0);
T(`②护盾累计吸收（${Math.round(b._shieldAbsorbedTotal || 0)}）`, b._shieldAbsorbedTotal > 0 && b._shieldAbsorbedTotal <= 30 + 1e-6);
const dmgTl = readTimeline(b, '_dmgTl');
const tlSum = dmgTl.reduce((s, v) => s + (v || 0), 0);
const total = b._dmgTaken.physical + b._dmgTaken.magic + b._dmgTaken.true;
T(`③最近 ${TIMELINE_SEC} 秒承伤时间线之和 = 累计承伤（${Math.round(tlSum)} / ${Math.round(total)}）`, dmgTl.length === TIMELINE_SEC && Math.abs(tlSum - total) < 1e-6);
const hpTl = readTimeline(b, '_hpTl').filter((v) => v != null);
T(`④每秒采一次血量占比（${hpTl.length} 个点，都在 0~1）`, hpTl.length >= 6 && hpTl.every((v) => v >= 0 && v <= 1));
// 治疗按来源
const e = mk('blue', -200); e.currentHP = 1;
applyHeal(e, 10, 1, e.baseStats.maxHP, undefined, 'vamp');
applyHeal(e, 5, 1, e.baseStats.maxHP);
T(`⑤治疗按来源拆分（吸血 ${e._healBySource?.vamp}，技能 ${e._healBySource?.skill}）`,
  e._healBySource?.vamp === 10 && e._healBySource?.skill === 5 && e._healReceivedTotal === 15);
// 生命恢复走 regen 来源
const r = mk('blue', -400); r.baseStats.healthRegen = 5; r.currentHP = 10;
for (let i = 0; i < 60; i++) sim.step(1 / 60);
T(`⑥生命恢复记在"regen"来源（${(r._healBySource?.regen || 0).toFixed(2)}）`, (r._healBySource?.regen || 0) > 3);
done();
