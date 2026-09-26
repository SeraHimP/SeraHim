// 走廊排队力（Q6：三路排队不一致）验收。
//
// 挑测什么：**行为**验证（"中路散开变少"）要 8 分钟真实对局采样，太慢，
// 不适合放进一键回归 —— 那份实测（含被否掉的三组参数）留在
// CONFIG.tuning.laneCentering 的注释里。这里钉三件回归时真会坏掉的事：
//   ① 参数软编码，且**默认值与 v39 原式可证明等价**（不是"看起来差不多"）；
//   ② 三个让位条件都在（每一个都是踩出来的，去掉任一个都有对应用例会红）；
//   ③ 权重斜坡的算术。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { CONFIG } = await import('../src/data/Config.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const SRC = fs.readFileSync('src/systems/LaneMovementSystem.js', 'utf8');
const CFG = fs.readFileSync('src/data/Config.js', 'utf8');

// ==================== 一、参数化：默认值必须与 v39 原式等价 ====================
{
  const lc = CONFIG.tuning?.laneCentering;
  T('参数在 CONFIG 里（源码里不留魔数）', !!lc);
  T('默认开启', lc.enabled === true);
  T('三个旋钮都在', typeof lc.deadZone === 'number'
    && typeof lc.rampTo === 'number' && typeof lc.weight === 'number');

  // v39 原式：w = min(0.5, d/140) × 0.55。
  // 参数化后：w = weight × min(1, d/rampTo)。
  // 取 weight=0.275、rampTo=70 时两者**逐位相同** —— 这条断言保证"参数化本身"
  // 没有偷偷改行为，把"改了参数"和"改了公式"两件事分开。
  const v39 = (d) => Math.min(0.5, d / 140) * 0.55;
  const now = (d, w, r) => w * Math.min(1, d / r);
  let same = true;
  for (let d = 6.001; d < 400; d += 0.017) {
    if (Math.abs(v39(d) - now(d, 0.275, 70)) > 1e-15) { same = false; break; }
  }
  T('参数化公式在 weight=0.275/rampTo=70 时与 v39 原式逐位等价', same);
  T('实现用的就是这个形状（斜坡从 0 起算，不减死区）',
    /\(_lc\.weight \?\? 0\.275\) \* Math\.min\(1, n\.dist \/ Math\.max\(1, _lc\.rampTo \?\? 70\)\)/.test(SRC));

  T('当前默认比 v39 更强（v39 的 0.275 压不住分离力）', lc.weight > 0.275);
  T('注释里留了实测对照表（含被否掉的参数与兵墙用例结果）',
    /0\.275\/70（= v39）/.test(CFG) && /0\.700\/40/.test(CFG) && /兵墙测试/.test(CFG));
  T('注释里说明了为什么不取"最一致"那一档（会让兵墙用例掉到 5/6）',
    /5\/6/.test(CFG) && /拟合噪声/.test(CFG));
  T('注释里说明了残留问题（中路只有一段，压不平）', /整条路只有一段/.test(CFG));
}

// ==================== 二、三个让位条件 ====================
// 这一节是本次的核心。排队力和"眼前正在处理的事"是对着干的，
// 每一个让位条件都对应一个真实红过的用例：
{
  T('让位条件写在一处（_lcOn），不是散在各个分支里',
    /const _lcOn = _lc\.enabled !== false && !enemyNear && !blocked && !minion\._detourSide;/.test(SRC));
  T('① 附近有敌人时让位（不让位：sim_passthrough 的"零未接敌穿越" 0 → 7）',
    /let enemyNear = false;/.test(SRC) && /if \(!sameFac\) enemyNear = true;/.test(SRC));
  T('敌人判定复用已有的邻居扫描（不额外查一次网格）',
    SRC.indexOf('if (!sameFac) enemyNear = true;') > SRC.indexOf('for (const o of this.entities.findInRadius(minion.pos.x, minion.pos.y, R'));
  T('敌人判定在 rSum+26 早退【之前】（接敌前就要让位，不能等贴上）',
    SRC.indexOf('if (!sameFac) enemyNear = true;') < SRC.indexOf('if (od > rSum + 26) continue;'));
  T('② 正面被锚定障碍挡住时让位（不让位：sim_wall 的"全部越过兵墙" 6/6 → 5/6）',
    /!blocked/.test(SRC));
  T('③ 绕行黏性期内让位（别在半路把它拽回中线）', /!minion\._detourSide/.test(SRC));
  T('注释写清了每个让位条件对应哪个用例', /零未接敌穿越/.test(SRC) && /越过兵墙/.test(SRC));

  // 野区回归那一段【不受让位影响】：跑进野区是要纠正的错误位置，不是交火走位
  T('野区回归（LANE_KEEP 之外）不受让位影响',
    /if \(n\.dist > LANE_KEEP\) w \+= Math\.min\(1, \(n\.dist - LANE_KEEP\) \/ LANE_SPAN\) \* LANE_BACK_K;/.test(SRC));
  T('野区回归的注释说明了为什么不让位', /跑进野区是要纠正的错误位置/.test(SRC));

  // 别再写第二份：这段力从 v39 就存在，第一版我差点在 _advanceAlongLane 里又加一个
  T('排队力只有一处实现（_advanceAlongLane 里不许再加一份）',
    !/laneCentering/.test(SRC.slice(SRC.indexOf('_advanceAlongLane(minion, stats, dt) {'),
                                    SRC.indexOf('_steer(minion, dirX, dirY'))));
  T('注释里记了"差点抄第二份"这件事', /抄第二份/.test(CFG));
}

// ==================== 三、权重斜坡的算术 ====================
{
  const lc = CONFIG.tuning.laneCentering;
  const w = (d) => d <= lc.deadZone ? 0 : lc.weight * Math.min(1, d / Math.max(1, lc.rampTo));
  T('死区内权重为 0', w(0) === 0 && w(lc.deadZone) === 0);
  T('死区外单调递增', w(lc.deadZone + 1) < w(lc.deadZone + 10) && w(lc.deadZone + 10) < w(lc.rampTo));
  T('到 rampTo 达到满权重', Math.abs(w(lc.rampTo) - lc.weight) < 1e-9);
  T('再远也不超过满权重（不会盖掉前进方向）', w(9999) === lc.weight);
  T('满权重 < 1：期望力永远占主导（否则小兵横着走而不是往前走）', lc.weight < 1);
  T('死区小于实测偏移中位数（否则力永远不启动 —— 第一版取 34 就是这么废掉的）',
    lc.deadZone < 15);
}

console.log(`走廊排队力验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
