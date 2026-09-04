/**
 * WallLayer.js —— 墙体挤出（2.5D 迁移第 6.2 步）
 *
 * ===== 单一事实来源 =====
 * 几何全部由 `MapSystem.isWalkable(x, y)` 采样得来——那是碰撞系统用的同一个判据。
 * 因此"看着能走的地方"和"实际能走的地方"在结构上不可能分叉。
 * 绝不在这里另写一份走廊/基地圈的几何推导：那会立刻产生两套真相。
 *
 * ===== 为什么不是"给墙区做三角剖分" =====
 * 墙区 = 世界矩形 减去（三条走廊胶囊 ∪ 两个基地圆）的补集，是带洞的任意多边形，
 * 精确剖分代价高且易出退化三角形。这里用两件便宜且稳的东西拼出同样的观感：
 *
 *   ① 顶面 = 一张【和地面同尺寸同 UV 的平面】抬到 WALL_H，套一张 alpha 遮罩：
 *      走廊处透明、墙区不透明。于是顶面只花 2 个三角形，纹理与地面天然对齐
 *      （复用同一张地形贴图，抬起来的部分保持原有配色）。
 *      用 alphaTest 而不是 transparent：前者按不透明物体渲染，无排序问题、能正确投影。
 *   ② 崖面 = 逐格边生成的竖直四边形。对每个墙格，若某个邻格可走，就在那条边上
 *      立一片从 y=0 到 y=WALL_H 的墙皮。天然处理任意形状，包括洞和孤岛。
 *
 * 崖面因此是 CELL 粒度的阶梯边，不是光滑曲线。这是刻意取舍：低多边形风格里
 * 碎块状岩壁本就成立，而换取的是"绝不与碰撞分叉"和实现上的简单可靠。
 *
 * 采样成本在切图时一次性付清（isWalkable 每次要遍历三条折线），故 CELL 不宜过小；
 * 实测见 buildStats()，超预算时调大 CELL 即可，几何逻辑不变。
 */
import * as THREE from '../../vendor/three.module.js';

const CELL = 8;            // 采样格边长（世界单位）。崖面阶梯粒度 = 此值
// 墙体高度。走廊半宽 130，取其一半略多，俯视 45° 下不会糊住走廊。
// export：植被层要把树/岩摆在**墙顶**而不是地面高度（见 VegetationLayer 的说明）。
export const WALL_H = 70;
const CLIFF_COLOR = 0x2a3142;   // 崖面色：比地形底色略深，与顶面拉开层次
// 崖壁贴图横向平铺尺寸（世界单位）。140 时一整张 1024 图挤进 140 单位，拉近看碎得像噪点；
// 300 让单块岩石约 30 单位（与小兵同量级），拉到 200%+ 也读得出结构。
const CLIFF_TILE = 300;
const ORDER_WALL = 2;      // 地面(0) < 墙体(2) < 贴地环(5)

// P1：程序化岩石法线贴图——给崖面加起伏（原本是纯平贴图，斜光下像贴纸）。
// 值域用整数周期的多频正弦叠加，平铺无缝；只生成一次，全崖面共享。
let _rockNrm = null;
function rockNormalTexture(size = 256) {
  if (_rockNrm) return _rockNrm;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const TAU = Math.PI * 2;
  const H = (u, v) =>
      Math.sin((u * 5 + v * 3) * TAU) * 0.35
    + Math.sin((u * 11 - v * 7) * TAU) * 0.18
    + Math.sin((u * 2 + v * 13) * TAU) * 0.12;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, e = 1 / size;
      const h = H(u, v);
      const nx = -(H(u + e, v) - h) / e * 0.05, ny = -(H(u, v + e) - h) / e * 0.05, nz = 1;
      const L = Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
      img.data[i]     = (nx / L * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / L * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / L * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _rockNrm = new THREE.CanvasTexture(c);
  _rockNrm.wrapS = _rockNrm.wrapT = THREE.RepeatWrapping;
  _rockNrm.repeat.set(6, 2);
  return _rockNrm;
}

export class WallLayer {
  constructor(scene) {
    this.scene = scene;
    this.top = null;
    this.cliff = null;
    this.grid = null;
    this._maskTex = null;
    this._stats = null;
    this.shadowLevel = 'off';
    this.cliffTex = null;    // 第 6.5 步：崖壁材质贴图（异步加载完由 ThreeRenderer 注入）
  }

  setCliffTexture(tex) { this.cliffTex = tex; }

  setShadowLevel(level) {
    this.shadowLevel = level;
    const on = level !== 'off';
    if (this.top) { this.top.castShadow = on; this.top.receiveShadow = on; }
    if (this.cliff) { this.cliff.castShadow = on; this.cliff.receiveShadow = on; }
  }

  clear() {
    for (const m of [this.top, this.cliff]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.top = this.cliff = null;
    if (this._maskTex) { this._maskTex.dispose(); this._maskTex = null; }
    this._stats = null;
  }

  /**
   * 重建墙体。terrainTex 复用地面那张贴图（顶面与地面配色一致）。
   * mapSystem 无墙时（无 walls 声明的地图）直接清空返回。
   */
  rebuild(mapSystem, terrainTex) {
    this.clear();
    if (!mapSystem?.hasWalls?.() || !mapSystem.currentMap?.world) return;
    // 2026-09-04：风格化 demo（见 Config.stylizedVisuals 头注）——不可走区域不再
    // 抬高成岩壁台地，改由 VegetationLayer 用更密的树/灌木在原地形高度上标出边界
    // （参照实拍截图："墙"是贴边的细栅栏/树林，不是大块岩壁台地）。这张图直接
    // 走"无墙地图"同一条早退路径，什么都不画；三张老地图这个分支永远不命中。
    if (mapSystem.currentMap.visualStyle === 'stylized') return;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const { w: WW, h: WH } = mapSystem.currentMap.world;
    const nx = Math.ceil(WW / CELL), ny = Math.ceil(WH / CELL);

    // ---- 采样：格心是否可走。这是唯一一次调用 isWalkable，之后全部读这张表 ----
    const walk = this._sample(mapSystem, nx, ny);
    const isWall = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? 1 : !walk[j * nx + i];

    // ---- ① 顶面遮罩：墙区不透明。线性过滤 + alphaTest 0.5 让边界落在格间中点，
    //        有效精度约半格，比纯格点量化更贴合真实边界。----
    const mc = document.createElement('canvas');
    mc.width = nx; mc.height = ny;
    const mg = mc.getContext('2d');
    const img = mg.createImageData(nx, ny);
    // ⚠ three 的 alphaMap 取【绿色通道】，不是 alpha 通道：
    //     diffuseColor.a *= texture2D( alphaMap, uv ).g;   （已核对 vendor 内着色器源码）
    // 首版只写了 alpha 通道、RGB 全 0，于是绿通道处处为 0 → 顶面在颜色和阴影两个 pass 里
    // 被整片丢弃，高地根本没画出来。这里把遮罩值写进 RGB（A 一并给满，便于人工查看）。
    for (let k = 0; k < nx * ny; k++) {
      const v = walk[k] ? 0 : 255;
      img.data[k * 4] = v; img.data[k * 4 + 1] = v; img.data[k * 4 + 2] = v; img.data[k * 4 + 3] = 255;
    }
    mg.putImageData(img, 0, 0);

    const maskTex = new THREE.CanvasTexture(mc);
    // 贴图 v 轴与世界 y 轴相反（与地面同一约定），故遮罩需上下翻转以对齐
    maskTex.flipY = true;
    maskTex.needsUpdate = true;
    this._maskTex = maskTex;

    const topGeo = new THREE.PlaneGeometry(WW, WH);
    topGeo.rotateX(-Math.PI / 2);
    const topMat = new THREE.MeshLambertMaterial({
      map: terrainTex, alphaMap: maskTex, transparent: false, alphaTest: 0.5,
    });
    this.top = new THREE.Mesh(topGeo, topMat);
    this.top.position.set(WW / 2, WALL_H, WH / 2);
    this.top.renderOrder = ORDER_WALL;
    this.scene.add(this.top);

    // ---- ② 崖面：墙格与可走邻格之间立墙皮 ----
    const pos = [], nrm = [], uv = [];
    const quad = (ax, az, bx, bz, nxv, nzv) => {
      // 竖直四边形：(a,0) (b,0) (b,H) (a,H)，两三角
      // 绕序必须与外法线一致：three 判正面看【顶点绕序】而不是法线属性，材质又是默认
      // FrontSide。首版把两个三角都排反了（实测 6812/6812 全部反向），于是所有朝外的
      // 崖面被背面剔除——几何、高度、遮罩、深度全对，唯独墙皮从走廊侧看根本不存在。
      // 不用 DoubleSide 兜底：那会掩盖同类错误，还让这批三角的填充率翻倍。
      const v = [ax, 0, az, bx, WALL_H, bz, bx, 0, bz, ax, 0, az, ax, WALL_H, az, bx, WALL_H, bz];
      for (const c of v) pos.push(c);
      for (let k = 0; k < 6; k++) { nrm.push(nxv, 0, nzv); }
      // UV：u 取【沿墙的世界坐标】除以平铺尺寸——相邻墙皮因此自动接续，不必显式累计弧长；
      // v 固定 0→1 只贴一遍，正好绕开崖壁贴图上下方向的接缝（它只需要横向可平铺）。
      const ua = (nxv !== 0 ? az : ax) / CLIFF_TILE, ub = (nxv !== 0 ? bz : bx) / CLIFF_TILE;
      // v 只取 WALL_H/CLIFF_TILE 而不是 0~1：贴图是方的，若竖直方向硬铺满 70 单位高的墙，
      // 而水平方向一格 300 单位，岩石就会被横向拉伸 4 倍。按同一世界尺度取一条横带，像素才是方的。
      const vh = WALL_H / CLIFF_TILE;
      uv.push(ua, 0, ub, vh, ub, 0, ua, 0, ua, vh, ub, vh);   // 与上面的新绕序一一对应
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!isWall(i, j)) continue;
        const x0 = i * CELL, x1 = x0 + CELL, z0 = j * CELL, z1 = z0 + CELL;
        // 法线朝向可走的一侧（外法线），保证受光正确
        if (!isWall(i - 1, j)) quad(x0, z1, x0, z0, -1, 0);
        if (!isWall(i + 1, j)) quad(x1, z0, x1, z1, 1, 0);
        if (!isWall(i, j - 1)) quad(x0, z0, x1, z0, 0, -1);
        if (!isWall(i, j + 1)) quad(x1, z1, x0, z1, 0, 1);
      }
    }

    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
      // P1：加程序化岩石法线 → 崖面在斜光下有真实起伏，不再像一张贴纸。
      // 无 tangent 属性时 three 用屏幕导数求切空间，普通网格可直接用。
      const m = new THREE.MeshLambertMaterial({ color: this.cliffTex ? 0xffffff : CLIFF_COLOR,
                                                map: this.cliffTex || null,
                                                normalMap: rockNormalTexture(),
                                                normalScale: new THREE.Vector2(0.9, 0.9) });
      this.cliff = new THREE.Mesh(g, m);
      this.cliff.renderOrder = ORDER_WALL;
      this.scene.add(this.cliff);
    }

    this.setShadowLevel(this.shadowLevel);
    this.grid = { walk, nx, ny };   // 第 6.5 步：材质合成按同一张网格分区，避免二次采样
    this._stats = {
      cells: nx * ny,
      wallCells: nx * ny - walk.reduce((a, b) => a + b, 0),
      cliffTris: pos.length / 9,
      buildMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
    };
  }

  /**
   * 分层采样：先按 BLOCK×BLOCK 粗采一遍，只有【邻块结论不同】的粗块才逐格细采，
   * 内部均匀的粗块整块继承粗采结论。isWalkable 每次要遍历三条折线，是全流程唯一的
   * 热点，这一步把调用量砍到约 1/4。
   *
   * 正确性前提：最小可走特征宽度 > 粗块边长。走廊全宽 = 2×corridorHalfWidth = 260、
   * 基地圈半径近千，而粗块只有 CELL×BLOCK = 32，余量两个数量级。
   * verify_walls.mjs 里有一条"与暴力逐格采样逐字节相同"的断言守着这个前提——
   * 将来若有地图声明出极窄走廊，那条断言会先炸，不会静默画错。
   */
  _sample(mapSystem, nx, ny, BLOCK = 4) {
    const walk = new Uint8Array(nx * ny);
    const bx = Math.ceil(nx / BLOCK), by = Math.ceil(ny / BLOCK);
    const coarse = new Uint8Array(bx * by);
    for (let bj = 0; bj < by; bj++) {
      for (let bi = 0; bi < bx; bi++) {
        const cx = Math.min(nx - 1, bi * BLOCK + (BLOCK >> 1)) + 0.5;
        const cy = Math.min(ny - 1, bj * BLOCK + (BLOCK >> 1)) + 0.5;
        coarse[bj * bx + bi] = mapSystem.isWalkable(cx * CELL, cy * CELL) ? 1 : 0;
      }
    }
    const cAt = (bi, bj) => coarse[Math.min(by - 1, Math.max(0, bj)) * bx
                                 + Math.min(bx - 1, Math.max(0, bi))];
    for (let bj = 0; bj < by; bj++) {
      for (let bi = 0; bi < bx; bi++) {
        const v = coarse[bj * bx + bi];
        // 必须查【八邻域】：只查四邻会漏掉"对角块结论不同、四邻相同"的边界拐角，
        // 实测在 197136 格里漏 3 格——正确性断言当场抓到，故此处不得退回四邻。
        let uniform = true;
        for (let dj = -1; dj <= 1 && uniform; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (cAt(bi + di, bj + dj) !== v) { uniform = false; break; }
          }
        }
        const i1 = Math.min(nx, (bi + 1) * BLOCK), j1 = Math.min(ny, (bj + 1) * BLOCK);
        for (let j = bj * BLOCK; j < j1; j++) {
          for (let i = bi * BLOCK; i < i1; i++) {
            walk[j * nx + i] = uniform ? v
              : (mapSystem.isWalkable((i + 0.5) * CELL, (j + 0.5) * CELL) ? 1 : 0);
          }
        }
      }
    }
    return walk;
  }

  /** 暴力逐格采样，仅供验证脚本比对用（不参与运行时路径） */
  _sampleBrute(mapSystem, nx, ny) {
    const walk = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        walk[j * nx + i] = mapSystem.isWalkable((i + 0.5) * CELL, (j + 0.5) * CELL) ? 1 : 0;
      }
    }
    return walk;
  }

  buildStats() { return this._stats; }
}
