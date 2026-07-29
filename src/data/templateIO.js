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
  'gameRules',            // 出兵编排 + 沙盒节奏 + 兵种开关
  'world',                // 昼夜/熵/龙魂耦合与加成
];

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

/** 导出为普通对象（调用方自行 JSON.stringify）。 */
export function exportTemplates(CONFIG) {
  const out = { _seraHimTemplates: IO_VERSION, _exportedAt: new Date().toISOString() };
  for (const g of IO_GROUPS) {
    if (CONFIG[g] === undefined) continue;
    out[g] = JSON.parse(JSON.stringify(CONFIG[g]));
  }
  return out;
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
