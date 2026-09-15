/**
 * MapSkirtLayer.js —— 地图外围环境（v51.27 起，v51.29 排查出两处渲染坑后重写过材质方案）
 *
 * 用户："咱们现在的地图说白了就是个纸片子，就是怎么能改进显示效果啊，
 *       空白地方加个背景图片？？？"
 *
 * ==================== 根因 ====================
 * 地形是一整块严格贴合世界边界的 PlaneGeometry（见 ThreeRenderer._rebuildTerrain），
 * 边界之外直接是 scene.background 那块纯色，中间没有任何过渡——地图边缘是一条硬边，
 * 看起来像浮在虚空里的一张纸。
 *
 * ==================== 做法：裙边 ====================
 * 在地形外面铺一圈更大的平面（"裙边"），贴一张背景图（或纯色兜底），用径向淡出的
 * alpha 把硬边软化成一圈过渡：贴着地形边界处 alpha=1（无缝接上地形本身），往外在
 * `fadeFrac` 那段距离里线性淡到 0（透出后面的场景）。
 *
 * ==================== v51.29 排查记录 #1：alpha 淡出为什么不走 vertexColors ====================
 * 最初的做法是往几何的 `color` 顶点属性塞 RGBA（itemSize=4），material 开
 * `vertexColors:true`，理论上三.js 会自动识别 itemSize===4 → 编译出 USE_COLOR_ALPHA
 * 分支，让 alpha 通道参与混合。实测：**只要材质同时有 `map`，这条组合就整个不渲染**
 * ——mesh 在场景里、贴图确实加载成功、alpha/RGB 数值都对，画面却什么都看不到。
 * 逐项排除过 UV、itemSize、PNG 里一个非标准的 caBX 元数据块（怀疑过是内容溯源水印
 * 干扰解码，重编码后问题依旧）、Lambert 光照压暗（换 MeshBasicMaterial 后仍不可见，
 * 排除光照）——最后二分定位到 `vertexColors:true`(itemSize4) + `map` 这个组合本身，
 * 换成 `vertexColors:false` 或去掉 map 都能恢复正常，同时开两个才炸。没有继续深挖是
 * 三.js 这个版本的 USE_COLOR_ALPHA 和 USE_MAP 两个 shader chunk 具体哪里冲突——
 * 绕过比修三.js 内部实现划算。于是**改用 `onBeforeCompile` 注入一个自定义
 * `fadeAlpha`（itemSize=1）顶点属性**，自己把它乘进 `gl_FragColor.a`，完全不碰
 * vertexColors/USE_COLOR_ALPHA 这条路径，实测稳定。
 *
 * ==================== v51.29 排查记录 #2：颜色/贴图为什么不走 MeshLambertMaterial ====================
 * 同一轮排查里还发现：即使绕开上面那个 bug，MeshLambertMaterial 会把这层裙边的亮度
 * 压到源图的 1/4~1/5——跟同样很暗的 scene.background 撞在一起，肉眼/截图完全看不出
 * 区别，跟"没渲染"长得一模一样，这也是为什么上面那个 bug 排查了很久才最终定位到
 * vertexColors 组合本身（一路上先后怀疑过光照、UV、PNG 元数据）。没有继续深挖具体是
 * 阴影贴图边界效应还是入射角算错，因为**裙边本来就该是不受场景动态光照摆布的背景
 * 元素**——现实里天空/远山不会因为脚下一盏塔灯忽明忽暗。所以材质直接用
 * MeshBasicMaterial（不吃光照），昼夜响应改走 `setTint(hex)`（材质色乘数，跟
 * VegetationLayer.setTint 同一手法），ThreeRenderer.setLighting() 用现成的
 * unitTint 值调用它。
 *
 * ==================== 贴图 ====================
 * `material.map` 恒定有值：没配 `CONFIG.ui.mapSkirt.texturePath`（或加载失败）时是
 * 一张 1×1 的纯色 DataTexture（颜色取 `innerColor`）；配了路径且加载成功时换成真图。
 * 两种情况走同一条材质/shader 路径，不需要为"有没有贴图"分叉逻辑。路径缺失或加载
 * 失败一律静默保留纯色贴图——本仓库对纹理 404 一贯是这个容忍策略（历史注释提过
 * assets/textures/default/*.png 的必然 404 是纯控制台噪声），这里延续同一原则。
 *
 * ==================== 已知的简化 ====================
 * 裙边是一整块平的平面（不跟随 mapSystem.heightAt 起伏），只做视觉氛围用，
 * 不追求跟高地/台阶精确咬合——它离地图核心玩法区域有一整段淡出距离，
 * 肉眼分辨不出"没有跟着地形起伏"这件事。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const _texLoader = new THREE.TextureLoader();

/** 1×1 纯色贴图，做没有背景图时的默认材质 map（见文件头"贴图"一节）。 */
function _solidTexture(hex) {
  const c = new THREE.Color(hex);
  const data = new Uint8Array([
    Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255,
  ]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 材质的自定义着色器补丁——把 `fadeAlpha` 顶点属性乘进片元 alpha。见文件头排查记录 #1。 */
function _patchFadeAlpha(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float fadeAlpha;\nvarying float vFadeAlpha;\nvoid main() {\n\tvFadeAlpha = fadeAlpha;',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vFadeAlpha;\nvoid main() {')
      .replace('#include <dithering_fragment>', 'gl_FragColor.a *= vFadeAlpha;\n#include <dithering_fragment>');
  };
}

export class MapSkirtLayer {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this._mapId = null;
    this._defaultTex = null; // 纯色兜底贴图，dispose 时释放
    this._customTex = null;  // 加载成功的真背景图，dispose 时释放
    this._tint = null;       // 当前昼夜染色，重建时要补回去（否则重建那一帧会闪回白色）
  }

  /** 昼夜/天气染色——见文件头排查记录 #2。材质色是乘数，贴图色不受影响。 */
  setTint(hex) {
    this._tint = hex;
    if (this.mesh?.material?.color) this.mesh.material.color.set(hex);
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this._defaultTex) { this._defaultTex.dispose(); this._defaultTex = null; }
    if (this._customTex) { this._customTex.dispose(); this._customTex = null; }
    this.mesh = null;
    this._mapId = null;
  }

  /**
   * mapSystem：要有 currentMap.world 才建（跟地形自己的建图条件保持同一口径，见
   * ThreeRenderer._rebuildTerrain 的 `want` 判定）。裙边不依赖地形贴图，地形还没建好
   * /没有墙体信息时裙边一样能先建出来。
   */
  build(mapSystem) {
    const map = mapSystem?.currentMap;
    const C = CONFIG.ui?.mapSkirt || {};
    if (C.enabled === false || !map?.world) { this.dispose(); return; }
    if (this.mesh && this._mapId === map.id) return; // 同图已建，跳过
    this.dispose();
    this._mapId = map.id;

    const { w: WW, h: WH } = map.world;
    const scale = Math.max(1.2, C.scale ?? 3);       // 裙边总边长 = 地图边长 × 这个倍数
    const fadeFrac = Math.max(0.05, Math.min(1, C.fadeFrac ?? 0.5)); // 淡出发生在裙边延伸段的这个比例内
    const halfExtra = (scale - 1) / 2;                // 每边比地形多出的比例（以地形边长为单位）
    const SW = WW * scale, SH = WH * scale;
    const segX = 40, segZ = 40;                       // 只做视觉氛围，不需要地形那种精细段数

    // 不手动改 UV：PlaneGeometry 的默认 UV 就是"整块裙边 0..1"，正好是背景图要的映射。
    const geo = new THREE.PlaneGeometry(SW, SH, segX, segZ);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const fade = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) / WW, lz = pos.getZ(i) / WH; // "以地形边长为单位"的局部坐标，地形边界在 ±0.5
      const distX = Math.max(0, Math.abs(lx) - 0.5) / halfExtra;
      const distZ = Math.max(0, Math.abs(lz) - 0.5) / halfExtra;
      const t = Math.max(0, Math.min(1, Math.max(distX, distZ))); // 0=贴着地形边界，1=裙边最外圈
      fade[i] = t <= 0 ? 1 : Math.max(0, 1 - t / fadeFrac);
    }
    geo.setAttribute('fadeAlpha', new THREE.BufferAttribute(fade, 1));
    geo.computeVertexNormals();

    this._defaultTex = _solidTexture(C.innerColor ?? '#4c5a45');
    const mat = new THREE.MeshBasicMaterial({
      map: this._defaultTex, transparent: true, depthWrite: false,
    });
    _patchFadeAlpha(mat);
    if (this._tint) mat.color.set(this._tint); // 重建时把当前昼夜染色补回去

    const mesh = new THREE.Mesh(geo, mat);
    // 比地形略低（世界单位，不是像素），避免与地形共面 z-fighting；这段距离在俯视视角下
    // 肉眼不可辨——裙边本来就只在地形边界之外可见，边界内侧的部分会被地形自身遮住。
    mesh.position.set(WW / 2, C.yOffset ?? -15, WH / 2);
    this.scene.add(mesh);
    this.mesh = mesh;

    if (C.texturePath) {
      // THREE.TextureLoader 内部靠 ImageLoader 用 document.createElementNS 建 <img>——
      // 在无 DOM 的环境（headless Node 测试、未来任何非浏览器宿主）里 .load() 会【同步】
      // 抛 "document is not defined"，不会走到下面的 onError 回调。这里用 try/catch 兜底，
      // 当同一件事对待：安安静静留着上面已经建好的纯色贴图，不把整个裙边/地形重建炸掉。
      try {
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
          () => {}, // 404/加载失败：静默保留纯色贴图这个回退，不报错炸渲染
        );
      } catch (_) { /* 同上：非浏览器环境的同步抛错，留着纯色贴图，不往外传 */ }
    }
  }
}
