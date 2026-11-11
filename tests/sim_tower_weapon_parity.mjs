// Q2：同攻速下穿透型与闪电杖强度相等；充能型武器的充能速度与攻速挂钩。
// 用户："思考如何平衡在相同攻速下，穿透型子弹和闪电杖的强度相等，对于充能型武器应该如何把充能速度和攻速连结起来"。
// 做法：两者每次攻击量都是 100%（穿透型 = 物攻；闪电杖 = 物攻转来的法强 × tickPct×tickPerSec），
// 爬升都按攻击次数（升温 4 层 / 4 次攻击量充满，满档 1.8 倍），换目标都不清零。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { T, done } = scoreboard('穿透型 vs 闪电杖 同攻速等强');

function dps(weapon, as, seconds = 20) {
  const sim = createSimulation(); sim.mapSystem.loadMap('summoners_rift_v1');
  const W = sim.mapSystem.currentMap.world, cx = W.w / 2, cy = W.h / 2;
  const tw = sim.factories.createBuilding({ faction: 'blue', tier: 'outer', laneId: 'mid', isNexus: false,
    pos: { x: cx, y: cy }, weapon, stats: { maxHP: 1e6, attackDamage: 100, baseAttackSpeed: as, armor: 0, magicResist: 0 } });
  tw.baseStats.attackSpeedRatio = 1; tw.baseStats.abilityPower = 0;
  const d = sim.factories.createMinion('melee', cx + 100, cy, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
  d.baseStats.moveSpeed = 0; d.baseStats.maxHP = d.currentHP = 1e9; d.baseStats.armor = 0; d.baseStats.magicResist = 0;
  d.baseStats.attackDamage = 0; d._skillInstances = [];
  const hp0 = d.currentHP;
  for (let i = 0; i < seconds * 30; i++) sim.step(1 / 30);
  return (hp0 - d.currentHP) / seconds;
}
for (const as of [0.833, 2.5]) {
  const p = dps('piercing', as), l = dps('lightning', as);
  T(`攻速 ${as}：穿透型 ${p.toFixed(1)}/秒 ≈ 闪电杖 ${l.toFixed(1)}/秒（差 ${(Math.abs(p - l) / Math.max(p, l) * 100).toFixed(1)}%）`,
    p > 0 && l > 0 && Math.abs(p - l) / Math.max(p, l) < 0.12);
}
{
  const l1 = dps('lightning', 0.833), l2 = dps('lightning', 2.5);
  T(`闪电杖伤害随攻速增长（攻速 3 倍 → ${(l2 / l1).toFixed(2)} 倍）`, l2 / l1 > 2.5);
}
T('闪电杖转化率 100%（保留物攻转法强，数值改为与穿透型对齐）', CONFIG.tuning.weapons.lightningApConvertPct === 100);
done();
