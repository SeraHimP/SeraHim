// Q3 技能文案验收：描述 ↔ 实际效果 ↔ 状态描述，三者必须一致；且文案格式统一。
//
// 起因：用户发现"枢纽塔的生命恢复，技能里还写是 5，状态里是 3"。
// 根因是身份技能 core_tier_* 把子技能的文案【手抄】了一份，
// 改平衡时只改了子技能，手抄副本原地不动（水晶塔 2→1 也同样残留）。
// 修法是让合并文案从子技能现取现拼（_helpers.mergedDescription），
// 本用例则把"不许再手抄、不许再对不上"钉成回归。
//
// 三条断言：
//   ① 格式：所有技能文案统一为「唯一被动——名称：描述」（用户定稿，同步写进设计文档）。
//   ② 数值一致：onEquip/onFrame 实际施加的效果数值，必须都能在文案里找到。
//   ③ 状态描述一致：效果 blueprint 自带的 description 里的数值，同样要能在文案里找到。
globalThis.window = { gameTime: 0, waveNumber: 99, _uid: 0 };
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const nums = (s) => [...String(s || '').matchAll(/-?\d+(?:\.\d+)?/g)].map(m => +m[0]);

// 部分技能的文案会把数值写成派生形式（如"每分钟+9，共14层至278封顶"），
// 实际施加的是累计值。这里只要求"实际值能被文案里的某个数解释"：
// 相等、或等于文案中两数之差/之积的常见组合。放宽是为了不逼着文案退化成流水账。
function explained(v, ds, base) {
  const V = Math.abs(v);                      // 符号不比：文案写"减速每层7%"，效果是 -7
  const eq = (a, b) => Math.abs(a - b) < 1e-4;
  for (const a0 of ds) {
    const a = Math.abs(a0);
    if (eq(a, V)) return true;
    for (const b0 of ds) {
      const b = Math.abs(b0);
      if (eq(a - b, V) || eq(a * b, V)) return true;
      if (b !== 0 && eq(a / b, V)) return true;
    }
    // 文案写成"自身攻击力的 X%"这类派生量时，实际施加的是折算后的绝对值
    for (const st of base) if (eq(a / 100 * st, V) || eq(a * st, V)) return true;
  }
  return false;
}

function probe(id, def) {
  const kind = /melee|ranged/.test(id) ? 'melee'
             : /siege/.test(id) ? 'siege' : /super/.test(id) ? 'super'
             : /totem/.test(id) ? 'totem' : /warlock/.test(id) ? 'warlock'
             : /corrupt/.test(id) ? 'corrupt' : /ram|siege_weapon/.test(id) ? 'ram' : 'tower';
  const tpl = CONFIG.templates[kind] || CONFIG.templates.tower;
  const self = {
    id: 1, type: kind === 'tower' ? 'tower' : kind, alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...tpl }, currentHP: tpl.maxHP, _skillInstances: [],
    _mapTier: 'hq_tower', _mapFaction: 'blue', faction: 'blue',
  };
  const ally = { ...self, id: 2, _skillInstances: [] };
  const applied = [];
  const ents = {
    get: (i) => (i === 2 ? ally : self), getAll: () => [self, ally],
    findInRadius: () => [self, ally], getAllTowers: () => [self], getAllMinions: () => [ally],
    getByType: () => [ally],
  };
  const ctx = {
    entityContainer: ents,
    effectRegistry: {
      apply: (eid, bp) => { applied.push(bp); return bp; },
      getEffects: () => [], remove() {}, removeBySource() {}, has: () => false,
      getEffectByName: () => null,
    },
    eventBus: { emit() {}, on() {} },
    waveNumber: 99, attrCalc: AttributeCalculator,
  };
  const inst = { id: 1, skillId: id, state: {} };
  try {
    def.onEquip && def.onEquip(self.id, inst, ctx);
    // 跑一段时间，把 onFrame 里才施加的效果（成长类）也抓出来
    for (let t = 0; t < 60; t += 0.5) { window.gameTime = t; def.onFrame && def.onFrame(self.id, 0.5, inst, ctx); }
    window.gameTime = 0;
  } catch (e) { return { err: e.message, applied, baseStats: self.baseStats }; }
  return { applied, baseStats: self.baseStats };
}

const ids = SkillLibrary.ids();
const badFormat = [], badNums = [], errs = [];
for (const id of ids) {
  const def = SkillLibrary.get(id);
  if (!def) continue;
  const desc = def.description || '', tmpl = def.descTemplate || '';
  const text = tmpl || desc;

  // ① 格式。v51：主动技能（category:'active'）不是"唯一被动"——它们由玩家/单位
  // 自己攒满法力触发，前缀改成"主动技能——"，判据用 category 不用名字（见
  // SkillLibrary.js 里 _prefixFor 的头注）。
  const expectPrefix = def.category === 'active' ? /^主动技能——/ : /^唯一被动——/;
  if (!expectPrefix.test(text) || !expectPrefix.test(desc || text)) {
    badFormat.push(`${id}（${def.name}）: ${(text || '(空)').slice(0, 60)}`);
  }

  // ②③ 数值
  const r = probe(id, def);
  if (r.err) { errs.push(`${id}: ${r.err}`); continue; }
  const ds = new Set([...nums(desc), ...nums(tmpl)]);
  // 派生量的基数：单位自身属性（攻击力/生命/双抗…）
  const baseVals = Object.values(r.baseStats || {}).filter(v => typeof v === 'number' && v !== 0);
  for (const bp of r.applied) {
    const vals = [];
    if (bp.flatValue) vals.push(bp.flatValue);
    if (bp.percentValue) vals.push(bp.percentValue);
    for (const v of nums(bp.description)) vals.push(v);   // ③ 状态自带描述里的数
    for (const v of vals) {
      if (!explained(v, ds, baseVals)) {
        badNums.push(`${id}（${def.name}）: 实际效果出现 ${v}（${bp.statKey || bp.kind}${bp.description ? ' / 状态描述"' + bp.description + '"' : ''}），文案里没有。文案=${(text || '').slice(0, 90)}`);
      }
    }
  }
}

console.log(`技能总数 ${ids.length}`);
if (badFormat.length) { console.log('格式不统一：'); badFormat.forEach(s => console.log('  ' + s)); }
if (badNums.length) { console.log('文案与实际效果数值对不上：'); badNums.forEach(s => console.log('  ' + s)); }
if (errs.length) { console.log('探测异常：'); errs.forEach(s => console.log('  ' + s)); }

T(`所有技能文案统一为「唯一被动——名称：描述」（${badFormat.length} 处不合规）`, badFormat.length === 0);
T(`技能文案数值与实际效果一致（${badNums.length} 处不符）`, badNums.length === 0);
T(`技能探测无异常（${errs.length} 处）`, errs.length === 0);

console.log(`技能文案验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
