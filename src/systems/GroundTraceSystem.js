import { CONFIG } from '../data/Config.js';

/**
 * GroundTraceSystem.js —— 地面痕迹层（水洼/雪痕，Q4 天气重做落地）
 *
 * 雨的水洼、雪的破雪通道，本质是同一类东西：**地面上一小块会随天气强度动态
 * 生成/合并/消退、且对经过单位有持续效果的区域**（见
 * docs/Q4-WEATHER-REDESIGN.md §四）。这里用同一套骨架承载两种痕迹，只是数值
 * 方向相反：水洼是"进去减速"的负面痕迹（区域生成型，随机撒在地面上），雪痕是
 * "沿着走更快"的正面痕迹（路径生成型，跟着移动单位的脚印走）。
 *
 * ==================== 为什么不走 EffectRegistry 的常规 aura 机制 ====================
 * makeAuraPassive（skills/_helpers.js）是"以施法者为圆心，扫周围友军"的模型，
 * 这里反过来：是**地面固定区域**，单位路过就吃效果，跟哪个技能/哪个施法者无关。
 * 效果本身仍然复用同一套 aura 参数约定（duration 短、stackPolicy:'refresh'、
 * uniquePassive:true）以获得同样"离开自动脱落、不会因重复 apply 而闪烁"的
 * 行为，只是判定"在不在范围内"的逻辑是这个系统自己算的几何查询，不是
 * findInRadius 以施法者为心的邻域搜索。
 */
export class GroundTraceSystem {
  constructor(entityContainer, effectRegistry, mapSystem, weatherSystem) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.mapSystem = mapSystem;
    this.weather = weatherSystem;

    this.puddles = []; // [{id, x, y, r, strength, subOffsets:[{dx,dy,r}]}]
    this.trails = [];  // [{id, x, y, r, age, lifetime}]

    this._rainSustainT = 0;
    this._puddleRespawnT = 0;
    this._nextId = 1;
  }

  update(dt) {
    this._updatePuddles(dt);
    this._updateTrails(dt);
    this._applyEffects();
  }

  /** 每次载图重新开局：上一局的水洼/雪痕不该带到新的一局。 */
  reset() {
    this.puddles = [];
    this.trails = [];
    this._rainSustainT = 0;
    this._puddleRespawnT = 0;
  }

  // ==================== 水洼（雨） ====================

  _rainScale() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getEffectiveStrengths?.().rain || 0;
  }

  _rainCharge() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getCharge ? ws.getCharge('rain') : 0;
  }

  _updatePuddles(dt) {
    const cfg = CONFIG.groundTrace?.puddle || {};
    const scale = this._rainScale();
    const charge = this._rainCharge();

    // 触发门槛：持续够久，或瞬时够猛，两者任一满足。
    if (scale >= (cfg.sustainedThresholdScale ?? 0.75)) this._rainSustainT += dt;
    else this._rainSustainT = 0;
    const active = this._rainSustainT >= (cfg.sustainedSeconds ?? 12)
      || charge >= (cfg.instantChargeThreshold ?? 0.75);

    if (active) {
      const targetCount = Math.round((cfg.minPatches ?? 8)
        + ((cfg.maxPatches ?? 20) - (cfg.minPatches ?? 8)) * scale);
      this._puddleRespawnT += dt;
      const interval = cfg.respawnIntervalSec ?? 2.5;
      while (this._puddleRespawnT >= interval && this.puddles.length < targetCount) {
        this._puddleRespawnT -= interval;
        this._spawnPuddle(cfg);
      }
      if (this._puddleRespawnT > interval) this._puddleRespawnT = interval; // 不欠账累积
      for (const p of this.puddles) p.strength = Math.min(1, p.strength + (cfg.growPerSec ?? 0.5) * dt);
    } else {
      this._puddleRespawnT = 0;
      for (const p of this.puddles) p.strength -= (cfg.decayPerSec ?? 0.08) * dt;
      this.puddles = this.puddles.filter(p => p.strength > 0);
    }
  }

  /** 在可行走区域内随机取一点；找不到就放弃（不强行落在墙里/野区外）。 */
  _randomWalkablePoint() {
    const ms = this.mapSystem;
    const world = ms?.currentMap?.world;
    if (!ms || !world) return null;
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * world.w;
      const y = Math.random() * world.h;
      if (!ms.isWalkable || ms.isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  _spawnPuddle(cfg) {
    const pos = this._randomWalkablePoint();
    if (!pos) return;
    // 距离够近的已有水洼直接合并进去，而不是各自独立——"水洼可以连接到一块"。
    const mergeDist = cfg.mergeDistance ?? 90;
    const near = this.puddles.find(p => Math.hypot(p.x - pos.x, p.y - pos.y) < mergeDist);
    const subOffsets = this._makeSubOffsets(cfg);
    if (near) {
      this._mergeSubOffsets(near, pos, subOffsets, cfg);
      near.strength = Math.max(near.strength, 0.15);
      return;
    }
    const p = { id: this._nextId++, x: pos.x, y: pos.y, strength: 0.05, subOffsets };
    p.r = this._boundingRadius(p);
    this.puddles.push(p);
  }

  _makeSubOffsets(cfg) {
    const n = (cfg.subCirclesPerPatchMin ?? 3)
      + Math.floor(Math.random() * ((cfg.subCirclesPerPatchMax ?? 6) - (cfg.subCirclesPerPatchMin ?? 3) + 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const rMin = cfg.subRadiusMin ?? 30, rMax = cfg.subRadiusMax ?? 70;
      const r = rMin + Math.random() * (rMax - rMin);
      // 子圆中心撒在一个比半径稍大的圈内，让整片形状不规则又保持大致连成一片。
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * r * 0.8;
      out.push({ dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, r });
    }
    return out;
  }

  /** 把新生成的一组子圆（世界坐标偏移量 newPos + newSubOffsets）并入已有水洼 target。 */
  _mergeSubOffsets(target, newPos, newSubOffsets, cfg) {
    for (const so of newSubOffsets) {
      target.subOffsets.push({ dx: (newPos.x + so.dx) - target.x, dy: (newPos.y + so.dy) - target.y, r: so.r });
    }
    const cap = cfg.maxSubCircles ?? 20;
    if (target.subOffsets.length > cap) target.subOffsets = target.subOffsets.slice(-cap);
    target.r = this._boundingRadius(target);
  }

  _boundingRadius(p) {
    let r = 0;
    for (const so of p.subOffsets) r = Math.max(r, Math.hypot(so.dx, so.dy) + so.r);
    return r;
  }

  // ==================== 雪痕（雪） ====================

  _snowScale() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getEffectiveStrengths?.().snow || 0;
  }

  _updateTrails(dt) {
    const cfg = CONFIG.groundTrace?.snowTrail || {};
    for (const t of this.trails) t.age += dt;
    this.trails = this.trails.filter(t => t.age < t.lifetime);

    const scale = this._snowScale();
    if (scale < (cfg.minTierScale ?? 0.25)) return;
    const interval = cfg.sampleIntervalSec ?? 0.4;
    const minDist = cfg.minMoveDistPx ?? 8;
    for (const m of this.entities.getAllMinions(true)) {
      if (!m.alive || !m.pos) continue;
      m._groundTraceSampleT = (m._groundTraceSampleT || 0) + dt;
      if (m._groundTraceSampleT < interval) continue;
      m._groundTraceSampleT = 0;
      const lx = m._groundTraceLastX, ly = m._groundTraceLastY;
      if (lx != null && Math.hypot(m.pos.x - lx, m.pos.y - ly) < minDist) continue;
      m._groundTraceLastX = m.pos.x; m._groundTraceLastY = m.pos.y;
      this.trails.push({
        id: this._nextId++, x: m.pos.x, y: m.pos.y,
        r: cfg.segmentRadius ?? 26, age: 0, lifetime: cfg.lifetimeSec ?? 10,
      });
    }
  }

  // ==================== 效果应用 ====================

  _applyEffects() {
    const puddleCfg = CONFIG.groundTrace?.puddle || {};
    const trailCfg = CONFIG.groundTrace?.snowTrail || {};
    for (const m of this.entities.getAllMinions(true)) {
      if (!m.alive || !m.pos) continue;

      let inPuddle = 0;
      for (const p of this.puddles) {
        if (p.strength <= 0) continue;
        for (const so of p.subOffsets) {
          const cx = p.x + so.dx, cy = p.y + so.dy;
          if (Math.hypot(m.pos.x - cx, m.pos.y - cy) <= so.r) { inPuddle = Math.max(inPuddle, p.strength); break; }
        }
      }
      if (inPuddle > 0) {
        this.effects.apply(m.id, {
          // aura:true 时 EffectRegistry 会把 duration 强制设成 Infinity，改用宽限期
          // （auraGrace）自动到期——不用也不该在这里再传 duration，见
          // EffectRegistry.apply 的"光环机制"头注。
          aura: true, auraGrace: 1.0, name: '水洼', icon: '💧', kind: 'stat', statKey: 'moveSpeed',
          percent: (puddleCfg.slowPct ?? -25) * inPuddle,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `水洼：移速 ${(puddleCfg.slowPct ?? -25) * inPuddle >= 0 ? '+' : ''}${Math.round((puddleCfg.slowPct ?? -25) * inPuddle)}%`,
        }, 'groundtrace_puddle');
      }

      let onTrail = 0;
      for (const t of this.trails) {
        const strength = 1 - t.age / t.lifetime;
        if (strength <= 0) continue;
        if (Math.hypot(m.pos.x - t.x, m.pos.y - t.y) <= t.r) { onTrail = Math.max(onTrail, strength); }
      }
      if (onTrail > 0) {
        this.effects.apply(m.id, {
          aura: true, auraGrace: 1.0, name: '雪痕', icon: '❄️', kind: 'stat', statKey: 'moveSpeed',
          percent: (trailCfg.speedPct ?? 20) * onTrail,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `雪痕：移速 +${Math.round((trailCfg.speedPct ?? 20) * onTrail)}%`,
        }, 'groundtrace_trail');
      }
    }
  }

  /** 供渲染层读——只读快照。 */
  getPuddles() { return this.puddles; }
  getTrails() { return this.trails; }
}
