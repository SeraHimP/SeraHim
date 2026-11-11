// Q5：攻城车部分重做。用户："对防御塔造成150%伤害，攻击目标时，攻城车攻击的目标距离越远，造成的伤害越高，
// 在满射程下+350%伤害（指数级衰减，行军/攻城模式下都生效）"。曲线定稿"越远涨得越快"，与对塔倍率"相加"。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { ramRangeBonus, ramDamageMult } = await import('../src/systems/CombatSystem.js');
const { T, done } = scoreboard('攻城车距离加伤');

const R = CONFIG.gameRules.ram;
const max = R.rangeBonusMaxPct / 100;
T(`①参数软编码：对塔 ${R.siegeDamagePct}%、满射程 +${R.rangeBonusMaxPct}%、曲线 k=${R.rangeBonusCurveK}`,
  R.siegeDamagePct > 100 && R.rangeBonusMaxPct > 0 && Number.isFinite(R.rangeBonusCurveK));
T('②贴脸没有加成、满射程正好是满额', ramRangeBonus(0) === 0 && Math.abs(ramRangeBonus(1) - max) < 1e-9);
T('③超出满射程按满射程算（不会继续涨）', Math.abs(ramRangeBonus(1.3) - max) < 1e-9);
const pts = [0.1, 0.25, 0.5, 0.75, 0.9].map(ramRangeBonus);
T('④距离越远加成越高（单调递增）', pts.every((v, i) => i === 0 || v > pts[i - 1]));
T(`⑤"越远涨得越快"：半射程处加成低于满额的一半（${(ramRangeBonus(0.5) * 100).toFixed(0)}% < ${(max * 50).toFixed(0)}%）`,
  ramRangeBonus(0.5) < max / 2);
T('⑥后半程的增量大于前半程', ramRangeBonus(1) - ramRangeBonus(0.5) > ramRangeBonus(0.5) - ramRangeBonus(0));

const tower = { type: 'tower' }, minion = { type: 'melee' };
T(`⑦满射程打塔：与对塔倍率相加（${ramDamageMult(tower, 1)} = ${R.siegeDamagePct / 100} + ${max}）`,
  Math.abs(ramDamageMult(tower, 1) - (R.siegeDamagePct / 100 + max)) < 1e-9);
T('⑧贴脸打塔 = 对塔倍率本身', Math.abs(ramDamageMult(tower, 0) - R.siegeDamagePct / 100) < 1e-9);
T('⑨打非建筑也吃距离加伤（行军/普通模式同样生效）',
  Math.abs(ramDamageMult(minion, 1) - (1 + R.normalDamageAmpPct / 100 + max)) < 1e-9);

const cs = fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');
T('⑩距离在开火那一刻快照进 hitInfo（子弹飞行中不随目标移动变化）', /ramRangeT: hasRamCannon\(attacker\)/.test(cs));
T('⑪主命中按 ramDamageMult 结算，溅射把这份倍率除回去（额外增幅只作用于主目标）',
  /const ramMult = hasRamCannon\(attacker\) \? ramDamageMult\(target, hitInfo\.ramRangeT\) : 1;/.test(cs)
  && /const siegeMult = \(chargeP \? chargeP\.damageMult : 1\) \* ramMult;/.test(cs));
done();
