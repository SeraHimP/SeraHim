/**
 * FactionSystem.js
 * 阵营关系表：给定两个阵营，判断是否互为敌对。
 *
 * 设计目标：当前只用 blue/red 两个阵营对战，但关系表本身按"任意多阵营互相声明敌对关系"
 * 的方式实现，以后加入第三方阵营（如野怪/中立塔）不需要改判定逻辑，只需要在
 * ENEMY_PAIRS 里补充新的敌对声明。
 *
 * 沙盒模式（现有自由玩法）不使用本系统——那边的索敌逻辑是"塔固定打小兵、小兵固定打塔"，
 * 与阵营无关，保持原样不受影响。本系统只服务于新的"对战模式"。
 */

export const FACTIONS = {
  BLUE: 'blue',
  RED: 'red',
  NEUTRAL: 'neutral', // 野怪/巨龙等中立单位，谁都可以打，但不主动攻击任何一方
};

// 互斥（敌对）阵营对——用 Set 存储"a|b"形式的无序对，双向查询
const ENEMY_PAIRS = new Set([
  pairKey(FACTIONS.BLUE, FACTIONS.RED),
]);

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

/**
 * 声明两个阵营互为敌对（供以后新增阵营时调用，例如加入第三方阵营）。
 */
export function declareEnemies(factionA, factionB) {
  ENEMY_PAIRS.add(pairKey(factionA, factionB));
}

/**
 * 判断两个阵营是否敌对。
 * 中立阵营（NEUTRAL）对任何阵营都不主动敌对（不会被这个函数判定为"是敌人"），
 * 但可以被任何阵营攻击——中立单位是否还手，由具体单位的 AI/技能逻辑决定，不归这里管。
 */
export function isEnemyFaction(factionA, factionB) {
  if (!factionA || !factionB) return false;
  if (factionA === factionB) return false;
  if (factionA === FACTIONS.NEUTRAL || factionB === FACTIONS.NEUTRAL) return false;
  return ENEMY_PAIRS.has(pairKey(factionA, factionB));
}

/**
 * 判断"攻击方是否可以将目标视为可攻击目标"——用于对战模式的索敌过滤。
 * 中立目标（如巨龙）对任何非中立阵营都视为"可攻击"（谁都能打野怪/龙），
 * 但中立单位之间、以及中立打非中立不适用这条（中立不主动索敌）。
 */
export function canTarget(attackerFaction, targetFaction) {
  if (!attackerFaction || !targetFaction) return false;
  if (attackerFaction === targetFaction) return false;
  if (targetFaction === FACTIONS.NEUTRAL) return attackerFaction !== FACTIONS.NEUTRAL;
  // EQ2：中立作为攻击方可以打任何非中立阵营（中立塔"都打红蓝方并且都被红蓝方打"）。
  // 中立单位是否真的主动攻击由其自身 AI 决定（塔的攻击循环会用到这条；巨龙等仍走各自系统）。
  if (attackerFaction === FACTIONS.NEUTRAL) return targetFaction !== FACTIONS.NEUTRAL;
  return isEnemyFaction(attackerFaction, targetFaction);
}


/**
 * 结构保护（"不可选中"，LoL 规则）：
 * - 分路召唤水晶：该路己方水晶塔（高地塔，tier='base'）存活时不可被攻击/索敌。
 * - 水晶枢纽：己方任一枢纽塔（tier='hq_tower'）存活时不可被攻击/索敌（双塔全灭才解除）。
 * 集中在这里实现，CombatSystem（伤害守卫）、LaneMovementSystem（索敌过滤）、
 * CanvasRenderer（保护视觉标识）三处共用，避免规则复制三份后失同步。
 * 只依赖 entityContainer 查询，不依赖 MapSystem——水晶塔重生/摧毁后状态自动正确。
 */
/**
 * 结构保护（v35 追加Q2：扩展到全部塔层级，LoL 对齐）。
 * 受保护 = 不可被选中 + 免疫一切伤害（含天气负恢复的环境扣血）。
 * 保护链（动态判定，水晶重生后保护自动恢复——LoL 同款）：
 *   内塔     ← 同路己方外塔存活
 *   水晶塔   ← 同路己方内塔存活
 *   召唤水晶 ← 同路己方水晶塔存活（原有）
 *   枢纽塔   ← 三路召唤水晶【全部】完好（任一被毁即暴露；重生后三路恢复完好则重新无敌）
 *   水晶枢纽 ← 双枢纽塔任一存活（原有）
 */
export function isStructureProtected(entityContainer, target) {
  if (!target || !target._mapFaction) return false;
  const towers = entityContainer.getAllTowers(true);
  const aliveTier = (tier, laneId) => towers.some(t =>
    t.alive && t._mapFaction === target._mapFaction && t._mapTier === tier &&
    (laneId === undefined || t._laneId === laneId)
  );
  switch (target._mapTier) {
    case 'inner':      return aliveTier('outer', target._laneId);
    case 'base':       return aliveTier('inner', target._laneId);
    case 'nexus_lane': return aliveTier('base', target._laneId);
    case 'hq_tower': {
      // 三路召唤水晶全部完好才保护（单路地图=该路水晶完好）。
      // 注意：路集合必须从【含尸体】的全部实体收集——getAllTowers(true) 只有活的，
      // 死水晶从集合里消失会把"缺一路"误判成"全部完好"（首版 bug）。
      const laneIds = new Set();
      for (const t of entityContainer.getAllTowers(false)) {
        if (t._mapFaction === target._mapFaction && t._mapTier === 'nexus_lane') laneIds.add(t._laneId);
      }
      if (laneIds.size === 0) return false;
      for (const lid of laneIds) if (!aliveTier('nexus_lane', lid)) return false;
      return true;
    }
    case 'nexus_main': return aliveTier('hq_tower');
    default: return false;
  }
}
