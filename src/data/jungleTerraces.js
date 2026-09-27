/**
 * jungleTerraces.js —— 野区"台地 + 分片树林"布局规划（纯数据，headless 可测）
 *
 * 用户看过三版实机截图后定稿（2026-09-27）："还是弄有悬崖（抬高地形）的那种吧……
 * 密密麻麻的一样的树太丑了。"——就是这一版：
 *   ① 大尺度：每块不可走区先定"它是什么"——
 *      · 台地：小块障碍、以及贴着河道的障碍 → 低多边形台地（草色台面、岩色崖壁），
 *        轮廓就是这块不可走区，崖壁本身就是"为什么走不过去"；台面上零星几棵树、几丛灌木；
 *      · 树林：其余野区障碍；
 *      · 边林：与地图外缘相连的那一圈，只做靠里的一条林带。
 *   ② 中尺度：树种由一张低频噪声场决定——一片以针叶林为主、另一片以阔叶林为主。
 *   ③ 密度：树林边缘一排（有大有小、有空当），内部按另一张噪声场成团、中间留空地；
 *      偶尔一棵特别大的树。空地里零星一块石头或一丛灌木。
 *   ④ 留白：能走的草地基本不放东西，只在贴着树林的边上零星几丛矮灌木。
 *
 * 能不能走以运行时判定为准（MapSystem.isWalkable，已含"城墙只有墙体挡人"），
 * 基地石墙占的地方不摆东西。参数在 CONFIG.ui.jungleTerraces。不碰 THREE。
 */
import { CONFIG, stylizedPaletteOf } from './Config.js';
import { isLaneCell } from './mapValidate.js';
import { navOutline } from './navOutline.js';

function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

/** 平滑的值噪声（0..1），scale 是一个"斑块"大约多少世界单位。 */
function valueNoise(x, y, scale, seed) {
  const fx = x / scale, fy = y / scale;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const s = (t) => t * t * (3 - 2 * t);
  const v = (i, j) => hash(i * 7919 + seed, j * 104729 + seed * 31);
  const top = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * s(tx);
  const bot = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * s(tx);
  return top + (bot - top) * s(ty);
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
const _cache = new WeakMap();

/**
 * @param {object} map
 * @param {(x:number,y:number)=>boolean} walk  运行时可走判定
 * @param {((x:number,y:number)=>boolean)|null} [isWall]  基地石墙占的地方
 * @param {((x:number,y:number)=>number)|null} [riverAt] 河道强度（MapSystem.riverFactor）
 * @param {number} [n=256] 分块采样分辨率（与 navgrid 一致）
 * @param {*} [cacheKey] 传运行时位图对象即可：同一份位图 + 同一套参数直接复用结果
 * @returns {{ trees: Array<{x,y,s,rot,species:'round'|'conifer',deep:boolean,onTop?:number}>,
 *            bushes: number[][], rocks: number[][],
 *            outcrops: Array<{ loops: Array<Array<[number,number]>>, height:number, cells:number }>,
 *            biomes: { outcrop:number, grove:number, border:number } }}
 *   bushes / rocks 的元素是 [x, y, scale, rot, 台面高度?]
 */
export function terracePlan(map, walk, isWall = null, riverAt = null, n = 256, cacheKey = null) {
  // 基表 CONFIG.ui.jungleTerraces，调色板可以用 terraceOverrides 逐项覆写
  // （扭曲丛林的格子只有峡谷的约 1/3 大，台地门槛要按自己的格子数算）。
  const C = { ...(CONFIG.ui?.jungleTerraces || {}), ...(stylizedPaletteOf(map).terraceOverrides || {}) };
  const cfgKey = JSON.stringify(C);   // 编辑器里改了参数必须重算，不能命中旧结果
  if (cacheKey != null) {
    const hit = _cache.get(map);
    if (hit && hit.key === cacheKey && hit.cfg === cfgKey) return hit.plan;
  }
  const { w: WW, h: WH } = map.world;
  const wall = isWall || (() => false);
  const out = { trees: [], bushes: [], rocks: [], outcrops: [], biomes: { outcrop: 0, grove: 0, border: 0 } };
  const cw = WW / n, ch = WH / n;
  const inWorld = (x, y) => x >= 0 && y >= 0 && x <= WW && y <= WH;
  const nearWalk = (x, y, r) => DIRS.some(([dx, dy]) => {
    const px = x + dx * r, py = y + dy * r;
    return inWorld(px, py) && walk(px, py);
  });
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- ① 不可走区分块，给每块定类型 ----
  const blocked = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * cw, y = (j + 0.5) * ch;
    blocked[j * n + i] = (!walk(x, y) && !wall(x, y)) ? 1 : 0;
  }
  const label = new Int32Array(n * n).fill(-1);
  const comps = [];
  const cx = (k) => (k % n + 0.5) * cw, cy = (k) => (((k / n) | 0) + 0.5) * ch;
  for (let s = 0; s < n * n; s++) {
    if (!blocked[s] || label[s] >= 0) continue;
    const id = comps.length, cells = [];
    let border = false;
    const q = [s]; label[s] = id;
    while (q.length) {
      const k = q.pop(); cells.push(k);
      const x = k % n, y = (k / n) | 0;
      if (!x || !y || x === n - 1 || y === n - 1) border = true;
      for (const kk of [k - 1, k + 1, k - n, k + n]) {
        if (kk < 0 || kk >= n * n || Math.abs((kk % n) - x) > 1) continue;
        if (blocked[kk] && label[kk] < 0) { label[kk] = id; q.push(kk); }
      }
    }
    const probe = C.outcropRiverProbe ?? 70;
    const nearRiver = !!riverAt && cells.some((k, i) => i % 3 === 0
      && DIRS.some(([dx, dy]) => (riverAt(cx(k) + dx * probe, cy(k) + dy * probe) || 0) > 0.3));
    let type = 'grove';
    if (border) type = 'border';
    else if (cells.length <= (C.outcropMaxCells ?? 110) || nearRiver) type = 'outcrop';
    comps.push({ cells, type });
    out.biomes[type]++;
  }

  // ---- 台地：追边挤出；台面零星几棵树、几丛灌木/小石头 ----
  for (const comp of comps) {
    if (comp.type !== 'outcrop') continue;
    const mask = new Uint8Array(n * n);
    for (const k of comp.cells) mask[k] = 1;
    const loops = navOutline(mask, n, map.world, { simplifyCells: 1.4, smoothPasses: 2, minAreaCells: 1 });
    if (!loops.length) continue;
    const size = comp.cells.length;
    const height = Math.min(C.outcropHeightMax ?? 44, (C.outcropHeightMin ?? 18) + Math.sqrt(size) * (C.outcropHeightPerRootCell ?? 1.6));
    out.outcrops.push({ loops: loops.map((l) => l.pts), height, cells: size });
    const inner = comp.cells.filter((k) => {
      for (let d = 1; d <= 3; d++) {
        if (!mask[k - d] || !mask[k + d] || !mask[k - d * n] || !mask[k + d * n]) return false;
      }
      return true;
    });
    if (!inner.length) continue;
    const nDetail = Math.min(C.outcropDetailMax ?? 6, Math.floor(size / (C.outcropDetailPerCells ?? 70)));
    for (let t = 0; t < nDetail; t++) {
      const k = inner[Math.floor(hash(size + t * 29 + 5, comp.cells[0] + 3) * inner.length)];
      (hash(k, t + 7) < 0.7 ? out.bushes : out.rocks).push([cx(k), cy(k), lerp(0.5, 0.9, hash(k + 1, t)), hash(k + 9, t) * 6.2832, height]);
    }
    const nTop = size < 40 ? 0 : size < 150 ? 1 : size < 400 ? 2 : 3;
    for (let t = 0; t < nTop; t++) {
      const k = inner[Math.floor(hash(size + t * 17, comp.cells[0]) * inner.length)];
      const x = cx(k), y = cy(k);
      out.trees.push({ x, y, s: lerp(0.6, 0.85, hash(k, t)), rot: hash(k + 3, t) * 6.2832,
        species: valueNoise(x, y, C.speciesPatch ?? 700, 11) > 0.5 ? 'conifer' : 'round', deep: false, onTop: height });
    }
  }

  // ---- 树林与边林 ----
  const S = C.treeStep ?? 26, edgeProbe = C.edgeProbe ?? 28;
  const clusterScale = C.clusterPatch ?? 170, speciesScale = C.speciesPatch ?? 700;
  for (let gx = S / 2; gx < WW; gx += S) {
    for (let gy = S / 2; gy < WH; gy += S) {
      const x = gx + (hash(gx + 11, gy) - 0.5) * S * 0.8;
      const y = gy + (hash(gx, gy + 11) - 0.5) * S * 0.8;
      if (!inWorld(x, y) || walk(x, y) || wall(x, y)) continue;
      const i = Math.min(n - 1, Math.floor(x / cw)), j = Math.min(n - 1, Math.floor(y / ch));
      const id = label[j * n + i];
      const type = id >= 0 ? comps[id].type : 'grove';
      if (type === 'outcrop') continue;
      const edge = nearWalk(x, y, edgeProbe);
      if (type === 'border' && !edge && !nearWalk(x, y, C.borderDepth ?? 150)) continue;
      const cluster = Math.max(0, Math.min(1, (valueNoise(x, y, clusterScale, 3) - 0.3) / 0.45));
      const density = edge ? (C.edgeDensity ?? 0.7) : lerp(C.innerDensityMin ?? 0.12, C.innerDensityMax ?? 0.85, cluster);
      if (hash(gx + 17, gy + 3) >= density) {
        if (!edge && hash(gx + 19, gy + 5) < (C.clearingDetailChance ?? 0.08)) {
          (hash(gx + 23, gy) < 0.5 ? out.rocks : out.bushes).push([x, y, lerp(0.6, 1.2, hash(gx, gy + 29)), hash(gx + 5, gy + 9) * 6.2832]);
        }
        continue;
      }
      if (edge && hash(gx + 29, gy + 7) < (C.edgeRockChance ?? 0.1)) {
        out.rocks.push([x, y, lerp(C.rockScaleMin ?? 1.0, C.rockScaleMax ?? 1.8, hash(gx + 31, gy)), hash(gx + 5, gy + 9) * 6.2832]);
        continue;
      }
      let species = valueNoise(x, y, speciesScale, 11) > 0.5 ? 'conifer' : 'round';
      if (hash(gx + 37, gy + 13) < (C.speciesMix ?? 0.15)) species = species === 'conifer' ? 'round' : 'conifer';
      const hero = !edge && hash(gx + 41, gy + 19) < (C.heroChance ?? 0.04);
      const s = hero ? lerp(1.55, 1.9, hash(gx + 43, gy)) : edge ? lerp(0.7, 1.1, hash(gx + 47, gy)) : lerp(0.8, 1.35, hash(gx + 53, gy));
      out.trees.push({ x, y, s, rot: hash(gx + 5, gy + 5) * 6.2832, species, deep: !edge && cluster > 0.6 });
    }
  }

  // ---- 留白：草地上只贴着树林零星几丛矮灌木 ----
  const B = C.bushStep ?? 44, band = C.bushBand ?? 34;
  for (let gx = B / 2; gx < WW; gx += B) {
    for (let gy = B / 2; gy < WH; gy += B) {
      const x = gx + (hash(gx + 29, gy) - 0.5) * B * 0.7;
      const y = gy + (hash(gx, gy + 29) - 0.5) * B * 0.7;
      if (!inWorld(x, y) || !walk(x, y) || isLaneCell(map, x, y)) continue;
      if (!DIRS.some(([dx, dy]) => { const px = x + dx * band, py = y + dy * band; return inWorld(px, py) && !walk(px, py); })) continue;
      if (hash(gx + 31, gy + 7) >= (C.bushChance ?? 0.14)) continue;
      out.bushes.push([x, y, 0.55 + hash(gx + 37, gy) * 0.4, hash(gx + 41, gy) * 6.2832]);
    }
  }
  if (cacheKey != null) _cache.set(map, { key: cacheKey, cfg: cfgKey, plan: out });
  return out;
}
