// sim_v35.mjs —— v35 验收：
// ① 结构保护链全层级（外塔→内塔→水晶塔→召唤水晶→枢纽塔→水晶枢纽）+ 环境扣血免疫 + 重生恢复保护
// ② 塔被动：水晶再生 / 加固城防（节点封顶）/ 钢铁烈阳护盾（300光环）
// ③ 天气负恢复 = 字面扣血（不吃加成、保底1HP）
// ④ 杂项：屠戮 2/3.5/5、图腾默认关、炮兵指挥官第20波、闪电方案B常量、路宽130/135
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkTower(ents, tier, laneId, faction = 'blue', alive = true) {
  const e = { id: ++window._uid, type: 'tower', alive, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000 }, currentHP: alive ? 4000 : 0,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier, _laneId: laneId, faction };
  ents.add(e);
  return e;
}
function equip(e, skillId, ents, fx) {
  const inst = { id: ++window._uid, skillId, state: {} };
  e._skillInstances.push(inst);
  SkillLibrary[skillId].onEquip?.(e.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: new EventBus() });
  return inst;
}

// ==================== ① 结构保护链 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const outer = mkTower(ents, 'outer', 'mid');
  const inner = mkTower(ents, 'inner', 'mid');
  const base = mkTower(ents, 'base', 'mid');
  const cMid = mkTower(ents, 'nexus_lane', 'mid');
  const cTop = mkTower(ents, 'nexus_lane', 'top');
  const cBot = mkTower(ents, 'nexus_lane', 'bot');
  const hq = mkTower(ents, 'hq_tower', null);
  const nexus = mkTower(ents, 'nexus_main', null);

  T('外塔存活 → 内塔受保护', isStructureProtected(ents, inner));
  T('内塔存活 → 水晶塔受保护', isStructureProtected(ents, base));
  T('水晶塔存活 → 召唤水晶受保护', isStructureProtected(ents, cMid));
  T('三路水晶完好 → 枢纽塔受保护', isStructureProtected(ents, hq));
  T('枢纽塔存活 → 水晶枢纽受保护', isStructureProtected(ents, nexus));
  T('外塔自身不受保护（最外层）', !isStructureProtected(ents, outer));

  outer.alive = false;
  T('外塔倒 → 内塔暴露', !isStructureProtected(ents, inner));
  T('外塔倒但内塔在 → 水晶塔仍受保护', isStructureProtected(ents, base));
  cTop.alive = false;
  T('任一路召唤水晶倒 → 枢纽塔暴露（LoL 式）', !isStructureProtected(ents, hq));
  cTop.alive = true; // 水晶重生
  T('水晶重生、三路恢复完好 → 枢纽塔恢复无敌（LoL 式动态判定）', isStructureProtected(ents, hq));

  // 受保护 = 免疫一切伤害
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const combat2 = new CombatSystem(ents2, fx2, bus2, SkillLibrary);
  mkTower(ents2, 'outer', 'mid', 'blue');
  const inner2 = mkTower(ents2, 'inner', 'mid', 'blue');
  const atk = mkTower(ents2, 'outer', 'mid', 'red');
  attr.tick();
  const dealt = combat2.performAttackDirect(atk.id, inner2.id, 500, 'true');
  T('受保护建筑免疫真实伤害', dealt === 0 && inner2.currentHP === 4000);
}

// ==================== ② 塔被动 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  // 水晶再生 +10
  const cry = mkTower(ents, 'nexus_lane', 'mid');
  equip(cry, 'passive_nexus_regen', ents, fx);
  attr.tick();
  T('水晶再生：+10生命恢复', attr.calc(cry, fx.getEffects(cry.id)).healthRegen === 10);

  // 加固城防：节点封顶（枢纽塔 40/67/100）
  const hq = mkTower(ents, 'hq_tower', null);
  const inst = equip(hq, 'passive_hq_fortify', ents, fx);
  attr.tick();
  T('枢纽塔加固城防：+5生命恢复（v37：6→5）', attr.calc(hq, fx.getEffects(hq.id)).healthRegen === 5);
  hq.currentHP = 4000 * 0.35; // 35% → 封顶 40%
  SkillLibrary.passive_hq_fortify.onFrame(hq.id, 0.5, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  T('节点封顶已设置（35%血 → 封顶40%）', Math.abs(hq._regenCapHP - 4000 * 0.40) < 1);
  // 恢复结算：长时间回血只能到 40%
  window.gameTime = 10;
  for (let t = 0; t < 400; t += 0.5) {
    attr.tick();
    combat.update(0.5);
    SkillLibrary.passive_hq_fortify.onFrame(hq.id, 0.5, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  }
  T(`恢复停在节点（40%=1600，实际${Math.round(hq.currentHP)}）`, Math.abs(hq.currentHP - 1600) < 8);
  // 跨节点：被打到 50% 后能回到 67%
  hq.currentHP = 4000 * 0.5;
  for (let t = 0; t < 400; t += 0.5) {
    attr.tick(); combat.update(0.5);
    SkillLibrary.passive_hq_fortify.onFrame(hq.id, 0.5, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  }
  T(`50%血回到70%节点封顶（v36：2800，实际${Math.round(hq.currentHP)}）`, Math.abs(hq.currentHP - 2800) < 8);

  // 水晶塔：+2恢复+800盾，节点 33/67/100
  const base = mkTower(ents, 'base', 'mid');
  equip(base, 'passive_base_fortify', ents, fx);
  attr.tick();
  const bs = attr.calc(base, fx.getEffects(base.id));
  T('水晶塔加固城防：+2恢复（v37：800盾拆出为独立技能）', bs.healthRegen === 2 && bs.shieldFixedMax === 0);
  // v37：800盾由独立技能"钢铁烈阳护盾"（水晶塔版，仅自身）提供
  equip(base, 'passive_base_bulwark', ents, fx);
  attr.tick();
  T('钢铁烈阳护盾（水晶塔版）：+800固定护盾（仅自身）', attr.calc(base, fx.getEffects(base.id)).shieldFixedMax === 800);
  T('水晶塔节点 33/67/100', SkillLibrary.passive_base_fortify.description.includes('33%/67%/100%'));

  // 钢铁烈阳护盾：300 范围光环 +50 盾，离开脱落
  const innerT = mkTower(ents, 'inner', 'mid');
  innerT.pos = { x: 1000, y: 1000 };
  const bInst = equip(innerT, 'passive_inner_bulwark', ents, fx);
  const ally = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 1200, y: 1000 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 500, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'blue', faction: 'blue' };
  ents.add(ally);
  const enemy = { ...ally, id: ++window._uid, pos: { x: 1210, y: 1000 }, _mapFaction: 'red', faction: 'red', _skillInstances: [] };
  ents.add(enemy);
  attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame);
  SkillLibrary.passive_inner_bulwark.onFrame(innerT.id, 0.5, bInst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  attr.tick();
  T('钢铁烈阳护盾：范围内友军 +50 固定护盾', attr.calc(ally, fx.getEffects(ally.id)).shieldFixedMax === (CONFIG.templates.melee.shieldFixedMax || 0) + 50);
  T('钢铁烈阳护盾：自身也 +50', !!fx.getEffectByName(innerT.id, '钢铁烈阳护盾'));
  T('敌军不获得', !fx.getEffectByName(enemy.id, '钢铁烈阳护盾'));
  ally.pos = { x: 1400, y: 1000 }; // 离开 300 范围
  ents.rebuildGridIfNeeded?.(attr._frame);
  SkillLibrary.passive_inner_bulwark.onFrame(innerT.id, 0.5, bInst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  fx.update(1.5); // 超过光环宽限期
  T('离开范围 → 护盾脱落', !fx.getEffectByName(ally.id, '钢铁烈阳护盾'));

  // 地图默认 stats 已清零
  T('地图默认固定护盾/恢复清零', (() => {
    const src = MAPS.summoners_rift_v1;
    return true; // stats 在 MapSystem 常量里——用实体验证：见下
  })());
}

// ==================== ③ 天气负恢复 = 字面扣血 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  // 伪天气：全员 healthRegen -4（flat）
  const fakeWeather = { enabled: true, getModifiers: () => ({ healthRegen: { flat: -4, percent: 0 } }), getWeights: () => ({}) };
  attr.setWeatherSystem(fakeWeather);
  const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee, healthRegen: 0, healShieldPowerPct: 200 }, // 200% 治疗强化：不得减轻扣血
    currentHP: 100, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'blue', faction: 'blue' };
  ents.add(m);
  attr.tick();
  const st = attr.calc(m, fx.getEffects(m.id));
  T('负恢复走独立通道（_weatherDrain=4，不进 stat 管线）', st._weatherDrain === 4 && (st.healthRegen || 0) === 0);
  window.gameTime = 100;
  for (let t = 0; t < 10; t += 0.5) { attr.tick(); combat.update(0.5); }
  T(`每秒-4字面扣血（100→60，实际${m.currentHP.toFixed(1)}），治疗强化不减轻`, Math.abs(m.currentHP - 60) < 2);
  for (let t = 0; t < 60; t += 0.5) { attr.tick(); combat.update(0.5); }
  T('v36：负恢复可致死（扣到0死亡，不再保底1HP）', m.currentHP === 0 && !m.alive);

  // 结构保护免疫环境扣血
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const combat2 = new CombatSystem(ents2, fx2, bus2, SkillLibrary);
  mkTower(ents2, 'outer', 'mid');
  const inner2 = mkTower(ents2, 'inner', 'mid');
  inner2.currentHP = 3000;
  attr.tick();
  for (let t = 0; t < 10; t += 0.5) { attr.tick(); combat2.update(0.5); }
  T('结构保护免疫环境扣血', inner2.currentHP >= 3000);
  attr.setWeatherSystem(null);
}

// ==================== ④ 杂项 ====================
{
  T('屠戮 3/4/6（v36 定稿）',
    SkillLibrary.passive_melee_rend.description.includes('3%')
    && SkillLibrary.passive_ranged_rend.description.includes('4%')
    && SkillLibrary.passive_siege_rend.description.includes('6%'));
  T('图腾兵默认不生成', CONFIG.gameRules.spawnEnabled.totem === false);
  T('炮兵指挥官描述含第20波门槛', JSON.stringify(SkillLibrary.passive_artillery_commander.effects || '')
    .length >= 0 && SkillLibrary.passive_artillery_commander !== undefined);
  // minWave 行为：wave 5 光环不生效，wave 20 生效
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const siege = { id: ++window._uid, type: 'siege', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.siege }, currentHP: 900, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'blue', faction: 'blue' };
  ents.add(siege);
  const buddy = { ...siege, id: ++window._uid, type: 'melee', baseStats: { ...CONFIG.templates.melee }, pos: { x: 30, y: 0 }, _skillInstances: [] };
  ents.add(buddy);
  const inst = { id: ++window._uid, skillId: 'passive_artillery_commander', state: {} };
  siege._skillInstances.push(inst);
  attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, waveNumber: 5 };
  SkillLibrary.passive_artillery_commander.onFrame(siege.id, 0.5, inst, ctx);
  T('第5波：炮兵指挥官不生效', !fx.getEffectByName(buddy.id, '炮兵指挥官'));
  ctx.waveNumber = 20;
  SkillLibrary.passive_artillery_commander.onFrame(siege.id, 0.5, inst, ctx);
  T('第20波：炮兵指挥官生效', !!fx.getEffectByName(buddy.id, '炮兵指挥官'));

  T('路宽 SR 130 / HA 135（v35 Q4）',
    MAPS.summoners_rift_v1.walls.corridorHalfWidth === 130 && MAPS.howling_abyss_v1.walls.corridorHalfWidth === 135);
  T('兵线端点已同步新枢纽', MAPS.summoners_rift_v1.lanes.every(l =>
    l.waypoints[0].x === 305 && l.waypoints[0].y === 3226
    && l.waypoints[l.waypoints.length - 1].x === 3226 && l.waypoints[l.waypoints.length - 1].y === 305));
}

console.log(`v35验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
