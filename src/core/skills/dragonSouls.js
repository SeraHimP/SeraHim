/**
 * dragonSouls.js —— 八条龙魂（v43 全部重做）
 *
 * ==================== 上一版为什么全部推翻 ====================
 * 上一版（以及我提的第一版方案）设计时默认了一个**不存在的东西：玩家**。
 * 用户当场否掉："龙魂效果是大型小兵和塔获得的，没有玩家！这些单位只会机械的攻击。"
 *
 * 这是设计层面的错误，不是数值没调好。领受龙魂的是：
 *   · 防御塔 —— 钉在原地，打射程内按优先级选出的目标；
 *   · 大型小兵 —— 沿固定路线走，打最近的敌人。
 * 它们**不做任何决策**：不会主动集火残血、不会切目标攒层、不会留技能等时机。
 * 所以"连续攻击同一目标每层 +15%、换目标清零"这类效果的实际价值只有两种：
 * 要么等于 0（没人去 focus），要么等于无限（塔的目标粘性让层数永不清零）。
 *
 * 现在这八条全部由用户定稿，共同点是**触发条件不需要判断**：
 * 命中就触发、受击就触发、每隔 N 秒就触发。单位再"机械"也能吃满。
 *
 * ==================== 数值口径 ====================
 * 全部进 CONFIG.dragonSouls，源码里不留魔数（编辑器可改）。
 * 平衡验收标准：用 tools/balance_matrix.mjs 的龙魂对照模式跑
 * "持魂方 vs 无魂方"，目标胜率 60~70%（不是 90%+）。超出就砍数值。
 *
 * ==================== 领受范围 ====================
 * 全部塔 + 大型小兵（= 除近战/远程外的所有兵种，含图腾兵）。
 * 判定走 DragonSystem.SOUL_REWARD_OK，**不直接读 isLargeMinion** ——
 * 那个标记还被别处用着（渲染体积等），两件事不该绑死在一个字段上。
 */
import { applyHeal, healPowerFor } from '../healing.js';
import { CONFIG } from '../../data/Config.js';

/** 取某条龙魂的参数（缺省回落到出厂值，编辑器改 CONFIG 即时生效）。 */
const P = (key) => (CONFIG.dragonSouls && CONFIG.dragonSouls[key]) || {};

/**
 * 冷却型龙魂的共用判定。
 * 用 gameTime 的**绝对时间戳**比较，而不是自己累加 dt —— onHit/onDealtDamage
 * 这类钩子拿不到 dt，而且绝对时间戳在"只跑部分系统"的仿真里也正确
 *（与本项目其它冷却 _lockUntil / _respawnAt 同口径）。
 */
function offCooldown(instance, seconds) {
  const now = (typeof window !== 'undefined' && window.gameTime) || 0;
  instance.state = instance.state || {};
  if (now < (instance.state.nextAt || 0)) return false;
  instance.state.nextAt = now + seconds;
  return true;
}

export const dragonSouls = {
  // ==================== 🔥 炎魂：攻击附带溅射（8s CD）====================
  dragonsoul_fire: {
    id: 'dragonsoul_fire', name: '炎魂', icon: '🔥', color: '#e74c3c', category: 'dragonsoul',
    get description() {
      const p = P('fire');
      const cd = p.cooldown ?? 0;
      return `攻击附带溅射伤害（半径 ${p.radius ?? 75}、${p.pct ?? 30}% 伤害）` + (cd > 0 ? `，冷却 ${cd} 秒。` : '，无冷却。');
    },
    get descTemplate() {
      const p = P('fire');
      const cd = p.cooldown ?? 0;
      return `唯一被动——炎魂：攻击附带溅射（【{val}】=${p.pct ?? 30}% 伤害，半径 ${p.radius ?? 75}）` + (cd > 0 ? `，冷却 ${cd} 秒。` : '，无冷却。');
    },
    computeCurrent: () => `${P('fire').pct ?? 30}%`,
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('fire');
      // v44：cooldown 为 0 时**不走冷却门**（常驻溅射）。
      // 8 秒一次的溅射在"机械攻击"的单位身上几乎感觉不到 —— 塔约 1.2 秒一次攻击，
      // 也就是七发里只有一发带溅射，玩家根本看不出来自己拿了炎魂。
      // 改成常驻低比例：总收益相近，但**稳定**，而且看得见。
      const cd = p.cooldown ?? 0;
      if (cd > 0 && !offCooldown(instance, cd)) return;
      const target = ctx.entityContainer.get(targetId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!target || !attacker || !ctx.combat) return;
      // 走引擎既有的溅射结算：中心取目标坐标、排除主目标（主伤害已单独结算）。
      ctx.combat._applyExplosion(attacker, target,
        (ctx.totalRaw || 0) * ((p.pct ?? 30) / 100),
        ctx.attackType || 'physical', p.radius ?? 75);
    },
  },

  // ==================== 🌊 潮魂：攻击后回复 + 治疗强度（8s CD）====================
  dragonsoul_water: {
    id: 'dragonsoul_water', name: '潮魂', icon: '🌊', color: '#3498db', category: 'dragonsoul',
    get description() {
      const p = P('water');
      return `攻击后回复自身【已损生命】的 ${p.healMissingPct ?? 8}%，并获得 ${p.powerPct ?? 25}% 治疗与护盾强度（持续 ${p.buffSec ?? 5} 秒），冷却 ${p.cooldown ?? 8} 秒。`;
    },
    get descTemplate() {
      const p = P('water');
      return `唯一被动——潮魂：攻击后回复（【{val}】=已损生命×${p.healMissingPct ?? 8}%）并获得 ${p.powerPct ?? 25}% 治疗与护盾强度 ${p.buffSec ?? 5} 秒，冷却 ${p.cooldown ?? 8} 秒。`;
    },
    computeCurrent: (entity, ctx) => {
      const s = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      const missing = Math.max(0, (s.maxHP || 0) - (entity.currentHP || 0));
      return Math.round(missing * ((P('water').healMissingPct ?? 8) / 100));
    },
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('water');
      if (!offCooldown(instance, p.cooldown ?? 8)) return;
      const e = ctx.entityContainer.get(attackerId);
      if (!e || !e.alive) return;
      const stats = ctx.attrCalc.calc(e, ctx.effectRegistry.getEffects(e.id));
      const missing = Math.max(0, (stats.maxHP || 0) - (e.currentHP || 0));
      // ⚠️ 回血**不无视**加固城防的节点封顶（用户定稿："不无视"）。
      // applyHeal 的 capHP 参数正是那个节点上限，塔身上由 fortify 写在 _regenCapHP。
      applyHeal(e, missing * ((p.healMissingPct ?? 8) / 100),
                healPowerFor(e, ctx), stats.maxHP, e._regenCapHP);
      ctx.effectRegistry.apply(attackerId, {
        name: '潮涌', icon: '🌊', kind: 'stat', color: '#3498db', type: 'buff',
        statKey: 'healShieldPowerPct', flatValue: p.powerPct ?? 25,
        duration: p.buffSec ?? 5, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        stackKey: 'dragonsoul_water_tide',
        description: `治疗与护盾强度 +${p.powerPct ?? 25}%`,
      }, 'dragonsoul_water');
    },
  },

  // ==================== 🗿 山魂：减伤 + 伤害格挡 ====================
  // ⚠️ 格挡是**每次命中扣固定值**，对小 AD 单位近乎免疫：
  // 近战兵 AD 9、远程兵 6.5，格挡给到 7 就等于把对手整条兵线的输出删掉
  //（我第一版方案写的就是 7，用户选了方案 A 砍到 2）。这个数不要再往上调。
  dragonsoul_earth: {
    id: 'dragonsoul_earth', name: '山魂', icon: '🗿', color: '#95a5a6', category: 'dragonsoul',
    get description() {
      const p = P('earth');
      return `获得 ${p.damageReduction ?? 33}% 伤害减免与 ${p.damageBlock ?? 2} 点伤害格挡。`;
    },
    get descTemplate() {
      const p = P('earth');
      return `唯一被动——山魂：【{val}】=${p.damageReduction ?? 33}% 伤害减免 + ${p.damageBlock ?? 2} 点伤害格挡。`;
    },
    computeCurrent: () => `${P('earth').damageReduction ?? 33}% / ${P('earth').damageBlock ?? 2}`,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const p = P('earth');
      for (const [statKey, value, label, unit] of [
        ['damageReduction', p.damageReduction ?? 33, '伤害减免', '%'],
        ['damageBlock', p.damageBlock ?? 2, '伤害格挡', ''],
      ]) {
        ctx.effectRegistry.apply(entityId, {
          name: '山魂', icon: '🗿', kind: 'stat', color: '#95a5a6', type: 'buff',
          statKey, flatValue: value,
          duration: Infinity, permanent: true,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          stackKey: `dragonsoul_earth_${statKey}`,
          description: `${label}+${value}${unit}`,
        }, 'dragonsoul_earth');
      }
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '山魂') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // ==================== ⚡ 雷魂：连锁真实伤害，最多 6 个敌人均摊（8s CD）====================
  dragonsoul_thunder: {
    id: 'dragonsoul_thunder', name: '雷魂', icon: '⚡', color: '#f1c40f', category: 'dragonsoul',
    get description() {
      const p = P('thunder');
      return `攻击附带连锁：对附近最多 ${p.targets ?? 6} 个敌人**各**造成 ${p.perTargetPct ?? 35}% 真实伤害，冷却 ${p.cooldown ?? 8} 秒。`;
    },
    get descTemplate() {
      const p = P('thunder');
      return `唯一被动——雷魂：连锁对最多 ${p.targets ?? 6} 个敌人各造成（【{val}】=${p.perTargetPct ?? 35}% 伤害）真实伤害，冷却 ${p.cooldown ?? 8} 秒。`;
    },
    computeCurrent: () => `${P('thunder').perTargetPct ?? 35}%`,
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('thunder');
      if (!offCooldown(instance, p.cooldown ?? 8)) return;
      const attacker = ctx.entityContainer.get(attackerId);
      const target = ctx.entityContainer.get(targetId);
      if (!attacker || !target || !ctx.combat) return;
      const n = Math.max(1, p.targets ?? 6);
      // ==================== v44：取消均摊 ====================
      // 旧语义是"总量固定、在最多 6 人间均摊"，于是打单体时每人 = 总量/6 —— 也就是说
      // 在**推塔**（这个游戏里最常见的情形）时它只有名义伤害的六分之一。
      // 对照数据里雷魂的推进度差是 -0.38，比不拿魂还差，根子就在这。
      // 现在每个目标各吃一份固定真伤，目标数仍然封顶（不会在人堆里失控）。
      const per = (ctx.totalRaw || 0) * ((p.perTargetPct ?? 35) / 100);
      ctx.combat.connectChain(attackerId, target, per, 'true',
                              n, p.range ?? 200, '#f1c40f');
    },
  },

  // ==================== 🌪 风魂：全体移速；塔攻速 ====================
  dragonsoul_wind: {
    id: 'dragonsoul_wind', name: '风魂', icon: '🌪', color: '#1abc9c', category: 'dragonsoul',
    get description() {
      const p = P('wind');
      const mv = p.moveSpeedPct ?? 0;
      return (mv > 0 ? `小兵移速 +${mv}%，脱战后提升至 +${p.moveSpeedOutPct ?? 25}%` : `小兵脱战后移速 +${p.moveSpeedOutPct ?? 25}%`)
           + `；防御塔额外获得 +${p.towerAttackSpeedRatio ?? 0.15} 攻速收益率（把所有攻速加成整体放大）。`;
    },
    get descTemplate() {
      const p = P('wind');
      return `唯一被动——风魂：小兵移速（【{val}%】，脱战后升至 +${p.moveSpeedOutPct ?? 25}%）；防御塔 +${p.towerAttackSpeedRatio ?? 0.15} 攻速收益率。`;
    },
    computeCurrent: (entity) => {
      const p = P('wind');
      return entity && entity._inCombat ? (p.moveSpeedPct ?? 0) : (p.moveSpeedOutPct ?? 25);
    },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const p = P('wind');
      const e = ctx.entityContainer.get(entityId);
      if (!e || e.type !== 'tower') return;
      // ==================== v44：塔的那一半从攻速改为射程 ====================
      // 上一版给塔的是攻速。但风魂的主题是"快"，而塔身上"快"的唯一有效形态不是攻速
      //（那和别的魂重复），是**更早开火** —— 射程 +45 意味着敌方兵线还没进场就先挨一轮，
      // 而且这份收益是复利的：塔多打一轮 → 兵线更早崩 → 塔挨的伤害更少 → 又多打一轮。
      // 对照数据里风魂是 -0.54（比不拿还差），移速那一半反而把兵线推得脱离己方塔的保护。
      // v45：塔那一半改回【速度】主题 —— 攻速收益率。
      // 它是**乘性**的：本项目的攻速公式是 有效加成 = 正值 × attackSpeedRatio(默认 0.667)，
      // 抬高收益率等于把这座塔身上所有来源的攻速加成一起放大，
      // 而且对"不会移动"的单位完全有效（射程那一版方向对，但主题不是速度）。
      ctx.effectRegistry.apply(entityId, {
        name: '风魂', icon: '🌪', kind: 'stat', color: '#1abc9c', type: 'buff',
        statKey: 'attackSpeedRatio', flatValue: p.towerAttackSpeedRatio ?? 0.15,
        duration: Infinity, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        stackKey: 'dragonsoul_wind_asr',
        description: `攻速收益率 +${p.towerAttackSpeedRatio ?? 0.15}`,
      }, 'dragonsoul_wind');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '风魂') ctx.effectRegistry.remove(eff.id);
      }
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const p = P('wind');
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive || e.type === 'tower') return;   // 塔移速恒 0，没必要每帧刷
      // 脱战判定复用引擎已有的 _inCombat / _combatTimer（攻击或受击时置起，4 秒后落下）。
      // 自己再记一套"上次交战时间"必然与引擎那套漂移 —— 双份状态是本项目的老毛病。
      const out = !e._inCombat;
      const pct = out ? (p.moveSpeedOutPct ?? 25) : (p.moveSpeedPct ?? 0);
      ctx.effectRegistry.apply(entityId, {
        name: '风魂', icon: '🌪', kind: 'stat', color: '#1abc9c', type: 'buff',
        aura: true, auraGrace: 1.0,
        statKey: 'moveSpeed', percentValue: pct,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        stackKey: 'dragonsoul_wind_ms',
        description: `移速 +${pct}%${out ? '（脱战）' : ''}`,
      }, 'dragonsoul_wind');
    },
  },

  // ==================== 🌑 暗魂：命中削双抗（全队共享层数）====================
  dragonsoul_dark: {
    id: 'dragonsoul_dark', name: '暗魂', icon: '🌑', color: '#8e44ad', category: 'dragonsoul',
    get description() {
      const p = P('dark');
      const st = p.steal !== false ? '，并为自己**偷取等量**双抗' : '';
      return `命中降低目标 ${p.flatPerStack ?? 1} 点与 ${p.pctPerStack ?? 0.5}% 双抗${st}，最多 ${p.maxFlat ?? 30} 点 / ${p.maxPct ?? 15}%；【友军攻击也会叠层】（全队共享同一份层数）。`;
    },
    get descTemplate() {
      const p = P('dark');
      const st = p.steal !== false ? '，同时为自己偷取等量' : '';
      return `唯一被动——暗魂：命中削目标双抗（【{val}】=每层 ${p.flatPerStack ?? 1} 点 + ${p.pctPerStack ?? 0.5}%）${st}，上限 ${p.maxFlat ?? 30} 点 / ${p.maxPct ?? 15}%，友军攻击共享层数。`;
    },
    computeCurrent: () => `-${P('dark').maxFlat ?? 30} / -${P('dark').maxPct ?? 15}%`,
    effects: [],
    onHit: (attackerId, targetId, instance, ctx) => {
      const p = P('dark');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;
      const maxStacks = Math.max(1, Math.round((p.maxFlat ?? 30) / (p.flatPerStack ?? 1)));
      for (const [statKey, label] of [['armor', '护甲'], ['magicResist', '魔抗']]) {
        // uniquePassive:true + **固定** sourceId ⇒ 全队共用一份层数
        //（用户定稿："不可叠加，但是友军单位攻击也会增加层数"）。
        // 若按攻击者分源，五个单位打同一个目标会各攒各的，实际削抗变成五倍。
        //
        // 顺带说明减抗的**顺序**（用户定稿："所有减抗的都按照先固定后百分比"）：
        // 属性合成管线本来就是 `value += flat; value *= (1 + percent/100)`，
        // 也就是先固定后百分比 —— 这里把 flat 与 percent 挂在同一条效果上即可，
        // 不需要额外处理。双抗允许被打成负数（负抗性在本作是增伤的）。
        ctx.effectRegistry.apply(targetId, {
          name: '侵蚀', icon: '🌑', kind: 'stat', color: '#8e44ad', type: 'debuff',
          statKey,
          flatValue: -(p.flatPerStack ?? 1), perStackFlat: -(p.flatPerStack ?? 1),
          percentValue: -(p.pctPerStack ?? 0.5), perStackPercent: -(p.pctPerStack ?? 0.5),
          duration: p.duration ?? 6,
          stackable: true, maxStacks, stackPolicy: 'stack', uniquePassive: true,
          stackKey: `dragonsoul_dark_${statKey}`,
          descTemplate: `唯一被动——侵蚀：${label}降低（【{val}】），{stacks}/${maxStacks} 层。`,
          description: `${label}降低（{stacks}/${maxStacks}层）`,
        }, 'dragonsoul_dark');

        // ==================== v44：削掉多少，自己就偷多少 ====================
        // 纯减抗在 v43 的对照里是最差的一档（推进度差 -0.90，垫底）。
        // 根子在于：减抗只有在**自己有输出**的时候才值钱，而塔和大兵的输出是固定的 ——
        // 把对方护甲削 30 点，多打出来的那点伤害远不如"自己多 30 点护甲"活得久。
        // 现在改成偷取：对方掉多少、自己加多少，上限同。攻防一体，收益不再单边。
        if (p.steal !== false) {
          ctx.effectRegistry.apply(attackerId, {
            name: '掠夺', icon: '🌑', kind: 'stat', color: '#8e44ad', type: 'buff',
            statKey,
            flatValue: (p.flatPerStack ?? 1), perStackFlat: (p.flatPerStack ?? 1),
            percentValue: (p.pctPerStack ?? 0.5), perStackPercent: (p.pctPerStack ?? 0.5),
            duration: p.duration ?? 6,
            stackable: true, maxStacks, stackPolicy: 'stack', uniquePassive: true,
            stackKey: `dragonsoul_dark_steal_${statKey}`,
            descTemplate: `唯一被动——掠夺：${label}提升（【{val}】），{stacks}/${maxStacks} 层。`,
            description: `${label}提升（{stacks}/${maxStacks}层）`,
          }, 'dragonsoul_dark_steal');
        }
      }
    },
  },

  // ==================== ☠️ 毒魂：命中叠中毒，无限叠加 ====================
  dragonsoul_poison: {
    id: 'dragonsoul_poison', name: '毒魂', icon: '☠️', color: '#27ae60', category: 'dragonsoul',
    get description() {
      const p = P('poison');
      return `攻击对敌方施加一层中毒：每层每秒造成目标 ${p.pctPerStack ?? 0.4}% 最大生命的魔法伤害，`
           + `可无限叠加，持续 ${p.duration ?? 4} 秒（对【建筑】按 ${p.vsBuildingPct ?? 25}% 计）。`;
    },
    get descTemplate() {
      const p = P('poison');
      return `唯一被动——毒魂：命中叠一层中毒（【{val}】=每层每秒 ${p.pctPerStack ?? 0.4}% 最大生命魔法伤害），`
           + `无限叠加，${p.duration ?? 4} 秒；对建筑 ${p.vsBuildingPct ?? 25}%。`;
    },
    computeCurrent: () => `${P('poison').pctPerStack ?? 0.4}%`,
    effects: [],
    onHit: (attackerId, targetId, instance, ctx) => {
      const p = P('poison');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;
      const stats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id));
      // 百分比最大生命的 DoT 天然反建筑（血越厚越疼），所以对建筑单独打折。
      // 算过账：一波兵（近战3×1.25 + 远程3×0.667 + 炮兵1×1.0 ≈ 6.75 次/秒）
      // 在 4 秒持续时间下的稳态层数约 27 层。不打折的话 27×0.4% = 10.8% 最大生命/秒，
      // 9000 血的塔十秒就没了 —— 整张图两三波兵推平。
      const k = (target.type === 'tower') ? ((p.vsBuildingPct ?? 25) / 100) : 1;
      const perStack = (stats.maxHP || 0) * ((p.pctPerStack ?? 0.4) / 100) * k;
      if (perStack <= 0) return;
      // maxStacks 给一个极大值 = 用户要的"无限叠加"。
      // 实际稳态层数 = 施加速率 × 持续时间，是个**有界的确定值**，所以"无限"不会真的发散
      // —— 真正的旋钮是每层的百分比，不是层数上限。
      ctx.effectRegistry.apply(targetId, {
        name: '腐毒', icon: '☠️', kind: 'dot', color: '#27ae60', type: 'debuff',
        damageType: 'magic',
        flatValue: perStack, perStackFlat: perStack,
        tickInterval: 1, duration: p.duration ?? 4,
        stackable: true, maxStacks: p.maxStacks ?? 999, stackPolicy: 'stack', uniquePassive: true,
        stackKey: 'dragonsoul_poison',
        descTemplate: '唯一被动——腐毒：每秒（【{val}】）魔法伤害，{stacks} 层。',
        description: '腐毒（{stacks}层）',
      }, 'dragonsoul_poison');
    },
  },

  // ==================== 🐲 远古之力（限时 240s 的处决）====================
  // 用户定稿：八条龙魂全部**永久**，只有这一条限时。
  // 它是龙魂之外的独立奖励 —— 成魂后元素龙停刷、只出远古龙，**双方都能抢**。
  // 定位是落后方的翻盘工具：处决专治"最后 20% 特别难啃"，
  // 恰好克制山魂/光魂/潮魂这三条防守型龙魂。
  dragonsoul_ancient: {
    id: 'dragonsoul_ancient', name: '远古之力', icon: '🐲', color: '#e67e22', category: 'dragonsoul',
    get description() {
      const p = P('ancient');
      return `对生命低于最大值 ${p.executeAtPct ?? 20}% 的敌方单位额外造成其 ${p.executePct ?? 20}% 最大生命的真实伤害（处决）。持续 ${p.durationSec ?? 240} 秒。`;
    },
    get descTemplate() {
      const p = P('ancient');
      return `远古之力：对生命低于 ${p.executeAtPct ?? 20}% 的敌人额外造成（【{val}】=${p.executePct ?? 20}% 最大生命）真实伤害。`;
    },
    computeCurrent: () => `${P('ancient').executePct ?? 20}%`,
    effects: [],
    onHit: (attackerId, targetId, instance, ctx) => {
      const p = P('ancient');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive || !ctx.combat) return;
      const stats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id));
      const maxHP = stats.maxHP || 0;
      if (maxHP <= 0) return;
      if ((target.currentHP || 0) > maxHP * ((p.executeAtPct ?? 20) / 100)) return;
      // _noProc：处决伤害不再触发 onHit，否则会与自己递归
      ctx.combat.performAttackDirect(attackerId, targetId,
        maxHP * ((p.executePct ?? 20) / 100), 'true', { _noProc: true });
    },
  },
};

/**
 * ==================== v44：给每条魂补上【数值部分】 ====================
 * 用户定稿："巨龙之力做成简单的数值调整。龙魂做成数值+机制的。"
 *
 * 于是每条魂 = 一份常驻属性（这里）+ 一份机制（上面各自的 onHit/onFrame/…）。
 * 属性表住在 CONFIG.dragonSouls.stat[元素]，键名即 statKey，
 * 以 `Pct` 结尾的算百分比 —— 与 CONFIG.dragonPower 同一套约定，只有一份规则要记。
 *
 * 为什么在这里统一包一层，而不是在七条定义里各写一遍 onEquip：
 * 那样等于把同一件事抄七遍，改一处漏六处是迟早的事。这里包一层之后，
 * 七条魂的定义里只剩下**它自己独有的机制**，数值全部由配置驱动。
 *
 * ⚠️ 为什么每条魂的数值里都有一份生存分量（哪怕它的主题是输出）：
 * v43 的对照数据显示，这个引擎里输出收益封顶、生存收益复利
 *（塔和大兵机械攻击，输出增益只是把本来就杀得掉的东西杀快一点）。
 * 当时纯输出的炎/雷/暗三条魂推进度差全为负 —— 比不拿还差。
 * 独占性的要求落在【巨龙之力】上（每种元素的属性互不重复），
 * 平衡的要求落在【魂】上，两边不打架。
 */
const SOUL_STAT_KEYS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison'];

// 属性中文名。只覆盖龙魂用得到的那几项 —— 面板那份完整表在 UI 层（editor/fields.js），
// core 不该反向依赖 UI，所以这里留一份小的。多出来的键会原样显示，不会漏说。
const STAT_LABEL = {
  attackDamage: '攻击力', maxHP: '最大生命', armor: '护甲', magicResist: '魔抗',
  healShieldPowerPct: '治疗与护盾强度', healthRegen: '生命回复',
  armorPenFlat: '固定护甲穿透', magicPenFlat: '固定法术穿透',
  bonusAttackSpeedPct: '攻速', attackRange: '攻击距离',
  damageAmpPct: '伤害增幅', lifeStealPct: '生命偷取',
  onHitPercentDamage: '攻击特效%当前生命',
};

/** 把某条魂的常驻属性拼成一句人话，追加到面板文案里。 */
function statSummary(el) {
  const tbl = (CONFIG.dragonSouls && CONFIG.dragonSouls.stat && CONFIG.dragonSouls.stat[el]) || null;
  if (!tbl) return '';
  const parts = Object.entries(tbl).map(([k, v]) => {
    const pct = k.endsWith('Pct');
    const key = pct ? k.slice(0, -3) : k;
    const label = STAT_LABEL[k] || STAT_LABEL[key] || key;
    // 键名本身带 Pct（如 healShieldPowerPct）时不要再补一个 %，否则会写成"强度 +20%%"
    const unit = pct ? '%' : (/Pct$/.test(key) ? '%' : '');
    return `${label} +${v}${unit}`;
  });
  return parts.length ? `　常驻加持：${parts.join('、')}。` : '';
}

/** 某条魂的常驻属性蓝图列表（读 CONFIG，编辑器改了立刻生效）。 */
export function soulStatBlueprints(el) {
  const tbl = (CONFIG.dragonSouls && CONFIG.dragonSouls.stat && CONFIG.dragonSouls.stat[el]) || null;
  if (!tbl) return [];
  const def = dragonSouls['dragonsoul_' + el] || {};
  return Object.entries(tbl).map(([k, v]) => {
    const pct = k.endsWith('Pct');
    return {
      name: `${def.name || el}·加持`, icon: def.icon || '🐉', color: def.color, kind: 'stat',
      statKey: pct ? k.slice(0, -3) : k,
      flatValue: pct ? 0 : v, percentValue: pct ? v : 0,
      duration: Infinity, permanent: true,
      stackable: false, stackPolicy: 'refresh', uniquePassive: true,
      stackKey: `soul_stat_${el}_${k}`,
      description: `${def.name || el}的常驻加持`,
    };
  });
}

for (const el of SOUL_STAT_KEYS) {
  const def = dragonSouls['dragonsoul_' + el];
  if (!def) continue;

  // 文案：把常驻属性追加进去。
  // 不追加的话面板会**少说一半** —— sim_skilldesc 那套"文案数值与实际效果一致"的断言
  // 当场就会红（它逐条比对技能挂出来的效果数值有没有出现在文案里）。
  // 那条断言是对的：面板上看不到的加成，等于玩家不知道自己拿了什么。
  for (const key of ['description', 'descTemplate']) {
    const d = Object.getOwnPropertyDescriptor(def, key);
    if (!d) continue;
    if (d.get) {
      const orig = d.get;
      Object.defineProperty(def, key, {
        configurable: true, enumerable: d.enumerable,
        get() { return String(orig.call(this)) + statSummary(el); },
      });
    } else if (typeof d.value === 'string') {
      const orig = d.value;
      Object.defineProperty(def, key, {
        configurable: true, enumerable: d.enumerable,
        get() { return orig + statSummary(el); },
      });
    }
  }

  const prevEquip = def.onEquip, prevUnequip = def.onUnequip;
  def.onEquip = (entityId, instance, ctx) => {
    if (prevEquip) prevEquip(entityId, instance, ctx);
    if (!ctx || !ctx.effectRegistry) return;
    for (const bp of soulStatBlueprints(el)) {
      ctx.effectRegistry.apply(entityId, { ...bp }, `soul_stat_${el}`);
    }
  };
  def.onUnequip = (entityId, instance, ctx) => {
    if (prevUnequip) prevUnequip(entityId, instance, ctx);
    if (!ctx || !ctx.effectRegistry) return;
    for (const eff of ctx.effectRegistry.getEffects(entityId)) {
      if (eff.sourceId === `soul_stat_${el}`) ctx.effectRegistry.remove(eff.id);
    }
  };
}

export default dragonSouls;
