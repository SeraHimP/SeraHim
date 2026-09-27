/**
 * simulation.js —— 游戏仿真的唯一装配点与唯一步进顺序。
 *
 * 游戏（main.js）、平衡工具（tools/balance_*.mjs）、全栈测试都从这里拿同一套系统、
 * 同一套接线、同一个 step()。以前 main.js 有一份 stepSimulation，平衡工具各自手抄了
 * 一份更新顺序，而且抄漏了：没有 ManaSystem（主动技能永远不施放）、WeatherSystem、
 * DragonSystem、LaneAvengerSystem、GroundTraceSystem，balance_matrix 甚至没有
 * DominionSystem——平衡结论是在另一个游戏里得出的。
 *
 * 这里只放"影响对局结果"的东西：系统、工厂、地图切换时的仿真状态重置。
 * 界面日志、计分板、渲染、按钮都留在 main.js。
 */
import { EntityContainer } from './core/EntityContainer.js';
import { CTX } from './core/GameContext.js';
import { EffectRegistry } from './core/EffectRegistry.js';
import { SkillLibrary } from './core/SkillLibrary.js';
import { AttributeCalculator } from './core/AttributeCalculator.js';
import { createFactories } from './core/factories.js';
import { EventBus } from './utils/EventBus.js';
import { CONFIG } from './data/Config.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { ProjectileSystem } from './systems/ProjectileSystem.js';
import { BuffSystem } from './systems/BuffSystem.js';
import { ManaSystem } from './systems/ManaSystem.js';
import { DragonSystem } from './systems/DragonSystem.js';
import { MapSystem } from './systems/MapSystem.js';
import { WeatherSystem } from './systems/WeatherSystem.js';
import { WorldState } from './systems/WorldState.js';
import { LaneMovementSystem } from './systems/LaneMovementSystem.js';
import { GroundTraceSystem } from './systems/GroundTraceSystem.js';
import { FacingSystem, setWeatherSystem as setFacingWeatherSystem } from './systems/FacingSystem.js';
import { LaneWaveSystem } from './systems/LaneWaveSystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { LaneAvengerSystem } from './systems/LaneAvengerSystem.js';
import { DominionSystem } from './systems/DominionSystem.js';

/** 固定仿真步长（30Hz）。 */
export const SIM_DT = 1 / 30;

/**
 * @param {{ log?: (msg:string, kind?:string) => void }} [opts]
 *   log：工厂在建塔/出兵/刷龙时打的日志。游戏里接 UIManager，工具里可以不传。
 */
export function createSimulation({ log = () => {} } = {}) {
  const eventBus = new EventBus();
  const entityContainer = new EntityContainer();
  const effectRegistry = new EffectRegistry(eventBus);
  const skillLibrary = SkillLibrary;
  const attrCalc = AttributeCalculator;

  const combatSystem = new CombatSystem(entityContainer, effectRegistry, eventBus, skillLibrary);
  const projectileSystem = new ProjectileSystem(entityContainer, eventBus, combatSystem);
  combatSystem.setProjectileSystem(projectileSystem);
  const buffSystem = new BuffSystem(effectRegistry, entityContainer, eventBus, combatSystem);
  // 技能增幅与韧性要在 EffectRegistry.apply() 里现读施法者/受术者的属性表。
  effectRegistry.setStatSource(entityContainer, attrCalc);
  const dragonSystem = new DragonSystem(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc);
  // 资源条 + 主动技能施放（没装"主动"类技能的单位法力恒为 0）。
  const manaSystem = new ManaSystem(entityContainer, effectRegistry, eventBus, skillLibrary, attrCalc, combatSystem);
  const mapSystem = new MapSystem(entityContainer, eventBus);
  mapSystem.setEffectRegistry(effectRegistry);
  const weatherSystem = new WeatherSystem(eventBus);
  attrCalc.setWeatherSystem(weatherSystem);
  setFacingWeatherSystem(weatherSystem);
  const worldState = new WorldState({ weather: weatherSystem, dragons: dragonSystem, entities: entityContainer, bus: eventBus });
  attrCalc.setWorldState(worldState);
  const laneMovementSystem = new LaneMovementSystem(entityContainer, effectRegistry, attrCalc, combatSystem, mapSystem, weatherSystem);
  const groundTraceSystem = new GroundTraceSystem(entityContainer, effectRegistry, mapSystem, weatherSystem);
  const laneWaveSystem = new LaneWaveSystem(entityContainer, eventBus, mapSystem);
  laneWaveSystem.setBroadcastDeps({ effectRegistry, attrCalc, combat: combatSystem, dragonSystem, worldState });
  const collisionSystem = new CollisionSystem(entityContainer, mapSystem);
  // 朝向排在移动之后（用最新位置转），攻击门读的是上一帧的朝向。
  const facingSystem = new FacingSystem(entityContainer);
  const laneAvengerSystem = new LaneAvengerSystem(entityContainer, effectRegistry, eventBus, mapSystem);
  // 统治战场：普通地图（无 map.dominionNodes）下 active=false，update() 直接早退。
  const dominionSystem = new DominionSystem(entityContainer, eventBus);
  dominionSystem.setEffectRegistry(effectRegistry);

  const factories = createFactories({
    entityContainer, effectRegistry, eventBus, skillLibrary, attrCalc, mapSystem, dragonSystem,
    uiManager: { log },
  });
  const { createMinion, createBuilding, createDragon } = factories;
  mapSystem.setCreateBuildingFn(createBuilding);
  dragonSystem.setCreateEntity(createDragon);
  // 注入而不是 import MAPS：自制地图存在 MapSystem 那边。
  dragonSystem.setMapLookup((id) => mapSystem.getMapById?.(id) || null);
  // 龙的「宿怨」被动在 CombatSystem 里结算，击杀数由 DragonSystem 灌过去。
  dragonSystem.setCombatSystem(combatSystem);

  /** 对战小兵成长：CONFIG.battleGrowth 基表 → map.minionGrowth 覆写（按兵种浅合并），纯固定值/波。 */
  function battleGrowthFlat(type) {
    const n = Math.max(0, (laneWaveSystem.waveNumber || 1) - 1); // 第 1 波为基准无成长
    const G = CONFIG.battleGrowth || {};
    const mapG = mapSystem.currentMap?.minionGrowth?.[type] || {};
    const f = { ...(G._default || {}), ...(G[type] || {}), ...mapG };
    return { hp: (f.hp || 0) * n, ad: (f.ad || 0) * n, res: (f.res || 0) * n, ap: (f.ap || 0) * n };
  }
  laneWaveSystem.setCreateMinion((type, x, y, faction, laneId, direction) =>
    createMinion(type, x, y, 1, 1, {
      faction, laneId, direction, growthFlat: battleGrowthFlat(type),
      templateOverride: mapSystem.currentMap?.minionTemplates?.[type],
    }));
  // 唤灵兵召唤幻灵：不带波次成长，不挂路（幻灵不推线）。
  combatSystem.setCreateMinion((type, x, y, faction, hpScale, attrScale) =>
    createMinion(type, x, y, hpScale, attrScale, { faction }));
  // 水晶之痕出兵：据点有自己的出兵节奏，不挂 laneWaveSystem 的成长曲线。
  dominionSystem.setCreateMinion((type, x, y, faction, laneId, direction) =>
    createMinion(type, x, y, 1, 1, { faction, laneId, direction }));

  // ⚠️ 时钟必须在【建筑创建之前】归零（map:loading，不是 map:loaded）：塔成长被动
  // 在 onEquip 里记 t0 = gameTime，建筑是在 loadMap 中段创建的。
  eventBus.on('map:loading', () => {
    CTX.gameTime = 0;
    CTX.waveNumber = 0;
    CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
    // 上一张图飞行中的子弹/光束不能带到新图上。
    projectileSystem.projectiles.length = 0;
    projectileSystem.beams.clear();
    dominionSystem.reset();
  });
  eventBus.on('map:loaded', () => {
    dominionSystem.initMap(mapSystem.currentMap); // 无 dominionNodes 的地图上是空操作
    weatherSystem.reset();      // 每次载图重新随机：起始权重、变化快慢
    groundTraceSystem.reset();  // 上一局的水洼/雪盖不带到新的一局
    CTX.gameTime = 0;           // 幂等重置，兜住"有人直接 emit map:loaded"的路径
    CTX.waveNumber = 0;
    CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
    laneWaveSystem.waveNumber = 0;
    laneWaveSystem._mapWaveApplied = undefined;
    laneWaveSystem._clock = 0;
    laneWaveSystem._spawnQueue.length = 0;
    laneWaveSystem.nextWaveTime = 30; // 下一次 update 会按地图配置覆盖
  });

  /** 推进一个仿真步。游戏循环、平衡工具、测试共用这一个顺序。 */
  function step(dt = SIM_DT) {
    // 每步都要让属性缓存失效并重建空间网格——位置/效果在步进中变化。
    attrCalc.tick();
    entityContainer.rebuildGridIfNeeded(attrCalc._frame);
    CTX.gameTime += dt;
    effectRegistry.update(dt);
    buffSystem.update(dt);
    dragonSystem.update(dt);
    combatSystem.update(dt);
    manaSystem.update(dt);
    weatherSystem.update(dt);
    worldState.update(dt, CTX.gameTime);
    mapSystem.update(dt);
    laneWaveSystem.update(dt);
    dominionSystem.update(dt);
    laneMovementSystem.update(dt);
    collisionSystem.update(dt);
    facingSystem.update(dt);
    laneAvengerSystem.update(dt);
    groundTraceSystem.update(dt);
    projectileSystem.update(dt);
  }

  return {
    eventBus, entityContainer, effectRegistry, skillLibrary, attrCalc,
    combatSystem, projectileSystem, buffSystem, dragonSystem, manaSystem, mapSystem,
    weatherSystem, worldState, laneMovementSystem, groundTraceSystem, laneWaveSystem,
    collisionSystem, facingSystem, laneAvengerSystem, dominionSystem,
    factories, battleGrowthFlat, step,
  };
}
