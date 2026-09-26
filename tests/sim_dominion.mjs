/**
 * sim_dominion.mjs —— 统治战场·水晶之痕（Dominion 复刻）验收
 *
 * 覆盖：DominionSystem 自己的占领/争夺/脱战恢复/出兵/掉血逻辑，CombatSystem
 * 对据点的伤害转发（isCapturePoint 分支），新地图 dominion_crystal_scar_v1
 * 的数据形状，据点/召唤水晶的占领进度展示（resourceBar.js 的法力条复用），
 * 以及统治战场并入"选择模式"tab 这条 UI 接线。
 *
 * 2026-09-26 第二轮返工（用户实机截图后报的 4 条问题）：
 *   Q1-占领条：无符号 0~100（不再是"以50%为中点"的双向量表）；
 *   Q1-争夺机制：双方同时在场则据点不可被选中，逼迫交战；脱战后向"静息值"
 *      （中立=0，已占领=±100）缓慢恢复；
 *   Q1-出兵编排：据点每方向 2 近战 2 远程、每两波每方向 +1 炮兵；召唤水晶每波
 *      3 远程 3 近战 1 炮兵，敌方水晶被摧毁则每波额外 1 超级兵；
 *   Q2-数值：据点攻击力大幅减弱/攻速略微提升/占领速度提高，召唤水晶攻击力
 *      大幅提升；
 *   Q3-出兵编排统一：据点出兵改走标准 compositionFor（跟模板编辑器同一份数据，
 *      不再是编辑器改了没用的独立配置）；
 *   Q4-模式弹窗：统治战场下"选择地图"块显示这张图的真名（水晶之痕），不是
 *      彻底隐藏。
 *
 * 每条断言钉行为形状，不钉 CONFIG.dominion 里的具体数字（那些是待
 * balance_matrix 校准的起草值，见 Config.js 头注）——除非断言本身就是在验证
 * "某个具体数字确实被用户定稿改成了这个值"（比如 nexusDrainPerPointPerSec）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity, srcOf, srcRaw } from './_harness.mjs';

setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('统治战场·水晶之痕验收');

const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');
const { DominionSystem } = await import('../src/systems/DominionSystem.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { resourceInfoOf, RESOURCE_COLORS } = await import('../src/core/resourceBar.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { buildWaveOrder } = await import('../src/data/waveComposition.js');

const DCFG = CONFIG.dominion;
const FULL = DCFG.captureFull;

// ==================== 一、地图数据形状 ====================
// 2026-09-26 第五轮：用户定稿"这个地图没有召唤水晶，把原有的召唤水晶改为
// 普通的据点。然后打通水晶枢纽和环的通道……水晶枢纽继承召唤水晶的攻击"——
// 原来的 2 个 kind:'base' 节点（固定归属、专门放召唤水晶）撤编，改成跟其余
// 5 个一样的 kind:'point'（7 个据点全部可占领）；水晶枢纽(nexus_main)不再
// "完全不在任何路径上"，而是通过新走廊接入 navgrid，自己也带上了原来召唤
// 水晶(nexus_lane)的攻击数值；出兵锚点从"基地节点"变成 dominionNodes 里新增
// 的 kind:'nexus' 节点（挂在水晶枢纽自己的位置上）。
{
  const map = MAPS['dominion_crystal_scar_v1'];
  T('①-地图确实注册进了 MAPS', !!map);
  T('②-9 个节点：7 据点（全部可占领，没有固定归属的"基地"了）+ 2 水晶枢纽出兵锚点',
    map.dominionNodes.length === 9
    && map.dominionNodes.filter(n => n.kind === 'point').length === 7
    && map.dominionNodes.filter(n => n.kind === 'nexus').length === 2
    && map.dominionNodes.filter(n => n.kind === 'base').length === 0);

  T('③-只有一条闭合的环形兵线（不是 7 段各自独立的短边）', map.lanes.length === 1);
  const ring = map.lanes[0];
  T('③b-环形兵线路点足够多、真的绕了一整圈（弧线采样，不是 7 个点的折线）',
    ring.waypoints.length >= 28);
  const first = ring.waypoints[0], last = ring.waypoints[ring.waypoints.length - 1];
  T('③c-首尾相接，闭合成一个完整的圆（最后一个路点等于第一个）',
    Math.abs(first.x - last.x) < 1 && Math.abs(first.y - last.y) < 1);
  T('③d-环形兵线声明了 loop:true（否则首尾坐标重合只是摆设，走不出真正的绕圈）',
    ring.loop === true);

  T('④-唯一这条环形兵线显式声明空出兵流（不借道 laneWaveSystem 的默认兜底）',
    Array.isArray(ring.spawns) && ring.spawns.length === 0);
  T('⑤-每个据点/水晶枢纽锚点的 segForward/segReverse 都指向同一条共享兵线，只是方向相反',
    map.dominionNodes.every(n => n.segForward.laneId === ring.id && n.segReverse.laneId === ring.id
      && n.segForward.direction !== n.segReverse.direction));

  T('⑤b-两个水晶枢纽出兵锚点都带着正确的 faction 字段',
    map.dominionNodes.find(n => n.id === 'blue_nexus').faction === FACTIONS.BLUE
    && map.dominionNodes.find(n => n.id === 'red_nexus').faction === FACTIONS.RED);
  T('⑤c-据点节点(kind:point)不带 faction 字段（不再有"天生归属谁"这种概念，归属完全由占领决定）',
    map.dominionNodes.filter(n => n.kind === 'point').every(n => n.faction === undefined));

  T('⑥-水晶枢纽(nexus_main)不落在据点上（挪进环内侧），但确实存在两座（蓝/红各一）',
    ['blue', 'red'].every(f => {
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const onPoint = map.dominionNodes.some(n => n.kind === 'point' && n.pos.x === main.pos.x && n.pos.y === main.pos.y);
      return !!main && !onPoint;
    }));
  T('⑥b-地图上再也没有召唤水晶(nexus_lane)这个层级了（buildings 里没有，tierStats 里也没有）',
    !map.buildings.some(b => b.tier === 'nexus_lane') && !map.tierStats.nexus_lane);
  T('⑥c-水晶枢纽显式声明 skills:[]（用户定稿"默认不含任何技能和状态"）',
    map.buildings.filter(b => b.tier === 'nexus_main').every(b => Array.isArray(b.skills) && b.skills.length === 0));
  T('⑥d-水晶枢纽 HP 定稿为 750（用户追加定稿"为了增加对局时长，由500增加到750"）',
    map.tierStats.nexus_main.maxHP === 750);
  T('⑥e-水晶枢纽继承了原召唤水晶的攻击力/攻速（用户定稿"水晶枢纽继承召唤水晶的攻击"，数值原样照抄第四轮定的 700/1.4）',
    map.tierStats.nexus_main.attackDamage === 700 && map.tierStats.nexus_main.baseAttackSpeed === 1.4);
  T('⑥f-水晶枢纽射程是正数且明显小于世界尺寸（用户定稿"攻击范围是从环到水晶枢纽的距离"，不是沿用召唤水晶原来的射程）',
    map.tierStats.nexus_main.attackRange > 0 && map.tierStats.nexus_main.attackRange < 500);

  T('⑦-画面走黄沙风格（visualStyle:stylized + paletteId:desert）',
    map.visualStyle === 'stylized' && map.paletteId === 'desert');
  T('⑧-CONFIG.stylizedPalettes.desert 确实存在且不长树（沙漠据点）',
    !!CONFIG.stylizedPalettes.desert && CONFIG.stylizedPalettes.desert.vegetationMode === 'none');

  const { unpackBits } = await import('../src/data/navgrid.js');
  const bits = unpackBits(map.navgrid.bits, map.navgrid.n);
  const isWalk = (x, y) => {
    const i = Math.floor(x / map.world.w * map.navgrid.n), j = Math.floor(y / map.world.h * map.navgrid.n);
    return !!bits[j * map.navgrid.n + i];
  };
  T('⑨-水晶枢纽自己那块空地现在是可走的（第五轮打通之前这里是故意留白的不可走格，现在反过来必须可走，否则小兵永远走不出来）',
    ['blue', 'red'].every(f => {
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      return isWalk(main.pos.x, main.pos.y);
    }));
  T('⑨b-水晶枢纽到环上同角度那个位置之间的走廊也是可走的（真的打通了整条连接路，不是两端各自留了一块空地、中间没接上）',
    ['blue', 'red'].every(f => {
      const main = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const mouth = map.dominionNodes.find(n => n.id === (f + '_base')).pos;
      const midX = (main.pos.x + mouth.x) / 2, midY = (main.pos.y + mouth.y) / 2;
      return isWalk(midX, midY);
    }));

  // 2026-09-26：Q3 返工——据点出兵改走标准出兵编排系统，这张图物理上只有一条
  // 兵线（ring），装不下"顺/逆时针各自编排"两份数据，靠这个字段给编辑器一个
  // 额外的"按几路分"提示（见 laneLabels.js mapLaneIds() 的头注）。
  T('⑩-地图声明了 waveEditorLaneIds:[ring_fwd,ring_rev]（用户定稿"分为4条线路：红蓝方×顺逆时针"）',
    JSON.stringify(map.waveEditorLaneIds) === JSON.stringify(['ring_fwd', 'ring_rev']));
}

// ==================== 二、占领机制：有符号进度 + 粘性翻转 + 镜像展示字段 ====================
// 2026-09-26 第三轮：占领和攻击彻底解耦（用户定稿"小兵占领和攻击的实现是完全
// 不同的……小兵占领据点时应该是固定每秒一次"）——旧的 applyCapturePressure()
// 已删除，现在靠"把 minion 加进真实 EntityContainer + targetId 指向据点 +
// 推进 ds.update(dt)"来模拟"站在据点旁边占领"，DominionSystem._tickCapture()
// 自己按 captureTickSec 的固定节奏扫描谁在场、推进占领压力，见该方法头注。
{
  const { ents, fx, attr, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  T('①-声明了 dominionNodes 的地图会激活系统', ds.active === true);
  T('②-5 个据点各自建了一个 isCapturePoint 实体', ds.nodes.filter(n => n.kind === 'point').every(n => n.entity?.isCapturePoint === true));
  T('③-初始全部中立、进度 0', ds.nodes.filter(n => n.kind === 'point').every(n => n.captureOwner === FACTIONS.NEUTRAL && n.capturePct === 0));

  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;
  const blueAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.BLUE }, C);
  const redAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);
  const power = DCFG.capturePower.melee;
  const tick = (dt = tickSec) => { window.gameTime = (window.gameTime || 0) + dt; ds.update(dt); };
  // 2026-09-26 用户追加返工："攻占后据点属性提升……都要在状态栏显示"——占领
  // 后的攻击力增量不再直接写进 baseStats.attackDamage（那样状态栏看不出来），
  // 改走 EffectRegistry 的一条可见效果，真实生效的总值要用 attr.calc 现算，
  // 不能只读 baseStats（baseStats 现在永远停在中立基线上，见 _setOwner 头注）。
  const neutralDamage = attr.calc(node.entity, fx.getEffects(node.entity.id)).attackDamage;

  window.gameTime = 0;
  blueAttacker.targetId = node.entity.id;
  tick();
  T('④-蓝方在场满一个 tick，进度按 capturePower.melee 往蓝方（正）方向推', Math.abs(node.capturePct - power) < 1e-9);
  T('④b-镜像字段 _capturePct 跟着同步（resourceBar.js/UnitLayer.js 只读实体本身的字段）',
    Math.abs(node.entity._capturePct - node.capturePct) < 1e-9);

  // 推到完全占领：直接反复推进足够多个 tick（同一方持续在场，不涉及争夺判定——
  // 争夺判定专门测试见第十一节，这里只测原有的推进/粘性行为）。
  while (node.captureOwner === FACTIONS.NEUTRAL) tick();
  T('⑤-推满之后归属翻转为蓝方且进度钉在 captureFull', node.captureOwner === FACTIONS.BLUE && node.capturePct === FULL);
  T('⑤b-镜像的 _captureOwner 也翻转为蓝方', node.entity._captureOwner === FACTIONS.BLUE);
  const capturedDamage = attr.calc(node.entity, fx.getEffects(node.entity.id)).attackDamage;
  T('⑥-被占领后据点获得正的攻击力/射程（tpl 的一部分，不再是 0）',
    capturedDamage > 0 && node.entity.baseStats.attackRange > 0);
  // 2026-09-26 第四轮·补充：用户追加定稿"据点在中立状态下攻击力低，在某方
  // 占领之后攻击力提高"——占领后的攻击力应该明显比中立时高（pointDamagePct
  // 30% > pointNeutralDamagePct 15%），不再是中立/占领共用同一份数值。
  T('⑥b-占领后攻击力比中立时更高（用户定稿"中立低、占领后提高"）',
    capturedDamage > neutralDamage);
  T('⑥c-占领后据点身上真的有一条可见的"据点占领增益"效果（用户追加返工："都要在状态栏显示"）',
    fx.getEffects(node.entity.id).some((e) => e.blueprint.name === '据点占领增益'));

  const before = node.capturePct;
  tick();
  T('⑦-己方（蓝）打不动自己已占领的点（canTarget 已经会挡，这里是兜底）', node.capturePct === before);

  // ⚠️ 红方开始进攻前，蓝方先撤出（两边同时在场会被判成"争夺中"，见第十一节），
  // 并把游戏时间往后拨过 contestWindowSec——避免刚撤出的蓝方 _lastHit 还落在窗口内。
  blueAttacker.targetId = null;
  window.gameTime += (DCFG.contestWindowSec ?? 2) + 1;
  redAttacker.targetId = node.entity.id;
  tick();
  T('⑧-敌方在场开始把进度往回推，但推到 0 之前归属仍然粘着蓝方',
    node.capturePct < before && node.captureOwner === FACTIONS.BLUE);

  while (node.captureOwner === FACTIONS.BLUE) tick();
  T('⑨-推到 0 之后变回中立（不是直接被红方占领）', node.captureOwner === FACTIONS.NEUTRAL && node.capturePct === 0);
  // 2026-09-26 第四轮：用户定稿"中立据点会正常攻击"——变回中立后攻击力/射程
  // 不再清零（中立据点会正常攻击，不再是完全被动的空目标）。
  T('⑩-变回中立后攻击力/射程仍然是正的', node.entity.baseStats.attackDamage > 0 && node.entity.baseStats.attackRange > 0);
  // 2026-09-26 第四轮·补充：变回中立后攻击力要跟着降回中立档（不是停留在
  // 占领时的更高档），也不是直接清零——"低"不等于"没有"。
  T('⑩b-变回中立后攻击力退回中立档（比刚才占领时低，但仍是正数，逐位等于最初的中立值）',
    Math.abs(node.entity.baseStats.attackDamage - neutralDamage) < 1e-9);
}

// ==================== 三、据点真的会开火（不是只有数值变了）====================
// 2026-09-26 第四轮：用户定稿"中立据点会正常攻击"——据点从 initMap() 创建
// 那一刻起就已经带着武器/攻击数值，不需要先被占领才会开火。
{
  const { ents, fx, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;
  const tick = (dt = tickSec) => { window.gameTime = (window.gameTime || 0) + dt; ds.update(dt); };

  T('①-中立据点从创建时起就已经装好了武器技能实例（不再是无武器空实例）',
    node.entity._skillInstances.some(s => s.skillId === 'weapon_piercing'));

  const neutralEnemy = mkEntity(ents, 'ranged', {
    faction: FACTIONS.RED,
    pos: { x: node.entity.pos.x + 10, y: node.entity.pos.y },
    stats: { maxHP: 100000, armor: 0, magicResist: 0 },
  }, C);
  const neutralHpBefore = neutralEnemy.currentHP;
  window.gameTime = 0;
  for (let i = 0; i < 200; i++) { window.gameTime += 0.1; combat.update(0.1); }
  T('②-中立态的据点确实会主动攻击靠近它的任意一方单位（不需要先被占领）',
    neutralEnemy.currentHP < neutralHpBefore);
  // 索敌锁定：目标存活且在射程内就不会重新索敌（见 CombatSystem.update() 的
  // "索敌锁定"注释）——不清掉这个目标，下面 ③ 新建的 enemy 永远抢不到点的
  // targetId，测的其实还是这具旧尸体，跟"占领后还会不会打"这件事没关系。
  neutralEnemy.alive = false;

  const attacker = mkEntity(ents, 'melee', { faction: FACTIONS.BLUE }, C);
  attacker.targetId = node.entity.id;
  while (node.captureOwner === FACTIONS.NEUTRAL) tick();

  const enemy = mkEntity(ents, 'ranged', {
    faction: FACTIONS.RED,
    pos: { x: node.entity.pos.x + 10, y: node.entity.pos.y },
    stats: { maxHP: 100000, armor: 0, magicResist: 0 },
  }, C);
  const hpBefore = enemy.currentHP;
  for (let i = 0; i < 200; i++) { window.gameTime += 0.1; combat.update(0.1); }
  T('③-被占领之后据点依然对射程内的敌方单位造成伤害（同一份武器/数值，没有跟着掉线）',
    enemy.currentHP < hpBefore);

  // 蓝方撤出，避开"双方同时在场=争夺中"（见第十一节），过了 contestWindowSec
  // 之后红方才开始进攻，模拟真实对局里不会有人一直占着自家已推满的点。
  attacker.targetId = null;
  window.gameTime += (DCFG.contestWindowSec ?? 2) + 1;
  const redAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);
  redAttacker.targetId = node.entity.id;
  while (node.captureOwner !== FACTIONS.NEUTRAL) tick();
  T('④-退回中立后武器技能仍然装着（中立据点也会正常攻击，不用跟着卸掉）',
    node.entity._skillInstances.some(s => s.skillId === 'weapon_piercing'));
}

// ==================== 四、CombatSystem：命中据点是纯粹的空操作 ====================
// 2026-09-26 第三轮：占领和攻击彻底解耦（用户定稿"占领和攻击是完全不同的实现"）
// 之后，攻击命中据点不再产生任何效果——不扣 HP，也不再转发占领压力，占领改由
// DominionSystem._tickCapture() 自己按固定节奏扫描"谁在场"，见该文件头注。
{
  const { ents, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const atk = mkEntity(ents, 'ranged', { faction: FACTIONS.BLUE, stats: { attackDamage: 999999 } }, C);

  const hpBefore = node.entity.currentHP;
  const pctBefore = node.capturePct;
  combat.performAttackDirect(atk.id, node.entity.id, 999999, 'physical', {});
  T('①-命中据点不扣 HP（据点没有 HP 概念）', node.entity.currentHP === hpBefore);
  T('②-命中据点也不再顺带产生占领压力（那部分已经改由固定节奏的扫描机制负责，见第十一节）',
    node.capturePct === pctBefore);

  combat._resolveHit({
    attackerId: atk.id, targetId: node.entity.id,
    baseDamage: 999999, onHitFixed: 0, onHitPctBase: 0, dmgAmp: 0, preDamageMult: 1,
    attackType: 'physical', isCrit: false, critMult: 200,
    armorPenPercent: 0, armorPenFlat: 0, magicPenPercent: 0, magicPenFlat: 0,
    weaponId: null, weaponInstId: null,
  });
  T('③-_resolveHit 路径同样什么都不做（不是只有 performAttackDirect 那一条漏了）',
    node.capturePct === pctBefore && node.entity.currentHP === hpBefore);
}

// ==================== 五、据点出兵：改走标准出兵编排系统，两个方向各出一整套 ====================
// 2026-09-26 返工：原来据点出兵是 DominionSystem 自己维护的 CONFIG.dominion.
// waveBudget，编辑器改了没用（用户报"实际出兵编排和模板编辑器中的对应不上"）。
// 现在据点出兵直接调 buildWaveOrder/compositionFor，跟模板编辑器"出兵编排"页
// 读写的是同一份数据——默认编排在 CONFIG.gameRules.laneWaveCompositionByLane
// 的 ring_fwd/ring_rev。用户定稿："每个据点改为每个方向生成2近战2远程（共4
// 近战4远程），每两两波每个方向额外生成1炮兵（共2炮兵）。"
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  // 隔离测试：水晶枢纽出兵锚点（kind:'nexus'）也走同一条共享环形兵线（同样的
  // laneId/direction 字符串），且 bonusWaveEvery 现在是 1——每一波都会跟着一起
  // 出兵，混进这里要单独盯的"某一个据点自己出的这一份编排"里。这两个节点
  // 本身的出兵行为由第六节单独覆盖，这里只掐掉它们对 spawned 数组的干扰，
  // 不改产品逻辑。
  ds.nodes = ds.nodes.filter(n => n.kind !== 'nexus');

  const spawned = [];
  ds.setCreateMinion((type, x, y, faction, laneId, direction) => spawned.push({ type, faction, laneId, direction }));

  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;
  const attacker = mkEntity(ents, 'melee', { faction: FACTIONS.BLUE }, C);
  attacker.targetId = node.entity.id;
  window.gameTime = 0;
  while (node.captureOwner === FACTIONS.NEUTRAL) { window.gameTime += tickSec; ds.update(tickSec); }
  // 出兵编排的波次时钟（_waveTimer/_waveCount，见 _tickWaves）跟占领是两个
  // 独立的时钟，但都挂在同一个 ds.update() 上——上面推进占领用的这些
  // ds.update(tickSec) 调用会顺带把波次时钟也走掉一截（中立据点不出兵，
  // spawned 数组不会被污染，但计数本身已经往前跑了）。归零，让下面
  // "第 1 波/第 2 波"的断言从一个干净的起点开始数。
  ds._waveTimer = 0;
  ds._waveCount = 0;

  const pointEvery = DCFG.pointWaveEvery ?? 2;

  // 2026-09-26 第四轮：用户定稿"基地每波出兵，据点改为每2波出兵"——奇数波
  // （_waveCount % 2 !== 0）据点应该完全不出兵，只有偶数波才出。
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // _waveCount=1（奇数）
  T('①-第 1 波（奇数）据点不出兵，用户定稿"据点改为每2波出兵"', spawned.length === 0);

  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // _waveCount=2（偶数，第一次真正出兵）
  const fwd1 = spawned.filter(s => s.direction === node.segForward.direction);
  const rev1 = spawned.filter(s => s.direction === node.segReverse.direction);
  T('②-第 2 波（偶数）顺时针方向出了 2 近战 + 1 远程，不含任何炮兵（据点已经不再生成炮兵）',
    fwd1.filter(s => s.type === 'melee').length === 2 && fwd1.filter(s => s.type === 'ranged').length === 1
    && fwd1.filter(s => s.type === 'siege').length === 0);
  T('③-逆时针方向也出了完全一样的一整套（不是把预算拆开轮流分给两边）',
    rev1.filter(s => s.type === 'melee').length === 2 && rev1.filter(s => s.type === 'ranged').length === 1);
  T('④-所有出的兵都是占领方的阵营', spawned.every(s => s.faction === FACTIONS.BLUE));
  T('④b-所有出的兵都走它自己声明的方向对应的 laneId（真实的 ring，不是伪路 id）',
    spawned.every(s => s.laneId === node.segForward.laneId));
  T('④c-据点默认不出超级兵', !spawned.some(s => s.type === 'super'));

  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // _waveCount=3（奇数，又不出兵）
  T('⑤-第 3 波（奇数）又轮空不出兵，确认不是只有第 1 波特殊', spawned.length === 0);

  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01); // _waveCount=4（偶数，第二次出兵）
  T('⑥-第 4 波（偶数）跟第 2 波完全一样的编排（据点出兵没有隔波+1这种概念了，是"每2波一次"的节奏本身，本波仅这一个已占领据点：2+1 两个方向共6个单位）',
    spawned.length === 6
    && spawned.filter(s => s.type === 'melee').length === 4 && spawned.filter(s => s.type === 'ranged').length === 2
    && spawned.filter(s => s.type === 'siege').length === 0);

  // 验证真实出兵读的就是 compositionFor()/编辑器同一份数据——直接改
  // CONFIG.gameRules.laneWaveCompositionByLane.ring_fwd 之后，下一次据点出兵
  // 马上跟着变，不需要重启/重新 initMap（这正是"跟模板编辑器同一份数据"这句话
  // 的可验证含义）。据点现在每 pointEvery 波才出一次，得多推进几波才能等到。
  const bak = CONFIG.gameRules.laneWaveCompositionByLane.ring_fwd;
  CONFIG.gameRules.laneWaveCompositionByLane.ring_fwd = [{ type: 'siege', count: 5 }];
  spawned.length = 0;
  for (let i = 0; i < pointEvery; i++) ds.update(DCFG.waveInterval + 0.01);
  const fwd4 = spawned.filter(s => s.direction === node.segForward.direction);
  T('⑦-改 CONFIG.gameRules.laneWaveCompositionByLane.ring_fwd 立刻影响真实出兵（编辑器改了不再没用）',
    fwd4.length === 5 && fwd4.every(s => s.type === 'siege'));
  CONFIG.gameRules.laneWaveCompositionByLane.ring_fwd = bak;

  // pseudoLaneId 的编码规则（<laneId>_fwd/_rev）跟 CONFIG.gameRules 里登记的
  // 键名一致，用真实 buildWaveOrder 调用交叉验证一遍。
  T('⑧-伪路 id 命名跟 CONFIG.gameRules.laneWaveCompositionByLane 的键一致',
    buildWaveOrder(1, false, CONFIG.gameRules, FACTIONS.BLUE, { laneId: 'ring_fwd' }).length === 3
    && buildWaveOrder(1, false, CONFIG.gameRules, FACTIONS.BLUE, { laneId: 'ring_rev' }).length === 3);
}

// ==================== 六、水晶枢纽出兵：每波固定编制，与据点占领无关 ====================
// 用户定稿："召唤水晶处每波生成3远程3近战1炮兵"——bonusWaveEvery 从 3 改成 1
// （字面意思上的"每波"），composition 从 1+1 改成 3+3+1。这份编排跟据点的
// 出兵编排系统（第五节）是两个独立的兵种来源，用户拍板过"两份分开"，不共用
// _spawnPointWave 那一套 compositionFor，所以还是走原来的 _spawnBudget 算法。
// 2026-09-26 第五轮：撤编召唤水晶(nexus_lane)之后，这份出兵待遇（以及
// "敌方水晶被摧毁才出超级兵"的判据）转到水晶枢纽(nexus_main)身上——
// _enemyCrystalDown() 现在查 nexus_main.alive，不再查 nexus_lane。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);

  const blueCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 500 } }, C);
  const redCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_main', stats: { maxHP: 500 } }, C);

  const spawned = [];
  ds.setCreateMinion((type, x, y, faction) => spawned.push({ type, faction }));

  T('①-bonusWaveEvery 定稿为 1（用户定稿"每波"字面意思，不再是每隔3波）',
    (DCFG.bonusWaveEvery ?? 1) === 1);

  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  // 2026-09-26 第四轮：用户反馈"滚雪球更严重了"，追加定稿"取消常驻超级兵的
  // 生成"——第二轮加的"基线每波自带 1 超级兵"整个撤销，退回只有"敌方水晶被
  // 拆才出超级兵"这一条路径（下面 ③④⑤）。双方水晶都活着时不应该有任何超级兵。
  T('②-双方水晶枢纽都活着时，每波出 3 近战 + 3 远程 + 1 炮兵，不含超级兵（已取消常驻超级兵）',
    spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'melee').length === 3
    && spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'ranged').length === 3
    && spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'siege').length === 1
    && spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'super').length === 0);

  // 红方水晶枢纽被摧毁（alive=false，跟 MapSystem._onEntityDeath 的处理逐位一致）
  redCrystal.alive = false;
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  const blueSupers = spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'super');
  const redSupers = spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'super');
  T('③-红方水晶枢纽被摧毁后，蓝方（打掉它的一方）出 1 个超级兵（没有基线可加，crystalSuperBonus 直接就是最终值）',
    blueSupers.length === 1);
  T('④-红方自己（水晶被摧毁的一方）不会因此获得超级兵，仍是 0 个',
    redSupers.length === 0);
  T('④b-超级兵加成是额外加的，常规编制(3+3+1)依然照出不误',
    spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'melee').length === 3
    && spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'ranged').length === 3
    && spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'siege').length === 1);

  // 红方水晶枢纽"复活"（现实中水晶枢纽被摧毁=游戏结束，不会真的复活——这里
  // 单纯是测试手段，验证_enemyCrystalDown()读的是【当前】alive状态，不是
  // 曾经死过一次就锁死的旗标）。
  redCrystal.alive = true;
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('⑤-红方水晶枢纽 alive 回真后，蓝方的超级兵加成立刻停止，退回 0 个（不是"退回基线1个"，因为已经没有基线了）',
    spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'super').length === 0);
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

  const points = ds.nodes.filter(n => n.kind === 'point');
  points[0].captureOwner = FACTIONS.BLUE; points[0].capturePct = FULL;

  const redHpBefore = redNexus.currentHP, blueHpBefore = blueNexus.currentHP;
  ds.update(1);
  T('①-占点数落后的一方（红）水晶掉血', redNexus.currentHP < redHpBefore);
  T('②-占点数领先的一方（蓝）水晶不掉血', blueNexus.currentHP === blueHpBefore);

  const dropAt1 = redHpBefore - redNexus.currentHP;
  points[1].captureOwner = FACTIONS.BLUE; points[1].capturePct = FULL;
  const redHpBefore2 = redNexus.currentHP;
  ds.update(1);
  const dropAt2 = redHpBefore2 - redNexus.currentHP;
  // 2026-09-26 第二轮：用户反馈"某一方滚雪球太严重了"——掉血速率从"跟据点数差
  // 线性走"改成"跟 sqrt(据点数差) 走"（见 DominionSystem._tickNexusDrain 头注），
  // 据点数差从 1 变到 2 时，掉血速率应该是 √2 倍，不再是 2 倍。
  T('③-据点数差从 1 变到 2，掉血速率变成 √2 倍（sqrt 曲线，不再是线性的 2 倍）',
    Math.abs(dropAt2 - Math.SQRT2 * dropAt1) < 1e-6);
  // 2026-09-26 第四轮：1 → 0.8——balance_dominion.mjs 实测发现真正的滚雪球根因
  // 是水晶枢纽没有回血、落后期间欠的血债追不回来（不是这个系数本身），用户
  // 定稿"根因暂不修，先只调这个系数，水晶枢纽满血还是500"，0.8 是待
  // balance_matrix 校准的起草值，不是像 1 那样的用户逐字定稿数字。
  T('③b-掉血速率系数当前是 0.8（水晶枢纽没有回血这条根因暂缓，先用这个系数买一点缓冲，起草值待校准）',
    DCFG.nexusDrainPerPointPerSec === 0.8);

  let deathEvent = null;
  bus.emit = (evt, payload) => { if (evt === 'entity:death') deathEvent = payload; };
  redNexus.currentHP = 0.001;
  ds.update(1000);
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
  ds.initMap(MAPS['summoners_rift_v1']);
  T('③-普通地图不激活这套机制（active 仍为 false）', ds.active === false);
}

// ==================== 九、水晶枢纽自带武器 + 无法被小兵攻击（initMap 时就定好） ====================
// 2026-09-26 第五轮：撤编召唤水晶(nexus_lane)之后，"自带穿透型子弹+物理攻击"
// 这份待遇转到水晶枢纽(nexus_main)身上；同一轮追加定稿"水晶枢纽无法被场上
// 的小兵所攻击"——initMap() 顺手给它标 `_untargetable`。
{
  const { ents, fx, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const blueCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 500, attackDamage: 700, attackRange: 420 } }, C);
  const redCrystal = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_main', stats: { maxHP: 500, attackDamage: 700, attackRange: 420 } }, C);

  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  ds.initMap(MAPS['dominion_crystal_scar_v1']);

  T('①-蓝方水晶枢纽 initMap 时就自动装备了穿透型武器（不需要先打一场仗）',
    blueCrystal._skillInstances.some(s => s.skillId === 'weapon_piercing'));
  T('②-红方水晶枢纽同样装备（两座都要，不是只装了一座）',
    redCrystal._skillInstances.some(s => s.skillId === 'weapon_piercing'));
  T('②b-两座水晶枢纽都标了 _untargetable（用户定稿"水晶枢纽无法被场上的小兵所攻击"）',
    blueCrystal._untargetable === true && redCrystal._untargetable === true);
  T('②c-isStructureProtected 认得这个标记，无条件放行（跳过任何索敌判定）',
    isStructureProtected(ents, blueCrystal) === true);

  ds.initMap(MAPS['dominion_crystal_scar_v1']);
  T('③-重复 initMap 不会重复装备（幂等）',
    blueCrystal._skillInstances.filter(s => s.skillId === 'weapon_piercing').length === 1);
}

// ==================== 十、据点/召唤水晶的占领进度展示（resourceBar.js 复用法力条）====================
// 用户返工："应该是显示某一方占领进度从0到100，用颜色区分"——无符号 0~1，
// 中立=空条，颜色按当前领先方走（不用等完全占领才变色）。
{
  const neutralPt = { isCapturePoint: true, _capturePct: 0, _captureOwner: FACTIONS.NEUTRAL };
  const bluePt = { isCapturePoint: true, _capturePct: 100, _captureOwner: FACTIONS.BLUE };
  const redPt = { isCapturePoint: true, _capturePct: -40, _captureOwner: FACTIONS.NEUTRAL };
  const ctx = {};

  const infoNeutral = resourceInfoOf(neutralPt, ctx);
  T('①-中立据点：frac 是 0（空条，不是半满），kind 是中立色，不是法力/升温这些常规资源',
    infoNeutral.frac === 0 && infoNeutral.kind === 'capture_neutral');

  const infoBlue = resourceInfoOf(bluePt, ctx);
  T('②-完全被蓝方占领：frac 拉满（1），kind 是蓝方色', infoBlue.frac === 1 && infoBlue.kind === 'capture_blue');

  const infoRed = resourceInfoOf(redPt, ctx);
  T('③-红方领先 40%（中立据点，还没完全占领）：frac=0.4（幅值本身，不再叠加中点偏移），kind 已经跟着当前领先方是红色',
    Math.abs(infoRed.frac - 0.4) < 1e-9 && infoRed.kind === 'capture_red');

  T('④-label 里带上了具体百分比数字，不是只有颜色/进度条', /\d+%/.test(infoBlue.label) && /\d+%/.test(infoRed.label));
  T('⑤-RESOURCE_COLORS 里确实定义了三种据点专属颜色（面板/画板血条共用同一份颜色表）',
    !!RESOURCE_COLORS.capture_blue && !!RESOURCE_COLORS.capture_red && !!RESOURCE_COLORS.capture_neutral);

  const normalTower = { _skillInstances: [] };
  const infoNormal = resourceInfoOf(normalTower, { skillLibrary: {}, attrCalc: { calc: () => ({}) }, effects: { getEffectByName: () => null } });
  T('⑥-普通单位不受影响（没有 isCapturePoint 字段时走原来的法力/充能判定，退化空法力条）',
    infoNormal.kind === 'mana' && infoNormal.label === '0/0');
}

// ==================== 十一、据点争夺：双方同时在场则不可选中，逼迫交战 ====================
// 用户定稿："两方不能同时占领据点，如果出现了，据点进入不可被占领状态
// （不可被双方选中，迫使两方开始交战），直至只剩一方占领该据点。"
//
// 2026-09-26 第三轮：占领和攻击解耦之后，"在场"不再靠某次攻击命中记一笔，
// 而是靠 DominionSystem._tickCapture() 每次 update() 扫描"谁把这个据点设为
// 目标"——这里用极小的 dt（0.001s）驱动 update() 只为了刷新"在场/争夺"状态
// 本身，不会因为累计到 captureTickSec 而真的推进占领进度（那部分单独用完整
// 的 captureTickSec 在 T⑧ 验证）。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const win = DCFG.contestWindowSec ?? 2;
  const tickSec = DCFG.captureTickSec ?? 1;

  const blueAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.BLUE }, C);
  const redAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);

  window.gameTime = 500;
  blueAttacker.targetId = node.entity.id;
  ds.update(0.001);
  T('①-只有蓝方在场时不算争夺（还没被双方同时打过）', node.entity._contested === false);

  const pctBeforeContest = node.capturePct;
  window.gameTime = 500.5; // 0.5 秒后红方也来了，落在 contestWindowSec 之内
  redAttacker.targetId = node.entity.id;
  ds.update(0.001);
  T('②-双方短时间内都打过之后，据点进入争夺状态', node.entity._contested === true);
  T('③-争夺中这一下命中不产生任何占领压力（既不加也不减）', node.capturePct === pctBeforeContest);
  T('④-争夺中攻击者的 targetId 被清空（逼它下一轮重新索敌，索敌会经 isStructureProtected 跳过这个据点）',
    redAttacker.targetId === null && blueAttacker.targetId === null);
  T('⑤-isStructureProtected 认得争夺中的据点，拒绝把它当合法目标', isStructureProtected(ents, node.entity) === true);

  blueAttacker.targetId = node.entity.id;
  window.gameTime = 500.6;
  ds.update(0.001);
  T('⑥-争夺中双方都打不动这个点（不是只挡了一方）',
    node.capturePct === pctBeforeContest && blueAttacker.targetId === null);

  // 红方消失、蓝方孤身留下：过了 contestWindowSec 之后争夺自动解除
  window.gameTime = 500.6 + win + 1;
  blueAttacker.targetId = node.entity.id;
  ds.update(0.001);
  T('⑦-红方长时间没再出现、窗口过期后争夺自动解除（不需要额外事件通知）', node.entity._contested === false);
  T('⑨-isStructureProtected 也跟着认为它重新可以被选中了', isStructureProtected(ents, node.entity) === false);

  // 解除后蓝方满一个完整的 captureTickSec，才会真的推进一次占领压力
  // （固定节奏，跟攻速无关，见 DominionSystem._tickCapture() 头注）。
  blueAttacker.targetId = node.entity.id;
  window.gameTime += tickSec;
  ds.update(tickSec);
  T('⑧-解除后蓝方满一个 tick 后重新产生占领压力', node.capturePct > pctBeforeContest);
}

// ==================== 十二、脱战恢复：静息值回归 ====================
// 用户定稿："若据点脱离战斗状态，此时会慢慢恢复该状态下的值。比如此时为中立
// 据点（红方并未完全占领），脱战后红方占领进度会慢慢消退直至0。如果该据点
// 已经被红方占领了，但是由于蓝方进攻占领进度目前为40%，那么脱战后占领进度
// 会慢慢恢复为100。"
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const points = ds.nodes.filter(n => n.kind === 'point');

  // 场景①：中立据点，红方领先但还没占满——脱战后应该慢慢消退回 0。
  // 这两个点从没有任何小兵在场过（_lastHit 全是 -Infinity），对
  // _tickCapture()/_tickRegen() 来说天然就是"早就脱战了"，不需要额外拨时间
  // 模拟脱战。
  const p1 = points[0];
  p1.captureOwner = FACTIONS.NEUTRAL;
  p1.capturePct = -30;
  ds._syncCaptureDisplay(p1);
  ds.update(0.5); // 小步长，看它是不是"慢慢"移动而不是一步到位
  T('①-中立据点脱战后向 0 回归（不是原地不动，也不是一步走到底）',
    p1.capturePct > -30 && p1.capturePct < 0);
  for (let i = 0; i < 500 && p1.capturePct !== 0; i++) ds.update(1);
  T('②-脱战恢复最终精确停在 0，归属仍是中立（回归不会因为浮点步长扣过头）',
    p1.capturePct === 0 && p1.captureOwner === FACTIONS.NEUTRAL);

  // 场景②：已被红方占领，蓝方进攻打到 40%（对红方而言 capturePct=-40）——
  // 脱战后应该慢慢恢复回 -100（红方自己的满值，不是 0）。
  const p2 = points[1];
  p2.captureOwner = FACTIONS.RED;
  p2.capturePct = -40;
  ds._syncCaptureDisplay(p2);
  ds.update(0.5);
  T('③-已占领的据点脱战后向自己的满值回归（红方满值是 -100，不是 0）',
    p2.capturePct < -40 && p2.capturePct > -100);
  for (let i = 0; i < 500 && p2.capturePct !== -100; i++) ds.update(1);
  T('④-脱战恢复最终精确停在满值 -100，归属仍然是红方（回归不触发 _setOwner 的多余副作用）',
    p2.capturePct === -100 && p2.captureOwner === FACTIONS.RED);

  // 场景③：正在被攻击（最近有命中）的据点不该被脱战恢复悄悄拉走——
  // "脱战"要求两方都超过 combatTimeoutSec 秒没打过，而不是"当下没在争夺"就够了。
  const p3 = points[2];
  p3.captureOwner = FACTIONS.NEUTRAL;
  p3.capturePct = -30;
  ds._syncCaptureDisplay(p3);
  const attacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);
  attacker.targetId = p3.entity.id;
  window.gameTime = (window.gameTime || 0) + 1;
  ds.update(0.001); // 极小步长：只刷新"在场"（_lastHit），不会累积到一整个 captureTickSec
  const pctAfterHit = p3.capturePct;
  ds.update(0.5); // 只过了半秒，远没到 combatTimeoutSec（默认 4 秒），红方仍在场
  T('⑤-最近还在被攻击的据点不会被脱战恢复悄悄拉走', p3.capturePct === pctAfterHit);
}

// ==================== 十三、据点/召唤水晶数值调整（用户返工定稿）====================
{
  // 2026-09-26 第二轮：用户实机测过之后改口"太低了，需要加强"——不再钉死
  // "必须 <=20" 这个第一轮的具体门限，改钉行为形状本身：比第一轮砍过头的
  // 12% 强，但仍然比原型草案原始的 35% 弱（用户没说要强化到超过原始基准）。
  // 2026-09-26 第三轮：用户实机测过第二轮的 30% 之后仍反馈"还是太低了"——
  // 说明"不超过原始35%基准"这条第二轮自己加的隐性上限本身就是错的，这次
  // 改钉"比第二轮的 30% 继续强化"，不再假设存在任何固定上限。
  T('①-据点攻击力（占领后）比第二轮的 30% 继续强化', (DCFG.pointDamagePct ?? 30) > 30);
  T('①b-中立时的攻击力也同步提高（用户定稿"中立状态和占领状态的攻击都提高"），且仍然低于占领后（维持"中立弱、占领强"的层级关系不能被"都提高"这条要求打破）',
    (DCFG.pointNeutralDamagePct ?? 15) > 15 && DCFG.pointNeutralDamagePct < DCFG.pointDamagePct);
  T('②-新增据点攻速系数，且是提升方向（"略微提升"≈>100%）',
    (DCFG.pointAttackSpeedPct ?? 100) > 100);
  T('③-小兵占领速度整体提高（capturePower 各项都比原型草案的基准更高）',
    DCFG.capturePower.melee > 1.0 && DCFG.capturePower.ranged > 0.75
    && DCFG.capturePower.siege > 0.75 && DCFG.capturePower.super > 2.2);

  // 数值真的接线到 _setOwner，不是只停在 Config.js 里没人读
  const { ents, fx, attr, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  ds.initMap(MAPS['dominion_crystal_scar_v1']);
  const node = ds.nodes.find(n => n.kind === 'point');
  const tpl = CONFIG.templates.tower;
  const tickSec = DCFG.captureTickSec ?? 1;
  const attacker = mkEntity(ents, 'melee', { faction: FACTIONS.BLUE }, C);
  attacker.targetId = node.entity.id;
  window.gameTime = 0;
  while (node.captureOwner === FACTIONS.NEUTRAL) { window.gameTime += tickSec; ds.update(tickSec); }
  const finalDamage = attr.calc(node.entity, fx.getEffects(node.entity.id)).attackDamage;
  T('④-占领后据点的攻击力确实是 tpl 的 pointDamagePct%（不是某个写死的数；现在是 baseStats 中立基线 + 一条可见效果的加成合计）',
    Math.abs(finalDamage - tpl.attackDamage * (DCFG.pointDamagePct / 100)) < 1e-6);
  T('⑤-占领后据点的攻速确实是 tpl 的 pointAttackSpeedPct%（新增的这个维度真的生效了）',
    Math.abs(node.entity.baseStats.baseAttackSpeed - tpl.baseAttackSpeed * (DCFG.pointAttackSpeedPct / 100)) < 1e-6);
}

// ==================== 十四、main.js / CombatSystem.js / UnitLayer.js / FactionSystem.js 源码接线核对 ====================
{
  // 2026-09-26 第三轮：占领和攻击彻底解耦（用户定稿"占领和攻击是完全不同的
  // 实现"）——CombatSystem 不再持有 dominionSystem 引用，命中据点纯粹是
  // 空操作，旧的转发/setDominionSystem 接线全部删除。
  const combatSrc = srcOf('src/systems/CombatSystem.js');
  T('①-CombatSystem 不再持有 dominionSystem 引用（回归守卫：防止重新引入旧的耦合）',
    !/dominionSystem/.test(combatSrc));
  T('②-_resolveHit 命中据点分支直接 return，什么都不做', /if \(target\.isCapturePoint\) return;/.test(combatSrc));
  T('③-performAttackDirect 命中据点分支同样直接 return 0', /if \(target\.isCapturePoint\) return 0;/.test(combatSrc));

  const mainSrc = srcOf('src/main.js');
  T('④-main.js 造了 DominionSystem（不再需要接到 combatSystem，两者已经解耦）',
    /new DominionSystem\(/.test(mainSrc) && !/combatSystem\.setDominionSystem/.test(mainSrc));
  T('⑤-main.js 主循环里调用了 dominionSystem.update(dt)', /dominionSystem\.update\(dt\)/.test(mainSrc));
  T('⑥-map:loading 里 reset、map:loaded 里 initMap（跟 DragonSystem 同一套时序）',
    /dominionSystem\.reset\(\)/.test(mainSrc) && /dominionSystem\.initMap\(mapSystem\.currentMap\)/.test(mainSrc));
  T('⑦-dominionSystem 也注入了 createMinion（复用 main.js 的兵种工厂）',
    /dominionSystem\.setCreateMinion\(/.test(mainSrc));

  const layerSrc = srcOf('src/presentation/UnitLayer.js');
  T('⑧-UnitLayer 的画板血条对 isCapturePoint 有专门分支（不是画一条没意义的满血条）',
    /if \(e\.isCapturePoint\) \{/.test(layerSrc));
  T('⑨-isCapturePoint 分支恒定显示（不受"结构保护+满血则隐藏"那条规则约束——占领条不是血条，见 bug 修复的 showBar=true）',
    /e\.isCapturePoint[\s\S]{0,400}showBar\s*=\s*true/.test(layerSrc));
  // 2026-09-26 用户补充定稿："目前据点在画板上的进度条并无拖尾特效，需要和其他
  // 进度条统一增加拖尾/增加特效"——_redrawBar 的 isCapturePoint 分支原来直接
  // return，调用方已经用 stepTrail 算好的 resTrailFrac 传进来却从没读过。
  T('⑫-画板据点条现在真的用了 resTrailFrac（不再是早期版本直接 return、完全无视调用方算好的拖尾数据）',
    /if \(e\.isCapturePoint\) \{[\s\S]{0,900}resTrailFrac > capFrac/.test(layerSrc));
  T('⑬-据点的拖尾残段跟 HP/资源条用同一个 TRAIL_COLOR 常量（真正的"统一"，不是另起一套颜色）',
    /if \(e\.isCapturePoint\) \{[\s\S]{0,1000}TRAIL_COLOR/.test(layerSrc));

  const facSrc = srcOf('src/systems/FactionSystem.js');
  T('⑩-isStructureProtected 里接了 _contested 判断（争夺中的据点在所有既有索敌/攻击判据点上都生效）',
    /isCapturePoint && target\._contested/.test(facSrc));

  const domSrc = srcOf('src/systems/DominionSystem.js');
  T('⑪-占领改走固定节奏的 _tickCapture，旧的"挂在攻击事件上"的 applyCapturePressure 已经删除',
    /_tickCapture\(dt\)/.test(domSrc) && !/applyCapturePressure\s*\(/.test(domSrc));
}

// ==================== 十五、统治战场并入"选择模式"tab ====================
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

  ms.loadMap('summoners_rift_v1', 'dominion');
  T('④-选中统治战场模式后，不管原来选的是哪张图，都会强制换成这张专属地图',
    ms.currentMap.id === DOMINION_MODE_MAP_ID && ms.currentMode === 'dominion');

  const dialogSrc = srcOf('src/ui/ModeDialog.js');
  T('⑤-ModeDialog.js 给 dominion 配了专属图标，不是沿用 normal/classic 的兜底',
    /MODE_ICONS\s*=\s*\{[^}]*dominion/.test(dialogSrc));
  T('⑥-选中统治战场时"选择地图"块改成渲染当前这张图（水晶之痕），不是彻底隐藏',
    /isDominion[\s\S]{0,400}mapSystem\.currentMap/.test(dialogSrc)
    && !/isDominion \? '' :/.test(dialogSrc));

  const laneSrc = srcOf('src/ui/laneLabels.js');
  T('⑦-mapLaneIds() 优先读 map.waveEditorLaneIds（Q3 返工：编辑器"路"数跟物理兵线数解耦）',
    /waveEditorLaneIds/.test(laneSrc));
  T('⑧-laneLabel/laneShort 给顺/逆时针配了人话标签，不是直接显示 ring_fwd/ring_rev 这种内部 id',
    /ring_fwd:\s*'[^']*顺时针/.test(laneSrc) && /ring_rev:\s*'[^']*逆时针/.test(laneSrc));
}

// ==================== 十六、真实移动回归：小兵不会卡在据点/塔下不动 ====================
// 用户实机报"会出现小兵在塔下呆着不动，不知道什么意思"。根因见
// MapSystem._computeWaypointBlock 头注新补的一段：5 个据点不进 map.buildings
// （据点走 DominionSystem 自己的 dominionNodes，不走常规建塔管线），而据点
// pos 恰好就是环形兵线上的一个路点——这个函数之前只认 map.buildings，据点的
// 避障半径（CONFIG.buildingSizes 没有 'capture_point' 这个 tier，退回
// default=32 × towerVizScale.default=1.25 = 40px）完全没被计入 _wpBlock，
// 到达半径只有 24px，40 > 24，小兵永远够不着那个精确路点坐标，被碰撞推着
// 原地顶牛——跟 sim_pathcorner.mjs⑦ 那次"塔压在路点上"是同一个坑，这次换了
// 一种不走 buildings 数组的建筑实现方式而已。
//
// 用真实 LaneMovementSystem 让一个兵从兽骨场出发，沿顺时针方向跑足够绕完
// 一整圈的时长，钉住"路点索引不会在任何一个据点/基地处停住不再推进"——
// 不钉具体像素/秒数（那些是起草值），钉的是"卡死"这个行为形状本身。
// 隔离交战这个变量：真实地图上环绕整圈会先撞上敌方召唤水晶，minion 停下来
// 打架是【正确】行为，不是这次要钉的 bug——所以这里不建召唤水晶实体（不进
// ents，没有可选中的目标），据点也在 DominionSystem.initMap() 建好之后
// 改成跟小兵同阵营（canTarget 同阵营必为 false，不会被当成敌人打），只留下
// 它们的【物理避障体积】——这样才能干净地单独测"路径推进会不会被卡死"，
// 不跟"正在交战所以站定"这个完全正常的分支混在一起。
{
  const { ents, CONFIG: C } = await makeWorld();
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
  const bus = new EventBus();
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus);
  ms.setCreateBuildingFn(({ pos }) => ({ pos })); // 不进 ents：没有召唤水晶可打
  window.gameTime = 0;
  ms.loadMap('dominion_crystal_scar_v1');
  const map = MAPS['dominion_crystal_scar_v1'];
  const lane = ms.getLane('ring');

  T('①-据点自己的避障半径确实被计入 _wpBlock（不再是 -Infinity，之前压根不知道据点存在）',
    map.dominionNodes.filter(n => n.kind === 'point')
      .every(n => {
        const idx = lane.waypoints.findIndex(w => Math.hypot(w.x - n.pos.x, w.y - n.pos.y) < 1);
        return idx >= 0 && lane._wpBlock[idx] > 0;
      }));

  const ds = new DominionSystem(ents, bus);
  ds.initMap(map);
  for (const node of ds.nodes) {
    if (!node.entity) continue;
    node.entity._mapFaction = FACTIONS.BLUE; // 测试专用：跟小兵同阵营，不互相交火
    node.entity.faction = FACTIONS.BLUE;
  }

  const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, ms);
  const boneyard = map.dominionNodes.find(n => n.id === 'boneyard');
  const m = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: boneyard.pos.x, y: boneyard.pos.y },
    baseStats: { ...C.templates.melee }, currentHP: C.templates.melee.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: FACTIONS.BLUE, faction: FACTIONS.BLUE,
    _laneId: 'ring', _laneDirection: 'forward',
  };
  ents.add(m);

  const DT = 1 / 30;
  const runSeconds = 220; // 足够绕完好几整圈（实测约 73s/圈），给足冗余
  let maxStall = 0, lastIdx = m._laneWaypointIndex, stallStart = 0, wraps = 0;
  for (let i = 0; i < runSeconds / DT; i++) {
    window.gameTime = i * DT;
    move.update(DT);
    if (m._laneWaypointIndex !== lastIdx) {
      maxStall = Math.max(maxStall, window.gameTime - stallStart);
      // 索引从接近末尾突然跳回接近开头 → 绕完了一圈（loop:true 的 wrap()）。
      if (lastIdx > m._laneWaypointIndex && lastIdx - m._laneWaypointIndex > 5) wraps++;
      lastIdx = m._laneWaypointIndex;
      stallStart = window.gameTime;
    }
  }
  maxStall = Math.max(maxStall, window.gameTime - stallStart);
  T(`②-绕圈期间路点索引最长停滞 ${maxStall.toFixed(1)}s，没有在任何一个据点处卡死不再推进（< 10s）`,
    maxStall < 10);
  T(`③-${runSeconds}s 里确实绕完了不止一整圈（wraps=${wraps} ≥ 2，不是卡在半路一直没到终点）`,
    wraps >= 2);
}

// ==================== 十七、追赶机制：落后一方基地出兵额外带炮兵 ====================
// 2026-09-26 第四轮：用户定稿"当某方占领的据点数量低于另一方时，基地出兵
// 每波额外出1×据点占领差值的炮兵"——纯粹的据点数量差值，跟谁在打谁、水晶
// 死没死都无关，只看 _tickWaves() 每次结算时双方各占了几个据点。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 500 } }, C);
  mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_main', stats: { maxHP: 500 } }, C);

  const points = ds.nodes.filter(n => n.kind === 'point');
  const spawned = [];
  ds.setCreateMinion((type, x, y, faction) => spawned.push({ type, faction }));

  // 双方占点数相等（0=0）：谁都不该有追赶炮兵，仍是基线的 1 炮兵。
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('①-双方占点数相等（都是 0）时没有追赶加成，双方都只有基线的 1 个炮兵',
    spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'siege').length === 1
    && spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'siege').length === 1);

  // 蓝方占 2 个据点，红方占 0 个：红方落后 2，应该额外多出 2 个炮兵（基线1+追赶2=3）；
  // 蓝方领先，不受影响，仍是基线的 1 个。
  points[0].captureOwner = FACTIONS.BLUE; points[0].capturePct = FULL;
  points[1].captureOwner = FACTIONS.BLUE; points[1].capturePct = FULL;
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('②-占点落后 2 个的红方，基地这一波炮兵数=基线1+差值2=3',
    spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'siege').length === 3);
  T('③-占点领先的蓝方不受影响，仍是基线的 1 个炮兵（不是双方都加）',
    spawned.filter(s => s.faction === FACTIONS.BLUE && s.type === 'siege').length === 1);
  T('④-追赶只加炮兵这一项，常规的近战/远程编制不受影响（3+3，不是被炮兵顶掉）',
    spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'melee').length === 3
    && spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'ranged').length === 3);

  // 红方追上（也占 2 个），差值归零：额外炮兵立刻消失，不需要额外的"追平"事件。
  points[2].captureOwner = FACTIONS.RED; points[2].capturePct = -FULL;
  points[3].captureOwner = FACTIONS.RED; points[3].capturePct = -FULL;
  spawned.length = 0;
  ds.update(DCFG.waveInterval + 0.01);
  T('⑤-双方占点数追平（2=2）后，追赶炮兵立刻消失，红方退回基线的 1 个',
    spawned.filter(s => s.faction === FACTIONS.RED && s.type === 'siege').length === 1);
}

// ==================== 十八、bug修复：占领翻转后不会继续咬着已锁定的旧目标打到死 ====================
// 用户报"在某方夺取某个据点后，该防御塔依然会攻击正在锁定的目标直至死亡"。
// 根因：中立据点索敌不分敌我（canTarget(NEUTRAL,*) 恒真），如果它锁定的目标
// 恰好跟"刚占领它的那一方"同阵营，占领瞬间目标就从敌人变成了友军——但
// CombatSystem.update() 里"索敌锁定"那段校验原来只查 alive/射程，从来没有
// 在【已经锁定】的情况下复查过阵营，于是翻转之后这座塔还在照着旧目标打，
// 直到它死或走出射程才停。修复见 CombatSystem.js 里新增的 canTarget 复查。
{
  const { ents, fx, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;

  // 蓝方单位既是"正在占领这个据点的人"（targetId 指向据点），也恰好站在
  // 射程内——中立据点索敌不分敌我，会同时把它当成攻击目标锁定住。
  const blueUnit = mkEntity(ents, 'melee', {
    faction: FACTIONS.BLUE,
    pos: { x: node.entity.pos.x + 10, y: node.entity.pos.y },
    stats: { maxHP: 100000, armor: 0, magicResist: 0 },
  }, C);
  blueUnit.targetId = node.entity.id;

  window.gameTime = 0;
  for (let i = 0; i < 5; i++) { window.gameTime += 0.1; combat.update(0.1); }
  T('①-中立据点确实锁定住了这个恰好也在占领它的蓝方单位（前置条件：翻转前先锁定）',
    node.entity.targetId === blueUnit.id);
  const hpBeforeFlip = blueUnit.currentHP;
  T('②-锁定之后蓝方单位确实在掉血（不是锁定了却没打）', hpBeforeFlip < 100000);

  // 推进占领直到翻转成蓝方——翻转瞬间据点的 _mapFaction 从中立变成蓝方，
  // 之前锁定的蓝方单位从"敌人"变成了"友军"。
  while (node.captureOwner === FACTIONS.NEUTRAL) { window.gameTime += tickSec; ds.update(tickSec); }
  T('③-翻转后据点的阵营确实已经变成蓝方', node.entity._mapFaction === FACTIONS.BLUE);

  const hpAfterFlip = blueUnit.currentHP;
  for (let i = 0; i < 50; i++) { window.gameTime += 0.1; combat.update(0.1); }
  T('④-修复之后：翻转后据点不会继续咬着这个已经变成友军的旧目标打到死（bug修复前会一直打到它死）',
    node.entity.targetId !== blueUnit.id && blueUnit.currentHP === hpAfterFlip);
}

// ==================== 十九、驻守小兵：己方据点攻击范围内有己方小兵时，敌方占领速度打五折 ====================
// 用户定稿："若我方据点的攻击范围内还存在我方小兵，则敌方的占领速度降低50%"。
// 根因见 DominionSystem._tickCapture() 里新增的驻守检测那段注释：己方小兵
// 不可能把 targetId 设成自己的据点（canTarget 挡着同阵营互相攻击），所以
// 驻守小兵一直没办法体现在"谁在占领"的那份扫描里，这里单独按"阵营 + 据点
// 自己的攻击范围"检测驻守，跟"谁在占领"用的是两套完全不同的判据。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;

  node.captureOwner = FACTIONS.BLUE; node.capturePct = FULL;
  ds._syncCaptureDisplay(node);
  const redAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);
  redAttacker.targetId = node.entity.id;
  window.gameTime = 0;
  window.gameTime += tickSec; ds.update(tickSec);
  const dropNoDefender = FULL - node.capturePct;
  T('①-没有驻守小兵时，红方确实能正常推进（前提：先测出正常掉的量，不是巧合为 0）',
    dropNoDefender > 0);

  // 复原到满值，这次在据点攻击范围内放一个蓝方驻守小兵（离据点很近，但不会
  // 把 targetId 设成据点自己——那是 canTarget 不允许的）。
  node.captureOwner = FACTIONS.BLUE; node.capturePct = FULL;
  ds._syncCaptureDisplay(node);
  redAttacker.targetId = node.entity.id;
  const blueDefender = mkEntity(ents, 'melee', {
    faction: FACTIONS.BLUE,
    pos: { x: node.entity.pos.x + 5, y: node.entity.pos.y },
  }, C);
  window.gameTime += tickSec; ds.update(tickSec);
  const dropWithDefender = FULL - node.capturePct;
  T('②-驻守小兵在场时，敌方这一 tick 的净占领压力正好打五折（用户给的具体数字：50%）',
    Math.abs(dropWithDefender - dropNoDefender * 0.5) < 1e-6);

  // 驻守小兵走出据点攻击范围之后，敌方占领速度应该恢复正常——不是"来过就永久打折"。
  node.captureOwner = FACTIONS.BLUE; node.capturePct = FULL;
  ds._syncCaptureDisplay(node);
  redAttacker.targetId = node.entity.id;
  blueDefender.pos.x = node.entity.pos.x + 99999;
  window.gameTime += tickSec; ds.update(tickSec);
  const dropAfterLeaving = FULL - node.capturePct;
  T('③-驻守小兵离开攻击范围之后，敌方占领速度恢复正常（不再打折）',
    Math.abs(dropAfterLeaving - dropNoDefender) < 1e-6);

  T('④-defenderSlowPct 定稿为 50（用户给的具体数字，不是起草值）', DCFG.defenderSlowPct === 50);
}

// ==================== 十九b、驻守减速必须在状态栏可见（用户追加返工）====================
// 用户："这个经过实测并没做出来，需要修复。还有攻占后据点属性提升，攻占速度
// 减少等都要在状态栏显示！"——排查后确认十九节测的折算逻辑本身没问题，真正
// 缺的是"玩家看不看得见"：原来只改了两个局部变量 bluePower/redPower，据点
// 自己的效果列表里什么都没有。这里改走 EffectRegistry.apply，跟其它任何
// buff/debuff 一样能被 effects.getEffects() 读到。
{
  const { ents, fx, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');
  const tickSec = DCFG.captureTickSec ?? 1;

  node.captureOwner = FACTIONS.BLUE; node.capturePct = FULL;
  ds._syncCaptureDisplay(node);
  const redAttacker = mkEntity(ents, 'melee', { faction: FACTIONS.RED }, C);
  redAttacker.targetId = node.entity.id;
  const blueDefender = mkEntity(ents, 'melee', {
    faction: FACTIONS.BLUE, pos: { x: node.entity.pos.x + 5, y: node.entity.pos.y },
  }, C);
  window.gameTime = 0;
  window.gameTime += tickSec; ds.update(tickSec);
  const hasSlowEffect = fx.getEffects(node.entity.id).some((e) => e.blueprint.name === '驻守减速');
  T('①-驻守小兵在场时，据点自己身上真的挂了一条可见的"驻守减速"效果（不再是完全无感的暗改）',
    hasSlowEffect);

  blueDefender.pos.x = node.entity.pos.x + 99999;
  window.gameTime += 2; fx.update(2); ds.update(0.001);
  const stillHasSlowEffect = fx.getEffects(node.entity.id).some((e) => e.blueprint.name === '驻守减速');
  T('②-驻守小兵离开之后，这条效果会自然消失（aura 的宽限期到期，不是永久挂着骗玩家）',
    !stillHasSlowEffect);
}

// ==================== 十九c、占领后的攻击力提升必须在状态栏可见（用户追加返工）====================
{
  const { ents, fx, attr, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');

  ds._setOwner(node, FACTIONS.BLUE, FULL);
  const buffEffect = fx.getEffects(node.entity.id).find((e) => e.blueprint.name === '据点占领增益');
  T('①-占领之后据点身上挂了一条可见的"据点占领增益"效果（不再是静默改 baseStats）',
    !!buffEffect && buffEffect.blueprint.statKey === 'attackDamage');

  const tpl = C.templates.tower;
  const expectedTotal = tpl.attackDamage * (DCFG.pointDamagePct / 100);
  const stats = attr.calc(node.entity, fx.getEffects(node.entity.id));
  T('②-基线(中立值)+这条效果的加成 = 跟改动前完全一样的占领后总攻击力（数值不变，只是拆开了）',
    Math.abs(stats.attackDamage - expectedTotal) < 1e-6);

  ds._setOwner(node, FACTIONS.NEUTRAL, 0);
  const buffAfterNeutral = fx.getEffects(node.entity.id).find((e) => e.blueprint.name === '据点占领增益');
  T('③-翻转回中立之后，这条效果被显式移除（不是永久挂着）', !buffAfterNeutral);
}

// ==================== 二十、中立据点优先攻击正在占领它的单位 ====================
// 用户定稿："中立据点会优先攻击正在占领该据点的阵营的单位"。
{
  const { ents, fx, combat, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.setEffectRegistry(fx);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const node = ds.nodes.find(n => n.kind === 'point');

  // 旁观者：离据点更近，但没有在占领它（targetId 没有指向这个据点）——
  // 纯按距离排的话应该是它赢，用它来反证"确实是优先级规则在起作用，不是
  // 巧合按距离也选中了同一个"。
  const bystander = mkEntity(ents, 'melee', {
    faction: FACTIONS.RED,
    pos: { x: node.entity.pos.x + 5, y: node.entity.pos.y },
    stats: { maxHP: 100000 },
  }, C);
  // 占领者：离据点更远，但正在占领它（targetId 指向据点）。
  const capturer = mkEntity(ents, 'melee', {
    faction: FACTIONS.RED,
    pos: { x: node.entity.pos.x + 50, y: node.entity.pos.y },
    stats: { maxHP: 100000 },
  }, C);
  capturer.targetId = node.entity.id;

  window.gameTime = 0;
  combat.update(0.1);
  T('①-中立据点优先锁定正在占领它的单位，不是纯按距离选中更近的旁观者',
    node.entity.targetId === capturer.id);
}

// ==================== 二十一、居中顶部水晶枢纽血量条：源码接线核对 ====================
// 用户定稿"在主窗口上方新增居中小条，上面显示红蓝方水晶枢纽的血量（加进度条，
// 并且某方水晶枢纽扣血时在进度条上显示特效）"——纯 DOM/渲染层的行为，这套
// 测试脚手架没有真实 DOM，钉不住"画面上到底显示成什么样"，能钉住的是"该接的
// 线都接了"：HTML 里有这些元素、UIManager 按 dominionSystem.active 切显隐、
// 读的是 nexus_main 的 currentHP/maxHP、掉血时真的会给轨道补一个 class。
{
  const htmlSrc = srcRaw('index.html');
  T('①-HTML 里有这条居中血量条本身，默认是隐藏的（只在统治战场地图上才显示）',
    /id="dominionNexusBar"[\s\S]{0,60}style="display:none;"/.test(htmlSrc));
  T('②-蓝/红两侧的血量文字节点都在', /id="dnbHpBlue"/.test(htmlSrc) && /id="dnbHpRed"/.test(htmlSrc));
  T('③-蓝/红两侧的进度条填充节点都在', /id="dnbFillBlue"/.test(htmlSrc) && /id="dnbFillRed"/.test(htmlSrc));
  T('④-掉血特效挂在轨道节点上（.dnb-flash 的 keyframes 确实存在）',
    /id="dnbTrackBlue"/.test(htmlSrc) && /id="dnbTrackRed"/.test(htmlSrc) && /@keyframes dnbFlash/.test(htmlSrc));

  const uiSrc = srcOf('src/ui/UIManager.js');
  T('⑤-UIManager 按 dominionSystem.active 切换这条血量条的显隐（不是无条件常显）',
    /dominionNexusBar[\s\S]{0,400}dom\.active/.test(uiSrc));
  T('⑥-读的是水晶枢纽(nexus_main)的血量，不是别的塔层级',
    /nexus_main[\s\S]{0,200}_mapFaction === 'blue'/.test(uiSrc));
  T('⑦-掉血时会给对应轨道节点补一个 class（用户定稿的"显示特效"落地成这一步）',
    /hp < prevHp[\s\S]{0,400}classList\.add\('dnb-flash'\)/.test(uiSrc));

  // 2026-09-26 追加两条用户返工：
  //   Q5-文字格式："文字不要为XXX/YYY，仅保留XXX（当前血量）"；
  //   Q6-减少特效："每减少1进度，就从当前进度的位置往后划一个圆点到进度为0的
  //      地方，代表进度减少，减少得快就加快小点的滑动速度"。
  T('⑧-血量文字只显示当前值，不再拼 "当前/上限"（不能匹配旧的 hp/max 写法）',
    /_setText\(hpId, `\$\{hp\}`\)/.test(uiSrc) && !/_setText\(hpId, `\$\{hp\}\/\$\{max\}`\)/.test(uiSrc));
  T('⑨-掉血时会生成一个"减少点"（.dnb-dot），不是只有轨道闪烁',
    /spawnDrainDot/.test(uiSrc) && /dnb-dot/.test(uiSrc));
  T('⑩-减少点的滑动时长跟掉血量挂钩（掉得越多滑得越快），不是写死一个固定时长',
    /DOT_BASE_MS\s*\/\s*Math\.sqrt\(delta\)/.test(uiSrc));
  T('⑪-CSS 里真的定义了 .dnb-dot 这个点的样式（不是只在 JS 里造了个没有外观的节点）',
    /\.dnb-dot\s*\{/.test(htmlSrc));
}

// ==================== 二十二：水晶之痕光环——所有单位伤害增幅+33% ====================
// 用户定稿："新增地图级光环，水晶之痕光环——所有单位伤害增幅+33%"。跟扭曲丛林/
// 嚎哭深渊冰封版同一套 MapSystem._applyGlobalAura 机制（那套通用机制本身已经
// 在 sim_globalaura.mjs 和 sim_v51.mjs 里覆盖过），这里只验证【这张图】的
// 声明值真的接上了，做法照抄 sim_v51.mjs 里"光①~光④"那组断言的模式。
{
  const { ents, fx, attr, CONFIG: C } = await makeWorld();
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const ms = new MapSystem(ents, new EventBus());
  ms.setEffectRegistry(fx);
  ms.loadMap('dominion_crystal_scar_v1');
  const unit = mkEntity(ents, 'melee', {}, C);
  ms.update(1);
  const stats = attr.calc(unit, fx.getEffects(unit.id));
  T('①-水晶之痕光环：所有单位伤害增幅+33%（真接上了 damageAmpPct，不是只停在地图数据里没人读）',
    Math.abs(stats.damageAmpPct - 33) < 1e-6);

  const tower = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE }, C);
  ms.update(1);
  const towerStats = attr.calc(tower, fx.getEffects(tower.id));
  T('②-光环真的对塔也生效（用户口径"所有单位"含防御塔，跟其它两张图的既有先例一致）',
    Math.abs(towerStats.damageAmpPct - 33) < 1e-6);
}

// ==================== 二十三、水晶枢纽低血量额外超级兵 ====================
// 用户定稿："若某阵营水晶枢纽生命值低于75，则该阵营每2次出兵额外生成一个超级兵"。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  ds.createMinion = () => {};
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  // DominionSystem 自己只建 kind:'point' 那些据点实体（initMap 头注写得很明白：
  // "kind:'base' 的两个节点复用地图 buildings 数组里已经建好的 nexus_main 水晶
  // 实体"）——水晶枢纽的建造是 MapSystem 走 map.buildings 那条常规建塔路径，
  // 这份轻量测试脚手架没有跑那条路径，得跟第九节一样自己手搭一个。
  const blueNexus = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 750 } }, C);

  let superCount = 0;
  ds.createMinion = (type) => { if (type === 'super') superCount++; };
  window.gameTime = 0;
  const interval = DCFG.waveInterval ?? 20;
  const bonusEvery = Math.max(1, DCFG.bonusWaveEvery ?? 1);
  const wavesNeeded = 8 * bonusEvery; // 跑够多波，覆盖至少 8 次这个水晶枢纽自己的出兵
  for (let i = 0; i < wavesNeeded; i++) { window.gameTime += interval; ds.update(interval); }
  T('①-血量充足时，正常出兵不会带超级兵（先测出基准，确认下面的差异不是巧合）',
    superCount === 0);

  blueNexus.currentHP = (DCFG.lowHpNexusThreshold ?? 75) - 1; // 打到阈值以下
  superCount = 0;
  for (let i = 0; i < wavesNeeded; i++) { window.gameTime += interval; ds.update(interval); }
  T('②-血量低于阈值后，蓝方每 lowHpNexusBonusEvery 次出兵确实多出一个超级兵',
    superCount === Math.floor(8 / (DCFG.lowHpNexusBonusEvery ?? 2)));

  T('③-lowHpNexusThreshold/lowHpNexusBonusEvery 定稿为 75/2（用户给的具体数字，不是起草值）',
    DCFG.lowHpNexusThreshold === 75 && DCFG.lowHpNexusBonusEvery === 2);
}

// ==================== 二十四、水晶枢纽热寂：30分钟后每秒固定掉0.5血，防止僵局 ====================
// 用户定稿："为了防止僵局，在30分钟后所有阵营的水晶枢纽每秒减少0.5生命值
// （状态——热寂）"——固定量，不随据点数差变化，双方无条件各扣一份。
{
  const { ents, CONFIG: C } = await makeWorld();
  const bus = { emit() {}, on() {} };
  const ds = new DominionSystem(ents, bus);
  const map = MAPS['dominion_crystal_scar_v1'];
  ds.initMap(map);
  const blueNexus = mkEntity(ents, 'tower', { faction: FACTIONS.BLUE, tier: 'nexus_main', stats: { maxHP: 750 } }, C);
  const redNexus = mkEntity(ents, 'tower', { faction: FACTIONS.RED, tier: 'nexus_main', stats: { maxHP: 750 } }, C);
  const hpBefore = blueNexus.currentHP;

  window.gameTime = 60 * (DCFG.nexusHeatDeathTriggerAtMin ?? 30) - 5; // 触发前 5 秒
  ds.update(1);
  T('①-触发时间点之前，双方水晶枢纽不受这条掉血影响（据点数量相同，双方也没有据点差掉血）',
    blueNexus.currentHP === hpBefore && redNexus.currentHP === hpBefore);

  window.gameTime += 10; // 跨过触发点
  ds.update(1);
  const expected = hpBefore - (DCFG.nexusHeatDeathDrainPerSec ?? 0.5) * 1;
  T('②-触发时间点之后，双方（据点数量仍然相同）都按固定速率掉血（不是只掉落后方那一份）',
    Math.abs(blueNexus.currentHP - expected) < 1e-6 && Math.abs(redNexus.currentHP - expected) < 1e-6);

  T('③-触发时间点/掉血速率定稿为 30分钟 / 0.5每秒（用户给的具体数字，不是起草值）',
    DCFG.nexusHeatDeathTriggerAtMin === 30 && DCFG.nexusHeatDeathDrainPerSec === 0.5);
}

done();
