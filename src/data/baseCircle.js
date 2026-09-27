import { unpackBits } from './navgrid.js';
/**
 * baseCircle.js —— 基地圈圆心的**唯一**取值口。
 *
 * 为什么要单独一个模块：这个量原本有两处实现——`MapSystem.getBaseCircleCenter`
 * 和 `TerrainLayer` 里"离线重算，避免依赖注入时序"的那份。两份都写死了
 * 「蓝方基地在世界左下角、红方在右上角」。
 *
 * 那是召唤师峡谷/嚎哭深渊的**巧合**，不是普遍规律：扭曲丛林的双方基地在
 * 左右两侧的中点 (300,1000)/(2700,1000)。按角点算，基地圈会被甩到地图角落的空地上——
 * 光环画在没有建筑的地方、+20 的高地地形长在空地上、可行走区凭空多出两块无用扇形，
 * 而基地本身反倒没有开阔地。**画面上不会报错，只会看着莫名其妙。**
 *
 * 现在地图可以显式声明 `baseCenters: { blue:{x,y}, red:{x,y} }`；
 * 未声明的沿用角点，对已有地图逐位不变（见 docs/DEVELOPMENT.md §8.3：加开关不许改行为）。
 */

/** @returns {{x:number,y:number}|null} 该方基地圈圆心 */
export function baseCircleCenter(map, faction) {
  if (!map?.world) return null;
  const declared = map.baseCenters?.[faction];
  if (declared) return { x: declared.x, y: declared.y };
  const { w: WW, h: WH } = map.world;
  return faction === 'blue' ? { x: 0, y: WH } : { x: WW, y: 0 };
}

/**
 * v58：该点是否落在任意一方的"基地开放圈"内（baseOpenRadius，未声明则退回
 * baseCircleRadius）——森林风格地图的 TerrainLayer/VegetationLayer 都要用它
 * 排除"基地广场本身也被判成野区"的问题：广场是一整片圆形开阔地，半径通常
 * 远大于走廊半宽，广场中心离兵线折线的直线距离早就超过半宽，只靠"离兵线够
 * 近才算路"这一条判据会把广场中心误判成野区（用户实机截图圈出的问题）。
 * 两处渲染代码共用这一份实现，不各自重复一份基地圈判定。
 * @returns {boolean}
 */
export function isInBaseOpen(map, x, y) {
  if (!map?.world) return false;
  const r = map.baseOpenRadius || map.baseCircleRadius;
  if (!r) return false;
  for (const f of ['blue', 'red']) {
    const c = baseCircleCenter(map, f);
    if (c && Math.hypot(x - c.x, y - c.y) <= r) return true;
  }
  return false;
}

/**
 * v59：该点是否落在任意一方"基地高地围墙"那一圈——sr_navgrid.js 里描的
 * "在基地圈半径处筑一圈厚 45 的墙，兵线走廊穿过处不筑，留三个口子"那圈围墙，
 * 几何上就贴着 baseOpenRadius 往外扩一段厚度。用户看截图指出：这一圈墙体的
 * 不可走格子被森林风格的野区植被逻辑当成"基地开放圈内，不用管"跳过了，
 * 露出裸的图外底色，"丑的要死"；而这一圈本来就该是石墙，不是森林——
 * "我粉色画圈的地方应该是高地的围墙（石墙）"。
 * BoundaryDecorLayer 用它摆真正的墙体装饰，VegetationLayer 用它跳过（不在
 * 这一圈里重复摆树），两处必须用同一份判定，否则墙和树会在同一块地皮上打架。
 * @param {object} map @param {number} x @param {number} y
 * @param {number} [thickness=60] 围墙判定带的厚度（比 sr_navgrid.js 描述的
 *   45 略宽一点留余量，避免边缘漏判露底色）
 * @returns {boolean}
 */
export function isInBaseWallRing(map, x, y, thickness = 60) {
  if (!map?.world) return false;
  const r = map.baseOpenRadius || map.baseCircleRadius;
  if (!r) return false;
  for (const f of ['blue', 'red']) {
    const c = baseCircleCenter(map, f);
    if (!c) continue;
    const d = Math.hypot(x - c.x, y - c.y);
    if (d >= r && d <= r + thickness) return true;
  }
  return false;
}

/**
 * navgrid 原生分辨率下的"基地围墙"掩码。只有地图声明了 `baseWalls: true` 才有墙
 * （召唤师峡谷：sr_navgrid.js 在基地圈半径处专门描了一圈墙、给三路留了口子；
 * 扭曲丛林没有这种墙，环带里的不可走区是野区树林的一部分，不能被截成墙块）。
 *
 * 规则：不可走 且 格心在 isInBaseWallRing 环带内 → 墙；另外，一整块不可走小岛如果
 * 至少 `wallFraction`（CONFIG.ui.baseWall）落在环带内，整块都算墙——否则墙体外侧
 * 那一溜会被当成树林长出树来，挡住墙面。
 *
 * @param {object} map
 * @param {Uint8Array} bits 可走位图（1=可走），n×n
 * @param {number} n
 * @param {number} [wallFraction=0.5]
 * @returns {Uint8Array|null} 1 = 该格是墙；地图没声明 baseWalls 时返回 null
 */
export function baseWallMask(map, bits, n, wallFraction = 0.5) {
  if (!map?.baseWalls || !map.world) return null;
  const cw = map.world.w / n, ch = map.world.h / n;
  const ring = (k) => isInBaseWallRing(map, (k % n + 0.5) * cw, (((k / n) | 0) + 0.5) * ch);
  const out = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  for (let s = 0; s < n * n; s++) {
    if (bits[s] || seen[s]) continue;
    const q = [s], cells = []; seen[s] = 1;
    while (q.length) {
      const k = q.pop(); cells.push(k);
      const x = k % n, y = (k / n) | 0;
      if (x > 0 && !bits[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; q.push(k - 1); }
      if (x < n - 1 && !bits[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; q.push(k + 1); }
      if (y > 0 && !bits[k - n] && !seen[k - n]) { seen[k - n] = 1; q.push(k - n); }
      if (y < n - 1 && !bits[k + n] && !seen[k + n]) { seen[k + n] = 1; q.push(k + n); }
    }
    const inRing = cells.filter(ring);
    if (!inRing.length) continue;
    const whole = inRing.length / cells.length >= wallFraction;
    for (const k of (whole ? cells : inRing)) out[k] = 1;
  }
  return out;
}

const _wallLookupCache = new WeakMap();
/**
 * 世界坐标 → 是否基地石墙。TerrainLayer（墙脚地面）、jungleCanopy（墙上不长树）、
 * BaseWallLayer（砌墙）三处读同一份掩码。按 map 对象缓存。
 * @returns {((x:number,y:number)=>boolean)|null}
 */
export function baseWallLookup(map, navgrid, wallFraction = 0.5) {
  if (!map?.baseWalls || !navgrid?.bits) return null;
  const hit = _wallLookupCache.get(map);
  if (hit && hit.bits === navgrid.bits) return hit.fn;
  const n = navgrid.n, bits = unpackBits(navgrid.bits, n);
  const mask = bits ? baseWallMask(map, bits, n, wallFraction) : null;
  const cw = map.world.w / n, ch = map.world.h / n;
  const fn = mask ? (x, y) => {
    const i = Math.floor(x / cw), j = Math.floor(y / ch);
    return i >= 0 && j >= 0 && i < n && j < n && mask[j * n + i] === 1;
  } : null;
  _wallLookupCache.set(map, { bits: navgrid.bits, fn });
  return fn;
}

/**
 * 基地石墙的中线：沿基地圈逐角度量出墙带的内外径，取中间；连续的一段角度就是一截墙。
 * BaseWallLayer 沿这些中线砌城墙（墙体比墙带窄，站在墙带正中）。
 *
 * @param {object} map
 * @param {Uint8Array} mask baseWallMask 的结果（n×n）
 * @param {number} n
 * @param {number} [spacing=18] 输出点沿弧长的间距（世界单位）
 * @returns {Array<Array<{x:number,y:number,width:number,ang:number}>>} 每截墙一串点，ang 是该点相对基地圈心的方位角
 */
export function baseWallRuns(map, mask, n, spacing = 18) {
  if (!mask || !map?.world) return [];
  const cw = map.world.w / n, ch = map.world.h / n;
  const inWall = (x, y) => {
    const i = Math.floor(x / cw), j = Math.floor(y / ch);
    return i >= 0 && j >= 0 && i < n && j < n && mask[j * n + i] === 1;
  };
  const runs = [];
  const r0 = map.baseOpenRadius || map.baseCircleRadius;
  if (!r0) return runs;
  for (const f of ['blue', 'red']) {
    const c = baseCircleCenter(map, f);
    if (!c) continue;
    const N = Math.ceil(2 * Math.PI * (r0 + 30) / 6);
    const samples = [];
    for (let i = 0; i < N; i++) {
      const ang = i / N * Math.PI * 2;
      let lo = Infinity, hi = -Infinity;
      for (let rr = r0 - 20; rr <= r0 + 90; rr += 3) {
        if (inWall(c.x + Math.cos(ang) * rr, c.y + Math.sin(ang) * rr)) { lo = Math.min(lo, rr); hi = Math.max(hi, rr); }
      }
      samples.push(hi - lo >= 8 ? { ang, mid: (lo + hi) / 2, width: hi - lo } : null);
    }
    // 从一个空档开始转一圈，跨 0° 的那截墙不会被切成两段
    let start = samples.findIndex((q) => !q);
    if (start < 0) start = 0;
    let run = [];
    const raw = [];
    for (let k = 1; k <= N; k++) {
      const q = samples[(start + k) % N];
      if (q) run.push(q); else if (run.length) { raw.push(run); run = []; }
    }
    if (run.length) raw.push(run);
    for (const rn of raw) {
      const pts = rn.map((q) => ({ x: c.x + Math.cos(q.ang) * q.mid, y: c.y + Math.sin(q.ang) * q.mid, width: q.width, ang: q.ang }));
      const out = [pts[0]];
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (acc >= spacing) { out.push(pts[i]); acc = 0; }
      }
      if (out.length >= 2) runs.push(out);
    }
  }
  return runs;
}
