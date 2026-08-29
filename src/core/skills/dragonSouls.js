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
import { statMod } from '../statMod.js';
import { applyHeal, healPowerFor, grantTempShield } from '../healing.js';
import { MELEE_RANGE_THRESHOLD } from '../../data/Config.js';
import { CONFIG } from '../../data/Config.js';

/** 取某条龙魂的参数（缺省回落到出厂值，编辑器改 CONFIG 即时生效）。 */
const P = (key) => (CONFIG.dragonSouls && CONFIG.dragonSouls[key]) || {};

/**
 * ==================== 龙魂给的吸血类加成对塔削弱到 33% ====================
 * 用户定稿："所有龙魂作用增加的吸血（物理/魔法/全能）对防御塔这种单位的数值
 * 减少至33%。" 只削"龙魂"（dark 的全能吸血 lifeStealPct、poison 的法术吸血
 * spellVampPct、blood 的物理吸血 physicalVampPct + blood 自己"狂血"机制里的
 * 全能吸血 lifeStealPct），不动巨龙之力（dragonPower.dark.lifeStealPct）——
 * 用户点名的是"龙魂"，力是另一条独立的过程奖励线。
 * 只削塔：塔是钉死原地开火、永远不脱靶的机械单位，同一份吸血系数放它身上
 * 比放会走位/会被集火打断输出的大型小兵身上明显更稳定、更划算。
 */
const VAMP_STAT_KEYS = new Set(['lifeStealPct', 'physicalVampPct', 'spellVampPct']);
/** 与算数值时用同一条公式（v * 百分比 / 100，四舍五入到 2 位小数），文案与实际生效值才能逐位对上。 */
function towerVampScaled(v) {
  const pct = (CONFIG.dragonSouls && CONFIG.dragonSouls.vampTowerScalePct) ?? 33;
  return Math.round(v * pct) / 100;
}
/** entity 是塔时把吸血类数值削到 towerVampScaled()，否则原样返回。 */
function vampForEntity(entity, statKey, v) {
  if (!VAMP_STAT_KEYS.has(statKey) || !entity || entity.type !== 'tower') return v;
  return towerVampScaled(v);
}

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
    applicableTypes: ['tower'],
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
    // procMode 用默认的 'always'（不声明）——用户定稿：炎魂的溅射要"跟手"，
    // 闪电杖每 0.25 秒一跳就该溅射一次、每次按那一跳自己的 totalRaw 算 pct%。
    // 这天然就是对的：不节流、不累加，4 跳各自结算，累计起来正好等于一次
    // 完整攻击的溅射总量，不需要额外处理——这正是 'always' 存在的意义。
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
      // v51：这是龙魂自己的溅射（技能效果），不是普攻自带的那圈——basicAttack:false
      // 让它吃到技能增幅/技能暴击。见 CombatSystem._applyExplosionAt 的头注。
      ctx.combat._applyExplosion(attacker, target,
        (ctx.totalRaw || 0) * ((p.pct ?? 30) / 100),
        ctx.attackType || 'physical', p.radius ?? 75, { basicAttack: false });
    },
  },

  // ==================== 🌊 潮魂：攻击后回复 + 治疗强度（8s CD）====================
  dragonsoul_water: {
    id: 'dragonsoul_water', name: '潮魂', icon: '🌊', color: '#3498db', category: 'dragonsoul',
    applicableTypes: ['tower'],
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
    // procMode：'perAttack'——回血/冷却检查按"完整一次攻击"判定一次，不是分帧
    // 攻击的每一小份都各查一次冷却。这条本身不读 ctx.totalRaw（回血基数是自己的
    // 已损生命，不是伤害值），声明这个只是为了跟雷魂/暗魂/毒魂那一类保持同一套
    // 频率语义，不是因为它本身会被数值上的累加影响。
    procMode: 'perAttack',
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
    applicableTypes: ['tower'],
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
    applicableTypes: ['tower'],
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
    // procMode：'perAttack'——关键修复点。这条**依赖 ctx.totalRaw** 算连锁伤害
    // （per = totalRaw × pct%）。闪电杖每跳只有约 1/4 攻击的伤害，之前这里没声明
    // procMode 时走的是旧的"每次伤害都判、伤害基数用当次"，冷却虽然对（8秒真实
    // 冷却兜底），但触发那一下的 totalRaw 只是某一跳的量，威力被削到约四分之一。
    // 声明 'perAttack' 后，触发时 ctx.totalRaw 会是"攒够一次完整攻击"期间的
    // 累计伤害，威力恢复正常；普通攻击（attackShare 恒为1）不受影响，逐位不变。
    procMode: 'perAttack',
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
    applicableTypes: ['tower'],
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
    applicableTypes: ['tower'],
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
    // procMode：'perAttack'——按"完整一次攻击"叠一层（用户定稿："当成攻速为1的
    // 武器，每1秒叠一次层"），不是特殊攻击方式的每一小份伤害都叠一次。
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
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
    applicableTypes: ['tower'],
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
    // procMode：'perAttack'——同上，命中叠层按"完整一次攻击"算一次。
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
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
      }, 'dragonsoul_poison', { casterId: attackerId });
    },
  },

  // ==================== 🧊 霜魂：控制（对建筑改为减攻速）====================
  // 用户定稿："霜龙魂的冻结也太超标了吧。冻结目标后该目标 15 秒内免疫冻结
  //（显示在被冻结目标的状态栏里）。塔的话可以（做减攻速的）。"
  //
  // 免疫是这条魂能不能存在的前提：没有它，一条兵线上多个持魂单位轮流冻，
  // 一个目标可以被**永久锁死**，那就不是控制而是删除。
  dragonsoul_frost: {
    id: 'dragonsoul_frost', name: '霜魂', icon: '🧊', color: '#7fd3f7', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('frost');
      return `攻击叠一层【霜冻】，满 ${p.stacksToFreeze ?? 5} 层冻结目标 ${p.freezeSec ?? 1.2} 秒；`
        + `被冻结的目标随后 ${p.immuneSec ?? 15} 秒内免疫冻结。`
        + `对**建筑**不冻结，改为每层攻速 ${p.towerAtkSpeedPct ?? -6}%（最多 ${p.towerMaxStacks ?? 8} 层）。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('frost');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;

      // ---- 建筑：不冻结，改叠攻速衰减 ----
      if (target.type === 'tower') {
        ctx.effectRegistry.apply(targetId, {
          name: '霜蚀', icon: '🧊', kind: 'stat', color: '#7fd3f7', type: 'debuff',
          statKey: 'bonusAttackSpeedPct',
          flatValue: p.towerAtkSpeedPct ?? -6, perStackFlat: p.towerAtkSpeedPct ?? -6,
          duration: p.towerDebuffSec ?? 4,
          stackable: true, maxStacks: p.towerMaxStacks ?? 8, stackPolicy: 'stack', uniquePassive: true,
          description: `霜蚀（{stacks}层，每层攻速${p.towerAtkSpeedPct ?? -6}%）`,
        }, 'dragonsoul_frost_tower', { casterId: attackerId });
        return;
      }

      // ---- 单位：叠层 → 满层冻结 → 进入免疫 ----
      const effs = ctx.effectRegistry.getEffects(targetId);
      // 免疫期内连层都不叠：否则免疫一结束就立刻二次冻结，等于免疫没起作用。
      if (effs.some(e => e.blueprint.name === '冻结免疫')) return;

      const need = p.stacksToFreeze ?? 5;
      const id = ctx.effectRegistry.apply(targetId, {
        name: '霜冻', icon: '❄️', kind: 'stat', color: '#7fd3f7', type: 'debuff',
        statKey: 'moveSpeed', flatValue: -2, perStackFlat: -2,
        duration: p.stackDuration ?? 4,
        stackable: true, maxStacks: need, stackPolicy: 'stack', uniquePassive: true,
        description: `霜冻（{stacks}/${need}层，满层冻结）`,
      }, 'dragonsoul_frost', { casterId: attackerId });
      const eff = ctx.effectRegistry.getEffect(id);
      if (!eff || eff.stacks < need) return;

      ctx.effectRegistry.remove(eff.id);                 // 触发即清空层数
      ctx.effectRegistry.apply(targetId, {
        name: '冻结', icon: '🧊', kind: 'stun', color: '#7fd3f7', type: 'debuff',
        duration: p.freezeSec ?? 1.2,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: '被冻结：无法行动',
      }, 'dragonsoul_frost_freeze', { casterId: attackerId });
      // 用户明确要求这一格要能在被冻目标的状态栏里看到，且写清楚"这段时间内不会再被冻"。
      ctx.effectRegistry.apply(targetId, {
        name: '冻结免疫', icon: '🛡', kind: 'display', color: '#aee7ff', type: 'buff',
        duration: p.immuneSec ?? 15,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `该时间内不会受到冻结（${p.immuneSec ?? 15} 秒）`,
      }, 'dragonsoul_frost_immune');
    },
  },

  // ==================== 🛡 铁魂：周期护盾 + 近战反弹 ====================
  // 用户定稿："铁龙可以改为获得固定护盾 + 百分比生命值/已损/最大的护盾。"
  // 四档来源全部预留成参数（具体数值以后再定），护盾在场时反弹近战伤害。
  dragonsoul_steel: {
    id: 'dragonsoul_steel', name: '钢魂', icon: '🛡', color: '#b0bec5', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('steel');
      return `每 ${p.everySec ?? 8} 秒获得一层护盾（固定 ${p.flat ?? 120}`
        + ` + 最大生命 ${p.maxHPPct ?? 3}% + 已损生命 ${p.missingHPPct ?? 6}% + 当前生命 ${p.currentHPPct ?? 0}%）；`
        + `护盾存在期间，受到的近战伤害反弹 ${p.reflectPct ?? 30}%（真实伤害）。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const p = P('steel');
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const st = instance.state || (instance.state = { t: 0 });
      st.t = (st.t || 0) + dt;
      const per = Math.max(0.1, p.everySec ?? 8);
      if (st.t < per) return;
      st.t -= per;
      const stats = ctx.attrCalc.calc(e, ctx.effectRegistry.getEffects(entityId));
      const maxHP = stats.maxHP || 0;
      const cur = Math.max(0, e.currentHP || 0);
      const missing = Math.max(0, maxHP - cur);
      const amount = (p.flat ?? 120)
        + maxHP * ((p.maxHPPct ?? 3) / 100)
        + missing * ((p.missingHPPct ?? 6) / 100)
        + cur * ((p.currentHPPct ?? 0) / 100);
      if (amount <= 0) return;
      // 走临时护盾：固定护盾是"脱战回满"的那一套，套在它上面会与自身回复打架。
      grantTempShield(e, amount, healPowerFor(e, ctx));
    },
    /** 受击时反弹：只反弹**近战**来源，且是真伤（绕过对方防御）。 */
    onDamaged: (entityId, attackerId, amount, ctx) => {
      const p = P('steel');
      const self = ctx.entityContainer.get(entityId);
      const atk = ctx.entityContainer.get(attackerId);
      if (!self || !atk || !atk.alive) return;
      if ((self.tempShield || 0) + (self.shieldFixedCurrent || 0) <= 0) return;   // 没盾不反弹
      if ((atk.baseStats?.attackRange ?? 999) > MELEE_RANGE_THRESHOLD) return;     // 只反近战
      const back = amount * ((p.reflectPct ?? 30) / 100);
      if (back > 0) ctx.combat?.performAttackDirect?.(entityId, attackerId, back, 'true', { _noProc: true });
    },
  },

  // ==================== 🩸 血魂：越残血越强（33% 时峰值）====================
  // 用户定稿："血龙龙魂可以改为损失生命值百分比越多，获得某属性越多。……
  //           +攻击力 +攻速 +生命偷取。生命值在 33% 时增益最大。"
  // 33% 以下**维持峰值不再回落** —— 越接近死亡收益反而下降会很怪。
  // 这条天然自限（满血时收益为 0），不会滚雪球，正好是"落后方的翻盘工具"。
  dragonsoul_blood: {
    id: 'dragonsoul_blood', name: '血魂', icon: '🩸', color: '#c0392b', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('blood');
      const vamp = p.lifeStealPct ?? 10;
      return `生命值越低增益越高，在 ${p.peakAtHPPct ?? 33}% 生命时达到峰值并保持：`
        + `攻击力 +${p.attackDamagePct ?? 30}%、攻速 +${p.bonusAttackSpeedPct ?? 25}%、`
        + `全能吸血 +${vamp}%（对防御塔按 ${CONFIG.dragonSouls?.vampTowerScalePct ?? 33}% 生效，`
        + `即 +${towerVampScaled(vamp)}%）。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const p = P('blood');
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const stats = ctx.attrCalc.calc(e, ctx.effectRegistry.getEffects(entityId));
      const maxHP = stats.maxHP || 1;
      const frac = Math.max(0, Math.min(1, (e.currentHP || 0) / maxHP));
      const peak = Math.max(1, Math.min(99, p.peakAtHPPct ?? 33)) / 100;
      // 100% 生命 → 0；peak 生命 → 1；低于 peak 维持 1。
      const k = frac >= 1 ? 0 : Math.max(0, Math.min(1, (1 - frac) / (1 - peak)));
      // 每帧改数值会让状态图标每帧重建（闪烁+点不中，本项目踩过），
      // 所以按"量化到整数百分点"节流：只有 k 变了一个百分点才动效果。
      const q = Math.round(k * 100);
      if (instance.state?.q === q) return;
      instance.state = instance.state || {};
      instance.state.q = q;
      const cur = ctx.effectRegistry.getEffects(entityId).filter(x => x.blueprint.name === '狂血');
      for (const c of cur) ctx.effectRegistry.remove(c.id);
      if (q <= 0) return;
      for (const [statKey, base] of [
        ['attackDamage', p.attackDamagePct ?? 30],
        ['bonusAttackSpeedPct', p.bonusAttackSpeedPct ?? 25],
        ['lifeStealPct', p.lifeStealPct ?? 10],
      ]) {
        // attackDamage 走百分比，另两项本身就是百分比属性 → 走固定值加成
        const isPct = statKey === 'attackDamage';
        // 全能吸血对塔削到 33%（用户定稿，见文件头的 vampForEntity 头注）；
        // 攻击力/攻速两项是狂血的主方向，不受这条规则影响。
        const rawFlat = isPct ? 0 : base * k;
        ctx.effectRegistry.apply(entityId, {
          name: '狂血', icon: '🩸', kind: 'stat', color: '#c0392b', type: 'buff',
          statKey,
          flatValue: vampForEntity(e, statKey, rawFlat),
          percentValue: isPct ? base * k : 0,
          duration: Infinity, permanent: true,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `狂血：残血强化（当前 ${q}%）`,
        }, `dragonsoul_blood_${statKey}`);
      }
    },
  },

  // ==================== 🌋 熔魂：跟着目标走的灼烧圈 ====================
  // 用户定稿："熔龙改为对目标施加灼烧效果，灼烧效果是有半径的，可以对其他单位造成伤害。"
  // 追加定稿："跟着中毒目标走。"—— 所以它是一个**会移动的伤害圈**，对密集兵线最强，
  // 与毒魂（百分比最大生命、天然反建筑）正好是相反的定位。
  dragonsoul_magma: {
    id: 'dragonsoul_magma', name: '熔魂', icon: '🌋', color: '#d35400', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('magma');
      return `攻击对目标施加【灼烧】${p.duration ?? 4} 秒：以该目标为中心 ${p.radius ?? 70} 半径内的敌人`
        + `每秒受到其最大生命 ${p.tickDamagePct ?? 0.6}% 的真实伤害并减速 ${p.slowPct ?? 20}%（灼烧圈跟着目标移动）。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('magma');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;
      const stats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(targetId));
      const perTick = (stats.maxHP || 0) * ((p.tickDamagePct ?? 0.6) / 100);
      // 两条效果**同名**，状态栏因此合成一格（按 blueprint.name 聚合）。
      //   ① dot + auraRadius —— 伤害本体。半径那一半由 BuffSystem 通用处理，
      //      圈的中心天然是持有者的当前位置，"跟着目标走"不需要额外维护任何东西。
      //   ② stat —— 减速。
      ctx.effectRegistry.apply(targetId, {
        name: '灼烧', icon: '🌋', kind: 'dot', color: '#d35400', type: 'debuff',
        damageType: 'true',
        flatValue: perTick, perStackFlat: perTick,
        tickInterval: 1, duration: p.duration ?? 4,
        auraRadius: p.radius ?? 70,       // ← 通用字段：带半径的 DOT（见 BuffSystem）
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `灼烧：半径 ${p.radius ?? 70} 内每秒真实伤害`,
      }, 'dragonsoul_magma', { casterId: attackerId });
      ctx.effectRegistry.apply(targetId, {
        name: '灼烧', icon: '🌋', kind: 'stat', color: '#d35400', type: 'debuff',
        statKey: 'moveSpeed', percentValue: -(p.slowPct ?? 20),
        duration: p.duration ?? 4,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `灼烧：减速 ${p.slowPct ?? 20}%`,
      }, 'dragonsoul_magma_slow', { casterId: attackerId });
    },
  },

  // ==================== 🌌 星魂：命中后分裂 ====================
  // 用户定稿："分裂子弹不触发任何技能/被动等，但是攻击特效%/攻击特效固定以 55% 的效率工作。"
  // 不这么限的话，毒魂/暗魂/蚀魂的叠层速度会因为"一发变三发"直接翻三倍。
  dragonsoul_astral: {
    id: 'dragonsoul_astral', name: '星魂', icon: '🌌', color: '#7c6cf5', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('astral');
      return `命中后分裂出 ${p.splits ?? 2} 枚星弹，飞向 ${p.radius ?? 260} 内最近的其他敌人，`
        + `各造成 ${p.damagePct ?? 40}% 伤害。分裂弹不触发任何技能与被动，`
        + `攻击特效按 ${p.onHitEffPct ?? 55}% 效率结算。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('astral');
      const atk = ctx.entityContainer.get(attackerId);
      const origin = ctx.entityContainer.get(targetId);
      if (!atk || !origin || !ctx.combat) return;
      const base = (ctx.totalRaw || 0) * ((p.damagePct ?? 40) / 100);
      if (base <= 0) return;
      // v51.6 修复：星魂的主题就是"射程+弹速"（见上面的 CONFIG.dragonSouls.stat.astral
      // 头注），但分裂出来的星弹速度原来是硬编码 520，跟攻击者自己的 bulletSpeed
      // 完全脱钩——一座叠满星魂+星力的塔自身普攻弹速能到 560（400 基础 +80 魂 +80
      // 满层力），自己的招牌分裂弹反而比普攻还慢，正是用户报的"星龙的子弹速度特别慢"。
      // 现在改成分裂弹速度＝攻击者当前弹速（与主武器完全同步），不再是一个和弹速
      // 属性无关的写死数字。
      const atkStats = ctx.attrCalc.calc(atk, ctx.effectRegistry.getEffects(atk.id));
      ctx.combat.splitShot(atk, origin, base, ctx.attackType || 'physical', {
        splits: p.splits ?? 2,
        radius: p.radius ?? 260,
        onHitEffPct: p.onHitEffPct ?? 55,
        speed: atkStats.bulletSpeed,
      });
    },
  },

  // ==================== ☄️ 蚀魂：把减伤削成负数 ====================
  // 与暗魂的区别要说清楚：暗魂削的是**双抗**（只影响对应伤害类型，且被穿透规则牵制），
  // 蚀魂削的是**伤害减免**（影响一切非真伤伤害，而且能进负数 = 放大）。
  // ⚠️ 按 v50 的定稿，真伤跳过一切防御手段，所以**真伤不吃这个放大** —— 这是自洽的。
  dragonsoul_rift: {
    id: 'dragonsoul_rift', name: '蚀魂', icon: '☄️', color: '#5d6d7e', category: 'dragonsoul',
    applicableTypes: ['tower'],
    get description() {
      const p = P('rift');
      return `命中使目标伤害减免降低 ${p.perStack ?? 4}%/层（最多 ${p.maxStacks ?? 5} 层，`
        + `${p.duration ?? 6} 秒）。减免被削成负数时，目标受到的伤害会被**放大**（真实伤害除外）。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('rift');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;
      ctx.effectRegistry.apply(targetId, {
        name: '侵蚀', icon: '☄️', kind: 'stat', color: '#5d6d7e', type: 'debuff',
        statKey: 'damageReduction',
        flatValue: -(p.perStack ?? 4), perStackFlat: -(p.perStack ?? 4),
        duration: p.duration ?? 6,
        stackable: true, maxStacks: p.maxStacks ?? 5, stackPolicy: 'stack', uniquePassive: true,
        description: `侵蚀（{stacks}层，每层减免 −${p.perStack ?? 4}%）`,
      }, 'dragonsoul_rift', { casterId: attackerId });
    },
  },

  // ==================== 🐲 远古之力（限时 240s 的处决）====================
  // 用户定稿：八条龙魂全部**永久**，只有这一条限时。
  // 它是龙魂之外的独立奖励 —— 成魂后元素龙停刷、只出远古龙，**双方都能抢**。
  // 定位是落后方的翻盘工具：处决专治"最后 20% 特别难啃"，
  // 恰好克制山魂/光魂/潮魂这三条防守型龙魂。
  dragonsoul_ancient: {
    id: 'dragonsoul_ancient', name: '远古之力', icon: '🐲', color: '#e67e22', category: 'dragonsoul',
    applicableTypes: ['tower', 'dragon'],
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
    // Bug 修复：原来挂在 onHit 上。CombatSystem 里 onHit 只在 performAttack（普攻）
    // 路径触发；闪电杖/腐蚀等武器的伤害走 performAttackDirect，那条路径只触发
    // onDealtDamage，从来不碰 onHit —— 所以远古之力的斩杀对闪电杖等于完全没接上，
    // 不是"判定不准"，是这个 tick 里代码从没跑过。
    // 改成 onDealtDamage 后两条路径都能触发。procMode 用默认的 'always'（不声明）：
    // 每次伤害都直接用当次数值判定是否够斩杀线——这本来就该"这一下伤害结算完就
    // 立刻查"，不需要等攒够一次完整攻击（那是 'perAttack' 的语义，给雷魂/暗魂/
    // 毒魂那类"计次/叠层"型被动用的，见 CombatSystem._fireOnDealtDamage 的说明）。
    // 闪电杖的分帧攻击因此每跳都会各自检定一次，比等一整秒才判一次更贴近直觉。
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const p = P('ancient');
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive || !ctx.combat) return;
      const stats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id));
      const maxHP = stats.maxHP || 0;
      if (maxHP <= 0) return;
      if ((target.currentHP || 0) > maxHP * ((p.executeAtPct ?? 20) / 100)) return;
      // _noProc：处决伤害不再触发 onDealtDamage，否则会与自己递归
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
const SOUL_STAT_KEYS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison',
  // v50 新增六条
  'frost', 'steel', 'blood', 'magma', 'astral', 'rift'];

// 属性中文名。只覆盖龙魂用得到的那几项 —— 面板那份完整表在 UI 层（editor/fields.js），
// core 不该反向依赖 UI，所以这里留一份小的。多出来的键会原样显示，不会漏说。
const STAT_LABEL = {
  attackDamage: '攻击力', maxHP: '最大生命', armor: '护甲', magicResist: '魔抗',
  healShieldPowerPct: '治疗与护盾强度', healthRegen: '生命回复',
  armorPenFlat: '固定护甲穿透', magicPenFlat: '固定法术穿透',
  bonusAttackSpeedPct: '攻速', attackRange: '攻击距离',
  damageAmpPct: '伤害增幅', lifeStealPct: '全能吸血',
  onHitPercentDamage: '攻击特效%当前生命',
  // v51.4：龙魂改回纯主题方向后新用上的几个属性（此前这份表没覆盖到，
  // 缺了的话会原样显示英文键名，不算错但不好看）。
  critChance: '暴击率', spellVampPct: '法术吸血', physicalVampPct: '物理吸血',
  tenacityPct: '韧性', abilityPower: '法术强度', adaptiveForce: '适应之力',
  damageConvertPct: '伤害转化', bulletSpeed: '子弹速度',
  critDamagePct: '暴击伤害', evasionPct: '闪避率', skillAmpPct: '技能增幅',
  manaRegen: '法力回复',
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
    // 吸血类常驻属性对塔削到 vampTowerScalePct%（用户定稿，见文件头 vampForEntity 的头注）。
    if (VAMP_STAT_KEYS.has(k)) {
      const scalePct = (CONFIG.dragonSouls && CONFIG.dragonSouls.vampTowerScalePct) ?? 33;
      return `${label} +${v}${unit}（对防御塔按 ${scalePct}% 生效，即 +${towerVampScaled(v)}${unit}）`;
    }
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
    // v45：与 dragonPowerBuffs 共用 statMod（原来两处各写了一份同样的错约定）。
    // 无条件剥 Pct 后缀对 damageAmpPct / bonusAttackSpeedPct / healShieldPowerPct
    // 这类**本身就以 Pct 结尾的属性**是错的 —— 剥完不存在，被 AttributeCalculator
    // 静默丢弃。暗魂的两项常驻数值、风魂的攻速加成、潮魂的治疗强度都因此一直空转。
    const m = statMod(k, v);
    return {
      // ==================== v47：状态栏合并 ====================
      // 用户："龙魂/巨龙之力在状态栏显示的乱七八糟……龙魂还是技能+状态显示。"
      //
      // 名字原来是 `山魂·加持`，与龙魂本体的 `山魂` **不同名** ——
      // 而状态栏是**按 blueprint.name 聚合成图标**的（UIManager._updateEffectIcons），
      // 于是一条龙魂在状态栏占了两格：一格【山魂】（本体 display + 机制那几项 stat），
      // 一格【山魂·加持】（常驻属性）。玩家看到的就是同一个东西列了两遍。
      //
      // 改成与本体同名之后自动并进同一个图标，点开的详情里两部分的属性行都在
      //（showEffectGroup 按组把所有 stat 成员逐条列出），信息一条没少。
      // 用户要的"技能 + 状态"两处显示，正是现在的样子：技能栏一格、状态栏一格。
      name: def.name || el, icon: def.icon || '🐉', color: def.color, kind: 'stat',
      statKey: m.statKey,
      flatValue: m.flat, percentValue: m.percent,
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
    // 吸血类常驻属性（dark/poison/blood 各自那一项）对塔削到 vampForEntity 里定的比例；
    // 其余属性/其余单位类型原样通过（vampForEntity 对非吸血键、非塔单位是恒等函数）。
    const entity = ctx.entityContainer ? ctx.entityContainer.get(entityId) : null;
    for (const bp of soulStatBlueprints(el)) {
      const flatValue = vampForEntity(entity, bp.statKey, bp.flatValue);
      ctx.effectRegistry.apply(entityId, { ...bp, flatValue }, `soul_stat_${el}`);
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
