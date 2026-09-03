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

// ==================== 档位自动识别（用户定稿："塔的层次也可以设置，最好弄个自动
// 识别这种"）====================
// 规则（用户原话）：一条路上有很多塔时，外防御塔只能有一个（原则上是最外侧），
// 召唤水晶前为水晶防御塔，水晶枢纽前面为枢纽防御塔，剩下的都是内塔（或者没有）。
//
// "最外侧/紧贴"不依赖弧长方向假设（沿折线哪一端是哪一方，各地图并不统一）——
// 直接量到本方【召唤水晶】的直线距离：同路同阵营的塔按这个距离排序，
// 离召唤水晶最近的是水晶防御塔，最远的是外塔，中间的都是内塔。
// 没有召唤水晶（编辑器里被删掉了，或地图本来就没有）时退回本方水晶枢纽做锚点；
// 两个锚点都没有就不改这条路（无法判断方向，保留原档位好过瞎猜）。
//
// 没有 laneId 的塔（不属于任何一条路）只有一种可能：枢纽防御塔——分路的四档
// （外/内/水晶防御塔/召唤水晶）按定义都必须挂在某条路上，水晶枢纽本身是识别的
// 起点不会被重新分类，排除这两者后，"没有路"在当前档位词表里只剩枢纽防御塔一种解释。
const _dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const _CHAIN_TIERS = new Set(['outer', 'inner', 'base']);

/**
 * 对整份草稿建筑跑一遍档位自动识别，返回一份新数组（不改原数组）。
 * 只重算"链上"的塔（当前档位是 outer/inner/base 之一）和"没有路"的塔（判给
 * 枢纽防御塔）——nexus_lane/nexus_main 是识别用的锚点，不会被这个函数改动，
 * 手动把某座塔的档位设成这两者也不会被自动识别悄悄改回去。
 * @param {object} map 草稿地图（要有 lanes）
 * @param {object[]} buildings 草稿建筑数组
 * @returns {object[]}
 */
export function autoDetectTiers(map, buildings) {
  const next = buildings.map(b => ({ ...b }));

  // ---- 分路链：outer/inner/base 按到本方召唤水晶（缺省水晶枢纽）的距离重排 ----
  const groups = new Map();
  next.forEach((b, i) => {
    if (!b.laneId || !_CHAIN_TIERS.has(b.tier)) return;
    const key = b.faction + '|' + b.laneId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const [key, idxs] of groups) {
    const [faction, laneId] = key.split('|');
    const anchor = next.find(b => b.faction === faction && b.laneId === laneId && b.tier === 'nexus_lane')
      || next.find(b => b.faction === faction && b.tier === 'nexus_main');
    if (!anchor) continue;   // 没有任何锚点，无法判断方向，保留原档位
    const sorted = [...idxs].sort((a, b) => _dist(next[a].pos, anchor.pos) - _dist(next[b].pos, anchor.pos));
    sorted.forEach((idx, rank) => {
      next[idx].tier = rank === 0 ? 'base' : (rank === sorted.length - 1 ? 'outer' : 'inner');
    });
  }

  // ---- 没有路的塔：枢纽防御塔（水晶枢纽本身按 tier 排除，不参与重分类） ----
  next.forEach(b => { if (!b.laneId && b.tier !== 'nexus_main') b.tier = 'hq_tower'; });

  return next;
}
