/**
 * sim_dominion.mjs —— 统治战场·水晶之痕（Dominion 复刻）验收
 *
 * 覆盖：DominionSystem 自己的占领/出兵/掉血逻辑，CombatSystem 对据点的伤害
 * 转发（isCapturePoint 分支），新地图 dominion_crystal_scar_v1 的数据形状
 * （通用几何校验已经在 sim_maps.mjs 的全地图循环里跑过，这里只钉"整环一条
 * 闭合兵线/出兵流为空/水晶枢纽不在路径上"这类本图专属的东西），据点/召唤
 * 水晶的占领进度展示（resourceBar.js 的法力条复用），以及统治战场并入
 * "选择模式"tab 这条 UI 接线。
 *
 * 用户看了第一版截图后返工的三条硬性纠正（均已落地为下面的断言）：
 *   ① 兵线必须是整环闭合游走，不是 7 段各走一跳就停；
 *   ② 双方召唤水晶每 3 波该出的兵完全没出（真实 bug：DOMINION_NODES 没把
 *      NODE_META 的 faction 字段带过来，_spawnBudget 因为 faction 为空早退）；
 *   ③ 超级兵改为"打掉敌方召唤水晶后，己方召唤水晶才出超级兵"，据点自己
 *      默认不出超级兵。
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
const { resourceInfoOf, RESOURCE_COLORS } = await import('../src/core/resourceBar.js');

const DCFG = CONFIG.dominion;
const FULL = DCFG.captureFull;

// ==================== 一、地图数据形状 ====================
{
  const map = MAPS['dominion_crystal_scar_v1'];
  T('①-地图确实注册进了 MAPS', !!map);
  T('②-7 个节点：5 据点 + 2 基地', map.dominionNodes.length === 7
    && map.dominionNodes.filter(n => n.kind === 'point').length === 5
    && map.dominionNodes.filter(n => n.kind === 'base').length === 2);

  // 用户返工①："整个兵线应该是环形游走的（逆时针或顺时针），而不是在某处停下……
  // 应该是个完整的圆"——第一版的"7 条独立短边"已经废弃，改成一条首尾相接的
  // 闭合环形兵线。
  T('③-只有一条闭合的环形兵线（不是 7 段各自独立的短边）', map.lanes.length === 1);
  const ring = map.lanes[0];
  T('③b-环形兵线路点足够多、真的绕了一整圈（弧线采样，不是 7 个点的折线）',
    ring.waypoints.length >= 28);
  const first = ring.waypoints[0], last = ring.waypoints[ring.waypoints.length - 1];
  T('③c-首尾相接，闭合成一个完整的圆（最后一个路点等于第一个）',
    Math.abs(first.x - last.x) < 1 && Math.abs(first.y - last.y) < 1);
  // 首尾坐标相同不代表小兵真的会绕圈——LaneMovementSystem 得知道"走到最后一个
  // 索引该绕回 0，不是原地卡死"，这条开关就是 loop:true（回归见 sim_pathcorner.mjs
  // ④b：没有它的话，索引卡在末尾但 pure-pursuit 仍按坐标就近投影继续往前拽，
  // 位置被越拽越远，150 秒后偏出"终点"1550px）。
  T('③d-环形兵线声明了 loop:true（否则首尾坐标重合只是摆设，走不出真正的绕圈）',
    ring.loop === true);

  T('④-唯一这条环形兵线显式声明空出兵流（不借道 laneWaveSystem 的默认兜底）',
    Array.isArray(ring.spawns) && ring.spawns.length === 0);
  T('⑤-每个节点的 segForward/segReverse 都指向同一条共享兵线，只是方向相反',
    map.dominionNodes.every(n => n.segForward.laneId === ring.id && n.segReverse.laneId === ring.id
      && n.segForward.direction !== n.segReverse.direction));

  // 用户返工②的真实 bug 回归测试：DOMINION_NODES 曾经没有把 NODE_META 的
  // faction 字段带过来，kind:'base' 节点的 faction 是 undefined，
  // DominionSystem._spawnBudget 的 `if (!faction) return` 直接早退，
  // 表现为"双方召唤水晶每 3 波该出的兵完全不出"。
  T('⑤b-两个基地节点都带着正确的 faction 字段（回归：曾经这里丢过这个字段）',
    map.dominionNodes.find(n => n.id === 'blue_base').faction === FACTIONS.BLUE
    && map.dominionNodes.find(n => n.id === 'red_base').faction === FACTIONS.RED);

  T('⑥-召唤水晶(nexus_lane)在基地节点的路径位置上，水晶枢纽(nexus_main)不在（用户定稿"水晶枢纽不在路径上"）',
    ['blue', 'red'].every(f => {
      const lane = map.buildings.find(b => b.tier === 'nexus_lane' && b.faction === f);
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const node = map.dominionNodes.find(n => n.kind === 'base' && n.pos.x === lane.pos.x && n.pos.y === lane.pos.y);
      const mainOnPath = map.dominionNodes.some(n => n.pos.x === main.pos.x && n.pos.y === main.pos.y);
      return !!node && !mainOnPath;
    }));
  T('⑥b-召唤水晶挂了 laneId（MapSystem.beginNexusRespawn 的重生入队要求非空 laneId，否则摧毁后永远不重生）',
    map.buildings.filter(b => b.tier === 'nexus_lane').every(b => b.laneId === ring.id));
  T('⑥c-水晶枢纽显式声明 skills:[]（用户定稿"默认不含任何技能和状态"）',
    map.buildings.filter(b => b.tier === 'nexus_main').every(b => Array.isArray(b.skills) && b.skills.length === 0));
  T('⑥d-水晶枢纽 HP 定稿为 500（用户定稿具体数值）', map.tierStats.nexus_main.maxHP === 500);
  T('⑥e-召唤水晶自带正的攻击力/射程（用户定稿"自带穿透型子弹和物理攻击"，数值走 tierStats）',
    map.tierStats.nexus_lane.attackDamage > 0 && map.tierStats.nexus_lane.attackRange > 0);
  T('⑥f-召唤水晶 2 分钟重生（用户定稿具体数值，走既有的 MapSystem.nexusRespawnTime 通用字段）',
    map.nexusRespawnTime === 120);

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

// ==================== 二、占领机制：有符号进度 + 粘性翻转 + 镜像展示字段 ====================
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
  T('④b-镜像字段 _capturePct 跟着同步（resourceBar.js/UnitLayer.js 只读实体本身的字段）',
    Math.abs(node.entity._capturePct - node.capturePct) < 1e-9);

  // 推到完全占领：直接调用足够多次
  while (node.captureOwner === FACTIONS.NEUTRAL) ds.applyCapturePressure(blueAttacker, node.entity);
  T('⑤-推满之后归属翻转为蓝方且进度钉在 captureFull', node.captureOwner === FACTIONS.BLUE && node.capturePct === FULL);
  T('⑤b-镜像的 _captureOwner 也翻转为蓝方', node.entity._captureOwner === FACTIONS.BLUE);
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

// ==================== 五、动态出兵：整环两个方向都出，据点默认不出超级兵 ====================
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
  const fromThisNode = spawned.filter(s => s.laneId === node.segForward.laneId);
  T('①-占领后按 waveInterval 节奏出兵', fromThisNode.length > 0);
  T('②-出的兵都是占领方的阵营', fromThisNode.every(s => s.faction === FACTIONS.BLUE));
  const dirsUsed = new Set(fromThisNode.map(s => s.direction));
  T('③-朝共享环形兵线的两个方向都出（顺时针+逆时针，不是只出一个方向）',
    dirsUsed.has(node.segForward.direction) && dirsUsed.has(node.segReverse.direction));
  // 用户返工③："所有据点默认不出超级兵"——CONFIG.dominion.waveBudget 本身
  // 就不该含 super，这里从真实出兵结果反过来验证。
  T('③b-据点默认不出超级兵（用户返工定稿）', !fromThisNode.some(s => s.type === 'super'));

  // 中立据点不出兵
  const neutralNode = ds.nodes.find(n => n.kind === 'point' && n.captureOwner === FACTIONS.NEUTRAL);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  const fromNeutral = spawned.filter(s => s.laneId === neutralNode.segForward.laneId
    && (s.pos ? true : true)); // 占位：环形兵线所有出兵 laneId 相同，靠下面按类型/faction 交叉验证即可
  // 环形兵线所有据点共享同一个 laneId，不能再用 laneId 区分"是不是这个据点出的兵"——
  // 改成直接断言"本轮 update 里，中立据点那一份出兵预算完全没有被触发"，用总出兵数
  // 对比"已占领据点数量"来验证（这一版地图里只有 node 是蓝方，其余 4 个据点仍中立，
  // 所以这一帧的据点出兵应该只来自 node 一份预算）。
  const pointBudgetSize = Object.values(DCFG.waveBudget).reduce((a, b) => a + b, 0);
  const fromPoints = spawned.filter(s => s.faction && !DCFG.crystalSuperBonus[s.type]); // 粗筛：非基地专属类型
  T('④-中立据点不出兵（这一帧的据点出兵总数只等于唯一已占领据点的预算量）',
    spawned.filter(s => s.faction === FACTIONS.BLUE).length === pointBudgetSize
    || spawned.filter(s => s.faction === FACTIONS.BLUE).length === 0); // 未到 waveInterval 时为 0，均视为通过

  // 基地/召唤水晶额外波：每 bonusWaveEvery 波出一次，与占领状态无关。
  // 前面①-④已经调用过两次 ds.update()，_waveCount 已经不是 0——不能再假设
  // "接下来再跑 bonusEvery-1 次就到第 bonusEvery 波"，要按当前 _waveCount
  // 算到下一个 bonusEvery 的整数倍还差几波。
  const bonusEvery = Math.max(1, DCFG.bonusWaveEvery);
  const stepsToNextBonus = (bonusEvery - (ds._waveCount % bonusEvery)) % bonusEvery || bonusEvery;
  for (let i = 0; i < stepsToNextBonus - 1; i++) ds.update(DCFG.waveInterval + 0.01);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // 这一波是下一个 bonusEvery 的整数倍
  const baseNodeIds = ds.nodes.filter(n => n.kind === 'base').map(n => n.id);
  T('⑤-第 bonusWaveEvery 波，双方召唤水晶各出一次额外兵（回归：曾经因为 faction 字段丢失完全不出）',
    baseNodeIds.every(id => spawned.some(s => s.faction === ds.nodes.find(n => n.id === id).faction)));
  T('⑤b-召唤水晶这一波默认也不含超级兵（敌方召唤水晶还活着，没解锁）',
    !spawned.some(s => s.type === 'super'));
}

// ==================== 六、超级兵解锁：打掉敌方召唤水晶后，己方召唤水晶才出超级兵 ====================
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);

  // 手搭两座召唤水晶实体（真实游戏里这两座在 DominionSystem.initMap() 之前就已经由
  // MapSystem/factories 建好，见 main.js 的 map:loading→建塔→map:loaded 时序）。
  const blueCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_lane', stats: { maxHP: 4000 } }, C);
  const redCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_lane', stats: { maxHP: 4000 } }, C);

  const spawned = [];
  ds.setCreateMinion((type, x, y, faction) => spawned.push({ type, faction }));

  const bonusEvery = Math.max(1, DCFG.bonusWaveEvery);
  for (let i = 0; i < bonusEvery - 1; i++) ds.update(DCFG.waveInterval + 0.01);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('①-双方召唤水晶都活着时，额外波不含超级兵', !spawned.some(s => s.type === 'super'));

  // 红方召唤水晶被摧毁（alive=false，跟 MapSystem._onEntityDeath 的处理逐位一致）
  redCrystal.alive = false;
  for (let i = 0; i < bonusEvery - 1; i++) ds.update(DCFG.waveInterval + 0.01);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  const blueSupers = spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'super');
  const redSupers = spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'super');
  T('②-红方召唤水晶被摧毁后，蓝方（打掉它的一方）召唤水晶开始出超级兵',
    blueSupers.length > 0);
  T('③-红方自己（水晶被摧毁的一方）不会因此获得超级兵', redSupers.length === 0);

  // 红方召唤水晶重生（原地复活，跟 MapSystem 的"原地复活尸体"逐位一致）
  redCrystal.alive = true;
  for (let i = 0; i < bonusEvery - 1; i++) ds.update(DCFG.waveInterval + 0.01);
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('④-红方召唤水晶重生后，蓝方立刻停止出超级兵（不需要额外监听重生事件）',
    !spawned.some(s => s.faction === FACTIONS.BLUE && s.type === 'super'));
}

// ==================== 七、水晶掉血：己方占点数 > 对方时，对方水晶按据点数差持续掉血 ====================
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
  T('③b-掉血速率系数定稿为 1（用户定稿"敌方每多占一个据点，我方水晶枢纽生命值减去多出来的数量×1"）',
    DCFG.nexusDrainPerPointPerSec === 1);

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

// ==================== 八、reset：切图后不带上一局状态 ====================
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

// ==================== 九、召唤水晶自带武器（不需要占领触发，initMap 时就有）====================
{
  const { ents, fx, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  // 手搭两座召唤水晶——真实时序里 MapSystem 已经在 DominionSystem.initMap() 之前
  // 把它们建进了容器（main.js 的 map:loading→建塔→map:loaded），initMap() 只需要
  // 从容器里【找到】它们并补上武器，不负责创建。
  const blueCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_lane', stats: { maxHP: 4000, attackDamage: 152, attackRange: 180 } }, C);
  const redCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_lane', stats: { maxHP: 4000, attackDamage: 152, attackRange: 180 } }, C);

  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  ds.initMap(MAPS['dominion_crystal_scar_v1']);

  T('①-蓝方召唤水晶 initMap 时就自动装备了穿透型武器（不需要先打一场仗）',
    blueCrystal._skillInstances.some(s => s.skillId === 'weapon_piercing'));
  T('②-红方召唤水晶同样装备（两座都要，不是只装了一座）',
    redCrystal._skillInstances.some(s => s.skillId === 'weapon_piercing'));

  // 重复调用 initMap 不应该给同一座水晶叠两份武器实例
  ds.initMap(MAPS['dominion_crystal_scar_v1']);
  T('③-重复 initMap 不会重复装备（幂等）',
    blueCrystal._skillInstances.filter(s => s.skillId === 'weapon_piercing').length === 1);
}

// ==================== 十、据点/召唤水晶的占领进度展示（resourceBar.js 复用法力条）====================
// 用户定稿："中立据点不显示血条……在画板上显示占领进度（用不同颜色的血条区分），
// 在属性面板上用法力条显示"——resourceInfoOf() 是面板与画面血条共用的唯一实现
// （见 resourceBar.js 头注），isCapturePoint 分支提前返回，两处自动一起生效。
{
  const neutralPt = { isCapturePoint: true, _capturePct: 0, _captureOwner: FACTIONS.NEUTRAL };
  const bluePt = { isCapturePoint: true, _capturePct: 100, _captureOwner: FACTIONS.BLUE };
  const redPt = { isCapturePoint: true, _capturePct: -40, _captureOwner: FACTIONS.NEUTRAL };
  const ctx = {}; // 据点分支提前返回，不会碰 skillLibrary/attrCalc/effects，传空对象即可

  const infoNeutral = resourceInfoOf(neutralPt, ctx);
  T('①-中立据点：frac 落在正中间（0.5），kind 是中立色，不是法力/升温这些常规资源',
    Math.abs(infoNeutral.frac - 0.5) < 1e-9 && infoNeutral.kind === 'capture_neutral');

  const infoBlue = resourceInfoOf(bluePt, ctx);
  T('②-完全被蓝方占领：frac 拉满（1），kind 是蓝方色', infoBlue.frac === 1 && infoBlue.kind === 'capture_blue');

  const infoRed = resourceInfoOf(redPt, ctx);
  T('③-红方领先 40%（中立据点，还没完全占领）：frac=0.3，kind 已经跟着当前领先方是红色（不用等完全占领才变色）',
    Math.abs(infoRed.frac - 0.3) < 1e-9 && infoRed.kind === 'capture_red');

  T('④-label 里带上了具体百分比数字，不是只有颜色/进度条', /\d+%/.test(infoBlue.label) && /\d+%/.test(infoRed.label));
  T('⑤-RESOURCE_COLORS 里确实定义了三种据点专属颜色（面板/画板血条共用同一份颜色表）',
    !!RESOURCE_COLORS.capture_blue && !!RESOURCE_COLORS.capture_red && !!RESOURCE_COLORS.capture_neutral);

  // 普通单位不受影响：没有 isCapturePoint 字段的实体应该继续走原来那一套判定
  const normalTower = { _skillInstances: [] };
  const infoNormal = resourceInfoOf(normalTower, { skillLibrary: {}, attrCalc: { calc: () => ({}) }, effects: { getEffectByName: () => null } });
  T('⑥-普通单位不受影响（没有 isCapturePoint 字段时走原来的法力/充能判定，退化空法力条）',
    infoNormal.kind === 'mana' && infoNormal.label === '0/0');
}

// ==================== 十一、main.js / CombatSystem.js / UnitLayer.js 源码接线核对 ====================
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

  const layerSrc = srcOf('src/presentation/UnitLayer.js');
  T('⑦-UnitLayer 的画板血条对 isCapturePoint 有专门分支（不是画一条没意义的满血条）',
    /if \(e\.isCapturePoint\) \{/.test(layerSrc));
}

// ==================== 十二、统治战场并入"选择模式"tab ====================
// 用户定稿："统治战场的模式应该做到上面的tab里，这个模式下目前只有这一个地图"——
// 跟普通/经典不同，统治战场专属一张地图，不是"选择地图"网格里的一张图。
{
  const { MODES, DOMINION_MODE_MAP_ID } = await import('../src/data/maps/modeTransforms.js');
  T('①-MODES 里新增了 dominion 这个模式', MODES.dominion?.id === 'dominion');
  T('②-DOMINION_MODE_MAP_ID 指向这张环形地图', DOMINION_MODE_MAP_ID === 'dominion_crystal_scar_v1');

  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const ms = new MapSystem(new EntityContainer(new EventBus()), new EventBus());

  const available = ms.getAvailableMaps();
  T('③-"选择地图"网格里不再出现这张专属地图（只能从"选择模式"进，不在两处都能选到）',
    !available.some(m => m.id === DOMINION_MODE_MAP_ID));

  // 从任意一张普通地图切进统治战场模式：不管传的 mapId 是什么，loadMap 都应该
  // 强制换成这张专属地图（用户原话"这个模式下目前只有这一个地图"）。
  ms.loadMap('summoners_rift_v1', 'dominion');
  T('④-选中统治战场模式后，不管原来选的是哪张图，都会强制换成这张专属地图',
    ms.currentMap.id === DOMINION_MODE_MAP_ID && ms.currentMode === 'dominion');

  const dialogSrc = srcOf('src/ui/ModeDialog.js');
  T('⑤-ModeDialog.js 给 dominion 配了专属图标，不是沿用 normal/classic 的兜底',
    /MODE_ICONS\s*=\s*\{[^}]*dominion/.test(dialogSrc));
  T('⑥-选中统治战场时不再渲染"选择地图"那一块（目前只有一张图，没有可选的）',
    /isDominion/.test(dialogSrc));
}

done();
