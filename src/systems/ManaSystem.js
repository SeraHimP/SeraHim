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
 *
 * ==================== 法力满了之后 ====================
 * 找该单位装备的第一个 category:'active' 技能实例，调用它的 onCast(entityId, instance, ctx)。
 * onCast 自己负责索敌/找目标——找不到目标就返回 falsy，本帧不消耗法力、下一帧再试
 * （法力停在满格，不会绷在那里"漏掉"这次施放）。施放成功后法力按
 * CONFIG.templates... 不对，按 ACTIVE_TUNING.consumeMode 处理（目前只有 'toFloor'：
 * 清到 manaFloor，默认 0）。
 *
 * ==================== 沉默 ====================
 * 持有【沉默】状态（EffectRegistry.isSilenced）的单位法力照常回复、照常封顶，
 * 只是不会尝试施放——沉默一解除，攒好的法力立刻放出去，这是"压制"而不是"清零重来"。
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

  _onDamageDealt({ sourceId, targetId, amount }) {
    if (!(amount > 0)) return;
    const attacker = this.entities.get(sourceId);
    const target = this.entities.get(targetId);
    if (attacker && this.hasActiveSkill(attacker)) {
      const stats = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id));
      if (stats.manaOnAttack) this._addMana(attacker, stats, stats.manaOnAttack);
    }
    if (target && target.alive && this.hasActiveSkill(target)) {
      const stats = this.attrCalc.calc(target, this.effects.getEffects(target.id));
      if (stats.manaOnHitTaken) this._addMana(target, stats, stats.manaOnHitTaken);
    }
  }

  _addMana(entity, stats, amount) {
    const max = stats.maxMana || 0;
    if (max <= 0) return;
    entity._mana = Math.min(max, (entity._mana || 0) + amount);
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
      if (stats.manaRegen) entity._mana = Math.min(max, entity._mana + stats.manaRegen * dt);
      if (entity._mana < max) continue;

      // 沉默：法力照常封顶待命，只是不尝试施放。
      if (this.effects.isSilenced(entity.id)) continue;

      const inst = this._firstActiveInst(entity);
      if (!inst) continue;
      const def = this.skills[inst.skillId];
      if (!def || !def.onCast) continue;
      const ok = def.onCast(entity.id, inst, {
        entityContainer: this.entities, effectRegistry: this.effects, eventBus: this.eventBus,
        attrCalc: this.attrCalc, combat: this.combat, waveNumber: window.waveNumber || 0,
      });
      if (!ok) continue; // 没找到目标：法力保持满格，下一帧再试

      const floor = Math.min(max, Math.max(0, stats.manaFloor || 0));
      entity._mana = ACTIVE_TUNING.consumeMode === 'toFloor' ? floor : entity._mana;
    }
  }
}
