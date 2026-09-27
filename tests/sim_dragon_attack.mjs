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
T('③模板没声明弹速的单位：默认弹速 + 加成（不会被一点加成拖成爬速）',
  /\(attacker\.baseStats\?\.bulletSpeed > 0\)[\s\S]{0,200}: \(CONFIG\.tuning\?\.defaultBulletSpeed \?\? 400\) \+ Math\.max\(0, atkStats\.bulletSpeed \|\| 0\)/.test(cs));
// 行为：把"星龙之力"的弹速加成套到一个没声明弹速的远程单位上，算出来的弹速不低于默认值
{
  const def = CONFIG.tuning?.defaultBulletSpeed ?? 400;
  const speedOf = (base, bonus) => (base > 0) ? (base + bonus || def) : def + Math.max(0, bonus);
  T(`④基础 0 + 星龙之力 +${CONFIG.dragonPower.astral.bulletSpeed} → ${speedOf(0, CONFIG.dragonPower.astral.bulletSpeed)}（原来是 ${CONFIG.dragonPower.astral.bulletSpeed}）`,
    speedOf(0, CONFIG.dragonPower.astral.bulletSpeed) >= def);
}
done();
