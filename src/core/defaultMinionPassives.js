/**
 * defaultMinionPassives.js —— 小兵"出厂默认被动/主动技能"清单的唯一来源。
 *
 * v51.5：审查现有技能时发现这份表在 factories.js（真正被 createMinion 消费）
 * 和 ui/editor/pagesSkillEffect.js（编辑器"模板技能面板首次打开"的回填用）
 * 里各写了一份，且早就漂移了——v51/v51.1 加的四条主动技能（active_siege_haste/
 * active_totem_shield/active_warlock_empower/active_corrupt_poison）以及
 * warlock 的 passive_warlock_attune、图腾兵重做后的 passive_totem_mend/
 * passive_totem_bulwark，都只进了 factories.js 那份，编辑器那份从未跟上。
 * 症状：模板编辑器第一次打开图腾兵的"被动技能"页时，勾选框显示的默认装配
 * 是重做前的老三件套（guardian/awaken/nourish），而游戏里实际生成的图腾兵
 * 装的是新三件套 + 主动技能——面板显示的"默认值"与游戏里的真实默认值对不上。
 * 现在两处改成读同一份。
 */
export const DEFAULT_MINION_PASSIVES = {
  'melee': ['passive_melee_rend'],
  'ranged': ['passive_ranged_rend'],
  // v51.1：主动技能改成用户给的精确规格（active_siege_haste 等，见 actives.js 头注），
  // 推翻 v51 那版占位的 active_siege_barrage。
  'siege': ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend', 'active_siege_haste'],
  'super': ['passive_super_commander'],
  // v49 攻城车重做：一条被动拆成三条（攻城炮=常驻闸门，另两条是两个模式）。
  // atkmode_charge 是**攻击方式**技能（与塔的武器同一形状），充能的全部参数在它身上。
  'ram': ['passive_ram_cannon', 'passive_ram_siege', 'passive_ram_normal', 'atkmode_charge'],
  // 三个支援兵种（用户定稿重做）。v51.5：旧的 totem_guardian/awaken/nourish/sacrifice
  // 已经从 SkillLibrary 里整个删除（不再是"可手动装但不默认装"，是真的不存在了）。
  'totem': ['passive_totem_aura', 'passive_totem_mend', 'passive_totem_bulwark', 'active_totem_shield'],
  'warlock': ['passive_warlock_aura', 'passive_warlock_attune', 'active_warlock_empower'],
  'corrupt': ['passive_corrupt_strike', 'active_corrupt_poison'],
};
