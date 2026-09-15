/**
 * sim_qualitybatch.mjs —— 品质优化批次 Q1-Q8 验收（用户："品质优化，暂停画面的修改"）。
 *
 * 每个 Q 独立一节，互不依赖，方便后续单条 --only 调试。
 */
import { setupWindow, scoreboard, srcOf, makeWorld, mkEntity } from './_harness.mjs';

setupWindow();
const { T, done } = scoreboard('品质优化批次 Q1-Q8');

// ==================== Q8：外塔/内塔 HP 数值互换 ====================
{
  const { summoners_rift } = await import('../src/data/maps/summoners_rift.js');
  const ts = summoners_rift.tierStats;
  T('Q8①-外塔 maxHP 3500（3300→3500）', ts.outer.maxHP === 3500);
  T('Q8②-内塔 maxHP 3300（3750→3300）', ts.inner.maxHP === 3300);
  T('Q8③-其余层级维持原值（水晶4000/枢纽4750/召唤水晶5500）',
    ts.base.maxHP === 4000 && ts.hq_tower.maxHP === 4750 && ts.nexus_main.maxHP === 5500);
}

// ==================== Q7：枢纽塔钢铁烈阳护盾变体 + 格挡移入加固城防 ====================
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { equipSkill } = await import('../src/core/skillParams.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer();
  const fx = new EffectRegistry(bus);
  const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator };

  const mkHqTower = (id) => {
    const e = { id, type: 'tower', alive: true, pos: { x: 0, y: 0 },
      baseStats: { maxHP: 4750, armor: 70, magicResist: 110 }, currentHP: 4750,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
      targetId: null, _skillInstances: [], _mapTier: 'hq_tower' };
    ents.add(e);
    return e;
  };

  // ① 格挡从固有属性移植进加固城防技能：装了才有
  const t1 = mkHqTower(1);
  equipSkill(t1, 'passive_hq_fortify', ctx, SkillLibrary);
  const eff1 = fx.getEffects(t1.id);
  T('Q7①-枢纽塔装了加固城防 → 拿到+7伤害格挡（不再是塔身固有属性）',
    eff1.some(x => x.blueprint.statKey === 'damageBlock' && x.blueprint.flatValue === 7));

  const t2 = mkHqTower(2);
  T('Q7②-裸塔（没装加固城防）没有格挡效果', !fx.getEffects(t2.id).some(x => x.blueprint.statKey === 'damageBlock'));

  const def1 = SkillLibrary.passive_hq_fortify;
  def1.onUnequip(t1.id, t1._skillInstances.find(i => i.skillId === 'passive_hq_fortify'), ctx);
  T('Q7③-卸下加固城防后格挡效果一并摘除',
    !fx.getEffects(t1.id).some(x => x.blueprint.statKey === 'damageBlock'));

  // ② 新增被动 passive_hq_bulwark：脱战满 shieldRegenDelay 秒后每 15s +70 护盾，封顶 350
  T('Q7④-passive_hq_bulwark 技能已注册，defaultParams 为 70/350/15',
    !!SkillLibrary.passive_hq_bulwark
    && SkillLibrary.passive_hq_bulwark.defaultParams.perTick === 70
    && SkillLibrary.passive_hq_bulwark.defaultParams.cap === 350
    && SkillLibrary.passive_hq_bulwark.defaultParams.tickInterval === 15);

  const t3 = mkHqTower(3);
  t3.lastDamageTime = 0; // 刚挨打（t=0）
  const inst3 = equipSkill(t3, 'passive_hq_bulwark', ctx, SkillLibrary);
  const def3 = SkillLibrary.passive_hq_bulwark;
  const regenDelay = CONFIG.gameRules?.shieldRegenDelay ?? 8;
  const curCap = (t) => def3.computeCurrent(t, ctx);

  // 仍在脱战延迟窗口内（1s < shieldRegenDelay=8s），不计时、不生成护盾
  window.gameTime = 1;
  def3.onFrame(t3.id, 1, inst3, ctx);
  T('Q7⑤-仍在脱战延迟窗口内（未满 shieldRegenDelay）不计时、不生成护盾',
    curCap(t3) === 0 && fx.plainShieldOf(t3.id) === 0);

  // 一次性推进到"脱战超过 regenDelay + 15s"（模拟大 dt 一次补齐）→ 应该拿到一份 70 护盾
  window.gameTime = regenDelay + 15;
  def3.onFrame(t3.id, regenDelay + 15, inst3, ctx);
  T(`Q7⑥-脱战满15秒后获得70护盾（当前 ${fx.plainShieldOf(t3.id)}）`,
    Math.abs(fx.plainShieldOf(t3.id) - 70) < 1e-6 && curCap(t3) === 70);

  // 再脱战 15s：累加到 140，不会被"重新 apply"顶满/清零
  window.gameTime = regenDelay + 30;
  def3.onFrame(t3.id, 15, inst3, ctx);
  T(`Q7⑦-连续脱战再叠一次 +70（累计140，不会清零重来，当前 ${fx.plainShieldOf(t3.id)}）`,
    Math.abs(fx.plainShieldOf(t3.id) - 140) < 1e-6 && curCap(t3) === 140);

  // 护盾被消耗一部分后（模拟受伤扣护盾），再次脱战满 15s 时增量仍是固定 70，
  // 不会把之前被打没的那部分也一起找回来（cap 140→210，delta=70，不是回满到210+100）
  {
    const shieldEff = fx.getEffects(t3.id).find(e => e.blueprint.kind === 'shield' && e.sourceId === 'passive_hq_bulwark');
    shieldEff.shieldRemaining -= 100; // 模拟吸收了 100 点伤害，剩 40
  }
  window.gameTime = regenDelay + 45;
  def3.onFrame(t3.id, 15, inst3, ctx);
  T(`Q7⑧-护盾被部分消耗后，脱战新增量仍是固定 perTick(70)，不会连本带利地补回来（当前 ${fx.plainShieldOf(t3.id)}，应为110）`,
    Math.abs(fx.plainShieldOf(t3.id) - 110) < 1e-6 && curCap(t3) === 210);

  // 挨打打断计时：重置 timer，但已到手的护盾（层数）不会消失
  const before = fx.plainShieldOf(t3.id);
  window.gameTime = regenDelay + 46;
  t3.lastDamageTime = window.gameTime;
  def3.onFrame(t3.id, 1, inst3, ctx);
  T('Q7⑨-挨打打断脱战计时，但已攒到手的护盾不会消失',
    Math.abs(fx.plainShieldOf(t3.id) - before) < 1e-6);

  // 实际施加给 EffectRegistry 的 flatValue 恒为固定的 perTick(70)，累计值是
  // stacks×perTick 由引擎算出来的派生量——不会把不断增长的累计数直接写成 flatValue
  // （sim_skilldesc.mjs 会拿"实际施加的每个数值"反查文案，累计值没法在静态文案里
  // 逐一列出，见 passive_hq_bulwark 定义处那段头注）。
  {
    const shieldEff = fx.getEffects(t3.id).find(e => e.blueprint.kind === 'shield' && e.sourceId === 'passive_hq_bulwark');
    T('Q7⑩-施加的护盾效果 flatValue 恒为 perTick(70)，累计值走 stacks×perStackFlat 派生',
      shieldEff.blueprint.flatValue === 70 && shieldEff.blueprint.perStackFlat === 70 && shieldEff.stacks === 3);
  }

  // 封顶 350（350/70=5 层）
  {
    const t4 = mkHqTower(4);
    t4.lastDamageTime = -Infinity;
    const inst4 = equipSkill(t4, 'passive_hq_bulwark', ctx, SkillLibrary);
    window.gameTime = 10000;
    for (let i = 0; i < 10; i++) def3.onFrame(t4.id, 15, inst4, ctx); // 远超5层的 tick 次数
    T(`Q7⑪-累计护盾封顶350（尝试叠10次，实际封顶为 ${curCap(t4)}）`, curCap(t4) === 350);
  }

  // ③ hq_tower 默认装配已包含 passive_hq_bulwark（factories.js）
  T('Q7⑫-factories.js 里 hq_tower 层级默认技能列表已加入 passive_hq_bulwark',
    /hq_tower.*passive_hq_fortify.*passive_hq_bulwark|towerDefaults\.push\('passive_hq_fortify', 'passive_hq_bulwark'\)/.test(srcOf('src/core/factories.js')));
}

// ==================== Q3+Q5：点开的生命回复/法力回复窗口显示口径 ====================
// Q3：点开的"生命恢复/秒"大字应为实际值（regen×regenMod×healPower），括号为
//     （实际基础+实际修正），可为负不 clamp；下面关联属性显示未修正的原始属性
//     （生命恢复≠生命回复）。
// Q5：法力回复同理，新增 baseManaRegenMod/manaGainPct 两个系数 + 法力回复主格。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { UIManager } = await import('../src/ui/UIManager.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const e = mkEntity(ents, 'tower', {
    stats: {
      healthRegen: 10, baseHealthRegenMod: 1.2,
      manaRegen: 5, baseManaRegenMod: 1.1, manaGainPct: 0,
    },
  }, CONFIG);
  fx.apply(e.id, { name: '测试生命恢复buff', kind: 'stat', statKey: 'healthRegen', flatValue: 5,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_hr_buff');
  fx.apply(e.id, { name: '测试治疗强度buff', kind: 'stat', statKey: 'healShieldPowerPct', flatValue: 50,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_hsp_buff');
  fx.apply(e.id, { name: '测试法力恢复buff', kind: 'stat', statKey: 'manaRegen', flatValue: 3,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_mr_buff');
  fx.apply(e.id, { name: '测试法力获取加成buff', kind: 'stat', statKey: 'manaGainPct', flatValue: 20,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_mg_buff');

  class FakeOverlay {
    constructor() { this.id = ''; this.className = ''; this._html = ''; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    querySelector(sel) { return sel === '.stat-doc-close' ? { addEventListener() {} } : null; }
    remove() {}
  }
  let captured = null;
  globalThis.document = {
    getElementById: () => null,
    createElement: () => new FakeOverlay(),
    body: { appendChild: (el) => { captured = el; } },
  };
  const ui = Object.create(UIManager.prototype);
  ui.attrCalc = AttributeCalculator;
  ui.effects = fx;

  // ---- 生命回复 ----
  ui._showStatDoc('healthRegen', e);
  // 实际值 = (10+5)×1.2×1.5 = 27；括号 = (10×1.2×1.5=18 + 5×1.2×1.5=9)
  T('Q3①-点开"生命恢复"格子，主体大字显示实际每秒回复值 27（不是原始属性 15）',
    captured && captured._html.includes('生命回复/秒') && captured._html.includes('>27<'));
  T('Q3②-括号为（实际基础+实际修正）＝（18+9），不是原始属性的（10+5）',
    captured && captured._html.includes('（18+9）'));
  T('Q3③-下方关联属性区块用"生命恢复"这个名字，显示未经 regenMod/治疗强度加工的原始属性值 15（10+5）',
    captured && captured._html.includes('生命恢复') && captured._html.includes('>15<') && captured._html.includes('（10+5）'));

  // ---- 生命回复为负时不 clamp 成 0 ----
  const e2 = mkEntity(ents, 'tower', { stats: { healthRegen: -10, baseHealthRegenMod: 1.0 } }, CONFIG);
  ui._showStatDoc('healthRegen', e2);
  T('Q3④-生命回复为负值时如实显示负数，不 clamp 成 0',
    captured && captured._html.includes('>-10<'));

  // ---- 法力回复 ----
  ui._showStatDoc('manaRegen', e);
  // 实际值 = (5+3)×1.1×1.2 = 10.56；括号 = (5×1.1×1.2=6.6 + 3×1.1×1.2=3.96)
  T('Q5①-点开"法力恢复"格子，主体大字显示实际每秒回复值 10.56（不是原始属性 8）',
    captured && captured._html.includes('法力回复/秒') && captured._html.includes('>10.56<'));
  T('Q5②-括号为（实际基础+实际修正）＝（6.6+3.96）',
    captured && captured._html.includes('（6.6+3.96）'));
  T('Q5③-下方关联属性区块用"法力恢复"这个名字，显示未经系数加工的原始属性值 8（5+3）',
    captured && captured._html.includes('>8<') && captured._html.includes('（5+3）'));
  T('Q5④-关联属性区块带出【基础法力恢复】（110%）与【法力获取加成%】（0+20%）',
    captured && captured._html.includes('基础法力恢复') && captured._html.includes('>110%<')
    && captured._html.includes('法力获取加成'));

  // ---- Q5：splashRadius 汉化 + 新字段的 FIELD_META/statDoc 都已登记 ----
  const { fieldLabel } = await import('../src/ui/editor/fields.js');
  const { statDoc } = await import('../src/data/statDocs.js');
  T('Q5⑤-splashRadius 已汉化，不再原样显示英文字段名', fieldLabel('splashRadius') === '溅射半径');
  T('Q5⑥-baseManaRegenMod/manaGainPct 都有 statDoc 说明可点开',
    !!statDoc('baseManaRegenMod') && !!statDoc('manaGainPct'));
  T('Q5⑦-baseManaRegenMod 出厂默认 1.0（100%，不影响任何单位现有回蓝速度）',
    CONFIG.templates.melee.baseManaRegenMod === 1 && CONFIG.templates.tower.baseManaRegenMod === 1);

  // ---- statPanelLayout.js 接入检查 ----
  const { RELATED_STATS, extAttrGroups } = await import('../src/ui/statPanelLayout.js');
  T('Q5⑧-法力回复已进入面板分组（extAttrGroups）',
    extAttrGroups().some(g => g.rows.some(r => r.key === 'manaRegen')));
  T('Q3⑤-RELATED_STATS.healthRegen 含自身（未修正属性）',
    RELATED_STATS.healthRegen.includes('healthRegen'));
  T('Q5⑨-RELATED_STATS.manaRegen 含自身+基础法力恢复+法力获取加成',
    RELATED_STATS.manaRegen.includes('manaRegen')
    && RELATED_STATS.manaRegen.includes('baseManaRegenMod')
    && RELATED_STATS.manaRegen.includes('manaGainPct'));

  delete globalThis.document;
}

// ==================== Q2：主动技能施放触发方式框架化 ====================
// 用户："主动技能的施放应该有不同的形式：法力值满后自动释放/满后攻击才释放/满后
// 受击才释放等（或者是两种都可以触发）。" ——排查发现改动前的实现对所有装了主动
// 技能的单位一视同仁，法力一满下一帧就自动施放，跟这一帧有没有攻击/受击完全无关
// （多数单位 manaRegen 非0，被动回复本身就能堆满，"看起来像攻击触发"只是巧合，
// 不是真的攻击门控——如实记录在 ManaSystem.js 头注里）。这里新增 castTrigger
// 框架，不重新指派任何现有技能，默认值必须与改动前逐位一致。
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { ManaSystem } = await import('../src/systems/ManaSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');

  function mkTestWorld(skillDefs) {
    const bus = new EventBus();
    const ents = new EntityContainer();
    const fx = new EffectRegistry(bus);
    const mana = new ManaSystem(ents, fx, bus, skillDefs, AttributeCalculator, null);
    return { bus, ents, fx, mana };
  }
  function mkUnit(ents, id, skillId) {
    const e = {
      id, type: 'melee', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.melee, maxMana: 100, manaRegen: 0, manaStart: 0, manaFloor: 0 },
      currentHP: 100, _skillInstances: [{ id: 900 + id, skillId, state: {} }],
      _mapFaction: 'blue', faction: 'blue',
    };
    ents.add(e);
    return e;
  }

  // Q2①：castTrigger 缺省即 'onFull'，行为与改动前逐位一致——满格下一帧就直接放。
  {
    let casts = 0;
    const defs = { test_active_full: { category: 'active', onCast: () => { casts++; return true; } } };
    const { ents, mana } = mkTestWorld(defs);
    const u = mkUnit(ents, 1, 'test_active_full');
    u._mana = 100;
    mana.update(0.1);
    T('Q2①-castTrigger 缺省即 onFull，法力满格下一帧立刻施放（与改动前逐位一致）',
      casts === 1 && u._mana === 0);
  }

  // Q2②：castTrigger='onAttack' 时，法力满格但没有攻击事件，update() 不会自动施放。
  {
    let casts = 0;
    const defs = { test_active_atk: { category: 'active', castTrigger: 'onAttack', onCast: () => { casts++; return true; } } };
    const { ents, mana } = mkTestWorld(defs);
    const u = mkUnit(ents, 2, 'test_active_atk');
    u._mana = 100;
    mana.update(0.1); mana.update(0.1); mana.update(0.1);
    T('Q2②-castTrigger=onAttack 时，法力满格但没发生攻击事件，不会自动施放',
      casts === 0 && u._mana === 100);
  }

  // Q2③：onAttack 触发——满格后本单位作为攻击方打出一次攻击，立刻施放。
  {
    let casts = 0;
    const defs = { test_active_atk: { category: 'active', castTrigger: 'onAttack', onCast: () => { casts++; return true; } } };
    const { ents, bus, mana } = mkTestWorld(defs);
    const u = mkUnit(ents, 3, 'test_active_atk');
    const target = mkUnit(ents, 4, 'test_active_atk');
    u._mana = 100;
    bus.emit('damage:dealt', { sourceId: u.id, targetId: target.id, amount: 10, attackShare: 1 });
    T('Q2③-onAttack 技能在自己打出一次攻击后立刻施放（不用等下一帧 update）',
      casts === 1 && u._mana === 0);
  }

  // Q2④：onHit 触发——满格后本单位作为受击方被打才施放；自己打人不触发。
  {
    let casts = 0;
    const defs = { test_active_hit: { category: 'active', castTrigger: 'onHit', onCast: () => { casts++; return true; } } };
    const { ents, bus, mana } = mkTestWorld(defs);
    const u = mkUnit(ents, 5, 'test_active_hit');
    const other = mkUnit(ents, 6, 'test_active_hit');
    u._mana = 100;
    bus.emit('damage:dealt', { sourceId: u.id, targetId: other.id, amount: 10, attackShare: 1 });
    T('Q2④a-onHit 技能自己打人不会触发施放', casts === 0 && u._mana === 100);
    bus.emit('damage:dealt', { sourceId: other.id, targetId: u.id, amount: 10, attackShare: 1 });
    T('Q2④b-onHit 技能被打一下后立刻施放', casts === 1 && u._mana === 0);
  }

  // Q2⑤：onAttackOrHit——攻击或受击任一发生都可以触发（用户"两种都可以触发"）。
  {
    let casts = 0;
    const defs = { test_active_or: { category: 'active', castTrigger: 'onAttackOrHit', onCast: () => { casts++; return true; } } };
    const { ents, bus, mana } = mkTestWorld(defs);
    const u = mkUnit(ents, 7, 'test_active_or');
    const other = mkUnit(ents, 8, 'test_active_or');
    u._mana = 100;
    bus.emit('damage:dealt', { sourceId: other.id, targetId: u.id, amount: 10, attackShare: 1 });
    T('Q2⑤-onAttackOrHit：受击就能触发（另一半"攻击也能触发"与 Q2③ 是同一逻辑分支，不重复测）',
      casts === 1 && u._mana === 0);
  }

  // Q2⑥：现有全部主动技能都没有显式指派 castTrigger——如实反映"本次未重新指派任何
  // 现有技能"，而不是悄悄把某些技能改成攻击/受击门控却没人注意到。
  {
    const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
    const actives = SkillLibrary.ids().map(id => SkillLibrary.get(id)).filter(d => d?.category === 'active');
    T(`Q2⑥-现有 ${actives.length} 条主动技能均未显式指派 castTrigger（框架新增不改现状，默认 onFull）`,
      actives.length > 0 && actives.every(d => d.castTrigger === undefined));
  }
}

// ==================== Q1：HP/法力条统一拖尾特效 + "增加特效"预告 ====================
// 用户："所有的HP/法力进度条，都添加统一的拖尾特效和'增加特效'。进度条主体大幅
// 削弱动画效果（几乎看不出来），用拖尾特效展示。……如果某单位在固定时间内要
// 增加一定数额的值，就会在进度条高位出出现'拖尾特效'同款的一个显示（但是不要
// 长得一样要做区分），就是告诉这个单位要回这么多血或者是法力。"
//
// v51.28（Q1返工）：用户否掉了当初这版实现——"增加特效不好！增加特效应该是
// 短时间内获得大量百分比才会触发！要不然太乱了看起来。而且颜色不要做成红色
// 啊！做成和该进度条颜色的自适应颜色"。旧版 previewFrac/CONFIG.ui.barIncreasePreview
// .{windowSec,color} 已被 bigRegenPreviewFrac/deriveIncreaseColor +
// CONFIG.ui.barIncreasePreview.{thresholdFrac,maxWindowSec,lightenPct,alpha} 取代
// （见 barTrail.js 头注 + tests/sim_barinc.mjs 的完整验收），这里的 Q1①-④/⑦
// 改成钉新形状，不再钉已经被否掉的旧行为。
{
  const { bigRegenPreviewFrac, deriveIncreaseColor } = await import('../src/presentation/barTrail.js');
  const { CONFIG } = await import('../src/data/Config.js');

  T('Q1①-CONFIG.ui.barIncreasePreview 已软编码（enabled/thresholdFrac/maxWindowSec/lightenPct/alpha）',
    !!CONFIG.ui?.barIncreasePreview
    && typeof CONFIG.ui.barIncreasePreview.enabled === 'boolean'
    && typeof CONFIG.ui.barIncreasePreview.thresholdFrac === 'number'
    && typeof CONFIG.ui.barIncreasePreview.maxWindowSec === 'number'
    && typeof CONFIG.ui.barIncreasePreview.lightenPct === 'number'
    && typeof CONFIG.ui.barIncreasePreview.alpha === 'number');

  T('Q1②-bigRegenPreviewFrac：永久（remainingTime=Infinity）的被动回复不触发',
    bigRegenPreviewFrac([{ blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: Infinity, totalFlat: 999 }],
      'healthRegen', 1, 100, 0.5, 0.12, 20) === 0);
  T('Q1③-bigRegenPreviewFrac：限时效果、总量达到阈值时触发，宽度=总量/上限',
    Math.abs(bigRegenPreviewFrac([{ blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 5 }],
      'healthRegen', 1, 100, 0, 0.12, 20) - 0.5) < 1e-9);
  T('Q1④-bigRegenPreviewFrac：预告条不会超过"到满还剩多少"',
    Math.abs(bigRegenPreviewFrac([{ blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 20 }],
      'healthRegen', 1, 100, 0.95, 0.12, 20) - 0.05) < 1e-9);

  // resourceBar.js：effRegen（实际每秒回复速率，供预告用）+ max（法力上限，供换算宽度分数用）
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { resourceInfoOf } = await import('../src/core/resourceBar.js');

  const bus2 = new EventBus();
  const ents2 = new EntityContainer(bus2);
  const fx2 = new EffectRegistry(bus2);
  const rctx = { skillLibrary: SkillLibrary, attrCalc: AttributeCalculator, effects: fx2 };
  const mageLike = {
    id: 500, type: 'corrupt', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.corrupt, maxMana: 50, manaRegen: 3, baseManaRegenMod: 1.2, manaGainPct: 10 },
    currentHP: 100, _mana: 20,
    _skillInstances: [{ id: 501, skillId: 'active_corrupt_poison', state: {} }],
  };
  ents2.add(mageLike);
  const info = resourceInfoOf(mageLike, rctx);
  T('Q1⑤-resourceInfoOf 暴露 max（法力上限）+ effRegen（实际每秒回复，非原始属性）',
    info && info.max === 50 && Math.abs(info.effRegen - 3 * 1.2 * 1.1) < 1e-9);
  T('Q1⑥-regenText（💧X）现在用的也是实际值，跟 effRegen 同源，不是原始属性 3',
    info && info.regenText === `💧${Math.round(info.effRegen * 10) / 10}`);

  // UnitLayer.js / UIManager.js 接线检查：确认改动落到了两处消费方
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('Q1⑦-UnitLayer._redrawBar 接收 hpIncFrac/resTrailFrac/resIncFrac 三个新参数并按该条真实颜色生成预告色',
    /_redrawBar\(g, e, ghost, maxHP, trailFrac = 0, resInfo = null, hpIncFrac = 0, resTrailFrac = 0, resIncFrac = 0\)/.test(ul)
    && /deriveIncreaseColor\(hpColor,/.test(ul));

  const um = srcOf('src/ui/UIManager.js');
  T('Q1⑧-UIManager 新增 _updateHpIncBar（塔/兵卡片共用）并接入 .bar-hp-inc/.bar-res-inc',
    /_updateHpIncBar\(card, prefix, id, entity, stats, hpFrac, maxHP\)/.test(um)
    && /row\.querySelector\('\.bar-res-inc'\)/.test(um));

  const html = srcOf('index.html');
  T('Q1⑨-CSS 里 .bar-hp-inc/.bar-res-inc/.bar-res-trail 三个新元素都已定义',
    /\.bar-hp-inc \{/.test(html) && /\.bar-res-inc \{/.test(html) && /\.bar-res-trail \{/.test(html));
}

// ==================== Q4：攻击力面板自适应显示伤害类型+数值 ====================
// 用户："属性窗口的'攻击力'应该也改成自适应显示目前的伤害类型和可以造成的伤害
// （左侧伤害类型图标+数值）。"
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { UIManager } = await import('../src/ui/UIManager.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ui = Object.create(UIManager.prototype);
  ui.attrCalc = AttributeCalculator;
  ui.effects = fx;

  const mkUnit = (id, attackType, stats) => {
    const e = { id, type: 'melee', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.melee, attackType, ...stats }, currentHP: 100,
      _skillInstances: [] };
    ents.add(e);
    return e;
  };

  const phys = mkUnit(1, 'physical', { attackDamage: 50 });
  T('Q4①-物理伤害类型显示⚔️图标', ui._attackDamageHtml(phys, AttributeCalculator.calc(phys, [])).includes('⚔️'));

  const magic = mkUnit(2, 'magic', { attackDamage: 30, abilityPower: 100 });
  T('Q4②-魔法伤害类型显示✨图标', ui._attackDamageHtml(magic, AttributeCalculator.calc(magic, [])).includes('✨'));

  // 自适应：法术强度明显高于攻击力时应该解析成魔法伤害图标
  const adaptive = mkUnit(3, 'adaptive', { attackDamage: 1, abilityPower: 200 });
  const adaptiveStats = AttributeCalculator.calc(adaptive, []);
  T('Q4③-自适应类型现读 resolveAttackType，法强远高于攻击力时显示✨（不是恒定物理图标）',
    ui._attackDamageHtml(adaptive, adaptiveStats).includes('✨')
    && AttributeCalculator.resolveAttackType(adaptiveStats) === 'magic');

  // 数值本身不变——还是走原有的 _statParts 着色逻辑，只是多了个图标前缀
  const withBuff = mkUnit(4, 'physical', { attackDamage: 50 });
  fx.apply(withBuff.id, { name: '测试攻击力buff', kind: 'stat', statKey: 'attackDamage', flatValue: 20,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_ad_buff');
  const buffedStats = AttributeCalculator.calc(withBuff, fx.getEffects(withBuff.id));
  const html4 = ui._attackDamageHtml(withBuff, buffedStats);
  T('Q4④-数值本身不受影响，仍显示修正后的真实值（70）+着色', html4.includes('>70<') && html4.includes('stat-up'));
}

// ==================== Q6：HP/法力条可点开详细统计窗口 ====================
// 用户："属性窗口中生命值/法力条也可点击（类似属性窗口），点开可以看到详细的
// 数据，包括经抗性/伤害减免结算后的实际生命值（例子：HP500，双抗100，实际
// 生命值就为1000），还有该单位受到的不同类型的伤害统计/生命恢复的统计，各种
// 和生命恢复相关联的属性都移动到里面，还有护盾别忘了……法力值窗口同理。"
{
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { UIManager } = await import('../src/ui/UIManager.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);

  const mkUnit = (id, stats) => {
    const e = { id, type: 'melee', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.melee, armor: 0, magicResist: 0, damageReduction: 0, damageBlock: 0,
        maxHP: 10000, shieldFixedMax: 0, tempShieldDecayPct: 0, ...stats },
      currentHP: stats?.hp ?? 10000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'red', faction: 'red' };
    ents.add(e);
    return e;
  };

  // ① 伤害类型累计统计：物理/魔法/真实三条互不干扰，按 finalDamage（实扣血量）累计
  const victim = mkUnit(1, { armor: 0, magicResist: 0 });
  const attacker = mkUnit(2, {});
  combat.performAttackDirect(attacker.id, victim.id, 100, 'physical');
  combat.performAttackDirect(attacker.id, victim.id, 50, 'magic');
  combat.performAttackDirect(attacker.id, victim.id, 20, 'true');
  T('Q6①-CombatSystem 累计"受到的不同类型伤害"统计（物理/魔法/真实分开记）',
    victim._dmgTaken && victim._dmgTaken.physical === 100 && victim._dmgTaken.magic === 50 && victim._dmgTaken.true === 20);

  // ② 护盾吸收的那部分不算进"受到伤害"（finalDamage 是实扣血量，不是护盾吸收前的原始伤害）
  const shielded = mkUnit(3, {});
  fx.apply(shielded.id, { name: '测试护盾', kind: 'shield', flatValue: 30,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_shield');
  combat.performAttackDirect(attacker.id, shielded.id, 100, 'physical');
  T(`Q6②-护盾吸收的部分不计入累计伤害统计（100点打进来，30点被护盾挡掉，累计应为70，当前=${shielded._dmgTaken?.physical}）`,
    shielded._dmgTaken && Math.abs(shielded._dmgTaken.physical - 70) < 1e-6);

  // ③ 生命恢复累计统计：healing.js 的 applyHeal 是唯一回血入口，这里直接测它
  const { applyHeal } = await import('../src/core/healing.js');
  const healed = { alive: true, currentHP: 50 };
  applyHeal(healed, 30, 1, 100);
  applyHeal(healed, 30, 1, 100); // 第二次会被 maxHP=100 封顶到 20
  T(`Q6③-累计生命恢复量按实际回复量累加（不是按尝试回复的原始量），当前=${healed._healReceivedTotal}`,
    healed._healReceivedTotal === 50); // 30 + 20（封顶）

  // ④ HP 统计弹窗：等效生命值公式与用户给的例子一致（HP500，双抗100→实际1000）
  class FakeOverlay {
    constructor() { this.id = ''; this.className = ''; this._html = ''; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    querySelector(sel) { return sel === '.stat-doc-close' ? { addEventListener() {} } : null; }
    remove() {}
  }
  let captured = null;
  globalThis.document = {
    getElementById: () => null,
    createElement: () => new FakeOverlay(),
    body: { appendChild: (el) => { captured = el; } },
  };
  const ui = Object.create(UIManager.prototype);
  ui.attrCalc = AttributeCalculator;
  ui.effects = fx;

  const exampleUnit = mkUnit(4, { maxHP: 500, hp: 500, armor: 100, magicResist: 100 });
  ui._showHpStatsModal(exampleUnit);
  T('Q6④-等效生命值公式与用户给的例子一致（HP500，双抗100 → 对应方向实际生命值1000）',
    captured && captured._html.includes('对物理伤害') && captured._html.includes('对魔法伤害')
    && /对物理伤害[\s\S]{0,40}>1000</.test(captured._html) && /对魔法伤害[\s\S]{0,40}>1000</.test(captured._html));

  // ⑤ HP 统计弹窗包含护盾构成 + 累计伤害统计 + 累计生命恢复
  const withShields = mkUnit(5, { maxHP: 1000, hp: 800 });
  withShields.shieldFixedCurrent = 40; withShields.tempShield = 15; withShields.plainShield = 25;
  withShields._dmgTaken = { physical: 70, magic: 30, true: 5 };
  withShields._healReceivedTotal = 123;
  ui._showHpStatsModal(withShields);
  // v51.29（Q3）：这块窗口重新设计过，"累计承受伤害"这个小标题改成了
  // "承伤 — 按类型"（环状图形式），断言跟着改，其余数字口径不变。
  T('Q6⑤-弹窗展示护盾构成三项+承伤统计三项+累计生命恢复',
    captured && /护盾构成/.test(captured._html)
    && />40</.test(captured._html) && />15</.test(captured._html) && />25</.test(captured._html)
    && /承伤 — 按类型/.test(captured._html) && />70</.test(captured._html) && />30</.test(captured._html) && />5</.test(captured._html)
    && /累计生命恢复量[\s\S]{0,20}>123</.test(captured._html));

  // ⑥ 法力统计弹窗：与 Q5 的三个系数同源，不另起一套计算
  const mageLike = { id: 6, type: 'corrupt', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.corrupt, maxMana: 50, manaRegen: 3, baseManaRegenMod: 1.2, manaGainPct: 10 },
    currentHP: 100, _mana: 20, _skillInstances: [{ id: 601, skillId: 'active_corrupt_poison', state: {} }] };
  ents.add(mageLike);
  ui._showManaStatsModal(mageLike);
  // 本轮：用户"没有的括号都给我删了"，这两行的标签去掉了括号（法力恢复（属性）→
  // 法力恢复属性；法力回复（实际每秒）→实际每秒法力回复），断言跟着改。
  T('Q6⑥-法力统计弹窗展示法力恢复属性/基础法力恢复/法力获取加成/实际每秒法力回复 四项',
    captured && /法力恢复属性/.test(captured._html) && /基础法力恢复/.test(captured._html)
    && /法力获取加成/.test(captured._html) && /实际每秒法力回复/.test(captured._html));

  delete globalThis.document;

  // ⑦ 接线检查：卡片创建时确实绑定了点击（不是只写了方法没人调）
  const um = srcOf('src/ui/UIManager.js');
  T('Q6⑦-塔/兵卡片创建时都绑定了 HP/法力条的点击事件',
    /card\.querySelector\(`#tower-bar-\$\{tower\.id\}`\)\?\.addEventListener\('click'/.test(um)
    && /card\.querySelector\(`#tower-resrow-\$\{tower\.id\}`\)\?\.addEventListener\('click'/.test(um)
    && /card\.querySelector\(`#minion-bar-\$\{minion\.id\}`\)\?\.addEventListener\('click'/.test(um)
    && /card\.querySelector\(`#minion-resrow-\$\{minion\.id\}`\)\?\.addEventListener\('click'/.test(um));
  const html6 = srcOf('index.html');
  T('Q6⑧-CSS 里 .bar-track 有 cursor:pointer（可点击的可发现性）',
    /\.bar-track \{[^}]*cursor: pointer/.test(html6));
}

done();
