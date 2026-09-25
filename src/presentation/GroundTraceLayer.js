/**
 * GroundTraceLayer.js —— 水洼贴花 + 雪盖遮罩渲染（Q4 天气重做 + v54 第二轮重做）
 *
 * 水洼沿用 RainRippleLayer.js 的实例池模式——固定大小的 Mesh 池，共享几何+
 * 各自独立材质（材质只在 _build() 时创建一次，之后只改 position/scale/opacity），
 * 没在用就 visible=false，不逐帧 new 对象。既然水洼本身不是逐帧连续动画的粒子，
 * 没必要维护"这个池槽位对应哪个水洼"这份映射——每帧直接按当前存在的水洼重新
 * 分配池槽位（先到先得），用不完的槽位整体隐藏。
 *
 * ==================== v54：雪盖改用 Canvas alpha 遮罩，不再是实例池 ====================
 * 旧的"雪痕"是短命贴花（跟水洼同一套实例池渲染）；v54 雪盖是【整地图连续的一张
 * 遮罩】，不是离散的点——沿用 WaterLayer.js 的做法：一块覆盖整个地图的平面 +
 * 一张 CanvasTexture 当 alphaMap，只是这张贴图不是静态烘焙一次，而是每帧从
 * GroundTraceSystem 的雪盖网格（Float32Array）里重新写入。网格分辨率很低
 * （默认 48×48），CanvasTexture 用 LinearFilter，GPU 采样时自动双线性插值放大到
 * 铺满全图——同一个"低分辨率网格 + GPU 双线性放大"技巧，PostFX.js 的雾噪声纹理
 * 也是这么做的。
 *
 * 已知简化：雪盖是一整块【平面】，不像水洼那样逐个贴花跟着 heightAt 走——
 * 这张图的地形高度差本来就很小（森林三级梯度，不是深谷悬崖），暂时接受这个
 * 简化，没有另外做一版跟随台阶地形起伏的网格。
 */
import * as THREE from '../../vendor/three.module.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';
import { CONFIG } from '../data/Config.js';

const cfg = () => (CONFIG.ui && CONFIG.ui.groundTraceFx) || {};

// 实心软边圆贴图：中心不透明、向外羽化，程序生成，无外部素材（同 RainRippleLayer
// 的 makeRingTexture 思路，这里要的是实心圆而不是一圈环）。
function makeDiscTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GroundTraceLayer {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this._built = false;
    this._puddlePool = [];
    this._snowMesh = null;
    this._snowTex = null;
    this._snowCanvas = null;
    this._snowMapId = null;
  }

  _build() {
    if (this._built) return;
    const C = cfg();
    this._tex = makeDiscTexture();
    this._geo = new THREE.PlaneGeometry(1, 1);
    this._geo.rotateX(-Math.PI / 2);
    const maxPuddle = Math.max(1, C.maxPuddleCircles ?? 150);
    const mk = (color) => {
      const mat = new THREE.MeshBasicMaterial({
        map: this._tex, color, transparent: true, opacity: 0, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.visible = false;
      // 半透明贴花排除出法线/深度预渲染，同 RainRippleLayer 的理由：
      // 否则会在描边/SSAO 里画出一圈假轮廓。
      mesh.layers.set(FX_PARTICLE_LAYER);
      mesh.frustumCulled = false;
      mesh.renderOrder = 24; // 水面波纹（25）之下一点，贴花本来就该先于波纹铺在地上
      this.scene.add(mesh);
      return { mesh };
    };
    for (let i = 0; i < maxPuddle; i++) this._puddlePool.push(mk(C.puddleColor ?? 0x5b8fb0));
    this._built = true;
  }

  /** 建/重建雪盖平面——跟当前地图尺寸绑定，换图时重建（同 WaterLayer._mapId 的判同方式）。 */
  _ensureSnowMesh(mapSystem, resolution) {
    const map = mapSystem?.currentMap;
    if (!map || !map.world) return;
    if (this._snowMesh && this._snowMapId === map.id && this._snowRes === resolution) return;
    this._disposeSnowMesh();
    this._snowMapId = map.id;
    this._snowRes = resolution;

    const { w: WW, h: WH } = map.world;
    const c = document.createElement('canvas');
    c.width = c.height = resolution;
    this._snowCanvas = c;
    this._snowImgData = c.getContext('2d').createImageData(resolution, resolution);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // 积雪材质差异化（v55.1）：这张纹理现在也当 map（颜色）用，不再只是 alphaMap——
    // 同文件里 makeDiscTexture 那张贴图同样是"程序生成 Canvas 当 map 用"，一样
    // 标了 SRGBColorSpace，这里跟它对齐，颜色管线口径统一。
    tex.colorSpace = THREE.SRGBColorSpace;
    this._snowTex = tex;

    const C = cfg();
    // v55.5 修复："野区雪盖看着还是绿的"真根因——不是颜色/透明度算错，是【几何
    // 高度错了】。这块雪盖原来是整块【单一 Y 值的平面】（1×1 分段，Y 固定
    // =snowCoverLift≈0.4），头注里"地形高度差本来就很小……暂时接受这个简化"这个
    // 前提在森林风格地图上并不成立——实测野区台阶地形 heightAt 能到 6~10 世界
    // 单位（v58 森林三级梯度），而雪盖平面固定卡在 0.4，比野区地面矮了一大截。
    // 结果是野区地面几何体本身就比雪盖高，深度测试里雪盖被野区地形整个挡在下面
    // ——根本没画出来，跟贴图里雪深/颜色/alpha 写没写对毫无关系（之前排查只查了
    // Canvas 纹理数据本身，没有连着实际渲染出的画面一起核对，才把"贴图对了"
    // 误判成"整条链路都对了"）。路面 heightAt=0，跟雪盖原来的 0.4 差得不多，
    // 所以路面从来没暴露过这个问题。
    // 修法：雪盖平面改成跟 ThreeRenderer._rebuildTerrain 同一套做法——按同样密度
    // 细分网格，逐顶点用 heightAt 抬到地形实际高度，再统一加 snowCoverLift 的
    // 小幅离地量避免 z-fighting。地图没有 heightAt（老式非台阶地图）时全部
    // 顶点仍是 Y=snowCoverLift，等价于修复前的整块平面，画面不变。
    const segX = Math.max(1, Math.round(WW / 24)), segZ = Math.max(1, Math.round(WH / 24));
    const geo = new THREE.PlaneGeometry(WW, WH, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const lift = C.snowCoverLift ?? 0.4;
    if (mapSystem?.heightAt) {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, mapSystem.heightAt(WW / 2 + pos.getX(i), WH / 2 + pos.getZ(i)) + lift);
      }
      pos.needsUpdate = true;
    }
    // 积雪材质差异化（v55.1）：material.color 改成中性白——真正的颜色现在按格
    // 写进纹理的 RGB 通道（路面/野区各自的颜色，见 update() 里的写入逻辑），
    // 不再是整块平面统一吃一个 tint。地图没有森林分区数据时纹理 RGB 处处等于
    // 旧的 snowCoverColor，等价于"白色材质 × 旧颜色纹理" = 旧颜色，画面不变。
    // map 和 alphaMap 都指向同一张纹理——alphaMap 只读它的 alpha 通道（雪深），
    // map 读它的 RGB 通道（颜色）；两者本来就是同一份 ImageData 的不同通道，
    // 没必要建两张纹理各读各的。
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true,
      map: tex, alphaMap: tex, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(WW / 2, mapSystem?.heightAt ? 0 : lift, WH / 2);
    mesh.renderOrder = 23; // 压在水洼贴花（24）之下——雪盖是更底层的地表状态
    this.scene.add(mesh);
    this._snowMesh = mesh;
  }

  _disposeSnowMesh() {
    if (this._snowMesh) {
      this.scene.remove(this._snowMesh);
      this._snowMesh.geometry.dispose();
      this._snowMesh.material.dispose();
      this._snowMesh = null;
    }
    if (this._snowTex) { this._snowTex.dispose(); this._snowTex = null; }
    this._snowCanvas = null;
    this._snowImgData = null;
  }

  setEnabled(v) {
    this.enabled = v !== false;
    if (!this.enabled) this._hideAll();
  }

  _hideAll() {
    for (const s of this._puddlePool) s.mesh.visible = false;
    if (this._snowMesh) this._snowMesh.material.opacity = 0;
  }

  /**
   * @param groundTraceSystem GroundTraceSystem 实例（window.__groundTrace）
   * @param mapSystem 用来查 heightAt(x,z)，水洼贴花跟着台阶地形走；没有就当平地(0)
   */
  update(groundTraceSystem, mapSystem) {
    if (!this.enabled || !groundTraceSystem) { if (this._built) this._hideAll(); return; }
    this._build();
    const C = cfg();
    const baseAlpha = C.alpha ?? 0.45;
    const heightAt = mapSystem?.heightAt ? (x, z) => mapSystem.heightAt(x, z) : () => 0;

    let pi = 0;
    for (const p of groundTraceSystem.getPuddles()) {
      if (p.strength <= 0) continue;
      for (const so of p.subOffsets) {
        if (pi >= this._puddlePool.length) break;
        const x = p.x + so.dx, z = p.y + so.dy;
        const slot = this._puddlePool[pi++];
        slot.mesh.position.set(x, heightAt(x, z) + 0.35, z);
        slot.mesh.scale.set(so.r, 1, so.r);
        slot.mesh.material.opacity = baseAlpha * p.strength;
        slot.mesh.visible = true;
      }
      if (pi >= this._puddlePool.length) break;
    }
    for (let i = pi; i < this._puddlePool.length; i++) this._puddlePool[i].mesh.visible = false;

    const snow = groundTraceSystem.getSnowCover?.();
    if (!snow) { if (this._snowMesh) this._snowMesh.material.opacity = 0; return; }
    this._ensureSnowMesh(mapSystem, snow.resolution);
    if (!this._snowMesh) return;
    // v55.4 修复：material.opacity 是整块平面共用的一个标量，纹理 alpha 通道只能在
    // 【它以内】按局部雪深往下调，调不出它的上限——之前野区局部雪深拉满时纹理
    // alpha 也顶到 255，等效不透明度正好卡在 snowCoverAlpha（0.6）这个天花板，
    // 跟路面雪深拉满时的效果完全一样，这正是"野区雪盖看着还是绿的"的根源。
    // 改法：material.opacity 固定为 1（不再是可变天花板），把 snowCoverAlpha
    // 本身也一起编码进纹理 alpha 通道——路面用原始 snowCoverAlpha 当上限，野区用
    // snowCoverAlpha × snowCoverJungleAlphaBoost 当上限（按 zoneMix 线性插值），
    // 这样野区雪深拉满时才能真正冲到 0.9 那种更白的不透明度，路面上限不变，
    // 数学上跟改动前逐位一致（0.6×1=0.6，material.opacity=1 抵消了原来的 0.6）。
    const snowAlphaMax = C.snowCoverAlpha ?? 0.6;
    this._snowMesh.material.opacity = 1;
    // 网格值（0~1 局部雪深）写进 ImageData 的 alpha 通道；RGB 通道现在也不再是
    // 写死的白——积雪材质差异化（v55.1）：按 zoneMix（0=路面，1=野区）在
    // pathColor/jungleColor 之间线性插值。zoneMix 为 null（地图没有森林分区
    // 数据）时退回纯 pathColor，逐位等于改动前"整块统一 snowCoverColor"的画面。
    const img = this._snowImgData;
    const data = img.data;
    const grid = snow.data;
    const zoneMix = snow.zoneMix;
    const pathHex = C.snowCoverColor ?? 0xf4f8fc;
    const jungleHex = C.snowCoverJungleColor ?? 0xffffff;
    const pr = (pathHex >> 16) & 255, pg = (pathHex >> 8) & 255, pb = pathHex & 255;
    const jr = (jungleHex >> 16) & 255, jg = (jungleHex >> 8) & 255, jb = jungleHex & 255;
    // 同一档 snowCoverAlpha 在路面（浅色）和野区（饱和绿/紫）上观感天差地别——哪怕
    // 野区局部雪深已经拉满，60%不透明度混出来的颜色在饱和度高的野区底色上仍然
    // "看得出底色"，被用户报成"野区依旧没有雪覆盖"（详见 Config.js
    // groundTraceFx.snowCoverJungleAlphaBoost 头注，那边有具体的 RGB 混合计算）。
    // 野区（zoneMix=1）的不透明度上限按 jungleAlphaBoost 放大，路面（zoneMix=0）
    // 上限沿用原始 snowCoverAlpha，逐位不变。
    const jungleAlphaBoost = C.snowCoverJungleAlphaBoost ?? 1;
    const jungleAlphaMax = Math.min(1, snowAlphaMax * jungleAlphaBoost);
    for (let i = 0; i < grid.length; i++) {
      const depth = Math.max(0, Math.min(1, grid[i]));
      const t = zoneMix ? zoneMix[i] : 0;
      const alphaCap = snowAlphaMax + (jungleAlphaMax - snowAlphaMax) * t;
      const v = Math.round(depth * alphaCap * 255);
      const o = i * 4;
      data[o] = pr + (jr - pr) * t;
      data[o + 1] = pg + (jg - pg) * t;
      data[o + 2] = pb + (jb - pb) * t;
      data[o + 3] = v;
    }
    this._snowCanvas.getContext('2d').putImageData(img, 0, 0);
    this._snowTex.needsUpdate = true;
  }

  dispose() {
    if (this._built) {
      for (const s of this._puddlePool) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
      }
      this._geo?.dispose();
      this._tex?.dispose();
      this._puddlePool = [];
      this._built = false;
    }
    this._disposeSnowMesh();
    this._snowMapId = null;
  }
}
