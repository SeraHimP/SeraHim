/**
 * testScenarios.js —— 平衡测试专用技能（不是给正常出兵/建塔流程用的玩法内容）
 *
 * ==================== 为什么要有这个文件、为什么必须是真技能 ====================
 * 用户原话（针对塔平衡横向测试第一版返工）："这个防御塔测试场就是复用召唤师峡谷
 * 的地图，并且我看也没有进攻方和防守方的属性加成啊！进攻方获得的属性加成通过
 * 永久状态实现！并且可以像跑龙魂一样用代码跑！"
 *
 * 第一版的错误：把"进攻方90%减伤+1000%增伤+闪电杖、小兵33%减伤"这套增益直接
 * 内联写在 tools/balance_tower.mjs 脚本里（一个个 fx.apply 调用），只在那个
 * 脚本自己的一次性内存模拟里存在——用户在游戏/编辑器里正常打开地图看，什么都
 * 看不到，因为这套逻辑压根没有接进 SkillLibrary/EffectRegistry 那一整套
 * "真实存在于游戏里的状态系统"。跟龙魂的做法完全不是一回事：龙魂是
 * DragonSystem.js 里定义的真技能，balance_matrix.mjs 的 equipForcedSoul 只是
 * 调用 equipSkill 把这条**已经存在于游戏里**的技能装到蓝方身上而已，脚本自己
 * 不发明任何新机制。这个文件就是照这个形状补上"进攻方强化"这条真技能——
 * 装了就在编辑器/游戏里的技能栏、状态栏里看得到，跑批脚本（tools/balance_tower.mjs）
 * 跟手动在编辑器里给一座塔装这条技能，走的是完全相同的一条路径（equipSkill）。
 *
 * 地图改用真实的召唤师峡谷（summoners_rift_v1）——不再自己另造一张地图。
 * "进攻方是红是蓝"这件事本身不属于地图能声明的范畴（每局随机），所以地图
 * 本身不需要、也不应该带任何这套逻辑；这两条技能是唯一需要新增的东西。
 *
 * ==================== 数值设计 ====================
 * defaultParams 对应用户原话的数字，全部走标准的"技能参数三层覆写"通道
 * （skillParams.js），符合"一切数值都必须软编码"——要调这套测试增益，改这里
 * 的 defaultParams 或走 CONFIG.skillOverrides，不用碰脚本代码。
 *
 * 2026-09-21：删除"强制替换闪电杖"（用户原话"测试技能中删除强制替换闪电杖"）。
 * passive_test_tower_attacker 原来 onEquip 里还会顺手把进攻方的塔武器换成闪电杖，
 * 现在只保留伤害减免/伤害增幅两条属性效果，进攻方武器不再被这条技能动过。
 */
export const testScenarios = {
  // 塔：伤害减免 + 伤害增幅。
  // 2026-09-21：删除"强制替换闪电杖"这一步（用户原话"测试技能中删除强制替换
  // 闪电杖"）——进攻方的武器不再被这条技能改动，防守方那边武器覆写（决定
  // 测哪种塔武器的那个维度）本来就跟这条技能无关，不受影响。
  passive_test_tower_attacker: {
    id: 'passive_test_tower_attacker', name: '【测试】进攻方强化', icon: '⚡',
    color: '#f1c40f', category: 'passive', applicableTypes: ['tower'],
    defaultParams: { damageReductionPct: 90, damageAmpPct: 1000 },
    get description() {
      const p = this.defaultParams;
      return `【塔平衡横向测试专用】伤害减免+${p.damageReductionPct}%、伤害增幅+${p.damageAmpPct}%。`
        + `仅用于对照测试（真实存在的技能，可在编辑器手动装配/观察），不会出现在`
        + `正常出兵/建塔/地图默认配置里。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const p = instance._params || testScenarios.passive_test_tower_attacker.defaultParams;
      ctx.effectRegistry?.apply(entityId, {
        name: '进攻方强化', icon: '⚡', kind: 'stat', statKey: 'damageReduction',
        flatValue: p.damageReductionPct, duration: 0, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `伤害减免 +${p.damageReductionPct}%（塔平衡测试）`,
      }, 'passive_test_tower_attacker_dr');
      ctx.effectRegistry?.apply(entityId, {
        name: '进攻方强化', icon: '⚡', kind: 'stat', statKey: 'damageAmpPct',
        flatValue: p.damageAmpPct, duration: 0, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `伤害增幅 +${p.damageAmpPct}%（塔平衡测试）`,
      }, 'passive_test_tower_attacker_amp');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry?.getEffects(entityId) || []) {
        if (eff.blueprint.name === '进攻方强化') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // 小兵：伤害减免。
  passive_test_minion_attacker: {
    id: 'passive_test_minion_attacker', name: '【测试】进攻方强化（小兵）', icon: '⚡',
    color: '#f1c40f', category: 'passive',
    // 与 src/data/customContent.js 的 BUILTIN_MINION_TYPES 同一份清单——这里不
    // import 那个常量，是因为 customContent.js 反过来 import SkillLibrary.js，
    // 两边互相 import 会成环；这几个类型名本来就很少变，手抄一份的代价比引入
    // 循环依赖小。
    applicableTypes: ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram', 'heavy', 'healer', 'engineer', 'summoner'],
    defaultParams: { damageReductionPct: 33 },
    get description() {
      const p = this.defaultParams;
      return `【塔平衡横向测试专用】伤害减免+${p.damageReductionPct}%。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const p = instance._params || testScenarios.passive_test_minion_attacker.defaultParams;
      ctx.effectRegistry?.apply(entityId, {
        name: '进攻方强化', icon: '⚡', kind: 'stat', statKey: 'damageReduction',
        flatValue: p.damageReductionPct, duration: 0, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `伤害减免 +${p.damageReductionPct}%（塔平衡测试）`,
      }, 'passive_test_minion_attacker_dr');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry?.getEffects(entityId) || []) {
        if (eff.blueprint.name === '进攻方强化') ctx.effectRegistry.remove(eff.id);
      }
    },
  },
};
