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

// ---- ① 熵的耦合默认全关；打开的只有昼夜 ----
// 用户定稿的默认值：昼夜默认开、熵三条默认关。所以"零漂移"的口径要跟着改：
// 不再是"所有耦合全关"，而是"把 dayNight 也关掉后，世界层不产生任何修正"。
// 这条断言的意义没变 —— 全关时 WorldState 必须等价于不存在。
T('熵的三条耦合默认关闭', ['entropyToUnits', 'entropyToWeather', 'entropyToDayNight']
  .every(k => CONFIG.world.couplings[k] === false));
T('昼夜耦合默认开启（用户定稿）', CONFIG.world.couplings.dayNight === true);

const world = new WorldState({});
const _dn0 = CONFIG.world.couplings.dayNight;
CONFIG.world.couplings.dayNight = false;
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
CONFIG.world.couplings.dayNight = _dn0;

// ---- ② 昼夜相位口径：与 DayNight 关键帧一致（0=黎明 .25=正午 .5=黄昏 .75=午夜）----
const at = (t) => { world.update(0.1, t); return { ...world.daynight }; };
const noon = at(DAY_PERIOD * 0.25), dusk = at(DAY_PERIOD * 0.5), mid = at(DAY_PERIOD * 0.75);
T(`正午判为白天（相位 ${noon.phase.toFixed(2)}）`, !noon.isNight);
T(`午夜判为夜晚（相位 ${mid.phase.toFixed(2)}）`, mid.isNight);
T('黄昏是昼夜分界（相位 0.5 起为夜）', dusk.isNight);
// 相位必须是有限数。这里曾经恒为 NaN —— WorldState 读的 `CTX.__dayPeriod` 是个
// setter 函数（秒数在 __dayPeriodSec），函数 truthy 让 period 变成函数、相位 NaN、
// isNight 永远 false，昼夜的数值耦合其实一直没生效过，而这不报任何错。
T('相位是有限数（不是 NaN）', [noon, dusk, mid].every(x => Number.isFinite(x.phase)));

// ---- ③ 昼夜 → 攻守（用户定稿：白天小兵占优 / 夜晚防御塔占优，双方对称）----
CONFIG.world.couplings.dayNight = true;
const g = CONFIG.world.dayNightBonus;
const mkTower = (fac) => ({
  id: 2, type: 'tower', alive: true, pos: { x: 0, y: 0 },
  baseStats: { ...CONFIG.templates.tower }, currentHP: 3000,
  _skillInstances: [], _mapFaction: fac, faction: fac, _mapTier: 'outer',
});

world.update(0.1, DAY_PERIOD * 0.25);            // 正午 → 小兵占优
AttributeCalculator.tick();
const minionDay = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const towerDay = AttributeCalculator.calc(mkTower('blue'), []);
const baseMs = CONFIG.templates.melee.moveSpeed;
T(`白天：小兵移速 ${minionDay.moveSpeed.toFixed(1)} = 基准 ${baseMs} × (1+${g.day.moveSpeedPct}%)`,
  Math.abs(minionDay.moveSpeed - baseMs * (1 + g.day.moveSpeedPct / 100)) < 1e-6);
T(`白天：防御塔攻击力 ${towerDay.attackDamage.toFixed(1)} 无加成`,
  Math.abs(towerDay.attackDamage - CONFIG.templates.tower.attackDamage) < 1e-6);

// 双方对称：同为小兵，蓝红拿到的加成必须一模一样（这是与上一版最大的区别 ——
// 上一版按阵营给，等于把昼夜做成了先手优势）
AttributeCalculator.tick();
const redMinionDay = AttributeCalculator.calc(mkUnit('red'), []);
T('白天：蓝红小兵加成完全对称（不再是阵营优势）',
  Math.abs(minionDay.moveSpeed - redMinionDay.moveSpeed) < 1e-9);

world.update(0.1, DAY_PERIOD * 0.75);            // 午夜 → 防御塔占优
AttributeCalculator.tick();
const minionNight = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const towerNight = AttributeCalculator.calc(mkTower('blue'), []);
T(`夜晚：防御塔攻击力 ${towerNight.attackDamage.toFixed(1)} = 基准 × (1+${g.night.attackDamagePct}%)`,
  Math.abs(towerNight.attackDamage - CONFIG.templates.tower.attackDamage * (1 + g.night.attackDamagePct / 100)) < 1e-6);
T(`夜晚：防御塔射程 +${g.night.attackRangeFlat}`,
  Math.abs(towerNight.attackRange - (CONFIG.templates.tower.attackRange + g.night.attackRangeFlat)) < 1e-6);
T(`夜晚：小兵移速 ${minionNight.moveSpeed.toFixed(1)} 回到基准（不再占优）`,
  Math.abs(minionNight.moveSpeed - baseMs) < 1e-6);
T('攻守易位：白天利兵、夜晚利塔', minionDay.moveSpeed > minionNight.moveSpeed
  && towerNight.attackDamage > towerDay.attackDamage);

// ---- ④ 缓存键必须含世界状态：昼→夜切换后属性要跟着变（不能停在旧值）----
// 上面 ③ 已隐含验证（同一个 AttributeCalculator 实例跨昼夜取到了不同值），这里显式钉住。
T('昼夜切换后属性缓存正确失效', Math.abs(minionDay.moveSpeed - minionNight.moveSpeed) > 1e-6);

// ---- ⑤ 可解释：getBreakdown 必须说得出为什么 ----
const rows = world.getBreakdown(mkTower('red'));
T('getBreakdown 返回逐项来源（可解释性）',
  Array.isArray(rows) && rows.length > 0 && rows.every(r => r.source && r.detail));
console.log('  夜晚·防御塔的修正来源：' + rows.map(r => `${r.source} → ${r.detail}`).join(' ｜ '));

// ---- ⑥ 熵未实现时保持中性（不产生任何修正）----
CONFIG.world.couplings.dayNight = false;
CONFIG.world.couplings.entropyToUnits = true;
world.update(0.1, 0);
AttributeCalculator.tick();
const neutral = AttributeCalculator.calc(mkUnit('red'), []);
T(`熵中性（0.5）时零修正：攻击力 ${neutral.attackDamage} = 基准 ${CONFIG.templates.melee.attackDamage}`,
  Math.abs(neutral.attackDamage - CONFIG.templates.melee.attackDamage) < 1e-6);
T('熵接口已就位（value/black/white/red 四个通道）',
  ['value', 'black', 'white', 'red'].every(k => typeof world.entropy[k] === 'number'));

// ---- ⑦ 总开关：关掉 WorldState 本身，一切修正消失 ----
CONFIG.world.couplings.dayNight = true;
world.update(0.1, DAY_PERIOD * 0.75);
world.setEnabled(false);
AttributeCalculator.tick();
const off = AttributeCalculator.calc(mkTower('red'), []);
T('WorldState 总开关关闭后无任何修正',
  Math.abs(off.attackDamage - CONFIG.templates.tower.attackDamage) < 1e-6);
world.setEnabled(true);

// 还原配置，避免污染同进程内的其它用例
CONFIG.world.couplings.dayNight = true;   // 还原为出厂默认（默认开）
CONFIG.world.couplings.entropyToUnits = false;
AttributeCalculator.setWorldState(null);

console.log(`WorldState 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
