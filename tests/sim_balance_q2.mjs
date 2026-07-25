// Q2 平衡改动验收：成长表软编码 + 屠戮基数语义 + 地图覆写预留。
//
// 用户目标：「30分钟前塔占优势，之后小兵占优势」，且「尽量让防御塔参加的时间变长」。
// 量出来的根因：屠戮基数取"自身当前生命"，而生命也随波次成长，两者同步 →
// 兵杀兵所需时间永远恒定 14.4s。波间隔 30s，于是两波兵永远在半个周期内互相清完、
// 永远聚不起来，高地就永远推不动。
// 改法：基数改取「模板基础生命」（不随成长膨胀）+ 双抗成长 0.1 → 0.5/波（近战）。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0 };
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { summoners_rift: SR } = await import('../src/data/maps/summoners_rift.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ---- ① 软编码落点 ----
T('成长表住在 CONFIG.battleGrowth（不再是 main.js 的硬编码常量）',
  !!CONFIG.battleGrowth && typeof CONFIG.battleGrowth.melee?.res === 'number');
T('屠戮参数住在 CONFIG.rend',
  !!CONFIG.rend && typeof CONFIG.rend.melee?.pct === 'number' && !!CONFIG.rend.melee?.base);
import fs from 'fs';
const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
T('main.js 不再持有 BATTLE_GROWTH_FLAT 常量', !mainSrc.includes('BATTLE_GROWTH_FLAT ='));
T('成长取值支持 map.minionGrowth 覆写（同一兵种可跨地图不同）',
  mainSrc.includes('minionGrowth'));

// ---- ② 双抗成长确实起来了 ----
const resAt = (type, wave) => CONFIG.templates[type].armor + CONFIG.battleGrowth[type].res * (wave - 1);
T(`近战双抗 60 分钟(第120波) 达到 ~75（旧值 0.1/波 只有 27）`, Math.round(resAt('melee', 120)) >= 60);
T('超级兵双抗【不跟这轮提升】（它只在收尾阶段出场，提了会让收尾更快）',
  CONFIG.battleGrowth.super.res <= 0.2);

// ---- ③ 屠戮基数语义：不随生命成长膨胀 ----
const def = SkillLibrary.get('passive_melee_rend');
function rendDamage(attackerHP, params) {
  const dealt = [];
  const A = { id: 1, type: 'melee', alive: true, pos: { x: 0, y: 0 },
              baseStats: { ...CONFIG.templates.melee, maxHP: attackerHP }, currentHP: attackerHP, _skillInstances: [] };
  const B = { ...A, id: 2 };
  const ctx = { entityContainer: { get: (i) => (i === 1 ? A : B) },
                combat: { performAttackDirect: (a, b, dmg) => dealt.push(dmg) } };
  def.onHit(1, 2, { state: {}, _params: params }, ctx);
  return dealt[0] || 0;
}
const base = CONFIG.templates.melee.maxHP;
const d1 = rendDamage(base), d2 = rendDamage(base * 3);
T(`屠戮伤害不随自身生命膨胀（${d1} vs 生命×3 时 ${d2}）`, Math.abs(d1 - d2) < 1e-6);
T(`屠戮伤害 = 模板基础生命 × ${CONFIG.rend.melee.pct * 100}%`,
  Math.abs(d1 - base * CONFIG.rend.melee.pct) < 1e-6);

// ---- ④ 地图覆写预留：数值与【机制】都能按地图改 ----
T('地图可覆写屠戮百分比', Math.abs(rendDamage(base, { pct: 0.10, base: 'template' }) - base * 0.10) < 1e-6);
T('地图可把基数机制切回 current（同一技能在不同地图上机制不同）',
  Math.abs(rendDamage(base * 3, { pct: 0.04, base: 'current' }) - base * 3 * 0.04) < 1e-6);
T('屠戮声明了 defaultParams（否则 CombatSystem 不会注入地图覆写）', !!def.defaultParams);
const combatSrc = fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');
T('地图覆写注入不再局限于 onFrame 技能（屠戮只有 onHit）',
  combatSrc.indexOf('_mapOverrides') < combatSrc.indexOf('if (def && def.onFrame)'));

// ---- ⑤ 文案跟着基数走 ----
T('屠戮文案写的是"基础生命"而不是"当前生命"',
  def.description.includes('基础生命') && !def.description.includes('当前生命'));

// ---- ⑥ 枢纽塔魔抗（用户定稿：护甲70 / 魔抗110）----
T('枢纽塔 护甲70 / 魔抗110',
  SR.tierStats.hq_tower.armor === 70 && SR.tierStats.hq_tower.magicResist === 110);

// ---- ⑦ 节奏：塔清完一波的耗时应在 ~25~35 分钟越过波间隔 ----
const dmgMul = (r) => (r >= 0 ? 100 / (100 + r) : 2 - 100 / (100 - r));
function towerClearSeconds(mins) {
  const wave = Math.max(1, Math.floor(mins * 60 / 30));
  const n = wave - 1;
  const hp = CONFIG.templates.melee.maxHP + CONFIG.battleGrowth.melee.hp * n;
  const res = CONFIG.templates.melee.armor + CONFIG.battleGrowth.melee.res * n;
  const towerAD = Math.min(278, 152 + 9 * Math.min(Math.max(0, Math.floor(mins - 0.7) + 1), 15));
  return (hp / (towerAD * 0.833 * dmgMul(res))) * 6;   // 一波 6 个
}
let cross = null;
for (let m = 1; m <= 60; m++) if (cross === null && towerClearSeconds(m) > 30) cross = m;
console.log(`  塔清完一波的耗时越过波间隔(30s) 的时间点 = 第 ${cross} 分钟`);
T(`塔优势期覆盖到 20 分钟以后（实测转折点 ${cross} 分钟）`, cross >= 20);
T(`塔并非永远碾压（转折点 ${cross} 分钟 ≤ 40）`, cross <= 40);

console.log(`Q2 平衡验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
