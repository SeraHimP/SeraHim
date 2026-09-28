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
 *   node tools/balance_matrix.mjs                       # 默认档位跑一遍，单局不设时长上限（跑到分出胜负为止）
 *   node tools/balance_matrix.mjs --runs 8 --minutes 40 # 每档 8 局、每局封顶 40 分钟（快速摸底用，见下方说明）
 *   node tools/balance_matrix.mjs --sweep dayNight      # 扫昼夜阵营加成
 *   node tools/balance_matrix.mjs --sweep entropy       # 扫熵档位（熵实现后可用）
 *   node tools/balance_matrix.mjs --sweep soul --runs 20 # v43：八条龙魂的强度对照
 *                                                       #   基线档差值应≈0；每条魂目标胜率带 60~70%
 *   node tools/balance_matrix.mjs --json out.json       # 结果落盘，便于前后对比
 *   node tools/balance_matrix.mjs --no-entropy           # 关掉熵三核推进（不影响速度，见下方说明）
 *
 * 说明：
 * - 纯 headless，不需要浏览器；用真实的 MapSystem / LaneWaveSystem / CombatSystem，
 *   不是简化模型 —— 简化模型算出来的平衡没有意义。
 * - 每档用固定种子序列，同一命令重复跑结果一致（可复现）。
 * - 渲染层完全不参与，一局模拟通常只需几秒到几十秒，但**默认不设时长上限**——
 *   实测双方打不动的对局可能需要模拟出几个游戏小时才能分出胜负，真实耗时仍然
 *   很快（不经过渲染），但如果两边真的谁都打不穿（对称僵局），这一档会一直跑
 *   下去不退出——那本身就是该被发现和报告的平衡问题，不要通过 --minutes 强行
 *   封顶来掩盖它；--minutes 仅用于明确知道自己只要一个快速代理信号的场景。
 */
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const RUNS = parseInt(arg('runs', '5'), 10);
// ==================== 2026-09-19：默认取消单局时长上限 ====================
// 用户实测发现：--minutes 40（乃至45）下，绝大多数对局（尤其基线）在时限内根本
// 分不出胜负（14 档里 13 档是"平 20/20"），意味着"胜率"这条主信号大面积失效，
// 只能退而求其次看【推进度差】这个代理指标——但那终究是代理，不是真实结果。
// 用户原话："因为40分钟分不出来胜负，所以取消时间限制，我的电脑跑起来配置高。"
// 现在默认不设上限：主循环（见下面 maxT 用法）会一直跑到水晶枢纽被摧毁为止，
// 用真实胜负当主信号。--minutes 仍然保留，传了就按传的值封顶——留给需要快速
// 摸底、不在乎跑不出真实胜负的场景（比如 --quick 式的冒烟检查）用。
// 注意：默认无上限意味着"两边打不动、永远分不出胜负"会变成这个进程真的挂住
// 不退出，而不是像以前那样 40 分钟后体面收场——如果发生这种情况，"这一档
// 卡住不结束"本身就是一个值得报告的平衡问题（大概率是某种对称僵局），不是
// 工具的锅，不要为了让工具"看起来能跑完"就悄悄重新加一个隐藏上限糊弄过去。
const minutesArg = arg('minutes', null);
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
// ==================== 2026-09-19：--no-entropy ====================
// 用户问："这个功能几乎处于永久关闭状态，关闭熵之后跑起来是不是更快一些"——
// 如实回答写在下面（读代码验证过，不是猜）：熵系统对**耦合到玩法**这一半本来就
// 默认全关（CONFIG.world.couplings 的 entropyToUnits/entropyToWeather/
// entropyToDayNight 三个都是 false），熵值从没被喂回过任何一局的战斗结果；
// **跟踪计算**这一半（EntropySystem.update）本身是 O(1)——只有两次减法和一个
// 计时器比较，没有任何按帧扫全场实体的查询，开着也几乎不产生可测的耗时。
// 所以关掉它**不会让批量对局明显跑得更快**——真正的耗时大头是每局本身要模拟
// 多少游戏内分钟（这次刚好又把这个上限从40分钟去掉了，见上面 MAX_MIN 的改动），
// 跟熵开不开无关。加这个开关不是为了性能，是为了让"终局熵"这一栏在确认关掉后
// 干脆显示"关闭"而不是一个从不影响结果、只会让人误以为它在起作用的数字。
const NO_ENTROPY = args.includes('--no-entropy');
// v43：--sweep soul 用。非 null 时给**蓝方**的全部领受者（塔 + 大型小兵）装上这条龙魂。
let FORCE_SOUL = null;
let FORCE_POWER = null;   // v44：巨龙之力对照档（元素 key），给蓝方叠满层
const JSON_OUT = arg('json', '');

const { createSimulation, SIM_DT } = await import('../src/simulation.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { DragonSystem, dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');
const { effectiveMaxHP } = await import('../src/core/factories.js');
const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');

// 2026-09-21：--minutes 优先级链 CLI > CONFIG.gameRules.maxSimMinutes > 无上限。
// 用户原话"设定每局游戏最长跑120分钟（代码实现，默认还是无上限）"——上面那段
// 2026-09-19 的教训（默认封顶会把胜率这条主信号打没）依然成立，不能碰
// CONFIG.gameRules.maxSimMinutes 的默认值，所以它留 null（=Infinity）；
// "代码实现"要的是有一个统一读取点，而不是每次都要记得手打 --minutes，
// 以后哪个批次要用固定上限（比如塔平衡对照——见 balance_tower.mjs），
// CLI 传参就行，不影响这里的默认行为。
const MAX_MIN = minutesArg != null ? parseFloat(minutesArg)
  : (Number.isFinite(CONFIG.gameRules?.maxSimMinutes) ? CONFIG.gameRules.maxSimMinutes : Infinity);

let FORCE_ENTROPY = null;   // 熵扫档时由 runCell 的 apply 钩子钉住

// 可复现的随机：整局把 Math.random 换成种子发生器，跑完还原。
// 不这么做的话 seed 参数就是摆设——同一档的 N 局会因为出兵抖动完全同轨，
// "跑 20 局取平均"退化成"跑 1 局抄 20 遍"，胜率数字看着稳其实没有任何样本量。
const { seedRandom: seedRandomLogic } = await import('../src/core/rng.js');
const _realRandom = Math.random;
function _seedRandom(seed) {
  seedRandomLogic(seed);
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

  // 2026-09-27：改用 src/simulation.js——与游戏 main.js 同一套系统、同一套接线、同一个
  // step()。原来这里手抄了一份更新顺序，漏了 ManaSystem（主动技能从不施放）、
  // WeatherSystem、DragonSystem、LaneAvengerSystem、GroundTraceSystem，
  // 对统治战场地图还没有 DominionSystem：量的是另一个游戏。
  // ⚠️ 因此本次之前的平衡结论不能与之后的直接比较。
  const sim = createSimulation();
  const { eventBus: bus, entityContainer: ents, effectRegistry: fx,
          mapSystem: mapSys, laneWaveSystem: waves, worldState: world, factories: F } = sim;
  // 熵档位：钉死在某个值扫曲线（此时三核不推进）。传 null 则由三核按对局事件自然演化。
  world.forceEntropy(FORCE_ENTROPY);

  const score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };

  // 龙魂/巨龙之力对照档：给蓝方装上要量的魂/力之后必须补满血（见 forceAndRefill 头注）。
  // 工厂与成长口径都是 simulation.js 那一份，这里只在外面包一层"装魂 + 补血"。
  mapSys.setCreateBuildingFn((opt) => {
    const e = F.createBuilding(opt);
    if (e) forceAndRefill(e, fx, ents, bus);
    return e;
  });
  waves.setCreateMinion((type, x, y, faction, laneId, direction) => {
    const e = F.createMinion(type, x, y, 1, 1, {
      faction, laneId, direction,
      growthFlat: sim.battleGrowthFlat(type),
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
  const maxFrames = MAX_MIN * 60 / SIM_DT;
  let winner = null;
  for (let frame = 1; frame <= maxFrames; frame++) {
    sim.step(SIM_DT);
    ents.purgeDead();
    // 胜负：水晶枢纽被摧毁。用帧计数判"每秒"，不用 (t*30)%30（浮点误差会随机漏检）。
    if (frame % 30 === 0) {
      for (const fac of ['blue', 'red']) {
        const nexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === fac);
        if (nexus && !nexus.alive) { winner = fac === 'blue' ? 'red' : 'blue'; break; }
      }
      if (winner) break;
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
 *
 * 2026-09-04 修复：这两个分支原来共用同一句 `if (!SOUL_REWARD_OK(e)) return;`
 * 早退——巨龙之力分支被误连坐进了龙魂那条【窄】范围（塔+大型小兵，不含普通
 * 近战/远程兵）。DragonSystem.js 自己的注释写得很清楚：龙魂用 SOUL_REWARD_OK，
 * 巨龙之力用【更宽】的 POWER_REWARD_OK（塔+全部小兵，含近战/远程），这是用户
 * 定稿"巨龙之力现在作用于所有单位（包含普通小兵）"——工具这份没跟上，于是
 * `--sweep power` 量出来的强度系统性偏低（普通兵完全没吃到力），量出来的
 * "参差不齐"程度也不可信。改成两个分支各自判自己的领受范围。
 */
function equipForcedSoul(e, fx, ents, bus) {
  if ((e._mapFaction || e.faction) !== 'blue') return;
  // v44：巨龙之力单独一档。力和魂必须**分开测** ——
  // 混在一起的话，某一档偏强时分不清是"力给多了"还是"魂给多了"，
  // 只能整体往下砍，而整体砍会把本来正常的那一半也砍坏。
  if (FORCE_SOUL && DragonSystem.SOUL_REWARD_OK(e)) {
    equipSkill(e, FORCE_SOUL, {
      entityContainer: ents, effectRegistry: fx, eventBus: bus,
      attrCalc: AttributeCalculator, waveNumber: 0,
    }, SkillLibrary);
  }
  if (FORCE_POWER && DragonSystem.POWER_REWARD_OK(e)) {
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
  //
  // 2026-09-19 修复：这份清单跟 SOULS 一样在 v50 加 frost/steel/blood/magma/astral/
  // rift 六条魂时该同步却没同步——SOULS 那份在 v51.6 补齐过了，这份 ELS 一直停在
  // v44 最初的 7 个元素，沉默漏测了 6 档，被用户发现"系统里明明有 10+ 种巨龙之力，
  // 扫描却只跑了 8 档（基线+7）"。现在补齐成与 CONFIG.dragonPower 里真实存在的
  // 13 个元素键一致（与 SOULS 逐项同名，一一对应）。
  // 不含 'ancient'（远古之力）：它和这 13 个元素不是同一种"力"——元素之力是
  // "先手击杀 4 条元素龙即封顶"的一次性满层对照，远古之力是每杀一条远古龙就
  // 永久再叠一层、层数上不封顶（见 DragonSystem._applyAncientPower 的 maxStacks:999），
  // 硬套这份工具"钉死在 cap=4"的量法量出来的数字不代表远古之力真实的后期强度，
  // 量出来反而会误导人以为它就这么弱。远古之力需要单独设计一套"随远古龙击杀数
  // 演化"的对照方式，留到下一轮专门做，不在这里囫囵塞一档凑数。
  const ELS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison',
    'frost', 'steel', 'blood', 'magma', 'astral', 'rift'];
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

// 龙魂/巨龙之力对照：要量的是"拿到魂/力之后的强度差"，不是"抢龙的难易"——
// 整个对照（含它自己的基线档）都关掉真实刷龙，否则抢龙成功率会把魂本身的强度掩盖掉。
if (SWEEP === 'soul' || SWEEP === 'power') {
  for (const c of cells) {
    const [apply, restore] = [c[1], c[2]];
    c[1] = () => { c._spawn0 = CONFIG.dragonToggles.spawn; CONFIG.dragonToggles.spawn = false; apply(); };
    c[2] = () => { restore(); CONFIG.dragonToggles.spawn = c._spawn0; };
  }
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
const minLabel = Number.isFinite(MAX_MIN) ? `单局上限 ${MAX_MIN} 分钟` : '单局不设时长上限（跑到分出胜负为止）';
console.log(`批量对局模拟：地图 ${MAP_ID}，每档 ${RUNS} 局，${minLabel}，档位 ${cells.length} 个${NO_ENTROPY ? '，熵已关闭' : ''}`);
{
  const { MAPS } = await import('../src/data/maps/index.js');
  if (MAPS[MAP_ID]?.dominionNodes) {
    console.log('⚠️ 这是统治战场地图：本工具的"推进度"只数防御塔档位，看不到据点占领与水晶掉血。'
      + '请改用 node tools/balance_dominion.mjs。');
  }
}
console.log('（纯 headless，使用真实的 MapSystem/LaneWaveSystem/CombatSystem，非简化模型）\n');

// --no-entropy：整批统一关掉三核推进（见上面 NO_ENTROPY 定义处的说明——不是为了
// 性能，是让"终局熵"这一栏不再打印一个从不影响结果的数字）。跑完还原，避免这个
// 进程后面还有别的代码路径读到被改过的 CONFIG（虽然当前用法是跑完就退出）。
const _entropyEnabledBefore = CONFIG.world.entropy.enabled;
if (NO_ENTROPY) CONFIG.world.entropy.enabled = false;

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
    `  推进度 蓝${r.pushB}/红${r.pushR}（差 ${sign}${r.pushDiff}）` +
    (NO_ENTROPY ? '  终局熵 关闭' : `  终局熵 ${r.entropy}`)
  );
}
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
CONFIG.world.entropy.enabled = _entropyEnabledBefore;

if (results.length > 1) {
  const rates = results.map(r => r.blueRate);
  const diffs = results.map(r => r.pushDiff);
  console.log(`蓝方胜率区间 ${Math.min(...rates)}% ~ ${Math.max(...rates)}%` +
              `（跨度 ${Math.max(...rates) - Math.min(...rates)} 个百分点）`);
  console.log(`推进度差区间 ${Math.min(...diffs)} ~ ${Math.max(...diffs)}` +
              `（跨度 ${(Math.max(...diffs) - Math.min(...diffs)).toFixed(2)}）`);
}
console.log(
  Number.isFinite(MAX_MIN)
    ? ('\n判读提示：\n' +
      '  · 本次跑的是有时长上限的快速摸底（--minutes 明确传了值），对局可能因为封顶而打平，\n' +
      '    这种情况下【推进度差】才是主信号，胜率是副信号。\n' +
      '    推进度 = 打掉对方几档塔（外塔1/内塔2/高地塔3/召唤水晶4/枢纽5）+ 当前最前线那座的掉血比例。\n' +
      '  · 差值 0 = 对称；正 = 蓝方占优。看【趋势】而不是单点，要下结论请用 --runs 20 以上。')
    : ('\n判读提示：\n' +
      '  · 本次单局不设时长上限，"平"意味着真的两边都摧毁不了对方的水晶枢纽（不是被时限打断），\n' +
      '    这种情况本身就是重要信号——胜率和"平"的占比才是主信号，不再需要靠推进度差代理。\n' +
      '  · 推进度差依旧一并打出来，仍然有参考价值（谁占优、占优多少）。\n' +
      '  · 差值 0 = 对称；正 = 蓝方占优。看【趋势】而不是单点，要下结论请用 --runs 20 以上。')
);

if (JSON_OUT) {
  const fs = await import('fs');
  // Infinity 不能被 JSON.stringify 原样序列化（会变成 null，读的人看不出"不设上限"和
  // "读取失败"的区别），显式写成字符串 'unlimited'，跟数字上限区分开。
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    runs: RUNS, maxMin: Number.isFinite(MAX_MIN) ? MAX_MIN : 'unlimited', sweep: SWEEP, results,
  }, null, 2));
  console.log(`结果已写入 ${JSON_OUT}`);
}
