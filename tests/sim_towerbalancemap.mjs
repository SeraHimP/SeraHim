/**
 * sim_towerbalancemap.mjs —— 防御塔强度测试场（tower_balance_test_v1）验收
 *
 * 这张图本身不含任何"进攻方增益/防守方武器覆写"逻辑——那些都是配套的
 * tools/balance_tower.mjs 在跑起来之后按局施加的（见 tower_balance_test.js
 * 头注）。这里只钉地图文件本身该成立的东西：注册正确、结构对称、能被
 * MapSystem 正常加载并跑起来、weapon 字段是能被 equipSkill 正确解析的占位值。
 * 通用几何约束（塔间距/射程不重叠等）已经在 sim_maps.mjs 里对全部注册地图
 * 统一跑过，这里不重复。
 */
import { setupWindow, scoreboard, makeWorld } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('防御塔强度测试场（tower_balance_test_v1）验收');

// ==================== 一、注册 + 基本字段 ====================
{
  const { MAPS } = await import('../src/data/maps/index.js');
  const { tower_balance_test } = await import('../src/data/maps/tower_balance_test.js');
  T('注①-tower_balance_test_v1 已注册进 MAPS', MAPS['tower_balance_test_v1'] === tower_balance_test);
  T('注②-声明了 world/factions/lanes/buildings 这些必需字段',
    !!tower_balance_test.world && Array.isArray(tower_balance_test.factions)
    && Array.isArray(tower_balance_test.lanes) && Array.isArray(tower_balance_test.buildings));
  T('注③-只有一条路（单路走廊模型，跟 demo_stylized 同款，不追求野区复杂度）',
    tower_balance_test.lanes.length === 1);
}

// ==================== 二、双方对称：塔的层级构成、数量完全一致 ====================
{
  const { tower_balance_test: m } = await import('../src/data/maps/tower_balance_test.js');
  const blueTiers = m.buildings.filter(b => b.faction === 'blue').map(b => b.tier).sort();
  const redTiers = m.buildings.filter(b => b.faction === 'red').map(b => b.tier).sort();
  T('对称①-蓝红双方塔的层级构成完全一致（对照测试要求双方结构对称，差异只能来自覆写，不能来自地图本身）',
    JSON.stringify(blueTiers) === JSON.stringify(redTiers));
  T('对称②-每方都有 outer/base/hq_tower(×2)/nexus_lane/nexus_main 这条完整推进链',
    blueTiers.filter(t => t === 'hq_tower').length === 2
    && ['outer', 'base', 'nexus_lane', 'nexus_main'].every(t => blueTiers.includes(t)));

  // 位置也要真镜像（x 关于世界中轴对称，y 相同）——不是"层级凑对但位置乱摆"。
  const W = m.world.w;
  const byTierFaction = (fac, tier, idx = 0) =>
    m.buildings.filter(b => b.faction === fac && b.tier === tier)[idx];
  for (const tier of ['outer', 'base', 'nexus_lane', 'nexus_main']) {
    const b = byTierFaction('blue', tier), r = byTierFaction('red', tier);
    T(`对称③-${tier} 蓝红位置关于地图中轴镜像`,
      Math.abs((b.pos.x + r.pos.x) - W) < 1e-6 && b.pos.y === r.pos.y);
  }
}

// ==================== 三、weapon 占位值能被正常解析装配（不是非法字符串） ====================
{
  const w = await makeWorld();
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { DragonSystem } = await import('../src/systems/DragonSystem.js');
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(w.fx);
  const ds = new DragonSystem(ents, bus, w.fx, w.SkillLibrary, w.attr);
  // 直接用真实工厂链路（与 sim_maps.mjs 里其它地图的装配验证同一套做法）——
  // 复用 _harness.mjs 的 makeWorld 拿到的 attr/SkillLibrary，走 loadMap 实跑一遍。
  const { createFactories } = await import('../src/core/factories.js');
  const F = createFactories({
    entityContainer: ents, effectRegistry: w.fx, eventBus: bus,
    skillLibrary: w.SkillLibrary, attrCalc: w.attr, mapSystem: ms, dragonSystem: ds,
    uiManager: { log() {} },
  });
  ms.setCreateBuildingFn((opt) => F.createBuilding(opt));
  ms.loadMap('tower_balance_test_v1');

  const towers = ents.getAllTowers(true);
  T('装配①-地图加载后场上出现了塔（builtin buildings 正确落地）', towers.length === 12);
  const outerBlue = towers.find(t => t._mapFaction === 'blue' && t._mapTier === 'outer');
  T('装配②-weapon:"piercing" 占位值被正确装成 weapon_piercing 技能实例',
    !!outerBlue && (outerBlue._skillInstances || []).some(s => s.skillId === 'weapon_piercing'));
  const nexusBlue = towers.find(t => t._mapFaction === 'blue' && t._mapTier === 'nexus_main');
  T('装配③-weapon:null 的水晶枢纽没有被装上任何 weapon_* 技能',
    !!nexusBlue && !(nexusBlue._skillInstances || []).some(s => s.skillId?.startsWith('weapon_')));
}

done();
