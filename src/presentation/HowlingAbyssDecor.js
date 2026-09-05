/**
 * HowlingAbyssDecor.js —— 嚎哭深渊·冰封版专属装饰层
 *
 * 设计文档：docs/MAP-DESIGN-howling-abyss-frost.md。只服务 `paletteId==='frost'`
 * 这一张地图（目前只有 `howling_abyss_frost_v1`），不是通用机制——柱子/墙段的
 * 位置直接读地图声明的 `frostBridge`（世界坐标，见 howling_abyss_frost.js 头注），
 * 这里只管"照着坐标摆什么几何体"，不重新推导桥的形状/朝向。
 *
 * 纯装饰，不改变任何占位判定——navgrid 逐位不变，这一层只是加在上面看的东西。
 *
 * ⚠️ 火炬的"火焰"用的是普通几何体（Cone/Icosahedron）+ MeshBasicMaterial，
 * 不是 Points/LineSegments 粒子——第 1 节记录过的描边 bug 根因就是线/点类几何
 * 没排除出预渲染相机，普通 Mesh 不会踩这个坑，不需要额外接入 HUD_SPRITE_LAYER。
 * "孤灵小岛"的灵魂光点同理，用小型发光 Mesh 而不是粒子系统。
 */
import * as THREE from '../../vendor/three.module.js';
import { stylizedPaletteOf } from '../data/Config.js';

// 坐标哈希 → [0,1)，确定性伪随机（与 VegetationLayer 同一套算法，保证同一张图
// 每次加载画面一致、可复现——不用 Math.random）。
function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

// 世界坐标 (x,y) → Three.js 场景坐标：与全项目一致的映射，见 UnitLayer 等
// 各处的 position.set(e.pos.x, height, e.pos.y)（世界 y 轴对应场景 z 轴）。
const toScene = (x, y, h = 0) => new THREE.Vector3(x, h, y);
// 世界坐标系里的朝向角（Math.atan2(dy,dx)）→ Three.js 绕 Y 轴的 rotation.y，
// 使物体局部 +X 轴对齐到该方向在场景 XZ 平面上的投影。
const worldAngleToRotY = (angle) => -angle;

// ==================== 2026-09-05 用户反馈：推倒重做成【柱子】【墙】【柱子】 ====================
// 上一版是"6 棱锥台柱身 + 圆锥雪冠"配"矩形墙板 + 压顶石"——两套完全不同的形状
// 语言拼在一起，加上柱子 46 高、墙只有 13 高，比例也垮了。用户连续两条反馈：
// "你这做的啥墙啊，我咋看不懂呢，而且对应的柱子也要变短啊"
// "你能不能把墙完全推倒重做？？？做成【柱子】【墙】【柱子】这种。并且墙体别太宽，
//  柱子和墙要风格统一"
//
// 现在柱和墙是**同一套构造**，只差尺寸：都是矩形体块 + 同一种压顶石（同高、同探出、
// 同材质）。柱子比墙板【高一截、厚一圈】，柱-墙-柱的节奏因此一眼读得出来：
//   柱：POST_W 见方、POST_H 高
//   墙：WALL_THICK 厚、WALL_H 高（比柱矮、比柱薄）
// 圆锥雪冠去掉了——它是整套里最不"矩形"的一块，留着就谈不上风格统一。火盆/火焰
// 仍旧摞在柱顶正上方（用户返工三轮才定下的关系），只是锚点从雪冠改成柱子的压顶石。
const POST_H = 22, POST_W = 11;   // 柱子：明显高过墙板、粗过墙板，但不再是原来 46 那种塔
const CAP_H = 3, CAP_OVERHANG = 1.5;  // 压顶石——柱和墙共用同一套厚度与探出量
// ==================== 2026-09-05 用户反馈重做：火炬（两轮） ====================
// 第一轮是"柱子顶端插一根杆子+火苗"，用户原话："应该是火盆承载着火焰在石墙上"。
// 改成"支架从墙面探出+火盆"后，支架起点算错（离柱心太近，糊在柱子雪冠上）+
// 用户看完直接否掉了"挑出去"这个思路："那个火盆应该就是在原来的柱子上，
// 不要挂着！"——现在是第三版：火盆直接贴住柱身表面，中间没有支架，
// 见 _buildPillarsAndTorches 方法头注。
const BRAZIER_BOWL_R_TOP = 5.6, BRAZIER_BOWL_R_BOT = 3.8, BRAZIER_BOWL_H = 4.4;
const TORCH_FLAME_H = 10;

// ==================== 2026-09-05 用户反馈第五轮：按 Thronefall 的设计语言重做石墙 ====================
// 用户发来 16 张 Thronefall 实机截图当参考，并明确"一定要有统一的设计语言"。
// 从参考里读到的墙的规则（用户已确认）：**低矮细长的一条带**，规律的细节靠
// 顶部压顶石的节奏体现，间隔立较粗的柱子/门楼，顶边有不规则的细锯齿；
// 绝不是一块块砖垒出来的。用户原话："目前的墙太复杂了不适配简洁风格"
// "每个墙的除了用柱子分割之外，每一块都是一体的""墙体的高度降低到 50%"
// "做成石栅栏那种感觉""可以在墙上加一些缺口模拟环境侵蚀"。
//
// 相应地，上一版"分块砌墙"（每段切成 n 块 BoxGeometry + 3 档深浅色随机错缝）
// 整套拆掉：那套做法的复杂度全用在"垒砌纹理感"上，而这正是用户要去掉的东西。
// 现在每两根柱子之间**只有一根连续的墙体**（脚下没桥的那一段除外，见
// _buildWallSegments 头注），侵蚀感改由顶部压顶石的缺失与高低不齐来表达——
// 墙身本身是完整的一条，顶边是啃过的（用户在选项里明确选了"只在顶边啃出缺口"，
// 不是整跨塌掉；整跨塌掉只发生在桥面真凹口那一处，两者是两回事）。
const WALL_H = 13;            // 墙板高：用户"墙体的高度降低到 50%"——26→13
const WALL_THICK = 6;         // 墙板厚：用户"墙体别太宽"——8→6，比柱子(11)明显薄一圈，柱墙节奏才读得出来
const WALL_CAP_PITCH = 14;    // 压顶石的节奏间距——墙身连续，靠这一层的重复制造韵律
const WALL_EROSION_CHANCE = 0.1;  // 压顶石按坐标哈希缺失的比例＝顶边"被风化啃掉"的缺口。
                              // 0.22 时平均每四五块就缺一块、加上每块还各自缩了 8%，
                              // 整道墙读成一排碎块而不是一道墙（用户："我咋看不懂呢"）
const WALL_RUN_STEP = 6;      // 沿墙扫"脚下有没有桥"的采样步长（决定断口两端的精度）
const WALL_RUBBLE_PITCH = 20; // 断口里每隔多远摆一堆瓦砾——扫描步长是 6，若逐个采样点都摆，
                              // 瓦砾密度会是上一版的三倍多，堆成一条碎石带，与简洁风格相悖
// ==================== 2026-09-05 用户反馈第四轮：缺口是几何事实，不是概率 ====================
// 此前这里有 WALL_GAP_CHANCE（先 0.55 后 1）和 WALL_GAP_BLOCKS 两个常量，用来
// 在**每根柱子**旁边拆墙。那套机制建立在一个错误前提上：把地图里 `GAP_D` 那
// 13 个**柱子间距**弧长当成了"桥上的 13 处缺口"。用户拿地形位图截图圈出真相：
// 全桥真正凹进去的缺口**只有一处**（sign-1 侧弧长 1240~1400，内凹 67 个单位），
// 用户原话："我指的桥上的缺口是我画红圈的地方，墙在桥的两侧，正好有一块的墙
// 会穿过桥的缺口那里，所以那部分的墙就断掉"。
//
// 于是两个常量连同整套概率机制一起删掉，换成一句几何判据：
//   **墙脚下没有桥的地方，这块墙就不摆**（改摆瓦砾）。
// 墙沿直线走，走到那处凹口上方时脚下是水，那一段自然断开；其余地方墙连续
// 不断、与柱子严丝合缝——用户同时要求"柱子和墙是一体的"，而"一体"和
// "缺口处断开"在这套判据下不再矛盾：不需要为了做出断口而在柱子旁边硬拆砖。
//
// 判据用的两样东西都由地图数据给（`map.frostBridge.left/right`）：`inward`
// 指向桥内侧的单位法向，`groundProbe` 是往内侧探多远采样——不能直接采墙身
// 中线，因为可走区域正好收到墙线上（见 howling_abyss_frost.js 头注④），
// 中线落在边界格上，结果会随取整方向抖动。

/**
 * 不规则冰棱柱几何体：在标准棱柱的基础上，按角度槽位给每个顶点一个一致的半径
 * 抖动，做出参考图里那种歪歪扭扭的冰原轮廓。
 *
 * 为什么必须做这个：上一版所有冰块都是 `CylinderGeometry(1, .88, 1, 6)`，也就是
 * 规则六边形——尺寸和概率怎么调都改变不了"一地大小雷同的硬币"这个观感
 * （用户："这算啥环境层次啊，做的一点都不好看"）。参考图里的冰原是不规则多边形、
 * 而且明显被拉长过，两块挨着能读成一整片，规则六边形永远做不到。
 *
 * 同一个角度槽位的上下环共用同一个抖动系数，侧面才不会扭成麻花。
 * @param {number} sides 边数 @param {number} seed 决定这一块长什么样（同 seed 同形状）
 */
function icePrismGeo(sides, seed) {
  const g = new THREE.CylinderGeometry(1, 0.88, 1, sides, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-6) continue;
    const slot = Math.round((Math.atan2(z, x) + Math.PI) / (Math.PI * 2) * sides);
    const k = 0.5 + hash(seed * 131 + slot * 37, seed * 17 + slot * 91) * 0.85;  // 0.50~1.35
    pos.setX(i, x * k); pos.setZ(i, z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ==================== 2026-09-05 阶段二：水域按 Thronefall 参考重做 ====================
// 参考图（雪地那几张）里，可玩区域之外不是一片均匀的碎块，而是**成组的冰脊**
// （大块平顶多边形，亮顶面 + 暗侧面，几块叠在一起成为一坨）加上**冰刺丛**
// （那些细高的浅色锥体，是这套美术里辨识度最高的母题），再零星点缀平浮冰。
// 上一版只有一档"接近格距的平六边形"，大小雷同、铺满整片水面，读成一张瓷砖贴图。
// 现在分三档，靠**尺度差**拉开层次（这也是参考图里唯一的层次手段——它没有贴图）：
const RIDGE_STEP = 330;        // 冰脊的布点格距：比浮冰稀疏得多，成组出现才像山
const RIDGE_CHANCE = 0.8;      // 每个格子长冰脊的概率——参考图里环境是被冰脊填满的，不是空旷的水面
const RIDGE_MIN_DIST = 300;    // 离桥至少这么远才长冰脊——近处留给平浮冰，别挡视线/压桥
const RIDGE_SLABS = [2, 4];    // 每坨冰脊由几块平顶多边形叠成（闭区间）
const RIDGE_R = [40, 132];     // 单块平顶多边形的半径范围——上限拉大，才会出现几坨明显更大的冰川
const RIDGE_H = [18, 38];      // 冰脊高度范围——够厚，侧面才压得出明显的暗部（参考图的层次全靠这个）
const SPIKE_PER_RIDGE = [9, 18];// 每坨冰脊上插几根冰刺——参考图里是成丛的冰针，不是零星几根
const SPIKE_R = [2.6, 6.5];    // 冰刺底半径：细，成丛之后才读成冰针而不是木桩
const SPIKE_H = [16, 58];      // 冰刺高度：高低差要大，一丛里参差不齐才自然

export class HowlingAbyssDecor {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
    this.shadowLevel = 'off';
  }

  /**
   * 用户反馈"目前的石墙并没有体积碰撞和光影"——光影这半句跟拓宽桥面/体积碰撞
   * 是两件独立的事（后者要动 navgrid，见设计文档第 6 节待确认清单），这半句
   * 纯粹是渲染开关，跟 `WallLayer.setShadowLevel` 走一样的模式，可以先落地。
   * 只给石头类实体开（柱子/墙体/压顶石/火盆），不给火焰（MeshBasicMaterial，
   * 自发光，开了阴影没有意义）、冰面/水面（这次不追加，避免不必要的阴影贴图
   * 开销——那一片本来就在场景边缘，投影收益很小）。
   */
  setShadowLevel(level) {
    this.shadowLevel = level;
    if (!this.group) return;
    const on = level !== 'off';
    this.group.traverse((o) => {
      if (o.isMesh && o.material && o.material.type !== 'MeshBasicMaterial') {
        o.castShadow = on;
        o.receiveShadow = on;
      }
    });
  }

  clear() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.scene.remove(this.group);
    this.group = null;
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    if (!map || map.paletteId !== 'frost' || !map.frostBridge) {
      this.clear(); this._mapId = null; return;
    }
    if (this._mapId === map.id && this.group) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;

    const SV = stylizedPaletteOf(map);
    const stoneColor = SV.rockColor || '#8fa3b0';
    const stoneColorDark = new THREE.Color(stoneColor).multiplyScalar(0.78).getHex();

    const group = new THREE.Group();
    this.group = group;
    this.scene.add(group);

    const stoneDarkMat = new THREE.MeshLambertMaterial({ color: stoneColorDark, flatShading: true });
    // 柱和墙一共只用两个色：体块一色 + 压顶石一色（比体块亮一档）。
    // 圆锥雪冠连同它那份 snowMat 一起删掉了（见 POST_H 上面的头注：雪冠是整套里
    // 最不"矩形"的一块，留着就谈不上柱墙风格统一）。
    // 上一版是 3 档深浅按坐标哈希随机错缝，那是在堆"垒砌纹理感"——正是用户要
    // 去掉的复杂度（"太复杂了不适配简洁风格"）。参考图里的墙也就是两个色。
    const wallBodyMat = new THREE.MeshLambertMaterial({ color: stoneColor, flatShading: true });
    const wallCapMat = new THREE.MeshLambertMaterial({
      color: SV.wallCapColor || new THREE.Color(stoneColor).lerp(new THREE.Color(0xffffff), 0.28),
      flatShading: true });

    const rubbleGeo = new THREE.IcosahedronGeometry(1, 0);
    for (const side of [map.frostBridge.left, map.frostBridge.right]) {
      // 柱子与墙共用同一对材质，这是"风格统一"最直接的一半（另一半是同样的压顶石构造）。
      this._buildPillarsAndTorches(group, side.pillars, wallBodyMat, wallCapMat);
      this._buildWallSegments(group, side, wallBodyMat, wallCapMat, stoneDarkMat, rubbleGeo);
    }

    // v55：陆地有厚度之后，水域装饰要**整体沉到深渊面那一层**。
    // 不沉的话浮冰会停在陆地高度，等于悬在水面上方 abyssDrop 那么高 ——
    // 近看是"冰块浮在半空"。设计文档 §8.2 的改动面第 3 条写的就是这一步。
    const waterGroup = new THREE.Group();
    waterGroup.position.y = -(map.terrainEdge?.abyssDrop ?? 0);
    group.add(waterGroup);
    this._buildWaterDecor(waterGroup, map, SV);
    this.setShadowLevel(this.shadowLevel);   // 新建的网格套用当前阴影档位
  }

  /**
   * 柱子（方柱 + 压顶石）+ 顶在柱子最上面的火盆。
   *
   * ==================== 与墙用同一套构造 ====================
   * 柱子＝ POST_W 见方的矩形体块 + 一块与墙板完全相同规格的压顶石（同高 CAP_H、
   * 同探出 CAP_OVERHANG、同材质）。跟墙板的差别只有尺寸：更高一截、更厚一圈。
   * 于是沿桥看过去就是【柱】【墙】【柱】【墙】的节奏，而不是两套形状拼在一起。
   *
   * ==================== 火盆的位置：三轮返工定下来的，不要再动 ====================
   * 用户先后否掉了"从墙面挑出支架挂火盆"和"火盆贴柱身侧面"两版，最终定的是
   * **摞在柱子最上面**（"火盆不是贴在柱子身上，而是顶在柱子的上面！！！！"）。
   * 这里只是把锚点从原来的圆锥雪冠换成了柱子的压顶石，火盆仍旧在柱子正上方、
   * 同一根竖直中轴线上，关系没有变。
   */
  _buildPillarsAndTorches(group, pillars, postMat, capMat) {
    const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_W);
    const postCapGeo = new THREE.BoxGeometry(
      POST_W + CAP_OVERHANG * 2, CAP_H, POST_W + CAP_OVERHANG * 2);
    const bowlGeo = new THREE.CylinderGeometry(BRAZIER_BOWL_R_TOP, BRAZIER_BOWL_R_BOT, BRAZIER_BOWL_H, 8);
    const flameOuterGeo = new THREE.ConeGeometry(3.6, TORCH_FLAME_H, 6);
    const flameInnerGeo = new THREE.ConeGeometry(1.8, TORCH_FLAME_H * 0.6, 5);
    const bowlMat = new THREE.MeshLambertMaterial({ color: 0x33383f, flatShading: true });
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff8a3d });
    const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });

    for (const p of pillars) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.copy(toScene(p.x, p.y, -2 + POST_H / 2));
      group.add(post);

      const capH = -2 + POST_H + CAP_H / 2;
      const cap = new THREE.Mesh(postCapGeo, capMat);
      cap.position.copy(toScene(p.x, p.y, capH));
      group.add(cap);

      const bowlH = capH + CAP_H / 2 + BRAZIER_BOWL_H / 2;
      const bowl = new THREE.Mesh(bowlGeo, bowlMat);
      bowl.position.copy(toScene(p.x, p.y, bowlH));
      group.add(bowl);

      const flameY = bowlH + BRAZIER_BOWL_H / 2 + TORCH_FLAME_H / 2 - 1;
      const flameOuter = new THREE.Mesh(flameOuterGeo, flameOuterMat);
      flameOuter.position.copy(toScene(p.x, p.y, flameY));
      group.add(flameOuter);
      const flameInner = new THREE.Mesh(flameInnerGeo, flameInnerMat);
      flameInner.position.copy(toScene(p.x, p.y, flameY - 1));
      group.add(flameInner);
    }
  }

  /**
   * 砌墙：每两根柱子之间**一根连续的墙体**，顶部一层压顶石按节奏排列、
   * 随机缺几块来表达风化侵蚀。
   *
   * ==================== 2026-09-05 第五轮：每跨一体，不再分块 ====================
   * 上一版把每段切成 n 块 BoxGeometry、按 3 档深浅色错缝排列，堆的是"一块块石头
   * 垒起来"的纹理感。用户看完 Thronefall 参考后否掉了这条路："目前的墙太复杂了
   * 不适配简洁风格""每个墙的除了用柱子分割之外，每一块都是一体的"。
   * 现在墙身是整根，柱子是唯一的分割点。
   *
   * ==================== 断口 vs 侵蚀：两回事，不要混 ====================
   * ① **断口**（整跨没有墙）：只发生在墙脚下真的没有桥的地方——全桥仅桥中段
   *    sign-1 侧那一处真凹口。判据见下面的 onBridge，与上一版完全一致，没有改。
   *    一段墙因此可能被凹口切成若干"跑段"(run)，每个 run 各自是一根连续墙体。
   * ② **侵蚀缺口**（顶边啃掉一块）：墙身依旧连续，只是顶上的压顶石缺了几块、
   *    高低不齐。用户在选项里明确选的是这一种，不是"整跨塌掉"。
   * 两者叠在一起就是"完好的地方墙是连续的、顶边被风啃过；真凹口那一处整段没有"。
   */
  _buildWallSegments(group, side, wallBodyMat, wallCapMat, stoneDarkMat, rubbleGeo) {
    const inward = side.inward || { x: 0, y: 0 };
    const probe = side.groundProbe || 0;
    // 这一点的墙脚下有没有桥（没注入 isWalkable 时按"有"算，退化成一条完整的墙）。
    const onBridge = (cx, cy) => !this._isWalkable
      || this._isWalkable(cx + inward.x * probe, cy + inward.y * probe);

    for (const seg of side.segments) {
      const ux = Math.cos(seg.angle), uy = Math.sin(seg.angle);
      const nx = -Math.sin(seg.angle), ny = Math.cos(seg.angle);
      const rotY = worldAngleToRotY(seg.angle);
      const at = (t) => ({ x: seg.from.x + ux * t, y: seg.from.y + uy * t });

      // 沿这一段扫出若干"脚下有桥"的连续区间（多数情况就是整段一个 run）。
      const runs = [];
      let open = null, lastRubbleT = -Infinity;
      for (let t = 0; t <= seg.len + 1e-6; t += WALL_RUN_STEP) {
        const p = at(Math.min(t, seg.len));
        if (onBridge(p.x, p.y)) {
          if (!open) open = { from: t, to: t }; else open.to = t;
        } else {
          if (open) { runs.push(open); open = null; }
          // 塌掉的那一段留瓦砾——按 WALL_RUBBLE_PITCH 稀疏地摆，不是每个采样点都摆。
          if (t - lastRubbleT >= WALL_RUBBLE_PITCH) {
            this._buildRubbleAt(group, p.x, p.y, stoneDarkMat, rubbleGeo);
            lastRubbleT = t;
          }
        }
      }
      if (open) runs.push(open);

      for (const run of runs) {
        // 端点吸到段首/段尾，保证墙与柱子严丝合缝（用户："柱子和墙是一体的"）。
        const a = run.from <= WALL_RUN_STEP ? 0 : run.from;
        const b = run.to >= seg.len - WALL_RUN_STEP ? seg.len : run.to;
        const len = b - a;
        if (len < WALL_CAP_PITCH * 0.5) continue;           // 太短的碎渣不摆，交给瓦砾表现
        const mid = at((a + b) / 2);

        // ① 墙身：整根一条，不分块。
        const body = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, WALL_THICK), wallBodyMat);
        body.position.copy(toScene(mid.x, mid.y, -2 + WALL_H / 2));
        body.rotation.y = rotY;
        group.add(body);

        // ② 压顶石：按 WALL_CAP_PITCH 的节奏排一层，按坐标哈希缺掉一部分（侵蚀），
        //    留下的也各自有一点高低差——顶边于是是啃过的，而不是一条直线。
        const capN = Math.max(1, Math.round(len / WALL_CAP_PITCH));
        const capLen = len / capN;
        for (let i = 0; i < capN; i++) {
          const c = at(a + capLen * (i + 0.5));
          if (hash(c.x, c.y) < WALL_EROSION_CHANCE) continue;              // 这一块被风化掉了
          // 长度取满 capLen、相邻块首尾相接：压顶因此是**连续**的一条，只有被
          // 风化掉的那几处才真的断开。上一版每块缩到 0.92 留出等间距的缝，再叠上
          // 逐块的高低抖动，顶边就成了一排碎块，读不出"一道墙"（用户原话）。
          const cap = new THREE.Mesh(new THREE.BoxGeometry(
            capLen, CAP_H, WALL_THICK + CAP_OVERHANG * 2), wallCapMat);
          cap.position.copy(toScene(c.x, c.y, -2 + WALL_H + CAP_H / 2));
          cap.rotation.y = rotY;
          group.add(cap);
        }

        // ③ 断口两端仅存的墙体补一点崩裂痕迹（用户早前明确要过："断掉的这两边
        //    的墙体会有损毁痕迹"）。只在真断口那一侧补，段首/段尾贴着柱子的不补。
        for (const [edgeT, isBreak] of [[a, run.from > WALL_RUN_STEP], [b, run.to < seg.len - WALL_RUN_STEP]]) {
          if (!isBreak) continue;
          const e = at(edgeT);
          this._buildWeatherChips(group, e.x, e.y, stoneDarkMat, rubbleGeo);
        }
      }
    }
  }

  /** 完好墙块紧贴缺口一侧的崩裂痕迹（不是缺口本身的瓦砾堆）。 */
  /**
   * ==================== 2026-09-05 用户反馈：路上还有穿模的东西 ====================
   * 真根因跟冰块那次不一样：这次不是冰块本身的摆放算法有洞，是瓦砾/崩块压根
   * 没查过 isWalkable——v0.6 把柱子/墙移到了真实边界上（"墙即边界"），意味着
   * 柱子周围随手一撒的瓦砾，有近一半的随机方向会撒到边界的可走一侧。以前
   * 柱子离边界还有 40~70 个单位的余量，撒偏了也摔不到路上；现在贴着边界，
   * 每一块瓦砾摆放前都必须单独查一次 isWalkable，查到就跳过这一块（宁可
   * 这簇瓦砾少一块，也不能有任何一块落在能走的地方——这跟冰块那边"绝不允许
   * 伸进桥面"是同一条底线，不是新规矩）。
   */
  _buildWeatherChips(group, x, y, stoneDarkMat, geo) {
    const n = 2 + Math.floor(hash(x, y) * 2);   // 2~3 块崩块，比缺口的瓦砾堆少
    for (let i = 0; i < n; i++) {
      const cx = x + (hash(x + i * 3, y) - 0.5) * 3;
      const cy = y + (hash(x, y + i * 3) - 0.5) * 3;
      if (this._isWalkable && this._isWalkable(cx, cy)) continue;   // 落在可走区域就跳过，不摆
      const s = 1.2 + hash(x + i, y - i) * 1.6;
      const chip = new THREE.Mesh(geo, stoneDarkMat);
      chip.position.copy(toScene(cx, cy, -2 + WALL_H * (0.25 + hash(x + i, y + i) * 0.55)));
      chip.scale.set(s, s, s);
      chip.rotation.y = hash(x + i * 5, y + i * 5) * Math.PI * 2;
      group.add(chip);
    }
  }

  /** 单点瓦砾堆：墙缺损处用，替代原来"每根柱子旁固定摆一堆"的做法。 */
  _buildRubbleAt(group, x, y, stoneDarkMat, geo) {
    const n = 3 + Math.floor(hash(x, y) * 3);   // 3~5 块瓦砾
    for (let i = 0; i < n; i++) {
      const a = hash(x + i * 7, y - i * 3) * Math.PI * 2;
      const dist = 3 + hash(x - i * 5, y + i * 11) * 9;
      const sx = x + Math.cos(a) * dist, sy = y + Math.sin(a) * dist;
      if (this._isWalkable && this._isWalkable(sx, sy)) continue;   // 落在可走区域就跳过，见头注
      const s = 2 + hash(x + i, y + i) * 3.2;
      const rock = new THREE.Mesh(geo, stoneDarkMat);
      rock.position.copy(toScene(sx, sy, -1 + s * 0.4));
      rock.scale.set(s, s * (0.6 + hash(sx, sy) * 0.5), s);
      rock.rotation.y = hash(sx + 3, sy + 3) * Math.PI * 2;
      group.add(rock);
    }
  }

  /**
   * 水域装饰：水面大部分是浮冰（大小接近格距、轻微咬合当裂纹），只有靠近桥
   * 的地方才偶尔露出水面碎冰；冰块绝不允许伸进桥面范围。
   *
   * ==================== 2026-09-04 用户反馈重做：冰面（第二轮） ====================
   * 第一轮改完用户看实机截图直接炸了："浮冰几乎覆盖了整个水面堆得乱七八糟的
   * 甚至还有穿模到桥里面的"，外加"路的颜色和冰的颜色要区分""水是灰色的，应该
   * 是更深的蓝色"。查下来是三个问题：
   *  ①真正的 bug——`CylinderGeometry(1,...)` 半径是 1，`mesh.scale.set(s,s,s)`
   *    里的 s 是**半径**不是直径，上一轮把 s 算成"接近 STEP 的值"（0.66~1.16
   *    倍 STEP），结果实际半径就有 125~220，直径 250~440，是格距 190 的
   *    1.3~2.3 倍——所有相邻块严重互相重叠，看着"乱七八糟"；而且判定"能不能摆"
   *    只查了块的中心点是否在桥上，块本身那么大，中心不在桥上、边缘早就伸进
   *    桥里了——这就是"穿模到桥里面"的真正原因。这次把 s 直接当半径来算
   *    （目标半径 ≈ STEP/2 的 0.75~1.0 倍，只留轻微咬合），并且不再只查中心点，
   *    改成中心+四个方向的边缘采样点全部不在桥上才摆（IceMargin 系列）。
   *  ②颜色可读性——`iceMatA/B`（#dfeaf0/#c9dee8）跟雪覆盖的桥面色
   *    （frost 调色板 corridorColor #eef4f8）几乎是同一个色，冰和路天然分不清；
   *    水色 #1c3946 太暗，在当前场景光照下读成灰黑而不是蓝。这次冰色明显往
   *    饱和的冰蓝方向调（不再贴近雪白），水色换成更亮更饱和的中蓝，跟桥面的
   *    雪白/冰的浅蓝/水的中蓝三级拉开可读的色差。
   */
  _buildWaterDecor(group, map, SV) {
    // 颜色全部走调色板（第 2 条铁律：不硬编码），改一处即可整张图统一换色。
    const iceMatA = new THREE.MeshLambertMaterial({ color: SV.iceColorA || '#8ab4d4', flatShading: true });
    const iceMatB = new THREE.MeshLambertMaterial({ color: SV.iceColorB || '#77a2c4', flatShading: true }); // 邻块用不同色阶，边界当裂纹
    const waterMat = new THREE.MeshLambertMaterial({ color: SV.waterColor || '#2a5f8f', flatShading: true }); // 裸露水面，比冰暗、比深渊基底亮
    // 冰面不用二十面体：subdivision-0 的二十面体只有 20 个朝向各异的三角面，
    // 就算把高度压扁也没有一块"正对着镜头的平顶"，斜射光下每块小面都单独明暗，
    // 看着像碎石堆/山地而不是一整块平铺的冰。改用矮圆柱（真正有一个水平顶面）：
    // 每个格子的随机旋转 + 7 边形轮廓，顶面在俯视下就是块不规则的平冰。
    // ⚠️ CylinderGeometry(1,...) 半径是 1——下面所有 mesh.scale.set(r,...) 里的
    // r 都是"目标半径"，不是直径，别再算错成两倍大。
    const iceGeo = new THREE.CylinderGeometry(1, 0.92, 0.16, 7, 1);
    const shardGeo = new THREE.CylinderGeometry(1, 0.85, 0.22, 6, 1);
    // 用 ThreeRenderer 注入的 isWalkable（见 setWalkableFn）避开桥面；没注入时
    // 保守地整段跳过散布，宁可这次不摆冰，也不摆错在桥上挡视线。
    const canPlace = this._isWalkable;
    if (!canPlace) return;
    // 判"这块冰的整个圆形范围是否完全落在不可走区域"，不是只查几个采样点。
    // ==================== 2026-09-05 用户反馈（第二轮）：红蓝方水晶塔那边还是有冰 ====================
    // 上一轮把"只查中心点"改成"查 8 个方向的边缘点"，在笔直的桥身段上够用，
    // 但两个基地附近的可走区域是"桥身 + 圆形基地圈"融合出来的形状，边界在
    // 那里是**弯的**——弯曲的边界完全可能从两个相邻采样方向之间的空隙"钻"
    // 进冰块范围，8 个点覆盖不到所有弯曲情况。改成整圆网格采样：以
    // `r*0.4` 为格距在冰块的外接正方形里打网格，只保留落在圆内的格点，
    // 要求这些点全部不可走才摆放——网格足够密时不再有遗漏的"缝隙"。
    const clearOfBridge = (x, y, r) => {
      const step = Math.max(6, r * 0.4);
      for (let dx = -r; dx <= r + 1e-6; dx += step) {
        for (let dy = -r; dy <= r + 1e-6; dy += step) {
          if (dx * dx + dy * dy > r * r) continue;
          if (canPlace(x + dx, y + dy)) return false;
        }
      }
      return true;
    };

    const bridgePts = [...map.frostBridge.left.pillars, ...map.frostBridge.right.pillars];
    const distToBridge = (x, y) => {
      let m = Infinity;
      for (const p of bridgePts) { const d = Math.hypot(x - p.x, y - p.y); if (d < m) m = d; }
      return m;
    };
    const WATER_NEAR_BRIDGE_R = 260;   // 这个半径内才有机会露水，见头注
    const WATER_EXPOSE_CHANCE = 0.32;  // "偶尔"——不是靠近桥就一定露水
    const ICE_FILL_CHANCE = 0.42;      // 非靠桥区域摆平浮冰的概率——0.58→0.42，给第一档的冰脊让出空间

    // ==================== 第一档：冰脊（成坨的"山"）====================
    // 稀疏布点，每个点长一坨（若干块平顶多边形互相叠着），只长在离桥足够远的地方。
    const spikeMat = new THREE.MeshLambertMaterial({ color: SV.spikeColor || '#b9d5e6', flatShading: true });
    const slabGeo = new THREE.CylinderGeometry(1, 0.88, 1, 6, 1);   // 6 边平顶块，高度靠 scale 给
    const spikeGeo = new THREE.ConeGeometry(1, 1, 5);               // 5 棱锥，细高的冰刺
    const rnd = (h, [lo, hi]) => lo + h * (hi - lo);
    const ridges = [];                                              // 记下冰脊占位，平浮冰要避开
    const { w: WW, h: WH } = map.world;

    for (let gx = 120; gx < WW - 120; gx += RIDGE_STEP) {
      for (let gy = 120; gy < WH - 120; gy += RIDGE_STEP) {
        if (hash(gx + 31, gy + 31) > RIDGE_CHANCE) continue;
        const cx = gx + (hash(gx + 5, gy) - 0.5) * RIDGE_STEP * 0.5;
        const cy = gy + (hash(gx, gy + 5) - 0.5) * RIDGE_STEP * 0.5;
        if (distToBridge(cx, cy) < RIDGE_MIN_DIST) continue;

        const slabN = Math.round(rnd(hash(cx + 2, cy + 2), RIDGE_SLABS));
        const placed = [];
        for (let i = 0; i < slabN; i++) {
          const a = hash(cx + i * 11, cy - i * 7) * Math.PI * 2;
          const off = hash(cx - i * 3, cy + i * 9) * RIDGE_R[0];
          const sx = cx + Math.cos(a) * off, sy = cy + Math.sin(a) * off;
          const r = rnd(hash(sx, sy), RIDGE_R);
          if (!clearOfBridge(sx, sy, r)) continue;
          const h = rnd(hash(sx + 1, sy - 1), RIDGE_H);
          // 不规则轮廓 + 两轴不等比拉长：这两件事一起做，冰原才不像一地硬币。
          const ex = 0.62 + hash(sx + 8, sy) * 0.85, ez = 0.62 + hash(sx, sy + 8) * 0.85;
          const slab = new THREE.Mesh(
            icePrismGeo(6 + Math.floor(hash(sx + 4, sy + 4) * 3), Math.round(sx + sy)),
            hash(sx + 5, sy + 5) < 0.5 ? iceMatA : iceMatB);
          slab.position.copy(toScene(sx, sy, h / 2));
          slab.scale.set(r * ex, h, r * ez);
          slab.rotation.y = hash(sx + 2, sy + 2) * Math.PI * 2;
          group.add(slab);
          placed.push({ x: sx, y: sy, r, h });
        }
        if (!placed.length) continue;
        ridges.push({ x: cx, y: cy, r: RIDGE_R[1] });

        // 冰刺：插在刚摆下的那些平顶块上，底部埋进块里一点，不会看到浮空的锥底。
        const spikeN = Math.round(rnd(hash(cx + 4, cy + 4), SPIKE_PER_RIDGE));
        for (let i = 0; i < spikeN; i++) {
          const base = placed[Math.floor(hash(cx + i * 13, cy + i * 5) * placed.length) % placed.length];
          const a = hash(cx + i * 17, cy - i * 11) * Math.PI * 2;
          // 往块中心聚（乘方压低外圈概率），成丛而不是均匀撒一圈。
          const off = Math.pow(hash(cx - i * 5, cy + i * 3), 1.6) * base.r * 0.8;
          const sx = base.x + Math.cos(a) * off, sy = base.y + Math.sin(a) * off;
          const r = rnd(hash(sx + 3, sy + 3), SPIKE_R);
          if (!clearOfBridge(sx, sy, r)) continue;
          const h = rnd(hash(sx - 3, sy - 3), SPIKE_H);
          const spike = new THREE.Mesh(spikeGeo, spikeMat);
          spike.position.copy(toScene(sx, sy, base.h - 2 + h / 2));
          spike.scale.set(r, h, r);
          spike.rotation.y = hash(sx + 7, sy + 7) * Math.PI * 2;
          group.add(spike);
        }
      }
    }
    const onRidge = (x, y) => ridges.some((g) => Math.hypot(x - g.x, y - g.y) < g.r);

    // ==================== 第二/三档：平浮冰 + 靠桥处偶尔露水 ====================
    const STEP = 190, edge = 90;
    for (let gx = edge; gx < WW - edge; gx += STEP) {
      for (let gy = edge; gy < WH - edge; gy += STEP) {
        const x = gx + (hash(gx + 3, gy) - 0.5) * STEP * 0.3;
        const y = gy + (hash(gx, gy + 3) - 0.5) * STEP * 0.3;
        if (onRidge(x, y)) continue;                 // 冰脊底下不再叠平浮冰

        const nearBridge = distToBridge(x, y) <= WATER_NEAR_BRIDGE_R;
        if (nearBridge && hash(gx + 9, gy + 9) < WATER_EXPOSE_CHANCE) {
          const r = 12 + hash(x, y) * 10;   // 半径，不是直径
          if (!clearOfBridge(x, y, r)) continue;
          const water = new THREE.Mesh(iceGeo, waterMat);
          water.position.copy(toScene(x, y, 0.2));
          water.scale.set(r, r * 0.3, r);
          group.add(water);
          const shardN = 2 + Math.floor(hash(x + 1, y + 1) * 3);
          for (let i = 0; i < shardN; i++) {
            const a = hash(x + i * 7, y - i * 3) * Math.PI * 2;
            const dist = r * 0.9 + hash(x - i, y + i) * r * 0.7;
            const sx = x + Math.cos(a) * dist, sy = y + Math.sin(a) * dist;
            const sr = 3 + hash(sx, sy) * 4;
            if (!clearOfBridge(sx, sy, sr)) continue;
            const shard = new THREE.Mesh(shardGeo, iceMatA);
            shard.position.copy(toScene(sx, sy, 0.7));
            shard.scale.set(sr, sr * 0.35, sr);
            shard.rotation.y = hash(sx + 2, sy + 2) * Math.PI * 2;
            group.add(shard);
          }
          continue;
        }

        // 平浮冰：半径范围拉大（0.38~0.98 倍格半距，上一版是 0.72~0.98），
        // 大小差别明显了才不像一张瓷砖贴图；密度也降下来给冰脊让位。
        if (hash(gx + 7, gy + 7) > ICE_FILL_CHANCE) continue;
        const r = (STEP / 2) * (0.38 + hash(x, y) * 0.6);
        if (!clearOfBridge(x, y, r)) continue;
        const mat = hash(x + 5, y + 5) < 0.5 ? iceMatA : iceMatB;
        const ex = 0.6 + hash(x + 8, y) * 0.9, ez = 0.6 + hash(x, y + 8) * 0.9;
        const ice = new THREE.Mesh(
          icePrismGeo(6 + Math.floor(hash(x + 4, y + 4) * 3), Math.round(x + y * 3)), mat);
        ice.position.copy(toScene(x, y, 0.5));
        ice.scale.set(r * ex, r * 0.9, r * ez);
        ice.rotation.y = hash(x + 1, y + 1) * Math.PI * 2;
        group.add(ice);
      }
    }

    this._buildSpiritIslands(group, SV);
  }

  /**
   * 孤灵小岛：只放 2 座（用户拍板"1~2个"），幽灵/亡灵主题——墓碑+幽蓝鬼火+灵魂光点。
   *
   * ==================== 2026-09-05 用户反馈：路上还有穿模的东西 ====================
   * 原来的两个坐标 (700,1650)/(1650,700) 是"手动挑的、估计离桥有余量"——实际算下来
   * 离桥中线只有约 18 个世界单位，压根就在桥面正中间，从一开始就是错的（v0.6
   * 拓宽桥面之前凑巧没被拆穿，因为窄桥+这两点又跟某个格子的采样点没对上）。
   * 这次不再手动猜坐标，直接在新 navgrid 上量出两块半径 75（岛屿本体 64 + 安全
   * 余量）范围内全部不可走的开阔水域，两侧各挑一块。
   */
  _buildSpiritIslands(group, SV = {}) {
    const spots = [
      { x: 550, y: 1250 },
      { x: 1775, y: 1075 },
    ];
    const islandMat = new THREE.MeshLambertMaterial({ color: '#4c6270', flatShading: true });
    const snowMat = new THREE.MeshLambertMaterial({ color: SV.islandColor || '#c8dcea', flatShading: true });
    const graveMat = new THREE.MeshLambertMaterial({ color: '#5a6570', flatShading: true });
    const wispMat = new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.85 });

    for (const spot of spots) {
      const baseGeo = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.4, 1);
      const base = new THREE.Mesh(baseGeo, islandMat);
      base.position.copy(toScene(spot.x, spot.y, 3));
      base.scale.set(64, 22, 64);
      group.add(base);
      const cap = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0).scale(1, 0.22, 1), snowMat);
      cap.position.copy(toScene(spot.x, spot.y, 10));
      cap.scale.set(58, 10, 58);
      group.add(cap);

      // 2~3 座墓碑：薄片 Box，微微倾斜。
      const graveGeo = new THREE.BoxGeometry(6, 16, 2);
      const graveCount = 2 + Math.floor(hash(spot.x, spot.y) * 2);
      for (let i = 0; i < graveCount; i++) {
        const a = hash(spot.x + i * 17, spot.y - i * 5) * Math.PI * 2;
        const dist = 12 + hash(spot.x - i, spot.y + i) * 24;
        const gx = spot.x + Math.cos(a) * dist, gy = spot.y + Math.sin(a) * dist;
        const grave = new THREE.Mesh(graveGeo, graveMat);
        grave.position.copy(toScene(gx, gy, 8 + 8));
        grave.rotation.y = a;
        grave.rotation.z = (hash(gx, gy) - 0.5) * 0.35;   // 歪斜，荒废感
        group.add(grave);
      }

      // 幽蓝鬼火 + 飘散灵魂光点：不用粒子系统，几个小型发光 Mesh 代替。
      const wispGeo = new THREE.IcosahedronGeometry(1, 0);
      const wispCount = 3 + Math.floor(hash(spot.x + 5, spot.y + 5) * 3);
      for (let i = 0; i < wispCount; i++) {
        const a = hash(spot.x + i * 23, spot.y + i * 7) * Math.PI * 2;
        const dist = 8 + hash(spot.x + i, spot.y - i) * 34;
        const wx = spot.x + Math.cos(a) * dist, wy = spot.y + Math.sin(a) * dist;
        const wh = 14 + hash(wx, wy) * 22;
        const wisp = new THREE.Mesh(wispGeo, wispMat);
        wisp.position.copy(toScene(wx, wy, wh));
        const s = 2 + hash(wx + 2, wy + 2) * 2.4;
        wisp.scale.set(s, s, s);
        group.add(wisp);
      }
    }
  }

  /** ThreeRenderer 注入的 isWalkable 判定（浮冰摆放要避开桥面），见调用方。 */
  setWalkableFn(fn) { this._isWalkable = fn; }
}
