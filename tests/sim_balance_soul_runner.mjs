// tools/run_balance_soul.mjs 验收——本地一键跑龙魂/巨龙之力平衡扫描的并行封装。
//
// 这个脚本本身不算游戏逻辑，但它是"我这边算力/环境不行时，把重活交给用户本地
// 机器跑"这条路径的唯一入口，跑错了、拆漏了档、结果对不上号，比没有这个工具
// 更糟——所以照样按 CLAUDE.md 的规矩配一套断言，不是"纯运维脚本可以不测"。
//
// 2026-09-04：这个脚本原来硬编码只认 --sweep soul（14 档：基线 + 13 种龙魂）。
// 用户想测"巨龙之力"时，我一开始让他直接单进程跑 balance_matrix.mjs——没利用
// 这个脚本已经写好的并行封装，8 档 × 20 局单进程串行在他 16 核机器上干等了两个
// 多小时。现在补上 --sweep power（8 档：基线 + 7 种元素之力），下面新增③④两组
// 断言专门盯这条新路径，①②两组盯的默认 soul 路径逐位不动。
//
// 四条硬性要求：
//   ① SOULS 列表不能和 balance_matrix.mjs 里 --sweep soul 分支的清单出现漂移——
//      这是最容易被忽略的坏法：以后 balance_matrix.mjs 加了新龙魂，这边的
//      SOULS 数组没跟着改，用户本地跑出来的"完整扫描"其实漏了一档，还不会报错。
//   ② 真跑一遍（用最小的 --runs/--minutes 保持够快），确认多进程拆分+合并这条
//      管线本身是好的：14 档一个不漏、日志/JSON 都落了盘、退出码正常。
//   ③ POWERS 列表同样不能和 balance_matrix.mjs 里 --sweep power 分支的 ELS
//      清单出现漂移（与①同一个坏法，换了一份清单）。
//   ④ --sweep power 真跑一遍：8 档一个不漏、--sweep 字段正确写进合并 JSON。
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

// ---- ③ POWERS 清单不漂移：与①同一个坏法，换成 balance_matrix.mjs --sweep power 分支的 ELS ----
const extractArray = (src, varName, label) => {
  const re = new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\];`);
  const m = src.match(re);
  if (!m) { T(`能在 ${label} 里定位到 ${varName} 数组`, false); return null; }
  return m[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1));
};
const runnerPowers = extractArray(runnerSrc, 'POWERS', 'run_balance_soul.mjs');
const matrixEls = extractArray(matrixSrc, 'ELS', 'balance_matrix.mjs（--sweep power 分支）');
T('两份清单（POWERS / ELS）都能定位到', !!runnerPowers && !!matrixEls);
if (runnerPowers && matrixEls) {
  T(`run_balance_soul.mjs 的 POWERS 与 balance_matrix.mjs 的 ELS 逐项一致（${runnerPowers.length} 项），没有漂移`,
    runnerPowers.length === matrixEls.length && runnerPowers.every((k, i) => k === matrixEls[i]));
}

// ---- ④ --sweep power 真跑一遍：8 档（基线 + 7 种元素之力）一个不漏，--sweep 字段正确 ----
{
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const rp = spawnSync('node', [runner, '--sweep', 'power', '--runs', '1', '--minutes', '1', '--jobs', '2'],
    { encoding: 'utf8', cwd: root, timeout: 90_000 });
  T('--sweep power：正常退出（0）', rp.status === 0);
  if (rp.status !== 0) console.log((rp.stdout || '').slice(-1500), (rp.stderr || '').slice(-1500));
  const filesP = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  const jsonFileP = filesP.find(f => f.endsWith('.json'));
  T('--sweep power：产出了合并结果文件（power_sweep_ 前缀）',
    !!jsonFileP && jsonFileP.startsWith('power_sweep_'));
  T('--sweep power：各进程的临时 JSON 已经在合并后清理掉', !filesP.some(f => /_job\d+\.json$/.test(f)));
  if (jsonFileP) {
    const dataP = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFileP), 'utf8'));
    T('--sweep power：JSON 里的 sweep 字段是 "power"（不是遗留的 "soul"）', dataP.sweep === 'power');
    T('--sweep power：合并后的 JSON 恰好含 8 档结果（基线 + 7 种元素之力，一个不漏）',
      dataP.results.length === 8);
    const labelsP = new Set(dataP.results.map(r => r.label));
    T('--sweep power：合并结果里包含基线档', [...labelsP].some(l => l.includes('基线')));
    T('--sweep power：7 种元素之力各自都在（按 POWERS 清单逐个核对）',
      !!runnerPowers && runnerPowers.every(k => [...labelsP].some(l => l.includes(k))));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- ⑤ v51.7 新增：--pick 只跑点名的档位（针对性重跑用），不是悄悄跑成全量 ----
{
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const r2 = spawnSync('node', [runner, '--pick', 'fire,water,基线', '--runs', '1', '--minutes', '1', '--jobs', '2'],
    { encoding: 'utf8', cwd: root, timeout: 90_000 });
  T('--pick 三档：正常退出（0）', r2.status === 0);
  if (r2.status !== 0) console.log((r2.stdout || '').slice(-1500), (r2.stderr || '').slice(-1500));
  const files2 = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  const jsonFile2 = files2.find(f => f.endsWith('.json'));
  T('--pick 三档：产出了合并结果文件', !!jsonFile2);
  if (jsonFile2) {
    const data2 = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFile2), 'utf8'));
    T('--pick 三档：合并结果恰好 3 档，不是悄悄跑了全部 14 档', data2.results.length === 3);
    const labels2 = new Set(data2.results.map(r => r.label));
    T('--pick 三档：点名的 fire/water/基线 都在，没跑漏也没跑多',
      [...labels2].some(l => l.includes('基线'))
      && [...labels2].some(l => l.includes('fire'))
      && [...labels2].some(l => l.includes('water'))
      && ![...labels2].some(l => l.includes('thunder') || l.includes('magma')));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 写错档名：应该直接报错退出，不能悄悄当成全量跑掉（用户会白等一整轮）。
  const r3 = spawnSync('node', [runner, '--pick', 'notarealsoul', '--runs', '1', '--minutes', '1'],
    { encoding: 'utf8', cwd: root, timeout: 30_000 });
  T('--pick 写错档名：非 0 退出（拒绝悄悄跑成全量）', r3.status !== 0);
  T('--pick 写错档名：错误信息里点名是哪个档位不认识', /notarealsoul/.test(r3.stderr || ''));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`龙魂平衡本地跑批验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
