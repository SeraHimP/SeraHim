import { CONFIG } from '../data/Config.js';

/**
 * FacingSystem.js —— 朝向与转身（v45）
 *
 * 用户定稿："所有单位（除了塔）攻击的时候只能攻击面朝正面的敌人，否则需要转动来
 * 攻击其他方向的敌人，行走的时候也是根据面朝的方向走的。"
 * 追加确认：**走向即朝向，不限制移动**——只有【攻击】受扇形限制，寻路照旧。
 *
 * ==================== 为什么单独一个系统 ====================
 * 朝向此前**只存在于渲染层**：UnitLayer 每帧拿位置增量 atan2 出一个角度，自己插值。
 * 那份角度模拟层根本看不见，所以"必须转过来才能打"无法用它实现 —— 真按它判，
 * 无头模式（tests / balance_matrix）里连朝向都不存在，规则会在最需要它的地方消失。
 *
 * 所以朝向必须**下沉到模拟层**：`entity._facing`（弧度，模型正面朝 +Z，与几何一致）
 * 由本系统维护，渲染层改成**读**它。一个量一个来源 —— 本仓库反复出事的形状就是
 * 同一个量在两处各算一份（昼夜相位、龙坑、攻城锁定都栽过）。
 *
 * ==================== 为什么塔豁免 ====================
 * 用户明说"除了塔"。水晶/枢纽在本项目里同样是 type='tower'，一并豁免 ——
 * 它们没有"正面"这个概念，硬给一个只会让最外圈的塔在开局前 0.8 秒打不出伤害。
 *
 * ==================== 时序 ====================
 * 本系统在 stepSimulation 里排在**移动之后、下一帧战斗之前**，于是：
 *   ① 转身用的是这一帧最新的位置；
 *   ② 攻击门用的是上一帧算完的朝向 —— 差一帧（1/30 秒），换来的是不必把
 *      朝向计算塞进两条攻击路径里各写一遍。
 * "刚锁定新目标的那一下打不出去"正是**要的**行为（转身前摇）。
 */

/** 塔（含水晶/枢纽）豁免；其余一切单位（含龙）都受朝向约束。 */
export function facingExempt(e) {
  return !e || e.type === 'tower';
}

/** 当前生效的朝向参数。逐单位可被模板里的同名字段覆写（软编码硬约束）。 */
export function facingParams(e = null) {
  const g = CONFIG.tuning?.facing || {};
  const b = e?.baseStats || {};
  return {
    enabled: g.enabled !== false,
    arcDeg: b.attackArcDeg ?? g.arcDeg ?? 35,        // 半角：目标必须落在 ±arcDeg 内
    turnRateDeg: b.turnRateDeg ?? g.turnRateDeg ?? 220,  // 度/秒
  };
}

/** 把角度归一化到 (-π, π]。 */
export function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** 从 from 指向 to 的朝向角（与几何约定一致：模型正面朝 +Z，故用 atan2(dx, dz)）。 */
export function angleTo(from, to) {
  return Math.atan2(to.x - from.x, to.y - from.y);
}

/**
 * 这个攻击者当前能不能打到这个目标（**只判朝向**，射程/敌我另有判定）。
 *
 * 攻击路径必须走这个函数，不要各自算一遍角差 —— 两条攻击路径
 *（LaneMovementSystem 的对战路 / CombatSystem 的沙盒路）历史上就是因为
 * "同一条规则各写一半"反复出事（攻城模式那次最典型）。
 */
export function canFire(attacker, target) {
  if (!attacker || !target || !attacker.pos || !target.pos) return true;
  if (facingExempt(attacker)) return true;
  const p = facingParams(attacker);
  if (!p.enabled) return true;
  if (attacker._facing === undefined) return true;   // 还没跑过一帧：不卡第一下
  const d = Math.abs(wrapPi(angleTo(attacker.pos, target.pos) - attacker._facing));
  return d <= p.arcDeg * Math.PI / 180;
}

export class FacingSystem {
  constructor(entityContainer) {
    this.entities = entityContainer;
  }

  /**
   * 每帧把所有非塔单位的 _facing 朝"期望方向"转 turnRate×dt。
   *
   * ==================== 优先级：在走就朝着走的方向（v45b 修正）====================
   * 第一版把**朝目标**排在第一位、朝移动方向排第二。用户实测："兵现在会出现
   * 原地漂移/转圈的问题"，并指出就是加了转向之后才有的。
   *
   * 用无头探针量出来的结果很干脆：318 个兵里 **301 个**在某一刻"面朝方向与实际移动
   * 方向夹角 > 60°"，最大 180° —— 也就是**倒着走**。原因就是那个优先级：
   * 一个已经锁定目标、但还在移动的兵（追击、落位、被挤开、绕障）会一边朝着目标、
   * 一边往别处走，看起来就是横着滑/倒着滑。混战团里几十个兵一起这么滑，
   * 就是用户说的"原地漂移/转圈"。
   *
   * 现在反过来：**只要在移动就朝着移动方向**，只有站定时才朝目标。
   * 这既符合直觉（人走路时脸朝前，停下来才转向对手），也保住了"必须转过来才能打"——
   * 兵停下来打人的那一刻才开始转，转到位才开火。
   *
   * ⚠️ "在不在移动"**不能**用单帧位移判断：碰撞每帧会把兵推 0~2px，方向近乎随机，
   * 按单帧判会让站桩的兵朝着随机方向乱转（换一种打转而已）。
   * 所以用位移的**指数滑动平均**：随机抖动会互相抵消趋近 0，真实行军则稳定累积。
   */
  update(dt) {
    if (CONFIG.tuning?.facing?.enabled === false) return;
    const g = CONFIG.tuning?.facing || {};
    const alpha = g.velEmaAlpha ?? 0.25;      // EMA 系数：越小越平滑、响应越慢
    const eps = g.moveEpsPx ?? 0.6;           // 平滑后每帧位移超过这么多 px 才算"在走"
    const eps2 = eps * eps;
    for (const e of this.entities.getAll(true)) {
      if (facingExempt(e) || !e.pos) continue;
      const p = facingParams(e);

      // ---- 平滑速度（像素/帧）----
      if (e._faceLastX !== undefined) {
        const dx = e.pos.x - e._faceLastX, dz = e.pos.y - e._faceLastZ;
        e._faceVX = (e._faceVX || 0) * (1 - alpha) + dx * alpha;
        e._faceVZ = (e._faceVZ || 0) * (1 - alpha) + dz * alpha;
      }
      e._faceLastX = e.pos.x; e._faceLastZ = e.pos.y;

      let want;
      const vx = e._faceVX || 0, vz = e._faceVZ || 0;
      if (vx * vx + vz * vz > eps2) {
        want = Math.atan2(vx, vz);                       // ① 在走 → 朝着走的方向
      } else {
        const tgt = e.targetId ? this.entities.get(e.targetId) : null;
        if (tgt && tgt.alive && tgt.pos) want = angleTo(e.pos, tgt.pos);  // ② 站定 → 朝目标
      }
      // ③ 都没有 → 保持最后一次的期望方向继续转完。
      // 不记的话会**转到一半冻住**：一个刚起步又立刻停下的单位（被挡、被锚定）会永远歪着。
      // 是 sim_v46「朝⑧」抓到的。
      if (want !== undefined) e._faceWant = want;
      else want = e._faceWant;

      if (e._facing === undefined) {
        // 入场即面向期望方向，不从 0（正北）转过去 —— 否则每个新兵一出生
        // 都要先原地转半圈，看起来像是集体犯迷糊。
        e._facing = want ?? 0;
        continue;
      }
      if (want === undefined) continue;
      const diff = wrapPi(want - e._facing);
      const step = p.turnRateDeg * Math.PI / 180 * dt;
      e._facing = wrapPi(Math.abs(diff) <= step ? want : e._facing + Math.sign(diff) * step);
    }
  }
}
