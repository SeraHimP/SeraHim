/**
 * sim_towerweapons.mjs —— Q5 新塔武器验收（狂潮塔/连珠炮 weapon_barrage、聚能塔/聚能炮 weapon_nova）
 *
 * 用户对狂潮塔的定稿："B，但是每层更少，层数更多。和风魂区别开来"——即每层攻速
 * 加成比风魂小、上限层数比风魂多，且叠层不按时间衰减（风魂是持续时间衰减），
 * 只在脱战/换目标时清零。聚能塔是"低频、单次巨额AOE"，蓄力被打断（掉目标）
 * 立即清零，跟"每次都有延迟"的坠星塔不是一回事。
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

const { T, done } = scoreboard('新塔武器（狂潮塔/聚能塔/牧灵塔）验收');

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
  T('命中①-onBeforeAttack 返回 preDamageMult=55%（出厂值）',
    Math.abs(r.preDamageMult - (p.preDamageMultPct / 100)) < 1e-9);
  T('命中②-onBeforeAttack 返回 attackShare=33%（"33%命中效率"）',
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

// ==================== 三、连珠炮：按秒叠层，不按时间衰减，命中同一目标才涨层 ====================
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

  // 长时间不动（模拟"不按时间衰减"）：多跑几秒不清零，只要还在同一目标身上就继续涨
  for (let i = 0; i < 50; i++) SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  eff = fx.getEffectByName(tower.id, '连珠');
  T(`叠层②-层数封顶在 maxStacks=${p.maxStacks}，不会无限涨`, eff && eff.stacks === p.maxStacks);
  T('叠层③-封顶后层数不随时间自然衰减（effect 是 permanent，不吃 remainingTime 递减）',
    eff && eff.blueprint.permanent === true);

  // 换目标：应该清零重新开始
  const target2 = mk(ents, 'melee', 60, 'red');
  tower.targetId = target2.id;
  SkillLibrary.weapon_barrage.onFrame(tower.id, 0.5, inst, ctx); // 还没到1秒，观察是否先清零重计时
  eff = fx.getEffectByName(tower.id, '连珠');
  T('叠层④-换目标后层数清零重新开始（不是继续累加在新目标身上）',
    !eff || eff.stacks < p.maxStacks);

  // 脱离战斗：应该清零
  tower._inCombat = false;
  SkillLibrary.weapon_barrage.onFrame(tower.id, 1.0, inst, ctx);
  eff = fx.getEffectByName(tower.id, '连珠');
  T('叠层⑤-脱战后层数清零', !eff);
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

// ==================== 六、聚能炮（weapon_nova）：specialAttack，onBeforeAttack 跳过普通弹道 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  const r = SkillLibrary.weapon_nova.onBeforeAttack(tower, target, inst, ctx);
  T('特殊①-onBeforeAttack 返回 skipProjectile（命中完全由自己的蓄力循环结算）',
    r.skipProjectile === true);
  T('特殊②-声明为 specialAttack（跟闪电杖同一类）', SkillLibrary.weapon_nova.specialAttack === true);
}

// ==================== 七、聚能炮：蓄力——掉目标立即清零 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red');
  tower.targetId = target.id;
  SkillLibrary.weapon_nova.onFrame(tower.id, 3.0, inst, ctx);
  T('蓄力①-蓄了一段时间后 charge>0', inst.state.charge > 0);

  tower.targetId = null; // 掉目标
  SkillLibrary.weapon_nova.onFrame(tower.id, 0.1, inst, ctx);
  T('蓄力②-掉目标后立即清零（"蓄力被打断就得重新蓄"）', inst.state.charge === 0);
}

// ==================== 八、聚能炮：蓄满后单次巨额AOE命中 ====================
{
  const { ents, fx, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.attackDamage = 1000;
  tower.baseStats.attackType = 'physical';
  const inst = equipSkill(tower, 'weapon_nova', ctx);
  const target = mk(ents, 'melee', 50, 'red', 10_000_000);
  target.baseStats.armor = 0;
  const bystander = mk(ents, 'melee', 55, 'red', 10_000_000); // 站在爆点附近，应该吃到溅射
  bystander.baseStats.armor = 0;
  const farAway = mk(ents, 'melee', 5000, 'red', 10_000_000); // 远处不该被打到
  farAway.baseStats.armor = 0;
  tower.targetId = target.id;

  const hpBefore = target.currentHP, hpBystanderBefore = bystander.currentHP, hpFarBefore = farAway.currentHP;
  // 一步一步推进，命中"刚打出去那一帧"就停——不多跑，免得停下来之前已经又开始蓄下一发。
  const step = 0.25;
  let fired = false;
  for (let i = 0; i < 2000 && !fired; i++) {
    const before = inst.state.charge;
    SkillLibrary.weapon_nova.onFrame(tower.id, step, inst, ctx);
    if (before > 0 && inst.state.charge === 0) fired = true;
  }
  T('蓄满-确实触发了一次打出去（否则下面全部断言都没意义）', fired);

  T('命中①-主目标吃到了伤害（蓄满打出去了）', target.currentHP < hpBefore);
  T('命中②-附近的旁观者也吃到了溅射伤害（范围AOE）', bystander.currentHP < hpBystanderBefore);
  T('命中③-远处的单位没被波及（不是全图AOE）', farAway.currentHP === hpFarBefore);
  T('命中④-主目标伤害明显高于溅射到旁观者的伤害（中心命中不打折，旁边才衰减）',
    (hpBefore - target.currentHP) > (hpBystanderBefore - bystander.currentHP));
  T('命中⑤-打完一发后 charge 归零重新蓄力', inst.state.charge === 0);
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

// ==================== 十一、牧灵法阵：召唤幻兽 + 属性按塔的百分比缩放 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower.baseStats.maxHP = 2000; tower.baseStats.attackDamage = 100;
  tower.baseStats.armor = 40; tower.baseStats.magicResist = 40;
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;

  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('召唤①-onFrame 跑一次后确实生成了幻兽', !!inst.state.petId);
  const pet = ctx.entityContainer.get(inst.state.petId);
  T('召唤②-幻兽是 type:melee（复用现有小兵管线）', pet && pet.type === 'melee');
  T('召唤③-幻兽出生在塔的位置', pet && pet.pos.x === tower.pos.x);
  const pct = (p.statPct ?? 50) / 100;
  T('召唤④-幻兽生命值≈塔生命值的statPct%',
    Math.abs(pet.baseStats.maxHP - tower.baseStats.maxHP * pct) < 1e-6);
  T('召唤⑤-幻兽攻击力≈塔攻击力的statPct%',
    Math.abs(pet.baseStats.attackDamage - tower.baseStats.attackDamage * pct) < 1e-6);
  T('召唤⑥-幻兽记录了主人塔的id（拴绳依据）', pet && pet._petOwnerId === tower.id);
  T('召唤⑦-幻兽有拴绳半径', pet && pet._petLeashRadius === (p.leashRadius ?? 260));
  T('召唤⑧-幻兽打了_isSummoned标记（不记熵，同幻灵口径）', pet && pet._isSummoned === true);

  // 已经有活着的幻兽时不会再召唤第二只
  const before = inst.state.petId;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('召唤⑨-幻兽还活着时不会重复召唤', inst.state.petId === before);
}

// ==================== 十二、牧灵法阵：持续治疗幻兽 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petId);
  pet.currentHP = pet.baseStats.maxHP * 0.5;
  const before = pet.currentHP;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 1.0, inst, ctx);
  T('治疗①-幻兽掉血后被塔治疗', pet.currentHP > before);
  T('治疗②-治疗速率≈healPerSec',
    Math.abs((pet.currentHP - before) - (p.healPerSec ?? 40)) < 1e-6);

  pet.currentHP = pet.baseStats.maxHP;
  const beforeFull = pet.currentHP;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 1.0, inst, ctx);
  T('治疗③-满血时不会超出maxHP（治疗管线本身的封顶，不是这里特殊处理）',
    pet.currentHP === beforeFull);
}

// ==================== 十三、牧灵法阵：死亡后延迟复活，且每死一次冷却更长 ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  const p = SkillLibrary.weapon_shepherd.defaultParams;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet1 = ctx.entityContainer.get(inst.state.petId);
  pet1.currentHP = 0; pet1.alive = false; // 幻兽死亡

  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('复活①-幻兽死后没有立即复活', !inst.state.petId);
  const initial = p.initialRespawnSec ?? 8;
  T('复活②-第一次死亡的复活等待时间≈initialRespawnSec',
    Math.abs(inst.state.respawnAt - (window.gameTime || 0) - initial) < 1e-6);

  window.gameTime = (window.gameTime || 0) + initial + 0.1;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  T('复活③-等待时间到了之后重新召唤出幻兽', !!inst.state.petId);

  const pet2 = ctx.entityContainer.get(inst.state.petId);
  pet2.currentHP = 0; pet2.alive = false; // 第二次死亡
  const gameTimeAtDeath2 = window.gameTime || 0;
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const step = p.respawnStepSec ?? 4;
  T('复活④-第二次死亡的复活等待时间比第一次更长（initial + step）',
    Math.abs(inst.state.respawnAt - gameTimeAtDeath2 - (initial + step)) < 1e-6);
  window.gameTime = 0; // 复位，避免影响后面的用例
}

// ==================== 十四、牧灵法阵：卸下武器时幻兽立即消失（非战斗死亡） ====================
{
  const { ents, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petId);
  T('卸下①-装备后确实有一只活着的幻兽', pet && pet.alive);
  SkillLibrary.weapon_shepherd.onUnequip(tower.id, inst, ctx);
  T('卸下②-卸下武器后幻兽立即死亡', !pet.alive);
}

// ==================== 十五、牧灵法阵：塔死亡后幻兽清理（CombatSystem.update） ====================
{
  const { ents, combat, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  const inst = equipSkill(tower, 'weapon_shepherd', ctx);
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petId);
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
  SkillLibrary.weapon_shepherd.onFrame(tower.id, 0.1, inst, ctx);
  const pet = ctx.entityContainer.get(inst.state.petId);
  pet.pos.x = tower.pos.x; pet.pos.y = tower.pos.y;
  const leash = pet._petLeashRadius;

  // 拴绳范围内的敌人：应该会追过去
  const nearFoe = mk(ents, 'melee', leash * 0.5, 'red');
  const before1 = { x: pet.pos.x, y: pet.pos.y };
  lms._updatePet(pet, 1.0);
  T('接敌①-拴绳范围内的敌人会被追击（幻兽移动了）',
    pet.pos.x !== before1.x || pet.pos.y !== before1.y);

  // 拴绳范围外的敌人：不该被追
  ents.remove ? ents.remove(nearFoe.id) : (nearFoe.alive = false);
  pet.pos.x = tower.pos.x; pet.pos.y = tower.pos.y; pet.targetId = null;
  const farFoe = mk(ents, 'melee', leash * 3, 'red');
  const before2 = { x: pet.pos.x, y: pet.pos.y };
  lms._updatePet(pet, 1.0);
  T('接敌②-拴绳范围外的敌人不会被追击（幻兽原地不动）',
    pet.pos.x === before2.x && pet.pos.y === before2.y);

  // 无目标时离主人太远要往回收
  farFoe.alive = false;
  pet.pos.x = tower.pos.x + 500; pet.pos.y = tower.pos.y; pet.targetId = null;
  const before3 = pet.pos.x;
  lms._updatePet(pet, 1.0);
  T('归位①-无目标且离主人较远时会往主人方向收拢', pet.pos.x < before3);
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

done();
