/**
 * buildingModels.js —— 防御塔 / 召唤水晶 / 水晶枢纽的写实造型（2026-11 画面重构）。
 *
 * 用户："塔/兵的模型也需要完全重做，也是写实风格的，塔只需要做两种模型，蓝方/红方防御塔/召唤水晶/水晶枢纽，
 *        某一方所有塔的模型都是一样的不需要再做区分了……可以参考 lol 中的模型，尤其是模型中的水晶要好好做。"
 *
 * 每方一套、三种建筑同一套语言：
 *   蓝方（秩序）：浅灰石灰岩、金色线脚、蓝釉、垂旗；对称、端正。
 *   红方（混沌）：深色玄武岩、青铜与铁、朱红釉、尖刺与利爪、撕破的旗。
 *   防御塔两方是同一副骨架（见 masonryTower）；召唤水晶 / 水晶枢纽各有各的造型。
 * 建筑的档位（外塔 / 高地塔 / 枢纽塔）不再换造型，只按建筑半径 R 等比缩放。
 *
 * 结构上延续按部件建模（towerStatue.PieceModel）：基座以上的每一块都登记成部件，所以
 *   · 掉档 = 把清单里的部件拿掉，它们落在塔脚；
 *   · 被摧毁 = 剩下的部件全部塌下来堆成废墟（PieceModel.layoutRuin），废墟就是这些部件本身。
 * 尺寸比例是造型本身的具名常量；配色和可调的量在 CONFIG.ui.citadel。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { PieceModel, partsBox } from './towerStatue.js';
import { T, RX, RY, RZ, S, C, shade, mixHex, hash01, flat, stoneBlock, arcBlock, lathe, latheSectors, prism, shard, horn, banner, gem } from './modelKit.js';

const cfg = () => CONFIG.ui?.citadel || {};
const TAU = Math.PI * 2;

export function citadelColors(faction) {
  const P = (cfg().colors || {})[faction === 'red' ? 'red' : faction === 'blue' ? 'blue' : 'neutral'] || {};
  return {
    stone: P.stone || '#b9b4a6', stoneDark: P.stoneDark || '#7d786c', core: P.core || '#4a4640',
    trim: P.trim || '#d9b45a', accent: P.accent || '#2f6fc4', cloth: P.cloth || '#2a5fae',
    metal: P.metal || '#8e97a6', glow: P.glow || '#6cc4ff', bone: P.bone || '#b9a88f',
  };
}

/** 一皮石头：n 块弧形石围成一圈。每块登记成部件 `${id}_${k}`；返回这一皮的部件名。 */
function course(m, id, { r0, r1, y, h, n, phase = 0, gap = 0.012, taper = 1, color, vary = 0.1, seed = 0, mat = 'stone', stub = 0 }) {
  const ids = [];
  for (let k = 0; k < n; k++) {
    const a0 = phase + k / n * TAU + gap, a1 = phase + (k + 1) / n * TAU - gap;
    const pid = `${id}_${k}`;
    m.piece(pid, { stub }, () => m.add(arcBlock(r0, r1, h, a0, a1, seed * 37 + k, taper), T(0, y, 0), shade(color, 1 - vary / 2 + hash01(seed * 13 + k, 5) * vary), mat));
    ids.push(pid);
  }
  return ids;
}

/** 棱柱，顶点略抖（塔芯的断面不是机器切出来的）。 */
function jitterPrism(n, rTop, rBot, h, seed) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, n, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 37) * 131 + Math.round(p.getZ(i) * 41) * 17 + (p.getY(i) > 0 ? 7 : 3);
    p.setY(i, p.getY(i) + (hash01(k, seed) - 0.5) * h * 0.16);
  }
  return flat(g);
}

/**
 * 塔芯的一瓣：圆台沿圆周切出来的一个扇形块（a0..a1，按 x = cos、z = sin 的方位角），带两个切面。底面在 y = 0。
 * 塔芯切成几瓣，重损时被打穿的那一侧整瓣拿掉 —— 塔芯也是会坏的（用户："塔里面这个核心一直都是完好无损的，这个也应该跟着损毁"）。
 */
function coreWedge(rTop, rBot, h, a0, a1, seed, seg = 3) {
  const P = [], tri = (a, b, c) => P.push(a, b, c);
  const ring = (r, y, top) => { const o = []; for (let i = 0; i <= seg; i++) { const a = a0 + (a1 - a0) * i / seg; o.push([Math.cos(a) * r, y + (top ? (hash01(i + seed * 7, 3) - 0.5) * h * 0.14 : 0), Math.sin(a) * r]); } return o; };
  const b = ring(rBot, 0, false), t = ring(rTop, h, true), cb = [0, 0, 0], ct = [0, h, 0];
  for (let i = 0; i < seg; i++) { tri(b[i], t[i], b[i + 1]); tri(b[i + 1], t[i], t[i + 1]); tri(ct, t[i + 1], t[i]); tri(cb, b[i], b[i + 1]); }
  tri(cb, ct, b[0]); tri(b[0], ct, t[0]); tri(cb, b[seg], ct); tri(b[seg], t[seg], ct);
  // 这一瓣是凸的：把每个三角形的绕向统一成朝外（法线背离瓣的重心）
  const cx = Math.cos((a0 + a1) / 2) * rBot * 0.5, cz = Math.sin((a0 + a1) / 2) * rBot * 0.5, cy = h / 2, pos = [];
  for (let i = 0; i < P.length; i += 3) {
    const [A, B, Cc] = [P[i], P[i + 1], P[i + 2]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const out = nx * ((A[0] + B[0] + Cc[0]) / 3 - cx) + ny * ((A[1] + B[1] + Cc[1]) / 3 - cy) + nz * ((A[2] + B[2] + Cc[2]) / 3 - cz);
    pos.push(...A, ...(out >= 0 ? B : Cc), ...(out >= 0 ? Cc : B));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 红方台沿的玄武岩柱丛：一簇簇高低不一的六棱石柱（部件 `col{i}`），把平板一样的台子变成从地里长出来的岩台。 */
function basaltRim(m, R, col, { n = 9, r = 0.98, y = 0, seed = 0, hMin = 0.16, hMax = 0.46 }) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + (hash01(i, seed + 81) - 0.5) * 0.5, rr = R * (r + (hash01(i, seed + 82) - 0.5) * 0.14);
    m.piece(`col${i}`, { stub: 0.3 }, () => {
      for (let k = 0; k < 3; k++) {
        const hh = R * (hMin + hash01(i * 3 + k, seed + 83) * (hMax - hMin)), w = R * (0.075 + hash01(i * 3 + k, seed + 84) * 0.05);
        const ox = (hash01(i * 3 + k, seed + 85) - 0.5) * R * 0.2, oz = (hash01(i * 3 + k, seed + 86) - 0.5) * R * 0.2;
        m.add(prism(6, w * 0.92, w, hh), C(T(Math.cos(a) * rr + ox, y + hh / 2, Math.sin(a) * rr + oz), RY(hash01(i * 3 + k, seed + 87) * 3), RZ((hash01(i * 3 + k, seed + 88) - 0.5) * 0.14)), shade(col.stone, 0.7 + hash01(i * 3 + k, seed + 89) * 0.4), 'dark');
      }
    });
    ids.push(`col${i}`);
  }
  return ids;
}

// ============================================================================
// 防御塔：双方同一副骨架（一皮皮垒起来的圆塔 + 扶壁 + 腰箍 + 冠台 + 四爪托水晶），阵营只换"口音"
//   蓝方（秩序）：浅灰石灰岩、金线脚、蓝釉、方垛口、盾徽、整齐的垂旗；
//   红方（混沌）：深色玄武岩、青铜线脚、朱红釉、獠牙一样的尖垛口、铁刺、更长更尖的爪、撕破的旗，台脚有碎岩刺出来。
// 用户："红方塔需要重做，红方塔的塔里面为什么是红色的，我要求做成类似蓝方防御塔那样但是要修改成红方的风格。"
// 所以红方不再是"岩板缝里透着熔岩光的尖碑"：塔芯和蓝方一样是暗色的石头，发光的只有四道窄窗和水晶。
// ============================================================================
function masonryTower(m, R, col, red) {
  const SM = red ? 'dark' : 'stone';            // 台座、扶壁这些大石头的材质
  const vary = red ? 0.3 : 0.2;                 // 一皮石头里各块的深浅差：红方更斑驳
  // ---- 基座：两级八角石台（留在原地，不掉）----
  m.add(prism(8, R * 1.08, R * 1.16, R * 0.12), C(T(0, R * 0.06, 0), RY(Math.PI / 8)), shade(col.stoneDark, 0.9), SM);
  m.add(prism(8, R * 0.92, R * 0.98, R * 0.14), C(T(0, R * 0.19, 0), RY(Math.PI / 8 + (red ? 0.12 : 0))), shade(col.stone, 0.86), SM);
  m.add(lathe([[R * 0.88, 0], [R * 0.91, R * 0.012], [R * 0.88, R * 0.03]], 8, true), C(T(0, R * 0.26, 0), RY(Math.PI / 8 + (red ? 0.12 : 0))), red ? col.metal : col.trim, red ? 'iron' : 'gold');
  const y0 = R * 0.26;
  if (red) {
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU + 0.5 + (hash01(i, 21) - 0.5) * 0.5, r = R * (0.98 + hash01(i, 22) * 0.1), hh = R * (0.3 + hash01(i, 23) * 0.26);
      m.piece(`spur${i}`, { stub: 0.3 }, () => m.add(shard(R * 0.13, hh, 4 + (i % 2), i + 3, 0.5), C(T(Math.cos(a) * r, R * 0.06, Math.sin(a) * r), RZ(Math.cos(a) * -0.4), RX(Math.sin(a) * 0.4)), shade(col.stone, 0.8 + hash01(i, 25) * 0.25), 'dark'));
    }
  }
  // ---- 塔身下段：芯（石块掉了露出来）+ 六皮石头，逐皮收分、错缝 ----
  const lowH = R * 1.3, nC = 6, ch = lowH / nC, taper = 0.82;
  // 芯分三段垒（塌的时候是三块，不是一根完整的柱子）
  // 每段再沿圆周切成四瓣（部件 coreLow{段}_{瓣}，瓣 q 占方位角 q·90°..(q+1)·90°）：重损时被打穿的那一侧整瓣拿掉
  const QUAD = Math.PI / 2;
  for (let i = 0; i < 3; i++) for (let q = 0; q < 4; q++) m.piece(`coreLow${i}_${q}`, { stub: i === 2 ? 0.4 : 0, vanish: true },
    () => m.add(coreWedge(R * (0.5 - 0.1 * (i + 1) / 3), R * (0.5 - 0.1 * i / 3), lowH / 3, q * QUAD, (q + 1) * QUAD, i * 4 + q + 5), T(0, y0 + lowH * i / 3, 0), shade(col.core, 0.92 + hash01(i * 4 + q, 17) * 0.16), 'dark'));
  const blocks = [];
  for (let i = 0; i < nC; i++) {
    const k0 = 1 - (1 - taper) * i / nC, k1 = 1 - (1 - taper) * (i + 1) / nC;
    blocks.push(course(m, `c${i}`, { r0: R * 0.42 * k0, r1: R * 0.64 * k0, y: y0 + i * ch, h: ch * 0.93, n: 8, gap: 0.028, phase: (i % 2) * TAU / 16, taper: k1 / k0, color: col.stone, vary, seed: i + 1 }));
  }
  // ---- 四道扶壁（对角）----
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`fin${i}`, { stub: 0.25 }, () => {
      const at = (r, y, g, colr, mat, rz = 0) => m.add(g, C(T(cs * r, y, sn * r), RY(-a), RZ(rz)), colr, mat);
      at(R * 0.8, y0 + R * 0.22, stoneBlock(R * 0.36, R * 0.44, R * 0.22, i + 40), shade(col.stone, 0.9), SM);
      at(R * 0.71, y0 + R * 0.62, stoneBlock(R * 0.26, R * 0.4, R * 0.19, i + 44), shade(col.stone, 0.97), SM, 0.13);
      at(R * 0.62, y0 + R * 0.98, stoneBlock(R * 0.18, R * 0.36, R * 0.16, i + 48), col.stone, SM, 0.18);
      if (red) at(R * 0.57, y0 + R * 1.16, shard(R * 0.075, R * 0.34, 4, i + 5, 0.15), col.metal, 'iron', 0.2);
      else at(R * 0.575, y0 + R * 1.2, prism(4, R * 0.03, R * 0.1, R * 0.12), col.trim, 'gold');
    });
  }
  let y = y0 + lowH;
  // ---- 腰箍：线脚 + 釉带 + 四面徽记 ----
  {
    const b1 = latheSectors([[R * 0.47, 0], [R * 0.6, R * 0.03], [R * 0.6, R * 0.07], [R * 0.54, R * 0.1], [R * 0.47, R * 0.1]], 4, 5);
    const b2 = latheSectors([[R * 0.47, 0], [R * 0.565, R * 0.02], [R * 0.565, R * 0.12], [R * 0.53, R * 0.14], [R * 0.47, R * 0.14]], 4, 5);
    const b3 = latheSectors([[R * 0.47, 0], [R * 0.585, R * 0.02], [R * 0.56, R * 0.05], [R * 0.47, R * 0.05]], 4, 5);
    for (let i = 0; i < 4; i++) m.piece(`belt${i}`, { stub: 0, vanish: true }, () => {
      m.add(b1[i], T(0, y, 0), col.trim, 'gold');
      m.add(b2[i], T(0, y + R * 0.1, 0), col.accent, 'metal');
      m.add(b3[i], T(0, y + R * 0.24, 0), col.trim, 'gold');
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`shield${i}`, { stub: 0 }, () => {
      if (red) {
        // 朱红的菱形铁牌，正中一根朝外的铁刺
        m.add(prism(4, R * 0.12, R * 0.12, R * 0.035), C(T(cs * R * 0.595, y + R * 0.14, sn * R * 0.595), RY(-a + Math.PI / 2), RX(Math.PI / 2)), col.accent, 'metal');
        m.add(shard(R * 0.045, R * 0.2, 4, i + 7, 0.05), C(T(cs * R * 0.6, y + R * 0.14, sn * R * 0.6), RY(-a), RZ(-Math.PI / 2)), col.metal, 'iron');
      } else {
        m.add(prism(5, R * 0.12, R * 0.12, R * 0.04), C(T(cs * R * 0.595, y + R * 0.14, sn * R * 0.595), RY(-a + Math.PI / 2), RX(Math.PI / 2), RY(Math.PI)), col.accent, 'metal');
        m.add(flat(new THREE.OctahedronGeometry(R * 0.05)), T(cs * R * 0.625, y + R * 0.14, sn * R * 0.625), col.trim, 'gold');
      }
    });
  }
  y += R * 0.29;
  // ---- 塔身上段：细一圈，三皮石头 + 四道发光的窄窗 ----
  const upH = R * 0.72, uc = upH / 3;
  for (let i = 0; i < 2; i++) for (let q = 0; q < 4; q++) m.piece(`coreUp${i}_${q}`, { stub: 0, vanish: true },
    () => m.add(coreWedge(R * (0.37 - 0.04 * (i + 1) / 2), R * (0.37 - 0.04 * i / 2), upH / 2, q * QUAD, (q + 1) * QUAD, i * 4 + q + 29), T(0, y + upH * i / 2, 0), shade(col.core, 0.92 + hash01(i * 4 + q, 19) * 0.16), 'dark'));
  for (let i = 0; i < 3; i++) blocks.push(course(m, `u${i}`, { r0: R * 0.33, r1: R * 0.48 - i * R * 0.012, y: y + i * uc, h: uc * 0.93, n: 8, gap: 0.03, phase: (i % 2) * TAU / 16 + 0.2, color: shade(col.stone, 1.04), vary, seed: i + 11 }));
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`slit${i}`, { stub: 0 }, () => m.add(stoneBlock(R * 0.07, R * 0.36, R * 0.03, i, 0), C(T(cs * R * 0.478, y + upH * 0.5, sn * R * 0.478), RY(-a + Math.PI / 2)), col.glow, 'glow'));
  }
  y += upH;
  // ---- 冠台：外挑的托檐，台面嵌一圈釉与线脚；一圈垛口 ----
  {
    const c1 = latheSectors([[0.01, 0], [R * 0.46, 0], [R * 0.54, R * 0.05], [R * 0.66, R * 0.15], [R * 0.68, R * 0.2], [R * 0.64, R * 0.22], [0.01, R * 0.22]], 4, 4);
    const c2 = latheSectors([[R * 0.67, 0], [R * 0.7, R * 0.015], [R * 0.67, R * 0.035]], 4, 4);
    const c3 = latheSectors([[R * 0.36, 0], [R * 0.36, R * 0.012], [R * 0.5, R * 0.012], [R * 0.5, 0]], 4, 6);
    const c4 = latheSectors([[R * 0.5, 0], [R * 0.5, R * 0.02], [R * 0.53, R * 0.02], [R * 0.53, 0]], 4, 6);
    for (let i = 0; i < 4; i++) m.piece(`corbel${i}`, { stub: 0, vanish: true }, () => {
      m.add(c1[i], T(0, y, 0), shade(col.stone, 0.95), SM);
      m.add(c2[i], T(0, y + R * 0.185, 0), col.trim, 'gold');
      m.add(c3[i], T(0, y + R * 0.215, 0), col.accent, 'metal');
      m.add(c4[i], T(0, y + R * 0.215, 0), col.trim, 'gold');
    });
  }
  y += R * 0.22;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + Math.PI / 8, cs = Math.cos(a), sn = Math.sin(a);
    // 垛口立在冠台上：它脚下那一段冠台塌了的话，垛口的残根不能留在半空（挂靠到所在的那段冠台）
    m.attachedTo(`corbel${[0, 0, 3, 3, 2, 2, 1, 1][i]}`, () => m.piece(`mer${i}`, { stub: 0.3 }, () => {
      if (red) {
        // 獠牙一样的尖垛口：高低错落，尖上包一点青铜
        const hh = R * (0.24 + (i % 2) * 0.1);
        m.add(prism(4, R * 0.02, R * 0.105, hh), C(T(cs * R * 0.6, y + hh / 2, sn * R * 0.6), RY(-a + Math.PI / 4), RZ(0)), shade(col.stone, 0.9 + hash01(i, 9) * 0.2), 'dark');
        m.add(prism(4, R * 0.004, R * 0.034, hh * 0.3), C(T(cs * R * 0.6, y + hh * 0.86, sn * R * 0.6), RY(-a + Math.PI / 4)), col.trim, 'gold');
      } else {
        m.add(stoneBlock(R * 0.19, R * 0.15, R * 0.1, i + 60), C(T(cs * R * 0.6, y + R * 0.075, sn * R * 0.6), RY(-a + Math.PI / 2)), shade(col.stone, 0.96 + hash01(i, 9) * 0.08), 'stone');
        m.add(stoneBlock(R * 0.21, R * 0.03, R * 0.12, i + 70, 0.02), C(T(cs * R * 0.6, y + R * 0.165, sn * R * 0.6), RY(-a + Math.PI / 2)), col.trim, 'gold');
      }
    }));
  }
  // ---- 水晶托：中间一个杯座，四只石爪向上合拢，爪尖包金 / 包铜 ----
  m.piece('cup', { stub: 0 }, () => {
    m.add(lathe([[R * 0.3, 0], [R * 0.25, R * 0.07], [R * 0.15, R * 0.14], [R * 0.19, R * 0.24], [R * 0.25, R * 0.28], [R * 0.19, R * 0.29]], red ? 8 : 12, red), T(0, y, 0), shade(col.stone, 0.88), SM);
    m.add(lathe([[R * 0.245, 0], [R * 0.27, R * 0.012], [R * 0.245, R * 0.03]], red ? 8 : 12, red), T(0, y + R * 0.265, 0), col.trim, 'gold');
  });
  const crystalR = R * 0.3;
  const crystalCy = y + R * 0.3 + crystalR * (red ? 1.7 : 1.55);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU, cs = Math.cos(a), sn = Math.sin(a);
    const P = (r, yy) => [cs * r * R, y + yy * R, sn * r * R];
    m.piece(`claw${i}`, { stub: 0 }, () => {
      if (red) {
        // 更长、更尖、往里勾得更狠的爪，外脊一道青铜
        m.add(horn([P(0.42, -0.04), P(0.66, 0.24), P(0.7, 0.66), P(0.52, 1.02), P(0.33, 1.24)], R * 0.125, R * 0.014, 5, 9, 0.75), new THREE.Matrix4(), shade(col.stone, 1.08), 'dark');
        m.add(horn([P(0.7, 0.24), P(0.76, 0.66), P(0.57, 1.04), P(0.36, 1.27)], R * 0.042, R * 0.006, 3, 6), new THREE.Matrix4(), col.trim, 'gold');
      } else {
        // 蓝方不是爪：四根笔直的方尖石柱，微微内收，腰上一道金箍、朝外一条蓝釉、柱顶一颗金锥 —— 秩序的顶冠是"建"出来的，
        // 红方的是"长"出来的（用户："优化蓝方防御塔上面那四个爪的效果，要做到和红方不同"）
        const lean = -0.1;                                   // 柱身往里倾的角度
        const at = (g, r, yy, colr, mat) => m.add(g, C(T(cs * r * R, y + yy * R, sn * r * R), RY(-a), RZ(lean)), colr, mat);
        at(stoneBlock(R * 0.2, R * 0.1, R * 0.2, i + 80, 0.04), 0.58, 0.05, shade(col.stone, 0.9), 'stone');             // 柱础
        at(prism(4, R * 0.062, R * 0.092, R * 0.78), 0.565, 0.49, shade(col.stone, 1.04), 'stone');                       // 柱身（方锥台）
        at(prism(4, R * 0.09, R * 0.09, R * 0.035), 0.552, 0.6, col.trim, 'gold');                                       // 金箍
        at(stoneBlock(R * 0.012, R * 0.4, R * 0.05, i, 0), 0.625, 0.36, col.accent, 'metal');                            // 朝外的蓝釉条
        at(prism(4, R * 0.008, R * 0.07, R * 0.16), 0.53, 0.96, col.trim, 'gold');                                       // 柱顶金锥
      }
    });
  }
  // ---- 蓝方：法环。一道金环悬在水晶腰间，由四根石柱的内侧托着（四段，部件 halo{i} 接在第 i、i+1 两根柱子之间）----
  if (!red) {
    const hy = crystalCy - crystalR * 0.15, hr = R * 0.5;
    for (let i = 0; i < 4; i++) {
      m.attachedTo(`claw${i}`, () => m.piece(`halo${i}`, { stub: 0 }, () => {
        m.add(arcBlock(hr - R * 0.03, hr + R * 0.03, R * 0.035, i / 4 * TAU + 0.07, (i + 1) / 4 * TAU - 0.07, i + 90, 1, 5, 0), T(0, hy, 0), col.trim, 'gold');
        m.add(arcBlock(hr - R * 0.012, hr + R * 0.012, R * 0.012, i / 4 * TAU + 0.12, (i + 1) / 4 * TAU - 0.12, i + 94, 1, 5, 0), T(0, hy + R * 0.036, 0), col.glow, 'glow');   // 环面上一线光
      }));
    }
  }
  // ---- 两面垂旗（前后）：蓝方整齐，红方撕破 ----
  for (const s of [1, -1]) {
    m.piece(`flag${s}`, { stub: 0, cloth: true }, () => {
      const zy = y0 + lowH + R * 0.08;
      if (red) {
        m.add(banner(R * 0.32, R * (s > 0 ? 0.9 : 0.68), 0.09, 0.9, 5), C(T(0, zy, s * R * 0.66), RY(s > 0 ? 0 : Math.PI), RX(-0.1), RZ(0.05 * s)), col.cloth, 'cloth');
        m.add(stoneBlock(R * 0.4, R * 0.04, R * 0.05, 3, 0.02), T(0, zy + R * 0.01, s * R * 0.645), col.metal, 'iron');
      } else {
        m.add(banner(R * 0.34, R * 0.86, 0.05, 0.3), C(T(0, zy, s * R * 0.66), RY(s > 0 ? 0 : Math.PI), RX(-0.1)), col.cloth, 'cloth');
        m.add(banner(R * 0.2, R * 0.6, 0.05, 0.3), C(T(0, zy - R * 0.06, s * R * 0.67), RY(s > 0 ? 0 : Math.PI), RX(-0.1), T(0, 0, R * 0.012)), col.trim, 'gold');
        m.add(stoneBlock(R * 0.4, R * 0.04, R * 0.05, 3, 0.02), T(0, zy + R * 0.01, s * R * 0.645), col.trim, 'gold');
      }
    });
  }
  // 损毁清单。用户的定义："轻损模型就是塔受到了损伤；重损模型就是塔看起来摇摇欲坠"，
  // 并且否掉了上一版的重损："看起来就是少了一半，另一半安然无恙毫发无损，这个是不对的"。
  //   轻损：四面都挨了打 —— 各处零星少几块石头、露出暗芯，掉一面旗、两个垛口、一道扶壁、一块徽记，顶冠缺一角；整座塔略有松动。
  //   重损：四面的石头掉了近半、扶壁只剩一道、垛口所剩无几；朝 90°~180° 那一侧豁开一道口子（冠台、腰箍、上段、里面那一瓣塔芯都没了）；
  //         剩下的石头全都松了、往外鼓，上半截朝豁口那边倾 —— 看上去再挨一下就塌。
  // 不变量：豁口那一瓣里，被拿掉的东西上面不能还留着东西（否则就是悬在半空的石头）。
  const pick = (list) => list.map(([i, k]) => blocks[i]?.[k]).filter(Boolean);
  const light = ['flag1', 'mer2', 'mer5', 'fin1', 'shield1', red ? 'claw1' : 'halo1',
    ...pick([[5, 2], [4, 5], [3, 0], [2, 6], [1, 3], [0, 7], [8, 1], [7, 5], [6, 3], [4, 2], [2, 2], [5, 6]])];
  const heavy = ['flag-1', 'claw1', 'claw2', 'halo0', 'halo1', 'halo2', 'corbel3', 'belt3', 'slit1', 'slit3', 'fin2', 'fin3', 'mer1', 'mer3', 'mer4', 'mer6', 'mer7', 'shield2', 'shield3',
    'coreUp1_1', 'coreUp0_1', 'coreLow2_1',
    // 豁口这一瓣
    ...pick([[6, 2], [7, 1], [7, 2], [8, 2], [8, 3], [5, 1], [5, 3], [4, 3], [3, 2], [3, 1]]),
    // 其余三面
    ...pick([[6, 5], [6, 7], [7, 7], [8, 5], [8, 7], [5, 5], [5, 7], [4, 0], [4, 7], [3, 4], [3, 6], [2, 0], [2, 4], [1, 1], [1, 5], [1, 6], [0, 2], [0, 5]]),
    ...(red ? ['spur1', 'spur3'] : [])].filter((id, i, arr) => arr.indexOf(id) === i && !light.includes(id));
  const W = cfg().wear || {};
  const wear = [null, { loose: W.lightLoose ?? 0.35, share: W.lightShare ?? 0.45 },
    { loose: W.heavyLoose ?? 1, share: W.heavyShare ?? 0.85, tilt: { y: y0 + lowH, angle: W.heavyTilt ?? 0.075, toward: Math.PI * 0.75, pivotR: 0.3 } }];
  debris(m, R, col, 22, { r: R * 0.36, y0: y0 + R * 0.1, y1: y0 + R * 2.3 }, red ? 2 : 1);
  return { crystalR, crystalCy, baseTop: y0, baseR: R * 0.9, light, heavy, wear, ruinStyle: 'heap',
           gemShape: red ? { n: 5, top: 2.0, mid: 0.5, bot: 1.4, twist: 0.3 } : { n: 6, top: 1.8, mid: 0.9, bot: 1.25 },
           stump: { n: 10, r: R * 0.5, h: R * (cfg().ruin?.stumpHeight ?? 0.3) } };
}
const orderTower = (m, R, col) => masonryTower(m, R, col, false);
const chaosTower = (m, R, col) => masonryTower(m, R, col, true);

/** 断桩：一截顶面被砸得参差不齐的柱子（n 棱）。底面在 y = 0。 */
function jaggedStump(n, rTop, rBot, h, seed) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, n, 2);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < h * 0.25) continue;
    const k = Math.round(p.getX(i) * 37) * 131 + Math.round(p.getZ(i) * 41) * 17;
    p.setY(i, y - h * (y > h * 0.75 ? 0.75 : 0.3) * hash01(k, seed));
  }
  return flat(g);
}

/**
 * 塞在建筑体内的碎石（部件 `deb{i}`，完好时被外皮挡着看不见）：倒塌时它们和别的部件一起落下来，铺满碎石丘。
 * @param box { r 水平范围, y0 / y1 高度范围 }
 */
function debris(m, R, col, n, box, seed = 0) {
  for (let i = 0; i < n; i++) {
    const a = hash01(i, seed + 91) * TAU, rr = box.r * Math.sqrt(hash01(i, seed + 92)), y = box.y0 + (box.y1 - box.y0) * hash01(i, seed + 93);
    const sz = R * (0.1 + hash01(i, seed + 94) * 0.13);
    m.piece(`deb${i}`, { stub: 0, inner: true }, () => m.add(stoneBlock(sz, sz * (0.6 + hash01(i, seed + 95) * 0.5), sz * (0.7 + hash01(i, seed + 96) * 0.5), i + seed, 0.16),
      C(T(Math.cos(a) * rr, y, Math.sin(a) * rr), RY(hash01(i, seed + 97) * 6)), shade(i % 5 === 0 ? col.trim : i % 3 === 0 ? col.stoneDark : col.stone, 0.8 + hash01(i, seed + 98) * 0.3), i % 5 === 0 ? 'gold' : 'stone'));
  }
}

/** 碎石丘：一个不规则的低矮石堆（顶点随机起伏）+ 半埋在里面的石块。底面在 y = 0。 */
function moundParts(R, col, h, r, seed = 0) {
  const g = new THREE.ConeGeometry(r, h, 11, 3);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 13) * 31 + Math.round(p.getZ(i) * 17) + Math.round(p.getY(i) * 7) * 7;
    const top = p.getY(i) > h * 0.98;
    if (!top) { p.setX(i, p.getX(i) * (0.86 + hash01(k, seed + 1) * 0.3)); p.setZ(i, p.getZ(i) * (0.86 + hash01(k, seed + 2) * 0.3)); }
    p.setY(i, Math.max(0, p.getY(i) * (top ? 0.8 : 1) + (hash01(k, seed + 3) - 0.5) * h * 0.3));
  }
  const out = [{ geo: flat(g), matrix: new THREE.Matrix4(), color: shade(col.stoneDark, 0.8), mat: 'stone' }];
  for (let i = 0; i < 12; i++) {
    const a = hash01(i, seed + 51) * TAU, rr = r * Math.sqrt(hash01(i, seed + 52)) * 0.92, sz = R * (0.12 + hash01(i, seed + 53) * 0.14);
    out.push({ geo: stoneBlock(sz, sz * 0.8, sz * 0.9, i + seed, 0.14), matrix: C(T(Math.cos(a) * rr, h * Math.max(0, 1 - rr / r) * 0.85 + sz * 0.1, Math.sin(a) * rr), RY(hash01(i, seed + 54) * 6), RZ(hash01(i, seed + 55) * 1.2), RX(hash01(i, seed + 56))),
               color: shade(i % 4 === 0 ? col.stone : col.stoneDark, 0.7 + hash01(i, seed + 57) * 0.3), mat: 'stone' });
  }
  return out;
}

/**
 * 熄灭的水晶碎片：几根细长的晶柱斜插 / 躺在地上，颜色压暗、只剩一点余光。
 * 底面在 y = 0；ring = [内半径, 外半径]（× R）。
 */
function crystalFragments(R, col, cr, n, ring, seed, K) {
  // 熄灭的水晶是半透明的暗色晶体（金属质感的反光），只有少数几片还留着一点余光
  const out = [], c = mixHex(col.glow, '#2a2e36', K.fragmentDim ?? 0.55), ember = mixHex(col.glow, '#000000', K.fragmentEmber ?? 0.78);
  for (let i = 0; i < n; i++) {
    const a = hash01(i, seed + 31) * TAU, rr = R * (ring[0] + (ring[1] - ring[0]) * Math.sqrt(hash01(i, seed + 32)));
    const h = cr * (0.35 + hash01(i, seed + 33) * 0.55), w = h * (0.22 + hash01(i, seed + 34) * 0.12);
    // 一半斜插在地上，一半横躺；插着的朝外倒（被炸开的方向）
    const lying = hash01(i, seed + 35) < 0.5;
    const tilt = lying ? Math.PI / 2 - 0.15 : 0.35 + hash01(i, seed + 36) * 0.5;
    out.push({ geo: shard(w, h, 5, i + seed, 0.1), matrix: C(T(Math.cos(a) * rr, lying ? w * 0.5 : -h * 0.12, Math.sin(a) * rr), RY(-a), RZ(-tilt)), color: i % 4 === 0 ? ember : c, mat: i % 4 === 0 ? 'glow' : 'metal' });
  }
  return out;
}

/** 焦痕：一片边缘参差的暗色薄片（中心爆炸烧黑的地面）。底面在 y = 0。 */
function scorchDisc(r, seed) {
  const n = 22, g = new THREE.CircleGeometry(r, n);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 1; i < p.count; i++) {
    const k = 0.62 + 0.38 * hash01(i % n, seed) + 0.12 * Math.sin(i * 2.3 + seed);
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  return flat(g);
}

/**
 * 收尾：定损毁清单、摆废墟。
 * 废墟里的部件位置由 PieceModel.layoutRuin 定：倒塌动画把它们从原位送到那里，所以播完换成静态废墟时不会跳。
 * 掉档时掉下去的部件早就消失了，不在废墟里；倒塌时碎成渣的大块（vanish）也不在。
 *   · 塔（heap）：塔身往下塌，基座上一座低矮的碎石丘 + 中间一截断桩 + 扶壁的断根，丘上散着几片熄灭的水晶碎片；
 *   · 召唤水晶 / 枢纽（blast）：用户说原来的废墟"简直是为了废墟而废墟，而不是自然的水晶爆炸之后形成的废墟"。
 *     水晶是从中间炸开的，所以：没有人造的锥形石堆；柱子 / 方尖碑 / 巨牙在根部断掉，留下参差的断根；
 *     上面的部件被向外抛，散落在台沿和台外的地上；台面正中一片焦痕，一圈被掀起的碎石，熄灭的水晶碎片四散。
 *   · 两者的旗都在爆炸里烧没了（布料部件不进废墟）。
 */
function finish(m, R, r, col) {
  const has = (id) => m.pieces.has(id);
  const s1 = r.light.filter(has), s2 = [...s1, ...r.heavy.filter(has)];
  const K = { ...(cfg().ruin || {}), wear: cfg().wear };
  const style = r.ruinStyle || 'blast';
  const tint = K.tint ?? 0.78;
  const keep = r.baseTop + R * 0.12;
  const at = (parts, k = tint) => parts.map((p) => ({ ...p, matrix: T(0, r.baseTop - R * 0.02, 0).multiply(p.matrix), color: p.mat === 'glow' ? p.color : shade(p.color, k) }));
  m.cfg = { ...m.cfg, collapse: { ...(m.cfg.collapse || {}), scale: K.pieceScale ?? 0.8 } };
  let mound, stump;
  if (style === 'heap') {
    const mh = R * (r.moundH ?? K.moundHeight ?? 0.42), mr = R * (r.moundR ?? K.spread ?? 0.95);
    m.layoutRuin(s2, { baseTop: r.baseTop, baseR: r.baseR, mound: { h: mh, r: mr } });
    // 碎片插在丘面上：按丘的坡度垫高
    const frags = crystalFragments(R, col, r.crystalR, K.fragments?.tower ?? 6, [0.12, 0.7], 41, K)
      .map((p) => { const v = new THREE.Vector3().setFromMatrixPosition(p.matrix); return { ...p, matrix: T(0, mh * Math.max(0, 1 - Math.hypot(v.x, v.z) / mr) * 0.85, 0).multiply(p.matrix) }; });
    mound = at([...moundParts(R, col, mh, mr, Math.round(R)), ...frags]);
    stump = r.stump ? at([{ geo: jaggedStump(r.stump.n, r.stump.r * 0.8, r.stump.r, r.stump.h, 7), matrix: RY(r.stump.rot || 0), color: r.stump.color || col.core, mat: 'dark' },
      { geo: jaggedStump(r.stump.n, r.stump.r * 1.12, r.stump.r * 1.3, r.stump.h * 0.55, 9), matrix: RY((r.stump.rot || 0) + 0.3), color: shade(col.stone, 0.85), mat: 'stone' }]) : [];
    stump.push(...m.ruinStubs(tint));
  } else {
    const B = K.blast || {};
    m.layoutRuin(s2, { baseTop: r.baseTop, baseR: r.baseR, mound: null, spread: B.spread ?? 2.0, outward: B.throw ?? [0.3, 0.95] });
    const cr = r.crystalR, sr = R * (B.scorchR ?? 0.62);
    const rim = [];
    // 被掀起的一圈碎石：贴着焦痕外沿，大小不一，有的立着有的翻倒
    const nRim = B.rimStones ?? 14;
    for (let i = 0; i < nRim; i++) {
      const a = i / nRim * TAU + (hash01(i, 51) - 0.5) * 0.4, rr = sr * (0.8 + hash01(i, 52) * 0.45), sz = R * (0.05 + hash01(i, 53) * 0.08);
      rim.push({ geo: stoneBlock(sz, sz * (0.5 + hash01(i, 54) * 0.6), sz * (0.7 + hash01(i, 55) * 0.4), i + 120, 0.18),
        matrix: C(T(Math.cos(a) * rr, R * 0.02 + sz * 0.2, Math.sin(a) * rr), RY(hash01(i, 56) * 6), RZ((hash01(i, 57) - 0.5) * 1.2), RX((hash01(i, 58) - 0.5))),
        color: shade(i % 3 ? col.stoneDark : col.stone, 0.75 + hash01(i, 59) * 0.25), mat: 'stone' });
    }
    mound = at([
      { geo: scorchDisc(sr, Math.round(R) + 3), matrix: T(0, R * 0.026, 0), color: B.scorchColor || '#2e2924', mat: 'dark' },
      { geo: scorchDisc(sr * 0.55, Math.round(R) + 7), matrix: C(T(0, R * 0.031, 0), RY(1.1)), color: shade(B.scorchColor || '#2e2924', 0.6), mat: 'dark' },
      ...rim,
      ...crystalFragments(R, col, cr, B.fragments ?? 10, [0.05, 0.9], 61, K).map((p) => ({ ...p, matrix: T(0, R * 0.02, 0).multiply(p.matrix) })),
    ], 1);
    stump = m.ruinStubs(tint);
  }
  // 召唤水晶 / 枢纽没有"上半截"可倾，只松动
  const W = K.wear || {};
  const wear = r.wear || [null, { loose: W.lightLoose ?? 0.35, share: W.lightShare ?? 0.45 }, { loose: W.heavyLoose ?? 1, share: W.heavyShare ?? 0.85 }];
  return {
    model: m, stages: [[], s1, s2], continuous: true, wear, ruinStyle: style,
    ruin: [...m.ruinParts(keep, tint), ...mound, ...stump],
    ruinKit: { mound, stump, moundY: r.baseTop - R * 0.02 },
    crystalCy: r.crystalCy, crystalR: r.crystalR, crystalX: 0, crystalZ: 0,
    // 上半截倾斜时水晶跟着托座走（只平移水平位置，高度不变：炮口高度、水晶的光都不跳）
    crystalShift: wear.map((w) => { if (!w?.tilt) return [0, 0]; const v = new THREE.Vector3(0, r.crystalCy, 0).applyMatrix4(m.tiltMatrixOf(w.tilt)); return [v.x, v.z]; }),
    crystalGeo: () => gem(r.crystalR, r.gemShape.n, r.gemShape.top, r.gemShape.mid, r.gemShape.bot, r.gemShape.twist || 0),
    ruinShardY: r.ruinShardY ?? null, support: r.support || null, keepBelow: keep,
  };
}

/** 防御塔。返回值与 towerStatue.statueTower 同格式（多一个 continuous：废墟由部件本身塌成）。 */
export function citadelTower(R, faction) {
  const col = citadelColors(faction);
  const m = new PieceModel(R, { ...cfg(), rubbleDist: cfg().rubbleDist || [1.05, 1.5], rubbleScale: cfg().rubbleScale ?? 0.92, stubShade: 0.55 });
  const r = faction === 'red' ? chaosTower(m, R, col) : orderTower(m, R, col);
  return finish(m, R, r, col);
}

/** 召唤水晶（orb）/ 水晶枢纽（gem）。 */
export function citadelShrine(kind, R, faction) {
  const col = citadelColors(faction);
  const m = new PieceModel(R, { ...cfg(), rubbleDist: cfg().rubbleDist || [1.05, 1.5], rubbleScale: cfg().rubbleScale ?? 0.92, stubShade: 0.55 });
  const red = faction === 'red';
  const r = kind === 'gem' ? (red ? chaosNexus(m, R, col) : orderNexus(m, R, col)) : (red ? chaosInhib(m, R, col) : orderInhib(m, R, col));
  return finish(m, R, r, col);
}
// ============================================================================
// 蓝方召唤水晶：圆坛 + 三根立柱托着一道石环，水晶悬在环心
// ============================================================================
function orderInhib(m, R, col) {
  m.add(lathe([[R * 1.1, 0], [R * 1.14, R * 0.03], [R * 1.08, R * 0.1], [0.01, R * 0.1]], 14, true), T(0, 0, 0), shade(col.stoneDark, 0.92), 'stone');
  m.add(lathe([[R * 0.94, 0], [R * 0.96, R * 0.03], [R * 0.9, R * 0.12], [0.01, R * 0.12]], 14, true), T(0, R * 0.1, 0), shade(col.stone, 0.88), 'stone');
  m.add(lathe([[R * 0.9, 0], [R * 0.925, R * 0.012], [R * 0.9, R * 0.028]], 14, true), T(0, R * 0.215, 0), col.trim, 'gold');
  const y0 = R * 0.22;
  // 台面：一圈蓝釉 + 六段发光的符文弧（部件，碎的时候一段一段掉）
  m.add(lathe([[R * 0.3, 0], [R * 0.3, R * 0.012], [R * 0.52, R * 0.012], [R * 0.52, 0]], 28), T(0, y0 - R * 0.004, 0), col.accent, 'metal');
  for (let i = 0; i < 6; i++) m.piece(`rune${i}`, { stub: 0, vanish: true }, () => m.add(arcBlock(R * 0.6, R * 0.67, R * 0.018, i / 6 * TAU + 0.07, (i + 1) / 6 * TAU - 0.07, i, 1, 4, 0), T(0, y0, 0), col.glow, 'glow'));
  // 中间的光池
  m.piece('well', { stub: 0, vanish: true }, () => {
    m.add(lathe([[R * 0.3, 0], [R * 0.27, R * 0.08], [R * 0.2, R * 0.1], [R * 0.2, R * 0.06], [0.01, R * 0.06]], 14), T(0, y0, 0), shade(col.stone, 0.9), 'stone');
    m.add(lathe([[0.01, 0], [R * 0.19, 0], [R * 0.19, R * 0.012], [0.01, R * 0.012]], 14), T(0, y0 + R * 0.062, 0), col.glow, 'glow');
  });
  // 三根立柱：柱础 + 两段石 + 金柱头 + 向内探的托臂
  const ringY = y0 + R * 0.98, ringR = R * 0.62;
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * TAU + Math.PI / 2, cs = Math.cos(a), sn = Math.sin(a), pr = R * 0.76;
    const at = (g, r, y, colr, mat, rz = 0) => m.add(g, C(T(cs * r, y, sn * r), RY(-a), RZ(rz)), colr, mat);
    m.piece(`pyl${i}a`, { stub: 0.3 }, () => {
      at(stoneBlock(R * 0.3, R * 0.14, R * 0.3, i + 3), pr, y0 + R * 0.07, shade(col.stone, 0.86), 'stone');
      at(stoneBlock(R * 0.2, R * 0.46, R * 0.2, i + 7), pr, y0 + R * 0.37, col.stone, 'stone');
    });
    m.attachedTo(`pyl${i}a`, () => m.piece(`pyl${i}b`, { stub: 0 }, () => {
      at(stoneBlock(R * 0.17, R * 0.4, R * 0.17, i + 11), pr - R * 0.02, y0 + R * 0.8, shade(col.stone, 1.05), 'stone', 0.07);
      at(lathe([[R * 0.1, 0], [R * 0.14, R * 0.03], [R * 0.14, R * 0.06], [R * 0.04, R * 0.16]], 4, true), pr - R * 0.035, y0 + R * 1.0, col.trim, 'gold');
      const P = (r, yy) => [cs * r, y0 + yy * R, sn * r];
      m.add(horn([P(pr - R * 0.06, 0.9), P(ringR + R * 0.06, 1.02), P(ringR, 0.99)], R * 0.07, R * 0.04, 4, 3), new THREE.Matrix4(), shade(col.stone, 0.96), 'stone');
    }));
  }
  // 石环：六段（部件），外沿包金
  for (let i = 0; i < 6; i++) {
    m.piece(`ring${i}`, { stub: 0 }, () => {
      m.add(arcBlock(ringR - R * 0.06, ringR + R * 0.05, R * 0.1, i / 6 * TAU + 0.02, (i + 1) / 6 * TAU - 0.02, i + 20, 1, 4, 0.02), T(0, ringY - R * 0.05, 0), shade(col.stone, 0.98 + hash01(i, 3) * 0.1), 'stone');
      m.add(arcBlock(ringR + R * 0.05, ringR + R * 0.075, R * 0.05, i / 6 * TAU + 0.03, (i + 1) / 6 * TAU - 0.03, i + 30, 1, 4, 0), T(0, ringY - R * 0.025, 0), col.trim, 'gold');
    });
  }
  // 垂旗（两面，挂在环上）
  for (const [k, a] of [[1, 0.52], [-1, 0.52 + Math.PI]]) {
    m.piece(`flag${k}`, { stub: 0, cloth: true }, () => m.add(banner(R * 0.3, R * 0.62, 0.05, 0.3), C(T(Math.sin(a) * (ringR + R * 0.085), ringY - R * 0.03, Math.cos(a) * (ringR + R * 0.085)), RY(a), RX(-0.06)), col.cloth, 'cloth'));
  }
  const crystalR = R * 0.4;
  const light = ['flag1', 'ring1', 'rune2', 'rune5'];
  const heavy = ['flag-1', 'ring2', 'ring4', 'pyl1b', 'rune0', 'rune3'];
  debris(m, R, col, 18, { r: R * 0.6, y0: y0 - R * 0.16, y1: y0 - R * 0.12 }, 3);
  return { crystalR, crystalCy: ringY + crystalR * 0.1, baseTop: y0, baseR: R * 0.9, light, heavy, ruinShardY: R * 0.95, moundH: 0.3, gemShape: { n: 8, top: 1.25, mid: 0.7, bot: 1.25 } };
}

// ============================================================================
// 红方召唤水晶：裂开的岩台 + 三根巨牙向内合抱，水晶悬在牙尖之间
// ============================================================================
function chaosInhib(m, R, col) {
  m.add(prism(7, R * 1.06, R * 1.16, R * 0.11), C(T(-R * 0.02, R * 0.055, R * 0.02), RY(0.4)), shade(col.stoneDark, 0.85), 'dark');
  m.add(prism(7, R * 0.92, R * 0.98, R * 0.12), C(T(R * 0.02, R * 0.16, 0), RY(0.15)), shade(col.stone, 0.8), 'dark');
  const y0 = R * 0.22;
  // 台面的熔岩裂缝：从中心放射出去
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * TAU + (hash01(i, 61) - 0.5) * 0.5, L = R * (0.4 + hash01(i, 62) * 0.3);
    m.piece(`rune${i}`, { stub: 0, vanish: true }, () => m.add(stoneBlock(L, R * 0.016, R * 0.035, i, 0), C(T(Math.cos(a) * (R * 0.25 + L / 2), y0 + R * 0.004, Math.sin(a) * (R * 0.25 + L / 2)), RY(-a + (hash01(i, 63) - 0.5) * 0.3)), col.glow, 'glow'));
  }
  m.piece('well', { stub: 0, vanish: true }, () => {
    m.add(prism(5, R * 0.2, R * 0.3, R * 0.1), C(T(0, y0 + R * 0.05, 0), RY(0.3)), shade(col.stone, 0.7), 'dark');
    m.add(prism(5, R * 0.17, R * 0.17, R * 0.014), C(T(0, y0 + R * 0.105, 0), RY(0.3)), col.glow, 'glow');
  });
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU + 0.9 + (hash01(i, 64) - 0.5) * 0.4, hh = R * (0.3 + hash01(i, 65) * 0.3);
    m.piece(`spur${i}`, { stub: 0.3 }, () => m.add(shard(R * 0.13, hh, 4, i + 13, 0.5), C(T(Math.cos(a) * R * 0.95, R * 0.08, Math.sin(a) * R * 0.95), RZ(Math.cos(a) * -0.4), RX(Math.sin(a) * 0.4)), shade(col.stone, 0.85 + hash01(i, 66) * 0.2), 'dark'));
  }
  basaltRim(m, R, col, { n: 9, r: 0.94, y: R * 0.08, seed: 2, hMin: 0.16, hMax: 0.42 });
  // 三根巨牙：粗根、向上、向内弯，外脊包铜
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * TAU + Math.PI / 2 + (i === 1 ? 0.12 : 0), cs = Math.cos(a), sn = Math.sin(a), k = [1.0, 1.12, 0.92][i];
    const P = (r, yy) => [cs * r * R, y0 + yy * k * R, sn * r * R];
    m.piece(`fang${i}`, { stub: 0.2 }, () => {
      m.add(horn([P(0.7, -0.04), P(0.9, 0.36), P(0.86, 0.86), P(0.6, 1.3), P(0.38, 1.48)], R * 0.2, R * 0.02, 5, 10, 0.72), new THREE.Matrix4(), shade(col.stone, 1.1), 'dark');
      m.add(horn([P(0.93, 0.36), P(0.93, 0.88), P(0.66, 1.33), P(0.42, 1.52)], R * 0.06, R * 0.006, 3, 7), new THREE.Matrix4(), col.trim, 'metal');
    });
  }
  // 悬在半空的碎铁环：五段，带刺
  const ringY = y0 + R * 0.92;
  for (let i = 0; i < 5; i++) {
    const a0 = i / 5 * TAU + 0.12, a1 = (i + 1) / 5 * TAU - 0.12, am = (a0 + a1) / 2;
    m.piece(`ring${i}`, { stub: 0 }, () => {
      m.add(arcBlock(R * 0.52, R * 0.6, R * 0.08, a0, a1, i + 40, 1, 3, 0.03), C(T(0, ringY + (hash01(i, 67) - 0.5) * R * 0.08, 0)), col.metal, 'iron');
      m.add(shard(R * 0.05, R * 0.2, 4, i + 50, 0.1), C(T(Math.cos(am) * R * 0.6, ringY + R * 0.04, Math.sin(am) * R * 0.6), RY(-am), RZ(-Math.PI / 2 + 0.2)), col.trim, 'metal');
    });
  }
  const crystalR = R * 0.4;
  const light = ['ring1', 'spur1', 'col1', 'col5', 'rune2', 'rune5'];
  const heavy = ['ring3', 'ring4', 'fang2', 'spur3', 'col2', 'col7', 'col8', 'rune0', 'rune3'];
  debris(m, R, col, 18, { r: R * 0.6, y0: y0 - R * 0.16, y1: y0 - R * 0.12 }, 4);
  return { crystalR, crystalCy: ringY + crystalR * 0.15, baseTop: y0, baseR: R * 0.9, light, heavy, ruinShardY: R * 0.95, moundH: 0.3, gemShape: { n: 5, top: 1.5, mid: 0.5, bot: 1.4, twist: 0.3 } };
}

// ============================================================================
// 蓝方水晶枢纽：三级八角台 + 四座方尖碑，碑顶的飞臂托向中央的巨型水晶
// ============================================================================
function orderNexus(m, R, col) {
  const oct = (r0, r1, h, y, colr, k = 1) => m.add(prism(8, r1 * R, r0 * R, h * R), C(T(0, (y + h / 2) * R, 0), RY(Math.PI / 8)), shade(colr, k), 'stone');
  oct(1.26, 1.2, 0.1, 0, col.stoneDark, 0.9);
  oct(1.1, 1.05, 0.1, 0.1, col.stone, 0.84);
  oct(0.95, 0.91, 0.1, 0.2, col.stone, 0.92);
  m.add(lathe([[R * 0.9, 0], [R * 0.925, R * 0.01], [R * 0.9, R * 0.024]], 8, true), C(T(0, R * 0.296, 0), RY(Math.PI / 8)), col.trim, 'gold');
  const y0 = R * 0.3;
  // 四面台阶
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU;
    for (let k = 0; k < 2; k++) m.add(stoneBlock(R * 0.34, R * 0.1, R * 0.16, i * 2 + k, 0.03), C(T(Math.cos(a) * R * (1.2 - k * 0.14), R * (0.05 + k * 0.1), Math.sin(a) * R * (1.2 - k * 0.14)), RY(-a + Math.PI / 2)), shade(col.stone, 0.95), 'stone');
  }
  // 台面：蓝釉环 + 八段符文弧 + 中央光池
  m.add(lathe([[R * 0.34, 0], [R * 0.34, R * 0.008], [R * 0.56, R * 0.008], [R * 0.56, 0]], 32), T(0, y0 - R * 0.002, 0), col.accent, 'metal');
  for (let i = 0; i < 8; i++) m.piece(`rune${i}`, { stub: 0, vanish: true }, () => m.add(arcBlock(R * 0.6, R * 0.65, R * 0.012, i / 8 * TAU + 0.05, (i + 1) / 8 * TAU - 0.05, i, 1, 3, 0), T(0, y0, 0), col.glow, 'glow'));
  m.piece('well', { stub: 0, vanish: true }, () => {
    m.add(lathe([[R * 0.36, 0], [R * 0.32, R * 0.1], [R * 0.22, R * 0.2], [R * 0.26, R * 0.26], [R * 0.2, R * 0.28], [R * 0.2, R * 0.24], [0.01, R * 0.24]], 16), T(0, y0, 0), shade(col.stone, 0.9), 'stone');
    m.add(lathe([[R * 0.255, 0], [R * 0.275, R * 0.01], [R * 0.255, R * 0.024]], 16), T(0, y0 + R * 0.245, 0), col.trim, 'gold');
    m.add(lathe([[0.01, 0], [R * 0.19, 0], [R * 0.19, R * 0.01], [0.01, R * 0.01]], 16), T(0, y0 + R * 0.242, 0), col.glow, 'glow');
  });
  // 四座方尖碑（对角）：三段石 + 金顶 + 朝内的光缝 + 飞臂
  const crystalR = R * 0.4;
  const crystalCy = y0 + R * 0.3 + crystalR * 1.9;
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a), pr = R * 0.8;
    const at = (g, r, y, colr, mat, rz = 0) => m.add(g, C(T(cs * r, y, sn * r), RY(-a), RZ(rz)), colr, mat);
    m.piece(`ob${i}a`, { stub: 0.3 }, () => {
      at(stoneBlock(R * 0.3, R * 0.1, R * 0.3, i + 3), pr, y0 + R * 0.05, shade(col.stone, 0.86), 'stone');
      at(stoneBlock(R * 0.22, R * 0.4, R * 0.22, i + 7), pr, y0 + R * 0.3, col.stone, 'stone');
    });
    m.attachedTo(`ob${i}a`, () => {
      m.piece(`ob${i}b`, { stub: 0.2 }, () => {
        at(stoneBlock(R * 0.19, R * 0.4, R * 0.19, i + 11), pr, y0 + R * 0.7, shade(col.stone, 1.04), 'stone');
        at(stoneBlock(R * 0.03, R * 0.5, R * 0.05, i, 0), pr - R * 0.105, y0 + R * 0.6, col.glow, 'glow');
        at(lathe([[R * 0.115, 0], [R * 0.13, R * 0.015], [R * 0.115, R * 0.035]], 4, true), pr, y0 + R * 0.49, col.trim, 'gold');
      });
      m.attachedTo(`ob${i}b`, () => m.piece(`ob${i}c`, { stub: 0 }, () => {
        at(stoneBlock(R * 0.16, R * 0.28, R * 0.16, i + 15), pr, y0 + R * 1.04, shade(col.stone, 1.08), 'stone');
        at(prism(4, R * 0.01, R * 0.115, R * 0.2), pr, y0 + R * 1.28, col.trim, 'gold');
        const P = (r, yy) => [cs * r * R, y0 + yy * R, sn * r * R];
        m.add(horn([P(0.76, 0.98), P(0.62, 1.26), P(0.5, 1.3), P(0.42, 1.2)], R * 0.075, R * 0.03, 5, 6), new THREE.Matrix4(), shade(col.stone, 0.98), 'stone');
        m.add(horn([P(0.43, 1.21), P(0.36, 1.12), P(0.33, 1.02)], R * 0.04, R * 0.006, 4, 3), new THREE.Matrix4(), col.trim, 'gold');
      }));
    });
    m.piece(`flag${i}`, { stub: 0, cloth: true }, () => m.add(banner(R * 0.2, R * 0.5, 0.05, 0.3), C(T(cs * (pr + R * 0.125), y0 + R * 0.86, sn * (pr + R * 0.125)), RY(Math.PI / 2 - a), RX(-0.06)), col.cloth, 'cloth'));
  }
  // 台沿的矮栏（正方向两侧各一块）
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + Math.PI / 8 + (i % 2 ? -0.16 : 0.16);
    m.piece(`mer${i}`, { stub: 0.3 }, () => {
      m.add(stoneBlock(R * 0.2, R * 0.12, R * 0.08, i + 60), C(T(Math.cos(a) * R * 0.84, y0 + R * 0.06, Math.sin(a) * R * 0.84), RY(-a + Math.PI / 2)), shade(col.stone, 0.98 + hash01(i, 9) * 0.08), 'stone');
      m.add(stoneBlock(R * 0.21, R * 0.02, R * 0.095, i + 70, 0.02), C(T(Math.cos(a) * R * 0.84, y0 + R * 0.13, Math.sin(a) * R * 0.84), RY(-a + Math.PI / 2)), col.trim, 'gold');
    });
  }
  const light = ['flag0', 'flag2', 'mer1', 'mer4', 'ob1c', 'rune1', 'rune5'];
  const heavy = ['flag1', 'mer2', 'mer6', 'mer7', 'ob3c', 'ob1b', 'ob2c', 'rune2', 'rune6', 'rune7'];
  debris(m, R, col, 26, { r: R * 0.62, y0: y0 - R * 0.2, y1: y0 - R * 0.14 }, 5);
  return { crystalR, crystalCy, baseTop: y0, baseR: R * 0.95, light, heavy, moundH: 0.34, moundR: 0.9, gemShape: { n: 8, top: 2.0, mid: 0.9, bot: 1.5 } };
}

// ============================================================================
// 红方水晶枢纽：层层错开的岩台 + 四根巨爪合抱，内圈一排獠牙，水晶悬在正中
// ============================================================================
function chaosNexus(m, R, col) {
  m.add(prism(7, R * 1.18, R * 1.28, R * 0.1), C(T(-R * 0.02, R * 0.05, R * 0.02), RY(0.5)), shade(col.stoneDark, 0.85), 'dark');
  m.add(prism(7, R * 1.04, R * 1.1, R * 0.1), C(T(R * 0.02, R * 0.15, -R * 0.01), RY(0.22)), shade(col.stone, 0.76), 'dark');
  m.add(prism(7, R * 0.9, R * 0.96, R * 0.1), C(T(0, R * 0.25, R * 0.01), RY(0.62)), shade(col.stone, 0.86), 'dark');
  const y0 = R * 0.3;
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * TAU + (hash01(i, 71) - 0.5) * 0.4, L = R * (0.36 + hash01(i, 72) * 0.36);
    m.piece(`rune${i}`, { stub: 0, vanish: true }, () => m.add(stoneBlock(L, R * 0.012, R * 0.03, i, 0), C(T(Math.cos(a) * (R * 0.3 + L / 2), y0 + R * 0.003, Math.sin(a) * (R * 0.3 + L / 2)), RY(-a + (hash01(i, 73) - 0.5) * 0.3)), col.glow, 'glow'));
  }
  m.piece('well', { stub: 0, vanish: true }, () => {
    m.add(prism(5, R * 0.24, R * 0.36, R * 0.22), C(T(0, y0 + R * 0.11, 0), RY(0.3)), shade(col.stone, 0.7), 'dark');
    m.add(prism(5, R * 0.2, R * 0.2, R * 0.012), C(T(0, y0 + R * 0.225, 0), RY(0.3)), col.glow, 'glow');
  });
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + 0.5 + (hash01(i, 74) - 0.5) * 0.35, hh = R * (0.24 + hash01(i, 75) * 0.3);
    m.piece(`spur${i}`, { stub: 0.3 }, () => m.add(shard(R * 0.11, hh, 4, i + 23, 0.5), C(T(Math.cos(a) * R * 1.08, R * 0.08, Math.sin(a) * R * 1.08), RZ(Math.cos(a) * -0.42), RX(Math.sin(a) * 0.42)), shade(col.stone, 0.85 + hash01(i, 76) * 0.2), 'dark'));
  }
  const crystalR = R * 0.4;
  const crystalCy = y0 + R * 0.3 + crystalR * 2.0;
  basaltRim(m, R, col, { n: 13, r: 1.06, y: R * 0.06, seed: 3, hMin: 0.14, hMax: 0.4 });
  // 四根巨爪
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4 + (hash01(i, 77) - 0.5) * 0.16, cs = Math.cos(a), sn = Math.sin(a), k = 0.94 + hash01(i, 78) * 0.2;
    const P = (r, yy) => [cs * r * R, y0 + yy * k * R, sn * r * R];
    m.piece(`fang${i}`, { stub: 0.2 }, () => {
      m.add(horn([P(0.74, -0.03), P(0.98, 0.4), P(0.98, 0.95), P(0.74, 1.45), P(0.5, 1.7)], R * 0.19, R * 0.02, 5, 11, 0.72), new THREE.Matrix4(), shade(col.stone, 1.1), 'dark');
      m.add(horn([P(1.03, 0.4), P(1.05, 0.96), P(0.8, 1.48), P(0.54, 1.74)], R * 0.055, R * 0.006, 3, 8), new THREE.Matrix4(), col.trim, 'metal');
    });
  }
  // 内圈獠牙：六根短的，围着光池
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU + 0.2, cs = Math.cos(a), sn = Math.sin(a), k = 0.8 + hash01(i, 79) * 0.5;
    const P = (r, yy) => [cs * r * R, y0 + yy * k * R, sn * r * R];
    m.piece(`tooth${i}`, { stub: 0.25 }, () => m.add(horn([P(0.52, -0.02), P(0.56, 0.26), P(0.5, 0.56)], R * 0.08, R * 0.008, 5, 5, 0.85), new THREE.Matrix4(), col.bone, 'bone'));
  }
  const light = ['spur1', 'spur5', 'col1', 'col6', 'col10', 'tooth1', 'tooth4', 'rune1', 'rune5'];
  const heavy = ['fang2', 'spur2', 'spur6', 'spur7', 'col3', 'col4', 'col8', 'col12', 'tooth0', 'tooth3', 'rune2', 'rune6', 'rune7'];
  debris(m, R, col, 26, { r: R * 0.62, y0: y0 - R * 0.2, y1: y0 - R * 0.14 }, 6);
  return { crystalR, crystalCy, baseTop: y0, baseR: R * 0.95, light, heavy, moundH: 0.34, moundR: 0.9, gemShape: { n: 5, top: 2.2, mid: 0.6, bot: 1.6, twist: 0.3 } };
}
