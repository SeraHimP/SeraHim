#!/usr/bin/env node
/**
 * balance_matrix.mjs —— 批量对局模拟，输出胜率/时长矩阵
 *
 * ============ 为什么必须有这个 ============
 * 引入熵之后是【非对称对战】（蓝=秩序 / 红=混乱），而现有数值全是对称的。
 * 非对称平衡的验证成本比对称高一个量级：不能只看"谁赢了"，要看
 * **胜率曲线随参数的变化趋势**。靠人肉一局一局看，调一次数值就得盯半小时，
 * 根本不可能收敛。所以熵系统开工前，先把这把尺子造出来。
 *
 * 用法：
 *   node tools/balance_matrix.mjs                       # 默认档位跑一遍
 *   node tools/balance_matrix.mjs --runs 8 --minutes 40 # 每档 8 局、每局上限 40 分钟
 *   node tools/balance_matrix.mjs --sweep dayNight      # 扫昼夜阵营加成
 *   node tools/balance_matrix.mjs --sweep entropy       # 扫熵档位（熵实现后可用）
 *   node tools/balance_matrix.mjs --json out.json       # 结果落盘，便于前后对比
 *
 * 说明：
 * - 纯 headless，不需要浏览器；用真实的 MapSystem / LaneWaveSystem / CombatSystem，
 *   不是简化模型 —— 简化模型算出来的平衡没有意义。
 * - 每档用固定种子序列，同一命令重复跑结果一致（可复现）。
 * - 渲染层完全不参与，故一局 40 分钟的模拟只需几秒。
 */
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const RUNS = parseInt(arg('runs', '5'), 10);
const MAX_MIN = parseFloat(arg('minutes', '45'));
const SWEEP = arg('sweep', 'none');
const JSON_OUT = arg('json', '');

const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');

const SIM_DT = 1 / 30;
let FORCE_ENTROPY = null;   // 熵扫档时由 runCell 的 apply 钩子钉住

// 可复现的随机：整局把 Math.random 换成种子发生器，跑完还原。
// 不这么做的话 seed 参数就是摆设——同一档的 N 局会因为出兵抖动完全同轨，
// "跑 20 局取平均"退化成"跑 1 局抄 20 遍"，胜率数字看着稳其实没有任何样本量。
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

/** 跑一局，返回 { winner, minutes, towers, kills } */
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
  const waves = new LaneWaveSystem(ents, bus, mapSys);
  const world = new WorldState({ entities: ents, bus });
  // 熵档位：钉死在某个值扫曲线（此时三核不推进）。传 null 则由三核按对局事件自然演化。
  world.forceEntropy(FORCE_ENTROPY);
  AttributeCalculator.setWorldState(world);

  const score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };

  // ---- 建筑 ----
  mapSys.setCreateBuildingFn(({ faction, tier, laneId, isNexus, pos, weapon, stats }) => {
    const tpl = CONFIG.templates.tower;
    const s = { ...(stats || {}),
                ...(CONFIG.towerTierOverrides?.[tier] || {}),
                ...(CONFIG.factionOverrides?.[faction]?.['tower_' + tier] || {}) };
    const e = {
      id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
      baseStats: {
        ...tpl,
        maxHP: s.maxHP ?? tpl.maxHP, armor: s.armor ?? tpl.armor,
        magicResist: s.magicResist ?? tpl.magicResist,
        attackDamage: s.attackDamage ?? tpl.attackDamage,
        baseAttackSpeed: s.baseAttackSpeed ?? tpl.baseAttackSpeed,
        healthRegen: s.healthRegen ?? tpl.healthRegen,
        attackRange: s.attackRange ?? tpl.attackRange,
        shieldFixedMax: s.shieldFixedMax ?? 0,
      },
      currentHP: 0, shieldFixedCurrent: s.shieldFixedMax ?? 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
      _skillInstances: [], _inCombat: false, _attackerCount: 0,
      _mapFaction: faction, _mapTier: tier, _laneId: laneId || null, faction,
    };
    e.currentHP = e.baseStats.maxHP;
    const wKey = CONFIG.towerTierWeapon?.[tier] !== undefined
      ? CONFIG.towerTierWeapon[tier] : (isNexus ? 'none' : weapon);
    if (wKey && wKey !== 'none') e._skillInstances.push({ id: ++window._uid, skillId: 'weapon_' + wKey, state: {} });
    ents.add(e);
    return e;
  });

  // ---- 小兵 ----
  const growth = (type) => {
    const n = Math.max(0, (waves.waveNumber || 1) - 1);
    const G = CONFIG.battleGrowth || {};
    const f = { ...(G._default || {}), ...(G[type] || {}) };
    return { hp: (f.hp || 0) * n, ad: (f.ad || 0) * n, res: (f.res || 0) * n };
  };
  waves.setCreateMinion((type, x, y, faction, laneId, direction) => {
    const tpl = CONFIG.templates[type];
    if (!tpl) return null;
    const g = growth(type);
    const e = {
      id: ++window._uid, type, alive: true, pos: { x, y },
      baseStats: {
        ...tpl,
        maxHP: tpl.maxHP + g.hp,
        attackDamage: tpl.attackDamage + g.ad,
        armor: tpl.armor + g.res, magicResist: tpl.magicResist + g.res,
      },
      currentHP: tpl.maxHP + g.hp, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
      _skillInstances: [], _mapFaction: faction, _laneId: laneId,
      _laneDirection: direction, faction,
    };
    // 屠戮（对战节奏的主导项，必须带上，否则模拟结果没有参考价值）
    const rend = { melee: 'passive_melee_rend', ranged: 'passive_ranged_rend', siege: 'passive_siege_rend' }[type];
    if (rend) e._skillInstances.push({ id: ++window._uid, skillId: rend, state: {} });
    ents.add(e);
    return e;
  });

  bus.on('entity:death', ({ entityId }) => {
    const e = ents.get(entityId);
    if (!e) return;
    const scorer = (e._mapFaction || e.faction) === 'blue' ? 'red' : 'blue';
    if (e.type === 'tower') {
      if (['outer', 'inner', 'base', 'hq_tower'].includes(e._mapTier)) score[scorer].towers++;
    } else score[scorer].kills++;
  });

  mapSys.loadMap('summoners_rift_v1');

  // ---- 主循环 ----
  const maxT = MAX_MIN * 60;
  let winner = null;
  let frame = 0;
  for (let t = 0; t < maxT; t += SIM_DT) {
    frame++;
    window.gameTime = t;
    AttributeCalculator.tick();
    ents.rebuildGridIfNeeded(AttributeCalculator._frame);
    world.update(SIM_DT, t);
    waves.update(SIM_DT);
    move.update(SIM_DT);
    coll.update(SIM_DT);
    combat.update(SIM_DT);
    proj.update(SIM_DT);
    buffs.update(SIM_DT);
    fx.update(SIM_DT);
    mapSys.update(SIM_DT);
    ents.purgeDead();

    // 胜负：水晶枢纽被摧毁。用【帧计数】而不是 (t*30)%30——t 是 1/30 累加出来的，
    // 浮点误差让 t*30 很快就不再是整数，这个取模条件会随机漏检。
    if (frame % 30 === 0) {
      for (const fac of ['blue', 'red']) {
        const nexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === fac);
        if (nexus && !nexus.alive) { winner = fac === 'blue' ? 'red' : 'blue'; break; }
      }
      if (winner) { window.gameTime = t; break; }
    }
  }

  // ---- 推进度（打平时的主信号）----
  // 实测：基线对局 40 分钟内几乎不会分出胜负（双方各推掉 8~10 座塔就僵住了）。
  // 只看胜率的话，整张矩阵会是一片 0%，任何参数改动都读不出差别——尺子等于没造。
  // 所以额外记录"推进深度"：对方每丢一档塔算一级，再加上最深一层建筑的残血比例。
  // 这个量在打平的对局里依然连续可比，才是调参时真正要盯的曲线。
  const TIER_RANK = { outer: 1, inner: 2, base: 3, hq_tower: 3, nexus_lane: 4, nexus_main: 5 };
  const pushScore = (attacker) => {
    const victim = attacker === 'blue' ? 'red' : 'blue';
    let s = 0, frontHP = 1;
    for (const e of ents.getAllTowers(false)) {
      if (e._mapFaction !== victim) continue;
      const rank = TIER_RANK[e._mapTier] || 0;
      if (!e.alive) { s = Math.max(s, rank); continue; }
      const hp = Math.max(0, e.currentHP) / Math.max(1, e.baseStats.maxHP);
      if (rank === s + 1 && hp < frontHP) frontHP = hp;
    }
    return +(s + (1 - frontHP)).toFixed(2);
  };

  const out = {
    winner: winner || 'draw',
    minutes: +(window.gameTime / 60).toFixed(1),
    towers: { blue: score.blue.towers, red: score.red.towers },
    kills: { blue: score.blue.kills, red: score.red.kills },
    push: { blue: pushScore('blue'), red: pushScore('red') },
    // 终局熵：自演化档位下用来判断"雪球有没有滚起来"（0.5=中性，逼近上下限=失控）
    entropy: +world.entropy.value.toFixed(3),
  };
  AttributeCalculator.setWorldState(null);
  Math.random = _realRandom;
  return out;
}

/** 跑一个档位 */
function runCell(label, apply, restore) {
  apply();
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`\r  ${label} … ${i + 1}/${RUNS}`);
    rows.push(runOne(i));
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  restore();
  const avg = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
  const blue = rows.filter(r => r.winner === 'blue').length;
  const red = rows.filter(r => r.winner === 'red').length;
  const draw = rows.filter(r => r.winner === 'draw').length;
  const pushB = avg(r => r.push.blue), pushR = avg(r => r.push.red);
  return {
    label, runs: rows.length, blue, red, draw,
    blueRate: +(blue / rows.length * 100).toFixed(0),
    avgMin: avg(r => r.minutes),
    avgTB: avg(r => r.towers.blue), avgTR: avg(r => r.towers.red),
    pushB, pushR, pushDiff: +(pushB - pushR).toFixed(2),
    entropy: avg(r => r.entropy),
    rows,
  };
}

// ==================== 档位定义 ====================
const cells = [];
const cw = CONFIG.world.couplings;

if (SWEEP === 'dayNight') {
  const BONUS0 = { ...CONFIG.world.dayNightBonus };
  for (const pct of [0, 3, 5, 8, 12]) {
    cells.push(['昼夜加成 ' + pct + '%', () => {
      cw.dayNightFaction = pct > 0;
      CONFIG.world.dayNightBonus = { moveSpeedPct: pct, attackDamagePct: Math.round(pct * 0.8) };
    }, () => {
      // 必须把改过的配置整体还原：档位之间共用同一个 CONFIG 实例，
      // 只还原开关不还原数值的话，后一档会带着前一档的残留跑。
      cw.dayNightFaction = false;
      CONFIG.world.dayNightBonus = { ...BONUS0 };
    }]);
  }
} else if (SWEEP === 'entropy') {
  for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    cells.push(['熵 ' + v.toFixed(1), () => {
      cw.entropyToUnits = true;
      FORCE_ENTROPY = v;
    }, () => { cw.entropyToUnits = false; FORCE_ENTROPY = null; }]);
  }
} else if (SWEEP === 'entropyLive') {
  // 熵【自然演化】下扫加成幅度。这一档才是真正要看的：
  // 钉死熵值只能验证"给定熵值时谁占优"，验证不了那条正反馈回路
  // （红方多杀 → 熵升 → 红方更强 → 杀更多）会不会滚雪球。
  // 判读：推进度差应随幅度增大而单调偏离 0；若在某一档突然跳变，就是雪球滚起来了。
  const B0 = { ...CONFIG.world.entropyBonus };
  for (const pct of [0, 4, 8, 16, 32]) {
    cells.push(['熵自演化·幅度 ' + pct, () => {
      cw.entropyToUnits = true;
      CONFIG.world.entropyBonus = { attackDamagePct: pct, armorFlat: Math.round(pct * 0.75) };
      FORCE_ENTROPY = null;
    }, () => {
      cw.entropyToUnits = false;
      CONFIG.world.entropyBonus = { ...B0 };
    }]);
  }
} else {
  cells.push(['基线（所有耦合关闭）', () => {}, () => {}]);
}

// ==================== 跑 ====================
console.log(`批量对局模拟：每档 ${RUNS} 局，单局上限 ${MAX_MIN} 分钟，档位 ${cells.length} 个`);
console.log('（纯 headless，使用真实的 MapSystem/LaneWaveSystem/CombatSystem，非简化模型）\n');

const t0 = Date.now();
const results = [];
for (const [label, apply, restore] of cells) {
  const r = runCell(label, apply, restore);
  results.push(r);
  const sign = r.pushDiff > 0 ? '+' : '';
  console.log(
    `${label.padEnd(22)} 蓝胜 ${String(r.blue).padStart(2)}/${r.runs}（${String(r.blueRate).padStart(3)}%）` +
    `  红胜 ${String(r.red).padStart(2)}  平 ${String(r.draw).padStart(2)}` +
    `  均时长 ${String(r.avgMin).padStart(5)} 分  推塔 蓝${r.avgTB}/红${r.avgTR}` +
    `  推进度 蓝${r.pushB}/红${r.pushR}（差 ${sign}${r.pushDiff}）  终局熵 ${r.entropy}`
  );
}
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (results.length > 1) {
  const rates = results.map(r => r.blueRate);
  const diffs = results.map(r => r.pushDiff);
  console.log(`蓝方胜率区间 ${Math.min(...rates)}% ~ ${Math.max(...rates)}%` +
              `（跨度 ${Math.max(...rates) - Math.min(...rates)} 个百分点）`);
  console.log(`推进度差区间 ${Math.min(...diffs)} ~ ${Math.max(...diffs)}` +
              `（跨度 ${(Math.max(...diffs) - Math.min(...diffs)).toFixed(2)}）`);
}
console.log(
  '\n判读提示：\n' +
  '  · 基线对局在 40 分钟内基本打不出胜负，所以【推进度差】才是主信号，胜率是副信号。\n' +
  '    推进度 = 打掉对方几档塔（外塔1/内塔2/高地塔3/召唤水晶4/枢纽5）+ 当前最前线那座的掉血比例。\n' +
  '  · 差值 0 = 对称；正 = 蓝方占优。看【趋势】而不是单点，要下结论请用 --runs 20 以上。'
);

if (JSON_OUT) {
  const fs = await import('fs');
  fs.writeFileSync(JSON_OUT, JSON.stringify({ runs: RUNS, maxMin: MAX_MIN, sweep: SWEEP, results }, null, 2));
  console.log(`结果已写入 ${JSON_OUT}`);
}
