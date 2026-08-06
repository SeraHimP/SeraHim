import { WORLD_SIZE, summoners_rift } from './summoners_rift.js';

/**
 * summoners_rift_quick.js - Quick Mode (15-minute games).
 * Every tower/minion stat and skill parameter is configurable per map.
 * This map inherits the summoners_rift layout (lanes, buildings, walls) via spread,
 * then overrides tierStats, minion templates, skill timings, wave rules.
 */
export const summoners_rift_quick = {
  ...summoners_rift,
  id: 'summoners_rift_quick_v2',
  label: 'Quick Mode',

  // ==================== Tower Stats (weakened for fast push) ====================
  tierStats: {
    outer:      { maxHP: 1750, armor: 15, magicResist: 15, attackDamage: 215, baseAttackSpeed: 0.833 },
    inner:      { maxHP: 2250, armor: 40, magicResist: 40, attackDamage: 240, baseAttackSpeed: 0.833 },
    base:       { maxHP: 3750, armor: 55, magicResist: 55, attackDamage: 240, baseAttackSpeed: 4.0 },
    nexus_lane: { maxHP: 2400 },
    hq_tower:   { maxHP: 2250, armor: 70, magicResist: 70, attackDamage: 215, baseAttackSpeed: 4.0 },
    nexus_main: { maxHP: 3300 },
  },

  // ==================== Minion Templates (+30% HP / +40% AD / +25% MS vs classic) ====================
  minionTemplates: {
    melee:   { maxHP: 650, attackDamage: 13, moveSpeed: 117 },
    ranged:  { maxHP: 260, attackDamage: 9,  moveSpeed: 117 },
    siege:   { maxHP: 1414, attackDamage: 25, moveSpeed: 117 },
    super:   { maxHP: 980, attackDamage: 38, moveSpeed: 117 },
    totem:   { maxHP: 195, attackDamage: 11, moveSpeed: 117 },
    warlock: { maxHP: 520, attackDamage: 28, moveSpeed: 117 },
    corrupt: { maxHP: 620, attackDamage: 25, moveSpeed: 117 },
    ram:     { maxHP: 800, attackDamage: 118, moveSpeed: 117 },
  },

  // ==================== Per-type Skill Parameter Overrides ====================
  skillOverrides: {
    // ---- Tower Growth: -50% wait time, -50% growth values ----
    'tower:outer': {
      passive_overload:   { startMin: 4, PHASE2_DELAY: 180 },
      passive_growth_outer: { adStartT: 20, stepAD: 4.5 },
    },
    'tower:inner': {
      passive_overload:   { startMin: 7, PHASE2_DELAY: 180 },
      passive_growth_inner: { adStartT: 90, stepAD: 4.5, resistGrowthStartT: 480 },
    },
    'tower:base': {
      passive_overload:   { startMin: 12, PHASE2_DELAY: 180 },
      passive_growth_base:  { adStartT: 90, stepAD: 4.5 },
    },
    'tower:hq_tower': {
      passive_overload:   { startMin: 20, PHASE2_DELAY: 180 },
      passive_growth_hq:    { adStartT: 90, stepAD: 4.5 },
    },
    // ---- Siege always has artillery commander (not wave-gated) ----
    'siege': {
      passive_artillery_commander: { minWave: 0 },
    },
  },

  // ==================== Skills to Exclude Per Entity Type ====================
  excludeSkills: {
    'tower:outer': ['passive_iron_line'],
    'tower:base':  ['passive_base_bulwark', 'passive_armor_plating'],
  },

  // ==================== Minion Default Passives (override hardcoded defaults) ====================
  minionDefaultPassives: {
    siege: ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend'],
  },

  // ==================== Wave Timing ====================
  waveInterval: 20,
  firstWaveDelay: 5,
  spawnGap: 0.55,
  nexusRespawnTime: 150,
};
