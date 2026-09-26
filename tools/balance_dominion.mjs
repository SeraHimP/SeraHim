#!/usr/bin/env node
/**
 * balance_dominion.mjs —— 统治战场·水晶之痕专用批量对局模拟
 *
 * ============ 为什么单独写一份，不用 balance_matrix.mjs ============
 * balance_matrix.mjs 是给"两个基地互推一条/三条线"的经典模式量的——它的胜负判定
 * （水晶枢纽 alive）、出兵驱动（LaneWaveSystem）在 Dominion 地图上部分对不上：
 * Dominion 不用 LaneWaveSystem 出兵（DominionSystem._tickWaves 自己按
 * waveInterval/pointWaveEvery 驱动），而且真正决定胜负节奏的除了推塔，还多了一条
 * 全新的资源线——据点占领数差 → nexus_main 持续掉血（DominionSystem._tickNexusDrain）。
 * 这条线不需要任何一次真实攻击命中就能独立杀死水晶枢纽，balance_matrix 那套
 * "只看塔血/击杀"的记录口径完全看不见它，必须单独造一把尺子。
 *
 * ============ 用法 ============
 *   node tools/balance_dominion.mjs                        # 默认 10 局，不限时长
 *   node tools/balance_dominion.mjs --runs 30               # 加大样本量
 *   node tools/balance_dominion.mjs --minutes 30            # 给个安全上限（正常应该远早于这个结束）
 *   node tools/balance_dominion.mjs --drain-mult 20         # 仅本工具内加速水晶掉血，加快测试
 *   node tools/balance_dominion.mjs --json out.json         # 结果落盘
 *
 * ⚠️ --drain-mult 只在这个独立进程里临时改 CONFIG.dominion.nexusDrainPerPointPerSec，
 * 跑完立刻还原，且这个改动从不落进任何提交——它是"让我这次测试跑快一点"的工具开关，
 * 不是"游戏里水晶应该掉血更快"的产品结论（那条结论只能来自用户明确定稿）。
 * 不传就是 1（等于线上真实速率），默认值本身就证明这一点。
 */
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const RUNS = parseInt(arg('runs', '10'), 10);
const minutesArg = arg('minutes', null);
const DRAIN_MULT = parseFloat(arg('drain-mult', '1'));
const JSON_OUT = arg('json', '');
const MAP_ID = 'dominion_crystal_scar_v1';

const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { FacingSystem } = await import('../src/systems/FacingSystem.js');
const { DominionSystem } = await import('../src/systems/DominionSystem.js');
const { DragonSystem } = await import('../src/systems/DragonSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { createFactories, effectiveMaxHP } = await import('../src/core/factories.js');
const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');

const MAX_MIN = minutesArg != null ? parseFloat(minutesArg) : Infinity;
const SIM_DT = 1 / 30;

// 可复现的随机：整局把 Math.random 换成种子发生器，跑完还原（与 balance_matrix.mjs 同一套做法）。
const _realRandom = Math.random;
function _seedRandom(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  Math.random = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 跑一局，返回详细结局 + 一条按时间采样的"据点数差/水晶血量"轨迹，用于诊断滚雪球速度。 */
function runOne(seed) {
  _seedRandom(seed + 1);
  window.gameTime = 0; window.waveNumber = 0; window._uid = 0;
  window.__towerRules = {
    invincible: { blue: false, red: false },
    attackOff: { blue: false, red: false },
    waveOn: { blue: true, red: true },
  };
  window.__towerRuleFor = (kind, fac) => {
    const r = window.__towerRules[kind];
    return fac ? !!r[fac] : (r.blue || r.red);
  };

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
  const facing = new FacingSystem(ents);
  const world = new WorldState({ entities: ents, bus });
  AttributeCalculator.setWorldState(world);

  const dominion = new DominionSystem(ents, bus);
  dominion.setEffectRegistry(fx);

  // Dominion 地图没有龙坑（map.dragon 未声明），DragonSystem 不进主循环
  // （下面没有 dragons.update）——只是 createFactories() 的必填依赖，跟
  // balance_matrix.mjs 造它的理由一样：工具与 main.js 用同一批工厂函数，
  // 不能因为这张图用不上龙就单独搞一套"更简化"的实体构造。
  const dragons = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  dragons.setMapLookup((id) => mapSys.getMapById?.(id) || null);
  dragons.setCombatSystem(combat);
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem: mapSys, dragonSystem: dragons,
    uiManager: { log() {} },
  });
  dragons.setCreateEntity(F.createDragon);

  mapSys.setCreateBuildingFn((opt) => F.createBuilding(opt));
  dominion.setCreateMinion((type, x, y, faction, laneId, direction) =>
    F.createMinion(type, x, y, 1, 1, { faction, laneId, direction }));

  const score = { blue: { kills: 0 }, red: { kills: 0 } };
  let firstCaptureAt = null;
  let firstMajorityAt = null; // 某一方先占到 3/5（多数）据点的时刻
  let firstDrainStartAt = null; // 据点数差第一次非零（水晶开始掉血）的时刻
  const track = []; // 按 10s 采样：{t, blueCount, redCount, blueNexusHp, redNexusHp}

  bus.on('entity:death', ({ entityId }) => {
    const e = ents.get(entityId);
    if (!e) return;
    const scorer = (e._mapFaction || e.faction) === 'blue' ? 'red' : 'blue';
    if (e.type !== 'tower') score[scorer].kills++;
  });

  mapSys.loadMap(MAP_ID);
  dominion.initMap(mapSys.currentMap);

  const maxT = MAX_MIN * 60;
  let winner = null;
  let frame = 0;
  for (let t = 0; t < maxT; t += SIM_DT) {
    frame++;
    window.gameTime = t;
    AttributeCalculator.tick();
    ents.rebuildGridIfNeeded(AttributeCalculator._frame);
    world.update(SIM_DT, t);
    move.update(SIM_DT);
    coll.update(SIM_DT);
    facing.update(SIM_DT);
    combat.update(SIM_DT);
    proj.update(SIM_DT);
    buffs.update(SIM_DT);
    fx.update(SIM_DT);
    dominion.update(SIM_DT);
    mapSys.update(SIM_DT);
    ents.purgeDead();

    if (frame % 30 === 0) {
      const st = dominion.getStatus();
      const majority = Math.floor(st.total / 2) + 1; // 第五轮：据点总数从 5 变成 7，"多数"跟着算，不再硬编码 3
      if (firstCaptureAt == null && (st.blue > 0 || st.red > 0)) firstCaptureAt = t;
      if (firstMajorityAt == null && (st.blue >= majority || st.red >= majority)) firstMajorityAt = t;
      if (firstDrainStartAt == null && st.blue !== st.red) firstDrainStartAt = t;
      if (frame % 300 === 0) { // 每 10s 采样一次轨迹
        const blueNexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === 'blue');
        const redNexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === 'red');
        track.push({
          t: +t.toFixed(0), blueCount: st.blue, redCount: st.red,
          blueNexusHp: blueNexus ? Math.max(0, blueNexus.currentHP) : 0,
          redNexusHp: redNexus ? Math.max(0, redNexus.currentHP) : 0,
        });
      }
      for (const fac of ['blue', 'red']) {
        const nexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === fac);
        if (nexus && !nexus.alive) { winner = fac === 'blue' ? 'red' : 'blue'; break; }
      }
      if (winner) { window.gameTime = t; break; }
    }
  }

  const finalStatus = dominion.getStatus();
  const out = {
    winner: winner || 'draw',
    minutes: +(window.gameTime / 60).toFixed(2),
    kills: { blue: score.blue.kills, red: score.red.kills },
    finalPoints: { blue: finalStatus.blue, red: finalStatus.red },
    firstCaptureAt: firstCaptureAt != null ? +firstCaptureAt.toFixed(0) : null,
    firstMajorityAt: firstMajorityAt != null ? +firstMajorityAt.toFixed(0) : null,
    firstDrainStartAt: firstDrainStartAt != null ? +firstDrainStartAt.toFixed(0) : null,
    track,
  };
  AttributeCalculator.setWorldState(null);
  Math.random = _realRandom;
  return out;
}

// ==================== --drain-mult：仅本进程内临时改配置，跑完还原 ====================
const _drainBefore = CONFIG.dominion.nexusDrainPerPointPerSec;
if (DRAIN_MULT !== 1) CONFIG.dominion.nexusDrainPerPointPerSec = _drainBefore * DRAIN_MULT;

const minLabel = Number.isFinite(MAX_MIN) ? `单局上限 ${MAX_MIN} 分钟` : '单局不设时长上限';
console.log(`统治战场·水晶之痕 批量对局模拟：${RUNS} 局，${minLabel}` +
  (DRAIN_MULT !== 1 ? `，水晶掉血速率×${DRAIN_MULT}（仅本次测试加速，不改真实配置）` : ''));
console.log('（纯 headless，使用真实的 MapSystem/DominionSystem/CombatSystem，非简化模型）\n');

const t0 = Date.now();
const rows = [];
for (let i = 0; i < RUNS; i++) {
  process.stderr.write(`\r  跑局 … ${i + 1}/${RUNS}`);
  rows.push(runOne(i));
}
process.stderr.write('\r' + ' '.repeat(30) + '\r');
CONFIG.dominion.nexusDrainPerPointPerSec = _drainBefore;

const avg = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
const blue = rows.filter(r => r.winner === 'blue').length;
const red = rows.filter(r => r.winner === 'red').length;
const draw = rows.filter(r => r.winner === 'draw').length;
const withCapture = rows.filter(r => r.firstCaptureAt != null);
const withMajority = rows.filter(r => r.firstMajorityAt != null);
const withDrain = rows.filter(r => r.firstDrainStartAt != null);

console.log(`结果：蓝胜 ${blue}/${RUNS}（${(blue / RUNS * 100).toFixed(0)}%）  红胜 ${red}  平 ${draw}`);
console.log(`均时长 ${avg(r => r.minutes)} 分钟（min ${Math.min(...rows.map(r => r.minutes))} / max ${Math.max(...rows.map(r => r.minutes))}）`);
console.log(`首次出现据点归属 平均 ${withCapture.length ? avg.call(null, r => r.firstCaptureAt) : 'N/A'}s`
  + `（${withCapture.length}/${RUNS} 局观测到）`);
console.log(`首次出现某方多数占领(≥半数+1) 平均 ${withMajority.length ? +(withMajority.reduce((s, r) => s + r.firstMajorityAt, 0) / withMajority.length).toFixed(0) : 'N/A'}s`
  + `（${withMajority.length}/${RUNS} 局观测到）`);
console.log(`首次出现水晶枢纽掉血(据点数差≠0) 平均 ${withDrain.length ? +(withDrain.reduce((s, r) => s + r.firstDrainStartAt, 0) / withDrain.length).toFixed(0) : 'N/A'}s`
  + `（${withDrain.length}/${RUNS} 局观测到）`);

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (JSON_OUT) {
  const fs = await import('fs');
  fs.writeFileSync(JSON_OUT, JSON.stringify({ runs: RUNS, drainMult: DRAIN_MULT, rows }, null, 2));
  console.log(`结果已写入 ${JSON_OUT}`);
}
