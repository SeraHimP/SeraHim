/**
 * actives.js —— 主动技能（category:'active'）。
 *
 * 与"被动"（category 不是 'active' 的那些）的区别只有一件事：谁来决定什么时候触发。
 * 被动由引擎的战斗时序（onHit/onDealtDamage/onFrame）驱动；主动由 ManaSystem 驱动——
 * 法力条攒满就调用这里的 onCast，找不到目标就返回 false（法力保持满格，下一帧再试）。
 *
 * ==================== 数值怎么写 ====================
 * 用户明确要求："技能的法强相关的数值我自己写！！！不要弄成你说的那种。"
 * 所以引擎只往外暴露一个只读的 `abilityPower` 属性，具体每个技能的伤害/治疗公式
 * 全部在各自的 onCast 里手写——不存在共享的 `skillValue()` 之类的换算函数。
 * 下面这三条是**示例/测试用**（用户："为了测试，给大型小兵/龙写一些简单的主动技能，
 * 每种类型单位都不同，要和法术强度能联动的"），数值公式仅供验证整条链路，
 * 以后要精调直接改这个文件、或者把系数挪进 defaultParams 走地图/全局覆写。
 *
 * ==================== 技能增幅/技能暴击怎么接上的 ====================
 * onCast 里造成伤害一律走 `ctx.combat.performAttackDirect(...)`，**不传** `basicAttack`——
 * 默认值就是"这是技能"，技能增幅与【技能暴击】状态自动生效，不需要这里操心。
 */
import { enemyUnitsInRadius } from '../../systems/FactionSystem.js';
import { healPowerOf, applyHeal } from '../healing.js';

/** 找 self 附近最近的一个敌人（复用引擎既有的阵营感知半径查询，不再另写一份）。 */
function nearestEnemy(ctx, self, range) {
  const cands = enemyUnitsInRadius(ctx.entityContainer, self, range, { includeBuildings: true });
  let best = null, bestD = Infinity;
  for (const e of cands) {
    if (!e.alive) continue;
    const d = Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** self 半径内的存活友军（含自己）——群体治疗用，阵营判据与其它系统一致。 */
function alliesInRadius(ctx, self, range) {
  const fac = self._mapFaction || self.faction || null;
  return ctx.entityContainer.findInRadius(self.pos.x, self.pos.y, range, null, true)
    .filter(e => e.alive && (e._mapFaction || e.faction || null) === fac);
}

export const actives = {
  // ==================== 炮兵：轰炸（AP + AD 联动的单体爆发）====================
  active_siege_barrage: {
    id: 'active_siege_barrage', name: '轰炸', icon: '💥', color: '#e67e22', category: 'active',
    applicableTypes: ['siege'],
    defaultParams: { range: 300, baseDamage: 40, apScale: 0.8, adScale: 0.3 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，对射程内最近的敌人造成 ${p.baseDamage} + ${p.apScale}×法术强度 `
           + `+ ${p.adScale}×攻击力 的魔法伤害。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const target = nearestEnemy(ctx, self, instance._params?.range ?? 300);
      if (!target) return false;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const p = instance._params || actives.active_siege_barrage.defaultParams;
      const dmg = (p.baseDamage ?? 40)
        + (p.apScale ?? 0.8) * (stats.abilityPower || 0)
        + (p.adScale ?? 0.3) * (stats.attackDamage || 0);
      if (!(dmg > 0) || !ctx.combat) return false;
      ctx.combat.performAttackDirect(entityId, target.id, dmg, 'magic');
      return true;
    },
  },

  // ==================== 图腾兵：治疗波（AP 联动的群体治疗）====================
  active_totem_pulse: {
    id: 'active_totem_pulse', name: '治疗波', icon: '💚', color: '#2ecc71', category: 'active',
    applicableTypes: ['totem'],
    defaultParams: { range: 220, baseHeal: 60, apScale: 1.0 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，为半径 ${p.range} 内的全部友军回复 ${p.baseHeal} + ${p.apScale}×法术强度 `
           + `生命（受治疗与护盾强度加成）。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return false;
      const p = instance._params || actives.active_totem_pulse.defaultParams;
      const allies = alliesInRadius(ctx, self, p.range ?? 220);
      if (!allies.length) return false;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const heal = (p.baseHeal ?? 60) + (p.apScale ?? 1.0) * (stats.abilityPower || 0);
      if (!(heal > 0)) return false;
      const power = healPowerOf(stats);
      for (const a of allies) {
        const aStats = ctx.attrCalc.calc(a, ctx.effectRegistry.getEffects(a.id));
        applyHeal(a, heal, power, aStats.maxHP || a.currentHP);
      }
      return true;
    },
  },

  // ==================== 龙：新星（AP 联动的范围法术伤害）====================
  active_dragon_nova: {
    id: 'active_dragon_nova', name: '新星', icon: '🌌', color: '#8e44ad', category: 'active',
    applicableTypes: ['dragon'],
    defaultParams: { radius: 160, baseDamage: 80, apScale: 1.2 },
    get description() {
      const p = this.defaultParams;
      return `法力攒满后，对周身半径 ${p.radius} 内的全部敌人各造成 ${p.baseDamage} + `
           + `${p.apScale}×法术强度 的魔法伤害。`;
    },
    effects: [],
    onCast: (entityId, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive || !ctx.combat) return false;
      const p = instance._params || actives.active_dragon_nova.defaultParams;
      const foes = enemyUnitsInRadius(ctx.entityContainer, self, p.radius ?? 160, { includeBuildings: true })
        .filter(e => e.alive);
      if (!foes.length) return false;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const dmg = (p.baseDamage ?? 80) + (p.apScale ?? 1.2) * (stats.abilityPower || 0);
      if (!(dmg > 0)) return false;
      for (const f of foes) ctx.combat.performAttackDirect(entityId, f.id, dmg, 'magic', { vampGroup: true });
      return true;
    },
  },
};
