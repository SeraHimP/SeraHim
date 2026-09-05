/**
 * healing.js —— 治疗与护盾的**唯一入口**。
 *
 * ==================== 为什么要有这个文件 ====================
 * 用户："排查一下治疗与护盾强度是否生效" → 排查结果：**大部分没生效**。
 * 改动前 `healShieldPowerPct` 只出现在两处：
 *   · CombatSystem 的全能吸血
 *   · CombatSystem 的伤害转化护盾
 * 而下面这些一律不吃它 —— 也就是说光龙的「治疗与护盾强度 +8%」买了等于没买：
 *   · 生命恢复（healthRegen，每帧回血）
 *   · 固定护盾的延迟回满（shieldFixedMax）
 *   · 技能治疗：吸血鬼之触 8%、迅捷图腾的光环治疗、水龙魂的全塔 15% 回复
 *   · 技能护盾：山魂的独立护盾、图腾壁垒的出场满盾、行为脚本的 heal/shield 指令
 * 用户定稿：「治疗与护盾强度影响所有的相关属性」。所以这里把口径收成一处，
 * 以后新增任何回血/给盾都必须走这两个函数，漏掉一处就等于又埋一个"买了没用"的属性。
 *
 * ==================== 强度取【谁】的属性 ====================
 * 取**接受治疗/护盾的那一方**。三个理由：
 *   ① 与改动前已有的两处一致：全能吸血取攻击者（= 被治疗者本人），
 *      伤害转化取受击者（= 被加盾者本人）—— 两处都是"接受方"，只是恰好等于来源方。
 *   ② 重伤（闪电杖满充能施加）在本作的定义是「减少目标 40% 治疗与护盾强度」，
 *      只有按接受方取，重伤才能压住【所有】给这个目标的治疗，包括别人给他的。
 *   ③ 光环治疗（迅捷图腾）按接受方算，才不会出现"奶妈站得远近决定队友回多少"的怪事。
 *
 * 强度系数下限夹到 0：属性最低 −100%（编辑器里就是这个下限），
 * 再往下不该变成"治疗反而扣血"——那是另一套机制（负生命恢复），不要在这里混进来。
 */

/** 由已算好的属性表取强度系数（1.0 = 无加成）。 */
export function healPowerOf(stats) {
  return Math.max(0, 1 + ((stats && stats.healShieldPowerPct) || 0) / 100);
}

/**
 * 由实体现取强度系数。ctx 里认两种字段名：
 * 技能上下文用 { attrCalc, effectRegistry }，系统内部用 { attrCalc, effects }。
 */
export function healPowerFor(entity, ctx) {
  if (!entity || !ctx) return 1;
  const attrCalc = ctx.attrCalc;
  const reg = ctx.effectRegistry || ctx.effects;
  if (!attrCalc || !reg) return 1;
  return healPowerOf(attrCalc.calc(entity, reg.getEffects(entity.id)));
}

/**
 * 回血。amount 是【未经强度加成】的原始值，强度在这里乘。
 * capHP 缺省用 maxHP；调用方有更低的封顶（如"加固城防"的节点封顶）就自己传。
 * 返回实际回复量。
 */
export function applyHeal(entity, amount, power, maxHP, capHP) {
  if (!entity || !entity.alive || !(amount > 0)) return 0;
  const cap = Math.min(maxHP ?? Infinity, capHP ?? Infinity);
  const before = entity.currentHP || 0;
  if (before >= cap) return 0;
  entity.currentHP = Math.min(cap, before + amount * (power ?? 1));
  return entity.currentHP - before;
}

/** 临时护盾。amount 同样是未经加成的原始值。返回实际增加量。 */
export function grantTempShield(entity, amount, power) {
  if (!entity || !entity.alive || !(amount > 0)) return 0;
  const add = amount * (power ?? 1);
  entity.tempShield = (entity.tempShield || 0) + add;
  return add;
}

/**
 * 固定护盾的**有效上限**。
 * 固定护盾是"破了以后延迟回满"的机制，没有"回复量"可乘，
 * 所以强度作用在**上限**上：强度 +20% → 这层盾厚 20%，回满也回到这个更高的值。
 * 这是唯一说得通的口径 —— 只乘"回满的那一下"会立刻被上限夹回去，等于没乘。
 */
export function effectiveFixedShieldMax(shieldMax, power) {
  return (shieldMax || 0) * (power ?? 1);
}
