/**
 * structureRadius.js —— 建筑（塔 / 召唤水晶 / 水晶枢纽 / 据点）的碰撞半径：唯一的取法。
 *
 * 用户："模型的碰撞就是按照模型的实际尺寸来计算的！"；"塔和小兵穿模了！！！！不要出现任何穿模！！！！"
 * 显示半径 = buildingSizes × towerVizScale（模型按它建），但雕像塔的底座 / 塔基台面、枢纽的台阶
 * 都比这个"名义半径"宽（实测：普通塔 1.08–1.10、高地塔 1.18–1.19、召唤水晶 1.06–1.09、枢纽 1.30–1.33），
 * 小兵贴着名义半径站就已经插进底座里了。所以碰撞半径再乘 buildingFootprintK（按层级，取值 ≥ 实测外轮廓，
 * sim_no_clipping 用真实模型量外轮廓钉住这条）。显示不乘它——模型大小不变。
 * 纯数据（不 import 渲染层），逻辑层 LaneMovementSystem / MapSystem 共用。
 */
import { CONFIG } from './Config.js';

export function structureRadius(tier, modelSize = 0) {
  const bs = CONFIG.buildingSizes || {}, vz = CONFIG.towerVizScale || {}, fk = CONFIG.buildingFootprintK || {};
  const base = modelSize || bs[tier] || bs.default || 28;
  return base * (vz[tier] ?? vz.default ?? 1) * (fk[tier] ?? fk.default ?? 1);
}
