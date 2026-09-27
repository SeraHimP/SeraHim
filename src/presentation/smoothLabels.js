/**
 * smoothLabels.js —— 把"每格一个类别"的网格放大成边界平滑的像素图。
 *
 * navgrid 地图的地面（道路/林缘/森林/深林/围墙地基/图外）原来是逐格填色后
 * 最近邻放大：每格 ~9 世界单位，放大后斜线全是台阶，召唤师峡谷和扭曲丛林
 * 看起来像像素画。这里改成：
 *   ① 每个类别做成 one-hot 场，先过一道轻度模糊（[1,4,1]/6，可配）磨掉单格毛刺；
 *   ② 输出像素处对 4 个相邻格双线性插值，取权重最大的类别。
 * 效果相当于对每条类别边界取等值线：45° 台阶变成直线，拐角变圆，
 * 1 格宽的细条（中心权重 2/3）保留，孤立的单格噪点被磨掉。
 *
 * 只影响**画出来的**地面；能不能走仍然只认 map.navgrid。画出的边界与格边界
 * 最多差半格。
 *
 * 纯函数、不碰 canvas，headless 可测（tests/sim_smoothterrain.mjs）。
 */

/**
 * @param {Uint8Array} labels   nx*ny 个类别编号（0..K-1）
 * @param {number} nx
 * @param {number} ny
 * @param {Array<[number,number,number,number]>} palette  K 个 RGBA
 * @param {number} W  输出宽（像素）
 * @param {number} H  输出高（像素）
 * @param {number} [blurSide]  模糊核两侧权重（中心为 1-2*blurSide）；0 = 不模糊
 * @returns {Uint8ClampedArray} W*H*4
 */
export function smoothLabelsToRGBA(labels, nx, ny, palette, W, H, blurSide = 1 / 6) {
  const K = palette.length;
  const N = nx * ny;
  // one-hot → 分离模糊（先 x 后 y），边缘按钳位处理
  let f = new Float32Array(N * K);
  for (let k = 0; k < N; k++) f[k * K + labels[k]] = 1;
  if (blurSide > 0) {
    const c = 1 - 2 * blurSide, s = blurSide;
    const t = new Float32Array(N * K);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = (y * nx + x) * K;
      const l = (y * nx + Math.max(0, x - 1)) * K, r = (y * nx + Math.min(nx - 1, x + 1)) * K;
      for (let q = 0; q < K; q++) t[i + q] = c * f[i + q] + s * (f[l + q] + f[r + q]);
    }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = (y * nx + x) * K;
      const u = (Math.max(0, y - 1) * nx + x) * K, d = (Math.min(ny - 1, y + 1) * nx + x) * K;
      for (let q = 0; q < K; q++) f[i + q] = c * t[i + q] + s * (t[u + q] + t[d + q]);
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  const sx = nx / W, sy = ny / H;
  for (let py = 0; py < H; py++) {
    // 像素中心在格坐标里的位置，减 0.5 换到"以格中心为采样点"的坐标
    const gy = (py + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.min(ny - 1, Math.floor(gy)));
    const y1 = Math.min(ny - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gy - y0));
    for (let px = 0; px < W; px++) {
      const gx = (px + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.min(nx - 1, Math.floor(gx)));
      const x1 = Math.min(nx - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, gx - x0));
      const a = (y0 * nx + x0) * K, b = (y0 * nx + x1) * K, cc = (y1 * nx + x0) * K, d = (y1 * nx + x1) * K;
      const wa = (1 - tx) * (1 - ty), wb = tx * (1 - ty), wc = (1 - tx) * ty, wd = tx * ty;
      let best = 0, bw = -1;
      for (let q = 0; q < K; q++) {
        const w = wa * f[a + q] + wb * f[b + q] + wc * f[cc + q] + wd * f[d + q];
        if (w > bw) { bw = w; best = q; }
      }
      const col = palette[best], o = (py * W + px) * 4;
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = col[3];
    }
  }
  return out;
}

/**
 * 标量场（0..1）的低分辨率采样 → 在 cell 画布上写成 alpha，交给 drawImage 的双线性放大。
 * 河道原来是 16 世界单位一块的 fillRect，边缘是台阶、水面带条纹。
 */
export function sampleFieldRGBA(fn, W, H, cellW, cellH, rgb, maxAlpha) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = Math.max(0, Math.min(1, fn((x + 0.5) * cellW, (y + 0.5) * cellH)));
    const o = (y * W + x) * 4;
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2];
    out[o + 3] = Math.round(255 * maxAlpha * a);
  }
  return out;
}

/**
 * 不可走格里，哪些**不与地图外缘连通**（野区里的小块障碍物，而不是地图外面）。
 * 从四条边往里泛洪不可走格，泛洪不到的就是内部障碍物。返回 Uint8Array（1=内部）。
 */
export function interiorObstacles(paint, nx, ny) {
  const outside = new Uint8Array(nx * ny);
  const stack = [];
  const push = (i, j) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    const k = j * nx + i;
    if (paint[k] || outside[k]) return;
    outside[k] = 1; stack.push(k);
  };
  for (let i = 0; i < nx; i++) { push(i, 0); push(i, ny - 1); }
  for (let j = 0; j < ny; j++) { push(0, j); push(nx - 1, j); }
  while (stack.length) {
    const k = stack.pop(), i = k % nx, j = (k / nx) | 0;
    push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
  }
  const out = new Uint8Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) out[k] = (!paint[k] && !outside[k]) ? 1 : 0;
  return out;
}
