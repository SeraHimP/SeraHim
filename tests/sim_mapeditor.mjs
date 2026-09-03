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
const { resolveBaseNavgrid, decodeBaseBits, cloneMapForEdit, buildCustomMapPayload } =
  await import('../src/data/mapEditorCore.js');
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
}

// ==================== ⑤ CONFIG.mapEditor 笔刷半径软编码 ====================
{
  T('①-CONFIG.mapEditor.brushRadiusGridDefault 存在且在 [min,max] 区间内',
    CONFIG.mapEditor.brushRadiusGridDefault >= CONFIG.mapEditor.brushRadiusGridMin &&
    CONFIG.mapEditor.brushRadiusGridDefault <= CONFIG.mapEditor.brushRadiusGridMax);
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
}

board.done();
