/**
 * buildingModels.js —— 防御塔 / 召唤水晶 / 水晶枢纽的写实造型（2026-11 画面重构）。
 *
 * 用户："塔/兵的模型也需要完全重做，也是写实风格的，塔只需要做两种模型，蓝方/红方防御塔/召唤水晶/水晶枢纽，
 *        某一方所有塔的模型都是一样的不需要再做区分了……可以参考 lol 中的模型，尤其是模型中的水晶要好好做。"
 *
 * 每方一套、三种建筑同一套语言：
 *   蓝方（秩序）：浅灰石灰岩一皮皮垒起来的圆塔，扶壁、金色线脚、蓝釉腰箍、垂旗；顶上四只石爪托着悬浮的水晶。对称、端正。
 *   红方（混沌）：一截截拧着往上长的玄武岩尖碑，铁箍、熔岩色的裂缝、不对称的弯角和骨刺；顶上一圈利爪抓着水晶。
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
// 蓝方防御塔
// ============================================================================
function orderTower(m, R, col) {
  // ---- 基座：两级八角石台（留在原地，不掉）----
  m.add(prism(8, R * 1.08, R * 1.16, R * 0.12), C(T(0, R * 0.06, 0), RY(Math.PI / 8)), shade(col.stoneDark, 0.9), 'stone');
  m.add(prism(8, R * 0.92, R * 0.98, R * 0.14), C(T(0, R * 0.19, 0), RY(Math.PI / 8)), shade(col.stone, 0.86), 'stone');
  m.add(lathe([[R * 0.88, 0], [R * 0.91, R * 0.012], [R * 0.88, R * 0.03]], 8, true), C(T(0, R * 0.26, 0), RY(Math.PI / 8)), col.trim, 'gold');
  const y0 = R * 0.26;
  // ---- 塔身下段：芯（石块掉了露出来）+ 六皮石头，逐皮收分、错缝 ----
  const lowH = R * 1.3, nC = 6, ch = lowH / nC, taper = 0.82;
  // 芯分三段垒（塌的时候是三块，不是一根完整的柱子）
  for (let i = 0; i < 3; i++) m.piece(`coreLow${i}`, { stub: 0, vanish: true }, () => m.add(jitterPrism(10, R * (0.5 - 0.1 * (i + 1) / 3), R * (0.5 - 0.1 * i / 3), lowH / 3, i + 5), T(0, y0 + lowH * (i + 0.5) / 3, 0), col.core, 'dark'));
  const blocks = [];
  for (let i = 0; i < nC; i++) {
    const k0 = 1 - (1 - taper) * i / nC, k1 = 1 - (1 - taper) * (i + 1) / nC;
    blocks.push(course(m, `c${i}`, { r0: R * 0.42 * k0, r1: R * 0.64 * k0, y: y0 + i * ch, h: ch * 0.93, n: 8, gap: 0.028, phase: (i % 2) * TAU / 16, taper: k1 / k0, color: col.stone, vary: 0.2, seed: i + 1 }));
  }
  // ---- 四道扶壁（对角）----
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`fin${i}`, { stub: 0.25 }, () => {
      const at = (r, y, g, colr, mat, rz = 0) => m.add(g, C(T(cs * r, y, sn * r), RY(-a), RZ(rz)), colr, mat);
      at(R * 0.8, y0 + R * 0.22, stoneBlock(R * 0.36, R * 0.44, R * 0.22, i + 40), shade(col.stone, 0.9), 'stone');
      at(R * 0.71, y0 + R * 0.62, stoneBlock(R * 0.26, R * 0.4, R * 0.19, i + 44), shade(col.stone, 0.97), 'stone', 0.13);
      at(R * 0.62, y0 + R * 0.98, stoneBlock(R * 0.18, R * 0.36, R * 0.16, i + 48), col.stone, 'stone', 0.18);
      at(R * 0.575, y0 + R * 1.2, prism(4, R * 0.03, R * 0.1, R * 0.12), col.trim, 'gold');
    });
  }
  let y = y0 + lowH;
  // ---- 腰箍：金线脚 + 蓝釉带 + 四面盾徽 ----
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
      m.add(prism(5, R * 0.12, R * 0.12, R * 0.04), C(T(cs * R * 0.595, y + R * 0.14, sn * R * 0.595), RY(-a + Math.PI / 2), RX(Math.PI / 2), RY(Math.PI)), col.accent, 'metal');
      m.add(flat(new THREE.OctahedronGeometry(R * 0.05)), T(cs * R * 0.625, y + R * 0.14, sn * R * 0.625), col.trim, 'gold');
    });
  }
  y += R * 0.29;
  // ---- 塔身上段：细一圈，三皮石头 + 四道发光的窄窗 ----
  const upH = R * 0.72, uc = upH / 3;
  for (let i = 0; i < 2; i++) m.piece(`coreUp${i}`, { stub: 0, vanish: true }, () => m.add(jitterPrism(10, R * (0.37 - 0.04 * (i + 1) / 2), R * (0.37 - 0.04 * i / 2), upH / 2, i + 9), T(0, y + upH * (i + 0.5) / 2, 0), col.core, 'dark'));
  for (let i = 0; i < 3; i++) blocks.push(course(m, `u${i}`, { r0: R * 0.33, r1: R * 0.48 - i * R * 0.012, y: y + i * uc, h: uc * 0.93, n: 8, gap: 0.03, phase: (i % 2) * TAU / 16 + 0.2, color: shade(col.stone, 1.04), vary: 0.2, seed: i + 11 }));
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`slit${i}`, { stub: 0 }, () => m.add(stoneBlock(R * 0.07, R * 0.36, R * 0.03, i, 0), C(T(cs * R * 0.478, y + upH * 0.5, sn * R * 0.478), RY(-a + Math.PI / 2)), col.glow, 'glow'));
  }
  y += upH;
  // ---- 冠台：外挑的托檐，台面嵌一圈蓝釉与金线；一圈垛口 ----
  {
    const c1 = latheSectors([[0.01, 0], [R * 0.46, 0], [R * 0.54, R * 0.05], [R * 0.66, R * 0.15], [R * 0.68, R * 0.2], [R * 0.64, R * 0.22], [0.01, R * 0.22]], 4, 4);
    const c2 = latheSectors([[R * 0.67, 0], [R * 0.7, R * 0.015], [R * 0.67, R * 0.035]], 4, 4);
    const c3 = latheSectors([[R * 0.36, 0], [R * 0.36, R * 0.012], [R * 0.5, R * 0.012], [R * 0.5, 0]], 4, 6);
    const c4 = latheSectors([[R * 0.5, 0], [R * 0.5, R * 0.02], [R * 0.53, R * 0.02], [R * 0.53, 0]], 4, 6);
    for (let i = 0; i < 4; i++) m.piece(`corbel${i}`, { stub: 0, vanish: true }, () => {
      m.add(c1[i], T(0, y, 0), shade(col.stone, 0.95), 'stone');
      m.add(c2[i], T(0, y + R * 0.185, 0), col.trim, 'gold');
      m.add(c3[i], T(0, y + R * 0.215, 0), col.accent, 'metal');
      m.add(c4[i], T(0, y + R * 0.215, 0), col.trim, 'gold');
    });
  }
  y += R * 0.22;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU + Math.PI / 8, cs = Math.cos(a), sn = Math.sin(a);
    m.piece(`mer${i}`, { stub: 0.3 }, () => {
      m.add(stoneBlock(R * 0.19, R * 0.15, R * 0.1, i + 60), C(T(cs * R * 0.6, y + R * 0.075, sn * R * 0.6), RY(-a + Math.PI / 2)), shade(col.stone, 0.96 + hash01(i, 9) * 0.08), 'stone');
      m.add(stoneBlock(R * 0.21, R * 0.03, R * 0.12, i + 70, 0.02), C(T(cs * R * 0.6, y + R * 0.165, sn * R * 0.6), RY(-a + Math.PI / 2)), col.trim, 'gold');
    });
  }
  // ---- 水晶托：中间一个杯座，四只石爪向上合拢，爪尖包金 ----
  m.piece('cup', { stub: 0 }, () => {
    m.add(lathe([[R * 0.3, 0], [R * 0.25, R * 0.07], [R * 0.15, R * 0.14], [R * 0.19, R * 0.24], [R * 0.25, R * 0.28], [R * 0.19, R * 0.29]], 12), T(0, y, 0), shade(col.stone, 0.88), 'stone');
    m.add(lathe([[R * 0.245, 0], [R * 0.27, R * 0.012], [R * 0.245, R * 0.03]], 12), T(0, y + R * 0.265, 0), col.trim, 'gold');
  });
  const crystalR = R * 0.3;
  const crystalCy = y + R * 0.3 + crystalR * 1.55;
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU, cs = Math.cos(a), sn = Math.sin(a);
    const P = (r, yy) => [cs * r * R, y + yy * R, sn * r * R];
    m.piece(`claw${i}`, { stub: 0 }, () => {
      m.add(horn([P(0.42, -0.04), P(0.6, 0.26), P(0.6, 0.6), P(0.47, 0.86)], R * 0.115, R * 0.06, 6, 7), new THREE.Matrix4(), shade(col.stone, 1.03), 'stone');
      m.add(horn([P(0.48, 0.84), P(0.4, 1.0), P(0.31, 1.12)], R * 0.066, R * 0.012, 5, 4), new THREE.Matrix4(), col.trim, 'gold');
      m.add(lathe([[R * 0.085, 0], [R * 0.1, R * 0.02], [R * 0.085, R * 0.045]], 6, true), C(T(cs * R * 0.6, y + R * 0.4, sn * R * 0.6)), col.trim, 'gold');
    });
  }
  // ---- 两面垂旗（前后）----
  for (const s of [1, -1]) {
    m.piece(`flag${s}`, { stub: 0, cloth: true }, () => {
      const zy = y0 + lowH + R * 0.08;
      m.add(banner(R * 0.34, R * 0.86, 0.05, 0.3), C(T(0, zy, s * R * 0.66), RY(s > 0 ? 0 : Math.PI), RX(-0.1)), col.cloth, 'cloth');
      m.add(banner(R * 0.2, R * 0.6, 0.05, 0.3), C(T(0, zy - R * 0.06, s * R * 0.67), RY(s > 0 ? 0 : Math.PI), RX(-0.1), T(0, 0, R * 0.012)), col.trim, 'gold');
      m.add(stoneBlock(R * 0.4, R * 0.04, R * 0.05, 3, 0.02), T(0, zy + R * 0.01, s * R * 0.645), col.trim, 'gold');
    });
  }
  // 损毁清单：轻损掉旗、几块外皮石、一道扶壁、两个垛口；重损再掉一只爪、更多石头、盾徽、另一道扶壁
  const pick = (rows, list) => list.map(([i, k]) => rows[i]?.[k]).filter(Boolean);
  const light = ['flag1', ...pick(blocks, [[5, 1], [4, 2], [5, 6], [3, 5], [7, 2]]), 'fin1', 'mer1', 'mer5', 'shield1'];
  const heavy = ['flag-1', 'claw1', ...pick(blocks, [[5, 2], [5, 7], [4, 6], [4, 7], [3, 0], [2, 4], [8, 4], [8, 5], [7, 6], [6, 1], [1, 7], [0, 3]]), 'fin3', 'mer2', 'mer6', 'mer7', 'shield3', 'slit1'];
  debris(m, R, col, 22, { r: R * 0.36, y0: y0 + R * 0.1, y1: y0 + R * 2.3 }, 1);
  return { crystalR, crystalCy, baseTop: y0, baseR: R * 0.9, light, heavy, gemShape: { n: 6, top: 1.8, mid: 0.9, bot: 1.25 },
           stump: { n: 10, r: R * 0.46, h: R * 0.62 } };
}

// ============================================================================
// 红方防御塔
// ============================================================================
function chaosTower(m, R, col) {
  // ---- 基座：歪斜的七边玄武岩台 + 一圈从地里刺出来的碎岩 ----
  m.add(prism(7, R * 1.04, R * 1.16, R * 0.13), C(T(-R * 0.03, R * 0.065, R * 0.02), RY(0.5)), shade(col.stoneDark, 0.85), 'dark');
  m.add(prism(7, R * 0.9, R * 0.98, R * 0.14), C(T(R * 0.02, R * 0.2, -R * 0.02), RY(0.2), RZ(0.02)), shade(col.stone, 0.8), 'dark');
  const y0 = R * 0.27;
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU + 0.3 + (hash01(i, 21) - 0.5) * 0.5, r = R * (0.9 + hash01(i, 22) * 0.1), hh = R * (0.42 + hash01(i, 23) * 0.4);
    m.piece(`spur${i}`, { stub: 0.3 }, () => m.add(shard(R * 0.17, hh, 4 + (i % 2), i + 3, 0.5), C(T(Math.cos(a) * r, R * 0.1, Math.sin(a) * r), RZ(Math.cos(a) * -0.38), RX(Math.sin(a) * 0.38)), shade(col.stone, 0.8 + hash01(i, 25) * 0.25), 'dark'));
  }
  basaltRim(m, R, col, { n: 8, r: 0.9, y: R * 0.1, seed: 1, hMin: 0.2, hMax: 0.5 });
  // ---- 塔身：三截五棱岩柱，一截比一截细，逐截拧一个角度；岩板之间的缝里透出熔岩色的光 ----
  const segs = [[0.66, 0.56, 0.8], [0.56, 0.47, 0.74], [0.47, 0.39, 0.64]];
  let y = y0, tw = 0.2;
  const faces = [];
  segs.forEach(([rb, rt, h], i) => {
    const hh = h * R;
    m.piece(`core${i}`, { stub: 0, vanish: true }, () => m.add(prism(5, rt * R * 0.7, rb * R * 0.7, hh), C(T(0, y + hh / 2, 0), RY(-tw)), col.core, 'dark'));
    m.piece(`vein${i}`, { stub: 0, vanish: true }, () => m.add(prism(10, rt * R * 0.8, rb * R * 0.8, hh * 0.94), T(0, y + hh / 2, 0), col.glow, 'glow'));
    const row = [];
    for (let k = 0; k < 5; k++) {
      const a0 = tw + k / 5 * TAU + 0.075, a1 = tw + (k + 1) / 5 * TAU - 0.075, pid = `slab${i}_${k}`;
      m.piece(pid, { stub: 0 }, () => m.add(arcBlock(rb * R * 0.76, rb * R * (1.0 + hash01(i * 5 + k, 31) * 0.07), hh * 0.97, a0, a1, i * 17 + k + 5, rt / rb, 1, 0.07), T(0, y + hh * 0.015, 0), shade(col.stone, 0.82 + hash01(i * 5 + k, 33) * 0.34), 'dark'));
      row.push(pid);
    }
    faces.push(row);
    y += hh;
    if (i < segs.length - 1) {
      m.piece(`band${i}`, { stub: 0 }, () => {
        m.add(prism(5, rt * R * 1.12, rt * R * 1.18, R * 0.09), C(T(0, y, 0), RY(-tw - 0.31)), col.metal, 'iron');
        for (let k = 0; k < 5; k++) { const a = tw + 0.31 + k / 5 * TAU; m.add(shard(R * 0.07, R * 0.24, 4, k + i * 9, 0.1), C(T(Math.cos(a) * rt * R * 1.08, y, Math.sin(a) * rt * R * 1.08), RY(-a), RZ(-Math.PI / 2 + 0.3)), col.trim, 'metal'); }
      });
    }
    tw += 0.38;
  });
  // ---- 两根断角：不对称地从下箍斜刺出来 ----
  [[0.5, 0.74, 1.0], [3.4, 1.42, 0.8]].forEach(([a, yy, k], i) => {
    const cs = Math.cos(a), sn = Math.sin(a), P = (r, h) => [cs * r * R, y0 + (yy + h * k) * R, sn * r * R];
    m.piece(`tusk${i}`, { stub: 0 }, () => {
      m.add(horn([P(0.45, 0), P(0.82, 0.1), P(1.02, 0.42), P(1.0, 0.8)], R * 0.14 * k, R * 0.02, 5, 7, 0.75), new THREE.Matrix4(), col.bone, 'bone');
    });
  });
  // ---- 冠：四只粗壮的利爪向上、向内抓住水晶，外脊包铜 ----
  const topY = y;
  m.piece('crown', { stub: 0, vanish: true }, () => {
    m.add(prism(5, R * 0.52, R * 0.4, R * 0.16), C(T(0, topY + R * 0.08, 0), RY(-tw)), shade(col.stone, 0.8), 'dark');
    m.add(prism(5, R * 0.3, R * 0.36, R * 0.1), C(T(0, topY + R * 0.21, 0), RY(-tw - 0.3)), col.metal, 'iron');
  });
  const crystalR = R * 0.3;
  const crystalCy = topY + R * 0.26 + crystalR * 1.7;
  for (let i = 0; i < 4; i++) {
    const a = tw + i / 4 * TAU + (hash01(i, 41) - 0.5) * 0.3, cs = Math.cos(a), sn = Math.sin(a), k = 0.86 + hash01(i, 42) * 0.34;
    const P = (r, h) => [cs * r * R, topY + R * 0.08 + h * k * R, sn * r * R];
    m.piece(`claw${i}`, { stub: 0 }, () => {
      m.add(horn([P(0.38, 0), P(0.72, 0.2), P(0.78, 0.62), P(0.56, 1.02), P(0.36, 1.2)], R * 0.15, R * 0.016, 5, 9, 0.7), new THREE.Matrix4(), shade(col.stone, 1.12), 'dark');
      m.add(horn([P(0.76, 0.2), P(0.85, 0.62), P(0.62, 1.04), P(0.4, 1.23)], R * 0.05, R * 0.006, 3, 6), new THREE.Matrix4(), col.trim, 'metal');
    });
  }
  // ---- 两条破布 ----
  for (const [a, len, id] of [[1.4, 0.95, 1], [3.9, 0.7, -1]]) {
    m.piece(`flag${id}`, { stub: 0, cloth: true }, () => {
      const zy = y0 + R * 1.5;
      m.add(banner(R * 0.28, R * len, 0.09, 0.9, 5), C(T(Math.sin(a) * R * 0.6, zy, Math.cos(a) * R * 0.6), RY(a), RX(-0.1), RZ(0.07 * id)), col.cloth, 'cloth');
    });
  }
  const pick = (list) => list.map(([i, k]) => faces[i]?.[k]).filter(Boolean);
  const light = ['flag1', 'spur1', 'spur4', 'col2', 'col6', ...pick([[2, 1], [1, 3], [0, 0]]), 'tusk1', 'claw3'];
  const heavy = ['flag-1', 'claw1', 'tusk0', 'band1', 'col0', 'col3', 'col5', ...pick([[2, 3], [2, 4], [1, 0], [1, 1], [0, 2], [0, 3]]), 'spur2', 'spur5'];
  debris(m, R, col, 20, { r: R * 0.4, y0: y0 + R * 0.1, y1: y0 + R * 2.0 }, 2);
  return { crystalR, crystalCy, baseTop: y0, baseR: R * 0.9, light, heavy, gemShape: { n: 5, top: 2.0, mid: 0.5, bot: 1.4, twist: 0.3 },
           stump: { n: 5, r: R * 0.5, h: R * 0.66, rot: 0.2 } };
}

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
    m.piece(`deb${i}`, { stub: 0 }, () => m.add(stoneBlock(sz, sz * (0.6 + hash01(i, seed + 95) * 0.5), sz * (0.7 + hash01(i, seed + 96) * 0.5), i + seed, 0.16),
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
 * 收尾：定损毁清单、摆废墟。
 * 废墟（用户定稿："还是要原来废墟的那样的损毁模型"、"倒塌的模型可以消失一部分块"）= 留下的基座 + 一座碎石丘 +
 * 中间一截断桩（塔）+ 塌下来的部件堆在丘上（芯、腰箍这些大块碎成了渣，不在其中）。
 * 部件在废墟里的位置由 PieceModel.layoutRuin 定：倒塌动画把它们从原位送到那里，所以播完换成静态废墟时不会跳。
 */
function finish(m, R, r, col) {
  const has = (id) => m.pieces.has(id);
  const s1 = r.light.filter(has), s2 = [...s1, ...r.heavy.filter(has)];
  const K = cfg().ruin || {};
  const mh = R * (r.moundH ?? K.moundHeight ?? 0.42), mr = R * (r.moundR ?? K.spread ?? 0.95);
  m.cfg = { ...m.cfg, collapse: { ...(m.cfg.collapse || {}), scale: K.pieceScale ?? 0.8 } };
  m.layoutRuin(s2, { baseTop: r.baseTop, baseR: r.baseR, mound: { h: mh, r: mr } });
  const tint = K.tint ?? 0.78;
  const keep = r.baseTop + R * 0.12;
  const at = (parts) => parts.map((p) => ({ ...p, matrix: T(0, r.baseTop - R * 0.02, 0).multiply(p.matrix), color: shade(p.color, tint) }));
  const mound = at(moundParts(R, col, mh, mr, Math.round(R)));
  const stump = r.stump ? at([{ geo: jaggedStump(r.stump.n, r.stump.r * 0.8, r.stump.r, r.stump.h, 7), matrix: RY(r.stump.rot || 0), color: r.stump.color || col.core, mat: 'dark' },
    { geo: jaggedStump(r.stump.n, r.stump.r * 1.12, r.stump.r * 1.3, r.stump.h * 0.55, 9), matrix: RY((r.stump.rot || 0) + 0.3), color: shade(col.stone, 0.85), mat: 'stone' }]) : [];
  return {
    model: m, stages: [[], s1, s2], continuous: true,
    ruin: [...m.ruinParts(keep, tint), ...mound, ...stump],
    ruinKit: { mound, stump, moundY: r.baseTop - R * 0.02 },
    crystalCy: r.crystalCy, crystalR: r.crystalR, crystalX: 0, crystalZ: 0,
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
