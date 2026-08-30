#!/usr/bin/env node
/**
 * run_balance_soul.mjs —— 本地一键跑"龙魂平衡"全量扫描（多进程并行加速）
 *
 * ==================== 为什么要有这个 ====================
 * balance_matrix.mjs --sweep soul 是单进程串行跑 14 档（基线 + 13 种龙魂）×
 * --runs 局，在弱一点的机器/共享容器上跑 --runs 20 --minutes 40 可能要好几个
 * 小时——这正是这次评估在沙盒容器里被空闲回收、始终跑不完的根子（不是数值/
 * 参数不对，是环境撑不住这么长的连续跑）。
 *
 * balance_matrix.mjs 本身早就留了 --pick 参数（"拆成几个进程各跑几档，墙钟
 * 时间按核数除下去"，见该文件 v48 的头注），只是需要手动拆分、手动起多个
 * 进程、手动合并结果——这个脚本就是把这几步自动化：按本机 CPU 核数把 14 档
 * 拆成 N 份，每份起一个子进程并行跑，跑完合并成一份结果，控制台完整回显、
 * 同时落盘一份 .log/.json，方便直接复制或把文件发回去。
 *
 * ==================== 用法 ====================
 *   node tools/run_balance_soul.mjs                     # 完整规模：--runs 20 --minutes 40
 *   node tools/run_balance_soul.mjs --runs 8 --minutes 30
 *   node tools/run_balance_soul.mjs --quick              # 快速摸底：--runs 5 --minutes 25
 *   node tools/run_balance_soul.mjs --jobs 4             # 手动指定并行进程数（默认按 CPU 核数，封顶 14）
 *   node tools/run_balance_soul.mjs --pick fire,water,magma   # 只重跑这几档（调完数值针对性验证用，
 *                                                              # "基线"/baseline 也可以写进去）
 *
 * 跑完之后：把控制台打印的表格，或者 .balance/ 目录下最新那份 .log 文件
 * 直接发给 Claude 就行，不需要额外处理。
 *
 * ==================== v51.7：补上 --pick 透传 + 汇总进度/ETA ====================
 * 两条都是用户此前提的、当时明确要求"留到龙魂平衡那里做"——现在就是这个工作：
 *   · --pick：调完某几条魂的数值后，不用再重跑全部 14 档，只点名要重跑的那几条。
 *   · 汇总进度：之前是把每个子进程的 stderr 原样透传到终端，多路 \r 糊在一起花屏
 *     （用户反馈的"突然一下变成10了"）。现在父进程自己接管每个子进程的 stderr，
 *     解析出"第几局"后在本进程里累加成一条总进度行，不再有多路互相覆盖的问题；
 *     用已耗时 / 已完成局数反推剩余时间，同样每隔几秒刷新一次。
 *
 * 判读标准（写死在 balance_matrix.mjs 的 --sweep soul 分支注释里，这里抄一遍
 * 方便对着看）：
 *   · 基线档（双方无魂）的"推进度差"应当接近 0——对称局面。
 *   · 每条龙魂的目标是让蓝方【略微】占优，胜率落在 60~70% 区间。
 *     超过 70% 说明这条魂太强，该削；低于 55% 说明太弱，该加。
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const QUICK = argv.includes('--quick');
const RUNS = flag('runs', QUICK ? '5' : '20');
const MINUTES = flag('minutes', QUICK ? '25' : '40');

// 与 balance_matrix.mjs --sweep soul 分支里的 SOULS 列表保持一致（见该文件
// v51.6 的补齐记录）。这里不 import 那份代码去读常量——那个文件顶部就执行
// 了一堆 window/CONFIG 初始化副作用，不适合当纯数据模块 import；13 个龙魂
// key 抄一份维护成本很低，比硬拉一个有副作用的模块进来更干净。
const SOULS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison',
  'frost', 'steel', 'blood', 'magma', 'astral', 'rift'];
const ALL_TIERS = ['基线', ...SOULS];   // "基线"能匹配到"基线·双方无魂"（--pick 是子串匹配）

// --pick fire,water,magma：只跑点名的那几档，支持中文"基线"或英文别名 baseline/all。
// 大小写不敏感、允许有空格；写错的名字直接报错退出，不悄悄跑成全量（免得白等一轮）。
const pickArg = flag('pick', null);
let TIERS = ALL_TIERS;
if (pickArg) {
  const wanted = pickArg.split(',').map(s => s.trim()).filter(Boolean);
  const norm = (s) => (s === 'baseline' || s === '基线') ? '基线' : s;
  TIERS = wanted.map(norm);
  const bad = TIERS.filter(t => !ALL_TIERS.includes(t));
  if (bad.length) {
    console.error(`✗ --pick 里有不认识的档位：${bad.join('、')}`);
    console.error(`  可选：${ALL_TIERS.join('、')}（或 baseline 代替"基线"）`);
    process.exit(1);
  }
}

const cpuCount = cpus().length || 4;
const JOBS = Math.max(1, Math.min(TIERS.length, parseInt(flag('jobs', String(Math.min(cpuCount, TIERS.length))), 10) || cpuCount));

// 轮转分配（round-robin），保证"基线"落在第 0 组——不是必须但让第一组最先
// 出基线结果，便于跑到一半时就能看基线是否对称。
const buckets = Array.from({ length: JOBS }, () => []);
TIERS.forEach((t, i) => buckets[i % JOBS].push(t));

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.balance');
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, `soul_sweep_${ts}.log`);
const jsonPath = path.join(outDir, `soul_sweep_${ts}.json`);

const logLines = [];
const log = (s = '') => { console.log(s); logLines.push(s); };

log(pickArg
  ? `龙魂平衡扫描（--pick 指定档位）：${TIERS.join('、')}，每档 ${RUNS} 局，单局上限 ${MINUTES} 分钟`
  : `龙魂平衡扫描：${TIERS.length} 档（基线 + ${SOULS.length} 种龙魂），每档 ${RUNS} 局，单局上限 ${MINUTES} 分钟`);
log(`拆成 ${JOBS} 个并行进程（本机 ${cpuCount} 核）：`);
buckets.forEach((b, i) => log(`  进程${i + 1}：${b.join('、')}`));
log('');

// ==================== 汇总进度 + ETA ====================
// 总局数 = 档位数 × 每档局数；每个子进程按自己 bucket 里的档位顺序跑，进度行格式固定是
// `\r  ${label} … ${i+1}/${RUNS}`（balance_matrix.mjs 写死的）。这里不去猜 label 对应
// 哪一档，只要看到"当前局数比上次小"就当作换到了下一档（tiersDone++），换算出这个
// 子进程已经跑完的局数，再把所有子进程加起来就是总进度——不依赖具体档位顺序，
// 子进程内部换档、乱序都不影响这个累加逻辑。
const totalGames = TIERS.length * Number(RUNS);
const jobProgress = Array.from({ length: JOBS }, () => ({ tiersDone: 0, curInTier: 0 }));
function totalCompleted() {
  return jobProgress.reduce((s, j) => s + j.tiersDone * Number(RUNS) + j.curInTier, 0);
}
function onProgressChunk(idx, chunk) {
  // 一次 data 事件可能攒了好几次 \r 覆写，只有最后一段是当前真实进度。
  const seg = chunk.split('\r').filter(Boolean).pop();
  if (!seg) return;
  const m = seg.match(/(\d+)\/(\d+)/);
  if (!m) return;
  const cur = parseInt(m[1], 10);
  const j = jobProgress[idx];
  if (cur < j.curInTier) j.tiersDone += 1;   // 数字变小 = 换到了下一档，重新从 1 数
  j.curInTier = cur;
}
let tickerStarted = 0;
const ticker = setInterval(() => {
  const done = totalCompleted();
  const elapsed = (Date.now() - tickerStarted) / 1000;
  const rate = done > 0 ? elapsed / done : 0;   // 秒/局
  const remain = done > 0 ? Math.max(0, (totalGames - done) * rate) : NaN;
  const etaStr = Number.isFinite(remain)
    ? (remain > 90 ? `约 ${(remain / 60).toFixed(1)} 分钟` : `约 ${Math.round(remain)} 秒`)
    : '估算中…';
  process.stdout.write(`\r总进度：${done}/${totalGames} 局，已耗时 ${(elapsed / 60).toFixed(1)} 分钟，预计剩余 ${etaStr}   `);
}, 3000);

// balance_matrix.mjs 把逐档"…N/M"进度写去 stderr（靠 \r 原地刷新，活体终端上
// 好看），真正的每档结果表格行是 console.log 写去 stdout 的——之前把两路合并
// 进同一个字符串缓冲区，进度的 \r 和结果行前后夹在一起，日志里全糊成一团。
// 现在分开处理：stdout 单独攒起来落日志；stderr 不再直接 inherit（多个子进程的
// \r 糊在同一个终端上正是用户报的花屏根子），改成父进程自己接住、喂给上面的
// onProgressChunk() 去算总进度，原始的逐子进程 \r 不再直接打印。
function runJob(idx, pickList) {
  return new Promise((resolve) => {
    const jsonOut = path.join(outDir, `soul_sweep_${ts}_job${idx}.json`);
    const args = ['tools/balance_matrix.mjs', '--sweep', 'soul',
      '--runs', String(RUNS), '--minutes', String(MINUTES),
      '--pick', pickList.join(','), '--json', jsonOut];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => onProgressChunk(idx, d.toString()));
    child.on('close', (code) => resolve({ idx, code, buf, jsonOut }));
  });
}

const started = Date.now();
tickerStarted = started;
const jobResults = await Promise.all(buckets.map((b, i) => runJob(i, b)));
clearInterval(ticker);
const elapsedSecNum = (Date.now() - started) / 1000;
const elapsedSec = elapsedSecNum.toFixed(1);
process.stdout.write(`\r总进度：${totalGames}/${totalGames} 局，全部完成，用时 ${(elapsedSecNum / 60).toFixed(1)} 分钟` + ' '.repeat(20) + '\n');

log(`==================== 全部 ${JOBS} 个进程跑完，用时 ${elapsedSec}s（并行墙钟时间，不是累加）====================\n`);

let mergedResults = [];
for (const r of jobResults.sort((a, b) => a.idx - b.idx)) {
  log(`---- 进程${r.idx + 1}（退出码 ${r.code}） ----`);
  log(r.buf.trim());
  log('');
  if (r.code !== 0) {
    log(`⚠️ 进程${r.idx + 1}异常退出，它负责的档位（${buckets[r.idx].join('、')}）结果可能不完整或缺失。`);
    continue;
  }
  try {
    const data = JSON.parse(fs.readFileSync(r.jsonOut, 'utf8'));
    mergedResults.push(...data.results);
    fs.unlinkSync(r.jsonOut);   // 已经并进 mergedResults，单份的临时文件不留
  } catch (e) {
    log(`⚠️ 读取进程${r.idx + 1}的 JSON 输出失败：${e.message}`);
  }
}

fs.writeFileSync(jsonPath, JSON.stringify({ runs: Number(RUNS), maxMin: Number(MINUTES), sweep: 'soul', results: mergedResults }, null, 2));
fs.writeFileSync(logPath, logLines.join('\n') + '\n');

log(`==================== 完成 ====================`);
log(`合并后的完整结果：`);
log(`  日志：${logPath}`);
log(`  JSON：${jsonPath}`);
log(`把上面这份日志（或者这两个文件）发给 Claude 就行。`);
