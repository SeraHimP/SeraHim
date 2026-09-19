/**
 * sim_heavy.mjs —— 重装车（heavy，Q5 新兵种方案之一）接线验收
 *
 * 之前一轮只把核心机制代码写完就被用户叫停（"先把代码给我，先别做"），没有接进
 * 出兵编排/编辑器标签/单位样式，也没有专属测试——这轮补完接线后一并补测试。
 * 每条断言钉"行为形状"，不钉具体数值（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('重装车（heavy）验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

// ==================== 一、模板数值：坦克定位落实到数值上 ====================
{
  const { CONFIG } = await world();
  const tpl = CONFIG.templates.heavy;
  T('模板①-CONFIG.templates.heavy 存在', !!tpl);
  T('模板②-双抗明显高于近战兵（"超高双抗"）',
    tpl.armor > CONFIG.templates.melee.armor && tpl.magicResist > CONFIG.templates.melee.magicResist);
  T('模板③-自带伤害格挡（damageBlock > 0）', tpl.damageBlock > 0);
  T('模板④-攻速极低（明显低于近战兵基础攻速）', tpl.baseAttackSpeed < CONFIG.templates.melee.baseAttackSpeed);
  T('模板⑤-有法力槽（主动技能法力攒满触发的前提）', tpl.maxMana > 0 && tpl.manaRegen > 0);
}

// ==================== 二、塔攻击优先级最高 ====================
{
  const { ents, combat, CONFIG } = await world();
  const tower = mkEntity(ents, 'tower', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { attackRange: 1000 } }, CONFIG);
  // 同一位置放一圈候选，只靠 getPriority 的排序决定谁被选中，不靠距离。
  const dragon = mkEntity(ents, 'dragon', { faction: null, pos: { x: 10, y: 0 } }, CONFIG);
  dragon._mapFaction = null; dragon.faction = null; // 中立
  const superUnit = mkEntity(ents, 'super', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG);
  const heavy = mkEntity(ents, 'heavy', { faction: 'red', pos: { x: 30, y: 0 } }, CONFIG);
  const target = combat.selectTarget(tower, [dragon, superUnit, heavy]);
  T('优先级①-同射程内龙/超级兵/重装车都在场时，塔优先打重装车', target && target.id === heavy.id);

  // 去掉重装车后，龙仍然按原有次序排第一（不是重装车"顶替"了龙的位置，
  // 而是叠加在最上面——验证没有破坏原有的优先级链条）。
  ents.remove(heavy.id);
  const target2 = combat.selectTarget(tower, [dragon, superUnit]);
  T('优先级②-没有重装车时，原有优先级链条（龙 > 超级兵）不受影响', target2 && target2.id === dragon.id);
}

// ==================== 三、破城锤：对塔额外伤害，对小兵无效 ====================
{
  const { ents, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('passive_heavy_vs_tower');
  const attacker = mkEntity(ents, 'heavy', { faction: 'blue' }, CONFIG);
  const tower = mkEntity(ents, 'tower', { faction: 'red' }, CONFIG);
  const minion = mkEntity(ents, 'melee', { faction: 'red' }, CONFIG);
  const dealt = [];
  const ctx = {
    entityContainer: ents, totalRaw: 100, attackType: 'physical',
    combat: { performAttackDirect: (a, b, dmg) => dealt.push(dmg) },
  };
  def.onDealtDamage(attacker.id, tower.id, { state: {}, _params: {} }, ctx);
  const pct = CONFIG.gameRules.supportUnits.heavy.bonusVsTowerPct;
  T('破城锤①-对塔额外伤害 = 本次原始伤害 × bonusVsTowerPct（软编码取自 Config）',
    dealt.length === 1 && Math.abs(dealt[0] - 100 * (pct / 100)) < 1e-6);
  def.onDealtDamage(attacker.id, minion.id, { state: {}, _params: {} }, ctx);
  T('破城锤②-对小兵无额外伤害（只针对防御塔）', dealt.length === 1);
}

// ==================== 四、铁壁：法力攒满触发的限时伤害减免 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('active_heavy_bulwark');
  const self = mkEntity(ents, 'heavy', { faction: 'blue' }, CONFIG);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr };
  const inst = { id: ++window._uid, skillId: 'active_heavy_bulwark', state: {} };
  self._skillInstances.push(inst);
  const before = attr.calc(self, fx.getEffects(self.id));
  const ok = def.onCast(self.id, inst, ctx);
  T('铁壁①-施放成功', ok === true);
  const after = attr.calc(self, fx.getEffects(self.id));
  const p = def.defaultParams;
  T('铁壁②-伤害减免按 defaultParams.damageReductionPct 生效',
    Math.abs((after.damageReduction || 0) - (before.damageReduction || 0) - p.damageReductionPct) < 1e-6);
  const eff = fx.getEffects(self.id).find(e => e.sourceId === 'active_heavy_bulwark');
  T('铁壁③-限时（不是永久buff）', eff && eff.remainingTime > 0 && eff.remainingTime <= p.durationSec + 1e-6);
}

// ==================== 五、出兵编排 / 出兵开关接线 ====================
{
  const { CONFIG } = await world();
  T('接线①-spawnEnabled.heavy 默认开启', CONFIG.gameRules.spawnEnabled.heavy === true);
  T('接线②-laneWaveComposition 里有 heavy 的出兵规则',
    CONFIG.gameRules.laneWaveComposition.some(r => r.type === 'heavy'));
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  T('接线③-出厂默认技能清单包含被动+主动两条',
    DEFAULT_MINION_PASSIVES.heavy.includes('passive_heavy_vs_tower')
    && DEFAULT_MINION_PASSIVES.heavy.includes('active_heavy_bulwark'));
}

// ==================== 六、编辑器/渲染层的类型枚举没有漏掉 heavy ====================
// 这一节钉的是"新增兵种要在哪几处露面"这份 checklist 本身——ram 当年就是漏了
// 其中几处才被发现（画板问号、页签不显示、技能勾选面板报错），逐个源码扫描确认
// 这次没有重蹈覆辙。
{
  const schemaSrc = srcOf('src/data/schema/index.js');
  T('枚举①-schema/index.js 的 MINION_TYPES 里有 heavy', /\['heavy',\s*'重装车'\]/.test(schemaSrc));

  const customSrc = srcOf('src/data/customContent.js');
  T('枚举②-customContent.js 的 BUILTIN_MINION_TYPES/minionLabel/minionIcon 都认得 heavy',
    /BUILTIN_MINION_TYPES\s*=\s*\[[^\]]*'heavy'/.test(customSrc)
    && /heavy:\s*'重装车'/.test(customSrc) && /heavy:\s*'🐢'/.test(customSrc));

  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举③-UnitAddDialog.js 的 MINION_TYPES/TYPE_META 都认得 heavy',
    /'heavy'/.test(dialogSrc) && /heavy:\s*\{[^}]*重装车/.test(dialogSrc));

  const openSrc = srcOf('src/ui/editor/open.js');
  T('枚举④-open.js 的 _TPL_LABELS/_TPL_ICONS 都认得 heavy',
    /heavy:\s*'重装车'/.test(openSrc) && /heavy:\s*'🐢'/.test(openSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举⑤-pagesEntity.js 的技能列表类型枚举包含 heavy（否则该类型技能面板会报错）',
    /'ram',\s*'heavy',/.test(entitySrc));

  const spriteSrc = srcOf('src/presentation/SpriteFactory.js');
  T('枚举⑥-SpriteFactory.js 的 MINION_STYLE 有 heavy 专属样式（不会 fallback 成问号/近战兵默认色）',
    /heavy:\s*\{[^}]*🐢/.test(spriteSrc));
}

done();
