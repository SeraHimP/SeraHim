// Q4 平衡改动验收（本轮追加反馈）：
//   Q1 - 修复蚀骨兵主动技能（环刃毒雾）错误触发自己的屠戮被动
//   Q2 - 自适应伤害的基础伤害数值改成"攻击力+法术强度"（规则照搬LoL Adaptive damage）
//   Q4 - 哀兵数值 4%/10% → 7%/3%（软编码），范围仍只对小兵生效
//   Q5 - 近战兵主动技能：本能格挡(+2格挡) → 本能防御(+10%伤害转化，可叠加)
//
// 用户原话摘录：
//   "Q1，蚀骨兵的主动技能的伤害会错误触发屠戮（好像是，自己排查）。"
//   "目前的伤害结算不对！……如果法强远远大于攻击力，造成的伤害就是基于法强的魔法
//    伤害而不是物理伤害，自己去上网查，规则照搬lol就行。" → 查证后用户定稿："A，照搬LOL"。
//   "Q4 哀兵你也没改。" → 追问范围后定稿"维持只对小兵生效"。
//   "Q5，近战兵主动技能由格挡+2改为+10%伤害转化（2s，可叠加）。"
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { LaneAvengerSystem } = await import('../src/systems/LaneAvengerSystem.js');
const { CONFIG } = await import('../src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkMinion(ents, type, hp = 1e6) {
  const tpl = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...tpl, maxHP: hp, armor: 0, magicResist: 0 }, currentHP: hp,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue' };
  ents.add(e);
  return e;
}

// ==================== ① 修复：蚀骨兵主动技能不再错误触发自己的屠戮被动 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const buff = new BuffSystem(fx, ents, bus, combat);

  const caster = mkMinion(ents, 'corrupt', 620);
  const rendInst = { id: ++window._uid, skillId: 'passive_corrupt_rend', state: {} };
  caster._skillInstances.push(rendInst);
  SkillLibrary.passive_corrupt_rend.onEquip?.(caster.id, rendInst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus });

  const target = mkMinion(ents, 'melee', 1e6);
  // 直接模拟"环刃毒雾"施加的那份 DOT（与 actives.js 里 active_corrupt_poison.onCast
  // 挂的效果同形状：kind:'dot', dotBasis:'currentHP', damageType:'true'）。
  const pct = 5; // 每秒损失当前生命 5%（用来放大观测窗口，数值本身不是这条测试要钉的东西）
  fx.apply(target.id, {
    name: '环刃毒雾', kind: 'dot', damageType: 'true', dotBasis: 'currentHP',
    percentValue: pct, tickInterval: 1, duration: 4,
    stackable: false, stackPolicy: 'refresh', uniquePassive: true,
  }, 'active_corrupt_poison', { casterId: caster.id });

  const hpBefore = target.currentHP;
  buff.update(1); // 走满一个 tick 间隔，触发一次 DOT 结算
  const dealt = hpBefore - target.currentHP;
  const expectPureDot = hpBefore * pct / 100;
  // 若 bug 仍在（DOT tick 漏传 _noProc），蚀骨兵自己的屠戮会在同一次 tick 里额外
  // 触发一笔 performAttackDirect（基数=攻击者自身当前生命620×7%≈43.4），实际掉血
  // 会比纯 DOT 量多出这一截——用误差窗口把"混进了屠戮"和"只有纯DOT"区分开。
  T(`蚀骨兵的环刃毒雾 tick 不再错误触发自己的屠戮（实际掉血${dealt.toFixed(1)} ≈ 纯DOT${expectPureDot.toFixed(1)}，不应该多出屠戮的~43）`,
    Math.abs(dealt - expectPureDot) < 1);
}

// ==================== ② 自适应伤害：基础伤害 = 攻击力+法术强度（规则照搬LoL） ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const atk = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee, attackDamage: 40, abilityPower: 100, attackType: 'adaptive',
      armor: 0, magicResist: 0, baseAttackSpeed: 10 }, currentHP: 500, _skillInstances: [], _mapFaction: 'blue' };
  ents.add(atk);
  const tgt = mkMinion(ents, 'tower', 1e7);
  attr.tick();
  const before = tgt.currentHP;
  combat.performAttack(atk, tgt);
  const dealt = before - tgt.currentHP;
  // 本轮（数值平衡重做）：AD+AP 相加的规则被推翻，改成"赢家通吃"——用户查证
  // LoL 后指出普通攻击的伤害本来就不该叠加另一项属性，判定用哪个类型，伤害就
  // 直接取那个属性（见 CombatSystem.performAttack 头注）。AD40/AP100，
  // AP×0.6(判定系数)=60>40，判成魔法。追加定稿"AP打折，AD不打折"：伤害 =
  // 法术强度×apMagicDamagePct%（默认60%）= 100×0.6 = 60，不再是原始值100，
  // 更不是 AD+AP=140。
  const apMagicPct = (CONFIG.tuning?.adaptiveDamage?.apMagicDamagePct ?? 60) / 100;
  T(`自适应普攻基础伤害 = 判定胜出属性打折后的值（AP100×0.6折扣=60，实际${dealt.toFixed(1)}）`,
    Math.abs(dealt - 100 * apMagicPct) < 2);
  T(`此时类型判成魔法（AP>AD，跟真实规则"哪项贡献更大决定类型"一致）`,
    attr.resolveAttackType(attr.calc(atk, fx.getEffects(atk.id))) === 'magic');

  // 反证：非自适应（固定物理）类型，基础伤害仍然只是攻击力本身，不相加法术强度。
  const atk2 = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee, attackDamage: 40, abilityPower: 100, attackType: 'physical',
      armor: 0, magicResist: 0, baseAttackSpeed: 10 }, currentHP: 500, _skillInstances: [], _mapFaction: 'blue' };
  ents.add(atk2);
  const tgt2 = mkMinion(ents, 'tower', 1e7);
  attr.tick();
  const before2 = tgt2.currentHP;
  combat.performAttack(atk2, tgt2);
  const dealt2 = before2 - tgt2.currentHP;
  T(`固定物理类型不受影响，基础伤害仍只是攻击力本身（AD40，实际${dealt2.toFixed(1)}）`,
    Math.abs(dealt2 - 40) < 2);
}

// ==================== ④ 哀兵：数值 4%/10% → 7%/3%（软编码），范围仍只对小兵 ====================
{
  T('CONFIG.avenger 声明了新数值（每层+7%对敌方小兵伤害/-3%受敌方小兵伤害）',
    CONFIG.avenger?.ampPctPerStack === 7 && CONFIG.avenger?.redPctPerStack === 3);

  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const avSys = Object.create(LaneAvengerSystem.prototype);
  avSys.fx = fx;
  avSys._applyTo(1, 2); // 2 层
  const effs = fx.getEffects(1);
  const amp = effs.find(e => e.blueprint.statKey === 'avengerVsMinionAmpPct');
  const red = effs.find(e => e.blueprint.statKey === 'avengerVsMinionRedPct');
  T('哀兵每层+7%对敌方小兵伤害（2层=14%）', amp && Math.abs(amp.totalFlat - 14) < 1e-6);
  T('哀兵每层-3%受敌方小兵伤害（2层=6%）', red && Math.abs(red.totalFlat - 6) < 1e-6);

  // 范围维持不变：CombatSystem._applyAvenger 仍然只在【小兵 vs 小兵】时生效
  const src = (await import('fs')).readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');
  T('_applyAvenger 的小兵限定判据没有被放宽到塔/龙（仍然是 isMinion(attacker)&&isMinion(target)）',
    /if \(!isMinion\(attacker\) \|\| !isMinion\(target\)\) return damage;/.test(src));
}

// ==================== ⑤ 近战兵主动技能：本能格挡 → 本能防御（+10%伤害转化，可叠加） ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const caster = mkMinion(ents, 'melee', 500);
  const inst = { id: ++window._uid, skillId: 'active_melee_block', state: {} };
  caster._skillInstances.push(inst);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  SkillLibrary.active_melee_block.onCast(caster.id, inst, ctx);
  let eff = fx.getEffectByName(caster.id, '本能防御');
  T('技能改名"本能防御"，效果是+10%伤害转化（damageConvertPct），持续2秒',
    !!eff && eff.blueprint.statKey === 'damageConvertPct' && eff.blueprint.flatValue === 10
    && Math.abs(eff.remainingTime - 2) < 1e-6 && eff.stacks === 1);
  // 可叠加：再次施放应该叠层，不是单纯刷新时间
  SkillLibrary.active_melee_block.onCast(caster.id, inst, ctx);
  eff = fx.getEffectByName(caster.id, '本能防御');
  T('可叠加：再次施放层数变成2（不是原地刷新）', eff.stacks === 2);
  attr.tick();
  const finalStats = attr.calc(caster, fx.getEffects(caster.id));
  T('叠2层后 damageConvertPct 实际生效 = 20%', Math.abs((finalStats.damageConvertPct || 0) - 20) < 1e-6);
}

console.log(`Q4 平衡验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
