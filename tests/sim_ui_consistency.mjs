// Q1 UI 审查后定下的一致性规则 + 本轮修掉的界面 bug。
// 用户："唯一的铁律，要保证UI设计的一致性……模板编辑器中批量添加技能窗口右面竟然有三个翻页的那个条，
//        诸如此类弱智的问题就不要再出现了。"
import fs from 'fs';
import path from 'path';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { T, done } = scoreboard('UI 一致性');
const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ① 一个窗口只有一个滚动区：内容里的列表/矩阵/网格不许自带 max-height + overflow 滚动
// 允许的滚动容器：弹窗本体、左侧导航、右侧内容区、主界面的单位面板/卡片列表/日志（它们是窗口级区域）
const html = read('index.html');
const allowedCss = ['.modal-box', '.tpl-nav', '.tpl-pane', '#towerCards', '#logArea', '#selectionPanel'];
const cssScrollers = [];
for (const m of html.matchAll(/([^{}\n]+)\{([^}]*overflow(?:-y)?:\s*(?:auto|scroll)[^}]*)\}/g)) {
  const sel = m[1].trim();
  if (!allowedCss.some((a) => sel.includes(a))) cssScrollers.push(sel);
}
T(`①CSS 里的滚动容器只有窗口级区域（多出来的：${cssScrollers.join(' / ') || '无'}）`, cssScrollers.length === 0);
const uiFiles = fs.readdirSync(path.join(ROOT, 'src/ui')).filter((f) => f.endsWith('.js')).map((f) => 'src/ui/' + f)
  .concat(fs.readdirSync(path.join(ROOT, 'src/ui/editor')).filter((f) => f.endsWith('.js')).map((f) => 'src/ui/editor/' + f));
const inline = [];
for (const f of uiFiles) {
  const src = read(f);
  for (const m of src.matchAll(/style="[^"]*max-height:\s*\d+px;[^"]*overflow(?:-y)?:\s*(?:auto|scroll)[^"]*"/g)) inline.push(f);
}
T(`②界面代码里没有内联的"固定高度 + 自带滚动条"小框（${[...new Set(inline)].join(', ') || '无'}）`, inline.length === 0);
T('③批量加技能页的矩阵与技能池不再各自滚动', !/\.gp-matrix-wrap\s*\{[^}]*overflow/.test(html) && !/\.gp-pool\s*\{[^}]*overflow/.test(html));

// ④ Esc 关闭最上层弹窗（走弹窗自己的取消/关闭按钮）
const esc = read('src/ui/escClose.js'), main = read('src/main.js');
T('④Esc 关闭弹窗：main.js 安装了统一的 Esc 处理', /installEscClose\(\)/.test(main) && /'Escape'/.test(esc) && /#dlgCancelBtn/.test(esc));

// ⑤ 面包屑/应用按钮在没有对象名时不留多余的"·"
const shell = read('src/ui/editor/shell.js');
T('⑤面包屑与"应用 →"按钮按非空段拼接', /\.filter\(Boolean\)\.join\(' · '\)/.test(shell) && /\.filter\(Boolean\)\.join\('·'\)/.test(shell));

// ⑥ 模板页不显示"当前生命"
T('⑥模板编辑不显示"当前生命"（模板里没有这个状态）', /isTemplate \? \['maxHP', 'healthRegen', 'baseHealthRegenMod'\]/.test(read('src/ui/editor/pagesEntity.js')));

// ⑦ 技能数值页：每个参数键都有中文名
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { PARAM_LABELS } = await import('../src/data/paramLabels.js');
  const keys = new Set();
  for (const d of Object.values(SkillLibrary)) for (const k of Object.keys(d.defaultParams || {})) keys.add(k);
  const miss = [...keys].filter((k) => !PARAM_LABELS[k]);
  T(`⑦技能参数键都有中文名（缺：${miss.join(',') || '无'}）`, miss.length === 0);
}
// ⑧ 界面不解释机制（docs/ui-standard.md 第四节铁律）：本轮删掉的几句不许回来
const all = uiFiles.map(read).join('\n');
T('⑧本轮删掉的机制说明文案没有回来', !/跑得慢一点|关掉的兵种下面怎么排都不会出|一改就会复制成本格专属|技能参数的叠加顺序/.test(all));
done();
