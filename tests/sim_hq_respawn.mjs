// Q11 / Q12：召唤水晶与枢纽防御塔的重生。
// Q11 用户："召唤水晶重生计时器不要在状态栏里显示了，而应该在属性栏的第二个法力栏中显示……应该显示XX%代表重生进度"
// Q12 用户："枢纽防御塔被摧毁后，将在3分钟后以40%最大生命值重生（每个防御塔仅一次），重生进度显示还是参考我上条说的"
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { resourceInfoOf, HIDDEN_STATUS_EFFECT_NAMES } = await import('../src/core/resourceBar.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { effectiveMaxHP } = await import('../src/core/factories.js');
const { T, done } = scoreboard('召唤水晶 / 枢纽防御塔重生');

const cfg = CONFIG.tuning.hqTowerRespawn;
T(`①参数软编码在 CONFIG.tuning.hqTowerRespawn（${cfg?.delaySec}s / ${cfg?.hpPct}% / ${cfg?.maxTimes} 次）`,
  cfg && cfg.enabled !== false && cfg.delaySec > 0 && cfg.hpPct > 0 && cfg.maxTimes >= 1);
T('②"重生中"不在状态栏显示（改在资源条）', HIDDEN_STATUS_EFFECT_NAMES.has('重生中'));

const sim = createSimulation();
sim.mapSystem.loadMap('summoners_rift_v1');
const ec = sim.entityContainer, ms = sim.mapSystem;
const res = (e) => resourceInfoOf(e, { skillLibrary: SkillLibrary, attrCalc: sim.attrCalc, effects: sim.effectRegistry });
const kill = (e) => { e.currentHP = 0; e.alive = false; sim.eventBus.emit('entity:death', { entityId: e.id }); };
const stepSec = (sec) => { for (let i = 0; i < sec * 10; i++) sim.step(0.1); };

const hq = ec.getAll(false).find((e) => e._mapTier === 'hq_tower' && e._mapFaction === 'blue');
T('③找到蓝方枢纽防御塔', !!hq);
if (hq) {
  kill(hq);
  T('④被摧毁后进入重生倒计时', !!hq._respawnAt && !hq.alive);
  stepSec(cfg.delaySec / 2);
  const r = res(hq);
  T(`⑤等待期间资源条显示重生进度（${r?.kind} ${r?.label}）`, r?.kind === 'respawn' && /^\d+%$/.test(r.label) && Math.abs(r.frac - 0.5) < 0.05);
  stepSec(cfg.delaySec / 2 - 2);
  T('⑥时间没到之前不复活', !hq.alive);
  stepSec(3);
  const mx = effectiveMaxHP(hq);
  T(`⑦到点复活，生命 ≈ ${cfg.hpPct}%（${Math.round(hq.currentHP)}/${Math.round(mx)}）`,
    hq.alive && Math.abs(hq.currentHP / mx - cfg.hpPct / 100) < 0.02);
  T('⑧复活后清掉废墟/损毁标记', !hq._ruin && !hq._respawnAt);
  kill(hq);
  stepSec(cfg.delaySec + 10);
  T('⑨每座塔只重生一次：第二次被拆不再复活', !hq.alive && !hq._respawnAt);
}
// 召唤水晶：等待期间资源条同样显示 XX%
{
  const nx = ec.getAll(false).find((e) => e._mapTier === 'nexus_lane' && e._mapFaction === 'red');
  T('⑩找到红方召唤水晶', !!nx);
  if (nx) {
    kill(nx);
    stepSec(30);
    const r = res(nx);
    T(`⑪召唤水晶等待重生时资源条显示 XX%（${r?.label}）`, r?.kind === 'respawn' && /^\d+%$/.test(r.label) && r.frac > 0 && r.frac < 1);
  }
}
done();
