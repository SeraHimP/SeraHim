// Auto-injected: minimal CTX shim for test environment.
if (typeof window !== "undefined" && !window.CTX) {
  window.CTX = {
    gameTime: 0, waveNumber: 0, gamePaused: false, _uid: 0,
    _nextWaveTime: 20, __gameSpeed: 1, __ffRemain: 0,
    __showLanePaths: false,
    __towerRules: {
      invincible: { blue: false, red: false },
      attackOff:  { blue: false, red: false },
      waveOn:     { blue: true,  red: true  },
    },
    __towerRuleFor(kind, faction) {
      const r = this.__towerRules?.[kind];
      if (!r) return false;
      if (!faction) return r.blue || r.red;
      return !!r[faction];
    },
    __app: null, __weather: null, __mapSystem: null,
    __uiManager: null, __weatherPanel: null, __entityContainer: null,
    __perf: null, __score: null, __gameLoop: null,
    createMinion: null, createTower: null,
  };
}

// ==================== 启动体检（v10 事故的直接产物） ====================
// 事故：基地光环补丁被贴进了 createTower（该函数没有 tier 变量），开机即 ReferenceError，
// 整个 main.js 崩死、界面全黑。而当时 6 套仿真全绿——因为它们都直接 import 各个系统，
// 从不加载 main.js，等于把组合根整个漏在测试之外。
//
// 本套的职责：不依赖浏览器，也能证明 main.js「能被解析、且没有未定义引用」。
// 手段：
//   1) 语法解析（node --check 等价：动态 import 会真跑，所以用 vm 编译而不执行）
//   2) 作用域引用体检：把每个顶层函数体内出现的标识符，与「全局白名单 + 模块顶层声明 +
//      本函数参数/局部声明」比对，任何对不上的都是可疑的未定义引用。
import fs from 'fs';
import { fileURLToPath } from 'url';

let fails = 0;
const A = (n, c) => { if (!c) { fails++; console.log('✗', n); } };

// 体检覆盖全部源文件（组合根 main.js 是重灾区，但其他文件同样可能被贴错补丁）
const { spawnSync: _sp } = await import('child_process');
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const allFiles = _sp('find', [srcDir, '-name', '*.js'], { encoding: 'utf8' }).stdout.trim().split('\n');
for (const file of allFiles) {
  const r = _sp('node', ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('  语法错误:', file); }
  A('语法可编译: ' + file.replace(srcDir, ''), r.status === 0);
}

// 注：手写正则做作用域分析的路子已放弃——误报率太高（把浏览器全局、正则字面量、
// 多声明符都当成未定义引用），而误报比漏报更有害：它会训练人无视警告。
// 真正的防线是 sim_runtime.mjs 的【动态冒烟】：用 DOM 桩把整个游戏循环真跑起来，
// 任何运行时错误（v25 的 `entity is not defined` 正是此类）都会当场暴露。

const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// ---- 1. 能否编译（node --check 是权威语法检查，零实验标志） ----
const { spawnSync } = await import('child_process');
const mainPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const chk = spawnSync('node', ['--check', mainPath], { encoding: 'utf8' });
if (chk.status !== 0) console.log('  编译错误:', (chk.stderr || '').split('\n').slice(0, 3).join('\n'));
A('main.js 可编译（无语法错误）', chk.status === 0);

// ==================== 顶层执行顺序体检（TDZ / 先用后声明） ====================
// v24 事故：`canvasController.mapSystem = mapSystem` 被插在 mapSystem 声明之前，
// const 的暂时性死区（TDZ）导致 ReferenceError，整个 main.js 加载失败、游戏起不来。
// 讽刺的是 main.js 里本来就有一段注释记着同样的教训——但作用域体检只检查
// "名字存不存在"，不检查"用的时候初始化了没"，所以抓不住。这里补上。
{
  // 只看顶层语句（不进函数体——函数体在调用时才执行，那时所有顶层声明都已完成）
  const lines = src.split('\n');
  const declaredAt = new Map();   // 顶层 const/let/function 的声明行号
  let depth = 0;
  const topLines = [];            // [{ lineNo, text }]，仅顶层
  lines.forEach((raw, i) => {
    // 先去掉行尾 \r 再剥注释：main.js 是 CRLF，split('\n') 会留下 \r，
    // 而 /\/\/.*$/ 的 . 不匹配 \r、$ 又只认字符串末尾 → 整行注释根本没被剥掉，
    // 于是注释里出现的标识符被当成"先用后声明"，7 条全是假阳性。
    const line = raw.replace(/\r$/, '').replace(/\/\/.*$/, '');
    if (depth === 0) topLines.push({ lineNo: i, text: line });
    const m = depth === 0 && line.match(/^(?:const|let|var|function)\s+(\w+)/);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
  });

  const tdz = [];
  for (const { lineNo, text } of topLines) {
    // 跳过声明行本身
    if (/^(?:const|let|var|function|import|export|\/\*|\*)/.test(text.trim())) continue;
    for (const [name, declLine] of declaredAt) {
      if (declLine <= lineNo) continue;           // 声明在前，没问题
      // 该顶层语句里用到了一个"更晚才声明"的名字 → TDZ 风险
      const re = new RegExp('(?<![.\\w$])' + name + '(?![\\w$])');
      if (re.test(text)) tdz.push({ lineNo: lineNo + 1, name, declLine: declLine + 1, text: text.trim().slice(0, 60) });
    }
  }
  if (tdz.length) {
    console.log('  先用后声明（TDZ，会直接崩）:');
    for (const t of tdz) console.log(`    第${t.lineNo}行用了 ${t.name}，但它在第${t.declLine}行才声明 → ${t.text}`);
  }
  A('main.js 顶层无"先用后声明"（TDZ）', tdz.length === 0);
}

console.log(fails ? `❌ 启动体检 ${fails} 项失败` : '✅ 启动体检通过');
process.exit(fails ? 1 : 0);
