// Q9：三级兵种（近战 / 远程 / 炮兵）+ 全兵种技能精简。
// 用户："一个兵种有三个不同等级……跟随战场形势的变化来改变某一方出兵的等级……前15分钟出的是一级兵，
// 15分钟后出的是二级兵，在某一方某一路的水晶塔被摧毁后，这方的这条路出的就是三级兵或者是在30分钟之后全图
// 就都出三级兵了"；追问定稿："这方"= 被拆塔的一方；兵种草案"直接做"；"所有兵种的各种技能都进行优化和简化，
// 删除一堆乱七八糟的，只保留兵种特色"。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { createSimulation } = await import('../src/simulation.js');
const { resolveTierType, tierLineOf, tierLevelFor } = await import('../src/systems/unitTiers.js');
const { DEFAULT_MINION_PASSIVES } = await import('../src/core/defaultMinionPassives.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { minionRenderType } = await import('../src/presentation/SpriteFactory.js');
const { T, done } = scoreboard('三级兵种');

const U = CONFIG.unitTiers;
T('①规则软编码（15 分钟二级 / 30 分钟三级 / 被拆水晶塔的一方该路三级）', U.tier2AtMin === 15 && U.tier3AtMin === 30 && U.tier3OnOwnBaseTowerLost === true);
const names = Object.values(U.lines).flat().map((t) => CONFIG.templates[t]?.label);
T(`②三条兵种线 9 个兵都有模板（${names.join(' ')}）`, names.length === 9 && names.every(Boolean));
for (const [line, list] of Object.entries(U.lines)) {
  const hp = list.map((t) => CONFIG.templates[t].maxHP);
  T(`③${line} 线一级比一级强（生命 ${hp.join(' < ')}）`, hp[0] < hp[1] && hp[1] < hp[2]);
}
T('④每级最多 1 个技能', Object.values(U.lines).flat().every((t) => (DEFAULT_MINION_PASSIVES[t] || []).length <= 1));
T('⑤三级兵的技能各不相同（同一线内不重复）', Object.values(U.lines).every((list) => {
  const ks = list.flatMap((t) => DEFAULT_MINION_PASSIVES[t] || []); return new Set(ks).size === ks.length;
}));
T('⑥其余兵种精简到 1 个特色技能（术士兵按 Q4 定稿 2 个、唤灵兵的灵契是唤灵配套、攻城车四格是同一套机制）',
  ['super', 'totem', 'corrupt', 'heavy', 'healer', 'engineer'].every((t) => (DEFAULT_MINION_PASSIVES[t] || []).length === 1));
T('⑦新技能都在技能库里', ['passive_tier_shield_guard', 'passive_tier_charge', 'passive_tier_volley', 'passive_tier_pierce_bolt'].every((k) => SkillLibrary[k]));

// 等级判定
const sim = createSimulation(); sim.mapSystem.loadMap('summoners_rift_v1');
const ec = sim.entityContainer;
T('⑧0~15 分钟一级', resolveTierType('melee', 'blue', 'mid', 14 * 60, ec) === 'melee');
T('⑨15 分钟起二级', resolveTierType('ranged', 'blue', 'mid', 15 * 60, ec) === 'ranged_t2');
T('⑩30 分钟起全图三级', resolveTierType('siege', 'red', 'top', 30 * 60, ec) === 'siege_t3');
T('⑪不在兵种线里的兵不升级', resolveTierType('super', 'blue', 'mid', 40 * 60, ec) === 'super');
const baseT = ec.getAll(false).find((e) => e._mapTier === 'base' && e._mapFaction === 'blue' && e._laneId === 'bot');
if (baseT) { baseT.currentHP = 0; baseT.alive = false; sim.eventBus.emit('entity:death', { entityId: baseT.id }); }
T('⑫蓝方下路水晶塔被拆 → 蓝方下路 5 分钟就出三级', !!baseT && tierLevelFor('blue', 'bot', 5 * 60, ec) === 3);
T('⑬拆塔的红方不受影响、蓝方其它路也不受影响', tierLevelFor('red', 'bot', 5 * 60, ec) === 1 && tierLevelFor('blue', 'mid', 5 * 60, ec) === 1);
T('⑭渲染先沿用所属兵种线的造型', minionRenderType({ type: 'melee_t3' }) === 'melee' && tierLineOf('ranged_t2') === 'ranged');

// 出兵真跑：把时钟拨到 16 分钟，下一波就是二级兵
{
  const s2 = createSimulation(); s2.mapSystem.loadMap('summoners_rift_v1');
  window.gameTime = 16 * 60;
  s2.laneWaveSystem.spawnWave();
  for (let i = 0; i < 60 * 6; i++) { window.gameTime = 16 * 60 + i / 60; s2.laneWaveSystem.update?.(1 / 60); }
  const types = new Set(s2.entityContainer.getAllMinions(true).map((m) => m.type));
  T(`⑮16 分钟的一波出的是二级兵（${[...types].join(',')}）`, types.has('melee_t2') && types.has('ranged_t2') && !types.has('melee'));
  window.gameTime = 0;
}

// 技能行为
function arena(atkType, defType, dist = 60) {
  const s = createSimulation(); s.mapSystem.loadMap('summoners_rift_v1');
  const W = s.mapSystem.currentMap.world, cx = W.w / 2, cy = W.h / 2;
  const a = s.factories.createMinion(atkType, cx, cy, 1, 1, { faction: 'blue', laneId: 'mid', direction: 'forward' });
  const d = s.factories.createMinion(defType, cx + dist, cy, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
  for (const u of [a, d]) u.baseStats.moveSpeed = 0;
  d.baseStats.maxHP = d.currentHP = 1e6; d.baseStats.attackDamage = 0; d.baseStats.abilityPower = 0;
  return { s, a, d };
}
const drain = (s) => { for (let i = 0; i < 120; i++) s.projectileSystem.update(1 / 60); };
{
  // 盾卫：同一发弹道，盾卫比矛卒少吃 shieldGuardPct
  const r1 = arena('ranged', 'melee', 120), r2 = arena('ranged', 'melee_t2', 120);
  for (const r of [r1, r2]) { r.d.baseStats.armor = r.d.baseStats.magicResist = 0; r.s.attrCalc.tick(); r.s.combatSystem.performAttack(r.a, r.d); drain(r.s); }
  const l1 = 1e6 - r1.d.currentHP, l2 = 1e6 - r2.d.currentHP;
  T(`⑯盾卫举盾：弹道伤害 -${U.skills.shieldGuardPct}%（${l1.toFixed(2)} → ${l2.toFixed(2)}）`, l1 > 0 && Math.abs(l2 / l1 - (1 - U.skills.shieldGuardPct / 100)) < 0.02);
}
{
  // 长弓手：第 N 箭伤害翻倍
  const { s, a, d } = arena('ranged_t2', 'melee', 120);
  d.baseStats.armor = d.baseStats.magicResist = 0;
  const hits = [];
  for (let i = 0; i < U.skills.volleyEvery; i++) { s.attrCalc.tick(); const h = d.currentHP; s.combatSystem.performAttack(a, d); drain(s); hits.push(h - d.currentHP); }
  T(`⑰长弓手强弓：第 ${U.skills.volleyEvery} 箭是普通箭的 ${(hits[hits.length - 1] / hits[0]).toFixed(2)} 倍`,
    Math.abs(hits[hits.length - 1] / hits[0] - (1 + U.skills.volleyBonusPct / 100)) < 0.05);
}
{
  // 弩炮手：主目标身后的敌人也挨打，侧面的不挨
  const { s, a, d } = arena('ranged_t3', 'melee', 120);
  const W = s.mapSystem.currentMap.world;
  const behind = s.factories.createMinion('melee', d.pos.x + 60, d.pos.y, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
  const aside = s.factories.createMinion('melee', d.pos.x, d.pos.y + 80, 1, 1, { faction: 'red', laneId: 'mid', direction: 'reverse' });
  for (const u of [behind, aside]) { u.baseStats.moveSpeed = 0; u.baseStats.maxHP = u.currentHP = 1e6; }
  s.attrCalc.tick(); s.combatSystem.performAttack(a, d); drain(s);
  T('⑱弩炮手贯穿：身后直线上的敌人挨打、侧面的不挨', behind.currentHP < 1e6 && aside.currentHP === 1e6 && d.currentHP < 1e6);
}
{
  // 重骑：对新目标的第一击击退，第二击不再推
  const { s, a, d } = arena('melee_t3', 'melee', 25);
  s.attrCalc.tick(); const x0 = d.pos.x; s.combatSystem.performAttack(a, d);
  const x1 = d.pos.x; s.attrCalc.tick(); s.combatSystem.performAttack(a, d);
  T(`⑲重骑冲锋：第一击把目标击退（${(x1 - x0).toFixed(1)}），第二击不再推（${(d.pos.x - x1).toFixed(1)}）`, x1 - x0 > 20 && Math.abs(d.pos.x - x1) < 1e-6);
}
done();
