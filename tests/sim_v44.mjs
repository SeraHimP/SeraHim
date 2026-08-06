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
  const ELS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison'];

  T('龙①-光龙与光魂一并删除（用户定稿"光龙直接删除吧"）',
    !DRAGON_ELEMENTS.light && !SkillLibrary.dragonsoul_light
    && !CONFIG.dragonSouls.light && !CONFIG.dragonPower.light);
  T('龙②-剩七个元素，每个都能查到自己的魂',
    Object.keys(DRAGON_ELEMENTS).length === 7
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
  T('龙⑭-风魂给塔的是射程不是攻速（塔不会动，移速对它是废的）',
    'towerAttackRangeFlat' in CONFIG.dragonSouls.wind
    && !('towerAttackSpeedPct' in CONFIG.dragonSouls.wind)
    && /statKey: 'attackRange', flatValue: p\.towerAttackRangeFlat/.test(ds));
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

  // ① 右上角三条竖排（这一处推翻了上一版的"时间与天气并成一行"）
  T('界①-三条各占一行（whTimeRow / whWeatherRow / whEntropyRow 都是 .wh-row）',
    /<div class="wh-row" id="whTimeRow"/.test(html)
    && /<div class="wh-row" id="whWeatherRow"/.test(html)
    && /<div class="wh-row" id="whEntropyRow"/.test(html));
  T('界①-并排布局的残留样式已删干净（留着就是死样式）',
    !/wh-row-split/.test(html) && !/wh-seg/.test(html) && !/wh-sep/.test(html));
  T('界②-天气行拿回了 pointer 光标（此前被裹在 #whTimeRow 里，正好被 :not(#whTimeRow) 排除）',
    /#worldHud \.wh-row\[title\]:not\(#whTimeRow\) \{ cursor: pointer; \}/.test(html));

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
  T('界⑤-属性行带 data-stat 且可点击', (um.match(/class="a stat-doc" data-stat="/g) || []).length >= 20);
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
      const g = line.match(/(\w+):\s*\{ tiers: (\d+), buttress: (\d+), orbs: (\d+), shaft: ([\d.]+)/);
      if (g) spec[g[1]] = { tiers: +g[2], buttress: +g[3], orbs: +g[4], shaft: +g[5] };
    }
    const order = ['outer', 'inner', 'base', 'hq_tower'];
    if (order.some(k => !spec[k])) return false;
    for (let i = 1; i < order.length; i++) {
      const a = spec[order[i - 1]], b = spec[order[i]];
      if (!(b.shaft > a.shaft && b.tiers >= a.tiers && b.buttress >= a.buttress && b.orbs >= a.orbs)) return false;
    }
    return true;
  })());
  T('模③-阵营语言成对声明，且两边部件数量一致（观感不同，强弱对称）',
    /const FACTION_STYLE = \{[\s\S]*blue:[\s\S]*red:[\s\S]*neutral:/.test(umf));
  T('模③-towerMesh 收 tier 与 faction（原签名根本不知道 tier 是什么）',
    /export function towerMesh\(key, color, bSize, weaponId, kind, ghost, ruin, tier, faction\)/.test(umf));
  T('模③-tier/faction 进了几何缓存 key（不进则四档共用第一个被缓存的几何）',
    /\$\{vTier\}\|\$\{vFac\}/.test(ul));

  // ---- 小兵：八个内置兵种都有专属 builder ----
  const builders = [...umf.matchAll(/^  (\w+)\(color, S\) \{/gm)].map(m => m[1]);
  const NEED = ['melee', 'ranged', 'siege', 'ram', 'super', 'totem', 'warlock', 'corrupt'];
  T(`模④-八个内置兵种都有专属造型（此前 totem/warlock/corrupt 落在通用步兵模板上）`,
    NEED.every(k => builders.includes(k)));
  T('模④-模板里配置的兵种与有造型的兵种对得上',
    NEED.every(k => !!CONFIG.templates[k]));
  T('模⑤-有正面的兵种会转向（术士的法杖、蚀骨的镰爪都在固定一侧）', (() => {
    const m = umf.match(/const FACING_TYPES = new Set\(\[([^\]]*)\]/);
    if (!m) return false;
    const set = m[1];
    return /'warlock'/.test(set) && /'corrupt'/.test(set) && !/'totem'/.test(set);
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
  T('顶②-顶栏悬浮', /#topbar \{[^}]*position: absolute[^}]*\}/.test(html));
  T('顶③-三块浮层用同一组玻璃参数（顶栏 / 右下角工具栏 / 右上角世界小窗）', (() => {
    const grab = (sel) => {
      const m = html.match(new RegExp(sel.replace(/[#]/g, '#') + ' \\{([^}]*)\\}'));
      return m ? m[1] : '';
    };
    const blocks = ['#topbar', '#canvasControls', '#worldHud', '#selectionPanel'].map(grab);
    return blocks.every(b => /blur\(14px\)/.test(b) && /var\(--surface\)/.test(b)
                             && /var\(--glass-border\)/.test(b));
  })());
  T('顶④-世界小窗与属性面板都给悬浮顶栏让了位（否则被压在底下）',
    /#worldHud \{[^}]*top: 66px/.test(html) && /#selectionPanel \{[^}]*top: 66px/.test(html));

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

done();
