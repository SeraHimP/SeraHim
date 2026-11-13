/**
 * NavPlanner.js —— 小兵寻路：网格 + 建筑障碍 + 兵线距离场 + A* 追击路径。
 *
 * 用户（2026-09-28）："这三个地方特别容易卡住小兵。还是我们目前的寻路机制太落后了"；
 *                    "由于更改了塔的模型，现在经常出现兵在塔附近打转"。
 *
 * 原来的机制只有两样：行军 = 沿路点折线直走（pure-pursuit），追击 = 直线冲向目标；
 * 挡在前面的东西全靠局部转向（分离力 + 贴边绕行）去"蹭"过去。这在两种地形下必然失败：
 *   ① 建筑压在路点折线上：下路从枢纽直连外塔，中间正好穿过己方的枢纽水晶和基地塔；中路是一条
 *      对角直线，直穿内塔。局部绕行只能看到眼前那座建筑，两座挨着的建筑（间隙比小兵还窄）
 *      等于一堵墙，兵就在墙前左右换边打转。上一轮把建筑碰撞按模型外轮廓放大后，这种情况多了一倍多
 *     （仿真实测 8 分钟卡住事件 60 → 148）。
 *   ② 野区的 C 形凹口：追击时直线冲向目标，目标在凹口另一侧就一头扎进口袋，出口在身后，
 *      局部转向永远转不出来。
 *
 * 现在：
 *   · 网格：可走地形（navgrid 位图 / 走廊模型按格采样）+ 全部建筑（活的和废墟，按碰撞半径 +
 *     小兵半径膨胀）标成障碍。建筑集合变了（被清除/新增）才重建。
 *   · 行军：每条兵线 × 每个方向一张到敌方终点的距离场（Dijkstra，8 邻接）。离兵线中心越远
 *     单格代价越高（软走廊）——所以兵仍然沿着自己的路走，只在被挡时才从旁边绕，从野区也能找回来。
 *     只有"正前方一小段被挡住"时才改用场的下坡方向，路面开阔时行为与原来逐位相同。
 *   · 追击：与目标之间有直线视线 → 照旧直线冲；被墙/建筑挡住 → A* 找一条路，沿路上
 *     "还看得见的最远一个点"走（拉直），目标挪远了再重算。找不到路、或绕路长得离谱
 *    （超过直线距离 × detourMaxRatio）→ 放弃这个目标一段时间，回去推线。
 * 参数全部在 CONFIG.tuning.nav（编辑器"世界"页可改）。
 */
import { CONFIG, MINION_SIZES } from '../data/Config.js';
import { structureRadius } from '../data/structureRadius.js';

const SQ2 = Math.SQRT2;
const cfg = () => CONFIG.tuning?.nav || {};

/** 最小堆（按 f 排序的整数 key），Dijkstra / A* 共用 */
class Heap {
  constructor(cap) { this.k = new Int32Array(cap); this.f = new Float64Array(cap); this.n = 0; }
  push(key, f) {
    if (this.n >= this.k.length) {   // 同一格可能被多次压入（懒删除），容量不够就翻倍
      const k2 = new Int32Array(this.k.length * 2), f2 = new Float64Array(this.f.length * 2);
      k2.set(this.k); f2.set(this.f); this.k = k2; this.f = f2;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= f) break;
      this.k[i] = this.k[p]; this.f[i] = this.f[p]; i = p;
    }
    this.k[i] = key; this.f[i] = f;
  }
  pop() {
    const top = this.k[0];
    const lk = this.k[--this.n], lf = this.f[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.f[c + 1] < this.f[c]) c++;
      if (this.f[c] >= lf) break;
      this.k[i] = this.k[c]; this.f[i] = this.f[c]; i = c;
    }
    this.k[i] = lk; this.f[i] = lf;
    return top;
  }
  topF() { return this.f[0]; }
}

export class NavPlanner {
  constructor(mapSystem, entities) {
    this.map = mapSystem;
    this.entities = entities;
    this._mapKey = null;
    this._structKey = null;
    this._cfgKey = null;
    this.grid = null;        // { n, cw, ch, free: Uint8Array(1=可走) }
    this._fields = new Map();
    this._laneMul = new Map();
  }

  /** 每帧开头调一次（便宜：只比较地图 id、建筑集合、配置签名） */
  sync() {
    const m = this.map?.currentMap;
    if (!m?.world) { this.grid = null; this._mapKey = null; return; }
    const C = cfg();
    const cfgKey = `${C.unitPad ?? 10}|${C.laneHalf ?? 60}|${C.corridorPenalty ?? 3}|${C.goalRadius ?? 160}|${this.map.hasWalls?.() ? 1 : 0}`;
    const structs = this._structures();
    const sKey = structs.map((s) => `${s.id}:${s.x | 0},${s.y | 0},${s.r | 0}`).join(';');
    const mapKey = `${m.id}|${this.map.active ? 1 : 0}`;
    if (mapKey !== this._mapKey || cfgKey !== this._cfgKey) {
      this._mapKey = mapKey; this._cfgKey = cfgKey; this._structKey = null;
      this._buildTerrain(m);
    }
    if (sKey !== this._structKey) {
      this._structKey = sKey;
      this._stampStructures(structs);
      this._fields.clear();
    }
  }

  /** 建筑（活的 + 废墟）：它们都是走不过去的实体 */
  _structures() {
    const out = [];
    for (const e of this.entities.getAll(false)) {
      if (e.type !== 'tower' || !e.pos) continue;
      if (!e.alive && !e._ruin) continue;
      out.push({ id: e.id, x: e.pos.x, y: e.pos.y, r: structureRadius(e._mapTier, e._modelSize) });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  _buildTerrain(m) {
    const W = m.world;
    const nav = this.map._navgrid?.();
    const n = nav ? nav.n : Math.max(32, Math.min(cfg().maxGrid ?? 320, Math.ceil(Math.max(W.w, W.h) / (cfg().cellSize ?? 14))));
    const cw = W.w / n, ch = W.h / n;
    const terrain = new Uint8Array(n * n);
    const walls = !!this.map.hasWalls?.();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      terrain[k] = nav ? (nav.bits[k] === 1 ? 1 : 0)
        : (!walls || this.map.isWalkable((i + 0.5) * cw, (j + 0.5) * ch)) ? 1 : 0;
    }
    this.grid = { n, cw, ch, terrain, free: terrain.slice(), owner: new Int32Array(n * n) };
    this._laneMul = new Map();
  }

  _stampStructures(structs) {
    const g = this.grid;
    if (!g) return;
    g.free.set(g.terrain);
    g.owner.fill(0);
    const pad = cfg().unitPad ?? 10;
    for (const s of structs) {
      const R = s.r + pad;
      const i0 = Math.max(0, Math.floor((s.x - R) / g.cw)), i1 = Math.min(g.n - 1, Math.floor((s.x + R) / g.cw));
      const j0 = Math.max(0, Math.floor((s.y - R) / g.ch)), j1 = Math.min(g.n - 1, Math.floor((s.y + R) / g.ch));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * g.cw, y = (j + 0.5) * g.ch;
        if ((x - s.x) ** 2 + (y - s.y) ** 2 <= R * R) { g.free[j * g.n + i] = 0; g.owner[j * g.n + i] = s.id; }
      }
    }
  }

  /** 该点所在格是否可走（站在建筑障碍圈里 / 墙里为 false） */
  isFree(x, y) { const k = this.cellOf(x, y); return k >= 0 && !!this.grid.free[k]; }

  cellOf(x, y) {
    const g = this.grid;
    const i = Math.floor(x / g.cw), j = Math.floor(y / g.ch);
    if (i < 0 || j < 0 || i >= g.n || j >= g.n) return -1;
    return j * g.n + i;
  }

  /** 离 (x,y) 最近的可走格（站在膨胀圈边上的兵，自己那格可能被标成障碍） */
  _nearestFree(x, y, maxR = 4) {
    const g = this.grid;
    const k = this.cellOf(x, y);
    if (k >= 0 && g.free[k]) return k;
    const ci = Math.floor(x / g.cw), cj = Math.floor(y / g.ch);
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= maxR && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= g.n || j >= g.n || !g.free[j * g.n + i]) continue;
        const d = di * di + dj * dj;
        if (d < bestD) { bestD = d; best = j * g.n + i; }
      }
    }
    return best;
  }

  /**
   * 线段 (a→b) 是否畅通（不穿墙、不穿建筑）。ignoreId：终点那座建筑本身不算挡（追的就是它）。
   * 按半格步长采样，成本 O(长度/半格)。
   */
  clear(ax, ay, bx, by, ignoreId = 0) {
    const g = this.grid;
    if (!g) return true;
    const dist = Math.hypot(bx - ax, by - ay);
    const step = Math.min(g.cw, g.ch) * 0.5;
    const steps = Math.ceil(dist / step);
    const pad = (cfg().unitPad ?? 10) + Math.min(g.cw, g.ch);
    // 起点就在某座建筑的障碍圈里（刚从水晶枢纽出生、被挤进去）→ 往外走不算被这座建筑挡
    const k0 = this.cellOf(ax, ay);
    const startOwner = k0 >= 0 ? g.owner[k0] : 0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const k = this.cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (k < 0) return false;
      if (g.free[k]) continue;
      if (ignoreId && g.owner[k] === ignoreId) continue;
      if (startOwner && g.owner[k] === startOwner) continue;
      // 起点附近那一两格可能落在建筑的膨胀圈里（贴着建筑站），那不算挡；再往前还是圈里才算
      if (t * dist <= pad && g.terrain[k] && g.owner[k]) continue;
      return false;
    }
    return true;
  }

  // ==================== 兵线距离场 ====================

  _field(lane, forward) {
    const key = `${lane.id}|${forward ? 1 : 0}`;
    if (this._fields.has(key)) return this._fields.get(key);
    const g = this.grid;
    const wps = lane.waypoints;
    if (!g || !wps || wps.length < 2 || lane.loop) { this._fields.set(key, null); return null; }
    const C = cfg();
    const half = C.laneHalf ?? 60, pen = C.corridorPenalty ?? 3;
    const n = g.n, N = n * n;
    // 每格到兵线中心的距离 → 单格代价倍率（软走廊）。只跟地形和兵线有关，按地图缓存：
    // 这一步占一张场耗时的八成，建筑变动时重建场不必再算一遍
    let mul = this._laneMul.get(lane.id);
    if (!mul) {
      mul = new Float32Array(N);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (!g.terrain[k]) continue;
        const d = this.map._nearestOnLane(lane, (i + 0.5) * g.cw, (j + 0.5) * g.ch).dist;
        mul[k] = 1 + pen * Math.min(3, Math.max(0, (d - half) / half));
      }
      this._laneMul.set(lane.id, mul);
    }
    const end = forward ? wps[wps.length - 1] : wps[0];
    const dist = new Float64Array(N).fill(Infinity);   // 必须与堆里的 f 同精度：Float32 会把 nd 舍入，两格互相"改进"无限循环
    const heap = new Heap(N);
    // 终点多半是敌方水晶枢纽（障碍），以它周围一圈可走格为源
    const seedR = (C.goalRadius ?? 160);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!g.free[k]) continue;
      const x = (i + 0.5) * g.cw, y = (j + 0.5) * g.ch;
      const d = Math.hypot(x - end.x, y - end.y);
      if (d <= seedR) { dist[k] = d / g.cw; heap.push(k, dist[k]); }
    }
    while (heap.n) {
      const f = heap.topF(), k = heap.pop();
      if (f > dist[k]) continue;
      const i = k % n, j = (k / n) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i2 = i + di, j2 = j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
        const k2 = j2 * n + i2;
        if (!g.free[k2]) continue;
        // 斜走不许切墙角（两个正交邻格都得可走）
        if (di && dj && (!g.free[j * n + i2] || !g.free[j2 * n + i])) continue;
        const nd = f + (di && dj ? SQ2 : 1) * (mul[k] + mul[k2]) * 0.5;
        if (nd < dist[k2]) { dist[k2] = nd; heap.push(k2, nd); }
      }
    }
    const fld = { dist };
    this._fields.set(key, fld);
    return fld;
  }

  /**
   * 沿兵线距离场往敌方终点走的方向（单位向量）；没有场/不连通返回 null。
   * 取 3×3 邻域里代价最低的方向，并与次优方向按代价差做加权，避免 8 方向的锯齿。
   */
  laneDir(laneId, forward, x, y) {
    const g = this.grid;
    if (!g) return null;
    const lane = this.map.getLane?.(laneId);
    if (!lane) return null;
    const fld = this._field(lane, forward);
    if (!fld) return null;
    const k0 = this._nearestFree(x, y);
    if (k0 < 0 || !isFinite(fld.dist[k0])) return null;
    const n = g.n, i = k0 % n, j = (k0 / n) | 0, here = fld.dist[k0];
    let vx = 0, vy = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
      const k2 = j2 * n + i2;
      if (!g.free[k2] || (di && dj && (!g.free[j * n + i2] || !g.free[j2 * n + i]))) continue;
      const L = di && dj ? SQ2 : 1;
      const drop = (here - fld.dist[k2]) / L;   // 每单位长度下降多少
      if (drop > 0) { vx += di / L * drop * drop; vy += dj / L * drop * drop; }
    }
    const len = Math.hypot(vx, vy);
    if (len < 1e-9) return null;
    return { x: vx / len, y: vy / len, cost: here };
  }

  // ==================== A* 追击路径 ====================

  /**
   * 从 (sx,sy) 到能站着打到目标的位置：离目标 ≤ goalR 且可走的格。
   * 返回世界坐标点数组（不含起点），不可达或超出扩展上限返回 null。
   */
  pathTo(sx, sy, tx, ty, goalR) {
    const g = this.grid;
    if (!g) return null;
    const C = cfg();
    const n = g.n;
    const s = this._nearestFree(sx, sy, cfg().startSearchCells ?? 10);
    if (s < 0) return null;
    const gR = Math.max(goalR, Math.min(g.cw, g.ch) * 1.5);
    const tgi = tx / g.cw, tgj = ty / g.ch;
    const hOf = (k) => {
      const i = k % n, j = (k / n) | 0;
      const dx = Math.abs(i + 0.5 - tgi), dy = Math.abs(j + 0.5 - tgj);
      return Math.max(0, (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)) - gR / g.cw);
    };
    const isGoal = (k) => {
      const i = k % n, j = (k / n) | 0;
      return ((i + 0.5) * g.cw - tx) ** 2 + ((j + 0.5) * g.ch - ty) ** 2 <= gR * gR;
    };
    this._gScore = this._gScore && this._gScore.length === n * n ? this._gScore : new Float64Array(n * n);
    this._came = this._came && this._came.length === n * n ? this._came : new Int32Array(n * n);
    this._stamp = this._stamp && this._stamp.length === n * n ? this._stamp : new Uint32Array(n * n);
    this._runId = (this._runId || 0) + 1;
    const gs = this._gScore, came = this._came, stamp = this._stamp, run = this._runId;
    const heap = new Heap(4096);
    gs[s] = 0; came[s] = -1; stamp[s] = run;
    heap.push(s, hOf(s));
    const maxExpand = C.maxExpand ?? 8000;
    let expanded = 0, goal = -1;
    while (heap.n) {
      const f = heap.topF(), k = heap.pop();
      const gk = gs[k];
      if (f > gk + hOf(k) + 1e-6) continue;   // 懒删除：旧条目
      if (isGoal(k)) { goal = k; break; }
      if (++expanded > maxExpand) return null;
      const i = k % n, j = (k / n) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i2 = i + di, j2 = j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
        const k2 = j2 * n + i2;
        if (!g.free[k2]) continue;
        if (di && dj && (!g.free[j * n + i2] || !g.free[j2 * n + i])) continue;
        const ng = gk + (di && dj ? SQ2 : 1);
        if (stamp[k2] !== run || ng < gs[k2]) {
          stamp[k2] = run; gs[k2] = ng; came[k2] = k;
          heap.push(k2, ng + hOf(k2));
        }
      }
    }
    if (goal < 0) return null;
    const cells = [];
    for (let k = goal; k !== s && k >= 0; k = came[k]) cells.push(k);
    cells.reverse();
    return {
      points: cells.map((k) => ({ x: (k % n + 0.5) * g.cw, y: (((k / n) | 0) + 0.5) * g.ch })),
      length: gs[goal] * g.cw,
    };
  }

  /** 单位半径（膨胀用的 unitPad 是按普通小兵估的，大体型单位路径上会多蹭一点，由转向层兜底） */
  static unitRadius(e) { return MINION_SIZES[e.type] || 10; }
}
