import { MAPS, DEFAULT_MAP_ID } from '../data/maps/index.js';
import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { isStructureProtected } from './FactionSystem.js';

/**
 * MapSystem.js
 * 读取地图配置（src/data/maps/）生成建筑与路径，管理"对战模式"专属的地图状态。
 * 沙盒模式完全不使用这个系统，互不干扰。
 *
 * 职责边界：
 * - 只负责"这张地图有哪些建筑、路径长什么样、水晶被摧毁后该阵营进入什么状态"。
 * - 不管小兵怎么走路径（LaneMovementSystem 的事）、不管战斗结算（CombatSystem 的事）、
 *   不管碰撞（CollisionSystem 的事）。
 *
 * tier 数值表：6层建筑（外塔/内塔/水晶塔/召唤水晶/枢纽塔/水晶枢纽），数值是绝对值
 * （不是相对沙盒塔的倍率——之前用倍率体系，但实际需求是直接指定每档具体数值，
 * 这样改起来更直观：想调"水晶塔多少血"直接改这一个数字，不用去算倍率）。
 * 以后调整某一档强度，或者新地图想用不同数值，只改这里（或者新地图自己声明一份覆盖），
 * 不用逐个建筑改。攻击距离统一用 CONFIG.templates.tower.attackRange（不按 tier 区分，
 * 所有会攻击的建筑共用同一个射程——之前误做成"每档不同射程"，已改正）。
 */
// 建筑显示半径由 CONFIG.buildingSizes 按 tier 提供（模板编辑器可调），不在此处。
// Q2 塔数值重排（LoL 对齐）：攻击力为【起步值】，成长由 passive_growth_* 技能按时间线性推进；
// 双抗为固定值（内塔 16:00 起的 +1/分钟 由成长技能负责）。生命/护盾：外4000+0/内3500+50/水晶3300+800/枢纽4750+0。
const TIER_STATS = {
  // v35（Q5）：所有建筑默认 固定护盾/生命恢复 = 0——这两项全部改由默认装备的
  // 可卸被动提供（水晶再生/加固城防/钢铁烈阳护盾），数值可见可拆。
  outer:      { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 40, magicResist: 40, attackDamage: 152, baseAttackSpeed: 0.833 },
  inner:      { maxHP: 3500, shieldFixedMax: 0, healthRegen: 0, armor: 55, magicResist: 55, attackDamage: 170, baseAttackSpeed: 0.833 },
  base:       { maxHP: 3300, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 3.08 },
  nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 150, baseAttackSpeed: 4.00 },
  nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
};

export class MapSystem {
  // effectRegistry 为可选注入（setEffectRegistry），仅用于 Q5 重生状态展示；不注入时功能自动降级。
  setEffectRegistry(fx) { this._fx = fx; }

  constructor(entityContainer, eventBus) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.currentMap = null;
    this.active = false;
    this.createBuildingFn = null;
    this.nexusDestroyed = { blue: {}, red: {} }; // { faction: { laneId: true } } —— 每路水晶独立摧毁状态
    this._buildingIds = [];
    this._clock = 0;              // 对战模式内部时钟（仅激活时推进），供水晶重生计时
    this._respawnQueue = [];      // [{ at, blueprint }] —— 召唤水晶重生队列
    this.NEXUS_RESPAWN_TIME = (CONFIG.tuning?.nexusRespawnTime) ?? 300; // 召唤水晶重生时间（秒），LoL 抑制水晶 5 分钟

    this.eventBus.on('entity:death', ({ entityId }) => this._onEntityDeath(entityId));
  }

  setCreateBuildingFn(fn) { this.createBuildingFn = fn; }

  getAvailableMaps() {
    return Object.values(MAPS).map(m => ({ id: m.id, label: m.label }));
  }

  loadMap(mapId = DEFAULT_MAP_ID) {
    const map = MAPS[mapId];
    if (map?.nexusRespawnTime != null) this.NEXUS_RESPAWN_TIME = map.nexusRespawnTime;
    if (!map) { console.warn('地图不存在:', mapId); return; }

    this.clearCurrentMap();
    // 进入对战模式：沙盒模式下玩家手动建的塔/小兵（没有 _mapFaction/_laneId 标记）
    // 之前完全没有被清理，会残留在对战模式的地图上。这里一并清空，让对战模式从干净状态开始。
    const sandboxEntities = this.entities.getAll(true).filter(e =>
      (e.type === 'tower' || this._isMinionType(e.type)) && !e._mapFaction && !e._laneId
    );
    for (const e of sandboxEntities) { e.alive = false; e.currentHP = 0; }
    this.entities.purgeDead();

    this.currentMap = map;
    // Store per-type skill overrides for CombatSystem auto-init
    SkillLibrary._mapOverrides = map.skillOverrides || {};
    SkillLibrary._excludeSkills = map.excludeSkills || {};
    this.nexusDestroyed = { blue: {}, red: {} }; // { faction: { laneId: true } } —— 每路水晶独立摧毁状态
    this._clock = 0;
    this._respawnQueue = [];

    if (this.createBuildingFn) {
      for (const b of map.buildings) {
        // Q9：地图可自带 tierStats 覆写（嚎哭深渊建筑数值与峡谷不同）
        const stats = (map.tierStats && map.tierStats[b.tier]) || TIER_STATS[b.tier] || TIER_STATS.outer;
        const isNexus = b.tier === 'nexus_lane' || b.tier === 'nexus_main';
        const entity = this.createBuildingFn({
          faction: b.faction,
          tier: b.tier,
          laneId: b.laneId,
          isNexus,
          pos: b.pos,
          weapon: b.weapon,
          stats,
          skills: b.skills, // Q9：地图可为建筑指定默认技能（如嚎哭深渊的统一成长/永久钢铁防线）
        });
        if (entity) this._buildingIds.push(entity.id);
      }
    }
    this.active = true;
    this.eventBus.emit('map:loaded', { mapId, label: map.label });
  }

  // 判断一个类型字符串是否是"小兵"类（塔/龙以外的都算），用于清理沙盒残留单位。
  _isMinionType(type) {
    return type !== 'tower' && type !== 'dragon';
  }

  // 规则性状态镜像到效果系统（Q1）：只增量变更，不每帧 apply（防进度环闪烁）
  _syncRuleStates() {
    if (!this._fx) return;
    for (const t of this.entities.getAllTowers(true)) {
      if (!t._mapFaction) continue;
      // Q5：无敌/停火按阵营分管 —— 每座塔读自己阵营的开关
      const inv = !!window.__towerRuleFor?.('invincible', t._mapFaction);
      const atkOff = !!window.__towerRuleFor?.('attackOff', t._mapFaction);

      // ① 结构保护
      const prot = isStructureProtected(this.entities, t);
      if (prot !== t._stateProtected) {
        t._stateProtected = prot;
        if (prot) {
          this._fx.apply(t.id, {
            name: '结构保护', icon: '🛡️', kind: 'custom',
            duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: ({
              inner: '本路外塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              base: '本路内塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              nexus_lane: '本路水晶塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              hq_tower: '三路召唤水晶完好期间：不可被选中、免疫一切伤害（含环境扣血）',
              nexus_main: '己方枢纽塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
            })[t._mapTier] || '外侧建筑存活期间：不可被选中、免疫一切伤害',
          }, 'rule_protected');
        } else {
          for (const e of this._fx.getEffects(t.id)) if (e.blueprint.name === '结构保护') this._fx.remove(e.id);
        }
      }

      // ② 全局无敌
      if (inv !== t._stateInvincible) {
        t._stateInvincible = inv;
        if (inv) {
          this._fx.apply(t.id, {
            name: '无敌', icon: '🛡️', kind: 'custom',
            duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: '设置：所有防御塔无敌（不受任何伤害）',
          }, 'rule_invincible');
        } else {
          for (const e of this._fx.getEffects(t.id)) if (e.blueprint.name === '无敌') this._fx.remove(e.id);
        }
      }

      // ③ 全局停火
      if (atkOff !== t._stateAttackOff) {
        t._stateAttackOff = atkOff;
        if (atkOff) {
          this._fx.apply(t.id, {
            name: '停火', icon: '🚫', kind: 'custom',
            duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: '设置：所有防御塔停火（不发起攻击）',
          }, 'rule_attackoff');
        } else {
          for (const e of this._fx.getEffects(t.id)) if (e.blueprint.name === '停火') this._fx.remove(e.id);
        }
      }
    }
  }

  clearCurrentMap() {
    for (const id of this._buildingIds) {
      const e = this.entities.get(id);
      if (e) {
        e.alive = false;
        e.currentHP = 0;
        // Q2：必须抹掉重生标记——purgeDead 特意豁免带 _respawnAt 的"幽灵水晶"（让它们能原地复活），
        // 于是切换地图时这些尸体不会被清掉，残留到新地图上。清图时它们不再需要重生。
        delete e._respawnAt;
        if (this._fx) {
          for (const eff of this._fx.getEffects(e.id)) this._fx.remove(eff.id);
        }
      }
    }
    this._buildingIds = [];
    // 兜底：任何带重生标记的幽灵（含不在 _buildingIds 里的历史残留）一律清除
    for (const e of this.entities.getAllTowers(false)) {
      if (e._respawnAt) { e.alive = false; e.currentHP = 0; delete e._respawnAt; }
    }
    this._respawnQueue = [];
    // 建筑之外，对战模式生成的小兵（带 _laneId 标记）也要一并清理，
    // 否则切回沙盒模式后这些小兵会残留在场上（沙盒战斗逻辑会跳过它们，
    // 但它们既不会被攻击也不会消失，永久卡场占用渲染/实体资源）。
    const laneMinions = this.entities.getAllMinions(true).filter(m => m._laneId);
    for (const m of laneMinions) { m.alive = false; m.currentHP = 0; }
    this.entities.purgeDead();
    this.active = false;
    this.currentMap = null;
  }

  getLane(laneId) {
    if (!this.currentMap) return null;
    return this.currentMap.lanes.find(l => l.id === laneId) || null;
  }

  _onEntityDeath(entityId) {
    if (!this.active) return;
    const e = this.entities.get(entityId);
    if (!e || !e._mapFaction) return;

    // 结构（塔/水晶）被摧毁后保留为"损毁"幽灵实体：alive=false 已使其不可攻击/索敌、
    // 不计入存活塔数与 isStructureProtected（两者都走 aliveOnly）。这里打 _ruin 标记，
    // purgeDead 特意豁免它（不删实体），渲染层据此切换为损毁模型。分路水晶会重生，
    // 复活时清除该标记（见 update() 的原地复活分支）。
    if (e._mapTier) e._ruin = true;

    if (e._mapTier === 'nexus_lane') {
      // 分路水晶摧毁：该路（e._laneId）追加生成超级兵，其余兵种不受影响（LoL 真实机制，版本B）。
      // 用 laneId 维度记录，而不是整个阵营——因为一个阵营三路的水晶是分别摧毁的。
      const faction = e._mapFaction, laneId = e._laneId;
      if (!laneId) return;
      this.nexusDestroyed[faction] = this.nexusDestroyed[faction] || {};
      if (this.nexusDestroyed[faction][laneId]) return;
      this.nexusDestroyed[faction][laneId] = true;
      this.eventBus.emit('map:nexusDestroyed', { faction, laneId });
      // 5 分钟后重生（LoL 抑制水晶机制）：从地图定义里找回这座水晶的蓝图入队
      const blueprint = this.currentMap?.buildings.find(b =>
        b.tier === 'nexus_lane' && b.faction === faction && b.laneId === laneId);
      // Q5：尸体保留（半透明可选中），到点原地复活；挂"重生中"状态（效果环即倒计时）
      e._respawnAt = this._clock + this.NEXUS_RESPAWN_TIME;
      if (this._fx) {
        this._fx.apply(e.id, {
          name: '重生中', icon: '⏳', kind: 'custom', duration: this.NEXUS_RESPAWN_TIME,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `召唤水晶重生中：${this.NEXUS_RESPAWN_TIME}s`,
        }, 'nexus_respawn_' + e.id);
      }
      if (blueprint) this._respawnQueue.push({ at: e._respawnAt, blueprint, corpseId: e.id });
    } else if (e._mapTier === 'nexus_main') {
      // 水晶枢纽摧毁：理论上是"游戏结束"的触发点，按之前确认暂不做终局判定，
      // 这里只发一个独立事件供以后接入，不影响现有的分路超级兵逻辑。
      this.eventBus.emit('map:mainNexusDestroyed', { faction: e._mapFaction });
    }
  }

  // 查询"某阵营的某一路"水晶是否已被摧毁（用于该路是否已进入"追加超级兵"状态）。
  /**
   * 该路召唤水晶【剩余重生时间】（秒）。未摧毁或已重生返回 null。
   * 供 Q2 使用：水晶即将重生时提前停发超级兵。
   */
  getNexusRespawnRemain(faction, laneId) {
    for (const q of this._respawnQueue) {
      if (q.blueprint?.faction === faction && q.blueprint?.laneId === laneId) {
        return Math.max(0, q.at - this._clock);
      }
    }
    return null;
  }

  isNexusDestroyed(faction, laneId) {
    return !!(this.nexusDestroyed[faction] && this.nexusDestroyed[faction][laneId]);
  }

  // 每帧由主循环调用：推进内部时钟，处理召唤水晶重生。
  update(dt) {
    if (!this.active) return;
    this._clock += dt;
    while (this._respawnQueue.length && this._respawnQueue[0].at <= this._clock) {
      const { blueprint: b, corpseId } = this._respawnQueue.shift();
      if (!this.currentMap) continue;
      const stats = (this.currentMap.tierStats && this.currentMap.tierStats[b.tier]) || TIER_STATS[b.tier] || TIER_STATS.outer;
      // Q5：优先原地复活尸体（技能/塔身在原实体上都还在，满血满盾归位即可）；
      // 尸体意外不在（旧存档等）才回退到重建路径。
      const corpse = corpseId ? this.entities.get(corpseId) : null;
      if (corpse) {
        corpse.alive = true;
        corpse.currentHP = stats.maxHP;
        corpse.shieldFixedCurrent = stats.shieldFixedMax || 0;
        corpse.tempShield = 0;
        delete corpse._respawnAt;
        delete corpse._respawnProgress;
        delete corpse._respawnRemain;
        delete corpse._ruin;   // 复活后不再是损毁幽灵
        this.entities.markDirty?.();
      } else if (this.createBuildingFn) {
        const entity = this.createBuildingFn({
          faction: b.faction, tier: b.tier, laneId: b.laneId,
          isNexus: true, pos: b.pos, weapon: b.weapon, stats, skills: b.skills,
        });
        if (entity) this._buildingIds.push(entity.id);
      }
      // 清除摧毁标记：下一波起对方停止追加超级兵（LoL 一致）
      if (this.nexusDestroyed[b.faction]) delete this.nexusDestroyed[b.faction][b.laneId];
      this.eventBus.emit('map:nexusRespawned', { faction: b.faction, laneId: b.laneId });
    }
    // ==================== Q1：三种"规则性状态"进效果系统（面板可见） ====================
    // ① 结构保护（水晶塔/枢纽塔未破时，召唤水晶/水晶枢纽不可选中且不可被攻击）
    // ② 全局防御塔无敌开关   ③ 全局防御塔停火开关
    // 设计取舍：战斗/索敌逻辑仍读各自的权威来源（isStructureProtected / window 开关），
    // 效果系统在这里做【状态镜像】——保证面板可见、图标统一，又不把战斗正确性押在
    // 每帧状态同步的时序上（状态晚一帧同步就漏判无敌，代价太大）。
    this._syncRuleStates();

    // Q3：把重生进度（0..1）与剩余秒数写到实体上，渲染器/UI 直接读——
    // _respawnAt 是绝对时钟值，只有 MapSystem 知道当前时钟与总时长，别处算不了。
    for (const q of this._respawnQueue) {
      if (!q.corpseId) continue;
      const corpse = this.entities.get(q.corpseId);
      if (!corpse) continue;
      const remain = Math.max(0, q.at - this._clock);
      corpse._respawnRemain = remain;
      corpse._respawnProgress = Math.max(0, Math.min(1, 1 - remain / this.NEXUS_RESPAWN_TIME)); // 填满即重生
    }
    // 重生状态描述每秒同步剩余秒数
    this._descTimer = (this._descTimer || 0) + dt;
    if (this._descTimer >= 1 && this._fx) {
      this._descTimer = 0;
      for (const q of this._respawnQueue) {
        if (!q.corpseId) continue;
        const eff = this._fx.getEffects(q.corpseId).find(x => x.blueprint.name === '重生中');
        if (eff) eff.blueprint.description = `召唤水晶重生中：${Math.max(0, Math.ceil(q.at - this._clock))}s`;
      }
    }
    // 注：重生队列按入队顺序即时间顺序（重生时长恒定），无需排序。
  }

  // 基地防守圈：以己方水晶枢纽为圆心，半径 = 枢纽到最远枢纽塔的距离 + 塔射程。
  // 供 LaneMovementSystem 的"守家优先"逻辑使用；按阵营缓存，地图加载后不变。
  getDefenseZone(faction) {
    if (!this.currentMap) return null;
    this._defenseZones = this._defenseZones || {};
    if (this._defenseZones[faction] && this._defenseZones[faction].mapId === this.currentMap.id) {
      return this._defenseZones[faction];
    }
    const nexus = this.currentMap.buildings.find(b => b.tier === 'nexus_main' && b.faction === faction);
    if (!nexus) return null;
    let maxD = 0;
    for (const b of this.currentMap.buildings) {
      if (b.tier === 'hq_tower' && b.faction === faction) {
        maxD = Math.max(maxD, Math.hypot(b.pos.x - nexus.pos.x, b.pos.y - nexus.pos.y));
      }
    }
    const towerRange = 180; // 与 CONFIG.templates.tower.attackRange 一致（建筑统一射程）
    const zone = { x: nexus.pos.x, y: nexus.pos.y, r: maxD + towerRange, mapId: this.currentMap.id };
    this._defenseZones[faction] = zone;
    return zone;
  }

  // ==================== v33：基地圈（红/蓝高地区域）—— 渲染与基地光环共用的数据源 ====================
  // 圆心 = 该方基地角点（蓝 = 左下 (0, WH)，红 = 右上 (WW, 0)）；
  // 半径 = 覆盖该方全部高地建筑（水晶枢纽/枢纽塔/召唤水晶/水晶塔）的最远距离 + 塔身半径。
  // 画布上画多大圈，基地光环就罩多大——一处数据，两处使用（Q9）。
  getBaseCircleCenter(faction) {
    if (!this.currentMap?.world) return null;
    const { w: WW, h: WH } = this.currentMap.world;
    return faction === 'blue' ? { x: 0, y: WH } : { x: WW, y: 0 };
  }

  getBaseCircleRadius(faction) {
    if (!this.currentMap) return null;
    // v34（Q1）：地图显式声明半径优先（高地塔按"距入口180"摆放依赖固定的圈，
    // 反推算法会形成"位置依赖圈、圈依赖位置"的循环）。未声明的旧地图退回反推。
    if (this.currentMap.baseCircleRadius) return this.currentMap.baseCircleRadius;
    this._baseCircles = this._baseCircles || {};
    const cached = this._baseCircles[faction];
    if (cached && cached.mapId === this.currentMap.id) return cached.r;
    const center = this.getBaseCircleCenter(faction);
    if (!center) return null;
    const HIGHGROUND = new Set(['nexus_main', 'hq_tower', 'nexus_lane', 'base']);
    const bSizes = CONFIG.buildingSizes || {};
    let far = 0;
    for (const b of this.currentMap.buildings || []) {
      if (b.faction !== faction || !HIGHGROUND.has(b.tier)) continue;
      const r = bSizes[b.tier] || bSizes.default || 28;
      far = Math.max(far, Math.hypot(b.pos.x - center.x, b.pos.y - center.y) + r);
    }
    const r = far > 0 ? far : (this.currentMap.world?.w || 3552) * 0.37;
    this._baseCircles[faction] = { r, mapId: this.currentMap.id };
    return r;
  }

  // ==================== v33（Q8）：地图墙壁 —— "走廊模型" ====================
  // 可行走区域 = 三路兵线走廊（折线 ± corridorHalfWidth）∪ 双方基地高地区（基地圈）。
  // 其余全是"墙"（野区/丛林）。这在小兵行为上与逐块复刻 LoL 野区墙体等效
  //（小兵不进野区），同时天然实现两条 LoL 机制：
  //   · 追击不能穿墙：追出走廊会被推回来；
  //   · 高地塔不可被合围：进高地只有走廊那一个口子，站位扇面受走廊约束。
  // 只挡【单位】不挡子弹（LoL 塔弹同样穿墙）。
  hasWalls() {
    return !!(this.active && this.currentMap?.walls);
  }

  _wallHalfWidth() {
    return this.currentMap?.walls?.corridorHalfWidth ?? 95;
  }

  /** 点到折线的最近投影：返回 { dist, px, py } */
  _nearestOnLane(lane, x, y) {
    const wps = lane.waypoints;
    let best = { dist: Infinity, px: 0, py: 0 };
    for (let i = 0; i < wps.length - 1; i++) {
      const ax = wps[i].x, ay = wps[i].y, bx = wps[i + 1].x, by = wps[i + 1].y;
      const vx = bx - ax, vy = by - ay;
      const L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2));
      const px = ax + t * vx, py = ay + t * vy;
      const d = Math.hypot(x - px, y - py);
      if (d < best.dist) best = { dist: d, px, py };
    }
    return best;
  }

  /** v36（Q6）：完全开放的内圈半径（baseOpenRadius 未声明的旧地图 = 与 baseCircleRadius 相同，即无收束段） */
  getBaseOpenRadius(faction) {
    if (!this.currentMap) return null;
    return this.currentMap.baseOpenRadius || this.getBaseCircleRadius(faction);
  }

  /** 该点是否在可行走区域内（无墙地图恒 true） */
  isWalkable(x, y) {
    if (!this.hasWalls()) return true;
    const hw = this._wallHalfWidth();
    for (const lane of this.currentMap.lanes) {
      if (this._nearestOnLane(lane, x, y).dist <= hw) return true;
    }
    for (const f of ['blue', 'red']) {
      const c = this.getBaseCircleCenter(f), r = this.getBaseOpenRadius(f);
      if (c && r && Math.hypot(x - c.x, y - c.y) <= r) return true;
    }
    // C 组·河道玩法化（默认关闭 → 对失败集合零影响；setRiverWalkable(true) 开启）：
    // 主对角线河带（与 heightAt 的河床同一带）变为可行走，横穿并连通三路——LoL 式河道。
    // 已知并接受的后果（用户定稿）：跨河视线打通、小兵可能临时滞留河中、sim_avoid 基准会变。
    if (this._riverWalkable) {
      const cfg = this.currentMap.heightZones || {};
      const rh = cfg.riverHalfWidth ?? 200;
      if (Math.abs(x - y) * 0.70710678 < rh) return true;
    }
    return false;
  }

  /** C 组·河道玩法化开关（默认关闭，保持既有玩法与失败集合基线）。 */
  setRiverWalkable(on) { this._riverWalkable = !!on; return this._riverWalkable; }

  /**
   * C 组·台阶地形：某点的【地面高度】（世界单位）。纯渲染/摆位查询——仿真层不读它，
   * 不影响 isWalkable/移动/索敌，故加它对失败集合零影响。默认两级台阶：
   *   高地 +20（两基地平台，baseOpenRadius 内）、河床 −10（主对角线 x≈z 河带）。
   * 数值可由 map.heightZones 覆写；WallLayer 的丛林崖体不经此处（那是另一套，别动崖面绕序）。
   */
  heightAt(x, z) {
    const m = this.currentMap;
    if (!m || !m.world || !this.hasWalls?.()) return 0;
    const cfg = m.heightZones || {};
    const riverHalf = cfg.riverHalfWidth ?? 200, riverDepth = cfg.riverDepth ?? -10;
    const platH = cfg.plateauHeight ?? 20;
    let h = 0;
    // 河床：到主对角线 x=z 的垂距（÷√2）小于半宽 → 下沉
    if (Math.abs(x - z) * 0.70710678 < riverHalf) h = Math.min(h, riverDepth);
    // 高地：两基地平台。Q4——边缘做成【斜坡】而非陡坎：内核 rFull 内满高 platH，
    // rFull→rEdge 之间线性降到 0，于是从各兵线口离开基地都是一段可走的坡（红圈处）。
    const rFull = cfg.plateauFull ?? 0.60, rEdge = cfg.plateauEdge ?? 0.98;
    for (const f of ['blue', 'red']) {
      const c = this.getBaseCircleCenter(f), r = this.getBaseOpenRadius(f);
      if (!c || !r) continue;
      const d = Math.hypot(x - c.x, z - c.y), a = r * rFull, b = r * rEdge;
      if (d >= b) continue;
      const t = d <= a ? 1 : 1 - (d - a) / Math.max(1e-6, b - a);   // 1（核心）→ 0（坡脚）
      h = Math.max(h, platH * t);
    }
    return h;
  }

  /**
   * 把位置约束回可行走区域（就地修改 pos）。返回是否发生了修正。
   * 修正目标 = 所有走廊/基地区中【离该点最近的合法点】（贴着墙内侧 2px）。
   */
  /**
   * v39（Q3）：把"越界后钳回最近合法点"升级为【沿墙滑行】。
   * 旧行为是纯投影：兵对着墙推 → 每帧被推回同一点 → 视觉上贴着墙原地磨、一动不动。
   * 现在额外返回墙的法向，调用方把速度里"撞进墙"的分量剔除，剩下的切向分量得以保留，
   * 于是贴着墙面滑过去。返回值：false=未越界；{nx,ny}=越界并已修正，附墙面法向。
   */
  constrainToWalkable(pos) {
    if (!this.hasWalls()) return false;
    const hw = this._wallHalfWidth();
    let best = null, bestMove = Infinity;
    for (const lane of this.currentMap.lanes) {
      const n = this._nearestOnLane(lane, pos.x, pos.y);
      if (n.dist <= hw) return false; // 已在某条走廊内，无需修正
      const move = n.dist - hw;
      if (move < bestMove) {
        const ux = (pos.x - n.px) / n.dist, uy = (pos.y - n.py) / n.dist;
        best = { x: n.px + ux * (hw - 2), y: n.py + uy * (hw - 2), nx: -ux, ny: -uy };
        bestMove = move;
      }
    }
    for (const f of ['blue', 'red']) {
      const c = this.getBaseCircleCenter(f), r = this.getBaseOpenRadius(f); // v36 Q6：用开放内圈（不是外层收束边界）
      if (!c || !r) continue;
      const d = Math.hypot(pos.x - c.x, pos.y - c.y);
      if (d <= r) return false; // 在基地区内
      const move = d - r;
      if (move < bestMove) {
        const ux = (pos.x - c.x) / (d || 1), uy = (pos.y - c.y) / (d || 1);
        best = { x: c.x + ux * (r - 2), y: c.y + uy * (r - 2), nx: -ux, ny: -uy };
        bestMove = move;
      }
    }
    if (best) { pos.x = best.x; pos.y = best.y; return { nx: best.nx, ny: best.ny }; }
    return false;
  }
}
