/**
 * WorldDominion.js —— 统治战场的"景"：每个据点按名字立一组场景物、据点归属旗、水晶枢纽两侧的战旗、峡谷里的砂岩巨岩。
 *
 * 用户："水晶之痕为沙漠黄沙风格，我目前觉得统治战场的地图做的都不如原先的，自己去搜统治战场每个据点叫啥名
 *        并且在地图上应该有对应的装饰。"
 * 原版水晶之痕（Crystal Scar）的五个据点：风车 Windmill、钻机 Drill、兽骨场 Boneyard、采石场 Quarry、精炼厂 Refinery；
 * 这张图另有两个由基地节点改成的据点：商栈、望塔。画面重构时旧的据点装饰层（DominionPropsLayer）随旧地形一起删了，
 * 新世界里一直没补回来 —— 这就是"不如原先的"。这里按写实画面重做：
 *   · 每个据点一组实体场景物（不是图标）：风车真的在转，钻机的钻杆在转，精炼厂的炉口是亮的……
 *   · 据点旁一面归属旗，颜色跟着占领状态走（实体的 _captureOwner）；
 *   · 水晶枢纽两侧各一面本阵营的战旗；
 *   · 不可走的沙地里立着几座砂岩巨岩（方山），沙漠峡谷才有远近。沙漠不种树。
 * 只要地图声明了 dominionNodes 就会建；据点 id 没登记在 SCENES 里的只有旗。
 *
 * 场景物的尺寸比例是造型本身的具名常量；摆在哪、多大、巨岩的疏密在 CONFIG.terrain.dominion。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { fbm, hash2 } from '../../data/noise.js';
import { RESOURCE_COLORS } from '../../core/resourceBar.js';
import { T, RX, RY, RZ, S, C, shade, flat, stoneBlock, lathe, prism, shard, horn, banner } from '../modelKit.js';
import { mergeParts, makeUnitMaterial } from '../UnitMeshFactory.js';
import { patchWorldMaterial } from './worldShading.js';
import { dominionSites, dominionKeepOut } from '../../data/dominionSites.js';
export { dominionSites, dominionKeepOut };

const cfg = () => CONFIG.terrain?.dominion || {};
const TAU = Math.PI * 2;
// 跨据点共用的材料色（木、锈铁、骨、砂岩、帆布）。造型里的局部配色，不随主题变
const WOOD = '#7a5636', WOOD_DARK = '#4e3722', RUST = '#8a5a3a', RUST_DARK = '#5a3a28', IRON = '#4a4a50';
const BONE = '#e6dcc2', SANDSTONE = '#c9a878', SAND_DARK = '#a8845a', CANVAS = '#e2d6b8', ROPE = '#b09868';
const CRYSTAL = '#7fe4ff', EMBER = '#ff9a3a';

/** 两点之间的一根梁（方木 / 铁杆）。 */
function beam(p0, p1, th, color, mat = 'wood') {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1), d = b.clone().sub(a), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const m = new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return { geo: flat(new THREE.BoxGeometry(th, len, th)), matrix: m, color, mat };
}
const part = (geo, matrix, color, mat) => ({ geo, matrix, color, mat });
const barrel = (x, z, s, color = WOOD) => [
  part(lathe([[5, 0], [6.2, 5], [6.2, 9], [5, 14], [0.01, 14]], 9), C(T(x, 0, z), S(s)), color, 'wood'),
  part(lathe([[6.3, 0], [6.5, 0.8], [6.3, 1.6]], 9), C(T(x, 4.2 * s, z), S(s)), IRON, 'iron'),
  part(lathe([[6.3, 0], [6.5, 0.8], [6.3, 1.6]], 9), C(T(x, 9 * s, z), S(s)), IRON, 'iron'),
];
const crate = (x, z, s, rot = 0) => part(stoneBlock(s, s, s, x + z, 0.03), C(T(x, s / 2, z), RY(rot)), shade(WOOD, 0.9 + hash2(x, z, 1) * 0.3), 'wood');
const lift = (p, dy) => ({ ...p, matrix: C(T(0, dy, 0), p.matrix) });
const sack = (x, z, s, rot = 0) => part(stoneBlock(s * 1.3, s * 0.7, s, x * 3 + z, 0.22), C(T(x, s * 0.32, z), RY(rot)), '#b89a6a', 'cloth');

// ============================================================================
// 各据点的场景。局部坐标：+x = 背离地图中心（场景的"背面"），正面朝 −x（朝着据点和路）；y 朝上。
// 返回 { parts, spin?: [{ parts, pivot: [x, y, z], axis: 'x' | 'y', speed }] }
// ============================================================================
function windmill() {
  const parts = [], H = 96;
  parts.push(part(lathe([[30, 0], [27, 26], [23, 70], [21, H]], 10, true), T(0, 0, 0), SANDSTONE, 'stone'));
  parts.push(part(lathe([[31, 0], [32.5, 3], [31, 7]], 10, true), T(0, 0, 0), shade(SANDSTONE, 0.8), 'stone'));
  parts.push(part(lathe([[22, 0], [24.5, 3], [22, 6]], 10, true), T(0, H - 2, 0), WOOD, 'wood'));
  parts.push(part(prism(8, 2, 25, 30), T(0, H + 19, 0), '#8a4a30', 'wood'));                                  // 尖顶
  parts.push(part(stoneBlock(3, 22, 12, 1, 0.02), T(-28.4, 11, 0), WOOD_DARK, 'wood'));                       // 门
  for (const y of [42, 70]) parts.push(part(stoneBlock(2.4, 9, 6, y, 0.02), T(-25 + (y - 42) * 0.11, y, 0), '#2a2420', 'dark'));   // 窗
  parts.push(beam([-21, H + 6, 0], [-33, H + 6, 0], 5, WOOD_DARK));                                           // 风轮轴
  const sails = [];
  for (let i = 0; i < 4; i++) {
    const m = RX(i / 4 * TAU);
    const arm = beam([0, 4, 0], [0, 62, 0], 2.6, WOOD);
    sails.push({ ...arm, matrix: C(m, arm.matrix) });
    sails.push(part(flat(new THREE.BoxGeometry(0.8, 44, 15)), C(m, T(0.6, 38, 8.5)), CANVAS, 'cloth'));
    for (const y of [18, 32, 46, 60]) sails.push(part(flat(new THREE.BoxGeometry(1.4, 1.4, 16)), C(m, T(0, y, 8)), WOOD, 'wood'));
  }
  sails.push(part(prism(8, 4.5, 4.5, 5), RZ(Math.PI / 2), IRON, 'iron'));
  parts.push(...barrel(34, 20, 1), sack(30, -24, 12, 0.4), sack(40, -16, 11, 1.2), sack(34, -19, 10, 2.0), crate(-6, 40, 13, 0.3));
  return { parts, spin: [{ parts: sails, pivot: [-34, H + 6, 0], axis: 'x', speed: 0.55 }] };
}

function drill() {
  const parts = [], Ht = 124, w0 = 24, w1 = 7;
  const leg = (sx, sz) => beam([sx * w0, 0, sz * w0], [sx * w1, Ht, sz * w1], 4.2, WOOD);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) parts.push(leg(sx, sz));
  for (const y of [28, 60, 92]) {                                                                             // 横撑 + 斜撑
    const w = w0 + (w1 - w0) * y / Ht, wn = w0 + (w1 - w0) * Math.min(Ht, y + 32) / Ht;
    const cs = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      const a = cs[i], b = cs[(i + 1) % 4];
      parts.push(beam([a[0] * w, y, a[1] * w], [b[0] * w, y, b[1] * w], 2.6, WOOD_DARK));
      if (y < 92) parts.push(beam([a[0] * w, y, a[1] * w], [b[0] * wn, y + 32, b[1] * wn], 1.8, WOOD_DARK));
    }
  }
  parts.push(part(stoneBlock(20, 8, 20, 3, 0.03), T(0, Ht + 3, 0), RUST, 'iron'));                            // 天车
  parts.push(part(lathe([[20, 0], [22, 3], [22, 7], [17, 7], [16, 0]], 12, true), T(0, 0, 0), shade(SANDSTONE, 0.75), 'stone'));   // 井口的石圈
  // 蒸汽机：锈铁箱 + 飞轮 + 烟囱，一根管子接到井架
  parts.push(part(stoneBlock(28, 20, 18, 5, 0.03), T(44, 10, -8), RUST, 'iron'));
  parts.push(part(prism(14, 11, 11, 3), C(T(44, 14, 3), RX(Math.PI / 2)), RUST_DARK, 'iron'));
  parts.push(part(prism(8, 3.2, 4, 34), T(52, 37, -10), IRON, 'iron'));
  parts.push(part(horn([[30, 16, -8], [20, 26, -4], [8, 40, 0]], 2.2, 2.2, 6, 6), null, RUST_DARK, 'iron'));
  // 挖出来的水晶
  for (const [x, z, s, r] of [[-30, 26, 1, 0.3], [-38, 18, 0.7, 1.4], [-26, 34, 0.55, 2.2]]) parts.push(part(shard(6 * s, 22 * s, 5, x, 0.3), C(T(x, 0, z), RY(r), RZ(0.25)), CRYSTAL, 'glow'));
  parts.push(crate(34, 26, 12, 0.5), ...barrel(-40, -26, 1, RUST));
  const rod = [];
  rod.push(part(prism(8, 2.6, 2.6, Ht - 12), T(0, (Ht - 12) / 2 + 4, 0), IRON, 'iron'));
  rod.push(part(prism(6, 0.4, 7.5, 16), T(0, 9, 0), RUST_DARK, 'iron'));
  for (let i = 0; i < 3; i++) rod.push(part(stoneBlock(13, 2.2, 2.6, i, 0.02), C(RY(i / 3 * Math.PI), T(0, 40 + i * 26, 0)), RUST, 'iron'));   // 钻杆上的卡箍：看得出在转
  return { parts, spin: [{ parts: rod, pivot: [0, 0, 0], axis: 'y', speed: 1.6 }] };
}

function refinery() {
  const parts = [];
  const tank = (x, z, r, h) => {
    parts.push(part(lathe([[r, 0], [r, h], [r * 0.7, h + r * 0.35], [0.01, h + r * 0.45]], 12), T(x, 4, z), RUST, 'iron'));
    for (const y of [0.25, 0.6, 0.92]) parts.push(part(lathe([[r + 0.3, 0], [r + 1.1, 1.2], [r + 0.3, 2.4]], 12), T(x, 4 + h * y, z), RUST_DARK, 'iron'));
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; parts.push(beam([x + Math.cos(a) * r * 0.8, 0, z + Math.sin(a) * r * 0.8], [x + Math.cos(a) * r * 0.8, 6, z + Math.sin(a) * r * 0.8], 3, IRON, 'iron')); }
  };
  tank(18, 26, 17, 44); tank(34, -8, 13, 34);
  // 熔炉：石砌炉体，炉口是亮的；一根高烟囱
  parts.push(part(stoneBlock(34, 30, 28, 7, 0.05), T(-14, 15, -22), shade(SANDSTONE, 0.7), 'stone'));
  parts.push(part(stoneBlock(2, 12, 13, 2, 0.02), T(-31.4, 9, -22), EMBER, 'glow'));
  parts.push(part(stoneBlock(4, 3, 18, 3, 0.03), T(-32, 16.5, -22), IRON, 'iron'));
  parts.push(part(prism(8, 4.6, 7, 92), T(-8, 76, -26), shade(RUST_DARK, 0.9), 'iron'));
  parts.push(part(lathe([[5, 0], [6.2, 1.5], [5, 4]], 8, true), T(-8, 120, -26), IRON, 'iron'));
  // 管线
  parts.push(part(horn([[18, 40, 9], [10, 46, -6], [-4, 40, -18]], 2.4, 2.4, 6, 8), null, RUST_DARK, 'iron'));
  parts.push(part(horn([[34, 30, -21], [20, 24, -26], [3, 22, -26]], 2, 2, 6, 6), null, RUST_DARK, 'iron'));
  parts.push(part(horn([[18, 10, 9], [28, 8, 2], [34, 10, 5]], 2, 2, 6, 5), null, IRON, 'iron'));
  parts.push(...barrel(-34, 20, 1, RUST), ...barrel(-24, 28, 0.9, RUST), ...barrel(-36, 32, 0.85, RUST_DARK), crate(40, 30, 12, 0.2));
  return { parts };
}

function boneyard() {
  const parts = [];
  // 一副巨兽的肋骨：脊椎沿 z，肋骨一对对拱起来，越往尾巴越小
  for (let i = 0; i < 6; i++) {
    const z = -30 + i * 15, k = 1 - i * 0.09;
    parts.push(part(stoneBlock(9 * k, 7 * k, 11, i, 0.14), T(8, 6 * k, z), BONE, 'bone'));
    for (const s of [1, -1]) {
      parts.push(part(horn([[8 + s * 3, 7 * k, z], [8 + s * 26 * k, 24 * k, z + 2], [8 + s * 32 * k, 52 * k, z + 3], [8 + s * 18 * k, 74 * k, z + 4]], 3.6 * k, 1.1 * k, 6, 9), null, shade(BONE, 0.92 + hash2(i, s, 3) * 0.12), 'bone'));
    }
  }
  // 头骨：颅 + 往前收窄的吻 + 下颌，两只弯角，眼窝是黑的，一排牙
  const skull = C(T(6, 0, -66), RY(0.25));
  const ico = (rx, ry, rz, seed) => { const g = new THREE.IcosahedronGeometry(1, 1); const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const k = 0.9 + hash2(Math.round(p.getX(i) * 9) + seed, Math.round(p.getY(i) * 9) * 3 + Math.round(p.getZ(i) * 9) * 7, 5) * 0.2; p.setXYZ(i, p.getX(i) * rx * k, p.getY(i) * ry * k, p.getZ(i) * rz * k); } return flat(g); };
  parts.push(part(ico(15, 12, 16, 1), C(skull, T(0, 13, 0)), BONE, 'bone'));
  parts.push(part(prism(6, 5.5, 11, 26), C(skull, T(0, 9, -24), RX(-Math.PI / 2 + 0.12)), shade(BONE, 0.97), 'bone'));       // 吻
  parts.push(part(prism(5, 3.5, 8, 24), C(skull, T(0, 2.4, -20), RX(-Math.PI / 2 - 0.06)), shade(BONE, 0.88), 'bone'));       // 下颌
  for (const s of [1, -1]) {
    parts.push(part(ico(4.2, 4.6, 4.2, 3), C(skull, T(s * 8.5, 14, -11)), '#241e1a', 'dark'));                                  // 眼窝
    parts.push(part(horn([[s * 11, 19, 4], [s * 28, 28, 8], [s * 38, 46, 2], [s * 33, 62, -8]], 5.2, 0.8, 6, 9), skull, shade(BONE, 0.9), 'bone'));
    for (let i = 0; i < 4; i++) parts.push(part(shard(1.5, 6, 4, i, 0.1), C(skull, T(s * (3.2 + i * 0.5), 5.2, -22 - i * 3.6), RX(Math.PI)), shade(BONE, 1.04), 'bone'));
  }
  // 散落的骨头
  for (let i = 0; i < 9; i++) {
    const a = hash2(i, 1, 7) * TAU, r = 38 + hash2(i, 2, 7) * 26, x = Math.cos(a) * r, z = Math.sin(a) * r - 10, l = 10 + hash2(i, 3, 7) * 12;
    parts.push(part(horn([[x, 1.5, z], [x + l * 0.5, 2.5, z + 2], [x + l, 1.5, z - 1]], 1.6, 1.1, 5, 4), null, shade(BONE, 0.85 + hash2(i, 4, 7) * 0.2), 'bone'));
  }
  return { parts };
}

function quarry() {
  const parts = [];
  // 开采面：一级级切出来的石台
  const tiers = [[52, 16, 40, 22, 8], [40, 16, 34, 26, 24], [26, 18, 26, 30, 41]];
  tiers.forEach(([w, h, d, x, y], i) => parts.push(part(stoneBlock(w, h, d, i + 3, 0.04), T(x, y, 0), shade(SANDSTONE, 1.02 - i * 0.08), 'stone')));
  for (const [x, y, z, s] of [[8, 4, 22, 8], [36, 20, 14, 7], [44, 20, -12, 6]]) parts.push(part(shard(s * 0.5, s * 2.6, 5, x, 0.3), C(T(x, y, z), RZ(-0.3)), CRYSTAL, 'glow'));   // 岩层里露出来的水晶
  // 切好的石料（两块摞着、两块散着）
  parts.push(part(stoneBlock(18, 10, 12, 21, 0.03), C(T(-34, 5, 26), RY(0.2)), '#d8c8a8', 'stone'));
  parts.push(part(stoneBlock(16, 9, 11, 22, 0.03), C(T(-34, 14.5, 26.5), RY(0.5)), shade('#d8c8a8', 0.92), 'stone'));
  parts.push(part(stoneBlock(14, 9, 10, 23, 0.03), C(T(-20, 4.5, 34), RY(1.1)), shade('#d8c8a8', 1.05), 'stone'));
  parts.push(part(stoneBlock(12, 8, 12, 24, 0.03), C(T(-40, 4, 8), RY(0.1)), shade('#d8c8a8', 0.97), 'stone'));
  // 吊杆：A 字架 + 吊臂 + 绳 + 吊着的石块
  parts.push(beam([-8, 0, -30], [0, 74, -22], 3.6, WOOD), beam([10, 0, -34], [0, 74, -22], 3.6, WOOD), beam([-6, 22, -29.6], [8, 22, -32.4], 2.4, WOOD_DARK));
  parts.push(beam([4, 70, -22], [-34, 86, -8], 3, WOOD), beam([0, 74, -22], [26, 52, -30], 1.2, ROPE, 'cloth'));
  parts.push(beam([-34, 85, -8], [-34, 34, -8], 0.9, ROPE, 'cloth'));
  parts.push(part(stoneBlock(14, 10, 12, 9, 0.03), T(-34, 29, -8), '#d8c8a8', 'stone'));
  // 小推车 + 镐
  parts.push(part(stoneBlock(20, 8, 12, 4, 0.03), T(-14, 9, 44), WOOD, 'wood'));
  for (const s of [1, -1]) parts.push(part(prism(10, 5.5, 5.5, 1.8), C(T(-14, 5.5, 44 + s * 7.2), RX(Math.PI / 2)), WOOD_DARK, 'wood'));
  parts.push(beam([4, 0, 40], [10, 18, 36], 1.4, WOOD), part(shard(1.6, 12, 4, 2, 0), C(T(10, 18, 36), RZ(Math.PI / 2), T(0, -6, 0)), IRON, 'iron'));
  return { parts };
}

function tradingPost() {
  const parts = [];
  const tent = (x, z, r, h, color, rot) => {
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + Math.PI / 4 + rot; parts.push(beam([x + Math.cos(a) * r, 0, z + Math.sin(a) * r], [x + Math.cos(a) * r, h, z + Math.sin(a) * r], 2, WOOD)); }
    parts.push(part(prism(4, 1.2, r * 1.5, h * 0.55), C(T(x, h + h * 0.27, z), RY(Math.PI / 4 + rot)), color, 'cloth'));
    parts.push(part(prism(4, r * 1.5, r * 1.52, 2.2), C(T(x, h - 0.6, z), RY(Math.PI / 4 + rot)), shade(color, 0.75), 'cloth'));
  };
  tent(14, -22, 20, 26, '#b24a34', 0.1); tent(18, 28, 16, 22, '#3a6e90', -0.2);
  parts.push(part(stoneBlock(26, 2, 10, 1, 0.02), T(12, 11, -22), WOOD, 'wood'));                             // 柜台
  for (const [x, z] of [[2, -19], [22, -19], [2, -25], [22, -25]]) parts.push(beam([x, 0, z], [x, 10, z], 1.6, WOOD_DARK));
  parts.push(lift(crate(8, -22, 7, 0.2), 12), lift(crate(16, -23, 6, 0.9), 12));                              // 柜台上的货
  parts.push(crate(-22, 14, 14, 0.3), lift(crate(-21, 15, 10, 1.2), 14), crate(-20, 30, 12, 0.8));
  parts.push(...barrel(-26, -8, 1.1), ...barrel(-16, -2, 0.95), sack(20, 26, 12, 0.5), sack(12, 32, 11, 1.4), sack(-6, 40, 12, 2.2));
  // 一盏挂灯
  parts.push(beam([-34, 0, 34], [-34, 40, 34], 2.2, WOOD_DARK), beam([-34, 38, 34], [-24, 38, 34], 1.6, WOOD_DARK));
  parts.push(part(prism(6, 2.6, 3.2, 6), T(-25, 32, 34), EMBER, 'glow'), part(prism(6, 0.5, 3.6, 2.4), T(-25, 36.2, 34), IRON, 'iron'));
  return { parts };
}

function watchtower() {
  const parts = [], Hp = 88, w0 = 18, w1 = 12;
  const cs = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (const [sx, sz] of cs) parts.push(beam([sx * w0, 0, sz * w0], [sx * w1, Hp, sz * w1], 3.8, WOOD));
  for (const y of [22, 52]) {
    const w = w0 + (w1 - w0) * y / Hp, wn = w0 + (w1 - w0) * (y + 30) / Hp;
    for (let i = 0; i < 4; i++) { const a = cs[i], b = cs[(i + 1) % 4]; parts.push(beam([a[0] * w, y, a[1] * w], [b[0] * w, y, b[1] * w], 2.2, WOOD_DARK), beam([a[0] * w, y, a[1] * w], [b[0] * wn, y + 30, b[1] * wn], 1.6, WOOD_DARK)); }
  }
  parts.push(part(stoneBlock(38, 3, 38, 2, 0.02), T(0, Hp + 1.5, 0), WOOD, 'wood'));                          // 平台
  for (let i = 0; i < 4; i++) {
    const a = cs[i], b = cs[(i + 1) % 4], r = 18;
    parts.push(beam([a[0] * r, Hp + 3, a[1] * r], [a[0] * r, Hp + 34, a[1] * r], 2.2, WOOD));
    if (i !== 2) parts.push(beam([a[0] * r, Hp + 13, a[1] * r], [b[0] * r, Hp + 13, b[1] * r], 1.6, WOOD_DARK));   // 栏杆（留一面上梯子）
  }
  parts.push(part(prism(4, 1, 30, 20), C(T(0, Hp + 44, 0), RY(Math.PI / 4)), '#7a4630', 'wood'));              // 棚顶
  // 梯子
  parts.push(beam([-20, 0, -5], [-14, Hp, -5], 1.4, WOOD_DARK), beam([-20, 0, 5], [-14, Hp, 5], 1.4, WOOD_DARK));
  for (let y = 8; y < Hp; y += 9) parts.push(beam([-20 + 6 * y / Hp, y, -5], [-20 + 6 * y / Hp, y, 5], 1, WOOD));
  // 旗杆 + 一面旧旗，平台上一盆火
  parts.push(beam([0, Hp + 54, 0], [0, Hp + 86, 0], 1.6, WOOD_DARK));
  parts.push(part(banner(18, 13, 0.08, 0.5, 4), C(T(0, Hp + 84, 0), RY(Math.PI / 2), T(9, 0, 0)), '#c8b48a', 'cloth'));
  parts.push(part(lathe([[3, 0], [5.5, 4], [5, 6], [3.6, 6]], 8, true), T(9, Hp + 3, 9), IRON, 'iron'), part(shard(3.4, 9, 5, 4, 0.2), T(9, Hp + 8, 9), EMBER, 'glow'));
  parts.push(crate(26, 18, 12, 0.4), ...barrel(28, -16, 1), sack(-30, 24, 12, 0.8));
  return { parts };
}

/** 据点 id → 场景。id 是地图里的节点 id（商栈 / 望塔沿用了历史 id blue_base / red_base）。 */
export const SCENES = { windmill, drill, refinery, boneyard, quarry, blue_base: tradingPost, red_base: watchtower };   // 键与 data/dominionSites.js 的 SCENE_IDS 一致

/** 砂岩巨岩的站位（纯数据）：不可走的沙地里和地图外面，成簇、彼此不挨着。返回 [{ x, y, h, r, tall, rot, v }] */
export function placeMonoliths(field, D = cfg()) {
  const M = D.monoliths || {}, out = [];
  if (M.enabled === false) return out;
  const step = M.step ?? 170, reach = M.outerReach ?? 900, hQ = field.terrainHeightAt || field.heightAt;
  for (let gy = Math.floor(-reach / step); gy * step < field.H + reach; gy++) for (let gx = Math.floor(-reach / step); gx * step < field.W + reach; gx++) {
    const x = (gx + 0.2 + hash2(gx, gy, 71) * 0.6) * step, y = (gy + 0.2 + hash2(gx, gy, 72) * 0.6) * step;
    if (hash2(gx, gy, 73) > (M.density ?? 0.42)) continue;
    const r = (M.radius?.[0] ?? 45) + hash2(gx, gy, 74) * ((M.radius?.[1] ?? 110) - (M.radius?.[0] ?? 45));
    if (field.sdAt(x, y) < r + (M.walkClear ?? 40)) continue;                     // 整块都在不可走区里，离路有一段距离
    out.push({ x, y, h: hQ(x, y), r, tall: r * ((M.tall?.[0] ?? 1.1) + hash2(gx, gy, 75) * ((M.tall?.[1] ?? 2.4) - (M.tall?.[0] ?? 1.1))), rot: hash2(gx, gy, 76) * TAU, v: hash2(gx, gy, 77) });
  }
  // 超过上限时按各自的随机值挑，不是按扫描顺序截断（那样会全挤在地图的一头）
  const max = M.max ?? 60;
  return out.length > max ? out.sort((a, b) => a.v - b.v).slice(0, max) : out;
}

/**
 * 一座方山：近乎直立的岩壁、一层层进出的岩层、平顶，脚下一圈塌下来的碎石坡。底面 y = 0，半径 / 高都是 1。
 * 剖面 PROFILE = [高度, 半径]：坡脚宽、往上很快收成直壁，到顶略收。
 */
const MESA_PROFILE = [[0, 1.0], [0.1, 0.8], [0.2, 0.7], [0.4, 0.68], [0.6, 0.66], [0.8, 0.64], [0.93, 0.62], [1.0, 0.56]];
function mesaGeometry(seed) {
  const SEG = 13, rows = MESA_PROFILE.length, pos = [], idx = [];
  for (let j = 0; j < rows; j++) {
    const [y, r0] = MESA_PROFILE[j];
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG * TAU;
      // 平面轮廓不是圆：低频的凹凸决定这座山的"形"（各层共用），每层再各自进出一点（岩层）
      const plan = 0.8 + fbm(Math.cos(a) * 1.1 + seed, Math.sin(a) * 1.1 + seed * 0.7, 2, 81) * 0.5;
      const layer = (j % 2 ? 0.05 : -0.03) + (fbm(Math.cos(a) * 3 + j * 1.7 + seed, Math.sin(a) * 3, 2, 83) - 0.5) * 0.1;
      const r = r0 * plan * (1 + (j > 0 && j < rows - 1 ? layer : 0));
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  const top = pos.length / 3; pos.push(0, 1.02, 0);
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < SEG; i++) {
    const a = j * SEG + i, b = j * SEG + (i + 1) % SEG, c = a + SEG, d = b + SEG;
    idx.push(a, c, b, b, c, d);
  }
  for (let i = 0; i < SEG; i++) idx.push((rows - 1) * SEG + i, top, (rows - 1) * SEG + (i + 1) % SEG);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return flat(g);
}

/** 一面旗：旗杆是共用的受光网格，旗面单独一个网格（颜色要跟着归属变）。 */
function flagPole(h) { return [beam([0, 0, 0], [0, h, 0], 2.2, WOOD_DARK), part(prism(6, 0.4, 2, 5), T(0, h + 2.5, 0), '#c8a04a', 'gold'), part(lathe([[3.4, 0], [4, 2], [3, 4]], 7, true), T(0, 0, 0), shade(SANDSTONE, 0.7), 'stone')]; }

/**
 * @param field 高度场  @param theme 主题  @param rockTex 岩石贴图 { map, normalMap }
 */
export function buildWorldDominion(field, theme, rockTex) {
  const map = field.map;
  if (!Array.isArray(map.dominionNodes) || !map.dominionNodes.length) return null;
  const D = cfg();
  const group = new THREE.Group(); group.name = 'worldDominion';
  const disp = [], spinners = [], flags = [];
  const mat = makeUnitMaterial(); disp.push(mat);
  const sites = dominionSites(map), k = D.propScale ?? 1;
  const place = (parts, x, y, rotY, sc = k) => {
    const geo = mergeParts(parts);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, field.heightAt(x, y), y); m.rotation.y = rotY; m.scale.setScalar(sc);
    m.castShadow = true; m.receiveShadow = true; m.updateMatrix(); m.matrixAutoUpdate = false;
    group.add(m); disp.push(geo);
    return m;
  };
  const flagMat = (hex) => patchWorldMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.95, side: THREE.DoubleSide }), { lightDir: false });
  const flagGeo = banner(D.flagSize?.[0] ?? 30, D.flagSize?.[1] ?? 22, 0.08, 0.45, 5); disp.push(flagGeo);
  const poleH = D.flagPole ?? 78;
  const flag = (x, y, hex) => {
    place(flagPole(poleH), x, y, 0, 1);
    const fm = flagMat(hex), b = new THREE.Mesh(flagGeo, fm);
    b.position.set(x + (D.flagSize?.[0] ?? 30) / 2 + 1, field.heightAt(x, y) + poleH - 2, y);
    b.castShadow = true; b.updateMatrix(); b.matrixAutoUpdate = false;
    group.add(b); disp.push(fm);
    return b;
  };

  // ---------- 据点：场景物 + 归属旗 ----------
  for (const s of sites.points) {
    if (s.scene) {
      const sc = SCENES[s.scene](), rot = Math.atan2(-s.ay, s.ax);
      place(sc.parts, s.px, s.py, rot);
      for (const sp of (sc.spin || [])) {
        // 会转的部分：几何以转轴为原点，挂在一个按场景朝向摆好的支点上
        const holder = new THREE.Group();
        holder.position.set(s.px, field.heightAt(s.px, s.py), s.py); holder.rotation.y = rot; holder.scale.setScalar(k);
        const geo = mergeParts(sp.parts), m = new THREE.Mesh(geo, mat);
        m.position.set(...sp.pivot); m.castShadow = true;
        holder.add(m); group.add(holder); disp.push(geo);
        spinners.push({ mesh: m, axis: sp.axis, speed: sp.speed });
      }
    }
    flags.push({ banner: flag(s.fx, s.fy, RESOURCE_COLORS.capture_neutral), x: s.x, y: s.y, owner: undefined });
  }
  // ---------- 水晶枢纽两侧的战旗（本阵营色，不变）----------
  for (const n of sites.nexus) for (const [x, y] of n.flags) flag(x, y, n.faction === 'red' ? RESOURCE_COLORS.capture_red : RESOURCE_COLORS.capture_blue);

  // ---------- 砂岩巨岩 ----------
  const mono = placeMonoliths(field, D);
  if (mono.length && rockTex) {
    const rm = patchWorldMaterial(new THREE.MeshStandardMaterial({ map: rockTex.map, normalMap: rockTex.normalMap, roughness: 0.95, color: new THREE.Color(D.monoliths?.tint ?? '#e0c8a8') }));
    // 贴图按世界尺寸铺：巨岩的 UV 是圆柱展开的，按实例缩放后会拉伸，这里用物体坐标的三向投影
    rm.onBeforeCompile = ((prev) => (sh, r) => {
      prev?.(sh, r);
      sh.vertexShader = 'varying vec3 vMP; varying vec3 vMN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vMP = (instanceMatrix * vec4(position, 1.0)).xyz; vMN = normalize(mat3(instanceMatrix) * normal);
#else
  vMP = position; vMN = normal;
#endif`);
      sh.fragmentShader = `varying vec3 vMP; varying vec3 vMN;
vec4 mtri(sampler2D t, vec3 p, vec3 n) { vec3 w = abs(n); w = w * w * w; w /= (w.x + w.y + w.z); return texture2D(t, p.zy * 0.011) * w.x + texture2D(t, p.xz * 0.011) * w.y + texture2D(t, p.xy * 0.011) * w.z; }
` + sh.fragmentShader
        .replace('#include <map_fragment>', 'vec4 mk = mtri(map, vMP, normalize(vMN)); diffuseColor.rgb *= mk.rgb;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * mk.a;')
        .replace('#include <normal_fragment_maps>', '');
    })(rm.onBeforeCompile);
    rm.customProgramCacheKey = ((prev) => () => (prev ? prev() : '') + '|mesa')(rm.customProgramCacheKey);
    const geos = [mesaGeometry(1), mesaGeometry(7)];
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler();
    geos.forEach((g, gi) => {
      const mine = mono.filter((o) => ((o.v * geos.length) | 0) === gi);
      if (!mine.length) return;
      const inst = new THREE.InstancedMesh(g, rm, mine.length);
      mine.forEach((o, i) => { E.set(0, o.rot, 0); Q.setFromEuler(E); SC.set(o.r, o.tall, o.r * (0.8 + o.v * 0.4)); V.set(o.x, o.h - o.tall * 0.06, o.y); inst.setMatrixAt(i, M4.compose(V, Q, SC)); });
      inst.castShadow = true; inst.receiveShadow = true; inst.matrixAutoUpdate = false; inst.computeBoundingSphere(); inst.name = 'monoliths';
      group.add(inst);
    });
    disp.push(rm, ...geos);
  }

  const cBlue = new THREE.Color(RESOURCE_COLORS.capture_blue), cRed = new THREE.Color(RESOURCE_COLORS.capture_red), cNone = new THREE.Color(RESOURCE_COLORS.capture_neutral);
  return {
    group, sites, counts: { scenes: sites.points.filter((s) => s.scene).length, flags: flags.length, nexusFlags: sites.nexus.length * 2, monoliths: mono.length, spinners: spinners.length },
    flags,
    update(ctx) {
      const t = ctx.time || 0;
      for (const s of spinners) s.mesh.rotation[s.axis] = t * s.speed;
      // 归属旗跟着占领状态变色。实体与据点按坐标对（据点实体的 pos 就是节点的 pos）；不缓存实体引用，免得实体被换掉后读到旧的
      const towers = ctx.deps?.entities?.getAllTowers?.(false);
      if (!towers) return;
      for (const f of flags) {
        const e = towers.find((q) => q.isCapturePoint && q.pos && q.pos.x === f.x && q.pos.y === f.y);
        const owner = e ? (e._captureOwner || null) : null;
        if (owner === f.owner) continue;
        f.owner = owner;
        f.banner.material.color.copy(owner === 'blue' ? cBlue : owner === 'red' ? cRed : cNone);
      }
    },
    dispose() { for (const d of disp) d.dispose(); },
  };
}
