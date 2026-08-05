/**
 * EffectsLayer.js —— 弹道 / 指示线 / 静态参照层（2.5D 迁移第 3.5 步，B+C+D）
 *
 * 承接 CanvasRenderer.render() 里所有【非实体、非地形】的绘制物：
 *   B 弹道：子弹（光晕+核心+高光）、闪电杖光束、闪电链电弧
 *   C 指示线：塔攻击红线、攻城车攻城红线
 *   D 静态参照：背景网格、世界边界框、双方基地高地扇形、兵线虚线
 *
 * ===== 为什么不用 THREE.Line =====
 * WebGL 的 lineWidth 在几乎所有平台被钳到 1px，而 2D 侧线宽是有语义的
 * （光束宽度随充能 1.5→5、电弧 3.5、边界框 4）。所以全部线段自己铺成
 * 【贴地四边形带】（ribbon）：世界单位定宽，在倾斜相机下随地面一起透视压缩——
 * 这正是"线躺在地上"的正确表现。
 *
 * 2D 侧线宽的两种语义，此处如实区分：
 *   - `ctx.lineWidth = 4`  → ctx 已 scale(zoom)，故 4 是【世界单位】→ ribbon 直接用
 *   - `ctx.lineWidth = Math.max(0.35, 0.5 / viewZoom)` → 屏幕恒定像素（C 组两条红线）
 *     → ribbon 每帧按当前 zoom 反算世界宽度，保持屏幕观感一致
 *
 * ===== 分批 =====
 *   _dyn   动态线批（B 的光束/电弧 + C 的两条红线）：每帧重建，一个 draw call
 *   _quad  动态贴图四边形批（B 的子弹光晕/核心）：每帧重建，一个 draw call
 *   _stat  静态参照批（D）：切图时重建一次，之后零每帧成本
 * 三者都用预分配 Float32Array + BufferAttribute.updateRange 风格的"只改 count"，
 * 每帧零分配（长跑不产生 GC 压力）。
 *
 * ===== 墙钟纪律（ARCHITECTURE 明示，第3.5步验收项）=====
 * 光束流动虚线的相位用 `performance.now()`（渲染墙钟），**不是** 30Hz 的 gameTime——
 * 用 gameTime 会让流动以 30Hz 台阶推进，肉眼可见卡顿。
 *
 * ===== 流动相位：积分式，不是"绝对时间 × 速度" =====
 * 2D 原式 `lineDashOffset = -((wallT * flowSpeed) % 100000)` 有个结构性缺陷：
 * flowSpeed 随充能从 60 跳到 220，而 wallT 是开页以来的绝对秒数（可达数千）。
 * 速度一变，相位瞬间跳变 wallT×Δspeed（成千上万像素），对 period 取模后等于随机数
 * —— 于是充能过程中虚线不是"流动"，是每帧【瞬移】。充能越剧烈跳得越凶。
 * 此处改为逐帧积分：phase += flowSpeed × dtWall，再对 period 取模。速度变化只改变
 * 推进【速率】，绝不改变当前【位置】，流动因此连续。相位按 beam 对象存在 WeakMap 里
 * （beam 对象在 ProjectileSystem 里原地复用，删除后条目自动回收），渲染态零外泄。
 * 这是 3D 侧【优于】2D 的一处刻意差异：2D 第 5 步即摘除，不回填。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const MAX_DYN_TRI = 24000;    // 动态线批三角形上限（电弧封顶 120 条 × 分段，余量充足）
const MAX_QUAD = 4000;        // 子弹上限（每颗 2 个四边形：光晕 + 核心）
const MAX_STAT_TRI = 12000;   // 静态参照：网格 89×2 线 + 边界 4 边 + 两扇形 + 兵线虚线

// 子弹光晕纹理：一次性程序生成的径向渐变（对应 2D 的 _glowSprite，此处白色，由顶点色染色）
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.80)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.40)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// '#rrggbb' -> THREE.Color。按 hex 缓存【各自独立】的对象：
// 若共用一个可变实例，`const red = rgbOf(...)` 这类跨调用持有的引用会被后续 rgbOf 改写
// （本文件里 C 组红线的 red 就是这么持有的）。缓存后暖机完成即零分配，且无别名陷阱。
const _colCache = new Map();
function rgbOf(hex) {
  const k = hex || '#ffffff';
  let c = _colCache.get(k);
  if (!c) { c = new THREE.Color(k); _colCache.set(k, c); }
  return c;
}

// #10：穿透塔弹"升温"的热色目标（橙白）。子弹按 heat（0..1）向它偏移。
const HEAT_HOT = new THREE.Color('#ffcf6a');

const GROUND_LIFT = 0.6;   // 贴地特效离地高度（世界单位）
// Q1/Q2：塔弹拖尾 = 锥形光束（尾细头粗 + 辉光 + 白芯），与闪电杖同一套视觉语言。
const TRAIL_LEN = 2.2;     // 尾巴长度 = 弹丸尺寸 × 本系数（Q2：3.2→2.2，收敛）
const TRAIL_GLOW = 2.0;    // 辉光层相对主体的宽度倍率（Q2：2.6→2.0）
const TRAIL_W = 0.22;      // 尾巴头部宽度 = 弹丸尺寸 × 本系数
const TRAIL_W_HEAT = 0.05; // 升温对尾巴宽度的加成（Q2：从 0.14 压到 0.05）
const TRAIL_FADE = 0.13;   // 子弹消失后尾迹余烬的淡出时长（秒）
const WHITE = new THREE.Color('#ffffff');
// Q1：闪电杖光束宽度只由充能驱动（细 → 粗），不再有虚线形态。
// 主体与辉光走软边（两侧渐变透明），所以宽度可以给得比硬边时代大一些也不会显笨。
const BEAM_W_MIN = 1.6;    // 零充能时的主体宽度
const BEAM_W_MAX = 9.0;    // 满充能时的主体宽度
const BEAM_GLOW_K = 3.0;   // 辉光层相对主体的宽度倍率
const BEAM_CORE_K = 0.16;  // 白芯相对主体的宽度比（细才好看，实心不刺眼）
// Q3：腐蚀塔不画红线，改为从塔向射程边缘扩散的毒雾波纹
// v43 Q8：腐蚀型的 2D 环常量已随实现一起迁到 presentation/CorrosionLayer.js（改为 3D 雾球）。

class Batch {
  constructor(scene, maxTri, opts = {}) {
    this.max = maxTri;
    this.pos = new Float32Array(maxTri * 3 * 3);
    this.col = new Float32Array(maxTri * 3 * 4);   // itemSize 4 → three 启用 USE_COLOR_ALPHA
    this.uv = opts.uv ? new Float32Array(maxTri * 3 * 2) : null;
    this.n = 0;                                    // 已写入三角形数

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    if (this.uv) geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      // depthTest 必须【开启】：第 6.2 步之后高地抬到了 y=70，关掉深度测试会让网格线、
      // 兵线虚线、弹道一律画在高地之上，视觉上就是"墙是透明的"。这是纸片人时代
      // 靠 renderOrder 强行排序的遗留设定，立体化后必须改掉。
      // depthWrite 仍关闭：特效之间不该互相遮挡，只该被实体几何遮挡。
      vertexColors: true, transparent: true, depthTest: true, depthWrite: false,
      side: THREE.DoubleSide, map: opts.map || null,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;               // 顶点每帧变，包围盒无意义
    this.mesh.renderOrder = opts.order || 0;
    // 贴地图元建在 y=0，与地面平面同高会 z-fighting；整片抬 GROUND_LIFT 即可。
    // 已经带高度的三维图元（光束/子弹）多抬这一点肉眼不可辨。
    this.mesh.position.y = GROUND_LIFT;
    scene.add(this.mesh);
    this.geo = geo;
  }

  reset() { this.n = 0; }

  // 贴地三角形（y=0），转调三维版本
  _tri(ax, az, bx, bz, cx, cz, col, a, uvs) {
    this._tri3(ax, 0, az, bx, 0, bz, cx, 0, cz, col, a, uvs);
  }

  // 三维三角形：第 6.3 步单位立体化后，弹道/光束/红线的起点要抬到炮口高度，
  // 不能再假定一切都躺在 y=0 上。
  _tri3(ax, ay, az, bx, by, bz, cx, cy, cz, col, a, uvs) {
    if (this.n >= this.max) return;
    const p = this.n * 9, q = this.n * 12;
    const P = this.pos, C = this.col;
    P[p] = ax; P[p + 1] = ay; P[p + 2] = az;
    P[p + 3] = bx; P[p + 4] = by; P[p + 5] = bz;
    P[p + 6] = cx; P[p + 7] = cy; P[p + 8] = cz;
    for (let i = 0; i < 3; i++) {
      C[q + i * 4] = col.r; C[q + i * 4 + 1] = col.g; C[q + i * 4 + 2] = col.b; C[q + i * 4 + 3] = a;
    }
    if (this.uv && uvs) {
      const u = this.n * 6;
      for (let i = 0; i < 6; i++) this.uv[u + i] = uvs[i];
    }
    this.n++;
  }

  // 贴地四边形：四角按 (x,z) 给出，逆时针无所谓（DoubleSide）
  quad(x0, z0, x1, z1, x2, z2, x3, z3, col, a, uvA, uvB) {
    this._tri(x0, z0, x1, z1, x2, z2, col, a, uvA);
    this._tri(x0, z0, x2, z2, x3, z3, col, a, uvB);
  }

  // 世界单位定宽线段
  seg(ax, ay, bx, by, w, col, a) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = -dy / len * w * 0.5, ny = dx / len * w * 0.5;
    this.quad(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, col, a);
  }

  // 虚线段：dash/gap 世界单位，phase 为相位偏移（负值 = 向前流动）
  dashed(ax, ay, bx, by, w, col, a, dash, gap, phase = 0) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const ux = dx / len, uy = dy / len;
    const period = dash + gap;
    if (period <= 0.01) { this.seg(ax, ay, bx, by, w, col, a); return; }
    let t = -(((phase % period) + period) % period);
    while (t < len) {
      const s = Math.max(0, t), e = Math.min(len, t + dash);
      if (e > s) this.seg(ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e, w, col, a);
      t += period;
    }
  }

  // 轴对齐矩形描边（世界边界框）
  rectStroke(x, y, w, h, lw, col, a) {
    this.seg(x, y, x + w, y, lw, col, a);
    this.seg(x + w, y, x + w, y + h, lw, col, a);
    this.seg(x + w, y + h, x, y + h, lw, col, a);
    this.seg(x, y + h, x, y, lw, col, a);
  }

  // 扇形填充（基地高地圈）：圆心 + 起止角，与 2D 的 moveTo/arc/closePath/fill 同形
  fan(cx, cy, r, a0, a1, col, a, segs = 48) {
    const step = (a1 - a0) / segs;
    for (let i = 0; i < segs; i++) {
      const t0 = a0 + step * i, t1 = a0 + step * (i + 1);
      this._tri(cx, cy,
        cx + Math.cos(t0) * r, cy + Math.sin(t0) * r,
        cx + Math.cos(t1) * r, cy + Math.sin(t1) * r, col, a);
    }
  }

  /**
   * 三维带子：连接两个任意高度的点。宽度方向取 叉乘(线方向, 视线方向) —— 即恒定朝向
   * 摄像机的一片带子。贴地带子那套（宽度在 XZ 平面内）在这里行不通：一条从塔顶斜射
   * 到地面的线，其贴地宽度在屏幕上会被压成一条缝，充能到满也看不见。
   * 摄像机不做偏航、只有仰角，故视线方向是常量，由 update() 传入。
   */
  seg3(ax, ay, az, bx, by, bz, w, col, a, vx, vy, vz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    // n = dir × view，归一化后乘半宽
    let nx = dy * vz - dz * vy, ny = dz * vx - dx * vz, nz = dx * vy - dy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) return;
    const k = w * 0.5 / nl;
    nx *= k; ny *= k; nz *= k;
    this._tri3(ax + nx, ay + ny, az + nz, bx + nx, by + ny, bz + nz, bx - nx, by - ny, bz - nz, col, a);
    this._tri3(ax + nx, ay + ny, az + nz, bx - nx, by - ny, bz - nz, ax - nx, ay - ny, az - nz, col, a);
  }

  /**
   * 三维【锥形】带子：起点宽 wA、终点宽 wB，alpha 也从 aA 渐变到 aB。
   * 与 seg3 的区别只在两端可以不等宽 —— 这是"光束由细变粗"的基础图元
   * （Q1/Q2：子弹拖尾与闪电杖统一成同一种锥形光束语言）。
   * 宽度方向同样取 叉乘(线方向, 视线方向)，恒定朝向摄像机。
   */
  taper3(ax, ay, az, bx, by, bz, wA, wB, col, aA, aB, vx, vy, vz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (Math.hypot(dx, dy, dz) < 1e-6) return;
    let nx = dy * vz - dz * vy, ny = dz * vx - dx * vz, nz = dx * vy - dy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) return;
    const ka = wA * 0.5 / nl, kb = wB * 0.5 / nl;
    const ax1 = nx * ka, ay1 = ny * ka, az1 = nz * ka;
    const bx1 = nx * kb, by1 = ny * kb, bz1 = nz * kb;
    // 两端 alpha 不同 → 不能用 _tri3（它对三个顶点写同一个 alpha），这里逐顶点写。
    this._triA(ax + ax1, ay + ay1, az + az1, aA,
               bx + bx1, by + by1, bz + bz1, aB,
               bx - bx1, by - by1, bz - bz1, aB, col);
    this._triA(ax + ax1, ay + ay1, az + az1, aA,
               bx - bx1, by - by1, bz - bz1, aB,
               ax - ax1, ay - ay1, az - az1, aA, col);
  }

  /** 逐顶点 alpha 的三角形（taper3 专用；其余路径继续走 _tri3 的统一 alpha 快路径） */
  _triA(x0, y0, z0, a0, x1, y1, z1, a1, x2, y2, z2, a2, col) {
    if (this.n >= this.max) return;
    const p = this.n * 9, q = this.n * 12;
    const P = this.pos, C = this.col;
    P[p] = x0; P[p + 1] = y0; P[p + 2] = z0;
    P[p + 3] = x1; P[p + 4] = y1; P[p + 5] = z1;
    P[p + 6] = x2; P[p + 7] = y2; P[p + 8] = z2;
    const r = col.r, g = col.g, b = col.b, A = [a0, a1, a2];
    for (let i = 0; i < 3; i++) {
      C[q + i * 4] = r; C[q + i * 4 + 1] = g; C[q + i * 4 + 2] = b; C[q + i * 4 + 3] = A[i];
    }
    this.n++;
  }

  /**
   * 【软边】三维带子：横截面上中线不透明、两侧线性渐变到全透明。
   *
   * seg3 画出来是一条硬边实带 —— 宽度一大就是一条死板的方条（用户："那个宽带太丑了"）。
   * 光束本该是中间亮、边缘化开的。这里把带子拆成左右两片，
   * 中线顶点 alpha = aMid、外沿顶点 alpha = 0，靠顶点色插值出横向渐变。
   * 代价是 4 个三角形（seg3 是 2 个），换来的是"光"而不是"条"。
   */
  softSeg3(ax, ay, az, bx, by, bz, w, col, aMid, vx, vy, vz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (Math.hypot(dx, dy, dz) < 1e-6 || aMid <= 0.001) return;
    let nx = dy * vz - dz * vy, ny = dz * vx - dx * vz, nz = dx * vy - dy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) return;
    const k = w * 0.5 / nl;
    nx *= k; ny *= k; nz *= k;
    // +n 侧：中线(aMid) → 外沿(0)
    this._triA(ax, ay, az, aMid, bx, by, bz, aMid, bx + nx, by + ny, bz + nz, 0, col);
    this._triA(ax, ay, az, aMid, bx + nx, by + ny, bz + nz, 0, ax + nx, ay + ny, az + nz, 0, col);
    // -n 侧：同上镜像
    this._triA(ax, ay, az, aMid, bx, by, bz, aMid, bx - nx, by - ny, bz - nz, 0, col);
    this._triA(ax, ay, az, aMid, bx - nx, by - ny, bz - nz, 0, ax - nx, ay - ny, az - nz, 0, col);
  }

  /**
   * 水平圆环（Q3 腐蚀波纹）：躺在 y=cy 平面上的一圈定宽带子。
   * 不用 seg3 逐段拼——那样宽度方向取的是"朝向摄像机"，环会拧成麻花；
   * 这里宽度直接取径向（环躺平在地面上，跟着地面一起透视压缩，读作贴地的雾）。
   */
  ring3(cx, cy, cz, r, w, col, a, segs = 36) {
    const hw = w * 0.5, ri = Math.max(0, r - hw), ro = r + hw;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs * Math.PI * 2, t1 = (i + 1) / segs * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      this._tri3(cx + c0 * ri, cy, cz + s0 * ri, cx + c0 * ro, cy, cz + s0 * ro,
                 cx + c1 * ro, cy, cz + s1 * ro, col, a);
      this._tri3(cx + c0 * ri, cy, cz + s0 * ri, cx + c1 * ro, cy, cz + s1 * ro,
                 cx + c1 * ri, cy, cz + s1 * ri, col, a);
    }
  }

  /** 三维虚线：与 dashed 同参，只是端点带高度（沿线线性插值） */
  dashed3(ax, ay, az, bx, by, bz, w, col, a, dash, gap, phase, vx, vy, vz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    // 长度取【三维实长】。首版用水平投影长，而顶点是沿三维向量插值的：
    // 光束从塔顶斜射下来时目标越近、高差占比越大，虚线被拉长、流速看着也变快
    // （远距离差 5%，近距离能差 60%）。同一条线上 dash/gap 的世界尺寸必须自洽。
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const period = dash + gap;
    let t = ((phase % period) + period) % period - period;
    while (t < len) {
      const s0 = Math.max(0, t), s1 = Math.min(len, t + dash);
      if (s1 > s0) {
        const u0 = s0 / len, u1 = s1 / len;
        this.seg3(ax + dx * u0, ay + dy * u0, az + dz * u0,
                  ax + dx * u1, ay + dy * u1, az + dz * u1, w, col, a, vx, vy, vz);
      }
      t += period;
    }
  }

  /** 悬空贴图片（子弹）：面向摄像机的正方形。右 = 世界 +X（无偏航），上 = 摄像机 up。 */
  sprite3(x, y, z, size, col, a, ux, uy, uz, rrx = 1, rry = 0, rrz = 0) {
    const h = size * 0.5;
    // 右向量：无偏航时 = 世界 +X（原行为）；偏航时由调用方传摄像机右向。
    const rpx = rrx * h, rpy = rry * h, rpz = rrz * h;
    const upx = ux * h, upy = uy * h, upz = uz * h;
    const P = [
      [x - rpx - upx, y - rpy - upy, z - rpz - upz], [x + rpx - upx, y + rpy - upy, z + rpz - upz],
      [x + rpx + upx, y + rpy + upy, z + rpz + upz], [x - rpx + upx, y - rpy + upy, z - rpz + upz],
    ];
    this._tri3(P[0][0], P[0][1], P[0][2], P[1][0], P[1][1], P[1][2], P[2][0], P[2][1], P[2][2],
      col, a, [0, 1, 1, 1, 1, 0]);
    this._tri3(P[0][0], P[0][1], P[0][2], P[2][0], P[2][1], P[2][2], P[3][0], P[3][1], P[3][2],
      col, a, [0, 1, 1, 0, 0, 0]);
  }

  // 贴图四边形（子弹）：以 (x,y) 为中心的正方形，边长 size
  sprite(x, y, size, col, a) {
    const h = size * 0.5;
    this.quad(x - h, y - h, x + h, y - h, x + h, y + h, x - h, y + h, col, a,
      [0, 1, 1, 1, 1, 0], [0, 1, 1, 0, 0, 0]);
  }

  flush() {
    this.geo.setDrawRange(0, this.n * 3);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    if (this.uv) this.geo.attributes.uv.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}

export class EffectsLayer {
  constructor(scene) {
    this._muzzle = new WeakMap();     // 子弹 -> 出膛高度（解析一次，随子弹回收自动释放）
    this._beamPhase = new WeakMap();  // beam 对象 -> 流动相位（px，已对 period 取模）
    this._lastWall = 0;               // 上一帧墙钟秒数，用于求 dtWall
    this.scene = scene;
    this._glowTex = makeGlowTexture();
    // renderOrder：静态参照(1) < 地面已在 0 < 弹道线(30) < 子弹(31) < 单位(10)/血条(20)
    // 单位用 10/20（见 UnitLayer），弹道压在单位之上符合 2D 的绘制次序（子弹最后画）。
    this._stat = new Batch(scene, MAX_STAT_TRI, { order: 1 });
    this._dyn = new Batch(scene, MAX_DYN_TRI, { order: 30 });
    this._quad = new Batch(scene, MAX_QUAD * 2, { order: 31, uv: true, map: this._glowTex });
    this._statMapId = null;
    this._weaponCache = new WeakMap();   // 塔 → 当前武器技能 id（Q3 腐蚀判定用）
    this._seen = new Map();             // 子弹 → 上一帧尾迹快照（Q2 余烬用）
    this._fading = [];                  // 正在淡出的尾迹余烬
    this._beamEndY = new WeakMap();     // Q1：光束 → 冻结的末端高度（目标死亡后不再重算）
    this._beamStartY = new WeakMap();   // v43 Q2：光束 → 冻结的**起点**高度（塔死后不再重算）
    this._projTgt = new WeakMap();      // Q1：子弹 → 目标位置与落点高度的快照
    this._statDirty = true;
  }

  markStaticDirty() { this._statDirty = true; }

  /**
   * 塔弹拖尾：辉光 / 主体 / 白芯 三层锥形带（尾细头粗），沿真实三维弹道。
   * k = 整体不透明度系数（命中后的残影靠它淡出）。
   */
  _trail(D, V, tx, ty, tz, x, by, y, hsz, heat, col, k) {
    if (k <= 0.01) return;
    // Q2：升温对拖尾的加成大幅收敛 —— 只留一点点，避免满升温时尾巴又粗又亮抢戏
    const wHead = hsz * (TRAIL_W + heat * TRAIL_W_HEAT);
    D.taper3(tx, ty, tz, x, by, y, wHead * 0.6 * TRAIL_GLOW, wHead * TRAIL_GLOW,
             col, 0, (0.16 + heat * 0.08) * k, V.vx, V.vy, V.vz);
    D.taper3(tx, ty, tz, x, by, y, wHead * 0.18, wHead, col, 0, 0.62 * k, V.vx, V.vy, V.vz);
    D.taper3(tx, ty, tz, x, by, y, wHead * 0.06, wHead * 0.30, WHITE, 0,
             0.70 * (0.7 + heat * 0.3) * k, V.vx, V.vy, V.vz);
  }

  /**
   * 取某座塔当前装备的武器技能 id（没有则 null）。
   * 每帧对每座塔遍历技能实例是白费——技能实例只在装/卸时变，故按实例数组身份缓存。
   */
  _weaponOf(t) {
    const arr = t._skillInstances;
    if (!arr) return null;
    const c = this._weaponCache.get(t);
    if (c && c.arr === arr && c.len === arr.length) return c.id;
    let id = null;
    for (const i of arr) if (i.skillId && i.skillId.startsWith('weapon_')) { id = i.skillId; break; }
    this._weaponCache.set(t, { arr, len: arr.length, id });
    return id;
  }

  // ============ D 组：静态参照层（切图重建一次） ============
  _rebuildStatic(mapSystem) {
    this._statDirty = false;
    const B = this._stat;
    B.reset();
    const map = mapSystem?.currentMap;

    // D1 背景网格：2D 按视口裁剪，3D 一次性铺满同一个 [-500, 4100] 常量范围
    //（89×2 条线 ≈ 356 三角形，静态零成本，不必再做视口裁剪）
    // 用户反馈"地面上会显示格子，不要显示格子" → 默认关闭，作为设置项（画质 tab）保留。
    // 开关走 window.__gridOn，切换后由 SettingsDialog 调 markStaticDirty() 触发重建。
    if (window.__gridOn) {
      const STEP = 40, LIM_MIN = -500, LIM_MAX = 4100;
      const col = rgbOf('#ffffff');
      for (let x = LIM_MIN; x < LIM_MAX; x += STEP) B.seg(x, LIM_MIN, x, LIM_MAX, 1, col, 0.06);
      for (let y = LIM_MIN; y < LIM_MAX; y += STEP) B.seg(LIM_MIN, y, LIM_MAX, y, 1, col, 0.06);
    }

    if (mapSystem?.active && map?.world) {
      const { w: WW, h: WH } = map.world;
      // D2 世界边界框
      B.rectStroke(0, 0, WW, WH, 4, rgbOf('#ffffff'), 0.18);
      // D3 双方基地高地扇形 —— 默认不画（CONFIG.tuning.showBaseCircle，设置里可开）。
      // 关掉的只是这个圈的**画法**；基地光环是玩法效果，走 towerPassives，与此无关。
      if (CONFIG.tuning?.showBaseCircle) {
        const baseR = mapSystem.getBaseCircleRadius?.('blue') || WW * 0.37;
        const baseR2 = mapSystem.getBaseCircleRadius?.('red') || baseR;
        B.fan(0, WH, baseR, -Math.PI / 2, 0, rgbOf('#5b9bd5'), 0.07);
        B.fan(WW, 0, baseR2, Math.PI / 2, Math.PI, rgbOf('#e0473f'), 0.07);
      }
    }

    // D4 兵线虚线：有墙地图默认隐藏，设置里"显示小兵轨迹"可开（与 2D 同条件）
    if (mapSystem?.active && map &&
        (!mapSystem.hasWalls?.() || window.__showLanePaths)) {
      const col = rgbOf('#f6c94a');
      for (const lane of map.lanes) {
        const wps = lane.waypoints;
        for (let i = 1; i < wps.length; i++) {
          B.dashed(wps[i - 1].x, wps[i - 1].y, wps[i].x, wps[i].y, 3, col, 0.25, 8, 6);
        }
      }
    }
    B.flush();
    this._statMapId = map?.id ?? null;
  }

  /**
   * 每帧更新动态部分。
   * @param {object} deps { entities, projectiles, mapSystem }
   * @param {number} zoom  当前视图缩放（C 组屏幕恒定线宽反算世界宽度用）
   * @param {boolean} lodDots  与 2D 同口径的 LOD 档2（抑制攻城红线）
   */
  /**
   * @param view  { vx,vy,vz, ux,uy,uz } 摄像机视线与上方向（摄像机不偏航，故为常量）
   * @param muzzleY(x, z) → 该处单位的炮口高度（无单位则 0）。由 ThreeRenderer 从 UnitLayer 取。
   */
  update(deps, zoom, lodDots, view, muzzleY, muzzleOf) {
    const V = view || { vx: 0, vy: -1, vz: 0, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0 };
    const MY = muzzleY || (() => 0);
    // Q1：按【实体 id】取高度。坐标反查（MY）只作最后兜底 —— 它在目标死亡后返回 0、
    // 或者搜到旁边另一个单位身上，正是"残留轨迹错位"的根因。
    const MYOF = muzzleOf || (() => null);
    const endHeightOf = (id, x, z) => {
      const h = id != null ? MYOF(id) : null;
      return (h != null ? h : MY(x, z)) * 0.6;
    };
    const { entities, projectiles, mapSystem } = deps;
    // D 组：切图或首帧重建
    if (this._statDirty || this._statMapId !== (mapSystem?.currentMap?.id ?? null)) {
      this._rebuildStatic(mapSystem);
    }

    const D = this._dyn, Q = this._quad;
    D.reset(); Q.reset();
    const wallT = performance.now() / 1000;   // 墙钟纪律：光束流动用它，不用 gameTime
    // dtWall 钳到 0.1s：切标签页/断点回来后的巨大间隔不该让虚线瞬移一大截
    const dtWall = Math.min(0.1, Math.max(0, wallT - (this._lastWall || wallT)));
    this._lastWall = wallT;

    // ---- C1 塔攻击红线（前摇期间不画；语义 = "正在输出"）----
    // v43 Q4：样式集中到 CONFIG.ui.aimLine，塔与攻城车共用同一份（用户要求两者一致）。
    const AL = (CONFIG.ui && CONFIG.ui.aimLine) || {};
    const AL_W = AL.widthPx ?? 0.5, AL_A = AL.alpha ?? 0.5, AL_MIN = AL.minWidth ?? 0.35;
    const red = rgbOf(AL.color || '#ff3c3c');
    const screenW = (px) => Math.max(AL_MIN, px / (zoom || 1)); // 屏幕恒定 → 世界宽度
    for (const t of entities.getAllTowers(true)) {
      // ---- Q3 腐蚀型：没有"瞄准某个目标"这回事（它对射程内所有敌人持续叠毒），
      //      画红线是错的语义。改为从塔脚扩散出去的毒雾波纹，见下面 C3。
      if (this._weaponOf(t) === 'weapon_corrosion') continue;
      if (!t.targetId) continue;
      if ((window.gameTime || 0) < (t._lockUntil || 0)) continue;
      const tgt = entities.get(t.targetId);
      if (!tgt || !tgt.alive || !tgt.pos) continue;
      D.seg3(t.pos.x, MY(t.pos.x, t.pos.y), t.pos.y,
              tgt.pos.x, MY(tgt.pos.x, tgt.pos.y) * 0.6, tgt.pos.y,
              screenW(AL_W), red, AL_A, V.vx, V.vy, V.vz);
    }

    // ---- C3 腐蚀塔的表现已迁出本文件 ----
    // v43（Q8）：上一版在这里用三角批画一圈圈**贴地的 2D 同心环**。用户定稿否掉了：
    // "射程球（立体3D，半径最大射程）常驻显示……一波波向外扩散的雾（3D，遵循攻速），
    //  不要做成2D的，并且只有范围内有兵的时候在显示一波波的雾。"
    // 2D 环用三角批合适，3D 球不合适（球要真正的网格 + 双面低透明才有体积感），
    // 所以整块搬到 presentation/CorrosionLayer.js，由 ThreeRenderer 单独驱动。

    // ---- C2 攻城车攻城红线（受 LOD 档2 抑制）----
    // v43 Q4：宽度/透明度改为与塔**完全一致**（同一份 CONFIG.ui.aimLine）。
    // 旧版刻意画粗（0.9px/α0.55）来"凸显攻城状态"，用户要的是统一样式。
    if (!lodDots) {
      for (const m of entities.getAllMinions(true)) {
        if (!m._ramLockId) continue;
        const tgt = entities.get(m._ramLockId);
        if (!tgt || !tgt.alive || !tgt.pos) continue;
        D.seg3(m.pos.x, MY(m.pos.x, m.pos.y), m.pos.y,
                tgt.pos.x, MY(tgt.pos.x, tgt.pos.y) * 0.6, tgt.pos.y,
                screenW(AL_W), red, AL_A, V.vx, V.vy, V.vz);
      }
    }

    // ---- B2 闪电杖光束（Q1 推翻重做）----
    // 旧版是"流动虚线 + 实线 + 白核"三种形态混在一起，读起来是一串跑动的短横，
    // 不是一束光。用户定稿：**一开始细、随充能变粗，配辉光**，去掉一切虚线。
    // 现在整束光只有三层同心实带：辉光 / 主体 / 白芯，宽度都由 charge 单调驱动。
    if (projectiles?.getBeams) {
      for (const b of projectiles.getBeams()) {
        const charge = Math.max(0, Math.min(1, b.charge || 0));
        // v43 Q2：透明度 = 淡出 × 淡入。淡入由 ProjectileSystem 的 riseT 提供
        //（0→1 线性），解决"光束啪一下出现"；淡出沿用 fadeT/fadeMax。
        const fadeOut = (b.fadeT !== undefined && b.fadeMax) ? Math.max(0, b.fadeT / b.fadeMax) : 1;
        const fadeIn = (b.riseT !== undefined && b.riseMax) ? Math.min(1, 1 - b.riseT / b.riseMax) : 1;
        const fade = fadeOut * fadeIn;
        if (fade <= 0) continue;
        const col = rgbOf(b.color || '#f1c40f');
        // ==================== 起点高度：塔一死也【冻结】 ====================
        // 用户："闪电杖塔死亡后，残余的弹道突然就到水平面上了。"
        // 根因与末端那处**同一族**：这里原本是 `MY(b.startX, b.startY)` —— 按【坐标】
        // 反查该处单位的炮口高度。塔一没，那个坐标上再也搜不到单位，返回 0，
        // 于是整束光的起点当场塌到地面，看起来就是"弹道躺平了"。
        // 末端早在上一版就改成了"按 id 查 + 快照兜底"，起点漏了 —— 现在补齐。
        let sy;
        const liveS = b.attackerId != null ? MYOF(b.attackerId) : null;
        if (liveS != null) { sy = liveS; this._beamStartY.set(b, sy); }
        else {
          const snapS = this._beamStartY.get(b);
          sy = snapS !== undefined ? snapS : MY(b.startX, b.startY);
        }
        // ==================== 末端高度：目标一死就【冻结】 ====================
        // 用户："闪电杖攻击该目标死亡后会瞬间往下移动（就像是目标突然跳到了下面一样）。"
        // 上一版的冻结条件是 `b.fadeT === undefined`，也就是【等光束的 ttl 走完 0.4s
        // 之后】才冻。可是目标一死，武器层立刻停止刷新光束，而这 0.4s 里光束照样在画，
        // 且每帧都拿 targetId 去查高度 —— 实体没了，MYOF 返回 null，
        // 于是退化成按坐标反查（≈0），末端**当场塌到地面**。冻结晚了整整 0.4 秒。
        // 现在改成：只要这一帧还能按 id 查到高度就刷新快照，查不到（死亡/移除）
        // 或已进入淡出，就一律用最后一次的快照值。
        let ey;
        const liveH = b.targetId != null ? MYOF(b.targetId) : null;
        if (liveH != null && b.fadeT === undefined) {
          ey = liveH * 0.6;
          this._beamEndY.set(b, ey);
        } else {
          const snap = this._beamEndY.get(b);
          ey = snap !== undefined ? snap : endHeightOf(b.targetId, b.endX, b.endY);
        }
        // 宽度：细 → 粗。charge 走一点点缓入，让"越充越粗"的手感集中在后半段。
        const k = charge * charge * (3 - 2 * charge);          // smoothstep
        const w = BEAM_W_MIN + k * (BEAM_W_MAX - BEAM_W_MIN);
        // 轻微呼吸：只改宽度不改亮度，避免整束光一闪一闪
        const breathe = 1 + Math.sin(wallT * 6) * 0.06 * charge;
        // 满充能时那条"宽实带"很难看，因为硬边实心矩形读起来是条子不是光。
        // 外面两层改用软边带（中线不透明、两侧渐变到全透），只有最细的白芯保持实心：
        // 细到几个像素时实心反而是需要的"芯"，不会显得死板。
        const soft = (width, color, alpha) =>
          D.softSeg3(b.startX, sy, b.startY, b.endX, ey, b.endY, width, color, alpha, V.vx, V.vy, V.vz);
        soft(w * BEAM_GLOW_K * breathe, col, fade * (0.14 + charge * 0.30));  // ① 外层辉光
        soft(w * breathe, col, fade * (0.55 + charge * 0.40));                // ② 主体
        D.seg3(b.startX, sy, b.startY, b.endX, ey, b.endY,                    // ③ 白芯（细，实心）
               Math.max(0.6, w * BEAM_CORE_K) * breathe, WHITE,
               fade * (0.30 + charge * 0.60), V.vx, V.vy, V.vz);

        // ==================== ④ 流动：沿光束推进的亮脉冲 ====================
        // 用户："我想要闪电杖的攻击轨迹有流动效果（不是那种虚线的效果，之前做过效果太差）"。
        // 虚线为什么差：它把一条连续的光**切断**成一串短横，读起来是"跑动的破折号"，
        // 光束本身消失了。这里反过来做——光束保持①②③三层连续不动，
        // 在它**上面叠**几团顺着流的亮斑（加算感），于是读到的是"这束光里有东西在跑"。
        //
        // 三个刻意的细节：
        //   · 亮斑的透明度用 sin(πt) 开窗：两端自然收没，不会在塔口/目标处出现硬边，
        //     那种硬边正是"虚线感"的来源。
        //   · 相位仍然逐帧积分（phase += 速度 × dtWall），不是"绝对时间 × 速度"。
        //     后者在速度随充能变化时会瞬移（见本文件头注那段）。
        //   · 速度随充能升高：充满时明显更急，充能过程自带视觉反馈。
        const F = (CONFIG.ui && CONFIG.ui.beamFlow) || {};
        if (F.enabled !== false) {
          const bx = b.endX - b.startX, bz = b.endY - b.startY;
          const blen = Math.hypot(bx, bz);
          if (blen > 4) {
            const spd = (F.speed ?? 200) + charge * (F.speedCharge ?? 320);   // px/s
            let ph = (this._beamPhase.get(b) || 0) + spd * dtWall;
            ph %= blen;
            this._beamPhase.set(b, ph);
            const n = Math.max(1, F.pulses ?? 3);
            const half = Math.max(6, blen * (F.len ?? 0.16)) / 2 / blen;      // 半长（归一化）
            for (let i = 0; i < n; i++) {
              const t = ((ph / blen) + i / n) % 1;
              const win = Math.sin(Math.PI * t);          // 两端收没
              if (win <= 0.03) continue;
              const t0 = Math.max(0, t - half), t1 = Math.min(1, t + half);
              if (t1 - t0 < 1e-3) continue;
              const X0 = b.startX + bx * t0, Z0 = b.startY + bz * t0, Y0 = sy + (ey - sy) * t0;
              const X1 = b.startX + bx * t1, Z1 = b.startY + bz * t1, Y1 = sy + (ey - sy) * t1;
              const aBase = fade * win * (F.alpha ?? 0.5) * (0.35 + 0.65 * charge);
              // 两层：宽的软斑给"体积"，细的白芯给"速度感"
              D.softSeg3(X0, Y0, Z0, X1, Y1, Z1, w * (F.widthK ?? 1.5) * breathe,
                         col, aBase, V.vx, V.vy, V.vz);
              D.softSeg3(X0, Y0, Z0, X1, Y1, Z1, Math.max(0.8, w * BEAM_CORE_K * 2.2) * breathe,
                         WHITE, aBase * 1.1, V.vx, V.vy, V.vz);
            }
          }
        }
      }
    }

    // ---- B3 闪电链电弧：种子确定性锯齿（存活期内形状不变），双层描边，按 ttl 淡出 ----
    if (projectiles?.getArcs) {
      for (const a of projectiles.getArcs()) {
        const alpha = Math.max(0, a.ttl / a.maxTtl);
        if (alpha <= 0) continue;
        const dx = a.endX - a.startX, dy = a.endY - a.startY;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const segs = Math.max(3, Math.min(6, Math.round(len / 30)));
        let seed = a.seed;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
        // 与 2D 完全相同的折点生成（同种子同序列 → 同形状）
        const px = [a.startX], py = [a.startY];
        for (let i = 1; i < segs; i++) {
          const t = i / segs;
          const off = rnd() * Math.min(16, len * 0.18);
          px.push(a.startX + dx * t + nx * off); py.push(a.startY + dy * t + ny * off);
        }
        px.push(a.endX); py.push(a.endY);
        const col = rgbOf(a.color);
        // 电弧两端各自抬到炮口高度，中间锯齿按沿线比例插值
        const ay0 = MY(a.startX, a.startY), ay1 = MY(a.endX, a.endY) * 0.6;
        const hy = (i) => ay0 + (ay1 - ay0) * (i / (px.length - 1));
        for (let i = 1; i < px.length; i++)
          D.seg3(px[i - 1], hy(i - 1), py[i - 1], px[i], hy(i), py[i], 3.5, col, alpha * 0.55, V.vx, V.vy, V.vz);
        for (let i = 1; i < px.length; i++)
          D.seg3(px[i - 1], hy(i - 1), py[i - 1], px[i], hy(i), py[i], 1.2, rgbOf('#ffffff'), alpha, V.vx, V.vy, V.vz);
      }
    }

    // ---- B1 子弹：光晕四边形（贴图）+ 核心亮点 ----
    // Q2：本帧还活着的塔弹尾迹收集在 live 里，帧末与上一帧对比，
    // 消失的那些转入 _fading 做淡出——命中不再是"一整条尾巴瞬间没了"。
    this._fxFrame = (this._fxFrame || 0) + 1;
    const live = [];
    if (projectiles?.getProjectiles) {
      for (const p of projectiles.getProjectiles()) {
        const x = p.currentX !== undefined ? p.currentX : p.startX;
        const y = p.currentY !== undefined ? p.currentY : p.startY;
        const col = rgbOf(p.color || '#e8563f');
        const gsz = p.size || 20;        // v2.5D（Q1）：小兵/巨龙弹丸 12，塔弹 20
        // 高度：出膛时在炮口，飞行中线性降到目标身高的六成（弹着点在躯干而非头顶）。
        // 炮口高度只在【首次见到这发子弹】时解析一次并缓存——攻击者可能移动，
        // 每帧按起点重查会查到别人身上。缓存挂 WeakMap，不写进逻辑对象。
        let my = this._muzzle.get(p);
        if (my === undefined) { my = MY(p.startX, p.startY); this._muzzle.set(p, my); }
        // 飞行进度必须拿【目标当前位置】算全程距离。首版误用了子弹自己的当前位置
        // 兜底（p.targetX 根本不存在），于是分子分母相同、进度恒等于 1，
        // 子弹永远取"终点高度"= 空地 0 → 全程贴地飞。这就是"红线对了子弹没对"的原因。
        // Q1：目标位置与落点高度做成【快照】。旧实现每帧现查 entities.get(p.targetId)，
        // 目标一死就拿不到 → by 退化成常量 my → 子弹从"沿弹道下降"突变为"水平飞"，
        // 这就是"目标死亡后残余弹道异常"。现在死亡后沿用最后一次的快照，弹道继续走完。
        // ⚠️ 刷新条件必须是"目标还【活着】"，不能只判 `tgtE?.pos` 存在。
        // 用户："水晶塔被摧毁留下的弹道轨迹会突然变成平面的（水平的）。"
        // 根因：塔死了会变成**废墟**留在容器里（为了还能被点选），pos 照样在，
        // 于是这里继续每帧刷新 —— 可废墟的模型比塔矮一大截，endHeightOf 返回的
        // 落点高度当场塌下来，整条弹道从"斜着落下"变成"贴着地面平飞"。
        // 与闪电杖光束末端那条是同一类错误（那边是查不到就退化成按坐标反查）。
        const tgtE = entities?.get?.(p.targetId);
        let snap = this._projTgt.get(p);
        if (tgtE?.pos && tgtE.alive) {
          snap = snap || {};
          snap.x = tgtE.pos.x; snap.y = tgtE.pos.y;
          snap.h = endHeightOf(p.targetId, tgtE.pos.x, tgtE.pos.y);
          this._projTgt.set(p, snap);
        } else if (!snap && p.lastTx != null) {
          // 目标在【这发子弹被画出来之前】就已经死了 —— 一次快照都没取到。
          // 于是下面的 by 退化成常量 my（炮口高度），子弹平着飞出去直到消失
          //（用户："塔在攻速快的时候…射出去的子弹就是不变的高度射直至消失"）。
          // 高攻速塔特别容易撞上：开火与目标死亡经常落在同一个逻辑帧里，
          // 中间根本没轮到一次渲染帧，所以"目标活着时先记一笔"这条路走不通。
          // 补法：用 ProjectileSystem 已经冻结好的最后落点（p.lastTx/lastTy）现补一张快照
          // —— 那正是这发子弹实际要飞到的地方（见 ProjectileSystem.update 的 B2 段），
          // 弹道于是照常从炮口斜落到那一点，而不是平飞。
          // 高度用 endHeightOf 查：目标实体已经没了，会退化成按坐标查（≈地面），
          // 也就是"落到它倒下的那块地上"，正是想要的观感。
          snap = { x: p.lastTx, y: p.lastTy, h: endHeightOf(p.targetId, p.lastTx, p.lastTy) };
          this._projTgt.set(p, snap);
        }
        let by = my;
        if (snap) {
          const tot = Math.hypot(snap.x - p.startX, snap.y - p.startY) || 1;
          const done = Math.min(1, Math.hypot(x - p.startX, y - p.startY) / tot);
          by = my + (snap.h - my) * done;
        }
        // 塔弹与兵弹的分野：CombatSystem 按攻击者类型给 size（塔 20 / 兵 12），这里据此
        // 分档。塔弹加拖尾 + 白亮核，兵弹保持两层——同屏兵弹上百，给它们加拖尾只会糊成一片。
        // #10 升温可视化：塔弹随 heat（0..1，穿透弹的升温层数）变"热"——尺寸增大、颜色向
        // 橙白偏、拖尾更亮、外加一层热晕、白芯更粗（参照闪电杖 charge 的做法）。heat=0 与原塔弹一致。
        const isTower = gsz >= 16;
        const heat = isTower ? Math.max(0, Math.min(1, p.heat || 0)) : 0;
        const hsz = gsz * (1 + heat * 0.22);   // Q2：升温放大 0.55 → 0.22，别那么张扬
        let dcol = col;
        if (heat > 0.01) {
          this._heatCol = this._heatCol || new THREE.Color();
          dcol = this._heatCol.copy(col).lerp(HEAT_HOT, heat * 0.75);
        }
        if (isTower) {
          // ---- Q1：拖尾沿真实三维弹道（旧版把残影全放在同一高度、只沿 XZ 回退，
          //      而弹道是斜的，于是尾巴与红线分家 = 用户看到的"拖尾是水平的"）。
          // ---- Q2：收敛张扬度。升温对拖尾的加成从"越热越粗越亮"压到几乎只改颜色，
          //      尾巴也缩短：之前满升温时尾巴又长又亮，喧宾夺主。
          const dx = x - p.startX, dy2 = y - p.startY;
          const d = Math.hypot(dx, dy2);
          if (d > 1) {
            const ux = dx / d, uy2 = dy2 / d;
            const tail = Math.min(d, hsz * TRAIL_LEN);       // 尾巴长度（不超过已飞行距离）
            const tx = x - ux * tail, tz = y - uy2 * tail;
            // 尾端高度：用与弹头相同的插值规则求出该处的路径高度（关键——别再用 by）
            // 尾端高度同样走快照（与弹头同一条路径规则），目标死亡后不再塌到 my
            let ty = by;
            if (snap) {
              const tot = Math.hypot(snap.x - p.startX, snap.y - p.startY) || 1;
              const doneT = Math.min(1, Math.max(0, Math.hypot(tx - p.startX, tz - p.startY) / tot));
              ty = my + (snap.h - my) * doneT;
            }
            this._trail(D, V, tx, ty, tz, x, by, y, hsz, heat, dcol, 1);
            // Q2：记下这一帧的尾迹快照。子弹命中即从列表消失，若不留残影，
            // 一整条尾巴会在命中的那一帧【整体瞬间消失】，看着很突兀（用户反馈）。
            let sn = this._seen.get(p);
            if (!sn) { sn = { col: new THREE.Color() }; this._seen.set(p, sn); }
            sn.tx = tx; sn.ty = ty; sn.tz = tz; sn.x = x; sn.by = by; sn.y = y;
            sn.hsz = hsz; sn.heat = heat; sn.col.copy(dcol); sn.f = this._fxFrame;
            live.push(sn);
          }
          if (heat > 0.01) Q.sprite3(x, by, y, hsz * (1.4 + heat * 0.4), dcol, 0.07 + heat * 0.08, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz); // 热晕（压淡）
        }
        Q.sprite3(x, by, y, hsz, dcol, 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);          // 光晕
        Q.sprite3(x, by, y, hsz * 0.4, dcol, 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);    // 核心
        if (isTower) Q.sprite3(x, by, y, hsz * (0.18 + heat * 0.10), rgbOf('#ffffff'), 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);  // 白亮弹芯
      }
    }

    // ---- Q2 拖尾余烬：本帧不在场的尾迹转入淡出队列，短暂留一下再消失 ----
    for (const [p, sn] of this._seen) {
      if (sn.f === this._fxFrame) continue;          // 还活着
      this._seen.delete(p);
      sn.t = 0;
      this._fading.push(sn);
    }
    for (let i = this._fading.length - 1; i >= 0; i--) {
      const s = this._fading[i];
      s.t += dtWall;
      const k = 1 - s.t / TRAIL_FADE;
      if (k <= 0) { this._fading.splice(i, 1); continue; }
      // 余烬同时缩短：尾端向弹着点收拢，读作"打中后一闪而散"，而不是原地淡掉一整条
      const kk = k * k;
      const sx = s.x + (s.tx - s.x) * kk, sz = s.y + (s.tz - s.y) * kk;
      const sy2 = s.by + (s.ty - s.by) * kk;
      this._trail(D, V, sx, sy2, sz, s.x, s.by, s.y, s.hsz, s.heat, s.col, kk);
    }

    D.flush(); Q.flush();
  }

  stats() { return { dynTri: this._dyn.n, quadTri: this._quad.n, statTri: this._stat.n }; }

  dispose() {
    this._stat.dispose(); this._dyn.dispose(); this._quad.dispose();
    this._glowTex.dispose();
  }
}
