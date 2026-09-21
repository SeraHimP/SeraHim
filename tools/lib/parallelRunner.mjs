/**
 * tools/lib/parallelRunner.mjs —— 跑批脚本共享的并行调度层
 *
 * ==================== 为什么要抽出来 ====================
 * 用户："以后测试跑的脚本可能很多，脚本也要有一个统一的架构，方便后期写不同
 * 其他测试脚本。" 起因是这一轮连续两个真实问题：
 *   ① 塔平衡横向对照（tools/balance_tower.mjs）CPU 占用很低——根因是按"局"
 *      并行前，单进程串行跑，其余核心全程闲置（已在 2026-09-21 修过，见该
 *      文件头注"并行榨干多核"）。
 *   ② 龙魂平衡跑批（tools/run_balance_soul.mjs）挂了超过24小时依旧卡住——
 *      单局在极端对称僵局下会真的无限跑（tools/balance_matrix.mjs 头注早就
 *      写了这个后果，2026-09-21 已经用"热寂终局"机制从游戏规则层面根治），
 *      而且**看不到当前具体卡在哪一局、也没法手动跳过**。
 * 这两个问题的解法本质相同：把"按局拆分、并行跑、聚合进度、支持跳过"这套
 * 机制做成一个跑批脚本都能复用的库，而不是每个新脚本各写一遍——下次再写
 * 新的横向对照工具，直接接这个库就有并行/进度/跳过/落盘这一整套。
 *
 * ==================== 设计 ====================
 * orchestrator（主进程）用 child_process.fork() 拉起若干 worker（自己重新
 * spawn 自己，通过 IPC 通道通信，不再靠"解析 stderr 文本"猜进度——fork()
 * 自带的 process.send/on('message') 给的是结构化消息，比正则抠 `\r i/N`
 * 健壮，也顺带打开了"orchestrator 主动给 worker 发跳过信号"这条路，纯靠
 * stdio 管道是做不到双向通信的。
 *
 * worker 侧循环调用调用方传入的 workFn(item, ctx)，ctx 带两个钩子：
 *   · ctx.onProgress(info)：工作函数可以在自己内部的长循环里（比如模拟到
 *     第几分钟了）随时上报一条子进度，orchestrator 会实时显示"当前在跑
 *     哪一项、进度多少"，不再是"整项跑完才 +1"这种粗粒度、容易看起来像
 *     卡住的进度条。
 *   · ctx.shouldSkip()：工作函数在自己的主循环里该周期性调用一下这个——
 *     返回 true 就该提前 return/break，把这一项标记为"用户手动跳过"，
 *     不是真的算完，但不阻塞整批跑完。
 *
 * orchestrator 监听标准输入：跑批过程中按 s + 回车，跳过当前跑得最久的
 * 那一项（原始 items 早排过序，"跑得最久"用"这个 worker 开始跑当前项
 * 的时间戳"判断，不用猜）。
 *
 * ==================== 调用约定（务必照抄，否则会重蹈"fork炸弹"覆辙）====================
 * ⚠️ 2026-09-21 第一版在这里栽过一次真实 bug：调用方脚本顶部写的是
 *   `if (isWorkerProcess()) { runWorker(fn); }`
 * 后面不加任何东西直接紧跟 orchestrator 的代码——runWorker() 内部只是注册了
 * 一个 `process.on('message', ...)` 监听器就【立刻返回】，并不会同步阻塞到
 * 进程退出。于是"worker 分支"执行完 runWorker() 那一行之后，代码继续往下
 * 掉进了 orchestrator 的逻辑——worker 自己又去 fork 更多 worker，那些
 * worker 又各自继续掉进 orchestrator……指数级递归 fork，几秒内就能把机器
 * 打到失去响应，终端里连一行输出都来不及打印（冒烟测试复现过：15秒超时
 * 杀掉，全程零输出）。
 *
 * 唯一正确的用法是 **if/else 互斥**，两条分支必须二选一、不能顺序执行：
 * ```js
 * if (isWorkerProcess()) {
 *   runWorker((item, ctx) => myRunOne(item, ctx));
 * } else {
 *   // ...orchestrator 的全部逻辑（构造 items、调 runOrchestrator、落盘等）
 * }
 * ```
 * 不要写成"两段各自顶格、中间没有 else 分隔"的形式，哪怕看起来 worker 分支
 * "应该"会在 runWorker 内部退出——它不会同步退出，必须结构上互斥。
 *
 * ==================== 第二个真实坑：shouldSkip() 光靠"周期性调用"是假的 ====================
 * ⚠️ 冒烟测试还揭出第二个更隐蔽的问题：workFn 如果是一个【纯同步】的长循环
 * （比如塔平衡/龙魂那种一局几十万帧的模拟主循环），Node 是单线程事件循环，
 * IPC 收到的 'skip' 消息要等【当前这段同步代码执行完、把控制权还给事件循环】
 * 才会真正触发 `process.on('message', ...)` 回调——workFn 只要不主动让出
 * 控制权，这条消息在 workFn 跑完之前根本没机会被处理，`ctx.shouldSkip()`
 * 不管调多少次都只会读到跳过请求到达【之前】的旧值，永远是 false。用一个
 * 纯 CPU-bound busy loop 直接测过：父进程确实把 skip 消息发出去了，子进程
 * 也确实收到了（IPC 本身没问题），但 workFn 内部的 shouldSkip() 全程读到
 * false，因为消息处理回调排在事件循环队列里，永远排不上号。
 *
 * 结论：workFn **必须是 async 函数**，并且在自己的主循环里周期性
 * `await` 一次真正的宏任务边界（`setImmediate`/`setTimeout(fn,0)` 都行），
 * 才能把控制权还给事件循环、让排队的 IPC 消息有机会被处理。参考实现：
 * ```js
 * async function myRunOne(item, ctx) {
 *   for (let i = 0; i < N; i++) {
 *     // ...每帧计算...
 *     if (i % CHECK_EVERY === 0) {
 *       await new Promise((r) => setImmediate(r));   // 让出控制权
 *       if (ctx.shouldSkip()) { return partialResult; }
 *     }
 *   }
 * }
 * ```
 * runWorker() 已经按 `await workFn(item, ctx)` 调用，配合 workFn 自己让出
 * 控制权即可；调用方唯一要做的是让 workFn 真的是 async 的、真的会 await。
 *
 * ==================== 给这次改动的两个既有回归判据 ====================
 * tests/sim_towerbalance.mjs 的可复现性测试（同参数两次运行 stdout 逐字
 * 一致）必须继续过——本库的所有进度/交互输出都走 stderr，不碰 stdout；
 * 且不触发跳过时行为要跟改动前的纯并行版本逐位一致（结果按 sortKey 排序
 * 合并，不受 worker 完成先后顺序影响）。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const IS_WORKER = process.env.__PARALLEL_RUNNER_WORKER__ === '1';

/** 供调用方在自己脚本顶部判断"我现在是不是被 runOrchestrator fork 出来的 worker"。 */
export function isWorkerProcess() {
  return IS_WORKER;
}

/**
 * worker 侧入口——调用方必须保证这行下面没有任何 orchestrator 代码会被
 * 顺序执行到（见文件头注"调用约定"，用 if/else 互斥，不要顺序排列）。
 * 内部一路跑到 process.exit()。
 *
 * @param {(item:any, ctx:{onProgress:(info:any)=>void, shouldSkip:()=>boolean})=>(any|Promise<any>)} workFn
 *   建议是 async 函数，并在自己主循环里周期性 `await` 一次让出控制权——见
 *   文件头注"第二个真实坑"，否则 ctx.shouldSkip() 永远读不到真实的跳过请求。
 */
export function runWorker(workFn) {
  let items = null;
  let currentIndex = -1;
  let skipRequested = false;

  process.on('message', (msg) => {
    if (msg?.type === 'items') { items = msg.items; void run(); }
    if (msg?.type === 'skip' && typeof msg.index === 'number') {
      if (msg.index === currentIndex) skipRequested = true;
    }
  });

  async function run() {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      currentIndex = i;
      skipRequested = false;
      const item = items[i];
      process.send({ type: 'current', index: i, item });
      const ctx = {
        onProgress: (info) => process.send({ type: 'progress', index: i, item, info }),
        shouldSkip: () => skipRequested,
      };
      let result, error = null;
      try {
        result = await workFn(item, ctx);
      } catch (e) {
        error = e.message || String(e);
      }
      const skipped = skipRequested;
      out.push({ item, result, skipped, error });
      process.send({ type: 'itemDone', index: i, item, skipped, error });
    }
    process.send({ type: 'finished', results: out });
    process.exit(0);
  }
}

/**
 * orchestrator 侧入口——把 items 拆到 min(核数, items.length) 个 worker
 * 并行跑完，实时显示总进度 + 每个 worker 当前在跑哪一项，支持按 s+回车
 * 跳过跑得最久的那一项。
 *
 * @param {object} opts
 * @param {any[]} opts.items 全部工作项（会被均匀轮转分给各 worker）
 * @param {string} opts.scriptUrl 调用方自己的 import.meta.url——worker 就是
 *   重新 spawn 这个文件本身（约定：脚本顶部检测 isWorkerProcess() 后走
 *   runWorker 分支，用 if/else 与 orchestrator 分支互斥）。
 * @param {(item:any)=>string} [opts.labelOf] 给进度显示用的每项简短描述，
 *   默认 JSON.stringify(item)。
 * @param {(item:any)=>number} [opts.sortKey] 结果合并时的排序键（可复现性
 *   的关键：并行完成顺序不确定，必须排回确定顺序），默认按 items 原始下标。
 * @param {string[]} [opts.extraArgs] 透传给每个 worker 进程的额外 CLI 参数
 *   （比如 --minutes 这类"单局怎么跑"的配置，不是工作项本身）。
 * @param {string} [opts.taskLabel] 显示在进度行开头的这批任务的名字。
 * @param {boolean} [opts.interactive] 是否监听 stdin 支持手动跳过——非
 *   TTY（比如被测试用 spawnSync 拉起）时自动关闭，不会挂在等输入上。
 * @returns {Promise<{item:any, result:any, skipped:boolean, error:string|null}[]>}
 *   按 sortKey 排序后的结果数组。
 */
export async function runOrchestrator(opts) {
  const {
    items, scriptUrl, labelOf = (it) => JSON.stringify(it),
    sortKey = null, extraArgs = [], taskLabel = '跑批',
    interactive = process.stdin.isTTY === true,
  } = opts;

  const cpuCount = os.cpus().length || 4;
  const JOBS = Math.max(1, Math.min(cpuCount, items.length));
  const buckets = Array.from({ length: JOBS }, () => []);
  const bucketOrigIndex = Array.from({ length: JOBS }, () => []);
  items.forEach((item, i) => {
    const b = i % JOBS;
    buckets[b].push(item);
    bucketOrigIndex[b].push(i);
  });

  process.stderr.write(`${taskLabel}：拆成 ${JOBS} 个并行进程（本机 ${cpuCount} 核，共 ${items.length} 项待跑）\n`);
  if (interactive) {
    process.stderr.write('（跑批过程中按 s + 回车可跳过当前跑得最久的那一项）\n');
  }

  const workerCurrent = new Array(JOBS).fill(null); // { index, item, startedAt, progress }
  const workerResults = new Array(JOBS).fill(null);
  let totalDone = 0;

  function pickLongestRunning() {
    let best = -1, bestAt = Infinity;
    for (let w = 0; w < JOBS; w++) {
      const cur = workerCurrent[w];
      if (cur && cur.startedAt < bestAt) { bestAt = cur.startedAt; best = w; }
    }
    return best;
  }

  let rl = null;
  const children = [];
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (line.trim().toLowerCase() !== 's') return;
      const w = pickLongestRunning();
      if (w < 0) return;
      const cur = workerCurrent[w];
      process.stderr.write(`\n跳过：worker${w + 1} 当前这项（${labelOf(cur.item)}，已跑 ${((Date.now() - cur.startedAt) / 1000).toFixed(0)}s）\n`);
      children[w].send({ type: 'skip', index: cur.index });
    });
  }

  const tickerStarted = Date.now();
  const ticker = setInterval(() => {
    const elapsed = (Date.now() - tickerStarted) / 1000;
    const rate = totalDone > 0 ? elapsed / totalDone : 0;
    const remain = totalDone > 0 ? Math.max(0, (items.length - totalDone) * rate) : NaN;
    const etaStr = Number.isFinite(remain)
      ? (remain > 90 ? `约 ${(remain / 60).toFixed(1)} 分钟` : `约 ${Math.round(remain)} 秒`)
      : '估算中…';
    const currents = workerCurrent
      .map((c, w) => (c ? `w${w + 1}:${labelOf(c.item)}${c.progress ? `(${c.progress})` : ''}` : null))
      .filter(Boolean).join(' ');
    process.stderr.write(
      `\r总进度：${totalDone}/${items.length}，已耗时 ${(elapsed / 60).toFixed(1)}分，预计剩余 ${etaStr}  ${currents}`.slice(0, 200)
      + ' '.repeat(10)
    );
  }, 3000);

  const scriptPath = fileURLToPath(scriptUrl);

  function runWorkerProc(w) {
    return new Promise((resolve) => {
      const child = fork(scriptPath, extraArgs, {
        env: { ...process.env, __PARALLEL_RUNNER_WORKER__: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children[w] = child;
      child.on('message', (msg) => {
        if (msg?.type === 'current') {
          workerCurrent[w] = { index: msg.index, item: msg.item, startedAt: Date.now(), progress: null };
        } else if (msg?.type === 'progress') {
          if (workerCurrent[w] && workerCurrent[w].index === msg.index) workerCurrent[w].progress = msg.info;
        } else if (msg?.type === 'itemDone') {
          totalDone++;
          workerCurrent[w] = null;
        } else if (msg?.type === 'finished') {
          workerResults[w] = msg.results;
        }
      });
      child.on('exit', (code) => resolve(code));
      child.send({ type: 'items', items: buckets[w] });
    });
  }

  const exitCodes = await Promise.all(buckets.map((_, w) => runWorkerProc(w)));
  clearInterval(ticker);
  if (rl) rl.close();
  process.stderr.write(`\r总进度：${items.length}/${items.length}，全部完成` + ' '.repeat(40) + '\n');

  exitCodes.forEach((code, w) => {
    if (code !== 0) process.stderr.write(`⚠️ worker${w + 1} 异常退出（退出码 ${code}），它负责的那批可能不完整。\n`);
  });

  const flat = [];
  workerResults.forEach((res, w) => {
    (res || []).forEach((r, localI) => {
      flat.push({ ...r, __origIndex: bucketOrigIndex[w][localI] });
    });
  });
  flat.sort((a, b) => {
    if (sortKey) return sortKey(a.item) - sortKey(b.item);
    return a.__origIndex - b.__origIndex;
  });
  return flat.map(({ __origIndex, ...rest }) => rest);
}

// 供需要落盘/找目录的调用方复用，不用各自重复这几行。
export function ensureBalanceDir(rootUrl) {
  const root = path.resolve(path.dirname(fileURLToPath(rootUrl)), '..');
  const dir = path.join(root, '.balance');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
