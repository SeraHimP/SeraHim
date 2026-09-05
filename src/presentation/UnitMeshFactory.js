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
import { FX_PARTICLE_LAYER } from './PostFX.js';
import { CONFIG } from '../data/Config.js';

const _geoCache = new Map();
const _matCache = new Map();

// ==================== Week2·Day6：三平面盒式投影 UV ====================
// docs/Q4-RENDERING-REDESIGN.md §1.2 的审计结论："单位无 UV——mergeParts() 只写了
// position/normal/color 三个 attribute"。这里补上第四个。造型是几十种手工拼装的
// 几何体拼在一起（不是一整块能好好做接缝展开的网格），逐部件手工 UV 展开工作量
// 大且这批模型后续还会跟着规则频繁改（见 docs 第 4 节推荐理由 2），所以按每个
// 顶点法线的主导轴选一个投影平面（XY/YZ/XZ 三选一，"三平面盒式投影/triplanar
// box mapping"，程序化几何的标准兜底做法），不需要为每个部件手工展开，新造型
// 天然免疫（与 pack() 里"贴地强制对齐"同一个"在合并层统一兜底"的思路）。
// 这一步只生成 UV 属性，材质还没换、没有任何贴图会用到它——纯管线搭建，画面不变。
const UV_TEXEL_SCALE = 1 / 12;   // 世界单位→UV 的缩放，决定投影出来的贴图密度
function boxProjectUV(px, py, pz, nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return [pz * UV_TEXEL_SCALE, py * UV_TEXEL_SCALE];
  if (ay >= ax && ay >= az) return [px * UV_TEXEL_SCALE, pz * UV_TEXEL_SCALE];
  return [px * UV_TEXEL_SCALE, py * UV_TEXEL_SCALE];
}

// ---------- 合并工具：把 [{geo, matrix, color}] 压成单个带顶点色+UV 的 BufferGeometry ----------
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
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const { g, c } of prepped) {
    const p = g.getAttribute('position'), q = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const nx = q.getX(i), ny = q.getY(i), nz = q.getZ(i);
      pos[(o + i) * 3] = x; pos[(o + i) * 3 + 1] = y; pos[(o + i) * 3 + 2] = z;
      nrm[(o + i) * 3] = nx; nrm[(o + i) * 3 + 1] = ny; nrm[(o + i) * 3 + 2] = nz;
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
      const [u, v] = boxProjectUV(x, y, z, nx, ny, nz);
      uv[(o + i) * 2] = u; uv[(o + i) * 2 + 1] = v;
    }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingBox();
  _applyFakeAO(pos, col, out.boundingBox);
  return out;
}

// ==================== Week2·Day7：贴地渐变假 AO ====================
// docs/Q4-RENDERING-REDESIGN.md 第 2 节判断依据："低多边形场景对 AO 极其敏感，
// 缝隙/接缝处一旦有柔和暗角，立刻显得有实体感"——真 AO（屏幕空间或逐顶点遮蔽率）
// 要么要后处理 Pass（SSAO，排在 Week2·Day9-10）、要么要知道几何真实的缝隙遮挡关系
// 逐顶点算，这批造型是几十种手工拼装体拼出来的，没有一份"这个顶点被谁挡住"的
// 关系数据。这里先用一个便宜但视觉收益不小的近似：**越靠近整个单位的底部越暗**——
// 现实里接触地面的凹角本来就是最容易积灰、被自身遮挡的地方，这条经验规律对绝大多数
// 造型（塔/小兵都是"下宽上窄或直筒"）成立。用 pow(t, AO_CURVE) 而不是线性 t，
// 让暗化只集中在贴近底部的一小段，中上段基本不受影响——不是整体调暗，是"贴地阴影"。
// 直接乘进顶点色（col 已经是 mergeParts 自己算出来的部件颜色），不需要新增贴图/新
// 材质通道，因此这一步不改变材质、不改变着色器行为，风险局限在"数值算对了没有"。
const AO_MIN = 0.72;    // 单位最底部的顶点色亮度下限（1 = 不变暗）
const AO_CURVE = 0.6;   // <1 时暗化集中在贴近底部的一小段，越小集中范围越窄
function _applyFakeAO(pos, col, bbox) {
  const minY = bbox.min.y, span = Math.max(bbox.max.y - minY, 1e-6);
  const n = col.length / 3;
  for (let i = 0; i < n; i++) {
    const t = (pos[i * 3 + 1] - minY) / span;               // 0（底部）~1（顶部）
    const factor = AO_MIN + (1 - AO_MIN) * Math.pow(Math.min(1, Math.max(0, t)), AO_CURVE);
    col[i * 3] *= factor; col[i * 3 + 1] *= factor; col[i * 3 + 2] *= factor;
  }
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
// v45：层级差异从"只改数字"扩到**也改造型**。这四行仍然只管规模，
// 但造型语言现在按阵营分家（见 towerMesh 里的 red 分支），四档的剪影因此真的不同。
// halo 字段已删（用户要求去掉基座那圈队伍色环），不留死开关。
// v45b：**每档多一件专属部件**。只调数字（层数/粗细/高度）做不出"等级越高越牛逼"——
// 对照图（tests/browser/run_tower_sheet.mjs）一拉出来，四档的剪影几乎一模一样，
// 因为四档用的是同一套部件、只是尺寸不同，而尺寸差异在各自居中的画面里根本看不出来。
// 现在逐档**加东西**：内塔起有环廊、高地塔起有角楼、枢纽塔另有尖塔。
// 这是"看得出来的差异"与"数字上的差异"的区别 —— v44 只做了后者。
// ==================== v52：档次表按新塔型重写 ====================
// 旧表（v45d）的字段是给"圆柱塔身 + 冠 + 雉堞 + 角楼 + 顶盖"那套造型写的。
// 新塔型是**逐层收分的方体 + 压顶石**（与 HowlingAbyssDecor 的墙/柱同一套语言），
// 旧字段里 `shaft`/`balcony`/`topScale` 已经没有部件读得到，留着就是死字段
//（v45 删 `spikes` 时吃过一次亏：配置里写着 8，没有任何部件读它，
// 于是"红蓝看不出区别"查了很久 —— 死字段比缺字段更能骗人）。
//
// 四档的差异**只靠剪影**：段数 segs 递增 → 总高递增 → 一眼分得出谁大谁小。
// 不再靠"同一座塔的大中小码"（那在各自居中的画面里根本读不出来）。
// `merlons`（雉堞）是外塔与内塔以上的唯一造型分野，比"矮一点细一点"读得清得多。
//
// `crown` / `buttress` / `turrets` 三项现在**只有废墟分支在读**（断塔口的冠、扶壁残根、
// 角楼碎块）。它们不是死字段，但读它们的地方只剩一处，改之前先看 ruin 分支。
const TIER_SPEC = {
  //          段数     段高    塔身半宽    台基半宽   水晶   蓝方尖塔数 红方尖刺数  ——— 以下仅废墟分支读 ———
  outer:    { segs: 1, seg: 1.15, shaftHalf: 0.50, base: 0.72, crystal: 0.40, fins: 4, spikes: 6,  crown: 0.30, buttress: 0, turrets: 0 },
  inner:    { segs: 2, seg: 0.98, shaftHalf: 0.56, base: 0.80, crystal: 0.46, fins: 4, spikes: 7,  crown: 0.34, buttress: 2, turrets: 0 },
  base:     { segs: 3, seg: 0.90, shaftHalf: 0.62, base: 0.88, crystal: 0.52, fins: 4, spikes: 9,  crown: 0.38, buttress: 4, turrets: 4 },
  hq_tower: { segs: 4, seg: 0.86, shaftHalf: 0.70, base: 0.96, crystal: 0.60, fins: 4, spikes: 11, crown: 0.44, buttress: 4, turrets: 4 },
};
const TIER_FALLBACK = TIER_SPEC.outer;
/** 塔身总高（× R）。废墟分支要用它算"倒下来那一截有多长"，别再各算各的。 */
const shaftHeight = (sp) => sp.segs * sp.seg;

// 阵营语言。两边**部件数量一致**，只换形状/角度/配色 —— 不对称的是观感，不是强弱。
// v45：`spikes` 与 `pointy` 已删 —— 它们是**死字段**。
// spikes 从 v44 起就没有任何部件读它（配置里写着 8，红方的骨刺从来没画出来），
// 这正是"红蓝看不出区别"的一半原因；pointy 在阵营分家后也失去意义
//（尖顶与否现在由 red 分支直接决定）。死字段留着比删掉更危险：
// 下一个人会以为改它有用，改完发现没反应，然后开始怀疑别的地方。
//
// v52 改色：石身从深棕/深灰（#8e9aa8 / #9a8478）拉到**浅石色**。
// 对照 Thronefall 实机图，建筑是全场**最亮最跳**的东西，而我们的塔比地面还暗，
// 整座塔沉进地里 —— 这是上一版最大的问题，比造型本身还严重。
// 新增 `ink`：深墨色，只用在门洞/射孔这类"线"上。整座塔只用三个色，
// **队伍色只出现在顶部水晶**（参考图里饱和色也只出现在极小的一处）。
const FACTION_STYLE = {
  blue:    { stone: '#5b7099', trim: '#eef4fd', ink: '#26314b', widen: 1.00, hK: 1.15, wK: 0.88, lean: 0,    crownSides: 6 },
  red:     { stone: '#9b5a45', trim: '#fbeada', ink: '#41211a', widen: 1.26, hK: 0.98, wK: 1.34, lean: 0.10, crownSides: 5 },
  neutral: { stone: '#6c6f76', trim: '#f1f2f4', ink: '#2c2f34', widen: 1.00, hK: 1.00, wK: 1.00, lean: 0,    crownSides: 8 },
};
const facStyle = (f) => FACTION_STYLE[f] || FACTION_STYLE.neutral;

/**
 * ==================== v45：建筑损毁档（0 完好 / 1 轻度 / 2 重度）====================
 * 用户定稿："每种塔有不同生命节点下的模型，以内塔举例（生命节点为 33/67/100），
 * 67-100 就是正常模型，33-67 为看起来轻度损毁，0-33 看起来重度损毁。"
 * 追加定稿："塔的模型损毁是**不可逆**的，只会从低损毁向高损毁转变。
 * 并且塔手动重生时要恢复零损毁的模型。"
 *
 * 做法上没有"做三个模型"这回事 —— towerMesh 本来就是参数化拼件（parts[] + key 缓存），
 * 而废墟(ruin)早就是 key 里的一档。损毁只是同一个 builder 的第三个维度：
 * 掉冠 / 塌一段 / 换焦黑色 / 加碎石。三档共用一份代码，几何仍然全缓存。
 *
 * **不可逆**这条让实现变简单而不是变难：不需要向下的滞回（血量在阈值附近抖动时
 * 模型来回重建是这类功能最典型的坑），只需要 `stage = max(已有, 按血量算出的)`。
 * 复位由复活流程显式清掉 `_dmgStage` 完成 —— **唯一清单在 core/reviveState.js**。
 * v47 之前它是写在 MapSystem 复活分支里的一句 `delete`，而复活其实有两条路
 *（重生队列 + 编辑器的【设为存活】），第二条没跟上，手动复活的塔模型停在重度损毁。
 * 新增复活入口时改那一份清单即可，不要在自己这边再 delete 一次。
 */
export function towerDamageStage(e, hpFrac) {
  const c = CONFIG.ui?.towerDamage || {};
  if (c.enabled === false) return 0;
  const nodes = c.nodes || [33, 67];   // [重度上界, 轻度上界]，单位 %
  const pct = Math.max(0, Math.min(1, hpFrac)) * 100;
  const now = pct < nodes[0] ? 2 : pct < nodes[1] ? 1 : 0;
  const prev = e._dmgStage || 0;
  const stage = Math.max(prev, now);   // 单向：只增不减
  if (stage !== prev) e._dmgStage = stage;
  return stage;
}

export function towerMesh(key, color, bSize, weaponId, kind, ghost, ruin, tier, faction, dmg = 0) {
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
        // ==================== 防御塔废墟（v47 随塔身重做而重做）====================
        // 用户："由于防御塔模型的重做，对应的防御塔废墟模型也需要重做。"
        //
        // v44 那版废墟是照着**当时的塔**做的：一根圆断桩 + 一截圆塔身 + 几块石头。
        // v45 把活塔彻底换掉之后（蓝方方基座/方柱/四角立柱，红方岩台/六棱柱/外露骨架肋，
        // 而且四个档次的层数、扶壁数、总高度各不相同），废墟就再也对不上了 ——
        // 蓝方的方塔倒下来变成圆柱，四个档次的废墟还是同一坨。
        //
        // 重做的判据只有一条：**玩家要能认出"这是刚才那座塔倒了"**。
        // 所以废墟不再自成一套形状，而是复用活塔的同一套词汇：
        //   ① 基座**原样保留**（红方三块岩台 / 蓝方方台 + 窄边）——
        //      基座是最贴地、最不容易被打飞的部分，也是认塔的锚点；
        //   ② 断桩 = 活塔第一段塔身的**下半截**，形状随阵营（蓝方方柱 / 红方六棱柱），
        //      粗细直接沿用活塔那一段的 rb（0.62R），不再另取 0.66/0.96；
        //   ③ 倒下的残段沿 LEAN 方向躺着，横截面同样按阵营分（方/圆），
        //      长度随 SP.shaft ——**档次越高的塔，倒下来的那一截越长**；
        //   ④ 扶壁多的档次（内塔起）留下几根折断的扶壁根部，
        //      角楼档（水晶塔起）在废墟里多两块碎角楼 —— 四档的废墟因此也各不相同；
        //   ⑤ 碎石量随档次递增，焦痕铺在倒塌方向上。
        // 角度全用固定值，保证同 key 几何稳定可缓存（不引入随机）。
        const SPr = TIER_SPEC[tier] || TIER_FALLBACK;
        const redR = faction === 'red';
        const baseHr = R * 0.42;

        // ① 基座：与活塔逐件同形，只换成 dead 色
        if (redR) {
          const rocks = [[0.00, 0.00, 1.06, 1.00], [0.26, -0.16, 0.62, 0.72], [-0.30, 0.20, 0.54, 0.58]];
          for (const [rx, rz, rr, rh] of rocks) {
            add(new THREE.CylinderGeometry(R * rr * 0.86, R * rr, baseHr * rh, 5),
                compose(T(rx * R, baseHr * rh / 2, rz * R), R_Z(0.06 * rx), R_X(-0.06 * rz)), shade(dead, 0.86));
          }
        } else {
          add(new THREE.BoxGeometry(R * 1.78, baseHr, R * 1.78), T(0, baseHr / 2, 0), shade(dead, 0.88));
          add(new THREE.BoxGeometry(R * 1.96, baseHr * 0.22, R * 1.96), T(0, baseHr * 0.11, 0), shade(dead, 0.78));
        }

        // ② 断桩：活塔第一段塔身的下半截。高度随档次（层数越多、塔身越高，留下的桩也越高）
        const segHr = R * SPr.seg;
        const stumpH = segHr * 0.46;
        const rb0 = R * 0.62;
        if (redR) {
          add(new THREE.CylinderGeometry(rb0 * 0.95, rb0, stumpH, 6), T(0, baseHr + stumpH / 2, 0), dead);
          // 折断的骨架肋：活塔有 5 根，废墟留 3 根参差不齐的根部
          for (const [k, hK] of [[0, 0.9], [2, 0.45], [3, 0.66]]) {
            const a = (k / 5) * Math.PI * 2;
            add(new THREE.BoxGeometry(R * 0.075, stumpH * hK, R * 0.11),
                compose(T(Math.cos(a) * rb0 * 1.02, baseHr + stumpH * hK / 2, Math.sin(a) * rb0 * 1.02),
                        R_Z(Math.cos(a) * 0.16), R_X(-Math.sin(a) * 0.16)), char);
          }
        } else {
          const w0 = rb0 * 1.62;
          add(new THREE.BoxGeometry(w0, stumpH, w0), T(0, baseHr + stumpH / 2, 0), dead);
          // 四角立柱只剩两根（对角），高低不同 —— 蓝方"秩序"被打破的样子
          for (const [sx, sz, hK] of [[-1, -1, 0.82], [1, 1, 0.5]]) {
            add(new THREE.BoxGeometry(R * 0.10, stumpH * hK, R * 0.10),
                T(sx * w0 * 0.5, baseHr + stumpH * hK / 2, sz * w0 * 0.5), char);
          }
        }
        // 斜切断口：盖在断桩上的一块倾斜薄板，读作"从这里断的"。形状随阵营（方/圆）
        const capY = baseHr + stumpH;
        if (redR) {
          add(new THREE.CylinderGeometry(rb0 * 1.02, rb0 * 1.02, R * 0.08, 6),
              compose(T(0, capY, 0), R_Z(LEAN * 0.5)), char);
        } else {
          add(new THREE.BoxGeometry(rb0 * 1.68, R * 0.08, rb0 * 1.68),
              compose(T(0, capY, 0), R_Z(LEAN * 0.5)), char);
        }

        // ③ 倒下的塔身残段。三件事让它读作"倒下来的"而不是"堆在旁边的一块"：
        //   · **比断桩细**（0.72×）—— 塔身本来就是往上收分的，倒下来的是上半截；
        //   · **一头搭在断桩上、一头落地**（沿 −0.34rad 倾斜），不是平放；
        //   · 横截面随阵营（蓝方方柱 / 红方六棱柱），与活塔的塔身同形。
        // 长度按活塔塔身减去断桩、再打 0.55 折（碎掉的那部分变成脚下的瓦砾）。
        const fallLen = (R * shaftHeight(SPr) - stumpH) * 0.55;
        const fallR = rb0 * 0.72;
        const tiltF = -0.34;
        const fx = R * 0.60 + fallLen * 0.44;      // 重心落在断桩外侧
        const fyy = capY * 0.52;                    // 高的一头搭在断口上，低的一头触地
        if (redR) {
          add(new THREE.CylinderGeometry(fallR * 0.72, fallR, fallLen, 6),
              compose(T(fx, fyy, R * 0.14), R_Z(Math.PI / 2 + tiltF), R_Y(0.18)), dead);
        } else {
          add(new THREE.BoxGeometry(fallLen, fallR * 1.5, fallR * 1.5),
              compose(T(fx, fyy, R * 0.14), R_Z(tiltF), R_Y(0.18)), dead);
        }
        // ④ 断段末端的冠（碎的一半），说明"那截是塔顶"。棱数用阵营的 crownSides，与活塔一致。
        // 它贴地放：塔倒下来，顶自然是离基座最远、砸在地上的那一端。
        add(new THREE.CylinderGeometry(R * SPr.crown * 0.9, R * SPr.crown * 0.72, R * 0.26, F.crownSides),
            compose(T(fx + Math.cos(tiltF) * fallLen * 0.54,
                      Math.max(R * 0.16, fyy + Math.sin(tiltF) * fallLen * 0.54),
                      R * 0.20),
                    R_Z(Math.PI / 2 + tiltF)), char);

        // ⑤ 扶壁根部：只有装了扶壁的档次才有（内塔 2 根、水晶/枢纽 4 根）
        for (let i = 0; i < SPr.buttress; i++) {
          const a = (i / Math.max(1, SPr.buttress)) * Math.PI * 2 + 0.5;
          const hK = i % 2 ? 0.42 : 0.68;
          add(new THREE.BoxGeometry(R * 0.16, stumpH * hK, R * 0.30),
              compose(T(Math.cos(a) * R * 0.86, baseHr + stumpH * hK / 2, Math.sin(a) * R * 0.86), R_Y(-a)),
              shade(dead, 0.72));
        }
        // 碎角楼：只有带角楼的档次（水晶塔起）才会在废墟里出现
        for (let i = 0; i < (SPr.turrets ? 2 : 0); i++) {
          const sgn = i ? 1 : -1;
          add(new THREE.CylinderGeometry(R * 0.20, R * 0.24, R * 0.26, F.crownSides),
              compose(T(R * (0.95 + i * 0.55), R * 0.13, R * 0.62 * sgn), R_Z(1.2 * sgn), R_X(0.35)), char);
        }

        // 碎石：顺着倒塌方向铺开，越远越小；档次越高瓦砾越多（tiers 1→3 对应 5→9 块）
        const chunks = [[0.42, 0.18, 0.10, 0.6, 0.34], [0.95, 0.15, -0.30, -0.8, 0.28],
                        [1.45, 0.13, 0.42, 0.3, 0.24], [1.70, 0.10, -0.10, 1.1, 0.18],
                        [-0.55, 0.14, 0.48, 0.9, 0.26], [2.05, 0.09, 0.30, -0.4, 0.16],
                        [1.15, 0.11, 0.72, 0.8, 0.20], [-0.30, 0.12, -0.66, 1.3, 0.22],
                        [0.66, 0.10, -0.74, -1.0, 0.18]];
        for (const [cx, cy, cz, rot, sz] of chunks.slice(0, 3 + SPr.segs * 2)) {
          add(new THREE.BoxGeometry(R * sz, R * sz * 0.9, R * sz * 0.85),
              compose(T(cx * R, cy * R, cz * R), R_Z(rot), R_X(rot * 0.35)), dead);
        }
        // 焦痕：贴地的一层暗色扁盘，摊在倒塌方向上
        add(new THREE.CylinderGeometry(R * 1.05, R * 1.25, R * 0.04, F.crownSides + 6),
            T(R * 0.45, R * 0.02, R * 0.05), char);
      }
    } else if (kind === 'gem' || kind === 'orb') {
      // ==================== 召唤水晶 / 水晶枢纽（v45 分家重做）====================
      // 用户："枢纽塔看起来就是变瘦版本的水晶塔。并且水晶塔和枢纽塔的装饰小水晶
      //        （非攻击水晶）存在穿模的情况。"
      //
      // 前一句是准确的：v44 里 gem 与 orb 走的是**同一段代码**，差别只有
      // 祭坛高一点、护柱 3→4 根、多一圈碎晶、宝石换个多面体 —— 本来就是同一个模型换参数。
      // 现在两者按"它在对局里是什么"分开：
      //   orb（召唤水晶）＝**前哨的封印**：矮、三根斜柱向内合抱、宝石半嵌在柱间，
      //                    读作"被扣住的东西"。
      //   gem（水晶枢纽）＝**基地的心脏**：高台 + 环形阶梯 + 四根直立方碑 +
      //                    悬在正中的大宝石 + 一圈**水平轨道上**的卫星碎晶，
      //                    剪影是"一座祭坛"而不是"一根柱子"。
      //
      // 穿模那句也定位到了：v44 的碎晶固定摆在半径 R*0.95、高度 pedH+colH*0.75，
      // 而护柱在 R*0.72、顶端 pedH+colH；半径只差 0.23R，碎晶自身半径就有 0.16R，
      // 红方护柱还带 lean 外倾 —— 必然插进去。**根因是位置写死、不看柱子在哪。**
      // 现在碎晶的轨道半径由柱子半径 + 两者半径和 + 余量算出来，柱子怎么摆都不会插。
      const isNexus = kind === 'gem';
      let orbSeatTop = 0;   // 召唤水晶座柱顶面高度（宝石就坐在这上面）
      // v45d：召唤水晶/水晶枢纽同样吃损毁档 —— 用户说的是"**每种**塔"。
      // 与防御塔同一套词汇：主体尺寸不动，只减细节（护柱断掉几根）+ 加损伤（掉块、碎石）。
      const cWear = dmg === 0 ? 1 : dmg === 1 ? 0.94 : 0.85;
      const cTrim = dmg === 0 ? F.trim : desat(F.trim, dmg === 1 ? 0.93 : 0.86, 1);
      const cStone = dmg === 0 ? F.stone : desat(F.stone, dmg === 1 ? 0.94 : 0.88, 1);
      const cChar = desat(F.stone, 0.34, 0.42);
      const nCol = isNexus ? 4 : 3;
      const pedH = R * (isNexus ? 0.58 : 0.40);
      const colH = R * (isNexus ? 1.12 : 0.50);   // v52：召唤水晶的护柱**大幅压矮**，理由见下面的座柱注释
      const colR = R * (isNexus ? 0.78 : 0.58);   // 护柱所在半径
      const colHalf = R * 0.13;                    // 护柱最粗处的半径

      // v52：基座由**锥台圆柱**改成**方体逐级收分 + 压顶石**，与防御塔/城墙/柱子同一套语言。
      // 旧版三级圆锥台在对照图里读起来就是三块灰石头，跟旁边的方塔完全不是一种建筑；
      // 而且 shade(…, 0.44) 这种压暗系数把浅石色又拉回了深灰 —— 石色改浅这件事
      // 只改 FACTION_STYLE 是不够的，这些**乘在上面的系数**才是最终亮度的决定项。
      // 护柱/碑/卫星碎晶的几何逻辑（防穿模那套算式）一概不动，只换基座与亮度。
      const pCapH = R * 0.11, pCapOver = R * 0.09;
      const pStep = (y, halfW, h, k) => {
        add(new THREE.BoxGeometry(halfW * 2, h, halfW * 2), T(0, y + h / 2, 0), shade(cStone, k * cWear));
        add(new THREE.BoxGeometry((halfW + pCapOver) * 2, pCapH, (halfW + pCapOver) * 2),
            T(0, y + h + pCapH / 2, 0), shade(cTrim, 0.94 * cWear));
        return y + h + pCapH;
      };
      if (isNexus) {
        // 高台三级，把"基地核心"垫起来。越往上越窄 —— 与 hq_tower 的收分同一个母题。
        let py = pStep(0, R * 1.22, pedH * 0.30, 0.86);
        py = pStep(py, R * 1.00, pedH * 0.26, 0.92);
        pStep(py, R * 0.80, pedH * 0.22, 1.0);
      } else {
        // 召唤水晶：同款方台，两级。旧版是单块扁平圆台 + 三根细斜棍，
        // 在对照图里读起来是"三根棍插在一块板上"，跟枢纽不像同一个家族的东西。
        const py = pStep(0, R * 0.78, pedH * 0.36, 0.90);
        pStep(py, R * 0.62, pedH * 0.30, 1.0);
      }

      // 护柱：枢纽是**直立方碑**（庄重），召唤水晶是**向内合抱的斜柱**（封印）
      for (let i = 0; i < nCol; i++) {
        const a = (i / nCol) * Math.PI * 2 + (isNexus ? Math.PI / 4 : 0);
        const px = Math.cos(a) * colR, pz = Math.sin(a) * colR;
        // 损毁：断掉几根护柱。**留断根**而不是整根消失 —— 整根消失会让剪影缺一大块，
        // 那又回到"主体不一样了"那个错误上去。
        const brk = (dmg === 1 && i === 0) || (dmg === 2 && i % 2 === 0);
        const hK = brk ? (dmg === 2 ? 0.34 : 0.55) : 1;
        if (isNexus) {
          add(new THREE.BoxGeometry(R * 0.20, colH * hK, R * 0.20),
              T(px, pedH + colH * hK / 2, pz), brk ? cChar : shade(cStone, 0.94 * cWear));
          if (!brk) {
            // 碑顶的小盖，让它读作"碑"而不是"柱"
            add(new THREE.BoxGeometry(R * 0.28, R * 0.07, R * 0.28),
                T(px, pedH + colH + R * 0.035, pz), shade(cTrim, 0.98 * cWear));
          }
        } else {
          // 召唤水晶的护柱也改成**方碑**，只是更细、向内倾（负号 = 朝圆心倒，读作"封印"）。
          // 与红方 lean 的外倾叠加后仍然朝内。圆柱换方柱是为了跟塔/墙/柱共用同一套语言。
          const lean = 0.20 - F.lean * 0.5;
          add(new THREE.BoxGeometry(R * 0.16, colH * hK, R * 0.16),
              compose(T(px, pedH + colH * hK / 2, pz), R_Z(-Math.cos(a) * lean), R_X(Math.sin(a) * lean)),
              brk ? cChar : shade(cStone, 0.94 * cWear));
        }
      }

      // ⚠️ 召唤水晶的**座柱**（v52 新增）。上一版没有它，宝石就悬在三根斜柱的尖上，
      // 对照图里读起来是"球浮在半空"。之前那版试图靠"宝石半嵌在柱间"解决，结果读作穿模
      // （文件里已经留过一次这个教训）。现在换个思路：
      //   · 中间立一根**方座柱 + 压顶石**，宝石坐在压顶石上 —— 有支撑，不会浮；
      //   · 三根护柱**压到座柱顶之下**，靠"高度不重叠"保证永不穿模。
      // 这比靠半径算余量稳：半径余量一旦有人改 lean / colR / crystalR 就会重新插进去，
      // 而"护柱顶 < 宝石底"这条只要座柱比护柱高就恒成立。
      if (!isNexus) {
        const seatHalf = R * 0.22, seatH = R * 0.46;
        add(new THREE.BoxGeometry(seatHalf * 2, seatH, seatHalf * 2),
            T(0, pedH + seatH / 2, 0), shade(cStone, 1.0 * cWear));
        add(new THREE.BoxGeometry((seatHalf + pCapOver) * 2, pCapH, (seatHalf + pCapOver) * 2),
            T(0, pedH + seatH + pCapH / 2, 0), shade(cTrim, 0.98 * cWear));
        orbSeatTop = pedH + seatH + pCapH;
      }
      // 掉块 + 碎石（与防御塔同一套词汇）
      if (dmg > 0) {
        const nC = dmg === 1 ? 2 : 4;
        for (let i = 0; i < nC; i++) {
          const a = (i / nC) * Math.PI * 2 + 0.6;
          add(new THREE.BoxGeometry(R * 0.26, R * 0.20, R * 0.14),
              compose(T(Math.cos(a) * R * 0.82, pedH * 0.62, Math.sin(a) * R * 0.82), R_Y(-a)), cChar);
        }
        const rub = dmg === 1 ? [[0.92, 0.34, 0.20], [-0.84, 0.48, 0.17]]
                              : [[1.02, 0.30, 0.26], [-0.90, 0.52, 0.22], [0.36, -1.00, 0.19], [-0.44, -0.86, 0.16]];
        for (const [rx, rz, sz] of rub) {
          add(new THREE.BoxGeometry(R * sz, R * sz * 0.85, R * sz * 0.9),
              compose(T(rx * R, R * sz * 0.42, rz * R), R_Z(0.6), R_X(0.3)), shade(cStone, 0.82 * cWear));
        }
      }

      // ⚠️ 宝石的高度必须让它**整个在护柱顶端之上**。
      // 第一版把召唤水晶的宝石放在 pedH + 0.46·colH + 0.72·R_gem —— 我当时的说法是
      // "半嵌在柱间，读作被扣住的东西"，但对照图（run_tower_sheet）一拉出来，
      // 它读起来就是**穿模**，和用户报的枢纽碎晶穿模是同一种观感。
      // 设计意图再好，看起来像 bug 就是 bug。现在按几何算：宝石底 ≥ 柱顶。
      crystalR = R * (isNexus ? 0.80 : 0.46);
      crystalCy = isNexus ? pedH + colH + crystalR * 0.10
                          : orbSeatTop + crystalR * 0.74;   // 坐在座柱压顶石上（略陷入 = "坐住了"）
      crystalGeo = isNexus ? new THREE.OctahedronGeometry(crystalR)
                           : new THREE.IcosahedronGeometry(crystalR, 0);
      crystalMuzzleK = (CONFIG.ui?.muzzle?.nexusTopK) ?? 0.9;

      // 卫星碎晶（仅枢纽）：轨道半径**由几何算出来**，不再写死。
      // 需要同时躲开两样东西：护柱（半径 colR、半宽 colHalf）与中心宝石（半径 crystalR）。
      // 这就是 v44 穿模的修法 —— 位置一旦写死，改任何一处柱子/宝石尺寸都会重新插进去。
      if (isNexus) {
        const shardR = R * 0.15;
        const gap = R * 0.10;                                  // 余量
        const orbit = Math.max(colR + colHalf + shardR + gap,  // 躲柱子
                               crystalR + shardR + gap);        // 躲宝石
        const shardY = pedH + colH + shardR + gap;             // 抬到碑顶之上，纵向也不会碰
        for (let i = 0; i < 6; i++) {
          if (dmg === 1 && i % 3 === 0) continue;   // 损毁时碎晶也少几颗
          if (dmg === 2 && i % 2 === 0) continue;
          const a = (i / 6) * Math.PI * 2 + Math.PI / 6;        // 与四根碑错开
          add(new THREE.OctahedronGeometry(shardR),
              compose(T(Math.cos(a) * orbit, shardY, Math.sin(a) * orbit), R_Z(a)), shade(color, 1.1));
        }
      }
    } else {
      // ==================== 防御塔（v45 按阵营彻底分家）====================
      // 用户："新模型的塔我觉得一般，并没有做出差异化，红蓝方，外/内等。"
      //
      // v44 的问题诊断清楚了再改：那一版把红蓝差异全压在 FACTION_STYLE 的
      // lean / spikes / crownSides / 配色 四项上，而 **spikes 那一项压根没有部件读它**
      //（红方的骨刺从来没被画出来）。实际生效的只剩"颜色 + 柱子微倾"，
      // 所以看起来就是同一座塔刷了两种漆。层级同理：TIER_SPEC 只改层数和粗细，
      // 造型语言从头到尾一样，四档就是同一座塔的大中小码。
      //
      // 现在两边**走各自的建造函数**，从剪影就能分开：
      //   蓝方＝秩序：正方基座、逐层内收的台阶、笔直的立柱、方齿雉堞、尖顶、悬浮法环
      //   红方＝混沌：不对称的岩基、外倾的骨架肋、歪斜的冠、成排骨刺、熔岩裂缝
      // 部件**数量对等**（不影响任何强弱读感），只是长得完全不同。
      // ==================== v52：塔模型推倒重做（红蓝两套完全不同的造型语言）====================
      // 用户："太丑了你给我好好做！可以完全推翻现有的设计！总之就是水晶+塔身+装饰的设计，
      // 别糊弄！红/蓝方的设计风格应完全不同！"
      //
      // 上一版（以及 v45）的通病都是同一个：**红蓝共用一套几何，只换配色和几个系数**。
      // 那种做法在实机的俯视视距下等于没做 —— 玩家看到的是两座一样的塔刷了两种漆。
      // 所以这次两边分成**两个独立的 builder**，剪影层面就必须能分开：
      //
      //   蓝方【霜之尖塔】：正交、对称、向上。等宽方形塔身（不收分）+ 四角贯通壁柱
      //     + 每段一道腰线 + 顶部收窄钟楼 + 一圈向内合抱的竖鳍围成"灯笼"，水晶悬在笼中。
      //     关键词：细、高、齐整。
      //
      //   红方【熔火祭坛】：倾斜、粗野、头重脚轻。塔身**逐段变宽**（倒锥），每段带一点
      //     Y 轴错转 + 段间夹一条深色熔缝，顶沿一圈外斜尖刺，三根向内弯的巨爪抓住水晶。
      //     关键词：矮、宽、扎人。
      //
      // 两边共享的只有三件事（这是"同一个世界的建筑"的下限）：
      //   ① 石身用浅色、墨线只用在"缝/洞"上；② 饱和队伍色**只出现在水晶**；
      //   ③ 档次差异只靠 segs（段数）→ 总高与体量，不靠堆细节。
      //
      // ⚠️ 损毁三档（0/1/2）保留。用户定了本轮只做完好档，所以损毁仍然是
      // "掉块 + 轻微做旧"的最低限度表达；真正的损毁造型进待办（见设计文档待办清单）。
      // 但**不能三档一模一样**——那样玩家完全看不出塔挨打了，是功能倒退。
      const SP = TIER_SPEC[tier] || TIER_FALLBACK;
      const red = faction === 'red';
      const stone = F.stone, trim = F.trim, ink = F.ink;
      const wear = dmg === 0 ? 1 : (dmg === 1 ? 0.94 : 0.86);   // 损毁只压暗石色，不改主体尺寸
      const cSt = shade(stone, wear), cTr = shade(trim, wear);

      const CAP_H = R * 0.10, CAP_OVER = R * 0.08;   // 压顶石比例：与城墙/柱子同一套（HowlingAbyssDecor）
      // 掉块：往压顶石里嵌几块墨色小方，读作"啃掉一口"。位置由 seed 定死、不引入随机
      //（同一个 key 的几何要进缓存，随机会让缓存命中与否决定长相）。
      const chip = (cy, halfW, n, seed) => {
        for (let i = 0; i < n; i++) {
          const a = ((seed + i * 3) % 4) * (Math.PI / 2) + 0.62;
          const w = halfW * 0.32;
          add(new THREE.BoxGeometry(w, CAP_H * 1.35, w),
              T(Math.cos(a) * (halfW + CAP_OVER) * 0.88, cy, Math.sin(a) * (halfW + CAP_OVER) * 0.88), ink);
        }
      };
      // 崩掉哪几件：件数随损毁档**严格递增**（0 → 约 22% → 约 42%），并且均匀分布。
      // ⚠️ 用"按比例取整 + 均匀取样"，不要用 `i % k`。模数写法在某些件数下会撞车 ——
      // 9 件时 i%4 和 i%3 都正好崩掉 3 件，于是轻损和重损的几何**一模一样**，
      // 玩家看不出区别，测试也抓不到（顶点数一致）。这是本轮真实踩到的坑。
      const dropSet = (n, d) => {
        const k = d === 0 ? 0 : d === 1 ? Math.max(1, Math.round(n * 0.22))
                                        : Math.max(2, Math.round(n * 0.42));
        const out = new Set();
        for (let i = 0; i < k; i++) out.add(Math.floor(i * n / k) % n);
        return out;
      };
      const cap = (y, halfW, color, seed) => {
        add(new THREE.BoxGeometry((halfW + CAP_OVER) * 2, CAP_H, (halfW + CAP_OVER) * 2),
            T(0, y + CAP_H / 2, 0), color);
        // 掉块数取 dmg*2 而不是 dmg。理由是踩过的坑：压顶掉块是"加顶点"、
        // 女儿墙崩齿是"减顶点"，两边数量接近时会**正好抵消** —— 完好与轻损的
        // 顶点数一模一样，看起来就像轻损这一档没做。让加的一侧涨得更快就不会撞上。
        chip(y + CAP_H / 2, halfW, dmg * 2, seed);
        return y + CAP_H;
      };

      let y = 0;
      // 阵营体型系数：**同一张档次表，两边长成完全不同的比例**。
      // 蓝方 hK 1.15 / wK 0.88 → 细高；红方 hK 0.80 / wK 1.30 → 矮宽。
      // 这一步很重要 —— 只换顶部装饰的话，两边剪影仍然是同一根柱子。
      const shaftH = R * SP.segs * SP.seg * F.hK;   // 塔身总高（不含台基与顶部）

      if (!red) {
        // ================= 蓝方【秩序·方尖堡】：只用方 =================
        // 用户定稿："蓝方遵循方正/秩序。"
        // 所以这一支**一个圆件都不用** —— 全是 BoxGeometry，全部正交对齐，左右对称，
        // 尺寸按等差走。上一版在顶上插了四根小尖塔（锥体），用户的原话是
        // "上面那一堆柱子太丑了"：那既破了"只用方"，又把顶部搞碎了。已整段删掉。
        const b1 = R * SP.base * F.wK, b2 = R * SP.base * F.wK * 0.86;
        add(new THREE.BoxGeometry(b1 * 2, R * 0.14, b1 * 2), T(0, R * 0.07, 0), shade(cSt, 0.90));
        y = cap(R * 0.14, b1, cTr, 1);
        add(new THREE.BoxGeometry(b2 * 2, R * 0.12, b2 * 2), T(0, y + R * 0.06, 0), cSt);
        y = cap(y + R * 0.12, b2, cTr, 2);

        // ① 塔身：**等宽**方柱，一根到顶（不收分 —— 收分是圆滑那一侧的语言）
        const half = R * SP.shaftHalf * F.wK;
        const shaftY = y;
        add(new THREE.BoxGeometry(half * 2, shaftH, half * 2), T(0, y + shaftH / 2, 0), cSt);

        // ② 四角贯通壁柱：竖线一路拉到顶，"向上"这件事主要靠它，比把塔加高管用
        const pil = half * 0.30;
        for (let i = 0; i < 4; i++) {
          const a = i * (Math.PI / 2) + Math.PI / 4;
          add(new THREE.BoxGeometry(pil, shaftH, pil),
              T(Math.cos(a) * half * 1.16, y + shaftH / 2, Math.sin(a) * half * 1.16), cTr);
        }
        // ③ 每段交界一道腰线，把塔身切成 segs 段（档次差异的可读来源之一）
        for (let i = 1; i < SP.segs; i++) {
          add(new THREE.BoxGeometry((half + CAP_OVER * 0.8) * 2, CAP_H * 0.6, (half + CAP_OVER * 0.8) * 2),
              T(0, shaftY + (shaftH / SP.segs) * i, 0), cTr);
        }
        // ④ 方窗阵列：每段每面一枚小方窗，位置严格等距。
        //    这是"秩序"最直接的表达 —— 参考图（docs/refs/thronefall）里的建筑也是
        //    靠这种规整的浅色小方块把大面积素墙分出节奏的。
        for (let i = 0; i < SP.segs; i++) {
          const wy = shaftY + (shaftH / SP.segs) * (i + 0.62);
          for (let f = 0; f < 4; f++) {
            const a = f * (Math.PI / 2);
            add(new THREE.BoxGeometry(half * 0.20, half * 0.20, R * 0.05),
                compose(T(Math.sin(a) * (half + R * 0.02), wy, Math.cos(a) * (half + R * 0.02)), R_Y(a)), ink);
          }
        }
        // ⑤ 正面（+Z）门洞：矩形深槽。塔按兵线转向（UnitLayer 的 needsFacing），
        //    没有正面记号就白转了。方塔的门就该是方的，不做尖拱。
        add(new THREE.BoxGeometry(half * 0.44, shaftH * 0.30, R * 0.06),
            T(0, shaftY + shaftH * 0.19, half + R * 0.02), ink);
        y = cap(shaftY + shaftH, half, cTr, 3);

        // ⑥ 挑檐 + 方齿女儿墙（参考图里每座塔顶都是这个做法：先外挑一圈，再摆一圈方齿）
        const corn = half * 1.26;
        add(new THREE.BoxGeometry(corn * 2, CAP_H * 1.6, corn * 2), T(0, y + CAP_H * 0.8, 0), cTr);
        y += CAP_H * 1.6;
        const mN = 12, mW = (corn * 2) / (mN / 4) * 0.30, mH = R * 0.17;
        const mDrop = dropSet(mN, dmg);
        for (let i = 0; i < mN; i++) {
          if (mDrop.has(i)) continue;
          // 沿方形边走一圈（不是绕圆排）—— 圆排会在四角挤成一堆，方塔就该沿边等距。
          const side = Math.floor(i / (mN / 4)), k = (i % (mN / 4)) / (mN / 4 - 1) - 0.5;
          const t = k * corn * 1.62, e = corn * 0.90;
          const px = side === 0 ? t : side === 1 ? e : side === 2 ? -t : -e;
          const pz = side === 0 ? e : side === 1 ? -t : side === 2 ? -e : t;
          add(new THREE.BoxGeometry(mW, mH, mW), T(px, y + mH / 2, pz), cTr);
        }

        // ⑦ 水晶坐在女儿墙正中的方形高台上（方台 —— 还是方的）
        crystalR = R * SP.crystal;
        const plH = R * 0.12, plHalf = crystalR * 0.62;
        add(new THREE.BoxGeometry(plHalf * 2, plH, plHalf * 2), T(0, y + plH / 2, 0), cSt);
        crystalCy = y + plH + crystalR * 0.72;
      } else {
        // ================= 红方【混沌·熔环塔】：只用圆 =================
        // 用户定稿："红方圆滑/混沌的设计方向。"
        // 所以这一支**一个方件都不用**（除了正面那道熔口，它得是个"缺口"）：
        // 圆鼓、圆环、球、半球，尺寸不规则、每一层都歪一点、有东西从侧面鼓出来。
        // 上一版的错误是"歪着的方块堆 + 一块大砧板"，方块和砧板都是方的，
        // 用户的原话是"简直都没法看" —— 混沌不等于把方块摆歪。
        const SEG = 14;                       // 圆件的分段数：够圆但仍是低多边形
        const b1 = R * SP.base * F.wK;
        // ① 台基：一只压扁的圆鼓，上大下小（外张），再压一圈圆环。
        add(new THREE.CylinderGeometry(b1 * 0.86, b1 * 0.74, R * 0.16, SEG), T(0, R * 0.08, 0), shade(cSt, 0.88));
        add(new THREE.TorusGeometry(b1 * 0.84, R * 0.05, 6, SEG),
            compose(T(0, R * 0.16, 0), R_X(Math.PI / 2)), cTr);
        y = R * 0.18;

        // ② 塔身：一摞**圆鼓**，半径忽胖忽瘦（不是单调收分），每层各歪各的。
        //    "混沌"就写在这两点上：节奏不齐 + 轴线不正。
        const segH = shaftH / SP.segs;
        const baseHalf = R * SP.shaftHalf * F.wK;
        let topR = baseHalf;
        for (let i = 0; i < SP.segs; i++) {
          // 忽胖忽瘦：奇数层鼓出来、偶数层收进去，整体仍随高度略收
          const shrink = 1 - i * 0.03;
          const rB = baseHalf * shrink * (i % 2 ? 0.82 : 1.10);
          const rT = baseHalf * (1 - (i + 1) * 0.03) * (i % 2 ? 1.10 : 0.82);
          const tilt = (i % 2 ? -1 : 1) * 0.085;
          add(new THREE.CylinderGeometry(rT, rB, segH, SEG),
              compose(T(0, y + segH / 2, 0), R_Z(tilt), R_Y(i * 1.1)), cSt);
          if (i === 0) {
            // 正面（+Z）熔口：圆拱洞。红方的正面记号。
            add(new THREE.CylinderGeometry(rB * 0.30, rB * 0.30, R * 0.10, SEG),
                compose(T(0, y + segH * 0.36, rB * 0.94), R_X(Math.PI / 2)), ink);
          }
          y += segH;
          // 层间圆环（熔箍）：比鼓略大，深色，读作"箍住要裂开的石头"
          add(new THREE.TorusGeometry(rT * 1.02, R * 0.055, 6, SEG),
              compose(T(0, y, 0), R_X(Math.PI / 2), R_Y(tilt)), ink);
          topR = rT;
        }

        // ③ 侧面鼓包：几颗大小不一的球黏在塔身上，位置不对称 —— 这是"混沌"的装饰。
        //    数量随档次走，位置由固定角度给出（不引入随机，几何要进缓存）。
        const blobs = [[0.55, 0.42, 0.9], [2.30, 0.68, 0.7], [4.10, 0.28, 0.8], [5.20, 0.86, 0.6]];
        const nBlob = Math.min(blobs.length, SP.segs + 1);
        const blobDrop = dropSet(nBlob, dmg);     // 鼓包也会被打掉（红方的损毁表达之一）
        for (let i = 0; i < nBlob; i++) {
          if (blobDrop.has(i)) continue;
          const [a, hK2, sz] = blobs[i];
          const by = y - shaftH * (1 - hK2);
          const br = baseHalf * (0.30 * sz);
          add(new THREE.SphereGeometry(br, SEG, 8),
              T(Math.cos(a) * baseHalf * 0.86, by, Math.sin(a) * baseHalf * 0.86), shade(cSt, 1.06));
        }

        // ④ 顶部：一只**碗**（半球，开口朝上）。水晶就窝在碗里。
        //    蓝方是"方齿女儿墙托一块方台"，红方是"碗"—— 顶部一眼就分得开。
        crystalR = R * SP.crystal;
        const bowlR = crystalR * 1.16;
        add(new THREE.SphereGeometry(bowlR, SEG, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
            T(0, y + bowlR * 0.10, 0), cTr);
        add(new THREE.TorusGeometry(bowlR * 0.99, R * 0.06, 6, SEG),
            compose(T(0, y + bowlR * 0.10, 0), R_X(Math.PI / 2)), shade(cSt, 1.05));

        // ⑤ 环抱的臂：三条**由大到小的球串**从碗沿探出、向内弯过来护住水晶。
        //    第一版用 TorusGeometry 画弧，结果整条弧都躲在碗沿后面根本看不见 ——
        //    圆环的朝向要靠三次旋转叠出来，很容易连自己都摆不对。球串没有朝向问题，
        //    而且"由大到小"本身就读作弯曲，是更稳的画法。
        //    ⚠️ 臂的半径由水晶算出来，不写死 —— 这个文件已经因为"位置写死"出过一次穿模
        //    （v44 卫星碎晶）。以后改水晶大小，臂会自己让开。
        //    臂**不参与损毁崩件**：它们是最高的石件，崩掉会让石身包围盒变矮，
        //    等于"损毁顺带改了主体尺寸"，那是用户当场推翻过的错误。
        // 只用两颗、且都压在水晶**腰线以下** —— 上一版三颗一路堆到水晶头顶，
        // 加上碗沿那圈珠子，整个顶部变成一堆撒在水晶上的白点，读不出"臂"。
        const armBeads = [[1.36, -0.02, 0.135], [1.18, 0.46, 0.105]];
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.4;
          for (const [rk, hk, sk] of armBeads) {
            add(new THREE.SphereGeometry(R * sk, SEG, 8),
                T(Math.cos(a) * crystalR * rk, y + bowlR * 0.10 + crystalR * hk, Math.sin(a) * crystalR * rk),
                cTr);
          }
        }

        // ⑥ 碗沿一圈小圆珠（不是尖刺 —— 尖刺是"方正/锐利"那一侧的词）
        // 珠子贴着碗沿排一圈（不是尖刺 —— 尖刺是"方正/锐利"那一侧的词），
        // 压在碗沿高度上，读作"镶了一圈边"，不是撒在顶上的点。
        const bDrop = dropSet(SP.spikes, dmg);
        for (let i = 0; i < SP.spikes; i++) {
          if (bDrop.has(i)) continue;
          const a = (i / SP.spikes) * Math.PI * 2 + 0.2;
          add(new THREE.SphereGeometry(R * 0.048, 8, 6),
              T(Math.cos(a) * bowlR * 0.97, y + bowlR * 0.04, Math.sin(a) * bowlR * 0.97), cTr);
        }
        crystalCy = y + bowlR * 0.10 + crystalR * 0.68;   // 窝在碗里，比蓝方低、更沉
      }

      // ⑤ 水晶＝武器＝炮口。全塔**唯一**的饱和队伍色。
      //    大小与高度不随损毁变 —— 变了等于损毁顺带改了炮口位置，弹道会像换了把武器。
      //    形状也分家：蓝方八面体（规整），红方二十面体（多面、粗野）。
      crystalGeo = red ? new THREE.IcosahedronGeometry(crystalR, 0)
                       : new THREE.OctahedronGeometry(crystalR);
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

// ==================== 谁要转（v45 改为"除塔之外全都转"）====================
// 这里原来是一张白名单（melee/ranged/siege/ram/super/warlock/corrupt），
// 理由是"图腾这类轴对称造型转了也看不出来"。那个理由在 v45 之前成立，现在不成立了：
// **朝向已经变成战斗规则**（非塔单位必须转到正面才能开火，见 FacingSystem）。
// 一个单位如果受规则约束却在画面上从不转身，玩家看到的就是"它明明对着敌人却不打" ——
// 表现与规则脱节比"转了看不出来"糟得多。轴对称的单位转起来无害，只是看不见而已。
//
// 判据必须与 FacingSystem.facingExempt **同一句话**（塔豁免），否则两处一旦漂移，
// 又会变成"规则说要转、画面不转"的那种查不出来的不一致。
export function needsFacing(type) { return type !== 'tower'; }

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
 * ==================== 朝向（v45 修：龙走路头没朝前）====================
 * 用户："龙目前走路头没有朝着前面。"两个原因叠在一起：
 *   ① 龙**不在** FACING_TYPES 里 —— 它从来就没转过，永远朝正北；
 *   ② 更隐蔽的一条：这条龙的几何是**朝 -Z 建**的（头在 -Z、尾在 +Z），
 *      而项目里其余程序化模型一律朝 +Z 建（UnitLayer 直接把 _facing 赋给 rotation.y）。
 *      也就是说即使把它加进 FACING_TYPES，它也会**倒着走**。
 * 头注原来那句"朝向约定：模型面朝 -Z（与其余单位一致）"是错的 —— 其余单位朝 +Z。
 * 这种"注释写着一致、其实相反"的东西最坑，所以不靠改注释解决：
 * 造完之后把整块几何绕 Y 转 180°，让它**真的**朝 +Z，与全项目同一个约定。
 */
export function dragonMesh(key, color, ancient, size = null) {
  let hit = _geoCache.get(key);
  if (!hit) {
    // 尺寸由调用方给（来自 CONFIG.dragonSizes）。省略时才回退到原来的写死值 ——
    // 保留回退是为了让这个函数单独调用时仍然能用，但正常路径一律走配置。
    const ds = CONFIG.dragonSizes || {};
    const S = size ?? (ancient ? (ds.ancient ?? 30) : (ds.element ?? 24));
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
    // 归一到全项目的朝向约定（正面 = +Z）。这条龙上面所有部件都是按"头在 -Z"摆的，
    // 与其重排几十个坐标（每改一处都可能把翼/尾摆错），不如整体转 180° —— 一行，且无歧义。
    hit.geo.rotateY(Math.PI);
    _geoCache.set(key, hit);
  }
  return { geo: hit.geo, mat: unitMaterial(false), topY: hit.topY };
}

/**
 * 单位材质：顶点色 + 受光。幽灵（等待重生的水晶）走半透明。
 *
 * ==================== Week2·Day6：Lambert → Standard ====================
 * docs/Q4-RENDERING-REDESIGN.md 第 11 节 P0："材质从 Lambert 换成 Standard（先不挂
 * 任何新贴图，验证换材质本身不会让画面变化）"。Standard 是 PBR 材质，默认参数
 * 下环境反射/高光响应与 Lambert 的纯漫反射模型不是同一套数学，不能假设零配置换皮
 * 就画面不变——这里显式钉死 roughness:1（完全粗糙，没有镜面高光，最贴近 Lambert
 * 的观感）、metalness:0（非金属，反射率走的是普通电介质那条低反射路径）、
 * envMapIntensity:0（场景没挂环境贴图，这个不影响，但显式写零，以后万一加了
 * 环境贴图也不会让单位平白冒出一层不该有的反射）。这三项是"贴图槽位化"（第 4 节
 * 的推荐理由）里第一批占位——贴图接进来之后 roughness/metalness 会换成从贴图采样，
 * 现在先给纯色兜底值。
 */
export function unitMaterial(ghost) {
  const k = ghost ? 'ghost' : 'solid';
  let m = _matCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: !!ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0,
      // v47：昼夜染色的落点。color 与顶点色**相乘**，所以白色 = 完全不改
      // （Lambert 时代就是这个行为，Standard 的 color/vertexColors 语义相同），
      // 越暗越往当时的天空色压。初值必须是白：材质是共享缓存的，第一帧在
      // setUnitTint 之前就会被用到。
      color: 0xffffff,
    });
    _matCache.set(k, m);
  }
  return m;
}

/**
 * 给**所有**单位（塔 / 小兵 / 龙 / 幽灵）统一施加昼夜染色。
 *
 * 用户："任何单位，兵/塔/龙等都要融入地形光照。"—— 三种单位走的都是 unitMaterial()
 * 这一份共享材质，所以只要染这一处就全覆盖，不需要逐实体去改（也不该：
 * 逐实体改就等于每种单位各写一份，正是本仓库反复出现的那类问题）。
 * 色值怎么来的见 DayNight.unitTintOf 的头注。
 *
 * 水晶（crystalMaterial）**不在此列**：它是自发光的，"夜里发亮"就是它的设定。
 */
export function setUnitTint(hex) {
  for (const k of ['solid', 'ghost']) {
    const m = _matCache.get(k);
    if (m) m.color.set(hex);
  }
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
    // 水晶粒子同样排除出法线深度预渲染（描边 bug 根因之一，见 PostFX.js 头注）。
    pts.layers.set(FX_PARTICLE_LAYER);
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
