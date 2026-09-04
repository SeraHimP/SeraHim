import { MAPS, DEFAULT_MAP_ID } from '../data/maps/index.js';
import { MODES, CLASSIC_ID_SUFFIX, applyClassicMode } from '../data/maps/modeTransforms.js';
import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { isStructureProtected, mapFactionsOf } from './FactionSystem.js';
import { SR_NAVGRID, SR_PITS } from '../data/maps/sr_navgrid.js';
import { baseCircleCenter } from '../data/baseCircle.js';
import { unpackBits } from '../data/navgrid.js';
import { LIVE_EDIT_SESSION_MAP_ID } from '../data/mapEditorCore.js';
import { resolveAuraEffectValue } from './AuraValueResolver.js';
// 重生血量与出生血量必须用同一个"最大生命"口径，见 factories.js spawnAtFullHP 头注。
import { effectiveMaxHP } from '../core/factories.js';
// 复活要清哪些标记：唯一清单，两条复活路径共用（见该文件头注）。
import { clearDamageMarks } from '../core/reviveState.js';

/**
 * MapSystem.js
 * 读取地图配置（src/data/maps/）生成建筑与路径，管理地图相关的对局状态。
 *
 * 职责边界：
 * - 只负责"这张地图有哪些建筑、路径长什么样、水晶被摧毁后该阵营进入什么状态"。
 * - 不管小兵怎么走路径（LaneMovementSystem 的事）、不管战斗结算（CombatSystem 的事）、
 *   不管碰撞（CollisionSystem 的事）。
 *
 * tier 数值表：6层建筑（外塔/内塔/水晶塔/召唤水晶/枢纽塔/水晶枢纽），数值是绝对值
 * （不是相对基础模板的倍率——之前用倍率体系，但实际需求是直接指定每档具体数值，
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
  base:       { maxHP: 3300, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 70, attackDamage: 170, baseAttackSpeed: 2.50 },
  nexus_lane: { maxHP: 4000, shieldFixedMax: 0, healthRegen: 0, armor: 20, magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
  hq_tower:   { maxHP: 4750, shieldFixedMax: 0, healthRegen: 0, armor: 70, magicResist: 110, attackDamage: 150, baseAttackSpeed: 4.00 },
  nexus_main: { maxHP: 5500, shieldFixedMax: 0, healthRegen: 0, armor: 0,  magicResist: 0,  attackDamage: 0,   baseAttackSpeed: 0 },
};

export class MapSystem {
  // effectRegistry 为可选注入（setEffectRegistry），仅用于 Q5 重生状态展示；不注入时功能自动降级。
  setEffectRegistry(fx) { this._fx = fx; }

  constructor(entityContainer, eventBus) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.currentMap = null;
    this.currentMode = MODES.normal.id;   // v51.20：地图/模式两条轴，模式默认普通
    this.currentBaseMapId = null;         // 不含 _classic 后缀的"真地图" id，UI 高亮用
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

  /**
   * 在【当前已加载的地图】上现场再造一座建筑，不重新走 loadMap()（那会清空全场、
   * 归零对局时钟、重置召唤水晶重生队列——对"只是想再加一座塔"这个操作来说代价太大）。
   * 地图编辑器主画面工具条的"➕ 添加塔"工具用它：数值/技能查表逻辑与 loadMap()
   * 建塔那段、以及水晶重生那条建塔路径（本文件下方 _respawnNexus 附近）完全一致——
   * 三处都在造同一种东西，数值来源必须是同一张 TIER_STATS/tierStats 表，不能各查各的。
   * @param {{faction:string, tier:string, laneId:?string, pos:{x:number,y:number}, weapon?:string, skills?:string[]}} b
   * @returns {object|null} 新建的实体（createBuildingFn 未注入或造塔失败时为 null）
   */
  addBuildingLive(b) {
    if (!this.createBuildingFn || !this.currentMap) return null;
    const stats = (this.currentMap.tierStats && this.currentMap.tierStats[b.tier]) || TIER_STATS[b.tier] || TIER_STATS.outer;
    const isNexus = b.tier === 'nexus_lane' || b.tier === 'nexus_main';
    const entity = this.createBuildingFn({
      faction: b.faction, tier: b.tier, laneId: b.laneId ?? null, isNexus,
      pos: b.pos, weapon: b.weapon, stats, skills: b.skills,
    });
    if (entity) this._buildingIds.push(entity.id);
    return entity;
  }

  /**
   * v51.32：内置地图（MAPS）∪ 自制地图（CONFIG.customMaps，地图编辑器落盘的地方，
   * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.5）。
   * `getAvailableMaps`/`getMapById`/`loadMap` 三处都要认自制地图，统一从这一个
   * 方法取——踩过的坑（docs/DEVELOPMENT.md §5"已知的坑"）："列表不要写死"：
   * 只改其中一处会变成"地图能加载但选不到"或"能选到但加载空白"这类各写一半的故障，
   * 一处改就三处一起跟上。CONFIG.customMaps 里的 id 与内置地图撞车时内置地图优先——
   * 自制地图不该有能力顶掉三张官方图，真出现同名多半是用户手改配置时的失误，
   * 优先内置图能让游戏保持能玩，而不是静默换成一张来源不明的地图。
   */
  _mapRegistry() {
    const custom = (CONFIG.customMaps && typeof CONFIG.customMaps === 'object') ? CONFIG.customMaps : null;
    return custom ? { ...custom, ...MAPS } : MAPS;
  }

  getAvailableMaps() {
    // 地图编辑器主画面工具条借这个 id 落一份临时草稿（见 mapEditorCore.js 头注的
    // LIVE_EDIT_SESSION_MAP_ID 说明），不是用户存过的真地图，选图列表里不该出现它。
    // getMapById()/loadMap() 不受影响——它们要能正常找到并加载这个 id。
    return Object.values(this._mapRegistry())
      .filter(m => m.id !== LIVE_EDIT_SESSION_MAP_ID)
      .map(m => ({ id: m.id, label: m.label }));
  }

  /** v51.20：模式列表（普通/经典），与地图是两条独立的轴，UI 先选这个再选地图。 */
  getAvailableModes() {
    return Object.values(MODES);
  }

  /**
   * v45：按 id 取地图数据。给"需要问地图声明了什么"的系统用（目前是 DragonSystem
   * 问 `dragon.enabled`）。走这一个入口而不是让各系统自己 import MAPS ——
   * 自制地图也注册在 MAPS 里，但入口只有一个，以后改注册方式只改这一处。
   *
   * v51.20：经典模式不是一张注册在 MAPS 里的独立地图，是"基础地图 id + _classic
   * 后缀"现算出来的——这里认得这个后缀，现场套 applyClassicMode 变换、不用另外注册。
   */
  getMapById(id) {
    const reg = this._mapRegistry();
    if (reg[id]) return reg[id];
    if (typeof id === 'string' && id.endsWith(CLASSIC_ID_SUFFIX)) {
      const base = reg[id.slice(0, -CLASSIC_ID_SUFFIX.length)];
      if (base) return applyClassicMode(base);
    }
    return null;
  }

  /**
   * v51.20：mapId 是"真地图" id（如 summoners_rift_v1）；mode 是 MODES 里的一个 id
   * （'normal' | 'classic'），缺省是 'normal' —— 一个不带后缀的裸 id 本来就该是"这张图
   * 的普通版"，不该悄悄沿用上一次调用留下的 currentMode（那样太容易在别处踩坑：调用方
   * 明明只传了 id，却因为"之前切过经典模式"而拿到经典模式的塔）。
   * 唯一的例外是 mapId 自己带 _classic 后缀——那是 `mapSystem.loadMap(mapSystem
   * .currentMap.id)`（main.js __resetRun 那种"原样重载当前图"的调用）在经典模式下
   * 拿到的形状，这时才需要自动识别后缀、拆成 base id + 推出 mode='classic'，
   * 不强制调用方都要记得多传一个参数。
   */
  loadMap(mapId = DEFAULT_MAP_ID, mode) {
    let baseId = mapId;
    let effectiveMode = mode;
    if (typeof mapId === 'string' && mapId.endsWith(CLASSIC_ID_SUFFIX)) {
      baseId = mapId.slice(0, -CLASSIC_ID_SUFFIX.length);
      if (effectiveMode === undefined) effectiveMode = MODES.classic.id;
    }
    if (effectiveMode === undefined) effectiveMode = MODES.normal.id;

    const base = this._mapRegistry()[baseId];
    if (!base) { console.warn('地图不存在:', mapId); return; }
    const map = effectiveMode === MODES.classic.id ? applyClassicMode(base) : base;

    if (map?.nexusRespawnTime != null) this.NEXUS_RESPAWN_TIME = map.nexusRespawnTime;

    this.clearCurrentMap();

    this.currentMap = map;
    this.currentMode = effectiveMode;
    this.currentBaseMapId = baseId;
    this.invalidateNav();   // navgrid 随地图重新解码（_fields 本来就会靠 mapId 变化自然失效，一并清掉不多余）
    // Store per-type skill overrides for CombatSystem auto-init
    SkillLibrary._mapOverrides = map.skillOverrides || {};
    SkillLibrary._excludeSkills = map.excludeSkills || {};
    this.nexusDestroyed = { blue: {}, red: {} }; // { faction: { laneId: true } } —— 每路水晶独立摧毁状态
    this._clock = 0;
    this._respawnQueue = [];

    // ⚠️ 必须在【创建建筑之前】发。听它的那一侧要把 gameTime 归零，
    // 而塔成长被动在 onEquip 里就把当时的 gameTime 记成了起算点 t0 ——
    // 归零晚一步，成长就被推迟"归零前已经过去的那么多秒"（见 main.js 的长注释）。
    // 用 map.id（可能带 _classic 后缀）而不是原始 mapId 入参——DragonSystem 等下游
    // 靠这个 id 反查 getMapById，经典模式下必须拿到变换后的那份（dragon 字段被清空）。
    this.eventBus.emit('map:loading', { mapId: map.id, label: map.label });

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
    this._computeWaypointBlock(map);
    this.active = true;
    this.eventBus.emit('map:loaded', { mapId: map.id, label: map.label });
  }

  /**
   * 逐路点算出"这个路点被建筑吃掉了多深"，结果写在 lane._wpBlock[i]（px，可为负）。
   *
   * 为什么需要：小兵推进路点索引的判据之一是"离该路点 < 到达半径"。
   * 而**两张新图的塔就压在兵线上**——扭曲丛林上路 wp8(1104,336) 离蓝方外塔(1085,328)
   * 只有 21px，塔的避障半径 35px（28 × towerVizScale 1.25），加上小兵自己 10px，
   * 小兵最近只能站到离路点 45−21 = 24px 处，而到达半径正好也是 24 —— **踩不中**。
   * 于是索引永远停在 8，兵一直朝着塔肚子里那个点走，绕着塔转圈
   *（实测 150 秒路程 9068px、净位移 534px，轨迹是以塔为圆心的正圆）。
   * 下路是 24px（45−24 = 21 < 24，够得着）所以不犯 —— 这正是用户说的"上路会下路不会"。
   *
   * 存的是【路点陷进建筑圆里多深】= 建筑半径 − 圆心距，不含小兵半径：
   * 小兵半径按类型不同，留到运行时再加（见 LaneMovementSystem 的到达半径）。
   * 每次 loadMap 重算，所以塔位改了不会用到旧值。
   */
  _computeWaypointBlock(map) {
    const sizes = CONFIG.buildingSizes || {};
    const vz = CONFIG.towerVizScale || {};
    for (const lane of (map.lanes || [])) {
      const out = new Array(lane.waypoints.length).fill(-Infinity);
      for (let i = 0; i < lane.waypoints.length; i++) {
        const w = lane.waypoints[i];
        for (const b of (map.buildings || [])) {
          const r = (sizes[b.tier] || sizes.default || 28) * (vz[b.tier] ?? vz.default ?? 1);
          out[i] = Math.max(out[i], r - Math.hypot(b.pos.x - w.x, b.pos.y - w.y));
        }
      }
      lane._wpBlock = out;
    }
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
          // 追加需求："结构保护的状态里面写：无敌。"——之前的描述只说"免疫一切
          // 伤害"，没有直接点出"无敌"这个词；跟下面②全局无敌开关（rule_invincible）
          // 的效果本质一样（免疫一切伤害），文案上也该同样直白。
          this._fx.apply(t.id, {
            name: '结构保护', icon: '🛡️', kind: 'custom',
            duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: ({
              inner: '无敌——本路外塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              base: '无敌——本路内塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              nexus_lane: '无敌——本路水晶塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
              hq_tower: '无敌——三路召唤水晶完好期间：不可被选中、免疫一切伤害（含环境扣血）',
              nexus_main: '无敌——己方枢纽塔存活期间：不可被选中、免疫一切伤害（含环境扣血）',
            })[t._mapTier] || '无敌——外侧建筑存活期间：不可被选中、免疫一切伤害',
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
    // 全局光环是**按地图**的：换图必须先把上一张图的那条从所有残留单位身上摘掉，
    // 否则跨图存活的单位（手动放的、还没被清掉的）会带着上一张图的光环进新图。
    if (this._fx) {
      for (const e of this.entities.getAll(false)) {
        for (const eff of this._fx.getEffects(e.id)) {
          if (eff.sourceId === 'map_global_aura') this._fx.remove(eff.id);
        }
      }
    }
    this._auraT = 0;
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
    // 建筑之外，出兵生成的小兵（带 _laneId 标记）也要一并清理，
    // 否则切换地图后这些小兵会残留在场上——既不会被攻击也不会消失，
    // 永久卡场占用渲染/实体资源。
    const laneMinions = this.entities.getAllMinions(true).filter(m => m._laneId);
    for (const m of laneMinions) { m.alive = false; m.currentHP = 0; }
    // ⚠️ 这里【不能】只靠 purgeDead 收尸。
    // purgeDead 现在的规则是"任何塔死后都留成废墟（_ruin）而不删除"——那是为了满足
    // "死亡的塔也应该能被选中"。于是 alive=false + purgeDead() 这套老写法对塔彻底失效：
    // 切地图时上一张图的塔一个都删不掉，全部变成废墟留在新图里（实测峡谷→扭曲丛林：
    // 容器里 46 座塔而不是 16 座，其中 8 座旧废墟落在新图可视范围内、有的就压在兵线上）。
    // 同一个坑此前以 _respawnAt 的形态出过一次（见上面那段注释）；_ruin 是第二扇门。
    // 所以对【本图自己的建筑】一律显式 remove，不走 purgeDead 那条会被豁免的路。
    for (const t of this.entities.getAllTowers(false)) {
      if (t._mapFaction || t._mapTier) { delete t._ruin; delete t._respawnAt; this.entities.remove(t.id); }
    }
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
      this.beginNexusRespawn(e);
    } else if (e._mapTier === 'nexus_main') {
      // 水晶枢纽摧毁：理论上是"游戏结束"的触发点，按之前确认暂不做终局判定，
      // 这里只发一个独立事件供以后接入，不影响现有的分路超级兵逻辑。
      this.eventBus.emit('map:mainNexusDestroyed', { faction: e._mapFaction });
    }
  }

  // ==================== 召唤水晶：一路可以有多座 ====================
  // 用户定稿（为以后的新地图预留）：「一路可能设置多个召唤水晶，必须这一路的
  // **所有**召唤水晶都被摧毁，才算这一路被摧毁」。
  // 原实现是"第一座死掉就 nexusDestroyed[faction][lane] = true 并 return"——
  // 峡谷每路恰好只有一座，所以看不出问题；一旦某张地图放两座，拆掉一座就会立刻
  // 开始给对方发超级兵，而防线其实还在。这类"数据一变就错、当前数据下看不出来"的
  // 假设，是最难在事后定位的一种。

  /**
   * 该阵营该路的所有召唤水晶实体（含尸体/废墟，用 aliveOnly 过滤）。
   * 从**实体容器**枚举而不是 this._buildingIds：后者只装地图加载时建的那批，
   * 手动添加/编辑器改过层级的水晶不在里面，那样"这一路还剩几座"就会漏数。
   * 场上真实存在什么，只有容器说了算。
   */
  laneNexuses(faction, laneId, aliveOnly = false) {
    const out = [];
    for (const e of this.entities.getAll(false)) {
      if (!e || e._mapTier !== 'nexus_lane') continue;
      if (e._mapFaction !== faction || e._laneId !== laneId) continue;
      if (aliveOnly && !e.alive) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * 这一路是否已经"全灭"。
   * ignoreId：把某个实体**无条件当作已倒下**。死亡链路上要用它 ——
   * 调用方是否已经把 alive 置成 false 是个时序细节（CombatSystem 是先置后发事件，
   * 但手写测试/别的调用点未必），把判定押在那上面，就会出现"最后一座拆了却不算陷落"
   * 这种偶发漏判，而且不会报任何错。
   */
  _laneNexusAllDown(faction, laneId, ignoreId = null) {
    const all = this.laneNexuses(faction, laneId, false);
    if (!all.length) return false;
    return all.every(e => !e.alive || e.id === ignoreId);
  }

  /** 依据"这一路是否全灭"刷新摧毁标记，并在状态翻转时发事件。 */
  _refreshLaneNexusFlag(faction, laneId, ignoreId = null) {
    if (!faction || !laneId) return;
    this.nexusDestroyed[faction] = this.nexusDestroyed[faction] || {};
    const now = this._laneNexusAllDown(faction, laneId, ignoreId);
    const was = !!this.nexusDestroyed[faction][laneId];
    if (now === was) return;
    if (now) {
      this.nexusDestroyed[faction][laneId] = true;
      this.eventBus.emit('map:nexusDestroyed', { faction, laneId });
    } else {
      delete this.nexusDestroyed[faction][laneId];
      this.eventBus.emit('map:nexusRespawned', { faction, laneId });
    }
  }

  /**
   * 让一座召唤水晶进入重生倒计时。**唯一入口** ——
   * 对局里的自然死亡（_onEntityDeath）和编辑器里的手动击杀都走这里。
   * 原来编辑器的"击杀"是自己写的一段（刻意绕开 entity:death 以免计分），
   * 于是手动打掉的召唤水晶【永远不会重生】，也不会触发超级兵：
   * 同一件事在两处各实现一半，正是本仓库反复出事的形状。
   */
  beginNexusRespawn(e) {
    if (!e || e._mapTier !== 'nexus_lane') return false;
    if (e._respawnAt) return false;                  // 已在倒计时里，不重复入队
    const faction = e._mapFaction, laneId = e._laneId;
    if (!laneId) return false;
    // 蓝图按【坐标】匹配这一座，不能用 (tier,faction,laneId) find 第一座 ——
    // 一路多座时那会永远取到同一份蓝图，尸体不在时的重建路径就会把水晶建到别处去。
    const blueprint = (this.currentMap?.buildings || []).find(b =>
      b.tier === 'nexus_lane' && b.faction === faction && b.laneId === laneId
      && b.pos && e.pos && Math.abs(b.pos.x - e.pos.x) < 1 && Math.abs(b.pos.y - e.pos.y) < 1)
      || (this.currentMap?.buildings || []).find(b =>
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
    if (blueprint) this._enqueueRespawn({ at: e._respawnAt, blueprint, corpseId: e.id,
                                          dur: this.NEXUS_RESPAWN_TIME, hpPct: 100, isNexus: true });
    // 这一路是不是全灭了，交给统一判定 —— 多水晶地图上"拆一座 ≠ 这一路没了"。
    // 传 e.id：这一座正在进重生倒计时，无论它的 alive 标记此刻是什么，都按"已倒下"算。
    this._refreshLaneNexusFlag(faction, laneId, e.id);
    return true;
  }

  /**
   * 入队并按到点时间排序。
   *
   * 排序这件事以前不需要：队列里只有召唤水晶、重生时长恒定，入队顺序天然就是时间顺序
   *（原来那行注释就是这么写的）。光魂进来之后不再成立 —— 光魂的 respawnSec 与
   * 召唤水晶的 NEXUS_RESPAWN_TIME 是两个独立可调的数，出队用的又是
   * `while (queue[0].at <= clock)`，一旦短的排在长的后面，短的会被长的堵在后面
   * 一直不出队。所以这里改成入队即排序。
   */
  _enqueueRespawn(item) {
    this._respawnQueue.push(item);
    this._respawnQueue.sort((a, b) => a.at - b.at);
    return item;
  }

  /**
   * 取消一座召唤水晶的重生倒计时（手动复活时用）。
   * 队列项、_respawnAt 标记、"重生中"状态三样**必须一起清** ——
   * 编辑器原来只清了前两样，于是复活之后那个 ⏳ 重生中 的状态还挂在水晶身上、
   * 描述里的秒数还在往下走，看起来就像"复活了但倒计时还在跑"。
   */
  cancelNexusRespawn(entityId) {
    let removed = 0;
    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      if (this._respawnQueue[i].corpseId === entityId) { this._respawnQueue.splice(i, 1); removed++; }
    }
    const e = this.entities.get(entityId);
    if (e) { delete e._respawnAt; delete e._respawnProgress; delete e._respawnRemain; }
    this._clearRespawnEffect(entityId);
    if (e) this._refreshLaneNexusFlag(e._mapFaction, e._laneId);
    return removed;
  }

  // 查询"某阵营的某一路"水晶是否已被摧毁（用于该路是否已进入"追加超级兵"状态）。
  /**
   * 该路召唤水晶【剩余重生时间】（秒）。未摧毁或已重生返回 null。
   * 供 Q2 使用：水晶即将重生时提前停发超级兵。
   *
   * 一路多座时取**最早**的那个：只要有一座回来了，这一路就不再是"已陷落"，
   * 超级兵红利也就该停 —— 取最晚的会让防守方白白多挨几波。
   */
  getNexusRespawnRemain(faction, laneId) {
    let best = null;
    for (const q of this._respawnQueue) {
      if (q.blueprint?.faction !== faction || q.blueprint?.laneId !== laneId) continue;
      const remain = Math.max(0, q.at - this._clock);
      if (best === null || remain < best) best = remain;
    }
    return best;
  }

  isNexusDestroyed(faction, laneId) {
    return !!(this.nexusDestroyed[faction] && this.nexusDestroyed[faction][laneId]);
  }

  /**
   * 该阵营是否已被淘汰——主水晶枢纽（nexus_main）全灭。
   * 用户定稿（docs/REPORT-2026-09-03-multifaction.md §4）："某一方水晶枢纽被摧毁，
   * 该方以及攻击该方的路径就不再生成小兵"，塔本身保留、仍可被攻击/反击（不是消失）。
   *
   * 动态从实体状态现算，不额外维护一个"已淘汰"标记——同 isStructureProtected 头注
   * 那条教训：缓存的状态迟早跟真实状态脱节（水晶手动复活/编辑器改动都可能漏更新），
   * 用得到时现算一次，没有"忘了同步"这类 bug 可能。
   * 这张图对该阵营没有声明 nexus_main（比如未来的中立阵营）→ 不算淘汰。
   */
  isFactionEliminated(faction) {
    const mains = this.entities.getAllTowers(false)
      .filter(t => t._mapFaction === faction && t._mapTier === 'nexus_main');
    if (!mains.length) return false;
    return mains.every(t => !t.alive);
  }

  /** 摘掉那颗 ⏳「重生中」状态。EffectRegistry.remove 收的是 effectId，不是 (entityId, source)。 */
  _clearRespawnEffect(entityId) {
    const eff = this._fx?.getEffectByName?.(entityId, '重生中');
    if (eff) this._fx.remove(eff.id);
  }

  /**
   * 各阵营各档建筑的存活/摧毁统计 —— 出兵编排的「条件」读这个。
   * 分路的档位（外/内/水晶塔/召唤水晶）按 laneId 再分一层；
   * 枢纽塔与水晶枢纽在地图定义里 laneId 为 null，属于全场。
   */
  structureCensus() {
    const mk = () => ({ total: 0, alive: 0 });
    // 多阵营地基（docs/REPORT-2026-09-03-multifaction.md §3）：按地图声明的阵营
    // 列表动态建表，不再写死 {blue,red} 两个 key——改动前只有两阵营地图，
    // mapFactionsOf 未声明时兜底就是 [blue,red]，行为逐位不变。
    const out = {};
    for (const faction of mapFactionsOf(this.currentMap)) out[faction] = { all: {}, lanes: {} };
    // 同样从容器枚举（理由见 laneNexuses）：编排的条件问的是"场上还剩几座"，
    // 而不是"地图当初建了几座"。
    for (const e of this.entities.getAll(false)) {
      if (!e || !e._mapTier || !e._mapFaction) continue;
      const f = out[e._mapFaction];
      if (!f) continue;
      const t = e._mapTier;
      f.all[t] = f.all[t] || mk();
      f.all[t].total++; if (e.alive) f.all[t].alive++;
      const lane = e._laneId;
      if (!lane) continue;
      f.lanes[lane] = f.lanes[lane] || {};
      f.lanes[lane][t] = f.lanes[lane][t] || mk();
      f.lanes[lane][t].total++; if (e.alive) f.lanes[lane][t].alive++;
    }
    return out;
  }

  // 每帧由主循环调用：推进内部时钟，处理召唤水晶重生。
  /**
   * 地图全局光环：把 map.globalAura 声明的效果挂到**场上所有单位**（现有 + 待生成）。
   *
   * 用户定稿：
   *   嚎哭深渊 —— 所有单位治疗与护盾强度 −80%
   *   扭曲丛林 —— 所有单位 +18 固定双穿；+[0.5% × 本局分钟数] 攻速（上限 15%）
   * "所有单位"按用户确认= **真的所有**，含防御塔与水晶。
   *
   * 为什么放在这里逐帧刷，而不是在单位创建时挂一次：
   *   ① "待生成"的单位不需要任何额外接线 —— 下一次 tick 自然就带上了，
   *      出兵/建塔/水晶重生/手动放置全都覆盖到，不会漏掉某条创建路径；
   *   ② 有些条目是**随时间变的**（扭曲丛林的攻速随分钟数涨），必须重算；
   *   ③ permanent + refresh 的 apply 是幂等的，重复挂只会更新数值（见 EffectRegistry.apply）。
   * 节流到 refreshSec（默认 0.5s）一次：几百个实体的遍历，30Hz 跑纯属白烧。
   *
   * 2026-09-04：数值解析从这里内联的"看 perMinute 存不存在"两分支，改成调用
   * `resolveAuraEffectValue()`（见该文件头注）——新增了第三种"分阶段"模式
   * （事件触发换挡，复用出兵编排的 WAVE_CONDITIONS），逻辑挪到独立纯函数里
   * 才能脱离完整 MapSystem 单独测试。固定值/渐进到目标值两种改动前就有的
   * 模式解析结果逐位不变。
   */
  _applyGlobalAura(dt) {
    const aura = this.currentMap && this.currentMap.globalAura;
    if (!this._fx) return;
    this._auraT = (this._auraT || 0) + dt;
    const every = aura?.refreshSec ?? 0.5;
    if (this._auraT < every) return;
    this._auraT = 0;
    if (!aura || !aura.effects || !aura.effects.length) return;
    // 分阶段模式用得到的 ctx——地图光环对全部阵营生效，没有"我方/敌方"视角，
    // 也没有接 DragonSystem/WorldState，所以这里只给 gameTime，其余字段留空
    // 交给 whenPasses 的"拿不到就放行"既定口径处理（见 AuraValueResolver.js 头注）。
    const ctx = { gameTime: window.gameTime || 0 };
    for (const e of this.entities.getAll(true)) {
      if (!e || !e.alive) continue;
      for (const it of aura.effects) {
        const { flat, percent } = resolveAuraEffectValue(it, ctx);
        this._fx.apply(e.id, {
          name: aura.name, icon: aura.icon || '🌐', kind: 'stat', statKey: it.statKey,
          flatValue: flat, percentValue: percent,
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh',
          uniquePassive: true,
          description: `${it.label || it.statKey}${flat >= 0 ? '+' : ''}${flat}`,
        }, 'map_global_aura');
      }
    }
  }

  update(dt) {
    if (!this.active) return;
    this._clock += dt;
    this._applyGlobalAura(dt);
    while (this._respawnQueue.length && this._respawnQueue[0].at <= this._clock) {
      const { blueprint: b, corpseId, hpPct = 100, isNexus = true } = this._respawnQueue.shift();
      if (!this.currentMap) continue;
      // 光魂的队列项没有蓝图（一定是原地复活尸体），tier 从尸体本身取。
      const tier = b ? b.tier : (this.entities.get(corpseId)?._mapTier);
      const stats = (this.currentMap.tierStats && this.currentMap.tierStats[tier]) || TIER_STATS[tier] || TIER_STATS.outer;
      // Q5：优先原地复活尸体（技能/塔身在原实体上都还在，满血满盾归位即可）；
      // 尸体意外不在（旧存档等）才回退到重建路径。
      const corpse = corpseId ? this.entities.get(corpseId) : null;
      if (corpse) {
        corpse.alive = true;
        // 血量按队列项的 hpPct（召唤水晶 100%，光魂 外/内 33%、枢纽 40%）。
        // 取这座塔**此刻真正的**最大生命而不是 tierStats 的原始值：它身上可能带着
        // 成长/覆写/龙之奖励，用原始表会把它打回"刚开局的样子"，
        // "重生 33% 生命"就成了别的意思。
        // v47：从 baseStats.maxHP 再进一步到 effectiveMaxHP —— 前者不含 maxHPPct 一类的
        // 百分比加成，持魂方的水晶按 100% 重生时会少那几个百分点（与出生那处同一个取错，
        // 见 factories.js spawnAtFullHP 头注）。
        const maxHP = effectiveMaxHP(corpse) || stats.maxHP;
        corpse.currentHP = Math.max(1, Math.round(maxHP * (hpPct / 100)));
        corpse.shieldFixedCurrent = stats.shieldFixedMax || 0;
        corpse.tempShield = 0;
        delete corpse._respawnAt;
        delete corpse._respawnProgress;
        delete corpse._respawnRemain;
        // 复活后不再是损毁幽灵、损毁档一并清零（用户定稿："塔手动重生时要恢复零损毁的模型"）。
        // 清在这里而不是渲染层：损毁档是**单向**的，渲染层只会往上抬、永远不会自己归零，
        // 所以"什么时候可以清"这件事必须由知道"这是一次复活"的地方来说。
        // v47：改调 clearDamageMarks —— 编辑器的【设为存活】是**第二条**复活路径，
        // 它当年没跟着清 _dmgStage，于是手动复活的塔模型停在重度损毁（用户报的就是这个）。
        clearDamageMarks(corpse);
        this.entities.markDirty?.();
      } else if (b && this.createBuildingFn) {
        const entity = this.createBuildingFn({
          faction: b.faction, tier: b.tier, laneId: b.laneId,
          isNexus: true, pos: b.pos, weapon: b.weapon, stats, skills: b.skills,
        });
        if (entity) this._buildingIds.push(entity.id);
      }
      // 清除摧毁标记：下一波起对方停止追加超级兵（LoL 一致）。
      // 走统一判定而不是直接 delete —— 一路多座时，另一座可能还躺着，
      // 但"有一座活着"就足以让这一路不再算陷落（见 _refreshLaneNexusFlag）。
      // 只有召唤水晶才动"这一路陷落没有"的旗标。光魂复活的是外/内/枢纽塔，
      // 与超级兵红利无关；无条件调用会在 b 为 null 时直接抛。
      if (isNexus && b) this._refreshLaneNexusFlag(b.faction, b.laneId);
      this._clearRespawnEffect(corpseId);
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
      // 分母用**这一项自己的**总时长：光魂与召唤水晶的重生时间是两个独立可调的数，
      // 统一按 NEXUS_RESPAWN_TIME 算的话，光魂那圈进度条会走错速度（甚至满了还不复活）。
      const dur = q.dur || this.NEXUS_RESPAWN_TIME;
      corpse._respawnProgress = Math.max(0, Math.min(1, 1 - remain / dur)); // 填满即重生
    }
    // 重生状态描述每秒同步剩余秒数
    this._descTimer = (this._descTimer || 0) + dt;
    if (this._descTimer >= 1 && this._fx) {
      this._descTimer = 0;
      for (const q of this._respawnQueue) {
        if (!q.corpseId) continue;
        const eff = this._fx.getEffects(q.corpseId).find(x => x.blueprint.name === '重生中');
        if (!eff) continue;
        const left = Math.max(0, Math.ceil(q.at - this._clock));
        eff.blueprint.description = q.isNexus
          ? `召唤水晶重生中：${left}s`
          : `☀️ 光魂重生中：${left}s（${q.hpPct}% 生命）`;
      }
    }
    // 队列排序由 _enqueueRespawn 负责 —— 光魂进来之后"重生时长恒定"不再成立，
    // 原来那句"按入队顺序即时间顺序，无需排序"已经作废，理由写在 _enqueueRespawn 上。
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
  //
  // 圆心的取值口在 src/data/baseCircle.js（TerrainLayer 也用同一个函数）——
  //「基地一定在世界的对角」只是峡谷/深渊的巧合，那里写清了为什么。
  getBaseCircleCenter(faction) {
    return baseCircleCenter(this.currentMap, faction);
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

  /**
   * navgrid（可行走位图）：从 2D 导航图描出的真实峡谷地形（野区可走、野区墙体、河道）。
   * 位图按需解码一次并缓存；只有声明了 useNavgrid 的地图走这条路，其余地图沿用走廊模型。
   */
  _navgrid() {
    if (this._nav !== undefined) return this._nav;
    this._nav = null;
    if (this.currentMap?.useNavgrid) {
      // ⚠️ 这里原来写死了 SR_NAVGRID —— 于是任何声明 useNavgrid 的新地图都会拿到
      // **召唤师峡谷的地形**，而且不会报任何错，只是走位莫名其妙。
      // 现在优先用地图自带的 navgrid，未声明的沿用峡谷那张（对已有地图逐位不变）。
      const NG = this.currentMap.navgrid || SR_NAVGRID;
      const n = NG.n;
      // base64 → 位数组：v51.32 起改调 data/navgrid.js 的 unpackBits（地图编辑器的
      // 笔刷要用同一份编解码逻辑序列化画好的地形，不能各写一份、容易悄悄跑偏）。
      // atob 在浏览器有、Node 18+ 全局也有；都没有就退回走廊模型（不炸），
      // unpackBits 内部处理这个兜底，这里只需要判断返回值。
      const bits = unpackBits(NG.bits, n);
      if (bits) this._nav = { n, bits };
    }
    return this._nav;
  }

  /**
   * v51.32：地图编辑器前置重构（阶段二，见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md
   * §2 原则 6）——navgrid 相关缓存的失效入口：解码后的可行走位图（`_nav`）与
   * 各路回流场（`_fields`，见 `_laneField`）。
   *
   * 正常切图不需要调用这个方法：两处缓存各自靠 `this._nav !== undefined` /
   * `this._fieldsMapId !== map.id` 在切图时自然重算。这个方法是给"同一张图、
   * navgrid 数据在运行时被改了"这一种场景用的——目前唯一会发生这种事的是地图编辑器
   * 的地形笔刷：画一笔就要让"能不能走"和"沿哪条路脱困"两份缓存立刻失效，
   * 否则画完地形，寻路读到的还是画之前的旧位图。
   *
   * 只清 MapSystem 自己这两处逻辑层缓存；渲染层（离屏地形画布、植被/水面/裙边网格）
   * 的缓存走 `ThreeRenderer.invalidateTerrain()`，两处调用点分开是因为
   * MapSystem（系统层）不允许 import 渲染层模块（CLAUDE.md 的系统间禁止互相 import）——
   * 调用方（未来的地图编辑器）需要在改完 navgrid 后把两个方法都调一遍。
   */
  invalidateNav() {
    this._nav = undefined;
    this._fields = {};
  }

  /** 龙坑/男爵坑坑心（navgrid 地图才有）。name = 'dragon' | 'baron' */
  /**
   * 龙坑 / 男爵坑。默认取 SR_PITS（= 每段河道的几何重心，推导过程见那里的注释）。
   * v44：加一层 CONFIG 覆写 —— 硬约束是"一切数值都必须软编码"，
   * 而坑位此前只能改源码。地图自己声明的 pits 优先级最高（以后新图各有各的河）。
   */
  getPit(name) {
    const m = this.currentMap;
    if (!m) return null;
    // 顺序：**用户覆写 → 地图声明 → 没有**。
    // 与本项目其它分层一致（towerTierOverrides 也是用户覆写盖过地图 tierStats）——
    // 用户在编辑器里显式改过的东西，不该被地图数据顶回去。
    const fromMap = (m.pits && m.pits[name]) || null;
    const ovr = CONFIG.gameRules?.dragon?.pits?.[name];
    if (ovr && Number.isFinite(ovr.x) && Number.isFinite(ovr.y)) {
      const base = fromMap || SR_PITS[name] || {};
      return { r: base.r ?? 150, depth: base.depth ?? -26, ...ovr };
    }
    if (fromMap) return fromMap;
    // v44：不再有 `useNavgrid ? SR_PITS : null` 这条兜底 ——
    // 那等于把召唤师峡谷的龙坑发给每一张用 navgrid 的地图（嚎哭深渊、扭曲丛林都中招，
    // 各自的地形上被挖了两个毫无意义的坑）。坑属于地图，没声明就是没有。
    return null;
  }

  /**
   * 河道强度场：0 = 没有河，1 = 河心满深。**河道的唯一真源**——
   * 地形高度(heightAt)、水面遮罩(WaterLayer)、地形底图的河色(TerrainLayer)
   * 三处一律读它，免得三份判据各写一套、改一处漏两处。
   *
   * 用户定稿（Q5）：河道不是贯穿地图对角的一整条，而是被三条路面切断的【两条支流】——
   * 参照 LoL 小地图，上下两段河，路面处恢复原有地形高度。
   * 实现就是"对角河带 ∩ 非路面"：
   *   ① 河带 = 到河轴 x=y 的垂距 < riverHalfWidth（岸边 RIVER_BANK 比例羽化）；
   *   ② 路面 = 到任一兵线折线的距离 ≤ 走廊半宽 + riverLaneClear（外侧再留一段渐变收口）。
   * 河轴与三路的几何关系天然给出两段：上路拐角截掉西北端、下路拐角截掉东南端、
   * 中路在正中把剩下的一刀两断 —— 正是用户圈出的那两段。
   */
  /**
   * 是否落在【三路围出的可玩区域】内。上路与下路首尾都接在两座水晶枢纽上，
   * 于是"上路正向 + 下路反向"天然闭合成一圈，把地图内场围起来。
   * 用它把河道裁在内场里：否则河轴两端会在上路西北拐角外、下路东南拐角外
   * 各留一小段贴着地图边界的水（用户圈的是两段，不是四段）。
   * 缺 top/bot 的地图（嚎哭深渊）直接返回 true，行为不变。
   */
  _insideLaneRing(x, y) {
    const m = this.currentMap;
    if (!m) return true;
    if (this._ringMapId !== m.id) {
      this._ringMapId = m.id;
      const top = (m.lanes || []).find(l => l.id === 'top');
      const bot = (m.lanes || []).find(l => l.id === 'bot');
      this._ring = (top && bot) ? [...top.waypoints, ...bot.waypoints.slice().reverse()] : null;
    }
    const P = this._ring;
    if (!P) return true;
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i].x, yi = P[i].y, xj = P[j].x, yj = P[j].y;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  riverFactor(x, y) {
    const m = this.currentMap;
    if (!m || !m.world || m.walls?.river === false) return 0;
    if (!this._insideLaneRing(x, y)) return 0;
    const cfg = m.heightZones || {};
    const half = cfg.riverHalfWidth ?? 200;
    const d = Math.abs(x - y) * Math.SQRT1_2;          // 到河轴 x=y 的垂距
    if (d >= half) return 0;
    const bank = cfg.riverBank ?? 0.28;                 // 岸边羽化占半宽的比例
    const t = d / half;
    let f = t < 1 - bank ? 1 : (1 - t) / bank;
    if (f <= 0) return 0;
    // 路面切断：路中心一段完全无河，外侧 fade 段线性收口（不留硬边）
    const clear = (m.walls?.corridorHalfWidth ?? 95) + (cfg.riverLaneClear ?? 40);
    const fade = cfg.riverLaneFade ?? 120;
    for (const lane of (m.lanes || [])) {
      const dl = this._nearestOnLane(lane, x, y).dist;
      if (dl <= clear) return 0;
      if (dl < clear + fade) f = Math.min(f, (dl - clear) / fade);
    }
    return Math.max(0, Math.min(1, f));
  }

  /**
   * Q1：兵线回流场（每路一张，navgrid 地图专用，按需构建并缓存）。
   *
   * 为什么需要它：只靠"朝兵线方向直线拉 + 撞墙滑行"这类**局部贪心**永远走不出凹形口袋——
   * 出口在身后时，任何只看前方的转向都会把兵顶在凹壁上磨。实测本图上"朝推进方向 ±60°
   * 全被地形挡住"的口袋格点有 577 个，最近的离兵线只有 73px，分离力把兵挤进去很正常。
   *
   * 做法：以"离该路中心线 ≤ 走廊半宽的可走格"为源点，在 navgrid 上做一次 BFS，
   * 得到每个可走格【沿地形走回该路要几步】。小兵脱困时顺着这个距离场下山即可，
   * 只要口袋与兵线连通就一定出得来，且是全局最优方向，不会被凹角骗。
   * 成本：每路一次 BFS（256×256 ≈ 6.5 万格），切图时才算，之后每帧只是一次数组查表。
   */
  _laneField(laneId) {
    const nav = this._navgrid();
    const m = this.currentMap;
    if (!nav || !m) return null;
    this._fields = this._fields || {};
    if (this._fieldsMapId !== m.id) { this._fields = {}; this._fieldsMapId = m.id; }
    if (this._fields[laneId] !== undefined) return this._fields[laneId];

    const lane = this.getLane(laneId);
    if (!lane) return (this._fields[laneId] = null);
    const n = nav.n, W = m.world;
    const cw = W.w / n, ch = W.h / n;
    // 源点半径要【比走廊半宽窄】：用 130 的走廊半宽当源，会把"离中线 73px 但被野区墙
    // 隔在另一侧的凹角"也标成距离 0 —— 站在那儿的兵一查场就被告知"你已经到家了"，
    // 于是拿不到任何脱困方向（实测中路这类点 30s 只挪 10px）。收到 50 才是真·路面。
    const hw = m.heightZones?.laneFieldSource ?? 50;
    const dist = new Uint16Array(n * n).fill(0xffff);
    const q = new Int32Array(n * n);
    let qh = 0, qt = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (nav.bits[k] !== 1) continue;
        const x = (i + 0.5) * cw, y = (j + 0.5) * ch;
        if (this._nearestOnLane(lane, x, y).dist <= hw) { dist[k] = 0; q[qt++] = k; }
      }
    }
    if (qt === 0) return (this._fields[laneId] = null);
    // 8 邻接 BFS（对角按 1 步算——只用来定"下山方向"，不需要精确欧氏距离）
    while (qh < qt) {
      const k = q[qh++], i = k % n, j = (k / n) | 0, d = dist[k] + 1;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i2 = i + di, j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
          const k2 = j2 * n + i2;
          if (nav.bits[k2] !== 1 || dist[k2] !== 0xffff) continue;
          dist[k2] = d; q[qt++] = k2;
        }
      }
    }
    return (this._fields[laneId] = { dist, n, cw, ch });
  }

  /**
   * 顺着回流场"下山"的单位方向；已在兵线上（或没有场/不可达）返回 null。
   * 返回 { x, y, steps }，steps = 距兵线还有几格，可用来判断偏离有多远。
   */
  laneFlowDir(laneId, x, y) {
    const f = this._laneField(laneId);
    if (!f) return null;
    const { dist, n, cw, ch } = f;
    const i = Math.floor(x / cw), j = Math.floor(y / ch);
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    const here = dist[j * n + i];
    if (here === 0 || here === 0xffff) return null;   // 已在兵线上 / 站在墙里或不连通
    let best = here, bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i2 = i + di, j2 = j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
        const d = dist[j2 * n + i2];
        if (d < best) { best = d; bi = di; bj = dj; }
      }
    }
    if (!bi && !bj) return null;
    const L = Math.hypot(bi, bj);
    return { x: bi / L, y: bj / L, steps: here };
  }

  /** 该点是否在可行走区域内（无墙地图恒 true） */
  isWalkable(x, y) {
    if (!this.hasWalls()) return true;
    // 真实峡谷地形：野区可走，墙体/河道形状来自描出的位图（是本图唯一判据）。
    const nav = this._navgrid();
    if (nav) {
      const W = this.currentMap.world;
      const i = Math.floor(x / W.w * nav.n), j = Math.floor(y / W.h * nav.n);
      if (i < 0 || j < 0 || i >= nav.n || j >= nav.n) return false;
      return nav.bits[j * nav.n + i] === 1;
    }
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
    if (this._riverWalkable && this.riverFactor(x, y) > 0) return true;
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
    const riverDepth = cfg.riverDepth ?? -10;
    const platH = cfg.plateauHeight ?? 20;
    let h = 0;
    // 河床：按河道强度场下沉。强度为 0 的地方（路面、河带之外）高度原样保持 0，
    // 这就是用户要的"路面恢复原有地形高度"——河不再从三路底下横穿过去。
    const rf = this.riverFactor(x, z);
    if (rf > 0) h = Math.min(h, riverDepth * rf);
    // 高地。**两种形状，按地图声明选**：
    //
    // ① map.highground（半平面）—— 用户定稿："从水晶塔前方就开始有高低差
    //    （从水晶塔开始就已经是高地了）"。即高地是【水晶塔那条线往自家方向的一整片】，
    //    不是一个圆。圆那套只对峡谷成立（那里基地确实是个角上的圆台）。
    //    在扭曲丛林/嚎哭深渊上按圆抬，抬出来的就是"水晶周围凭空隆起一个包"——
    //    用户问的"水晶周围为什么会隆起来"就是这个。
    //    声明形式：{ blue:{at,dir}, red:{at,dir}, ramp }
    //      at  = 界线上一点（放水晶塔位置）
    //      dir = 指向【自家】的单位向量（界线的内法向）
    //      ramp= 界线处的坡宽（世界单位），做成斜坡而不是陡坎，兵能走上去
    // ② 未声明 highground 的地图退回原来的圆（峡谷/Quick 逐位不变）。
    const hg = m.highground;
    if (hg) {
      const ramp = hg.ramp ?? 120;
      for (const f of ['blue', 'red']) {
        const z0 = hg[f]; if (!z0) continue;
        // 两种形状：
        //   { at, dir } 半平面 —— 界线往 dir 那一侧是高地
        //   { center, full } 圆   —— 离圆心 < full 满高，full~full+ramp 之间是斜坡
        // 扭曲丛林用圆（用户定稿："效果就是从水晶塔前面就是斜坡，枢纽那里都是高地"）：
        // 圆心放水晶枢纽，full=420 正好把水晶塔（离枢纽 413）圈进满高区，
        // 兵线从外面进来依次经过 499→452→357，天然就是一段爬坡。
        let sIn;
        if (z0.center) sIn = (z0.full ?? 0) + ramp - Math.hypot(x - z0.center.x, z - z0.center.y);
        else sIn = (x - z0.at.x) * z0.dir.x + (z - z0.at.y) * z0.dir.y;
        if (sIn <= 0) continue;
        h = Math.max(h, platH * Math.min(1, sIn / Math.max(1e-6, ramp)));
      }
    } else {
      // Q4——边缘做成【斜坡】而非陡坎：内核 rFull 内满高 platH，
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
    }
    // 龙坑/男爵坑：坑心下沉，边缘一段过渡（坑壁）。
    // v44：闸门从 `m.useNavgrid` 改为 **getPit**（= 地图自己声明的坑）。
    // 原来按 useNavgrid 判断，等于把召唤师峡谷的两个坑挖进了每一张 navgrid 地图 ——
    // 嚎哭深渊是一座平桥、扭曲丛林根本没有河，却都被挖了 SR 的坑。
    // 这里与 getPit 共用同一个取值口径，地形与出生点不会再各说各话。
    {
      for (const key of ['dragon', 'baron']) {
        const pit = this.getPit(key); if (!pit) continue;
        const d = Math.hypot(x - pit.x, z - pit.y);
        if (d < pit.r) {
          const t = Math.min(1, (pit.r - d) / (pit.r * 0.45));   // 边缘→坑心 线性下沉
          h = Math.min(h, pit.depth * t);
        }
      }
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
    // navgrid 地图：碰撞【只认位图】。旧的"投影回三路走廊/基地圆"那套必须彻底让位——
    // 否则站在野区（位图明明可走）的小兵会被硬拽回走廊边缘，表现为沿着早已不存在的
    // 旧路径边缘卡住、挤成一堆（用户实测截图）。
    const nav = this._navgrid();
    if (nav) {
      if (this.isWalkable(pos.x, pos.y)) return false;   // 已在可走区，无需修正
      const W = this.currentMap.world, n = nav.n;
      const sx = W.w / n, sy = W.h / n;
      const ci = Math.floor(pos.x / sx), cj = Math.floor(pos.y / sy);
      // 由内向外一圈圈找最近的可走格（越界点也能被拉回图内）。半径上限足够跨过最厚的野区墙块。
      for (let r = 1; r <= 24; r++) {
        let bestD = Infinity, bx = 0, by = 0;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;   // 只扫这一圈
            const i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= n || j >= n) continue;
            if (nav.bits[j * n + i] !== 1) continue;
            const wx = (i + 0.5) * sx, wy = (j + 0.5) * sy;
            const d = (wx - pos.x) ** 2 + (wy - pos.y) ** 2;
            if (d < bestD) { bestD = d; bx = wx; by = wy; }
          }
        }
        if (bestD < Infinity) {
          const dx = bx - pos.x, dy = by - pos.y, L = Math.hypot(dx, dy) || 1;
          pos.x = bx; pos.y = by;
          return { nx: dx / L, ny: dy / L };   // 法向 = 由墙内指向可走区（调用方据此剔除撞入分量）
        }
      }
      return false;
    }
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
