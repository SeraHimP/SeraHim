/**
 * RainRippleLayer.js —— 雨滴打在水面上的波纹（Phase 1：天气×环境交互）
 *
 * ==================== 为什么不直接改水面材质 ====================
 * WaterLayer.js 的水面已经叠了三层东西：Canvas 生成的河带 alpha 遮罩、涟漪法线贴图、
 * 逐帧滚动的 UV（模拟水在流）。把"雨滴撞击"也塞进那个 shader，会把"水流模拟"和
 * "天气驱动的撞击特效"焊死在一起——以后想单独调雨的强度/单独关掉水流效果都会
 * 互相牵连。这里另开一条完全独立的小层：只在河道范围内生成一批短命的、从小到大
 * 扩散并淡出的波纹环，叠加渲染在水面之上，不读也不写水面材质的任何一个属性。
 *
 * ==================== 生成点只在真正的水面上 ====================
 * 不整图撒点、也不建立一份"哪里是水"的第二套判据——直接复用 MapSystem.riverFactor
 * （WaterLayer 的河带遮罩用的就是它），沿河道对角线（x=z，riverFactor 内部约定）
 * 附近随机取点，riverFactor 太低（岸边羽化段/没有河）就重试，重试几次都不中就放弃
 * 这一次生成，不报错、不阻塞。
 *
 * ==================== 性能纪律 ====================
 * 与 CorrosionLayer.js 同一个模式：固定大小的实例池（共享几何+各自独立的材质，
 * 材质只在 _build() 时创建一次，之后只改 opacity/scale），没有波纹在用就整体
 * visible=false，不逐帧 new 任何对象、不逐帧建立/销毁网格。
 */
import * as THREE from '../../vendor/three.module.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';
import { CONFIG } from '../data/Config.js';

const cfg = () => (CONFIG.ui && CONFIG.ui.rainRippleFx) || {};

// 环形软边贴图：透明中心 + 一圈亮环 + 向外羽化，程序生成，无外部素材。
function makeRingTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  const grad = g.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RainRippleLayer {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this._built = false;
    this._pool = [];       // { mesh, life, dur, active }
    this._spawnAcc = 0;
  }

  _build() {
    if (this._built) return;
    const C = cfg();
    const max = Math.max(1, C.maxRipples ?? 24);
    this._tex = makeRingTexture();
    this._geo = new THREE.PlaneGeometry(1, 1);
    this._geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this._tex, color: 0xbcd6f0, transparent: true, opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.visible = false;
      // 排除出法线深度预渲染，跟雨/雪粒子同一个理由（PostFX.js 的 FX_PARTICLE_LAYER 头注）：
      // 半透明面被当成不透明几何预渲染会在描边/SSAO 里画出一圈假轮廓。
      mesh.layers.set(FX_PARTICLE_LAYER);
      mesh.frustumCulled = false;
      mesh.renderOrder = 25;   // 水面（WaterLayer renderOrder=1）之上，天气粒子（30+）之下
      this.scene.add(mesh);
      this._pool.push({ mesh, life: 0, dur: 1, active: false });
    }
    this._built = true;
  }

  setEnabled(v) {
    this.enabled = v !== false;
    if (!this.enabled) this._hideAll();
  }

  _hideAll() {
    for (const r of this._pool) { r.active = false; r.mesh.visible = false; }
  }

  /**
   * @param waterLayer WaterLayer 实例；只有 .mesh 存在（这张图真的建出了水面）才生成波纹
   * @param mapSystem  取 riverFactor / currentMap.world
   * @param weather    WeatherSystem；读雨的 charge
   * @param dt         墙钟秒
   */
  update(waterLayer, mapSystem, weather, dt) {
    if (!this.enabled || !waterLayer?.mesh || !weather || !weather.enabled) {
      if (this._built) this._hideAll();
      return;
    }
    this._build();
    const C = cfg();
    const rain = Math.max(0, Math.min(1, weather.getCharge ? (weather.getCharge('rain') || 0) : 0));
    if (rain <= 0.02) { this._hideAll(); return; }

    const rate = (C.spawnRatePerSec ?? 6) * rain;
    this._spawnAcc += rate * dt;
    let guard = 0;
    while (this._spawnAcc >= 1 && guard++ < 8) {   // 上限防止长时间掉帧后一次性猛烈补发
      this._spawnAcc -= 1;
      this._trySpawn(waterLayer, mapSystem, C);
    }

    const growTo = C.maxRadius ?? 55;
    for (const r of this._pool) {
      if (!r.active) continue;
      r.life += dt;
      const t = r.life / r.dur;
      if (t >= 1) { r.active = false; r.mesh.visible = false; continue; }
      const rad = 4 + growTo * t;
      r.mesh.scale.set(rad, 1, rad);
      // 起来快、消失慢：模拟水波"猛地一下扩散、慢慢淡出"，不是线性淡入淡出。
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      r.mesh.material.opacity = (C.alpha ?? 0.55) * fade;
    }
  }

  _trySpawn(waterLayer, mapSystem, C) {
    const free = this._pool.find((r) => !r.active);
    if (!free) return;
    const map = mapSystem?.currentMap;
    if (!map || !map.world) return;
    const { w: WW, h: WH } = map.world;
    const half = map.heightZones?.riverHalfWidth ?? 200;
    const tries = 6;
    for (let i = 0; i < tries; i++) {
      // 河带沿主对角线 x=z：先在对角线上取一个位置，再加一段垂直于对角线的
      // 侧向偏移——比整图网格采样找水快得多，找不到（这张图没有河）就放弃。
      const s = Math.random() * Math.min(WW, WH);
      const d = (Math.random() - 0.5) * half * 0.9;   // 沿垂直于对角线方向的偏移
      const x = s + d * Math.SQRT1_2, z = s - d * Math.SQRT1_2;
      if (x < 0 || x > WW || z < 0 || z > WH) continue;
      if (mapSystem.riverFactor(x, z) < (C.minRiverFactor ?? 0.6)) continue;
      free.mesh.position.set(x, waterLayer.mesh.position.y + 0.6, z);
      free.mesh.scale.set(4, 1, 4);
      free.mesh.visible = true;
      free.life = 0;
      free.dur = (C.durMin ?? 0.6) + Math.random() * Math.max(0, (C.durMax ?? 1.1) - (C.durMin ?? 0.6));
      free.active = true;
      return;
    }
  }

  dispose() {
    if (!this._built) return;
    for (const r of this._pool) { this.scene.remove(r.mesh); r.mesh.material.dispose(); }
    this._geo?.dispose();
    this._tex?.dispose();
    this._pool = [];
    this._built = false;
  }
}
