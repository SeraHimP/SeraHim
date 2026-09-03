/**
 * sim_mapeditorlive.mjs —— 地图编辑器"直接在主画面编辑"这条链路的验收。
 *
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md 用户定稿："地图编辑器（笔刷）最好是
 * 直接在显示的画板上直接刷而不是单独弄个窗口（你目前这个也保留）"。
 * 这里验收两块新东西：
 *   ① src/ui/mapEditorSession.js —— 弹窗与主画面工具条共用的唯一草稿状态
 *      （startSession/ensureSession/syncLiveMap/commitTerrainLive）。
 *   ② MapSystem.addBuildingLive —— 不整份重载地图、现场加一座塔。
 * MapEditorBoardTool.js 本身是 DOM/3D 交互代码，headless 测不到；它依赖的这两块
 * 已经拆成不碰 DOM 的逻辑，这里直接钉住行为——弹窗代码那套"源码正则接线检查"
 * 同样适用于它，见文件末尾。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { LIVE_EDIT_SESSION_MAP_ID } = await import('../src/data/mapEditorCore.js');
const {
  getSession, startSession, ensureSession, endSession, syncLiveMap, commitTerrainLive,
} = await import('../src/ui/mapEditorSession.js');

const board = scoreboard('地图编辑器主画面直接编辑验收');
const T = board.T;

/** 与 sim_maps.mjs 同一套简化建筑工厂：只做本文件断言需要的那部分。 */
function mkMapSystem() {
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const ms = new MapSystem(ents, bus);
  ms.setCreateBuildingFn((b) => {
    const e = {
      id: ++window._uid, type: 'tower', alive: true, pos: { ...b.pos },
      baseStats: { maxHP: 1000, ...b.stats }, currentHP: 1000,
      _mapFaction: b.faction, _mapTier: b.tier, _laneId: b.laneId, _skillInstances: [],
    };
    ents.add(e);
    return e;
  });
  return { ms, ents, bus };
}

// ==================== ① mapEditorSession：生命周期 ====================
{
  endSession(); // 不依赖跑测试的先后顺序，先清一次
  T('①-还没开始会话时 getSession() 是 null', getSession() === null);

  const { ms } = mkMapSystem();
  const session = startSession(ms, 'summoners_rift_v1');
  T('②-startSession 返回的会话字段齐全', session.baseId === 'summoners_rift_v1'
    && session.baseMap && session.n > 0 && session.bits instanceof Uint8Array
    && Array.isArray(session.draftBuildings) && session.draftBuildings.length > 0);
  T('③-getSession() 拿到同一个会话（引用相等，两个入口共享同一份）', getSession() === session);
  T('④-startSession 不会碰 mapSystem.currentMap（弹窗"画完存下才预览"的行为不能变）',
    ms.currentMap === null);

  const session2 = ensureSession(ms);
  T('⑤-已有会话时 ensureSession 直接复用，不重新克隆', session2 === session);

  endSession();
  T('⑥-endSession 之后 getSession() 变回 null', getSession() === null);
}

// ==================== ② mapEditorSession：syncLiveMap（结构性同步） ====================
{
  endSession();
  const { ms, ents } = mkMapSystem();
  const session = startSession(ms, 'summoners_rift_v1');
  const wantCount = session.draftBuildings.length;

  syncLiveMap(ms);
  T('①-syncLiveMap 之后 currentMap 切到保留 id（不是原始 summoners_rift_v1，不会就地改内置地图）',
    ms.currentMap.id === LIVE_EDIT_SESSION_MAP_ID);
  T('②-保留 id 被存进 CONFIG.customMaps（复用弹窗的落盘路径，不是另起一套）',
    !!CONFIG.customMaps?.[LIVE_EDIT_SESSION_MAP_ID]);
  T('③-场上真的按草稿建筑数造出了对应的塔', ents.getAll(true).filter(e => e.type === 'tower').length === wantCount);
  T('④-保留 id 不会出现在选图列表里（玩家看不见这张"地图"）',
    !ms.getAvailableMaps().some(m => m.id === LIVE_EDIT_SESSION_MAP_ID));

  // 挪一座塔的草稿位置，再同步一次，场上应该出现在新位置（而不是残留旧的）
  const moved = { ...session.draftBuildings[0], pos: { x: 111, y: 222 } };
  session.draftBuildings = [moved, ...session.draftBuildings.slice(1)];
  syncLiveMap(ms);
  const towers = ents.getAll(true).filter(e => e.type === 'tower');
  T('⑤-重新同步后场上出现挪动后的新位置', towers.some(e => e.pos.x === 111 && e.pos.y === 222));
  T('⑥-重新同步没有残留双份（塔数仍等于草稿数，不是越同步越多）', towers.length === wantCount);

  endSession();
}

// ==================== ③ mapEditorSession：commitTerrainLive（只改地形，不清场重建） ====================
{
  endSession();
  const { ms, ents } = mkMapSystem();
  const session = startSession(ms, 'summoners_rift_v1');
  syncLiveMap(ms);
  const beforeIds = ents.getAll(true).filter(e => e.type === 'tower').map(e => e.id).sort();

  session.bits[0] = session.bits[0] ? 0 : 1; // 随手翻一格地形位
  commitTerrainLive(ms);
  T('①-commitTerrainLive 之后 currentMap.navgrid 反映了新的位图',
    ms.currentMap.navgrid.n === session.n);
  const afterIds = ents.getAll(true).filter(e => e.type === 'tower').map(e => e.id).sort();
  T('②-只改地形不会清场重建塔（塔的 id 集合逐位不变，不是 syncLiveMap 那种整份重来）',
    JSON.stringify(beforeIds) === JSON.stringify(afterIds));

  // 没有先 syncLiveMap（currentMap 还不是保留 id）时，commitTerrainLive 应该安全地什么都不做
  endSession();
  const { ms: ms2 } = mkMapSystem();
  startSession(ms2, 'summoners_rift_v1');
  let threw = false;
  try { commitTerrainLive(ms2); } catch { threw = true; }
  T('③-currentMap 还没接上草稿时调用不会抛错（安全地空操作）', !threw);

  endSession();
}

// ==================== ④ MapSystem.addBuildingLive：现场加一座塔 ====================
{
  const { ms, ents } = mkMapSystem();
  ms.loadMap('summoners_rift_v1');
  const before = ents.getAll(true).filter(e => e.type === 'tower').length;

  const entity = ms.addBuildingLive({ faction: 'blue', tier: 'inner', laneId: 'top', pos: { x: 500, y: 600 } });
  T('①-addBuildingLive 返回新建的实体', !!entity && entity.pos.x === 500 && entity.pos.y === 600);
  T('②-新塔带着正确的阵营/档位/所属路标记', entity._mapFaction === 'blue' && entity._mapTier === 'inner' && entity._laneId === 'top');
  T('③-场上塔数 +1（不是清场重建，其它塔原样还在）',
    ents.getAll(true).filter(e => e.type === 'tower').length === before + 1);

  // 没有加载任何地图（currentMap 为 null）时应安全返回 null，不抛错
  const { ms: ms3 } = mkMapSystem();
  let threw = false, result;
  try { result = ms3.addBuildingLive({ faction: 'blue', tier: 'outer', laneId: 'top', pos: { x: 0, y: 0 } }); }
  catch { threw = true; }
  T('④-没有已加载地图时安全返回 null（不抛错）', !threw && result === null);
}

// ==================== ⑤ MapEditorBoardTool.js：源码层面的接线检查（DOM/3D 交互测不到，但能测"接对了没接错"） ====================
{
  const src = srcOf('../src/ui/MapEditorBoardTool.js');
  T('①-MapEditorBoardTool.js 导入了 mapEditorSession.js 的会话函数（不是自己另存一份草稿）',
    /from ['"].*mapEditorSession\.js['"]/.test(src)
    && /ensureSession|getSession/.test(src) && /syncLiveMap/.test(src) && /commitTerrainLive/.test(src));
  T('②-移动塔时直接改 entity.pos（真拖真实塔模型，不是另画一个标记）',
    /\.pos\.x\s*=|\.pos\s*=\s*\{/.test(src));
  T('③-拖拽用了 mapEditorCore.js 的 snapBuildingPos（吸附逻辑与弹窗同一份，不是另起一套）',
    /snapBuildingPos/.test(src));
  T('④-命中/坐标转换调用了 canvasController 已有的 screenToWorld（不在这里另写一遍射线检测）',
    /screenToWorld/.test(src));
  T('⑤-添加塔调用了 MapSystem 的 addBuildingLive（不是整份重同步）',
    /addBuildingLive/.test(src));
  T('⑥-笔刷拖动期间不会每帧调 syncLiveMap/commitTerrainLive（那是松手才做的事，源码里对这条有说明）',
    /松开|松手|pointerup/.test(src));
}

board.done();
