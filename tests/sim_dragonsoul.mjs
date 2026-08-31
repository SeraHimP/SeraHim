// 阵营龙魂规则验收（v43 全部重写）
//
// ==================== 规则改了什么 ====================
// 旧规则："6 条元素龙全部刷完再一次性结算，谁的击杀数 ≥4 谁成魂、都不到则无魂"。
// 新规则（用户定稿）："某阵营拿满 4 条**直接**获得龙魂，然后不再生成元素龙而是一直生成远古龙。"
//
// 三处关键差别，本套逐条钉住：
//   ① 归属：从"参与塔投票"改成 **最后一击**（_lastHitFaction）。
//      投票制下一条龙被双方轮流打时谁塔多谁拿 —— 抢龙这件事就没有博弈了。
//   ② 奖励对象：从"参与的那几座塔"扩到 **该阵营全体塔 + 全体大型小兵**
//      （= 除近战/远程外的所有兵种），且**新生成的单位要补发**。
//      不补的话奖励只对当时在场的生效，后面每一波新兵都是裸的。
//   ③ 时机：拿满门槛立即成魂，不再等 6 条刷完。紧迫感完全不同 ——
//      旧规则下前 5 条龙谁拿都无所谓，反正最后一起算。
//
// 于是"3:3 平局无魂"这个旧结局**不再存在**：先到 4 的一方当场拿走。
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
const { CONFIG } = await import('../src/data/Config.js');
const { DragonSystem, DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const board = scoreboard('阵营龙魂规则验收');
const T = board.T;

/** 造一个世界：双方各 2 塔 + 各 1 个炮车（大型小兵）+ 各 1 个近战（不该拿奖励）。 */
function mk() {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const units = { blue: [], red: [] };
  const mkUnit = (type, fac, tier) => {
    const e = { id: ++window._uid, type, alive: true, pos: { x: 0, y: fac === 'blue' ? 0 : 500 },
      baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.tower) }, currentHP: 1000,
      _skillInstances: [], _mapFaction: fac, faction: fac };
    if (tier) e._mapTier = tier;
    ents.add(e); units[fac].push(e); return e;
  };
  for (const fac of ['blue', 'red']) {
    mkUnit('tower', fac, 'outer'); mkUnit('tower', fac, 'base');
    mkUnit('siege', fac); mkUnit('melee', fac);
  }
  const pick = (fac, type) => units[fac].filter(u => u.type === type);

  /** 用某阵营的**最后一击**杀掉一条龙。 */
  const killBy = (fac, element, ancient = false) => {
    if (!ancient) ds.elementDragonSpawned++;
    const d = { id: ++window._uid, type: 'dragon', alive: false, pos: { x: 250, y: 250 },
      baseStats: { ...CONFIG.templates.dragon }, currentHP: 0,
      _element: element, _isAncient: ancient, _skillInstances: [],
      _lastHitBy: pick(fac, 'tower')[0].id, _lastHitFaction: fac };
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
  };
  return { bus, ents, fx, ds, units, pick, killBy };
}

const hasSoul = (e, id) => e._skillInstances.some(s => s.skillId === id);
const anySoul = (e) => e._skillInstances.some(s => s.skillId.startsWith('dragonsoul_'));

// ==================== ① 领受范围：塔 + 大型小兵，不含近战/远程 ====================
{
  const ok = DragonSystem.SOUL_REWARD_OK;
  T('①-塔算领受者', ok({ type: 'tower' }) === true);
  T('①-大型小兵都算（炮车/超级兵/图腾/术士/蚀骨/攻城车）',
    ['siege', 'super', 'totem', 'warlock', 'corrupt', 'ram'].every(t => ok({ type: t }) === true));
  T('①-近战/远程不算', ok({ type: 'melee' }) === false && ok({ type: 'ranged' }) === false);
  T('①-龙自己不算', ok({ type: 'dragon' }) === false);
  // 判定刻意不读 isLargeMinion —— 那个标记还被渲染体积等处用着。
  // srcOf **默认剥注释**（含块注释）：SOUL_REWARD_OK 的 JSDoc 里就写着
  // "刻意不读 isLargeMinion"，不剥的话这条断言会匹配到自己的解释文字。
  const src = srcOf('src/systems/DragonSystem.js');
  T('①-判定不依赖 isLargeMinion（两件事不绑死在一个字段上）',
    !/isLargeMinion/.test(src));
}

// ==================== ② 归属按最后一击；奖励发给全阵营 ====================
{
  const { ds, units, pick, killBy } = mk();
  killBy('blue', 'fire');
  T('②-最后一击方记到击杀数', ds.factionTotals.blue === 1 && ds.factionTotals.red === 0);
  const buffed = (e) => Object.values(e.__fx || {}).length >= 0;   // 占位，真正的断言在下面
  void buffed;
  // 巨龙之力发给该阵营的全部塔 + 大型小兵
  const { fx } = mk();   // 另起一个干净世界做效果检查
  const w = mk();
  w.killBy('blue', 'fire');
  const hasPower = (e) => w.fx.getEffects(e.id).some(x => x.blueprint?.stackKey?.startsWith('dragon_fire'));
  T('②-该阵营全部塔拿到巨龙之力', w.pick('blue', 'tower').every(hasPower));
  T('②-该阵营大型小兵也拿到', w.pick('blue', 'siege').every(hasPower));
  // v45：用户改了规则 ——「巨龙之力现在作用于所有单位（包含普通小兵），
  // 只有龙魂作用于大型小兵+塔」。所以这一条从"近战兵不拿"翻成"近战兵也拿"。
  // 这是**规则改了**，不是断言写错了；魂的那条范围断言（③）原样保留。
  T('②-近战兵现在也拿力（v45：力的范围放宽到所有单位）',
    w.pick('blue', 'melee').every(hasPower));
  T('②-力的层数不因兵种打折（近战与大型兵同层）', (() => {
    const st = (e) => (w.fx.getEffects(e.id).find(x => x.blueprint?.stackKey?.startsWith('dragon_fire')) || {}).stacks;
    return st(w.pick('blue', 'melee')[0]) === st(w.pick('blue', 'siege')[0]);
  })());
  T('②-敌方一点都没有', [...w.units.red].every(e => !hasPower(e)));
  void fx; void units; void pick;
}

// ==================== ③ 拿满 4 条【立即】成魂，之后只刷远古龙 ====================
{
  const { ds, units, killBy } = mk();
  const seen = [];
  ds.eventBus.on('dragon:soulResolved', (d) => seen.push(d));
  for (let i = 0; i < 3; i++) killBy('blue', 'fire');
  T('③-3 条时尚未成魂', ds.soulResolved === false && ds.soulOwner === null);
  killBy('blue', 'fire');                      // 第 4 条
  T('③-第 4 条【当场】成魂（不再等 6 条刷完）', ds.soulResolved === true && ds.soulOwner === 'blue');
  T('③-魂的元素 = 该阵营击杀最多的那种（炎龙）',
    ds.getSouls().blue[0] === DRAGON_ELEMENTS.fire.soul);
  T('③-另一方无魂', ds.getSouls().red.length === 0);
  T('③-成魂阵营的塔与大型小兵都装上了魂',
    units.blue.filter(u => DragonSystem.SOUL_REWARD_OK(u))
      .every(u => hasSoul(u, DRAGON_ELEMENTS.fire.soul)));
  T('③-近战兵没装魂', units.blue.filter(u => u.type === 'melee').every(u => !anySoul(u)));
  T('③-敌方没有任何单位装魂', units.red.every(u => !anySoul(u)));
  T('③-结算事件发一次且带阵营与比分',
    seen.length === 1 && seen[0].owner === 'blue' && seen[0].factionTotals.blue === 4);
  T('③-成魂后进入远古龙阶段', ds.soulUnlocked === true && ds.ancientSpawned === 0);
}

// ==================== ④ 抢龙：最后一击换人，奖励就换人 ====================
{
  const { ds, killBy } = mk();
  for (let i = 0; i < 3; i++) killBy('blue', 'fire');
  killBy('red', 'water');    // 红方抢到第 4 条 —— 蓝方 3、红方 1，都没到门槛
  T('④-抢到的那条算红方', ds.factionTotals.blue === 3 && ds.factionTotals.red === 1);
  T('④-谁都没到 4 → 仍未成魂', ds.soulResolved === false);
  killBy('blue', 'fire');    // 蓝方补到 4
  T('④-蓝方补满 4 条后成魂', ds.soulOwner === 'blue');
}

// ==================== ⑤ 新生成的单位要补发（否则奖励几十秒后自动失效）====================
{
  const { ds, ents, fx, killBy } = mk();
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');
  const mkFresh = (type, fac) => {
    const e = { id: ++window._uid, type, alive: true, pos: { x: 99, y: 0 },
      baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.tower) }, currentHP: 1000,
      _skillInstances: [], _mapFaction: fac, faction: fac, _mapTier: type === 'tower' ? 'outer' : undefined };
    ents.add(e); return e;
  };
  const freshTower = mkFresh('tower', 'blue');
  T('⑤-新建单位默认什么都没有', !anySoul(freshTower));
  T('⑤-补发成功（龙魂）', ds.equipExistingSoul(freshTower) === true
    && hasSoul(freshTower, DRAGON_ELEMENTS.fire.soul));
  T('⑤-巨龙之力也按已击杀条数补齐（4 条炎龙 → 4 层）',
    fx.getEffects(freshTower.id).some(x => x.blueprint?.stackKey?.startsWith('dragon_fire') && x.stacks === 4));

  const freshSiege = mkFresh('siege', 'blue');
  T('⑤-新出的大型小兵同样补发', ds.equipExistingSoul(freshSiege) === true && anySoul(freshSiege));
  const freshMelee = mkFresh('melee', 'blue');
  // v45：近战兵现在要补【力】、但仍然不给【魂】。
  // 补发这条尤其不能漏：击杀时的 _grantAll 已经放宽到所有单位，补发这边如果还卡着
  // 老范围，就会变成"开局在场的近战兵有力、后面出的没有" —— 两处范围不一致
  // 比两处都窄难查得多（本仓库刚在龙的两条出生路径上栽过同一形状）。
  T('⑤-新出的近战兵要补【力】', ds.equipExistingSoul(freshMelee) === true
    && fx.getEffects(freshMelee.id).some(x => x.blueprint?.stackKey?.startsWith('dragon_fire')));
  T('⑤-但近战兵仍然拿不到【魂】', !anySoul(freshMelee));
  const freshRed = mkFresh('tower', 'red');
  T('⑤-敌方新塔不补发', ds.equipExistingSoul(freshRed) === false && !anySoul(freshRed));

  ds.equipExistingSoul(freshTower); ds.equipExistingSoul(freshTower);
  T('⑤-重复补发幂等（不会叠出多个魂）',
    freshTower._skillInstances.filter(s => s.skillId.startsWith('dragonsoul_')).length === 1);
}

// ==================== ⑥ 远古龙魂（远古处决）：限时 300s 的处决，双方都能抢 ====================
// v51.6：展示名从"远古之力"改成"远古处决"——那个名字现在专指新增的永久全属性
// 加成（见下面新增的"远古之力（力）"那一节），不再和限时的处决效果撞名。
{
  const { ds, fx, units, killBy } = mk();
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');   // 蓝方成魂
  window.gameTime = 100;
  killBy('red', null, true);                            // 红方拿下一条远古龙
  const redOk = units.red.filter(u => DragonSystem.SOUL_REWARD_OK(u));
  T('⑥-远古龙魂发给最后一击方的全体领受者',
    redOk.every(u => hasSoul(u, 'dragonsoul_ancient')));
  T('⑥-未成魂的一方照样能拿远古（这是落后方的翻盘工具）', ds.soulOwner === 'blue');
  T('⑥-状态栏可见、限时（不是永久）',
    fx.getEffects(redOk[0].id).some(x => x.blueprint.name === '远古处决'
      && x.remainingTime > 0 && x.remainingTime !== Infinity));
  const dur = CONFIG.dragonSouls.ancient.durationSec;
  T('⑥-限时 180 秒（八条龙魂里唯一限时的一条；v51.6 从 240 改稿为 300，v51.9 用户实测超标改为 180）', dur === 180);
  // 到点回收
  window.gameTime = 100 + dur + 1;
  ds.update(0.1);
  T('⑥-到期后技能实例被摘掉', redOk.every(u => !hasSoul(u, 'dragonsoul_ancient')));
  T('⑥-龙魂本体不受影响（永久）',
    units.blue.filter(u => DragonSystem.SOUL_REWARD_OK(u)).every(u => anySoul(u)));
  window.gameTime = 0;
}

// ==================== ⑥b 远古之力（新增，v51.6；v51.9 改用核心属性加成）：永久核心属性加成，覆盖全部单位 ====================
// 用户："远古巨龙目前只有龙魂，没有远古之力，远古之力（作用在某阵营所有单位）的效果
//        每层：+5%全属性加成（永久生效）。"——与限时的"远古处决"（上面⑥那节）是两件
//        独立的事：一个永久叠层覆盖全部单位（含近战/远程），一个限时只给塔+大型小兵。
// v51.9：用户实测发现太超标，改用核心属性加成（更窄的六项属性），5%→2.5%。
{
  const { ds, fx, units, killBy } = mk();
  const findPower = (e) => fx.getEffects(e.id).find(x => x.sourceId === 'dragon_ancient_power_0');

  killBy('red', null, true); // 第一条远古龙
  const meleeRed = units.red.find(u => u.type === 'melee');
  const towerRed = units.red.find(u => u.type === 'tower');
  T('⑥b-近战兵也拿到远古之力（POWER_REWARD_OK 范围，不是龙魂那条窄范围）',
    !!findPower(meleeRed) && findPower(meleeRed).stacks === 1);
  // v51.9：用户实测"4力+雷魂的蓝方打不过0力+远古龙魂的红方"，把全属性加成砍成
  // 核心属性加成、5%→2.5%（见 Config.js dragonPower.ancient 的头注）。
  T('⑥b-塔同样拿到，且每层 +2.5%核心属性（与 CONFIG.dragonPower.ancient.coreStatsPct 一致）',
    findPower(towerRed).blueprint.flatValue === CONFIG.dragonPower.ancient.coreStatsPct
    && CONFIG.dragonPower.ancient.coreStatsPct === 2.5
    && findPower(towerRed).blueprint.statKey === 'coreStatsPct');
  T('⑥b-是永久效果，不受"远古处决"限时窗口影响',
    findPower(towerRed).blueprint.duration === Infinity && findPower(towerRed).blueprint.permanent === true);

  killBy('red', null, true); // 第二条远古龙，同一阵营再下一条
  T('⑥b-再杀一条远古龙，层数叠加到2层（不是刷新成1层）', findPower(towerRed).stacks === 2);

  // 窗口期内新出生的单位（含近战/远程）也要补到当前层数——与元素之力的 factionKills
  // 补发同一个道理，否则"旧的一批死绝、新出生的一批没有"。
  const newMelee = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 500 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 500, _skillInstances: [],
    _mapFaction: 'red', faction: 'red' };
  ds.entities.add(newMelee);
  ds.equipExistingSoul(newMelee);
  T('⑥b-新出生的近战兵补到2层（不是只对开局在场的单位生效）',
    !!findPower(newMelee) && findPower(newMelee).stacks === 2);

  T('⑥b-未拿到远古龙的一方没有这个效果', !findPower(units.blue.find(u => u.type === 'tower')));
}

// ==================== ⑦ 两个独立开关 ====================
{
  const bak = { ...CONFIG.dragonToggles };
  CONFIG.dragonToggles.spawn = false;
  {
    const { ds } = mk();
    ds.paused = false;
    const before = ds.elementDragonSpawned;
    for (let i = 0; i < 100; i++) ds.update(10);
    T('⑦-spawn 关掉后一条龙都不刷', ds.elementDragonSpawned === before);
  }
  CONFIG.dragonToggles.spawn = true;
  CONFIG.dragonToggles.effect = false;
  {
    const { ds, units, killBy } = mk();
    for (let i = 0; i < 4; i++) killBy('blue', 'fire');
    T('⑦-effect 关掉后照常结算归属（用于做"有龙但没魂"的平衡基线）',
      ds.soulOwner === 'blue' && ds.factionTotals.blue === 4);
    T('⑦-但不发放任何增益', units.blue.every(u => !anySoul(u)));
  }
  Object.assign(CONFIG.dragonToggles, bak);
}

// ==================== ⑧ 龙坑交替 ====================
// v51.9 修复：用户报"蓝方一直在输，从未赢过"排查出的一条——首条龙坑此前硬编码
// 从 'top' 出（top 坑推的正是【蓝方】基地），等于每一局红方都天然先手抢到"第一条
// 龙威胁蓝方"这个地理优势，蓝方永远没有。改成每局随机决定首条坑位，组内仍然
// 严格交替（公平性只挪到"哪边先手"上随机，不影响"轮流"这条规则本身）。
{
  const { ds } = mk();
  const sides = [];
  ds.setCreateEntity((type, o) => { sides.push(o.pitSide); return null; });
  ds.paused = false;
  for (let i = 0; i < 4; i++) ds.spawnDragon();
  T(`⑧-上/下龙坑严格交替（实际 ${sides.join('/')}）`,
    sides.join('/') === 'top/bot/top/bot' || sides.join('/') === 'bot/top/bot/top');
  T('⑧-首条坑位是合法值（不再固定是 top——固定就是本条要修的不对称本身）',
    sides[0] === 'top' || sides[0] === 'bot');
}

// ==================== ⑨ 重置本局把整局进度清干净 ====================
{
  const { ds, killBy } = mk();
  for (let i = 0; i < 4; i++) killBy('blue', 'fire');
  ds.resetRun();
  T('⑨-resetRun 清掉成魂状态与击杀数',
    ds.soulOwner === null && ds.soulResolved === false && ds.soulUnlocked === false
    && ds.factionTotals.blue === 0 && ds.getSouls().blue.length === 0);
  // v51.9：首条坑位改成每局随机（见上面⑧那条），resetRun 也要重新掷一次骰子，
  // 不能停在上一局用剩的值——这里只能钉"复位后仍是合法坑位"，具体是哪一边不该
  // 是固定值（固定就是回归到本条要修的不对称）。
  T('⑨-龙坑交替也复位（重开一局仍是合法坑位，不会残留成 undefined 之类的坏状态）',
    ds._nextPitSide === 'top' || ds._nextPitSide === 'bot');
}

// ==================== ⑩ getSouls / getState 仍然可用（WorldState 与 UI 读它们）====================
{
  const { ds, killBy } = mk();
  T('⑩-getSouls() 存在且返回双阵营结构', typeof ds.getSouls === 'function'
    && Array.isArray(ds.getSouls().blue) && Array.isArray(ds.getSouls().red));
  for (let i = 0; i < 2; i++) killBy('blue', 'fire');
  const st = ds.getState();
  T('⑩-getState 含阵营比分与规则参数',
    st.factionTotals.blue === 2 && st.soulThreshold === 4
    && st.soulResolved === false && st.soulOwner === null && !!st.souls);
}

// ==================== ⑪ 没有最后一击归属方（环境击杀）不结算，也不该崩 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const t = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 1000,
    _skillInstances: [], _mapTier: 'outer' };   // 无 _mapFaction
  ents.add(t);
  for (let i = 0; i < 7; i++) {
    ds.elementDragonSpawned++;
    const d = { id: ++window._uid, type: 'dragon', alive: false, pos: { x: 1, y: 1 },
      baseStats: {}, currentHP: 0, _element: 'fire', _skillInstances: [] };  // 无 _lastHitFaction
    ents.add(d);
    bus.emit('entity:death', { entityId: d.id });
  }
  T('⑪-无归属击杀不计数', ds.factionTotals.blue === 0 && ds.factionTotals.red === 0);
  T('⑪-无归属击杀不成魂', ds.soulOwner === null && ds.soulResolved === false);
  T('⑪-没有最后一击方时不发放任何增益（宁可少发也不能误发给敌方）',
    !fx.getEffects(t.id).some(e => e.blueprint?.stackKey?.startsWith('dragon_fire')));
}

// ==================== ⑫ 旧的按塔解锁旁路仍然不存在 ====================
{
  const { ds } = mk();
  T('⑫-_unlockSoulForTower 已删除（语义与阵营规则相反）', ds._unlockSoulForTower === undefined);
  T('⑫-_applyElementBuffToTower 已改名（奖励不再限于塔）',
    ds._applyElementBuffToTower === undefined && typeof ds._applyElementBuff === 'function');
}

board.done();
