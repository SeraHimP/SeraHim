// Q3：攻击方式统一成 4 种（近战 / 弹道 / 光束 / 范围），显式声明，不再按射程推断。
// 用户："所有单位的攻击方式都统一为4种（不再受攻击距离限制……）"
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { ATTACK_MODES, attackModeOf } = await import('../src/core/attackMode.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { createSimulation } = await import('../src/simulation.js');
const { T, done } = scoreboard('四种攻击方式');

// ① 每个模板、每把攻击型塔武器都显式声明了合法的攻击方式
const bad = Object.entries(CONFIG.templates).filter(([, t]) => !ATTACK_MODES.includes(t.attackMode)).map(([k]) => k);
T(`①所有单位模板都声明了攻击方式（缺：${bad.join(',') || '无'}）`, bad.length === 0);
const weps = ['weapon_piercing', 'weapon_lightning', 'weapon_explosive', 'weapon_corrosion', 'weapon_barrage', 'weapon_nova', 'weapon_prism'];
T('②攻击型塔武器都声明了攻击方式', weps.every((w) => ATTACK_MODES.includes(SkillLibrary[w]?.attackMode)));
T('③闪电杖/光棱/聚能炮 = 光束，腐蚀 = 范围，穿透/爆炸/连珠炮 = 弹道',
  ['weapon_lightning', 'weapon_prism', 'weapon_nova'].every((w) => SkillLibrary[w].attackMode === 'beam')
  && SkillLibrary.weapon_corrosion.attackMode === 'area'
  && ['weapon_piercing', 'weapon_explosive', 'weapon_barrage'].every((w) => SkillLibrary[w].attackMode === 'projectile'));
// ④ 默认映射与改动前"按射程推断"的实际表现逐位一致（这一步只加开关，不改行为）
const legacy = (k, t) => (k === 'dragon' ? 'melee' : ((t.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD ? 'melee' : 'projectile'));
const diff = Object.entries(CONFIG.templates).filter(([k, t]) => t.maxHP > 0 && (t.attackRange > 0 || k === 'dragon') && t.attackMode !== legacy(k, t)).map(([k]) => k);
T(`④默认攻击方式与改动前一致（不一致：${diff.join(',') || '无'}）`, diff.length === 0);
T('⑤没声明时按旧规则兜底（自制单位不受影响）',
  attackModeOf({ type: 'x', baseStats: { attackRange: 30 } }) === 'melee' && attackModeOf({ type: 'x', baseStats: { attackRange: 200 } }) === 'projectile');

// 真跑：同一个兵改攻击方式，看结算路径
function arena(mode, range, extraFoes = 0) {
  const sim = createSimulation(); sim.mapSystem.loadMap('summoners_rift_v1');
  const W = sim.mapSystem.currentMap.world, cx = W.w / 2, cy = W.h / 2;
  const a = sim.factories.createMinion('melee', cx, cy, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
  a.baseStats.attackMode = mode; a.baseStats.attackRange = range; a.baseStats.moveSpeed = 0; a._skillInstances = [];
  a.baseStats.attackDamage = 50;
  const foes = [];
  for (let i = 0; i <= extraFoes; i++) {
    const f = sim.factories.createMinion('melee', cx + Math.min(range, 40) * 0.6, cy + (i - extraFoes / 2) * 14, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
    f.baseStats.moveSpeed = 0; f.baseStats.maxHP = f.currentHP = 1e6; f.baseStats.attackDamage = 0; f._skillInstances = [];
    foes.push(f);
  }
  return { sim, a, foes };
}
{
  const { sim, a, foes } = arena('projectile', 1);
  sim.combatSystem.performAttack(a, foes[0]);
  const p = sim.projectileSystem.getProjectiles().find((q) => q.attackerId === a.id);
  T('⑥弹道：射程 1 也走弹道，开火时还没掉血', !!p && foes[0].currentHP === 1e6);
}
{
  const { sim, a, foes } = arena('melee', 200);
  sim.combatSystem.performAttack(a, foes[0]);
  T('⑦近战：射程 200 也是出手即结算、没有弹道',
    foes[0].currentHP < 1e6 && !sim.projectileSystem.getProjectiles().some((q) => q.attackerId === a.id));
}
{
  const { sim, a, foes } = arena('beam', 150);
  sim.combatSystem.performAttack(a, foes[0]);
  const beams = [...(sim.projectileSystem.getBeams?.() || [])];
  T('⑧光束：当场结算、不发子弹、画出光束',
    foes[0].currentHP < 1e6 && !sim.projectileSystem.getProjectiles().some((q) => q.attackerId === a.id)
    && beams.some((b) => b.attackerId === a.id));
}
{
  const { sim, a, foes } = arena('area', 120, 2);
  sim.combatSystem.performAttack(a, foes[0]);
  T(`⑨范围：射程内的敌人都吃到伤害（${foes.filter((f) => f.currentHP < 1e6).length}/${foes.length}）`,
    foes.every((f) => f.currentHP < 1e6) && !sim.projectileSystem.getProjectiles().some((q) => q.attackerId === a.id));
  T('⑩范围：出手时给画面留了记号（时间戳 + 光环半径），逻辑层自己不碰画面', Number.isFinite(a._areaPulseAt) && a._areaPulseR > 0);
}
// ---- 范围光环 / 术士第三下的施法特效（presentation/pulseFx.js）----
{
  const THREE = await import('../vendor/three.module.js');
  const { PulseFx, pulseDue } = await import('../src/presentation/pulseFx.js');
  const { CONFIG } = await import('../src/data/Config.js');
  T('⑪特效参数在 CONFIG.ui.pulseFx（软编码）', CONFIG.ui.pulseFx.area.dur > 0 && CONFIG.ui.pulseFx.cast.dur > 0 && CONFIG.ui.pulseFx.cast.rings >= 1);
  T('⑫时间戳变了、而且是刚发生的才播；没变不播；切图带进来的旧时间戳不播；还没有时间戳不播',
    pulseDue(undefined, 10, 10.1) && !pulseDue(10, 10, 10.1) && !pulseDue(undefined, 10, 30) && !pulseDue(undefined, undefined, 5) && pulseDue(10, 12, 12));
  const scene = new THREE.Scene(), fx = new PulseFx(scene);
  let now = 0; const realNow = performance.now; performance.now = () => now; fx._last = 0;
  fx.ground({ x: 0, y: 0, z: 0, r1: 120, color: '#6cb4ff' });
  fx.cast({ x: 0, y: 0, z: 0, h: 24, color: '#b46cf0' });
  const n0 = scene.children.length;
  T(`⑬范围光环是一道环；术士的施法是 ${CONFIG.ui.pulseFx.cast.rings} 道环 + 一团闪光`, n0 === 1 + CONFIG.ui.pulseFx.cast.rings + 1);
  now = 100; fx.update();
  const ring = fx.live.find((a) => a.kind === 'ring');
  T('⑭光环在往外扩（已经比起点大）、还没到射程边缘', ring && ring.obj.scale.x > ring.r0 && ring.obj.scale.x < 120);
  for (let i = 0; i < 30; i++) { now += 100; fx.update(); }
  T('⑮播完全部收回池子，场景里不留东西', scene.children.length === 0 && fx.live.length === 0 && fx.pool.ring.length === 1 + CONFIG.ui.pulseFx.cast.rings);
  fx.ground({ x: 0, y: 0, z: 0, r1: 60, color: '#ff6a55' });
  T('⑯再播时从池子里取（不新建网格）', fx.pool.ring.length === CONFIG.ui.pulseFx.cast.rings && scene.children.length === 1);
  performance.now = realNow;
}
done();
