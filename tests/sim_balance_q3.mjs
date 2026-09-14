// Q3 平衡改动验收（本轮）：塔改自适应伤害 + 穿透型/闪电杖重做 + 塔法强成长。
//
// 用户原话："我考虑让所有单位默认都是自适应伤害，目前的塔强制魔法伤害，感觉不太好。
// 所以你可以考虑，目前穿透型/闪电杖重做（但是攻击方式不要改），让穿透型子弹和攻击力
// 联动更高一些，打的是物理伤害，闪电杖和法强联动更好，打的是魔法……对应的塔成长也可以
// 随之变化" + 跟进定稿："塔的物理攻击和法术强度都会成长，然后穿透型是每层额外造成
// （20%+X%×法术强度）伤害。闪电杖是将（XX=攻击力×100%）攻击力转化为（YY=攻击力×XX%）
// 法术强度（相当于攻击力归0）。每秒造成4次伤害，每次造成（XX%×法术强度）伤害，
// 平衡先不用做。"
//
// 两个百分比（穿透型每层的 AD/AP 系数、闪电杖的转化比例）用户都没给最终数字，
// 本轮按用户原话"平衡先不用做"各自占位（20%/20%/100%），全部软编码进
// CONFIG.tuning.weapons，具体理由见 Config.js 里那段配置的头注。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkTower(ents, fx, { ad = 152, ap = 0, weapon = null } = {}) {
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 9000, attackDamage: ad, abilityPower: ap, attackRange: 999, bulletSpeed: 0 },
    currentHP: 9000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: 'blue', _mapTier: 'outer', _laneId: 'mid', faction: 'blue' };
  ents.add(e);
  if (weapon) {
    const inst = { id: ++window._uid, skillId: weapon, state: {} };
    e._skillInstances.push(inst);
    SkillLibrary[weapon].onEquip?.(e.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: new EventBus() });
  }
  return e;
}
function mkTarget(ents, hp = 1e7) {
  const e = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 20, y: 0 },
    baseStats: { ...CONFIG.templates.melee, maxHP: hp, armor: 0, magicResist: 0 }, currentHP: hp,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'red' };
  ents.add(e);
  return e;
}

// ==================== ① 塔默认伤害类型 = 自适应（不再强制魔法） ====================
T('CONFIG.templates.tower.attackType = adaptive（用户："目前的塔强制魔法伤害，感觉不太好"）',
  CONFIG.templates.tower.attackType === 'adaptive');
T('裸塔（无武器）abilityPower=0 < attackDamage，自适应解析仍是物理——与改动前表现一致',
  attr.resolveAttackType({ ...CONFIG.templates.tower, attackType: 'adaptive' }) === 'physical');

// ==================== ② 软编码落点：两把武器的新增百分比都在 CONFIG.tuning.weapons ====================
T('CONFIG.tuning.weapons 声明了三个新增百分比（闪电杖转化比例 + 穿透型AD/AP系数）',
  typeof CONFIG.tuning?.weapons?.lightningApConvertPct === 'number'
  && typeof CONFIG.tuning?.weapons?.piercingStackAdPct === 'number'
  && typeof CONFIG.tuning?.weapons?.piercingStackApPct === 'number');

// ==================== ③ 闪电杖：装备后攻击力全部转化为法术强度 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const tw = mkTower(ents, fx, { ad: 200, ap: 30, weapon: 'weapon_lightning' });
  attr.tick();
  const s = attr.calc(tw, fx.getEffects(tw.id));
  T('装备闪电杖：攻击力归零（用户原话"相当于攻击力归0"）', Math.abs(s.attackDamage) < 1e-6);
  T('装备闪电杖：法术强度 = 原法强 + 全部转化的攻击力（默认1:1，30+200=230）',
    Math.abs(s.abilityPower - 230) < 1e-6);

  // 反证：不装备武器的塔，attackDamage/abilityPower 都不受这条转化影响
  const bare = mkTower(ents, fx, { ad: 200, ap: 30, weapon: null });
  attr.tick();
  const s2 = attr.calc(bare, fx.getEffects(bare.id));
  T('不装备闪电杖：攻击力/法术强度不受转化影响（200/30 原样）',
    Math.abs(s2.attackDamage - 200) < 1e-6 && Math.abs(s2.abilityPower - 30) < 1e-6);
}

// ==================== ④ 闪电杖：跳伤害基数已从攻击力换成法术强度 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, fx, { ad: 100, ap: 0, weapon: 'weapon_lightning' });
  const target = mkTarget(ents);
  const inst = tw._skillInstances.find(i => i.skillId === 'weapon_lightning');
  tw.targetId = target.id;
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat, eventBus: bus };
  combat.projectiles = { fireBeam: () => {} };
  const DT = 0.05;
  for (let t = 0; t < 30; t += DT) { window.gameTime = t; attr.tick(); SkillLibrary.weapon_lightning.onFrame(tw.id, DT, inst, ctx); fx.update(DT); }
  T('满充能', (inst.state.charge || 0) >= 1);
  const hp0 = target.currentHP;
  SkillLibrary.weapon_lightning.onFrame(tw.id, 0.26, inst, ctx);
  const tickDmg = hp0 - target.currentHP;
  // AD=100 全转化为 AP=100（1:1），跳伤害 = 20%×AP(100)×满充倍率1.8 = 36
  // ——与改动前"20%×AD100×1.8"数值上恰好一致（因为默认转化比例是1:1），
  // 但现在读的是转化后的法强，不再是原始攻击力（见 AttributeCalculator 的转化注释）。
  T(`满充单跳伤害基数已切到法术强度（20%×AP100×1.8≈36，实际${tickDmg.toFixed(1)}）`,
    Math.abs(tickDmg - 36) < 1.5);
}

// ==================== ⑤ 穿透型：每层额外造成 AD/AP 混合加成伤害 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, fx, { ad: 100, ap: 50, weapon: 'weapon_piercing' });
  const target = mkTarget(ents);
  const dmgs = [];
  for (let i = 0; i < 4; i++) { attr.tick(); const b = target.currentHP; combat.performAttack(tw, target); dmgs.push(b - target.currentHP); }
  const W = CONFIG.tuning.weapons;
  const heatMult = (i) => 1 + i * (SkillLibrary.weapon_piercing.HEAT_PER_STACK ?? 0.30);
  const bonus = (i) => i * (100 * W.piercingStackAdPct / 100 + 50 * W.piercingStackApPct / 100);
  const want = [0, 1, 2, 3].map(i => 100 * heatMult(i) + bonus(i));
  T(`每层命中总伤害 = 升温倍率×AD + 层数×(AD×${W.piercingStackAdPct}%+AP×${W.piercingStackApPct}%)（实际${dmgs.map(d => d.toFixed(1)).join(',')}，期望${want.map(w => w.toFixed(1)).join(',')}）`,
    dmgs.every((d, i) => Math.abs(d - want[i]) < 1));

  // 反证：法术强度=0 时，加成伤害只剩 AD 那一项（确认 AP 项确实在起作用，不是摆设）
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const combat2 = new CombatSystem(ents2, fx2, bus2, SkillLibrary);
  const tw2 = mkTower(ents2, fx2, { ad: 100, ap: 0, weapon: 'weapon_piercing' });
  const target2 = mkTarget(ents2);
  const dmgs2 = [];
  for (let i = 0; i < 2; i++) { attr.tick(); const b = target2.currentHP; combat2.performAttack(tw2, target2); dmgs2.push(b - target2.currentHP); }
  const bonusNoAp = 1 * (100 * W.piercingStackAdPct / 100);
  const wantNoAp = 100 * heatMult(1) + bonusNoAp;
  T(`法强=0时第2下伤害只含AD那一项加成（实际${dmgs2[1].toFixed(1)}，期望${wantNoAp.toFixed(1)}）`,
    Math.abs(dmgs2[1] - wantNoAp) < 1);
}

// ==================== ⑥ 塔成长：物理攻击与法术强度同步成长（同一曲线） ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const tw = mkTower(ents, fx);
  const inst = { id: ++window._uid, skillId: 'passive_growth_outer', state: {} };
  tw._skillInstances.push(inst);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  SkillLibrary.passive_growth_outer.onEquip(tw.id, inst, ctx);
  window.gameTime = 0;
  // passive_growth_outer 的 adStartT=40：跑到 40+60=100 秒，应该正好长出第 1 层
  const DT = 0.25;
  for (let t = 0; t <= 100; t += DT) { window.gameTime = t; SkillLibrary.passive_growth_outer.onFrame(tw.id, DT, inst, ctx); }
  attr.tick();
  const s = attr.calc(tw, fx.getEffects(tw.id));
  T('外塔第1层成长后：攻击力 = 基础152+9', Math.abs(s.attackDamage - (152 + 9)) < 1e-6);
  T('外塔第1层成长后：法术强度也同步 +9（Q3新增，与攻击力同一条曲线）',
    Math.abs(s.abilityPower - 9) < 1e-6);
  const adEff = fx.getEffectByName(tw.id, '外塔成长');
  const apEff = fx.getEffectByName(tw.id, '外塔成长·法强');
  T('攻击力/法术强度两条成长效果层数一致', !!adEff && !!apEff && adEff.stacks === apEff.stacks);
}

// ==================== ⑦ 屠戮扩展到除攻城车/超级兵外的全部兵种 ====================
// 用户："除了攻城车/超级兵之外的所有兵种都要有屠戮，新加的的数值你自己定。"
{
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  T('图腾兵/术士兵/蚀骨兵默认装备了各自的屠戮被动',
    DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_rend')
    && DEFAULT_MINION_PASSIVES.warlock.includes('passive_warlock_rend')
    && DEFAULT_MINION_PASSIVES.corrupt.includes('passive_corrupt_rend'));
  T('攻城车/超级兵按用户要求排除在屠戮之外',
    !DEFAULT_MINION_PASSIVES.ram.some(k => k.includes('_rend'))
    && !DEFAULT_MINION_PASSIVES.super.some(k => k.includes('_rend')));
  T('CONFIG.rend 里三个新百分比都声明了（数值本轮由AI自定，未跑balance_matrix）',
    CONFIG.rend.totem.base === 'current' && CONFIG.rend.warlock.base === 'current' && CONFIG.rend.corrupt.base === 'current'
    && CONFIG.rend.totem.pct > 0 && CONFIG.rend.warlock.pct > 0 && CONFIG.rend.corrupt.pct > 0);

  // 结算形状验证：与 melee 屠戮同一套代码路径（_makeRendPassive 生成），只打小兵、
  // 不打塔/龙，伤害基数=攻击者自身当前生命×对应pct。
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const def = SkillLibrary.get('passive_totem_rend');
  const A = { id: ++window._uid, type: 'totem', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.totem }, currentHP: CONFIG.templates.totem.maxHP, _skillInstances: [] };
  const B = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: CONFIG.templates.melee.maxHP, _skillInstances: [] };
  const towerTarget = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: CONFIG.templates.tower.maxHP, _skillInstances: [] };
  ents.add(A); ents.add(B); ents.add(towerTarget);
  const dealt = [];
  const ctx = { entityContainer: ents, combat: { performAttackDirect: (a, b, dmg) => dealt.push(dmg) } };
  def.onDealtDamage(A.id, B.id, { state: {}, _params: {} }, ctx);
  T('图腾屠戮命中小兵：伤害 = 攻击者自身当前生命 × ' + (CONFIG.rend.totem.pct * 100) + '%',
    Math.abs(dealt[0] - CONFIG.templates.totem.maxHP * CONFIG.rend.totem.pct) < 1e-6);
  def.onDealtDamage(A.id, towerTarget.id, { state: {}, _params: {} }, ctx);
  T('图腾屠戮对塔无效（只打小兵单位）', dealt.length === 1);
}

console.log(`Q3 平衡验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
