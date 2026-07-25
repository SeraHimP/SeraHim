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
import { renderSkillDescription } from './skills/_helpers.js';
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

export { renderSkillDescription };
