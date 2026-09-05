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

// ==================== 五、不规则大陆：形状变了，但玩法量不许变 ====================
// 用户定稿："**也改可走区域**，但是不要影响游戏平衡，就是**可走区域面积不要差太多**"、
//          "**桥不要收窄**"。
// 所以这一组钉的全是"玩法量没被改坏"，不是形状本身长什么样（形状还会调）。
{
  const map = howling_abyss_frost;
  const g = map.navgrid;
  const bits = unpackBits(g.bits, g.n);
  const N = g.n, W = map.world.w, cell = W / N;
  const walkAt = (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    return gx >= 0 && gy >= 0 && gx < N && gy < N && bits[gy * N + gx] === 1;
  };

  // ① 面积：形状换成不规则多边形，但可走格数必须基本不变。
  //    实现上不是靠手调系数，是**二分标定**到原图实测的格数（见地图文件的注释）——
  //    这条断言就是那个标定的守门员。
  let count = 0;
  for (const v of bits) count += v;
  T(`陆①-可走格数与原图基本一致（${count}，容差 2%）`,
    Math.abs(count - 18427) / 18427 < 0.02);

  // ② 连通：形状凹进去太多会把大陆和桥切断，寻路直接废掉。
  //    BFS 一遍，要求"能从蓝方枢纽走到红方枢纽"且"没有孤岛"。
  const gi = (x, y) => Math.floor(y / cell) * N + Math.floor(x / cell);
  const start = gi(292, 2033), goal = gi(2033, 292);
  const seen = new Uint8Array(N * N);
  const q = [start]; seen[start] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], cx = c % N, cy = (c / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const k = ny * N + nx;
      if (seen[k] || !bits[k]) continue;
      seen[k] = 1; q.push(k);
    }
  }
  T('陆②-蓝方枢纽能走到红方枢纽（大陆与桥没被切断）', seen[goal] === 1);
  T(`陆③-没有孤岛（连通区域 ${q.length} = 全部可走格 ${count}）`, q.length === count);

  // ③ 所有建筑仍站在可走格上。塔被挤到不可走格上的话，攻击/寻路都会出怪事。
  const off = map.buildings.filter(b => !walkAt(b.pos.x, b.pos.y));
  T(`建①-12 座建筑全部落在可走格上（越界 ${off.length}）`, off.length === 0);

  // ④ 兵线端点仍可走。
  const wps = map.lanes.flatMap(l => l.waypoints);
  T('兵①-兵线路点全部落在可走格上', wps.every(w => walkAt(w.x, w.y)));

  // ⑤ 桥没被收窄（用户："桥不要收窄"）。量桥中点的横向可走宽度。
  const mid = { x: (292 + 2033) / 2, y: (2033 + 292) / 2 };
  const ux = (2033 - 292), uy = (292 - 2033);
  const L = Math.hypot(ux, uy), nx = -uy / L, ny = ux / L;   // 桥的法向
  let width = 0;
  for (let t = -400; t <= 400; t += 2) if (walkAt(mid.x + nx * t, mid.y + ny * t)) width += 2;
  T(`桥①-桥中点的可走宽度未被收窄（${width}，期望 ≥ 300）`, width >= 300);
}

void CONFIG; void packBits; void paintCircle;
done();
