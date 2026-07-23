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
    this._statDirty = true;
  }

  markStaticDirty() { this._statDirty = true; }

  // ============ D 组：静态参照层（切图重建一次） ============
  _rebuildStatic(mapSystem) {
    this._statDirty = false;
    const B = this._stat;
    B.reset();
    const map = mapSystem?.currentMap;

    // D1 背景网格：2D 按视口裁剪，3D 一次性铺满同一个 [-500, 4100] 常量范围
    //（89×2 条线 ≈ 356 三角形，静态零成本，不必再做视口裁剪）
    {
      const STEP = 40, LIM_MIN = -500, LIM_MAX = 4100;
      const col = rgbOf('#ffffff');
      for (let x = LIM_MIN; x < LIM_MAX; x += STEP) B.seg(x, LIM_MIN, x, LIM_MAX, 1, col, 0.06);
      for (let y = LIM_MIN; y < LIM_MAX; y += STEP) B.seg(LIM_MIN, y, LIM_MAX, y, 1, col, 0.06);
    }

    if (mapSystem?.active && map?.world) {
      const { w: WW, h: WH } = map.world;
      // D2 世界边界框
      B.rectStroke(0, 0, WW, WH, 4, rgbOf('#ffffff'), 0.18);
      // D3 双方基地高地扇形（半径与 MapSystem/基地光环同源）
      const baseR = mapSystem.getBaseCircleRadius?.('blue') || WW * 0.37;
      const baseR2 = mapSystem.getBaseCircleRadius?.('red') || baseR;
      B.fan(0, WH, baseR, -Math.PI / 2, 0, rgbOf('#5b9bd5'), 0.07);
      B.fan(WW, 0, baseR2, Math.PI / 2, Math.PI, rgbOf('#e0473f'), 0.07);
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
  update(deps, zoom, lodDots, view, muzzleY) {
    const V = view || { vx: 0, vy: -1, vz: 0, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0 };
    const MY = muzzleY || (() => 0);
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
    const red = rgbOf('#ff3c3c');
    const screenW = (px) => Math.max(0.35, px / (zoom || 1)); // 屏幕恒定 → 世界宽度
    for (const t of entities.getAllTowers(true)) {
      if (!t.targetId) continue;
      if ((window.gameTime || 0) < (t._lockUntil || 0)) continue;
      const tgt = entities.get(t.targetId);
      if (!tgt || !tgt.alive || !tgt.pos) continue;
      D.seg3(t.pos.x, MY(t.pos.x, t.pos.y), t.pos.y,
              tgt.pos.x, MY(tgt.pos.x, tgt.pos.y) * 0.6, tgt.pos.y,
              screenW(0.5), red, 0.5, V.vx, V.vy, V.vz);
    }
    // ---- C2 攻城车攻城红线（略粗，受 LOD 档2 抑制）----
    if (!lodDots) {
      for (const m of entities.getAllMinions(true)) {
        if (!m._ramLockId) continue;
        const tgt = entities.get(m._ramLockId);
        if (!tgt || !tgt.alive || !tgt.pos) continue;
        D.seg3(m.pos.x, MY(m.pos.x, m.pos.y), m.pos.y,
                tgt.pos.x, MY(tgt.pos.x, tgt.pos.y) * 0.6, tgt.pos.y,
                screenW(0.9), red, 0.55, V.vx, V.vy, V.vz);
      }
    }

    // ---- B2 闪电杖光束：辉光 + 流动虚线主体 + 白热核（充能连续过渡）----
    if (projectiles?.getBeams) {
      for (const b of projectiles.getBeams()) {
        const charge = Math.max(0, Math.min(1, b.charge || 0));
        const lineWidth = 1.5 + charge * 3.5;
        const fade = (b.fadeT !== undefined && b.fadeMax) ? Math.max(0, b.fadeT / b.fadeMax) : 1;
        if (fade <= 0) continue;
        const col = rgbOf(b.color || '#f1c40f');
        const dashLen = 5 + charge * 20;
        const gap = dashLen * (1 - charge) * 0.9 + (1 - charge) * 3;
        const flowSpeed = 60 + charge * 160;
        // ① 底层辉光
        const sy = MY(b.startX, b.startY), ey = MY(b.endX, b.endY) * 0.6;
        D.seg3(b.startX, sy, b.startY, b.endX, ey, b.endY, lineWidth + 5 + charge * 9, col,
              fade * (20 + charge * 90) / 255, V.vx, V.vy, V.vz);
        // ② 主体：gap 随充能收缩，>0.4 时走流动虚线，否则退化为实线（与 2D 同判据）
        if (gap > 0.4) {
          const period = dashLen + gap;
          let ph = this._beamPhase.get(b) || 0;
          ph = (ph + flowSpeed * dtWall) % period;   // 积分推进：速度变只改速率，不改位置
          this._beamPhase.set(b, ph);
          // 相位取【正】：本实现里 t 从 phase 起步递增摆放虚线，phase 增大 ⇒ 虚线向终点推进。
          // 首版照搬了 2D 的 `-offset`，但 canvas 的 lineDashOffset 与此处的符号语义相反
          // （前者递减才前进），于是流向整个反了：实测虚线由目标流回塔。
          D.dashed3(b.startX, sy, b.startY, b.endX, ey, b.endY, lineWidth, col, fade,
                    dashLen, gap, ph, V.vx, V.vy, V.vz);
        } else {
          D.seg3(b.startX, sy, b.startY, b.endX, ey, b.endY, lineWidth, col, fade,
                 V.vx, V.vy, V.vz);
        }
        // ③ 白热核：alpha 随充能二次曲线淡入，宽度带脉冲
        const coreA = charge * charge;
        if (coreA > 0.02) {
          const pulse = 1 + Math.sin(wallT * 10) * 0.15 * charge;
          D.seg3(b.startX, sy, b.startY, b.endX, ey, b.endY,
                Math.max(0.8, lineWidth * 0.35) * pulse, rgbOf('#ffffff'), fade * coreA,
                V.vx, V.vy, V.vz);
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
        const tgtE = entities?.get?.(p.targetId);
        let by = my;
        if (tgtE?.pos) {
          const tot = Math.hypot(tgtE.pos.x - p.startX, tgtE.pos.y - p.startY) || 1;
          const done = Math.min(1, Math.hypot(x - p.startX, y - p.startY) / tot);
          by = my + (MY(tgtE.pos.x, tgtE.pos.y) * 0.6 - my) * done;
        }
        // 塔弹与兵弹的分野：CombatSystem 按攻击者类型给 size（塔 20 / 兵 12），这里据此
        // 分档。塔弹加拖尾 + 白亮核，兵弹保持两层——同屏兵弹上百，给它们加拖尾只会糊成一片。
        // #10 升温可视化：塔弹随 heat（0..1，穿透弹的升温层数）变"热"——尺寸增大、颜色向
        // 橙白偏、拖尾更亮、外加一层热晕、白芯更粗（参照闪电杖 charge 的做法）。heat=0 与原塔弹一致。
        const isTower = gsz >= 16;
        const heat = isTower ? Math.max(0, Math.min(1, p.heat || 0)) : 0;
        const hsz = gsz * (1 + heat * 0.55);
        let dcol = col;
        if (heat > 0.01) {
          this._heatCol = this._heatCol || new THREE.Color();
          dcol = this._heatCol.copy(col).lerp(HEAT_HOT, heat * 0.75);
        }
        if (isTower) {
          const dx = x - p.startX, dy2 = y - p.startY;
          const d = Math.hypot(dx, dy2);
          if (d > 1) {
            const ux = dx / d, uy2 = dy2 / d;
            for (let k = 1; k <= 4; k++) {          // 沿来向铺 4 片递减的残影（升温更亮）
              const back = k * hsz * 0.42;
              Q.sprite3(x - ux * back, by, y - uy2 * back,
                        hsz * (1 - k * 0.17), dcol, (0.5 - k * 0.1) * (1 + heat * 0.6), V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);
            }
          }
          if (heat > 0.01) Q.sprite3(x, by, y, hsz * (1.7 + heat * 0.8), dcol, 0.10 + heat * 0.16, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz); // 热晕
        }
        Q.sprite3(x, by, y, hsz, dcol, 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);          // 光晕
        Q.sprite3(x, by, y, hsz * 0.4, dcol, 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);    // 核心
        if (isTower) Q.sprite3(x, by, y, hsz * (0.18 + heat * 0.14), rgbOf('#ffffff'), 1, V.ux, V.uy, V.uz, V.rx, V.ry, V.rz);  // 白亮弹芯（升温更粗）
      }
    }

    D.flush(); Q.flush();
  }

  stats() { return { dynTri: this._dyn.n, quadTri: this._quad.n, statTri: this._stat.n }; }

  dispose() {
    this._stat.dispose(); this._dyn.dispose(); this._quad.dispose();
    this._glowTex.dispose();
  }
}
