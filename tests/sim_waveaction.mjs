/**
 * sim_waveaction.mjs —— 出兵编排"广播"升级验收（v51.33，design §5/§6 阶段一）
 *
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §5.1：与独立开一张 WAVE_ACTIONS 表
 * 相比，用户定稿"打通"——广播规则不自带动作，而是引用一个声明了 broadcast 触发的
 * 已有技能，behaviorVM.compileSpec 生成 onBroadcast 钩子（照抄 onEquip 那段），
 * 出兵编排这边只负责"什么时候广播、广播给谁"。
 *
 * 覆盖：① behaviorVM 的 broadcast 触发器与 hasTarget:false 边界校验；
 *      ② compileSpec 编译出 onBroadcast，调用后动作真的生效；
 *      ③ waveComposition 的 buildBroadcastOrder（fromWave/everyN/when/scope）；
 *      ④ buildWaveOrder 不会把广播规则误当刷兵规则展开；
 *      ⑤ 新增的龙魂/天气/昼夜/战绩条件（ctx 缺失时按既有口径放行）；
 *      ⑥ LaneWaveSystem 端到端：真的把广播派发给了 scope 范围内的单位。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { validateSpec, compileSpec, TRIGGERS } = await import('../src/core/behaviorVM.js');
const { buildWaveOrder, buildBroadcastOrder, WAVE_CONDITIONS, compositionFor } = await import('../src/data/waveComposition.js');
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');

const board = scoreboard('出兵编排广播升级验收');
const T = board.T;

// ==================== ① broadcast 触发器 ====================
{
  T('触①-TRIGGERS 里有 broadcast，且 hasTarget:false（与 equip 同形状，没有目标）',
    TRIGGERS.broadcast && TRIGGERS.broadcast.hasTarget === false);
}

// ==================== ② compileSpec 编译出 onBroadcast，调用后动作真的生效 ====================
{
  const spec = {
    id: 'test_broadcast_buff', name: '测试广播增益', category: 'passive',
    rules: [{ on: 'broadcast', do: [{ act: 'applyEffect', to: 'self',
      effect: { kind: 'stat', statKey: 'armor', flatValue: 20, duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh' } }] }],
  };
  const v = validateSpec(spec);
  T('广①-broadcast 触发 + applyEffect(to:self) 这种"没有目标"的组合能通过校验', v.ok);
  const def = compileSpec(spec);
  T('广②-compileSpec 编译出 onBroadcast', typeof def?.onBroadcast === 'function');

  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const unit = { id: 1, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100, armor: 0 }, _skillInstances: [] };
  ents.add(unit);
  const inst = { id: 99, skillId: spec.id, state: {} };
  def.onBroadcast(unit.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: AttributeCalculator });
  const eff = fx.getEffects(unit.id).find(e => e.blueprint.statKey === 'armor');
  T('广③-调用 onBroadcast 后，effect 真的挂到了单位身上（+20 护甲）', !!eff && eff.totalFlat === 20);
}

// ==================== ③ hasTarget:false 边界校验（与 equip 同一条规则） ====================
{
  const badTarget = {
    id: 'test_broadcast_bad1', name: 'x',
    rules: [{ on: 'broadcast', when: [{ hpBelowPct: 50 }], do: [{ act: 'applyEffect', to: 'self', effect: { kind: 'stat', statKey: 'armor', flatValue: 1 } }] }],
  };
  T('广④-broadcast 触发用"目标生命低于%"这种需要目标的条件 → 校验拒绝',
    !validateSpec(badTarget).ok);

  const badAction = {
    id: 'test_broadcast_bad2', name: 'x',
    rules: [{ on: 'broadcast', do: [{ act: 'damage', to: 'target', amount: 10 }] }],
  };
  T('广⑤-broadcast 触发对 target 造成伤害（需要目标的动作）→ 校验拒绝',
    !validateSpec(badAction).ok);
}

// ==================== ④ buildBroadcastOrder：fromWave/everyN/when/scope ====================
{
  const rules = {
    laneWaveComposition: [
      { kind: 'broadcast', skillId: 'skill_a', scope: 'faction', fromWave: 3, everyN: 2 },
      { kind: 'broadcast', skillId: 'skill_b', scope: 'lane', fromWave: 0, everyN: 1, when: 'time.after', whenArg: 100 },
      { type: 'melee', count: 3 }, // 混一条刷兵规则，确认两边互不干扰
    ],
  };
  // 注意：ctx={} 没带 gameTime，skill_b 的 time.after 条件按"拿不到就放行"口径会
  // 通过（这是既有口径，见 WAVE_CONDITIONS['time.after']），所以只断言 skill_a
  // 没触发，不断言整个列表为空。
  T('广播①-第 1 波（< fromWave 3）不触发 skill_a', !buildBroadcastOrder(1, false, rules, 'blue', {}).some(b => b.skillId === 'skill_a'));
  T('广播②-第 3 波命中 fromWave，触发 skill_a（scope 默认为 faction）',
    buildBroadcastOrder(3, false, rules, 'blue', {}).some(b => b.skillId === 'skill_a' && b.scope === 'faction'));
  T('广播③-第 4 波不满足 everyN=2 的周期（3,5,7...）不触发 skill_a',
    !buildBroadcastOrder(4, false, rules, 'blue', {}).some(b => b.skillId === 'skill_a'));
  T('广播④-第 5 波再次命中周期，触发 skill_a', buildBroadcastOrder(5, false, rules, 'blue', {}).some(b => b.skillId === 'skill_a'));
  T('广播⑤-skill_b 的 when 条件（游戏时间≥100s）不满足时不触发',
    !buildBroadcastOrder(3, false, rules, 'blue', { gameTime: 50 }).some(b => b.skillId === 'skill_b'));
  T('广播⑥-skill_b 的 when 条件满足时触发，且 scope 正确读出 lane',
    buildBroadcastOrder(3, false, rules, 'blue', { gameTime: 200 }).some(b => b.skillId === 'skill_b' && b.scope === 'lane'));
}

// ==================== ⑤ buildWaveOrder 不会把广播规则误当刷兵规则 ====================
{
  const rules = {
    laneWaveComposition: [
      { kind: 'broadcast', skillId: 'skill_a', scope: 'faction' },
      { type: 'melee', count: 2 },
    ],
  };
  const order = buildWaveOrder(1, false, rules, 'blue', {});
  T('展①-buildWaveOrder 的展开结果只有刷兵规则（melee×2），广播规则被跳过、不产生 undefined/垃圾条目',
    order.length === 2 && order.every(t => t === 'melee'));
}

// ==================== ⑥ 龙魂/天气/昼夜/战绩条件 ====================
{
  const soulOwned = WAVE_CONDITIONS['ally.soul.owned'];
  T('条①-ally.soul.owned：我方已成魂时为 true', soulOwned.test({ faction: 'blue', dragonState: { soulOwner: 'blue' } }));
  T('条②-ally.soul.owned：敌方成魂（不是我方）时为 false', !soulOwned.test({ faction: 'blue', dragonState: { soulOwner: 'red' } }));
  T('条③-ally.soul.owned：dragonState 缺失（依赖没注入）时放行，不静默判 false',
    soulOwned.test({ faction: 'blue', dragonState: null }));

  const kills = WAVE_CONDITIONS['enemy.dragonKills.atLeast'];
  T('条④-enemy.dragonKills.atLeast：敌方已集齐 3 层（雷1+火2）≥2 时为 true',
    kills.test({ faction: 'blue', enemy: 'red', dragonState: { factionKills: { red: { thunder: 1, fire: 2 } } } }, 2));
  T('条⑤-enemy.dragonKills.atLeast：不足门槛时为 false',
    !kills.test({ faction: 'blue', enemy: 'red', dragonState: { factionKills: { red: { thunder: 1 } } } }, 2));

  const extreme = WAVE_CONDITIONS['weather.extreme'];
  T('条⑥-weather.extreme：极端天气（如暴雪 blizzard）为 true', extreme.test({ weather: { id: 'blizzard' } }));
  T('条⑦-weather.extreme：基础天气（如晴 clear）为 false', !extreme.test({ weather: { id: 'clear' } }));
  T('条⑧-weather.extreme：weather 为 null（依赖没注入）时放行', extreme.test({ weather: null }));

  const isNight = WAVE_CONDITIONS['daynight.isNight'];
  T('条⑨-daynight.isNight：夜晚为 true，白天为 false',
    isNight.test({ dayPhase: { isNight: true } }) && !isNight.test({ dayPhase: { isNight: false } }));
  T('条⑩-daynight.isNight：dayPhase 缺失时放行', isNight.test({ dayPhase: null }));

  const lead = WAVE_CONDITIONS['ally.towers.leadAtLeast'];
  T('条⑪-ally.towers.leadAtLeast：我方推塔 5 座、敌方 1 座，领先 4 ≥ 3 为 true',
    lead.test({ faction: 'blue', enemy: 'red', score: { blue: { towers: 5 }, red: { towers: 1 } } }, 3));
  T('条⑫-ally.towers.leadAtLeast：领先不足门槛为 false',
    !lead.test({ faction: 'blue', enemy: 'red', score: { blue: { towers: 2 }, red: { towers: 1 } } }, 3));
  T('条⑬-ally.towers.leadAtLeast：score 缺失时放行', lead.test({ faction: 'blue', enemy: 'red', score: null }, 3));
}

// ==================== ⑦ LaneWaveSystem._broadcast：scope 过滤（阵营/路）====================
// 直接调 _broadcast 而不经过 spawnWave()——共享编排规则（不分阵营）在 spawnWave()
// 里会对蓝红各跑一次 _enqueueForFaction，两边各自广播给"自己"是正确的对称行为
// （与刷兵规则同一套语义：共享编排对双方都生效，不是只对一方生效），
// 那不是 _broadcast 本身的过滤逻辑该测的东西——过滤逻辑单独、干净地测。
{
  const spec = {
    id: 'test_wave_broadcast_e2e', name: '端到端测试广播', category: 'passive',
    rules: [{ on: 'broadcast', do: [{ act: 'applyEffect', to: 'self',
      effect: { kind: 'stat', statKey: 'attackDamage', flatValue: 15, duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh' } }] }],
  };
  const def = compileSpec(spec);
  SkillLibrary.register(spec.id, def);

  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSystem = { currentMap: null, isNexusDestroyed: () => false, getNexusRespawnRemain: () => null, structureCensus: () => null };
  const lws = new LaneWaveSystem(ents, bus, mapSystem);
  lws.setBroadcastDeps({ effectRegistry: fx, attrCalc: AttributeCalculator, combat });

  const blueMid = { id: 10, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100, attackDamage: 100 }, _mapFaction: 'blue', _laneId: 'mid', _skillInstances: [] };
  const blueTop = { id: 11, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100, attackDamage: 100 }, _mapFaction: 'blue', _laneId: 'top', _skillInstances: [] };
  const redMid = { id: 12, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100, attackDamage: 100 }, _mapFaction: 'red', _laneId: 'mid', _skillInstances: [] };
  ents.add(blueMid); ents.add(blueTop); ents.add(redMid);

  lws._broadcast('blue', null, spec.id, 'faction');

  const has = (e) => fx.getEffects(e.id).some(x => x.blueprint.statKey === 'attackDamage' && x.totalFlat === 15);
  T('端①-scope=faction：己方所有单位（不分路）都拿到了广播效果', has(blueMid) && has(blueTop));
  T('端②-scope=faction：敌方单位不受影响（faction 过滤生效）', !has(redMid));

  SkillLibrary._registry.delete(spec.id);
  delete SkillLibrary[spec.id];
}

// ==================== ⑧ scope=lane 只影响该路，且未注入依赖时优雅降级 ====================
{
  const spec = {
    id: 'test_wave_broadcast_lane', name: '端到端测试分路广播', category: 'passive',
    rules: [{ on: 'broadcast', do: [{ act: 'applyEffect', to: 'self',
      effect: { kind: 'stat', statKey: 'moveSpeed', flatValue: 7, duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh' } }] }],
  };
  const def = compileSpec(spec);
  SkillLibrary.register(spec.id, def);

  const savedComposition = CONFIG.gameRules.laneWaveComposition;
  CONFIG.gameRules = { ...CONFIG.gameRules,
    laneWaveComposition: [{ kind: 'broadcast', skillId: spec.id, scope: 'lane' }],
    spawnEnabled: {} };

  const mapSystem = {
    currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }] },
    isNexusDestroyed: () => false, getNexusRespawnRemain: () => null,
    structureCensus: () => null,
  };
  // 故意不调用 setBroadcastDeps —— 验证"没注入依赖时不崩、只是不广播"（同 census/gameTime
  // 拿不到时的既有降级口径，见 LaneWaveSystem._broadcast 头注）。走真实 spawnWave()
  // 链路（唯一一处过 spawnWave 的用例），确认整条链路（含 buildBroadcastOrder→
  // _broadcast）在依赖缺失时不炸，不只是孤立函数层面不炸。
  const busN = new EventBus(), entsN = new EntityContainer(busN);
  const lwsNoDeps = new LaneWaveSystem(entsN, busN, mapSystem);
  lwsNoDeps.createMinion = () => {};
  entsN.add({ id: 20, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100 }, _mapFaction: 'blue', _laneId: 'mid', _skillInstances: [] });
  let threw = false;
  try { lwsNoDeps.spawnWave(); } catch { threw = true; }
  T('降①-setBroadcastDeps 没调用时，spawnWave() 不抛错（def 查得到但没有 effectRegistry 时安全跳过）', !threw);

  // 正式测 scope=lane 的路过滤——直接调 _broadcast（理由同⑦：过滤逻辑本身与
  // "共享编排对每条路各跑一次"是两件事，分开测才不会互相干扰断言）。
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const combat2 = new CombatSystem(ents2, fx2, bus2, SkillLibrary);
  const lws = new LaneWaveSystem(ents2, bus2, mapSystem);
  lws.setBroadcastDeps({ effectRegistry: fx2, attrCalc: AttributeCalculator, combat: combat2 });
  const mid = { id: 21, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100 }, _mapFaction: 'blue', _laneId: 'mid', _skillInstances: [] };
  const top = { id: 22, type: 'tower', alive: true, currentHP: 100, baseStats: { maxHP: 100 }, _mapFaction: 'blue', _laneId: 'top', _skillInstances: [] };
  ents2.add(mid); ents2.add(top);
  lws._broadcast('blue', 'mid', spec.id, 'lane');
  const has2 = (e) => fx2.getEffects(e.id).some(x => x.blueprint.statKey === 'moveSpeed' && x.totalFlat === 7);
  T('端③-scope=lane：只有对应路（mid）的单位拿到广播', has2(mid));
  T('端④-scope=lane：其它路（top）不受影响', !has2(top));

  CONFIG.gameRules.laneWaveComposition = savedComposition;
  SkillLibrary._registry.delete(spec.id);
  delete SkillLibrary[spec.id];
}

// ==================== ⑨ compositionFor 仍然认得混合了广播规则的数组（不需要单独处理） ====================
{
  const saved = CONFIG.gameRules.laneWaveComposition;
  CONFIG.gameRules = { ...CONFIG.gameRules, laneWaveComposition: [
    { type: 'melee', count: 1 }, { kind: 'broadcast', skillId: 'x', scope: 'faction' },
  ] };
  const list = compositionFor(null, CONFIG.gameRules, null);
  T('混①-compositionFor 原样返回混合数组（刷兵规则与广播规则共存，不互相排斥）',
    list.length === 2 && list.some(r => r.type === 'melee') && list.some(r => r.kind === 'broadcast'));
  CONFIG.gameRules.laneWaveComposition = saved;
}

board.done();
