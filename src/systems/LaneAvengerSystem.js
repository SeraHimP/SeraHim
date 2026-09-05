import { CONFIG } from '../data/Config.js';

/**
 * LaneAvengerSystem.js —— v33（Q20）「哀兵」
 *
 * 规则（用户定稿）：
 *   某阵营在某一路上的己方【攻击塔】（外塔/内塔/水晶塔，最多 3 座）每被敌方摧毁 1 座，
 *   且该路的己方召唤水晶仍存活时——【该路走廊范围内的所有己方小兵】每层获得
 *   +1% 伤害增幅、+3% 伤害减免。
 *
 * 关键语义：
 *   · "该路范围内的所有己方小兵"= 距该路折线 ≤ 200px（与索敌半径一致）的任何己方小兵，
 *     不论它是从哪路生成的——中路兵游走到上路也吃上路的哀兵层数。
 *   · 小兵离开路径范围 → 失效（走光环机制：宽限期内不刷新即脱落）。
 *   · 该路己方召唤水晶被摧毁 → 整路失效；水晶重生后恢复。
 *   · 召唤水晶与小兵身上【都显示】该效果（水晶上的那份同时也是"这路正在哀兵"的可视标记）。
 *
 * 实现：效果系统 + 光环机制（aura:true）。层数 = 该路己方被毁攻击塔计数
 * （entity:death 事件驱动，地图加载时清零；塔不会重生，计数只增不减）。
 * 0.5s 节奏轮询应用——与其它光环同一套宽限期语义，零闪烁。
 */

const LANE_RANGE = 200;    // "在这条路上"的判定半径（= 小兵索敌半径）
const TICK = 0.5;          // 应用节奏（秒）；光环宽限期 1.2s > 节奏，不会闪断
const ATTACK_TIERS = new Set(['outer', 'inner', 'base']);

export class LaneAvengerSystem {
  constructor(entityContainer, effectRegistry, eventBus, mapSystem) {
    this.entities = entityContainer;
    this.fx = effectRegistry;
    this.mapSystem = mapSystem;
    this._timer = 0;
    this._lost = { blue: {}, red: {} }; // { faction: { laneId: 被毁攻击塔数 } }

    eventBus.on('map:loaded', () => { this._lost = { blue: {}, red: {} }; });
    eventBus.on('entity:death', ({ entityId }) => {
      const e = this.entities.get(entityId);
      if (!e || e.type !== 'tower' || !e._mapFaction || !e._laneId) return;
      if (!ATTACK_TIERS.has(e._mapTier)) return;
      const rec = this._lost[e._mapFaction] || (this._lost[e._mapFaction] = {});
      rec[e._laneId] = Math.min(3, (rec[e._laneId] || 0) + 1);
    });
  }

  /** 该阵营在该路的哀兵层数（0~3）；水晶不存活时为 0 */
  getStacks(faction, laneId) {
    const n = this._lost[faction]?.[laneId] || 0;
    if (n <= 0) return 0;
    if (!this._laneNexusAlive(faction, laneId)) return 0;
    return n;
  }

  _laneNexusAlive(faction, laneId) {
    for (const t of this.entities.getAllTowers(true)) {
      if (t._mapTier === 'nexus_lane' && t._mapFaction === faction && t._laneId === laneId) return true;
    }
    return false;
  }

  update(dt) {
    if (!this.mapSystem.active || !this.mapSystem.currentMap) return;
    this._timer += dt;
    if (this._timer < TICK) return;
    this._timer = 0;

    // 收集当前有哀兵层数的 (faction, lane)
    const activeLanes = [];
    for (const faction of ['blue', 'red']) {
      for (const lane of this.mapSystem.currentMap.lanes) {
        const stacks = this.getStacks(faction, lane.id);
        if (stacks > 0) activeLanes.push({ faction, lane, stacks });
      }
    }
    if (!activeLanes.length) return;

    // 己方小兵：命中多条哀兵路时取最高层数（一个单位只挂一份，不叠路）
    for (const m of this.entities.getAllMinions(true)) {
      if (m.type === 'dragon' || !m.pos) continue;
      const mf = m._mapFaction || m.faction;
      if (!mf) continue;
      let best = 0;
      for (const a of activeLanes) {
        if (a.faction !== mf) continue;
        if (this.mapSystem._nearestOnLane(a.lane, m.pos.x, m.pos.y).dist <= LANE_RANGE) {
          best = Math.max(best, a.stacks);
        }
      }
      if (best > 0) this._applyTo(m.id, best);
    }

    // 该路的召唤水晶也显示（存活是激活前提，必然找得到）
    for (const a of activeLanes) {
      for (const t of this.entities.getAllTowers(true)) {
        if (t._mapTier === 'nexus_lane' && t._mapFaction === a.faction && t._laneId === a.lane.id) {
          this._applyTo(t.id, a.stacks);
        }
      }
    }
  }

  _applyTo(entityId, stacks) {
    // 用户定稿：哀兵改为【只针对敌方小兵】的攻防加成——每层 +4% 对敌方小兵伤害、
    // +10% 减免来自敌方小兵的伤害。区别于旧版的"通用增幅/减免"（那会连带强化对塔输出）。
    // 这两项是【条件加成】：stat 管线只看防御方自身、拿不到攻击来源，故与"防御护盾"同款，
    // 由 CombatSystem 在结算处读层数生效；此处只负责挂效果（携带层数 + 供 UI 展示）。
    const base = [
      ['avengerVsMinionAmpPct', 4, '对敌方小兵伤害'],
      ['avengerVsMinionRedPct', 10, '减免敌方小兵伤害'],
    ];
    for (const [key, per, label] of base) {
      this.fx.apply(entityId, {
        name: '哀兵', icon: '⚔️', kind: 'stat', statKey: key,
        flatValue: per, perStackFlat: per,
        aura: true, auraGrace: 1.2,
        stackable: true, maxStacks: 3, stackPolicy: 'refresh',
        alwaysShowStacks: true, uniquePassive: true,
        descTemplate: `哀兵：该路己方防御塔陷落激发斗志（{val}%=${per}%×层数）${label}。离开该路或该路召唤水晶被摧毁后失效。`,
        description: `${label}+${per}%/层（{stacks}/3层）`,
      }, 'lane_avenger_' + key, { initialStacks: stacks });
    }
  }
}
