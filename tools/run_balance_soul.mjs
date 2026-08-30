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
 *
 * 跑完之后：把控制台打印的表格，或者 .balance/ 目录下最新那份 .log 文件
 * 直接发给 Claude 就行，不需要额外处理。
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
const TIERS = ['基线', ...SOULS];   // "基线"能匹配到"基线·双方无魂"（--pick 是子串匹配）

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

log(`龙魂平衡扫描：${TIERS.length} 档（基线 + ${SOULS.length} 种龙魂），每档 ${RUNS} 局，单局上限 ${MINUTES} 分钟`);
log(`拆成 ${JOBS} 个并行进程（本机 ${cpuCount} 核）：`);
buckets.forEach((b, i) => log(`  进程${i + 1}：${b.join('、')}`));
log('');

// balance_matrix.mjs 把逐档"…N/M"进度写去 stderr（靠 \r 原地刷新，活体终端上
// 好看），真正的每档结果表格行是 console.log 写去 stdout 的——之前把两路合并
// 进同一个字符串缓冲区，进度的 \r 和结果行前后夹在一起，日志里全糊成一团。
// 现在分开处理：stderr 直接 inherit 到父进程的终端（你能实时看到进度，安心
// 知道它没卡死），只把 stdout 单独攒起来落日志——两路不再混在一起，天然干净，
// 不需要再去猜怎么模拟"回车覆盖"。
function runJob(idx, pickList) {
  return new Promise((resolve) => {
    const jsonOut = path.join(outDir, `soul_sweep_${ts}_job${idx}.json`);
    const args = ['tools/balance_matrix.mjs', '--sweep', 'soul',
      '--runs', String(RUNS), '--minutes', String(MINUTES),
      '--pick', pickList.join(','), '--json', jsonOut];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('close', (code) => resolve({ idx, code, buf, jsonOut }));
  });
}

const started = Date.now();
const jobResults = await Promise.all(buckets.map((b, i) => runJob(i, b)));
const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

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
