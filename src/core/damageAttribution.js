/**
 * damageAttribution.js —— "这份伤害该算到哪个攻击者类别头上"的唯一实现。
 *
 * 用户（Q3）："应该分类统计每种不同的单位对该单位造成的伤害，比如红方远程兵XX，
 * 红方近战兵XX，巨龙XX等。"追加："如果攻击者已经死了，那也全算该类型小兵造成的
 * 伤害"——不能因为攻击者在伤害结算/DOT跳伤那一刻已经死亡、已被移出实体容器，
 * 就把这笔伤害归到"环境/未知来源"。
 *
 * EntityContainer.purgeDead() 对非塔单位是【死亡后下一帧立刻从容器移除】（塔会
 * 变成废墟留着，小兵不会）——普攻子弹的飞行时间、DOT 的多次跳伤都完全可能跨过
 * 攻击者死亡、被移出容器的那一刻，所以"分类"不能在伤害结算那一刻才去
 * entities.get(attackerId) 现查，查到的经常已经是 null。
 *
 * 做法：category 在【攻击者确定还活着的那一刻】（开火 / DOT 挂上的那一刻）算好，
 * 存成一份纯数据快照（本函数只读字段、不查容器，返回值也不含实体引用），跟着
 * hitInfo / 效果实例一起往后传——跟本仓库"attackType 在开火那一刻解析并快照"
 * 是同一个理由、同一个时序（见 CombatSystem.performAttack 的 hitInfo 构造）。
 */

export const FACTION_LABEL = { blue: '蓝方', red: '红方', neutral: '中立' };

/** 塔的层级中文名——与 UIManager.selectEntity 里那份同一份数据，两处都引用这里，不再各写一遍。 */
export const TOWER_TIER_LABEL = {
  outer: '外塔', inner: '内塔', base: '水晶防御塔',
  nexus_lane: '召唤水晶', hq_tower: '枢纽防御塔', nexus_main: '水晶枢纽',
};

/** 没有攻击者（真正的环境伤害/来源不明）时的兜底类别——不是"忘了传攻击者"的兜底。 */
export const ENV_CATEGORY = Object.freeze({ key: 'env', label: '环境/未知来源' });

/**
 * @param entity 攻击者实体——可以是已经不在容器里的对象（只要调用方在它还活着的
 *               那一刻把引用/快照传进来），本函数只读字段，不查容器、不判断存活。
 * @param templates CONFIG.templates，用来查小兵的中文名（如"远程兵"）。
 * @returns {{key:string,label:string}} 恒有值，不会返回 null/undefined。
 */
export function attackerCategoryOf(entity, templates) {
  if (!entity) return ENV_CATEGORY;
  if (entity.type === 'dragon') return { key: 'dragon', label: '巨龙' };
  const faction = entity._mapFaction || entity.faction || 'neutral';
  const facLabel = FACTION_LABEL[faction] || '中立';
  if (entity.type === 'tower') {
    const tier = entity._mapTier || 'outer';
    return { key: `${faction}:tower:${tier}`, label: `${facLabel}${TOWER_TIER_LABEL[tier] || '防御塔'}` };
  }
  const tplLabel = templates?.[entity.type]?.label || entity.type || '单位';
  return { key: `${faction}:${entity.type}`, label: `${facLabel}${tplLabel}` };
}

/**
 * 受到伤害的累计统计（原在 CombatSystem.js，持续真实伤害与最大生命缩减也要记，挪到这里共用）。
 * v51.27（Q6）：单位属性窗口的"血条统计"要展示"该单位受到的不同类型伤害统计"，
 * 需要一份累计值——之前完全没有任何地方记录过这个。两条伤害路径
 * （_resolveHit/performAttackDirect）各自的 `target.currentHP -= finalDamage`
 * 后面都调这一个函数，口径统一（按 finalDamage，即实际掉的血，不是护盾吸收前的
 * 原始伤害——跟血条上"掉了多少血"看到的是同一个数）。惯例做法：懒初始化在
 * entity 上挂一个 _dmgTaken 累计表，永不清零（跟塔的其它累计类状态同一惯例，
 * 没有指定要按"每条命"重置的需求就不额外造一层重置逻辑）。
 *
 * v51.29（Q3）：追加两项统计，同一个函数一次性记完，不再新开调用点——
 *   ① _dmgByAttacker：按【攻击者类别】（阵营+兵种/塔层级/巨龙）分桶的累计伤害，
 *      用户："应该分类统计每种不同的单位对该单位造成的伤害。"attackerCategory
 *      由调用方传入（攻击者存活那一刻算好的快照，见 damageAttribution.js 的头注，
 *      解决"攻击者已经死了就归到未知来源"这个用户明确否掉的行为），本函数只管
 *      按 category.key 分桶累加，不关心这份快照是怎么来的。
 *   ② _dmgMitigatedTotal：已缓和的伤害（抗性/减伤/格挡等减少的量，不含护盾吸收——
 *      护盾吸收已经有自己的统计，见 _absorbByShields）。跟 finalDamage 是否 >0
 *      无关——伤害被完全格挡/减到 0 时，缓和量本身依然要计入。
 */
export function trackDamageTaken(target, attackerCategory, attackType, finalDamage, mitigated) {
  if (!target) return;
  if (finalDamage > 0) {
    const key = attackType === 'physical' || attackType === 'magic' ? attackType : 'true';
    const stats = target._dmgTaken || (target._dmgTaken = { physical: 0, magic: 0, true: 0 });
    stats[key] += finalDamage;

    const cat = attackerCategory || ENV_CATEGORY;
    const byAtk = target._dmgByAttacker || (target._dmgByAttacker = new Map());
    const bucket = byAtk.get(cat.key) || { total: 0, count: 0, label: cat.label };
    bucket.total += finalDamage;
    bucket.count += 1;
    byAtk.set(cat.key, bucket);
  }
  if (mitigated > 0) {
    target._dmgMitigatedTotal = (target._dmgMitigatedTotal || 0) + mitigated;
  }
}

/**
 * 持续真实伤害（环境/状态造成的扣血）的唯一结算口。
 * 用户（Q7）："所有减少生命恢复直至负的技能或者是状态……一律改制为造成的真实伤害（不受自身的任何防御措施），
 * 生命恢复永远大于等于0"；追加："所有的扣血都走伤害统计"。
 * 所以这里不过护甲/魔抗/减伤/护盾/闪避（不受自身任何防御措施），直接扣生命，
 * 但按真实伤害记进 _dmgTaken / _dmgByAttacker。结构保护与全局无敌是规则层面的"不可受伤"，
 * 不是单位自身的防御，照旧免疫（与改动前的环境扣血同规则）——由调用方传 immune 判定。
 * @returns 实际扣掉的生命
 */
export function applyEnvTrueDamage(entity, amount, category, eventBus) {
  if (!entity || !entity.alive || !(amount > 0) || !(entity.currentHP > 0)) return 0;
  const dealt = Math.min(amount, entity.currentHP);
  entity.currentHP -= dealt;
  trackDamageTaken(entity, category || ENV_CATEGORY, 'true', dealt, 0);
  if (entity.currentHP <= 0) {
    entity.currentHP = 0; entity.alive = false;
    eventBus?.emit?.('entity:death', { entityId: entity.id });
  }
  return dealt;
}

/**
 * 最大生命缩减（过载 / 热寂）的唯一入口。
 * 用户（Q7）："所有的最大生命值缩减去搜 lol 如何实现的，就是进度条的最大生命还是原先的，
 * 但是被扣除的最大生命值在血条的右面用灰色的斜条纹代表"——英雄联盟里"最大生命值降低"
 * 不会把整条血条重新拉满，而是在右端留一段灰色、不可回复的区域。
 * 所以缩减量累计在 entity._maxHPLost 上，血条按 (最大生命 + 已缩减) 作总长来画（见 resourceBar.hpBarLayout）。
 * 当前生命随之扣掉的部分按真实伤害记进受伤统计（"所有的扣血都走伤害统计"）。
 * @returns 实际缩减的最大生命
 */
export function reduceMaxHP(entity, amount, category, eventBus) {
  if (!entity || !(amount > 0)) return 0;
  const cur = entity.baseStats.maxHP || 0;
  const cut = Math.min(cur, amount);
  entity.baseStats.maxHP = cur - cut;
  entity._maxHPLost = (entity._maxHPLost || 0) + cut;
  // 当前生命跟着扣同样的量（用户此前定稿的"最大生命下降时当前生命对称扣、可致死"，
  // 见 BuffSystem._syncMaxHP），并且不会高于新上限。扣掉的部分按真实伤害记统计。
  // 这里扣过了，就让 _syncMaxHP 下一帧重新取基准（_lastMaxHP 置空），否则它会把同一份变化量
  // 再从当前生命里扣一次——改动前过载/热寂在满血时就是这样被扣了两次，而且同步那一刀不进统计。
  const before = entity.currentHP || 0;
  entity.currentHP = Math.max(0, Math.min(entity.baseStats.maxHP, before - cut));
  if (before - entity.currentHP > 0) trackDamageTaken(entity, category || ENV_CATEGORY, 'true', before - entity.currentHP, 0);
  entity._lastMaxHP = undefined;
  if ((entity.baseStats.maxHP <= 0 || entity.currentHP <= 0) && entity.alive) {
    entity.alive = false; entity.currentHP = 0;
    eventBus?.emit?.('entity:death', { entityId: entity.id });
  }
  return cut;
}
