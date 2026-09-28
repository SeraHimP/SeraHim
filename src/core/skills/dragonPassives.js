/**
 * dragonPassives.js —— 龙自身的天生被动（区别于 dragonSouls.js：那边是龙死后
 * 发给击杀方单位的奖励，这里是龙这个单位自己一直带着的技能）。
 *
 * 目前只有一条：宿怨。
 *
 * Bug 修复（用户定稿）："巨龙的宿怨应该作为一个技能显示在技能栏，目前并未显示。"
 * 根因：宿怨的数值判定从一开始就直接写死在 CombatSystem._dragonGrudge() 里，
 * 从来没有过一个对应的 skillId / SkillLibrary 条目——技能栏只读
 * entity._skillInstances 再去 SkillLibrary 查定义，查不到自然什么都不会显示。
 * 这里补一份纯【展示用】的技能定义：数值口径仍然是 CombatSystem._dragonGrudge()
 * 那份（同一份 CONFIG.gameRules.dragon.passive），不重复实现、不会出现两个地方
 * 数字对不上的问题；这份定义没有 onHit/onFrame，只负责技能栏图标 + 描述文案。
 * 每条龙创建时要在 factories.js 的 createDragon 里塞一个对应的 _skillInstances
 * 条目，技能栏才会真的显示出来（光有定义、没有实例，技能栏还是空的）。
 */
import { CONFIG } from '../../data/Config.js';

export const dragonPassives = {
  dragon_grudge: {
    id: 'dragon_grudge',
    applicableTypes: ['dragon'],
    name: '宿怨',
    icon: '💢',
    color: '#c0392b',
    category: 'passive',
    descTemplate: '龙对某阵营造成的伤害随该阵营已击杀的元素龙数量提升'
      + '（每层{amp}%），受到该阵营的伤害随之降低（每层{dr}%，远古龙不计入层数，'
      + '但自己也吃这条被动）。当前：蓝方{blue}层 / 红方{red}层。',
    computeCurrent(entity, ctx) {
      const p = (CONFIG.gameRules?.dragon?.passive) || {};
      // 击杀层数由 DragonSystem 维护（只数元素龙），跨系统读取走 window.CTX.__app，
      // 与 SettingsDialog 展示同一份数据同一个口径（factionTotals）。
      const totals = window.CTX?.__app?.dragonSystem?.factionTotals || {};
      return {
        amp: p.damageAmpPerKill ?? 11,
        dr: p.damageReductionPerKill ?? 7,
        blue: totals.blue ?? 0,
        red: totals.red ?? 0,
      };
    },
    description: '龙对某阵营造成的伤害随该阵营已击杀的元素龙数量提升，受到该阵营的伤害随之降低'
      + '（远古龙不计入层数，但自己也吃这条被动）。',
    effects: [],
  },
};
