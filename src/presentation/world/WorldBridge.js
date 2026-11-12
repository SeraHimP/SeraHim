/**
 * WorldBridge.js —— 横跨峡谷的石桥（深渊图，主题里声明了 landmass 才有）。
 *
 * 用户："两个悬崖中间通过一座石桥连接……中间的石桥要做成真正的桥，就是中间是悬空的，
 *        桥两侧的那个雾可以加重一些显示出万丈深渊的感觉。"
 * 原来的桥是高度场的一部分：可走的那条带子两侧各一道几百高的斜坡一直落到谷底，看上去是一道坝，不是桥。
 * 高度场一个 (x, z) 只有一个高度，做不出"桥面底下是空的"，所以桥体单独建模，高度场在桥下照常是峡谷：
 *   · 桥面：沿可走区的轮廓（距离场的零等值线，行进方块取出来的光滑边）铺一层厚石板，四周是侧壁和一圈缘石；
 *   · 桥下：一道连拱 —— 几座桥墩从桥面底下一直扎进雾里，墩与墩之间是拱，拱下是空的；
 *     bridge.piers = 0 时没有桥墩，整座桥是一跨，完全悬空。
 * 单位站的高度仍然来自高度场的逻辑高度（field.heightAt，桥面是平的），和这里画的桥面是同一个高度。
 *
 * 桥体的尺寸比例是造型本身的具名常量；可调的量（厚度、桥墩数、拱高、缘石）在主题的 bridge 里。
 */
import * as THREE from '../../../vendor/three.module.js';
import { hash2 } from '../../data/noise.js';
import { patchWorldMaterial, patchAbyssFog } from './worldShading.js';

const DECK_LIFT = 0.25;        // 桥面比逻辑高度高出一点点，桥头和实地重叠的那一小段不闪
const SUB_INSET = 26;          // 桥下结构比桥面最窄处每边收进去多少（藏在桥面的檐下）
const PIER_PROUD = 7;          // 桥墩比拱身每边凸出多少
const ARCH_SEGS = 16;          // 一道拱分多少段

/** 往数组里塞一个四边形（a, b, c, d 逆时针，法线朝外） */
function quad(P, a, b, c, d) { P.push(...a, ...b, ...c, ...a, ...c, ...d); }

/** 三向投影的石材：桥面看到的是俯视的石板，侧壁和桥墩是同一种石头的立面 */
function stoneMaterial(tex, theme, tint) {
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normalMap, roughness: 0.92, metalness: 0, color: new THREE.Color(tint), flatShading: true });
  const B = theme.bridge || {};
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTile = { value: 1 / (B.tile ?? theme.tile?.paved ?? 110) };
    sh.vertexShader = 'varying vec3 vBP; varying vec3 vBN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vBP = position; vBN = normal;');
    sh.fragmentShader = `uniform float uTile; varying vec3 vBP; varying vec3 vBN;
vec4 btri(sampler2D t, vec3 p, vec3 n) { vec3 w = abs(n); w = w * w * w; w /= (w.x + w.y + w.z); return texture2D(t, p.zy * uTile) * w.x + texture2D(t, p.xz * uTile) * w.y + texture2D(t, p.xy * uTile) * w.z; }
` + sh.fragmentShader
      .replace('#include <map_fragment>', 'vec4 bk = btri(map, vBP, normalize(vBN)); diffuseColor.rgb *= bk.rgb;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * bk.a;')
      .replace('#include <normal_fragment_maps>', '');
  };
  mat.customProgramCacheKey = () => 'world-bridge-1';
  return patchAbyssFog(patchWorldMaterial(mat), theme);
}

/**
 * 桥面的轮廓：在自己的网格上对"桥面标量" D 做行进方块。D ≤ 0 = 桥面（可走区往外 over 宽，且在峡谷上空）。
 * 返回 { top: 顶面三角形顶点, edges: [[x0, z0, x1, z1, nx, nz]] 轮廓线段（n = 朝外的方向）}
 */
export function deckOutline(field, B = {}) {
  const step = B.cell ?? 8, over = B.over ?? 7, W = field.W, H = field.H;
  const nx = Math.ceil(W / step) + 1, ny = Math.ceil(H / step) + 1;
  const D = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(W, i * step), y = Math.min(H, j * step);
    const L = field.landAt(x, y).L;
    D[j * nx + i] = L > 0.999 ? 1e3 : Math.max(field.sdAt(x, y) - over, (L - (B.landOverlap ?? 0.85)) * 60);
  }
  const top = [], edges = [];
  const corner = [[0, 0], [0, 1], [1, 1], [1, 0]];   // 这个顺序的多边形法线朝上
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v = corner.map(([a, b]) => D[(j + b) * nx + i + a]);
    const inN = v.filter((q) => q <= 0).length;
    if (!inN) continue;
    const pt = corner.map(([a, b]) => [(i + a) * step, (j + b) * step]);
    const poly = [], cross = [];
    for (let e = 0; e < 4; e++) {
      const f = (e + 1) % 4;
      if (v[e] <= 0) poly.push(pt[e]);
      if ((v[e] <= 0) !== (v[f] <= 0)) {
        const t = v[e] / (v[e] - v[f]), c = [pt[e][0] + (pt[f][0] - pt[e][0]) * t, pt[e][1] + (pt[f][1] - pt[e][1]) * t];
        poly.push(c); cross.push(c);
      }
    }
    for (let k = 1; k < poly.length - 1; k++) top.push(poly[0], poly[k], poly[k + 1]);
    if (cross.length >= 2) {
      // 朝外 = 从里面的角指向外面的角
      let ix = 0, iz = 0, ox = 0, oz = 0;
      for (let e = 0; e < 4; e++) { if (v[e] <= 0) { ix += pt[e][0] / inN; iz += pt[e][1] / inN; } else { ox += pt[e][0] / (4 - inN); oz += pt[e][1] / (4 - inN); } }
      const l = Math.hypot(ox - ix, oz - iz) || 1;
      for (let k = 0; k + 1 < cross.length; k += 2) edges.push([cross[k][0], cross[k][1], cross[k + 1][0], cross[k + 1][1], (ox - ix) / l, (oz - iz) / l]);
    }
  }
  return { top, edges, step };
}

/**
 * 桥下结构怎么排：沿两个基地的连线，从一侧崖线到另一侧崖线。
 * 返回 { ax, az, ux, uz, s0, s1, half, off, piers: [[a0, a1]], spans: [[a0, a1]], rise }（a = 沿桥轴的距离）
 */
export function bridgeLayout(field, B = {}) {
  const b0 = field.bases[0].c, b1 = field.bases[1].c;
  const len = Math.hypot(b1.x - b0.x, b1.y - b0.y), ux = (b1.x - b0.x) / len, uz = (b1.y - b0.y) / len, nx = -uz, nz = ux;
  // 峡谷上空的那一段：沿轴找 L < 0.5 的范围
  let s0 = null, s1 = null;
  for (let s = 0; s <= len; s += 6) { if (field.landAt(b0.x + ux * s, b0.y + uz * s).L < 0.5) { if (s0 == null) s0 = s; s1 = s; } }
  if (s0 == null) return null;
  // 桥面最窄处的半宽，以及桥面中线相对轴线偏了多少（可走区不一定正好以轴线为中心）
  let lo = Infinity, hi = Infinity;
  const reach = (s, dir) => { let o = 0; while (o < 600 && field.sdAt(b0.x + ux * s + nx * dir * (o + 6), b0.y + uz * s + nz * dir * (o + 6)) <= 0) o += 6; return o; };
  for (let s = s0 + 40; s <= s1 - 40; s += 40) { hi = Math.min(hi, reach(s, 1)); lo = Math.min(lo, reach(s, -1)); }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  const off = (hi - lo) / 2, half = Math.max(20, (hi + lo) / 2 - SUB_INSET);
  const a0 = s0 - (B.abutment ?? 30), a1 = s1 + (B.abutment ?? 30), n = Math.max(0, B.piers ?? 4), tp = B.pierThick ?? 70;
  const clear = (a1 - a0 - n * tp) / (n + 1);
  const piers = [], spans = [];
  for (let k = 0; k <= n; k++) {
    const sa = a0 + k * (clear + tp);
    spans.push([sa, sa + clear]);
    if (k < n) piers.push([sa + clear, sa + clear + tp]);
  }
  return { ax: b0.x + nx * off, az: b0.y + nz * off, ux, uz, nx, nz, s0, s1, half, off, piers, spans, rise: Math.min(clear * 0.5 * (B.archRatio ?? 0.85), B.archRise ?? 170) };
}

export function buildWorldBridge(field, tex, theme) {
  if (!field.landmass || !field.landAt) return null;
  const B = theme.bridge || {};
  if (B.enabled === false) return null;
  const group = new THREE.Group(); group.name = 'worldBridge';
  const disp = [];
  const T = B.thickness ?? 30;
  const mat = stoneMaterial(tex, theme, B.tint ?? '#ffffff');
  disp.push(mat);

  // ---------- 桥面 ----------
  const { top, edges } = deckOutline(field, B);
  if (!top.length) return null;
  const P = [];
  const hAt = (x, z) => field.heightAt(x, z) + DECK_LIFT;
  for (let i = 0; i < top.length; i += 3) for (let k = 0; k < 3; k++) { const [x, z] = top[i + k]; P.push(x, hAt(x, z), z); }
  for (const [x0, z0, x1, z1, nx, nz] of edges) {
    const y0 = hAt(x0, z0), y1 = hAt(x1, z1);
    // 线段方向 × 朝下 的法线要朝外：不对就把两端对调
    const cz = (x1 - x0) * nz - (z1 - z0) * nx;
    const a = cz > 0 ? [x0, z0, y0] : [x1, z1, y1], b = cz > 0 ? [x1, z1, y1] : [x0, z0, y0];
    quad(P, [a[0], a[2], a[1]], [b[0], b[2], b[1]], [b[0], b[2] - T, b[1]], [a[0], a[2] - T, a[1]]);
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  deckGeo.computeVertexNormals(); deckGeo.computeBoundingSphere();
  const deck = new THREE.Mesh(deckGeo, mat);
  deck.castShadow = true; deck.receiveShadow = true; deck.matrixAutoUpdate = false; deck.name = 'bridgeDeck';
  group.add(deck); disp.push(deckGeo);

  // ---------- 缘石：沿桥边一块块矮石（偶尔缺一块）----------
  let curbs = 0;
  if ((B.curb ?? true) && edges.length) {
    const gap = B.curbGap ?? 21, sz = B.curbSize ?? [16, 7, 9], miss = B.curbMiss ?? 0.14;
    const list = [], M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), E = new THREE.Euler();
    // 每条轮廓线段按自己的位置决定放不放（线段是乱序的，不串成折线；按世界坐标取整到 gap 的格子里，一格最多一块）
    const seen = new Set();
    for (const [x0, z0, x1, z1, nx, nz] of edges) {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, key = Math.round(mx / gap) + ',' + Math.round(mz / gap);
      if (seen.has(key)) continue; seen.add(key);
      if (hash2(mx, mz, 3) < miss) continue;
      const k = 0.85 + hash2(mx, mz, 4) * 0.4;
      E.set((hash2(mx, mz, 5) - 0.5) * 0.14, Math.atan2(-(z1 - z0), x1 - x0) + (hash2(mx, mz, 6) - 0.5) * 0.2, (hash2(mx, mz, 7) - 0.5) * 0.1); Q.setFromEuler(E);
      S.set(sz[0] * k, sz[1] * (0.8 + hash2(mx, mz, 8) * 0.5), sz[2]);
      V.set(mx - nx * sz[2] * 0.45, hAt(mx, mz) + S.y * 0.42, mz - nz * sz[2] * 0.45);
      list.push(M.compose(V, Q, S).clone());
    }
    if (list.length) {
      const g = new THREE.BoxGeometry(1, 1, 1);
      const inst = new THREE.InstancedMesh(g, mat, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = true; inst.receiveShadow = true; inst.matrixAutoUpdate = false; inst.computeBoundingSphere(); inst.name = 'bridgeCurb';
      group.add(inst); disp.push(g); curbs = list.length;
    }
  }

  // ---------- 桥下：连拱 + 桥墩 ----------
  const lay = bridgeLayout(field, B);
  let piers = 0, spans = 0;
  if (lay && (B.substructure ?? true)) {
    const S2 = [], yTop = -T + 2, bottom = -(theme.dropHeight ?? 300) - 40, half = lay.half;
    const at = (a, o, y) => [lay.ax + lay.ux * a + lay.nx * o, y, lay.az + lay.uz * a + lay.nz * o];
    const yArch = (u) => -T - lay.rise * (1 - Math.sqrt(Math.max(0, 1 - (2 * u - 1) * (2 * u - 1))));
    for (const [a0, a1] of lay.spans) {
      for (let i = 0; i < ARCH_SEGS; i++) {
        const u0 = i / ARCH_SEGS, u1 = (i + 1) / ARCH_SEGS, x0 = a0 + (a1 - a0) * u0, x1 = a0 + (a1 - a0) * u1, y0 = yArch(u0), y1 = yArch(u1);
        quad(S2, at(x0, half, yTop), at(x1, half, yTop), at(x1, half, y1), at(x0, half, y0));        // +侧拱墙
        quad(S2, at(x1, -half, yTop), at(x0, -half, yTop), at(x0, -half, y0), at(x1, -half, y1));    // −侧拱墙
        quad(S2, at(x0, half, y0), at(x1, half, y1), at(x1, -half, y1), at(x0, -half, y0));          // 拱腹
      }
      spans++;
    }
    const spring = -T - lay.rise;
    for (const [a0, a1] of lay.piers) {
      const hp = half + PIER_PROUD, k = B.pierBatter ?? 1.3, mid = (a0 + a1) / 2, tb = (a1 - a0) / 2 * k, hb = hp * (1 + (k - 1) * 0.4);
      // 墩身：上窄下宽，一直扎进雾里
      const t = [at(a0, hp, yTop), at(a1, hp, yTop), at(a1, -hp, yTop), at(a0, -hp, yTop)];
      const b = [at(mid - tb, hb, bottom), at(mid + tb, hb, bottom), at(mid + tb, -hb, bottom), at(mid - tb, -hb, bottom)];
      quad(S2, t[0], t[1], b[1], b[0]); quad(S2, t[1], t[2], b[2], b[1]); quad(S2, t[2], t[3], b[3], b[2]); quad(S2, t[3], t[0], b[0], b[3]);
      // 墩帽：起拱线上一道外挑的石带
      const c0 = a0 - 8, c1 = a1 + 8, hc = hp + 9, y0 = spring + 6, y1 = spring - 12;
      const ct = [at(c0, hc, y0), at(c1, hc, y0), at(c1, -hc, y0), at(c0, -hc, y0)], cb = [at(c0, hc, y1), at(c1, hc, y1), at(c1, -hc, y1), at(c0, -hc, y1)];
      quad(S2, ct[0], ct[1], cb[1], cb[0]); quad(S2, ct[1], ct[2], cb[2], cb[1]); quad(S2, ct[2], ct[3], cb[3], cb[2]); quad(S2, ct[3], ct[0], cb[0], cb[3]);
      quad(S2, ct[3], ct[2], ct[1], ct[0]);
      piers++;
    }
    const subGeo = new THREE.BufferGeometry();
    subGeo.setAttribute('position', new THREE.Float32BufferAttribute(S2, 3));
    subGeo.computeVertexNormals(); subGeo.computeBoundingSphere();
    // 拱墙两面都画：从低机位能看进拱洞里面
    const subMat = mat.clone(); subMat.side = THREE.DoubleSide; subMat.onBeforeCompile = mat.onBeforeCompile; subMat.customProgramCacheKey = mat.customProgramCacheKey;
    const sub = new THREE.Mesh(subGeo, subMat);
    sub.castShadow = true; sub.receiveShadow = true; sub.matrixAutoUpdate = false; sub.name = 'bridgeArches';
    group.add(sub); disp.push(subGeo, subMat);
  }

  return { group, counts: { deckTris: top.length / 3, edges: edges.length, curbs, piers, spans }, layout: lay, dispose() { for (const d of disp) d.dispose(); } };
}
