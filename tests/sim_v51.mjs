/**
 * sim_v51.mjs —— v51 验收（资源条+主动技能 / 法术强度+技能增幅 / 适应之力 / 暴击 /
 *                 统一吸血 / 闪避+韧性+沉默+缴械 / 远古龙魂大型小兵漏发 bug 修复）
 *                 + v51.1 追补（资源条 UI 细化 / 升温状态清零 / 4 条主动技能改按用户
 *                 精确规格重写 / 屠龙者并入龙魂本体倒计时 / 批量技能池排除攻击方式 /
 *                 模板编辑器分区与自适应伤害类型显示）
 *
 * 每条断言钉"行为形状"，不钉具体数字（见 docs/DEVELOPMENT.md §8.2）。
 * 本轮不考虑平衡（用户原话："目前不需要考虑任何平衡方面的问题"），所以数值本身
 * 不是验收对象，"这条规则生不生效/生效的方向对不对"才是。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';
import { RELATED_STATS } from '../src/ui/statPanelLayout.js';
import { fieldLabel } from '../src/ui/editor/fields.js';
import { statDoc } from '../src/data/statDocs.js';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('v51验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

// ==================== 一、技能增幅（自动生效） ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const atk = mkEntity(ents, 'tower', { stats: { skillAmpPct: 50, attackDamage: 100 } }, CONFIG);
  const tgt1 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  const tgt2 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  // 技能路径（performAttackDirect，默认不传 basicAttack）：应该吃到 50% 技能增幅
  const before1 = tgt1.currentHP;
  combat.performAttackDirect(atk.id, tgt1.id, 100, 'magic');
  const skillDmg = before1 - tgt1.currentHP;
  T('增①-技能伤害吃到技能增幅（100 → 明显多于 100）', skillDmg > 140 && skillDmg < 160);

  // 普攻路径（performAttack/_resolveHit）：不该吃技能增幅
  const before2 = tgt2.currentHP;
  combat.performAttack(atk, tgt2);
  const basicDmg = before2 - tgt2.currentHP;
  T('增②-普攻伤害不吃技能增幅（约等于原始攻击力 100）', basicDmg > 95 && basicDmg < 105);

  T('增③-basicAttack 标记确实是唯一的例外开关（源码可见）',
    /options\.basicAttack/.test(srcOf('src/systems/CombatSystem.js')));
}

// ==================== 二、DOT 不会被技能增幅重复放大 ====================
// 用户没有明确提这条，但这是"技能增幅自动生效"这个设计的直接推论：
// EffectRegistry.apply() 在效果创建那一刻已经按 casterId 缩放过一次数值了，
// BuffSystem 逐帧兑现伤害时如果 performAttackDirect 又缩放一次，就是双倍放大。
{
  const { ents, fx, combat, attr, SkillLibrary } = await world();
  const { BuffSystem } = await import('../src/systems/BuffSystem.js');
  const buffSys = new BuffSystem(fx, ents, { emit() {} }, combat);
  const { CONFIG } = await import('../src/data/Config.js');
  const caster = mkEntity(ents, 'tower', { stats: { skillAmpPct: 100 } }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  fx.apply(tgt.id, {
    name: '测试DOT', kind: 'dot', damageType: 'true', flatValue: 10,
    tickInterval: 1, duration: 5,
  }, 'test_dot', { casterId: caster.id });
  const eff = fx.getEffects(tgt.id)[0];
  // 100% 技能增幅应该只在 apply() 那一刻生效一次：10 → 20，不是 10 → 40
  T('DOT①-效果创建时吃到一次技能增幅（10 → 20）', Math.abs(eff.totalFlat - 20) < 1e-6);

  const before = tgt.currentHP;
  buffSys.update(1.0); // 走满一个 tick
  const dealt = before - tgt.currentHP;
  T('DOT②-逐帧兑现伤害没有被二次放大（约等于 20，不是 40）', dealt > 15 && dealt < 25);
}

// ==================== 三、暴击 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  // critChance=0 时 Math.random()*100 < 0 恒假——这条边界是确定性的，不会偶发失败
  const noCrit = mkEntity(ents, 'tower', { stats: { attackDamage: 100, critChance: 0 } }, CONFIG);
  const alwaysCrit = mkEntity(ents, 'tower', { stats: { attackDamage: 100, critChance: 100, critDamagePct: 0 } }, CONFIG);
  const tgtA = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  const tgtB = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  const b1 = tgtA.currentHP; combat.performAttack(noCrit, tgtA);
  T('暴①-暴击率0恒不暴击', Math.abs((b1 - tgtA.currentHP) - 100) < 1);

  const b2 = tgtB.currentHP; combat.performAttack(alwaysCrit, tgtB);
  T('暴②-暴击率100%必定暴击，按基础暴击倍率200%结算', Math.abs((b2 - tgtB.currentHP) - 200) < 1);

  // 技能默认不能暴击；持有【技能暴击】状态后才能，且倍率更低
  const skillAtk = mkEntity(ents, 'tower', { stats: { critChance: 100, critDamagePct: 0 } }, CONFIG);
  const tgtC = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  const tgtD = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  // 不传 basicAttack：默认就是"技能路径"，同一个开关同时管着技能增幅与技能暴击
  // （skillAtk 没设 skillAmpPct，默认0，不干扰这里的暴击倍率断言）。
  const b3 = tgtC.currentHP;
  combat.performAttackDirect(skillAtk.id, tgtC.id, 100, 'magic');
  T('暴③-没有【技能暴击】状态，技能默认不暴击', Math.abs((b3 - tgtC.currentHP) - 100) < 1);

  fx.apply(skillAtk.id, { name: '技能暴击', kind: 'skillCrit', duration: Infinity, permanent: true }, 'test_skillcrit');
  const b4 = tgtD.currentHP;
  combat.performAttackDirect(skillAtk.id, tgtD.id, 100, 'magic');
  const skillCritDmg = b4 - tgtD.currentHP;
  T('暴④-持有【技能暴击】后技能能暴击', skillCritDmg > 100);
  T('暴⑤-技能暴击倍率比普攻基础暴击倍率(200%)更低',
    skillCritDmg < 200 && (CONFIG.tuning.crit.skillCritDamagePct < CONFIG.tuning.crit.baseCritDamagePct));
}

// ==================== 四、适应之力 / 自适应伤害类型 ====================
{
  const { attr } = await world();
  T('适①-AP明显更高 → 转武器伤害类型解析为魔法', attr.resolveAttackType(
    { attackType: 'adaptive', abilityPower: 100, attackDamage: 10, adaptiveDefault: 'physical' }) === 'magic');
  T('适②-AD明显更高 → 解析为物理', attr.resolveAttackType(
    { attackType: 'adaptive', abilityPower: 10, attackDamage: 100, adaptiveDefault: 'physical' }) === 'physical');
  T('适③-打平时按 adaptiveDefault', attr.resolveAttackType(
    { attackType: 'adaptive', abilityPower: 50, attackDamage: 50, adaptiveDefault: 'ap' }) === 'magic');
  T('适④-非 adaptive 类型原样返回', attr.resolveAttackType({ attackType: 'physical' }) === 'physical');

  const { ents, CONFIG } = await world();
  const e1 = mkEntity(ents, 'tower', { stats: { adaptiveForce: 100, abilityPower: 0, attackDamage: 0, adaptiveDefault: 'physical' } }, CONFIG);
  const s1 = attr.calc(e1, []);
  T('适⑤-适应之力打平按物理方向：100 点 → +60 攻击力（0.6 换算比例）',
    Math.abs(s1.attackDamage - 60) < 1e-6 && Math.abs(s1.abilityPower - 0) < 1e-6);

  const e2 = mkEntity(ents, 'tower', { stats: { adaptiveForce: 100, abilityPower: 0, attackDamage: 0, adaptiveDefault: 'ap' } }, CONFIG);
  const s2 = attr.calc(e2, []);
  T('适⑥-适应之力打平按法术方向：100 点 → +100 法强（1:1）',
    Math.abs(s2.abilityPower - 100) < 1e-6 && Math.abs(s2.attackDamage - 0) < 1e-6);
}

// ==================== 五、塔的默认伤害类型改回物理 ====================
// v51.6：用户又一次改稿——"处了特殊说明外，所有单位的攻击方式都应该是自适应，
// 塔默认造成魔法伤害（特殊说明）"，把这里钉的 physical 再次翻成 magic。
// 完整时间线记在 Config.js 里 tower 模板 attackType 那段头注，这里不重复。
{
  const { CONFIG } = await world();
  T('塔①-默认伤害类型 = magic（v51.6 用户定稿"塔默认造成魔法伤害"，第三次翻转）', CONFIG.templates.tower.attackType === 'magic');
}

// ==================== 六、统一吸血（物理/法术/全能 + 群体折扣） ====================
{
  const { ents, combat, CONFIG } = await world();
  const mkDamaged = () => mkEntity(ents, 'tower', {
    stats: { maxHP: 10000, healthRegen: 0, shieldFixedMax: 0 },
  }, CONFIG);
  const tgt = () => mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  // 全能吸血：任何类型伤害（含真实）都吃
  {
    const atk = mkDamaged(); atk.currentHP = 5000; atk.baseStats.lifeStealPct = 40;
    const before = atk.currentHP + (atk.tempShield || 0);
    combat.performAttackDirect(atk.id, tgt().id, 100, 'true', { basicAttack: true });
    const gained = (atk.currentHP + (atk.tempShield || 0)) - before;
    T('吸①-全能吸血对真实伤害也生效', gained > 0);
  }
  // 物理吸血只认物理
  {
    const atk = mkDamaged(); atk.currentHP = 5000; atk.baseStats.physicalVampPct = 50;
    const before = atk.currentHP + (atk.tempShield || 0);
    combat.performAttackDirect(atk.id, tgt().id, 100, 'magic', { basicAttack: true });
    const gained = (atk.currentHP + (atk.tempShield || 0)) - before;
    T('吸②-物理吸血对魔法伤害不生效', gained === 0);
  }
  {
    const atk = mkDamaged(); atk.currentHP = 5000; atk.baseStats.physicalVampPct = 50;
    const before = atk.currentHP + (atk.tempShield || 0);
    combat.performAttackDirect(atk.id, tgt().id, 100, 'physical', { basicAttack: true });
    const gained = (atk.currentHP + (atk.tempShield || 0)) - before;
    T('吸③-物理吸血对物理伤害生效', gained > 0);
  }
  // 群体命中打 20% 折扣
  {
    const atk1 = mkDamaged(); atk1.currentHP = 5000; atk1.baseStats.lifeStealPct = 50;
    const b1 = atk1.currentHP + (atk1.tempShield || 0);
    combat.performAttackDirect(atk1.id, tgt().id, 100, 'physical', { basicAttack: true });
    const mainGain = (atk1.currentHP + (atk1.tempShield || 0)) - b1;

    const atk2 = mkDamaged(); atk2.currentHP = 5000; atk2.baseStats.lifeStealPct = 50;
    const b2 = atk2.currentHP + (atk2.tempShield || 0);
    combat.performAttackDirect(atk2.id, tgt().id, 100, 'physical', { basicAttack: true, vampGroup: true });
    const groupGain = (atk2.currentHP + (atk2.tempShield || 0)) - b2;

    T('吸④-群体命中的吸血明显低于主目标（约 20% 效率）',
      groupGain > 0 && groupGain < mainGain * 0.3 && groupGain > mainGain * 0.1);
  }
  T('吸⑤-lifeStealToHealth/lifeStealToShield 真的接进了吸血结算（不再是死配置）',
    /lifeStealToHealth/.test(srcOf('src/systems/CombatSystem.js'))
    && /lifeStealToShield/.test(srcOf('src/systems/CombatSystem.js')));
}

// ==================== 七、闪避 / 韧性 / 沉默 / 缴械 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  // 闪避：100% 时确定性地完全躲开普攻
  const atk = mkEntity(ents, 'tower', { stats: { attackDamage: 100 } }, CONFIG);
  const dodgeTgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 10000, evasionPct: 100 } }, CONFIG);
  const before = dodgeTgt.currentHP;
  combat.performAttack(atk, dodgeTgt);
  T('躲①-闪避率100%完全躲开普攻（伤害为0）', dodgeTgt.currentHP === before);

  // 韧性：缩短减速/控制类效果的持续时间
  const tenTgt = mkEntity(ents, 'tower', { stats: { tenacityPct: 50 } }, CONFIG);
  const noTenTgt = mkEntity(ents, 'tower', { stats: { tenacityPct: 0 } }, CONFIG);
  fx.apply(tenTgt.id, { name: '减速测试', kind: 'stat', statKey: 'moveSpeed', percentValue: -50, duration: 10 }, 'test_slow');
  fx.apply(noTenTgt.id, { name: '减速测试', kind: 'stat', statKey: 'moveSpeed', percentValue: -50, duration: 10 }, 'test_slow');
  const tRemain = fx.getEffects(tenTgt.id)[0].remainingTime;
  const nRemain = fx.getEffects(noTenTgt.id)[0].remainingTime;
  T('韧①-50%韧性把10秒减速缩短到约5秒', Math.abs(tRemain - 5) < 1e-6);
  T('韧②-0韧性不受影响，仍是10秒', Math.abs(nRemain - 10) < 1e-6);

  // 缴械：装备权且射程内有目标，但缴械后不应发起普攻
  const ramTower = mkEntity(ents, 'tower', {
    stats: { attackRange: 500, attackDamage: 50, armor: 0, magicResist: 0, baseAttackSpeed: 1 },
    skills: ['weapon_piercing'],
  }, CONFIG);
  const disarmTgt = mkEntity(ents, 'tower', { pos: { x: 10, y: 0 }, stats: { armor: 0, magicResist: 0, maxHP: 10000 } }, CONFIG);
  fx.apply(ramTower.id, { name: '缴械测试', kind: 'disarm', duration: 10 }, 'test_disarm');
  const beforeHP = disarmTgt.currentHP;
  combat.update(0.1);
  T('缴①-缴械期间不会发起普攻（目标血量不变）', disarmTgt.currentHP === beforeHP);

  T('缴②-isDisarmed 判据接在攻击决策点上（源码可见）',
    /isDisarmed/.test(srcOf('src/systems/CombatSystem.js')));
}

// ==================== 八、法力系统："没装主动技能的单位法力恒为0" ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const bus = { listeners: [], on(e, cb) { this.listeners.push(cb); }, emit() {} };
  const mana = new ManaSystem(ents, fx, bus, SkillLibrary, AttributeCalculator, combat);

  // 没有主动技能，但模板/覆写里塞了 maxMana/manaRegen——应当恒为0
  const passive = mkEntity(ents, 'tower', { stats: { maxMana: 500, manaRegen: 999, manaStart: 500 } }, CONFIG);
  for (let i = 0; i < 5; i++) mana.update(1);
  T('法①-没装主动技能的单位法力恒为0（哪怕模板给了maxMana/manaRegen）', (passive._mana || 0) === 0);

  // 装了主动技能：法力应当按 manaRegen 累积到满。用 active_corrupt_poison（需要
  // 半径内有敌人才能真正施放）而不是自增益的 active_siege_haste——后者不挑目标，
  // 测不出"没有目标就不清零"这条规则。
  const active = mkEntity(ents, 'corrupt', {
    pos: { x: 5000, y: 5000 }, // 远离一切敌人，确保满了也施放不出去（找不到目标）
    stats: { maxMana: 10, manaRegen: 5, manaStart: 0 },
    skills: ['active_corrupt_poison'],
  }, CONFIG);
  mana.update(1);
  T('法②-装了主动技能的单位会按 manaRegen 攒法力', (active._mana || 0) > 0);
  for (let i = 0; i < 10; i++) mana.update(1);
  T('法③-法力封顶在 maxMana（找不到目标时满了也不会溢出/清零）',
    Math.abs((active._mana || 0) - 10) < 1e-6);

  // 附近有目标时，满法力应当触发施放并回落到 manaFloor（默认0）
  const foe = mkEntity(ents, 'melee', { pos: { x: 5030, y: 5000 }, stats: { maxHP: 100000, armor: 0, magicResist: 0 } }, CONFIG);
  foe._mapFaction = 'red'; foe.faction = 'red';
  active._mapFaction = 'blue'; active.faction = 'blue';
  mana.update(0.01); // 现在半径内有目标了，这一次 tick 应该真正触发施放
  T('法④-满法力+有目标 → 施放主动技能并施加了中毒效果', fx.getEffects(foe.id).some(e => e.blueprint.name === '环刃毒雾'));
  T('法⑤-施放后法力回落（默认清到0）', (active._mana || 0) < 10);

  // 沉默：法力照常攒满待命，但不会尝试施放
  const silenced = mkEntity(ents, 'corrupt', {
    pos: { x: 9000, y: 9000 },
    stats: { maxMana: 10, manaRegen: 999, manaStart: 0 },
    skills: ['active_corrupt_poison'],
  }, CONFIG);
  fx.apply(silenced.id, { name: '沉默测试', kind: 'silence', duration: 10 }, 'test_silence');
  const foe2 = mkEntity(ents, 'melee', { pos: { x: 9010, y: 9000 }, stats: { maxHP: 100000, armor: 0, magicResist: 0 } }, CONFIG);
  foe2._mapFaction = 'red'; foe2.faction = 'red';
  silenced._mapFaction = 'blue'; silenced.faction = 'blue';
  mana.update(1);
  T('法⑥-沉默期间法力照常攒满但不尝试施放',
    silenced._mana >= 10 && !fx.getEffects(foe2.id).some(e => e.blueprint.name === '环刃毒雾'));
}

// ==================== 九、Q1 bug 修复：远古龙魂对大型小兵漏发 ====================
// 用户："远古龙魂对大型小兵目前不生效，只对塔生效。"
// 排查结论（见 DragonSystem._grantAncient 的头注）：不是装备时按类型过滤——是
// 240 秒窗口期内新入场的单位没人告诉 equipExistingSoul "现在正顶着一份远古之力"。
// 大型小兵churn 快，几十秒就死绝重生，很快就只剩塔还留着，看起来像"只对塔生效"。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  fx.setStatSource(ents, AttributeCalculator);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);

  // 广播那一刻：给"当时在场"的一座塔与一个大型小兵都发一份（既有行为，验证没被我改坏）。
  const towerAtGrant = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 9000, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue' };
  ents.add(towerAtGrant);
  const siegeAtGrant = { id: ++window._uid, type: 'siege', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.siege }, currentHP: 900, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue' };
  ents.add(siegeAtGrant);
  ds._grantAncient('blue');
  const hasAncient = (e) => (e._skillInstances || []).some(i => i.skillId === 'dragonsoul_ancient');
  T('远①-广播那一刻在场的塔拿到远古之力', hasAncient(towerAtGrant));
  T('远②-广播那一刻在场的大型小兵也拿到远古之力（这条本来就没坏）', hasAncient(siegeAtGrant));

  // 关键场景：窗口期内**之后**才出生的大型小兵（模拟兵线churn，塔不会中途重新出生）。
  const newSiege = { id: ++window._uid, type: 'siege', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.siege }, currentHP: 900, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue' };
  ents.add(newSiege);
  ds.equipExistingSoul(newSiege);
  T('远③-修复：窗口期内新入场的大型小兵也能补到远古之力（这是本次修的 bug）', hasAncient(newSiege));

  // 窗口过期之后，新入场的单位不应该再补到。
  window.gameTime = 10000; // 远超 durationSec（默认240）
  const lateSiege = { id: ++window._uid, type: 'siege', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.siege }, currentHP: 900, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue' };
  ents.add(lateSiege);
  ds.equipExistingSoul(lateSiege);
  T('远④-窗口过期后新入场的单位不会补到（不是变成永久了）', !hasAncient(lateSiege));
  window.gameTime = 0;
}

// ==================== 十、面板常驻属性区重排 ====================
{
  const { BASE_ATTR_ROWS } = await import('../src/ui/statPanelLayout.js');
  const keys = BASE_ATTR_ROWS.map(r => r.key);
  T('板①-常驻属性区按用户定稿顺序：攻击力·法强·护甲·魔抗·攻速·暴击率',
    JSON.stringify(keys) === JSON.stringify(
      ['attackDamage', 'abilityPower', 'armor', 'magicResist', 'bonusAttackSpeedPct', 'critChance']));
  T('板②-塔卡片与兵卡片共用同一份渲染（不再各写一遍模板字符串）',
    /_baseAttrsHtml/.test(srcOf('src/ui/UIManager.js')));
}

// ==================== 十一、主动技能类别 + 技能库前缀规范化 ====================
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('active_siege_haste');
  T('主①-主动技能确实注册进了技能库', !!def && def.category === 'active');
  T('主②-主动技能的文案前缀是"主动技能——"而不是"唯一被动——"',
    /^主动技能——/.test(def.description));
  const passiveDef = SkillLibrary.get('dragonsoul_fire');
  T('主③-被动技能前缀不受影响，仍是"唯一被动——"', /^唯一被动——/.test(passiveDef.description));
}

// ==================== 十二、v51.1：资源条 UI（格式/颜色/升温清零）====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const { resourceInfoOf, RESOURCE_COLORS } = await import('../src/core/resourceBar.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const ctx = { skillLibrary: SkillLibrary, attrCalc: (await world()).attr, effects: fx };
  // 换一份真正共享的 attrCalc（上面临时开的 world() 只是为了拿类型引用，不要用它的 ents）
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  ctx.attrCalc = AttributeCalculator;

  // 法力：XX/XX 格式 + 右侧回复速度
  const mageLike = mkEntity(ents, 'corrupt', { stats: { maxMana: 50, manaRegen: 3 }, skills: ['active_corrupt_poison'] }, CONFIG);
  mageLike._mana = 20;
  const info1 = resourceInfoOf(mageLike, ctx);
  T('资①-法力显示 XX/XX（当前/上限），不是只写一个词', info1 && info1.label === '20/50');
  // v51.2：右侧回复数格式改成用户定稿的 💧X（原来的 "+X/s" 已作废）。
  T('资②-法力条右侧带每秒回复数（💧X 格式）', info1 && info1.regenText === '💧3');
  // v51.2：用户纠正——不是"四种颜色两两不同"，而是"法力单独一色，其余非法力
  // 资源（升温/闪电充能/通用充能）统一同一种灰白色"，只需要 mana 与非 mana 有区分。
  T('资③-法力的颜色 kind 是 mana，且与非法力类资源颜色不同（非法力三者统一同色）',
    info1 && info1.kind === 'mana'
    && RESOURCE_COLORS.mana !== RESOURCE_COLORS.heat
    && RESOURCE_COLORS.heat === RESOURCE_COLORS.lightning
    && RESOURCE_COLORS.lightning === RESOURCE_COLORS.charge);

  // 升温：装了穿透型子弹的塔，连续命中同一目标应该叠层，且显示 XX/4
  const atk = mkEntity(ents, 'tower', {
    stats: { attackDamage: 100, armor: 0, magicResist: 0, baseAttackSpeed: 1 },
    skills: ['weapon_piercing'],
  }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 1000000 } }, CONFIG);
  combat.performAttack(atk, tgt);
  combat.performAttack(atk, tgt);
  const info2 = resourceInfoOf(atk, ctx);
  // v51.5：第一次命中不再计入资源条显示（用户："第一下攻击不计入"），分母从
  // maxS 变成 maxS-1（4 层封顶 → 显示 X/3）；两次攻击后内部 raw stacks=2，
  // 显示层数 = 2-1 = 1。
  T('资④-升温层数显示 XX/3（第一次命中不计入显示层数）',
    info2 && info2.kind === 'heat' && info2.label === '1/3' && info2.frac > 0);

  // v51.1 bug 修复：升温效果因超时过期后（哪怕还是同一个目标），资源条应该清零，
  // 而不是停在过期前的层数。
  fx.update(10); // 远超"升温"效果的 6 秒时长
  const info3 = resourceInfoOf(atk, ctx);
  T('资⑤-升温效果超时过期后，资源条清零（不再显示旧层数）', !info3 || info3.frac === 0);

  // 同时验证：不只是 UI 清零，实际伤害倍率也真的清零了——用真实伤害验证不是"看起来清了"。
  const tgt2 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 1000000 } }, CONFIG);
  const before = tgt2.currentHP;
  combat.performAttack(atk, tgt2);
  const dealt = before - tgt2.currentHP;
  T('资⑥-升温过期后再次命中同一目标，伤害按基础值算（没有偷偷继承旧层数的倍率）',
    dealt > 90 && dealt < 110);
}

// ==================== 十三、v51.1：蚀骨兵主动技能——按【当前生命】百分比的真实伤害 DOT ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const atk = mkEntity(ents, 'corrupt', { stats: { maxMana: 1, manaRegen: 999 }, skills: ['active_corrupt_poison'] }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { pos: { x: 10, y: 0 }, stats: { armor: 0, magicResist: 0, maxHP: 1000 } }, CONFIG);
  atk._mapFaction = 'blue'; atk.faction = 'blue';
  tgt._mapFaction = 'red'; tgt.faction = 'red';
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const bus = { on() {}, emit() {} };
  const mana = new ManaSystem(ents, fx, bus, SkillLibrary, AttributeCalculator, combat);
  mana.update(1); // 满法力 + 有目标 → 应该施放
  const eff = fx.getEffects(tgt.id).find(e => e.blueprint.name === '环刃毒雾');
  T('毒①-施放后目标身上挂了环刃毒雾', !!eff);
  T('毒②-DOT 走 dotBasis:currentHP（不是固定 flatValue）', eff && eff.blueprint.dotBasis === 'currentHP');

  const { BuffSystem } = await import('../src/systems/BuffSystem.js');
  const buffSys = new BuffSystem(fx, ents, { emit() {} }, combat);
  const hp1 = tgt.currentHP;
  buffSys.update(1); // 走一个 tick（1秒）
  const dealt1 = hp1 - tgt.currentHP;
  T('毒③-第一跳按当前生命1%扣血（1000 血 → 约 10 点）', Math.abs(dealt1 - hp1 * 0.01) < 1);
  const hp2 = tgt.currentHP;
  buffSys.update(1);
  const dealt2 = hp2 - tgt.currentHP;
  T('毒④-第二跳的基数是【已经掉过血的】当前生命，跳伤会自然变小（不是固定值）',
    dealt2 < dealt1 && Math.abs(dealt2 - hp2 * 0.01) < 1);
}

// ==================== 十四、v51.1：术士兵主动技能——延迟消耗 + 法术强度联动 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const bus = { on() {}, emit() {} };
  const mana = new ManaSystem(ents, fx, bus, SkillLibrary, AttributeCalculator, combat);

  const atk = mkEntity(ents, 'warlock', {
    stats: { maxMana: 1, manaRegen: 999, attackDamage: 1, armor: 0, magicResist: 0 },
    skills: ['active_warlock_empower'],
  }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 1000000 } }, CONFIG);

  mana.update(1); // 满法力 → onCast，应该是"武装"状态，不清零法力
  T('蓄①-施放后法力不立即清零（延迟消耗，等真正命中才清）', (atk._mana || 0) >= 1);
  const inst = atk._skillInstances.find(i => i.skillId === 'active_warlock_empower');
  T('蓄②-技能实例被标记为"已武装"', inst && inst.state && inst.state._armed === true);
  T('蓄③-获得了永久叠加的法术强度自增益', fx.getEffects(atk.id).some(e => e.blueprint.name === '蓄能强化'));

  mana.update(1); // 已经武装：这一帧不应该再次触发施放（不会再叠一层"蓄能强化"）
  const apStacksAfterSecondTick = fx.getEffects(atk.id).find(e => e.blueprint.name === '蓄能强化')?.stacks;
  T('蓄④-已武装期间不会重复施放（法术强度不会莫名其妙再涨一层）', apStacksAfterSecondTick === 1);

  const before = tgt.currentHP;
  combat.performAttack(atk, tgt); // 真正打出这一下，应该消耗"蓄势待发"、额外造成真实伤害
  const totalDealt = before - tgt.currentHP;
  T('蓄⑤-命中时额外造成了明显超过基础攻击力的伤害（真实伤害加成生效）', totalDealt > 1);
  T('蓄⑥-命中后法力才真正清零', (atk._mana || 0) < 1);
  const inst2 = atk._skillInstances.find(i => i.skillId === 'active_warlock_empower');
  T('蓄⑦-命中后"已武装"标记被清掉', inst2 && inst2.state && inst2.state._armed === false);
  T('蓄⑧-"蓄势待发"展示状态被移除（不会在命中之后还挂着）',
    !fx.getEffects(atk.id).some(e => e.blueprint.name === '蓄势待发'));
}

// ==================== 十五、v51.1：全局法力回复（不再是每单位各存一份） ====================
{
  const { CONFIG } = await world();
  T('全①-CONFIG.tuning.mana 是全局唯一来源', CONFIG.tuning?.mana
    && typeof CONFIG.tuning.mana.onAttack === 'number' && typeof CONFIG.tuning.mana.onHitTaken === 'number');
  T('全②-用户定稿的默认值：攻击+1、受击+2', CONFIG.tuning.mana.onAttack === 1 && CONFIG.tuning.mana.onHitTaken === 2);
  T('全③-模板不再各自带 manaOnAttack/manaOnHitTaken 字段（已改为全局）',
    CONFIG.templates.siege.manaOnAttack === undefined && CONFIG.templates.totem.manaOnHitTaken === undefined);
}

// ==================== 十六、v51.1：屠龙者并入龙魂本体倒计时（不再另起一个徽标）====================
{
  const src = srcOf('src/systems/DragonSystem.js');
  T('屠①-源码里不再有独立的"屠龙者"效果 apply（并入了龙魂本体的展示效果）',
    !/name: '屠龙者'/.test(src));
  T('屠②-改成直接把龙魂本体展示效果的剩余时间设成限时', /soul_display_\$\{soulId\}/.test(src) && /disp\.remainingTime = sec/.test(src));
}

// ==================== 十七、v51.1：批量加技能池排除"攻击方式" ====================
{
  const src = srcOf('src/ui/editor/pagesGameplaySkillState.js');
  T('批①-批量加技能的技能池过滤掉了 attackmode 分类',
    /category !== 'attackmode'/.test(src));
}

// ==================== 十八、v51.1：attackType 编辑器下拉 + 自适应伤害类型提示 ====================
{
  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('类①-实体编辑器的伤害类型下拉里加了"自适应"选项',
    /\['adaptive','自适应'\]/.test(entitySrc));
  const uiSrc = srcOf('src/ui/UIManager.js');
  T('类②-攻击力详情弹窗对 adaptive 类型现读实时解析结果，不再一律显示物理伤害',
    /rawType === 'adaptive'/.test(uiSrc) && /resolveAttackType/.test(uiSrc));
  T('类③-新增属性按语义分类，不再全部堆进"其他"（法力单独成组）',
    /const manaKeys = \['maxMana', 'manaRegen', 'manaStart', 'manaFloor'\];/.test(entitySrc)
    && /'法力': manaKeys/.test(entitySrc));
}

// ==================== 十九、v51.2：资源条继续修（文字看不见/配色/闪电格式/隐藏重复状态）====================
// 用户反馈三点：① 法力条文字（含右侧回复值圆圈）还是不显示；② 除法力外的资源条不该
// 各配一色，统一灰白；③ 已经有资源条的三种展示效果（升温/闪电充能/充能）不该在
// 状态栏里再出现一遍；顺带闪电杖格式从 XX% 改成 XX/100。
{
  const { ents, fx, CONFIG } = await world();
  const { resourceInfoOf, HIDDEN_STATUS_EFFECT_NAMES } = await import('../src/core/resourceBar.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const ctx = { skillLibrary: SkillLibrary, attrCalc: AttributeCalculator, effects: fx };

  const ltg = mkEntity(ents, 'tower', { skills: ['weapon_lightning'] }, CONFIG);
  ltg._skillInstances[0].state.charge = 0.42;
  const infoL = resourceInfoOf(ltg, ctx);
  T('资⑦-闪电杖充能格式改成 XX/100（不再是 XX%）', infoL && infoL.label === '42/100');

  T('资⑧-三个已有专属资源条的展示效果名单：升温/闪电充能/充能',
    HIDDEN_STATUS_EFFECT_NAMES.has('升温') && HIDDEN_STATUS_EFFECT_NAMES.has('闪电充能')
    && HIDDEN_STATUS_EFFECT_NAMES.has('充能') && HIDDEN_STATUS_EFFECT_NAMES.size === 3);

  const uiSrc = srcOf('src/ui/UIManager.js');
  const effectRowCalls = (uiSrc.match(/this\._updateEffectIcons\(effectsContainer, this\.effects\.getEffects\(id\)\.filter\(e => !HIDDEN_STATUS_EFFECT_NAMES\.has\(e\.blueprint\.name\)\)\)/g) || []);
  T('资⑨-塔卡片与兵卡片两处状态栏渲染都过滤了这三个效果名（不是只改了一处）',
    effectRowCalls.length === 2);

  T('资⑩-技能栏渲染排除 category 为 attackmode 的技能实例（充能攻击不该占一格）',
    /SkillLibrary\[i\.skillId\]\?\.category !== 'attackmode'/.test(uiSrc));

  const html = srcOf('index.html');
  // v51.3：这条规则后来跟 .bar-text 合并成同一个选择器了（见资⑯），这里只钉
  // "不再是几乎看不见的 --text-mute" 这个核心诉求——具体选择器怎么写留给资⑯管。
  T('资⑪-资源条文字不再用几乎看不见的 --text-mute（已经改用亮色+投影）',
    !/\.bar-res-text\s*\{[^}]*--text-mute/.test(html)
    && /text-shadow:\s*0 1px 2px rgba\(0,0,0,0\.85\)/.test(html));
}

// FakeEl 技能栏渲染验证：真正跑一遍 _updateSkillSlots，确认 attackmode 技能实例
// 不会出现在渲染出的 DOM 里（不是只查了源码里写没写这个判断）。
{
  class FakeEl { constructor() { this.dataset = {}; this._html = ''; } set innerHTML(v) { this._html = v; } get innerHTML() { return this._html; } }
  globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => null }), addEventListener() {} };
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
  const { UIManager } = await import('../src/ui/UIManager.js');
  const ui = Object.create(UIManager.prototype);
  const c = new FakeEl();
  ui._updateSkillSlots(c, [
    { id: 101, skillId: 'weapon_piercing' },
    { id: 102, skillId: 'atkmode_charge' },
  ]);
  const h = c.innerHTML;
  T('资⑫-充能攻击（atkmode_charge）实际渲染时被排除，武器技能仍正常显示',
    h.includes('data-skill-id="101"') && !h.includes('data-skill-id="102"')
    && (h.match(/skill-slot has-skill/g) || []).length === 1);
}

// ==================== 二十、v51.3：资源条再修（配色/居中统一/永远显示）+ 大型小兵法术强度随波次成长 ====================
{
  const { ents, fx, CONFIG } = await world();
  const { resourceInfoOf, RESOURCE_COLORS } = await import('../src/core/resourceBar.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const ctx = { skillLibrary: SkillLibrary, attrCalc: AttributeCalculator, effects: fx };

  // 换色：非法力那一档不再是 v51.2 的浅灰（#b7bec8，读不清），且仍然与法力不同色
  T('资⑬-非法力资源换了更深的颜色（不再是读不清的浅灰），且仍与法力不同色',
    RESOURCE_COLORS.heat !== '#b7bec8' && RESOURCE_COLORS.heat !== RESOURCE_COLORS.mana);

  // 通用充能（攻击方式，如攻城车）格式也补齐成 XX/100
  const ramLike = mkEntity(ents, 'ram', { skills: ['atkmode_charge'] }, CONFIG);
  ramLike._charge = 0.73;
  const infoRam = resourceInfoOf(ramLike, ctx);
  T('资⑭-通用充能型攻击方式格式也改成 XX/100（之前漏了这一支，还是 XX%）',
    infoRam && infoRam.label === '73/100');

  // 什么资源系统都没有的单位（近战兵）——不再隐藏整行，退化成空法力条
  const plainMelee = mkEntity(ents, 'melee', {}, CONFIG);
  const infoPlain = resourceInfoOf(plainMelee, ctx);
  T('资⑮-没有任何资源系统的单位也必须显示资源条（退化成 0/0 法力条，不再整行隐藏）',
    infoPlain && infoPlain.kind === 'mana' && infoPlain.label === '0/0' && infoPlain.frac === 0);

  const html = srcOf('index.html');
  T('资⑯-血条读数与资源条读数的 CSS 合并成同一份规则（位置/字号/颜色统一）',
    /\.bar-text,\s*\.bar-res-text\s*\{/.test(html));
}

// 大型小兵法术强度随波次成长
{
  const { CONFIG } = await import('../src/data/Config.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { createFactories } = await import('../src/core/factories.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mapSystem = { active: false, currentMap: null };
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem, dragonSystem: ds, uiManager: { log() {} },
  });

  T('长①-大型小兵成长表配了 ap 字段（炮兵/图腾兵/术士兵/蚀骨兵/超级兵/攻城车）',
    ['siege', 'totem', 'warlock', 'corrupt', 'super', 'ram'].every(t =>
      typeof CONFIG.battleGrowth[t].ap === 'number' && CONFIG.battleGrowth[t].ap > 0));
  T('长②-普通兵（近战/远程）没有法术强度成长', !CONFIG.battleGrowth.melee.ap && !CONFIG.battleGrowth.ranged.ap);

  const noGrowth = F.createMinion('siege', 0, 0, 1, 1, { growthFlat: { hp: 0, ad: 0, res: 0, ap: 0 } });
  const withGrowth = F.createMinion('siege', 0, 0, 1, 1, { growthFlat: { hp: 0, ad: 0, res: 0, ap: 20 } });
  T('长③-growthFlat.ap 真的加到了 abilityPower 上（不是只在配置表里存在没接线）',
    Math.abs((withGrowth.baseStats.abilityPower - noGrowth.baseStats.abilityPower) - 20) < 1e-9);

  const mainSrc = srcOf('src/main.js');
  T('长④-main.js 的成长取值函数把 ap 也算进去了（不是只有 hp/ad/res 三项）',
    /ap:\s*\(f\.ap \|\| 0\) \* n/.test(mainSrc));

  const schemaSrc = srcOf('src/data/schema/index.js');
  T('长⑤-模板编辑器 Schema 也补了 ap 这个成长字段（不是只在 Config 里加了个死数）',
    /NUM\('ap', '法术强度 \/波'/.test(schemaSrc));
}

// ==================== 二十一、v51.4：龙魂改回纯主题方向 + 首条龙延后 ====================
// 用户否掉了 v44 定下的"每条魂都塞一份生存分量"规则："巨龙之力/龙魂的方向就是
// 只加某方向的属性，不要因为平衡加一些别的（比如加双抗/生命值等）。哪种类型的
// 巨龙之力/龙魂就加哪种类型的属性/方向。" 并要求审视新属性框架（法力/暴击等）
// 有没有正确用上、以及龙魂/巨龙之力有没有正确在塔与全部大型小兵身上生效。
{
  const { ents, fx, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: AttributeCalculator, eventBus: new EventBus() };

  // 雷魂新增暴击率、星魂新增法术强度——两个此前龙魂系统完全没用过的新框架属性，
  // 各挑一个大型小兵类型（不是塔）验证真的吃到了效果，不是只在配置表里存在。
  // v51.11：雷魂/星魂的常驻加持已按用户定稿清零（强度旋钮搬到这里，见 Config.js
  // dragonSouls.stat 的 v51.11 说明），这条测的是"框架本身接得上"而不是"现在
  // 配了多少"，所以临时塞一个非零测试值，跑完再还原，不依赖当前的平衡数值。
  const siege = mkEntity(ents, 'siege', {}, CONFIG);
  const thunderInst = { id: 1, skillId: 'dragonsoul_thunder', state: {} };
  const thunderStatBak = { ...CONFIG.dragonSouls.stat.thunder };
  CONFIG.dragonSouls.stat.thunder.critChance = 15;
  SkillLibrary.dragonsoul_thunder.onEquip(siege.id, thunderInst, ctx);
  const critAfter = AttributeCalculator.calc(siege, fx.getEffects(siege.id)).critChance;
  T('魂框①-雷魂的暴击率（新框架属性）正确挂到大型小兵（炮兵）身上，不只是塔',
    critAfter >= (siege.baseStats.critChance || 0) + CONFIG.dragonSouls.stat.thunder.critChance - 1e-6);
  CONFIG.dragonSouls.stat.thunder = thunderStatBak;

  const totem = mkEntity(ents, 'totem', {}, CONFIG);
  const astralInst = { id: 2, skillId: 'dragonsoul_astral', state: {} };
  const astralStatBak = { ...CONFIG.dragonSouls.stat.astral };
  CONFIG.dragonSouls.stat.astral.abilityPower = 20;
  SkillLibrary.dragonsoul_astral.onEquip(totem.id, astralInst, ctx);
  const apAfter = AttributeCalculator.calc(totem, fx.getEffects(totem.id)).abilityPower;
  T('魂框②-星魂的法术强度（新框架属性）正确挂到大型小兵（图腾兵）身上',
    apAfter >= (totem.baseStats.abilityPower || 0) + CONFIG.dragonSouls.stat.astral.abilityPower - 1e-6);
  CONFIG.dragonSouls.stat.astral = astralStatBak;

  // 领受范围审计：SOUL_REWARD_OK 按"类型排除"而不是"类型枚举"实现——近战/远程/龙
  // 排除，其余一律放行。这意味着任何现有或将来新增的大型小兵类型都自动覆盖，
  // 不需要每加一个兵种就去改一次白名单（这正是用户担心的"新加了一堆属性/兵种，
  // 有没有正确生效"的根子——白名单式实现才会漏，排除式实现结构上不会漏）。
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  T('魂框③-龙魂领受范围是排除式实现（塔+除近战/远程外全部小兵），不是逐个类型枚举',
    ['siege', 'totem', 'warlock', 'corrupt', 'super', 'ram', 'tower']
      .every(t => DragonSystem.SOUL_REWARD_OK({ type: t }))
    && !DragonSystem.SOUL_REWARD_OK({ type: 'melee' })
    && !DragonSystem.SOUL_REWARD_OK({ type: 'ranged' })
    && !DragonSystem.SOUL_REWARD_OK({ type: 'dragon' }));

  // 主题独占：十三条魂的常驻数值互不重复（sim_v44「龙⑩」已经断言过，这里额外确认
  // 六条被改动/新增新框架属性的魂各自"只用了自己的方向"，没有借用别的元素已占用的键）。
  const stat = CONFIG.dragonSouls.stat;
  // v51.11：血魂常驻加持已清零（见上），"是否用了 physicalVampPct"不再适用——
  // 空对象天然不会跟任何人撞车，这里只保留"没有误留 lifeStealPct"这条还有意义的检查。
  T('魂框④-血魂常驻加持不含 lifeStealPct（不会跟暗魂撞车，哪怕以后又填了内容）',
    !('lifeStealPct' in stat.blood));
  T('魂框⑤-铁魂不再借用潮魂独占的治疗护盾强度',
    !('healShieldPowerPct' in stat.steel));
  T('魂框⑥-蚀魂不再借用炎魂独占的攻击力百分比',
    !('attackDamagePct' in stat.rift));
  T('魂框⑦-炎/雷/毒三条魂不再塞跟主题无关的最大生命百分比（山魂才是）',
    !('maxHPPct' in stat.fire) && !('maxHPPct' in stat.thunder) && !('maxHPPct' in stat.poison)
    && 'maxHPPct' in stat.earth);

  // 补齐剩下四个还没用上的新框架属性（用户确认的方案A）：法力回复→潮魂（次要项，
  // 对塔空转但强化装了主动技能的小兵）、技能增幅→熔魂（自己的灼烧DOT已标casterId，
  // 吃得到）、暴击伤害→雷魂（配暴击率凑成"会心一击"）、闪避率→风魂（呼应难以捉摸）。
  // v51.11：magma/thunder 的常驻加持已清零，skillAmpPct/critDamagePct 不再挂在
  // 它们身上——这两项只在 water.manaRegen / wind.evasionPct 上还留着，一并核对
  // 没有撞到别的元素独占的键。
  T('魂框⑧-未清零的新框架属性各自分给了一条魂，且不撞车',
    stat.water.manaRegen > 0 && stat.wind.evasionPct > 0
    && !('manaRegen' in stat.fire) && !('skillAmpPct' in stat.astral)
    && !('skillAmpPct' in stat.magma) && !('critDamagePct' in stat.thunder));

  // 首条龙延后（用户："第一波龙生成的太快了，导致龙的倾向就偏向于红方了"）——
  // v51.9 起改成随机区间，这里只钉"首条巨龙的区间下限不再低到能抢跑"这件事本身，
  // 具体的随机区间行为在下面"龙时②"那块（v51.9 新增）单独钉。
  const { dragonCfg } = await import('../src/data/dragonCurve.js');
  T('龙时①-首条元素龙不再单独抢跑（下限 ≥ 60s，不是 v43 时代的 1 分钟就刷）',
    dragonCfg().firstDelay[0] >= 60);
}

// ==================== 二十二、v51.5：临时龙魂倒计时环不显示的 bug + 升温资源条第一击不计入 ====================
// 用户 Q1："某单位杀死龙后获得的临时龙魂，在状态栏并未显示进度条。"
{
  const { ents, fx } = await world();
  const { UIManager } = await import('../src/ui/UIManager.js');
  globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => null }), addEventListener() {} };
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
  const ui = Object.create(UIManager.prototype);

  // 一份最小可用的 FakeEl：支持 _updateEffectIcons 实际会用到的那几个操作
  // （className/dataset/innerHTML/querySelector('.effect-cd-ring')/appendChild/remove）。
  class FakeRing { constructor() { this.style = {}; } }
  class FakeEl {
    constructor() { this.className = ''; this.dataset = {}; this._html = ''; this._ring = new FakeRing(); this._children = []; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    querySelector(sel) { return sel === '.effect-cd-ring' ? this._ring : null; }
    appendChild(c) { this._children.push(c); }
    remove() {}
  }
  const fakeDoc = { createElement: () => new FakeEl() };
  const realDoc = globalThis.document;
  globalThis.document = fakeDoc;
  const container = { appendChild() {} };

  // 模拟"永久龙魂展示效果"→ DragonSystem._grantSlayer 那段改成限时的同一套字段变更
  // （remainingTime/maxDuration/permanent 都改，blueprint.duration 不动——那是
  // 蓝图上的出厂设计值，DragonSystem 那段代码本来就不该去碰它）。
  const soulId = fx.apply(1, {
    name: '雷魂', icon: '⚡', kind: 'stat', statKey: 'armor', flatValue: 1,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
    description: '常驻',
  }, 'soul_display_dragonsoul_thunder');
  const disp = fx.getEffect(soulId);
  disp.remainingTime = 30; disp.maxDuration = 60; disp.permanent = false; disp.blueprint.permanent = false;

  ui._updateEffectIcons(container, fx.getEffects(1));
  const ring1 = container._iconMap.get('雷魂').ring;
  globalThis.document = realDoc;

  T('龙时②-临时龙魂（限时后的展示效果）不再被判成"永久"而不画环',
    ring1.style.background !== 'none' && ring1.style.background !== undefined);
  // 用旧公式（除 blueprint.duration=Infinity）算出来的结果是 elapsedFrac=0（deg=0）
  // 且【不随 remainingTime 变化】；用正确的 maxDuration 算，remainingTime=30/60
  // 应该是半程（deg=180），这里直接抠出 deg 数值验证不是巧合碰对了 0 这个特例。
  const deg1 = Number((ring1.style.background.match(/rgba\(0,0,0,0\.72\) (\d+)deg/) || [])[1]);
  T('龙时③-剩余时间过半时，倒计时环确实画到了半程（deg≈180），不是死数字',
    Math.abs(deg1 - 180) <= 2);
}

// 升温资源条第一击不计入（用户："第一下攻击不计入……在充能条上显示X/3"）
{
  const { ents, fx, combat, CONFIG } = await world();
  const { resourceInfoOf } = await import('../src/core/resourceBar.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const ctx = { skillLibrary: SkillLibrary, attrCalc: AttributeCalculator, effects: fx };
  const atk = mkEntity(ents, 'tower', {
    stats: { attackDamage: 100, armor: 0, magicResist: 0, baseAttackSpeed: 1 },
    skills: ['weapon_piercing'],
  }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 1000000 } }, CONFIG);

  combat.performAttack(atk, tgt); // 第一击：100%基础伤害，不该在资源条上显示任何层数
  const infoAfter1 = resourceInfoOf(atk, ctx);
  T('龙时④-第一次命中后资源条显示 0（不把"预判层数"当成已生效的加成）',
    infoAfter1 && infoAfter1.kind === 'heat' && infoAfter1.label === '0/3' && infoAfter1.frac === 0);

  combat.performAttack(atk, tgt); // 第二击：这一下才吃到 +30%，资源条该显示 1
  const infoAfter2 = resourceInfoOf(atk, ctx);
  T('龙时⑤-第二次命中后资源条显示 1/3（分母也从 4 变成 3）',
    infoAfter2 && infoAfter2.label === '1/3');
}

// ==================== 二十三、v51.5：删除过时塔被动 + 钢铁防线限时/永久合并 ====================
// 用户："过热核心删除。吸血鬼删除。相位领域删除。钢铁防线这种的，有永久的有
// 持续多少秒的。都进行合并……可以设置这个技能持续多久或者是永久持续。"
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  T('删①-过热核心/吸血鬼/相位领域三条技能已从技能库删除',
    !SkillLibrary.passive_overheat && !SkillLibrary.passive_vampire && !SkillLibrary.passive_phase);

  T('删②-钢铁防线的永久版（passive_iron_line_ha）已删除，只剩一条合并后的技能',
    !SkillLibrary.passive_iron_line_ha && !!SkillLibrary.passive_iron_line);

  const { ents, fx, attr, CONFIG } = await world();
  const t1 = mkEntity(ents, 'tower', {}, CONFIG);
  // 默认（无覆写）：限时 300 秒，行为与合并前的 passive_iron_line 逐位一致
  const { equipSkill } = await import('../src/core/skillParams.js');
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr };
  equipSkill(t1, 'passive_iron_line', ctx, SkillLibrary);
  const eff1 = fx.getEffectByName(t1.id, '钢铁防线');
  T('合①-默认（无覆写）走限时 300 秒，不是永久', eff1 && !eff1.permanent && Math.abs(eff1.remainingTime - 300) < 1);

  // 用 CONFIG.skillOverrides（全局覆写层）模拟"这条技能被设成永久"——与地图级覆写
  // 走同一套 resolveSkillParams 三层叠加，模拟全局层即可验证 durationSec<=0 的分支。
  CONFIG.skillOverrides = CONFIG.skillOverrides || {};
  CONFIG.skillOverrides.passive_iron_line = { durationSec: 0 };
  const t2 = mkEntity(ents, 'tower', {}, CONFIG);
  equipSkill(t2, 'passive_iron_line', ctx, SkillLibrary);
  const eff2 = fx.getEffectByName(t2.id, '钢铁防线');
  // 注意：新建的效果实例本身不会在创建时写 instance.permanent 这个字段（只有
  // "刷新已有实例"那条路径才会写），永久与否的权威判据是 remainingTime===Infinity
  // + blueprint.permanent，不是 instance.permanent——这也是 Q1 那个环形进度条
  // bug 顺带暴露出来的同一个坑，这里避免重蹈覆辙。
  T('合②-durationSec<=0 时走永久（不会过期）',
    eff2 && eff2.blueprint.permanent === true && eff2.remainingTime === Infinity);
  delete CONFIG.skillOverrides.passive_iron_line;

  T('合③-defaultParams 声明了 durationSec，会被"技能数值编辑器"自动收录（不需要额外接 UI）',
    SkillLibrary.passive_iron_line.defaultParams
    && typeof SkillLibrary.passive_iron_line.defaultParams.durationSec === 'number');
}

// ==================== 二十四、v51.5：单位编辑窗口统一龙魂 tab + 顺带修的三个 bug ====================
// 用户："编辑塔的界面有龙魂，编辑其他界面就没有龙魂了？这是怎么回事，统一一下。"
{
  const openSrc = srcOf('src/ui/editor/open.js');
  T('编①-龙魂 tab 的开关从"是不是塔"改成"够不够格拿龙魂"（SOUL_REWARD_OK）',
    /const soulEligible = DragonSystem\.SOUL_REWARD_OK\(entity\)/.test(openSrc)
    && /soulEligible \? \[\{ key: 'soul'/.test(openSrc));
  T('编①-武器 tab 仍然只给塔（武器是塔专属概念，不受这次改动影响）',
    /isTower \? \[\{ key: 'weapon'/.test(openSrc));

  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  T('编①-实测：图腾兵（大型小兵）满足 soul 资格，近战兵不满足',
    DragonSystem.SOUL_REWARD_OK({ type: 'totem' }) && !DragonSystem.SOUL_REWARD_OK({ type: 'melee' }));

  // 顺带修的三个 bug：都在这次被解锁给小兵用的同一块龙魂 UI 代码里，之前只有塔能
  // 打开这个 tab，所以从来没人点到过。
  const pagesEntitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('修①-单位龙魂 tab 的悬浮说明不再引用未声明的 entity/ctx（会抛 ReferenceError）',
    /renderSkillDescription\(def, tower, ctx\)/.test(pagesEntitySrc)
    && !/renderSkillDescription\(def, entity, ctx\)/.test(pagesEntitySrc));
  T('修②-巨龙增益池调用的是真实存在的 _applyElementBuff（不是已改名的 _applyElementBuffToTower）',
    /app\.dragonSystem\._applyElementBuff\(tower, key\)/.test(pagesEntitySrc)
    && !/_applyElementBuffToTower/.test(pagesEntitySrc));

  const pagesConfigSrc = srcOf('src/ui/editor/pagesConfig.js');
  T('修③-模板编辑器的龙魂悬浮说明同样修了（同一个 ReferenceError 的另一处拷贝）',
    /renderSkillDescription\(def, null, \{\}\)/.test(pagesConfigSrc)
    && !/renderSkillDescription\(def, entity, ctx\)/.test(pagesConfigSrc));
}

// ==================== 二十五、v51.5：冰霜镀层加法术强度 + 批量龙魂改卡片池 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { equipSkill } = await import('../src/core/skillParams.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr };
  const t = mkEntity(ents, 'tower', {}, CONFIG);
  const inst = equipSkill(t, 'passive_frost_plating', ctx, SkillLibrary);
  // 直接调用 onFrame 三次（每次跨越 60s 阈值）模拟叠 3 层，不必真等 180 秒。
  for (let i = 0; i < 3; i++) SkillLibrary.passive_frost_plating.onFrame(t.id, 60, inst, ctx);
  const stats = attr.calc(t, fx.getEffects(t.id));
  // 用户："+3法术强度……注意不是百分比，是数值"——3 层应该是 +9（固定值，
  // 不随任何百分比缩放），与攻击力/护甲/魔抗那三项的【百分比】性质不同。
  T('冰①-冰霜镀层新增法术强度，且是固定数值不是百分比（3层=+9）',
    Math.abs(stats.abilityPower - (t.baseStats.abilityPower || 0) - 9) < 1e-6);
}

{
  const { EDITOR_PAGES_GAMEPLAY_WORLD } = await import('../src/ui/editor/pagesGameplayWorld.js');
  const { ents, fx, CONFIG } = await world();
  window.CTX = window.CTX || {};
  window.CTX.__app = { entityContainer: ents };
  const t1 = mkEntity(ents, 'totem', { faction: 'blue' }, CONFIG);
  t1._mapFaction = 'blue';
  const t2 = mkEntity(ents, 'siege', { faction: 'blue' }, CONFIG);
  t2._mapFaction = 'blue';
  t1._skillInstances.push({ id: 999, skillId: 'dragonsoul_thunder', state: {} });

  const counts = EDITOR_PAGES_GAMEPLAY_WORLD._dgFactionActiveSouls({ }, 'blue');
  T('批①-_dgFactionActiveSouls 正确统计该阵营每条魂被多少单位持有',
    counts.dragonsoul_thunder === 1 && !counts.dragonsoul_fire);
  T('批①-排除 dragonsoul_ancient（限时的远古之力不算进"常驻龙魂"统计）', (() => {
    t2._skillInstances.push({ id: 998, skillId: 'dragonsoul_ancient', state: {} });
    const c2 = EDITOR_PAGES_GAMEPLAY_WORLD._dgFactionActiveSouls({}, 'blue');
    return !c2.dragonsoul_ancient;
  })());
}

// ==================== 二十五(b)、v51.6：批量龙魂改成"共享池+广播目标复选框+已生效chip移除" ====================
// 用户第二版反馈："模板编辑器里龙魂编辑页面依旧乱七八糟……【蓝方龙魂池】【红方龙魂池】
// 【全部生效/蓝方/红方（复选框）】【巨龙之力池】【龙魂池】。点击之后就加到红蓝方龙魂池中，
// 在池中减少某个龙魂等。" —— 卡片池从"蓝/红各一份"改成一份共享池，点哪个阵营生效由
// 复选框决定；"已生效"从卡片角标数字改回真正的 chip 条，chip 上点 ✕ 移除。
{
  const { ents, fx, bus, attr, SkillLibrary, CONFIG } = await world();
  const { DragonSystem, DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
  const { EDITOR_PAGES_GAMEPLAY_WORLD } = await import('../src/ui/editor/pagesGameplayWorld.js');
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, attr);
  window.CTX = window.CTX || {};
  window.CTX.__app = { entityContainer: ents, effectRegistry: fx, dragonSystem: ds };

  const siege = mkEntity(ents, 'siege', { faction: 'blue' }, CONFIG); // 塔+大型小兵：SOUL 和 POWER 都该收到
  const melee = mkEntity(ents, 'melee', { faction: 'blue' }, CONFIG); // 普通小兵：只有 POWER 该收到

  const el0 = Object.keys(DRAGON_ELEMENTS)[0];
  const soulId0 = DRAGON_ELEMENTS[el0].soul;

  // 够 _bindGameplayDragonEvents 用的最小 DOM 桩：dataset/addEventListener/click，
  // 不需要真的渲染 HTML——测的是点击之后 ds/entity 的真实状态变化，不是字符串。
  // addEventListener 用「覆盖」不用「累加」：真实 DOM 里 refresh() 靠重写 innerHTML
  // 换出全新节点，旧节点连同它绑的监听器一起被丢弃；这里的桩子是长期复用的同一个
  // 对象，每次 refresh 触发的重新绑定如果用累加，同一张卡片会越攒越多个监听器，
  // 点一下实际触发 N 次——这是桩子和真实 DOM 生命周期不一致造成的假象，不是被测代码的 bug。
  class FakeEl {
    constructor() { this.dataset = {}; this.checked = false; this.value = ''; this._html = ''; this._listeners = {}; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    addEventListener(evt, cb) { this._listeners[evt] = [cb]; }
    click() { (this._listeners.click || []).forEach(cb => cb()); }
    fire(evt) { (this._listeners[evt] || []).forEach(cb => cb()); }
  }
  const scopeAll = new FakeEl(); scopeAll.value = 'all'; scopeAll.checked = true;
  const scopeBlue = new FakeEl(); scopeBlue.value = 'blue'; scopeBlue.checked = false;
  const scopeRed = new FakeEl(); scopeRed.value = 'red'; scopeRed.checked = false;
  let scopeBoxes = [scopeAll];
  const powerCard = new FakeEl(); powerCard.dataset = { dgpKind: 'power', dgpEl: el0 };
  const soulCard = new FakeEl(); soulCard.dataset = { dgpKind: 'soul', dgpEl: el0, dgpSoulid: soulId0 };
  const templateContentStub = new FakeEl();
  const descBoxStub = new FakeEl();
  let removeChips = [];
  const overlay = {
    isConnected: false,
    querySelector(sel) {
      if (sel === '#templateContent') return templateContentStub;
      if (sel === '#dgSoulDescBox') return descBoxStub;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.dg-scope') return scopeBoxes;
      if (sel === '[data-dgp-kind]') return [powerCard, soulCard];
      if (sel === '[data-dg-remove-kind]') return removeChips;
      return [];
    },
    contains() { return false; },
  };
  const logs = [];
  EDITOR_PAGES_GAMEPLAY_WORLD._bindGameplayDragonEvents(overlay, (m) => logs.push(m));

  powerCard.click();
  T('批池①-点巨龙之力卡片：POWER_REWARD_OK 范围广播，连普通近战兵都收到（不是龙魂那条窄范围）',
    fx.getEffects(melee.id).some(e => e.sourceId === `dragon_buff_${el0}_0`)
    && fx.getEffects(siege.id).some(e => e.sourceId === `dragon_buff_${el0}_0`));

  soulCard.click();
  T('批池②-点龙魂卡片：只广播给 SOUL_REWARD_OK 范围（普通近战兵不该装上，攻城车该装上）',
    !(melee._skillInstances || []).some(i => i.skillId === soulId0)
    && (siege._skillInstances || []).some(i => i.skillId === soulId0));

  soulCard.click();
  T('批池③-同一张龙魂卡片再点一次：整场按"点击前是否为空"统一卸下，不是逐单位各自反转',
    !(siege._skillInstances || []).some(i => i.skillId === soulId0));

  const removeChip = new FakeEl();
  removeChip.dataset = { dgRemoveKind: 'power', dgRemoveFac: 'blue', dgRemoveEl: el0 };
  removeChips = [removeChip];
  EDITOR_PAGES_GAMEPLAY_WORLD._bindGameplayDragonEvents(overlay, (m) => logs.push(m)); // 重新绑定，拿到新的 removeChips
  removeChip.click();
  T('批池④-已生效 chip 点 ✕：巨龙之力 -1 层清零后效果被移除（该阵营内两种单位都要移干净）',
    !fx.getEffects(melee.id).some(e => e.sourceId === `dragon_buff_${el0}_0`)
    && !fx.getEffects(siege.id).some(e => e.sourceId === `dragon_buff_${el0}_0`));

  if (EDITOR_PAGES_GAMEPLAY_WORLD._dgLiveTimer) {
    clearInterval(EDITOR_PAGES_GAMEPLAY_WORLD._dgLiveTimer);
    EDITOR_PAGES_GAMEPLAY_WORLD._dgLiveTimer = null;
  }

  const gwSrc = srcOf('src/ui/editor/pagesGameplayWorld.js');
  T('批池⑤-旧版"按阵营各复制一份池子/清空按钮/击杀数表格"的死代码已经删除',
    !/dg-clear-all-soul/.test(gwSrc) && !/data-dgsoul-id/.test(gwSrc) && !/dg-set-kills/.test(gwSrc) && !/dg-kill-field/.test(gwSrc));
  T('批池⑥-巨龙之力的广播/移除都显式指定 POWER_REWARD_OK（不能落到 _grantAll 默认的 SOUL 那条窄范围）',
    (gwSrc.match(/DragonSystem\.POWER_REWARD_OK/g) || []).length >= 2);

  // ==================== Q19：广播目标复选框——互斥 + 跨重绘持久化 ====================
  // 用户："点击某一方后全部生效还是被错误的选中。并且我选中某个加上去之后，广播
  // 目标又被设置成默认全部广播了，应该保留原先选中的目标。"
  scopeBoxes = [scopeAll, scopeBlue, scopeRed];
  EDITOR_PAGES_GAMEPLAY_WORLD._bindGameplayDragonEvents(overlay, (m) => logs.push(m)); // 重新绑定，拿到新的 scopeBoxes

  // bug①：勾"蓝方"时，"全部生效"必须被联动取消（不是各管各的两个死复选框）
  scopeBlue.checked = true;
  scopeBlue.fire('change');
  T('广①-勾选单独阵营（蓝方）后，"全部生效"复选框被联动取消勾选',
    scopeAll.checked === false && scopeBlue.checked === true);
  T('广②-_dgScopeFactions 此时只回蓝方一个阵营，不再被"全部生效"顶掉',
    JSON.stringify(EDITOR_PAGES_GAMEPLAY_WORLD._dgScopeFactions(overlay)) === JSON.stringify(['blue']));

  // bug②：这份选择必须能扛住一次"重绘"（每秒自重绘定时器/点池子卡片后的 refresh 都会重绘），
  // 不能被写死的默认值冲掉——重绘就是重新调用 _renderGameplayDragonSoulPool。
  const reRendered = EDITOR_PAGES_GAMEPLAY_WORLD._renderGameplayDragonSoulPool(ds);
  T('广③-重绘后的 HTML 里"蓝方"复选框仍然带 checked，"全部生效"不再带 checked（选择被保留，不是被冲回默认全选）',
    /value="blue" checked/.test(reRendered) && !/value="all" checked/.test(reRendered));

  // 勾"全部生效"要把之前单独选的阵营复选框联动取消（反向互斥同样成立）
  scopeAll.checked = true;
  scopeAll.fire('change');
  T('广④-反向：勾"全部生效"后，之前单独勾选的蓝方复选框被联动取消',
    scopeAll.checked === true && scopeBlue.checked === false && scopeRed.checked === false);
  T('广⑤-勾"全部生效"后 _dgScopeFactions 回全部阵营', EDITOR_PAGES_GAMEPLAY_WORLD._dgScopeFactions(overlay).length === EDITOR_PAGES_GAMEPLAY_WORLD._DG_FACTIONS.length);
}

// ==================== 二十五(c)、v51.6：修单位编辑器"龙魂 tab 点 X 没反应"的真根因 ====================
// 用户报的隐藏 bug："单位编辑界面中想删除某个龙魂点X没反应"。排查结论：pagesEntity.js
// 的 _renderSoulContent/_bindSoulEvents 读的是裸 window.__app —— 全仓库只有
// window.CTX.__app 是真的被赋值过的（main.js:54/221），window.__app 从未被赋值过，
// app 恒为 undefined，点按钮时 app.dragonSystem.xxx 直接抛 TypeError，被事件处理器
// 悄悄吞掉，界面上看起来"点了没反应"。顺带发现同一个 tab 里"巨龙增益 -1 层"还有第二个
// 独立 bug：decrementBuff 读的是 el.buff.length，而 DRAGON_ELEMENTS 从 v44 起就没有
// .buff 字段了（属性表改成从 CONFIG.dragonPower 读，见 DragonSystem.js dragonPowerBuffs
// 头注），点了同样会抛 TypeError。
{
  const { ents, fx, bus, attr, SkillLibrary, CONFIG } = await world();
  const { DragonSystem, DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
  const { EDITOR_PAGES_ENTITY } = await import('../src/ui/editor/pagesEntity.js');
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, attr);
  window.CTX = window.CTX || {};
  window.CTX.__app = { entityContainer: ents, effectRegistry: fx, dragonSystem: ds, DRAGON_ELEMENTS, SkillLibrary };
  window.__app = undefined; // 显式清空——确保这个测试真的在验证 window.CTX.__app 那条路径，不是巧合靠旧全局变量测过

  const tower = mkEntity(ents, 'tower', { faction: 'blue' }, CONFIG);
  const el0 = Object.keys(DRAGON_ELEMENTS)[0];
  const soulId0 = DRAGON_ELEMENTS[el0].soul;
  ds._applyElementBuff(tower, el0); // 先叠 1 层力
  ds._toggleSoul(tower, soulId0);   // 先装 1 条魂

  class FakeEl {
    constructor() { this.dataset = {}; this._html = ''; this._listeners = {}; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    addEventListener(evt, cb) { (this._listeners[evt] = this._listeners[evt] || []).push(cb); }
    click() { (this._listeners.click || []).forEach(cb => cb()); }
  }
  const removeBuffChip = new FakeEl(); removeBuffChip.dataset = { removeKind: 'buff', removeKey: el0 };
  const removeSoulChip = new FakeEl(); removeSoulChip.dataset = { removeKind: 'soul', removeKey: el0 };
  const editorContentStub = new FakeEl();
  const overlay = {
    querySelector(sel) { return sel === '#editorContent' ? editorContentStub : null; },
    querySelectorAll(sel) {
      if (sel === '[data-pool-kind="buff"]') return [];
      if (sel === '[data-pool-kind="soul"]') return [];
      if (sel === '[data-remove-kind]') return [removeBuffChip, removeSoulChip];
      return [];
    },
  };
  let threw = null;
  try {
    EDITOR_PAGES_ENTITY._bindSoulEvents(overlay, tower, () => {});
    removeSoulChip.click();
    removeBuffChip.click();
  } catch (e) { threw = e; }

  T('实体龙魂 tab①-window.__app 恒 undefined 的根因修好后，点 chip 移除不再抛异常',
    !threw);
  T('实体龙魂 tab②-点龙魂 chip 真的卸下了那条魂（不是"看起来点了但没生效"）',
    !(tower._skillInstances || []).some(i => i.skillId === soulId0));
  T('实体龙魂 tab③-decrementBuff 改成按 sourceId 前缀扫描后，-1层 真的清空了力（不再依赖已不存在的 el.buff 字段）',
    !fx.getEffects(tower.id).some(e => e.sourceId === `dragon_buff_${el0}_0`));
}

// ==================== 二十六、v51.5：删图腾兵僵尸技能+统一默认被动清单+塔被动新联动 ====================
// 用户："把过时的图腾兵技能删除。你说的那前两个可以（荆棘反击加法术强度/重甲联防
// 加韧性）。防御塔镀层爆发重做，改为+33%伤害减免，持续10秒，不可叠加。"
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  T('删③-图腾兵四条僵尸技能（守护/觉醒/滋养/献祭）已从技能库删除',
    !SkillLibrary.passive_totem_guardian && !SkillLibrary.passive_totem_awaken
    && !SkillLibrary.passive_totem_nourish && !SkillLibrary.passive_totem_sacrifice);

  // 顺带发现并修的 bug：编辑器的"默认被动"回填表与 factories.js 真正消费的那份
  // 早就漂移了（totem 一直显示重做前的老三件套，warlock/siege/corrupt 缺主动技能）。
  // 现在两处读同一个模块，这里直接比对，逐位相同才算真的统一。
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  const { EDITOR_PAGES_SKILLEFFECT } = await import('../src/ui/editor/pagesSkillEffect.js');
  T('统①-编辑器默认被动回填表与 factories.js 真正消费的清单是同一个对象（不再是两份手抄副本）',
    EDITOR_PAGES_SKILLEFFECT._DEFAULT_PASSIVE_MAP === DEFAULT_MINION_PASSIVES);
  // v51.6：passive_totem_mend（被动"图腾涌泉"）与旧主动 active_totem_shield（庇护波）
  // 一并删除，合并成新主动技能 active_totem_mend（同名"图腾涌泉"）。
  T('统②-图腾兵默认清单是重做后的两条被动+主动技能，不是老三件套/旧主动',
    DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_aura')
    && DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_bulwark')
    && DEFAULT_MINION_PASSIVES.totem.includes('active_totem_mend')
    && !DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_mend')
    && !DEFAULT_MINION_PASSIVES.totem.includes('active_totem_shield')
    && !DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_guardian'));
  T('统③-warlock/siege/corrupt 的默认清单也补上了此前漏掉的主动技能',
    DEFAULT_MINION_PASSIVES.warlock.includes('active_warlock_empower')
    && DEFAULT_MINION_PASSIVES.siege.includes('active_siege_haste')
    && DEFAULT_MINION_PASSIVES.corrupt.includes('active_corrupt_poison'));

  // 荆棘反击：新增法术强度联动
  const { ents, fx, combat, CONFIG } = await world();
  const t1 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000, abilityPower: 0 }, skills: ['passive_thorns'] }, CONFIG);
  const atk1 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, attackDamage: 50, maxHP: 100000 } }, CONFIG);
  const before1 = atk1.currentHP;
  SkillLibrary.passive_thorns.onBeingAttacked(t1.id, atk1.id, null, { entityContainer: ents, effectRegistry: fx, attrCalc: (await world()).attr, combat });
  const reflectNoAP = before1 - atk1.currentHP;
  const t2 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000, abilityPower: 40 }, skills: ['passive_thorns'] }, CONFIG);
  const atk2 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, attackDamage: 50, maxHP: 100000 } }, CONFIG);
  const before2 = atk2.currentHP;
  SkillLibrary.passive_thorns.onBeingAttacked(t2.id, atk2.id, null, { entityContainer: ents, effectRegistry: fx, attrCalc: (await world()).attr, combat });
  const reflectWithAP = before2 - atk2.currentHP;
  T('联①-荆棘反击的法术强度联动生效：40 法术强度多反弹约 20（40×50%）',
    Math.abs((reflectWithAP - reflectNoAP) - 20) < 1);

  // 重甲联防：新增韧性联动
  const towerHD = mkEntity(ents, 'tower', { stats: { attackRange: 260, maxHP: 100000 }, skills: ['passive_heavy_defense'] }, CONFIG);
  const foeHD = mkEntity(ents, 'melee', { pos: { x: 20, y: 0 } }, CONFIG);
  foeHD.targetId = towerHD.id; foeHD.baseStats.attackRange = 30;
  towerHD.pos = { x: 0, y: 0 };
  const hdInst = towerHD._skillInstances.find(i => i.skillId === 'passive_heavy_defense');
  SkillLibrary.passive_heavy_defense.onFrame(towerHD.id, 1, hdInst, { entityContainer: ents, effectRegistry: fx });
  const hdStats = (await world()).attr.calc(towerHD, fx.getEffects(towerHD.id));
  T('联②-重甲联防新增韧性：1个攻击者时 tenacityPct 应为 +2%',
    Math.abs((hdStats.tenacityPct || 0) - (towerHD.baseStats.tenacityPct || 0) - 2) < 1e-6);

  // 防御塔镀层爆发重做
  const plating = mkEntity(ents, 'tower', { stats: { maxHP: 1000 }, skills: ['passive_armor_plating'] }, CONFIG);
  const pInst = plating._skillInstances.find(i => i.skillId === 'passive_armor_plating');
  const pCtx = { entityContainer: ents, effectRegistry: fx, attrCalc: (await world()).attr };
  SkillLibrary.passive_armor_plating.onEquip(plating.id, pInst, pCtx);
  plating.currentHP = 700; // 跌破 80% 阈值
  SkillLibrary.passive_armor_plating.onFrame(plating.id, 0.1, pInst, pCtx);
  const burstEff = fx.getEffects(plating.id).find(e => e.blueprint.name === '镀层爆发');
  T('爆①-镀层爆发重做为单一效果：+33%伤害减免、10秒、不可叠加',
    burstEff && burstEff.blueprint.statKey === 'damageReduction' && burstEff.blueprint.flatValue === 33
    && Math.abs(burstEff.remainingTime - 10) < 1 && burstEff.blueprint.stackable === false);
  const burstCountBefore = fx.getEffects(plating.id).filter(e => e.blueprint.name === '镀层爆发').length;
  plating.currentHP = 500; // 再跌破 60% 阈值，第二次触发
  SkillLibrary.passive_armor_plating.onFrame(plating.id, 0.1, pInst, pCtx);
  const burstCountAfter = fx.getEffects(plating.id).filter(e => e.blueprint.name === '镀层爆发').length;
  T('爆②-再次破裂只刷新同一份效果，不会叠出第二份（旧版四份数值各自独立累加的问题不再出现）',
    burstCountBefore === 1 && burstCountAfter === 1);
}

// ==================== 二十七、v51.6：近战兵/远程兵首次拥有主动技能 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const bus = { on() {}, emit() {} };
  const mana = new ManaSystem(ents, fx, bus, SkillLibrary, AttributeCalculator, combat);

  T('主动①-近战兵/远程兵的法力上限与回复按用户定稿写入模板',
    CONFIG.templates.melee.maxMana === 25 && CONFIG.templates.melee.manaRegen === 0
    && CONFIG.templates.ranged.maxMana === 70 && CONFIG.templates.ranged.manaRegen === 0.5);

  // 近战兵：本能格挡
  const m = mkEntity(ents, 'melee', { skills: ['active_melee_block'] }, CONFIG);
  m._mana = 25;
  mana.update(1);
  const blockEff = fx.getEffects(m.id).find(e => e.blueprint.name === '本能格挡');
  T('主动②-近战兵满蓝后获得2点伤害格挡，持续2秒', blockEff && blockEff.blueprint.flatValue === 2 && Math.abs(blockEff.remainingTime - 2) < 1e-6);
  T('主动③-施放后法力清零（普通主动技能，不是延迟消耗）', m._mana === 0);

  // 远程兵：强化射击（延迟消耗 + 魔法伤害，复用 _empowerNextAttack 通用机制）
  const r = mkEntity(ents, 'ranged', { stats: { armor: 0, magicResist: 0, attackDamage: 10, abilityPower: 40 },
    skills: ['active_ranged_snipe'] }, CONFIG);
  r._mana = 70;
  mana.update(1);
  T('主动④-远程兵满蓝后蓄势待发（延迟消耗，法力不立刻清零）', r._mana === 70 && !!r._empowerNextAttack);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 1000000 } }, CONFIG);
  const before = tgt.currentHP;
  combat.performAttack(r, tgt);
  const dealt = before - tgt.currentHP;
  // 10 基础攻击 + 40 法术强度×25% = 10 的额外魔法伤害 = 20 总量（真实伤害那条路径
  // 已经在术士兵测试里验证过，这里换成验证 damageType 参数确实传成了 'magic'）
  T('主动⑤-下一次攻击命中后额外造成 25%×法术强度 的伤害，且法力才真正清零',
    dealt > 15 && dealt < 25 && r._mana === 0 && !r._empowerNextAttack);

  T('主动⑥-CombatSystem 的延迟消耗点支持自定义伤害类型（不再永远是真实伤害）',
    /emp\.damageType \|\| 'true'/.test(srcOf('src/systems/CombatSystem.js')));

  // v51.6：术士兵的基础法强从"数值自己定但是不要太多"的一般性基础值，改成了要
  // 专门服务于"攻击力极低+初始法强高，自适应稳定解析成魔法伤害"这件事的更高值，
  // 与远程兵/图腾兵那两个仍然"不要太多"的基础法强不是同一条口径——分开钉两个上限。
  T('主动⑦-远程兵/图腾兵自带基础法术强度，且量级不大（用户："不要太多"）',
    CONFIG.templates.ranged.abilityPower > 0 && CONFIG.templates.ranged.abilityPower <= 20
    && CONFIG.templates.totem.abilityPower > 0 && CONFIG.templates.totem.abilityPower <= 20);
  T('主动⑦b-术士兵基础法强明显高于攻击力（用户："攻击力极低，初始法强高，所以自适应直接造成魔法伤害"）',
    CONFIG.templates.warlock.abilityPower > CONFIG.templates.warlock.attackDamage * 5
    && CONFIG.templates.warlock.attackType === 'adaptive');
}

// ==================== 二十八、v51.6："所有单位攻击方式都自适应"（塔是唯一例外）====================
// 用户："处了特殊说明外，所有单位的攻击方式都应该是自适应（推翻之前的）。修改为：
//        术士兵攻击力极低，初始法强高（所以自适应直接造成魔法伤害）。塔默认造成
//        魔法伤害（特殊说明）。"
{
  const { CONFIG, attr } = await world();
  const nonTower = ['melee', 'ranged', 'siege', 'totem', 'super', 'warlock', 'corrupt', 'ram', 'dragon'];
  T('自适应①-除塔以外全部单位类型的默认攻击方式都是 adaptive',
    nonTower.every(t => CONFIG.templates[t].attackType === 'adaptive'));
  T('自适应②-塔是唯一写死类型的例外，且是魔法（不是 adaptive，也不是 physical）',
    CONFIG.templates.tower.attackType === 'magic');
  T('自适应③-龙的真实战斗字段（CONFIG.gameRules.dragon.combat.attackType）同一版一起改，不是只改了展示用的模板字段',
    CONFIG.gameRules.dragon.combat.attackType === 'adaptive');
  T('自适应④-resolveAttackType 对术士兵当前基础属性真的解析成魔法（不是"AP高但没高到能压过AD"的空调）',
    attr.resolveAttackType({ ...CONFIG.templates.warlock, attackType: 'adaptive' }) === 'magic');
  T('自适应⑤-远程兵默认物理向属性下，resolveAttackType 仍按真实AP/AD比较结果走（不是被写死成某一边）',
    attr.resolveAttackType({ attackType: 'adaptive', attackDamage: 100, abilityPower: 0, adaptiveDefault: 'physical' }) === 'physical'
    && attr.resolveAttackType({ attackType: 'adaptive', attackDamage: 0, abilityPower: 100, adaptiveDefault: 'physical' }) === 'magic');
}

// ==================== 二十九、v51.6：超级兵新主动技能【荆棘装甲】====================
// 用户："超级兵，最大法力120，1/s。新增主动技能【荆棘装甲】：获得（XX=25+10%法强）
//        双抗，持续8秒。并且期间反弹给伤害者实际造成造成伤害的25%的魔法伤害。"
{
  const { ents, fx, combat, attr, SkillLibrary, CONFIG } = await world();
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat };
  T('荆棘①-超级兵模板法力值改为定稿数值', CONFIG.templates.super.maxMana === 120 && CONFIG.templates.super.manaRegen === 1);

  const superUnit = mkEntity(ents, 'super', { faction: 'blue' }, CONFIG);
  superUnit.baseStats.abilityPower = 20; // 25+10%*20=27，验证法强联动确实生效，不是纯固定值
  const inst = { id: ++window._uid, skillId: 'active_thorn_armor', state: {} };
  superUnit._skillInstances.push(inst);
  const before = attr.calc(superUnit, fx.getEffects(superUnit.id));
  T('荆棘②-施放前没有额外双抗', !(before.armor > CONFIG.templates.super.armor + 1) && !(before.magicResist > CONFIG.templates.super.magicResist + 1));

  const cast = SkillLibrary.active_thorn_armor.onCast(superUnit.id, inst, ctx);
  T('荆棘③-施放成功', cast === true);
  const after = attr.calc(superUnit, fx.getEffects(superUnit.id));
  T('荆棘④-双抗 = 25+10%×法术强度（法强20时应该各+27），且护甲/魔抗同步生效',
    Math.abs(after.armor - before.armor - 27) < 1e-6 && Math.abs(after.magicResist - before.magicResist - 27) < 1e-6);

  // 反弹的是【魔法伤害】（用户原话就是"魔法伤害"，不是"真实伤害"），要正常吃攻击者
  // 的魔抗——与 passive_thorns 那条塔反击同一个道理。魔抗清零，让下面的断言直接
  // 验证"25%"这个比例本身，不用另外把 calcDamageMultiplier 的减伤系数也算进去。
  const attacker = mkEntity(ents, 'melee', { faction: 'red' }, CONFIG);
  attacker.baseStats.magicResist = 0;
  const hpBefore = attacker.currentHP;
  SkillLibrary.active_thorn_armor.onDamaged(superUnit.id, attacker.id, 100, ctx);
  const reflectDmg = hpBefore - attacker.currentHP;
  T('荆棘⑤-装甲生效期间受击，按实际伤害的25%反弹魔法伤害给攻击者（100伤害→反弹25）',
    Math.abs(reflectDmg - 25) < 1e-6);

  // 装甲窗口结束后不应该再反弹——把两条 stat 效果都手动移除模拟"buff已过期"。
  for (const e of fx.getEffects(superUnit.id).filter(x => x.sourceId && x.sourceId.startsWith('active_thorn_armor_'))) {
    fx.remove(e.id);
  }
  const hpBefore2 = attacker.currentHP;
  SkillLibrary.active_thorn_armor.onDamaged(superUnit.id, attacker.id, 100, ctx);
  T('荆棘⑥-装甲窗口结束后不再反弹（不是"装备了这个技能就永久反弹"）',
    attacker.currentHP === hpBefore2);
}

// ==================== 三十、v51.6：Q1 修"编辑单位界面-技能里残留充能攻击" ====================
// 用户："编辑单位界面-技能中还是残留着充能攻击。"排查结论：_SKILLS_BY_TYPE 只排除了
// core/dragonsoul 两个 category，没排除 attackmode（充能攻击的 category）——它的
// applicableTypes 几乎覆盖所有类型，于是作为一条可勾选的"被动"技能残留在通用技能
// 列表里。这条口径其实已经在"游戏性·批量加技能"页应用过（用户当时原话："这个里面
// 不要显示充能攻击，这个应该是和塔武器/小兵类型相绑定的"），单位编辑器自己的
// 「技能」tab 当时漏了同一处，这次一并补齐。
{
  const { EDITOR_PAGES_ENTITY } = await import('../src/ui/editor/pagesEntity.js');
  const byType = EDITOR_PAGES_ENTITY._SKILLS_BY_TYPE;
  const leaked = Object.entries(byType).some(([, v]) =>
    (v.passives || []).includes('atkmode_charge') || (v.weapons || []).includes('atkmode_charge'));
  T('技能残留①-任何单位类型的技能列表里都不再包含 atkmode_charge（充能攻击）',
    !leaked);
  T('技能残留②-ram 的充能攻击照样跟着出厂默认配置走（不是被删掉了，只是不进通用勾选列表）',
    (await import('../src/core/defaultMinionPassives.js')).DEFAULT_MINION_PASSIVES.ram.includes('atkmode_charge'));
}

// ==================== 三十一、v51.6：炮车主动技能改成恒定30%、不叠加 ====================
// 用户："炮车主动技能的数值修改为恒定30%，持续6秒。" 推翻 v51.1 那版"30%+50%×法强、
// 可叠加"的设计。
{
  const { ents, fx, attr, SkillLibrary, CONFIG } = await world();
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr };
  const siege = mkEntity(ents, 'siege', { faction: 'blue' }, CONFIG);
  siege.baseStats.abilityPower = 100; // 给它法强，确认恒定值真的不受法强影响
  const inst = { id: ++window._uid, skillId: 'active_siege_haste', state: {} };
  siege._skillInstances.push(inst);
  SkillLibrary.active_siege_haste.onCast(siege.id, inst, ctx);
  const eff1 = fx.getEffects(siege.id).find(e => e.sourceId === 'active_siege_haste');
  T('炮①-急速装填是固定30%攻速，不随法术强度缩放', eff1 && eff1.blueprint.flatValue === 30 && !eff1.blueprint.perStackFlat);
  T('炮②-不可叠加，到点刷新（stackable:false）', eff1 && eff1.blueprint.stackable === false);
  SkillLibrary.active_siege_haste.onCast(siege.id, inst, ctx); // 再施放一次
  const stillOne = fx.getEffects(siege.id).filter(e => e.sourceId === 'active_siege_haste').length;
  T('炮③-连续两次施放不会叠成两份效果', stillOne === 1);
}

// ==================== 三十二、v51.6：加状态面板重做（现代化 UI，Q1）====================
// 用户："加状态的UI你根本没有重做……我要求有现代化的UI并且功能易用。"三处共用同一份
// _renderEffectPicker/_renderEffectParams/_buildEffectBlueprintFromPicker（单位编辑器
// 手动加状态、模板编辑器批量加状态、模板编辑器"状态"tab 的默认状态），改一次三处一起好。
{
  const { EDITOR_PAGES_SKILLEFFECT } = await import('../src/ui/editor/pagesSkillEffect.js');

  // ---- 渲染形状：新组件替换旧的原生 select + 内联深色样式 ----
  const pickerHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectPicker();
  T('状态①-类型选择器改成胶囊 tab（data-efftype），不再是原生 <select>',
    /data-efftype="stat"/.test(pickerHtml) && /data-efftype="stun"/.test(pickerHtml)
    && /data-efftype="dot"/.test(pickerHtml) && !/class="effect-type-select"/.test(pickerHtml));

  const statParamsHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('stat');
  T('状态②-属性选择器改成可搜索卡片网格，标签是中文（不是裸的 attackDamage 这种字段名）',
    /effect-stat-grid/.test(statParamsHtml) && /effect-stat-filter/.test(statParamsHtml)
    && statParamsHtml.includes('攻击力') && /data-effstat="attackDamage"/.test(statParamsHtml));
  T('状态③-持续时间新增独立的"永久"勾选框，不再是"填≤0才是永久"这条隐藏规则',
    /effect-permanent/.test(statParamsHtml));
  T('状态④-数值输入框统一用 .editor-number（不再是手写内联深色样式）',
    /class="effect-flat-value editor-number"/.test(statParamsHtml)
    && !/background:#0d1013/.test(statParamsHtml));

  const dotParamsHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('dot');
  T('状态⑤-DOT 伤害类型也改成 tab（data-effdot），不再是原生 <select>',
    /data-effdot="magic"/.test(dotParamsHtml) && !/class="effect-dot-type"[^>]*<select/.test(dotParamsHtml));

  // ---- 三处调用方都改用统一的 _bindEffectPicker，不再各自手写 change 监听 ----
  const eventsSrc = srcOf('src/ui/editor/events.js');
  const gpSrc = srcOf('src/ui/editor/pagesGameplaySkillState.js');
  const skillEffectSrc = srcOf('src/ui/editor/pagesSkillEffect.js');
  T('状态⑥-单位编辑器/批量加状态/模板默认状态三处都改调 this._bindEffectPicker(box)',
    /this\._bindEffectPicker\(box\)/.test(eventsSrc)
    && /this\._bindEffectPicker\(box\)/.test(gpSrc)
    && /this\._bindEffectPicker\(box\)/.test(skillEffectSrc));
  T('状态⑦-三处都不再各自手写 .effect-type-select 的 change 监听（旧实现被统一替换）',
    !/effect-type-select.*addEventListener\('change'/.test(eventsSrc)
    && !/effect-type-select.*addEventListener\('change'/.test(gpSrc)
    && !/effect-type-select.*addEventListener\('change'/.test(skillEffectSrc));

  // ---- 行为：_buildEffectBlueprintFromPicker 从新 DOM 结构里正确读值 ----
  // 用最小的 querySelector/querySelectorAll 桩子模拟渲染出来的 DOM，
  // 不依赖真实浏览器——测的是"读值逻辑对不对"，不是"点击能不能触发"。
  const mkFakeBox = (fields) => ({
    querySelector(sel) { return fields[sel] ?? null; },
  });

  const statBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'stat' } },
    '.effect-permanent': { checked: false },
    '.effect-duration': { value: '8' },
    '.effect-stat-key': { value: 'armor' },
    '.effect-flat-value': { value: '15' },
    '.effect-percent-value': { value: '0' },
  });
  const statBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(statBox);
  T('状态⑧-stat 蓝图：属性/数值/持续时间都从新结构正确读出',
    statBp.kind === 'stat' && statBp.statKey === 'armor' && statBp.flatValue === 15
    && statBp.duration === 8 && statBp.permanent === false);
  T('状态⑨-stat 蓝图描述用中文标签（fieldLabel），不是裸字段名',
    statBp.description.startsWith('护甲'));

  const permBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'stat' } },
    '.effect-permanent': { checked: true },
    '.effect-duration': { value: '8' }, // 即使数字框还留着非≤0的值，勾了永久也要生效
    '.effect-stat-key': { value: 'maxHP' },
    '.effect-flat-value': { value: '100' },
    '.effect-percent-value': { value: '0' },
  });
  const permBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(permBox);
  T('状态⑩-勾选"永久"复选框直接生效，不需要再靠"把数字改成≤0"这个隐藏技巧',
    permBp.permanent === true && permBp.duration === Infinity);

  const stunBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'stun' } },
    '.effect-permanent': null,
    '.effect-duration': { value: '2' },
  });
  const stunBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(stunBox);
  T('状态⑪-stun 蓝图不受重做影响，形状不变', stunBp.kind === 'stun' && stunBp.duration === 2);

  const dotBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'dot' } },
    '.effect-permanent': null,
    '.effect-duration': { value: '4' },
    '.effect-dot-type': { value: 'physical' },
    '.effect-flat-value': { value: '20' },
  });
  const dotBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(dotBox);
  T('状态⑫-dot 蓝图正确读取新 tab 结构写回的伤害类型', dotBp.kind === 'dot' && dotBp.damageType === 'physical' && dotBp.flatValue === 20);

  // ==================== 补：补全"添加效果"面板缺失的类型/属性 ====================
  // 用户："护盾这个属性别忘了在……某个单位添加效果中加。并且现有的添加效果中属性
  // 不全，后面新加的这些属性都没有，自查一遍，补全所有的属性。并且添加效果中状态
  // 的类型（持续伤害，晕眩等）也不全，补全。"
  const pickerHtml2 = EDITOR_PAGES_SKILLEFFECT._renderEffectPicker();
  T('状态⑭-类型 tab 补上沉默/缴械/护盾（引擎已认得这三种 kind，只是面板之前没暴露）',
    /data-efftype="silence"/.test(pickerHtml2)
    && /data-efftype="disarm"/.test(pickerHtml2) && /data-efftype="shield"/.test(pickerHtml2));

  const missingStatKeys = ['abilityPower', 'skillAmpPct', 'critChance', 'critDamagePct', 'adaptiveForce',
    'physicalVampPct', 'spellVampPct', 'evasionPct', 'tenacityPct', 'maxMana', 'manaRegen'];
  T('状态⑮-属性列表补全 v51 新增的这批（法强/技能增幅/暴击/适应之力/双吸血/闪避/韧性/法力两项）',
    missingStatKeys.every(k => EDITOR_PAGES_SKILLEFFECT._EFFECT_STAT_KEYS.includes(k)));
  const statParamsHtml2 = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('stat');
  T('状态⑯-补全的属性在卡片网格里也有中文标签（不是裸字段名）',
    statParamsHtml2.includes('法术强度') && statParamsHtml2.includes('暴击率')
    && /data-effstat="manaRegen"/.test(statParamsHtml2));

  const shieldParamsHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('shield');
  T('状态⑰-护盾类型的参数区有护盾值输入（复用 .effect-flat-value）+ 持续时间 + 永久勾选',
    /effect-flat-value/.test(shieldParamsHtml) && /effect-duration/.test(shieldParamsHtml)
    && /effect-permanent/.test(shieldParamsHtml));
  const silenceParamsHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('silence');
  const disarmParamsHtml = EDITOR_PAGES_SKILLEFFECT._renderEffectParams('disarm');
  T('状态⑱-沉默/缴械的参数区只有持续时间（跟眩晕同规格，控制类不需要数值输入）',
    /effect-duration/.test(silenceParamsHtml) && !/effect-flat-value/.test(silenceParamsHtml)
    && /effect-duration/.test(disarmParamsHtml) && !/effect-flat-value/.test(disarmParamsHtml));

  const shieldBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'shield' } },
    '.effect-permanent': { checked: false },
    '.effect-duration': { value: '10' },
    '.effect-flat-value': { value: '80' },
  });
  const shieldBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(shieldBox);
  T('状态⑲-护盾蓝图：kind:\'shield\'，flatValue/duration 从面板正确读出，不衰减不回复（无 statKey）',
    shieldBp.kind === 'shield' && shieldBp.flatValue === 80 && shieldBp.duration === 10 && shieldBp.statKey === undefined);

  const silenceBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'silence' } },
    '.effect-permanent': null,
    '.effect-duration': { value: '1.5' },
  });
  const silenceBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(silenceBox);
  T('状态⑳-沉默蓝图：kind:\'silence\'，供 EffectRegistry.isSilenced() 识别',
    silenceBp.kind === 'silence' && silenceBp.duration === 1.5);

  const disarmBox = mkFakeBox({
    '[data-efftype].active': { dataset: { efftype: 'disarm' } },
    '.effect-permanent': null,
    '.effect-duration': { value: '1.5' },
  });
  const disarmBp = EDITOR_PAGES_SKILLEFFECT._buildEffectBlueprintFromPicker(disarmBox);
  T('状态㉑-缴械蓝图：kind:\'disarm\'，供 EffectRegistry.isDisarmed() 识别',
    disarmBp.kind === 'disarm' && disarmBp.duration === 1.5);

  // 行为闭环：新蓝图真的能被 EffectRegistry 认得（不是面板自造了一个引擎不理的 kind）
  {
    const { ents, fx, CONFIG } = await world();
    const t = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
    fx.apply(t.id, shieldBp, 'panel_shield_test');
    const eff = fx.getEffects(t.id).find(e => e.blueprint.kind === 'shield');
    T('状态㉒-面板造出的护盾蓝图挂上后 shieldRemaining=80（走的是同一套第三类护盾机制）',
      !!eff && eff.shieldRemaining === 80);

    fx.apply(t.id, silenceBp, 'panel_silence_test');
    T('状态㉓-面板造出的沉默蓝图挂上后 EffectRegistry.isSilenced() 识别为真', fx.isSilenced(t.id) === true);

    fx.apply(t.id, disarmBp, 'panel_disarm_test');
    T('状态㉔-面板造出的缴械蓝图挂上后 EffectRegistry.isDisarmed() 识别为真', fx.isDisarmed(t.id) === true);
  }
}

// ==================== 三十三、v51.6：召唤师峡谷塔属性修正 ====================
// 用户："属性修正，召唤师峡谷。外塔HP5000，双抗40。内塔HP4000，双抗70。水晶塔HP3500，
// 双抗55。"——"水晶塔"＝tier:'base'，这是 FactionSystem.js 里已经钉死的口径
// （"水晶塔（高地塔，tier='base'）"、"外塔→内塔→水晶塔→召唤水晶"分路链），不是
// nexus_main（召唤水晶本体）也不是 hq_tower（枢纽塔）。
{
  const { summoners_rift } = await import('../src/data/maps/summoners_rift.js');
  const ts = summoners_rift.tierStats;
  T('峡①-外塔：HP 5000，双抗40（双抗本来就是40，只改了HP）',
    ts.outer.maxHP === 5000 && ts.outer.armor === 40 && ts.outer.magicResist === 40);
  T('峡②-内塔：HP 4000，双抗70', ts.inner.maxHP === 4000 && ts.inner.armor === 70 && ts.inner.magicResist === 70);
  T('峡③-水晶塔（tier:base）：HP 3500，双抗55', ts.base.maxHP === 3500 && ts.base.armor === 55 && ts.base.magicResist === 55);
  T('峡④-枢纽塔/召唤水晶本体（hq_tower/nexus_main）不在本次修正范围内，维持原值',
    ts.hq_tower.maxHP === 4750 && ts.nexus_main.maxHP === 5500);
}

// ==================== 三十四、v51.6：伤害转化描述文案纠正 + 子弹速度分组调整 ====================
// 用户："伤害转化的描述有问题，应该为：将受到的实际伤害按百分比转化为临时护盾。
//        子弹速度放在攻击力里，所有单位统一展开更多的最后一个格为移速（目前的塔为
//        子弹速度）。"
{
  const { statDoc } = await import('../src/data/statDocs.js');
  const doc = statDoc('damageConvertPct');
  T('转①-伤害转化的说明文案改成了跟真实实现一致的版本（不是"转成另一种类型结算"那个旧说法）',
    doc.desc === '将受到的实际伤害按百分比转化为临时护盾。'
    && !/另一种类型/.test(doc.desc) && !/另一种类型/.test(doc.formula || ''));

  const { extAttrGroups } = await import('../src/ui/statPanelLayout.js');
  const keysOf = () => extAttrGroups().flatMap(g => g.rows.map(r => r.key));
  // v51.6 追补：子弹速度已经从"展开更多"网格里整个删除（用户："子弹速度已经整合到
  // 攻击力窗口了，把属性界面遗留的子弹速度删掉"）——只留在攻击力的关联属性弹窗里，
  // 见下面 v51.6 那一节的 RELATED_STATS.attackDamage 断言。
  T('转②-子弹速度已从"展开更多"网格里删除（不再单独占格）', !keysOf().includes('bulletSpeed'));
  T('转③-所有单位类型"展开更多"的最后一格统一是移速', keysOf().includes('moveSpeed'));
}

// ==================== v51.6：关联属性弹窗 + 全能吸血改名 ====================
{
  // 用户原话给出的 3 组关联属性，逐一钉死
  T('关①-暴击率关联暴击伤害', RELATED_STATS.critChance?.includes('critDamagePct'));
  T('关②-全能吸血关联物理/法术吸血',
    RELATED_STATS.lifeStealPct?.includes('physicalVampPct') &&
    RELATED_STATS.lifeStealPct?.includes('spellVampPct'));
  T('关③-生命恢复关联基础生命恢复', RELATED_STATS.healthRegen?.includes('baseHealthRegenMod'));

  // 补充的 4 组也要有内容，且不能跟自己关联
  for (const k of ['abilityPower', 'attackDamage', 'armor', 'magicResist']) {
    const arr = RELATED_STATS[k];
    T(`关④-补充关联组「${k}」非空且不自指`, Array.isArray(arr) && arr.length > 0 && !arr.includes(k));
  }

  // _showStatDoc 要真正读取并渲染 RELATED_STATS
  const uiSrc = srcOf('src/ui/UIManager.js');
  T('关⑤-属性说明弹窗读取 RELATED_STATS[key]', /RELATED_STATS\[key\]/.test(uiSrc));
  T('关⑥-关联属性区块拼进弹窗正文', /\$\{live\}\$\{relatedHtml\}\$\{dmgType\}/.test(uiSrc));

  // 全能吸血改名：跨 4 处标签同步，且旧名不再作为「显示用」标签出现
  T('改①-fieldLabel 已改名', fieldLabel('lifeStealPct') === '全能吸血%');
  T('改②-statDoc 标签已改名', statDoc('lifeStealPct')?.label === '全能吸血%');
  const detailSrc = srcOf('src/ui/DetailModal.js');
  T('改③-DetailModal 标签表已改名', /lifeStealPct:\s*'全能吸血'/.test(detailSrc));
  const layoutSrc = srcOf('src/ui/statPanelLayout.js');
  T('改④-展开面板行标签已改名', /label:\s*'全能吸血%'/.test(layoutSrc));
}

// ==================== v51.6 Q4：带导航的窗口固定高度，不再随页面跳变 ====================
{
  const htmlSrc = srcOf('index.html');
  T('固①-侧边导航列固定高度（不再是 max-height 封顶）', /\.tpl-nav\s*\{[^}]*height:\s*58vh/.test(htmlSrc));
  T('固②-带导航窗口的内容区固定高度', /\.tpl-layout \.tpl-pane\s*\{\s*height:\s*58vh/.test(htmlSrc));
  // 不带导航的单页信息弹窗（详情框/属性说明）不受影响，仍按内容自适应封顶
  T('固③-不带导航的单页弹窗仍是 max-height 封顶（未被强行撑大）',
    /\.tpl-pane\s*\{[^}]*max-height:\s*58vh/.test(htmlSrc));
}

// ==================== v51.6：bug 修复——闪电杖/腐蚀型打人挨打不涨法力 ====================
// 用户："闪电杖攻击目标不会使目标的法力值增长。"根因：ManaSystem 只监听 _resolveHit
// （真正的"普通攻击"）发的 damage:dealt，闪电杖每跳、腐蚀型中毒 DOT 全部走
// performAttackDirect，从不发这个事件。不能直接用 options.basicAttack 判断——那个
// 字段被 BuffSystem 的 DOT 计时循环挪用表示"这一跳已经缩放过技能增幅，别再缩放"，
// 技能/龙魂的 DOT（毒药、灼烧圈）同样会带着 basicAttack:true 走到这里，如果拿它发
// 法力就等于技能能给自己回蓝，撞上"技能不该回蓝"的既有设计。所以新增一个含义单一
// 的 options.grantsMana，只有真正的【武器】拆分伤害（闪电杖 tick、腐蚀型中毒）才传。
{
  const { ents, fx, combat, bus, attr, SkillLibrary, CONFIG } = await world();
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const mana = new ManaSystem(ents, fx, bus, SkillLibrary, attr, combat);
  const bak = CONFIG.tuning?.mana ? { ...CONFIG.tuning.mana } : null;
  CONFIG.tuning = CONFIG.tuning || {};
  CONFIG.tuning.mana = { onAttack: 1, onHitTaken: 2 };

  const atk = mkEntity(ents, 'tower', {
    stats: { maxMana: 100, manaRegen: 0, manaStart: 0, attackDamage: 100, armor: 0, magicResist: 0 },
    skills: ['active_siege_haste'],   // 随便一个 category:'active' 的技能，让法力系统对它"真的生效"
  }, CONFIG);
  const tgt = mkEntity(ents, 'tower', {
    stats: { maxMana: 100, manaRegen: 0, manaStart: 0, maxHP: 100000, armor: 0, magicResist: 0 },
    skills: ['active_siege_haste'],
  }, CONFIG);

  T('法⑦-前提：普通伤害路径本来就会涨法力（_resolveHit 发的事件）', (() => {
    combat.performAttack(atk, tgt);
    return (atk._mana || 0) > 0 && (tgt._mana || 0) > 0;
  })());

  // 不传 grantsMana（等价于技能 DOT）：伤害照常结算，但不该涨法力
  atk._mana = 0; tgt._mana = 0;
  combat.performAttackDirect(atk.id, tgt.id, 50, 'magic', { basicAttack: true });
  T('法⑧-performAttackDirect 不传 grantsMana 时不涨法力（技能/龙魂 DOT 的口径）',
    (atk._mana || 0) === 0 && (tgt._mana || 0) === 0);

  // 传 grantsMana:true（闪电杖 tick / 腐蚀型中毒的口径）：双方都该涨法力
  atk._mana = 0; tgt._mana = 0;
  combat.performAttackDirect(atk.id, tgt.id, 50, 'magic', { basicAttack: true, grantsMana: true });
  T('法⑨-grantsMana:true 时攻守双方都涨法力（闪电杖/腐蚀型修复生效）',
    (atk._mana || 0) > 0 && (tgt._mana || 0) > 0);

  // ==================== bug 修复：闪电杖每跳各回一次完整攻击的法力（4倍超发）====================
  // 用户报："目前闪电杖每秒4跳造成伤害，正常应该是每秒算造成一次完整攻击，受击者
  // 回复2法力，但是目前每一跳（0.25s）都会回复2法力，正常是每跳回复2/4=0.5法力。"
  // 根因：grantsMana 发的 damage:dealt 事件没带 attackShare，ManaSystem 按"每次
  // 事件都是一次完整攻击"发放，于是一次攻击拆成的 4 跳变成 4 倍法力。
  atk._mana = 0; tgt._mana = 0;
  combat.performAttackDirect(atk.id, tgt.id, 50, 'magic', { basicAttack: true, grantsMana: true, attackShare: 0.25 });
  T(`法⑨b-attackShare:0.25 时法力只发 1/4（受击 ${tgt._mana}，期望 ${CONFIG.tuning.mana.onHitTaken * 0.25}）`,
    Math.abs((tgt._mana || 0) - CONFIG.tuning.mana.onHitTaken * 0.25) < 1e-9);
  T(`法⑨c-累计 4 跳（每跳 attackShare 0.25）等于一次完整攻击的法力`, (() => {
    atk._mana = 0; tgt._mana = 0;
    for (let i = 0; i < 4; i++) {
      combat.performAttackDirect(atk.id, tgt.id, 50, 'magic', { basicAttack: true, grantsMana: true, attackShare: 0.25 });
    }
    return Math.abs((tgt._mana || 0) - CONFIG.tuning.mana.onHitTaken) < 1e-9;
  })());
  T('法⑨d-不传 attackShare 时仍按一次完整攻击算（向后兼容，普通攻击路径不受影响）', (() => {
    atk._mana = 0; tgt._mana = 0;
    combat.performAttackDirect(atk.id, tgt.id, 50, 'magic', { basicAttack: true, grantsMana: true });
    return Math.abs((tgt._mana || 0) - CONFIG.tuning.mana.onHitTaken) < 1e-9;
  })());

  if (bak) CONFIG.tuning.mana = bak;
}
{
  const lw = srcOf('src/core/skills/weapons.js');
  T('法⑩-闪电杖每跳伤害传了 grantsMana:true',
    /basicAttack: true,\s*\n\s*\/\/[^\n]*\n\s*grantsMana: true,/.test(lw)
    || /grantsMana: true/.test(lw));
  const bs = srcOf('src/systems/BuffSystem.js');
  T('法⑪-DOT 计时循环按 blueprint.basicAttack 转发 grantsMana（不是无脑传 true）',
    (bs.match(/grantsMana: eff\.blueprint\.basicAttack === true/g) || []).length >= 2);
}

// ==================== v51.6：bug 修复——点击窗口外空白处不再意外关闭窗口 ====================
// 用户："打开窗口后点击周围空白地方，窗口就会消失（被关闭）。"
// 全仓库统一删除"点 overlay 背景关闭"这条监听——窗口只能通过明确的关闭/取消/确定
// 按钮关闭，不会因为鼠标点歪而意外丢失正在编辑的内容。
{
  const files = [
    'src/ui/DetailModal.js', 'src/ui/editor/shell.js', 'src/ui/editor/events.js',
    'src/ui/UnitAddDialog.js', 'src/ui/ModeDialog.js', 'src/ui/SettingsDialog.js', 'src/ui/UIManager.js',
  ];
  for (const f of files) {
    const src = srcOf(f);
    T(`关闭①-${f} 不再有"点背景关闭"监听`,
      !/e\.target === overlay\)/.test(src) && !/e\.target === modal\)/.test(src));
  }
}

// ==================== v51.6：bug 修复——缩放应以画面中心为锚点 ====================
// 用户："目前视角放大是聚焦于左上角进行放大的。正确放大应该是聚焦于窗口中心。"
// 从产品源码里把 _viewSize/_zoomAt 这两个纯逻辑方法借出来单独调用（同 sim_lightring
// 借出 _rangeRingStrength 的做法）——测的是产品代码本身，不是抄一份公式。
{
  const src = srcOf('src/ui/CanvasController.js');
  const mView = src.match(/_viewSize\(\) \{[\s\S]*?\n  \}/);
  const mZoom = src.match(/_zoomAt\(newZoom\) \{[\s\S]*?\n  \}/);
  T('能定位到 _viewSize/_zoomAt 实现', !!mView && !!mZoom);

  const makeCC = (W, H, zoom, offsetX, offsetY) => {
    const obj = { zoom, offsetX, offsetY, renderer: { width: W, height: H }, canvas: {} };
    obj._viewSize = new Function(`return function ${mView[0]}`)();
    obj._zoomAt = new Function(`return function ${mZoom[0]}`)();
    return obj;
  };

  // 画布中心对应的世界坐标：缩放前后必须是【同一个点】——这就是"以画面中心为锚点"。
  const cc = makeCC(1000, 800, 1.0, 0, 0);
  const worldAtCenter = (o) => ({
    x: (o.renderer.width / 2 - o.offsetX) / o.zoom,
    y: (o.renderer.height / 2 - o.offsetY) / o.zoom,
  });
  const before = worldAtCenter(cc);
  cc._zoomAt.call(cc, 2.0);
  const after = worldAtCenter(cc);
  T('缩①-放大后画面中心对应的世界坐标不变（不再朝左上角聚焦）',
    Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  T('缩②-zoom 确实变了（不是锚点算对了但缩放没生效）', cc.zoom === 2.0);

  // 已经平移过（offset 不为 0）之后再缩放，同一条不变量仍然成立
  const cc2 = makeCC(1200, 700, 1.5, 340, -180);
  const before2 = worldAtCenter(cc2);
  cc2._zoomAt.call(cc2, 0.6);
  const after2 = worldAtCenter(cc2);
  T('缩③-平移过之后再缩放，画面中心对应的世界坐标依旧不变',
    Math.abs(before2.x - after2.x) < 1e-9 && Math.abs(before2.y - after2.y) < 1e-9);

  T('缩④-缩放范围仍然钉在 0.15~3.0（没有被新逻辑放宽）', (() => {
    const cc3 = makeCC(800, 600, 1.0, 0, 0);
    cc3._zoomAt.call(cc3, 99);
    const cc4 = makeCC(800, 600, 1.0, 0, 0);
    cc4._zoomAt.call(cc4, -5);
    return cc3.zoom === 3.0 && cc4.zoom === 0.15;
  })());

  // 五个入口（滚轮/±按钮两个/滑杆/双指捏合）都要走 _zoomAt，不能有漏网的
  // "直接改 this.zoom、不配平 offset"的旧写法。
  T('缩⑤-滚轮/±按钮/滑杆/捏合五个入口都改走 _zoomAt',
    (src.match(/this\._zoomAt\(/g) || []).length === 5
    && !/this\.zoom = Math\.(max|min)\(0\.15, this\.zoom/.test(src));
}

// ==================== 追加：重置视角要重置整套状态 + fitToWorld 修正俯仰角带来的压缩 ====================
// 用户："重置视角点完之后，这个地图看起来还是很小。就是点完重置视角后根据窗口的大小
// 来自适应显示全部地图的缩放。并且缩放，视角角度，东南西北等所有的都重置，不光重置
// 缩放。"排查出两个根因：①resetViewBtn 原来只调 fitToWorld（只碰 zoom/offset），
// 俯仰角/方位角留着用户之前调的值没归位；②fitToWorld 的缩放公式本身没考虑世界 Z 轴
// 在当前俯仰角下会先乘 sin(elevationDeg) 才映射到屏幕像素，等于永远假装俯仰角是
// 90°（正俯视），实际能塞进屏幕的世界范围比算出来的更大，"全图适配"因此偏保守。
{
  const src = srcOf('src/ui/CanvasController.js');
  const mFit = src.match(/fitToWorld\(worldW, worldH\) \{[\s\S]*?\n  \}/);
  T('位①-能定位到 fitToWorld 实现', !!mFit);

  const makeCC = (W, H, elevationDeg) => {
    const obj = { zoom: 1, offsetX: 0, offsetY: 0, renderer: { width: W, height: H, elevationDeg, resize() {} } };
    obj.updateView = () => {};
    obj.fitToWorld = new Function(`return function ${mFit[0]}`)();
    return obj;
  };

  // 位②：90°（正俯视）时退化回"没有压缩"的原始公式——回归锚点，确认这条修正
  // 没有在基准情形（俯仰角=90°）下引入偏差。
  const cc90 = makeCC(1000, 800, 90);
  cc90.fitToWorld.call(cc90, 2000, 1500);
  const expected90 = Math.min(1000 / 2000, 800 / 1500) * 0.95;
  T('位②-俯仰角90°(正俯视)时 zoom 与"未修正前"的公式一致（sin(90°)=1，不引入偏差）',
    Math.abs(cc90.zoom - expected90) < 1e-9);

  // 位③：45°（默认视角）时，Z 轴方向能塞进屏幕的世界范围应该比"假装90°"算出来的更大，
  // 即修正后的 zoom 应该 ≥ 未修正的 zoom（新公式不应该比旧公式更保守）。
  // 用一个 worldW 很窄、worldH 很高的世界，让 Y 轴（世界 Z 深度）成为真正的限制项——
  // 上面 2000×1500 那组两条轴限制太接近，X 轴（0.5×0.95）比 Y 轴更紧，min() 恒取
  // X 轴，sinP 修正根本轮不到它生效，测不出这条修正有没有用。
  const worldWNarrow = 100, worldHTall = 1500;
  const expected90Tall = Math.min(1000 / worldWNarrow, 800 / worldHTall) * 0.95;
  const cc45 = makeCC(1000, 800, 45);
  cc45.fitToWorld.call(cc45, worldWNarrow, worldHTall);
  T('位③-俯仰角45°(默认)时，修正后的 zoom 比"假装90°"的旧公式更大（不再过度保守）',
    cc45.zoom > expected90Tall);
  // 数值精确核对：h 轴的限制应该是 h/(worldH*sin(45°))，不是 h/worldH
  const sin45 = Math.sin(45 * Math.PI / 180);
  const expected45 = Math.min(1000 / worldWNarrow, 800 / (worldHTall * sin45)) * 0.95;
  T('位④-45°下 zoom 精确等于 min(w/worldW, h/(worldH·sinP))·0.95', Math.abs(cc45.zoom - expected45) < 1e-9);

  // 位⑤：俯仰角很低（比如 12°，接近水平视角）时，压缩更严重，修正后的 zoom 应该更大，
  // 不能因为 sin(p) 趋近 0 而算出离谱的极端值（下限保护）。
  const cc12 = makeCC(1000, 800, 12);
  cc12.fitToWorld.call(cc12, 2000, 1500);
  T('位⑥-俯仰角很低时 zoom 依旧是有限正数（sinP 有下限保护，不会除出 Infinity/NaN）',
    Number.isFinite(cc12.zoom) && cc12.zoom > 0);

  // 位⑦：X 轴（offsetX）的推导本来就不含 sinP，这条断言确认修正没有连带碰坏它。
  T('位⑦-offsetX 的计算没有被这次修正牵连改动（X 轴本就不含 sinP 因子）',
    /this\.offsetX = \(w - worldW \* this\.zoom\) \/ 2;/.test(src));

  // 位⑧：resetViewBtn 点击时要把俯仰角/方位角都归位到出厂默认，再算适配缩放——
  // 不能只重置缩放。
  T('位⑧-重置视角按钮把俯仰角滑杆归位到 CAM_ELEVATION_DEG（出厂默认），不是留着用户调过的值',
    /elevSl\.value = String\(CAM_ELEVATION_DEG\)/.test(src) && /elevSl\.dispatchEvent\(new Event\('input'/.test(src));
  T('位⑨-重置视角按钮把方位角滑杆归位到 0（正北），不是留着用户调过的值',
    /azimSl\.value = '0'; azimSl\.dispatchEvent\(new Event\('input'/.test(src));
  T('位⑩-CAM_ELEVATION_DEG 是从 ThreeRenderer 导入的同一个值，不是另起一个可能漂移的硬编码 45',
    /import \{ CAM_ELEVATION_DEG \} from '\.\.\/presentation\/ThreeRenderer\.js';/.test(src));
}

// ==================== 追加：视角高度——"看的位置上下移，镜头角度不变" ====================
// 用户确认（AskUserQuestion 选项）："看的位置上下移（推荐）"——不是俯仰角（转角度），
// 不是镜头远近（正交摄像机下移动机位对成像没有视觉影响）。实现是把摄像机机位和
// 目标点沿世界 Y 轴同步平移同一个量，相对几何（夹角/距离）完全不变。
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('高①-setLookHeight 存在，范围钉在 ±250（塔身高度量级的几倍）',
    /setLookHeight\(h\) \{\s*\n\s*this\.lookHeightOffset = Math\.max\(-250, Math\.min\(250, Number\(h\) \|\| 0\)\);/.test(tr));
  T('高②-lookHeightOffset 在构造函数里初始化为 0（默认不引入任何变化，与改动前行为一致）',
    /this\.lookHeightOffset = 0;/.test(tr));
  T('高③-syncCameraFrom 里目标点的 Y 坐标改用 ly（不再恒为 0）',
    /const ly = this\.lookHeightOffset \|\| 0;\s*\n\s*this\._target\.set\(tx, ly, tz\);/.test(tr));
  T('高④-机位（cam.position）的 Y 分量也同步加了 ly——机位与目标点一起平移，不是只挪了目标点',
    /cam\.position\.set\(tx \+ CAM_DIST \* cosP \* sa, CAM_DIST \* sinP \+ ly, tz \+ CAM_DIST \* cosP \* ca\);/.test(tr));

  const mm = srcOf('src/main.js');
  T('高⑤-main.js 接线 lookHeightSlider，走 renderer3d.setLookHeight（与俯仰角/方位角同一套接线手法）',
    /CTX\.__setLookHeight = \(h\) => renderer3d \? renderer3d\.setLookHeight\(h\) : null;/.test(mm)
    && /document\.getElementById\('lookHeightSlider'\)/.test(mm));
  T('高⑥-lookHeightUpBtn/DownBtn 步进按钮也接了（统一四行控件的形状）',
    /lookHeightDownBtn/.test(mm) && /lookHeightUpBtn/.test(mm));

  const html = srcOf('index.html');
  T('高⑦-index.html 第四行视角高度控件是同一种【图标】【−】【滑杆】【+】【读数】形状',
    /<span class="ctl-name" title="视角高度">↕<\/span>[\s\S]{0,150}id="lookHeightDownBtn"[\s\S]{0,400}id="lookHeightSlider"[\s\S]{0,400}id="lookHeightUpBtn"[\s\S]{0,150}id="lookHeightLabel"/.test(html));

  const cc = srcOf('src/ui/CanvasController.js');
  T('高⑧-重置视角按钮把视角高度滑杆也归位到 0（"所有的都重置"覆盖到这条新滑杆，不是漏网之鱼）',
    /lookHeightSl\.value = '0'; lookHeightSl\.dispatchEvent\(new Event\('input'/.test(cc));
}

// ==================== 追加：右下角工具条做扁——按钮/行距单独收窄，不影响全局 .icon-btn ====================
// 用户："右下角工具条做的扁一些，目前右下角工具条的高度太高了。"三行控件用的是全局
// .icon-btn（30×30，给顶栏那种单行按钮条设计的尺寸），纵向堆三行就显得高。这里单独
// 给 #canvasControls 的按钮/行高/内边距一套更矮的尺寸，不碰全局 .icon-btn（顶栏右侧
// 单行场景仍需要 30×30 的点击热区）。
{
  const html = srcOf('index.html');
  const m = html.match(/#canvasControls \{[\s\S]*?\}/);
  T('扁①-#canvasControls 的内边距/行距比旧版收紧（7px 10px/gap 5px → 更小）',
    !!m && /padding: 6px 9px;/.test(m[0]) && /gap: 3px;/.test(m[0]));
  T('扁②-#canvasControls 单独给 .icon-btn 一套更小的尺寸（不动全局 30×30 的定义）',
    /#canvasControls \.icon-btn \{\s*\n\s*width: 20px; height: 20px;/.test(html));
  T('扁③-全局 .icon-btn 仍然是 30×30（顶栏右侧等其它场景没被这次改动误伤）',
    /\.icon-btn \{\s*\n\s*width: 30px; height: 30px;/.test(html));
}

// ==================== v51.6：属性弹窗再打磨 ====================
{
  const { CONFIG } = await import('../src/data/Config.js');
  T('磨①-子弹速度加入"攻击力"的关联属性', RELATED_STATS.attackDamage?.includes('bulletSpeed'));

  const uiSrc = srcOf('src/ui/UIManager.js');
  // 用户："所有属性点开的窗口描述里去除无用的描述，比如结算规则等，就保留最基础的
  // 描述就可以。" —— doc.formula（结算规则）与 doc.tip 两块都不再拼进弹窗正文。
  T('磨②-弹窗正文不再拼 doc.formula（结算规则）', !/doc\.formula \?/.test(uiSrc));
  T('磨③-弹窗正文不再拼 doc.tip', !/doc\.tip \?/.test(uiSrc));
  T('磨④-弹窗正文只剩 desc 这一句基础描述',
    /const body = `\$\{live\}\$\{relatedHtml\}\$\{dmgType\}\n\s*<p[^>]*>\$\{descText\}<\/p>`;/.test(uiSrc));

  // 暴击伤害：显示"当前总倍率"而不是加成量本身。用户举例：基准200%，+30% → 显示230%；
  // -50% → 显示150%。crit 那一档基准取的是 CombatSystem 结算时用的同一个
  // CONFIG.tuning.crit.baseCritDamagePct（默认200），不能另起一个写死的 200。
  T('磨⑤-暴击伤害换算成总倍率，基准取自 CONFIG.tuning.crit.baseCritDamagePct',
    /CONFIG\.tuning\?\.crit\?\.baseCritDamagePct \?\? 200/.test(uiSrc)
    && /const total = base \+ bonus;/.test(uiSrc));

  // 用实际数值验证磨⑤这条公式确实按用户给的例子走：基准200%，+30% → 230%；
  // 换个角度再钉一次 -50% → 150%，两个方向都要对。
  const critTotal = (bonus) => (CONFIG.tuning?.crit?.baseCritDamagePct ?? 200) + bonus;
  T('磨⑥-暴击伤害总倍率算对：基准200%+30% = 230%，基准200%-50% = 150%',
    critTotal(30) === 230 && critTotal(-50) === 150);

  // v51.6 追补：用户重新拍板——"属性面板上生命恢复显示实际生效值"这件事挪到
  // 主格（_effectiveHealthRegenHtml），公式仍是 regen×regenMod×healPowerOf 那一条，
  // 不能另写一份（否则面板和实际生效值对不上，是本仓库反复出过的那类事故）。
  // 关联属性区块里的【基础生命回复】（原 baseHealthRegenMod）改回单纯显示这个
  // 系数本身的百分比，不再混算成"实际生效值"——两件事现在分开显示。
  T('磨⑦-生命恢复面板主格走 regen×regenMod×healPowerOf 同一条公式',
    /const regenMod = entity\.baseStats\?\.baseHealthRegenMod \?\? 1;/.test(uiSrc)
    && /const healPower = Math\.max\(0, 1 \+ \(stats\.healShieldPowerPct \|\| 0\) \/ 100\);/.test(uiSrc)
    && /const effective = Math\.round\(regen \* regenMod \* healPower \* 100\) \/ 100;/.test(uiSrc));

  // 用实际数值验证磨⑦这条公式确实按用户给的例子走：基础生命恢复2，
  // 治疗与护盾强度-60% → healPower=0.4 → 实际 0.8/秒。
  const effRegen = (regen, regenMod, healShieldPowerPct) =>
    Math.round(regen * regenMod * Math.max(0, 1 + healShieldPowerPct / 100) * 100) / 100;
  T('磨⑧-生命恢复实际值算对：2×1×(1-60%) = 0.8', effRegen(2, 1, -60) === 0.8);

  T('磨⑨-关联属性区块的【基础生命回复】只显示系数本身的百分比，不再混算实际生效值',
    /const pct = Math\.round\(mod \* 1000\) \/ 10;/.test(uiSrc)
    && !/\/秒（实际生效值）/.test(uiSrc));
  T('磨⑩-baseHealthRegenMod 的说明标签已改名为"基础生命回复"',
    statDoc('baseHealthRegenMod')?.label === '基础生命回复');

  // 用户："属性面板每个属性占的空间太大了，优化一下，缩小一下空间。"
  const htmlSrc = srcOf('index.html');
  T('磨⑨-属性格子间距收紧（gap 6→4，padding 5px8px→3px6px）',
    /\.attrs, \.attrs-ext \{[^}]*gap: 4px/.test(htmlSrc)
    && /\.attrs \.a, \.attrs-ext \.a \{[\s\S]{0,80}padding: 3px 6px/.test(htmlSrc));
  T('磨⑩-属性数值字号收紧（14→12）',
    /\.attrs \.a > span:last-child, \.attrs-ext \.a > span:last-child \{[\s\S]{0,20}font-size: 12px/.test(htmlSrc));
}

// ==================== v51.6：攻城车攻城疲惫平衡调整 ====================
// 用户定稿："攻城车的攻城模式下每次攻击减少的攻速由7%调整为13%。并且恢复速率
// 降低至原先的75%。" 恢复速率 = recoverLayers/recoverSec，保持 recoverLayers=1
// 整数层不变，用 recoverSec 承担这个折扣（3÷0.75=4）。
{
  const { CONFIG } = await import('../src/data/Config.js');
  const R = CONFIG.gameRules.ram;
  T('城⑦-每次攻城攻击的攻速惩罚从 7% 调到 13%', R.fatiguePerAttack === 13 && R.fatigueLayerPct === -1);
  T('城⑧-恢复速率降到原先的75%（1层/3秒 → 1层/4秒）',
    R.recoverLayers === 1 && R.recoverSec === 4 && Math.abs((1 / 4) / (1 / 3) - 0.75) < 1e-9);
}

// ==================== v51.6：地图光环新增（扭曲丛林法力+法强 / 嚎哭深渊法力获取-50%）====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const bus2 = new EventBus();
  const ms = new MapSystem(ents, bus2);
  ms.setEffectRegistry(fx);

  ms.loadMap('twisted_treeline_v1');
  const tt = mkEntity(ents, 'siege', { stats: { maxMana: 100, manaRegen: 0, abilityPower: 0 }, skills: ['active_siege_haste'] }, CONFIG);
  ms.update(1);
  const ttStats = attr.calc(tt, fx.getEffects(tt.id));
  T('光①-扭曲丛林光环：所有单位被动法力值+1/s', Math.abs(ttStats.manaRegen - 1) < 1e-6);
  T('光②-扭曲丛林光环：所有单位法术强度+10', Math.abs(ttStats.abilityPower - 10) < 1e-6);

  ms.loadMap('howling_abyss_v1');
  const ha = mkEntity(ents, 'siege', { stats: { maxMana: 100, manaGainPct: 0 }, skills: ['active_siege_haste'] }, CONFIG);
  ms.update(1);
  const haStats = attr.calc(ha, fx.getEffects(ha.id));
  T('光③-嚎哭深渊光环：所有单位法力获取-50%', Math.abs(haStats.manaGainPct - (-50)) < 1e-6);
  T('光④-嚎哭深渊光环：治疗与护盾强度-80%仍然生效（没被这次改动挤掉）',
    Math.abs(haStats.healShieldPowerPct - (-80)) < 1e-6);
}
{
  // ManaSystem 真的按 manaGainPct 打折：攻击/受击获得的法力、被动回复都吃这一层。
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const mana = new ManaSystem(null, null, null, null, null, null);
  const e1 = { _mana: 0 };
  mana._addMana(e1, { maxMana: 100, manaGainPct: -50 }, 10);
  T('法⑫-manaGainPct=-50% 时 _addMana 只到账一半（10→5）', Math.abs(e1._mana - 5) < 1e-6);
  const e2 = { _mana: 0 };
  mana._addMana(e2, { maxMana: 100, manaGainPct: 0 }, 10);
  T('法⑬-manaGainPct=0 时 _addMana 照常到账全部（10→10）', Math.abs(e2._mana - 10) < 1e-6);
}

// ==================== v51.6：水晶枢纽基地光环重做 ====================
// 用户定稿："水晶枢纽的基地光环修改为：+2生命恢复，+2法力恢复，+5%移速，+20%伤害转化。"
{
  const { ents, fx, combat, attr, SkillLibrary, CONFIG } = await world();
  const nexus = mkEntity(ents, 'tower', { faction: 'blue', tier: 'nexus_main', pos: { x: 0, y: 0 } }, CONFIG);
  const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: { emit() {}, on() {} }, mapSystem: null, attrCalc: attr };
  const inst = { id: ++window._uid, skillId: 'passive_home_aura', state: {} };
  nexus._skillInstances.push(inst);
  const def = SkillLibrary.passive_home_aura;
  def.onEquip(nexus.id, inst, ctx);

  const minion = mkEntity(ents, 'melee', { faction: 'blue', lane: 'mid', pos: { x: 10, y: 0 },
    stats: { maxMana: 100 } }, CONFIG);
  // onFrame 内部按 0.5s 节流、半径首次计算时 mapSystem 不可用会退回 (maxD||180)+180 兜底，
  // 兜底半径远大于 minion 与 nexus 之间的 10 单位距离，圈内命中没有问题。
  def.onFrame(nexus.id, 1.0, inst, ctx);

  const s = attr.calc(minion, fx.getEffects(minion.id));
  T('基①-基地光环：+2生命恢复', Math.abs((s.healthRegen - CONFIG.templates.melee.healthRegen) - 2) < 1e-6);
  T('基②-基地光环：+2法力恢复', Math.abs(s.manaRegen - 2) < 1e-6);
  T('基③-基地光环：+5%移速', Math.abs(s.moveSpeed / CONFIG.templates.melee.moveSpeed - 1.05) < 1e-6);
  T('基④-基地光环：+20%伤害转化', Math.abs(s.damageConvertPct - 20) < 1e-6);
}

// ==================== bug 修复：模板编辑器"龙魂"tab 对大型小兵/地图塔不生效 ====================
// 用户报告："模板编辑器-龙魂设置窗口中设置的龙魂，在大型小兵中不生效，塔是正常生效的"。
// 根因：应用 tpl._templateSouls（"龙魂"tab 存的默认装备清单）这一步只在
// factories.js 的 createTower()（手动放置的单座塔）里实现了一次，createMinion()
// （小兵，含大型小兵）与 createBuilding()（真正用于对局的地图塔）两条创建路径
// 都没有对应的读取——尽管三者读的是同一个 CONFIG.templates[type] 对象。
// 用户能看到"塔正常生效"，大概率是通过 createTower 这条手动放置路径测试的；
// 大型小兵与地图上真正在打的塔，从始至终没读过这份配置。
{
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { createFactories } = await import('../src/core/factories.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mapSystem = { active: false, currentMap: null };
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem, dragonSystem: ds, uiManager: { log() {} },
  });

  const hasSoul = (e, id) => (e._skillInstances || []).some(s => s.skillId === id);

  // ①大型小兵（炮车）：createMinion 之前完全不读 _templateSouls。
  CONFIG.templates.siege._templateSouls = ['dragonsoul_fire'];
  const siege = F.createMinion('siege', 0, 0, 1, 1, { faction: 'blue', laneId: 'mid' });
  T('龙魂①-大型小兵（createMinion）现在能读到模板"龙魂"tab 的默认装备',
    hasSoul(siege, 'dragonsoul_fire'));
  delete CONFIG.templates.siege._templateSouls;

  // ②手动放置的塔（createTower）：修复前就能读到，这里钉住不回归。
  CONFIG.templates.tower._templateSouls = ['dragonsoul_water'];
  const placedTower = F.createTower(0, 0);
  T('龙魂②-手动放置的塔（createTower）仍然正常装备（不回归）',
    hasSoul(placedTower, 'dragonsoul_water'));

  // ③地图上真正的对局塔（createBuilding）：之前同样完全不读 _templateSouls。
  const mapTower = F.createBuilding({ faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 100, y: 100 } });
  T('龙魂③-对局地图塔（createBuilding）现在也能读到模板"龙魂"tab 的默认装备',
    hasSoul(mapTower, 'dragonsoul_water'));
  delete CONFIG.templates.tower._templateSouls;

  // ④近战/远程小兵不在 SOUL_REWARD_OK 范围内，但 _templateSouls 是"模板编辑器显式指定"，
  // 不经过 SOUL_REWARD_OK 那道口子（与 createTower 对普通塔一视同仁同理）——
  // 这里确认修复没有意外收紧成"只对大型小兵生效"，近战兵一样能被模板配置装上。
  CONFIG.templates.melee._templateSouls = ['dragonsoul_earth'];
  const melee = F.createMinion('melee', 0, 0, 1, 1, { faction: 'blue', laneId: 'mid' });
  T('龙魂④-模板显式装备不受 SOUL_REWARD_OK 限制（近战兵也能被模板配置装上）',
    hasSoul(melee, 'dragonsoul_earth'));
  delete CONFIG.templates.melee._templateSouls;
}

// ==================== v51.6：龙魂给的吸血类加成对塔削弱到 33% ====================
// 用户定稿："所有龙魂作用增加的吸血（物理/魔法/全能）对防御塔这种单位的数值
// 减少至33%。" 涉及三条魂：暗魂的全能吸血（lifeStealPct）、毒魂的法术吸血
// （spellVampPct）、血魂的物理吸血（常驻属性 physicalVampPct + "狂血"机制里
// 另一份全能吸血 lifeStealPct）。只削塔，大型小兵原样；巨龙之力（用户没点名）不受影响。
{
  const { ents, fx, attr, CONFIG, SkillLibrary } = await world();
  const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: { emit() {}, on() {} }, attrCalc: attr };
  const scalePct = CONFIG.dragonSouls.vampTowerScalePct ?? 33;
  const scaled = (v) => Math.round(v * scalePct) / 100;
  const equip = (entity, skillId) => {
    const inst = { id: ++window._uid, skillId, state: {} };
    entity._skillInstances.push(inst);
    SkillLibrary[skillId].onEquip(entity.id, inst, ctx);
    return inst;
  };

  // 暗魂：全能吸血常驻属性
  const towerDark = mkEntity(ents, 'tower', {}, CONFIG);
  const siegeDark = mkEntity(ents, 'siege', {}, CONFIG);
  equip(towerDark, 'dragonsoul_dark'); equip(siegeDark, 'dragonsoul_dark');
  // v51.11：dark 常驻加持已清零，lifeStealPct 可能不存在——用 || 0 兜底，
  // 缩放测试在"没有常驻加持"的情况下应该照样通过（0 缩放还是 0）。
  const darkFull = CONFIG.dragonSouls.stat.dark.lifeStealPct || 0;
  T(`吸①-暗魂全能吸血对塔削到${scalePct}%（期望 ${scaled(darkFull)}）`,
    Math.abs(attr.calc(towerDark, fx.getEffects(towerDark.id)).lifeStealPct - scaled(darkFull)) < 1e-6);
  T('吸②-暗魂全能吸血对大型小兵原样生效（不打折）',
    Math.abs(attr.calc(siegeDark, fx.getEffects(siegeDark.id)).lifeStealPct - darkFull) < 1e-6);

  // 毒魂：法术吸血常驻属性
  const towerPoison = mkEntity(ents, 'tower', {}, CONFIG);
  const siegePoison = mkEntity(ents, 'siege', {}, CONFIG);
  equip(towerPoison, 'dragonsoul_poison'); equip(siegePoison, 'dragonsoul_poison');
  const poisonFull = CONFIG.dragonSouls.stat.poison.spellVampPct || 0;
  T('吸③-毒魂法术吸血对塔削到33%',
    Math.abs(attr.calc(towerPoison, fx.getEffects(towerPoison.id)).spellVampPct - scaled(poisonFull)) < 1e-6);
  T('吸④-毒魂法术吸血对大型小兵原样生效',
    Math.abs(attr.calc(siegePoison, fx.getEffects(siegePoison.id)).spellVampPct - poisonFull) < 1e-6);

  // 血魂：物理吸血常驻属性
  const towerBlood = mkEntity(ents, 'tower', {}, CONFIG);
  const siegeBlood = mkEntity(ents, 'siege', {}, CONFIG);
  const towerBloodInst = equip(towerBlood, 'dragonsoul_blood');
  const siegeBloodInst = equip(siegeBlood, 'dragonsoul_blood');
  const bloodFull = CONFIG.dragonSouls.stat.blood.physicalVampPct || 0;
  T('吸⑤-血魂物理吸血常驻属性对塔削到33%',
    Math.abs(attr.calc(towerBlood, fx.getEffects(towerBlood.id)).physicalVampPct - scaled(bloodFull)) < 1e-6);
  T('吸⑥-血魂物理吸血常驻属性对大型小兵原样生效',
    Math.abs(attr.calc(siegeBlood, fx.getEffects(siegeBlood.id)).physicalVampPct - bloodFull) < 1e-6);

  // 血魂"狂血"机制（onFrame，残血触发）里的全能吸血——与上面的物理吸血是两个独立的键。
  towerBlood.currentHP = 1; towerBloodInst.state = {};
  SkillLibrary.dragonsoul_blood.onFrame(towerBlood.id, 0.1, towerBloodInst, ctx);
  const bloodVampFull = CONFIG.dragonSouls.blood.lifeStealPct ?? 10;
  T('吸⑦-血魂"狂血"机制的全能吸血对塔削到33%',
    Math.abs(attr.calc(towerBlood, fx.getEffects(towerBlood.id)).lifeStealPct - scaled(bloodVampFull)) < 1e-6);
  siegeBlood.currentHP = 1; siegeBloodInst.state = {};
  SkillLibrary.dragonsoul_blood.onFrame(siegeBlood.id, 0.1, siegeBloodInst, ctx);
  T('吸⑧-血魂"狂血"机制的全能吸血对大型小兵原样生效（不打折）',
    Math.abs(attr.calc(siegeBlood, fx.getEffects(siegeBlood.id)).lifeStealPct - bloodVampFull) < 1e-6);

  // 巨龙之力（用户点名的是"龙魂"，力不受这条规则影响）
  const { dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
  const lifeStealPowerBuff = dragonPowerBuffs('dark').find(b => b.statKey === 'lifeStealPct');
  T('吸⑨-巨龙之力（非龙魂）的暗之力全能吸血不受这条规则影响',
    !!lifeStealPowerBuff && lifeStealPowerBuff.flat === CONFIG.dragonPower.dark.lifeStealPct);
}

// ==================== v51.6：龙魂环——按元素配色 + 塔与大型小兵都显示 + 方形塔用方环 ====================
// 用户："获得龙魂的某一方，塔下面都会有光圈。这个光圈的颜色目前是不会变的，应该跟随
// 获得的不同种类龙魂而改变颜色。而且由于蓝方塔是方形的，导致下面显示的圈不完全，
// 你可以把蓝方的塔下面匹配轮廓而显示方形。并且所有获得龙魂的单位（包括小兵等）下面
// 都显示这个圈，自适应大小。注意是龙魂！并非巨龙之力！"
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  const { DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');

  T('环①-龙魂环颜色表按 DRAGON_ELEMENTS 的 color 构建（不是写死的金色）',
    /const SOUL_COLORS = \(\(\) => \{/.test(ul) && /m\[el\.soul\] = el\.color;/.test(ul));
  T('环②-远古之力（无元素归属）也配了颜色，不会落回默认金色',
    /m\.dragonsoul_ancient = '#e67e22';/.test(ul));
  T('环③-龙魂环走独立的 _syncSoulRing，不再挤在"仅活体塔"的 _syncTowerInfo 里',
    /_syncSoulRing\(e, en, vis, ghost, ruin\)/.test(ul)
    && !/_syncTowerInfo[\s\S]{0,2000}dragonsoul_/.test(ul));
  T('环④-尺寸走 vis.ringR（与选中光圈同一个"自适应单位大小"的值），不是写死的 32',
    /const r = vis\.ringR \|\| 12;/.test(ul));
  T('环⑤-默认都用圆环，只有蓝方阶梯方塔（outer/inner/base）才额外适配成方形环',
    /const isNexusTier = e\._mapTier === 'nexus_lane' \|\| e\._mapTier === 'nexus_main';/.test(ul)
    && /const square = e\.type === 'tower' && faction === 'blue' && !isNexusTier;/.test(ul)
    && /_flatGeo\(square \? 'squareRing' : 'ring', r, ringW\)/.test(ul));
  T('环⑤c-蓝方召唤水晶/水晶枢纽（圆形基座）被排除在方环之外，不会跟着阶梯方塔一起被套成方形',
    /!isNexusTier/.test(ul) && /e\._mapTier === 'nexus_lane' \|\| e\._mapTier === 'nexus_main'/.test(ul));
  T('环⑤b-环宽比选中光圈的核心环（2.5）细，两种含义不同的环能区分粗细（用户报"太粗了"）',
    /_flatGeo\(square \? 'squareRing' : 'ring', r, ringW\)/.test(ul)
    && /_flatGeo\('ring', r, 2\.5\)/.test(ul));
  T('环⑤d-追加需求：塔的龙魂环单独收小半径(×0.85)+加粗(2.0)，小兵维持原样(×1, 1.6)',
    /const isTowerRing = e\.type === 'tower';/.test(ul)
    && /const r = \(vis\.ringR \|\| 12\) \* \(isTowerRing \? 0\.85 : 1\);/.test(ul)
    && /const ringW = isTowerRing \? 2\.0 : 1\.6;/.test(ul));
  T('环⑥-幽灵/废墟/死亡单位不显示龙魂环', /if \(ghost \|\| ruin \|\| !e\.alive\)/.test(ul));
  // v51.6 修复：用户报"龙死了之后龙魂的颜色环残余在地面"，后来补充"不只是龙，
  // 其余单位的龙魂环也会残留"——根因是 remove(id)（单位被整个从 EntityContainer
  // 移除时的清理路径）只调了 _clearInfo，从没调过 _clearSoulRing；_syncSoulRing
  // 里那个"幽灵/废墟/死亡才清"的早退分支必须【那个实体还在被 _syncOne 同步】才会
  // 跑到——一旦整个被 remove() 摘掉（大多数单位死亡就是这样），那次清理永远不会发生。
  T('环⑧-remove(id) 会清理龙魂环，不能只指望 _syncSoulRing 的早退分支',
    /this\._clearInfo\(en\);[\s\S]{0,200}if \(en\.soul\) this\._clearSoulRing\(en\);[\s\S]{0,50}this\.map\.delete\(id\);/.test(ul));

  // ==================== Q20：蓝方塔方形龙魂环没有跟随塔的朝向旋转 ====================
  // 用户："蓝方塔的龙魂框依旧没有正确跟随塔的朝向。"根因：_syncSoulRing 只 set 了
  // position，从没写过 rotation——方框是直接在 XZ 平面里建的（_squareRingGeo 的头注），
  // rotation.y 就是绕竖直轴的偏航角，与 en.unit.rotation.y 用的是同一个量。
  // 塔的朝向早在 _syncOne 里算好并缓存在 en.faceFixed（同一份值，见"向⑫"那条断言），
  // 这里直接复用，不新算一份、也不新引入字段。圆环各向同性，赋不赋值肉眼看不出区别，
  // 所以直接对两种形状统一赋值，不必为方形单独分支。
  T('环⑨-龙魂环（含方形）跟随塔朝向：rotation.y 复用 en.faceFixed，且在每帧都重新赋值（不是只在新建时赋一次）',
    /en\.soul\.position\.set\(e\.pos\.x, RING_LIFT \+ en\.groundY, e\.pos\.y\);\s*\n[\s\S]{0,600}if \(en\.faceFixed !== null && en\.faceFixed !== undefined\) en\.soul\.rotation\.y = en\.faceFixed;/.test(ul));

  // 颜色表本身的行为：每种元素都能查到色值，且与 DRAGON_ELEMENTS 定义的颜色一致
  // （这里直接跑一遍构建函数体同款逻辑核对，不是又对着源码字符串猜）。
  const rebuilt = {};
  for (const el of Object.values(DRAGON_ELEMENTS)) rebuilt[el.soul] = el.color;
  T('环⑦-八条元素龙魂各自的颜色与 DRAGON_ELEMENTS 定义一致（抽样核对暗魂/血魂）',
    rebuilt.dragonsoul_dark === DRAGON_ELEMENTS.dark.color
    && rebuilt.dragonsoul_blood === DRAGON_ELEMENTS.blood.color);
}

// ==================== v51.6：Q9——状态详情弹窗改走天气弹窗那套网格样式 ====================
// 用户："状态窗口中属性变化那种我也想弄成天气窗口那种形式。"
{
  const { modsGridHtml, STAT_LABELS } = await import('../src/ui/DetailModal.js');
  T('状①-DetailModal 导出共用的 modsGridHtml，UIManager 直接委托它（不再各写一份）',
    typeof modsGridHtml === 'function'
    && /_modsGridHtml\(mods\) \{ return modsGridHtml\(mods\); \}/.test(srcOf('src/ui/UIManager.js')));
  T('状②-modsGridHtml 用 .a/.attrs 这套现成的网格 class（与天气/世界弹窗同一视觉语言）',
    /class="a"><label>\$\{label\}<\/label><span>\$\{parts\.join\(' '\)\}<\/span>/.test(srcOf('src/ui/DetailModal.js')));

  // 直接跑一遍 showEffectGroup 的核心逻辑，验证 kind:'stat' 的效果被折算进 mods
  // 而不再是逐行拼"　label：+10"这种纯文本。
  const fakeEff = (statKey, flat, percent, stackable = false, stacks = 1) => ({
    blueprint: { kind: 'stat', statKey, stackable }, totalFlat: flat, totalPercent: percent,
    stacks, remainingTime: Infinity, permanent: true,
  });
  const mods = {};
  for (const e of [fakeEff('attackDamage', 10, 0), fakeEff('armor', 0, 5)]) {
    const m = mods[e.blueprint.statKey] || (mods[e.blueprint.statKey] = { flat: 0, percent: 0 });
    m.flat += e.totalFlat || 0; m.percent += e.totalPercent || 0;
  }
  const grid = modsGridHtml(mods);
  T('状③-属性类效果折算进 mods 后能生成对应的网格行（标签走 STAT_LABELS 中文名）',
    grid.includes(STAT_LABELS.attackDamage) && grid.includes('+10')
    && grid.includes(STAT_LABELS.armor) && grid.includes('+5.0%'));
}

// ==================== v51.6：Q8——属性/技能/状态/天气/世界 tile 悬浮即预览 ====================
// 用户："鼠标移动到属性窗口的属性/技能/状态/天气等上面时，我想鼠标移到上面，就在鼠标
// 旁边显示出窗口，就是不需要再点开就能看了（目前点开查看也保留）。"
{
  const um = srcOf('src/ui/UIManager.js');
  const html = (await import('fs')).default.readFileSync('index.html', 'utf8');

  T('悬①-悬浮浮层的 CSS 存在且 pointer-events:none（否则挡住 mouseleave 判定，会卡住不消失）',
    /\.hover-tip \{[^}]*pointer-events:\s*none/.test(html));
  T('悬②-三个核心方法都存在（显示/跟随/隐藏）',
    /_showHoverTip\(html, x, y\) \{/.test(um) && /_positionHoverTip\(x, y\) \{/.test(um) && /_hideHoverTip\(\) \{/.test(um));
  T('悬③-属性行用 mouseover/mouseout（会冒泡）而非 mouseenter/mouseleave，才能走事件委托（属性行每帧重建，逐行绑定会随旧节点一起丢失——技能栏/效果栏当年就是这个坑）',
    /selCard\.addEventListener\('mouseover', \(e\) => \{[\s\S]{0,300}_hoverBodyForStat/.test(um));
  T('悬④-点击查看依旧保留（悬浮预览是新增，不是替换）',
    /selCard\.addEventListener\('click', \(e\) => \{[\s\S]{0,300}_showStatDoc/.test(um));
  T('悬⑤-技能格/状态格的悬浮预览与点击共用同一份查找逻辑（inst/def、effName/group 的取法一致），不是另起一套',
    /const inst = unit\?\._skillInstances\?\.find\(s => s\.id === skillId\);[\s\S]{0,120}_hoverBodyForSkill/.test(um)
    && /group\.length\) this\._hoverBodyForEffect|group\.length\) this\._showHoverTip\(this\._hoverBodyForEffect/.test(um));
  T('悬⑥-天气行/世界行的悬浮预览直接复用点击弹窗同一份 body 构建函数（_weatherDetailBody/_worldDetailBody），不是重新拼一份文案',
    /_showHoverTip\(this\._worldDetailBody\(row\)/.test(um) && /_showHoverTip\(this\._weatherDetailBody\(row\)/.test(um));

  // 真的跑一遍：三个 _hoverBodyForXxx 在没有真实 DOM 的情况下也能拼出内容
  // （不依赖 document，只依赖 this.attrCalc / this.effects / statDoc，用假 this 直接调）。
  const { UIManager } = await import('../src/ui/UIManager.js').catch(() => ({}));
  if (UIManager) {
    const { ents, fx, attr, CONFIG } = await world();
    const t = mkEntity(ents, 'tower', { stats: { attackDamage: 152 } }, CONFIG);
    const ui = Object.create(UIManager.prototype);
    ui.attrCalc = attr; ui.effects = fx; ui.entities = ents;
    const statHtml = ui._hoverBodyForStat('attackDamage', t);
    T('悬⑦-_hoverBodyForStat 能拼出属性名+当前值+基础描述，不依赖 DOM', statHtml.includes(statDoc('attackDamage').label) && statHtml.length > 20);

    const effHtml = ui._hoverBodyForEffect('测试效果', [{ blueprint: { kind: 'stat', statKey: 'armor', icon: '🛡' }, totalFlat: 10, totalPercent: 0 }]);
    T('悬⑧-_hoverBodyForEffect 与 DetailModal.showEffectGroup 同款折算逻辑，效果名+属性名都在', effHtml.includes('测试效果') && effHtml.includes('+10'));
    T('悬⑧b-悬浮预览标题图标用 blueprint.icon，不再写死📌（用户报"图标和技能栏/状态栏不匹配"）', effHtml.includes('🛡'));
    // v51.6（Q13）：dot/stun/display 这类"不是属性数值"的效果，用户报悬浮预览之前只看
    // 属性变化网格、把这些文字说明漏掉了——现在应与 showEffectGroup 一样带出说明文字。
    const dotHtml = ui._hoverBodyForEffect('持续伤害效果', [{ blueprint: { kind: 'dot', damageType: 'magic' }, totalFlat: 0, totalPercent: 0 }]);
    T('悬⑨-dot 类效果的悬浮预览带出"持续伤害"文字说明，不是只看 mods 网格', dotHtml.includes('持续伤害'));
    const emptyHtml = ui._hoverBodyForEffect('空效果', [{ blueprint: { kind: 'stat', statKey: 'armor' }, totalFlat: 0, totalPercent: 0 }]);
    T('悬⑩-真正没有任何属性变化/文字说明时才显示"无属性变化"兜底，不留空白', emptyHtml.includes('无属性变化'));
  }
}

// ==================== v51.6：Q10——技能描述换行修复 + 口水词/简写/英文残留审查 ====================
// 用户："目前两个被动之间是连着显示的，应该是每个被动是单独一行……并且我看还有些属性
// 是英文显示的，应该改成中文……属性的描述绝对不允许简写！一定要描述全称！"
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');

  // ---- 换行：合并展示的身份技能，两条被动之间要有真正的换行，不是粘在一起 ----
  T('文①-mergedDescription/renderSkillDescription 合并多条子技能文案时用 \\n 分隔（不再是连着显示）',
    /\.join\('\\n'\)/.test(srcOf('src/core/skills/_helpers.js')));
  T('文②-实际跑一遍：枢纽塔身份技能的两条被动文案之间真的有换行符',
    SkillLibrary.core_tier_hq.description.includes('\n')
    && SkillLibrary.core_tier_hq.description.split('\n').length === 2);

  // ---- 英文残留：扫全部技能的 description/descTemplate，不该有游戏内文字用英文字段名 ----
  {
    let leaks = 0;
    for (const def of Object.values(SkillLibrary)) {
      for (const field of ['description', 'descTemplate']) {
        let v; try { v = def[field]; } catch (e) { continue; }
        if (typeof v !== 'string') continue;
        // {val}/{amp}/{dr}/{blue}/{red} 这类占位符会在渲染时被替换成数值，不算残留；
        // 排除掉花括号占位符本身以后，正文里不该再剩任何英文单词。
        const stripped = v.replace(/\{[a-zA-Z_]+\}/g, '');
        if (/[A-Za-z]{2,}/.test(stripped)) leaks++;
      }
    }
    T('文③-全部技能文案扫描不到英文属性字段名残留（此前雷魂/风魂/霜魂/钢魂/血魂/熔魂/星魂/蚀魂的"常驻加持"都漏了翻译）',
      leaks === 0);
  }

  // ---- 简写：magicPenFlat 与它的同族 armorPenFlat 用词对称，不再一个全称一个简写 ----
  const dm = srcOf('src/ui/DetailModal.js');
  const spl = srcOf('src/ui/statPanelLayout.js');
  T('文④-DetailModal.STAT_LABELS 里 magicPenFlat 不再是简写"固定法穿"（与 armorPenFlat 的"固定护甲穿透"对称）',
    /magicPenFlat: '固定法术穿透'/.test(dm) && !/固定法穿'/.test(dm));
  T('文⑤-属性面板"穿透"组同一处也已同步改成全称（这是玩家真正看到的那一份，不只是弹窗里的表）',
    /armorPenFlat', label: '固定护甲穿透'/.test(spl) && !/固定穿甲/.test(spl));
  T('文⑥-防御塔镀层描述里的 "HP" 已改成中文"生命值"', /生命值跌破80%/.test(srcOf('src/core/skills/towerPassives.js')));

  // ---- 一致性：（数值=公式）这个括号形状要统一，不能有的技能漏了括号 ----
  {
    let bad = 0;
    for (const def of Object.values(SkillLibrary)) {
      const t = def.descTemplate;
      if (typeof t !== 'string') continue;
      const re = /(.)\{[a-zA-Z_]+\}=/g;
      let m;
      while ((m = re.exec(t))) { if (m[1] !== '（') bad++; }
    }
    T('文⑦-所有"{val}=公式"都统一包在圆括号里（山魂此前漏了括号，没有 entity 上下文时会显示成"山魂：0=6%伤害减免…"这种读不懂的文字）',
      bad === 0);
  }

  // ---- LoL 式颜色标注 + 简洁/详细切换（message G）----
  const { formatSkillFormulasHtml, getSkillDescMode, setSkillDescMode, STAT_COLORS, STAT_LABELS } = await import('../src/ui/DetailModal.js');
  T('文⑧-颜色表只认已有属性（STAT_COLORS 的键都是 STAT_LABELS 里已经有的属性名，不是新造的）',
    Object.keys(STAT_COLORS).every(k => k in STAT_LABELS));
  const sample = '（38=3+护甲×7%+法术强度×50%）';
  const detailHtml = formatSkillFormulasHtml(sample, { concise: false });
  const conciseHtml = formatSkillFormulasHtml(sample, { concise: true });
  T('文⑨-详细模式：公式里认得出的属性按专属颜色标出（护甲=皮革色、法术强度=紫色），数字/运算符不受影响',
    detailHtml.includes(`color:${STAT_COLORS.armor}`) && detailHtml.includes(`color:${STAT_COLORS.abilityPower}`)
    && detailHtml.includes('38') && detailHtml.includes('×7%'));
  T('文⑩-简洁模式：整个公式连括号一起吞掉，只留最终数值', conciseHtml === '38');
  T('文⑪-简洁/详细的选择是模块级状态，弹窗与悬浮预览共用同一份（切一次两处都变）',
    (() => { setSkillDescMode('concise'); const m = getSkillDescMode(); setSkillDescMode('detail'); return m === 'concise' && getSkillDescMode() === 'detail'; })());
  T('文⑫-UIManager 的悬浮预览复用同一份颜色/简洁-详细/常驻加持网格渲染（skillDescHtmlParts），不是另起一套文案逻辑',
    /skillDescHtmlParts\(def, desc, \{ concise: getSkillDescMode\(\) === 'concise' \}\)/.test(srcOf('src/ui/UIManager.js')));
}

// ==================== 补充批次三：Q15（龙魂常驻加持改走统一网格块） ====================
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { skillDescHtmlParts } = await import('../src/ui/DetailModal.js');
  const { soulStatMods } = await import('../src/core/skills/dragonSouls.js');

  T('补⑪-soulStatMods 与真正挂给实体的效果（soulStatBlueprints）同一套 statMod() 翻译规则，不是另起一份换算',
    /export function soulStatMods\(el\)/.test(srcOf('src/core/skills/dragonSouls.js'))
    && /const m = statMod\(k, v\);/.test(srcOf('src/core/skills/dragonSouls.js')));

  const def = SkillLibrary.dragonsoul_earth;
  const r = skillDescHtmlParts(def, def.description, { concise: false });
  T('补⑫-山魂的常驻加持（护甲+8/魔法抗性+8/最大生命+6%）从文字尾巴换成了网格块，正文里不再重复这句话',
    !r.textHtml.includes('常驻加持') && r.gridHtml.includes('护甲') && r.gridHtml.includes('+8.0') && r.gridHtml.includes('魔法抗性'));

  T('补⑬-非龙魂技能（没有常驻加持）不受影响，gridHtml 为空、正文原样',
    (() => {
      const d2 = SkillLibrary.weapon_piercing;
      const r2 = skillDescHtmlParts(d2, d2.description, { concise: false });
      return r2.gridHtml === '' && r2.textHtml.includes('升温');
    })());

  T('补⑭-description/descTemplate 原始字符串本身不受影响（sim_skilldesc.mjs 靠文本核对数值，不能动这份源数据）',
    SkillLibrary.dragonsoul_earth.description.includes('常驻加持'));

  const mods = soulStatMods('earth');
  T('补⑮-soulStatMods 的键就是 STAT_LABELS 里的已有属性名（armor/magicResist/maxHP），没有新造属性',
    'armor' in mods && 'magicResist' in mods && 'maxHP' in mods);
}

// ==================== 补充批次二：Q1/Q3/Q5-Q14（截图追加） ====================
// 用户给了新一批截图追加的问题：悬浮白框、暴击/魔抗描述、穿透型换行、简洁详细按钮合并、
// 弹窗自适应、龙之力百分比、弹窗毛玻璃、天气进度条、阵亡悬浮框未消失、悬浮图标不匹配、
// 龙魂环残留与太粗、状态悬浮丢文字说明。
{
  const um = srcOf('src/ui/UIManager.js');
  const wp = srcOf('src/ui/WeatherPanel.js');
  const html = srcOf('index.html');

  T('补①-技能格/属性行/天气三角/世界三角都不再挂原生 title（Q1：悬浮预览与浏览器原生提示框重叠出现白框）',
    !/data-skill-id="\$\{inst\.id\}" title=/.test(um)
    && !/data-stat="\$\{key\}" title=/.test(um)
    && !/data-worldidx="\$\{i\}" title=/.test(um)
    && !/data-wxid="\$\{r\.def\.id\}"[\s\S]{0,20}title=/.test(um));

  T('补②-暴击率描述不再有"纯机械单位"这句（Q2）',
    !/纯机械单位，没有来源加成就不会暴击/.test(srcOf('src/data/statDocs.js')));

  T('补③-魔法抗性：statDocs 不再有"真实伤害不受任何抗性影响"，标签改成全称（Q3a）',
    !/真实伤害不受任何抗性影响/.test(srcOf('src/data/statDocs.js'))
    && /magicResist: '魔法抗性'/.test(srcOf('src/ui/DetailModal.js'))
    && /key: 'magicResist', label: '魔法抗性'/.test(srcOf('src/ui/statPanelLayout.js')));

  T('补④-穿透型子弹描述真正换行、不再是"固定30%双穿"（Q3b）',
    (() => {
      const w = srcOf('src/core/skills/weapons.js');
      return /升温[\s\S]{0,300}\\n唯一被动——穿透/.test(w) && !/固定30%双穿/.test(w) && /\+30%护甲穿透，\+30%法术穿透/.test(w);
    })());

  T('补⑤-简洁/详细合并成一个按钮（不再是两颗），文字就是当前模式，点一下切到另一个（Q5）',
    (() => {
      const dm = srcOf('src/ui/DetailModal.js');
      return /id="skillModeToggle" class="skill-mode-toggle-single"/.test(dm)
        && !/id="skillModeToggle"[\s\S]{0,300}id="skillModeToggle"/.test(dm) // 只有一个按钮节点，不是两个
        && /const next = btn\.dataset\.mode === 'concise' \? 'detail' : 'concise';/.test(dm);
    })());
  T('补⑤b-切换按钮塞进 footerExtra、用 margin-right:auto 推到左边，不挤在"关闭"右边（Q5：位置改到左下角）',
    /const footerExtra = `<button id="skillModeToggle" class="skill-mode-toggle-single" style="margin-right:auto;"/.test(srcOf('src/ui/DetailModal.js'))
    && /footer: `<div class="modal-actions">\$\{opts\.footerExtra \|\| ''\}<button id="detailCloseBtn"/.test(srcOf('src/ui/DetailModal.js')));

  {
    const ds = srcOf('src/ui/dialogShell.js');
    const html = (await import('fs')).default.readFileSync('index.html', 'utf8');
    T('补⑥-无侧边栏的单页弹窗（技能详情等）自动加 .compact，按 hasNav 判断，不用每个调用点各传参（Q6）',
      /const compact = groups\.length === 0 \? ' compact' : '';/.test(ds)
      && /class="modal-box\$\{compact\}"/.test(ds));
    T('补⑥b-.compact 按内容自适应宽度（fit-content），同时有最小尺寸兜底，不会缩成一个挤扁的小方块',
      /\.modal-box\.compact \{ width: fit-content; min-width: 320px; min-height: 120px; \}/.test(html));
  }
  // 直接跑一遍 shellHtml，核对"有 groups 就不加 .compact，没有就加"这条判据本身。
  {
    const { shellHtml } = await import('../src/ui/dialogShell.js');
    const withNav = shellHtml({ title: 't', body: 'b', groups: [{ title: '', items: [{ key: 'a', label: 'A' }] }], activeKey: 'a' });
    const withoutNav = shellHtml({ title: 't', body: 'b' });
    T('补⑥d-真的跑一遍 shellHtml：有 groups 的弹窗（编辑器）不带 .compact', /class="modal-box"/.test(withNav) && !withNav.includes('compact'));
    T('补⑥e-真的跑一遍 shellHtml：没有 groups 的单页弹窗（技能详情等）带 .compact', /class="modal-box compact"/.test(withoutNav));
  }

  T('补⑦-modsGridHtml 对百分比量纲的属性（如 bonusAttackSpeedPct）flat 增量也带 %（Q7）',
    /PERCENT_UNIT_KEYS\.has\(k\) \? '%' : ''/.test(srcOf('src/ui/DetailModal.js')));
  T('补⑦b-attackSpeedRatio/damageBlock/damageConvertPct/bulletSpeed 补齐中文标签，不再原样显示英文键名（Q7）',
    /attackSpeedRatio: '攻速系数', damageBlock: '格挡值'/.test(srcOf('src/ui/DetailModal.js'))
    && /damageConvertPct: '伤害转化', bulletSpeed: '子弹速度'/.test(srcOf('src/ui/DetailModal.js')));

  // Q8 用户澄清："我指的是这个小窗口"（悬浮预览截图）——.hover-tip 原来是接近不透明的
  // 纯色卡片、完全没有 backdrop-filter，跟弹窗（.modal-box 本来就有 blur）是两回事。
  T('补⑧-悬浮预览（.hover-tip）补上半透明背景 + backdrop-filter，不再是纯色实底小卡片（Q8）',
    (() => {
      const m = html.match(/\.hover-tip \{[\s\S]*?\}/);
      return !!m && /backdrop-filter:\s*blur/.test(m[0]) && /rgba\(22,27,34,0\.6\)/.test(m[0]);
    })());
  T('补⑧b-弹窗（.modal-box）的暗色 tint 调淡，让更多背景色透出来给 blur 处理，不是叠两层暗色吃光颜色',
    /rgba\(22,27,34,0\.55\)/.test(html) && /rgba\(4,6,9,0\.45\)/.test(html));

  T('补⑨-天气"实时与预报"列表改用圆角发光条，不再是 █/░ 手搓字符条（Q9）',
    !/'█'\.repeat/.test(wp) && !/'░'\.repeat/.test(wp) && /box-shadow:0 0 6px \$\{def\.color\}80/.test(wp));

  T('补⑩-clearSelection 会一并隐藏悬浮预览（Q10：单位阵亡后属性面板关闭但悬浮框残留）',
    /clearSelection\(\) \{[\s\S]{0,400}this\._hideHoverTip\(\);/.test(um));

  // ==================== Q18：毛玻璃效果统一到全部界面 ====================
  // 用户："毛玻璃效果要统一到所有窗口，所有界面上，目前主界面四个角的工具条，
  // 单位属性窗口等都没有应用这个效果。"——技术上 .hud-panel/#selectionPanel 本来
  // 就有 backdrop-filter，但用的是旧的纯色 var(--surface)，跟后来给 .modal-box/
  // .hover-tip 定下的"渐变高光 + rgba(22,27,34,0.6) 更透底色"是两种质感，肉眼看
  // 就是没效果。这里统一成与 .hover-tip 完全相同的配方（同一档 blur(14px)）。
  const hudPanelBlock = html.match(/\.hud-panel \{[\s\S]*?\}/);
  T('毛①-四角工具条（.hud-panel：顶栏左/右、右下工具栏、右上世界小窗共用）改用与悬浮预览/弹窗同款玻璃配方',
    !!hudPanelBlock && /rgba\(22,27,34,0\.6\)/.test(hudPanelBlock[0])
    && /linear-gradient\(180deg, rgba\(255,255,255,0\.06\), rgba\(255,255,255,0\) 50%\)/.test(hudPanelBlock[0])
    && /backdrop-filter:\s*blur\(14px\)/.test(hudPanelBlock[0]));
  const selectionPanelBlock = html.match(/#selectionPanel \{[\s\S]*?\}/);
  T('毛②-单位属性窗口（#selectionPanel）同样改用这份配方，不再是更不透明的旧版 var(--surface)',
    !!selectionPanelBlock && /rgba\(22,27,34,0\.6\)/.test(selectionPanelBlock[0])
    && /linear-gradient\(180deg, rgba\(255,255,255,0\.06\), rgba\(255,255,255,0\) 50%\)/.test(selectionPanelBlock[0])
    && !/background: var\(--surface\);/.test(selectionPanelBlock[0]));
  T('毛③-四块浮层与属性窗口用的是完全相同的一份配方（同一份字符串出现 3 次：hud-panel + selectionPanel，不是各改各的凑数）',
    (html.match(/linear-gradient\(180deg, rgba\(255,255,255,0\.06\), rgba\(255,255,255,0\) 50%\), rgba\(22,27,34,0\.6\)/g) || []).length >= 3);
}

// ==================== 护盾三分类：新增"护盾"（不衰减不回复）====================
// 用户定稿：临时护盾（衰减）/固定护盾（脱战回满）/护盾（不衰减不回复，随所属效果
// 自然到期一起消失，被打空不提前结束效果）。承伤顺序①临时②固定③护盾。
{
  const { ents, fx, combat, CONFIG } = await world();
  const target = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  // 盾①：创建即满值 —— shieldRemaining = flatValue（首次 delta = totalFlat - 0）
  fx.apply(target.id, { name: '测试护盾', icon: '🛡', kind: 'shield', flatValue: 100,
    duration: 5, stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'test_shield');
  let eff = fx.getEffects(target.id).find(e => e.blueprint.name === '测试护盾');
  T('盾①-新建 kind:\'shield\' 效果，shieldRemaining 等于 flatValue（满值）', eff.shieldRemaining === 100);

  // 盾②：承伤后 shieldRemaining 减少，且优先级在临时/固定护盾之后
  const before = target.currentHP;
  combat.performAttackDirect(null, target.id, 30, 'physical');
  eff = fx.getEffects(target.id).find(e => e.blueprint.name === '测试护盾');
  T('盾②-护盾吸收伤害后 shieldRemaining 减少，生命值不掉（没有临时/固定护盾时护盾顶上）',
    eff.shieldRemaining < 100 && target.currentHP === before);

  // 盾③：refresh（同 stackKey 再次 apply）不会把 shieldRemaining 顶回满——这正是
  // 用户报"钢铁烈阳护盾/图腾壁垒太强"的根子（旧版固定护盾会在 refresh 时回满）。
  const remainingBeforeRefresh = eff.shieldRemaining;
  fx.apply(target.id, { name: '测试护盾', icon: '🛡', kind: 'shield', flatValue: 100,
    duration: 5, stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'test_shield');
  eff = fx.getEffects(target.id).find(e => e.blueprint.name === '测试护盾');
  T('盾③-refresh 不会把 shieldRemaining 顶回满（"护盾"不会自动回复，这是与固定护盾的关键区别）',
    eff.shieldRemaining === remainingBeforeRefresh && eff.remainingTime > 0);

  // 盾④：承伤顺序——临时护盾①、固定护盾②、护盾③依次吃伤害
  const t2 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000, shieldFixedMax: 20 } }, CONFIG);
  t2.tempShield = 10; t2.shieldFixedCurrent = 20;
  fx.apply(t2.id, { name: '测试护盾2', icon: '🛡', kind: 'shield', flatValue: 50,
    duration: 5, stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'test_shield2');
  combat.performAttackDirect(null, t2.id, 15, 'physical');   // 应先吃光 10 点临时护盾，再吃 5 点固定护盾
  const eff2 = fx.getEffects(t2.id).find(e => e.blueprint.name === '测试护盾2');
  T('盾④-承伤顺序 临时→固定→护盾：15 点伤害先吃光 10 点临时护盾，再吃 5 点固定护盾，护盾（50）完全没动',
    t2.tempShield === 0 && t2.shieldFixedCurrent === 15 && eff2.shieldRemaining === 50);

  // 盾⑤：被打空后效果本身不提前结束（remainingTime 照常倒计时，不会因为 shieldRemaining=0 被强制移除）
  const t3 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  fx.apply(t3.id, { name: '测试护盾3', icon: '🛡', kind: 'shield', flatValue: 5,
    duration: 10, stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'test_shield3');
  combat.performAttackDirect(null, t3.id, 50, 'physical');   // 5 点护盾一下打空，剩余 45 点该扣到生命值上
  const eff3 = fx.getEffects(t3.id).find(e => e.blueprint.name === '测试护盾3');
  T('盾⑤-护盾被打空后效果依然存在（不会因为余量归零就提前移除，直到自己的 duration 到期）',
    !!eff3 && eff3.shieldRemaining === 0 && eff3.remainingTime > 0);

  // 盾⑥：效果自然到期后随之消失，不会有"补偿伤害"或残留
  const t4 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  fx.apply(t4.id, { name: '测试护盾4', icon: '🛡', kind: 'shield', flatValue: 30,
    duration: 0.1, stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'test_shield4');
  const hpBeforeExpire = t4.currentHP;
  fx.update(0.2);   // 超过 duration，效果到期移除
  T('盾⑥-效果自然到期后随之消失，剩余护盾直接消失、不倒扣生命值（不会有"补偿伤害"）',
    !fx.getEffects(t4.id).some(e => e.blueprint.name === '测试护盾4') && t4.currentHP === hpBeforeExpire);

  // 盾⑦：stackPolicy:'stack' 叠层时，新层的量会加进 shieldRemaining（追加护盾，不是刷新覆盖）
  const t5 = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  fx.apply(t5.id, { name: '测试护盾5', icon: '🛡', kind: 'shield', flatValue: 20, perStackFlat: 20, maxStacks: 3,
    duration: 5, stackable: true, stackPolicy: 'stack' }, 'test_shield5');
  combat.performAttackDirect(null, t5.id, 12, 'physical');   // 消耗到剩 8
  fx.apply(t5.id, { name: '测试护盾5', icon: '🛡', kind: 'shield', flatValue: 20, perStackFlat: 20, maxStacks: 3,
    duration: 5, stackable: true, stackPolicy: 'stack' }, 'test_shield5');   // 叠一层，+20
  const eff5 = fx.getEffects(t5.id).find(e => e.blueprint.name === '测试护盾5');
  T('盾⑦-stack 叠层追加护盾量（8 + 新层 20 = 28），不是刷新覆盖成 20', eff5.shieldRemaining === 28);
}

// EffectRegistry.plainShieldOf 汇总 + CombatSystem 缓存进 entity.plainShield
{
  const { ents, fx, combat, CONFIG } = await world();
  const t = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);
  fx.apply(t.id, { name: '护盾A', kind: 'shield', flatValue: 15, duration: 5,
    stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'shieldA');
  fx.apply(t.id, { name: '护盾B', kind: 'shield', flatValue: 25, duration: 5,
    stackable: false, stackPolicy: 'refresh', uniquePassive: true }, 'shieldB');
  T('盾⑧-plainShieldOf 把该实体身上所有 kind:\'shield\' 效果的余量加总', fx.plainShieldOf(t.id) === 40);
  combat.update(1 / 30);
  T('盾⑨-CombatSystem 每帧把汇总值缓存进 entity.plainShield（UI/血条读这个缓存字段）', t.plainShield === 40);
}

// 源码断言：两条被转换的技能不再挂 shieldFixedMax，改挂 kind:'shield'
{
  const tp = srcOf('src/core/skills/towerPassives.js');
  const mp = srcOf('src/core/skills/minionPassives.js');
  T('盾⑩-钢铁烈阳护盾（passive_inner_bulwark）自身那份改挂 kind:\'shield\'',
    /name: '钢铁烈阳护盾', icon: '☀️', kind: 'shield', flatValue: selfPlain,/.test(tp));
  // v51.9：用户对 v51.6 那次决定又改了主意——"图腾兵给自己加900护盾的技能，那个
  // 应该是固定护盾，你改错成护盾了"。改回 kind:'stat'+statKey:'shieldFixedMax'。
  T('盾⑪-图腾壁垒（passive_totem_bulwark）v51.9 改回 kind:\'stat\'/shieldFixedMax（用户重新定稿）',
    /kind: 'stat', statKey: 'shieldFixedMax',\s*\n\s*flatValue: v,/.test(mp));
  T('盾⑫-图腾壁垒改挂效果后也走 healPowerFor 缩放（"治疗与护盾强度影响所有相关属性"这条硬规矩不能漏）',
    /const v = \(CONFIG\.gameRules\.supportUnits\?\.totem\?\.selfShieldFlat \?\? 900\) \* healPowerFor\(e, ctx\);/.test(mp));
  T('盾⑬-钢铁烈阳护盾三项数值都走 defaultParams（才能被地图级 skillOverrides 分别覆写，不是仍旧写死在闭包里）',
    /defaultParams: \{ selfPlainValue: 50, selfFixedValue: 0, allyPlainValue: 50 \}/.test(tp));
  T('盾⑬b-Q4 修正：自身固定护盾走 kind:\'stat\' statKey:\'shieldFixedMax\'，只有配了 selfFixedValue>0 才挂（不白占状态栏格子）',
    /if \(selfFixed > 0\) \{[\s\S]{0,300}kind: 'stat', statKey: 'shieldFixedMax', flatValue: selfFixed,/.test(tp));
  // v51.9：图腾守护（passive_totem_aura）友军光环那份护盾用户定稿"应该改成护盾"——
  // 光环每帧刷新，走固定护盾会变相"不断续满血护盾"，与前面几条踩的是同一个坑。
  T('盾⑭-图腾守护友军光环护盾改走 kind:\'shield\'（不再是 shieldFixedMax）',
    /name: '图腾守护', icon: '🟣', kind: 'shield',\s*\n\s*flatValue: sh,/.test(mp)
    && !/statKey: 'shieldFixedMax',\s*\n\s*flatValue: sh,/.test(mp));
  // v51.9：铁龙之力（dragonPower.steel.shieldFixedMax）用户先说"改为护盾，要不然
  // 太超标了"，之后补充定稿具体分配——"对塔+45固定护盾。对其余单位+45护盾。"
  // 钉的是真实行为而不是正则抠源码：塔拿到的应该是 kind:'stat'/shieldFixedMax
  // （会自动回满），大型小兵拿到的应该是 kind:'shield'（不会自动回复）。
  {
    const { EventBus } = await import('../src/utils/EventBus.js');
    const { EntityContainer } = await import('../src/core/EntityContainer.js');
    const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
    const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
    const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
    const { DragonSystem } = await import('../src/systems/DragonSystem.js');
    const { CONFIG } = await import('../src/data/Config.js');
    const bus2 = new EventBus();
    const ents2 = new EntityContainer(bus2);
    const fx2 = new EffectRegistry(bus2);
    const ds2 = new DragonSystem(ents2, bus2, fx2, SkillLibrary, AttributeCalculator);
    const tw = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.tower }, currentHP: 9000, _skillInstances: [],
      _mapFaction: 'blue', faction: 'blue' };
    ents2.add(tw);
    const siege = { id: ++window._uid, type: 'siege', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.siege }, currentHP: 900, _skillInstances: [],
      _mapFaction: 'blue', faction: 'blue' };
    ents2.add(siege);
    ds2._applyElementBuff(tw, 'steel');
    ds2._applyElementBuff(siege, 'steel');
    const twEff = fx2.getEffects(tw.id).find(e => e.blueprint.name === '铁龙之力');
    const siegeEff = fx2.getEffects(siege.id).find(e => e.blueprint.name === '铁龙之力');
    T('盾⑮-塔拿到的铁龙之力是 kind:\'stat\'/shieldFixedMax（会自动回满）',
      !!twEff && twEff.blueprint.kind === 'stat' && twEff.blueprint.statKey === 'shieldFixedMax');
    T('盾⑮b-大型小兵拿到的铁龙之力是 kind:\'shield\'（不会自动回复）',
      !!siegeEff && siegeEff.blueprint.kind === 'shield');
    T('盾⑮c-数值一致，都是 CONFIG.dragonPower.steel.shieldFixedMax（未改数值，只改类型分配）',
      twEff.blueprint.flatValue === CONFIG.dragonPower.steel.shieldFixedMax
      && siegeEff.blueprint.flatValue === CONFIG.dragonPower.steel.shieldFixedMax);
  }
}

// ==================== 召唤师峡谷内塔：Q4 修正版——自身+800护盾+50固定护盾，友军+50护盾 ====================
// 用户："内塔+800护盾，+50固定护盾。给周围友军单位+50护盾。"——不新开技能/新造
// 属性：内塔本来就默认装 passive_inner_bulwark（钢铁烈阳护盾），靠
// map.skillOverrides['tower:inner'].passive_inner_bulwark 把这张图的
// selfPlainValue/selfFixedValue 覆写成 800/50，allyPlainValue 留着出厂默认 50
// 不动（其它地图/编辑器新建的内塔三项都还是出厂默认，不受影响）。
{
  const { ents, fx, combat, CONFIG, SkillLibrary, attr } = await world();
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const bus2 = new EventBus();
  const ms = new MapSystem(ents, bus2);
  ms.setEffectRegistry(fx);

  ms.loadMap('summoners_rift_v1');
  T('盾⑭-召唤师峡谷地图数据里 tower:inner 的 passive_inner_bulwark 覆写为 selfPlainValue:800, selfFixedValue:50',
    ms.currentMap.skillOverrides?.['tower:inner']?.passive_inner_bulwark?.selfPlainValue === 800
    && ms.currentMap.skillOverrides?.['tower:inner']?.passive_inner_bulwark?.selfFixedValue === 50);

  const innerTower = mkEntity(ents, 'tower', { tier: 'inner', skills: ['passive_inner_bulwark'] }, CONFIG);
  combat.update(0.31); // 光环节流 0.3s 一次，跑够一次 tick，onFrame 内才真正 apply 上护盾
  combat.update(0.01); // entity.plainShield 是在 onFrame 之前缓存的，要再跑一帧才能读到刚挂上的护盾
  const shieldEff = fx.getEffects(innerTower.id).find(e => e.blueprint.kind === 'shield' && e.blueprint.name === '钢铁烈阳护盾');
  T('盾⑮-召唤师峡谷的内塔在此覆写下自身拿到 800 护盾（不是出厂的 50）',
    !!shieldEff && shieldEff.shieldRemaining === 800);
  T('盾⑮b-召唤师峡谷的内塔同时拿到 +50 固定护盾（shieldFixedMax 提升 50）',
    attr.calc(innerTower, fx.getEffects(innerTower.id)).shieldFixedMax === 50);
  T('盾⑯-召唤师峡谷内塔的护盾缓存进 entity.plainShield=800（UI 血条读的就是这个字段；固定护盾不算进这个字段）',
    innerTower.plainShield === 800);

  // 回归：不带这条地图覆写时（其它地图 / 编辑器手动加的内塔），自身出厂值仍是 50 护盾、
  // 没有固定护盾（selfFixedValue 默认 0，没超过 0 就不挂那条效果），没被这次改动带偏。
  SkillLibrary._mapOverrides = null;
  const plainInnerTower = mkEntity(ents, 'tower', { tier: 'inner', skills: ['passive_inner_bulwark'] }, CONFIG);
  combat.update(0.31);
  const shieldEff2 = fx.getEffects(plainInnerTower.id).find(e => e.blueprint.kind === 'shield' && e.blueprint.name === '钢铁烈阳护盾');
  T('盾⑰-没有地图级覆写时，钢铁烈阳护盾自身仍是出厂默认的 50 护盾（召唤师峡谷的 800 只影响这张图）',
    !!shieldEff2 && shieldEff2.shieldRemaining === 50);
  T('盾⑰b-没有地图级覆写时，自身不会额外挂固定护盾（selfFixedValue 出厂默认 0）',
    attr.calc(plainInnerTower, fx.getEffects(plainInnerTower.id)).shieldFixedMax === 0);
}

// ==================== 追加 Q1：攻击/受击弹跳幅度太夸张——用户随后纠正：塔要直接取消 ====================
// 先反馈"把这个弹跳的效果做的没那么明显吧"，我把小兵调小、又给塔单独加了一档
// 更高的幅度——理解反了。用户随即纠正："我说的是把塔攻击/受击弹跳取消掉！！！
// 你还给我加强了？？" 塔现在完全不参与这个效果，小兵维持调小后的幅度。
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('跳①-小兵的攻击脉冲/受击挤压幅度比原来小（原 0.1/0.14 → 0.035/0.05）',
    /const ATTACK_PULSE_AMOUNT = 0\.035;/.test(ul) && /const HIT_SQUASH_AMOUNT = 0\.05;/.test(ul));
  T('跳②-塔完全不参与攻击脉冲/受击挤压（不是"塔单独一档更高幅度"——那是理解反了、已被用户纠正）',
    /if \(en\.poseAttackT >= 0 && !en\.isTower\) \{/.test(ul)
    && /if \(en\.poseHitT >= 0 && !en\.isTower\) \{/.test(ul)
    && !/ATTACK_PULSE_AMOUNT_TOWER/.test(ul) && !/HIT_SQUASH_AMOUNT_TOWER/.test(ul));
}

// ==================== 追加 Q2：护盾在血条上的颜色——画板统一白色，属性窗口按深浅+斜纹区分 ====================
// 用户："护盾在血条的显示就应该是灰白色系……在画板上的进度条上这三个显示效果
// 不需要区分，都是白色就行。但是在单位属性窗口中，可以用颜色深浅和是否有斜线
// 来区分这三个。"
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('护色①-画板（UnitLayer 画布血条）三种护盾合并成一段纯白，不再用黄色画"护盾"那一档',
    /const shieldW = spW \+ sfW \+ stW;/.test(ul)
    && /if \(shieldW > 0\.001\) \{ g\.fillStyle = 'rgba\(255,255,255,0\.8\)';/.test(ul)
    && !/rgba\(255,213,79/.test(ul));   // 旧的暖金色一处都不该剩

  const html = srcOf('index.html');
  const mPlain = html.match(/\.bar-shield-plain \{[\s\S]*?\}/);
  const mFixed = html.match(/\.bar-shield-fixed \{[\s\S]*?\}/);
  const mTemp = html.match(/\.bar-shield-temp \{[\s\S]*?\}/);
  T('护色②-属性窗口的 .bar-shield-plain 改回灰白色系（不再是暖金色），且不带斜纹（用"是否带斜纹"这个维度跟另外两条区分）',
    !!mPlain && /rgba\(225,228,232,0\.62\)/.test(mPlain[0]) && !/repeating-linear-gradient/.test(mPlain[0]));
  T('护色③-固定/临时护盾两条还是白色斜纹（repeating-linear-gradient），只是深浅不同——三条都没有跳出白/灰白色系',
    !!mFixed && !!mTemp && /repeating-linear-gradient/.test(mFixed[0]) && /repeating-linear-gradient/.test(mTemp[0]));
}

// ==================== 追加 Q3：画板法力/充能条没有缓动，且要和属性窗口统一 ====================
// 用户："画板上显示的的法力条/充能条没有缓动效果。增加缓动效果。画板上进度条和
// 属性窗口进度条的缓动效果是统一的。"
{
  const bt = srcOf('src/presentation/barTrail.js');
  T('缓①-barTrail.js 新增 stepEase（双向缓动，不同于只在【减少】方向缓动的 stepTrail）',
    /export function stepEase\(disp, real, dt, snapEps\)/.test(bt));

  const ul = srcOf('src/presentation/UnitLayer.js');
  T('缓②-画板（UnitLayer）法力/充能条改用 stepEase 缓动出 en.dispResFrac，不再直接画瞬时值',
    /import \{ stepTrail, stepEase, TRAIL_COLOR \} from '\.\/barTrail\.js';/.test(ul)
    && /const rt = stepEase\(en\.dispResFrac \?\? resInfo\.frac, resInfo\.frac, dt, 1 \/ BAR_W\);/.test(ul)
    && /resInfo = \{ \.\.\.resInfo, frac: en\.dispResFrac \};/.test(ul));
  T('缓③-资源种类切换时直接贴齐，不从旧种类的数值缓过来（比如法力条切充能条不该有一条"跨种类"的缓动）',
    /if \(en\._resKind !== resInfo\.kind\) \{ en\.dispResFrac = resInfo\.frac; en\._resKind = resInfo\.kind; \}/.test(ul));

  const um = srcOf('src/ui/UIManager.js');
  T('缓④-属性窗口（UIManager）法力/充能条也改走同一个 stepEase（_stepEaseBar），与画板同一份 TRAIL_RATE',
    /import \{ stepTrail, stepEase \} from '\.\.\/presentation\/barTrail\.js';/.test(um)
    && /_stepEaseBar\(el, frac\) \{/.test(um)
    && /const tr = stepEase\(el\._frac, frac, dt, 1 \/ 300\);/.test(um)
    && /this\._stepEaseBar\(fill, info\.frac\);/.test(um));

  const html = srcOf('index.html');
  const mRes = html.match(/\.bar-res \{[\s\S]*?\}/);
  T('缓⑤-CSS 里 .bar-res 不再有 transition: width（JS 逐帧算好的宽度不该再叠一层 CSS 缓动，barTrail.js 头注点过这个老毛病）',
    !!mRes && !/transition:[^;]*width/.test(mRes[0]));
}

// ==================== 追加：钢铁烈阳护盾数值改走 defaultParams 后，getDescTemplate 也要带出新参数 ====================
{
  const tp = srcOf('src/core/skills/towerPassives.js');
  T('钢①-钢铁烈阳护盾的 getDescTemplate 读 selfPlainValue/selfFixedValue/allyPlainValue 三项参数拼描述',
    /const selfPlain = typeof p\.selfPlainValue === 'number' \? p\.selfPlainValue : 50;/.test(tp)
    && /const selfFixed = typeof p\.selfFixedValue === 'number' \? p\.selfFixedValue : 0;/.test(tp)
    && /const allyPlain = typeof p\.allyPlainValue === 'number' \? p\.allyPlainValue : 50;/.test(tp));
}

// ==================== 追加：结构保护状态文案加"无敌"，过载状态显示已损失的最大生命值 ====================
// 用户："结构保护的状态里面写：无敌。过载状态里面添加最大生命值损失了多少。"
{
  const ms = srcOf('src/systems/MapSystem.js');
  T('文①-结构保护五条描述文案都以"无敌——"开头（用户要求直接点出"无敌"这个词）',
    /无敌——本路外塔存活期间/.test(ms) && /无敌——本路内塔存活期间/.test(ms)
    && /无敌——本路水晶塔存活期间/.test(ms) && /无敌——三路召唤水晶完好期间/.test(ms)
    && /无敌——己方枢纽塔存活期间/.test(ms) && /'无敌——外侧建筑存活期间/.test(ms));

  const tp = srcOf('src/core/skills/towerPassives.js');
  T('文②-过载 computeCurrent 在进入第二阶段（开始扣最大生命）后显示具体已损失多少，不再只写"含最大生命损失"这种看不出数值的话',
    /return `已过载（最大生命已损失 \$\{Math\.round\(st\.hpLostTotal \|\| 0\)\}）`;/.test(tp));
}

// ==================== 追加：风魂塔半重做验证（v51.7：攻速收益率→攻速百分比）====================
// 用户："加移速对塔没啥用，开动脑筋重新做风魂。"根因见 Config.js/dragonSouls.js 里
// v51.7 那段注释：旧机制放大的是塔身上的 bonusAttackSpeedPct 这个"收益率乘数"，
// 但塔出厂就没有别的 bonusAttackSpeedPct 来源（模板值是 0），乘数再高乘的还是 0——
// 这条钉的就是"不做任何人为造条件、直接用真实默认塔"验证攻速确实提高了，堵上被删掉的
// 旧测试（sim_v45.mjs 原风⑤）手工把 bonusAttackSpeedPct 造到 60 才能测出效果的盲区。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');

  T('风⑥-塔的攻速百分比出厂确实是 0（不是测试特意绕开的特例，是真实默认值——旧盲区的根源）',
    (CONFIG.templates.tower.bonusAttackSpeedPct || 0) === 0);

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  fx.setStatSource(ents, AttributeCalculator);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);

  // 不做任何人为造条件——直接用塔模板的真实出厂值。
  const t = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: CONFIG.templates.tower.maxHP,
    _skillInstances: [], _mapFaction: 'blue', faction: 'blue' };
  ents.add(t);

  const before = AttributeCalculator.calcAttackSpeedOf(AttributeCalculator.calc(t, fx.getEffects(t.id)));
  ds._toggleSoul(t, 'dragonsoul_wind');
  const after = AttributeCalculator.calcAttackSpeedOf(AttributeCalculator.calc(t, fx.getEffects(t.id)));

  T('风⑦-真实默认塔（无人为造条件）装上风魂后攻速确实提高了（旧机制这里测出来是 after === before）',
    after > before);
  // 期望值要把两处来源都算上：mechanism 那半（towerBonusAttackSpeedPct，本次重做的）
  // + stat 那半（CONFIG.dragonSouls.stat.wind 的常驻 bonusAttackSpeedPct/attackSpeedRatio，
  // 塔和大型小兵都会拿到的常驻加持，与本次重做无关但同样叠在塔身上）。
  const p = CONFIG.dragonSouls.wind;
  const w = CONFIG.dragonSouls.stat.wind;
  const bonus = (p.towerBonusAttackSpeedPct ?? 35) + (w.bonusAttackSpeedPct || 0);
  const ratio = (CONFIG.templates.tower.attackSpeedRatio || 0.667) + (w.attackSpeedRatio || 0);
  const expected = CONFIG.templates.tower.baseAttackSpeed * (1 + bonus * ratio / 100);
  T('风⑧-提高的幅度对得上 towerBonusAttackSpeedPct（重做的机制半）+ 常驻加持半 的合计，不是随便一个正数就算过',
    Math.abs(after - expected) < 0.01);
}

// ==================== 追加：模板默认护盾（plainShieldFlat）====================
// 用户："【护盾】这个属性我在单位编辑窗口/模板编辑器里并未看到。"——护盾此前只能
// 靠"状态"tab 的【添加效果】临时挂，没有一个像【固定护盾】那样的模板数值字段入口。
// 新增 CONFIG.templates.<type>.plainShieldFlat，factories.js 的 grantTemplatePlainShield
// 在出生时读它，>0 就挂一份 kind:'shield' 效果。这条钉的是端到端行为（模板配置
// →出生→效果真的出现在 EffectRegistry 里），不是只钉字段存在。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { createFactories } = await import('../src/core/factories.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mapSystem = { active: false, currentMap: null };
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem, dragonSystem: ds, uiManager: { log() {} },
  });

  T('护盾字段①-出厂默认 plainShieldFlat 为 0（不影响没配置这项的单位）',
    CONFIG.templates.melee.plainShieldFlat === 0);

  const noShield = F.createMinion('melee', 0, 0, 1, 1, { faction: 'blue', laneId: 'mid' });
  T('护盾字段②-plainShieldFlat=0 时不挂任何护盾效果',
    !fx.getEffects(noShield.id).some(e => e.blueprint.kind === 'shield'));

  const bak = CONFIG.templates.melee.plainShieldFlat;
  CONFIG.templates.melee.plainShieldFlat = 77;
  const withShield = F.createMinion('melee', 0, 0, 1, 1, { faction: 'blue', laneId: 'mid' });
  const eff = fx.getEffects(withShield.id).find(e => e.blueprint.kind === 'shield');
  T('护盾字段③-plainShieldFlat=77 时出生即挂一份 kind:\'shield\' 效果，余量=77',
    !!eff && eff.shieldRemaining === 77);
  T('护盾字段④-这份护盾不会自动回复（duration 是永久，但不是【固定护盾】那种会回满的类型）',
    eff.blueprint.duration === Infinity && eff.blueprint.kind === 'shield');
  CONFIG.templates.melee.plainShieldFlat = bak;
}

// ==================== 追加：巨龙刷新节奏改随机区间——DragonSystem 端到端验证 ====================
// 用户："第一条巨龙的生成时间改为每局随机，60秒-480秒。之后下一条巨龙的生成时间
// 改为随机240-360秒。"——dragonCurve.js 那份是纯函数级验证，这里钉 DragonSystem
// 真正用起来的样子：反复构造多个实例，首条巨龙的计时器应该落在配置区间内、
// 且不是每次构造都拿到同一个数（否则等于没做到"每局随机"）。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const firstTimes = Array.from({ length: 30 }, () => {
    const bus = new EventBus();
    const ents = new EntityContainer(bus);
    const fx = new EffectRegistry(bus);
    const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
    return ds.nextDragonTime;
  });
  const [lo, hi] = CONFIG.gameRules.dragon.firstDelay;
  T('龙时②-DragonSystem 构造时首条巨龙的计时器落在配置区间 [60,480] 内',
    firstTimes.every(v => v >= lo && v <= hi));
  T('龙时②-同样的配置，多次构造拿到的首条计时器不是同一个值（真的每局随机）',
    new Set(firstTimes.map(v => v.toFixed(6))).size > 1);

  // ==================== 追加：首条龙坑改随机（Q6 排查"蓝方一直输"发现的不对称）====================
  // 首条龙坑此前硬编码 'top'（推蓝方），红方因此天然先手抢到"第一条龙威胁蓝方"的
  // 地理优势。反复构造 DragonSystem，30 次里 top/bot 都应该出现（不是恒为 top）。
  const firstSides = Array.from({ length: 30 }, () => {
    const bus = new EventBus();
    const ents = new EntityContainer(bus);
    const fx = new EffectRegistry(bus);
    const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
    return ds._nextPitSide;
  });
  T('龙坑①-首条龙坑改成随机后，多次构造里 top/bot 都出现过（不再恒为 top）',
    firstSides.includes('top') && firstSides.includes('bot'));
}

done();
