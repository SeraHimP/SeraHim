import { MINION_SIZES, CONFIG } from '../data/Config.js';

/**
 * CollisionSystem.js（v34 第三次重做——LoL 对齐版）
 *
 * 症状史：
 *   v1 柔化互推 → 混战团单调膨胀（外圈无回拉力，兵源流入持续注入能量）；
 *   v2 锚定阻尼 + ANCHOR_YIELD（锚定兵给己方行军兵让路）→ 治好了"兵墙堵死近战"，
 *      但引入两个新病（用户实测）：
 *      ① 依旧"膨胀"：让路 + 围圈滑动 + 成对互推，三个持续位移源叠加，密集堆每帧
 *         都有能量注入，净效果=整团向外蠕动；
 *      ② "隔空推动"：敌方近战推开我方行军兵 → 行军兵触发我方锚定远程兵让路 →
 *         推力链式传导，敌人还没碰到远程堆、堆先动了。
 *
 * v34 设计（定稿，与 LoL 一致）：
 *   1. 【锚定 = 静态障碍】：站定攻击的兵谁都推不动（敌我通吃）。锚定 vs 锚定零推；
 *      锚定 vs 移动 → 移动方承担 100% 分离。ANCHOR_YIELD 机制整体删除。
 *   2. 兵墙就是墙：后排兵打不到就沿墙滑动找缝（LaneMovementSystem 负责）或排队等
 *      前排死亡补位——这是 LoL 原版行为，用户已确认接受。
 *   3. 移动 vs 移动维持对半柔化（行军队形内的正常错开）。
 *   4. 每步位移封顶 + 墙壁约束保留。
 */
export class CollisionSystem {
  constructor(entityContainer, mapSystem) {
    this.entities = entityContainer;
    this.mapSystem = mapSystem;
    const T = CONFIG.tuning || {};
    this.OVERLAP_ALLOW = T.collisionOverlapAllow ?? 1.0;  // v41: 只防穿模，不维持队形
    this.MOVER_FACTOR = T.collisionMoverFactor ?? 0.25;   // 移动 vs 移动的每步修正比例
    this.MAX_PUSH = T.collisionMaxPush ?? 2.0;            // 移动单位单步位移上限（px）
    this.BLOCK_FACTOR = T.collisionBlockFactor ?? 0.85;   // 撞上锚定障碍时移动方的修正比例
    this.MAX_PUSH_BLOCK = T.collisionMaxPushBlock ?? 2.6; // 被障碍弹回的单步上限（≈移速步长）
  }

  update(dt) {
    if (!this.mapSystem.active) return;

    const minions = this.entities.getAllMinions(true).filter(m => m._laneId && m.pos);

    for (const m of minions) {
      const rM = MINION_SIZES[m.type] || 10;
      const nearby = this.entities.findInRadius(m.pos.x, m.pos.y, rM * 3, null, true);

      for (const other of nearby) {
        if (other.id <= m.id || !other._laneId || !other.pos) continue; // 每对只处理一次
        const rO = MINION_SIZES[other.type] || 10;
        const aAnch = !!m._anchored, bAnch = !!other._anchored;

        // 锚定 vs 锚定：零推。落位时已尽量避开（_findAnchorSlot），残余重叠容忍——
        // 任何"锚定间微调"都会在密集堆里累积成蠕动（v2 的教训）。
        if (aAnch && bAnch) continue;

        const oneAnchored = aAnch !== bAnch;
        const minDist = (rM + rO) * (oneAnchored ? 1.0 : this.OVERLAP_ALLOW);
        const dx = m.pos.x - other.pos.x, dy = m.pos.y - other.pos.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;

        let nx, ny, dist;
        if (distSq < 0.0001) {
          // 完全重合：id 差生成确定性方向（同一对每次一致，不抖）
          const angle = ((m.id - other.id) * 2.399963) % (Math.PI * 2);
          nx = Math.cos(angle); ny = Math.sin(angle); dist = 0;
        } else {
          dist = Math.sqrt(distSq);
          nx = dx / dist; ny = dy / dist;
        }
        const overlap = minDist - dist;

        // 分担：锚定方永远 0（静态障碍，敌我一致）；移动方承担全部。
        let pushM = 0, pushO = 0;
        if (oneAnchored) {
          if (aAnch) pushO = Math.min(overlap * this.BLOCK_FACTOR, this.MAX_PUSH_BLOCK);
          else pushM = Math.min(overlap * this.BLOCK_FACTOR, this.MAX_PUSH_BLOCK);
        } else {
          pushM = pushO = Math.min(overlap * this.MOVER_FACTOR / 2, this.MAX_PUSH);
        }

        if (pushM) { m.pos.x += nx * pushM; m.pos.y += ny * pushM; this.mapSystem.constrainToWalkable?.(m.pos); }
        if (pushO) { other.pos.x -= nx * pushO; other.pos.y -= ny * pushO; this.mapSystem.constrainToWalkable?.(other.pos); }
      }
    }
  }
}
