import { CONFIG } from '../data/Config.js';

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

    this.nextDragonTime = 60; // 首条元素龙：开局60秒
    this.paused = true; // 开局默认暂停巨龙生成（用户要求：巨龙系统待大改，先默认关闭；原开关照常可开启）
    this.createEntity = null;
    this.elementDragonSpawned = 0; // 已刷新的元素龙数
    this.ancientSpawned = 0;       // 已刷新的远古龙数

    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;

    this._bindDeath();
  }

  setCreateEntity(fn) { this.createEntity = fn; }

  _bindDeath() {
    this.eventBus.on('entity:death', ({ entityId }) => {
      const e = this.entities.get(entityId);
      if (e && e.type === 'dragon') this._onDragonKilled(e);
    });
  }

  // 下一条龙的刷新间隔（秒）——龙刷新后从此刻起重新计时。
  _nextInterval() {
    if (this.soulUnlocked) {
      // 首条远古龙 5min，之后每 10min
      return this.ancientSpawned <= 1 ? 300 : 600;
    }
    // 元素龙：第2条=7min，第3条=8min，第4条=9min（首条已在构造时设为60s）
    const n = this.elementDragonSpawned;
    if (n === 1) return 7 * 60;
    if (n === 2) return 8 * 60;
    if (n === 3) return 9 * 60;
    return 9 * 60;
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
  _dragonStats(dragonIndex, isAncient) {
    const w = Math.max(1, dragonIndex);
    let hp;
    if (w <= 4) hp = 1200 + (w - 1) * 600;              // 1200 → 3000
    else hp = 3000 + (w - 4) * 500;
    let res;
    if (w <= 4) res = -40 + (w - 1) * (240 / 3);        // -40 → 200
    else res = Math.min(200 + (w - 4) * 30, 500);
    let ad;
    if (w <= 4) ad = 23 + (w - 1) * (229 / 3);          // 23 → 252
    else ad = 252 + (w - 4) * 60;

    if (isAncient) { hp *= 1.15; res += 40; ad *= 1.1; } // 远古龙仅轻微上升
    return { maxHP: Math.round(hp), armor: Math.round(res), magicResist: Math.round(res), attackDamage: Math.round(ad) };
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
      // 给这座塔元素增益
      this._applyElementBuffToTower(tower, el);
      // 这座塔达到4条且尚未解锁 → 解锁它自己的龙魂
      if (!tower._soulUnlocked && tower._dragonTotalKills >= 4) {
        this._unlockSoulForTower(tower);
      }
    }
    this.eventBus.emit('dragon:killed', { element: el, totalKills: this.totalKills, killCounts: { ...this.killCounts } });
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

  // 为单个塔解锁龙魂（按该塔击杀最多的元素）
  _unlockSoulForTower(tower) {
    let best = null, bestCount = -1;
    for (const [el, cnt] of Object.entries(tower._dragonKills || {})) {
      if (cnt > bestCount) { bestCount = cnt; best = el; }
    }
    if (!best) return;
    const soulId = DRAGON_ELEMENTS[best].soul;
    tower._soulUnlocked = true;
    tower._currentSoul = soulId;
    this._equipSoul(tower, soulId);
    // 首个塔解锁 → 开始刷新远古龙
    if (!this.soulUnlocked) {
      this.soulUnlocked = true;
      this._unlockWave = window.waveNumber || 4;
      this.ancientSpawned = 0;
      this.nextDragonTime = 300;
    }
    this.eventBus.emit('dragon:soulUnlocked', { element: best, soulId, label: DRAGON_ELEMENTS[best].label, towerId: tower.id });
  }

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
    return {
      killCounts: { ...this.killCounts },
      totalKills: this.totalKills,
      soulUnlocked: this.soulUnlocked,
      ancientKills: this.ancientKills,
      nextDragonTime: this.nextDragonTime,
    };
  }
}
