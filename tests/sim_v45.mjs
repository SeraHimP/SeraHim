/**
 * sim_v45.mjs —— v45 第一批验收
 *
 *   一  屠龙者：给出最后一击的**那一个单位**获得该龙对应的龙魂，持续 60s
 *   二  元素龙自带：1 层对应龙魂 + （该元素已死数 + 1）层对应巨龙之力
 *   三  风的方向重做：+移速 / +攻速 / +攻速收益率（推翻 v44 的"给塔发射程"）
 *   四  属性面板抬头合并：阵营色圆点 + 单位类型，删掉 #编号与右侧徽标
 *
 * 断言尽量钉**行为**（真的装上了魂 / 真的到点摘掉 / 有效攻速真的变了）。
 * 只能钉源码的（面板 HTML）钉的是**取值口径**，不是"某个名字存在" ——
 * 光魂那次的教训：钉定义等于没钉，代码搬个家断言照样绿。
 */
import { setupWindow, scoreboard, srcOf, srcRaw } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { CONFIG } = await import('../src/data/Config.js');
const { DragonSystem, DRAGON_ELEMENTS, dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');

const { T, done } = scoreboard('v45验收');
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mk() {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mkUnit = (type, fac) => {
    const e = { id: ++window._uid, type, alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.tower) }, currentHP: 1000,
      shieldFixedCurrent: 0, tempShield: 0, attackCooldown: 0, targetId: null,
      _skillInstances: [], _mapFaction: fac, faction: fac, _inCombat: false, _attackerCount: 0 };
    ents.add(e); return e;
  };
  /** 造一条已死的龙，最后一击记在 killer 身上。 */
  const killDragon = (killer, element, ancient = false) => {
    const d = { id: ++window._uid, type: 'dragon', alive: false, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.dragon }, currentHP: 0, _skillInstances: [],
      _element: element, _isAncient: ancient,
      _lastHitBy: killer.id, _lastHitFaction: killer._mapFaction };
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
    return d;
  };
  return { bus, ents, fx, ds, mkUnit, killDragon };
}
const hasSoul = (e, id) => (e._skillInstances || []).some(s => s.skillId === id);
const instOf = (e, id) => (e._skillInstances || []).find(s => s.skillId === id);

// ==================== 一、屠龙者 ====================
{
  window.gameTime = 100;
  const { ds, fx, mkUnit, killDragon } = mk();
  const tower = mkUnit('tower', 'blue');
  killDragon(tower, 'thunder');
  const sec = CONFIG.gameRules.dragon.slayer.durationSec;

  T('屠①-最后一击的单位拿到了对应元素的龙魂（雷龙→雷魂）',
    hasSoul(tower, DRAGON_ELEMENTS.thunder.soul));
  T('屠②-限时标记按配置的秒数打（不是写死的 60）',
    instOf(tower, 'dragonsoul_thunder').state.slayerUntil === 100 + sec);
  // v51.1 改稿（用户："不要杀死龙后获得屠龙者，直接获得XX秒的临时龙魂，在临时龙魂
  // 状态上显示倒计时"）：不再另起一个独立的"屠龙者"徽标，倒计时直接长在龙魂本体
  // 那个展示效果（soul_display_<soulId>，name = 该魂自己的名字）上。
  T('屠③-龙魂本体的展示状态带着真实倒计时（不是另一个独立的"屠龙者"徽标）',
    fx.getEffects(tower.id).some(e =>
      e.sourceId === `soul_display_${DRAGON_ELEMENTS.thunder.soul}`
      && e.remainingTime > 0 && e.remainingTime <= sec));

  // 到期：时间推过去，跑一帧 update
  window.gameTime = 100 + sec + 1;
  ds.update(0.016);
  T('屠④-到点后龙魂被摘掉（不是永久白拿）', !hasSoul(tower, 'dragonsoul_thunder'));

  // 领受者是**一个单位**而不是全阵营
  window.gameTime = 200;
  const { ds: ds2, mkUnit: mk2, killDragon: kill2 } = mk();
  const a = mk2('tower', 'blue'), b = mk2('tower', 'blue');
  kill2(a, 'fire');
  T('屠⑤-只有补刀的那一个拿到，同阵营的另一座塔没有',
    hasSoul(a, 'dragonsoul_fire') && !hasSoul(b, 'dragonsoul_fire'));
  void ds2;

  // 近战兵抢到人头也算 —— 屠龙者刻意不受 SOUL_REWARD_OK 限制。
  // 限制领受者的话它会在**最常见**的情形下静默失效：兵线上近战兵最多，最可能补到尾刀。
  window.gameTime = 300;
  const w3 = mk();
  const melee = w3.mkUnit('melee', 'red');
  w3.killDragon(melee, 'poison');
  T('屠⑥-近战兵补刀也给（屠龙者不吃"大型小兵+塔"那条限制）',
    hasSoul(melee, 'dragonsoul_poison'));

  // 已有永久魂的单位再补一刀：**不能**给永久魂盖上到期时间。
  // 这条曾经是真 bug：`else slayerUntil = Math.max(slayerUntil||0, now+sec)`
  // 会把 undefined 当 0，于是永久魂 60 秒后被 _expireSlayers 摘走。
  window.gameTime = 400;
  const w4 = mk();
  const perm = w4.mkUnit('tower', 'blue');
  w4.ds._toggleSoul(perm, 'dragonsoul_earth');           // 模拟阵营永久魂
  w4.killDragon(perm, 'earth');
  const pInst = instOf(perm, 'dragonsoul_earth');
  T('屠⑦-已有永久魂时不打限时标记（否则 60 秒后永久魂会被摘掉）',
    !pInst.state.slayerUntil);
  window.gameTime = 400 + sec + 1;
  w4.ds.update(0.016);
  T('屠⑧-推过 60 秒后永久魂仍在', hasSoul(perm, 'dragonsoul_earth'));

  // 开关
  window.gameTime = 500;
  const w5 = mk();
  const t5 = w5.mkUnit('tower', 'blue');
  CONFIG.gameRules.dragon.slayer.enabled = false;
  w5.killDragon(t5, 'wind');
  CONFIG.gameRules.dragon.slayer.enabled = true;
  T('屠⑨-开关关掉后不再发放（软编码，编辑器里可关）', !hasSoul(t5, 'dragonsoul_wind'));
}

// ==================== 二、元素龙自带对应的力与魂 ====================
{
  window.gameTime = 0;
  const { ds, fx, ents } = mk();
  const mkDragon = (el) => {
    const d = { id: ++window._uid, type: 'dragon', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.dragon }, currentHP: 5000, _element: el,
      _isAncient: false, _skillInstances: [] };
    ents.add(d); return d;
  };

  const d1 = mkDragon('thunder');
  ds.applyDragonSelfBuffs(d1);
  T('自①-第一条雷龙：自带 1 层雷魂', hasSoul(d1, DRAGON_ELEMENTS.thunder.soul));
  T('自②-第一条雷龙：自带 1 层雷之力（0 条已死 + 1）', d1._selfPowerStacks === 1);

  // 用户给的例子：已死 2 雷 + 1 火 + 1 山 → 第 5 条若是雷龙 → 1 雷魂 + 3 雷之力
  ds.killCounts = { thunder: 2, fire: 1, earth: 1 };
  const d5 = mkDragon('thunder');
  ds.applyDragonSelfBuffs(d5);
  T('自③-用户给的例子：已死 2 雷 → 新雷龙自带 3 层雷之力', d5._selfPowerStacks === 3);
  T('自④-魂始终只有 1 层（层数只作用于力）',
    (d5._skillInstances || []).filter(s => s.skillId === DRAGON_ELEMENTS.thunder.soul).length === 1);
  T('自⑤-层数只看**同种**的死亡数，火/山那两条不算进来',
    d5._selfPowerStacks === (ds.killCounts.thunder + 1));

  // 力真的叠上去了（钉行为，不是钉字段）
  const keys = dragonPowerBuffs('thunder').map(b => b.statKey);
  const eff = fx.getEffects(d5.id).filter(e => keys.includes(e.blueprint?.statKey));
  const cap = CONFIG.dragonPower.maxStacks;
  T('自⑥-每一项雷之力都真的挂上了效果',
    keys.every(k => eff.some(e => e.blueprint.statKey === k)));
  T('自⑦-叠加层数受 maxStacks 夹取（不会因为龙自带就突破上限）',
    eff.every(e => (e.stacks || 1) <= cap));

  // 远古龙没有元素，走另一条分支
  const anc = { id: ++window._uid, type: 'dragon', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.dragon }, currentHP: 5000, _isAncient: true,
    _element: null, _skillInstances: [] };
  ents.add(anc);
  ds.applyDragonSelfBuffs(anc);
  T('自⑧-远古龙自带远古之力（没有元素就没有层数概念）',
    hasSoul(anc, 'dragonsoul_ancient') && anc._selfPowerStacks === undefined);

  // 关掉 effect 开关 = 量"有龙但没增益"的基线，龙自带的那份也必须一起关
  const w2 = mk();
  const d9 = { id: ++window._uid, type: 'dragon', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.dragon }, currentHP: 5000, _element: 'fire',
    _isAncient: false, _skillInstances: [] };
  w2.ents.add(d9);
  CONFIG.dragonToggles.effect = false;
  w2.ds.applyDragonSelfBuffs(d9);
  CONFIG.dragonToggles.effect = true;
  T('自⑨-effect 开关关掉时龙自己也不带增益（否则基线对照不干净）',
    (d9._skillInstances || []).length === 0);

  // 挂点：必须在 createDragon（实体诞生的唯一一处），不能挂在 spawnDragon。
  // 用户实测过"元素龙并没有自带"——根因就是挂在了 spawnDragon 上，
  // 而设置里的"手动生成龙"走的是 main.js → createDragon 这条旁路，生成出来的龙是裸的。
  const fac = srcOf('src/core/factories.js');
  const dsrc = srcOf('src/systems/DragonSystem.js');
  T('自⑩-发放挂在 createDragon 里（两条出生路径共用的那一处）',
    /dragonSystem\.applyDragonSelfBuffs\(entity\)/.test(fac));
  T('自⑪-spawnDragon 里不再单独发一份（否则计时刷新的龙会拿双份）',
    !/applyDragonSelfBuffs/.test(dsrc.split('spawnDragon()')[1]?.split('_onDragonKilled')[0] || ''));
}

// ==================== 三、风：速度主题 ====================
{
  const ds = srcOf('src/core/skills/dragonSouls.js');
  const w = CONFIG.dragonSouls.stat.wind;
  const p = CONFIG.dragonPower.wind;

  T('风①-风魂的常驻数值围绕"速度"：移速 + 攻速 + 攻速收益率',
    w.moveSpeed > 0 && w.bonusAttackSpeedPct > 0 && w.attackSpeedRatio > 0);
  T('风②-风之力同样是速度三件套（力与魂同一个主题）',
    p.moveSpeed > 0 && p.bonusAttackSpeedPct > 0 && p.attackSpeedRatio > 0);
  T('风③-attackSpeedRatio 是风独占的（别的元素不碰，避免主题重复）',
    Object.keys(CONFIG.dragonPower).filter(k => k !== 'maxStacks')
      .every(el => el === 'wind' || !('attackSpeedRatio' in CONFIG.dragonPower[el]))
    && Object.keys(CONFIG.dragonSouls.stat)
      .every(el => el === 'wind' || !('attackSpeedRatio' in CONFIG.dragonSouls.stat[el])));
  // v51.7：本条已被推翻，见 tests/sim_v51.mjs 里的重做用例——塔身上没有别的攻速
  // 加成可供"收益率"放大，连着两轮真实对局（--sweep soul）都测出这半形同虚设，
  // 用户要求重做成直接发攻速百分比。这里只留下"旧机制确实已经被替换掉"的负向断言，
  // 完整的新行为验证在 sim_v51.mjs。
  T('风④-塔那一半不再是攻速收益率（v51.7 重做，见 sim_v51.mjs）',
    !('towerAttackSpeedRatio' in CONFIG.dragonSouls.wind)
    && !/statKey: 'attackSpeedRatio', flatValue: p\.towerAttackSpeedRatio/.test(ds));
}

// ==================== 五、攻城车：射程比放弃距离长导致锁定永远建立不起来 ====================
// 用户："攻城车依旧不显示攻城模式，红线也不显示。是不是因为攻城车射程比较长？"——是。
// 这一条钉的是**行为**：让攻城车站在"射程内、但超过固定放弃距离"的位置上跑几帧，
// 锁定必须建立起来。只钉源码常量的话，下次有人把 Math.max 换个写法就假通过了。
{
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  // 最小地图桩：这条用例只关心"目标校验 → siegeAcquire"这一段，
  // 兵线/地形/守家圈全部给成空，避免把无关系统拖进来。
  const mapStub = {
    active: true,
    currentMap: { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }] },
    getDefenseZone: () => null,
    isWalkable: () => true,
    constrainToWalkable: (p) => p,
  };
  const lms = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, mapStub);

  const ramRange = CONFIG.templates.ram.attackRange;
  const drop = (CONFIG.tuning?.acquisitionRange ?? 200) * (CONFIG.tuning?.chaseDropFactor ?? 1.2);
  T('城①-前提：攻城车射程确实超过了固定的放弃距离（否则这条测的是空气）',
    ramRange > drop);

  // 站位：距离取在 (放弃距离, 射程) 之间 —— 正是攻城车实际开火的那一段
  const dist = (drop + ramRange) / 2;
  const ram = { id: ++window._uid, type: 'ram', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.ram }, currentHP: 99999, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 99, targetId: null, _inCombat: false, _attackerCount: 0,
    _mapFaction: 'blue', faction: 'blue', _laneId: 'mid', _laneDirection: 'forward',
    // v49：闸门改成【攻城炮】（旧的 passive_siege_weapon 已整个删除）
    _skillInstances: [{ id: ++window._uid, skillId: 'passive_ram_cannon', state: {} }] };
  const tw = { id: ++window._uid, type: 'tower', alive: true, pos: { x: dist, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 99999, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 99, targetId: null, _inCombat: false, _attackerCount: 0,
    _mapFaction: 'red', faction: 'red', _mapTier: 'outer', _laneId: 'mid', _skillInstances: [] };
  ents.add(ram); ents.add(tw);
  window.gameTime = 1000;
  for (let i = 0; i < 5; i++) { window.gameTime += 0.1; lms.update(0.1); }
  T('城②-在"射程内但超过固定放弃距离"处能锁定建筑（红线与攻城模式的唯一依据）',
    ram._ramLockId === tw.id);
}

// ==================== 四、属性面板抬头合并 ====================
{
  const ui = srcOf('src/ui/UIManager.js');
  const html = srcRaw('index.html');
  T('面①-抬头不再拼 #编号（用户："不要显示……右侧的＃编号"）',
    !/#\$\{e\.id\}/.test(ui));
  T('面②-右侧的阵营徽标节点已删（合并到左上角，同一件事只写一处）',
    !/selectionBadge/.test(ui) && !/id="selectionBadge"/.test(html));
  T('面③-抬头用阵营**色圆点**而不是文字阵营',
    /FAC_DOT/.test(ui) && /class="fac-dot"/.test(ui) && !/🔵 蓝方/.test(ui));
  T('面④-阵营三值都要有分支（v43 栽过：没有第三档的三元把中立塔显示成红方）',
    /FAC_DOT\s*=\s*\{[^}]*blue[^}]*red[^}]*neutral[^}]*\}/.test(ui));
  T('面⑤-塔显示的是层级名（外塔/内塔/…），不再是笼统的"防御塔"+层级两处重复',
    /tierLabels\[e\._mapTier\]/.test(ui));
  T('面⑥-圆点有配套样式（否则是个 0×0 的空 span）',
    /#selectionTitle \.fac-dot/.test(html));
}

done();
