/**
 * crystalShrines.js —— 召唤水晶 / 水晶枢纽的造型（按部件掉块，与雕像塔同一套 PieceModel）。
 *
 * 用户："水晶枢纽/召唤水晶的模型需要完全推倒重来，重新做。"看过两组方案后定稿：
 *   · 召唤水晶 = 三尊跪姿守卫面朝中间、双手举起托住水晶（封印）；
 *   · 水晶枢纽 = 守卫圣殿：两级八角台，四角各站一尊与塔同款的持杖守卫（背对巨晶），
 *     中间一圈短柱围着巨晶。
 * 造型语言与雕像塔一致：蓝方庄重、沉稳（对称、方正），红方混沌、尖锐（尖角、倾斜、不对称）。
 *
 * 攻击水晶在中轴上（炮口不偏），大小与高度三档一致；损毁时水晶本身也缺角（chippedCrystal）。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { PieceModel, hash01, orderStatue, chaosStatue, statueColors, rubblePile } from './towerStatue.js';

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

/** 面朝圆心 / 背朝圆心的 Y 旋转（局部 +z 指向圆心 / 指向外） */
const faceIn = (a) => Math.atan2(-Math.cos(a), -Math.sin(a));
const faceOut = (a) => Math.atan2(Math.cos(a), Math.sin(a));

/**
 * 损毁时攻击水晶本身也缺角：把某个方向上的顶点往中心压（同一方向的顶点一起动，面不会裂开）。
 * 形状只由 (kind, r, dmg) 决定，可缓存。
 */
export function chippedCrystal(kind, r, dmg) {
  const g = (kind === 'gem' ? new THREE.OctahedronGeometry(r) : new THREE.IcosahedronGeometry(r, 0)).toNonIndexed();
  if (dmg > 0) {
    const cfg = CONFIG.ui?.crystalShrine || {};
    const dents = dmg === 1 ? (cfg.dentsLight || [[0.6, 0.7, 0.4, 0.62]])
                            : (cfg.dentsHeavy || [[0.6, 0.7, 0.4, 0.5], [-0.7, -0.2, 0.6, 0.62], [0, 1, 0, 0.55]]);
    // 每个缺口压的是"离这个方向最近的那个角"——八面体只有 6 个角，用固定阈值会一个都挑不中
    const p = g.attributes.position, v = new THREE.Vector3(), d = new THREE.Vector3();
    const dirs = [];
    for (let i = 0; i < p.count; i++) dirs.push(v.fromBufferAttribute(p, i).clone().normalize());
    const scale = new Float32Array(p.count).fill(1);
    for (const [dx, dy, dz, k] of dents) {
      d.set(dx, dy, dz).normalize();
      const best = Math.max(...dirs.map((u) => u.dot(d)));
      dirs.forEach((u, i) => { if (u.dot(d) >= best - 1e-4) scale[i] = Math.min(scale[i], k); });
    }
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).multiplyScalar(scale[i]);
      p.setXYZ(i, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

/**
 * @param {'orb'|'gem'} kind orb = 召唤水晶，gem = 水晶枢纽
 * @param {number} R 建筑显示半径
 * @param {string} faction
 * @param {{stone,trim}} F 石色（跟随地图调色板）
 * @returns {{ model, stages: string[][], ruin: object[], crystalCy: number, crystalR: number }}
 */
export function crystalShrine(kind, R, faction, F) {
  const col = statueColors(faction, F);
  const m = new PieceModel(R, CONFIG.ui?.statueTower || {});
  const red = faction === 'red';
  const r = kind === 'gem' ? nexusTemple(m, R, col, red) : inhibBearers(m, R, col, red);
  const has = (id) => m.pieces.has(id);
  const s1 = r.light.filter(has), s2 = [...s1, ...r.heavy.filter(has)];
  const rc = CONFIG.ui?.crystalShrine?.ruin || {};
  return { model: m, stages: [[], s1, s2], crystalCy: r.crystalCy, crystalR: r.crystalR,
           ruin: rubblePile(m, R, col, { keepBelow: r.keepBelow, moundHeight: r.moundHeight, spread: rc.spread ?? 1.0, blocks: rc.blocks ?? 18, pieceScale: rc.pieceScale }) };
}

// ---------- 召唤水晶：三尊守卫托举 ----------
function inhibBearers(m, R, col, red) {
  const cfg = CONFIG.ui?.crystalShrine || {};
  // 圆台：蓝方十边正圆，红方七边、偏心、边上一圈外翻的尖石
  m.add(red ? Cy(R * 0.94, R * 1.06, R * 0.16, 7) : Cy(R * 0.96, R * 1.06, R * 0.16, 10), C(T(red ? R * 0.03 : 0, R * 0.08, 0), RY(red ? 0.25 : 0)), shade(col.stone, 0.62));
  m.add(red ? Cy(R * 0.6, R * 0.7, R * 0.1, 5) : Cy(R * 0.62, R * 0.7, R * 0.1, 10), C(T(0, R * 0.21, 0), RY(red ? 0.6 : 0)), shade(col.stone, 0.74));
  for (let i = 0; i < 6; i++) {   // 队伍色符文环：六段弧，碎的时候一段一段掉
    m.piece(`rune${i}`, { stub: 0 }, () => m.add(new THREE.TorusGeometry(R * 0.8, R * 0.025, 3, 5, Math.PI / 3 * (red ? 0.8 : 0.92)),
      C(T(0, R * 0.165, 0), RX(Math.PI / 2), RZ(i * Math.PI / 3 + (red ? hash01(i, 9) * 0.3 : 0))), col.armor));
  }
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * R * 0.92, z = Math.sin(a) * R * 0.92;
    m.piece(`edge${i}`, { stub: 0.35 }, () => {
      if (red) {
        const h = R * (0.26 + hash01(i, 4) * 0.2);
        m.add(Co(R * 0.1, h, 4), C(T(x, R * 0.16 + h / 2 - R * 0.03, z), RZ(Math.cos(a) * -0.4), RX(Math.sin(a) * 0.4)), shade(col.stone, 0.72 + hash01(i, 3) * 0.12));
      } else {
        m.add(B(R * 0.3, R * 0.16, R * 0.14), C(T(x, R * 0.24, z), RY(-a + Math.PI / 2)), shade(col.stone, 0.76 + hash01(i, 3) * 0.08));
      }
    });
  }
  const top = R * 0.26, K = cfg.bearerScale ?? 0.72;
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + Math.PI / 2;
    m.prefixed(`f${i}.`, () => m.within(C(T(Math.cos(a) * R * 0.6, top, Math.sin(a) * R * 0.6), RY(faceIn(a)), S(K * R)), () => bearer(m, col, red)));
  }
  const crystalR = R * (cfg.orbCrystalR ?? 0.42);
  return {
    crystalR, crystalCy: top + K * R * 1.5 + crystalR * 0.35, keepBelow: 0.3, moundHeight: 0.3,
    light: ['f0.arm1', 'f0.plate1', 'f1.cape', 'edge1', 'edge4', 'rune2'],
    heavy: ['f0.torso', 'f1.arm-1', 'f1.plate-1', 'f2.arm1', 'f2.cape', 'edge2', 'edge5', 'edge0', 'rune1', 'rune4'],
  };
}

/** 跪姿托举的守卫：局部 +z 朝圆心，双臂向前上方举起托住水晶。头不掉（与塔一致）。 */
function bearer(m, col, red) {
  const { statue, armor, cloth, metal, dark } = col;
  m.add(red ? Cy(0.2, 0.34, 0.44, 5) : Cy(0.22, 0.34, 0.44, 8), C(T(0, 0.22, 0), RY(red ? 0.3 : 0)), shade(statue, 0.86));
  m.piece('torso', { stub: 0 }, () => {
    m.add(red ? Cy(0.3, 0.19, 0.42, 5) : Cy(0.28, 0.21, 0.42, 6), C(T(0, 0.64, 0.02), RX(red ? 0.3 : 0.15)), dark);
    m.add(B(0.3, 0.3, 0.08), C(T(0, 0.66, 0.18), RX(0.15)), shade(armor, red ? 1.0 : 1.2));
    m.add(Cy(0.08, 0.1, 0.1, 6), T(0, 0.9, 0.05), dark);
    if (red) {   // 角盔 + 两根弯角
      m.add(Cy(0.11, 0.15, 0.22, 5), C(T(0, 1.03, 0.07), RY(0.3)), shade(statue, 1.1));
      m.add(Co(0.09, 0.16, 4), C(T(0, 0.98, 0.2), RX(Math.PI / 2 + 0.35)), shade(dark, 0.7));
      m.add(Co(0.05, 0.34, 4), C(T(-0.15, 1.18, 0.05), RZ(0.75)), metal);
      m.add(Co(0.04, 0.22, 4), C(T(0.13, 1.15, 0.05), RZ(-0.85)), metal);
      for (let i = 0; i < 2; i++) m.add(Co(0.04, 0.2, 3), C(T((i - 0.5) * 0.14, 0.78, -0.18), RX(-0.95)), metal);   // 背刺
    } else {     // 兜帽
      m.add(Cy(0.12, 0.17, 0.24, 6), T(0, 1.04, 0.06), shade(statue, 0.92));
      m.add(B(0.12, 0.12, 0.05), T(0, 1.01, 0.19), shade(dark, 0.45));
      m.add(Co(0.12, 0.22, 6), C(T(0, 1.26, 0.03), RX(-0.2)), shade(statue, 0.92));
    }
  });
  m.attachedTo('torso', () => {
    for (const s of [-1, 1]) {
      m.piece(`arm${s}`, { stub: 0 }, () => {
        m.add(B(0.11, 0.46, 0.11), C(T(s * 0.26, 1.02, 0.14), RX(0.75), RZ(-s * 0.25)), dark);
        if (red) m.add(Co(0.08, 0.14, 4), C(T(s * 0.19, 1.24, 0.34), RX(-0.4)), shade(statue, 0.8));   // 爪
        else m.add(B(0.13, 0.1, 0.13), T(s * 0.19, 1.22, 0.34), shade(statue, 0.8));
      });
      m.piece(`plate${s}`, { stub: 0 }, () => {
        if (red) {
          m.add(Cy(0.06, s < 0 ? 0.2 : 0.15, 0.14, 5), C(T(s * 0.3, 0.84, 0.02), RZ(-s * 0.4)), statue);
          for (let k = 0; k < (s < 0 ? 3 : 2); k++) m.add(Co(0.04, 0.26, 4), C(T(s * 0.32, 0.94, (k - 0.5) * 0.1), RZ(-s * (0.5 + k * 0.2))), k % 2 ? armor : metal);
        } else {
          m.add(Dome(0.16), C(T(s * 0.3, 0.84, 0.02), S(1.1, 0.8, 1), RZ(-s * 0.35)), statue);
          m.add(B(0.24, 0.05, 0.26), C(T(s * 0.38, 0.76, 0.02), RZ(-s * 0.55)), metal);
        }
      });
    }
    m.piece('cape', { stub: 0.15, cloth: true }, () => {
      if (red) {
        for (let k = 0; k < 3; k++) {
          const h = 0.45 + hash01(k, 12) * 0.25;
          m.add(B(0.12, h, 0.03), C(T((k - 1) * 0.13, 0.66 - h / 2, -0.24), RX(0.2), RZ((hash01(k, 13) - 0.5) * 0.4)), cloth);
        }
      } else {
        m.add(B(0.4, 0.62, 0.03), C(T(0, 0.52, -0.24), RX(0.2)), cloth);
        m.add(B(0.26, 0.06, 0.035), T(0, 0.62, -0.26), metal);
      }
    });
  });
}

// ---------- 水晶枢纽：守卫圣殿 ----------
function nexusTemple(m, R, col, red) {
  const cfg = CONFIG.ui?.crystalShrine || {};
  const segs = red ? 7 : 8;
  m.add(Cy(R * 1.2, R * 1.3, R * 0.14, segs), C(T(red ? R * 0.03 : 0, R * 0.07, 0), RY(red ? 0.3 : Math.PI / 8)), shade(col.stone, 0.56));
  m.add(Cy(R * 1.0, R * 1.1, R * 0.14, red ? 5 : 8), C(T(red ? -R * 0.03 : 0, R * 0.21, 0), RY(red ? 0.9 : Math.PI / 8)), shade(col.stone, 0.64));
  const top = R * 0.28;
  m.add(Cy(R * 0.5, R * 0.6, R * 0.24, segs), T(0, top + R * 0.12, 0), shade(col.stone, 0.76));
  m.add(Cy(R * 0.61, R * 0.61, R * 0.05, segs), T(0, top + R * 0.04, 0), col.armor);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const x = Math.cos(a) * R * 0.74, z = Math.sin(a) * R * 0.74;
    m.piece(`pillar${i}`, { stub: 0.35 }, () => {
      if (red) {   // 高低不一、向外斜的尖柱
        const h = R * (0.5 + hash01(i, 14) * 0.3);
        m.add(Co(R * 0.1, h, 4), C(T(x, top + h / 2, z), RZ(Math.cos(a) * -0.2), RX(Math.sin(a) * 0.2), RY(hash01(i, 15) * 3)), shade(col.stone, 0.8 + hash01(i, 16) * 0.1));
        m.add(Co(R * 0.05, R * 0.24, 3), C(T(x * 1.08, top + h * 0.35, z * 1.08), RZ(Math.cos(a) * -0.8), RX(Math.sin(a) * 0.8)), col.armor);
      } else {
        m.add(Cy(R * 0.07, R * 0.09, R * 0.6, 6), T(x, top + R * 0.3, z), shade(col.stone, 0.86));
        m.add(B(R * 0.18, R * 0.06, R * 0.18), C(T(x, top + R * 0.63, z), RY(-a)), shade(col.trim, 0.82));
      }
    });
  }
  const K = cfg.guardianScale ?? 0.62;
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * R * 0.98, z = Math.sin(a) * R * 0.98;
    m.add(red ? Cy(R * 0.18, R * 0.25, R * 0.14, 5) : Cy(R * 0.2, R * 0.25, R * 0.14, 8), T(x, top + R * 0.07, z), shade(col.trim, 0.8));
    m.prefixed(`g${i}.`, () => m.within(C(T(x, top + R * 0.14, z), RY(faceOut(a)), S(K * R)), () => {
      const staff = red ? chaosStatue(m, col, 1) : orderStatue(m, col, 1);
      m.add(new THREE.OctahedronGeometry(0.07), T(staff.x, staff.top + 0.2, staff.z), shade(col.armor, 1.5));   // 杖顶小晶
    }));
  }
  const crystalR = R * (cfg.gemCrystalR ?? 0.6);
  return {
    crystalR, crystalCy: top + R * 0.24 + R * 0.35 + crystalR, keepBelow: 0.32,
    light: ['g0.plate-1_1', 'g0.plate-1_2', 'g0.plate-1_3', 'g1.clothF-1', 'g2.cloak1', 'g3.plate1_2', 'pillar1', 'pillar5'],
    heavy: ['g0.pauldron-1', 'g0.arm-1', 'g0.chest-1', 'g2.pauldron1', 'g2.arm1', 'g1.chest1', 'g1.cloak0', 'g3.clothF1',
            'g3.cloak2', 'g1.prong1', 'pillar2', 'pillar3', 'pillar6', 'pillar0'],
  };
}
