import { CONFIG } from '../data/Config.js';

/** 光束的淡入/淡出时长（软编码，编辑器可调）。缺省值与参数化前逐位一致。 */
const beamCfg = () => (CONFIG.ui && CONFIG.ui.beam) || {};

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
      existing.targetId = beam.targetId ?? existing.targetId;   // Q1：端点高度要按实体查，不能按坐标猜
      existing.attackerId = beam.attackerId ?? existing.attackerId; // v43 Q2：起点高度同理
      existing.fadeT = undefined;      // v39：复用时清除淡出标记（防止残影态被继承）
    } else {
      const rise = beamCfg().fadeIn ?? 0.10;
      this.beams.set(key, {
        startX: beam.startX, startY: beam.startY, endX: beam.endX, endY: beam.endY,
        charge: beam.charge ?? 0, color: beam.color || '#f1c40f', ttl: beam.life || 0.3,
        targetId: beam.targetId ?? null,
        attackerId: beam.attackerId ?? null,
        // v43 Q2：淡入。用户："出现也应该是淡入"——旧版是"啪"地整束光满亮度出现。
        riseT: rise > 0 ? rise : undefined, riseMax: rise > 0 ? rise : undefined,
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
      // B2：目标存活 → 追踪其位置（记录最后落点）；目标中途死亡 → 不再删除子弹，
      // 冻结到【最后已知落点】继续飞到底，然后消失，**不造成任何伤害**
      //（用户定稿："残余的子弹会到达已经死亡的目标处才会消失而不是在半空直接消失，
      //   并且这个子弹不造成任何伤害（包括爆炸型）"）。
      let tx, ty;
      if (target && target.alive) {
        tx = target.pos.x; ty = target.pos.y;
        p.lastTx = tx; p.lastTy = ty; p.dead = false;
      } else {
        if (p.lastTx == null) { this.projectiles.splice(i, 1); continue; } // 从未见到目标位置（异常）→ 丢弃
        tx = p.lastTx; ty = p.lastTy; p.dead = true;
      }
      const dx = tx - p.startX;
      const dy = ty - p.startY;
      const totalDist = Math.hypot(dx, dy);
      if (totalDist < 1) { this._hit(p); this.projectiles.splice(i, 1); continue; }
      const speed = p.speed || 400;
      const step = speed * dt;
      p.progress = (p.progress || 0) + step / totalDist;
      if (p.progress >= 1) { this._hit(p); this.projectiles.splice(i, 1); }
      else { p.currentX = p.startX + dx * p.progress; p.currentY = p.startY + dy * p.progress; }
    }

    // 光束：存活计时递减。v36（Q2）：攻击停止（目标死亡/脱离）后不再刷新 →
    // 进入淡出残留期（渲染层据此淡出最后一段轨迹）。
    //
    // ==================== v43 Q2：目标一死就立刻淡出 ====================
    // 用户："目标死亡后弹道仍会残留极短时间。目标死亡后应该立即淡出。"
    // 旧实现只看 ttl：目标死了武器层停止刷新，但光束还要把剩下的 ttl（最多 0.3s）
    // **满亮度**走完，才开始 0.35s 的淡出 —— 也就是最坏情况下尸体上挂着 0.65s 的光。
    // 现在把"目标没了"提升为与 ttl 到期同级的淡出触发条件，且用一条更短的
    // fadeOnDeath（默认 0.12s）：死亡是个瞬间事件，该干脆地收掉。
    const B = beamCfg();
    for (const [key, b] of this.beams) {
      if (b.riseT !== undefined) { b.riseT -= dt; if (b.riseT <= 0) b.riseT = undefined; }
      const tgt = b.targetId != null ? this.entities.get(b.targetId) : null;
      const targetGone = b.targetId != null && (!tgt || !tgt.alive);
      b.ttl -= dt;
      if (b.ttl <= 0 || targetGone) {
        // 首次到期：转入淡出态而不是立即删除（残留一小段时间）
        if (b.fadeT === undefined) {
          const d = targetGone ? (B.fadeOnDeath ?? 0.12) : (B.fadeOut ?? 0.35);
          b.fadeT = d; b.fadeMax = d;
        }
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
    if (!p.pendingHit) return;
    const target = this.entities.get(p.targetId);
    if (target && target.alive) {
      this.combat._resolveHit(p.pendingHit);            // 正常命中：直伤 + 溅射
    }
    // 目标已死：子弹已经飞到落点了，这里【什么都不做】——不结算直伤，也不炸。
    // 上一版还会在落点走一次 _resolveHitSplashOnly（爆炸型/攻城车仍然溅射），
    // 用户明确否掉了："这个子弹不造成任何伤害（包括爆炸型）"。
    // 于是"目标死了还被残弹的溅射补刀"这种事不会再发生。
  }

  getProjectiles() { return this.projectiles; }
  getBeams() { return Array.from(this.beams.values()); }
  getArcs() { return this.arcs; }
}
