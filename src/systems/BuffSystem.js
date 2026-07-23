export class BuffSystem {
  constructor(effectRegistry, entityContainer, eventBus, combatSystem) {
    this.effects = effectRegistry;
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.combat = combatSystem;
    this.timers = new Map();
  }

  update(dt) {
    for (const entity of this.entities.getAll(true)) {
      const effs = this.effects.getEffects(entity.id);
      for (const eff of effs) {
        if (eff.blueprint.kind === 'dot' && eff.remainingTime > 0) {
          const interval = eff.blueprint.tickInterval || 1;
          if (!this.timers.has(eff.id)) {
            this.timers.set(eff.id, { timer: 0, interval });
          }
          const timer = this.timers.get(eff.id);
          timer.timer += dt;
          if (timer.timer >= interval) {
            timer.timer -= interval;
            const dmg = eff.totalFlat || 0;
            const type = eff.blueprint.damageType || 'magic';
            this.combat.performAttackDirect(eff.sourceId || 0, entity.id, dmg, type);
          }
        } else {
          if (this.timers.has(eff.id) && eff.remainingTime <= 0) {
            this.timers.delete(eff.id);
          }
        }
      }
    }
    for (const [id] of this.timers) {
      if (!this.effects.getEffect(id)) {
        this.timers.delete(id);
      }
    }
  }
}