import { applyHeal, healPowerFor } from '../healing.js';

export const dragonSouls = {
  dragonsoul_fire: {
    id: 'dragonsoul_fire', name: '炎魂', icon: '🔥', color: '#e74c3c', category: 'dragonsoul',
    description: '伤害连锁：命中时向附近3个敌人弹射40%伤害。',
    descTemplate: '唯一被动——炎魂：命中时向附近3个敌人弹射（【{val}】=40%伤害）。',
    computeCurrent: (entity, ctx) => '40%',
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      if (!target || !ctx.combat) return;
      const bounces = 3 + (instance.state?.ancientBonus || 0);
      ctx.combat.connectChain(attackerId, target, (ctx.totalRaw || 0) * 0.4, ctx.attackType || 'physical', bounces, 180, '#e74c3c');
    },
  },
  dragonsoul_water: {
    id: 'dragonsoul_water', name: '潮魂', icon: '🌊', color: '#3498db', category: 'dragonsoul',
    description: '攻击附带12%当前生命真实伤害，并获得8%生命偷取。',
    descTemplate: '唯一被动——潮魂：攻击附带12%当前生命真实伤害，并获得8%生命偷取。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) e.baseStats.lifeStealPct = (e.baseStats.lifeStealPct || 0) + 8;
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) e.baseStats.lifeStealPct = Math.max(0, (e.baseStats.lifeStealPct || 0) - 8);
    },
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive || !ctx.combat) return;
      const dmg = target.currentHP * 0.12 * (1 + (instance.state?.ancientBonus || 0) * 0.5);
      ctx.combat.performAttackDirect(attackerId, targetId, dmg, 'magic', { ignoreDefenseRatio: 1 });
    },
  },
  dragonsoul_earth: {
    id: 'dragonsoul_earth', name: '山魂', icon: '🗿', color: '#95a5a6', category: 'dragonsoul',
    description: '获得20%最大生命的永久护盾（破碎后10秒重生）+30%减伤。',
    descTemplate: '唯一被动——山魂：获得（【{val}】=20%最大生命）永久护盾（破碎10秒重生）+30%减伤。',
    computeCurrent: (entity, ctx) => { const s = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id)); return Math.round((s.maxHP||0)*0.2); },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.shieldTimer = 0;
      instance.state.soulShield = 0; // 独立护盾值，不写入 baseStats
    },
    onUnequip: (entityId, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      // 卸载时扣除本龙魂提供的护盾，不残留
      if (entity && instance.state) {
        entity.shieldFixedCurrent = Math.max(0, (entity.shieldFixedCurrent || 0) - (instance.state.soulShield || 0));
        instance.state.soulShield = 0;
      }
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const st = instance.state || (instance.state = { shieldTimer: 0, soulShield: 0 });
      const maxHP = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entityId)).maxHP || 1;
      // 治疗与护盾强度作用在护盾量上（统一口径，见 core/healing.js）
      const shieldAmt = Math.round(maxHP * 0.2 * (1 + (st.ancientBonus || 0) * 0.5)
                                   * healPowerFor(entity, ctx));

      // 减伤（唯一被动）
      ctx.effectRegistry.apply(entityId, {
        name: '山魂庇护', icon: '🗿', kind: 'stat', statKey: 'damageReduction',
        flatValue: 30, duration: 1, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: '唯一被动——山魂庇护：减伤+30%。', description: '减伤+30%',
      }, 'dragonsoul_earth_dr');

      // 独立护盾：破碎后 10 秒重生，直接补到实体护盾上，并记录本龙魂贡献量
      if ((entity.shieldFixedCurrent || 0) <= 0) {
        st.shieldTimer = (st.shieldTimer || 0) + dt;
        if (st.shieldTimer >= 10) {
          entity.shieldFixedCurrent = shieldAmt;
          st.soulShield = shieldAmt;
          st.shieldTimer = 0;
        }
      }
    },
  },
  dragonsoul_thunder: {
    id: 'dragonsoul_thunder', name: '雷魂', icon: '⚡', color: '#f1c40f', category: 'dragonsoul',
    description: '命中触发范围闪电，对目标周围造成60%攻击力魔法伤害（连锁2次）。',
    descTemplate: '唯一被动——雷魂：命中触发范围闪电，对目标周围造成60%攻击力魔法伤害（连锁2次）。',
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!target || !attacker || !ctx.combat) return;
      const atkDmg = ctx.attrCalc.calc(attacker, ctx.effectRegistry.getEffects(attackerId)).attackDamage || 0;
      const bounces = 2 + (instance.state?.ancientBonus || 0);
      ctx.combat.connectChain(attackerId, target, atkDmg * 0.6, 'magic', bounces, 160, '#f1c40f');
    },
  },
  dragonsoul_wind: {
    id: 'dragonsoul_wind', name: '风魂', icon: '🌪', color: '#1abc9c', category: 'dragonsoul',
    description: '攻速+30%，攻击必定额外触发一次50%伤害追击。',
    descTemplate: '唯一被动——风魂：攻速+30%，攻击必定额外触发一次50%伤害追击。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) e.baseStats.bonusAttackSpeedPct = (e.baseStats.bonusAttackSpeedPct || 0) + 30;
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) e.baseStats.bonusAttackSpeedPct = Math.max(0, (e.baseStats.bonusAttackSpeedPct || 0) - 30);
    },
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      if (!ctx.combat) return;
      const mult = 0.5 * (1 + (instance.state?.ancientBonus || 0) * 0.5);
      ctx.combat.performAttackDirect(attackerId, targetId, (ctx.totalRaw || 0) * mult, ctx.attackType || 'physical');
    },
  },
  dragonsoul_dark: {
    id: 'dragonsoul_dark', name: '暗魂', icon: '🌑', color: '#8e44ad', category: 'dragonsoul',
    description: '处决：对生命低于20%的目标造成双倍伤害。',
    descTemplate: '唯一被动——暗魂：对生命低于20%的目标造成双倍伤害。',
    effects: [],
    onBeforeAttack: (attacker, target, instance, ctx) => {
      const maxHP = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id)).maxHP || 1;
      if (target.currentHP / maxHP < 0.2) {
        const mult = 2 + (instance.state?.ancientBonus || 0);
        return { preDamageMult: mult };
      }
      return null;
    },
  },
  dragonsoul_light: {
    id: 'dragonsoul_light', name: '光魂', icon: '☀️', color: '#f39c12', category: 'dragonsoul',
    description: '每5秒净化并回复15%生命，治疗光环恢复周围友方塔。',
    descTemplate: '唯一被动——光魂：每5秒净化并回复15%生命，治疗光环恢复周围友方塔。',
    effects: [],
    onEquip: (entityId, instance, ctx) => { instance.state = instance.state || {}; instance.state.timer = 0; },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state || (instance.state = { timer: 0 });
      state.timer += dt;
      if (state.timer >= 5) {
        state.timer -= 5;
        const healPct = 0.15 * (1 + (instance.state?.ancientBonus || 0) * 0.5);
        const towers = ctx.entityContainer.getByType('tower', true);
        for (const t of towers) {
          const maxHP = ctx.attrCalc.calc(t, ctx.effectRegistry.getEffects(t.id)).maxHP || 1;
          // 强度取【被治疗方】的（见 core/healing.js 头注），所以重伤能压住水龙魂的回复
          applyHeal(t, maxHP * healPct, healPowerFor(t, ctx), maxHP);
        }
      }
    },
  },
  dragonsoul_poison: {
    id: 'dragonsoul_poison', name: '毒魂', icon: '☠️', color: '#27ae60', category: 'dragonsoul',
    description: '攻击附带高额中毒，中毒目标受到的伤害提升15%。',
    descTemplate: '唯一被动——毒魂：攻击附带高额中毒，中毒目标受到伤害+15%。',
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!target || !attacker) return;
      const atkDmg = ctx.attrCalc.calc(attacker, ctx.effectRegistry.getEffects(attackerId)).attackDamage || 0;
      const scale = 1 + (instance.state?.ancientBonus || 0) * 0.5;
      ctx.effectRegistry.apply(targetId, {
        name: '龙魂剧毒', icon: '☠️', kind: 'dot', color: '#27ae60', type: 'debuff',
        damageType: 'magic', flatValue: atkDmg * 0.15 * scale, perStackFlat: atkDmg * 0.1 * scale,
        tickInterval: 1, duration: 4, stackable: true, maxStacks: 10, stackPolicy: 'stack',
        description: '龙魂剧毒（{stacks}层）',
      }, `dragonsoul_poison_${attackerId}`);
      ctx.effectRegistry.apply(targetId, {
        name: '毒伤易伤', icon: '☠️', kind: 'stat', statKey: 'damageReduction', type: 'debuff',
        flatValue: -15, duration: 4, stackPolicy: 'refresh', description: '受到伤害+15%',
      }, `dragonsoul_poison_vuln_${attackerId}`);
    },
  },
};
