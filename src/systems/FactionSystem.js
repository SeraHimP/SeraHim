/**
 * FactionSystem.js
 * 阵营关系表：给定两个阵营，判断是否互为敌对。
 *
 * 设计目标：当前只用 blue/red 两个阵营对战，但关系表本身按"任意多阵营互相声明敌对关系"
 * 的方式实现，以后加入第三方阵营（如野怪/中立塔）不需要改判定逻辑，只需要在
 * ENEMY_PAIRS 里补充新的敌对声明。
 *
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
 * ==================== 多阵营地基：地图声明哪些阵营、每条路打谁 ====================
 * 见 docs/REPORT-2026-09-03-multifaction.md §3。地图作者时间声明，对局中固定不变。
 *
 * 未声明时按两阵营解读，跟改动前逐位一致——现有三张地图暂时都没有显式写
 * factions/lane.spawns 字段（正在按报告的分阶段顺序逐步补），这两个函数保证
 * 在字段补齐之前，读它们的代码不会因为"字段不存在"而表现异常。
 */

/** 地图声明支持的阵营列表。未声明时兜底为 [blue, red]（现有地图的既定行为）。 */
export function mapFactionsOf(map) {
  return map?.factions || [FACTIONS.BLUE, FACTIONS.RED];
}

/**
 * 一条兵线上有哪些出兵流：每一项是"某阵营从这条路的哪个方向出发、打向哪些阵营"。
 * 未声明时兜底为"蓝方 forward 打红方 + 红方 reverse 打蓝方"——与
 * LaneWaveSystem.spawnWave 改造前对每条 lane 各调一次 BLUE/RED 的行为逐位一致。
 * @param {{spawns?: {faction:string, direction:'forward'|'reverse', targetFactions:string[]}[]}} lane
 */
export function laneSpawnsOf(lane) {
  return lane?.spawns || [
    { faction: FACTIONS.BLUE, direction: 'forward', targetFactions: [FACTIONS.RED] },
    { faction: FACTIONS.RED, direction: 'reverse', targetFactions: [FACTIONS.BLUE] },
  ];
}

/**
 * CTX.__towerRules（{invincible,attackOff,waveOn} 三张按阵营开关的表）的统一取值逻辑。
 * 三张表都只声明了 blue/red 两个 key，查不到某个阵营的 key 时：
 *   - waveOn 兜底 true——这张表是"选中才不出兵"的反向语义，新阵营不声明就该照常
 *     出兵，兜底 false 会把新阵营默认静音且不报任何错，是最难查的那类问题
 *     （见 docs/REPORT-2026-09-03-multifaction.md §1.2）。
 *   - 其余表兜底 false——"选中才生效"的正向语义，默认不生效本来就对。
 * main.js 的 CTX.__towerRuleFor 与 GameContext.js 的初始默认值都调用这一份，
 * 不在两处各写一遍同样的逻辑（两份迟早漂移，是本项目一贯在防的重复）。
 */
export function towerRuleFor(towerRules, kind, faction) {
  const r = towerRules?.[kind];
  if (r && faction in r) return !!r[faction];
  return kind === 'waveOn';
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
 * ==================== v49：半径内的**敌方单位**（唯一实现）====================
 * 用户："腐蚀型武器的塔竟然会对友军也造成伤害，攻城车安然无恙？"
 *
 * 两句话各自对应一个 bug，而且是同一行代码造成的：
 *   ① `findInRadius` **不认阵营**（它只是个空间网格查询）。腐蚀把返回值直接命名为
 *      `enemies` 就拿去叠毒了 —— 于是自己人也中毒。溅射那处刚犯过一模一样的错
 *      （见 CombatSystem._applyExplosionAt 的头注），这是同一个坑的第三次。
 *   ② 那行还带着一张**写死的兵种白名单**
 *      `['melee','ranged','siege','super','totem','dragon','shield','warlock','corrupt']`——
 *      里面**没有 'ram'**，所以攻城车对腐蚀完全免疫。这类白名单每加一个新兵种就得
 *      记得回来补一次，漏了没有任何报错，只会表现成"某个兵莫名其妙不吃某个效果"。
 *
 * 所以这里一次解决两件事：按阵营过滤 + 用"不是建筑"代替白名单。
 * 以后再加兵种自动包含在内，不需要回来改这张表。
 *
 * @param entities 实体容器
 * @param self     施法者（永远排除自己）
 * @param radius   半径
 * @param opts.includeBuildings 是否也返回敌方建筑（默认 false = 只要单位）
 */
export function enemyUnitsInRadius(entities, self, radius, opts = {}) {
  if (!self || !self.pos) return [];
  const sf = self._mapFaction || self.faction || null;
  const out = [];
  for (const e of entities.findInRadius(self.pos.x, self.pos.y, radius, null, true)) {
    if (!e || !e.alive || e.id === self.id) continue;
    if (!opts.includeBuildings && e.type === 'tower') continue;
    const ef = e._mapFaction || e.faction || null;
    if (!canTarget(sf, ef)) continue;
    out.push(e);
  }
  return out;
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
 *   分路链    ← 同路上【任何一个仍然存在且存活】的前置层级（外塔 → 内塔 → 水晶塔 → 召唤水晶）
 *   枢纽塔    ← 三路召唤水晶【全部】完好（任一被毁即暴露；重生后三路恢复完好则重新无敌）
 *   水晶枢纽  ← 双枢纽塔任一存活（原有）
 *
 * ==================== 为什么分路链要"按地图实际有的层级"算 ====================
 * 用户："扭曲丛林/嚎哭深渊中结构保护有错误，只有召唤水晶/枢纽塔/水晶枢纽生效，
 *        外/内/水晶塔不生效。"
 * 根因：原来这条链是**写死的一对一**——水晶塔的保护者固定是"内塔"。
 * 而这两张图**根本没有内塔**（层级只有 outer/base/nexus_lane/hq_tower/nexus_main），
 * 于是 aliveTier('inner') 永远为假 → 水晶塔从开局就是裸的，外塔没掉就能直接拆。
 * 用户列的那三条能生效，正因为它们的保护者（水晶塔/召唤水晶/枢纽塔）在这两张图上都存在。
 *（外塔是最前排，设计上本来就没有保护者，"不生效"是对的。）
 *
 * 现在改成：沿 LANE_CHAIN 往前找，只要**同路上还存在**（哪怕已经打没了，看的是"这张图有没有
 * 这个层级"）的前置层级里有【任意一个还活着】，就受保护。缺层的地图自动把链接上：
 *   扭曲丛林/嚎哭深渊：水晶塔 ← 外塔（跳过不存在的内塔）
 *   召唤师峡谷：       水晶塔 ← 内塔（内塔存在，行为与改动前逐位一致）
 *
 * ==================== v43：从"只看紧邻前一层"改成"任意前置层活着即保护" ====================
 * 用户："结构保护bug，如果我手动设置了外塔存在，如果此时内塔不存在的话，
 *        水晶塔的结构保护未生效。"（定稿选 B）
 * 上一版是 LoL 口径：**只认紧邻的那个"这张图上存在"的前置层级**，它死了就解除，
 * 更前面的层还活着也不管。于是"内塔已拆、手动把外塔复活回来"这种编辑器场景下，
 * 水晶塔仍然是裸的 —— 站在用户视角这就是"我明明把外塔弄回来了，保护却没回来"。
 * 现在改成：沿链往前扫，**任意一个前置层级还有活着的塔**就受保护，
 * 全部倒光才解除。副作用（有意的）：
 *   · 拆塔顺序必须自外向内**全部**拆完，不能跳着拆；
 *   · 水晶重生后，只要该路还有任何一座前置塔活着，它就是无敌的。
 * tierExists 这个辅助函数随之失去意义（不再需要"这张图有没有这一层"这一步，
 * 缺层天然就是"没有活着的塔"，扫过去即可），一并删掉。
 */
const LANE_CHAIN = ['outer', 'inner', 'base', 'nexus_lane'];

export function isStructureProtected(entityContainer, target) {
  if (!target || !target._mapFaction) return false;
  const towers = entityContainer.getAllTowers(true);
  const aliveTier = (tier, laneId) => towers.some(t =>
    t.alive && t._mapFaction === target._mapFaction && t._mapTier === tier &&
    (laneId === undefined || t._laneId === laneId)
  );
  const idx = LANE_CHAIN.indexOf(target._mapTier);
  if (idx > 0) {
    // v43：往前扫【全部】前置层级，任意一个还有活着的塔就受保护。
    // 缺层的地图不用特判——没有的层级自然一个活的都找不到，直接落到下一层。
    for (let i = idx - 1; i >= 0; i--) {
      if (aliveTier(LANE_CHAIN[i], target._laneId)) return true;
    }
    return false;   // 同路前置层级全部倒光（或自己就是最前排）→ 不受保护
  }
  switch (target._mapTier) {
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
