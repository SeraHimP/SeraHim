import { CONFIG } from '../data/Config.js';

export class WaveSystem {
  constructor(entityContainer, eventBus) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.config = CONFIG.gameRules;
    this.waveNumber = 0;
    this.nextWaveTime = this.config.firstWaveDelay || 20;
    this.paused = false;
    this.createMinion = null;
  }

  setCreateMinion(fn) {
    this.createMinion = fn;
  }

  setMapSystem(ms) {
    this.mapSystem = ms;
  }

  update(dt) {
    if (this.paused) return;
    if (this.mapSystem && this.mapSystem.active) return; // v42: don't run in battle mode
    this.nextWaveTime -= dt;
    if (this.nextWaveTime <= 0) {
      this.spawnWave();
      this.nextWaveTime = this.config.waveInterval || 45;
    }
  }

  spawnWave() {
    this.waveNumber++;
    window.waveNumber = this.waveNumber;
    const n = this.waveNumber;

    const { hpFixedPerWave, hpCompPctPerWave, attrFixedPerWave, attrCompPctPerWave } = this.config;
    const hpScale = (1 + hpFixedPerWave / 100 * n) * Math.pow(1 + hpCompPctPerWave / 100, n);
    const attrScale = (1 + attrFixedPerWave / 100 * n) * Math.pow(1 + attrCompPctPerWave / 100, n);

    const types = [];
    const meleeCount = this.config.waveMeleeCount || 3;
    const rangedCount = this.config.waveRangedCount || 3;
    const siegeInterval = this.config.waveSiegeSuperInterval || 2;
    const superFromWave = this.config.waveSuperFromWave || 20;
    const totemInterval = this.config.waveTotemInterval || 5;

    // v33 Q4：各兵种"是否生成"总开关（模板编辑器→生成规则）
    const en = this.config.spawnEnabled || {};
    const on = (t) => en[t] !== false;
    if (on('melee')) for (let i = 0; i < meleeCount; i++) types.push('melee');
    if (on('ranged')) for (let i = 0; i < rangedCount; i++) types.push('ranged');
    if (n % siegeInterval === 0) {
      const t = n >= superFromWave ? 'super' : 'siege';
      if (on(t)) types.push(t);
    }
    if (n % totemInterval === 0 && on('totem')) types.push('totem');
    // 特殊兵种前期不生成，中后期才登场（门槛可在模板编辑器的"生成规则"里调整）
    const warlockMinWave = this.config.warlockMinWave ?? 12;
    const corruptMinWave = this.config.corruptMinWave ?? 15;
    if (n >= warlockMinWave && n % (this.config.waveWarlockInterval || 6) === 0 && on('warlock')) types.push('warlock');
    if (n >= corruptMinWave && n % (this.config.waveCorruptInterval || 7) === 0 && on('corrupt')) types.push('corrupt');

    const spawnX = 820;
    const baseY = 400;
    const spacing = 25;

    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const x = spawnX + Math.random() * 20 - 10;
      const y = baseY + (i - (types.length - 1) / 2) * spacing + Math.random() * 16 - 8;

      if (this.createMinion) {
        this.createMinion(type, x, y, hpScale, attrScale);
      } else {
        // 降级方案
        console.warn('WaveSystem: createMinion 未注入');
        const tpl = CONFIG.templates[type];
        if (!tpl) continue;
        const entity = {
          id: ++window._uid,
          type: type,
          alive: true,
          pos: { x, y },
          baseStats: { ...tpl },
          currentHP: tpl.maxHP * hpScale,
          shieldFixedCurrent: (tpl.shieldFixedMax || 0) * hpScale,
          tempShield: 0,
          lastDamageTime: -Infinity,
          attackCooldown: 0,
          targetId: null,
          _skillInstances: [],
          _inCombat: false,
          _attackerCount: 0,
        };
        entity.baseStats.attackDamage = tpl.attackDamage * attrScale;
        entity.baseStats.armor = tpl.armor * attrScale;
        entity.baseStats.magicResist = tpl.magicResist * attrScale;
        entity.baseStats.onHitDamage = (tpl.onHitDamage || 0) * attrScale;
        entity.baseStats.shieldFixedMax = (tpl.shieldFixedMax || 0) * hpScale;
        entity.baseStats.healthRegen = tpl.healthRegen * attrScale;
        entity.baseStats.moveSpeed = tpl.moveSpeed || 30;
        entity.baseStats.attackRange = tpl.attackRange || 20;
        this.entities.add(entity);
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('wave:start', { waveNumber: n });
    }
  }

  skipToNextWave() {
    this.nextWaveTime = 0;
  }
}