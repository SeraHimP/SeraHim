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
  // lane: 'mid' 不是随手加的——下面唤灵⑨要验证幻灵继承施法者的 _laneId，
  // 不给唤灵兵本身一个真实的路，继承出来的就是 undefined === undefined，
  // 断言会在什么都没做对的情况下也通过（假通过），钉不住真正的行为。
  const self = mkEntity(ents, 'summoner', { faction: 'blue', pos: { x: 100, y: 100 }, lane: 'mid' }, CONFIG);
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
  // 2026-09-20：用户反馈"不再强制设定到多少秒后死"——到期计时器（_summonExpireAt）
  // 整条删掉，改成生命衰减速率（_summonDrainPctPerSec，见CombatSystem.update）。
  T('唤灵⑦-幻灵不再有强制到期时间（_summonExpireAt 这条机制已经删掉）',
    spirit && spirit._summonExpireAt === undefined);
  T('唤灵⑦b-幻灵改用生命衰减速率（会自然衰减死亡，不是永久单位）',
    spirit && typeof spirit._summonDrainPctPerSec === 'number' && spirit._summonDrainPctPerSec > 0);
  T('唤灵⑧-唤灵兵名下记录了这只幻灵的 id', self._summonedIds && self._summonedIds.includes(spirit.id));
  // 用户反馈bug"召唤出来的唤灵不移动"——根因是移动系统的过滤条件只认
  // `_laneId || _petOwnerId`，幻灵原来两个都没有。现在继承施法者自己的 _laneId，
  // 让它并入普通小兵那一整套索敌/追击/推线AI（不是牧灵法阵那种拴绳宠物）。
  T('唤灵⑨-幻灵继承唤灵兵自己的 _laneId（能并入普通小兵移动/索敌AI，不再站桩不动）',
    spirit && spirit._laneId === self._laneId);
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

// ==================== 五、生命衰减：每秒扣一定比例最大生命，归零后死亡 ====================
// 用户原话："这个唤灵兵的每秒减少生命值，归零后就死了，不再强制设定到多少秒后死"。
{
  const { ents, fx, combat, CONFIG } = await world();
  const spirit = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  spirit.currentHP = 1000;
  spirit._isSummoned = true;
  spirit._summonDrainPctPerSec = 10; // 每秒衰减10%最大生命

  const before = spirit.currentHP;
  combat.update(1);
  T('衰减①-每帧按 maxHP×drainPct%×dt 扣血（不是战斗伤害，直接扣currentHP）',
    spirit.alive === true && Math.abs((before - spirit.currentHP) - 100) < 1e-6);

  // 打到归零之前一直存活，归零那一刻才死——不是"活满固定秒数"这种硬计时器。
  for (let i = 0; i < 20 && spirit.alive; i++) combat.update(1);
  T('衰减②-持续衰减到血量归零后自然死亡', spirit.alive === false && spirit.currentHP === 0);
}

// ==================== 五b、没有衰减速率的普通幻灵不会被这条规则误伤 ====================
{
  const { ents, combat, CONFIG } = await world();
  const spirit = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 0, y: 0 },
    stats: { maxHP: 1000 } }, CONFIG);
  spirit.currentHP = 1000;
  spirit._isSummoned = true; // 没有 _summonDrainPctPerSec
  combat.update(5);
  T('衰减③-没有衰减速率就不掉血（这条规则只认_summonDrainPctPerSec，不是_isSummoned本身）',
    spirit.currentHP === 1000);
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

  // v51.32：这份类型枚举从 pagesEntity.js 搬到了 SkillLibrary.js 的 skillsByType()
  // （地图编辑器"塔模板自定义"要用同一份数据，不再各写一份，见该函数头注）。
  const skillLibSrc = srcOf('src/core/SkillLibrary.js');
  T('枚举⑤-SkillLibrary.js 的 skillsByType 类型枚举包含 summoner',
    /'engineer',\s*'summoner',\s*'dragon'/.test(skillLibSrc));

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

// ==================== 九、移动系统真正接纳幻灵：不再是不动的木桩 ====================
// 用户原话："召唤出来的唤灵不移动"——根因是 LaneMovementSystem 的过滤条件
// `_laneId || _petOwnerId` 幻灵两个都没有，被整套移动/索敌AI排除在外。
{
  const { ents, fx, attr, combat, CONFIG } = await world();
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const mapStub = {
    active: true,
    currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }] },
    getDefenseZone: () => null,
    isWalkable: () => true,
    constrainToWalkable: (p) => p,
  };
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapStub);
  const spirit = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 0, y: 0 }, lane: 'mid' }, CONFIG);
  spirit._isSummoned = true;
  spirit._summonDrainPctPerSec = 7;
  const foe = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG); // 贴脸
  lms.update(1);
  T('接纳①-带 _laneId 的幻灵走标准索敌流程（贴脸敌人时能获得 targetId，不再是木桩）',
    spirit.targetId === foe.id);

  // 反证：没有 _laneId（也没有 _petOwnerId）的幻灵，就是旧bug复现的样子——
  // 确认这条断言本身钉得住"会不会不小心把过滤条件删过头"这类回归。
  const { ents: ents2, fx: fx2, attr: attr2, combat: combat2, CONFIG: CONFIG2 } = await world();
  const lms2 = new LaneMovementSystem(ents2, fx2, attr2, combat2, mapStub);
  const orphanSpirit = mkEntity(ents2, 'melee', { faction: 'blue', pos: { x: 0, y: 0 } }, CONFIG2); // 没有lane
  orphanSpirit._isSummoned = true;
  mkEntity(ents2, 'melee', { faction: 'red', pos: { x: 20, y: 0 } }, CONFIG2);
  lms2.update(1);
  T('接纳②-反证：没有 _laneId 的幻灵确实拿不到 targetId（复现旧bug的条件，佐证①改对了地方）',
    !orphanSpirit.targetId);
}

// ==================== 十、渲染层：幻灵用专属"召唤物"造型，不再落回近战兵模板 ====================
// 用户原话："这个模型改为 唤灵塔召唤物的模型，用颜色区分"——幻灵复用牧灵法阵
// 幻兽同一份"召唤物"几何（UnitMeshFactory.MINION_BUILDERS.summon_spirit 直接是
// shepherd_pet 的别名），靠颜色（不是造型）跟牧灵幻兽/唤灵兵本体区分开。
{
  const { minionRenderType, MINION_STYLE } = await import('../src/presentation/SpriteFactory.js');
  const spirit = { type: 'melee', _isSummoned: true };
  T('造型①-minionRenderType 把幻灵路由到专属伪类型 summon_spirit（不是melee）',
    minionRenderType(spirit) === 'summon_spirit');

  const pet = { type: 'melee', _petOwnerId: 999, _isSummoned: true }; // 牧灵幻兽同时也挂_isSummoned
  T('造型②-牧灵法阵幻兽仍然优先路由到 shepherd_pet（判断顺序没有被幻灵这条分支顶掉）',
    minionRenderType(pet) === 'shepherd_pet');

  T('造型③-summon_spirit 与 shepherd_pet 颜色不同（能用颜色区分两种"召唤物"）',
    MINION_STYLE.summon_spirit.color !== MINION_STYLE.shepherd_pet.color);
  T('造型④-summon_spirit 与唤灵兵本体（summoner）颜色也不同（不会跟施法者本人撞色）',
    MINION_STYLE.summon_spirit.color !== MINION_STYLE.summoner.color);

  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { minionMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const spiritMesh = minionMesh('mm-summonspirit-test', '#c9a6f0', 9, 'summon_spirit', 'blue');
    const shepherdMesh = minionMesh('mm-shepherdpet-test', '#6fd6c8', 9, 'shepherd_pet', 'blue');
    T('造型⑤-summon_spirit 与 shepherd_pet 复用同一份几何（同顶点数），差异只在颜色',
      spiritMesh.geo.attributes.position.count === shepherdMesh.geo.attributes.position.count);
    const genericMelee = minionMesh('mm-melee-test-s2', '#f2795c', 10, 'melee', 'blue');
    T('造型⑥-summon_spirit 不再落回普通近战兵造型（顶点数不同）',
      spiritMesh.geo.attributes.position.count !== genericMelee.geo.attributes.position.count);
  }
}

done();
