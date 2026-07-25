/**
 * TerrainMaterial.js —— 材质贴图合成（2.5D 迁移第 6.5 步）
 *
 * 地面与高地顶面共用同一张【整图 0~1 UV】的地形贴图，那张贴图携带全部布局信息
 * （走廊位置、基地圈、阵营配色）。要给它加上材质质感，有两条路：
 *   a) 换成 repeat UV 的材质贴图 —— 布局信息全丢，等于重做地形
 *   b) 把材质在【画布阶段】叠加进去 —— 布局全留，只加颗粒
 * 取 b。代价是每次切图多一次画布合成（一次性，见 buildStats）。
 *
 * 混合模式用 'overlay' 而不是普通叠加：overlay 对暗底走乘法、对亮底走滤色，
 * 因此保留原有明暗关系（走廊亮、墙区暗、基地圈的阵营色）而只注入纹理起伏。
 * 普通叠加会把整片压成材质本身的颜色，布局信息就糊掉了。
 *
 * 走廊与高地用两张不同材质，靠 walk 采样网格分区：先整张铺走廊材质，
 * 再把高地材质按遮罩裁进墙区。遮罩用最近邻放大——它本来就是格点数据，
 * 平滑插值只会在边界糊出一圈错误材质。
 */

const TILE_WORLD = 384;     // 一张材质覆盖的世界尺寸。小兵约 10~24 单位，故一块石子约 4 单位
const AMPLIFY = 1.8;        // 材质自身对比放大（保留其原色，只把起伏拉明显）
const CHROMA_KEEP = 0.85;   // 保留多少底图色偏：阵营基地圈的蓝/红靠它活下来
// P1 野区提亮：布局因子 k = 像素亮度/全图均值，野区在底图里本就暗 → k 极小 → 野区被压成近黑
// （植被/道具都"沉"进黑里看不见）。这里把 k 向 1 压缩并设下限：暗部大幅提亮、亮部几乎不变，
// 走廊/野区的明暗层次仍在，只是不再死黑。
const LAYOUT_CONTRAST = 0.55;  // 1=原样（死黑），越小越平
const LAYOUT_MIN = 0.42;       // 布局因子下限
// 野区（墙区）植被色偏：让野区读作"丛林草地"而不是"暗土"。0=不染，1=全绿。
const JUNGLE_TINT = [0.42, 0.62, 0.30], JUNGLE_TINT_AMT = 0.30;

/**
 * @param {HTMLCanvasElement} base      buildTerrainLayer 产出的地形画布（不被修改）
 * @param {object} world                { w, h } 世界尺寸，用于换算平铺次数
 * @param {Uint8Array|null} walk        可走网格（1=可走）；为 null 时只铺走廊材质
 * @param {number} nx @param {number} ny 网格尺寸
 * @param {HTMLImageElement} texGround  走廊材质
 * @param {HTMLImageElement} texPlateau 高地材质
 * @returns {HTMLCanvasElement} 合成后的新画布
 */
/**
 * 把材质图【归一化到中灰并放大起伏】，这是 overlay 能用的前提。
 *
 * 首版直接拿原图 overlay，结果两头落空——实测：走廊底色亮度 85→65（暗了 24%），
 * 纹理起伏 6.0→2.3（不到 1%，肉眼不可见）。原因是 overlay 对暗底走乘法：
 * 深色纹理压在深色底上只会越压越黑，同时把本就微弱的起伏一起吃掉。
 *
 * 修法两步，缺一不可：
 *   ① 均值搬到中灰 128 —— overlay 遇到中灰不改变底色，亮度因此原样保留；
 *   ② 起伏放大 AMPLIFY 倍 —— 当初为了平铺不露馅特意要了低对比（std≈6），
 *      经 overlay 衰减后所剩无几，必须先放大回可见区间（目标 std 8~10）。
 */
function normalize(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data, n = c.width * c.height;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= n; mg /= n; mb /= n;
  for (let i = 0; i < n; i++) {
    px[i * 4]     = Math.max(0, Math.min(255, 128 + (px[i * 4]     - mr) * AMPLIFY));
    px[i * 4 + 1] = Math.max(0, Math.min(255, 128 + (px[i * 4 + 1] - mg) * AMPLIFY));
    px[i * 4 + 2] = Math.max(0, Math.min(255, 128 + (px[i * 4 + 2] - mb) * AMPLIFY));
  }
  g.putImageData(d, 0, 0);
  return c;
}

const _normCache = new WeakMap();
function normed(img) {
  if (!img) return null;
  let c = _normCache.get(img);
  if (!c) { c = normalize(img); _normCache.set(img, c); }
  return c;
}

export function compositeTerrain(base, world, walk, nx, ny, texGround, texPlateau) {
  const W = base.width, H = base.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.drawImage(base, 0, 0);
  if (!texGround && !texPlateau) return out;

  // 画布像素 ↔ 世界单位的比例：地形画布可能带超采样系数
  const pxPerWorld = W / world.w;
  const tile = Math.max(16, Math.round(TILE_WORLD * pxPerWorld));

  // ---- 材质层：先整张走廊材质，再把高地材质裁进墙区 ----
  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lg = layer.getContext('2d');
  const fill = (ctx, tex) => {
    for (let y = 0; y < H; y += tile) for (let x = 0; x < W; x += tile) ctx.drawImage(tex, x, y, tile, tile);
  };
  const nG = texGround, nP = texPlateau;
  if (nG) fill(lg, nG);

  // P1：野区（墙区）全分辨率遮罩——供下面的"提亮 + 植被色偏"逐像素判断。
  // 与高地材质用同一份 walk 网格、同样最近邻放大，故两者边界严格一致。
  let jungle = null;
  if (walk) {
    const jc = document.createElement('canvas');
    jc.width = W; jc.height = H;
    const jg = jc.getContext('2d');
    const src = document.createElement('canvas');
    src.width = nx; src.height = ny;
    const sg = src.getContext('2d');
    const im = sg.createImageData(nx, ny);
    for (let k = 0; k < nx * ny; k++) { const v = walk[k] ? 0 : 255; im.data[k * 4] = v; im.data[k * 4 + 3] = 255; }
    sg.putImageData(im, 0, 0);
    jg.imageSmoothingEnabled = false;
    jg.drawImage(src, 0, 0, W, H);
    jungle = jg.getImageData(0, 0, W, H).data;
  }

  if (nP && walk) {
    const pl = document.createElement('canvas');
    pl.width = W; pl.height = H;
    const pg = pl.getContext('2d');
    fill(pg, nP);
    // 遮罩：墙区不透明。最近邻放大，避免边界插值出一圈两种材质的混色
    const mc = document.createElement('canvas');
    mc.width = nx; mc.height = ny;
    const mg2 = mc.getContext('2d');
    const img = mg2.createImageData(nx, ny);
    for (let k = 0; k < nx * ny; k++) img.data[k * 4 + 3] = walk[k] ? 0 : 255;
    mg2.putImageData(img, 0, 0);
    pg.globalCompositeOperation = 'destination-in';
    pg.imageSmoothingEnabled = false;
    pg.drawImage(mc, 0, 0, W, H);
    pg.globalCompositeOperation = 'source-over';
    lg.drawImage(pl, 0, 0);
  }

  // ---- 合成：材质出颜色，底图出布局 ----
  // 用户拍板：地面颜色来自材质贴图本身，而不是地形层那套暗蓝灰调色板，否则抽再多
  // 绿色图渲染出来还是蓝灰（此前的乘性灰度调制只加质感、不改色相）。
  //
  // 分解方式：
  //   底图亮度 → 布局因子 k = 该像素亮度 / 全图平均亮度。走廊亮、墙区暗、河道更暗，
  //              这套明暗关系是地形层辛苦画出来的信息，必须原样保留。
  //   底图色偏 → base − 自身灰度，即阵营基地圈的蓝/红。乘性调制会把它冲掉，
  //              故按 CHROMA_KEEP 单独加回去，保证敌我识别不丢。
  //   材质    → 提供色相与细节，围绕自身均值放大 AMPLIFY 倍以拉开起伏。
  // 结果 = 材质色 × 布局因子 + 底图色偏。
  const bd = g.getImageData(0, 0, W, H), bp = bd.data;
  const ld = lg.getImageData(0, 0, W, H), lp = ld.data;
  let refLum = 0, n = 0;
  for (let i = 0; i < bp.length; i += 4) { refLum += (bp[i] + bp[i + 1] + bp[i + 2]) / 3; n++; }
  refLum = Math.max(1, refLum / n);
  // 材质层自身均值（走廊/高地两种材质混在一起，取整体均值即可）
  let tr = 0, tg = 0, tb = 0, tn = 0;
  for (let i = 0; i < lp.length; i += 4) {
    if (lp[i + 3] === 0) continue;
    tr += lp[i]; tg += lp[i + 1]; tb += lp[i + 2]; tn++;
  }
  if (tn) { tr /= tn; tg /= tn; tb /= tn; }
  const C = (v, m) => Math.max(0, Math.min(255, m + (v - m) * AMPLIFY));
  for (let i = 0; i < bp.length; i += 4) {
    if (lp[i + 3] === 0) continue;
    const bl = (bp[i] + bp[i + 1] + bp[i + 2]) / 3;
    // P1：布局因子向 1 压缩 + 下限 → 野区不再死黑（暗部大幅提亮、亮部几乎不变）
    const k = Math.max(LAYOUT_MIN, 1 + (bl / refLum - 1) * LAYOUT_CONTRAST);
    let r = C(lp[i], tr) * k + (bp[i] - bl) * CHROMA_KEEP;
    let g2 = C(lp[i + 1], tg) * k + (bp[i + 1] - bl) * CHROMA_KEEP;
    let b2 = C(lp[i + 2], tb) * k + (bp[i + 2] - bl) * CHROMA_KEEP;
    // P1：野区染一层植被绿（保留材质起伏，只挪色相）→ 读作丛林草地而非暗土
    if (jungle && jungle[i] > 127) {
      const lum = (r + g2 + b2) / 3, a = JUNGLE_TINT_AMT;
      r  = r  * (1 - a) + lum * JUNGLE_TINT[0] * 2 * a;
      g2 = g2 * (1 - a) + lum * JUNGLE_TINT[1] * 2 * a;
      b2 = b2 * (1 - a) + lum * JUNGLE_TINT[2] * 2 * a;
    }
    bp[i]     = Math.max(0, Math.min(255, r));
    bp[i + 1] = Math.max(0, Math.min(255, g2));
    bp[i + 2] = Math.max(0, Math.min(255, b2));
  }
  g.putImageData(bd, 0, 0);
  return out;
}

/** 加载一张材质贴图；失败返回 null（缺图不该让整个地形崩掉） */
export function loadTexture(url, quiet = false) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    // quiet：探测主题专属贴图时缺失是正常的（会回落到通用图），不该刷警告
    im.onerror = () => { if (!quiet) console.warn('[2.5D] 材质贴图加载失败，回退到程序化配色：' + url); resolve(null); };
    im.src = url;
  });
}
