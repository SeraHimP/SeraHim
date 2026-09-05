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
  cliffHeight: 28,      // 崖壁高度（陆地面 y=0 往下伸多少）
  abyssDrop: 44,        // 深渊面比陆地面低多少。必须 > cliffHeight，否则崖壁踩不到底
  segLen: 46,           // 崖壁块的目标长度（世界单位）
  thickness: 16,        // 崖壁块朝内的厚度
  jitter: 0.22,         // 每块的高度抖动比例（0 = 齐平，参考图里崖顶是参差的）
  capHeight: 5,         // 崖顶那道亮边的厚度
  // ⚠️ 轮廓的简化容差 / 平滑遍数**不在这里**：它们决定的是"陆地边界长什么样"，
  //    地面底图和崖壁必须用同一条，所以统一由 navOutline.mapOutline 读地图声明
  //    （`terrainEdge.simplifyCells` / `.smoothPasses`，默认见 OUTLINE_DEF）。
  //    v55 初版在这里另存了一份，是"同一条边界存了三份"那个 bug 的一部分。
  cliffColor: '#3d5470',
  capColor: '#8ea6b8',
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

    // ① 深渊面：比陆地低 abyssDrop 的一张大平面。
    //    不复用 MapSkirtLayer —— 那是 3 倍地图边长、带 fadeAlpha 着色器补丁、
    //    MeshBasicMaterial 不吃光照的氛围层，职责完全不同（§8.2 的改动面第 2 条）。
    const W = map.world?.w ?? map.world, H = map.world?.h ?? W;
    const AS = P.abyssScale ?? 3;
    const abyss = new THREE.Mesh(
      new THREE.PlaneGeometry(W * AS, H * AS).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(P.abyssColor) })
    );
    abyss.position.set(W / 2, -P.abyssDrop, H / 2);
    abyss.receiveShadow = this.shadowOn;
    abyss.renderOrder = -1;
    this.group.add(abyss);

    // ② 崖壁：沿轮廓每 segLen 摆一块，块高带抖动（参考图里崖顶是参差的，不是齐平的）。
    const cliffGeos = [], capGeos = [];
    let seed = 0;
    for (const loop of loops) {
      const pts = loop.pts;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const nSeg = Math.max(1, Math.round(len / P.segLen));
        const ux = dx / len, uz = dz / len;
        // 法线朝**外**（内部在左手边 → 外法线是右手边）
        const nxv = uz, nzv = -ux;
        for (let k = 0; k < nSeg; k++) {
          const t0 = k / nSeg, t1 = (k + 1) / nSeg;
          const cx = a[0] + dx * (t0 + t1) / 2, cz = a[1] + dz * (t0 + t1) / 2;
          const segW = len / nSeg;
          const h = P.cliffHeight * (1 + (rnd(seed++) - 0.5) * 2 * P.jitter);
          const ang = Math.atan2(dx, dz);   // 让块的 +Z 对齐边的方向
          // 块朝内偏半个厚度，免得崖壁整体悬在地面外侧
          const ox = -nxv * P.thickness * 0.5, oz = -nzv * P.thickness * 0.5;
          const box = new THREE.BoxGeometry(P.thickness, h, segW * 1.02);
          box.rotateY(ang);
          box.translate(cx + ox, -h / 2, cz + oz);
          cliffGeos.push(box);
          // 崖顶亮边：贴在陆地面高度上，把地面那圈最近邻锯齿盖掉（§8.2.4）
          const cap = new THREE.BoxGeometry(P.thickness * 1.25, P.capHeight, segW * 1.02);
          cap.rotateY(ang);
          cap.translate(cx + ox, -P.capHeight * 0.35, cz + oz);
          capGeos.push(cap);
        }
      }
    }
    const addMerged = (geos, color) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos, false);
      for (const gg of geos) gg.dispose();
      if (!merged) return;
      const m = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
      m.castShadow = this.shadowOn; m.receiveShadow = this.shadowOn;
      this.group.add(m);
    };
    addMerged(cliffGeos, P.cliffColor);
    addMerged(capGeos, P.capColor);

    this.scene.add(this.group);
    this._mapId = map.id;
  }
}
