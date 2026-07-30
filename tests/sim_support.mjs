// 支援兵种重做 + 塔互攻 + 出兵编排 验收（用户定稿）。
//
// 三个兵种的规格是用户逐条给的，所以这套用例逐条对照着钉，
// 每条断言的名字就写清"应该是多少"，以后改数值时一眼看出是数值变了还是逻辑坏了。
globalThis.window = { gameTime: 0, waveNumber: 10, _uid: 0, CTX: {} };
globalThis.window.__towerRules = { invincible: {}, attackOff: {}, waveOn: { blue: true, red: true } };
globalThis.window.__towerRuleFor = () => false;
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { buildWaveOrder } = await import('../src/data/waveComposition.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const SU = () => CONFIG.gameRules.supportUnits;

function world() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: bus,
                attrCalc: AttributeCalculator, waveNumber: 10, combat };
  const mk = (type, fac, x, y = 0, tier = null) => {
    const t = CONFIG.templates[type];
    const e = {
      id: ++window._uid, type, alive: true, pos: { x, y },
      baseStats: { ...t }, currentHP: t.maxHP,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: fac, faction: fac,
    };
    if (tier) e._mapTier = tier;
    ents.add(e);
    return e;
  };
  const eq = (e, ids) => {
    for (const id of ids) {
      const inst = { id: ++window._uid, skillId: id, state: {} };
      e._skillInstances.push(inst);
      SkillLibrary.get(id)?.onEquip?.(e.id, inst, ctx);
    }
  };
  const run = (secs, actors) => {
    for (let i = 0; i < Math.round(secs * 30); i++) {
      for (const a of actors) {
        for (const inst of a._skillInstances) {
          SkillLibrary.get(inst.skillId)?.onFrame?.(a.id, 1 / 30, inst, ctx);
        }
      }
      fx.update(1 / 30);
    }
  };
  const stats = (e) => { AttributeCalculator.tick(); return AttributeCalculator.calc(e, fx.getEffects(e.id)); };
  return { bus, ents, fx, combat, ctx, mk, eq, run, stats };
}

// ==================== 图腾兵 ====================
// 规格：对自己和附近友军周期性（15s）提供已损生命值百分比（3%）治疗，
//       施加 10% 伤害减免 / 25 固定护盾的光环，自身拥有高额固定护盾。
{
  const W = world();
  const c = SU().totem;
  const totem = W.mk('totem', 'blue', 0);
  W.eq(totem, ['passive_totem_aura', 'passive_totem_mend', 'passive_totem_bulwark']);
  const ally = W.mk('melee', 'blue', 50);
  const foe = W.mk('melee', 'red', 60);
  const allyMax = ally.baseStats.maxHP;
  ally.currentHP = Math.round(allyMax * 0.2);
  const hp0 = ally.currentHP;

  T(`图腾·自身高额固定护盾（模板 ${CONFIG.templates.totem.shieldFixedMax} + ${c.selfShieldFlat}）`,
    totem.baseStats.shieldFixedMax === CONFIG.templates.totem.shieldFixedMax + c.selfShieldFlat);
  T('图腾·出场即满盾', totem.shieldFixedCurrent === totem.baseStats.shieldFixedMax);

  W.run(1, [totem]);      // 光环节流 0.3s，1 秒足够铺开
  const as = W.stats(ally);
  T(`图腾光环·友军伤害减免 +${c.auraDamageReduction}%（实测 ${as.damageReduction}）`,
    as.damageReduction === c.auraDamageReduction);
  T(`图腾光环·友军固定护盾 +${c.auraShieldFlat}（实测 ${as.shieldFixedMax}）`,
    as.shieldFixedMax === CONFIG.templates.melee.shieldFixedMax + c.auraShieldFlat);
  const fs = W.stats(foe);
  T('图腾光环·不会加到敌方身上',
    fs.damageReduction === CONFIG.templates.melee.damageReduction);

  T(`治疗周期未到不回血（1s < ${c.healIntervalSec}s）`, ally.currentHP === hp0);
  W.run(c.healIntervalSec, [totem]);
  const expect = hp0 + (allyMax - hp0) * (c.healMissingPct / 100);
  T(`图腾涌泉·每 ${c.healIntervalSec}s 回【已损生命】的 ${c.healMissingPct}%（${hp0} → ${ally.currentHP.toFixed(1)}，期望 ${expect.toFixed(1)}）`,
    Math.abs(ally.currentHP - expect) < 0.01);
  T('图腾涌泉·不治疗敌方', foe.currentHP === foe.baseStats.maxHP);

  // 自身也要被治疗（"对自己和附近友军"）
  const W2 = world();
  const t2 = W2.mk('totem', 'blue', 0);
  W2.eq(t2, ['passive_totem_mend']);
  t2.currentHP = 10;
  const tMax = t2.baseStats.maxHP;
  W2.run(SU().totem.healIntervalSec, [t2]);
  const tExp = 10 + (tMax - 10) * (SU().totem.healMissingPct / 100);
  T(`图腾涌泉·也治疗自己（10 → ${t2.currentHP.toFixed(1)}，期望 ${tExp.toFixed(1)}）`,
    Math.abs(t2.currentHP - tExp) < 0.01);
  T('图腾涌泉·自己只被治疗一次（不会因为同时在范围内而双份）',
    t2.currentHP < 10 + (tMax - 10) * (SU().totem.healMissingPct / 100) * 1.5);

  // 满血单位不该浪费一次治疗
  const W3 = world();
  const t3 = W3.mk('totem', 'blue', 0);
  W3.eq(t3, ['passive_totem_mend']);
  const full = W3.mk('melee', 'blue', 30);
  W3.run(SU().totem.healIntervalSec, [t3]);
  T('图腾涌泉·满血单位不会超出上限', full.currentHP === full.baseStats.maxHP);
}

// ==================== 术士兵 ====================
// 规格：对附近友军施加 13% 固定双穿和 7% 伤害增幅（光环）；自身拥有 70% 固定双穿（状态）。
{
  const W = world();
  const c = SU().warlock;
  const wl = W.mk('warlock', 'blue', 0);
  W.eq(wl, ['passive_warlock_aura', 'passive_warlock_attune']);
  const ally = W.mk('melee', 'blue', 40);
  const foe = W.mk('melee', 'red', 50);
  W.run(1, [wl]);

  const as = W.stats(ally);
  T(`术法共鸣·友军双穿 +${c.auraPenPct}%（实测 护甲 ${as.armorPenPercent} / 法术 ${as.magicPenPercent}）`,
    as.armorPenPercent === c.auraPenPct && as.magicPenPercent === c.auraPenPct);
  T(`术法共鸣·友军伤害增幅 +${c.auraDamageAmpPct}%（实测 ${as.damageAmpPct}）`,
    as.damageAmpPct === c.auraDamageAmpPct);
  const fs = W.stats(foe);
  T('术法共鸣·不会加到敌方身上', fs.armorPenPercent === CONFIG.templates.melee.armorPenPercent);

  const ws = W.stats(wl);
  T(`术法贯通·自身双穿 ${c.selfPenPct}%（实测 护甲 ${ws.armorPenPercent} / 法术 ${ws.magicPenPercent}）`,
    ws.armorPenPercent >= c.selfPenPct && ws.magicPenPercent >= c.selfPenPct);
  T('术法贯通·以【状态】形式存在（面板里看得见）',
    W.fx.getEffects(wl.id).some(e => e.blueprint?.name === '术法贯通'));
}

// ==================== 蚀骨兵 ====================
// 规格：改为近战，血量大于普通近战，对小范围内所有敌人施加减少双抗（叠层直满层）。
{
  const { MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
  const c = SU().corrupt;
  T(`蚀骨兵·近战（射程 ${CONFIG.templates.corrupt.attackRange} ≤ ${MELEE_RANGE_THRESHOLD}）`,
    CONFIG.templates.corrupt.attackRange <= MELEE_RANGE_THRESHOLD);
  T(`蚀骨兵·血量高于普通近战（${CONFIG.templates.corrupt.maxHP} > ${CONFIG.templates.melee.maxHP}）`,
    CONFIG.templates.corrupt.maxHP > CONFIG.templates.melee.maxHP);

  const W = world();
  const cor = W.mk('corrupt', 'blue', 0);
  W.eq(cor, ['passive_corrupt_strike']);
  const foe = W.mk('melee', 'red', c.radius - 20);
  const farFoe = W.mk('melee', 'red', c.radius + 200);
  const ally = W.mk('melee', 'blue', 30);
  const foeTower = W.mk('tower', 'red', 40, 0, 'outer');
  W.run(1, [cor]);

  const drop = c.resistPerStack * c.maxStacks;
  const fs = W.stats(foe);
  T(`蚀骨·范围内敌人双抗降低 ${drop}（一次即满 ${c.maxStacks} 层；护甲 ${CONFIG.templates.melee.armor} → ${fs.armor}）`,
    fs.armor === CONFIG.templates.melee.armor - drop
    && fs.magicResist === CONFIG.templates.melee.magicResist - drop);
  T('蚀骨·"叠层直满层"—— 不用平A慢慢叠',
    W.fx.getEffects(foe.id).find(e => e.blueprint?.statKey === 'armor')?.stacks === c.maxStacks);
  const as2 = W.stats(ally);
  T('蚀骨·不会削自己人', as2.armor === CONFIG.templates.melee.armor);
  const ffs = W.stats(farFoe);
  T(`蚀骨·范围外（>${c.radius}）不受影响`, ffs.armor === CONFIG.templates.melee.armor);
  const ts = W.stats(foeTower);
  T('蚀骨·"所有敌人"含敌方建筑', ts.armor < CONFIG.templates.tower.armor);
  T('蚀骨·文案说的是"敌军"不是"友军"（文案与效果必须一致）',
    /敌军/.test(SkillLibrary.get('passive_corrupt_strike').description));
}

// ==================== 塔互攻 ====================
{
  const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
  T('塔互攻开关软编码且默认开启', CONFIG.gameRules.towerAttacksTower === true);

  const W = world();
  // 蓝方外塔 vs 红方外塔（红方没有更外层的塔 → 不受结构保护）
  const blue = W.mk('tower', 'blue', 0, 0, 'outer');
  const red = W.mk('tower', 'red', 100, 0, 'outer');
  blue._skillInstances.push({ id: ++window._uid, skillId: 'weapon_piercing', state: {} });
  T('红方外塔未被结构保护', isStructureProtected(W.ents, red) === false);
  const tgt = W.combat.selectTarget(blue, []);
  T(`塔可以选中敌方塔为目标（选到 ${tgt ? tgt.type + '#' + tgt.id : 'null'}）`, tgt && tgt.id === red.id);

  // 小兵在场时优先打小兵（塔不会跑，什么时候打都来得及）
  const minion = W.mk('melee', 'red', 60);
  const tgt2 = W.combat.selectTarget(blue, []);
  T('小兵在场时优先打小兵（塔的索敌优先级最低）', tgt2 && tgt2.id === minion.id);

  // 结构保护仍然生效：有外塔挡着就打不到内塔
  const W2 = world();
  const b2 = W2.mk('tower', 'blue', 0, 0, 'outer');
  b2._skillInstances.push({ id: ++window._uid, skillId: 'weapon_piercing', state: {} });
  const rOuter = W2.mk('tower', 'red', 900, 0, 'outer');   // 射程外，但存活 → 提供保护
  rOuter._laneId = 'mid';
  const rInner = W2.mk('tower', 'red', 100, 0, 'inner');
  rInner._laneId = 'mid';
  T('内塔在同路外塔存活时受结构保护', isStructureProtected(W2.ents, rInner) === true);
  T('受保护的敌方塔不会被选为目标（不跳过推进顺序）',
    W2.combat.selectTarget(b2, []) === null);

  // 沙盒模式（无阵营）不互打
  const W3 = world();
  const s1 = W3.mk('tower', null, 0, 0, 'outer');
  const s2 = W3.mk('tower', null, 80, 0, 'outer');
  s1._mapFaction = undefined; s2._mapFaction = undefined;
  s1._skillInstances.push({ id: ++window._uid, skillId: 'weapon_piercing', state: {} });
  T('沙盒模式的塔互不攻击（没有阵营概念）', W3.combat.selectTarget(s1, []) === null);

  // 开关关掉就完全恢复旧行为
  CONFIG.gameRules.towerAttacksTower = false;
  const W4 = world();
  const b4 = W4.mk('tower', 'blue', 0, 0, 'outer');
  b4._skillInstances.push({ id: ++window._uid, skillId: 'weapon_piercing', state: {} });
  W4.mk('tower', 'red', 100, 0, 'outer');
  T('关掉开关后塔不再互攻（可回退）', W4.combat.selectTarget(b4, []) === null);
  CONFIG.gameRules.towerAttacksTower = true;
}

// ==================== 出兵编排：所有兵种默认生成 ====================
{
  const gr = CONFIG.gameRules;
  T('所有兵种默认开启生成',
    ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram']
      .every(t => gr.spawnEnabled[t] === true));

  // 重复键会静默覆盖：spawnEnabled 曾在同一个对象里声明两次，改前面那份毫无效果
  const src = (await import('fs')).default.readFileSync('src/data/Config.js', 'utf8');
  const dup = (k) => (src.match(new RegExp('^\\s*' + k + ':', 'gm')) || []).length;
  T(`spawnEnabled 只声明一次（实测 ${dup('spawnEnabled')} 次）`, dup('spawnEnabled') === 1);
  T(`battleTotemFromWave 只声明一次（实测 ${dup('battleTotemFromWave')} 次）`,
    dup('battleTotemFromWave') === 1);
  T(`laneWaveComposition 只声明一次`, dup('laneWaveComposition') === 1);

  // 编排：三个支援兵种都排进去了，且起始波错开
  const types = gr.laneWaveComposition.map(r => r.type);
  T('编排里包含全部 8 个兵种', ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram']
    .every(t => types.includes(t)));

  const at = (w) => buildWaveOrder(w, false, gr);
  T(`第 1 波只有基础兵（${at(1).join('/')}）`,
    at(1).every(t => t === 'melee' || t === 'ranged' || t === 'siege'));
  T('蚀骨兵第 4 波起出现', !at(3).includes('corrupt') && at(4).includes('corrupt'));
  T('术士兵第 6 波起出现', !at(5).includes('warlock') && at(6).includes('warlock'));
  T('图腾兵第 8 波起出现', !at(7).includes('totem') && at(8).includes('totem'));
  T('攻城车第 5 波起出现', !at(4).includes('ram') && at(5).includes('ram'));

  // 支援兵种不应该每波都堆在一起 —— 那样一波兵会变成一支全能小队
  let allThree = 0;
  for (let w = 1; w <= 40; w++) {
    const o = at(w);
    if (o.includes('corrupt') && o.includes('warlock') && o.includes('totem')) allThree++;
  }
  // 越少越好：三个支援同时到场应该是罕见的强攻波，而不是常态
  T(`前 40 波里三个支援兵种同时到场的波次很少（${allThree} 波）`, allThree <= 6);

  // 超级兵仍然只在水晶陷落后出
  T('超级兵仅在水晶陷落后出现',
    !at(20).includes('super') && buildWaveOrder(20, true, gr).includes('super'));
}

console.log(`支援兵种 / 塔互攻 / 出兵编排验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
