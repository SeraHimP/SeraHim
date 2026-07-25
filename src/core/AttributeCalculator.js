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

  calc(entity, effects, options = { includeAllStats: true }) {
    const incAll = options.includeAllStats !== false;
    // 天气版本号参与缓存键：天气权重每帧在变，属性缓存必须随之失效，
    // 否则天气变了而单位属性纹丝不动。用"权重量化到 1%"作为版本，
    // 避免浮点抖动导致缓存永不命中（1% 的精度对 buff 强度足够）。
    const wKey = this._weatherKey();
    const cacheKey = (incAll ? '1|' : '0|') + wKey + '|' + this._effectsKey(effects);
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
  calcAttackSpeed(baseAttackSpeed, bonusAttackSpeedPct, attackSpeedRatio, cap = 5.0) {
    const positive = Math.max(0, bonusAttackSpeedPct);
    const negative = Math.min(0, bonusAttackSpeedPct);
    const effectiveBonusPct = positive * attackSpeedRatio + negative; // 负值不乘收益率
    const raw = baseAttackSpeed * (1 + effectiveBonusPct / 100);
    return Math.max(0.05, Math.min(raw, cap));
  },

  /**
   * 计算有效抗性（支持百分比穿透和固定穿透）
   * @param {number} resist - 原始抗性（护甲或魔抗）
   * @param {number} penPercent - 百分比穿透（如 30 表示 30%）
   * @param {number} penFlat - 固定穿透
   * @returns {number} 有效抗性（最小0）
   */
  calcEffectiveArmor(resist, penPercent, penFlat) {
    let effective = resist * (1 - penPercent / 100);
    effective -= penFlat;
    return Math.max(0, effective);
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