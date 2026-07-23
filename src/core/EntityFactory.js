/**
 * EntityFactory.js — creates entity objects from templates.
 *
 * @typedef {object} Entity
 * @property {number} id
 * @property {string} type
 * @property {boolean} alive
 * @property {{x:number,y:number}} pos
 * @property {object} baseStats
 * @property {number} currentHP
 * @property {number} attackCooldown
 * @property {number|null} targetId
 * @property {string} state
 * @property {number[]} effectIds
 * @property {object} _skillStates
 * // Movement state (LaneMovementSystem)
 * @property {boolean} [_anchored]
 * @property {boolean} [_offPath]
 * @property {number} [_laneWaypointIndex]
 * @property {{x:number,y:number}} [_steerDir]
 * @property {number} [_retargetAt]
 * @property {number} [_chaseLastD]
 * @property {number} [_lockUntil]
 * @property {number} [_stuckT]
 * @property {number|null} [_detourSide]
 * @property {number} [_detourUntil]
 * // Faction / lane (MapSystem)
 * @property {string} [_mapFaction]
 * @property {string} [_laneId]
 * @property {string} [_laneDirection]
 * // Rules / respawn
 * @property {number} [_respawnAt]
 * @property {boolean} [_stateProtected]
 * @property {boolean} [_stateInvincible]
 * // Siege weapon
 * @property {number|null} [_ramLockId]
 * // Template editor
 * @property {string[]} [_templateSkills]
 * 
 * All `_`-prefixed properties are set by their respective systems at runtime.
 * Do NOT set them manually in EntityFactory — they are not part of the template.
 */

import { UnitTemplates } from '../config/UnitTemplates.js';

let _nextId = 1;

export class EntityFactory {
  /**
   * 创建实体
   * @param {string} type - 实体类型，如 'tower', 'melee'
   * @param {object} options - 额外选项
   * @param {number} options.x - 初始X位置
   * @param {number} options.y - 初始Y位置
   * @param {number} options.waveScale - 波次缩放（用于小兵）
   * @param {object} options.overrideStats - 覆盖基础属性
   * @returns {object} 实体对象
   */
  static create(type, options = {}) {
    const template = UnitTemplates[type];
    if (!template) {
      throw new Error(`Unknown entity type: ${type}`);
    }

    const id = _nextId++;
    const baseStats = { ...template };
    
    // 应用波次缩放（如果有）
    const waveScale = options.waveScale || 1.0;
    if (waveScale !== 1.0) {
      // 缩放生命、攻击、护甲等
      const scaleKeys = ['maxHP', 'attackDamage', 'armor', 'magicResist', 'onHitDamage', 'shieldFixedMax', 'healthRegen'];
      for (const key of scaleKeys) {
        if (baseStats[key] !== undefined) {
          baseStats[key] *= waveScale;
        }
      }
    }

    // 覆盖属性
    if (options.overrideStats) {
      Object.assign(baseStats, options.overrideStats);
    }

    const entity = {
      id,
      type,
      alive: true,
      pos: { x: options.x || 0, y: options.y || 0 },
      baseStats: baseStats,
      currentHP: baseStats.maxHP,
      shieldFixedCurrent: baseStats.shieldFixedMax || 0,
      tempShield: 0,
      skillInstanceIds: [],
      effectIds: [],
      attackCooldown: 0,
      targetId: null,
      state: 'idle',
      // 技能特定状态（按需添加）
      _skillStates: {},
    };

    return entity;
  }
}
