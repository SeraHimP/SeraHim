/**
 * towerModels.js —— 建筑可用的模型角色清单（**唯一来源**）。
 *
 * 为什么单独放在 data/ 而不是 presentation/ModelLibrary.js：
 * ModelLibrary 里 import 了 three 与 GLTFLoader，是纯浏览器模块；
 * 建塔面板（UI）与 headless 回归都要读这张表，从那边导入会把 three 拖进
 * 不需要它的调用链。清单本身只是数据，没有任何渲染依赖。
 *
 * 加了新的建筑 GLB 时**只改这里**：ModelLibrary 用它做角色校验、
 * 建塔面板用它生成选项。抄第二份的话，新模型在界面上看不见 = 等于没做。
 *
 * tier：勾选"同时套用该档位数值"时把塔的 _mapTier 设成它。
 *       'tower' 没有对应档位（外/内/水晶塔/枢纽塔都用同一个模型），故为 null。
 */
export const TOWER_MODEL_ROLES = [
  { key: 'tower',        label: '防御塔',   icon: '🏰', tier: null,          kind: 'tower' },
  { key: 'lane_crystal', label: '召唤水晶', icon: '🔮', tier: 'nexus_lane',  kind: 'orb' },
  { key: 'nexus',        label: '水晶枢纽', icon: '💎', tier: 'nexus_main',  kind: 'gem' },
];

/** 角色 key 是否合法（渲染层用它挡住存档里的脏值）。 */
export function isTowerModelRole(key) {
  return TOWER_MODEL_ROLES.some(r => r.key === key);
}

/** 角色 → 程序化几何的形状（GLB 未加载完/headless 时的回退用同一张表）。 */
export function towerModelKind(key) {
  return (TOWER_MODEL_ROLES.find(r => r.key === key) || {}).kind || null;
}

/** 角色 → 对应档位（没有则 null）。 */
export function towerModelTier(key) {
  return (TOWER_MODEL_ROLES.find(r => r.key === key) || {}).tier || null;
}
