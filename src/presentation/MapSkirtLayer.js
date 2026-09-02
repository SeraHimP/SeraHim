/**
 * MapSkirtLayer.js —— 地图外围环境（v51.27）
 *
 * 用户："咱们现在的地图说白了就是个纸片子，就是怎么能改进显示效果啊，
 *       空白地方加个背景图片？？？"
 *
 * ==================== 根因 ====================
 * 地形是一整块严格贴合世界边界的 PlaneGeometry（见 ThreeRenderer._rebuildTerrain），
 * 边界之外直接是 scene.background 那块纯色，中间没有任何过渡——地图边缘是一条硬边，
 * 看起来像浮在虚空里的一张纸。
 *
 * ==================== 做法：零美术资源的裙边 ====================
 * 在地形外面铺一圈更大的平面（"裙边"），复用地形自己那张 CanvasTexture——它已经是
 * ClampToEdgeWrapping，UV 延伸到 [0,1] 之外时会把边缘那一圈像素直接拉伸出去，
 * 不用画任何新贴图。裙边用顶点 alpha 做径向淡出：贴着地形边界处 alpha=1（无缝接上
 * 地形本身），往外在 `fadeFrac` 那段距离里线性淡到 0（透出后面的纯色 scene.background），
 * 硬边就变成了一圈柔和的雾化过渡，而不是砍断的纸片边。
 *
 * 材质用跟地形同款的 MeshLambertMaterial，所以裙边跟场景灯光走同一条路，昼夜/天气
 * 压光时它跟着一起变暗变亮——不需要像 unitTint 那样另开一条染色通路（那是给高反照率
 * 的单位材质做补偿的，裙边本身就是低反照率的地形色，不存在那个问题）。
 *
 * ==================== 预留：以后真的有背景图时怎么接 ====================
 * `CONFIG.ui.mapSkirt.texturePath` 配了路径，就异步加载那张图换上去（铺满整个裙边，
 * 不再是"延伸地形贴图"这套，径向 alpha 淡出逻辑不变，两种贴图共用同一层几何）；
 * 路径缺失或加载失败一律静默保留"延伸地形贴图"这个零美术资源回退——本仓库对纹理
 * 404 一贯是这个容忍策略（历史注释提过 assets/textures/default/*.png 的必然 404
 * 是纯控制台噪声，不该因为一张缺失的图打断渲染），这里延续同一原则。
 *
 * ==================== 已知的简化 ====================
 * 裙边是一整块平的平面（不跟随 mapSystem.heightAt 起伏），只做视觉氛围用，
 * 不追求跟高地/台阶精确咬合——它离地图核心玩法区域有一整段淡出距离，
 * 肉眼分辨不出"没有跟着地形起伏"这件事。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const _texLoader = new THREE.TextureLoader();

export class MapSkirtLayer {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this._mapId = null;
    this._customTex = null; // 只有这个是裙边自己加载的，dispose 时才需要释放
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this._customTex) { this._customTex.dispose(); this._customTex = null; }
    this.mesh = null;
    this._mapId = null;
  }

  /** terrainTex：地形当前那张 CanvasTexture（ThreeRenderer._rebuildTerrain 已建好），复用来做延伸拉伸回退。 */
  build(mapSystem, terrainTex) {
    const map = mapSystem?.currentMap;
    const C = CONFIG.ui?.mapSkirt || {};
    if (C.enabled === false || !map?.world || !terrainTex) { this.dispose(); return; }
    if (this.mesh && this._mapId === map.id) return; // 同图已建，跳过
    this.dispose();
    this._mapId = map.id;

    const { w: WW, h: WH } = map.world;
    const scale = Math.max(1.2, C.scale ?? 3);       // 裙边边长是地图的几倍
    const fadeFrac = Math.max(0.05, Math.min(1, C.fadeFrac ?? 0.5)); // 淡出发生在裙边延伸段的这个比例内
    const halfExtra = (scale - 1) / 2;                // 每边比地形多出的比例（以地形边长为单位）
    const SW = WW * scale, SH = WH * scale;
    const segX = 40, segZ = 40;                       // 只做视觉氛围，不需要地形那种精细段数

    const geo = new THREE.PlaneGeometry(SW, SH, segX, segZ);
    geo.rotateX(-Math.PI / 2);

    // UV 与顶点 alpha 用同一套局部坐标算：lx/lz 是"以地形自身边长为 1 个单位"的坐标，
    // 范围 [-scale/2, scale/2]，地形边界正好落在 ±0.5。
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const col = new Float32Array(pos.count * 4); // RGBA，alpha 通道做径向淡出
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) / WW, lz = pos.getZ(i) / WH;
      // 与地形自己的默认 UV 公式同一套换算（PlaneGeometry.rotateX(-90°) 把局部 Y 映到 -Z，
      // 所以 v 要用 -lz 换算），UV 超出 [0,1] 的部分交给 ClampToEdgeWrapping 去拉伸。
      uv.setXY(i, lx + 0.5, 0.5 - lz);

      const distX = Math.max(0, Math.abs(lx) - 0.5) / halfExtra;
      const distZ = Math.max(0, Math.abs(lz) - 0.5) / halfExtra;
      const t = Math.max(0, Math.min(1, Math.max(distX, distZ))); // 0=贴着地形边界，1=裙边最外圈
      const alpha = t <= 0 ? 1 : Math.max(0, 1 - t / fadeFrac);
      col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = alpha;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({
      map: terrainTex, vertexColors: true, transparent: true, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // 比地形略低（世界单位，不是像素），避免与地形共面 z-fighting；这段距离在俯视视角下
    // 肉眼不可辨——裙边本来就只在地形边界之外可见，边界内侧的部分会被地形自身遮住。
    mesh.position.set(WW / 2, C.yOffset ?? -15, WH / 2);
    this.scene.add(mesh);
    this.mesh = mesh;

    if (C.texturePath) {
      _texLoader.load(
        C.texturePath,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          if (!this.mesh) { tex.dispose(); return; } // 加载完成时地图已经切走了
          this._customTex = tex;
          this.mesh.material.map = tex;
          this.mesh.material.needsUpdate = true;
        },
        undefined,
        () => {}, // 404/加载失败：静默保留延伸地形贴图这个回退，不报错炸渲染
      );
    }
  }
}
