/**
 * data/templates/index.js ? JSON template loader.
 *
 * Loads all unit templates from JSON files. Use as a drop-in replacement
 * for hardcoded template objects in Config.js or UnitTemplates.js.
 *
 * Usage:
 *   import { loadTemplates } from '../data/templates/index.js';
 *   const templates = await loadTemplates();
 *   console.log(templates.tower.maxHP); // 9000
 *
 * For non-async usage (browser):
 *   import templates from '../data/templates/tower.json' assert { type: 'json' };
 */

const TEMPLATE_FILES = [
  'tower', 'melee', 'ranged', 'siege', 'super',
  'totem', 'warlock', 'corrupt', 'ram',
];

export async function loadTemplates() {
  const result = {};
  for (const name of TEMPLATE_FILES) {
    const mod = await import('./' + name + '.json', { assert: { type: 'json' } });
    result[name] = mod.default;
  }
  return result;
}

export { TEMPLATE_FILES };
