import { CONFIG } from '../data/Config.js';
import { EXTREME_WEATHERS } from '../data/Weather.js';

/**
 * GroundTraceSystem.js —— 地面痕迹层（水洼/雪盖，Q4 天气重做 + v54 第二轮重做）
 *
 * 雨的水洼、雪的积雪，本质是同一类东西：**地面上会随天气强度动态变化、且对
 * 经过单位有持续效果的区域**（见 docs/Q4-WEATHER-REDESIGN.md §九）。但两者的
 * 实现方式这一轮彻底分开了：
 *
 * - **水洼**：区域生成型——不规则的"大片湿润区域"随机（现在是【权重】撒点，
 *   见 §9.4）撒在地面上，进去减速，可以互相合并。
 * - **雪盖**（v54 全新设计，取代了旧的"脚印瞬间加速"机制）：**连续网格型**——
 *   整个地图铺一张低分辨率网格，随雪的强度/时长整体累积"雪深"，站在雪深高的
 *   地方减速；单位经过会在网格上局部"踩低"雪深留下小径，小径的雪深有个下限
 *   （不会被踩成 0），离开小径后再缓慢回涨——方向跟旧机制完全相反：不再是
 *   "加速"，是"踩过的地方减速幅度比周围雪盖小"。
 *
 * ==================== 为什么不走 EffectRegistry 的常规 aura 机制 ====================
 * makeAuraPassive（skills/_helpers.js）是"以施法者为圆心，扫周围友军"的模型，
 * 这里反过来：是**地面固定区域**，单位路过就吃效果，跟哪个技能/哪个施法者无关。
 * 效果本身仍然复用同一套 aura 参数约定（duration 短、stackPolicy:'refresh'、
 * uniquePassive:true）以获得同样"离开自动脱落、不会因重复 apply 而闪烁"的
 * 行为，只是判定"在不在范围内"的逻辑是这个系统自己算的几何/网格查询，不是
 * findInRadius 以施法者为心的邻域搜索。
 */
export class GroundTraceSystem {
  constructor(entityContainer, effectRegistry, mapSystem, weatherSystem) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.mapSystem = mapSystem;
    this.weather = weatherSystem;

    this.puddles = []; // [{id, x, y, r, strength, subOffsets:[{dx,dy,r}]}]

    // 雪盖网格：resolution×resolution 的 Float32Array，每格是 0~1 的局部雪深。
    this.snowGrid = null;
    this.snowGridRes = 0;
    this.snowGlobalTarget = 0; // 雪盖"应该有"的全局目标深度（不考虑局部踩踏）

    this._rainSustainT = 0;
    this._puddleRespawnT = 0;
    this._nextId = 1;
  }

  update(dt) {
    this._updatePuddles(dt);
    this._updateSnowCover(dt);
    this._applyEffects();
  }

  /** 每次载图重新开局：上一局的水洼/雪盖不该带到新的一局。 */
  reset() {
    this.puddles = [];
    this._rainSustainT = 0;
    this._puddleRespawnT = 0;
    this.snowGrid = null;
    this.snowGridRes = 0;
    this.snowGlobalTarget = 0;
  }

  // ==================== 水洼（雨，v54 §9.4 重做） ====================

  _rainScale() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getEffectiveStrengths?.().rain || 0;
  }

  _rainCharge() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getCharge ? ws.getCharge('rain') : 0;
  }

  /** 读任意天气 id（基础或极端）的当前充能，供各条 Signature 用；找不到就是 0。 */
  _extremeCharge(id) {
    const ws = this.weather;
    if (!ws || !ws.enabled || !ws.getCharge) return 0;
    return ws.getCharge(id) || 0;
  }

  _updatePuddles(dt) {
    const cfg = CONFIG.groundTrace?.puddle || {};
    const scale = this._rainScale();
    const charge = this._rainCharge();

    // 触发门槛：持续够久，或瞬时够猛，两者任一满足。
    if (scale >= (cfg.sustainedThresholdScale ?? 0.75)) this._rainSustainT += dt;
    else this._rainSustainT = 0;
    const active = this._rainSustainT >= (cfg.sustainedSeconds ?? 12)
      || charge >= (cfg.instantChargeThreshold ?? 0.75);

    // 太阳雨 Signature（puddleHighTurnover）：生成更密集、生命周期缩短——
    // "生得快、干得也快"。洪涝 Signature（floodMerge）：合并距离大幅放宽，
    // 水洼连成连续积水带（形态质变，不是数量翻倍）。
    const sunshowerC = this._extremeCharge('sunshower');
    const floodC = this._extremeCharge('flood');
    const sunshowerSig = EXTREME_WEATHERS.sunshower.signature || {};
    const floodSig = EXTREME_WEATHERS.flood.signature || {};
    const spawnMul = sunshowerC > 0 ? 1 + ((sunshowerSig.spawnMul ?? 1.8) - 1) * sunshowerC : 1;
    const lifetimeMul = sunshowerC > 0 ? 1 - (1 - (sunshowerSig.lifetimeMul ?? 0.5)) * sunshowerC : 1;
    const mergeDistMul = floodC > 0 ? 1 + ((floodSig.mergeDistanceMul ?? 3) - 1) * floodC : 1;

    if (active) {
      const targetCount = Math.round((cfg.minPatches ?? 8)
        + ((cfg.maxPatches ?? 20) - (cfg.minPatches ?? 8)) * scale);
      this._puddleRespawnT += dt;
      const interval = (cfg.respawnIntervalSec ?? 2.5) / spawnMul;
      while (this._puddleRespawnT >= interval && this.puddles.length < targetCount) {
        this._puddleRespawnT -= interval;
        this._spawnPuddle(cfg, mergeDistMul);
      }
      if (this._puddleRespawnT > interval) this._puddleRespawnT = interval; // 不欠账累积
      // 高周转：涨得快，也跌得快——decayPerSec 同时按 lifetimeMul 的倒数放大，
      // 只在【有充能】时生效，天气一旦真的停了还是走正常的干涸曲线。
      const growPerSec = (cfg.growPerSec ?? 0.5) / lifetimeMul;
      for (const p of this.puddles) p.strength = Math.min(1, p.strength + growPerSec * dt);
    } else {
      this._puddleRespawnT = 0;
      const decayPerSec = (cfg.decayPerSec ?? 0.08) / lifetimeMul;
      for (const p of this.puddles) p.strength -= decayPerSec * dt;
      this.puddles = this.puddles.filter(p => p.strength > 0);
    }
  }

  /** 在可行走区域内全图随机取一点；找不到就放弃（不强行落在墙里/野区外）。 */
  _randomWalkablePoint() {
    const ms = this.mapSystem;
    const world = ms?.currentMap?.world;
    if (!ms || !world) return null;
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * world.w;
      const y = Math.random() * world.h;
      if (!ms.isWalkable || ms.isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  /**
   * v54 §9.4：沿兵线附近取一点——先随机选一条兵线，再在随机一段路点之间插值，
   * 垂直方向加一个 spread 范围内的随机偏移。找不到兵线数据就返回 null，
   * 调用方会退回全图随机点，不强行依赖地图一定有 lanes。
   */
  _randomLaneNearbyPoint(spread) {
    const ms = this.mapSystem;
    const lanes = ms?.currentMap?.lanes;
    if (!ms || !Array.isArray(lanes) || !lanes.length) return null;
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    const wps = lane?.waypoints;
    if (!wps || wps.length < 2) return null;
    const i = Math.floor(Math.random() * (wps.length - 1));
    const a = wps[i], b = wps[i + 1];
    const t = Math.random();
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    // 垂直于路段方向的单位向量，偏移量在 [-spread, spread] 内随机。
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = (Math.random() * 2 - 1) * spread;
    const x = px + nx * off, y = py + ny * off;
    if (ms.isWalkable && !ms.isWalkable(x, y)) return null;
    return { x, y };
  }

  _spawnPuddle(cfg, mergeDistMul = 1) {
    // v54 §9.4：70~80% 权重沿兵线附近撒点，20~30% 全图自然撒点——不是 100% 沿
    // 兵线（太游戏化，见设计文档），也不是纯随机（大部分落在玩家看不到的野区）。
    const laneRatio = cfg.laneWeightRatio ?? 0.75;
    const spread = cfg.laneSpread ?? 220;
    let pos = null;
    if (Math.random() < laneRatio) pos = this._randomLaneNearbyPoint(spread);
    if (!pos) pos = this._randomWalkablePoint();
    if (!pos) return;
    // 距离够近的已有水洼直接合并进去，而不是各自独立——"水洼可以连接到一块"。
    // 洪涝 Signature 时合并距离被大幅放宽，水洼连成连续积水带。
    const mergeDist = (cfg.mergeDistance ?? 90) * mergeDistMul;
    const near = this.puddles.find(p => Math.hypot(p.x - pos.x, p.y - pos.y) < mergeDist);
    const subOffsets = this._makeSubOffsets(cfg);
    if (near) {
      this._mergeSubOffsets(near, pos, subOffsets, cfg);
      near.strength = Math.max(near.strength, 0.15);
      return;
    }
    const p = { id: this._nextId++, x: pos.x, y: pos.y, strength: 0.05, subOffsets };
    p.r = this._boundingRadius(p);
    this.puddles.push(p);
  }

  _makeSubOffsets(cfg) {
    const n = (cfg.subCirclesPerPatchMin ?? 3)
      + Math.floor(Math.random() * ((cfg.subCirclesPerPatchMax ?? 6) - (cfg.subCirclesPerPatchMin ?? 3) + 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const rMin = cfg.subRadiusMin ?? 50, rMax = cfg.subRadiusMax ?? 90;
      const r = rMin + Math.random() * (rMax - rMin);
      // 子圆中心撒在一个比半径稍大的圈内，让整片形状不规则又保持大致连成一片。
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * r * 0.8;
      out.push({ dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, r });
    }
    return out;
  }

  /** 把新生成的一组子圆（世界坐标偏移量 newPos + newSubOffsets）并入已有水洼 target。 */
  _mergeSubOffsets(target, newPos, newSubOffsets, cfg) {
    for (const so of newSubOffsets) {
      target.subOffsets.push({ dx: (newPos.x + so.dx) - target.x, dy: (newPos.y + so.dy) - target.y, r: so.r });
    }
    const cap = cfg.maxSubCircles ?? 20;
    if (target.subOffsets.length > cap) target.subOffsets = target.subOffsets.slice(-cap);
    target.r = this._boundingRadius(target);
  }

  _boundingRadius(p) {
    let r = 0;
    for (const so of p.subOffsets) r = Math.max(r, Math.hypot(so.dx, so.dy) + so.r);
    return r;
  }

  // ==================== 雪盖（雪，v54 全新设计） ====================

  _snowScale() {
    const ws = this.weather;
    if (!ws || !ws.enabled) return 0;
    return ws.getEffectiveStrengths?.().snow || 0;
  }

  // 每格速率倍率用的空间噪声——两个不同频率、不同轴向的正弦波叠加，跟
  // mapValidate.js 的 laneWidthNoise 同一手法（那边注释："哈希是给散点装饰用的
  // ——每个点互不相关；这里要的是连续、平滑的起伏，用哈希会变成锯齿状抖动"）。
  // 频率常数跟 laneWidthNoise 刻意错开，避免雪的斑驳纹理跟着道路的宽窄起伏走
  // （两者语义无关，撞了频率会看起来像"雪跟着路的形状铺"）。
  _snowCellNoise(x, y) {
    return Math.sin(x * 0.0057 + y * 0.0031) * 0.5 + Math.sin(x * 0.0019 - y * 0.0083) * 0.5;
  }

  _ensureSnowGrid(world) {
    const cfg = CONFIG.groundTrace?.snowCover || {};
    const res = Math.max(8, cfg.gridResolution ?? 48);
    if (this.snowGrid && this.snowGridRes === res) return;
    this.snowGrid = new Float32Array(res * res);
    this.snowGridRes = res;
    // 每格一份固定不变的速率倍率（只在网格新建时算一次）：有的格子天生涨得快、
    // 有的天生涨得慢，全部收敛到同一个 snowGlobalTarget，但"谁先谁后"从空间上
    // 错开，看起来是自然蔓延，不是全图同步的一次性刷白（真根因见下面 _updateSnowCover
    // 头注 2026-09-20 记录）。没有 world 尺寸时退化成全 1（不变），下一帧
    // _updateSnowCover 拿到 world 后会重新走一次这个函数把倍率补上。
    const amp = cfg.cellRateNoiseAmp ?? 0.65;
    const floor = cfg.cellRateNoiseFloor ?? 0.25;
    this.snowCellRateMul = new Float32Array(res * res).fill(1);
    if (world) {
      const cellW = world.w / res, cellH = world.h / res;
      for (let gy = 0; gy < res; gy++) {
        for (let gx = 0; gx < res; gx++) {
          const wx = (gx + 0.5) * cellW, wy = (gy + 0.5) * cellH;
          const mul = Math.max(floor, 1 + this._snowCellNoise(wx, wy) * amp);
          this.snowCellRateMul[gy * res + gx] = mul;
        }
      }
    }
  }

  /**
   * 雪盖整体的推进：
   *   全局目标深度 snowGlobalTarget 追着雪的强度走（只有强度过了 minChargeToGrow
   *   才开始往上涨——"雪下到一定程度后，才缓缓显出积雪"；强度不够时缓慢消退）。
   *   每一格的局部深度 snowGrid[i] 追着这个全局目标走（regrowPerSec × 每格自己的
   *   速率倍率 snowCellRateMul，见 _ensureSnowGrid 头注——2026-09-20 第三次修复
   *   记录：前两次分别改了"时间常数"和"曲线形状"，症状依旧是"整块地面同一时刻
   *   刷白"，根因是全图每一格用的是【同一条速率】，天生就会同步——不是曲线的问题，
   *   是"没有空间差异"的问题，现在每格速率各自固定错开，蔓延感靠这个），除非这一帧
   *   有单位站在这一格——那时局部深度被【踩低】（erodePerSec），但设了下限
   *   （pathFloor × 全局目标），不会被踩成 0，这就是"小径"。
   */
  _updateSnowCover(dt) {
    const cfg = CONFIG.groundTrace?.snowCover || {};
    const ms = this.mapSystem;
    const world = ms?.currentMap?.world;
    if (!world) return;
    this._ensureSnowGrid(world);

    const scale = this._snowScale();
    const minChargeToGrow = cfg.minChargeToGrow ?? 0.25;
    const growTarget = scale >= minChargeToGrow ? Math.min(1, cfg.maxDepth ?? 1) : 0;
    // 暴风雪 Signature（snowCoverWindBoost）：雪盖增长速度挂到风强度上，设增长
    // 响应上限（growthCap）防止风一大瞬间铺满全图。
    const blizzardC = this._extremeCharge('blizzard');
    const windCharge = this._extremeCharge('wind');
    const blizzardSig = EXTREME_WEATHERS.blizzard.signature || {};
    const windGrowthMul = blizzardC > 0
      ? Math.min(blizzardSig.growthCap ?? 2.5, 1 + ((blizzardSig.growthMul ?? 1.8) - 1) * windCharge * blizzardC)
      : 1;
    const growPerSec = (cfg.growPerSec ?? 0.02) * windGrowthMul;
    const decayPerSec = cfg.decayPerSec ?? 0.03;
    // ==================== 2026-09-19 二次修复：指数逼近换成匀速线性推进 ====================
    // 用户第三次反馈同一个症状："雪依旧直接土地一下子变成白色"——上一轮只是把
    // 指数逼近的时间常数拉长（0.02/0.03 → 0.003/0.005），但没换掉曲线的**形状**。
    // 指数逼近 `x += (target-x)*rate` 天生是"越接近起点涨得越快、越接近终点涨得
    // 越慢"：哪怕总耗时拉到几分钟，头 20 秒（远小于总时长）也已经吃掉了将近一半
    // 的总变化量（τ=33s 时，20s ≈ 1-e^(-0.6) ≈ 45%）——人眼在这短短 20 秒里看到的
    // 就是"唰"一下奔到快一半白，跟总时长有没有拉长没关系，因为**变化率本身**
    // 从开始那一刻就是全程最快的，不是逐渐加速再逐渐放缓。
    // 换成匀速线性推进：每秒固定涨/退 growPerSec/decayPerSec 这么多（不再乘以
    // 剩余差值），全程变化率恒定，不存在"前段特别快"这个视觉尖峰。此时
    // growPerSec/decayPerSec 的含义也跟着变了：不再是指数的时间常数系数，
    // 而是直接的"每秒增减多少"，1/growPerSec 就是从0到1所需的准确秒数——
    // 下面把默认值重新标定为"匀速120秒铺满、匀速80秒退净"（CONFIG.js 同步更新）。
    const growStep = growPerSec * dt;
    const decayStep = decayPerSec * dt;
    if (growTarget > this.snowGlobalTarget) {
      this.snowGlobalTarget = Math.min(growTarget, this.snowGlobalTarget + growStep);
    } else if (growTarget < this.snowGlobalTarget) {
      this.snowGlobalTarget = Math.max(growTarget, this.snowGlobalTarget - decayStep);
    }

    const res = this.snowGridRes;
    const grid = this.snowGrid;
    const rateMul = this.snowCellRateMul;
    const regrowRate = Math.min(1, (cfg.regrowPerSec ?? 0.05) * dt);
    // 全图格子朝全局目标回涨（踩踏留下的小径也在这一步缓慢恢复），但不是同一个
    // 速率——每格乘自己固定的空间噪声倍率，有的格子先到、有的格子晚到，蔓延感
    // 靠这个（见本函数头注 2026-09-20 记录的真根因）。
    for (let i = 0; i < grid.length; i++) {
      grid[i] += (this.snowGlobalTarget - grid[i]) * regrowRate * (rateMul ? rateMul[i] : 1);
    }

    // 单位经过时局部踩踏：把周围 erodeRadius 内的格子压低，但设下限（不会踩成 0）。
    if (this.snowGlobalTarget > 0.001) {
      const erodeRadius = cfg.erodeRadius ?? 70;
      const erodeAmt = Math.min(1, (cfg.erodePerSec ?? 1.2) * dt);
      const pathFloor = cfg.pathFloor ?? 0.3;
      const cellW = world.w / res, cellH = world.h / res;
      const rCellsX = Math.max(1, Math.ceil(erodeRadius / cellW));
      const rCellsY = Math.max(1, Math.ceil(erodeRadius / cellH));
      for (const m of this.entities.getAllMinions(true)) {
        if (!m.alive || !m.pos) continue;
        const cx = Math.floor(m.pos.x / cellW), cy = Math.floor(m.pos.y / cellH);
        const floor = pathFloor * this.snowGlobalTarget;
        for (let gy = cy - rCellsY; gy <= cy + rCellsY; gy++) {
          if (gy < 0 || gy >= res) continue;
          for (let gx = cx - rCellsX; gx <= cx + rCellsX; gx++) {
            if (gx < 0 || gx >= res) continue;
            const wx = (gx + 0.5) * cellW, wy = (gy + 0.5) * cellH;
            if (Math.hypot(wx - m.pos.x, wy - m.pos.y) > erodeRadius) continue;
            const idx = gy * res + gx;
            if (grid[idx] > floor) grid[idx] = Math.max(floor, grid[idx] - erodeAmt);
          }
        }
      }
    }
  }

  /** 某世界坐标处的当前局部雪深（0~1）；地图未就绪或坐标越界时返回 0。 */
  _snowDepthAt(x, y) {
    const world = this.mapSystem?.currentMap?.world;
    if (!world || !this.snowGrid) return 0;
    const res = this.snowGridRes;
    const gx = Math.max(0, Math.min(res - 1, Math.floor(x / world.w * res)));
    const gy = Math.max(0, Math.min(res - 1, Math.floor(y / world.h * res)));
    return this.snowGrid[gy * res + gx] || 0;
  }

  // ==================== 效果应用 ====================

  _applyEffects() {
    const puddleCfg = CONFIG.groundTrace?.puddle || {};
    const snowCfg = CONFIG.groundTrace?.snowCover || {};
    for (const m of this.entities.getAllMinions(true)) {
      if (!m.alive || !m.pos) continue;

      let inPuddle = 0;
      for (const p of this.puddles) {
        if (p.strength <= 0) continue;
        for (const so of p.subOffsets) {
          const cx = p.x + so.dx, cy = p.y + so.dy;
          if (Math.hypot(m.pos.x - cx, m.pos.y - cy) <= so.r) { inPuddle = Math.max(inPuddle, p.strength); break; }
        }
      }
      if (inPuddle > 0) {
        this.effects.apply(m.id, {
          // aura:true 时 EffectRegistry 会把 duration 强制设成 Infinity，改用宽限期
          // （auraGrace）自动到期——不用也不该在这里再传 duration，见
          // EffectRegistry.apply 的"光环机制"头注。
          aura: true, auraGrace: 1.0, name: '水洼', icon: '💧', kind: 'stat', statKey: 'moveSpeed',
          percent: (puddleCfg.slowPct ?? -25) * inPuddle,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `水洼：移速 ${(puddleCfg.slowPct ?? -25) * inPuddle >= 0 ? '+' : ''}${Math.round((puddleCfg.slowPct ?? -25) * inPuddle)}%`,
        }, 'groundtrace_puddle');
      }

      // v54 全新设计：雪盖站里面减速，局部雪深由网格给出（踩出的小径雪深低，
      // 减速幅度自然跟着小——不需要另外维护一份"小径"数据结构）。
      const depth = this._snowDepthAt(m.pos.x, m.pos.y);
      if (depth > 0.02) {
        const pct = (snowCfg.slowPct ?? -22) * depth;
        this.effects.apply(m.id, {
          aura: true, auraGrace: 1.0, name: '积雪', icon: '❄️', kind: 'stat', statKey: 'moveSpeed',
          percent: pct,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `积雪：移速 ${pct >= 0 ? '+' : ''}${Math.round(pct)}%`,
        }, 'groundtrace_snowcover');
      }
    }
  }

  /** 供渲染层读——只读快照。 */
  getPuddles() { return this.puddles; }
  /** 供渲染层读——雪盖网格快照，{resolution, data(Float32Array), worldW, worldH}。 */
  getSnowCover() {
    const world = this.mapSystem?.currentMap?.world;
    if (!this.snowGrid || !world) return null;
    return { resolution: this.snowGridRes, data: this.snowGrid, worldW: world.w, worldH: world.h };
  }
}
