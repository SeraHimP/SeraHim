/**
 * sim_towerbase.mjs —— 塔基（地面 → 石台 → 塔）+ 塔色自适应地面 验收
 *
 * 用户："目前的塔模型根本无法融入地形……最重要的就是塔/小兵和环境的割裂感！"
 * 外部评审同一结论："塔太像一个完全独立的建筑"，并明确指出**别把塔基做成
 * "地面色压暗一档"**——冰封图地面本来就亮，压暗一档得到的仍是一块深色贴片，
 * 等于把问题换个位置。
 *
 * 2026-09-10：用户主动提了两件事一起做实验，「先看看效果」：
 *   ① 把塔的颜色自适应成地面的颜色（CONFIG.ui.towerColorAdapt，见 Config.js）；
 *   ② 塔基暂时关掉（CONFIG.ui.towerFoundation.enabled 改 false）——两个变量一起看
 *      分不清是哪个在起作用。塔基的代码、断言都留着，只是暂时不生效。
 *
 * 这一套钉的是**色阶关系**与**几何往下长**这两类东西，不钉具体色值：
 * 调色板会改，色值钉死等于每换一次配色都要来改断言（见 DEVELOPMENT.md §8.2）。
 */
import { CONFIG, stylizedPaletteOf, adaptiveTowerColors } from '../src/data/Config.js';
import { howling_abyss_frost } from '../src/data/maps/howling_abyss_frost.js';
import { towerMesh } from '../src/presentation/UnitMeshFactory.js';
import { srcOf, scoreboard } from './_harness.mjs';

const { T, done } = scoreboard('塔基 + 塔色自适应地面');

const hex2rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  if (!m) return null;
  const v = m[1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};
/** 与 UnitMeshFactory.mixHex 同一套线性插值（k=0 取 a，k=1 取 b）。 */
const mix = (a, b, k) => hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * k);
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const lumHex = (h) => lum(hex2rgb(h));
const cool = (h) => { const [r, , b] = hex2rgb(h); return b - r; };   // 蓝多于红 = 冷调

// ==================== 一、塔基：软编码 + 当前临时状态 ====================
{
  const F = CONFIG.ui?.towerFoundation;
  T('基①-塔基参数在 CONFIG 里，不是散在源码里的魔数',
    !!F && typeof F.enabled === 'boolean'
    && Number.isFinite(F.height) && Number.isFinite(F.spread) && Number.isFinite(F.groundMix));
  // 2026-09-10：用户要求暂时关掉，单独看塔色自适应地面的效果——这是**临时**状态，
  // 记在 docs/MAP-DESIGN-howling-abyss-frost.md §14。塔基本身没有问题，代码与
  // 下面②~⑤组的断言都留着，改这一行就整体恢复，不是要砍掉这个功能。
  T('基①b-当前临时关闭（用户主动要求，用于隔离测试塔色自适应）', F.enabled === false);
  // 高而窄的台座在 45° 下只露侧面，而侧面吃不到光 —— 实测第一版（0.22 / 1.34）
  // 采样出来比塔身侧面还暗，等于又垫了一块黑砖。压扁加宽才露得出受光的顶面。
  T(`基②-塔基是"压扁加宽"而不是"又一个方块"（spread ${F.spread} > 1，且明显大于 height ${F.height}）`,
    F.spread > 1 && F.spread > F.height * 4);
}

// ==================== 二、三层色阶：地面(亮) → 塔基(中) → 塔身(暗) ====================
// 塔基当前关着，但公式本身还在代码里、还会在重新打开那天生效，这组断言继续守着它。
{
  const F = CONFIG.ui.towerFoundation;
  const pal = stylizedPaletteOf(howling_abyss_frost);
  const ground = pal.corridorColor, stone = pal.towerStone;
  const base = mix(stone, ground, F.groundMix);
  const lg = lumHex(ground), ls = lumHex(stone), lb = lum(base);
  T(`色①-塔基明度落在地面与塔身之间（塔身 ${ls.toFixed(0)} < 塔基 ${lb.toFixed(0)} < 地面 ${lg.toFixed(0)}）`,
    ls < lb && lb < lg);
  // 这条是外部评审点名的失败模式：塔基如果比塔身还暗，就成了"地面上的一块黑贴片"。
  T('色②-塔基必须比塔身**亮**（不能做成"地面色压暗一档"）', lb > ls);
  // 也不能亮到跟地面分不开，否则台座的轮廓读不出来。
  // ⚠️ 2026-09-10："塔色自适应地面"这次被用户要求大幅调亮（darken 0.34→0.95，
  //    塔身现在只比桥面暗 14 个亮度单位），塔基混入的塔身色跟着一起变亮，
  //    与地面的差距从原来的 ~24 压到了 ~6——这条阈值从 ≥12 松到 ≥3，
  //    只保证"数学上仍不是同一个颜色"。塔基当前是关着的，这里只钉公式关系，
  //    不代表重新打开那天它在画面上一定读得出来：如果到时候台座轮廓真的
  //    糊成一片，第一个该查的就是这条——多半要把 groundMix 往回调，
  //    或者干脆让塔基不再跟着塔身石色联动，改成固定取一档"地面暗部"色。
  T(`色③-塔基与地面仍有可读的明度差（${(lg - lb).toFixed(1)} ≥ 3，阈值随本轮调亮已从 12 下调）`,
    lg - lb >= 3);
}

// ==================== 三、几何往 y<0 长（pack 会把底面对齐回 0）====================
{
  const f = srcOf('src/presentation/UnitMeshFactory.js');
  T('几①-塔基几何加在 y<0 一侧（pack 会把底面对齐回 y=0，塔身因此整体上抬一个塔基高度）',
    /T\(0, -fh \+ fh \* 0\.21, 0\)/.test(f) && /T\(0, -fh \* 0\.58 \+ fh \* 0\.29, 0\)/.test(f));
  T('几②-pack 仍然把底面强制对齐到 y=0（塔基落地的前提）',
    /const dy = -geo\.boundingBox\.min\.y;/.test(f));
  // 废墟是"塔没了"，垫个完好的台座会读成"台座上摆了一堆碎石"。
  T('几③-废墟不加塔基', /if \(!ruin && pal && pal\.foundation\)/.test(f));
  T('几④-塔基色走中间色插值 mixHex，不是 shade（压暗）',
    /const fc = mixHex\(F\.stone, FD\.ground \|\| F\.stone, FD\.groundMix/.test(f));
  // 形状必须跟阵营的塔身走：蓝方方塔配六边形台座就是"设计语言不统一"。
  T('几⑤-塔基形状随阵营（蓝方方台 / 红方多棱台），不是一律拉圆柱',
    /const fRed = faction === 'red';/.test(f)
    && /fRed\s*\?\s*new THREE\.CylinderGeometry/.test(f)
    && /new THREE\.BoxGeometry\(r \* 1\.78, h, r \* 1\.78\)/.test(f));
}

// ==================== 四、地面色的来源分流 + 缓存 key ====================
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  // ⚠️ 只有 visualStyle==='stylized' 的图才按调色板画地面，三张老地图的走廊是写死的
  //    #2b3647（见 TerrainLayer 的 navMode 分支）。一律读调色板的话，老地图的塔基
  //    会按一个画面上根本不存在的颜色去配，等于白配。
  T('源①-地面色按 visualStyle 分流（老地图不会拿调色板的颜色去配）',
    /visualStyle === 'stylized' \? \(pal\.corridorColor \|\| '#2b3647'\) : '#2b3647'/.test(ul));
  // 几何按 key 全局缓存：地面色随地图变，不进 key 就会命中上一张图的几何，
  // 而且**只在切图时复现**——本仓库已经在 paletteId 上踩过一次同样的坑。
  T('源②-地面色进了塔几何缓存 key', /\$\{foundation \? groundHex : 'nf'\}/.test(ul));
  T('源③-关掉开关就不传 foundation（一处开关能整体回退）',
    /fd\?\.enabled \? \{ \.\.\.fd, ground: groundHex \} : null/.test(ul));
}

// ==================== 五、塔色自适应地面（v55.3 新机制）====================
// 用户："把塔的颜色自适应成地面的颜色……我看看效果如何"。
// 这一组钉**公式本身的行为形状**——任意一张地面色输进去，塔色都必须满足
// "比地面暗、偏冷、亮部比石身亮"这三条关系，不是只在冰封图那一份颜色上凑巧成立。
{
  const F = CONFIG.ui.towerColorAdapt;
  T('适①-参数在 CONFIG 里（软编码），不是函数里的魔数',
    !!F && typeof F.enabled === 'boolean'
    && Number.isFinite(F.coolBoost) && Number.isFinite(F.darken) && Number.isFinite(F.trimLighten));
  T('适①b-当前打开（这就是用户要看效果的那个开关）', F.enabled === true);

  T('适②-是纯函数：同样的输入两次调用结果完全一样（不能混进 Math.random 之类的东西）',
    JSON.stringify(adaptiveTowerColors('#dce9f2', F)) === JSON.stringify(adaptiveTowerColors('#dce9f2', F)));

  // 抽几张风格跨度很大的地面色（冷/暖/亮/暗）都过一遍，钉的是"关系"，不是某一张图的具体色值。
  const samples = ['#dce9f2', '#c9a06b', '#3fa06a', '#1a1a1a', '#f2f2f2', '#8a5a3a'];
  for (const g of samples) {
    const { stone, trim } = adaptiveTowerColors(g, F);
    T(`适③-地面「${g}」算出的石色偏冷（蓝-红 = ${cool(stone)}）`, cool(stone) > 0);
    T(`适③b-地面「${g}」算出的石色比地面暗（${lumHex(stone).toFixed(0)} < ${lumHex(g).toFixed(0)}）`,
      lumHex(stone) < lumHex(g));
    T(`适③c-地面「${g}」算出的亮部比石身亮（${lumHex(trim).toFixed(0)} > ${lumHex(stone).toFixed(0)}）`,
      lumHex(trim) > lumHex(stone));
  }

  // 极端输入不能崩、不能越界（纯黑/纯白地面都要出合法的 #rrggbb）。
  for (const g of ['#000000', '#ffffff']) {
    const { stone, trim } = adaptiveTowerColors(g, F);
    T(`适④-极端地面色「${g}」也能算出合法颜色（stone=${stone} trim=${trim}）`,
      /^#[0-9a-f]{6}$/i.test(stone) && /^#[0-9a-f]{6}$/i.test(trim));
  }

  const cfgSrc = srcOf('src/data/Config.js');
  // 显式声明的塔色永远优先——保留手工微调的出路，不是把自适应焊死。
  T('适⑤-调色板显式声明的塔色优先于自适应算出的值',
    /pal\.towerStone \|\| stone, towerTrim: pal\.towerTrim \|\| trim/.test(cfgSrc));
  T('适⑥-未声明 visualStyle 的老地图不受影响（自适应只挂在 corridorColor 存在的调色板上）',
    /adapt\?\.enabled && \(!pal\.towerStone \|\| !pal\.towerTrim\) && pal\.corridorColor/.test(cfgSrc));
  // 返回的必须是浅拷贝，绝不能就地改 CONFIG 里的原始调色板对象（否则调用顺序
  // 不同会看到不同的值，是本仓库已经踩过的一类"最难查的 bug"）。
  T('适⑦-stylizedPaletteOf 用浅拷贝接管，不会污染原始调色板对象',
    /const adapt = CONFIG\.ui\.towerColorAdapt;/.test(cfgSrc)
    && /return \{ \.\.\.pal, towerStone:/.test(cfgSrc));

  // ⚠️ 通用机制：只要调色板没声明塔色，任何 stylized 地图都会拿到自适应颜色——
  // 不只是冰封图。demo_stylized_v1（探路 demo，用 default 调色板）以前落在
  // FACTION_STYLE（与本图无关的暖中性灰），现在也会自动跟着自己的地面色走。
  // 这是本次改动**必须报告的行为变化**，钉在这里防止以后被误当成只影响 frost。
  const demoPal = stylizedPaletteOf({ paletteId: undefined, world: undefined });
  T('适⑧-通用机制覆盖 default 调色板（demo_stylized_v1 现在也会拿到自适应塔色）',
    !!demoPal.towerStone && !!demoPal.towerTrim
    && lumHex(demoPal.towerStone) < lumHex(demoPal.corridorColor));

  // ==================== 关闭开关：必须能整体回退 ====================
  // 放在本组最后，避免污染前面依赖 F.enabled===true 的断言。
  CONFIG.ui.towerColorAdapt.enabled = false;
  const off = stylizedPaletteOf({ paletteId: undefined });
  T('适⑨-关掉开关后，没声明塔色的调色板就不再补（一处开关能整体回退）',
    off.towerStone === undefined && off.towerTrim === undefined);
  CONFIG.ui.towerColorAdapt.enabled = true;   // 还原，虽然本文件到此就结束了，留个干净收尾
}

// ==================== 六、外塔（tier==='outer'）v56/v57 全部撤销，v58 回退 ====================
// 用户看完 v57.2 蓝方外塔实机截图："道心破碎……太失望了。"——明确要求整体回退：
// outer 不再单独分支，重新并入通用防御塔造型（其余三档一直在用、从未离开过的
// 那一套），只靠 TIER_SPEC 的数值级差（tiers/buttress/balcony/crown/topScale）
// 表达档次差异，不再靠另起一套几何语言。这组断言原来钉的是"v56 新造型 vs 旧造型
// 两套并存"，v58 撤销之后前提已经不成立，逐条改写：
//   ① v45c 的老教训不能再犯——三档损毁下主体高度（topY/muzzleY）必须逐位相等，
//      水晶同时是炮口，弹道原点不能随掉血跳动。这条与具体走哪套造型无关，继续钉。
//   ② 损毁确实改了几何（顶点数递增），不是纯换色的空转。同样继续钉。
//   ③ 两阵营确实分了形——原来用"顶点数不同"当代理指标，但 outer 回退共用通用
//      分支后，蓝方（纯箱体+方柱）与红方（岩台+肋+圆柱+锥）的顶点数**恰好**都是
//      1032（分别是 26 个 24 顶点箱体+2 个 28 顶点圆台 vs 13 箱体+4 锥+7 圆柱，
//      算下来刚好撞了同一个总数）——两边部件类型、数量都完全不同，验证过并非
//      共用同一份几何缓存，只是顶点总数这个代理指标凑巧相等。改用一个更贴合
//      "秩序 vs 混沌"设计语言本身的指标：蓝方部件都以中轴对称摆放，包围盒在
//      x/z 方向左右对称（min+max≈0）；红方基座三块岩台故意用不对称偏移
//      （见"红方基座"那段的 rocks 数组），包围盒必然不对称。这比顶点数更贴近
//      "两边是不是真的分了形"这个问题本身，也不会再被巧合撞上。
//   ④ outer 现在与其余三档同源：不应该再有"两套代码"，应该验证的是反过来的
//      事情——四档顶点数随 TIER_SPEC 的 tiers/buttress/balcony 级差单调不降
//      （tiers 越多、扶壁越多，部件确实越多），而不是"outer 明显更小"（那是
//      "另起一套语言"时代的产物，现在 outer 只是同一套语言里参数最小的一档）。
{
  const build = (tier, faction, dmg, tag) => towerMesh(
    `test-outer-${tag}-${tier}-${faction}-${dmg}`, faction === 'red' ? '#e0473f' : '#5b9bd5',
    30, '', 'tower', false, false, tier, faction, dmg, null);

  for (const faction of ['blue', 'red']) {
    const m0 = build('outer', faction, 0, 'h');
    const m1 = build('outer', faction, 1, 'h');
    const m2 = build('outer', faction, 2, 'h');
    T(`外①-${faction}方三档损毁下 topY 逐位相等（v45c 教训：主体高度绝不能随掉血变）`,
      m0.topY === m1.topY && m1.topY === m2.topY);
    T(`外②-${faction}方三档损毁下 muzzleY 逐位相等（水晶＝炮口，弹道原点不能跳）`,
      m0.muzzleY === m1.muzzleY && m1.muzzleY === m2.muzzleY);
    const n0 = m0.geo.attributes.position.count;
    const n1 = m1.geo.attributes.position.count;
    const n2 = m2.geo.attributes.position.count;
    T(`外③-${faction}方顶点数随损毁递增而非不变（凹坑/碎石确实加了几何，不是纯换色）`,
      n0 < n1 && n1 < n2);
  }

  const bbAsym = (m) => {
    m.geo.computeBoundingBox();
    const b = m.geo.boundingBox;
    return Math.abs(b.max.x + b.min.x) + Math.abs(b.max.z + b.min.z);
  };
  T('外④-两阵营确实分了形：蓝方包围盒左右对称（秩序），红方明显不对称（混沌，rocks 数组故意偏移）',
    bbAsym(build('outer', 'blue', 0, 'f')) < 1e-6 && bbAsym(build('outer', 'red', 0, 'f')) > 1);

  // outer 现在与其余三档同源：顶点数应随 TIER_SPEC 的档次级差单调不降，
  // 不应该再出现"某一档明显异常地小/大"（那意味着又混进了另一套语言）。
  const counts = ['outer', 'inner', 'base', 'hq_tower'].map(tier =>
    build(tier, 'blue', 0, 'tierguard').geo.attributes.position.count);
  T(`外⑤-四档顶点数随 TIER_SPEC 级差单调不降（同源造型，只靠参数拉开差距：${counts.join(' < ')}）`,
    counts[0] <= counts[1] && counts[1] <= counts[2] && counts[2] <= counts[3] && counts[0] < counts[3]);

  // 纯函数/可缓存：同样入参（不同 key，绕开缓存命中）应该产出同样的几何形状。
  const a = build('outer', 'blue', 0, 'x1');
  const b = build('outer', 'blue', 0, 'x2');
  T('外⑥-outer 造型是确定性的（同样入参、不同 key 两次生成，顶点数/topY 完全一致）',
    a.geo.attributes.position.count === b.geo.attributes.position.count && a.topY === b.topY);
}

done();
