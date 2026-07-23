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
import { CONFIG } from '../data/Config.js';

const _terrainCache = new Map();

export function buildTerrainLayer(map) {
  let c = _terrainCache.get(map.id);
  if (c) return c;
  const { w: WW, h: WH } = map.world;
  const S = 0.5; // 半分辨率烘焙（3552² 全尺寸约 50MB，砍到 1/4）
  c = document.createElement('canvas');
  c.width = Math.ceil(WW * S); c.height = Math.ceil(WH * S);
  const g = c.getContext('2d');
  g.scale(S, S);
  const hw = map.walls?.corridorHalfWidth ?? 95;

  // 丛林底（= 墙）
  g.fillStyle = '#151c26';
  g.fillRect(0, 0, WW, WH);
  // 丛林纹理：稀疏亮斑（廉价的"树丛"感）
  g.fillStyle = 'rgba(74,110,87,0.10)';
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 260; i++) {
    const x = rnd() * WW, y = rnd() * WH, r = 14 + rnd() * 30;
    g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
  }

  // 河道（装饰）：沿反对角线的水带。v34：地图可声明 walls.river:false 关闭
  //（嚎哭深渊是冰桥，没有河道——用户 Q补充）。
  if (map.walls?.river !== false) {
    g.strokeStyle = 'rgba(60,120,150,0.35)';
    g.lineWidth = 150;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(WW * 0.12, WH * 0.12); g.lineTo(WW * 0.88, WH * 0.88); g.stroke();
  }

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
  const rBlue = baseRFor('blue', 0, WH), rRed = baseRFor('red', WW, 0);
  const oBlue = openRFor(rBlue), oRed = openRFor(rRed);

  // 墙缘（比走廊宽一圈的亮边）→ 走廊路面。基地区同理两层。
  // 开放区改用 oBlue/oRed（收束段内圈）而不是 rBlue/rRed（外层完整基地圈半径）——
  // 收束段（oBlue~rBlue 之间）不再被开放色覆盖，corridor 墙壁在那一圈保持可见，
  // 高地塔（落在收束段内）的射程圈因此会真实穿过两侧墙壁。
  strokeLanes(hw * 2 + 14, '#43536a');
  fillBase(0, WH, oBlue + 7, '#43536a'); fillBase(WW, 0, oRed + 7, '#43536a');
  strokeLanes(hw * 2, '#2b3647');
  fillBase(0, WH, oBlue, '#2b3647'); fillBase(WW, 0, oRed, '#2b3647');
  // 走廊中心细线（路感）
  strokeLanes(3, 'rgba(246,201,74,0.10)');

  // v36（Q6）：高地门槛线已删除（用户反馈突兀且蓝红不对称）。

  _terrainCache.set(map.id, c);
  return c;
}
