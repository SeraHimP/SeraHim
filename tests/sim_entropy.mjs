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

// ---- ① 熵的耦合全关 → 零影响（最重要的一条）----
T('entropyToUnits 默认关闭', CONFIG.world.couplings.entropyToUnits === false);
T('entropyToDayNight 默认关闭', CONFIG.world.couplings.entropyToDayNight === false);
// 昼夜默认【开】（用户定稿），它会给小兵加成 —— 本套是验熵的，
// 不关掉的话昼夜的加成会混进"零漂移"和"两方镜像"两条断言里，测出来的就不是熵了。
const _dayNight0 = CONFIG.world.couplings.dayNight;
CONFIG.world.couplings.dayNight = false;

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

// ---- ② 不变量：三核总数恒为 8（用户定稿）----
// 这是整个模型的地基。总数一旦能变，"滚雪球不可能"的论证就失效了，
// 所以任何操作之后都要成立 —— 包括推满、抢空、归还、归零之后。
const CFG = () => CONFIG.world.entropy;
const inv = (e) => e.black + e.white + e.red === CFG().coreTotal;
const kills = (e, n, victimFac, type = 'melee') => {
  for (let i = 0; i < n; i++) e.onDeath({ entity: { type, _mapFaction: victimFac } });
};
// 攒满一颗核需要的小兵击杀数
const PER = Math.ceil(CFG().chargePerCore / CFG().gainMinion);

{
  const e = new EntropySystem();
  T(`开局 8 颗全未归属（黑0/白0/红${e.red}）`, e.black === 0 && e.white === 0 && e.red === CFG().coreTotal);
  T('开局熵为中性', Math.abs(e.value - 0.5) < 1e-9);
  T('开局满足总数不变量', inv(e));
}

// ---- ③ 争夺：攒满充能才夺一颗核，且优先从未归属里拿 ----
{
  const e = new EntropySystem();
  kills(e, PER - 1, 'blue');                    // 蓝方单位阵亡 = 红方击杀
  T(`充能未满时一颗核都不动（还差 1 杀，黑${e.black}）`, e.black === 0 && e.value === 0.5);
  T('充能进度可读（供 UI 画进度条）', e.chargeProgress('black') > 0.9 && e.chargeProgress('black') < 1);
  kills(e, 1, 'blue');
  T(`充能攒满 → 夺得一颗核（黑${e.black}/白${e.white}/红${e.red}）`,
    e.black === 1 && e.red === CFG().coreTotal - 1);
  T('夺核后总数不变', inv(e));
  T(`一颗核 = ${(100 / (2 * CFG().coreTotal)).toFixed(2)}% 的熵（${(e.value * 100).toFixed(2)}%）`,
    Math.abs(e.value - (0.5 + 1 / (2 * CFG().coreTotal))) < 1e-9);
}

// ---- ④ 归因方向：算【击杀方】不是死亡方 ----
// 按死亡方记会把语义反过来 —— 被打崩的一方反而推高自己的核。
{
  const a = new EntropySystem(); kills(a, PER, 'blue');
  T(`蓝方单位阵亡 → 黑核（混乱侧）拿到核，熵升高（${(a.value * 100).toFixed(1)}%）`,
    a.black === 1 && a.white === 0 && a.value > 0.5);
  const b = new EntropySystem(); kills(b, PER, 'red');
  T(`红方单位阵亡 → 白核（秩序侧）拿到核，熵降低（${(b.value * 100).toFixed(1)}%）`,
    b.white === 1 && b.black === 0 && b.value < 0.5);
}

// ---- ⑤ 建筑权重远高于小兵 ----
{
  const a = new EntropySystem(); kills(a, 1, 'blue', 'tower');
  const b = new EntropySystem(); kills(b, 1, 'blue', 'melee');
  T(`摧毁建筑的充能远高于击杀小兵（${CFG().gainTower} vs ${CFG().gainMinion}）`,
    a.chargeProgress('black') > b.chargeProgress('black') * 5);
}

// ---- ⑥ 红核拿光后必须从对方手里抢（后期是真拉锯）----
{
  const e = new EntropySystem();
  kills(e, PER * CFG().coreTotal, 'red');        // 蓝方连夺 8 颗
  T(`蓝方可以拿满全部 ${CFG().coreTotal} 颗（白${e.white}/红${e.red}）`,
    e.white === CFG().coreTotal && e.red === 0);
  T('拿满时熵到达下限 0（绝对秩序）', Math.abs(e.value - 0) < 1e-9);
  T('拿满后总数仍不变', inv(e));
  // 再杀也不该溢出
  kills(e, PER * 3, 'red');
  T('已拿满后继续击杀不会溢出（核数不超过总数）',
    e.white === CFG().coreTotal && inv(e));
  // 现在红方开始抢
  kills(e, PER, 'blue');
  T(`红核为 0 时从对方手里抢（白 ${CFG().coreTotal} → ${e.white}，黑 ${e.black}）`,
    e.white === CFG().coreTotal - 1 && e.black === 1);
  T('抢核后总数不变', inv(e));
}

// ---- ⑦ 均值回复：优势方的核会被慢慢归还 ----
{
  const e = new EntropySystem();
  kills(e, PER * 3, 'blue');
  T(`红方拿到 3 颗（黑${e.black}）`, e.black === 3);
  const peak = e.value;
  // 跑够 coreReturnSec 应归还一颗
  for (let i = 0; i < Math.ceil(CFG().coreReturnSec * 30) + 2; i++) e.update(1 / 30);
  T(`静默 ${CFG().coreReturnSec}s 后归还一颗（黑 3 → ${e.black}，熵 ${(peak * 100).toFixed(1)}% → ${(e.value * 100).toFixed(1)}%）`,
    e.black === 2 && e.value < peak);
  T('归还后总数不变', inv(e));
  // 跑很久应回到完全中性
  for (let i = 0; i < Math.ceil(CFG().coreReturnSec * 30) * 4; i++) e.update(1 / 30);
  T('长时间无交火后回到完全中性', e.black === 0 && e.white === 0 && e.red === CFG().coreTotal);
  T('回到中性后熵为 0.5', Math.abs(e.value - 0.5) < 1e-9);
}

// ---- ⑧ 巨龙：反向归还己方核（"秩序压制混乱"）----
{
  const e = new EntropySystem();
  kills(e, PER * 2, 'blue');
  const before = e.black;
  e.onDeath({ entity: { type: 'dragon', _mapFaction: 'blue' } });   // 红方击杀龙
  T(`红方击杀巨龙反而归还自己一颗核（黑 ${before} → ${e.black}）`, e.black === before - 1);
  T('巨龙归还后总数不变', inv(e));
  // 对照：普通击杀是提高极化的，方向相反
  const f = new EntropySystem();
  kills(f, PER * 2, 'blue');
  kills(f, PER, 'blue');
  T('对照：普通击杀提高极化（与巨龙方向相反）', f.black === 3);
}

// ---- ⑨ 充能衰减：不持续压制就攒不满 ----
{
  const e = new EntropySystem();
  kills(e, PER - 1, 'blue');
  const p0 = e.chargeProgress('black');
  for (let i = 0; i < 30 * 30; i++) e.update(1 / 30);   // 静默 30 秒
  T(`充能会衰减（进度 ${(p0 * 100).toFixed(0)}% → ${(e.chargeProgress('black') * 100).toFixed(0)}%）`,
    e.chargeProgress('black') < p0);
  T('衰减不会把已经夺到的核吐出来（那是 coreReturnSec 的职责）', e.black === 0 && inv(e));
}

// ---- ⑩ 波动：未归属的核越少，世界越极化 ----
{
  const e = new EntropySystem();
  T('开局波动为 1（8 颗全未归属）', Math.abs(e.volatility - 1) < 1e-9);
  kills(e, PER * CFG().coreTotal, 'blue');
  T(`红核归零时波动到顶（×${e.volatility.toFixed(2)}）`,
    Math.abs(e.volatility - (1 + CFG().volatilityPct / 100)) < 1e-9);
}

// ---- ⑩·5 标定：衰减必须低于基准击杀率 ----
// 这条是【实测标定的护栏】，不是风格偏好。真实对局稳态下每方约 35 次击杀/分钟
// （≈0.58/s，用 killrate 探针量的）。若 chargeDecayPerSec ≥ 这个数，衰减会吃光充能、
// 一颗核都夺不走 —— 上一版取 1.5/s，实测 10 分钟对局终局熵恒为 0.500，
// 五个加成档位的推进度差一模一样，机制完全等于不存在，而这不会报任何错。
// 反过来取得太低就回到用户最初反馈的"红方占优太快"。所以两边都钉住。
{
  const BASELINE_KILLS_PER_SEC = 0.58;
  const d = CFG().chargeDecayPerSec;
  T(`充能衰减 ${d}/s 低于基准击杀率 ${BASELINE_KILLS_PER_SEC}/s（否则熵永远不动）`,
    d < BASELINE_KILLS_PER_SEC * CFG().gainMinion);
  T(`充能衰减不低于基准的 1/4（否则熵变化过快，回到"红方占优太快"）`,
    d >= BASELINE_KILLS_PER_SEC * CFG().gainMinion * 0.25);
  // 夺一颗核的时间量级：基准净攒 = 击杀率 − 衰减
  const net = BASELINE_KILLS_PER_SEC * CFG().gainMinion - d;
  const secsPerCore = CFG().chargePerCore / net;
  T(`基准表现下夺一颗核约 ${(secsPerCore / 60).toFixed(1)} 分钟（应在 1~10 分钟之间）`,
    secsPerCore > 60 && secsPerCore < 600);
  // 核归还必须慢于夺取，否则优势永远攒不起来
  T(`归还间隔 ${CFG().coreReturnSec}s 慢于夺取耗时 ${secsPerCore.toFixed(0)}s`,
    CFG().coreReturnSec > secsPerCore * 0.5);
}

// ---- ⑪ 软编码 ----
T('三核的每一项都软编码', ['coreTotal', 'chargePerCore', 'chargeDecayPerSec', 'coreReturnSec',
  'gainMinion', 'gainTower', 'volatilityPct', 'nightStretchPct']
  .every(k => typeof CFG()[k] === 'number'));
T('核总数可配（不是写死的 8）', (() => {
  const saved = CFG().coreTotal;
  CONFIG.world.entropy.coreTotal = 4;
  const e = new EntropySystem();
  const ok = e.red === 4 && inv(e);
  CONFIG.world.entropy.coreTotal = saved;
  return ok;
})());
T('reset 回到开局态', (() => {
  const e = new EntropySystem();
  kills(e, PER * 3, 'blue');
  e.reset();
  return e.black === 0 && e.white === 0 && e.red === CFG().coreTotal && inv(e);
})());
T('snapshot 暴露 UI 需要的全部字段', (() => {
  const sn = new EntropySystem().snapshot();
  return ['black', 'white', 'red', 'total', 'value', 'volatility', 'charge']
    .every(k => sn[k] !== undefined);
})());

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
CONFIG.world.couplings.dayNight = _dayNight0;   // 还原出厂默认
AttributeCalculator.setWorldState(null);

console.log(`熵/三核验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
