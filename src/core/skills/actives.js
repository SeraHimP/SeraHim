/**
 * actives.js —— 主动技能（category:'active'）。
 *
 * ==================== v51.1：推翻重写（两轮）====================
 * 用户："你写的所有临时主动技能都删了重新按我的写。" v51 那三条（炮兵轰炸/图腾治疗波/
 * 龙新星）是我自己拍的占位数值，只用来验证"法力条→满了就放主动"这条链路走不走得通。
 * 第一版按用户精确规格重写；用户随后又补了一版法术强度联动，这里是第二版（最终）。
 *
 * 与"被动"（category 不是 'active' 的那些）的区别只有一件事：谁来决定什么时候触发。
 * 被动由引擎的战斗时序（onHit/onDealtDamage/onFrame）驱动；主动由 ManaSystem 驱动——
 * 法力条攒满就调用这里的 onCast，找不到目标就返回 false（法力保持满格，下一帧再试）。
 *
 * ==================== "延迟消耗"这个特殊约定（术士兵用）====================
 * 大多数主动技能：onCast 一旦返回 true，ManaSystem 立刻把法力清到 manaFloor。
 * 但术士兵的技能是"下次攻击才生效"——用户明确要求"只有攻击了法力值才清零重新计算"，
 * 也就是法力条在"已经蓄好、等待触发"期间必须一直显示满格，不能一放技能就先扣掉。
 * 约定：onCast 里把 `instance.state._armed = true`，ManaSystem 看到这个标记就知道
 * "这次调用已经生效了，但消耗法力这件事我不管，技能自己负责"，之后不会再重复调用
 * onCast（不会每帧重复施放），也不会主动清空法力。真正的消耗发生在
 * CombatSystem.performAttack 里检测到 `attacker._empowerNextAttack` 时——那里会把
 * `_armed` 清掉、法力清到 manaFloor、并按【消耗那一刻】的法术强度结算伤害（不是
 * 施放那一刻），这是通用机制，不是只服务这一个技能。
 *
 * ==================== 数值怎么写 ====================
 * 用户明确要求："技能的法术强度相关的数值我自己写！！！不要弄成你说的那种。"
 * 引擎只往外暴露一个只读的 `abilityPower` 属性，具体每条技能怎么用它由这里手写的
 * 公式决定，不存在共享的换算函数。
 */
import { enemyUnitsInRadius } from '../../systems/FactionSystem.js';
import { healPowerOf, grantTempShield } from '../healing.js';

/** self 半径内的存活友军（含自己）——阵营判据与其它系统一致。 */
function alliesInRadius(ctx, self, range) {
  const fac = self._mapFaction || self.faction || null;
  return ctx.entityContainer.findInRadius(self.pos.x, self.pos.y, range, null, true)
    .filter(e => e.alive && (e._mapFaction || e.faction || null) === fac);
}

export const actives = {
  // ==================== v51.6：近战兵/远程兵首次拥有主动技能 ====================
  // 用户："近战兵，最大法力值25，0/s，主动技能：获得2伤害格挡，持续2秒。
  //        远程兵，最大70，0.5/s，主动技能：下次攻击附带（XX%=25%法强）魔法伤害。"
  // 这两种是场上数量最多的兵种，量级必须压得很低（近战是纯固定值格挡，
  // 远程是延迟消耗但没有额外增益/叠层），不能照搬四条大型小兵那一档的强度。

  // ==================== 近战兵：本能格挡（自增益，固定格挡）====================
  active_melee_block: {
    id: 'active_melee_block', name: '本能格挡', icon: '🛡️', color: '#95a5a6', category: 'active',
    applicableTypes: ['melee'],
    defaultParams: { block: 2, durationSec: 2 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，获得 ${p.block} 点伤害格挡，持续 ${p.durationSec} 秒。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_melee_block.defaultParams;
      ctx.effectRegistry.apply(entityId, {
        name: '本能格挡', icon: '🛡️', kind: 'stat', statKey: 'damageBlock',
        flatValue: p.block ?? 2, duration: p.durationSec ?? 2,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `伤害格挡+${p.block ?? 2}`,
      }, 'active_melee_block', { casterId: entityId });
      return true;
    },
  },

  // ==================== 远程兵：强化射击（延迟消耗，魔法伤害）====================
  // 与术士兵的蓄能打击共用同一套"延迟消耗"机制（CombatSystem.performAttack 里的
  // _empowerNextAttack 消耗点），区别只有 damageType：这条是魔法伤害，不是真实
  // 伤害，也没有术士兵那样"施放即永久叠法术强度"的额外自增益——纯粹是下一击
  // 强化，故意做得比大型小兵那档弱。
  active_ranged_snipe: {
    id: 'active_ranged_snipe', name: '强化射击', icon: '🎯', color: '#3498db', category: 'active',
    applicableTypes: ['ranged'],
    defaultParams: { bonusApPct: 25 },
    deferredConsume: true,
    get description() {
      const p = this.defaultParams;
      return `法力攒满后蓄势待发：下一次普通攻击命中额外造成 (${p.bonusApPct}%×法术强度) 的`
           + `魔法伤害，命中后法力才清零重新计算。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_ranged_snipe.defaultParams;
      self._empowerNextAttack = { bonusApPct: p.bonusApPct ?? 25, skillInstId: instance.id, damageType: 'magic' };
      ctx.effectRegistry.apply(entityId, {
        name: '蓄势待发', icon: '🎯', kind: 'display', type: 'buff', color: '#3498db',
        duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `下一次普通攻击额外造成 ${p.bonusApPct ?? 25}%×法术强度 的魔法伤害`,
      }, 'active_ranged_snipe_buff');
      instance.state = instance.state || {};
      instance.state._armed = true;
      return true;
    },
  },

  // ==================== 炮兵：急速装填（自增益，攻速）====================
  // 用户："炮兵……主动技能，获得（XX%=30%+50%法术强度）攻速，持续6秒，可叠加。"
  active_siege_haste: {
    id: 'active_siege_haste', name: '急速装填', icon: '⚡', color: '#e8a23a', category: 'active',
    applicableTypes: ['siege'],
    defaultParams: { basePct: 30, apScale: 0.5, durationSec: 6 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，获得 (${p.basePct}% + ${p.apScale * 100}%×法术强度) 攻速，`
           + `持续 ${p.durationSec} 秒，可叠加。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_siege_haste.defaultParams;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const pct = (p.basePct ?? 30) + (p.apScale ?? 0.5) * (stats.abilityPower || 0);
      ctx.effectRegistry.apply(entityId, {
        name: '急速装填', icon: '⚡', kind: 'stat', statKey: 'bonusAttackSpeedPct',
        flatValue: pct, perStackFlat: pct,
        duration: p.durationSec, stackable: true, maxStacks: 99, stackPolicy: 'stack',
        description: `急速装填（{stacks}层，每层+${Math.round(pct)}%攻速）`,
      }, 'active_siege_haste', { casterId: entityId });
      return true;
    },
  },

  // ==================== 图腾兵：庇护波（群体临时护盾，法术强度联动）====================
  // 用户："图腾兵……主动技能，对150范围内友军施加（XX=50+3%法术强度）临时护盾。"
  active_totem_shield: {
    id: 'active_totem_shield', name: '庇护波', icon: '🛡', color: '#2ecc71', category: 'active',
    applicableTypes: ['totem'],
    defaultParams: { range: 150, baseShield: 50, apScale: 0.03 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，为半径 ${p.range} 内的全部友军各施加 (${p.baseShield} + `
           + `${p.apScale * 100}%×法术强度) 点临时护盾。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_totem_shield.defaultParams;
      const allies = alliesInRadius(ctx, self, p.range ?? 150);
      if (!allies.length) return false;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const shieldAmt = (p.baseShield ?? 50) + (p.apScale ?? 0.03) * (stats.abilityPower || 0);
      if (!(shieldAmt > 0)) return false;
      for (const a of allies) {
        const aStats = ctx.attrCalc.calc(a, ctx.effectRegistry.getEffects(a.id));
        grantTempShield(a, shieldAmt, healPowerOf(aStats));
      }
      return true;
    },
  },

  // ==================== 术士兵：蓄能打击（延迟消耗 + 自身叠法术强度）====================
  // 用户："术士兵……主动技能：下次攻击额外造成（XX=10%法术强度）真实伤害且获得5法术
  //        强度（只有攻击了法力值才清零重新计算），被动技能：周围150码友军获得20
  //        法术强度。" 被动那半句挂在已有的 passive_warlock_aura 上（见 minionPassives.js），
  //        这里只实现主动的一半。
  active_warlock_empower: {
    id: 'active_warlock_empower', name: '蓄能打击', icon: '💥', color: '#9b59b6', category: 'active',
    applicableTypes: ['warlock'],
    defaultParams: { bonusApPct: 10, apGainPerCast: 5 },
    // ManaSystem 认这个标记：法力攒满时只调一次 onCast，之后即使法力仍然满格也不再重复
    // 施放，直到 instance.state._armed 被下面这条效果的消耗方（CombatSystem）清掉。
    deferredConsume: true,
    get description() {
      const p = this.defaultParams;
      return `法力攒满后蓄势待发并立即获得 ${p.apGainPerCast} 点法术强度（永久叠加）：`
           + `下一次普通攻击命中额外造成 (${p.bonusApPct}%×法术强度) 的真实伤害，`
           + `命中后法力才清零重新计算。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_warlock_empower.defaultParams;
      self._empowerNextAttack = { bonusApPct: p.bonusApPct ?? 10, skillInstId: instance.id };
      // 立即获得法术强度（永久叠加，每次施放都加一层）——与"下次攻击触发"是两件事，
      // 这个是施放那一刻就生效的自增益，不需要等攻击命中。
      const apGain = p.apGainPerCast ?? 5;
      ctx.effectRegistry.apply(entityId, {
        name: '蓄能强化', icon: '✨', kind: 'stat', statKey: 'abilityPower',
        flatValue: apGain, perStackFlat: apGain,
        duration: Infinity, permanent: true, stackable: true, maxStacks: 999, stackPolicy: 'stack',
        description: `蓄能强化（{stacks}层，每层+${apGain}法术强度）`,
      }, 'active_warlock_empower_apgain', { casterId: entityId });
      // 一次性标记："下一次普通攻击会触发"，命中后由 CombatSystem 移除。
      ctx.effectRegistry.apply(entityId, {
        name: '蓄势待发', icon: '💥', kind: 'display', type: 'buff', color: '#9b59b6',
        duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `下一次普通攻击额外造成 ${p.bonusApPct ?? 10}%×法术强度 的真实伤害`,
      }, 'active_warlock_empower_buff');
      instance.state = instance.state || {};
      instance.state._armed = true;
      return true;
    },
  },

  // ==================== 蚀骨兵：环刃毒雾（AOE 中毒，按当前生命%的真实伤害）====================
  // 用户："蚀骨兵……主动技能：对周围所有敌人施加中毒效果，持续4秒。每秒造成1%当前
  //        生命值的真实伤害。" ——注意基数是【当前】生命，不是最大生命，会随中毒推进
  //        自然衰减（BuffSystem 按 blueprint.dotBasis==='currentHP' 识别，见其头注）。
  //        这一条没有法术强度联动——用户给的规格里没提，不强行加。
  active_corrupt_poison: {
    id: 'active_corrupt_poison', name: '环刃毒雾', icon: '☠️', color: '#7bc96f', category: 'active',
    applicableTypes: ['corrupt'],
    defaultParams: { radius: 150, pctPerSec: 1, durationSec: 4 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，对半径 ${p.radius} 内的全部敌人施加中毒，持续 ${p.durationSec} 秒，`
           + `每秒损失其当前生命 ${p.pctPerSec}%（真实伤害）。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_corrupt_poison.defaultParams;
      const foes = enemyUnitsInRadius(ctx.entityContainer, self, p.radius ?? 150, { includeBuildings: true })
        .filter(e => e.alive);
      if (!foes.length) return false;
      for (const f of foes) {
        ctx.effectRegistry.apply(f.id, {
          name: '环刃毒雾', icon: '☠️', kind: 'dot', color: '#7bc96f', type: 'debuff',
          damageType: 'true', dotBasis: 'currentHP',
          percentValue: p.pctPerSec ?? 1, tickInterval: 1, duration: p.durationSec ?? 4,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `环刃毒雾：每秒损失当前生命 ${p.pctPerSec ?? 1}%（真实伤害）`,
        }, 'active_corrupt_poison', { casterId: entityId });
      }
      return true;
    },
  },

  // ==================== 超级兵：荆棘装甲（自身双抗 + 期间反弹实际伤害）====================
  // 用户："超级兵，最大法力120，1/s。新增主动技能【荆棘装甲】：获得（XX=25+10%法强）
  //        双抗，持续8秒。并且期间反弹给伤害者实际造成造成伤害的25%的魔法伤害。"
  // 反弹的是【实际伤害】（减免/护盾吸收之后真正掉的血），不是塔那条"荆棘反击"
  // （passive_thorns）那种按自身属性现算的固定值——两者形状不同，不能公用同一个
  // 实现：这条要接 CombatSystem 的 onDamaged 钩子（与 dragonsoul_steel 同款，见
  // dragonSouls.js 头注"受击时反弹：只反弹近战来源"那条旁边），拿到命中那一刻的
  // 真实扣血量 amount 再按比例反弹；护甲/魔抗那部分是开局蓄势时算好的固定 buff，
  // 两段各自独立，装甲期间反弹的百分比不会因为双抗生效而"越打伤害越少、反弹跟着变少"。
  active_thorn_armor: {
    id: 'active_thorn_armor', name: '荆棘装甲', icon: '🌵', color: '#c0392b', category: 'active',
    applicableTypes: ['super'],
    defaultParams: { flatBase: 25, apScalePct: 10, durationSec: 8, reflectPct: 25 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后获得 (${p.flatBase} + ${p.apScalePct}%×法术强度) 点护甲与魔法抗性，`
           + `持续 ${p.durationSec} 秒；期间受到攻击时，将本次实际承受伤害的 ${p.reflectPct}% `
           + `以魔法伤害反弹给攻击者。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_thorn_armor.defaultParams;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const amt = (p.flatBase ?? 25) + ((p.apScalePct ?? 10) / 100) * (stats.abilityPower || 0);
      const dur = p.durationSec ?? 8;
      if (!(amt > 0)) return false;
      // 护甲和魔抗是两条独立的 stat 效果（EffectRegistry 一条效果只挂一个 statKey），
      // sourceId 共用前缀、按 statKey 分开——onDamaged 只要认到其中任意一条还在场，
      // 就知道"现在处于装甲窗口内"，不用额外起一个计时器去重复维护同一段时长。
      for (const statKey of ['armor', 'magicResist']) {
        ctx.effectRegistry.apply(entityId, {
          name: '荆棘装甲', icon: '🌵', kind: 'stat', statKey,
          flatValue: amt, duration: dur,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `荆棘装甲：${statKey === 'armor' ? '护甲' : '魔法抗性'} +${Math.round(amt)}，`
            + `期间受击反弹 ${p.reflectPct ?? 25}% 实际伤害`,
        }, `active_thorn_armor_${statKey}`, { casterId: entityId });
      }
      return true;
    },
    // ⚠️ CombatSystem._fireOnDamaged 调用这个钩子时**不传技能实例**（签名固定是
    // entityId/attackerId/amount/ctx 四个参数，与 dragonsoul_steel 同款）——要读
    // 地图/实例覆写过的 reflectPct，得自己从受击方身上把技能实例找回来，不能像
    // onCast 那样直接用参数里的 instance。
    onDamaged: (entityId, attackerId, amount, ctx) => {
      if (!(amount > 0)) return;
      const self = ctx.entityContainer.get(entityId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!self || !attacker || !attacker.alive) return;
      const stillArmored = ctx.effectRegistry.getEffects(entityId)
        .some(e => e.sourceId === 'active_thorn_armor_armor' || e.sourceId === 'active_thorn_armor_magicResist');
      if (!stillArmored) return;
      const inst = (self._skillInstances || []).find(i => i.skillId === 'active_thorn_armor');
      const p = inst?._params || actives.active_thorn_armor.defaultParams;
      const back = amount * ((p.reflectPct ?? 25) / 100);
      if (back > 0) ctx.combat?.performAttackDirect?.(entityId, attackerId, back, 'magic', { _noProc: true });
    },
  },
};
