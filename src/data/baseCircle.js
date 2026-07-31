/**
 * baseCircle.js —— 基地圈圆心的**唯一**取值口。
 *
 * 为什么要单独一个模块：这个量原本有两处实现——`MapSystem.getBaseCircleCenter`
 * 和 `TerrainLayer` 里"离线重算，避免依赖注入时序"的那份。两份都写死了
 * 「蓝方基地在世界左下角、红方在右上角」。
 *
 * 那是召唤师峡谷/嚎哭深渊的**巧合**，不是普遍规律：扭曲丛林的双方基地在
 * 左右两侧的中点 (300,1000)/(2700,1000)。按角点算，基地圈会被甩到地图角落的空地上——
 * 光环画在没有建筑的地方、+20 的高地地形长在空地上、可行走区凭空多出两块无用扇形，
 * 而基地本身反倒没有开阔地。**画面上不会报错，只会看着莫名其妙。**
 *
 * 现在地图可以显式声明 `baseCenters: { blue:{x,y}, red:{x,y} }`；
 * 未声明的沿用角点，对已有地图逐位不变（见 docs/DEVELOPMENT.md §8.3：加开关不许改行为）。
 */

/** @returns {{x:number,y:number}|null} 该方基地圈圆心 */
export function baseCircleCenter(map, faction) {
  if (!map?.world) return null;
  const declared = map.baseCenters?.[faction];
  if (declared) return { x: declared.x, y: declared.y };
  const { w: WW, h: WH } = map.world;
  return faction === 'blue' ? { x: 0, y: WH } : { x: WW, y: 0 };
}
