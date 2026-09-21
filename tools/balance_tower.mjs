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
 * ==================== 第一版返工记录（如实记录）====================
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
 * 进攻方被人为拉到近乎打不死、且输出被放大到 11 倍（1+1000%）的极端强度，
 * 用统一同一把"锤子"（闪电杖）敲，这样【谁是进攻方的武器强度】这个变量被
 * 焊死了，场上唯一还在变的就是【防守方这一档用哪种塔武器】——量出来的差异
 * 才能干净地归因到"这种塔武器扛揍/续航能力强不强"，不会被"进攻方武器碰巧
 * 也很强"这个混杂因素污染。
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
 * "已经存在于游戏里"的技能，脚本自己不发明任何新机制）。塔武器换成闪电杖
 * 由这条技能自己的 onEquip 处理（同时会跳过 nexus_lane/nexus_main）。
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

/** 跑一档（一种防守方塔武器） */
function runCell(weaponKey) {
  const label = `防守方=${WEAPON_LABEL[weaponKey] || weaponKey}`;
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`\r  ${label} … ${i + 1}/${RUNS}`);
    rows.push(runOne(i, weaponKey));
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  const avg = (f) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
  const attackerWins = rows.filter(r => r.winner === 'attacker').length;
  const defenderWins = rows.filter(r => r.winner === 'defender').length;
  const draws = rows.filter(r => r.winner === 'draw').length;
  return {
    weaponKey, label, runs: rows.length,
    attackerWins, defenderWins, draws,
    defenderWinRate: +(defenderWins / rows.length * 100).toFixed(1),
    avgSurviveMin: avg(r => r.minutes),
    avgDefenderTowersLost: avg(r => r.defenderTowersLost),
    avgAttackerTowersLost: avg(r => r.attackerTowersLost),
    rows,
  };
}

// ==================== 跑 ====================
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
const fs = await import('fs');
const path = await import('path');
const { fileURLToPath } = await import('url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, '.balance');
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, `tower_sweep_${ts}.log`);
const jsonPath = path.join(outDir, `tower_sweep_${ts}.json`);

const logLines = [];
const log = (s = '') => { console.log(s); logLines.push(s); };

const minLabel = Number.isFinite(MAX_MIN) ? `单局上限 ${MAX_MIN} 分钟` : '单局不设时长上限';
log(`防御塔强度横向对照：地图 ${MAP_ID}，每档 ${RUNS} 局，${minLabel}，${weaponsToRun.length} 种塔武器`);
log('（进攻方每局随机指派蓝/红，固定90%减伤+1000%增伤+闪电杖+小兵33%减伤；防守方按档位换武器，其余一切正常）\n');

const t0 = Date.now();
const results = [];
for (const w of weaponsToRun) {
  const r = runCell(w);
  results.push(r);
  log(
    `${r.label.padEnd(16)} 防守方存活均时长 ${String(r.avgSurviveMin).padStart(6)} 分` +
    `  防守方平均丢塔档位 ${String(r.avgDefenderTowersLost).padStart(5)}` +
    `  防守方胜 ${r.defenderWins}/${r.runs}（${r.defenderWinRate}%）  平 ${r.draws}`
  );
}
log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

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
