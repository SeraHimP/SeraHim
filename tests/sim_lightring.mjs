// 射程圈渐显 + 塔灯光换算 + 废墟可选中 验收（Q1/Q2/Q3）。
//
// 挑测什么：
//  · 射程圈的强度函数是**纯逻辑**（给定实体/条目/依赖就有确定结果）→ 直接调，逐档比对。
//    浏览器里测这个不靠谱：小兵会被沙盒的移动/分离力推走，探测又有 0.25s 节流，
//    读到的距离和探测时的距离经常不是同一个（实测过，数值乱跳）。
//  · 塔灯的强度换算也是纯算术 → 断言"照度落在人能看见的量级"。第一版就是这里错了
//    5 个数量级（把坎德拉当成了照度），而画面上只表现为"这功能没做"。
//  · 废墟可选中的判据 → 断言三处口径一致。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { CONFIG } = await import('../src/data/Config.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ==================== 一、射程圈：按距离渐显 ====================
// UnitLayer 是浏览器模块（import 了 three），headless 下不能实例化。
// 但 _rangeRingStrength 只用到 CONFIG + 传进来的 ctxDeps，所以把方法**从原型上借出来**
// 单独调用即可 —— 这样测的是产品代码本身，不是抄一份公式（抄的那份永远会通过）。
{
  const src = fs.readFileSync('src/presentation/UnitLayer.js', 'utf8');
  const m = src.match(/_rangeRingStrength\(e, en, ctxDeps, selectedId\) \{[\s\S]*?\n  \}/);
  T('能定位到 _rangeRingStrength 实现', !!m);
  // 用 Function 构造出同一份函数体（this 由 call 提供；它只读 CONFIG 与参数）
  const fn = new Function('CONFIG', `return function ${m[0]}`)(CONFIG);

  const cfg = CONFIG.ui.rangeRing;
  T('配置里有内外圈阈值且是 50 / 10（用户定稿）',
    cfg.fadeOuter === 50 && cfg.fadeInner === 10);
  T('滞回已移除（距离本身连续，不再需要防抖阈值）', cfg.hysteresis === undefined);

  const RANGE = 200;
  const tower = { id: 1, pos: { x: 0, y: 0 }, _mapFaction: 'blue' };
  const mkDeps = (enemyDist) => ({
    attrCalc: { calc: () => ({ attackRange: RANGE }) },
    effects: { getEffects: () => [] },
    entities: {
      findInRadius: (x, y, r) => enemyDist === null || enemyDist > r ? []
        : [{ id: 2, type: 'melee', pos: { x: enemyDist, y: 0 }, _mapFaction: 'red' }],
    },
  });
  // 每次都用全新 entry，并把插值一次走完（fade 走完 = 目标值）
  const strengthAt = (d) => {
    const en = {};
    let v = 0;
    for (let i = 0; i < 400; i++) {
      en.ringAt = undefined;                 // 强制每次都重新探测
      en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05;   // 喂一个稳定的 dt，让插值收敛
      v = fn.call({}, tower, en, mkDeps(d), null);
    }
    return v;
  };

  T('敌人在 射程+50（外圈）→ 0（刚好不显示）', strengthAt(RANGE + 50) < 0.02);
  T('敌人在 射程+60（外圈之外）→ 0', strengthAt(RANGE + 60) === 0);
  T('敌人在 射程+10（内圈）→ 1（完全显示）', strengthAt(RANGE + 10) > 0.98);
  T('敌人在 射程内 → 1（完全显示）', strengthAt(RANGE - 50) > 0.98);
  T('射程+30（正中间）→ 约 0.5', Math.abs(strengthAt(RANGE + 30) - 0.5) < 0.06);
  const a = strengthAt(RANGE + 45), b = strengthAt(RANGE + 35), c = strengthAt(RANGE + 15);
  T('强度随距离单调递增（越近越亮）', a < b && b < c);
  T('没有敌人 → 0', strengthAt(null) === 0);

  // 选中恒为完全显示 —— 选中是明确的意图，不该被距离打折
  {
    const en = {};
    T('选中的塔恒为 1（即使一个敌人都没有）',
      fn.call({}, tower, en, mkDeps(null), 1) === 1);
  }
  // 己方单位不算"有敌人"
  {
    const deps = {
      attrCalc: { calc: () => ({ attackRange: RANGE }) },
      effects: { getEffects: () => [] },
      entities: { findInRadius: () => [{ id: 3, type: 'melee', pos: { x: RANGE - 10, y: 0 }, _mapFaction: 'blue' }] },
    };
    const en = {};
    let v = 0;
    for (let i = 0; i < 50; i++) { en.ringAt = undefined; en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05; v = fn.call({}, tower, en, deps, null); }
    T('己方小兵不触发射程圈', v === 0);
  }
  // 沙盒（塔无阵营）：任何单位都算敌人，与索敌口径一致
  {
    const neutral = { id: 9, pos: { x: 0, y: 0 } };   // 没有 _mapFaction
    const en = {};
    let v = 0;
    for (let i = 0; i < 400; i++) { en.ringAt = undefined; en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05; v = fn.call({}, neutral, en, mkDeps(RANGE), null); }
    T('沙盒塔（无阵营）任何单位都算敌人', v > 0.98);
  }

  T('always 模式仍可退回常驻（旧行为）', (() => {
    CONFIG.ui.rangeRing.mode = 'always';
    const r = fn.call({}, tower, {}, mkDeps(null), null);
    CONFIG.ui.rangeRing.mode = 'auto';
    return r === 1;
  })());
  T('渐显靠改材质 opacity，不重建网格（否则每次淡入都造几十个材质）',
    /en\.rangeFill\.material\.opacity = .*ringK/.test(src));
  T('探测状态仍只写在渲染层 entry 上（不往实体挂字段）',
    /en\.ringWant/.test(src) && !/e\._ring/.test(src));
}

// ==================== 二、塔灯：强度换算必须落在能看见的量级 ====================
{
  const c = CONFIG.ui.towerLight;
  T('照明半径口径是"射程 + rangeExtra"，且 rangeExtra = 50（用户定稿）', c.rangeExtra === 50);
  T('不再用 rangeMult（那是上一版的 ×1.2）', c.rangeMult === undefined);
  T('衰减指数软编码且 < 2（2 是物理正确但中心过曝/边缘断崖，不是"火柴"感）',
    typeof c.decay === 'number' && c.decay > 1 && c.decay < 2);

  // 这是本次最关键的一条断言。r155+ 的 PointLight.intensity 是【坎德拉】，
  // 地面照度 = intensity / d^decay。第一版写成 0.55×(半径/250) ≈ 0.66，
  // 在 150px 处照度只有 3e-5，而场景方向光是 2.3 —— 差 5 个数量级，画面上完全看不见。
  // 现在的口径：intensity = edgeLux × 半径^decay，于是边缘照度恒等于 edgeLux。
  const intensityFor = (range) => c.edgeLux * Math.pow(range + c.rangeExtra, c.decay);
  const luxAt = (range, d) => intensityFor(range) / Math.pow(d, c.decay);
  for (const range of [195, 250, 400]) {
    const R = range + c.rangeExtra;
    T(`射程 ${range}：半径边缘照度 == edgeLux(${c.edgeLux})`,
      Math.abs(luxAt(range, R) - c.edgeLux) < 1e-9);
    T(`射程 ${range}：坎德拉在千位量级（不是 <1 那种看不见的值）`,
      intensityFor(range) > 100);
  }
  T('边缘照度与场景方向光（≈2.3）同量级可比，不是 1e-5 级',
    c.edgeLux > 0.02 && c.edgeLux < 2.3);
  T('中心有照度上限（decay<2 时中心仍很亮，不夹会糊成死白）',
    typeof c.centerClampLux === 'number' && c.centerClampLux > c.edgeLux);

  const tr = fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8');
  T('实现按 edgeLux × 半径^decay 反推坎德拉', /edgeLux \* Math\.pow\(R, decay\) \* night/.test(tr));
  T('半径按 射程 + rangeExtra', /const R = range \+ extra;/.test(tr));
  T('灯的 decay 从配置来（不再写死 2）', /l\.decay = decay;/.test(tr));
  T('中心照度夹紧真的实现了', /centerLux > clampLux/.test(tr));
  T('昼夜相位走唯一口径 resolveDayPhase（不再自己读 __world.daynight）',
    /resolveDayPhase\(window\.gameTime/.test(tr) && !/ws\.enabled && Number\.isFinite/.test(tr));
  T('灯池大小够覆盖一屏的塔（8 盏时可见塔就有十几座）', c.poolSize >= 16);
  T('够不上灯池的塔有地面辉光兜底', c.glowDecal === true && /_syncTowerGlow/.test(tr));
  T('辉光贴片用 DoubleSide（rotateX(-90°) 会翻绕序，单面材质下整层不显示）',
    /side: THREE\.DoubleSide/.test(tr));
  T('有真光源的塔不再叠贴片（会过曝）', /skip\.has\(e\.id\)/.test(tr));
  T('贴片贴地高度走 MapSystem.heightAt（与单位定高同一查询）',
    /this\.units\?\.mapSystem\?\.heightAt \? this\.units\.mapSystem\.heightAt/.test(tr));
}

// ==================== 三、废墟可选中：三处口径必须一致 ====================
{
  const ui = fs.readFileSync('src/ui/UIManager.js', 'utf8');
  const cc = fs.readFileSync('src/ui/CanvasController.js', 'utf8');
  T('UIManager 有唯一判据 _selectable', /_selectable\(e\) \{[\s\S]{0,200}e\.alive \|\| e\._ruin \|\| e\._respawnAt/.test(ui));
  T('selectEntity 走它', /selectEntity\(id\) \{[\s\S]{0,400}!this\._selectable\(e\)/.test(ui));
  T('updateSelection 也走它（只改一处的话废墟点开后下一帧就被清掉）',
    /updateSelection\(\) \{[\s\S]{0,400}!this\._selectable\(e\)/.test(ui));
  T('已不存在只放行 _respawnAt 的旧判断', !/!e\.alive && !e\._respawnAt/.test(ui));
  T('命中检测与它同口径', /e\.alive \|\| e\._ruin \|\| e\._respawnAt/.test(cc));
}

// ==================== 四、世界 HUD 行序（用户定稿：昼夜 → 熵 → 天气）====================
{
  const html = fs.readFileSync('index.html', 'utf8');
  const order = ['whTimeRow', 'whEntropyRow', 'whWeatherRow'].map(id => html.indexOf(`id="${id}"`));
  T('三行都在', order.every(i => i > 0));
  T('顺序是 昼夜 → 熵 → 天气', order[0] < order[1] && order[1] < order[2]);
  T('熵默认隐藏（关闭时不占位）', /id="whEntropyRow" style="display:none;"/.test(html));
}

console.log(`射程圈/塔灯/废墟点选 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
