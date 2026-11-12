/**
 * modelKit.js —— 程序化建模的小工具箱：建筑和单位的模型都是用这些零件拼出来的。
 *
 * 写实感来自三件事，都落在这里：
 *   ① 石头是一块块垒的（arcBlock / stoneBlock：每块略有大小、颜色和棱角上的差别），不是一根光滑的圆柱；
 *   ② 该圆的地方真的圆（lathe：线脚、柱础、杯口都用旋转体），该有棱的地方用硬边（flat）；
 *   ③ 每个零件带材料名（石 / 金属 / 金 / 布……），材质按它出粗糙度和金属度（unitSurface.js）。
 * 零件的格式与 UnitMeshFactory.mergeParts 一致：{ geo, matrix, color, mat }。
 */
import * as THREE from '../../vendor/three.module.js';

export const M4 = () => new THREE.Matrix4();
export const T = (x, y, z) => M4().makeTranslation(x, y, z);
export const RX = (a) => M4().makeRotationX(a);
export const RY = (a) => M4().makeRotationY(a);
export const RZ = (a) => M4().makeRotationZ(a);
export const S = (x, y = x, z = x) => M4().makeScale(x, y, z);
export const C = (...ms) => ms.reduce((a, m) => a.multiply(m), M4());
export const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
export const mixHex = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();

export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

/** 硬边：拆成不共享顶点再算法线（每个面一个朝向）。 */
export function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}
/** 把顶点按位置抖一下（同一位置的顶点抖动相同，不会裂缝）。amt = 抖动幅度（世界单位）。 */
export function jitter(geo, amt, seed = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = Math.round(x * 53.3) * 7919 + Math.round(y * 47.7) * 104729 + Math.round(z * 61.1) * 1299709;
    p.setXYZ(i, x + (hash01(k, seed) - 0.5) * 2 * amt, y + (hash01(k, seed + 1) - 0.5) * 2 * amt, z + (hash01(k, seed + 2) - 0.5) * 2 * amt);
  }
  return geo;
}

/** 一块凿出来的石头：长方体，八个角略微内收 / 外鼓，棱是硬的。 */
export function stoneBlock(w, h, d, seed = 0, rough = 0.07) {
  const g = new THREE.BoxGeometry(w, h, d);
  jitter(g, Math.min(w, h, d) * rough, seed);
  return flat(g);
}

/**
 * 弧形石块：圆环的一段（内半径 r0、外半径 r1、高 h、角度 a0..a1），圆塔的一皮石头就是一圈这个。
 * taper = 顶面半径相对底面的比例（塔身收分）。原点在环心、底面 y = 0。
 */
export function arcBlock(r0, r1, h, a0, a1, seed = 0, taper = 1, seg = 2, rough = 0.035) {
  const pos = [], idx = [];
  const ring = (r, y) => { for (let i = 0; i <= seg; i++) { const a = a0 + (a1 - a0) * i / seg; pos.push(Math.cos(a) * r, y, Math.sin(a) * r); } };
  ring(r0, 0); ring(r1, 0); ring(r0 * taper, h); ring(r1 * taper, h);
  const n = seg + 1, I0 = 0, O0 = n, I1 = 2 * n, O1 = 3 * n;
  const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
  for (let i = 0; i < seg; i++) {
    quad(O0 + i, O1 + i, O1 + i + 1, O0 + i + 1);       // 外侧
    quad(I0 + i + 1, I1 + i + 1, I1 + i, I0 + i);       // 内侧
    quad(I1 + i, I1 + i + 1, O1 + i + 1, O1 + i);       // 顶
    quad(I0 + i, O0 + i, O0 + i + 1, I0 + i + 1);       // 底
  }
  quad(I0, I1, O1, O0);                                 // 两个端面
  quad(O0 + seg, O1 + seg, I1 + seg, I0 + seg);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  jitter(g, (r1 - r0) * rough + h * rough * 0.5, seed);
  return flat(g);
}

/** 旋转体。profile = [[半径, 高度], ...]（从下到上），seg = 圆周分段。hard = 棱是硬的（多边形柱）。 */
export function lathe(profile, seg = 16, hard = false, phi0 = 0, phiLen = Math.PI * 2) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), seg, phi0, phiLen);
  return hard ? flat(g) : g;
}
/** 把一个旋转体切成 n 瓣（每瓣一个几何）：整着看是一体的，塌下来是几块。 */
export function latheSectors(profile, n, segEach = 4, hard = false) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lathe(profile, segEach, hard, i / n * Math.PI * 2, Math.PI * 2 / n));
  return out;
}

/** 多棱柱 / 棱台（硬边）。 */
export function prism(n, rTop, rBot, h) { return flat(new THREE.CylinderGeometry(rTop, rBot, h, n, 1)); }

/** 不规则的尖碎片（黑曜石、骨刺、水晶簇）：n 棱锥，顶点歪一点，棱是硬的。底面在 y = 0，尖在 +y。 */
export function shard(r, h, n = 5, seed = 0, lean = 0.25) {
  const g = new THREE.ConeGeometry(r, h, n, 2);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  const lx = (hash01(seed, 3) - 0.5) * 2 * lean * r * 2, lz = (hash01(seed, 4) - 0.5) * 2 * lean * r * 2;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / h;
    p.setX(i, p.getX(i) * (1 + (hash01(Math.round(p.getX(i) * 31 + p.getZ(i) * 17), seed) - 0.5) * 0.35 * (1 - t)) + lx * t * t);
    p.setZ(i, p.getZ(i) * (1 + (hash01(Math.round(p.getZ(i) * 29 + p.getX(i) * 13), seed + 1) - 0.5) * 0.35 * (1 - t)) + lz * t * t);
  }
  return flat(g);
}

/**
 * 沿一条曲线弯起来的"角"或"爪"：截面从根部 r0 收到尖端 r1，n 棱。
 * pts = [[x,y,z], ...] 控制点（Catmull-Rom 插值），seg = 沿长度分段。
 */
export function horn(pts, r0, r1, n = 5, seg = 7, flatY = 1) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const pos = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0), tan = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg; curve.getPoint(t, c); curve.getTangent(t, tan);
    a.crossVectors(tan, Math.abs(tan.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).normalize(); b.crossVectors(tan, a).normalize();
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    for (let k = 0; k < n; k++) {
      const ang = k / n * Math.PI * 2, cx = Math.cos(ang) * r, cy = Math.sin(ang) * r * flatY;
      pos.push(c.x + a.x * cx + b.x * cy, c.y + a.y * cx + b.y * cy, c.z + a.z * cx + b.z * cy);
    }
  }
  for (let i = 0; i < seg; i++) for (let k = 0; k < n; k++) {
    const p0 = i * n + k, p1 = i * n + (k + 1) % n, q0 = p0 + n, q1 = p1 + n;
    idx.push(p0, p1, q0, p1, q1, q0);
  }
  const base = pos.length / 3; curve.getPoint(0, c); pos.push(c.x, c.y, c.z);
  for (let k = 0; k < n; k++) idx.push(base, (k + 1) % n, k);
  const tip = pos.length / 3; curve.getPoint(1, c); pos.push(c.x, c.y, c.z);
  for (let k = 0; k < n; k++) idx.push(tip, seg * n + k, seg * n + (k + 1) % n);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return flat(g);
}

/** 垂下来的布（旗、披风）：宽 w、长 h，上沿在 y = 0 往下垂，带一点波浪和末端的燕尾。 */
export function banner(w, h, wave = 0.06, tail = 0.25, segY = 6) {
  const g = new THREE.PlaneGeometry(w, h, 2, segY);
  g.translate(0, -h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = -p.getY(i) / h, x = p.getX(i) / (w / 2);
    p.setZ(i, Math.sin(t * 5.2 + x * 0.8) * wave * h * t + t * t * wave * h * 1.5);
    if (t > 0.999) p.setY(i, p.getY(i) + (1 - Math.abs(x)) * tail * w);   // 燕尾：中间往上收
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 水晶的几何（双尖晶柱）：n 棱的柱身 + 上下两个尖顶，上尖长、下尖短，棱是硬的。r = 腰部半径；总高约 r × (top + mid + bot)。
 * 原点在腰部中心附近（视觉重心）。
 */
export function gem(r, n = 6, top = 1.5, mid = 0.7, bot = 1.0, twist = 0) {
  const pos = [], idx = [];
  const y1 = mid * r / 2, y0 = -y1;
  for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; pos.push(Math.cos(a) * r * 0.92, y0, Math.sin(a) * r * 0.92); }
  for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2 + twist; pos.push(Math.cos(a) * r, y1, Math.sin(a) * r); }
  const iT = pos.length / 3; pos.push(0, y1 + top * r, 0);
  const iB = pos.length / 3; pos.push(0, y0 - bot * r, 0);
  for (let k = 0; k < n; k++) {
    const a = k, b = (k + 1) % n, c = n + k, d = n + (k + 1) % n;
    idx.push(a, c, b, b, c, d);
    idx.push(c, iT, d);
    idx.push(a, b, iB);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return flat(g);
}
