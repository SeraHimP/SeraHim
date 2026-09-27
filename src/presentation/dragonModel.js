/**
 * dragonModel.js —— 巨龙造型：一副共用的龙身 + 按元素换装饰与配色。
 *
 * 用户定稿（2026-09-27）："龙的话不需要每种都做一个模型，就是通过装饰 + 龙的颜色区分龙的不同类型"，
 * 选"每种元素一套专属装饰"：炎龙火焰尖刺、潮龙鳍、山龙岩甲、雷龙闪电角、风龙羽翼飘带、暗龙破翼、
 * 毒龙毒囊、霜龙冰棱、铁龙甲片、血龙骨刺、熔龙熔岩裂纹、星龙星点光环、蚀龙浮空碎片；
 * 远古龙更大、多一对角、带金纹。
 *
 * 朝向：直接朝 +Z 建（头在 +Z），与全项目一致。骨骼（unitRig.js）：
 * 对角两条腿一组（LEG_L = 左前 + 右后，LEG_R = 右前 + 左后），双翼扇动，颈 + 头扑咬，尾巴摆。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { BONE, rigPack } from './unitRig.js';

const M4 = () => new THREE.Matrix4();
const T = (x, y, z) => M4().makeTranslation(x, y, z);
const RX = (a) => M4().makeRotationX(a);
const RY = (a) => M4().makeRotationY(a);
const RZ = (a) => M4().makeRotationZ(a);
const SC = (x, y = x, z = x) => M4().makeScale(x, y, z);
const C = (...ms) => ms.reduce((a, m) => a.multiply(m), M4());
const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const Cyl = (rt, rb, h, s = 7) => new THREE.CylinderGeometry(rt, rb, h, s);
const Cone = (r, h, s = 5) => new THREE.ConeGeometry(r, h, s);
const Sph = (r, w = 9, h = 7) => new THREE.SphereGeometry(r, w, h);
const Ico = (r) => new THREE.IcosahedronGeometry(r, 0);
const Oct = (r) => new THREE.OctahedronGeometry(r, 0);
const Dod = (r) => new THREE.DodecahedronGeometry(r, 0);
const Tor = (r, t, rs = 3, ts = 14) => new THREE.TorusGeometry(r, t, rs, ts);
const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
const mix = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();
const hash = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };

/** 两点之间的一节圆柱（龙的翼骨 / 尾节） */
function seg(r, a, b, rad, col) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  const m = M4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  r.add(Cyl(rad * 0.8, rad, len, 5), m, col);
}
/** 翼膜：一组三角形，正反两面都画（单位材质不是双面的） */
function membrane(tris) {
  const pos = [];
  for (const [a, b, c] of tris) pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

class Rig {
  constructor() { this.parts = []; this.cur = { bone: 0, pivot: [0, 0, 0], k: 1 }; }
  add(geo, m, color) { this.parts.push({ geo, matrix: m, color, bone: this.cur.bone, pivot: this.cur.pivot, k: this.cur.k }); }
  on(bone, pivot, k, fn) { const p = this.cur; this.cur = { bone, pivot, k }; fn(); this.cur = p; }
}

/**
 * @param {string} color 龙的颜色（DRAGON_ELEMENTS[el].color / 远古龙色）
 * @param {string|null} element 元素 key（fire / water / …），远古龙传 null
 * @param {boolean} ancient
 * @param {number} S 尺寸（CONFIG.dragonSizes）
 */
export function buildDragon(color, element, ancient, S) {
  const U = CONFIG.ui?.unitModels || {};
  const accent = (U.dragonAccent || {})[ancient ? 'ancient' : element] || mix(color, '#ffffff', 0.5);
  const P = {
    base: color, dark: shade(color, 0.58), mid: shade(color, 0.8), lite: mix(color, '#ffffff', 0.28),
    belly: mix(color, '#f3e6c8', 0.55), accent, horn: ancient ? (U.dragonAccent?.ancient || '#ffd76a') : mix(color, '#efe6d2', 0.7),
    eye: accent, claw: '#e9e1cf',
  };
  const r = new Rig();
  const D = body(r, S, P, element, ancient);
  const deco = DECOR[ancient ? 'ancient' : element];
  if (deco) deco(r, S, P, D);
  return rigPack(r.parts);
}

// ============================================================================
// 共用龙身
// ============================================================================
function body(r, S, P, element, ancient) {
  const bodyY = S * 0.66;
  const D = { bodyY, neck: [0, bodyY + S * 0.14, S * 0.4], head: [0, bodyY + S * 0.5, S * 0.9], tail0: [0, bodyY - S * 0.02, -S * 0.52], shoulder: [S * 0.24, bodyY + S * 0.26, S * 0.14] };
  // 躯干：胸厚、腰细、臀略收
  r.add(Sph(S * 0.4), C(T(0, bodyY + S * 0.04, S * 0.16), SC(0.92, 0.9, 1.15)), P.base);
  r.add(Sph(S * 0.32), C(T(0, bodyY - S * 0.02, -S * 0.3), SC(0.95, 0.88, 1.2)), P.base);
  r.add(Sph(S * 0.3, 8, 5), C(T(0, bodyY - S * 0.18, 0), SC(0.85, 0.45, 1.7)), P.belly);   // 腹甲
  for (let i = 0; i < 4; i++) r.add(Box(S * 0.36 - i * S * 0.04, S * 0.03, S * 0.06), T(0, bodyY - S * 0.28 + i * S * 0.005, S * (0.28 - i * 0.18)), shade(P.belly, 0.85));   // 腹甲横纹

  // 四条腿：大腿 + 小腿 + 爪
  const leg = (sx, sz) => {
    const front = sz > 0;
    const hx = sx * S * 0.24, hz = front ? S * 0.2 : -S * 0.34, hy = bodyY - S * 0.04;
    const diag = (sx > 0) === front ? BONE.LEG_L : BONE.LEG_R;
    r.on(diag, [hx, hy, hz], 0.8, () => {
      r.add(Sph(S * 0.14, 7, 5), C(T(hx, hy - S * 0.08, hz), SC(0.9, 1.4, 1)), P.base);
      r.add(Cyl(S * 0.07, S * 0.085, hy * 0.62, 6), C(T(hx, hy * 0.38, hz + (front ? S * 0.02 : -S * 0.04)), RX(front ? 0.08 : -0.15)), P.mid);
      r.add(Box(S * 0.16, S * 0.07, S * 0.2), T(hx, S * 0.035, hz + S * 0.04), P.dark);
      for (const cx of [-1, 0, 1]) r.add(Cone(S * 0.025, S * 0.09, 4), C(T(hx + cx * S * 0.05, S * 0.03, hz + S * 0.16), RX(Math.PI / 2)), P.claw);
    });
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) leg(sx, sz);

  // 颈 + 头（扑咬骨）
  r.on(BONE.BITE, D.neck, 1, () => {
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      r.add(Sph(S * (0.16 - i * 0.02), 7, 5), T(0, D.neck[1] + (D.head[1] - D.neck[1]) * t * 0.9, D.neck[2] + (D.head[2] - D.neck[2]) * t * 0.85), P.base);
    }
    const [x, y, z] = D.head;
    r.add(Box(S * 0.28, S * 0.22, S * 0.34), C(T(x, y, z), RX(0.12)), P.base);                 // 颅
    r.add(Box(S * 0.2, S * 0.14, S * 0.3), C(T(x, y - S * 0.02, z + S * 0.26), RX(0.18)), P.base);   // 吻
    r.add(Box(S * 0.18, S * 0.06, S * 0.34), C(T(x, y - S * 0.12, z + S * 0.18), RX(0.05)), P.belly);   // 下颌
    for (const sx of [-1, 1]) {
      r.add(Box(S * 0.06, S * 0.04, S * 0.03), T(sx * S * 0.1, y + S * 0.05, z + S * 0.16), P.eye);   // 眼
      r.add(Box(S * 0.03, S * 0.03, S * 0.03), T(sx * S * 0.06, y + S * 0.02, z + S * 0.42), P.dark);   // 鼻孔
      for (let t = 0; t < 2; t++) r.add(Cone(S * 0.015, S * 0.05, 3), C(T(sx * S * 0.07, y - S * 0.1, z + S * (0.3 - t * 0.08)), RX(Math.PI)), P.claw);   // 獠牙
      r.add(Box(S * 0.02, S * 0.06, S * 0.22), C(T(sx * S * 0.14, y + S * 0.11, z - S * 0.02), RX(-0.3)), P.dark);   // 眉骨
    }
  });

  // 双翼：蝙蝠翼——翼臂（肩 → 肘 → 腕）向外向上张开，三根翼指从腕向后下方伸，翼膜连在翼指之间、一直连到身侧
  const span = S * (ancient ? 1.1 : 0.95);
  D.wing = (sx) => {
    const O = new THREE.Vector3(sx * D.shoulder[0], D.shoulder[1], D.shoulder[2]);
    const at = (x, y, z) => new THREE.Vector3(O.x + sx * x * span, O.y + y * span, O.z + z * span);
    return { O, E: at(0.44, 0.24, -0.08), W: at(0.94, 0.3, -0.3), F: [at(1.12, -0.06, -0.72), at(0.8, -0.12, -0.92), at(0.44, -0.08, -0.84)], root: at(0.06, -0.14, -0.64) };
  };
  for (const sx of [-1, 1]) {
    const w = D.wing(sx);
    r.on(BONE.WING, [w.O.x, w.O.y, w.O.z], sx, () => {
      seg(r, w.O, w.E, S * 0.045, P.mid);
      seg(r, w.E, w.W, S * 0.035, P.mid);
      r.add(Cone(S * 0.03, S * 0.12, 4), C(T(w.W.x, w.W.y + S * 0.05, w.W.z), RZ(-sx * 0.4)), P.claw);   // 腕爪
      for (const f of w.F) seg(r, w.W, f, S * 0.02, P.mid);
      const pts = [w.O, w.E, w.W, ...w.F, w.root];
      // 翼膜：以肩为扇心，依次连 肘-腕、腕-指1、指1-指2、指2-指3、指3-身侧
      const tris = [];
      for (let i = 1; i < pts.length - 1; i++) tris.push([w.O, pts[i], pts[i + 1]]);
      r.add(membrane(tris), M4(), P.dark);
    });
  }

  // 尾：沿一条向后下垂、略侧弯的曲线，五节递减（尾巴骨）
  r.on(BONE.TAIL, D.tail0, 1, () => {
    const N = 6, pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push(new THREE.Vector3(S * 0.16 * Math.sin(t * Math.PI), D.tail0[1] - S * 0.46 * Math.sin(t * Math.PI / 2), D.tail0[2] - S * 1.15 * t));
    }
    for (let i = 0; i < N; i++) seg(r, pts[i], pts[i + 1], S * (0.17 - i * 0.022), i % 2 ? P.mid : P.base);
    const tip = pts[N];
    D.tailTip = [tip.x, tip.y, tip.z];
  });
  return D;
}

// ============================================================================
// 各元素装饰
// ============================================================================
const spineAt = (S, D, i, n) => {   // 背脊第 i 个点（从颈根到尾根）
  const t = i / (n - 1);
  return [0, D.bodyY + S * (0.36 - t * 0.14), S * (0.34 - t * 0.78)];
};
const hornPair = (r, S, D, col, len, spread, back = 0.6, seg = 5) => {
  r.on(BONE.BITE, D.neck, 1, () => {
    const [x, y, z] = D.head;
    for (const sx of [-1, 1]) r.add(Cone(S * 0.04, S * len, seg), C(T(sx * S * spread, y + S * 0.16, z - S * 0.1), RX(-back), RZ(-sx * 0.35), T(0, S * len / 2, 0)), col);
  });
};
const tailTip = (r, D, fn) => r.on(BONE.TAIL, D.tail0, 1, () => fn(D.tailTip));

const DECOR = {
  // 炎龙：火焰状背刺（橙底黄尖）、后掠长角、尾端一簇火焰
  fire(r, S, P, D) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n), h = S * (0.34 - Math.abs(i - 2) * 0.04);
      r.add(Cone(S * 0.07, h, 4), C(T(x, y + h / 2, z), RX(-0.35)), P.base);
      r.add(Cone(S * 0.035, h * 0.55, 4), C(T(x, y + h * 0.85, z - h * 0.2), RX(-0.35)), P.accent);
    }
    hornPair(r, S, D, P.horn, 0.34, 0.1, 1.0);
    tailTip(r, D, ([x, y, z]) => { for (let i = 0; i < 3; i++) r.add(Cone(S * 0.07, S * 0.3, 4), C(T(x + (i - 1) * S * 0.06, y + S * 0.08, z - S * 0.06), RX(-1.2 + i * 0.15)), i === 1 ? P.accent : P.base); });
  },
  // 潮龙：一整条背鳍帆、耳鳍、尾端扇形鳍
  water(r, S, P, D) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n), h = S * (0.3 - Math.abs(i - 2) * 0.05);
      r.add(Box(S * 0.02, h, S * 0.2), T(x, y + h / 2, z), i % 2 ? P.accent : P.lite);
    }
    r.on(BONE.BITE, D.neck, 1, () => {
      const [x, y, z] = D.head;
      for (const sx of [-1, 1]) r.add(Box(S * 0.02, S * 0.2, S * 0.26), C(T(sx * S * 0.17, y + S * 0.06, z - S * 0.12), RY(sx * 0.5), RZ(-sx * 0.6)), P.accent);
    });
    tailTip(r, D, ([x, y, z]) => { for (const sx of [-1, 1]) r.add(Box(S * 0.02, S * 0.34, S * 0.3), C(T(x + sx * S * 0.12, y, z - S * 0.1), RZ(sx * 1.1)), P.accent); });
  },
  // 山龙：背上一排岩块、肩头岩甲、钝短角、尾端岩锤
  earth(r, S, P, D) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n);
      r.add(Dod(S * (0.14 - i * 0.012)), C(T(x, y + S * 0.05, z), RY(i)), i % 2 ? P.accent : shade(P.accent, 0.8));
    }
    for (const sx of [-1, 1]) r.add(Dod(S * 0.13), T(sx * S * 0.3, D.bodyY + S * 0.2, S * 0.2), shade(P.accent, 0.9));
    hornPair(r, S, D, shade(P.accent, 1.1), 0.18, 0.1, 0.3, 4);
    tailTip(r, D, ([x, y, z]) => r.add(Dod(S * 0.14), T(x, y, z - S * 0.05), P.accent));
  },
  // 雷龙：折线闪电角、背上一排黄晶、尾端晶刺
  thunder(r, S, P, D) {
    r.on(BONE.BITE, D.neck, 1, () => {
      const [x, y, z] = D.head;
      for (const sx of [-1, 1]) {
        let px = sx * S * 0.1, py = y + S * 0.14, pz = z - S * 0.08;
        for (let k = 0; k < 3; k++) {
          const dx = sx * S * 0.07 * (k % 2 ? -0.4 : 1), dy = S * 0.13, dz = -S * 0.08;
          r.add(Box(S * 0.04, S * 0.16, S * 0.04), C(T(px + dx / 2, py + dy / 2, pz + dz / 2), RZ(-Math.atan2(dx, dy)), RX(0.5)), P.accent);
          px += dx; py += dy; pz += dz;
        }
      }
    });
    const n = 6;
    for (let i = 0; i < n; i++) { const [x, y, z] = spineAt(S, D, i, n); r.add(Oct(S * 0.09), C(T(x, y + S * 0.08, z), SC(0.6, 1.6, 0.6)), P.accent); }
    tailTip(r, D, ([x, y, z]) => r.add(Oct(S * 0.1), C(T(x, y, z - S * 0.08), SC(0.6, 0.6, 1.8)), P.accent));
  },
  // 风龙：翼后缘一排羽片、头冠羽、尾巴两条长飘带
  wind(r, S, P, D) {
    for (const sx of [-1, 1]) {
      const w = D.wing(sx);
      r.on(BONE.WING, [w.O.x, w.O.y, w.O.z], sx, () => {
        // 翼指尖与翼膜后缘挂一排羽片
        const edge = [w.W, ...w.F];
        for (let i = 0; i < edge.length; i++) {
          const p = edge[i];
          r.add(Box(S * 0.014, S * 0.07, S * 0.3), C(T(p.x, p.y, p.z - S * 0.1), RY(sx * 0.3), RX(0.2)), i % 2 ? P.accent : P.lite);
          if (i < edge.length - 1) { const q = p.clone().lerp(edge[i + 1], 0.5); r.add(Box(S * 0.014, S * 0.06, S * 0.24), T(q.x, q.y, q.z - S * 0.1), P.accent); }
        }
      });
    }
    r.on(BONE.BITE, D.neck, 1, () => {
      const [x, y, z] = D.head;
      for (let i = 0; i < 3; i++) r.add(Box(S * 0.015, S * 0.06, S * 0.3), C(T(x + (i - 1) * S * 0.05, y + S * 0.16, z - S * 0.2), RX(-0.5 - Math.abs(i - 1) * 0.2)), P.accent);
    });
    tailTip(r, D, ([x, y, z]) => { for (const sx of [-1, 1]) r.add(Box(S * 0.05, S * 0.012, S * 0.7), C(T(x + sx * S * 0.08, y - S * 0.02, z - S * 0.35), RY(sx * 0.2)), P.accent); });
  },
  // 暗龙：翼膜上的破口（叠几片深色碎片表现撕裂）、弯角、紫色眼光
  dark(r, S, P, D) {
    hornPair(r, S, D, P.dark, 0.36, 0.12, 1.3);
    for (const sx of [-1, 1]) {
      const w = D.wing(sx);
      r.on(BONE.WING, [w.O.x, w.O.y, w.O.z], sx, () => {
        // 翼膜后缘的撕裂：在翼指之间挂几条深色的碎片
        const edge = [...w.F, w.root];
        for (let i = 0; i < edge.length - 1; i++) {
          const q = edge[i].clone().lerp(edge[i + 1], 0.5);
          r.add(Cone(S * 0.07, S * 0.22, 3), C(T(q.x, q.y - S * 0.05, q.z + S * 0.06), RX(Math.PI * 0.85)), shade(P.dark, 0.6));
        }
      });
    }
    const n = 6;
    for (let i = 0; i < n; i++) { const [x, y, z] = spineAt(S, D, i, n); r.add(Cone(S * 0.05, S * 0.2, 3), C(T(x, y + S * 0.1, z), RX(-0.6)), P.accent); }
  },
  // 毒龙：背上一串毒囊、下垂的毒刺
  poison(r, S, P, D) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n);
      r.add(Sph(S * (0.1 - i * 0.008), 7, 5), T(x + (i % 2 ? 1 : -1) * S * 0.06, y + S * 0.06, z), P.accent);
      r.add(Cone(S * 0.03, S * 0.1, 4), C(T(x + (i % 2 ? 1 : -1) * S * 0.06, y - S * 0.02, z + S * 0.08), RX(Math.PI * 0.8)), P.accent);
    }
    hornPair(r, S, D, P.horn, 0.22, 0.1, 0.8);
    tailTip(r, D, ([x, y, z]) => r.add(Sph(S * 0.1, 7, 5), T(x, y, z - S * 0.05), P.accent));
  },
  // 霜龙：背上与头上一簇簇冰棱
  frost(r, S, P, D) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n);
      for (const sx of [-1, 1]) r.add(Oct(S * 0.06), C(T(x + sx * S * 0.07, y + S * 0.1, z), RZ(-sx * 0.35), SC(0.55, 2.2, 0.55)), sx > 0 ? P.accent : P.lite);
    }
    r.on(BONE.BITE, D.neck, 1, () => {
      const [x, y, z] = D.head;
      for (let i = 0; i < 3; i++) r.add(Oct(S * 0.06), C(T(x + (i - 1) * S * 0.09, y + S * 0.2, z - S * 0.08), RZ((1 - i) * 0.4), RX(-0.5), SC(0.5, 2.4, 0.5)), P.accent);
    });
    tailTip(r, D, ([x, y, z]) => r.add(Oct(S * 0.08), C(T(x, y, z - S * 0.1), SC(0.5, 0.5, 2.4)), P.accent));
  },
  // 铁龙：背上一排甲片、头盔、刃形尾
  steel(r, S, P, D) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n);
      r.add(Box(S * 0.34 - i * S * 0.03, S * 0.06, S * 0.16), C(T(x, y + S * 0.04, z), RX(-0.15)), i % 2 ? P.accent : shade(P.accent, 0.8));
      for (const sx of [-1, 1]) r.add(Box(S * 0.03, S * 0.03, S * 0.03), T(x + sx * S * 0.13, y + S * 0.08, z), '#fbfdff');   // 铆钉
    }
    r.on(BONE.BITE, D.neck, 1, () => { const [x, y, z] = D.head; r.add(Box(S * 0.32, S * 0.08, S * 0.3), C(T(x, y + S * 0.13, z), RX(0.1)), P.accent); });
    tailTip(r, D, ([x, y, z]) => r.add(Box(S * 0.03, S * 0.2, S * 0.34), T(x, y, z - S * 0.12), P.accent));
  },
  // 血龙：骨白色的弯骨刺（背、肘）、骨质面甲
  blood(r, S, P, D) {
    const n = 7;
    for (let i = 0; i < n; i++) { const [x, y, z] = spineAt(S, D, i, n); r.add(Cone(S * 0.05, S * 0.26, 4), C(T(x, y + S * 0.1, z), RX(-0.9)), P.accent); }
    for (const sx of [-1, 1]) r.add(Cone(S * 0.04, S * 0.2, 4), C(T(sx * S * 0.34, D.bodyY + S * 0.02, S * 0.24), RZ(-sx * 1.2)), P.accent);
    r.on(BONE.BITE, D.neck, 1, () => { const [x, y, z] = D.head; r.add(Box(S * 0.24, S * 0.12, S * 0.24), C(T(x, y + S * 0.06, z + S * 0.16), RX(0.2)), P.accent); });
    hornPair(r, S, D, P.accent, 0.3, 0.12, 0.9);
  },
  // 熔龙：黑色岩片之间透出橙色熔岩缝
  magma(r, S, P, D) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n);
      r.add(Box(S * 0.3, S * 0.07, S * 0.12), C(T(x, y + S * 0.02, z), RY(hash(i, 3) * 0.3), RX(-0.1)), '#3a2a24');
      r.add(Box(S * 0.26, S * 0.06, S * 0.02), T(x, y + S * 0.03, z - S * 0.07), P.accent);   // 熔岩缝
    }
    for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) r.add(Box(S * 0.02, S * 0.2, S * 0.03), C(T(sx * S * 0.36, D.bodyY + S * 0.02, S * (0.1 - k * 0.3)), RZ(0.4 * (k ? 1 : -1))), P.accent);
    hornPair(r, S, D, '#3a2a24', 0.26, 0.1, 0.7);
    tailTip(r, D, ([x, y, z]) => { r.add(Dod(S * 0.1), T(x, y, z - S * 0.04), '#3a2a24'); r.add(Oct(S * 0.07), T(x, y + S * 0.05, z - S * 0.04), P.accent); });
  },
  // 星龙：背上方一圈缓转的星点 + 一道光环；翼膜上缀星
  astral(r, S, P, D) {
    r.on(BONE.SPIN, [0, 0, 0], 0.7, () => {
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        r.add(Oct(S * 0.05), T(Math.cos(a) * S * 0.55, D.bodyY + S * (0.62 + (i % 2) * 0.1), Math.sin(a) * S * 0.55), P.accent);
      }
    });
    r.on(BONE.BOB, [0, 0, 0], S * 0.04, () => r.add(Tor(S * 0.34, S * 0.02), C(T(0, D.bodyY + S * 0.72, -S * 0.05), RX(Math.PI / 2)), P.accent));
    for (const sx of [-1, 1]) {
      const w = D.wing(sx);
      r.on(BONE.WING, [w.O.x, w.O.y, w.O.z], sx, () => {
        // 翼膜上缀星：在肩-腕-指之间的三角里取几个点，贴在膜面上方一点
        for (let f = 0; f < 6; f++) {
          const a = hash(f, 1), b = hash(f, 2) * (1 - a);
          const tip = w.F[f % 3];
          const q = w.O.clone().multiplyScalar(1 - a - b).add(w.W.clone().multiplyScalar(a)).add(tip.clone().multiplyScalar(b));
          r.add(Oct(S * 0.025), T(q.x, q.y + S * 0.02, q.z), P.accent);
        }
      });
    }
    hornPair(r, S, D, P.accent, 0.28, 0.1, 0.8);
  },
  // 蚀龙：身周绕转的浮空碎片 + 背上一道裂隙
  rift(r, S, P, D) {
    r.on(BONE.SPIN, [0, 0, 0], -0.9, () => {
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * Math.PI * 2;
        r.add(Ico(S * (0.05 + hash(i, 4) * 0.04)), C(T(Math.cos(a) * S * (0.62 + hash(i, 5) * 0.15), D.bodyY + S * (0.2 + hash(i, 6) * 0.5), Math.sin(a) * S * (0.62 + hash(i, 5) * 0.15)), RY(i)), i % 2 ? P.accent : P.dark);
      }
    });
    const n = 5;
    for (let i = 0; i < n; i++) { const [x, y, z] = spineAt(S, D, i, n); r.add(Box(S * 0.04, S * 0.05, S * 0.18), C(T(x, y + S * 0.02, z), RY((i % 2 ? 1 : -1) * 0.4)), P.accent); }
    hornPair(r, S, D, P.dark, 0.3, 0.1, 1.1, 4);
  },
  // 远古龙：两对金角、金色背板、头冠
  ancient(r, S, P, D) {
    hornPair(r, S, D, P.horn, 0.42, 0.1, 1.0);
    hornPair(r, S, D, P.horn, 0.26, 0.15, 0.4);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = spineAt(S, D, i, n), h = S * (0.3 - Math.abs(i - 2) * 0.03);
      r.add(Cone(S * 0.08, h, 4), C(T(x, y + h / 2, z), RX(-0.3), RY(Math.PI / 4)), P.horn);
    }
    r.on(BONE.BITE, D.neck, 1, () => {
      const [x, y, z] = D.head;
      for (let i = 0; i < 5; i++) r.add(Cone(S * 0.025, S * 0.12, 4), T(x + (i - 2) * S * 0.05, y + S * 0.18, z + S * 0.04), P.horn);   // 头冠
    });
    for (const sx of [-1, 1]) r.add(Box(S * 0.02, S * 0.04, S * 0.7), T(sx * S * 0.36, D.bodyY + S * 0.05, 0), P.horn);   // 身侧金纹
    tailTip(r, D, ([x, y, z]) => r.add(Cone(S * 0.08, S * 0.26, 4), C(T(x, y, z - S * 0.1), RX(-Math.PI / 2 - 0.2)), P.horn));
  },
};

export const DRAGON_DECOR_KEYS = Object.keys(DECOR);
