/**
 * AISystem.js ? Target acquisition and line-of-sight checking [DeepSeek].
 *
 * Extracted from LaneMovementSystem (v41).
 * All methods are stateless ? callers pass entityContainer and mapSystem directly.
 */
import { canTarget, isStructureProtected } from './FactionSystem.js';

export const AISystem = {

  hasLineOfSight(mapSystem, ax, ay, bx, by) {
    if (!mapSystem.isWalkable) return true;
    const dist = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(dist / 40);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!mapSystem.isWalkable(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  },

  scanEnemies(entities, mapSystem, minion, acqRadius, attackRange) {
    const nearby = entities.findInRadius(minion.pos.x, minion.pos.y, acqRadius, null, true);
    const candidates = [];
    let inRange = null, inRangeD = attackRange * attackRange;
    const ign = minion._ignoreTarget;
    const now = window.gameTime || 0;

    for (const other of nearby) {
      if (other.id === minion.id) continue;
      const otherFaction = other._mapFaction || other.faction;
      if (!otherFaction) continue;
      if (!canTarget(minion._mapFaction, otherFaction)) continue;
      if (isStructureProtected(entities, other)) continue;
      const dx = other.pos.x - minion.pos.x, dy = other.pos.y - minion.pos.y;
      const d = dx * dx + dy * dy;
      if (d < inRangeD) { inRangeD = d; inRange = other; }
      if (ign && ign.id === other.id && now < ign.until) continue;
      candidates.push({ e: other, d });
    }

    candidates.sort((a, b) => a.d - b.d);
    let nearest = null;
    const lim = Math.min(6, candidates.length);
    for (let i = 0; i < lim; i++) {
      const c = candidates[i];
      if (this.hasLineOfSight(mapSystem, minion.pos.x, minion.pos.y, c.e.pos.x, c.e.pos.y)) {
        nearest = c.e; break;
      }
    }
    return { nearest, inRange };
  },
};

export default AISystem;
