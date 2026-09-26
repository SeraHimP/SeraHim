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
 * 必须整个绕开正常的护甲/护盾/伤害转化那一整套，直接跳过（不做任何事）——
 * 两者是完全解耦的两套数值（设计文档 5.1 节的核心结论），混在一起算就会出现
 * "以后调兵种伤害，据点争夺节奏也跟着变"这种不该有的耦合。
 *
 * ==================== 2026-09-26 第三轮：占领不再挂在攻击事件上 ====================
 * 早期版本占领压力是 CombatSystem 命中据点那一刻【顺带】触发的（调
 * DominionSystem.applyCapturePressure()），本质是"攻击的副作用"，于是占领
 * 推进速度被绑上了攻击者自己的攻速——用户反馈"小兵占领和攻击的实现是完全
 * 不同的，目前我看做的占领实际上就是攻击"。现在两者彻底解耦：CombatSystem
 * 命中据点时什么都不做（见上一段），占领改由 DominionSystem._tickCapture()
 * 自己按固定节奏（跟攻速无关）扫描"谁把这个据点设为目标"来推进，见该方法
 * 的头注。
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
    // _lastHit：蓝/红两方【最近一次】在场（有小兵把这个据点设为目标）的游戏
    // 时刻，供 _tickCapture()/_tickRegen() 判定"双方是否同时在场"与"是否已经
    // 脱战"——见那两个方法的头注。
    this.nodes = nodes.map((n) => ({
      ...n, capturePct: 0, captureOwner: FACTIONS.NEUTRAL, entity: null,
      _lastHit: { [FACTIONS.BLUE]: -Infinity, [FACTIONS.RED]: -Infinity },
    }));
    const tpl = CONFIG.templates.tower;
    const cfg = CONFIG.dominion || {};
    // 2026-09-26 用户定稿"中立据点会正常攻击"——据点不管有没有被占领都用同一套
    // pointDamagePct/pointRangePct/pointAttackSpeedPct 主动开火，不再是"中立=
    // 完全被动的空目标"。canTarget(NEUTRAL, BLUE/RED) 天然允许中立据点攻击
    // 任意一方（跟中立野怪同一条判据），于是中立据点会对最先靠近的任何一方
    // 开火——据点从"谁先摸到就是谁的"变成"要打一架才能拿下"，归属翻转只改变
    // 它认哪一方为敌（_setOwner 只改 _mapFaction/faction），不再需要跟着重新
    // 装卸武器/改攻击数值，见 _setOwner() 头注。
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
        baseStats: {
          ...tpl,
          attackDamage: (tpl.attackDamage || 0) * ((cfg.pointDamagePct ?? 12) / 100),
          attackRange: (tpl.attackRange || 0) * ((cfg.pointRangePct ?? 82) / 100),
          baseAttackSpeed: (tpl.baseAttackSpeed || 0) * ((cfg.pointAttackSpeedPct ?? 100) / 100),
          maxHP: 1, healthRegen: 0, shieldFixedMax: 0,
        },
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
        // 见 _tickCapture() 的维护逻辑。
        _contested: false,
      };
      this.entities.add(entity);
      node.entity = entity;
    }
    // 召唤水晶（nexus_lane）自带穿透型子弹+物理攻击（用户定稿），但全局
    // CONFIG.towerTierWeapon.nexus_lane 固定是 'none'（所有地图的召唤水晶默认
    // 不开火），常规的"地图 buildings[].weapon"装配路径会被这条全局配置直接
    // 顶掉，据点同样是手搭的裸实体（不走 createBuilding）——两者都只能绕开
    // 正常武器装配、直接调用 equipSkill 补上"装武器"这一步，数值都已经在各自
    // 的创建处（这里的 baseStats / dominion_crystal_scar.js 的 tierStats）给好了。
    if (this.effectRegistry) {
      const ctx = { entityContainer: this.entities, effectRegistry: this.effectRegistry, eventBus: this.eventBus, waveNumber: (typeof window !== 'undefined' && window.CTX?.waveNumber) || 0 };
      for (const e of this.entities.getAllTowers(false)) {
        if (e._mapTier !== 'nexus_lane' && !e.isCapturePoint) continue;
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

  /** 蓝红两方是不是都在 contestWindowSec 秒内"在场"过这个据点——"双方同时在场"的判据。 */
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
   * 归属翻转时同步：只改 _mapFaction/faction（决定 canTarget 判它是敌是友），
   * 不再需要在这里重算攻击力/攻速/装卸武器——2026-09-26 用户定稿"中立据点会
   * 正常攻击"之后，据点从 initMap() 创建那一刻起就已经按同一套
   * pointDamagePct/pointRangePct/pointAttackSpeedPct 定死了攻击强度并装好了
   * weapon_piercing，不管中立还是被占领都是同一份数值/同一把武器，翻转归属
   * 只是换了"认哪一方为敌"，不需要跟着重新装卸/改数值。
   */
  _setOwner(node, owner, value) {
    node.captureOwner = owner;
    node.capturePct = value;
    const e = node.entity;
    if (!e) return;
    e._mapFaction = owner;
    e.faction = owner;
    this._syncCaptureDisplay(node);
  }

  update(dt) {
    if (!this.active) return;
    this._tickCapture(dt);
    this._tickRegen(dt);
    this._tickWaves(dt);
    this._tickNexusDrain(dt);
  }

  /**
   * ==================== 2026-09-26 第三轮：占领与攻击彻底解耦 ====================
   * 用户反馈"中立据点会进行攻击单位"，追问之下定的根因是"小兵占领和攻击的
   * 实现是完全不同的，目前我看做的占领实际上就是攻击。小兵占领据点时应该是
   * 固定每秒一次"——原来的占领压力是从 CombatSystem._resolveHit/
   * performAttackDirect 命中据点时【顺带】触发的（见旧版 applyCapturePressure
   * 头注），本质上是"攻击事件的副作用"：占领的推进节奏因此被绑在攻击者自己的
   * 攻速上——近战/远程/炮兵攻速不同，同样的 capturePower 换算出来的实际占领
   * 速度（每秒推进的百分点）就会不一样，这正是用户说的"占领实际上就是攻击"。
   *
   * 现在改成据点自己按固定节奏（captureTickSec，默认 1 秒）扫一遍"当前谁把
   * 我设为攻击目标"（只读 targetId，不读攻速/冷却），按扫到的小兵各自的
   * capturePower 汇总一次净压力，跟攻击者的攻速/攻击冷却彻底没有关系——
   * 哪怕是炮兵那种攻速很慢的兵种，只要站在据点边上把它设为目标，同样按
   * 这固定的每秒一次推进，不会因为攻速快就推得更猛。
   *
   * 用户追加定稿："据点是有占领速度上限的，每秒最多10%最大占领速度"——不管
   * 同时有多少个小兵在占（人越多本来净压力会越大），最终这一次 tick 的净变化
   * 量被夹在 ±(captureFull × maxCaptureRatePctPerSec / 100) 之内，见下面
   * capPerTick 的计算。
   *
   * "谁在占领"的判据用现成的 minion.targetId===点的实体id（LaneMovementSystem
   * 的索敌/锚定逻辑已经在维护这个字段，且已经过 isStructureProtected 的争夺
   * 判定——争夺中的据点不会被设成任何人的目标，见 AISystem.scanEnemies）——
   * 只读它的【值】（谁盯着我），不牵扯攻击方那一套攻速/冷却计时，这就是
   * "占领和攻击完全独立两套实现"在这里的落地方式：复用位置/索敌信息，
   * 不复用节奏信息。
   *
   * _lastHit 的更新也从"每次攻击命中"改成"这一帧扫到时有没有人在场"——
   * 语义不变（供 _isContested/_tickRegen 判定"双方是否同时在场"/"是否已经
   * 脱战"），只是触发源从攻击事件变成了每帧的在场扫描。
   */
  _tickCapture(dt) {
    const cfg = CONFIG.dominion || {};
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    const full = cfg.captureFull ?? 100;
    const tickSec = cfg.captureTickSec ?? 1;
    const capPerTick = full * ((cfg.maxCaptureRatePctPerSec ?? 10) / 100) * tickSec;
    const minions = this.entities.getAllMinions ? this.entities.getAllMinions(true) : [];
    for (const node of this.nodes) {
      if (node.kind !== 'point' || !node.entity) continue;
      let bluePower = 0, redPower = 0, blueHere = false, redHere = false;
      for (const m of minions) {
        if (!m.alive || m.targetId !== node.entity.id) continue;
        const faction = m._mapFaction || m.faction;
        const power = (cfg.capturePower && (cfg.capturePower[m.type] ?? cfg.capturePower.default)) ?? 1;
        if (faction === FACTIONS.BLUE) { bluePower += power; blueHere = true; }
        else if (faction === FACTIONS.RED) { redPower += power; redHere = true; }
      }
      if (blueHere) node._lastHit[FACTIONS.BLUE] = now;
      if (redHere) node._lastHit[FACTIONS.RED] = now;

      const contested = this._isContested(node, now);
      node.entity._contested = contested;
      if (contested) {
        // 迫使两方开始交战：把当前盯着这个据点的攻击者目标清空，逼它们下一轮
        // 重新索敌——索敌会经过 isStructureProtected()（已认得 _contested），
        // 自然跳过这个据点，转而盯上旁边的敌方单位。
        for (const m of minions) {
          if (m.alive && m.targetId === node.entity.id) m.targetId = null;
        }
        continue;
      }

      node._captureTimer = (node._captureTimer || 0) + dt;
      if (node._captureTimer < tickSec - 1e-9) continue;
      node._captureTimer -= tickSec;
      const rawDelta = bluePower - redPower;
      if (rawDelta === 0) continue;
      const delta = Math.max(-capPerTick, Math.min(capPerTick, rawDelta));
      this._advance(node, delta);
    }
  }

  /**
   * 脱战后向"静息值"（中立=0，已占领=±captureFull）缓慢恢复——用户定稿
   * "若据点脱离战斗状态，此时会慢慢恢复该状态下的值"。脱战判据是【两方都】
   * 超过 combatTimeoutSec 秒没有任何小兵把这个据点设为目标（_lastHit 由
   * _tickCapture() 每帧维护），比"争夺中"那个窗口更宽松——争夺解除不代表
   * 已经没人管这个点了，可能只是暂时没人在占，紧接着还会回来。回归只会把
   * capturePct 拉向静息值，不会翻过界，也不会触发 _setOwner——已经在静息值
   * 上或正在往那儿靠近，从不需要转移归属。
   */
  _tickRegen(dt) {
    const cfg = CONFIG.dominion || {};
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    const full = cfg.captureFull ?? 100;
    const combatTimeout = cfg.combatTimeoutSec ?? 4;
    const regenPerSec = cfg.captureRegenPerSec ?? 8;
    for (const node of this.nodes) {
      if (node.kind !== 'point' || !node.entity) continue;
      const idleFor = Math.min(now - node._lastHit[FACTIONS.BLUE], now - node._lastHit[FACTIONS.RED]);
      if (idleFor < combatTimeout) continue; // 至少还有一方最近在场，不脱战
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
    // 2026-09-26 第四轮：用户定稿"基地每波出兵，据点改为每2波出兵"——据点出兵
    // 节奏单独拉慢，跟基地（bonusWaveEvery）解耦成两个独立的节奏。
    const pointEvery = Math.max(1, cfg.pointWaveEvery ?? 2);
    // 追赶炮兵（用户定稿"当某方占领的据点数量低于另一方时，基地出兵每波额外出
    // 1×据点占领差值的炮兵"）：算一次双方当前占了几个据点，下面 base 分支里
    // 落后的那一方按差值往自己的编制里加炮兵。
    const points = this.nodes.filter((n) => n.kind === 'point');
    const blueCount = points.filter((n) => n.captureOwner === FACTIONS.BLUE).length;
    const redCount = points.filter((n) => n.captureOwner === FACTIONS.RED).length;
    for (const node of this.nodes) {
      if (node.kind === 'point') {
        if (node.captureOwner === FACTIONS.NEUTRAL) continue;
        if (this._waveCount % pointEvery !== 0) continue;
        this._spawnPointWave(node, node.captureOwner);
      } else if (node.kind === 'base' && this._waveCount % bonusEvery === 0) {
        const budget = { ...cfg.bonusWaveComposition };
        if (this._enemyCrystalDown(node.faction)) Object.assign(budget, cfg.crystalSuperBonus);
        const myCount = node.faction === FACTIONS.BLUE ? blueCount : redCount;
        const oppCount = node.faction === FACTIONS.BLUE ? redCount : blueCount;
        const deficit = Math.max(0, oppCount - myCount);
        if (deficit > 0) budget.siege = (budget.siege || 0) + deficit;
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
    // 2026-09-26：用户反馈"某一方滚雪球太严重了"，改成按 sqrt(据点数差) 走而不是
    // 线性——领先越大惩罚越重的方向不变，但增速变缓（边际递减），见 Config.js
    // 里 nexusDrainPerPointPerSec 旁边的头注，那里有完整的问题分析和公式对比。
    const amount = (cfg.nexusDrainPerPointPerSec ?? 8) * Math.sqrt(Math.abs(diff)) * dt;
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
