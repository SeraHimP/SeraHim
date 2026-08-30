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
 *   node tools/balance_matrix.mjs --sweep soul --runs 20 # v43：八条龙魂的强度对照
 *                                                       #   基线档差值应≈0；每条魂目标胜率带 60~70%
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
// --map：在指定地图上跑。默认召唤师峡谷（历史基线都是在它上面测的，不要随便改默认值）。
// 加这个参数是因为新地图做完必须能【用同一把尺子】量一遍 ——
// 我自己临时写的简易脚手架量出来"塔零掉血"，连峡谷也是零，说明那种脚手架说明不了任何事。
const MAP_ID = arg('map', 'summoners_rift_v1');
const SWEEP = arg('sweep', 'none');
// v48：--pick 只跑名字含某个关键字的档位（逗号分隔多个）。
// 加它的唯一理由是**并行**：一轮 soul 对照是 8 档 × N 局，单进程要跑几个小时，
// 而各档之间完全独立（每档跑完都 restore，档与档不共享状态）。
// 拆成几个进程各跑几档，墙钟时间按核数除下去。
// ⚠️ 只用于分批跑，**下结论前必须确认基线档也跑过** —— 所有判读都是相对基线的差值，
// 没有基线的那几档数字单独看没有任何意义。
const PICK = arg('pick', '');
// v43：--sweep soul 用。非 null 时给**蓝方**的全部领受者（塔 + 大型小兵）装上这条龙魂。
let FORCE_SOUL = null;
let FORCE_POWER = null;   // v44：巨龙之力对照档（元素 key），给蓝方叠满层
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
const { FacingSystem } = await import('../src/systems/FacingSystem.js');
const { DragonSystem, dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');
// v48：工具改用与 main.js 同一批实体工厂（见 runOne 里那段长注释）。
const { createFactories, effectiveMaxHP } = await import('../src/core/factories.js');
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
  // ⚠️ 朝向系统**必须**跑。它不跑的话 entity._facing 恒为 undefined，
  // canFire 走"还没跑过一帧就不卡第一下"的兜底、一律返回 true ——
  // 于是"必须转过来才能打"这条规则在**平衡测量里整个不存在**，测出来的数不是游戏里的数。
  // 这正是 FacingSystem 头注里写的那件事：把规则留在渲染层的话，无头模式里规则会消失。
  // 我把规则下沉到了模拟层，却忘了把系统接进这个工具 —— 绕一圈又踩回同一个坑。
  const facing = new FacingSystem(ents);
  const waves = new LaneWaveSystem(ents, bus, mapSys);
  const world = new WorldState({ entities: ents, bus });
  // 熵档位：钉死在某个值扫曲线（此时三核不推进）。传 null 则由三核按对局事件自然演化。
  world.forceEntropy(FORCE_ENTROPY);
  AttributeCalculator.setWorldState(world);

  const score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };

  // ==================== v48：改用**真实工厂**建实体 ====================
  // 这里原来自己手搓塔与小兵的实体字面量 —— 那是 createBuilding / createMinion 之外的
  // **第三份**实现，而且早就长歪了。逐条列出它与游戏的差别（每一条都直接影响本工具要量的东西）：
  //
  //   ① `currentHP = baseStats.maxHP` 写在装龙魂**之前**。带 maxHPPct 的四条魂
  //      （炎5% / 山6% / 雷4% / 毒4%）因此在出生那一刻就少了自己那份血 ——
  //      **正好把要测的增益扣掉一部分**，而且给得越多扣得越多。
  //      这与用户报的"第二波龙不是满血"是同一个 bug，v47 已在 factories 里修掉，
  //      工具这一份没跟上。
  //   ② 塔的属性走一张**八字段白名单**（v43 Q9 在 createBuilding 里删掉的那张），
  //      attackType / bulletSpeed / damageReduction / 四个穿透字段全被丢掉。
  //   ③ 塔**只装武器**：没有身份技能、没有【加固城防】、没有塔成长、没有镀层。
  //      山魂给的是减伤与格挡、潮魂给的是回血，而加固城防正是"回血与生命节点封顶"那条 ——
  //      少了它，量的是另一个游戏里的山魂/潮魂。
  //   ④ 小兵**只装屠戮**：攻城车护盾、炮兵指挥官、超级兵指挥官全没有。
  //      v48 的攻城车改动（攻城疲惫 + 破甲重击）整个挂在 passive_siege_weapon 上，
  //      不装它就等于那批改动在平衡测量里不存在。
  //   ⑤ 小兵成长漏了地图级 minionGrowth 覆写，换地图跑时曲线是错的。
  //
  // 这正是本文件上面那段 FacingSystem 注释里写过的同一个坑：
  // "把规则留在别处，无头模式里规则就会消失"。当时我修的是朝向那一条，
  // 没意识到**整个实体构造**都是这个形状。现在直接调 createFactories，
  // 与 main.js 用的是同一批函数，工具与游戏之间不再有"第二套实体"。
  //
  // ⚠️ 因此**历史数值不可与本轮直接比较**：塔从此带加固城防与成长、小兵带全部默认被动，
  // 基线本身就换了一把尺子。本轮所有结论都基于重新跑出来的基线。
  const dragons = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  dragons.setMapLookup((id) => mapSys.getMapById?.(id) || null);
  dragons.setCombatSystem(combat);
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem: mapSys, dragonSystem: dragons,
    // 工具不需要界面，但工厂会往日志里写字 —— 给个空实现，别让它去碰 DOM。
    uiManager: { log() {} },
  });
  dragons.setCreateEntity(F.createDragon);
  // 注：DragonSystem **不进主循环**（下面没有 dragons.update）。对照要量的是
  // "拿到魂之后的强度差"，不是"抢龙的难易"—— 两件事混在一起的话，
  // 抢龙成功率会把魂本身的强度整个掩盖掉。这与 equipForcedSoul 的设计是同一条理由。

  // ---- 建筑 ----
  mapSys.setCreateBuildingFn((opt) => {
    const e = F.createBuilding(opt);
    if (e) forceAndRefill(e, fx, ents, bus);   // 龙魂 / 巨龙之力对照档
    return e;
  });

  // ---- 小兵 ----
  // 成长口径与 main.js 的 battleGrowthFlat 完全一致（含地图级 minionGrowth 覆写）。
  const growth = (type) => {
    const n = Math.max(0, (waves.waveNumber || 1) - 1);
    const G = CONFIG.battleGrowth || {};
    const mapG = mapSys.currentMap?.minionGrowth?.[type] || {};
    const f = { ...(G._default || {}), ...(G[type] || {}), ...mapG };
    return { hp: (f.hp || 0) * n, ad: (f.ad || 0) * n, res: (f.res || 0) * n };
  };
  waves.setCreateMinion((type, x, y, faction, laneId, direction) => {
    const e = F.createMinion(type, x, y, 1, 1, {
      faction, laneId, direction,
      growthFlat: growth(type),
      templateOverride: mapSys.currentMap?.minionTemplates?.[type],
    });
    if (e) forceAndRefill(e, fx, ents, bus);
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

  mapSys.loadMap(MAP_ID);

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
    facing.update(SIM_DT);   // 顺序与 main.js 的 stepSimulation 一致：移动/碰撞之后
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

/**
 * 对照档的增益是在工厂返回**之后**才装上去的，所以必须再补一次血。
 *
 * 这正是 v47 修掉的那个 bug 的同一个形状：带 maxHPPct 的魂/力（炎5% 山6% 雷4% 毒4%、
 * 山之力 2.5%/层）会把最大生命抬高，而 currentHP 已经按抬高前的数填好了 ——
 * 于是持魂方**全军出生即残血**，恰好把要测的那份增益扣掉一部分。
 * 不补的话这几条魂会被系统性地测低，而低多少取决于它给了多少 maxHPPct，
 * 也就是"给得越多、被扣得越多"—— 一条会让人把数值越调越大的负反馈。
 */
function forceAndRefill(e, fx, ents, bus) {
  equipForcedSoul(e, fx, ents, bus);
  const m = effectiveMaxHP(e);
  if (m > 0) e.currentHP = m;
}

/**
 * v43：龙魂对照档专用 —— 给**蓝方**的领受者装上 FORCE_SOUL。
 * 领受范围与引擎同源（DragonSystem.SOUL_REWARD_OK），否则测出来的东西不是游戏里的东西。
 * 走 equipSkill 而不是手动 push：龙魂的 onEquip 里要施加常驻效果（山魂/风魂），
 * 手动 push 会漏掉那一步，量出来的强度偏低。
 */
function equipForcedSoul(e, fx, ents, bus) {
  if ((e._mapFaction || e.faction) !== 'blue') return;
  if (!DragonSystem.SOUL_REWARD_OK(e)) return;
  if (FORCE_SOUL) {
    equipSkill(e, FORCE_SOUL, {
      entityContainer: ents, effectRegistry: fx, eventBus: bus,
      attrCalc: AttributeCalculator, waveNumber: 0,
    }, SkillLibrary);
  }
  // v44：巨龙之力单独一档。力和魂必须**分开测** ——
  // 混在一起的话，某一档偏强时分不清是"力给多了"还是"魂给多了"，
  // 只能整体往下砍，而整体砍会把本来正常的那一半也砍坏。
  if (FORCE_POWER) {
    const cap = (CONFIG.dragonPower && CONFIG.dragonPower.maxStacks) || 4;
    const el = FORCE_POWER;
    const buffs = dragonPowerBuffs(el);
    for (let i = 0; i < buffs.length; i++) {
      const b = buffs[i];
      const id = fx.apply(e.id, {
        name: `${el}之力`, icon: '🐉', kind: 'stat',
        statKey: b.statKey,
        flatValue: b.flat || 0, percentValue: b.percent || 0,
        perStackFlat: b.flat || 0, perStackPercent: b.percent || 0,
        duration: Infinity, permanent: true,
        stackable: true, maxStacks: cap, stackPolicy: 'stack',
        stackKey: `dragon_${el}_${b.statKey}`,
        description: `${el}增益`,
      }, `dragon_buff_${el}_${i}`);
      // 直接顶到满层：对照要量的是"集齐 4 条之后"的强度，不是攒的过程
      const eff = fx.getEffect(id);
      if (eff) { eff.stacks = cap; fx._recalcEffectValues(eff); fx._updateDescription(eff); }
    }
  }
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
} else if (SWEEP === 'soul') {
  // ==================== v43：龙魂平衡对照 ====================
  // 用户："做模拟对照吧。"
  // 八条龙魂各自跑一档「蓝方持魂 vs 红方无魂」，外加一档双方都无魂的**基线**。
  // 判读标准写死在这里，免得下次又靠感觉调：
  //   · 基线档的推进度差应当接近 0（对称局面）；
  //   · 每条魂的目标是让蓝方**略微**占优 —— 胜率带 60~70%。
  //     超过 70% 就砍数值，低于 55% 就加。龙魂该是胜负手，不该是终局宣告。
  //
  // 实现方式：直接给蓝方全体领受者装上那条魂（不真的去打龙）——
  // 我们要量的是"拿到魂之后的强度差"，不是"抢龙的难易"，两件事必须分开测，
  // 混在一起的话抢龙成功率会把魂本身的强度掩盖掉。
  // v51.6 修复：这份清单一直停在 v44 删光魂那一版，v50 新增的六条魂
  // （frost/steel/blood/magma/astral/rift）从来没被这把尺子量过——沉默的空白，
  // 不是"量过没问题"。补齐成当前 SkillLibrary 里真实存在的全部 dragonsoul_* 元素。
  const SOULS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison',
    'frost', 'steel', 'blood', 'magma', 'astral', 'rift'];
  cells.push(['基线·双方无魂', () => { FORCE_SOUL = null; }, () => { FORCE_SOUL = null; }]);
  for (const k of SOULS) {
    cells.push([`蓝方持${k}魂`, () => { FORCE_SOUL = 'dragonsoul_' + k; },
                () => { FORCE_SOUL = null; }]);
  }
} else if (SWEEP === 'power') {
  // v44：**巨龙之力**单独一档（满 4 层，不给魂）。
  // 判读：力是"过程奖励"，强度应当明显低于魂 —— 每档的推进度差落在基线 +0.3~+1.0 之间。
  // 力比魂还强就说明成魂这件事没有意义了。
  const ELS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison'];
  cells.push(['基线·双方无力', () => { FORCE_POWER = null; }, () => { FORCE_POWER = null; }]);
  for (const k of ELS) {
    cells.push([`蓝方满${k}之力`, () => { FORCE_POWER = k; }, () => { FORCE_POWER = null; }]);
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
if (PICK) {
  const keys = PICK.split(',').map(k => k.trim()).filter(Boolean);
  const kept = cells.filter(([label]) => keys.some(k => label.includes(k)));
  if (!kept.length) {
    console.log(`\u274c --pick "${PICK}" \u6ca1\u5339\u914d\u5230\u4efb\u4f55\u6863\u4f4d\u3002\u53ef\u7528\uff1a\n  ` + cells.map(c => c[0]).join('\n  '));
    process.exit(1);
  }
  cells.length = 0;
  cells.push(...kept);
}
console.log(`批量对局模拟：地图 ${MAP_ID}，每档 ${RUNS} 局，单局上限 ${MAX_MIN} 分钟，档位 ${cells.length} 个`);
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
