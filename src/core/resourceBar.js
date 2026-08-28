/**
 * resourceBar.js —— "这个单位血条下面该显示什么资源条"的唯一实现。
 *
 * 面板（UIManager 的单位属性窗口）与画面（UnitLayer 的世界空间血条）两处都要画
 * 同一件事，写两份必然某一天只改对了一处——本仓库反复栽在这个形状上，这次一开始
 * 就抽成一份纯函数，两边都调它。
 *
 * 用户定稿："每个单位新增法力条/能量条/充能条等……显示在单位属性窗口的血条下面。"
 * 追加："塔/攻城车的话那个条就显示穿透型子弹的升温（1/4）/闪电杖的闪电充能/
 *        攻城车的攻击充能进度。"
 * 所以不是单纯的"法力条"：没有装 category:'active' 技能的单位改显示自己已有的
 * 充能类进度（穿透升温/闪电杖充能/充能型攻击方式），都没有就不显示（返回 null）。
 *
 * v51.1 追加（用户）：
 *   · 法力显示 XX/XX（当前/上限），充能类显示 XX%，不再只写一个词。
 *   · 法力/升温/闪电充能/通用充能四种颜色必须各不相同——`kind` 字段供两处渲染
 *     查 RESOURCE_COLORS，不再各自硬编码一个颜色。
 *   · 升温条要跟着【升温】展示效果本身走，不能信 weaponInst.state.heatStacks——
 *     那份状态只在"换目标"时清零，效果自己因超时过期时不会同步清零，会出现
 *     "界面上升温图标已经消失、下一下命中却仍按旧层数结算"的错位（见
 *     CombatSystem.performAttack 里同一个 bug 的头注）。这里直接读效果本身的
 *     层数，天然不会比展示效果更"新鲜"或更"过时"。
 */

/** 四种资源类型的颜色（面板资源条 + 世界空间血条贴图共用同一份，不再各写一份）。 */
export const RESOURCE_COLORS = {
  mana: '#6c8cf5',       // 法力：蓝紫
  heat: '#e8643a',       // 穿透型升温：橙红（呼应"热"这个主题）
  lightning: '#f1c40f',  // 闪电杖充能：黄
  charge: '#9b59b6',     // 通用充能型攻击方式（攻城车等）：紫
};

/**
 * @param entity 实体
 * @param ctx { skillLibrary, attrCalc, effects }
 * @returns {{frac:number, kind:string, label:string, regenText?:string}|null}
 */
export function resourceInfoOf(entity, ctx) {
  if (!entity) return null;
  const { skillLibrary, attrCalc, effects } = ctx;
  const insts = entity._skillInstances || [];
  const hasActive = insts.some(i => !i._disabled && skillLibrary[i.skillId]?.category === 'active');
  if (hasActive) {
    const stats = attrCalc.calc(entity, effects.getEffects(entity.id));
    const max = stats.maxMana || 0;
    if (max <= 0) return null;
    const cur = Math.max(0, Math.min(max, entity._mana || 0));
    const regen = stats.manaRegen || 0;
    return {
      frac: max > 0 ? cur / max : 0, kind: 'mana',
      label: `${Math.round(cur)}/${Math.round(max)}`,
      // 用户："法力条右侧显示每秒被动获得法力的值，如果没有就显示为0。"
      regenText: `+${Math.round(regen * 10) / 10}/s`,
    };
  }
  const pierce = insts.find(i => i.skillId === 'weapon_piercing');
  if (pierce) {
    const def = skillLibrary.weapon_piercing;
    const maxS = def?.HEAT_MAX_STACKS || 4;
    const eff = effects.getEffectByName(entity.id, '升温');
    const st = eff ? Math.min(maxS, eff.stacks || 0) : 0;
    return { frac: st / maxS, kind: 'heat', label: `${st}/${maxS}` };
  }
  const lightning = insts.find(i => i.skillId === 'weapon_lightning');
  if (lightning && lightning.state) {
    const c = Math.max(0, Math.min(1, lightning.state.charge || 0));
    return { frac: c, kind: 'lightning', label: `${Math.round(c * 100)}%` };
  }
  const chargeAtk = insts.find(i => skillLibrary[i.skillId]?.category === 'attackmode');
  if (chargeAtk) {
    const c = Math.max(0, Math.min(1, entity._charge || 0));
    return { frac: c, kind: 'charge', label: `${Math.round(c * 100)}%` };
  }
  return null;
}
