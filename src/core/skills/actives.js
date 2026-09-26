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
import { applyHeal, healPowerFor } from '../healing.js';

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
  // ==================== 近战兵：本能格挡 → 伤害转化（用户本轮定稿）====================
  // 用户："近战兵主动技能由格挡+2改为+10%伤害转化（2s，可叠加）。" 原来是固定
  // 格挡 2 点（damageBlock，效果太小、后期几乎无感），改成 +10% 伤害转化
  // （damageConvertPct，受击按比例转临时护盾，量级会随对手伤害自然放大）；
  // "可叠加"走 stackPolicy:'stack'（每次施放 +1 层，刷新 2 秒时限），maxStacks
  // 先给 5（50% 封顶）占位——用户没给上限，考虑到近战兵满血 25 点法力、无被动
  // 回蓝，只靠攻击(+1)/受击(+2)全局法力攒，天然打不快，封顶数值本身待后续观察
  // 是否需要放开。
  active_melee_block: {
    id: 'active_melee_block', name: '本能防御', icon: '🛡️', color: '#95a5a6', category: 'active',
    applicableTypes: ['melee'],
    defaultParams: { convertPct: 10, durationSec: 2, maxStacks: 5 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，获得 ${p.convertPct}% 伤害转化，持续 ${p.durationSec} 秒，可叠加（最多 ${p.maxStacks} 层）。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_melee_block.defaultParams;
      ctx.effectRegistry.apply(entityId, {
        name: '本能防御', icon: '🛡️', kind: 'stat', statKey: 'damageConvertPct',
        // stackPolicy:'stack' 时 totalFlat = flatValue + perStackFlat×(stacks-1)——
        // 两个都要给同一个值，否则第2层起不叠加任何数值（踩过的坑，见 EffectRegistry
        // ._recalcEffectValues 的公式）。
        flatValue: p.convertPct ?? 10, perStackFlat: p.convertPct ?? 10, duration: p.durationSec ?? 2,
        stackable: true, maxStacks: p.maxStacks ?? 5, stackPolicy: 'stack', uniquePassive: true,
        description: `伤害转化+${p.convertPct ?? 10}%（{stacks}层）`,
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
  // v51.6：用户改稿"炮车主动技能的数值修改为恒定30%，持续6秒"——推翻 v51.1 那版
  // "30% + 50%×法术强度、可叠加"的设计，理由是"炮兵本来就没有稳定的法强来源"。
  // 本轮：用户再次改稿，推翻 v51.6 那版恒定值——"炮兵主动技能更新，获得
  // （XX%=30%+20%×法术强度）攻速。"与 v51.1 的形状相同（基础值+AP联动），
  // 但系数从 50% 降到 20%（用户这次给的新数），且不再提"可叠加"，沿用 v51.6
  // 定下的"不叠加、到点刷新"的施放节奏（与 active_melee_block 等同形状）——
  // 两版改动叠加取交集：数值走 AP 联动，机制维持不叠加。
  active_siege_haste: {
    id: 'active_siege_haste', name: '急速装填', icon: '⚡', color: '#e8a23a', category: 'active',
    applicableTypes: ['siege'],
    defaultParams: { basePct: 30, apScalePct: 20, durationSec: 6 },
    // {val} 由 computeCurrent 现算真实数字填入——不能把 "XX" 这两个字母原样写进模板，
    // 那是本仓库已经踩过的坑（见 weapons.js weapon_lightning 头注：玩家在游戏里
    // 看到的是原原本本的"XX"两个字符，根本看不懂）。
    get descTemplate() {
      const p = this.defaultParams;
      return `法力攒满后，获得（{val}=${p.basePct}%+${p.apScalePct}%×法术强度）攻速，`
        + `持续 ${p.durationSec} 秒（固定不叠加，到点刷新）。`;
    },
    get description() { return this.descTemplate; },
    computeCurrent: (entity, ctx) => {
      const p = actives.active_siege_haste.defaultParams;
      const stats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      return Math.round((p.basePct ?? 30) + (p.apScalePct ?? 20) * (stats.abilityPower || 0) / 100);
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_siege_haste.defaultParams;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const pct = (p.basePct ?? 30) + (p.apScalePct ?? 20) * (stats.abilityPower || 0) / 100;
      ctx.effectRegistry.apply(entityId, {
        name: '急速装填', icon: '⚡', kind: 'stat', statKey: 'bonusAttackSpeedPct',
        flatValue: pct,
        duration: p.durationSec ?? 6, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `急速装填：攻速 +${Math.round(pct)}%`,
      }, 'active_siege_haste', { casterId: entityId });
      return true;
    },
  },

  // active_totem_mend（"图腾涌泉"，法力攒满触发一次性群体治疗）已在 Q5 改成
  // 常驻光环持续治疗，见 minionPassives.js 的 passive_totem_mend——用户反馈
  // "图腾兵各种属性堆一块太膨胀了"，收窄图腾兵成只做"光环治疗"这一件事，不再
  // 占用法力槽，这里删除。

  // ==================== 术士兵：蓄能打击（延迟消耗 + 自身叠法术强度）====================
  // 用户："术士兵……主动技能：下次攻击额外造成（XX=10%法术强度）真实伤害且获得5法术
  //        强度（只有攻击了法力值才清零重新计算），被动技能：周围150码友军获得20
  //        法术强度。" 被动那半句原来挂在 passive_warlock_aura 上，Q5 收窄术士兵成
  //        只做"光环增伤"时，光环法强这一项已随光环双穿一起整条删除（见
  //        minionPassives.js 的 passive_warlock_aura 头注），这里只实现主动的一半。
  active_warlock_empower: {
    id: 'active_warlock_empower', name: '蓄能打击', icon: '💥', color: '#9b59b6', category: 'active',
    applicableTypes: ['warlock'],
    defaultParams: { bonusApPct: 10, apGainPerCast: 5, apGainMaxStacks: 20 },
    // ManaSystem 认这个标记：法力攒满时只调一次 onCast，之后即使法力仍然满格也不再重复
    // 施放，直到 instance.state._armed 被下面这条效果的消耗方（CombatSystem）清掉。
    deferredConsume: true,
    get description() {
      const p = this.defaultParams;
      return `法力攒满后蓄势待发并立即获得 ${p.apGainPerCast} 点法术强度（永久叠加，最多${p.apGainMaxStacks}层）：`
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
      // ==================== Q5：自身法强叠层加上限 ====================
      // 排查"术士兵太强"时发现的结构性问题：这条自增益原来 maxStacks:999，事实上
      // 不封顶——一个能存活到局面后期的术士兵会无限膨胀法强（连带它自己的输出和
      // 光环增伤一起滚雪球）。改成有限层数（占位20层=100法强），不是本轮数值削弱
      // 的主角，是补一个此前没设计到的上限。
      const apGain = p.apGainPerCast ?? 5;
      const apMaxStacks = p.apGainMaxStacks ?? 20;
      ctx.effectRegistry.apply(entityId, {
        name: '蓄能强化', icon: '✨', kind: 'stat', statKey: 'abilityPower',
        flatValue: apGain, perStackFlat: apGain,
        duration: Infinity, permanent: true, stackable: true, maxStacks: apMaxStacks, stackPolicy: 'stack',
        description: `蓄能强化（{stacks}层，每层+${apGain}法术强度，最多${apMaxStacks}层）`,
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
          // v51.12：用户"描述要写清晰：该单位每秒损失1%生命值"——照这个句式改写，
          // 同时保留"真实伤害"与"当前生命"这两条机制上不能丢的信息（基数是当前
          // 生命而不是最大生命，见本条上方 v43 头注）。
          description: `该单位每秒损失当前生命值 ${p.pctPerSec ?? 1}%（真实伤害）`,
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

  // ==================== Q5：重装车——铁壁（法力攒满后一段时间伤害减免）====================
  // 用户给的规格："主动技能是一段时间内获得伤害减免。" 数值占位，量级参考荆棘装甲
  // 同款"法力攒满触发限时buff"结构，直接复用同一个模式（不新造一套触发方式）。
  active_heavy_bulwark: {
    id: 'active_heavy_bulwark', name: '铁壁', icon: '🛡', color: '#7f8c8d', category: 'active',
    applicableTypes: ['heavy'],
    defaultParams: { damageReductionPct: 30, durationSec: 4 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后获得 ${p.damageReductionPct}% 伤害减免，持续 ${p.durationSec} 秒。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_heavy_bulwark.defaultParams;
      const pct = p.damageReductionPct ?? 30;
      const dur = p.durationSec ?? 4;
      ctx.effectRegistry.apply(entityId, {
        name: '铁壁', icon: '🛡', kind: 'stat', statKey: 'damageReduction',
        flatValue: pct, duration: dur,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `伤害减免 +${pct}%`,
      }, 'active_heavy_bulwark');
      return true;
    },
  },

  // ==================== Q5：唤灵兵——法力攒满，脚下召唤一只幻灵 ====================
  // 用户定稿："法力攒满时在自己脚下召唤一只幻灵——一个真正的小型战斗单位（复用
  // 现有小兵创建管线，不是特效摆设）……血量/攻击力取偏低量级（近战兵的60~70%），
  // 不成长；同时最多存在2只；幻灵不计入屠戮/龙魂奖励/出兵编排统计口径。"
  //
  // 2026-09-20 追加两处bug修复（用户原话）：
  //   ①"召唤出来的唤灵不移动"——根因：LaneMovementSystem 的小兵过滤条件是
  //     `_laneId || _petOwnerId` 二选一，幻灵两个都没有，直接被整套移动/索敌AI
  //     排除在外，变成一根杵在原地的木桩。幻灵不是牧灵法阵那种"拴绳宠物"（不该
  //     走 _updatePet 的跟随/待机逻辑），它是"一个真正的战斗单位"——所以补的是
  //     `_laneId`（继承施法者自己的），让它并入普通小兵那一整套索敌/追击/推线AI，
  //     不是新写一套。
  //   ②"这个唤灵兵的每秒减少生命值，归零后就死了，不再强制设定到多少秒后死"——
  //     原来的 _summonExpireAt 是"活满 ttlSec 秒无条件强制清零"，用户要求去掉这个
  //     硬计时器，改成【固有衰减】：每秒扣固定比例的最大生命，血量到 0 才死，
  //     这样"这一局它扛了多少伤害"会真实影响它能撑多久，而不是不管打没打都是
  //     同一个数字。用百分比（而不是固定量）扣，是因为幻灵的 maxHP 随波次成长
  //     （继承近战兵的成长曲线），固定量扣血会导致早期幻灵秒死、后期幻灵基本
  //     打不干——百分比衰减能让"不挨打能撑多久"这件事在整局里大致恒定。
  //     drainPctPerSec=7（≈14.3秒衰减完，贴近原来 13.5 秒的量级，只是从"强制
  //     计时器"换成了"血量说了算"，不是要顺带改变幻灵的大致寿命长短）。
  //     真正的扣血/死亡判定在 CombatSystem.update 里（与旧的 _summonExpireAt
  //     判定同一个位置，见那边的头注），这里只在生成时把 drainPctPerSec 打到
  //     幻灵身上。
  //
  // 实现选择：幻灵直接是一个 type:'melee' 实体，只是用 createMinion 的 hpScale/
  // attrScale 参数缩放成 65%、不传 growthFlat（不成长），额外打几个标记：
  // _isSummoned（供 EntropySystem 等统计口径排除，见该文件头注；也是渲染层
  // minionRenderType() 路由到专属"召唤物"造型的判据，见 SpriteFactory.js）、
  // _summonDrainPctPerSec（上面②描述的衰减速率）、_summonVisual（渲染层按
  // 这个标记做半透明+粒子处理）。不新建一个 'phantom' 兵种类型——那意味着要把
  // 编辑器/渲染层那一整套枚举清单再抄一遍（heavy/healer/engineer 每加一个都要
  // 抄七八处），而幻灵的定位就是"一个缩水的近战兵"，复用现有类型完全够用，也更
  // 贴合用户说的"复用现有小兵创建管线"这句话本身。
  //
  // maxAlive 用【施法者自己名下】计数，不是全队共享的池子——每个唤灵兵是独立的
  // 法力条/独立的召唤额度，符合"这个兵种能凭空多一个打架的身体"这个定位本身。
  active_summoner_call: {
    id: 'active_summoner_call', name: '唤灵', icon: '👻', color: '#8e7cc3', category: 'active',
    applicableTypes: ['summoner'],
    defaultParams: { hpScalePct: 65, drainPctPerSec: 7, maxAlive: 2 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后在自己脚下召唤一只幻灵（近战兵${p.hpScalePct}%属性，不成长，`
        + `随施法者一起索敌/推线），每秒衰减${p.drainPctPerSec}%最大生命，`
        + `衰减或战斗归零后死亡；同时最多存在${p.maxAlive}只。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive || typeof ctx.combat?.createMinion !== 'function') return false;
      const p = instance._params || actives.active_summoner_call.defaultParams;
      const maxAlive = p.maxAlive ?? 2;

      // 清点自己名下还活着的幻灵，满编就先不放（法力保持满格，下次触发再试——
      // 等某一只消失腾出名额）。
      self._summonedIds = (self._summonedIds || []).filter(id => {
        const e = ctx.entityContainer.get(id);
        return e && e.alive;
      });
      if (self._summonedIds.length >= maxAlive) return false;

      const faction = self._mapFaction || self.faction;
      const scale = (p.hpScalePct ?? 65) / 100;
      const spirit = ctx.combat.createMinion('melee', self.pos.x, self.pos.y, faction, scale, scale);
      if (!spirit) return false;
      spirit._isSummoned = true;
      spirit._summonDrainPctPerSec = p.drainPctPerSec ?? 7;
      spirit._summonVisual = true;
      spirit._laneId = self._laneId; // 并入施法者自己的兵线AI（索敌/追击/推线），不再是死站桩
      self._summonedIds.push(spirit.id);
      return true;
    },
  },
};
