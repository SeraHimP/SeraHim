// mapValidate.js 直接单测：地图几何校验共享模块的行为形状。
//
// sim_maps.mjs / sim_abyss.mjs / sim_v40.mjs 已经在用真实地图数据间接跑过这些函数，
// 但那几处调用只覆盖了"当前地图恰好落在哪个分支"——比如所有现有地图都是 axis='x' 镜像，
// isMirroredAcrossAxis 的 axis='y' 分支、attackTowerSpacingOk 真报违规的分支、
// outerTowersOwnHalfOk 返回 null 的分支，都不会被现有地图数据触发到。
// 这里用手搭的最小地图数据直接钉这些分支，不依赖真实地图会不会凑巧经过它们。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
const {
  distToPolyline, arcLengthAt, nearestPointOnPolyline, nearestSegmentIndex, lookaheadOnPolyline,
  buildingCountsSymmetric, isMirroredAcrossAxis,
  insideBaseCircle, buildingOnLaneOrInBase, minPairwiseDistance,
  attackTowerSpacingOk, crossFactionTowerSpacingOk, outerTowersOwnHalfOk,
} = await import('../src/data/mapValidate.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ==================== distToPolyline / arcLengthAt ====================
{
  const wp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  T('距①：折线中段上的点距离为 0', distToPolyline(wp, 50, 0) === 0);
  T('距②：折线外的点量到最近投影', Math.abs(distToPolyline(wp, 50, 10) - 10) < 1e-9);
  T('距③：拐角之后落在第二段', Math.abs(distToPolyline(wp, 110, 50) - 10) < 1e-9);
  T('弧①：起点弧长为 0', arcLengthAt(wp, 0, 0) === 0);
  T('弧②：第一段中点弧长=50', Math.abs(arcLengthAt(wp, 50, 0) - 50) < 1e-9);
  T('弧③：拐角之后累计第一段全长', Math.abs(arcLengthAt(wp, 100, 50) - 150) < 1e-9);
  // 两点折线（sim_abyss.mjs 原来的特化版）与通用版数学上完全一致
  const wp2 = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
  T('距④：两点折线退化为点到线段（与通用版同一算法）', Math.abs(distToPolyline(wp2, 100, 30) - 30) < 1e-9);
  // nearestPointOnPolyline 与 distToPolyline/arcLengthAt 共用同一次投影计算
  const near = nearestPointOnPolyline(wp, 50, 10);
  T('近①：投影点落在折线上（不是原始拖拽点）', Math.abs(near.x - 50) < 1e-9 && Math.abs(near.y - 0) < 1e-9);
  const near2 = nearestPointOnPolyline(wp, 110, 50);
  T('近②：拐角之后投影到第二段', Math.abs(near2.x - 100) < 1e-9 && Math.abs(near2.y - 50) < 1e-9);

  // nearestSegmentIndex（阶段六：地图编辑器路径编辑"点空白处插入新路点"用它）
  T('段①：折线第一段中点 → 段下标 0（插入点应落在 waypoints[0]/[1] 之间）',
    nearestSegmentIndex(wp, 50, 10) === 0);
  T('段②：拐角之后落在第二段 → 段下标 1', nearestSegmentIndex(wp, 110, 50) === 1);
  const wp3 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }];
  T('段③：三段折线，离第三段最近的点 → 段下标 2', nearestSegmentIndex(wp3, 150, 90) === 2);

  // lookaheadOnPolyline（阶段五：小兵寻路 pure-pursuit 前瞻插值，见 LaneMovementSystem.js）
  const straight = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];
  const closeTo = (p, x, y) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;
  T('前瞻①：段内前瞻不越过下一个路点', closeTo(lookaheadOnPolyline(straight, 50, 0, 30), 80, 0));
  T('前瞻②：前瞻跨过路点，继续消耗剩余弧长走进下一段', closeTo(lookaheadOnPolyline(straight, 50, 0, 100), 150, 0));
  T('前瞻③：前瞻距离超过折线剩余总长 → 停在终点，不会越界', closeTo(lookaheadOnPolyline(straight, 50, 0, 100000), 200, 0));
  T('前瞻④：反向（direction=-1）前瞻走向下标更小的方向', closeTo(lookaheadOnPolyline(straight, 50, 0, 30, -1), 20, 0));
  T('前瞻⑤：反向前瞻跨过路点继续走进上一段', closeTo(lookaheadOnPolyline(straight, 150, 0, 100, -1), 50, 0));
  T('前瞻⑥：偏离折线的起点先投影回折线，再沿折线前瞻（不是直接从偏离点算直线距离）',
    closeTo(lookaheadOnPolyline(straight, 50, 10, 30), 80, 0));
  T('前瞻⑦：前瞻距离为 0 → 停在投影点本身', closeTo(lookaheadOnPolyline(straight, 50, 10, 0), 50, 0));
}

// ==================== buildingCountsSymmetric ====================
{
  const mk = (over) => ({
    buildings: [
      { faction: 'blue', tier: 'outer', laneId: 'mid' },
      { faction: 'red', tier: 'outer', laneId: 'mid' },
      ...over,
    ],
  });
  T('对①：同 tier/lane 数量一致 → 对称', buildingCountsSymmetric(mk([])));
  T('对②：红方少一座 → 不对称',
    !buildingCountsSymmetric({ buildings: [{ faction: 'blue', tier: 'outer', laneId: 'mid' }] }));
  T('对③：档位不同也算不对称', !buildingCountsSymmetric(mk([
    { faction: 'blue', tier: 'inner', laneId: 'mid' },
  ])));
}

// ==================== isMirroredAcrossAxis ====================
{
  const world = { w: 1000, h: 1000 };
  const left = { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 100, y: 400 } };
  const mirroredX = { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 900, y: 400 } };
  const mirroredY = { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 100, y: 600 } };
  const rotated180 = { faction: 'red', tier: 'outer', laneId: 'mid', pos: { x: 900, y: 600 } };
  T('镜①：左右镜像（axis=x）识别正确', isMirroredAcrossAxis({ world, buildings: [left, mirroredX] }, 'x'));
  T('镜②：左右镜像不等于上下镜像', !isMirroredAcrossAxis({ world, buildings: [left, mirroredX] }, 'y'));
  T('镜③：上下镜像（axis=y）识别正确', isMirroredAcrossAxis({ world, buildings: [left, mirroredY] }, 'y'));
  T('镜④：180°旋转不算任何一种镜像', !isMirroredAcrossAxis({ world, buildings: [left, rotated180] }, 'x')
    && !isMirroredAcrossAxis({ world, buildings: [left, rotated180] }, 'y'));
}

// ==================== insideBaseCircle ====================
{
  const map = { world: { w: 1000, h: 1000 }, baseOpenRadius: 200,
    buildings: [{ faction: 'blue', tier: 'nexus_main', pos: { x: 0, y: 1000 } }] };
  T('基①：圆心附近判定在内', insideBaseCircle(map, 'blue', { x: 50, y: 950 }));
  T('基②：远处判定在外', !insideBaseCircle(map, 'blue', { x: 500, y: 500 }));
  const declared = { world: { w: 1000, h: 1000 }, baseOpenRadius: 100,
    baseCenters: { blue: { x: 300, y: 500 } }, buildings: [] };
  T('基③：声明了 baseCenters 时用声明值，不退回角点',
    insideBaseCircle(declared, 'blue', { x: 350, y: 500 }) && !insideBaseCircle(declared, 'blue', { x: 0, y: 1000 }));
}

// ==================== buildingOnLaneOrInBase ====================
{
  const lane = { id: 'mid', waypoints: [{ x: 0, y: 500 }, { x: 1000, y: 500 }] };
  const map = {
    world: { w: 1000, h: 1000 }, walls: { corridorHalfWidth: 60 }, baseOpenRadius: 150,
    lanes: [lane],
    buildings: [{ faction: 'blue', tier: 'nexus_main', pos: { x: 0, y: 500 } }],
  };
  T('线①：走廊内的分路建筑合规',
    buildingOnLaneOrInBase(map, { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 400, y: 520 } }));
  T('线②：远离走廊、又不在基地圈内的建筑不合规',
    !buildingOnLaneOrInBase(map, { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 400, y: 800 } }));
  T('线③：离兵线很远但在基地圈内的建筑（枢纽塔一类）合规',
    buildingOnLaneOrInBase(map, { faction: 'blue', tier: 'hq_tower', pos: { x: 30, y: 480 } }));
  T('线④：laneId 指向不存在的路 → 不合规', !buildingOnLaneOrInBase(map,
    { faction: 'blue', tier: 'outer', laneId: 'nope', pos: { x: 400, y: 520 } }));
  T('线⑤：没声明走廊半宽（navgrid 地图）直接放行',
    buildingOnLaneOrInBase({ ...map, walls: {} }, { faction: 'blue', tier: 'outer', laneId: 'mid', pos: { x: 400, y: 999 } }));
}

// ==================== minPairwiseDistance ====================
{
  T('距对①：三点取最近一对', minPairwiseDistance([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }]) === 10);
  T('距对②：单点/空数组返回 Infinity',
    minPairwiseDistance([{ x: 0, y: 0 }]) === Infinity && minPairwiseDistance([]) === Infinity);
}

// ==================== attackTowerSpacingOk ====================
{
  const lane = { id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] };
  const okMap = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 100, y: 0 } },
    { faction: 'blue', laneId: 'mid', tier: 'inner', pos: { x: 500, y: 0 } },
  ] };
  T('间①：间距足够 → 无违规', attackTowerSpacingOk(okMap, 180, ['outer', 'inner']).length === 0);
  const badMap = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 100, y: 0 } },
    { faction: 'blue', laneId: 'mid', tier: 'inner', pos: { x: 200, y: 0 } },
  ] };
  const bad = attackTowerSpacingOk(badMap, 180, ['outer', 'inner']);
  T('间②：间距不足 → 报出具体一对', bad.length === 1 && bad[0].tierA === 'outer' && bad[0].tierB === 'inner');
  const pairMap = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'hq_tower', pos: { x: 100, y: 0 } },
    { faction: 'blue', laneId: 'mid', tier: 'hq_tower', pos: { x: 150, y: 0 } },
  ] };
  T('间③：同档位刻意成对不算违规', attackTowerSpacingOk(pairMap, 180, ['hq_tower']).length === 0);
}

// ==================== crossFactionTowerSpacingOk ====================
{
  const okMap = { buildings: [
    { faction: 'blue', tier: 'outer', pos: { x: 0, y: 0 } },
    { faction: 'red', tier: 'outer', pos: { x: 1000, y: 0 } },
  ] };
  T('跨①：敌我离得够远 → 无违规', crossFactionTowerSpacingOk(okMap, 180, ['outer']).length === 0);
  const badMap = { buildings: [
    { faction: 'blue', tier: 'outer', pos: { x: 0, y: 0 } },
    { faction: 'red', tier: 'outer', pos: { x: 100, y: 0 } },
  ] };
  const bad = crossFactionTowerSpacingOk(badMap, 180, ['outer']);
  T('跨②：敌我射程圈重叠 → 报出最小间距', bad.length === 1 && Math.abs(bad[0].gap - 100) < 1e-9);
}

// ==================== outerTowersOwnHalfOk ====================
{
  const lane = { id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] };
  const good = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 200, y: 0 } },
    { faction: 'red', laneId: 'mid', tier: 'outer', pos: { x: 800, y: 0 } },
  ] };
  const r1 = outerTowersOwnHalfOk(good, 'mid');
  T('半①：各在自己半区、净空足够 → ok', r1?.ok === true);
  const crossed = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 700, y: 0 } },
    { faction: 'red', laneId: 'mid', tier: 'outer', pos: { x: 300, y: 0 } },
  ] };
  T('半②：越过中线 → 不 ok', outerTowersOwnHalfOk(crossed, 'mid')?.ok === false);
  const tooClose = { lanes: [lane], buildings: [
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 480, y: 0 } },
    { faction: 'red', laneId: 'mid', tier: 'outer', pos: { x: 520, y: 0 } },
  ] };
  T('半③：净空不足 400 → 不 ok', outerTowersOwnHalfOk(tooClose, 'mid')?.ok === false);
  T('半④：一方没有外塔 → 不适用，返回 null',
    outerTowersOwnHalfOk({ lanes: [lane], buildings: [good.buildings[0]] }, 'mid') === null);
  T('半⑤：路不存在 → 返回 null', outerTowersOwnHalfOk(good, 'nope') === null);
}

console.log(`地图校验共享模块验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
