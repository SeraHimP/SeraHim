// Q7：负生命恢复 → 持续真实伤害；最大生命缩减 → 血条右端灰色斜纹；所有扣血记进受伤统计。
// 用户："所有减少生命恢复直至负的技能或者是状态……一律改制为造成的真实伤害（不受自身的任何防御措施），
//        生命恢复永远大于等于0"；追加："所有的扣血都走伤害统计，然后所有的最大生命值缩减……进度条的
//        最大生命还是原先的，但是被扣除的最大生命值在血条的右面用灰色的斜条纹代表"。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { reduceMaxHP } = await import('../src/core/damageAttribution.js');
const { hpBarLayout } = await import('../src/core/resourceBar.js');
const { T, done } = scoreboard('负恢复转真实伤害 + 最大生命缩减');

const sim = createSimulation();
sim.mapSystem.loadMap('summoners_rift_v1');
// 放在地图正中（离两边基地都远，不吃基地光环的回血）
const W = sim.mapSystem.currentMap.world;
const mk = () => {
  const e = sim.factories.createMinion('melee', W.w / 2, W.h / 2, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
  e.baseStats.moveSpeed = 0; e._skillInstances = [];
  return e;
};
const calc = (e) => { sim.attrCalc.tick(); return sim.attrCalc.calc(e, sim.effectRegistry.getEffects(e.id)); };

// ① 负的固定值生命恢复效果：不压低生命恢复，转成真实伤害/秒
{
  const e = mk();
  e.baseStats.healthRegen = 4;
  sim.effectRegistry.apply(e.id, { name: '测试腐化', icon: '☠', kind: 'stat', statKey: 'healthRegen', flatValue: -6, duration: 30 }, 'test');
  const st = calc(e);
  T(`①生命恢复不被负效果抵消、也不为负（${st.healthRegen}）`, st.healthRegen === 4);
  T(`②负效果全额转成持续真实伤害（${st._regenDrain}/秒）`, Math.abs(st._regenDrain - 6) < 1e-9);
}
// ③ 模板/编辑器写成负数的基础生命恢复：同样转成真实伤害，恢复为 0
{
  const e = mk();
  e.baseStats.healthRegen = -3;
  const st = calc(e);
  T(`③负的基础生命恢复 → 恢复 0、真实伤害 3/秒（${st.healthRegen} / ${st._regenDrain}）`, st.healthRegen === 0 && Math.abs(st._regenDrain - 3) < 1e-9);
}
// ④ 真跑：掉血量 ≈ 伤害/秒 × 时长，不吃护盾；记进受伤统计（真实伤害、归到"持续真实伤害"）
{
  const e = mk();
  e.baseStats.healthRegen = 0; e.baseStats.armor = 500; e.baseStats.magicResist = 500;
  e.currentHP = e.baseStats.maxHP;
  e.tempShield = 1000;
  sim.effectRegistry.apply(e.id, { name: '测试腐化', icon: '☠', kind: 'stat', statKey: 'healthRegen', flatValue: -10, duration: 30 }, 'test');
  const hp0 = e.currentHP;
  for (let i = 0; i < 120; i++) sim.step(1 / 60);
  const lost = hp0 - e.currentHP;
  const dealt = e._dmgTaken?.true || 0;
  T(`④2 秒造成 ≈ 20 真实伤害（实测 ${dealt.toFixed(2)}），不被护甲/护盾挡（临时护盾仍有 ${Math.round(e.tempShield)}）`, Math.abs(dealt - 20) < 1.5 && e.tempShield > 0);
  T(`⑤生命确实掉了（${lost.toFixed(2)}）`, lost > 15);
  T('⑥按来源归类为"持续真实伤害"', e._dmgByAttacker?.get('env:regenDrain')?.total > 0);
}
// ⑦ 天气负恢复：同一条结算口，归类为"天气"
{
  const sim2 = createSimulation(); sim2.mapSystem.loadMap('summoners_rift_v1');
  const fakeWeather = { enabled: true, getWeights: () => ({ sun: 1 }), getModifiers: () => ({ healthRegen: { flat: -3, percent: 0 } }) };
  sim2.attrCalc.setWeatherSystem(fakeWeather);
  const e = sim2.factories.createMinion('melee', 300, 3300, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
  e.baseStats.moveSpeed = 0; e.baseStats.healthRegen = 0; e._skillInstances = [];
  const st = sim2.attrCalc.calc(e, sim2.effectRegistry.getEffects(e.id));
  T(`⑦天气负恢复：生命恢复不为负（${st.healthRegen}），天气真实伤害 3/秒`, st.healthRegen >= 0 && Math.abs(st._weatherDrain - 3) < 1e-9);
  for (let i = 0; i < 60; i++) sim2.step(1 / 60);
  T('⑧天气扣血记进受伤统计，归类"天气"', e._dmgByAttacker?.get('env:weather')?.total > 2);
  sim2.attrCalc.setWeatherSystem(null);
}
// ⑨ 最大生命缩减：缩上限、记 _maxHPLost、被削掉的当前血算真实伤害
{
  const e = mk();
  e.baseStats.maxHP = 1000; e.currentHP = 1000;
  const cut = reduceMaxHP(e, 200, { key: 'env:test', label: '测试' }, null);
  T(`⑨上限 1000 → 800，_maxHPLost = 200（${e.baseStats.maxHP} / ${e._maxHPLost}）`, cut === 200 && e.baseStats.maxHP === 800 && e._maxHPLost === 200);
  T(`⑩被削掉的 200 当前生命记为真实伤害（${e._dmgTaken?.true}）`, e._dmgTaken?.true === 200 && e.currentHP === 800);
  const L = hpBarLayout(e, 800);
  T(`⑪血条总长按原最大生命算：生命段 0.8，斜纹段 0.2（${L.hp.toFixed(3)} / ${L.lostFrac.toFixed(3)}）`, Math.abs(L.hp - 0.8) < 1e-9 && Math.abs(L.lostFrac - 0.2) < 1e-9);
  e.currentHP = 400;
  const L2 = hpBarLayout(e, 800);
  T('⑫半血时生命段 0.4，斜纹段仍从 0.8 开始', Math.abs(L2.hp - 0.4) < 1e-9 && Math.abs(L2.cap - 0.8) < 1e-9);
}
// ⑬ 没有缩减时布局与改动前的公式逐位一致（HP+护盾超过 1 时整体按比例压缩）
{
  const e = { currentHP: 700, shieldFixedCurrent: 300, tempShield: 200, plainShield: 0 };
  const L = hpBarLayout(e, 1000);
  const total = 0.7 + 0.3 + 0.2, sc = 1 / total;
  T('⑬无缩减：与旧公式一致', L.cap === 1 && L.lostFrac === 0 && L.hp === 0.7 * sc && L.sf === 0.3 * sc && L.st === 0.2 * sc);
}
// ⑭ 两处缩上限的来源（过载被动、热寂光环）都走 reduceMaxHP；面板与画面血条都用 hpBarLayout
{
  const tp = fs.readFileSync(new URL('../src/core/skills/towerPassives.js', import.meta.url), 'utf8');
  const ms = fs.readFileSync(new URL('../src/systems/MapSystem.js', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url), 'utf8');
  const ul = fs.readFileSync(new URL('../src/presentation/UnitLayer.js', import.meta.url), 'utf8');
  T('⑭过载与热寂都调用 reduceMaxHP', /reduceMaxHP\(e, hpLoss/.test(tp) && /reduceMaxHP\(e, loss/.test(ms));
  T('⑮面板卡片与画面血条都用 hpBarLayout 算宽度', (ui.match(/hpBarLayout\(/g) || []).length >= 2 && /hpBarLayout\(e, maxHP\)/.test(ul));
  T('⑯斜纹颜色软编码在 CONFIG.ui.maxHpLostBar', !!CONFIG.ui.maxHpLostBar?.stripeA && !!CONFIG.ui.maxHpLostBar?.stripeB);
}
done();
