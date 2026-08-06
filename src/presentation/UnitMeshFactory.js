/**
 * UnitMeshFactory.js —— 单位的程序化三维几何（2.5D 迁移第 6.3 步）
 *
 * 零美术素材：全部由基本几何体拼装。造型取向按用户拍板 = "写实"——
 * 塔有基座/塔身/雉堞冠，小兵有身体和头，而不是抽象色块。
 *
 * ===== 三条设计约束 =====
 * ① 一个单位 = 一个 Mesh、一次 draw call。多部件用【手工合并 + 顶点色】实现，
 *    而不是 Group 套多个 Mesh（后者 30 座塔就是 150+ draw call）。
 *    合并需要 BufferGeometryUtils，那在 three 的 examples/jsm 里、本项目只 vendor 了核心，
 *    故此处自带一个 30 行的 mergeParts——只处理 position/normal/color，够用且无依赖。
 * ② 几何按 key 全局共享。同阵营同层级的塔共用同一份几何与材质，与第 3 步贴图
 *    按 key 共享是同一套缓存策略，单位数量不影响显存。
 * ③ 原点在【底面中心】。UnitLayer 把单位摆在 (pos.x, 0, pos.y)，原点在底才能贴地站稳；
 *    另外 topY 一并返回，血条/盾牌要浮在单位顶上而不是插在腰里。
 *
 * 武器几何标记已移除（用户拍板）：塔身不再冒标记；接入 GLB 塔模型后，炮口由挂点
 * 骨骼（Buffbone_Glb_Weapon_1）提供，程序化塔仅作为模型未加载时的回退，炮口取塔冠顶端。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const _geoCache = new Map();
const _matCache = new Map();

// ---------- 合并工具：把 [{geo, matrix, color}] 压成单个带顶点色的 BufferGeometry ----------
function mergeParts(parts) {
  let n = 0;
  const prepped = parts.map(({ geo, matrix, color }) => {
    const g = geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    if (nonIndexed !== g) g.dispose();
    n += nonIndexed.getAttribute('position').count;
    return { g: nonIndexed, c: new THREE.Color(color) };
  });
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, c } of prepped) {
    const p = g.getAttribute('position'), q = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      nrm[(o + i) * 3] = q.getX(i); nrm[(o + i) * 3 + 1] = q.getY(i); nrm[(o + i) * 3 + 2] = q.getZ(i);
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
    }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingBox();
  return out;
}

// topY 一律从合并后的包围盒读【真值】，不手工累加各部件高度：
// 手推值会随任何一次造型微调悄悄失准，而血条正是靠它定位，一旦偏了就插进模型里。
function pack(parts) {
  const geo = mergeParts(parts);
  // 统一把底面对齐到 y=0。旋转过的部件（盾牌、车轮）很容易探到地面以下——
  // 实测近战兵沉 8.1、炮车沉 14.0、投石机沉 12.5，视觉上就是半截埋进土里。
  // 与其在每个造型里手工配平，不如在这里对所有模型强制该不变量，新造型天然免疫。
  const dy = -geo.boundingBox.min.y;
  if (Math.abs(dy) > 1e-6) {
    geo.translate(0, dy, 0);
    geo.computeBoundingBox();
  }
  return { geo, topY: geo.boundingBox.max.y };
}

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
/**
 * 褪色：把颜色往灰里拉再压暗。v44 用于**废墟**。
 * 用户："召唤水晶/水晶枢纽被摧毁的模型，上面的水晶碎片没有更改材质，看起来不好看。"
 * 说的就是这个 —— 活体水晶走的是 crystalMaterial（自发光、玻璃质感），
 * 而废墟碎片只是把同一个队伍色 shade(color, 0.92) 一下，材质还是普通 Lambert：
 * 于是它既没有活体那种通透感、颜色又几乎一样亮，看起来像"掉在地上的塑料块"。
 * 死掉的东西应该**失去饱和度**，而不只是暗一点。
 * @param {number} k 亮度系数    @param {number} g 灰度混合比例（1 = 全灰）
 */
const desat = (hex, k = 0.55, g = 0.6) => {
  const c = new THREE.Color(hex);
  const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  c.lerp(new THREE.Color(lum, lum, lum), g).multiplyScalar(k);
  return '#' + c.getHexString();
};
// 中性石色：塔身/底座用它，融入土色地形（用户 Q2）。队伍色只落在顶部/本体的小水晶上。
const STONE = '#948b7c';

/**
 * 防御塔：基座 → 塔身 → 雉堞冠 → 武器标记。
 * 水晶（isNexus）走宝石造型，分路水晶走球体，与 2D 的 💎/🔮 语义对应。
 * 返回 { geo, mat, topY }；topY = 世界单位高度，血条据此上浮。
 */
/**
 * ==================== 防御塔 / 水晶（v44 全面重造）====================
 * 用户："现有的所有模型都优化或者是重做（我更倾向于重做，因为目前的确实很烂）。
 *        最好是红/蓝方的外/内/水晶/枢纽塔的模型都不同。蓝方有蓝方的特色，
 *        红方有红方的特色，然后塔等级越高长得越牛逼。"
 *
 * ==================== 原实现错在哪 ====================
 * 不是"造型丑"这么简单 —— 是**四个档次共用同一个几何**：
 * 旧 towerMesh 只认 kind（tower / gem / orb），完全不知道 tier 是什么，
 * 外塔和枢纽塔的差别只有 bSize 一个缩放系数。GLB 那条路同样：
 * `_mapTier → tower.glb`，四档一个文件。所以"高地塔看起来更厉害"这件事
 * 在这个项目里**从来没有存在过**。
 *
 * ==================== 现在怎么做 ====================
 * 造型由 (tier, faction) 共同决定，两个维度各管一件事：
 *
 *   tier 管【规模】：层数、扶壁数、悬浮水晶数、总高度，全部随档次单调递增。
 *     外塔   1 层 · 0 扶壁 · 0 悬浮晶      —— 最朴素的哨塔
 *     内塔   2 层 · 2 扶壁 · 0 悬浮晶      —— 收分塔身 + 侧翼
 *     水晶塔 3 层 · 4 扶壁 · 1 悬浮晶      —— 开始有"要塞"的样子
 *     枢纽塔 3 层 · 4 扶壁 · 3 悬浮晶 + 底座光环 —— 最高、最繁复
 *
 *   faction 管【语言】：
 *     🔵 蓝方（秩序）—— 左右对称、垂直收分、尖顶收束、棱柱冠、冷色石
 *     🔴 红方（混乱）—— 冠顶偏斜、多一圈骨刺、构件参差、暖色暗铁
 *   两边的部件数量与高度**保持一致**，只换形状与角度 —— 否则就成了强弱不对称。
 *
 * 参数化的好处在这里很直接：想让某一档更气派，改的是 TIER_SPEC 里的一行数字，
 * 不是再画一个模型。
 */

// 每档的规模。数字是"相对 R（建筑显示半径）"的比例，改这里就能整体调气派程度。
const TIER_SPEC = {
  outer:      { tiers: 1, buttress: 0, orbs: 0, shaft: 1.35, crown: 0.30, halo: false },
  inner:      { tiers: 2, buttress: 2, orbs: 0, shaft: 1.70, crown: 0.34, halo: false },
  base:       { tiers: 3, buttress: 4, orbs: 1, shaft: 2.05, crown: 0.38, halo: false },
  hq_tower:   { tiers: 3, buttress: 4, orbs: 3, shaft: 2.45, crown: 0.44, halo: true },
};
const TIER_FALLBACK = TIER_SPEC.outer;

// 阵营语言。两边**部件数量一致**，只换形状/角度/配色 —— 不对称的是观感，不是强弱。
const FACTION_STYLE = {
  blue:    { stone: '#8e9aa8', trim: '#cfe3ff', lean: 0,     spikes: 0, crownSides: 6, pointy: true },
  red:     { stone: '#9a8478', trim: '#ffd0c0', lean: 0.10,  spikes: 8, crownSides: 5, pointy: false },
  neutral: { stone: STONE,     trim: '#d8dee8', lean: 0,     spikes: 0, crownSides: 8, pointy: true },
};
const facStyle = (f) => FACTION_STYLE[f] || FACTION_STYLE.neutral;

export function towerMesh(key, color, bSize, weaponId, kind, ghost, ruin, tier, faction) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const R = bSize, parts = [];
    let crystalGeo = null, crystalCy = 0, crystalR = 0;   // Q6：水晶单独成件，不并入石身
    let crystalMuzzleK = 0;   // v43 Q8：炮口相对水晶中心上移的比例（× crystalR），0 = 正中心
    const F = facStyle(faction);
    const add = (geo, m, c) => parts.push({ geo, matrix: m, color: c });

    if (ruin) {
      // ==================== 废墟（v44 重做）====================
      // 用户："塔被摧毁的模型也优化一下。然后召唤水晶/水晶枢纽被摧毁的模型，
      //        上面的水晶碎片没有更改材质，看起来不好看。"
      //
      // 两处一起改：
      //   ① 碎片改用 desat()：往灰里拉再压暗。旧写法是 shade(color, 0.92)——
      //      只暗了 8%，饱和度一点没掉，配上普通 Lambert 就像"掉了一地的塑料"。
      //   ② 造型从"断桩 + 几块石头"改成有**破坏方向**的废墟：主体沿一个固定方向
      //      塌下去，断口是斜切的，碎石顺着倒塌方向散开。原来的版本上下对称、
      //      石块随手撒在四周，读起来像"一堆材料"而不是"倒下来的建筑"。
      // 角度全用固定值，保证同 key 几何稳定可缓存（不引入随机）。
      const LEAN = 0.42;                 // 倒塌方向（固定，缓存友好）
      const dead = desat(F.stone, 0.62, 0.45);
      const char = desat(F.stone, 0.34, 0.7);   // 焦黑断口
      if (kind === 'gem' || kind === 'orb') {
        // 水晶废墟：破损祭坛 + 折断的护柱 + 失去光泽的晶体碎片
        const pedH = R * 0.34;
        add(new THREE.CylinderGeometry(R * 0.66, R * 0.96, pedH, 7), T(0, pedH / 2, 0), dead);
        // 折断的护柱：一根还立着（斜的）、一根横躺、一根只剩根部
        add(new THREE.CylinderGeometry(R * 0.08, R * 0.13, R * 0.62, 5),
            compose(T(-R * 0.62, pedH + R * 0.28, R * 0.18), R_Z(0.30)), dead);
        add(new THREE.CylinderGeometry(R * 0.07, R * 0.12, R * 0.72, 5),
            compose(T(R * 0.52, R * 0.12, -R * 0.42), R_Z(Math.PI / 2 - 0.16), R_Y(0.6)), dead);
        add(new THREE.CylinderGeometry(R * 0.11, R * 0.14, R * 0.20, 5), T(R * 0.12, pedH + R * 0.10, R * 0.66), char);
        // 晶体碎片：**褪色**的八面体，大小递减、贴地散开（不再是一圈亮闪闪的队伍色）
        const shards = [[-0.46, 0.30, 0.30, 0.5], [0.44, 0.24, -0.34, -0.7],
                        [0.08, 0.34, 0.55, 1.0], [-0.30, 0.22, -0.5, 0.3], [0.20, 0.20, 0.03, 1.4]];
        for (const [sx, sr, sz, rot] of shards) {
          add(new THREE.OctahedronGeometry(R * sr),
              compose(T(sx * R, R * sr * 0.92, sz * R), R_Z(rot), R_X(rot * 0.5)),
              desat(color, 0.50, 0.55));
        }
        // 一块还嵌在祭坛上的大碎晶（暗示"这里原本有东西"）
        add(new THREE.OctahedronGeometry(R * 0.30),
            compose(T(0, pedH + R * 0.16, 0), R_Z(0.9), R_X(0.4)), desat(color, 0.42, 0.6));
      } else {
        // 塔废墟：斜切断口 + 朝一个方向倒下的塔身残段 + 顺着倒塌方向散落的碎石
        const stumpH = R * 0.62;
        add(new THREE.CylinderGeometry(R * 0.66, R * 0.96, stumpH, F.crownSides + 4), T(0, stumpH / 2, 0), dead);
        // 斜切断口：一块倾斜的薄盘盖在断桩上，读作"从这里断的"
        add(new THREE.CylinderGeometry(R * 0.68, R * 0.68, R * 0.08, F.crownSides + 4),
            compose(T(0, stumpH, 0), R_Z(LEAN * 0.5)), char);
        // 倒下的塔身残段（沿 LEAN 方向躺着，一头搭在断桩上）
        add(new THREE.CylinderGeometry(R * 0.26, R * 0.44, R * 1.15, F.crownSides + 2),
            compose(T(R * 0.72, R * 0.30, R * 0.16), R_Z(Math.PI / 2 - 0.22), R_Y(0.18)), dead);
        // 断段末端的冠（碎的一半），说明"那截是塔顶"
        add(new THREE.CylinderGeometry(R * 0.34, R * 0.28, R * 0.22, F.crownSides),
            compose(T(R * 1.28, R * 0.26, R * 0.22), R_Z(Math.PI / 2 - 0.22)), char);
        // 碎石：顺着倒塌方向铺开，越远越小（不再是围一圈）
        const chunks = [[0.42, 0.18, 0.10, 0.6, 0.34], [0.95, 0.15, -0.30, -0.8, 0.28],
                        [1.45, 0.13, 0.42, 0.3, 0.24], [1.70, 0.10, -0.10, 1.1, 0.18],
                        [-0.55, 0.14, 0.48, 0.9, 0.26]];
        for (const [cx, cy, cz, rot, sz] of chunks) {
          add(new THREE.BoxGeometry(R * sz, R * sz * 0.9, R * sz * 0.85),
              compose(T(cx * R, cy * R, cz * R), R_Z(rot), R_X(rot * 0.35)), dead);
        }
        // 焦痕：贴地的一层暗色扁盘
        add(new THREE.CylinderGeometry(R * 1.05, R * 1.15, R * 0.04, F.crownSides + 6),
            T(R * 0.35, R * 0.02, R * 0.05), char);
      }
    } else if (kind === 'gem' || kind === 'orb') {
      // ---- 两类水晶：祭坛底座 + 护柱 + 悬浮宝石 ----
      // 水晶枢纽（gem）比召唤水晶（orb）多一圈环绕碎晶与更高的祭坛 —— 同样是"越核心越繁复"。
      const isNexus = kind === 'gem';
      const pedH = R * (isNexus ? 0.52 : 0.40);
      add(new THREE.CylinderGeometry(R * 0.72, R * 0.98, pedH, F.crownSides + 2), T(0, pedH / 2, 0), shade(F.stone, 0.52));
      // 护柱：orb 三根、gem 四根，围住宝石。红方的柱子外倾（混乱），蓝方笔直（秩序）。
      const nCol = isNexus ? 4 : 3, colH = R * (isNexus ? 1.05 : 0.85);
      for (let i = 0; i < nCol; i++) {
        const a = (i / nCol) * Math.PI * 2 + (isNexus ? Math.PI / 4 : 0);
        add(new THREE.CylinderGeometry(R * 0.09, R * 0.13, colH, 5),
            compose(T(Math.cos(a) * R * 0.72, pedH + colH / 2, Math.sin(a) * R * 0.72), R_Z(F.lean * Math.cos(a)), R_X(-F.lean * Math.sin(a))),
            shade(F.stone, 0.74));
      }
      // 环绕碎晶（仅枢纽）：读作"力量的核心"
      if (isNexus) {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          add(new THREE.OctahedronGeometry(R * 0.16),
              compose(T(Math.cos(a) * R * 0.95, pedH + colH * 0.75, Math.sin(a) * R * 0.95), R_Z(a)), shade(color, 1.1));
        }
      }
      crystalR = R * (isNexus ? 0.82 : 0.70);
      crystalCy = pedH + colH * 0.55 + crystalR * 0.75;
      crystalGeo = isNexus ? new THREE.OctahedronGeometry(crystalR)
                           : new THREE.IcosahedronGeometry(crystalR, 0);
      crystalMuzzleK = (CONFIG.ui?.muzzle?.nexusTopK) ?? 0.9;
    } else {
      // ---- 防御塔：层数/扶壁/悬浮晶随 tier 递增 ----
      const SP = TIER_SPEC[tier] || TIER_FALLBACK;
      const baseH = R * 0.42;
      add(new THREE.CylinderGeometry(R * 0.92, R * 1.06, baseH, F.crownSides + 4), T(0, baseH / 2, 0), shade(F.stone, 0.48));
      // 台阶式基座（档次越高台阶越多，从下往上收）
      let y = baseH;
      for (let i = 1; i < SP.tiers; i++) {
        const h = R * 0.22, rr = 0.92 - i * 0.10;
        add(new THREE.CylinderGeometry(R * (rr - 0.04), R * rr, h, F.crownSides + 4), T(0, y + h / 2, 0), shade(F.stone, 0.56));
        y += h;
      }
      // 塔身：分成 tiers 段，每段更细 —— 收分是"高塔"读感的来源
      const segH = R * SP.shaft / SP.tiers;
      for (let i = 0; i < SP.tiers; i++) {
        const rb = R * (0.62 - i * 0.07), rt = R * (0.62 - (i + 1) * 0.07);
        add(new THREE.CylinderGeometry(rt, rb, segH, F.crownSides + 4), T(0, y + segH / 2, 0), shade(F.stone, 0.80 + i * 0.04));
        // 段与段之间一道箍
        if (i < SP.tiers - 1) {
          add(new THREE.CylinderGeometry(R * (rb / R + 0.05), R * (rb / R + 0.05), R * 0.07, F.crownSides + 4),
              T(0, y + segH, 0), shade(F.stone, 0.62));
        }
        y += segH;
      }
      // 扶壁：贴着塔身的斜撑，档次越高越多
      for (let i = 0; i < SP.buttress; i++) {
        const a = (i / Math.max(1, SP.buttress)) * Math.PI * 2 + Math.PI / 4;
        const bh = R * SP.shaft * 0.55;
        add(new THREE.BoxGeometry(R * 0.16, bh, R * 0.30),
            compose(T(Math.cos(a) * R * 0.66, baseH + bh / 2, Math.sin(a) * R * 0.66), R_Z(Math.cos(a) * 0.12), R_X(-Math.sin(a) * 0.12)),
            shade(F.stone, 0.66));
      }
      // 冠：蓝方尖顶收束、红方偏斜且带骨刺
      const crownH = R * SP.crown;
      add(new THREE.CylinderGeometry(R * 0.80, R * 0.70, crownH, F.crownSides),
          compose(T(0, y + crownH / 2, 0), R_Z(F.lean)), shade(F.stone, 0.70));
      y += crownH;
      // 雉堞：一圈小方块，是"塔楼"读感的关键。档次越高越密。
      const mN = 6 + SP.tiers * 2, mS = R * 0.19, rr = R * 0.68;
      for (let i = 0; i < mN; i++) {
        const a = (i / mN) * Math.PI * 2;
        add(new THREE.BoxGeometry(mS, mS * (F.pointy ? 1.5 : 1.2), mS),
            T(Math.cos(a) * rr, y + mS * 0.65, Math.sin(a) * rr), shade(F.stone, 0.60));
      }
      // 红方专属：冠上一圈骨刺（蓝方 spikes=0，这个循环不跑）
      for (let i = 0; i < F.spikes; i++) {
        const a = (i / Math.max(1, F.spikes)) * Math.PI * 2 + 0.3;
        add(new THREE.ConeGeometry(R * 0.07, R * 0.34, 4),
            compose(T(Math.cos(a) * R * 0.52, y + R * 0.30, Math.sin(a) * R * 0.52), R_Z(Math.cos(a) * 0.5), R_X(-Math.sin(a) * 0.5)),
            shade(F.trim, 0.8));
      }
      y += mS * 1.3;
      // 蓝方专属：尖顶（红方 pointy=false，改成一个偏斜的短柱）
      if (F.pointy) {
        add(new THREE.ConeGeometry(R * 0.42, R * 0.55, F.crownSides), T(0, y + R * 0.27, 0), shade(F.trim, 0.75));
        y += R * 0.55;
      } else {
        add(new THREE.CylinderGeometry(R * 0.30, R * 0.44, R * 0.30, F.crownSides),
            compose(T(0, y + R * 0.15, 0), R_Z(F.lean * 2)), shade(F.trim, 0.7));
        y += R * 0.30;
      }
      // 悬浮晶（档次越高越多）：绕塔顶排开，纯装饰，读作"这座塔有分量"
      for (let i = 0; i < SP.orbs; i++) {
        const a = (i / Math.max(1, SP.orbs)) * Math.PI * 2;
        add(new THREE.OctahedronGeometry(R * 0.17),
            compose(T(Math.cos(a) * R * 0.62, y * 0.86, Math.sin(a) * R * 0.62), R_Z(0.6)), shade(color, 1.15));
      }
      // 底座光环（仅枢纽塔）
      if (SP.halo) {
        add(new THREE.TorusGeometry(R * 1.15, R * 0.05, 5, 16),
            compose(T(0, baseH * 0.55, 0), R_X(Math.PI / 2)), shade(color, 1.1));
      }
      // 顶部队伍色小水晶＝武器；单独成件（会转/发光/攻击辉光，见 UnitLayer），炮口=其中心。
      crystalR = R * (0.34 + SP.tiers * 0.035);
      crystalCy = y + crystalR * 0.75;
      crystalGeo = new THREE.OctahedronGeometry(crystalR);
      void weaponId;    // weaponId 不再驱动几何（炮口＝顶部水晶）
    }
    hit = pack(parts);
    // Q6：石身合并进 hit.geo；水晶几何 + 中心高度另存，由 UnitLayer 配独立发光材质、慢转与攻击辉光。
    if (crystalGeo) { hit.crystal = { geo: crystalGeo, cy: crystalCy, r: crystalR }; hit.topY = crystalCy + crystalR; hit.muzzleY = crystalCy + crystalR * crystalMuzzleK; }
    else { hit.crystal = null; hit.muzzleY = hit.topY; }
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(ghost), topY: hit.topY, muzzleY: hit.muzzleY, crystal: hit.crystal };
}

// ===================== 分兵种造型（第 6.3 步补充） =====================
// 约定：模型一律朝【+Z】建，UnitLayer 按移动方向绕 Y 轴旋转。
// 有"头尾"的单位（炮车/投石机/机甲/步兵）才转；图腾这类对称体不转，转了也看不出来。
const R_X = (a) => new THREE.Matrix4().makeRotationX(a);
const R_Z = (a) => new THREE.Matrix4().makeRotationZ(a);
const R_Y = (a) => new THREE.Matrix4().makeRotationY(a);   // v44：图腾/术士的环绕件要绕 Y
// 部件变换：T×R（先在原地绕自身旋转，再平移到目标位）。
// 修正：之前用 premultiply 得到的是 R×T（先平移、再绕【原点】旋转）→ 部件被甩到地下，
// pack() 再把整体抬起补偿 → 模型悬空、盾/弓/炮管错位。改 multiply 后部件落回本位、贴地。
const compose = (m, ...rest) => rest.reduce((acc, x) => acc.multiply(x), m.clone());

/** 通用步兵骨架：身体 + 肩甲 + 头。melee/ranged 在此之上加武器。 */
function infantryParts(color, S, slim) {
  const bodyH = S * (slim ? 1.35 : 1.25), headR = S * (slim ? 0.40 : 0.46);
  const rTop = S * (slim ? 0.34 : 0.42), rBot = S * (slim ? 0.50 : 0.62);
  const parts = [
    { geo: new THREE.CylinderGeometry(rTop, rBot, bodyH, 8), matrix: T(0, bodyH / 2, 0), color },
  ];
  for (const sx of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(S * 0.30, S * 0.26, S * 0.42),
                 matrix: T(sx * S * 0.52, bodyH * 0.86, 0), color: shade(color, 0.7) });
  }
  const headY = bodyH + headR * 0.82;
  parts.push({ geo: new THREE.SphereGeometry(headR, 12, 10), matrix: T(0, headY, 0), color: shade(color, 1.18) });
  return { parts, bodyH, headY, headR };
}

const MINION_BUILDERS = {
  // 近战兵：左手圆盾、右手短刃
  melee(color, S) {
    const { parts, bodyH } = infantryParts(color, S, false);
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.42, S * 0.42, S * 0.10, 10),
                 matrix: compose(T(-S * 0.72, bodyH * 0.62, S * 0.16), R_X(Math.PI / 2)),
                 color: shade(color, 0.55) });   // 圆盾（立起来的扁圆柱）
    parts.push({ geo: new THREE.BoxGeometry(S * 0.11, S * 1.05, S * 0.05),
                 matrix: T(S * 0.66, bodyH * 0.95, S * 0.10), color: '#d8dee8' });  // 短刃
    return parts;
  },
  // 远程兵：瘦削，斜挎长弓
  ranged(color, S) {
    const { parts, bodyH } = infantryParts(color, S, true);
    parts.push({ geo: new THREE.TorusGeometry(S * 0.55, S * 0.055, 6, 12, Math.PI * 1.15),
                 matrix: compose(T(-S * 0.60, bodyH * 0.78, 0), R_Z(-0.35)),
                 color: '#c9a06a' });            // 弓臂（部分圆环 = 弯弓）
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.04, S * 0.04, S * 1.0, 4),
                 matrix: compose(T(S * 0.30, bodyH * 0.95, 0), R_Z(-1.05)),
                 color: '#e8e2d0' });            // 背着的箭
    return parts;
  },
  // 炮兵 = 炮车：车体 + 四轮 + 前伸炮管
  siege(color, S) {
    const bodyH = S * 0.55, parts = [];
    parts.push({ geo: new THREE.BoxGeometry(S * 1.15, bodyH, S * 1.55),
                 matrix: T(0, S * 0.42 + bodyH / 2, 0), color });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      parts.push({ geo: new THREE.CylinderGeometry(S * 0.40, S * 0.40, S * 0.16, 10),
                   matrix: compose(T(sx * S * 0.62, S * 0.40, sz * S * 0.52), R_Z(Math.PI / 2)),
                   color: shade(color, 0.45) });
    }
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.20, S * 0.26, S * 1.35, 10),
                 matrix: compose(T(0, S * 0.42 + bodyH + S * 0.16, S * 0.42), R_X(Math.PI / 2)),
                 color: shade(color, 0.72) });   // 炮管，朝 +Z（前）
    parts.push({ geo: new THREE.SphereGeometry(S * 0.28, 10, 8),
                 matrix: T(0, S * 0.42 + bodyH + S * 0.16, -S * 0.28), color: shade(color, 0.9) });
    return parts;
  },
  // 攻城车 = 投石机：车体 + 四轮 + 斜抛臂 + 抛篮 + 配重
  ram(color, S) {
    const bodyH = S * 0.42, parts = [];
    parts.push({ geo: new THREE.BoxGeometry(S * 1.0, bodyH, S * 1.7),
                 matrix: T(0, S * 0.38 + bodyH / 2, 0), color });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      parts.push({ geo: new THREE.CylinderGeometry(S * 0.36, S * 0.36, S * 0.15, 10),
                   matrix: compose(T(sx * S * 0.55, S * 0.36, sz * S * 0.58), R_Z(Math.PI / 2)),
                   color: shade(color, 0.45) });
    }
    // 支架（人字形）+ 抛臂（向后上方斜举，蓄势待发的姿态最好认）
    const pivY = S * 0.38 + bodyH + S * 0.55;
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(S * 0.10, S * 1.1, S * 0.10),
                   matrix: compose(T(sx * S * 0.34, pivY - S * 0.30, 0), R_Z(sx * 0.16)),
                   color: shade(color, 0.55) });
    }
    parts.push({ geo: new THREE.BoxGeometry(S * 0.13, S * 1.6, S * 0.13),
                 matrix: compose(T(0, pivY + S * 0.30, -S * 0.42), R_X(0.72)),
                 color: '#a9865c' });   // 抛臂
    parts.push({ geo: new THREE.SphereGeometry(S * 0.30, 10, 8),
                 matrix: T(0, pivY + S * 1.02, -S * 0.98), color: shade(color, 0.85) });  // 抛篮
    parts.push({ geo: new THREE.BoxGeometry(S * 0.36, S * 0.36, S * 0.36),
                 matrix: T(0, pivY - S * 0.10, S * 0.56), color: shade(color, 0.4) });    // 配重
    return parts;
  },
  // 超级兵 = 机甲：粗壮躯干 + 大方肩 + 方头 + 天线 + 双腿
  super(color, S) {
    const legH = S * 0.62, torsoH = S * 0.95, parts = [];
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(S * 0.34, legH, S * 0.40),
                   matrix: T(sx * S * 0.30, legH / 2, 0), color: shade(color, 0.5) });
    }
    parts.push({ geo: new THREE.BoxGeometry(S * 1.02, torsoH, S * 0.66),
                 matrix: T(0, legH + torsoH / 2, 0), color });
    parts.push({ geo: new THREE.BoxGeometry(S * 0.72, S * 0.30, S * 0.50),
                 matrix: T(0, legH + torsoH * 0.30, S * 0.28), color: shade(color, 1.2) }); // 胸甲
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(S * 0.42, S * 0.46, S * 0.62),
                   matrix: T(sx * S * 0.66, legH + torsoH * 0.86, 0), color: shade(color, 0.65) });
      parts.push({ geo: new THREE.BoxGeometry(S * 0.24, S * 0.70, S * 0.24),
                   matrix: T(sx * S * 0.70, legH + torsoH * 0.38, 0), color: shade(color, 0.55) });
    }
    const headY = legH + torsoH + S * 0.26;
    parts.push({ geo: new THREE.BoxGeometry(S * 0.46, S * 0.44, S * 0.46),
                 matrix: T(0, headY, 0), color: shade(color, 1.25) });
    parts.push({ geo: new THREE.BoxGeometry(S * 0.30, S * 0.10, S * 0.06),
                 matrix: T(0, headY + S * 0.02, S * 0.24), color: '#ffd98a' });   // 目镜
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.035, S * 0.035, S * 0.55, 4),
                 matrix: T(-S * 0.18, headY + S * 0.48, 0), color: shade(color, 0.6) }); // 天线
    return parts;
  },

  // ==================== v44 补齐：这三种此前**没有任何专属造型** ====================
  // 用户："目前现有的小兵模型也是一团糟，甚至有些兵用的是通用的模板。每个兵应该有自己的模型。"
  // 说的就是它们：MINION_BUILDERS 里原本只有 melee/ranged/siege/ram/super 五项，
  // 图腾兵/术士兵/蚀骨兵三种落到 `infantryParts(...)` 这个**通用步兵模板** ——
  // 场上三种功能完全不同的兵长着同一副身板，只有颜色能区分。
  // （GLB 那条路更少：只有四种有模型，而且默认还是关的。）

  // 图腾兵：无腿，一根悬浮的图腾柱 + 环绕小石 + 顶端符文眼。
  // 它是**辅助单位**，造型上刻意不像"人" —— 一眼能从兵线里挑出来。
  totem(color, S) {
    const parts = [];
    const dark = shade(color, 0.62), lite = shade(color, 1.25);
    const H = S * 1.5;
    for (let i = 0; i < 3; i++) {
      const w = S * (0.62 - i * 0.09), h = H / 3;
      parts.push({ geo: new THREE.BoxGeometry(w, h, w),
                   matrix: compose(T(0, S * 0.34 + h * (i + 0.5), 0), R_Y(i * 0.4)), color });
      parts.push({ geo: new THREE.BoxGeometry(w * 1.22, S * 0.07, w * 1.22),
                   matrix: T(0, S * 0.34 + h * (i + 1), 0), color: dark });
    }
    const topY = S * 0.34 + H;
    parts.push({ geo: new THREE.BoxGeometry(S * 0.50, S * 0.22, S * 0.10),
                 matrix: T(0, topY + S * 0.16, 0), color: dark });
    parts.push({ geo: new THREE.OctahedronGeometry(S * 0.17),
                 matrix: T(0, topY + S * 0.16, 0), color: lite });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      parts.push({ geo: new THREE.TetrahedronGeometry(S * 0.20),
                   matrix: compose(T(Math.cos(a) * S * 0.78, S * 0.95, Math.sin(a) * S * 0.78), R_Y(a), R_Z(0.5)),
                   color: shade(color, 0.85) });
    }
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.55, S * 0.72, S * 0.34, 6),
                 matrix: T(0, S * 0.17, 0), color: dark });
    return parts;
  },

  // 术士兵：兜帽长袍 + 法杖 + 悬浮符文环。没有明显的头肩，剪影是个"锥"。
  warlock(color, S) {
    const parts = [];
    const dark = shade(color, 0.58), lite = shade(color, 1.3);
    const robeH = S * 1.35;
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.34, S * 0.74, robeH, 8),
                 matrix: T(0, robeH / 2, 0), color });
    parts.push({ geo: new THREE.ConeGeometry(S * 0.42, S * 0.62, 8),
                 matrix: T(0, robeH + S * 0.24, 0), color: dark });
    parts.push({ geo: new THREE.SphereGeometry(S * 0.20, 8, 6),
                 matrix: T(0, robeH + S * 0.10, S * 0.16), color: '#1c1f26' });
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.05, S * 0.06, S * 1.75, 5),
                 matrix: compose(T(S * 0.56, robeH * 0.72, 0), R_Z(-0.16)), color: '#8a6b4a' });
    parts.push({ geo: new THREE.OctahedronGeometry(S * 0.22),
                 matrix: T(S * 0.70, robeH * 0.72 + S * 0.92, 0), color: lite });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      parts.push({ geo: new THREE.BoxGeometry(S * 0.16, S * 0.05, S * 0.16),
                   matrix: compose(T(S * 0.70 + Math.cos(a) * S * 0.34, robeH * 0.72 + S * 0.92, Math.sin(a) * S * 0.34), R_Y(a)),
                   color: lite });
    }
    return parts;
  },

  // 蚀骨兵：佝偻的骨架 + 外露肋骨 + 镰爪。它是**减益单位**，造型走"病态"。
  corrupt(color, S) {
    const parts = [];
    const bone = '#d9d3c4', dark = shade(color, 0.5);
    const bodyH = S * 1.05;
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.30, S * 0.40, bodyH, 6),
                 matrix: compose(T(0, bodyH * 0.55, S * 0.06), R_X(0.22)), color });
    for (let i = 0; i < 4; i++) {
      const yy = bodyH * (0.32 + i * 0.17);
      parts.push({ geo: new THREE.BoxGeometry(S * 0.72 - i * S * 0.06, S * 0.055, S * 0.11),
                   matrix: compose(T(0, yy, S * 0.14), R_Z(0.05 * (i % 2 ? 1 : -1))), color: bone });
    }
    const headY = bodyH + S * 0.30;
    parts.push({ geo: new THREE.BoxGeometry(S * 0.34, S * 0.34, S * 0.42),
                 matrix: compose(T(0, headY, S * 0.16), R_X(0.35)), color: bone });
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(S * 0.07, S * 0.07, S * 0.05),
                   matrix: T(sx * S * 0.09, headY + S * 0.03, S * 0.36), color: '#2a1a1a' });
    }
    parts.push({ geo: new THREE.BoxGeometry(S * 0.09, S * 0.62, S * 0.05),
                 matrix: compose(T(S * 0.52, bodyH * 0.72, 0), R_Z(-0.30)), color: bone });
    parts.push({ geo: new THREE.BoxGeometry(S * 0.08, S * 0.44, S * 0.05),
                 matrix: compose(T(S * 0.74, bodyH * 1.06, 0), R_Z(-1.05)), color: bone });
    for (let i = 0; i < 3; i++) {
      parts.push({ geo: new THREE.BoxGeometry(S * 0.05, S * 0.26, S * 0.05),
                   matrix: compose(T(-S * 0.46 - i * S * 0.06, bodyH * 0.46, (i - 1) * S * 0.09), R_Z(0.35 + i * 0.12)),
                   color: bone });
    }
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.CylinderGeometry(S * 0.075, S * 0.10, S * 0.42, 5),
                   matrix: compose(T(sx * S * 0.20, S * 0.21, 0), R_Z(sx * 0.16)), color: dark });
    }
    return parts;
  },
};

// 需要朝向的兵种（有明确头尾）。图腾/护盾/术士/蚀骨等对称造型不转。
// v44：术士与蚀骨也进来 —— 它们的新造型有明确的正面（法杖/镰爪在固定一侧），
// 不转的话走反方向时会看到「背对着挥镰刀」。图腾是轴对称的，仍然不转。
const FACING_TYPES = new Set(['melee', 'ranged', 'siege', 'ram', 'super', 'warlock', 'corrupt']);
export function needsFacing(type) { return FACING_TYPES.has(type); }

/**
 * 小兵：身体（下粗上细的柱体）+ 头（球）+ 肩甲，阵营色。
 * size 沿用 MINION_STYLE 的世界尺寸，视觉高度约 size×2.1——比贴图纸片人略高，
 * 因为立起来之后底面积变小，不加高会显得矮胖。
 */
export function minionMesh(key, color, size, type, faction) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const build = MINION_BUILDERS[type];
    // v44：八个内置兵种现在**每一个都有自己的 builder**（图腾/术士/蚀骨是这一版补的）。
    // 回退到通用步兵模板的只剩「玩家自制兵种」——那是合理的：自制兵种没有造型可言，
    // 它靠颜色与图标区分。内置兵种再落到这条回退上就是漏做了，sim_v44 里有断言盯着。
    void faction;   // 阵营差异目前只体现在颜色（由调用方传入 color），造型两边一致
    hit = pack(build ? build(color, size) : infantryParts(color, size, false).parts);
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(false), topY: hit.topY };
}

/** 巨龙：拉长的身体 + 头 + 双翼，比小兵大一圈，古龙更大 */
/**
 * ==================== 巨龙（v44 重造）====================
 * 用户："龙的模型太丑了，而且不要一会大一会小那种效果。"
 *
 * 旧造型只有 5 件：一个压扁的球（身）、一个锥（头）、两块斜板（翼）、一根柱（腿）。
 * 问题不在件数少，在**比例**：那个球被 scale(1, 0.72, 1.45) 压成一坨，
 * 锥直接怼在球侧面当头（没有脖子），两块板从球心穿出去当翅膀，
 * 一根柱子代表全部四条腿。远看是个带刺的土豆。
 *
 * 现在按"低多边形四足飞龙"重造，形状语言与场景里的树/石一致（都是低面数硬边）：
 *   躯干（前粗后细的两段）→ 颈（向前上方斜）→ 头（楔形）+ 下颚 → 犄角
 *   → 四条腿 + 脚掌 → 双翼（翼骨 + 两片翼膜，向后掠且上扬）→ 分节的尾 + 尾刺
 *   → 背脊骨板（沿脊线由大到小）
 * 远古龙不再是"同一个模型放大"：它多一对犄角、背板更高、翼展更大，
 * 光靠剪影就能和元素龙分开。
 *
 * 朝向约定：模型面朝 -Z（与 needsFacing 的其余单位一致）。
 */
export function dragonMesh(key, color, ancient) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const S = ancient ? 30 : 24;
    const parts = [];
    const dark = shade(color, 0.62);      // 腹部/腿/翼膜
    const lite = shade(color, 1.22);      // 头/犄角/背板/尖端
    const mid  = shade(color, 0.86);
    const add = (geo, m, c) => parts.push({ geo, matrix: m, color: c });
    const M = () => new THREE.Matrix4();
    const rot = (rx, ry, rz) => M().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));

    const bodyY = S * 0.62;               // 躯干中心高度（四条腿把它撑起来）

    // ---- 躯干：前胸粗、后腰细，两段拼出锥度，比单个压扁的球有体积感 ----
    add(new THREE.SphereGeometry(S * 0.40, 10, 7),
        M().makeScale(1.0, 0.92, 1.25).premultiply(T(0, bodyY, -S * 0.18)), color);
    add(new THREE.SphereGeometry(S * 0.31, 10, 7),
        M().makeScale(1.0, 0.88, 1.30).premultiply(T(0, bodyY * 0.96, S * 0.30)), color);
    // 腹部（浅色一条，低多边形生物常用的分色）
    add(new THREE.SphereGeometry(S * 0.26, 8, 6),
        M().makeScale(1.0, 0.42, 1.5).premultiply(T(0, bodyY - S * 0.20, 0)), dark);

    // ---- 颈 + 头：先有脖子再有头，这是旧造型最缺的一段 ----
    add(new THREE.CylinderGeometry(S * 0.13, S * 0.19, S * 0.52, 7),
        rot(-0.62, 0, 0).premultiply(T(0, bodyY + S * 0.30, -S * 0.44)), color);
    // 头：楔形（前窄后宽），比锥体像头
    add(new THREE.BoxGeometry(S * 0.26, S * 0.24, S * 0.42),
        rot(-0.18, 0, 0).premultiply(T(0, bodyY + S * 0.56, -S * 0.76)), lite);
    // 吻部
    add(new THREE.ConeGeometry(S * 0.13, S * 0.26, 6),
        rot(-Math.PI / 2 - 0.18, 0, 0).premultiply(T(0, bodyY + S * 0.52, -S * 1.02)), lite);
    // 下颚
    add(new THREE.BoxGeometry(S * 0.18, S * 0.08, S * 0.30),
        rot(-0.10, 0, 0).premultiply(T(0, bodyY + S * 0.44, -S * 0.86)), dark);
    // 犄角：元素龙一对、远古龙两对（剪影层面的区分）
    const horns = ancient ? [[0.62, 0.30], [0.34, 0.62]] : [[0.52, 0.34]];
    for (const [zk, spread] of horns) {
      for (const sx of [-1, 1]) {
        add(new THREE.ConeGeometry(S * 0.05, S * 0.30, 5),
            rot(-0.5, 0, sx * 0.42).premultiply(
              T(sx * S * spread * 0.30, bodyY + S * 0.74, -S * zk)), lite);
      }
    }

    // ---- 四条腿 + 脚掌 ----
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = sx * S * 0.26, lz = sz * S * 0.34;
      add(new THREE.CylinderGeometry(S * 0.075, S * 0.10, bodyY * 0.62, 6),
          T(lx, bodyY * 0.34, lz), dark);
      add(new THREE.BoxGeometry(S * 0.17, S * 0.07, S * 0.21),
          T(lx, S * 0.035, lz - S * 0.03), dark);
    }

    // ---- 双翼 ----
    // 做法：**先把几何体自己平移到"内缘贴在原点"**，再整体旋转、再挪到肩点。
    // 第一版是把三个矩阵 premultiply 串起来（rot → 局部平移 → base），
    // 结果那个"局部平移"用的是世界轴而不是旋转后的坐标系，翼板被甩到身体外面
    // 变成两根穿身而过的螺旋桨叶。几何体自带偏移之后，旋转天然绕内缘发生，
    // 怎么转都还连在肩上。
    //
    // 姿态：这是一条**落地的**龙，翼不该像飞机一样平展。所以三个角一起给：
    //   dihedral 上反角（翼尖抬高） + sweep 后掠（翼面向后拖） + 翼膜比翼骨更宽，
    // 让剪影是"收在背上的一对翼"而不是两根横棍。
    const span = S * 0.86, chord = S * 0.80;
    const dihedral = 0.95, sweep = 0.62;
    for (const sx of [-1, 1]) {
      const shX = sx * S * 0.22, shY = bodyY + S * 0.30, shZ = -S * 0.06;
      const pose = rot(0, sx * sweep, sx * dihedral);
      // 翼骨（前缘）：底端在原点的柱体，沿 +Y 立起来，由 pose 摆成翼展方向
      const bone = new THREE.CylinderGeometry(S * 0.036, S * 0.055, span, 5);
      bone.translate(0, span / 2, 0);
      add(bone, rot(0, sx * sweep, sx * (dihedral - Math.PI / 2 + 0.30))
                  .premultiply(T(shX, shY, shZ)), mid);
      // 翼膜：内缘在原点、向 +Y（翼展方向）铺开，chord 沿 Z 向后拖
      const mem = new THREE.BoxGeometry(S * 0.022, span * 0.92, chord);
      mem.translate(0, span * 0.46, chord * 0.34);
      add(mem, rot(0, sx * sweep, sx * (dihedral - Math.PI / 2 + 0.30))
                 .premultiply(T(shX, shY, shZ)), dark);
      // 翼指：翼膜后缘的两根细骨，低多边形龙翼的辨识点
      for (const k of [0.45, 0.80]) {
        const rib = new THREE.CylinderGeometry(S * 0.022, S * 0.028, chord * 0.86, 4);
        rib.rotateX(Math.PI / 2);
        rib.translate(0, span * k, chord * 0.40);
        add(rib, rot(0, sx * sweep, sx * (dihedral - Math.PI / 2 + 0.30))
                   .premultiply(T(shX, shY, shZ)), mid);
      }
    }

    // ---- 尾：三节递减 + 尾刺 ----
    const tail = [[0.62, 0.13, 0.34], [0.94, 0.10, 0.30], [1.22, 0.07, 0.26]];
    for (const [tz, tr, tl] of tail) {
      add(new THREE.CylinderGeometry(S * tr * 0.8, S * tr, S * tl, 6),
          rot(Math.PI / 2 - 0.10, 0, 0).premultiply(
            T(0, bodyY - S * (tz - 0.62) * 0.18, S * tz)), color);
    }
    add(new THREE.ConeGeometry(S * 0.09, S * 0.28, 5),
        rot(Math.PI / 2 - 0.10, 0, 0).premultiply(T(0, bodyY - S * 0.13, S * 1.48)), lite);

    // ---- 背脊骨板：沿脊线由大到小，低多边形龙的标志性剪影 ----
    const spine = ancient ? [0.28, 0.24, 0.20, 0.15, 0.11] : [0.20, 0.17, 0.14, 0.10];
    spine.forEach((h, i) => {
      add(new THREE.ConeGeometry(S * 0.055, S * h, 4),
          rot(0.12, Math.PI / 4, 0).premultiply(
            T(0, bodyY + S * 0.36, -S * 0.28 + i * S * 0.26)), lite);
    });

    hit = pack(parts);
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(false), topY: hit.topY };
}

/** 单位材质：顶点色 + 受光。幽灵（等待重生的水晶）走半透明。 */
export function unitMaterial(ghost) {
  const k = ghost ? 'ghost' : 'solid';
  let m = _matCache.get(k);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: !!ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    });
    _matCache.set(k, m);
  }
  return m;
}

// Q6：水晶材质——玻璃/切面质感 + 自发光（队伍色）。每座塔【独立一份】（攻击辉光要逐塔调
// emissiveIntensity），故不缓存、每次 new；调用方负责在替换/移除时 dispose。
export function crystalMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.7,
    roughness: 0.18, metalness: 0.0,
    flatShading: true,                 // 切面高光 → 水晶感
    transparent: true, opacity: 0.88,
  });
}

// Q6：水晶粒子——绕水晶悬浮的一圈发光尘埃（加法混合，类 LoL）。作为水晶 Mesh 的子物体挂上，
// 随水晶慢转而公转。软圆点贴图全局共享（懒建，headless 不触发）；几何/材质逐塔独立、需 dispose。
let _dotTex = null;
function dotTexture() {
  if (_dotTex) return _dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  _dotTex = new THREE.CanvasTexture(c); _dotTex.colorSpace = THREE.SRGBColorSpace;
  return _dotTex;
}
export function crystalParticles(color, r) {
  const N = 16, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {                    // 螺旋分布在水晶周围一层薄壳里（确定性，无随机）
    const a = i * 2.399963;                         // 黄金角 → 均匀铺开
    const rad = r * (0.95 + 0.55 * ((i * 0.618) % 1));
    pos[i * 3] = Math.cos(a) * rad;
    pos[i * 3 + 1] = r * (-0.5 + 1.6 * ((i * 0.373) % 1));
    pos[i * 3 + 2] = Math.sin(a) * rad;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // 尺寸：正交相机下 three 的 sizeAttenuation 【完全失效】（着色器里 gl_PointSize *= scale/-z
  // 只在透视相机分支执行），gl_PointSize 就是固定像素数 → 缩小看全图时塔只剩几像素、粒子仍占那么多
  // 像素，糊成一团。故这里只给"世界半径"，由 UnitLayer 每帧按 像素/世界单位 换算成 size。
  const mat = new THREE.PointsMaterial({
    size: 1, map: dotTexture(), color,
    transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.worldSize = r * 0.5;   // 期望的世界尺寸（UnitLayer 换算用）
  return pts;
}

/** 仅测试/切换地图时调用：释放全部共享几何与材质 */
export function disposeMeshCache() {
  for (const v of _geoCache.values()) v.geo.dispose();
  _geoCache.clear();
  for (const m of _matCache.values()) m.dispose();
  _matCache.clear();
}

export function meshCacheSize() { return _geoCache.size; }
