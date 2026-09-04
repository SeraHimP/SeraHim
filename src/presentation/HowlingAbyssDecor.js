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
const TORCH_POLE_H = 14, TORCH_FLAME_H = 12;

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
// 每个"缺口"（=柱子位置，见 _buildWallSegments 头注）旁边的墙块损毁的概率——
// 用户要求缺损必须对应桥本来就有的缺口位置，这条概率只决定"这处缺口是否
// 表现出损毁"，不再是随机挑段中间某块（那是上一版的错误做法）。
const WALL_GAP_CHANCE = 0.55;
const WALL_STONE_SHADES = 3;                 // 石块用几种深浅色，垒砌感靠这个，不是纹理贴图

export class HowlingAbyssDecor {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
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
      this._buildWallSegments(group, side.segments, stoneShadeMats, stoneDarkMat, rubbleGeo);
    }

    this._buildWaterDecor(group, map, SV);
  }

  _buildPillarsAndTorches(group, pillars, stoneMat, snowMat) {
    const pillarGeo = new THREE.CylinderGeometry(PILLAR_R_TOP, PILLAR_R_BOT, PILLAR_H, 6);
    const capGeo = new THREE.ConeGeometry(PILLAR_R_TOP * 1.15, 6, 6);
    const poleGeo = new THREE.CylinderGeometry(1.6, 1.8, TORCH_POLE_H, 5);
    const flameOuterGeo = new THREE.ConeGeometry(4.4, TORCH_FLAME_H, 6);
    const flameInnerGeo = new THREE.ConeGeometry(2.2, TORCH_FLAME_H * 0.65, 5);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff8a3d });
    const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });

    for (const p of pillars) {
      const pillar = new THREE.Mesh(pillarGeo, stoneMat);
      pillar.position.copy(toScene(p.x, p.y, -2 + PILLAR_H / 2));
      group.add(pillar);

      const cap = new THREE.Mesh(capGeo, snowMat);
      cap.position.copy(toScene(p.x, p.y, -2 + PILLAR_H + 2));
      group.add(cap);

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(toScene(p.x, p.y, -2 + PILLAR_H + 4 + TORCH_POLE_H / 2));
      group.add(pole);

      const flameY = -2 + PILLAR_H + 4 + TORCH_POLE_H + TORCH_FLAME_H / 2;
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
   * ==================== 2026-09-04 用户反馈重做：缺损位置要对应桥的缺口 ====================
   * 上一版缺损块是"整段墙里随机挑一块中间的"，跟桥面本来就有的 13×2 处缺口
   * （`HA_TERRAIN.obstacles`，桥在这些弧长位置本来就变窄）完全没关系，两处
   * 缺损各画各的，看着不像同一次损毁。用户原话（带四个感叹号）："桥中间那里
   * 的缺口，对应的那块的墙也要损毁"——柱子的位置本来就是这 13 个缺口弧长，
   * 所以正确的做法是：**贴着柱子的那一块墙**才是要损毁的块，不是段中间随便
   * 一块。这也是设计文档 v0.2 原本就定好的方案（"豁口本身落在柱子的位置上，
   * 柱子还立着、柱子两侧的墙/桥面塌了一块"）——上一版重做分块墙时为了解决
   * "墙接不上柱子"的问题把首尾块改成"必须画"，结果连带把缺损位置也一起挪没了，
   * 这次把"必须贴住柱子"和"缺损在哪"两件事分开处理：块的位置永远贴到底
   * （不留几何缝隙），但贴着柱子的那一块用瓦砾代替石块本体——缺损和"贴住"
   * 并不矛盾，瓦砾堆本身就摆在贴着柱子的位置上，不会显得断开。
   * 每段墙两端都紧邻一根柱子（=一个缺口），所以两端各自独立判定是否损毁；
   * 段太短（n<3）时只留一端损毁，否则整段墙可能一块实体都不剩。
   */
  _buildWallSegments(group, segments, stoneShadeMats, stoneDarkMat, rubbleGeo) {
    const capMat = stoneShadeMats[stoneShadeMats.length - 1];
    for (const seg of segments) {
      const n = Math.max(2, Math.round(seg.len / WALL_BLOCK_LEN));
      const blockLen = seg.len / n;
      const ux = Math.cos(seg.angle), uy = Math.sin(seg.angle);
      const nx = -Math.sin(seg.angle), ny = Math.cos(seg.angle);
      // 两端各自对应一个缺口（柱子位置）：按该端柱子坐标独立掷概率，不是整段共用一个判定。
      const gapAtStart = hash(seg.from.x, seg.from.y) < WALL_GAP_CHANCE;
      const gapAtEnd = n >= 3 && hash(seg.to.x, seg.to.y) < WALL_GAP_CHANCE;

      for (let i = 0; i < n; i++) {
        const cx = seg.from.x + ux * blockLen * (i + 0.5);
        const cy = seg.from.y + uy * blockLen * (i + 0.5);

        if ((i === 0 && gapAtStart) || (i === n - 1 && gapAtEnd)) {
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
      }
    }
  }

  /** 单点瓦砾堆：墙缺损处用，替代原来"每根柱子旁固定摆一堆"的做法。 */
  _buildRubbleAt(group, x, y, stoneDarkMat, geo) {
    const n = 3 + Math.floor(hash(x, y) * 3);   // 3~5 块瓦砾
    for (let i = 0; i < n; i++) {
      const a = hash(x + i * 7, y - i * 3) * Math.PI * 2;
      const dist = 3 + hash(x - i * 5, y + i * 11) * 9;
      const sx = x + Math.cos(a) * dist, sy = y + Math.sin(a) * dist;
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
    // 中心 + 四个方向的边缘采样点都不能落在桥上，避免大块冰的边缘"穿模"进桥面
    // （只查中心点是上一轮出问题的根源，见头注①）。
    const clearOfBridge = (x, y, r) =>
      !canPlace(x, y) && !canPlace(x + r, y) && !canPlace(x - r, y) && !canPlace(x, y + r) && !canPlace(x, y - r);

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

  /** 孤灵小岛：只放 2 座（用户拍板"1~2个"），幽灵/亡灵主题——墓碑+幽蓝鬼火+灵魂光点。 */
  _buildSpiritIslands(group) {
    // 手动挑的两个位置：离桥有余量、落在开阔水域，世界 2325×2325，桥沿对角线附近。
    const spots = [
      { x: 700, y: 1650 },
      { x: 1650, y: 700 },
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
