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
    // v43 P0-③：闪电链电弧（arcs / fireArc / getArcs）已整个删除。
    // 闪电链本身在 v35 就按用户定稿去掉了（"纯单体，无 AOE"），但这套数据结构、
    // fireArc 与渲染层那 30 行锯齿绘制一起留了下来 —— fireArc **没有任何调用者**，
    // 也就是说它从 v35 起就没画过一个像素。删掉它，渲染层最后一个"按坐标查高度"的
    // 用户也一并消失了。
  }

  fire(projectile) {
    // ==================== v49：落点在**开火那一刻**就先记一份 ====================
    // 用户："无论攻击单位是否死亡，只要发出去的子弹就造成伤害。"
    //
    // lastTx/lastTy 原来只在 update 里、且只在"目标还活着"的那一帧才写。
    // 于是目标在**同一帧内**死掉时它从没被写过，下面的循环会走
    // `if (p.lastTx == null) → 丢弃`，整发子弹凭空消失 —— 与"发出去就算数"直接冲突。
    // 开火时目标必然还活着（不然打不出这一发），此刻的位置就是最合理的兜底落点。
    const t0 = projectile.targetId != null ? this.entities.get(projectile.targetId) : null;
    if (t0 && t0.pos && projectile.lastTx == null) {
      projectile.lastTx = t0.pos.x; projectile.lastTy = t0.pos.y;
    }
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

  }

  _hit(p) {
    if (!p.pendingHit) return;
    const target = this.entities.get(p.targetId);
    if (target && target.alive) {
      this.combat._resolveHit(p.pendingHit);            // 正常命中：直伤 + 溅射
      return;
    }
    // ==================== v43 Q2b：目标已死 → 直伤不结算，溅射照常 ====================
    // 用户："只要子弹存在就应该有伤害！其他单位也是一样！"
    //      "落点结算一次完整命中，如果目标已经死亡那么这个子弹照常走完流程但是不造成伤害，
    //        溅射给其他单位正常结算。"
    //
    // 这**推翻了上一版的定稿**。上一版的原话是"这个子弹不造成任何伤害（包括爆炸型）"，
    // 当时为此把 CombatSystem 里的 splash-only 路径整个删掉了。现在按新定稿恢复。
    // 为什么会推翻：攻城车的伤害有很大一部分在溅射上，主目标一死整发炮弹归零，
    // 表现出来就是"打出去的炮没了"。
    this.combat.resolveSplashOnlyAt?.(p.pendingHit, p.lastTx, p.lastTy);
  }

  getProjectiles() { return this.projectiles; }
  getBeams() { return Array.from(this.beams.values()); }
}
