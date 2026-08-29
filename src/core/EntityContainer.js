/**
 * EntityContainer.js
 * 纯数据容器，管理所有实体。
 * 内置空间网格索引：findInRadius 此前是每次调用都全量扫描所有实体（O(n)），
 * 而 CombatSystem/SkillLibrary 中多个光环/被动每帧对每个单位调用它，
 * 造成 O(塔数×兵数) 级别的重复距离计算——这是单位越多越卡的根本原因。
 * 现在改为：每帧重建一次网格（O(n)，一次性代价很低），
 * findInRadius 查询时只扫描目标半径覆盖到的格子内的单位（局部、常数级）。
 */
const GRID_CELL = 100; // 网格单元大小（略大于常见光环/攻击范围，减少跨格查询数）

export class EntityContainer {
  constructor() {
    this._entities = new Map();
    this._typeIndex = new Map();
    this._grid = new Map();       // "gx,gy" -> Set<id>
    this._gridDirty = true;
    this._gridFrame = -1;
  }

  add(entity) {
    if (!entity.id) throw new Error('Entity must have an id');
    if (this._entities.has(entity.id)) this._removeFromIndices(entity.id);
    this._entities.set(entity.id, entity);
    this._addToIndices(entity);
    this._gridDirty = true;
    return entity;
  }

  remove(id) {
    if (!this._entities.has(id)) return false;
    this._removeFromIndices(id);
    this._gridDirty = true;
    return this._entities.delete(id);
  }

  /**
   * 显式作废空间网格。
   * Q3 之后网格按【存活/废墟状态】决定收不收一个实体，所以在容器外部直接改
   * entity.alive / _ruin（编辑器的复活·击杀就是这么干的）必须跟一声，
   * 否则网格要等到下一次 add/remove 才重建，中间这段时间查询结果是陈旧的。
   */
  markDirty() { this._gridDirty = true; }

  get(id) {
    return this._entities.get(id) || null;
  }

  getAll(aliveOnly = false) {
    const result = [];
    for (const e of this._entities.values()) {
      if (aliveOnly && !e.alive) continue;
      result.push(e);
    }
    return result;
  }

  getByType(type, aliveOnly = false) {
    const ids = this._typeIndex.get(type);
    if (!ids) return [];
    const result = [];
    for (const id of ids) {
      const e = this._entities.get(id);
      if (!e) continue;
      if (aliveOnly && !e.alive) continue;
      result.push(e);
    }
    return result;
  }

  // 每帧调用一次（由主循环 tick 驱动），使网格与实体实际位置同步。
  // 位置每帧都会变（移动的小兵），所以简单起见每帧整体重建一次，
  // 但这只是 O(n) 一次遍历，远比"findInRadius 内部每次全量扫描"便宜得多。
  rebuildGridIfNeeded(frame) {
    if (this._gridFrame === frame && !this._gridDirty) return;
    this._gridFrame = frame;
    this._gridDirty = false;
    this._grid.clear();
    for (const e of this._entities.values()) {
      if (!e.pos) continue;
      // Q3：网格【也索引静态障碍】——塔废墟(_ruin)与待重生的召唤水晶(_respawnAt)。
      // 原来这里只索引活体，导致所有 findInRadius(..., aliveOnly=false) 的调用都是
      // 空头支票：网格里压根没有死亡实体，传什么都拿不到。
      // 直接后果是 LaneMovementSystem 里那段"任意塔废墟 = 硬障碍"的避障【从未执行过】，
      // 小兵一直穿废墟；点选那边也因此不得不额外做一次全量扫描来兜底。
      // 这类实体全图最多几十个（塔 30 座），进网格的代价可以忽略。
      // 注意：aliveOnly 过滤仍在 findInRadius 内部，既有调用点行为不变。
      if (!e.alive && !e._ruin && !e._respawnAt) continue;
      const key = this._cellKey(e.pos.x, e.pos.y);
      let set = this._grid.get(key);
      if (!set) { set = []; this._grid.set(key, set); }
      set.push(e);
    }
  }

  _cellKey(x, y) {
    return ((x / GRID_CELL) | 0) + ',' + ((y / GRID_CELL) | 0);
  }

  findInRadius(cx, cy, radius, types = null, aliveOnly = true) {
    const radiusSq = radius * radius;
    const result = [];
    const typeSet = types ? new Set(Array.isArray(types) ? types : [types]) : null;

    if (this._grid.size > 0) {
      // 网格路径：只扫描半径覆盖到的格子
      const minGx = ((cx - radius) / GRID_CELL) | 0;
      const maxGx = ((cx + radius) / GRID_CELL) | 0;
      const minGy = ((cy - radius) / GRID_CELL) | 0;
      const maxGy = ((cy + radius) / GRID_CELL) | 0;
      for (let gx = minGx; gx <= maxGx; gx++) {
        for (let gy = minGy; gy <= maxGy; gy++) {
          const cell = this._grid.get(gx + ',' + gy);
          if (!cell) continue;
          for (const e of cell) {
            if (aliveOnly && !e.alive) continue;
            if (typeSet && !typeSet.has(e.type)) continue;
            const dx = e.pos.x - cx, dy = e.pos.y - cy;
            if (dx * dx + dy * dy <= radiusSq) result.push(e);
          }
        }
      }
      return result;
    }

    // 兜底：网格尚未构建（如测试环境直接调用）时退回全量扫描
    let entities;
    if (types) {
      const arr = Array.isArray(types) ? types : [types];
      entities = [];
      for (const t of arr) entities.push(...this.getByType(t, false));
    } else {
      entities = this.getAll(false);
    }
    for (const e of entities) {
      if (aliveOnly && !e.alive) continue;
      if (!e.pos) continue;
      const dx = e.pos.x - cx, dy = e.pos.y - cy;
      if (dx * dx + dy * dy <= radiusSq) result.push(e);
    }
    return result;
  }

  findNearest(cx, cy, filter) {
    let best = null, bestDistSq = Infinity;
    for (const e of this._entities.values()) {
      if (!e.alive || !e.pos) continue;
      if (filter && !filter(e)) continue;
      const dx = e.pos.x - cx, dy = e.pos.y - cy;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = e;
      }
    }
    return best;
  }

  purgeDead() {
    const toRemove = [];
    for (const [id, e] of this._entities) {
      if (e.alive) continue;
      // 用户定稿："死亡的塔也应该能被选中"。
      // 所以【任何塔死后都留成废墟】而不是被清掉 —— 留着才点得中，
      // 才能在属性编辑器里查看/改属性、改阵营、复活或彻底击杀。
      //
      // 原来只有 MapSystem._onEntityDeath 会打 _ruin，而那条路径有三重门槛
      // （地图未激活 / 无 _mapFaction / 无 _mapTier 一律返回），于是**手建的塔
      // 死后直接被清掉，根本选不中**。规则挪到这里：实体生命周期归容器管，
      // 放在这一处就漏不掉，也不需要各系统各记一遍。
      if (e.type === 'tower' && !e._ruin) { e._ruin = true; this._gridDirty = true; }
      if (!e._respawnAt && !e._ruin) toRemove.push(id);
    }
    for (const id of toRemove) this.remove(id);
    return toRemove.length;
  }

  _addToIndices(e) {
    if (e.type) {
      if (!this._typeIndex.has(e.type)) this._typeIndex.set(e.type, new Set());
      this._typeIndex.get(e.type).add(e.id);
    }
  }

  _removeFromIndices(id) {
    const e = this._entities.get(id);
    if (e && e.type) {
      const set = this._typeIndex.get(e.type);
      if (set) {
        set.delete(id);
        if (set.size === 0) this._typeIndex.delete(e.type);
      }
    }
  }

  count(aliveOnly = false) {
    if (!aliveOnly) return this._entities.size;
    let c = 0;
    for (const e of this._entities.values()) if (e.alive) c++;
    return c;
  }

  clear() {
    this._entities.clear();
    this._typeIndex.clear();
  }

  *[Symbol.iterator]() {
    for (const e of this._entities.values()) yield e;
  }

  // ========== 辅助方法 ==========
  getAllTowers(aliveOnly = true) {
    return this.getByType('tower', aliveOnly);
  }

  getAllMinions(aliveOnly = true) {
    return this.getAll(aliveOnly).filter(e => e.type !== 'tower');
  }
}