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
  const siege = mkEntity(ents, 'siege', {}, CONFIG);
  const thunderInst = { id: 1, skillId: 'dragonsoul_thunder', state: {} };
  SkillLibrary.dragonsoul_thunder.onEquip(siege.id, thunderInst, ctx);
  const critAfter = AttributeCalculator.calc(siege, fx.getEffects(siege.id)).critChance;
  T('魂框①-雷魂的暴击率（新框架属性）正确挂到大型小兵（炮兵）身上，不只是塔',
    critAfter >= (siege.baseStats.critChance || 0) + CONFIG.dragonSouls.stat.thunder.critChance - 1e-6);

  const totem = mkEntity(ents, 'totem', {}, CONFIG);
  const astralInst = { id: 2, skillId: 'dragonsoul_astral', state: {} };
  SkillLibrary.dragonsoul_astral.onEquip(totem.id, astralInst, ctx);
  const apAfter = AttributeCalculator.calc(totem, fx.getEffects(totem.id)).abilityPower;
  T('魂框②-星魂的法术强度（新框架属性）正确挂到大型小兵（图腾兵）身上',
    apAfter >= (totem.baseStats.abilityPower || 0) + CONFIG.dragonSouls.stat.astral.abilityPower - 1e-6);

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
  T('魂框④-血魂改用物理吸血后不再与暗魂的生命偷取撞车',
    'physicalVampPct' in stat.blood && !('lifeStealPct' in stat.blood));
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
  T('魂框⑧-四个此前没用上的新框架属性各自分给了一条魂，且不撞车',
    stat.water.manaRegen > 0 && stat.magma.skillAmpPct > 0
    && stat.thunder.critDamagePct > 0 && stat.wind.evasionPct > 0
    && !('manaRegen' in stat.fire) && !('skillAmpPct' in stat.astral));

  // 首条龙延后（用户："第一波龙生成的太快了，导致龙的倾向就偏向于红方了"）
  const { dragonCfg } = await import('../src/data/dragonCurve.js');
  T('龙时①-首条元素龙不再单独抢跑，与后续元素龙同一个 300s 节奏',
    dragonCfg().firstDelay === 300 && dragonCfg().firstDelay === dragonCfg().elementIntervals[0]);
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
  }
  const scopeAll = new FakeEl(); scopeAll.value = 'all'; scopeAll.checked = true;
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
      if (sel === '.dg-scope') return [scopeAll];
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
  T('统②-图腾兵默认清单是重做后的新三件套+主动技能，不是老三件套',
    DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_aura')
    && DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_mend')
    && DEFAULT_MINION_PASSIVES.totem.includes('passive_totem_bulwark')
    && DEFAULT_MINION_PASSIVES.totem.includes('active_totem_shield')
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

done();
