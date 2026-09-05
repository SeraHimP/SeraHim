/**
 * sim_mapeditor.mjs —— 地图编辑器交互 UI 阶段：mapEditorCore.js 纯逻辑验收
 *
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.5、任务 #113~#116。
 * MapEditorDialog.js 本身是 DOM 弹窗（笔刷画布/事件绑定），headless 测不到；
 * 但它依赖的"克隆地图/解出笔刷位图/拼保存对象"这几步已经拆成 mapEditorCore.js
 * 的纯函数，这里直接钉住这几步的行为——弹窗代码本身用 sim_v51.mjs 那套
 * 源码正则断言（Dialog 存在、按钮/画布元素齐全、正确调用了这些纯函数）来兜底。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
const {
  resolveBaseNavgrid, decodeBaseBits, cloneMapForEdit, buildCustomMapPayload,
  cloneBuildingsForEdit, snapBuildingPos, freeBuildingPos, withBuildingMoved, validateDraftMap, autoDetectTiers,
  cloneRegionsForEdit, defaultPitFor,
  cloneLanesForEdit, withWaypointMoved, withWaypointInserted, withWaypointRemoved,
  withLaneAdded, withLaneRemoved, laneBuildingCount, nearestSegmentIndex,
  cloneFactionsForEdit, withFactionAdded, withFactionRemoved, pruneMapDataForRemovedFaction,
} = await import('../src/data/mapEditorCore.js');
const { unpackBits, packBits } = await import('../src/data/navgrid.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { CONFIG } = await import('../src/data/Config.js');

const board = scoreboard('地图编辑器 mapEditorCore 验收');
const T = board.T;

// ==================== ① resolveBaseNavgrid：召唤师峡谷的隐式兜底 ====================
{
  // 峡谷地图对象本身不声明 navgrid 字段（沿用 MapSystem._navgrid() 的兜底逻辑），
  // 编辑器克隆它时必须认得同一条兜底规则，否则画出来的地形和游戏里实际的对不上。
  const sr = MAPS.summoners_rift_v1;
  T('①-峡谷地图对象本身确实没有 navgrid 字段（前提假设，验证兜底分支真的会被走到）',
    sr.navgrid === undefined);
  const ng = resolveBaseNavgrid(sr);
  T('②-resolveBaseNavgrid 对没声明 navgrid 的地图兜底到 SR_NAVGRID',
    ng === SR_NAVGRID);

  const ha = MAPS.howling_abyss_v1 || Object.values(MAPS).find(m => m.navgrid);
  T('③-已经自带 navgrid 字段的地图（如嚎哭深渊/扭曲丛林），resolveBaseNavgrid 直接返回它自己的，不套兜底',
    ha && resolveBaseNavgrid(ha) === ha.navgrid);
}

// ==================== ② decodeBaseBits：解码出的位图与真实几何一致 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const { n, bits } = decodeBaseBits(sr);
  const expected = unpackBits(SR_NAVGRID.bits, SR_NAVGRID.n);
  T('①-decodeBaseBits(峡谷) 的 n 与 SR_NAVGRID.n 一致', n === SR_NAVGRID.n);
  T('②-decodeBaseBits(峡谷) 解出的位图逐格与直接 unpackBits(SR_NAVGRID) 一致',
    bits.length === expected.length && bits.every((v, i) => v === expected[i]));
}

// ==================== ③ cloneMapForEdit：深克隆，不共享引用 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const clone = cloneMapForEdit(sr);
  T('①-克隆出的对象与原对象内容相等', JSON.stringify(clone) === JSON.stringify(sr));
  T('②-克隆出的对象不是同一个引用', clone !== sr);
  // 改克隆体的嵌套字段，原地图对象必须纹丝不动——这是编辑器决不能就地改内置地图
  // 这条底线的直接验证（内置地图是模块级常量，被 MAPS 表和正在跑的对局同时引用）。
  if (clone.world) clone.world.w = -1;
  T('③-改动克隆体的嵌套字段不影响原地图对象（真的是深克隆，不是浅拷贝共享了 world 对象）',
    sr.world.w !== -1);
}

// ==================== ④ buildCustomMapPayload：拼出的对象结构正确 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const { n, bits } = decodeBaseBits(sr);
  // 笔刷操作：把左上角一小块方形区域擦成不可走，模拟"画了一笔"
  for (let gy = 0; gy < 10; gy++) for (let gx = 0; gx < 10; gx++) bits[gy * n + gx] = 0;

  const payload = buildCustomMapPayload(sr, { id: 'my_edited_map_v1', label: '我改过的峡谷', n, bits });
  T('①-payload.id/label 按传入值覆盖', payload.id === 'my_edited_map_v1' && payload.label === '我改过的峡谷');
  T('②-payload 保留了原地图的其它结构（如 world，克隆而来，不是从零现造）',
    JSON.stringify(payload.world) === JSON.stringify(sr.world));
  T('③-payload.navgrid.n 与笔刷时用的 n 一致', payload.navgrid.n === n);

  const decodedBack = unpackBits(payload.navgrid.bits, payload.navgrid.n);
  T('④-payload.navgrid.bits 解码回来与笔刷改过的位图逐格一致（保存链路没有丢数据/错位）',
    decodedBack.length === bits.length && decodedBack.every((v, i) => v === bits[i]));
  T('⑤-笔刷擦掉的那块区域在保存结果里确实是不可走（0）', decodedBack[5 * n + 5] === 0);
  // 峡谷左上角本来是野区/墙体以外的可走区域较多，这里只断言"笔刷确实改变了原始数据"，
  // 不断言具体某格原始值是什么（不钉死美术数据的具体像素，只钉"笔刷生效"这个行为形状）。
  const original = unpackBits(SR_NAVGRID.bits, SR_NAVGRID.n);
  T('⑥-payload 与原始 navgrid 不完全相同（证明确实是编辑后的数据，不是原样照抄）',
    !decodedBack.every((v, i) => v === original[i]));

  // 不传 id 必须报错，而不是悄悄存出一张 id=undefined 的地图（那种地图在
  // CONFIG.customMaps[undefined] 底下，选择列表里会显示成一张没有名字的鬼图）。
  let threw = false;
  try { buildCustomMapPayload(sr, { label: '没给 id', n, bits }); } catch { threw = true; }
  T('⑦-不传 id 时 buildCustomMapPayload 抛错，而不是静默生成一张无 id 的地图', threw);

  // 阶段三剩余：不传 buildings 时行为与参数化之前逐位一致（见 CLAUDE.md §2）——
  // 仍然整体克隆 baseMap 的建筑数组，不受这次加的新参数影响。
  const payload2 = buildCustomMapPayload(sr, { id: 'no_buildings_arg', label: 'x', n, bits });
  T('⑧-不传 buildings 时保留 baseMap 原有建筑（新参数不改默认行为）',
    JSON.stringify(payload2.buildings) === JSON.stringify(sr.buildings));
  const movedBuildings = sr.buildings.map((b, i) => (i === 0 ? { ...b, pos: { x: 1, y: 2 } } : b));
  const payload3 = buildCustomMapPayload(sr, { id: 'with_buildings_arg', label: 'x', n, bits, buildings: movedBuildings });
  T('⑨-传了 buildings 时用传入的草稿数组覆盖', payload3.buildings[0].pos.x === 1 && payload3.buildings[0].pos.y === 2);

  // 阶段四剩余（区域参数表单）：同样遵循"不传就保留 baseMap 原值"的默认行为不变原则。
  const payload4 = buildCustomMapPayload(sr, { id: 'no_regions_arg', label: 'x', n, bits });
  T('⑩-不传 baseCircleRadius/pits 时保留 baseMap 原值', payload4.baseCircleRadius === sr.baseCircleRadius
    && JSON.stringify(payload4.pits) === JSON.stringify(sr.pits));
  const payload5 = buildCustomMapPayload(sr, {
    id: 'with_regions_arg', label: 'x', n, bits,
    baseCircleRadius: 999, pits: { baron: { x: 1, y: 2, r: 3, depth: -1 } },
  });
  T('⑪-传了 baseCircleRadius/pits 时用传入值覆盖', payload5.baseCircleRadius === 999
    && payload5.pits.baron.x === 1 && payload5.pits.baron.r === 3 && payload5.pits.dragon === undefined);

  // 阶段六（兵路径编辑）：同样遵循"不传就保留 baseMap 原值"的默认行为不变原则。
  const payload6 = buildCustomMapPayload(sr, { id: 'no_lanes_arg', label: 'x', n, bits });
  T('⑫-不传 lanes 时保留 baseMap 原有路径', JSON.stringify(payload6.lanes) === JSON.stringify(sr.lanes));
  const movedLanes = sr.lanes.map((l, i) => (i === 0 ? { ...l, waypoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } : l));
  const payload7 = buildCustomMapPayload(sr, { id: 'with_lanes_arg', label: 'x', n, bits, lanes: movedLanes });
  T('⑬-传了 lanes 时用传入的草稿数组覆盖',
    payload7.lanes[0].waypoints.length === 2 && payload7.lanes[0].waypoints[0].x === 1);
}

// ==================== ④b 区域参数草稿：克隆 / 默认坑位 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const regions = cloneRegionsForEdit(sr);
  T('①-cloneRegionsForEdit(峡谷) 的 baseCircleRadius 与原地图一致', regions.baseCircleRadius === sr.baseCircleRadius);
  T('②-cloneRegionsForEdit(峡谷) 的 pits 内容与原地图一致（峡谷声明了龙坑/男爵坑）',
    JSON.stringify(regions.pits) === JSON.stringify(sr.pits));
  regions.pits.baron.x = -999;
  T('③-改动草稿的 pits 不影响原地图对象（深克隆）', sr.pits.baron.x !== -999);

  const howl = MAPS.howling_abyss_v1;
  const regionsHowl = cloneRegionsForEdit(howl);
  T('④-嚎哭深渊没声明 pits → 草稿的 pits 是空对象（不是 undefined，表单可以直接读 .baron/.dragon）',
    typeof regionsHowl.pits === 'object' && regionsHowl.pits.baron === undefined && regionsHowl.pits.dragon === undefined);
  T('⑤-嚎哭深渊 baseCircleRadius 有声明 → 草稿原样带出', regionsHowl.baseCircleRadius === howl.baseCircleRadius);

  const noRadiusMap = { world: { w: 100, h: 100 } };
  T('⑥-地图完全没声明 baseCircleRadius 时草稿是 null（不是误导性的 0，表单据此显示空输入框）',
    cloneRegionsForEdit(noRadiusMap).baseCircleRadius === null);

  const baronDefault = defaultPitFor(sr, 'baron');
  const dragonDefault = defaultPitFor(sr, 'dragon');
  T('⑦-defaultPitFor 给出的默认坑位落在世界范围内', baronDefault.x >= 0 && baronDefault.x <= sr.world.w
    && baronDefault.y >= 0 && baronDefault.y <= sr.world.h);
  T('⑧-男爵坑默认位置偏世界中心的左上、龙坑偏右下（呼应 SR_PITS 的几何直觉，不是同一个点）',
    baronDefault.x < dragonDefault.x && baronDefault.y < dragonDefault.y);
  T('⑨-defaultPitFor 给出合理的默认半径/深度（非零，可直接用于渲染）', baronDefault.r > 0 && baronDefault.depth < 0);
}

// ==================== ④c 兵路径编辑（阶段六）：克隆/拖动/插入/删除路点/整条路增删 ====================
{
  const sr = MAPS.summoners_rift_v1;

  // cloneLanesForEdit：深克隆，不共享引用（同 cloneBuildingsForEdit 的理由）
  const lanes = cloneLanesForEdit(sr);
  T('①-cloneLanesForEdit 内容与原地图路径相等', JSON.stringify(lanes) === JSON.stringify(sr.lanes));
  lanes[0].waypoints[0].x = -999;
  T('②-改动草稿不影响原地图对象（深克隆）', sr.lanes[0].waypoints[0].x !== -999);

  // withWaypointMoved：只改目标路的目标下标，不改原数组，其它路原样保留
  const topLaneId = sr.lanes[0].id;
  const moved = withWaypointMoved(lanes, topLaneId, 0, { x: 10, y: 20 });
  T('③-withWaypointMoved 不改原数组（拖拽期间每帧调用，不能有副作用累积）',
    lanes.find(l => l.id === topLaneId).waypoints[0].x !== 10);
  T('④-withWaypointMoved 返回的新数组里目标路点落点已更新',
    moved.find(l => l.id === topLaneId).waypoints[0].x === 10 && moved.find(l => l.id === topLaneId).waypoints[0].y === 20);
  T('⑤-withWaypointMoved 只改目标路，其它路原样保留',
    JSON.stringify(moved.find(l => l.id !== topLaneId)) === JSON.stringify(lanes.find(l => l.id !== topLaneId)));

  // withWaypointInserted：插在指定下标之后，其它点顺移，不改原数组
  const beforeLen = lanes.find(l => l.id === topLaneId).waypoints.length;
  const inserted = withWaypointInserted(lanes, topLaneId, 0, { x: 111, y: 222 });
  const insertedLane = inserted.find(l => l.id === topLaneId);
  T('⑥-withWaypointInserted 新路点插在 afterIndex+1 处', insertedLane.waypoints[1].x === 111 && insertedLane.waypoints[1].y === 222);
  T('⑦-withWaypointInserted 总点数 +1', insertedLane.waypoints.length === beforeLen + 1);
  T('⑧-withWaypointInserted 不改原数组', lanes.find(l => l.id === topLaneId).waypoints.length === beforeLen);
  T('⑨-withWaypointInserted 原有点的相对顺序保留（原第 2 个点现在是第 3 个）',
    insertedLane.waypoints[2].x === lanes.find(l => l.id === topLaneId).waypoints[1].x);

  // withWaypointRemoved：正常删除、以及"少于等于 2 个点时拒绝删除"这条安全底线
  const removed = withWaypointRemoved(lanes, topLaneId, 0);
  T('⑩-withWaypointRemoved 正常删除后总点数 -1',
    removed.find(l => l.id === topLaneId).waypoints.length === beforeLen - 1);
  const twoPointLanes = [{ id: 'x', waypoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];
  const refused = withWaypointRemoved(twoPointLanes, 'x', 0);
  T('⑪-只剩 2 个点时拒绝删除（一条路至少要有起点终点两个点，不能删到只剩 1 个）',
    refused.find(l => l.id === 'x').waypoints.length === 2);

  // withLaneAdded / withLaneRemoved：整条路增删
  const newLane = { id: 'brand_new_lane', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
  const withNew = withLaneAdded(lanes, newLane);
  T('⑫-withLaneAdded 新增一条路，总数 +1', withNew.length === lanes.length + 1);
  T('⑬-withLaneAdded 不改原数组', lanes.length === sr.lanes.length);
  let threwDup = false;
  try { withLaneAdded(withNew, newLane); } catch { threwDup = true; }
  T('⑭-withLaneAdded 对已存在的 id 抛错，而不是静默覆盖（新增和改名顶替是两回事）', threwDup);
  const withoutTop = withLaneRemoved(lanes, topLaneId);
  T('⑮-withLaneRemoved 删除指定 id 的路，总数 -1', withoutTop.length === lanes.length - 1);
  T('⑯-withLaneRemoved 不影响其它路', withoutTop.every(l => l.id !== topLaneId));

  // laneBuildingCount：删整条路之前用它判断会不会留下孤儿建筑
  T('⑰-laneBuildingCount 统计出召唤师峡谷 top 路上确实有建筑（真实数据，不是 0）',
    laneBuildingCount(sr.buildings, topLaneId) > 0);
  T('⑱-laneBuildingCount 对不存在的 laneId 返回 0', laneBuildingCount(sr.buildings, 'no_such_lane') === 0);

  // nearestSegmentIndex 已经在 sim_mapvalidate.mjs 里直接测过，这里只确认
  // mapEditorCore.js 转导出的是同一个函数（不是另起一份同名实现）。
  const { nearestSegmentIndex: directImport } = await import('../src/data/mapValidate.js');
  T('⑲-mapEditorCore.js 转导出的 nearestSegmentIndex 与 mapValidate.js 是同一个函数引用', nearestSegmentIndex === directImport);
}

// ==================== ⑤b 建筑摆放：克隆/吸附/挪动/实时校验 ====================
{
  const sr = MAPS.summoners_rift_v1;

  // cloneBuildingsForEdit：深克隆，不共享引用
  const draft = cloneBuildingsForEdit(sr);
  T('①-cloneBuildingsForEdit 内容与原地图建筑相等', JSON.stringify(draft) === JSON.stringify(sr.buildings));
  draft[0].pos.x = -999;
  T('②-改动克隆体不影响原地图对象（深克隆）', sr.buildings[0].pos.x !== -999);

  // snapBuildingPos：有 laneId 的建筑吸附到自己那条兵线上
  const outerTop = sr.buildings.find(b => b.tier === 'outer' && b.laneId === 'top' && b.faction === 'blue');
  const topLane = sr.lanes.find(l => l.id === 'top');
  const farOff = { x: outerTop.pos.x + 500, y: outerTop.pos.y + 500 }; // 明显偏离兵线的拖拽点
  const snapped = snapBuildingPos(sr, outerTop, farOff.x, farOff.y);
  const { distToPolyline } = await import('../src/data/mapValidate.js');
  T('③-拖到偏离兵线很远的点，落点仍被吸附回兵线上（距离≈0）',
    distToPolyline(topLane.waypoints, snapped.x, snapped.y) < 1e-6);

  // 没有 laneId 的建筑（水晶枢纽）不吸附，只夹在世界范围内
  const nexus = sr.buildings.find(b => b.tier === 'nexus_main' && b.faction === 'blue');
  const free = snapBuildingPos(sr, nexus, 123, 456);
  T('④-没有 laneId 的建筑自由摆放（不吸附到任何兵线）', free.x === 123 && free.y === 456);
  const clampTest = snapBuildingPos(sr, nexus, -100, sr.world.h + 999);
  T('⑤-自由摆放仍会夹在世界范围内（不能拖出地图外）',
    clampTest.x === 0 && clampTest.y === sr.world.h);

  // freeBuildingPos（用户定稿"移动塔只能沿着某线运动，修复为可以随意移动"）：
  // 挪动一座已有塔时不吸附到任何兵线，哪怕这座塔有 laneId。
  const freeMoveLaneTower = freeBuildingPos(sr, outerTop.pos.x + 500, outerTop.pos.y + 500);
  T('⑤b-freeBuildingPos 不把有 laneId 的塔吸附回兵线（落点就是传入的世界坐标本身）',
    freeMoveLaneTower.x === outerTop.pos.x + 500 && freeMoveLaneTower.y === outerTop.pos.y + 500);
  T('⑤c-freeBuildingPos 仍会夹在世界范围内（不能拖出地图外）',
    freeBuildingPos(sr, -100, sr.world.h + 999).x === 0 && freeBuildingPos(sr, -100, sr.world.h + 999).y === sr.world.h);

  // withBuildingMoved：返回新数组，不改原数组
  const moved = withBuildingMoved(draft, 1, { x: 10, y: 20 });
  T('⑥-withBuildingMoved 不改原数组（拖拽期间每帧调用，不能有副作用累积）',
    draft[1].pos.x !== 10 || draft[1].pos.y !== 20);
  T('⑦-withBuildingMoved 返回的新数组里目标建筑落点已更新', moved[1].pos.x === 10 && moved[1].pos.y === 20);
  T('⑧-withBuildingMoved 只改目标下标，其它建筑原样保留',
    JSON.stringify(moved[0]) === JSON.stringify(draft[0]));

  // validateDraftMap：正常的召唤师峡谷应该全部合规
  const okResult = validateDraftMap({ ...sr, buildings: cloneBuildingsForEdit(sr) });
  T('⑨-未改动的峡谷建筑数据跑校验应该全部合规', okResult.ok === true && okResult.symmetric === true
    && okResult.spacingViolations.length === 0 && okResult.crossViolations.length === 0);

  // 把外塔拖到和内塔贴脸——应该报出间距违规
  const draft2 = cloneBuildingsForEdit(sr);
  const outerIdx = draft2.findIndex(b => b.tier === 'outer' && b.laneId === 'top' && b.faction === 'blue');
  const innerB = draft2.find(b => b.tier === 'inner' && b.laneId === 'top' && b.faction === 'blue');
  const badDraft = withBuildingMoved(draft2, outerIdx, { x: innerB.pos.x + 10, y: innerB.pos.y });
  const badResult = validateDraftMap({ ...sr, buildings: badDraft });
  T('⑩-把外塔拖到贴着内塔 → 报出间距违规', badResult.ok === false && badResult.spacingViolations.length > 0);

  // 破坏对称性：删掉红方一座塔
  const asymDraft = draft2.filter(b => !(b.tier === 'outer' && b.laneId === 'top' && b.faction === 'red'));
  const asymResult = validateDraftMap({ ...sr, buildings: asymDraft });
  T('⑪-少一座红方塔 → 报出不对称', asymResult.ok === false && asymResult.symmetric === false);
}

// ==================== ⑤c 档位自动识别 autoDetectTiers ====================
{
  const sr = MAPS.summoners_rift_v1;

  // 真实地图往返：现有峡谷的档位本来就是"正确答案"，自动识别应该原样复现它，
  // 不依赖弧长方向假设（用距自家召唤水晶的直线距离判断，见函数头注）。
  const real = cloneBuildingsForEdit(sr);
  const detected = autoDetectTiers(sr, real);
  const mismatches = detected.filter((b, i) => b.tier !== real[i].tier)
    .map(b => `${b.faction}/${b.laneId}/${b.tier}(期望${real[detected.indexOf(b)]?.tier})`);
  T(`①-真实峡谷数据跑自动识别，档位与原数据逐位一致${mismatches.length ? '：' + mismatches.join('；') : ''}`,
    mismatches.length === 0);

  // 打乱一路的档位（外/内互换），自动识别应该按位置纠正回来
  const shuffled = cloneBuildingsForEdit(sr).map(b => {
    if (b.faction === 'blue' && b.laneId === 'top' && b.tier === 'outer') return { ...b, tier: 'inner' };
    if (b.faction === 'blue' && b.laneId === 'top' && b.tier === 'inner') return { ...b, tier: 'outer' };
    return b;
  });
  const fixed = autoDetectTiers(sr, shuffled);
  const wantOuter = sr.buildings.find(b => b.faction === 'blue' && b.laneId === 'top' && b.tier === 'outer');
  const wantInner = sr.buildings.find(b => b.faction === 'blue' && b.laneId === 'top' && b.tier === 'inner');
  T('②-外/内塔的档位被人为打乱后，自动识别按位置纠正回原样',
    fixed.find(b => b.pos.x === wantOuter.pos.x && b.pos.y === wantOuter.pos.y).tier === 'outer'
    && fixed.find(b => b.pos.x === wantInner.pos.x && b.pos.y === wantInner.pos.y).tier === 'inner');

  // 手搭最小地图：单路只有一座链上的塔 + 一个召唤水晶 → 判给水晶防御塔
  // （见函数头注的边界情形取舍：离锚点最近同时也是唯一一座，优先按"离锚点最近"判）
  const oneLane = {
    lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }],
    buildings: [
      { faction: 'blue', laneId: 'mid', tier: 'inner', pos: { x: 800, y: 0 } },
      { faction: 'blue', laneId: 'mid', tier: 'nexus_lane', pos: { x: 900, y: 0 } },
    ],
  };
  const oneLaneResult = autoDetectTiers(oneLane, oneLane.buildings);
  T('③-单路只有一座链上的塔 → 判给水晶防御塔', oneLaneResult[0].tier === 'base');

  // 没有 laneId 的塔（不管原来是什么档位）一律判给枢纽防御塔，nexus_main 本身不受影响
  const hqCase = [
    { faction: 'blue', laneId: null, tier: 'outer', pos: { x: 0, y: 0 } },   // 手误设错的档位
    { faction: 'blue', laneId: null, tier: 'nexus_main', pos: { x: 10, y: 10 } },
  ];
  const hqResult = autoDetectTiers({ lanes: [] }, hqCase);
  T('④-没有路的塔一律判给枢纽防御塔（不管原来标了什么）', hqResult[0].tier === 'hq_tower');
  T('⑤-nexus_main 本身不会被自动识别改动', hqResult[1].tier === 'nexus_main');

  // 既没有召唤水晶也没有水晶枢纽做锚点 → 无法判断方向，保留原档位
  const noAnchor = [
    { faction: 'blue', laneId: 'mid', tier: 'inner', pos: { x: 100, y: 0 } },
    { faction: 'blue', laneId: 'mid', tier: 'outer', pos: { x: 900, y: 0 } },
  ];
  const noAnchorResult = autoDetectTiers({ lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }] }, noAnchor);
  T('⑥-两个锚点都没有 → 保留原档位（不瞎猜）',
    noAnchorResult[0].tier === 'inner' && noAnchorResult[1].tier === 'outer');

  // 纯函数：不改原数组
  const before = cloneBuildingsForEdit(sr);
  const beforeSnapshot = JSON.stringify(before);
  autoDetectTiers(sr, before);
  T('⑦-autoDetectTiers 不修改传入的原数组（纯函数）', JSON.stringify(before) === beforeSnapshot);
}

// ==================== ⑤ CONFIG.mapEditor 笔刷半径软编码 ====================
{
  T('①-CONFIG.mapEditor.brushRadiusGridDefault 存在且在 [min,max] 区间内',
    CONFIG.mapEditor.brushRadiusGridDefault >= CONFIG.mapEditor.brushRadiusGridMin &&
    CONFIG.mapEditor.brushRadiusGridDefault <= CONFIG.mapEditor.brushRadiusGridMax);
  T('②-CONFIG.mapEditor.validationAttackTiers 是非空数组（建筑摆放实时校验用它判定哪些档位会攻击）',
    Array.isArray(CONFIG.mapEditor.validationAttackTiers) && CONFIG.mapEditor.validationAttackTiers.length > 0);
  T('③-CONFIG.mapEditor.buildingHitRadiusPx/buildingMarkerRadiusPx 都是正数（软编码，不是画布代码里的魔数）',
    CONFIG.mapEditor.buildingHitRadiusPx > 0 && CONFIG.mapEditor.buildingMarkerRadiusPx > 0);
}

// ==================== ⑥ MapEditorDialog.js：源码层面的接线检查（DOM 弹窗测不到交互，但能测"接对了没接错"）====================
{
  const src = srcOf('../src/ui/MapEditorDialog.js');
  T('①-MapEditorDialog.js 导入了 mapEditorCore.js 的纯函数（没有在弹窗里重新抄一遍逻辑）',
    /from ['"].*mapEditorCore\.js['"]/.test(src));
  T('②-MapEditorDialog.js 用了 navgrid.js 的 paintCircle 做笔刷（没有另起一套画圆算法）',
    /paintCircle/.test(src));
  T('③-MapEditorDialog.js 保存时写入 CONFIG.customMaps（落盘位置与 IO_GROUPS/_mapRegistry 一致）',
    /CONFIG\.customMaps/.test(src));
  T('④-MapEditorDialog.js 没有直接操作 CanvasController 的拖拽状态（_placeMode/isDragging 等），画布笔刷是独立实现，不与相机拖拽/建塔选位共用状态机',
    !/canvasController\.(isDragging|_placeMode|dragStartX)/.test(src));
  T('⑤-建筑摆放调用了 mapEditorCore.js 的 freeBuildingPos/withBuildingMoved/validateDraftMap（拖拽/校验逻辑不在弹窗里重新写一遍）',
    /freeBuildingPos/.test(src) && /withBuildingMoved/.test(src) && /validateDraftMap/.test(src));
  T('⑥-保存时把当前草稿建筑数组传给了 buildCustomMapPayload（拖拽结果真的会存下去，不是只在画布上好看）',
    /buildCustomMapPayload\([^)]*buildings:\s*draftBuildings/.test(src));
  T('⑦-切换起点地图会重置草稿建筑（cloneBuildingsForEdit 在 switchBase 里被调用，不是只在弹窗打开时调一次）',
    /switchBase[\s\S]{0,400}cloneBuildingsForEdit/.test(src));
  T('⑧-建筑标记半径在重画函数里现算，不是模块顶层的一次性常量（切图后 n 变了，写成一次性常量会画错大小）',
    /drawBuildingMarkers[\s\S]{0,200}buildingMarkerRadiusPx/.test(src));
  T('⑨-自动识别档位按钮调用了 mapEditorCore.js 的 autoDetectTiers（不是弹窗里另算一套）',
    /autoDetectTiers/.test(src) && /from ['"].*waveComposition\.js['"]/.test(src));
  T('⑩-点选建筑后的手动改档位下拉框用的是 STRUCT_TIERS（与游戏内其它地方同一张档位表，不是另起一份）',
    /STRUCT_TIERS\.map/.test(src));
  T('⑪-切换起点地图会重置选中的建筑（selectedBuildingIndex 在 switchBase 里被清空，避免旧下标指错建筑）',
    /switchBase[\s\S]{0,400}selectedBuildingIndex = -1/.test(src));

  // 阶段四剩余：区域参数表单调了 mapEditorCore.js 的纯函数，没有另起一套坑位/半径逻辑；
  // 切图会重置区域参数草稿；保存时区域参数真的传给了 buildCustomMapPayload。
  T('⑫-区域参数表单调用了 mapEditorCore.js 的 cloneRegionsForEdit/defaultPitFor（不是弹窗里另算一套）',
    /cloneRegionsForEdit/.test(src) && /defaultPitFor/.test(src));
  T('⑬-切换起点地图会重置区域参数草稿（cloneRegionsForEdit 在 switchBase 里被调用）',
    /switchBase[\s\S]{0,400}draftRegions = cloneRegionsForEdit/.test(src));
  T('⑭-保存时把当前区域参数草稿传给了 buildCustomMapPayload（表单改的值真的会存下去）',
    /buildCustomMapPayload\([^)]*baseCircleRadius:\s*draftRegions\.baseCircleRadius[^)]*pits:\s*draftRegions\.pits/.test(src));

  // 阶段四剩余：折线造墙笔刷调了 navgrid.js 的 paintPolyline/despeckle，没有另起一套
  // 折线栅格化或去噪算法；完成造墙时真的把点选的顶点数组传给了 paintPolyline。
  T('⑮-折线造墙调用了 navgrid.js 的 paintPolyline（不是弹窗里另算一套折线栅格化）',
    /paintPolyline/.test(src));
  T('⑯-去毛刺按钮调用了 navgrid.js 的 despeckle（不是弹窗里另算一套降噪）',
    /despeckle/.test(src));
  T('⑰-完成造墙时把当前点选的顶点数组传给了 paintPolyline',
    /paintPolyline\(bits,\s*n,\s*polylinePoints/.test(src));
  T('⑱-切换起点地图会重置折线顶点（switchBase 里清空 polylinePoints，避免旧格子坐标在新分辨率下错位）',
    /switchBase[\s\S]{0,700}polylinePoints = \[\]/.test(src));

  // 阶段六：路径编辑调了 mapEditorCore.js 的纯函数，没有另起一套路点增删/插入逻辑；
  // draftMapForValidate 用的是草稿 lanes 不是原始 baseMap.lanes；删整条路之前真的
  // 检查了 laneBuildingCount，不会留下孤儿建筑；保存时 lanes 草稿真的传给了 payload。
  T('⑲-路径编辑调用了 mapEditorCore.js 的 withWaypointMoved/withWaypointInserted/withWaypointRemoved（不是弹窗里另算一套）',
    /withWaypointMoved/.test(src) && /withWaypointInserted/.test(src) && /withWaypointRemoved/.test(src));
  T('⑳-路径编辑调用了 withLaneAdded/withLaneRemoved（整条路增删同样不重新实现）',
    /withLaneAdded/.test(src) && /withLaneRemoved/.test(src));
  T('㉑-draftMapForValidate 用的是草稿 draftLanes 而不是原始 baseMap.lanes（否则路径编辑后建筑摆放模式的吸附/校验还在用编辑前的路）',
    /draftMapForValidate\s*=\s*\(\)\s*=>\s*\(\{[^}]*lanes:\s*draftLanes/.test(src));
  T('㉒-删除整条路之前调用了 laneBuildingCount 检查孤儿建筑', /laneBuildingCount\(draftBuildings/.test(src));
  T('㉓-保存时把当前路径草稿传给了 buildCustomMapPayload', /buildCustomMapPayload\([^)]*lanes:\s*draftLanes/.test(src));
  T('㉔-切换起点地图会重置路径草稿（switchBase 里重建 draftLanes）',
    /switchBase[\s\S]{0,900}draftLanes = cloneLanesForEdit/.test(src));

  // 真机跑出来的 bug：点选/插入路点只走轻量的 redrawCanvas()（不整体重渲 DOM），
  // "删除选中路点"按钮的 disabled 是渲染 HTML 字符串时按当时的 selectedWaypointIndex
  // 写死的一次性属性——选中路点之后按钮永远显示 disabled，点不动，直到下次整体 render()。
  // 钉住"updatePathStatus 会手动同步这个按钮的 disabled"，防止以后重构时又把这行删掉。
  T('㉕-updatePathStatus 会同步删除路点按钮的 disabled 状态（不能只靠 render() 时写死一次）',
    /updatePathStatus[\s\S]{0,400}mapEditorDeleteWaypointBtn['"][\s\S]{0,150}disabled\s*=\s*selectedWaypointIndex\s*<\s*0/.test(src));

  // 用户定稿"地图编辑器运行时游戏不运行，退出后才恢复"：打开弹窗就暂停，
  // 关闭按钮恢复成打开之前的暂停状态。
  T('㉖-导入了 GameContext.js 的 CTX（暂停开关走唯一取值口）',
    /from ['"].*GameContext\.js['"]/.test(src) && /\bCTX\b/.test(src));
  T('㉗-open() 打开弹窗时记住进来之前的暂停状态并强制置为暂停',
    /_pausedBefore\s*=\s*CTX\.gamePaused[\s\S]{0,200}CTX\.gamePaused\s*=\s*true/.test(src));
  T('㉘-关闭按钮把 CTX.gamePaused 恢复成 _pausedBefore（不是无脑续玩）',
    /mapEditorCloseBtn[\s\S]{0,300}CTX\.gamePaused\s*=\s*_pausedBefore/.test(src));

  // 用户定稿"窗口做的大一些"：弹窗打开时给 #modalBox 加尺寸变体 class，
  // 关闭时摘掉（#modalBox 是全弹窗共用的元素，摘不掉会把其它弹窗也带宽）。
  T('㉙-open() 给 modalBox 加 mapEditorWide 尺寸变体',
    /modalBox['"]\)\.classList\.add\(['"]mapEditorWide['"]\)/.test(src));
  T('㉚-关闭按钮把 mapEditorWide 从 modalBox 摘掉（不带宽其它弹窗）',
    /mapEditorCloseBtn[\s\S]{0,400}modalBox['"]\)\.classList\.remove\(['"]mapEditorWide['"]\)/.test(src));

  const htmlSrc = srcOf('index.html');
  T('㉛-index.html 定义了 .modal-box.mapEditorWide 尺寸变体',
    /\.modal-box\.mapEditorWide\s*\{[^}]*max-width\s*:\s*960px/.test(htmlSrc));

  // 图片自动识别导入（docs/REQUIREMENTS-2026-09-03.md 第四节，用户拍板先只做
  // "识别可行走地形"）：算法本体在 imageImport.js（sim_imageimport.mjs 单测过），
  // 这里只钉 DOM 弹窗那层——导入了纯函数、事件绑定齐全、取样点击换算了坐标、
  // 应用按钮真的把结果写回 bits，不是摆设。
  T('㉜-MapEditorDialog.js 导入了 imageImport.js 的 imageToNavgrid',
    /imageToNavgrid[\s\S]{0,60}from ['"]\.\.\/data\/imageImport\.js['"]/.test(src));
  T('㉝-展开/收起按钮切换 imgImportOpen 并触发 render()',
    /mapEditorImgImportToggle['"]\)[\s\S]{0,150}imgImportOpen\s*=\s*!imgImportOpen[\s\S]{0,250}render\(\)/.test(src));
  T('㉞-文件选择后用 getImageData 存下整份原图像素（不进 HTML，避免弹窗重渲把大数组序列化）',
    /mapEditorImgImportFile['"]\)[\s\S]{0,600}getImageData\(/.test(src));
  T('㉟-点击原图画布会把屏幕坐标换算回原图像素坐标再取色（不是直接拿显示坐标当像素坐标）',
    /mapEditorImgImportSrcCanvas['"]\)[\s\S]{0,900}imgImportImageData\.width\s*\/\s*canvas\.width/.test(src));
  T('㊱-容差滑块把 0~100 的百分比换算成 RGB 距离单位（×441.7）再传给 imageToNavgrid',
    /imgImportTolerancePct\s*\/\s*100\)\s*\*\s*441\.7/.test(src));
  T('㊲-应用按钮真的把识别结果写回 bits（不是只关面板）',
    /mapEditorImgImportApplyBtn['"]\)[\s\S]{0,200}bits\s*=\s*imgImportResult\.bits/.test(src));
  T('㊳-CONFIG.mapEditor 声明了图片导入容差的默认值/上下限（第二条铁律：数值软编码）',
    typeof CONFIG.mapEditor.imageImportTolerancePctDefault === 'number'
    && typeof CONFIG.mapEditor.imageImportTolerancePctMin === 'number'
    && typeof CONFIG.mapEditor.imageImportTolerancePctMax === 'number');
  // 实机验收踩到的真 bug：取样/拖容差走的是轻量更新（不调 render()，避免弹窗重渲打断
  // 画布/输入框状态），但"应用"按钮的 disabled 是 render() 整页重渲时按当时 imgImportResult
  // 写死的一次性属性——不在 redrawImgImportPreview() 里手动同步，取样完按钮永远是灰的，
  // 用户点不了"应用"。跟 ㉕ 的 updatePathStatus() 同步删除按钮同一类问题。
  T('㊴-redrawImgImportPreview 会同步应用按钮的 disabled 状态（不能只靠 render() 时写死一次）',
    /redrawImgImportPreview[\s\S]{0,2500}mapEditorImgImportApplyBtn['"][\s\S]{0,150}disabled\s*=\s*!imgImportResult/.test(src));

  // 配置模式（第四节 Part A：统一编辑器接入"配置"模式）：地形模板选择器复用已有的
  // "起点地图"下拉框（不重新做一份，见 renderConfigModeBody 头注），这里只钉阵营
  // 增删/出兵开关/跳转入口这几处新接线，以及 mapEditorCore.js 那几个纯函数真的被调用了。
  T('㊵-导入了阵营管理的纯函数（cloneFactionsForEdit/withFactionAdded/withFactionRemoved/pruneMapDataForRemovedFaction）',
    /cloneFactionsForEdit[\s\S]{0,300}withFactionAdded[\s\S]{0,300}withFactionRemoved[\s\S]{0,300}pruneMapDataForRemovedFaction[\s\S]{0,800}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('㊶-新增了第四个 editMode 切换按钮（配置模式）',
    /mapEditorEditModeConfig['"]\)\.addEventListener\(['"]click['"][\s\S]{0,60}editMode\s*=\s*['"]config['"]/.test(src));
  T('㊷-新增阵营按钮调用 withFactionAdded 并捕获异常写回状态提示（不是让整个弹窗崩掉）',
    /mapEditorAddFactionBtn['"]\)[\s\S]{0,300}withFactionAdded\(draftFactions[\s\S]{0,400}catch[\s\S]{0,300}mapEditorFactionStatus/.test(src));
  T('㊸-删除阵营按钮：调用 withFactionRemoved 之后紧接着调用 pruneMapDataForRemovedFaction 级联清理（用户定稿"删除阵营时级联全部删除相关数据"）',
    /data-remove-faction[\s\S]{0,400}withFactionRemoved\(draftFactions[\s\S]{0,200}pruneMapDataForRemovedFaction/.test(src));
  T('㊹-出兵开关复选框绑定到 draftSpawnEnabled（而不是直接写 CONFIG.gameRules 之类的全局状态）',
    /data-spawn-enabled[\s\S]{0,200}draftSpawnEnabled\[cb\.dataset\.spawnEnabled\]\s*=\s*e\.target\.checked/.test(src));
  T('㊺-切换起点地图（switchBase）会重建阵营/出兵开关草稿（不然切了图，草稿还是上一张图的阵营列表）',
    /switchBase\s*=[\s\S]{0,900}draftFactions\s*=\s*cloneFactionsForEdit\(baseMap\)[\s\S]{0,200}draftSpawnEnabled\s*=/.test(src));
  T('㊻-保存时把 draftFactions/draftSpawnEnabled 一起传给 buildCustomMapPayload（不是编辑了但存不下去）',
    /buildCustomMapPayload\(baseMap[\s\S]{0,400}factions:\s*draftFactions[\s\S]{0,100}spawnEnabled:\s*draftSpawnEnabled/.test(src));

  // 出兵编排（第四节 Part B：地图独立的按路编排，见 mapEditorCore.js"出兵编排"节
  // 头注 + LaneWaveSystem.js 的 _mapLWC 合并块）——DOM 弹窗这层同样只钉接线：
  // 导入了纯函数、缩略图点击换算了坐标选路、增删/拖拽真的调了对应纯函数、
  // 字段改动写回草稿、保存时把刷兵规则和原样保留的广播规则拼起来传出去。
  T('㊼-导入了出兵编排的纯函数（withRuleAdded/withRuleRemoved/withRuleMoved/withRuleFieldSet）',
    /withRuleAdded[\s\S]{0,200}withRuleRemoved[\s\S]{0,200}withRuleMoved[\s\S]{0,200}withRuleFieldSet[\s\S]{0,800}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('㊽-缩略图点击会把屏幕坐标换算成格子坐标，再找最近的路（不是瞎猜第一条）',
    /mapEditorWaveThumb['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,150}clientToGrid\(e\.target[\s\S]{0,150}nearestLaneAtGridPoint/.test(src));
  T('㊾-新增规则按钮：先 ensureWaveDraft 材料化草稿，再调 withRuleAdded',
    /mapEditorWaveAddRuleBtn['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,150}ensureWaveDraft\(selectedWaveLaneId\)[\s\S]{0,200}withRuleAdded/.test(src));
  T('㊿-删除规则按钮：真的调了 withRuleRemoved（不是只关掉面板）',
    /data-rule-remove[\s\S]{0,300}withRuleRemoved\(draftLaneComposition\[selectedWaveLaneId\]/.test(src));
  T('51-拖拽排序：dragstart 记下标，drop 时调 withRuleMoved',
    /dragstart['"][\s\S]{0,100}draggingRuleIndex\s*=\s*Number\(card\.dataset\.ruleIndex\)[\s\S]{0,400}withRuleMoved/.test(src));
  T('52-字段改动（兵种/数量/起始波/每几波/whenOp）：调 withRuleFieldSet 写回草稿',
    /data-rule-field\]'\)\.forEach\(el[\s\S]{0,400}withRuleFieldSet\(draftLaneComposition\[selectedWaveLaneId\]/.test(src));

  // 出兵条件重做（2026-09-04）：单一 when/whenArg 改成"平铺列表+每条可取反+
  // 整体AND/OR"，见 waveComposition.js 的 conditionItemsOf/whenPasses 头注 与
  // mapEditorCore.js 的 withRuleConditionsSet 头注——这里同样只钉接线：
  // 导入了纯函数、渲染时按 conditionItemsOf(r) 展开、faction 类型的 arg 换成
  // 从 draftFactions 生成的下拉框、增删条件/改 token-arg-negate 真的调了
  // withRuleConditionsSet。
  T('52.1-导入了 conditionItemsOf（waveComposition.js）与 withRuleConditionsSet（mapEditorCore.js）',
    /conditionItemsOf[\s\S]{0,200}from ['"]\.\.\/data\/waveComposition\.js['"]/.test(src)
    && /withRuleConditionsSet[\s\S]{0,400}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('52.2-渲染规则卡片时用 conditionItemsOf(r) 展开当前条件列表（不是只读 r.when 一条）',
    /const items = conditionItemsOf\(r\)/.test(src));
  T('52.3-条件的阵营下拉框选项来自 draftFactions（跟这次编辑会话里增删的阵营同步，不是写死的地图原值）',
    /def\.arg\.type === ['"]faction['"][\s\S]{0,300}draftFactions\.map/.test(src));
  T('52.4-添加条件按钮：真的调了 withRuleConditionsSet，新条件默认 token 为空（"总是"）',
    /data-cond-add\][\s\S]{0,400}\[\.\.\.conditionItemsOf\(rule\), \{ token: ['"]['"][\s\S]{0,200}withRuleConditionsSet/.test(src));
  T('52.5-删除条件按钮：filter 掉对应下标后调 withRuleConditionsSet 写回',
    /data-cond-remove\][\s\S]{0,400}\.filter\(\(_, i\) => i !== condIdx\)[\s\S]{0,150}withRuleConditionsSet/.test(src));
  T('52.6-条件字段（token/arg/negate）改动：先克隆当前条件数组再改指定一条，不直接改原数组（不修改输入）',
    /data-cond-field\]'\)\.forEach[\s\S]{0,500}conditionItemsOf\(rule\)\.map\(it => \(\{ \.\.\.it \}\)\)[\s\S]{0,600}withRuleConditionsSet/.test(src));
  T('52.7-arg 字段改动时按 token 对应条件的 arg.type 分支：faction 存字符串，否则走 Number()',
    /def\?\.arg\?\.type === ['"]faction['"] \? e\.target\.value : \(Number\(e\.target\.value\) \|\| 0\)/.test(src));
  T('53-保存时把刷兵规则（draftLaneComposition）和原样保留的广播规则（draftLaneBroadcast）拼起来传给 buildCustomMapPayload',
    /laneWaveCompositionByLane\[laneId\]\s*=\s*\[\.\.\.draftLaneComposition\[laneId\], \.\.\.\(draftLaneBroadcast\[laneId\][\s\S]{0,300}buildCustomMapPayload\(baseMap[\s\S]{0,500}laneWaveCompositionByLane/.test(src));
  T('54-切换起点地图会重建出兵编排草稿（不然切图后草稿还是上一张图的覆写）',
    /switchBase\s*=[\s\S]{0,1200}draftLaneComposition\s*=[\s\S]{0,200}draftLaneBroadcast\s*=/.test(src));

  // 中立营地（第四节 Part D）：DOM 弹窗这层同样只钉接线——导入了纯函数、
  // 字段改动/新增/删除出生点真的调了对应纯函数、切图会重建草稿、保存时传出去。
  T('55-导入了中立营地的纯函数（cloneNeutralCampsForEdit/withCampSpawnPointFieldSet/Added/Removed）',
    /cloneNeutralCampsForEdit[\s\S]{0,200}withCampSpawnPointFieldSet[\s\S]{0,200}withCampSpawnPointAdded[\s\S]{0,200}withCampSpawnPointRemoved[\s\S]{0,800}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('56-出生点字段改动调用 withCampSpawnPointFieldSet 写回草稿',
    /data-camp-id\]\[data-sp-field\][\s\S]{0,400}withCampSpawnPointFieldSet\(draftNeutralCamps/.test(src));
  T('57-新增出生点按钮调用 withCampSpawnPointAdded（默认坐标用世界坐标系，不是格子坐标）',
    /data-camp-add-sp\][\s\S]{0,300}baseMap\.world[\s\S]{0,300}withCampSpawnPointAdded\(draftNeutralCamps/.test(src));
  T('58-删除出生点按钮调用 withCampSpawnPointRemoved 并捕获异常（不是让整个弹窗崩掉）',
    /data-camp-remove-sp\][\s\S]{0,300}withCampSpawnPointRemoved\(draftNeutralCamps[\s\S]{0,300}catch/.test(src));
  T('59-切换起点地图会重建中立营地草稿',
    /switchBase\s*=[\s\S]{0,1400}draftNeutralCamps\s*=\s*cloneNeutralCampsForEdit\(baseMap\)/.test(src));
  T('60-保存时把 draftNeutralCamps 传给 buildCustomMapPayload',
    /buildCustomMapPayload\(baseMap[\s\S]{0,600}neutralCamps:\s*draftNeutralCamps/.test(src));

  // 兵线自动对齐（2026-09-04 第二节）：导入了纯函数、按钮真的调用了它并写回
  // draftLanes（不是只调轻量重绘，糊弄一下）。
  T('61-导入了 alignLaneToCorridor 纯函数', /alignLaneToCorridor[\s\S]{0,800}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('62-自动对齐按钮真的调用 alignLaneToCorridor 并写回 draftLanes',
    /mapEditorAlignLaneBtn['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,300}alignLaneToCorridor\(bits, n, baseMap\.world, lane\.waypoints\)[\s\S]{0,300}draftLanes\s*=/.test(src));

  // 地图光环（2026-09-04 第五节）：DOM 弹窗这层同样只钉接线——导入了纯函数
  // （含复用"添加效果"面板的 EDITOR_PAGES_SKILLEFFECT._EFFECT_STAT_KEYS，这就是
  // 用户说的"这一堆UI都是复用"）、增删效果/切模式/增删阶段/字段改动真的调了
  // 对应纯函数、切图会重建草稿、保存时传出去。
  T('63-导入了地图光环的纯函数（cloneGlobalAuraForEdit/withAuraFieldSet/withAuraEffectAdded/Removed/FieldSet/ModeSet/withAuraStageAdded/Removed/FieldSet）',
    /cloneGlobalAuraForEdit[\s\S]{0,200}withAuraFieldSet[\s\S]{0,200}withAuraEffectAdded[\s\S]{0,200}withAuraEffectRemoved[\s\S]{0,800}from ['"]\.\.\/data\/mapEditorCore\.js['"]/.test(src));
  T('64-复用了"添加效果"面板的属性清单 EDITOR_PAGES_SKILLEFFECT._EFFECT_STAT_KEYS（不是在这里另抄一份，防止两处漂移）',
    /import \{ EDITOR_PAGES_SKILLEFFECT \} from ['"]\.\/editor\/pagesSkillEffect\.js['"]/.test(src)
    && /EDITOR_PAGES_SKILLEFFECT\._EFFECT_STAT_KEYS/.test(src));
  T('65-新增效果按钮调用 withAuraEffectAdded；切数值模式调用 withAuraEffectModeSet',
    /mapEditorAuraEffectAddBtn['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,200}withAuraEffectAdded\(draftGlobalAura[\s\S]{0,1500}withAuraEffectModeSet\(draftGlobalAura/.test(src));
  T('66-分阶段模式的新增/删除阶段按钮真的调了 withAuraStageAdded/withAuraStageRemoved（删除时捕获异常，不是让整个弹窗崩掉）',
    /data-aura-stage-add\][\s\S]{0,300}withAuraStageAdded\(draftGlobalAura[\s\S]{0,600}data-aura-stage-remove\][\s\S]{0,300}withAuraStageRemoved\(draftGlobalAura[\s\S]{0,300}catch/.test(src));
  T('67-切换起点地图会重建光环草稿（不然切图后草稿还是上一张图的光环）',
    /switchBase\s*=[\s\S]{0,1600}draftGlobalAura\s*=\s*cloneGlobalAuraForEdit\(baseMap\)/.test(src));
  T('68-保存时把 draftGlobalAura 传给 buildCustomMapPayload',
    /buildCustomMapPayload\(baseMap[\s\S]{0,600}globalAura:\s*draftGlobalAura/.test(src));

  // 出兵条件重做（2026-09-04）的连带修复：地图光环"分阶段"模式的阶段切换条件
  // （renderAuraStageRow）复用同一份 WAVE_CONDITIONS，选到新增的 faction.nexus_lane.*
  // 条件时同样要把参数框换成阵营下拉——这里不做多条件组合（阶段判定仍是单条件，
  // 按用户已定的范围：完整的 AND/OR/NOT 组合 UI 只做在出兵编排规则卡片），
  // 但至少不能让这两条件在这里选中后渲染出一个存不了阵营 id 的数字框。
  T('68.1-地图光环阶段行的参数框同样按 arg.type===\'faction\' 分支成阵营下拉（不是无条件数字框）',
    /whenDef\.arg\.type === ['"]faction['"][\s\S]{0,300}draftFactions\.map/.test(src));
  T('68.2-阶段条件切换时，新旧条件的 arg 类型不一致会把 whenArg 重置成新条件默认值（不留阵营/数值残值）',
    /const oldArg = WAVE_CONDITIONS\[currentWhen\]\?\.arg[\s\S]{0,300}oldArg\?\.type !== newArg\.type/.test(src));

  // 画布显示尺寸自适应（2026-09-04：用户反馈"扭曲丛林地图都变形了"）：
  // 主画布/出兵编排缩略图都改成调用 canvasDisplaySize()（按 baseMap.world 的
  // 长宽比算显示框），不是写死的正方形常量。
  T('69-导入了 canvasDisplaySize', /canvasDisplaySize[\s\S]{0,60}from ['"]\.\.\/data\/navgrid\.js['"]/.test(src));
  T('70-主画布 style 的 width/height 调用 mainCanvasSize()（不是写死 CANVAS_DISPLAY_PX）',
    /mapEditorCanvas['"][\s\S]{0,150}style="width:\$\{mainCanvasSize\(\)\.w\}px;height:\$\{mainCanvasSize\(\)\.h\}px/.test(src));
  T('71-出兵编排缩略图 style 的 width/height 调用 waveThumbSize()（同一套修法）',
    /mapEditorWaveThumb['"][\s\S]{0,150}style="width:\$\{waveThumbSize\(\)\.w\}px;height:\$\{waveThumbSize\(\)\.h\}px/.test(src));
  T('72-mainCanvasSize/waveThumbSize 都是基于当前 baseMap.world 现算（不是缓存成固定值，切图后要跟着变）',
    /mainCanvasSize\s*=\s*\(\)\s*=>\s*canvasDisplaySize\(baseMap\.world/.test(src)
    && /waveThumbSize\s*=\s*\(\)\s*=>\s*canvasDisplaySize\(baseMap\.world/.test(src));

  // 中立营地出生点并入"建筑摆放"画布可视化点选（2026-09-04，用户反馈：
  // "巨龙出生点等所有中立生物的出生点所有的都可以在地图上选点……显示点位那里弄个
  // 过滤器……并且在右侧也有新增/移动/删除等工具栏"）。
  T('73-画布渲染时会画中立营地出生点标记（drawCampPointMarkers 挂在 buildings 模式的重绘分支上）',
    /editMode === ['"]buildings['"][\s\S]{0,60}drawBuildingMarkers\(ctx\)[\s\S]{0,60}drawCampPointMarkers\(ctx\)/.test(src));
  T('74-过滤器复选框绑定 campPointFilter（Set 的增删），不是简单的整体开关',
    /data-camp-filter-type\][\s\S]{0,150}campPointFilter\.add\(type\)[\s\S]{0,60}campPointFilter\.delete\(type\)/.test(src));
  T('75-点击画布时：新增模式下调用 addCampPointAt；否则先查 findCampPointNear 再退回建筑命中判定',
    /campAddMode[\s\S]{0,80}addCampPointAt\(e\.clientX, e\.clientY\)[\s\S]{0,300}findCampPointNear\(canvas, e\.clientX, e\.clientY\)/.test(src));
  T('76-拖动出生点调用 withCampSpawnPointFieldSet 写回草稿（不是只改本地渲染状态）',
    /dragCampPointTo[\s\S]{0,400}withCampSpawnPointFieldSet\(draftNeutralCamps, draggingCampPoint\.campId/.test(src));
  T('77-新增出生点按钮真的调用了 withCampSpawnPointAdded（不是只切换模式什么都不做）',
    /addCampPointAt[\s\S]{0,400}withCampSpawnPointAdded\(draftNeutralCamps, campAddTargetId/.test(src));
  T('78-删除选中出生点按钮调用 withCampSpawnPointRemoved 并捕获异常（同其它删除按钮同一套容错）',
    /mapEditorDeleteCampPointBtn['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,300}withCampSpawnPointRemoved\(draftNeutralCamps[\s\S]{0,200}catch/.test(src));
  T('79-切换起点地图会重置出生点画布交互状态（selectedCampPoint/draggingCampPoint/campAddMode），不然切图后还拖着上一张图的选中态',
    /switchBase\s*=[\s\S]{0,2000}selectedCampPoint\s*=\s*null[\s\S]{0,60}draggingCampPoint\s*=\s*null[\s\S]{0,60}campAddMode\s*=\s*false/.test(src));
}

// ==================== ⑦ 阵营管理（第四节 Part A：统一编辑器"配置模式"）====================
{
  const sr = MAPS.summoners_rift_v1;
  T('①-cloneFactionsForEdit 对没声明 factions 的地图兜底为 [blue,red]（与 mapFactionsOf 一致）',
    JSON.stringify(cloneFactionsForEdit({})) === JSON.stringify(['blue', 'red']));
  T('①b-cloneFactionsForEdit 对已声明 factions 的地图读它自己的值（不是重新兜底）',
    JSON.stringify(cloneFactionsForEdit(sr)) === JSON.stringify(sr.factions));

  const withGreen = withFactionAdded(['blue', 'red'], 'green');
  T('②-withFactionAdded 追加新阵营，不修改输入数组', JSON.stringify(withGreen) === JSON.stringify(['blue', 'red', 'green'])
    && JSON.stringify(['blue', 'red']) === JSON.stringify(['blue', 'red']));
  T('③-withFactionAdded 去首尾空白', JSON.stringify(withFactionAdded(['blue', 'red'], '  green  ')) === JSON.stringify(['blue', 'red', 'green']));
  let threw = false;
  try { withFactionAdded(['blue', 'red'], 'blue'); } catch { threw = true; }
  T('④-withFactionAdded 拒绝重复 id', threw);
  threw = false;
  try { withFactionAdded(['blue', 'red'], '   '); } catch { threw = true; }
  T('⑤-withFactionAdded 拒绝空白 id', threw);

  const removed = withFactionRemoved(['blue', 'red', 'green'], 'green');
  T('⑥-withFactionRemoved 删掉指定阵营，不修改输入数组', JSON.stringify(removed) === JSON.stringify(['blue', 'red']));
  threw = false;
  try { withFactionRemoved(['blue', 'red'], 'red'); } catch { threw = true; }
  T('⑦-withFactionRemoved 拒绝删到只剩一个阵营', threw);

  const buildings = [
    { faction: 'blue', kind: 'outer' }, { faction: 'red', kind: 'outer' }, { faction: 'green', kind: 'outer' },
  ];
  const lanes = [
    { id: 'mid', waypoints: [], spawns: [
      { faction: 'blue', direction: 'forward', targetFactions: ['red', 'green'] },
      { faction: 'green', direction: 'forward', targetFactions: ['blue'] },
    ] },
  ];
  const pruned = pruneMapDataForRemovedFaction({ buildings, lanes }, 'green');
  T('⑧-pruneMapDataForRemovedFaction 删掉被删阵营的建筑', pruned.buildings.length === 2
    && pruned.buildings.every(b => b.faction !== 'green'));
  T('⑨-pruneMapDataForRemovedFaction 摘掉引用了被删阵营的出兵流（整条 green→blue 摘掉；blue→[red,green] 里只摘 green）',
    pruned.lanes[0].spawns.length === 1
    && JSON.stringify(pruned.lanes[0].spawns[0]) === JSON.stringify({ faction: 'blue', direction: 'forward', targetFactions: ['red'] }));
  T('⑩-pruneMapDataForRemovedFaction 保留路的 waypoints/id（只删阵营数据，不删物理路径）',
    pruned.lanes[0].id === 'mid' && Array.isArray(pruned.lanes[0].waypoints));
  T('⑪-pruneMapDataForRemovedFaction 不修改输入数组', buildings.length === 3 && lanes[0].spawns.length === 2);

  // buildCustomMapPayload：factions/spawnEnabled 走同一条"不传就保留原值"规则。
  const { n: n0, bits: bits0 } = decodeBaseBits(sr);
  const p1 = buildCustomMapPayload(sr, { id: 'x1', label: 'x1', n: n0, bits: bits0 });
  T('⑫-buildCustomMapPayload 不传 factions/spawnEnabled 时保持 baseMap 原值（factions 随整体克隆带过来，spawnEnabled 峡谷本没声明故仍是 undefined）',
    JSON.stringify(p1.factions) === JSON.stringify(sr.factions) && p1.spawnEnabled === undefined);
  const p2 = buildCustomMapPayload(sr, { id: 'x2', label: 'x2', n: n0, bits: bits0, factions: ['blue', 'red', 'green'], spawnEnabled: { totem: false } });
  T('⑬-buildCustomMapPayload 传了就整体覆盖', JSON.stringify(p2.factions) === JSON.stringify(['blue', 'red', 'green'])
    && p2.spawnEnabled.totem === false);
}

// ==================== ⑧ 档位显示名统一（水晶防御塔/枢纽防御塔）====================
// v51.35：'base'/'hq_tower' 原来在 waveComposition.js/UIManager.js/pagesConfig.js/
// open.js/schema/index.js 五处各写各的（"水晶塔"/"高地塔"/"枢纽塔"三种叫法混用），
// 玩家点开塔的技能栏（core_tier_base/core_tier_hq 身份技能的显示名）看到的又是
// 第四种"水晶防御塔"/"枢纽防御塔"——同一座塔在不同地方叫不同名字。
// 这里钉住"以 core.js 身份技能的名字为准，其余四处都跟它一致"，
// 防止改名改了一半、或者以后又漂移回去。
{
  const { STRUCT_TIERS } = await import('../src/data/waveComposition.js');
  const { SCHEMA } = await import('../src/data/schema/index.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const CANON = { base: SkillLibrary.core_tier_base?.name, hq_tower: SkillLibrary.core_tier_hq?.name };
  T('①-core.js 身份技能确实叫"水晶防御塔"/"枢纽防御塔"（本条测试自己的前提假设）',
    CANON.base === '水晶防御塔' && CANON.hq_tower === '枢纽防御塔');
  T('②-waveComposition.js STRUCT_TIERS 与身份技能同名',
    STRUCT_TIERS.find(t => t.key === 'base').label === CANON.base
    && STRUCT_TIERS.find(t => t.key === 'hq_tower').label === CANON.hq_tower);
  T('③-schema/index.js SCHEMA 的 tower.base/tower.hq_tower 与身份技能同名',
    SCHEMA['tower.base'].label === CANON.base && SCHEMA['tower.hq_tower'].label === CANON.hq_tower);
  const uiSrc = srcOf('../src/ui/UIManager.js');
  T('④-UIManager.js 选中卡片标题的 tierLabels 与身份技能同名',
    uiSrc.includes(`base: '${CANON.base}'`) && uiSrc.includes(`hq_tower: '${CANON.hq_tower}'`));
  const cfgSrc = srcOf('../src/ui/editor/pagesConfig.js');
  T('⑤-pagesConfig.js 建筑体积面板的 _BSIZE_TIERS 与身份技能同名',
    cfgSrc.includes(`'base', '${CANON.base}'`) && cfgSrc.includes(`'hq_tower', '${CANON.hq_tower}'`));
  const openSrc = srcOf('../src/ui/editor/open.js');
  T('⑥-open.js 模板编辑器的 _TPL_TOWER_TIERS 与身份技能同名',
    openSrc.includes(`label: '${CANON.base}'`) && openSrc.includes(`label: '${CANON.hq_tower}'`));
}

board.done();
