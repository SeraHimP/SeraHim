/**
 * drift_probe.mjs —— 找"原地漂移 / 绕圈"的小兵
 *
 * 用户："兵现在会出现原地漂移/转圈的问题。"
 *
 * 判据（与 MapSystem._computeWaypointBlock 头注里那次的量法一致）：
 * 在一个时间窗内，某个兵**走了很长的路程**却**几乎没有净位移** —— 那就是在原地打转。
 * 只看"位移小"会把正常站桩输出的兵也算进来，所以两个条件必须同时成立。
 *
 *   node tools/drift_probe.mjs [分钟] [地图id]
 */
import { EventBus } from '../src/utils/EventBus.js';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
window.__towerRules = { invincible: { blue: false, red: false },
                        attackOff: { blue: false, red: false },
                        waveOn: { blue: true, red: true } };
window.__towerRuleFor = (kind, fac) => {
  const r = window.__towerRules[kind];
  return fac ? !!r[fac] : (r.blue || r.red);
};

const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { FacingSystem } = await import('../src/systems/FacingSystem.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { CONFIG } = await import('../src/data/Config.js');

const MIN = Number(process.argv[2] || 6);
const MAP_ID = process.argv[3] || 'summoners_rift_v1';
const SIM_DT = 1 / 30;
const WIN = 6;              // 观察窗（秒）
const PATH_MIN = 120;       // 窗内路程超过这么多 px 才算"在动"
const NET_MAX = 40;         // 而净位移小于这么多 px 就算"没走出去"
const SPIN_MIN = 720;       // 窗内累计转角超过这么多度（= 两整圈）才算"在原地打转"

const bus = new EventBus();
const ents = new EntityContainer(bus);
const fx = new EffectRegistry(bus);
const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
const proj = new ProjectileSystem(ents, bus, combat);
combat.setProjectileSystem(proj);
const buffs = new BuffSystem(fx, ents, bus, combat);
const mapSys = new MapSystem(ents, bus);
mapSys.setEffectRegistry(fx);
const move = new LaneMovementSystem(ents, fx, AttributeCalculator, combat, mapSys);
const coll = new CollisionSystem(ents, mapSys);
const waves = new LaneWaveSystem(ents, bus, mapSys);
const facing = new FacingSystem(ents);
const world = new WorldState({ entities: ents, bus });
AttributeCalculator.setWorldState(world);

mapSys.setCreateBuildingFn(({ faction, tier, laneId, pos, weapon, stats }) => {
  const tpl = CONFIG.templates.tower;
  const s = { ...(stats || {}) };
  const e = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
    baseStats: { ...tpl, ...s },
    currentHP: s.maxHP ?? tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _inCombat: false, _attackerCount: 0,
    _mapFaction: faction, faction, _mapTier: tier, _laneId: laneId,
  };
  if (weapon) e._skillInstances.push({ id: ++window._uid, skillId: 'weapon_' + weapon, state: {} });
  ents.add(e);
  return e;
});
waves.setCreateMinion((type, x, y, faction, laneId, direction) => {
  const tpl = CONFIG.templates[type] || CONFIG.templates.melee;
  const e = {
    id: ++window._uid, type, alive: true, pos: { x, y },
    baseStats: { ...tpl },
    currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _inCombat: false, _attackerCount: 0,
    _mapFaction: faction, faction,
    _laneId: laneId, _laneDirection: direction,
  };
  ents.add(e);
  return e;
});
mapSys.loadMap(MAP_ID);

// 每个兵一条环形轨迹记录
const track = new Map();   // id -> { pts:[{t,x,y}], path:0 }
const hits = new Map();    // id -> { type, lane, fac, worst:{path,net,cx,cy,r} }

const maxT = MIN * 60;
for (let t = 0; t < maxT; t += SIM_DT) {
  window.gameTime = t;
  AttributeCalculator.tick();
  ents.rebuildGridIfNeeded(AttributeCalculator._frame);
  world.update(SIM_DT, t);
  waves.update(SIM_DT);
  move.update(SIM_DT);
  coll.update(SIM_DT);
  facing.update(SIM_DT);
  combat.update(SIM_DT);
  proj.update(SIM_DT);
  buffs.update(SIM_DT);
  fx.update(SIM_DT);
  mapSys.update(SIM_DT);
  ents.purgeDead();

  for (const m of ents.getAllMinions(true)) {
    if (!m._laneId || !m.pos) continue;
    let r = track.get(m.id);
    if (!r) { r = { pts: [], path: 0, spin: 0, lastX: m.pos.x, lastY: m.pos.y, lastF: m._facing }; track.set(m.id, r); }
    r.path += Math.hypot(m.pos.x - r.lastX, m.pos.y - r.lastY);
    r.lastX = m.pos.x; r.lastY = m.pos.y;
    // 累计**转过的角度绝对值**（不是净转角）——原地来回甩也会把它累起来
    if (m._facing !== undefined && r.lastF !== undefined) {
      let d = m._facing - r.lastF;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d <= -Math.PI) d += Math.PI * 2;
      r.spin += Math.abs(d);
    }
    r.lastF = m._facing;
    r.pts.push({ t, x: m.pos.x, y: m.pos.y, p: r.path, s: r.spin });
    while (r.pts.length && t - r.pts[0].t > WIN) r.pts.shift();
    if (r.pts.length < 2) continue;
    const a = r.pts[0], b = r.pts[r.pts.length - 1];
    const path = b.p - a.p;
    const net = Math.hypot(b.x - a.x, b.y - a.y);
    const spinDeg = (b.s - a.s) * 180 / Math.PI;
    // 判据②（真正的"漂移"）：面朝方向与实际移动方向**持续**对不上。
    //
    // ⚠️ 不能用瞬时夹角判 —— 任何一次合法的转身都会瞬间产生大夹角
    //（掉头 180° 在 220°/秒下本来就要 0.82 秒），量瞬时值会把"正在转身"全算成漂移，
    //  实测那样 318 个兵里 300 个中招，噪声淹没信号。
    // 所以量**连续超标的时长**：转身撑不过一个掉头时间（0.9s 足够涵盖），
    // 而"一边朝目标一边往别处走"会一直持续下去。
    if (m._facing !== undefined && r.pts.length >= 3) {
      const q = r.pts[r.pts.length - 3];
      const mvx = b.x - q.x, mvy = b.y - q.y;
      const mv = Math.hypot(mvx, mvy);
      let bad = false;
      if (mv > 1.5) {
        let d = Math.atan2(mvx, mvy) - m._facing;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d <= -Math.PI) d += Math.PI * 2;
        bad = Math.abs(d) * 180 / Math.PI > 60;
      }
      if (bad) {
        r.badSince = r.badSince ?? t;
        const dur = t - r.badSince;
        const prev = hits.get(m.id);
        if (dur > 0.9 && (!prev || dur > prev.worst.spin)) {
          hits.set(m.id, { type: m.type, lane: m._laneId, fac: m._mapFaction,
                           worst: { path: Math.round(path), net: Math.round(net),
                                    spin: dur, t: Math.round(t),
                                    cx: Math.round(m.pos.x), cy: Math.round(m.pos.y), r: 0 } });
        }
      } else r.badSince = null;
    }
  }
}

const list = [...hits.values()].sort((a, b) => b.worst.spin - a.worst.spin);
console.log(`地图 ${MAP_ID}，跑了 ${MIN} 分钟，共观察 ${track.size} 个兵`);
console.log('漂移判据：面朝方向与移动方向夹角 > 60° 且**持续 > 0.9 秒**（掉头只需 0.82s）');
console.log(`命中 ${list.length} 个：`);
for (const h of list.slice(0, 15)) {
  const w = h.worst;
  console.log(`  ${h.fac}/${h.lane}/${h.type}  t=${w.t}s  持续错向 ${w.spin.toFixed(1)}s  @(${w.cx},${w.cy})`);
}
// 圆心聚类：打转的地方是不是都挨着某座塔
if (list.length) {
  const map = mapSys.currentMap;
  const near = new Map();
  for (const h of list) {
    let best = null, bd = Infinity;
    for (const b of (map.buildings || [])) {
      const d = Math.hypot(b.pos.x - h.worst.cx, b.pos.y - h.worst.cy);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && bd < 120) {
      const k = `${best.faction}/${best.tier}/${best.laneId}@(${best.pos.x},${best.pos.y})`;
      near.set(k, (near.get(k) || 0) + 1);
    }
  }
  console.log('\n打转位置离哪座建筑最近（<120px）：');
  for (const [k, n] of [...near.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} 次  ${k}`);
}
