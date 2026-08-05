import { CONFIG } from './Config.js';

/**
 * waveComposition.js
 * 对战模式「出兵编排」的唯一真源。
 *
 * 编排规则本身存在 CONFIG.gameRules.laneWaveComposition（数组顺序 = 出兵顺序），
 * 这里只放"把规则展开成一波的兵种序列"的那段纯函数逻辑。
 *
 * 为什么单独抽出来：模板编辑器的「出兵顺序」面板要做实时预览（"第 N 波会出什么"），
 * 如果在 UI 里另抄一份同样的筛选逻辑，两份实现迟早会漂移，预览就会骗人。
 * LaneWaveSystem 与编辑器共用本函数，预览与真实出兵天然一致。
 */

/** 单条规则的字段说明（供 UI 生成表单，避免 UI 里再硬编码一份字段表） */
export const RULE_FIELDS = {
  count:    { label: '数量',       min: 0, step: 1, def: 1 },
  fromWave: { label: '起始波次',   min: 0, step: 1, def: 0 },
  everyN:   { label: '每几波一次', min: 1, step: 1, def: 1 },
};

// ==================== 出兵条件（when）====================
// 这里是「条件」下拉框的**唯一来源**：加一条新条件只改这张表，
// 编辑器的选项、真实出兵的判定、批量模拟一起跟上。
// （behaviorVM 的 TRIGGERS/CONDITIONS/ACTIONS 是同一个套路 —— UI 里不要再抄一份清单。）
//
// 判定用的世界快照 ctx 由 LaneWaveSystem 现场组装：
//   { faction, enemy, laneId, gameTime, nexusDown, census }
// census 来自 MapSystem.structureCensus()：{ 阵营: { all: {档位:{total,alive}},
// lanes: { 路: {档位:{total,alive}} } }}。拿不到 census 时（沙盒/单测）
// 所有依赖建筑的条件一律**放行**，宁可多出兵也不要静默漏兵 —— 一条规则突然不生效、
// 却没有任何报错，是这类编排最难查的故障。

/** 档位：分路的四档 + 全场的两档。key 与地图 buildings 的 tier 同名。 */
export const STRUCT_TIERS = [
  { key: 'outer',      label: '外塔',     lane: true },
  { key: 'inner',      label: '内塔',     lane: true },
  { key: 'base',       label: '水晶塔',   lane: true },
  { key: 'nexus_lane', label: '召唤水晶', lane: true },
  { key: 'hq_tower',   label: '枢纽塔',   lane: false },
  { key: 'nexus_main', label: '水晶枢纽', lane: false },
];

const SIDES = [
  { key: 'ally',  label: '我方', of: (c) => c.faction },
  { key: 'enemy', label: '敌方', of: (c) => c.enemy },
];

/** 取某方某档在【本路】（分路档位）或【全场】（枢纽档位）的存活/总数。 */
function tally(ctx, sideKey, tier) {
  const census = ctx && ctx.census;
  if (!census) return null;
  const side = SIDES.find(x => x.key === sideKey);
  const fac = side && side.of(ctx);
  const box = fac && census[fac];
  if (!box) return null;
  const meta = STRUCT_TIERS.find(t => t.key === tier);
  const src = (meta && meta.lane && ctx.laneId)
    ? ((box.lanes && box.lanes[ctx.laneId]) || {})
    : (box.all || {});
  return src[tier] || null;
}

/**
 * 条件表。每项 { label, group, arg?, test(ctx, arg) }。
 * test 返回 true 表示"这一条规则本波生效"。arg 存在时表示该条件需要一个数值参数
 * （存在规则的 whenArg 字段上）。
 */
export const WAVE_CONDITIONS = {
  '': { label: '总是', group: '基础', test: () => true },
  // 兼容旧存档里的两个 token：语义 = 本路（敌方）召唤水晶是否已全灭。
  // 它们和下面的 enemy.nexus_lane.allDown / .anyAlive 是同一件事，
  // 保留是为了老配置导进来不失效，新建规则请用下面那组。
  'nexusDown':  { label: '本路水晶已陷落（旧写法）', group: '基础', test: (c) => !!c.nexusDown },
  '!nexusDown': { label: '本路水晶未陷落（旧写法）', group: '基础', test: (c) => !c.nexusDown },
  // gameTime 缺失（沙盒/单测/旧调用不传 ctx）时【放行】，与建筑条件拿不到 census
  // 时的口径一致。若按 0 秒算，"游戏满 10 分钟才出的兵"会在所有不带 ctx 的调用里
  // 静默消失 —— 一条规则突然不生效却不报错，是这类编排最难查的故障。
  'time.after':  { label: '游戏已进行 ≥ N 秒', group: '时间',
                   arg: { label: '秒', def: 600, min: 0, step: 30 },
                   test: (c, n) => c.gameTime == null || c.gameTime >= (n ?? 0) },
  'time.before': { label: '游戏进行不足 N 秒', group: '时间',
                   arg: { label: '秒', def: 600, min: 0, step: 30 },
                   test: (c, n) => c.gameTime == null || c.gameTime < (n ?? 0) },
};

// 建筑条件：档位 × 我方/敌方 × 三种成色。共 36 条，全部由这张表生成 ——
// 手写 36 个 case 迟早漏掉一两个，而漏掉的那个不会报错，只会"这条规则从不生效"。
for (const side of SIDES) {
  for (const t of STRUCT_TIERS) {
    const where = t.lane ? '本路' : '全场';
    const base = `${side.key}.${t.key}`;
    const grp = `${side.label}建筑`;
    WAVE_CONDITIONS[base + '.allDown'] = {
      label: `${side.label}${where}${t.label} 全部被摧毁`, group: grp,
      test: (c) => { const n = tally(c, side.key, t.key); return n ? n.alive === 0 && n.total > 0 : true; },
    };
    WAVE_CONDITIONS[base + '.anyDown'] = {
      label: `${side.label}${where}${t.label} 至少一座被摧毁`, group: grp,
      test: (c) => { const n = tally(c, side.key, t.key); return n ? n.alive < n.total : true; },
    };
    WAVE_CONDITIONS[base + '.allAlive'] = {
      label: `${side.label}${where}${t.label} 全部完好`, group: grp,
      test: (c) => { const n = tally(c, side.key, t.key); return n ? n.alive === n.total : true; },
    };
  }
}

/** 下拉框用：按 group 归类后的选项列表（编辑器直接渲染成 optgroup）。 */
export function whenOptionGroups() {
  const groups = [];
  for (const [value, def] of Object.entries(WAVE_CONDITIONS)) {
    let g = groups.find(x => x.label === def.group);
    if (!g) { g = { label: def.group, items: [] }; groups.push(g); }
    g.items.push({ value, label: def.label, arg: def.arg || null });
  }
  return groups;
}

/** 兼容旧引用：扁平的 { value, label } 列表。 */
export const WHEN_OPTIONS = Object.entries(WAVE_CONDITIONS)
  .map(([value, def]) => ({ value, label: def.label }));

/** 单条规则的 when 是否成立。未知 token 一律放行（见文件顶部关于"宁可多出兵"的说明）。 */
export function whenPasses(rule, ctx) {
  const token = rule && rule.when;
  if (!token) return true;
  const def = WAVE_CONDITIONS[token];
  if (!def) return true;
  return !!def.test(ctx || {}, rule.whenArg);
}

/**
 * 取某阵营实际生效的编排（用户定稿："出兵编排要能只对某一方生效"）。
 *
 * 解析顺序（**整体替换，不是逐条合并**）：
 *   CONFIG.factionOverrides[阵营].laneWaveComposition   ← 存在且非空则用它
 *   CONFIG.gameRules.laneWaveComposition               ← 否则用共享基准
 *
 * 为什么整体替换：编排的**顺序就是语义**。两份逐条合并会得到一个
 * "谁都没要过"的出兵顺序（templateIO 对数组已经是同一口径，保持一致）。
 *
 * 这个函数是解析顺序的【唯一实现】—— 出兵、编辑器预览、批量模拟都走它。
 * 抄第二份就是下一个"预览与实战不一致"。
 */
export function compositionFor(faction, rules = CONFIG.gameRules, laneId = null) {
  // ==================== v43 Q5：编排是【阵营 × 路】的二维网格 ====================
  // 用户："出兵编排应该是每一路+每阵营都可调整，特别注意！每个地图的路数不同，
  //        UI上记得做区分！"
  // 改动前只有"阵营"一维（factionOverrides[阵营].laneWaveComposition），
  // 三路共用一份，做不出"红方上路多压一个炮车"这种事。
  //
  // 解析顺序 = **从最具体到最笼统**，先命中先返回：
  //   ① 该阵营的该路   factionOverrides[阵营].laneWaveCompositionByLane[路]
  //   ② 该阵营的全部路 factionOverrides[阵营].laneWaveComposition        （原有）
  //   ③ 双方共享的该路 gameRules.laneWaveCompositionByLane[路]
  //   ④ 双方共享的基准 gameRules.laneWaveComposition                     （原有）
  // 为什么 ② 排在 ③ 前面：阵营是这套覆写体系里的**外层键**（factionOverrides 的结构
  // 本来就是"先分阵营再分对象"），所以"我给红方单独排过兵"应当压过"我给上路排过兵"。
  // 顺序写死在这一个函数里，出兵、编辑器预览、批量模拟共用它。
  const fo = faction ? CONFIG.factionOverrides?.[faction] : null;
  const pick = (a) => (Array.isArray(a) && a.length) ? a : null;
  return pick(laneId && fo?.laneWaveCompositionByLane?.[laneId])
      || pick(fo?.laneWaveComposition)
      || pick(laneId && rules.laneWaveCompositionByLane?.[laneId])
      || rules.laneWaveComposition || [];
}

/** 该阵营是否有独立编排（编辑器用来显示角标/启用"清除覆写"）。 */
export function hasFactionComposition(faction) {
  const ov = CONFIG.factionOverrides?.[faction]?.laneWaveComposition;
  return Array.isArray(ov) && ov.length > 0;
}

/**
 * (阵营, 路) 这一格是否有自己的编排。faction 传 null/'shared' 表示共享那一行。
 * 编辑器用它给格子打角标、决定"清除本格"按钮是否可用。
 */
export function hasLaneComposition(faction, laneId) {
  if (!laneId) return false;
  const box = (faction && faction !== 'shared')
    ? CONFIG.factionOverrides?.[faction]?.laneWaveCompositionByLane
    : CONFIG.gameRules?.laneWaveCompositionByLane;
  const ov = box?.[laneId];
  return Array.isArray(ov) && ov.length > 0;
}

/**
 * 展开某一波的出兵序列。
 * @param {number} waveNumber 当前波次
 * @param {boolean} nexusDown 该路水晶是否已被摧毁
 * @param {object} [rules] 覆盖用的 gameRules（默认读 CONFIG.gameRules），编辑器预览未应用的改动时会传
 * @param {string|null} [faction] 阵营（'blue'/'red'）。传了就先看该阵营有没有独立编排
 * @param {object|null} [ctx] 条件判定用的世界快照 { gameTime, laneId, census }。不传则依赖建筑/时间的条件一律放行
 * @returns {string[]} 兵种类型按出场先后排列
 */
export function buildWaveOrder(waveNumber, nexusDown, rules = CONFIG.gameRules, faction = null, ctx = null) {
  const EN = rules.spawnEnabled || {};
  const on = (t) => EN[t] !== false;
  // 条件判定的世界快照。调用方不传 ctx 时退化成"只有 nexusDown 这一个已知量"，
  // 与改动前的行为逐位一致（依赖建筑/时间的条件在这种情况下全部放行）。
  const wctx = { nexusDown, faction, enemy: faction === 'blue' ? 'red' : (faction === 'red' ? 'blue' : null), ...(ctx || {}) };
  if (wctx.nexusDown === undefined) wctx.nexusDown = nexusDown;
  const order = [];
  // v43 Q5：编排按 (阵营, 路) 解析。laneId 来自 ctx（LaneWaveSystem 一直在传，
  // 只是以前只用于条件判定的"本路"，没参与选编排）。
  for (const rule of compositionFor(faction, rules, wctx.laneId || null)) {
    if (!rule || !rule.type || !on(rule.type)) continue;
    if (!whenPasses(rule, wctx)) continue;
    const from = rule.fromWave ?? 0, every = Math.max(1, rule.everyN ?? 1);
    if (waveNumber < from) continue;
    if ((waveNumber - from) % every !== 0) continue;
    const n = Math.max(0, Math.floor(rule.count ?? 1));
    for (let k = 0; k < n; k++) order.push(rule.type);
  }
  return order;
}
