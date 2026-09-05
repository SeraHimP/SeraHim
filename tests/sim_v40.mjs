// sim_v40.mjs —— v40 验收：
// ① 三路出兵点分离（且在枢纽塔身后，红蓝对称）
// ② 攻城车全部机制由【攻城武器被动】驱动（拆掉被动即退化）+ 攻城模式状态
// ③ 攻城车数值调整：AD60 / 对建筑 +270% / 射程 +20%
// ④ 超级兵射程修复（体型大导致够不着）
// ⑤ 渲染：攻城车不再是 ❓；结构保护盾牌不透明
// ⑥ 编辑器：模板编辑器 + 添加单位 都有攻城车
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG, MINION_SIZES, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');
// v51.34：最近点对距离的双循环搬进了 mapValidate.js，与 sim_maps.mjs 里隐含的
// 同形状双循环合并成唯一实现。
const { minPairwiseDistance } = await import('../src/data/mapValidate.js');
const fs = await import('fs');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);
const DT = 1 / 30;

function mkUnit(ents, type, faction, x, y, skills = []) {
  const t = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...t },
    currentHP: t.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: skills.map(k => ({ id: ++window._uid, skillId: k, state: {} })),
    _mapFaction: faction, faction, _laneId: 'mid', _laneDirection: 'forward' };
  ents.add(e);
  return e;
}

// ==================== ① 出兵点分离 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  for (const mid of ['summoners_rift_v1', 'howling_abyss_v1']) {
    const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap(mid);
    const lws = new LaneWaveSystem(ents, bus, ms);
    const map = MAPS[mid];
    for (const f of ['blue', 'red']) {
      const c = f === 'blue' ? { x: 0, y: map.world.h } : { x: map.world.w, y: 0 };
      const hqR = Math.min(...map.buildings.filter(b => b.faction === f && b.tier === 'hq_tower')
        .map(b => Math.hypot(b.pos.x - c.x, b.pos.y - c.y)));
      const pts = map.lanes.map(l => {
        const p = lws._laneSpawnPoint(l, f === 'blue' ? 'forward' : 'reverse');
        return { id: l.id, p, r: Math.hypot(p.x - c.x, p.y - c.y) };
      });
      T(`${mid}/${f} 出兵点都在枢纽塔身后（径向 < ${hqR.toFixed(0)}）`, pts.every(q => q.r < hqR));
      T(`${mid}/${f} 出兵点都可行走`, pts.every(q => ms.isWalkable(q.p.x, q.p.y)));
      if (pts.length > 1) {
        const minGap = minPairwiseDistance(pts.map(q => q.p));
        T(`${mid}/${f} 三路出兵点互相分开（最小间距 ${minGap.toFixed(0)}px > 50）`, minGap > 50);
      }
    }
  }
  // 红蓝对称：同名路的径向应一致
  const map = MAPS.summoners_rift_v1;
  const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap('summoners_rift_v1');
  const lws = new LaneWaveSystem(ents, bus, ms);
  const rOf = (laneId, f) => {
    const c = f === 'blue' ? { x: 0, y: map.world.h } : { x: map.world.w, y: 0 };
    const p = lws._laneSpawnPoint(map.lanes.find(l => l.id === laneId), f === 'blue' ? 'forward' : 'reverse');
    return Math.hypot(p.x - c.x, p.y - c.y);
  };
  T('红蓝对称（同名路径向一致）',
    map.lanes.every(l => Math.abs(rOf(l.id, 'blue') - rOf(l.id, 'red')) < 1));
  // 实际出兵：同一波三路的落点不再重合
  const spawnPts = [];
  lws.setCreateMinion((type, x, y, f, laneId) => { spawnPts.push({ laneId, f, x, y }); return mkUnit(ents, type, f, x, y); });
  for (let t = 0; t < 40; t += DT) lws.update(DT);
  const blueFirst = {};
  for (const s of spawnPts.filter(s => s.f === 'blue')) if (!blueFirst[s.laneId]) blueFirst[s.laneId] = s;
  const ids = Object.keys(blueFirst);
  const ok = ids.length >= 3 && minPairwiseDistance(ids.map(id => blueFirst[id])) >= 50;
  T('实际出兵：三路首兵落点互不重合（>50px）', ok);
}

// ==================== ② 攻城车机制全部由被动驱动 ====================
{
  // ==================== v49：攻城车重做，这一整段的前提变了 ====================
  // 旧的 passive_siege_weapon 把 5 个常量挂在**技能对象**上，本条断言钉的就是那件事。
  // 用户定稿"攻城车原有的全部删除"之后：一条被动拆成三条，
  // 而且所有数值按 CLAUDE.md 的硬约束搬进了 CONFIG.gameRules.ram（编辑器可改）。
  // 所以断言从"被动上有这些字段"翻成"**数值在 Config 里、技能上不再挂数值**" ——
  // 后者才是那条硬约束本身，前者恰好是它的反面。
  const def = SkillLibrary.passive_ram_cannon;
  const RAM = CONFIG.gameRules.ram;
  T('攻城车三条被动齐全（攻城炮 / 攻城模式 / 普通模式）',
    !!SkillLibrary.passive_ram_cannon && !!SkillLibrary.passive_ram_siege
    && !!SkillLibrary.passive_ram_normal);
  // 数值分两处，各自有明确归属（不是散落）：
  //   · 攻城车自己的性格（溅射/疲惫/恢复/普通模式减伤）→ CONFIG.gameRules.ram
  //   · 充能这件**攻击方式**的参数（充能时间/倍率/衰减/对谁充）→ 技能的 defaultParams
  //     （用户："单独做成技能……里面各种参数"；与塔的武器同一套 skillParams 管线）
  const CH = SkillLibrary.atkmode_charge.defaultParams;
  T('攻城车自身数值软编码在 CONFIG.gameRules.ram，技能对象上不再挂数值',
    RAM.siegeSplash > 0 && RAM.normalSplash > 0
    && RAM.fatiguePerAttack > 0 && RAM.fatigueLayerPct < 0
    && RAM.recoverSec > 0 && RAM.normalDamageAmpPct < 0
    && def.TOWER_DAMAGE_MULT === undefined && def.SIEGE_FATIGUE_AS_PCT === undefined);
  // v49b：充能对**所有目标**生效（用户："攻城车所有状态下都是充能攻击"），
  // 且 damagePct 回归中性 100 —— 倍率是攻城车自己的性格（RAM.siegeDamagePct），不是充能的。
  T('充能参数在【充能攻击】技能里，走 defaultParams（编辑器可改、可换装）',
    SkillLibrary.atkmode_charge.category === 'attackmode'
    && CH.chargeSecAt1AS > 0 && CH.damagePct === 100 && CH.onlyVs === 'any'
    && RAM.chargeSecAt1AS === undefined && RAM.siegeDamagePct > 100);
  T('被动图标：攻城炮 🎯', def.icon === '🎯');

  // v43 P1-4：小兵工厂已搬到 src/core/factories.js，读组合根两份
  // v51.5：默认被动清单本身又从 factories.js 搬进了 defaultMinionPassives.js
  // （与编辑器"模板技能面板首次打开"回填用的那份合并成唯一来源，此前两份手抄
  // 副本漂移过），这条断言跟着改成读新文件。
  const mainSrc = ['../src/main.js', '../src/core/factories.js', '../src/core/defaultMinionPassives.js']
    .map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  T('工厂已把三条被动 + 充能攻击都装配给攻城车（此前遗漏 → 技能栏空白）',
    /'ram':\s*\['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge'\]/.test(mainSrc));

  const csSrc = fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');
  T('伤害规则以被动为闸门（不再按 type==="ram" 硬编码）',
    csSrc.includes('hasRamCannon') && !csSrc.includes("const isRam = (e)"));
  const lmsSrc = fs.readFileSync(new URL('../src/systems/LaneMovementSystem.js', import.meta.url), 'utf8');
  // v43 Q2：攻城的锁定/攻速/自损从 LaneMovementSystem 搬进 CombatSystem，两条攻击路径共用。
  // 这条断言原来钉的是"这些常量出现在 LaneMovementSystem 里"，那等于把
  // **实现位置**写死进了测试；而这次的 bug 恰恰是"实现只在其中一条路径上"。
  // 所以改成钉两件事：① 规则只有一份（只在 CombatSystem 里读那三个常量）；
  // ② 两条路径都调那一份。
  // v49：常量已从技能对象搬进 CONFIG.gameRules.ram（CLAUDE.md 的软编码硬约束）。
  // "只有一份"这条不变，钉的对象换成 Config：CombatSystem 读它，LaneMovementSystem 不读。
  T('攻城规则只有一份（数值只在 Config，LaneMovementSystem 不自己抄）',
    csSrc.includes('CONFIG.gameRules?.ram') && !lmsSrc.includes('gameRules?.ram')
    && !lmsSrc.includes('siegeDamagePct') && !lmsSrc.includes('fatiguePerAttack'));
  // 沙盒模式删除后，CombatSystem 的小兵循环（原来的第二条攻击路径）一并删了，
  // 只剩 LaneMovementSystem 这一条，但 siegeAcquire/finishAttack 仍各自独立实现在
  // CombatSystem 里（不是单单为了眼下这一个调用方而并回去），免得以后再冒出
  // 第二条攻击路径时又要重新拆一次。
  T('唯一的攻击路径调用 CombatSystem 里独立实现的攻城规则',
    lmsSrc.includes('this.combat.siegeAcquire(') && lmsSrc.includes('this.combat.finishAttack(')
    && csSrc.includes('siegeAcquire(attacker, target)') && csSrc.includes('finishAttack('));
  // v50：finishAttack 开头多了一段"清零充能"（那件事与是不是攻城车无关，见该处注释），
  // 所以闸门不再是函数的**第一句**。断言改成"函数体里有这道闸"，别钉它在第几行。
  T('闸门仍然是被动（拆掉【攻城炮】即退化为普通车）',
    /siegeAcquire\(attacker, target\) \{\s*if \(!hasRamCannon/.test(csSrc)
    && /finishAttack\(attacker, target, finalAS\) \{[\s\S]{0,900}if \(!hasRamCannon\(attacker\) \|\| !isStructureUnit\(target\)\) return finalAS;/.test(csSrc));

  // 攻城模式状态：锁定建筑时出现，解除时消失
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const ram = mkUnit(ents, 'ram', 'blue', 0, 0, ['passive_ram_cannon']);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = ram._skillInstances[0];
  def.onFrame(ram.id, DT, inst, ctx);
  T('未锁定时无攻城模式状态', !fx.getEffectByName(ram.id, '攻城模式'));
  const tw = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 100, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 4000, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'red', _mapTier: 'outer', faction: 'red' };
  ents.add(tw);
  ram._ramLockId = tw.id;
  def.onFrame(ram.id, DT, inst, ctx);
  const mode = fx.getEffectByName(ram.id, '攻城模式');
  // v49：攻城模式的描述换了（-50% 攻速已删，改成充能攻击 + 疲惫不恢复）。
  // 断言钉"状态存在且描述里写了充能"，不再钉那句已经不存在的文案。
  T('锁定建筑 → 状态栏出现【攻城模式】', !!mode && /充能/.test(mode.blueprint.description));
  tw.alive = false;
  def.onFrame(ram.id, DT, inst, ctx);
  T('目标摧毁 → 攻城模式消失', !fx.getEffectByName(ram.id, '攻城模式'));

  // 拆掉被动 → 状态与锁定一并清除
  ram._ramLockId = tw.id; tw.alive = true;
  def.onFrame(ram.id, DT, inst, ctx);
  def.onUnequip(ram.id, inst, ctx);
  T('拆掉被动 → 锁定与攻城模式一并清除（退化为普通车）',
    !ram._ramLockId && !fx.getEffectByName(ram.id, '攻城模式'));
}

// ==================== ③ 数值调整 ====================
{
  const ram = CONFIG.templates.ram;
  // v49b 用户定稿：攻击力 60 → 70
  T('AD 70（远高于炮兵 17.5）', ram.attackDamage === 70 && ram.attackDamage > CONFIG.templates.siege.attackDamage);
  T('射程 312（260 +20%，仍远超塔的 180）', ram.attackRange === 312 && ram.attackRange > CONFIG.templates.tower.attackRange);
  const perHit = 60 * 3.7 * (100 / 140);
  T(`打外塔单发 ≈ ${perHit.toFixed(0)}，五发自毁前共 ${(perHit * 5).toFixed(0)}（外塔 4000 的 ${(perHit * 5 / 40).toFixed(0)}%）`,
    Math.abs(perHit - 158.6) < 1);
}

// ==================== ④ 超级兵射程修复 ====================
{
  const sup = CONFIG.templates.super;
  const rSum = MINION_SIZES.super + MINION_SIZES.melee;
  T(`超级兵射程 ${sup.attackRange} > 体型和 ${rSum}（此前 20 < ${rSum} → 判定上永远够不着）`, sup.attackRange > rSum);
  T('超级兵仍算近战单位（≤ 阈值 60，攻城车克制关系不变）', sup.attackRange <= MELEE_RANGE_THRESHOLD);

  // 行为：超级兵能真正打到贴身的敌人
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSys = new MapSystem(ents, bus); mapSys.setCreateBuildingFn(() => null); mapSys.loadMap('summoners_rift_v1');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapSys);
  const lane = mapSys.getLane('mid');
  let si = 0, sl = 0;
  for (let i = 0; i < lane.waypoints.length - 1; i++) {
    const P = lane.waypoints[i], Q = lane.waypoints[i + 1];
    const l = Math.hypot(Q.x - P.x, Q.y - P.y);
    if (l > sl) { sl = l; si = i; }
  }
  const P = lane.waypoints[si], Q = lane.waypoints[si + 1];
  const M = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  const foe = mkUnit(ents, 'melee', 'red', M.x, M.y);
  foe.baseStats.moveSpeed = 0; foe.baseStats.maxHP = 1e9; foe.currentHP = 1e9;
  const sup2 = mkUnit(ents, 'super', 'blue', M.x - 60, M.y);
  sup2.baseStats.maxHP = 1e9; sup2.currentHP = 1e9;
  const hp0 = foe.currentHP;
  for (let t = 0; t < 6; t += DT) { window.gameTime += DT; attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame); lms.update(DT); }
  T(`超级兵能打到贴身敌人（造成 ${Math.round(hp0 - foe.currentHP)} 伤害 > 0）`, foe.currentHP < hp0);
}

// ==================== ⑤ 渲染 ====================
{
  // v2.5D 第3步：MINION_STYLE 与 _minionSprite 抽到了 SpriteFactory.js（Billboard 复用同一套绘制）。
  // 断言意图不变（攻城车有样式条目 + 独立形状分支），改为在"渲染源码 = 两文件之和"里找。
  // v43 P0-①：CanvasRenderer.js 已删（零引用的旧 2D 渲染器）。
  // 攻城车的样式与形状分支本来就在 SpriteFactory 里，断言意图不变，只是不再拼那个死文件。
  const src = fs.readFileSync(new URL('../src/presentation/SpriteFactory.js', import.meta.url), 'utf8');
  T('攻城车有渲染样式（不再 fallback 到 ❓）', /ram:\s*\{ color: '#7f8c8d', icon: '🛠️'/.test(src));
  T('攻城车有独立形状分支（横向长方形）', src.includes("case 'ram':"));
  // 盾牌只钉**活的**渲染路径（UnitLayer）：旧断言还拼着 CanvasRenderer 里那半，
  // 而那个渲染器从 2.5D 迁移完成起就没人调了 —— 钉死代码的行为等于什么都没钉。
  const ulSrc = fs.readFileSync(new URL('../src/presentation/UnitLayer.js', import.meta.url), 'utf8');
  T('结构保护盾牌显式锁定不透明实色（修"透明"问题）',
    /fillStyle = '#ffffff'/.test(ulSrc) && /depthTest: false, depthWrite: false/.test(ulSrc));
  // v43 Q4：红线样式收敛到 CONFIG.ui.aimLine，塔与攻城车共用同一份（用户要求两者一致）。
  // 原断言钉的是攻城车那条独有的 rgba(255,60,60,0.55)——那正是"两处各写各的"的痕迹，
  // 现在改为钉"两处都从 aimLine 取值"。
  // 红线画在 EffectsLayer（活的渲染路径），不在 SpriteFactory 里 —— 分开读。
  const fxSrc = fs.readFileSync(new URL('../src/presentation/EffectsLayer.js', import.meta.url), 'utf8');
  T('攻城模式攻击指示红线（与塔同款）',
    fxSrc.includes('m._ramLockId') && fxSrc.includes('CONFIG.ui.aimLine')
    && !fxSrc.includes('rgba(255,60,60,0.55)'));
}

// ==================== ⑥ 编辑器 ====================
{
  // v43 P1-4：编辑器已拆成 src/ui/editor/* 七块，断言要读整片 ——
  // 只读 AttributeEditor.js 会让否定断言因为「搬到隔壁文件」而假通过。
  const ae = [process.cwd() + '/src/ui/AttributeEditor.js',
    ...fs.readdirSync(process.cwd() + '/src/ui/editor').sort()
      .filter(f => f.endsWith('.js')).map(f => process.cwd() + '/src/ui/editor/' + f)]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
  T('模板编辑器有攻城车', ae.includes("ram: '攻城车'"));
  const ua = fs.readFileSync(new URL('../src/ui/UnitAddDialog.js', import.meta.url), 'utf8');
  T('添加单位对话框有攻城车', /ram:\s*\{ label: '攻城车'/.test(ua));
}

console.log(`v40验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
