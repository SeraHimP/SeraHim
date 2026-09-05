/**
 * TerrainEdgeLayer.js —— 让"陆地"真的有厚度：**下沉的深渊面 + 沿可走边界的崖壁**
 *
 * 设计文档：docs/MAP-DESIGN-howling-abyss-frost.md §8.2（路线 B）。
 * 用户的原话是「两方基地变成不规则的大陆，中间用桥连接，大陆和桥要做出立体感，
 * 就像旁边那个冰的装饰一样」。
 *
 * ==================== 为什么必须是"两个面"，不能靠抬高地形 ====================
 * 陆地和深渊现在画在**同一个平面**上。崖壁块若从边界往下伸，会被同高的深渊面挡住，
 * 读成"方块陷进地板"，不是"陆地有厚度"。§8.2.3 逐条压测过三条路，结论：
 *   · 用 `MapSystem.heightAt` 抬高可走区域 —— **否决**。地形网格 24px 一段、
 *     navgrid 9px 一格，跟着 navgrid 抬会量化出**两条频率不同、互相错开的锯齿**，
 *     比现在还糟。
 *   · 在底图上画一条深色带假装崖壁 —— 45° 斜视下没有视差，像贴纸。
 *   · **拆成两个面**（地形只留可走区域、深渊另起一个更低的面）—— 采用。
 *
 * ==================== 这一层是通用件，不是冰封图专用 ====================
 * §8.2.5 明确要求：**不许写进 HowlingAbyssDecor.js**（那个文件只服务 frost）。
 * 任何地图声明 `map.terrainEdge` 就能启用，参数（崖高/下沉/颜色/块长/抖动）全在声明里。
 *
 * ==================== 性能 ====================
 * 边界总长 ≈ 7800 世界单位，按 ~46 单位一块 ≈ 170 块，再叠一层顶沿 ≈ 340 个 mesh。
 * 崖壁是**完全静态**的，建完直接 `mergeGeometries` 合成 2 个 mesh，draw call 回到个位数。
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { mapOutline } from '../data/navOutline.js';

const DEF = {
  // ==================== 落差（全是 y 坐标，陆地面 = 0）====================
  waterY: -22,          // 水面（深渊面）的 y。这是**唯一决定"陆地看起来高多少"的数**
  slopeDepth: 14,       // 岸坡从陆地面往下落多少
  slopeRun: 10,         // 岸坡朝外扩多少（水平）。slopeDepth/slopeRun 决定坡角
  edgeDepth: 0,         // 岸坡底再垂直往下多少（>0 就是"短斜坡 + 厚边"的两段式）
  // ==================== 形状 ====================
  segLen: 46,           // 沿轮廓的采样间距
  blockLen: 3,          // 每几段共用一次抖动 —— 做出"大块段落"而不是逐段噪声
  jitter: 0.22,         // 落差的抖动比例
  runJitter: 0.25,      // 外扩的抖动比例
  // ==================== 颜色 ====================
  // ⚠️ 岸坡的颜色必须取**地面色压暗一档**，不能取墙/柱子的石色。
  //    实测第一版用了石色（#6f89a6，介于 rockColor 与 wallCapColor 之间），
  //    画面上岸坡读成"更多的墙"而不是"这块地的背光面"——正是这一轮要消灭的建筑感。
  slopeColor: '#a8c2d4',   // = corridorColor #dce9f2 压暗约 25%
  edgeColor: '#5f7d94',    // 厚边/暗面：再压暗一档（edgeDepth=0 时不生成）
  abyssColor: '#16233d',
  // 深渊面要**比地图大**。只做地图那么大的话，地图边界处会露出一条硬直角边：
  // 边界内是深渊面、边界外是裙边层（MapSkirtLayer，3 倍地图边长、y=-15、
  // 中心透明向外渐显），两者颜色不同就成了一个矩形框。做成同样 3 倍之后，
  // 裙边只是在同一张深色面上淡入，接缝变成软过渡而不是硬边。
  abyssScale: 3,
};

/** 确定性伪随机：同一条边界每次生成必须一模一样（几何要进缓存，随机会让画面每次不同）。 */
function rnd(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export class TerrainEdgeLayer {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
    this.shadowOn = false;
  }

  setShadowLevel(level) {
    this.shadowOn = level !== 'off';
    if (this.group) this.group.traverse((o) => { if (o.isMesh) { o.castShadow = this.shadowOn; o.receiveShadow = this.shadowOn; } });
  }

  dispose() {
    if (!this.group) return;
    this.group.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); } });
    this.scene.remove(this.group);
    this.group = null;
    this._mapId = null;
  }

  /**
   * @param {MapSystem} mapSystem
   */
  build(mapSystem) {
    const map = mapSystem?.currentMap;
    const cfg = map?.terrainEdge;
    // 没声明的地图一律不生成 —— 三张老地图因此逐位不变。
    if (!map || !cfg) { this.dispose(); return; }
    if (this._mapId === map.id && this.group) return;   // 同图跳过（与其它装饰层一致）
    this.dispose();

    const P = { ...DEF, ...cfg };
    // 崖壁与地面底图共用**同一条**轮廓（见 navOutline.mapOutline 的头注：
    // 各画各的会让一半崖壁块脚下没有地面，就是用户说的"条在图上乱飘"）。
    const loops = mapOutline(map);
    if (!loops || !loops.length) return;

    this.group = new THREE.Group();
    this.group.name = 'terrainEdge';

    // ① 深渊面（= 水面）：铺在 waterY 的一张大平面。
    //    不复用 MapSkirtLayer —— 那是 3 倍地图边长、带 fadeAlpha 着色器补丁、
    //    MeshBasicMaterial 不吃光照的氛围层，职责完全不同（§8.2 的改动面第 2 条）。
    const W = map.world?.w ?? map.world, H = map.world?.h ?? W;
    const AS = P.abyssScale ?? 3;
    const abyss = new THREE.Mesh(
      new THREE.PlaneGeometry(W * AS, H * AS).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(P.abyssColor) })
    );
    abyss.position.set(W / 2, P.waterY, H / 2);
    abyss.receiveShadow = this.shadowOn;
    abyss.renderOrder = -1;
    this.group.add(abyss);

    // ② 岸坡：沿轮廓挤出的**连续外倾带**，不是一圈竖直方块。
    //
    // ==================== 为什么必须是斜面 ====================
    // 45° 正交俯视下，**竖直面只有朝相机的那两条边看得见**：背向相机的那两条
    // 被陆地自己挡住，做多高都看不到。v55 的竖直崖壁就栽在这儿——用户反馈
    // 「桥下面的高度差是可以被看到的，上面的看不到」，说的正是这件事，
    // 跟崖壁高度无关。斜面有朝上的法线分量，任何方位角都能吃到光。
    //
    // ⚠️ 但别把话说满：单靠法线不等于"读得出高差"。真正起作用的是
    //    斜面 + 深度对比 + 轮廓 + 水面对比四件一起。这里只负责前两件。
    //
    // ==================== 为什么去掉了原来的"崖顶亮边" ====================
    // 它当初的职责是盖住地面底图那圈最近邻锯齿。v55.1 地面改成按同一条折线
    // 矢量填充之后锯齿已经没了，再留着只会在斜面顶部多出**第二条轮廓线**——
    // 在强描边下会读成"两条栏杆"，正是这一轮要消灭的东西。
    //
    // ==================== 抖动为什么按"块"而不是按"段" ====================
    // 逐段独立随机 = 噪声，看起来像锯齿而不是地形。改成每 blockLen 段共用一个
    // 抖动值，边缘于是呈现"大块段落"（████ █████ ████），这才是低模地形的读法。
    const slopeGeos = [], edgeGeos = [];
    let seed = 0;
    for (const loop of loops) {
      // ①-a 把折线按 segLen 重采样成等距点列（闭合）。直接用折线顶点的话，
      //     DP 之后长短悬殊，抖动块的尺度会跟着乱。
      const src = loop.pts;
      const ring = [];
      let acc = 0, target = 0;
      const total = (() => { let t = 0; for (let i = 0; i < src.length; i++) {
        const a = src[i], b = src[(i + 1) % src.length];
        t += Math.hypot(b[0] - a[0], b[1] - a[1]); } return t; })();
      if (total < P.segLen * 3) continue;
      const nSample = Math.max(8, Math.round(total / P.segLen));
      const step = total / nSample;
      for (let i = 0; i < src.length && ring.length < nSample; i++) {
        const a = src[i], b = src[(i + 1) % src.length];
        const segLen2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (target < acc + segLen2 && ring.length < nSample) {
          const t = (target - acc) / segLen2;
          ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          target += step;
        }
        acc += segLen2;
      }
      const m = ring.length;
      if (m < 8) continue;

      // ①-b 每个采样点的外法线。用前后邻居求切线（不是单边），
      //     否则拐角处两侧法线打架，挤出来的带会自交出一个尖刺。
      const prof = [];
      const base = seed;
      for (let i = 0; i < m; i++) {
        const a = ring[(i - 1 + m) % m], b = ring[(i + 1) % m];
        const tx = b[0] - a[0], tz = b[1] - a[1];
        const L = Math.hypot(tx, tz) || 1;
        // 外法线。⚠️ 方向踩过一次：v55 的竖直崖壁用的是 (tz, -tx)，实测在这条环上
        // **50/58 个顶点指向陆地内侧**——竖直方块因为跨在边界上，插反了看不太出来；
        // 换成挤出的斜面之后整条带子被陆地盖住，画面上"岸坡完全不见了"。
        // 正确的是 (-tz, tx)：traceLoops 的绕向是"内部在左手边"，外侧在右手边的**反**向。
        // 洞环绕向相反，同一个公式自动给出"背离陆地"的方向，不用另写分支。
        const nx = -tz / L, nz = tx / L;
        // 按块取抖动：同一块内所有采样点共用一个值 → 大块段落而不是噪声
        const blk = Math.floor(i / Math.max(1, P.blockLen));
        const jd = (rnd(base + blk * 2) - 0.5) * 2 * P.jitter;
        const jr = (rnd(base + blk * 2 + 1) - 0.5) * 2 * P.runJitter;
        const depth = P.slopeDepth * (1 + jd);
        const run = P.slopeRun * (1 + jr);
        prof.push({
          x: ring[i][0], z: ring[i][1],
          fx: ring[i][0] + nx * run, fz: ring[i][1] + nz * run,
          depth,
        });
      }
      seed += Math.ceil(m / Math.max(1, P.blockLen)) * 2 + 1;

      // ①-c 逐段拉两个三角形。顶环恒在 y=0 且**就是地面那条折线的点**，
      //     所以坡顶与地面边缘逐点重合，不可能出现缝（这是 v55.1 共用轮廓的直接红利）。
      const quad = (out, ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2) => {
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute('position', new THREE.Float32BufferAttribute(
          [ax, ay, az, bx, by, bz, cx2, cy2, cz2,
           ax, ay, az, cx2, cy2, cz2, dx2, dy2, dz2], 3));
        g2.computeVertexNormals();
        out.push(g2);
      };
      for (let i = 0; i < m; i++) {
        const p0 = prof[i], p1 = prof[(i + 1) % m];
        // 斜面：陆地边缘 (y=0) → 坡脚 (y=-depth，外扩 run)
        quad(slopeGeos,
          p0.x, 0, p0.z,   p1.x, 0, p1.z,
          p1.fx, -p1.depth, p1.fz,   p0.fx, -p0.depth, p0.fz);
        // 厚边：坡脚再垂直往下 edgeDepth（edgeDepth=0 就是纯斜坡，不生成这一段）
        if (P.edgeDepth > 0) {
          quad(edgeGeos,
            p0.fx, -p0.depth, p0.fz,   p1.fx, -p1.depth, p1.fz,
            p1.fx, -p1.depth - P.edgeDepth, p1.fz,
            p0.fx, -p0.depth - P.edgeDepth, p0.fz);
        }
      }
    }
    // 静态几何合并：斜面按采样点逐段拉三角形，环上有 ~180 段，
    // 不合并就是 180+ 个 mesh 的 draw call。合完是 1~2 个。
    const addMerged = (geos, color) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos, false);
      for (const gg of geos) gg.dispose();
      if (!merged) return;
      // 双面：凹角处相邻两段会轻微自交，单面会漏出背面。
      const m2 = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({
        color: new THREE.Color(color), side: THREE.DoubleSide }));
      m2.castShadow = this.shadowOn; m2.receiveShadow = this.shadowOn;
      this.group.add(m2);
    };
    // 斜面/厚边分成两个 mesh：两档颜色，低模世界里靠色阶而不是贴图表达体积。
    addMerged(slopeGeos, P.slopeColor);
    addMerged(edgeGeos, P.edgeColor);

    this.scene.add(this.group);
    this._mapId = map.id;
  }
}
