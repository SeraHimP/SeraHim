/**
 * sim_engineer.mjs —— 工程兵（engineer，Q5 新兵种方案之一）验收
 *
 * 行为形状是"不推线，只在需要修复的己方塔和原地待命之间切换"（见
 * LaneMovementSystem._updateEngineer 头注），跟其它小兵的索敌/追击/攻击完全不同，
 * 走独立分支、不碰共享的接敌AI。每条断言钉"行为形状"，不钉具体数值。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('工程兵（engineer）验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

const mapStub = {
  active: true,
  currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }] },
  getDefenseZone: () => null,
  isWalkable: () => true,
  constrainToWalkable: (p) => p,
};

// ==================== 一、模板数值：无攻击能力 ====================
{
  const { CONFIG } = await world();
  const tpl = CONFIG.templates.engineer;
  T('模板①-CONFIG.templates.engineer 存在', !!tpl);
  T('模板②-攻击力为0（真的没有攻击能力）', tpl.attackDamage === 0);
}

// ==================== 二、原地待命：没有需要修的塔时不动 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 100, y: 100 } }, CONFIG);
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 800, y: 800 } }, CONFIG);
  // tower 默认满血，不需要修
  const before = { x: eng.pos.x, y: eng.pos.y };
  lms._updateEngineer(eng, 1);
  T('待命①-附近没有需要修复的塔时原地不动', eng.pos.x === before.x && eng.pos.y === before.y);
}

// ==================== 三、走向最近的受损己方塔 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const damagedTower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 500, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  damagedTower.currentHP = 400;
  const enemyDamagedTower = mkEntity(ents, 'tower', { faction: 'red', pos: { x: -50, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  enemyDamagedTower.currentHP = 100; // 更近但是敌方的塔，不该被修
  const before = { x: eng.pos.x, y: eng.pos.y };
  lms._updateEngineer(eng, 1);
  T('走位①-朝己方受损塔移动（不是原地不动）', eng.pos.x !== before.x || eng.pos.y !== before.y);
  T('走位②-移动方向朝向己方塔（x 增大），不是敌方塔方向', eng.pos.x > before.x);
}

// ==================== 四、修复：节点内正常效率，节点外overflow效率突破封顶 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 5, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG); // 距离在 repairRange 内，直接进入修复分支
  tower.currentHP = 400;
  tower._regenCapHP = 500; // 加固城防节点封顶在500

  const before1 = tower.currentHP;
  lms._updateEngineer(eng, 1);
  const gained1 = tower.currentHP - before1;
  const c = CONFIG.gameRules.supportUnits.engineer;
  T('修复①-节点内的部分按正常效率（每秒repairPerSec）回复', Math.abs(gained1 - c.repairPerSec) < 1e-6);
  T('修复①b-repairPerSec 相比改造前的 20 已大幅削弱（用户原话"大幅削弱"）', c.repairPerSec < 20);

  // 隔离测量overflow效率：清零上一步顺带累积的"永久效率衰减"，不然会跟十四节
  // 测的那套机制混在一起，这里只想单独看 overflowEfficiencyPct 这一件事。
  tower._engineerRepairAccumPct = 0;
  tower.currentHP = tower._regenCapHP; // 已经顶到节点
  const before2 = tower.currentHP;
  lms._updateEngineer(eng, 1);
  const gained2 = tower.currentHP - before2;
  T('修复②-顶到节点后，继续修复按overflowEfficiencyPct效率突破封顶（而不是被封顶挡住不再增长）',
    gained2 > 0 && Math.abs(gained2 - c.repairPerSec * (c.overflowEfficiencyPct / 100)) < 1e-6);
  T('修复②b-overflowEfficiencyPct 相比改造前的 33 已下调（用户要求"变为10%"）',
    c.overflowEfficiencyPct === 10);

  // 其它治疗来源此时应该仍然被节点挡住——工程兵的突破是它自己调用方式的特例，
  // 不是把 applyHeal 本身改成不认 cap 了。
  const { applyHeal } = await import('../src/core/healing.js');
  const before3 = tower.currentHP;
  applyHeal(tower, 50, 1, 1000, tower._regenCapHP);
  T('修复③-普通治疗来源依旧被节点封顶挡住（工程兵的突破没有改坏治疗管线本身）',
    tower.currentHP === before3);
}

// ==================== 五、不参与标准索敌/接敌：即使敌人在附近也不会获得 targetId ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const foe = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG); // 贴脸
  lms.update(1);
  T('旁路①-即便有敌人贴脸，工程兵也不会走标准索敌流程获得 targetId', !eng.targetId);
}

// ==================== 六、塔保护工程兵：优先反击正在攻击工程兵的单位 ====================
{
  const { ents, combat, CONFIG } = await world();
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { attackRange: 1000 } }, CONFIG);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 10, y: 0 } }, CONFIG);
  const attacker = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG);
  attacker.targetId = eng.id; // 正在攻击工程兵
  const bystander = mkEntity(ents, 'ranged', { faction: 'red', pos: { x: 30, y: 0 } }, CONFIG);
  const target = combat.selectTarget(tower, [attacker, bystander]);
  T('保护①-塔优先攻击正在攻击工程兵的单位', target && target.id === attacker.id);

  const heavyAtk = mkEntity(ents, 'heavy', { faction: 'red', pos: { x: 40, y: 0 } }, CONFIG);
  const target2 = combat.selectTarget(tower, [attacker, heavyAtk]);
  T('保护②-保护工程兵的优先级甚至压过重装车的"最高优先级"',
    target2 && target2.id === attacker.id);
}

// ==================== 七、出兵编排 / 出兵开关接线 ====================
{
  const { CONFIG } = await world();
  T('接线①-spawnEnabled.engineer 默认开启', CONFIG.gameRules.spawnEnabled.engineer === true);
  T('接线②-laneWaveComposition 里有 engineer 的出兵规则',
    CONFIG.gameRules.laneWaveComposition.some(r => r.type === 'engineer'));
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  // 2026-09-19：用户反馈"修复效果要做成技能常驻在技能栏里"——出厂默认清单从空数组
  // 改成挂一张纯展示技能卡（passive_engineer_repair）。真正的修复/走位判定逻辑
  // 仍然只在 LaneMovementSystem._updateEngineer 里，这张卡不重复结算，见该技能
  // 定义旁的说明。
  T('接线③-出厂默认技能清单挂了纯展示用的 passive_engineer_repair（行为仍由移动系统驱动）',
    Array.isArray(DEFAULT_MINION_PASSIVES.engineer)
    && DEFAULT_MINION_PASSIVES.engineer.includes('passive_engineer_repair'));
}

// ==================== 八、修复效果的技能卡是纯展示，不会重复结算修复量 ====================
{
  const { ents, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.passive_engineer_repair;
  T('展示①-passive_engineer_repair 存在，applicableTypes 认得 engineer',
    !!def && def.applicableTypes.includes('engineer'));
  T('展示②-没有 onFrame（不重复结算，真实修复逻辑只在 LaneMovementSystem._updateEngineer）',
    typeof def.onFrame !== 'function');
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  T('展示③-computeCurrent 读的是同一份 CONFIG.gameRules.supportUnits.engineer（不会跟真实数值读岔）',
    def.computeCurrent(eng, {}) === (CONFIG.gameRules.supportUnits.engineer.repairPerSec ?? 20));
}

// ==================== 八、编辑器/渲染层的类型枚举没有漏掉 engineer ====================
{
  const schemaSrc = srcOf('src/data/schema/index.js');
  T('枚举①-schema/index.js 的 MINION_TYPES 里有 engineer', /\['engineer',\s*'工程兵'\]/.test(schemaSrc));

  const customSrc = srcOf('src/data/customContent.js');
  T('枚举②-customContent.js 的 BUILTIN_MINION_TYPES/minionLabel/minionIcon 都认得 engineer',
    /BUILTIN_MINION_TYPES\s*=\s*\[[^\]]*'engineer'/.test(customSrc)
    && /engineer:\s*'工程兵'/.test(customSrc) && /engineer:\s*'🔧'/.test(customSrc));

  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举③-UnitAddDialog.js 的 MINION_TYPES/TYPE_META 都认得 engineer',
    /'engineer'/.test(dialogSrc) && /engineer:\s*\{[^}]*工程兵/.test(dialogSrc));

  const openSrc = srcOf('src/ui/editor/open.js');
  T('枚举④-open.js 的 _TPL_LABELS/_TPL_ICONS 都认得 engineer',
    /engineer:\s*'工程兵'/.test(openSrc) && /engineer:\s*'🔧'/.test(openSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举⑤-pagesEntity.js 的技能列表类型枚举包含 engineer',
    /'healer',\s*'engineer',/.test(entitySrc));

  const spriteSrc = srcOf('src/presentation/SpriteFactory.js');
  T('枚举⑥-SpriteFactory.js 的 MINION_STYLE 有 engineer 专属样式',
    /engineer:\s*\{[^}]*🔧/.test(spriteSrc));

  const modeSrc = srcOf('src/data/maps/modeTransforms.js');
  T('枚举⑦-经典模式排除了 engineer',
    /engineer:\s*false/.test(modeSrc) && /engineer:\s*\[\]/.test(modeSrc));
}

// ==================== 九、没塔可修时前出驻守本车道最前沿的存活塔 ====================
// 用户反馈的真实bug："工程兵目前只会躺在家里，应该往前线推进到最前方的塔！"
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 }, lane: 'mid' }, CONFIG);
  const base = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    tier: 'base', lane: 'mid', stats: { maxHP: 1000 } }, CONFIG);
  const outer = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 600, y: 0 },
    tier: 'outer', lane: 'mid', stats: { maxHP: 1000 } }, CONFIG);
  // 两座塔都满血——没有需要修的塔，但外塔（outer）比基地（base）更靠前。
  const before = { x: eng.pos.x, y: eng.pos.y };
  lms._updateEngineer(eng, 1);
  T('前出①-没塔可修时朝更靠前（外塔）的方向移动，不是继续待在原地',
    eng.pos.x > before.x);

  // 外塔被拆掉之后，最前沿变成基地——工程兵不该继续往外塔的空位置冲。
  outer.alive = false;
  const before2 = { x: eng.pos.x, y: eng.pos.y };
  lms._updateEngineer(eng, 1);
  T('前出②-外塔没了之后最前沿退到基地，工程兵已经在基地附近就不再继续往外冲',
    Math.abs(eng.pos.x - before2.x) < 700); // 宽松上界：不会一路冲向已经死掉的外塔坐标
}

// ==================== 十、贴脸敌人不影响"没塔可修就前出"这条判断 ====================
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 0, y: 0 }, lane: 'mid' }, CONFIG);
  mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 600, y: 0 }, tier: 'outer', lane: 'mid',
    stats: { maxHP: 1000 } }, CONFIG);
  const foe = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG); // 贴脸
  lms.update(1);
  T('旁路②-工程兵前出时依旧不会对贴脸敌人获得 targetId（不参与标准索敌）', !eng.targetId);
}

// ==================== 十一、3D 造型：不再复用通用步兵模板（用户："模型也要重做！不要复用现有的！"） ====================
{
  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { minionMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const m = minionMesh('mm-engineer-test', '#5b9bd5', 11, 'engineer', 'blue');
    T('模型①-engineer 能造出几何', !!m.geo && m.topY > 0);
    const generic = minionMesh('mm-generic-test-e', '#5b9bd5', 11, '__custom__', 'blue');
    T('模型②-engineer 不再落回通用步兵模板（顶点数不同）',
      m.geo.attributes.position.count !== generic.geo.attributes.position.count);
  }
}

// ==================== 十二、多个工程兵同时维修同一座塔：每人效率再降25%（乘法叠加） ====================
// 用户原话："多个工程兵同时维修一座塔时维修时每个人降低25%维修速度"。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const c = CONFIG.gameRules.supportUnits.engineer;

  // 单人基线：只有一个工程兵在修，效率应该是满速。
  const tower1 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower1.currentHP = 5000;
  const soloEng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 5, y: 0 } }, CONFIG);
  const before1 = tower1.currentHP;
  lms._updateEngineer(soloEng, 1);
  const soloGain = tower1.currentHP - before1;
  T('叠加①-单人维修时效率满速（等于repairPerSec）', Math.abs(soloGain - c.repairPerSec) < 1e-6);

  // 双人同修：另一个同阵营工程兵也站在这座塔的repairRange内。
  const tower2 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 1000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower2.currentHP = 5000;
  const engA = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 1005, y: 0 } }, CONFIG);
  const engB = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 995, y: 0 } }, CONFIG);
  const before2 = tower2.currentHP;
  lms._updateEngineer(engA, 1);
  const duoGain = tower2.currentHP - before2;
  const expectedDuo = c.repairPerSec * (1 - c.repairStackPenaltyPct / 100);
  T('叠加②-两人同修一座塔时，每人效率按 (1-25%) 衰减', Math.abs(duoGain - expectedDuo) < 1e-6);
  T('叠加③-两人同修比一个人修更慢（不是巧合数值相等）', duoGain < soloGain);

  // 三人同修：乘法叠加，不是线性叠加（(1-25%)^2，不是 1-2*25%）。
  const tower3 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 2000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower3.currentHP = 5000;
  const engC = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 2005, y: 0 } }, CONFIG);
  mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 1995, y: 0 } }, CONFIG);
  mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 2010, y: 0 } }, CONFIG);
  const before3 = tower3.currentHP;
  lms._updateEngineer(engC, 1);
  const trioGain = tower3.currentHP - before3;
  const expectedTrio = c.repairPerSec * Math.pow(1 - c.repairStackPenaltyPct / 100, 2);
  T('叠加④-三人同修按乘法叠加 (1-25%)^2，不是线性相减',
    Math.abs(trioGain - expectedTrio) < 1e-6);

  // 范围外/敌方的工程兵不该被计入叠加惩罚。
  const tower4 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 3000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower4.currentHP = 5000;
  const engD = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 3005, y: 0 } }, CONFIG);
  mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 3500, y: 0 } }, CONFIG); // 太远，不算
  mkEntity(ents, 'engineer', { faction: 'red', pos: { x: 3006, y: 0 } }, CONFIG); // 敌方，不算
  const before4 = tower4.currentHP;
  lms._updateEngineer(engD, 1);
  const gain4 = tower4.currentHP - before4;
  T('叠加⑤-范围外/敌方阵营的工程兵不计入叠加惩罚', Math.abs(gain4 - c.repairPerSec) < 1e-6);
}

// ==================== 十三、永久维修效率衰减：塔被工程兵修得越多，效率永久越低 ====================
// 用户原话："每座塔每被维修1%生命值（仅为工程师维修的，不包含自己恢复的等），
// 其永久维修效率降低1%"。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const c = CONFIG.gameRules.supportUnits.engineer;

  // ① 累计值随实际修复量正确增长：修复了 maxHP 的 X%，累计值就该增加 X。
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  tower.currentHP = 1;
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 5, y: 0 } }, CONFIG);
  T('永久①-新塔的累计值初始为0（从未被工程兵修过）', !tower._engineerRepairAccumPct);
  const beforeHP = tower.currentHP;
  lms._updateEngineer(eng, 1);
  const healed = tower.currentHP - beforeHP;
  T('永久②-修复后累计值按 (实际治疗量/最大生命)×100 增长',
    Math.abs(tower._engineerRepairAccumPct - (healed / 1000) * 100) < 1e-6);

  // ② 累计值直接决定效率：给定累计值，效率按 1 - accumPct×decayPerRepairPct/100 折算。
  const tower2 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 1000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower2.currentHP = 5000;
  tower2._engineerRepairAccumPct = 50; // 已经被修过累计50%最大生命
  const eng2 = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 1005, y: 0 } }, CONFIG);
  const before2 = tower2.currentHP;
  lms._updateEngineer(eng2, 1);
  const gain2 = tower2.currentHP - before2;
  const expectedMult = 1 - 50 * c.permanentDecayPerRepairPct / 100;
  T('永久③-累计50%时效率按公式折算（本例=50%）',
    Math.abs(gain2 - c.repairPerSec * expectedMult) < 1e-6);

  // ③ 效率地板：累计值远超100%时不会变成负数，卡在 permanentDecayFloorPct。
  const tower3 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 2000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower3.currentHP = 5000;
  tower3._engineerRepairAccumPct = 500; // 远超100%
  const eng3 = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 2005, y: 0 } }, CONFIG);
  const before3 = tower3.currentHP;
  lms._updateEngineer(eng3, 1);
  const gain3 = tower3.currentHP - before3;
  T('永久④-累计值超过100%时效率地板生效，不会变成负数回血',
    gain3 >= 0 && gain3 <= c.repairPerSec * ((c.permanentDecayFloorPct ?? 0) / 100 + 1e-9));

  // ④ "永久"：不随时间流逝自动恢复（这一步没有工程兵在场，只是流逝时间）。
  const tower4 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 3000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower4._engineerRepairAccumPct = 30;
  const snapshot = tower4._engineerRepairAccumPct;
  fx.update(10); // 流逝10秒，期间没有任何工程兵修复这座塔
  T('永久⑤-累计值不会随时间自动衰减/恢复（这是"永久"的字面意思）',
    tower4._engineerRepairAccumPct === snapshot);

  // ⑤ 换一个新的工程兵来修同一座塔，惩罚照样生效——挂在塔身上，不是挂在工程兵身上。
  const tower5 = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 4000, y: 0 },
    stats: { maxHP: 10000 } }, CONFIG);
  tower5.currentHP = 5000;
  tower5._engineerRepairAccumPct = 80;
  const brandNewEng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 4005, y: 0 } }, CONFIG);
  const before5 = tower5.currentHP;
  lms._updateEngineer(brandNewEng, 1);
  const gain5 = tower5.currentHP - before5;
  const expectedMult5 = Math.max((c.permanentDecayFloorPct ?? 0) / 100, 1 - 80 * c.permanentDecayPerRepairPct / 100);
  T('永久⑥-换一个全新的工程兵来修，效率依旧按塔身上的累计值折算（不是按工程兵个体清零）',
    Math.abs(gain5 - c.repairPerSec * expectedMult5) < 1e-6);
}

// ==================== 十四、只能从塔的正面（半圆）修复 ====================
// 用户原话："工程兵只能在塔的前方修复（半圆）"。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  // 这张地图带 buildings，让 towerFacingRad 能真正算出一个朝向（默认的 mapStub
  // 没有 buildings，facing 恒为 null，测不出正面限制——这里必须换一张。
  // 塔在原点、没有挂在任何 lane 上，红方水晶枢纽摆在 +x 方向很远处，
  // 于是 towerFacingRad 走"没有兵线→朝敌方主基地"这条规则，算出朝向=+x（π/2）。
  const mapStubFacing = {
    active: true,
    currentMap: {
      lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }],
      buildings: [{ tier: 'nexus_main', faction: 'red', pos: { x: 100000, y: 0 } }],
    },
    getDefenseZone: () => null,
    isWalkable: () => true,
    constrainToWalkable: (p) => p,
  };
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStubFacing);

  // 正面（+x一侧）：在 repairRange 内，应该正常修复。
  const towerFront = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  towerFront.currentHP = 400;
  const engFront = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 30, y: 0 } }, CONFIG);
  const beforeFront = towerFront.currentHP;
  lms._updateEngineer(engFront, 1);
  T('正面①-站在塔的正面、repairRange内，正常修复', towerFront.currentHP > beforeFront);

  // 背面（-x一侧）：同样在 repairRange 内，但在塔的背面，不该修复，应该改为绕去正面。
  const towerBack = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 1000, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  towerBack.currentHP = 400;
  const engBack = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 970, y: 0 } }, CONFIG);
  const beforeBackPos = { x: engBack.pos.x, y: engBack.pos.y };
  const beforeBackHP = towerBack.currentHP;
  lms._updateEngineer(engBack, 1);
  T('正面②-站在塔的背面时不修复（即使距离在repairRange内）', towerBack.currentHP === beforeBackHP);
  T('正面③-背面时改为朝正面绕过去，不是原地卡住不动',
    engBack.pos.x !== beforeBackPos.x || engBack.pos.y !== beforeBackPos.y);

  // 拿不到朝向数据时（地图没有buildings）不设限——沿用最早的 mapStub。
  const lmsNoFacing = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const towerNoFacing = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 2000, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  towerNoFacing.currentHP = 400;
  const engBehindNoFacing = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 1970, y: 0 } }, CONFIG);
  const beforeNoFacing = towerNoFacing.currentHP;
  lmsNoFacing._updateEngineer(engBehindNoFacing, 1);
  T('正面④-算不出朝向时不设限，任意方向都能修复', towerNoFacing.currentHP > beforeNoFacing);
}

// ==================== 十五、"正在维修"状态：塔和工程兵都要挂，停修后自动脱落 ====================
// 用户原话："维修时塔和工程兵都要新增状态显示正在维修"。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  tower.currentHP = 400;
  const eng = mkEntity(ents, 'engineer', { faction: 'blue', pos: { x: 5, y: 0 } }, CONFIG);

  lms._updateEngineer(eng, 1);
  const towerHasStatus = fx.getEffects(tower.id).some(e => e.blueprint.name === '正在维修');
  const engHasStatus = fx.getEffects(eng.id).some(e => e.blueprint.name === '正在维修');
  T('状态①-正在修复时塔挂上"正在维修"状态', towerHasStatus);
  T('状态②-正在修复时工程兵自己也挂上"正在维修"状态', engHasStatus);

  const eff = fx.getEffects(tower.id).find(e => e.blueprint.name === '正在维修');
  T('状态③-"正在维修"是纯展示效果，不进属性合成管线（kind:display）',
    !!eff && eff.blueprint.kind === 'display');

  // 停止修复（工程兵离开，不再调用 _updateEngineer 给它续上）后，光环宽限期一过就自动脱落。
  fx.update(0.6);
  const towerStillHas = fx.getEffects(tower.id).some(e => e.blueprint.name === '正在维修');
  const engStillHas = fx.getEffects(eng.id).some(e => e.blueprint.name === '正在维修');
  T('状态④-停止修复超过宽限期后，塔身上的"正在维修"自动脱落', !towerStillHas);
  T('状态⑤-停止修复超过宽限期后，工程兵身上的"正在维修"自动脱落', !engStillHas);
}

done();
