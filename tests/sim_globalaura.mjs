/**
 * sim_globalaura.mjs —— 地图光环三种数值模式验收（2026-09-04 第五节）
 *
 * 见 src/systems/AuraValueResolver.js 头注（三种模式的力学定义、为什么"分阶段"
 * 用事件触发换挡、ctx 的诚实限制）与 src/data/mapEditorCore.js"地图光环"节头注
 * （编辑器纯函数）。用户原话："状态可以设置固定增加某个值/逐渐增加到某个值/
 * 分阶段设置值"，追问"分阶段"具体力学时用户选了"事件触发换挡（推荐）"——
 * 复用出兵编排已有的 WAVE_CONDITIONS 条件系统判定换挡时机。
 *
 * 覆盖：① resolveAuraEffectValue 三种模式的纯函数行为（含固定/渐进两种改动前
 *      就有的模式必须逐位不变）；② mapEditorCore.js 的光环编辑纯函数（克隆/
 *      改字段/增删效果/切模式/增删阶段）；③ 端到端：真实 MapSystem 在不同
 *      gameTime 下正确应用固定/渐进/分阶段三种效果到场上单位。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { resolveAuraEffectValue } = await import('../src/systems/AuraValueResolver.js');
const {
  cloneGlobalAuraForEdit, withAuraFieldSet, withAuraEffectAdded, withAuraEffectRemoved,
  withAuraEffectFieldSet, withAuraEffectModeSet, withAuraStageAdded, withAuraStageRemoved, withAuraStageFieldSet,
  cloneMapForEdit,
} = await import('../src/data/mapEditorCore.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('地图光环三种数值模式验收');

// ==================== ① resolveAuraEffectValue：三种模式的纯函数行为 ====================
{
  // 固定值（改动前就有）：flat/percent 原样返回，跟 gameTime 无关。
  T('①-固定值模式：flat 原样返回', resolveAuraEffectValue({ flat: 18 }, { gameTime: 0 }).flat === 18);
  T('①b-固定值模式：percent 原样返回', resolveAuraEffectValue({ flat: 0, percent: 25 }, { gameTime: 9999 }).percent === 25);
  T('①c-固定值模式：不传 ctx 也不报错（flat 缺省为0）', resolveAuraEffectValue({}, {}).flat === 0);

  // 渐进到目标值（改动前就有）：perMinute × 分钟数，到 max 封顶，两位小数。
  T('②-渐进模式：0分钟时为0', resolveAuraEffectValue({ perMinute: 0.5, max: 15 }, { gameTime: 0 }).flat === 0);
  T('②b-渐进模式：10分钟时线性增长到5', resolveAuraEffectValue({ perMinute: 0.5, max: 15 }, { gameTime: 600 }).flat === 5);
  T('②c-渐进模式：超过封顶时间也不会超过 max', resolveAuraEffectValue({ perMinute: 0.5, max: 15 }, { gameTime: 999999 }).flat === 15);
  T('②d-渐进模式：没有 max 时不封顶', resolveAuraEffectValue({ perMinute: 1 }, { gameTime: 6000 }).flat === 100);

  // 分阶段（新增）：按数组顺序判 whenPasses，最后一个满足条件的阶段生效。
  const stages = [
    { when: '', flat: 0 },
    { when: 'time.after', whenArg: 600, flat: 10 },
    { when: 'time.after', whenArg: 1200, flat: 20 },
  ];
  T('③-分阶段：游戏刚开始（0秒）落在兜底阶段（0）', resolveAuraEffectValue({ stages }, { gameTime: 0 }).flat === 0);
  T('③b-分阶段：过了第一个阈值（700秒）切到10（第一阶段的 time.after 600 依然满足，但排在后面的判据没通过，所以停在10）',
    resolveAuraEffectValue({ stages }, { gameTime: 700 }).flat === 10);
  T('③c-分阶段：过了第二个阈值（1300秒）切到20（两个 time.after 条件都满足，取最后一个满足的）',
    resolveAuraEffectValue({ stages }, { gameTime: 1300 }).flat === 20);
  T('③d-分阶段：没有兜底阶段、条件都不满足时退回 flat:0（不报错，只是不生效）',
    resolveAuraEffectValue({ stages: [{ when: 'time.after', whenArg: 600, flat: 10 }] }, { gameTime: 0 }).flat === 0);
  T('③e-分阶段：percent 字段同样按阶段切换', resolveAuraEffectValue({
    stages: [{ when: '', percent: 0 }, { when: 'time.after', whenArg: 600, percent: 25 }],
  }, { gameTime: 700 }).percent === 25);
  T('③f-分阶段：stages 存在但为空数组时退回 flat:0（编辑器不该允许存出这种配置，但解析层自己也要扛住）',
    resolveAuraEffectValue({ stages: [] }, { gameTime: 700 }).flat === 0);
}

// ==================== ② mapEditorCore.js：地图光环编辑纯函数 ====================
{
  let aura = cloneGlobalAuraForEdit({});
  T('④-没有 globalAura 的地图克隆出一个空壳（不是 null/undefined）',
    aura && aura.name === '' && aura.icon === '🌐' && Array.isArray(aura.effects) && aura.effects.length === 0);

  const sr = MAPS.summoners_rift_v1;
  const auraFromReal = cloneGlobalAuraForEdit({ globalAura: { name: 'x', icon: '❄️', effects: [{ statKey: 'a', flat: 1 }] } });
  T('④b-有 globalAura 的地图深拷贝原值', auraFromReal.name === 'x' && auraFromReal.effects[0].statKey === 'a');
  const probe = { globalAura: { name: 'x', effects: [{ flat: 1 }] } };
  const cloned = cloneGlobalAuraForEdit(probe);
  cloned.effects[0].flat = 999;
  T('④c-是深拷贝，改草稿不影响原地图', probe.globalAura.effects[0].flat === 1);
  void sr;

  aura = withAuraFieldSet(aura, 'name', '测试光环');
  aura = withAuraFieldSet(aura, 'icon', '🔥');
  T('⑤-withAuraFieldSet 改名称/图标', aura.name === '测试光环' && aura.icon === '🔥');

  aura = withAuraEffectAdded(aura, { statKey: 'attackDamage', label: '攻击力', flat: 5 });
  T('⑥-withAuraEffectAdded 新增一条效果', aura.effects.length === 1 && aura.effects[0].statKey === 'attackDamage');

  aura = withAuraEffectFieldSet(aura, 0, 'flat', 10);
  T('⑦-withAuraEffectFieldSet 改效果字段', aura.effects[0].flat === 10);

  const beforeMode = aura;
  aura = withAuraEffectModeSet(aura, 0, 'gradual');
  T('⑧-withAuraEffectModeSet 切到渐进模式：清掉了 flat，换上 perMinute',
    aura.effects[0].perMinute === 0 && !('flat' in aura.effects[0]));
  T('⑧b-切模式保留了 statKey/label（不是整条效果重新来过）',
    aura.effects[0].statKey === 'attackDamage' && aura.effects[0].label === '攻击力');
  T('⑧c-不修改输入对象', beforeMode.effects[0].perMinute === undefined);

  aura = withAuraEffectModeSet(aura, 0, 'staged');
  T('⑨-withAuraEffectModeSet 切到分阶段模式：带一个默认的 when:\'\' 兜底阶段',
    Array.isArray(aura.effects[0].stages) && aura.effects[0].stages.length === 1 && aura.effects[0].stages[0].when === '');

  aura = withAuraStageAdded(aura, 0, { when: 'time.after', whenArg: 600, flat: 10 });
  T('⑩-withAuraStageAdded 新增一个阶段', aura.effects[0].stages.length === 2);

  aura = withAuraStageFieldSet(aura, 0, 1, 'whenArg', 900);
  T('⑪-withAuraStageFieldSet 改阶段字段', aura.effects[0].stages[1].whenArg === 900);

  try {
    let a2 = withAuraStageRemoved(aura, 0, 1);
    a2 = withAuraStageRemoved(a2, 0, 0);
    T('⑫-withAuraStageRemoved 拒绝删到零个阶段', false);
  } catch (err) {
    T('⑫-withAuraStageRemoved 拒绝删到零个阶段', /至少要保留一个阶段/.test(err.message));
  }

  aura = withAuraEffectAdded(aura, { statKey: 'moveSpeed', flat: 1 });
  aura = withAuraEffectRemoved(aura, 1);
  T('⑬-withAuraEffectRemoved 删除效果', aura.effects.length === 1);
}

// ==================== ③ 端到端：真实 MapSystem 在不同 gameTime 下应用三种模式 ====================
{
  const { ents, fx, attr } = await makeWorld();
  fx.setStatSource(ents, attr);
  const bus = new EventBus();
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(fx);

  const testMap = cloneMapForEdit(MAPS.summoners_rift_v1);
  testMap.id = 'test_globalaura_e2e';
  testMap.globalAura = {
    name: '测试光环', icon: '🧪',
    effects: [
      { statKey: 'attackDamage', label: '固定', flat: 7 },
      { statKey: 'moveSpeed', label: '渐进', perMinute: 1, max: 10 },
      {
        statKey: 'abilityPower', label: '分阶段',
        stages: [{ when: '', flat: 0 }, { when: 'time.after', whenArg: 600, flat: 20 }],
      },
    ],
  };
  CONFIG.customMaps = CONFIG.customMaps || {};
  CONFIG.customMaps[testMap.id] = testMap;
  ms.loadMap(testMap.id);

  const unit = mkEntity(ents, 'siege', {
    stats: { attackDamage: 100, moveSpeed: 300, abilityPower: 0 },
  }, CONFIG);

  // ⚠️ AttributeCalculator.calc() 按帧缓存（key 只看效果 id/层数，不看数值本身，
  // 见其头注"帧级缓存"），真实游戏每帧由主循环调 attr.tick() 使旧缓存失效；
  // 这里手动模拟"下一帧"，否则同一效果 id 数值变了但缓存键没变，会读到上一次
  // 算出来的旧结果——这是测试要还原真实调用节奏，不是产品代码的 bug。
  window.gameTime = 0;
  ms.update(1);
  let s = attr.calc(unit, fx.getEffects(unit.id));
  T('⑭-游戏刚开始：固定值已生效（+7）', Math.abs(s.attackDamage - 107) < 1e-6);
  T('⑮-游戏刚开始：渐进模式还是0（未涨）', Math.abs(s.moveSpeed - 300) < 1e-6);
  T('⑯-游戏刚开始：分阶段落在兜底阶段（+0，法强还是0）', Math.abs(s.abilityPower - 0) < 1e-6);

  attr.tick();
  window.gameTime = 300; // 5分钟
  ms.update(1);
  s = attr.calc(unit, fx.getEffects(unit.id));
  T('⑰-5分钟时：渐进模式涨到+5（moveSpeed）', Math.abs(s.moveSpeed - 305) < 1e-6);
  T('⑱-5分钟时：分阶段仍未到 time.after 600，法强仍是+0', Math.abs(s.abilityPower - 0) < 1e-6);

  attr.tick();
  window.gameTime = 700; // 超过 time.after 600 的阶段阈值
  ms.update(1);
  s = attr.calc(unit, fx.getEffects(unit.id));
  T('⑲-超过阶段阈值后：分阶段切到+20（法强）', Math.abs(s.abilityPower - 20) < 1e-6);
  T('⑳-固定值全程不受时间影响（仍是+7）', Math.abs(s.attackDamage - 107) < 1e-6);

  attr.tick();
  window.gameTime = 6000; // 100分钟，远超渐进模式的封顶
  ms.update(1);
  s = attr.calc(unit, fx.getEffects(unit.id));
  T('㉑-渐进模式到封顶后不再继续涨（moveSpeed 停在+10）', Math.abs(s.moveSpeed - 310) < 1e-6);
}

done();
