// Q3 废墟避障验收：小兵不得穿过塔废墟。
//
// 这条测试的存在意义在于：废墟避障的代码 LaneMovementSystem 里一直都写着，
// 但它走 `findInRadius(..., ['tower'], false)`，而空间网格【只索引活体】——
// 于是那段代码从写下来那天起就是死的，小兵一路穿废墟而过，没有任何测试发现。
// 修法是让网格也索引静态障碍（废墟 / 待重生水晶）。本用例把它钉住：
// 若哪天网格又只索引活体，这里立刻红。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { CONFIG, MINION_SIZES } = await import('../src/data/Config.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
const combat = new CombatSystem(ents, fx, bus, {});
const mapSys = new MapSystem(ents, bus);
const moveSys = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, mapSys);
const collSys = new CollisionSystem(ents, mapSys);
mapSys.setCreateBuildingFn(() => null);
mapSys.loadMap('summoners_rift_v1');

// ---- ① 网格确实索引废墟 ----
const lane = mapSys.getLane('mid'), wps = lane.waypoints;
const u = { x: wps[1].x - wps[0].x, y: wps[1].y - wps[0].y };
const L = Math.hypot(u.x, u.y); u.x /= L; u.y /= L;
const at = (d, off = 0) => ({ x: wps[0].x + u.x * d - u.y * off, y: wps[0].y + u.y * d + u.x * off });
const along = (p) => (p.x - wps[0].x) * u.x + (p.y - wps[0].y) * u.y;

const RUIN_D = 700;
const rp = at(RUIN_D, 0);
const ruin = {
  id: ++window._uid, type: 'tower', alive: false, pos: { x: rp.x, y: rp.y },
  baseStats: { ...CONFIG.templates.tower }, currentHP: 0,
  _skillInstances: [], _mapFaction: 'red', _mapTier: 'outer', _ruin: true, faction: 'red',
};
ents.add(ruin);
AttributeCalculator.tick(); ents.rebuildGridIfNeeded(AttributeCalculator._frame);
T('废墟在空间网格中（aliveOnly=false 取得到）',
  ents.findInRadius(rp.x, rp.y, 40, ['tower'], false).some(e => e.id === ruin.id));

// ---- ② 小兵正面撞上去，必须绕开而不是穿过 ----
// 正对废墟中心投放一列近战，跑够时间；全程记录每个兵到废墟中心的最小距离。
const born = [];
for (let i = 0; i < 5; i++) {
  const p = at(RUIN_D - 260 - i * 24, (i - 2) * 6);   // 几乎正对，只留极小横向偏移
  const tpl = CONFIG.templates.melee;
  const e = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: p.x, y: p.y },
    baseStats: { ...tpl }, currentHP: tpl.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', _laneId: 'mid', _laneDirection: 'forward', faction: 'blue',
  };
  ents.add(e); born.push(e);
}
const startArc = born.map(m => along(m.pos));

// 废墟的"实体半径"：与 LaneMovementSystem 同口径（建筑尺寸 × 视觉放大系数）
const vz = CONFIG.towerVizScale || {};
const ruinR = (CONFIG.buildingSizes?.outer ?? 28) * (vz.outer ?? vz.default ?? 1.25);
const minR = new Map(born.map(m => [m.id, Infinity]));

const DT = 1 / 30;
for (let t = 0; t < 40; t += DT) {
  window.gameTime = t;
  AttributeCalculator.tick(); ents.rebuildGridIfNeeded(AttributeCalculator._frame);
  moveSys.update(DT); collSys.update(DT);
  for (const m of born) {
    if (!m.alive) continue;
    const d = Math.hypot(m.pos.x - rp.x, m.pos.y - rp.y);
    if (d < minR.get(m.id)) minR.set(m.id, d);
  }
}

const rSelf = MINION_SIZES.melee || 10;
const need = ruinR + rSelf;
const worst = Math.min(...minR.values());
const endArc = born.map(m => along(m.pos));
const advanced = endArc.filter((a, i) => a - startArc[i] > 300).length;

console.log(`  废墟半径 ${ruinR.toFixed(1)} + 兵半径 ${rSelf} = 应保持 ${need.toFixed(1)}；` +
            `实测全程最小间距 ${worst.toFixed(1)}`);
console.log(`  越过废墟继续推进的小兵：${advanced}/${born.length}`);

// 允许 2px 的数值容差（硬圆投影每帧钳一次，可能有极小穿透后被推回）
T(`小兵未穿进废墟模型（最小间距 ${worst.toFixed(1)} ≥ ${(need - 2).toFixed(1)}）`, worst >= need - 2);
T(`小兵仍能绕过废墟继续推进（${advanced}/${born.length}）`, advanced === born.length);

console.log(`废墟避障验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
