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
