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
 *   ② 不在任何路上（水晶枢纽、手动建的塔）→ 朝**敌方主基地**。
 *      这是个总能算出来的方向，比"保持默认朝北"有意义。
 */
export function towerFacingRad(entity, map, cfg = null) {
  const c = cfg || (CONFIG.ui && CONFIG.ui.towerFacing) || {};
  if (c.enabled === false) return null;
  if (!entity || !entity.pos || !map) return null;
  const fac = entity._mapFaction || entity.faction;
  if (fac !== 'blue' && fac !== 'red') return null;

  // ---- ① 有兵线：取切线 ----
  const lane = (map.lanes || []).find(l => l.id === entity._laneId);
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
    // 蓝方朝路点前进方向（指向红方），红方反过来 —— 即"每座塔面朝敌人来向"。
    if (fac === 'red') { dx = -dx; dy = -dy; }
    if (c.flip) { dx = -dx; dy = -dy; }   // 见下面 flip 的说明
    return wrap(Math.atan2(dx, dy));
  }

  // ---- ② 没有兵线：朝敌方主基地 ----
  const nexusOf = (f) => (map.buildings || []).find(b =>
    b.tier === 'nexus_main' && b.faction === f && b.pos);
  const foe = nexusOf(fac === 'blue' ? 'red' : 'blue');
  if (!foe) return null;
  let dx = foe.pos.x - entity.pos.x, dy = foe.pos.y - entity.pos.y;
  if (c.flip) { dx = -dx; dy = -dy; }
  if (dx === 0 && dy === 0) return null;
  let ang = wrap(Math.atan2(dx, dy));

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
  const own = nexusOf(fac);
  if (entity._mapTier === 'hq_tower' && own) {
    const spread = (c.hqSpreadDeg ?? 25) * Math.PI / 180;
    const bearing = Math.atan2(entity.pos.x - own.pos.x, entity.pos.y - own.pos.y);
    const side = wrap(bearing - ang);
    if (side !== 0) ang = wrap(ang + Math.sign(side) * spread);
  }
  return ang;
}
