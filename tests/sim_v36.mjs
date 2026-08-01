// sim_v36.mjs —— v36 验收：
// ① 穿透升温=配对倍率（不碰塔属性，切目标重置）
// ② 闪电杖阵营色/死亡残留机制
// ③ 结构保护盾牌标志统一（非isNexus也画）
// ④ 水晶被动装配bug修复 + 身份技能容器（groupedChildren）
// ⑤ 统一转向器_steer：不抽搐（连续力，无状态机分支跳变）
// ⑥ 地图收束段（baseOpenRadius）：射程圈穿墙 + 门槛线已删
// ⑦ 过载被动：两阶段、递增损失、致死、层级差异
// ⑧ 天气负恢复可致死；节点 33/67/100 + 40/70/100；屠戮3/4/6
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { towerPassives } = await import('../src/core/skills/towerPassives.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkTower(ents, tier, laneId, faction = 'blue', extra = {}) {
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000, attackDamage: 100, attackRange: 180, attackType: 'physical', baseAttackSpeed: 10, bulletSpeed: 0, ...extra },
    currentHP: 4000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier, _laneId: laneId, faction };
  ents.add(e);
  return e;
}
function equip(e, skillId, ents, fx, bus) {
  const inst = { id: ++window._uid, skillId, state: {} };
  e._skillInstances.push(inst);
  SkillLibrary[skillId].onEquip?.(e.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus || new EventBus() });
  return inst;
}

// ==================== ① 升温=配对倍率 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, 'outer', 'mid');
  equip(tw, 'weapon_piercing', ents, fx, bus);
  const t1 = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 20, y: 0 },
    baseStats: { ...CONFIG.templates.melee, maxHP: 1e7, armor: 0, magicResist: 0 }, currentHP: 1e7,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'red' };
  ents.add(t1);
  const dmgs = [];
  for (let i = 0; i < 4; i++) { attr.tick(); const b = t1.currentHP; combat.performAttack(tw, t1); dmgs.push(b - t1.currentHP); }
  const ratios = dmgs.map(d => d / dmgs[0]);
  // 期望值 = 升温倍率 × 削抗带来的伤害乘数变化。
  //
  // ⚠️ 原来这里只钉升温那一半（1.30/1.60/1.90），因为**削抗当时是无效的**：
  // calcEffectiveArmor 无条件 Math.max(0, …)，把负抗性一律夹成 0，
  // 于是"命中削目标 3 双抗【至 -12】"这条描述里的负数段从来没生效过
  //（穿透型子弹的技能说明白纸黑字写着"至-12"）。
  // 修好负抗性增伤之后，第 2/3/4 发的目标护甲是 -3/-6/-9，
  // 按 calcDamageMultiplier 的负值分支 2 − 100/(100−r) 各自额外增伤 2.9%/5.7%/8.3%。
  // 这一条现在同时钉住两个机制，任何一个失效都会红。
  const mult = (r) => (r >= 0 ? 100 / (100 + r) : 2 - 100 / (100 - r));
  const want = [0, 1, 2, 3].map(i => (1 + 0.3 * i) * mult(-3 * i) / mult(0));
  T(`升温×削抗 = ${want.map(v => v.toFixed(2)).join(',')}（实际 ${ratios.map(r => r.toFixed(2)).join(',')}）`,
    ratios.every((r, i) => Math.abs(r - want[i]) < 0.01));
  T('不写入塔属性 damageAmpPct（display纯计数）', attr.calc(tw, fx.getEffects(tw.id)).damageAmpPct === 0);
  const heat = fx.getEffectByName(tw.id, '升温');
  T('状态栏可见升温层数（4发命中后=4层封顶）', !!heat && heat.stacks === 4 && heat.blueprint.kind === 'display');
  const t2 = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 20, y: 0 },
    baseStats: { ...CONFIG.templates.melee, maxHP: 1e7, armor: 0, magicResist: 0 }, currentHP: 1e7,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'red' };
  ents.add(t2);
  attr.tick(); const b2 = t2.currentHP; combat.performAttack(tw, t2);
  T('切目标重置为100%', Math.abs((b2 - t2.currentHP) - dmgs[0]) < 1);
}

// ==================== ② 闪电杖：阵营色 + 死亡残留机制 ====================
{
  const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const proj = new ProjectileSystem(ents, bus);
  proj.fireBeam({ attackerId: 1, startX: 0, startY: 0, endX: 100, endY: 0, charge: 0.5, life: 0.3, color: '#5b9bd5' });
  T('光束携带阵营色', proj.getBeams()[0].color === '#5b9bd5');
  // 攻击停止后不再刷新：小步推进越过 ttl，光束进入淡出态（fadeT）而不是立即消失
  proj.update(1 / 30); proj.update(1 / 30); proj.update(1 / 30); // 3帧 = 0.1s，累计越过 0.3 ttl 还需再推
  for (let i = 0; i < 8 && proj.getBeams()[0] && proj.getBeams()[0].fadeT === undefined; i++) proj.update(1 / 30);
  const b = proj.getBeams()[0];
  T('目标脱离后进入淡出态（fadeT 存在，残留而非瞬灭）', b && b.fadeT !== undefined && b.fadeT > 0);
  for (let i = 0; i < 15; i++) proj.update(1 / 30); // 淡出走完
  T('淡出结束后光束移除', proj.getBeams().length === 0);
}

// ==================== ③ 盾牌标志统一 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  mkTower(ents, 'outer', 'mid');
  const inner = mkTower(ents, 'inner', 'mid');
  T('非nexus内塔在外塔存活时也受结构保护', isStructureProtected(ents, inner));
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/presentation/CanvasRenderer.js', import.meta.url), 'utf8');
  T('渲染源码：盾牌条件不再限定 isNexus', src.includes('if (isStructureProtected(this.entities, t)) {') && !src.includes('if (isNexus && isStructureProtected'));
}

// ==================== ④ 水晶被动bug修复 + 身份技能容器 ====================
{
  T('core_tier_outer 等身份技能声明 mergedSkills（v37：加固城防+成长合并显示）', Array.isArray(SkillLibrary.core_tier_outer?.mergedSkills) && SkillLibrary.core_tier_outer.mergedSkills.includes('passive_outer_fortify'));
  T('core_nexus_lane 保持独立水晶再生（无 mergedSkills）', !SkillLibrary.core_nexus_lane.mergedSkills);
  const fs = await import('fs');
  const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  T('main.js：nexus 装配bug已修（passive_nexus_regen 在 v36 分支装配）',
    mainSrc.includes("passive_nexus_regen'); // v36 Q4 修复"));
  T('main.js：身份技能按 tier 选择（identityByTier）', mainSrc.includes('identityByTier'));
}

// ==================== ⑤ 统一转向器：连续力，不抽搐 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapSys);
  T('_steer 方法存在（取代三态状态机）', typeof lms._steer === 'function');
  T('旧状态机方法已移除（_probeBlocked/_chooseSide/_navigate 不存在）',
    lms._probeBlocked === undefined && lms._chooseSide === undefined && lms._navigate === undefined);

  const lane = mapSys.getLane('mid');
  const mid = Math.floor(lane.waypoints.length / 2);
  const wp = lane.waypoints[mid];
  const a = lane.waypoints[mid - 1];
  const dx = wp.x - a.x, dy = wp.y - a.y, L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  function mkMinion(type, faction, x, y) {
    const tpl = CONFIG.templates[type];
    const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...tpl }, currentHP: tpl.maxHP,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
      _skillInstances: [], _mapFaction: faction, _laneId: 'mid', _laneDirection: 'forward', faction };
    ents.add(e);
    return e;
  }
  const tower = { id: ++window._uid, type: 'tower', alive: true, pos: { x: wp.x + ux * 90, y: wp.y + uy * 90 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 1e9, attackDamage: 0, attackRange: 180, attackType: 'physical', baseAttackSpeed: 0 },
    currentHP: 1e9, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
    _skillInstances: [], _mapFaction: 'red', _mapTier: 'outer', _laneId: 'mid', faction: 'red' };
  ents.add(tower);
  for (let i = -2; i <= 2; i++) mkMinion('ranged', 'red', wp.x + nx * i * 22, wp.y + ny * i * 22);
  const DT = 1 / 30;
  const step = () => { window.gameTime += DT; attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame); lms.update(DT); };
  for (let t = 0; t < 8; t += DT) step();

  const runner = mkMinion('melee', 'blue', wp.x - ux * 120, wp.y - uy * 120);
  // 抽搐的真正判据：每帧都在动（有位移）却【原地不前进】（净位移≈0）。
  // 新连续力模型下 runner 应稳定推进到接敌，而不是卡在墙前反复蹭。
  const fwd0 = (runner.pos.x - wp.x) * ux + (runner.pos.y - wp.y) * uy;
  let totalMove = 0, maxLatSwing = 0, minLat = Infinity, maxLat = -Infinity;
  for (let t = 0; t < 6; t += DT) {
    const before = { x: runner.pos.x, y: runner.pos.y };
    step();
    totalMove += Math.hypot(runner.pos.x - before.x, runner.pos.y - before.y);
    const lat = (runner.pos.x - wp.x) * nx + (runner.pos.y - wp.y) * ny;
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  const fwd1 = (runner.pos.x - wp.x) * ux + (runner.pos.y - wp.y) * uy;
  const netProgress = fwd1 - fwd0;
  maxLatSwing = maxLat - minLat;
  // 健康：有净前进（不卡墙原地蹭）且侧向不大幅来回甩（横跳）
  T(`不抽搐：稳定推进 ${netProgress.toFixed(0)}px（>15）而非原地蹭`, netProgress > 15);
  // v37：绕行力会产生较大的【单向】侧移（绕过障碍本来就要侧移），上限放宽；
  // 病态横甩由"净前进>15"断言兜底（原地往复甩必然没有净前进）。
  T(`侧向摆幅有界 ${maxLatSwing.toFixed(0)}px（<100）`, maxLatSwing < 100);
}

// ==================== ⑥ 地图收束段 ====================
{
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/presentation/CanvasRenderer.js', import.meta.url), 'utf8');
  T('高地门槛线渲染代码已删除', !src.includes('drawThreshold'));
  // 期望常量更新：HA 788 → 460（见 src/data/maps/howling_abyss.js 里的说明）。
// 基地圈（圆心+半径）是【走廊模型】专有的概念。嚎哭深渊/扭曲丛林已改成 navgrid
// 逐像素地形，压根没有基地圈 —— 这几条只对走廊模型的地图成立。
  T('SR 声明 baseOpenRadius（1185，六个墙角全落进射程）',
    MAPS.summoners_rift_v1.baseOpenRadius === 1185);
  T('嚎哭深渊/扭曲丛林已改 navgrid：不再声明基地圈',
    MAPS.howling_abyss_v1.useNavgrid && MAPS.howling_abyss_v1.baseOpenRadius === undefined
    && MAPS.twisted_treeline_v1.useNavgrid && MAPS.twisted_treeline_v1.baseOpenRadius === undefined);

  const bus = new EventBus(), ents = new EntityContainer(bus);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  const map = MAPS.summoners_rift_v1;
  const c = { x: 0, y: map.world.h };
  const tw = map.buildings.find(b => b.faction === 'blue' && b.tier === 'base' && b.laneId === 'top');
  const dist = Math.hypot(tw.pos.x - c.x, tw.pos.y - c.y);
  // v38 语义反转：塔必须【在开放高地内】（塔距角 < openRadius），墙口在塔外侧但仍被射程盖住。
  T('高地塔在开放高地内（塔距角 < openRadius < 塔距角+射程）',
    dist < map.baseOpenRadius && map.baseOpenRadius < dist + 180);
  const hw = map.walls.corridorHalfWidth;
  T(`射程180 > 走廊半宽${hw} → 几何必然穿墙`, 180 > hw);
  // navgrid 版语义（用户定稿）：进入高地的入口【只有三座高地塔那里】，其余外沿一律是墙。
  // 于是"塔四周皆可走"不再成立——塔正是把守窄口的那一座，两侧就该是墙。
  // 改为断言这个新语义：沿兵线方向（进出高地的方向）可走，垂直兵线的侧向被墙夹住。
  {
    const lane = mapSys.getLane('top');
    const n = mapSys._nearestOnLane(lane, tw.pos.x, tw.pos.y);
    // 兵线切向（用最近点两侧取差分）
    const n2 = mapSys._nearestOnLane(lane, tw.pos.x + 1, tw.pos.y + 1);
    let tx = n2.px - n.px, ty = n2.py - n.py;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    T('高地口沿兵线方向可走（这就是那三个入口）',
      mapSys.isWalkable(tw.pos.x + tx * 120, tw.pos.y + ty * 120));
    T('高地口侧向被墙夹住（入口只在三座高地塔处）',
      !mapSys.isWalkable(tw.pos.x - ty * 220, tw.pos.y + tx * 220)
      || !mapSys.isWalkable(tw.pos.x + ty * 220, tw.pos.y - tx * 220));
  }
  const dxr = tw.pos.x - c.x, dyr = tw.pos.y - c.y, dr = Math.hypot(dxr, dyr);
  T('更深处（开放区内）仍自由行走',
    mapSys.isWalkable(tw.pos.x - dxr / dr * 200, tw.pos.y - dyr / dr * 200));
  // 墙依然存在：走廊段（高地开口外侧）的侧向仍不可行走
  T('高地开口外的走廊侧向仍有墙（墙未消失）',
    !mapSys.isWalkable(tw.pos.x + dxr / dr * 260 + 200, tw.pos.y + dyr / dr * 260));
}

// ==================== ⑦ 过载被动 ====================
{
  T('过载在 towerPassives 中定义', 'passive_overload' in towerPassives);
  T('过载 SkillLibrary 引用一致', SkillLibrary.passive_overload === towerPassives.passive_overload);
  const def = SkillLibrary.passive_overload;
  T('四层级起始 外20/内30/水晶45/枢纽60',
    def._TIER_CFG.outer.startMin === 20 && def._TIER_CFG.inner.startMin === 30
    && def._TIER_CFG.base.startMin === 45 && def._TIER_CFG.hq_tower.startMin === 60);
  T('外侧塔损失系数更大',
    def._TIER_CFG.outer.resistBase > def._TIER_CFG.inner.resistBase
    && def._TIER_CFG.inner.resistBase > def._TIER_CFG.base.resistBase
    && def._TIER_CFG.base.resistBase > def._TIER_CFG.hq_tower.resistBase);

  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const tw = mkTower(ents, 'outer', 'mid');
  const inst = equip(tw, 'passive_overload', ents, fx, bus);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };

  window.gameTime = 100;
  def.onFrame(tw.id, 1, inst, ctx);
  T('未到时限不激活', !inst.state.phase1Started);

  window.gameTime = 20 * 60 + 5;
  def.onFrame(tw.id, 1, inst, ctx);
  T('20min第一阶段激活', inst.state.phase1Started);
  T('未到phase2不掉最大生命', !inst.state.phase2Started);
  const maxHPBefore = tw.baseStats.maxHP;

  window.gameTime = 20 * 60 + 40;
  def.onFrame(tw.id, 1, inst, ctx);
  const armorEff = fx.getEffectByName(tw.id, '过载');
  T('双抗开始损失（负值）', armorEff && armorEff.blueprint.flatValue < 0);
  T('状态栏只有一条【过载】且带30s倒计时进度条（v39：删除"过载中"独立条目）',
    !fx.getEffectByName(tw.id, '过载中') && (() => { const e = fx.getEffectByName(tw.id, '过载'); return !!e && e.blueprint.duration > 0 && e.blueprint.duration <= 30 && e.blueprint.description.includes('下次过载'); })());

  window.gameTime = 20 * 60 + 300 + 40;
  def.onFrame(tw.id, 1, inst, ctx);
  T('phase2激活并掉最大生命', inst.state.phase2Started && tw.baseStats.maxHP < maxHPBefore);

  const tw2 = mkTower(ents, 'outer', 'mid');
  const inst2 = equip(tw2, 'passive_overload', ents, fx, bus);
  let died = false;
  bus.on('entity:death', ({ entityId }) => { if (entityId === tw2.id) died = true; });
  window.gameTime = 20 * 60;
  for (let m = 0; m < 400; m++) {
    window.gameTime += 30;
    def.onFrame(tw2.id, 1, inst2, ctx);
    if (!tw2.alive) break;
  }
  T('长期过载可致死', died || !tw2.alive);
}

// ==================== ⑧ 数值 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const fakeWeather = { enabled: true, getModifiers: () => ({ healthRegen: { flat: -50, percent: 0 } }), getWeights: () => ({}) };
  attr.setWeatherSystem(fakeWeather);
  const m = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.melee, healthRegen: 0 }, currentHP: 100,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
    _skillInstances: [], _mapFaction: 'blue', faction: 'blue' };
  ents.add(m);
  window.gameTime = 500;
  for (let t = 0; t < 5; t += 0.5) { attr.tick(); combat.update(0.5); }
  T('负恢复可致死（100HP,-50/s扣到0死亡）', m.currentHP === 0 && !m.alive);
  attr.setWeatherSystem(null);

  T('屠戮 4/6/7（用户定稿）', SkillLibrary.passive_melee_rend.description.includes('4%')
    && SkillLibrary.passive_ranged_rend.description.includes('6%')
    && SkillLibrary.passive_siege_rend.description.includes('7%'));
  T('水晶塔节点 33/67/100%', SkillLibrary.passive_base_fortify.description.includes('33%/67%/100%'));
  T('枢纽塔节点 40/70/100%', SkillLibrary.passive_hq_fortify.description.includes('40%/70%/100%'));

  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const hq = mkTower(ents2, 'hq_tower', null);
  const inst = equip(hq, 'passive_hq_fortify', ents2, fx2, bus2);
  T('装备后立即有节点百分比（修显示0的bug）', typeof inst.state._capPct === 'number' && inst.state._capPct > 0);
}

console.log(`v36验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
