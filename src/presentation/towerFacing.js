/**
 * towerFacing.js —— 塔的**静态朝向**（沿兵线朝向敌方）
 *
 * 用户："路径上塔的朝向也需要修改，看图，能看懂不，另一阵营同理。"
 * 图上画的是：蓝方上路塔朝上路推进方向、中路塔沿对角线朝右上、下路塔朝右；红方镜像。
 * 也就是**每座塔都面朝自己这一路的敌人来向**，而不是全部朝同一个方向。
 *
 * ==================== 这与 FacingSystem 是两回事 ====================
 * FacingSystem 管的是"必须转过来才能打"那条**战斗规则**，塔按用户定稿**豁免**。
 * 这里管的是**模型摆放**：塔不会转，但它一开始朝哪边摆是个设计问题。
 * 两者互不影响 —— 塔的朝向不进 `entity._facing`，也不参与 canFire 的判定。
 * 分开写而不是塞进 FacingSystem，就是为了让"塔豁免战斗朝向"这条不被将来的人误解。
 *
 * ==================== 为什么是纯函数、为什么单独一个文件 ====================
 * 与 torchPlacement.js 同一个理由，而且那次的教训是刚踩过的：
 * 逻辑埋在渲染器里 = headless 一行都跑不到 = 没有任何断言守着。
 * 火炬那个"世界尺寸取错字段导致全图没灯"就是这么漏出去的。
 *
 * ==================== 关于方向的一个诚实说明 ====================
 * 用户是画图说明的，图上三条路的箭头里，中路（朝右上）与下路（朝右）都明确指向**敌方**，
 * 上路那条箭头我读起来像是朝下（即指向蓝方自己的基地），与另外两条不一致。
 * 我按"**每座塔面朝敌人来向**"这条统一规则实现 —— 它能解释中路和下路两条，
 * 也是防御工事该有的朝向；上路那条我判断是在画"敌人从这个方向压过来"的流向，
 * 而不是塔的朝向。
 *
 * 如果我读反了，**改一个值就能整体翻转**：CONFIG.ui.towerFacing.flip = true。
 * 之所以留这个开关而不是赌一把：图示方向这种东西描述起来有歧义，
 * 而返工代价（重画一遍全部塔的角度）远大于留一个布尔。
 */

import { CONFIG } from '../data/Config.js';
import { FACTIONS, mapFactionsOf, laneSpawnsOf } from '../systems/FactionSystem.js';

/** 归一化到 (-π, π]。 */
function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * 算出一座塔该朝哪个方向（弧度，与全项目约定一致：模型正面 +Z，故用 atan2(dx, dz)）。
 *
 * @param entity 塔实体（读 pos / _mapFaction / _laneId）
 * @param map    地图数据（读 lanes / buildings）
 * @returns 弧度；拿不到足够信息时返回 null（调用方保持默认朝向，不要瞎猜）
 *
 * 规则：
 *   ① 塔在某条路上 → 取该路在塔位置处的**切线方向**，蓝方朝路点前进方向、红方反向。
 *      兵线的 waypoints 一律是【蓝方基地 → 红方基地】的顺序，这是全项目的既有约定
 *      （LaneMovementSystem 的 forward/reverse 就建立在它上面），这里沿用同一条约定。
 *      —— 但切线**只在它确实指着敌方半场时才用**，见下面「回环路」那一段。
 *   ② 不在任何路上（水晶枢纽、手动建的塔），或切线不可信 → 朝**敌方主基地**。
 *      这是个总能算出来的方向，比"保持默认朝北"有意义。
 *
 * ==================== 回环路：切线为什么会指反 ====================
 * 用户："扭曲丛林的朝向不对，另一阵营同理。"
 *
 * 我一开始默认了"兵线大体是从自家基地单调走向敌家基地"，所以切线方向 ≈ 敌人方向。
 * **召唤师峡谷成立，扭曲丛林不成立** —— 那张图两条路的起点和终点是同一个点
 * （都是 (584,676) → (2424,676)），路本身是**绕出去再绕回来**的回环。
 * 于是靠近自家基地的那几座塔，切线指的是"这条路在此处的走向"（上/下），
 * 跟"敌人在哪边"（右）差了将近 90°，甚至更多。屏幕上就是一排塔集体扭着头。
 *
 * 修法不是给扭曲丛林写特例，而是**给切线加一个可信度判据**：
 * 切线与"此处指向敌方水晶枢纽"的方向点积 > 0 才用它（即至少大方向没搞反），
 * 否则退回规则②。召唤师峡谷三条路全程满足这个判据，所以那张图一个角度都不变；
 * 扭曲丛林只有回环段被拦下，路中段仍然吃切线、保留各路的性格。
 *
 * 换个说法：切线负责"这一路的味道"，敌方枢纽方向负责"底线正确"。
 */
export function towerFacingRad(entity, map, cfg = null) {
  const c = cfg || (CONFIG.ui && CONFIG.ui.towerFacing) || {};
  if (c.enabled === false) return null;
  if (!entity || !entity.pos || !map) return null;
  const fac = entity._mapFaction || entity.faction;
  if (!fac || fac === FACTIONS.NEUTRAL) return null;

  const nexusOf = (f) => (map.buildings || []).find(b =>
    b.tier === 'nexus_main' && b.faction === f && b.pos);
  const lane = (map.lanes || []).find(l => l.id === entity._laneId);
  // 多阵营地基（docs/REPORT-2026-09-03-multifaction.md §1.3）：原来写死
  // "敌人=另外那一个"，改成优先读这条路自己声明的目标阵营（laneSpawnsOf）——
  // 汇合路径上一座塔理论上有多个目标，朝向取第一个目标当"正对方向"，跟
  // LaneWaveSystem 的 wctx.enemy 简化取法一致，真正的多目标朝向语义留给以后。
  // 找不到匹配的 spawn 声明时（自制图没配 lane.spawns，或建筑不在任何路上），
  // 兜底成"地图声明的阵营列表里第一个不是自己的"——两阵营地图下这就是
  // "另外那一个"，与改动前逐位一致。
  const mySpawn = laneSpawnsOf(lane || {}).find(s => s.faction === fac);
  const enemyFac = mySpawn?.targetFactions?.[0] || mapFactionsOf(map).find(f => f !== fac) || null;
  const foe = enemyFac ? nexusOf(enemyFac) : null;
  // 指向敌方水晶枢纽的向量：既是规则②本身，也是规则①的可信度判据。
  const fx = foe ? foe.pos.x - entity.pos.x : 0;
  const fy = foe ? foe.pos.y - entity.pos.y : 0;

  // ---- ① 有兵线：取切线（且切线得指着敌方半场） ----
  const wps = lane && lane.waypoints;
  if (wps && wps.length >= 2) {
    // 找最近的路点，用它前后两点连线当切线 —— 只用相邻一段的话，
    // 塔正好卡在拐点上时方向会跳；跨一段取差分平滑得多。
    let bi = 0, bd = Infinity;
    for (let i = 0; i < wps.length; i++) {
      const dx = wps[i].x - entity.pos.x, dy = wps[i].y - entity.pos.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    const a = wps[Math.max(0, bi - 1)];
    const b = wps[Math.min(wps.length - 1, bi + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return null;
    // 朝路点前进方向还是反过来，取这条路自己声明的方向（mySpawn.direction）——
    // 两阵营默认声明里 blue=forward/red=reverse，跟改动前"红方反过来"逐位一致；
    // 找不到声明（同上面 enemyFac 的兜底理由）时按 forward 处理，即"沿路点顺序朝敌人来向"。
    if (mySpawn?.direction === 'reverse') { dx = -dx; dy = -dy; }
    // 可信度判据。没有敌方枢纽可参照时（自制图可能没写）就无条件信切线 ——
    // 那是改动前的行为，不能因为拿不到参照物就把整条规则①废掉。
    //
    // ⚠️ 判据必须在 **flip 之前**算。flip 的语义是"整份结果翻 180°"，
    // 要是先 flip 再判据，flip 就会把切线判成不可信、从而改走规则② ——
    // 那时 flip 不再是纯翻转，而是**换了一条规则**，两次调用的差值也不再是 180°。
    // 所以 flip 统一挪到函数末尾，作为最后一步施加。
    if (!foe || dx * fx + dy * fy > 0) return applyFlip(wrap(Math.atan2(dx, dy)), c);
  }

  // ---- ② 没有兵线 / 切线不可信：朝敌方主基地 ----
  if (!foe) return null;
  if (fx === 0 && fy === 0) return null;
  let ang = wrap(Math.atan2(fx, fy));

  // ==================== 枢纽塔：对角线上再各自向外张开一点 ====================
  // 用户："枢纽塔那里注意看一下，两侧的看向对角线但是略微朝两侧一些。"
  //
  // 两座枢纽塔夹着水晶枢纽站，都朝敌方基地的话会**完全平行**，读起来像两个复制品；
  // 而且它们实际要防的是从两侧绕进来的兵，正对对角线反而是最没用的朝向。
  //
  // 张开方向**不写死左右**：用"这座塔在自家水晶的哪一侧"来定 ——
  // 取它相对自家水晶的方位角与对角线的夹角，往那个符号的方向偏。
  // 这样红蓝天然镜像，以后挪塔的位置也不用回来改这里；
  // 写死左右的话，红方那两座（坐标是镜像的）必然要单独特判，那就是两份规则了。
  //
  // ⚠️ 只有**这一方确实有两座及以上枢纽塔**时才张开。张开这件事的全部意义是
  // "两座别摆成一模一样"，扭曲丛林每方只有一座枢纽塔 —— 对着孤零零一座塔偏 25°，
  // 没有任何东西与它形成对称，看上去就只是"这塔歪了"。用户报的正是这个。
  const own = nexusOf(fac);
  const hqCount = (map.buildings || []).filter(b =>
    b.tier === 'hq_tower' && b.faction === fac).length;
  if (entity._mapTier === 'hq_tower' && own && hqCount >= 2) {
    const spread = (c.hqSpreadDeg ?? 25) * Math.PI / 180;
    const bearing = Math.atan2(entity.pos.x - own.pos.x, entity.pos.y - own.pos.y);
    const side = wrap(bearing - ang);
    if (side !== 0) ang = wrap(ang + Math.sign(side) * spread);
  }
  return applyFlip(ang, c);
}

/** flip 的唯一施加点（见规则①里那段说明：它必须是最后一步、且是纯 180° 翻转）。 */
function applyFlip(ang, c) {
  return c.flip ? wrap(ang + Math.PI) : ang;
}
