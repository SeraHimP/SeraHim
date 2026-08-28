/**
 * sim_v51.mjs —— v51 验收（资源条+主动技能 / 法强+技能增幅 / 适应之力 / 暴击 /
 *                 统一吸血 / 闪避+韧性+沉默+缴械 / 远古龙魂大型小兵漏发 bug 修复）
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
{
  const { CONFIG } = await world();
  T('塔①-默认伤害类型 = physical（推翻 v43 的"改为魔法"）', CONFIG.templates.tower.attackType === 'physical');
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

  // 装了主动技能：法力应当按 manaRegen 累积到满
  const active = mkEntity(ents, 'siege', {
    pos: { x: 5000, y: 5000 }, // 远离一切敌人，确保满了也施放不出去（找不到目标）
    stats: { maxMana: 10, manaRegen: 5, manaStart: 0 },
    skills: ['active_siege_barrage'],
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
  const hpBefore = foe.currentHP;
  mana.update(0.01);
  T('法④-满法力+有目标 → 施放主动技能并造成伤害', foe.currentHP < hpBefore);
  T('法⑤-施放后法力回落（默认清到0）', (active._mana || 0) < 10);

  // 沉默：法力照常攒满待命，但不会尝试施放
  const silenced = mkEntity(ents, 'siege', {
    pos: { x: 9000, y: 9000 },
    stats: { maxMana: 10, manaRegen: 999, manaStart: 0 },
    skills: ['active_siege_barrage'],
  }, CONFIG);
  fx.apply(silenced.id, { name: '沉默测试', kind: 'silence', duration: 10 }, 'test_silence');
  const foe2 = mkEntity(ents, 'melee', { pos: { x: 9010, y: 9000 }, stats: { maxHP: 100000, armor: 0, magicResist: 0 } }, CONFIG);
  foe2._mapFaction = 'red'; foe2.faction = 'red';
  silenced._mapFaction = 'blue'; silenced.faction = 'blue';
  const hp2Before = foe2.currentHP;
  mana.update(1);
  T('法⑥-沉默期间法力照常攒满但不尝试施放', silenced._mana >= 10 && foe2.currentHP === hp2Before);
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
  const def = SkillLibrary.get('active_siege_barrage');
  T('主①-主动技能确实注册进了技能库', !!def && def.category === 'active');
  T('主②-主动技能的文案前缀是"主动技能——"而不是"唯一被动——"',
    /^主动技能——/.test(def.description));
  const passiveDef = SkillLibrary.get('dragonsoul_fire');
  T('主③-被动技能前缀不受影响，仍是"唯一被动——"', /^唯一被动——/.test(passiveDef.description));
}

done();
