// v41 验收：治疗与护盾强度贯通 / 负防御 / 闪电杖重做 / 残弹不伤人 / 天气真关 / 昼夜 8 分钟 / 植被高度
//
// 这一套对应用户在同一轮里提的一串问题，每一条都配了【反证】或【逐位等价】说明，
// 因为它们大多是"改动前就错着、只是没人看出来"的那种 bug。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { healPowerOf, applyHeal, grantTempShield, effectiveFixedShieldMax } = await import('../src/core/healing.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;

function world() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  return { bus, ents, fx, combat };
}
function unit(ents, o = {}) {
  const t = CONFIG.templates.melee;
  const e = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...t, armor: 0, magicResist: 0, damageReduction: 0, damageBlock: 0,
                 maxHP: 10000, healthRegen: 0, shieldFixedMax: 0, tempShieldDecayPct: 0, ...o },
    currentHP: o.hp ?? 10000, shieldFixedCurrent: o.fixed ?? 0, tempShield: o.temp ?? 0,
    lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: o.fac || 'red', faction: o.fac || 'red',
  };
  ents.add(e); return e;
}

// ==================== 一、治疗与护盾强度：口径与贯通 ====================
// 用户："治疗与护盾强度影响所有的相关属性"。排查结论：改动前它只作用于
// 生命偷取与伤害转化两处，healthRegen / 固定护盾 / 所有技能治疗与护盾全都不吃它
// —— 也就是光龙的「+8%」买了等于没买。
{
  T('强度系数：0% → 1.0（默认逐位不变）', healPowerOf({ healShieldPowerPct: 0 }) === 1);
  T('强度系数：+40% → 1.4', Math.abs(healPowerOf({ healShieldPowerPct: 40 }) - 1.4) < 1e-9);
  T('强度系数夹到 0（−100% 不该变成"治疗反而扣血"）',
    healPowerOf({ healShieldPowerPct: -150 }) === 0);
  T('固定护盾：强度作用在【上限】上（只乘"回满那一下"会被上限夹回去，等于没乘）',
    effectiveFixedShieldMax(1000, 1.2) === 1200);

  // 纯函数入口
  {
    const e = { alive: true, currentHP: 100 };
    T('applyHeal 乘强度并受封顶', applyHeal(e, 100, 1.5, 200) === 100 && e.currentHP === 200);
    const e2 = { alive: true, tempShield: 0 };
    T('grantTempShield 乘强度', grantTempShield(e2, 100, 0.6) === 60 && e2.tempShield === 60);
  }

  // 生命恢复：+100% 强度必须回得正好是两倍
  {
    const A = world();
    const a = unit(A.ents, { healthRegen: 10, hp: 5000 });
    const b = unit(A.ents, { healthRegen: 10, healShieldPowerPct: 100, hp: 5000 });
    window.gameTime = 0;
    for (let i = 0; i < 10; i++) { window.gameTime += 0.1; A.combat.update(0.1); }
    const dA = a.currentHP - 5000, dB = b.currentHP - 5000;
    T(`生命恢复吃强度（+0% 回 ${dA.toFixed(1)}，+100% 回 ${dB.toFixed(1)}，比值 2）`,
      dA > 0 && Math.abs(dB / dA - 2) < 1e-6);
  }

  // 固定护盾：强度抬高上限，回满回到更高的值
  {
    const A = world();
    const a = unit(A.ents, { shieldFixedMax: 1000 });
    const b = unit(A.ents, { shieldFixedMax: 1000, healShieldPowerPct: 50 });
    window.gameTime = 100;   // 远超 shieldRegenDelay
    A.combat.update(0.1);
    T(`固定护盾吃强度（+0% → ${a.shieldFixedCurrent}，+50% → ${b.shieldFixedCurrent}）`,
      a.shieldFixedCurrent === 1000 && Math.abs(b.shieldFixedCurrent - 1500) < 1e-6);
  }

  // 强度取【被治疗方】的：这是重伤能压住"别人给我的治疗"的前提
  T('healing.js 明确写了强度取接受方，并给出理由',
    /取\*\*接受治疗\/护盾的那一方\*\*/.test(fs.readFileSync('src/core/healing.js', 'utf8')));

  // 覆盖面：所有回血/给盾的地方都必须走统一入口，不许再出现裸的 currentHP += / tempShield +=
  {
    const files = ['src/systems/CombatSystem.js', 'src/core/skills/towerPassives.js',
                   'src/core/skills/dragonSouls.js', 'src/core/skills/minionPassives.js',
                   'src/core/behaviorVM.js'];
    let routed = 0;
    for (const f of files) if (/from '.*healing\.js'/.test(fs.readFileSync(f, 'utf8'))) routed++;
    T(`五处治疗/护盾来源全部改走 core/healing.js（${routed}/5）`, routed === 5);
  }
}

// ==================== 二、负防御：本来就该增伤，而且不能被"无视防御"抹掉 ====================
// 用户："如果闪电杖攻击该单位无视防御，但是这个单位的防御已经为负了……
//        那么你需要处理一下别把增伤减免没了。"
// 顺着查出来一个更早的 bug：calcEffectiveArmor 无条件 Math.max(0, …)，
// 把负抗性一律夹成 0 —— calcDamageMultiplier 里那条 resist<0 的增伤分支**从来没跑过**。
{
  T('负抗性本身就增伤（−50 → 1.333 倍）',
    Math.abs(attr.calcDamageMultiplier(attr.calcEffectiveArmor(-50, 0, 0)) - (2 - 100 / 150)) < 1e-9);
  T('穿透不能把正抗性打成负数变增伤（100 护甲吃 200 固定穿 → 0，不是 −100）',
    attr.calcEffectiveArmor(100, 0, 200) === 0);
  T('穿透对已经是负的抗性不再往下打（−50 吃 30% 穿 → 仍是 −50）',
    attr.calcEffectiveArmor(-50, 30, 10) === -50);

  const hit = (defOpts, ignore) => {
    const A = world();
    const atk = unit(A.ents, { attackDamage: 100, fac: 'blue' });
    const d = unit(A.ents, defOpts);
    A.combat.performAttackDirect(atk.id, d.id, 100, 'physical', { ignoreDefenseRatio: ignore });
    return 10000 - d.currentHP;
  };
  // 保护性防御：无视 90% 后伤害应当接近无防御时的水平
  T('正护甲 50：无视 0% → 66.7，无视 90% → 96.7（保护性防御确实被无视）',
    Math.abs(hit({ armor: 50 }, 0) - 200 / 3) < 0.01 && Math.abs(hit({ armor: 50 }, 0.9) - 96.667) < 0.01);
  // 负防御：无视多少都不该把增伤削掉
  T(`负护甲 −50：无视 0% 与 90% 伤害相同且 > 100（${hit({ armor: -50 }, 0).toFixed(1)} / ${hit({ armor: -50 }, 0.9).toFixed(1)}）`,
    Math.abs(hit({ armor: -50 }, 0) - hit({ armor: -50 }, 0.9)) < 1e-6 && hit({ armor: -50 }, 0.9) > 100);
  T(`负减伤 −40%：无视 90% 仍保留增伤（${hit({ damageReduction: -40 }, 0.9).toFixed(1)} = 140）`,
    Math.abs(hit({ damageReduction: -40 }, 0.9) - 140) < 1e-6);
  T(`负格挡 −30：无视 90% 仍保留增伤（${hit({ damageBlock: -30 }, 0.9).toFixed(1)} = 130）`,
    Math.abs(hit({ damageBlock: -30 }, 0.9) - 130) < 1e-6);
  // 负格挡只加一次，不因为伤害被拆成两股就算两遍
  T('负格挡只结算一次（不随无视比例翻倍）',
    Math.abs(hit({ damageBlock: -30 }, 0) - hit({ damageBlock: -30 }, 0.9)) < 1e-6);
}

// ==================== 三、伤害转化 = 实际扣掉的血 × 转化% × 强度 ====================
// 用户："伤害转化可能不好使，这个工作是实际减少的生命值百分比转化为临时护盾。"
// 排查结论：这一条**改动前就是对的**（用的是 finalDamage = min(剩余伤害, 当前HP)），
// 这里补上断言把它钉住，免得以后被改坏；同时钉住"强度也要乘"。
{
  const conv = (opts, raw) => {
    const A = world();
    const atk = unit(A.ents, { attackDamage: 100, fac: 'blue' });
    const d = unit(A.ents, opts);
    const hp0 = d.currentHP, sh0 = d.tempShield;
    A.combat.performAttackDirect(atk.id, d.id, raw, 'physical');
    return { lost: hp0 - d.currentHP, shieldDelta: d.tempShield - sh0, consumed: sh0 };
  };
  {
    const r = conv({ damageConvertPct: 50 }, 200);
    T(`纯扣血：护盾 = 扣血 × 50%（扣 ${r.lost}，得盾 ${r.shieldDelta}）`,
      r.lost === 200 && Math.abs(r.shieldDelta - 100) < 1e-9);
  }
  {
    // 带 100 临时盾：盾吸收 100，只有另外 100 是真扣血 → 只该按 100 转化
    const r = conv({ damageConvertPct: 50, temp: 100 }, 200);
    T(`护盾吸收的部分不参与转化（扣血 ${r.lost}，净盾变化 ${r.shieldDelta}）`,
      r.lost === 100 && Math.abs(r.shieldDelta - (-100 + 50)) < 1e-9);
  }
  {
    const r = conv({ damageConvertPct: 50, healShieldPowerPct: 100 }, 200);
    T(`转化护盾同样吃治疗与护盾强度（+100% → ${r.shieldDelta}）`,
      Math.abs(r.shieldDelta - 200) < 1e-9);
  }
  {
    // 致命一击：转化只按【实际扣掉的血】算，不按溢出的伤害
    const r = conv({ damageConvertPct: 50, hp: 50 }, 500);
    T(`致命伤只按实际扣血转化（HP 50 挨 500，扣 ${r.lost}，得盾 ${r.shieldDelta}）`,
      r.lost === 50 && Math.abs(r.shieldDelta - 25) < 1e-9);
  }
}

// ==================== 四、闪电杖：90% 无视防御 + 满充重伤 + 切目标严格归零 ====================
{
  const P = SkillLibrary.weapon_lightning.defaultParams;
  T('无视防御上限 90%（用户定稿，原 60%）', P.maxPenPct === 90);
  T('重伤 40%', P.grievousPct === 40);
  T('充能时间基准仍是 12s（用户："充能时间不要改"）', P.chargeTimeAtAS1 === 12);
  T('每跳 20% AD / 每秒 4 跳 / 满充 1.8 倍（方案B 三个数未动）',
    P.tickPct === 20 && P.tickPerSec === 4 && P.maxMult === 180);
  T('数值全部软编码（编辑器列的就是代码读的）',
    Object.keys(P).length >= 10 && !('damage' in P) && !('bounces' in P));

  const A = world();
  const tw = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, attackDamage: 100, baseAttackSpeed: 1.0,
                 attackSpeedRatio: 0.667, armor: 0, magicResist: 0 },
    currentHP: 5000, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [], _mapFaction: 'blue', faction: 'blue',
  };
  A.ents.add(tw);
  const inst = { id: ++window._uid, skillId: 'weapon_lightning', state: {} };
  tw._skillInstances.push(inst);
  SkillLibrary.weapon_lightning.onEquip(tw.id, inst, {});
  const t1 = unit(A.ents, { hp: 1e7, maxHP: 1e7 }); t1.pos = { x: 50, y: 0 };
  const t2 = unit(A.ents, { hp: 1e7, maxHP: 1e7 }); t2.pos = { x: 60, y: 0 };
  const ctx = { entityContainer: A.ents, effectRegistry: A.fx, attrCalc: attr,
                combat: A.combat, eventBus: A.bus };
  tw.targetId = t1.id;
  const DT = 1 / 30;
  window.gameTime = 0;
  const grievousOn = (e) => A.fx.getEffects(e.id).some(x => x.blueprint.name === '重伤');
  let sawGrievousBeforeFull = false;
  for (let i = 0; i < 30 / DT; i++) {
    window.gameTime = i * DT; attr.tick();
    SkillLibrary.weapon_lightning.onFrame(tw.id, DT, inst, ctx);
    A.fx.update(DT);
    if (inst.state.charge < 1 && grievousOn(t1)) sawGrievousBeforeFull = true;
    if (inst.state.charge >= 1) break;
  }
  T('能充满', (inst.state.charge || 0) >= 1);
  T('未满充【不】施加重伤（用户改口："改成满充能后才会施加"）', !sawGrievousBeforeFull);
  // 满充后再跑几跳，重伤必须挂上
  for (let i = 0; i < 20; i++) { window.gameTime += DT; attr.tick(); SkillLibrary.weapon_lightning.onFrame(tw.id, DT, inst, ctx); A.fx.update(DT); }
  T('满充后施加重伤', grievousOn(t1));
  {
    const st = attr.calc(t1, A.fx.getEffects(t1.id));
    T(`重伤 = 治疗与护盾强度 −40%（实际 ${st.healShieldPowerPct}）`, st.healShieldPowerPct === -40);
    T('重伤真的压住治疗（强度系数 0.6）', Math.abs(healPowerOf(st) - 0.6) < 1e-9);
  }
  // 切目标：充能严格归零（用户定稿"严格归零"）
  tw.targetId = t2.id;
  window.gameTime += DT; attr.tick();
  SkillLibrary.weapon_lightning.onFrame(tw.id, DT, inst, ctx);
  T(`切目标充能严格归零（切后 ${(inst.state.charge * 100).toFixed(1)}%，只该是这一帧充的那点）`,
    inst.state.charge < 0.02);
  // 旧目标身上的重伤是光环，停照后会自己脱落
  for (let i = 0; i < 40; i++) A.fx.update(0.05);
  T('切目标后旧目标的重伤自动脱落（光环宽限期，不需要额外清理代码）', !grievousOn(t1));
}

// ==================== 五、残弹：飞到落点，且不造成任何伤害（含爆炸型）====================
// 用户："残余的子弹会到达已经死亡的目标处才会消失而不是在半空直接消失，
//        并且这个子弹不造成任何伤害（包括爆炸型）。"
{
  const A = world();
  const proj = new ProjectileSystem(A.ents, A.bus, A.combat);
  A.combat.setProjectileSystem(proj);
  const atk = unit(A.ents, { attackDamage: 100, fac: 'blue' });
  const victim = unit(A.ents, { hp: 10 }); victim.pos = { x: 400, y: 0 };
  const bystander = unit(A.ents, { hp: 10000 }); bystander.pos = { x: 410, y: 0 };
  let resolved = 0, splashed = 0;
  A.combat._resolveHit = () => { resolved++; };
  A.combat._resolveHitSplashOnly = () => { splashed++; };   // 已删除的方法：不该再被调用
  proj.fire({
    targetId: victim.id, startX: 0, startY: 0, speed: 400, progress: 0,
    pendingHit: { attackerId: atk.id, targetId: victim.id, baseDamage: 100,
                  attackType: 'physical', weaponId: 'weapon_explosive' },
  });
  proj.update(0.1);                       // 飞一帧，记下最后落点
  const seenX = proj.getProjectiles()[0]?.currentX ?? -1;
  victim.alive = false;                   // 目标当场死亡
  let frames = 0;
  while (proj.getProjectiles().length && frames < 200) { proj.update(0.1); frames++; }
  T(`残弹继续飞完全程才消失（中途 x=${seenX.toFixed(0)}，共飞 ${frames + 1} 帧）`, frames >= 8);
  T('残弹不结算直伤', resolved === 0);
  T('残弹不结算溅射（爆炸型也一样）', splashed === 0);
  T('旁观者毫发无伤', bystander.currentHP === 10000);
  T('_resolveHitSplashOnly 已从 CombatSystem 删除（留着会让人以为死了还会炸）',
    !/^\s*_resolveHitSplashOnly\(/m.test(fs.readFileSync('src/systems/CombatSystem.js', 'utf8')));
}

// ==================== 六、天气：滑条拉到底 = 真的没有 ====================
// 用户："除了晴之外所有权重调到最低了，但是天气还是啥都有。"
// 根因：占比走 softmax，值域是开区间 (0,1)，**永远给不出 0**。
{
  const { WeatherSystem } = await import('../src/systems/WeatherSystem.js');
  const { BASE_WEATHERS, EXTREME_WEATHERS } = await import('../src/data/Weather.js');
  const ids = Object.keys(BASE_WEATHERS);
  const keep = ids[0];

  const ws = new WeatherSystem(new EventBus());
  ws.reset(20260801);
  for (const id of ids) if (id !== keep) ws.setMu(id, -1);
  let maxOther = 0;
  for (let i = 0; i < 3000; i++) {
    ws.update(0.1);
    const w = ws.getWeights();
    for (const id of ids) if (id !== keep) maxOther = Math.max(maxOther, w[id] || 0);
  }
  T(`其余天气拉到 −1 后占比严格 0（实测最大 ${(maxOther * 100).toFixed(3)}%）`, maxOther === 0);
  T(`保留的那个天气占满（${(ws.getWeights()[keep] * 100).toFixed(0)}%）`, ws.getWeights()[keep] === 1);
  let charged = 0;
  for (const id of ids) if (id !== keep && ws.getCharge(id) > 0) charged++;
  T('被关掉的天气充能也归零（不会靠残留充能继续生效）', charged === 0);
  T('留下的那个天气仍然能充能（兜底天气不能"占比 100% 却永远充不上能"）',
    ws.getCharge(keep) > 0.5);

  // 全部拉到底的兜底：占比之和仍然是 1（否则"当前天气"会变成 null）
  {
    const w2 = new WeatherSystem(new EventBus());
    w2.reset(7);
    for (const id of ids) w2.setMu(id, -1);
    w2.update(0.1);
    const w = w2.getWeights();
    const sum = ids.reduce((s, id) => s + (w[id] || 0), 0);
    T(`全部拉到底时仍保留一个天气（占比和 ${sum.toFixed(3)} = 1）`, Math.abs(sum - 1) < 1e-9);
  }

  // 极端天气的权重滑条同样是真开关
  {
    const w3 = new WeatherSystem(new EventBus());
    w3.reset(99);
    const exIds = Object.keys(EXTREME_WEATHERS);
    for (const id of exIds) w3.setExtremeWeight(id, -1);
    let maxEx = 0;
    for (let i = 0; i < 4000; i++) { w3.update(0.1); for (const id of exIds) maxEx = Math.max(maxEx, w3.getCharge(id)); }
    T(`极端天气权重拉到 −1 = 彻底不出现（实测最大充能 ${(maxEx * 100).toFixed(2)}%）`, maxEx === 0);
  }

  // 门槛：抬高之后极端天气占时间必须明显下降（用户："后期的极端天气特别多"）
  {
    const exIds = Object.keys(EXTREME_WEATHERS);
    const share = (scale) => {
      const save = CONFIG.tuning.weatherExtremeThresholdScale;
      CONFIG.tuning.weatherExtremeThresholdScale = scale;
      let hit = 0, tot = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const w = new WeatherSystem(new EventBus());
        w.reset(seed * 7919);
        for (let i = 0; i < 6000; i++) {
          w.update(0.1); tot++;
          if (exIds.some(id => w.getCharge(id) > 0.3)) hit++;
        }
      }
      CONFIG.tuning.weatherExtremeThresholdScale = save;
      return hit / tot;
    };
    const before = share(1.0), after = share(CONFIG.tuning.weatherExtremeThresholdScale);
    T(`抬高门槛后极端天气明显变少（${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%）`,
      after < before * 0.75);
    T('门槛倍率是软编码的', CONFIG.tuning.weatherExtremeThresholdScale > 1);
  }

  // 冷却：用户定稿"极端天气不要冷却"。排查结论是本来就没有，这里钉住"别有人加回去"。
  {
    // 只看【代码】，注释里当然会提到"没有冷却"这四个字。
    const src = fs.readFileSync('src/systems/WeatherSystem.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    T('极端天气没有冷却机制（用户："随即成啥样就是啥样"）',
      !/cooldown|冷却|_exCd|lastExtremeAt/i.test(src));
  }
}

// ==================== 七、昼夜周期：软编码，默认 8 分钟 ====================
{
  const { DAY_PERIOD, dayPeriodSec, resolveDayPhase } = await import('../src/presentation/DayNight.js');
  T('CONFIG 里有可编辑的一天时长', typeof CONFIG.world.dayPeriodSec === 'number');
  T(`默认 8 分钟（480 秒，原来是写死的 360）`, CONFIG.world.dayPeriodSec === 480);
  T('模块兜底常量也跟着改成 480（两处不一致会在 Config 缺字段时露馅）', DAY_PERIOD === 480);
  T('周期解析走唯一入口 dayPeriodSec', typeof dayPeriodSec === 'function' && dayPeriodSec({}) === 480);
  T('CTX 覆写优先于 CONFIG（调试杠杆仍然好使）', dayPeriodSec({ __dayPeriodSec: 120 }) === 120);
  T('相位按新周期走：t=240 正好是半天（黄昏）',
    Math.abs(resolveDayPhase(240, {}, true).phase - 0.5) < 1e-9);
  T('DayNight.js 里不再有写死的 360',
    !/DAY_PERIOD = 360/.test(fs.readFileSync('src/presentation/DayNight.js', 'utf8')));
  T('设置面板里有入口（软编码必须可改）',
    /dayPeriodSec/.test(fs.readFileSync('src/ui/SettingsDialog.js', 'utf8')));
}

// ==================== 八、植被：摆在墙顶，不是埋在墙里 ====================
// 用户："你这做的植被都跑到了贴图底下，正常根本看不到。"
{
  const veg = fs.readFileSync('src/presentation/VegetationLayer.js', 'utf8');
  const wall = fs.readFileSync('src/presentation/WallLayer.js', 'utf8');
  T('WallLayer 导出墙高（两边共用同一个数，不各写一份）', /export const WALL_H = 70;/.test(wall));
  T('VegetationLayer 用的是墙高而不是地形高度场', /import \{ WALL_H \} from '\.\/WallLayer\.js'/.test(veg));
  T('摆放高度确实来自 WALL_H', /const y0 = WALL_H - [\d.]+;/.test(veg));
  T('三类植被都用同一个高度', (veg.match(/push\(\[x, y0, y,/g) || []).length === 3);
  T('注释写清了根因（植被只撒在不可走格，而那些格被拔高到 WALL_H）',
    /WallLayer 把不可走区整块拔高到 WALL_H/.test(veg));
}

// ==================== 九、闪电轨迹：目标死了不许掉到地上 ====================
// 用户："闪电杖的轨迹在目标死后会漂移，如果目标在高地上，攻击该目标死亡后会瞬间往下移动。"
{
  const src = fs.readFileSync('src/presentation/EffectsLayer.js', 'utf8');
  T('末端高度按【实体是否还查得到】冻结，而不是等淡出才冻',
    /const liveH = b\.targetId != null \? MYOF\(b\.targetId\) : null;/.test(src));
  T('查不到就用最后一次的快照（不再退化成按坐标反查 → 塌到地面）',
    /const snap = this\._beamEndY\.get\(b\);/.test(src));
  T('注释写清了"晚冻 0.4 秒"这个真因', /冻结晚了整整 0\.4 秒/.test(src));
  // 流动效果：用户明确否掉了虚线，要"光里有东西在跑"
  T('有流动脉冲实现', /F\.pulses/.test(src) && /this\._beamPhase\.set\(b, ph\)/.test(src));
  T('脉冲两端用 sin(πt) 开窗（硬边就是"虚线感"的来源）', /Math\.sin\(Math\.PI \* t\)/.test(src));
  T('相位仍是逐帧积分（绝对时间×速度会在充能变速时瞬移）',
    /\(this\._beamPhase\.get\(b\) \|\| 0\) \+ spd \* dtWall/.test(src));
  T('流动参数软编码', typeof CONFIG.ui.beamFlow === 'object' && CONFIG.ui.beamFlow.enabled === true);
  T('可以关掉（关了就只剩原来的三层实带）', /F\.enabled !== false/.test(src));
}

console.log(`v41验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
