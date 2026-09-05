import { baseCircleCenter } from './baseCircle.js';
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
