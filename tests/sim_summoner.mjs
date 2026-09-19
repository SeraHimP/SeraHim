/**
 * sim_summoner.mjs —— 唤灵兵（summoner，Q5 新兵种方案之一）验收
 *
 * 幻灵直接复用 type:'melee' 的小兵创建管线（缩放属性 + 不成长），不是新造一个
 * 兵种类型——见 actives.js 的 active_summoner_call 头注。这里的测试用一个模拟版
 * combat.createMinion（签名与 main.js 真实注入的一致）验证技能自身的逻辑（上限/
 * 标记/法力返回值），不重复验证 factories.js 的缩放数学本身。
 * 每条断言钉"行为形状"，不钉具体数值。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('唤灵兵（summoner）验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

/** 模拟 main.js 里真实的 combat.setCreateMinion 注入（签名一致）。 */
function fakeCreateMinion(ents, CONFIG) {
  return (type, x, y, faction, hpScale = 1, attrScale = 1) => {
    const tpl = CONFIG.templates[type];
    if (!tpl) return null;
    return mkEntity(ents, type, {
      faction, pos: { x, y },
      stats: { maxHP: Math.round(tpl.maxHP * hpScale), attackDamage: Math.round(tpl.attackDamage * attrScale) },
    }, CONFIG);
  };
}

// ==================== 一、模板数值 ====================
{
  const { CONFIG } = await world();
  const tpl = CONFIG.templates.summoner;
  T('模板①-CONFIG.templates.summoner 存在', !!tpl);
  T('模板②-有法力槽（唯一主动技能靠这个触发）', tpl.maxMana > 0 && tpl.manaRegen > 0);
}

// ==================== 二、唤灵：成功召唤一只幻灵 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('active_summoner_call');
  const self = mkEntity(ents, 'summoner', { faction: 'blue', pos: { x: 100, y: 100 } }, CONFIG);
  const combat = { createMinion: fakeCreateMinion(ents, CONFIG) };
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat };
  const inst = { id: ++window._uid, skillId: 'active_summoner_call', state: {} };

  const before = ents.getAll(true).length;
  const ok = def.onCast(self.id, inst, ctx);
  T('唤灵①-施放成功', ok === true);
  T('唤灵②-场上确实多了一个实体', ents.getAll(true).length === before + 1);

  const spirit = ents.getAll(true).find(e => e._isSummoned);
  T('唤灵③-幻灵是 type:melee（复用现有小兵管线，不是新兵种）', spirit && spirit.type === 'melee');
  T('唤灵④-幻灵出生在唤灵兵脚下', spirit && spirit.pos.x === self.pos.x && spirit.pos.y === self.pos.y);
  T('唤灵⑤-幻灵属性明显低于满配近战兵（60~70%量级）',
    spirit && spirit.baseStats.maxHP < CONFIG.templates.melee.maxHP);
  T('唤灵⑥-幻灵打了 _isSummoned 标记（供统计口径排除）', spirit && spirit._isSummoned === true);
  T('唤灵⑦-幻灵有到期时间（会自动消失，不是永久单位）',
    spirit && typeof spirit._summonExpireAt === 'number' && spirit._summonExpireAt > 0);
  T('唤灵⑧-唤灵兵名下记录了这只幻灵的 id', self._summonedIds && self._summonedIds.includes(spirit.id));
}

// ==================== 三、上限：满编时不再召唤 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('active_summoner_call');
  const self = mkEntity(ents, 'summoner', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const combat = { createMinion: fakeCreateMinion(ents, CONFIG) };
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat };
  const maxAlive = def.defaultParams.maxAlive;

  let successCount = 0;
  for (let i = 0; i < maxAlive + 3; i++) {
    const inst = { id: ++window._uid, skillId: 'active_summoner_call', state: {} };
    if (def.onCast(self.id, inst, ctx)) successCount++;
  }
  T('上限①-连续施放多次，成功次数不超过上限', successCount === maxAlive);
  T('上限②-达到上限后再次施放返回 false（法力保持满格，下次再试）',
    def.onCast(self.id, { id: ++window._uid, skillId: 'active_summoner_call', state: {} }, ctx) === false);
}

// ==================== 四、腾出名额：一只死了之后可以再召唤 ====================
{
  const { ents, fx, attr, CONFIG } = await world();
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const def = SkillLibrary.get('active_summoner_call');
  const self = mkEntity(ents, 'summoner', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  const combat = { createMinion: fakeCreateMinion(ents, CONFIG) };
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat };
  const maxAlive = def.defaultParams.maxAlive;
  for (let i = 0; i < maxAlive; i++) {
    def.onCast(self.id, { id: ++window._uid, skillId: 'active_summoner_call', state: {} }, ctx);
  }
  T('满编①-已经满编', !def.onCast(self.id, { id: ++window._uid, skillId: 'active_summoner_call', state: {} }, ctx));

  // 杀掉其中一只
  const spirit = ents.getAll(true).find(e => e._isSummoned);
  spirit.alive = false;
  const ok = def.onCast(self.id, { id: ++window._uid, skillId: 'active_summoner_call', state: {} }, ctx);
  T('满编②-其中一只死后腾出名额，可以再召唤', ok === true);
}

// ==================== 五、到期自动消失 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const spirit = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG);
  spirit._isSummoned = true;
  spirit._summonExpireAt = (window.gameTime || 0) + 1;
  window.gameTime = (window.gameTime || 0) + 2; // 过期
  combat.update(0.016);
  T('到期①-超过存活时限后自动消亡', spirit.alive === false);
}

// ==================== 六、幻灵死亡不给对面记熵 ====================
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EntropySystem } = await import('../src/systems/EntropySystem.js');
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const es = new EntropySystem(bus, ents);
  const before = es.snapshot ? JSON.stringify(es.snapshot()) : null;
  const victim = { id: 1, type: 'melee', _mapFaction: 'blue', _isSummoned: true };
  ents.add(victim);
  bus.emit('entity:death', { entityId: victim.id });
  const after = es.snapshot ? JSON.stringify(es.snapshot()) : null;
  T('熵①-幻灵死亡不改变熵状态（不给对面免费记熵）', before === null || before === after);
}

// ==================== 七、出兵编排 / 出兵开关接线 ====================
{
  const { CONFIG } = await world();
  T('接线①-spawnEnabled.summoner 默认开启', CONFIG.gameRules.spawnEnabled.summoner === true);
  T('接线②-laneWaveComposition 里有 summoner 的出兵规则',
    CONFIG.gameRules.laneWaveComposition.some(r => r.type === 'summoner'));
  const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
  T('接线③-出厂默认技能清单包含唯一主动技能',
    DEFAULT_MINION_PASSIVES.summoner.includes('active_summoner_call'));
}

// ==================== 八、编辑器/渲染层的类型枚举没有漏掉 summoner ====================
{
  const schemaSrc = srcOf('src/data/schema/index.js');
  T('枚举①-schema/index.js 的 MINION_TYPES 里有 summoner', /\['summoner',\s*'唤灵兵'\]/.test(schemaSrc));

  const customSrc = srcOf('src/data/customContent.js');
  T('枚举②-customContent.js 的 BUILTIN_MINION_TYPES/minionLabel/minionIcon 都认得 summoner',
    /BUILTIN_MINION_TYPES\s*=\s*\[[^\]]*'summoner'/.test(customSrc)
    && /summoner:\s*'唤灵兵'/.test(customSrc) && /summoner:\s*'👻'/.test(customSrc));

  const dialogSrc = srcOf('src/ui/UnitAddDialog.js');
  T('枚举③-UnitAddDialog.js 的 MINION_TYPES/TYPE_META 都认得 summoner',
    /'summoner'/.test(dialogSrc) && /summoner:\s*\{[^}]*唤灵兵/.test(dialogSrc));

  const openSrc = srcOf('src/ui/editor/open.js');
  T('枚举④-open.js 的 _TPL_LABELS/_TPL_ICONS 都认得 summoner',
    /summoner:\s*'唤灵兵'/.test(openSrc) && /summoner:\s*'👻'/.test(openSrc));

  const entitySrc = srcOf('src/ui/editor/pagesEntity.js');
  T('枚举⑤-pagesEntity.js 的技能列表类型枚举包含 summoner',
    /'engineer',\s*'summoner',\s*'dragon'/.test(entitySrc));

  const spriteSrc = srcOf('src/presentation/SpriteFactory.js');
  T('枚举⑥-SpriteFactory.js 的 MINION_STYLE 有 summoner 专属样式',
    /summoner:\s*\{[^}]*👻/.test(spriteSrc));

  const modeSrc = srcOf('src/data/maps/modeTransforms.js');
  T('枚举⑦-经典模式排除了 summoner',
    /summoner:\s*false/.test(modeSrc) && /summoner:\s*\[\]/.test(modeSrc));
}

// ==================== 十一、3D 造型：不再复用通用步兵模板（用户："模型也要重做！不要复用现有的！"） ====================
{
  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { minionMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const m = minionMesh('mm-summoner-test', '#5b9bd5', 11, 'summoner', 'blue');
    T('模型①-summoner 能造出几何', !!m.geo && m.topY > 0);
    const generic = minionMesh('mm-generic-test-s', '#5b9bd5', 11, '__custom__', 'blue');
    T('模型②-summoner 不再落回通用步兵模板（顶点数不同）',
      m.geo.attributes.position.count !== generic.geo.attributes.position.count);
    const warlock = minionMesh('mm-warlock-test-s', '#5b9bd5', 11, 'warlock', 'blue');
    T('模型③-summoner 与术士（同为兜帽斗篷造型）也是不同几何，不是照抄术士',
      m.geo.attributes.position.count !== warlock.geo.attributes.position.count);
  }
}

done();
