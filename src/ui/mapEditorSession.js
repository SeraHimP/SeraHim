/**
 * mapEditorSession.js —— 地图编辑器的**唯一**草稿状态。
 *
 * 用户定稿："地图编辑器（笔刷）最好是直接在显示的画板上直接刷而不是单独弄个窗口
 * （你目前这个也保留）"——现在有两个入口在编辑同一张草稿：弹窗（MapEditorDialog.js，
 * 独立 2D 俯视画布）和主画面工具条（MapEditorBoardTool.js，直接在 3D 场景上拖）。
 * 两个入口如果各存一份 { baseMap, n, bits, draftBuildings }，切换入口就会互相看不见
 * 对方的改动——这正是 docs/DEVELOPMENT.md §3.5"同一个量只能有一个取值口"要防的事。
 * 这里是这份草稿状态**唯一**存在的地方，两个入口都读/写这一个 session。
 *
 * ==================== startSession 本身不碰 mapSystem.currentMap ====================
 * 弹窗原来的行为是"画完存下、存完才一键加载预览"——编辑期间**不影响**正在显示/正在跑
 * 的那局。这条行为不能因为这次重构悄悄变掉（改了就是本次重构自己引入的副作用，
 * 不是用户要的）。所以 session 本身只管草稿数据，谁要在 3D 场景里所见即所得，
 * 由调用方自己决定何时把 `mapSystem.currentMap` 接到草稿上——见
 * `activateLiveEditing()`，只有主画面工具条会调它。
 *
 * ==================== activateLiveEditing 怎么让 3D 场景显示这份草稿 ====================
 * 3D 场景里的塔是**真实体**（entityContainer 里的 tower 类型实体，UnitLayer 按
 * entity.pos 每帧画），不是弹窗那种"画几个色点"的抽象预览——想让场上出现与草稿一致的
 * 塔，必须真的把它们造出来。造塔只有一条安全的路：`MapSystem.loadMap()`
 * （它会先 `clearCurrentMap()` 收掉上一批塔，再按 `map.buildings` 顺序逐个建）。
 * 但 `loadMap()` 只认注册表里的 id（`MAPS` 或 `CONFIG.customMaps`），不能直接喂给它
 * 一个游离对象；而且**决不能**为了这件事就地改内置地图或用户已保存的自制地图
 * （`mapEditorCore.js` 的 `cloneMapForEdit` 头注同一条底线）。
 * 于是复用弹窗早就在用的落盘路径——存进 `CONFIG.customMaps` 再 `loadMap()`——
 * 只是自动存到 `LIVE_EDIT_SESSION_MAP_ID` 这个保留 id 下，不需要用户手动填一次；
 * `MapSystem.getAvailableMaps()`/弹窗的"已保存的自制地图"列表都已经把这个 id
 * 过滤掉了（见 mapEditorCore.js 对该常量的说明），玩家看不见它。
 * 之后单纯的地形笔刷或塔位拖拽（没有增删塔）不需要重新调这个函数——见
 * `MapEditorBoardTool.js` 对"结构性变化才重新同步"的注释。
 */
import {
  decodeBaseBits, cloneBuildingsForEdit, cloneMapForEdit, buildCustomMapPayload, LIVE_EDIT_SESSION_MAP_ID,
} from '../data/mapEditorCore.js';
import { packBits } from '../data/navgrid.js';
import { CONFIG } from '../data/Config.js';

let _session = null;

/** 当前会话（还没开始过就是 null）。两个入口都用它读当前草稿状态。 */
export function getSession() {
  return _session;
}

/**
 * 开始/重置一次编辑会话：以 baseId 对应的地图为起点克隆一份，草稿建筑/地形位图
 * 都基于这份克隆解出。不touch `mapSystem.currentMap`（见文件头注）。
 * @param {object} mapSystem
 * @param {string} baseId
 * @returns {object} 新会话
 */
export function startSession(mapSystem, baseId) {
  const original = mapSystem.getMapById(baseId);
  if (!original) throw new Error('mapEditorSession.startSession: 地图不存在 ' + baseId);
  const clone = cloneMapForEdit(original);
  const { n, bits } = decodeBaseBits(clone);
  _session = { baseId, baseMap: clone, n, bits, draftBuildings: cloneBuildingsForEdit(clone) };
  return _session;
}

/** 已有会话就直接返回；否则以 mapSystem 当前地图（或第一张可用地图）起个新的。 */
export function ensureSession(mapSystem) {
  if (_session) return _session;
  const baseId = mapSystem.currentBaseMapId || mapSystem.getAvailableMaps()[0]?.id;
  return startSession(mapSystem, baseId);
}

/** 结束会话（关闭编辑器所有入口时调用，避免下次打开还拿着上一张图的草稿）。 */
export function endSession() {
  _session = null;
}

/**
 * 主画面工具条专用：把当前会话的草稿（地形 + 建筑）整份同步进 3D 场景——存进
 * `CONFIG.customMaps[LIVE_EDIT_SESSION_MAP_ID]` 再 `mapSystem.loadMap()`，
 * 复用弹窗保存/预览那条已经跑通的路径（见文件头注）。这是**结构性**同步：
 * 会清空重建全场的塔。只有下面两种情况需要调它：
 *   ① 主画面工具条刚激活（场上还没有与草稿对应的塔）；
 *   ② 增删了一座塔（挪动已有塔的位置走 `mapSystem.addBuildingLive` 或直接改
 *     `entity.pos`，不需要整份重同步——见 MapEditorBoardTool.js 的用法说明）。
 * @param {object} mapSystem
 * @param {object} [renderer3d] 有则顺带失效地形缓存，让笔刷改的地形立即重渲染
 * @returns {object} 当前会话
 */
export function syncLiveMap(mapSystem, renderer3d) {
  const session = ensureSession(mapSystem);
  const payload = buildCustomMapPayload(session.baseMap, {
    id: LIVE_EDIT_SESSION_MAP_ID, label: session.baseMap.label,
    n: session.n, bits: session.bits, buildings: session.draftBuildings,
  });
  if (!CONFIG.customMaps || typeof CONFIG.customMaps !== 'object') CONFIG.customMaps = {};
  CONFIG.customMaps[LIVE_EDIT_SESSION_MAP_ID] = payload;
  mapSystem.loadMap(LIVE_EDIT_SESSION_MAP_ID);
  renderer3d?.invalidateTerrain?.();
  return session;
}

/**
 * 只有地形位图变了（笔刷画完一笔松手），不需要整份重同步——3D 场景里已经加载的
 * 是 `LIVE_EDIT_SESSION_MAP_ID` 这份草稿地图对象本身（`syncLiveMap` 建立的），
 * 直接改它的 `navgrid` 字段 + 失效两处地形缓存即可，不用清场重建塔。
 * @param {object} mapSystem
 * @param {object} [renderer3d]
 */
export function commitTerrainLive(mapSystem, renderer3d) {
  const session = getSession();
  if (!session || mapSystem.currentMap?.id !== LIVE_EDIT_SESSION_MAP_ID) return;
  mapSystem.currentMap.navgrid = { n: session.n, bits: packBits(session.bits) };
  mapSystem.invalidateNav?.();
  renderer3d?.invalidateTerrain?.();
}
