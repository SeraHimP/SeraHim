/**
 * torchSites.js —— 路边火炬的位置（纯数据，无头可测）。
 *
 * 用户："路的两边自带光源（墙上的火炬），然后塔目前就不要自带光源了。"
 * 沿每条兵线每隔一段取一个站位，左右交错；从路边往外找岩壁，找到就把火炬立在崖脚（贴着墙），
 * 找不到（开阔地 / 桥面）就立在路肩。建筑、河道、龙坑附近不放；多条兵线共用的路段不重复放。
 * 参数在 CONFIG.terrain.lights。
 */
import { CONFIG } from './Config.js';

/** @returns [{ x, y, h, wall, dx, dy }]  (dx,dy) 指向路中心的单位向量 */
export function placeTorches(field, map) {
  const C = CONFIG.terrain?.lights || {}, G = CONFIG.terrain.ground;
  if (C.torches === false) return [];
  const spacing = C.spacing ?? 250, search = C.wallSearch ?? 130, gap = C.minGap ?? 150;
  const out = [];
  const keep = [];
  for (const b of (map.buildings || [])) { const p = b.pos || b; if (Number.isFinite(p?.x)) keep.push({ x: p.x, y: p.y, r: C.buildingClear ?? 95 }); }
  for (const p of field.pits) keep.push({ x: p.x, y: p.y, r: p.r * 1.5 });
  const blocked = (x, y) => { for (const k of keep) if ((k.x - x) ** 2 + (k.y - y) ** 2 < k.r * k.r) return true; return false; };
  const tooClose = (x, y) => { for (const o of out) if ((o.x - x) ** 2 + (o.y - y) ** 2 < gap * gap) return true; return false; };
  const drop = field.mode === 'drop';
  for (const lane of (map.lanes || [])) {
    const wps = lane.waypoints || [];
    let acc = 0, k = 0;
    for (let i = 0; i < wps.length - 1; i++) {
      const ax = wps[i].x, ay = wps[i].y, bx = wps[i + 1].x, by = wps[i + 1].y;
      const L = Math.hypot(bx - ax, by - ay); if (L < 1e-6) continue;
      const tx = (bx - ax) / L, ty = (by - ay) / L;
      // 半个间距一个站位，左右交错：左侧在整数站位，右侧在半站位
      for (let s = Math.ceil((acc - 1e-6) / (spacing / 2)) * (spacing / 2); s < acc + L; s += spacing / 2) {
        const t = s - acc, px = ax + tx * t, py = ay + ty * t;
        const side = (k++ % 2) ? 1 : -1, nx = -ty * side, ny = tx * side;
        let d = G.pathHalf + (C.shoulder ?? 16), wall = false;
        for (let q = G.pathHalf * 0.7; q <= G.pathHalf + search; q += 5) {
          const sd = field.sdAt(px + nx * q, py + ny * q);
          if (sd > -5) { d = q - (drop ? 14 : 7); wall = !drop; break; }
        }
        const x = px + nx * d, y = py + ny * d;
        if (x < 20 || y < 20 || x > field.W - 20 || y > field.H - 20) continue;
        if (field.sdAt(x, y) > -3) continue;                       // 落点必须是能站的地面
        if (field.laneAt(x, y) < G.pathHalf * 0.7) continue;        // 别的兵线正好从这儿过（交汇处）：不立在路中间
        if (field.riverAt(x, y) > 0.06 || blocked(x, y) || tooClose(x, y)) continue;
        out.push({ x, y, h: field.heightAt(x, y), wall, dx: -nx, dy: -ny });
      }
      acc += L;
    }
  }
  return out;
}

/**
 * 静态 + 动态局部光的清单 → 光照图要画的圆。
 * @param torches placeTorches 的结果
 * @param crystals [{ x, y, faction, kind }]  活着的建筑（kind: tower / orb / gem）
 */
export function localLightList(torches, crystals, theme) {
  const C = CONFIG.terrain?.lights || {}, T = theme?.torch || {};
  const out = [];
  for (const t of torches) out.push({ x: t.x + t.dx * 6, y: t.y + t.dy * 6, r: C.torchRadius ?? 215, color: T.light || C.torchColor || '#ffb066', k: C.torchK ?? 1 });
  const cr = C.crystal || {};
  for (const c of (crystals || [])) {
    const col = c.faction === 'blue' ? (cr.blue || '#6cb4ff') : c.faction === 'red' ? (cr.red || '#ff6a55') : (cr.neutral || '#d8dce6');
    const r = c.kind === 'gem' ? (cr.gemRadius ?? 420) : c.kind === 'orb' ? (cr.orbRadius ?? 260) : (cr.towerRadius ?? 190);
    out.push({ x: c.x, y: c.y, r, color: col, k: cr.k ?? 0.9 });
  }
  return out;
}
