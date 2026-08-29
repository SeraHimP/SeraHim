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

  // 用户定稿修正：不是"一次即满层"，而是【每秒 -1，最高 -30】。
  // 上一版我把"叠层直满层"理解成一次到顶，站进范围瞬间 -30 双抗，
  // 等于一个即时 AoE 破甲 —— 强得离谱且没有博弈。
  const stacksOf = (e) =>
    W.fx.getEffects(e.id).find(x => x.blueprint?.statKey === 'armor')?.stacks || 0;
  const iv = c.stackIntervalSec, per = c.resistPerStack, mx = c.maxStacks;
  W.run(iv, [cor]);
  T(`蚀骨·${iv} 秒后只有 1 层（不是一次满层）`, stacksOf(foe) === 1);
  T(`蚀骨·1 层 = -${per} 双抗（护甲 ${CONFIG.templates.melee.armor} → ${W.stats(foe).armor}）`,
    W.stats(foe).armor === CONFIG.templates.melee.armor - per);
  W.run(iv * 4, [cor]);
  T(`蚀骨·逐秒累积（${iv * 5} 秒后 ${stacksOf(foe)} 层）`, stacksOf(foe) === 5);
  // 跑满并越过上限，验证封顶
  W.run(iv * (mx + 10), [cor]);
  const drop = per * mx;
  const fs = W.stats(foe);
  T(`蚀骨·封顶 ${mx} 层 = -${drop} 双抗（护甲 ${fs.armor} / 魔抗 ${fs.magicResist}）`,
    stacksOf(foe) === mx
    && fs.armor === CONFIG.templates.melee.armor - drop
    && fs.magicResist === CONFIG.templates.melee.magicResist - drop);
  T(`蚀骨·上限就是用户定的 -30`, drop === 30);
  // 单层时长必须 > 叠加间隔，否则上一层在下一层叠上来之前就过期，永远停在 1 层
  T(`蚀骨·单层时长 ${c.stackDurationSec}s > 叠加间隔 ${iv}s（否则永远叠不上去）`,
    c.stackDurationSec > iv);
  const as2 = W.stats(ally);
  T('蚀骨·不会削自己人', as2.armor === CONFIG.templates.melee.armor);
  const ffs = W.stats(farFoe);
  T(`蚀骨·范围外（>${c.radius}）不受影响`, ffs.armor === CONFIG.templates.melee.armor);
  const ts = W.stats(foeTower);
  T('蚀骨·"所有敌人"含敌方建筑', ts.armor < CONFIG.templates.tower.armor);
  // 离开范围 → 层数随过期自然消退（这正是"逐秒叠"与"一次满层"的关键差别：
  // 满层实现下离开范围会瞬间清零，玩家完全感受不到腐蚀的持续性）
  foe.pos.x = 99999;
  W.run(c.stackDurationSec + 1, [cor]);
  T(`蚀骨·离开范围后消退（护甲回到 ${W.stats(foe).armor}）`,
    W.stats(foe).armor === CONFIG.templates.melee.armor);
  T('蚀骨·文案写明"所有敌人"与逐秒叠加',
    /所有敌人/.test(SkillLibrary.get('passive_corrupt_strike').description)
    && /每 1 秒/.test(SkillLibrary.get('passive_corrupt_strike').description));
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

  // 防御性场景：塔没有阵营字段（正常游戏里不会出现）时互不攻击，canTarget 自带的
  // "缺阵营即返回 false" 兜底保证了这一点，不需要 selectTarget 自己再判一次
  const W3 = world();
  const s1 = W3.mk('tower', null, 0, 0, 'outer');
  const s2 = W3.mk('tower', null, 80, 0, 'outer');
  s1._mapFaction = undefined; s2._mapFaction = undefined;
  s1._skillInstances.push({ id: ++window._uid, skillId: 'weapon_piercing', state: {} });
  T('无阵营塔互不攻击（canTarget 兜底）', W3.combat.selectTarget(s1, []) === null);

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
  // 起始波次【从编排里读】，不抄数字 —— 用户这轮把它们整体前移了（原 4/6/8/5），
  // 抄一遍就等着下次调编排时又假失败。
  for (const t of ['corrupt', 'warlock', 'totem', 'ram']) {
    const r = gr.laneWaveComposition.find(x => x.type === t);
    T(`${t} 第 ${r.fromWave} 波起出现，之前不出`,
      at(r.fromWave).includes(t) && (r.fromWave <= 1 || !at(r.fromWave - 1).includes(t)));
  }
  T('特殊兵种起始波次都已前移到 4 波以内（用户："降低特殊兵种的生成波次"）',
    ['corrupt', 'warlock', 'totem', 'ram']
      .every(t => gr.laneWaveComposition.find(x => x.type === t).fromWave <= 4));

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

// ==================== 昼夜相位：唯一解析口径 + 不能是 NaN ====================
// 用户报的"时间条不动"就是这里：WorldState 与 WorldHud 都写了
// `CTX.__dayPeriod || DAY_PERIOD`，而 __dayPeriod 是个 **setter 函数**
// （秒数在 __dayPeriodSec）。函数 truthy → period 变成函数 → Math.max(1, fn) = NaN
// → 相位恒 NaN → 游标不动、标签永远"黎明"，而昼夜的数值耦合（isNight 永远 false）
// 其实一直没生效过。而这不报任何错。
{
  const { resolveDayPhase, DAY_PERIOD, phaseLabelOf } =
    await import('../src/presentation/DayNight.js');
  const ctx = {};
  ctx.__dayPeriod = (sec) => { ctx.__dayPeriodSec = sec; };   // 复现真实的 CTX 形状
  for (const t of [0, DAY_PERIOD * 0.25, DAY_PERIOD * 0.5, DAY_PERIOD * 0.75, 2508]) {
    const r = resolveDayPhase(t, ctx, true);
    T(`相位在 t=${Math.round(t)}s 是有限数（${r.phase.toFixed(3)}）`, Number.isFinite(r.phase));
  }
  T('相位随时间推进（时间条会动）',
    resolveDayPhase(0, ctx, true).phase !== resolveDayPhase(DAY_PERIOD * 0.4, ctx, true).phase);
  T('相位落在 [0,1)', [0, 100, 2508, 99999]
    .every(t => { const p = resolveDayPhase(t, ctx, true).phase; return p >= 0 && p < 1; }));
  T('关键帧标签与相位对应', phaseLabelOf(0) === '黎明' && phaseLabelOf(0.25) === '白昼'
    && phaseLabelOf(0.5) === '黄昏' && phaseLabelOf(0.8) === '夜晚');
  T('天气关闭时锁定在固定时刻（不再随时间跑）',
    resolveDayPhase(0, ctx, false).phase === resolveDayPhase(9999, ctx, false).phase);
  T('__dayPhaseOverride 优先（调试定格）',
    resolveDayPhase(0, { ...ctx, __dayPhaseOverride: 0.75 }, true).phase === 0.75);
  T('自定义周期生效（读 __dayPeriodSec 而不是那个 setter 函数）',
    resolveDayPhase(30, { __dayPeriodSec: 120 }, true).phase === 0.25);

  // 三处必须读同一个函数 —— 各算一遍时"画面白天、数值夜晚"不会报错，只会让人怀疑眼睛
  const fs2 = (await import('fs')).default;
  for (const f of ['src/main.js', 'src/systems/WorldState.js', 'src/ui/WorldHud.js']) {
    T(`${f} 走 resolveDayPhase 统一口径`, /resolveDayPhase\(/.test(fs2.readFileSync(f, 'utf8')));
  }
  T('不再有人读那个 setter 函数当数字用', ['src/systems/WorldState.js', 'src/ui/WorldHud.js']
    .every(f => !/__dayPeriod\s*\)\s*\|\|/.test(fs2.readFileSync(f, 'utf8'))));
}

// ==================== 世界状态小窗：三行版式统一 ====================
// 用户："这三个显示文字不统一"。三行都必须是 [图标 + 中文名] + 色带 + 右侧数值。
{
  const fs2 = (await import('fs')).default;
  const html = fs2.readFileSync('index.html', 'utf8');
  for (const id of ['whTimeRow', 'whWeatherRow', 'whEntropyRow']) {
    T(`${id} 存在于世界状态小窗`, html.includes(`id="${id}"`));
  }
  T('三行都有 [标签][色带][数值] 三列',
    (html.match(/class="wh-label"/g) || []).length === 3
    && (html.match(/class="wh-bar"/g) || []).length === 3
    && (html.match(/class="wh-val"/g) || []).length === 3);
  const hud = fs2.readFileSync('src/ui/WorldHud.js', 'utf8');
  T('熵行右列是百分比、核数移到 tooltip（名字那一列只放名字）',
    /whEntVal/.test(hud) && /row\.title = /.test(hud) && !/\$\{white\}·\$\{red\}·\$\{black\}/.test(hud));
  const wp = fs2.readFileSync('src/ui/WeatherPanel.js', 'utf8');
  T('天气行右列有数值（原先是空白）', /whWeatherVal/.test(wp));
}

console.log(`支援兵种 / 塔互攻 / 出兵编排验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
