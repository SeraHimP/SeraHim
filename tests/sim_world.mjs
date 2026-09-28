// P3 WorldState 聚合层验收。
//
// 引入一个新的全局修正层，最大的风险是"悄悄改变了现有平衡"。
// 所以第一条也是最重要的一条断言是：**所有耦合关闭时，属性必须与接入前逐位一致**。
// 其余断言验证打开后确实按设计生效、且可解释。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
const { CONFIG } = await import('../src/data/Config.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { DAY_LEN, NIGHT_LEN } = await import('../src/presentation/DayNight.js');
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
// v52：白天/夜晚不对称（用户定稿15分钟：8/7），相位不再是 DAY_PERIOD 的线性分数——
// 正午在白天时长一半处、黄昏在白天结束处、午夜在夜晚时长一半处（见 DayNight.js
// 的 _gameTimeToPhase 头注），不能再用 DAY_PERIOD×0.25/0.5/0.75 这种对称假设反推 t。
const at = (t) => { world.update(0.1, t); return { ...world.daynight }; };
const noon = at(DAY_LEN * 0.5), dusk = at(DAY_LEN), mid = at(DAY_LEN + NIGHT_LEN * 0.5);
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

// 本轮（用户定稿）：昼夜加成从"非黑即白"改成随相位连续变化、量化成四档
// （正午/极夜=严重100%，随距离衰减，档位系数直接复用天气的 INTENSITY_TIERS）。
// 原来的"+攻击力%"也改成了"+适应之力"（会按 AD/AP 谁高转化，见 AttributeCalculator）。
const { tierOf } = await import('../src/data/Weather.js');
const afRatio = 0.6; // adaptiveForce 转攻击力的官方比例（AD 明显高于 AP 时走这条）

world.update(0.1, DAY_LEN * 0.5);            // 正午（白天时长一半处）→ dayCloseness=1（严重档，小兵满档）
AttributeCalculator.tick();
const minionDay = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const towerDay = AttributeCalculator.calc(mkTower('blue'), []);
const baseMs = CONFIG.templates.melee.moveSpeed;
T(`正午：小兵移速 ${minionDay.moveSpeed.toFixed(1)} = 基准 ${baseMs} × (1+${g.day.moveSpeedPct}%)（满档）`,
  Math.abs(minionDay.moveSpeed - baseMs * (1 + g.day.moveSpeedPct / 100)) < 1e-6);
T(`正午：小兵适应之力转攻击力 ≈ 基准+${g.day.adaptiveForce}×${afRatio}（近战AD天生更高，走AD分支）`,
  Math.abs(minionDay.attackDamage - (CONFIG.templates.melee.attackDamage + g.day.adaptiveForce * afRatio)) < 1e-3);
// 追加定稿：白天/小兵是进攻向，防御类不再给小兵，改给固定穿甲/固定法穿。
T(`正午：小兵固定穿甲/法穿 各+${g.day.armorPenFlat}/${g.day.magicPenFlat}（满档，不再有护甲/魔抗加成）`,
  Math.abs(minionDay.armorPenFlat - g.day.armorPenFlat) < 1e-6
  && Math.abs(minionDay.magicPenFlat - g.day.magicPenFlat) < 1e-6
  && Math.abs(minionDay.armor - CONFIG.templates.melee.armor) < 1e-6);
T(`正午：防御塔（夜晚侧，nightCloseness=0）无加成，攻击力/射程都是基准`,
  Math.abs(towerDay.attackDamage - CONFIG.templates.tower.attackDamage) < 1e-6
  && Math.abs(towerDay.attackRange - CONFIG.templates.tower.attackRange) < 1e-6);

// 双方对称：同为小兵，蓝红拿到的加成必须一模一样（这是与"按阵营给"版本最大的区别）
AttributeCalculator.tick();
const redMinionDay = AttributeCalculator.calc(mkUnit('red'), []);
T('正午：蓝红小兵加成完全对称（不再是阵营优势）',
  Math.abs(minionDay.moveSpeed - redMinionDay.moveSpeed) < 1e-9);

world.update(0.1, DAY_LEN + NIGHT_LEN * 0.5);            // 午夜（夜晚时长一半处）→ nightCloseness=1（严重档，塔满档）
AttributeCalculator.tick();
const minionNight = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const towerNight = AttributeCalculator.calc(mkTower('blue'), []);
T(`极夜：防御塔适应之力转攻击力 ≈ 基准+${g.night.adaptiveForce}×${afRatio}（塔AD天生更高，走AD分支）`,
  Math.abs(towerNight.attackDamage - (CONFIG.templates.tower.attackDamage + g.night.adaptiveForce * afRatio)) < 1e-3);
T(`极夜：防御塔射程 +${g.night.attackRangeFlat}（满档）`,
  Math.abs(towerNight.attackRange - (CONFIG.templates.tower.attackRange + g.night.attackRangeFlat)) < 1e-6);
T(`极夜：防御塔护甲/魔抗 各+${g.night.armorFlat}/${g.night.magicResistFlat}（满档）`,
  Math.abs(towerNight.armor - (CONFIG.templates.tower.armor + g.night.armorFlat)) < 1e-6
  && Math.abs(towerNight.magicResist - (CONFIG.templates.tower.magicResist + g.night.magicResistFlat)) < 1e-6);
// 追加定稿：夜晚/塔是防守向，法力获取/攻速都不给塔（用户先说给攻速，随后又
// 拍板"昼夜加成防御塔不再加攻速"，两轮定稿叠加后塔只剩射程+适应之力+双抗三项）。
T('极夜：防御塔没有法力获取加成、也没有攻速加成',
  Math.abs((towerNight.manaGainPct || 0) - (CONFIG.templates.tower.manaGainPct || 0)) < 1e-6
  && Math.abs((towerNight.bonusAttackSpeedPct || 0) - (CONFIG.templates.tower.bonusAttackSpeedPct || 0)) < 1e-6);
T(`极夜：小兵（白天侧，dayCloseness=0）无加成，移速回到基准`,
  Math.abs(minionNight.moveSpeed - baseMs) < 1e-6);
T('攻守易位：正午利兵、极夜利塔', minionDay.moveSpeed > minionNight.moveSpeed
  && towerNight.attackDamage > towerDay.attackDamage);

// ---- ③b 新特性：黎明/黄昏过渡区，小兵与防御塔的加成【同时】生效（各自最低档）----
// 用户定稿："在黎明/黄昏的时候兵/塔的加成同时生效（最低档）"——这是本轮与上一版
// 最大的行为差异：上一版在分界点是硬切换（非此即彼），现在两条曲线在边界附近
// 有重叠窗口，双方都落在"轻微"档（25%）。
world.update(0.1, 0);                            // 黎明（相位0，精确分界点）
AttributeCalculator.tick();
const minionDawn = AttributeCalculator.calc(mkUnit('blue'), []);
AttributeCalculator.tick();
const towerDawn = AttributeCalculator.calc(mkTower('blue'), []);
const dawnTier = tierOf(world.daynight.dayCloseness);
T(`黎明：白天/夜晚曲线在分界点精确对称（dayCloseness=${world.daynight.dayCloseness.toFixed(3)} = nightCloseness=${world.daynight.nightCloseness.toFixed(3)}）`,
  Math.abs(world.daynight.dayCloseness - world.daynight.nightCloseness) < 1e-9);
T(`黎明：两条曲线都落在"轻微"档（25%），不是骤降到0`,
  dawnTier.id === 'slight' && Math.abs(dawnTier.scale - 0.25) < 1e-9);
T('黎明：小兵拿到白天加成的最低档（移速比基准略高，但明显低于正午满档）',
  minionDawn.moveSpeed > baseMs && minionDawn.moveSpeed < minionDay.moveSpeed);
T('黎明：防御塔【同时】拿到夜晚加成的最低档（射程比基准略高，但明显低于极夜满档）',
  towerDawn.attackRange > CONFIG.templates.tower.attackRange && towerDawn.attackRange < towerNight.attackRange);

// ---- ④ 缓存键必须含世界状态：昼→夜切换后属性要跟着变（不能停在旧值）----
// 上面 ③ 已隐含验证（同一个 AttributeCalculator 实例跨昼夜取到了不同值），这里显式钉住。
T('昼夜切换后属性缓存正确失效', Math.abs(minionDay.moveSpeed - minionNight.moveSpeed) > 1e-6);

// ---- ⑤ 可解释：getBreakdown 必须说得出为什么 ----
const rows = world.getBreakdown(mkTower('red'));
T('getBreakdown 返回逐项来源（可解释性）',
  Array.isArray(rows) && rows.length > 0 && rows.every(r => r.source && r.detail));
console.log('  黎明·防御塔的修正来源：' + rows.map(r => `${r.source} → ${r.detail}`).join(' ｜ '));

// ---- ⑤b 结构化 mods + favored + tier，供 UI 走天气弹窗那套网格样式 ----
// 用户定稿："在属性界面如果没有增益的话，这个框就不要显示满（进度满），无增益就
// 不显示进度，有增益才显示进度"；"把'小兵占优（本单位不吃这条）'删掉"。
// 本轮追加：昼夜行现在带 tier（天气同款四档），且黎明/黄昏两侧可以同时 favored。
{
  world.update(0.1, DAY_LEN * 0.5); // 挪回正午：night 侧精确为 0，适合验证"完全不吃这条"
  const towerRow = world.getBreakdown(mkTower('red')).find(r => r.source.startsWith('昼夜'));
  T('⑤b-正午·塔（夜晚侧 nightCloseness=0）：favored=false，mods 为空对象',
    towerRow.favored === false && Object.keys(towerRow.mods).length === 0);
  T('⑤b-正午·塔：detail 就是"无增益"，不再说"XX占优（本单位不吃这条）"',
    towerRow.detail === '无增益' && !/本单位不吃这条/.test(towerRow.detail));

  const minionRow = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('昼夜'));
  T('⑤b-正午·小兵：favored=true，tier=严重（100%），mods 对应 dayNightBonus.day 配置（进攻向：移速/适应之力/法力获取/固定穿甲/固定法穿）',
    minionRow.favored === true && minionRow.tier.id === 'severe'
    && (!g.day.moveSpeedPct || minionRow.mods.moveSpeed?.percent === g.day.moveSpeedPct)
    && (!g.day.adaptiveForce || minionRow.mods.adaptiveForce?.flat === g.day.adaptiveForce)
    && (!g.day.manaGainPct || minionRow.mods.manaGainPct?.flat === g.day.manaGainPct)
    && (!g.day.armorPenFlat || minionRow.mods.armorPenFlat?.flat === g.day.armorPenFlat)
    && (!g.day.magicPenFlat || minionRow.mods.magicPenFlat?.flat === g.day.magicPenFlat)
    && !('armor' in minionRow.mods) && !('attackRange' in minionRow.mods));

  // 黎明：两侧【同时】favored，各自最低档——本轮最核心的新行为。
  world.update(0.1, 0);
  const towerDawnRow = world.getBreakdown(mkTower('red')).find(r => r.source.startsWith('昼夜'));
  const minionDawnRow = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('昼夜'));
  T('⑤b-黎明：小兵与防御塔【同时】favored（用户定稿的过渡区双重生效）',
    towerDawnRow.favored === true && minionDawnRow.favored === true);
  T('⑤b-黎明：两侧的档位都是"轻微"（最低档），不是满档',
    towerDawnRow.tier.id === 'slight' && minionDawnRow.tier.id === 'slight');

  // 熵：中性（0.5）时同理——favored=false、mods 空、detail 是"中性（无修正）"
  CONFIG.world.couplings.entropyToUnits = true;
  world.entropy.value = 0.5;
  const entropyNeutralRow = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('熵'));
  T('⑤b-熵中性时 favored=false、mods 为空', entropyNeutralRow.favored === false
    && Object.keys(entropyNeutralRow.mods).length === 0 && entropyNeutralRow.detail === '中性（无修正）');
  world.entropy.value = 0.9;
  const entropyHotRow = world.getBreakdown(mkUnit('red')).find(r => r.source.startsWith('熵'));
  T('⑤b-熵偏离中性时 favored=true 且 mods 有数值', entropyHotRow.favored === true
    && Object.keys(entropyHotRow.mods).length > 0);
  CONFIG.world.couplings.entropyToUnits = false;
  world.entropy.value = 0.5;

  // UI 侧：_modsGridHtml 是唯一实现，天气/世界两个弹窗都走它；进度条按 tier.pips 点亮。
  const { srcOf } = await import('./_harness.mjs');
  const um = srcOf('src/ui/UIManager.js');
  T('⑤b-UIManager 有共用的 _modsGridHtml，天气与世界弹窗都调用它',
    /_modsGridHtml\(mods\)/.test(um) && (um.match(/this\._modsGridHtml\(/g) || []).length >= 2);
  T('⑤b-世界效应弹窗不再显示"充能条/占优（本单位不吃这条）"这类旧文案',
    !/本单位不吃这条/.test(um));
  T('⑤b-昼夜行的点亮格数按 tier.pips 决定（天气同款四档），不再是二选一的 3/0',
    /lit = r\.tier\?\.pips \?\? 0/.test(um));
}

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
world.update(0.1, DAY_LEN + NIGHT_LEN * 0.5);
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
