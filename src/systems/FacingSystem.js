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
   * 期望方向的优先级：
   *   ① 有存活目标 → 朝目标（这才产生"必须转过来才能打"）
   *   ② 否则朝这一帧的实际位移方向（走向即朝向）
   *   ③ 都没有 → 保持不动（站着不该原地乱转）
   * 位移阈值用平方比较，且刻意留了一个死区：模拟 30Hz、渲染 60Hz，
   * 半数帧位移为 0，没有死区的话朝向会在"有位移/无位移"之间抖。
   */
  update(dt) {
    if (CONFIG.tuning?.facing?.enabled === false) return;
    for (const e of this.entities.getAll(true)) {
      if (facingExempt(e) || !e.pos) continue;
      const p = facingParams(e);

      let want;
      const tgt = e.targetId ? this.entities.get(e.targetId) : null;
      if (tgt && tgt.alive && tgt.pos) {
        want = angleTo(e.pos, tgt.pos);
      } else if (e._faceLastX !== undefined) {
        const dx = e.pos.x - e._faceLastX, dz = e.pos.y - e._faceLastZ;
        if (dx * dx + dz * dz > 0.25) want = Math.atan2(dx, dz);
      }
      e._faceLastX = e.pos.x; e._faceLastZ = e.pos.y;

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
