/**
 * ManaSystem.js —— 单位资源条（法力/能量/充能，统一叫"法力"）+ 主动技能施放。
 *
 * ==================== 用户定稿的核心规则 ====================
 * 「每个单位新增法力条/能量条/充能条等（为一个，但是类型可能不同）……攻击/受击/被动
 *  获得法力等。然后法力满了之后就释放主动技能……释放完后法力清零。」
 *
 * 「因为目前并没有任何主动单位的技能，对于没有主动单位的技能，是不能获得任何法力的
 *  （法力恒定为0，即使有最大法力值等其他属性）。」
 *
 * 所以这个系统只做一件"门"的事：**只有装备了 category:'active' 技能的单位才会真正
 * 攒法力**；没装的单位哪怕模板上填了 maxMana/manaRegen，也一律按 0 处理——这不是
 * "没触发"，是每帧显式清零（见 update 里的 hasActiveSkill 分支），保证"恒为0"这条
 * 定稿是真的恒为 0，不是碰巧没人给它加过。
 *
 * ==================== 法力从哪来 ====================
 * 被动：每帧按 manaRegen 回复（这里做）。
 * 攻击/受击：监听 CombatSystem 已有的 `damage:dealt` 事件——这个事件只在**普通攻击**
 * 命中时发出（_resolveHit），技能/DOT/溅射不发。用普通攻击而不是"任意一次伤害"来触发
 * 法力增长，是刻意的：与 LoL 里"技能本身不回蓝、只有普攻回蓝"是同一个道理，
 * 否则主动技能会自己给自己充能，节奏会失控。
 * v51.1：这两个数改成**全局**一份（CONFIG.tuning.mana.onAttack/onHitTaken），
 * 不再是每个模板各存一份——用户："全局生效，每个单位每次受击获得2，每次攻击获得1
 * （每张地图/每个单位可能不一样，先都按这个写，可修改）"。
 *
 * ==================== 法力满了之后：施放触发方式（v51.27 / Q2）====================
 * 用户："主动技能的施放应该有不同的形式：法力值满后自动释放/满后攻击才释放/满后受击
 * 才释放等（或者是两种都可以触发）。"
 *
 * 排查结论：改这条之前，本文件对**所有**装了主动技能的单位一视同仁——法力一满，
 * 下一帧 update() 就直接尝试 onCast，跟这一帧是不是恰好发生了攻击/受击完全无关。
 * 用户当时的印象是"现有主动技能除了超级兵都是攻击触发"，但逐条核对 Config.js 的
 * 模板发现：除了近战兵（manaRegen:0，只能靠攻击/受击攒满）之外，其余全部单位类型
 * 的 manaRegen 都不是 0——被动回复本身就能把法力堆满，跟有没有攻击完全无关。
 * 也就是说，改动前的"看起来像攻击触发"只是因为大多数对局里单位一直在打架，被动回复
 * 攒满的那一刻恰好前后脚跟着一次攻击，视觉上不容易分辨，架构上并不是真的攻击门控。
 * 如实记录这个发现，不假装现状符合用户的原始描述。
 *
 * 这里新增的是一个**框架**，不是重新指派现有技能——`def.castTrigger` 声明这个技能
 * 该用哪种触发方式，缺省（或显式 'onFull'）就是"满了立刻放"，与改动前逐位一致
 * （不破坏任何已有平衡数据，符合"参数化默认值必须跟参数化前一致"这条硬约束）。
 * 可选值：
 *   'onFull'        —— 默认：法力满格后下一帧立刻尝试施放（原有行为）。
 *   'onAttack'      —— 法力满格后，等这个单位**自己打出一次普通攻击**才尝试施放。
 *   'onHit'         —— 法力满格后，等这个单位**挨一次普通攻击**才尝试施放。
 *   'onAttackOrHit' —— 以上两种任一发生都可以触发（"两种都可以触发"）。
 * 满格但还没等到触发事件期间，法力照常停在满格（不会溢出丢失，也不会被二次施放）。
 * 具体某条技能用哪一档由技能自己在定义里声明，本次不重新指派任何现有技能的默认值。
 *
 * 找该单位装备的第一个 category:'active' 技能实例，调用它的 onCast(entityId, instance, ctx)。
 * onCast 自己负责索敌/找目标——找不到目标就返回 falsy，本帧不消耗法力、下一次触发
 * 再试（法力停在满格，不会绷在那里"漏掉"这次施放）。施放成功后法力按
 * ACTIVE_TUNING.consumeMode 处理（目前只有 'toFloor'：清到 manaFloor，默认 0）。
 *
 * ==================== 延迟消耗（用户："只有攻击了法力值才清零重新计算"）====================
 * 少数技能（术士兵的蓄能打击）不是"放出去立刻清零"，而是"蓄势待发，等下一次普通
 * 攻击命中才真正清零"——法力条在待发期间必须一直显示满格。这类技能在自己的定义里
 * 声明 `deferredConsume: true`，onCast 成功后自己把 `instance.state._armed = true`。
 * 见到这个标记后本系统：①不清空法力（技能自己决定什么时候清）；②本帧起不再重复
 * 调用 onCast（`_armed` 还在就跳过），直到别处（目前是 CombatSystem 消耗
 * entity._empowerNextAttack 时）把 `_armed` 改回 false。
 * 这与 castTrigger 是两回事：castTrigger 决定"满格后靠什么事件触发 onCast"，
 * deferredConsume 决定"onCast 成功之后法力什么时候真正清零"，互不冲突。
 *
 * ==================== 沉默 ====================
 * 持有【沉默】状态（EffectRegistry.isSilenced）的单位法力照常回复、照常封顶，
 * 只是不会尝试施放——沉默一解除，攒好的法力立刻放出去（或等下一次触发事件），
 * 这是"压制"而不是"清零重来"。
 */
import { CONFIG, ACTIVE_TUNING } from '../data/Config.js';

export class ManaSystem {
  constructor(entities, effects, eventBus, skillLibrary, attrCalc, combat) {
    this.entities = entities;
    this.effects = effects;
    this.eventBus = eventBus;
    this.skills = skillLibrary;
    this.attrCalc = attrCalc;
    this.combat = combat;
    eventBus?.on?.('damage:dealt', (e) => this._onDamageDealt(e));
  }

  /** 该单位是否装备了至少一个未禁用的主动技能——法力系统对它是否"真的生效"的唯一判据。 */
  hasActiveSkill(entity) {
    return !!(entity && (entity._skillInstances || []).some(
      i => !i._disabled && this.skills[i.skillId]?.category === 'active'));
  }

  _firstActiveInst(entity) {
    return (entity._skillInstances || []).find(
      i => !i._disabled && this.skills[i.skillId]?.category === 'active') || null;
  }

  _onDamageDealt({ sourceId, targetId, amount, attackShare }) {
    if (!(amount > 0)) return;
    const m = CONFIG.tuning?.mana || {};
    // bug 修复：用户报"闪电杖每秒4跳，每跳都各回复一次完整的攻击/受击法力"。
    // 普通攻击（_resolveHit）一次攻击只发一次这个事件，隐含 attackShare=1；
    // 闪电杖/腐蚀型这类"一次攻击拆成多跳结算"的武器每跳都发一次，不折算份额的话
    // 4 跳会变成 4 倍法力。这里按 attackShare 折算，4 跳累计起来才等于一次
    // 完整攻击应得的法力（0.25 份额 × 4 跳 = 1 次完整攻击）。
    const share = Math.max(0, Math.min(1, attackShare ?? 1));
    const attacker = this.entities.get(sourceId);
    const target = this.entities.get(targetId);
    if (attacker && this.hasActiveSkill(attacker) && m.onAttack) {
      const stats = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id));
      this._addMana(attacker, stats, m.onAttack * share);
      // v51.27（Q2）：满格后等"自己打出一次攻击"才施放的技能，这次攻击事件本身
      // 就是触发信号——本帧就试一次，不用等到下一帧 update() 的被动回复分支。
      this._tryCastIfTriggered(attacker, stats, 'onAttack');
    }
    if (target && target.alive && this.hasActiveSkill(target) && m.onHitTaken) {
      const stats = this.attrCalc.calc(target, this.effects.getEffects(target.id));
      this._addMana(target, stats, m.onHitTaken * share);
      // 同理：满格后等"自己挨一次攻击"才施放的技能。
      this._tryCastIfTriggered(target, stats, 'onHit');
    }
  }

  _addMana(entity, stats, amount) {
    const max = stats.maxMana || 0;
    if (max <= 0) return;
    // v51.6：地图光环（嚎哭深渊"所有单位获取的法力值减少50%"）等来源统一走
    // manaGainPct 这个倍率修正，攻击/受击/被动回复三条来源都吃这一层。
    const gain = amount * Math.max(0, 1 + (stats.manaGainPct || 0) / 100);
    entity._mana = Math.min(max, (entity._mana || 0) + gain);
  }

  /** castTrigger 是否认可 firedEvent（'onAttack'/'onHit'）为一次有效触发。 */
  _triggerMatches(castTrigger, firedEvent) {
    if (castTrigger === 'onAttackOrHit') return true;
    return castTrigger === firedEvent;
  }

  /**
   * 供 _onDamageDealt 调用：法力已经满格、且这个单位的主动技能声明的 castTrigger
   * 恰好认这次事件（攻击/受击）时，立刻尝试一次施放，不必等到下一帧。
   * 与 update() 里的自动施放分支共用同一个 _tryCast，两处判定逻辑不重复。
   */
  _tryCastIfTriggered(entity, stats, firedEvent) {
    const max = stats.maxMana || 0;
    if (max <= 0 || (entity._mana || 0) < max) return;
    const inst = this._firstActiveInst(entity);
    if (!inst) return;
    const def = this.skills[inst.skillId];
    const trigger = def?.castTrigger || 'onFull';
    if (trigger === 'onFull' || !this._triggerMatches(trigger, firedEvent)) return;
    if (this.effects.isSilenced(entity.id)) return;
    this._tryCast(entity, inst, def, stats, max);
  }

  /** 实际调用 onCast 并按 consumeMode/deferredConsume 处理法力清零，两处触发路径共用。 */
  _tryCast(entity, inst, def, stats, max) {
    if (!def || !def.onCast) return;
    if (inst.state?._armed) return; // 延迟消耗：已经放过、正等着被消耗，不重复施放。
    const ok = def.onCast(entity.id, inst, {
      entityContainer: this.entities, effectRegistry: this.effects, eventBus: this.eventBus,
      attrCalc: this.attrCalc, combat: this.combat, waveNumber: window.waveNumber || 0,
    });
    if (!ok) return; // 没找到目标：法力保持满格，下一次触发再试
    if (def.deferredConsume && inst.state?._armed) return;
    const floor = Math.min(max, Math.max(0, stats.manaFloor || 0));
    entity._mana = ACTIVE_TUNING.consumeMode === 'toFloor' ? floor : entity._mana;
  }

  update(dt) {
    for (const entity of this.entities.getAll(true)) {
      if (!this.hasActiveSkill(entity)) {
        // 用户定稿："恒定为0"——不是"不回复"，是每帧显式清零，不留下任何残留状态。
        if (entity._mana) entity._mana = 0;
        continue;
      }
      const stats = this.attrCalc.calc(entity, this.effects.getEffects(entity.id));
      const max = stats.maxMana || 0;
      if (max <= 0) { entity._mana = 0; continue; }
      if (entity._mana === undefined) entity._mana = Math.min(max, stats.manaStart || 0);
      // v51.6：被动回复同样吃 manaGainPct（见 _addMana 里那段说明）。
      // v51.27（Q5）：新增 baseManaRegenMod（基础法力恢复，百分比，默认100%）——
      // 跟 CombatSystem 里 baseHealthRegenMod 同一读法，直接读 baseStats 上的出厂/
      // 模板值，不走 AttributeCalculator 的加成管线（那条系数本身就是"这个单位天生
      // 回蓝快不快"，不是会被技能/状态叠加的常规属性）。只乘在被动回复这一项，
      // 攻击/受击回蓝走 manaGainPct，两条互不影响。
      if (stats.manaRegen) {
        const gainPct = Math.max(0, 1 + (stats.manaGainPct || 0) / 100);
        const regenMod = entity.baseStats?.baseManaRegenMod ?? 1;
        entity._mana = Math.min(max, entity._mana + stats.manaRegen * regenMod * gainPct * dt);
      }
      if (entity._mana < max) continue;

      // 沉默：法力照常封顶待命，只是不尝试施放。
      if (this.effects.isSilenced(entity.id)) continue;

      const inst = this._firstActiveInst(entity);
      if (!inst) continue;
      const def = this.skills[inst.skillId];
      // v51.27（Q2）：castTrigger 不是 'onFull' 的技能，满格后要等 _onDamageDealt
      // 里对应的攻击/受击事件才施放，这一帧不主动尝试——见文件头注的框架说明。
      const trigger = def?.castTrigger || 'onFull';
      if (trigger !== 'onFull') continue;
      this._tryCast(entity, inst, def, stats, max);
    }
  }
}
