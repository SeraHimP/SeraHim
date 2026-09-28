// P4 批量对局模拟器（tools/balance_matrix.mjs）验收。
//
// 这个脚本是【调平衡用的尺子】，它自己必须先是准的。尺子只有两条硬性要求：
//   ① 可复现：同一命令跑两遍，结果必须逐字一致。否则"改了参数胜率变了"
//      永远分不清是参数起作用了还是随机数抖了一下，整个工具就是废的。
//   ② 有分辨力：不同种子的对局必须真的不同。种子参数如果是摆设，
//      "跑 20 局取平均"就退化成"跑 1 局抄 20 遍"，样本量是假的。
// 另外钉住输出格式里的关键字段，避免以后改打印顺手把推进度这类主信号删了。
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'balance_matrix.mjs');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const run = (args) => spawnSync('node', [tool, ...args], { encoding: 'utf8' });

// ---- ① 可复现：同参数两次运行输出完全一致 ----
const A = run(['--runs', '2', '--minutes', '3']);
const B = run(['--runs', '2', '--minutes', '3']);
T('模拟器正常退出', A.status === 0 && B.status === 0);
if (A.status !== 0) console.log(A.stderr.slice(0, 800));

// 耗时行每次都不同，比对时剔除
const strip = (s) => s.split('\n').filter(l => !l.startsWith('耗时')).join('\n');
T('同种子两次运行结果逐字一致（可复现）', strip(A.stdout) === strip(B.stdout));

// ---- ② 有分辨力：单局结果不能全部雷同 ----
const J = path.join(root, 'tests', '.matrix_tmp.json');
const C = run(['--runs', '4', '--minutes', '3', '--json', J]);
T('--json 落盘可用', C.status === 0);
const fs = await import('fs');
const data = JSON.parse(fs.readFileSync(J, 'utf8'));
fs.unlinkSync(J);
const rows = data.results[0].rows;
T(`落盘含每局明细（${rows.length} 局）`, rows.length === 4);
const sigs = new Set(rows.map(r => `${r.push.blue}/${r.push.red}/${r.kills.blue}/${r.kills.red}`));
T(`不同种子产生不同对局（${sigs.size}/4 种结果）`, sigs.size > 1);

// ---- ③ 推进度口径 ----
// 推进度 = 已打掉的档位数 + 最前线那座的掉血比例，所以必须是非负的连续量，
// 且 3 分钟内绝不可能推穿到召唤水晶（档位 4）。越界说明档位映射写错了。
const pushes = rows.flatMap(r => [r.push.blue, r.push.red]);
T('推进度非负', pushes.every(p => p >= 0));
T(`推进度在合理量级内（最大 ${Math.max(...pushes)}，3 分钟不可能破 4）`, Math.max(...pushes) < 4);
T('短局判为平局（3 分钟推不掉枢纽）', rows.every(r => r.winner === 'draw'));

// ---- ④ 输出保留主信号字段 ----
T('输出含推进度（打平时的主信号，不能被删）', /推进度/.test(A.stdout));
T('输出含胜率', /蓝胜/.test(A.stdout));

// ---- ⑤ 扫档模式：档位之间配置互不污染 ----
// 昼夜扫档会改写 CONFIG.world.dayNightBonus，还原不干净的话 0% 档会被上一档带偏。
const D = run(['--sweep', 'dayNight', '--runs', '1', '--minutes', '2']);
T('昼夜扫档正常退出', D.status === 0);
T('昼夜扫档跑满 5 档', (D.stdout.match(/昼夜加成/g) || []).length === 5);
const E = run(['--sweep', 'entropy', '--runs', '1', '--minutes', '2']);
T('熵扫档正常退出', E.status === 0);
T('熵扫档跑满 5 档', (E.stdout.match(/^熵 /gm) || []).length === 5);

console.log(`批量模拟器验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
