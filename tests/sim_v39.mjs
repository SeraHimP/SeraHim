// sim_v39.mjs —— v39 验收：
// Q1 基地光环圈半径 = 高地地形半径 | Q2 超级兵不再绕着目标转圈
// Q3 寻路四件套（互卡/排队走中线/沿墙滑/转向平滑）+ 过载改造
// Q4 节奏：钢铁防线 33%/300s + 攻城车新兵种 | Q5 镀层内塔→水晶塔
// Q6 设置界面（速度/快进/时间）| Q7 负生命恢复扣血 | Q8 闪电杖切目标清残留
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG, MINION_SIZES, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);
const DT = 1 / 30;

function mkUnit(ents, type, faction, x, y, over = {}) {
  const t = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y },
    baseStats: { ...t, ...over }, currentHP: over.maxHP ?? t.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, faction,
    _laneId: 'mid', _laneDirection: 'forward' };
  ents.add(e);
  return e;
}
function mkTower(ents, faction, x, y, tier = 'outer', over = {}) {
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x, y },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000, armor: 40, magicResist: 40, ...over },
    currentHP: over.maxHP ?? 4000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier,
    _laneId: 'mid', faction };
  ents.add(e);
  return e;
}
function battle() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapSys);
  return { bus, ents, fx, combat, mapSys, lms };
}

// ==================== Q1 基地光环圈 = 高地地形半径 ====================
{
  // 期望常量更新：howling_abyss 788 → 460。788 > 召唤水晶到角点的 701，
  // 意味着抑制器被基地广场吞在里面，ARAM「抑制器在桥上」的形态从来没成立过。
// 基地圈（圆心+半径）是【走廊模型】专有的概念。嚎哭深渊/扭曲丛林已改成 navgrid
// 逐像素地形，压根没有基地圈 —— 这几条只对走廊模型的地图成立。
  for (const [mid, r] of [['summoners_rift_v1', 1185]]) {
    const map = MAPS[mid];
    T(`${mid} 光环圈=地形半径=${r}`, map.baseCircleRadius === r && map.baseOpenRadius === r);
  }
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap('summoners_rift_v1');
  T('MapSystem 两个取值口径一致（视觉圈与可行走边界同一半径）',
    ms.getBaseCircleRadius('blue') === ms.getBaseOpenRadius('blue')
    && ms.getBaseCircleRadius('red') === ms.getBaseOpenRadius('red'));
}

// ==================== Q2 超级兵不再绕着目标转圈 ====================
{
  const W = battle();
  const lane = W.mapSys.getLane('mid');
  const i = Math.floor(lane.waypoints.length / 2);
  const wp = lane.waypoints[i], a = lane.waypoints[i - 1];
  const L = Math.hypot(wp.x - a.x, wp.y - a.y);
  const ux = (wp.x - a.x) / L, uy = (wp.y - a.y) / L;
  // 敌方小兵先站定（锚定成"静态障碍"），超级兵从后方冲上来打它
  const foe = mkUnit(W.ents, 'melee', 'red', wp.x, wp.y, { moveSpeed: 0, maxHP: 1e9 });
  foe.currentHP = 1e9;
  const foe2 = mkUnit(W.ents, 'melee', 'red', wp.x + ux * 26, wp.y + uy * 26, { moveSpeed: 0, maxHP: 1e9 });
  foe2.currentHP = 1e9;
  const sup = mkUnit(W.ents, 'super', 'blue', wp.x - ux * 120, wp.y - uy * 120, { maxHP: 1e9 });
  sup.currentHP = 1e9;
  const step = () => { window.gameTime += DT; attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame); W.lms.update(DT); };
  for (let t = 0; t < 3; t += DT) step();
  T('超级兵接敌后锚定（不再绕圈）', sup._anchored === true && (sup.targetId === foe.id || sup.targetId === foe2.id));
  // 锚定后位置应基本不动（转圈的表现是持续位移）
  const p0 = { x: sup.pos.x, y: sup.pos.y };
  for (let t = 0; t < 3; t += DT) step();
  const drift = Math.hypot(sup.pos.x - p0.x, sup.pos.y - p0.y);
  T(`锚定后不再持续位移（3秒漂移 ${drift.toFixed(0)}px < 25）`, drift < 25);
  // 源码级：当前目标被排除在障碍集合外
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/systems/LaneMovementSystem.js', import.meta.url), 'utf8');
  T('源码：当前攻击目标不进障碍集合', src.includes('if (o.id === minion.targetId) continue;'));
}

// ==================== Q3 寻路四件套 ====================
{
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/systems/LaneMovementSystem.js', import.meta.url), 'utf8');
  T('互卡死锁：确定性让位力存在', src.includes('yieldX') && src.includes('minion.id > o.id'));
  T('排队：向走廊中心线回归力存在', src.includes('_nearestOnLane') && src.includes('走廊中心线'));
  T('转向低通平滑（消抽搐）存在', src.includes('_steerDir') && src.includes('maxTurn'));
  const msrc = fs.readFileSync(new URL('../src/systems/MapSystem.js', import.meta.url), 'utf8');
  T('沿墙滑行：constrainToWalkable 返回墙面法向', msrc.includes('nx: -ux, ny: -uy'));
  T('_steer 里用法向剔除撞墙分量', src.includes('hit.nx') && src.includes('剔除'));

  // 行为测试的摆位约定（v39 调试教训）：纯行军单位必须摆在【路段中间】，
  // 不能正好摆在路点上——摆在路点上时"目标路点=脚下这个点"，方向退化为零向量，
  // 单位原地不动，会被误读成寻路 bug（实测 A 推进 0px；改摆中点后 392px）。
  const segMid = (mapSys, laneId) => {
    const lane = mapSys.getLane(laneId);
    let si = 0, sl = 0;
    for (let i = 0; i < lane.waypoints.length - 1; i++) {
      const P = lane.waypoints[i], Q = lane.waypoints[i + 1];
      const l = Math.hypot(Q.x - P.x, Q.y - P.y);
      if (l > sl) { sl = l; si = i; }
    }
    const P = lane.waypoints[si], Q = lane.waypoints[si + 1];
    const L = Math.hypot(Q.x - P.x, Q.y - P.y);
    return { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2, ux: (Q.x - P.x) / L, uy: (Q.y - P.y) / L };
  };

  // 行为：两兵一前一后紧贴行军，后车不被永久卡死
  const W = battle();
  const M = segMid(W.mapSys, 'mid');
  const A = mkUnit(W.ents, 'melee', 'blue', M.x, M.y);
  const B = mkUnit(W.ents, 'melee', 'blue', M.x - M.ux * 18, M.y - M.uy * 18); // 紧贴 A 正后方
  const f0 = (B.pos.x - M.x) * M.ux + (B.pos.y - M.y) * M.uy;
  for (let t = 0; t < 5; t += DT) { window.gameTime += DT; attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame); W.lms.update(DT); }
  const f1 = (B.pos.x - M.x) * M.ux + (B.pos.y - M.y) * M.uy;
  T(`互卡自解：后车 5 秒推进 ${(f1 - f0).toFixed(0)}px（>200，未被前车卡死）`, f1 - f0 > 200);

  // 沿墙滑行：贴着墙行军，应沿墙推进而不是原地磨
  const W2 = battle();
  const M2 = segMid(W2.mapSys, 'mid');
  const nx2 = -M2.uy, ny2 = M2.ux;
  const hw = MAPS.summoners_rift_v1.walls.corridorHalfWidth;
  const hugger = mkUnit(W2.ents, 'melee', 'blue', M2.x + nx2 * (hw - 4), M2.y + ny2 * (hw - 4));
  const s0 = (hugger.pos.x - M2.x) * M2.ux + (hugger.pos.y - M2.y) * M2.uy;
  for (let t = 0; t < 4; t += DT) { window.gameTime += DT; attr.tick(); W2.ents.rebuildGridIfNeeded?.(attr._frame); W2.lms.update(DT); }
  const s1 = (hugger.pos.x - M2.x) * M2.ux + (hugger.pos.y - M2.y) * M2.uy;
  T(`贴墙兵沿墙推进 ${(s1 - s0).toFixed(0)}px（>150，不再原地磨墙）`, s1 - s0 > 150);
  T('贴墙兵仍在可行走区内', W2.mapSys.isWalkable(hugger.pos.x, hugger.pos.y));
}

// ==================== Q3b 过载改造 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const def = SkillLibrary.passive_overload;
  T('层级双抗基数 外3/内2.5/水晶2/枢纽1.5',
    def._TIER_CFG.outer.resistBase === 3.0 && def._TIER_CFG.inner.resistBase === 2.5
    && def._TIER_CFG.base.resistBase === 2.0 && def._TIER_CFG.hq_tower.resistBase === 1.5);

  const tw = mkTower(ents, 'blue', 0, 0, 'outer');
  const inst = { id: ++window._uid, skillId: 'passive_overload', state: {} };
  tw._skillInstances.push(inst);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  def.onEquip(tw.id, inst, ctx);
  window.gameTime = 20 * 60 + 70;
  def.onFrame(tw.id, 1, inst, ctx);
  const names = [...new Set(fx.getEffects(tw.id).map(e => e.blueprint.name))];
  T('状态栏只有一条【过载】（无"过载中"）', names.length === 1 && names[0] === '过载');
  const armorEff = fx.getEffects(tw.id).find(e => e.blueprint.statKey === 'armor');
  T('进度条=30s倒计时', armorEff.blueprint.duration > 0 && armorEff.blueprint.duration <= 30);
  T('说明集中到这一条（含"下次过载"与每跳数值）',
    armorEff.blueprint.description.includes('下次过载') && armorEff.blueprint.description.includes('每30秒 -3'));
  const lost1 = inst.state.armorLost;
  window.gameTime = 20 * 60 + 190;
  def.onFrame(tw.id, 1, inst, ctx);
  const per = (inst.state.armorLost - lost1) / 4; // 又跳了4次
  T(`双抗损失固定不递增（每跳 ${per.toFixed(2)} = 基数3.0）`, Math.abs(per - 3.0) < 0.01);
  const maxHP0 = tw.baseStats.maxHP;
  window.gameTime = 20 * 60 + 400;
  def.onFrame(tw.id, 1, inst, ctx);
  T('生命损失仍为【扣最大生命上限】且递增（保持现状）',
    inst.state.phase2Started && tw.baseStats.maxHP < maxHP0 && inst.state.hpTicks > 0);
}

// ==================== Q4 节奏：钢铁防线 + 攻城车 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const tw = mkTower(ents, 'blue', 0, 0, 'outer');
  const inst = { id: ++window._uid, skillId: 'passive_iron_line', state: {} };
  tw._skillInstances.push(inst);
  SkillLibrary.passive_iron_line.onEquip(tw.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  const eff = fx.getEffectByName(tw.id, '钢铁防线');
  T('钢铁防线 33% / 300s', eff.blueprint.flatValue === 33 && Math.abs(eff.remainingTime - 300) < 1);

  // 攻城车模板
  const ram = CONFIG.templates.ram;
  T('攻城车模板：HP800 / AD60 / AS0.25 / 射程312 / 双抗0 / 溅射60（v40 调整）',
    ram.maxHP === 800 && ram.attackDamage === 60 && ram.baseAttackSpeed === 0.25
    && ram.attackRange === 312 && ram.armor === 0 && ram.magicResist === 0 && ram.splashRadius === 60);
  T('攻城车射程 > 防御塔射程（可越塔输出）', ram.attackRange > CONFIG.templates.tower.attackRange);
  T('近战阈值 60：命中近战/超级兵/蚀骨兵，排除炮车/远程/术士/图腾/塔/攻城车',
    CONFIG.templates.melee.attackRange <= MELEE_RANGE_THRESHOLD
    && CONFIG.templates.super.attackRange <= MELEE_RANGE_THRESHOLD
    && CONFIG.templates.corrupt.attackRange <= MELEE_RANGE_THRESHOLD
    && CONFIG.templates.siege.attackRange > MELEE_RANGE_THRESHOLD
    && CONFIG.templates.ranged.attackRange > MELEE_RANGE_THRESHOLD
    && CONFIG.templates.warlock.attackRange > MELEE_RANGE_THRESHOLD
    && CONFIG.templates.totem.attackRange > MELEE_RANGE_THRESHOLD
    && CONFIG.templates.tower.attackRange > MELEE_RANGE_THRESHOLD
    && ram.attackRange > MELEE_RANGE_THRESHOLD);
  // 用户定稿改动："让所有兵种都会默认生成" —— 攻城车从默认关改为默认开
  // （它没有 GLB 模型，会回退到程序化几何；能玩，只是不好看）。
  T('攻城车有体积，且默认生成（用户定稿）',
    MINION_SIZES.ram === 14 && CONFIG.gameRules.spawnEnabled.ram === true);
  T('攻城武器被动已定义', !!SkillLibrary.passive_siege_weapon);

  // 伤害四规则（精确数值）
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const combat = new CombatSystem(ents2, fx2, bus2, SkillLibrary);
  // v40：机制以【是否装备攻城武器被动】为闸门。先验证"没装被动 = 普通车"。
  const Rplain = mkUnit(ents2, 'ram', 'blue', 0, 0);
  const T0 = mkTower(ents2, 'red', 100, 0, 'outer');
  attr.tick();
  let h0 = T0.currentHP; combat.performAttack(Rplain, T0);
  T(`未装被动 = 普通单位（打塔 ${Math.round(h0 - T0.currentHP)} ≈ 60×100/140 = 43，无 +270%）`,
    Math.abs((h0 - T0.currentHP) - 43) < 3);

  // 装上被动后各规则生效
  const R = mkUnit(ents2, 'ram', 'blue', 0, 0);
  R._skillInstances.push({ id: ++window._uid, skillId: 'passive_siege_weapon', state: {} });
  const T1 = mkTower(ents2, 'red', 100, 0, 'outer');
  attr.tick();
  h0 = T1.currentHP; combat.performAttack(R, T1);
  const dmgTower = h0 - T1.currentHP;
  T(`① 打建筑 +270%（${Math.round(dmgTower)} ≈ 60×3.7×100/140 = 159）`, Math.abs(dmgTower - 159) < 3);
  const mn = mkUnit(ents2, 'melee', 'red', 30, 0);
  attr.tick(); h0 = mn.currentHP; combat.performAttack(R, mn);
  const dmgMinion = h0 - mn.currentHP;
  T(`② 打小兵 -33%（${Math.round(dmgMinion)} ≈ 60×0.67×100/115 = 35）`, Math.abs(dmgMinion - 35) < 3);
  const mel = mkUnit(ents2, 'melee', 'red', 20, 0);
  attr.tick(); h0 = R.currentHP; combat.performAttack(mel, R);
  T(`③ 近战单位打它 +100%（${Math.round(h0 - R.currentHP)} = 9×2 = 18）`, Math.abs((h0 - R.currentHP) - 18) < 1);
  const rng = mkUnit(ents2, 'ranged', 'red', 40, 0);
  attr.tick(); h0 = R.currentHP; combat.performAttack(rng, R);
  T(`③b 远程单位无加成（${Math.round(h0 - R.currentHP)} ≈ 6.5）`, Math.abs((h0 - R.currentHP) - 6.5) < 1.5);

  // 出兵波次 + 队尾
  const bus3 = new EventBus(), ents3 = new EntityContainer(bus3);
  const ms3 = new MapSystem(ents3, bus3); ms3.setCreateBuildingFn(() => null); ms3.loadMap('summoners_rift_v1');
  const lws = new LaneWaveSystem(ents3, bus3, ms3);
  const spawned = [];
  lws.setCreateMinion((type, x, y, f, laneId, dir) => {
    spawned.push({ w: lws.waveNumber, type, laneId, f });
    return mkUnit(ents3, type, f, x, y);
  });
  // 攻城车默认关闭（暂无模型）——此处显式开启以验证【出兵节奏机制】本身不变。
  const _ramWas = CONFIG.gameRules.spawnEnabled.ram;
  CONFIG.gameRules.spawnEnabled.ram = true;
  for (let t = 0; t < 52 * 30; t += DT) lws.update(DT);
  CONFIG.gameRules.spawnEnabled.ram = _ramWas;
  const ramWaves = [...new Set(spawned.filter(s => s.type === 'ram').map(s => s.w))];
  // 波次【从编排里读】，不抄数字 —— 用户这轮把特殊兵种的起始波整体前移了。
  const _ramRule = CONFIG.gameRules.laneWaveComposition.find(r => r.type === 'ram');
  const expectWaves = [];
  for (let w = _ramRule.fromWave; w <= 52; w += _ramRule.everyN) expectWaves.push(w);
  T(`出生波次 ${expectWaves.join('/')}（实际 ${ramWaves.join(',')}）`,
    ramWaves.join(',') === expectWaves.join(','));
  const wF = _ramRule.fromWave;
  const w5 = spawned.filter(s => s.w === wF && s.laneId === 'mid' && s.f === 'blue').map(s => s.type);
  T(`出生在兵线最后方（第${wF}波：${w5.join('→')}）`, w5[w5.length - 1] === 'ram');
  T('每波每路每方各 1 辆', spawned.filter(s => s.w === wF && s.type === 'ram').length === 6);

  // 成长：HP 正常、AD 极慢、双抗恒 0
  const mainSrc = (await import('fs')).readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // Q2：成长表已从 main.js 的 BATTLE_GROWTH_FLAT 常量搬进 CONFIG.battleGrowth（软编码，
// 模板编辑器可改、地图可按兵种覆写）。断言改为读【真值】而不是 main.js 的源码文本。
T('成长表：ram = HP10/波、AD0.1/波、双抗0',
  CONFIG.battleGrowth.ram.hp === 10 && CONFIG.battleGrowth.ram.ad === 0.1 && CONFIG.battleGrowth.ram.res === 0);
}

// ==================== Q5 镀层：内塔 → 水晶塔 ====================
{
  const mainSrc = (await import('fs')).readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const innerLine = mainSrc.split('\n').find(l => l.includes("tier === 'inner'") && l.includes('towerDefaults.push'));
  const baseLine = mainSrc.split('\n').find(l => l.includes("tier === 'base'") && l.includes('towerDefaults.push'));
  T('内塔不再默认装镀层', !innerLine.includes('passive_armor_plating'));
  T('水晶塔默认装镀层', baseLine.includes('passive_armor_plating'));
}

// ==================== Q6 设置界面 ====================
{
  const src = (await import('fs')).readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url), 'utf8');
  T('设置：游戏进行时间', src.includes('游戏进行时间') && src.includes('_fmtTime'));
  T('设置：速度 0.5/1/2x', src.includes('[0.5, 1, 2]') && src.includes('data-speed'));
  T('设置：快进 30s/300s', src.includes('data-ff="30"') && src.includes('data-ff="300"'));
  T('设置：波次概览（当前波次/下一波倒计时）', src.includes('当前波次') && src.includes('nextWaveTime'));
  const mainSrc = (await import('fs')).readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // 同上：速度倍率读的是 CTX.__gameSpeed（会同步到 window），断言认 CTX 写法。
  T('主循环：速度倍率只放大投喂时间（SIM_DT 不变，判定一致）',
    /CTX\.__gameSpeed/.test(mainSrc) && mainSrc.includes('realDt * speed'));
  T('快进=加速模拟真实跑完（非跳时钟）',
    mainSrc.includes('__ffRemain') && mainSrc.includes('FF_BUDGET'));
}

// ==================== Q7 负生命恢复扣血 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const m = mkUnit(ents, 'melee', 'blue', 0, 0, { healthRegen: -20, maxHP: 100 });
  m.currentHP = 100;
  let died = false;
  bus.on('entity:death', ({ entityId }) => { if (entityId === m.id) died = true; });
  for (let t = 0; t < 3; t += 0.5) { attr.tick(); combat.update(0.5); }
  T(`手动设负恢复会掉血（100 → ${Math.round(m.currentHP)}）`, m.currentHP < 60);
  for (let t = 0; t < 5; t += 0.5) { attr.tick(); combat.update(0.5); }
  T('负恢复可致死', died || !m.alive);
}

// ==================== Q8 闪电杖切目标清残留 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const proj = new ProjectileSystem(ents, bus);
  T('ProjectileSystem 提供 clearBeam', typeof proj.clearBeam === 'function');
  proj.fireBeam({ attackerId: 7, startX: 0, startY: 0, endX: 100, endY: 0, charge: 1, life: 0.3 });
  T('光束已建立', proj.getBeams().length === 1);
  proj.clearBeam(7);
  T('clearBeam 后立即消失（无淡出残留）', proj.getBeams().length === 0);
  const wsrc = (await import('fs')).readFileSync(new URL('../src/core/skills/weapons.js', import.meta.url), 'utf8');
  T('闪电杖切目标时调用 clearBeam', wsrc.includes('beamTargetId !== target.id') && wsrc.includes('clearBeam'));
  // 目标死亡的残留淡出仍保留
  proj.fireBeam({ attackerId: 8, startX: 0, startY: 0, endX: 50, endY: 0, charge: 1, life: 0.3 });
  for (let i = 0; i < 10 && proj.getBeams()[0] && proj.getBeams()[0].fadeT === undefined; i++) proj.update(DT);
  T('停火（目标死亡）仍走淡出残留', !!proj.getBeams()[0] && proj.getBeams()[0].fadeT > 0);
}

console.log(`v39验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
