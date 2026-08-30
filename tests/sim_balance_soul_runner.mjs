// tools/run_balance_soul.mjs 验收——本地一键跑龙魂平衡扫描的并行封装。
//
// 这个脚本本身不算游戏逻辑，但它是"我这边算力/环境不行时，把重活交给用户本地
// 机器跑"这条路径的唯一入口，跑错了、拆漏了档、结果对不上号，比没有这个工具
// 更糟——所以照样按 CLAUDE.md 的规矩配一套断言，不是"纯运维脚本可以不测"。
//
// 两条硬性要求：
//   ① SOULS 列表不能和 balance_matrix.mjs 里 --sweep soul 分支的清单出现漂移——
//      这是最容易被忽略的坏法：以后 balance_matrix.mjs 加了新龙魂，这边的
//      SOULS 数组没跟着改，用户本地跑出来的"完整扫描"其实漏了一档，还不会报错。
//   ② 真跑一遍（用最小的 --runs/--minutes 保持够快），确认多进程拆分+合并这条
//      管线本身是好的：14 档一个不漏、日志/JSON 都落了盘、退出码正常。
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSrc = fs.readFileSync(path.join(root, 'tools', 'run_balance_soul.mjs'), 'utf8');
const matrixSrc = fs.readFileSync(path.join(root, 'tools', 'balance_matrix.mjs'), 'utf8');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ---- ① SOULS 清单不漂移：从两份源码里各自抠出数组字面量，逐项比对 ----
const extractSouls = (src, label) => {
  const m = src.match(/const SOULS = \[([\s\S]*?)\];/);
  if (!m) { T(`能在 ${label} 里定位到 SOULS 数组`, false); return null; }
  return m[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1));
};
const runnerSouls = extractSouls(runnerSrc, 'run_balance_soul.mjs');
const matrixSouls = extractSouls(matrixSrc, 'balance_matrix.mjs（--sweep soul 分支）');
T('两份 SOULS 清单都能定位到', !!runnerSouls && !!matrixSouls);
if (runnerSouls && matrixSouls) {
  T(`run_balance_soul.mjs 的 SOULS 与 balance_matrix.mjs 逐项一致（${runnerSouls.length} 项），没有漂移`,
    runnerSouls.length === matrixSouls.length && runnerSouls.every((k, i) => k === matrixSouls[i]));
}

// ---- ② 真跑一遍：用最小规模（--runs 1 --minutes 1 --jobs 2）确认管线本身是好的 ----
const tmpDir = path.join(root, '.balance');
fs.rmSync(tmpDir, { recursive: true, force: true });   // 跑之前清一次，避免读到上次留下的文件误判
const runner = path.join(root, 'tools', 'run_balance_soul.mjs');
const r = spawnSync('node', [runner, '--runs', '1', '--minutes', '1', '--jobs', '2'],
  { encoding: 'utf8', cwd: root, timeout: 90_000 });
T('run_balance_soul.mjs 正常退出（0）', r.status === 0);
if (r.status !== 0) console.log((r.stdout || '').slice(-1500), (r.stderr || '').slice(-1500));

const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
const logFile = files.find(f => f.endsWith('.log'));
const jsonFile = files.find(f => f.endsWith('.json'));
T('.balance/ 下落了一份 .log 和一份 .json（不是只有中间产物）', !!logFile && !!jsonFile);
// 各进程自己的临时 JSON（soul_sweep_*_job0.json 这类）应该在合并后被清掉，
// 不能留一堆散落的中间文件——那样"发给 Claude 哪个文件"会变得模棱两可。
T('各进程的临时 JSON 已经在合并后清理掉，只留一份合并结果', !files.some(f => /_job\d+\.json$/.test(f)));

if (jsonFile) {
  const data = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFile), 'utf8'));
  T('合并后的 JSON 恰好含 14 档结果（基线 + 13 种龙魂，一个不漏）', data.results.length === 14);
  const labels = new Set(data.results.map(r => r.label));
  T('合并结果里包含基线档', [...labels].some(l => l.includes('基线')));
  T('合并结果里 13 种龙魂各自都在（按 SOULS 清单逐个核对）',
    !!runnerSouls && runnerSouls.every(k => [...labels].some(l => l.includes(k))));
}

fs.rmSync(tmpDir, { recursive: true, force: true });   // 测试产物不留痕迹

console.log(`龙魂平衡本地跑批验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
