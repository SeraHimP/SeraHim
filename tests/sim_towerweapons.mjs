/**
 * sim_towerweapons.mjs —— Q5 新塔武器验收（狂潮塔 weapon_barrage、聚能塔 weapon_nova、
 * 牧灵塔 weapon_shepherd、光棱塔 weapon_prism —— 这轮计划的全部4个新塔武器）
 *
 * 用户对狂潮塔的定稿："B，但是每层更少，层数更多。和风魂区别开来"——即每层攻速
 * 加成比风魂小、上限层数比风魂多，且叠层不按时间衰减（风魂是持续时间衰减），
 * 只在脱战/换目标时清零。聚能塔是"低频、单次巨额AOE"，蓄力被打断（掉目标）
 * 立即清零，跟"每次都有延迟"的坠星塔不是一回事。光棱塔要跟雷魂
 * （dragonsoul_thunder：命中后依次弹射）区分开——"塔本身同一时刻分裂出多条独立
 * 光束"，不是沿途弹射，见 docs/Q5-BALANCE-UNITS-TOWERS-REDESIGN.md §5.3。
 *
 * 每条断言钉"行为形状/口径"，不钉具体数值（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { CONFIG } = await import('../src/data/Config.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator: A } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');

const { T, done } = scoreboard('新塔武器（狂潮塔/聚能塔/牧灵塔/光棱塔）验收');

const mk = (ents, t, x, f, hp = 100000) => {
  const e = { id: ++window._uid, type: t, alive: true, pos: { x, y: 0 },
    baseStats: { ...(CONFIG.templates[t] || CONFIG.templates.melee) },
    currentHP: hp, _skillInstances: [], targetId: null, _mapFaction: f, faction: f,
    _inCombat: false, _combatTimer: 0, attackCooldown: 0, lastDamageTime: -Infinity,
    shieldFixedCurrent: 0, tempShield: 0, _attackerCount: 0 };
  e.baseStats.maxHP = hp; ents.add(e); return e;
};

/** 模拟 main.js 里真实的 combat.setCreateMinion 注入（签名与 sim_summoner.mjs 同一份约定）。 */
function fakeCreateMinion(ents) {
  return (type, x, y, faction, hpScale = 1, attrScale = 1) => {
    const tpl = CONFIG.templates[type];
    if (!tpl) return null;
    return mk(ents, type, x, faction, Math.round(tpl.maxHP * hpScale));
  };
}

function W() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  combat.createMinion = fakeCreateMinion(ents);
  return { bus, ents, fx, combat,
    ctx: { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: A, combat, waveNumber: 0 } };
}

const mapStub = {
  active: true,
  currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }] },
  getDefenseZone: () => null,
  isWalkable: () => true,
  constrainToWalkable: (p) => p,
};

// ==================== 一、连珠炮（weapon_barrage）：伤害/命中效率 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_barrage', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  const r = SkillLibrary.weapon_barrage.onBeforeAttack(tower, target, inst, ctx);
  const p = SkillLibrary.weapon_barrage.defaultParams;
  T(`命中①-onBeforeAttack 返回 preDamageMult=${p.preDamageMultPct}%（出厂值，钉住行为形状不钉数字）`,
    Math.abs(r.preDamageMult - (p.preDamageMultPct / 100)) < 1e-9);
  T(`命中②-onBeforeAttack 返回 attackShare=${p.onHitEffPct}%（"命中效率"）`,
    Math.abs(r.attackShare - (p.onHitEffPct / 100)) < 1e-9);
  T('命中③-没有 skipProjectile（连珠炮走正常开火，不是自带结算的特殊攻击）',
    !r.skipProjectile);
}

// ==================== 二、连珠炮：总攻速+100% 且不吃攻速收益率折扣 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackSpeedRatio = 0.3; // 故意压低收益率，验证这个加成绕过它
  const asBefore = A.calcAttackSpeedOf(A.calc(tower, fx.getEffects(tower.id)));
  equipSkill(tower, 'weapon_barrage', ctx);
  const asAfter = A.calcAttackSpeedOf(A.calc(tower, fx.getEffects(tower.id)));
  const p = SkillLibrary.weapon_barrage.defaultParams;
  const expectMult = 1 + (p.baseAttackSpeedBonusPct / 100);
  T('攻速①-装备后攻速精确翻到 (1+加成%) 倍，不被 attackSpeedRatio 打折',
    Math.abs(asAfter / asBefore - expectMult) < 1e-6);
}

// ==================== 三、连珠炮：按秒叠层，不按时间衰减，只有脱战才清零 ====================
// v51.33 机制改动：用户定稿"脱战或切换目标立即清空层数"改成"只有脱离战斗后
// 层数才消失"——换目标不再打断叠层，只要塔一直在战斗状态就持续涨，直到真的
// 脱离战斗（没有存活目标/entity._inCombat 变 false）才清零。
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_barrage', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  tower.targetId = target.id; tower._inCombat = true;
  const p = SkillLibrary.weapon_barrage.defaultParams;

  for (let i = 0; i < 3; i++) SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  let eff = fx.getEffectByName(tower.id, '连珠');
  T('叠层①-命中同一目标 3 秒后叠了 3 层', eff && eff.stacks === 3);

  // 换目标：本轮改动后不应该再清零——层数继续在新目标身上累加。
  const target2 = mk(ents, 'melee', 60, 'red');
  tower.targetId = target2.id;
  SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  eff = fx.getEffectByName(tower.id, '连珠');
  T('叠层②-换目标后层数不清零，继续在新目标身上累加（本轮机制改动的核心）',
    eff && eff.stacks === 4);

  // 长时间不动（模拟"不按时间衰减"）：多跑几秒不清零，中途再换一次目标也一样继续涨，
  // 只要一直在战斗状态就冲到封顶。
  for (let i = 0; i < 50; i++) SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  eff = fx.getEffectByName(tower.id, '连珠');
  T(`叠层③-层数封顶在 maxStacks=${p.maxStacks}，不会无限涨`, eff && eff.stacks === p.maxStacks);
  T('叠层④-封顶后层数不随时间自然衰减（effect 是 permanent，不吃 remainingTime 递减）',
    eff && eff.blueprint.permanent === true);

  // 脱离战斗：唯一的清零条件。
  tower._inCombat = false;
  SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  eff = fx.getEffectByName(tower.id, '连珠');
  T('叠层⑤-脱战后层数清零（脱战是现在唯一会清空层数的条件）', !eff);
}

// ==================== 四、连珠炮：与风魂区别开——每层更少、层数更多 ====================
{
  const barrage = SkillLibrary.weapon_barrage.defaultParams;
  const windSoul = CONFIG.dragonSouls?.wind || {};
  // 风魂是 dragonsoul_wind 的每层攻速加成（比如 perStack），跟连珠炮的 stackPct 比较：
  // 用户口径是"每层更少，层数更多"——不钉绝对数字，只钉这个相对关系成立。
  const windPerStack = windSoul.attackSpeedPerStack ?? windSoul.perStack ?? null;
  if (windPerStack != null) {
    T('区分①-连珠炮每层攻速加成比风魂每层更小', barrage.stackPct < windPerStack);
  }
  const windMaxStacks = windSoul.maxStacks ?? null;
  if (windMaxStacks != null) {
    T('区分②-连珠炮层数上限比风魂更多', barrage.maxStacks > windMaxStacks);
  }
}

// ==================== 五、连珠炮：卸下武器清理残留效果 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_barrage', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  tower.targetId = target.id; tower._inCombat = true;
  SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  T('卸下①-装备后确实生效了超频buff', !!fx.getEffectByName(tower.id, '连珠炮·超频'));
  SkillLibrary.weapon_barrage.onUnequip(tower.id, inst, ctx);
  T('卸下②-卸下后超频buff清理干净', !fx.getEffectByName(tower.id, '连珠炮·超频'));
  T('卸下③-卸下后叠层buff清理干净', !fx.getEffectByName(tower.id, '连珠'));
}

// ==================== 六、聚能炮（weapon_nova）：真正复用 atkmode_charge，不是自己另起一套 ====================
// 用户反馈"聚能炮依旧0充能，这个充能方式和攻城车是一样的，需要修复"。真根因：
// nova 原来自己在 onFrame 里另起一套 instance.state.charge 累加/衰减逻辑，跟攻城车
// 用的 atkmode_charge（entity._charge，由 CombatSystem._tickCharge 统一维护、经过
// 长期验证）是两套完全独立、没有共享一行代码的实现。现在改成：装备 nova 时顺带
// 装上 atkmode_charge，真正的充能状态全部记在 entity._charge 上，nova 自己的
// onFrame 只负责"读有没有充满、充满了打一炮"。
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  T('接线①-装备聚能炮时顺带装上了atkmode_charge（真正复用同一套充能系统）',
    (tower._skillInstances || []).some(s => s.skillId === 'atkmode_charge'));
  T('接线②-CombatSystem.chargeNeedOf 认得这座塔在充能（走的是共享判据，不是nova自己判）',
    !!ctx.combat.chargeNeedOf(tower, target));

  const r = SkillLibrary.weapon_nova.onBeforeAttack(tower, target, inst, ctx);
  T('特殊①-onBeforeAttack 返回 skipProjectile（命中完全由自己的充能判定结算）',
    r.skipProjectile === true);
  T('特殊②-声明为 specialAttack（跟闪电杖同一类）', SkillLibrary.weapon_nova.specialAttack === true);

  // 卸载武器时要把顺带装的 atkmode_charge 一起摘掉，不留孤儿实例。
  tower._skillInstances = tower._skillInstances.filter(s => s.skillId === 'weapon_nova');
  SkillLibrary.weapon_nova.onUnequip(tower.id, inst, ctx);
  T('接线③-卸载聚能炮时一并摘掉atkmode_charge（不留孤儿实例）',
    !(tower._skillInstances || []).some(s => s.skillId === 'atkmode_charge'));
}

// 推进充能的小工具：真实游戏里充能靠 CombatSystem._tickCharge（对全体实体每帧统一
// 跑一次），不再是 weapon_nova.onFrame 自己攒——测试要驱动充能就必须调它，直接
// 调 weapon_nova.onFrame 只能测"充满了会不会开火"这一半。
function tickNovaCharge(combat, ctx, tower, dt) {
  const stats = ctx.attrCalc.calc(tower, ctx.effectRegistry.getEffects(tower.id));
  combat._tickCharge(tower, stats, dt);
}

// ==================== 七、聚能炮：蓄力——掉目标按秒衰减（不再瞬间清零）====================
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  tower.targetId = target.id;
  tickNovaCharge(combat, ctx, tower, 3.0);
  T('蓄力①-蓄了一段时间后 charge>0', tower._charge > 0);

  const chargeBefore = tower._charge;
  tower.targetId = null; // 掉目标
  tickNovaCharge(combat, ctx, tower, 0.1);
  T('蓄力②-掉目标后不再瞬间清零，只是比之前略低（按秒衰减，不是瞬间归零）',
    tower._charge > 0 && tower._charge < chargeBefore);
}

// ==================== 七b、聚能炮：换目标不会打断蓄力（真实对局里最常见的场景）====================
// 用户此前反馈"聚能炮不会攻击"，根因是旧实现把"换了目标"当成"蓄力被打断"、
// 立即清零重蓄——真实混战里目标每隔一两秒就会换一次（小兵死亡/被替换），蓄力
// 因此永远攒不到满值。现在换目标走的是 atkmode_charge 同一套判据：只要【这一刻
// 还有某个可打的目标】就继续累积，跟目标是不是同一个无关。
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  equipSkill(tower, 'weapon_nova', ctx);
  let foe = mk(ents, 'melee', 50, 'red');
  tower.targetId = foe.id;
  tickNovaCharge(combat, ctx, tower, 2.0);
  const chargeBeforeSwitch = tower._charge;
  T('换目标①-蓄力确实在涨', chargeBeforeSwitch > 0);

  // 旧目标"死"了，新目标顶上——这是真实对局里最常见的换目标场景。
  foe.alive = false;
  foe = mk(ents, 'melee', 55, 'red');
  tower.targetId = foe.id;
  tickNovaCharge(combat, ctx, tower, 2.0);
  T('换目标②-换了目标之后蓄力继续往上涨，不会被打回0重新开始',
    tower._charge > chargeBeforeSwitch);
}

// ==================== 七c、聚能炮：真实混战节奏（目标每2秒换一次）下最终能蓄满并开火 ====================
// 用户报的"0充能"是在真实对局（目标churn很快）里看到的现象，这条断言直接复现
// 那个场景：驱动 CombatSystem.update() 本身（不是单独调 onFrame），目标每2秒
// 死一个换一个，跑够久之后必须真的打出去过至少一次。
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackRange = 500;
  equipSkill(tower, 'weapon_nova', ctx);
  let foe = mk(ents, 'melee', 50, 'red', 10_000_000);

  let fireCount = 0;
  const origPAD = combat.performAttackDirect.bind(combat);
  combat.performAttackDirect = (...args) => { fireCount++; return origPAD(...args); };

  window.gameTime = 0;
  for (let i = 0; i < 2400; i++) {   // 80秒
    window.gameTime += 1 / 30;
    combat.update(1 / 30);
    if (i > 0 && i % 60 === 0) { foe.alive = false; foe.currentHP = 0; foe = mk(ents, 'melee', 50, 'red', 10_000_000); }
  }
  combat.performAttackDirect = origPAD;
  T('真实节奏-80秒、每2秒换一次目标的混战里，聚能炮确实开过火（不是0充能卡死）', fireCount > 0);
}

// ==================== 八、聚能炮：蓄满后单次巨额AOE命中 ====================
{
  const { ents, fx, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackDamage = 1000;
  tower.baseStats.attackType = 'physical';
  equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red', 10_000_000);
  target.baseStats.armor = 0;
  const bystander = mk(ents, 'melee', 55, 'red', 10_000_000); // 站在爆点附近，应该吃到溅射
  bystander.baseStats.armor = 0;
  const farAway = mk(ents, 'melee', 5000, 'red', 10_000_000); // 远处不该被打到
  farAway.baseStats.armor = 0;
  tower.targetId = target.id;

  const hpBefore = target.currentHP, hpBystanderBefore = bystander.currentHP, hpFarBefore = farAway.currentHP;
  // 先用充能推进工具把 entity._charge 直接推到刚好蓄满，再跑一次 onFrame 触发开火——
  // 不用循环猜多少帧才能蓄满，充能推进和"充满了打一炮"现在是两件独立的事。
  tower._charge = 1;
  const novaInst = tower._skillInstances.find(s => s.skillId === 'weapon_nova');
  SkillLibrary.weapon_nova.onFrame(tower.id, 0.1, novaInst, ctx);

  T('命中①-主目标吃到了伤害（蓄满打出去了）', target.currentHP < hpBefore);
  T('命中②-附近的旁观者也吃到了溅射伤害（范围AOE）', bystander.currentHP < hpBystanderBefore);
  T('命中③-远处的单位没被波及（不是全图AOE）', farAway.currentHP === hpFarBefore);
  T('命中④-主目标伤害明显高于溅射到旁观者的伤害（中心命中不打折，旁边才衰减）',
    (hpBefore - target.currentHP) > (hpBystanderBefore - bystander.currentHP));
  T('命中⑤-打完一发后 charge 归零重新蓄力', tower._charge === 0);
}

// ==================== 八b、聚能炮：修复"子弹不显示"——没接 ProjectileSystem.fireBeam ====================
// 用户报告："聚能炮子弹不显示。"根因：聚能炮走 atkmode_charge 充能状态机，跟闪电杖
// 同一类（ProjectileSystem.fireBeam 头注早把"闪电杖/聚能炮"列为同类调用点），但
// nova 落地时从没调用过 fireBeam——充能到开火全程没有任何画面反馈。修复：onFrame
// 每帧都调 ctx.combat.projectiles.fireBeam，charge 传 entity._charge（0~1），换目标
// 时先 clearBeam 清掉旧光束（与闪电杖的既有处理一致）。
{
  const { ents, fx, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  tower.targetId = target.id;
  const novaInst = tower._skillInstances.find(s => s.skillId === 'weapon_nova');

  const fireBeamCalls = [];
  const clearBeamCalls = [];
  combat.projectiles = {
    fireBeam: (beam) => fireBeamCalls.push(beam),
    clearBeam: (attackerId) => clearBeamCalls.push(attackerId),
  };

  // 充能中途（没打满）：应该也画一条光束，charge 反映当前充能比例，不是只有命中那一帧才画。
  tower._charge = 0.4;
  SkillLibrary.weapon_nova.onFrame(tower.id, 0.1, novaInst, ctx);
  T('视觉①-充能中途也调用了 fireBeam（不是只有开火那一帧才有画面）', fireBeamCalls.length === 1);
  T('视觉②-光束端点是塔到目标的连线', fireBeamCalls[0].startX === tower.pos.x && fireBeamCalls[0].endX === target.pos.x);
  T('视觉③-charge 字段如实反映 entity._charge（充能进度=画面亮度/粗细的依据）', fireBeamCalls[0].charge === 0.4);
  T('视觉④-attackerId 传了塔自己的 id（fireBeam 靠它当 Map key，同一座塔只留一条光束）',
    fireBeamCalls[0].attackerId === tower.id);

  // 蓄满打出去那一帧同样要画（不能因为命中判定提前 return 而漏掉这次的光束刷新）。
  tower._charge = 1;
  SkillLibrary.weapon_nova.onFrame(tower.id, 0.1, novaInst, ctx);
  T('视觉⑤-蓄满命中的那一帧同样调用了 fireBeam', fireBeamCalls.length === 2);

  // 换目标：应该先清掉旧光束，不留"指向空气的残影"（与闪电杖同一处理）。
  const target2 = mk(ents, 'melee', 90, 'red');
  tower.targetId = target2.id;
  tower._charge = 0.1;
  SkillLibrary.weapon_nova.onFrame(tower.id, 0.1, novaInst, ctx);
  T('视觉⑥-换目标时调用了 clearBeam 清掉旧光束', clearBeamCalls.includes(tower.id));
  T('视觉⑦-换目标后新一帧的光束端点指向新目标', fireBeamCalls[2].endX === target2.pos.x);
}

// ==================== 九、编辑器/UI枚举接线没有漏掉 barrage/nova ====================
{
  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举①-UnitAddDialog.js 的 WEAPONS 认得连珠炮和聚能炮',
    /barrage:\s*\{[^}]*连珠炮/.test(dialogSrc) && /nova:\s*\{[^}]*聚能炮/.test(dialogSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举②-pagesEntity.js 的 weaponMeta 认得 weapon_barrage 和 weapon_nova',
    /weapon_barrage:\s*\{[^}]*连珠炮/.test(entitySrc) && /weapon_nova:\s*\{[^}]*聚能炮/.test(entitySrc));

  T('枚举③-weapon_barrage/weapon_nova 的 applicableTypes 包含 tower（这样才会被 _SKILLS_BY_TYPE 自动收进武器桶）',
    SkillLibrary.weapon_barrage.applicableTypes.includes('tower')
    && SkillLibrary.weapon_nova.applicableTypes.includes('tower')
    && SkillLibrary.weapon_barrage.category === 'weapon'
    && SkillLibrary.weapon_nova.category === 'weapon');
}

// ==================== 十、牧灵法阵（weapon_shepherd）：塔本身不攻击 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  const r = SkillLibrary.weapon_shepherd.onBeforeAttack(tower, target, inst, ctx);
  T('无攻击①-onBeforeAttack 永远返回 skipProjectile（塔本身没有攻击能力）',
    r.skipProjectile === true);
}

// ==================== 十一、牧灵法阵：召唤幻兽（现在是两只）+ 属性按塔的百分比缩放 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.maxHP = 2000; tower.baseStats.attackDamage = 100;
  tower.baseStats.armor = 40; tower.baseStats.magicResist = 40;
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;

  // 幻兽是"零冷却排队生成"（respawnAt初始为0），maxAlive只需要跑几帧就能全部凑齐。
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('召唤①-onFrame 跑几次后凑齐了maxAlive只幻兽', inst.state.petIds.length === (p.maxAlive ?? 2));
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  T('召唤②-幻兽是 type:melee（复用现有小兵管线）', pet && pet.type === 'melee');
  // 用户报的bug"幻兽模型会和塔的模型重叠"：幻兽不该生在塔的坐标点上（塔自身模型
  // 就占着那块地方），改成生在塔外一圈的待机位——离塔中心的距离＝塔模型半径+间隙。
  const spawnTowerR = CONFIG.buildingSizes[tower._mapTier] ?? CONFIG.buildingSizes.default;
  const spawnDist = pet && Math.hypot(pet.pos.x - tower.pos.x, pet.pos.y - tower.pos.y);
  T('召唤③-幻兽出生在塔外的待机位，不在塔的模型半径以内（不重叠）',
    pet && spawnDist > spawnTowerR);
  T('召唤③b-出生点距离精确等于塔模型半径+idleClearance（不是随便定的偏移）',
    pet && Math.abs(spawnDist - (spawnTowerR + (p.idleClearance ?? 40))) < 1e-6);
  const pct = (p.statPct ?? 60) / 100;
  T('召唤④-幻兽生命值≈塔生命值的statPct%',
    Math.abs(pet.baseStats.maxHP - tower.baseStats.maxHP * pct) < 1e-6);
  T('召唤④b-幻兽出生时currentHP=满血（用户报的"出生只有几百血"bug——旧实现出生时'
    + 'currentHP还停在melee模板的小体量，maxHP却已经改成塔的量级）',
    pet.currentHP === pet.baseStats.maxHP);
  T('召唤⑤-幻兽攻击力≈塔攻击力的statPct%',
    Math.abs(pet.baseStats.attackDamage - tower.baseStats.attackDamage * pct) < 1e-6);
  T('召唤⑥-幻兽记录了主人塔的id（拴绳依据）', pet && pet._petOwnerId === tower.id);
  T('召唤⑦-幻兽有拴绳半径', pet && pet._petLeashRadius === (p.leashRadius ?? 260));
  T('召唤⑧-幻兽打了_isSummoned标记（不记熵，同幻灵口径）', pet && pet._isSummoned === true);

  // 已经凑满maxAlive只时不会继续召唤更多。
  const beforeIds = [...inst.state.petIds];
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('召唤⑨-凑满maxAlive只后不会继续召唤更多', inst.state.petIds.length === beforeIds.length);

  // 幻兽有独立技能（用户追加定稿"1+2，要不然幻兽太弱了"）。
  T('召唤⑩-幻兽装备了独立技能passive_pet_spirit_guard',
    pet._skillInstances?.some(s => s.skillId === 'passive_pet_spirit_guard'));
  // 用户定稿"不要复用近战兵的"：createMinion 按 type:'melee' 自动挂的默认主动/
  // 被动（本能防御等）要在生成后立刻摘掉，幻兽的技能栏里不该出现它们。
  T('召唤⑩b-幻兽没有近战兵的默认主动技能active_melee_block（不复用近战兵的）',
    !pet._skillInstances?.some(s => s.skillId === 'active_melee_block'));
  T('召唤⑩c-幻兽没有近战兵的默认被动passive_melee_rend（不复用近战兵的）',
    !pet._skillInstances?.some(s => s.skillId === 'passive_melee_rend'));
}

// ==================== 十一b、牧灵法阵：塔后续获得的增益会持续按比例转到幻兽身上 ====================
// 用户追加定稿："塔获得增益会按照一定百分比转换到幻兽上（幻兽是塔的一部分）"——
// 不是只在召唤那一刻定死属性，塔之后再变强，已经在场的幻兽也要跟着变强。
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.maxHP = 1000; tower.baseStats.attackDamage = 50;
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  const pct = (p.statPct ?? 60) / 100;
  T('增益前①-幻兽属性一开始按塔当时的属性算', Math.abs(pet.baseStats.attackDamage - 50 * pct) < 1e-6);

  // 塔后来变强了（比如吃到了龙魂/成长）——不用重新装备武器，下一帧幻兽属性就该跟涨。
  // attrCalc.calc 有帧级缓存（同一帧内同一实体+同样效果集合直接复用），真实主循环
  // 每帧调用一次 tick() 使其失效（见 main.js），这里手动推进一帧来对齐真实时序，
  // 否则 baseStats 改了但缓存没失效，测的是缓存问题而不是传导逻辑本身。
  A.tick();
  tower.baseStats.attackDamage = 200;
  tower.baseStats.maxHP = 4000;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('增益后①-幻兽攻击力跟着塔的新属性同步涨了', Math.abs(pet.baseStats.attackDamage - 200 * pct) < 1e-6);
  T('增益后②-幻兽生命上限也跟着涨了', Math.abs(pet.baseStats.maxHP - 4000 * pct) < 1e-6);
}

// ==================== 十二、牧灵法阵：幻兽回血机制——共享塔的healthRegen，不再是塔"推"血 ====================
// 用户定稿："回血机制改为和共享防御塔的属性，本身不具备任何回血能力"——幻兽不再
// 由塔按固定healPerSec主动"推"治疗，而是幻兽自己的healthRegen属性本身就是从塔的
// healthRegen按statPct继承来的（走PET_INHERITED_STAT_FIELDS那条通用路径），实际
// 回血靠CombatSystem.update()对**所有实体**都跑的通用生命恢复tick，跟其它任何
// 单位同一条路，不是weapon_shepherd自己手写的applyHeal调用。
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.healthRegen = 20;
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  const pct = (p.statPct ?? 60) / 100;
  T('回血①-幻兽的healthRegen属性是塔healthRegen的statPct%（共享塔的属性）',
    Math.abs(pet.baseStats.healthRegen - 20 * pct) < 1e-6);

  pet.currentHP = pet.baseStats.maxHP * 0.5;
  const before = pet.currentHP;
  combat.update(1.0);
  T('回血②-幻兽确实按继承来的healthRegen自然回血（不再需要weapon_shepherd自己推血）',
    pet.currentHP > before);
}

// ==================== 十二b、牧灵法阵：塔本身没有回血能力时幻兽也没有 ====================
// "本身不具备任何回血能力"：塔的healthRegen是0（默认防御塔就是0），幻兽继承到的
// 也是0——回血能力完全靠共享，不是幻兽自己另外还揣着一份。
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.healthRegen = 0;
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  pet.currentHP = pet.baseStats.maxHP * 0.5;
  const before = pet.currentHP;
  combat.update(1.0);
  T('回血③-塔没有healthRegen时幻兽也没有回血', pet.currentHP === before);
}

// ==================== 十二c、牧灵法阵：幻兽脱战后额外获得+100%治疗与护盾强度 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);

  // 幻兽出生时 lastDamageTime 是 -Infinity（"从没挨过打"，机械上等同"已脱战"），
  // 前面5次spawn循环的onFrame已经把脱战aura打上了——先手动摘掉，才能干净地测
  // "刚挨打①"这条（不然测的是"aura还没到宽限期"，不是"在战斗中不会重新施加"）。
  const preExisting = fx.getEffectByName(pet.id, '灵体疗愈');
  if (preExisting) fx.remove(preExisting.id);
  window.gameTime = 100;
  pet.lastDamageTime = window.gameTime; // 刚挨打，还在战斗中
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('脱战①-刚挨打时（还在战斗中）不会获得脱战治疗强度加成',
    !fx.getEffectByName(pet.id, '灵体疗愈'));

  window.gameTime = 200; // 早就没挨打了（超过shieldRegenDelay）
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const eff = fx.getEffectByName(pet.id, '灵体疗愈');
  T('脱战②-脱离战斗一段时间后幻兽获得+outOfCombatHealPowerPct%治疗与护盾强度',
    !!eff && Math.abs(eff.blueprint.flatValue - (p.outOfCombatHealPowerPct ?? 100)) < 1e-6);
}

// ==================== 十三、牧灵法阵：死亡后延迟复活，且每死一次复利多等一点 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('前置-先凑满两只', inst.state.petIds.length === (p.maxAlive ?? 2));
  const pet1 = ctx.entityContainer.get(inst.state.petIds[0]);
  pet1.currentHP = 0; pet1.alive = false; // 其中一只死亡

  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('复活①-幻兽死后没有立即补上（少了一只）', inst.state.petIds.length === (p.maxAlive ?? 2) - 1);
  const base = p.baseRespawnSec ?? 15;
  T('复活②-第一次死亡的复活等待时间≈baseRespawnSec',
    Math.abs(inst.state.respawnAt - (window.gameTime || 0) - base) < 1e-6);

  window.gameTime = (window.gameTime || 0) + base + 0.1;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('复活③-等待时间到了之后补回满编', inst.state.petIds.length === (p.maxAlive ?? 2));

  const deadAgainId = inst.state.petIds[0];
  const petAgain = ctx.entityContainer.get(deadAgainId);
  petAgain.currentHP = 0; petAgain.alive = false; // 第二次死亡
  const gameTimeAtDeath2 = window.gameTime || 0;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const growth = (p.respawnGrowthPct ?? 5) / 100;
  const expectedWait2 = base * (1 + growth); // 第二次死亡：复利一次
  T('复活④-第二次死亡的复活等待时间比第一次更长（复利，不是固定加几秒）',
    Math.abs(inst.state.respawnAt - gameTimeAtDeath2 - expectedWait2) < 1e-6);
  window.gameTime = 0; // 复位，避免影响后面的用例
}

// ==================== 十四、牧灵法阵：卸下武器时全部幻兽立即消失（非战斗死亡） ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pets = inst.state.petIds.map(id => ctx.entityContainer.get(id));
  T('卸下①-装备后确实有活着的幻兽', pets.length > 0 && pets.every(p => p.alive));
  SkillLibrary.weapon_shepherd.onUnequip(tower.id, inst, ctx);
  T('卸下②-卸下武器后全部幻兽立即死亡', pets.every(p => !p.alive));
}

// ==================== 十五、牧灵法阵：塔死亡后幻兽清理（CombatSystem.update） ====================
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  tower.currentHP = 0; tower.alive = false; // 塔被拆
  combat.update(0.1);
  T('孤儿清理①-主人塔死亡后幻兽在下一次update中也跟着消失', !pet.alive);
}

// ==================== 十六、牧灵法阵：拴绳接敌AI（LaneMovementSystem._updatePet） ====================
{
  const { ents, combat, ctx } = W();
  const lms = new LaneMovementSystem(ents, ctx.effectRegistry, ctx.attrCalc, combat, mapStub);
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  for (let i = 0; i < 5; i++) SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petIds[0]);
  pet.pos.x = tower.pos.x; pet.pos.y = tower.pos.y;
  const leash = pet._petLeashRadius;

  // 拴绳范围内的敌人：应该会追过去
  const nearFoe = mk(ents, 'melee', leash * 0.5, 'red');
  const before1 = { x: pet.pos.x, y: pet.pos.y };
  lms._updatePet(pet, 1.0);
  T('接敌①-拴绳范围内的敌人会被追击（幻兽移动了）',
    pet.pos.x !== before1.x || pet.pos.y !== before1.y);

  // 拴绳范围外的敌人：不该被追。幻兽先站定在自己算好的待机点上（不是塔的坐标点——
  // 那正是"重叠"bug修完之后的新语义），这样"没有移动"测的才是"没追那个远处的敌人"，
  // 不会跟"没到待机点所以本来就要走"这两件事混在一起。
  ents.remove ? ents.remove(nearFoe.id) : (nearFoe.alive = false);
  {
    const idleTowerR = CONFIG.buildingSizes[tower._mapTier] ?? CONFIG.buildingSizes.default;
    const idleStandoff = idleTowerR + (pet._petIdleClearance ?? 40);
    pet.pos.x = tower.pos.x + Math.cos(pet._petIdleAngle || 0) * idleStandoff;
    pet.pos.y = tower.pos.y + Math.sin(pet._petIdleAngle || 0) * idleStandoff;
  }
  pet.targetId = null;
  const farFoe = mk(ents, 'melee', leash * 3, 'red');
  const before2 = { x: pet.pos.x, y: pet.pos.y };
  lms._updatePet(pet, 1.0);
  T('接敌②-拴绳范围外的敌人不会被追击（幻兽已在待机点上，不会再移动）',
    pet.pos.x === before2.x && pet.pos.y === before2.y);

  // 无目标时离主人太远要往回收
  farFoe.alive = false;
  pet.pos.x = tower.pos.x + 500; pet.pos.y = tower.pos.y; pet.targetId = null;
  const before3 = pet.pos.x;
  lms._updatePet(pet, 1.0);
  T('归位①-无目标且离主人较远时会往主人方向收拢', pet.pos.x < before3);

  // ==================== 修复"幻兽模型会和塔的模型重叠"====================
  // 用户报的bug：幻兽待机归位点原来是直接收到塔的坐标点上（塔自身模型半径就有
  // 32~44，旧的"离塔中心<40停"完全兜不住），现在待机点应该是塔外一圈、离塔边缘
  // 有固定间隙的点，不会收缩进塔的模型里。
  pet.pos.x = tower.pos.x; pet.pos.y = tower.pos.y; pet.targetId = null;
  for (let i = 0; i < 300; i++) lms._updatePet(pet, 1 / 30);
  const finalDistFromTower = Math.hypot(pet.pos.x - tower.pos.x, pet.pos.y - tower.pos.y);
  const towerR = CONFIG.buildingSizes[tower._mapTier] ?? CONFIG.buildingSizes.default;
  T('重叠修复①-幻兽最终稳定的待机点在塔的模型半径之外（不会陷进塔的几何里）',
    finalDistFromTower > towerR);
  T('重叠修复②-待机点距离≈塔半径+idleClearance（精确落在算好的待机点上，不是随便停在某处）',
    // 容差覆盖 _updatePet 里"离待机点<8就停"的停止阈值，不是断言算法有误差。
    Math.abs(finalDistFromTower - (towerR + (pet._petIdleClearance ?? 40))) < 8);

  // 两只幻兽的待机点不应该叠在同一个点上（各自的 _petIdleAngle 不同）。
  const pet2 = ctx.entityContainer.get(inst.state.petIds[1]);
  T('重叠修复③-两只幻兽的待机角度不同（不会叠在同一个待机点上）',
    pet._petIdleAngle !== pet2._petIdleAngle);
}

// ==================== 十七、编辑器/UI枚举接线没有漏掉 shepherd ====================
{
  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举①-UnitAddDialog.js 的 WEAPONS 认得牧灵法阵', /shepherd:\s*\{[^}]*牧灵法阵/.test(dialogSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举②-pagesEntity.js 的 weaponMeta 认得 weapon_shepherd',
    /weapon_shepherd:\s*\{[^}]*牧灵法阵/.test(entitySrc));

  T('枚举③-weapon_shepherd 的 applicableTypes 包含 tower',
    SkillLibrary.weapon_shepherd.applicableTypes.includes('tower')
    && SkillLibrary.weapon_shepherd.category === 'weapon');
}

// ==================== 十八、渲染层：牧灵法阵不画红线，改画绿色拴绳线 ====================
// 用户原话："塔本身就不要再显示攻击红线了，而是显示绿线和幻兽相连"。
// 渲染层需要 THREE.js/DOM，这里不真的跑渲染，钉源码里的接线（跟 sim_v43.mjs 已有的
// 红线源码断言同一种手法）。
{
  const fxSrc = srcOf('src/presentation/EffectsLayer.js');
  T('渲染①-塔攻击红线的循环里排除了 weapon_shepherd（不再画"正在输出"的红线）',
    /wid === 'weapon_corrosion' \|\| wid === 'weapon_shepherd'/.test(fxSrc));
  T('渲染②-新增了牧灵法阵专属的拴绳线渲染，读的是 state.petIds',
    /petLeashLine/.test(fxSrc) && /inst\?\.state\?\.petIds/.test(fxSrc));

  const cfgSrc = srcOf('src/data/Config.js');
  T('渲染③-拴绳线颜色走 CONFIG.ui.petLeashLine（软编码，不是写死的颜色常量）',
    /petLeashLine:\s*\{/.test(cfgSrc));
}

// ==================== 十九、幻兽独立技能（passive_pet_spirit_guard）自身机制 ====================
// 用户追加定稿："1+2，要不然幻兽太弱了"——攻击附带小型减速 + 受击概率触发自保护盾。
{
  const { ents, fx, ctx } = W();
  const pet = mk(ents, 'melee', 0, 'blue');
  const inst = equipSkill(pet, 'passive_pet_spirit_guard', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  const p = SkillLibrary.passive_pet_spirit_guard.defaultParams;

  SkillLibrary.passive_pet_spirit_guard.onDealtDamage(pet.id, target.id, inst, ctx);
  const slowEff = fx.getEffectByName(target.id, '灵体侵蚀');
  T('机制①-命中目标后附带减速效果', !!slowEff);
  T('机制②-减速幅度≈onHitSlowPct', slowEff && Math.abs(slowEff.blueprint.percentValue - (p.onHitSlowPct ?? -20)) < 1e-6);

  const realRandom = Math.random;
  try {
    Math.random = () => 0; // 保证抽中
    SkillLibrary.passive_pet_spirit_guard.onBeingAttacked(pet.id, target.id, inst, ctx);
    const shieldEff = fx.getEffectByName(pet.id, '灵体守护盾');
    T('机制③-受击时抽中概率会给自己上一层护盾', !!shieldEff);
    T('机制④-护盾量≈shieldAmount', shieldEff && Math.abs(shieldEff.blueprint.flatValue - (p.shieldAmount ?? 60)) < 1e-6);

    // 冷却里再次挨打不会重复触发（哪怕又抽中）——effectRegistry 上不会多出第二份实例。
    SkillLibrary.passive_pet_spirit_guard.onBeingAttacked(pet.id, target.id, inst, ctx);
    T('机制⑤-冷却期内再次挨打不会重复触发（护盾效果实例没有变成两份/叠加两次）',
      fx.getEffects(pet.id).filter(e => e.blueprint.name === '灵体守护盾').length === 1);
  } finally {
    Math.random = realRandom;
  }
}

// ==================== 二十、幻兽 3D 造型：渲染层单独路由，不长得像小兵 ====================
// 用户明确要求"幻兽的模型就不要弄成小兵了，新做一个模型"。entity.type 必须留着 'melee'
// （战斗/属性模板需要，见 weapon_shepherd.onFrame 用 combat.createMinion('melee', ...)），
// 造型另路由到渲染专用伪类型 'shepherd_pet'，见 SpriteFactory.minionRenderType。
{
  const { minionRenderType } = await import('../src/presentation/SpriteFactory.js');
  T('路由①-普通近战兵（无_petOwnerId）渲染类型仍是melee',
    minionRenderType({ type: 'melee' }) === 'melee');
  T('路由②-带_petOwnerId的幻兽渲染类型被路由到shepherd_pet',
    minionRenderType({ type: 'melee', _petOwnerId: 1 }) === 'shepherd_pet');

  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { minionMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const petMesh = minionMesh('mm-pet-test', '#5b9bd5', 9, 'shepherd_pet', 'blue');
    T('模型①-shepherd_pet 能造出几何', !!petMesh.geo && petMesh.topY > 0);
    const meleeMesh = minionMesh('mm-melee-test', '#5b9bd5', 9, 'melee', 'blue');
    T('模型②-幻兽造型与普通近战兵不是同一份几何（不会和小兵长一样）',
      petMesh.geo.attributes.position.count !== meleeMesh.geo.attributes.position.count);
  }
}

// ==================== 二十一、光棱塔（weapon_prism）验收 ====================
// 用户要求"塔本身同一时刻分裂出多条独立光束"，跟雷魂"依次弹射"明确区分开。
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackRange = 1000;
  tower.baseStats.attackDamage = 100;
  const inst = equipSkill(tower, 'weapon_prism', ctx);
  const p = SkillLibrary.weapon_prism.defaultParams;

  // 6个候选目标，只有最近的 maxBranches 个该挨打。
  const near = [];
  for (let i = 0; i < 6; i++) near.push(mk(ents, 'melee', 100 + i * 30, 'red', 1000000));

  for (let i = 0; i < 300; i++) SkillLibrary.weapon_prism.onFrame(tower.id, 1 / 30, inst, ctx);

  const hit = near.filter(e => e.currentHP < 1000000);
  T('分支①-同一时刻只命中最多maxBranches个不同目标（不是全射程AOE，也不是依次弹射全部6个）',
    hit.length === (p.maxBranches ?? 4));
  T('分支②-命中的是最近的那几个（机械按距离挑，不是随机）',
    near.slice(0, p.maxBranches ?? 4).every(e => e.currentHP < 1000000)
    && near.slice(p.maxBranches ?? 4).every(e => e.currentHP === 1000000));
  const dmgs = hit.map(e => 1000000 - e.currentHP);
  T('分支③-命中的多个目标各自扣血量大致相等（独立光束各打各的，不是均摊）',
    Math.max(...dmgs) - Math.min(...dmgs) < Math.max(...dmgs) * 0.05);

  // 命中目标越多，单条分支伤害应该越低（"轻微递减"，防止无限乘算失控）。
  const { ents: ents2, ctx: ctx2 } = W();
  const tower2 = mk(ents2, 'tower', 0, 'blue');
  tower2.baseStats.attackRange = 1000;
  tower2.baseStats.attackDamage = 100;
  const inst2 = equipSkill(tower2, 'weapon_prism', ctx2);
  const soloFoe = mk(ents2, 'melee', 100, 'red', 1000000);
  for (let i = 0; i < 300; i++) SkillLibrary.weapon_prism.onFrame(tower2.id, 1 / 30, inst2, ctx2);
  const soloDmgPerHit = (1000000 - soloFoe.currentHP);
  // 只有1个目标时命中次数与4目标场景基本一致（同样的攻速节奏），可以直接比总扣血。
  T('分支④-只有1个目标时，该目标扣的血比4目标场景里单个目标扣的血更多（递减确实生效）',
    soloDmgPerHit > (dmgs[0] || 0));
}

// ==================== 二十一b：光棱塔"不攻击"bug（v51.31）====================
// 真根因：ProjectileSystem.fireBeam 原来按 attackerId（塔没传就退化成坐标）当
// Map key，一个攻击者只留一条常驻光束；光棱塔同一时刻要开最多4条，不给各自独立
// 的 key 就会在同一帧内互相覆盖，Map 里最后只剩1条——伤害其实一直是对的（上面
// 二十一已经验过），玩家看到的只是画面上顶多闪一下，误以为"没在攻击"。
{
  const { ents, ctx } = W();
  const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
  ctx.combat.projectiles = new ProjectileSystem(ents, ctx.eventBus, ctx.combat);
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackRange = 1000;
  tower.baseStats.attackDamage = 100;
  const inst = equipSkill(tower, 'weapon_prism', ctx);
  const p = SkillLibrary.weapon_prism.defaultParams;
  for (let i = 0; i < 4; i++) mk(ents, 'melee', 100 + i * 30, 'red', 1000000);

  for (let i = 0; i < 300; i++) SkillLibrary.weapon_prism.onFrame(tower.id, 1 / 30, inst, ctx);

  const beams = ctx.combat.projectiles.getBeams();
  T(`光束①-同一时刻命中的每条分支都留下一条独立可见的光束（应有${p.maxBranches ?? 4}条，不是被互相覆盖只剩1条）`,
    beams.length === (p.maxBranches ?? 4));
  T('光束②-各条光束的终点各不相同（真的是4条打4个不同目标，不是同一条反复刷新）',
    new Set(beams.map(b => `${b.endX},${b.endY}`)).size === beams.length);
}

// ==================== 二十二、光棱塔与雷魂的区分（不是同一个东西换皮） ====================
{
  const wSrc = srcOf('src/core/skills/weapons.js');
  T('区分①-光棱塔走performAttackDirect对多个独立目标逐个结算，不调用connectChain（雷魂那种依次弹射）', (() => {
    const i = wSrc.indexOf('weapon_prism:');
    const j = wSrc.indexOf('\n  },\n\n', i);
    const body = wSrc.slice(i, j > i ? j : i + 4000);
    return !/connectChain/.test(body) && /performAttackDirect/.test(body);
  })());
  T('区分②-光棱塔伤害类型走自适应判定（resolveAttackType），不是雷魂的固定真实伤害',
    /weapon_prism:[\s\S]{0,3000}?resolveAttackType/.test(wSrc));
}

done();
