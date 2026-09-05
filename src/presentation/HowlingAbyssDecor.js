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

const PILLAR_H = 46, PILLAR_R_TOP = 9, PILLAR_R_BOT = 12;
// ==================== 2026-09-05 用户反馈重做：火炬（两轮） ====================
// 第一轮是"柱子顶端插一根杆子+火苗"，用户原话："应该是火盆承载着火焰在石墙上"。
// 改成"支架从墙面探出+火盆"后，支架起点算错（离柱心太近，糊在柱子雪冠上）+
// 用户看完直接否掉了"挑出去"这个思路："那个火盆应该就是在原来的柱子上，
// 不要挂着！"——现在是第三版：火盆直接贴住柱身表面，中间没有支架，
// 见 _buildPillarsAndTorches 方法头注。
const BRAZIER_BOWL_R_TOP = 5.6, BRAZIER_BOWL_R_BOT = 3.8, BRAZIER_BOWL_H = 4.4;
const TORCH_FLAME_H = 10;

// ==================== 2026-09-04 用户反馈重做：石墙 ====================
// 第一版是"两根柱子中间摆一个两端内缩的长方体"——用户原话："我看起来就是个
// 雷霆方块吧？"（雷霆方块＝第 4.3 节里那种统一抬高的岩壁台地，正是这条风格化
// 路线一开始就要摆脱的东西）。问题有三个：①端头内缩造出的缝看着像"没接上"，
// 不是"缺损"；②单个光滑长方体没有"一块块石头垒起来"的纹理感；③太厚太满。
// 重做成"分块砌墙"：每段墙按 WALL_BLOCK_LEN 切成若干石块（不是一整根），
// 主体一层 + 顶部一层收窄的"压顶石"错缝排列（真实砌墙的收边做法）。缺损位置
// 后来又按用户反馈从"段中间随机一块"改成"贴着柱子（=桥本来的缺口）的那一块"，
// 见 _buildWallSegments 方法头注的完整说明。
const WALL_H = 26, WALL_THICK = 13;          // 用户："厚度减少一些"——22→13
const WALL_CAP_H = 7, WALL_CAP_INSET = 2.5;  // 压顶石：更矮更窄，收边观感
const WALL_BLOCK_LEN = 20;                   // 每块石头的目标长度（实际按段长整除微调）
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
// 不断、与柱子严丝合缝——用户这一轮同时要求"柱子和墙是一体的"，而"一体"和
// "缺口处断开"在这套判据下不再矛盾：不需要为了做出断口而在柱子旁边硬拆砖。
//
// 判据用的两样东西都由地图数据给（`map.frostBridge.left/right`）：`inward`
// 指向桥内侧的单位法向，`groundProbe` 是往内侧探多远采样——不能直接采墙块
// 中心点，因为可走区域正好收到墙线上（见 howling_abyss_frost.js 头注④），
// 中心点落在边界格上，结果会随取整方向抖动。
const WALL_STONE_SHADES = 3;                 // 石块用几种深浅色，垒砌感靠这个，不是纹理贴图

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
    const snowCapColor = 0xf3f8fb;

    const group = new THREE.Group();
    this.group = group;
    this.scene.add(group);

    const stoneMat = new THREE.MeshLambertMaterial({ color: stoneColor, flatShading: true });
    const stoneDarkMat = new THREE.MeshLambertMaterial({ color: stoneColorDark, flatShading: true });
    const snowMat = new THREE.MeshLambertMaterial({ color: snowCapColor, flatShading: true });
    // 石块深浅色阶（垒砌感的主要来源，见 WALL_STONE_SHADES 头注）——每种色阶单独
    // 一份材质，同一石块几何体在不同 Mesh 间共享，不逐块新建材质（省内存/draw call）。
    const stoneShadeMats = Array.from({ length: WALL_STONE_SHADES }, (_, i) => {
      const t = WALL_STONE_SHADES > 1 ? i / (WALL_STONE_SHADES - 1) : 0;
      const c = new THREE.Color(stoneColor).lerp(new THREE.Color(stoneColorDark), t * 0.85);
      return new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    });

    const rubbleGeo = new THREE.IcosahedronGeometry(1, 0);
    for (const side of [map.frostBridge.left, map.frostBridge.right]) {
      this._buildPillarsAndTorches(group, side.pillars, stoneMat, snowMat);
      this._buildWallSegments(group, side, stoneShadeMats, stoneDarkMat, rubbleGeo);
    }

    this._buildWaterDecor(group, map, SV);
    this.setShadowLevel(this.shadowLevel);   // 新建的网格套用当前阴影档位
  }

  /**
   * 柱子 + 顶在柱子最上面的火盆（不贴柱身侧面，也不用支架）。
   *
   * ==================== 2026-09-05 用户反馈（第三轮）：顶在柱子上面，不是贴在侧面 ====================
   * 上一版把火盆贴到了柱身侧面（偏上方、雪冠下面）。用户明确否掉："火盆不是
   * 贴在柱子身上，而是顶在柱子的上面！！！！"——即摞在柱顶，跟雪冠同一根竖直
   * 中轴线上，不做任何侧向偏移。现在顺序是：柱身 → 雪冠 → 火盆 → 火焰，
   * 全部摞在 (p.x, p.y) 这条竖直线上。
   */
  _buildPillarsAndTorches(group, pillars, stoneMat, snowMat) {
    const pillarGeo = new THREE.CylinderGeometry(PILLAR_R_TOP, PILLAR_R_BOT, PILLAR_H, 6);
    const capGeo = new THREE.ConeGeometry(PILLAR_R_TOP * 1.15, 6, 6);
    const bowlGeo = new THREE.CylinderGeometry(BRAZIER_BOWL_R_TOP, BRAZIER_BOWL_R_BOT, BRAZIER_BOWL_H, 8);
    const flameOuterGeo = new THREE.ConeGeometry(3.6, TORCH_FLAME_H, 6);
    const flameInnerGeo = new THREE.ConeGeometry(1.8, TORCH_FLAME_H * 0.6, 5);
    const bowlMat = new THREE.MeshLambertMaterial({ color: 0x33383f, flatShading: true });
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff8a3d });
    const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });

    for (let i = 0; i < pillars.length; i++) {
      const p = pillars[i];
      const pillar = new THREE.Mesh(pillarGeo, stoneMat);
      pillar.position.copy(toScene(p.x, p.y, -2 + PILLAR_H / 2));
      group.add(pillar);

      const capH = -2 + PILLAR_H + 2;
      const cap = new THREE.Mesh(capGeo, snowMat);
      cap.position.copy(toScene(p.x, p.y, capH));
      group.add(cap);

      const bowlH = capH + 4 + BRAZIER_BOWL_H / 2;
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
   * 分块砌墙：每段墙（两根柱子之间）按 WALL_BLOCK_LEN 切成 n 块石头。
   *
   * ==================== 2026-09-05 用户反馈第四轮：断口由地形决定 ====================
   * 缺损位置的判据经历了三次错误的迭代（段中间随机一块 → 贴着柱子的一块 →
   * 每根柱子必断两块），根子上都错在同一个前提：以为桥上有 13 处缺口。
   * 实际全桥只有一处真凹口（见文件头 WALL_GAP_CHANCE 那段被删掉的常量的头注）。
   *
   * 现在的规则只有一句：**逐块查这块墙脚下有没有桥，没有就不摆这块**。
   *   · 采样点不取墙块中心，而是从中心沿 `inward` 往桥内侧探 `groundProbe`——
   *     可走区域正好收到墙线上，中心点落在边界格上，取整方向一变结果就抖。
   *   · 判不到 isWalkable（渲染器没注入）时一律按"有桥"处理，退化成一条完整
   *     的墙，不会因为缺少地形信息就把墙拆得七零八落。
   * 于是断口出现在且只出现在真凹口上方，其余地方墙连续、与柱子严丝合缝，
   * 满足用户这一轮的两条要求（"缺口那里断掉" + "柱子和墙是一体的"）。
   * 断口两端仅存的那块完好砖照旧补崩裂痕迹（_buildWeatherChips），断口本身
   * 摆瓦砾（_buildRubbleAt，其内部也各自查过 isWalkable，不会掉到桥面上）。
   */
  _buildWallSegments(group, side, stoneShadeMats, stoneDarkMat, rubbleGeo) {
    const capMat = stoneShadeMats[stoneShadeMats.length - 1];
    const inward = side.inward || { x: 0, y: 0 };
    const probe = side.groundProbe || 0;
    // 这块墙脚下有没有桥（没注入 isWalkable 时按"有"算，见方法头注）。
    const onBridge = (cx, cy) => !this._isWalkable
      || this._isWalkable(cx + inward.x * probe, cy + inward.y * probe);

    for (const seg of side.segments) {
      const n = Math.max(2, Math.round(seg.len / WALL_BLOCK_LEN));
      const blockLen = seg.len / n;
      const ux = Math.cos(seg.angle), uy = Math.sin(seg.angle);
      const nx = -Math.sin(seg.angle), ny = Math.cos(seg.angle);
      // 先把整段的"脚下有没有桥"一次算完：后面补崩裂痕迹要知道自己是不是紧挨着断口。
      const solid = [];
      for (let i = 0; i < n; i++) {
        solid.push(onBridge(seg.from.x + ux * blockLen * (i + 0.5),
                            seg.from.y + uy * blockLen * (i + 0.5)));
      }

      for (let i = 0; i < n; i++) {
        const cx = seg.from.x + ux * blockLen * (i + 0.5);
        const cy = seg.from.y + uy * blockLen * (i + 0.5);

        if (!solid[i]) {                       // 脚下没桥：这块墙塌了，只留瓦砾
          this._buildRubbleAt(group, cx, cy, stoneDarkMat, rubbleGeo);
          continue;
        }

        const shade = stoneShadeMats[Math.floor(hash(cx, cy) * stoneShadeMats.length) % stoneShadeMats.length];
        const bodyGeo = new THREE.BoxGeometry(blockLen * 0.94, WALL_H, WALL_THICK);
        const body = new THREE.Mesh(bodyGeo, shade);
        body.position.copy(toScene(cx, cy, -2 + WALL_H / 2));
        body.rotation.y = worldAngleToRotY(seg.angle);
        group.add(body);

        // 压顶石：奇偶块左右交替错缝，比主体窄一圈，制造"一层层垒起来"的观感。
        const capOffset = (i % 2 === 0 ? 1 : -1) * WALL_CAP_INSET * 0.3;
        const capGeo = new THREE.BoxGeometry(
          Math.max(2, blockLen * 0.94 - WALL_CAP_INSET), WALL_CAP_H, Math.max(2, WALL_THICK - WALL_CAP_INSET));
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.copy(toScene(cx + nx * capOffset, cy + ny * capOffset, -2 + WALL_H + WALL_CAP_H / 2));
        cap.rotation.y = worldAngleToRotY(seg.angle);
        group.add(cap);

        // 用户反馈："断掉的这两边的墙体会有损毁痕迹"——紧贴断口的那块完好砖，
        // 朝断口那一侧的边缘嵌几块崩块，跟断口处地上的瓦砾堆（_buildRubbleAt）
        // 区分开：那是"塌掉的石头"，这是"没塌但被震裂"的痕迹。
        const gapBefore = i > 0 && !solid[i - 1];
        const gapAfter = i < n - 1 && !solid[i + 1];
        if (gapBefore || gapAfter) {
          const edgeSign = gapBefore ? -1 : 1;
          const ex = cx + ux * edgeSign * (blockLen * 0.94 / 2 - 1.5);
          const ey = cy + uy * edgeSign * (blockLen * 0.94 / 2 - 1.5);
          this._buildWeatherChips(group, ex, ey, stoneDarkMat, rubbleGeo);
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
    const iceMatA = new THREE.MeshLambertMaterial({ color: '#7fb2cc', flatShading: true });
    const iceMatB = new THREE.MeshLambertMaterial({ color: '#5f9ab8', flatShading: true }); // 邻块用不同色阶，边界当裂纹
    const waterMat = new THREE.MeshLambertMaterial({ color: '#1f6f95', flatShading: true }); // 裸露水面，明显的中蓝色，不是灰黑
    // 冰面不用二十面体：subdivision-0 的二十面体只有 20 个朝向各异的三角面，
    // 就算把高度压扁也没有一块"正对着镜头的平顶"，斜射光下每块小面都单独明暗，
    // 看着像碎石堆/山地而不是一整块平铺的冰。改用矮圆柱（真正有一个水平顶面）：
    // 每个格子的随机旋转 + 7 边形轮廓，顶面在俯视下就是块不规则的平冰。
    // ⚠️ CylinderGeometry(1,...) 半径是 1——下面所有 mesh.scale.set(r,...) 里的
    // r 都是"目标半径"，不是直径，别再算错成两倍大。
    const iceGeo = new THREE.CylinderGeometry(1, 0.92, 0.16, 7, 1);
    const shardGeo = new THREE.CylinderGeometry(1, 0.85, 0.22, 6, 1);
    const { w: WW, h: WH } = map.world;
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
    const ICE_FILL_CHANCE = 0.58;      // 非靠桥区域摆冰的概率，留出可见水面（不是铺满）

    const STEP = 190, edge = 90;
    for (let gx = edge; gx < WW - edge; gx += STEP) {
      for (let gy = edge; gy < WH - edge; gy += STEP) {
        const x = gx + (hash(gx + 3, gy) - 0.5) * STEP * 0.3;
        const y = gy + (hash(gx, gy + 3) - 0.5) * STEP * 0.3;

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

        // 常规冰块：半径略小于格距一半，相邻块只轻微咬合（不再是 2 倍暴涨的重叠）。
        // ICE_FILL_CHANCE 故意不是 1——参考图里装饰物是"疏落的强调色块"，不是铺满，
        // 留出的空格直接露出底下的水色（groundColor），读成"水面上飘着冰"而不是
        // "一整块看不出下面是水的白毯子"。
        if (hash(gx + 7, gy + 7) > ICE_FILL_CHANCE) continue;
        const r = (STEP / 2) * (0.72 + hash(x, y) * 0.26);
        if (!clearOfBridge(x, y, r)) continue;
        const mat = hash(x + 5, y + 5) < 0.5 ? iceMatA : iceMatB;
        const ice = new THREE.Mesh(iceGeo, mat);
        ice.position.copy(toScene(x, y, 0.5));
        ice.scale.set(r, r, r);
        ice.rotation.y = hash(x + 1, y + 1) * Math.PI * 2;
        group.add(ice);
      }
    }

    this._buildSpiritIslands(group);
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
  _buildSpiritIslands(group) {
    const spots = [
      { x: 550, y: 1250 },
      { x: 1775, y: 1075 },
    ];
    const islandMat = new THREE.MeshLambertMaterial({ color: '#4c6270', flatShading: true });
    const snowMat = new THREE.MeshLambertMaterial({ color: '#e7eff4', flatShading: true });
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
