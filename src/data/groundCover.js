/**
 * groundCover.js —— 地被（草丛、野花、灌木、芦苇、碎石）的摆放（纯数据，无头可测）。
 *
 * 用户："地图要有呼吸感，要像真正的峡谷一样，有那些装饰品瀑布，植被等等。"
 * 光有草皮贴图和几棵树，野区是一块平整的绿地毯。地被按"这里本来会长什么"来撒：
 *   草丛 tuft    野地上成片地长（一片噪声决定哪里密哪里疏），路面、铺石、建筑脚下不长；
 *   野花 flower  草丛里零星的几片；
 *   灌木 bush    贴着崖脚和树林边缘；
 *   芦苇 reed    河岸的浅水边；
 *   碎石 pebble  路肩和河滩。
 * 全部只是画面：不挡路、不参与碰撞。数量有上限（CONFIG.terrain.cover.max），大图自动变疏。
 */
import { CONFIG } from './Config.js';
import { fbm, hash2 } from './noise.js';

/** @returns {{ tuft:[], flower:[], bush:[], reed:[], pebble:[] }}  每项 { x, y, h, s 大小系数, r 朝向, v 变体 0..1 } */
export function placeGroundCover(field, map, theme) {
  const C = { ...(CONFIG.terrain?.cover || {}), ...(theme?.cover || {}) };
  const out = { tuft: [], flower: [], bush: [], reed: [], pebble: [] };
  if (C.enabled === false) return out;
  const G = CONFIG.terrain.ground, K = CONFIG.terrain.cliff, P = CONFIG.terrain.paving || {};
  const W = field.W, H = field.H, drop = field.mode === 'drop';
  const keep = [];
  for (const b of (map.buildings || [])) { const p = b.pos || b; if (Number.isFinite(p?.x)) keep.push({ x: p.x, y: p.y, r: C.buildingClear ?? 70 }); }
  for (const p of field.pits) keep.push({ x: p.x, y: p.y, r: p.r * 1.08 });
  for (const b of field.bases) keep.push({ x: b.c.x, y: b.c.y, r: Math.min(b.r * (P.baseK ?? 0.5), P.baseMax ?? 430) + 20 });
  const cs = 240, grid = new Map();
  for (const k of keep) for (let gy = Math.floor((k.y - k.r) / cs); gy <= Math.floor((k.y + k.r) / cs); gy++) for (let gx = Math.floor((k.x - k.r) / cs); gx <= Math.floor((k.x + k.r) / cs); gx++) {
    const key = gx + ',' + gy; (grid.get(key) || grid.set(key, []).get(key)).push(k);
  }
  const blocked = (x, y) => { const l = grid.get(Math.floor(x / cs) + ',' + Math.floor(y / cs)); if (l) for (const k of l) if ((k.x - x) ** 2 + (k.y - y) ** 2 < k.r * k.r) return true; return false; };
  // 大图自动变疏：格距按面积放大，总量不超过上限
  const area = W * H, k0 = Math.max(1, Math.sqrt(area / ((C.refSize ?? 3552) ** 2)));
  const step = (C.step ?? 15) * k0;
  const put = (kind, x, y, s, gx, gy) => out[kind].push({ x, y, h: field.heightAt(x, y), s, r: hash2(gx, gy, 71) * Math.PI * 2, v: hash2(gx, gy, 72) });
  for (let gy = 0; gy * step < H; gy++) for (let gx = 0; gx * step < W; gx++) {
    const x = (gx + hash2(gx, gy, 61)) * step, y = (gy + hash2(gx, gy, 62)) * step;
    if (x < 8 || y < 8 || x > W - 8 || y > H - 8) continue;
    const sd = field.sdAt(x, y), rf = field.riverAt(x, y), ld = field.laneAt(x, y), rnd = hash2(gx, gy, 63);
    // 河岸：芦苇（浅水边）和河滩碎石
    if (rf > 0.03) {
      if (sd < -4 && rf > 0.06 && rf < (C.reedBand ?? 0.3) && ld > G.pathHalf + 30 && rnd < (C.reed ?? 0.3) && fbm(x * 0.006, y * 0.006, 2, 77) > 0.48) put('reed', x, y, 0.8 + hash2(gx, gy, 64) * 0.6, gx, gy);
      else if (sd < -2 && rf < 0.5 && rnd > 1 - (C.pebble ?? 0.1)) put('pebble', x, y, 0.7 + hash2(gx, gy, 64) * 1.4, gx, gy);
      continue;
    }
    if (drop) {   // 桥 / 台地：可走面是人工铺的，只在边角撒一点碎石
      if (sd < -3 && sd > -16 && rnd < (C.pebble ?? 0.1) * 0.6 && !blocked(x, y)) put('pebble', x, y, 0.7 + hash2(gx, gy, 64) * 1.2, gx, gy);
      continue;
    }
    if (sd > K.width * 0.9) {   // 崖顶：林下的灌木
      if (rnd < (C.bushTop ?? 0.012)) put('bush', x, y, 0.9 + hash2(gx, gy, 64) * 0.7, gx, gy);
      continue;
    }
    if (sd > -3 || blocked(x, y)) continue;
    // 路肩的碎石
    if (ld < G.pathHalf + 22) {
      if (ld > G.pathHalf - 14 && rnd < (C.pebble ?? 0.1)) put('pebble', x, y, 0.6 + hash2(gx, gy, 64) * 1.1, gx, gy);
      continue;
    }
    // 崖脚的灌木
    if (sd > -(C.bushBand ?? 30) && rnd < (C.bushFoot ?? 0.09)) { put('bush', x, y, 0.75 + hash2(gx, gy, 64) * 0.7, gx, gy); continue; }
    // 野地：草丛成片，野花零星
    const dens = fbm(x * 0.0045, y * 0.0045, 3, 79);
    if (dens > (C.tuftThreshold ?? 0.43) && rnd < (C.tuft ?? 0.55) * Math.min(1, (dens - (C.tuftThreshold ?? 0.43)) * 6 + 0.25)) {
      const fl = fbm(x * 0.011, y * 0.011, 2, 83);
      if (fl > (C.flowerThreshold ?? 0.62) && hash2(gx, gy, 65) < (C.flower ?? 0.5)) put('flower', x, y, 0.8 + hash2(gx, gy, 64) * 0.5, gx, gy);
      else put('tuft', x, y, 0.75 + hash2(gx, gy, 64) * 0.6, gx, gy);
    } else if (rnd > 1 - (C.pebble ?? 0.1) * 0.12) put('pebble', x, y, 0.8 + hash2(gx, gy, 64) * 1.6, gx, gy);
  }
  // 上限：超了就均匀抽稀（按固定间隔丢，结果仍然可复现）
  const max = C.max || {};
  for (const kind of Object.keys(out)) {
    const cap = max[kind] ?? 20000, list = out[kind];
    if (list.length > cap) { const k = list.length / cap; out[kind] = Array.from({ length: cap }, (_, i) => list[Math.floor(i * k)]); }
  }
  return out;
}

/**
 * 萤火虫 / 飘絮的活动范围：野地里靠近水和树林的地方取一批锚点。
 * @returns [{ x, y, h }]
 */
export function placeAmbientAnchors(field, map, theme) {
  const C = { ...(CONFIG.terrain?.ambient || {}), ...(theme?.ambient || {}) };
  if (C.enabled === false) return [];
  const G = CONFIG.terrain.ground, n = C.count ?? 260, out = [];
  for (let i = 0, tries = 0; out.length < n && tries < n * 30; tries++, i++) {
    const x = hash2(i, 1, 91) * field.W, y = hash2(i, 2, 92) * field.H;
    const sd = field.sdAt(x, y);
    if (sd > -6 || field.laneAt(x, y) < G.pathHalf + 30) continue;
    // 偏爱水边和崖脚（潮、背风）
    const near = field.riverAt(x, y) > 0.02 || sd > -70;
    if (!near && hash2(i, 3, 93) > 0.35) continue;
    out.push({ x, y, h: Math.max(field.heightAt(x, y), field.waterLevel ?? -1e9) });
  }
  return out;
}
