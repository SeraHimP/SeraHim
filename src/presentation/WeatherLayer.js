/**
 * WeatherLayer.js —— 天气可视化（基础 5 种：晴 / 雨 / 雾 / 风 / 雪）
 *
 * ==================== 为什么现在才有 ====================
 * 天气系统本身早就是连续演化的（OU + softmax + 充能条），可它一直**只存在于数字里**：
 * HUD 上一行字、属性面板里几个加成。用户："我想做出可视化天气。"
 * 这一层把那些数字画出来 —— 而且画的就是玩法真正读的那个量（充能值），
 * 不另起一套强度曲线。于是"看起来雨很大"和"雨的加成很强"永远是同一件事。
 *
 * ==================== 强度取【充能】不取【占比】 ====================
 * 占比（getWeights）是瞬时的、会随 OU 抖动；充能（getCharge）是一阶惯性的，
 * 有"积累—爆发—消退"的节奏，也正是效果强度的依据（见 WeatherSystem 头注）。
 * 画面跟着充能走，才会出现"雨越下越大、停了慢慢收"的观感；
 * 跟着占比走的话，天上的雨会跟着随机游走一帧一帧地忽大忽小。
 *
 * ==================== 粒子只在【看得见的那块】撒 ====================
 * 世界有 3008×1388 那么大，而屏幕通常只看得到其中一小块。整图撒粒子是纯浪费：
 * 要么密度够了但粒子数爆炸，要么粒子数可控但屏幕上稀稀拉拉。
 * 这里把粒子放在一个【跟着镜头走的盒子】里，盒子尺寸 = 当前可见世界范围 × 1.15，
 * 粒子越界就按盒子尺寸取模绕回来（环面拓扑）。于是：
 *   · 粒子数恒定（不随缩放变），密度自动跟着缩放走；
 *   · 镜头平移时粒子从"另一边"绕进来，看不出接缝（雨雪本来就无规律）。
 *
 * ==================== 每帧零分配 ====================
 * 所有粒子的位置存在预分配的 Float32Array 里，逐帧只改数字、置 needsUpdate。
 * 不 new 任何对象、不重建几何 —— 长跑不产生 GC 压力（与 EffectsLayer 同一条纪律）。
 */
import * as THREE from '../../vendor/three.module.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';
import { CONFIG } from '../data/Config.js';

/** 雪花/尘埃用的软圆点纹理（一次性程序生成，无外部素材） */
function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 确定性伪随机：同一颗粒子每次取到的"性格"（速度/大小抖动）不变，
// 不用每颗都存一份属性数组。
function hash01(i, salt) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(salt | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

export class WeatherLayer {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this._built = false;
    this._t = 0;
    this._box = { cx: 0, cz: 0, hx: 1200, hz: 1200 };
  }

  _cfg() { return (CONFIG.ui && CONFIG.ui.weatherFx) || {}; }

  _build() {
    if (this._built) return;
    const C = this._cfg();
    const MAXR = C.maxRain ?? 1400;
    const MAXS = C.maxSnow ?? 900;
    const MAXD = C.maxDust ?? 260;

    // ---- 雨：线段批（每滴一条短线，头尾两个顶点）----
    this._rainPos = new Float32Array(MAXR * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this._rainPos, 3));
    this._rainMat = new THREE.LineBasicMaterial({
      color: 0xbcd6f0, transparent: true, opacity: 0, depthWrite: false,
    });
    this._rain = new THREE.LineSegments(rg, this._rainMat);
    // 粒子必须排除出法线深度预渲染，否则描边会在每一颗雨/雪上触发（满屏黑麻点）。
    // 真根因与证据见 PostFX.js 里 FX_PARTICLE_LAYER 的头注。
    this._rain.layers.set(FX_PARTICLE_LAYER);
    this._rain.frustumCulled = false;           // 盒子跟着镜头走，包围盒没意义
    this._rain.renderOrder = 30;
    this.scene.add(this._rain);

    // ---- 雪 / 尘埃：点批（软圆点贴图）----
    this._dotTex = makeDotTexture();
    const mkPoints = (n, color, size) => {
      const arr = new Float32Array(n * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const m = new THREE.PointsMaterial({
        color, size, map: this._dotTex, transparent: true, opacity: 0,
        depthWrite: false, sizeAttenuation: true,
      });
      const p = new THREE.Points(g, m);
      p.layers.set(FX_PARTICLE_LAYER);   // 同雨：排除出法线深度预渲染，见 PostFX.js 头注
      p.frustumCulled = false;
      p.renderOrder = 30;
      this.scene.add(p);
      return { arr, geo: g, mat: m, obj: p };
    };
    this._snow = mkPoints(MAXS, 0xffffff, C.snowSize ?? 9);
    this._dust = mkPoints(MAXD, 0xffe3a8, C.dustSize ?? 7);

    // ---- 雾：一张跟着镜头走的大平面，低透明度白 ----
    // 不用 scene.fog：那是【按距离】的雾，俯视视角下所有单位到镜头的距离差不多，
    // 调到能看见的浓度时远处天边会先糊掉，战场本身反而没变化。
    // 一张贴在单位上方的薄纱片才是俯视图里"起雾了"的正确读法。
    const fg = new THREE.PlaneGeometry(1, 1);
    fg.rotateX(-Math.PI / 2);
    this._fogMat = new THREE.MeshBasicMaterial({
      color: 0xc8d2dc, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
    });
    this._fog = new THREE.Mesh(fg, this._fogMat);
    // 雾是一整块半透明薄纱，被预渲染当成不透明面的话会在雾的边界描出一圈假轮廓。
    this._fog.layers.set(FX_PARTICLE_LAYER);
    this._fog.frustumCulled = false;
    this._fog.renderOrder = 31;
    this.scene.add(this._fog);

    this._built = true;
  }

  setEnabled(on) {
    this.enabled = on !== false;
    if (!this.enabled && this._built) {
      this._rainMat.opacity = 0;
      this._snow.mat.opacity = 0;
      this._dust.mat.opacity = 0;
      this._fogMat.opacity = 0;
    }
  }

  /**
   * @param weather  WeatherSystem（可为 null → 全部收起来）
   * @param target   THREE.Vector3 镜头注视点（世界坐标，y 忽略）
   * @param viewW    可见世界宽度
   * @param viewD    可见世界纵深（已按仰角还原，不是屏幕高度）
   * @param dt       墙钟秒（渲染帧间隔，不用 gameTime —— 暂停时雨也该继续下）
   * @param azimuthDeg 摄像机方位角（绕 Y 偏航，度）。见下面盒子尺寸那段。
   */
  update(weather, target, viewW, viewD, dt, azimuthDeg = 0) {
    if (!this.enabled || !weather || !weather.enabled) {
      if (this._built) this._hideAll();
      return;
    }
    this._build();
    const C = this._cfg();
    this._t += dt;

    // 充能 = 玩法读的那个量（见头注）。取不到就当 0。
    const ch = (id) => {
      const v = weather.getCharge ? weather.getCharge(id) : 0;
      return Math.max(0, Math.min(1, v || 0));
    };
    const rain = ch('rain'), snow = ch('snow'), fog = ch('fog'), wind = ch('wind'), clear = ch('clear');

    // ==================== 盒子：跟着镜头走 ====================
    // v43 Q6 修正。用户："天气可视化效果如果我旋转了视角那就会有一部分少了显示不到！"
    // 根因：粒子盒是**轴对齐**的，尺寸直接取 viewW × viewD，完全没读方位角。
    // 可摄像机一偏航，可见区域就是一个绕 Y 转了 az 度的矩形；轴对齐盒子装不下它的四个角，
    // 那几块就是空的 —— 转到 45° 时缺得最狠。
    //
    // 修法：把盒子撑成"旋转后矩形的**轴对齐外接盒**"（AABB），这是能保证全覆盖的
    // 最小轴对齐盒：
    //     hx = (|W·cos| + |D·sin|) / 2 ,  hz = (|W·sin| + |D·cos|) / 2
    // 为什么不选"外接圆"（hx = hz = ½·hypot(W,D)）：那个更省事，但面积能大一倍，
    // 粒子总数固定的前提下密度直接掉一半。为什么不把 _wrap 改到摄像机基向量上：
    // 那样最省粒子，但要把三处粒子写入全部改成"先在旋转系里 wrap 再转回世界系"，
    // 改动面大得多，而 AABB 在最坏角度（45°）也只多 41% 面积。
    const pad = C.viewPad ?? 1.15;
    const B = this._box;
    const azr = (azimuthDeg || 0) * Math.PI / 180;
    const ca = Math.abs(Math.cos(azr)), sa = Math.abs(Math.sin(azr));
    B.cx = target.x; B.cz = target.z;
    B.hx = Math.max(200, (viewW * ca + viewD * sa) * 0.5 * pad);
    B.hz = Math.max(200, (viewW * sa + viewD * ca) * 0.5 * pad);
    const top = C.ceiling ?? 520;

    this._updateRain(rain, wind, top, C);
    this._updateSnow(snow, wind, top, C);
    this._updateDust(clear, wind, top, C);
    this._updateFog(fog, C);
  }

  _hideAll() {
    this._rainMat.opacity = 0;
    this._snow.mat.opacity = 0;
    this._dust.mat.opacity = 0;
    this._fogMat.opacity = 0;
  }

  // 把一个坐标绕回盒子里（环面）。粒子因此永远在视野内，且看不出接缝。
  _wrap(v, c, h) {
    const span = h * 2;
    let d = v - (c - h);
    d -= Math.floor(d / span) * span;
    return c - h + d;
  }

  _updateRain(k, wind, top, C) {
    const arr = this._rainPos, max = arr.length / 6;
    const n = Math.round(max * k);
    this._rainMat.opacity = (C.rainAlpha ?? 0.5) * Math.min(1, k * 1.6);
    this._rain.visible = n > 0;
    if (n <= 0) { this._rain.geometry.setDrawRange(0, 0); return; }
    const B = this._box;
    const fall = C.rainSpeed ?? 1500;                 // 下落速度（世界单位/秒）
    const tilt = (C.rainTilt ?? 0.35) + wind * (C.rainTiltWind ?? 0.75); // 风越大越斜
    const len = C.rainLen ?? 46;
    for (let i = 0; i < n; i++) {
      // 每颗雨滴的"性格"：出生相位 + 速度抖动，由 hash 决定（确定性，无需数组）
      const sp = fall * (0.8 + hash01(i, 1) * 0.5);
      const ph = hash01(i, 2);
      // 高度：随时间循环下落
      const y = top - ((this._t * sp + ph * top * 3) % top);
      // 水平：静态散布 + 随下落进度侧移（风的倾斜）
      const bx = (hash01(i, 3) - 0.5) * B.hx * 2;
      const bz = (hash01(i, 4) - 0.5) * B.hz * 2;
      const drift = (top - y) * tilt;
      const x = this._wrap(B.cx + bx + drift, B.cx, B.hx);
      const z = this._wrap(B.cz + bz + drift * 0.35, B.cz, B.hz);
      const o = i * 6;
      arr[o] = x;                   arr[o + 1] = y;             arr[o + 2] = z;
      arr[o + 3] = x - tilt * len;  arr[o + 4] = y + len;       arr[o + 5] = z - tilt * len * 0.35;
    }
    this._rain.geometry.setDrawRange(0, n * 2);
    this._rain.geometry.attributes.position.needsUpdate = true;
  }

  _updateSnow(k, wind, top, C) {
    const P = this._snow, max = P.arr.length / 3;
    const n = Math.round(max * k);
    P.mat.opacity = (C.snowAlpha ?? 0.85) * Math.min(1, k * 1.6);
    P.obj.visible = n > 0;
    if (n <= 0) { P.geo.setDrawRange(0, 0); return; }
    const B = this._box;
    const fall = C.snowSpeed ?? 130;
    const sway = (C.snowSway ?? 28) * (1 + wind * 2.5);
    for (let i = 0; i < n; i++) {
      const sp = fall * (0.7 + hash01(i, 5) * 0.7);
      const ph = hash01(i, 6);
      const y = top - ((this._t * sp + ph * top * 3) % top);
      const bx = (hash01(i, 7) - 0.5) * B.hx * 2;
      const bz = (hash01(i, 8) - 0.5) * B.hz * 2;
      // 横向正弦摆 + 风的整体侧推
      const s = Math.sin(this._t * (0.5 + hash01(i, 9)) + ph * 6.28) * sway;
      const push = wind * (C.snowWindPush ?? 1.4) * (top - y);
      const o = i * 3;
      P.arr[o] = this._wrap(B.cx + bx + s + push, B.cx, B.hx);
      P.arr[o + 1] = y;
      P.arr[o + 2] = this._wrap(B.cz + bz + s * 0.4 + push * 0.35, B.cz, B.hz);
    }
    P.geo.setDrawRange(0, n);
    P.geo.attributes.position.needsUpdate = true;
  }

  // 晴：极淡的暖色浮尘。晴天要是什么都不画，切到晴就成了"天气关了"，
  // 而晴本身是有加成的 —— 得让人看得出"现在是晴"。
  _updateDust(k, wind, top, C) {
    const P = this._dust, max = P.arr.length / 3;
    const n = Math.round(max * k);
    P.mat.opacity = (C.dustAlpha ?? 0.30) * Math.min(1, k * 1.6);
    P.obj.visible = n > 0;
    if (n <= 0) { P.geo.setDrawRange(0, 0); return; }
    const B = this._box;
    const ceil = top * 0.5;   // 浮尘只在低空飘，不铺满整个高度
    for (let i = 0; i < n; i++) {
      const ph = hash01(i, 11);
      // 上浮而不是下落 —— 逆着雨雪的方向，一眼能分辨
      const y = 20 + ((this._t * (C.dustSpeed ?? 18) * (0.6 + hash01(i, 12)) + ph * ceil * 3) % ceil);
      const bx = (hash01(i, 13) - 0.5) * B.hx * 2;
      const bz = (hash01(i, 14) - 0.5) * B.hz * 2;
      const s = Math.sin(this._t * 0.35 + ph * 6.28) * 24 * (1 + wind * 2);
      const o = i * 3;
      P.arr[o] = this._wrap(B.cx + bx + s, B.cx, B.hx);
      P.arr[o + 1] = y;
      P.arr[o + 2] = this._wrap(B.cz + bz + s * 0.5, B.cz, B.hz);
    }
    P.geo.setDrawRange(0, n);
    P.geo.attributes.position.needsUpdate = true;
  }

  _updateFog(k, C) {
    const B = this._box;
    this._fogMat.opacity = (C.fogAlpha ?? 0.42) * k;
    this._fog.visible = k > 0.004;
    if (!this._fog.visible) return;
    this._fog.position.set(B.cx, C.fogY ?? 110, B.cz);
    this._fog.scale.set(B.hx * 2, 1, B.hz * 2);
  }

  dispose() {
    if (!this._built) return;
    for (const o of [this._rain, this._snow.obj, this._dust.obj, this._fog]) {
      this.scene.remove(o); o.geometry.dispose(); o.material.dispose();
    }
    this._dotTex.dispose();
    this._built = false;
  }
}
