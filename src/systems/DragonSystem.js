import { CONFIG } from '../data/Config.js';
import { dragonCfg, dragonStatsAt, dragonIntervalAt } from '../data/dragonCurve.js';

/**
 * DragonSystem.js
 *
 * 龙魂系统（参考 LoL 元素龙机制）：
 * - 每隔固定时间刷新一条元素龙，与普通波次同时存在
 * - 击杀元素龙给所有塔叠加对应永久增益
 * - 累计击杀达到门槛后，按击杀最多的元素解锁唯一龙魂（装备到所有塔）
 * - 解锁后只刷新远古巨龙，击杀提供额外远古增益并强化龙魂
 */

// 8 种元素龙定义：击杀后给所有塔叠加的增益（永久，可叠加同种）
export const DRAGON_ELEMENTS = {
  fire:    { key: 'fire',    label: '炎龙', icon: '🔥', color: '#e74c3c', soul: 'dragonsoul_fire',    buff: [{ statKey: 'attackDamage', percent: 8 }] },
  water:   { key: 'water',   label: '潮龙', icon: '🌊', color: '#3498db', soul: 'dragonsoul_water',   buff: [{ statKey: 'bonusAttackSpeedPct', flat: 6 }] },
  earth:   { key: 'earth',   label: '山龙', icon: '🗿', color: '#95a5a6', soul: 'dragonsoul_earth',   buff: [{ statKey: 'armor', flat: 10 }, { statKey: 'magicResist', flat: 10 }, { statKey: 'maxHP', percent: 5 }] },
  thunder: { key: 'thunder', label: '雷龙', icon: '⚡', color: '#f1c40f', soul: 'dragonsoul_thunder', buff: [{ statKey: 'armorPenFlat', flat: 6 }, { statKey: 'magicPenFlat', flat: 6 }, { statKey: 'attackDamage', percent: 5 }] },
  wind:    { key: 'wind',    label: '风龙', icon: '🌪', color: '#1abc9c', soul: 'dragonsoul_wind',    buff: [{ statKey: 'bonusAttackSpeedPct', flat: 6 }, { statKey: 'attackRange', flat: 8 }] },
  dark:    { key: 'dark',    label: '暗龙', icon: '🌑', color: '#8e44ad', soul: 'dragonsoul_dark',    buff: [{ statKey: 'damageAmpPct', flat: 6 }, { statKey: 'lifeStealPct', flat: 4 }] },
  light:   { key: 'light',   label: '光龙', icon: '☀️', color: '#f39c12', soul: 'dragonsoul_light',   buff: [{ statKey: 'healShieldPowerPct', flat: 8 }, { statKey: 'healthRegen', flat: 2 }] },
  poison:  { key: 'poison',  label: '毒龙', icon: '☠️', color: '#27ae60', soul: 'dragonsoul_poison',  buff: [{ statKey: 'onHitPercentDamage', flat: 0.5 }] },
};

export class DragonSystem {
  constructor(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.effects = effectRegistry;
    this.skills = skillLibrary;
    this.attrCalc = attrCalc;
    this.config = CONFIG.gameRules;

    this.nextDragonTime = dragonCfg().firstDelay; // 首条元素龙：开局60秒（软编码）
    this.paused = true; // 开局默认暂停巨龙生成（用户要求：巨龙系统待大改，先默认关闭；原开关照常可开启）
    this.createEntity = null;
    this.elementDragonSpawned = 0; // 已刷新的元素龙数
    this.ancientSpawned = 0;       // 已刷新的远古龙数

    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;

    // ==================== 阵营龙魂规则（用户定稿）====================
    // 「6 条龙 + ≥4 击杀才成魂、都不到 4 则无魂、之后出远古龙」
    //
    // 改这块之前的实现是**按塔**结算的：每座塔各记自己的击杀、各自到 4 条解锁
    // 自己的魂。那既不是 LoL 的口径也不是用户要的 —— 龙魂是**阵营级**的战利品，
    // 一方拿到全军受益，另一方什么都没有。按塔算的结果是双方都能慢慢攒够、
    // 龙魂从"争夺目标"退化成"时间到了就有"，整个争龙的博弈就没有了。
    //
    // 现在：元素龙总共 elementDragonTotal（默认 6）条。每条龙的击杀归属到阵营。
    // 6 条打完后结算一次：谁 ≥ soulThreshold（默认 4）谁成魂；都不到则**无魂**
    // （3:3 是合法结局，不是需要兜底的边界）。结算后转入远古龙阶段。
    this.factionKills = { blue: {}, red: {} };   // 阵营 → { 元素: 次数 }
    this.factionTotals = { blue: 0, red: 0 };
    this.souls = { blue: [], red: [] };          // 阵营 → 已获得的龙魂 id
    this.soulResolved = false;                   // 6 条龙是否已结算
    this.soulOwner = null;                       // 成魂阵营（null = 无魂）

    this._bindDeath();
  }

  /** 元素龙总数与成魂门槛（软编码）。 */
  get _soulRule() {
    const g = CONFIG.gameRules || {};
    return {
      total: g.elementDragonTotal ?? 6,
      threshold: g.dragonSoulThreshold ?? 4,
    };
  }

  /**
   * WorldState 读这个接口把龙魂并进世界状态层。
   * 此前**这个方法根本不存在** —— WorldState 里写的是 `this.dragons?.getSouls?.()`，
   * 可选调用把缺失静默吞掉了，于是"龙魂已接入 WorldState"其实一直是空转。
   */
  getSouls() {
    return { blue: [...this.souls.blue], red: [...this.souls.red] };
  }

  setCreateEntity(fn) { this.createEntity = fn; }

  _bindDeath() {
    this.eventBus.on('entity:death', ({ entityId }) => {
      const e = this.entities.get(entityId);
      if (e && e.type === 'dragon') this._onDragonKilled(e);
    });
  }

  // 下一条龙的刷新间隔（秒）——龙刷新后从此刻起重新计时。
  // 这里原先是一串写死的 300/600/7*60/8*60/9*60。数值本身没错，但"巨龙多久刷一条"
  // 是最该让用户调的东西之一，却只能改源码。现在读 CONFIG.gameRules.dragon，
  // 实现在 data/dragonCurve.js —— 与模板编辑器的预览是**同一个函数**。
  _nextInterval() {
    return dragonIntervalAt({
      soulUnlocked: this.soulUnlocked,
      elementSpawned: this.elementDragonSpawned,
      ancientSpawned: this.ancientSpawned,
    });
  }

  update(dt) {
    if (this.paused) return;
    const alive = this.entities.getByType('dragon', true);
    if (alive.length > 0) return;

    this.nextDragonTime -= dt;
    if (this.nextDragonTime <= 0) {
      this.spawnDragon();
      this.nextDragonTime = this._nextInterval();
    }
  }

  // 巨龙绝对属性曲线——按"这是第几条元素龙"（1~4），而非游戏波次驱动。
  // 之前的 bug：龙按固定时间表刷新，但公式用 window.waveNumber 计算，
  // 导致波次早已跑远时（如7分钟后刷第2条龙时波次可能已到10+），
  // 数值远超预期（双抗几百）。改为用龙的刷新序号，增长曲线可预期、可控。
  // 参考：第1→4条：生命 1200→3000，双抗 -40→200，攻击力 23→252。
  //
  // 三条曲线原先是六行写死的分段线性式。形状一样、只有系数不同，所以收敛成一条
  // 参数化曲线搬进 data/dragonCurve.js，系数进 CONFIG.gameRules.dragon.curve。
  // 默认值与原式**逐位相同**（tests/sim_tpleditor.mjs 有断言守着）。
  _dragonStats(dragonIndex, isAncient) {
    return dragonStatsAt(dragonIndex, isAncient);
  }

  spawnDragon() {
    const isAncient = this.soulUnlocked;

    // 元素龙用"第几条龙"（elementDragonSpawned+1）；远古龙用"第几条远古龙"，
    // 均与游戏波次解耦，避免龙按固定时间表刷新导致数值随波次失控增长。
    const dragonIndex = isAncient ? (this.ancientSpawned + 1) : (this.elementDragonSpawned + 1);
    const dstats = this._dragonStats(dragonIndex, isAncient);

    let element = null;
    if (!isAncient) {
      const keys = Object.keys(DRAGON_ELEMENTS);
      element = keys[Math.floor(Math.random() * keys.length)];
      this.elementDragonSpawned++;
    } else {
      this.ancientSpawned++;
    }

    if (this.createEntity) {
      this.createEntity('dragon', { element, isAncient, absStats: dstats });
    }

    const label = isAncient ? '🐲 远古巨龙' : `${DRAGON_ELEMENTS[element].icon} ${DRAGON_ELEMENTS[element].label}`;
    this.eventBus.emit('dragon:spawn', { element, isAncient, label });
  }

  _onDragonKilled(dragon) {
    // 参与击杀的塔 = 对该龙造成过伤害的塔（记录在 dragon._damagers）
    let participants = Array.from(dragon._damagers || []);
    // 兜底："无记录则算全体塔参与"——这个兜底只在沙盒模式安全（不分敌我，本来也没有阵营概念）。
    // 对战模式下如果直接沿用，会导致：龙如果被非塔伤害来源（如某些间接AOE/DOT）补刀致死，
    // _damagers 记录不完整或为空时，敌我双方所有塔会一起获得击杀奖励——包括本不该受益的敌方。
    // 所以对战模式下宁可少发（无记录就不发），也不能误发给敌方。
    const isBattleMode = this.entities.getAllTowers(true).some(t => t._mapFaction);
    if (participants.length === 0 && !isBattleMode) {
      participants = this.entities.getByType('tower', true).map(t => t.id);
    }

    if (dragon._isAncient) {
      this.ancientKills++;
      for (const tid of participants) {
        const tower = this.entities.get(tid);
        if (tower) this._applyAncientBuffToTower(tower);
      }
      this.eventBus.emit('dragon:killed', { ancient: true, ancientKills: this.ancientKills });
      return;
    }

    const el = dragon._element;
    if (!el) return;
    this.killCounts[el] = (this.killCounts[el] || 0) + 1; // 全局统计（仅用于显示）
    this.totalKills++;

    for (const tid of participants) {
      const tower = this.entities.get(tid);
      if (!tower) continue;
      // 每塔独立记录击杀元素
      tower._dragonKills = tower._dragonKills || {};
      tower._dragonKills[el] = (tower._dragonKills[el] || 0) + 1;
      tower._dragonTotalKills = (tower._dragonTotalKills || 0) + 1;
      // 给这座塔元素增益（这一层保持不变：元素增益本来就是"谁打的谁拿"）
      this._applyElementBuffToTower(tower, el);
    }

    // ---- 阵营归属：这条龙算谁杀的 ----
    // 按参与塔的阵营投票，多者得。沙盒模式没有阵营标记，跳过阵营结算。
    const votes = { blue: 0, red: 0 };
    for (const tid of participants) {
      const f = this.entities.get(tid)?._mapFaction;
      if (f === 'blue' || f === 'red') votes[f]++;
    }
    if (votes.blue || votes.red) {
      const owner = votes.blue >= votes.red ? 'blue' : 'red';
      this.factionKills[owner][el] = (this.factionKills[owner][el] || 0) + 1;
      this.factionTotals[owner]++;
    }

    this.eventBus.emit('dragon:killed', {
      element: el, totalKills: this.totalKills, killCounts: { ...this.killCounts },
      factionTotals: { ...this.factionTotals },
    });

    // ---- 6 条龙打完 → 结算龙魂 ----
    // 用【已刷新数】而不是【已击杀数】判断阶段结束：龙可能自然消失/被跳过，
    // 按击杀数算的话只要有一条没被杀掉，阶段就永远结束不了、远古龙永不出现。
    if (!this.soulResolved && this.elementDragonSpawned >= this._soulRule.total) {
      this._resolveSoul();
    }
  }

  /**
   * 6 条元素龙结束后的一次性结算。
   * 达到门槛的阵营成魂（魂的元素 = 该阵营击杀最多的那种）；都不到则无魂。
   * 之后转入远古龙阶段。
   */
  _resolveSoul() {
    this.soulResolved = true;
    const { threshold } = this._soulRule;
    const b = this.factionTotals.blue, r = this.factionTotals.red;

    // 双方都达标时按击杀多的一方（同分则无人成魂：平局不该白送任何一方）
    let owner = null;
    if (b >= threshold && r >= threshold) owner = b === r ? null : (b > r ? 'blue' : 'red');
    else if (b >= threshold) owner = 'blue';
    else if (r >= threshold) owner = 'red';

    if (owner) {
      const kills = this.factionKills[owner];
      let best = null, bestCount = -1;
      for (const [el, cnt] of Object.entries(kills)) {
        if (cnt > bestCount) { bestCount = cnt; best = el; }
      }
      if (best) {
        const soulId = DRAGON_ELEMENTS[best].soul;
        this.soulOwner = owner;
        this.souls[owner] = [soulId];
        // 装备给该阵营【所有】塔，含之后新建的（见 equipSoulToTower 的调用点）
        for (const t of this.entities.getAllTowers(true)) {
          if (t._mapFaction === owner) this._equipSoul(t, soulId);
        }
        this.eventBus.emit('dragon:soulResolved', {
          owner, element: best, soulId, label: DRAGON_ELEMENTS[best].label,
          factionTotals: { ...this.factionTotals },
        });
      }
    } else {
      this.eventBus.emit('dragon:soulResolved', {
        owner: null, element: null, soulId: null,
        factionTotals: { ...this.factionTotals },
      });
    }

    // 无论有没有成魂，都进入远古龙阶段（用户定稿："都不到 4 则无魂，之后出远古龙"）
    this.soulUnlocked = true;
    this._unlockWave = window.waveNumber || 0;
    this.ancientSpawned = 0;
    this.nextDragonTime = 300;
  }

  /** 新塔（重生/新建）补发本阵营已有的龙魂，否则重生后就把魂丢了。 */
  equipExistingSoul(tower) {
    const fac = tower?._mapFaction;
    if (!fac) return false;
    const soulId = this.souls[fac]?.[0];
    if (!soulId) return false;
    this._equipSoul(tower, soulId);
    return true;
  }

  // 给单个塔叠加元素增益
  _applyElementBuffToTower(tower, el) {
    const def = DRAGON_ELEMENTS[el];
    if (!def) return;
    for (let i = 0; i < def.buff.length; i++) {
      const b = def.buff[i];
      this.effects.apply(tower.id, {
        name: `${def.label}之力`, icon: def.icon, kind: 'stat', color: def.color,
        statKey: b.statKey,
        flatValue: b.flat || 0, percentValue: b.percent || 0,
        perStackFlat: b.flat || 0, perStackPercent: b.percent || 0,
        duration: Infinity, permanent: true,
        stackable: true, maxStacks: 99, stackPolicy: 'stack',
        stackKey: `dragon_${el}_${b.statKey}`,
        descTemplate: `唯一被动——${def.label}之力：击杀${def.label}获得的永久增益（{stacks}层）。`,
        description: `${def.label}增益（{stacks}层）`,
      }, `dragon_buff_${el}_${i}`);
    }
  }

  // 注：这里原有 _unlockSoulForTower(tower)（"每座塔各自攒够 4 条就解锁自己的魂"）。
  // 它与用户定稿的阵营级规则冲突 —— 按塔算的话双方都能慢慢攒够，龙魂从"争夺目标"
  // 退化成"时间到了就有"，而且"都不到 4 则无魂"这条永远不会发生（每座塔各算各的，
  // 总有塔能到 4）。现已由 _resolveSoul() 的一次性阵营结算取代，故删除，
  // 不留下一个语义相反的旁路入口。

  // 远古增益给单个塔
  _applyAncientBuffToTower(tower) {
    this.effects.apply(tower.id, {
      name: '远古之力', icon: '🐲', kind: 'stat', color: '#e67e22',
      statKey: 'allStatsPct', flatValue: 10, perStackFlat: 10,
      duration: Infinity, permanent: true, stackable: true, maxStacks: 99, stackPolicy: 'stack',
      stackKey: 'ancient_allstats',
      descTemplate: '唯一被动——远古之力：全属性提升（{stacks}层）。',
      description: '远古之力（{stacks}层）',
    }, 'dragon_ancient_buff');
    for (const inst of tower._skillInstances || []) {
      if (inst.skillId.startsWith('dragonsoul_')) {
        inst.state = inst.state || {};
        inst.state.ancientBonus = (inst.state.ancientBonus || 0) + 1;
      }
    }
  }

  // 注：早期版本这里有 _applyElementBuff(el) 和 equipSoulToAllTowers(soulId) 两个
  // "不分塔、批量发给所有塔"的方法，属于"全局龙魂"的旧设计。改成"每塔独立"之后
  // 项目里已经没有任何地方调用它们了（纯死代码），但留着是个真实隐患——对战模式下
  // 如果未来不小心调用了它们，会不分敌我地把增益/龙魂发给红蓝双方所有塔。已删除。

  _equipSoul(tower, soulId) {
    // 移除已有龙魂 + 其展示效果
    const existing = (tower._skillInstances || []).filter(s => s.skillId.startsWith('dragonsoul_'));
    for (const inst of existing) {
      const def = this.skills[inst.skillId];
      if (def?.onUnequip) def.onUnequip(tower.id, inst, this._ctx());
      const disp = this.effects.getEffects(tower.id).find(e => e.sourceId === `soul_display_${inst.skillId}`);
      if (disp) this.effects.remove(disp.id);
      tower._skillInstances = tower._skillInstances.filter(s => s !== inst);
    }
    if (!soulId) return;
    const inst = { id: ++window._uid, skillId: soulId, state: { ancientBonus: this.ancientKills } };
    tower._skillInstances.push(inst);
    const def = this.skills[soulId];
    if (def?.onEquip) def.onEquip(tower.id, inst, this._ctx());
    if (def) {
      this.effects.apply(tower.id, {
        name: def.name, icon: def.icon, color: def.color, kind: 'display',
        duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: def.descTemplate, description: def.description || '龙魂',
      }, `soul_display_${soulId}`);
    }
  }

  // 多选叠加版：装备/卸下某个龙魂时不影响其他已装备的龙魂（供龙魂穿梭框手动多选使用）。
  // 与 _equipSoul（单一替换，供击杀自动解锁使用）是两套独立入口。
  _toggleSoul(tower, soulId) {
    const existing = (tower._skillInstances || []).find(s => s.skillId === soulId);
    if (existing) {
      const def = this.skills[soulId];
      if (def?.onUnequip) def.onUnequip(tower.id, existing, this._ctx());
      const disp = this.effects.getEffects(tower.id).find(e => e.sourceId === `soul_display_${soulId}`);
      if (disp) this.effects.remove(disp.id);
      tower._skillInstances = tower._skillInstances.filter(s => s !== existing);
      return false; // 已卸下
    }
    const inst = { id: ++window._uid, skillId: soulId, state: { ancientBonus: this.ancientKills } };
    tower._skillInstances.push(inst);
    const def = this.skills[soulId];
    if (def?.onEquip) def.onEquip(tower.id, inst, this._ctx());
    if (def) {
      this.effects.apply(tower.id, {
        name: def.name, icon: def.icon, color: def.color, kind: 'display',
        duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: def.descTemplate, description: def.description || '龙魂',
      }, `soul_display_${soulId}`);
    }
    return true; // 已装备
  }

  _ctx() {
    return {
      entityContainer: this.entities,
      effectRegistry: this.effects,
      eventBus: this.eventBus,
      waveNumber: window.waveNumber || 0,
      attrCalc: this.attrCalc,
    };
  }

  // 注：早期还有一个 setSoulManual(soulId) 方法（"全局手动设置当前龙魂"），
  // 同属旧的"全局龙魂"设计，项目里同样没有任何调用点（现在的龙魂穿梭框 UI
  // 用的是 _toggleSoul，每塔独立、可多选叠加，完全不走这条路径）。一并清理，
  // 避免留下一个内部调用了已删除方法的坏函数。

  getState() {
    const { total, threshold } = this._soulRule;
    return {
      killCounts: { ...this.killCounts },
      totalKills: this.totalKills,
      soulUnlocked: this.soulUnlocked,
      ancientKills: this.ancientKills,
      nextDragonTime: this.nextDragonTime,
      // 阵营龙魂规则的可观测状态（UI 与验收都读这里）
      elementDragonSpawned: this.elementDragonSpawned,
      elementDragonTotal: total,
      soulThreshold: threshold,
      factionTotals: { ...this.factionTotals },
      soulResolved: this.soulResolved,
      soulOwner: this.soulOwner,
      souls: this.getSouls(),
    };
  }
}
