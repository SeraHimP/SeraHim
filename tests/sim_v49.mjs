/**
 * sim_v49.mjs —— v49 验收
 *
 *   ① 溅射不打友军（中立除外）
 *   ② 攻击者死亡不再让已发出的子弹作废
 *   ③ 攻速下限 0.05 → 0（攻速 0 = 永不攻击，且恢复后能解冻）
 *   ④ 攻击方式技能类别（充能攻击）—— 与塔的武器同一形状，参数走 defaultParams
 *   ⑤ 攻城车重做（旧被动整个删除）
 *
 * 钉的是行为形状：溅射打谁/子弹结不结算/充能几秒，都真跑一遍算出来，
 * 不去正则源码 —— 源码怎么写会变，这几条规则不会。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { CONFIG } = await import('../src/data/Config.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator: A } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem, ramSplashRadius, hasRamCannon } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');

const { T, done } = scoreboard('v49验收');

function world() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const proj = new ProjectileSystem(ents, bus, combat);
  combat.setProjectileSystem(proj);
  return { bus, ents, fx, combat, proj,
    ctx: { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: A, waveNumber: 0 } };
}
/** 把飞行中的子弹全部推到落点结算完（塔/攻城车都是弹道单位，不推就什么都不会发生）。 */
const drain = (proj, n = 400) => { for (let i = 0; i < n && proj.getProjectiles().length; i++) proj.update(0.05); };
const mk = (ents, type, x, fac, hp = 100000, extra = {}) => {
  const e = { id: ++window._uid, type, alive: true, pos: { x, y: 0 },
    baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.melee) },
    currentHP: hp, _skillInstances: [], targetId: null,
    _mapFaction: fac, faction: fac, ...extra };
  e.baseStats.maxHP = hp; ents.add(e); return e;
};

// ==================== 一、溅射 ====================
// 用户："打不到友军。但是中立单位的可以打到两方。"
{
  const { ents, combat, proj } = world();
  const ram = mk(ents, 'ram', 0, 'blue');
  ram.baseStats.splashRadius = 200;      // 直接给个大半径，免得依赖攻城炮的模式
  const foe = mk(ents, 'melee', 60, 'red');
  const mate = mk(ents, 'melee', 40, 'blue');
  const neutral = mk(ents, 'melee', 50, 'neutral');
  const hp = new Map([[ram, ram.currentHP], [foe, foe.currentHP], [mate, mate.currentHP], [neutral, neutral.currentHP]]);
  combat.performAttack(ram, foe); drain(proj);
  const lost = (e) => hp.get(e) - e.currentHP;
  T('溅①-攻击者不吃自己的溅射（用户："无法对自己造成伤害"）', lost(ram) === 0);
  T('溅②-友军不吃溅射（用户："打不到友军"）', lost(mate) === 0);
  T('溅③-敌方与中立照常吃', lost(foe) > 0 && lost(neutral) > 0);
}
{
  // 中立（龙）不受"不打友军"约束：龙对红蓝都是敌人，龙之间也要能互相打到
  const { ents, combat, proj } = world();
  const d1 = mk(ents, 'dragon', 0, 'neutral');
  Object.assign(d1.baseStats, CONFIG.gameRules.dragon.combat, { attackDamage: 500, maxHP: 100000, splashRadius: 200 });
  const foe = mk(ents, 'melee', 60, 'red');
  const d2 = mk(ents, 'dragon', 70, 'neutral');
  const blue = mk(ents, 'melee', 50, 'blue');
  const hp = new Map([[d1, d1.currentHP], [d2, d2.currentHP], [blue, blue.currentHP]]);
  combat.performAttack(d1, foe); drain(proj);
  T('溅④-中立的溅射打得到两方（用户："中立单位的可以打到两方"）',
    hp.get(blue) - blue.currentHP > 0);
  T('溅④-一条龙的溅射打得到另一条龙（用户明确要保留）', hp.get(d2) - d2.currentHP > 0);
  T('溅④-但仍然打不到自己', hp.get(d1) - d1.currentHP === 0);
  T('溅⑤-两条开关都软编码', typeof CONFIG.tuning.splash.hitSelf === 'boolean'
    && typeof CONFIG.tuning.splash.hitAllies === 'boolean');
}

// ==================== 二、子弹：攻击者死了也照常结算 ====================
// 用户："无论攻击单位是否死亡，只要发出去的子弹就造成伤害。"
{
  const { ents, combat, proj } = world();
  const tw = mk(ents, 'tower', 0, 'blue');
  const foe = mk(ents, 'melee', 300, 'red');
  combat.performAttack(tw, foe);          // 发出一发子弹（塔有弹速，不会瞬时结算）
  T('弹①-确实发出了飞行中的子弹（前提成立，否则下面什么都没测）',
    proj.getProjectiles().length === 1);
  tw.alive = false;                        // 子弹在途中，攻击者阵亡
  const hp0 = foe.currentHP;
  for (let i = 0; i < 200 && proj.getProjectiles().length; i++) proj.update(0.05);
  T('弹②-攻击者死亡后，已发出的子弹照常造成伤害', foe.currentHP < hp0);
}
{
  // 目标死了 → 打尸体不造成伤害，但溅射照常（这条是既有定稿，回归守住）
  const { ents, combat, proj } = world();
  const tw = mk(ents, 'tower', 0, 'blue');
  tw.baseStats.splashRadius = 150;
  const foe = mk(ents, 'melee', 300, 'red');
  const other = mk(ents, 'melee', 340, 'red');
  combat.performAttack(tw, foe);
  foe.alive = false;
  const hpOther = other.currentHP;
  for (let i = 0; i < 200 && proj.getProjectiles().length; i++) proj.update(0.05);
  T('弹③-目标已死：溅射仍然结算给周围的其他单位', other.currentHP < hpOther);
}

// ==================== 三、攻速下限 ====================
{
  T('速①-下限从 0.05 降到 0（用户："如果攻速为0的话就显示0"）',
    A.calcAttackSpeed(1.0, -100, 0.667) === 0 && A.calcAttackSpeed(1.0, -200, 0.667) === 0);
  T('速②-正常值不受影响（只动下限，不动公式）',
    Math.abs(A.calcAttackSpeed(1.0, 0, 0.667) - 1.0) < 1e-9
    && Math.abs(A.calcAttackSpeed(1.0, -50, 0.667) - 0.5) < 1e-9);
  T('速③-攻速 0 → 攻击间隔 Infinity（不是被 `|| 0.5` 兜成每 2 秒一下）',
    A.attackIntervalOf(0) === Infinity && A.attackIntervalOf(-1) === Infinity
    && A.attackIntervalOf(2) === 0.5);
  // 沙盒模式删除后 CombatSystem 里的小兵冷却那处（原来的第三处）随小兵循环一起没了，
  // 现在塔（CombatSystem）与小兵（LaneMovementSystem）各一处，仍是同一个 attackIntervalOf。
  T('速③-两处冷却都走同一个 attackIntervalOf（原来各写一份 `1/(finalAS||0.5)`）', (() => {
    const cs = srcOf('src/systems/CombatSystem.js'), lms = srcOf('src/systems/LaneMovementSystem.js');
    return !/1 \/ \(finalAS \|\| 0\.5\)/.test(cs) && !/1 \/ \(finalAS \|\| 0\.5\)/.test(lms)
      && (cs.match(/attackIntervalOf\(finalAS\)/g) || []).length === 1
      && /attackIntervalOf\(finalAS\)/.test(lms);
  })());
  T('速④-攻速恢复后能解冻（Infinity 减多少还是 Infinity，不解冻就永久哑火）', (() => {
    const { ents, combat, fx } = world();
    const e = mk(ents, 'melee', 0, 'blue');
    e.attackCooldown = Infinity;
    A.tick();
    combat.update(0.1);
    return Number.isFinite(e.attackCooldown) && e.attackCooldown > 0;
  })());
}

// ==================== 四、攻击方式技能类别 ====================
// 用户："可不可以把充能型等单独做成技能（类似防御塔的武器），然后里面各种参数。"
{
  const def = SkillLibrary.atkmode_charge;
  T('式①-充能是独立类别 attackmode（与塔的武器同一形状）',
    !!def && def.category === 'attackmode');
  T('式②-参数走 defaultParams（编辑器可改、地图可覆写，与 weapon_* 同一条管线）',
    def.defaultParams && def.defaultParams.chargeSecAt1AS > 0
    && def.defaultParams.damagePct > 0 && 'onlyVs' in def.defaultParams);
  T('式③-谁都能装，不与攻城车绑死（以后复用的前提）',
    def.applicableTypes.includes('tower') && def.applicableTypes.includes('ram')
    && def.applicableTypes.length > 3);
  T('式④-引擎侧只认"装了 attackmode 技能"，不认是谁装的', (() => {
    const { ents, combat, ctx } = world();
    const t = mk(ents, 'tower', 0, 'blue');           // 给一座**塔**装充能
    equipSkill(t, 'atkmode_charge', ctx, SkillLibrary);
    const tw = mk(ents, 'tower', 100, 'red');
    // 默认 onlyVs='any' → 对谁都充能；关键是它**不是攻城车**也照样能充。
    return !!combat.chargeNeedOf(t, tw) && !hasRamCannon(t);
  })());
  T('式④-没有目标 = 打断（对着空气不会一直充着）', (() => {
    const { ents, combat, ctx } = world();
    const t = mk(ents, 'tower', 0, 'blue');
    equipSkill(t, 'atkmode_charge', ctx, SkillLibrary);
    return combat.chargeNeedOf(t, null) === null;
  })());
  T('式⑤-打断衰减率有全局缺省，技能可自带（"以后所有充能型武器都这样，但数可能会改"）',
    typeof CONFIG.tuning.charge.decayPctPerSec === 'number'
    && 'decayPctPerSec' in def.defaultParams);
}

// ==================== 五、攻城车重做 ====================
{
  const R = CONFIG.gameRules.ram;
  const CH = SkillLibrary.atkmode_charge.defaultParams;
  T('城①-旧被动 passive_siege_weapon 已整个删除（用户："原有的全部删除"）',
    !SkillLibrary.passive_siege_weapon);
  T('城①-三条新被动齐全', !!SkillLibrary.passive_ram_cannon
    && !!SkillLibrary.passive_ram_siege && !!SkillLibrary.passive_ram_normal);
  T('城②-模板 splashRadius = 0，半径完全由模式给出（用户："模板改为0"）',
    CONFIG.templates.ram.splashRadius === 0);
  T('城②-基础攻速 1.2 / 收益率 0.05（用户定稿）',
    CONFIG.templates.ram.baseAttackSpeed === 1.2 && CONFIG.templates.ram.attackSpeedRatio === 0.05);

  const { ents, combat, fx, ctx } = world();
  const ram = mk(ents, 'ram', 0, 'blue');
  for (const k of ['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge']) {
    equipSkill(ram, k, ctx, SkillLibrary);
  }
  const tw = mk(ents, 'tower', 100, 'red');
  const mn = mk(ents, 'melee', 60, 'red');
  const inst = ram._skillInstances.find(i => i.skillId === 'passive_ram_cannon');
  const asOf = (e) => A.calcAttackSpeedOf(A.calc(e, fx.getEffects(e.id)));

  ram.targetId = tw.id; SkillLibrary.passive_ram_cannon.onFrame(ram.id, 0.1, inst, ctx);
  T('城③-打塔 → 攻城模式，溅射半径 = siegeSplash',
    ram._ramMode === 'siege' && ramSplashRadius(ram, tw) === R.siegeSplash);
  T('城③-状态栏显示【攻城模式】（用户："别忘了在状态栏里要显示"）',
    fx.getEffects(ram.id).some(e => e.blueprint.name === '攻城模式'));
  ram.targetId = mn.id; SkillLibrary.passive_ram_cannon.onFrame(ram.id, 0.1, inst, ctx);
  T('城③-打兵 → 普通模式，溅射半径 = normalSplash',
    ram._ramMode === 'normal' && ramSplashRadius(ram, mn) === R.normalSplash);
  T('城③-状态栏切成【普通模式】，且两个模式不会同时挂着', (() => {
    const names = fx.getEffects(ram.id).map(e => e.blueprint.name);
    return names.includes('普通模式') && !names.includes('攻城模式');
  })());

  // 充能：1.2 攻速 → 12/1.2 = 10 秒
  ram.targetId = tw.id; ram._ramMode = 'siege'; ram._charge = 0;
  const st = A.calc(ram, fx.getEffects(ram.id));
  let t = 0;
  while ((ram._charge || 0) < 1 && t < 200) { combat._tickCharge(ram, st, 0.05); t += 0.05; }
  T(`城④-满充耗时 = chargeSecAt1AS / 攻速（${t.toFixed(1)}s ≈ ${(CH.chargeSecAt1AS / asOf(ram)).toFixed(1)}s）`,
    Math.abs(t - CH.chargeSecAt1AS / asOf(ram)) < 0.2);

  // 疲惫：攻城模式叠、不恢复；普通模式恢复
  combat.finishAttack(ram, tw, 1.0);
  const fat = () => (fx.getEffects(ram.id).find(e => e.blueprint.name === '攻城疲惫') || { stacks: 0 }).stacks;
  T(`城⑤-一次攻城攻击叠 fatiguePerAttack 层`, fat() === R.fatiguePerAttack);
  T('城⑤-打出去之后充能清零', ram._charge === 0);
  ram.targetId = tw.id;
  for (let i = 0; i < 10; i++) SkillLibrary.passive_ram_cannon.onFrame(ram.id, 1.0, inst, ctx);
  T('城⑥-攻城模式下**不恢复**（用户特别强调）', fat() === R.fatiguePerAttack);
  ram.targetId = mn.id;
  for (let i = 0; i < R.recoverSec * 3; i++) SkillLibrary.passive_ram_cannon.onFrame(ram.id, 1.0, inst, ctx);
  T(`城⑥-普通模式下每 ${R.recoverSec} 秒恢复 ${R.recoverLayers} 层`,
    fat() === R.fatiguePerAttack - 3 * R.recoverLayers);

  // 伤害两档
  const { ents: e2, combat: c2, ctx: x2, proj: p2 } = world();
  const r2 = mk(e2, 'ram', 0, 'blue');
  for (const k of ['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge']) {
    equipSkill(r2, k, x2, SkillLibrary);
  }
  const t2 = mk(e2, 'tower', 100, 'red'); t2.baseStats.armor = 0; t2.baseStats.magicResist = 0;
  const m2 = mk(e2, 'melee', 60, 'red'); m2.baseStats.armor = 0; m2.baseStats.magicResist = 0;
  A.tick();
  let h = t2.currentHP; c2.performAttack(r2, t2); drain(p2);
  const dTower = h - t2.currentHP;
  h = m2.currentHP; c2.performAttack(r2, m2); drain(p2);
  const dMinion = h - m2.currentHP;
  const AD = CONFIG.templates.ram.attackDamage;
  // v49b：对建筑的倍率回到攻城车自己的 siegeDamagePct（充能的 damagePct 是中性 100）
  T(`城⑦-对塔 = 攻城车的 siegeDamagePct（${Math.round(dTower)} ≈ ${Math.round(AD * R.siegeDamagePct / 100)}）`,
    Math.abs(dTower - AD * R.siegeDamagePct / 100) < 2);
  T(`城⑦-对兵 = 普通模式的伤害增幅（${Math.round(dMinion)} ≈ ${Math.round(AD * (1 + R.normalDamageAmpPct / 100))}）`,
    Math.abs(dMinion - AD * (1 + R.normalDamageAmpPct / 100)) < 2);
  T('城⑧-「近战对攻城车 +100%」已按用户定稿删除', (() => {
    const mel = mk(e2, 'melee', 10, 'red');
    A.tick();
    const before = r2.currentHP;
    c2.performAttack(mel, r2); drain(p2);
    const plain = mk(e2, 'ram', 500, 'blue');   // 没装被动的车，作对照
    const b2 = plain.currentHP;
    c2.performAttack(mel, plain); drain(p2);
    return Math.abs((before - r2.currentHP) - (b2 - plain.currentHP)) < 1e-6;
  })());
}

// ==================== 六、v49b 追加 ====================
{
  const R = CONFIG.gameRules.ram;
  const CH = SkillLibrary.atkmode_charge.defaultParams;
  T('补①-攻城车所有状态下都充能（用户改稿），充能自身的倍率回归中性 100',
    CH.onlyVs === 'any' && CH.damagePct === 100);
  T('补②-攻击力 70 / 对建筑 700%（用户定稿）',
    CONFIG.templates.ram.attackDamage === 70 && R.siegeDamagePct === 700);
  T('补③-普通模式 +33% 攻速走 baseAttackSpeed 的百分比，不走 bonusAttackSpeedPct', (() => {
    // 攻城车的攻速收益率是 0.05：正向加成要打 5% 的折，33% 只剩 1.65%，等于没有。
    // baseAttackSpeed 不过收益率 —— 这是选它的全部理由，钉住免得被"顺手改回去"。
    const src = srcOf('src/core/skills/minionPassives.js');
    return R.normalAtkSpeedPct === 33
      && /name: '轻装行军'[\s\S]{0,200}statKey: 'baseAttackSpeed'/.test(src);
  })());

  const { ents, fx, ctx, combat } = world();
  const ram = mk(ents, 'ram', 0, 'blue');
  for (const k of ['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge']) {
    equipSkill(ram, k, ctx, SkillLibrary);
  }
  const tw = mk(ents, 'tower', 100, 'red');
  const mn = mk(ents, 'melee', 60, 'red');
  const cannon = ram._skillInstances.find(i => i.skillId === 'passive_ram_cannon');
  const normal = ram._skillInstances.find(i => i.skillId === 'passive_ram_normal');
  const frame = () => {
    SkillLibrary.passive_ram_cannon.onFrame(ram.id, 0.1, cannon, ctx);
    SkillLibrary.passive_ram_normal.onFrame(ram.id, 0.1, normal, ctx);
  };
  const asOf = () => A.calcAttackSpeedOf(A.calc(ram, fx.getEffects(ram.id)));

  ram.targetId = mn.id; frame();
  const asNormal = asOf();
  ram.targetId = tw.id; frame();
  const asSiege = asOf();
  T(`补③-普通模式确实快 ${R.normalAtkSpeedPct}%（普通 ${asNormal.toFixed(2)} vs 攻城 ${asSiege.toFixed(2)}）`,
    Math.abs(asNormal - asSiege * (1 + R.normalAtkSpeedPct / 100)) < 1e-6);
  T('补③-切回攻城模式时那份加成会被摘掉（不会两个模式同时享受）',
    !fx.getEffects(ram.id).some(e => e.blueprint.name === '轻装行军'));

  // 充能进度状态
  ram.targetId = tw.id; frame();
  const chg = fx.getEffects(ram.id).find(e => e.blueprint.name === '充能');
  T('补④-状态栏有【充能】这一格（用户："应该有个带进度的状态表示充能进度"）', !!chg);
  T('补④-进度由 progressOf 现算，不往效果里写数（写数=每帧 apply=图标闪烁+点不中）',
    !!chg && typeof chg.blueprint.progressOf === 'function');
  T('补④-进度读的就是实体的充能值', (() => {
    ram._charge = 0.42;
    return Math.abs(chg.blueprint.progressOf(ram) - 0.42) < 1e-9;
  })());
  T('补④-界面把 progressOf 接上了环（钉调用点，不钉定义）', (() => {
    const um = srcOf('src/ui/UIManager.js');
    return /const progFn = e\.blueprint\.progressOf;/.test(um)
      && /conic-gradient\(rgba\(246,201,74/.test(um);
  })());
}

// ==================== 七、腐蚀/连锁：不打友军、也不再漏掉攻城车 ====================
// 用户："腐蚀型武器的塔竟然会对友军也造成伤害，攻城车安然无恙？"
{
  const { ents, fx, ctx } = world();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower._skillInstances.push({ id: ++window._uid, skillId: 'weapon_corrosion', state: { timer: 999 } });
  const foe = mk(ents, 'melee', 50, 'red');
  const mate = mk(ents, 'melee', 60, 'blue');
  const foeRam = mk(ents, 'ram', 70, 'red');
  const inst = tower._skillInstances[0];
  SkillLibrary.weapon_corrosion.onFrame(tower.id, 1.0, inst, ctx);
  const poisoned = (e) => fx.getEffects(e.id).some(x => x.blueprint.name === '腐蚀·毒素');
  T('腐①-敌方单位中毒', poisoned(foe));
  T('腐②-**友军不中毒**（用户报的第一个症状）', !poisoned(mate));
  T('腐③-攻城车也会中毒（用户报的第二个症状：白名单里漏了 ram）', poisoned(foeRam));
  T('腐④-判据不再是写死的兵种白名单（以后加兵种不用回来补）', (() => {
    const w = srcOf('src/core/skills/weapons.js');
    return /enemyUnitsInRadius\(ctx\.entityContainer, entity, range\)/.test(w)
      && !/'melee', 'ranged', 'siege', 'super', 'totem', 'dragon', 'shield', 'warlock', 'corrupt'/.test(w);
  })());
  T('腐⑤-连锁伤害走同一份实现（同一个坑的另一半）', (() => {
    const cs = srcOf('src/systems/CombatSystem.js');
    return /enemyUnitsInRadius\(this\.entities, probe, radius\)/.test(cs);
  })());
}

done();
