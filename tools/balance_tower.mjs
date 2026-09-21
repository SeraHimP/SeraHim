#!/usr/bin/env node
/**
 * balance_tower.mjs —— 防御塔武器强度横向对照（在真实召唤师峡谷上跑）
 *
 * ==================== 这把尺子量的是什么 ====================
 * 用户原话："在这个测试中，红蓝方中随机某一方为进攻方，进攻方的所有防御塔获得
 * 90%伤害减免并且获得1000%伤害增幅（进攻方所有防御塔武器设置为闪电杖），
 * 进攻方所有小兵额外获得33%伤害减免。防守方一切正常。这个地图是用来测试防御塔
 * 强度的，就是通过设置防守方所有防御塔的武器类型来横向判断防御塔的武器强度。"
 *
 * ==================== 返工记录（如实记录）====================
 * 第一版做错了两件事，用户原话："这个防御塔测试场就是复用召唤师峡谷的地图，
 * 并且我看也没有进攻方和防守方的属性加成啊！进攻方获得的属性加成通过永久状态
 * 实现！"：
 *   ① 自己另造了一张最小地图（tower_balance_test_v1），而不是像其它平衡工具
 *      （龙魂/巨龙之力）一样在真实地图上量——已删除那张图，改用 summoners_rift_v1。
 *   ② 把进攻方增益直接内联写在这个脚本里（一串 fx.apply），只存在于脚本自己
 *      的一次性内存模拟里，游戏/编辑器里正常打开地图什么都看不到。现在改成
 *      equipSkill 装一条真实存在于 SkillLibrary 里的技能
 *      （passive_test_tower_attacker / passive_test_minion_attacker，见
 *      src/core/skills/testScenarios.js），跟 balance_matrix.mjs 给蓝方装龙魂
 *      同一条路径——脚本不再发明任何新机制，只是"批量装配+批量跑+统计"。
 *
 * 2026-09-21：用户又要求"测试技能中删除强制替换闪电杖"——passive_test_tower_attacker
 * 不再改动进攻方的塔武器，进攻方各档塔沿用召唤师峡谷自己声明的默认武器
 * （outer/inner=piercing、base/hq_tower=lightning，是个固定的混编，不是清一色
 * 闪电杖了）。这份"进攻方武器组成"对同一次横向对照里的每一档（每一种防守方
 * 武器）都完全相同，所以【谁是进攻方的武器】依旧是被焊死的常量，跨档比较照样
 * 干净——只是从"焊死成单一武器"变成"焊死成地图默认的这份混编"，不影响
 * "防守方这一档用哪种塔武器"才是唯一变量这条设计意图。
 *
 * 进攻方被人为拉到近乎打不死、且输出被放大到 11 倍（1+1000%）的极端强度，
 * 场上唯一在变的是【防守方这一档用哪种塔武器】——量出来的差异才能干净地
 * 归因到"这种塔武器扛揍/续航能力强不强"，不会被"进攻方武器碰巧也很强"这个
 * 混杂因素污染。
 *
 * 进攻方是**每局**随机指派蓝或红（不是固定蓝方），这样也把"地图/引擎里
 * 会不会有某些不易察觉的红蓝不对称"这个变量洗掉——同一档 20 局里蓝当过
 * 进攻方也当过防守方，差异不会来自"恰好蓝方天生強"。
 *
 * ==================== 该看哪个数字 ====================
 * 进攻方的强度被人为拉到这个量级后，几乎每一档【胜负】本身都会一边倒（进攻方
 * 赢），"胜率"在这里不是有效信号——跟 balance_matrix.mjs 里"平局"会让胜率
 * 失效是同一个道理，只是这里换成了"赢率"失效。真正有信息量的是【防守方撑了
 * 多久 / 被打掉了几档塔】：同样打不过，防御塔武器强的那一档应该扛得更久、
 * 少丢几档塔，这才是"防御塔强度"这个词本来该衡量的东西。所以下面的输出
 * 以【均时长（=防守方存活时长）】【防守方平均丢塔档位】为主信号，胜负只作为
 * 极端情况的旁证（哪种武器居然能让防守方赢，那就是真的离谱地强）。
 *
 * ==================== 单局时长上限 ====================
 * 用户原话"设定每局游戏最长跑120分钟"——这正是这个场景需要它的地方：防守方
 * 武器如果强到能和被拉满的进攻方长期僵持，对局可能真的不会自然结束。
 * 默认给 120 分钟（不依赖 CONFIG.gameRules.maxSimMinutes 的全局默认——那个
 * 依然是无上限，见该字段注释），--minutes 可以覆盖。
 *
 * ==================== 2026-09-21：并行榨干多核 ====================
 * 用户反馈"跑塔平衡时cpu占用很低"——原因是每一局（runOne）都是重 CPU 计算，
 * 但改动前是【单进程单核】一局接一局串行跑，其余核心全程闲置。现在把
 * "全部武器 × 全部局数"拆成一份扁平工作项列表（每项就是一局：{武器,种子}），
 * 按本机核数拆到多个子进程（重新 spawn 自己，带 --worker-items/--worker-out
 * 两个内部专用参数），并行跑完再合并——不是按"武器"分（8种武器可能远小于
 * 核数，会晾着大半CPU不用），是按"局"分，核数不管多高都能喂满。
 * 跟 tools/run_balance_soul.mjs 拆分档位到多进程是同一个思路，只是这里拆到
 * 局这一级，颗粒度更细。
 *
 * 用法：
 *   node tools/balance_tower.mjs                          # 8种塔武器全测，每档20局，单局上限120分钟
 *   node tools/balance_tower.mjs --runs 10 --minutes 90    # 更快摸底
 *   node tools/balance_tower.mjs --pick lightning,nova     # 只测这几种（逗号分隔，子串匹配）
 *   node tools/balance_tower.mjs --json out.json           # 落盘
 */
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const RUNS = parseInt(arg('runs', '20'), 10);
const minutesArg = arg('minutes', '120'); // 见上方头注：这个工具专属默认120，不动全局默认
const MAX_MIN = minutesArg != null ? parseFloat(minutesArg) : Infinity;
// 用户明确要求复用真实的召唤师峡谷，不要另造一张地图——见文件头注那次返工的说明。
const MAP_ID = 'summoners_rift_v1';
const PICK = arg('pick', '');
const JSON_OUT = arg('json', '');
// --worker-items/--worker-out：内部专用，orchestrator 拿自己 spawn 自己时才会传，
// 手动跑这个脚本不需要碰它们（见文件头注"并行榨干多核"）。
const WORKER_ITEMS = arg('worker-items', null);
const WORKER_OUT = arg('worker-out', null);

const fs = await import('fs');
const path = await import('path');
const { fileURLToPath } = await import('url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const { DragonSystem } = await import('../src/systems/DragonSystem.js');
const { equipSkill } = await import('../src/core/skillParams.js');
const { createFactories } = await import('../src/core/factories.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { WorldState } = await import('../src/systems/WorldState.js');
const { CONFIG } = await import('../src/data/Config.js');

const SIM_DT = 1 / 30;

// 8 种塔武器（见 src/core/skills/weapons.js 的 weapon_* 定义）——这是本工具
// 唯一要横向对照的维度。召唤师峡谷地图本身给不同档位塔配了不同默认武器
// （outer/inner=piercing、base/hq_tower=lightning），防守方这里全部覆写成
// 当前档位要测的那一种，不受地图默认值影响。
const WEAPONS = ['piercing', 'lightning', 'explosive', 'corrosion', 'barrage', 'nova', 'shepherd', 'prism'];
const WEAPON_LABEL = {
  piercing: '穿透型', lightning: '闪电杖', explosive: '爆破型', corrosion: '腐蚀型',
  barrage: '弹幕型', nova: '聚能炮', shepherd: '牧灵法阵', prism: '光棱',
};
// 只有这几档塔层级真正持有武器（nexus_lane/nexus_main 在召唤师峡谷上一律
// weapon:null，不攻击——跟地图文件本身的声明一致，不覆写这两档）。
const WEAPON_TOWER_TIERS = new Set(['outer', 'inner', 'base', 'hq_tower']);

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

/**
 * 换一座塔的武器：先卸旧的（跑 onUnequip，防止爆破型这类"装备时改了固定值、
 * 卸下要还原"的武器漏清理），再装新的。equipSkill 只会【新增】实例，不会自动
 * 顶掉已有的同类武器——这正是 src/ui/editor/events.js 的 _applyWeaponChanges
 * 换武器时的同一套两步走法，这里复用同一个形状，不是我自己发明的流程。
 */
function swapTowerWeapon(entity, weaponKey, ctx) {
  const oldInst = (entity._skillInstances || []).find(s => s.skillId.startsWith('weapon_'));
  if (oldInst) {
    const oldDef = SkillLibrary[oldInst.skillId];
    if (oldDef?.onUnequip) oldDef.onUnequip(entity.id, oldInst, ctx);
    entity._skillInstances = entity._skillInstances.filter(s => s !== oldInst);
  }
  if (weaponKey && weaponKey !== 'none') {
    equipSkill(entity, 'weapon_' + weaponKey, ctx, SkillLibrary);
  }
}

/**
 * 进攻方增益：装 passive_test_tower_attacker / passive_test_minion_attacker——
 * 这是 SkillLibrary 里真实存在的技能（见 src/core/skills/testScenarios.js
 * 头注：第一版把这套增益内联写在脚本里，只在这个脚本自己的内存模拟里存在，
 * 编辑器/游戏里看不到，是错的；跟龙魂的装法完全一致，equipSkill 装的是一条
 * "已经存在于游戏里"的技能，脚本自己不发明任何新机制）。进攻方的塔武器不再
 * 被改动（用户"删除强制替换闪电杖"），沿用召唤师峡谷自己声明的默认武器。
 * 防守方：只换武器（这一档要测的那种），不装任何增益技能——"防守方一切正常"。
 */
function applyRoleBuffs(entity, ctx, defenderWeapon) {
  const isAttacker = (entity._mapFaction || entity.faction) === CURRENT_ATTACKER;
  if (isAttacker) {
    equipSkill(entity, 'passive_test_tower_attacker', ctx, SkillLibrary);
  } else if (WEAPON_TOWER_TIERS.has(entity._mapTier)) {
    swapTowerWeapon(entity, defenderWeapon, ctx);
  }
}

function applyAttackerMinionBuff(entity, ctx) {
  if ((entity._mapFaction || entity.faction) !== CURRENT_ATTACKER) return;
  equipSkill(entity, 'passive_test_minion_attacker', ctx, SkillLibrary);
}

let CURRENT_ATTACKER = null; // 本局随机指派，runOne 开头设置

/** 跑一局，返回 { attackerWon, defenderWon, draw, minutes, defenderTowersLost, attackerTowersLost } */
function runOne(seed, defenderWeapon) {
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
  // 随机指派进攻方——用已经切到种子发生器的 Math.random，同一个 seed 每次跑结果一致。
  CURRENT_ATTACKER = Math.random() < 0.5 ? 'blue' : 'red';

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
  const waves = new LaneWaveSystem(ents, bus, mapSys);
  const world = new WorldState({ entities: ents, bus });
  world.forceEntropy(null);
  AttributeCalculator.setWorldState(world);

  const score = { blue: { kills: 0, towers: 0 }, red: { kills: 0, towers: 0 } };
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

  // combat 字段是必须的：passive_test_tower_attacker 的 onEquip 靠 ctx.combat?.skills
  // 拿到 SkillLibrary 去查旧武器的 onUnequip（与 weapons.js 里 atkmode_charge/
  // passive_pet_spirit_guard 的装配同一个既有取法，不是这里新发明的）。
  const skillCtx = { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat, waveNumber: 0 };

  mapSys.setCreateBuildingFn((opt) => {
    const e = F.createBuilding(opt);
    if (e) applyRoleBuffs(e, skillCtx, defenderWeapon);
    return e;
  });

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
    if (e) applyAttackerMinionBuff(e, skillCtx);
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

  const maxT = MAX_MIN * 60;
  let winnerFaction = null;
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
    facing.update(SIM_DT);
    combat.update(SIM_DT);
    proj.update(SIM_DT);
    buffs.update(SIM_DT);
    fx.update(SIM_DT);
    mapSys.update(SIM_DT);
    ents.purgeDead();

    if (frame % 30 === 0) {
      for (const fac of ['blue', 'red']) {
        const nexus = ents.getAllTowers(false).find(e => e._mapTier === 'nexus_main' && e._mapFaction === fac);
        if (nexus && !nexus.alive) { winnerFaction = fac === 'blue' ? 'red' : 'blue'; break; }
      }
      if (winnerFaction) { window.gameTime = t; break; }
    }
  }

  const defenderFaction = CURRENT_ATTACKER === 'blue' ? 'red' : 'blue';
  const TIER_RANK = { outer: 1, inner: 2, base: 3, hq_tower: 3, nexus_lane: 4, nexus_main: 5 };
  const towersLostBy = (victimFaction) => {
    let s = 0, frontHP = 1;
    for (const e of ents.getAllTowers(false)) {
      if (e._mapFaction !== victimFaction) continue;
      const rank = TIER_RANK[e._mapTier] || 0;
      if (!e.alive) { s = Math.max(s, rank); continue; }
      const hp = Math.max(0, e.currentHP) / Math.max(1, e.baseStats.maxHP);
      if (rank === s + 1 && hp < frontHP) frontHP = hp;
    }
    return +(s + (1 - frontHP)).toFixed(2);
  };

  const out = {
    winner: winnerFaction ? (winnerFaction === CURRENT_ATTACKER ? 'attacker' : 'defender') : 'draw',
    minutes: +(window.gameTime / 60).toFixed(1),
    defenderTowersLost: towersLostBy(defenderFaction),
    attackerTowersLost: towersLostBy(CURRENT_ATTACKER),
    attackerFaction: CURRENT_ATTACKER,
  };
  AttributeCalculator.setWorldState(null);
  Math.random = _realRandom;
  return out;
}

// ==================== worker 模式：只跑分给自己的那一批局，不打印任何汇总 ====================
// orchestrator（下面的默认流程）拿这份文件自己 spawn 自己，带上这两个参数就会
// 走这条分支：读工作项列表（每项 {weaponKey, seed}），逐个跑 runOne，整批结果
// 写成一个 JSON 数组到 --worker-out，然后直接退出——聚合/打印/落盘都是
// orchestrator 进程的事，worker 只管算。
if (WORKER_ITEMS && WORKER_OUT) {
  const items = JSON.parse(fs.readFileSync(WORKER_ITEMS, 'utf8'));
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const { weaponKey, seed } = items[i];
    out.push({ weaponKey, seed, ...runOne(seed, weaponKey) });
    process.stderr.write(`\r${i + 1}/${items.length}`);
  }
  fs.writeFileSync(WORKER_OUT, JSON.stringify(out));
  process.exit(0);
}

// ==================== 跑（orchestrator，默认走这条）====================
let weaponsToRun = WEAPONS;
if (PICK) {
  const keys = PICK.split(',').map(k => k.trim()).filter(Boolean);
  weaponsToRun = WEAPONS.filter(w => keys.some(k => w.includes(k)));
  if (!weaponsToRun.length) {
    console.log(`❌ --pick "${PICK}" 没匹配到任何塔武器。可用：\n  ` + WEAPONS.join('\n  '));
    process.exit(1);
  }
}

// 2026-09-21：自动落盘到 .balance/（跟 tools/run_balance_soul.mjs 同一个约定——
// 用户跑完龙魂/巨龙之力扫描后一直是直接把 .balance/ 下最新的 .log/.json 发过来，
// 这个工具也该有同样的体验，不用每次都记得手打 --json）。--json 仍然保留，
// 传了就【额外】再写一份到指定路径，两边不冲突。
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.balance');
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, `tower_sweep_${ts}.log`);
const jsonPath = path.join(outDir, `tower_sweep_${ts}.json`);

const logLines = [];
const log = (s = '') => { console.log(s); logLines.push(s); };

// ---- 拆分工作项：每个 {武器, 种子} 就是一局，拆到 min(核数, 总局数) 个子进程 ----
// 见文件头注"并行榨干多核"——按"局"拆而不是按"武器"拆，核数再多也能喂满。
const os = await import('os');
const { spawn } = await import('child_process');
const cpuCount = os.cpus().length || 4;

const workItems = [];
for (const w of weaponsToRun) for (let seed = 0; seed < RUNS; seed++) workItems.push({ weaponKey: w, seed });
const JOBS = Math.max(1, Math.min(cpuCount, workItems.length));
const buckets = Array.from({ length: JOBS }, () => []);
workItems.forEach((item, i) => buckets[i % JOBS].push(item));

const minLabel = Number.isFinite(MAX_MIN) ? `单局上限 ${MAX_MIN} 分钟` : '单局不设时长上限';
log(`防御塔强度横向对照：地图 ${MAP_ID}，每档 ${RUNS} 局，${minLabel}，${weaponsToRun.length} 种塔武器`);
log(`拆成 ${JOBS} 个并行进程（本机 ${cpuCount} 核，共 ${workItems.length} 局待跑）`);
log('（进攻方每局随机指派蓝/红，固定90%减伤+1000%增伤+小兵33%减伤，武器不改动；防守方按档位换武器，其余一切正常）\n');

// ---- 汇总进度：子进程把"这一批跑到第几局了"写去 stderr，父进程累加成总进度 ----
// 进度条走 stderr（不是 stdout）：sim_towerbalance.mjs 的可复现性测试会逐字比对
// 整段 stdout，进度条自带耗时/百分比这类每次跑都不同的内容，混进 stdout 会把
// "同参数复现"误判成"不一致"——跟 balance_matrix.mjs 原来那条 `\r i/RUNS`
// 进度走 stderr 是同一个理由，不是这次心血来潮。
const jobDone = new Array(JOBS).fill(0);
const totalItems = workItems.length;
function totalDone() { return jobDone.reduce((a, b) => a + b, 0); }
function onProgressChunk(idx, chunk) {
  const seg = chunk.split('\r').filter(Boolean).pop();
  if (!seg) return;
  const m = seg.match(/(\d+)\/(\d+)/);
  if (m) jobDone[idx] = parseInt(m[1], 10);
}
const tickerStarted = Date.now();
const ticker = setInterval(() => {
  const done = totalDone();
  const elapsed = (Date.now() - tickerStarted) / 1000;
  const rate = done > 0 ? elapsed / done : 0;
  const remain = done > 0 ? Math.max(0, (totalItems - done) * rate) : NaN;
  const etaStr = Number.isFinite(remain)
    ? (remain > 90 ? `约 ${(remain / 60).toFixed(1)} 分钟` : `约 ${Math.round(remain)} 秒`)
    : '估算中…';
  process.stderr.write(`\r总进度：${done}/${totalItems} 局，已耗时 ${(elapsed / 60).toFixed(1)} 分钟，预计剩余 ${etaStr}   `);
}, 3000);

function runWorker(idx, items) {
  return new Promise((resolve) => {
    const itemsFile = path.join(outDir, `.tower_items_${ts}_${idx}.json`);
    const outFile = path.join(outDir, `.tower_out_${ts}_${idx}.json`);
    fs.writeFileSync(itemsFile, JSON.stringify(items));
    const scriptPath = fileURLToPath(import.meta.url);
    const cliArgs = [scriptPath, '--worker-items', itemsFile, '--worker-out', outFile,
      ...(Number.isFinite(MAX_MIN) ? ['--minutes', String(MAX_MIN)] : [])];
    const child = spawn(process.execPath, cliArgs, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => onProgressChunk(idx, d.toString()));
    child.on('close', (code) => resolve({ idx, code, itemsFile, outFile }));
  });
}

const t0 = Date.now();
const jobResults = await Promise.all(buckets.map((b, i) => runWorker(i, b)));
clearInterval(ticker);
process.stderr.write(`\r总进度：${totalItems}/${totalItems} 局，全部完成` + ' '.repeat(30) + '\n');

// ---- 合并：按武器分组，每组按种子排序 ----
// 排序是可复现性的关键：并行完成的先后顺序本身不确定（哪个子进程先跑完取决于
// 机器当下的调度，不是种子决定的），如果直接按"谁先回来"的顺序拼 rows，同一组
// 参数两次运行会拼出不同顺序的 rows 数组，序列化成 JSON/汇总统计虽然平均值一样
// 但明细顺序不同——sim_towerbalance.mjs 的可复现性测试比对的是完整 stdout
// 文本，顺序一变就判不一致了。按 seed 排序把它拉回跟旧的串行版本逐位一致的序。
const rowsByWeapon = new Map();
for (const jr of jobResults) {
  if (jr.code !== 0) {
    log(`⚠️ 子进程${jr.idx + 1}异常退出（退出码${jr.code}），它负责的那批局可能缺失。`);
  }
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(jr.outFile, 'utf8'));
  } catch (e) {
    log(`⚠️ 读取子进程${jr.idx + 1}的结果失败：${e.message}`);
  }
  try { fs.unlinkSync(jr.itemsFile); } catch { /* 临时文件，读不到也无所谓 */ }
  try { fs.unlinkSync(jr.outFile); } catch { /* 同上 */ }
  for (const it of items) {
    if (!rowsByWeapon.has(it.weaponKey)) rowsByWeapon.set(it.weaponKey, []);
    rowsByWeapon.get(it.weaponKey).push(it);
  }
}

const results = [];
for (const w of weaponsToRun) {
  const rows = (rowsByWeapon.get(w) || [])
    .sort((a, b) => a.seed - b.seed)
    .map(({ weaponKey, seed, ...rest }) => rest); // 剥掉合并用的辅助字段，形状跟旧版 runOne() 输出逐位一致
  const label = `防守方=${WEAPON_LABEL[w] || w}`;
  const avg = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
  const attackerWins = rows.filter(r => r.winner === 'attacker').length;
  const defenderWins = rows.filter(r => r.winner === 'defender').length;
  const draws = rows.filter(r => r.winner === 'draw').length;
  const r = {
    weaponKey: w, label, runs: rows.length,
    attackerWins, defenderWins, draws,
    defenderWinRate: +(defenderWins / rows.length * 100).toFixed(1),
    avgSurviveMin: avg(r2 => r2.minutes),
    avgDefenderTowersLost: avg(r2 => r2.defenderTowersLost),
    avgAttackerTowersLost: avg(r2 => r2.attackerTowersLost),
    rows,
  };
  results.push(r);
  log(
    `${r.label.padEnd(16)} 防守方存活均时长 ${String(r.avgSurviveMin).padStart(6)} 分` +
    `  防守方平均丢塔档位 ${String(r.avgDefenderTowersLost).padStart(5)}` +
    `  防守方胜 ${r.defenderWins}/${r.runs}（${r.defenderWinRate}%）  平 ${r.draws}`
  );
}
log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（并行墙钟时间，不是累加）`);

if (results.length > 1) {
  const mins = results.map(r => r.avgSurviveMin);
  const lost = results.map(r => r.avgDefenderTowersLost);
  const best = results.reduce((a, b) => (b.avgSurviveMin > a.avgSurviveMin ? b : a));
  const worst = results.reduce((a, b) => (b.avgSurviveMin < a.avgSurviveMin ? b : a));
  log(`存活均时长区间 ${Math.min(...mins)} ~ ${Math.max(...mins)} 分`);
  log(`丢塔档位区间 ${Math.min(...lost)} ~ ${Math.max(...lost)}`);
  log(`最扛揍：${best.label}（${best.avgSurviveMin}分）　最不扛揍：${worst.label}（${worst.avgSurviveMin}分）`);
}
log(
  '\n判读提示：\n' +
  '  · 进攻方被人为拉到近乎打不死，"胜负"在这里几乎必然一边倒，不是有效信号——\n' +
  '    真正要看的是【存活均时长】【平均丢塔档位】：数值越大越扛揍，武器强度按这个排序。\n' +
  '  · 防守方胜率不是0%的那几档，说明这种武器强到能顶穿被拉满的进攻方，是个强烈信号，\n' +
  '    值得单独复核（--pick 那个武器名 --runs 40 再跑一遍确认不是运气）。\n' +
  '  · 丢塔档位 = 外塔1/内塔2/高地塔3/召唤水晶4/枢纽5 + 最前线那座的掉血比例，是连续量，\n' +
  '    比单看"赢/输"更能看出"差多少"。'
);

const payload = { runs: RUNS, maxMin: Number.isFinite(MAX_MIN) ? MAX_MIN : 'unlimited', map: MAP_ID, results };
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
fs.writeFileSync(logPath, logLines.join('\n') + '\n');
console.log(`\n📄 结果已落盘：`);
console.log(`  日志：${logPath}`);
console.log(`  数据：${jsonPath}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2));
  console.log(`  另存：${JSON_OUT}`);
}
