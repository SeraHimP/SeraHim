/**
 * WaterLayer.js —— 河道水面（P1 视觉优化）
 *
 * 河道此前只是一条"下沉的土带"（heightAt 把主对角线带压到 riverDepth），观感上仍是土。
 * 这里在河床之上盖一层【半透明水面】：程序化涟漪法线 + 逐帧滚动 UV，得到流动的水。
 *
 * 几何 = 一块沿主对角线（世界 x=z）铺开的长方形平面，绕 Y 转 45° 对齐河带；
 * 尺寸取自 map.heightZones（riverHalfWidth / riverDepth），与 MapSystem.heightAt 同一份配置，
 * 故水面宽度永远和真实河床一致。仅渲染，仿真不读。
 */
import * as THREE from '../../vendor/three.module.js';

// 程序化涟漪法线贴图：两组不同频率/朝向的正弦叠加 → 交错波纹，平铺无缝（用整数周期）。
function rippleNormalTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // 高度场：两列斜向行波（整数周期保证平铺接缝连续）
      const h = Math.sin((u * 3 + v * 2) * TAU) * 0.5 + Math.sin((u * 2 - v * 4) * TAU) * 0.35;
      // 数值微分求切向斜率 → 法线
      const e = 1 / size;
      const hx = Math.sin(((u + e) * 3 + v * 2) * TAU) * 0.5 + Math.sin(((u + e) * 2 - v * 4) * TAU) * 0.35;
      const hy = Math.sin((u * 3 + (v + e) * 2) * TAU) * 0.5 + Math.sin((u * 2 - (v + e) * 4) * TAU) * 0.35;
      const nx = -(hx - h) / e * 0.06, ny = -(hy - h) / e * 0.06, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i]     = (nx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// 河带 alpha 遮罩：与 MapSystem.heightAt 同一判据（到主对角线 x=z 的垂距 < riverHalfWidth），
// 岸边留一段羽化，水陆过渡不是硬边。贴图整图 0~1 UV 对应世界 [0,WW]×[0,WH]。
function riverMaskTexture(WW, WH, riverAt, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size * WW, z = (j + 0.5) / size * WH;
      // 直接采样 MapSystem.riverFactor —— 水面、河床高度、地形底图共用同一个场，
      // 三者边界因此严格一致（此前这里另抄了一份"到 x=z 的垂距"判据）。
      const a = riverAt(x, z);
      const k = (j * size + i) * 4;
      const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;   // alphaMap 读绿通道，三通道同值最稳
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

export class WaterLayer {
  constructor(scene) { this.scene = scene; this.mesh = null; this.tex = null; this.mask = null; this._mapId = null; this.enabled = true; }

  clear() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose(); this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.tex) { this.tex.dispose(); this.tex = null; }
    if (this.mask) { this.mask.dispose(); this.mask = null; }
    this._mapId = null;
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    if (!this.enabled || !map || !map.world || !mapSystem.hasWalls || !mapSystem.hasWalls()) { this.clear(); return; }
    if (this.mesh && this._mapId === map.id) return;
    this.clear(); this._mapId = map.id;

    const { w: WW, h: WH } = map.world;
    const cfg = map.heightZones || {};
    const depth = cfg.riverDepth ?? -10;
    this.tex = rippleNormalTexture();
    this.tex.repeat.set(WW / 150, WH / 150);          // 细密涟漪（平铺越多波纹越小，避免方格感）

    // 水面 = 整张地图大小的平面 + 河带 alpha 遮罩。比"旋转的长条"好在：
    //   ① 天然裁进地图边界（长条会从四角戳出去）；② 河带定义与 heightAt 逐像素一致；③ 岸边可羽化。
    this.mask = riverMaskTexture(WW, WH, (x, z) => mapSystem.riverFactor(x, z));
    const geo = new THREE.PlaneGeometry(WW, WH, 1, 1);
    geo.rotateX(-Math.PI / 2);                        // 躺平到 XZ
    // 材质用 Lambert（【无镜面反射】）而不是 Standard：低粗糙度+金属度会在太阳方向打出一大片高光，
    // 再被 Bloom 放大成刺眼白斑（用户反馈"晃瞎"）。水面不是核心玩法，只需要"看得出是水"：
    // 靠法线扰动做出细微涟漪的明暗起伏即可，不要任何高光。
    const mat = new THREE.MeshLambertMaterial({
      color: 0x35707c, transparent: true, opacity: 0.55,
      normalMap: this.tex, normalScale: new THREE.Vector2(0.35, 0.35),
      alphaMap: this.mask,        // 只有河带处不透明
      depthWrite: false,          // 半透明水面不写深度，避免挡住河床里的单位/贴花
    });
    const mesh = new THREE.Mesh(geo, mat);
    // 水位：河床(depth) 与地面(0) 之间，略低于岸，读作"半满的河"
    mesh.position.set(WW / 2, depth * 0.35, WH / 2);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.mesh = mesh;
  }

  /** 每帧滚动 UV → 水在流。tNow = 游戏时间（秒）。 */
  update(tNow) {
    if (!this.tex) return;
    this.tex.offset.set((tNow * 0.035) % 1, (tNow * 0.012) % 1);
  }

  setEnabled(on) {
    this.enabled = on !== false;
    if (!this.enabled) this.clear();
    return this.enabled;
  }
}
