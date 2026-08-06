/**
 * sim_v44.mjs —— v44 第一批验收
 *
 *   Q1  最大生命变化时当前生命同步跟随（对称扣、可致死）
 *   Q2  攻城武器收归一份实现，对战/沙盒两条攻击路径共用
 *   Q2b 残弹：主目标已死 → 直伤不结算，溅射照常对其他单位结算
 *   补充 中立单位：血条绿色、面板显示「中立」、运维可切到中立
 *   补充 HDR 检测改走现代路径（不再拿一个从未发布的实验 API 当闸门）
 *   补充 巨龙设置面板重做
 *
 * 断言尽量钉**行为**。少数只能钉源码的（渲染层配色、面板 HTML），一律钉
 * **调用点/取值口径**而不是钉某个名字存在 —— 光魂那次的教训：钉定义等于没钉。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow();

const { EventBus } = await import('../src/utils/EventBus.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('v44验收');
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function world() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const buffs = new BuffSystem(fx, ents, bus, combat);
  return { bus, ents, fx, combat, buffs };
}
function mk(ents, type, opts = {}) {
  const tpl = CONFIG.templates[type] || CONFIG.templates.tower;
  const e = {
    id: ++window._uid, type, alive: true, pos: { x: opts.x ?? 0, y: opts.y ?? 0 },
    baseStats: { ...tpl, ...(opts.stats || {}) },
    currentHP: (opts.stats?.maxHP ?? tpl.maxHP), shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
    _skillInstances: (opts.skills || []).map(k => ({ id: ++window._uid, skillId: k, state: {} })),
    _inCombat: false, _attackerCount: 0,
  };
  if (opts.faction) { e._mapFaction = opts.faction; e.faction = opts.faction; }
  if (opts.tier) e._mapTier = opts.tier;
  ents.add(e);
  return e;
}
// 挂一个"改最大生命"的效果
const addMaxHP = (fx, id, flat, key = 'test_maxhp') => fx.apply(id, {
  name: '测试·最大生命', icon: '🧪', kind: 'stat', statKey: 'maxHP',
  flatValue: flat, duration: Infinity, permanent: true,
  stackable: false, stackPolicy: 'refresh', stackKey: key,
}, key);

// ==================== 一、Q1 最大生命 ↔ 当前生命 ====================
{
  const { fx, ents, buffs } = world();
  const t = mk(ents, 'tower', { stats: { maxHP: 4000 } });

  buffs.update(0.1);                       // 首帧：只记基准，不该动血
  T('Q1①-首次见到实体只记基准，不凭空补血', t.currentHP === 4000);

  t.currentHP = 2000;                      // 打掉一半
  const id = addMaxHP(fx, t.id, 500);
  buffs.update(0.1);
  T('Q1②-+500 最大生命 → 当前生命同样 +500', t.currentHP === 2500);
  T('Q1②-最大生命确实变了（否则上一条可能是巧合）',
    attr.calc(t, fx.getEffects(t.id)).maxHP === 4500);

  fx.remove(id);
  buffs.update(0.1);
  T('Q1③-增益移除 → 当前生命对称扣回（用户定稿：对称扣）', t.currentHP === 2000);

  // 满血时加最大生命：补上去之后仍是满血，不会溢出
  t.currentHP = 4000;
  addMaxHP(fx, t.id, 300, 'test_maxhp2');
  buffs.update(0.1);
  T('Q1④-满血时加最大生命仍是满血（不溢出）', t.currentHP === 4300);
}
{
  // 可致死：残血单位身上的最大生命增益一掉就暴毙（用户明确选择"对称扣且可致死"）
  const { fx, ents, buffs, bus } = world();
  const t = mk(ents, 'tower', { stats: { maxHP: 4000 } });
  buffs.update(0.1);
  const id = addMaxHP(fx, t.id, 500);
  buffs.update(0.1);
  t.currentHP = 300;                       // 残血，低于那 500 的增益
  let died = null;
  bus.on('entity:death', ({ entityId }) => { died = entityId; });
  fx.remove(id);
  buffs.update(0.1);
  T('Q1⑤-残血时增益到期 → 扣成 0 并死亡', t.alive === false && t.currentHP === 0);
  T('Q1⑤-死亡走 entity:death 事件（不是静默清零）', died === t.id);
}
{
  // 开关：lethal=false 时保底 1 点
  const { fx, ents, buffs } = world();
  const saved = JSON.parse(JSON.stringify(CONFIG.gameRules.maxHPSync));
  CONFIG.gameRules.maxHPSync.lethal = false;
  const t = mk(ents, 'tower', { stats: { maxHP: 4000 } });
  buffs.update(0.1);
  const id = addMaxHP(fx, t.id, 500);
  buffs.update(0.1);
  t.currentHP = 100;
  fx.remove(id);
  buffs.update(0.1);
  T('Q1⑥-lethal=false 时保底 1 点不致死', t.alive === true && t.currentHP === 1);
  CONFIG.gameRules.maxHPSync = saved;
  T('Q1⑥-数值软编码在 CONFIG.gameRules.maxHPSync（不是写死的行为）',
    typeof CONFIG.gameRules.maxHPSync === 'object'
    && 'enabled' in CONFIG.gameRules.maxHPSync && 'lethal' in CONFIG.gameRules.maxHPSync);
}

// ==================== 二、Q2 攻城武器：一份实现，两条路径 ====================
{
  const { ents, combat } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_siege_weapon'] });
  const tw = mk(ents, 'tower', { faction: 'red', tier: 'outer', x: 100, stats: { maxHP: 4000 } });
  const foe = mk(ents, 'melee', { faction: 'red', x: 10 });

  T('Q2①-未锁定时 siegeAcquire 原样返回调用方的选择', combat.siegeAcquire(ram, foe) === foe);
  T('Q2①-选择了建筑就锁定它', combat.siegeAcquire(ram, tw) === tw && ram._ramLockId === tw.id);
  T('Q2②-锁定后无视其他目标（这就是红线与攻城模式状态的唯一依据）',
    combat.siegeAcquire(ram, foe) === tw);
  tw.alive = false;
  T('Q2③-锁定目标死亡后解除锁定', combat.siegeAcquire(ram, foe) === foe && !ram._ramLockId);
}
{
  const { ents, combat } = world();
  const def = SkillLibrary.passive_siege_weapon;
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_siege_weapon'] });
  const tw = mk(ents, 'tower', { faction: 'red', x: 100 });
  const foe = mk(ents, 'melee', { faction: 'red', x: 10 });
  const hp0 = ram.currentHP;

  const asVsTower = combat.finishAttack(ram, tw, 1.0);
  T('Q2④-打建筑时攻速按被动的倍率下降', Math.abs(asVsTower - def.TOWER_ATKSPD_MULT) < 1e-9);
  T('Q2④-打建筑时自损（比例取自被动定义）',
    Math.abs((hp0 - ram.currentHP) - ram.baseStats.maxHP * def.SELF_DAMAGE_PCT) < 1);

  const hp1 = ram.currentHP;
  const asVsMinion = combat.finishAttack(ram, foe, 1.0);
  T('Q2⑤-打小兵时攻速不变、不自损', asVsMinion === 1.0 && ram.currentHP === hp1);

  // 闸门仍是被动：没装的车什么都不该发生
  const plain = mk(ents, 'ram', { faction: 'blue' });
  const hp2 = plain.currentHP;
  T('Q2⑥-没装被动 → 攻速不变、不自损、不锁定',
    combat.finishAttack(plain, tw, 1.0) === 1.0 && plain.currentHP === hp2
    && combat.siegeAcquire(plain, tw) === tw && !plain._ramLockId);
}
{
  // 自损致死：用户定稿"照常生效，接受自杀"
  const { ents, combat, bus } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_siege_weapon'] });
  const tw = mk(ents, 'tower', { faction: 'red', x: 100 });
  let died = null;
  bus.on('entity:death', ({ entityId }) => { died = entityId; });
  const def = SkillLibrary.passive_siege_weapon;
  const hits = Math.ceil(1 / def.SELF_DAMAGE_PCT);
  for (let i = 0; i < hits && ram.alive; i++) combat.finishAttack(ram, tw, 1.0);
  T(`Q2⑦-自损 ${(def.SELF_DAMAGE_PCT * 100)}%/次 → ${hits} 下自尽（用户定稿：接受自杀）`,
    ram.alive === false && died === ram.id);
}
{
  // 两条攻击路径都调同一份（这条是本次 bug 的形状：实现只在其中一条路上）
  const cs = srcOf('src/systems/CombatSystem.js');
  const lms = srcOf('src/systems/LaneMovementSystem.js');
  T('Q2⑧-规则只有一份：常量只在 CombatSystem 里读',
    cs.includes('TOWER_ATKSPD_MULT') && cs.includes('SELF_DAMAGE_PCT')
    && !lms.includes('TOWER_ATKSPD_MULT') && !lms.includes('SELF_DAMAGE_PCT'));
  T('Q2⑧-对战路径（LaneMovementSystem）调它',
    lms.includes('this.combat.siegeAcquire(') && lms.includes('this.combat.finishAttack('));
  T('Q2⑧-沙盒路径（CombatSystem 小兵循环）也调它',
    cs.includes('this.siegeAcquire(minion, nearestTower)')
    && cs.includes('this.finishAttack(minion, nearestTower'));
}

// ==================== 三、Q2b 残弹：目标已死仍结算溅射 ====================
{
  const { ents, combat } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_siege_weapon'],
                                stats: { splashRadius: 80 } });
  const bystander = mk(ents, 'melee', { faction: 'red', x: 30, y: 0 });
  const far = mk(ents, 'melee', { faction: 'red', x: 900, y: 0 });
  const hpB = bystander.currentHP, hpF = far.currentHP;

  // 伪造一发已经在飞的子弹的 pendingHit（主目标已经不在了）
  const hitInfo = { attackerId: ram.id, targetId: 99999, baseDamage: 100, onHitFixed: 0,
                    onHitPctBase: 0, dmgAmp: 0, preDamageMult: 1, attackType: 'physical',
                    weaponId: null, weaponInstId: null };
  combat.resolveSplashOnlyAt(hitInfo, 0, 0);
  T('Q2b①-主目标已死，落点附近的其他单位照常吃溅射', bystander.currentHP < hpB);
  T('Q2b①-范围之外的不受影响', far.currentHP === hpF);
}
{
  // 没有溅射能力的单位：残弹就是什么也不做（不能凭空多出直伤）
  const { ents, combat } = world();
  const t = mk(ents, 'tower', { faction: 'blue', stats: { splashRadius: 0 } });
  const foe = mk(ents, 'melee', { faction: 'red', x: 20 });
  const hp = foe.currentHP;
  combat.resolveSplashOnlyAt({ attackerId: t.id, targetId: 99999, baseDamage: 100,
    onHitFixed: 0, onHitPctBase: 0, dmgAmp: 0, preDamageMult: 1,
    attackType: 'physical', weaponId: null }, 0, 0);
  T('Q2b②-无溅射能力的单位：残弹不造成任何伤害（直伤不会凭空冒出来）', foe.currentHP === hp);
}
{
  const ps = srcOf('src/systems/ProjectileSystem.js');
  T('Q2b③-ProjectileSystem 在目标已死的分支上真的调了溅射结算（钉调用点，不钉定义）',
    /this\.combat\.resolveSplashOnlyAt\?\.\(p\.pendingHit, p\.lastTx, p\.lastTy\)/.test(ps));
}
{
  // 顺带修好的：龙的溅射此前从没生效过（闸门与攻城武器被动绑死）
  const cs = srcOf('src/systems/CombatSystem.js');
  T('Q2b④-溅射闸门改为"模板写了 splashRadius 就溅射"（巨龙的溅射因此才真正生效）',
    /const splashR = attacker\.baseStats\?\.splashRadius \|\| 0;\s*if \(splashR > 0\)/.test(cs));
  T('Q2b④-攻城车"只对塔有额外增幅"仍成立（倍率只在装了被动时除回）',
    /\(atkSiege && isStructureUnit\(target\)\) \? totalRaw \/ atkSiege\.TOWER_DAMAGE_MULT/.test(cs));
}

// ==================== 四、中立单位 ====================
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('中立①-血条颜色按阵营判定，中立走绿色（不再按 type 分叉）',
    /faction === 'blue' \? '#4a9eff'/.test(ul) && /faction === 'red' \? '#ff5a5a'/.test(ul)
    && /'#4caf50';\s*\/\/ 中立一律绿色/.test(ul));
  const um = srcOf('src/ui/UIManager.js');
  T('中立②-面板徽标有三档（原来是个没有第三档的三元，非蓝一律显示红方）',
    /FAC_BADGE = \{[\s\S]*blue:[\s\S]*red:[\s\S]*neutral:/.test(um));
  const pe = srcOf('src/ui/editor/pagesEntity.js');
  T('中立③-运维页有「中立」按钮', /data-op="fac" data-v="neutral"/.test(pe));
  T('中立③-切阵营的白名单也放行 neutral（否则按钮点了静默失败）',
    /v !== 'blue' && v !== 'red' && v !== 'neutral'/.test(pe));
  T('中立④-标签表补了 neutral', /neutral: '⚪ 中立'/.test(pe));
}

// ==================== 五、HDR 检测 ====================
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('HDR①-不再拿 configureHighDynamicRange 当闸门（它是个从未发布的实验 API，恒为 undefined）',
    !/if \(typeof this\.canvas\.configureHighDynamicRange !== 'function'\) return false;/.test(tr));
  T('HDR②-hdrSupported 委托给逐项诊断', /hdrSupported\(\) \{ return this\.hdrDiagnose\(\)\.ok; \}/.test(tr));
  T('HDR③-诊断是**真的试一次**色彩空间，而不是查属性在不在',
    /ctx\.drawingBufferColorSpace = want;/.test(tr)
    && /out\.colorSpace = \(ctx\.drawingBufferColorSpace === want\)/.test(tr));
  T('HDR④-开启时真的设了 HDR 传输函数（只换 RGBA16F 缓冲不设色彩空间＝开了也看不出来）',
    /for \(const cs of \[want1, 'display-p3'\]\)/.test(tr));
  T('HDR⑤-force 可以跳过能力检查强制尝试（用户："可以强制开启"）',
    /if \(want && !forced && !this\.hdrSupported\(\)\) want = false;/.test(tr));
  T('HDR⑥-退到 display-p3 时不顶曝光（那一档没有 SDR 白点之上的余量）',
    /const trueHDR = this\.hdrOn && \/\^rec2100\/\.test\(this\.hdrMode \|\| ''\);/.test(tr));
  T('HDR⑦-色彩空间软编码进 CONFIG', typeof CONFIG.ui.hdr.colorSpace === 'string');
  const sd = srcOf('src/ui/SettingsDialog.js');
  T('HDR⑧-面板不再只说一句"浏览器不支持"，而是分情况给出下一步',
    /enable-experimental-web-platform-features/.test(sd) && /_hdrDiagHtml/.test(sd));
  T('HDR⑨-落到广色域时照实说，不冒充真 HDR',
    /广色域已开（非真 HDR/.test(sd));
}

// ==================== 六、巨龙设置面板 ====================
{
  const sd = srcOf('src/ui/SettingsDialog.js');
  T('巨龙①-面板渲染与事件绑定成对存在',
    /_dragonPanelHtml\(ds, ents\)/.test(sd) && /_bindDragonEvents\(overlay, ds, ents, logFn, render\)/.test(sd));
  T('巨龙②-面板真的被调用（不是写了个没人用的方法）',
    /SettingsDialog\._dragonPanelHtml\(dragonSystem, entityContainer\)/.test(sd)
    && /SettingsDialog\._bindDragonEvents\(overlay, dragonSystem, entityContainer, logFn, render\)/.test(sd));
  T('巨龙③-节奏输入写回 CONFIG，不再是写倒计时剩余值',
    /CONFIG\.gameRules\.dragon\.elementIntervals = \[v\]/.test(sd)
    && /CONFIG\.gameRules\.dragon\[k\] = v/.test(sd));
  T('巨龙④-有生成/效果两个独立开关（对应 CONFIG.dragonToggles 的两项）',
    /CONFIG\.dragonToggles\.spawn/.test(sd) && /CONFIG\.dragonToggles\.effect/.test(sd));
  T('巨龙⑤-即时操作齐备：刷一条 / 清场 / 判魂 / 清进度',
    /setDragonSpawnNowBtn/.test(sd) && /setDragonKillAllBtn/.test(sd)
    && /setDragonSoulBlueBtn/.test(sd) && /setDragonResetBtn/.test(sd));
  T('巨龙⑥-清场走 entity:death（绕过去的话"编辑器杀的龙不给奖励"，两套行为）',
    /ds\.eventBus\?\.emit\?\.\('entity:death'/.test(sd));
  T('巨龙⑦-展示双方争夺进度（旧面板完全没有这一层信息）',
    /还差 \$\{need\} 条成魂/.test(sd));
}

done();
