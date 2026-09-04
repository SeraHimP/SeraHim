/**
 * TerrainLayer.js —— 地形层（墙壁）离屏烘焙
 *
 * 从 CanvasRenderer._terrainLayer 原样抽出（2.5D 迁移第 2 步）。
 * 抽离目的：Three 渲染器要把同一张离屏画布做成 CanvasTexture 贴地面，
 * 不能为此依赖 CanvasRenderer 实例。
 *
 * 【纪律】本次抽离是【纯搬运】：绘制逻辑、常量、缓存命中路径一律未改，
 *   不许在这里顺手做任何"优化"。CanvasRenderer._terrainLayer 现在只是转调。
 * 唯一的差别：缓存从"每个渲染器实例一份"变成模块级共享一份
 *   （全程只有一个 CanvasRenderer 实例，行为等价；两个渲染器共用还省一份内存）。
 *
 * ==================== v33（Q8）：地形层（墙壁）预渲染 ====================
 * 每张地图只烘焙一次（半分辨率离屏画布，绘制时放大）——运行时零开销。
 * 视觉编码：深色丛林 = 墙（不可行走），亮色走廊 = 兵线路面，斜向河道为装饰，
 * 走廊外沿一圈"墙缘"高光，读起来就是 LoL 小地图的结构。
 */
import { CONFIG, stylizedPaletteOf } from '../data/Config.js';
import { baseCircleCenter } from '../data/baseCircle.js';

const _terrainCache = new Map();

/**
 * v51.32：地图编辑器前置重构（阶段二，见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md
 * §2 原则 6）——清掉某张地图缓存的离屏地形画布。
 *
 * 在此之前 `_terrainCache` 是【全程只增不减】的：ThreeRenderer.invalidateTerrain()
 * 只置空 `_terrainMapId` 让渲染器那一层的"同图跳过"守卫失效，但 buildTerrainLayer()
 * 自己这份缓存的 key（map.id 不变）从没变过，于是"渲染器以为在重建"实际拿到的还是
 * 上一次烘焙的旧画布——这条路径目前唯一的调用者（河道可行走开关）之所以没暴露这个
 * 坑，是因为那个开关只影响寻路/isWalkable，不影响 buildTerrainLayer 读的 grid.walk
 * 视觉表现在那条路径上恰好没有变化。地图编辑器的地形笔刷会真的改 navgrid 的可走位，
 * 每一笔都要求这份缓存跟着作废，否则画完地形游戏里看到的还是旧的。
 *
 * 两个 key（有无 '#nav' 后缀）一起删，不假设调用方知道当前地图是不是 navgrid 模式。
 */
export function invalidateTerrainCache(mapId) {
  if (!mapId) return;
  _terrainCache.delete(mapId);
  _terrainCache.delete(mapId + '#nav');
}

/**
 * @param map        地图定义
 * @param grid       WallLayer 的可走网格 { walk, nx, ny }（navgrid 地图才有意义）
 * @param mapSystem  用于取河道强度场（riverFactor）；缺省则不画河
 */
export function buildTerrainLayer(map, grid = null, mapSystem = null) {
  // Q4：navgrid 地图的底图改由【真实可走网格】生成，与走廊模型产出的底图不是一回事，
  // 故缓存键要带上模式，切换时不会拿到上一版。
  const navMode = !!(map.useNavgrid && grid && grid.walk);
  const key = map.id + (navMode ? '#nav' : '');
  let c = _terrainCache.get(key);
  if (c) return c;
  const { w: WW, h: WH } = map.world;
  const S = 0.5; // 半分辨率烘焙（3552² 全尺寸约 50MB，砍到 1/4）
  c = document.createElement('canvas');
  c.width = Math.ceil(WW * S); c.height = Math.ceil(WH * S);
  const g = c.getContext('2d');
  g.scale(S, S);
  const hw = map.walls?.corridorHalfWidth ?? 95;

  // 2026-09-04：风格化地图（见 Config.stylizedPalettes 头注）——地面/走廊直接用
  // 声明的纯色，不叠"稀疏亮斑"这层噪声纹理（实拍截图核对过：Thronefall 的地面
  // 就是一片饱和纯色，没有可见的铺贴纹理）。只影响声明了 visualStyle:'stylized'
  // 的地图，三张老地图这里的颜色/纹理逐位不变。
  const stylized = map.visualStyle === 'stylized';
  const SV = stylizedPaletteOf(map);

  // 丛林底（= 墙）
  g.fillStyle = stylized ? (SV.groundColor || '#151c26') : '#151c26';
  g.fillRect(0, 0, WW, WH);
  if (!stylized) {
    // 丛林纹理：稀疏亮斑（廉价的"树丛"感）
    g.fillStyle = 'rgba(74,110,87,0.10)';
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 260; i++) {
      const x = rnd() * WW, y = rnd() * WH, r = 14 + rnd() * 30;
      g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
    }
  }

  // 河道（装饰）：v34 起地图可声明 walls.river:false 关闭（嚎哭深渊是冰桥，没有河道）。
  // Q5：不再画"整条对角线"，改为逐格采样 MapSystem.riverFactor —— 与水面/河床同一个场，
  // 于是路面处自动没有河色（用户定稿：只有被三路切出来的那两段是河）。
  const drawRiver = (riverAt) => {
    if (map.walls?.river === false || !riverAt) return;
    const STEP = 16;                                  // 世界单位；底图是半分辨率，16 已足够细
    for (let y = 0; y < WH; y += STEP) {
      for (let x = 0; x < WW; x += STEP) {
        const a = riverAt(x + STEP / 2, y + STEP / 2);
        if (a <= 0.01) continue;
        g.fillStyle = `rgba(60,120,150,${(0.35 * a).toFixed(3)})`;
        g.fillRect(x, y, STEP, STEP);
      }
    }
  };
  const riverAt = mapSystem ? ((x, y) => mapSystem.riverFactor(x, y)) : null;

  // ============ Q4：navgrid 地图 —— 底图直接由真实可走网格生成 ============
  // 此前底图是"沿兵线折线描三层粗线"画出来的走廊模型；而地形的真实形状早已换成 navgrid。
  // 两者不重合，最外那层比走廊宽 14px 的亮边（'#43536a'）就在真实路面上留下一圈
  // 【与地形无关的亮线】——正是用户圈出来的"原先的道路边缘标识线"。
  // 现在底图与 navgrid 逐格一致，那圈亮线从源头消失，也不需要再叠加任何描边。
  if (navMode) {
    const { walk, nx, ny } = grid;
    const cell = document.createElement('canvas');
    cell.width = nx; cell.height = ny;
    const cg = cell.getContext('2d');
    const im = cg.createImageData(nx, ny);
    // 2026-09-04：navMode 原来完全没读 stylized/调色板（现有缺口，见
    // docs/MAP-DESIGN-howling-abyss-frost.md 第 4.3 节）——写死的 #2b3647/#151c26
    // 走廊模型和 navgrid 地图共用同一对颜色，非风格化地图逐位不变；风格化地图
    // 改用调色板的 corridorColor（可走）/groundColor（不可走），不再是这两个死值。
    const hex2rgb = (h, fallback) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
      const v = m ? m[1] : fallback;
      return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
    };
    const [corR, corG, corB] = stylized ? hex2rgb(SV.corridorColor, 'c9a06b') : [0x2b, 0x36, 0x47];
    const [gndR, gndG, gndB] = stylized ? hex2rgb(SV.groundColor, '151c26') : [0x15, 0x1c, 0x26];
    for (let k = 0; k < nx * ny; k++) {
      const on = walk[k];
      im.data[k * 4]     = on ? corR : gndR;
      im.data[k * 4 + 1] = on ? corG : gndG;
      im.data[k * 4 + 2] = on ? corB : gndB;
      im.data[k * 4 + 3] = 255;
    }
    cg.putImageData(im, 0, 0);
    g.imageSmoothingEnabled = false;                  // 最近邻：格边界与 navgrid 严格对齐
    g.drawImage(cell, 0, 0, WW, WH);
    g.imageSmoothingEnabled = true;
    drawRiver(riverAt);
    // 阵营底色：基地圈的蓝/红是敌我识别信息（材质合成里靠 CHROMA_KEEP 单独保留），
    // 但只染色不改亮度 —— 用叠加半透明色而不是实心填充，免得又造出一圈新的亮度边界。
    const tintBase = (cx, cy, r, color) => {
      const gr2 = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr2.addColorStop(0, color); gr2.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr2;
      g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fill();
    };
    // 阵营底色的圆心跟着基地圈走（原来写死在两个角上，扭曲丛林的基地不在角上）。
    // 305/326 是相对角点的内缩偏移，改成沿"角点→基地圈心"同向内缩同样的量。
    const bcB = baseCircleCenter(map, 'blue'), bcR = baseCircleCenter(map, 'red');
    tintBase(bcB.x + 305, bcB.y - 326, WW * 0.30, 'rgba(91,155,213,0.20)');
    tintBase(bcR.x - 326, bcR.y + 305, WW * 0.30, 'rgba(224,71,63,0.20)');
    _terrainCache.set(key, c);
    return c;
  }

  drawRiver(riverAt);

  const strokeLanes = (width, color) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const lane of map.lanes) {
      g.beginPath();
      lane.waypoints.forEach((wp, i) => i ? g.lineTo(wp.x, wp.y) : g.moveTo(wp.x, wp.y));
      g.stroke();
    }
  };
  const fillBase = (cx, cy, r, color) => {
    g.fillStyle = color;
    g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fill();
  };
  // 基地区半径：与 MapSystem.getBaseCircleRadius 同一算法（此处离线重算，避免依赖注入时序）
  const HIGHGROUND = new Set(['nexus_main', 'hq_tower', 'nexus_lane', 'base']);
  const bSizes = CONFIG.buildingSizes || {};
  const baseRFor = (faction, cx, cy) => {
    if (map.baseCircleRadius) return map.baseCircleRadius; // v34 Q1：声明值优先（与 MapSystem 同口径）
    let far = 0;
    for (const b of map.buildings || []) {
      if (b.faction !== faction || !HIGHGROUND.has(b.tier)) continue;
      far = Math.max(far, Math.hypot(b.pos.x - cx, b.pos.y - cy) + (bSizes[b.tier] || bSizes.default || 28));
    }
    return far || WW * 0.37;
  };
  // v36（Q6）：开放内圈（baseOpenRadius）——圆内到这个半径才整片开放着色；
  // 未声明时退回旧地图行为（= baseCircleRadius，即无收束段，整圆开放）。
  const openRFor = (r) => map.baseOpenRadius || r;
  const cB = baseCircleCenter(map, 'blue'), cR = baseCircleCenter(map, 'red');
  const rBlue = baseRFor('blue', cB.x, cB.y), rRed = baseRFor('red', cR.x, cR.y);
  const oBlue = openRFor(rBlue), oRed = openRFor(rRed);

  // 墙缘（比走廊宽一圈的亮边）→ 走廊路面。基地区同理两层。
  // 开放区改用 oBlue/oRed（收束段内圈）而不是 rBlue/rRed（外层完整基地圈半径）——
  // 收束段（oBlue~rBlue 之间）不再被开放色覆盖，corridor 墙壁在那一圈保持可见，
  // 高地塔（落在收束段内）的射程圈因此会真实穿过两侧墙壁。
  if (stylized) {
    // 风格化 demo：单色走廊 + 干净边界，不叠边缘高光/中心细线（那两层是"贴图感"，
    // 参照截图里道路就是一条颜色差一档的干净色带）。
    const roadColor = SV.corridorColor || '#c9a06b';
    strokeLanes(hw * 2, roadColor);
    fillBase(cB.x, cB.y, oBlue, roadColor); fillBase(cR.x, cR.y, oRed, roadColor);
  } else {
    strokeLanes(hw * 2 + 14, '#43536a');
    fillBase(cB.x, cB.y, oBlue + 7, '#43536a'); fillBase(cR.x, cR.y, oRed + 7, '#43536a');
    strokeLanes(hw * 2, '#2b3647');
    fillBase(cB.x, cB.y, oBlue, '#2b3647'); fillBase(cR.x, cR.y, oRed, '#2b3647');
    // 走廊中心细线（路感）
    strokeLanes(3, 'rgba(246,201,74,0.10)');
  }

  // v36（Q6）：高地门槛线已删除（用户反馈突兀且蓝红不对称）。

  _terrainCache.set(key, c);
  return c;
}
