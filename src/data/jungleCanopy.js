/**
 * jungleCanopy.js —— 野区"树冠"布局的摆放规划（纯数据，headless 可测）
 *
 * 用户："区分可走不可走不是改个颜色就区分了，重要要出来为什么不可走，是有树挡着，
 * 还是墙挡着？"定稿方案（2026-09-27 方案页，用户逐项选过）：
 *   · 不可走区整块被树冠盖满，边缘一排正好压在可走边界上，边缘夹石头；
 *   · 能走的草地是干净的，只在贴着树林的地方放少量矮灌木；兵线路面上什么都不放；
 *   · 基地石墙（地图声明 baseWalls 时）交给 BaseWallLayer，这里跳过。
 *
 * 只按调色板 jungleLayout:'canopy' 启用；参数全部在 CONFIG.ui.jungleCanopy。
 * 返回四类摆放点，VegetationLayer 负责实例化；这里不碰 THREE。
 */
import { CONFIG } from './Config.js';
import { isLaneCell } from './mapValidate.js';

// 与 VegetationLayer.hash 同一公式（这里不 import 渲染层）。
function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];

/**
 * @param {object} map
 * @param {(x:number,y:number)=>boolean} walk  可走判定（MapSystem.isWalkable）
 * @param {((x:number,y:number)=>boolean)|null} [isWall]  基地石墙（baseWallLookup），墙上不长树
 * @returns {{ interior: number[][], edgeTrees: number[][], edgeRocks: number[][], bushes: number[][] }}
 *   每个点是 [x, y, scale, rot]
 */
export function canopyPlan(map, walk, isWall = null) {
  const wall = isWall || (() => false);
  const C = CONFIG.ui?.jungleCanopy || {};
  const { w: WW, h: WH } = map.world;
  const out = { interior: [], edgeTrees: [], edgeRocks: [], bushes: [] };
  const inWorld = (x, y) => x >= 0 && y >= 0 && x <= WW && y <= WH;
  const nearWalk = (x, y, r) => DIRS.some(([dx, dy]) => {
    const px = x + dx * r, py = y + dy * r;
    return inWorld(px, py) && walk(px, py);
  });
  const nearBlock = (x, y, r) => DIRS.some(([dx, dy]) => {
    const px = x + dx * r, py = y + dy * r;
    return inWorld(px, py) && !walk(px, py);
  });
  const lerp = (a, b, t) => a + (b - a) * t;
  const edgeProbe = C.edgeProbe ?? 26;

  // 树林内部：盖满。离可走区不到 edgeProbe 的点留给边缘那一排。
  const S = C.interiorStep ?? 34;
  for (let gx = S / 2; gx < WW; gx += S) {
    for (let gy = S / 2; gy < WH; gy += S) {
      const x = gx + (hash(gx + 11, gy) - 0.5) * S * 0.6;
      const y = gy + (hash(gx, gy + 11) - 0.5) * S * 0.6;
      if (!inWorld(x, y) || walk(x, y) || wall(x, y)) continue;
      if (nearWalk(x, y, edgeProbe)) continue;
      out.interior.push([x, y, lerp(C.scaleMin ?? 0.95, C.scaleMax ?? 1.35, hash(gx + 7, gy)), hash(gx + 5, gy + 5) * 6.2832]);
    }
  }

  // 边缘一排：不可走、但离可走区很近——树为主，夹石头。
  const E = C.edgeStep ?? 26;
  for (let gx = E / 2; gx < WW; gx += E) {
    for (let gy = E / 2; gy < WH; gy += E) {
      const x = gx + (hash(gx + 13, gy) - 0.5) * E * 0.4;
      const y = gy + (hash(gx, gy + 13) - 0.5) * E * 0.4;
      if (!inWorld(x, y) || walk(x, y) || wall(x, y)) continue;
      if (!nearWalk(x, y, edgeProbe)) continue;
      const rot = hash(gx + 5, gy + 9) * 6.2832;
      if (hash(gx + 17, gy + 3) < (C.edgeRockChance ?? 0.25)) {
        out.edgeRocks.push([x, y, lerp(C.rockScaleMin ?? 1.3, C.rockScaleMax ?? 2.1, hash(gx + 19, gy)), rot]);
      } else {
        out.edgeTrees.push([x, y, lerp(C.scaleMin ?? 0.95, C.scaleMax ?? 1.35, hash(gx + 23, gy)), rot]);
      }
    }
  }

  // 草地上的矮灌木：只在贴着树林的地方，兵线路面上一株都不放。
  const B = C.bushStep ?? 40, band = C.bushBand ?? 34;
  for (let gx = B / 2; gx < WW; gx += B) {
    for (let gy = B / 2; gy < WH; gy += B) {
      const x = gx + (hash(gx + 29, gy) - 0.5) * B * 0.7;
      const y = gy + (hash(gx, gy + 29) - 0.5) * B * 0.7;
      if (!inWorld(x, y) || !walk(x, y) || isLaneCell(map, x, y)) continue;
      if (!nearBlock(x, y, band)) continue;
      if (hash(gx + 31, gy + 7) >= (C.bushChance ?? 0.25)) continue;
      out.bushes.push([x, y, 0.6 + hash(gx + 37, gy) * 0.4, hash(gx + 41, gy) * 6.2832]);
    }
  }
  return out;
}
