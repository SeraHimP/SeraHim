/**
 * attackMode.js —— 单位"攻击方式"的唯一判定口。
 *
 * 用户（Q3）："所有单位的攻击方式都统一为4种（不再受攻击距离限制，目前仅设定4种，以后可能会有别的）：
 *   近战攻击——没有子弹速度，打出来就即时造成伤害，没有可视化弹道，攻击距离是多远就是多远；
 *   弹道攻击——走子弹速度，即使攻击距离为1也必须走弹道，弹道打在目标上才算造成伤害，有可视化弹道；
 *   光束型攻击（类似闪电杖）——持续伤害（每种武器定义不同），有持续光束但不吃子弹速度，目标进入射程就造成持续伤害；
 *   范围型伤害（类似腐蚀性武器）——有范围光环，不吃子弹速度。"
 *
 * 原来"近战还是远程"是按射程隐式判的（基础射程 ≤ MELEE_RANGE_THRESHOLD 算近战，巨龙特判），
 * 光束/范围是各把武器自己写的特例。现在每个单位模板（baseStats.attackMode）和每把塔武器
 * （武器定义上的 attackMode）显式声明，判定顺序：武器 > 单位自己 > 旧的射程推断（兜底，
 * 只给没声明的自制单位用，保证不声明时行为与改动前一致）。
 */
import { MELEE_RANGE_THRESHOLD } from '../data/Config.js';

export const ATTACK_MODES = ['melee', 'projectile', 'beam', 'area'];
export const ATTACK_MODE_LABELS = { melee: '近战', projectile: '弹道', beam: '光束', area: '范围' };

/** 这个单位装备的塔武器定义（没有则 null）。 */
function weaponDefOf(e, skills) {
  if (!skills) return null;
  const wi = e?._skillInstances?.find((s) => s.skillId && s.skillId.startsWith('weapon_') && !s._disabled);
  return wi ? skills[wi.skillId] || null : null;
}

/** 声明值 → 合法的攻击方式；不认识的值当作没声明。 */
const valid = (m) => (ATTACK_MODES.includes(m) ? m : null);

/**
 * @param e 实体
 * @param skills 技能库（可省略：省略时不看武器声明）
 * @returns 'melee' | 'projectile' | 'beam' | 'area'
 */
export function attackModeOf(e, skills = null) {
  if (!e) return 'melee';
  const w = weaponDefOf(e, skills);
  const fromWeapon = valid(w?.attackMode);
  if (fromWeapon) return fromWeapon;
  const own = valid(e.baseStats?.attackMode);
  if (own) return own;
  if (e.type === 'dragon') return 'melee';
  return (e.baseStats?.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD ? 'melee' : 'projectile';
}
