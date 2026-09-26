/**
 * sim_dominion.mjs —— 统治战场·水晶之痕（Dominion 复刻）验收
 *
 * 覆盖三件事：DominionSystem 自己的占领/出兵/掉血逻辑，CombatSystem 对据点的
 * 伤害转发（isCapturePoint 分支），以及新地图 dominion_crystal_scar_v1 的
 * 数据形状（通用几何校验已经在 sim_maps.mjs 的全地图循环里跑过，这里只钉
 * "据点数量/环形拓扑/出兵流为空"这类本图专属的东西）。
 *
 * 每条断言钉行为形状（signed capturePct 的粘性翻转、出兵方向、掉血速率与
 * 据点数差的关系），不钉 CONFIG.dominion 里的具体数字（那些是待
 * balance_matrix 校准的起草值，见 Config.js 头注）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity, srcOf } from './_harness.mjs';

setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('统治战场·水晶之痕验收');

const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');
const { DominionSystem } = await import('../src/systems/DominionSystem.js');
const { MAPS } = await import('../src/data/maps/index.js');

const DCFG = CONFIG.dominion;
const FULL = DCFG.captureFull;

// ==================== 一、地图数据形状 ====================
{
  const map = MAPS['dominion_crystal_scar_v1'];
  T('①-地图确实注册进了 MAPS', !!map);
  T('②-7 个节点：5 据点 + 2 基地', map.dominionNodes.length === 7
    && map.dominionNodes.filter(n => n.kind === 'point').length === 5
    && map.dominionNodes.filter(n => n.kind === 'base').length === 2);
  T('③-7 条环边（每个节点一条到"下一个"节点的边）', map.lanes.length === 7);
  T('④-每条边显式声明空出兵流（不借道 laneWaveSystem 的默认兜底）',
    map.lanes.every(l => Array.isArray(l.spawns) && l.spawns.length === 0));
  T('⑤-每个节点的 segForward/segReverse 都指向真实存在的 laneId',
    map.dominionNodes.every(n => map.lanes.some(l => l.id === n.segForward.laneId)
      && map.lanes.some(l => l.id === n.segReverse.laneId)));
  T('⑥-召唤水晶(nexus_lane)在基地节点的路径位置上，水晶枢纽(nexus_main)不在（用户定稿"水晶枢纽不在路径上"）',
    ['blue', 'red'].every(f => {
      const lane = map.buildings.find(b => b.tier === 'nexus_lane' && b.faction === f);
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const node = map.dominionNodes.find(n => n.kind === 'base' && n.pos.x === lane.pos.x && n.pos.y === lane.pos.y);
      const mainOnPath = map.dominionNodes.some(n => n.pos.x === main.pos.x && n.pos.y === main.pos.y);
      return !!node && !mainOnPath;
    }));
  T('⑦-画面走黄沙风格（visualStyle:stylized + paletteId:desert）',
    map.visualStyle === 'stylized' && map.paletteId === 'desert');
  T('⑧-CONFIG.stylizedPalettes.desert 确实存在且不长树（沙漠据点）',
    !!CONFIG.stylizedPalettes.desert && CONFIG.stylizedPalettes.desert.vegetationMode === 'none');

  // ⑨：不只是"不在节点坐标上"，真的落在 navgrid 不可走的格子里——
  // 这才是"不在路径上"字面意义上的验证（跟 MapSystem.isWalkable 同一套换算）。
  const { unpackBits } = await import('../src/data/navgrid.js');
  const bits = unpackBits(map.navgrid.bits, map.navgrid.n);
  const isWalk = (x, y) => {
    const i = Math.floor(x / map.world.w * map.navgrid.n), j = Math.floor(y / map.world.h * map.navgrid.n);
    return !!bits[j * map.navgrid.n + i];
  };
  T('⑨-水晶枢纽真的落在 navgrid 不可走的格子里（不是只挪了坐标数字）',
    ['blue', 'red'].every(f => {
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      return !isWalk(main.pos.x, main.pos.y);
    }));
  T('⑩-召唤水晶仍然落在可走的路径格子里', ['blue', 'red'].every(f => {
    const lane = map.buildings.find(b => b.tier === 'nexus_lane' && b.faction === f);
    return isWalk(lane.pos.x, lane.pos.y);
  }));
}

// ==================== 二、占领机制：有符号进度 + 粘性翻转 ====================
{
  const bus = { emit() {}, on() {} };
  const ents = { add() {}, getAllTowers: () => [] };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  T('①-声明了 dominionNodes 的地图会激活系统', ds.active === true);
  T('②-5 个据点各自建了一个 isCapturePoint 实体', ds.nodes.filter(n => n.kind === 'point').every(n => n.entity?.isCapturePoint === true));
  T('③-初始全部中立、进度 0', ds.nodes.filter(n => n.kind === 'point').every(n => n.captureOwner === FACTIONS.NEUTRAL && n.capturePct === 0));

  const node = ds.nodes.find(n => n.kind === 'point');
  const blueAttacker = { type: 'melee', _mapFaction: FACTIONS.BLUE };
  const redAttacker = { type: 'melee', _mapFaction: FACTIONS.RED };
  const power = DCFG.capturePower.melee;

  ds.applyCapturePressure(blueAttacker, node.entity);
  T('④-蓝方打一下，进度按 capturePower.melee 往蓝方（正）方向推', Math.abs(node.capturePct - power) < 1e-9);

  // 推到完全占领：直接调用足够多次
  while (node.captureOwner === FACTIONS.NEUTRAL) ds.applyCapturePressure(blueAttacker, node.entity);
  T('⑤-推满之后归属翻转为蓝方且进度钉在 captureFull', node.captureOwner === FACTIONS.BLUE && node.capturePct === FULL);
  T('⑥-被占领后据点获得正的攻击力/射程（tpl 的一部分，不再是 0）',
    node.entity.baseStats.attackDamage > 0 && node.entity.baseStats.attackRange > 0);

  const before = node.capturePct;
  ds.applyCapturePressure(blueAttacker, node.entity);
  T('⑦-己方（蓝）打不动自己已占领的点（canTarget 已经会挡，这里是兜底）', node.capturePct === before);

  // 敌方（红）持续推：进度应该单调下降，但在推到 0 之前归属全程仍是蓝方（粘性）
  ds.applyCapturePressure(redAttacker, node.entity);
  T('⑧-敌方攻击开始把进度往回推，但推到 0 之前归属仍然粘着蓝方',
    node.capturePct < before && node.captureOwner === FACTIONS.BLUE);

  while (node.captureOwner === FACTIONS.BLUE) ds.applyCapturePressure(redAttacker, node.entity);
  T('⑨-推到 0 之后变回中立（不是直接被红方占领）', node.captureOwner === FACTIONS.NEUTRAL && node.capturePct === 0);
  T('⑩-变回中立后攻击力/射程清零（中立不攻击任何单位）',
    node.entity.baseStats.attackDamage === 0 && node.entity.baseStats.attackRange === 0);
}

// ==================== 三、被占领的据点真的会开火（不是只有数值变了）====================
// CombatSystem.update 的塔攻击循环有一道跟 attackDamage 数值完全无关的前置闸门：
// "无武器：不攻击"（`_skillInstances` 里没有 category:'weapon' 的实例就直接
// targetId=null、continue）。据点是手搭的裸实体，天生没有这个实例——这是实现
// 过程中踩过的一个真坑（数值改对了、据点却仍然打不出去），这里补一套端到端验证：
// 真的接上 AISystem+CombatSystem 的完整攻击循环，看被占领的点是否真的对靠近的
// 敌方单位造成伤害，而不是只断言 baseStats 数值本身。
{
  const { ents, fx, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  combat.setDominionSystem(ds);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');

  T('①-占领前（中立）没有武器技能实例，塔攻击循环会直接跳过它',
    !(node.entity._skillInstances || []).some(s => s.skillId === 'weapon_piercing'));

  const attacker = { type: 'melee', _mapFaction: FACTIONS.BLUE };
  while (node.captureOwner === FACTIONS.NEUTRAL) ds.applyCapturePressure(attacker, node.entity);
  T('②-占领后自动装备了武器技能（不再是无武器空实例）',
    node.entity._skillInstances.some(s => s.skillId === 'weapon_piercing'));

  // 站一个敌方（红）单位到射程内，跑几秒真实的战斗循环，看它是否真的掉血
  const enemy = mkEntity(ents, 'ranged', {
    faction: FACTIONS.RED,
    pos: { x: node.entity.pos.x + 10, y: node.entity.pos.y },
    stats: { maxHP: 100000, armor: 0, magicResist: 0 },
  }, C);
  const hpBefore = enemy.currentHP;
  // 锁定前摇（CONFIG.tuning.lockOnWindup，默认0.3s）按 window.gameTime 的绝对时间戳判定，
  // 不推进它的话前摇窗口永远"还没过"——真实主循环里 CTX.gameTime 每帧自然前进，
  // 这里手动模拟同一件事，不能只调 combat.update(dt) 而漏了这一步。
  for (let i = 0; i < 200; i++) { window.gameTime += 0.1; combat.update(0.1); } // 20 秒足够打出至少一次攻击
  T('③-被占领的据点确实对射程内的敌方单位造成了伤害（不是只有一份摆设数值）',
    enemy.currentHP < hpBefore);

  // 退回中立后应该重新失去武器（不会打不掉的哑炮永久留在身上）
  const redAttacker = { type: 'melee', _mapFaction: FACTIONS.RED };
  while (node.captureOwner !== FACTIONS.NEUTRAL) ds.applyCapturePressure(redAttacker, node.entity);
  T('④-退回中立后武器技能被卸下', !node.entity._skillInstances.some(s => s.skillId === 'weapon_piercing'));
}

// ==================== 四、CombatSystem：命中据点转发到占领压力，不走 HP 结算 ====================
{
  const { ents, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  combat.setDominionSystem(ds);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const atk = mkEntity(ents, 'ranged', { faction: FACTIONS.BLUE, stats: { attackDamage: 999999 } }, C);

  const hpBefore = node.entity.currentHP;
  const pctBefore = node.capturePct;
  combat.performAttackDirect(atk.id, node.entity.id, 999999, 'physical', {});
  T('①-命中据点不扣 HP（据点没有 HP 概念）', node.entity.currentHP === hpBefore);
  T('②-命中据点确实推动了占领进度（转发到了 DominionSystem）', node.capturePct > pctBefore);

  // _resolveHit 路径（间接伤害如溅射/DOT 落地时走的那条）同样要转发，不走真伤/护盾结算
  const pctBefore2 = node.capturePct;
  combat._resolveHit({
    attackerId: atk.id, targetId: node.entity.id,
    baseDamage: 999999, onHitFixed: 0, onHitPctBase: 0, dmgAmp: 0, preDamageMult: 1,
    attackType: 'physical', isCrit: false, critMult: 200,
    armorPenPercent: 0, armorPenFlat: 0, magicPenPercent: 0, magicPenFlat: 0,
    weaponId: null, weaponInstId: null,
  });
  T('③-_resolveHit 路径同样转发（不是只有 performAttackDirect 那一条）', node.capturePct > pctBefore2);
  T('④-两条路径都没有让据点掉血', node.entity.currentHP === hpBefore);
}

// ==================== 五、动态出兵：出到相邻两个方向，双方基地按固定节奏出增援 ====================
{
  const bus = { emit() {}, on() {} };
  const ents = { add() {}, getAllTowers: () => [] };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);

  const spawned = [];
  ds.setCreateMinion((type, x, y, faction, laneId, direction) => spawned.push({ type, faction, laneId, direction }));

  const node = ds.nodes.find(n => n.kind === 'point');
  const attacker = { type: 'melee', _mapFaction: FACTIONS.BLUE };
  while (node.captureOwner === FACTIONS.NEUTRAL) ds.applyCapturePressure(attacker, node.entity);

  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  const fromThisNode = spawned.filter(s => [node.segForward.laneId, node.segReverse.laneId].includes(s.laneId));
  T('①-占领后按 waveInterval 节奏出兵', fromThisNode.length > 0);
  T('②-出的兵都是占领方的阵营', fromThisNode.every(s => s.faction === FACTIONS.BLUE));
  const dirsUsed = new Set(fromThisNode.map(s => s.laneId + '|' + s.direction));
  T('③-朝相邻两个方向都出（不是只出一个方向）',
    dirsUsed.has(node.segForward.laneId + '|' + node.segForward.direction)
    && dirsUsed.has(node.segReverse.laneId + '|' + node.segReverse.direction));

  // 中立据点不出兵
  const neutralNode = ds.nodes.find(n => n.kind === 'point' && n.captureOwner === FACTIONS.NEUTRAL);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  const fromNeutral = spawned.filter(s => [neutralNode.segForward.laneId, neutralNode.segReverse.laneId].includes(s.laneId));
  T('④-中立据点不出兵', fromNeutral.length === 0);

  // 基地额外波：每 bonusWaveEvery 波出一次，与占领状态无关
  spawned.length = 0;
  const bonusEvery = Math.max(1, DCFG.bonusWaveEvery);
  for (let i = 0; i < bonusEvery - 1; i++) ds.update(DCFG.waveInterval + 0.01);
  const baseNodeIds = ds.nodes.filter(n => n.kind === 'base').map(n => n.id);
  const beforeBonusWave = spawned.filter(s => baseNodeIds.some(id => {
    const n = ds.nodes.find(x => x.id === id);
    return [n.segForward.laneId, n.segReverse.laneId].includes(s.laneId);
  }));
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // 这一波是第 bonusEvery 波
  const onBonusWave = spawned.filter(s => baseNodeIds.some(id => {
    const n = ds.nodes.find(x => x.id === id);
    return [n.segForward.laneId, n.segReverse.laneId].includes(s.laneId);
  }));
  T('⑤-第 bonusWaveEvery 波，双方基地各出一次额外兵', onBonusWave.length > 0);
}

// ==================== 六、水晶掉血：己方占点数 > 对方时，对方水晶按据点数差持续掉血 ====================
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);

  const blueNexus = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 100000 } }, C);
  const redNexus = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_main', stats: { maxHP: 100000 } }, C);

  // 手动把 1 个据点判给蓝方、0 个给红方（不经过 applyCapturePressure，直接摆状态测掉血逻辑）
  const points = ds.nodes.filter(n => n.kind === 'point');
  points[0].captureOwner = FACTIONS.BLUE; points[0].capturePct = FULL;

  const redHpBefore = redNexus.currentHP, blueHpBefore = blueNexus.currentHP;
  ds.update(1);
  T('①-占点数落后的一方（红）水晶掉血', redNexus.currentHP < redHpBefore);
  T('②-占点数领先的一方（蓝）水晶不掉血', blueNexus.currentHP === blueHpBefore);

  // 掉血量应该正比于据点数差（1 个 vs 2 个，掉血速率翻倍）
  const dropAt1 = redHpBefore - redNexus.currentHP;
  points[1].captureOwner = FACTIONS.BLUE; points[1].capturePct = FULL;
  const redHpBefore2 = redNexus.currentHP;
  ds.update(1);
  const dropAt2 = redHpBefore2 - redNexus.currentHP;
  T('③-据点数差翻倍，掉血速率也翻倍', Math.abs(dropAt2 - 2 * dropAt1) < 1e-6);

  // 掉到 0 应该正确触发死亡 + entity:death（死亡检查是 DominionSystem 自己复刻的一份，
  // 见 _tickNexusDrain 头注——这里验证它确实发了事件，不是只改了字段）
  let deathEvent = null;
  bus.emit = (evt, payload) => { if (evt === 'entity:death') deathEvent = payload; };
  redNexus.currentHP = 0.001;
  ds.update(1000); // 足够大的 dt，一次性打到 0 以下
  T('④-水晶被掉血打到 0 后 alive=false（与 CombatSystem 的死亡判据逐位一致）', redNexus.alive === false && redNexus.currentHP === 0);
  T('⑤-正确发出 entity:death 事件（下游 MapSystem 的水晶损毁处理靠它触发）',
    deathEvent && deathEvent.entityId === redNexus.id);
}

// ==================== 七、reset：切图后不带上一局状态 ====================
{
  const bus = { emit() {}, on() {} };
  const ents = { add() {}, getAllTowers: () => [] };
  const ds = new DominionSystem(ents, bus);
  ds.initMap(MAPS['dominion_crystal_scar_v1']);
  T('①-激活后 nodes 非空', ds.nodes.length > 0);
  ds.reset();
  T('②-reset 之后 active=false 且 nodes 清空', ds.active === false && ds.nodes.length === 0);
  // 普通地图（无 dominionNodes）不应该激活
  ds.initMap(MAPS['summoners_rift_v1']);
  T('③-普通地图不激活这套机制（active 仍为 false）', ds.active === false);
}

// ==================== 八、main.js / CombatSystem.js 源码接线核对 ====================
{
  const combatSrc = srcOf('src/systems/CombatSystem.js');
  T('①-CombatSystem 有 setDominionSystem 注入口', /setDominionSystem\(dominionSystem\)/.test(combatSrc));
  T('②-_resolveHit 里有 isCapturePoint 早退分支', /if \(target\.isCapturePoint\) \{ this\.dominionSystem\?\.applyCapturePressure/.test(combatSrc));

  const mainSrc = srcOf('src/main.js');
  T('③-main.js 造了 DominionSystem 并接到 combatSystem', /new DominionSystem\(/.test(mainSrc) && /combatSystem\.setDominionSystem\(dominionSystem\)/.test(mainSrc));
  T('④-main.js 主循环里调用了 dominionSystem.update(dt)', /dominionSystem\.update\(dt\)/.test(mainSrc));
  T('⑤-map:loading 里 reset、map:loaded 里 initMap（跟 DragonSystem 同一套时序）',
    /dominionSystem\.reset\(\)/.test(mainSrc) && /dominionSystem\.initMap\(mapSystem\.currentMap\)/.test(mainSrc));
  T('⑥-dominionSystem 也注入了 createMinion（复用 main.js 的兵种工厂）',
    /dominionSystem\.setCreateMinion\(/.test(mainSrc));
}

done();
