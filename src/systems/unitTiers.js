/**
 * unitTiers.js —— 三级兵种（Q9）的等级判定：出兵编排里写的一级兵类型 → 此刻该出哪一级。
 *
 * 规则（全部读 CONFIG.unitTiers）：
 *   · tier2AtMin 分钟起全图二级，tier3AtMin 分钟起全图三级；
 *   · tier3OnOwnBaseTowerLost：某一方某一路的水晶塔（tier=base）被拆后，这一方这一路出三级
 *     （用户定稿"这方"= 被拆塔的一方，劣势补偿）。
 * 只有 lines 里登记的兵种线才升级；其余兵种原样返回。
 */
import { CONFIG } from '../data/Config.js';

/** 某个类型属于哪条兵种线（返回一级兵的类型），不属于任何线返回 null。 */
export function tierLineOf(type) {
  const lines = CONFIG.unitTiers?.lines || {};
  for (const [base, list] of Object.entries(lines)) if (list.includes(type)) return base;
  return null;
}

/** 这一方这一路的水晶塔是否已经有被拆掉的（废墟或等待重生都算）。 */
export function ownBaseTowerLost(entities, faction, laneId) {
  if (!entities || !faction || !laneId) return false;
  for (const e of entities.getAll(false)) {
    if (e && e.type === 'tower' && e._mapTier === 'base' && e._mapFaction === faction && e._laneId === laneId && !e.alive) return true;
  }
  return false;
}

/** 此刻这一方这一路该出第几级（1/2/3）。 */
export function tierLevelFor(faction, laneId, gameTime, entities) {
  const c = CONFIG.unitTiers || {};
  if (c.enabled === false) return 1;
  const min = (gameTime || 0) / 60;
  let lv = 1;
  if (min >= (c.tier2AtMin ?? 15)) lv = 2;
  if (min >= (c.tier3AtMin ?? 30)) lv = 3;
  if (lv < 3 && c.tier3OnOwnBaseTowerLost !== false && ownBaseTowerLost(entities, faction, laneId)) lv = 3;
  return lv;
}

/** 出兵编排里的类型 → 实际生成的类型。 */
export function resolveTierType(type, faction, laneId, gameTime, entities) {
  const list = CONFIG.unitTiers?.lines?.[type];
  if (!list || !list.length) return type;
  const lv = tierLevelFor(faction, laneId, gameTime, entities);
  const t = list[Math.min(list.length, lv) - 1];
  return CONFIG.templates?.[t] ? t : type;
}
