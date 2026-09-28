/**
 * torchPlacement.js —— 地图火炬的布点（纯函数）
 *
 * ==================== 为什么单独一个文件 ====================
 * 这段逻辑原来埋在 ThreeRenderer._torchPoints 里。结果是：它**在 headless 下一行都跑不到**
 * （渲染器要 WebGL），于是里面那个"世界尺寸取了不存在的字段"的错误
 * ——`map.width || 900`，而地图的世界尺寸在 `map.world.w`（召唤师峡谷 3552）——
 * 一条用例都碰不到，只能等人在游戏里发现"全图乌漆嘛黑，灯呢？"。
 *
 * 抽成纯函数之后它就是可测的：给一张假地图，数一数撒了多少点、在不在范围内。
 * 这是本仓库反复出现的形状：**逻辑住在只有真浏览器才跑的地方 = 没有断言守着**。
 */

/**
 * @param map        地图数据（读 world / lanes）
 * @param isWalkable (x, y) => bool
 * @param cfg        CONFIG.ui.torch
 * @returns [{x, y}]
 */
export function torchPoints(map, isWalkable = () => true, cfg = {}) {
  if (!map) return [];

  // ① 地图自己声明的优先（作者摆得比算法准）
  if (Array.isArray(map.torches) && map.torches.length) {
    return map.torches.map(t => ({ x: t.x, y: t.y }));
  }

  // ② 程序化撒点
  // ⚠️ 世界尺寸在 map.world = {w, h}。写成 map.width 时 `|| 900` 会把"字段不存在"
  // 静默变成一个合法值，撒点范围因此被限死在左上角一小块 —— 不报错，最难查。
  const W = map.world?.w || map.width || 900;
  const H = map.world?.h || map.height || 700;
  const gap = Math.max(60, cfg.spacing ?? 260);
  const laneKeep = cfg.nearLane === false ? 0 : gap * 0.55;
  const lanes = map.lanes || [];
  const maxPts = cfg.maxPoints ?? 400;

  const farFromLane = (x, y) => {
    if (!laneKeep) return true;
    const r2 = laneKeep * laneKeep;
    for (const ln of lanes) {
      for (const w of (ln.waypoints || [])) {
        const dx = w.x - x, dy = w.y - y;
        if (dx * dx + dy * dy < r2) return false;
      }
    }
    return true;
  };

  const pts = [];
  // 抖动网格而不是纯随机：这些点每张图只算一次，纯随机扎堆一次就永远扎堆。
  // 抖动量取间距的 1/5，既不成排也不聚团；抖动量由坐标派生，保证同一张图结果稳定。
  for (let y = gap * 0.6; y < H && pts.length < maxPts; y += gap) {
    for (let x = gap * 0.6; x < W; x += gap) {
      const jx = x + ((x * 7 + y * 13) % 100 / 100 - 0.5) * gap * 0.4;
      const jy = y + ((x * 11 + y * 5) % 100 / 100 - 0.5) * gap * 0.4;
      if (jx < 0 || jy < 0 || jx > W || jy > H) continue;
      if (!isWalkable(jx, jy)) continue;
      if (!farFromLane(jx, jy)) continue;
      pts.push({ x: jx, y: jy });
    }
  }
  return pts;
}
