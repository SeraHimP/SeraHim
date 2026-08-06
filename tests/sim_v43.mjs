// v43 验收：结构保护规则B / 闪电光束淡入淡出+起点冻结 / 攻城车索敌半径 /
//            手动状态可叠加 / 天气盒随方位角 / 攻速真正生效 / 水晶可攻击 /
//            塔默认魔法伤害+分层覆写贯通 / 穿透型删破甲 / 闪电杖 67% 无视防御
//
// 这一套里有五条是"改动前就错着、只是没人看出来"的口径 bug：
//   · 攻速：面板读 stats.baseAttackSpeed、战斗读 entity.baseStats.baseAttackSpeed；
//   · 塔覆写：createBuilding 用一张八字段白名单，白名单外的覆写全被丢；
//   · 手动状态：蓝图名恒为 '默认状态'，合并键撞车导致后加的顶掉先加的；
//   · 攻城车：索敌半径写死 200 < 自身射程 312；
//   · 天气盒：轴对齐，完全没读方位角。
// 每条都尽量钉"行为形状"而不是某个具体数字。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { CONFIG } = await import('../src/data/Config.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
const readSrc = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** 去掉注释再做源码断言 —— 本仓库栽过好几次"断言匹配到了自己的解释文字"。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function mkTower(ents, tier, lane, faction = 'blue', extra = {}) {
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, ...extra },
    currentHP: (extra.maxHP ?? CONFIG.templates.tower.maxHP),
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier,
    _laneId: lane, faction };
  ents.add(e); return e;
}

// ==================== 一、Q3 结构保护：规则 B ====================
// 用户："如果我手动设置了外塔存在，如果此时内塔不存在的话，水晶塔的结构保护未生效。"
// 定稿 B：同路**任意**前置层级还有活着的塔 → 受保护；全倒光才解除。
// 旧规则（A/LoL 口径）只认紧邻的那个"这张图上存在"的前置层，
// 于是"内塔已拆、把外塔复活回来"时水晶塔仍是裸的 —— 正是用户报的现象。
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const outer = mkTower(ents, 'outer', 'mid');
  const inner = mkTower(ents, 'inner', 'mid');
  const base = mkTower(ents, 'base', 'mid');
  const nl = mkTower(ents, 'nexus_lane', 'mid');

  T('B① 三层齐全时水晶塔受保护', isStructureProtected(ents, base) === true);
  inner.alive = false;
  T('B② 内塔倒、外塔仍在 → 水晶塔【仍】受保护（这就是本次改的那条）',
    isStructureProtected(ents, base) === true);
  outer.alive = false;
  T('B③ 外塔也倒 → 水晶塔暴露', isStructureProtected(ents, base) === false);
  // 用户原话的场景：把外塔"手动设置为存在"（复活），保护必须回来
  outer.alive = true;
  T('B④ 手动复活外塔 → 水晶塔保护恢复（旧规则下这里是裸的）',
    isStructureProtected(ents, base) === true);
  // 召唤水晶：往前扫三层
  T('B⑤ 召唤水晶被更前面的层保护（不止看紧邻的水晶塔）',
    base.alive === true && isStructureProtected(ents, nl) === true);
  base.alive = false;
  T('B⑥ 水晶塔倒但外塔活 → 召唤水晶仍受保护', isStructureProtected(ents, nl) === true);
  outer.alive = false;
  T('B⑦ 同路全灭 → 召唤水晶暴露', isStructureProtected(ents, nl) === false);
  T('B⑧ 最前排的外塔自己永远没有保护者', isStructureProtected(ents, outer) === false);

  // 反证：把"扫全部层"退化回"只看紧邻一层"，B② 必须当场变红
  const src = stripComments(readSrc('../src/systems/FactionSystem.js'));
  T('B⑨ 源码确实是"扫到任意一层活着就 return true"',
    /for \(let i = idx - 1; i >= 0; i--\) \{\s*if \(aliveTier\(LANE_CHAIN\[i\], target\._laneId\)\) return true;/.test(src));
}

// ==================== 二、Q2 闪电光束：淡入 / 目标死立刻淡出 / 起点冻结 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const ps = new ProjectileSystem(ents, bus, null);
  const tgt = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 100, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 100, _skillInstances: [] };
  ents.add(tgt);

  ps.fireBeam({ attackerId: 1, targetId: tgt.id, startX: 0, startY: 0, endX: 100, endY: 0, charge: 0.5, life: 0.4 });
  let b = ps.getBeams()[0];
  T('Q2① 新光束带淡入计时（riseT/riseMax）', b.riseT > 0 && b.riseMax > 0);
  T('Q2② 光束记下了 attackerId（起点高度要按实体查，不能按坐标猜）', b.attackerId === 1);

  // 淡入走完
  ps.update(0.2);
  T('Q2③ 淡入到期后清除标记（之后按满亮度画）', ps.getBeams()[0].riseT === undefined);

  // 目标死亡 → 立刻进入淡出，且用的是更短的 fadeOnDeath
  tgt.alive = false;
  ps.update(0.01);
  b = ps.getBeams()[0];
  const cfgBeam = CONFIG.ui.beam;
  T('Q2④ 目标一死立刻转淡出（不必等 ttl 走完）', b && b.fadeT !== undefined);
  T('Q2⑤ 死亡淡出用的是 fadeOnDeath，且比自然淡出短',
    b && Math.abs(b.fadeMax - cfgBeam.fadeOnDeath) < 1e-9 && cfgBeam.fadeOnDeath < cfgBeam.fadeOut);
  // 走完就没了
  ps.update(cfgBeam.fadeOnDeath + 0.01);
  T('Q2⑥ 淡出走完光束被删除', ps.getBeams().length === 0);

  // 目标活着、只是停止刷新 → 走自然淡出（长的那条）
  const tgt2 = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 100, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 100, _skillInstances: [] };
  ents.add(tgt2);
  ps.fireBeam({ attackerId: 2, targetId: tgt2.id, startX: 0, startY: 0, endX: 100, endY: 0, charge: 1, life: 0.1 });
  ps.update(0.15);
  const b2 = ps.getBeams()[0];
  T('Q2⑦ 目标活着只是停火 → 走较长的自然淡出',
    b2 && Math.abs(b2.fadeMax - cfgBeam.fadeOut) < 1e-9);

  // 渲染层：起点高度必须按 attackerId 查 + 快照兜底（塔死后不塌到地面）
  const fxSrc = stripComments(readSrc('../src/presentation/EffectsLayer.js'));
  T('Q2⑧ 起点高度按实体 id 查并做快照（塔死后不塌到水平面）',
    /_beamStartY/.test(fxSrc) && /MYOF\(b\.attackerId\)/.test(fxSrc));
  T('Q2⑨ 起点不再是无条件的坐标反查',
    !/const sy = MY\(b\.startX, b\.startY\);/.test(fxSrc));
  T('Q2⑩ 透明度 = 淡出 × 淡入', /fadeOut \* fadeIn/.test(fxSrc));
}

// ==================== 三、Q4 攻城车：索敌半径不得小于射程 ====================
{
  const lms = stripComments(readSrc('../src/systems/LaneMovementSystem.js'));
  T('Q4① 索敌半径取 max(仇恨半径, 自身射程)',
    /const acqR = Math\.max\(ACQUISITION_RANGE, range\);/.test(lms)
    && /scanEnemies\(this\.entities, this\.mapSystem, minion, acqR, range\)/.test(lms));
  const ram = CONFIG.templates.ram;
  T('Q4② 攻城车射程确实大于默认仇恨半径（否则这条修复没有意义）',
    ram.attackRange > (CONFIG.tuning?.acquisitionRange ?? 200));
  T('Q4③ 攻城车模板补回了被注释吞掉的两个键',
    ram.bonusAttackSpeedPct === 0 && ram.attackSpeedRatio === 0.667);
  // 攻城模式的机制常量仍由被动定义（拆掉被动即退化为普通车）
  const sw = SkillLibrary.passive_siege_weapon;
  T('Q4④ 攻城模式的全部数值仍在被动里', !!sw
    && sw.TOWER_ATKSPD_MULT > 0 && sw.SELF_DAMAGE_PCT > 0 && sw.TOWER_DAMAGE_MULT > 1);
  T('Q4⑤ 攻城模式状态由被动 onFrame 维护（状态栏可见）',
    typeof sw.onFrame === 'function' && /攻城模式/.test(String(sw.onFrame)));
  // 红线：塔与攻城车共用同一份样式
  const fxSrc = stripComments(readSrc('../src/presentation/EffectsLayer.js'));
  T('Q4⑥ 红线样式集中到 CONFIG.ui.aimLine，塔与攻城车共用',
    /CONFIG\.ui && CONFIG\.ui\.aimLine/.test(fxSrc)
    && (fxSrc.match(/screenW\(AL_W\), red, AL_A/g) || []).length === 2);
  T('Q4⑦ 攻城车不再有自己那份更粗的线宽',
    !/screenW\(0\.9\)/.test(fxSrc) && !/rgba\(255,60,60,0\.55\)/.test(fxSrc));
}

// ==================== 四、Q5 手动状态：同属性必须叠加 ====================
// 合并键 = blueprint.stackKey || name::statKey。手动状态的名字恒为 '默认状态'，
// 不给唯一 stackKey 就必然互相 refresh 掉。
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const e = mkTower(ents, 'outer', 'mid');

  const { AttributeEditor } = await import('../src/ui/AttributeEditor.js');
  const k1 = AttributeEditor._newCustomStackKey();
  const k2 = AttributeEditor._newCustomStackKey();
  T('Q5① 每条手动状态领到互不相同的 stackKey', k1 !== k2);

  const mk = (pct) => ({ name: '默认状态', icon: '📌', kind: 'stat', statKey: 'attackDamage',
    flatValue: 0, percentValue: pct, duration: Infinity, permanent: true,
    stackable: false, stackPolicy: 'refresh', stackKey: AttributeEditor._newCustomStackKey() });

  // 用户的原例：+20% 与 +5%，两条走**同一个** sourceId（模板默认状态就是这么施加的）
  fx.apply(e.id, mk(20), 'template_effect_tier');
  fx.apply(e.id, mk(5), 'template_effect_tier');
  attr.tick();
  const st = attr.calc(e, fx.getEffects(e.id));
  const want = CONFIG.templates.tower.attackDamage * 1.25;
  T(`Q5② +20% 与 +5% 叠成 +25%（实际 ${st.attackDamage.toFixed(1)} / 期望 ${want.toFixed(1)}）`,
    Math.abs(st.attackDamage - want) < 0.01);
  T('Q5③ 两条状态都在（不是一条顶掉另一条）',
    fx.getEffects(e.id).filter(x => x.blueprint.name === '默认状态').length === 2);

  // 反证：不给 stackKey 就会被顶掉 —— 这正是改动前的行为
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
  const e2 = mkTower(ents2, 'outer', 'mid');
  const noKey = (pct) => ({ name: '默认状态', kind: 'stat', statKey: 'attackDamage',
    flatValue: 0, percentValue: pct, duration: Infinity, permanent: true,
    stackable: false, stackPolicy: 'refresh' });
  fx2.apply(e2.id, noKey(20), 'template_effect_tier');
  fx2.apply(e2.id, noKey(5), 'template_effect_tier');
  T('Q5④ 反证：没有 stackKey 时确实只剩一条（改动前的 bug 形状）',
    fx2.getEffects(e2.id).filter(x => x.blueprint.name === '默认状态').length === 1);

  const ae = stripComments(readSrc('../src/ui/AttributeEditor.js'));
  T('Q5⑤ 三种手动状态（stat/dot/stun）都带 stackKey',
    (ae.match(/stackKey,/g) || []).length >= 3);
}

// ==================== 五、Q6 天气盒必须随方位角变形 ====================
{
  const wl = stripComments(readSrc('../src/presentation/WeatherLayer.js'));
  T('Q6① update 收方位角参数', /update\(weather, target, viewW, viewD, dt, azimuthDeg = 0\)/.test(wl));
  T('Q6② 盒子按旋转矩形的外接盒算（|W·cos|+|D·sin|）',
    /B\.hx = Math\.max\(200, \(viewW \* ca \+ viewD \* sa\) \* 0\.5 \* pad\)/.test(wl)
    && /B\.hz = Math\.max\(200, \(viewW \* sa \+ viewD \* ca\) \* 0\.5 \* pad\)/.test(wl));
  const tr = stripComments(readSrc('../src/presentation/ThreeRenderer.js'));
  T('Q6③ 渲染器把 azimuthDeg 传下去了（否则改了也白改）',
    /weatherFx\.update\([\s\S]*?this\.azimuthDeg \|\| 0\)/.test(tr));

  // 数值形状：0° 时退化为旧行为；45° 时两边都被撑大；90° 时长宽互换
  const box = (W, D, az, pad = 1.15) => {
    const r = az * Math.PI / 180, ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
    return { hx: (W * ca + D * sa) * 0.5 * pad, hz: (W * sa + D * ca) * 0.5 * pad };
  };
  const W = 1600, D = 2400;
  const b0 = box(W, D, 0), b45 = box(W, D, 45), b90 = box(W, D, 90);
  T('Q6④ 0° 时与旧的轴对齐盒逐位一致（不改动默认视角的表现）',
    Math.abs(b0.hx - W * 0.5 * 1.15) < 1e-9 && Math.abs(b0.hz - D * 0.5 * 1.15) < 1e-9);
  T('Q6⑤ 45° 时两个方向都被撑大（正是旧版缺角的那个角度）',
    b45.hx > b0.hx && b45.hz > b0.hz);
  T('Q6⑥ 90° 时长宽互换', Math.abs(b90.hx - b0.hz) < 1e-6 && Math.abs(b90.hz - b0.hx) < 1e-6);
}

// ==================== 六、Q7 攻速：面板与实际开火必须同源 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, 'outer', 'mid');
  tw._skillInstances.push({ id: 1, skillId: 'weapon_piercing', state: {} });
  SkillLibrary.weapon_piercing.onEquip(tw.id, tw._skillInstances[0],
    { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus });
  const foe = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 30, y: 0 },
    baseStats: { ...CONFIG.templates.melee, maxHP: 1e7 }, currentHP: 1e7,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    _skillInstances: [], _mapFaction: 'red', faction: 'red' };
  ents.add(foe);

  attr.tick();
  const asBefore = attr.calcAttackSpeedOf(attr.calc(tw, fx.getEffects(tw.id)));
  // 全属性加成 +50%
  fx.apply(tw.id, { name: '全属性', kind: 'stat', statKey: 'allStatsPct', flatValue: 50,
    duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh' }, 'test_allstats');
  attr.tick();
  const statsAfter = attr.calc(tw, fx.getEffects(tw.id));
  const asAfter = attr.calcAttackSpeedOf(statsAfter);
  T(`Q7① 全属性加成确实抬高了攻速（${asBefore.toFixed(3)} → ${asAfter.toFixed(3)}）`, asAfter > asBefore * 1.2);

  // 真正开一炮，看冷却是不是按加成后的攻速设置的
  window.gameTime = 1000; tw._lockUntil = 0; tw.attackCooldown = 0; tw.targetId = foe.id;
  combat.update(0.001);
  T(`Q7② 开火后设的冷却 = 1/加成后攻速（cd=${tw.attackCooldown.toFixed(4)}）`,
    Math.abs(tw.attackCooldown - 1 / asAfter) < 1e-6);
  T('Q7③ 记录的参考攻速也是加成后的值', Math.abs(tw._cdAS - asAfter) < 1e-9);

  // 反证：如果还按 entity.baseStats.baseAttackSpeed 算，冷却会明显更长
  const stale = 1 / attr.calcAttackSpeed(tw.baseStats.baseAttackSpeed,
    statsAfter.bonusAttackSpeedPct || 0, tw.baseStats.attackSpeedRatio || 0.667);
  T(`Q7④ 反证：旧算法的冷却明显更长（${stale.toFixed(4)} vs ${tw.attackCooldown.toFixed(4)}）`,
    stale > tw.attackCooldown * 1.2);

  // 源码层：战斗侧不许再直接读 entity.baseStats.baseAttackSpeed
  for (const f of ['../src/systems/CombatSystem.js', '../src/systems/LaneMovementSystem.js',
                   '../src/core/skills/weapons.js']) {
    T(`Q7⑤ ${f.split('/').pop()} 不再直读 baseStats.baseAttackSpeed`,
      !/baseStats\.baseAttackSpeed/.test(stripComments(readSrc(f))));
  }
  const ui = stripComments(readSrc('../src/ui/UIManager.js'));
  T('Q7⑥ 面板与战斗走同一个函数（不可能再各算各的）',
    /calcAttackSpeedOf\(stats\)/.test(ui));
}

// ==================== 七、Q8 水晶装了武器就能索敌 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const nexus = mkTower(ents, 'nexus_lane', 'mid');
  const foe = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 50, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 500,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    _skillInstances: [], _mapFaction: 'red', faction: 'red' };
  ents.add(foe);
  attr.tick();
  T('Q8① 召唤水晶能索敌到射程内的敌人（旧版被硬闸挡死，恒为 null）',
    combat.selectTarget(nexus, [foe]) === foe);
  const main = mkTower(ents, 'nexus_main', null);
  T('Q8② 水晶枢纽同样可以', combat.selectTarget(main, [foe]) === foe);
  const cs = stripComments(readSrc('../src/systems/CombatSystem.js'));
  T('Q8③ 索敌闸门确实删了',
    !/tower\._mapTier === 'nexus_lane' \|\| tower\._mapTier === 'nexus_main'\) return null/.test(cs));
  T('Q8④ 真正的保险仍在（没装武器的塔连索敌都不进）', /const hasWeapon = /.test(cs));
  // 炮口：水晶本体很大，从几何中心出膛看着像"子弹从石头里钻出来"
  T('Q8⑤ 水晶炮口抬到接近尖端（可软编码）',
    (CONFIG.ui?.muzzle?.nexusTopK ?? 0) > 0);
  const umf = stripComments(readSrc('../src/presentation/UnitMeshFactory.js'));
  T('Q8⑥ 炮口高度用了这个系数', /crystalCy \+ crystalR \* crystalMuzzleK/.test(umf));
}

// ==================== 八、Q9 塔默认魔法伤害 + 分层覆写贯通 ====================
{
  T('Q9① 塔模板默认魔法伤害', CONFIG.templates.tower.attackType === 'magic');
  const mainSrc = stripComments(readSrc('../src/main.js'));
  T('Q9② createBuilding 不再用八字段白名单，改为"模板里有的键都能覆写"',
    /Object\.fromEntries\(Object\.entries\(s\)\.filter\(\(\[k, v\]\) => \(k in tpl\) && v !== undefined\)\)/.test(mainSrc));
  T('Q9③ 固定护盾保留"地图没写就当 0"的既有语义',
    /shieldFixedMax: s\.shieldFixedMax \?\? 0,/.test(mainSrc));
  // 形状验证：模拟 createBuilding 的合成，attackType 必须能被覆写层盖住
  const tpl = CONFIG.templates.tower;
  const s = { maxHP: 1234, attackType: 'true', bulletSpeed: 999, armorPenFlat: 7, notAStat: 1 };
  const built = { ...tpl,
    ...Object.fromEntries(Object.entries(s).filter(([k, v]) => (k in tpl) && v !== undefined)),
    shieldFixedMax: s.shieldFixedMax ?? 0 };
  T('Q9④ attackType 能被覆写（这就是"编辑界面改了没反应"的那条）', built.attackType === 'true');
  T('Q9⑤ 白名单外的其它字段也一起通了', built.bulletSpeed === 999 && built.armorPenFlat === 7);
  T('Q9⑥ 非模板键不会污染 baseStats', built.notAStat === undefined);
  T('Q9⑦ 原白名单字段行为不变', built.maxHP === 1234 && built.shieldFixedMax === 0);
  // 腐蚀型：可选那半按 attackType 走 → 现在默认就是魔法，另一半固定真实
  const corr = String(SkillLibrary.weapon_corrosion.onFrame);
  T('Q9⑧ 腐蚀型 = 可选类型（默认魔法）+ 固定真实，两条独立 DoT',
    /damageType: chosenType/.test(corr) && /damageType: 'true'/.test(corr));
}

// ==================== 九、Q10 穿透型删破甲 / 闪电杖 67% ====================
{
  const wp = SkillLibrary.weapon_piercing;
  T('Q10① 穿透型保留固定 30% 双穿', /flatValue: 30/.test(String(wp.onEquip)));
  T('Q10② 穿透型保留升温', wp.HEAT_MAX_STACKS === 4 && wp.HEAT_PER_STACK === 0.30);
  // 同样要先剥注释：onHit 里留着一段"破甲为什么被删"的说明，直接匹配会打到自己。
  T('Q10③ 穿透型不再叠破甲', !/破甲/.test(stripComments(String(wp.onHit))));
  T('Q10④ 技能说明也去掉了破甲', !/削.*双抗|破甲/.test(wp.description + wp.descTemplate));
  const P = SkillLibrary.weapon_lightning.defaultParams;
  T('Q10⑤ 闪电杖满充无视 67% 防御（原 90%）', P.maxPenPct === 67);
  T('Q10⑥ 闪电杖其余数值未改（用户："剩下不改"）',
    P.chargeTimeAtAS1 === 12 && P.tickPct === 20 && P.tickPerSec === 4
    && P.maxMult === 180 && P.grievousPct === 40 && P.bonusVsShieldPct === 7);
  T('Q10⑦ 闪电杖说明同步到 67%',
    /67%/.test(SkillLibrary.weapon_lightning.description) && !/90%/.test(SkillLibrary.weapon_lightning.description));

  // 行为形状：同一发攻击，删破甲之后对有抗性的目标伤害必然更低
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const tw = mkTower(ents, 'outer', 'mid');
  tw._skillInstances.push({ id: 1, skillId: 'weapon_piercing', state: {} });
  wp.onEquip(tw.id, tw._skillInstances[0],
    { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus });
  const foe = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 30, y: 0 },
    baseStats: { ...CONFIG.templates.melee, maxHP: 1e7, armor: 0, magicResist: 0 }, currentHP: 1e7,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    _skillInstances: [], _mapFaction: 'red', faction: 'red' };
  ents.add(foe);
  for (let i = 0; i < 4; i++) { attr.tick(); combat.performAttack(tw, foe); }
  attr.tick();
  const fs2 = attr.calc(foe, fx.getEffects(foe.id));
  T('Q10⑧ 连打 4 发后目标双抗一点没掉（破甲确实没了）',
    fs2.armor === 0 && fs2.magicResist === 0);
}

// ==================== 十、Q5(b) 出兵编排 = 阵营 × 路 的二维网格 ====================
// 用户："出兵编排应该是每一路+每阵营都可调整，特别注意！每个地图的路数不同，UI上记得做区分！"
// 改动前只有"阵营"一维，三路共用一份。
{
  const { compositionFor, hasLaneComposition } = await import('../src/data/waveComposition.js');
  const { buildWaveOrder } = await import('../src/data/waveComposition.js');
  const gr = CONFIG.gameRules;
  const base = gr.laneWaveComposition;
  // 备份，测完还原 —— 别把全局配置弄脏，后面的套件还要用
  const bakLane = gr.laneWaveCompositionByLane;
  const bakFO = CONFIG.factionOverrides;
  gr.laneWaveCompositionByLane = { top: [{ type: 'melee', count: 9 }] };
  CONFIG.factionOverrides = {
    red:  { laneWaveComposition: [{ type: 'ranged', count: 7 }] },
    blue: { laneWaveCompositionByLane: { bot: [{ type: 'siege', count: 5 }] } },
  };

  T('Q5b① 共享·某一路 压过 共享·基准', compositionFor(null, gr, 'top')[0].count === 9);
  T('Q5b② 没配过的路仍然跟随共享基准', compositionFor(null, gr, 'mid') === base);
  T('Q5b③ 阵营·全部路 压过 共享·某一路（阵营是外层键）',
    compositionFor('red', gr, 'top')[0].count === 7);
  T('Q5b④ 阵营·某一路 最优先', compositionFor('blue', gr, 'bot')[0].count === 5);
  T('Q5b⑤ 该阵营没配的路落到共享·该路', compositionFor('blue', gr, 'top')[0].count === 9);
  T('Q5b⑥ 该阵营没配的路、共享也没配 → 落到基准',
    compositionFor('blue', gr, 'mid') === base);
  T('Q5b⑦ hasLaneComposition 只认本格', hasLaneComposition('blue', 'bot') === true
    && hasLaneComposition('blue', 'top') === false && hasLaneComposition(null, 'top') === true);

  // 真正出兵也必须跟着走（buildWaveOrder 从 ctx.laneId 取路）
  const orderTop = buildWaveOrder(1, false, gr, 'blue', { laneId: 'top' });
  const orderBot = buildWaveOrder(1, false, gr, 'blue', { laneId: 'bot' });
  T('Q5b⑧ 同一波、同阵营、不同路的出兵序列确实不同',
    orderTop.length === 9 && orderBot.length === 5
    && orderTop.every(t => t === 'melee') && orderBot.every(t => t === 'siege'));

  // 编辑器：作用域读写 + 清除本格
  const { AttributeEditor } = await import('../src/ui/AttributeEditor.js');
  AttributeEditor._factionScope = 'red'; AttributeEditor._waveLaneScope = 'top';
  T('Q5b⑨ 只读时显示"实际会生效的那一份"（红方·全部路）',
    AttributeEditor._woList(false)[0].type === 'ranged');
  AttributeEditor._woList(true)[0].count = 42;
  T('Q5b⑩ 一动手就复制成本格专属', compositionFor('red', gr, 'top')[0].count === 42);
  T('Q5b⑪ 同阵营的其它路不受影响', compositionFor('red', gr, 'bot')[0].count === 7);
  AttributeEditor._woClearCell();
  T('Q5b⑫ 清除本格后回到继承的那一份', compositionFor('red', gr, 'top')[0].count === 7);
  T('Q5b⑬ 路页签按当前地图现生成（拿不到地图时退回三路）',
    JSON.stringify(AttributeEditor._mapLaneIds()) === JSON.stringify(['top', 'mid', 'bot']));

  const ae = stripComments(readSrc('../src/ui/AttributeEditor.js'));
  T('Q5b⑭ UI 上确实有路页签，且不是写死的三路',
    /data-wo-lane=/.test(ae) && /_mapLaneIds\(\)/.test(ae) && /m\?\.lanes \|\| \[\]/.test(ae));

  gr.laneWaveCompositionByLane = bakLane; CONFIG.factionOverrides = bakFO;
  AttributeEditor._factionScope = 'shared'; AttributeEditor._waveLaneScope = 'all';
}

// ==================== 十一、Q8(下) 腐蚀型改成 3D 雾 ====================
{
  const cl = stripComments(readSrc('../src/presentation/CorrosionLayer.js'));
  T('Q8⑦ 用的是球体网格，不是 2D 环', /new THREE\.SphereGeometry\(1,/.test(cl));
  T('Q8⑧ 雾的观感靠"双面 + 不写深度 + 低透明"', /depthWrite: false, side: THREE\.DoubleSide/.test(cl));
  T('Q8⑨ 常驻球半径 = 有效射程', /scale\.setScalar\(range\)/.test(cl));
  T('Q8⑩ 只有射程内有敌人才发波', /if \(hasFoe\) \{/.test(cl) && /hasFoe = true; break;/.test(cl));
  T('Q8⑪ 发波节奏 = 1/当前攻速（与 weapon_corrosion 的叠层节奏同源）',
    /const interval = 1 \/ Math\.max\(0\.1, as\);/.test(cl));
  T('Q8⑫ 没兵时只留更淡的常驻雾', /const want = hasFoe \? domeBusy : domeIdle;/.test(cl));
  T('Q8⑬ 波数有硬上限（极端攻速不会堆爆网格）', /rec\.waves\.length < maxWaves/.test(cl));
  T('Q8⑭ 塔没了/换武器会回收网格', /this\.scene\.remove\(rec\.dome\)/.test(cl));
  const c = CONFIG.ui.corrosionFx;
  T('Q8⑮ 全部数值软编码', !!c && c.domeAlphaIdle < c.domeAlphaBusy
    && c.maxWaves >= 1 && c.waveLife > 0 && c.waveStartK >= 0 && c.waveStartK < 1);
  const fx = stripComments(readSrc('../src/presentation/EffectsLayer.js'));
  T('Q8⑯ 旧的 2D 同心环已从 EffectsLayer 移除', !/CORROSION_RINGS/.test(fx));
  const tr = stripComments(readSrc('../src/presentation/ThreeRenderer.js'));
  T('Q8⑰ 渲染器驱动新层，且复用 EffectsLayer 的武器缓存',
    /this\.corrosionFx\.update\(this\.deps/.test(tr) && /this\.fx\._weaponOf\(t\)/.test(tr));
}

// ==================== 十二、Q1 所有窗口统一为模板编辑器样式 ====================
// 用户："所有窗口UI都统一为新版的模板编辑器样式（左侧栏那种的）。"
// 钉的是**结构**（左侧 .tpl-nav + 右侧 .tpl-pane），不钉具体像素/文案。
{
  const shell = stripComments(readSrc('../src/ui/dialogShell.js'));
  T('Q1① 有一份共用外壳模块', /export function paneHtml/.test(shell) && /export function shellHtml/.test(shell));
  T('Q1② 外壳沿用模板编辑器已有的类名，不另起一套 CSS',
    /tpl-layout/.test(shell) && /tpl-nav/.test(shell) && /tpl-pane/.test(shell));
  T('Q1③ 没有分组时不摆只有一项的假侧栏', /const hasNav = groups\.length > 0;/.test(shell));
  // ⚠️ 这条是本轮教训：外壳模块最初写出来之后，四个弹窗其实是**手写标记**的，
  // 谁也没 import 它 —— 也就是说我造了一个死模块，还给它写了断言。
  // 死代码守卫（sim_deadcode）当场抓到。现在钉"确实有人在调它"。
  for (const f of ['SettingsDialog', 'UnitAddDialog', 'ModeDialog', 'DetailModal']) {
    T(`Q1④ ${f} 真的调用了外壳模块（不是手写同款标记）`,
      /from '\.\/dialogShell\.js'/.test(stripComments(readSrc(`../src/ui/${f}.js`))));
  }

  const need = (name, src, checks) => {
    for (const [label, re] of checks) T(`Q1 ${name}：${label}`, re.test(src));
  };
  need('设置面板', stripComments(readSrc('../src/ui/SettingsDialog.js')), [
    ['走 paneHtml 出侧栏', /paneHtml\(\{[\s\S]*?navAttr: 'settab'/],
    ['_TABS 直接当导航源（页签定义只有一处）', /groups: \[\{ items: this\._TABS \}\]/],
  ]);
  need('添加单位', stripComments(readSrc('../src/ui/UnitAddDialog.js')), [
    ['走 paneHtml 出侧栏', /paneHtml\(\{[\s\S]*?navAttr: 'uadnav'/],
    ['兵种作为侧栏子项缩进（不再是第二排横页签）', /child: true/],
    ['子项 key 与主分类 key 同一套（避免两层选中错位）', /k\.startsWith\('minion:'\)/],
  ]);
  need('天气面板', stripComments(readSrc('../src/ui/WeatherPanel.js')), [
    ['左侧栏结构', /<div class="tpl-layout">/],
    ['外框换成 modal-box + editor-container（原来是第三套 .modal 壳）', /<div class="modal-box"[\s\S]*?editor-container/],
    ['切页只切 display，不重建 DOM（保住既有绑定与逐帧重绘）', /d\.style\.display = d\.dataset\.wxsec === this\._cfgSec/],
  ]);
  need('模式选择', stripComments(readSrc('../src/ui/ModeDialog.js')), [
    ['走 paneHtml 出侧栏', /paneHtml\(\{[\s\S]*?navAttr: 'modenav'/],
    ['两段内容各自成页', /data-modenav/],
  ]);
  need('详情框', stripComments(readSrc('../src/ui/DetailModal.js')), [
    ['走 shellHtml（它自带 overlay，要完整外框）', /shellHtml\(\{/],
    ['单页 → 不传 groups', /body: contentHtml, crumb: ''/],
  ]);
  T('Q1⑤ 详情框确实没有侧栏（一项的导航是纯装饰）',
    !/tpl-nav/.test(stripComments(readSrc('../src/ui/DetailModal.js'))));
}

console.log(`v43验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
