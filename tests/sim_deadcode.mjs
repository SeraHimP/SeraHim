// 死代码守卫（v43 P0-①）
//
// ==================== 为什么要有这一套 ====================
// 这一轮我在 `src/presentation/CanvasRenderer.js` 里认认真真改了一处 bug（把攻城车的
// 攻击红线统一成和塔一样的样式），**改完才发现全仓库没有任何一处 import 它**。
// 它是 2.5D 迁移前的 2D 渲染器，迁移完成后就没人调了，但一直留在树上 634 行。
// 我照着它改了一遍，纯属白做工。
//
// 同批发现的还有 `src/core/EntityFactory.js`(105 行)、`src/core/GameEvents.js`(43 行)
// 两个零引用模块，以及三个 `.bak`（main.js.bak 41KB / LaneMovementSystem.js.bak 32KB /
// CollisionSystem.js.bak 4KB）—— git 已经存了历史，工作树里再留一份只会误导人。
//
// 死代码的害处不是占空间，是**它看起来是活的**：
//   · 改 bug 时会被改到（我就是），白费工；
//   · 搜索时会命中，把人引到错误的实现上；
//   · 断言会去钉它（sim_v36/v40 原来就钉着 CanvasRenderer 的渲染行为），
//     于是"有断言守着"是假的——钉的是没人跑的代码。
//
// 所以这一套的职责很窄：**保证 src/ 下每个模块都真的被人用**。
// 它不检查函数级/变量级的死代码（那需要静态分析，误报率高、维护成本大于收益）。
import fs from 'fs';
import path from 'path';

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const ROOT = new URL('../', import.meta.url).pathname;
const SRC = path.join(ROOT, 'src');

/** 递归收集某目录下的全部 .js（不进 vendor/node_modules） */
function collect(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'vendor') continue;
      collect(p, out);
    } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

// 引用来源 = src/ 的全部模块 + tests/ + tools/ + index.html。
// tests 与 tools 也算：只被测试用到的模块（如纯数据表）不该被判死。
const srcFiles = collect(SRC);
const refFiles = [
  ...srcFiles,
  ...collect(path.join(ROOT, 'tests')),
  ...(fs.existsSync(path.join(ROOT, 'tools')) ? collect(path.join(ROOT, 'tools')) : []),
  path.join(ROOT, 'index.html'),
].filter(p => fs.existsSync(p));

// 入口：被 index.html 直接加载的模块不需要"被别人 import"
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ENTRY = new Set(
  [...html.matchAll(/src=["']\.\/(src\/[^"']+\.js)["']/g)].map(m => path.join(ROOT, m[1]))
);

// ==================== ① 每个模块都要有人 import ====================
{
  const orphans = [];
  for (const f of srcFiles) {
    if (ENTRY.has(f)) continue;
    const base = path.basename(f);                      // 'CorrosionLayer.js'
    const stem = base.replace(/\.m?js$/, '');           // 'CorrosionLayer'
    // 只认**真正的 import/动态 import 路径**，不认注释里提到的名字 ——
    // 本仓库的注释里到处写着模块名（"从 CanvasRenderer 原样抽出…"），
    // 按名字模糊匹配的话，一个死模块只要被谁在注释里念叨一句就永远判不了死。
    const re = new RegExp(`(from|import)\\s*\\(?\\s*['"][^'"]*/${stem}\\.m?js['"]`);
    const used = refFiles.some(r => r !== f && re.test(fs.readFileSync(r, 'utf8')));
    if (!used) orphans.push(path.relative(ROOT, f));
  }
  T(`src/ 下没有零引用模块${orphans.length ? '（发现：' + orphans.join(', ') + '）' : ''}`,
    orphans.length === 0);
}

// ==================== ② 工作树里不许留 .bak ====================
{
  const baks = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === 'vendor' || name === '.git') continue;
        walk(p);
      } else if (/\.(bak|orig|old|copy)$/i.test(name)) {
        baks.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  T(`工作树里没有 .bak/.orig/.old 备份文件${baks.length ? '（发现：' + baks.join(', ') + '）' : ''}`,
    baks.length === 0);
}

// ==================== ③ 已删除的模块不许被任何地方再 import ====================
// 光删文件不够：断言/文档里如果还写着 import 路径，跑起来就是 ENOENT
//（本次删 CanvasRenderer 时，sim_v36/v40/custom 三套都当场炸了）。
{
  const GONE = ['CanvasRenderer', 'EntityFactory', 'GameEvents'];
  const bad = [];
  for (const g of GONE) {
    const re = new RegExp(`['"][^'"]*/${g}\\.m?js['"]`);
    for (const r of refFiles) {
      if (re.test(fs.readFileSync(r, 'utf8'))) bad.push(`${path.relative(ROOT, r)} → ${g}`);
    }
  }
  T(`已删模块没有残留的 import 路径${bad.length ? '（发现：' + bad.join(', ') + '）' : ''}`,
    bad.length === 0);
}

console.log(`死代码守卫: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
