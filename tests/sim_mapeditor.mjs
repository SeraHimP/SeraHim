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
  cloneBuildingsForEdit, snapBuildingPos, withBuildingMoved, validateDraftMap,
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
  T('⑤-建筑摆放调用了 mapEditorCore.js 的 snapBuildingPos/withBuildingMoved/validateDraftMap（拖拽吸附/校验逻辑不在弹窗里重新写一遍）',
    /snapBuildingPos/.test(src) && /withBuildingMoved/.test(src) && /validateDraftMap/.test(src));
  T('⑥-保存时把当前草稿建筑数组传给了 buildCustomMapPayload（拖拽结果真的会存下去，不是只在画布上好看）',
    /buildCustomMapPayload\([^)]*buildings:\s*draftBuildings/.test(src));
  T('⑦-切换起点地图会重置草稿建筑（cloneBuildingsForEdit 在 switchBase 里被调用，不是只在弹窗打开时调一次）',
    /switchBase[\s\S]{0,400}cloneBuildingsForEdit/.test(src));
  T('⑧-建筑标记半径在重画函数里现算，不是模块顶层的一次性常量（切图后 n 变了，写成一次性常量会画错大小）',
    /drawBuildingMarkers[\s\S]{0,200}buildingMarkerRadiusPx/.test(src));
}

board.done();
