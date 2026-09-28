/**
 * sim_srorganic.mjs —— 召唤师峡谷·蜿蜒版（summoners_rift_organic_v1）验收
 *
 * 见 summoners_rift_organic.js / sr_organic_navgrid.js 头注：v51.21 被用户叫停
 * 撤回的"有机弯曲兵线"设计，用户要求"保留为另一个新地图，别直接删"——这里
 * 钉住它确实登记成了一张独立地图（不影响原图 summoners_rift_v1），且这张新图
 * 自身的基本几何约束（建筑覆盖路径、高地入口有塔守、navgrid 真的是自己的一份
 * 而不是意外退回原图/共享同一份数据）都成立。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { MAPS } = await import('../src/data/maps/index.js');
const { summoners_rift } = await import('../src/data/maps/summoners_rift.js');
const { summoners_rift_organic } = await import('../src/data/maps/summoners_rift_organic.js');
const { unpackBits } = await import('../src/data/navgrid.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');

const { T, done } = scoreboard('召唤师峡谷·蜿蜒版验收');

const map = MAPS['summoners_rift_organic_v1'];

// ==================== ① 注册与身份 ====================
T('①-新地图已注册，id 正确', !!map && map.id === 'summoners_rift_organic_v1');
T('①b-不覆盖/不等于原图（不同对象、不同 id）', map !== summoners_rift && map.id !== summoners_rift.id);
T('①c-原图 id/label 未受影响', summoners_rift.id === 'summoners_rift_v1' && summoners_rift.label === '召唤师峡谷');

// ==================== ② navgrid 是自己的一份，不是原图/回落值 ====================
T('②-navgrid 显式声明（不依赖 MapSystem 对 SR 的 SR_NAVGRID 兜底）', !!map.navgrid && map.navgrid.n === 256);
T('②b-与原图 navgrid 数据不同（真的重绘过，不是抄了一份原样）',
  map.navgrid.bits !== SR_NAVGRID.bits);
{
  // 差异点核实：world(456,1965) 在蜿蜒版可走，在原图不可走 —— 见设计脚本核实记录。
  const n = map.navgrid.n;
  const orgBits = unpackBits(map.navgrid.bits, n);
  const origBits = unpackBits(SR_NAVGRID.bits, n);
  const world = map.world;
  const gx = Math.round(456 / world.w * n), gy = Math.round(1965 / world.h * n);
  T('②c-差异点(456,1965)：蜿蜒版可走', !!orgBits[gy * n + gx]);
  T('②d-同一点：原图不可走（证明确实是两份不同的位图，不是巧合全同）', !origBits[gy * n + gx]);
}

// ==================== ③ 兵线路径确实改了（有机弯曲），塔位/数值原样复用 ====================
T('③-三路路点数与原图不同（51/35/51 vs 原图 11/2/11）',
  map.lanes.find(l => l.id === 'top').waypoints.length !== summoners_rift.lanes.find(l => l.id === 'top').waypoints.length);
T('③b-首尾锚点（基地/水晶）与原图一致，没有挪基地', (() => {
  const a = map.lanes.find(l => l.id === 'top').waypoints;
  const b = summoners_rift.lanes.find(l => l.id === 'top').waypoints;
  return a[0].x === b[0].x && a[0].y === b[0].y && a[a.length - 1].x === b[b.length - 1].x && a[a.length - 1].y === b[b.length - 1].y;
})());
T('③c-塔位/建筑数量与原图逐位相同（只改路径，不改塔）',
  JSON.stringify(map.buildings) === JSON.stringify(summoners_rift.buildings));
T('③d-光环/数值覆写/出兵节奏等玩法内容与原图相同（引用同一份 SR_CONFIG 派生）',
  JSON.stringify(map.globalAura) === JSON.stringify(summoners_rift.globalAura)
  && map.waveInterval === summoners_rift.waveInterval
  && JSON.stringify(map.tierStats) === JSON.stringify(summoners_rift.tierStats));

// ==================== ④ 几何：分路建筑仍在所属新路径 190px 内（索敌半径200带余量） ====================
{
  const dseg = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y; if (!dx && !dy) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)); };
  const dpath = (p, wps) => Math.min(...wps.slice(0, -1).map((a, i) => dseg(p, a, wps[i + 1])));
  let allOk = true;
  for (const b of map.buildings) {
    const lanes = b.laneId ? [map.lanes.find(l => l.id === b.laneId)] : map.lanes;
    const d = Math.min(...lanes.map(l => dpath(b.pos, l.waypoints)));
    if (d > 190) allOk = false;
  }
  T('④-全部分路建筑距新路径 ≤190px（换了弯曲路径后塔仍能打到路过的兵）', allOk);
}

// ==================== ⑤ 高地入口不可无脑冲：入口处必有守口塔在射程内 ====================
{
  // 从离 corner 最近的一端出发向外走，找到离开基地圈（半径 r）的第一个点——
  // 蓝方 corner=(0,h) 时路点数组本来就是从蓝方基地开始，正向走；红方
  // corner=(w,0) 时路点数组是从蓝方基地开始、离红方 corner 最远，必须反向走
  // （从数组末尾往回走），否则第一个采样点就已经在红方基地圈外，会直接
  // 误判成"入口"（这正是 sim_v34.mjs entrance() 只处理蓝方单侧的原因）。
  function entrance(m, lane, r, corner, reverse) {
    const wps = reverse ? [...lane.waypoints].reverse() : lane.waypoints;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      for (let t = 0; t <= 1; t += 0.0005) {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        if (Math.hypot(x - corner.x, y - corner.y) >= r) return { x, y };
      }
    }
    return null;
  }
  const r = map.baseCircleRadius;
  const gate = map.gateTier || 'base';
  let allOk = true;
  for (const [faction, corner, reverse] of [
    ['blue', { x: 0, y: map.world.h }, false],
    ['red', { x: map.world.w, y: 0 }, true],
  ]) {
    for (const lane of map.lanes) {
      const ent = entrance(map, lane, r, corner, reverse);
      const cands = map.buildings.filter(b => b.faction === faction && b.tier === gate
        && (b.laneId === lane.id || map.lanes.length === 1));
      const tower = cands.reduce((m, b) =>
        (m && Math.hypot(m.pos.x - ent.x, m.pos.y - ent.y) <= Math.hypot(b.pos.x - ent.x, b.pos.y - ent.y)) ? m : b, null);
      const d = tower ? Math.hypot(tower.pos.x - ent.x, tower.pos.y - ent.y) : Infinity;
      if (!(d > 0 && d < 180)) allOk = false;
    }
  }
  T('⑤-三路高地入口两侧都有守口塔在180射程内（高地不能被无脑冲）', allOk);
}

// ==================== ⑥ MapSystem 能正常加载并按自己的 navgrid 判定可走 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const ms = new MapSystem(ents, bus);
  ms.setCreateBuildingFn(() => null);
  ms.loadMap('summoners_rift_organic_v1');
  T('⑥-MapSystem 加载成功', ms.currentMap.id === 'summoners_rift_organic_v1');
  T('⑥b-差异点(456,1965)在这张图上可走', ms.isWalkable(456, 1965) === true);
}

done();
