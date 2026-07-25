/**
 * SkillLibrary.js ? plugin-based skill registry.
 *
 * To add a new skill:
 *   1. Define it in the appropriate core/skills/ file.
 *   2. Register it with SkillLibrary.register(id, def).
 *   3. Done ? no other files need to change.
 *
 * Reading: SkillLibrary['weapon_piercing']  or  SkillLibrary.get('weapon_piercing')
 * Listing: Object.keys(SkillLibrary)
 */
import { renderSkillDescription, setSkillLookup } from './skills/_helpers.js';
import { core } from './skills/core.js';
import { weapons } from './skills/weapons.js';
import { towerPassives, TowerGrowthSkills, HomeAuraSkill } from './skills/towerPassives.js';
import { minionPassives } from './skills/minionPassives.js';
import { dragonSouls } from './skills/dragonSouls.js';

export const SkillLibrary = {
  _registry: new Map(),

  /** @param {string} id @param {object} def */
  register(id, def) {
    if (this._registry.has(id)) console.warn('SkillLibrary: overwriting "' + id + '"');
    this._registry.set(id, def);
    this[id] = def; // backward-compat property access
    return this;
  },
  get(id) { return this._registry.get(id); },
  has(id) { return this._registry.has(id); },
  ids() { return [...this._registry.keys()]; },
};

// Register all built-in skills
const allSkills = { ...core, ...weapons, ...towerPassives, ...TowerGrowthSkills,
  ...HomeAuraSkill, ...minionPassives, ...dragonSouls };
for (const [id, def] of Object.entries(allSkills)) {
  SkillLibrary.register(id, def);
}

// 身份技能的合并文案要现查子技能——此处回填延迟绑定的查表函数（直接 import 会成环）
setSkillLookup((id) => SkillLibrary.get(id));

// ==================== Q3：技能文案格式统一（用户定稿，同步写进设计文档）====================
// 统一格式：「唯一被动——名称：描述」。
// 在【注册这一处】统一补前缀，而不是去改四十来个字符串——后者只能保证"改的这一刻是齐的"，
// 以后任何人加技能都可能再写歪。这里做成注册期规范化，新技能自动合规。
// 已经带前缀的（含身份技能拼出来的合并文案）原样不动，避免叠成"唯一被动——X：唯一被动——Y："。
const _PREFIX = /^唯一被动——/;
for (const id of SkillLibrary.ids()) {
  const def = SkillLibrary.get(id);
  if (!def || !def.name) continue;
  for (const key of ['description', 'descTemplate']) {
    let raw;
    try { raw = def[key]; } catch (e) { continue; }
    if (typeof raw !== 'string' || !raw || _PREFIX.test(raw)) continue;
    // getter 定义的（合并文案/光环文案）已经带前缀，走不到这里；剩下的都是普通字符串字段
    const d = Object.getOwnPropertyDescriptor(def, key);
    if (d && d.get) continue;
    def[key] = `唯一被动——${def.name}：${raw}`;
  }
}

export { renderSkillDescription };
