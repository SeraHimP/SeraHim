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
 */

/**
 * @param entity 实体
 * @param ctx { skillLibrary, attrCalc, effects }
 * @returns {{frac:number, label:string}|null}
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
    return { frac: Math.max(0, Math.min(1, (entity._mana || 0) / max)), label: '法力' };
  }
  const pierce = insts.find(i => i.skillId === 'weapon_piercing');
  if (pierce && pierce.state) {
    const def = skillLibrary.weapon_piercing;
    const maxS = def?.HEAT_MAX_STACKS || 4;
    const st = Math.min(maxS, pierce.state.heatStacks || 0);
    return { frac: st / maxS, label: `升温 ${st}/${maxS}` };
  }
  const lightning = insts.find(i => i.skillId === 'weapon_lightning');
  if (lightning && lightning.state) {
    const c = Math.max(0, Math.min(1, lightning.state.charge || 0));
    return { frac: c, label: `闪电充能 ${Math.round(c * 100)}%` };
  }
  const chargeAtk = insts.find(i => skillLibrary[i.skillId]?.category === 'attackmode');
  if (chargeAtk) {
    const c = Math.max(0, Math.min(1, entity._charge || 0));
    return { frac: c, label: `充能 ${Math.round(c * 100)}%` };
  }
  return null;
}
