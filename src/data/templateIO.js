/**
 * templateIO.js —— 模板配置的导出/导入（JSON）
 *
 * 为什么单独成模块而不是写在编辑器里：
 *   ① 编辑器跑在浏览器里，headless 测不到。序列化格式一旦和运行时读的字段错位，
 *      表现是"导入之后数值悄悄变了"——这种 bug 靠肉眼是发现不了的，必须能自动回归。
 *   ② 导出的东西以后要给地图编辑器 / 存档复用，不该锁死在一个弹窗里。
 *
 * 口径：**只导出用户改得动的那些配置分组**，不导出运行时状态（场上单位、波次进度）。
 * 导入采用【深合并】而不是整体替换：JSON 里没写的键保持现值。
 * 理由是配置会持续新增字段，整体替换会让旧存档一导入就把新字段抹成 undefined，
 * 而这些字段散布在各系统里、缺失时多半不是报错而是行为静默变样，极难排查。
 */

// 可导出的配置分组白名单。加新分组时【只需在这里加一行】，
// 导出/导入/测试三边自动跟上——不要在别处再抄一份键名列表。
export const IO_GROUPS = [
  'templates',            // 各类型基础模板
  'towerTierOverrides',   // 分层塔数值覆写
  'towerTierSkills',      // 分层塔被动
  'towerTierEffects',     // 分层塔状态
  'towerTierWeapon',      // 分层塔武器
  'towerVizScale',        // 建筑可视半径倍率（同时影响避障，见 EntityContainer）
  'buildingSizes',
  'factionOverrides',     // 阵营覆写层
  'battleGrowth',         // 对战成长
  'rend',                 // 屠戮
  'gameRules',            // 出兵编排 + 兵种开关 + 龙魂规则
  'world',                // 昼夜/熵/龙魂耦合与加成
  'skillOverrides',       // 技能参数覆写（按 skillId → { 参数: 值 }）
  'effectOverrides',      // 状态/效果参数覆写
  'mapOverrides',         // 地图级覆写（河道/坑位/层级数值/技能改写）
  // ===== 自制内容（用户"自己做一个"的成果，见 src/data/customContent.js）=====
  // 这三组是用户的**创作**，不是调过的数字 —— 存档里丢了就等于作品没了，
  // 所以它们和其它分组一样走同一条导出/导入通道，没有例外路径。
  'customEffects',        // 自制状态（纯数据蓝图）
  'customSkills',         // 自制技能/武器（声明式规格，由 behaviorVM 编译）
  'customMinions',        // 自制兵种（模板数据）
  'customMaps',           // v51.32：地图编辑器画出来的自制地图（结构与内置地图对象一致，
                           // 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.5）。不需要
                           // customContent.js 那套"编译并注册"——地图是纯数据，
                           // MapSystem._mapRegistry() 按需读取，不用像技能那样启动时预编译。
];

// 上面三个 *Overrides 分组可能尚未在 CONFIG 里存在（按需创建）。
// 列进白名单是为了让导出的存档**结构稳定** —— 存档格式不该随"用户这次有没有改过技能"
// 而时有时无，否则做前后对比（diff 两个存档）时会满屏是结构差异而不是数值差异。
export const IO_ENSURE = ['skillOverrides', 'effectOverrides', 'mapOverrides',
                          'customEffects', 'customSkills', 'customMinions', 'customMaps'];

export const IO_VERSION = 1;

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深合并 src 进 dst（就地）。数组整体替换——出兵编排的顺序就是语义，逐项合并会得到一个谁都没要过的顺序。 */
export function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (isPlainObject(v)) {
      if (!isPlainObject(dst[k])) dst[k] = {};
      deepMerge(dst[k], v);
    } else if (Array.isArray(v)) {
      dst[k] = v.map(x => (isPlainObject(x) ? { ...x } : x));
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

/** 确保按需分组存在（幂等）。运行时与导出共用，避免两边对"有没有这个键"看法不一致。 */
export function ensureGroups(CONFIG) {
  for (const g of IO_ENSURE) if (!isPlainObject(CONFIG[g])) CONFIG[g] = {};
  return CONFIG;
}

/** 导出为普通对象（调用方自行 JSON.stringify）。 */
export function exportTemplates(CONFIG) {
  ensureGroups(CONFIG);
  const out = { _seraHimTemplates: IO_VERSION, _exportedAt: new Date().toISOString() };
  for (const g of IO_GROUPS) {
    if (CONFIG[g] === undefined) continue;
    out[g] = JSON.parse(JSON.stringify(CONFIG[g]));
  }
  return out;
}

/**
 * 存档文件名。带日期便于按时间排序，不带时间戳以便同一天反复覆盖同一个文件。
 * 单独成函数是为了让"另存为"和"下载降级"两条路径拿到同一个名字。
 */
export function suggestedFileName(prefix = 'serahim-config') {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * 导入。返回 { ok, groups, skipped, error }。
 * 白名单之外的键一律忽略并列进 skipped —— 导入的 JSON 可能是用户手改的，
 * 让它能往 CONFIG 上挂任意键等于给自己埋雷。
 */
export function importTemplates(CONFIG, data) {
  if (!isPlainObject(data)) return { ok: false, groups: [], skipped: [], error: '不是一个 JSON 对象' };
  if (data._seraHimTemplates === undefined) {
    return { ok: false, groups: [], skipped: [], error: '缺少 _seraHimTemplates 版本标记，不像是本编辑器导出的文件' };
  }
  if (data._seraHimTemplates > IO_VERSION) {
    return { ok: false, groups: [], skipped: [], error: `文件版本 ${data._seraHimTemplates} 高于当前支持的 ${IO_VERSION}` };
  }
  const groups = [], skipped = [];
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_')) continue;
    if (!IO_GROUPS.includes(k)) { skipped.push(k); continue; }
    if (!isPlainObject(v)) { skipped.push(k); continue; }
    if (!isPlainObject(CONFIG[k])) CONFIG[k] = {};
    deepMerge(CONFIG[k], v);
    groups.push(k);
  }
  return { ok: true, groups, skipped, error: null };
}
