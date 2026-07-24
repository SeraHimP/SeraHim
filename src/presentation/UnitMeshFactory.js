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
// 中性石色：塔身/底座用它，融入土色地形（用户 Q2）。队伍色只落在顶部/本体的小水晶上。
const STONE = '#948b7c';

/**
 * 防御塔：基座 → 塔身 → 雉堞冠 → 武器标记。
 * 水晶（isNexus）走宝石造型，分路水晶走球体，与 2D 的 💎/🔮 语义对应。
 * 返回 { geo, mat, topY }；topY = 世界单位高度，血条据此上浮。
 */
export function towerMesh(key, color, bSize, weaponId, kind, ghost, ruin) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const R = bSize, parts = [];
    let topY, muzzleR = 0;
    if (ruin) {
      // 损毁结构：矮塌的断桩 / 碎裂台座 + 倾倒散落的碎块，明显区别于活体（读作"废墟"）。
      // 角度全用固定值，保证同 key 几何稳定可缓存（不引入随机）。topY 由 pack 从包围盒取真值。
      if (kind === 'gem' || kind === 'orb') {
        const pedH = R * 0.34;
        parts.push({ geo: new THREE.CylinderGeometry(R * 0.62, R * 0.92, pedH, 8),
                     matrix: T(0, pedH / 2, 0), color: shade(color, 0.5) });
        // 碎裂核心残片：水晶枢纽→八面体碎片，召唤水晶→球体碎片，散落并倾倒
        const frag = kind === 'gem'
          ? () => new THREE.OctahedronGeometry(R * 0.30)
          : () => new THREE.SphereGeometry(R * 0.26, 10, 8);
        const shards = [[-0.48, 0.18, 0.28, 0.5], [0.46, 0.16, -0.32, -0.7],
                        [0.06, 0.22, 0.58, 1.0], [-0.30, 0.14, -0.52, 0.3]];
        for (const [sx, sy, sz, rot] of shards) {
          parts.push({ geo: frag(),
                       matrix: compose(T(sx * R, pedH + sy * R, sz * R), R_Z(rot), R_X(rot * 0.6)),
                       color: shade(color, 0.9) });
        }
      } else {
        const stumpH = R * 0.46;
        parts.push({ geo: new THREE.CylinderGeometry(R * 0.7, R * 0.94, stumpH, 8),
                     matrix: T(0, stumpH / 2, 0), color: shade(color, 0.55) });
        // 一截近乎倒下的断裂塔身残段（横躺，读作"塌了"）
        parts.push({ geo: new THREE.CylinderGeometry(R * 0.3, R * 0.44, R * 0.5, 8),
                     matrix: compose(T(R * 0.3, stumpH * 0.6, -R * 0.05), R_Z(1.15)),
                     color: shade(color, 0.75) });
        // 倒塌散落的石块
        const chunks = [[-0.85, 0.14, 0.32, 0.6], [0.78, 0.12, -0.5, -0.8],
                        [0.12, 0.1, 0.9, 0.3], [-0.5, 0.13, -0.78, 1.1]];
        for (const [cx, cy, cz, rot] of chunks) {
          parts.push({ geo: new THREE.BoxGeometry(R * 0.34, R * 0.26, R * 0.3),
                       matrix: compose(T(cx * R, cy * R, cz * R), R_Z(rot), R_X(rot * 0.4)),
                       color: shade(color, 0.68) });
        }
      }
    } else if (kind === 'gem' || kind === 'orb') {
      // 水晶：中性石座 + 队伍色宝石（八面体）/ 球体（用户 Q2：底座石色、宝石染队色）
      const pedH = R * 0.45;
      parts.push({ geo: new THREE.CylinderGeometry(R * 0.75, R * 0.95, pedH, 8),
                   matrix: T(0, pedH / 2, 0), color: shade(STONE, 0.55) });
      const gemR = R * 0.8, gemY = pedH + gemR * 0.95;
      parts.push({ geo: kind === 'gem' ? new THREE.OctahedronGeometry(gemR)
                                       : new THREE.SphereGeometry(gemR, 16, 12),
                   matrix: T(0, gemY, 0), color: shade(color, 1.08) });
      topY = gemY + gemR;
    } else {
      // 塔身全部【中性石色】融入地形；队伍色只落在顶部小水晶（=武器，子弹由此射出，用户 Q2）
      const baseH = R * 0.40, shaftH = R * 1.45, crownH = R * 0.32;
      parts.push({ geo: new THREE.CylinderGeometry(R * 0.88, R * 1.0, baseH, 10),
                   matrix: T(0, baseH / 2, 0), color: shade(STONE, 0.5) });
      parts.push({ geo: new THREE.CylinderGeometry(R * 0.58, R * 0.68, shaftH, 10),
                   matrix: T(0, baseH + shaftH / 2, 0), color: shade(STONE, 0.82) });
      const crownY = baseH + shaftH;
      parts.push({ geo: new THREE.CylinderGeometry(R * 0.78, R * 0.72, crownH, 10),
                   matrix: T(0, crownY + crownH / 2, 0), color: shade(STONE, 0.68) });
      // 雉堞：冠顶一圈小方块，是"塔楼"读感的关键
      const mN = 8, mS = R * 0.20, mY = crownY + crownH + mS / 2;
      for (let i = 0; i < mN; i++) {
        const a = (i / mN) * Math.PI * 2, rr = R * 0.66;
        parts.push({ geo: new THREE.BoxGeometry(mS, mS * 1.3, mS),
                     matrix: T(Math.cos(a) * rr, mY + mS * 0.15, Math.sin(a) * rr),
                     color: shade(STONE, 0.6) });
      }
      // 顶部队伍色小水晶（八面体）＝武器；炮口取其中心（子弹从这颗水晶射出）
      const gemR = R * 0.40, gemCY = mY + mS + gemR * 0.65;
      parts.push({ geo: new THREE.OctahedronGeometry(gemR),
                   matrix: T(0, gemCY, 0), color: shade(color, 1.12) });
      muzzleR = gemR;   // muzzleY = topY − gemR = 顶部水晶中心
      void weaponId;    // weaponId 不再驱动几何（炮口＝顶部水晶）
    }
    hit = pack(parts);
    hit.muzzleY = hit.topY - muzzleR;   // 有顶水晶的塔＝水晶中心；水晶/废墟＝塔冠顶（muzzleR=0）
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(ghost), topY: hit.topY, muzzleY: hit.muzzleY };
}

// ===================== 分兵种造型（第 6.3 步补充） =====================
// 约定：模型一律朝【+Z】建，UnitLayer 按移动方向绕 Y 轴旋转。
// 有"头尾"的单位（炮车/投石机/机甲/步兵）才转；图腾这类对称体不转，转了也看不出来。
const R_X = (a) => new THREE.Matrix4().makeRotationX(a);
const R_Z = (a) => new THREE.Matrix4().makeRotationZ(a);
const compose = (m, ...rest) => rest.reduce((acc, x) => acc.premultiply(x), m.clone());

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
};

// 需要朝向的兵种（有明确头尾）。图腾/护盾/术士/蚀骨等对称造型不转。
const FACING_TYPES = new Set(['melee', 'ranged', 'siege', 'ram', 'super']);
export function needsFacing(type) { return FACING_TYPES.has(type); }

/**
 * 小兵：身体（下粗上细的柱体）+ 头（球）+ 肩甲，阵营色。
 * size 沿用 MINION_STYLE 的世界尺寸，视觉高度约 size×2.1——比贴图纸片人略高，
 * 因为立起来之后底面积变小，不加高会显得矮胖。
 */
export function minionMesh(key, color, size, type) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const build = MINION_BUILDERS[type];
    hit = pack(build ? build(color, size) : infantryParts(color, size, false).parts);
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(false), topY: hit.topY };
}

/** 巨龙：拉长的身体 + 头 + 双翼，比小兵大一圈，古龙更大 */
export function dragonMesh(key, color, ancient) {
  let hit = _geoCache.get(key);
  if (!hit) {
    const S = ancient ? 30 : 24, parts = [];
    const bodyH = S * 0.85;
    parts.push({ geo: new THREE.SphereGeometry(S * 0.62, 14, 10),
                 matrix: new THREE.Matrix4().makeScale(1, 0.72, 1.45).premultiply(T(0, bodyH, 0)),
                 color });
    parts.push({ geo: new THREE.ConeGeometry(S * 0.34, S * 0.7, 8),
                 matrix: new THREE.Matrix4().makeRotationX(Math.PI / 2)
                   .premultiply(T(0, bodyH * 1.05, -S * 0.9)), color: shade(color, 1.15) });
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(S * 1.15, S * 0.08, S * 0.55),
                   matrix: new THREE.Matrix4().makeRotationZ(sx * 0.42)
                     .premultiply(T(sx * S * 0.78, bodyH * 1.25, S * 0.1)),
                   color: shade(color, 0.72) });
    }
    parts.push({ geo: new THREE.CylinderGeometry(S * 0.16, S * 0.22, bodyH, 6),
                 matrix: T(0, bodyH / 2, 0), color: shade(color, 0.6) });
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

/** 仅测试/切换地图时调用：释放全部共享几何与材质 */
export function disposeMeshCache() {
  for (const v of _geoCache.values()) v.geo.dispose();
  _geoCache.clear();
  for (const m of _matCache.values()) m.dispose();
  _matCache.clear();
}

export function meshCacheSize() { return _geoCache.size; }
