import { laneSpawnsOf } from './FactionSystem.js';
import { CONFIG } from '../data/Config.js';
import { buildWaveOrder, buildBroadcastOrder } from '../data/waveComposition.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { resolveSkillParams } from '../core/skillParams.js';

/**
 * LaneWaveSystem.js
 * 小兵生成：双方阵营周期性各自生成一波小兵，沿地图 lane 行走。
 *
 * 出兵方式（LoL 真实机制）：一波兵不是同时刷出，而是在水晶枢纽处
 * 排成单列、每隔 spawnGap 秒出一个（近战×3 → 远程×2 → 炮车，超级兵排最前）。
 * 实现：spawnWave 只把出兵计划压入 _spawnQueue（带绝对时间戳），
 * update 每帧按时间弹出到期条目、逐个生成。
 *
 * 水晶摧毁后规则（LoL 真实机制，版本B）：某一路的分路水晶被摧毁后，
 * 【拆掉水晶的一方】在该路额外追加超级兵，原本兵种继续正常生成，不受影响
 * （之前写反成"谁被拆谁刷超级兵"，在无头仿真中暴露，已修正）。
 */
export class LaneWaveSystem {
  constructor(entityContainer, eventBus, mapSystem) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.mapSystem = mapSystem;
    this.createMinion = null;
    this.waveInterval = 30;
    // v33（Q22）：对战模式首波小兵 10s → 30s
    //（这一句原本在同一个构造函数里写了【两遍】，后者静默盖掉前者，删掉重复的那句。）
    this.nextWaveTime = 30;
    // 首波延迟另存一份：编辑器的出兵预览要按"第 N 波 ≈ 开局多少秒"推算时间条件，
    // 而 nextWaveTime 是每帧递减的倒计时，读它算出来的是个随机数。
    this.firstWaveDelay = 30;
    this.waveNumber = 0;
    this.paused = false;
    this.spawnGap = (CONFIG.tuning?.spawnGap) ?? 0.35;   // 单列出兵间隔（秒），LoL 同波小兵间隔约 0.3s
    this.waveColumns = 1;            // v42: columns per wave (1=single file)
    this.columnSpacing = 30;         // v42: spacing between columns (px)
    this._spawnQueue = [];  // { at, type, faction, laneId, direction } —— at 为该系统内部时钟的绝对时间
    this._clock = 0;        // 内部时钟
    // v51.33：出兵编排"广播"（design §5.1）——执行广播规则需要 effectRegistry/
    // attrCalc/combat（onBroadcast 的动作原语要用它们），判定广播的 when 条件需要
    // dragonSystem/worldState（§5.2 的龙魂/天气/昼夜条件来源）。这几样都不是本系统
    // 原本的职责，构造函数不强制要求——不注入时按"这类条件全部放行/广播直接跳过"
    // 降级，与 census/gameTime 拿不到时的既有口径一致（宁可多算，不要因为缺一个
    // 依赖就整个系统起不来）。
    this._effectRegistry = null;
    this._attrCalc = null;
    this._combat = null;
    this._dragonSystem = null;
    this._worldState = null;
  }

  setCreateMinion(fn) { this.createMinion = fn; }

  /** 见构造函数头注。main.js 在四个依赖都构造完之后调一次。 */
  setBroadcastDeps({ effectRegistry, attrCalc, combat, dragonSystem, worldState } = {}) {
    if (effectRegistry) this._effectRegistry = effectRegistry;
    if (attrCalc) this._attrCalc = attrCalc;
    if (combat) this._combat = combat;
    if (dragonSystem) this._dragonSystem = dragonSystem;
    if (worldState) this._worldState = worldState;
  }

  update(dt) {
    // 首帧应用**地图自带的波次设置**（地图载入之后才读得到）。
    // 变量名历史上叫 _quickApplied，是因为当初只有 Quick Mode 用这条路；
    // Quick Mode 已删，但这条路是通用的（任何地图都能写 waveInterval 等），所以保留并改名。
    if (this._mapWaveApplied === undefined) {
      const m = this.mapSystem.currentMap;
      if (m) {
        this._mapWaveApplied = true;
        if (m.waveInterval) this.waveInterval = m.waveInterval;
        if (m.firstWaveDelay) { this.nextWaveTime = m.firstWaveDelay; this.firstWaveDelay = m.firstWaveDelay; }
        if (m.spawnGap) this.spawnGap = m.spawnGap;
        if (m.waveColumns) this.waveColumns = m.waveColumns;
        if (m.columnSpacing) this.columnSpacing = m.columnSpacing;
      }
    }
    
    if (this.paused) return;
    this._clock += dt;

    this.nextWaveTime -= dt;
    if (this.nextWaveTime <= 0) {
      this.spawnWave();
      this.nextWaveTime = this.waveInterval;
    }

    // 弹出所有到期的出兵条目（队列按 at 升序压入，从头部顺序检查即可）
    while (this._spawnQueue.length && this._spawnQueue[0].at <= this._clock) {
      const s = this._spawnQueue.shift();
      this._spawn(s);
    }
  }

  spawnWave() {
    this.waveNumber++;
    window.waveNumber = this.waveNumber; // v35：对战波次同步到全局（炮兵指挥官等波次门槛读它）
    // 建筑普查每波只做一次，六个 (阵营×路) 的条件判定共用同一份快照 ——
    // 每条规则各查一次会把一次遍历放大成几十次，而且同一波里前后两条规则
    // 可能看到不同的世界状态（塔正好在这中间被拆掉），判定就不自洽了。
    this._census = this.mapSystem.structureCensus ? this.mapSystem.structureCensus() : null;
    // 多阵营地基（docs/REPORT-2026-09-03-multifaction.md §3/§4）：不再对每条 lane
    // 硬编码调用 BLUE forward / RED reverse 各一次，改成遍历该 lane 自己声明的
    // 出兵流（laneSpawnsOf 未声明时兜底为原来这两条，两阵营地图行为逐位不变）。
    for (const lane of this.mapSystem.currentMap?.lanes || []) {
      for (const spawn of laneSpawnsOf(lane)) {
        this._enqueueSpawn(spawn, lane);
      }
    }
  }

  /**
   * @param {{faction:string, direction:'forward'|'reverse', targetFactions:string[]}} spawn
   *   一条出兵流：某阵营从这条路的某方向出发，打向声明的目标阵营列表。
   * @param {*} lane
   */
  _enqueueSpawn(spawn, lane) {
    if (!this.createMinion) return;
    const { faction, direction, targetFactions } = spawn;

    // ==================== 阵营淘汰 → 停止出兵（用户定稿，见设计报告 §4） ====================
    // 出兵方自己的主水晶枢纽已被摧毁 → 这条出兵流直接不出兵（"该方停止出兵"）。
    if (this.mapSystem.isFactionEliminated?.(faction)) return;
    // 目标阵营里还有没被淘汰的，才继续打——全部目标都被淘汰才停这条路
    // （"攻击该方的路径不再生成小兵"；汇合路径打多个目标时，其余目标还活着就
    // 该继续照常出兵，只是不再对已经淘汰的那个目标触发超级兵，见下面 nexusDown）。
    const liveTargets = (targetFactions || []).filter(f => !this.mapSystem.isFactionEliminated?.(f));
    if ((targetFactions || []).length && !liveTargets.length) return;

    // 按"这一路"查询【存活目标里】的水晶摧毁状态（每路独立）——多个目标时，
    // 任意一个存活目标的本路水晶陷落就触发超级兵（与改动前单目标时逐位一致：
    // liveTargets 只有一个元素时，这段就是原来的 nexusDown 计算本身）。
    // Q2（用户要求的新规则）：召唤水晶重生【前 30 秒】就停止生成超级兵。
    // 语义：水晶快复活了 → 敌方的超级兵红利提前结束，防守方有喘息窗口去重整防线。
    let nexusDown = false;
    for (const enemy of liveTargets) {
      let down = this.mapSystem.isNexusDestroyed(enemy, lane.id);
      if (down) {
        // v33（Q10 定稿）：水晶重生【前 45 秒】停发超级兵（30→45），恢复普通兵线
        const remain = this.mapSystem.getNexusRespawnRemain(enemy, lane.id);
        const cutoff = CONFIG.tuning?.superMinionCutoffBeforeRespawn ?? 45;
        if (remain !== null && remain <= cutoff) down = false;
      }
      if (down) { nexusDown = true; break; }
    }

    // 出兵顺序（对齐 LoL）：
    // 普通波：近战×3 → 远程×3
    // 炮车波（每3波）：近战×3 → 炮车×1 → 远程×3（炮车紧跟近战，不在队尾）
    // 超级兵波（该路水晶被摧毁）：超级兵×1 最前 → 近战×3 → 远程×3，且【不生成炮车】
    // v33（Q4）：接入模板编辑器"生成规则"——
    //   ① spawnEnabled 兵种总开关（关掉的兵种两种模式都不再生成）
    //   ② 图腾兵进入对战出兵：第 battleTotemFromWave（默认10）波起，
    //      每 battleTotemInterval（默认3）波在队尾（远程之后）生成 1 个。
    //   术士/蚀骨暂不进对战（用户定稿"目前只加图腾兵"）。
    // 出兵编排【全部软编码】：读 CONFIG.gameRules.laneWaveComposition（数组顺序即出兵顺序）。
    // 默认值逐条等价于更早的硬编码（近战×3 / 每3波炮兵 / 远程×3 / 第10波起每3波图腾 /
    // 第5波起每15波攻城车 / 水晶陷落出超级兵），故不改参数时对战节奏完全不变。
    // 展开逻辑抽到 data/waveComposition.js，与模板编辑器「出兵顺序」面板的实时预览共用同一份，
    // 免得预览和真实出兵两套实现漂移。
    // 传 faction：该阵营若配了独立编排（CONFIG.factionOverrides[阵营].laneWaveComposition）
    // 就整体用它，否则用共享基准 —— 用户定稿"出兵编排要能只对某一方生效"。
    // 条件判定的世界快照：出兵编排里"敌方内塔全灭""游戏满 10 分钟"这类条件读它。
    // gameTime 用**对局时钟**（这一局跑了多久），不是 window.gameTime 那个会被
    // 暂停/倍速影响的挂钟 —— 编排是玩法规则，必须跟着游戏时间走。
    // v45：地图可以关掉某些兵种（经典模式只出 近战/远程/炮兵/超级兵）。
    // 走 spawnEnabled 这个既有闸门而不是让地图重写一份编排 ——
    // 编排是用户在编辑器里会调的东西，地图重写一份等于把他的调整覆盖掉。
    // 没有覆写时 rules 就是 CONFIG.gameRules 本身，行为逐位不变。
    //
    // 第四节 Part B："出兵编排要能和地图独立选择"——同样走"只覆写这一层，
    // 不重写整份规则"的路子：map.laneWaveCompositionByLane 是"这条路的完整
    // 出兵队列"，合并进 rules 之后交给 compositionFor()（data/waveComposition.js）
    // 判定——那边本来就认 rules.laneWaveCompositionByLane[laneId] 这一层
    // （阵营独立编排 CONFIG.factionOverrides 之下、共享基准 gameRules.laneWaveComposition
    // 之上，见 compositionFor 头注的四级解析顺序），这里只是把"这一层从哪来"
    // 从"全局唯一"改成"地图可以覆写"，判定逻辑一处都没改。没声明的地图/路，
    // 一路落回共享基准，行为与改动前逐位一致。
    const _mapSE = this.mapSystem.currentMap?.spawnEnabled;
    const _mapLWC = this.mapSystem.currentMap?.laneWaveCompositionByLane;
    const rules = (_mapSE || _mapLWC)
      ? {
          ...CONFIG.gameRules,
          spawnEnabled: { ...(CONFIG.gameRules.spawnEnabled || {}), ...(_mapSE || {}) },
          laneWaveCompositionByLane: { ...(CONFIG.gameRules.laneWaveCompositionByLane || {}), ...(_mapLWC || {}) },
        }
      : CONFIG.gameRules;
    // enemy：多阵营下"敌方"不再是唯一解（一条路可以同时打多个目标阵营），
    // 这里取存活目标里的第一个当"敌方xxx"这类编排条件的判定对象——两阵营地图
    // liveTargets 恰好只有一个元素，取法与改动前逐位一致。真正的 N 阵营
    // 汇合语义（"敌方"该指哪一个）留给以后按需再设计，见设计报告 §9。
    const wctx = {
      laneId: lane.id, gameTime: this._clock, census: this._census, enemy: liveTargets[0] ?? null,
      ...this._extraWaveCtx(),
    };
    const order = buildWaveOrder(this.waveNumber, nexusDown, rules, faction, wctx);

    // v51.33：出兵编排"广播"——与刷兵共用同一份 wctx/rules，"这一波该生效哪些
    // 规则"只判定一次（buildBroadcastOrder 内部走的是同一套 compositionFor/
    // whenPasses，不是另一套判定），不会出现"预览一套、真实执行一套"。
    for (const b of buildBroadcastOrder(this.waveNumber, nexusDown, rules, faction, wctx)) {
      this._broadcast(faction, lane.id, b.skillId, b.scope);
    }

    for (let i = 0; i < order.length; i++) {
      this._spawnQueue.push({
        at: this._clock + i * this.spawnGap,
        type: order[i], faction, laneId: lane.id, direction,
        colIdx: i % this.waveColumns,
      });
    }
    // 保证队列整体按时间有序（双方三路同时入队，交错时间戳）
    this._spawnQueue.sort((a, b) => a.at - b.at);
  }

  /**
   * v51.33：出兵条件的世界快照里补上龙魂/天气/昼夜/得分（design §5.2）。
   * 每一项都在对应依赖没注入时降级成"缺失"（undefined），交给
   * WAVE_CONDITIONS 里各自的 test() 按"拿不到就放行"的既有口径处理——
   * 与 census/gameTime 缺失时的处理原则完全一致，不单独发明一套新规矩。
   */
  _extraWaveCtx() {
    const ds = this._dragonSystem;
    const ws = this._worldState;
    return {
      dragonState: ds ? { soulOwner: ds.soulOwner, factionKills: ds.factionKills, killCounts: ds.killCounts } : null,
      weather: ws?.weather?.getDominant?.() ?? null, // { id, name, icon, ... }（BASE_WEATHERS/EXTREME_WEATHERS 条目原样）
      dayPhase: ws ? { phase: ws.daynight?.phase ?? null, isNight: !!ws.daynight?.isNight } : null,
      score: (typeof window !== 'undefined' && window.CTX?.__score) || null,
    };
  }

  /**
   * v51.33：执行一条广播规则——按 scope 枚举范围内的单位，逐个调用其
   * onBroadcast(unitId, instance, ctx)。与 DragonSystem._grantAll 同款
   * "按阵营/路过滤 entityContainer.getAll" 逻辑（design §5.1），这里独立写一份
   * 而不是直接调用 DragonSystem 的私有方法——那是另一个系统内部的实现细节，
   * 跨系统伸手进去拿私有方法比重复三行过滤逻辑更容易在将来悄悄踩坑。
   *
   * 广播技能不要求单位【预先装备】它——每次广播现造一个一次性 instance
   * 传给 onBroadcast，语义是"对这批单位施放一次"，不是"这批单位长期带着这个
   * 被动"（装备/卸下、常驻面板展示都不适用于广播技能）。behaviorVM 生成的
   * applyEffect 动作用 `vm_${skillId}` 作为固定 sourceId（不依赖 instance.id），
   * 所以一次性 instance 与常驻 instance 在 stackPolicy 上表现完全一致，见
   * behaviorVM.js ACTIONS.applyEffect 的实现。
   */
  _broadcast(faction, laneId, skillId, scope) {
    const def = SkillLibrary[skillId];
    if (!def || !def.onBroadcast) return;
    const ctx = {
      entityContainer: this.entities, effectRegistry: this._effectRegistry,
      eventBus: this.eventBus, waveNumber: this.waveNumber,
      attrCalc: this._attrCalc, combat: this._combat,
    };
    for (const e of this.entities.getAll(true)) {
      if ((e._mapFaction || e.faction) !== faction) continue;
      if (scope === 'lane' && e._laneId !== laneId) continue;
      const inst = { id: `broadcast_${skillId}`, skillId, state: {} };
      resolveSkillParams(inst, e, SkillLibrary);
      try { def.onBroadcast(e.id, inst, ctx); }
      catch (err) { console.error(`[LaneWaveSystem] 出兵编排广播技能「${skillId}」执行出错：`, err); }
    }
  }

  /**
   * v40（出兵点分离）：每路一个独立出兵点。
   * 旧实现三路共用 waypoints[0]（= 水晶枢纽坐标本身），蓝方 21 个单位（3路×7）全部在
   * 同一点上生成、只有 ±4px 抖动 → 出生瞬间挤成一团，靠碰撞互推慢慢解开 = 用户看到的
   * "刚出生队形就乱套"。
   * 现在沿【本路方向】从枢纽外推 SPAWN_OFFSET，三路天然呈扇形散开且互不重叠；
   * 距离取 100px 是为了满足用户要求"一定要在枢纽塔身后"——
   * 实测径向：枢纽水晶 446 → 出兵点 515/545/512 < 枢纽塔 559，仍在塔身后。
   * 红蓝共用同一算法（红方取末端路点与倒数第二个路点的方向），天然对称。
   */
  _laneSpawnPoint(lane, direction) {
    const wps = lane.waypoints;
    const SPAWN_OFFSET = 100;
    const isFwd = direction === 'forward';
    const p0 = isFwd ? wps[0] : wps[wps.length - 1];
    const p1 = isFwd ? wps[1] : wps[wps.length - 2];
    if (!p1) return { x: p0.x, y: p0.y };
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: p0.x + (dx / L) * SPAWN_OFFSET, y: p0.y + (dy / L) * SPAWN_OFFSET };
  }

  _spawn({ type, faction, laneId, direction, colIdx }) {
    // Q5：小兵波次生成可按阵营单独关闭（设置面板）。在【实际生成】处门控而不是在
    // spawnWave 处——否则一关就把双方都停了，做不到"只停蓝方"。
    if (window.__towerRuleFor && !window.__towerRuleFor('waveOn', faction)) return;
    const lane = this.mapSystem.getLane(laneId);
    if (!lane) return;
    const startPoint = this._laneSpawnPoint(lane, direction);
    // v42: column-based spawning, offset perpendicular to lane direction
    const numCols = this.waveColumns || 1;
    const col = colIdx || 0;
    const colSp = this.columnSpacing || 30;
    const wps = lane.waypoints;
    const p0 = direction === 'forward' ? wps[0] : wps[wps.length - 1];
    const p1 = direction === 'forward' ? wps[1] : wps[wps.length - 2];
    const dx = p1 ? (p1.x - p0.x) : 0, dy = p1 ? (p1.y - p0.y) : 0;
    const L = Math.hypot(dx, dy) || 1;
    const px = -dy / L, py = dx / L; // perpendicular unit vector
    const offset = (col - (numCols - 1) / 2) * colSp;
    const jx = (Math.random() - 0.5) * 6;
    const jy = (Math.random() - 0.5) * 6;
    const x = startPoint.x + px * offset + jx;
    const y = startPoint.y + py * offset + jy;
    this.createMinion(type, x, y, faction, laneId, direction);
  }
}
