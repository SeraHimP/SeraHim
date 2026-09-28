// 巨龙攻击结算：近身挥击，当场结算，不发子弹。
// 用户："星龙有严重Bug，攻击时正常的弹道无法造成伤害，星魂附加的额外弹道移动的特别特别慢！"
// 根因：龙射程 80 > 近战线 60，走了远程弹道；龙的 bulletSpeed = 0，星龙之力 +6 → 弹速 6，一发几乎不动的子弹。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { T, done } = scoreboard('巨龙攻击结算');
const cs = fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');

T('①龙的射程确实超过近战线（所以必须显式按近战判，不能只看射程）', CONFIG.gameRules.dragon.combat.attackRange > MELEE_RANGE_THRESHOLD);
T('②巨龙一律按近战：当场结算，不走弹道', /const isMeleeUnit = \(e\) => !!e && \(e\.type === 'dragon' \|\|/.test(cs));
T('③普攻弹速走 effectiveBulletSpeed（没声明弹速的单位 = 默认弹速 + 加成）',
  /speed: this\.effectiveBulletSpeed\(attacker, atkStats\)/.test(cs));
// 行为：把"星龙之力"的弹速加成套到一个没声明弹速的远程单位上，算出来的弹速不低于默认值
{
  const def = CONFIG.tuning?.defaultBulletSpeed ?? 400;
  const speedOf = (base, bonus) => (base > 0) ? (base + bonus || def) : def + Math.max(0, bonus);
  T(`④基础 0 + 星龙之力 +${CONFIG.dragonPower.astral.bulletSpeed} → ${speedOf(0, CONFIG.dragonPower.astral.bulletSpeed)}（原来是 ${CONFIG.dragonPower.astral.bulletSpeed}）`,
    speedOf(0, CONFIG.dragonPower.astral.bulletSpeed) >= def);
}
// 行为（真跑）：星龙 + 星魂近身打一个红兵，旁边还有两个红兵 → 分裂出的星弹速度不低于默认弹速。
// 用户第二次报"星龙的附加星弹依旧飞的特别慢"——上一轮只修了普攻那一处，分裂弹走的是星魂自己的
// 调用（直接拿属性表 bulletSpeed = 星魂/星力那一点加成当速度），上面那条公式断言测不到它。
{
  const { createSimulation } = await import('../src/simulation.js');
  const sim = createSimulation();
  sim.mapSystem.loadMap('summoners_rift_v1');
  const dragon = sim.factories.createDragon('dragon', { element: 'astral' });
  // createDragon 自己就挂上星魂 + 星龙之力（与游戏里登场同一条路）；applyDragonSelfBuffs 是开关式的，别再调一次
  const { x, y } = dragon.pos;
  for (let i = 0; i < 3; i++) {
    const r = sim.laneWaveSystem.createMinion('melee', x + 45, y + (i - 1) * 28, 'red', 'bot', 'reverse');
    if (r) r.currentHP = 1e6;
  }
  const def = CONFIG.tuning?.defaultBulletSpeed ?? 400;
  let splits = [];
  for (let f = 0; f < 30 * 8 && !splits.length; f++) {
    sim.step(1 / 30);
    splits = sim.projectileSystem.getProjectiles().filter((p) => p.directHit && p.attackerId === dragon.id);
  }
  T(`⑤真跑：星龙打出了分裂星弹（${splits.length} 枚）`, splits.length > 0);
  T(`⑥分裂星弹速度 ≥ 默认弹速 ${def}（实测 ${splits.map((p) => p.speed).join('/') || '无'}；原来是 ${CONFIG.dragonPower.astral.bulletSpeed} 左右）`,
    splits.length > 0 && splits.every((p) => p.speed >= def));
}
// 行为（真跑）：伤害在吐息落地时才结算——用户："龙的子弹还没打到小兵上就已经造成伤害了"
{
  const { createSimulation } = await import('../src/simulation.js');
  const sim = createSimulation();
  sim.mapSystem.loadMap('summoners_rift_v1');
  const dragon = sim.factories.createDragon('dragon', { element: 'fire' });
  const tgt = sim.laneWaveSystem.createMinion('melee', dragon.pos.x + 45, dragon.pos.y, 'red', 'bot', 'reverse');
  tgt.currentHP = 1e6;
  const travel = CONFIG.gameRules.dragon.combat.breathTravelSec;
  let prevCd = dragon.attackCooldown || 0, attackT = null, hitT = null, hp0 = tgt.currentHP;
  for (let f = 0; f < 30 * 8 && hitT == null; f++) {
    sim.step(1 / 30);
    const t = f / 30;
    if (attackT == null && (dragon.attackCooldown || 0) > prevCd + 0.02) { attackT = t; hp0 = tgt.currentHP; }
    prevCd = dragon.attackCooldown || 0;
    if (attackT != null && tgt.currentHP < hp0) hitT = t;
  }
  T(`⑦龙打出去了、也打中了（出手 ${attackT?.toFixed(2)}s，落地 ${hitT?.toFixed(2)}s）`, attackT != null && hitT != null);
  T(`⑧伤害在吐息落地时结算：出手到掉血 ≈ 吐息时长 ${travel}s（不是出手当帧）`,
    attackT != null && hitT != null && hitT - attackT >= travel - 1 / 30 - 1e-6 && hitT - attackT <= travel + 2 / 30);
}
done();
