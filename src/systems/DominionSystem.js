/**
 * DominionSystem.js —— 统治战场·水晶之痕：据点占领 + 动态出兵 + 水晶掉血
 *
 * 设计依据：docs/DOMINION-CRYSTAL-SCAR-DESIGN.md（用户拿这份方案问过 ChatGPT，
 * 逐条核实/校正后采纳，全部数值取自 CONFIG.dominion，起草值待 balance_matrix 校准）。
 *
 * ==================== 与现有引擎的关系：新增系统，不改动其它系统 ====================
 * 这是一个独立系统（跟 DragonSystem/WeatherSystem 平级），不 import 其它 systems
 * （见 docs/DEVELOPMENT.md §2"系统间禁止互相 import"）。main.js 里做三处注入：
 *   combat.setDominionSystem(this) —— CombatSystem 命中据点时转发到这里，不再走
 *     正常的 HP 伤害结算（据点没有 HP 概念，占领进度是另一条完全独立的数值轴）。
 *   this.setCreateMinion(fn) —— 复用 main.js 已有的 createMinion 工厂 + 波次成长
 *     曲线（跟 laneWaveSystem.setCreateMinion 同一个模式，出的兵享受同一套成长）。
 *   eventBus 监听 map:loading（在建塔之前重置+读取新地图数据，跟 DragonSystem.
 *     resetRun() 挂在同一个事件、同一个理由：必须早于建塔，见那边的头注）。
 *
 * ==================== 占领机制的核心设计：为什么不用"三态+独立进度条"====================
 * 直觉上"归属(蓝/中立/红) + 占领进度(0~100)"要两个字段，这里只用一个有符号值
 * capturePct ∈ [-100,100]：
 *   - 中立时（captureOwner==='neutral'）：符号就是当前争夺的领先方，双方都能推。
 *   - 一旦推到 ±100（captureFull），归属"粘"在那一方——己方打不动自己的点
 *     （canTarget 天然禁止同阵营互相攻击，不需要额外代码），只有敌方持续攻击
 *     才能把它从 100 推回 0；推到 0 才重新变回中立，从 0 开始被两边争夺。
 * 这精确对应用户原话："红方占领进度为0之后，变为中立，此时继续攻击累积蓝方
 * 占领进度，直到完全占领"——归属在【推到 0 之前】全程粘着红方，不是符号一
 * 过零就立刻切换（那样红方自己反而没法维持住快被推平的地盘）。
 *
 * ==================== 据点为什么复用 tower 类型 ====================
 * 目标是让【现有的索敌/移动/攻击 AI 零改动】就能正确处理据点：
 *   - AISystem.scanEnemies 用 canTarget(minion._mapFaction, otherFaction) 判断
 *     能不能打，不看 type——据点声明成 _mapFaction:'neutral' 时，两边小兵都会把
 *     它当合法目标（跟中立野怪/巨龙同一条判据），不需要新写目标获取逻辑。
 *   - LaneMovementSystem"射程内必停下打"这条规则同样不看 type，据点往路上一放，
 *     路过的小兵自然会停下来打——这正是"塔位必须卡在路径上"这条规则要生效的
 *     前提（见设计文档规则 8）。
 *   - 已被占领的据点要"主动开火"（设计文档 5.2）：只要给它一个正的 attackDamage，
 *     现成的塔攻击循环就会自动生效，不需要另外写一套"据点开火"逻辑。
 * 唯一需要特殊处理的地方是【伤害结算】：据点没有 HP，CombatSystem 命中据点时
 * 必须整个绕开正常的护甲/护盾/伤害转化那一整套，改成调用这里的
 * applyCapturePressure()——两者是完全解耦的两套数值（设计文档 5.1 节的核心结论），
 * 混在一起算就会出现"以后调兵种伤害，据点争夺节奏也跟着变"这种不该有的耦合。
 */
import { CONFIG } from '../data/Config.js';
import { FACTIONS } from './FactionSystem.js';
import { equipSkill } from '../core/skillParams.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { buildWaveOrder } from '../data/waveComposition.js';

/**
 * 一段(laneId,direction)对应的"伪路 id"——2026-09-26 用户报"水晶之痕地图中的
 * 实际出兵编排和模板编辑器中的对应不上"，根因是据点出兵原来自己维护一份
 * CONFIG.dominion.waveBudget，完全绕开 waveComposition.js 的 compositionFor()
 * （模板编辑器"出兵编排"页读写的就是这一套，两边各算各的，编辑器改了没用）。
 * 现在据点出兵改走 compositionFor()，但这条环形兵线物理上只有一个 laneId
 * （'ring'），装不下"顺时针/逆时针各自的编排"这两份数据，所以拿 direction
 * 也编进一个（阵营×路）二维网格能认的 key 里——与 dominion_crystal_scar.js
 * 的 waveEditorLaneIds、CONFIG.gameRules.laneWaveCompositionByLane 的
 * ring_fwd/ring_rev 是同一套约定，改其中一处要三处一起看。
 */
function pseudoLaneId(seg) {
  return `${seg.laneId}_${seg.direction === 'reverse' ? 'rev' : 'fwd'}`;
}

export class DominionSystem {
  constructor(entities, eventBus) {
    this.entities = entities;
    this.eventBus = eventBus;
    this.effectRegistry = null; // main.js 注入：装/卸武器技能的 onEquip/onUnequip 需要它
    this.createMinion = null; // main.js 注入：(type,x,y,faction,laneId,direction) => entity
    this.active = false;      // 只有声明了 dominionNodes 的地图才会激活这套机制
    this.nodes = [];          // 5 个据点 + 2 个基地节点，统一结构（见 initMap 头注）
    this._waveTimer = 0;
    this._waveCount = 0;
  }

  setCreateMinion(fn) { this.createMinion = fn; }
  setEffectRegistry(effectRegistry) { this.effectRegistry = effectRegistry; }

  /** main.js 监听 eventBus 'map:loading' 时调用——必须早于建塔（同 DragonSystem.resetRun）。 */
  reset() {
    this.nodes = [];
    this.active = false;
    this._waveTimer = 0;
    this._waveCount = 0;
  }

  /**
   * 地图声明 `dominionNodes` 字段（7 个节点：5 据点 kind:'point' + 2 基地
   * kind:'base'，见 dominion_crystal_scar.js 头注的具体形状）才会激活这套机制，
   * 普通地图（召唤师峡谷等）不受任何影响——这是本系统"新增而不改动其它地图"
   * 的落地方式。
   *
   * 只给 kind:'point' 的节点建实体：kind:'base' 的两个节点复用地图 buildings
   * 数组里已经建好的 nexus_main 水晶实体（水晶本身走现有塔管线，这里只需要
   * 记住它的出兵方向信息）。
   */
  initMap(map) {
    this.reset();
    const nodes = map?.dominionNodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    this.active = true;
    // _lastHit：蓝/红两方【最近一次】对这个据点造成占领压力的游戏时刻，供
    // _tickContest() 判定"双方是否同时在场"与"是否已经脱战"——见那个方法的头注。
    this.nodes = nodes.map((n) => ({
      ...n, capturePct: 0, captureOwner: FACTIONS.NEUTRAL, entity: null,
      _lastHit: { [FACTIONS.BLUE]: -Infinity, [FACTIONS.RED]: -Infinity },
    }));
    const tpl = CONFIG.templates.tower;
    for (const node of this.nodes) {
      if (node.kind !== 'point') continue;
      const entity = {
        id: ++window._uid,
        type: 'tower',
        isCapturePoint: true,
        alive: true,
        pos: { x: node.pos.x, y: node.pos.y },
        // 没有 HP 概念：maxHP/currentHP 给一个恒定占位值，CombatSystem 的伤害
        // 结算被 isCapturePoint 分支整个绕开，这两个字段永远不会被改动。
        baseStats: { ...tpl, attackDamage: 0, attackRange: 0, maxHP: 1, healthRegen: 0, shieldFixedMax: 0 },
        currentHP: 1,
        shieldFixedCurrent: 0,
        tempShield: 0,
        lastDamageTime: -Infinity,
        attackCooldown: 0,
        targetId: null,
        _skillInstances: [],
        _inCombat: false,
        _attackerCount: 0,
        _mapFaction: FACTIONS.NEUTRAL,
        faction: FACTIONS.NEUTRAL,
        _mapTier: 'capture_point',
        // 用户定稿："中立据点不显示血条，画板上显示占领进度（用不同颜色区分），
        // 属性面板用法力条显示"——这两份镜像字段是 resourceBar.js/UnitLayer.js
        // 读占领进度的唯一来源（那两处不认识 DominionSystem，只读实体本身的字段），
        // 见 _advance/_setOwner 里的 _syncCaptureDisplay()。
        _capturePct: 0,
        _captureOwner: FACTIONS.NEUTRAL,
        // 用户定稿："两方不能同时占领据点……据点进入不可被占领状态（不可被
        // 双方选中）"——FactionSystem.isStructureProtected() 读这个字段，
        // 见 _tickContest() 的维护逻辑。
        _contested: false,
      };
      this.entities.add(entity);
      node.entity = entity;
    }
    // 召唤水晶（nexus_lane）自带穿透型子弹+物理攻击（用户定稿），但全局
    // CONFIG.towerTierWeapon.nexus_lane 固定是 'none'（所有地图的召唤水晶默认
    // 不开火），常规的"地图 buildings[].weapon"装配路径会被这条全局配置直接
    // 顶掉——跟据点占领后开火踩的是同一个坑（见 _setOwner 头注），这里同样
    // 只能绕开正常武器装配、直接调用 equipSkill。攻击力/射程/攻速走地图自己
    // 的 tierStats.nexus_lane 覆写（见 dominion_crystal_scar.js），不需要在
    // 这里再改数值，只补上"装武器"这一步。
    if (this.effectRegistry) {
      const ctx = { entityContainer: this.entities, effectRegistry: this.effectRegistry, eventBus: this.eventBus, waveNumber: (typeof window !== 'undefined' && window.CTX?.waveNumber) || 0 };
      for (const e of this.entities.getAllTowers(false)) {
        if (e._mapTier !== 'nexus_lane') continue;
        if ((e._skillInstances || []).some((s) => s.skillId === 'weapon_piercing')) continue;
        equipSkill(e, 'weapon_piercing', ctx, SkillLibrary);
      }
    }
  }

  /** 镜像占领状态到实体上，供 resourceBar.js（面板法力条）/UnitLayer.js（画板血条）读取。 */
  _syncCaptureDisplay(node) {
    if (!node.entity) return;
    node.entity._capturePct = node.capturePct;
    node.entity._captureOwner = node.captureOwner;
  }

  /**
   * CombatSystem 的 _resolveHit / performAttackDirect 命中据点时调用，取代
   * 正常的 currentHP -= 伤害结算——见文件头注"为什么不用正常伤害结算"。
   *
   * 用户定稿："两方不能同时占领据点，如果出现了，据点进入不可被占领状态
   * （不可被双方选中，迫使两方开始交战），直至只剩一方占领该据点。"
   * 落地方式：先无条件记一笔"这一方刚刚打过这个据点"（_lastHit，供
   * _tickContest() 判定"双方是否都在场"），再检查【记完之后】是不是已经
   * 进入争夺状态——是的话这次命中不产生任何占领压力，并且把攻击者的
   * targetId 清掉，逼它下一轮重新索敌；索敌（AISystem.scanEnemies 等）
   * 会经过 isStructureProtected()，那里已经加了 target._contested 的判断，
   * 自然会跳过这个据点，转而盯上旁边的敌方单位——这就是"迫使两方开始交战"
   * 在代码里的样子：不需要另外写一套"强制攻击最近敌人"的逻辑，只是让现成的
   * 索敌逻辑看不到这个目标了。
   */
  applyCapturePressure(attacker, targetEntity) {
    if (!attacker) return;
    const node = this.nodes.find((n) => n.entity && n.entity.id === targetEntity.id);
    if (!node) return;
    const faction = attacker._mapFaction || attacker.faction;
    if (faction !== FACTIONS.BLUE && faction !== FACTIONS.RED) return;
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    node._lastHit[faction] = now;
    // ⚠️ 必须【无条件】同步，不能只在"判定为争夺中"这一支里赋 true——那样争夺
    // 状态只有 _tickContest()（挂在 update() 里）跑到才会被翻回 false，如果调用方
    // 没有稳定的每帧 update() 节奏（单测直接调这个函数，或者双方脱离后很久才有
    // 下一次命中），_contested 会卡在 true 出不来。这里每次命中都用当下最新的
    // 判定结果覆盖一遍，跟 _tickContest() 的逻辑保持同一个真源。
    const contested = this._isContested(node, now);
    node.entity._contested = contested;
    if (contested) {
      attacker.targetId = null;
      return;
    }
    const sign = faction === FACTIONS.BLUE ? 1 : -1;
    const cfg = CONFIG.dominion || {};
    const power = (cfg.capturePower && (cfg.capturePower[attacker.type] ?? cfg.capturePower.default)) ?? 1;
    this._advance(node, sign * power);
  }

  /** 蓝红两方是不是都在 contestWindowSec 秒内打过这个据点——"双方同时在场"的判据。 */
  _isContested(node, now) {
    const win = CONFIG.dominion?.contestWindowSec ?? 2;
    return (now - node._lastHit[FACTIONS.BLUE] <= win)
        && (now - node._lastHit[FACTIONS.RED] <= win);
  }

  /** 净压力结算 + 归属翻转的"粘性"逻辑，见文件头注。 */
  _advance(node, delta) {
    const full = CONFIG.dominion?.captureFull ?? 100;
    if (node.captureOwner === FACTIONS.BLUE) {
      if (delta > 0) return; // 己方打不动自己的点（canTarget 已挡，这里只是兜底）
      node.capturePct = Math.max(0, node.capturePct + delta);
      if (node.capturePct <= 0) this._setOwner(node, FACTIONS.NEUTRAL, 0);
    } else if (node.captureOwner === FACTIONS.RED) {
      if (delta < 0) return;
      node.capturePct = Math.min(0, node.capturePct + delta);
      if (node.capturePct >= 0) this._setOwner(node, FACTIONS.NEUTRAL, 0);
    } else {
      node.capturePct = Math.max(-full, Math.min(full, node.capturePct + delta));
      if (node.capturePct >= full) this._setOwner(node, FACTIONS.BLUE, full);
      else if (node.capturePct <= -full) this._setOwner(node, FACTIONS.RED, -full);
    }
    this._syncCaptureDisplay(node);
  }

  /**
   * 归属翻转时同步：数值（attackDamage/attackRange）+ 武器技能实例。
   *
   * ⚠️ 光有正的 attackDamage 不够——CombatSystem.update 的塔攻击循环有一道
   * 前置闸门："无武器：不攻击（`tower._skillInstances.some(s => category==='weapon')`
   * 为假就直接 `tower.targetId=null; continue`）"，跟 attackDamage 数值本身无关。
   * 据点是手搭的裸实体（不走 createBuilding），天生没有这个技能实例，所以
   * "已占领的据点主动开火"必须在这里显式装/卸一把武器，不能只改数值——
   * 这是本系统实现过程中一处真实踩过的坑：数值改对了但仍然不开火。
   * 武器复用 'weapon_piercing'——本仓库所有攻击塔（outer/base/hq_tower）默认
   * 都用它，据点没有理由另起一种，见 howling_abyss.js 等地图 `weapon:'piercing'`。
   */
  _setOwner(node, owner, value) {
    const prevOwner = node.captureOwner;
    node.captureOwner = owner;
    node.capturePct = value;
    const e = node.entity;
    if (!e) return;
    e._mapFaction = owner;
    e.faction = owner;
    const tpl = CONFIG.templates.tower;
    const cfg = CONFIG.dominion || {};
    const ctx = { entityContainer: this.entities, effectRegistry: this.effectRegistry, eventBus: this.eventBus, waveNumber: (typeof window !== 'undefined' && window.CTX?.waveNumber) || 0 };
    if (owner === FACTIONS.NEUTRAL) {
      // 中立不攻击任何单位（用户明确定稿）。
      e.baseStats.attackDamage = 0;
      e.baseStats.attackRange = 0;
      if (prevOwner !== FACTIONS.NEUTRAL && this.effectRegistry) {
        const wInst = (e._skillInstances || []).find((s) => s.skillId === 'weapon_piercing');
        if (wInst) {
          SkillLibrary.weapon_piercing?.onUnequip?.(e.id, wInst, ctx);
          e._skillInstances = e._skillInstances.filter((s) => s !== wInst);
        }
      }
    } else {
      // 已被完全占领的据点"帮拥有者守点"，火力打折到普通塔的一小截（设计文档 5.2 节）。
      // 2026-09-26 用户定稿"据点的攻击力大幅度减弱，攻速略微提升"：攻击力百分比
      // 从 35 砍到 12（pointDamagePct 的默认值同步改了，这里的 ?? 兜底也要跟着改，
      // 否则地图/存档里没写这个字段时会悄悄退回旧的 35%）；新增 pointAttackSpeedPct
      // 表达攻速提升——攻速这个维度以前 _setOwner 从没碰过（一直是 tpl 原始值）。
      e.baseStats.attackDamage = (tpl.attackDamage || 0) * ((cfg.pointDamagePct ?? 12) / 100);
      e.baseStats.attackRange = (tpl.attackRange || 0) * ((cfg.pointRangePct ?? 82) / 100);
      e.baseStats.baseAttackSpeed = (tpl.baseAttackSpeed || 0) * ((cfg.pointAttackSpeedPct ?? 100) / 100);
      if (prevOwner === FACTIONS.NEUTRAL && this.effectRegistry) {
        equipSkill(e, 'weapon_piercing', ctx, SkillLibrary);
      }
    }
  }

  update(dt) {
    if (!this.active) return;
    this._tickContest(dt);
    this._tickWaves(dt);
    this._tickNexusDrain(dt);
  }

  /**
   * 每帧刷新每个据点的"争夺中"状态 + 脱战后的静息值回归。
   *
   * 争夺状态不能只在 applyCapturePressure() 里"开"不"关"——一旦双方都停手
   * （比如其中一方的兵全被打死了），_lastHit 会自然老化出 contestWindowSec
   * 这个窗口，这里每帧重新判一次，让它能够【自动解除】，不需要额外的
   * "谁死了"事件监听。
   *
   * 脱战回归：用户定稿"若据点脱离战斗状态，此时会慢慢恢复该状态下的值"——
   * "该状态下的值"= 静息值：中立=0，已被某方占领=±captureFull。脱战判据
   * 是【两方都】超过 combatTimeoutSec 秒没再对这个据点造成过占领压力
   * （比"争夺中"那个窗口更宽松，争夺解除不代表已经没人管这个点了——可能
   * 只是暂时没打，紧接着还会回来打）。回归只会把 capturePct 拉向静息值，
   * 不会翻过界（Math.min/max 卡在静息值），也不会触发 _setOwner——已经在
   * 静息值上或正在往那儿靠近，从不需要转移归属。
   */
  _tickContest(dt) {
    const cfg = CONFIG.dominion || {};
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    const full = cfg.captureFull ?? 100;
    const combatTimeout = cfg.combatTimeoutSec ?? 4;
    const regenPerSec = cfg.captureRegenPerSec ?? 8;
    for (const node of this.nodes) {
      if (node.kind !== 'point' || !node.entity) continue;
      node.entity._contested = this._isContested(node, now);
      const idleFor = Math.min(now - node._lastHit[FACTIONS.BLUE], now - node._lastHit[FACTIONS.RED]);
      if (idleFor < combatTimeout) continue; // 至少还有一方最近打过，不脱战
      const resting = node.captureOwner === FACTIONS.BLUE ? full
                    : node.captureOwner === FACTIONS.RED ? -full : 0;
      if (node.capturePct === resting) continue;
      const step = regenPerSec * dt;
      node.capturePct = node.capturePct < resting
        ? Math.min(resting, node.capturePct + step)
        : Math.max(resting, node.capturePct - step);
      this._syncCaptureDisplay(node);
    }
  }

  /**
   * 出兵：据点被完全占领后，从这里开始出兵，两个方向各出一整套（用户定稿
   * "每个据点改为每个方向生成2近战2远程（共4近战4远程），每两两波每个方向
   * 额外生成1炮兵（共2炮兵）"——不再是"预算在两个方向分摊"那种旧算法，
   * 见 _spawnPointWave() 头注）。
   * 双方召唤水晶每隔 bonusWaveEvery 波额外出一次固定编制的兵，与据点占领
   * 状态无关（防止一方据点优势滚雪球到底，设计文档 5.3 节）——这一部分保留
   * 原来的独立预算+两方向轮流分摊算法（_spawnBudget），用户拍板"据点和
   * 召唤水晶两份编排分开"，不共用 _spawnPointWave 那一套。
   *
   * 用户定稿："只有在某一方打掉了另一方的召唤水晶后，在自家的召唤水晶出
   * 超级兵"——召唤水晶（kind:'base'）出兵时额外检查敌方召唤水晶【此刻】
   * 是不是处于摧毁/重生倒计时状态，是就把 crystalSuperBonus 并进这一波编制——
   * 敌方水晶一旦重生（nexusRespawnTime 到点，MapSystem 原地复活尸体）这里
   * 立刻就读不到"敌方水晶已摧毁"了，自然停止，不需要额外监听重生事件、
   * 也不需要自己维护一份"是否已解锁"的开关状态。
   */
  _tickWaves(dt) {
    const cfg = CONFIG.dominion || {};
    const interval = cfg.waveInterval ?? 20;
    this._waveTimer += dt;
    if (this._waveTimer < interval - 1e-9) return; // 留 epsilon，见 docs/DEVELOPMENT.md §3.6
    this._waveTimer -= interval;
    this._waveCount++;
    const toggleStart = this._waveCount % 2 === 0;
    const bonusEvery = Math.max(1, cfg.bonusWaveEvery ?? 1);
    for (const node of this.nodes) {
      if (node.kind === 'point') {
        if (node.captureOwner === FACTIONS.NEUTRAL) continue;
        this._spawnPointWave(node, node.captureOwner);
      } else if (node.kind === 'base' && this._waveCount % bonusEvery === 0) {
        const budget = this._enemyCrystalDown(node.faction)
          ? { ...cfg.bonusWaveComposition, ...cfg.crystalSuperBonus }
          : cfg.bonusWaveComposition;
        this._spawnBudget(node, node.faction, budget, toggleStart);
      }
    }
  }

  /**
   * 据点出兵：改走标准出兵编排系统（compositionFor/buildWaveOrder），不再是
   * DominionSystem 自己维护的一份 CONFIG.dominion.waveBudget——2026-09-26
   * 用户报"水晶之痕地图中的实际出兵编排和模板编辑器中的对应不上"，根因正是
   * 两套各算各的（见文件头 pseudoLaneId 的头注）。两个方向【各自】按自己的
   * 伪路 id 展开一整套完整编排（不是把预算拆开轮流分给两边），对应用户定稿
   * "每个方向生成2近战2远程……每两两波每个方向额外生成1炮兵"——默认编排见
   * CONFIG.gameRules.laneWaveCompositionByLane 的 ring_fwd/ring_rev。
   */
  _spawnPointWave(node, faction) {
    if (!this.createMinion) return;
    for (const seg of [node.segForward, node.segReverse]) {
      if (!seg) continue;
      const order = buildWaveOrder(this._waveCount, false, CONFIG.gameRules, faction, { laneId: pseudoLaneId(seg) });
      for (const type of order) this.createMinion(type, node.pos.x, node.pos.y, faction, seg.laneId, seg.direction);
    }
  }

  /** faction 的敌方召唤水晶此刻是不是已经被摧毁（还没重生）——决定这一波要不要带超级兵。 */
  _enemyCrystalDown(faction) {
    const enemy = faction === FACTIONS.BLUE ? FACTIONS.RED : faction === FACTIONS.RED ? FACTIONS.BLUE : null;
    if (!enemy) return false;
    const crystal = this.entities.getAllTowers(false)
      .find((t) => t._mapTier === 'nexus_lane' && t._mapFaction === enemy);
    return !!crystal && !crystal.alive;
  }

  /**
   * 把 budgetCfg（{melee:1,ranged:1,super:1} 这种）拆成单位序列，轮流分给两个
   * 方向——只有召唤水晶（kind:'base'）还在用这个算法，据点已经改走
   * _spawnPointWave() 那套标准编排系统（见上面两个方法的头注）。
   */
  _spawnBudget(node, faction, budgetCfg, toggleStart) {
    if (!this.createMinion || !faction) return;
    const types = Object.entries(budgetCfg || {}).flatMap(([t, n]) => Array(Math.max(0, n | 0)).fill(t));
    const dirs = [node.segForward, node.segReverse].filter(Boolean);
    if (dirs.length === 0 || types.length === 0) return;
    let toggle = toggleStart;
    for (const type of types) {
      const seg = dirs.length === 1 ? dirs[0] : (toggle ? dirs[0] : dirs[1]);
      toggle = !toggle;
      this.createMinion(type, node.pos.x, node.pos.y, faction, seg.laneId, seg.direction);
    }
  }

  /**
   * 水晶掉血：己方占据点数 > 对方时，对方水晶持续掉血，速度按据点数差走
   * （设计文档规则 7）。只数 kind:'point' 且已经【完全占领】的据点——中途
   * 争夺中的据点不计入任何一方。
   *
   * 直接改 currentHP 而不走 CombatSystem：这不是一次"攻击"，没有攻击者、
   * 不该吃护甲/护盾/减伤这些属性。死亡检查在这里手动复刻一份
   * （currentHP<=0 && alive 才发 entity:death），跟 CombatSystem._resolveHit
   * 里那份逐字一致——这是本仓库已有的先例（同一份检查在好几处伤害结算路径
   * 各自复刻一份，不是本系统独创的写法），复用同一个 entity:death 事件后，
   * MapSystem 现成的 nexus_main 死亡处理（转损毁幽灵 + 发 map:mainNexusDestroyed）
   * 不需要认得"这次死亡是不是由据点数差造成的"，天然一起生效。
   */
  _tickNexusDrain(dt) {
    const points = this.nodes.filter((n) => n.kind === 'point');
    if (points.length === 0) return;
    const blueCount = points.filter((n) => n.captureOwner === FACTIONS.BLUE).length;
    const redCount = points.filter((n) => n.captureOwner === FACTIONS.RED).length;
    const diff = blueCount - redCount;
    if (diff === 0) return;
    const cfg = CONFIG.dominion || {};
    const amount = (cfg.nexusDrainPerPointPerSec ?? 8) * Math.abs(diff) * dt;
    const loserFaction = diff > 0 ? FACTIONS.RED : FACTIONS.BLUE;
    const nexus = this.entities.getAllTowers(true)
      .find((t) => t._mapTier === 'nexus_main' && t._mapFaction === loserFaction);
    if (!nexus || !nexus.alive) return;
    nexus.currentHP = Math.max(0, nexus.currentHP - amount);
    if (nexus.currentHP <= 0 && nexus.alive) {
      nexus.currentHP = 0;
      nexus.alive = false;
      this.eventBus.emit('entity:death', { entityId: nexus.id });
    }
  }

  /** 供 UI/调试读——当前每方占了几个据点、水晶掉血速率是多少。 */
  getStatus() {
    const points = this.nodes.filter((n) => n.kind === 'point');
    return {
      active: this.active,
      blue: points.filter((n) => n.captureOwner === FACTIONS.BLUE).length,
      red: points.filter((n) => n.captureOwner === FACTIONS.RED).length,
      total: points.length,
    };
  }
}
