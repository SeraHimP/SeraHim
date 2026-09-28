// Q1 验证：弹道模型统一到所有单位（远程=飞行+延迟结算，近战=瞬时）
globalThis.window = { gameTime: 0, waveNumber: 20, _uid: 0 };
const { EntityContainer } = await import('./src/core/EntityContainer.js');
const { EventBus } = await import('./src/utils/EventBus.js');
const { EffectRegistry } = await import('./src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('./src/core/AttributeCalculator.js');
const { CombatSystem } = await import('./src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('./src/systems/ProjectileSystem.js');
const { SkillLibrary } = await import('./src/core/SkillLibrary.js');
const { CONFIG } = await import('./src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + n + (x ? '  ' + x : '')); };

function rig() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const proj = new ProjectileSystem(ents, bus, combat);
  combat.setProjectileSystem(proj);
  const mk = (type, x, y, faction) => {
    const tpl = CONFIG.templates[type];
    const e = { id: ++window._uid, type: type === 'tower' ? 'tower' : type, alive: true, pos: { x, y },
      baseStats: { ...tpl }, currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: faction, faction };
    ents.add(e); return e;
  };
  return { bus, ents, fx, combat, proj, mk };
}
const { MELEE_RANGE_THRESHOLD } = await import('./src/data/Config.js');
// 关键：用【模板缺 bulletSpeed 的远程兵种】做用例——第一版正是漏了这类
const rangedType = 'ranged';
const meleeType  = 'melee';
console.log('  分类总表：');
for (const [k, v] of Object.entries(CONFIG.templates)) {
  const isM = (v.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD;
  console.log('    ' + String(v.label || k).padEnd(8) + (isM ? '近战·瞬时' : '远程·飞行 ' + (v.attackRange / (v.bulletSpeed || 400)).toFixed(2) + 's'));
}
console.log(`\n  用例兵种：远程=${rangedType}（模板未声明 bulletSpeed，射程 ${CONFIG.templates[rangedType].attackRange}） 近战=${meleeType}\n`);

// 1. 远程小兵：生成弹道 + 伤害延迟
{
  const r = rig();
  const a = r.mk(rangedType, 0, 0, 'blue'), b = r.mk(meleeType, 140, 0, 'red');
  const hp0 = b.currentHP;
  r.combat.performAttack(a, b);
  T('远程小兵开火 → 生成弹道', r.proj.getProjectiles().length === 1);
  T('开火瞬间伤害未结算', b.currentHP === hp0);
  T('弹丸渲染尺寸 = 12（小兵小一号）', r.proj.getProjectiles()[0]?.size === 12);
  T('缺 bulletSpeed 的兵种取默认弹速 400', r.proj.getProjectiles()[0]?.speed === 400);
  let t = 0, hitAt = null;
  while (t < 1.5 && hitAt === null) { r.proj.update(1 / 30); t += 1 / 30; if (b.currentHP < hp0) hitAt = t; }
  T('伤害在飞行结束时结算（140px÷400 ≈ 0.35s）', hitAt > 0.30 && hitAt < 0.42, `命中于 ${hitAt?.toFixed(3)}s`);
  T('命中后弹道回收', r.proj.getProjectiles().length === 0);
}
// 2. 近战：无弹道 + 瞬时
{
  const r = rig();
  const a = r.mk(meleeType, 0, 0, 'blue'), b = r.mk(meleeType, 25, 0, 'red');
  const hp0 = b.currentHP;
  r.combat.performAttack(a, b);
  T('近战不生成可见弹道', r.proj.getProjectiles().length === 0);
  T('近战伤害瞬时生效（视作弹速无穷）', b.currentHP < hp0);
}
// 3. 塔：未被改坏
{
  const r = rig();
  const a = r.mk('tower', 0, 0, 'blue'), b = r.mk(meleeType, 180, 0, 'red');
  a.baseStats.attackDamage = 50; a.baseStats.baseAttackSpeed = 1;
  r.combat.performAttack(a, b);
  const bl = r.proj.getProjectiles()[0];
  T('塔仍生成弹道', !!bl);
  T('塔弹渲染尺寸仍 = 20', bl?.size === 20);
}
// 4. 目标中途死亡
{
  const r = rig();
  const a = r.mk(rangedType, 0, 0, 'blue'), b = r.mk(meleeType, 140, 0, 'red');
  r.combat.performAttack(a, b);
  r.proj.update(1 / 30);
  b.alive = false; b.currentHP = 0;
  for (let i = 0; i < 30; i++) r.proj.update(1 / 30);
  T('目标中途死亡 → 弹道清除', r.proj.getProjectiles().length === 0);
  T('不对尸体结算伤害', b.currentHP === 0);
}
// 5. 追踪移动目标
{
  const r = rig();
  const a = r.mk(rangedType, 0, 0, 'blue'), b = r.mk(meleeType, 140, 0, 'red');
  const hp0 = b.currentHP;
  r.combat.performAttack(a, b);
  let t = 0, hit = false;
  while (t < 3 && !hit) { b.pos.y += 78 / 30; r.proj.update(1 / 30); t += 1 / 30; if (b.currentHP < hp0) hit = true; }
  T('目标移动时仍能命中（弹道追踪）', hit, `耗时 ${t.toFixed(2)}s`);
}
// 6. 压力：40 远程兵混战，峰值在飞弹数（验证"防卡顿"顾虑是否成立）
{
  const r = rig();
  const atk = [], def = [];
  for (let i = 0; i < 40; i++) atk.push(r.mk(rangedType, 0, i * 20, 'blue'));
  for (let i = 0; i < 40; i++) def.push(r.mk(meleeType, 140, i * 20, 'red'));
  for (const d of def) { d.currentHP = 1e9; d.baseStats.maxHP = 1e9; }
  let peak = 0;
  for (let f = 0; f < 300; f++) {
    if (f % 30 === 0) for (let i = 0; i < 40; i++) r.combat.performAttack(atk[i], def[i]);
    r.proj.update(1 / 30);
    peak = Math.max(peak, r.proj.getProjectiles().length);
  }
  T('40 远程兵齐射峰值在飞弹 < 60（性能顾虑不成立）', peak < 60, `峰值 ${peak}`);
  T('10 秒后无弹道泄漏', r.proj.getProjectiles().length < 40);
}
// 7. 全兵种覆盖：每个远程模板都必须真的产生弹道，每个近战模板都必须瞬时
{
  for (const [k, v] of Object.entries(CONFIG.templates)) {
    if (k === 'tower' || k === 'dragon') continue;
    const r = rig();
    const a = r.mk(k, 0, 0, 'blue');
    const dist = Math.max(10, (v.attackRange ?? 20) - 10);
    const b = r.mk('melee', dist, 0, 'red');
    b.currentHP = 1e9; b.baseStats.maxHP = 1e9;
    const hp0 = b.currentHP;
    r.combat.performAttack(a, b);
    const isM = (v.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD;
    const n = r.proj.getProjectiles().length;
    if (isM) T(`【${v.label || k}】近战 → 无弹道且瞬时`, n === 0 && b.currentHP < hp0);
    else     T(`【${v.label || k}】远程 → 有弹道且未即时结算`, n === 1 && b.currentHP === hp0);
  }
}
console.log(`\nQ1 弹道统一: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
