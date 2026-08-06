/**
 * EffectRegistry.js
 * 效果注册中心 - 管理所有效果实例（buff/debuff/dot/stun）
 * 特性：
 * - 同名+同源效果自动合并（堆叠）
 * - 支持三种堆叠策略：'refresh'（重置时间）、'stack'（增加层数）、'independent'（独立实例）
 * - 效果描述支持 {stacks} 占位符动态替换
 * - 圆形进度条所需的 remainingTime/maxDuration 数据
 */
export class EffectRegistry {
  constructor(eventBus = null) {
    this._effects = new Map();        // effectId -> EffectInstance
    this._entityEffects = new Map();  // entityId -> Set(effectId)
    this._nextId = 1000;
    this._eventBus = eventBus;
    this._clock = 0; // aura 宽限计时用的内部时钟（只在 update 里推进）
    this._clock = 0; // 光环效果的宽限期计时基准（见 aura 机制说明）
  }

  /**
   * 为实体应用效果
   * @param {number} entityId - 目标实体ID
   * @param {object} blueprint - 效果蓝图
   * @param {string|number} sourceId - 来源标识（用于堆叠分组）
   * @param {object} [options] - 额外选项
   * @param {number} [options.initialStacks=1] - 初始层数
   * @param {number} [options.duration] - 覆盖持续时间
   * @param {boolean} [options.permanent] - 覆盖永久标志
   * @param {any} [options.customData] - 附加数据
   * @returns {number} 效果实例ID
   */
  apply(entityId, blueprint, sourceId, options = {}) {
    const stackPolicy = blueprint.stackPolicy || 'refresh';
    // ==================== 光环机制（v33 Q12） ====================
    // blueprint.aura === true 的效果是"存在型"而非"倒计时型"：
    //   · 显示为常驻（remainingTime=Infinity）——没有倒计时环，根治"极短时长反复刷新"的闪烁；
    //   · 施加方按节奏反复 apply（光环 onFrame / 闪电杖 tick），每次 apply 只更新宽限期时间戳；
    //   · update() 里检查：超过宽限期（默认 0.6s）没被刷新 → 自动移除。
    //     语义 = "在光环单位附近时常驻，离开或光环单位死亡后消失"。
    const isAura = blueprint.aura === true;
    const duration = isAura ? Infinity : (options.duration ?? blueprint.duration);
    const permanent = isAura ? true : (options.permanent ?? blueprint.permanent ?? false);
    // 合并键：优先使用显式 stackKey；否则对 stat 类效果按 name+statKey 区分，
    // 避免同一来源、同一效果名下的不同属性（如护甲+魔抗）互相顶替。
    const stackKey = blueprint.stackKey || (blueprint.statKey ? `${blueprint.name}::${blueprint.statKey}` : blueprint.name);

    let existing = null;
    // 唯一被动（uniquePassive）：同一 stackKey 在实体上全局只保留一个实例，
    // 忽略 sourceId —— 多个来源施加只刷新同一个（如镀层破裂、蚀骨腐蚀、多塔同名debuff）。
    const isUnique = blueprint.uniquePassive === true;
    if (stackPolicy !== 'independent') {
      const entityEffects = this._entityEffects.get(entityId);
      if (entityEffects) {
        for (const effId of entityEffects) {
          const eff = this._effects.get(effId);
          if (!eff) continue;
          const effKey = eff.blueprint.stackKey || (eff.blueprint.statKey ? `${eff.blueprint.name}::${eff.blueprint.statKey}` : eff.blueprint.name);
          const sourceMatch = isUnique ? true : (eff.sourceId === sourceId);
          if (effKey === stackKey && sourceMatch && eff.remainingTime > 0) {
            existing = eff;
            break;
          }
        }
      }
    }

    // 如果找到已存在的实例，根据策略更新
    if (existing) {
      if (stackPolicy === 'refresh') {
        // 刷新：重置层数，刷新时间，并更新数值字段（条件持续效果每帧变化的数值）
        existing._auraStamp = this._clock;
        const initStacks = options.initialStacks ?? 1;
        existing.stacks = Math.min(initStacks, blueprint.maxStacks || 1);
        existing.remainingTime = permanent ? Infinity : duration;
        // 同步可能变化的数值与标记
        existing.blueprint.flatValue = blueprint.flatValue;
        existing.blueprint.percentValue = blueprint.percentValue;
        existing.blueprint.permanent = blueprint.permanent;
        existing.blueprint.conditional = blueprint.conditional;
        existing.permanent = permanent;
        this._recalcEffectValues(existing);
        this._updateDescription(existing);
        return existing.id;
      } else if (stackPolicy === 'stack') {
        // 堆叠：增加层数，不超过maxStacks，刷新时间
        existing._auraStamp = this._clock;
        const maxStacks = blueprint.maxStacks || 1;
        existing.stacks = Math.min(existing.stacks + 1, maxStacks);
        existing.remainingTime = permanent ? Infinity : duration;
        this._recalcEffectValues(existing);
        this._updateDescription(existing);
        return existing.id;
      }
      // 理论上不会走到这里
    }

    // ---------- 创建新实例 ----------
    const id = this._nextId++;
    const initStacks = options.initialStacks ?? 1;
    const instance = {
      id,
      entityId,
      blueprint: { ...blueprint },
      sourceId,
      stacks: Math.min(initStacks, blueprint.maxStacks || 1),
      remainingTime: permanent ? Infinity : duration,
      maxDuration: permanent ? Infinity : duration,
      totalFlat: 0,
      totalPercent: 0,
      customData: options.customData ?? null,
      _createdAt: Date.now(),
      _auraStamp: this._clock,
    };
    this._recalcEffectValues(instance);
    this._updateDescription(instance);

    // 存储
    this._effects.set(id, instance);
    if (!this._entityEffects.has(entityId)) {
      this._entityEffects.set(entityId, new Set());
    }
    this._entityEffects.get(entityId).add(id);

    // 触发事件
    if (this._eventBus) {
      this._eventBus.emit('effect:applied', {
        entityId,
        effectId: id,
        blueprint: blueprint,
        instance: instance,
      });
    }

    return id;
  }

  /**
   * 移除效果实例
   */
  remove(effectId) {
    const eff = this._effects.get(effectId);
    if (!eff) return false;
    const entityId = eff.entityId;

    this._effects.delete(effectId);
    const set = this._entityEffects.get(entityId);
    if (set) {
      set.delete(effectId);
      if (set.size === 0) {
        this._entityEffects.delete(entityId);
      }
    }

    if (this._eventBus) {
      this._eventBus.emit('effect:expired', {
        entityId,
        effectId,
        blueprint: eff.blueprint,
        instance: eff,
      });
    }
    return true;
  }

  /**
   * 获取实体的所有效果实例
   */
  getEffects(entityId) {
    const ids = this._entityEffects.get(entityId);
    if (!ids) return [];
    const result = [];
    for (const id of ids) {
      const eff = this._effects.get(id);
      if (eff) result.push(eff);
    }
    return result;
  }

  /**
   * 获取实体的效果，按名称过滤（合并效果返回第一个）
   */
  getEffectByName(entityId, name) {
    const ids = this._entityEffects.get(entityId);
    if (!ids) return null;
    for (const id of ids) {
      const eff = this._effects.get(id);
      if (eff && eff.blueprint.name === name) return eff;
    }
    return null;
  }

  /**
   * 获取效果实例
   */
  getEffect(effectId) {
    return this._effects.get(effectId) || null;
  }

  /**
   * 判断实体当前是否处于眩晕状态（存在任意 kind:'stun' 且未过期的效果）
   */
  isStunned(entityId) {
    const ids = this._entityEffects.get(entityId);
    if (!ids) return false;
    for (const id of ids) {
      const eff = this._effects.get(id);
      if (eff && eff.blueprint.kind === 'stun' && eff.remainingTime > 0) return true;
    }
    return false;
  }

  /**
   * 每帧更新，减少剩余时间，移除过期效果，触发 onTick 回调
   */
  update(dt) {
    this._clock += dt;
    const expired = new Set(); // Set：同帧大量效果过期（光环churn）时 includes 是 O(n²)
    for (const [id, eff] of this._effects) {
      // 光环效果：宽限期内没被刷新（离开范围 / 光环源死亡 / 停止照射）→ 移除
      if (eff.blueprint.aura) {
        const grace = eff.blueprint.auraGrace ?? 0.6;
        if (this._clock - eff._auraStamp > grace) expired.add(id);
        continue;
      }
      if (eff.blueprint.permanent) continue;
      eff.remainingTime -= dt;
      // 触发 onTick（如果定义）
      if (eff.blueprint.onTick && eff.remainingTime > 0 && !expired.has(id)) {
        try {
          eff.blueprint.onTick(eff.entityId, eff, dt);
        } catch (e) {
          console.error(`EffectRegistry: onTick error for effect ${id}:`, e);
        }
      }
      if (eff.remainingTime <= 0) {
        expired.add(id);
      }
    }

    // 批量移除过期效果
    for (const id of expired) {
      const eff = this._effects.get(id);
      if (eff && eff.blueprint.onExpire) {
        try {
          eff.blueprint.onExpire(eff.entityId, eff);
        } catch (e) {
          console.error(`EffectRegistry: onExpire error for effect ${id}:`, e);
        }
      }
      this.remove(id);
    }
  }

  /**
   * 清空实体的所有效果
   */
  clear(entityId) {
    const ids = this._entityEffects.get(entityId);
    if (!ids) return;
    const copy = Array.from(ids);
    for (const id of copy) {
      this.remove(id);
    }
  }

  /**
   * 重新计算效果的总修正值
   */
  _recalcEffectValues(effect) {
    const bp = effect.blueprint;
    const stacks = effect.stacks;
    effect.totalFlat = (bp.flatValue || 0) + (bp.perStackFlat || 0) * (stacks - 1);
    effect.totalPercent = (bp.percentValue || 0) + (bp.perStackPercent || 0) * (stacks - 1);
  }

  /**
   * 更新效果描述（替换 {stacks} 占位符）
   * 保留原始模板，每次基于模板重新生成，避免占位符被首次替换后永久丢失。
   */
  _updateDescription(effect) {
    const bp = effect.blueprint;
    if (bp.description == null) return;
    if (bp._descTemplate === undefined) bp._descTemplate = bp.description;
    effect.displayDescription = bp._descTemplate.replace(/{stacks}/g, effect.stacks);
    bp.description = effect.displayDescription;
  }

  /**
   * 构建一个效果实例（用于状态添加弹窗）
   * @param {string} typeKey - 效果类型 ('burn', 'stun', 'stat_buff', etc.)
   * @param {object} params - 参数
   * @param {number} sourceId - 来源ID
   * @returns {object|null} 效果实例对象
   */
  static buildStatusEffectInstance(typeKey, params, sourceId = 0) {
    const STATUS_EFFECT_TYPES = {
      burn: {
        key: 'burn', label: '灼烧', icon: '🔥', color: '#e74c3c', kind: 'dot',
        defaultParams: { percentPerSecond: 1, duration: 5 },
      },
      stun: {
        key: 'stun', label: '晕眩', icon: '💫', color: '#f1c40f', kind: 'stun',
        defaultParams: { duration: 2 },
      },
      stat_buff: {
        key: 'stat_buff', label: '属性提升/降低', icon: '📈', color: '#5b9bd5', kind: 'stat',
        defaultParams: { statKey: 'bonusAttackSpeedPct', flatValue: 0, percentValue: 0, duration: 5 },
      },
    };

    const def = STATUS_EFFECT_TYPES[typeKey];
    if (!def) return null;
    const p = { ...def.defaultParams, ...params };
    const duration = p.duration === Infinity ? Infinity : (parseFloat(p.duration) || 0);

    return {
      name: def.label,
      icon: def.icon,
      color: def.color,
      kind: def.kind,
      statKey: p.statKey,
      percentPerSecond: p.percentPerSecond,
      percentValue: p.percentValue ?? 0,
      flatValue: p.flatValue ?? 0,
      value: p.percentValue ?? p.percentPerSecond,
      duration: duration,
      maxDuration: duration,
      permanent: duration === Infinity,
      description: `${def.label}: ${p.percentValue || p.flatValue ? `修正 ${p.statKey || ''}` : ''}`,
      sourceId: sourceId,
      stackable: false,
      currentStacks: 0,
      maxStacks: 0,
      perStackValue: 0,
      modType: 'percent',
    };
  }

}