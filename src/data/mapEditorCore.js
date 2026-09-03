/**
 * mapEditorCore.js —— 地图编辑器【笔刷 UI 之外】的纯逻辑
 *
 * 为什么要单独成模块（而不是直接写进 MapEditorDialog.js）：
 * 本仓库反复踩过"逻辑锁死在 DOM 代码里没法测"这个坑（见 navgrid.js 头注同一思路）
 * ——弹窗文件里必然混杂 document.getElementById/事件绑定，headless 测试跑不了；
 * 把"克隆一张地图 / 从地图上解出笔刷用的位图 / 拼出要存进 CONFIG.customMaps 的
 * 对象"这几步拆成不碰 DOM 的纯函数，Node 测试才能直接钉住它们的行为。
 *
 * 与地图编辑器设计报告的关系：docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.2/§3.5——
 * 阶段三 MVP 的"navgrid 笔刷 + 保存/加载"。这里只覆盖"克隆已有地图、在它的地形上
 * 改 navgrid"这一种笔刷起点——从空白世界徒手画出一张全新地图（含路径/建筑/出兵点）
 * 是设计报告阶段六（兵路径自定义）要做的事，不在这一批范围内。
 */
import { SR_NAVGRID } from './maps/sr_navgrid.js';
import { unpackBits, packBits } from './navgrid.js';
import { CONFIG } from './Config.js';
import {
  nearestPointOnPolyline, buildingCountsSymmetric, buildingOnLaneOrInBase,
  attackTowerSpacingOk, crossFactionTowerSpacingOk,
} from './mapValidate.js';

/**
 * 一张地图对象声明的 navgrid，或者该用哪张兜底。
 * 召唤师峡谷（summoners_rift.js）没有在地图对象上写 navgrid 字段，而是靠
 * MapSystem._navgrid() 里的 `this.currentMap.navgrid || SR_NAVGRID` 兜底——
 * 这里必须认得同一条兜底规则（复用同一个 SR_NAVGRID 常量，不重新写一份判断），
 * 否则编辑器克隆峡谷时会拿到一张空白 navgrid，画出来的地形和游戏里实际长的完全对不上。
 */
export function resolveBaseNavgrid(baseMap) {
  return baseMap?.navgrid || SR_NAVGRID;
}

/** 把一张地图的 navgrid 解码成笔刷能直接改的 {n, bits}（Uint8Array，0/1）。 */
export function decodeBaseBits(baseMap) {
  const ng = resolveBaseNavgrid(baseMap);
  const bits = unpackBits(ng.bits, ng.n);
  return { n: ng.n, bits };
}

/**
 * 深克隆一张地图数据（供编辑器改动而不污染原对象——尤其是内置地图，那是模块级
 * 常量，被 MAPS 表和当前正在跑的对局同时引用，编辑器决不能就地改它）。
 * 地图对象整体是纯数据（JSON 可还原），JSON 往返即可，不需要专门写递归克隆。
 */
export function cloneMapForEdit(baseMap) {
  return JSON.parse(JSON.stringify(baseMap));
}

/**
 * 拼出一份可以直接塞进 CONFIG.customMaps[id] 的地图数据：克隆 baseMap 的全部结构
 * （路径/建筑/技能覆写等一律照抄，编辑器这一批只改地形），只覆盖 id/label/navgrid。
 *
 * @param {object} baseMap  作为起点克隆的地图（内置或已有的自制地图）
 * @param {object} o        { id, label, n, bits }—— bits 是笔刷改完的 Uint8Array
 */
export function buildCustomMapPayload(baseMap, { id, label, n, bits, buildings }) {
  if (!id) throw new Error('buildCustomMapPayload: id 不能为空');
  const clone = cloneMapForEdit(baseMap);
  clone.id = id;
  clone.label = label || id;
  clone.navgrid = { n, bits: packBits(bits) };
  // 建筑摆放（阶段三剩余）：不传 buildings 时保持"整体克隆 baseMap 的建筑"这条
  // 参数化前的默认行为完全不变（见 docs/DEVELOPMENT.md §8.3），只有真的拖动过
  // 建筑、调用方显式传了草稿数组时才覆盖。
  if (Array.isArray(buildings)) clone.buildings = buildings;
  return clone;
}

// ==================== 建筑摆放（阶段三剩余）====================
// 设计报告 §3.2 阶段三待办项："Building placement (drag + arc-length snap to path)"
// + "real-time validation red lines"。判定算法一律调 src/data/mapValidate.js
// （唯一实现），这里只做"编辑器需要、但不属于几何校验本身"的胶水：克隆建筑数组、
// 拖拽落点吸附到兵线、挪动后返回新数组、把校验结果整理成 UI 好消费的形状。

/**
 * 深克隆一张地图的建筑数组，供编辑器拖拽而不污染原地图对象（同 cloneMapForEdit
 * 的理由：内置地图是模块级常量，被 MAPS 表和当前对局同时引用）。
 * @param {object} baseMap
 * @returns {object[]}
 */
export function cloneBuildingsForEdit(baseMap) {
  return JSON.parse(JSON.stringify(baseMap.buildings || []));
}

/**
 * 建筑拖拽到 (worldX, worldY) 时，实际应该落在哪——有 laneId 的建筑吸附到
 * 自己那条兵线上最近的一点（用户拖到哪都会被纠正回兵线上，不能允许分路建筑
 * 离开自己的路，否则又是"塔立在墙里"那个老坑的编辑器版）；没有 laneId 的建筑
 * （水晶枢纽等）不吸附，只夹在世界范围内，允许自由摆放。
 * @param {object} map 当前草稿地图（要有 lanes/world）
 * @param {object} building 被拖拽的建筑（读它的 laneId）
 * @param {number} worldX @param {number} worldY 拖拽点的世界坐标
 * @returns {{x:number,y:number}}
 */
export function snapBuildingPos(map, building, worldX, worldY) {
  const W = map.world || { w: 0, h: 0 };
  const clampX = Math.max(0, Math.min(W.w, worldX));
  const clampY = Math.max(0, Math.min(W.h, worldY));
  if (building.laneId) {
    const lane = map.lanes?.find(l => l.id === building.laneId);
    if (lane) return nearestPointOnPolyline(lane.waypoints, clampX, clampY);
  }
  return { x: clampX, y: clampY };
}

/**
 * 把 buildings[index] 的落点换成 pos，返回一份新数组（不改原数组——拖拽期间
 * 每帧都会调，调用方决定要不要把结果存回草稿状态；纯函数方便单测和撤销/重做）。
 * @param {object[]} buildings @param {number} index @param {{x:number,y:number}} pos
 * @returns {object[]}
 */
export function withBuildingMoved(buildings, index, pos) {
  return buildings.map((b, i) => (i === index ? { ...b, pos: { x: pos.x, y: pos.y } } : b));
}

/**
 * 对草稿建筑跑一遍 mapValidate.js 那套结构性校验，整理成编辑器能直接渲染
 * 红线/状态文字的形状。attackRange/attackTiers 不传时退回 CONFIG 里的软编码默认值
 * （调用方传自定义值是为了单测覆盖，不是产品需要另配一套数字）。
 * @param {object} draftMap 草稿地图（buildings 是当前正在编辑的数组）
 * @param {{attackRange?:number, attackTiers?:string[]}} [opts]
 * @returns {{symmetric:boolean, offLaneIds:Set<any>, spacingViolations:object[], crossViolations:object[], ok:boolean}}
 */
export function validateDraftMap(draftMap, opts = {}) {
  const attackRange = opts.attackRange ?? CONFIG.templates.tower.attackRange;
  const attackTiers = opts.attackTiers ?? CONFIG.mapEditor.validationAttackTiers;
  const buildings = draftMap.buildings || [];
  const symmetric = buildingCountsSymmetric(draftMap);
  const offLane = draftMap.walls?.corridorHalfWidth && !draftMap.useNavgrid
    ? buildings.filter(b => b.laneId && !buildingOnLaneOrInBase(draftMap, b))
    : [];
  const spacingViolations = attackTowerSpacingOk(draftMap, attackRange, attackTiers);
  const crossViolations = crossFactionTowerSpacingOk(draftMap, attackRange, attackTiers);
  return {
    symmetric,
    offLaneIds: new Set(offLane.map(b => b.id ?? buildings.indexOf(b))),
    spacingViolations,
    crossViolations,
    ok: symmetric && offLane.length === 0 && spacingViolations.length === 0 && crossViolations.length === 0,
  };
}
