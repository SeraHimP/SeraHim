/**
 * sim_v50.mjs —— v50 验收
 *
 *   ① 真实伤害跳过一切防御手段（含护盾）；减伤/格挡为负时放大
 *   ② 攻城车充能打小兵也清零
 *   ③ 护盾回复速率是死字段，已删干净
 *   ④ 六条新龙魂（霜/铁/血/熔/星/蚀）
 *   ⑤ 腐蚀/连锁不打友军、也不再漏掉攻城车（v49b 的同一个坑收口）
 *   ⑥ 四个窗口重构（龙魂 / 批量技能 / 批量状态 / 天气）
 *
 * 能真跑的一律真跑；只能钉源码的，钉的是**取值口径与接线**，不是某个名字存在。
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
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { DragonSystem, DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');

const { T, done } = scoreboard('v50验收');

function W() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const proj = new ProjectileSystem(ents, bus, combat); combat.setProjectileSystem(proj);
  const buffs = new BuffSystem(fx, ents, bus, combat);
  return { bus, ents, fx, combat, proj, buffs,
    ctx: { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: A, combat, waveNumber: 0 } };
}
const mk = (ents, t, x, f, hp = 100000) => {
  const e = { id: ++window._uid, type: t, alive: true, pos: { x, y: 0 },
    baseStats: { ...(CONFIG.templates[t] || CONFIG.templates.melee) },
    currentHP: hp, _skillInstances: [], targetId: null, _mapFaction: f, faction: f };
  e.baseStats.maxHP = hp; ents.add(e); return e;
};

// ==================== 一、真实伤害 ====================
// 用户："真实伤害会跳过护盾以及所有防御手段直接对生命值造成伤害。
//        伤害减免等（不包括双抗）为负时叠加额外伤害。"
{
  const { ents, combat } = W();
  const atk = mk(ents, 'tower', 0, 'blue');
  const mkVictim = (over) => {
    const v = mk(ents, 'melee', 50, 'red', 10000);
    Object.assign(v.baseStats, { armor: 0, magicResist: 0, damageReduction: 0, damageBlock: 0 }, over);
    return v;
  };
  const hit = (v, type, amt = 200) => { A.tick(); const h = v.currentHP; combat.performAttackDirect(atk.id, v.id, amt, type); return h - v.currentHP; };

  const v1 = mkVictim({}); v1.tempShield = 1000;
  T('真①-真伤完全不进护盾（护盾一点不掉，生命直接扣）',
    Math.abs(hit(v1, 'true') - 200) < 1 && Math.abs(v1.tempShield - 1000) < 1e-6);
  const v2 = mkVictim({ damageReduction: 50 });
  T('真②-真伤跳过伤害减免', Math.abs(hit(v2, 'true') - 200) < 1);
  const v3 = mkVictim({ damageBlock: 80 });
  T('真③-真伤跳过格挡', Math.abs(hit(v3, 'true') - 200) < 1);
  const v4 = mkVictim({ armor: 100 });
  T('真④-真伤跳过双抗', Math.abs(hit(v4, 'true') - 200) < 1);

  // 负减伤 = 放大（只对非真伤）
  const v5 = mkVictim({ damageReduction: -20 });
  T('真⑤-减伤为负 → 非真伤被放大（1 −(−20)/100 = 1.2）',
    Math.abs(hit(v5, 'physical') - 240) < 1);
  T('真⑤-但真伤不吃这个放大（它跳过了减伤这一段）',
    Math.abs(hit(v5, 'true') - 200) < 1);
  const v6 = mkVictim({ damageBlock: -30 });
  T('真⑥-格挡为负 → 非真伤加伤（damage −(−30)）',
    Math.abs(hit(v6, 'physical') - 230) < 1);

  // 两条路径口径一致（改动前 _resolveHit 根本没有真伤分支）
  const cs = srcOf('src/systems/CombatSystem.js');
  T('真⑦-两条路径共用同一个判据 isTrueDamage（不再各写一套）',
    /function isTrueDamage\(attackType\)/.test(cs)
    && (cs.match(/isTrueDamage\(attackType\)/g) || []).length >= 3);
  T('真⑦-护盾吸收也只剩一份实现（原来两条路径逐字各抄了一份 18 行）',
    /_absorbByShields\(target, damage, defStats, trueDmg\)/.test(cs)
    // 三次出现 = 一处定义 + 两条路径各一次调用。定义那一行后面跟着 `{`，据此区分。
    && (cs.match(/_absorbByShields\(target, damage, defStats, trueDmg\);/g) || []).length === 2);
}

// ==================== 二、攻城车充能清零 ====================
// 用户："攻城车在攻击小兵时，充能满了之后不会清零，而是满充能后持续攻击。"
{
  const { ents, combat, ctx } = W();
  const ram = mk(ents, 'ram', 0, 'blue');
  for (const k of ['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge']) {
    equipSkill(ram, k, ctx, SkillLibrary);
  }
  const tw = mk(ents, 'tower', 100, 'red');
  const mn = mk(ents, 'melee', 60, 'red');
  ram._charge = 1; ram.targetId = mn.id;
  combat.finishAttack(ram, mn, 1.0);
  T('充①-打小兵也清零（根因：清零那句原来写在"只对建筑"的早退之后）', ram._charge === 0);
  ram._charge = 1; ram.targetId = tw.id;
  combat.finishAttack(ram, tw, 1.0);
  T('充①-打建筑照样清零', ram._charge === 0);
  T('充②-攻城疲惫仍然只在打建筑时叠', (() => {
    const { ents: e2, combat: c2, fx: f2, ctx: x2 } = W();
    const r2 = mk(e2, 'ram', 0, 'blue');
    for (const k of ['passive_ram_cannon', 'atkmode_charge']) equipSkill(r2, k, x2, SkillLibrary);
    const m2 = mk(e2, 'melee', 60, 'red');
    r2._charge = 1; r2.targetId = m2.id;
    c2.finishAttack(r2, m2, 1.0);
    return !f2.getEffects(r2.id).some(e => e.blueprint.name === '攻城疲惫');
  })());
}

// ==================== 三、护盾回复速率是死字段 ====================
// 用户："没有【护盾回复】这个东西，如果有的话直接在系统里删除。"
{
  const files = ['src/data/Config.js', 'src/data/statDocs.js', 'src/ui/editor/fields.js',
    'src/ui/editor/pagesEntity.js', 'src/ui/editor/pagesSkillEffect.js'];
  T('盾①-shieldRegenRate 已从模板与编辑器里删干净（它从来没有被任何系统读过）',
    files.every(f => !/shieldRegenRate/.test(srcOf(f))));
  T('盾①-固定护盾的真实规则没变：脱战 N 秒后**瞬间**回满（速率本来就没参与过）',
    /entity\.shieldFixedCurrent = shieldMax;/.test(srcOf('src/systems/CombatSystem.js')));
  T('盾②-临时护盾的每秒衰减仍然是活的（别把这个也一起删了）',
    /tempShieldDecayPct/.test(srcOf('src/systems/CombatSystem.js'))
    && CONFIG.templates.tower.tempShieldDecayPct > 0);
}

// ==================== 四、六条新龙魂 ====================
{
  const NEW = ['frost', 'steel', 'blood', 'magma', 'astral', 'rift'];
  T('魂①-六个新元素都在，且各自能查到自己的魂',
    NEW.every(k => !!DRAGON_ELEMENTS[k] && !!SkillLibrary[DRAGON_ELEMENTS[k].soul]));
  T('魂①-每个新元素都有【力】与【魂属性】两份配置',
    NEW.every(k => CONFIG.dragonPower[k] && CONFIG.dragonSouls.stat[k] && CONFIG.dragonSouls[k]));
  T('魂②-巨龙之力的属性仍然元素独占（用户定稿，元素越多越容易破）', (() => {
    const owner = {};
    for (const [el, tbl] of Object.entries(CONFIG.dragonPower)) {
      if (el === 'maxStacks') continue;
      for (const k of Object.keys(tbl)) {
        if (owner[k]) return false;
        owner[k] = el;
      }
    }
    return true;
  })());
  // v51.4：推翻了。"每条魂都要有生存分量"这条 v44 规则被用户否掉，改成与
  // dragonPower 同一套纪律——"哪种类型的巨龙之力/龙魂就加哪种类型的属性/方向"，
  // 常驻数值不再靠塞跟主题无关的防御/生存属性来平衡。sim_v44.mjs「龙⑩」已经把
  // 这条改成了跨全部十三条魂的"元素独占"检查，这里不用重复断言，只确认这六条
  // 新魂本身也在那份独占表里（不是被漏掉、stat 是空对象）。
  T('魂③-六条新魂都有非空的常驻数值（方向对不对由龙⑩的独占检查守）',
    NEW.every(k => Object.keys(CONFIG.dragonSouls.stat[k]).length > 0));

  // 🧊 霜魂
  {
    const { ents, fx, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue'); equipSkill(t, 'dragonsoul_frost', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_frost');
    const m = mk(ents, 'melee', 50, 'red'), tw = mk(ents, 'tower', 80, 'red');
    const p = CONFIG.dragonSouls.frost;
    for (let i = 0; i < p.stacksToFreeze; i++) {
      SkillLibrary.dragonsoul_frost.onDealtDamage(t.id, m.id, inst, ctx);
    }
    const nm = () => fx.getEffects(m.id).map(e => e.blueprint.name);
    T('霜①-满层冻结，并同时挂上冻结免疫（用户："冻结目标后该目标 15 秒内免疫冻结"）',
      nm().includes('冻结') && nm().includes('冻结免疫'));
    T('霜①-免疫的描述写清楚了"这段时间内不会被冻"（用户明确要求显示）',
      fx.getEffects(m.id).some(e => e.blueprint.name === '冻结免疫'
        && /不会受到冻结/.test(e.blueprint.description)));
    // 免疫期内再打：连层都不该叠（否则免疫一过立刻二次冻结）
    for (const e of fx.getEffects(m.id)) if (e.blueprint.name === '冻结') fx.remove(e.id);
    for (let i = 0; i < p.stacksToFreeze + 2; i++) {
      SkillLibrary.dragonsoul_frost.onDealtDamage(t.id, m.id, inst, ctx);
    }
    T('霜②-免疫期内不再叠层、也不再冻结', !nm().includes('冻结'));
    for (let i = 0; i < 3; i++) SkillLibrary.dragonsoul_frost.onDealtDamage(t.id, tw.id, inst, ctx);
    const tn = fx.getEffects(tw.id).map(e => e.blueprint.name);
    T('霜③-对建筑不冻结，改叠攻速衰减（用户："塔做减攻速的"）',
      tn.includes('霜蚀') && !tn.includes('冻结'));
  }

  // 🛡 钢魂
  {
    const { ents, fx, combat, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue', 1000); t.currentHP = 400;
    equipSkill(t, 'dragonsoul_steel', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_steel');
    const p = CONFIG.dragonSouls.steel;
    SkillLibrary.dragonsoul_steel.onFrame(t.id, p.everySec + 0.1, inst, ctx);
    T('钢①-周期性获得护盾，四档来源都预留（固定/最大/已损/当前）',
      t.tempShield > 0
      && ['flat', 'maxHPPct', 'missingHPPct', 'currentHPPct'].every(k => k in p));
    const foe = mk(ents, 'melee', 20, 'red');
    const h = foe.currentHP;
    combat._fireOnDamaged(t, foe, 100);
    T(`钢②-有盾时反弹近战伤害 ${p.reflectPct}%（真伤）`,
      Math.abs((h - foe.currentHP) - 100 * p.reflectPct / 100) < 1);
    const rng = mk(ents, 'ranged', 200, 'red');
    const h2 = rng.currentHP;
    combat._fireOnDamaged(t, rng, 100);
    T('钢②-只反弹近战，远程不反', rng.currentHP === h2);
    t.tempShield = 0; t.shieldFixedCurrent = 0;
    const h3 = foe.currentHP;
    combat._fireOnDamaged(t, foe, 100);
    T('钢②-没盾就不反弹', foe.currentHP === h3);
    T('钢③-受击回调是引擎的通用钩子（此前根本没有，防御型被动无处可挂）',
      /_fireOnDamaged\(target, attacker, finalDamage\)/.test(srcOf('src/systems/CombatSystem.js')));
  }

  // 🩸 血魂
  {
    const { ents, fx, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue', 1000);
    equipSkill(t, 'dragonsoul_blood', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_blood');
    const p = CONFIG.dragonSouls.blood;
    const adAt = (hp) => {
      t.currentHP = hp; inst.state = {};
      SkillLibrary.dragonsoul_blood.onFrame(t.id, 0.1, inst, ctx);
      A.tick();
      return A.calc(t, fx.getEffects(t.id)).attackDamage;
    };
    const maxHP = A.calc(t, fx.getEffects(t.id)).maxHP;
    const full = adAt(maxHP), mid = adAt(maxHP * 0.66), peak = adAt(maxHP * (p.peakAtHPPct / 100));
    const below = adAt(maxHP * 0.10);
    T('血①-越残血越强（满血 < 中段 < 峰值）', full < mid && mid < peak);
    T(`血②-${p.peakAtHPPct}% 生命时达到峰值`, Math.abs(peak - full * (1 + p.attackDamagePct / 100)) < 2);
    T('血②-低于峰值点后**维持**不再回落（越接近死亡收益反而下降会很怪）',
      Math.abs(below - peak) < 1e-6);
    T('血③-加的是攻击力/攻速/生命偷取三项（用户定稿）',
      ['attackDamagePct', 'bonusAttackSpeedPct', 'lifeStealPct'].every(k => k in p));
  }

  // 🌋 熔魂
  {
    const { ents, fx, buffs, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue'); equipSkill(t, 'dragonsoul_magma', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_magma');
    const p = CONFIG.dragonSouls.magma;
    const burn = mk(ents, 'melee', 50, 'red', 5000);
    const near = mk(ents, 'melee', 50 + p.radius - 10, 'red', 5000);
    const far = mk(ents, 'melee', 50 + p.radius + 200, 'red', 5000);
    const mate = mk(ents, 'melee', 60, 'blue', 5000);
    SkillLibrary.dragonsoul_magma.onDealtDamage(t.id, burn.id, inst, ctx);
    const h = new Map([[burn, burn.currentHP], [near, near.currentHP], [far, far.currentHP], [mate, mate.currentHP]]);
    buffs.update(1.0);
    const lost = (e) => h.get(e) - e.currentHP;
    T('熔①-被灼烧者掉血', lost(burn) > 0);
    T('熔②-**半径内的其他敌人**也掉血（用户："可以对其他单位造成伤害"）', lost(near) > 0);
    T('熔②-半径外不掉', lost(far) === 0);
    T('熔③-友军不吃（v49b 的阵营过滤在这条新路径上同样成立）', lost(mate) === 0);
    T('熔④-圈跟着目标走：半径写在 DOT 蓝图上，圆心天然是持有者当前位置',
      fx.getEffects(burn.id).some(e => e.blueprint.auraRadius === p.radius)
      && /const R = eff\.blueprint\.auraRadius \|\| 0;/.test(srcOf('src/systems/BuffSystem.js')));
    T('熔④-带半径的 DOT 是**通用字段**，不是熔魂专属代码（以后任何 DOT 都能用）',
      !/magma/i.test(srcOf('src/systems/BuffSystem.js')));
  }

  // 🌌 星魂
  {
    const { ents, fx, combat, proj, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue'); equipSkill(t, 'dragonsoul_astral', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_astral');
    const p = CONFIG.dragonSouls.astral;
    const origin = mk(ents, 'melee', 100, 'red', 5000);
    const a = mk(ents, 'melee', 140, 'red', 5000), b = mk(ents, 'melee', 180, 'red', 5000);
    const mate = mk(ents, 'melee', 120, 'blue', 5000);
    SkillLibrary.dragonsoul_astral.onDealtDamage(t.id, origin.id, inst,
      { ...ctx, totalRaw: 200, attackType: 'physical' });
    T(`星①-分裂出 ${p.splits} 枚（走真实弹道，所以看得见）`,
      proj.getProjectiles().length === p.splits);
    T('星①-分裂弹用更小的 size（一眼看出不是主弹）',
      proj.getProjectiles().every(x => x.size < 12));
    const hs = new Map([[a, a.currentHP], [b, b.currentHP], [mate, mate.currentHP], [origin, origin.currentHP]]);
    for (let i = 0; i < 400 && proj.getProjectiles().length; i++) proj.update(0.05);
    T('星②-打到其他敌人，不打友军、也不回头打主目标',
      hs.get(a) - a.currentHP > 0 && hs.get(mate) - mate.currentHP === 0
      && hs.get(origin) - origin.currentHP === 0);
    T('星③-分裂弹不触发任何技能/被动（_noProc），攻击特效按 onHitEffPct 效率工作', (() => {
      const cs = srcOf('src/systems/CombatSystem.js');
      return /_noProc: true, applyOnHitBonus: true/.test(cs)
        && /attackShare: Math\.max\(0, Math\.min\(1, \(opt\.onHitEffPct \?\? 55\) \/ 100\)\)/.test(cs)
        && p.onHitEffPct === 55;
    })());
  }

  // v51.6 修复：星魂的分裂弹速度原来写死 520，跟攻击者自己的弹速完全脱钩——
  // 星魂自己的主题就是"射程+弹速"（CONFIG.dragonSouls.stat.astral），叠满弹速的
  // 塔反而会觉得"自己的分裂弹比普攻还慢"，这正是用户报的"星龙的子弹速度特别慢"。
  // 现在分裂弹速度＝攻击者当前 bulletSpeed，这里验证一高一低两个弹速都能跟上，
  // 不再是与弹速属性无关的固定 520。
  {
    const { ents, fx, combat, proj, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue'); equipSkill(t, 'dragonsoul_astral', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_astral');
    const origin = mk(ents, 'melee', 100, 'red', 5000);
    mk(ents, 'melee', 140, 'red', 5000);

    // AttributeCalculator.calc() 按 frame 缓存结果，改完 baseStats 之后要 A.tick()
    // 一下才会在下一次 calc() 里重新算，不然读到的是改之前那份缓存。
    // 期望值不能直接拿改的那个 baseStats 字面量比——这座塔本身还装着星魂，
    // CONFIG.dragonSouls.stat.astral 会再给弹速 +80，实际生效值是 calc() 算出来的
    // 那个数（base + 星魂加成），不是 baseStats 上的原始值，这才是这条修复真正要
    // 验证的东西："分裂弹速度＝这座塔当前真实弹速"，包含它自己的一切加成来源。
    t.baseStats.bulletSpeed = 999; // 远高于旧的硬编码 520
    A.tick();
    let expected = A.calc(t, fx.getEffects(t.id)).bulletSpeed;
    SkillLibrary.dragonsoul_astral.onDealtDamage(t.id, origin.id, inst, { ...ctx, totalRaw: 200, attackType: 'physical' });
    T('星④-分裂弹速度跟着攻击者【当前真实弹速】走（含星魂自身+80加成），不是硬编码520',
      expected !== 520 && proj.getProjectiles().every(pr => pr.speed === expected));
    for (let i = 0; i < 400 && proj.getProjectiles().length; i++) proj.update(0.05);

    t.baseStats.bulletSpeed = 50; // 远低于旧的硬编码 520，确认不是"取更大值"之类的另一种硬编码
    A.tick();
    expected = A.calc(t, fx.getEffects(t.id)).bulletSpeed;
    SkillLibrary.dragonsoul_astral.onDealtDamage(t.id, origin.id, inst, { ...ctx, totalRaw: 200, attackType: 'physical' });
    T('星⑤-弹速调低时分裂弹同步变慢（不是只在弹速很高时才生效，也不是取二者较大值）',
      expected < 520 && proj.getProjectiles().every(pr => pr.speed === expected));
  }

  // ☄️ 蚀魂
  {
    const { ents, fx, ctx } = W();
    const t = mk(ents, 'tower', 0, 'blue'); equipSkill(t, 'dragonsoul_rift', ctx, SkillLibrary);
    const inst = t._skillInstances.find(i => i.skillId === 'dragonsoul_rift');
    const p = CONFIG.dragonSouls.rift;
    const m = mk(ents, 'melee', 50, 'red'); m.baseStats.damageReduction = 0;
    for (let i = 0; i < p.maxStacks + 3; i++) {
      SkillLibrary.dragonsoul_rift.onDealtDamage(t.id, m.id, inst, ctx);
    }
    A.tick();
    T(`蚀①-把目标的减伤削成负数（封顶 −${p.perStack * p.maxStacks}%）`,
      Math.abs(A.calc(m, fx.getEffects(m.id)).damageReduction + p.perStack * p.maxStacks) < 1e-6);
    T('蚀②-与暗魂的区别：削的是减伤（影响一切非真伤），不是双抗',
      CONFIG.dragonSouls.dark.flatPerStack !== undefined
      && !('flatPerStack' in p));
  }
}

// ==================== 五、腐蚀 / 连锁不打友军 ====================
{
  const { ents, fx, ctx } = W();
  const tower = mk(ents, 'tower', 0, 'blue');
  tower._skillInstances.push({ id: ++window._uid, skillId: 'weapon_corrosion', state: { timer: 999 } });
  const foe = mk(ents, 'melee', 50, 'red');
  const mate = mk(ents, 'melee', 60, 'blue');
  const foeRam = mk(ents, 'ram', 70, 'red');
  SkillLibrary.weapon_corrosion.onFrame(tower.id, 1.0, tower._skillInstances[0], ctx);
  const poisoned = (e) => fx.getEffects(e.id).some(x => x.blueprint.name === '腐蚀·毒素');
  T('腐①-敌方中毒、友军不中毒', poisoned(foe) && !poisoned(mate));
  T('腐②-攻城车也会中毒（旧白名单里漏了 ram）', poisoned(foeRam));
  T('腐③-两处都走同一份 enemyUnitsInRadius（腐蚀 + 连锁）',
    /enemyUnitsInRadius\(ctx\.entityContainer, entity, range\)/.test(srcOf('src/core/skills/weapons.js'))
    && /enemyUnitsInRadius\(this\.entities, probe, radius\)/.test(srcOf('src/systems/CombatSystem.js')));
}

// ==================== 六、四个窗口重构 ====================
{
  const gw = srcOf('src/ui/editor/pagesGameplayWorld.js');
  const gs = srcOf('src/ui/editor/pagesGameplaySkillState.js');
  const gm = srcOf('src/ui/editor/gpMatrix.js');
  const wp = srcOf('src/ui/WeatherPanel.js');
  const html = srcOf('index.html');

  // v51.6：展示位置从"对局态势里一句层数/上限文字"改成了"已生效龙魂池里按元素
  // 显示层数的 chip"，见 tests/sim_v44.mjs 巨龙⑦ 同一处更新的说明。
  T('窗①-龙魂窗补上了【巨龙之力】（用户："你原有的窗口只写了龙魂，没写巨龙之力"）',
    /之力（\$\{n\}层）/.test(gw) && /_dgFactionActivePower/.test(gw));
  T('窗①-顶部有对局态势：双方条数 / 下一条龙倒计时 / 当前魂',
    /对局态势/.test(gw) && /下一条龙/.test(gw));
  T('窗①-套用单位属性面板的样式（.panel-sec + .attrs 网格），不再是一排 slider-row',
    /class="panel-sec">对局态势/.test(gw) && /<div class="attrs">/.test(gw));

  T('窗②-批量两页共用同一套选择组件（不是各抄一份）',
    /from '\.\/gpMatrix\.js'/.test(gs)
    && /export function matrixHtml/.test(gm) && /export function triState/.test(gm));
  T('窗②-目标矩阵是一二级菜单 + 每级全选（用户："弄成那种一二级菜单，右侧列添加全选"）',
    /gp-group/.test(gm) && /data-\$\{idPrefix\}all/.test(gm) && /data-\$\{idPrefix\}rowall/.test(gm));
  T('窗②-三态：实线 / 虚线半选 / 空（用户明确要求虚线表示半选）',
    /\.gp-chk\.partial \{ border-style: dashed/.test(html)
    && /state === 'all' \? 'gp-chk on' : state === 'some' \? 'gp-chk partial'/.test(gm));
  T('窗②-三态读的是**选中单位实际持有的情况**，不是模板',
    /export function entitiesOfCell\(cellKey, entityContainer\)/.test(gm));
  T('窗③-武器互斥：装新武器时先摘掉其它 weapon（用户："新选的武器会覆盖旧的武器"）',
    /export function stripOtherWeapons/.test(gm) && /stripOtherWeapons\(e, skillId, ctx\)/.test(gs));
  T('窗③-互斥写在"给单位装技能"那一处，不是写在某个按钮的回调里',
    /_gpSetSkill\(targets, skillId, want\)/.test(gs));
  T('窗④-状态页同样是三态 + 同一套矩阵（用户："选择逻辑还是上面的那种"）',
    /data-gpstatename/.test(gs) && /this\._gpBindMatrix\(overlay, 'gpstate'/.test(gs));

  T('窗⑤-天气页不再自己套一层侧栏（"两列 tab"的成因）',
    !/<div class="tpl-layout">/.test(wp) && !/tpl-nav-item/.test(wp));
  T('窗⑤-四段并成一页，用 .panel-sec 分隔',
    ['实时与预报', '气候模板', '基础天气', '极端天气']
      .every(x => new RegExp(`class="panel-sec">${x}<`).test(wp)));
  T('窗⑤-内层切页状态与绑定一并删干净（留着就是死状态）',
    !/data-wxsec/.test(wp) && !/data-wxnav/.test(wp));
}

// ==================== 七、兵弹不再是"一个点" ====================
{
  const fxSrc = srcOf('src/presentation/EffectsLayer.js');
  T('弹①-非塔弹补了一条**短**拖尾（塔弹不受影响）',
    /if \(!isTower\) \{[\s\S]{0,900}CONFIG\.ui && CONFIG\.ui\.bulletTrail/.test(fxSrc));
  T('弹②-长度/开关软编码，且明显短于塔弹（避免上百条兵弹糊成一片）',
    CONFIG.ui.bulletTrail.enabled === true
    && CONFIG.ui.bulletTrail.lenK < 2.2);
}

done();
