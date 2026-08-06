// sim_v33.mjs —— v33 大改版验收：
// ① 穿透型升温（每次命中+30%至120%，换目标重置）与近战兵"恰好3发打死"
// ② 伤害转化改防御向（仅扣血部分）
// ③ 闪电杖 2.2 倍率 + 满充闪电链 + 麻痹走光环（不闪、停照后脱落）
// ④ 锁定前摇 0.3s（塔与对战小兵）
// ⑤ 墙壁走廊模型（isWalkable / constrain / 追击不穿墙）
// ⑥ 对战出兵：首波30s、图腾第10波起每3波、兵种开关、超级兵截止45s
// ⑦ 哀兵（Q20）层数与光环脱落
// ⑧ 光环机制本体（aura 宽限期）
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneAvengerSystem } = await import('../src/systems/LaneAvengerSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
CONFIG.gameRules.spawnEnabled.totem = true; // v35：图腾默认不生成——本测试验证的是"开启后"的接入行为

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkTower(ents, fx, { ad = 152, weapon = 'weapon_piercing', faction = 'blue' } = {}) {
  // 用完整塔模板打底（缺字段会让 AttributeCalculator 返回 undefined——踩过的坑）
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000, attackDamage: ad, armor: 40, magicResist: 40,
      baseAttackSpeed: 0.833, attackRange: 180, attackType: 'physical', healthRegen: 0, bulletSpeed: 0 },
    currentHP: 4000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: faction, faction };
  ents.add(e);
  if (weapon) {
    const inst = { id: ++window._uid, skillId: weapon, state: {} };
    e._skillInstances.push(inst);
    SkillLibrary[weapon].onEquip?.(e.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  }
  return e;
}
function mkMinion(ents, type = 'melee', faction = 'red', x = 50, y = 0) {
  const tpl = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...tpl },
    currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: faction, faction };
  ents.add(e);
  return e;
}

// ==================== ① 升温 + 近战3发 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, fx);
  const melee = mkMinion(ents, 'melee');
  attr.tick();
  T('穿透型：30%护甲穿透+30%法术穿透（永久状态）', (() => {
    const st = attr.calc(tw, fx.getEffects(tw.id));
    return st.armorPenPercent === 30 && st.magicPenPercent === 30;
  })());
  // 3 发打死近战（不能 2 发）
  const hits = [];
  for (let i = 0; i < 5 && melee.alive; i++) {
    attr.tick();
    combat.performAttack(tw, melee);
    hits.push(melee.currentHP);
  }
  T(`近战兵恰好3发打死（2发后剩 ${Math.round(hits[1] ?? -1)} HP，第 ${hits.length} 发死）`,
    hits.length === 3 && hits[1] > 0 && !melee.alive);
  // 升温层数（3 发后 = 3 层，最多 4）
  const heat = fx.getEffectByName(tw.id, '升温');
  T('升温每次命中+1层（3发命中后=3层，display纯计数不影响属性）', !!heat && heat.stacks === 3 && heat.blueprint.kind === 'display');
  // 换目标重置
  const m2 = mkMinion(ents, 'siege');
  attr.tick();
  combat.performAttack(tw, m2);
  const heat2 = fx.getEffectByName(tw.id, '升温');
  T('切换目标升温重置（新目标第1发=1层）', !!heat2 && heat2.stacks === 1);
}

// ==================== ② 伤害转化：防御向、仅扣血部分 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const attacker = mkTower(ents, fx, { weapon: null, faction: 'blue' });
  const victim = mkTower(ents, fx, { weapon: null, faction: 'red' });
  victim.baseStats.damageConvertPct = 50;
  victim.baseStats.armor = 0; victim.baseStats.magicResist = 0;
  attr.tick();
  const dealt = combat.performAttackDirect(attacker.id, victim.id, 200, 'true');
  T(`伤害转化=受击方获得护盾（真伤200 → 扣血${Math.round(dealt)} → 临时护盾${Math.round(victim.tempShield)}=50%）`,
    Math.abs(dealt - 200) < 1 && Math.abs(victim.tempShield - 100) < 1);
  // 攻击方不再回盾
  T('攻击方不再从造成伤害回盾（旧机制已废）', (attacker.tempShield || 0) === 0);
  // 仅扣血部分：护盾吸收的不转化
  const v2 = mkTower(ents, fx, { weapon: null, faction: 'red' });
  v2.baseStats.damageConvertPct = 50; v2.baseStats.armor = 0; v2.baseStats.magicResist = 0;
  v2.tempShield = 1000;
  attr.tick();
  combat.performAttackDirect(attacker.id, v2.id, 200, 'true');
  T('护盾吸收部分不转化（仅扣血计算）', Math.abs(v2.tempShield - (1000 - 200)) < 2);
}

// ==================== ③ 闪电杖：2.2 倍率 / 闪电链 / 麻痹光环 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  let arcs = 0;
  combat.projectiles = { fireArc: () => { arcs++; }, fire: () => {}, fireBeam: () => {} };
  const tw = mkTower(ents, fx, { ad: 100, weapon: 'weapon_lightning' });
  const main = mkMinion(ents, 'melee', 'red', 50, 0); main.baseStats.maxHP = 1e6; main.currentHP = 1e6;
  main.baseStats.armor = 0; main.baseStats.magicResist = 0;
  const others = [];
  for (let i = 0; i < 8; i++) { const m = mkMinion(ents, 'melee', 'red', 60 + i * 5, 20); m.baseStats.maxHP = 1e5; m.currentHP = 1e5; others.push(m); }
  const inst = tw._skillInstances.find(i => i.skillId === 'weapon_lightning');
  tw.targetId = main.id; // 闪电杖 onFrame 读 entity.targetId（正常由 CombatSystem 索敌写入）
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, combat, eventBus: bus };
  // 手动满充
  const DT = 0.05;
  for (let t = 0; t < 30; t += DT) {
    window.gameTime = t; attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame);
    SkillLibrary.weapon_lightning.onFrame(tw.id, DT, inst, ctx);
    fx.update(DT);
  }
  T('闪电杖满充能', (inst.state.charge || 0) >= 1);
  // 满充跳伤 = 15%AD × 2.2 = 33（打 0 抗、60% 无视）
  const before = main.currentHP;
  SkillLibrary.weapon_lightning._doTick ? null : null;
  // 用两次 tick 间隔测单跳伤害
  const hp0 = main.currentHP;
  SkillLibrary.weapon_lightning.onFrame(tw.id, 0.26, inst, ctx); // ≥0.25 触发一跳
  const tickDmg = hp0 - main.currentHP;
  T(`满充单跳≈36（v35方案B：20%×AD100×1.8，实际${tickDmg.toFixed(1)}）`, Math.abs(tickDmg - 36) < 1.5);
  // v35 方案B：闪电链弹射已删除——满充为纯单体，周围敌人不受伤、无电弧
  T('v35 闪电链已删除（无电弧、周围敌人无伤）', arcs === 0 && others.every(o => o.currentHP === 1e5));
  // 麻痹：照射中常驻（永久显示），停照 0.6s 后脱落
  const para = fx.getEffects(main.id).filter(e => e.blueprint.name === '闪电麻痹');
  T('麻痹照射中常驻（光环式，无倒计时闪烁）', para.length === 3 && para.every(e => e.remainingTime === Infinity));
  fx.update(0.7); // 停止照射 0.7s
  T('停止照射后麻痹自动脱落（光环宽限期）', fx.getEffects(main.id).filter(e => e.blueprint.name === '闪电麻痹').length === 0);
}

// ==================== ④ 锁定前摇 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, fx);
  const m = mkMinion(ents, 'melee', 'red', 50, 0);
  window.gameTime = 100;
  let attacks = 0;
  const orig = combat.performAttack.bind(combat);
  combat.performAttack = (a, t) => { attacks++; return orig(a, t); };
  attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame);
  combat.update(0.033); // 首帧：锁定 → 前摇中不开火
  const lockSet = tw._lockUntil > 100;
  window.gameTime = 100.1; combat.update(0.033);
  const firedEarly = attacks;
  window.gameTime = 100.45; attr.tick(); combat.update(0.033);
  T('锁定新目标产生0.3s前摇（前摇内不开火，之后开火）', lockSet && firedEarly === 0 && attacks > 0);
}

// ==================== ⑤ 墙壁走廊模型 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  T('峡谷已声明墙壁', mapSys.hasWalls());
  const lane = mapSys.getLane('mid');
  const wp = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
  T('走廊内可行走', mapSys.isWalkable(wp.x, wp.y));
  // 走廊法向外 300px
  const midIdx = Math.max(1, Math.floor(lane.waypoints.length / 2));
  const a = lane.waypoints[midIdx - 1], b = lane.waypoints[midIdx];
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  const nx = -dy / L, ny = dx / L;
  const wallPt = { x: (a.x + b.x) / 2 + nx * 300, y: (a.y + b.y) / 2 + ny * 300 };
  // navgrid（真实峡谷地形）启用后【野区可走】，"走廊外一律是墙"不再成立——那正是本次改动的目的。
  // 改为断言真实墙体仍然存在且约束仍生效：① 地图边界外不可走；② 图内能找到野区墙块，
  // 且越界修正能把点推回可行走区。
  T('地图边界外不可走', !mapSys.isWalkable(-50, 1776) && !mapSys.isWalkable(3600, 1776));
  let p = null;
  for (let ang = 0; ang < 360 && !p; ang += 7) {
    for (let d = 120; d <= 500 && !p; d += 20) {
      const q = { x: wallPt.x + Math.cos(ang * Math.PI / 180) * d, y: wallPt.y + Math.sin(ang * Math.PI / 180) * d };
      if (q.x > 0 && q.y > 0 && q.x < 3552 && q.y < 3552 && !mapSys.isWalkable(q.x, q.y)) p = q;
    }
  }
  T('地图内存在真实墙体（野区墙块）', !!p);
  const moved = p ? mapSys.constrainToWalkable(p) : false;
  T('越界位置被推回可行走区', !!moved && mapSys.isWalkable(p.x, p.y));
  // 基地区可行走
  const c = mapSys.getBaseCircleCenter('blue'), r = mapSys.getBaseCircleRadius('blue');
  T('基地圈内可行走（半径与画布圈同源）', r > 0 && mapSys.isWalkable(c.x + r * 0.5, c.y - r * 0.5));
  T('嚎哭深渊也有墙壁', (() => { const ms2 = new MapSystem(ents, bus); ms2.setCreateBuildingFn(() => null); ms2.loadMap('howling_abyss_v1'); return ms2.hasWalls(); })());
}

// ==================== ⑥ 对战出兵：首波30s / 图腾 / 开关 / 截止45s ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  const lws = new LaneWaveSystem(ents, bus, mapSys);
  T('对战首波倒计时 = 30s（Q22）', lws.nextWaveTime === 30);
  const spawned = [];
  lws.setCreateMinion((type) => { spawned.push(type); return { id: ++window._uid, alive: true }; });
  // 推到图腾的【起始波】：图腾应出现且在队尾（远程之后）。
  // 波数从编排里读 —— 写死 10 的话，用户一改编排这条就假失败（上一轮就是这么挂的）。
  const _totemFrom = CONFIG.gameRules.laneWaveComposition.find(r => r.type === 'totem').fromWave;
  for (let w = 1; w <= _totemFrom; w++) { spawned.length = 0; lws.waveNumber = w - 1; lws.nextWaveTime = 0; lws.update(0.01);
    // 排空生成队列
    for (let t = 0; t < 30; t += 0.1) lws.update(0.1);
    if (w === _totemFrom - 1) { T(`第 ${w} 波无图腾（起始波为第 ${_totemFrom} 波）`, !spawned.includes('totem')); }
  }
  const oneLane = spawned.slice(0, spawned.length / 6); // 单路单方序列（3路×2方）
  // 用户重排了出兵编排（所有兵种默认生成、支援兵种错开波次）：
  // 图腾从"第10波起每3波"改为"第8波起每4波"。这里跟着新编排断言，
  // 并且【从 CONFIG 读】而不是再抄一遍数字 —— 抄一遍就等着下次改编排时又失同步。
  const totemRule = CONFIG.gameRules.laneWaveComposition.find(r => r.type === 'totem');
  T(`第 ${totemRule.fromWave} 波起生成图腾兵（编排驱动）`, spawned.includes('totem'));
  T('图腾排在远程之后（队尾）', (() => {
    const ti = spawned.indexOf('totem');
    return ti > spawned.indexOf('ranged');
  })());
  // 周期同样从编排里读（当前：第 8 波起每 4 波 → 9/10/11 无，12 有）
  const totemAt = (w) => { spawned.length = 0; lws.waveNumber = w - 1; lws.nextWaveTime = 0; lws.update(0.01);
    for (let t = 0; t < 30; t += 0.1) lws.update(0.1); return spawned.includes('totem'); };
  const f = totemRule.fromWave, n = totemRule.everyN;
  T(`图腾每 ${n} 波一次（${f + 1}✗ ${f + n}✓）`, !totemAt(f + 1) && totemAt(f + n));
  // 兵种开关。
  // 注意：必须先把【上一波遗留的出兵队列】排空再关开关，否则排在队列里的
  // 炮兵（关开关之前就已入队）会在这一轮流出来，被误判成"开关失效"。
  // 编排变大之后每波单位更多、队列更长，这个时序问题才暴露出来。
  CONFIG.gameRules.spawnEnabled.siege = false;
  for (let t = 0; t < 60; t += 0.1) { lws.nextWaveTime = 99999; lws.update(0.1); }
  spawned.length = 0;
  lws.waveNumber = 11; lws.nextWaveTime = 0; lws.update(0.01);
  for (let t = 0; t < 30; t += 0.1) { lws.nextWaveTime = 99999; lws.update(0.1); }
  T(`兵种开关生效（炮车关闭后不生成；本波 ${[...new Set(spawned)].join('/')}）`,
    spawned.length > 0 && !spawned.includes('siege'));
  CONFIG.gameRules.spawnEnabled.siege = true;
  T('截止时间为45s（Q10）', (CONFIG.tuning?.superMinionCutoffBeforeRespawn ?? 0) === 45);
  // 截止逻辑：摧毁水晶 → 超级兵；重生剩余 <45s → 停发
  const nexus = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 }, baseStats: {},
    currentHP: 0, _mapFaction: 'red', _mapTier: 'nexus_lane', _laneId: 'mid', _skillInstances: [] };
  ents.add(nexus);
  bus.emit('entity:death', { entityId: nexus.id });
  T('水晶摧毁登记', mapSys.isNexusDestroyed('red', 'mid'));
  spawned.length = 0; lws.waveNumber = 13; lws.nextWaveTime = 0; lws.update(0.01);
  for (let t = 0; t < 30; t += 0.1) lws.update(0.1);
  T('水晶摧毁后该路对方出超级兵', spawned.includes('super'));
  // 快进到重生前 44s
  mapSys.update(mapSys.NEXUS_RESPAWN_TIME - 44);
  spawned.length = 0; lws.nextWaveTime = 0; lws.update(0.01);
  for (let t = 0; t < 30; t += 0.1) lws.update(0.1);
  T('重生剩余<45s → 停发超级兵（恢复普通兵线）', !spawned.includes('super') && spawned.includes('siege') === (lws.waveNumber % 3 === 0) || !spawned.includes('super'));
}

// ==================== ⑦ 哀兵（Q20） ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const mapSys = new MapSystem(ents, bus);
  const built = [];
  mapSys.setCreateBuildingFn((b) => {
    const e = { id: ++window._uid, type: 'tower', alive: true, pos: { ...b.pos }, baseStats: { maxHP: 100 },
      currentHP: 100, _mapFaction: b.faction, _mapTier: b.tier, _laneId: b.laneId || null, _skillInstances: [] };
    ents.add(e); built.push(e); return e;
  });
  mapSys.loadMap('summoners_rift_v1');
  const avenger = new LaneAvengerSystem(ents, fx, bus, mapSys);
  // 蓝方中路外塔+内塔阵亡
  for (const tier of ['outer', 'inner']) {
    const t = built.find(e => e._mapFaction === 'blue' && e._mapTier === tier && e._laneId === 'mid');
    t.alive = false; bus.emit('entity:death', { entityId: t.id });
  }
  T('哀兵层数=该路被毁攻击塔数（2）', avenger.getStacks('blue', 'mid') === 2);
  // 中路走廊内的蓝方小兵获得效果
  const lane = mapSys.getLane('mid');
  const wp = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
  const ally = mkMinion(ents, 'melee', 'blue', wp.x, wp.y);
  const enemy = mkMinion(ents, 'melee', 'red', wp.x + 10, wp.y);
  const farAlly = mkMinion(ents, 'melee', 'blue', wp.x + 500, wp.y + 500); // 走廊外
  avenger.update(0.6);
  const eff = fx.getEffectByName(ally.id, '哀兵');
  T('走廊内己方小兵获得哀兵（2层：+2%增幅/+6%减免）', !!eff && eff.stacks === 2);
  T('敌方小兵不获得', !fx.getEffectByName(enemy.id, '哀兵'));
  T('走廊外不获得', !fx.getEffectByName(farAlly.id, '哀兵'));
  const crystal = built.find(e => e._mapFaction === 'blue' && e._mapTier === 'nexus_lane' && e._laneId === 'mid');
  T('该路召唤水晶上也显示', !!fx.getEffectByName(crystal.id, '哀兵'));
  // 水晶被毁 → 失效
  crystal.alive = false;
  avenger.update(0.6);
  fx.update(1.5); // 超过光环宽限期
  T('该路水晶被毁后哀兵失效（宽限期后脱落）', avenger.getStacks('blue', 'mid') === 0 && !fx.getEffectByName(ally.id, '哀兵'));
}

// ==================== ⑧ 光环机制本体 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const e = mkMinion(ents, 'melee', 'blue', 0, 0);
  fx.apply(e.id, { name: '测试光环', icon: '✨', kind: 'stat', statKey: 'armor', flatValue: 10,
    aura: true, stackPolicy: 'refresh', uniquePassive: true, description: 't' }, 'test_aura');
  const eff = fx.getEffectByName(e.id, '测试光环');
  T('光环效果显示为常驻（Infinity，无倒计时环）', eff.remainingTime === Infinity);
  fx.update(0.3);
  fx.apply(e.id, { name: '测试光环', icon: '✨', kind: 'stat', statKey: 'armor', flatValue: 10,
    aura: true, stackPolicy: 'refresh', uniquePassive: true, description: 't' }, 'test_aura'); // 刷新
  fx.update(0.5);
  T('宽限期内持续刷新 → 不脱落', !!fx.getEffectByName(e.id, '测试光环'));
  fx.update(0.7); // 累计 >0.6s 未刷新
  T('停止刷新超过宽限期 → 自动脱落', !fx.getEffectByName(e.id, '测试光环'));
}

// ==================== 屠戮 & 防御护盾（v33 数值） ====================
{
  T('近战屠戮 4%（用户定稿）', SkillLibrary.passive_melee_rend.description.includes('4%'));
  T('远程屠戮 6%（用户定稿）', SkillLibrary.passive_ranged_rend.description.includes('6%'));
  // v43（用户定稿："炮兵的被动防御护盾改为只对塔减伤30%"）：
  // 减伤来源从 塔/炮兵/超级兵 收窄到**只有塔**。文案与行为同批改。
  T('防御护盾描述只剩防御塔来源',
    SkillLibrary.passive_siege_shield.description.includes('防御塔')
    && !SkillLibrary.passive_siege_shield.description.includes('超级兵'));
  // 防御护盾：超级兵伤害【不再】减免；塔的伤害仍减 30%
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const sup = mkMinion(ents, 'super', 'blue', 0, 0);
  const siege = mkMinion(ents, 'siege', 'red', 10, 0);
  siege.baseStats.armor = 0; siege.baseStats.magicResist = 0; siege.baseStats.damageReduction = 0;
  siege._skillInstances.push({ id: ++window._uid, skillId: 'passive_siege_shield', state: {} });
  attr.tick();
  const dealt = combat.performAttackDirect(sup.id, siege.id, 100, 'physical');
  T(`超级兵打防御护盾单位【不再】减免（实际${dealt.toFixed(1)}）`, Math.abs(dealt - 100) < 2);
  // 塔来源仍然生效
  const tw = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 5, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 9000, shieldFixedCurrent: 0,
    tempShield: 0, lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'blue' };
  ents.add(tw); attr.tick();
  const dealt2 = combat.performAttackDirect(tw.id, siege.id, 100, 'physical');
  T(`防御塔打防御护盾单位 -30%（实际${dealt2.toFixed(1)}）`, Math.abs(dealt2 - 70) < 2);
}

console.log(`v33验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
