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

// ==================== 四、修复：节点内正常效率，节点外33%效率突破封顶 ====================
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

  tower.currentHP = tower._regenCapHP; // 已经顶到节点
  const before2 = tower.currentHP;
  lms._updateEngineer(eng, 1);
  const gained2 = tower.currentHP - before2;
  T('修复②-顶到节点后，继续修复按33%效率突破封顶（而不是被封顶挡住不再增长）',
    gained2 > 0 && Math.abs(gained2 - c.repairPerSec * (c.overflowEfficiencyPct / 100)) < 1e-6);

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
  T('接线③-出厂默认技能清单存在且为空（行为由移动系统驱动，不是技能系统）',
    Array.isArray(DEFAULT_MINION_PASSIVES.engineer) && DEFAULT_MINION_PASSIVES.engineer.length === 0);
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

done();
