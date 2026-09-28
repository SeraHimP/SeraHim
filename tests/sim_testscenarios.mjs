/**
 * sim_testscenarios.mjs —— 平衡测试专用技能（passive_test_tower_attacker /
 * passive_test_minion_attacker，见 src/core/skills/testScenarios.js）验收。
 *
 * 这两条技能是塔平衡横向对照工具（tools/balance_tower.mjs）第一版返工的直接
 * 产物：用户反馈"进攻方获得的属性加成通过永久状态实现"——即这套增益必须是
 * SkillLibrary 里真实存在、能在编辑器/游戏里手动装配观察到的技能，不能只活在
 * 某个脚本的内存模拟里。这里钉住"装了确实生效、卸了确实清理干净"这条行为
 * 形状，不钉具体数值（数值改动走 defaultParams，属于正常调参，不该让这份
 * 测试变红）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('平衡测试专用技能（testScenarios）验收');

// ==================== 一、注册 + 基本字段 ====================
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const tower = SkillLibrary.get('passive_test_tower_attacker');
  const minion = SkillLibrary.get('passive_test_minion_attacker');
  T('注①-passive_test_tower_attacker 已注册进 SkillLibrary', !!tower);
  T('注②-passive_test_minion_attacker 已注册进 SkillLibrary', !!minion);
  T('注③-塔技能只对 tower 生效', JSON.stringify(tower.applicableTypes) === JSON.stringify(['tower']));
  T('注④-小兵技能覆盖内置小兵类型（不含tower）', minion.applicableTypes.includes('melee') && !minion.applicableTypes.includes('tower'));
}

// ==================== 二、装到塔上：伤害减免/增幅生效，武器不受影响 ====================
// 2026-09-21：用户要求"测试技能中删除强制替换闪电杖"——这条技能装上之后
// 塔原有的武器必须原样保留，不再被换成闪电杖。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { equipSkill } = await import('../src/core/skillParams.js');
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  // 先给它装一把原有武器，验证这条技能不会动它。
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const ctx0 = { entityContainer: ents, effectRegistry: fx, eventBus: null, attrCalc: attr, combat, waveNumber: 0 };
  equipSkill(tower, 'weapon_piercing', ctx0, SkillLibrary);
  T('装配①-装备前带着穿透型武器', tower._skillInstances.some(s => s.skillId === 'weapon_piercing'));

  equipSkill(tower, 'passive_test_tower_attacker', ctx0, SkillLibrary);
  T('装配②-穿透型武器原样保留（不再强制换成闪电杖）',
    tower._skillInstances.some(s => s.skillId === 'weapon_piercing'));
  T('装配③-没有被凭空装上闪电杖', !tower._skillInstances.some(s => s.skillId === 'weapon_lightning'));

  const stats = attr.calc(tower, fx.getEffects(tower.id));
  T('装配④-伤害减免生效（默认90%）', stats.damageReduction === 90);
  T('装配⑤-伤害增幅生效（默认1000%）', stats.damageAmpPct === 1000);

  const names = fx.getEffects(tower.id).map(e => e.blueprint.name);
  T('装配⑥-状态栏能看到"进攻方强化"（用户原话"通过永久状态实现"，必须是真实可见的状态）',
    names.includes('进攻方强化'));
}

// ==================== 三、水晶枢纽/召唤水晶不会被凭空装出武器 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { equipSkill } = await import('../src/core/skillParams.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const nexus = mkEntity(ents, 'tower', { faction: 'blue', tier: 'nexus_main', pos: { x: 0, y: 0 } }, CONFIG);
  const ctx0 = { entityContainer: ents, effectRegistry: fx, eventBus: null, attrCalc: attr, combat, waveNumber: 0 };
  equipSkill(nexus, 'passive_test_tower_attacker', ctx0, SkillLibrary);
  T('枢纽①-水晶枢纽装这条技能后仍然没有任何 weapon_* 实例（本来就不该攻击）',
    !(nexus._skillInstances || []).some(s => s.skillId?.startsWith('weapon_')));
  const stats = attr.calc(nexus, fx.getEffects(nexus.id));
  T('枢纽②-伤害减免/增幅依旧生效（"所有防御塔"字面意思，水晶枢纽也是塔）',
    stats.damageReduction === 90 && stats.damageAmpPct === 1000);
}

// ==================== 四、卸下技能：效果清理干净 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { equipSkill } = await import('../src/core/skillParams.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const ctx0 = { entityContainer: ents, effectRegistry: fx, eventBus: null, attrCalc: attr, combat, waveNumber: 0 };
  const inst = equipSkill(tower, 'passive_test_tower_attacker', ctx0, SkillLibrary);
  const def = SkillLibrary.get('passive_test_tower_attacker');
  def.onUnequip(tower.id, inst, ctx0);
  const stats = attr.calc(tower, fx.getEffects(tower.id));
  T('卸下①-伤害减免归零（技能自己挂的效果被摘干净）', !stats.damageReduction);
  T('卸下②-伤害增幅归零', !stats.damageAmpPct);
}

// ==================== 五、小兵版：只有减伤，没有武器/增幅那一套 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { equipSkill } = await import('../src/core/skillParams.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const minion = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const ctx0 = { entityContainer: ents, effectRegistry: fx, eventBus: null, attrCalc: attr, combat, waveNumber: 0 };
  equipSkill(minion, 'passive_test_minion_attacker', ctx0, SkillLibrary);
  const stats = attr.calc(minion, fx.getEffects(minion.id));
  T('小兵①-伤害减免生效（默认33%）', stats.damageReduction === 33);
  T('小兵②-没有伤害增幅（用户原话只给小兵减伤，没提增幅）', !stats.damageAmpPct);
}

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

done();
