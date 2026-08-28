/**
 * AttributeCalculator.js
 * 纯函数，计算实体的最终属性。
 * 支持护甲穿透和魔法穿透分别计算
 * 帧级缓存：同一帧内、同一实体、同样的效果集合与选项，直接复用上次结果。
 */
// 条件型战斗属性白名单：基值恒为 0、只由效果提供，由 CombatSystem 在结算处按条件读取。
// 哀兵（LaneAvengerSystem）：avengerVsMinionAmpPct = 对敌方小兵伤害%，avengerVsMinionRedPct = 减免敌方小兵伤害%。
const CONDITIONAL_ZERO_BASE = new Set(['avengerVsMinionAmpPct', 'avengerVsMinionRedPct']);

export const AttributeCalculator = {
  _cache: new WeakMap(),   // entity -> { frame, key, stats }
  _frame: 0,

  // 每帧开始时由主循环调用，使旧缓存失效
  tick() { this._frame++; },

  _weatherKey() {
    if (!this._weather || !this._weather.enabled) return 'w0';
    const w = this._weather.getWeights();
    let k = 'w';
    for (const id of Object.keys(w).sort()) k += Math.round(w[id] * 100) + ',';
    return k;
  },

  _effectsKey(effects) {
    // 用效果 id + 层数生成签名，效果集合或层数变化即失效
    let k = '';
    for (const e of effects) k += e.id + ':' + e.stacks + ';';
    return k;
  },

  /**
   * 计算实体的最终属性
   */
  /**
   * 注入天气系统（可选依赖）。天气是【全局连续场】，不走 EffectRegistry：
   * 每帧给每个单位 apply 效果是几百上千次调用，且短时效果反复刷新会让进度环闪烁
   * （塔成长那批踩过的坑）。这里做成属性合成时的一个 O(1) 修正层。
   */
  setWeatherSystem(ws) { this._weather = ws; },
  /** P3：世界状态聚合层（昼夜/熵/龙魂）。未注入时整段短路，行为与接入前一致。 */
  setWorldState(ws) { this._world = ws; },

  calc(entity, effects, options = { includeAllStats: true }) {
    const incAll = options.includeAllStats !== false;
    // 天气版本号参与缓存键：天气权重每帧在变，属性缓存必须随之失效，
    // 否则天气变了而单位属性纹丝不动。用"权重量化到 1%"作为版本，
    // 避免浮点抖动导致缓存永不命中（1% 的精度对 buff 强度足够）。
    const wKey = this._weatherKey();
    // 世界状态也要进缓存键：昼夜昼→夜切换会改变阵营加成，不入键的话属性会停在旧值。
    const sKey = this._world && this._world.enabled
      ? (this._world.daynight.isNight ? 'n' : 'd') + ((this._world.entropy.value * 20) | 0) : 's0';
    const cacheKey = (incAll ? '1|' : '0|') + wKey + '|' + sKey + '|' + this._effectsKey(effects);
    const cached = this._cache.get(entity);
    if (cached && cached.frame === this._frame && cached.key === cacheKey) {
      return cached.stats;
    }
    const stats = this._compute(entity, effects, incAll);
    this._cache.set(entity, { frame: this._frame, key: cacheKey, stats });
    return stats;
  },

  _compute(entity, effects, includeAllStats) {
    const stats = { ...entity.baseStats };
    const modMap = new Map();

    for (const eff of effects) {
      if (eff.blueprint.kind !== 'stat') continue;
      const key = eff.blueprint.statKey;
      if (!key) continue;
      if (!modMap.has(key)) modMap.set(key, { flat: 0, percent: 0 });
      const mod = modMap.get(key);
      mod.flat += eff.totalFlat || 0;
      mod.percent += eff.totalPercent || 0;
    }

    let allStatsPctMod = 0;
    if (modMap.has('allStatsPct')) {
      const mod = modMap.get('allStatsPct');
      allStatsPctMod = mod.flat + mod.percent;
      modMap.delete('allStatsPct');
    }

    // ==================== 天气修正层（全局连续场） ====================
    // 强度 = 各天气的实时占比；多天气并存时相加。合并进 modMap 后与技能效果
    // 走同一条合成管线（先 flat 后 percent），保证叠加语义一致。
    let weatherDrain = 0; // v35（Q5）：天气负生命恢复的独立通道
    if (this._weather && this._weather.enabled) {
      const wMods = this._weather.getModifiers(entity);
      if (wMods) {
        for (const [key, m] of Object.entries(wMods)) {
          // v35（Q5 定稿）：天气的【负】生命恢复 = 字面扣血，不进 stat 合成管线——
          // 管线里 flat 会被 percent 修正缩放（恢复加成会"减轻"环境扣血、
          // 治疗强化会"放大"它），用户明确要求负值不受任何形式的加成。
          // 摘出为 _weatherDrain（已含天气档位强度缩放，那是天气自身强度非外部加成），
          // 由 CombatSystem 每秒原值扣血。正恢复照常走管线。
          if (key === 'healthRegen' && (m.flat || 0) < 0) {
            weatherDrain += -m.flat;
            if (!m.percent) continue;
            const cur0 = modMap.get(key) || { flat: 0, percent: 0 };
            cur0.percent += m.percent || 0;
            modMap.set(key, cur0);
            continue;
          }
          const cur = modMap.get(key) || { flat: 0, percent: 0 };
          cur.flat += m.flat || 0;
          cur.percent += m.percent || 0;
          modMap.set(key, cur);
        }
      }
    }

    // P3：世界状态（昼夜阵营非对称 / 熵）。天气【不走这里】——它已有成熟通道（上面那段
    // 含负恢复的独立处理），搬过来只会平添回归风险。本层只负责天气之外的三项。
    // CONFIG.world.couplings 默认全关，全关时这段等价于不存在。
    if (this._world && this._world.enabled) {
      const wsMods = this._world.getModifiers(entity);
      for (const [key, m] of Object.entries(wsMods || {})) {
        const cur = modMap.get(key) || { flat: 0, percent: 0 };
        cur.flat += m.flat || 0;
        cur.percent += m.pct || 0;
        modMap.set(key, cur);
      }
    }

    for (const [key, mod] of modMap) {
      // 条件型战斗属性（不写进任何 baseStats，基值视为 0）：这类属性只在结算处按
      // 攻击来源/目标类型生效（如哀兵的"对敌方小兵"加成），模板里没有对应字段。
      // 只对白名单内的键开这个口子，其余键维持"baseStats 没有就丢弃"的原行为 → 零回归风险。
      if (stats[key] === undefined) {
        if (!CONDITIONAL_ZERO_BASE.has(key)) continue;
        stats[key] = 0;
      }
      let value = stats[key];
      value += mod.flat;
      value *= (1 + mod.percent / 100);
      stats[key] = value;
    }

    if (includeAllStats && allStatsPctMod !== 0) {
      // 全属性加成不应作用于"百分比上限型"属性（减伤、伤害转化、生命偷取等），
      // 否则会把已经封顶的属性二次放大、突破设计上限。这类属性只吃自身的加成。
      const allStatsExclude = new Set([
        'allStatsPct', 'damageReduction', 'lifeStealPct', 'damageConvertPct',
        'armorPenPercent', 'magicPenPercent', 'attackType',
      ]);
      const keysToApply = Object.keys(stats).filter(k => !allStatsExclude.has(k));
      for (const key of keysToApply) {
        if (typeof stats[key] === 'number') {
          stats[key] *= (1 + allStatsPctMod / 100);
        }
      }
    }

    // 减伤硬性封顶 90%，避免任何来源叠加导致免疫
    if (stats.damageReduction !== undefined && stats.damageReduction > 90) stats.damageReduction = 90;

    // 确保非负
    if (stats.maxHP !== undefined && stats.maxHP < 0) stats.maxHP = 0;
    if (stats.attackDamage !== undefined && stats.attackDamage < 0) stats.attackDamage = 0;

    stats._weatherDrain = weatherDrain; // v35 Q5：天气负恢复独立通道
    return stats;
  },

  /**
   * 计算护盾吸收系数（根据双抗修正）
   */
  calcShieldAbsorbFactor(armor, magicResist) {
    const avg = (armor + magicResist) / 2;
    if (avg > 0) {
      return 1 + (avg / 100) * 0.2;
    } else if (avg < 0) {
      return 1 + (avg / 100) * 2;
    }
    return 1;
  },

  /**
   * 计算最终攻击速度
   * 规则：正值攻速加成受"攻速收益率"影响；负值攻速修正不受收益率影响，直接按原值生效。
   */
  /**
   * 由【已算好的属性表】取实际攻速。
   *
   * ==================== v43 Q7：战斗侧必须走这里 ====================
   * 用户："我设置塔全属性加成，面板上攻速加成了但是实际上子弹并没有加成。"
   * 根因：面板（UIManager）读的是 `stats.baseAttackSpeed` —— 吃过 allStatsPct 与
   * 一切 statKey='baseAttackSpeed' 的效果；而**所有**战斗节奏点读的都是
   * `entity.baseStats.baseAttackSpeed`，那是**原始模板值**，任何加成都进不去。
   * 于是"全属性加成"对射速的作用只存在于面板上。
   *
   * 顺带说明为什么 allStatsPct 对攻速的唯一通路就是 baseAttackSpeed：
   * 它虽然也乘 bonusAttackSpeedPct，但塔模板里那个值是 **0**，0×1.5 还是 0。
   * 真正被放大的是 baseAttackSpeed —— 也就是这条被战斗侧绕开的路。
   *
   * 新增行为都必须调这个函数，别再从 entity.baseStats 直接取攻速字段。
   */
  calcAttackSpeedOf(stats, cap = 5.0) {
    return this.calcAttackSpeed(
      stats.baseAttackSpeed, stats.bonusAttackSpeedPct || 0, stats.attackSpeedRatio || 0.667, cap);
  },

  calcAttackSpeed(baseAttackSpeed, bonusAttackSpeedPct, attackSpeedRatio, cap = 5.0) {
    const positive = Math.max(0, bonusAttackSpeedPct);
    const negative = Math.min(0, bonusAttackSpeedPct);
    const effectiveBonusPct = positive * attackSpeedRatio + negative; // 负值不乘收益率
    const raw = baseAttackSpeed * (1 + effectiveBonusPct / 100);
    // ==================== v49：下限 0.05 → 0 ====================
    // 用户："这个攻速最低只显示 0.05，要显示正确的（最低显示 0.01）。
    //        如果攻速为 0 的话就显示 0。"
    //
    // 只改显示是不行的：面板写 0.01、实际按 0.05 打，正是本仓库反复出现的
    // "面板与实际不一致"。而且"攻速为 0 就显示 0"这句只有在 0 真的能达到时才成立 ——
    // 所以下限本身要降到 0，把这个状态**变成可达的**。
    //
    // ⚠️ 攻速 0 = 永不攻击。三处算冷却的地方原来写的是 `1 / (finalAS || 0.5)`，
    // 那个 `|| 0.5` 是给 undefined 兜底的，**会把 0 当成假值吃掉** ——
    // 下限一降，攻速 0 的单位不是停手而是每 2 秒打一下，行为正好相反。
    // 所以那三处统一改走 attackIntervalOf()（见下），别再各写各的。
    return Math.max(0, Math.min(raw, cap));
  },

  /**
   * 攻速 → 攻击间隔（秒）。攻速 ≤ 0 时返回 Infinity = 永不攻击。
   *
   * 抽出来的唯一理由：`1 / (finalAS || 0.5)` 这一句原样抄在三处
   *（CombatSystem 的塔与小兵两条、LaneMovementSystem 一条）。
   * 下限降到 0 之后那个 `|| 0.5` 从"无害兜底"变成"把停手改成每 2 秒一下"的 bug，
   * 三处都得改 —— 抄三遍的东西改三遍必然漏一处，所以合成一份。
   */
  attackIntervalOf(attackSpeed) {
    return (Number.isFinite(attackSpeed) && attackSpeed > 0) ? 1 / attackSpeed : Infinity;
  },

  /**
   * 计算有效抗性（支持百分比穿透和固定穿透）
   *
   * ⚠️ 负抗性【本身就是增伤】——下面 calcDamageMultiplier 专门写了 resist<0 的分支
   *（2 − 100/(100−resist)，抗性 −50 时受到 1.33 倍伤害）。
   * 但改动前这里无条件 `Math.max(0, effective)`，把负抗性一律夹成 0，
   * **那条增伤分支于是成了死代码**：双抗调成负数在游戏里完全没有效果。
   * 排查缘由：用户问"如果单位防御已经为负，无视防御别把增伤减免没了" ——
   * 顺着查发现负抗性根本就没生效过。
   *
   * 现在的规则（与 LoL 一致）：
   *   · 原始抗性为负 → 原样传下去（增伤生效）。穿透不再往下打——已经是负的了，
   *     再穿只会让"穿透"变成无上限的增伤放大器。
   *   · 原始抗性为正 → 照旧穿透，并夹到 0：穿透**不能**把正抗性打成负数变增伤。
   * @param {number} resist - 原始抗性（护甲或魔抗）
   * @param {number} penPercent - 百分比穿透（如 30 表示 30%）
   * @param {number} penFlat - 固定穿透
   * @returns {number} 有效抗性（正抗性夹到 ≥0；负抗性原样返回）
   */
  calcEffectiveArmor(resist, penPercent, penFlat) {
    if (resist < 0) return resist;
    return Math.max(0, resist * (1 - penPercent / 100) - penFlat);
  },

  /**
   * 计算伤害乘数（基于抗性）
   */
  calcDamageMultiplier(resist) {
    if (resist >= 0) {
      return 100 / (100 + resist);
    } else {
      return 2 - 100 / (100 - resist);
    }
  }
};