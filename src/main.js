import { EntityContainer } from './core/EntityContainer.js';
import { CTX } from './core/GameContext.js';
import { EffectRegistry } from './core/EffectRegistry.js';
import { SkillLibrary } from './core/SkillLibrary.js';
import { AttributeCalculator } from './core/AttributeCalculator.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { WaveSystem } from './systems/WaveSystem.js';
import { ProjectileSystem } from './systems/ProjectileSystem.js';
import { BuffSystem } from './systems/BuffSystem.js';
import { DragonSystem, DRAGON_ELEMENTS } from './systems/DragonSystem.js';
import { MapSystem } from './systems/MapSystem.js';
import { WeatherSystem } from './systems/WeatherSystem.js';
import { WeatherPanel } from './ui/WeatherPanel.js';
import { LaneMovementSystem } from './systems/LaneMovementSystem.js';
import { LaneWaveSystem } from './systems/LaneWaveSystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { LaneAvengerSystem } from './systems/LaneAvengerSystem.js';
import { FACTIONS, canTarget } from './systems/FactionSystem.js';
import { ThreeRenderer } from './presentation/ThreeRenderer.js';
import { ThreeCameraController } from './presentation/ThreeCameraController.js';
import { EventBus } from './utils/EventBus.js';
import { CONFIG } from './data/Config.js';
import { UIManager } from './ui/UIManager.js';
import { CanvasController } from './ui/CanvasController.js';
import { AttributeEditor } from './ui/AttributeEditor.js';
import { UnitAddDialog } from './ui/UnitAddDialog.js';
import { SettingsDialog } from './ui/SettingsDialog.js';
import { ModeDialog } from './ui/ModeDialog.js';
import { DebugLogger } from './utils/DebugLogger.js';

CTX._uid = 0;
DebugLogger.hookConsole();
CTX.waveNumber = 0;
CTX.gameTime = 0;
CTX.gamePaused = false;
CTX.__gameSpeed = 1;    // v39（Q6）：游戏速度倍率 0.5 / 1 / 2
CTX.__ffRemain = 0;     // v39（Q6）：剩余快进秒数（真实加速模拟，非跳时钟）
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
const attrCalc = AttributeCalculator;

const combatSystem = new CombatSystem(entityContainer, effectRegistry, eventBus, skillLibrary);
const projectileSystem = new ProjectileSystem(entityContainer, eventBus, combatSystem);
combatSystem.setProjectileSystem(projectileSystem);
const waveSystem = new WaveSystem(entityContainer, eventBus);
const buffSystem = new BuffSystem(effectRegistry, entityContainer, eventBus, combatSystem);
const dragonSystem = new DragonSystem(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc);

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
waveSystem.setMapSystem(mapSystem);
mapSystem.setEffectRegistry(effectRegistry); // Q5：召唤水晶"重生中"状态展示

// 全局天气系统：连续演化的权重场，通过 AttributeCalculator 的修正层影响全体单位。
// 默认关闭（独立总开关，在设置面板里开）。
const weatherSystem = new WeatherSystem(eventBus);
attrCalc.setWeatherSystem(weatherSystem);
CTX.__weather = weatherSystem; // UI/调试入口

// Q5：塔无敌/停火、小兵波次开关，全部支持【按阵营分管】。
// 结构：{ blue: bool, red: bool }。读取一律走下面的 helper，避免各处散落判断。
CTX.__showLanePaths = false; // v33 Q18：有墙地图默认不显示兵线虚线（设置里可开）
CTX.__towerRules = {
  invincible: { blue: false, red: false },
  attackOff:  { blue: false, red: false },
  waveOn:     { blue: true,  red: true  },   // 小兵是否随波次生成
};
CTX.__towerRuleFor = (kind, faction) => {
  const r = CTX.__towerRules?.[kind];
  if (!r) return false;
  if (!faction) return r.blue || r.red;   // 无阵营（沙盒塔）：任一方开启即视为开启
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
// 视角俯仰角工具条。放画布控件栏而不是设置面板：它是持续微调的手感参数，
// 和缩放同类，藏进二级面板反而不好用。
{
  const sl = document.getElementById('elevSlider'), lb = document.getElementById('elevLabel');
  if (sl && renderer3d) {
    sl.value = String(renderer3d.elevationDeg);
    if (lb) lb.textContent = renderer3d.elevationDeg + '°';
    sl.addEventListener('input', () => {
      const d = renderer3d.setElevation(Number(sl.value));
      if (lb) lb.textContent = d + '°';
    });
  } else if (sl) {
    sl.disabled = true;   // 无 WebGL：控件留着但禁用，避免调了没反应
  }
}
// 第 6.1 步：阴影档位。'all' 全投影 / 'static' 仅塔与墙 / 'off' 关闭。
// 默认 'static'——小兵是同屏数量最大的一类，排除它们能省下绝大部分阴影开销，
// 而"建筑有影子"的观感基本全留。当前无任何投影体，三档在画面上还看不出区别。
renderer3d?.setShadowLevel('static');
CTX.__setShadows = (lv) => renderer3d ? renderer3d.setShadowLevel(lv) : null;
// 第 6.5 步排查开关：CTX.__textures(false) 关掉材质贴图重建地形，用于二分画面问题。
// 注意单位侧【没有】对应开关——纸片人路径已在第 6.3 步移除，要回退只能换 zip。
CTX.__textures = (on) => renderer3d ? renderer3d.setTexturesEnabled(on !== false) : null;
// 长跑体检：children 应稳定不涨
CTX.__sceneStats = () => renderer3d ? renderer3d.sceneStats() : null;
const laneMovementSystem = new LaneMovementSystem(entityContainer, effectRegistry, attrCalc, combatSystem, mapSystem);
const laneWaveSystem = new LaneWaveSystem(entityContainer, eventBus, mapSystem);
const collisionSystem = new CollisionSystem(entityContainer, mapSystem);
const laneAvengerSystem = new LaneAvengerSystem(entityContainer, effectRegistry, eventBus, mapSystem); // v33 Q20：哀兵


CTX.__app = { entityContainer, effectRegistry, combatSystem, waveSystem, dragonSystem, mapSystem, laneWaveSystem, laneAvengerSystem, eventBus, renderer: renderer3d, uiManager, attrCalc, SkillLibrary: skillLibrary, DRAGON_ELEMENTS, FACTIONS, canTarget };

// ---------- 创建单位 ----------
function createTower(x, y) {
  const tpl = CONFIG.templates.tower;
  const entity = {
    id: ++CTX._uid,
    type: 'tower',
    alive: true,
    pos: { x, y },
    baseStats: { ...tpl },
    currentHP: tpl.maxHP,
    shieldFixedCurrent: tpl.shieldFixedMax || 0,
    tempShield: 0,
    lastDamageTime: -Infinity,
    attackCooldown: 0,
    targetId: null,
    _skillInstances: [],
    _inCombat: false,
    _attackerCount: 0,
  };

  const ctx = { entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc };

  // 装备核心
  entity._skillInstances.push({ id: ++CTX._uid, skillId: 'core_normal', state: {} });

  // 默认武器：读取模板设置的默认武器（模板编辑器"武器"tab），否则用穿透型
  // （v33：增幅型武器已删除，其"升温"被并入穿透型）
  const defaultWeapon = tpl._templateWeapon || 'piercing';
  if (defaultWeapon !== 'none') {
    const wInst = { id: ++CTX._uid, skillId: 'weapon_' + defaultWeapon, state: {} };
    entity._skillInstances.push(wInst);
    const wDef = skillLibrary[wInst.skillId];
    if (wDef?.onEquip) wDef.onEquip(entity.id, wInst, ctx);
  }

  // 默认被动（模板编辑器"被动技能"tab 里勾选的）
  if (Array.isArray(tpl._templateSkills)) {
    for (const key of tpl._templateSkills) {
      const inst = { id: ++CTX._uid, skillId: key, state: {} };
      entity._skillInstances.push(inst);
      const def = skillLibrary[key];
      if (def?.onEquip) def.onEquip(entity.id, inst, ctx);
    }
  }

  entityContainer.add(entity);

  // 默认状态（模板编辑器"状态"tab 里配置的）
  if (Array.isArray(tpl._templateEffects)) {
    for (const effBlueprint of tpl._templateEffects) {
      effectRegistry.apply(entity.id, { ...effBlueprint }, 'template_effect_tower');
    }
  }

  // 默认龙魂（模板编辑器"龙魂"tab 里设置的，可多个）——不占用击杀解锁进度，仅作为默认配置
  if (Array.isArray(tpl._templateSouls)) {
    for (const soulId of tpl._templateSouls) {
      dragonSystem._toggleSoul(entity, soulId);
    }
  } else if (tpl._templateSoul) {
    // 兼容旧的单一字段
    dragonSystem._toggleSoul(entity, tpl._templateSoul);
  }

  eventBus.emit('entity:spawn', { entityId: entity.id });
  uiManager.log(`🏰 塔 #${entity.id} 建造在 (${Math.round(x)}, ${Math.round(y)})`, 'spawn');
  return entity;
}

// 对战模式专用：由 MapSystem 调用，生成地图上的塔/水晶建筑。
// 复用 createTower 的技能装配方式，但额外打上 faction/tier 标记、按 tier 应用数值倍率，
// 武器按地图配置固定分配（而非模板默认）。沙盒模式不会调用这个函数，互不影响。
function createBuilding({ faction, tier, laneId, isNexus, pos, weapon, stats, skills }) {
  const tpl = CONFIG.templates.tower;
  const s = stats || {};
  const entity = {
    id: ++CTX._uid,
    type: 'tower',
    alive: true,
    pos: { x: pos.x, y: pos.y },
    baseStats: {
      ...tpl,
      maxHP: s.maxHP ?? tpl.maxHP,
      armor: s.armor ?? tpl.armor,
      magicResist: s.magicResist ?? tpl.magicResist,
      attackDamage: s.attackDamage ?? tpl.attackDamage,
      baseAttackSpeed: s.baseAttackSpeed ?? tpl.baseAttackSpeed,
      shieldFixedMax: s.shieldFixedMax ?? 0,
      healthRegen: s.healthRegen ?? tpl.healthRegen,
      // 攻击距离统一沿用塔的基础射程（不按 tier 区分——所有会攻击的建筑共用同一个射程）。
      attackRange: tpl.attackRange,
    },
    currentHP: 0, // 下面按 maxHP 设置满血
    shieldFixedCurrent: s.shieldFixedMax ?? 0,
    tempShield: 0,
    lastDamageTime: -Infinity,
    attackCooldown: 0,
    targetId: null,
    _skillInstances: [],
    _inCombat: false,
    _attackerCount: 0,
    // 对战模式专属标记：阵营 + 建筑层级 + 所属路（水晶用于触发超级兵、索敌用于阵营过滤）
    _mapFaction: faction,
    _mapTier: tier,
    _laneId: laneId || null,
    faction,
  };
  entity.currentHP = entity.baseStats.maxHP;

  const ctx = { entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc };
  // 塔身按建筑类型装配：防御塔（外/内/高地/枢纽塔）用普通塔身；
  // 召唤水晶/水晶枢纽用各自的专属塔身（描述其保护/重生规则，无武器）。
  // v36（Q4）：身份技能 = 技能槽第 1 位，标明塔类型并归组该层级特殊被动。
  const identityByTier = {
    outer: 'core_tier_outer', inner: 'core_tier_inner', base: 'core_tier_base',
    hq_tower: 'core_tier_hq', nexus_lane: 'core_nexus_lane', nexus_main: 'core_nexus_main',
  };
  const coreSkill = identityByTier[tier] || 'core_normal';
  entity._skillInstances.push({ id: ++CTX._uid, skillId: coreSkill, state: {} });

  // 水晶不攻击：不装备武器；其余建筑按地图配置固定分配武器（外增幅/内穿透/高地闪电杖）
  if (!isNexus && weapon) {
    const wInst = { id: ++CTX._uid, skillId: 'weapon_' + weapon, state: {} };
    entity._skillInstances.push(wInst);
    const wDef = skillLibrary[wInst.skillId];
    if (wDef?.onEquip) wDef.onEquip(entity.id, wInst, ctx);
  }

  // 对战模式防御塔默认技能：所有攻击型塔装备"冰霜镀层"（每分钟成长），
  // 内塔额外装备"防御塔镀层"（破裂爆发）。水晶类建筑不装。
  {
    // v36（Q4）：子被动装配移出 !isNexus 门（原来把 nexus 的 passive_nexus_regen 也关在门外 →
    // 水晶/枢纽的生命恢复被动从没装上，这就是"水晶没恢复"的 bug 根因）。
    // 各身份技能的 groupedChildren 声明了该层级应装配的特殊被动；此处据此装配。
    // 地图显式指定 skills（嚎哭深渊）时优先用地图配置。
    const growthByTier = { outer: 'passive_growth_outer', inner: 'passive_growth_inner', base: 'passive_growth_base', hq_tower: 'passive_growth_hq' };
    let towerDefaults = [];
    if (Array.isArray(skills)) {
      towerDefaults = [...skills];
    } else {
      if (!isNexus) {
        if (growthByTier[tier]) towerDefaults.push(growthByTier[tier]);
        // v37（Q1）：四层级都有加固城防（外/内=纯节点33/67/100；水晶=节点+2恢复；枢纽=40/70/100+5恢复）；
        // 水晶塔的800固定护盾拆为独立技能"钢铁烈阳护盾"（仅自身，无光环）。
        if (tier === 'outer') towerDefaults.push('passive_outer_fortify', 'passive_iron_line');
        // v39（Q5）：防御塔镀层从内塔移到水晶塔
        if (tier === 'inner') towerDefaults.push('passive_inner_fortify', 'passive_inner_bulwark');
        if (tier === 'base') towerDefaults.push('passive_base_fortify', 'passive_base_bulwark', 'passive_armor_plating');
        if (tier === 'hq_tower') towerDefaults.push('passive_last_stand', 'passive_hq_fortify');
        towerDefaults.push('passive_overload'); // v36 Q2：所有防御塔默认过载被动
      } else {
        towerDefaults.push('passive_nexus_regen'); // v36 Q4 修复：水晶/枢纽的生命恢复被动
      }
    }
    // ==================== v42: Apply map-level skill exclusions ====================
    const skillExcludeList = SkillLibrary._excludeSkills?.["tower:" + tier] || [];
    if (skillExcludeList.length) {
      towerDefaults = towerDefaults.filter(k => !skillExcludeList.includes(k));
    }
    for (const key of towerDefaults) {
      const inst = { id: ++CTX._uid, skillId: key, state: {} };
      entity._skillInstances.push(inst);
      const def = skillLibrary[key];
      if (def?.onEquip) def.onEquip(entity.id, inst, ctx);
    }
  }

  // Q5 修复：基地光环装在水晶枢纽上——原先写在 if(!isNexus) 块内，枢纽是 nexus 永远装不上，
  // 这就是"基地加成没生效"的根因。移到门外独立装配。
  if (tier === 'nexus_main') {
    const inst = { id: ++CTX._uid, skillId: 'passive_home_aura', state: {} };
    entity._skillInstances.push(inst);
    const def = skillLibrary['passive_home_aura'];
    if (def?.onEquip) def.onEquip(entity.id, inst, ctx);
  }

  entityContainer.add(entity);
  eventBus.emit('entity:spawn', { entityId: entity.id });
  uiManager.log(`${isNexus ? '💎 水晶' : '🏯 ' + tier + '塔'}（${faction === FACTIONS.BLUE ? '蓝方' : '红方'}）已生成`, 'spawn');
  return entity;
}
mapSystem.setCreateBuildingFn(createBuilding);

function createMinion(type, x, y, hpScale = 1.0, attrScale = 1.0, mapOpts = null) {
  // 阵营覆写合并：对战模式单位按阵营在共享模板上叠加差异字段（编辑器"仅蓝方/仅红方"页签写入）
  const tplBase = CONFIG.templates[type];
  if (!tplBase) return null;
  const ovr = mapOpts?.faction ? CONFIG.factionOverrides?.[mapOpts.faction]?.[type] : null;
  const tpl = ovr && Object.keys(ovr).length ? { ...tplBase, ...ovr } : tplBase;
  const entity = {
    id: ++CTX._uid,
    type: type,
    alive: true,
    pos: { x: x || 820, y: y || 400 },
    baseStats: { ...tpl },
    currentHP: tpl.maxHP * hpScale,   // baseStats.maxHP 在下方同步缩放——此前只乘 currentHP
    shieldFixedCurrent: (tpl.shieldFixedMax || 0) * hpScale,
    tempShield: 0,
    lastDamageTime: -Infinity,
    attackCooldown: 0,
    targetId: null,
    _skillInstances: [],
    _inCombat: false,
    _attackerCount: 0,
  };
  // 对战模式专属标记：不传 mapOpts 时（沙盒模式调用）这些字段都是 undefined，
  // CombatSystem/LaneMovementSystem 里的相关分支只在这些字段存在时才生效，完全不影响沙盒行为。
  if (mapOpts) {
    entity._mapFaction = mapOpts.faction;
    entity.faction = mapOpts.faction;
    entity._laneId = mapOpts.laneId;
    entity._laneDirection = mapOpts.direction;
  }
  // 波次成长的历史 bug：currentHP 乘了 hpScale 但 baseStats.maxHP 从未缩放，
  // 直接造成"当前生命超过最大生命"。maxHP 必须与 currentHP 同源缩放。
  entity.baseStats.maxHP = tpl.maxHP * hpScale;
  entity.baseStats.attackDamage = tpl.attackDamage * attrScale;
  entity.baseStats.armor = tpl.armor * attrScale;
  entity.baseStats.magicResist = tpl.magicResist * attrScale;
  entity.baseStats.onHitDamage = (tpl.onHitDamage || 0) * attrScale;
  // v42: apply map-level minion template override BEFORE growth, so growth stacks on top
  const tplOverride = mapOpts?.templateOverride;
  if (tplOverride) {
    Object.assign(entity.baseStats, tplOverride);
    entity.currentHP = entity.baseStats.maxHP;
    if (entity.baseStats.shieldFixedMax != null) entity.shieldFixedCurrent = entity.baseStats.shieldFixedMax;
  }
  // 对战模式固定值成长（Q2）：加法叠在模板/阵营覆写之上，只动 生命/攻击/双抗。
  // 沙盒模式走上面的乘法缩放（hpScale/attrScale），两套互不影响。
  const g = mapOpts?.growthFlat;
  if (g) {
    entity.baseStats.maxHP += g.hp;
    entity.currentHP += g.hp;
    entity.baseStats.attackDamage += g.ad;
    entity.baseStats.armor += g.res;
    entity.baseStats.magicResist += g.res;
  }
  entity.baseStats.shieldFixedMax = (tpl.shieldFixedMax || 0) * hpScale;
  entity.baseStats.healthRegen = tpl.healthRegen * attrScale;
  entity.baseStats.moveSpeed = tpl.moveSpeed || 30;
  entity.baseStats.attackRange = tpl.attackRange || 20;

  // 小兵被动自动装备：模板编辑器中若已自定义 _templateSkills（哪怕是空数组），
  // 优先按用户设置生效；未做过任何自定义时才回退到默认硬编码被动。
  // v42: base default passive map; merged with map-level minionDefaultPassives below
  const defaultPassiveMap = {

    'melee': ['passive_melee_rend'],
    'ranged': ['passive_ranged_rend'],
    'siege': ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend'],
    'super': ['passive_super_commander'],
    'ram': ['passive_siege_weapon'],   // v40：攻城车的全部特殊机制都由这条被动驱动
    'totem': ['passive_totem_guardian', 'passive_totem_awaken', 'passive_totem_nourish', 'passive_totem_aura'],
    'warlock': ['passive_warlock_aura'],
    'corrupt': ['passive_corrupt_strike'],
  };
  // v42: merge map-level minionDefaultPassives overrides
  const mapMinionPassives = (mapOpts && mapSystem.currentMap?.minionDefaultPassives) || {};
  const effectivePassiveMap = { ...defaultPassiveMap, ...mapMinionPassives };
  let passives = Array.isArray(tpl._templateSkills) ? tpl._templateSkills : (effectivePassiveMap[type] || []);

  // Q9：嚎哭深渊小兵不装配屠戮被动（地图 minionNoRend 标记经 mapOpts 传入）
  if (mapOpts?.noRend) passives = passives.filter(k => !k.endsWith('_rend'));
  for (const key of passives) {
    const inst = { id: ++CTX._uid, skillId: key, state: {} };
    entity._skillInstances.push(inst);
    const def = skillLibrary[key];
    if (def?.onEquip) {
      def.onEquip(entity.id, inst, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber, attrCalc
      });
    }
  }

  // 波次里程碑成长：每 milestoneEveryWaves 波，普通小兵获得额外增益。
  // 仅对沙盒模式小兵生效——对战模式小兵用的是 LaneWaveSystem 自己的独立波次计数，
  // 如果误用 window.CTX.waveNumber（沙盒计数），玩家如果先在沙盒玩了很久再切对战模式，
  // 对战小兵会莫名其妙继承一个完全不相关的高波次增益（真实发现的串扰问题，这里堵住）。
  if (!mapOpts) applyMilestoneGrowth(entity, type);

  // 模板编辑器中配置的默认状态效果
  if (Array.isArray(tpl._templateEffects)) {
    for (const effBlueprint of tpl._templateEffects) {
      effectRegistry.apply(entity.id, { ...effBlueprint }, `template_effect_${type}`);
    }
  }

  entityContainer.add(entity);
  eventBus.emit('entity:spawn', { entityId: entity.id });
  return entity;
}

// 每 10 波：小兵获得永久里程碑增益（普通小兵没有专属被动，靠此成长）
// 减伤封顶 40%（4 层 ×10%），全属性封顶 45%（3 层 ×15%），避免后期数值墙。
function applyMilestoneGrowth(entity, type) {
  const n = CTX.waveNumber || 0;
  const step = CONFIG.gameRules.milestoneEveryWaves || 10;
  const milestones = Math.floor(n / step);
  if (milestones <= 0) return;

  // 减伤：每里程碑 +10%，最多 4 层（封顶 40%）
  const drStacks = Math.min(milestones, 4);
  if (drStacks >= 1) {
    const id = effectRegistry.apply(entity.id, {
      name: '里程碑·坚韧', icon: '🎖', kind: 'stat', statKey: 'damageReduction',
      flatValue: 10, perStackFlat: 10, duration: Infinity, permanent: true,
      stackable: true, maxStacks: 4, stackPolicy: 'stack', stackKey: 'milestone_dr',
      description: '减伤提升（{stacks}/4层）',
    }, 'milestone_dr');
    const eff = effectRegistry.getEffect(id);
    if (eff) { eff.stacks = drStacks; effectRegistry._recalcEffectValues(eff); effectRegistry._updateDescription(eff); }
  }

  // 全属性：第 3 里程碑起，每里程碑 +15%，最多 3 层（封顶 45%）
  if (milestones >= 3) {
    const allStacks = Math.min(milestones - 2, 3);
    const id = effectRegistry.apply(entity.id, {
      name: '里程碑·强化', icon: '🎖', kind: 'stat', statKey: 'allStatsPct',
      flatValue: 15, perStackFlat: 15, duration: Infinity, permanent: true,
      stackable: true, maxStacks: 3, stackPolicy: 'stack', stackKey: 'milestone_all',
      description: '全属性提升（{stacks}/3层）',
    }, 'milestone_all');
    const eff = effectRegistry.getEffect(id);
    if (eff) { eff.stacks = allStacks; effectRegistry._recalcEffectValues(eff); effectRegistry._updateDescription(eff); }
  }
}

// ---------- 创建巨龙 ----------
function createDragon(type, opts = {}) {
  const tpl = CONFIG.templates.dragon;
  const isAncient = !!opts.isAncient;
  const element = opts.element;
  const abs = opts.absStats || { maxHP: 8000, armor: 40, magicResist: 40, attackDamage: 100 };

  // 龙的登场位置：对战模式用地图中路的中点（公平，不偏向任何一方水晶）；
  // 沙盒模式沿用原固定坐标。此前固定用 (850,200) 在对战模式里几乎贴着红方水晶/外塔，
  // 导致红方总能第一时间抢到龙、对蓝方明显不公平，这里修正。
  let dragonPos = { x: 850, y: 200 };
  if (mapSystem.active && mapSystem.currentMap) {
    // 之前取 lanes[0] 实际是"上路"而非注释声称的"中路"——龙一直刷在上路半途，修正为按 id 找中路。
    const lane = mapSystem.currentMap.lanes.find(l => l.id === 'mid') || mapSystem.currentMap.lanes[0];
    if (lane) {
      const mid = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
      dragonPos = { x: mid.x, y: mid.y };
    }
  }

  const entity = {
    id: ++CTX._uid,
    type: 'dragon',
    alive: true,
    pos: dragonPos,
    baseStats: { ...tpl },
    currentHP: abs.maxHP,
    shieldFixedCurrent: 0,
    tempShield: 0,
    lastDamageTime: -Infinity,
    attackCooldown: 0,
    targetId: null,
    _skillInstances: [],
    _inCombat: false,
    _attackerCount: 0,
    _element: element,
    _isAncient: isAncient,
  };
  // 绝对属性
  entity.baseStats.maxHP = abs.maxHP;
  entity.baseStats.armor = abs.armor;
  entity.baseStats.magicResist = abs.magicResist;
  entity.baseStats.attackDamage = abs.attackDamage;
  // 巨龙主动进场攻击塔
  entity.baseStats.moveSpeed = 22;
  entity.baseStats.attackRange = 60;
  entity.baseStats.baseAttackSpeed = 0.25;
  entity.baseStats.attackType = 'physical';

  if (isAncient) {
    entity.baseStats.label = '远古巨龙';
    entity._dragonColor = '#e67e22';
    entity._dragonIcon = '🐲';
  } else {
    const def = DRAGON_ELEMENTS[element];
    entity.baseStats.label = def ? def.label : '巨龙';
    entity._dragonColor = def ? def.color : '#c0392b';
    entity._dragonIcon = def ? def.icon : '🐉';
  }

  entityContainer.add(entity);
  eventBus.emit('entity:spawn', { entityId: entity.id });
  const label = isAncient ? '🐲 远古巨龙' : `${entity._dragonIcon} ${entity.baseStats.label}`;
  uiManager.log(`${label} 降临！击败它获得龙之增益`, 'spawn');
  return entity;
}
dragonSystem.setCreateEntity(createDragon);
waveSystem.setCreateMinion(createMinion);
// 对战模式成长（Q2 再重做）：纯固定值/波，杜绝复利后期爆炸，只动 最大生命/攻击力/双抗。
// 数值经仿真校准：10分钟（约20波）时穿透塔单发 ≈ 近战44.9%/远程69.0%/炮车13.7%/超级兵4.3% 生命，
// 对齐 LoL 参考值（45/70/14/5）。无百分比分量 → 负基值属性（如超级兵魔抗-30）天然只吃固定增量。
// 数值偏保守，为龙魂等后续增益留出空间。沙盒模式里程碑成长公式不受影响。
// Q10：攻击力成长降至原值 75%、双抗成长降至原值 33%（生命成长不变）。
const BATTLE_GROWTH_FLAT = {
  melee:  { hp: 7,  ad: 0.3,   res: 0.1 },
  ranged: { hp: 5,  ad: 0.375, res: 0.1 },
  // Q3：后期炮车过强 → 降生命成长(18→10)、增双抗成长(0.13→0.30)。
  // 定位从"血厚打不动"转为"抗性高但血量正常"：坦度保留，但不再是无解的移动堡垒。
  siege:  { hp: 10, ad: 0.9,   res: 0.30 },
  super:  { hp: 20, ad: 1.875, res: 0.1 },
  // v39（Q4）：攻城车——生命正常成长（同炮车 10/波），攻击力成长【非常慢】（0.1/波，
  // 约为常规的 1/4~1/9），双抗恒定 0 不成长。用户定稿：影响力随时间自然衰减，不加速后期。
  ram:    { hp: 10, ad: 0.1,   res: 0 },
  _default: { hp: 8, ad: 0.375, res: 0.1 },
};
function battleGrowthFlat(type) {
  const n = Math.max(0, (laneWaveSystem.waveNumber || 1) - 1); // 第1波为基准无成长
  const f = BATTLE_GROWTH_FLAT[type] || BATTLE_GROWTH_FLAT._default;
  return { hp: f.hp * n, ad: f.ad * n, res: f.res * n };
}
laneWaveSystem.setCreateMinion((type, x, y, faction, laneId, direction) => {
  // 对战模式小兵按 laneWaveSystem 自己的独立波次计数成长（不能用沙盒的 window.CTX.waveNumber，
  // 两套波次计数完全独立）。成长公式与沙盒模式一致：固定值线性增长 × 复合增长叠加。
  const ent = createMinion(type, x, y, 1, 1, { faction, laneId, direction, growthFlat: battleGrowthFlat(type), templateOverride: mapSystem.currentMap?.minionTemplates?.[type], noRend: !!mapSystem.currentMap?.minionNoRend });
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
eventBus.on('map:loaded', (d) => {
  CTX.__score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };
  weatherSystem.reset(); // 每次载图重新随机：起始权重、变化快慢（θ）全部重抽
  // v42: full state reset on map switch
  CTX.gameTime = 0;
  CTX.waveNumber = 0;
  CTX._nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
  laneWaveSystem.waveNumber = 0;
  laneWaveSystem._quickApplied = undefined;
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

// ---------- 按钮绑定 ----------
// 统一添加单位按钮（建塔 + 添加小兵 + 手动生成巨龙）
let _towerPlacementQueue = [];
function _processNextTowerPlacement() {
  if (_towerPlacementQueue.length === 0) return;
  const { weaponType, passiveKeys, faction } = _towerPlacementQueue.shift();
  uiManager.log(`🎯 请点击画布选择建塔位置（剩余 ${_towerPlacementQueue.length + 1} 个待放置）`, 'spawn');
  canvasController.armPlaceMode((worldX, worldY) => {
    const tower = createTower(worldX, worldY);
    // EQ2：对战模式手动建塔归属阵营（蓝/红/中立）。中立=独立一方：打红蓝双方，也被双方打。
    // 沙盒模式 faction 为 null，行为完全不变（塔固定打小兵、小兵固定打塔）。
    if (faction) {
      tower._mapFaction = faction;
      tower.faction = faction;
    }
    const oldWeapon = tower._skillInstances.find(s => s.skillId.startsWith('weapon_'));
    if (oldWeapon) {
      const oldDef = skillLibrary[oldWeapon.skillId];
      if (oldDef?.onUnequip) oldDef.onUnequip(tower.id, oldWeapon, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
      tower._skillInstances = tower._skillInstances.filter(s => s !== oldWeapon);
    }
    const newWeapon = weaponType !== 'none' ? { id: ++CTX._uid, skillId: 'weapon_' + weaponType, state: {} } : null;
    if (newWeapon) {
      tower._skillInstances.push(newWeapon);
      const newDef = skillLibrary['weapon_' + weaponType];
      if (newDef?.onEquip) newDef.onEquip(tower.id, newWeapon, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
    }
    const allPassives = ['passive_heavy_defense', 'passive_thorns', 'passive_frost_plating', 'passive_armor_plating', 'passive_overheat', 'passive_vampire', 'passive_phase'];
    const toRemove = tower._skillInstances.filter(s => allPassives.includes(s.skillId));
    for (const inst of toRemove) {
      const def = skillLibrary[inst.skillId];
      if (def?.onUnequip) def.onUnequip(tower.id, inst, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
      tower._skillInstances = tower._skillInstances.filter(s => s !== inst);
    }
    for (const key of passiveKeys) {
      const inst = { id: ++CTX._uid, skillId: key, state: {} };
      tower._skillInstances.push(inst);
      const def = skillLibrary[key];
      if (def?.onEquip) def.onEquip(tower.id, inst, {
        entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber || 0, attrCalc
      });
    }
    const fTag = faction === 'blue' ? '🔵蓝方' : (faction === 'red' ? '🔴红方' : (faction === 'neutral' ? '⚪中立' : ''));
    uiManager.log(`🏗️ ${fTag}塔 #${tower.id} 建造完成，武器: ${weaponType}，被动: ${passiveKeys.length}个`, 'spawn');
    // 继续放置队列中的下一个塔
    _processNextTowerPlacement();
  });
}

document.getElementById('addUnitBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  if (mapSystem.active) {
    uiManager.log('ℹ️ 当前是对战模式：手动添加的单位不属于任何阵营/路径，仅供测试', 'spawn');
  }
  UnitAddDialog.open({
    isBattle: () => mapSystem.active,
    onBuildTower: (weaponType, passiveKeys, faction) => {
      // 批量生成时可能一次性收到多个塔条目，串行进入选位模式，避免互相抢占
      _towerPlacementQueue.push({ weaponType, passiveKeys, faction: faction || null });
      if (_towerPlacementQueue.length === 1) _processNextTowerPlacement();
    },
    onAddMinion: (type, count, growth, faction, laneId) => {
      // 对战模式：带阵营的手动添加——出生点=该阵营水晶枢纽，走指定分路推线，
      // 成长按对战复利公式，默认被动/阵营覆写在 createMinion 内自动生效。
      if (faction && mapSystem.active && mapSystem.currentMap) {
        const nexus = mapSystem.currentMap.buildings.find(b => b.tier === 'nexus_main' && b.faction === faction);
        const px = nexus ? nexus.pos.x : 1776, py = nexus ? nexus.pos.y : 1776;
        const dir = faction === FACTIONS.BLUE ? 'forward' : 'reverse';
        const gf = growth ? battleGrowthFlat(type) : null;
        for (let i = 0; i < count; i++) {
          createMinion(type, px + (Math.random() - 0.5) * 16, py + (Math.random() - 0.5) * 16,
            1, 1, { faction, laneId: laneId || 'mid', direction: dir, growthFlat: gf, noRend: !!mapSystem.currentMap?.minionNoRend });
        }
        uiManager.log(`➕ ${faction === FACTIONS.BLUE ? '🔵蓝方' : '🔴红方'}生成 ${count} 个 ${type} 兵 → ${laneId || 'mid'} 路`, 'spawn');
        return;
      }
      const n = waveSystem.waveNumber || 1;
      const hpFixed = CONFIG.gameRules.hpFixedPerWave || 2;
      const hpComp = CONFIG.gameRules.hpCompPctPerWave || 0.3;
      const attrFixed = CONFIG.gameRules.attrFixedPerWave || 3.5;
      const attrComp = CONFIG.gameRules.attrCompPctPerWave || 0.4;
      const hpScale = growth ? (1 + hpFixed/100*n) * Math.pow(1+hpComp/100, n) : 1;
      const attrScale = growth ? (1 + attrFixed/100*n) * Math.pow(1+attrComp/100, n) : 1;
      for (let i = 0; i < count; i++) {
        createMinion(type, 820 + Math.random()*20 - 10, 400 + Math.random()*50 - 25, hpScale, attrScale);
      }
      uiManager.log(`➕ 生成 ${count} 个 ${type} 兵${growth ? ' (应用波次成长)' : ''}`, 'spawn');
    },
    onAddDragon: (element, ancient) => {
      const dstats = dragonSystem._dragonStats(dragonSystem.elementDragonSpawned + 1, ancient);
      const el = element || Object.keys(DRAGON_ELEMENTS)[Math.floor(Math.random() * Object.keys(DRAGON_ELEMENTS).length)];
      createDragon('dragon', { element: ancient ? null : el, isAncient: ancient, absStats: dstats });
      uiManager.log(`🐉 手动生成${ancient ? '远古巨龙' : (DRAGON_ELEMENTS[el]?.label || '巨龙')}`, 'spawn');
    },
    onEditSpawnRule: (type, returnCallback) => {
      AttributeEditor.openTemplateEditor(type, uiManager.log.bind(uiManager), returnCallback);
    },
  });
});

// 龙魂管理已整合进每座塔的统一编辑窗口（🐉 龙魂 tab），顶部按钮不再需要。

// 模板编辑器（打开顶层大类选择，可切换编辑所有单位类型）
document.getElementById('templateEditorBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode(); // 若正处于"点击画布建塔"选位模式，先取消，避免弹窗盖住画布后选位状态悬挂
  AttributeEditor.openTemplateEditorRoot(uiManager.log.bind(uiManager));
});

// 日志显示开关（默认隐藏）
document.getElementById('toggleLogBtn').addEventListener('click', () => {
  const logArea = document.getElementById('logArea');
  logArea.classList.toggle('show');
});

// 设置窗口（整合此前的跳过等待/暂停波次/清屏/暂停/重置波次，新增小兵/龙独立控制）
document.getElementById('settingsBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  SettingsDialog.open({ waveSystem, dragonSystem, entityContainer, mapSystem, laneWaveSystem }, uiManager.log.bind(uiManager));
});

// 模式切换（沙盒 / 对战）
function updateModeBtnLabel() {
  const btn = document.getElementById('modeBtn');
  if (btn) btn.textContent = mapSystem.active ? '⚔️ 对战模式' : '🗺️ 沙盒模式';
}
document.getElementById('modeBtn').addEventListener('click', () => {
  canvasController.cancelPlaceMode();
  ModeDialog.open({ mapSystem, waveSystem, onModeChanged: () => {
    updateModeBtnLabel();
    // 对战模式：相机自适应到地图声明的世界尺寸（召唤师峡谷 3552×3552，
    // 默认 zoom=1 只能看到左上角一角）；沙盒模式：恢复默认视角。
    if (mapSystem.active && mapSystem.currentMap?.world) {
      canvasController.fitToWorld(mapSystem.currentMap.world.w, mapSystem.currentMap.world.h);
    } else {
      canvasController.zoom = 1.0; canvasController.offsetX = 0; canvasController.offsetY = 0; canvasController.updateView();
    }
  } }, uiManager.log.bind(uiManager));
});
updateModeBtnLabel();

// ---------- 点选面板接线 ----------
WeatherPanel.init(weatherSystem);
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
// 游戏时间保持与现实同速。补步上限 MAX_SUBSTEPS 防"模拟自身超支→越补越欠"的死亡螺旋：
// 达到上限时丢弃欠账（表现为轻微慢动作），这只在模拟本体过载的极端情况下发生。
// 30Hz 模拟顺带把模拟开销砍半（移速 78px/s 下单步 2.6px，视觉无感）。
const SIM_DT = 1 / 30;
const MAX_SUBSTEPS = 4;
let _lastTs = 0, _acc = 0;

// 性能分解统计：滚动窗口累计 模拟/渲染/DOM 耗时，PerfHud 低频读取。
const PERF = { sim: 0, render: 0, dom: 0, n: 0, steps: 0, t: 0 };
CTX.__perf = PERF;

function stepSimulation(dt) {
  CTX.gameTime += dt;
  CTX._nextWaveTime = waveSystem.nextWaveTime;
  effectRegistry.update(dt);
  buffSystem.update(dt);
  // 对战模式激活时暂停沙盒波次（两套系统互斥，详见历史注释）
  if (!mapSystem.active) waveSystem.update(dt);
  dragonSystem.update(dt);
  combatSystem.update(dt);
  weatherSystem.update(dt);   // 天气演化（权重场，enabled=false 时零开销）
  mapSystem.update(dt);       // 召唤水晶重生计时（仅对战模式内部生效）
  laneWaveSystem.update(dt);
      laneMovementSystem.update(dt);
      collisionSystem.update(dt);
  laneAvengerSystem.update(dt); // v33 Q20：哀兵光环（0.5s 节奏内部节流）
  projectileSystem.update(dt);
}

function gameLoop(timestamp) {
  if (!_lastTs) _lastTs = timestamp;
  let realDt = (timestamp - _lastTs) / 1000;
  _lastTs = timestamp;
  if (realDt > 0.25) realDt = 0.25; // 标签页切回等极端间隔，不让累积器暴走

  const t0 = performance.now();

  // ===== v39（Q6）：游戏速度倍率 + 快进 =====
  // 速度倍率只放大【投喂给模拟的时间】，模拟步长 SIM_DT 恒定不变 → 物理/战斗判定完全一致，
  // 只是单位时间内跑的步数不同（0.5x 减半、2x 加倍）。
  // 快进（CTX.__ffRemain 秒）= 用户选定的 A 方案：真实加速模拟把这段时间跑完，
  // 战斗照常发生、结果真实，不是跳时钟。每帧最多补 FF_BUDGET 秒，避免单帧卡死。
  const speed = CTX.__gameSpeed || 1;
  let feed = realDt * speed;
  if (CTX.__ffRemain > 0 && !CTX.gamePaused) {
    const FF_BUDGET = 2.0; // 每帧最多推进 2 秒模拟时间（约 60 个子步）
    const chunk = Math.min(CTX.__ffRemain, FF_BUDGET);
    feed += chunk;
    CTX.__ffRemain -= chunk;
    if (CTX.__ffRemain <= 0) CTX.__ffRemain = 0;
  }

  if (!CTX.gamePaused) {
    _acc += feed;
    let steps = 0;
    const maxSteps = CTX.__ffRemain > 0 || feed > realDt * 1.5 ? 240 : MAX_SUBSTEPS;
    while (_acc >= SIM_DT && steps < maxSteps) {
      // 每个模拟步都要让属性缓存失效并重建空间网格——位置/效果在步进中变化
      attrCalc.tick();
      entityContainer.rebuildGridIfNeeded(attrCalc._frame);
      stepSimulation(SIM_DT);
      _acc -= SIM_DT;
      steps++;
    }
    if (_acc > SIM_DT) _acc = SIM_DT; // 丢弃超出上限的欠账
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
  renderer3d?.render(canvasController);
  const t2 = performance.now();
  uiManager.update();
  WeatherPanel.update(); // 天气滚动条（关闭时零开销）
  const t3 = performance.now();

  PERF.sim += t1 - t0; PERF.render += t2 - t1; PERF.dom += t3 - t2; PERF.n++;
  requestAnimationFrame(gameLoop);
}

// ---------- 启动 ----------
// v33（Q15）：进入游戏默认为【对战模式 - 召唤师峡谷】。
// 沙盒模式的首波倒计时仍预置好——用户切回沙盒时行为与原来一致（但不再自动放一座初始塔，
// 对战模式下那座塔会以无阵营单位残留在峡谷正中，纯属干扰）。
waveSystem.nextWaveTime = CONFIG.gameRules.firstWaveDelay || 20;
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

