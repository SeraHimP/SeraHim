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
import { mapFactionsOf, laneSpawnsOf } from '../systems/FactionSystem.js';
import { neutralCampsOf } from '../systems/NeutralCampSystem.js';
export { nearestSegmentIndex } from './mapValidate.js';

/**
 * 主画面工具条（MapEditorBoardTool.js）要让草稿"所见即所得"，走的是编辑器已经在用
 * 的同一条落盘路径——存进 CONFIG.customMaps 再 mapSystem.loadMap()——只是自动存到
 * 这个保留 id 下，不需要用户手动填。这不是一张真正的自制地图，MapSystem.
 * getAvailableMaps() 与地图编辑器弹窗的"已保存的自制地图"列表都要认得这个 id
 * 并把它过滤掉，否则用户会在选图列表里看到一张自己从没存过、名字奇怪的"地图"。
 */
export const LIVE_EDIT_SESSION_MAP_ID = '__map_editor_live_session__';

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
export function buildCustomMapPayload(baseMap, {
  id, label, n, bits, buildings, baseCircleRadius, pits, lanes, factions, spawnEnabled,
  laneWaveCompositionByLane, neutralCamps, globalAura,
}) {
  if (!id) throw new Error('buildCustomMapPayload: id 不能为空');
  const clone = cloneMapForEdit(baseMap);
  clone.id = id;
  clone.label = label || id;
  clone.navgrid = { n, bits: packBits(bits) };
  // 建筑摆放（阶段三剩余）：不传 buildings 时保持"整体克隆 baseMap 的建筑"这条
  // 参数化前的默认行为完全不变（见 docs/DEVELOPMENT.md §8.3），只有真的拖动过
  // 建筑、调用方显式传了草稿数组时才覆盖。
  if (Array.isArray(buildings)) clone.buildings = buildings;
  // 区域参数表单（阶段四剩余）：同样只在真的编辑过时覆盖，不传就保持 baseMap 原值——
  // 这两项不像 buildings 有天然的"空数组也合法"歧义，用 undefined 判断是否传入即可。
  if (Number.isFinite(baseCircleRadius)) clone.baseCircleRadius = baseCircleRadius;
  if (pits) clone.pits = pits;
  // 兵路径编辑（阶段六）：同样的"不传就保留原值"规则。
  if (Array.isArray(lanes)) clone.lanes = lanes;
  // 阵营管理（第四节 Part A）：同样的"不传就保留原值"规则——map.factions 未声明时
  // mapFactionsOf() 兜底为 [blue,red]，克隆时不传这一项，行为与改动前逐位一致。
  if (Array.isArray(factions)) clone.factions = factions;
  // 出兵开关（第四节 Part A）：复用 LaneWaveSystem.js 已经在读的 map.spawnEnabled
  // 覆写机制（见该文件 `_mapSE` 那段注释），编辑器这里只是给它一个可视化入口，
  // 不是新发明一套开关。空对象也是合法值（等于"这张图不覆写任何兵种"），
  // 所以判断"是否传入"用 typeof 而不是"有没有键"。
  if (spawnEnabled && typeof spawnEnabled === 'object') clone.spawnEnabled = spawnEnabled;
  // 出兵编排（第四节 Part B）：复用 LaneWaveSystem.js 新接的 map.laneWaveCompositionByLane
  // 覆写层（见该文件 `_mapLWC` 那段注释）——同样"不传就保留原值"，空对象也是合法值
  // （编过但没给任何一条路配独立编排，仍然是"整张图不覆写"）。
  if (laneWaveCompositionByLane && typeof laneWaveCompositionByLane === 'object') {
    clone.laneWaveCompositionByLane = laneWaveCompositionByLane;
  }
  // 中立营地（第四节 Part D）：同样的"不传就保留原值"规则——未声明时
  // neutralCampsOf() 兜底成巨龙那份既定默认值，逐位不变。
  if (Array.isArray(neutralCamps)) clone.neutralCamps = neutralCamps;
  // 地图光环（2026-09-04 第五节）：同样的"不传就保留原值"规则。空 effects 数组
  // 也是合法值（这张图配了光环外壳但还没加任何效果，或者用户把效果全删了），
  // 所以判断"是否传入"用 typeof 而不是看 effects 是否非空——跟 spawnEnabled/
  // laneWaveCompositionByLane 同一个理由。
  if (globalAura && typeof globalAura === 'object') clone.globalAura = globalAura;
  return clone;
}

// ==================== 阵营管理（第四节 Part A：统一编辑器"配置模式"）====================
// 见 docs/REQUIREMENTS-2026-09-03.md 第四节、docs/REPORT-2026-09-03-multifaction.md。
// 数据模型跟 FactionSystem.js 的 mapFactionsOf() 保持一致：map.factions 是一个纯
// 字符串 id 数组，没有单独的显示名字段——本仓库现有三张地图从来没有过"阵营显示名"
// 这个概念（UI 上蓝方/红方是按 id 硬编码文案，不是从数据读的），这里不无中生有造
// 一个新字段，用户新增的阵营 id 本身就是它在各处列表里显示的样子。
//
// 3+ 阵营下的真实**渲染**（单位描边色/小地图光点色）目前仍会落到 SpriteFactory.js/
// UnitLayer.js 里"非 blue/red 就用灰色兜底"的分支——那一层的按阵营配色泛化没有做
// （不在这次范围内，属于设计报告里"中立野怪泛化"那个独立后续项目），这里保存出的
// 地图数据在**规则判定**上是完整可用的（canTarget/结构校验/记分/出兵目标筛选全部
// 走 mapFactionsOf()，已经是通用实现），只是新增阵营的单位在画面上暂时都是灰色。

/** 从一张地图克隆出阵营列表草稿，供编辑器增删。未声明时按 mapFactionsOf() 的两阵营兜底。 */
export function cloneFactionsForEdit(baseMap) {
  return [...mapFactionsOf(baseMap)];
}

/**
 * 新增一个阵营。id 去首尾空白、不能为空、不能与现有的重复（阵营 id 同时是
 * canTarget()/记分板/建筑归属的键，撞了会直接把两个阵营的数据混在一起算）。
 * @returns {string[]} 新数组（不修改输入）
 */
export function withFactionAdded(factions, id) {
  const clean = (id || '').trim();
  if (!clean) throw new Error('阵营 id 不能为空');
  if (factions.includes(clean)) throw new Error(`阵营「${clean}」已存在`);
  return [...factions, clean];
}

/**
 * 删除一个阵营。至少保留两个——单阵营的地图打不起来（canTarget 要求双方阵营不同），
 * 编辑器不应该允许存出一张必然打不起来的图。
 * @returns {string[]} 新数组（不修改输入）
 */
export function withFactionRemoved(factions, id) {
  if (factions.length <= 2) throw new Error('至少要保留两个阵营');
  return factions.filter(f => f !== id);
}

/**
 * 删除阵营时级联清理引用它的数据（用户定稿"删除阵营时级联全部删除相关数据"，
 * 见 docs/REPORT-2026-09-03-multifaction.md §9）：
 *   - 建筑：该阵营的塔/水晶直接删掉（留着一座没有阵营归属的塔没有意义）。
 *   - 兵线：不删整条路（路是地形层的物理连线，删了会把其它还在用这条路的阵营
 *     出兵也带崩），只摘掉引用了被删阵营的出兵流（laneSpawnsOf 展开后逐条过滤）。
 *     一条路摘完可能变成零出兵流，留空即可，不是错误状态——用户后续可以在
 *     配置模式里给这条路重新配出兵。
 * @returns {{buildings, lanes}} 新对象（不修改输入的 buildings/lanes 数组本身）
 */
export function pruneMapDataForRemovedFaction({ buildings, lanes }, removedId) {
  const nextBuildings = (buildings || []).filter(b => b.faction !== removedId);
  const nextLanes = (lanes || []).map((lane) => {
    if (!Array.isArray(lane.spawns)) return lane; // 没显式声明出兵流的路，兜底逻辑自己会跳过被删阵营，不用改
    // 出兵流本身（faction 就是被删阵营）整条摘掉——没有兵源了；只是**目标**里
    // 提到被删阵营（targetFactions 包含它）的，只摘掉那一个目标，其余目标阵营
    // 照打不误（一条路同时打两个阵营，删掉其中一个不该连另一个也停）。
    // 摘完 targetFactions 变空的出兵流（唯一目标就是被删阵营）才整条一起摘掉。
    const spawns = laneSpawnsOf(lane)
      .filter(s => s.faction !== removedId)
      .map(s => ({ ...s, targetFactions: (s.targetFactions || []).filter(f => f !== removedId) }))
      .filter(s => s.targetFactions.length > 0);
    return { ...lane, spawns };
  });
  return { buildings: nextBuildings, lanes: nextLanes };
}

// ==================== 区域参数（阶段四剩余）====================
// 设计报告把"区域参数表单"（龙坑/男爵坑中心+半径、基地圈半径）与"画线造墙/去毛刺"
// 分开列为阶段四的两个独立子项——前者是纯数值表单，复用 MapSystem.getPit()/
// getBaseCircleRadius() 已经在读的 map.pits / map.baseCircleRadius 字段，不需要新的
// 数据模型；后者是全新的折线栅格化+连通域降噪算法，工作量和风险都大得多，留到下一批。
//
// 为什么不能像 draftBuildings 那样直接改 baseMap 的字段：baseMap 在 MapEditorDialog.js
// 里是 mapSystem.getMapById() 返回的**直接引用**（MAPS 表的内置常量或 CONFIG.customMaps
// 里已存的自制地图），不是克隆——直接写 baseMap.pits.baron.x 会当场污染共享数据，
// 与本仓库反复强调的"currentMap 是直接引用，绝不能就地改"是同一个坑。
// 所以这里跟 draftBuildings 一样，走"克隆出一份独立草稿 → 表单改草稿 → 保存时随
// buildCustomMapPayload 一起落盘"的路子。

/**
 * 从一张地图克隆出区域参数草稿（供表单编辑，不污染 baseMap 原对象）。
 * baseCircleRadius 缺省地图（理论上不存在，所有内置地图都声明了）用 null 占位，
 * 表单据此显示空输入框而不是误导性的 0。
 * @param {object} baseMap
 * @returns {{baseCircleRadius:number|null, pits:object}}
 */
export function cloneRegionsForEdit(baseMap) {
  return {
    baseCircleRadius: Number.isFinite(baseMap.baseCircleRadius) ? baseMap.baseCircleRadius : null,
    pits: baseMap.pits ? JSON.parse(JSON.stringify(baseMap.pits)) : {},
  };
}

/**
 * 给"启用龙坑/男爵坑"勾选框新增一个坑时的默认位置——地图世界中心，按龙/男爵各偏移
 * 一点（呼应 sr_navgrid.js 里 SR_PITS 的几何直觉：男爵在偏左上那半，龙在偏右下那半，
 * 但这里不依赖河道采样，纯粹给用户一个可见、能直接拖表单数值微调的起点，不追求精确)。
 * @param {object} map 需要有 world
 * @param {'baron'|'dragon'} name
 * @returns {{x:number,y:number,r:number,depth:number}}
 */
export function defaultPitFor(map, name) {
  const W = map.world || { w: 0, h: 0 };
  const offset = name === 'baron' ? -0.15 : 0.15;
  return {
    x: W.w / 2 + offset * W.w,
    y: W.h / 2 + offset * W.h,
    r: 150,
    depth: -26,
  };
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
 * 挪动一座【已有】建筑时的落点——只夹世界边界，不管有没有 laneId 都不吸附到兵线上
 * （用户定稿："移动塔只能沿着某线运动，修复为可以随意移动"）。
 * 与 snapBuildingPos 是两个不同的场景，不是同一个函数改参数：snapBuildingPos 服务的是
 * "新增一座塔时就近吸附到最近的路"（阶段四"添加塔"工具仍在用，这个默认值本身没问题，
 * 用户没提意见）；这个函数服务的是"挪动一座已经放好的塔"，用户明确要求这里不该被强制
 * 拘束在线上。落错位置由已有的结构校验红线去提示，不再靠拖拽本身强行拦。
 * @param {object} map 需要有 world
 * @param {number} worldX @param {number} worldY
 * @returns {{x:number,y:number}}
 */
export function freeBuildingPos(map, worldX, worldY) {
  const W = map.world || { w: 0, h: 0 };
  return { x: Math.max(0, Math.min(W.w, worldX)), y: Math.max(0, Math.min(W.h, worldY)) };
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

// ==================== 兵路径编辑（阶段六）====================
// 设计报告把这一批列为独立阶段——路点/整条路的增删动的是 map.lanes，这份数据不只是
// 画面上一条线：LaneMovementSystem/LaneWaveSystem 靠它算小兵怎么走，snapBuildingPos
// 靠它算建筑吸附点，mapValidate.js 的间距/对称校验也全部读它。改动面比"往 navgrid
// 位图上刷格子"大得多，所以单独放在地形笔刷/建筑摆放/区域参数表单全部做完之后再做。
//
// 与 draftBuildings 同样的理由，这里也不能直接改 baseMap.lanes（那是 mapSystem.
// getMapById() 的直接引用，可能是内置地图常量或已存的自制地图）——一律走"克隆出草稿
// →改草稿→保存时随 buildCustomMapPayload 一起落盘"这条路。

/** 深克隆一张地图的路径数组，供编辑器改动而不污染原地图对象。 */
export function cloneLanesForEdit(baseMap) {
  return JSON.parse(JSON.stringify(baseMap.lanes || []));
}

/**
 * 把 laneId 那条路的第 index 个路点挪到 pos，返回一份新的 lanes 数组（不改原数组，
 * 拖拽期间每帧都会调，纯函数方便单测和撤销/重做，与 withBuildingMoved 同一套约定）。
 */
export function withWaypointMoved(lanes, laneId, index, pos) {
  return lanes.map(l => (l.id !== laneId ? l : {
    ...l,
    waypoints: l.waypoints.map((wp, i) => (i === index ? { x: pos.x, y: pos.y } : wp)),
  }));
}

/**
 * 在 laneId 那条路的第 afterIndex 个路点之后插入一个新路点（新点下标 = afterIndex+1）。
 * 用于"点在路径中段的空白处"这个交互——把新点插进最近那一段的两端之间，而不是追加到
 * 整条路的末尾（追加到末尾会让路径突然拐个大弯，不是用户想要的"在这里加个弯"）。
 */
export function withWaypointInserted(lanes, laneId, afterIndex, pos) {
  return lanes.map(l => (l.id !== laneId ? l : {
    ...l,
    waypoints: [...l.waypoints.slice(0, afterIndex + 1), { x: pos.x, y: pos.y }, ...l.waypoints.slice(afterIndex + 1)],
  }));
}

/**
 * 删除 laneId 那条路的第 index 个路点。少于等于 2 个点时拒绝删除（返回原数组不变）——
 * 一条路至少要有起点和终点两个点才成路，删到只剩 1 个点会让这条路失去方向，
 * LaneMovementSystem 沿着它算出的行进方向没有意义。
 */
export function withWaypointRemoved(lanes, laneId, index) {
  return lanes.map(l => {
    if (l.id !== laneId || l.waypoints.length <= 2) return l;
    return { ...l, waypoints: l.waypoints.filter((_, i) => i !== index) };
  });
}

/**
 * 新增一条路。id 已存在时抛错（不是静默覆盖——"新增"和"改名顶替一条已有的路"
 * 是两个不同的用户意图，静默覆盖会在用户没意识到的情况下丢掉一条路的既有数据）。
 * @param {object[]} lanes @param {{id:string, waypoints:{x:number,y:number}[]}} lane
 */
export function withLaneAdded(lanes, lane) {
  if (lanes.some(l => l.id === lane.id)) throw new Error(`withLaneAdded: 路 id 已存在：${lane.id}`);
  return [...lanes, lane];
}

/** 删除一整条路。调用方负责在删之前检查这条路上还有没有建筑（见 laneBuildingCount）。 */
export function withLaneRemoved(lanes, laneId) {
  return lanes.filter(l => l.id !== laneId);
}

/**
 * 有多少座建筑的 laneId 指向这条路——编辑器删除整条路之前用它判断"删了会不会留下
 * 一堆找不到路的孤儿建筑"，不适合静默删，也不适合在这里自作主张连带删掉那些建筑
 * （建筑摆放是另一个独立的编辑模式，删建筑该是用户在那边显式做的操作）。
 * @param {object[]} buildings @param {string} laneId
 * @returns {number}
 */
export function laneBuildingCount(buildings, laneId) {
  return buildings.filter(b => b.laneId === laneId).length;
}

// ==================== 出兵编排（第四节 Part B：地图独立的按路编排）====================
// 见 docs/REQUIREMENTS-2026-09-03.md 第四节、src/data/waveComposition.js 头注。
// 数据形状跟 CONFIG.gameRules.laneWaveCompositionByLane[laneId] 一模一样（一条路
// 一份规则数组，每条规则 {type,count,fromWave,everyN,when?,whenArg?}）——
// compositionFor() 早就认这一层（阵营独立编排之下、共享基准之上，见该函数头注
// 的四级解析顺序），这里只是把它从"只能在全局 CONFIG 里改"接到"可以按地图存"，
// 判定逻辑一处没动（LaneWaveSystem.js 的 `_mapLWC` 合并块）。
// 这几个函数只管"改一份规则数组"，不关心它挂在哪条路——挂哪条路是调用方
// （编辑器 UI）通过 `draftLaneComposition[laneId] = withRuleXxx(...)` 决定的。

/**
 * 新增一条规则到队尾（拖拽编排"新增"永远加在最后，用户再拖到想要的位置）。
 * @returns {object[]} 新数组（不修改输入）
 */
export function withRuleAdded(rules, rule) {
  return [...rules, rule];
}

/** 删除指定下标的规则。@returns {object[]} 新数组（不修改输入） */
export function withRuleRemoved(rules, index) {
  return rules.filter((_, i) => i !== index);
}

/**
 * 把某条规则从一个位置挪到另一个位置（拖拽排序落点用）——这就是"出兵顺序改
 * 拖拽编排"里"顺序"两个字的全部实现：数组下标就是出兵顺序，不需要额外的
 * "序号"字段。
 * @returns {object[]} 新数组（不修改输入）
 */
export function withRuleMoved(rules, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= rules.length) return [...rules];
  const next = [...rules];
  const [moved] = next.splice(fromIndex, 1);
  const clampedTo = Math.max(0, Math.min(next.length, toIndex));
  next.splice(clampedTo, 0, moved);
  return next;
}

/**
 * 改某条规则的某个字段（数量/起始波次/每几波一次/兵种/条件……）。
 * @returns {object[]} 新数组（不修改输入，也不修改被改的那条规则本身）
 */
export function withRuleFieldSet(rules, index, field, value) {
  return rules.map((r, i) => (i === index ? { ...r, [field]: value } : r));
}

/**
 * 出兵条件重做（2026-09-04）：整体替换某条规则的"生效条件"组合，写 whenItems/
 * whenOp（见 waveComposition.js 的 conditionItemsOf/whenPasses 头注），并清掉
 * 旧写法的 when/whenArg —— 编辑器一旦碰过"生效条件"这块 UI 就统一按新写法存，
 * 不留两套字段互相打架（whenPasses 优先认 whenItems，留着旧字段不会读错，
 * 但会让下一个看导出 JSON 的人以为这条规则还是旧写法）。
 * whenItems 为空（用户把所有条件都删掉了）时连 whenItems/whenOp 一起删掉，
 * 退回"没有条件字段=总是生效"这个两种写法共通的兜底状态，不留一个空数组占位。
 * @returns {object[]} 新数组（不修改输入，也不修改被改的那条规则本身）
 */
export function withRuleConditionsSet(rules, index, whenItems, whenOp) {
  return rules.map((r, i) => {
    if (i !== index) return r;
    const next = { ...r };
    delete next.when;
    delete next.whenArg;
    if (Array.isArray(whenItems) && whenItems.length) {
      next.whenItems = whenItems;
      next.whenOp = whenOp === 'or' ? 'or' : 'and';
    } else {
      delete next.whenItems;
      delete next.whenOp;
    }
    return next;
  });
}

// ==================== 中立营地（第四节 Part D：统一编辑器"配置模式"）====================
// 见 systems/NeutralCampSystem.js 头注。这里只是给编辑器一套克隆/增删改的纯函数，
// 跟阵营/出兵编排那两节是同一个套路——数据形状的唯一权威定义在 NeutralCampSystem.js，
// 这里不重新定义一遍，只操作它。

/** 从一张地图克隆出中立营地草稿（没声明时带出 neutralCampsOf() 合成的默认值）。 */
export function cloneNeutralCampsForEdit(baseMap) {
  return JSON.parse(JSON.stringify(neutralCampsOf(baseMap)));
}

/** 改某个营地某个出生点的某个字段（x/y/laneMatch/direction）。@returns 新数组 */
export function withCampSpawnPointFieldSet(camps, campId, spIndex, field, value) {
  return camps.map((c) => {
    if (c.id !== campId) return c;
    const spawnPoints = c.spawnPoints.map((sp, i) => {
      if (i !== spIndex) return sp;
      if (field === 'x' || field === 'y') {
        const pit = { ...(sp.pit || {}), [field]: value };
        // 一旦用户手动编辑坐标，这个出生点就有了自己的坐标，不再间接指向
        // baron/dragon 这类共享坑位——否则改了 x 却因为 pitRef 还在，下次
        // 解析时又被 pitRef 指向的坐标顶回去，表现成"改了但存不住"。
        const { pitRef, ...rest } = sp;
        return { ...rest, pit };
      }
      return { ...sp, [field]: value };
    });
    return { ...c, spawnPoints };
  });
}

/** 给指定营地新增一个出生点（默认坐标由调用方传入，比如画布中心）。@returns 新数组 */
export function withCampSpawnPointAdded(camps, campId, spawnPoint) {
  return camps.map(c => (c.id === campId ? { ...c, spawnPoints: [...c.spawnPoints, spawnPoint] } : c));
}

/**
 * 删除指定营地的一个出生点。至少保留一个——删到零个出生点的营地形同虚设
 * （生成器查不到任何位置，等于这个营地虽然还在列表里但从不出生），编辑器不该
 * 允许存出这种"看着有、其实是死的"配置。
 * @returns 新数组
 */
export function withCampSpawnPointRemoved(camps, campId, spIndex) {
  return camps.map((c) => {
    if (c.id !== campId) return c;
    if (c.spawnPoints.length <= 1) throw new Error('每个营地至少要保留一个出生点');
    return { ...c, spawnPoints: c.spawnPoints.filter((_, i) => i !== spIndex) };
  });
}

// ==================== 兵线自动对齐（2026-09-04 第二节）====================
// 用户："蓝方下路的兵线，在路上有些偏上。正常的下路兵线应该是在下路的路中央。"
// 用一个垂直于局部切线方向、在 navgrid 上双向探测可行走边界的算法核实过：
// 召唤师峡谷上/下路贴着地图边界走的直线段，路点确实一致地偏离走廊横截面
// 中点 1~4 格（256 分辨率下约 14~55 世界单位），量级不大但方向一致，跟用户
// "有些偏"的描述吻合；而路点数组里靠近基地的转角/开阔地那几个点，用同一个
// 算法量出来的"偏移"高达 20+ 格——那不是真的偏了，是那一段地形本来就是
// 开阔广场，两侧很远才碰到墙，"走廊中点"这个概念在开阔地根本不成立，量出来
// 的大偏移是算法在开阔地失真，不是真实问题。
//
// 所以关键设计是**搜索半径设上限**（默认 15 格）：窄直线段两侧都能在这个
// 半径内碰到真墙，判定可信，居中生效；开阔地两侧都碰不到墙，直接跳过不碰——
// 一个算法，自动区分"该修的窄段"和"不该碰的开阔地"，不需要额外传参告诉它
// 哪几个点是转角。

/**
 * 把一条路的中间路点（跳过首尾——那两个锚定基地/水晶，编辑器路径模式里
 * "拖动路点"本来就不让拖首尾，这里保持同一条规矩）沿垂直于局部切线的方向，
 * 吸附到 navgrid 可行走走廊的横截面中点。
 * @param {Uint8Array} bits navgrid 位图（0/1，n×n，见 navgrid.js unpackBits）
 * @param {number} n navgrid 分辨率
 * @param {{w:number,h:number}} world 地图世界尺寸（世界坐标→格子坐标换算用，
 *   与 MapEditorDialog.js 的 worldToGrid 同一条规则：gx = x/W.w*n）
 * @param {{x:number,y:number}[]} waypoints
 * @param {{maxRadius?:number}} [opts] maxRadius：单侧搜索上限格数，默认 15——
 *   两侧都在这个半径内摸到墙才算"窄走廊，可信、居中"，任一侧摸不到墙
 *   （开阔地）就跳过这个点，原样保留，不瞎猜。
 * @returns {{x:number,y:number}[]} 新数组（不修改输入）
 */
export function alignLaneToCorridor(bits, n, world, waypoints, opts = {}) {
  const maxRadius = opts.maxRadius ?? 15;
  const W = world?.w || 1, H = world?.h || 1;
  const toGrid = (x, y) => ({ gx: x / W * n, gy: y / H * n });
  const toWorld = (gx, gy) => ({ x: gx / n * W, y: gy / n * H });
  const isWalkable = (gx, gy) => {
    const x = Math.round(gx), y = Math.round(gy);
    if (x < 0 || y < 0 || x >= n || y >= n) return false;
    return !!bits[y * n + x];
  };
  return waypoints.map((wp, i) => {
    if (i === 0 || i === waypoints.length - 1) return wp;
    const prev = waypoints[i - 1], next = waypoints[i + 1];
    const g = toGrid(wp.x, wp.y);
    const gPrev = toGrid(prev.x, prev.y), gNext = toGrid(next.x, next.y);
    const dx = gNext.gx - gPrev.gx, dy = gNext.gy - gPrev.gy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = -dy / len, uy = dx / len; // 垂直方向单位向量（格子空间）
    // 路点本身若恰好落在不可走格（贴边/取整误差导致的边界抖动），先找最近的
    // 可走格当参照点——不然两侧从原地探墙立刻失败（0=0），会被误判成"已经
    // 居中"，实际上这个点根本不在走廊里，是最该修的情形。
    let originS = 0;
    if (!isWalkable(g.gx, g.gy)) {
      let found = null;
      for (let s = 1; s <= maxRadius; s++) {
        if (isWalkable(g.gx + ux * s, g.gy + uy * s)) { found = s; break; }
        if (isWalkable(g.gx - ux * s, g.gy - uy * s)) { found = -s; break; }
      }
      if (found === null) return wp; // 附近整片都不可走（异常数据），不瞎猜，原样保留
      originS = found;
    }
    const ox = g.gx + ux * originS, oy = g.gy + uy * originS;
    let posEdge = maxRadius, negEdge = maxRadius;
    for (let s = 0; s < maxRadius; s++) { if (!isWalkable(ox + ux * s, oy + uy * s)) { posEdge = s; break; } }
    for (let s = 0; s < maxRadius; s++) { if (!isWalkable(ox - ux * s, oy - uy * s)) { negEdge = s; break; } }
    if (posEdge >= maxRadius || negEdge >= maxRadius) return wp; // 开阔地，任一侧没摸到墙就不碰
    const offset = originS + (posEdge - negEdge) / 2;
    if (Math.abs(offset) < 0.5) return wp; // 已经居中（半格以内），不用挪
    const ng = { gx: g.gx + ux * offset, gy: g.gy + uy * offset };
    return toWorld(ng.gx, ng.gy);
  });
}

// ==================== 地图光环（2026-09-04 第五节：三种数值模式）====================
// 见 systems/AuraValueResolver.js 头注（三种模式的力学定义、为什么没有显式 mode
// 字段——沿用 MapSystem._applyGlobalAura 原有的"看字段推断"风格）。这里跟中立
// 营地那节同一个套路：数据形状的唯一权威定义在 AuraValueResolver.js，这里只给
// 编辑器一套克隆/增删改的纯函数，不重新定义数值怎么算。

/** 从一张地图克隆出光环草稿（没声明 globalAura 时给一个空壳，不是 null——
 *  编辑器表单要有东西可渲染，"这张图没有光环"和"光环字段是 null/undefined"
 *  不该是两种要分别处理的状态）。 */
export function cloneGlobalAuraForEdit(baseMap) {
  const aura = baseMap?.globalAura;
  if (aura) return JSON.parse(JSON.stringify(aura));
  return { name: '', icon: '🌐', effects: [] };
}

/** 改光环整体的字段（name/icon）。@returns 新对象 */
export function withAuraFieldSet(aura, field, value) {
  return { ...aura, [field]: value };
}

/** 新增一条效果，默认固定值模式（数值 0，等用户自己填）。@returns 新对象 */
export function withAuraEffectAdded(aura, effect) {
  return { ...aura, effects: [...(aura.effects || []), effect] };
}

/** 删除第 idx 条效果。@returns 新对象 */
export function withAuraEffectRemoved(aura, idx) {
  return { ...aura, effects: aura.effects.filter((_, i) => i !== idx) };
}

/** 改第 idx 条效果的单个字段（statKey/label/flat/percent/perMinute/max）。@returns 新对象 */
export function withAuraEffectFieldSet(aura, idx, field, value) {
  return { ...aura, effects: aura.effects.map((e, i) => (i === idx ? { ...e, [field]: value } : e)) };
}

/**
 * 切换第 idx 条效果的数值模式。三种模式各自认的字段不重叠（固定值：flat/percent；
 * 渐进：perMinute/max；分阶段：stages），切换时把上一个模式的专属字段清掉、
 * 换上新模式的默认字段——不然编辑器里改完"固定值"又切到"渐进"，effect 对象上
 * 同时挂着 flat 和 perMinute 两组字段，MapSystem._applyGlobalAura 那边"看字段
 * 推断模式"的判断顺序（stages > perMinute > flat）会让残留字段悄悄决定行为，
 * 界面显示的模式和实际生效的模式对不上。
 * 分阶段模式默认给一条 `when:''`（永远成立）的兜底阶段——不给的话所有条件都
 * 不满足时 resolveAuraEffectValue() 会退回 flat:0，界面上看着配了光环、场上
 * 却什么都没生效，找起来最费劲的那类"看着对却不生效"。
 * @returns 新对象
 */
export function withAuraEffectModeSet(aura, idx, mode) {
  return {
    ...aura,
    effects: aura.effects.map((e, i) => {
      if (i !== idx) return e;
      const { statKey, label } = e;
      if (mode === 'gradual') return { statKey, label, perMinute: 0, max: undefined };
      if (mode === 'staged') return { statKey, label, stages: [{ when: '', flat: 0 }] };
      return { statKey, label, flat: 0, percent: undefined };
    }),
  };
}

/** 给第 effectIdx 条效果新增一个分阶段。@returns 新对象 */
export function withAuraStageAdded(aura, effectIdx, stage) {
  return {
    ...aura,
    effects: aura.effects.map((e, i) => (i === effectIdx ? { ...e, stages: [...(e.stages || []), stage] } : e)),
  };
}

/**
 * 删除第 effectIdx 条效果的第 stageIdx 个阶段。至少保留一个——删到零个阶段的
 * 分阶段效果，resolveAuraEffectValue() 会因为 `stages` 数组存在但为空而直接
 * 走"不算 stages 分支"（`Array.isArray && length` 判据），退化成固定值 0，
 * 界面上还显示"分阶段模式"、实际却是个恒为 0 的死效果，同上一条的踩坑理由。
 * @returns 新对象
 */
export function withAuraStageRemoved(aura, effectIdx, stageIdx) {
  return {
    ...aura,
    effects: aura.effects.map((e, i) => {
      if (i !== effectIdx) return e;
      if ((e.stages || []).length <= 1) throw new Error('分阶段模式至少要保留一个阶段');
      return { ...e, stages: e.stages.filter((_, si) => si !== stageIdx) };
    }),
  };
}

/** 改第 effectIdx 条效果第 stageIdx 个阶段的单个字段（when/whenArg/flat/percent）。@returns 新对象 */
export function withAuraStageFieldSet(aura, effectIdx, stageIdx, field, value) {
  return {
    ...aura,
    effects: aura.effects.map((e, i) => {
      if (i !== effectIdx) return e;
      return { ...e, stages: e.stages.map((st, si) => (si === stageIdx ? { ...st, [field]: value } : st)) };
    }),
  };
}
