/**
 * terrainField.js —— 地形高度场（纯数据，不依赖 three，无头测试可直接跑）。
 *
 * 地形不是画出来的贴图，而是由地图数据推出来的一张高度场：
 *   可走区          → 地面（路面略低、野地有起伏、基地在台地上、河是浅滩）
 *   不可走区 rise   → 隆起成岩壁（峡谷 / 丛林类地图）
 *   不可走区 drop   → 下沉成深渊或谷地（桥 / 台地类地图）
 *   地图范围之外    → 延伸成山体，被雾吃掉 —— 没有"地图边缘"，地图不再是浮空的一张纸
 *
 * 画面（world/WorldTerrain.js）和逻辑层的"地面高度查询"（MapSystem.heightAt）读的是同一张场，
 * 所以单位、弹道、水洼的落点和看到的地面永远对得上。
 *
 * 形状判据全部来自 MapSystem：isWalkable（位图 / 走廊）、_nearestOnLane（兵线）、
 * riverFactor（河道唯一真源）、plateauHeightAt（基地台地）、getPit（龙坑）。这里只负责"纵向怎么长"。
 * 参数在 CONFIG.terrain。
 */
import { CONFIG } from './Config.js';
import { fbm, ridged, smoothstep, clamp01 } from './noise.js';
import { dominionKeepOut } from './dominionSites.js';

/** 地图用哪套地形主题：map.terrainTheme > map.paletteId > default。 */
export function terrainThemeIdOf(map) {
  const T = CONFIG.terrain?.themes || {};
  if (map?.terrainTheme && T[map.terrainTheme]) return map.terrainTheme;
  if (map?.paletteId && T[map.paletteId]) return map.paletteId;
  return 'forest';
}
export function terrainThemeOf(map) {
  return (CONFIG.terrain?.themes || {})[terrainThemeIdOf(map)] || { mode: 'rise' };   // 没有任何主题配置时退回最简单的"隆起"
}

// ---------- 欧氏距离变换（Felzenszwalb），返回每格到最近"特征格"的距离（单位：格） ----------
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--; else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
function edt(feature, nx, ny) {
  const INF = 1e12, N = Math.max(nx, ny);
  const g = new Float64Array(nx * ny), f = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1);
  for (let i = 0; i < nx * ny; i++) g[i] = feature[i] ? 0 : INF;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = g[y * nx + x];
    edt1d(f, ny, d, v, z);
    for (let y = 0; y < ny; y++) g[y * nx + x] = d[y];
  }
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = g[y * nx + x];
    edt1d(f, nx, d, v, z);
    for (let x = 0; x < nx; x++) out[y * nx + x] = Math.sqrt(d[x]);
  }
  return out;
}
function boxBlur(a, nx, ny, r) {
  if (r <= 0) return a;
  const t = new Float32Array(a.length), o = new Float32Array(a.length), w = 2 * r + 1;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += a[y * nx + Math.max(0, Math.min(nx - 1, x + k))];
    t[y * nx + x] = s / w;
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += t[Math.max(0, Math.min(ny - 1, y + k)) * nx + x];
    o[y * nx + x] = s / w;
  }
  return o;
}

/**
 * 建高度场。
 * @param ms  MapSystem（或鸭子类型：currentMap / isWalkable / _nearestOnLane / riverFactor / plateauHeightAt / getPit /
 *            getBaseCircleCenter / getBaseOpenRadius）
 */
export function buildTerrainField(ms) {
  const map = ms.currentMap;
  const W = map.world.w, H = map.world.h;
  const C = CONFIG.terrain, F = C.field, G = C.ground, R = C.river, K = C.cliff, D = C.drop, O = C.outer;
  const theme = terrainThemeOf(map), mode = theme.mode === 'drop' ? 'drop' : 'rise';
  const cell = Math.max(F.minCell, Math.max(W, H) / F.targetN);
  const nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
  const N = nx * ny;

  // ---- 1. 可走遮罩 → 有符号距离场 sd（世界单位；可走区为负，墙里为正）----
  const pad = F.padCells, px = nx + 2 * pad, py = ny + 2 * pad;
  const walkP = new Uint8Array(px * py), wallP = new Uint8Array(px * py);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) {
    const ci = i - pad, cj = j - pad;
    const inside = ci >= 0 && cj >= 0 && ci < nx && cj < ny;
    // 采样点取格子本身的位置；边界上的那一圈点往里收半格，免得正好踩在世界边界外
    const x = Math.min(W - 0.01, Math.max(0.01, ci * cell)), y = Math.min(H - 0.01, Math.max(0.01, cj * cell));
    const w = inside && ms.isWalkable(x, y) ? 1 : 0;
    walkP[j * px + i] = w; wallP[j * px + i] = 1 - w;
  }
  const dToWalk = edt(walkP, px, py), dToWall = edt(wallP, px, py);
  let sdP = new Float32Array(px * py);
  for (let i = 0; i < px * py; i++) sdP[i] = (walkP[i] ? -(dToWall[i] - 0.5) : (dToWalk[i] - 0.5)) * cell;
  sdP = boxBlur(sdP, px, py, F.sdBlur | 0);
  const sd = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sd[j * nx + i] = sdP[(j + pad) * px + (i + pad)];

  // ---- 2. 兵线距离（降采样算，双线性取）----
  const lanes = map.lanes || [];
  const lr = Math.max(1, F.laneRes | 0), lnx = Math.ceil((nx - 1) / lr) + 1, lny = Math.ceil((ny - 1) / lr) + 1;
  const laneC = new Float32Array(lnx * lny);
  for (let j = 0; j < lny; j++) for (let i = 0; i < lnx; i++) {
    const x = i * lr * cell, y = j * lr * cell;
    let d = 1e9;
    for (const l of lanes) { const r = ms._nearestOnLane(l, x, y); if (r && r.dist < d) d = r.dist; }
    laneC[j * lnx + i] = d;
  }
  const bil = (arr, ax, ay, fx, fy) => {
    const x0 = Math.max(0, Math.min(ax - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(ay - 1, Math.floor(fy)));
    const x1 = Math.min(ax - 1, x0 + 1), y1 = Math.min(ay - 1, y0 + 1);
    const tx = clamp01(fx - x0), ty = clamp01(fy - y0);
    const a = arr[y0 * ax + x0], b = arr[y0 * ax + x1], c = arr[y1 * ax + x0], d = arr[y1 * ax + x1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const lane = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) lane[j * nx + i] = bil(laneC, lnx, lny, i / lr, j / lr);

  // ---- 3. 河 ----
  const river = new Float32Array(N);
  let hasRiver = false;
  if (typeof ms.riverFactor === 'function') {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = ms.riverFactor(i * cell, j * cell) || 0;
      if (v > 0) { river[j * nx + i] = v; hasRiver = true; }
    }
  }
  const pits = ['dragon', 'baron'].map((k) => ms.getPit?.(k)).filter(Boolean);
  const bases = ['blue', 'red'].map((f) => ({ c: ms.getBaseCircleCenter?.(f), r: ms.getBaseOpenRadius?.(f) })).filter((b) => b.c && b.r);

  // ---- 4. 合成高度 ----
  const h = new Float32Array(N);
  const cliffH0 = theme.cliffHeight ?? K.height;
  const dropH = theme.dropHeight ?? 200, floorNoise = theme.dropFloorNoise ?? 0;
  // 陆块（深渊图可选，theme.landmass）：每个基地背后是一整块实地，实地在离基地中心 cliffDist 处断成悬崖，
  // 两块实地之间是一道峡谷，可走的那一条窄带横跨峡谷 —— 那就是桥（桥体另外建模，见 world/WorldBridge.js）。
  // 没有这个声明时，所有不可走区一律从可走区边缘往下沉（可走区是立在深渊里的一座台子）。
  //   landAt(x, y) → { L: 1 = 实地 … 0 = 峡谷上空, dc: 越过崖线多远（> 0 在峡谷上空）}，地图矩形内外都能算
  const LM = mode === 'drop' && theme.landmass && bases.length >= 2 ? theme.landmass : null;
  const mid = { x: W / 2, y: H / 2 };
  const landAxes = LM ? bases.map((b) => { const dx = mid.x - b.c.x, dy = mid.y - b.c.y, l = Math.hypot(dx, dy) || 1; return { c: b.c, ux: dx / l, uy: dy / l }; }) : null;
  const landAt = LM ? (x, y) => {
    const wob = (fbm(x * (LM.edgeFreq ?? 0.004), y * (LM.edgeFreq ?? 0.004), 3, 91) - 0.5) * 2 * (LM.edgeNoise ?? 60)
      + (fbm(x * 0.021, y * 0.021, 2, 93) - 0.5) * 2 * (LM.edgeNoise ?? 60) * 0.22;
    let dc = Infinity;
    for (const a of landAxes) dc = Math.min(dc, (x - a.c.x) * a.ux + (y - a.c.y) * a.uy - (LM.cliffDist ?? 500) + wob);
    return { L: 1 - smoothstep(-(LM.lip ?? 10), LM.lip ?? 10, dc), dc };
  } : null;
  /** 峡谷的剖面：崖面从崖线陡直落下去，带一层层岩台，谷底有起伏 */
  const chasmAt = (x, y, dc) => {
    const p = smoothstep(0, 1, dc / (LM.cliffWidth ?? 90));
    return -dropH * Math.pow(p, 0.85)
      + (ridged(x * 0.017, y * 0.017, 3, 53) - 0.5) * (LM.ledge ?? 60) * 4 * p * (1 - p)
      + (floorNoise ? (fbm(x * 0.006, y * 0.006, 3, 57) - 0.35) * floorNoise * p : 0);
  };
  /** 实地上的不可走区：雪坡缓缓隆起成一圈矮岩埂（基地窝在里面），不是悬崖 */
  const landRiseAt = (x, y, e) => {
    const p = smoothstep(0, 1, e / (LM.rimWidth ?? 70));
    return (LM.rimHeight ?? 30) * p * (0.55 + 0.9 * fbm(x * 0.009, y * 0.009, 3, 95)) + (fbm(x * 0.03, y * 0.03, 2, 97) - 0.5) * 8 * p;
  };
  const pads = dominionKeepOut(map);   // 没有据点场景物的地图是空的
  const hT = LM ? new Float32Array(N) : null;   // 画出来的地形高度（桥下是峡谷）；逻辑高度 h 里桥面仍是桥面
  const groundAt = (x, y, ld) => {
    const base = ms.plateauHeightAt ? ms.plateauHeightAt(x, y) : 0;
    const pathT = smoothstep(G.pathHalf, G.pathHalf + G.pathFeather, ld);   // 0 = 路面，1 = 野地
    let flat = 0;
    for (const b of bases) { const d = Math.hypot(x - b.c.x, y - b.c.y); flat = Math.max(flat, 1 - smoothstep(b.r * G.baseFlatInner, b.r, d)); }
    const wild = pathT * (1 - flat);
    return base - G.pathDip * (1 - pathT)
      + ((fbm(x * G.rollFreq, y * G.rollFreq, 3, 11) - 0.5) * 2 * G.rollAmp + (fbm(x * G.bumpFreq, y * G.bumpFreq, 2, 23) - 0.5) * 2 * G.bumpAmp) * wild;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = i * cell, y = j * cell, s = sd[k], ld = lane[k];
    let g = groundAt(x, y, ld);
    if (hasRiver) g = Math.max(g, R.level + 1.6);   // 野地的洼处不能低过水面，否则会冒出一摊摊没来由的水
    // 河床：可走河段是浅滩；岩壁之间（不可走）是深潭；兵线过河处是更浅的渡口
    const rf = river[k];
    if (rf > 0) {
      let bed = s <= 0 ? R.bed : R.bed + (R.deepBed - R.bed) * smoothstep(0, 40, s);
      const ford = 1 - smoothstep(G.pathHalf + 10, G.pathHalf + G.pathFeather + 40, ld);
      bed = bed + (Math.max(bed, R.fordBed) - bed) * ford;
      bed += (fbm(x * 0.03, y * 0.03, 2, 29) - 0.5) * 1.2;
      const t = rf * rf * (3 - 2 * rf);
      g = g * (1 - t) + bed * t;
    }
    // 龙坑 / 男爵坑：河心一片天然的浅滩 —— 边缘不规则、缓缓没进水里，不是一张正圆的石台
    //（用户："把龙坑那个特别丑的台删掉，或者换一个不太明显的方式显示"）
    for (const p of pits) {
      const d0 = Math.hypot(x - p.x, y - p.y), PT = C.pit;
      if (d0 > p.r * R.pitClearK * (1 + (PT.edgeNoise ?? 0))) continue;
      const d = d0 * (1 + (fbm(x * (PT.edgeFreq ?? 0.012), y * (PT.edgeFreq ?? 0.012), 3, 71) - 0.5) * 2 * (PT.edgeNoise ?? 0));
      if (d < p.r * R.pitClearK) {
        const t = 1 - smoothstep(p.r * PT.rimK, p.r * R.pitClearK, d);
        g = g * (1 - t) + (PT.floor + (fbm(x * 0.03, y * 0.03, 2, 73) - 0.5) * 2 * (PT.bump ?? 0)) * t;
      }
    }
    if (mode === 'rise') {
      const e = s - K.edgeNoise * fbm(x * K.edgeFreq, y * K.edgeFreq, 3, 31);   // 只往墙里收，崖脚不侵入可走区
      if (e > 0) {
        const p = Math.pow(smoothstep(0, 1, e / K.width), 0.85);
        const ch = cliffH0 + (fbm(x * 0.0031, y * 0.0031, 3, 41) - 0.5) * 2 * K.heightVar + Math.min(K.deepMax, e * K.deepGain);
        const top = (fbm(x * 0.027, y * 0.027, 3, 47) - 0.5) * 2 * K.topNoise * p;
        // 河从地图边缘流出去的地方，岩壁让开一条峡口（地图内部的岩壁照常立着，河绕着走）
        const dEdge = Math.min(x, y, W - x, H - y);
        const gorge = rf > 0 ? smoothstep(0, 0.4, rf) * (1 - smoothstep(180, 460, dEdge)) : 0;
        g += (ch * p + top) * (1 - gorge);
      }
    } else if (LM) {
      const { L, dc } = landAt(x, y);
      const base = ms.plateauHeightAt ? ms.plateauHeightAt(x, y) : 0;
      // 实地：可走区照常；不可走区是隆起的雪坡
      const gLand = s > 0 ? g + landRiseAt(x, y, s) : g;
      const gChasm = chasmAt(x, y, dc);
      const land = L >= 1 ? gLand : gChasm + (gLand - gChasm) * L;
      hT[k] = land;
      // 逻辑高度：桥面（峡谷上空的可走区，外加 deckMargin 宽的一圈）是平的桥面高度，单位站在桥上；其余同画出来的地形
      const deck = L < 1 && s <= (LM.deckMargin ?? 14);
      g = deck ? base * (1 - L) + land * L : land;
      if (deck && L < 0.5) g = base;
    } else {
      const e = s - 4;
      if (e > 0) {
        let p = smoothstep(0, 1, e / D.width);
        // 场景物（据点的风车、钻机……）脚下垫平：它们有一半探出可走的台面，底下不能是悬空的
        for (const k of pads) { const d = Math.hypot(x - k.x, y - k.y); if (d < k.r * 1.5) p *= smoothstep(k.r * 1.05, k.r * 1.5, d); }
        g -= dropH * Math.pow(p, 1.3);
        g += (ridged(x * 0.021, y * 0.021, 3, 53) - 0.5) * D.ledgeNoise * 4 * p * (1 - p);   // 崖面上的岩台
        if (floorNoise) g += (fbm(x * 0.006, y * 0.006, 3, 57) - 0.35) * floorNoise * p;       // 谷底起伏（沙丘）
      }
    }
    h[k] = g;
  }

  // ---- 5. 查询接口 ----
  const fieldAt = (arr, x, y) => bil(arr, nx, ny, Math.max(0, Math.min(W, x)) / cell, Math.max(0, Math.min(H, y)) / cell);
  const blend = theme.outerBlend ?? O.blend, peak = theme.outerPeak ?? O.peakHeight;
  const heightOf = (arr) => (x, y) => {
    const cx = Math.max(0, Math.min(W, x)), cy = Math.max(0, Math.min(H, y));
    const hc = fieldAt(arr, cx, cy);
    const dOut = Math.hypot(x - cx, y - cy);
    if (dOut <= 0) return hc;
    // 延伸世界：从地图边缘的高度过渡到山体，越远越高。距离用噪声扭一下，山脚线不跟着地图的矩形走。
    const warp = (fbm(x * 0.0027, y * 0.0027, 3, 59) - 0.5) * 2;
    const dW = Math.max(0, dOut * (1 + 0.5 * warp));
    const far = clamp01(dW / O.peakDist);
    const m = O.baseHeight + (peak - O.baseHeight) * Math.pow(far, 1.25)
      + (fbm(x * O.noiseFreq, y * O.noiseFreq, 5, 61) - 0.5) * 2 * O.noiseAmp * (0.35 + 0.65 * far)
      + (ridged(x * O.noiseFreq * 2.3, y * O.noiseFreq * 2.3, 4, 67) - 0.4) * O.noiseAmp * 0.6 * far;
    let out;
    if (mode === 'rise') {
      // 地图外侧紧贴着的一圈至少是岩壁那么高（可玩区被山围着，不是悬在半空）
      const wall = (cliffH0 + (fbm(x * 0.0031, y * 0.0031, 3, 41) - 0.5) * 2 * K.heightVar + (fbm(x * 0.027, y * 0.027, 3, 47) - 0.5) * 2 * K.topNoise)
        * smoothstep(0, K.width * 1.6, dOut + Math.max(0, fieldAt(sd, cx, cy)));
      out = Math.max(hc, wall);
      out = out + (m - out) * smoothstep(0, blend, dW);
    } else if (LM) {
      // 地图之外：实地继续往外长成雪山；峡谷照样往两头延伸，直到被雾吃掉
      const { L, dc } = landAt(x, y);
      const gLand = Math.max(0, hc) + (m - Math.max(0, hc)) * smoothstep(blend * 0.12, blend, dW);
      const gChasm = chasmAt(x, y, dc);
      out = L >= 1 ? gLand : gChasm + (gLand - gChasm) * L;
    } else {
      out = hc + (m - hc) * smoothstep(blend * 0.12, blend, dW);
    }
    if (hasRiver) {
      // 河流出地图之后继续在山谷里流，直到被雾吃掉
      const rf = ms.riverFactor(x, y) || 0;
      const dAxis = Math.abs(x - y) * Math.SQRT1_2;
      const v = 1 - smoothstep(R.valleyHalf * 0.3, R.valleyHalf * (1 + far), dAxis);
      if (v > 0) { const floor = 8 + (R.bed - 8) * (rf * rf * (3 - 2 * rf)); out = out * (1 - v) + floor * v; }
    }
    return out;
  };
  const heightAt = heightOf(h), terrainHeightAt = hT ? heightOf(hT) : heightAt;
  return {
    map, mode, theme, themeId: terrainThemeIdOf(map), cell, nx, ny, W, H,
    h, sd, lane, river, hasRiver, pits, bases,
    // 画出来的地形高度（有桥的图里，桥下是峡谷而不是桥面）。没有陆块声明时与 h / heightAt 是同一份
    hTerrain: hT || h, terrainHeightAt, landAt, landmass: LM,
    waterLevel: hasRiver ? R.level : null,
    extent: O.extent,
    heightAt,
    sdAt: (x, y) => fieldAt(sd, x, y) + Math.hypot(x - Math.max(0, Math.min(W, x)), y - Math.max(0, Math.min(H, y))),
    laneAt: (x, y) => fieldAt(lane, x, y),
    riverAt: (x, y) => (hasRiver ? (x >= 0 && y >= 0 && x <= W && y <= H ? fieldAt(river, x, y) : (ms.riverFactor(x, y) || 0)) : 0),
    /** 数值法线（世界空间，y 朝上），d = 差分步长 */
    normalAt: (x, y, d = cell) => {
      const gx = (heightAt(x + d, y) - heightAt(x - d, y)) / (2 * d), gz = (heightAt(x, y + d) - heightAt(x, y - d)) / (2 * d);
      const l = Math.hypot(gx, 1, gz); return [-gx / l, 1 / l, -gz / l];
    },
  };
}
