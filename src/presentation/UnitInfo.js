/**
 * UnitInfo.js —— 单位附属信息的纯读取函数（2.5D 迁移第 3.7 步抽出）
 *
 * 动机：镀层节点此前是 CanvasRenderer 的私有方法，第 3.7 步 3D 侧血条也要画节点线。
 * 与 TerrainLayer 同一抽离模式：单一来源，CanvasRenderer._nextPlatingNode 转调此处；
 * 第 5 步删除 Canvas 后本文件成为唯一实现。零 THREE 依赖，headless 可直接测。
 */

import { CONFIG } from '../data/Config.js';
import { MINION_STYLE } from './SpriteFactory.js';

// v33（Q16）：下一个未破裂的镀层节点（HP 比例 0.8/0.6/0.4/0.2）；无镀层技能返回 null
export function nextPlatingNode(tower) {
  const inst = (tower._skillInstances || []).find(i => i.skillId === 'passive_armor_plating');
  if (!inst) return null;
  const broken = inst.state?.broken || [false, false, false, false];
  const thresholds = [0.8, 0.6, 0.4, 0.2];
  for (let i = 0; i < thresholds.length; i++) {
    if (!broken[i]) return thresholds[i];
  }
  return null; // 全破完，不再标记
}

// ===== 点选命中半径（第 5 步：从 CanvasRenderer 抽出，与 UnitLayer 的显示尺寸同源） =====
// 命中语义在世界坐标里，与渲染器无关，故放在这里而不是任何一个 Layer 内。
export function buildingSize(t) {
  const bs = CONFIG.buildingSizes || {};
  return t._modelSize || bs[t._mapTier] || bs.default || 28; // v33 Q13：单塔覆写
}

export function minionSize(m) {
  return (MINION_STYLE[m.type] && MINION_STYLE[m.type].size) || 10;
}
