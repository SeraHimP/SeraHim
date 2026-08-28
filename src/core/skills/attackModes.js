import { CONFIG } from '../../data/Config.js';

/**
 * attackModes.js —— 「攻击方式」技能类别
 *
 * 用户："可不可以把充能型等（以后可能会有其他的），单独做成技能（类似防御塔的武器），
 *        然后里面各种参数，以后再用的话就很方便了。"
 *
 * ==================== 为什么单独一类 ====================
 * 塔的**武器**（weapon_piercing / weapon_explosive / weapon_lightning…）早就是这个形状：
 * 一个可装卸的技能，把"这个单位怎么打出一次攻击"整段封装起来，参数走
 * defaultParams → CONFIG.skillOverrides → 地图级覆写（见 core/skillParams.js）。
 * 充能攻击是同一类东西 —— 它改的是**开火的节奏**，而不是某个属性。
 *
 * 上一版我把充能写死在攻城车的被动里，那意味着下一个要充能的单位得把同样的逻辑再抄一遍
 *（本仓库反复出现的"同一件事实现了两遍"）。现在充能是一个可以装在**任何单位**身上的技能，
 * 引擎侧只认"装了 category === 'attackmode' 的技能"，不认是谁装的。
 *
 * ==================== 引擎侧的接口 ====================
 * CombatSystem 只问两件事，其余一概不管：
 *   · chargeNeedOf(entity, target) —— 此刻要不要充能？（返回参数）
 *   · chargeReady(entity)          —— 充满了吗？没满不许开火
 * 推进 / 打断衰减 / 打完清零全在 CombatSystem 的通用代码里，新增攻击方式不用碰。
 *
 * 以后再加（比如"蓄力连射""过热"）就在这里多一个条目，
 * 并在 CombatSystem 里给它一个对应的判据 —— 不要再往具体单位的被动里塞。
 */
export const attackModes = {
  atkmode_charge: {
    id: 'atkmode_charge', name: '充能攻击', icon: '🔋', category: 'attackmode',
    color: '#f6c94a',
    // 谁都能装（攻城车只是第一个用它的）。塔也可以 —— 引擎侧没有类型限制。
    applicableTypes: ['ram', 'siege', 'super', 'melee', 'ranged', 'totem', 'warlock', 'corrupt', 'tower', 'dragon'],
    defaultParams: {
      // 1.0 攻速下充满所需秒数；实际耗时 = chargeSecAt1AS / 当前攻速。
      // 「攻速影响充能速度」这条就是靠这个除法落地的，不需要另写一份缩放。
      chargeSecAt1AS: 12,
      // 充满后打出的一发造成多少百分比伤害（100 = 与普通攻击相同）
      damagePct: 375,
      // 充能被打断时每秒衰减**当前充能**的百分比（等比）。
      // 用户定稿："以后所有的充能型武器都是这样，但是数可能会改" ——
      // 所以留成每个攻击方式自己的参数，缺省回落到全局的 CONFIG.tuning.charge。
      decayPctPerSec: null,
      // 只对哪类目标充能：'tower' = 只有打防御塔时才充能，其余目标普通攻击；
      // 'any' = 对谁都充能。攻城车用 'tower'（用户定稿："对防御塔为充能攻击"）。
      onlyVs: 'tower',
    },
    get description() {
      return '攻击方式——充能攻击：对指定类型的目标改为蓄力开火，'
        + '充满才打出一发高倍率攻击；攻速决定充能速度，被打断时充能逐秒衰减。';
    },
    get descTemplate() { return this.description; },
    effects: [],
  },
};

/** 这次攻击是否应当走充能（读已装备的攻击方式技能的解析后参数）。 */
export function chargeParamsFor(entity, target, skillLibrary) {
  if (!entity || !entity._skillInstances) return null;
  for (const inst of entity._skillInstances) {
    if (inst._disabled) continue;
    const def = skillLibrary?.[inst.skillId];
    if (!def || def.category !== 'attackmode' || def.id !== 'atkmode_charge') continue;
    const p = inst._params || def.defaultParams || {};
    const only = p.onlyVs || 'any';
    if (only !== 'any') {
      // 'tower' 指防御塔与水晶（本项目里都是 type='tower'）
      if (!target || target.type !== only) return null;
    }
    return {
      secAt1AS: p.chargeSecAt1AS ?? 12,
      damageMult: (p.damagePct ?? 100) / 100,
      decayPctPerSec: p.decayPctPerSec ?? (CONFIG.tuning?.charge?.decayPctPerSec ?? 10),
    };
  }
  return null;
}
