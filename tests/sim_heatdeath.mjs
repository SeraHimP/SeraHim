/**
 * sim_heatdeath.mjs —— 热寂终局机制验收（目前仅 summoners_rift_v1）
 *
 * 起因：用户跑龙魂平衡（tools/run_balance_soul.mjs 默认不传 --minutes）挂了超过
 * 24 小时依旧卡住——两边打成真正的对称僵局时，tools/balance_matrix.mjs 的主循环
 * 没有任何退出条件，真的会无限跑下去。用户定稿的解法是在游戏本身加一条终局
 * 机制：拖到 CONFIG.tuning.heatDeath.triggerAtMin 分钟还没结束，地图自己把自己
 * 终结掉，详细设计背景见 src/data/Config.js 里 CONFIG.tuning.heatDeath 的头注和
 * src/data/maps/summoners_rift.js 的 globalAura 头注。
 *
 * 覆盖：
 *   ① AuraValueResolver.js 新增的 percentPerMinute 模式（纯函数）。
 *   ② MapSystem._applyGlobalAura 新增的 appliesTo/excludesTypes/scaleByOwnMaxHP
 *      三个字段（用最小自定义地图隔离测试，不依赖召唤师峡谷的真实数值，断言精确）。
 *      顺带钉住修过的一个真实 bug：同一条 aura 里两条效果撞了同一个 statKey
 *      （常驻移速环 + 热寂移速加成都是 statKey:'moveSpeed'）曾经会互相顶替，
 *      只剩后应用的那条生效——现在靠 it.name 覆写分开去重键，两条应该同时生效。
 *   ③ 召唤师峡谷真实地图声明：触发前后的数值确实来自 CONFIG.tuning.heatDeath，
 *      不是测试自己算出来的另一套数字。
 *   ④ 端到端：结构保护应免疫热寂衰减（用户定稿"被保护的后排塔不会立刻掉血"）——
 *      未受保护的塔在触发后真的会掉血，受保护的塔不会，靠真实 CombatSystem.update()
 *      跑出来验证，不只是看 stats 快照。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { resolveAuraEffectValue } = await import('../src/systems/AuraValueResolver.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

const { T, done } = scoreboard('热寂终局机制验收');

// ==================== ① percentPerMinute：新增的百分比渐进模式 ====================
{
  T('①-0分钟时百分比渐进为0', resolveAuraEffectValue({ percentPerMinute: 0.5 }, { gameTime: 0 }).percent === 0);
  T('①b-10分钟时线性涨到5%', resolveAuraEffectValue({ percentPerMinute: 0.5 }, { gameTime: 600 }).percent === 5);
  T('①c-100分钟时涨到50%（默认不封顶）', resolveAuraEffectValue({ percentPerMinute: 0.5 }, { gameTime: 6000 }).percent === 50);
  T('①d-有 max 时会封顶', resolveAuraEffectValue({ percentPerMinute: 0.5, max: 10 }, { gameTime: 999999 }).percent === 10);
  T('①e-percentPerMinute 模式下 flat 走 effect.flat（默认0），不受 percent 渐进影响',
    resolveAuraEffectValue({ percentPerMinute: 0.5, flat: 3 }, { gameTime: 600 }).flat === 3);
}

// ==================== ② appliesTo/excludesTypes/scaleByOwnMaxHP（最小自定义地图隔离测试）====================
{
  const { ents, fx, attr } = await makeWorld();
  fx.setStatSource(ents, attr);
  const bus = new EventBus();
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(fx);

  const testMap = {
    id: 'test_heatdeath_filters',
    globalAura: {
      name: '测试光环', icon: '🧪',
      effects: [
        // 只对塔生效，scaleByOwnMaxHP：flat 是"目标自身maxHP的百分比/秒"
        { name: '掉血', statKey: 'healthRegen', appliesTo: ['tower'], scaleByOwnMaxHP: true, flat: -2 },
        // 只对非塔生效
        { name: '加速buff', statKey: 'bonusAttackSpeedPct', excludesTypes: ['tower'], flat: 30 },
        // 两条都是 moveSpeed，但 name 不同——验证不会互相顶替（本轮修的那个 bug）
        { name: '常驻加速', statKey: 'moveSpeed', percentPerMinute: 1 },
        { name: '额外加速', statKey: 'moveSpeed', flat: 0, percent: 20 },
      ],
    },
  };
  CONFIG.customMaps = CONFIG.customMaps || {};
  CONFIG.customMaps[testMap.id] = testMap;
  ms.loadMap(testMap.id);

  const tower = mkEntity(ents, 'tower', { stats: { maxHP: 1000, healthRegen: 0, moveSpeed: 0 } }, CONFIG);
  const minion = mkEntity(ents, 'melee', { stats: { maxHP: 500, bonusAttackSpeedPct: 0, moveSpeed: 300 } }, CONFIG);

  window.gameTime = 600; // 10分钟：常驻加速这条 percentPerMinute:1 应该涨到 10%
  ms.update(1);
  const sTower = attr.calc(tower, fx.getEffects(tower.id));
  const sMinion = attr.calc(minion, fx.getEffects(minion.id));

  T('②-appliesTo:只对塔生效——塔拿到了掉血效果', sTower.healthRegen < 0);
  T('②b-scaleByOwnMaxHP：塔的 healthRegen ≈ -2%×自身maxHP（1000×-2%=-20）',
    Math.abs(sTower.healthRegen - (-20)) < 1e-6);
  T('②c-appliesTo:只对塔生效——非塔单位没有这条掉血效果', sMinion.healthRegen === undefined || sMinion.healthRegen === 0);
  T('②d-excludesTypes:非塔单位拿到了加速buff（+30）', sMinion.bonusAttackSpeedPct === 30);
  T('②e-excludesTypes:塔没有拿到加速buff（不在"非塔"范围内）', !sTower.bonusAttackSpeedPct);
  T('②f-两条 statKey 相同（moveSpeed）但 name 不同的效果同时生效，不互相顶替：'
    + '300×(1+(10+20)/100)=390', Math.abs(sMinion.moveSpeed - 390) < 1e-6);
}

// ==================== ③ 召唤师峡谷真实地图声明：数值确实来自 CONFIG，不是另算的 ====================
{
  const aura = MAPS.summoners_rift_v1.globalAura;
  T('③-召唤师峡谷已声明 globalAura', !!aura && Array.isArray(aura.effects) && aura.effects.length === 5);
  const drainEff = aura.effects.find(e => e.statKey === 'healthRegen');
  T('③b-塔掉血效果只对塔生效', JSON.stringify(drainEff.appliesTo) === JSON.stringify(['tower']));
  T('③c-塔掉血数值来自 CONFIG.tuning.heatDeath.towerDrainPctPerSec，不是硬编码的另一份',
    drainEff.stages[1].flat === -CONFIG.tuning.heatDeath.towerDrainPctPerSec);
  T('③d-触发阈值来自 CONFIG.tuning.heatDeath.triggerAtMin（70分钟）',
    drainEff.stages[1].whenArg === CONFIG.tuning.heatDeath.triggerAtMin * 60);
  const asEff = aura.effects.find(e => e.statKey === 'bonusAttackSpeedPct');
  const dmgEff = aura.effects.find(e => e.statKey === 'damageAmpPct');
  const msEffs = aura.effects.filter(e => e.statKey === 'moveSpeed');
  T('③e-非塔攻速加成数值来自 CONFIG', asEff.stages[1].flat === CONFIG.tuning.heatDeath.unitAtkSpeedBonusPct);
  T('③f-非塔伤害增幅数值来自 CONFIG', dmgEff.stages[1].flat === CONFIG.tuning.heatDeath.unitDmgAmpBonusPct);
  T('③g-两条 moveSpeed 效果（常驻环 + 热寂加成）都存在，name 不同', msEffs.length === 2 && msEffs[0].name !== msEffs[1].name);
  const rampEff = msEffs.find(e => e.percentPerMinute != null);
  T('③h-常驻移速环无上限（用户定稿"无上限"，不应该有 max 字段）', rampEff.max === undefined);
  T('③i-常驻移速环速率来自 CONFIG.tuning.summonersRiftMoveSpeedPctPerMin',
    rampEff.percentPerMinute === CONFIG.tuning.summonersRiftMoveSpeedPctPerMin);
  const heatMsEff = msEffs.find(e => e.stages);
  T('③j-热寂移速加成数值来自 CONFIG', heatMsEff.stages[1].percent === CONFIG.tuning.heatDeath.unitMoveSpeedBonusPct);
}

// ==================== ④ 端到端：结构保护免疫热寂衰减 ====================
{
  const { ents, fx, attr } = await makeWorld();
  fx.setStatSource(ents, attr);
  const bus = new EventBus();
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(fx);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);

  ms.loadMap('summoners_rift_v1');

  // 同一路：outer（未受保护，最前排本来就没有保护者）+ base（水晶塔，outer 存活时受保护）。
  const outer = mkEntity(ents, 'tower', { faction: 'blue', tier: 'outer', lane: 'mid', stats: { maxHP: 3000 } }, CONFIG);
  const base = mkEntity(ents, 'tower', { faction: 'blue', tier: 'base', lane: 'mid', stats: { maxHP: 3000 } }, CONFIG);

  const triggerSec = CONFIG.tuning.heatDeath.triggerAtMin * 60;

  // 触发前：跑几帧，血量不该有任何变化。
  window.gameTime = triggerSec - 10;
  attr.tick(); ms.update(1);
  for (let i = 0; i < 5; i++) combat.update(1);
  T('④-触发前：未受保护的外塔血量不变', outer.currentHP === outer.baseStats.maxHP);
  T('④b-触发前：受保护的水晶塔血量不变', base.currentHP === base.baseStats.maxHP);

  // 触发后：外塔（未受保护）应该真的开始掉血；水晶塔（外塔仍存活、受保护）应该血量不变。
  window.gameTime = triggerSec + 1;
  attr.tick(); ms.update(1);
  for (let i = 0; i < 5; i++) combat.update(1);
  T('④c-触发后：未受保护的外塔血量下降了', outer.currentHP < outer.baseStats.maxHP);
  T('④d-触发后：外塔仍存活时，受保护的水晶塔血量【不变】（用户定稿：被保护的后排塔不会立刻掉血）',
    base.currentHP === base.baseStats.maxHP);

  // 外塔倒了之后，水晶塔曝光，也应该开始掉血（前置层级熔穿曝光后链式生效）。
  outer.alive = false;
  ents.markDirty();
  for (let i = 0; i < 5; i++) combat.update(1);
  T('④e-外塔倒了、水晶塔曝光后：也开始掉血了（链式曝光，不是永久免疫）',
    base.currentHP < base.baseStats.maxHP);
}

done();
