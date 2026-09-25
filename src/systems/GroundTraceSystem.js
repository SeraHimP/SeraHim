import { CONFIG, stylizedPaletteOf } from '../data/Config.js';
import { EXTREME_WEATHERS } from '../data/Weather.js';
import { forestZoneAt } from '../data/mapValidate.js';

/**
 * 供渲染层（VegetationLayer/BoundaryDecorLayer）按世界坐标点采样雪深——与
 * GroundTraceLayer.update 里逐格铺贴纹理时用的下标公式完全同一套（行优先，
 * floor(坐标/世界尺寸*分辨率)），抽成纯函数供"点采样"场景复用，不在每个
 * 调用点各写一份容易跑偏的下标算法。
 * @param {{resolution:number, data:Float32Array, worldW:number, worldH:number}|null} snow getSnowCover() 的快照
 */
export function sampleSnowGrid(snow, x, y) {
  if (!snow || !snow.data || !snow.worldW || !snow.worldH) return 0;
  const res = snow.resolution;
  const gx = Math.max(0, Math.min(res - 1, Math.floor(x / snow.worldW * res)));
  const gy = Math.max(0, Math.min(res - 1, Math.floor(y / snow.worldH * res)));
  return snow.data[gy * res + gx] || 0;
}

/**
 * ==================== v55.8 修复："下雪天塔的颜色会跟随小兵走过而变化" ====================
 * 用户报：塔本来落了雪，旁边小兵一走过，塔的颜色就跟着变——很诡异。排查实测：
 * 塔的落雪效果（InstancedBodyLayer.updateSnow）跟野区植被用的是同一份 sampleSnowGrid
 * + 同一份 snowGrid，而 snowGrid 正是"单位经过时局部踩踏"（_updateSnowCover 里的
 * 侵蚀循环）会去压低的那份数据——侵蚀设计的本意是"小兵踩出的路径雪浅"，是给【地面】
 * 用的视觉反馈，但塔的落雪效果查的是塔自己所在坐标点的 snowGrid 值：小兵只要在
 * erodeRadius（默认70世界单位）内经过，塔那个坐标点的雪深就会被一起压低，塔的
 * "白了多少"因此跟着小兵的走位实时抖动——塔是石头/金属结构，不是会被踩的地面，
 * 被路过的小兵改变落雪程度没有任何物理意义，纯粹是"两者共用同一份数据"的副作用。
 * 实测验证：让一个假小兵站在塔旁 30 世界单位处，塔坐标点的 sampleSnowGrid 从 1.0
 * 被侵蚀到 0.29（见调试脚本），复现了用户描述的现象。
 * 修法：塔改用这个新的 sampleSnowTarget/getSnowTarget——只读"这一格该积多少雪"的
 * 目标值（全局目标 × 野区加成），不经过侵蚀步骤，塔的雪量只跟天气本身的强度/时长
 * 走，不再受旁边有没有小兵经过影响。地面（GroundTraceLayer）、植被（VegetationLayer/
 * BoundaryDecorLayer）不受影响，仍然读原来那份会被侵蚀的 snowGrid——它们本来就是
 * "地面"，侵蚀的踩踏小径视觉在那里是有意义的，不属于今天要改的范围。
 */
export function sampleSnowTarget(snap, x, y) {
  if (!snap || !snap.worldW || !snap.worldH) return 0;
  const { globalTarget, zoneMix, jungleMaxMul, resolution } = snap;
  if (!zoneMix) return globalTarget;
  const res = resolution;
  const gx = Math.max(0, Math.min(res - 1, Math.floor(x / snap.worldW * res)));
  const gy = Math.max(0, Math.min(res - 1, Math.floor(y / snap.worldH * res)));
  const idx = gy * res + gx;
  return zoneMix[idx] ? Math.min(1, globalTarget * jungleMaxMul) : globalTarget;
}

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
    // 积雪材质差异化（v55.1）：每格一份 0~1 的"野区程度"（forestZoneAt!==0 的
    // 森林分级），只在网格新建时算一次——跟 snowCellRateMul 同一节奏，同样是
    // 只依赖地形本身、不随天气变化的静态量。路面(0)恒为0，森林分级 1/2/3
    // 一律记 1（先只做"路 vs 野区"二分，不细分三档，见 Config.js
    // groundTrace.snowCover.jungleMaxDepthMul 头注）。没有 lanes（森林分区判据
    // 的前提，比如没有森林概念的老地图）时整张恒为 0，效果与改动前逐位一致。
    this.snowCellZoneMix = new Float32Array(res * res); // 全 0 = 默认（无差异化）
    const map = this.mapSystem?.currentMap;
    const hasForest = Array.isArray(map?.lanes) && map.lanes.length > 0;
    // ==================== v55.3 修复：雪盖不该铺到水面上 ====================
    // 用户报"嚎哭深渊·冰封"这张图的水域也盖了一层雪——根因是雪盖网格原来
    // 不区分地形类型，整张地图矩形范围内的格子统统朝 snowGlobalTarget 涨，
    // 对召唤师峡谷这类"不可走=野区"的图碰巧没问题（野区也是陆地，落雪合理），
    // 但对嚎哭深渊冰封版这类"不可走=水面"的图，水面也被刷了一层雪，违反常识。
    // "可走 vs 不可走"本身不能当判据（两张图对不可走区域的含义完全相反），
    // 复用 VegetationLayer.build() 已经在用的同一个信号——调色板声明
    // vegetationMode:'none' 就是"这张图的非路面区域不是森林，是别的东西（水/
    // 浮冰），不该按野区规则铺装饰"，雪盖沿用同一条判据：这种图里"不可走"的
    // 格子标记为不积雪（noGrow=1），路面格子照常积雪；其余图（'jungle'/默认
    // 未声明）不受影响，不可走区域仍然是野区，继续正常积雪，逐位不变。
    this.snowCellNoGrow = new Float32Array(res * res); // 1 = 这一格永远不积雪（水面）
    const isWaterOffPathMap = map?.visualStyle === 'stylized' && stylizedPaletteOf(map).vegetationMode === 'none';
    if (world) {
      const cellW = world.w / res, cellH = world.h / res;
      for (let gy = 0; gy < res; gy++) {
        for (let gx = 0; gx < res; gx++) {
          const wx = (gx + 0.5) * cellW, wy = (gy + 0.5) * cellH;
          const mul = Math.max(floor, 1 + this._snowCellNoise(wx, wy) * amp);
          const idx = gy * res + gx;
          this.snowCellRateMul[idx] = mul;
          if (hasForest) this.snowCellZoneMix[idx] = forestZoneAt(map, wx, wy) === 0 ? 0 : 1;
          if (isWaterOffPathMap && this.mapSystem?.isWalkable && !this.mapSystem.isWalkable(wx, wy)) {
            this.snowCellNoGrow[idx] = 1;
          }
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
    const zoneMix = this.snowCellZoneMix;
    const jungleMaxMul = cfg.jungleMaxDepthMul ?? 1;
    // 全图格子朝全局目标回涨（踩踏留下的小径也在这一步缓慢恢复），但不是同一个
    // 速率——每格乘自己固定的空间噪声倍率，有的格子先到、有的格子晚到，蔓延感
    // 靠这个（见本函数头注 2026-09-20 记录的真根因）。
    // 积雪材质差异化（v55.1）：每格的"追赶目标"不再统一是 snowGlobalTarget，
    // 野区（zoneMix===1）按 jungleMaxDepthMul 再往上提一档（"上限更高"），路面
    // （zoneMix===0，或没有森林分区数据的地图整张恒为0）目标不变，逐位一致。
    const noGrow = this.snowCellNoGrow;
    // ==================== v55.6 尝试修复又撤销：这里的指数逼近是故意的 ====================
    // 一度怀疑这里跟 snowGlobalTarget 一样漏改成线性、是个遗留 bug，改成了线性步进
    // （`grid[i] += step` 而不是 `+=(target-grid[i])*rate`）。跑 tests/sim_groundtrace.mjs
    // 才发现判断错了：改成线性后"雪⑨c-积雪过程中网格里同时存在深浅明显不同的格子"
    // 直接测试失败——推导一下发现，线性限幅（rate-limited slew）追一个匀速上升的
        // target，只要单格速率 > target 上升速率（这里恒成立：最慢的格子 regrowPerSec×
    // rateMul下限 0.05×0.25=0.0125/s，仍快于 target 的 growPerSec=1/120≈0.0083/s），
    // 会【零误差】锁定在 target 上，所有格子几乎同时到达、没有先后之分——这正好
    // 抹掉了 2026-09-20 那次修复特意做出来的"有的格子先到、有的格子晚到"的蔓延感
    // （那次修复的机制原理就是【指数逼近对不同 rateMul 会产生持续的追踪滞后】，
    // 滞后量正比于 target 爬升速率/自身速率——这是蔓延感的来源，不是缺陷）。
    // snowGlobalTarget 那次修复要解决的是"总量曲线形状"（改一次全局变量），跟这里
    // "同一时刻各格子该不该长得不一样多"是两个不同的设计目标，不能用同一个药方。
    // 结论：这里维持指数逼近，不是遗留 bug，撤销这次改动。
    const regrowRate = Math.min(1, (cfg.regrowPerSec ?? 0.05) * dt);
    for (let i = 0; i < grid.length; i++) {
      if (noGrow && noGrow[i]) { grid[i] = 0; continue; } // 水面：永远不积雪，直接钳零
      const localTarget = zoneMix && zoneMix[i]
        ? Math.min(1, this.snowGlobalTarget * jungleMaxMul)
        : this.snowGlobalTarget;
      grid[i] += (localTarget - grid[i]) * regrowRate * (rateMul ? rateMul[i] : 1);
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

      let inPuddle = 0, inPuddleR = 0;
      for (const p of this.puddles) {
        if (p.strength <= 0) continue;
        for (const so of p.subOffsets) {
          const cx = p.x + so.dx, cy = p.y + so.dy;
          if (Math.hypot(m.pos.x - cx, m.pos.y - cy) <= so.r) {
            if (p.strength > inPuddle) { inPuddle = p.strength; inPuddleR = p.r; }
            break;
          }
        }
      }
      if (inPuddle > 0) {
        // v55.7：减速幅度不再只看 strength（成型进度），再叠一层"水洼有多大"
        // 的尺寸系数——见 Config.js groundTrace.puddle.sizeSlowRefRadius 头注。
        const refR = puddleCfg.sizeSlowRefRadius ?? 260;
        const minSizeFactor = puddleCfg.minSizeSlowFactor ?? 0.5;
        const sizeFactor = Math.max(minSizeFactor, Math.min(1, inPuddleR / refR));
        const pct = (puddleCfg.slowPct ?? -25) * inPuddle * sizeFactor;
        this.effects.apply(m.id, {
          // aura:true 时 EffectRegistry 会把 duration 强制设成 Infinity，改用宽限期
          // （auraGrace）自动到期——不用也不该在这里再传 duration，见
          // EffectRegistry.apply 的"光环机制"头注。
          aura: true, auraGrace: 1.0, name: '水洼', icon: '💧', kind: 'stat', statKey: 'moveSpeed',
          // v55.3 修复：这里原来传的字段名是 percent，EffectRegistry._recalcEffectValues
          // 只认 percentValue（见其头注 + flatValue/percentValue 的字段约定）——字段名对
          // 不上，totalPercent 永远按 bp.percentValue（undefined）算成 0，玩法上这个
          // debuff 只有描述文字、从来没有真的生效过。用户报"水洼/积雪只有视觉没有数值"，
          // 根因就是这个拼写不一致的字段名，两处（这里 + 下面积雪）一起改。
          percentValue: pct,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `水洼：移速 ${pct >= 0 ? '+' : ''}${Math.round(pct)}%`,
        }, 'groundtrace_puddle');
      }

      // v54 全新设计：雪盖站里面减速，局部雪深由网格给出（踩出的小径雪深低，
      // 减速幅度自然跟着小——不需要另外维护一份"小径"数据结构）。
      const depth = this._snowDepthAt(m.pos.x, m.pos.y);
      if (depth > 0.02) {
        const pct = (snowCfg.slowPct ?? -22) * depth;
        this.effects.apply(m.id, {
          aura: true, auraGrace: 1.0, name: '积雪', icon: '❄️', kind: 'stat', statKey: 'moveSpeed',
          percentValue: pct, // 见上面水洼那条的 v55.3 修复记录，同一个字段名bug
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `积雪：移速 ${pct >= 0 ? '+' : ''}${Math.round(pct)}%`,
        }, 'groundtrace_snowcover');
      }
    }
  }

  /** 供渲染层读——只读快照。 */
  getPuddles() { return this.puddles; }
  /**
   * 供渲染层读——雪盖网格快照，{resolution, data(Float32Array), worldW, worldH,
   * zoneMix(Float32Array|null)}。zoneMix 是积雪材质差异化（v55.1）新增的"野区
   * 程度"（0=路面/无森林分区数据，1=野区），与 data 同长度、同下标公式，供
   * GroundTraceLayer 铺贴雪盖纹理颜色、VegetationLayer/BoundaryDecorLayer
   * 需要时判断这一点在不在野区。地图没有森林分区数据时恒为 null，渲染层据此
   * 退回原来的单一颜色，画面不变。
   */
  getSnowCover() {
    const world = this.mapSystem?.currentMap?.world;
    if (!this.snowGrid || !world) return null;
    return {
      resolution: this.snowGridRes, data: this.snowGrid, worldW: world.w, worldH: world.h,
      zoneMix: this.snowCellZoneMix || null,
    };
  }

  /**
   * 供【结构类】消费者（目前只有塔）读——不含侵蚀的"目标"雪深快照，见本文件
   * sampleSnowTarget 头注（v55.8 修复）。跟 getSnowCover 分开两个方法而不是加参数：
   * 两者语义不同（一个是实际地面雪深，一个是不受踩踏影响的目标雪深），混在一个
   * 方法里靠参数区分容易被调用方传错。
   */
  getSnowTarget() {
    const world = this.mapSystem?.currentMap?.world;
    if (!this.snowGrid || !world) return null;
    const jungleMaxMul = (CONFIG.groundTrace?.snowCover || {}).jungleMaxDepthMul ?? 1;
    return {
      resolution: this.snowGridRes, worldW: world.w, worldH: world.h,
      globalTarget: this.snowGlobalTarget, zoneMix: this.snowCellZoneMix || null, jungleMaxMul,
    };
  }
}
