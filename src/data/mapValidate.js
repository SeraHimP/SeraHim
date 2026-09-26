import { baseCircleCenter, isInBaseOpen } from './baseCircle.js';
import { mapFactionsOf } from '../systems/FactionSystem.js';

/**
 * mapValidate.js —— 地图几何校验的**唯一**实现。
 *
 * 背景：点到折线距离、弧长投影、基地圈内外判定、塔间距规则……这几段算法
 * 原来在 tests/sim_maps.mjs / sim_abyss.mjs / sim_v40.mjs 里各抄了一份
 * （sim_abyss.mjs 甚至是"折线只有两个点"的特化版，数学上和通用版完全一样）。
 * 三份实现互相之间没有任何约束，改一处不会带另外两处——这正是本项目一贯在防的
 * "同一件事有两份实现，迟早互相漂移"。
 *
 * 现在这里是唯一实现，三个测试文件改成调用本模块；地图编辑器（阶段三）
 * 画实时校验红线时也调用这里，保证"编辑器画的红线"和"发布前跑的验收"
 * 用的是同一套判定，不会出现"编辑器说没问题、跑测试才发现越界"。
 *
 * 所有函数都是纯函数：不读全局状态，不碰 DOM/Three.js，方便单测和在编辑器里复用。
 */

/** 点到点距离 */
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/**
 * 把 (x,y) 投影到折线上最近的一点，一次算出距离/弧长/投影坐标三件套。
 * distToPolyline / arcLengthAt / nearestPointOnPolyline 都是这一份投影的不同切面——
 * 拆开各写一份就会变成三份"点到折线"的重复实现，恰好是本模块本身要防的那种漂移。
 *
 * 对外导出给 LaneMovementSystem.js 单独调用：小兵的 pure-pursuit 转向方向要用
 * "投影点→前瞻点"这段纯切线向量（见 lookaheadOnPolyline 的头注），不能用
 * "小兵当前位置→前瞻点"（那会把小兵在走廊内的侧向偏移也当成转向分量，见下）。
 */
export function projectOntoPolyline(waypoints, x, y) {
  let acc = 0, best = Infinity, bestS = 0, bestX = waypoints[0]?.x ?? x, bestY = waypoints[0]?.y ?? y, bestSeg = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L2));
    const px = a.x + t * vx, py = a.y + t * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) { best = d; bestS = acc + t * Math.sqrt(L2); bestX = px; bestY = py; bestSeg = i; }
    acc += Math.sqrt(L2);
  }
  return { dist: best, s: bestS, x: bestX, y: bestY, seg: bestSeg };
}

/**
 * 点到折线的最短距离（与 MapSystem._nearestOnLane 同一算法）。
 * waypoints 只有 2 个点时就是"点到线段"距离——sim_abyss.mjs 原来的特化版
 * 其实就是这个通用算法的单段情形，数学上完全一致。
 * @param {{x:number,y:number}[]} waypoints
 * @param {number} x @param {number} y
 * @returns {number}
 */
export function distToPolyline(waypoints, x, y) {
  return projectOntoPolyline(waypoints, x, y).dist;
}

/**
 * v58：该点到"最近一条兵线"的距离——森林风格地图的"走廊 vs 野区"二分（渲染层的
 * TerrainLayer 地面着色、VegetationLayer 植被摆放）共用同一份实现，不各写一份
 * 各投影一次 map.lanes，避免本模块头注说的那种"同一件事两份实现迟早互相漂移"。
 * 没有声明 lanes 的地图返回 Infinity（永远判"离兵线很远"，调用方应先检查
 * map.lanes 是否存在，不能只靠这个返回值兜底所有情形）。
 * @param {object} map 地图定义，读它的 lanes 字段
 * @param {number} x @param {number} y
 * @returns {number}
 */
export function nearestLaneDist(map, x, y) {
  let d = Infinity;
  for (const lane of map.lanes || []) {
    const dd = distToPolyline(lane.waypoints, x, y);
    if (dd < d) d = dd;
  }
  return d;
}

/**
 * v51.19：nearestLaneDist 的姊妹函数——只要距离时用上面那个，要知道"离哪条兵线
 * 最近"时用这个。distToPolyline 本身坐标系无关（只认传进去的数字），所以这里
 * 接一个可选的 transform：调用方点选发生在哪个坐标系（世界坐标 / navgrid 格子
 * 坐标），就把 waypoint 先投到那个坐标系再比距离——地图编辑器的缩略图点选和
 * 模板编辑器（pagesWave.js）要搬的同一套交互都建在 navgrid 的 n×n 格子空间里
 * （非正方形世界下格子空间的"最近"和世界空间的"最近"不是同一个答案，
 * 见 navgrid.js canvasDisplaySize() 头注），不加这层间接就得各写一份找最近路的循环。
 * 没有声明 lanes 的地图返回 null。
 * @param {object} map @param {number} x @param {number} y
 * @param {(wp:{x:number,y:number})=>{x:number,y:number}} [transform] 默认原样透传（世界坐标）
 * @returns {string|null}
 */
export function nearestLaneId(map, x, y, transform = (p) => p) {
  let d = Infinity, id = null;
  for (const lane of map.lanes || []) {
    const dd = distToPolyline(lane.waypoints.map(transform), x, y);
    if (dd < d) { d = dd; id = lane.id; }
  }
  return id;
}

/**
 * v58：单点判定"路"还是"野区"——离最近兵线够近，或者落在己方基地开放圈内，
 * 两条判据取或。是 classifyLaneCells（批量/网格版）与 BoundaryDecorLayer
 * （连续坐标逐点采样版）共用的**唯一**判据实现，不在两处各写一份。
 * @param {object} map
 * @param {number} x @param {number} y
 * @returns {boolean} true=路，false=野区
 */
// v59.2：道路视觉宽窄有机变化——用户看了 GPT 对第一版森林风格截图的评价后定的
// 方向之一（P0 提案第3条："道路太像画出来的……做宽窄变化"）。用两个不同频率、
// 不同轴向的正弦波叠加代替按格哈希——哈希是给散点装饰用的（要的是"每个点互不
// 相关"），这里要的是沿着路连续、平滑地变宽变窄，用哈希会变成锯齿状抖动而不是
// 自然的宽窄起伏。只影响渲染层怎么画这条路（isLaneCell 只是视觉分类，
// navgrid/寻路/兵线路点逐位不变——用户确认过"只要不影响寻路/兵线"可以调）。
function laneWidthNoise(x, y) {
  return Math.sin(x * 0.0021 + y * 0.0013) * 0.5 + Math.sin(x * 0.0009 - y * 0.0027) * 0.5;
}

export function isLaneCell(map, x, y) {
  const baseHalfWidth = map.walls?.corridorHalfWidth ?? 130;
  const laneHalfWidth = baseHalfWidth * (1 + laneWidthNoise(x, y) * 0.18);   // ±18% 的有机宽窄
  return nearestLaneDist(map, x, y) <= laneHalfWidth || isInBaseOpen(map, x, y);
}

// v59：森林深度分级的带宽——从"离兵线够近/够远"这一刀切，改成沿离兵线距离
// 分四档（道路/林缘/普通森林/深林），颜色、高度、植被密度一起逐档加深/加高。
// 用户反馈原话："没有峡谷的空间结构，只有峡谷的颜色"——纯色块二分读不出层次，
// 分级才能让"越往野区深处走越密越暗"这件事同时体现在地面色、地形高度、植被
// 三处，而不是三处各判各的、各自另起一套阈值。
const FOREST_EDGE_WIDTH = 150;     // 林缘带宽度：紧贴道路边缘的过渡带
const FOREST_NORMAL_WIDTH = 400;   // 普通森林带宽度（从道路边缘往外算）；再往外算深林

/**
 * v59：单点森林深度分级——TerrainLayer 的地面着色、MapSystem.heightAt 的轻微
 * 地形梯度、VegetationLayer 的植被密度/类型选择三处共用同一份分级，避免"地面
 * 颜色说这里是深林、植被却按普通森林的密度长"这种三方各判各的漂移。
 * @param {object} map
 * @param {number} x @param {number} y
 * @returns {0|1|2|3} 0=道路(含基地开放圈) 1=林缘 2=普通森林 3=深林
 */
export function forestZoneAt(map, x, y) {
  if (isLaneCell(map, x, y)) return 0;
  const laneHalfWidth = map.walls?.corridorHalfWidth ?? 130;
  const d = nearestLaneDist(map, x, y) - laneHalfWidth;   // 到走廊边缘（不是中线）的距离
  if (d <= FOREST_EDGE_WIDTH) return 1;
  if (d <= FOREST_NORMAL_WIDTH) return 2;
  return 3;
}

/**
 * v59：把一份可走网格的每一格分类成森林深度档位（0~3，见 forestZoneAt）——
 * 网格版，TerrainLayer 的地面着色要按格批量取值，不能每像素都单独调一次
 * nearestLaneDist（性能上也吃不消，256×256 网格 = 6.5 万次多边形投影）。
 * @param {object} map
 * @param {Uint8Array|number[]} paint 该分辨率下的可走位图（真值=可走）
 * @param {number} nx @param {number} ny 网格分辨率（paint 长度 = nx*ny，行优先）
 * @returns {Uint8Array|null} 与 paint 同长度，值 0~3，只在 paint[k] 为真时有意义；
 *   地图没有声明 lanes 时返回 null（调用方各自决定怎么兜底）
 */
export function forestZoneCells(map, paint, nx, ny) {
  if (!Array.isArray(map.lanes) || !map.lanes.length || !map.world) return null;
  const { w: WW, h: WH } = map.world;
  const cellW = WW / nx, cellH = WH / ny;
  const out = new Uint8Array(nx * ny);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const k = gy * nx + gx;
      if (!paint[k]) continue;
      const wx = (gx + 0.5) * cellW, wy = (gy + 0.5) * cellH;
      out[k] = forestZoneAt(map, wx, wy);
    }
  }
  return out;
}

/**
 * v58：把一份可走网格的每一格分类成"路"(1)还是"野区"(0)——森林风格地图的
 * 走廊/野区二分。TerrainLayer 的地面着色、BoundaryDecorLayer 的边界围墙摆放
 * 都要用**同一份**分类结果，不能各算各的：判据本身已经收在 isLaneCell 里，
 * 这里只是把它铺到网格上，避免以后改一条判据只改了一处就会读出两种"哪里
 * 是路"的答案，围墙会摆在跟地面颜色不一致的地方。
 * @param {object} map
 * @param {Uint8Array|number[]} paint 该分辨率下的可走位图（真值=可走）
 * @param {number} nx @param {number} ny 网格分辨率（paint 长度 = nx*ny，行优先）
 * @returns {Uint8Array|null} 与 paint 同长度，1=路/0=野区，只在 paint[k] 为真时
 *   有意义；地图没有声明 lanes 时返回 null（调用方各自决定怎么兜底）
 */
export function classifyLaneCells(map, paint, nx, ny) {
  if (!Array.isArray(map.lanes) || !map.lanes.length || !map.world) return null;
  const { w: WW, h: WH } = map.world;
  const cellW = WW / nx, cellH = WH / ny;
  const out = new Uint8Array(nx * ny);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const k = gy * nx + gx;
      if (!paint[k]) continue;
      const wx = (gx + 0.5) * cellW, wy = (gy + 0.5) * cellH;
      out[k] = isLaneCell(map, wx, wy) ? 1 : 0;
    }
  }
  return out;
}

/**
 * 沿折线的弧长位置（取最近投影点处的累计长度）。
 * @param {{x:number,y:number}[]} waypoints
 * @param {number} x @param {number} y
 * @returns {number}
 */
export function arcLengthAt(waypoints, x, y) {
  return projectOntoPolyline(waypoints, x, y).s;
}

/**
 * 折线上离 (x,y) 最近的投影点本身的世界坐标（不是距离/弧长）——
 * 地图编辑器拖拽建筑时用它做"吸附到兵线"：拖到哪都把建筑的落点纠正到
 * 兵线上最近的一点，而不是允许它离开兵线自由摆放。
 * @param {{x:number,y:number}[]} waypoints
 * @param {number} x @param {number} y
 * @returns {{x:number,y:number}}
 */
export function nearestPointOnPolyline(waypoints, x, y) {
  const p = projectOntoPolyline(waypoints, x, y);
  return { x: p.x, y: p.y };
}

/**
 * 折线上离 (x,y) 最近的那一段的起点下标——地图编辑器路径编辑（阶段六）"点空白处
 * 插入新路点"用它：算出该往哪两个既有点之间插，返回 i 就意味着"插在 waypoints[i]
 * 和 waypoints[i+1] 之间"（新点下标即 i+1）。
 * @param {{x:number,y:number}[]} waypoints
 * @param {number} x @param {number} y
 * @returns {number}
 */
export function nearestSegmentIndex(waypoints, x, y) {
  return projectOntoPolyline(waypoints, x, y).seg;
}

/**
 * pure-pursuit 前瞻插值点：先把 (x,y) 投影到折线上，再沿折线往 direction 方向走
 * lookaheadDist 弧长，返回走到的世界坐标——这个返回点本身**落在折线上**（不带
 * 调用者的侧向偏移量），转角天然被削成弧线（各点沿弧长走到哪算哪，不是全体
 * 盯着路点数组里同一个精确坐标那种"漏斗"收敛）。
 * 走到折线端点、后面没有更多点可走时，直接停在最后能走到的那个点上（自然退化成
 * "瞄着终点"，与旧行为在临近终点时的表现一致）。
 *
 * ⚠️ 小兵寻路（LaneMovementSystem._advanceAlongLane）不能直接拿
 * "本函数返回点 − 小兵当前位置" 当转向方向：小兵允许在走廊内有侧向偏移
 * （LANE_KEEP=150 起才纠偏，见 LaneMovementSystem.js），若转向目标强行落在
 * 折线正中央，等于把"走到前瞻点"和"纠偏回中线"这两股力叠在一起，
 * 侧向偏移越大转向角越猛——仿真已实测：仅 ~15px 的侧向偏移就能在 60px
 * 前瞻距离下拗出 ~14° 转角，足以打乱一场混战里个别小兵的接敌时机
 * （sim_passthrough.mjs 曾在这个雷上炸过，见提交历史）。正确用法是同时调用
 * projectOntoPolyline 拿到"投影点"，用 "本函数返回点 − 投影点" 这段纯切线
 * 向量当转向方向——侧向偏移被两头抵消掉，只留"往前走+转弯"的分量，
 * 走廊纠偏完全交给 LaneMovementSystem 自己的 LANE_KEEP 逻辑去管，不重复实现。
 * @param {{x:number,y:number}[]} waypoints
 * @param {number} x @param {number} y 当前位置
 * @param {number} lookaheadDist 前瞻弧长（世界单位）
 * @param {1|-1} [direction=1] 沿折线走的方向：1=下标递增，-1=下标递减
 * @returns {{x:number,y:number}}
 */
export function lookaheadOnPolyline(waypoints, x, y, lookaheadDist, direction = 1) {
  const p = projectOntoPolyline(waypoints, x, y);
  let idx = direction > 0 ? p.seg : p.seg + 1;
  let curX = p.x, curY = p.y;
  let remaining = lookaheadDist;
  while (remaining > 0) {
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= waypoints.length) break;
    const nx = waypoints[nextIdx].x, ny = waypoints[nextIdx].y;
    const segDx = nx - curX, segDy = ny - curY;
    const segLen = Math.hypot(segDx, segDy);
    if (segLen <= remaining) {
      curX = nx; curY = ny;
      remaining -= segLen;
      idx = nextIdx;
    } else {
      const t = segLen > 0 ? remaining / segLen : 0;
      curX += segDx * t; curY += segDy * t;
      remaining = 0;
    }
  }
  return { x: curX, y: curY };
}

/**
 * 蓝红两方建筑构成是否完全对称（同 tier 同 laneId 的建筑数一致）。
 *
 * 多阵营地基（docs/REPORT-2026-09-03-multifaction.md §5）："对称"这个概念本身
 * 只对两阵营设计成立——三方地图没有唯一的"该跟谁对称"答案，勉强套用会把一张
 * 正常的三阵营地图判成"不合规"。所以只在 map.factions 恰好两个时才跑这条检查，
 * 3+ 阵营的地图直接放行（不是删规则，是它的适用范围本来就只覆盖两阵营设计，
 * 两阵营地图的行为完全不变）。
 * @param {*} map
 * @returns {boolean}
 */
export function buildingCountsSymmetric(map) {
  const factions = mapFactionsOf(map);
  if (factions.length !== 2) return true;
  const count = (f) => {
    const m = {};
    for (const b of map.buildings) {
      if (b.faction !== f) continue;
      const k = b.tier + '|' + (b.laneId || '-');
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  };
  const cb = count(factions[0]), cr = count(factions[1]);
  return JSON.stringify(Object.entries(cb).sort()) === JSON.stringify(Object.entries(cr).sort());
}

/**
 * 红方是否是蓝方按给定轴的镜像（而不是绕地图中心 180° 旋转——两者画面上
 * 经常看着差不多，但一个是"左右对调"一个是"上下颠倒左右也颠倒"，是两回事）。
 * axis='x'：镜像 x 坐标（x → world.w - x，y 不变，即"左右镜像"，扭曲丛林用这个）。
 * axis='y'：镜像 y 坐标（y → world.h - y，x 不变，即"上下镜像"）。
 * @param {*} map @param {'x'|'y'} axis @param {number} [eps=2]
 * @returns {boolean}
 */
export function isMirroredAcrossAxis(map, axis, eps = 2) {
  const bb = map.buildings.filter(b => b.faction === 'blue');
  return bb.every(b => map.buildings.some(r => {
    if (r.faction !== 'red' || r.tier !== b.tier || r.laneId !== b.laneId) return false;
    if (axis === 'x') {
      return Math.abs(r.pos.x - (map.world.w - b.pos.x)) < eps && Math.abs(r.pos.y - b.pos.y) < eps;
    }
    return Math.abs(r.pos.y - (map.world.h - b.pos.y)) < eps && Math.abs(r.pos.x - b.pos.x) < eps;
  }));
}

/**
 * 给定坐标是否落在某一方的基地圈内（圆心取 baseCircleCenter，半径取
 * map.baseOpenRadius，没声明就退回 map.baseCircleRadius，都没有就是 0）。
 * @param {*} map @param {'blue'|'red'} faction @param {{x:number,y:number}} pos
 * @returns {boolean}
 */
export function insideBaseCircle(map, faction, pos) {
  const c = baseCircleCenter(map, faction);
  if (!c) return false;
  const R = map.baseOpenRadius ?? map.baseCircleRadius ?? 0;
  return dist(c, pos) <= R;
}

/**
 * 分路建筑是否真的立在自己那条路上（走廊半宽之内），或者离自家水晶枢纽足够近
 * （枢纽塔等本来就可以离兵线远，走廊之外由基地开阔地兜底）。
 * 这里刻意用【到水晶枢纽的距离】而不是 insideBaseCircle（到基地圈圆心的距离）——
 * 两者在未声明 baseCenters 的地图上并不相等（圆心退回世界角点，枢纽塔在角点附近但
 * 不精确重合），换成圆心版会悄悄改变判定结果，所以保留原算法。
 * 没声明走廊半宽（navgrid 地图）时视为不适用，直接放行。
 * @param {*} map @param {*} building
 * @returns {boolean}
 */
export function buildingOnLaneOrInBase(map, building) {
  const hw = map.walls?.corridorHalfWidth;
  if (!hw || map.useNavgrid) return true;
  const nx = map.buildings.find(x => x.tier === 'nexus_main' && x.faction === building.faction);
  if (nx && dist(nx.pos, building.pos) <= (map.baseOpenRadius ?? 0)) return true;
  if (!building.laneId) return false;
  const lane = map.lanes.find(l => l.id === building.laneId);
  if (!lane) return false;
  return distToPolyline(lane.waypoints, building.pos.x, building.pos.y) <= hw;
}

/** 一组点里最近的一对之间的距离。少于 2 个点时返回 Infinity。 */
export function minPairwiseDistance(points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) best = Math.min(best, dist(points[i], points[j]));
  }
  return best;
}

/**
 * 同一方同一路上，相邻【攻击塔】档位之间的间距是否 > 2×射程（间距规则只管
 * 不同档位之间——同档位的两座塔可能是刻意成对的，如枢纽双塔各护水晶一侧）。
 * @param {*} map @param {number} attackRange @param {string[]} attackTiers
 * @returns {{faction:string, laneId:string, tierA:string, tierB:string, gap:number}[]} 违规列表，空数组=全部合规
 */
export function attackTowerSpacingOk(map, attackRange, attackTiers) {
  const violations = [];
  for (const lane of map.lanes) {
    for (const f of mapFactionsOf(map)) {
      const ts = map.buildings
        .filter(b => b.faction === f && b.laneId === lane.id && attackTiers.includes(b.tier))
        .map(b => ({ tier: b.tier, s: arcLengthAt(lane.waypoints, b.pos.x, b.pos.y), pos: b.pos }))
        .sort((a, b) => a.s - b.s);
      for (let i = 0; i + 1 < ts.length; i++) {
        if (ts[i].tier === ts[i + 1].tier) continue;
        const gap = dist(ts[i].pos, ts[i + 1].pos);
        if (gap <= 2 * attackRange) {
          violations.push({ faction: f, laneId: lane.id, tierA: ts[i].tier, tierB: ts[i + 1].tier, gap });
        }
      }
    }
  }
  return violations;
}

/**
 * 敌我双方的攻击塔射程圈是否互不重叠（全图范围，不分路——嚎哭深渊只有一条路时
 * 这就是"敌我攻击塔"的完整集合）。
 *
 * 多阵营地基：不再只算 blue↔red 这一对，改成遍历 map.factions 的所有两两组合——
 * "敌对双方射程圈不重叠"这条规则的意义在 N 阵营下依然成立，只是检查对象从
 * "唯一的一对"变成"所有的对"。两阵营地图只有一对组合，行为逐位不变。
 * @param {*} map @param {number} attackRange @param {string[]} attackTiers
 * @returns {{gap:number, factionA:string, factionB:string}[]} 违规列表（每对超标的阵营组合各报一条），空数组=合规
 */
export function crossFactionTowerSpacingOk(map, attackRange, attackTiers) {
  const factions = mapFactionsOf(map);
  const posOf = (f) => map.buildings.filter(b => b.faction === f && attackTiers.includes(b.tier)).map(b => b.pos);
  const violations = [];
  for (let i = 0; i < factions.length; i++) {
    for (let j = i + 1; j < factions.length; j++) {
      const a = posOf(factions[i]), b = posOf(factions[j]);
      let best = Infinity;
      for (const pa of a) for (const pb of b) best = Math.min(best, dist(pa, pb));
      if (best <= 2 * attackRange) violations.push({ gap: best, factionA: factions[i], factionB: factions[j] });
    }
  }
  return violations;
}

/**
 * 双方外塔是否各在自己的半区、且中间留有净空（旧 midlane_v1 就死在越过中线上）。
 * @param {*} map @param {string} laneId @param {number} [minGap=400]
 * @returns {{ok:boolean, sb:number, sr:number, total:number}|null} 双方都没有外塔时返回 null（不适用）
 */
export function outerTowersOwnHalfOk(map, laneId, minGap = 400) {
  const lane = map.lanes.find(l => l.id === laneId);
  if (!lane) return null;
  const total = lane.waypoints.reduce((s, p, i) => i ? s + dist(lane.waypoints[i - 1], p) : 0, 0);
  const bo = map.buildings.find(b => b.faction === 'blue' && b.laneId === laneId && b.tier === 'outer');
  const ro = map.buildings.find(b => b.faction === 'red' && b.laneId === laneId && b.tier === 'outer');
  if (!bo || !ro) return null;
  const sb = arcLengthAt(lane.waypoints, bo.pos.x, bo.pos.y);
  const sr = arcLengthAt(lane.waypoints, ro.pos.x, ro.pos.y);
  return { ok: sb < total / 2 && sr > total / 2 && sr - sb > minGap, sb, sr, total };
}
