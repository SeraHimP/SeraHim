export class ProjectileSystem {
  constructor(entityContainer, eventBus, combatSystem) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.combat = combatSystem;
    this.projectiles = []; // 普通飞行子弹（会移动，到达目标时结算伤害）
    this.beams = new Map(); // 持久光束：attackerId -> beam（不移动，随攻击刷新，无攻击则淡出）
    this.arcs = [];         // 闪电链电弧：短寿命纯视觉线段（v33，渲染器画锯齿闪电）
  }

  // 闪电链电弧（纯视觉，无伤害逻辑——伤害在武器层已结算）
  fireArc(arc) {
    // 上限保护：极端兵堆下每 0.25s 最多 6 条 × 多塔，封顶 120 条防渲染压力
    if (this.arcs.length > 120) this.arcs.shift();
    this.arcs.push({
      startX: arc.startX, startY: arc.startY, endX: arc.endX, endY: arc.endY,
      ttl: arc.life || 0.12, maxTtl: arc.life || 0.12, color: arc.color || '#f1c40f',
      seed: (Math.random() * 1e6) | 0, // 锯齿形状的随机种子（生成一次，存活期内不变——闪电不抖）
    });
  }

  fire(projectile) {
    this.projectiles.push(projectile);
  }

  // 闪电杖持久光束：按攻击者维护一条常驻光束，每次攻击刷新端点/充能/存活计时，
  // 而非每次新建短命光束——这样视觉上是一条连续不闪的光束（参考源实现）。
  fireBeam(beam) {
    const key = beam.attackerId != null ? beam.attackerId : `_${beam.startX}_${beam.startY}`;
    const existing = this.beams.get(key);
    if (existing) {
      existing.startX = beam.startX; existing.startY = beam.startY;
      existing.endX = beam.endX; existing.endY = beam.endY;
      existing.charge = beam.charge ?? existing.charge;
      existing.color = beam.color || existing.color;
      existing.ttl = beam.life || 0.3; // 刷新存活时间
      existing.fadeT = undefined;      // v39：复用时清除淡出标记（防止残影态被继承）
    } else {
      this.beams.set(key, {
        startX: beam.startX, startY: beam.startY, endX: beam.endX, endY: beam.endY,
        charge: beam.charge ?? 0, color: beam.color || '#f1c40f', ttl: beam.life || 0.3,
      });
    }
  }

  /** v39（Q8）：立即清除某攻击者的光束（切换目标时调用，避免旧弹道留在原地淡出） */
  clearBeam(attackerId) {
    this.beams.delete(attackerId);
  }

  update(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const target = this.entities.get(p.targetId);
      if (!target || !target.alive) { this.projectiles.splice(i, 1); continue; }
      const dx = target.pos.x - p.startX;
      const dy = target.pos.y - p.startY;
      const totalDist = Math.hypot(dx, dy);
      if (totalDist < 1) { this._hit(p); this.projectiles.splice(i, 1); continue; }
      const speed = p.speed || 400;
      const step = speed * dt;
      p.progress = (p.progress || 0) + step / totalDist;
      if (p.progress >= 1) { this._hit(p); this.projectiles.splice(i, 1); }
      else { p.currentX = p.startX + dx * p.progress; p.currentY = p.startY + dy * p.progress; }
    }

    // 光束：存活计时递减。v36（Q2）：攻击停止（目标死亡/脱离）后不再刷新 →
    // 进入淡出残留期（fadeT 从 0.35s 递减，渲染层据此淡出最后一段轨迹）。
    for (const [key, b] of this.beams) {
      b.ttl -= dt;
      if (b.ttl <= 0) {
        // 首次到期：转入淡出态而不是立即删除（残留一小段时间）
        if (b.fadeT === undefined) { b.fadeT = 0.35; b.fadeMax = 0.35; }
        b.fadeT -= dt;
        if (b.fadeT <= 0) this.beams.delete(key);
      } else {
        b.fadeT = undefined; // 仍在被刷新 → 清除淡出标记
      }
    }

    // 电弧：短寿命，到期移除
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].ttl -= dt;
      if (this.arcs[i].ttl <= 0) this.arcs.splice(i, 1);
    }
  }

  _hit(p) {
    const target = this.entities.get(p.targetId);
    if (!target || !target.alive) return;
    if (p.pendingHit) this.combat._resolveHit(p.pendingHit);
  }

  getProjectiles() { return this.projectiles; }
  getBeams() { return Array.from(this.beams.values()); }
  getArcs() { return this.arcs; }
}
