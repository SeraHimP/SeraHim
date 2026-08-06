/**
 * factories.js —— 实体工厂：塔 / 对战建筑 / 小兵 / 巨龙（v43 P1-④ 从 main.js 搬来）
 *
 * ==================== 为什么搬 ====================
 * main.js 曾经同时是四样东西：模块装配、实体工厂、按钮接线、游戏循环。
 * 1171 行里工厂占了 480 行，于是"改一条小兵默认被动"要在一个跟渲染循环、
 * 按钮回调混在一起的文件里翻。搬出来之后 main.js 回到它该干的事：装配。
 *
 * ==================== 这次搬迁的性质 ====================
 * **纯位移**：四个函数的函数体逐字未动，一个字符都没改。
 * 唯一的变化是它们原来靠 main.js 的模块作用域拿到那一堆单例，
 * 现在改成由 createFactories(deps) 一次性注入。
 *
 * ==================== 为什么用"模块级 let + 一次注入"而不是闭包 ====================
 * 把函数体裹进 createFactories 的闭包里，需要给 480 行**整体缩进两格**。
 * 那会让 diff 变成"整块重写"，审查时根本看不出到底改没改逻辑 ——
 * 而这次唯一要保证的就是"没改逻辑"。所以这里用模块级绑定 + 一次性赋值：
 * 语义与搬迁前的 main.js 模块作用域**完全一致**（全局单例，一个进程一份），
 * 而 diff 是干净的整块移动。
 * 代价是这个模块有隐式初始化顺序要求 —— 用 _assertReady 显式报错兜住，
 * 免得将来有人先 import 再忘了 createFactories，拿到一堆 undefined 报个天书。
 */
import { CONFIG } from '../data/Config.js';
import { CTX } from './GameContext.js';
import { equipSkill } from './skillParams.js';
import { FACTIONS } from '../systems/FactionSystem.js';
import { DRAGON_ELEMENTS } from '../systems/DragonSystem.js';
// createBuilding 里有一处读的是 SkillLibrary._excludeSkills（地图级技能排除表）。
// 它与下面注入的 skillLibrary 是**同一个对象**（main.js 里就是 `const skillLibrary = SkillLibrary`），
// 这里照原样 import 一份，是为了让搬过来的函数体一个字符都不用改 —— 这次搬迁的
// 唯一保证就是"没改逻辑"，任何顺手的重命名都会让审查失去这个保证。
import { SkillLibrary } from './SkillLibrary.js';

// 由 createFactories 注入的引擎单例。搬迁前它们是 main.js 的模块级 const，
// 现在是这里的模块级 let —— 对四个函数体而言完全等价。
let entityContainer, effectRegistry, eventBus, skillLibrary, attrCalc, mapSystem, dragonSystem, uiManager;

/**
 * 注入依赖并取回四个工厂。main.js 在所有系统构造完之后调用一次。
 * 返回的函数引用是稳定的（不是每次新建），可以直接存进 CTX / 传给各系统。
 */
export function createFactories(deps) {
  if (!deps) throw new Error('createFactories: 缺少依赖包');
  for (const k of ['entityContainer', 'effectRegistry', 'eventBus', 'skillLibrary',
                   'attrCalc', 'mapSystem', 'dragonSystem', 'uiManager']) {
    if (!deps[k]) throw new Error('createFactories: 依赖缺失 ' + k);
  }
  ({ entityContainer, effectRegistry, eventBus, skillLibrary,
     attrCalc, mapSystem, dragonSystem, uiManager } = deps);
  return { createTower, createBuilding, createMinion, createDragon, applyMilestoneGrowth };
}

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
  // v43 P0-②：所有装备点统一走 equipSkill —— 它在 onEquip 之前解析 _params。
  equipSkill(entity, 'core_normal', ctx, skillLibrary);

  // 默认武器：读取模板设置的默认武器（模板编辑器"武器"tab），否则用穿透型
  // （v33：增幅型武器已删除，其"升温"被并入穿透型）
  const defaultWeapon = tpl._templateWeapon || 'piercing';
  if (defaultWeapon !== 'none') {
    equipSkill(entity, 'weapon_' + defaultWeapon, ctx, skillLibrary);
  }

  // 默认被动（模板编辑器"被动技能"tab 里勾选的）
  if (Array.isArray(tpl._templateSkills)) {
    for (const key of tpl._templateSkills) equipSkill(entity, key, ctx, skillLibrary);
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
  // 分层塔属性解析（用户定稿：【模板覆盖地图】）——
  //   地图 tierStats（初始值） → CONFIG.towerTierOverrides[tier]（共享覆写）
  //   → CONFIG.factionOverrides[faction]['tower_'+tier]（该阵营覆写）
  // 覆写层只存"用户改过的字段"，没改的字段自然落回地图数值 → 不改就行为不变。
  const s = { ...(stats || {}),
              ...(CONFIG.towerTierOverrides?.[tier] || {}),
              ...(CONFIG.factionOverrides?.[faction]?.['tower_' + tier] || {}) };
  const entity = {
    id: ++CTX._uid,
    type: 'tower',
    alive: true,
    pos: { x: pos.x, y: pos.y },
    baseStats: {
      ...tpl,
      // ==================== v43 Q9：覆写从"白名单"改成"模板里有的键都能盖" ====================
      // 用户："编辑界面依旧有bug，伤害类型还是显示为物理"。
      // 根因不在编辑器：这里原本是一张**写死的八字段白名单**
      //（maxHP/armor/magicResist/attackDamage/baseAttackSpeed/shieldFixedMax/healthRegen/attackRange），
      // 白名单以外的一切覆写在建塔那一刻就被丢掉了。被丢掉的包括：
      //   attackType（本次报的）、bulletSpeed、attackSpeedRatio、bonusAttackSpeedPct、
      //   四个穿透字段、damageReduction/damageBlock、shieldRegenRate、tempShieldDecayPct、
      //   onHitDamage/onHitPercentDamage、damageConvertPct/lifeStealPct/damageAmpPct、
      //   allStatsPct、healShieldPowerPct……
      // 编辑器面板读的是 towerTierEffective（叠加链算出来的值），所以面板上改了会"显示成功"，
      // 场上的塔却按模板值打——又一个本仓库反复出现的"编辑器写 A、运行时读 B"。
      // 现在改成：**凡是塔模板里存在的键，覆写层都能盖**。非模板键（weapon/skills/size 等
      // 地图配置）照旧不进 baseStats。
      ...Object.fromEntries(Object.entries(s).filter(([k, v]) => (k in tpl) && v !== undefined)),
      // 固定护盾例外：语义是"地图没写就当 0"（不回落到模板值），与改动前逐位一致。
      shieldFixedMax: s.shieldFixedMax ?? 0,
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
  equipSkill(entity, coreSkill, ctx, skillLibrary);

  // 武器装配（Q4 定稿：**所有建筑都可以装武器**，含召唤水晶/水晶枢纽，
  // 只是后两者默认 'none'）。解析顺序：模板编辑器的分层覆写 → 地图给该建筑配的武器。
  //   · 旧实现有两处毛病：① `!isNexus` 把水晶类彻底挡在门外，想让水晶开火根本没有入口；
  //     ② 完全无视模板编辑器 —— 编辑器写的是 CONFIG.templates.tower._templateWeapon，
  //     而这里读的是地图字段，于是"改了武器不生效"（用户报的 Q4）。
  const tierW = CONFIG.towerTierWeapon?.[tier];
  const wKey = tierW !== undefined ? tierW : (isNexus ? 'none' : weapon);
  if (wKey && wKey !== 'none') {
    equipSkill(entity, 'weapon_' + wKey, ctx, skillLibrary);
    // 水晶类的 tierStats 里 攻击力/攻速 是 0（它们本来不打人）。装了武器却是 0 就等于
    // 装了个哑炮：攻速 0 → 冷却算出 Infinity，永远开不了火。所以只要真装了武器，
    // 这两项为 0 时回落到塔模板值 —— "装上武器就能打"。想调具体数值走分层属性覆写。
    if (!(entity.baseStats.attackDamage > 0)) entity.baseStats.attackDamage = tpl.attackDamage;
    if (!(entity.baseStats.baseAttackSpeed > 0)) entity.baseStats.baseAttackSpeed = tpl.baseAttackSpeed;
  }

  // 对战模式防御塔默认技能：所有攻击型塔装备"冰霜镀层"（每分钟成长），
  // 内塔额外装备"防御塔镀层"（破裂爆发）。水晶类建筑不装。
  {
    // v36（Q4）：子被动装配移出 !isNexus 门（原来把 nexus 的 passive_nexus_regen 也关在门外 →
    // 水晶/枢纽的生命恢复被动从没装上，这就是"水晶没恢复"的 bug 根因）。
    // 各身份技能的 groupedChildren 声明了该层级应装配的特殊被动；此处据此装配。
    // 地图显式指定 skills（嚎哭深渊）时优先用地图配置。
    const growthByTier = { outer: 'passive_growth_outer', inner: 'passive_growth_inner', base: 'passive_growth_base', hq_tower: 'passive_growth_hq' };
    // 加固城防属于【层级身份】的一部分，不是可有可无的默认被动 ——
    // 身份技能 core_tier_* 的面板文案是从 mergedSkills（含 fortify）现拼出来的，
    // 也就是说：只要这座塔是"外侧防御塔"，面板上就写着"三个生命节点 33%/67%/100%"。
    const fortifyByTier = { outer: 'passive_outer_fortify', inner: 'passive_inner_fortify', base: 'passive_base_fortify', hq_tower: 'passive_hq_fortify' };
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
        if (tier === 'base') towerDefaults.push('passive_base_fortify', 'passive_armor_plating'); // Q3：水晶塔不再默认装钢铁烈阳护盾(passive_base_bulwark)
        if (tier === 'hq_tower') towerDefaults.push('passive_hq_fortify');   // 用户定稿：删除不生效的"绝望反击"
        towerDefaults.push('passive_overload'); // v36 Q2：所有防御塔默认过载被动
      } else {
        towerDefaults.push('passive_nexus_regen'); // v36 Q4 修复：水晶/枢纽的生命恢复被动
      }
    }
    // ==================== 加固城防：地图显式指定 skills 时也必须补上 ====================
    // 用户："XX加固城防中的生命节点失效（嚎哭深渊，扭曲丛林）"。
    // 根因不是节点算错了，而是 fortify **压根没装上**：
    // 这两张图的地图数据给建筑写了显式 skills（为了换成本图专属的成长/钢铁防线），
    // 而上面那句 `towerDefaults = [...skills]` 是**整体替换** —— 默认列表里的 fortify
    // 连同别的一起被顶掉了，_regenCapHP 从没被设过。
    // 可身份技能（core_tier_*）是无条件装的，它的面板照样写着"三个生命节点"——
    // 于是"看得见、写得明白、就是不生效"。
    // 这里只补 fortify 一项，不补 iron_line / overload / plating 那些：
    // 那几个是"默认配置"，地图有权换掉；而 fortify 是身份技能承诺过的东西，
    // 面板上写了就必须真的有。地图仍可用 excludeSkills 显式排除（下面那一步）。
    if (!isNexus && fortifyByTier[tier] && !towerDefaults.includes(fortifyByTier[tier])) {
      towerDefaults.unshift(fortifyByTier[tier]);
    }
    // ==================== v42: Apply map-level skill exclusions ====================
    const skillExcludeList = SkillLibrary._excludeSkills?.["tower:" + tier] || [];
    if (skillExcludeList.length) {
      towerDefaults = towerDefaults.filter(k => !skillExcludeList.includes(k));
    }
    // 模板编辑器的分层被动覆写（用户定稿："所有的都不要硬编码，都应该是可编辑的软编码"）。
    // 与小兵 _templateSkills 同语义：显式设过就完全由它决定（空数组=不装），没设过才走上面的默认。
    // 放在排除表之后：玩家在编辑器里的显式选择优先于地图排除规则。
    const tierSkillOverride = CONFIG.towerTierSkills?.[tier];
    if (Array.isArray(tierSkillOverride)) towerDefaults = [...tierSkillOverride];
    for (const key of towerDefaults) equipSkill(entity, key, ctx, skillLibrary);
  }

  // Q5 修复：基地光环装在水晶枢纽上——原先写在 if(!isNexus) 块内，枢纽是 nexus 永远装不上，
  // 这就是"基地加成没生效"的根因。移到门外独立装配。
  // 分层被动覆写生效时，基地光环是否装备由那份清单说了算（否则会与清单里的同一项重复装配）。
  if (tier === 'nexus_main' && !Array.isArray(CONFIG.towerTierSkills?.nexus_main)) {
    equipSkill(entity, 'passive_home_aura', ctx, skillLibrary);
  }

  entityContainer.add(entity);

  // 分层默认状态（模板编辑器"状态"tab）。此前对战模式的建筑完全没有这条路径——
  // tpl._templateEffects 只在沙盒 createTower 里被读，所以编辑器里配的状态对地图塔从不生效。
  const tierEffects = CONFIG.towerTierEffects?.[tier];
  if (Array.isArray(tierEffects)) {
    for (const bp of tierEffects) effectRegistry.apply(entity.id, { ...bp }, 'template_effect_tier');
  }

  // v43：补发本阵营已有的龙之奖励（巨龙之力各层 + 龙魂）。
  // 不补的话，成魂之后新建/重生的建筑全是裸的 —— 奖励等于几十秒后自动失效。
  dragonSystem.equipExistingSoul(entity);
  eventBus.emit('entity:spawn', { entityId: entity.id });
  uiManager.log(`${isNexus ? '💎 水晶' : '🏯 ' + tier + '塔'}（${faction === FACTIONS.BLUE ? '蓝方' : '红方'}）已生成`, 'spawn');
  return entity;
}

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
    // 三个支援兵种（用户定稿重做）。旧的 totem_guardian/awaken/nourish/sacrifice
    // 仍在 SkillLibrary 里（编辑器可手动装备），但不再默认装配 —— 它们的效果
    // 与新的三件套重叠，同时装上会双份减伤、双份护盾。
    'totem': ['passive_totem_aura', 'passive_totem_mend', 'passive_totem_bulwark'],
    'warlock': ['passive_warlock_aura', 'passive_warlock_attune'],
    'corrupt': ['passive_corrupt_strike'],
  };
  // v42: merge map-level minionDefaultPassives overrides
  const mapMinionPassives = (mapOpts && mapSystem.currentMap?.minionDefaultPassives) || {};
  const effectivePassiveMap = { ...defaultPassiveMap, ...mapMinionPassives };
  let passives = Array.isArray(tpl._templateSkills) ? tpl._templateSkills : (effectivePassiveMap[type] || []);

  // Q2：技能的 minWave = 【默认装配波次门槛】。默认装配（非模板编辑器 _templateSkills）下，
  // 当前波次未达门槛的技能不装上——如炮兵指挥官第20波起才默认装备（20波前不装、不显示）。
  // 玩家在模板编辑器里手动设的 _templateSkills 走上面的分支、完全不受门槛限制，任何波次都装、都生效。
  if (!Array.isArray(tpl._templateSkills)) {
    const curWave = CTX.waveNumber || window.waveNumber || 0;
    passives = passives.filter(k => (skillLibrary[k]?.minWave || 0) <= curWave);
  }

  // （原来这里有 `if (mapOpts?.noRend) …` —— 嚎哭深渊靠地图字段 minionNoRend 摘掉屠戮。
  //   用户本轮定稿"所有地图小兵默认装备屠戮"，那条开关与它的整条传参链一起删掉了：
  //   留着一个没有任何地图会设的字段，只会让下一个人以为"屠戮还能按图关"。）
  for (const key of passives) {
    equipSkill(entity, key, {
      entityContainer, effectRegistry, eventBus, waveNumber: CTX.waveNumber, attrCalc
    }, skillLibrary);
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
  // v43：新出的大型小兵也要拿到本阵营已有的龙之奖励（见 createBuilding 那条同样的注释）。
  // equipExistingSoul 内部按 SOUL_REWARD_OK 过滤，近战/远程会被自然排除。
  dragonSystem.equipExistingSoul(entity);
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
  // ==================== v43：龙从上/下龙坑交替出，走对应的路推向某一方基地 ====================
  // 用户定稿："上路的走到蓝方，下路走到红方。""龙永久存活，就像是敌方小兵一样推进到基地。"
  //
  // 兵线的 waypoints 一律是【蓝方基地 → 红方基地】的顺序，所以：
  //   forward = 推向红方，reverse = 推向蓝方。
  // 于是：上坑 → 上路 → reverse（推蓝方）；下坑 → 下路 → forward（推红方）。
  //
  // 龙**没有阵营**（_mapFaction = 'neutral'）：canTarget 里中立与红蓝互为敌对，
  // 所以两边都会打它、它也打两边挡路的一切。它挂上 _laneId/_laneDirection 之后
  // 自动被 LaneMovementSystem 接管（那边的过滤条件就是 `m._mapFaction && m._laneId`），
  // 与小兵完全同一套行进/绕障/接敌逻辑 —— 不另写一份寻路。
  let dragonLane = null, dragonDir = 'forward';
  if (mapSystem.active && mapSystem.currentMap) {
    const lanes = mapSystem.currentMap.lanes || [];
    const pitSide = opts.pitSide === 'bot' ? 'bot' : 'top';
    // 路：优先取同名的那条；没有（如嚎哭深渊只有 mid）就退到唯一那条。
    const laneId = lanes.some(l => l.id === pitSide) ? pitSide
                 : (lanes.find(l => l.id === 'mid') ? 'mid' : (lanes[0] && lanes[0].id));
    const lane = lanes.find(l => l.id === laneId);
    if (lane) {
      dragonLane = lane.id;
      dragonDir = (pitSide === 'top') ? 'reverse' : 'forward';
      // 出生点：优先用真正的龙坑（navgrid 峡谷有 baron/dragon 两个），
      // 上坑取 baron（上半河道）、下坑取 dragon（下半河道）；没有龙坑的图退到兵线中点。
      const pit = mapSystem.getPit?.(pitSide === 'top' ? 'baron' : 'dragon');
      if (pit) dragonPos = { x: pit.x, y: pit.y };
      else {
        const mid = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
        dragonPos = { x: mid.x, y: mid.y };
      }
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
    // v43：中立 + 挂到兵线上，由 LaneMovementSystem 驱动（与小兵同一套逻辑）
    _mapFaction: 'neutral',
    faction: 'neutral',
    _laneId: dragonLane,
    _laneDirection: dragonDir,
  };
  // 绝对属性
  entity.baseStats.maxHP = abs.maxHP;
  entity.baseStats.armor = abs.armor;
  entity.baseStats.magicResist = abs.magicResist;
  entity.baseStats.attackDamage = abs.attackDamage;
  // v43：战斗属性全部软编码到 CONFIG.gameRules.dragon.combat（原先写死在这里）。
  // 形状按用户定稿：攻击力低→高、攻速低、血量/双抗低→高 —— 前三项由上面的
  // dragonCurve 提供（已经是这个形状），这里补的是"会动、够得着、带溅射"。
  {
    const c = (CONFIG.gameRules.dragon && CONFIG.gameRules.dragon.combat) || {};
    entity.baseStats.moveSpeed = c.moveSpeed ?? 25;
    entity.baseStats.attackRange = c.attackRange ?? 200;
    entity.baseStats.baseAttackSpeed = c.baseAttackSpeed ?? 0.4;
    entity.baseStats.attackSpeedRatio = 0.667;
    entity.baseStats.attackType = c.attackType || 'physical';
    // 溅射：复用引擎既有的 splashRadius 通道（攻城车用的是同一条）
    entity.baseStats.splashRadius = c.splashRadius ?? 90;
    entity.baseStats.bulletSpeed = 0;   // 近身挥击，不走弹道
  }

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
  // v45：元素龙自带对应的龙魂（1 层）+ 巨龙之力（该元素已死数 + 1 层）。
  //
  // ⚠️ 这一句原来写在 DragonSystem.spawnDragon() 里，用户实测"元素龙并没有自带"。
  // 根因不是发放逻辑错了（单测里它一直是对的），而是**龙有两条出生路径**：
  //   ① DragonSystem.spawnDragon()  —— 计时刷新
  //   ② main.js 的 onAddDragon()    —— 设置里的"手动生成龙"，直接调 createDragon
  // 挂在 ① 上就等于只覆盖了一半，手动生成出来的龙是裸的。
  // 本仓库这个形状已经犯过好几次（攻城模式、重生规则都是"一件事写了半份在两处"）。
  // 正确的挂点是**实体真正诞生的这一处**，只有一个，任何新的生成入口都自动覆盖。
  dragonSystem.applyDragonSelfBuffs(entity);
  eventBus.emit('entity:spawn', { entityId: entity.id });
  const label = isAncient ? '🐲 远古巨龙' : `${entity._dragonIcon} ${entity.baseStats.label}`;
  uiManager.log(`${label} 降临！击败它获得龙之增益`, 'spawn');
  return entity;
}
