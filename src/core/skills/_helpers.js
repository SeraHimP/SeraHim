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
  if (!def.descTemplate) return def.description || '';
 let text = def.descTemplate;
 // v42: support dynamic descTemplate via getDescTemplate(entity, instance)
 if (def.getDescTemplate && entity) {
   const inst = (entity._skillInstances || []).find(function(i) { return i.skillId === def.id; });
   const t = def.getDescTemplate(entity, inst || null);
   if (t) text = t;
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
export function makeAuraPassive({ id, name, icon, casterType, targetTypes, range = AURA_RANGE, includeSelf = false, minWave = 0, effectsFn }) {
  return {
    id, name, icon,
    category: 'passive',
    // minWave 现在是【默认装配的波次门槛】（由 main.js 装备逻辑读取），不再在光环层拦截——
    // 一旦装备（含玩家手动装备）光环即生效，波次门槛只决定"默认何时把技能装上"（炮兵指挥官第20波起默认装配）。
    minWave,
    descTemplate: `唯一被动——${name}：为周围友军提供光环效果。`,
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
      // 不过滤的话对战模式会把敌方小兵一起 buff（沙盒单阵营暴露不出来）；
      // 施法者自己永远在半径 0 处，includeSelf=false 必须显式剔除。
      const allies = nearby.filter(a => {
        if (a.id === entityId) return includeSelf;
        const af = a._mapFaction || a.faction, ef = entity._mapFaction || entity.faction;
        return !ef || af === ef; // 沙盒无阵营单位视为友方，维持原行为
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
          }, id);
        }
      }
    },
  };
}
