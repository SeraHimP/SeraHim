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
    description: '唯一被动——加固城防：外塔拥有三个生命节点33%，67%，100%，生命恢复不会超过当前生命节点。唯一被动——外塔成长：攻击力随时间成长（40秒起，每分钟提升，152→278封顶）。',
    descTemplate: '唯一被动——加固城防：外塔拥有三个生命节点33%/67%/100%，生命恢复不会超过当前生命节点。唯一被动——外塔成长：攻击力随时间成长（152→278）。',
    mergedSkills: ['passive_outer_fortify', 'passive_growth_outer'],
    effects: [], onEquip: () => {},
  },
  core_tier_inner: {
    id: 'core_tier_inner', name: '内侧防御塔', icon: '🏯', category: 'core',
    description: '唯一被动——加固城防：内塔拥有三个生命节点33%，67%，100%，生命恢复不会超过当前生命节点。唯一被动——内塔成长：攻击力随时间成长（3分钟起，170→305封顶；16分钟起双抗成长）。',
    descTemplate: '唯一被动——加固城防：内塔拥有三个生命节点33%/67%/100%，生命恢复不会超过当前生命节点。唯一被动——内塔成长：攻击力随时间成长（170→305），16分钟起双抗成长。',
    mergedSkills: ['passive_inner_fortify', 'passive_growth_inner'],
    effects: [], onEquip: () => {},
  },
  core_tier_base: {
    id: 'core_tier_base', name: '水晶防御塔', icon: '🏛️', category: 'core',
    description: '唯一被动——加固城防：水晶塔拥有三个生命节点33%，67%，100%，生命恢复不会超过当前生命节点。水晶防御塔获得2生命恢复。唯一被动——水晶塔成长：攻击力随时间成长（3分钟起，170→305封顶）。',
    descTemplate: '唯一被动——加固城防：水晶塔拥有三个生命节点33%/67%/100%，生命恢复不会超过当前生命节点；获得2生命恢复。唯一被动——水晶塔成长：攻击力随时间成长（170→305）。',
    mergedSkills: ['passive_base_fortify', 'passive_growth_base'],
    effects: [], onEquip: () => {},
  },
  core_tier_hq: {
    id: 'core_tier_hq', name: '枢纽防御塔', icon: '🏰', category: 'core',
    description: '唯一被动——加固城防：枢纽塔拥有三个生命节点40%，70%，100%，生命恢复不会超过当前生命节点。枢纽防御塔获得5生命恢复。唯一被动——枢纽塔成长：攻击力随时间成长（3分钟起，150→285封顶）。',
    descTemplate: '唯一被动——加固城防：枢纽塔拥有三个生命节点40%/70%/100%，生命恢复不会超过当前生命节点；获得5生命恢复。唯一被动——枢纽塔成长：攻击力随时间成长（150→285）。',
    mergedSkills: ['passive_hq_fortify', 'passive_growth_hq'],
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
