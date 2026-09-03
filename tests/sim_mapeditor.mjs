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
  cloneBuildingsForEdit, snapBuildingPos, withBuildingMoved, validateDraftMap, autoDetectTiers,
  cloneRegionsForEdit, defaultPitFor,
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
  T('⑤-建筑摆放调用了 mapEditorCore.js 的 snapBuildingPos/withBuildingMoved/validateDraftMap（拖拽吸附/校验逻辑不在弹窗里重新写一遍）',
    /snapBuildingPos/.test(src) && /withBuildingMoved/.test(src) && /validateDraftMap/.test(src));
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
}

// ==================== ⑦ 档位显示名统一（水晶防御塔/枢纽防御塔）====================
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
