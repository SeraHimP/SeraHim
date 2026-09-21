// 防御塔武器强度横向对照工具（tools/balance_tower.mjs）验收。
//
// 跟 sim_matrix.mjs 验证 balance_matrix.mjs 是同一条思路：这个脚本本身是把
// "调平衡用的尺子"，尺子必须先自己是准的——可复现、有分辨力、进攻方角色
// 真的是随机指派（不是写死蓝方）、--pick/--json 这些接口不能悄悄坏掉。
// 全部走子进程黑盒测试（不 import 脚本本体）——脚本本身是"加载即跑"的顶层
// 脚本，没有入口守卫，import 会直接触发一整轮真实模拟，这与
// tools/balance_matrix.mjs / tests/sim_matrix.mjs 是同一个既有取舍，不是
// 这次偷懒漏掉。
//
// 参数全部故意压得很小（--runs 2~4、--minutes 3）：这里只验证【机制接线】
// 对不对，不是要在测试套件里真的跑出平衡结论——那是 tools/balance_tower.mjs
// 自己按用户要求 --minutes 120 的事，不该混进日常回归的时间预算里。
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'balance_tower.mjs');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const run = (args) => spawnSync('node', [tool, ...args], { encoding: 'utf8' });

// ---- ① 可复现：同参数两次运行输出完全一致 ----
const A = run(['--runs', '2', '--minutes', '3', '--pick', 'piercing']);
const B = run(['--runs', '2', '--minutes', '3', '--pick', 'piercing']);
T('工具正常退出', A.status === 0 && B.status === 0);
if (A.status !== 0) console.log(A.stderr.slice(0, 800));
const strip = (s) => s.split('\n').filter(l => !l.startsWith('耗时')).join('\n');
T('同参数两次运行结果逐字一致（可复现）', strip(A.stdout) === strip(B.stdout));

// ---- ② --pick 过滤：只测请求的武器，不多不少 ----
// 行首锚定 ^防守方=（multiline）：每档的结果行是唯一以"防守方="开头的行，
// 不锚定行首的话，档位数>1时"最扛揍/最不扛揍"那行摘要里也会各嵌一次"防守方=X"，
// 把计数撑高，假装通过。
T('--pick 单个武器时只输出这一档', (A.stdout.match(/^防守方=/gm) || []).length === 1);
const P2 = run(['--runs', '1', '--minutes', '2', '--pick', 'nova,prism']);
T('--pick 逗号分隔多个武器时输出对应档数', (P2.stdout.match(/^防守方=/gm) || []).length === 2);
const P0 = run(['--runs', '1', '--minutes', '2', '--pick', '不存在的武器名']);
T('--pick 匹配不到任何武器时非0退出并给出可用列表', P0.status !== 0 && /可用/.test(P0.stdout));

// ---- ③ --json 落盘：字段齐全，且真的落了每局明细 ----
const J = path.join(root, 'tests', '.towerbalance_tmp.json');
const C = run(['--runs', '4', '--minutes', '3', '--pick', 'piercing', '--json', J]);
T('--json 落盘可用', C.status === 0);
const fs = await import('fs');
const data = JSON.parse(fs.readFileSync(J, 'utf8'));
fs.unlinkSync(J);
const rows = data.results[0].rows;
T(`落盘含每局明细（${rows.length} 局）`, rows.length === 4);

// ---- ④ 有分辨力：不同种子的对局不能全部雷同 ----
const sigs = new Set(rows.map(r => `${r.minutes}/${r.defenderTowersLost}/${r.attackerFaction}`));
T(`不同种子产生不同对局（${sigs.size}/4 种结果）`, sigs.size > 1);

// ---- ⑤ 进攻方真的是随机指派，不是写死某一边 ----
// 用户原话"红蓝方中随机某一方为进攻方"——多跑几局，蓝红都应该出现过，
// 不能是"名字上说随机、实际上永远是同一边"这种挂羊头卖狗肉。
const J2 = path.join(root, 'tests', '.towerbalance_tmp2.json');
run(['--runs', '16', '--minutes', '2', '--pick', 'piercing', '--json', J2]);
const data2 = JSON.parse(fs.readFileSync(J2, 'utf8'));
fs.unlinkSync(J2);
const attackers = new Set(data2.results[0].rows.map(r => r.attackerFaction));
T('16局里蓝红都当过进攻方（真的是每局随机指派，不是写死一边）',
  attackers.has('blue') && attackers.has('red'));

// ---- ⑥ 合理量级：极短封顶内不可能被推穿到水晶枢纽 ----
// 与 sim_matrix.mjs 里"3分钟不可能破4"同一条道理——即便进攻方被拉到极端强度，
// 3分钟的物理时长也打不穿一整条塔链（outer→base→hq×2→nexus_lane→nexus_main）。
const lost = rows.map(r => r.defenderTowersLost);
T('丢塔档位非负', lost.every(v => v >= 0));
T(`丢塔档位在合理量级内（最大 ${Math.max(...lost)}，3 分钟不可能推穿到水晶枢纽档位5）`,
  Math.max(...lost) < 5);

// ---- ⑦ 输出保留主信号字段（判读提示里明确说了胜负在这里不是有效信号） ----
T('输出含存活均时长（主信号，不能被删）', /存活均时长/.test(A.stdout));
T('输出含丢塔档位（主信号，不能被删）', /丢塔档位/.test(A.stdout));
T('输出含防守方胜率（旁证信号）', /防守方胜/.test(A.stdout));

console.log(`防御塔强度对照工具（balance_tower.mjs）验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
