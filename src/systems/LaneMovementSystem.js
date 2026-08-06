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
// navgrid 地形（野区可走）后的行军纪律（用户定稿）：小兵【不主动进野区】，被挤进/带偏后也要
// 尽快回到本路兵线继续向敌方推进。偏离中线超过 LANE_KEEP 起，回归力线性增强到压过前进期望力。
const LANE_KEEP = 150;      // 容许的离线距离（≈走廊半宽），以内只有原来的温和排队力
const LANE_SPAN = 200;      // 从 LANE_KEEP 到满强度的过渡跨度
const LANE_BACK_K = 1.6;    // 满强度权重（> 期望力 1.0 → 先回兵线再谈推进）

// ==================== Q1：地形避障（预判式触须）====================
// 此前地形是【纯反应式】的：先走进墙里，再由 constrainToWalkable 钳回来、把法向分量剔掉沿墙滑。
// 在 navgrid 的凹角（尤其上/下路那两个圆弧拐角）这套会来回抖：钳回→再撞→再钳，净推进≈0。
// 实测一局 5 分钟有 2~12 个小兵各卡 5s 以上，位置全部落在两个拐角，且 isWalkable 为真
//（说明不是穿模，是走不出去）。
// 现在改成【先探后走】：沿前进方向撒一组触须采样 isWalkable，正前方被挡就朝更开阔的一侧
// 注入切向力，侧向被挡就向反侧轻推 —— 于是拐角处提前转弯，而不是撞上去再蹭。
// 做法是【最小偏转扫描】而不是"撒触须各加一个力"：后者试过，正前方探针只要蹭到墙就注入
// 强切向力，而 navgrid 的兵线两侧全是野区墙 —— 沿墙正常行军也会被判成"正面被挡"，
// 小兵于是横着蟹步、推进反而更差（实测卡死数 2~12 → 21~23）。
// 现在：先看期望方向通不通，通就【什么都不做】（零副作用）；不通才从小到大试偏转角，
// 取第一个整条射线都可走的方向，即"够用就好"的最小转向。全部偏转角都不通才退化为贴墙切向。
const TERRAIN_LOOK = 2.4;        // 前瞻距离 = (自身半径 + 30) × 本倍率
const TERRAIN_PROBE = 30;
const TERRAIN_STEPS = 4;         // 每条射线的采样点数（避免漏掉薄墙）
const TERRAIN_FAN = [18, 36, 54, 72, 90];  // 依次尝试的偏转角（度），左右同时试
const TERRAIN_K = 1.3;           // 转向力权重（略大于期望力 1.0，转得动又不至于压掉回归力）
const TERRAIN_HOLD = 0.5;        // 绕行侧黏性（秒），防左右反复换边
// 卡死看门狗：行军中长时间几乎没位移 → 强制换一侧重新绕
const STUCK_T = 1.2;             // 观察窗口（秒）
const STUCK_D = 14;              // 窗口内的最小位移（px）
// 兵线回流场：距路面超过这么多格才接管前进方向（1~2 格属正常贴边行军，不该被接管）
const LANE_FLOW_MIN_STEPS = 2;
// v39 互卡死锁让位：两个行军单位贴身对顶时，靠 id 比大小产生确定性的不对称来解锁。
const DEADLOCK_GAP = 6;    // 贴身判据：间距小于 半径和 + 本值 才算对峙
const DEADLOCK_DOT = 0.6;  // 双方"朝着对方"的方向余弦阈值（越大越只认正面顶牛）
const YIELD_K = 0.9;       // 让位力权重（略小于期望力 1.0：让路但不放弃推进）

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
      // v43 Q4：索敌半径不能小于自己的攻击射程。攻城车射程 312 > ACQUISITION_RANGE(200)，
      // 旧写法把它的索敌硬砍到 200 —— 它必须先走进 200px 才"看得见"塔，
      // 312 的越塔射程完全作废，表现出来就是"攻城模式好像没生效"。
      const acqR = Math.max(ACQUISITION_RANGE, range);
      const scan = AISystem.scanEnemies(this.entities, this.mapSystem, minion, acqR, range);

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
            let finalAS = this.attrCalc.calcAttackSpeedOf(stats);   // v43 Q7：走属性表，不读原始模板值
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
    //
    // ⚠️ 这一条【在急转弯处永远不会触发】。它比的是"离哪个路点近"，也就是以
    // wp[i] 与 wp[i+1] 的**垂直平分线**为界。转角平缓时（峡谷最大转角 16°）
    // 沿行进方向越过 wp[i] 基本就同时越过了那条线，所以一直好用；
    // 但扭曲丛林在基地口有个 84° 的弯，沿来向越过 wp[i] 之后离 wp[i+1] 反而更远，
    // 想跳多远都跳不了 —— 只能靠下面"距路点 4px"那一条来推进索引。
    // 而小兵一帧只走 speed×dt ≈ 3.9px，4px 的到达圈比一步还小，稍有推挤就踩不中，
    // 于是绕着转角那个点无限打转（实测：路程 11738px、净位移 465px、150 秒不推进一格）。
    // 所以补一条与转角无关的判据：**沿来向越过该路点所在的平面**就算到达。
    const passedWaypoint = (i) => {
      const prevIdx = forward ? i - 1 : i + 1;
      if (prevIdx < 0 || prevIdx >= wps.length) return false;
      const w = wps[i], pv = wps[prevIdx];
      const ax = w.x - pv.x, ay = w.y - pv.y;          // 来向（上一段的方向）
      const L = Math.hypot(ax, ay) || 1;
      // 越过 = 位置相对该路点在来向上的投影为正
      return ((minion.pos.x - w.x) * ax + (minion.pos.y - w.y) * ay) / L > 0;
    };
    for (let hop = 0; hop < 4; hop++) {
      const nextIdx = forward ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= wps.length) break;
      const cur = wps[idx], nxt = wps[nextIdx];
      const dCur = (cur.x - minion.pos.x) ** 2 + (cur.y - minion.pos.y) ** 2;
      const dNxt = (nxt.x - minion.pos.x) ** 2 + (nxt.y - minion.pos.y) ** 2;
      if (dNxt < dCur) { idx = nextIdx; continue; }
      // 到达圈：至少要能装下一帧的位移，否则"踩不中"。半径软编码，
      // 且只在【已越过该路点】时才认——不加这个前提会在路点前方提前拐弯、抄内角。
      //
      // ⚠️ 还必须【加上这个路点被建筑吃掉的那一截】—— 用户报的"扭曲丛林上路还是转圈、
      // 下路不会"就是这里。两张新图的塔压在兵线上：上路 wp8(1104,336) 离蓝方外塔(1085,328)
      // 只有 21px，而塔的避障半径 35（28 × towerVizScale 1.25）加小兵自己 10 = 45，
      // 小兵最近只能站到离路点 45−21 = 24px 处 —— **正好等于到达半径，永远踩不中**。
      // 于是索引死在 8，期望方向永远指着塔肚子里那个够不着的点，绕着塔画圆
      //（实测 150 秒路程 9068px、净位移 534px，轨迹是圆心 (1920,327)、半径 51 的正圆，
      //  圆心就是那座塔）。下路是 24px（45−24 = 21 < 24，够得着）所以不犯 ——
      // "上路会下路不会"这三个字就是这么来的。
      // lane._wpBlock[i] = 建筑半径 − 圆心距（loadMap 时算好，见 MapSystem._computeWaypointBlock）。
      const arriveR = (CONFIG.tuning?.waypointArriveRadius ?? 24)
        + Math.max(0, (lane._wpBlock?.[idx] ?? -Infinity) + (MINION_SIZES[minion.type] || 10));
      if (dCur < arriveR * arriveR && passedWaypoint(idx)) { idx = nextIdx; continue; }
      break;
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
    let mx = dx / dist, my = dy / dist; // 期望前进方向（指向当前路点）
    // Q1：人不在路面上时，"直奔下一个路点"是错的——路点方向多半指着一堵野区墙，
    // 兵会顶着凹壁磨到死（实测中路凹角 30s 推进 10px）。这时改用兵线回流场的下山方向：
    // 那是 navgrid 上真正走得通的回家路线，先照它走回路面，回到路面场值归零后自动恢复原逻辑。
    const flow = window.__laneFlow === false ? null
               : this.mapSystem.laneFlowDir?.(minion._laneId, minion.pos.x, minion.pos.y);
    if (flow && flow.steps > LANE_FLOW_MIN_STEPS) { mx = flow.x; my = flow.y; }
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
    let enemyNear = false;            // 扫描半径内有没有敌方单位（走廊回归力据此让位）
    let sepX = 0, sepY = 0;           // 分离力累加
    let brake = 1;                    // 正前方有同向队友时减速（拉纵队，不追尾）
    let blockerX = 0, blockerY = 0, blocked = false; // v37：最近的正面锚定障碍（绕行用）
    let blockerD = Infinity, blockerRSum = 0, blockerSepX = 0, blockerSepY = 0;
    let yieldX = 0, yieldY = 0;   // v39：互卡死锁的让位力
    let deadlock = null, deadlockD = Infinity;   // 互卡对峙的那个邻居（取最近的一个）
    const contacts = []; // v37：贴身锚定接触（≤2-3个），位移后做硬圆投影防穿

    const R = rSelf + 34;
    for (const o of this.entities.findInRadius(minion.pos.x, minion.pos.y, R, null, true)) {
      if (o.id === minion.id || !o.pos || o.type === 'tower') continue;
      const sameFac = (o._mapFaction || o.faction) === minion._mapFaction;
      const ox = minion.pos.x - o.pos.x, oy = minion.pos.y - o.pos.y;
      const od = Math.hypot(ox, oy) || 0.001;
      const rSum = rSelf + (MINION_SIZES[o.type] || 10);
      // 附近有没有敌人 —— 下面的"走廊中心线回归"要据此让位（见那一段的注释）。
      // 判定放在 rSum+26 的早退【之前】：接敌前就得让位，等贴上了才让已经晚了。
      if (!sameFac) enemyNear = true;
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

      // v39：互卡死锁检测 —— 两个都在行军的单位【贴身且互相顶着对方走】时，
      // 纯分离力是对称的，双方原地互推谁也过不去。这里挑出这种对峙。
      // 判据：我朝着它、它也朝着我（用它上一帧的转向方向），且已经贴身。
      if (!o._anchored && od < rSum + DEADLOCK_GAP) {
        const intoO = fx * (-ux) + fy * (-uy);              // 我的期望方向指向它的分量
        const od2 = o._steerDir;
        const intoMe = od2 ? (od2.x * ux + od2.y * uy) : 0;  // 它的转向方向指向我的分量
        if (intoO > DEADLOCK_DOT && intoMe > DEADLOCK_DOT && od < deadlockD) {
          deadlockD = od; deadlock = o;
        }
      }
    }

    // v39：互卡死锁的让位力。对称的力解不开对称的僵局，必须引入一个【确定性的不对称】——
    // 用 id 比大小决定谁让（minion.id > o.id 的那个横向侧移），保证：
    //   ① 双方结论必然相反（不会两个都让或都不让）；
    //   ② 不依赖随机数，回放/测试可复现。
    if (deadlock) {
      const dx2 = minion.pos.x - deadlock.pos.x, dy2 = minion.pos.y - deadlock.pos.y;
      const dl = Math.hypot(dx2, dy2) || 1;
      // 让位方向 = 连线的垂线。取哪一侧同样按 id 定，两人才会往【同一侧】错身而过，
      // 否则各让各的反而继续对撞。
      const side = (minion.id + deadlock.id) % 2 ? 1 : -1;
      if (minion.id > deadlock.id) {
        yieldX = -dy2 / dl * side * YIELD_K;
        yieldY = dx2 / dl * side * YIELD_K;
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
      // Q4：半径必须乘上塔模型的【视觉放大系数】。渲染层把塔/废墟画大了 1.25×（水晶 1.10×），
      // 而这里一直按未放大的尺寸算，于是小兵贴到"逻辑表面"时早已插进模型里 —— 就是穿模。
      const vz = (CONFIG.towerVizScale || {});
      const k = vz[o._mapTier] ?? vz.default ?? 1;
      const rSum = rSelf + (o._modelSize || (CONFIG.buildingSizes && CONFIG.buildingSizes[o._mapTier]) || 28) * k;
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
    // ⚠️ 用户报的"小兵非要严格绕着他的圆边缘走"就出在下面这段。
    // 真因是**绕行状态只有【超时 0.8s】才退出** —— 已经绕过障碍了还在继续吃切向力，
    // 于是又贴着圆周多走大半圈。修法：**绕通了立刻退出**（见下面的 !blocked 分支）。
    //
    // 我一开始怀疑的是那个径向定距项（`err = blockerD − (blockerRSum+5)`，
    // 注释原话"维持 od ≈ rSum+5 贴着障碍表面做圆周绕行"）—— **判断错了，它不能删**：
    //   · 只删它、不加"绕通即退出"：合成用例照样过（说明它不是贴边的主因）
    //   · 删了它之后 sim_v34「确实是绕过而非穿过」当场红（最大横向偏移 88 < 墙半宽 123.5）
    //     —— 沿墙滑到端头绕过去，靠的正是这一项把兵**贴着**墙面推过去。
    // 也就是说：贴着障碍滑是**兵墙场景需要的能力**，问题只在于绕过去之后不肯松手。
    if (minion._detourSide && now <= (minion._detourUntil || 0)) {
      // 绕通判据：期望方向已经不再撞进障碍（正面无锚定障碍，或期望力没被截光）。
      // 这一条让"绕过去"立刻结束绕行，而不是等 0.8s 窗口自然过期。
      if (!blocked) {
        minion._detourSide = null;
        minion._detourUntil = 0;
      } else {
        const tx = -blockerY * minion._detourSide, ty = blockerX * minion._detourSide;
        fx += tx * 1.2; fy += ty * 1.2; // 主导力：沿障碍切向绕
        // 抵消对 blocker 的【弹开斥力】（1.8 系数的后推与 1.2 切向打架 →
        // 兵被弹出贴身区、blocked 断、又冲回，净踏步，v37 插桩实测）。
        sepX -= blockerSepX; sepY -= blockerSepY;
        const err = blockerD - (blockerRSum + 5);
        fx += blockerX * err * 0.06; fy += blockerY * err * 0.06;
      }
    } else if (now > (minion._detourUntil || 0)) {
      minion._detourSide = null;
    }

    // ===== 向走廊中心线回归（排队感）=====
    // 兵少时把队伍收拢成一列沿中线推进；兵多时 sep 的量级远大于它、自然被压过 → 恢复散开。
    // 只在行军（非追击、非锚定）时施加，避免干扰接敌走位。
    //
    // ==================== Q6：这段力原来太弱 ====================
    // 用户观察到"上路乖乖排队、中/下路散开"。量出来的直接原因是**路点间距**：
    // _advanceAlongLane 的期望方向是"指向当前路点"，横向偏移只在经过路点时才被顺带纠正。
    // 实测三路段长：上路/下路 10 段（两头 2100 + 中间八段 135~300），中路只有 1 段（4131）。
    // 中路目标永远是那个远端点 → 绕塔产生的偏移永远得不到纠正；上/下路走在中间密集段时
    // 下一个路点很近，立刻被拉回纵队。所以"哪一路乖"取决于当前推到了哪一段。
    //
    // 而这段回归力本该兜住它，却兜不住：原来的权重是 min(0.5, dist/140) × 0.55，
    // **上限只有 0.275**，在典型的 20~50px 偏移处只有 0.08~0.20 —— 远不足以对抗
    // 分离力，于是偏移就那么留着了。现在权重进 CONFIG.tuning.laneCentering，实测调档。
    //
    // ⚠️ 必须在【附近有敌人】时让位。第一版没让位，结果居中力（要把兵拉到中线）
    // 和分离力（要保持 20~30px 横向间距）在接敌瞬间对着挤，把兵从对手身边挤过去 ——
    // tests/sim_passthrough.mjs 的"零未接敌穿越"从 0 变成 7。行军纪律该在交火时让位于交火。
    const _lc = CONFIG.tuning?.laneCentering || {};
    // 排队力的三个让位条件。每一条都是踩出来的，不是预防性写的：
    //  ① enemyNear —— 不让位会和分离力对着挤，把兵从对手身边挤过去
    //     （sim_passthrough 的"零未接敌穿越" 0 → 7）。
    //  ② blocked  —— 正面有锚定障碍（兵墙/废墟）时正在绕行，居中力会把兵拽回被堵的中线，
    //     于是绕不过去（sim_wall 的"近战全部越过兵墙" 6/6 → 5/6）。
    //  ③ _detourSide —— 绕行黏性期内同理，别在半路把它拽回来。
    // 共同的道理：**居中力是行军纪律，一旦在处理眼前的事就该让位。**
    const _lcOn = _lc.enabled !== false && !enemyNear && !blocked && !minion._detourSide;
    if (!minion._offPath && this.mapSystem.getLane && minion._laneId) {
      const lane = this.mapSystem.getLane(minion._laneId);
      if (lane) {
        const n = this.mapSystem._nearestOnLane(lane, minion.pos.x, minion.pos.y);
        const dead = _lc.deadZone ?? 6;
        if (n && n.dist > dead) {
          // Q1：回归方向优先走【兵线回流场】——沿地形真能走回去的那条路。
          // 直线拉回（下面的 fallback）在凹形口袋里指的是墙，兵只会顶着凹壁磨；
          // 回流场是 navgrid 上到本路的 BFS 距离场，下山方向天然绕开地形，
          // 只要口袋与兵线连通就一定出得来。回到走廊附近后场值为 0、自动退回直线拉。
          const flow = (n.dist > 40 && window.__laneFlow !== false)
                     ? this.mapSystem.laneFlowDir?.(minion._laneId, minion.pos.x, minion.pos.y) : null;
          const cx = flow ? flow.x : (n.px - minion.pos.x) / n.dist;
          const cy = flow ? flow.y : (n.py - minion.pos.y) / n.dist;
          // 排队力：接敌时归零（让位）；否则按 偏移/rampTo 线性升到满权重。
          // 斜坡从 0 起算（不减死区）——这样默认参数与 v39 原式 **逐位等价**：
          //   原式 min(0.5, d/140) × 0.55  ==  0.275 × min(1, d/70)
          // 于是"默认不改行为、调了才改"是可证明的，而不是"看起来差不多"。
          let w = _lcOn
            ? (_lc.weight ?? 0.275) * Math.min(1, n.dist / Math.max(1, _lc.rampTo ?? 70))
            : 0;
          // 野区回归：navgrid 让野区可走，小兵可能被挤进野区、或想抄近道斜穿。这里在偏离
          // 超过 LANE_KEEP 后把回归力抬到压过期望力，于是【不主动进野区、进了也尽快出来】。
          // 这一段**不受接敌让位影响**：跑进野区是要纠正的错误位置，不是交火走位。
          if (n.dist > LANE_KEEP) w += Math.min(1, (n.dist - LANE_KEEP) / LANE_SPAN) * LANE_BACK_K;
          if (w > 0) { fx += cx * w; fy += cy * w; }
        }
      }
    }

    // ===== Q1：地形避障 —— 放在合成前，让它和其它转向力一起参与归一化 =====
    const terr = this._terrainAvoid(minion, fx, fy, rSelf, now);
    if (terr) { fx += terr.x; fy += terr.y; }

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

  /**
   * Q1：预判式地形避障。沿【当前合力方向】撒触须采样 isWalkable，返回一个避让力（或 null）。
   *
   *   · 正前方触须（前瞻 TERRAIN_LOOK 倍长）被挡 → 朝更开阔的一侧注入切向力 TERRAIN_TURN。
   *     侧别由左右触须的通畅数投票决定，并在 _terrSide 上黏 TERRAIN_HOLD 秒，防止逐帧换边抖动。
   *   · 侧向触须被挡 → 向反侧轻推 TERRAIN_SIDE，形成平滑的贴墙滑行（不必等撞上）。
   *   · 看门狗：行军中 STUCK_T 秒内位移不足 STUCK_D → 强制翻到另一侧重绕，
   *     破掉"两侧同样窄、投票平局"造成的对称死锁。
   *
   * 只读 isWalkable，不改任何单位状态（除自身的绕行侧/进度缓存），
   * 无墙地图 hasWalls() 为假时整段短路 → 沙盒与嚎哭深渊行为完全不变。
   */
  _terrainAvoid(minion, dirX, dirY, rSelf, now) {
    const ms = this.mapSystem;
    if (window.__terrainAvoid === false) return null;      // 设置里可关（A/B 对照用）
    if (!ms.isWalkable || !ms.hasWalls?.()) return null;
    const L = Math.hypot(dirX, dirY);
    if (L < 1e-4) return null;
    const dx = dirX / L, dy = dirY / L;
    const reach = (rSelf + TERRAIN_PROBE) * TERRAIN_LOOK;
    const px = minion.pos.x, py = minion.pos.y;
    // 整条射线可走才算通（只测端点会漏掉夹在中间的薄墙）
    const clear = (ux, uy) => {
      for (let s = 1; s <= TERRAIN_STEPS; s++) {
        const d = reach * s / TERRAIN_STEPS;
        if (!ms.isWalkable(px + ux * d, py + uy * d)) return false;
      }
      return true;
    };

    // ---- 看门狗：行军中长时间没位移 → 这一帧强制换边重绕 ----
    let forceFlip = false;
    const pr = minion._terrProg;
    if (!pr || now < pr.t) {
      minion._terrProg = { x: px, y: py, t: now };
    } else if (now - pr.t >= STUCK_T) {
      if (Math.hypot(px - pr.x, py - pr.y) < STUCK_D) forceFlip = true;
      minion._terrProg = { x: px, y: py, t: now };
    }

    // ---- 期望方向本身通畅：不干预（沿墙正常行军不该被打扰）----
    if (clear(dx, dy) && !forceFlip) {
      if (now > (minion._terrUntil || 0)) minion._terrSide = 0;
      return null;
    }

    // ---- 最小偏转扫描：从小角度往大角度试，先试上次选定的一侧（黏性）----
    const sticky = (minion._terrSide && now <= (minion._terrUntil || 0)) ? minion._terrSide : 0;
    let prefer = sticky || ((minion.id % 2) ? 1 : -1);
    if (forceFlip) prefer = -prefer;                        // 卡死 → 换另一侧
    for (const deg of TERRAIN_FAN) {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      for (const side of [prefer, -prefer]) {
        const ss = s * side;
        const ux = dx * c - dy * ss, uy = dx * ss + dy * c;
        if (!clear(ux, uy)) continue;
        minion._terrSide = side;
        minion._terrUntil = now + TERRAIN_HOLD;
        return { x: ux * TERRAIN_K, y: uy * TERRAIN_K };
      }
    }
    // ---- ±90° 内全被挡：退化为贴墙切向，至少沿墙挪动而不是顶着墙磨 ----
    minion._terrSide = prefer;
    minion._terrUntil = now + TERRAIN_HOLD;
    return { x: -dy * prefer * TERRAIN_K, y: dx * prefer * TERRAIN_K };
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
