// Q4：术士兵重做为"三连咒击"。
// 用户："术士兵改为没有蓝条，但是显示为攻击充能形式，术士兵每3次攻击，第三次攻击附带55%护甲穿透并永久获得
// 1法术强度（最高70），属性面板上进度条的显示方式是三个分块组成的进度条，每攻击一次就填充一个块，第三个块是
// 其他颜色并且攻击时触发特效，之后块进度条清零，开始下一周期。"
// 追问定稿：穿透护甲+魔法都给；"最高70"是这个被动累计最多 +70；只留新被动 + 屠戮。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
const { resourceInfoOf } = await import('../src/core/resourceBar.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { T, done } = scoreboard('术士兵三连咒击');

const C = CONFIG.gameRules.supportUnits.warlock;
T(`①参数软编码（每 ${C.triadEvery} 下、穿透 ${C.triadPenPct}%、法强 +${C.triadApGain}、累计上限 ${C.triadApMax}）`,
  C.triadEvery === 3 && C.triadPenPct === 55 && C.triadApGain === 1 && C.triadApMax === 70);
T('②默认技能只有三连咒击 + 屠戮', JSON.stringify(DEFAULT_MINION_PASSIVES.warlock) === JSON.stringify(['passive_warlock_triad', 'passive_warlock_rend']));
T('③没有蓝条（模板法力上限 0）', CONFIG.templates.warlock.maxMana === 0);

const sim = createSimulation();
sim.mapSystem.loadMap('summoners_rift_v1');
const W = sim.mapSystem.currentMap.world;
const wl = sim.factories.createMinion('warlock', W.w / 2, W.h / 2, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
const dummy = sim.factories.createMinion('melee', W.w / 2 + 120, W.h / 2, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
wl.baseStats.moveSpeed = 0; dummy.baseStats.moveSpeed = 0; dummy.baseStats.maxHP = dummy.currentHP = 1e7;
T('④实际生成的术士兵带着三连咒击', (wl._skillInstances || []).some((i) => i.skillId === 'passive_warlock_triad'));
const res = () => resourceInfoOf(wl, { skillLibrary: SkillLibrary, attrCalc: sim.attrCalc, effects: sim.effectRegistry });
const r0 = res();
T(`⑤资源条是 3 格分块的攻击充能（${r0?.kind} ${r0?.label}，${r0?.segments} 格）`, r0?.kind === 'triad' && r0.segments === 3 && r0.label === '0/3');

// 抓每一发开火的 hitInfo 快照
const shots = [];
const orig = sim.combatSystem.projectiles.fire.bind(sim.combatSystem.projectiles);
sim.combatSystem.projectiles.fire = (p) => { if (p.attackerId === wl.id && p.pendingHit) shots.push({ ...p.pendingHit, cnt: wl._triadCount, res: res() }); return orig(p); };
const ap0 = wl.baseStats.abilityPower;
const basePen = sim.attrCalc.calc(wl, sim.effectRegistry.getEffects(wl.id));
for (let i = 0; i < 60 * 30 && shots.length < 6; i++) sim.step(1 / 60);
T(`⑥打出了 6 发（${shots.length}）`, shots.length >= 6);
const emp = shots.map((s) => !!s.triadEmpowered);
T(`⑦每 3 发第 3 发是强化攻击（${emp.map((b) => (b ? '■' : '□')).join('')}）`, emp.slice(0, 6).join() === [false, false, true, false, false, true].join());
const s3 = shots[2], s1 = shots[0];
T(`⑧强化攻击额外 +55% 护甲穿透与魔法穿透（${s1?.armorPenPercent}→${s3?.armorPenPercent} / ${s1?.magicPenPercent}→${s3?.magicPenPercent}）`,
  s3 && Math.abs(s3.armorPenPercent - Math.min(100, (basePen.armorPenPercent || 0) + 55)) < 1e-9
  && Math.abs(s3.magicPenPercent - Math.min(100, (basePen.magicPenPercent || 0) + 55)) < 1e-9);
T('⑨普通的前两发不加穿透', s1 && s1.armorPenPercent === (basePen.armorPenPercent || 0));
T(`⑩每次强化攻击永久 +1 法术强度（${ap0} → ${wl.baseStats.abilityPower}）`, wl.baseStats.abilityPower === ap0 + 2 && wl._triadApGained === 2);
T('⑪第一发后填 1 格、第二发后 2 格、强化攻击后清零', shots[0].res.label === '1/3' && shots[1].res.label === '2/3' && shots[2].res.label === '0/3');
T('⑫强化攻击那一刻资源条闪光', shots[2].res.flash === true && shots[0].res.flash === false);

// 累计上限
{
  const def = SkillLibrary.passive_warlock_triad;
  const e = { baseStats: { abilityPower: 0 }, _triadApGained: C.triadApMax - 0.5 };
  for (let k = 0; k < 9; k++) def.onAttackFired(e, null, {}, {});
  T(`⑬累计获得的法强封顶 ${C.triadApMax}（${e._triadApGained}）`, e._triadApGained === C.triadApMax);
}
// 面板/画面都画分块
{
  const ui = fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url), 'utf8');
  const ul = fs.readFileSync(new URL('../src/presentation/UnitLayer.js', import.meta.url), 'utf8');
  T('⑭面板资源条按格画（前几格一色、最后一格另一色）并有分隔线与闪光', /info\.segments > 1/.test(ui) && /_updateResSegments\(row, info\)/.test(ui));
  T('⑮画面血条下的资源细条也按格画', /resInfo\.segments > 1/.test(ul));
}
done();
