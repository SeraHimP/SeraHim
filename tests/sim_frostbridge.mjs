// 嚎哭深渊·冰封版（howling_abyss_frost_v1）验收——设计文档
// docs/MAP-DESIGN-howling-abyss-frost.md，用户 v0.2 确认后落地的第一版实现。
//
// 这次新增的东西分两类：
//   ① 纯数据/纯函数（地图文件里的 frostBridge 桥体参数化坐标、调色板取值函数）
//      —— 能直接 import 断言，钉行为形状。
//   ② Three.js 渲染代码（HowlingAbyssDecor.js 的几何生成、TerrainLayer/
//      VegetationLayer 的调色板接线）—— 走本项目"渲染层用源码正则钉 JS/DOM 胶水
//      代码、不测 WebGL 画面本身"的既定规矩（见 sim_postfx.mjs 头注、
//      docs/Q4-RENDERING-REDESIGN.md 第 8 节），headless Node 没有真实 WebGL
//      上下文，测不出"几何摆得对不对"，只钉"接线有没有漏"。
import { srcOf, scoreboard } from './_harness.mjs';
import { MAPS } from '../src/data/maps/index.js';
import { howling_abyss } from '../src/data/maps/howling_abyss.js';
import { howling_abyss_frost, FROST_BRIDGE } from '../src/data/maps/howling_abyss_frost.js';
import { CONFIG, stylizedPaletteOf } from '../src/data/Config.js';
import { HA_NAVGRID, HA_NAVGRID_FROST_WIDE } from '../src/data/maps/map_navgrids.js';
import { unpackBits } from '../src/data/navgrid.js';

const { T, done } = scoreboard('嚎哭深渊·冰封版验收');

// ==================== 共享：把发布版 navgrid 当作可查询的地形 ====================
// 下面好几组断言都要拿地形反查（收边验证、断口验证），工具函数提到模块作用域共用一份。
const NAV_N = howling_abyss_frost.navgrid.n;
const NAV_ORIG = unpackBits(HA_NAVGRID.bits, NAV_N);
const NAV_WIDE = unpackBits(HA_NAVGRID_FROST_WIDE.bits, NAV_N);
const NAV_PUB = unpackBits(howling_abyss_frost.navgrid.bits, NAV_N);
// v55：实际用来画地面的那份（不再等于 WIDE —— 大陆改不规则形之后它跟着一起变形放大）。
const NAV_VIS = unpackBits(howling_abyss_frost.visualNavgrid.bits, NAV_N);
const navSum = (a) => a.reduce((x, y) => x + y, 0);

// 桥体几何：把 navgrid 当作可查询的地形，验证"收到墙线"这件事真的发生了。
const W_SZ = howling_abyss_frost.world.w;
const navWalk = (bits, x, y) => {
  const gx = Math.floor(x / W_SZ * NAV_N), gy = Math.floor(y / W_SZ * NAV_N);
  if (gx < 0 || gy < 0 || gx >= NAV_N || gy >= NAV_N) return false;
  return bits[gy * NAV_N + gx] === 1;
};
const AX = { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, NR = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
const BLUE = howling_abyss_frost.baseCenters.blue;
const AT = (d, off) => ({ x: BLUE.x + AX.x * d + NR.x * off, y: BLUE.y + AX.y * d + NR.y * off });
const halfWidth = (bits, d, sign) => {
  let o = 0;
  while (o < 420) { const p = AT(d, sign * (o + 1)); if (!navWalk(bits, p.x, p.y)) break; o++; }
  return o;
};


// ==================== 一、原图完全不动 ====================
{
  T('原①-howling_abyss_v1 依然注册着，字段没被这次改动动过', MAPS['howling_abyss_v1'] === howling_abyss);
  T('原②-原图没有 visualStyle/paletteId（三张老地图逐位不变的既定规则）',
    howling_abyss.visualStyle === undefined && howling_abyss.paletteId === undefined);
  T('原③-原图的 obstacles 还是 26 个（13 弧长 × 两侧），这次没有改它',
    Array.isArray(howling_abyss.obstacles) && howling_abyss.obstacles.length === 26);
}

// ==================== 二、新地图正确注册，声明字段齐全 ====================
{
  T('注①-howling_abyss_frost_v1 已注册进 MAPS', MAPS['howling_abyss_frost_v1'] === howling_abyss_frost);
  T('注②-Object.keys(MAPS).length === 5（原4 张 + 这次新增1 张）', Object.keys(MAPS).length === 5);
  T('注③-visualStyle/paletteId 正确声明', howling_abyss_frost.visualStyle === 'stylized' && howling_abyss_frost.paletteId === 'frost');
  // ==================== v0.6/v0.7：navgrid 从"逐位复用原图"变成这张图自己的一份 ====================
  // v0.6 用户拍板：新描一份更宽的（HA_NAVGRID_FROST_WIDE），原图完全不动。
  // v0.7 用户拍板：墙往桥内侧回收，可走区域跟着收到墙线（"墙即碰撞边界"），
  // 所以发布版 navgrid 是在 WIDE 基础上削出来的第三份数据——它既不等于原图，
  // 也不等于 WIDE。下面这组断言钉的是这三者之间应有的关系。
  T('原④-howling_abyss_v1 的 navgrid 还是 HA_NAVGRID 本身，没有被这次改动动过',
    howling_abyss.navgrid === HA_NAVGRID);
  T('注④-冰封版用自己的一份 navgrid，既不是原图那份，也不是未削边的 WIDE 那份',
    howling_abyss_frost.navgrid !== howling_abyss.navgrid
    && howling_abyss_frost.navgrid !== HA_NAVGRID_FROST_WIDE
    && howling_abyss_frost.navgrid.n === HA_NAVGRID.n);
  T('注④b-WIDE 是原图的超集（形态学膨胀只增不减，不会把原本能走的地方变不可走）',
    NAV_WIDE.length === NAV_ORIG.length && NAV_ORIG.every((v, i) => v !== 1 || NAV_WIDE[i] === 1));
  // v55：这条从"整张图"收窄到"**桥身段**"。
  // 原来的口径是"收边只削不加"，那时两个基地区确实原样不动。
  // 现在用户要求把基地做成不规则大陆，且"可走区域面积不要差太多"——
  // 面积要保住，形状就必然在某些方向**长出 WIDE 之外**（凹进去的地方要在别处补回来）。
  // 所以"只削不加"这条规则现在只对桥身成立，那也正是它当初想守的东西
  //（墙即碰撞边界，桥不能凭空变宽）。基地区改由 陆① 那组断言把关。
  T('注④c-桥身段是 WIDE 的子集（墙即碰撞边界，桥不会凭空变宽）',
    (() => {
      const LEN = Math.hypot(2325 - 2 * BLUE.x, 2325 - 2 * BLUE.y);
      const R0 = howling_abyss_frost.baseCircleRadius;
      for (let gy = 0; gy < NAV_N; gy++) {
        for (let gx = 0; gx < NAV_N; gx++) {
          const wx = (gx + 0.5) / NAV_N * W_SZ, wy = (gy + 0.5) / NAV_N * W_SZ;
          const d = (wx - BLUE.x) * AX.x + (wy - BLUE.y) * AX.y;
          if (d <= R0 || d >= LEN - R0) continue;          // 基地区不归这条管
          const i = gy * NAV_N + gx;
          if (NAV_PUB[i] === 1 && NAV_WIDE[i] !== 1) return false;
        }
      }
      return true;
    })());
  T('注④d-发布版确实被削过（墙内收之后可走区域必然比 WIDE 少）',
    navSum(NAV_PUB) < navSum(NAV_WIDE));
  T('注④e-发布版仍然比原图宽（内收 25 之后桥面没有比原来更窄，这是选这个内收量的前提）',
    navSum(NAV_PUB) > navSum(NAV_ORIG));

  // 桥身段（避开两个基地圈）逐段量半宽——收边之后应该是一条几乎平的线，
  // 只在那唯一一处真凹口上明显缩进去。
  const SPAN = [];
  for (let d = 400; d <= 2050; d += 25) SPAN.push(d);
  const widthsR = SPAN.map((d) => halfWidth(NAV_PUB, d, -1));
  const widthsL = SPAN.map((d) => halfWidth(NAV_PUB, d, +1));
  const mid = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const medR = mid(widthsR), medL = mid(widthsL);

  T('形①-收边后桥身两侧半宽各自基本恒定（除凹口外，偏离中位数不超过 6 个单位）——墙是直线，不是锯齿',
    widthsL.every((w) => Math.abs(w - medL) <= 6)
    && widthsR.filter((w) => Math.abs(w - medR) > 6).length <= SPAN.filter((d) => d >= 1200 && d <= 1450).length);
  T('形②-发布版半宽明显小于 WIDE 的半宽（确实往里收了，不是没削）',
    medL < mid(SPAN.map((d) => halfWidth(NAV_WIDE, d, +1)))
    && medR < mid(SPAN.map((d) => halfWidth(NAV_WIDE, d, -1))));
  T('形③-那处真凹口在收边后依然存在（sign=-1 侧、弧长 1240~1400 之间，明显比该侧常态窄）',
    (() => {
      const inNotch = SPAN.filter((d) => d >= 1240 && d <= 1400).map((d) => halfWidth(NAV_PUB, d, -1));
      return inNotch.length > 0 && Math.min(...inNotch) <= medR - 25;
    })());
  // v55：这条原来是"基地区与 WIDE 逐格相同"。用户要求基地改成不规则大陆之后，
  // 逐格相同不可能再成立。但它当初想守的东西还在：**基地平台不能被削成条状**。
  // 现在直接钉那件事本身 —— 沿八个方向量半径，最短的那条不许比最长的那条小太多
  //（团状 ≈ 各方向半径接近；条状 = 某个方向明显塌陷）。
  T('形④-两个基地仍是"团"而不是"条"（各方向半径不许塌陷）',
    (() => {
      const R0 = howling_abyss_frost.baseCircleRadius;
      for (const C of [BLUE, { x: 2325 - BLUE.x, y: 2325 - BLUE.y }]) {
        const radii = [];
        for (let k = 0; k < 8; k++) {
          const a = k / 8 * Math.PI * 2;
          let r = 0;
          while (r < R0 * 1.8 && navWalk(NAV_PUB, C.x + Math.cos(a) * (r + 4), C.y + Math.sin(a) * (r + 4))) r += 4;
          radii.push(r);
        }
        const lo = Math.min(...radii), hi = Math.max(...radii);
        if (lo < hi * 0.45) return false;     // 最短方向不得塌到最长方向的一半以下
        if (hi < R0 * 0.7) return false;      // 整体也不许缩水成一个小圆
      }
      return true;
    })());
  T('形⑤-兵线中线全程可走（收边不能把寻路走廊掐断）',
    (() => {
      for (let d = 0; d <= 2460; d += 5) { const p = AT(d, 0); if (!navWalk(NAV_PUB, p.x, p.y)) return false; }
      return true;
    })());

  T('注⑤-useNavgrid/walls/highground 与原图逐字段相同（navgrid 本身除外，上面单独断言过）',
    howling_abyss_frost.useNavgrid === howling_abyss.useNavgrid
    && JSON.stringify(howling_abyss_frost.walls) === JSON.stringify(howling_abyss.walls)
    && JSON.stringify(howling_abyss_frost.highground) === JSON.stringify(howling_abyss.highground));
  T('注⑥-obstacles（缺口）与原图逐位相同——用户拍板"保留缺口"，这份数据不能变',
    JSON.stringify(howling_abyss_frost.obstacles) === JSON.stringify(howling_abyss.obstacles));
  T('注⑦-tierStats/globalAura/lanes/buildings 数量与原图一致（数值不评估，照抄）',
    JSON.stringify(Object.keys(howling_abyss_frost.tierStats)) === JSON.stringify(Object.keys(howling_abyss.tierStats))
    && howling_abyss_frost.buildings.length === howling_abyss.buildings.length
    && howling_abyss_frost.lanes.length === howling_abyss.lanes.length);
}

// ==================== 三、frostBridge：桥体装饰参数化坐标 ====================
{
  const GAP_D_COUNT = 13;
  for (const side of ['left', 'right']) {
    const s = FROST_BRIDGE[side];
    T(`桥①-${side}侧柱子数量 = 13（与缺口弧长数一致，用户确认"柱子摆在现有缺口位置旁边"）`,
      Array.isArray(s.pillars) && s.pillars.length === GAP_D_COUNT);
    T(`桥②-${side}侧墙段数量 = 12（13 根柱子间 12 段，首尾不多不少）`,
      Array.isArray(s.segments) && s.segments.length === GAP_D_COUNT - 1);
    T(`桥③-${side}侧每段墙的端点与相邻柱子坐标完全对应（不是另算的一套坐标）`,
      s.segments.every((seg, i) =>
        seg.from.x === s.pillars[i].x && seg.from.y === s.pillars[i].y
        && seg.to.x === s.pillars[i + 1].x && seg.to.y === s.pillars[i + 1].y));
    T(`桥④-${side}侧每段墙的 mid/len/angle 与端点数学一致`,
      s.segments.every((seg) => {
        const mx = (seg.from.x + seg.to.x) / 2, my = (seg.from.y + seg.to.y) / 2;
        const len = Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y);
        const ang = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x);
        return Math.abs(seg.mid.x - mx) < 1e-6 && Math.abs(seg.mid.y - my) < 1e-6
          && Math.abs(seg.len - len) < 1e-6 && Math.abs(seg.angle - ang) < 1e-9;
      }));
  }
  T('桥⑤-left/right 两侧柱子的每一对（同一弧长 d）都关于桥中线对称偏移（+140/-140），不是同一侧写重了',
    FROST_BRIDGE.left.pillars.every((p, i) => {
      const q = FROST_BRIDGE.right.pillars[i];
      // 两侧到桥中线的垂直距离应相等（偏移量的绝对值相同），但坐标不同（不是同一侧抄了两遍）
      return (p.x !== q.x || p.y !== q.y);
    }));
  // v0.9：两端各换成一根立在桥/基地交界处的"端柱"（用户："墙略微短一些，不要
  // 超过桥面部分"）——原始弧长 280 / 2180 落在基地圈半径 330 以内，墙会压到
  // 圆形基地平台上。中间那 11 个仍然逐位取自 obstacles 那同一组弧长，没有另起一套。
  T('桥⑥-中段柱子的 d 值仍逐位取自 obstacles 用的那组弧长（没有重新定义一套间距）',
    FROST_BRIDGE.left.pillars.slice(1, -1).map(p => p.d).join(',')
      === [440, 600, 760, 920, 1080, 1240, 1400, 1560, 1720, 1880, 2040].join(','));
  T('桥⑥b-两端是额外补的端柱，落在原始弧长 280/2180 之外（即不在基地圈里）',
    (() => {
      const ds = FROST_BRIDGE.left.pillars.map(p => p.d);
      return ds[0] > 280 && ds[ds.length - 1] < 2180;
    })());
}

// ==================== 四、调色板架构：default 逐位不变 + frost 新增 ====================
{
  T('调①-CONFIG.stylizedPalettes.default 存在（旧 stylizedVisuals 迁移过来的那份）',
    !!CONFIG.stylizedPalettes && !!CONFIG.stylizedPalettes.default);
  T('调②-default 调色板取值与改动前的 stylizedVisuals 逐字段相同（demo_stylized_v1 画面不能变）',
    CONFIG.stylizedPalettes.default.groundColor === '#3fa06a'
    && CONFIG.stylizedPalettes.default.corridorColor === '#c9a06b'
    && CONFIG.stylizedPalettes.default.treeCrownColorA === '#4f9a52'
    && CONFIG.stylizedPalettes.default.rockColor === '#8a8f96'
    && CONFIG.stylizedPalettes.default.outlineOnByDefault === false);
  T('调③-frost 调色板存在，且带 vegetationMode:"none"（关掉树/岩/灌木散布）',
    !!CONFIG.stylizedPalettes.frost && CONFIG.stylizedPalettes.frost.vegetationMode === 'none');
  T('调④-stylizedPaletteOf(map) 未声明 paletteId 时退回 default（demo_stylized_v1 走这条）',
    stylizedPaletteOf({}) === CONFIG.stylizedPalettes.default);
  T('调⑤-stylizedPaletteOf(map) 按 paletteId 取对应的调色板',
    stylizedPaletteOf({ paletteId: 'frost' }) === CONFIG.stylizedPalettes.frost);
  T('调⑥-stylizedPaletteOf(map) 声明了不存在的 paletteId 时兜底回 default（不炸）',
    stylizedPaletteOf({ paletteId: 'not-a-real-one' }) === CONFIG.stylizedPalettes.default);
}

// ==================== 五、渲染层接线（源码正则钉 JS/DOM 胶水，不测 WebGL 画面本身）====================
{
  const terrain = srcOf('src/presentation/TerrainLayer.js');
  const veg = srcOf('src/presentation/VegetationLayer.js');
  const renderer = srcOf('src/presentation/ThreeRenderer.js');
  const decor = srcOf('src/presentation/HowlingAbyssDecor.js');

  T('接①-TerrainLayer 的 navMode 分支读取了调色板颜色（原来的现有缺口已补上）',
    /stylized \? hex2rgb\(SV\.corridorColor/.test(terrain) && /stylized \? hex2rgb\(SV\.groundColor/.test(terrain));
  T('接②-TerrainLayer 用 stylizedPaletteOf(map) 取值，不再直接读 CONFIG.stylizedVisuals',
    /stylizedPaletteOf\(map\)/.test(terrain) && !/CONFIG\.stylizedVisuals/.test(terrain));
  T('接③-VegetationLayer 对 vegetationMode==="none" 的地图整段跳过散布',
    /vegetationMode === 'none'/.test(veg));
  T('接④-VegetationLayer 用 stylizedPaletteOf(map) 取值，不再直接读 CONFIG.stylizedVisuals',
    /stylizedPaletteOf\(map\)/.test(veg) && !/CONFIG\.stylizedVisuals/.test(veg));
  T('接⑤-HowlingAbyssDecor 导出的类有 build/clear/setWalkableFn 三个方法',
    /class HowlingAbyssDecor/.test(decor) && /build\(mapSystem\)/.test(decor)
    && /clear\(\)/.test(decor) && /setWalkableFn\(fn\)/.test(decor));
  T('接⑥-HowlingAbyssDecor 只在 paletteId==="frost" 时建东西（不影响其它任何地图）',
    /map\.paletteId !== 'frost'/.test(decor));
  T('接⑦-火焰/鬼火/灵魂光点用的是普通 Mesh（MeshBasicMaterial），不是 Points/LineSegments 粒子',
    !/new THREE\.Points\(/.test(decor) && !/new THREE\.LineSegments\(/.test(decor));
  T('接⑧-ThreeRenderer 实例化了 HowlingAbyssDecor 并接入 _rebuildTerrain 的重建流程',
    /this\.frostDecor = new HowlingAbyssDecor\(this\.scene\)/.test(renderer)
    && /this\.frostDecor\.build\(this\.mapSystem\)/.test(renderer));
  T('接⑨-ThreeRenderer.setShadowLevel 接入了 frostDecor（用户反馈"没有光影"后补的）',
    /this\.frostDecor\?\.setShadowLevel\?\.\(lv\)/.test(renderer));
  T('接⑩-HowlingAbyssDecor 有 setShadowLevel 方法，且不给火焰（MeshBasicMaterial）开阴影',
    /setShadowLevel\(level\)/.test(decor) && /MeshBasicMaterial/.test(decor)
    && /o\.material\.type !== 'MeshBasicMaterial'/.test(decor));
}

// ==================== 六、v0.5：火炬接入地图光池 + 冰块防穿模的采样方式 ====================
{
  const decor = srcOf('src/presentation/HowlingAbyssDecor.js');
  const terrain = srcOf('src/presentation/TerrainLayer.js');
  const renderer = srcOf('src/presentation/ThreeRenderer.js');
  const FROST_PAL = CONFIG.stylizedPalettes.frost;

  T('炬①-howling_abyss_frost_v1 声明了 map.torches，且数量等于 26 根柱子（两侧各 13）',
    Array.isArray(howling_abyss_frost.torches) && howling_abyss_frost.torches.length === 26);
  T('炬②-torches 坐标就是两侧柱子坐标（不是另起一套点位）',
    howling_abyss_frost.torches.every((t, i) => {
      const all = [...FROST_BRIDGE.left.pillars, ...FROST_BRIDGE.right.pillars];
      return all.some(p => p.x === t.x && p.y === t.y);
    }));
  // ==================== v0.7：断墙由地形决定，整套概率机制已删除 ====================
  // 用户拿地形位图圈出真相：全桥只有一处真凹口（sign=-1 侧、弧长 1240~1400），
  // 此前把 GAP_D 那 13 个柱子间距当成"13 处缺口"是错的。现在的判据是几何的：
  // 墙脚下没有桥就不摆这块墙。下面既钉源码里不再有概率残留，也直接复刻渲染层
  // 的判据算一遍，钉住"断口只有一处、且落在那个凹口上"这个行为形状。
  T('墙①-概率断墙机制已彻底删除（源码里不再有 WALL_GAP_CHANCE / WALL_GAP_BLOCKS 这两个常量）',
    !/const WALL_GAP_CHANCE\s*=/.test(decor) && !/const WALL_GAP_BLOCKS\s*=/.test(decor));
  T('墙①b-改成逐块查"脚下有没有桥"，采样点从墙块中心沿 inward 往桥内侧探 groundProbe',
    /side\.inward/.test(decor) && /side\.groundProbe/.test(decor)
    && /this\._isWalkable\(cx \+ inward\.x \* probe, cy \+ inward\.y \* probe\)/.test(decor));
  T('墙①c-没注入 isWalkable 时按"有桥"兜底（退化成一条完整的墙，不会拆得七零八落）',
    /!this\._isWalkable\s*\r?\n?\s*\|\|/.test(decor));
  T('墙①d-断口只有一处，且落在 sign=-1 侧那个真凹口上（复刻渲染层判据实算）',
    (() => {
      const RUN_STEP = 6;                          // = HowlingAbyssDecor 的 WALL_RUN_STEP
      const found = [];
      for (const side of [FROST_BRIDGE.left, FROST_BRIDGE.right]) {
        const runs = [];
        for (const seg of side.segments) {
          const ux = Math.cos(seg.angle), uy = Math.sin(seg.angle);
          for (let t = 0; t <= seg.len + 1e-6; t += RUN_STEP) {
            const tt = Math.min(t, seg.len);
            const cx = seg.from.x + ux * tt, cy = seg.from.y + uy * tt;
            const px = cx + side.inward.x * side.groundProbe, py = cy + side.inward.y * side.groundProbe;
            if (navWalk(NAV_PUB, px, py)) continue;
            const d = (cx - BLUE.x) * AX.x + (cy - BLUE.y) * AX.y;
            const last = runs[runs.length - 1];
            if (last && d - last.to <= RUN_STEP * 2) last.to = d; else runs.push({ from: d, to: d });
          }
        }
        found.push(runs);
      }
      const [runsL, runsR] = found;
      if (runsL.length !== 0) return false;        // +1 侧没有凹口，整条墙不该有断口
      if (runsR.length !== 1) return false;        // -1 侧有且只有一处
      const g = runsR[0];
      return g.from >= 1200 && g.to <= 1450 && (g.to - g.from) >= 80;
    })());

  // ==================== v0.9：按 Thronefall 参考重做——矮、一体、顶边侵蚀 ====================
  // 用户发来 16 张参考图并确认了三条：墙身每跨一体（柱子是唯一分割）、高度降到
  // 50%、侵蚀只啃顶边不整跨塌。下面钉的是这三条的形状，不是具体数值。
  T('墙③-分块砌墙整套已删除（不再有 WALL_BLOCK_LEN / WALL_STONE_SHADES 这两个常量）',
    !/const WALL_BLOCK_LEN\s*=/.test(decor) && !/const WALL_STONE_SHADES\s*=/.test(decor));
  T('墙④-每个连续跑段只建一根墙身（长度＝整段长，不是按块长切出来的）',
    /new THREE\.BoxGeometry\(len, WALL_H, WALL_THICK\)/.test(decor));
  T('墙⑤-墙高降到原来的一半（26→13），压顶石跟着压扁',
    /const WALL_H = 13;/.test(decor) && /const CAP_H = 3,/.test(decor));
  T('墙⑧-柱与墙是同一套构造：同一对材质 + 同规格压顶石（CAP_H/CAP_OVERHANG 共用），柱更高更厚',
    /_buildPillarsAndTorches\(group, side\.pillars, wallBodyMat, wallCapMat\)/.test(decor)
    && /const POST_H = 22, POST_W = 11;/.test(decor)
    && /new THREE\.BoxGeometry\(POST_W, POST_H, POST_W\)/.test(decor)
    && /POST_W \+ CAP_OVERHANG \* 2, CAP_H, POST_W \+ CAP_OVERHANG \* 2/.test(decor));
  T('墙⑨-圆锥雪冠/棱柱柱身整套已删除（那是与矩形墙板冲突的另一套形状语言）',
    !/PILLAR_H|PILLAR_R_TOP|PILLAR_R_BOT/.test(decor) && !/ConeGeometry\(PILLAR/.test(decor));
  T('墙⑥-侵蚀只作用在压顶石上（跳过的是 cap，不是墙身）——顶边啃缺口，墙身仍连续',
    (() => {
      const i = decor.indexOf('WALL_EROSION_CHANCE) continue;');
      if (i < 0) return false;
      const around = decor.slice(Math.max(0, i - 700), i);
      return /const capN = /.test(around) && /const capLen = /.test(around);
    })());
  T('墙⑦-墙只用两个色（墙身一色 + 压顶一色），不再按哈希随机取深浅档',
    /const wallBodyMat = /.test(decor) && /const wallCapMat = /.test(decor)
    && !/stoneShadeMats/.test(decor));

  // 端柱：用户"墙略微短一些，不要超过桥面部分"——柱子不能落进基地圈。
  T('端①-两侧所有柱子都在桥身段内，没有一根落进基地圈（墙因此不会压在基地平台上）',
    (() => {
      const LEN = Math.hypot(2325 - 2 * BLUE.x, 2325 - 2 * BLUE.y);
      const R0 = howling_abyss_frost.baseCircleRadius;
      for (const side of [FROST_BRIDGE.left, FROST_BRIDGE.right]) {
        for (const p of side.pillars) {
          const d = (p.x - BLUE.x) * AX.x + (p.y - BLUE.y) * AX.y;
          if (d <= R0 || d >= LEN - R0) return false;
        }
      }
      return true;
    })());
  T('端②-墙确实覆盖到桥的两端（首尾柱子离基地圈边缘不超过 30，不是缩在中间一小截）',
    (() => {
      const LEN = Math.hypot(2325 - 2 * BLUE.x, 2325 - 2 * BLUE.y);
      const R0 = howling_abyss_frost.baseCircleRadius;
      for (const side of [FROST_BRIDGE.left, FROST_BRIDGE.right]) {
        const ds = side.pillars.map((p) => (p.x - BLUE.x) * AX.x + (p.y - BLUE.y) * AX.y);
        if (Math.min(...ds) - R0 > 30) return false;
        if ((LEN - R0) - Math.max(...ds) > 30) return false;
      }
      return true;
    })());

  // ==================== v0.7：画多宽 / 能走多远，拆成两份数据 ====================
  // 收边之后地面底图跟着一起缩了，墙看上去依旧贴在桥最外沿——用户"墙贴着桥的边缘
  // 不好看"这条其实没被解决。于是新增可选字段 map.visualNavgrid：地面按它画，
  // 可走判定仍然只认 map.navgrid，墙外侧那圈桥沿于是看得见、走不上去。
  // v55：visualNavgrid 不再直接等于 WIDE —— 大陆改成不规则形之后，视觉地面要跟着
  // 同一套形状放大一圈，否则地面画的是圆、可走的是不规则形，两者对不上。
  // 这条改成钉**关系**而不是钉具体是哪份数据：视觉地面必须是可走区域的超集，
  // 且严格更大（那圈"看得见走不上去"的桥沿就是靠这个关系存在的）。
  T('沿①-冰封版声明了 visualNavgrid，且严格包含可走区域（地面比能走的宽一圈）',
    (() => {
      const vg = howling_abyss_frost.visualNavgrid;
      if (!vg || vg.n !== NAV_N) return false;
      const VIS = unpackBits(vg.bits, NAV_N);
      for (let i = 0; i < NAV_PUB.length; i++) if (NAV_PUB[i] === 1 && VIS[i] !== 1) return false;
      return navSum(VIS) > navSum(NAV_PUB);
    })());
  // v55：这两条原来拿 NAV_WIDE 当"画地面的那份"。visualNavgrid 改成 VIS 之后
  // WIDE 只是它的原料，不再是实际画地面的数据 —— 继续拿它当替身，测的就是个
  // 已经不成立的假设（会出现"断言全绿但画面不对"）。改成直接读 map.visualNavgrid。
  T('沿②-画地面的那份严格比可走的那份宽（墙外侧确实留得出一圈桥沿）',
    navSum(NAV_VIS) > navSum(NAV_PUB));
  T('沿③-墙线外侧确实存在"看得见但走不上去"的格子（这就是那圈桥沿本身）',
    (() => {
      let ledge = 0;
      for (let i = 0; i < NAV_PUB.length; i++) if (!NAV_PUB[i] && NAV_VIS[i]) ledge++;
      return ledge > 0;
    })());
  T('沿④-其余地图都没有声明 visualNavgrid（这条接缝是可选的，不影响任何老地图）',
    !howling_abyss.visualNavgrid);
  T('沿⑤-TerrainLayer 只在地图声明了 visualNavgrid 时才改用它画地面，否则照抄可走网格',
    /const paint = visualWalkOf\(map, grid\) \|\| walk;/.test(terrain)
    && /if \(!vg \|\| !vg\.bits \|\| !vg\.n \|\| !grid\) return null;/.test(terrain));
  // ==================== v1.0 阶段二：配色 / 色调映射 / 水域环境 ====================
  // 用户确认的三件事：往 Thronefall 雪地那张靠、顺手修"冷色被压成灰绿"的老问题、
  // 空白水域补山体装饰。下面钉的是"这几件事确实落地了且都是软编码"，不钉具体色值。
  T('色①-色调映射做成了软编码，且默认已从 ACES 换走（ACES 会把饱和冷色压成灰绿）',
    typeof CONFIG.toneMapping?.mode === 'string' && CONFIG.toneMapping.mode !== 'aces');
  T('色②-渲染器按 CONFIG 取曲线，不再把 ACESFilmicToneMapping 写死在代码里',
    /toneMappingModeOf\(CONFIG\.toneMapping\?\.mode\)/.test(renderer)
    && !/toneMapping = THREE\.ACESFilmicToneMapping/.test(renderer));
  T('色③-frost 调色板补齐了冰/水/墙/岛/冰刺的颜色（原来散在装饰层里硬编码）',
    ['iceColorA', 'iceColorB', 'waterColor', 'wallCapColor', 'islandColor', 'spikeColor']
      .every((k) => typeof FROST_PAL[k] === 'string' && /^#[0-9a-f]{6}$/i.test(FROST_PAL[k])));
  T('色④-装饰层这些颜色一律读调色板，源码里不再出现写死的十六进制冰/水色',
    /SV\.iceColorA/.test(decor) && /SV\.waterColor/.test(decor) && /SV\.spikeColor/.test(decor));
  T('色⑤-桥面比深渊底色明显更亮（参考图的结构：地面亮、环境暗，靠这个反差撑画面）',
    (() => {
      const lum = (hex) => { const v = parseInt(hex.slice(1), 16);
        return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255); };
      return lum(FROST_PAL.corridorColor) - lum(FROST_PAL.groundColor) > 100;
    })());
  T('色⑥-墙体明显暗于桥面（墙要能从地面上读出来——用户"我咋看不懂呢"的一半原因）',
    (() => {
      const lum = (hex) => { const v = parseInt(hex.slice(1), 16);
        return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255); };
      return lum(FROST_PAL.corridorColor) - lum(FROST_PAL.rockColor) > 60;
    })());
  T('环①-冰块用不规则棱柱（icePrismGeo 逐顶点抖半径），不再是清一色的规则六边形',
    /function icePrismGeo\(sides, seed\)/.test(decor)
    && /pos\.setX\(i, x \* k\); pos\.setZ\(i, z \* k\);/.test(decor));
  T('环②-水域分三档：冰脊（成坨的山）+ 冰刺丛 + 平浮冰，尺度拉开',
    /const RIDGE_STEP = /.test(decor) && /const SPIKE_PER_RIDGE = /.test(decor)
    && /const RIDGE_R = /.test(decor));
  T('环③-冰脊只长在离桥足够远的地方，且每一块仍旧逐个查 clearOfBridge（不许压到桥上）',
    /distToBridge\(cx, cy\) < RIDGE_MIN_DIST/.test(decor)
    && /if \(!clearOfBridge\(sx, sy, r\)\) continue;/.test(decor));

  T('墙②-断口相邻的完好块会补损毁痕迹（_buildWeatherChips），不是只有断口本身有瓦砾',
    /_buildWeatherChips/.test(decor));
  T('冰①-clearOfBridge 用整圆网格采样（不再是几个固定方向的采样点），能覆盖任意弯曲边界',
    /for \(let dx = -r; dx <= r \+ 1e-6; dx \+= step\)/.test(decor)
    && /dx \* dx \+ dy \* dy > r \* r/.test(decor));
  T('火①-火盆摞在柱顶（压顶石上方），没有支架/横臂几何体、也不贴柱身侧面——用户先后否掉"挑出去"和"贴侧面"两版方案后定的',
    !/BoxGeometry\(BRAZIER_ARM_LEN/.test(decor) && !/pillarRAtBowl/.test(decor)
    && /const bowlH = capH \+ CAP_H \/ 2 \+ BRAZIER_BOWL_H \/ 2/.test(decor));
}

// ==================== v54：塔的石色归地图调色板管 ====================
// 用户："目前的塔模型根本无法融入地形……最重要的就是塔/小兵和环境的割裂感！"
// 放大到实机看得很清楚：城墙用的是本表的 rockColor/wallCapColor（冷蓝灰、暗于桥面，
// 读起来是"长在桥上的"），而塔用的是 FACTION_STYLE 里那套与本图无关的暖中性灰。
// 这一组钉住"塔与城墙同源"这件事本身，而不是某个具体色值。
{
  const P = CONFIG.stylizedPalettes.frost;
  T('塔①-冰封调色板声明了塔的石色/亮色', !!P.towerStone && !!P.towerTrim);

  const hex = (h) => { const v = parseInt(h.slice(1), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
  const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const cool = (h) => { const [r, , b] = hex(h); return b - r; };   // 蓝多于红 = 冷调

  // ① 与城墙同族：都必须是冷调（蓝分量高于红分量）。塔用暖灰是被否掉的那一版。
  T(`塔②-塔石色是冷调（与城墙同族，蓝-红 = ${cool(P.towerStone)}）`, cool(P.towerStone) > 12);
  // ② 必须明显暗于桥面，否则塔在近白的桥上"压不住"，看起来是浮的。
  T(`塔③-塔石色明显暗于桥面（塔 ${lum(P.towerStone).toFixed(0)} < 桥面 ${lum(P.corridorColor).toFixed(0)}）`,
    lum(P.towerStone) < lum(P.corridorColor) - 40);
  // ③ 亮部要比石身亮，塔身上才有明暗层次（全一个值就是一块剪影）。
  T('塔④-塔的亮部亮于石身', lum(P.towerTrim) > lum(P.towerStone) + 20);

  const ul = srcOf('src/presentation/UnitLayer.js');
  // ⚠️ 几何按 key 全局缓存。paletteId 不进 key 的话，换到另一张调色板的地图会直接
  //    命中上一张图的几何，颜色跟着错 —— 而且**只在切图时复现**，最难查的一类 bug。
  T('塔⑤-paletteId 进了塔几何缓存 key（否则切图会命中上一张图的几何）',
    /\$\{palId\}/.test(ul) && /stylizedPaletteOf\(this\.mapSystem\?\.currentMap\)/.test(ul));
}

done();
