/**
 * unitModels.js —— 小兵造型（阵营风格 + 部件骨骼）。
 *
 * 用户定稿（2026-09-27）：
 *   · "小兵的模型参照不同阵营的风格来做"——跟塔同一套：蓝方庄重沉稳（圆润板甲、方盾、长袍兜帽，
 *     白底蓝金），红方混沌尖锐（尖刺肩甲、锯齿刀、破烂披风，深红黑骨）。同一兵种两边剪影不同；
 *   · "近战兵拿刀盾，远程兵拿法杖，超级兵是机甲风格……顾名思义你自己判断"——全部 12 种重做：
 *     人形兵按名字来（治疗兵是牧师、工程兵带扳手背包、唤灵兵拿法书），炮车 / 投石车 / 重装车做载具，
 *     图腾兵、术士兵、蚀骨兵、召唤物保持以前定的"非人形"方向，只翻新造型；
 *   · 动画："模型加基础动画，直接接入"——部件挂骨（见 unitRig.js），走路摆腿摆臂、攻击挥动。
 *
 * 约定：模型朝 +Z 建（正面），右手在 -X、左手在 +X；S = 兵种尺寸（MINION_SIZES），
 * 人形兵总高约 2.1 S（与旧造型一致，血条位置、碰撞半径不变）。
 * 纯装饰几何的比例（一块护腿多宽）留作局部常量；配色、动画幅度在 CONFIG.ui.unitModels。
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
const Cyl = (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s);
const Cone = (r, h, s = 6) => new THREE.ConeGeometry(r, h, s);
const Sph = (r, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const Ico = (r) => new THREE.IcosahedronGeometry(r, 0);
const Oct = (r) => new THREE.OctahedronGeometry(r, 0);
const Tor = (r, t, rs = 4, ts = 10, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc);
const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
const mix = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();

/** 部件收集器：当前骨（bone / pivot / k）是个栈，with() 里加的部件都挂在那根骨上。 */
class Rig {
  constructor() { this.parts = []; this.cur = { bone: BONE.NONE, pivot: [0, 0, 0], k: 1 }; }
  add(geo, m, color) { this.parts.push({ geo, matrix: m, color, bone: this.cur.bone, pivot: this.cur.pivot, k: this.cur.k }); return this; }
  on(bone, pivot, k, fn) {
    const prev = this.cur;
    this.cur = { bone, pivot, k };
    fn();
    this.cur = prev;
    return this;
  }
}

/** 阵营配色：衣料 = 阵营色（调用方给），甲 / 饰 / 暗部 / 眼光 按阵营取 CONFIG。无阵营（自制兵种）按蓝方造型。 */
export function unitStyle(faction, color) {
  const U = CONFIG.ui?.unitModels || {};
  const chaos = faction === 'red';
  const P = (chaos ? U.chaos : U.order) || {};
  return {
    chaos,
    cloth: color, clothDark: shade(color, 0.62), clothLite: mix(color, '#ffffff', 0.3),
    armor: P.armor || (chaos ? '#5a3a3e' : '#d6dde6'),
    armorDark: shade(P.armor || (chaos ? '#5a3a3e' : '#d6dde6'), 0.72),
    trim: P.trim || (chaos ? '#e2d3b0' : '#d8b25a'),
    dark: P.dark || (chaos ? '#2a1c1f' : '#2a3446'),
    eye: P.eye || (chaos ? '#ffb23e' : '#9fe0ff'),
    wood: P.wood || (chaos ? '#4a3328' : '#8a6a44'),
    leather: P.leather || (chaos ? '#3a2a24' : '#6b4f35'),
    gem: mix(color, '#ffffff', 0.45),
  };
}

// ============================================================================
// 人形骨架
// ============================================================================
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
/** 两点之间一节圆柱（四肢）：r0 在 a 端、r1 在 b 端 */
function limb(r, a, b, r0, r1, col, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize());
  // CylinderGeometry 的 radiusTop 在 +Y 端（= b 端）
  r.add(Cyl(r1, r0, len, seg), M4().compose(V3().addVectors(a, b).multiplyScalar(0.5), q, V3(1, 1, 1)), col);
}
/** 半球（肩甲、胸甲的圆弧面），开口朝 -Y */
const Dome = (rad, w = 8) => new THREE.SphereGeometry(rad, w, 4, 0, Math.PI * 2, 0, Math.PI / 2);

/**
 * 人形兵的共用部分。分段人体：靴 / 小腿护甲 / 护膝 / 大腿（两根腿骨）→ 胯 / 收腰 / 宽胸（V 形轮廓）→ 颈 → 头盔；
 * 层叠肩甲；大臂 / 肘 / 前弯的小臂 / 手套（两根臂骨）；披风、罩袍。
 * 用户："小兵的模型重做弄得精细一些！！！目前兵的轮廓就是一个圆 + 一个圆台，太丑了！！完全重做！！！"
 * ——上一版是"圆柱身体 + 球头"，缩到实机大小只剩一个球叠一个圆台。现在靠宽肩窄腰、分开的四肢和
 * 头盔 / 肩甲的外形撑起剪影。
 * opts.robe：长袍（腿只露出靴子、宽袖、披肩）；opts.bulk：体格系数；opts.helm：'plume' | 'hood' | 'goggles' | 'horn'；
 * opts.cape：是否带披风（默认蓝方近战系带、红方全带）。返回手的位置，武器挂在对应的骨上。
 */
function humanoid(r, S, st, opts = {}) {
  const bk = opts.bulk ?? 1, robe = !!opts.robe, ch = st.chaos;
  const hipY = S * 0.68, hipX = S * 0.13 * bk, kneeY = S * 0.36, ankleY = S * 0.09;
  const waistY = S * 0.84, chestY = S * 1.08, shY = S * 1.24, shX = S * 0.38 * bk;
  const neckY = S * 1.33, headR = S * 0.21, hY = S * 1.5;
  const elbow = (sx) => V3(sx * (shX + S * 0.05), S * 0.93, S * 0.03);
  const handP = (sx) => V3(sx * (shX + S * 0.04), S * 0.72, S * 0.2);
  const out = { legH: hipY, torsoH: shY - hipY, shY, shX, armLen: shY - S * 0.72, headY: hY, headR };
  const metal = ch ? st.armorDark : st.armor, plate = ch ? st.armor : st.armor;

  // ---- 腿：大腿 / 护膝 / 小腿护甲 / 靴 ----
  for (const sx of [-1, 1]) {
    r.on(sx < 0 ? BONE.LEG_R : BONE.LEG_L, [sx * hipX, hipY, 0], 1, () => {
      const hip = V3(sx * hipX, hipY, 0), knee = V3(sx * hipX * 1.05, kneeY, S * 0.04), ank = V3(sx * hipX * 1.05, ankleY, 0);
      limb(r, hip, knee, S * 0.1 * bk, S * 0.08 * bk, robe ? st.dark : (ch ? st.dark : st.clothDark));
      limb(r, knee, ank, S * 0.085 * bk, S * 0.07 * bk, robe ? st.dark : metal);
      if (!robe) {
        r.add(Box(S * 0.17 * bk, S * 0.2, S * 0.08), C(T(sx * hipX * 1.05, (kneeY + ankleY) / 2 + S * 0.02, S * 0.09), RX(-0.1)), plate);   // 小腿护甲正面
        if (ch) r.add(Cone(S * 0.045, S * 0.16, 4), C(T(sx * hipX * 1.05, kneeY, S * 0.14), RX(Math.PI / 2)), st.trim);   // 膝刺
        else r.add(Sph(S * 0.075, 6, 4), T(sx * hipX * 1.05, kneeY, S * 0.08), st.trim);                                  // 护膝
      }
      // 靴：鞋身 + 鞋尖
      r.add(Box(S * 0.17 * bk, S * 0.1, S * 0.24), T(sx * hipX * 1.05, S * 0.05, S * 0.03), ch ? st.dark : st.leather);
      r.add(Box(S * 0.15 * bk, S * 0.07, S * 0.1), C(T(sx * hipX * 1.05, S * 0.04, S * 0.17), RX(0.3)), ch ? st.armorDark : shade(st.leather, 0.85));
      if (ch) r.add(Cone(S * 0.03, S * 0.1, 3), C(T(sx * hipX * 1.05, S * 0.12, -S * 0.1), RX(-Math.PI / 2)), st.trim);   // 靴跟刺
    });
  }

  // ---- 胯 / 腰 / 胸 ----
  if (robe) {
    // 长袍：从腰到脚踝的袍身（下摆外张），前襟一条亮色，下摆一圈边
    const top = waistY + S * 0.06, bot = S * 0.14, h = top - bot;
    r.add(Cyl(S * 0.25 * bk, S * 0.44 * bk, h, ch ? 7 : 12), C(T(0, bot + h / 2, 0), RY(ch ? 0.25 : 0)), st.cloth);
    if (ch) {
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * Math.PI * 2 + 0.2;
        r.add(Cone(S * 0.09, S * 0.18, 3), C(T(Math.sin(a) * S * 0.41 * bk, bot - S * 0.03, Math.cos(a) * S * 0.41 * bk), RX(Math.PI)), st.clothDark);   // 撕碎的下摆
      }
      r.add(Box(S * 0.04, h * 0.9, S * 0.3), C(T(S * 0.2, bot + h * 0.5, S * 0.22), RY(0.6), RZ(0.08)), st.clothDark);   // 斜挂的破布
    } else {
      r.add(Cyl(S * 0.445 * bk, S * 0.45 * bk, S * 0.05, 12), T(0, bot + S * 0.025, 0), st.trim);
      r.add(Box(S * 0.14, h * 0.95, S * 0.03), C(T(0, bot + h * 0.5, S * 0.34 * bk), RX(-0.14)), st.clothLite);   // 前襟
      r.add(Box(S * 0.16, S * 0.04, S * 0.03), C(T(0, bot + S * 0.1, S * 0.41 * bk), RX(-0.14)), st.trim);
    }
    // 胸：收窄的袍身上半 + 腰带 + 披肩（短斗篷）
    r.add(Box(S * 0.46 * bk, shY - waistY, S * 0.3), T(0, (waistY + shY) / 2, 0), st.cloth);
    r.add(Cyl(S * 0.27 * bk, S * 0.27 * bk, S * 0.06, 10), T(0, waistY + S * 0.04, 0), ch ? st.leather : st.trim);
    r.add(Box(S * 0.08, S * 0.28, S * 0.02), C(T(S * 0.1, waistY - S * 0.1, S * 0.28), RZ(0.1)), ch ? st.clothDark : st.trim);   // 垂下的腰绳
    r.add(Cone(S * 0.44 * bk, S * 0.3, ch ? 6 : 12), T(0, shY - S * 0.02, 0), ch ? st.clothDark : st.clothLite);   // 披肩
    if (!ch) r.add(Tor(S * 0.14, S * 0.03, 3, 10), C(T(0, shY + S * 0.1, S * 0.02), RX(Math.PI / 2)), st.trim);   // 领口金环
  } else {
    // 胯（腰带 + 护裆）
    r.add(Box(S * 0.44 * bk, S * 0.16, S * 0.28), T(0, hipY + S * 0.04, 0), ch ? st.dark : st.clothDark);
    r.add(Box(S * 0.46 * bk, S * 0.06, S * 0.3), T(0, hipY + S * 0.12, 0), ch ? st.leather : st.trim);
    // 收腰：两片分节甲
    r.add(Box(S * 0.38 * bk, S * 0.1, S * 0.26), T(0, waistY - S * 0.02, 0), metal);
    r.add(Box(S * 0.42 * bk, S * 0.08, S * 0.27), T(0, waistY + S * 0.07, 0), ch ? st.armor : shade(st.armor, 0.9));
    // 宽胸：倒梯形胸甲 + 圆弧前胸
    const cT = shY + S * 0.02, cB = waistY + S * 0.1, cH = cT - cB;
    r.add(Cyl(S * 0.33 * bk, S * 0.24 * bk, cH, ch ? 5 : 8), C(T(0, cB + cH / 2, 0), RY(ch ? Math.PI / 5 : Math.PI / 8), SC(1, 1, 0.62)), metal);
    if (ch) {
      // 红方：几片交错的斜甲 + 胸口一道阵营红
      r.add(Box(S * 0.3 * bk, cH * 0.7, S * 0.06), C(T(-S * 0.07, cB + cH * 0.55, S * 0.18), RZ(0.25), RX(-0.12)), st.armor);
      r.add(Box(S * 0.3 * bk, cH * 0.6, S * 0.06), C(T(S * 0.08, cB + cH * 0.45, S * 0.19), RZ(-0.3), RX(-0.12)), st.armorDark);
      r.add(Box(S * 0.08, cH * 0.8, S * 0.02), C(T(0, cB + cH * 0.5, S * 0.22), RZ(0.1)), st.cloth);
      for (let i = 0; i < 3; i++) r.add(Cone(S * 0.04, S * 0.18, 4), C(T((i - 1) * S * 0.12, cB + cH * 0.85, -S * 0.2), RX(-Math.PI / 2 - 0.5)), st.trim);   // 背刺
    } else {
      r.add(Dome(S * 0.22 * bk, 10), C(T(0, cB + cH * 0.6, S * 0.08), RX(Math.PI / 2), SC(1.15, 0.6, 0.95)), st.armor);   // 圆弧前胸
      r.add(Box(S * 0.4 * bk, S * 0.035, S * 0.05), T(0, cB + S * 0.02, S * 0.15), st.trim);                              // 胸甲下沿金边
      r.add(Box(S * 0.05, S * 0.14, S * 0.02), T(0, cB + cH * 0.58, S * 0.23), st.trim);                                   // 纹章（十字）
      r.add(Box(S * 0.12, S * 0.04, S * 0.02), T(0, cB + cH * 0.64, S * 0.23), st.trim);
    }
    // 罩袍 / 前襟布（垂到膝上）
    if (ch) {
      r.add(Box(S * 0.2 * bk, S * 0.34, S * 0.03), T(0, hipY - S * 0.1, S * 0.16), st.cloth);
      for (let i = 0; i < 2; i++) r.add(Cone(S * 0.06, S * 0.14, 3), C(T((i - 0.5) * S * 0.1, hipY - S * 0.32, S * 0.16), RX(Math.PI)), st.cloth);
    } else {
      r.add(Box(S * 0.24 * bk, S * 0.36, S * 0.03), T(0, hipY - S * 0.1, S * 0.16), st.cloth);
      r.add(Box(S * 0.25 * bk, S * 0.035, S * 0.035), T(0, hipY - S * 0.27, S * 0.165), st.trim);
    }
  }

  // ---- 披风（背后，肩到膝窝；红方下摆撕碎）----
  if (opts.cape ?? (ch || !robe)) {
    const cT = shY + S * 0.02, cB = robe ? S * 0.3 : kneeY - S * 0.02, cH = cT - cB;
    r.add(Box(S * 0.5 * bk, cH, S * 0.03), C(T(0, cB + cH / 2, -S * 0.2 * bk), RX(0.1)), ch ? st.cloth : st.clothDark);
    if (ch) for (let i = 0; i < 4; i++) r.add(Cone(S * 0.07, S * 0.16, 3), C(T((i - 1.5) * S * 0.12 * bk, cB - S * 0.06, -S * 0.24 * bk), RX(Math.PI)), st.cloth);
    else r.add(Box(S * 0.52 * bk, S * 0.04, S * 0.035), C(T(0, cB + S * 0.02, -S * 0.22 * bk), RX(0.1)), st.trim);
  }

  // ---- 颈 + 头 ----
  r.add(Cyl(S * 0.08, S * 0.1, neckY - shY + S * 0.06, 6), T(0, (shY + neckY) / 2, 0), ch ? st.dark : st.leather);
  const helm = opts.helm || (ch ? 'horn' : 'plume');
  if (helm === 'hood') {
    r.add(Sph(headR * 1.2, 8, 6), C(T(0, hY, -S * 0.02), SC(1, 1.05, 1.1)), st.cloth);
    r.add(Cone(headR * 0.95, headR * 1.5, ch ? 4 : 8), C(T(0, hY + headR * 0.5, -headR * 0.7), RX(-1.0)), st.cloth);   // 兜帽尖垂向后
    r.add(Box(headR * 1.25, headR * 1.1, S * 0.04), T(0, hY - headR * 0.1, headR * 1.0), st.dark);                     // 兜帽里的阴影脸
    r.add(Box(headR * 1.45, headR * 0.2, S * 0.05), T(0, hY + headR * 0.55, headR * 0.98), st.cloth);                  // 兜帽前沿
    for (const sx of [-1, 1]) r.add(Box(headR * 0.24, headR * 0.12, S * 0.02), T(sx * headR * 0.3, hY, headR * 1.05), st.eye);
    if (ch) for (const sx of [-1, 1]) r.add(Cone(S * 0.045, S * 0.26, 4), C(T(sx * headR * 0.85, hY + headR * 0.85, -headR * 0.1), RZ(-sx * 0.55), RX(-0.3)), st.trim);
    else r.add(Tor(headR * 1.12, S * 0.02, 3, 12), C(T(0, hY + headR * 0.35, 0), RX(Math.PI / 2 - 0.25)), st.trim);
  } else if (ch) {
    // 红方头盔：棱角头盔 + 带獠牙的面甲 + 两点眼光 + 一对后掠的角
    r.add(Ico(headR * 1.08), C(T(0, hY + S * 0.02, 0), SC(1, 1.1, 1.05)), st.armorDark);
    r.add(Box(headR * 1.5, headR * 0.7, headR * 0.5), C(T(0, hY - headR * 0.35, headR * 0.62), RX(0.15)), st.armor);
    for (let i = 0; i < 4; i++) r.add(Cone(S * 0.018, S * 0.06, 3), C(T((i - 1.5) * headR * 0.28, hY - headR * 0.72, headR * 0.82), RX(Math.PI)), st.trim);   // 獠牙
    for (const sx of [-1, 1]) {
      r.add(Box(headR * 0.34, headR * 0.12, S * 0.02), C(T(sx * headR * 0.36, hY + headR * 0.05, headR * 1.0), RZ(sx * 0.3)), st.eye);
      r.add(Cone(S * 0.055, S * 0.36, 4), C(T(sx * headR * 0.95, hY + headR * 0.75, -headR * 0.15), RZ(-sx * 0.8), RX(-0.45)), st.trim);
    }
    r.add(Box(S * 0.04, headR * 0.6, headR * 1.3), T(0, hY + headR * 1.0, -headR * 0.1), st.cloth);   // 头顶一道红鬃
  } else {
    // 蓝方头盔：桶形大头盔 + 圆顶 + 十字目缝 + 金边 + 盔缨（弧形排开）
    r.add(Cyl(headR * 0.98, headR * 1.05, headR * 1.5, 10), T(0, hY - headR * 0.05, 0), st.armor);
    r.add(Dome(headR * 0.98, 10), T(0, hY + headR * 0.7, 0), st.armor);
    r.add(Box(headR * 1.3, headR * 0.14, S * 0.04), T(0, hY + headR * 0.12, headR * 0.98), st.dark);   // 横目缝
    r.add(Box(headR * 0.14, headR * 0.7, S * 0.04), T(0, hY - headR * 0.15, headR * 0.99), st.dark);   // 竖缝
    r.add(Tor(headR * 1.02, S * 0.022, 3, 12), C(T(0, hY + headR * 0.7, 0), RX(Math.PI / 2)), st.trim);
    r.add(Tor(headR * 1.05, S * 0.022, 3, 12), C(T(0, hY - headR * 0.78, 0), RX(Math.PI / 2)), st.trim);
    if (helm === 'plume') for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      r.add(Box(S * 0.05, headR * 0.5, headR * 0.45), C(T(0, hY + headR * 0.75 + Math.cos(a) * headR * 0.75, Math.sin(a) * headR * 0.95), RX(a)), i % 2 ? st.cloth : st.clothLite);
    }
    if (helm === 'goggles') for (const sx of [-1, 1]) r.add(Cyl(headR * 0.3, headR * 0.3, S * 0.08, 8), C(T(sx * headR * 0.42, hY + headR * 0.45, headR * 0.9), RX(Math.PI / 2)), st.eye);
  }

  // ---- 肩甲（层叠）----
  for (const sx of [-1, 1]) {
    const px = sx * shX, py = shY;
    if (ch) {
      r.add(Box(S * 0.26 * bk, S * 0.12, S * 0.28), C(T(px, py + S * 0.05, 0), RZ(sx * 0.35)), st.armor);
      r.add(Box(S * 0.22 * bk, S * 0.08, S * 0.24), C(T(px + sx * S * 0.05, py - S * 0.04, 0), RZ(sx * 0.5)), st.armorDark);
      for (const [dz, h] of [[-0.08, 0.26], [0.04, 0.22], [0.13, 0.15]]) r.add(Cone(S * 0.04, S * h, 4), C(T(px + sx * S * 0.06, py + S * 0.17, S * dz), RZ(-sx * 0.55)), st.trim);
    } else if (robe) {
      r.add(Dome(S * 0.14 * bk), C(T(px, py - S * 0.02, 0), SC(1, 0.8, 1)), st.clothLite);
    } else {
      r.add(Dome(S * 0.18 * bk, 10), C(T(px, py, 0), SC(1.05, 0.85, 1.1)), st.armor);
      r.add(Dome(S * 0.15 * bk, 10), C(T(px + sx * S * 0.04, py - S * 0.07, 0), SC(1.05, 0.7, 1.05)), shade(st.armor, 0.9));
      r.add(Tor(S * 0.175 * bk, S * 0.018, 3, 10), C(T(px, py, 0), RX(Math.PI / 2), SC(1.05, 1.1, 1)), st.trim);
    }
  }

  // ---- 手臂（右 = 主手 -X，左 = 副手 +X）：大臂 / 肘 / 前弯的小臂 / 手套 ----
  const arm = (sx) => {
    const sh = V3(sx * shX, shY - S * 0.03, 0), el = elbow(sx), hd = handP(sx);
    if (robe) {
      limb(r, sh, el, S * 0.075, S * 0.085, st.cloth);
      limb(r, el, hd, S * 0.09, S * 0.14, st.cloth, 7);   // 宽袖（向手腕张开）
      r.add(Box(S * 0.09, S * 0.1, S * 0.09), T(hd.x, hd.y - S * 0.02, hd.z + S * 0.02), ch ? st.dark : shade(st.leather, 1.2));
    } else {
      limb(r, sh, el, S * 0.075 * bk, S * 0.065 * bk, ch ? st.dark : st.clothDark);
      r.add(Sph(S * 0.07 * bk, 6, 4), T(el.x, el.y, el.z), ch ? st.armor : st.trim);   // 肘
      limb(r, el, hd, S * 0.08 * bk, S * 0.075 * bk, metal);                           // 臂甲
      r.add(Box(S * 0.12 * bk, S * 0.12, S * 0.13), T(hd.x, hd.y - S * 0.02, hd.z + S * 0.02), ch ? st.dark : st.leather);   // 手套
      if (ch) r.add(Cone(S * 0.03, S * 0.12, 3), C(T(el.x + sx * S * 0.06, el.y, el.z - S * 0.02), RZ(-sx * Math.PI / 2)), st.trim);   // 肘刺
    }
  };
  out.mainPivot = [-shX, shY, 0]; out.offPivot = [shX, shY, 0];
  const mh = handP(-1), oh = handP(1);
  out.mainHand = [mh.x, mh.y, mh.z]; out.offHand = [oh.x, oh.y, oh.z];
  out.hand = { y: mh.y, z: mh.z };
  r.on(opts.mainBone ?? BONE.ARM_MAIN, out.mainPivot, opts.mainK ?? -1, () => { arm(-1); opts.onMain?.(out); });
  r.on(BONE.ARM_OFF, out.offPivot, 1, () => { arm(1); opts.onOff?.(out); });
  return out;
}

// ---- 武器 / 手持件（坐标都以手为原点） ----
function sword(r, S, st, h) {
  const [x, y, z] = h;
  const base = C(T(x, y, z), RX(0.6));   // 刀尖斜指前上方（举过头顶时刀在脑后，劈下时刀向前下）
  if (st.chaos) {
    // 锯齿砍刀：宽刃 + 背上一排齿 + 斜切刀尖
    r.add(Box(S * 0.05, S * 0.14, S * 0.05), C(base, T(0, S * 0.02, 0)), st.dark);
    r.add(Box(S * 0.05, S * 0.8, S * 0.26), C(base, T(0, S * 0.49, S * 0.05)), '#8d8286');
    for (let i = 0; i < 4; i++) r.add(Cone(S * 0.04, S * 0.12, 3), C(base, T(0, S * (0.2 + i * 0.16), -S * 0.08), RX(-Math.PI / 2)), st.trim);
    r.add(Cone(S * 0.13, S * 0.22, 3), C(base, T(0, S * 0.98, S * 0.1), RY(Math.PI / 2)), '#8d8286');
  } else {
    r.add(Box(S * 0.05, S * 0.16, S * 0.05), C(base, T(0, 0, 0)), st.leather);
    r.add(Box(S * 0.07, S * 0.05, S * 0.3), C(base, T(0, S * 0.09, 0)), st.trim);   // 护手
    r.add(Box(S * 0.05, S * 1.0, S * 0.14), C(base, T(0, S * 0.61, 0)), '#eef3f8');
    r.add(Cone(S * 0.1, S * 0.2, 4), C(base, T(0, S * 1.21, 0), RY(Math.PI / 4)), '#eef3f8');
    r.add(Sph(S * 0.05, 6, 4), C(base, T(0, -S * 0.1, 0)), st.trim);   // 剑首
  }
}
function shield(r, S, st, h, big = 1) {
  const [x, y, z] = h;
  const base = C(T(x + S * 0.1, y + S * 0.2, z + S * 0.06), RY(0.55));   // 立在左前方，盾面朝外前
  if (st.chaos) {
    r.add(Cyl(S * 0.36 * big, S * 0.36 * big, S * 0.07, 7), C(base, RZ(Math.PI / 2), RY(0.2)), st.armorDark);
    r.add(Cone(S * 0.1, S * 0.3, 5), C(base, T(S * 0.12, 0, 0), RZ(-Math.PI / 2)), st.trim);   // 盾心尖刺
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      r.add(Cone(S * 0.05, S * 0.18, 3), C(base, T(S * 0.02, Math.cos(a) * S * 0.38 * big, Math.sin(a) * S * 0.38 * big), RX(-a)), st.trim);
    }
    r.add(Box(S * 0.02, S * 0.5 * big, S * 0.08), C(base, T(S * 0.05, 0, 0), RX(0.6)), st.cloth);   // 一道阵营色的血痕
  } else {
    // 鸢盾：上方下尖，金边，盾面阵营色 + 金十字
    r.add(Box(S * 0.07, S * 0.52 * big, S * 0.54 * big), C(base, T(0, S * 0.08, 0)), st.cloth);
    r.add(Box(S * 0.07, S * 0.38 * big, S * 0.38 * big), C(base, T(0, -S * 0.2 * big, 0), RX(Math.PI / 4)), st.cloth);
    r.add(Box(S * 0.08, S * 0.56 * big, S * 0.06), C(base, T(S * 0.01, 0, 0)), st.trim);
    r.add(Box(S * 0.08, S * 0.06, S * 0.4 * big), C(base, T(S * 0.01, S * 0.12, 0)), st.trim);
    r.add(Box(S * 0.06, S * 0.05, S * 0.58 * big), C(base, T(-S * 0.005, S * 0.33 * big, 0)), st.trim);   // 上沿金边
  }
}
function staff(r, S, st, h, top) {
  const [x, y, z] = h;
  const len = S * 1.75;
  const base = C(T(x, y, z + S * 0.02), RX(0.12));
  r.add(Cyl(S * 0.035, S * 0.04, len, 5), C(base, T(0, len * 0.28, 0)), st.chaos ? st.dark : st.wood);
  const tip = C(base, T(0, len * 0.78, 0));
  top(tip, len);
}

// ============================================================================
// 各兵种
// ============================================================================
const B = {};

// 近战兵：刀盾
B.melee = (r, S, st) => humanoid(r, S, st, {
  onMain: (o) => sword(r, S, st, o.mainHand),
  onOff: (o) => shield(r, S, st, o.offHand, st.chaos ? 1.05 : 1.25),   // 红方的盾一圈尖刺，本身就更宽
});

// 远程兵：法杖
B.ranged = (r, S, st) => humanoid(r, S, st, {
  robe: true, helm: 'hood', mainK: 0.45,
  onMain: (o) => staff(r, S, st, o.mainHand, (tip) => {
    if (st.chaos) {
      r.add(Ico(S * 0.13), C(tip, T(0, S * 0.02, 0)), st.trim);   // 角骨
      for (const sx of [-1, 1]) r.add(Cone(S * 0.04, S * 0.26, 4), C(tip, T(sx * S * 0.1, S * 0.12, 0), RZ(-sx * 0.6)), st.trim);
      r.add(Oct(S * 0.11), C(tip, T(0, S * 0.24, 0)), st.gem);
    } else {
      for (let i = 0; i < 3; i++) {
        const a = i / 3 * Math.PI * 2;
        r.add(Box(S * 0.03, S * 0.26, S * 0.03), C(tip, T(Math.cos(a) * S * 0.08, S * 0.1, Math.sin(a) * S * 0.08), RY(-a), RZ(-0.3)), st.trim);   // 托爪
      }
      r.add(Oct(S * 0.13), C(tip, T(0, S * 0.22, 0), SC(1, 1.35, 1)), st.gem);
    }
  }),
});

// 治疗兵：牧师（长袍 + 顶端光环十字的杖）
B.healer = (r, S, st) => humanoid(r, S, st, {
  robe: true, helm: st.chaos ? 'hood' : 'plume', mainK: 0.45,
  onMain: (o) => staff(r, S, st, o.mainHand, (tip) => {
    r.add(Tor(S * 0.2, S * 0.03, 3, st.chaos ? 7 : 14), C(tip, T(0, S * 0.22, 0)), st.trim);
    if (st.chaos) {
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * Math.PI * 2;
        r.add(Cone(S * 0.03, S * 0.12, 3), C(tip, T(Math.cos(a) * S * 0.24, S * 0.22 + Math.sin(a) * S * 0.24, 0), RZ(a - Math.PI / 2)), st.trim);   // 荆棘环
      }
      r.add(Oct(S * 0.09), C(tip, T(0, S * 0.22, 0)), st.gem);
    } else {
      r.add(Box(S * 0.05, S * 0.26, S * 0.05), C(tip, T(0, S * 0.22, 0)), '#fff6dc');
      r.add(Box(S * 0.2, S * 0.05, S * 0.05), C(tip, T(0, S * 0.26, 0)), '#fff6dc');
    }
  }),
  onOff: () => {
    // 腰侧挂一只香炉 / 药瓶
    r.add(Sph(S * 0.09, 6, 4), T(S * 0.36, S * 0.86, S * 0.22), st.chaos ? st.trim : st.gem);
  },
});

// 唤灵兵：法书在左手，右手托召唤光球；手上方悬着一圈符文
B.summoner = (r, S, st) => {
  const o = humanoid(r, S, st, {
    robe: true, helm: 'hood', mainK: -1.3, mainBone: BONE.THRUST,
    onMain: (h) => r.add(Ico(S * 0.1), T(h.mainHand[0], h.mainHand[1] + S * 0.12, h.mainHand[2] + S * 0.06), st.gem),
    onOff: (h) => {
      const [x, y, z] = h.offHand;
      const bk = C(T(x - S * 0.05, y + S * 0.08, z + S * 0.14), RX(-0.9));
      for (const sx of [-1, 1]) r.add(Box(S * 0.2, S * 0.03, S * 0.26), C(bk, T(sx * S * 0.1, 0, 0), RZ(sx * -0.2)), st.chaos ? st.dark : st.clothDark);   // 封皮
      r.add(Box(S * 0.36, S * 0.025, S * 0.24), C(bk, T(0, S * 0.02, 0)), '#efe6cf');   // 书页
      if (st.chaos) r.add(Sph(S * 0.05, 6, 4), C(bk, T(0, -S * 0.03, 0)), st.eye);   // 封面上的眼
    },
  });
  // 悬浮符文环（独立的浮动件，不跟手摆）
  r.on(BONE.SPIN, [o.offHand[0], 0, o.offHand[2] + S * 0.1], 1.4, () => {
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2;
      r.add(Box(S * 0.08, S * 0.12, S * 0.02), C(T(o.offHand[0] + Math.cos(a) * S * 0.24, o.offHand[1] + S * 0.45, o.offHand[2] + S * 0.1 + Math.sin(a) * S * 0.24), RY(-a)), st.gem);
    }
  });
  return o;
};

// 工程兵：护目镜头盔 + 背包齿轮 + 大扳手
B.engineer = (r, S, st) => {
  const o = humanoid(r, S, st, {
    helm: st.chaos ? 'horn' : 'goggles',
    onMain: (h) => {
      const [x, y, z] = h.mainHand;
      const base = C(T(x, y, z), RX(0.6));
      r.add(Box(S * 0.07, S * 0.7, S * 0.07), C(base, T(0, S * 0.3, 0)), st.chaos ? st.dark : '#9aa4ad');
      if (st.chaos) {
        r.add(Cyl(S * 0.2, S * 0.2, S * 0.04, 8), C(base, T(0, S * 0.7, 0), RZ(Math.PI / 2)), st.armor);   // 圆锯
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          r.add(Cone(S * 0.04, S * 0.1, 3), C(base, T(0, S * 0.7 + Math.cos(a) * S * 0.22, Math.sin(a) * S * 0.22), RX(-a)), st.trim);
        }
      } else {
        for (const sz of [-1, 1]) r.add(Box(S * 0.08, S * 0.2, S * 0.07), C(base, T(0, S * 0.7, sz * S * 0.08)), '#b8c2cc');   // 扳手开口
        r.add(Box(S * 0.08, S * 0.08, S * 0.24), C(base, T(0, S * 0.62, 0)), '#b8c2cc');
      }
    },
    onOff: (h) => r.add(Box(S * 0.14, S * 0.18, S * 0.1), T(h.offHand[0], h.offHand[1] - S * 0.02, h.offHand[2]), st.trim),   // 工具盒
  });
  // 背包 + 齿轮 + 烟囱
  const by = o.legH + o.torsoH * 0.55;
  r.add(Box(S * 0.5, S * 0.52, S * 0.26), T(0, by, -S * 0.34), st.chaos ? st.armorDark : st.leather);
  const gear = (gx, gy, gz, rr, col) => {
    r.add(Cyl(rr, rr, S * 0.06, 8), C(T(gx, gy, gz), RX(Math.PI / 2)), col);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      r.add(Box(S * 0.06, S * 0.06, S * 0.06), T(gx + Math.cos(a) * rr * 1.08, gy + Math.sin(a) * rr * 1.08, gz), col);
    }
  };
  gear(0, by + S * 0.04, -S * 0.49, S * 0.16, st.trim);
  r.add(Cyl(S * 0.05, S * 0.06, S * 0.4, 6), T(S * 0.18, by + S * 0.4, -S * 0.38), st.chaos ? st.dark : '#8f989f');   // 烟囱
  if (st.chaos) for (const sx of [-1, 1]) r.add(Cone(S * 0.05, S * 0.24, 4), C(T(sx * S * 0.22, by + S * 0.3, -S * 0.42), RZ(-sx * 0.4)), st.trim);
  return o;
};

// 超级兵：机甲（大块头、宽肩、巨拳；红方满身尖角、爪）
B.super = (r, S, st) => {
  const legH = S * 0.7, torsoH = S * 0.78, hipX = S * 0.3;
  const hull = st.chaos ? st.armorDark : st.armor;
  for (const sx of [-1, 1]) {
    r.on(sx < 0 ? BONE.LEG_R : BONE.LEG_L, [sx * hipX, legH, 0], 0.7, () => {
      r.add(Box(S * 0.3, legH * 0.55, S * 0.34), T(sx * hipX, legH * 0.72, 0), hull);
      r.add(Box(S * 0.24, legH * 0.5, S * 0.28), T(sx * hipX, legH * 0.28, S * 0.04), st.dark);
      r.add(Box(S * 0.36, S * 0.14, S * 0.5), T(sx * hipX, S * 0.07, S * 0.08), hull);   // 大脚
      r.add(Box(S * 0.32, S * 0.1, S * 0.08), T(sx * hipX, legH * 0.5, S * 0.2), st.chaos ? st.trim : st.cloth);   // 膝甲
      if (st.chaos) r.add(Cone(S * 0.06, S * 0.2, 4), C(T(sx * hipX, legH * 0.52, S * 0.26), RX(Math.PI / 2)), st.trim);
    });
  }
  const tY = legH + torsoH / 2;
  r.add(Box(S * 0.86, torsoH, S * 0.6), T(0, tY, 0), hull);
  r.add(Box(S * 0.6, torsoH * 0.55, S * 0.1), T(0, tY + torsoH * 0.08, S * 0.33), st.cloth);   // 胸甲阵营色
  r.add(Cyl(S * 0.12, S * 0.12, S * 0.06, 8), C(T(0, tY + torsoH * 0.12, S * 0.39), RX(Math.PI / 2)), st.eye);   // 反应炉
  r.add(Box(S * 0.5, S * 0.4, S * 0.24), T(0, tY + S * 0.05, -S * 0.4), st.dark);   // 背后动力箱
  for (const sx of [-1, 1]) r.add(Cyl(S * 0.06, S * 0.07, S * 0.34, 6), T(sx * S * 0.16, tY + S * 0.35, -S * 0.44), st.dark);   // 排气管
  // 头：矮座舱 + 一条目镜
  const hY = legH + torsoH + S * 0.14;
  if (st.chaos) {
    r.add(Box(S * 0.36, S * 0.26, S * 0.34), C(T(0, hY, S * 0.06), RX(0.15)), st.armor);
    for (const sx of [-1, 1]) r.add(Cone(S * 0.06, S * 0.4, 4), C(T(sx * S * 0.2, hY + S * 0.2, -S * 0.02), RZ(-sx * 0.6), RX(-0.4)), st.trim);
    r.add(Box(S * 0.26, S * 0.05, S * 0.02), T(0, hY + S * 0.02, S * 0.24), st.eye);
  } else {
    r.add(Sph(S * 0.22, 10, 6), C(T(0, hY, S * 0.04), SC(1.1, 0.8, 1)), st.armor);
    r.add(Box(S * 0.3, S * 0.06, S * 0.04), T(0, hY + S * 0.02, S * 0.24), st.eye);
    r.add(Box(S * 0.05, S * 0.12, S * 0.3), T(0, hY + S * 0.2, 0), st.trim);
  }
  // 巨肩
  const shY = legH + torsoH * 0.92, shX = S * 0.56;
  for (const sx of [-1, 1]) {
    if (st.chaos) {
      r.add(Box(S * 0.42, S * 0.3, S * 0.5), C(T(sx * shX, shY + S * 0.06, 0), RZ(sx * 0.25)), st.armor);
      for (const dz of [-0.14, 0.02, 0.18]) r.add(Cone(S * 0.06, S * 0.34, 4), C(T(sx * (shX + S * 0.1), shY + S * 0.28, S * dz), RZ(-sx * 0.45)), st.trim);
    } else {
      r.add(new THREE.SphereGeometry(S * 0.3, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), C(T(sx * shX, shY - S * 0.02, 0), SC(1, 0.8, 1.1)), st.armor);
      r.add(Tor(S * 0.29, S * 0.03, 3, 12), C(T(sx * shX, shY - S * 0.02, 0), RX(Math.PI / 2), SC(1, 1.1, 1)), st.trim);
      r.add(Box(S * 0.06, S * 0.2, S * 0.3), T(sx * (shX + S * 0.2), shY - S * 0.02, 0), st.cloth);
    }
  }
  // 臂：主手巨拳（红方利爪），副手护臂
  const armLen = S * 0.66;
  const arm = (sx, main) => {
    const hx = sx * (shX + S * 0.04), hy = shY - armLen;
    r.add(Box(S * 0.2, armLen * 0.55, S * 0.22), T(hx, shY - armLen * 0.3, 0), st.dark);
    r.add(Box(S * 0.3, armLen * 0.5, S * 0.32), T(hx, shY - armLen * 0.72, S * 0.04), hull);   // 前臂
    if (main) {
      if (st.chaos) {
        r.add(Box(S * 0.3, S * 0.2, S * 0.3), T(hx, hy - S * 0.06, S * 0.08), st.armor);
        for (const dx of [-0.1, 0, 0.1]) r.add(Cone(S * 0.05, S * 0.28, 4), C(T(hx + S * dx, hy - S * 0.2, S * 0.2), RX(Math.PI / 2 + 0.6)), st.trim);   // 爪
      } else {
        r.add(Box(S * 0.36, S * 0.3, S * 0.36), T(hx, hy - S * 0.06, S * 0.08), st.armor);   // 巨拳
        r.add(Box(S * 0.38, S * 0.06, S * 0.38), T(hx, hy + S * 0.06, S * 0.08), st.trim);
      }
    } else {
      r.add(Box(S * 0.1, S * 0.5, S * 0.42), T(hx + sx * S * 0.16, shY - armLen * 0.6, S * 0.06), st.chaos ? st.armor : st.cloth);   // 臂盾
    }
  };
  r.on(BONE.THRUST, [-shX, shY, 0], -1.4, () => arm(-1, true));   // 出拳：先收再向前轰
  r.on(BONE.ARM_OFF, [shX, shY, 0], 1, () => arm(1, false));
};

// ---- 载具共用：车轮 ----
function wheel(r, S, st, x, y, z, rad) {
  r.on(BONE.WHEEL, [x, y, z], 1.4 / Math.max(0.1, rad / S), () => {
    r.add(Cyl(rad, rad, S * 0.14, st.chaos ? 7 : 12), C(T(x, y, z), RZ(Math.PI / 2)), st.chaos ? st.dark : st.wood);
    r.add(Cyl(rad * 0.3, rad * 0.3, S * 0.18, 6), C(T(x, y, z), RZ(Math.PI / 2)), st.trim);   // 轮毂
    for (let i = 0; i < (st.chaos ? 3 : 4); i++) r.add(Box(S * 0.16, rad * 1.8, S * 0.05), C(T(x, y, z), RX(i / (st.chaos ? 3 : 4) * Math.PI)), st.chaos ? st.armorDark : shade(st.wood, 0.8));   // 辐条
    if (st.chaos) for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      r.add(Cone(S * 0.04, S * 0.12, 3), C(T(x, y + Math.cos(a) * rad, z + Math.sin(a) * rad), RX(-a)), st.trim);   // 轮刺
    }
  });
}

// 炮车：车体 + 四轮 + 炮管（攻击后坐）
B.siege = (r, S, st) => {
  const wr = S * 0.34, bodyY = wr + S * 0.22;
  r.add(Box(S * 1.0, S * 0.36, S * 1.4), T(0, bodyY, 0), st.chaos ? st.armorDark : st.wood);
  r.add(Box(S * 1.04, S * 0.08, S * 1.44), T(0, bodyY + S * 0.2, 0), st.chaos ? st.armor : st.trim);
  r.add(Box(S * 0.9, S * 0.2, S * 0.1), T(0, bodyY + S * 0.02, S * 0.72), st.cloth);   // 阵营色挡板
  for (const sx of [-1, 1]) r.add(Box(S * 0.04, S * 0.26, S * 1.1), T(sx * S * 0.52, bodyY, 0), st.cloth);   // 两侧阵营色车板
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) wheel(r, S, st, sx * S * 0.58, wr, sz * S * 0.46, wr);
  // 炮座 + 炮管
  const by = bodyY + S * 0.44;
  r.add(Cyl(S * 0.34, S * 0.4, S * 0.2, st.chaos ? 6 : 10), T(0, bodyY + S * 0.28, -S * 0.05), st.chaos ? st.armor : st.armorDark);
  r.on(BONE.RECOIL, [0, by, 0], S * 0.28, () => {
    if (st.chaos) {
      r.add(Cyl(S * 0.17, S * 0.24, S * 1.2, 6), C(T(0, by, S * 0.25), RX(Math.PI / 2)), st.armorDark);
      // 龙口炮口：一圈向前的獠牙
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        r.add(Cone(S * 0.05, S * 0.22, 3), C(T(Math.cos(a) * S * 0.2, by + Math.sin(a) * S * 0.2, S * 0.92), RX(Math.PI / 2)), st.trim);
      }
      r.add(Box(S * 0.06, S * 0.3, S * 0.5), T(0, by + S * 0.22, S * 0.2), st.trim);   // 背鳍
    } else {
      r.add(Cyl(S * 0.18, S * 0.23, S * 1.2, 12), C(T(0, by, S * 0.25), RX(Math.PI / 2)), st.armor);
      for (const z of [-0.2, 0.3, 0.8]) r.add(Tor(S * 0.21, S * 0.035, 3, 12), T(0, by, S * z), st.trim);   // 金箍
      r.add(Sph(S * 0.24, 10, 6), T(0, by, -S * 0.35), st.armor);   // 炮尾
    }
  });
};

// 投石车（ram）：车架 + 四轮 + 抛臂（攻击时向前甩）
B.ram = (r, S, st) => {
  const wr = S * 0.32, bodyY = wr + S * 0.14;
  r.add(Box(S * 0.9, S * 0.24, S * 1.5), T(0, bodyY, 0), st.chaos ? st.armorDark : st.wood);
  r.add(Box(S * 0.94, S * 0.06, S * 1.54), T(0, bodyY + S * 0.14, 0), st.chaos ? st.armor : st.trim);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) wheel(r, S, st, sx * S * 0.52, wr, sz * S * 0.5, wr);
  const pivY = bodyY + S * 0.72;
  for (const sx of [-1, 1]) {
    r.add(Box(S * 0.1, S * 0.9, S * 0.12), C(T(sx * S * 0.3, bodyY + S * 0.44, S * 0.12), RX(0.3)), st.chaos ? st.dark : st.wood);   // 人字架
    r.add(Box(S * 0.1, S * 0.9, S * 0.12), C(T(sx * S * 0.3, bodyY + S * 0.44, -S * 0.12), RX(-0.3)), st.chaos ? st.dark : st.wood);
  }
  r.add(Cyl(S * 0.06, S * 0.06, S * 0.72, 6), C(T(0, pivY, 0), RZ(Math.PI / 2)), st.trim);   // 横轴
  // 抛臂：静止时向后上方举着，攻击时先往后压一点、再向前甩过头顶
  r.on(BONE.THRUST, [0, pivY, 0], 1.5, () => {
    const armM = C(T(0, pivY, 0), RX(-0.75));
    r.add(Box(S * 0.12, S * 1.35, S * 0.12), C(armM, T(0, S * 0.45, 0)), st.chaos ? st.armorDark : shade(st.wood, 1.15));
    r.add(Cyl(S * 0.22, S * 0.14, S * 0.14, st.chaos ? 5 : 8), C(armM, T(0, S * 1.12, 0)), st.chaos ? st.armor : st.leather);   // 抛篮
    r.add(Ico(S * 0.14), C(armM, T(0, S * 1.2, 0)), st.chaos ? st.trim : '#8d8579');   // 石弹
    r.add(st.chaos ? Ico(S * 0.26) : Box(S * 0.36, S * 0.34, S * 0.34), C(armM, T(0, -S * 0.3, 0)), st.chaos ? st.armor : st.armorDark);   // 配重
    if (st.chaos) for (const sx of [-1, 1]) r.add(Cone(S * 0.05, S * 0.2, 4), C(armM, T(sx * S * 0.2, -S * 0.3, 0), RZ(-sx * Math.PI / 2)), st.trim);
  });
  r.add(Box(S * 0.7, S * 0.18, S * 0.08), T(0, bodyY + S * 0.1, S * 0.78), st.cloth);
  for (const sx of [-1, 1]) r.add(Box(S * 0.04, S * 0.2, S * 1.2), T(sx * S * 0.47, bodyY, 0), st.cloth);
};

// 重装车：低矮宽厚的装甲车，前面一整面巨盾，顶上甲壳
B.heavy = (r, S, st) => {
  const wr = S * 0.26, hullY = wr + S * 0.26;
  r.add(Box(S * 1.2, S * 0.44, S * 1.3), T(0, hullY, 0), st.chaos ? st.armorDark : st.armor);
  for (const sx of [-1, 1]) for (const sz of [-0.42, 0, 0.42]) wheel(r, S, st, sx * S * 0.66, wr, sz * S, wr);
  // 甲壳顶：蓝方一块圆顶 + 金边，红方叠几片斜甲 + 骨刺
  if (st.chaos) {
    for (let i = 0; i < 3; i++) r.add(Box(S * 1.1 - i * S * 0.2, S * 0.14, S * 0.9 - i * S * 0.15), C(T(0, hullY + S * 0.28 + i * S * 0.12, -S * 0.08), RX(-0.08)), i % 2 ? st.armor : st.armorDark);
    for (const sx of [-1, 0, 1]) r.add(Cone(S * 0.07, S * 0.3, 4), T(sx * S * 0.3, hullY + S * 0.68, -S * 0.1), st.trim);
  } else {
    r.add(new THREE.SphereGeometry(S * 0.62, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), C(T(0, hullY + S * 0.2, -S * 0.05), SC(1, 0.62, 1)), st.cloth);
    r.add(Tor(S * 0.62, S * 0.04, 3, 16), C(T(0, hullY + S * 0.21, -S * 0.05), RX(Math.PI / 2)), st.trim);
    r.add(Box(S * 0.08, S * 0.1, S * 1.0), T(0, hullY + S * 0.56, -S * 0.05), st.trim);
  }
  // 巨盾
  const sz = S * 0.7;
  if (st.chaos) {
    r.add(Box(S * 1.3, S * 0.8, S * 0.12), C(T(0, hullY + S * 0.2, sz), RX(-0.25)), st.armor);
    for (const sx of [-0.45, 0, 0.45]) r.add(Cone(S * 0.08, S * 0.36, 4), C(T(sx * S, hullY + S * 0.2, sz + S * 0.12), RX(Math.PI / 2)), st.trim);   // 冲角尖刺
    r.add(Ico(S * 0.14), T(0, hullY + S * 0.44, sz + S * 0.02), st.trim);
    for (const sx of [-1, 1]) r.add(Box(S * 0.12, S * 0.05, S * 0.02), T(sx * S * 0.06, hullY + S * 0.44, sz + S * 0.14), st.eye);
    r.add(Box(S * 1.0, S * 0.28, S * 0.02), C(T(0, hullY + S * 0.02, sz + S * 0.07), RX(-0.25)), st.cloth);
    for (const sx of [-1, 1]) r.add(Box(S * 0.04, S * 0.3, S * 1.1), T(sx * S * 0.61, hullY, -S * 0.05), st.cloth);
  } else {
    r.add(Box(S * 1.3, S * 0.84, S * 0.12), C(T(0, hullY + S * 0.22, sz), RX(-0.2)), st.armor);
    r.add(Box(S * 1.36, S * 0.08, S * 0.14), C(T(0, hullY + S * 0.62, sz - S * 0.08), RX(-0.2)), st.trim);
    r.add(Box(S * 0.12, S * 0.62, S * 0.02), C(T(0, hullY + S * 0.22, sz + S * 0.07), RX(-0.2)), st.trim);
    r.add(Box(S * 0.5, S * 0.12, S * 0.02), C(T(0, hullY + S * 0.3, sz + S * 0.07), RX(-0.2)), st.trim);
    r.add(Box(S * 1.0, S * 0.3, S * 0.02), C(T(0, hullY + S * 0.02, sz + S * 0.06), RX(-0.2)), st.cloth);
  }
};

// ---- 非人形辅助单位 ----

// 图腾兵：悬浮的三段图腾（每段各自浮动）+ 顶端符文眼 + 环绕小石
B.totem = (r, S, st) => {
  const stone = st.chaos ? st.armorDark : '#d9d4c8';
  r.add(Cyl(S * 0.5, S * 0.64, S * 0.26, st.chaos ? 5 : 8), T(0, S * 0.13, 0), st.chaos ? st.dark : shade(stone, 0.8));   // 底座（不浮）
  r.add(Tor(S * 0.5, S * 0.03, 3, 12), C(T(0, S * 0.27, 0), RX(Math.PI / 2)), st.trim);
  let y = S * 0.46;
  for (let i = 0; i < 3; i++) {
    const w = S * (0.56 - i * 0.08), h = S * 0.42;
    r.on(BONE.BOB, [i * 1.7, 0, i * 2.3], S * 0.05, () => {
      r.add(st.chaos ? Cyl(w * 0.62, w * 0.72, h, 5) : Box(w, h, w), C(T(0, y + h / 2, 0), RY(i * 0.45)), i % 2 ? shade(stone, 0.9) : stone);
      r.add(Box(w * 1.08, S * 0.06, w * 1.08), C(T(0, y + h * 0.5, 0), RY(i * 0.45)), st.cloth);   // 阵营色符文带
      if (st.chaos) r.add(Cone(S * 0.05, S * 0.24, 4), C(T(w * 0.55, y + h * 0.7, 0), RZ(-0.9)), st.trim);
    });
    y += h + S * 0.06;
  }
  r.on(BONE.BOB, [5, 0, 5], S * 0.08, () => {
    r.add(Oct(S * 0.2), C(T(0, y + S * 0.2, 0), SC(1, 1.4, 1)), st.gem);   // 顶端符文眼
    if (st.chaos) for (const sx of [-1, 1]) r.add(Cone(S * 0.05, S * 0.3, 4), C(T(sx * S * 0.22, y + S * 0.28, 0), RZ(-sx * 0.7)), st.trim);
    else r.add(Tor(S * 0.28, S * 0.025, 3, 12), T(0, y + S * 0.2, 0), st.trim);
  });
  r.on(BONE.SPIN, [0, 0, 0], 1.1, () => {
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2;
      r.add(st.chaos ? Cone(S * 0.1, S * 0.26, 3) : Ico(S * 0.12), C(T(Math.cos(a) * S * 0.78, S * 0.9 + i * S * 0.18, Math.sin(a) * S * 0.78), RY(a)), st.chaos ? st.trim : shade(stone, 0.85));
    }
  });
};

// 术士兵：悬浮的兜帽术士（没有腿）——两层外张的长袍、收腰、披肩、深兜帽、两只宽袖；
// 右手法杖、左手托一团悬浮法球；腰间一圈符文绕着转。
B.warlock = (r, S, st) => {
  const ch = st.chaos, baseY = S * 0.2;
  // 下层袍摆（最宽）+ 上层袍身（收腰）
  r.add(Cyl(S * 0.3, S * 0.5, S * 0.5, ch ? 7 : 12), C(T(0, baseY + S * 0.25, 0), RY(0.2)), st.clothDark);
  r.add(Cyl(S * 0.2, S * 0.36, S * 0.55, ch ? 6 : 10), C(T(0, baseY + S * 0.72, 0), RY(0.5)), st.cloth);
  if (ch) {
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      r.add(Cone(S * 0.1, S * 0.26, 3), C(T(Math.sin(a) * S * 0.45, baseY - S * 0.06, Math.cos(a) * S * 0.45), RX(Math.PI)), st.clothDark);   // 碎下摆
    }
    for (let i = 0; i < 3; i++) r.add(Cone(S * 0.035, S * 0.18, 4), C(T((i - 1) * S * 0.1, baseY + S * 1.02, -S * 0.2), RX(-Math.PI / 2 - 0.4)), st.trim);   // 背脊骨刺
  } else {
    r.add(Cyl(S * 0.505, S * 0.51, S * 0.05, 12), T(0, baseY + S * 0.02, 0), st.trim);
    r.add(Cyl(S * 0.365, S * 0.37, S * 0.04, 10), T(0, baseY + S * 0.47, 0), st.trim);
    r.add(Box(S * 0.1, S * 0.95, S * 0.03), C(T(0, baseY + S * 0.5, S * 0.37), RX(-0.2)), st.trim);   // 前襟金线
  }
  r.add(Cyl(S * 0.22, S * 0.22, S * 0.06, 10), T(0, baseY + S * 0.95, 0), ch ? st.leather : st.trim);   // 腰带
  // 胸 + 披肩
  const shY = baseY + S * 1.28;
  r.add(Box(S * 0.4, S * 0.34, S * 0.26), T(0, baseY + S * 1.12, 0), st.cloth);
  r.add(Cone(S * 0.4, S * 0.26, ch ? 6 : 12), T(0, shY, 0), ch ? st.dark : st.clothLite);
  for (const sx of [-1, 1]) {
    if (ch) r.add(Cone(S * 0.05, S * 0.26, 4), C(T(sx * S * 0.3, shY + S * 0.08, 0), RZ(-sx * 0.6)), st.trim);
    else r.add(Dome(S * 0.12), T(sx * S * 0.28, shY - S * 0.04, 0), st.trim);
  }
  // 兜帽：深兜帽 + 前沿 + 暗影脸 + 两点眼光；垂向背后的帽尖
  const hY = shY + S * 0.22;
  r.add(Sph(S * 0.2, 8, 6), C(T(0, hY, -S * 0.02), SC(1, 1.05, 1.15)), st.clothDark);
  r.add(Cone(S * 0.16, S * 0.42, ch ? 4 : 8), C(T(0, hY + S * 0.12, -S * 0.2), RX(-1.1)), st.clothDark);
  r.add(Box(S * 0.26, S * 0.24, S * 0.04), T(0, hY - S * 0.02, S * 0.2), st.dark);
  r.add(Box(S * 0.32, S * 0.05, S * 0.05), T(0, hY + S * 0.12, S * 0.2), st.clothDark);
  for (const sx of [-1, 1]) r.add(Box(S * 0.06, S * 0.035, S * 0.02), T(sx * S * 0.06, hY, S * 0.23), st.eye);
  // 两只宽袖 + 手
  const sleeve = (sx) => {
    const sh = V3(sx * S * 0.28, shY - S * 0.06, 0), el = V3(sx * S * 0.36, shY - S * 0.36, S * 0.06), hd = V3(sx * S * 0.34, shY - S * 0.52, S * 0.24);
    limb(r, sh, el, S * 0.07, S * 0.08, st.cloth);
    limb(r, el, hd, S * 0.08, S * 0.13, st.cloth, 7);
    r.add(Box(S * 0.08, S * 0.09, S * 0.08), T(hd.x, hd.y - S * 0.02, hd.z + S * 0.03), ch ? st.dark : '#e9dcc4');
    return hd;
  };
  r.on(BONE.ARM_MAIN, [-S * 0.28, shY, 0], 0.45, () => {
    const hd = sleeve(-1);
    r.add(Cyl(S * 0.03, S * 0.035, S * 1.7, 5), T(hd.x, hd.y + S * 0.25, hd.z + S * 0.02), ch ? st.dark : st.wood);
    const top = hd.y + S * 1.1;
    if (ch) {
      r.add(Tor(S * 0.13, S * 0.03, 3, 6, Math.PI * 1.4), C(T(hd.x, top, hd.z + S * 0.02), RZ(0.6)), st.trim);   // 弯钩杖头
      r.add(Oct(S * 0.08), T(hd.x, top + S * 0.02, hd.z + S * 0.02), st.gem);
    } else {
      r.add(Oct(S * 0.12), C(T(hd.x, top + S * 0.04, hd.z + S * 0.02), SC(1, 1.4, 1)), st.gem);
      r.add(Tor(S * 0.13, S * 0.02, 3, 10), T(hd.x, top + S * 0.04, hd.z + S * 0.02), st.trim);
    }
  });
  r.on(BONE.ARM_OFF, [S * 0.28, shY, 0], 1, () => { sleeve(1); });
  r.on(BONE.BOB, [3, 0, 3], S * 0.05, () => r.add(Ico(S * 0.1), T(S * 0.34, shY - S * 0.36, S * 0.3), st.gem));   // 左手上方悬浮的法球
  r.on(BONE.SPIN, [0, 0, 0], 1.3, () => {
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2;
      r.add(Box(S * 0.12, S * 0.16, S * 0.03), C(T(Math.cos(a) * S * 0.66, baseY + S * 0.62, Math.sin(a) * S * 0.66), RY(-a + Math.PI / 2)), st.gem);
    }
  });
};

// 蚀骨兵：悬浮的骨灵（骷髅头 + 肋骨笼 + 一对骨翼）
B.corrupt = (r, S, st) => {
  const bone = st.chaos ? '#cdbf9e' : '#e6e2d6';
  const baseY = S * 0.5;
  r.add(Cone(S * 0.22, S * 0.6, 5), C(T(0, baseY - S * 0.18, 0), RX(Math.PI)), st.clothDark);   // 下方拖着的一缕灵体
  for (let i = 0; i < 3; i++) r.add(Tor(S * (0.3 - i * 0.04), S * 0.035, 3, 8, Math.PI * 1.5), C(T(0, baseY + S * (0.18 + i * 0.16), 0), RX(Math.PI / 2), RZ(Math.PI * 0.25 + Math.PI / 2)), bone);   // 肋骨
  r.add(Cyl(S * 0.05, S * 0.05, S * 0.6, 5), T(0, baseY + S * 0.34, -S * 0.22), bone);   // 脊椎
  r.add(Ico(S * 0.16), T(0, baseY + S * 0.34, 0), st.cloth);   // 笼里的灵核
  const hY = baseY + S * 0.86;
  r.add(Sph(S * 0.26, 8, 6), C(T(0, hY, S * 0.02), SC(1, 0.95, 1.1)), bone);
  r.add(Box(S * 0.3, S * 0.1, S * 0.24), T(0, hY - S * 0.22, S * 0.08), bone);   // 下颌
  for (const sx of [-1, 1]) r.add(Box(S * 0.09, S * 0.08, S * 0.03), T(sx * S * 0.1, hY + S * 0.02, S * 0.28), st.eye);
  if (st.chaos) for (const sx of [-1, 1]) r.add(Cone(S * 0.05, S * 0.34, 4), C(T(sx * S * 0.2, hY + S * 0.24, -S * 0.04), RZ(-sx * 0.5), RX(-0.4)), bone);
  // 骨翼：一根翼骨 + 两片灵膜
  for (const sx of [-1, 1]) {
    r.on(BONE.WING, [sx * S * 0.2, baseY + S * 0.62, -S * 0.12], sx * 1.4, () => {
      const w = C(T(sx * S * 0.2, baseY + S * 0.62, -S * 0.12), RZ(-sx * 0.9));
      r.add(Cyl(S * 0.03, S * 0.04, S * 0.8, 4), C(w, T(0, S * 0.4, 0)), bone);
      r.add(Box(S * 0.02, S * 0.7, S * 0.36), C(w, T(0, S * 0.38, -S * 0.2)), st.cloth);
      if (st.chaos) r.add(Cone(S * 0.04, S * 0.2, 3), C(w, T(0, S * 0.86, 0)), bone);
    });
  }
};

// 召唤物（牧灵幻兽 / 唤灵兵的幻灵）：悬浮的晶簇 + 绕转碎晶 + 脚下光环
B.shepherd_pet = (r, S, st) => {
  r.add(Tor(S * 0.46, S * 0.03, 3, 14), C(T(0, S * 0.03, 0), RX(Math.PI / 2)), st.clothLite);
  r.on(BONE.BOB, [0, 0, 0], S * 0.08, () => {
    r.add(Oct(S * 0.36), C(T(0, S * 0.75, 0), SC(1, 1.5, 1), RY(0.4)), st.clothLite);
    r.add(Oct(S * 0.22), C(T(0, S * 0.75, 0), SC(1, 1.5, 1), RY(1.2)), st.cloth);
  });
  r.on(BONE.SPIN, [0, 0, 0], 1.6, () => {
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2;
      r.add(Oct(S * 0.11), C(T(Math.cos(a) * S * 0.56, S * (0.55 + (i % 2) * 0.3), Math.sin(a) * S * 0.56), SC(1, 1.6, 1)), st.gem);
    }
  });
};
B.summon_spirit = B.shepherd_pet;

// 自制兵种 / 未登记类型：不拿武器的阵营步兵（靠颜色与图标区分）
function generic(r, S, st) { humanoid(r, S, st, {}); }

/** 这些类型有专属造型（其余走 generic） */
export const MINION_MODEL_TYPES = Object.keys(B);

/**
 * 建一个小兵几何（带骨骼属性）。
 * @returns {{ geo, topY, animated: true }}
 */
export function buildMinion(type, color, S, faction) {
  const st = unitStyle(faction, color);
  const r = new Rig();
  (B[type] || generic)(r, S, st);
  return rigPack(r.parts);
}
