/**
 * GameContext.js ? centralized game state management.
 *
 * WRITE: CTX.gameTime = 5   (or main.js initializations)
 * READ:  window.gameTime    (all subsystems continue using window.*)
 *
 * Architecture rule:
 *   - CTX is the single source of truth for mutating game state.
 *   - window.* is auto-synced for backward compatibility.
 *   - New code should import CTX; old code can keep using window.*.
 */

// Internal state store
const _state = {
  gameTime: 0, waveNumber: 0, gamePaused: false, _uid: 0,
  _nextWaveTime: 20, __gameSpeed: 1, __ffRemain: 0,
  __showLanePaths: false, __gridOn: false, __terrainAvoid: true, __laneFlow: true,
  __towerRules: {
    invincible: { blue: false, red: false },
    attackOff:  { blue: false, red: false },
    waveOn:     { blue: true,  red: true  },
  },
  __towerRuleFor(kind, faction) {
    const r = this.__towerRules?.[kind];
    if (!r) return false;
    if (!faction) return r.blue || r.red;
    return !!r[faction];
  },
  createMinion: null, createTower: null,
  __app: null, __weather: null, __world: null, __mapSystem: null,
  __uiManager: null, __weatherPanel: null, __entityContainer: null,
  __perf: null, __score: null, __gameLoop: null,
  __three: null,   // v2.5D：Three 渲染器（设置面板的阴影档位入口）
};

export const CTX = {};

// Sync keys: writing to CTX.xxx also writes to window.xxx
const SYNC_KEYS = [
  'gameTime', 'waveNumber', 'gamePaused', '_uid', '_nextWaveTime',
  '__gameSpeed', '__ffRemain', '__showLanePaths', '__gridOn', '__terrainAvoid', '__laneFlow',
  '__towerRules', '__towerRuleFor',
  'createMinion', 'createTower',
  '__app', '__weather', '__world', '__mapSystem', '__uiManager', '__weatherPanel',
  '__entityContainer', '__perf', '__score', '__gameLoop',
  '__three',
];

for (const key of SYNC_KEYS) {
  Object.defineProperty(CTX, key, {
    get() {
      return (typeof window !== 'undefined') ? window[key] : _state[key];
    },
    set(v) {
      if (typeof window !== 'undefined') window[key] = v;
      _state[key] = v;
    },
    enumerable: true,
    configurable: true,
  });
}

// Initialize window.* with default values from _state
if (typeof window !== 'undefined') {
  for (const key of SYNC_KEYS) {
    if (window[key] === undefined) window[key] = _state[key];
  }
}

export default CTX;
