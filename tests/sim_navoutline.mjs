/**
 * sim_navoutline.mjs —— navgrid 轮廓提取（navOutline.js）+ 陆地厚度（TerrainEdgeLayer）验收
 *
 * 用户："两方基地变成不规则的大陆，中间用桥连接！应该大陆和桥要做出立体感！"
 * 设计文档：docs/MAP-DESIGN-howling-abyss-frost.md §8.2。
 *
 * 这一套钉的是**轮廓提取的行为形状**，不是某张图具体几个顶点 ——
 * 地图形状会改（用户已经要求把基地改成不规则大陆），顶点数必然跟着变，
 * 钉具体数字等于每改一次地图都要来改一次断言。
 */
import { CONFIG } from '../src/data/Config.js';
import { srcOf, scoreboard } from './_harness.mjs';
import { unpackBits, packBits, paintCircle } from '../src/data/navgrid.js';
import { navOutline, traceLoops, simplify, chaikinClosed, signedArea2, perimeter } from '../src/data/navOutline.js';
import { howling_abyss_frost } from '../src/data/maps/howling_abyss_frost.js';

const { T, done } = scoreboard('navgrid 轮廓 + 陆地厚度');

// ==================== 一、纯函数：拿构造出来的图形验，不依赖任何地图 ====================
{
  const n = 64;
  // 一个居中的实心方块：轮廓应该是 1 条环、简化后正好 4 个角
  const sq = new Uint8Array(n * n);
  for (let y = 20; y < 44; y++) for (let x = 16; x < 48; x++) sq[y * n + x] = 1;

  const loops = traceLoops(sq, n);
  T(`纯①-实心方块只有一条边界环（得到 ${loops.length} 条）`, loops.length === 1);
  // 边界是格与格的缝，方块 32×24 格 → 周长 2*(32+24) = 112 段
  T(`纯②-环的顶点数 = 周长格数（${loops[0].length} = 112）`, loops[0].length === 112);

  const o = navOutline(sq, n, 640, { simplifyCells: 1, smoothPasses: 0 });
  T(`纯③-简化后是四个角（得到 ${o[0].pts.length} 个顶点）`, o[0].pts.length === 4);
  // 格 → 世界：cell = 640/64 = 10；方块 x∈[16,48) y∈[20,44) → 世界 [160,480]×[200,440]
  const xs = o[0].pts.map(p => p[0]), ys = o[0].pts.map(p => p[1]);
  T('纯④-世界坐标落在正确位置（格点而不是格中心）',
    Math.min(...xs) === 160 && Math.max(...xs) === 480
    && Math.min(...ys) === 200 && Math.max(...ys) === 440);
  T(`纯⑤-周长换算正确（${o[0].length} = 2*(320+240)）`, Math.abs(o[0].length - 1120) < 1e-6);

  // 带一个洞：应该得到两条环，且洞环与外环旋向相反（靠符号面积就能分内外）
  const holed = sq.slice();
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) holed[y * n + x] = 0;
  const hl = traceLoops(holed, n);
  T(`纯⑥-带洞的图形得到两条环（外环 + 洞，得到 ${hl.length} 条）`, hl.length === 2);
  const signs = hl.map(l => Math.sign(signedArea2(l)));
  T('纯⑦-外环与洞环旋向相反（不用另写包含判定就能分内外）', signs[0] === -signs[1]);

  // 简化：一条锯齿折线必须被压成直线
  const zig = [];
  for (let i = 0; i <= 40; i++) zig.push([i, i % 2]);
  T(`纯⑧-Douglas–Peucker 能把锯齿压成直线（41 → ${simplify(zig, 2).length}）`,
    simplify(zig, 2).length === 2);
  T('纯⑨-容差为 0 时不简化（不是"越简越好"，得能关掉）', simplify(zig, 0).length === 41);

  // Chaikin：顶点翻倍、周长变短（拐角被倒掉）
  const sqPts = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const sm = chaikinClosed(sqPts, 1);
  T('纯⑩-Chaikin 一遍顶点翻倍', sm.length === 8);
  T('纯⑪-Chaikin 之后周长变短（拐角被倒圆）', perimeter(sm) < perimeter(sqPts));
}

// ==================== 二、拿真实的冰封图验：这是崖壁真正要吃的数据 ====================
{
  const map = howling_abyss_frost;
  const g = map.navgrid;
  const bits = unpackBits(g.bits, g.n);
  T('图①-冰封图的 navgrid 解得开', !!bits && bits.length === g.n * g.n);

  const raw = traceLoops(bits, g.n);
  const o = navOutline(bits, g.n, map.world, { simplifyCells: 2.2, smoothPasses: 0 });
  T(`图②-轮廓提取得到至少一条环（${o.length} 条）`, o.length >= 1);

  // ⚠️ 这条钉的就是本轮踩过的坑：第一版用 Moore 邻域"沿格子走"，
  //    环会在细颈处沿原路折返，同一段边走两遍，于是 DP 完全失效
  //   （eps 1.2→4.0，顶点只从 16264 掉到 13166）。换成"沿格缝串环"后才正常。
  //    判据：简化必须把顶点数砍掉至少 90%。
  T(`图③-简化确实生效（${raw[0].length} → ${o[0].pts.length}，砍掉 ≥90%）`,
    o[0].pts.length < raw[0].length * 0.1);

  // 周长量级：桥 ≈ 2460×2 + 两个基地圈 ≈ 3000，总计 7000~9000。
  // 钉量级而不是具体值 —— 地图形状会改。
  T(`图④-周长在合理量级（${o[0].length.toFixed(0)}，期望 5000~12000）`,
    o[0].length > 5000 && o[0].length < 12000);

  // world 写成 { w, h } 也必须能用。踩过：直接 world/n 得到 NaN，
  // 而 NaN 一路传到几何里，表现是"崖壁一块都没有"而不是报错 —— 静默失败最难查。
  T('图⑤-world 写成 { w, h } 时不会算出 NaN',
    Number.isFinite(o[0].length) && o[0].pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
}

// ==================== 三、陆地厚度：声明、挖空、崖壁层的接线 ====================
{
  const te = howling_abyss_frost.terrainEdge;
  T('厚①-冰封图声明了 terrainEdge（通用件靠地图声明启用）', !!te);
  // 崖壁从陆地面往下伸 cliffHeight，深渊面在 -abyssDrop。
  // 前者 ≥ 后者的话崖壁踩不到底，会悬空 —— 这是这两个数唯一的硬约束。
  T(`厚②-abyssDrop(${te.abyssDrop}) > cliffHeight(${te.cliffHeight})，崖壁才踩得到深渊面`,
    te.abyssDrop > te.cliffHeight);

  const tl = srcOf('src/presentation/TerrainLayer.js');
  // 挖空必须按地图声明开启，否则三张老地图会一起变透明。
  T('厚③-地形挖空按 map.terrainEdge 声明开启（老地图不受影响）',
    /const cutout = !!map\.terrainEdge;/.test(tl)
    && /\(cutout && !on\) \? 0 : 255/.test(tl));
  T('厚④-挖空进了地形贴图缓存 key（否则同一张图会命中挖空前的贴图）',
    /map\.terrainEdge \? '#cut' : ''/.test(tl));

  const tr = srcOf('src/presentation/ThreeRenderer.js');
  // 必须用 alphaTest（片元 discard）而不是 transparent：
  // discard 的深度写入是正确的，半透明混合会把 SSAO / 描边的法线深度预渲染搞乱。
  T('厚⑤-地形材质用 alphaTest 而不是 transparent',
    /alphaTest: cutout \? 0\.5 : 0/.test(tr) && !/map: tex, transparent: true/.test(tr));
  T('厚⑥-崖壁层已接进渲染器且随阴影档下发',
    /new TerrainEdgeLayer\(this\.scene\)/.test(tr) && /this\.terrainEdge\?\.setShadowLevel\?\.\(lv\)/.test(tr));

  const el = srcOf('src/presentation/TerrainEdgeLayer.js');
  // 崖壁跟着**看得见的地面**走，不是跟着可走区域走 —— 冰封图故意让两者不同。
  T('厚⑦-崖壁跟随 visualNavgrid（视觉地面），不是 navgrid（可走区域）',
    /map\.visualNavgrid/.test(el));
  // 静态几何必须合并，否则 300+ 个 mesh 的 draw call 顶不住。
  T('厚⑧-崖壁块合并成整块（draw call 回到个位数）', /mergeGeometries\(geos, false\)/.test(el));
  // 位置抖动必须是确定性的：几何进缓存，随机会让画面每次不同。
  T('厚⑨-抖动是确定性伪随机，不用 Math.random', !/Math\.random/.test(el));

  const hd = srcOf('src/presentation/HowlingAbyssDecor.js');
  T('厚⑩-水域装饰随深渊面一起下沉（不沉的话浮冰会悬在水面上方）',
    /waterGroup\.position\.y = -\(map\.terrainEdge\?\.abyssDrop \?\? 0\)/.test(hd));
}

// ==================== 四、老地图不受影响 ====================
{
  const { MAPS } = await import('../src/data/maps/index.js');
  const others = Object.values(MAPS).filter(m => m.id !== 'howling_abyss_frost_v1');
  T(`老①-其余 ${others.length} 张地图都没有声明 terrainEdge（画面逐位不变）`,
    others.every(m => !m.terrainEdge));
}

void CONFIG; void packBits; void paintCircle;
done();
