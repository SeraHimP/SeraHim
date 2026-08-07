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

// ==================== 一、射程圈：按【时间】渐显渐隐（不再按距离）====================
// 用户定稿：「设置这个必须按照渐显渐隐的方式，而不再是根据单位的距离了，
//            只要出现目标或者是点了，就渐显，消失了就渐隐。」
// 所以这一节测的形状变了：**强度对距离不敏感**（射程内哪个位置都一样），
// 只对"射程内有没有敌人"敏感，且切换时是随时间的一阶滞后。
//
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
  T('按距离插值的两个参数已删干净（留着就会有人以为还能调）',
    cfg.fadeOuter === undefined && cfg.fadeInner === undefined);
  T('滞回也不存在（渐显渐隐本身就是防抖）', cfg.hysteresis === undefined);
  T('渐显/渐隐各有一个时间常数，且渐隐更慢（目标死了不该"啪"地消失）',
    cfg.fadeIn > 0 && cfg.fadeOut > 0 && cfg.fadeOut > cfg.fadeIn);
  T('源码里不再按距离算强度（没有 fadeOuter/fadeInner 的痕迹）',
    !/fadeOuter|fadeInner/.test(src));

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
  // 跑到收敛（每次强制重新探测，喂一个稳定的 dt）
  const settle = (d, selected = null, steps = 400) => {
    const en = {};
    let v = 0;
    for (let i = 0; i < steps; i++) {
      en.ringAt = undefined;
      en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05;
      v = fn.call({}, tower, en, mkDeps(d), selected);
    }
    return v;
  };

  // ---- 形状①：射程内 = 亮，射程外 = 灭，且【与距离无关】 ----
  T('敌人在射程内（贴脸）→ 完全显示', settle(10) > 0.98);
  T('敌人在射程内（边缘内侧）→ 完全显示', settle(RANGE - 5) > 0.98);
  T('射程内不同距离强度一样（不再按距离打折）',
    Math.abs(settle(10) - settle(RANGE - 5)) < 1e-9);
  T('敌人刚出射程 → 灭', settle(RANGE + 5) === 0);
  T('敌人在老远 → 灭（以前 射程+220 就会点亮，现在不会）', settle(RANGE + 220) === 0);
  T('没有敌人 → 灭', settle(null) === 0);

  // ---- 形状②：切换是【随时间】的一阶滞后，不是一帧到位 ----
  {
    const en = {};
    const step = (d, sel) => {
      en.ringAt = undefined;
      en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05;   // 每步 0.05s
      return fn.call({}, tower, en, mkDeps(d), sel);
    };
    const v1 = step(10, null);
    T(`渐显不是一帧到位（第一帧 ${v1.toFixed(3)} 在 0 和 1 之间）`, v1 > 0 && v1 < 0.9);
    const seq = [v1, step(10, null), step(10, null)];
    T('渐显过程单调上升', seq[0] < seq[1] && seq[1] < seq[2]);
    for (let i = 0; i < 200; i++) step(10, null);
    // 敌人消失 → 渐隐，同样不是一帧到 0
    const d1 = step(null, null);
    T(`渐隐不是一帧到 0（第一帧 ${d1.toFixed(3)}）`, d1 > 0.1 && d1 < 1);
    const d2 = step(null, null);
    T('渐隐过程单调下降', d2 < d1);
    for (let i = 0; i < 400; i++) step(null, null);
    T('渐隐最终归零', step(null, null) === 0);
  }

  // ---- 形状③：选中也走渐显（用户："或者是点了，就渐显"）----
  {
    const en = {};
    const step = (sel) => {
      en.ringAt = undefined;
      en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05;
      return fn.call({}, tower, en, mkDeps(null), sel);
    };
    const first = step(1);
    T(`选中的第一帧是渐显的中间值（${first.toFixed(3)}），不是啪一下 1`, first > 0 && first < 0.9);
    for (let i = 0; i < 200; i++) step(1);
    T('选中收敛到完全显示（即使一个敌人都没有）', step(1) === 1);
  }

  // ---- 己方单位不算"有敌人" ----
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
    for (let i = 0; i < 400; i++) { en.ringAt = undefined; en.ringLerpAt = (en.ringLerpAt ?? 0) - 0.05; v = fn.call({}, neutral, en, mkDeps(RANGE - 10), null); }
    T('沙盒塔（无阵营）任何单位都算敌人', v > 0.98);
  }

  T('always 模式仍可退回常驻（旧行为）', (() => {
    CONFIG.ui.rangeRing.mode = 'always';
    const r = fn.call({}, tower, {}, mkDeps(null), null);
    CONFIG.ui.rangeRing.mode = 'auto';
    return r === 1;
  })());
  T('渐显靠改材质 opacity，不重建网格（否则每次淡入都造几十个材质再丢掉）',
    /en\.rangeFill\.material\.opacity = .*ringK/.test(src));
  T('探测状态仍只写在渲染层 entry 上（不往实体挂字段）',
    /en\.ringWant/.test(src) && !/e\._ring/.test(src));

  // ==================== 射程圈贴合地形 ====================
  // 用户："塔的射程圈只要出现了高低差就会被吞掉一部分，修复问题，让射程浮在地形上。"
  T('有 _drapeGeo（逐顶点按 heightAt 抬沉的几何）', /_drapeGeo\(kind, r, w, cx, cz\)/.test(src));
  T('顶点高度真的来自 heightAt', /this\.mapSystem\.heightAt\(x, z\)/.test(src));
  T('取邻域最大值（只取本点会在台阶低侧被插值出来的地面盖住）',
    /Math\.max\(h, raw\(x \+ probe, z\)/.test(src));
  T('几何依赖圆心坐标，所以 key 里带了位置（不能进共享缓存）',
    /const rk = r \+ '\|' \+ color \+ \(drape \? `\|\$\{Math\.round\(x\)\},\$\{Math\.round\(z\)\}` : ''\)/.test(src));
  T('逐塔独有的几何/材质会被真 dispose（不是只摘出场景）',
    /_clearRange\(en\)/.test(src) && /for \(const g of en\.rangeGeo\) g\.dispose\(\)/.test(src)
    && /for \(const m of en\.rangeMat\) m\.dispose\(\)/.test(src));
  T('材质逐塔独有（共享材质下十几座塔共用一份 opacity，渐显会互相踩）',
    /_rangeMat\(color, opacity\)/.test(src) && /en\.rangeMat = \[this\._rangeMat/.test(src));
  T('贴合参数全在配置里（分段数/径向段/探针）',
    typeof cfg.drape === 'object' && cfg.drape.enabled === true
    && cfg.drape.segments >= 24 && cfg.drape.radialSteps >= 4 && cfg.drape.probe > 0);
  T('可以关掉退回平面片（关了就用共享几何，零额外开销）',
    /cfg0\.drape\?\.enabled !== false/.test(src) && /this\._flatGeo\('disc', r\)/.test(src));

  // ---- 真跑一遍 _drapeGeo：形状对不对，靠断言顶点，不靠"源码里有这几个字" ----
  // 同样是把方法从原型上借出来（它只用 CONFIG / THREE / this.mapSystem）。
  {
    const gm = src.match(/_drapeGeo\(kind, r, w, cx, cz\) \{[\s\S]*?\n  \}/);
    T('能定位到 _drapeGeo 实现', !!gm);
    // 最小 THREE 桩：只需要 BufferGeometry / Float32BufferAttribute 能存下顶点
    const THREE = {
      BufferGeometry: class { setAttribute(k, a) { this[k] = a; } setIndex(i) { this.index = i; } },
      Float32BufferAttribute: class { constructor(arr) { this.array = arr; } },
    };
    const drapeFn = new Function('CONFIG', 'THREE', `return function ${gm[0]}`)(CONFIG, THREE);

    // 合成地形：x < 500 平地 0，x > 700 高地 20，中间线性斜坡（和产品里高地/坡道同形状）
    const H = (x) => x < 500 ? 0 : x > 700 ? 20 : (x - 500) / 200 * 20;
    const self = { mapSystem: { heightAt: (x, z) => H(x) } };
    const g = drapeFn.call(self, 'ring', 300, 1, 600, 0);   // 圆心正好在坡中间
    const pos = g.position.array;
    const n = pos.length / 3;
    T(`[贴地] 生成了顶点（${n} 个）`, n > 100);

    let vary = 0, below = 0, maxAbs = 0;
    const h0 = H(600);
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3], y = pos[i * 3 + 1], dz = pos[i * 3 + 2];
      const world = y + h0;                     // 网格摆在 groundY=h0 上
      if (Math.abs(y) > 1e-6) vary++;
      maxAbs = Math.max(maxAbs, Math.abs(y));
      // 关键性质：任何一点都不许沉到该点地面【之下】—— 沉下去就是"被吞掉一部分"
      if (world < H(600 + dx) - 1e-6) below++;
    }
    T('[贴地] 顶点高度确实跟着地形变（不是一张平的面片）', vary > n * 0.5);
    T(`[贴地] 起伏幅度与地形落差同量级（最大 ${maxAbs.toFixed(1)}，坡高 20）`,
      maxAbs > 8 && maxAbs < 40);
    T(`[贴地] 没有任何顶点沉到自己脚下的地面以下（${below} 个）`, below === 0);

    // 反证：把 drape 关掉时用的那种平面片，在同一地形上必然有一半沉进地里
    let flatBelow = 0;
    for (let a = 0; a < 72; a++) {
      const th = a / 72 * Math.PI * 2, dx = Math.cos(th) * 300;
      if (h0 < H(600 + dx) - 1e-6) flatBelow++;
    }
    T(`[贴地·反证] 平面片在同一地形上有 ${flatBelow}/72 个点沉在地下（这就是"被吞掉一部分"）`,
      flatBelow > 20);

    // 台阶：邻域最大值必须让圈在台阶【低侧】提前抬起来，否则地面网格的线性插值会盖住它
    const STEP = (x) => x < 600 ? 0 : 20;
    const self2 = { mapSystem: { heightAt: (x) => STEP(x) } };
    const g2 = drapeFn.call(self2, 'ring', 300, 1, 300, 0);   // 圆心在低地，圈右缘跨过台阶
    const p2 = g2.position.array;
    let lifted = 0;
    for (let i = 0; i < p2.length / 3; i++) {
      const dx = p2[i * 3], y = p2[i * 3 + 1];
      // 台阶低侧（探针范围内）就该已经抬起来了
      if (dx + 300 < 600 && dx + 300 > 600 - (CONFIG.ui.rangeRing.drape.probe ?? 12) && y > 10) lifted++;
    }
    T(`[贴地] 台阶低侧的顶点被邻域最大值提前抬起（${lifted} 个）`, lifted > 0);
  }
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

// ==================== 世界小窗：三条竖排（v44 用户定稿）====================
// 用户："主窗口右上角的天气条，时间条，熵条应该是竖着排列的。"
//
// ⚠️ 这一处**来回改过两次**，如实记下来：
//   v43 我先做成三行 → 用户说要并成一行（我把"天气那栏的第一个"理解成了行序）
//   v44 用户又要三条竖排 → 改回三行
// 所以下面这组断言在 v43 是反着写的。断言随定稿走，不是产品有 bug。
//
// 并排那一版还留了个副作用：天气段被裹在 #whTimeRow 内部，而 CSS 的
// `.wh-row[title]:not(#whTimeRow) { cursor:pointer }` 恰好把它排除了 ——
// "天气可点击"这件事因此没有任何视觉提示，用户报的"天气那个无法点击"就是它。
{
  const html = fs.readFileSync('index.html', 'utf8');
  const iTime = html.indexOf('id="whTimeRow"');
  const iWx = html.indexOf('id="whWeatherRow"');
  const iEnt = html.indexOf('id="whEntropyRow"');
  T('三段都在', iTime > 0 && iWx > 0 && iEnt > 0);
  // v47：三段从"各占一行的色带"改成"一行三个胶囊"（用户："你自己看看左上角那个条好看吗"）。
  // 竖排/横排属于版式，会随观感反复；不能丢的是**三段各自是独立元素**——
  // 一旦谁被裹进谁，被裹的那个就会丢掉自己的 hover/pointer（下面那条断言就是为此存在的）。
  T('三段各自是独立元素（天气不再嵌在时间那一段里）',
    /<div class="wh-chip" id="whTimeRow"/.test(html)
    && /<div class="wh-chip" id="whWeatherRow"/.test(html)
    && /<div class="wh-chip" id="whEntropyRow"/.test(html));
  T('顺序 时间 → 天气 → 熵', iTime < iWx && iWx < iEnt);
  T('熵默认隐藏（关闭时整行不显示）', /id="whEntropyRow" style="display:none;"/.test(html));
  T('天气默认隐藏（天气系统关时不占位）', /id="whWeatherRow" style="display:none;"/.test(html));
  T('旧版式的样式与标记已删干净（留着就是死样式）',
    !/wh-row-split/.test(html) && !/wh-seg/.test(html) && !/\.wh-row/.test(html));
  T('天气段能拿到 pointer 光标（它不再是 #whTimeRow）',
    /\.wh-chip\[title\]:not\(#whTimeRow\) \{ cursor: pointer; \}/.test(html)
    && /id="whWeatherRow"[^>]*title=/.test(html));
}

console.log(`射程圈/塔灯/废墟点选 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
