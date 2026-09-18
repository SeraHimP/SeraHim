/**
 * GroundTraceLayer.js —— 水洼/雪痕的地面贴花渲染（Q4 天气重做，可视化落地）
 *
 * 参考先例：RainRippleLayer.js 的实例池模式——固定大小的 Mesh 池，共享几何+
 * 各自独立材质（材质只在 _build() 时创建一次，之后只改 position/scale/opacity），
 * 没在用就 visible=false，不逐帧 new 对象。
 *
 * 与 RainRippleLayer 的关键差异：那边渲染的是"短命粒子"（各自有独立的 life/dur
 * 状态，需要稳定的池槽位归属）；这里渲染的是 GroundTraceSystem 里"长期存在、
 * 缓慢变化"的水洼/雪痕（水洼的子圆列表会因合并而增减，雪痕点持续产生/过期）。
 * 既然这些形状本身就不是逐帧连续动画的粒子，没必要维护"这个池槽位对应哪个
 * 痕迹"这份映射——每帧直接按当前存在的痕迹重新分配池槽位（先到先得），
 * 用不完的槽位整体隐藏。比对象池的增删记账简单得多，视觉上完全等价。
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
    this._trailPool = [];
  }

  _build() {
    if (this._built) return;
    const C = cfg();
    this._tex = makeDiscTexture();
    this._geo = new THREE.PlaneGeometry(1, 1);
    this._geo.rotateX(-Math.PI / 2);
    const maxPuddle = Math.max(1, C.maxPuddleCircles ?? 150);
    const maxTrail = Math.max(1, C.maxTrailPoints ?? 150);
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
    for (let i = 0; i < maxTrail; i++) this._trailPool.push(mk(C.trailColor ?? 0xdbe9f4));
    this._built = true;
  }

  setEnabled(v) {
    this.enabled = v !== false;
    if (!this.enabled) this._hideAll();
  }

  _hideAll() {
    for (const s of this._puddlePool) s.mesh.visible = false;
    for (const s of this._trailPool) s.mesh.visible = false;
  }

  /**
   * @param groundTraceSystem GroundTraceSystem 实例（window.__groundTrace）
   * @param mapSystem 用来查 heightAt(x,z)，贴花跟着台阶地形走；没有就当平地(0)
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

    let ti = 0;
    for (const t of groundTraceSystem.getTrails()) {
      const fade = 1 - t.age / t.lifetime;
      if (fade <= 0) continue;
      if (ti >= this._trailPool.length) break;
      const slot = this._trailPool[ti++];
      slot.mesh.position.set(t.x, heightAt(t.x, t.y) + 0.3, t.y);
      slot.mesh.scale.set(t.r, 1, t.r);
      slot.mesh.material.opacity = baseAlpha * fade;
      slot.mesh.visible = true;
    }
    for (let i = ti; i < this._trailPool.length; i++) this._trailPool[i].mesh.visible = false;
  }

  dispose() {
    if (!this._built) return;
    for (const s of [...this._puddlePool, ...this._trailPool]) {
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
    }
    this._geo?.dispose();
    this._tex?.dispose();
    this._puddlePool = [];
    this._trailPool = [];
    this._built = false;
  }
}
