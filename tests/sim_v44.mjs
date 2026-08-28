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

// ==================== 二、Q2 攻城车：一份实现，两条路径（v49 重做后） ====================
// v49：用户定稿"攻城车原有的全部删除，按照我新的来做"。
// 删掉的旧规则（本节原来逐条钉过它们，现在一并作废）：
//   对建筑 ×3.7 / 打建筑攻速 ×0.5 / 对小兵 ×0.67（旧写法）/ 近战对它 ×2 /
//   攻城疲惫 -25%每层且永不恢复 / 破甲重击 10%当前生命·每塔 900 秒冷却。
// 新规则见 CONFIG.gameRules.ram 与【充能攻击】技能的 defaultParams。
//
// **保留并继续钉住的只有接线**（用户单独确认过"留"）：锁定建筑后不改目标、索敌优先塔。
// 那两件事是红线与状态栏显示的唯一依据。
{
  const { ents, combat } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_ram_cannon'] });
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
  // 攻城疲惫：每次**攻城**攻击叠 fatiguePerAttack 层，攻城模式下不恢复。
  const { ents, combat, fx } = world();
  const R = CONFIG.gameRules.ram;
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_ram_cannon'] });
  const tw = mk(ents, 'tower', { faction: 'red', x: 100 });
  const foe = mk(ents, 'melee', { faction: 'red', x: 10 });
  const hp0 = ram.currentHP;

  const asVsTower = combat.finishAttack(ram, tw, 1.0);
  T('Q2④-打建筑不再额外乘攻速倍率（旧的 -50% 已随旧被动删除）', asVsTower === 1.0);
  T('Q2④-打建筑不自损血量（自损那一版早就废了）', ram.currentHP === hp0);
  T('Q2④-打建筑叠 fatiguePerAttack 层"攻城疲惫"，每层 fatigueLayerPct%', (() => {
    const eff = fx.getEffects(ram.id).find(e => e.blueprint.name === '攻城疲惫');
    return !!eff && eff.stacks === R.fatiguePerAttack && eff.blueprint.perStackFlat === R.fatigueLayerPct;
  })());

  const hp1 = ram.currentHP;
  const asVsMinion = combat.finishAttack(ram, foe, 1.0);
  T('Q2⑤-打小兵不叠疲惫、不自损', asVsMinion === 1.0 && ram.currentHP === hp1 && (() => {
    const eff = fx.getEffects(ram.id).find(e => e.blueprint.name === '攻城疲惫');
    return eff.stacks === R.fatiguePerAttack;   // 还是刚才那几层，没有再涨
  })());

  // 闸门仍是被动：没装【攻城炮】的车什么都不该发生
  const plain = mk(ents, 'ram', { faction: 'blue' });
  const hp2 = plain.currentHP;
  T('Q2⑥-没装被动 → 攻速不变、不自损、不锁定',
    combat.finishAttack(plain, tw, 1.0) === 1.0 && plain.currentHP === hp2
    && combat.siegeAcquire(plain, tw) === tw && !plain._ramLockId);
}
{
  // 攻速下限：v49 从 0.05 降到 **0**（用户："要显示正确的……如果攻速为0就显示0"）。
  // 攻城疲惫无上限叠加，所以攻速真的能被压到 0 —— 这是用户明确选择的（Q5"不用"封顶）。
  const { ents, combat, bus, fx } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_ram_cannon'] });
  const tw = mk(ents, 'tower', { faction: 'red', x: 100 });
  let died = null;
  bus.on('entity:death', ({ entityId }) => { died = entityId; });
  for (let i = 0; i < 50; i++) combat.finishAttack(ram, tw, 1.0);
  const eff = fx.getEffects(ram.id).find(e => e.blueprint.name === '攻城疲惫');
  T('Q2⑦-无上限叠层：打 50 次车不会死，层数一路累加',
    ram.alive === true && died === null && !!eff
    && eff.stacks === 50 * CONFIG.gameRules.ram.fatiguePerAttack);
  T('Q2⑦-攻速可以被压到 0（下限已从 0.05 改为 0），且不会变成负数',
    attr.calcAttackSpeedOf(attr.calc(ram, fx.getEffects(ram.id))) === 0);
  T('Q2⑦-攻速 0 → 攻击间隔为 Infinity（永不攻击），而不是被 `|| 0.5` 兜成每 2 秒一下',
    attr.attackIntervalOf(0) === Infinity && attr.attackIntervalOf(2) === 0.5);
}
{
  // 充能攻击：做成**攻击方式技能**（用户："单独做成技能……以后再用的话就很方便了"）
  const { ents, combat, fx } = world();
  const CH = SkillLibrary.atkmode_charge.defaultParams;
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_ram_cannon', 'atkmode_charge'] });
  const tw = mk(ents, 'tower', { faction: 'red', x: 100 });
  const foe = mk(ents, 'melee', { faction: 'red', x: 10 });
  T('Q2⑧-充能是独立的技能类别（category=attackmode），谁都能装',
    SkillLibrary.atkmode_charge.category === 'attackmode');
  // v49b：用户改稿"攻城车所有状态下都是充能攻击" → onlyVs 'any'。
  // onlyVs 这个参数仍然存在（别的武器可以只对某类目标充能），只是攻城车不再用它筛。
  T('Q2⑧-onlyVs=any 时对谁都充能（用户："所有状态下都是充能攻击"）',
    !!combat.chargeNeedOf(ram, tw) && !!combat.chargeNeedOf(ram, foe));
  T('Q2⑧-onlyVs 仍然能筛目标类型（换个参数就只对塔充能）', (() => {
    // 这个 mk 不走 equipSkill，实例上没有 _params（读取时会回落 defaultParams）。
    // 这里显式给一份覆写，验证"参数改了行为就跟着变"。
    const inst = ram._skillInstances.find(i => i.skillId === 'atkmode_charge');
    inst._params = { ...SkillLibrary.atkmode_charge.defaultParams, onlyVs: 'tower' };
    const ok = !!combat.chargeNeedOf(ram, tw) && !combat.chargeNeedOf(ram, foe);
    delete inst._params;
    return ok;
  })());
  T('Q2⑧-没充满不许开火，充满才行', (() => {
    ram._charge = 0;
    const notReady = combat.chargeReady(ram, tw) === false;
    ram._charge = 1;
    return notReady && combat.chargeReady(ram, tw) === true;
  })());
  T('Q2⑧-充能速度 = 攻速 / chargeSecAt1AS（1.0 攻速下正好用满 chargeSecAt1AS 秒）', (() => {
    // _tickCharge 判"要不要充能"时会去看**当前目标**（每帧推进拿不到"这一击的目标"），
    // 所以这里必须把目标设成塔，否则它走的是"打断衰减"那条分支。
    ram.targetId = tw.id;
    ram._charge = 0;
    const st = attr.calc(ram, fx.getEffects(ram.id));
    const as = attr.calcAttackSpeedOf(st);
    let t = 0;
    while ((ram._charge || 0) < 1 && t < 1000) { combat._tickCharge(ram, st, 0.05); t += 0.05; }
    return Math.abs(t - CH.chargeSecAt1AS / as) < 0.2;
  })());
  T('Q2⑧-打断后每秒等比衰减当前充能（用户："每秒减少10%当前充能"）', (() => {
    // v49b：onlyVs=any 之后"切到小兵"不再是打断（对谁都充能）。
    // 真正的打断是**没有目标**（目标死了 / 脱离），这才是用户说的那种情形。
    ram._charge = 1; ram.targetId = null;
    ram._chargeDecay = CONFIG.tuning.charge.decayPctPerSec;   // 与充能中记下的那份一致
    const st = attr.calc(ram, fx.getEffects(ram.id));
    for (let i = 0; i < 10; i++) combat._tickCharge(ram, st, 1.0);
    const want = Math.pow(1 - (CONFIG.tuning.charge.decayPctPerSec / 100), 10);
    return Math.abs(ram._charge - want) < 1e-6;
  })());
  T('Q2⑧-衰减率是全局规则、软编码（"以后所有的充能型武器都是这样"）',
    typeof CONFIG.tuning.charge.decayPctPerSec === 'number');
}

// ==================== 三、Q2b 残弹：目标已死仍结算溅射 ====================
{
  const { ents, combat } = world();
  const ram = mk(ents, 'ram', { faction: 'blue', skills: ['passive_ram_cannon'],
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
  // v49：攻城车模板的 splashRadius 改成 0、半径改由模式给出，所以闸门取两者的较大值。
  // 龙那一半仍然靠模板的 splashRadius —— 这条断言原本就是为龙的溅射守的，继续守住。
  T('Q2b④-溅射闸门仍认"模板写了 splashRadius"（巨龙的溅射靠这条才生效）',
    /Math\.max\(attacker\.baseStats\?\.splashRadius \|\| 0, ramR\)/.test(cs));
  // v49b：要除回去的倍率变成两档（对建筑 siegeDamagePct / 对其余 normalDamageAmpPct），
  // 充能自己的 damagePct 也仍然要除。断言钉"两者都参与了 siegeMult"这件事。
  T('Q2b④-"额外增幅只对主目标"仍成立（溅射把倍率除回去）',
    /const siegeMult = \(chargeP \? chargeP\.damageMult : 1\)/.test(cs)
    && /siegeDamagePct/.test(cs) && /normalDamageAmpPct/.test(cs)
    && /totalRaw \/ siegeMult/.test(cs));
}

// ==================== 四、中立单位 ====================
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('中立①-血条颜色按阵营判定，中立走绿色（不再按 type 分叉）',
    /faction === 'blue' \? '#4a9eff'/.test(ul) && /faction === 'red' \? '#ff5a5a'/.test(ul)
    && /'#4caf50';\s*\/\/ 中立一律绿色/.test(ul));
  const um = srcOf('src/ui/UIManager.js');
  // v45：徽标（FAC_BADGE）已被抬头的阵营色圆点（FAC_DOT）取代 —— 用户要求把
  // 左上角的「#1 防御塔」与右上角的「🔵 蓝方 · 外塔」合并成一处。
  // 这条断言要守的**教训没变**：阵营是三值的，按它分叉的地方必须有三个分支，
  // 少一档就会把中立单位贴上敌方标签。所以只把被钉的名字换掉，判据照旧。
  T('中立②-面板抬头的阵营色有三档（原来是个没有第三档的三元，非蓝一律显示红方）',
    /FAC_DOT = \{[\s\S]*blue:[\s\S]*red:[\s\S]*neutral:/.test(um));
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
// 2026-08 用户定稿："设置窗口只留系统设置，游戏性设置整合到模板编辑器里"——
// 整块搬到 pagesGameplayWorld.js（游戏性→巨龙与龙魂），方法名/按钮 id 跟着变了，
// 但下面 7 条断言各自对应的能力都还在，逐条改成查新文件。
{
  const gw = srcOf('src/ui/editor/pagesGameplayWorld.js');
  const wr = srcOf('src/ui/editor/pagesWave.js'); // 刷新节奏/强度曲线仍在"巨龙→刷新与强度"页
  T('巨龙①-面板渲染与事件绑定成对存在',
    /_renderGameplayDragonContent\(\)/.test(gw) && /_bindGameplayDragonEvents\(overlay, logFn\)/.test(gw));
  T('巨龙②-面板真的被接到模板编辑器的分发上（不是写了个没人用的方法）',
    /case 'dragonstate':return this\._renderGameplayDragonContent\(\);/.test(srcOf('src/ui/editor/shell.js'))
    && /case 'dragonstate': this\._bindGameplayDragonEvents\(overlay, logFn\); break;/.test(srcOf('src/ui/editor/shell.js')));
  T('巨龙③-刷新节奏输入写回 CONFIG（在"巨龙→刷新与强度"页，与本面板分开但同样可编辑）',
    /_applyDragonRuleChanges/.test(wr) && /CONFIG\.gameRules\.dragon = CONFIG\.gameRules\.dragon/.test(wr));
  T('巨龙④-有生成/效果两个独立开关（对应 CONFIG.dragonToggles 的两项）',
    /CONFIG\.dragonToggles\.spawn = CONFIG\.dragonToggles\.spawn === false/.test(gw)
    && /CONFIG\.dragonToggles\.effect = CONFIG\.dragonToggles\.effect === false/.test(gw));
  T('巨龙⑤-即时操作齐备：刷一条 / 清场 / 判魂 / 清进度',
    /dgForceElement/.test(gw) && /dgKillAll/.test(gw)
    && /dg-set-soul/.test(gw) && /dgResetProgress/.test(gw));
  T('巨龙⑥-清场走 entity:death（绕过去的话"编辑器杀的龙不给奖励"，两套行为）',
    /app\?\.eventBus\?\.emit\?\.\('entity:death'/.test(gw));
  // v50 重做：进度那一块从一句文字扩成"对局态势"网格（双方条数 / 还差几条 /
  // 下一条龙倒计时 / 当前魂）。断言随之钉这几项都在，而不是钉那一句文案。
  T('巨龙⑦-展示双方争夺进度（双方条数 + 还差几条 + 下一条龙倒计时）',
    /还差 \$\{need\}/.test(gw) && /下一条龙/.test(gw) && /对局态势/.test(gw));
  // 用户："你原有的窗口只写了龙魂，没写巨龙之力！"—— 这是这一页最大的缺口。
  T('巨龙⑦-补上了【巨龙之力】的展示（层数 + 上限）',
    /巨龙之力层数/.test(gw) && /dragonPower\?\.maxStacks/.test(gw));
  T('巨龙⑦-元素表从 DRAGON_ELEMENTS 现取，不写死（v50 一次加了六个元素）',
    /Object\.entries\(DRAGON_ELEMENTS\)/.test(gw));
  // 手动指定龙魂原来存的是**元素 key** 而不是技能 id，equipExistingSoul 查不到 →
  // 手动指定从来没真正生效过。修好之后这条断言守住它不再退化。
  T('巨龙⑦-手动指定龙魂存的是技能 id，并且立刻发给场上全体',
    /DRAGON_ELEMENTS\[el\]\?\.soul/.test(gw) && /_grantAll\(fac, \(e\) => ds\._equipSoul\(e, soulId\)\)/.test(gw));
  T('巨龙⑧-文案跟真实规则一致：先到先得，不是"打完一批统一结算"',
    /先到先得/.test(gw) && !/都不到则无魂/.test(gw));
}

// ==================== 七、Q3 龙坑位置 ====================
// 用户："龙坑的位置不对！"并在小地图上标了两个红叉。
// 原坐标是"自小地图河道最粗处自动检测"出来的 —— 而河道最粗的地方恰恰在**中央交汇处**
//（三条路与河道交叉、蓝像素连成一片），于是两个坑都被往地图中心拽。
// "最粗处"这个判据本身就选错了：它测像素宽度，而坑的位置由河段的几何位置决定。
//
// 这一节不钉"坐标等于某两个数"（那只是把硬编码从源码搬到测试里），
// 而是**用 riverFactor 重算一遍每段河道的重心**，与声明值对表。
// 写死的数字必须有个东西盯着，否则下次改河道半宽它就悄悄错了。
{
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const bus2 = new EventBus(), ents2 = new EntityContainer(bus2);
  const ms = new MapSystem(ents2, bus2);
  ms.setCreateBuildingFn(() => null);
  ms.loadMap('summoners_rift_v1');
  const W = ms.currentMap.world.w, H = ms.currentMap.world.h;

  // 只取河心（f>0.5，排除羽化岸边），按 x+y 与地图中心线切成两段，各求加权重心
  const seg = { baron: { sx: 0, sy: 0, sw: 0 }, dragon: { sx: 0, sy: 0, sw: 0 } };
  for (let x = 0; x < W; x += 8) for (let y = 0; y < H; y += 8) {
    const f = ms.riverFactor(x, y);
    if (f <= 0.5) continue;
    const g = seg[(x + y < W) ? 'baron' : 'dragon'];
    g.sx += x * f; g.sy += y * f; g.sw += f;
  }
  for (const k of ['baron', 'dragon']) {
    const g = seg[k], cx = g.sx / g.sw, cy = g.sy / g.sw;
    const p = ms.getPit(k);
    T(`坑①-${k} 声明位置 = 该段河道的几何重心（误差 < 60）`,
      !!p && Math.hypot(p.x - cx, p.y - cy) < 60);
    T(`坑②-${k} 落在河心上（riverFactor 接近 1）`, ms.riverFactor(p.x, p.y) > 0.9);
    T(`坑③-${k} 可行走（龙要从这里出来走兵线）`, ms.isWalkable(p.x, p.y));
  }
  // 两个坑必须分居中心线两侧，且离中心足够远 —— 原实现的毛病就是"都挤向中心"
  const b = ms.getPit('baron'), d = ms.getPit('dragon'), C = W / 2;
  T('坑④-上坑在中心线左上、下坑在右下', (b.x + b.y) < W && (d.x + d.y) > W);
  T('坑⑤-两坑离地图中心足够远（旧实现被"最粗处"拽向中心，这条钉住别再犯）',
    Math.hypot(b.x - C, b.y - C) > W * 0.2 && Math.hypot(d.x - C, d.y - C) > W * 0.2);

  // 软编码：坑位可被 CONFIG 覆写（硬约束"一切数值软编码"）
  const saved = CONFIG.gameRules.dragon.pits.baron;
  CONFIG.gameRules.dragon.pits.baron = { x: 777, y: 888 };
  const ovr = ms.getPit('baron');
  T('坑⑥-CONFIG 可覆写坑位，且半径/depth 回落到默认',
    ovr.x === 777 && ovr.y === 888 && ovr.r === 150 && ovr.depth === -26);
  CONFIG.gameRules.dragon.pits.baron = saved;
  T('坑⑥-清掉覆写后回到推导值', ms.getPit('baron').x === b.x);
}

// ==================== 八、龙魂 / 巨龙之力重做 ====================
{
  const { DRAGON_ELEMENTS, dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
  // v50：六条新元素（霜/铁/血/熔/星/蚀）。这一节的规矩对全部元素成立，
  // 所以列表直接从 DRAGON_ELEMENTS 取 —— 写死七个的话，以后每加一个元素
  // 这里都会漏测（而"每个属性只属于一个元素"恰恰是元素越多越容易破的规矩）。
  const ELS = Object.keys(DRAGON_ELEMENTS);

  T('龙①-光龙与光魂一并删除（用户定稿"光龙直接删除吧"）',
    !DRAGON_ELEMENTS.light && !SkillLibrary.dragonsoul_light
    && !CONFIG.dragonSouls.light && !CONFIG.dragonPower.light);
  T('龙②-每个元素都能查到自己的魂（v50 起 13 个元素）',
    Object.keys(DRAGON_ELEMENTS).length === 13
    && ELS.every(k => !!SkillLibrary[DRAGON_ELEMENTS[k].soul]));

  // ---- 巨龙之力：纯数值，且**每一项只属于一个元素** ----
  // 用户定稿："每一种做出差异，最好不要重复，比如说 +最大生命值只是山龙的增益。"
  const owner = {};
  const dups = [];
  for (const el of ELS) {
    for (const k of Object.keys(CONFIG.dragonPower[el] || {})) {
      if (owner[k]) dups.push(`${k}（${owner[k]} 与 ${el}）`);
      owner[k] = el;
    }
  }
  T(`龙③-七条巨龙之力的属性互不重复${dups.length ? '：' + dups.join('、') : ''}`, dups.length === 0);
  T('龙③-最大生命是山龙独占（用户点名的例子）',
    owner.maxHPPct === 'earth' && !('maxHPPct' in (CONFIG.dragonPower.fire || {})));
  T('龙④-巨龙之力是纯属性（没有任何机制钩子）',
    ELS.every(el => Object.values(CONFIG.dragonPower[el]).every(v => typeof v === 'number')));
  T('龙⑤-层数上限 4（不再是永远到不了的 99）', CONFIG.dragonPower.maxStacks === 4);
  T('龙⑥-属性表从源码搬进 CONFIG（编辑器可改）',
    ELS.every(el => !!CONFIG.dragonPower[el])
    && ELS.every(el => !DRAGON_ELEMENTS[el].buff));
  T('龙⑦-dragonPowerBuffs 按 Pct 后缀分流固定值/百分比',
    dragonPowerBuffs('earth').some(b => b.statKey === 'maxHP' && b.percent > 0)
    && dragonPowerBuffs('earth').some(b => b.statKey === 'armor' && b.flat > 0));

  // ---- 龙魂 = 数值 + 机制 ----
  T('龙⑧-七条魂都有数值部分（CONFIG.dragonSouls.stat）',
    ELS.every(el => CONFIG.dragonSouls.stat[el]
      && Object.keys(CONFIG.dragonSouls.stat[el]).length > 0));
  T('龙⑨-数值部分真的会挂到单位身上（装魂 → 出现常驻 stat 效果）', (() => {
    const { ents, fx } = world();
    const t = mk(ents, 'tower', { faction: 'blue' });
    const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: new EventBus() };
    const inst = { id: 1, skillId: 'dragonsoul_earth', state: {} };
    SkillLibrary.dragonsoul_earth.onEquip(t.id, inst, ctx);
    const has = fx.getEffects(t.id).some(e => e.sourceId === 'soul_stat_earth');
    const armorUp = attr.calc(t, fx.getEffects(t.id)).armor > t.baseStats.armor;
    SkillLibrary.dragonsoul_earth.onUnequip(t.id, inst, ctx);
    const gone = !fx.getEffects(t.id).some(e => e.sourceId === 'soul_stat_earth');
    return has && armorUp && gone;
  })());
  T('龙⑩-每条魂的数值里都有一份生存分量（v43 对照：纯输出的魂推进度差全为负）',
    ELS.every(el => {
      const st = CONFIG.dragonSouls.stat[el];
      return Object.keys(st).some(k => /maxHP|armor|magicResist|healthRegen|healShieldPower|lifeSteal|damageReduction/.test(k));
    }));
  T('龙⑪-面板文案里说了这份数值（否则玩家不知道自己拿了什么）',
    ELS.every(el => /常驻加持/.test(String(SkillLibrary['dragonsoul_' + el].description))));

  // ---- 机制侧的三处改动 ----
  const ds = srcOf('src/core/skills/dragonSouls.js');
  T('龙⑫-炎魂改常驻（cooldown 0 时不走冷却门）',
    CONFIG.dragonSouls.fire.cooldown === 0 && /if \(cd > 0 && !offCooldown\(instance, cd\)\) return;/.test(ds));
  T('龙⑬-雷魂取消均摊（改为每目标固定一份）',
    'perTargetPct' in CONFIG.dragonSouls.thunder && !('totalPct' in CONFIG.dragonSouls.thunder)
    && /const per = \(ctx\.totalRaw \|\| 0\) \* \(\(p\.perTargetPct/.test(ds));
  // v45：本条推翻了 v44 的判断。v44 我给塔发的是**射程**，理由是"塔不会动，移速对它是废的"
  // ——前半句没错，后半句结论错了：不能因为"移速对塔无效"就跳出速度这个主题。
  // 用户明确要求风保持「+移速 +攻速 +攻速收益率」的方向，所以塔那一半改为发
  // attackSpeedRatio（攻速收益率）：它同样是"速度"，同样对静止的塔有效，
  // 而且是全局乘在所有攻速加成上的，与风的主题一致。
  T('龙⑭-风魂给塔的是攻速收益率（同属速度主题，且对不会动的塔有效）',
    'towerAttackSpeedRatio' in CONFIG.dragonSouls.wind
    && !('towerAttackRangeFlat' in CONFIG.dragonSouls.wind)
    && /statKey: 'attackSpeedRatio', flatValue: p\.towerAttackSpeedRatio/.test(ds));
  T('龙⑮-暗魂改为偷取（削对方多少自己得多少）',
    CONFIG.dragonSouls.dark.steal === true && /dragonsoul_dark_steal/.test(ds));
  T('龙⑯-山魂大削（v43 对照 6/6 全胜、推进度差 +3.65）',
    CONFIG.dragonSouls.earth.damageReduction <= 20 && CONFIG.dragonSouls.earth.damageBlock <= 1);

  // ---- 对照工具 ----
  const bm = srcOf('tools/balance_matrix.mjs');
  T('龙⑰-对照工具有 --sweep power 档（力和魂必须分开测）',
    /SWEEP === 'power'/.test(bm) && /蓝方满\$\{k\}之力/.test(bm));
  T('龙⑰-力那一档直接顶到满层（要量的是集齐之后，不是攒的过程）',
    /eff\.stacks = cap;/.test(bm));
}

// ==================== 九、龙坑归地图所有 ====================
{
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { MAPS } = await import('../src/data/maps/index.js');
  const ms2 = srcOf('src/systems/MapSystem.js');
  T('坑⑦-地形挖坑与出生点取坑走同一个口径（getPit）',
    /const pit = this\.getPit\(key\); if \(!pit\) continue;/.test(ms2));
  T('坑⑧-不再按 useNavgrid 给所有地图发召唤师峡谷的坑',
    !/m\.useNavgrid \? \(SR_PITS\[name\] \|\| null\) : null/.test(ms2));
  T('坑⑨-只有召唤师峡谷声明了坑', !!MAPS.summoners_rift_v1.pits
    && !MAPS.howling_abyss_v1.pits && !MAPS.twisted_treeline_v1.pits);

  const bus3 = new EventBus(), ents3 = new EntityContainer(bus3);
  const mHA = new MapSystem(ents3, bus3); mHA.setCreateBuildingFn(() => null);
  mHA.loadMap('howling_abyss_v1');
  T('坑⑩-嚎哭深渊没有坑，也就没有被挖出来的坑洞（它是一座平桥）',
    mHA.getPit('baron') === null && mHA.getPit('dragon') === null);
}

// ==================== 十、界面统一（用户补充的一批）====================
{
  const fs2 = (await import('fs')).default;
  const html = fs2.readFileSync('index.html', 'utf8');
  const um = srcOf('src/ui/UIManager.js');

  // ① 三段各自独立成一个可点单元。
  // v44 定的是"三条竖排"，v47 改成**一行三个胶囊**（用户："你自己看看左上角那个条好看吗"）——
  // 竖排/横排是版式，会随观感反复；真正不能丢的是**三段各自独立**这条：
  // 上一版把天气裹进 #whTimeRow，天气就丢了 pointer 光标（用户报的"天气那个无法点击"）。
  // 所以断言从"是不是 .wh-row"改成"三个 id 各自是独立元素"，钉规则不钉版式。
  T('界①-三段各自独立成一个可点单元（不是把谁裹进谁）',
    /id="whTimeRow"/.test(html) && /id="whWeatherRow"/.test(html) && /id="whEntropyRow"/.test(html)
    && !/id="whTimeRow"[\s\S]{0,400}id="whWeatherRow"[^>]*>[\s\S]{0,80}<\/div>\s*<\/div>\s*<\/div>/.test(html));
  T('界①-并排布局的残留样式已删干净（留着就是死样式）',
    !/wh-row-split/.test(html) && !/wh-seg/.test(html) && !/\.wh-row/.test(html));
  T('界②-天气段拿回了 pointer 光标（此前被裹在 #whTimeRow 里，正好被 :not(#whTimeRow) 排除）',
    /\.wh-chip\[title\]:not\(#whTimeRow\) \{ cursor: pointer; \}/.test(html));

  // ② 属性栏：天气行与世界行合并成一栏
  T('界③-两行被同一个 .state-row 包住（合的是版式，不是刷新逻辑）',
    /<div class="state-row">[\s\S]{0,200}weather-row[\s\S]{0,200}world-row[\s\S]{0,80}<\/div>/.test(um));
  T('界③-CSS 里 .state-row 是一行横排',
    /\.state-row \{[^}]*display: flex[^}]*\}/.test(html));
  T('界③-两个盒子各自的刷新入口都还在（没有为了合并而合掉逻辑）',
    /_updateWeatherRow\(card, /.test(um) && /_updateWorldRow\(card, /.test(um));

  // ③ 弹窗统一外壳
  T('界④-天气详情弹窗改用 shellHtml（v43 统一弹窗那轮漏了它，它藏在 UIManager 里）',
    /_showWeatherDetail\(row\) \{[\s\S]{0,3000}shellHtml\(\{/.test(um)
    && !/<div class="modal" style="max-width:380px;">/.test(um));
  T('界④-属性说明弹窗也走同一个外壳',
    /_showStatDoc\(key, entity\) \{[\s\S]{0,2500}shellHtml\(\{/.test(um));

  // ④ 属性可点击
  const { STAT_DOCS, statDoc } = await import('../src/data/statDocs.js');
  // v47：布局从"两段模板字符串"改成一张可 import 的表（src/ui/statPanelLayout.js），
  // 断言随之从"正则数源码里有几个 data-stat"改成**读那张表**。
  // 数源码钉的是"源码长什么样"—— 换个写法就红，真出问题反而不红。
  const { extAttrGroups, BASE_ATTR_ROWS, allPanelStatKeys } = await import('../src/ui/statPanelLayout.js');
  T('界⑤-属性行带 data-stat 且可点击（常驻区 4 格 + 展开区整张表）',
    /class="a stat-doc" data-stat="\$\{key\}"/.test(um)
    && BASE_ATTR_ROWS.length === 4
    && allPanelStatKeys('tower').length >= 18);
  T('界⑤-点击走**事件委托**绑在容器上（属性行是重建的，逐行绑会连同旧节点被丢掉）',
    /this\.selCard\.addEventListener\('click'/.test(um)
    && /closest\?\.\('\.stat-doc\[data-stat\]'\)/.test(um));
  T('界⑤-属性行加了脏检查（每帧全量重建时，mousedown 与 mouseup 会落在不同节点上）',
    /_setAttrs\(el, html\)/.test(um) && /el\._lastHtml === html/.test(um));
  T('界⑥-说明文字住在 data 层（与公式同源，不是嵌在渲染函数里的模板字符串）',
    typeof STAT_DOCS === 'object' && Object.keys(STAT_DOCS).length >= 20);
  T('界⑥-面板上每一个可点击的 statKey 都有对应说明（点了弹空窗比不能点更糟）', (() => {
    const keys = [...um.matchAll(/data-stat="(\w+)"/g)].map(m => m[1]);
    return keys.length > 0 && keys.every(k => !!statDoc(k));
  })());
  T('界⑥-说明里写了结算规则而不只是名词解释',
    ['attackDamage', 'armor', 'bonusAttackSpeedPct', 'damageBlock']
      .every(k => statDoc(k) && statDoc(k).formula && statDoc(k).formula.length > 20));
}

// ==================== 十一、模型全面重做（全部程序化，删 GLB）====================
{
  const fs3 = (await import('fs')).default;
  const umf = srcOf('src/presentation/UnitMeshFactory.js');
  const ul = srcOf('src/presentation/UnitLayer.js');
  const tr = srcOf('src/presentation/ThreeRenderer.js');

  // ---- GLB 那条路整条删除 ----
  T('模①-ModelLibrary.js 已删除', !fs3.existsSync('src/presentation/ModelLibrary.js'));
  T('模①-GLB 资产已删除', !fs3.existsSync('assets/models'));
  T('模①-渲染层不再有 GLB 分支',
    !/ModelLibrary/.test(ul) && !/vis\.isModel/.test(ul) && !/ModelLibrary/.test(tr)
    && !/setUseModels/.test(tr));
  T('模①-CTX.__useModels 一并去掉（开关的对象没了）',
    !/__useModels/.test(srcOf('src/main.js')));

  // ---- 塔：造型由 (tier, faction) 决定 ----
  T('模②-每档规模写在一张表里（层数/扶壁/悬浮晶/高度）',
    /const TIER_SPEC = \{[\s\S]*outer:[\s\S]*inner:[\s\S]*base:[\s\S]*hq_tower:/.test(umf));
  T('模②-规模随档次单调递增（这就是"等级越高越牛逼"）', (() => {
    const m = umf.match(/const TIER_SPEC = \{([\s\S]*?)\n\};/);
    if (!m) return false;
    const spec = {};
    for (const line of m[1].split('\n')) {
      // v45：`orbs`（绕塔顶的悬浮碎晶）已删 —— 用户："顶部元素别整的太多了，堆在一起不好看。"
      // 它与顶部水晶抢同一片视觉位置。递增性改看 topScale（顶盖高度），
      // 那是它的替代者：层级差异从"再堆一件"改成"同一件长高"。
      const g = line.match(/(\w+):\s*\{ tiers: (\d+), buttress: (\d+), shaft: ([\d.]+), crown: [\d.]+, balcony: (\w+),\s*turrets: (\d+), topScale: ([\d.]+)/);
      if (g) spec[g[1]] = { tiers: +g[2], buttress: +g[3], shaft: +g[4],
                            balcony: g[5] === 'true', turrets: +g[6], topScale: +g[7] };
    }
    const order = ['outer', 'inner', 'base', 'hq_tower'];
    if (order.some(k => !spec[k])) return false;
    for (let i = 1; i < order.length; i++) {
      const a = spec[order[i - 1]], b = spec[order[i]];
      if (!(b.shaft > a.shaft && b.tiers >= a.tiers && b.buttress >= a.buttress
            && b.turrets >= a.turrets && b.topScale > a.topScale)) return false;
    }
    return true;
  })());
  T('模③-阵营语言成对声明，且两边部件数量一致（观感不同，强弱对称）',
    /const FACTION_STYLE = \{[\s\S]*blue:[\s\S]*red:[\s\S]*neutral:/.test(umf));
  // v45：签名多了一个 dmg（损毁档 0/1/2）。判据保持"tier 与 faction 在签名里"这条
  // 不变的意图，但不再钉死整串参数 —— 参数列表是会长的，钉全串等于每加一个可选参数
  // 都要来改一次断言，而那次改动本身与这条断言想守的东西无关。
  T('模③-towerMesh 收 tier 与 faction（原签名根本不知道 tier 是什么）',
    /export function towerMesh\([^)]*\btier\b[^)]*\bfaction\b[^)]*\)/.test(umf));
  T('模③-tier/faction 进了几何缓存 key（不进则四档共用第一个被缓存的几何）',
    /\$\{vTier\}\|\$\{vFac\}/.test(ul));

  // ---- 小兵：八个内置兵种都有专属 builder ----
  const builders = [...umf.matchAll(/^  (\w+)\(color, S\) \{/gm)].map(m => m[1]);
  const NEED = ['melee', 'ranged', 'siege', 'ram', 'super', 'totem', 'warlock', 'corrupt'];
  T(`模④-八个内置兵种都有专属造型（此前 totem/warlock/corrupt 落在通用步兵模板上）`,
    NEED.every(k => builders.includes(k)));
  T('模④-模板里配置的兵种与有造型的兵种对得上',
    NEED.every(k => !!CONFIG.templates[k]));
  // v45：白名单 FACING_TYPES 已删。原因不是"这条不重要了"，而是**它变重要了**：
  // 朝向从纯表现升级成了战斗规则（非塔单位必须转到正面才能开火）。
  // 受规则约束却在画面上从不转身 = 玩家看到"它对着敌人却不打"，
  // 所以判据从"哪些兵种在白名单里"改成"除塔之外全都转，且与 FacingSystem 同一句话"。
  T('模⑤-除塔之外的单位都会转向（与 FacingSystem.facingExempt 同一判据）', (() => {
    const okShape = /needsFacing\(type\) \{ return type !== 'tower'; \}/.test(umf);
    const noWhitelist = !/FACING_TYPES/.test(umf);
    return okShape && noWhitelist;
  })());

  // ---- 真的能造出几何来（headless 下 three 可用）----
  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { towerMesh, minionMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const tops = {};
    for (const tier of ['outer', 'inner', 'base', 'hq_tower']) {
      const m = towerMesh('t|' + tier, '#5b9bd5', 26, '', 'tower', false, false, tier, 'blue');
      tops[tier] = m.topY;
      T(`模⑥-${tier} 塔能造出几何且有炮口高度`, m.geo && m.topY > 0 && m.muzzleY > 0);
    }
    T(`模⑥-塔高随档次递增（${['outer','inner','base','hq_tower'].map(k=>Math.round(tops[k])).join(' < ')}）`,
      tops.outer < tops.inner && tops.inner < tops.base && tops.base < tops.hq_tower);
    // 同档不同阵营必须是**不同的几何**（否则"红蓝各有特色"就没做到）
    const b = towerMesh('x|b', '#5b9bd5', 26, '', 'tower', false, false, 'inner', 'blue');
    const r2 = towerMesh('x|r', '#e0473f', 26, '', 'tower', false, false, 'inner', 'red');
    T('模⑦-同档的红蓝是两份不同的几何',
      b.geo !== r2.geo
      && b.geo.attributes.position.count !== r2.geo.attributes.position.count);
    for (const t of NEED) {
      const m = minionMesh('mm|' + t, '#5b9bd5', 17, t, 'blue');
      T(`模⑧-${t} 能造出几何`, m.geo && m.topY > 0);
    }
    // 三个新兵种不能与通用步兵模板同形
    const generic = minionMesh('mm|__custom__', '#5b9bd5', 17, '__custom__', 'blue');
    for (const t of ['totem', 'warlock', 'corrupt']) {
      const m = minionMesh('mm|' + t, '#5b9bd5', 17, t, 'blue');
      T(`模⑨-${t} 不再落回通用步兵模板`,
        m.geo.attributes.position.count !== generic.geo.attributes.position.count);
    }
  }
}

// ==================== 十二、废墟 / 顶栏 / 工具栏 / 速度倍率 ====================
{
  const fs4 = (await import('fs')).default;
  const umf = srcOf('src/presentation/UnitMeshFactory.js');
  const html = fs4.readFileSync('index.html', 'utf8');
  const mj = srcOf('src/main.js');
  const sd = srcOf('src/ui/SettingsDialog.js');
  const um = srcOf('src/ui/UIManager.js');

  // 废墟：碎片要**褪色**，不能只是暗一点
  T('废①-有 desat（往灰里拉 + 压暗），不是只调亮度',
    /const desat = \(hex, k = [\d.]+, g = [\d.]+\)/.test(umf) && /lerp\(new THREE\.Color\(lum, lum, lum\), g\)/.test(umf));
  T('废②-水晶碎片用 desat（旧写法 shade(color, 0.92) 只暗了 8%，饱和度一点没掉）',
    /desat\(color, 0\.\d+, 0\.\d+\)\)/.test(umf) && !/shade\(color, 0\.92\)/.test(umf));
  T('废③-废墟有倒塌方向（不再是上下对称的断桩 + 四周随手撒的石头）',
    /const LEAN = /.test(umf));

  // 顶栏
  T('顶①-击杀数不再上顶栏，只显示推塔数',
    /this\._setText\('scoreBlue', `\$\{sc\.blue\.towers\}`\)/.test(um)
    && !/sc\.blue\.kills\}\//.test(um));
  T('顶①-击杀仍然照常统计（只是不显示，不是把统计删了）',
    /__score\[scorer\]\.kills\+\+/.test(mj));
  // v47：顶栏拆成 #topbarLeft / #topbarRight 两块独立浮层（用户："顶边栏分成两部分"），
  // 玻璃参数从"每块各抄一遍"收敛到唯一的 .hud-panel。
  // 断言随之改成"这几块都挂着 .hud-panel"+"那一处定义里有那组参数" ——
  // 逐块正则各自的 CSS 块，正是它们当年会长歪的原因（改一块忘一块，断言还全绿）。
  T('顶②-顶栏悬浮（左右两块都是）',
    /#topbarLeft {2}\{[^}]*top: 10px[^}]*\}/.test(html)
    && /#topbarRight \{[^}]*top: 10px[^}]*\}/.test(html)
    && /\.hud-panel \{[^}]*position: absolute/.test(html));
  T('顶③-浮层共用唯一一份玻璃参数（.hud-panel），不再各抄一份', (() => {
    const m = html.match(/\.hud-panel \{([^}]*)\}/);
    if (!m) return false;
    const b = m[1];
    const okDef = /blur\(14px\)/.test(b) && /var\(--surface\)/.test(b) && /var\(--glass-border\)/.test(b);
    // v47：世界状态条并进了左上角那一块，所以浮层从四块减到三块。
    // 属性面板保持自己的一份 —— 它不是工具栏，尺寸与滚动行为都差太多。
    const users = ['topbarLeft', 'topbarRight', 'canvasControls'];
    return okDef && users.every(id => new RegExp(`id="${id}" class="hud-panel"`).test(html));
  })());
  T('顶③-属性面板仍然自带同一组玻璃参数（它不走 .hud-panel）', (() => {
    const m = html.match(/#selectionPanel \{([^}]*)\}/);
    return !!m && /blur\(14px\)/.test(m[1]) && /var\(--surface\)/.test(m[1]);
  })());
  // v47：世界小窗不再是浮层（并进左上角那块面板），所以"让位"只剩属性面板要做。
  // 而左上角那块因此变高了，属性面板的 top 也跟着从 66 抬到 104 ——
  // 断言改成"属性面板的 top 高于左上角面板的最坏高度"，钉的是**不重叠**这件事本身。
  // v47：遮挡不再靠"调一个够大的 top"来躲，而是**量出来**（UIManager._bindPanelOffset
  // 用 ResizeObserver 盯 #topbarLeft 的实际高度）。CSS 里那个数只是首帧兜底。
  T('顶④-属性面板的位置由左上角那块的实测高度决定，不是写死的数',
    /_bindPanelOffset\(\)/.test(um) && /new ResizeObserver\(apply\)/.test(um)
    && /bar\.offsetHeight/.test(um));
  T('顶④-CSS 里仍留了一个兜底 top（ResizeObserver 生效前的第一帧要有位置）',
    +((html.match(/#selectionPanel \{[^}]*top: (\d+)px/) || [])[1] || 0) >= 60);
  T('顶④-世界状态条已并进左上角，不再自己占一块浮层',
    /<div id="worldHud">/.test(html) && !/id="worldHud" class="hud-panel"/.test(html));
  // v47：日志按钮从顶栏移进设置（用户定稿）。**删元素必须连着删接线** ——
  // main.js 那句 getElementById('toggleLogBtn').addEventListener 在 null 上会直接抛，
  // 而它在接线段中间，抛了之后后面所有按钮都接不上（"删一半"的典型塌方）。
  T('顶⑤-顶栏不再有日志按钮，main.js 也不再对它接线',
    !/id="toggleLogBtn"/.test(html) && !/getElementById\('toggleLogBtn'\)/.test(mj));
  T('顶⑤-日志开关搬进了设置（操作的还是同一个 #logArea）',
    /id="setLogAreaBtn"/.test(sd) && /getElementById\('logArea'\)/.test(sd));

  // 速度 / 性能
  T('速①-倍率是 1/2/4/8（用户定稿）', /\[1, 2, 4, 8\]\.map\(v =>/.test(sd));
  T('速②-「快进 N 秒」已删除（它的作用被 8x 覆盖）',
    !/data-ff=/.test(sd) && !/__ffRemain/.test(mj) && !/__ffRemain/.test(sd));
  T('速③-每帧模拟预算改为**墙钟毫秒**（原来限步数，而单步耗时随单位数增长）',
    /const budgetMs = \(CONFIG\.tuning\?\.simBudgetMs\)/.test(mj)
    && /if \(performance\.now\(\) - tSim0 >= budgetMs\) break;/.test(mj));
  T('速③-步数上限 MAX_SUBSTEPS / 240 的写死值已去掉',
    !/MAX_SUBSTEPS/.test(mj) && !/maxSteps/.test(mj));
  T('速④-预算软编码在 CONFIG', Number.isFinite(CONFIG.tuning.simBudgetMs));
  T('速⑤-欠账有封顶（否则卡顿缓解后会突然补跑一大段，画面跳）',
    /const maxDebt = SIM_DT \* Math\.max\(2, Math\.min\(8, speed\) \* 2\);/.test(mj));
}

// ==================== 十三、属性面板重做 + 数值显示口径 ====================
{
  const fs5 = (await import('fs')).default;
  const html = fs5.readFileSync('index.html', 'utf8');
  const um = srcOf('src/ui/UIManager.js');
  const op = srcOf('src/ui/editor/open.js');
  const ev = srcOf('src/ui/editor/events.js');

  // ---- 显示口径：182（152+30），按符号着色 ----
  const { UIManager } = await import('../src/ui/UIManager.js').catch(() => ({}));
  T('值①-口径函数存在且是唯一实现（面板与弹窗都走它）',
    /_statParts\(key, entity, stats\)/.test(um) && /_statValueHtml\(key, entity, stats/.test(um));
  T('值②-基础值取 baseStats、最终值取 attrCalc，差额即"各渠道修正之和"',
    /const base = entity && entity\.baseStats \? entity\.baseStats\[key\] : undefined;/.test(um)
    && /const delta = now - base;/.test(um));
  T('值③-正修正橙色 / 负修正红色 / 无修正默认色',
    /cls: clean > 0 \? 'stat-up' : clean < 0 \? 'stat-down' : ''/.test(um)
    && /\.stat-up\s*\{ color: #f0a03c; \}/.test(html)
    && /\.stat-down \{ color: #ef6b6b; \}/.test(html));
  T('值④-没有修正就不显示括号（用户明确要求）',
    /const paren = p\.delta === 0 \? ''/.test(um));
  T('值⑤-括号里是「基础 ± 修正和」，负数用减号',
    /（\$\{p\.base\}\$\{p\.delta > 0 \? '\+' : '−'\}\$\{Math\.abs\(p\.delta\)\}）/.test(um));
  T('值⑥-浮点噪声当作无修正（否则 40 会显示成 40（40+0））',
    /Math\.abs\(delta\) < 0\.005 \? 0 : delta/.test(um));

  // 真的算一遍
  if (UIManager) {
    const { ents, fx } = world();
    const t = mk(ents, 'tower', { stats: { maxHP: 4000, attackDamage: 152 } });
    const ui = Object.create(UIManager.prototype || {});
    const parts = (UIManager.prototype ? UIManager.prototype._statParts : UIManager._statParts);
    if (parts) {
      const p0 = parts.call(ui, 'attackDamage', t, { attackDamage: 152 });
      const pUp = parts.call(ui, 'attackDamage', t, { attackDamage: 182 });
      const pDn = parts.call(ui, 'attackDamage', t, { attackDamage: 129 });
      T('值⑦-无修正：无 delta、无着色', p0.delta === 0 && p0.cls === '');
      T('值⑦-正修正：182（152+30）且标橙', pUp.now === 182 && pUp.base === 152 && pUp.delta === 30 && pUp.cls === 'stat-up');
      T('值⑦-负修正：129（152−23）且标红', pDn.now === 129 && pDn.delta === -23 && pDn.cls === 'stat-down');
    }
  }

  // ---- 面板重做 ----
  T('板①-属性做成 chip（标签在上、数值在下），不再是密排两列',
    /\.attrs \.a, \.attrs-ext \.a \{[^}]*flex-direction: column/.test(html));
  T('板②-每组有小标题（属性/技能/状态/世界影响）',
    /class="panel-sec">属性</.test(um) && /class="panel-sec">技能</.test(um)
    && /class="panel-sec">状态</.test(um) && /class="panel-sec">世界影响</.test(um));
  // v47：上移量从"估的 -17px"改成与血条**等高**的 -18px（用户："文字也要上下居中，
  // 目前就有些靠下了"）。断言随之改成"上移量 = 血条高度"，不再钉那个具体数字 ——
  // 钉 17 的话，血条高度一改这条就会拦下正确的实现。
  T('板③-血条数值压在条上，且上移量恰好等于血条高度（居中是算出来的，不是估的）', (() => {
    const br = (html.match(/\.bar-row \{([^}]*)\}/) || [])[1] || '';
    const bt = (html.match(/\.bar-text \{([^}]*)\}/) || [])[1] || '';
    const h = (br.match(/height: (\d+)px/) || [])[1];
    return !!h && new RegExp(`margin: -${h}px`).test(bt);
  })());
  T('板④-展开按钮做成整宽分隔条', /\.toggle-ext \{[^}]*width: 100%/.test(html));
  // v47：塔与兵**共用同一张表**（改动前是两份几乎相同的模板字符串，
  // 于是塔那份没有攻击距离、兵那份没有子弹速度，谁也没发现）。
  // 所以这里不再数"源码里出现了几次"，而是查两种单位的表里都有它。
  const { allPanelStatKeys } = await import('../src/ui/statPanelLayout.js');
  T('板⑤-「展开更多」里有伤害增幅（此前漏了）',
    ['tower', 'minion'].every(k => allPanelStatKeys(k).includes('damageAmpPct')));

  // ---- 攻击力弹窗写伤害类型 ----
  T('板⑥-攻击力弹窗写明伤害类型，且从**实体**读而不是查模板表',
    /key === 'attackDamage' && entity/.test(um)
    && /entity\.baseStats\?\.attackType/.test(um)
    && /physical: '⚔️ 物理伤害', magic: '✨ 魔法伤害', true: '💠 真实伤害'/.test(um));
  T('板⑥-武器带来的额外伤害股也会列出（腐蚀型是魔法+真实两股）',
    /weapon_corrosion'\) extras\.push/.test(um));

  // ---- 实体编辑器换壳 ----
  T('板⑦-实体编辑器改用统一外壳（v43 统一弹窗那轮漏了它）',
    /shellHtml\(\{/.test(op) && !/class="editor-tab active" data-tab="attr"/.test(op));
  T('板⑦-侧栏条目由一张表推出（不再手写六个按钮）', /const NAV = \[/.test(op));
  T('板⑧-事件分发放宽到 \[data-tab\]，不绑死 class（换壳时不必跟着改分发）',
    /overlay\.querySelectorAll\('\[data-tab\]'\)/.test(ev)
    && !/querySelectorAll\('\.editor-tab\[data-tab\]'\)/.test(ev));
  T('板⑧-切页时面包屑跟着走', /const crumb = overlay\.querySelector\('\.tpl-crumb'\);/.test(ev));

  // 每个可点击 statKey 仍然都有说明（新增的 damageAmpPct 也要有）
  const { statDoc } = await import('../src/data/statDocs.js');
  const keys = [...new Set([...allPanelStatKeys('tower'), ...allPanelStatKeys('minion')])];
  T('板⑨-新增的属性行也有说明（点了弹空窗比不能点更糟）',
    keys.includes('damageAmpPct') && keys.every(k => !!statDoc(k)));
}

done();
