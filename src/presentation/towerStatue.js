/**
 * towerStatue.js —— 防御塔"雕像守卫"造型 + 按部件掉块的损毁。
 *
 * 用户在两个原型里选了 B（石环 + 立柱 + 持杖守卫雕像），并要求：
 *   · "不同损毁程度的模型可以再极端一些"；
 *   · "蓝色的风格为庄重，沉稳。红色的风格为混沌，尖锐。"
 *   · 损毁像英雄联盟那样"掉块"：模型由部件拼成，每档把指定部件整块拿掉。
 *
 * 做法：
 *   ① 建模时把可掉的东西登记成部件（piece）。不登记的是永远在的主体。
 *   ② 每档损毁 = 一份"拿掉哪些部件"的清单，逐档累加（不可逆，与 towerDamageStage 一致）。
 *   ③ 拿掉的部件原位留一截断口（char 色的锯齿残根），部件本身缩小后翻倒在塔脚，
 *      朝它原来所在的方向掉——碎块留在地上，越打越多（用户选的"下落后留在脚下"）。
 *   ④ 水晶 = 炮口，在守卫右手所持的杖顶（偏在身侧，弹道起点跟着它走，见
 *      UnitLayer.muzzleOffsetOf），位置与高度三档一致。杖和头在损毁里都不掉。
 *
 * 部件的几何、落点矩阵都能单独取出来（pieceParts / rubbleMatrix），掉块动画直接复用。
 * 可调的量在 CONFIG.ui.statueTower；这里的尺寸比例是造型本身的具名常量（见 CLAUDE.md 第 2 条边界）。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (a) => new THREE.Matrix4().makeRotationX(a);
const RY = (a) => new THREE.Matrix4().makeRotationY(a);
const RZ = (a) => new THREE.Matrix4().makeRotationZ(a);
const S = (x, y = x, z = x) => new THREE.Matrix4().makeScale(x, y, z);
const C = (...ms) => ms.reduce((a, m) => a.multiply(m), new THREE.Matrix4());
const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const Cy = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s);
const Co = (r, h, s) => new THREE.ConeGeometry(r, h, s);
const Dome = (r) => new THREE.SphereGeometry(r, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();

export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

// 部件包围盒（按每个零件自己的包围盒 8 个角变换后取极值）
export function partsBox(parts) {
  const bb = new THREE.Box3(), v = new THREE.Vector3();
  for (const p of parts) {
    if (!p.geo.boundingBox) p.geo.computeBoundingBox();
    const g = p.geo.boundingBox;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? g.max.x : g.min.x, i & 2 ? g.max.y : g.min.y, i & 4 ? g.max.z : g.min.z).applyMatrix4(p.matrix);
      bb.expandByPoint(v);
    }
  }
  return bb;
}

/** 断口残根：一截顶面被随机往下压的矮块，读作"掰断的"。 */
export function jaggedGeo(w, h, d, seed) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 1, 2).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      const k = Math.round(p.getX(i) / Math.max(w, 1e-3) * 97) * 31 + Math.round(p.getZ(i) / Math.max(d, 1e-3) * 89);
      p.setY(i, p.getY(i) - h * 0.85 * hash01(k, seed));
    }
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 按部件建模。parts 的格式与 UnitMeshFactory.mergeParts 一致：{ geo, matrix, color }。
 */
export class PieceModel {
  constructor(R, cfg = {}) {
    this.R = R; this.cfg = cfg;
    this.base = []; this.pieces = new Map(); this.order = [];
    this._cur = null; this._xf = null; this._prefix = ''; this._parent = null;
  }
  add(geo, m, color) {
    const matrix = this._xf ? this._xf.clone().multiply(m) : m.clone();
    (this._cur ? this._cur.parts : this.base).push({ geo, matrix, color });
  }
  /** 在一个局部坐标系里建一段（雕像整体缩放、平移用它） */
  within(xf, fn) {
    const prev = this._xf;
    this._xf = prev ? prev.clone().multiply(xf) : xf.clone();
    fn();
    this._xf = prev;
  }
  /** 这一段里登记的部件都长在 parent 上 */
  attachedTo(parent, fn) { const prev = this._parent; this._parent = this._prefix + parent; fn(); this._parent = prev; }
  /** 同一个造型函数建多份（例如枢纽的四尊守卫）时，给这一份的部件名加前缀，免得撞名 */
  prefixed(pfx, fn) { const prev = this._prefix; this._prefix = prev + pfx; fn(); this._prefix = prev; }
  /**
   * @param {object} opt stub: 残根占部件包围盒高度的比例（0 = 不留残根，适合斜放的零件，
   *   包围盒会比零件本身大一圈）；cloth: 布料（落地时平躺）；fall: [dx,dz] 指定掉落方向；
   *   parent: 长在哪个部件上——父部件也掉了时不留残根（否则残根悬在半空）
   */
  piece(id, opt, fn) {
    if (typeof opt === 'function') { fn = opt; opt = {}; }
    id = this._prefix + id;
    const p = { id, parts: [], stub: opt.stub ?? 0.3, cloth: !!opt.cloth, fall: opt.fall || null,
                parent: opt.parent != null ? this._prefix + opt.parent : (this._parent ?? null), idx: this.order.length };
    this.pieces.set(id, p); this.order.push(id);
    const prev = this._cur; this._cur = p; fn(); this._cur = prev;
  }
  pieceParts(id) { return this.pieces.get(id)?.parts || []; }

  /**
   * 掉落的分解量：部件中心 c（原位）、落地后中心 dest、落地时的旋转 q 与缩放 s。
   * rubbleMatrix = T(dest) · R(q) · S(s) · T(-c)；掉块动画按这几个量插值。
   */
  rubbleParams(id) {
    const m = this.rubbleMatrix(id);
    const p = this.pieces.get(id);
    const c = new THREE.Vector3(); partsBox(p.parts).getCenter(c);
    const dest = c.clone().applyMatrix4(m);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    m.decompose(pos, q, sc);
    return { c, dest, q, s: sc.x };
  }

  /** 这块掉下去之后躺在哪：把部件原位几何变换到塔脚地面上的矩阵（与原 parts 矩阵左乘）。 */
  rubbleMatrix(id) {
    const p = this.pieces.get(id);
    if (!p) return new THREE.Matrix4();
    const R = this.R, cfg = this.cfg, n = p.idx;
    const bb = partsBox(p.parts), c = new THREE.Vector3(); bb.getCenter(c);
    let dx = c.x, dz = c.z; const L = Math.hypot(dx, dz);
    if (p.fall) [dx, dz] = p.fall;
    else if (L < R * 0.08) { const a = hash01(n, 13) * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
    else { dx /= L; dz /= L; }
    const spread = (hash01(n, 11) - 0.5) * 0.9;
    const fx = dx * Math.cos(spread) - dz * Math.sin(spread), fz = dx * Math.sin(spread) + dz * Math.cos(spread);
    const [d0, d1] = cfg.rubbleDist || [1.0, 1.45];
    const dist = R * (d0 + (d1 - d0) * hash01(n, 7));
    const sc = cfg.rubbleScale ?? 0.72;
    const rot = p.cloth
      ? C(RY(hash01(n, 3) * 6.28), RX(Math.PI / 2 - 0.08), S(sc))
      : C(RY(hash01(n, 3) * 6.28), RZ(0.9 + hash01(n, 5)), RX(0.5), S(sc));
    const m = C(rot, T(-c.x, -c.y, -c.z));
    const tb = partsBox(p.parts.map((q) => ({ geo: q.geo, matrix: m.clone().multiply(q.matrix) })));
    return C(T(fx * dist, -tb.min.y, fz * dist), m);
  }

  stubParts(id, seed = 0) {
    const p = this.pieces.get(id);
    if (!p || !(p.stub > 0)) return [];
    const bb = partsBox(p.parts);
    const w = bb.max.x - bb.min.x, h = (bb.max.y - bb.min.y) * p.stub, d = bb.max.z - bb.min.z;
    const col = p.parts[0].color;
    return [{ geo: jaggedGeo(w * 0.94, h, d * 0.94, p.idx + seed),
              matrix: T((bb.min.x + bb.max.x) / 2, bb.min.y + h / 2, (bb.min.z + bb.max.z) / 2),
              color: shade(col, this.cfg.stubShade ?? 0.5) }];
  }

  /**
   * 拼出一个状态的全部零件。
   * @param {string[]} removed 拿掉的部件
   * @param {Set<string>|null} [noRubble] 这些拿掉的部件先不画碎块（掉块动画进行中，碎块由动画画）
   */
  parts(removed = [], noRubble = null, noStubs = false) {
    const out = [...this.base], gone = new Set(removed);
    for (const id of this.order) {
      const p = this.pieces.get(id);
      if (!gone.has(id)) { out.push(...p.parts); continue; }
      if (!noStubs && !(p.parent && gone.has(p.parent))) out.push(...this.stubParts(id));
      if (noRubble && noRubble.has(id)) continue;
      const rm = this.rubbleMatrix(id);
      for (const q of p.parts) out.push({ geo: q.geo, matrix: rm.clone().multiply(q.matrix), color: q.color });
    }
    return out;
  }
}

// ==================== 造型 ====================
// 以用户选定的原型 B 为准（"我还是觉得最初你做的那个雕像模型更好，参照这个做"）：
// 八角石台 + 一圈立石 + 立柱 + 柱头上的守卫雕像，右手持杖立在身侧，攻击水晶悬在杖顶。
// 外塔就是原型本身；档位越高立柱越高、石台多一级、外侧加方尖碑、最高档背后加光环。

const TIERS = ['outer', 'inner', 'base', 'hq_tower'];

/** 雕像与建筑各部分的颜色：石头跟随地图调色板（F），雕像/甲/布/金属按阵营取 CONFIG.ui.statueTower.colors */
export function statueColors(faction, F) {
  const cfg = CONFIG.ui?.statueTower || {};
  const pal = (cfg.colors || {})[faction === 'red' ? 'red' : faction === 'blue' ? 'blue' : 'neutral'] || {};
  return {
    stone: F.stone, trim: F.trim,
    statue: pal.statue || '#d9e0ea', armor: pal.armor || '#3f78c4', cloth: pal.cloth || pal.armor || '#3f78c4',
    metal: pal.metal || '#eaf2fd', dark: pal.dark || shade(pal.statue || '#d9e0ea', 0.45),
  };
}

/**
 * @param {number} R 建筑显示半径（CONFIG.buildingSizes）
 * @param {string} tier outer / inner / base / hq_tower
 * @param {string} faction blue / red / neutral
 * @param {{stone:string, trim:string}} F 石色（跟随地图调色板）
 * @returns {{ model: PieceModel, stages: string[][], ruin: object[],
 *            crystalCy: number, crystalR: number, crystalX: number, crystalZ: number }}
 *   crystalX/Z 是水晶相对塔中心的水平偏移（模型坐标，+z = 塔的正面），炮口跟着它走。
 */
export function statueTower(R, tier, faction, F) {
  const cfg = CONFIG.ui?.statueTower || {};
  const ti = Math.max(0, TIERS.indexOf(tier));
  const tk = TIERS[ti];
  const red = faction === 'red';
  const col = statueColors(faction, F);
  const m = new PieceModel(R, cfg);
  const K = (cfg.statueScale || {})[tk] ?? 1.45;
  const colExtra = R * ((cfg.columnExtra || {})[tk] ?? 0);

  // ---- 石台 + 立石圈 ----
  const y0 = red ? chaosBase(m, R, ti, col) : orderBase(m, R, ti, col);
  // ---- 立柱：柱脚 + 下段鼓石 + 上段鼓石（可掉）+ 队伍色箍 + 柱头 ----
  const seg = red ? 5 : 8;
  const lowH = R * 0.45 + colExtra / 2, upH = R * 0.45 + colExtra / 2;
  m.add(Cy(R * 0.36, R * 0.44, R * 0.16, seg), T(0, y0 + R * 0.08, 0), shade(col.stone, 0.7));
  let y = y0 + R * 0.16;
  m.add(Cy(R * 0.32, R * 0.34, lowH, seg), C(T(0, y + lowH / 2, 0), RY(red ? 0.3 : 0)), shade(col.stone, 0.84));
  y += lowH;
  m.add(Cy(R * 0.33, R * 0.33, R * 0.08, seg), T(0, y, 0), col.armor);
  m.add(Cy(R * 0.22, R * 0.22, upH, seg), T(0, y + upH / 2, 0), shade(col.stone, 0.4));      // 上段芯：鼓石崩掉后露出来
  m.piece('drumTop', { stub: 0.35 }, () =>
    m.add(Cy(R * 0.3, R * 0.32, upH, seg), C(T(0, y + upH / 2, 0), RY(red ? -0.35 : 0)), shade(col.stone, 0.86)));
  y += upH;
  m.add(red ? Cy(R * 0.5, R * 0.34, R * 0.14, 5) : Cy(R * 0.48, R * 0.36, R * 0.14, 8), C(T(0, y + R * 0.07, 0), RY(red ? 0.5 : 0)), shade(col.trim, 0.82));
  const standY = y + R * 0.14;

  // ---- 雕像（局部坐标：脚底 y=0，单位 = R，整体放大 K 倍）----
  const SM = C(T(0, standY, 0), S(K * R));
  let staff = null;
  m.within(SM, () => { staff = red ? chaosStatue(m, col, ti) : orderStatue(m, col, ti); });
  const cp = new THREE.Vector3(staff.x, staff.top, staff.z).applyMatrix4(SM);
  const crystalR = R * (0.22 + ti * 0.02);
  // 水晶悬在托爪尖之上一点点：高度由托爪实际多高算出来（红方叉刃比蓝方托爪长），不写死
  const prongTop = Math.max(...m.order.filter((id) => /^prong\d$/.test(id)).map((id) => partsBox(m.pieceParts(id)).max.y));
  cp.y = prongTop + crystalR * (cfg.crystalLift ?? 1.05);

  const L = red ? chaosStages() : orderStages();
  const has = (id) => m.pieces.has(id);
  const s1 = L.light.filter(has), s2 = [...s1, ...L.heavy.filter(has)];
  return {
    model: m, stages: [[], s1, s2], ruin: rubblePile(m, R, col, { stump: true, twist: red ? 0.6 : 0.4 }),
    crystalCy: cp.y, crystalR, crystalX: cp.x, crystalZ: cp.z,
  };
}

// ---------- 蓝方：庄重、沉稳（对称、方正、竖直） ----------

function orderBase(m, R, ti, col) {
  let y = 0;
  if (ti >= 2) {   // 高地塔起：下面多垫一级更宽的台
    m.add(Cy(R * 1.1, R * 1.18, R * 0.1, 8), C(T(0, R * 0.05, 0), RY(Math.PI / 8)), shade(col.stone, 0.55));
    y = R * 0.1;
  }
  m.add(Cy(R * 0.98, R * 1.08, R * 0.16, 8), T(0, y + R * 0.08, 0), shade(col.stone, 0.62));
  const top = y + R * 0.16;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * R * 0.86, z = Math.sin(a) * R * 0.86;
    m.piece(`ring${i}`, { stub: 0.35 }, () => {
      m.add(B(R * 0.46, R * 0.3, R * 0.15), C(T(x, top + R * 0.15, z), RY(-a + Math.PI / 2)), shade(col.stone, 0.74 + hash01(i, 2) * 0.1));
      m.add(B(R * 0.5, R * 0.05, R * 0.19), C(T(x, top + R * 0.32, z), RY(-a + Math.PI / 2)), shade(col.trim, 0.8));
    });
  }
  if (ti >= 2) {   // 四座方尖碑（对角）
    const h = R * (ti >= 3 ? 1.15 : 0.9);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + Math.PI / 4;
      const x = Math.cos(a) * R * 1.02, z = Math.sin(a) * R * 1.02;
      m.piece(`obelisk${i}`, { stub: 0.3 }, () => {
        m.add(Cy(R * 0.07, R * 0.1, h, 4), C(T(x, h / 2, z), RY(Math.PI / 4)), shade(col.stone, 0.82));
        m.add(Co(R * 0.09, R * 0.18, 4), C(T(x, h + R * 0.09, z), RY(Math.PI / 4)), col.armor);
      });
    }
  }
  return top;
}

export function orderStatue(m, col, ti) {
  const { statue, armor, cloth, metal, dark } = col;
  m.add(Cy(0.22, 0.34, 0.56, 8), T(0, 0.28, 0), shade(statue, 0.86));   // 袍摆
  m.piece('torso', { stub: 0 }, () => {
    m.add(Cy(0.3, 0.23, 0.46, 6), T(0, 0.79, 0), dark);
    m.add(Cy(0.24, 0.24, 0.07, 8), T(0, 0.58, 0), shade(metal, 0.7));   // 腰带
    m.add(Cy(0.09, 0.11, 0.1, 6), T(0, 1.08, 0), dark);                 // 脖子
  });
  m.attachedTo('torso', () => {
    for (const s of [-1, 1]) {
      m.piece(`chest${s}`, { stub: 0.2 }, () => {
        m.add(B(0.26, 0.38, 0.1), C(T(s * 0.13, 0.82, 0.18), RY(s * 0.25)), shade(armor, 1.25));
        m.add(B(0.28, 0.05, 0.11), C(T(s * 0.13, 1.0, 0.19), RY(s * 0.25)), metal);
        m.add(B(0.22, 0.28, 0.1), C(T(s * 0.13, 0.82, -0.18), RY(-s * 0.25)), shade(statue, 0.88));
      });
    }
    const hy = 1.1;
    m.piece('hood', { stub: 0.2 }, () => {
      m.add(Cy(0.13, 0.19, 0.26, 6), T(0, hy + 0.13, 0), shade(statue, 0.92));
      m.add(B(0.13, 0.13, 0.06), T(0, hy + 0.09, 0.15), shade(dark, 0.45));
    });
    m.attachedTo('hood', () => m.piece('hoodTip', { stub: 0 }, () => m.add(Co(0.14, 0.28, 6), C(T(0, hy + 0.38, -0.03), RX(-0.25)), shade(statue, 0.92))));
    for (const s of [-1, 1]) {
      const sx = s * 0.36, sy = 0.97;
      m.piece(`arm${s}`, { stub: 0 }, () => {
        m.add(B(0.13, 0.42, 0.13), C(T(sx + s * 0.04, sy - 0.28, s > 0 ? 0.08 : 0), RZ(s * 0.12), RX(s > 0 ? -0.5 : 0)), dark);
        m.add(B(0.15, 0.13, 0.15), T(sx + s * 0.07, sy - 0.52, s > 0 ? 0.24 : 0), shade(statue, 0.8));
      });
      m.piece(`pauldron${s}`, { stub: 0 }, () => m.add(Dome(0.2), C(T(sx, sy, 0), S(1.15, 0.85, 1.05), RZ(-s * 0.35)), statue));
      m.attachedTo(`pauldron${s}`, () => {
        const nPl = ti >= 2 ? 3 : 2;
        for (let p = 1; p <= nPl; p++) {
          m.piece(`plate${s}_${p}`, { stub: 0 }, () => m.add(B(0.3, 0.06, 0.34 - p * 0.03), C(T(sx + s * (0.06 + p * 0.065), sy - (0.04 + p * 0.085), 0), RZ(-s * (0.45 + p * 0.12))), p % 2 ? metal : armor));
        }
      });
    }
    // 布：前襟两条、背后披风三条（高地塔起四条）
    const strip = (id, x, z, w, h, back) => m.piece(id, { stub: 0.15, cloth: true }, () => {
      m.add(B(w, h, 0.03), C(T(x, 0.57 - h / 2, z), RX(back ? 0.18 : -0.12)), cloth);
      m.add(B(w * 0.6, 0.07, 0.035), T(x, 0.57 - h * 0.35, z + (back ? -0.01 : 0.01)), metal);
    });
    strip('clothF-1', -0.1, 0.3, 0.16, 0.56, false);
    strip('clothF1', 0.1, 0.3, 0.16, 0.5, false);
    const nCloak = ti >= 2 ? 4 : 3;
    for (let i = 0; i < nCloak; i++) {
      const x = (i - (nCloak - 1) / 2) * 0.36 / (nCloak - 1) * 1.0;
      strip(`cloak${i}`, x, -0.34, 0.36 / (nCloak - 1) * 0.95, 0.8 + (i % 2) * 0.1, true);
    }
    if (ti >= 3) m.piece('halo', { stub: 0 }, () => m.add(new THREE.TorusGeometry(0.36, 0.035, 4, 14), T(0, 1.22, -0.24), metal));
  });
  // 杖：右手握着立在身侧，杖头三根托爪托住水晶
  const tx = 0.47, tz = 0.28, top = 1.31;
  m.add(Cy(0.032, 0.032, 1.3, 5), T(tx, 0.66, tz), shade(metal, 0.6));
  m.add(Cy(0.032, 0.032, 0.3, 5), T(tx, top - 0.15, tz), shade(metal, 0.6));
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2;
    m.piece(`prong${i}`, { stub: 0 }, () => m.add(B(0.045, 0.26, 0.045), C(T(tx + Math.cos(a) * 0.07, top + 0.12, tz + Math.sin(a) * 0.07), RY(-a), RZ(-0.4)), shade(metal, 0.95)));
  }
  return { x: tx, z: tz, top };
}

// 逐档累加。重损是"极端"那一档：左肩连手臂整个没了、胸甲碎了、杖头托爪断一根、大半布料和立石都没了。
// 头不掉（用户："重损雕像的头不要掉"），杖也不断——水晶始终在杖顶。
function orderStages() {
  return {
    light: ['plate-1_3', 'plate-1_2', 'plate-1_1', 'clothF-1', 'cloak2', 'ring1', 'ring5', 'obelisk0'],
    heavy: ['pauldron-1', 'arm-1', 'chest-1', 'prong1', 'cloak0', 'cloak3', 'clothF1', 'plate1_2', 'plate1_3',
            'ring2', 'ring6', 'ring7', 'drumTop', 'obelisk2', 'halo'],
  };
}

// ---------- 红方：混沌、尖锐（不对称、倾斜、尖角），结构与蓝方一一对应 ----------

function chaosBase(m, R, ti, col) {
  let y = 0;
  if (ti >= 2) {
    m.add(Cy(R * 1.0, R * 1.14, R * 0.12, 5), C(T(-R * 0.04, R * 0.06, R * 0.03), RY(0.7)), shade(col.stone, 0.52));
    y = R * 0.12;
  }
  m.add(Cy(R * 0.94, R * 1.06, R * 0.16, 7), C(T(R * 0.03, y + R * 0.08, -R * 0.02), RY(0.2)), shade(col.stone, 0.6));
  const top = y + R * 0.16;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + 0.3 + (hash01(i, 21) - 0.5) * 0.35;
    const r = R * (0.8 + hash01(i, 22) * 0.1);
    const hh = R * (0.38 + hash01(i, 23) * 0.34);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    m.piece(`ring${i}`, { stub: 0.3 }, () => {
      m.add(Co(R * 0.13, hh, 4), C(T(x, top + hh / 2 - R * 0.04, z), RZ(Math.cos(a) * -0.3), RX(Math.sin(a) * 0.3), RY(hash01(i, 24) * 3)), shade(col.stone, 0.66 + hash01(i, 25) * 0.14));
      m.add(Co(R * 0.06, hh * 0.55, 3), C(T(x * 1.06, top + hh * 0.22, z * 1.06), RZ(Math.cos(a) * -0.75), RX(Math.sin(a) * 0.75)), shade(col.armor, 0.75));
    });
  }
  if (ti >= 2) {   // 四根外弯的角（对应蓝方方尖碑）
    const hh = R * (ti >= 3 ? 1.15 : 0.9);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + 0.9;
      const x = Math.cos(a) * R * 0.98, z = Math.sin(a) * R * 0.98;
      m.piece(`obelisk${i}`, { stub: 0.25 }, () => {
        m.add(Co(R * 0.11, hh * 0.62, 4), C(T(x, hh * 0.31, z), RZ(Math.cos(a) * 0.22), RX(-Math.sin(a) * 0.22)), shade(col.dark, 1.4));
        m.add(Co(R * 0.065, hh * 0.5, 4), C(T(x * 0.9, hh * 0.8, z * 0.9), RZ(Math.cos(a) * -0.55), RX(Math.sin(a) * 0.55)), col.armor);
      });
    }
  }
  return top;
}

export function chaosStatue(m, col, ti) {
  const { statue, armor, cloth, metal, dark } = col;
  m.add(Cy(0.2, 0.34, 0.56, 5), C(T(0, 0.28, 0), RY(0.3)), shade(statue, 0.9));
  // 上身前倾、略向左扭
  const lean = C(T(0, 0.56, 0), RX(0.16), RZ(0.07), T(0, -0.56, 0));
  m.within(lean, () => {
    m.piece('torso', { stub: 0 }, () => {
      m.add(Cy(0.32, 0.21, 0.46, 5), C(T(0, 0.79, 0), RY(0.25)), dark);
      m.add(Cy(0.24, 0.24, 0.07, 5), T(0, 0.58, 0), shade(armor, 0.8));
      for (let i = 0; i < 3; i++) m.add(Co(0.045, 0.24, 3), C(T((i - 1) * 0.1, 0.92, -0.2), RX(-0.95)), metal);   // 背刺
      m.add(Cy(0.08, 0.1, 0.1, 5), T(0, 1.07, 0), dark);
    });
    m.attachedTo('torso', () => {
      for (const s of [-1, 1]) {
        m.piece(`chest${s}`, { stub: 0.2 }, () => {
          m.add(B(0.24, 0.36, 0.09), C(T(s * 0.13, 0.82, 0.18), RY(s * 0.3), RZ(s * 0.1)), armor);
          m.add(Co(0.045, 0.16, 3), C(T(s * 0.13, 0.84, 0.25), RX(Math.PI / 2)), metal);
          m.add(B(0.22, 0.28, 0.1), C(T(s * 0.13, 0.82, -0.18), RY(-s * 0.3)), shade(statue, 0.9));
        });
      }
      const hy = 1.1;
      m.piece('hood', { stub: 0.2 }, () => {   // 角盔（不是兜帽）
        m.add(Cy(0.12, 0.16, 0.24, 5), C(T(0, hy + 0.12, 0), RY(0.3)), shade(statue, 1.1));
        m.add(Co(0.1, 0.18, 4), C(T(0, hy + 0.06, 0.15), RX(Math.PI / 2 + 0.35)), shade(dark, 0.7));
        m.add(B(0.13, 0.03, 0.03), T(0, hy + 0.13, 0.15), armor);
      });
      m.attachedTo('hood', () => m.piece('hoodTip', { stub: 0 }, () => {
        m.add(Co(0.055, 0.4, 4), C(T(-0.16, hy + 0.34, 0), RZ(0.75)), metal);
        m.add(Co(0.045, 0.24, 4), C(T(0.14, hy + 0.3, 0), RZ(-0.85)), metal);
      }));
      for (const s of [-1, 1]) {
        const big = s < 0;
        const sx = s * 0.36, sy = 0.97;
        m.piece(`arm${s}`, { stub: 0 }, () => {
          m.add(B(0.13, 0.42, 0.13), C(T(sx + s * 0.04, sy - 0.28, s > 0 ? 0.08 : 0), RZ(s * 0.14), RX(s > 0 ? -0.5 : 0)), dark);
          m.add(Co(0.09, 0.16, 4), C(T(sx + s * 0.07, sy - 0.52, s > 0 ? 0.24 : 0), RX(Math.PI)), shade(statue, 0.8));   // 爪
        });
        m.piece(`pauldron${s}`, { stub: 0 }, () => m.add(Cy(0.07, big ? 0.25 : 0.19, big ? 0.2 : 0.15, 5), C(T(sx, sy, 0), RZ(-s * 0.4)), statue));
        m.attachedTo(`pauldron${s}`, () => {
          const nSp = big ? (ti >= 2 ? 4 : 3) : 2;
          for (let p = 1; p <= nSp; p++) {
            m.piece(`plate${s}_${p}`, { stub: 0 }, () => m.add(Co(0.05, big ? 0.36 : 0.24, 4),
              C(T(sx + s * (p - 1) * 0.04, sy + 0.1, (p - (nSp + 1) / 2) * 0.1), RZ(-s * (0.45 + p * 0.16)), RX((p - (nSp + 1) / 2) * 0.35)), p % 2 ? metal : armor));
          }
        });
      }
      // 破布：参差不齐，末端是尖角
      const rag = (id, x, z, w, h, back, tilt) => m.piece(id, { stub: 0.15, cloth: true }, () => {
        m.add(B(w, h * 0.72, 0.03), C(T(x, 0.57 - h * 0.36, z), RX(back ? 0.18 : -0.12), RZ(tilt)), cloth);
        m.add(Co(w * 0.55, h * 0.3, 3), C(T(x - tilt * h * 0.72, 0.57 - h * 0.87, z), RX(back ? 0.18 : -0.12), RZ(tilt), RX(Math.PI), S(1, 1, 0.12)), cloth);
      });
      rag('clothF-1', -0.1, 0.3, 0.14, 0.6, false, 0.1);
      rag('clothF1', 0.11, 0.3, 0.12, 0.42, false, -0.14);
      const nCloak = ti >= 2 ? 4 : 3;
      for (let i = 0; i < nCloak; i++) {
        const x = (i - (nCloak - 1) / 2) * 0.36 / (nCloak - 1);
        rag(`cloak${i}`, x, -0.34, 0.14, 0.6 + hash01(i, 31) * 0.4, true, (hash01(i, 32) - 0.5) * 0.45);
      }
      if (ti >= 3) {   // 最高档：头后一圈放射状尖角冠（对应蓝方光环）
        m.piece('halo', { stub: 0 }, () => {
          for (let i = 0; i < 7; i++) {
            const a = -Math.PI / 2 + (i - 3) * 0.4;
            m.add(Co(0.045, 0.3 + (i % 2) * 0.14, 3), C(T(Math.cos(a) * 0.28, 1.22 - Math.sin(a) * 0.28, -0.24), RZ(a + Math.PI / 2)), i % 2 ? armor : metal);
          }
        });
      }
    });
  });
  // 杖：锯齿长矛，右手握着立在身侧；杖头是不对称的叉刃
  const tx = 0.47, tz = 0.28, top = 1.31;
  m.add(Cy(0.03, 0.04, 1.3, 5), T(tx, 0.66, tz), shade(metal, 0.55));
  m.add(Cy(0.028, 0.03, 0.3, 5), T(tx, top - 0.15, tz), shade(metal, 0.55));
  m.piece('prong0', { stub: 0 }, () => m.add(Co(0.035, 0.36, 3), C(T(tx - 0.08, top + 0.1, tz), RZ(0.5)), metal));
  m.piece('prong1', { stub: 0 }, () => m.add(Co(0.03, 0.26, 3), C(T(tx + 0.08, top + 0.06, tz), RZ(-0.75)), metal));
  m.piece('prong2', { stub: 0 }, () => m.add(Co(0.025, 0.18, 3), C(T(tx, top - 0.1, tz + 0.06), RX(0.9)), armor));
  return { x: tx, z: tz, top };
}

function chaosStages() {
  return {
    light: ['plate-1_4', 'plate-1_3', 'plate-1_1', 'clothF-1', 'cloak2', 'ring1', 'ring4', 'obelisk0'],
    heavy: ['pauldron-1', 'arm-1', 'chest-1', 'prong2', 'cloak0', 'cloak3', 'clothF1', 'plate1_1', 'plate1_2',
            'ring2', 'ring5', 'ring6', 'drumTop', 'obelisk2', 'halo'],
  };
}

// ---------- 废墟：倒塌的塔 = 一堆碎石 ----------
// 用户："塔废墟的模型就是一个倒塌的塔的碎石堆。"
// 石台还在（开裂），立柱只剩一截断桩，中间一座不规则的碎石丘；雕像和立柱的碎块堆在丘上，
// 越靠中间越高——读作"整座塔塌下来堆在原地"，而不是"塔还站着、旁边撒了一圈石头"。
/**
 * @param {object} opts keepBelow: 主体里低于这个高度（× R）的零件留在原地（石台）；stump: 中间留一截断桩；
 *   twist: 断桩转角；spread / moundHeight 覆盖配置
 */
export function rubblePile(m, R, col, opts = {}) {
  const cfg = m.cfg.ruin || {};
  const keep = R * (opts.keepBelow ?? 0.5);
  const out = [...m.base.filter((p) => partsBox([p]).max.y <= keep)];   // 只留石台（高过台面的主体都塌了）
  const mound = opts.moundHeight ?? cfg.moundHeight ?? 0.42, spread = opts.spread ?? cfg.spread ?? 0.95;
  // 碎石丘：一个不规则的低锥，顶点随机起伏
  const g = new THREE.ConeGeometry(R * spread, R * mound, 9, 2).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 13) * 31 + Math.round(p.getZ(i) * 17) + Math.round(p.getY(i) * 7) * 7;
    if (p.getY(i) < R * mound / 2 - 1e-3) { p.setX(i, p.getX(i) * (0.85 + hash01(k, 1) * 0.3)); p.setZ(i, p.getZ(i) * (0.85 + hash01(k, 2) * 0.3)); }
    p.setY(i, p.getY(i) + (hash01(k, 3) - 0.5) * R * 0.08);
  }
  g.computeVertexNormals();
  const baseTop = partsBox(out).max.y;
  out.push({ geo: g, matrix: T(0, baseTop + R * mound / 2 - R * 0.04, 0), color: shade(col.stone, 0.62) });
  // 断桩
  if (opts.stump) out.push({ geo: jaggedGeo(R * 0.6, R * 0.5, R * 0.6, 77), matrix: C(T(R * 0.05, baseTop + R * 0.25, -R * 0.04), RY(opts.twist ?? 0.4)), color: shade(col.stone, 0.72) });
  // 所有部件 + 雕像主体、鼓石：倒在丘上
  const heapH = (r) => baseTop + R * mound * Math.max(0, 1 - r / (R * spread)) - R * 0.02;
  const all = [...m.order];
  let k = 0;
  for (const id of all) {
    const pc = m.pieces.get(id);
    if (!pc.parts.length) continue;
    const bb = partsBox(pc.parts), c = new THREE.Vector3(); bb.getCenter(c);
    const a = hash01(k, 41) * Math.PI * 2, r = R * spread * Math.sqrt(hash01(k, 42)) * 0.9;
    const sc = opts.pieceScale ?? cfg.pieceScale ?? 0.8;
    const rot = pc.cloth ? C(RY(hash01(k, 43) * 6.28), RX(Math.PI / 2 - 0.1), S(sc))
                         : C(RY(hash01(k, 43) * 6.28), RZ(hash01(k, 44) * 2.4), RX(hash01(k, 45) * 1.2), S(sc));
    const mm = C(rot, T(-c.x, -c.y, -c.z));
    const tb = partsBox(pc.parts.map((q) => ({ geo: q.geo, matrix: mm.clone().multiply(q.matrix) })));
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const place = C(T(x, heapH(r) - tb.min.y - (tb.max.y - tb.min.y) * 0.3, z), mm);
    for (const q of pc.parts) out.push({ geo: q.geo, matrix: place.clone().multiply(q.matrix), color: shade(q.color, 0.85) });
    k++;
  }
  // 额外的石块：立柱与雕像身体碎成的方块，堆满丘面
  const nBlocks = opts.blocks ?? cfg.blocks ?? 16;
  for (let i = 0; i < nBlocks; i++) {
    const a = hash01(i, 51) * Math.PI * 2, r = R * spread * Math.sqrt(hash01(i, 52));
    const sz = R * (0.12 + hash01(i, 53) * 0.16);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    out.push({ geo: B(sz, sz * 0.8, sz * 0.9), matrix: C(T(x, heapH(r) + sz * 0.2, z), RY(hash01(i, 54) * 6), RZ(hash01(i, 55) * 1.2), RX(hash01(i, 56))),
               color: i % 4 === 0 ? shade(col.statue, 0.8) : shade(col.stone, 0.66 + hash01(i, 57) * 0.2) });
  }
  return out;
}
