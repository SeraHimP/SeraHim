/**
 * _helpers.js
 * 技能系统共享工具，供 core/weapons/towerPassives/minionPassives/dragonSouls 各文件导入。
 */

/**
 * 渲染技能的最终描述文本（LoL 式）。
 * 格式：【唯一被动/被动】——【名称】：描述（【当前值】=【公式】）描述
 * - def.descTemplate：含 {val} 或 {xxx} 占位符的模板（已含"唯一被动——名称："前缀）
 * - def.computeCurrent(entity, ctx)：返回单值或对象 { key: value }，填入占位符
 * 无 descTemplate 时回退到 def.description。
 */
export function renderSkillDescription(def, entity, ctx) {
  if (!def) return '';
  // 合并展示的身份技能（core_tier_*）：逐个渲染子技能再拼接，而不是渲染那份拼好的静态文本。
  // 差别在于占位符——子技能各自有 computeCurrent/getDisplayValue，分开渲染才能填出真实的
  // "当前封顶节点/当前成长层数"；对拼好的整段渲染则找不到归属，只会被兜底成 0。
  if (def.mergedSkills && def.mergedSkills.length) {
    const parts = resolveMergedIds(def, entity).map((id) => renderSkillDescription(lookupSkill(id), entity, ctx));
    const joined = parts.filter(Boolean).join('');
    if (joined) return joined;
  }
  if (!def.descTemplate) return def.description || '';
 let text = def.descTemplate;
 // v42: support dynamic descTemplate via getDescTemplate(entity, instance)
 if (def.getDescTemplate && entity) {
   const inst = (entity._skillInstances || []).find(function(i) { return i.skillId === def.id; });
   const t = def.getDescTemplate(entity, inst || null);
   if (t) text = t;
 }
 // Q3：没有 computeCurrent、但提供了 getDisplayValue 的技能（加固城防四档），
 // 此前 {val} 永远填不上、被下面的兜底替换成 "0" —— 面板上写着"【0】为当前封顶节点"，
 // 而实际封顶节点是 100%。这里补上回退，占位符改由 getDisplayValue 提供。
 if (!def.computeCurrent && def.getDisplayValue && entity) {
   const inst = (entity._skillInstances || []).find(function (i) { return i.skillId === def.id; });
   try { text = text.replace(/\{val\}/g, def.getDisplayValue(inst || { state: {} }, entity, ctx)); }
   catch (e) { /* 取不到就走下面的兜底 */ }
 }
 if (def.computeCurrent && entity && ctx) {
    try {
      const val = def.computeCurrent(entity, ctx);
      if (val !== null && typeof val === 'object') {
        for (const [k, v] of Object.entries(val)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
        }
      } else {
        text = text.replace(/\{val\}/g, val);
      }
    } catch (e) { /* 计算失败则保留占位符 */ }
  }
  // 未替换的占位符显示为 0
  text = text.replace(/\{[a-zA-Z_]+\}/g, '0');
  return text;
}

/**
 * 合并展示的身份技能到底该展示【哪几条】。
 *
 * def.mergedSkills 是一份**写死的**清单（如 core_tier_outer → 外塔加固城防 + 外塔成长）。
 * 直接照它渲染会说谎，两种情况都真实发生过：
 *   ① 这座塔根本没装那条子技能 —— 扭曲丛林/嚎哭深渊的地图数据给建筑写了显式 skills，
 *      把默认列表整体顶掉，加固城防没装上，面板却照旧写着"三个生命节点"。
 *      （加固城防本身已改成无条件装配，见 main.js；这里是第二道保险：
 *        地图若用 excludeSkills 明确排除掉，面板就不该再吹。）
 *   ② 装的是【同族的替身】—— 嚎哭深渊用 passive_growth_ha 换掉了 passive_growth_outer，
 *      面板上那段成长文案指的是一个没装的技能，数值与层数全是另一座塔的。
 * 所以：有实体上下文时，按【这座塔真的装了什么】来渲染，并把同族替身接上。
 * 没有实体上下文（模板预览/技能百科）时才退回写死的清单。
 */
const _family = (id) => (id.startsWith('passive_growth') ? 'growth'
                       : id.endsWith('_fortify') ? 'fortify' : id);

export function resolveMergedIds(def, entity) {
  const want = def.mergedSkills || [];
  const have = (entity && entity._skillInstances) ? entity._skillInstances.map(i => i.skillId) : null;
  if (!have || !have.length) return want;
  const out = want.filter(id => have.includes(id));
  for (const id of have) {
    if (out.includes(id)) continue;
    if (want.some(w => _family(w) === _family(id))) out.push(id);   // 同族替身
  }
  return out;
}

/**
 * 技能查表的【延迟绑定】。core.js 里的身份技能要引用 towerPassives 里的子技能文案，
 * 但两者都被 SkillLibrary 汇总，直接 import 会成环。改由 SkillLibrary 注册完后回填。
 */
let _lookup = null;
export function setSkillLookup(fn) { _lookup = fn; }
export function lookupSkill(id) { return _lookup ? _lookup(id) : null; }

/**
 * 合并展示型技能（身份技能 core_tier_*）的描述：**从子技能现取现拼**，不许手抄。
 *
 * 用户 Q3 报的就是手抄的后果：枢纽塔生命恢复从 5 调成 3 之后，
 * passive_hq_fortify 的文案跟着变了，而 core_tier_hq 里那份手抄副本还写着 5，
 * 于是"技能里写 5、状态里是 3"。水晶塔 2→1 也同样残留。
 * 只要文案是拼出来的，改数值就不可能再对不上。
 * @param {string[]} ids 子技能 id（顺序即展示顺序）
 * @param {boolean} tpl  取 descTemplate（true）还是 description（false）
 */
export function mergedDescription(ids, tpl) {
  return (ids || []).map(id => {
    const d = lookupSkill(id);
    if (!d) return '';
    return (tpl ? (d.descTemplate || d.description) : (d.description || d.descTemplate)) || '';
  }).filter(Boolean).join('');
}

// 统一光环范围（所有小兵光环类被动共用，此前炮兵/超级兵150、图腾100、术法120不一致）
export const AURA_RANGE = 150;
// 光环效果统一节流间隔（秒）与 duration（秒）：
// duration 必须显著大于节流间隔，否则节流导致的"晚一点才刷新"会产生短暂真空期，视觉上表现为闪烁。
export const AURA_THROTTLE = 0.3;
export const AURA_DURATION = 3;

/**
 * 通用光环被动生成器：给定"施法者类型过滤"、"目标类型过滤"、"效果列表(可含条件)"，
 * 生成一个标准的光环 onFrame 实现。统一了节流/duration/去重逻辑，
 * 避免每个光环各写一遍、参数不一致（这也是此前"一直在闪"的根因——
 * duration 太短、配合节流导致短暂空窗）。
 *
 * 注意：instance.state 的初始化必须用 `typeof instance.state?.timer !== 'number'` 判断，
 * 不能用 `instance.state = instance.state || {timer:0}` ——因为真实技能实例创建时
 * state 已经是 `{}`（不是 undefined），后者的 `||` 永远短路成功、默认值不会生效，
 * 导致 timer 恒为 NaN、节流完全失效（这是此前排查到的真实 bug，教训写在这里防止重犯）。
 *
 * effectsFn(ally, ctx, waveNumber) 返回一个效果 blueprint 数组（可根据条件返回不同数量）。
 */
/**
 * 光环被动的文案：直接问 effectsFn 要它实际会施加的效果，把各条 blueprint 的
 * description 串起来。这样"技能怎么写"和"状态怎么显示"用的是同一份数据，
 * 不可能再出现文案一套、效果另一套。
 * effectsFn 需要 ally/ctx 时给最小桩；取不到就退回一句通用描述（绝不因为渲染文案而抛异常）。
 */
export function auraDescription(name, range, includeSelf, effectsFn, minWave, hostile = false) {
  let parts = [];
  try {
    const stub = { id: -1, type: 'melee', alive: true, pos: { x: 0, y: 0 }, baseStats: {}, currentHP: 1 };
    const ctx = { entityContainer: { get: () => stub, findInRadius: () => [] }, effectRegistry: { getEffects: () => [] } };
    parts = (effectsFn(stub, ctx, Math.max(minWave || 0, 99)) || [])
      .map(b => b && b.description).filter(Boolean);
  } catch (e) { /* 文案降级，不影响技能本身 */ }
  const who = includeSelf ? '自身及周围' : '周围';
  const body = parts.length ? parts.join('、') : '光环效果';
  const gate = minWave ? `第${minWave}波起默认装配；` : '';
  // 敌对光环必须说"敌军"。说成"友军"就是文案与效果对不上 —— 用户 Q3 点过这类问题。
  const side = hostile ? '敌军' : '友军';
  return `唯一被动——${name}：${gate}为${who}${range}范围内的${side}施加 ${body}。`;
}

// minionsOnly：targetTypes 传 null（不限类型）时用它把塔/巨龙过滤掉。
// 为什么需要这个开关：写死的 targetTypes 数组【收不到自制兵种】——
// 用户做出来的兵拿不到任何光环，而这不会报错，只会静默变弱。
// 传 null + minionsOnly 则天然覆盖所有现有与未来的兵种。
// hostile：光环作用于敌方（蚀骨兵的双抗削弱）。initialStacks：一次施加即满层。
/**
 * v43：`includeSelf` 的默认值从 false 改成 **true**。
 * 用户："所有光环类的效果也对自己生效，要不然太乱了逻辑。"
 * 改动前四条光环里只有图腾守护显式写了 includeSelf:true，其余三条（炮兵指挥官、
 * 超级兵指挥官、术法共鸣）都不惠及自身 —— 面板上写着"周围友军 +20 护甲"，
 * 而施法者自己没有，读起来像 bug 而不像设计。
 * 敌对光环（hostile:true）例外：那种光环是给**敌人**上 debuff 的，
 * 对自己生效等于自残，所以下面强制排除。
 */
export function makeAuraPassive({ id, name, icon, casterType, targetTypes, range = AURA_RANGE,
                                 includeSelf = true, minWave = 0, minionsOnly = false,
                                 hostile = false, initialStacks = 1, effectsFn }) {
  const selfIncluded = hostile ? false : includeSelf;
  return {
    id, name, icon,
    category: 'passive',
    // 光环技能按 casterType 走，applicableTypes 直接用它——覆盖炮兵指挥官/
    // 图腾守护/术法共鸣等全部由这个工厂生成的技能，不用逐个手写。
    applicableTypes: [casterType],
    // minWave 现在是【默认装配的波次门槛】（由 main.js 装备逻辑读取），不再在光环层拦截——
    // 一旦装备（含玩家手动装备）光环即生效，波次门槛只决定"默认何时把技能装上"（炮兵指挥官第20波起默认装配）。
    minWave,
    // 文案从 effectsFn 现取现拼，不写死。写死过的后果见 Q3：超级兵指挥官实际给
    // +17% 减伤 / +1 生命恢复，文案却只有一句"为周围友军提供光环效果"，
    // 玩家在技能栏根本看不到自己吃了什么。现在改一个数值文案就跟着改。
    get descTemplate() { return auraDescription(name, range, selfIncluded, effectsFn, minWave, hostile); },
    get description() { return auraDescription(name, range, selfIncluded, effectsFn, minWave, hostile); },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive || (casterType && entity.type !== casterType)) return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      instance.state.timer += dt;
      if (instance.state.timer < AURA_THROTTLE) return;
      instance.state.timer = 0;

      const nearby = ctx.entityContainer.findInRadius(entity.pos.x, entity.pos.y, range, targetTypes, true);
      // 阵营过滤 + 自身排除：findInRadius 不认阵营也不认查询者——
      // 不过滤的话会把敌方小兵一起 buff；施法者自己永远在半径 0 处，
      // includeSelf=false 必须显式剔除。
      const allies = nearby.filter(a => {
        if (a.id === entityId) return selfIncluded;
        if (minionsOnly && (a.type === 'tower' || a.type === 'dragon')) return false;
        const af = a._mapFaction || a.faction, ef = entity._mapFaction || entity.faction;
        // hostile=true 的光环作用于【敌方】（如蚀骨兵的双抗削弱）。
        if (hostile) return af !== ef;
        return af === ef;
      });

      for (const ally of allies) {
        const blueprints = effectsFn(ally, ctx, ctx.waveNumber || 0);
        for (const bp of blueprints) {
          // v33（Q12）：光环走统一的 aura 机制——在范围内常驻显示（无倒计时环闪烁），
          // 离开范围/光环源死亡后由 EffectRegistry 宽限期（1s > 节流 0.3s）自动脱落。
          ctx.effectRegistry.apply(ally.id, {
            aura: true,
            auraGrace: 1.0,
            stackable: false,
            stackPolicy: 'refresh',
            uniquePassive: true,
            ...bp,
          }, id, initialStacks > 1 ? { initialStacks } : undefined);
        }
      }
    },
  };
}
