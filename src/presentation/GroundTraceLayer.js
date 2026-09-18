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
    this._snowTex = tex;

    const geo = new THREE.PlaneGeometry(WW, WH, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const C = cfg();
    const mat = new THREE.MeshBasicMaterial({
      color: C.snowCoverColor ?? 0xf4f8fc, transparent: true,
      alphaMap: tex, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(WW / 2, C.snowCoverLift ?? 0.4, WH / 2);
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
    const snowAlphaMax = C.snowCoverAlpha ?? 0.6;
    this._snowMesh.material.opacity = snowAlphaMax;
    // 网格值（0~1 局部雪深）写进 ImageData 的 alpha 通道——alphaMap 只读 alpha，
    // RGB 随便填白色即可（材质颜色由 color 属性统一控制）。
    const img = this._snowImgData;
    const data = img.data;
    const grid = snow.data;
    for (let i = 0; i < grid.length; i++) {
      const v = Math.round(Math.max(0, Math.min(1, grid[i])) * 255);
      const o = i * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
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
