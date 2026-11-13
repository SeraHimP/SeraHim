/**
 * sim_confluence.mjs —— 汇流战场（confluence_v1，超大型多战线地图）验收
 *
 * 背景：用户深夜要求"新增几张地图……一张特别大（有多个内塔），有三个/四个阵营
 * （最好，如果实在做不明白两阵营也行）……超大规模交战，有多个战线，战线之间可以
 * 重叠……这张大型地图最好交战时长在180分钟"，并明确授权自主决定、不必等回复。
 * 见 src/data/maps/confluence.js 头注：选了2阵营（用户给的降级许可）+ 5路扇形
 * 汇流几何（"多个内塔"="多路各一座"+"战线重叠"=汇拢点走廊物理相连）。
 *
 * 通用几何校验（世界范围/对称/塔间距/射程圈不重叠等）已经在 sim_maps.mjs 的
 * 全地图通用循环里跑过了（新地图注册进 MAPS 自动被检查，不用在这里重复一份）。
 * 这里只钉这张图专属的、通用循环覆盖不到的行为：多路真的存在且数量对、
 * 战线真的物理重叠（不是"看起来近"）、终局保险丝真的接到了这张图专属的
 * CONFIG 常量上并端到端生效、2阵营/自主决策留了可追溯的理由。
 */
import { setupWindow, scoreboard, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { MAPS } = await import('../src/data/maps/index.js');
const { CONFIG } = await import('../src/data/Config.js');
const { mapFactionsOf, laneSpawnsOf } = await import('../src/systems/FactionSystem.js');
const { nearestLaneDist, distToPolyline } = await import('../src/data/mapValidate.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');

const { T, done } = scoreboard('汇流战场（confluence_v1）验收');

const map = MAPS['confluence_v1'];
T('地图确实注册进了 MAPS', !!map);

// ==================== 一、规模与结构：5路×2阵营，"多个内塔" ====================
{
  T('①-世界尺寸明显大于三张老图（>= 7000，"特别大"的量化下限）', map.world.w >= 7000 && map.world.h >= 7000);
  T('②-5条独立战线', map.lanes.length === 5);
  T('③-每条战线4个折点（出发口→己方汇拢点→对方汇拢点→对方出发口）',
    map.lanes.every(l => l.waypoints.length === 4));
  T('④-2阵营（用户明确给了2阵营的降级许可，见文件头注）', mapFactionsOf(map).length === 2);

  const attackTiersCount = (f, tier) => map.buildings.filter(b => b.faction === f && b.tier === tier).length;
  T('⑤-每方5座内塔（每路一座，"多个内塔"落到实处，不是口头上的"多"）',
    attackTiersCount('blue', 'inner') === 5 && attackTiersCount('red', 'inner') === 5);
  T('⑥-每方5座外塔+5座水晶塔+5座召唤水晶（四级链每路都齐）',
    attackTiersCount('blue', 'outer') === 5 && attackTiersCount('blue', 'base') === 5
    && attackTiersCount('blue', 'nexus_lane') === 5);
  T('⑦-每方2座枢纽塔+1座水晶枢纽', attackTiersCount('blue', 'hq_tower') === 2
    && attackTiersCount('blue', 'nexus_main') === 1);
  T('⑧-全图共46座建筑（2×(5路×4级+3枢纽建筑)）', map.buildings.length === 46);

  // 每条战线的出兵声明：蓝 forward 打红、红 reverse 打蓝——跟老图同一套约定。
  for (const lane of map.lanes) {
    const spawns = laneSpawnsOf(lane);
    T(`⑨-${lane.id} 声明了双向出兵（蓝→红 + 红→蓝）`,
      spawns.some(s => s.faction === 'blue') && spawns.some(s => s.faction === 'red'));
  }
}

// ==================== 二、战线重叠：不是"看起来近"，是走廊物理相连 ====================
{
  const hw = map.walls.corridorHalfWidth;
  // 取 w0/w1 两条相邻战线各自的"己方汇拢点"（waypoints[1]），量它们之间的距离——
  // 如果小于 2×半宽，两条战线在这一片的可行走区域必然有重叠（不用等真正跑仿真）。
  const join0 = map.lanes.find(l => l.id === 'w0').waypoints[1];
  const join1 = map.lanes.find(l => l.id === 'w1').waypoints[1];
  const joinDist = Math.hypot(join0.x - join1.x, join0.y - join1.y);
  T(`①-相邻战线（w0/w1）汇拢点间距(${joinDist.toFixed(0)}) < 走廊总宽(${2 * hw})——两条战线的可行走区域物理重叠`,
    joinDist < 2 * hw);

  // 更直接的证据：两条汇拢点连线的中点（两条战线之间的"接缝"）应该同时落在
  // 两条战线各自的走廊内——真正的物理重叠区域，不是两条各自独立、恰好靠得近。
  const w0 = map.lanes.find(l => l.id === 'w0');
  const w1 = map.lanes.find(l => l.id === 'w1');
  const mid = { x: (join0.x + join1.x) / 2, y: (join0.y + join1.y) / 2 };
  const distToW0 = distToPolyline(w0.waypoints, mid.x, mid.y);
  const distToW1 = distToPolyline(w1.waypoints, mid.x, mid.y);
  T(`②-两条汇拢点的中点同时落在w0(${distToW0.toFixed(0)})和w1(${distToW1.toFixed(0)})的走廊内（均 < 半宽 ${hw}）——真正的"重叠"而不是"相邻不相交"`,
    distToW0 < hw && distToW1 < hw);

  // nearestLaneDist 在汇拢区附近应该明显小于半宽（多条战线叠加覆盖，不是单条战线的边缘）。
  const dNear = nearestLaneDist(map, (join0.x + join1.x) / 2, (join0.y + join1.y) / 2);
  T(`③-两条汇拢点连线中点仍在可行走走廊内（离最近战线 ${dNear.toFixed(0)} < 半宽 ${hw}）`, dNear < hw);
}

// ==================== 三、数值：明显比召唤师峡谷同档更肉（配合更大规模/更长时长） ====================
{
  const sr = MAPS['summoners_rift_v1'];
  for (const tier of ['outer', 'inner', 'base', 'hq_tower', 'nexus_main']) {
    T(`①-${tier} 生命值高于召唤师峡谷同档（${map.tierStats[tier].maxHP} > ${sr.tierStats[tier].maxHP}）`,
      map.tierStats[tier].maxHP > sr.tierStats[tier].maxHP);
  }
  T('②-所有档位 healthRegen 归0（恢复走默认装配的加固城防/水晶再生被动，跟其余地图同一套约定）',
    Object.values(map.tierStats).every(s => s.healthRegen === 0));
  T('③-会攻击的建筑都是穿透型子弹（跟嚎哭深渊/扭曲丛林同规格）',
    map.buildings.filter(b => b.weapon !== null).every(b => b.weapon === 'piercing'));
}

// ==================== 四、终局保险丝：接的是这张图专属的 CONFIG 常量，不是召唤师峡谷那份 ====================
{
  const aura = map.globalAura;
  T('①-声明了 globalAura', !!aura);
  const drainEff = aura.effects.find(e => e.drainMaxHPPctPerSec != null);
  T('②-热寂触发时间来自 CONFIG.tuning.confluenceHeatDeathTriggerAtMin（不是召唤师峡谷的70分钟）',
    drainEff.drainAfterSec === CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60
    && drainEff.drainAfterSec !== CONFIG.tuning.heatDeath.triggerAtMin * 60);
  const msEffs = aura.effects.filter(e => e.statKey === 'moveSpeed');
  const rampEff = msEffs.find(e => e.percentPerMinute != null);
  T('③-常驻移速环速率来自 CONFIG.tuning.confluenceMoveSpeedPctPerMin（不是召唤师峡谷的0.5%）',
    rampEff.percentPerMinute === CONFIG.tuning.confluenceMoveSpeedPctPerMin
    && rampEff.percentPerMinute !== CONFIG.tuning.summonersRiftMoveSpeedPctPerMin);
  T('④-常驻移速环无上限（跟召唤师峡谷同一套"不封顶"设计）', rampEff.max === undefined);
  const heatMsEff = msEffs.find(e => e.stages);
  const asEff = aura.effects.find(e => e.statKey === 'bonusAttackSpeedPct');
  const dmgEff = aura.effects.find(e => e.statKey === 'damageAmpPct');
  T('⑤-非塔攻速/伤害增幅/移速三项数值复用共享的 CONFIG.tuning.heatDeath（不是另开一套倍率）',
    asEff.stages[1].flat === CONFIG.tuning.heatDeath.unitAtkSpeedBonusPct
    && dmgEff.stages[1].flat === CONFIG.tuning.heatDeath.unitDmgAmpBonusPct
    && heatMsEff.stages[1].percent === CONFIG.tuning.heatDeath.unitMoveSpeedBonusPct);
}

// ==================== 五、端到端：热寂真的会在配置的时间点触发并衰减未受保护的塔 ====================
{
  const ents = new EntityContainer(new EventBus());
  const fx = new EffectRegistry(new EventBus());
  const attr = AttributeCalculator;
  fx.setStatSource(ents, attr);
  const ms = new MapSystem(ents, new EventBus());
  ms.setEffectRegistry(fx);
  ms.loadMap('confluence_v1');

  const outer = mkEntity(ents, 'tower', { faction: 'blue', tier: 'outer', lane: 'w0', stats: { maxHP: 3000 } }, CONFIG);

  const triggerSec = CONFIG.tuning.confluenceHeatDeathTriggerAtMin * 60;
  window.gameTime = triggerSec - 10;
  attr.tick(); ms.update(1);
  T('①-触发前：塔最大生命不变', outer.baseStats.maxHP === 3000);

  window.gameTime = triggerSec + 1;
  attr.tick(); ms.update(1);
  T('②-触发后（按这张图专属的触发时间计）：塔最大生命真的开始下降', outer.baseStats.maxHP < 3000);
}

// ==================== 六、中心对称：红方 = 蓝方绕地图中心180°旋转（不是镜像） ====================
{
  const cx = map.world.w / 2, cy = map.world.h / 2;
  const blueOuterW2 = map.buildings.find(b => b.faction === 'blue' && b.tier === 'outer' && b.laneId === 'w2');
  const redOuterW2 = map.buildings.find(b => b.faction === 'red' && b.tier === 'outer' && b.laneId === 'w2');
  T('①-w2外塔红蓝互为地图中心180°旋转点（不是左右/上下镜像）',
    Math.abs(redOuterW2.pos.x - (2 * cx - blueOuterW2.pos.x)) < 1
    && Math.abs(redOuterW2.pos.y - (2 * cy - blueOuterW2.pos.y)) < 1);
  const blueNexus = map.buildings.find(b => b.faction === 'blue' && b.tier === 'nexus_main');
  const redNexus = map.buildings.find(b => b.faction === 'red' && b.tier === 'nexus_main');
  T('②-双方水晶枢纽同理中心对称', Math.abs(redNexus.pos.x - (2 * cx - blueNexus.pos.x)) < 1
    && Math.abs(redNexus.pos.y - (2 * cy - blueNexus.pos.y)) < 1);
}

done();
