// P2 模板编辑器重构验收：配置导出/导入 + 「生成规则/出兵顺序」的冲突已消除。
//
// 用户原话：「目前的生成顺序和生成规则就是冲突或者是重合的」。
// 这里用源码断言把结论钉死，防止以后又长回去。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CONFIG } = await import('../src/data/Config.js');
const { exportTemplates, importTemplates, deepMerge, IO_GROUPS, IO_VERSION }
  = await import('../src/data/templateIO.js');
const { buildWaveOrder } = await import('../src/data/waveComposition.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ---- ① 导出→导入 往返必须逐位一致 ----
// 这是整个功能的根：往返不一致就意味着"存了盘再读回来，数值悄悄变了"，
// 而这种漂移在界面上完全看不出来。
const snap = exportTemplates(CONFIG);
T(`导出覆盖全部白名单分组（${IO_GROUPS.filter(g => snap[g] !== undefined).length}/${IO_GROUPS.length}）`,
  IO_GROUPS.every(g => CONFIG[g] === undefined || snap[g] !== undefined));
T('导出带版本标记', snap._seraHimTemplates === IO_VERSION);

const before = JSON.stringify(exportTemplates(CONFIG));
const r1 = importTemplates(CONFIG, JSON.parse(JSON.stringify(snap)));
T('导入自身的导出结果成功', r1.ok && r1.skipped.length === 0);
const after = JSON.stringify(exportTemplates(CONFIG));
// _exportedAt 每次都不同，比对时剔除
const strip = (s) => s.replace(/"_exportedAt":\s*"[^"]*",?/, '');
T('导出→导入→导出 往返逐位一致', strip(before) === strip(after));

// ---- ② 导入是深合并：文件没写的字段必须保持现值 ----
// 整体替换的话，旧存档一导入就会把后来新增的配置字段抹成 undefined，
// 而缺字段多半不报错、只是行为静默变样，是最难查的一类回归。
const keepBefore = CONFIG.templates.melee.attackRange;
const r2 = importTemplates(CONFIG, { _seraHimTemplates: 1, templates: { melee: { maxHP: 12345 } } });
T('部分导入成功', r2.ok);
T('导入写入了指定字段', CONFIG.templates.melee.maxHP === 12345);
T('导入未触及文件里没写的同级字段（深合并）', CONFIG.templates.melee.attackRange === keepBefore);
T('导入未触及文件里没写的其它兵种', CONFIG.templates.ranged.maxHP !== 12345);

// ---- ③ 数组整体替换：出兵编排的顺序就是语义 ----
// 逐项合并会得到一个"两份编排掺在一起"的顺序，谁都没要过这个结果。
importTemplates(CONFIG, { _seraHimTemplates: 1,
  gameRules: { laneWaveComposition: [{ type: 'ranged', count: 9 }] } });
T('数组整体替换而非逐项合并',
  CONFIG.gameRules.laneWaveComposition.length === 1
  && CONFIG.gameRules.laneWaveComposition[0].type === 'ranged');

// ---- ④ 白名单外的键必须被拒 ----
const r3 = importTemplates(CONFIG, { _seraHimTemplates: 1, __proto__x: 1, evilKey: { a: 1 } });
T('未知键被忽略且如实报告', r3.ok && r3.skipped.includes('evilKey'));
T('未知键没有挂到 CONFIG 上', CONFIG.evilKey === undefined);
T('缺版本标记的文件被拒', importTemplates(CONFIG, { templates: {} }).ok === false);
T('版本过高的文件被拒', importTemplates(CONFIG, { _seraHimTemplates: 999 }).ok === false);
T('非对象输入被拒', importTemplates(CONFIG, 'nope').ok === false);

// ---- ⑤ deepMerge 自身 ----
T('deepMerge 递归合并嵌套对象',
  JSON.stringify(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })) === '{"a":{"b":1,"c":3}}');

// ---- ⑥ 编辑器重构：冲突/重合已消除 ----
const src = fs.readFileSync(path.join(root, 'src', 'ui', 'AttributeEditor.js'), 'utf8');
T('已删除「生成规则」tab（它把出兵节奏/开关/成长/屠戮混在一起）',
  !/data-tpltab="spawnrule"/.test(src));
T('出兵相关只剩唯一入口「出兵编排」', !/data-tpltab="waveorder"/.test(src)
  && /data-tpltab="spawn"/.test(src));
T('成长/屠戮拆成独立 tab（它们是战斗数值，与出兵无关）',
  /data-tpltab="growth"/.test(src) && /_applyGrowthChanges/.test(src));
T('出兵编排页明确标注了哪段管沙盒、哪段管对战',
  /只影响沙盒模式/.test(src) && /只管<b>对战模式/.test(src));

// battleTotemFromWave / battleTotemInterval 是死配置：全仓库无人读取，
// 而默认编排里 { totem, fromWave:10, everyN:3 } 是同一条规则的第二份表述。
const srcDirs = ['src/systems', 'src/core', 'src/data', 'src/presentation'];
let readers = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { walk(p); continue; }
    if (!f.name.endsWith('.js')) continue;
    const t = fs.readFileSync(p, 'utf8');
    // 只算"真读取"（gameRules.xxx / gr.xxx），Config 里的定义和注释不算
    if (/(?:gameRules|gr|rules)\s*[.[]\s*['"]?battleTotem/.test(t)) readers++;
  }
};
srcDirs.forEach(d => walk(path.join(root, d)));
T(`battleTotem* 确认无人读取（${readers} 处读取）`, readers === 0);
T('已从面板移除该死配置输入框',
  !/data-key="\$\{meta\.battleFromKey\}"/.test(src) && !/data-key="\$\{meta\.battleIntvKey\}"/.test(src));

// ---- ⑦ 兵种总开关仍然对出兵生效（重构不能改变行为）----
CONFIG.gameRules.laneWaveComposition = [{ type: 'melee', count: 3 }, { type: 'ranged', count: 2 }];
CONFIG.gameRules.spawnEnabled = {};
T('开关全开时按编排出兵', buildWaveOrder(1, false, CONFIG.gameRules).length === 5);
CONFIG.gameRules.spawnEnabled = { ranged: false };
T('关掉的兵种确实不出', buildWaveOrder(1, false, CONFIG.gameRules).every(t => t !== 'ranged'));

// ---- ⑧ 取值来源可视化：叠加链必须摊得开 ----
// 塔的数值穿过 模板 → 地图 tierStats → 共享覆写 → 阵营覆写 四层。
// 面板只显示最终值时，"我改了怎么没变"（被更靠后的层压住）根本没法自查。
const { towerTierSource } = await import('../src/data/schema/index.js');
CONFIG.towerTierOverrides = CONFIG.towerTierOverrides || {};
CONFIG.factionOverrides = CONFIG.factionOverrides || { blue: {}, red: {} };
delete CONFIG.towerTierOverrides.outer;
delete CONFIG.factionOverrides.blue?.tower_outer;

const s0 = towerTierSource('outer', 'maxHP', 'shared');
T(`无覆写时来源=模板（${s0.source} ${s0.value}）`, s0.source === '模板' && s0.chain.length === 1);

CONFIG.towerTierOverrides.outer = { maxHP: 4444 };
const s1 = towerTierSource('outer', 'maxHP', 'shared');
T('加共享覆写后生效层变为共享覆写', s1.source === '共享覆写' && s1.value === 4444);
T('叠加链保留被压住的层（可解释）', s1.chain.length === 2 && s1.chain[0].layer === '模板');
T('只有最后一层标记为 winner',
  s1.chain.filter(c => c.winner).length === 1 && s1.chain[s1.chain.length - 1].winner);

CONFIG.factionOverrides.blue = CONFIG.factionOverrides.blue || {};
CONFIG.factionOverrides.blue.tower_outer = { maxHP: 5555 };
const s2 = towerTierSource('outer', 'maxHP', 'blue');
T('阵营覆写压过共享覆写', s2.source === '蓝方覆写' && s2.value === 5555 && s2.chain.length === 3);
T('另一阵营不受影响', towerTierSource('outer', 'maxHP', 'red').value === 4444);
T('未定义字段如实报告', towerTierSource('outer', '__nope__', 'shared').source === '未定义');
delete CONFIG.towerTierOverrides.outer;
delete CONFIG.factionOverrides.blue.tower_outer;

// ---- ⑨ 属性 tab 的塔数值解析：首屏与切回来必须是同一套 ----
// 原代码首屏用 _tierEffective(tier)、从别的 tab 点回"属性"却用 _scopedTpl('tower')，
// 同一个面板前后给出两个答案。这里钉住两条路径读的是同一个解析函数。
T('属性 tab 切回时按层级解析（不再退化成通用模板）',
  /const isTowerTab = this\._categoryOfType\(type\) === 'tower'/.test(src)
  && /this\._tierEffective\(this\._tplState\.tier\)/.test(src));
T('取值来源角标已接入属性面板', /_srcBadge\(srcCtx, key\)/.test(src));

// ---- ⑩ 存档结构稳定性 + 本地文件保存 ----
// 存档格式不该随"用户这次有没有改过技能"而时有时无，否则 diff 两个存档时
// 满屏是结构差异而不是数值差异，前后对比就没法做了。
const { ensureGroups, suggestedFileName, IO_ENSURE } = await import('../src/data/templateIO.js');
for (const g of IO_ENSURE) delete CONFIG[g];
const snap2 = exportTemplates(CONFIG);
T(`按需分组始终出现在存档里（${IO_ENSURE.join('、')}）`,
  IO_ENSURE.every(g => snap2[g] !== undefined));
T('ensureGroups 幂等', (() => {
  CONFIG.skillOverrides.weapon_piercing = { dmg: 1 };
  ensureGroups(CONFIG);
  return CONFIG.skillOverrides.weapon_piercing.dmg === 1;
})());
T('技能/状态/地图覆写可往返', (() => {
  CONFIG.skillOverrides = { weapon_lightning: { chainRange: 123 } };
  CONFIG.effectOverrides = { slow: { pct: 45 } };
  CONFIG.mapOverrides = { summoners_rift_v1: { riverHalfWidth: 77 } };
  const s = exportTemplates(CONFIG);
  CONFIG.skillOverrides = {}; CONFIG.effectOverrides = {}; CONFIG.mapOverrides = {};
  importTemplates(CONFIG, s);
  return CONFIG.skillOverrides.weapon_lightning.chainRange === 123
    && CONFIG.effectOverrides.slow.pct === 45
    && CONFIG.mapOverrides.summoners_rift_v1.riverHalfWidth === 77;
})());
T('文件名带日期、以 .json 结尾', /^serahim-config-\d{4}-\d{2}-\d{2}\.json$/.test(suggestedFileName()));

// 本地文件保存：句柄要被记住，否则每点一次保存都往下载目录扔一个新文件。
T('保存/打开会复用同一个文件句柄（改一点存一次不会堆出一堆文件）',
  /_fileHandle/.test(src) && /this\._fileHandle = h;/.test(src));
T('用户点取消不被当成失败（AbortError 静默返回）', /AbortError/.test(src));
T('无 File System Access API 时降级为下载 / <input type=file>',
  /_downloadFallback/.test(src) && /inp\.type = 'file'/.test(src));

console.log(`模板 IO / 编辑器重构验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
