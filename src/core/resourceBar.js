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
 * 充能类进度（穿透升温/闪电杖充能/充能型攻击方式）；v51.3 起，连这些都没有的
 * 单位也不再隐藏整行，退化显示一条空法力条（0/0）——只有 entity 本身为空才返回 null。
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
 *
 * v51.2 追加（用户纠正）：
 *   · 上一版颜色方案错了——用户原话"法力/充能/能量等的颜色都不一样"是在说
 *     "法力 vs 非法力"要分开，不是"每种非法力资源各配一色"。这次改成两档：
 *     法力＝蓝；升温/闪电充能/通用充能（武器类充能）统一一种灰白色（`NON_MANA_COLOR`），
 *     不刺眼、也不会把叠在条上面的文字糊掉。
 *   · 闪电杖充能格式从 XX% 改成 XX/100（与升温的 X/4 同一种"当前/上限"口径）。
 *   · 法力条右侧不再写"+X/s"，改成 💧X（用户定稿的图标+数字格式）。
 *
 * v51.3 追加（用户再纠正，附截图）：
 *   · v51.2 选的灰白色（#b7bec8）太浅——文字用近白色叠加投影去压它时，
 *     浅灰底 + 近白字 + 淡投影三者亮度太接近，投影撑不开对比度，实际截图里
 *     "85%" 几乎读不出来。这次换成更深的石板灰（依旧是"灰"这个中性色系，
 *     但亮度拉开到能撑住白字+投影的组合，参照法力蓝底下白字读得清的同一个道理）。
 *   · 用户："单位无论有没有法力等都要显示法力条"——不再有"这个单位什么资源都
 *     没有就整行隐藏"的分支。没有任何资源系统的单位现在退化显示一条空的法力条
 *     （0/0，法力蓝），视觉语言统一，也不会出现"点开某些单位面板一截找不到条"
 *     的不一致感。
 *   · 通用充能型攻击方式（攻城车等）的格式补齐成 XX/100——之前只改了闪电杖，
 *     这个分支被漏掉，仍是 XX%（用户这轮指出"原有的XX%也改为XX/100"）。
 */

/** 非法力类资源（升温/闪电充能/通用充能）统一用这一种石板灰，比 v51.2 的浅灰更深、更压得住白字投影。 */
const NON_MANA_COLOR = '#6b7280';

/** 四种资源类型的颜色（面板资源条 + 世界空间血条贴图共用同一份，不再各写一份）。 */
export const RESOURCE_COLORS = {
  mana: '#6c8cf5',            // 法力：蓝紫，唯一独立配色
  heat: NON_MANA_COLOR,       // 穿透型升温
  lightning: NON_MANA_COLOR,  // 闪电杖充能
  charge: NON_MANA_COLOR,     // 通用充能型攻击方式（攻城车等）
};

/**
 * v51.2（Q3）：这几个"展示效果"已经有专属资源条了，状态栏（效果图标行）里
 * 再显示一遍是重复信息——用户原话"因为已经有充能条了"。
 * 三者与各自的资源条一一对应、且从不与法力条同时出现在同一单位身上
 * （见 minionPassives.js/weapons.js 的装配表：装了这些武器/攻击方式的单位
 * 都没有 category:'active' 技能），所以可以无条件从状态栏隐藏，不用按单位再判一次。
 */
export const HIDDEN_STATUS_EFFECT_NAMES = new Set(['升温', '闪电充能', '充能']);

/**
 * @param entity 实体
 * @param ctx { skillLibrary, attrCalc, effects }
 * @returns {{frac:number, kind:string, label:string, regenText?:string}|null} —
 *   仅 entity 为空时返回 null；否则永远有值（v51.3：无资源系统的单位退化成空法力条）。
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
      // 用户："法力条右侧显示每秒被动获得法力的值，如果没有就显示为0"，
      // 格式定稿为 💧X（v51.2 从 "+X/s" 改过来）。
      regenText: `💧${Math.round(regen * 10) / 10}`,
    };
  }
  const pierce = insts.find(i => i.skillId === 'weapon_piercing');
  if (pierce) {
    const def = skillLibrary.weapon_piercing;
    const maxS = def?.HEAT_MAX_STACKS || 4;
    const eff = effects.getEffectByName(entity.id, '升温');
    const raw = eff ? Math.min(maxS, eff.stacks || 0) : 0;
    // v51.5：用户："穿透型子弹的第一次攻击是不算在升温层数的，因为造成100%正常
    // 伤害……第一下攻击不计入。" weapon_piercing 命中后立刻把 heatStacks 设成 1
    // （这个 1 是给【下一击】预判用的，第一击本身按 0 层结算，逻辑没问题），但资源条
    // 直接显示这个"预判层数"就等于"打完第一发正常伤害，条上却已经亮了一格"——
    // 资源条要展示的是"已经吃到手的加成层数"，不是内部为下一击准备的原始计数，
    // 所以这里统一减 1（下限 0），分母也跟着从 maxS 变成 maxS-1（4 层封顶时显示 X/3）。
    // weapon_piercing 自己的叠层/伤害倍率计算完全不动，只改这里的展示口径。
    const st = Math.max(0, raw - 1);
    const dispMax = Math.max(1, maxS - 1);
    return { frac: st / dispMax, kind: 'heat', label: `${st}/${dispMax}` };
  }
  const lightning = insts.find(i => i.skillId === 'weapon_lightning');
  if (lightning && lightning.state) {
    const c = Math.max(0, Math.min(1, lightning.state.charge || 0));
    // v51.2：格式从 XX% 改成 XX/100，与升温的 X/4 同一种"当前/上限"口径。
    return { frac: c, kind: 'lightning', label: `${Math.round(c * 100)}/100` };
  }
  const chargeAtk = insts.find(i => skillLibrary[i.skillId]?.category === 'attackmode');
  if (chargeAtk) {
    const c = Math.max(0, Math.min(1, entity._charge || 0));
    // v51.3：格式补齐成 XX/100，之前只改了闪电杖那一支，这支漏改了。
    return { frac: c, kind: 'charge', label: `${Math.round(c * 100)}/100` };
  }
  // v51.3：用户定稿"单位无论有没有法力等都要显示法力条"——不再对"什么资源都
  // 没有的单位"整行隐藏，退化成一条空的法力条，视觉语言统一。
  return { frac: 0, kind: 'mana', label: '0/0', regenText: '💧0' };
}
