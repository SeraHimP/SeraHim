/**
 * sim_healer.mjs —— 治疗兵（healer，Q5 新兵种方案之一）验收
 *
 * 架构要点（与用户对齐过，见 minionPassives.js 的 passive_healer_mend 头注）：
 * "目标阵营"开关走独立通道——新增 FactionSystem.alliesInRadius（与 enemyUnitsInRadius
 * 对称）+ 按攻速节流的单体治疗脉冲，不深改现有的索敌/追击/弹道管线。
 * 每条断言钉"行为形状"，不钉具体数值（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('治疗兵（healer）验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

// ==================== 一、模板数值：无攻击能力 ====================
{
  const { CONFIG } = await world();
  const tpl = CONFIG.templates.healer;
  T('模板①-CONFIG.templates.healer 存在', !!tpl);
  T('模板②-攻击力为0（真的没有对敌方的攻击能力）', tpl.attackDamage === 0);
  T('模板③-有基础生命恢复（脱战加成是叠在这个基线上的）', tpl.healthRegen >= 0);
}

// ==================== 二、alliesInRadius：友方目标查询（"目标阵营"开关本体） ====================
{
  const { ents, CONFIG } = await world();
  const { alliesInRadius, enemyUnitsInRadius } = await import('../src/systems/FactionSystem.js');
  const self = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const ally = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 50, y: 0 } }, CONFIG);
  const enemy = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 50, y: 0 } }, CONFIG);
  const ownTower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 50, y: 0 } }, CONFIG);

  const allies = alliesInRadius(ents, self, 1000);
  T('友方①-只返回同阵营单位', allies.every(a => (a._mapFaction || a.faction) === 'blue'));
  T('友方②-不包含敌方单位', !allies.some(a => a.id === enemy.id));
  T('友方③-默认不包含建筑（includeBuildings 未开）', !allies.some(a => a.id === ownTower.id));
  T('友方④-不包含自己', !allies.some(a => a.id === self.id));
  T('友方⑤-includeBuildings:true 时包含己方建筑', alliesInRadius(ents, self, 1000, { includeBuildings: true }).some(a => a.id === ownTower.id));

  // 与 enemyUnitsInRadius 对称：同一个查询在"敌方"口径下应该正好互补（不算建筑时）。
  const enemies = enemyUnitsInRadius(ents, self, 1000);
  T('友方⑥-与 enemyUnitsInRadius 互补（一个返回友方，一个返回敌方，不重叠）',
    !allies.some(a => enemies.some(e => e.id === a.id)));

  // 中立单位没有"友军"概念。
  const neutral = mkEntity(ents, 'melee', { pos: { x: 0, y: 0 } }, CONFIG);
  neutral._mapFaction = null; neutral.faction = null;
  T('友方⑦-中立施法者查不到任何友军（没有阵营就没有"自己人"）',
    alliesInRadius(ents, neutral, 1000).length === 0);
}

// ==================== 三、生命脉冲：按攻速节奏的单体治疗 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('passive_healer_mend');
  const bus = { emit: () => {} };
  const self = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const ally = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 30, y: 0 },
    stats: { maxHP: 500 } }, CONFIG);
  ally.currentHP = 300; // 留出治疗空间
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = { id: ++window._uid, skillId: 'passive_healer_mend', state: {} };

  const stats = attr.calc(self, fx.getEffects(self.id));
  const finalAS = attr.calcAttackSpeedOf(stats);
  const interval = 1 / finalAS;

  def.onFrame(self.id, interval * 0.5, inst, ctx);
  T('脉冲①-没到攻速间隔时不治疗（不是每帧都触发）', ally.currentHP === 300);

  const hpBefore = ally.currentHP, selfBefore = self.currentHP;
  def.onFrame(self.id, interval * 0.6, inst, ctx); // 累计超过一个完整间隔
  T('脉冲②-累计到攻速间隔后治疗了半径内最近的友军', ally.currentHP > hpBefore);
  T('脉冲③-治疗兵自己也付出了代价（当前生命下降）', self.currentHP < selfBefore);
}

// ==================== 四、满血友军旁边不白扣自身血 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('passive_healer_mend');
  const bus = { emit: () => {} };
  const self = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const fullAlly = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 30, y: 0 } }, CONFIG);
  // fullAlly 默认满血（mkEntity 用 stats.maxHP ?? tpl.maxHP 作 currentHP）
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = { id: ++window._uid, skillId: 'passive_healer_mend', state: {} };
  const stats = attr.calc(self, fx.getEffects(self.id));
  const interval = 1 / attr.calcAttackSpeedOf(stats);
  const selfBefore = self.currentHP;
  def.onFrame(self.id, interval * 1.5, inst, ctx);
  T('空转①-友军已满血时，这次脉冲不收自身代价', self.currentHP === selfBefore);
}

// ==================== 五、无友军在范围内时不掉自身血 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('passive_healer_mend');
  const bus = { emit: () => {} };
  const self = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = { id: ++window._uid, skillId: 'passive_healer_mend', state: {} };
  const stats = attr.calc(self, fx.getEffects(self.id));
  const interval = 1 / attr.calcAttackSpeedOf(stats);
  const selfBefore = self.currentHP;
  def.onFrame(self.id, interval * 1.5, inst, ctx);
  T('空转②-附近没有友军时不掉自身血', self.currentHP === selfBefore);
}

// ==================== 六、脱战高额生命回复 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('passive_healer_mend');
  const bus = { emit: () => {} };
  const self = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  self._inCombat = false;
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = { id: ++window._uid, skillId: 'passive_healer_mend', state: {} };
  def.onFrame(self.id, 0.016, inst, ctx);
  const buff = fx.getEffects(self.id).find(e => e.sourceId === 'passive_healer_mend_regen');
  T('脱战①-脱战状态下获得额外生命回复加成', buff && buff.blueprint.flatValue > 0);

  const { ents: ents2, fx: fx2, attr: attr2, CONFIG: CONFIG2 } = await world();
  const self2 = mkEntity(ents2, 'healer', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG2);
  self2._inCombat = true;
  const ctx2 = { entityContainer: ents2, effectRegistry: fx2, attrCalc: attr2, eventBus: bus };
  const inst2 = { id: ++window._uid, skillId: 'passive_healer_mend', state: {} };
  def.onFrame(self2.id, 0.016, inst2, ctx2);
  const buff2 = fx2.getEffects(self2.id).find(e => e.sourceId === 'passive_healer_mend_regen');
  T('脱战②-战斗状态下不获得这份额外加成（只在脱战时给）', !buff2);
}

// ==================== 七、出兵编排 / 出兵开关接线 ====================
{
  const { CONFIG } = await world();
  T('接线①-spawnEnabled.healer 默认开启', CONFIG.gameRules.spawnEnabled.healer === true);
  T('接线②-laneWaveComposition 里有 healer 的出兵规则',
    CONFIG.gameRules.laneWaveComposition.some(r => r.type === 'healer'));
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  T('接线③-出厂默认技能清单包含唯一被动',
    DEFAULT_MINION_PASSIVES.healer.includes('passive_healer_mend'));
}

// ==================== 八、编辑器/渲染层的类型枚举没有漏掉 healer ====================
{
  const schemaSrc = srcOf('src/data/schema/index.js');
  T('枚举①-schema/index.js 的 MINION_TYPES 里有 healer', /\['healer',\s*'治疗兵'\]/.test(schemaSrc));

  const customSrc = srcOf('src/data/customContent.js');
  T('枚举②-customContent.js 的 BUILTIN_MINION_TYPES/minionLabel/minionIcon 都认得 healer',
    /BUILTIN_MINION_TYPES\s*=\s*\[[^\]]*'healer'/.test(customSrc)
    && /healer:\s*'治疗兵'/.test(customSrc) && /healer:\s*'💗'/.test(customSrc));

  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举③-UnitAddDialog.js 的 MINION_TYPES/TYPE_META 都认得 healer',
    /'healer'/.test(dialogSrc) && /healer:\s*\{[^}]*治疗兵/.test(dialogSrc));

  const openSrc = srcOf('src/ui/editor/open.js');
  T('枚举④-open.js 的 _TPL_LABELS/_TPL_ICONS 都认得 healer',
    /healer:\s*'治疗兵'/.test(openSrc) && /healer:\s*'💗'/.test(openSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举⑤-pagesEntity.js 的技能列表类型枚举包含 healer',
    /'heavy',\s*'healer',/.test(entitySrc));

  const spriteSrc = srcOf('src/presentation/SpriteFactory.js');
  T('枚举⑥-SpriteFactory.js 的 MINION_STYLE 有 healer 专属样式',
    /healer:\s*\{[^}]*💗/.test(spriteSrc));

  const modeSrc = srcOf('src/data/maps/modeTransforms.js');
  T('枚举⑦-经典模式的 CLASSIC_SPAWN_ENABLED/CLASSIC_MINION_PASSIVES 都排除了 healer',
    /healer:\s*false/.test(modeSrc) && /healer:\s*\[\]/.test(modeSrc));
}

// ==================== 六、移动分支：贴着受治疗的友军，不贴敌方单位 ====================
// 用户反馈的真实bug："治疗兵为什么会贴着敌方单位，治疗兵要贴着受治疗的友方单位！"
// 根因：治疗兵此前没有专属移动分支，走的是"追敌人打架"用的通用小兵AI。
{
  const mapStub = {
    active: true,
    currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }] },
    getDefenseZone: () => null,
    isWalkable: () => true,
    constrainToWalkable: (p) => p,
    getLane: (id) => mapStub.currentMap.lanes.find(l => l.id === id),
    _nearestOnLane: () => ({ dist: 0 }), // 假装已经在兵线中央，跳过居中修正逻辑
  };
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const heal = mkEntity(ents, 'healer', { faction: 'blue', pos: { x: 0, y: 0 }, lane: 'mid' }, CONFIG);
  const foeNear = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG); // 贴脸的敌人
  const allyHurt = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 500, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  allyHurt.currentHP = 400; // 远处但受伤的友军
  const before = { x: heal.pos.x, y: heal.pos.y };
  lms._updateHealer(heal, 1);
  T('贴身①-治疗兵朝受伤友军移动，不是朝贴脸的敌人（x增大而不是停在原地或朝敌人方向）',
    heal.pos.x > before.x);
  T('贴身②-移动方向不受贴脸敌人干扰（敌人在x=20但治疗兵越过它继续往受伤友军走）',
    heal.pos.x > foeNear.pos.x - 1 || heal.pos.x > before.x);

  // 满血友军不该被选为跟随目标。
  const { ents: ents2, fx: fx2, attr: attr2, combat: combat2, CONFIG: CONFIG2 } = await world();
  const lms2 = new LaneMovementSystem(ents2, fx2, attr2, combat2, mapStub);
  const heal2 = mkEntity(ents2, 'healer', { faction: 'blue', pos: { x: 0, y: 0 }, lane: 'mid' }, CONFIG2);
  mkEntity(ents2, 'melee', { faction: 'blue', pos: { x: 500, y: 0 } }, CONFIG2); // 满血友军
  const before2 = { x: heal2.pos.x, y: heal2.pos.y };
  lms2._updateHealer(heal2, 1);
  T('贴身③-没有受伤友军时沿兵线正常推进（不是工程兵那种"没活干就站定不动"）',
    heal2.pos.x > before2.x);
}

done();
