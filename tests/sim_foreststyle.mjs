// 森林风格（forest palette）验收——用户："召唤师峡谷是森林风格。"
//
// 背景：召唤师峡谷是本项目第一张 useNavgrid:true 且真正走风格化渲染分支的老地图。
// 之前唯一走 visualStyle:'stylized' 的两张图各自代表不同的地形模型：
//   demo_stylized_v1 —— 简单走廊模型（单路，corridorHalfWidth 就是"能不能走"）；
//   howling_abyss_frost_v1 —— navgrid 驱动，但可走区=桥（单一颜色），不可走区=水，
//     没有"可走区域内部还要再分两种颜色"这回事。
// 召唤师峡谷不一样：navgrid 里"可走"同时包含兵线走廊**和**野区（LoL 里野区本身
// 就能走），如果直接照抄旧逻辑，整张可走区域会变成同一个颜色、野区植被撒不出来
// （原有判据是"只在不可走区域长树"）——这是这次新增 jungleColor/vegetationMode:
// 'jungle' 机制要解决的问题。
//
// 分两类断言：
//   ① 纯数据/纯函数（调色板字段、nearestLaneDist 几何、地图声明）—— 直接 import 断言；
//   ② TerrainLayer/VegetationLayer 的接线（Three.js 渲染代码）—— 走本项目"渲染层
//      用源码正则钉 JS/DOM 胶水代码、不测 WebGL 画面本身"的既定规矩
//      （见 sim_frostbridge.mjs 头注、sim_postfx.mjs 头注）。
import { srcOf, scoreboard } from './_harness.mjs';
import { CONFIG, stylizedPaletteOf } from '../src/data/Config.js';
import { summoners_rift, WORLD_SIZE } from '../src/data/maps/summoners_rift.js';
import { SR_NAVGRID } from '../src/data/maps/sr_navgrid.js';
import { nearestLaneDist } from '../src/data/mapValidate.js';
import { unpackBits } from '../src/data/navgrid.js';

const { T, done } = scoreboard('森林风格（forest palette）验收');

// ==================== 一、forest 调色板：纯数据 ====================
{
  const F = CONFIG.stylizedPalettes.forest;
  T('调①-forest 调色板存在，且不与 default/frost 共用引用（互相独立可改）',
    !!F && F !== CONFIG.stylizedPalettes.default && F !== CONFIG.stylizedPalettes.frost);
  T('调②-forest 声明了 jungleColor（触发"走廊/野区二分"的开关字段）',
    typeof F.jungleColor === 'string' && /^#[0-9a-f]{6}$/i.test(F.jungleColor));
  T('调③-forest 声明 vegetationMode:"jungle"（不是 default 的隐式无值，也不是 frost 的 "none"）',
    F.vegetationMode === 'jungle');
  T('调④-forest 的 jungleColor 与 corridorColor 确实是两个不同的颜色（不然二分没有意义）',
    F.jungleColor.toLowerCase() !== F.corridorColor.toLowerCase());
  T('调⑤-forest 声明了 wallCapColor（"石头+金色"里的金色，供以后墙体装饰用）',
    typeof F.wallCapColor === 'string');
  T('调⑥-stylizedPaletteOf 认得 paletteId:"forest"（不会被兜底成 default）',
    stylizedPaletteOf({ paletteId: 'forest' }).jungleColor === F.jungleColor);
}

// ==================== 二、summoners_rift：地图声明 ====================
{
  T('图①-召唤师峡谷声明了 visualStyle:"stylized"（接入风格化渲染分支）',
    summoners_rift.visualStyle === 'stylized');
  T('图②-召唤师峡谷声明了 paletteId:"forest"',
    summoners_rift.paletteId === 'forest');
  T('图③-召唤师峡谷仍然是 useNavgrid:true（森林风格没有改动物理地形/仿真）',
    summoners_rift.useNavgrid === true);
  T('图④-召唤师峡谷仍然声明 lanes（jungleColor 二分要读它算兵线距离）',
    Array.isArray(summoners_rift.lanes) && summoners_rift.lanes.length === 3);
}

// ==================== 三、composeMap 字段收录 ====================
{
  const { TERRAIN_FIELDS, CONFIG_FIELDS } = await import('../src/data/mapComposition.js');
  T('拼①-visualStyle/paletteId 已收录进 CONFIG_FIELDS（否则 composeMap 会悄悄丢掉这两个字段）',
    CONFIG_FIELDS.includes('visualStyle') && CONFIG_FIELDS.includes('paletteId'));
  T('拼②-两个字段没有重复出现在 TERRAIN_FIELDS 里（一个字段只能属于一边）',
    !TERRAIN_FIELDS.includes('visualStyle') && !TERRAIN_FIELDS.includes('paletteId'));
}

// ==================== 四、nearestLaneDist：几何行为（真实数据，不是玩具坐标）====================
{
  const lane0 = summoners_rift.lanes[0];
  const wp0 = lane0.waypoints[0];
  T('几①-兵线路点自身到"最近兵线"的距离≈0（路点当然落在自己的兵线上）',
    nearestLaneDist(summoners_rift, wp0.x, wp0.y) < 1e-6);
  T('几②-没有声明 lanes 的地图返回 Infinity（调用方必须自己先判断 map.lanes 是否存在）',
    nearestLaneDist({ lanes: undefined }, 0, 0) === Infinity);
}

// ==================== 五、真实 navgrid 上抽样验证"走廊/野区二分"确实读出两类点 ====================
// 不测 Three.js 画面本身，但可以拿 nearestLaneDist + 真实 navgrid 位图自己复算一遍
// TerrainLayer 里那段分类逻辑要做的事，验证"至少存在被分成两类的真实格子"，
// 不是"halfWidth 设太大/太小导致全图都判成同一类"这种退化情况。
//
// ⚠️ summoners_rift 这个导出对象本身**不带** navgrid 字段——MapSystem.js:815
// `this.currentMap.navgrid || SR_NAVGRID` 是运行时兜底成 SR_NAVGRID 的，地图源码
// 里从来没显式写过 `navgrid: SR_NAVGRID`（这是这张图沿用至今的既有写法，不是这次
// 森林风格改动引入的）。这里按同一条兜底规则拿真正生效的那份位图，不是凭空
// 假设 summoners_rift.navgrid 存在。
{
  const g = SR_NAVGRID;
  const bits = unpackBits(g.bits, g.n);
  const cell = WORLD_SIZE / g.n;
  const halfW = summoners_rift.walls.corridorHalfWidth;
  let laneCells = 0, jungleCells = 0, firstJungle = null;
  for (let gy = 0; gy < g.n; gy += 4) {       // 步长 4 抽样，够用且快
    for (let gx = 0; gx < g.n; gx += 4) {
      if (!bits[gy * g.n + gx]) continue;      // 只统计可走格
      const wx = (gx + 0.5) * cell, wy = (gy + 0.5) * cell;
      if (nearestLaneDist(summoners_rift, wx, wy) <= halfW) laneCells++;
      else { jungleCells++; if (!firstJungle) firstJungle = { wx, wy }; }
    }
  }
  T(`格①-真实 navgrid 上抽样确实分出了两类可走格（路 ${laneCells} 格 / 野区 ${jungleCells} 格，不是全 0 或全非 0）`,
    laneCells > 0 && jungleCells > 0);
  T(`格②-抽样命中的野区格确实测得出大于走廊半宽的距离（真实几何自洽，不是分类逻辑本身矛盾）`,
    !!firstJungle && nearestLaneDist(summoners_rift, firstJungle.wx, firstJungle.wy) > halfW);
}

// ==================== 六、TerrainLayer / VegetationLayer 接线（源码正则）====================
{
  const tl = srcOf('src/presentation/TerrainLayer.js');
  T('接①-TerrainLayer 引入了共享的 classifyLaneCells（不再自己复算一份走廊/野区分类）',
    /import \{ classifyLaneCells \} from '\.\.\/data\/mapValidate\.js';/.test(tl));
  T('接②-TerrainLayer 的野区二分只在调色板声明了 jungleColor 时触发（三张老地图/frost 逐位不变）',
    /jungleActive = stylized && !!SV\.jungleColor/.test(tl));
  T('接③-classifyLaneCells 走廊半宽复用 map.walls.corridorHalfWidth（不另开一个新字段）',
    /laneHalfWidth = map\.walls\?\.corridorHalfWidth/.test(srcOf('src/data/mapValidate.js')));

  const veg = srcOf('src/presentation/VegetationLayer.js');
  T('接④-VegetationLayer 引入了共享的 nearestLaneDist',
    /import \{ nearestLaneDist \} from '\.\.\/data\/mapValidate\.js';/.test(veg));
  T('接⑤-VegetationLayer 对 vegetationMode==="jungle" 的地图走"可走+离兵线够远"判据',
    /vegetationMode === 'jungle'/.test(veg) && /if \(jungleMode\)/.test(veg));
  // v58.3：用户反馈"野区里深色一块一块的太丑"——jungleMode 内部拆成两支：
  // 不可走的障碍物内部整片盖森林（复用 default 分支"不可走=森林"的思路，
  // 隐藏裸露的调色板底色），可走的野区一侧仍走原来的"离兵线够远"判据。
  T('接⑥-jungleMode 内部按可走/不可走分成两支，不再是单一判据',
    (() => {
      const start = veg.indexOf('if (jungleMode) {');
      const innerElse = veg.indexOf('} else {', veg.indexOf('if (!walk(x, y)) {', start));
      const outerElse = veg.indexOf('} else {', innerElse + 1);   // 第二个 "} else {" 才是 jungleMode/default 两支的外层分界
      const seg = veg.slice(start, outerElse);
      return /if \(!walk\(x, y\)\) \{/.test(seg) && /nearestLaneDist\(map, x, y\) < laneHalfWidth \+ margin/.test(seg);
    })());
  T('接⑦-jungleMode 障碍物内部（不可走）分支复用与 default 分支相同的"内部/贴边"过滤（walk(x±margin,y)）',
    (() => {
      const start = veg.indexOf('if (!walk(x, y)) {', veg.indexOf('if (jungleMode) {'));
      const end = veg.indexOf('} else {', start);
      return /walk\(x \+ margin, y\) \|\| walk\(x - margin, y\)/.test(veg.slice(start, end));
    })());
}

done();
