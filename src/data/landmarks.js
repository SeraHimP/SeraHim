/**
 * landmarks.js —— 地标摆放规划（纯数据，headless 可测）
 *
 * 审查截图里召唤师峡谷的龙坑/男爵坑完全看不见（坑在河道里，风格化地图又不挖坑，
 * 只剩一片水），基地是一整片空地。地标让玩家一眼认出"这是哪里"：
 *   · 坑：沙色坑底 + 一圈立石，两个缺口——一个朝这个营地出兵的那条路，一个朝反方向。
 *   · 基地广场：每个水晶枢纽脚下一块铺石圆台（同心接缝 + 放射接缝）。
 *
 * 按地图声明开启：`map.landmarks = { pits: true, plazas: true }`，可在里面覆写
 * CONFIG.ui.landmarks 的任何一项。没声明的地图（冰封、水晶之痕……）完全不受影响。
 *
 * 只影响画面，不影响碰撞/寻路。
 */
import { CONFIG } from './Config.js';
import { projectOntoPolyline } from './mapValidate.js';

/** 这张图生效的地标参数：CONFIG.ui.landmarks 基表 → map.landmarks 覆写。未开启返回 null。 */
export function landmarkConfig(map) {
  const decl = map && map.landmarks;
  if (!decl) return null;
  return { ...(CONFIG.ui?.landmarks || {}), ...decl };
}

// 确定性伪随机（与 VegetationLayer.hash 同一思路，这里不 import 渲染层）。
function h01(a, b) {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

/**
 * @param {object} map
 * @param {(name:string)=>({x,y,r}|null)} getPit  MapSystem.getPit（含用户覆写）
 * @returns {{ pits: Array, plazas: Array } | null}
 */
export function landmarkPlan(map, getPit) {
  const L = landmarkConfig(map);
  if (!L) return null;
  const out = { pits: [], plazas: [] };

  if (L.pits) {
    const names = Object.keys(map.pits || {});
    for (const name of names) {
      const pit = (getPit && getPit(name)) || map.pits[name];
      if (!pit || !Number.isFinite(pit.x) || !Number.isFinite(pit.y)) continue;
      const r = (pit.r ?? 150) * (L.pitRadiusScale ?? 1);
      // 缺口方向：这个坑出兵的那条路上离坑心最近的点。找不到就朝地图中心。
      let ang = null;
      for (const camp of map.neutralCamps || []) {
        const sp = (camp.spawnPoints || []).find((s) => s.pitRef === name);
        const lane = sp && (map.lanes || []).find((l) => l.id === sp.laneMatch);
        if (lane && lane.waypoints?.length >= 2) {
          const p = projectOntoPolyline(lane.waypoints, pit.x, pit.y);
          if (p && Number.isFinite(p.x)) { ang = Math.atan2(p.y - pit.y, p.x - pit.x); break; }
        }
      }
      if (ang === null && map.world) ang = Math.atan2(map.world.h / 2 - pit.y, map.world.w / 2 - pit.x);
      const gaps = [ang ?? 0, (ang ?? 0) + Math.PI];
      const gapHalf = (L.pitGapDeg ?? 26) * Math.PI / 180;
      const N = Math.max(3, L.pitStones ?? 16);
      const stones = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const inGap = gaps.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < gapHalf);
        if (inGap) continue;
        const j = h01(i, Math.round(pit.x + pit.y));
        const rr = r * (0.98 + 0.08 * j);
        stones.push({ x: pit.x + Math.cos(a) * rr, y: pit.y + Math.sin(a) * rr,
          size: (L.pitStoneSize ?? 14) * (0.8 + 0.5 * h01(i + 17, Math.round(pit.x))),
          height: (L.pitStoneHeight ?? 26) * (0.75 + 0.5 * h01(i + 31, Math.round(pit.y))),
          rot: h01(i + 53, 7) * Math.PI * 2 });
      }
      out.pits.push({ name, x: pit.x, y: pit.y, r, gaps, stones });
    }
  }

  if (L.plazas) {
    for (const b of map.buildings || []) {
      if (b.tier !== 'nexus_main' || !b.pos) continue;
      out.plazas.push({ faction: b.faction, x: b.pos.x, y: b.pos.y, r: L.plazaRadius ?? 240,
        rings: L.plazaRings ?? 3, spokes: L.plazaSpokes ?? 12 });
    }
  }
  return out;
}

/** 某点是否在任一坑的坑底内（水面遮罩用：坑里不盖水）。 */
export function inPitFloor(plan, x, y, feather = 0.15) {
  if (!plan) return 0;
  let m = 0;
  for (const p of plan.pits) {
    const d = Math.hypot(x - p.x, y - p.y);
    const inner = p.r * (1 - feather);
    if (d <= inner) return 1;
    if (d < p.r) m = Math.max(m, 1 - (d - inner) / (p.r - inner));
  }
  return m;
}
