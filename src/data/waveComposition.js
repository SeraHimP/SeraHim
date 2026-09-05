import { CONFIG } from './Config.js';
import { EXTREME_WEATHERS } from './Weather.js';

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
// lanes: { 路: {档位:{total,alive}} } }}。拿不到 census 时（单测/未接完整上下文）
// 所有依赖建筑的条件一律**放行**，宁可多出兵也不要静默漏兵 —— 一条规则突然不生效、
// 却没有任何报错，是这类编排最难查的故障。

/**
 * 档位：分路的四档 + 全场的两档。key 与地图 buildings 的 tier 同名。
 * v51.35：base/hq_tower 的显示名统一成"水晶防御塔"/"枢纽防御塔"——与
 * src/core/skills/core.js 的 core_tier_base/core_tier_hq 两条身份技能显示名对齐
 * （原来这里叫"水晶塔"/"枢纽塔"，UIManager.js 又叫"高地塔"，三处各写各的）。
 */
export const STRUCT_TIERS = [
  { key: 'outer',      label: '外塔',       lane: true },
  { key: 'inner',      label: '内塔',       lane: true },
  { key: 'base',       label: '水晶防御塔', lane: true },
  { key: 'nexus_lane', label: '召唤水晶',   lane: true },
  { key: 'hq_tower',   label: '枢纽防御塔', lane: false },
  { key: 'nexus_main', label: '水晶枢纽',   lane: false },
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
  // 2026-09-04：用户反馈"本路水晶已陷落（旧写法）"在多阵营地图下语义不成立——
  // 它读的是 ctx.nexusDown（LaneWaveSystem 按"本路敌方"这个二元关系算出来的
  // 一个布尔值），3+ 阵营时"敌方"本就不是唯一的，这条件天生说不清"是哪个
  // 阵营的水晶陷落了"。新写法直接指定阵营 id，不依赖 ally/enemy 相对关系。
  // 旧的两个 token 保留（老存档/老配置引用它们不能失效），但不再是新建规则的
  // 推荐项——下面 faction.nexus_lane.destroyed 才是。
  'nexusDown':  { label: '本路水晶已陷落（旧写法，建议改用下面"指定阵营召唤水晶被摧毁"）', group: '基础', test: (c) => !!c.nexusDown },
  '!nexusDown': { label: '本路水晶未陷落（旧写法）', group: '基础', test: (c) => !c.nexusDown },
  // gameTime 缺失（单测/旧调用不传 ctx）时【放行】，与建筑条件拿不到 census
  // 时的口径一致。若按 0 秒算，"游戏满 10 分钟才出的兵"会在所有不带 ctx 的调用里
  // 静默消失 —— 一条规则突然不生效却不报错，是这类编排最难查的故障。
  'time.after':  { label: '游戏已进行 ≥ N 秒', group: '时间',
                   arg: { label: '秒', def: 600, min: 0, step: 30 },
                   test: (c, n) => c.gameTime == null || c.gameTime >= (n ?? 0) },
  'time.before': { label: '游戏进行不足 N 秒', group: '时间',
                   arg: { label: '秒', def: 600, min: 0, step: 30 },
                   test: (c, n) => c.gameTime == null || c.gameTime < (n ?? 0) },
  // 2026-09-04：多阵营地图下"本路水晶已陷落（旧写法）"的替代——直接指定一个
  // 阵营 id（不是 ally/enemy 相对概念），判定它的召唤水晶是否被摧毁。
  // arg.type='faction' 是本文件唯一一处非数值参数：UI 要按这个标记把参数框
  // 从数字输入换成"从 map.factions 选一个阵营"的下拉框（见各处 argBox 的渲染，
  // 判据统一是 `cond.arg?.type === 'faction'`，不要在别处另起一套判断）。
  // 拿不到 census、或指定的阵营在这张图上不存在时一律放行（与本文件其它条件
  // 同一套"信息不足就不拦"的既定口径）——包括"还没选阵营"（factionId 为空）
  // 这种半配置状态：不能让规则因为用户还没填完就静默失效。
  'faction.nexus_lane.destroyed': {
    label: '指定阵营召唤水晶被摧毁', group: '阵营（多阵营地图用）',
    arg: { type: 'faction', label: '阵营', def: '' },
    test: (c, factionId) => {
      if (!factionId) return true;
      const census = c.census; if (!census) return true;
      const box = census[factionId]; if (!box) return true;
      const n = box.all?.nexus_lane; if (!n) return true;
      return n.alive === 0 && n.total > 0;
    },
  },
  'faction.nexus_lane.alive': {
    label: '指定阵营召唤水晶仍存活', group: '阵营（多阵营地图用）',
    arg: { type: 'faction', label: '阵营', def: '' },
    test: (c, factionId) => {
      if (!factionId) return true;
      const census = c.census; if (!census) return true;
      const box = census[factionId]; if (!box) return true;
      const n = box.all?.nexus_lane; if (!n) return true;
      return n.alive > 0;
    },
  },
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

// ==================== v51.33：龙魂/天气/昼夜/得分条件（design §5.2） ====================
// ctx 来源见 LaneWaveSystem._extraWaveCtx()：dragonState/weather/dayPhase/score
// 四样都可能是 null（对应依赖没注入，或单测/预览不传）——统一按"拿不到就放行"
// 处理，与本文件其它依赖 census/gameTime 的条件同一套口径（宁可多算不要静默漏判）。
for (const side of SIDES) {
  WAVE_CONDITIONS[`${side.key}.soul.owned`] = {
    label: `${side.label}已成魂`, group: '龙魂',
    test: (c) => { const ds = c.dragonState; if (!ds) return true; return ds.soulOwner === side.of(c); },
  };
  WAVE_CONDITIONS[`${side.key}.dragonKills.atLeast`] = {
    label: `${side.label}龙击杀数 ≥ N`, group: '龙魂',
    arg: { label: '条数', def: 2, min: 1, step: 1 },
    test: (c, n) => {
      const ds = c.dragonState; if (!ds) return true;
      const fac = side.of(c); const kills = fac && ds.factionKills?.[fac];
      if (!kills) return false;
      const total = Object.values(kills).reduce((s, v) => s + v, 0);
      return total >= (n ?? 0);
    },
  };
}
WAVE_CONDITIONS['weather.extreme'] = {
  label: '当前是极端天气', group: '天气/昼夜',
  test: (c) => { if (c.weather === null) return true; return !!c.weather?.id && !!EXTREME_WEATHERS[c.weather.id]; },
};
WAVE_CONDITIONS['daynight.isNight'] = {
  label: '当前是夜晚', group: '天气/昼夜',
  test: (c) => { if (!c.dayPhase) return true; return !!c.dayPhase.isNight; },
};
WAVE_CONDITIONS['daynight.isDay'] = {
  label: '当前是白天', group: '天气/昼夜',
  test: (c) => { if (!c.dayPhase) return true; return !c.dayPhase.isNight; },
};
for (const side of SIDES) {
  WAVE_CONDITIONS[`${side.key}.towers.leadAtLeast`] = {
    label: `${side.label}推塔数领先 ≥ N 座`, group: '战绩',
    arg: { label: '座', def: 3, min: 1, step: 1 },
    test: (c, n) => {
      const sc = c.score; if (!sc) return true;
      const fac = side.of(c), opp = fac === c.faction ? c.enemy : c.faction;
      const mine = sc[fac]?.towers ?? 0, theirs = sc[opp]?.towers ?? 0;
      return (mine - theirs) >= (n ?? 0);
    },
  };
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

/**
 * 2026-09-04：条件组合（AND/OR/NOT，用户拍板"平铺列表+每条可取反，整体AND或
 * 整体OR"）。数据形状：
 *   rule.whenItems: [{ token, arg, negate }, ...]   —— 新写法，多条时用它
 *   rule.when / rule.whenArg                        —— 旧写法（单条件），
 *     没有 whenItems 时当作"只有这一条、negate:false"的兜底
 *   rule.whenOp: 'and' | 'or'                        —— whenItems 有 ≥2 条时
 *     怎么组合，默认 'and'；只有 0~1 条时这个字段不影响结果
 *
 * 只加字段、不改旧字段的语义——旧规则只有 when/whenArg 时，conditionItemsOf
 * 退化成单元素数组，whenPasses 的判定与改动前逐位一致（单条件时 AND/OR 无区别，
 * negate 恒为 false，跟原来"直接返回 test() 结果"完全一样）。
 */
export function conditionItemsOf(rule) {
  if (Array.isArray(rule?.whenItems) && rule.whenItems.length) return rule.whenItems;
  if (rule && rule.when) return [{ token: rule.when, arg: rule.whenArg, negate: false }];
  return [];
}

/** 单条规则的 when 是否成立。未知 token 一律放行（见文件顶部关于"宁可多出兵"的说明）。 */
export function whenPasses(rule, ctx) {
  const items = conditionItemsOf(rule);
  if (!items.length) return true;
  const c = ctx || {};
  const results = items.map(({ token, arg, negate }) => {
    const def = WAVE_CONDITIONS[token];
    const pass = def ? !!def.test(c, arg) : true;
    return negate ? !pass : pass;
  });
  return rule?.whenOp === 'or' ? results.some(Boolean) : results.every(Boolean);
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

/**
 * ==================== v51.33：出兵编排"广播"规则展开 ====================
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §5.1（用户定稿"打通"，不建独立
 * WAVE_ACTIONS 表）。广播规则形状：{ kind:'broadcast', skillId, scope, when,
 * whenArg, fromWave, everyN }——与刷兵规则（{type,count,...}）共存在同一个
 * compositionFor() 数组里，靠 kind 字段区分。buildWaveOrder() 的主循环已经用
 * `!rule.type` 天然跳过了这类规则（不会把广播规则误当刷兵规则展开），这里补一个
 * 镜像函数专门收集广播规则——两者共用同一份 compositionFor()/whenPasses()，
 * "这一波该生效哪些规则"的判定逻辑只有一份，不会出现"预览一套、真实执行一套"。
 *
 * 不返回"广播了几次"（count 对广播没有意义，技能被广播给一批单位，不是叠加触发
 * 好几遍），每条命中的规则在这一波恰好出现一次。
 *
 * @returns {{skillId:string, scope:'faction'|'lane'}[]}
 */
export function buildBroadcastOrder(waveNumber, nexusDown, rules = CONFIG.gameRules, faction = null, ctx = null) {
  const wctx = { nexusDown, faction, enemy: faction === 'blue' ? 'red' : (faction === 'red' ? 'blue' : null), ...(ctx || {}) };
  if (wctx.nexusDown === undefined) wctx.nexusDown = nexusDown;
  const out = [];
  for (const rule of compositionFor(faction, rules, wctx.laneId || null)) {
    if (!rule || rule.kind !== 'broadcast' || !rule.skillId) continue;
    if (!whenPasses(rule, wctx)) continue;
    const from = rule.fromWave ?? 0, every = Math.max(1, rule.everyN ?? 1);
    if (waveNumber < from) continue;
    if ((waveNumber - from) % every !== 0) continue;
    out.push({ skillId: rule.skillId, scope: rule.scope === 'lane' ? 'lane' : 'faction' });
  }
  return out;
}
