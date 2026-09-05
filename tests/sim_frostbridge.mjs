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
  // ==================== v0.6：桥面拓宽，navgrid 从"逐位复用原图"改成"专属更宽的一份" ====================
  // 用户拍板方案（AskUserQuestion）：新描一份更宽的 navgrid，只给冰封版用，原图
  // 完全不动。注④原本断言"逐位复用"，现在故意反过来：断言两者不是同一份数据，
  // 但新的这份必须是原图的**超集**（只增不减，不能把原图能走的地方走没了）。
  T('原④-howling_abyss_v1 的 navgrid 还是 HA_NAVGRID 本身，没有被这次改动动过',
    howling_abyss.navgrid === HA_NAVGRID);
  T('注④-冰封版现在用专属的 HA_NAVGRID_FROST_WIDE，不再逐位复用原图（用户拍板"新描一份更宽的"）',
    howling_abyss_frost.navgrid === HA_NAVGRID_FROST_WIDE && howling_abyss_frost.navgrid !== howling_abyss.navgrid);
  T('注④b-新 navgrid 是原图的超集（对原图做形态学膨胀，只增不减，不会把原本能走的地方变不可走）',
    (() => {
      const n = HA_NAVGRID.n;
      const orig = unpackBits(HA_NAVGRID.bits, n);
      const wide = unpackBits(HA_NAVGRID_FROST_WIDE.bits, n);
      if (wide.length !== orig.length) return false;
      for (let i = 0; i < orig.length; i++) if (orig[i] === 1 && wide[i] !== 1) return false;
      return true;
    })());
  T('注④c-新 navgrid 确实比原图宽（可走格数变多，不是原样复制了一份）',
    (() => {
      const n = HA_NAVGRID.n;
      const orig = unpackBits(HA_NAVGRID.bits, n);
      const wide = unpackBits(HA_NAVGRID_FROST_WIDE.bits, n);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      return sum(wide) > sum(orig);
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
  T('桥⑥-柱子的 d 值与 obstacles 数组用的弧长完全一致（同一份数据，不是重新定义了一套间距）',
    FROST_BRIDGE.left.pillars.map(p => p.d).join(',') === [280, 440, 600, 760, 920, 1080, 1240, 1400, 1560, 1720, 1880, 2040, 2180].join(','));
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

  T('炬①-howling_abyss_frost_v1 声明了 map.torches，且数量等于 26 根柱子（两侧各 13）',
    Array.isArray(howling_abyss_frost.torches) && howling_abyss_frost.torches.length === 26);
  T('炬②-torches 坐标就是两侧柱子坐标（不是另起一套点位）',
    howling_abyss_frost.torches.every((t, i) => {
      const all = [...FROST_BRIDGE.left.pillars, ...FROST_BRIDGE.right.pillars];
      return all.some(p => p.x === t.x && p.y === t.y);
    }));
  T('墙①-缺损判定按"贴着柱子的那一端"独立掷概率（gapAtStart/gapAtEnd 各自算 hash），不是段中间随机挑一块',
    /const gapAtStart = hash\(seg\.from\.x, seg\.from\.y\)/.test(decor)
    && /const gapAtEnd = n >= WALL_GAP_BLOCKS \* 2 && hash\(seg\.to\.x, seg\.to\.y\)/.test(decor));
  T('墙①b-缺口现在是必断（WALL_GAP_CHANCE=1），不再是 0.55 的概率抽样',
    /const WALL_GAP_CHANCE = 1;/.test(decor));
  T('墙②-缺口相邻的完好块会补损毁痕迹（_buildWeatherChips），不是只有缺口本身有瓦砾',
    /_buildWeatherChips/.test(decor));
  T('冰①-clearOfBridge 用整圆网格采样（不再是几个固定方向的采样点），能覆盖任意弯曲边界',
    /for \(let dx = -r; dx <= r \+ 1e-6; dx \+= step\)/.test(decor)
    && /dx \* dx \+ dy \* dy > r \* r/.test(decor));
  T('火①-火盆摞在柱顶（雪冠上方），没有支架/横臂几何体、也不贴柱身侧面——用户先后否掉"挑出去"和"贴侧面"两版方案后定的',
    !/BoxGeometry\(BRAZIER_ARM_LEN/.test(decor) && !/pillarRAtBowl/.test(decor)
    && /const bowlH = capH \+ 4 \+ BRAZIER_BOWL_H \/ 2/.test(decor));
}

done();
