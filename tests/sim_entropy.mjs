// P5 熵/三核系统验收。
//
// 熵是第一个【非对称】机制：它会让蓝红两方在同一局里拿到不同的数值。
// 这类机制最危险的不是"算错了"，而是"悄悄生效了"——所以第一条断言依然是
// 耦合全关时零影响，然后才验证打开后的方向、幅度、可解释性，
// 最后钉住三道防滚雪球的刹车确实存在。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
const { CONFIG } = await import('../src/data/Config.js');
const { EntropySystem } = await import('../src/systems/EntropySystem.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { EventBus } = await import('../src/utils/EventBus.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const E = () => CONFIG.world.entropy;
const mkUnit = (fac) => ({
  id: 1, type: 'melee', alive: true, pos: { x: 0, y: 0 },
  baseStats: { ...CONFIG.templates.melee }, currentHP: 500,
  _skillInstances: [], _mapFaction: fac, faction: fac,
});

// ---- ① 耦合全关 → 零影响（最重要的一条）----
T('entropyToUnits 默认关闭', CONFIG.world.couplings.entropyToUnits === false);
T('entropyToDayNight 默认关闭', CONFIG.world.couplings.entropyToDayNight === false);

const bus0 = new EventBus();
const w0 = new WorldState({ bus: bus0 });
AttributeCalculator.setWorldState(null);
AttributeCalculator.tick();
const before = { ...AttributeCalculator.calc(mkUnit('red'), []) };
AttributeCalculator.setWorldState(w0);
// 制造大量极化事件，熵应该被推到极值
for (let i = 0; i < 500; i++) bus0.emit('entity:death', { entity: { type: 'melee', _mapFaction: 'blue' } });
w0.update(0.1, 0);
AttributeCalculator.tick();
const after = { ...AttributeCalculator.calc(mkUnit('red'), []) };
const drift = Object.keys(before).filter(k => typeof before[k] === 'number' && Math.abs(before[k] - after[k]) > 1e-9);
T(`熵已偏离中性（${w0.entropy.value.toFixed(2)}）但耦合关闭时属性零漂移（${drift.length} 项）`,
  w0.entropy.value > 0.6 && drift.length === 0);

// ---- ② 归因方向：算【击杀方】不是死亡方 ----
// 按死亡方记会把语义反过来——被打崩的一方反而推高自己的核。
const e1 = new EntropySystem();
e1.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });   // 蓝方单位死 = 红方击杀
T('蓝方单位阵亡 → 黑核（混乱侧）增长', e1.black > 0 && e1.white === 0);
const e2 = new EntropySystem();
e2.onDeath({ entity: { type: 'melee', _mapFaction: 'red' } });
T('红方单位阵亡 → 白核（秩序侧）增长', e2.white > 0 && e2.black === 0);
T('红核不分阵营，两种情况都增长', e1.red > 0 && e2.red > 0 && Math.abs(e1.red - e2.red) < 1e-9);

// ---- ③ 熵值方向与量级 ----
T(`红方压制 → 熵 > 0.5（${e1.value.toFixed(3)}）`, e1.value > 0.5);
T(`蓝方压制 → 熵 < 0.5（${e2.value.toFixed(3)}）`, e2.value < 0.5);
const e3 = new EntropySystem();
T('无事件时熵为中性', Math.abs(e3.value - 0.5) < 1e-9);
const e4 = new EntropySystem();
e4.onDeath({ entity: { type: 'tower', _mapFaction: 'blue' } });
T(`摧毁建筑的权重远高于小兵（${e4.black} vs ${e1.black}）`, e4.black === E().gainTower && e4.black > e1.black);

// ---- ④ 巨龙【反向】压回中性（报告："秩序压制混乱"）----
// 从一个已经极化的局面出发才测得出来：核值有 0 下限，空系统里没有东西可压。
const e5 = new EntropySystem();
for (let i = 0; i < 60; i++) e5.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });
const polarized = e5.value;
e5.onDeath({ entity: { type: 'dragon', _mapFaction: 'blue' } });  // 红方击杀龙
T(`红方击杀巨龙反而降低自身极化（${polarized.toFixed(3)} → ${e5.value.toFixed(3)}）`,
  e5.value < polarized);
// 对照：同一局面下普通击杀是【提高】极化的，方向确实相反
const e5b = new EntropySystem();
for (let i = 0; i < 60; i++) e5b.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });
e5b.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });
T('对照：普通击杀提高极化（龙与之方向相反）', e5b.value > polarized);
T('核值不会被压成负数', e5.black >= 0 && e5.white >= 0);

// ---- ⑤ 三道刹车必须都在 ----
// 这个模型天然带正反馈（多杀→变强→杀更多），没有刹车就会滚雪球。
const e6 = new EntropySystem();
for (let i = 0; i < 100000; i++) e6.onDeath({ entity: { type: 'tower', _mapFaction: 'blue' } });
T(`刹车①上限：极端堆核也不会突破 clampMax（${e6.value}）`, e6.value <= E().clampMax + 1e-9);
const e7 = new EntropySystem();
for (let i = 0; i < 100000; i++) e7.onDeath({ entity: { type: 'tower', _mapFaction: 'red' } });
T(`刹车①下限：不会突破 clampMin（${e7.value}）`, e7.value >= E().clampMin - 1e-9);

const e8 = new EntropySystem();
for (let i = 0; i < 50; i++) e8.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });
const peak = e8.value;
for (let i = 0; i < 3000; i++) e8.update(1 / 30);       // 100 秒无事发生
T(`刹车②衰减：停止交火后熵回落（${peak.toFixed(3)} → ${e8.value.toFixed(3)}）`, e8.value < peak);
T('刹车②衰减最终回到中性', Math.abs(e8.value - 0.5) < 1e-6);
T('刹车③加成幅度可配且不大', CONFIG.world.entropyBonus.attackDamagePct <= 15);
T('三核的每一项都软编码', ['scale', 'decayPerSec', 'clampMin', 'clampMax', 'gainMinion',
  'gainTower', 'gainDragon', 'redFromConflict', 'volatilityPct', 'nightStretchPct']
  .every(k => typeof E()[k] === 'number'));

// ---- ⑥ 红核只放大幅度、不改变方向 ----
const e9 = new EntropySystem();
T('无冲突时波动系数为 1', Math.abs(e9.volatility - 1) < 1e-9);
for (let i = 0; i < 1000; i++) e9.onDeath({ entity: { type: 'melee', _mapFaction: 'blue' } });
T(`高烈度下波动系数 > 1（${e9.volatility.toFixed(3)}）`, e9.volatility > 1);
T('波动系数有上限（红核饱和）', e9.volatility <= 1 + E().volatilityPct / 100 + 1e-9);

// ---- ⑦ 打开耦合：方向正确、另一方镜像、可解释 ----
CONFIG.world.couplings.entropyToUnits = true;
const busA = new EventBus();
const wA = new WorldState({ bus: busA });
AttributeCalculator.setWorldState(wA);
for (let i = 0; i < 300; i++) busA.emit('entity:death', { entity: { type: 'melee', _mapFaction: 'blue' } });
wA.update(0.1, 0);
AttributeCalculator.tick();
const redHi = AttributeCalculator.calc(mkUnit('red'), []);
AttributeCalculator.tick();
const blueHi = AttributeCalculator.calc(mkUnit('blue'), []);
const baseAD = CONFIG.templates.melee.attackDamage;
T(`高熵：红方（混乱）拿到加成 ${redHi.attackDamage.toFixed(1)} > ${baseAD}`, redHi.attackDamage > baseAD);
T(`高熵：蓝方（秩序）受罚 ${blueHi.attackDamage.toFixed(1)} < ${baseAD}`, blueHi.attackDamage < baseAD);
T('两方修正互为镜像（同幅反向）',
  Math.abs((redHi.attackDamage - baseAD) + (blueHi.attackDamage - baseAD)) < 1e-6);

const rows = wA.getBreakdown(mkUnit('red'));
const erow = rows.find(r => r.source.startsWith('熵'));
T('getBreakdown 说得出三核构成与最终加成', !!erow && /黑核/.test(erow.detail) && /攻击力/.test(erow.detail));
console.log('  ' + wA.entropySystem.describe());

// ---- ⑧ 熵值进缓存键：熵变了属性必须跟着变 ----
wA.entropySystem.reset();
wA.update(0.1, 0);
AttributeCalculator.tick();
const redNeutral = AttributeCalculator.calc(mkUnit('red'), []);
T('熵回落后属性缓存正确失效', Math.abs(redNeutral.attackDamage - redHi.attackDamage) > 1e-6);

// ---- ⑨ 熵 → 昼夜：拉长夜晚而不是拖慢一切 ----
CONFIG.world.couplings.entropyToUnits = false;
CONFIG.world.couplings.entropyToDayNight = true;
const busB = new EventBus();
const wB = new WorldState({ bus: busB });
const { DAY_PERIOD } = await import('../src/presentation/DayNight.js');
// 中性熵：相位应与未拉伸时一致
wB.update(0.1, DAY_PERIOD * 0.25);
T(`中性熵不改变相位（${wB.daynight.phase.toFixed(3)} ≈ 0.25）`, Math.abs(wB.daynight.phase - 0.25) < 1e-6);
// 高熵：同一时刻应更偏向夜晚
for (let i = 0; i < 300; i++) busB.emit('entity:death', { entity: { type: 'melee', _mapFaction: 'blue' } });
wB.update(0.1, DAY_PERIOD * 0.45);
const hiPhase = wB.daynight.phase;
wB.entropySystem.reset();
wB.update(0.1, DAY_PERIOD * 0.45);
T(`高熵时同一时刻相位更晚（${hiPhase.toFixed(3)} > ${wB.daynight.phase.toFixed(3)}）`,
  hiPhase > wB.daynight.phase);
T('周期总长不变（相位仍在 0..1）', hiPhase >= 0 && hiPhase < 1);

// 还原，避免污染同进程内其它用例
CONFIG.world.couplings.entropyToDayNight = false;
CONFIG.world.couplings.entropyToUnits = false;
AttributeCalculator.setWorldState(null);

console.log(`熵/三核验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
