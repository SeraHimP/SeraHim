import { EntityContainer } from './core/EntityContainer.js';
import { CTX } from './core/GameContext.js';
import { EffectRegistry } from './core/EffectRegistry.js';
import { SkillLibrary } from './core/SkillLibrary.js';
import { AttributeCalculator } from './core/AttributeCalculator.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { ProjectileSystem } from './systems/ProjectileSystem.js';
import { BuffSystem } from './systems/BuffSystem.js';
import { ManaSystem } from './systems/ManaSystem.js';
import { DragonSystem, DRAGON_ELEMENTS } from './systems/DragonSystem.js';
import { MapSystem } from './systems/MapSystem.js';
import { WeatherSystem } from './systems/WeatherSystem.js';
import { WorldState } from './systems/WorldState.js';
import { WeatherPanel } from './ui/WeatherPanel.js';
import { LaneMovementSystem } from './systems/LaneMovementSystem.js';
import { FacingSystem } from './systems/FacingSystem.js';
import { LaneWaveSystem } from './systems/LaneWaveSystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { LaneAvengerSystem } from './systems/LaneAvengerSystem.js';
import { FACTIONS, canTarget } from './systems/FactionSystem.js';
import { ThreeRenderer } from './presentation/ThreeRenderer.js';
import { ThreeCameraController } from './presentation/ThreeCameraController.js';
import { dayNightAt, DAY_PERIOD, resolveDayPhase } from './presentation/DayNight.js';
import { EventBus } from './utils/EventBus.js';
import { equipSkill } from './core/skillParams.js';
import { createFactories, effectiveMaxHP } from './core/factories.js';
import { CONFIG } from './data/Config.js';
import { UIManager } from './ui/UIManager.js';
import { CanvasController } from './ui/CanvasController.js';
import { AttributeEditor } from './ui/AttributeEditor.js';
import { UnitAddDialog } from './ui/UnitAddDialog.js';
import { TOWER_MODEL_ROLES } from './data/towerModels.js';
import { SettingsDialog } from './ui/SettingsDialog.js';
import { ModeDialog } from './ui/ModeDialog.js';
import { DebugLogger } from './utils/DebugLogger.js';
import { syncAll as syncCustomContent } from './data/customContent.js';
import { WorldHud } from './ui/WorldHud.js';

CTX._uid = 0;
DebugLogger.hookConsole();
CTX.waveNumber = 0;
CTX.gameTime = 0;
CTX.gamePaused = false;
CTX.__gameSpeed = 1;    // 游戏速度倍率。v44 用户定稿：1x / 2x / 4x / 8x
// v44：__ffRemain（快进 N 秒）已删除 —— 它的作用被 1x/2x/4x/8x 倍率完全覆盖，
// 而它那套「每帧固定补 2 秒模拟时间」的预算正是卡顿的来源之一（见 gameLoop）。
CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
// ============================
//  Backward-compat bridge: expose CTX on window so all modules can access it.
//  Must be set BEFORE any module that reads window.CTX.* is loaded.
//  New code should import { CTX } from ./core/GameContext.js directly.
// ============================
window.CTX = CTX;



const eventBus = new EventBus();
const entityContainer = new EntityContainer();
const effectRegistry = new EffectRegistry(eventBus);
const skillLibrary = SkillLibrary;

// 自制内容（用户在编辑器里做出来的状态/技能/兵种）载入进引擎。
// 必须在装配阶段就做：自制技能要注册进 SkillLibrary、自制兵种要展开进
// CONFIG.templates，晚于建筑/出兵初始化就会出现"存档里有、这一局却没有"。
{
  const r = syncCustomContent();
  if (r.skills || r.minions || r.effects) {
    console.log(`[自制内容] 技能 ${r.skills} / 兵种 ${r.minions} / 状态 ${r.effects}`);
  }
  // 坏内容不静默丢弃：用户会以为自己的作品还在。
  for (const e of r.errors) console.warn('[自制内容] ' + e);
}
const attrCalc = AttributeCalculator;

const combatSystem = new CombatSystem(entityContainer, effectRegistry, eventBus, skillLibrary);
const projectileSystem = new ProjectileSystem(entityContainer, eventBus, combatSystem);
combatSystem.setProjectileSystem(projectileSystem);
const buffSystem = new BuffSystem(effectRegistry, entityContainer, eventBus, combatSystem);
// v51：技能增幅（自动生效）与韧性（缩短控制/减速）都要在 EffectRegistry.apply() 里
// 现读施法者/受术者的属性表，所以注入实体表 + 属性计算器——不注入时两条新逻辑整段短路。
effectRegistry.setStatSource(entityContainer, attrCalc);
const dragonSystem = new DragonSystem(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc);
// v51：单位资源条（法力/能量/充能）+ 主动技能施放。没有装备"主动"类技能的单位，
// 法力恒为 0（用户定稿），maxMana 填多少都不生效——见 ManaSystem 头注。
const manaSystem = new ManaSystem(entityContainer, effectRegistry, eventBus, skillLibrary, attrCalc, combatSystem);

// v2.5D 第5步：2D 渲染器已摘除，Three 是唯一渲染器。
// glCanvas 现在既是画面也是输入面（事件绑在它的父元素 #canvasWrap 上）。
// renderer3d 可能为 null（无 WebGL/显卡黑名单/headless 测试）——此时游戏逻辑照常运行、
// 只是没有画面，全链路用 ?. 保护，不崩。
const glCanvas = document.getElementById('glCanvas');
const uiManager = new UIManager(entityContainer, effectRegistry, attrCalc);

// 声明顺序在这里是有语义的：const 有暂时性死区，任何"先用后声明"都会直接抛
// ReferenceError 让整个 main.js 加载失败、游戏起不来（v25 事故的成因）。
// mapSystem 必须先于 renderer3d / canvasController 声明——后两者构造时就要用它。
const mapSystem = new MapSystem(entityContainer, eventBus);
mapSystem.setEffectRegistry(effectRegistry); // Q5：召唤水晶"重生中"状态展示

// 全局天气系统：连续演化的权重场，通过 AttributeCalculator 的修正层影响全体单位。
// 默认关闭（独立总开关，在设置面板里开）。
const weatherSystem = new WeatherSystem(eventBus);
attrCalc.setWeatherSystem(weatherSystem);

// P3：世界状态聚合层（天气/昼夜/熵/龙魂 的统一落点）。
// 所有耦合默认关闭（CONFIG.world.couplings），全关时行为与接入前逐位一致；
// 逐条打开即可引入昼夜阵营非对称、熵等玩法，而不必再改各系统内部。
const worldState = new WorldState({ weather: weatherSystem, dragons: dragonSystem, entities: entityContainer, bus: eventBus });
attrCalc.setWorldState(worldState);
CTX.__world = worldState;   // UI/调试入口
CTX.__CONFIG = CONFIG;      // UI/调试入口：控制台与无头冒烟里直接读写配置（与模块里是同一个对象）
CTX.__weather = weatherSystem; // UI/调试入口

// Q5：塔无敌/停火、小兵波次开关，全部支持【按阵营分管】。
// 结构：{ blue: bool, red: bool }。读取一律走下面的 helper，避免各处散落判断。
CTX.__showLanePaths = false; // v33 Q18：有墙地图默认不显示兵线虚线（设置里可开）
CTX.__gridOn = false;        // 用户定稿：地面参考网格默认关闭（设置→画质 里可开）
CTX.__terrainAvoid = true;   // Q1：小兵预判式地形避障（触须扫描），默认开
CTX.__laneFlow = true;       // Q1：兵线回流场（navgrid BFS 距离场）脱困，默认开
CTX.__towerRules = {
  invincible: { blue: false, red: false },
  attackOff:  { blue: false, red: false },
  waveOn:     { blue: true,  red: true  },   // 小兵是否随波次生成
};
CTX.__towerRuleFor = (kind, faction) => {
  const r = CTX.__towerRules?.[kind];
  if (!r) return false;
  return !!r[faction];
};

// ==================== v2.5D 第5步：Three 是唯一渲染器 ====================
// create() 是两层探测的静态工厂：无 WebGL 全局（Node 测试环境）或构造 throw（显卡黑名单/
// WebGL 被禁）一律返回 null。第 1~4 步的 F9 双渲染开关、__skip2d、对位断言均属脚手架，
// 已随 2D 渲染器一并拆除。
const renderer3d = glCanvas
  ? ThreeRenderer.create(glCanvas, mapSystem, eventBus,
      { entities: entityContainer, attrCalc, effects: effectRegistry,
        projectiles: projectileSystem, mapSystem,
        // 选中光圈取自 UIManager —— 选中态的真正持有者
        getSelectedId: () => uiManager?.selectedId ?? null })
  : null;
CTX.__three = renderer3d;
if (!renderer3d) console.warn('[2.5D] WebGL 不可用：游戏逻辑照常运行，但没有画面。');

const canvasController = new CanvasController(glCanvas, renderer3d);
canvasController.mapSystem = mapSystem;   // Q12：🎯 重置视角需要知道当前地图尺寸
if (renderer3d && glCanvas) {
  // 屏幕→世界改走"射线打 y=0 地面"，并给拖拽加 1/sin(仰角) 的纵向补偿。
  // 命中逻辑本身在世界坐标里工作，因此容差手感、幽灵水晶可选、点空地清除选中全部不变。
  canvasController.view3d = new ThreeCameraController(renderer3d, glCanvas, () => true);
}
// 仰角可调（默认 45°）。这不是脚手架，是画面手感参数，保留。
CTX.__setElevation = (deg) => renderer3d ? renderer3d.setElevation(deg) : null;
CTX.__setAzimuth = (deg) => renderer3d ? renderer3d.setAzimuth(deg) : null; // C 组·方位角：绕地图中心偏航
// C 组·河道玩法化（默认关闭）：开启后主对角线河带变可行走，重建地形开挖出下沉河道。
CTX.__riverWalkable = (on) => { const v = mapSystem.setRiverWalkable(on); renderer3d?.invalidateTerrain?.(); return v; };
// 视角俯仰角工具条。放画布控件栏而不是设置面板：它是持续微调的手感参数，
// 和缩放同类，藏进二级面板反而不好用。
{
  const sl = document.getElementById('elevSlider'), lb = document.getElementById('elevLabel');
  const applyElev = (deg) => {
    const d = renderer3d.setElevation(deg);
    sl.value = String(d);
    if (lb) lb.textContent = d + '°';
    return d;
  };
  if (sl && renderer3d) {
    applyElev(renderer3d.elevationDeg);
    sl.addEventListener('input', () => applyElev(Number(sl.value)));
    // v51.6：三行控件统一成【名称】【−】【滑杆】【+】【数值】——俯仰/方位原来只有
    // 滑杆没有步进按钮，这里补上；步长 1° 与滑杆的 step 保持一致。
    document.getElementById('elevDownBtn')?.addEventListener('click', () => applyElev(renderer3d.elevationDeg - 1));
    document.getElementById('elevUpBtn')?.addEventListener('click', () => applyElev(renderer3d.elevationDeg + 1));
  } else if (sl) {
    sl.disabled = true;   // 无 WebGL：控件留着但禁用，避免调了没反应
    document.getElementById('elevDownBtn')?.setAttribute('disabled', '');
    document.getElementById('elevUpBtn')?.setAttribute('disabled', '');
  }
}
// Q5：视角方位角（东南西北）工具条——滑块 0~360° + 靠近四方向自动吸附。与仰角同栏。
{
  const sl = document.getElementById('azimSlider'), lb = document.getElementById('azimLabel');
  const NAME = (d) => ['北', '东', '南', '西'][Math.round((((d % 360) + 360) % 360) / 90) % 4];
  const SNAP = 8; // 度：靠近 0/90/180/270 吸附
  const applyAzim = (raw) => {
    let d = ((raw % 360) + 360) % 360;
    for (const s of [0, 90, 180, 270, 360]) if (Math.abs(d - s) <= SNAP) { d = s % 360; break; }
    renderer3d.setAzimuth(d);
    sl.value = String(d);
    if (lb) lb.textContent = NAME(d);
    return d;
  };
  if (sl && renderer3d) {
    applyAzim(renderer3d.azimuthDeg || 0);
    sl.addEventListener('input', () => applyAzim(Number(sl.value)));
    // v51.6：同俯仰角，补上 −/+ 步进按钮，统一三行控件的形状。
    document.getElementById('azimDownBtn')?.addEventListener('click', () => applyAzim((renderer3d.azimuthDeg || 0) - 1));
    document.getElementById('azimUpBtn')?.addEventListener('click', () => applyAzim((renderer3d.azimuthDeg || 0) + 1));
  } else if (sl) {
    sl.disabled = true;
    document.getElementById('azimDownBtn')?.setAttribute('disabled', '');
    document.getElementById('azimUpBtn')?.setAttribute('disabled', '');
  }
}
// 追加需求：视角高度（与俯仰角/方位角同栏，同一套接线手法——第四行不是新造一套
// 逻辑，是把上面这两段的形状照抄一遍）。CTX.__setLookHeight 留给控制台手调手感用，
// 与 __setElevation/__setAzimuth 同级。
CTX.__setLookHeight = (h) => renderer3d ? renderer3d.setLookHeight(h) : null;
{
  const sl = document.getElementById('lookHeightSlider'), lb = document.getElementById('lookHeightLabel');
  const applyLookHeight = (h) => {
    const v = renderer3d.setLookHeight(h);
    sl.value = String(v);
    if (lb) lb.textContent = (v > 0 ? '+' : '') + v;
    return v;
  };
  if (sl && renderer3d) {
    applyLookHeight(renderer3d.lookHeightOffset);
    sl.addEventListener('input', () => applyLookHeight(Number(sl.value)));
    document.getElementById('lookHeightDownBtn')?.addEventListener('click', () => applyLookHeight(renderer3d.lookHeightOffset - 10));
    document.getElementById('lookHeightUpBtn')?.addEventListener('click', () => applyLookHeight(renderer3d.lookHeightOffset + 10));
  } else if (sl) {
    sl.disabled = true;
    document.getElementById('lookHeightDownBtn')?.setAttribute('disabled', '');
    document.getElementById('lookHeightUpBtn')?.setAttribute('disabled', '');
  }
}
// 第 6.1 步：阴影档位。'all' 全投影 / 'static' 仅塔与墙 / 'off' 关闭。
// 默认 'all'——用户定稿：启动即全部投影（含小兵）。性能有余量；想省开销可在设置面板切 'static'，
// 而"建筑有影子"的观感基本全留。当前无任何投影体，三档在画面上还看不出区别。
renderer3d?.setShadowLevel('all');
CTX.__setShadows = (lv) => renderer3d ? renderer3d.setShadowLevel(lv) : null;
// 第 6.5 步排查开关：CTX.__textures(false) 关掉材质贴图重建地形，用于二分画面问题。
// 注意单位侧【没有】对应开关——纸片人路径已在第 6.3 步移除，要回退只能换 zip。
CTX.__textures = (on) => renderer3d ? renderer3d.setTexturesEnabled(on !== false) : null;
// 长跑体检：children 应稳定不涨
CTX.__sceneStats = () => renderer3d ? renderer3d.sceneStats() : null;
// C 组·昼夜交替：并入天气系统——【随天气系统开关而开关】。天气开→昼夜随 gameTime 推进；
// 天气关→灯光锁定默认时刻（14 点，相位 1/3；比正午多些斜影）。以下三个 CTX 为调试杠杆：
// __dayNight(true/false/null)：强制开 / 强制锁默认时刻 / 跟随天气(默认，传 null 恢复)；
// __dayPeriod(秒) 改一天时长；__setDayPhase(0..1) 手动定格相位(null 恢复)。受光材质已接入 → 真实明暗。
CTX.__dayNightForce = null;   // null=跟随天气；true=强制昼夜；false=强制锁默认时刻（14 点）
CTX.__dayNight = (on) => { CTX.__dayNightForce = (on == null ? null : on !== false); };
CTX.__dayPeriod = (sec) => { CTX.__dayPeriodSec = Math.max(5, +sec || CONFIG.world?.dayPeriodSec || DAY_PERIOD); };
CTX.__setDayPhase = (p) => { CTX.__dayPhaseOverride = (p == null ? null : Math.max(0, Math.min(1, +p))); };
const laneMovementSystem = new LaneMovementSystem(entityContainer, effectRegistry, attrCalc, combatSystem, mapSystem);
const laneWaveSystem = new LaneWaveSystem(entityContainer, eventBus, mapSystem);
const collisionSystem = new CollisionSystem(entityContainer, mapSystem);
// v45：朝向/转身。排在移动之后（用最新位置转），攻击门读的是上一帧的朝向 ——
// 见 FacingSystem 头注的「时序」一节。
const facingSystem = new FacingSystem(entityContainer);
const laneAvengerSystem = new LaneAvengerSystem(entityContainer, effectRegistry, eventBus, mapSystem); // v33 Q20：哀兵


CTX.__app = { entityContainer, effectRegistry, combatSystem, dragonSystem, mapSystem, laneWaveSystem, laneAvengerSystem, eventBus, renderer: renderer3d, uiManager, attrCalc, SkillLibrary: skillLibrary, DRAGON_ELEMENTS, FACTIONS, canTarget };

// ---------- 创建单位 ----------
// v43 P1-④：塔 / 对战建筑 / 小兵 / 巨龙 四个工厂已搬到 src/core/factories.js。
// 那是一次**纯位移**（函数体逐字未动），只是把原来靠本文件模块作用域拿到的
// 那堆单例改成显式注入。搬迁的理由与"为什么没用闭包包起来"写在那个文件的头注释里。
const { createTower, createBuilding, createMinion, createDragon } = createFactories({
  entityContainer, effectRegistry, eventBus, skillLibrary, attrCalc, mapSystem, dragonSystem, uiManager,
});
mapSystem.setCreateBuildingFn(createBuilding);
dragonSystem.setCreateEntity(createDragon);
// v45：让巨龙系统能问"这张图声明了 dragon 吗"。注入而不是 import MAPS：
// 自制地图存在 MapSystem 那边，直接 import 只能看到内置的三张。
dragonSystem.setMapLookup((id) => mapSystem.getMapById?.(id) || null);
// v43：龙的「宿怨」被动（对某阵营的减伤/增伤随该阵营击杀数增长）在 CombatSystem 里结算，
// 击杀数由 DragonSystem 灌过去 —— 这里做一次注入，避免两个系统互相 import。
dragonSystem.setCombatSystem(combatSystem);
// 对战模式成长（Q2 再重做）：纯固定值/波，杜绝复利后期爆炸，只动 最大生命/攻击力/双抗。
// 数值经仿真校准：10分钟（约20波）时穿透塔单发 ≈ 近战44.9%/远程69.0%/炮车13.7%/超级兵4.3% 生命，
// 对齐 LoL 参考值（45/70/14/5）。无百分比分量 → 负基值属性（如超级兵魔抗-30）天然只吃固定增量。
// 数值偏保守，为龙魂等后续增益留出空间。
// Q10：攻击力成长降至原值 75%、双抗成长降至原值 33%（生命成长不变）。
// 成长表已搬进 CONFIG.battleGrowth（Q2：软编码，模板编辑器可改、地图可覆写）。
// 这里只保留取值逻辑：CONFIG 基表 → map.minionGrowth 覆写（浅合并，按兵种）。
function battleGrowthFlat(type) {
  const n = Math.max(0, (laneWaveSystem.waveNumber || 1) - 1); // 第1波为基准无成长
  const G = CONFIG.battleGrowth || {};
  // 地图覆写：同一兵种在不同地图上可以有完全不同的成长曲线（用户要求预留）
  const mapG = mapSystem.currentMap?.minionGrowth?.[type] || {};
  const f = { ...(G._default || {}), ...(G[type] || {}), ...mapG };
  // v51.3：新增 ap（法术强度）成长——只有显式写了 ap 字段的类型（大型小兵）才非零，
  // melee/ranged/_default 没写这个键，(f.ap || 0) 天然是 0，不用另外按类型分支。
  return { hp: (f.hp || 0) * n, ad: (f.ad || 0) * n, res: (f.res || 0) * n, ap: (f.ap || 0) * n };
}
laneWaveSystem.setCreateMinion((type, x, y, faction, laneId, direction) => {
  // 按 laneWaveSystem 自己的独立波次计数成长。
  const ent = createMinion(type, x, y, 1, 1, { faction, laneId, direction, growthFlat: battleGrowthFlat(type), templateOverride: mapSystem.currentMap?.minionTemplates?.[type] });
  // v42: template override now happens inside createMinion (before growth), passed via templateOverride
  // The growth is already applied on top of template values inside createMinion.
  return ent;
});

// 龙魂事件日志
eventBus.on('dragon:killed', (d) => {
  if (d.ancient) uiManager.log(`🐲 远古巨龙被击败！远古之力+1（共${d.ancientKills}）`, 'spawn');
  else uiManager.log(`${DRAGON_ELEMENTS[d.element]?.icon || '🐉'} ${DRAGON_ELEMENTS[d.element]?.label || '巨龙'}被击败！获得永久增益`, 'spawn');
});
eventBus.on('dragon:soulUnlocked', (d) => {
  uiManager.log(`✨ 龙魂解锁：${d.label}魂！所有防御塔获得强大效果，此后只刷新远古巨龙`, 'spawn');
});
// 阵营龙魂结算（用户定稿：6 条龙 + ≥4 击杀才成魂，都不到 4 则无魂，之后出远古龙）
eventBus.on('dragon:soulResolved', (d) => {
  const t = d.factionTotals || {};
  if (d.owner) {
    const who = d.owner === 'blue' ? '🔵蓝方' : '🔴红方';
    uiManager.log(`✨ 龙魂归属：${who}取得【${d.label}魂】（蓝 ${t.blue||0} : ${t.red||0} 红），全军生效`, 'spawn');
  } else {
    uiManager.log(`❌ 无人成魂（蓝 ${t.blue||0} : ${t.red||0} 红，无一方达到门槛），直接进入远古龙阶段`, 'spawn');
  }
});
// 召唤水晶重建后补发本阵营已有的龙魂 —— 重建路径是全新实体，不补就把魂丢了。
// 写在这里而不是 MapSystem 里，是为了守住“系统之间禁止互相 import”的规矩。
eventBus.on('map:nexusRespawned', ({ faction }) => {
  if (!faction) return;
  for (const t of entityContainer.getAllTowers(true)) {
    if (t._mapFaction === faction) dragonSystem.equipExistingSoul(t);
  }

});
eventBus.on('dragon:spawn', (d) => {
  uiManager.log(`⚠️ ${d.label} 即将降临`, 'spawn');
});
// ==================== 对战计分板：击杀数/推塔数（死亡归属：敌方阵亡=我方得分，无需击杀者溯源） ====================
CTX.__score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };
eventBus.on('entity:death', ({ entityId }) => {
  const e = entityContainer.get(entityId);
  if (!e || !e._mapFaction || !mapSystem.active) return;
  const scorer = e._mapFaction === 'blue' ? 'red' : 'blue';
  if (e.type === 'tower') {
    // 只计四类攻击塔为"推塔"；水晶类另有事件与日志
    if (['outer', 'inner', 'base', 'hq_tower'].includes(e._mapTier)) CTX.__score[scorer].towers++;
  } else {
    CTX.__score[scorer].kills++;
  }
});
// ⚠️ 时钟必须在【建筑创建之前】归零 —— 这是 map:loading，不是 map:loaded。
//
// 用户报的"所有地图的塔都不会正常成长"就出在这个时序上：
// 塔成长被动在 onEquip 里记 `t0 = window.gameTime`，而建筑是在 loadMap 的中段创建的；
// 原来只有 map:loaded（loadMap 的**最后一行**）里才 `CTX.gameTime = 0`，
// 于是 t0 记的是【归零之前】那个时间 —— 玩家在沙盒/菜单里待了多久，
// 成长就被推迟多久（elapsed = max(0, gameTime − t0) 要等 gameTime 重新爬回 t0 才开始走）。
// 实测：载图时 gameTime=300，跑满 15 分钟只长到 9 层（正常 14 层）；
// 待得越久越像"完全不长"，切第二张图必中。
eventBus.on('map:loading', () => {
  CTX.gameTime = 0;
  CTX.waveNumber = 0;
  CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
});
eventBus.on('map:loaded', (d) => {
  CTX.__score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };
  weatherSystem.reset(); // 每次载图重新随机：起始权重、变化快慢（θ）全部重抽
  // v42: full state reset on map switch
  // 时钟三项已在上面的 map:loading 里归零（必须早于建筑创建，见那段注释）。
  // 这里保留一次幂等重置，兜住"有人直接 emit map:loaded"的路径。
  CTX.gameTime = 0;
  CTX.waveNumber = 0;
  CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
  laneWaveSystem.waveNumber = 0;
  laneWaveSystem._mapWaveApplied = undefined;
  laneWaveSystem._clock = 0;
  laneWaveSystem._spawnQueue.length = 0;
  laneWaveSystem.nextWaveTime = 30; // will be overridden by map config on next update
  uiManager.log(`🗺️ 地图已加载：${d.label}`, 'spawn');
  DebugLogger.log('map', `地图加载: ${d.mapId} (${d.label})`);
});
eventBus.on('map:nexusDestroyed', (d) => {
  const label = d.faction === FACTIONS.BLUE ? '蓝方' : '红方';
  uiManager.log(`💥 ${label}水晶已被摧毁！${label}此后只生成超级兵（其余兵种停止）`, 'death');
  DebugLogger.log('map', `水晶摧毁: faction=${d.faction}`);
});

// ==================== v43：重置本局 ====================
// 用户："设置里新加一个按钮重置本局，按照目前现有的地图+属性等从头重新来一局。"
//
// 关键是划清"局内进度"与"玩家的设置"这条界：
//   **清掉**：全部实体（含建筑与尸体/废墟）、飞行中的弹道、对局时钟与波次、
//             比分、龙系统的整局进度（含已获得的龙魂）、水晶重生队列、天气重抽。
//   **保留**：CONFIG 里的一切 —— 分层塔覆写、出兵编排、模板改动、技能参数覆写、
//             天气权重、画质选项。也就是"按照目前现有的地图+属性等"重来。
//
// 实现上直接复用 mapSystem.loadMap(当前地图 id)：换图路径本来就要做一次完整清场
//（clearCurrentMap → map:loading 归零时钟 → 重建建筑 → map:loaded 重置波次系统），
// 重开一局与"切到同一张图"在语义上是同一件事。自己另写一套清场逻辑的话，
// 以后往换图路径里加的每一步都得记得同步到这边 —— 那是必然会漏的。
CTX.__resetRun = () => {
  // ① 小兵/巨龙：loadMap 只管建筑，其余实体要自己清
  for (const e of entityContainer.getAll(false)) {
    if (e.type === 'tower') continue;              // 建筑交给 clearCurrentMap
    e.alive = false; e.currentHP = 0;
    for (const eff of effectRegistry.getEffects(e.id)) effectRegistry.remove(eff.id);
  }
  entityContainer.purgeDead();
  // ② 飞行物：不清的话上一局的子弹会带着 pendingHit 落到新一局的实体 id 上
  projectileSystem.projectiles.length = 0;
  projectileSystem.beams.clear();
  // ③ 龙系统的整局进度（含龙魂归属）
  dragonSystem.resetRun();
  // ④ 地图：重载当前图。loadMap 触发的 map:loading/map:loaded 会把时钟/波次/比分/
  //    天气一并重置，见下面那两个事件处理器 —— 这里不用重复做一遍。
  mapSystem.loadMap(mapSystem.currentMap.id);
  uiManager.log('🔄 本局已重置（地图与所有属性设置保持不变）', 'spawn');
  return true;
};

// ---------- 按钮绑定 ----------
// 统一添加单位按钮（建塔 + 添加小兵 + 手动生成巨龙）
let _towerPlacementQueue = [];
function _processNextTowerPlacement() {
  if (_towerPlacementQueue.length === 0) return;
  const { weaponType, passiveKeys, faction, model, modelStats } = _towerPlacementQueue.shift();
  uiManager.log(`🎯 请点击画布选择建塔位置（剩余 ${_towerPlacementQueue.length + 1} 个待放置）`, 'spawn');
  canvasController.armPlaceMode((worldX, worldY) => {
    const tower = createTower(worldX, worldY);
    // EQ2：手动建塔归属阵营（蓝/红/中立）。中立=独立一方：打红蓝双方，也被双方打。
    tower._mapFaction = faction;
    tower.faction = faction;
    const oldWeapon = tower._skillInstances.find(s => s.skillId.startsWith('weapon_'));
    if (oldWeapon) {
      const oldDef = skillLibrary[oldWeapon.skillId];
      if (oldDef?.onUnequip) oldDef.onUnequip(tower.id, oldWeapon, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
      tower._skillInstances = tower._skillInstances.filter(s => s !== oldWeapon);
    }
    if (weaponType !== 'none') {
      equipSkill(tower, 'weapon_' + weaponType, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      }, skillLibrary);
    }
    const allPassives = ['passive_heavy_defense', 'passive_thorns', 'passive_frost_plating', 'passive_armor_plating'];
    const toRemove = tower._skillInstances.filter(s => allPassives.includes(s.skillId));
    for (const inst of toRemove) {
      const def = skillLibrary[inst.skillId];
      if (def?.onUnequip) def.onUnequip(tower.id, inst, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
      tower._skillInstances = tower._skillInstances.filter(s => s !== inst);
    }
    for (const key of passiveKeys) {
      equipSkill(tower, key, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      }, skillLibrary);
    }
    // Q7：建筑模型（用户定稿：**默认只换外观**；勾了"套用该档位数值"才连带数值与层级）。
    // 只写 _modelRole 的话，渲染层会用对应 GLB / 程序化几何，玩法完全不受影响。
    let mTag = '';
    if (model && model !== 'tower') {
      tower._modelRole = model;
      const meta = TOWER_MODEL_ROLES.find(r => r.key === model);
      mTag = `，外观: ${meta ? meta.label : model}`;
      if (modelStats && meta?.tier) {
        // 套用该档位数值：走与 createBuilding / 运维改层级**同一条解析链**
        // （地图 tierStats → towerTierOverrides → factionOverrides['tower_'+tier]），
        // 不在这里自己拼一份 —— 那条链已经被抄过四遍，不再添第五份。
        const map = mapSystem.currentMap;
        const merged = {
          ...((map?.tierStats && map.tierStats[meta.tier]) || {}),
          ...(CONFIG.towerTierOverrides?.[meta.tier] || {}),
          ...(CONFIG.factionOverrides?.[tower._mapFaction]?.['tower_' + meta.tier] || {}),
        };
        if (Object.keys(merged).length) {
          Object.assign(tower.baseStats, merged);
          // v47：补满到**叠完增益之后**的最大生命（与出生/重生同一口径，
          // 见 factories.js spawnAtFullHP 头注）。原来取 baseStats.maxHP，
          // 这座塔身上若挂着带 maxHPPct 的龙之奖励/状态，套完档位就成了残血。
          const fullHP = effectiveMaxHP(tower);
          if (fullHP > 0) tower.currentHP = fullHP;
          tower.shieldFixedCurrent = tower.baseStats.shieldFixedMax || 0;
        }
        // 层级也一并设上：不设的话它在结构保护/推进度统计里仍算"无层级的手建塔"，
        // 而面板写着"已套用召唤水晶数值" —— 又是一处面板与实际不符。
        tower._mapTier = meta.tier;
        mTag += `（已套用${meta.label}档位数值与层级）`;
      }
    }
    const fTag = faction === 'blue' ? '🔵蓝方' : (faction === 'red' ? '🔴红方' : (faction === 'neutral' ? '⚪中立' : ''));
    uiManager.log(`🏗️ ${fTag}塔 #${tower.id} 建造完成，武器: ${weaponType}，被动: ${passiveKeys.length}个${mTag}`, 'spawn');
    // 继续放置队列中的下一个塔
    _processNextTowerPlacement();
  });
}

document.getElementById('addUnitBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  UnitAddDialog.open({
    onBuildTower: (weaponType, passiveKeys, faction, opts) => {
      // 批量生成时可能一次性收到多个塔条目，串行进入选位模式，避免互相抢占
      _towerPlacementQueue.push({ weaponType, passiveKeys, faction: faction || null,
                                  model: opts?.model || 'tower', modelStats: !!opts?.modelStats });
      if (_towerPlacementQueue.length === 1) _processNextTowerPlacement();
    },
    onAddMinion: (type, count, growth, faction, laneId) => {
      // 带阵营的手动添加——出生点=该阵营水晶枢纽，走指定分路推线，
      // 成长按对战复利公式，默认被动/阵营覆写在 createMinion 内自动生效。
      const nexus = mapSystem.currentMap.buildings.find(b => b.tier === 'nexus_main' && b.faction === faction);
      const px = nexus ? nexus.pos.x : 1776, py = nexus ? nexus.pos.y : 1776;
      const dir = faction === FACTIONS.BLUE ? 'forward' : 'reverse';
      const gf = growth ? battleGrowthFlat(type) : null;
      for (let i = 0; i < count; i++) {
        createMinion(type, px + (Math.random() - 0.5) * 16, py + (Math.random() - 0.5) * 16,
          1, 1, { faction, laneId: laneId || 'mid', direction: dir, growthFlat: gf });
      }
      uiManager.log(`➕ ${faction === FACTIONS.BLUE ? '🔵蓝方' : '🔴红方'}生成 ${count} 个 ${type} 兵 → ${laneId || 'mid'} 路`, 'spawn');
    },
    onAddDragon: (element, ancient) => {
      const dstats = dragonSystem._dragonStats(dragonSystem.elementDragonSpawned + 1, ancient);
      const el = element || Object.keys(DRAGON_ELEMENTS)[Math.floor(Math.random() * Object.keys(DRAGON_ELEMENTS).length)];
      createDragon('dragon', { element: ancient ? null : el, isAncient: ancient, absStats: dstats });
      uiManager.log(`🐉 手动生成${ancient ? '远古巨龙' : (DRAGON_ELEMENTS[el]?.label || '巨龙')}`, 'spawn');
    },
  });
});

// 龙魂管理已整合进每座塔的统一编辑窗口（🐉 龙魂 tab），顶部按钮不再需要。

// 模板编辑器（打开顶层大类选择，可切换编辑所有单位类型）
document.getElementById('templateEditorBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode(); // 若正处于"点击画布建塔"选位模式，先取消，避免弹窗盖住画布后选位状态悬挂
  AttributeEditor.openTemplateEditorRoot(uiManager.log.bind(uiManager));
});

// v47：日志开关已从顶栏移进【设置 → 调试】（用户："删除右侧的日志按钮，移动到设置里"）。
// 这里原本是 `document.getElementById('toggleLogBtn').addEventListener(...)`——
// 顶栏那个按钮删掉之后这一句会在 null 上取 addEventListener 直接抛异常，
// 而它位于 main.js 的接线段中间，抛了之后**后面所有按钮都不会接上**。
// 删元素时必须连着把它的接线一起删，这是"删一半"最典型的塌方方式。
// 开关本身搬到 SettingsDialog（同一个 #logArea，行为一字未改）。

// 设置窗口（整合此前的跳过等待/暂停波次/清屏/暂停/重置波次，新增小兵/龙独立控制）
document.getElementById('settingsBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  SettingsDialog.open({ dragonSystem, entityContainer, mapSystem, laneWaveSystem }, uiManager.log.bind(uiManager));
});

// 地图切换（原来这里还有一个"沙盒/对战"模式切换按钮，随沙盒模式一起删掉了）
function updateModeBtnLabel() {
  const btn = document.getElementById('modeBtn');
  if (btn) btn.textContent = `🗺️ ${mapSystem.currentMap?.label || '游戏地图'}`;
}
document.getElementById('modeBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  ModeDialog.open({ mapSystem, onMapChanged: () => {
    updateModeBtnLabel();
    // 相机自适应到地图声明的世界尺寸（召唤师峡谷 3552×3552，默认 zoom=1 只能看到左上角一角）。
    if (mapSystem.currentMap?.world) {
      canvasController.fitToWorld(mapSystem.currentMap.world.w, mapSystem.currentMap.world.h);
    }
  } }, uiManager.log.bind(uiManager));
});
updateModeBtnLabel();

// ---------- 点选面板接线 ----------
WeatherPanel.init(weatherSystem, () => {
  AttributeEditor.openTemplateEditor('weather', uiManager.log.bind(uiManager), null);
});
// 世界状态小窗（时间/昼夜 · 天气 · 熵 三段合并在右上角一个窗口里）。
// 点熵那一段直接跳设置面板的「🌍 世界」页 —— 用户看到熵在变，第一反应就是想调它。
WorldHud.init(worldState, {
  onEntropyClick: () => {
    SettingsDialog._tab = 'world';
    SettingsDialog.open({ dragonSystem, entityContainer, mapSystem, laneWaveSystem },
      (m, k) => uiManager.log(m, k));
  },
});
CTX.__weatherPanel = WeatherPanel; // 设置面板里的"天气配置…"入口

canvasController.onSelect = (id) => uiManager.selectEntity(id);
canvasController.onDeselect = () => uiManager.clearSelection();

// ---------- 性能面板（📊 按钮开关，4Hz 刷新滚动窗口平均） ----------
{
  const hud = document.getElementById('perfHud');
  // Q12：性能面板开关已移入设置面板（SettingsDialog）
  setInterval(() => {
    if (!hud || !hud.classList.contains('show')) { if (CTX.__perf) { const P = CTX.__perf; P.sim = P.render = P.dom = P.n = P.steps = 0; } return; }
    const P = CTX.__perf; if (!P || !P.n) return;
    const units = entityContainer.getAllMinions(true).length + entityContainer.getAllTowers(true).length;
    const frame = (P.sim + P.render + P.dom) / P.n;
    hud.textContent =
      `帧均 ${frame.toFixed(2)}ms (${(1000 / Math.max(frame, 1000 / 240)).toFixed(0)}fps上限)\n` +
      `模拟 ${(P.sim / P.n).toFixed(2)}ms · 步/帧 ${(P.steps / P.n).toFixed(2)}\n` +
      `渲染 ${(P.render / P.n).toFixed(2)}ms\nDOM  ${(P.dom / P.n).toFixed(2)}ms\n单位 ${units}`;
    P.sim = P.render = P.dom = P.n = P.steps = 0;
  }, 250);
}

// ---------- 游戏循环：固定步长累积器（模拟与渲染解耦） ----------
// 旧问题：模拟步长 = 渲染帧间隔（钳制 0.05s）。渲染一掉帧，游戏时间就膨胀（倒计时变慢）。
// 新模型：模拟固定 30Hz 步进（SIM_DT），渲染每个 rAF 一帧。渲染掉帧时一帧内补跑多步模拟，
// 游戏时间保持与现实同速。补步预算（v44 改为墙钟毫秒，见 gameLoop）防"模拟自身超支→越补越欠"的死亡螺旋：
// 达到上限时丢弃欠账（表现为轻微慢动作），这只在模拟本体过载的极端情况下发生。
// 30Hz 模拟顺带把模拟开销砍半（移速 78px/s 下单步 2.6px，视觉无感）。
const SIM_DT = 1 / 30;
let _lastTs = 0, _acc = 0;

// 性能分解统计：滚动窗口累计 模拟/渲染/DOM 耗时，PerfHud 低频读取。
const PERF = { sim: 0, render: 0, dom: 0, n: 0, steps: 0, t: 0 };
CTX.__perf = PERF;

function stepSimulation(dt) {
  CTX.gameTime += dt;
  effectRegistry.update(dt);
  buffSystem.update(dt);
  dragonSystem.update(dt);
  combatSystem.update(dt);
  manaSystem.update(dt);      // v51：资源条推进 + 满了就施放主动技能
  weatherSystem.update(dt);   // 天气演化（权重场，enabled=false 时零开销）
  worldState.update(dt, CTX.gameTime);   // P3：昼夜相位 / 熵 / 龙魂统计（耦合默认全关）
  mapSystem.update(dt);       // 召唤水晶重生计时（仅对战模式内部生效）
  laneWaveSystem.update(dt);
      laneMovementSystem.update(dt);
      collisionSystem.update(dt);
  facingSystem.update(dt);      // v45：朝向必须在移动/碰撞之后，才用得上这一帧的位置
  laneAvengerSystem.update(dt); // v33 Q20：哀兵光环（0.5s 节奏内部节流）
  projectileSystem.update(dt);
}

function gameLoop(timestamp) {
  if (!_lastTs) _lastTs = timestamp;
  let realDt = (timestamp - _lastTs) / 1000;
  _lastTs = timestamp;
  if (realDt > 0.25) realDt = 0.25; // 标签页切回等极端间隔，不让累积器暴走

  const t0 = performance.now();

  const speed = CTX.__gameSpeed || 1;
  const feed = realDt * speed;

  if (!CTX.gamePaused) {
    _acc += feed;
    let steps = 0;
    // ==================== v44：预算从「步数」改成「墙钟时间」 ====================
    // 用户："单位一多，天气一开就特别卡，是那种每帧的延迟特别高。"
    //
    // 原实现有两个写死的**步数**上限：快进时每帧最多推 2 秒模拟时间（≈60 步），
    // 加速时 maxSteps 直接放到 240。问题在于 —— **步数是常量，单步耗时不是**。
    // 空场时一步几十微秒，60 步无感；上百个单位 + 天气开着时一步能到好几毫秒，
    // 同样的 60 步就是几百毫秒的卡顿，而且单位越多越卡，正是用户描述的现象。
    //
    // 现在按「这一帧还能花多少毫秒」来收：跑够时间就停，欠的账留到下一帧。
    // 于是不管场上有多少单位、倍率开到几，单帧耗时都被钉在预算内 ——
    // 快进变成「慢一点跑完」而不是「卡住不动」。
    const budgetMs = (CONFIG.tuning?.simBudgetMs) ?? 12;
    const tSim0 = performance.now();
    while (_acc >= SIM_DT) {
      // 每个模拟步都要让属性缓存失效并重建空间网格——位置/效果在步进中变化
      attrCalc.tick();
      entityContainer.rebuildGridIfNeeded(attrCalc._frame);
      stepSimulation(SIM_DT);
      _acc -= SIM_DT;
      steps++;
      // 至少跑一步（否则低帧率时永远追不上），之后按墙钟时间收
      if (performance.now() - tSim0 >= budgetMs) break;
    }
    // 欠账上限：按倍率放宽但封顶 —— 留太多会在卡顿缓解后突然补跑一大段（画面跳）。
    const maxDebt = SIM_DT * Math.max(2, Math.min(8, speed) * 2);
    if (_acc > maxDebt) _acc = maxDebt;
    PERF.steps += steps;
  } else {
    _acc = 0;
  }

  const t1 = performance.now();
  // 渲染复用最后一个模拟步的属性缓存（tick 会作废缓存、逼渲染全量重算 attrCalc）。
  // 模拟没跑的帧缓存本来就没变；暂停时例外——编辑器可能改了属性，需保持失效让改动可见。
  if (CTX.gamePaused) {
    attrCalc.tick();
    entityContainer.rebuildGridIfNeeded(attrCalc._frame);
  }
  // C 组·昼夜交替（并入天气系统）：随天气开关而开关。setLighting 很轻，逐帧无压力。
  //   · 手动定格相位（__setDayPhase）优先，任何时候生效（调试/截图）；
  //   · 否则：昼夜生效（跟随天气 enabled，或被 __dayNightForce 强制）→ 随 gameTime 推进；
  //   · 不生效（天气关且未强制）→ 锁定默认时刻＝14 点（相位 1/3）。
  //     选 14 点而非正午：正午太阳约 82° 近乎直射、几乎无阴影；14 点约 58°，有像样的斜影。
  if (renderer3d) {
    // 相位走 resolveDayPhase 这唯一口径（光照 / WorldState 数值化昼夜 / HUD 时间条共用）。
    // 三处各算一遍时"画面白天、数值夜晚"这种不一致不会报错，只会让人怀疑眼睛。
    const dp = resolveDayPhase(CTX.gameTime, CTX, weatherSystem.enabled);
    renderer3d.setLighting(dayNightAt(dp.phase * dp.period, dp.period));
  }
  renderer3d?.render(canvasController);
  const t2 = performance.now();
  uiManager.update();
  WeatherPanel.update(); // 天气滚动条（关闭时零开销）
  WorldHud.update(CTX.gameTime);  // 时间/昼夜 + 熵（熵无耦合开启时整行隐藏）
  const t3 = performance.now();

  PERF.sim += t1 - t0; PERF.render += t2 - t1; PERF.dom += t3 - t2; PERF.n++;
  requestAnimationFrame(gameLoop);
}

// ---------- 启动 ----------
// 进入游戏默认为【召唤师峡谷】。
mapSystem.loadMap('summoners_rift_v1');
const _bootMap = mapSystem.currentMap;
if (_bootMap?.world) canvasController.fitToWorld(_bootMap.world.w, _bootMap.world.h);
requestAnimationFrame(gameLoop);

// 供 tests/sim_runtime.mjs 驱动真实游戏循环（动态冒烟）——
// v25 教训：12 套仿真全绿，但游戏每帧崩溃，因为没有任何测试真正跑过游戏循环本体。
CTX.__gameLoop = gameLoop;
CTX.__entityContainer = entityContainer;
CTX.__uiManager = uiManager;
CTX.__mapSystem = mapSystem;

CTX.createTower = createTower;
CTX.createMinion = createMinion;

