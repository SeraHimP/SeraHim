// Q1 地形避障验收（确定性、无浏览器）。
//
// 场景 = 【地形口袋逃脱】。先在浏览器里量清楚真实卡死到底由什么造成：
// 排除掉"交战站定"的锚定单位后，一局 5 分钟只剩 3 次滞留，其中 1 次是朝目标方向
// ±60° 内被地形全堵（真·地形卡死），其余都有攻击目标。所以卡死虽然存在但很稀疏，
// 靠"跑一局数卡住几个"根本量不准（同一份代码三局 11/29/49，噪声压过信号）。
//
// 改为直接构造那个真实失败模式：navgrid 上朝红方基地方向 ±60° 全堵的"口袋"格点
// 共 577 个，最近的离兵线只有 73px —— 小兵被分离力挤进去就会顶着凹壁磨。
// 本测试把小兵放进离兵线最近的若干口袋，看它能不能自己走回兵线。
// 同一份代码用 window.__laneFlow 开/关各跑一遍，避免"改完自说自话变好了"。
// 另一半改动（触须式预判避障 __terrainAvoid）的证据在 sim_wall.mjs：
// 关掉它那里的"越墙"从 6/6 退回 5/6，两部分各自都是有效负载。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// 每次重建世界，保证两轮起点完全一致
function build() {
  window.gameTime = 0; window._uid = 0;
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, {});
  const mapSys = new MapSystem(ents, bus);
  const moveSys = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, mapSys);
  const collSys = new CollisionSystem(ents, mapSys);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  return { ents, mapSys, moveSys, collSys, attr: AttributeCalculator };
}

// 沿某条路的折线弧长定位：返回距起点 arc 处的坐标 + 该处切向
function onLane(lane, arc) {
  const wps = lane.waypoints;
  let acc = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const dx = wps[i + 1].x - wps[i].x, dy = wps[i + 1].y - wps[i].y;
    const seg = Math.hypot(dx, dy);
    if (acc + seg >= arc) {
      const t = (arc - acc) / seg;
      return { x: wps[i].x + dx * t, y: wps[i].y + dy * t, ux: dx / seg, uy: dy / seg };
    }
    acc += seg;
  }
  const n = wps.length - 1;
  const dx = wps[n].x - wps[n - 1].x, dy = wps[n].y - wps[n - 1].y, s = Math.hypot(dx, dy);
  return { x: wps[n].x, y: wps[n].y, ux: dx / s, uy: dy / s };
}
function arcOf(lane, p) {
  const wps = lane.waypoints;
  let acc = 0, best = { d: Infinity, arc: 0 };
  for (let i = 0; i < wps.length - 1; i++) {
    const ax = wps[i].x, ay = wps[i].y;
    const vx = wps[i + 1].x - ax, vy = wps[i + 1].y - ay;
    const L2 = vx * vx + vy * vy || 1, seg = Math.sqrt(L2);
    const t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / L2));
    const d = Math.hypot(p.x - (ax + t * vx), p.y - (ay + t * vy));
    if (d < best.d) best = { d, arc: acc + t * seg };
    acc += seg;
  }
  return best.arc;
}


// 找出"口袋"：可走、但朝本路推进方向 ±60° 内没有一条 120px 的通路。
// 用 navgrid 现算而不是写死坐标——地形重描后测试自动跟着走，不会变成过期常量。
function findPockets(mapSys, laneId, limit, band) {
  const lane = mapSys.getLane(laneId);
  const goal = lane.waypoints[lane.waypoints.length - 1];
  const W = mapSys.currentMap.world.w, H = mapSys.currentMap.world.h;
  const out = [];
  for (let y = 100; y < H - 100; y += 24) {
    for (let x = 100; x < W - 100; x += 24) {
      if (!mapSys.isWalkable(x, y)) continue;
      const d = mapSys._nearestOnLane(lane, x, y).dist;
      if (d < band[0] || d > band[1]) continue;
      let ux = goal.x - x, uy = goal.y - y;
      const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
      let clear = false;
      for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
        const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const vx = ux * c - uy * s, vy = ux * s + uy * c;
        let ok = true;
        for (let k = 1; k <= 6; k++) if (!mapSys.isWalkable(x + vx * 120 * k / 6, y + vy * 120 * k / 6)) { ok = false; break; }
        if (ok) { clear = true; break; }
      }
      if (!clear) out.push({ x, y, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  // 去重：同一个口袋里的相邻格点只取一个，保证样本落在不同口袋
  const picked = [];
  for (const p of out) {
    if (picked.every(q => Math.hypot(q.x - p.x, q.y - p.y) > 260)) picked.push(p);
    if (picked.length >= limit) break;
  }
  return picked;
}

// 一轮：把小兵单独放进各个口袋，跑 SECONDS 秒，看它能否走回兵线（离中线 < 60px）。
// 单独放 = 排除拥挤干扰，测的就是纯地形脱困能力。
function trial(laneId, spots, flowOn, SECONDS = 30) {
  window.__laneFlow = flowOn;
  const { ents, mapSys, moveSys, collSys, attr } = build();
  const lane = mapSys.getLane(laneId);
  const born = spots.map((sp, i) => {
    const type = i % 2 ? 'ranged' : 'melee';
    const tpl = CONFIG.templates[type];
    const e = {
      id: ++window._uid, type, alive: true, pos: { x: sp.x, y: sp.y },
      baseStats: { ...tpl }, currentHP: tpl.maxHP,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: 'blue', _laneId: laneId, _laneDirection: 'forward', faction: 'blue',
    };
    ents.add(e); return e;
  });
  const startArcs = born.map(m => arcOf(lane, m.pos));
  const DT = 1 / 30;
  for (let t = 0; t < SECONDS; t += DT) {
    window.gameTime = t;
    attr.tick(); ents.rebuildGridIfNeeded(attr._frame);
    moveSys.update(DT); collSys.update(DT);
  }
  // 验收口径 = 【沿本路真的推进了】。不用"回到中线 60px 内"：走廊半宽 130，
  // 贴边的兵本来就算在路上，问题从来不是横向偏移而是"卡在原地不前进"。
  let advanced = 0, sumAdv = 0;
  born.forEach((m, i) => {
    const adv = arcOf(lane, m.pos) - startArcs[i];
    sumAdv += adv;
    if (adv > 200) advanced++;
  });
  window.__laneFlow = undefined;
  return { advanced, avgAdv: sumAdv / born.length, n: born.length };
}

console.log('地形口袋脱困 A/B（同一份代码，__laneFlow 兵线回流场 开/关）');
const probe = build();
// 两个带：贴着兵线的野区凹角（走廊内，问题是"前进不了"）、以及深野区口袋（问题是"出不来"）
const BANDS = [[40, 220, '近兵线凹角'], [250, 700, '深野区口袋']];
let offTotal = 0, onTotal = 0, total = 0;
for (const band of BANDS) {
  for (const laneId of ['top', 'mid', 'bot']) {
    const spots = findPockets(probe.mapSys, laneId, 5, band);
    if (!spots.length) { console.log(`  ${band[2]}·${laneId}：无样本`); continue; }
    const off = trial(laneId, spots, false);
    const on = trial(laneId, spots, true);
    offTotal += off.advanced; onTotal += on.advanced; total += spots.length;
    console.log(`  ${band[2]}·${laneId}（${spots.length} 个）：关=${off.advanced}/${off.n} 推进` +
                `(均${off.avgAdv.toFixed(0)}px)　开=${on.advanced}/${on.n} 推进(均${on.avgAdv.toFixed(0)}px)`);
  }
}
console.log(`  合计：关=${offTotal}/${total}　开=${onTotal}/${total}`);
T(`兵线回流场提升脱困推进（${offTotal}/${total} → ${onTotal}/${total}）`, onTotal > offTotal);
T(`开启后脱困推进率不低于 90%（${onTotal}/${total}）`, onTotal >= Math.ceil(total * 0.9));

// ---- 回流场会不会把队形压成一条线？（确定性测量，不看浏览器快照——那个噪声太大）----
// 放一波正常小兵沿本路行军，全程记录横向铺开度，flow 开/关各跑一遍。
function spreadTrial(laneId, flowOn, N = 12, SECONDS = 40) {
  window.__laneFlow = flowOn;
  const { ents, mapSys, moveSys, collSys, attr } = build();
  const lane = mapSys.getLane(laneId);
  const born = [];
  for (let i = 0; i < N; i++) {
    const a = onLane(lane, 300 + Math.floor(i / 3) * 26);
    const off = ((i % 3) - 1) * 30;
    const type = i % 2 ? 'ranged' : 'melee';
    const tpl = CONFIG.templates[type];
    const e = { id: ++window._uid, type, alive: true,
      pos: { x: a.x - a.uy * off, y: a.y + a.ux * off },
      baseStats: { ...tpl }, currentHP: tpl.maxHP,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: 'blue', _laneId: laneId, _laneDirection: 'forward', faction: 'blue' };
    mapSys.constrainToWalkable?.(e.pos); ents.add(e); born.push(e);
  }
  const DT = 1 / 30; const samples = [];
  for (let t = 0; t < SECONDS; t += DT) {
    window.gameTime = t;
    attr.tick(); ents.rebuildGridIfNeeded(attr._frame);
    moveSys.update(DT); collSys.update(DT);
    if (Math.abs(t % 1) < DT) {
      for (const m of born) samples.push(mapSys._nearestOnLane(lane, m.pos.x, m.pos.y).dist);
    }
  }
  samples.sort((a, b) => a - b);
  window.__laneFlow = undefined;
  return { p50: samples[(samples.length * 0.5) | 0], p90: samples[(samples.length * 0.9) | 0],
           max: samples[samples.length - 1] };
}
console.log('行军队形铺开度（横向离中线距离，全程采样）');
let spreadOk = true;
for (const laneId of ['top', 'mid', 'bot']) {
  const off = spreadTrial(laneId, false), on = spreadTrial(laneId, true);
  console.log(`  ${laneId}：关 p50=${off.p50.toFixed(0)} p90=${off.p90.toFixed(0)} max=${off.max.toFixed(0)}` +
              `　开 p50=${on.p50.toFixed(0)} p90=${on.p90.toFixed(0)} max=${on.max.toFixed(0)}`);
  if (on.p90 < off.p90 * 0.6) spreadOk = false;   // 允许收紧，但不许压成一条线
}
T('回流场未把行军队形压扁（p90 铺开度 ≥ 关闭态的 60%）', spreadOk);

// ==================== v51.32：地图编辑器前置重构——navgrid 缓存失效 ====================
// 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §2 原则 6："改地形要通知失效"。
// 排查发现 _nav（解码后的可行走位图）与 _fields（各路回流场）此前只在【切图】时
// 自然失效（靠 map.id 变化触发），同一张图运行时改 navgrid 数据没有任何清缓存的入口——
// 地图编辑器的地形笔刷画一笔就需要让寻路立刻看见新数据，这里补上 invalidateNav()。
{
  const { mapSys } = build();
  const navBefore = mapSys._navgrid();
  T('失效①-navgrid 解码后被缓存（同一次调用拿到同一个对象）', mapSys._navgrid() === navBefore);
  mapSys._laneField('top'); // 触发回流场缓存
  T('失效②-回流场确实缓存了（_fields.top 不是 undefined）', mapSys._fields?.top !== undefined);

  mapSys.invalidateNav();
  T('失效③-invalidateNav() 之后 _nav 变回 undefined（下次访问会重新解码）', mapSys._nav === undefined);
  T('失效④-invalidateNav() 之后 _fields 被清空', Object.keys(mapSys._fields || {}).length === 0);

  const navAfter = mapSys._navgrid();
  T('失效⑤-重新解码出一份新对象（不是复用失效前那份引用，证明真的重算了）', navAfter !== navBefore);
  T('失效⑥-但内容等价（同一张地图，重新解码结果应该一致，证明"重算"没有意外改变数据）',
    navAfter.n === navBefore.n && navAfter.bits.length === navBefore.bits.length
    && navAfter.bits.every((v, i) => v === navBefore.bits[i]));

  const { srcOf } = await import('./_harness.mjs');
  T('失效⑦-loadMap 内部也走 invalidateNav（不是两处各写一份重置逻辑）',
    /this\.invalidateNav\(\);/.test(srcOf('src/systems/MapSystem.js')));
}

// ==================== v51.32：地图编辑器 §3.5——自制地图接入地图注册表 ====================
// 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §1.6/§3.5，呼应 docs/DEVELOPMENT.md §5
// "已知的坑"点名过的"列表不要写死"：getAvailableMaps/getMapById/loadMap 三处
// 必须都认 CONFIG.customMaps，只改一处会变成"能选到但加载空白"或"能加载但选不到"。
{
  const { CONFIG } = await import('../src/data/Config.js');
  const savedCustom = CONFIG.customMaps;
  CONFIG.customMaps = {
    my_custom_v1: { id: 'my_custom_v1', label: '我的自制地图', world: { w: 1000, h: 1000 },
      lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }] }], buildings: [] },
  };

  const { mapSys } = build(); // build() 会 loadMap('summoners_rift_v1')，不受 customMaps 影响

  T('自制地图①-getAvailableMaps 里能看到自制地图（不是只读内置 MAPS）',
    mapSys.getAvailableMaps().some(m => m.id === 'my_custom_v1'));
  T('自制地图②-getMapById 能按 id 取到自制地图数据',
    mapSys.getMapById('my_custom_v1')?.label === '我的自制地图');

  mapSys.loadMap('my_custom_v1');
  T('自制地图③-loadMap 能真的加载自制地图（不是只能选中选不动）',
    mapSys.currentMap?.id === 'my_custom_v1' && mapSys.currentMap?.world.w === 1000);

  // id 撞车：自制地图不该有能力顶掉内置官方图（见 _mapRegistry 头注的取舍记录）
  CONFIG.customMaps.summoners_rift_v1 = { id: 'summoners_rift_v1', label: '假冒的峡谷', world: { w: 1, h: 1 } };
  T('自制地图④-id 与内置地图撞车时，内置地图优先（不会被自制数据静默顶替）',
    mapSys.getMapById('summoners_rift_v1')?.label !== '假冒的峡谷');

  CONFIG.customMaps = savedCustom; // 不污染后面的测试
}

// ==================== v51.32：自制地图能存档往返（用户的地图作品不能丢） ====================
{
  const { CONFIG } = await import('../src/data/Config.js');
  const { exportTemplates, importTemplates, IO_GROUPS } = await import('../src/data/templateIO.js');
  T('存档①-customMaps 在 IO_GROUPS 白名单里（否则导出的存档里悄悄漏掉这一组）',
    IO_GROUPS.includes('customMaps'));

  const savedCustom = CONFIG.customMaps;
  CONFIG.customMaps = { archived_map_v1: { id: 'archived_map_v1', label: '存档测试地图', world: { w: 500, h: 500 } } };
  const snap = exportTemplates(CONFIG);
  T('存档②-自制地图确实进了导出结果', snap.customMaps?.archived_map_v1?.label === '存档测试地图');

  CONFIG.customMaps = {}; // 模拟"新开一局，自制地图暂时没导入"
  importTemplates(CONFIG, JSON.parse(JSON.stringify(snap)));
  T('存档③-导入存档后自制地图复活，且内容逐位一致',
    JSON.stringify(CONFIG.customMaps.archived_map_v1) === JSON.stringify(snap.customMaps.archived_map_v1));

  CONFIG.customMaps = savedCustom;
}

console.log(`地形避障验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
