/**
 * GameEvents.js ? canonical event type constants.
 *
 * Every event emitted through EventBus MUST use one of these constants.
 * This makes cross-system communication discoverable and refactor-safe.
 *
 * Usage:
 *   import { EVT } from '../core/GameEvents.js';
 *   this.eventBus.emit(EVT.ENTITY_DEATH, { entityId: e.id });
 *   this.eventBus.on(EVT.ENTITY_DEATH, ({ entityId }) => { ... });
 */

export const EVT = {
  // ---- Entity lifecycle ----
  ENTITY_SPAWN:               'entity:spawn',
  ENTITY_DEATH:               'entity:death',

  // ---- Combat / damage ----
  DAMAGE_DEALT:               'damage:dealt',

  // ---- Buffs / effects ----
  EFFECT_APPLIED:             'effect:applied',
  EFFECT_EXPIRED:             'effect:expired',

  // ---- Dragon ----
  DRAGON_SPAWN:               'dragon:spawn',
  DRAGON_KILLED:              'dragon:killed',
  DRAGON_SOUL_UNLOCKED:       'dragon:soulUnlocked',

  // ---- Map / buildings ----
  MAP_LOADED:                 'map:loaded',
  MAP_NEXUS_DESTROYED:        'map:nexusDestroyed',
  MAP_NEXUS_RESPAWNED:        'map:nexusRespawned',
  MAP_MAIN_NEXUS_DESTROYED:   'map:mainNexusDestroyed',

  // ---- Waves ----
  WAVE_START:                 'wave:start',

  // ---- Weather ----
  WEATHER_TOGGLED:            'weather:toggled',
};

export default EVT;
