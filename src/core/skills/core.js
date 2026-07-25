import { mergedDescription } from './_helpers.js';

// 身份技能（v37 Q1 定稿：合并展示，不再嵌套分组）
// —— 技能槽第 1 位。只有【加固城防 + 塔成长】两项的文案合并显示在身份技能里
//    （对应的 fortify/growth 技能实例仍然真实装配并生效，但技能栏【不再单独显示】，
//    由 mergedSkills 声明、UIManager 渲染时过滤）。其余被动（钢铁防线/镀层/钢铁烈阳护盾/
//    绝望反击/过载/武器）保持独立技能格，与从前一样平铺。
export const core = {
  core_normal: {
    id: 'core_normal', name: '普通塔身', icon: '🏰', category: 'core',
    description: '基础塔身，无额外效果。',
    descTemplate: '基础塔身，无额外效果。',
    effects: [], onEquip: () => {},
  },

  core_tier_outer: {
    id: 'core_tier_outer', name: '外侧防御塔', icon: '🗼', category: 'core',
    mergedSkills: ['passive_outer_fortify', 'passive_growth_outer'],
    // 文案从子技能现取现拼（见 _helpers.mergedDescription）——手抄过就出过
    // "技能里写5、状态里是3"的事故，这里用 getter 保证永远同步。
    get description() { return mergedDescription(this.mergedSkills, false); },
    get descTemplate() { return mergedDescription(this.mergedSkills, true); },
    effects: [], onEquip: () => {},
  },
  core_tier_inner: {
    id: 'core_tier_inner', name: '内侧防御塔', icon: '🏯', category: 'core',
    mergedSkills: ['passive_inner_fortify', 'passive_growth_inner'],
    // 文案从子技能现取现拼（见 _helpers.mergedDescription）——手抄过就出过
    // "技能里写5、状态里是3"的事故，这里用 getter 保证永远同步。
    get description() { return mergedDescription(this.mergedSkills, false); },
    get descTemplate() { return mergedDescription(this.mergedSkills, true); },
    effects: [], onEquip: () => {},
  },
  core_tier_base: {
    id: 'core_tier_base', name: '水晶防御塔', icon: '🏛️', category: 'core',
    mergedSkills: ['passive_base_fortify', 'passive_growth_base'],
    // 文案从子技能现取现拼（见 _helpers.mergedDescription）——手抄过就出过
    // "技能里写5、状态里是3"的事故，这里用 getter 保证永远同步。
    get description() { return mergedDescription(this.mergedSkills, false); },
    get descTemplate() { return mergedDescription(this.mergedSkills, true); },
    effects: [], onEquip: () => {},
  },
  core_tier_hq: {
    id: 'core_tier_hq', name: '枢纽防御塔', icon: '🏰', category: 'core',
    mergedSkills: ['passive_hq_fortify', 'passive_growth_hq'],
    // 文案从子技能现取现拼（见 _helpers.mergedDescription）——手抄过就出过
    // "技能里写5、状态里是3"的事故，这里用 getter 保证永远同步。
    get description() { return mergedDescription(this.mergedSkills, false); },
    get descTemplate() { return mergedDescription(this.mergedSkills, true); },
    effects: [], onEquip: () => {},
  },

  core_nexus_lane: {
    id: 'core_nexus_lane', name: '召唤水晶', icon: '🔮', category: 'core',
    description: '分路召唤水晶：无武器；本路水晶塔存活时不可被选中；被摧毁后敌方在本路追加超级兵；5分钟后重生。',
    descTemplate: '召唤水晶：无武器。本路水晶塔存活时受保护；被摧毁后敌方追加超级兵；5分钟后重生。',
    effects: [], onEquip: () => {},
  },
  core_nexus_main: {
    id: 'core_nexus_main', name: '水晶枢纽', icon: '💎', category: 'core',
    description: '主基地水晶：无武器；双枢纽塔全灭前不可被选中。',
    descTemplate: '水晶枢纽：无武器。双枢纽塔全部存活期间受保护。',
    effects: [], onEquip: () => {},
  },
};
