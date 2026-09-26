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
    this.nodes = nodes.map((n) => ({ ...n, capturePct: 0, captureOwner: FACTIONS.NEUTRAL, entity: null }));
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
      };
      this.entities.add(entity);
      node.entity = entity;
    }
  }

  /**
   * CombatSystem 的 _resolveHit / performAttackDirect 命中据点时调用，取代
   * 正常的 currentHP -= 伤害结算——见文件头注"为什么不用正常伤害结算"。
   */
  applyCapturePressure(attacker, targetEntity) {
    if (!attacker) return;
    const node = this.nodes.find((n) => n.entity && n.entity.id === targetEntity.id);
    if (!node) return;
    const faction = attacker._mapFaction || attacker.faction;
    const sign = faction === FACTIONS.BLUE ? 1 : faction === FACTIONS.RED ? -1 : 0;
    if (sign === 0) return;
    const cfg = CONFIG.dominion || {};
    const power = (cfg.capturePower && (cfg.capturePower[attacker.type] ?? cfg.capturePower.default)) ?? 1;
    this._advance(node, sign * power);
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
      e.baseStats.attackDamage = (tpl.attackDamage || 0) * ((cfg.pointDamagePct ?? 35) / 100);
      e.baseStats.attackRange = (tpl.attackRange || 0) * ((cfg.pointRangePct ?? 82) / 100);
      if (prevOwner === FACTIONS.NEUTRAL && this.effectRegistry) {
        equipSkill(e, 'weapon_piercing', ctx, SkillLibrary);
      }
    }
  }

  update(dt) {
    if (!this.active) return;
    this._tickWaves(dt);
    this._tickNexusDrain(dt);
  }

  /**
   * 出兵：据点被完全占领后，从这里开始按固定预算出兵，朝相邻两个方向分摊
   * （不是各出一整套，见设计文档第 6 节"出兵预算"——避免 5 点全占时爆量）。
   * 双方水晶基地每隔 bonusWaveEvery 波额外出一次固定编制的兵，与据点占领
   * 状态无关（防止一方据点优势滚雪球到底，设计文档 5.3 节）。
   */
  _tickWaves(dt) {
    const cfg = CONFIG.dominion || {};
    const interval = cfg.waveInterval ?? 20;
    this._waveTimer += dt;
    if (this._waveTimer < interval - 1e-9) return; // 留 epsilon，见 docs/DEVELOPMENT.md §3.6
    this._waveTimer -= interval;
    this._waveCount++;
    const toggleStart = this._waveCount % 2 === 0;
    const bonusEvery = Math.max(1, cfg.bonusWaveEvery ?? 3);
    for (const node of this.nodes) {
      if (node.kind === 'point') {
        if (node.captureOwner === FACTIONS.NEUTRAL) continue;
        this._spawnBudget(node, node.captureOwner, cfg.waveBudget, toggleStart);
      } else if (node.kind === 'base' && this._waveCount % bonusEvery === 0) {
        this._spawnBudget(node, node.faction, cfg.bonusWaveComposition, toggleStart);
      }
    }
  }

  /** 把 budgetCfg（{melee:1,ranged:1,super:1} 这种）拆成单位序列，轮流分给两个方向。 */
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
