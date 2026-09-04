/**
 * mapComposition.js —— 地形模板 / 玩法配置 的拆分与拼装（唯一实现）
 *
 * ==================== 背景 ====================
 * 用户："出兵编排 UI 应该算一个小型引擎……和地形编辑器兵线那里打通，编排可以
 * 独立选择（和地图相独立），可能存在一张地图上，地图模板相同，但是塔位/兵线/
 * 中立生物/阵营可能都不同。"
 *
 * 现状（改动前）：一张地图是一个揉在一起的对象——`world`/`navgrid` 这类物理
 * 地形，跟 `lanes`/`buildings`/`factions`/出兵节奏这类"这张地形上打什么仗"
 * 的玩法内容，字段上完全没有分界。想在同一片地形上配出第二种打法，
 * 只能把整个对象复制一份改，两份数据从此各改各的、没有"共用同一份地形"这件事。
 *
 * 现在拆成两层：
 *   - **地形模板**（TERRAIN_FIELDS）：只装物理几何——世界尺寸、可行走位图/走廊
 *     半宽、地形高低差、障碍物。跟"打谁、怎么打"完全无关，换掉配置层不用碰它。
 *   - **玩法配置**（CONFIG_FIELDS）：阵营声明、兵线路径、建筑/塔位、基地圈、
 *     全局光环、建筑数值覆写、出兵节奏……同一份地形模板可以配出好几份配置，
 *     各自独立存档、独立编辑。
 *
 * ==================== 为什么不改 MapSystem ====================
 * `MapSystem.loadMap`/`LaneWaveSystem` 等一大票下游系统读的都是"一个揉在一起
 * 的地图对象"（`currentMap.lanes`、`currentMap.navgrid` 平级并列）——这个契约
 * 不用变。地形/配置的拆分只发生在**编辑/存档时刻**：`composeMap()` 把一份地形
 * 模板和一份玩法配置拼成一个完整地图对象，拼好之后跟改动前手写的地图对象
 * 长得一模一样，直接能塞进 `CONFIG.customMaps[id]`（MapSystem 已经在读的那个
 * 注册表，见 MapSystem._mapRegistry 头注）。运行时系统全程不知道"地形/配置"
 * 这回事，只有编辑器和这个文件知道。
 *
 * ==================== 现有三张地图怎么办（2026-09-04 更新：已迁移）====================
 * 【此段历史决定已被推翻，原文保留仅供追溯】曾经拍板"现有三张地图不迁移"——
 * 源码继续保持"一个对象揉在一起"的写法，理由是怕牵连它们身上大量的既有
 * 测试/平衡数据。
 *
 * 2026-09-04：用户明确要求"把老地图都接入新的框架，包括地形，光环等等"，
 * 推翻了这条决定。summoners_rift.js / twisted_treeline.js / howling_abyss.js
 * 三个源文件现在都在内部拆成 `XX_TERRAIN` + `XX_CONFIG` 两个对象常量，末尾用
 * `composeMap({ terrain, config })` 拼回原来那个"一个对象揉在一起"的导出——
 * **对外导出的形状完全没变**（用脚本做过深度比较，逐字段值一致，只新增了
 * 一个 neutralCamps 字段），下游 MapSystem/所有系统全程无感知，改动只发生在
 * 这三个源文件内部怎么组织自己的数据。见 tests/sim_mapcomposition.mjs ④ 的
 * 源码正则断言，钉住"这三个文件确实在用 composeMap()"这件事，防止以后有人
 * 手滑改回整体对象又不吱声。
 *
 * `extractTerrainFromMap()`/`extractConfigFromMap()` 仍然保留（用途不变）：
 * 供编辑器"以任意一张图——不论内置还是自制——的地形为模板新建配置"时现场
 * 只读提取用。
 */

/**
 * 地形模板拥有的字段——纯物理几何，跟阵营/兵种/出兵节奏无关。
 * 单一来源：composeMap/splitMapIntoTerrainAndConfig 都从这张表生成，
 * 不在两处各写一份字段清单（这正是本项目一贯要防的那种"同一件事两份实现"）。
 */
export const TERRAIN_FIELDS = [
  'world', 'useNavgrid', 'navgrid', 'walls', 'heightZones', 'highground', 'obstacles',
];

/**
 * 玩法配置拥有的字段——阵营声明、路径/建筑、数值覆写、出兵节奏等一切"打法"内容。
 * 覆盖了现有三张地图除 TERRAIN_FIELDS/id/label 之外的全部顶层字段。
 */
export const CONFIG_FIELDS = [
  'factions', 'lanes', 'buildings',
  'baseCenters', 'baseCircleRadius', 'baseOpenRadius', 'gateTier',
  'dragon', 'pits',
  'tierStats', 'skillOverrides', 'excludeSkills',
  'waveInterval', 'firstWaveDelay', 'spawnGap', 'waveColumns', 'columnSpacing', 'nexusRespawnTime',
  'globalAura', 'spawnEnabled', 'laneWaveCompositionByLane', 'neutralCamps',
];

/**
 * 把一份地形模板和一份玩法配置拼成一个完整地图对象——形状与手写的地图源码
 * （summoners_rift.js 那种）完全一致，可以直接存进 CONFIG.customMaps[id]。
 * @param {{terrain:object, config:object}} o
 *   terrain 只读 TERRAIN_FIELDS 里的字段，config 只读 CONFIG_FIELDS 里的字段
 *   （多传了不认识的字段会被忽略，缺的字段拼出来的地图对象里就没有那个 key，
 *   跟"手写地图源码时那个字段本来就没写"是同一回事，下游系统各自的
 *   `map.xxx ?? 默认值` 兜底逻辑照常生效）。
 * @returns {object} 完整地图对象
 */
export function composeMap({ terrain, config }) {
  if (!terrain) throw new Error('composeMap: terrain 不能为空');
  if (!config) throw new Error('composeMap: config 不能为空');
  if (!config.id) throw new Error('composeMap: config.id 不能为空');
  const out = { id: config.id, label: config.label || config.id };
  for (const k of TERRAIN_FIELDS) if (terrain[k] !== undefined) out[k] = terrain[k];
  for (const k of CONFIG_FIELDS) if (config[k] !== undefined) out[k] = config[k];
  return out;
}

/**
 * 从一张完整地图（内置或自制）现算出它的地形部分——只读提取，不改原对象。
 * 用户拍板："只用于以后新建的地图"：这个函数不会、也不需要去改召唤师峡谷等
 * 现有地图的源码，只是在编辑器里"想拿这张图的地形当模板"时现场抽一份。
 * @param {object} map 完整地图对象
 * @returns {object} 只含 TERRAIN_FIELDS 里字段的地形模板（深拷贝，改它不影响原地图）
 */
export function extractTerrainFromMap(map) {
  const out = {};
  for (const k of TERRAIN_FIELDS) if (map[k] !== undefined) out[k] = JSON.parse(JSON.stringify(map[k]));
  return out;
}

/**
 * 从一张完整地图现算出它的玩法配置部分（同上，只读提取）。
 * id/label 一并带出（配置层是"这张地图打什么内容"的身份来源，见文件头注），
 * 调用方新建配置时通常会立刻覆盖成新 id，这里原样带出只是为了"以这张图的
 * 配置当起点微调"这种用法方便。
 * @param {object} map
 * @returns {object}
 */
export function extractConfigFromMap(map) {
  const out = { id: map.id, label: map.label };
  for (const k of CONFIG_FIELDS) if (map[k] !== undefined) out[k] = JSON.parse(JSON.stringify(map[k]));
  return out;
}
