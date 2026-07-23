/**
 * Q6：重甲联防计层口径——"正在攻击本塔"的敌人：以本塔为目标（targetId 匹配）
 * 且本塔已进入该敌人的攻击射程（即它已停下开打或下一步就开打）。
 * 路过的、在射程外追击别人的敌人不再计层。
 */
function _countTowerAttackers(entity, ctx) {
  const nearby = ctx.entityContainer.findInRadius(entity.pos.x, entity.pos.y, 260,
    ['melee', 'ranged', 'siege', 'super', 'totem', 'shield', 'warlock', 'corrupt', 'dragon'], true);
  let n = 0;
  for (const m of nearby) {
    if (m.targetId !== entity.id) continue;
    const r = (m.baseStats && m.baseStats.attackRange) || 20;
    const dx = m.pos.x - entity.pos.x, dy = m.pos.y - entity.pos.y;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

// v35（Q5）："加固城防"节点封顶——恢复只能回到当前血量所在区间的上界节点。
// 节点 [0.4,0.67,1.0]：血量 35% → 封顶 40%；55% → 67%；80% → 满血。恰好在节点上 = 停在节点。
// 实现：被动 onFrame 节流更新 entity._regenCapHP，CombatSystem 恢复结算读它。
// v36 Q1：节点封顶重算（onEquip 与 onFrame 共用；修"getDisplayValue 初始显示0"的 bug）
function _fortifyRecalc(entityId, instance, ctx, nodes) {
  const e = ctx.entityContainer.get(entityId);
  if (!e || !e.alive) return;
  const maxHP = ctx.attrCalc.calc(e, ctx.effectRegistry.getEffects(e.id)).maxHP || e.baseStats.maxHP || 1;
  const p = e.currentHP / maxHP;
  let node = nodes[nodes.length - 1];
  for (const n of nodes) { if (p <= n + 1e-6) { node = n; break; } }
  e._regenCapHP = node * maxHP;
  instance.state._capPct = Math.round(node * 100);
}

function _makeFortify({ id, name, icon, regen, shield = 0, nodes, tierLabel }) {
  const nodesTxt = nodes.map(n => Math.round(n * 100) + '%').join('/');
  // v37：regen 可为 0（外/内塔版加固城防：只有节点封顶，不提供恢复数值）
  const regenTxt = regen > 0 ? `${tierLabel}获得${regen}生命恢复${shield ? `和${shield}固定护盾` : ''}，` : `${tierLabel}拥有三个生命节点，`;
  return {
    id, name, icon,
    category: 'passive',
    description: `${regenTxt}生命恢复不超过生命值节点（${nodesTxt}）。`,
    descTemplate: `唯一被动——${name}：${regenTxt}生命恢复不超过生命值节点（【{val}】为当前封顶节点）。`,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      // 惯例：静态 stat 效果由 onEquip 手动 apply（effects 数组只是元数据，无人消费）
      if (regen > 0) ctx.effectRegistry.apply(entityId, {
        name, icon, kind: 'stat', statKey: 'healthRegen', flatValue: regen,
        duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `生命恢复+${regen}（恢复不超过生命值节点 ${nodesTxt}）`,
      }, id + '_regen');
      if (shield) {
        ctx.effectRegistry.apply(entityId, {
          name, icon, kind: 'stat', statKey: 'shieldFixedMax', flatValue: shield,
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `固定护盾+${shield}`,
        }, id + '_shield');
      }
      _fortifyRecalc(entityId, instance, ctx, nodes); // v36 Q1：装备即算初始节点（修显示 0 的 bug）
    },
    onFrame: (entityId, dt, instance, ctx) => {
      instance.state.t = (instance.state.t || 0) + dt;
      if (instance.state.t < 0.3) return;
      instance.state.t = 0;
      _fortifyRecalc(entityId, instance, ctx, nodes);
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) delete e._regenCapHP; // 卸下即解除封顶
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === name) ctx.effectRegistry.remove(eff.id);
      }
    },
    getDisplayValue: (instance) => (instance.state?._capPct ?? 100) + '%',
  };
}

export const towerPassives = {
  // ==================== v35（Q5）：建筑默认被动 ====================
  // 背景：所有塔的地图默认 固定护盾/生命恢复 清零，改由下列可卸被动提供——
  // 数值进被动而不是裸 stats，面板可见、编辑器可拆、语义可扩展。

  // 水晶枢纽/召唤水晶：+10 恢复（名字"水晶再生"为实现补充，效果按用户字面）
  passive_nexus_regen: {
    id: 'passive_nexus_regen', name: '水晶再生', icon: '💠',
    category: 'passive',
    description: '水晶枢纽/召唤水晶获得10生命恢复。',
    descTemplate: '唯一被动——水晶再生：水晶枢纽/召唤水晶获得10生命恢复。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      ctx.effectRegistry.apply(entityId, {
        name: '水晶再生', icon: '💠', kind: 'stat', statKey: 'healthRegen', flatValue: 10,
        duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: '生命恢复+10',
      }, 'passive_nexus_regen');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '水晶再生') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // v37（Q1）：外/内塔加固城防——纯节点封顶（33/67/100%），不提供恢复数值。
  // 塔本身默认 0 恢复，节点约束的是玩家外挂的恢复来源（编辑器加的恢复/光环等）。
  passive_outer_fortify: _makeFortify({
    id: 'passive_outer_fortify', name: '外塔加固城防', icon: '🏯',
    regen: 0, nodes: [0.33, 0.67, 1.0], tierLabel: '外塔',
  }),
  passive_inner_fortify: _makeFortify({
    id: 'passive_inner_fortify', name: '内塔加固城防', icon: '🏯',
    regen: 0, nodes: [0.33, 0.67, 1.0], tierLabel: '内塔',
  }),

  // 枢纽塔：+5 恢复，节点 40/70/100%
  passive_hq_fortify: _makeFortify({
    id: 'passive_hq_fortify', name: '枢纽防御塔加固城防', icon: '🏯',
    regen: 5, nodes: [0.40, 0.70, 1.0], tierLabel: '枢纽防御塔', // v37：6→5（用户定稿）
  }),

  // 水晶塔：+2 恢复 + 800 固定护盾，节点 33/67/100%
  passive_base_fortify: _makeFortify({
    id: 'passive_base_fortify', name: '水晶防御塔加固城防', icon: '🏯',
    regen: 2, nodes: [0.33, 0.67, 1.0], tierLabel: '水晶防御塔', // v37：800盾拆出为独立技能（钢铁烈阳护盾·水晶塔版）
  }),

  // v37（Q1）：水晶塔版钢铁烈阳护盾——独立技能，仅给自己 +800 固定护盾（不含光环）。
  // 从"水晶防御塔加固城防"里拆出（用户定稿：加固城防只管节点+恢复，护盾单列）。
  passive_base_bulwark: {
    id: 'passive_base_bulwark', name: '钢铁烈阳护盾', icon: '☀️',
    category: 'passive',
    description: '唯一被动——钢铁烈阳护盾：+800固定护盾。',
    descTemplate: '唯一被动——钢铁烈阳护盾：+800固定护盾（仅自身，无光环）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      ctx.effectRegistry.apply(entityId, {
        name: '钢铁烈阳护盾', icon: '☀️', kind: 'stat', statKey: 'shieldFixedMax', flatValue: 800,
        duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: '固定护盾+800',
      }, 'passive_base_bulwark');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '钢铁烈阳护盾') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // 内塔：钢铁烈阳护盾——300 范围光环，自己及友军 +50 固定护盾，离开范围脱落
  passive_inner_bulwark: {
    id: 'passive_inner_bulwark', name: '钢铁烈阳护盾', icon: '☀️',
    category: 'passive',
    description: '对自己及附近（300范围）友军提供50护盾，友军离开防御塔过远护盾消失。',
    descTemplate: '唯一被动——钢铁烈阳护盾：对自己及附近（300范围）友军提供50固定护盾，离开范围后护盾消失。',
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      instance.state.t = (instance.state.t || 0) + dt;
      if (instance.state.t < 0.3) return;
      instance.state.t = 0;
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return;
      const bp = (desc) => ({
        name: '钢铁烈阳护盾', icon: '☀️', kind: 'stat', statKey: 'shieldFixedMax', flatValue: 50,
        aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: '唯一被动——钢铁烈阳护盾：固定护盾+50（在内塔光环范围内）。', description: desc,
      });
      ctx.effectRegistry.apply(self.id, bp('固定护盾+50（自身）'), 'inner_bulwark');
      for (const ally of ctx.entityContainer.findInRadius(self.pos.x, self.pos.y, 300, null, true)) {
        if (ally.id === self.id || !ally.alive) continue;
        if ((ally._mapFaction || ally.faction) !== self._mapFaction) continue;
        ctx.effectRegistry.apply(ally.id, bp('固定护盾+50（内塔光环）'), 'inner_bulwark');
      }
    },
  },

  passive_heavy_defense: {
    id: 'passive_heavy_defense',
    name: '重甲联防',
    icon: '🤝',
    category: 'passive',
    descTemplate: '唯一被动——重甲联防：每个正在攻击本塔的敌人提供（【{val}】=+5×攻击者数）双抗，上限100。',
    computeCurrent: (entity, ctx) => {
      return Math.min(_countTowerAttackers(entity, ctx) * 5, 100);
    },
    description: '每个正在攻击本塔的敌人+5双抗，上限100（Q6：仅统计以本塔为目标且已进入其攻击射程的敌人）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state || (instance.state = { timer: 0 });
      state.timer = (state.timer || 0) + dt;
      if (state.timer < 0.2) return; // 轻量节流：每0.2秒检查一次即可，视觉上无感知差异
      state.timer = 0;

      const attackers = _countTowerAttackers(entity, ctx);
      const bonus = Math.min(attackers * 5, 100);

      if (bonus > 0) {
        const enemyCount = Math.min(attackers, 20);
        // 条件持续效果：conditional:true → 不倒计时、常驻显示；每帧刷新数值。
        // stackable:true 仅用于让右下角徽标显示"层数"（=附近敌人数），非真实叠层机制。
        const armorId = ctx.effectRegistry.apply(entityId, {
          name: '重甲联防', icon: '🤝', kind: 'stat', statKey: 'armor',
          flatValue: bonus, duration: Infinity, permanent: true, conditional: true,
          stackable: true, maxStacks: 20, stackPolicy: 'refresh', uniquePassive: true,
          descTemplate: '唯一被动——重甲联防：附近敌人提供（【{val}】=+5×敌人数）双抗，上限100。',
          description: `护甲+${bonus}`,
        }, 'passive_heavy_defense_armor');
        const armorEff = ctx.effectRegistry.getEffect(armorId);
        if (armorEff) armorEff.stacks = enemyCount;

        const mrId = ctx.effectRegistry.apply(entityId, {
          name: '重甲联防', icon: '🤝', kind: 'stat', statKey: 'magicResist',
          flatValue: bonus, duration: Infinity, permanent: true, conditional: true,
          stackable: true, maxStacks: 20, stackPolicy: 'refresh', uniquePassive: true,
          description: `魔抗+${bonus}`,
        }, 'passive_heavy_defense_mr');
        const mrEff = ctx.effectRegistry.getEffect(mrId);
        if (mrEff) mrEff.stacks = enemyCount;
      } else {
        // 条件不满足（没有敌人）→ 移除效果
        for (const src of ['passive_heavy_defense_armor', 'passive_heavy_defense_mr']) {
          const eff = ctx.effectRegistry.getEffects(entityId).find(e => e.sourceId === src);
          if (eff) ctx.effectRegistry.remove(eff.id);
        }
      }
    },
  },

  passive_thorns: {
    id: 'passive_thorns',
    name: '荆棘反击',
    icon: '⚔️',
    category: 'passive',
    descTemplate: '唯一被动——荆棘反击：被攻击时反弹（【{val}】=3+护甲×7%）魔法伤害。',
    computeCurrent: (entity, ctx) => {
      const s = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      return Math.round(3 + (s.armor || 0) * 0.07);
    },
    description: '被攻击时反弹（3+护甲×7%）魔法伤害。',
    effects: [],
    onBeingAttacked: (targetId, attackerId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!target || !attacker || !target.alive || !attacker.alive) return;
      const atkStats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id));
      const reflectDmg = 3 + (atkStats.armor || 0) * 0.07;
      if (ctx.combat) {
        ctx.combat.performAttackDirect(targetId, attackerId, reflectDmg, 'magic', { _noProc: true });
      }
    },
  },

  passive_frost_plating: {
    id: 'passive_frost_plating',
    name: '冰霜镀层',
    icon: '❄️',
    category: 'passive',
    description: '每60秒叠1层，最多18层。每层+5%攻击、+2%双抗、+1.5%生命恢复。',
    descTemplate: '唯一被动——冰霜镀层：防御塔每分钟获得额外属性（当前【{val}】层，最多18层），每层+5%攻击、+2%双抗、+1.5%生命恢复。',
    computeCurrent: (entity, ctx) => { const e = ctx.effectRegistry.getEffectByName(entity.id, '冰霜镀层'); return e ? e.stacks : 0; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.stacks = 0;
      instance.state.timer = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state;
      state.timer += dt;
      if (state.timer >= 60 && state.stacks < 18) {
        state.timer -= 60;
        state.stacks++;
        const s = state.stacks;
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'attackDamage',
          percentValue: 5,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 5,
          stackPolicy: 'stack',
          permanent: true,
          description: `攻击力+${s*5}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'armor',
          percentValue: 2,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 2,
          stackPolicy: 'stack',
          permanent: true,
          description: `护甲+${s*2}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'magicResist',
          percentValue: 2,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 2,
          stackPolicy: 'stack',
          permanent: true,
          description: `魔抗+${s*2}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'healthRegen',
          percentValue: 1.5,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 1.5,
          stackPolicy: 'stack',
          permanent: true,
          description: `生命恢复+${(s*1.5).toFixed(1)}%`,
        }, 'passive_frost_plating');
      }
    },
  },

  passive_armor_plating: {
    id: 'passive_armor_plating',
    name: '防御塔镀层',
    icon: '🛡️',
    category: 'passive',
    description: 'HP跌破80%/60%/40%/20%时破裂，永久+25双抗，并获20秒爆发（+70双抗、+100%攻速、远程减伤17%）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.broken = [false, false, false, false];
      instance.state.burstCounter = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state;
      const thresholds = [0.8, 0.6, 0.4, 0.2];
      const finalStats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      const maxHP = finalStats.maxHP;
      const hpRatio = entity.currentHP / maxHP;

      for (let i = 0; i < thresholds.length; i++) {
        if (!state.broken[i] && hpRatio <= thresholds[i]) {
          state.broken[i] = true;
          const brokenCount = state.broken.filter(Boolean).length;
          // 唯一被动：护甲/魔抗各只一个图标，层数=已破裂数（stackKey 固定 + uniquePassive）
          const armorEff = ctx.effectRegistry.apply(entityId, {
            name: '镀层破裂', icon: '🔰', kind: 'stat', statKey: 'armor',
            flatValue: 25, perStackFlat: 25, duration: Infinity, permanent: true,
            stackable: true, maxStacks: 4, stackPolicy: 'stack', uniquePassive: true,
            descTemplate: '唯一被动——镀层破裂：生命跌破阈值永久获得（【{val}】=+25×破裂数）护甲。',
            description: '永久护甲提升（{stacks}/4层）',
          }, 'passive_armor_plating_perm_armor');
          const ae = ctx.effectRegistry.getEffect(armorEff);
          if (ae) { ae.stacks = brokenCount; ctx.effectRegistry._recalcEffectValues(ae); ctx.effectRegistry._updateDescription(ae); }

          const mrEff = ctx.effectRegistry.apply(entityId, {
            name: '镀层破裂', icon: '🔰', kind: 'stat', statKey: 'magicResist',
            flatValue: 25, perStackFlat: 25, duration: Infinity, permanent: true,
            stackable: true, maxStacks: 4, stackPolicy: 'stack', uniquePassive: true,
            descTemplate: '唯一被动——镀层破裂：生命跌破阈值永久获得（【{val}】=+25×破裂数）魔抗。',
            description: '永久魔抗提升（{stacks}/4层）',
          }, 'passive_armor_plating_perm_mr');
          const me = ctx.effectRegistry.getEffect(mrEff);
          if (me) { me.stacks = brokenCount; ctx.effectRegistry._recalcEffectValues(me); ctx.effectRegistry._updateDescription(me); }
          
          const bid = state.burstCounter++;
          ctx.effectRegistry.apply(entityId, {
            name: '镀层爆发',
            icon: '💥',
            kind: 'stat',
            statKey: 'armor',
            flatValue: 70,
            duration: 20,
            stackable: true,
            maxStacks: 4,
            perStackFlat: 70,
            stackPolicy: 'stack',
            description: `护甲+70（${bid+1}/4层爆发）`,
          }, `passive_armor_plating_burst_${bid}`);
          ctx.effectRegistry.apply(entityId, {
            name: '镀层爆发',
            icon: '💥',
            kind: 'stat',
            statKey: 'magicResist',
            flatValue: 70,
            duration: 20,
            stackable: true,
            maxStacks: 4,
            perStackFlat: 70,
            stackPolicy: 'stack',
            description: `魔抗+70（${bid+1}/4层爆发）`,
          }, `passive_armor_plating_burst_${bid}`);
          ctx.effectRegistry.apply(entityId, {
            name: '镀层爆发',
            icon: '💥',
            kind: 'stat',
            statKey: 'bonusAttackSpeedPct',
            flatValue: 100,
            duration: 20,
            stackable: true,
            maxStacks: 4,
            perStackFlat: 100,
            stackPolicy: 'stack',
            description: `攻速+100%（${bid+1}/4层爆发）`,
          }, `passive_armor_plating_burst_${bid}`);
          ctx.effectRegistry.apply(entityId, {
            name: '镀层爆发',
            icon: '💥',
            kind: 'custom',
            duration: 20,
            stackable: true,
            maxStacks: 4,
            perStackFlat: 17,
            stackPolicy: 'stack',
            customData: { rangedDmgReduction: 17 },
            description: `远程伤害-17%（${bid+1}/4层爆发）`,
          }, `passive_armor_plating_burst_${bid}`);
        }
      }
    },
  },

  passive_overheat: {
    id: 'passive_overheat',
    name: '过热核心',
    icon: '💢',
    color: '#e67e22',
    category: 'passive',
    description: '连续攻击同一目标，每次+3%伤害，换目标清零，最多+30%（10层）。',
    descTemplate: '唯一被动——过热核心：连续攻击同一目标，每次获得（【{val}%】=3%×层数）伤害提升，换目标清零，最多+30%。',
    computeCurrent: (entity, ctx) => { const e = ctx.effectRegistry.getEffectByName(entity.id, '过热核心'); return (3 * (e ? e.stacks : 0)); },
    incompatibleWithSpecial: true,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.lastTargetId = null;
      instance.state.stacks = 0;
    },
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const state = instance.state || (instance.state = { lastTargetId: null, stacks: 0 });
      if (state.lastTargetId !== targetId) {
        state.lastTargetId = targetId;
        state.stacks = 0;
      }
      state.stacks = Math.min(state.stacks + 1, 10);
      ctx.effectRegistry.apply(attackerId, {
        name: '过热核心', icon: '💢', kind: 'stat', statKey: 'damageAmpPct',
        flatValue: (inst._params?.perStackDamage ?? 3), perStackFlat: (inst._params?.perStackDamage ?? 3), duration: (inst._params?.effectDuration ?? 3),
        stackable: true, maxStacks: (inst._params?.maxStacks ?? 10), stackPolicy: 'stack',
        description: '伤害提升（{stacks}/10层）',
      }, 'passive_overheat');
      // 手动同步层数（换目标时清零）
      const eff = ctx.effectRegistry.getEffectByName(attackerId, '过热核心');
      if (eff) { eff.stacks = state.stacks; }
    },
  },

  passive_vampire: {
    id: 'passive_vampire',
    name: '吸血鬼',
    icon: '🩸',
    color: '#c0392b',
    category: 'passive',
    description: '攻击回复等于8%造成伤害的生命值。',
    descTemplate: '唯一被动——吸血鬼：攻击回复等于（【{val}】=8%造成伤害）的生命值。',
    computeCurrent: (entity, ctx) => '8%',
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const attacker = ctx.entityContainer.get(attackerId);
      if (!attacker || !attacker.alive) return;
      const heal = (ctx.finalDamage || 0) * 0.08;
      if (heal > 0) {
        const maxHP = ctx.attrCalc.calc(attacker, ctx.effectRegistry.getEffects(attackerId)).maxHP || 1;
        attacker.currentHP = Math.min(maxHP, attacker.currentHP + heal);
      }
    },
  },

  passive_phase: {
    id: 'passive_phase',
    name: '相位领域',
    icon: '🌀',
    color: '#9b59b6',
    category: 'passive',
    description: '每8秒获得一层“相位”（最多3层），攻击命中消耗一层造成1.5倍额外伤害。',
    descTemplate: '唯一被动——相位领域：每8秒获得一层相位（最多3层），攻击命中消耗一层造成1.5倍额外伤害。当前（【{val}】=充能层数）。',
    computeCurrent: (entity, ctx) => { const e = ctx.effectRegistry.getEffectByName(entity.id, '相位'); return e ? e.stacks : 0; },
    incompatibleWithSpecial: true,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.timer = 0;
      instance.state.charges = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state || (instance.state = { timer: 0, charges: 0 });
      state.timer += dt;
      if (state.timer >= 8) {
        state.timer -= 8;
        state.charges = Math.min((state.charges || 0) + 1, 3);
        ctx.effectRegistry.apply(entityId, {
          name: '相位', icon: '🌀', kind: 'custom', color: '#9b59b6',
          duration: Infinity, permanent: true, stackable: true, maxStacks: 3,
          stackPolicy: 'stack', description: '相位充能（{stacks}/3）',
          customData: { charges: state.charges },
        }, 'passive_phase');
        const eff = ctx.effectRegistry.getEffectByName(entityId, '相位');
        if (eff) eff.stacks = state.charges;
      }
    },
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const state = instance.state;
      if (!state || (state.charges || 0) <= 0) return;
      state.charges -= 1;
      const eff = ctx.effectRegistry.getEffectByName(attackerId, '相位');
      if (eff) {
        eff.stacks = Math.max(0, state.charges);
        if (state.charges <= 0) ctx.effectRegistry.remove(eff.id);
      }
      // 造成 1.5 倍额外伤害
      const bonus = (ctx.totalRaw || 0) * 1.5;
      if (bonus > 0 && ctx.combat) {
        ctx.combat.performAttackDirect(attackerId, targetId, bonus, ctx.attackType || 'physical');
      }
    },
  },

  // Q9：嚎哭深渊水晶塔专属——永久版钢铁防线（30% 减伤，不过期）
  passive_iron_line_ha: {
    id: 'passive_iron_line_ha',
    name: '钢铁防线·永久',
    icon: '🛡️',
    category: 'passive',
    description: '唯一被动——钢铁防线（永久）：格挡30%即将到来的伤害，永不失效。',
    descTemplate: '唯一被动——钢铁防线（永久）：+30%伤害减免（常驻状态）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      ctx.effectRegistry.apply(entityId, {
        name: '钢铁防线', icon: '🛡️', kind: 'stat', statKey: 'damageReduction', flatValue: 30,
        duration: 0, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: '格挡30%即将到来的伤害（永久）',
      }, 'passive_iron_line_ha');
    },
  },

  passive_iron_line: {
    id: 'passive_iron_line',
    name: '钢铁防线',
    icon: '🛡️',
    category: 'passive',
    description: '唯一被动——钢铁防线：开局5分钟内格挡33%即将到来的伤害（+33%伤害减免状态，走效果系统，到期自动消失）。',
    descTemplate: '唯一被动——钢铁防线：开局300秒内+33%伤害减免（效果面板显示剩余时间）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      // 通过效果系统添加限时状态：效果面板自带剩余时间进度条，到期自动脱落。
      ctx.effectRegistry.apply(entityId, {
        name: '钢铁防线',
        icon: '🛡️',
        kind: 'stat',
        statKey: 'damageReduction',
        flatValue: 33,   // v39（节奏）：50→33
        duration: 300,   // v39（节奏）：420→300s（拆掉前期最大一道闸）
        stackable: false,
        stackPolicy: 'refresh',
        uniquePassive: true,
        description: '格挡33%即将到来的伤害（开局保护期）',
      }, 'passive_iron_line');
    },
  },

  // ==================== v36（Q2）：过载 ====================
  // 两阶段自毁被动，起始时间按层级递增（外20/内30/水晶45/枢纽60 分钟）。
  //   第一阶段（X 分钟起）：每 30s 损失一次双抗，每次损失量递增（越往后掉得越狠）。
  //   第二阶段（X+5 分钟起）：额外每 30s 损失一次最大生命（当前血超上限一起削，可致死）。
  // 外侧塔损失系数更大（外>内>水晶>枢纽）。状态栏：进入过载后显示"过载"状态+距下次30s倒计时；
  // 未过载时只在技能栏显示本条被动。
  passive_overload: {
    id: 'passive_overload', name: '过载', icon: '💣',
    category: 'passive',
    description: '唯一被动——过载：达到时限后每30秒损失固定双抗（外3/内2.5/水晶2/枢纽1.5）；再过5分钟后额外每30秒损失最大生命值（该项逐次递增）。越外侧的塔损失越多。',
    descTemplate: '唯一被动——过载：外塔20/内塔30/水晶塔45/枢纽塔60分钟起，每30秒损失双抗；再5分钟后额外损失最大生命值。当前 【{val}】。',
    // v42: dynamic descTemplate that respects per-map inst._params overrides
    getDescTemplate: function(entity, instance) {
      var def = towerPassives.passive_overload;
      var cfg = def._TIER_CFG[entity._mapTier];
      if (!cfg) return null;
      var p = instance?._params || {};
      var startMin = p.startMin ?? cfg.startMin;
      var phase2Delay = p.PHASE2_DELAY ?? def.PHASE2_DELAY;
      var resistBase = p.resistBase ?? cfg.resistBase;
      var phase2Min = startMin + (phase2Delay / 60);
      return '唯一被动——过载：' + startMin + '分钟起每30秒损失' + resistBase + '双抗；' + Math.round(phase2Min) + '分钟起额外损失最大生命值。当前 【{val}】。';
    },
    // 各层级：起始分钟 + 双抗每次基数 + 最大生命每次基数（占 maxHP 比例）
    _TIER_CFG: {
      outer:    { startMin: 20, resistBase: 3.0, hpPctBase: 0.015 },
      inner:    { startMin: 30, resistBase: 2.5, hpPctBase: 0.012 },
      base:     { startMin: 45, resistBase: 2.0, hpPctBase: 0.010 },
      hq_tower: { startMin: 60, resistBase: 1.5, hpPctBase: 0.008 },
    },
    RESIST_GROWTH: 1.15, // 每次双抗损失 ×1.15 递增
    HP_GROWTH: 1.12,     // 每次最大生命损失 ×1.12 递增
    INTERVAL: 30,        // 每 30 秒一跳
    PHASE2_DELAY: 300,   // 第二阶段延后 5 分钟（300s）
    // v42: empty defaultParams enables CombatSystem to inject per-map overrides into inst._params
    defaultParams: {},
    computeCurrent: (entity, ctx) => {
      const inst = (entity._skillInstances || []).find(i => i.skillId === 'passive_overload');
      const st = inst?.state;
      if (!st || !st.phase1Started) return '未过载';
      const p2 = st.phase2Started ? '（含最大生命损失）' : '';
      return `已过载${p2}`;
    },
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.armorLost = 0;
      instance.state.mrLost = 0;
      instance.state.resistTicks = 0;
      instance.state.hpTicks = 0;
      instance.state.phase1Started = false;
      instance.state.phase2Started = false;
      instance.state.lastTickAt = 0;
    },
    onUnequip: (entityId, instance, ctx) => {
      // 移除已施加的双抗损失效果（最大生命是直接改 maxHP 基线，不撤销——已过载的塔卸下被动不回血）
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '过载') ctx.effectRegistry.remove(eff.id);
      }
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const def = towerPassives.passive_overload;
      const cfg = def._TIER_CFG[e._mapTier];
      // v42: per-map overload override via inst._params (flat params, set by CombatSystem from map skillOverrides)
      const pOver = instance._params || {};
      const tierCfg = { startMin: (pOver.startMin ?? cfg?.startMin ?? 99), resistBase: (pOver.resistBase ?? cfg?.resistBase ?? 0), hpPctBase: (pOver.hpPctBase ?? cfg?.hpPctBase ?? 0) };
      const ov_INTERVAL = pOver.INTERVAL ?? def.INTERVAL;
      const ov_PHASE2_DELAY = pOver.PHASE2_DELAY ?? def.PHASE2_DELAY;
      const ov_HP_GROWTH = pOver.HP_GROWTH ?? def.HP_GROWTH;
      if (!cfg) return; // 非分层塔（沙盒普通塔）不过载

      const now = window.gameTime || 0;
      const startSec = tierCfg.startMin * 60;
      const st = instance.state;

      // 未到时限：只在技能栏显示，不做任何事，也不建状态
      if (now < startSec) return;

      if (!st.phase1Started) { st.phase1Started = true; st.lastTickAt = startSec - ov_INTERVAL; }
      const phase2At = startSec + ov_PHASE2_DELAY;
      if (!st.phase2Started && now >= phase2At) st.phase2Started = true;

      // 每 30s 一跳
      while (now - st.lastTickAt >= ov_INTERVAL) {
        st.lastTickAt += ov_INTERVAL;
        // v39（用户定稿）：双抗损失【固定不递增】，各层级保留自己的基数
        //（外3.0/内2.5/水晶2.0/枢纽1.5）。生命损失仍按原样递增（用户："过载还是扣最大生命上限"）。
        const rLoss = tierCfg.resistBase;
        st.resistTicks++;
        st.armorLost += rLoss;
        st.mrLost += rLoss;
        // 第二阶段：最大生命损失（递增，当前血超上限一起削→可致死）
        if (st.phase2Started) {
          // 损失量基于【原始】最大生命（st.maxHP0），不用当前正在缩水的 maxHP——
          // 否则 hpLoss 会随 maxHP 一起指数衰减，永远削不到 0（旧 bug：卡在 maxHP=1 不死）。
          if (st.maxHP0 === undefined) st.maxHP0 = e.baseStats.maxHP || 1;
          const hpLoss = st.maxHP0 * tierCfg.hpPctBase * Math.pow(ov_HP_GROWTH, st.hpTicks);
          st.hpTicks++;
          e.baseStats.maxHP = (e.baseStats.maxHP || st.maxHP0) - hpLoss;
          st.hpLostTotal = (st.hpLostTotal || 0) + hpLoss;
          if (e.currentHP > e.baseStats.maxHP) e.currentHP = e.baseStats.maxHP; // 削肉可致死
          if (e.baseStats.maxHP <= 0 || e.currentHP <= 0) {
            e.baseStats.maxHP = Math.max(0, e.baseStats.maxHP);
            if (e.alive) {
              e.alive = false; e.currentHP = 0;
              ctx.eventBus?.emit?.('entity:death', { entityId: e.id });
            }
          }
        }
      }

      // v39（用户定稿）：不再有独立的"过载中"条目。状态栏只保留一条【过载】，
      // 它自己的持续时间进度条 = 距下次过载跳动的 30s 倒计时（duration 设为剩余秒数，
      // 每帧刷新 → 进度环自然走完一圈再重置），说明文案全部集中到这一条。
      const nextIn = Math.max(0.1, ov_INTERVAL - (now - st.lastTickAt));

      // 施加双抗损失（负 flat 状态效果）。v39：主条目【过载】带 30s 倒计时进度条，
      // 说明集中于此；魔抗条 hidden 不单独占状态栏格子（数值照常生效）。
      const p2 = st.phase2Started;
      const cfgTxt = `每30秒 -${tierCfg.resistBase} 双抗`;
      ctx.effectRegistry.apply(entityId, {
        name: '过载', icon: '💣', kind: 'stat', statKey: 'armor', flatValue: -st.armorLost,
        duration: nextIn, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `过载（${cfgTxt}${p2 ? ' + 最大生命流失' : ''}）：已损双抗 -${Math.round(st.armorLost)}`
          + `${p2 ? `，已损最大生命 -${Math.round(st.hpLostTotal || 0)}` : ''}`
          + `　│　下次过载 ${Math.ceil(nextIn)}s`,
      }, 'passive_overload_armor');
      ctx.effectRegistry.apply(entityId, {
        name: '过载', icon: '💣', kind: 'stat', statKey: 'magicResist', flatValue: -st.mrLost,
        duration: nextIn, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `过载：魔抗 -${Math.round(st.mrLost)}`, // 与 armor 条同名 → UI 自动合并为一个图标
      }, 'passive_overload_mr');

    },
  },
};

// ==================== Q2：防御塔成长（LoL 对齐，按建筑层级分技能） ====================
// 攻击力从 startT 起以 +9/分钟 线性推进至 capAD 封顶；内塔额外从 16:00 起双抗 +1/分钟（不封顶）。
// 全部走效果系统（stat 效果、每秒刷新、面板可见），基准时刻取 onEquip 时的游戏时间（即建筑创建/地图加载时刻）。
function _makeTowerGrowth({ id, name, startAD, capAD, adStartT, resistGrowthStartT, fixedSteps, armorPerStep = 0 }) {
  const totalSteps = fixedSteps || Math.round((capAD - startAD) / 9);
  return {
    id, name,
    icon: '📈',
    // v42: defaultParams enables CombatSystem to inject per-map overrides into inst._params
    defaultParams: { adStartT: adStartT, stepAD: 9, totalSteps: totalSteps, armorPerStep: armorPerStep ?? 0, resistGrowthStartT: resistGrowthStartT ?? 0 },
    category: 'passive',
    description: `唯一被动——${name}：从${(adStartT / 60).toFixed(1)}分钟起每分钟攻击力+9（共${totalSteps}层至${capAD}封顶）` +
      (resistGrowthStartT ? '；16分钟起双抗每分钟+1（不封顶）' : '') + '。',
    descTemplate: `唯一被动——${name}：攻击力阶梯成长（当前加成【{val}】），每分钟+9共${totalSteps}层至 ${capAD} 封顶` +
     (resistGrowthStartT ? '；16:00 起双抗 +1/分钟' : '') + '。',
   // v42: dynamic descTemplate that respects per-map inst._params overrides
   getDescTemplate: function(entity, instance) {
     var sv = this; // this === def
     var p = instance && instance._params || {};
     var stepAD = p.stepAD || 9;
     var steps = p.totalSteps || totalSteps;
     return '唯一被动——' + name + '：攻击力阶梯成长（当前加成【{val}】），每分钟+' + stepAD + '共' + steps + '层至 ' + capAD + ' 封顶' + (resistGrowthStartT ? '；16:00起双抗+1/分钟' : '') + '。';
   },
   computeCurrent: (entity, ctx) => {
      const inst = (entity._skillInstances || []).find(i => i.skillId === id);
      const t0 = inst?.state?.t0 || 0;
      const elapsed = Math.max(0, (window.gameTime || 0) - t0);
      return Math.min(Math.max(0, Math.floor((elapsed - (inst?._params?.adStartT ?? adStartT)) / 60)), totalSteps) * 9;
    },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.t0 = window.gameTime || 0;
      instance.state.timer = 0;
      instance.state.adSteps = -1;   // -1 = 尚未挂出效果
      instance.state.resSteps = -1;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      // Q2 展示重做：成长改为【阶梯制】，效果只在"层数变化"时 apply 一次（不再每秒刷新，
      // 根治进度环不断重置的闪烁）；层与层之间只直写 remainingTime = 距下一层的剩余秒数，
      // 进度环即"下一次成长倒计时"，右下角层数徽标 = 当前层数；封顶后转常驻（无进度环）。
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0, t0: window.gameTime || 0, adSteps: -1, resSteps: -1 };
      instance.state.timer += dt;
      if (instance.state.timer < 0.25) return;
      instance.state.timer = 0;
      const st = instance.state;
      const elapsed = Math.max(0, (window.gameTime || 0) - (st.t0 || 0));
      // v42: per-map growth override via inst._params (set by CombatSystem from map skillOverrides)
      const pGrow = instance._params || {};
      const effectiveStartT = pGrow.adStartT ?? adStartT;
      const effectiveStepAD = pGrow.stepAD ?? 9;
      const effectiveTotalSteps = pGrow.totalSteps ?? totalSteps;
      const effectiveArmorPerStep = pGrow.armorPerStep ?? armorPerStep;
      const effectiveResistStartT = pGrow.resistGrowthStartT ?? resistGrowthStartT;

      // ---- 攻击力阶梯 ----
      const rawSteps = Math.floor((elapsed - effectiveStartT) / 60); // 起算点后每满一分钟一层
      const steps = Math.min(Math.max(0, rawSteps), effectiveTotalSteps);
      const capped = steps >= effectiveTotalSteps;
      if (steps !== st.adSteps) {
        st.adSteps = steps;
        if (steps > 0) {
          if (effectiveArmorPerStep > 0) {
            // Q2 修正（最新确认）：护甲与魔抗一块成长，每层各 +armorPerStep
            for (const [rk, rl] of [['armor', '护甲'], ['magicResist', '魔抗']]) {
              ctx.effectRegistry.apply(entityId, {
                name: name + '·双抗', icon: '🛡', kind: 'stat', statKey: rk, flatValue: steps * effectiveArmorPerStep,
                duration: capped ? Infinity : 60, permanent: capped,
                stackable: true, maxStacks: effectiveTotalSteps, stackPolicy: 'refresh',
                alwaysShowStacks: true, uniquePassive: true,
                description: `${rl}+${steps * effectiveArmorPerStep}（第 ${steps}/${effectiveTotalSteps} 层）`,
              }, id + '_step_' + rk);
            }
            for (const aEff of ctx.effectRegistry.getEffects(entityId)) {
              if (aEff.blueprint.name === name + '·双抗') aEff.stacks = steps;
            }
          }
          ctx.effectRegistry.apply(entityId, {
            name, icon: '📈', kind: 'stat', statKey: 'attackDamage', flatValue: steps * effectiveStepAD,
            duration: capped ? Infinity : 60, permanent: capped,
            stackable: true, maxStacks: effectiveTotalSteps, stackPolicy: 'refresh',
            alwaysShowStacks: true, uniquePassive: true,
            description: capped
              ? `攻击力+${steps * effectiveStepAD}（已封顶 ${steps}/${effectiveTotalSteps} 层）`
              : `攻击力+${steps * effectiveStepAD}（第 ${steps}/${effectiveTotalSteps} 层，进度环=下一层倒计时）`,
          }, id + '_ad', );
          const eff = ctx.effectRegistry.getEffects(entityId).find(x => x.blueprint.name === name);
          if (eff) eff.stacks = steps;
        }
      }
      if (!capped) {
        // 层间：直写剩余时间 = 距下一层秒数（不 apply，环平滑倒数不闪）
        const remain = Math.max(0.5, 60 - ((elapsed - effectiveStartT) % 60));
        for (const eff of ctx.effectRegistry.getEffects(entityId)) {
          if ((eff.blueprint.name === name || eff.blueprint.name === name + '·双抗') && steps > 0) eff.remainingTime = remain;
        }
      }

      // ---- 内塔双抗阶梯（不封顶，逻辑同上） ----
      if (effectiveResistStartT) {
        const rSteps = Math.max(0, Math.floor((elapsed - effectiveResistStartT) / 60));
        if (rSteps !== st.resSteps) {
          st.resSteps = rSteps;
          if (rSteps > 0) {
            for (const [key, label] of [['armor', '护甲'], ['magicResist', '魔抗']]) {
              ctx.effectRegistry.apply(entityId, {
                name: name + '·双抗', icon: '🛡', kind: 'stat', statKey: key, flatValue: rSteps,
                duration: 60, stackable: true, maxStacks: 999, stackPolicy: 'refresh',
                alwaysShowStacks: true, uniquePassive: true,
                description: `${label}+${rSteps}（第 ${rSteps} 层，每分钟+1不封顶）`,
              }, id + '_' + key);
            }
            for (const eff of ctx.effectRegistry.getEffects(entityId)) {
              if (eff.blueprint.name === name + '·双抗') eff.stacks = Math.min(rSteps, 999);
            }
          }
        }
        if (rSteps > 0) {
          for (const eff of ctx.effectRegistry.getEffects(entityId)) {
            if (eff.blueprint.name === name + '·双抗') eff.remainingTime = Math.max(0.5, 60 - ((elapsed - effectiveResistStartT) % 60));
          }
        }
      }
    },
  };
}

// ==================== Q5(前批)：基地光环（水晶枢纽默认被动） ====================
// 防守圈内（圆心=枢纽自身，半径=枢纽到己方最远枢纽塔距离+塔射程，与守家圈一致）的
// 己方【小兵】获得 +7%攻速/+3%移速/+1%伤害增幅。走效果系统：入圈上状态、离圈自动脱落。
export const HomeAuraSkill = {
  passive_home_aura: {
    id: 'passive_home_aura',
    name: '基地光环',
    icon: '🏠',
    category: 'passive',
    description: '唯一被动——基地光环：防守圈内的己方小兵获得+7%攻速/+3%移速/+1%伤害增幅。',
    descTemplate: '唯一被动——基地光环：防守圈内己方小兵 +7%攻速/+3%移速/+1%伤害增幅（离圈自动失效）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.timer = 0;
      instance.state.radius = null;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive || !self._mapFaction) return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0, radius: null };
      instance.state.timer += dt;
      if (instance.state.timer < 0.5) return;
      instance.state.timer = 0;

      if (instance.state.radius === null) {
        // v33（Q9）：半径 = 画布上红/蓝基地圈（高地区域）的半径——两处共用 MapSystem
        // 的同一数据源，图上看到多大圈，光环就罩多大。MapSystem 不可用时退回旧算法。
        const mapSys = ctx.mapSystem || window.__app?.mapSystem;
        const r = mapSys?.getBaseCircleRadius?.(self._mapFaction);
        if (r) {
          instance.state.radius = r;
        } else {
          let maxD = 0;
          for (const e of ctx.entityContainer.getAllTowers(true)) {
            if (e._mapTier === 'hq_tower' && e._mapFaction === self._mapFaction) {
              maxD = Math.max(maxD, Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y));
            }
          }
          instance.state.radius = (maxD || 180) + 180;
        }
        instance.state.center = null; // 圆心：基地角点（MapSystem 提供），否则用自身位置
        if (mapSys?.getBaseCircleCenter) instance.state.center = mapSys.getBaseCircleCenter(self._mapFaction);
      }

      const r = instance.state.radius;
      const cx = instance.state.center?.x ?? self.pos.x;
      const cy = instance.state.center?.y ?? self.pos.y;
      for (const ally of ctx.entityContainer.findInRadius(cx, cy, r, null, true)) {
        if (ally.id === entityId || ally.type === 'tower') continue;
        if ((ally._mapFaction || ally.faction) !== self._mapFaction) continue;
        if (!ally._laneId) continue;
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'bonusAttackSpeedPct', flatValue: 7,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '攻速+7%（基地防守圈）',
        }, 'home_aura_as_' + entityId);
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'moveSpeed', percentValue: 3,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '移速+3%（基地防守圈）',
        }, 'home_aura_ms_' + entityId);
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'damageAmpPct', flatValue: 1,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '伤害增幅+1%（基地防守圈）',
        }, 'home_aura_amp_' + entityId);
      }
    },
  },
};

// ==================== Q7：枢纽塔"绝望反击" ====================
// 问题：破了任一路召唤水晶后，防守方毫无反制手段，游戏基本就结束了——枢纽塔太弱。
// 机制：己方每有一座召唤水晶【首次】被摧毁，双枢纽塔即获得一层"绝望反击"：
//        +100% 伤害增幅、+50% 伤害转化，持续 90 秒，可叠加（破几路叠几层）。
// 走效果系统（面板可见、自带倒计时环）。事件驱动，不轮询。
export const LastStandSkill = {
  passive_last_stand: {
    id: 'passive_last_stand',
    name: '绝望反击',
    icon: '🔥',
    category: 'passive',
    description: '唯一被动——绝望反击：己方每有一座召唤水晶首次被摧毁，本塔获得 +105% 伤害增幅、+25 双抗、+150% 治疗与护盾强度，持续 60 秒（可叠加）。',
    descTemplate: '唯一被动——绝望反击：召唤水晶陷落时触发（当前 【{val}】 层），每层 +105% 伤害增幅、+25 双抗、+150% 治疗与护盾强度，持续 60 秒。',
    computeCurrent: (entity, ctx) => {
      const effs = ctx?.effectRegistry?.getEffects(entity.id) || [];
      const e = effs.find(x => x.blueprint.name === '绝望反击');
      return e ? e.stacks : 0;
    },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      // 事件驱动：监听召唤水晶首次陷落。用实例上的标记避免重复订阅。
      if (instance.state._sub) return;
      instance.state._sub = true;
      const handler = ({ faction }) => {
        const self = ctx.entityContainer.get(entityId);
        if (!self || !self.alive || self._mapFaction !== faction) return; // 只有【己方】水晶陷落才触发
        // v33 数值定稿：每层 +105% 伤害增幅、+25 护甲、+25 魔抗、+150% 治疗护盾强度，60s。
        // （原 +100% 增幅 / +50% 伤害转化 / 90s——伤害转化词条随 Q10 改为防御向后从这里移除，
        //  用双抗+治疗护盾强度补足枢纽塔的生存能力。）
        for (const [key, label, val] of [
          ['damageAmpPct', '伤害增幅', 105],
          ['armor', '护甲', 25],
          ['magicResist', '魔抗', 25],
          ['healShieldPowerPct', '治疗护盾强度', 150],
        ]) {
          // perStackFlat 必须显式给出——效果系统的叠层是 flatValue + perStackFlat×(层数-1)，
          // 只设 stackable 而不给 perStackFlat 的话，层数会涨但数值不涨（实测踩过）。
          ctx.effectRegistry.apply(entityId, {
            name: '绝望反击', icon: '🔥', kind: 'stat', statKey: key,
            flatValue: val, perStackFlat: val,
            duration: 60, stackable: true, maxStacks: (inst._params?.maxStacks ?? 10), stackPolicy: 'stack',
            alwaysShowStacks: true, uniquePassive: false,
            description: `${label}+${val}${key === 'armor' || key === 'magicResist' ? '' : '%'}/层（召唤水晶陷落，60秒）`,
          }, 'last_stand_' + key);
        }
      };
      ctx.eventBus?.on('map:nexusDestroyed', handler);
    },
  },
};

export const TowerGrowthSkills = {
  // Q9：嚎哭深渊统一塔成长——每分钟 +9攻击力/+1护甲，封顶14层（首层于 1:00）
  passive_growth_ha: _makeTowerGrowth({ id: 'passive_growth_ha', name: '深渊塔成长', startAD: 0, capAD: 126, adStartT: 0, fixedSteps: 14, armorPerStep: 1 }), // 每分钟+9攻/+1护甲/+1魔抗，开局起算，14层封顶（Q1/Q2最新确认）
  passive_growth_outer: _makeTowerGrowth({ id: 'passive_growth_outer', name: '外塔成长', startAD: 152, capAD: 278, adStartT: 40 }),
  passive_growth_inner: _makeTowerGrowth({ id: 'passive_growth_inner', name: '内塔成长', startAD: 170, capAD: 305, adStartT: 180, resistGrowthStartT: 960 }),
  passive_growth_base:  _makeTowerGrowth({ id: 'passive_growth_base',  name: '水晶塔成长', startAD: 170, capAD: 305, adStartT: 180 }),
  passive_growth_hq:    _makeTowerGrowth({ id: 'passive_growth_hq',    name: '枢纽塔成长', startAD: 150, capAD: 285, adStartT: 180 }),

};
