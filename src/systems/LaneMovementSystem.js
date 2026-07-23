import { canTarget, isStructureProtected } from './FactionSystem.js';
import { AISystem } from './AISystem.js';
import { getSiegeWeaponDef } from './CombatSystem.js';
import { CONFIG, MINION_SIZES } from '../data/Config.js';

/**
 * LaneMovementSystem.js
 * 对战模式专用：小兵沿地图 waypoint 折线行军 + 仇恨索敌（LoL 式）。
 * 沙盒模式完全不用这个系统——两套移动逻辑通过 mapSystem.active 互斥。
 *
 * ==================== 行为模型（Q2 重构：路径 = 参考线，不再是硬轨道）====================
 * 旧模型：小兵严格贴折线走，索敌半径 = 自身攻击射程 → 近战兵（射程30）会无视
 * 偏离路径 30px 以上的一切目标（中路枢纽塔离路径 75px，近战永远打不到，就是这个原因）。
 *
 * 新模型（对应 LoL 的仇恨获取机制）：
 * 1. 索敌：以 ACQUISITION_RANGE（200 ≈ LoL 小兵仇恨半径 800 × 0.24）为半径搜索敌人，
 *    与自身攻击射程解耦。近战兵能"看见"200 内的目标并走过去打。
 * 2. 追击：有目标但不在攻击射程内 → 直线走向目标（允许离开路径）。
 *    目标超出 CHASE_DROP_RANGE（240 = 索敌半径 × 1.2）则放弃仇恨，防止被无限拖走。
 * 3. 回归：无目标 → 走向当前路点。带"路点跳跃"：若已比当前路点更接近下一个路点
 *    （追击把自己带到了前方），直接推进索引，不往回走。
 *
 * 这个改动同时意味着：建筑不再必须精确压在路径折线上（虽然当前地图仍然如此），
 * 偏离路径 ≤200 的建筑都会被正常进攻。
 *
 * 性能：索敌用 entityContainer.findInRadius（空间网格局部查询），与旧版相同，
 * 半径从 20~180 扩到固定 200 只影响网格查询的桶数，仍是 O(局部单位数)。
 */

// 调参归拢：数值住在 CONFIG.tuning（Config.js），这里只取默认兜底——调平衡改配置，不翻系统源码
const ACQUISITION_RANGE = CONFIG.tuning?.acquisitionRange ?? 200;        // 仇恨获取半径（≈ LoL 800 × 0.24）
const CHASE_DROP_RANGE = ACQUISITION_RANGE * (CONFIG.tuning?.chaseDropFactor ?? 1.2); // 追击放弃距离

export class LaneMovementSystem {
  constructor(entityContainer, effectRegistry, attrCalc, combatSystem, mapSystem) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.attrCalc = attrCalc;
    this.combat = combatSystem;
    this.mapSystem = mapSystem;
  }

  update(dt) {
    if (!this.mapSystem.active) return; // 沙盒模式：这个系统完全不介入

    const minions = this.entities.getAllMinions(true).filter(m => m._mapFaction && m._laneId);

    // ==================== 守家优先（每帧每阵营只查一次圈）====================
    // 圈：己方水晶枢纽为圆心，半径 = 枢纽到枢纽塔距离 + 塔射程（MapSystem.getDefenseZone）。
    // 规则：圈内出现敌方单位时，【身处圈内的】己方小兵优先攻击圈内敌人（守家），
    // 圈清空后恢复正常推线。不召回已推出去的小兵（圈外小兵不受影响）。
    const intruders = {}; // faction -> { zone, list }
    for (const faction of ['blue', 'red']) {
      const zone = this.mapSystem.getDefenseZone ? this.mapSystem.getDefenseZone(faction) : null;
      if (!zone) continue;
      const list = this.entities.findInRadius(zone.x, zone.y, zone.r, null, true).filter(e =>
        e.alive && canTarget(faction, e._mapFaction || e.faction) &&
        !isStructureProtected(this.entities, e)
      );
      if (list.length) intruders[faction] = { zone, list };
    }

    for (const minion of minions) {
      if (!minion.alive || !minion.pos) continue;
      if (this.effects.isStunned(minion.id)) continue;

      const stats = this.attrCalc.calc(minion, this.effects.getEffects(minion.id));
      const range = stats.attackRange || 20;

      // ---- 1. 目标校验：死亡/不可打/超出放弃距离 → 丢仇恨 ----
      let target = minion.targetId ? this.entities.get(minion.targetId) : null;
      if (target && (!target.alive || !canTarget(minion._mapFaction, target._mapFaction || target.faction))) target = null;
      if (target) {
        const dx = target.pos.x - minion.pos.x, dy = target.pos.y - minion.pos.y;
        if (dx * dx + dy * dy > CHASE_DROP_RANGE * CHASE_DROP_RANGE) target = null;
      }

      // ---- 2. 扫描：单次查询取"索敌半径内最近敌"与"攻击射程内最近敌" ----
      const scan = AISystem.scanEnemies(this.entities, this.mapSystem, minion, ACQUISITION_RANGE, range);

      // ---- 3. 守家优先：己方防守圈内有敌人且自己也在圈内 → 锁定圈内最近敌人。
      //     覆盖普通仇恨（不受追击放弃距离约束）。射程内规则（下方）仍然优先——
      //     守家路上有敌人贴脸照样先打贴脸的。
      let _zoneTarget = null;
      const inv = intruders[minion._mapFaction];
      if (inv) {
        const dz = (minion.pos.x - inv.zone.x) ** 2 + (minion.pos.y - inv.zone.y) ** 2;
        if (dz <= inv.zone.r * inv.zone.r) {
          let best = null, bestD = Infinity;
          for (const e of inv.list) {
            if (!e.alive) continue;
            const d = (e.pos.x - minion.pos.x) ** 2 + (e.pos.y - minion.pos.y) ** 2;
            if (d < bestD) { bestD = d; best = e; }
          }
          _zoneTarget = best;
        }
      }

      // ---- 4. LoL 式接敌规则（修复"等速追逐永远追不上/两波兵互相穿过"）：
      //     a) 射程内有任何敌人 → 必定停下开打。当前目标若也在射程内则保持（粘性防抖），
      //        否则换成射程内最近者（机会主义换目标：贴脸的敌人 > 远处追不上的目标）。
      //     b) 射程内没有敌人 → 沿用当前目标追击，没有目标则锁定索敌半径内最近敌。
      //     旧版死追锁定目标的恶果（仿真实测）：双方等速互追形成旋转木马，40s 零攻击，
      //     混战团半径膨胀至 153px——正是"互相走过去了才开始战斗"的根源。
      //     c) 关键补充（仿真发现的几何陷阱）：射程外的追击目标【每步重估为最近敌】，
      //        绝不粘住远目标——等速追击不朝你走的目标永远追不上，粘性远追会让双方
      //        各追各的形成稳定轨道、两团人永不相遇（实测 40s 零攻击）。每步追最近敌时，
      //        全局最近的敌对一对必然互为最近 → 迎面收敛 → 锚定成静止靶 → 全场连锁坍缩成战线。
      //        粘性只保留在射程内（防止攻击目标抖动）。
      // ===== v39（Q4）攻城车：锁定建筑后不再改目标 =====
      // 用户定稿："以某座防御塔为目标后就不会再改变目标，直至防御塔摧毁或攻城车死亡"，
      // 且"对所有建筑单位生效"。锁定只认【当前可选中】的建筑（受结构保护的不锁）。
      if (getSiegeWeaponDef(minion, this.combat.skills)) {
        const locked = minion._ramLockId ? this.entities.get(minion._ramLockId) : null;
        if (locked && locked.alive) {
          target = locked;               // 锁定期间无视一切其他目标
          minion.targetId = locked.id;
        } else {
          minion._ramLockId = null;
          if (target && target.type === 'tower' && !isStructureProtected(this.entities, target)) {
            minion._ramLockId = target.id;   // 首次锁定
          }
        }
      }

      const targetInRange = target && ((target.pos.x - minion.pos.x) ** 2 + (target.pos.y - minion.pos.y) ** 2) <= range * range;
      if (!targetInRange) {
        // v37（Q2）：追击目标短粘性 0.35s——每帧重估最近敌导致追击方向频繁抖动。
        // 关键约束（不能破坏 v33 反"旋转木马"设计）：粘性【仅当目标仍在被接近】时生效；
        // 距离不再缩短（互相绕圈/目标不朝我走）→ 立即重估最近敌，收敛性保留。
        // 射程内敌人的最高优先级不变（贴脸的永远先打）。
        const now2 = window.gameTime || 0;
        let keepChase = false;
        if (target && !scan.inRange && now2 < (minion._retargetAt || 0)) {
          const dNow = (target.pos.x - minion.pos.x) ** 2 + (target.pos.y - minion.pos.y) ** 2;
          if (dNow < (minion._chaseLastD ?? Infinity)) { keepChase = true; minion._chaseLastD = dNow; }
        }
        if (!keepChase) {
          const prev = target;
          // 优先级：射程内敌人 > 守家圈内敌人 > 索敌半径内最近【可视】敌 > 残留目标
          target = scan.inRange || _zoneTarget || scan.nearest || target;
          if (target && target !== prev) {
            minion._retargetAt = now2 + 0.35;
            minion._chaseLastD = (target.pos.x - minion.pos.x) ** 2 + (target.pos.y - minion.pos.y) ** 2;
          }
        }
      }
      // v33（Q14）：锁定【新目标】时施加 0.3s 攻击前摇（LoL 式，绝对时间戳比较）
      if (target && minion.targetId !== target.id) {
        minion._lockUntil = (window.gameTime || 0) + (CONFIG.tuning?.lockOnWindup ?? 0.3);
      }
      minion.targetId = target ? target.id : null;

      if (target) {
        const dx = target.pos.x - minion.pos.x, dy = target.pos.y - minion.pos.y;
        const distSq = dx * dx + dy * dy;
        // v37（Q2）：脱锚滞回——近战抽搐的根因。已锚定的兵用【1.15×射程】判定脱离，
        // 未锚定用原射程判定进入。没有滞回时：目标兵在射程边缘挪动 → 本帧锚定站定、
        // 下帧超出射程追一步、再下帧又进射程锚定……走一步停一步（LoL 同样有脱锚缓冲）。
        const holdRange = minion._anchored ? range * 1.15 : range;
        if (distSq <= holdRange * holdRange) {
          // ---- 5a. 射程内：站定输出（锚定标记供碰撞系统识别，锚定单位几乎不可推动） ----
          minion._anchored = true;
          minion._offPath = true; // 交战过（可能被位移/追击带离路径），脱战后需重投影
          if (minion.attackCooldown <= 0 && !((window.gameTime || 0) < (minion._lockUntil || 0))) {
            this.combat.performAttack(minion, target);
            let finalAS = this.attrCalc.calcAttackSpeed(
              minion.baseStats.baseAttackSpeed, stats.bonusAttackSpeedPct || 0, minion.baseStats.attackSpeedRatio || 0.667
            );
            // ===== v40 攻城武器被动：攻击建筑时 攻速-50% + 自损20%最大生命 =====
            // 装备了被动才生效，倍率/百分比全部取自技能定义（拆掉被动即失效）。
            const swDef = getSiegeWeaponDef(minion, this.combat.skills);
            if (swDef && target.type === 'tower') {
              finalAS *= swDef.TOWER_ATKSPD_MULT;
              const selfDmg = (this.attrCalc.calc(minion, this.effects.getEffects(minion.id)).maxHP
                || minion.baseStats.maxHP || 1) * swDef.SELF_DAMAGE_PCT;
              minion.currentHP -= selfDmg;
              if (minion.currentHP <= 0 && minion.alive) {
                minion.currentHP = 0; minion.alive = false;
                this.combat.eventBus?.emit?.('entity:death', { entityId: minion.id });
              }
            }
            minion.attackCooldown = 1 / (finalAS || 0.5);
            minion._cdAS = finalAS;
          }
          // ---- v34（Q3 重做）：落位一次、之后冻结 ----
          // v33 的持续围圈滑动（_ringSpacing 每帧执行）是"混战团膨胀"的位移源之一：
          // 密集堆里每帧都有兵在滑，滑动 + 碰撞互推叠加 = 整团向外蠕动。
          // LoL 的真实行为：攻击者到位后【站死】。所以改为——只在锚定的【瞬间】
          // 做一次落位搜索（与已锚定同伴重叠时沿攻击弧找最近空位），之后位置冻结，
          // 由 CollisionSystem 把它当静态障碍。
          if (!minion._slotted) {
            this._findAnchorSlot(minion, target, range);
            minion._slotted = true;
          }
        } else {
          // ---- 5b. 射程外：脱轨追击，直线逼近目标 ----
          minion._anchored = false;
          minion._slotted = false; // 脱离锚定 → 下次进入攻击距离时重新落位一次
          minion._offPath = true; // 追击中，位置已偏离路径
          const dist = Math.sqrt(distSq);
          const speed = stats.moveSpeed || 30;
          const px = minion.pos.x, py = minion.pos.y;
          this._steer(minion, dx / dist, dy / dist, speed, dt);
          // v37（Q2）：罚站自愈——追击帧位移几乎为零（被墙/兵墙彻底卡死）持续 1 秒
          // → 放弃该目标并短期拉黑 2 秒（防止下一帧立即重锁同一个追不到的目标），
          // 回归行军。这是视线检查漏网情形的保底（如目标在收束段墙后极近处）。
          const moved = Math.hypot(minion.pos.x - px, minion.pos.y - py);
          if (moved < speed * dt * 0.15) {
            minion._stuckT = (minion._stuckT || 0) + dt;
            if (minion._stuckT >= 1.0) {
              minion._ignoreTarget = { id: target.id, until: (window.gameTime || 0) + 2 };
              minion.targetId = null;
              minion._stuckT = 0;
            }
          } else {
            minion._stuckT = 0;
          }
        }
        continue;
      }

      // ---- 6. 无目标：回归路径行军 ----
      // Q3：脱战回归不走"原路点回头路"——清空路点索引，_advanceAlongLane 的
      // 最近线段投影初始化会以当前位置重新定位行进段，直接奔向路径上最近的前进点。
      // 未偏离路径的兵不受影响（投影回自己所在段，零回退）。
      minion._anchored = false;
      if (minion._offPath) {
        minion._laneWaypointIndex = undefined;
        minion._offPath = false;
      }
      this._advanceAlongLane(minion, stats, dt);
    }
  }

  /**
   * v37（Q2）：视线检查——两点连线穿过地形墙则不可视。
   * 罚站的根因之一：基地圈附近三条走廊收拢，中路兵隔着丛林楔子"看到"上/下路的敌人
   * （中路夹在两路中间所以最严重），追过去被墙 constrain 钉在走廊边、期望力垂直怼墙。
   * 索敌只锁【可视】目标后此路断绝。采样步长 40px，成本 O(dist/40) 次 isWalkable。
   */
  _hasLineOfSight(ax, ay, bx, by) {
    if (!this.mapSystem.isWalkable) return true;
    const dist = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(dist / 40);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.mapSystem.isWalkable(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  // 单次空间网格局部查询，同时返回：{ nearest: 索敌半径内最近【可视】敌, inRange: 攻击射程内最近敌 }。
  // v37：nearest 带视线检查（按距离排序逐个查，通常第一个就命中；上限查 6 个防极端开销）；
  // inRange（≤攻击射程，很近）默认可视不做检查。
  _scanEnemies(minion, acqRadius, attackRange) {
    const nearby = this.entities.findInRadius(minion.pos.x, minion.pos.y, acqRadius, null, true);
    const candidates = [];
    let inRange = null, inRangeD = attackRange * attackRange;
    const ign = minion._ignoreTarget; // v37：罚站自愈的短期黑名单（追不到的目标暂时不锁）
    const now = window.gameTime || 0;
    for (const other of nearby) {
      if (other.id === minion.id) continue;
      const otherFaction = other._mapFaction || other.faction;
      if (!otherFaction) continue; // 忽略沙盒模式的手动测试单位（无阵营标记）
      if (!canTarget(minion._mapFaction, otherFaction)) continue;
      if (isStructureProtected(this.entities, other)) continue; // 受保护水晶不可选中
      const dx = other.pos.x - minion.pos.x, dy = other.pos.y - minion.pos.y;
      const d = dx * dx + dy * dy;
      if (d < inRangeD) { inRangeD = d; inRange = other; } // 射程内：不吃黑名单也不查视线（贴脸必打）
      if (ign && ign.id === other.id && now < ign.until) continue;
      candidates.push({ e: other, d });
    }
    // 最近【可视】敌：按距离升序逐个做视线检查，通常第一个就命中；上限 6 个防极端开销
    candidates.sort((a, b) => a.d - b.d);
    let nearest = null;
    const lim = Math.min(6, candidates.length);
    for (let i = 0; i < lim; i++) {
      const c = candidates[i];
      if (this._hasLineOfSight(minion.pos.x, minion.pos.y, c.e.pos.x, c.e.pos.y)) { nearest = c.e; break; }
    }
    return { nearest, inRange };
  }

  _advanceAlongLane(minion, stats, dt) {
    const lane = this.mapSystem.getLane(minion._laneId);
    if (!lane || !lane.waypoints || lane.waypoints.length === 0) return;

    const forward = minion._laneDirection !== 'reverse';
    const wps = lane.waypoints;
    let idx = minion._laneWaypointIndex;
    if (idx === undefined) {
      // 首次初始化：按"最近线段投影"确定行进段，而不是盲取端点索引——
      // 中途投放的单位（手动添加/测试投放）盲取端点会掉头走回头路（仿真实测）。
      let bestSeg = 0, bestD = Infinity;
      for (let i = 0; i < wps.length - 1; i++) {
        const ax = wps[i].x, ay = wps[i].y, bx = wps[i + 1].x, by = wps[i + 1].y;
        const vx = bx - ax, vy = by - ay;
        const L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((minion.pos.x - ax) * vx + (minion.pos.y - ay) * vy) / L2));
        const px = ax + t * vx, py = ay + t * vy;
        const d = (minion.pos.x - px) ** 2 + (minion.pos.y - py) ** 2;
        if (d < bestD) { bestD = d; bestSeg = i; }
      }
      idx = forward ? bestSeg + 1 : bestSeg;
    }
    idx = Math.max(0, Math.min(wps.length - 1, idx));

    // 路点跳跃：追击可能把小兵带到了当前路点前方——若已比"当前路点"更接近
    // "下一个路点"，直接推进索引，避免往回走。最多连跳数个（限制防死循环）。
    for (let hop = 0; hop < 4; hop++) {
      const nextIdx = forward ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= wps.length) break;
      const cur = wps[idx], nxt = wps[nextIdx];
      const dCur = (cur.x - minion.pos.x) ** 2 + (cur.y - minion.pos.y) ** 2;
      const dNxt = (nxt.x - minion.pos.x) ** 2 + (nxt.y - minion.pos.y) ** 2;
      if (dNxt < dCur) idx = nextIdx; else break;
    }

    const target = wps[idx];
    const dx = target.x - minion.pos.x, dy = target.y - minion.pos.y;
    const distSq = dx * dx + dy * dy;

    if (distSq < 16) {
      idx = forward ? idx + 1 : idx - 1;
      minion._laneWaypointIndex = Math.max(0, Math.min(wps.length - 1, idx));
      return;
    }
    const dist = Math.sqrt(distSq);
    const mx = dx / dist, my = dy / dist; // 期望前进方向（指向当前路点）
    const speed = stats.moveSpeed || 30;

    // v36（Q5 寻路重做）：行军移动交给统一转向器 _steer——朝路点方向为主，
    // 邻居斥力自然拉开队形、绕过障碍、遇兵墙沿边缘滑动，不再有偏转横跳/抽搐。
    this._steer(minion, mx, my, speed, dt, /*chasing*/false);
    minion._laneWaypointIndex = idx;
  }

  // ==================== v36（Q5）：统一转向器（boids 式连续力模型） ====================
  // 彻底取代 v34/v35 的"切向滑动 + 三态状态机"——那套没有记忆、正对障碍时左右分量对称
  // 归零导致横跳抽搐（用户实测）。新模型是纯连续力合成，天然平滑、天然绕障：
  //   期望力  desire：单位向量指向目标/路点（主驱动）。
  //   分离力  separation：附近单位的斥力，距离越近越强（拉开队形、不叠罗汉）。
  //                       己方非锚定 = 弱斥力（队形）；锚定单位（敌我通吃）= 强斥力+法向截断
  //                       （撞不进兵墙，自然沿其表面滑走）。
  //   合成后归一 × 速度 × dt，再做墙壁约束。没有分支跳变 → 没有抽搐。
  _steer(minion, dirX, dirY, speed, dt) {
    const rSelf = MINION_SIZES[minion.type] || 10;
    let fx = dirX, fy = dirY;         // 期望力（权重 1）
    let sepX = 0, sepY = 0;           // 分离力累加
    let brake = 1;                    // 正前方有同向队友时减速（拉纵队，不追尾）
    let blockerX = 0, blockerY = 0, blocked = false; // v37：最近的正面锚定障碍（绕行用）
    let blockerD = Infinity, blockerRSum = 0, blockerSepX = 0, blockerSepY = 0;
    let yieldX = 0, yieldY = 0;   // v39：互卡死锁的让位力
    const contacts = []; // v37：贴身锚定接触（≤2-3个），位移后做硬圆投影防穿

    const R = rSelf + 34;
    for (const o of this.entities.findInRadius(minion.pos.x, minion.pos.y, R, null, true)) {
      if (o.id === minion.id || !o.pos || o.type === 'tower') continue;
      const sameFac = (o._mapFaction || o.faction) === minion._mapFaction;
      const ox = minion.pos.x - o.pos.x, oy = minion.pos.y - o.pos.y;
      const od = Math.hypot(ox, oy) || 0.001;
      const rSum = rSelf + (MINION_SIZES[o.type] || 10);
      if (od > rSum + 26) continue;

      const ux = ox / od, uy = oy / od;                    // 从邻居指向自己（斥力方向）
      const closeness = Math.max(0, 1 - (od - rSum) / 26);  // 0（刚进范围）→ 1（贴身/重叠）

      // v39（Q2 修复 超级兵绕着目标转圈）：**当前攻击目标永远不算障碍**。
      // 根因：v37 的绕行把"所有锚定单位"一律当静态障碍，于是超级兵冲向【已站定的敌方小兵】
      // 时，目标本身触发法向截断+切向绕行 → 绕着目标转圈，对面近战被同样逻辑带着一起转。
      // 防御塔在本函数开头就被 type==='tower' 跳过，所以打塔/水晶一直正常——正好印证根因。
      if (o.id === minion.targetId) continue;

      if (o._anchored) {
        // 锚定单位（含敌方兵墙）= 硬障碍。
        // v37 调试定稿：法向截断与 blocked 判定统一收进【贴身门】(od < rSum+8)——
        // 之前截断作用于整个扫描半径（rSum+26），造成 32~50px 的"中间死区"：期望力被
        // 截光（res=0）却不算贴身、绕行不激活，B 被钉在扫描边界高频振荡永远近不了身
        //（插桩实测 blk 恒 false、res 0/1 交替、1.2s 零推进）。
        // 现在：远处只留弱斥力自然分流、可以正常靠近；贴身才截断+触发绕行。
        const into = fx * (-ux) + fy * (-uy); // 期望方向朝向障碍的分量
        if (od < rSum + 8) contacts.push({ x: o.pos.x, y: o.pos.y, rSum }); // 注：当前目标已在上面 continue，不会进来
        if (into > 0 && od < rSum + 8) {
          fx += ux * into; fy += uy * into; // 去掉撞入分量（贴边滑）
          if (od < blockerD) {
            blockerD = od; blockerX = -ux; blockerY = -uy; blocked = true;
            blockerRSum = rSum; blockerSepX = ux * closeness * 1.8; blockerSepY = uy * closeness * 1.8;
          }
        }
        // v37 调试定稿：锚定斥力拆两段——贴身 1.8（防穿模+配合绕行），非贴身 0.35。
        // 之前全程 1.8：兵在两个墙兵中缝前方 40px 处，双斥力叠加 1.1+ 压过期望力 1.0，
        // 形成"斥力墙"驻波死锁（插桩实测：位置 6 秒纹丝不动、无绕行触发）。
        const sepK = od < rSum + 8 ? 1.8 : 0.35;
        sepX += ux * closeness * sepK;
        sepY += uy * closeness * sepK;
      } else if (sameFac) {
        // 己方行军队友：弱分离（拉开队形）+ 前方减速（纵队跟随）
        sepX += ux * closeness * 0.7;
      } else {
        // 敌方非锚定单位：轻微分离即可（马上要接敌，不需要强避让）
        sepX += ux * closeness * 0.4;
        sepY += uy * closeness * 0.4;
      }
    }

    // ===== B1：己方防御塔 + 任意损毁塔废墟 = 硬障碍，绕行（转向行为，非碰撞推挤）=====
    // 主循环按 type==='tower' 跳过了所有塔（保持既有兵-兵行为逐位不变）；这里单独把
    // 【己方活塔】与【任意塔废墟】按与锚定硬障碍完全相同的口径并入 fx/sep/blocker/contacts，
    // 于是复用下方 v37 切向绕行 + 硬圆投影：小兵沿塔面滑绕、不再穿模。敌方【活】塔不含
    // （那是索敌/攻击目标，纳入会绕着塔转圈）。塔半径取 bSize；废墟 alive=false，故放开 aliveOnly。
    for (const o of this.entities.findInRadius(minion.pos.x, minion.pos.y, rSelf + 80, ['tower'], false)) {
      if (!o.pos || o.id === minion.targetId) continue;
      const isRuin = !o.alive && !!o._ruin;
      const sameFac = (o._mapFaction || o.faction) === minion._mapFaction;
      if (!(isRuin || (o.alive && sameFac))) continue;
      const ox = minion.pos.x - o.pos.x, oy = minion.pos.y - o.pos.y;
      const od = Math.hypot(ox, oy) || 0.001;
      const rSum = rSelf + (o._modelSize || (CONFIG.buildingSizes && CONFIG.buildingSizes[o._mapTier]) || 28);
      if (od > rSum + 26) continue;
      const ux = ox / od, uy = oy / od;
      const closeness = Math.max(0, 1 - (od - rSum) / 26);
      const into = fx * (-ux) + fy * (-uy);
      if (od < rSum + 8) contacts.push({ x: o.pos.x, y: o.pos.y, rSum });
      if (into > 0 && od < rSum + 8) {
        fx += ux * into; fy += uy * into;
        if (od < blockerD) {
          blockerD = od; blockerX = -ux; blockerY = -uy; blocked = true;
          blockerRSum = rSum; blockerSepX = ux * closeness * 1.8; blockerSepY = uy * closeness * 1.8;
        }
      }
      const sepK = od < rSum + 8 ? 1.8 : 0.35;
      sepX += ux * closeness * sepK;
      sepY += uy * closeness * sepK;
    }

    // ===== v37（Q2 根治"A挡B原地振荡"）：正对障碍时注入带黏性的切向绕行力 =====
    // 机理：法向截断在【正对】障碍时把期望力削到≈0，分离力把兵弹开一点、期望力又推回来
    // ——原地小幅振荡永远不绕（v36 实测）。判据：截断后的剩余期望力太小且确有正面障碍。
    // 绕行力 = 障碍方向的垂线（叉积选侧），选定的侧存到 minion._detourSide【保持 0.8s】
    //（黏性防左右换侧），绕通（不再 blocked）后自然过期清除。
    const now = window.gameTime || 0;
    const residual = Math.hypot(fx, fy);
    // 进入/刷新绕行状态：正面被堵（期望力几乎被截光）
    if (blocked && residual < 0.45) {
      if (!minion._detourSide || now > (minion._detourUntil || 0)) {
        // 叉积定侧：期望方向相对障碍方向偏哪边就绕哪边（平局取 +1）
        const cross = dirX * blockerY - dirY * blockerX;
        minion._detourSide = cross >= 0 ? 1 : -1;
      }
      minion._detourUntil = now + 0.8;
    }
    // v37 调试定稿：绕行力在【窗口期内持续】施加，不要求本帧仍 blocked——
    // 否则绕出两步 residual 回升力就消失、又直冲撞回障碍，形成"绕-撞-绕"踏步
    //（插桩实测：blk true/false 交替、0.6s 仅推进 3px）。窗口内持续切向 → 一口气绕过。
    if (minion._detourSide && now <= (minion._detourUntil || 0)) {
      const bx = blocked ? blockerX : dirX, by = blocked ? blockerY : dirY;
      const tx = -by * minion._detourSide, ty = bx * minion._detourSide;
      fx += tx * 1.2; fy += ty * 1.2; // 主导力：沿障碍边缘切向绕
      if (blocked) {
        // v37 调试定稿：贴身绕行时抵消对 blocker 的【弹开斥力】（1.8 系数的后推与
        // 1.2 切向打架 → B 被弹出贴身区、blocked 断、又冲回——净踏步，插桩实测）。
        // 换成温和的径向定距项：维持 od ≈ rSum+5 贴着障碍表面做圆周绕行。
        sepX -= blockerSepX; sepY -= blockerSepY;
        const err = blockerD - (blockerRSum + 5);
        fx += blockerX * err * 0.06; fy += blockerY * err * 0.06;
      }
    } else if (now > (minion._detourUntil || 0)) {
      minion._detourSide = null;
    }

    // ===== v39（Q3）：向走廊中心线回归（排队感）=====
    // 兵少时把队伍收拢成一列沿中线推进；兵多时 sep 的量级远大于它、自然被压过 → 恢复散开。
    // 只在行军（非追击、非锚定）时施加，避免干扰接敌走位。
    if (!minion._offPath && this.mapSystem.getLane && minion._laneId) {
      const lane = this.mapSystem.getLane(minion._laneId);
      if (lane) {
        const n = this.mapSystem._nearestOnLane(lane, minion.pos.x, minion.pos.y);
        if (n && n.dist > 6) {
          const cx = (n.px - minion.pos.x) / n.dist, cy = (n.py - minion.pos.y) / n.dist;
          const w = Math.min(0.5, n.dist / 140) * 0.55; // 越偏离中线拉得越紧，上限温和
          fx += cx * w; fy += cy * w;
        }
      }
    }

    // 合成：期望 + 分离 + 让位
    let vx = fx + sepX + yieldX, vy = fy + sepY + yieldY;
    const vl = Math.hypot(vx, vy) || 1;
    vx /= vl; vy /= vl;

    // ===== v39（Q3）：转向低通平滑——消除视觉抖动 =====
    // 逐帧合力方向的小幅跳变会被眼睛读成"抽搐"。这里限制每帧转向角速度（约 12 rad/s），
    // 只改【朝向】不改速度大小，所以不影响到位时间与任何战斗判定。
    const prev = minion._steerDir;
    if (prev) {
      const maxTurn = 12 * dt;
      const cross = prev.x * vy - prev.y * vx;
      const dot = Math.max(-1, Math.min(1, prev.x * vx + prev.y * vy));
      const ang = Math.acos(dot);
      if (ang > maxTurn) {
        const s2 = Math.sign(cross) || 1;
        const ca = Math.cos(maxTurn * s2), sa = Math.sin(maxTurn * s2);
        const rx = prev.x * ca - prev.y * sa, ry = prev.x * sa + prev.y * ca;
        vx = rx; vy = ry;
      }
    }
    minion._steerDir = { x: vx, y: vy };

    // 位移 + 墙壁约束（不出走廊）
    const stepX = vx * speed * brake * dt, stepY = vy * speed * brake * dt;
    minion.pos.x += stepX;
    minion.pos.y += stepY;
    // v39（Q3）：撞墙沿墙滑行——越界被钳回后，把"撞进墙"的法向分量从本帧位移里剔除，
    // 保留切向分量重新走一遍 → 贴着墙面滑过去，而不是每帧被推回同一点原地磨。
    const hit = this.mapSystem.constrainToWalkable?.(minion.pos);
    if (hit && hit.nx !== undefined) {
      const into = stepX * hit.nx + stepY * hit.ny; // 位移中朝墙里的分量
      if (into < 0) {
        const tx = stepX - hit.nx * into, ty = stepY - hit.ny * into;
        minion.pos.x += tx; minion.pos.y += ty;
        this.mapSystem.constrainToWalkable?.(minion.pos); // 切向滑动后再钳一次（拐角安全）
      }
      minion._steerDir = null; // 撞墙后重置转向平滑基准，避免沿墙时被角速度限制拖住
    }
    // v37 防穿硬约束：锚定单位 = 真正的硬圆。位移后若与贴身锚定接触重叠，
    // 沿法向投影回表面——绕行只能【沿表面滑】，永远无法从缝隙里被逐帧渗透挤穿
    //（v34 全宽兵墙测试实测：间距19<直径22 的理论无缝墙被切向力+碰撞弱推慢慢钻透）。
    for (const c of contacts) {
      const cdx = minion.pos.x - c.x, cdy = minion.pos.y - c.y;
      const cd = Math.hypot(cdx, cdy) || 0.001;
      if (cd < c.rSum) {
        minion.pos.x = c.x + (cdx / cd) * c.rSum;
        minion.pos.y = c.y + (cdy / cd) * c.rSum;
      }
    }
    this.mapSystem.constrainToWalkable?.(minion.pos); // 硬圆投影后可能又出界，最后兜一次
  }

  // ==================== v34（Q3）：锚定落位（一次性） ====================

  /**
   * 锚定瞬间的一次性落位：若当前位置与已锚定的同伴重叠，沿"以目标为圆心的攻击弧"
   * 左右交替搜索最近空位（最多 ±5 步，每步一个身位）；找不到就原地锚定（容忍重叠）。
   * 只在 _anchored 置位的那一刻调用一次——之后位置冻结（LoL：攻击者到位后站死）。
   */
  _findAnchorSlot(minion, target, range) {
    const rSelf = MINION_SIZES[minion.type] || 10;
    const overlapAt = (x, y) => {
      for (const o of this.entities.findInRadius(x, y, rSelf * 3, null, true)) {
        if (o.id === minion.id || !o._anchored || !o.pos) continue;
        const rSum = rSelf + (MINION_SIZES[o.type] || 10);
        if ((o.pos.x - x) ** 2 + (o.pos.y - y) ** 2 < (rSum * 0.92) ** 2) return true;
      }
      return false;
    };
    if (!overlapAt(minion.pos.x, minion.pos.y)) return; // 不挤，原地即是好位
    // v41: COMBAT_LOCK - never teleport to slot; stay in place, let CollisionSystem handle
  }

}
