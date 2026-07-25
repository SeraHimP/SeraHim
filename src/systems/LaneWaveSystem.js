import { FACTIONS } from './FactionSystem.js';
import { CONFIG } from '../data/Config.js';

/**
 * LaneWaveSystem.js
 * 对战模式专用小兵生成：双方阵营周期性各自生成一波小兵，沿地图 lane 行走。
 * 与沙盒模式的 WaveSystem 完全独立、互不影响。
 *
 * 出兵方式（LoL 真实机制）：一波兵不是同时刷出，而是在水晶枢纽处
 * 排成单列、每隔 spawnGap 秒出一个（近战×3 → 远程×2 → 炮车，超级兵排最前）。
 * 实现：spawnWave 只把出兵计划压入 _spawnQueue（带绝对时间戳），
 * update 每帧按时间弹出到期条目、逐个生成。切回沙盒模式时队列清空。
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
    this.nextWaveTime = 30; // v33（Q22）：对战模式首波小兵 10s → 30s
    // Quick mode override (applied after map loads)
    this.nextWaveTime = 30; // v33（Q22）：对战模式首波小兵 10s → 30s
    this.waveNumber = 0;
    this.paused = false;
    this.spawnGap = (CONFIG.tuning?.spawnGap) ?? 0.35;   // 单列出兵间隔（秒），LoL 同波小兵间隔约 0.3s
    this.waveColumns = 1;            // v42: columns per wave (1=single file)
    this.columnSpacing = 30;         // v42: spacing between columns (px)
    this._spawnQueue = [];  // { at, type, faction, laneId, direction } —— at 为该系统内部时钟的绝对时间
    this._clock = 0;        // 内部时钟：只在对战模式激活时推进
  }

  setCreateMinion(fn) { this.createMinion = fn; }

  update(dt) {
    // Apply quickMode settings on first update (after map is loaded)
    if (this._quickApplied === undefined) {
      const m = this.mapSystem.currentMap;
      if (m) {
        this._quickApplied = true;
        if (m.waveInterval) this.waveInterval = m.waveInterval;
        if (m.firstWaveDelay) this.nextWaveTime = m.firstWaveDelay;
        if (m.spawnGap) this.spawnGap = m.spawnGap;
        if (m.waveColumns) this.waveColumns = m.waveColumns;
        if (m.columnSpacing) this.columnSpacing = m.columnSpacing;
      }
    }
    
    if (!this.mapSystem.active || this.paused) {
      // 离开对战模式：丢弃未出完的兵，避免切回沙盒后队列残兵在错误的时机涌出
      if (!this.mapSystem.active && this._spawnQueue.length) this._spawnQueue.length = 0;
      return;
    }
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
    for (const lane of this.mapSystem.currentMap?.lanes || []) {
      this._enqueueForFaction(FACTIONS.BLUE, lane, 'forward');
      this._enqueueForFaction(FACTIONS.RED, lane, 'reverse');
    }
  }

  _enqueueForFaction(faction, lane, direction) {
    if (!this.createMinion) return;
    // 按"这一路"查询【敌方】水晶摧毁状态（每路独立）。
    const enemy = faction === FACTIONS.BLUE ? FACTIONS.RED : FACTIONS.BLUE;
    // Q2（用户要求的新规则）：召唤水晶重生【前 30 秒】就停止生成超级兵。
    // 语义：水晶快复活了 → 敌方的超级兵红利提前结束，防守方有喘息窗口去重整防线。
    let nexusDown = this.mapSystem.isNexusDestroyed(enemy, lane.id);
    if (nexusDown) {
      // v33（Q10 定稿）：水晶重生【前 45 秒】停发超级兵（30→45），恢复普通兵线
      const remain = this.mapSystem.getNexusRespawnRemain(enemy, lane.id);
      const cutoff = CONFIG.tuning?.superMinionCutoffBeforeRespawn ?? 45;
      if (remain !== null && remain <= cutoff) nexusDown = false;
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
    const EN = CONFIG.gameRules.spawnEnabled || {};
    const on = (t) => EN[t] !== false;
    // 出兵编排【全部软编码】：读 CONFIG.gameRules.laneWaveComposition（数组顺序即出兵顺序）。
    // 默认值逐条等价于此前的硬编码（近战×3 / 每3波炮兵 / 远程×3 / 第10波起每3波图腾 /
    // 第5波起每15波攻城车 / 水晶陷落出超级兵），故不改参数时对战节奏完全不变。
    const order = [];
    for (const rule of (CONFIG.gameRules.laneWaveComposition || [])) {
      if (!rule || !rule.type || !on(rule.type)) continue;
      if (rule.when === 'nexusDown' && !nexusDown) continue;
      if (rule.when === '!nexusDown' && nexusDown) continue;
      const from = rule.fromWave ?? 0, every = Math.max(1, rule.everyN ?? 1);
      if (this.waveNumber < from) continue;
      if ((this.waveNumber - from) % every !== 0) continue;
      const n = Math.max(0, Math.floor(rule.count ?? 1));
      for (let k = 0; k < n; k++) order.push(rule.type);
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
