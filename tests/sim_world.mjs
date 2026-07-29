// P3 WorldState 聚合层验收。
//
// 引入一个新的全局修正层，最大的风险是"悄悄改变了现有平衡"。
// 所以第一条也是最重要的一条断言是：**所有耦合关闭时，属性必须与接入前逐位一致**。
// 其余断言验证打开后确实按设计生效、且可解释。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
const { CONFIG } = await import('../src/data/Config.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { DAY_PERIOD } = await import('../src/presentation/DayNight.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const mkUnit = (fac) => ({
  id: 1, type: 'melee', alive: true, pos: { x: 0, y: 0 },
  baseStats: { ...CONFIG.templates.melee }, currentHP: 500,
  _skillInstances: [], _mapFaction: fac, faction: fac,
});

// ---- ① 默认全关：接入前后必须逐位一致 ----
T('CONFIG.world.couplings 默认全部关闭',
  Object.values(CONFIG.world.couplings).every(v => v === false));

const world = new WorldState({});
AttributeCalculator.setWorldState(null);
AttributeCalculator.tick();
const before = { ...AttributeCalculator.calc(mkUnit('blue'), []) };
AttributeCalculator.setWorldState(world);
world.update(0.1, 0);
AttributeCalculator.tick();
const after = { ...AttributeCalculator.calc(mkUnit('blue'), []) };
const drift = Object.keys(before).filter(k => typeof before[k] === 'number' && Math.abs(before[k] - after[k]) > 1e-9);
if (drift.length) drift.forEach(k => console.log(`  ${k}: ${before[k]} → ${after[k]}`));
T(`耦合全关时属性零漂移（${drift.length} 项变化）`, drift.length === 0);

// ---- ② 昼夜相位口径：与 DayNight 关键帧一致（0=黎明 .25=正午 .5=黄昏 .75=午夜）----
const at = (t) => { world.update(0.1, t); return { ...world.daynight }; };
const noon = at(DAY_PERIOD * 0.25), dusk = at(DAY_PERIOD * 0.5), mid = at(DAY_PERIOD * 0.75);
T(`正午判为白天（相位 ${noon.phase.toFixed(2)}）`, !noon.isNight);
T(`午夜判为夜晚（相位 ${mid.phase.toFixed(2)}）`, mid.isNight);
T('黄昏是昼夜分界（相位 0.5 起为夜）', dusk.isNight);

// ---- ③ 打开昼夜阵营耦合：占优方拿到加成，另一方分毫不动 ----
CONFIG.world.couplings.dayNightFaction = true;
const g = CONFIG.world.dayNightBonus;

world.update(0.1, DAY_PERIOD * 0.25);            // 正午 → 蓝方占优
AttributeCalculator.tick();
const blueDay = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const redDay = AttributeCalculator.calc(mkUnit('red'), []);
const baseMs = CONFIG.templates.melee.moveSpeed;
T(`白天：蓝方移速 ${blueDay.moveSpeed.toFixed(1)} = 基准 ${baseMs} × (1+${g.moveSpeedPct}%)`,
  Math.abs(blueDay.moveSpeed - baseMs * (1 + g.moveSpeedPct / 100)) < 1e-6);
T(`白天：红方移速 ${redDay.moveSpeed.toFixed(1)} 无加成`, Math.abs(redDay.moveSpeed - baseMs) < 1e-6);

world.update(0.1, DAY_PERIOD * 0.75);            // 午夜 → 红方占优
AttributeCalculator.tick();
const blueNight = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const redNight = AttributeCalculator.calc(mkUnit('red'), []);
T(`夜晚：攻守易位（红 ${redNight.moveSpeed.toFixed(1)} > 蓝 ${blueNight.moveSpeed.toFixed(1)}）`,
  redNight.moveSpeed > blueNight.moveSpeed && Math.abs(blueNight.moveSpeed - baseMs) < 1e-6);

// ---- ④ 缓存键必须含世界状态：昼→夜切换后属性要跟着变（不能停在旧值）----
// 上面 ③ 已隐含验证（同一个 AttributeCalculator 实例跨昼夜取到了不同值），这里显式钉住。
T('昼夜切换后属性缓存正确失效', Math.abs(blueDay.moveSpeed - blueNight.moveSpeed) > 1e-6);

// ---- ⑤ 可解释：getBreakdown 必须说得出为什么 ----
const rows = world.getBreakdown(mkUnit('red'));
T('getBreakdown 返回逐项来源（可解释性）',
  Array.isArray(rows) && rows.length > 0 && rows.every(r => r.source && r.detail));
console.log('  夜晚·红方的修正来源：' + rows.map(r => `${r.source} → ${r.detail}`).join(' ｜ '));

// ---- ⑥ 熵未实现时保持中性（不产生任何修正）----
CONFIG.world.couplings.dayNightFaction = false;
CONFIG.world.couplings.entropyToUnits = true;
world.update(0.1, 0);
AttributeCalculator.tick();
const neutral = AttributeCalculator.calc(mkUnit('red'), []);
T(`熵中性（0.5）时零修正：攻击力 ${neutral.attackDamage} = 基准 ${CONFIG.templates.melee.attackDamage}`,
  Math.abs(neutral.attackDamage - CONFIG.templates.melee.attackDamage) < 1e-6);
T('熵接口已就位（value/black/white/red 四个通道）',
  ['value', 'black', 'white', 'red'].every(k => typeof world.entropy[k] === 'number'));

// ---- ⑦ 总开关：关掉 WorldState 本身，一切修正消失 ----
CONFIG.world.couplings.dayNightFaction = true;
world.update(0.1, DAY_PERIOD * 0.75);
world.setEnabled(false);
AttributeCalculator.tick();
const off = AttributeCalculator.calc(mkUnit('red'), []);
T('WorldState 总开关关闭后无任何修正', Math.abs(off.moveSpeed - baseMs) < 1e-6);
world.setEnabled(true);

// 还原配置，避免污染同进程内的其它用例
CONFIG.world.couplings.dayNightFaction = false;
CONFIG.world.couplings.entropyToUnits = false;
AttributeCalculator.setWorldState(null);

console.log(`WorldState 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
