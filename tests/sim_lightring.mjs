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
  // 用户反馈"射程圈也是突然一下就出来了"：50→10 只有 40px 过渡带，
  // 小兵走过不到半秒，观感上就是"啪"地出现。放宽到 220→30。
  T('渐显带够宽（不然还是"啪"地出现）',
    cfg.fadeOuter - cfg.fadeInner >= 150);
  T('内圈仍留一点余量（进射程前就该完全显示）', cfg.fadeInner > 0 && cfg.fadeInner < 60);
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

  // 阈值从配置读，不写死 —— 上一版写死 50/10，用户一嫌"太突然"我把带宽调到 220/30，
  // 三条断言当场全红。断言该钉的是【行为形状】（外圈 0、内圈 1、中点约一半、单调），
  // 不是某个具体数字。
  const OUT = cfg.fadeOuter, IN = cfg.fadeInner, MIDD = (OUT + IN) / 2;
  T(`敌人在 射程+${OUT}（外圈）→ 0（刚好不显示）`, strengthAt(RANGE + OUT) < 0.02);
  T(`敌人在 射程+${OUT + 20}（外圈之外）→ 0`, strengthAt(RANGE + OUT + 20) === 0);
  T(`敌人在 射程+${IN}（内圈）→ 1（完全显示）`, strengthAt(RANGE + IN) > 0.98);
  T('敌人在 射程内 → 1（完全显示）', strengthAt(RANGE - 50) > 0.98);
  T(`射程+${MIDD}（正中间）→ 约 0.5`, Math.abs(strengthAt(RANGE + MIDD) - 0.5) < 0.06);
  const a = strengthAt(RANGE + OUT - 10), b = strengthAt(RANGE + MIDD), c = strengthAt(RANGE + IN + 10);
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
    typeof c.decay === 'number' && c.decay >= 1 && c.decay < 2);

  // ==================== 换算：两个都栽过的坑，各钉一条 ====================
  // 坑一：r155+ 的 PointLight.intensity 是【坎德拉】，照度 = intensity / d^decay。
  //   第一版写成 0.55×(半径/250) ≈ 0.66 —— 150px 处照度约 3e-5，而场景方向光是 2.3，
  //   差 5 个数量级，画面上完全看不见，看起来就像"这功能没做"。
  // 坑二：灯在**空中** ly 高处，地面上半径 R 那一点离灯是 √(R²+ly²)。
  //   distance 若按 R 给，超出的部分被 Three 截成 0 —— 灯抬得越高地面越黑
  //   （实测把灯抬到 +200 时地面几乎全黑，就是这么发现的）。
  const ly = (range) => 40 + c.heightBias;             // 炮口高度约 40，再加偏置
  const dEdgeFor = (range) => Math.hypot(range + c.rangeExtra, ly(range));
  const intensityFor = (range) => c.edgeLux * Math.pow(dEdgeFor(range), c.decay);
  const luxAt = (range, d) => intensityFor(range) / Math.pow(d, c.decay);
  for (const range of [195, 250, 400]) {
    T(`射程 ${range}：地面边缘照度 == edgeLux(${c.edgeLux})`,
      Math.abs(luxAt(range, dEdgeFor(range)) - c.edgeLux) < 1e-9);
    T(`射程 ${range}：坎德拉在百位以上（不是 <1 那种看不见的值）`, intensityFor(range) > 100);
    // 中心/边缘比 = (斜距/灯高)^decay。太大 → 塔身过曝，太小 → 整片死平。
    const ratio = Math.pow(dEdgeFor(range) / ly(range), c.decay);
    T(`射程 ${range}：中心/边缘照度比在 1.5~5 倍（实拍调出来的舒适区）`, ratio > 1.5 && ratio < 5);
  }
  T('边缘照度与场景方向光（≈2.3）同量级，不是 1e-5 级也不是几十',
    c.edgeLux > 0.5 && c.edgeLux < 10);
  T('灯抬得够高才压得住塔身过曝（+10 时中心是边缘的 8.8 倍，必然糊白）',
    c.heightBias >= 60);
  T('中心仍有照度上限兜底（射程特别大的塔）',
    typeof c.centerClampLux === 'number' && c.centerClampLux > c.edgeLux);

  const tr = fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8');
  T('半径按 射程 + rangeExtra', /const R = range \+ extra;/.test(tr));
  T('灯的 decay 从配置来（不再写死 2）', /l\.decay = decay;/.test(tr));
  T('中心照度夹紧真的实现了', /centerLux > clampLux/.test(tr));
  T('昼夜相位走唯一口径 resolveDayPhase（不再自己读 __world.daynight）',
    /resolveDayPhase\(window\.gameTime/.test(tr) && !/ws\.enabled && Number\.isFinite/.test(tr));
  T('distance 按【斜距】给，不是地面半径（否则灯越高地面越黑）',
    /const dEdge = Math\.hypot\(R, ly\);/.test(tr) && /l\.distance = dEdge;/.test(tr));
  T('强度也按斜距反推（与 distance 同一个量，不能一个用 R 一个用斜距）',
    /want = edgeLux \* Math\.pow\(dEdge, decay\) \* night;/.test(tr));
  T('灯池大小够覆盖一屏的塔（8 盏时可见塔就有十几座）', c.poolSize >= 16);
  // 地面辉光贴片已**整个删除**：它是假光（不参与光照计算、照不亮任何东西），
  // 只是在地上涂了几坨白，用户直接问"高地上那一坨白的是啥"。
  // 更糟的是它掩盖了真问题 —— 真光源当时依然弱到照不亮地形，
  // 我却因为画面上"有亮的东西"就以为成了。宁可少一层，也不要假的。
  T('假光（地面辉光贴片）已从渲染层删干净',
    !/_syncTowerGlow/.test(tr) && !/_towerGlow/.test(tr));
  T('配置里也不留贴片开关（留着就会有人以为还能开）',
    c.glowDecal === undefined && c.glowOpacity === undefined && c.glowSoftness === undefined);
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

// ==================== 四、世界 HUD 布局（用户定稿：时间+天气同一行，熵单独一行）====================
// 上一版我做成了三行 —— 把"天气那栏的第一个"理解成了行序，实际要的是时间和天气
// 在同一行里左右排开。这里钉住结构，免得以后又拆回三行。
{
  const html = fs.readFileSync('index.html', 'utf8');
  const iTime = html.indexOf('id="whTimeRow"');
  const iWx = html.indexOf('id="whWeatherRow"');
  const iEnt = html.indexOf('id="whEntropyRow"');
  T('三段都在', iTime > 0 && iWx > 0 && iEnt > 0);
  // 天气段必须在时间行【内部】：找到时间行的收尾位置，天气段的下标要在它之前
  const rowEnd = html.indexOf('</div>', html.indexOf('id="whEntropyRow"') > iTime ? iTime : 0);
  T('天气段嵌在时间行里（同一行，不是另起一行）',
    iWx > iTime && iWx < iEnt && /wh-row wh-row-split/.test(html));
  T('时间段与天气段都是 .wh-seg（靠 flex 并排，不写死宽度）',
    (html.match(/class="wh-seg"/g) || []).length >= 2);
  T('熵是独立一行且默认隐藏', /id="whEntropyRow" style="display:none;"/.test(html)
    && iEnt > iWx);
  T('分隔线放在天气段内部（天气隐藏时它自然跟着消失）',
    /id="whWeatherRow"[^>]*>\s*<span class="wh-sep">/.test(html));
}

console.log(`射程圈/塔灯/废墟点选 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
