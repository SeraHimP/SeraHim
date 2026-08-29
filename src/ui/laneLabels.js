/**
 * laneLabels.js —— "这张图有哪几条路、每条路叫什么"的**唯一实现**
 *
 * 用户："添加单位窗口中，由于不同地图有不同的路数，所以窗口元素也要跟着修改。
 *        现在进入扭曲丛林也会显示上/中/下路。"
 *
 * 各图的路数确实不同：
 *   召唤师峡谷 / 经典模式  top, mid, bot（三路）
 *   扭曲丛林               top, bot（**没有中路**）
 *   嚎哭深渊               mid（只有一路）
 *
 * ==================== 为什么单独一个文件 ====================
 * 出兵编排面板（pagesWave）**早就做对了** —— 它有个 _mapLaneIds() 读当前地图的 lanes。
 * 而添加单位窗口把 top/mid/bot 写死在模板字符串里。同一个问题一处对一处错，
 * 正是"同一件事实现了两遍"的典型：先做的那处修好了，后做的那处没人想起来。
 *
 * 所以这次不是"把 pagesWave 的写法抄到 UnitAddDialog"，而是抽成一份、两边都调它。
 * 抄过去的话，下次再加一个用到分路的界面，就是第三份。
 */

/** 当前地图的路 id 列表。取不到地图（尚未载入）时退回三路，与改动前的默认一致。 */
export function mapLaneIds() {
  const m = (window.CTX?.__app || window.__app)?.mapSystem?.currentMap;
  const ids = (m?.lanes || []).map(l => l.id).filter(Boolean);
  return ids.length ? ids : ['top', 'mid', 'bot'];
}

/** 带图标的长标签（页签用）。地图自定义的路 id 没有登记时原样显示 id。 */
export function laneLabel(id) {
  return ({ top: '⬆️ 上路', mid: '➡️ 中路', bot: '⬇️ 下路' })[id] || id;
}

/** 不带图标的短标签（"🔵→中路" 这种一行摘要用）。 */
export function laneShort(id) {
  return ({ top: '上路', mid: '中路', bot: '下路' })[id] || id;
}

/**
 * 把一个可能已经失效的路 id 夹回当前地图真实存在的路。
 *
 * 这一步**必不可少**：界面上的选择是记在状态里的，玩家在召唤师峡谷选了"中路"，
 * 切到扭曲丛林之后那张图根本没有 mid —— 按钮不会高亮（看起来像没选），
 * 而生成出来的兵会带着一个不存在的 laneId，LaneMovementSystem 找不到那条路，
 * 兵就**站在原地不动**。是个不报错、只是"兵不走"的坑。
 */
export function clampLaneId(id) {
  const ids = mapLaneIds();
  return ids.includes(id) ? id : ids[0];
}
