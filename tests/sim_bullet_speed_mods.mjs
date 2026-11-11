// 子弹速度修正对所有远程单位生效。
// 用户："子弹速度对于炮兵子弹/远程兵子弹不生效"。
// 根因：远程兵/炮兵/攻城车模板没声明 bulletSpeed，基础值是 0；百分比修正（风天 -30% 等）
// 乘在 0 上恒为 0，战斗里再按"默认弹速 + 属性值"兜底，于是这类修正对它们完全无效，
// 只有声明了弹速的塔、术士兵吃得到。修法：建兵时把默认弹速写进远程单位的基础属性。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { T, done } = scoreboard('子弹速度修正');

const def = CONFIG.tuning?.defaultBulletSpeed ?? 400;
const rangedTypes = Object.entries(CONFIG.templates)
  .filter(([, t]) => (t.attackRange || 0) > MELEE_RANGE_THRESHOLD && t.maxHP > 0)
  .map(([k]) => k);
const meleeTypes = Object.entries(CONFIG.templates)
  .filter(([, t]) => (t.attackRange || 0) > 0 && (t.attackRange || 0) <= MELEE_RANGE_THRESHOLD && t.maxHP > 0)
  .map(([k]) => k);

const sim = createSimulation();
sim.mapSystem.loadMap('summoners_rift_v1');
const F = sim.factories;
const mk = (type) => F.createMinion(type, 1700, 1800, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });

T(`①至少有远程兵种可测（${rangedTypes.join('/')}）`, rangedTypes.length >= 2);
for (const type of rangedTypes) {
  const e = mk(type); if (!e) continue;
  const declared = CONFIG.templates[type].bulletSpeed;
  T(`②${type}：基础弹速为正（模板${declared > 0 ? '声明 ' + declared : '未声明 → 默认 ' + def}）`,
    e.baseStats.bulletSpeed === (declared > 0 ? declared : def));
}
for (const type of meleeTypes.slice(0, 3)) {
  const e = mk(type); if (!e) continue;
  T(`③近战 ${type} 不补弹速（没有弹道）`, !(e.baseStats.bulletSpeed > 0) || CONFIG.templates[type].bulletSpeed > 0);
}

// 行为：挂一个"子弹速度 -30%"的修正层（与风天走同一条属性合成通路），远程兵真实发出的子弹变慢
{
  const fakeWeather = { enabled: true, getWeights: () => ({ wind: 1 }), getModifiers: () => ({ bulletSpeed: { flat: 0, percent: -30 } }) };
  for (const type of ['ranged', 'siege'].filter((t) => rangedTypes.includes(t))) {
    const sim2 = createSimulation(); sim2.mapSystem.loadMap('summoners_rift_v1');
    sim2.attrCalc.setWeatherSystem?.(fakeWeather);
    const a = sim2.factories.createMinion(type, 1700, 1800, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
    const b = sim2.factories.createMinion('melee', 1700 + 150, 1800 - 150, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
    a.baseStats.moveSpeed = 0; b.baseStats.moveSpeed = 0; b.baseStats.maxHP = b.currentHP = 1e6;
    let p = null;
    for (let i = 0; i < 900 && !p; i++) { sim2.step(1 / 60); p = sim2.projectileSystem.getProjectiles().find((q) => q.attackerId === a.id); }
    T(`④${type} 在"弹速 -30%"下发出了子弹`, !!p);
    T(`⑤${type} 子弹速度被修正压低（实测 ${p?.speed}，无修正时 ${def}）`, !!p && p.speed < def && p.speed > 0);
  }
}
done();
