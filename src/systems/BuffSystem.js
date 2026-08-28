import { AttributeCalculator } from '../core/AttributeCalculator.js';
import { CONFIG } from '../data/Config.js';
import { enemyUnitsInRadius } from './FactionSystem.js';

export class BuffSystem {
  constructor(effectRegistry, entityContainer, eventBus, combatSystem) {
    this.effects = effectRegistry;
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.combat = combatSystem;
    this.timers = new Map();
  }

  /**
   * ==================== Q1：最大生命变化时，当前生命同步跟随 ====================
   * 用户："单位获得最大生命值时，只是获得了最大生命值而对应的生命值并未提升，
   *        比如 +500 最大生命值应该是对应的当前生命值也 +500，否则没意义。"
   *
   * 原实现错在哪：`maxHP` 是 AttributeCalculator 每帧从 baseStats + 效果**算出来**的，
   * 而 `currentHP` 是实体上的一个裸字段，两者之间**没有任何联系**。
   * 全仓库只有三处把 currentHP 往下钳（编辑器、削肉、治疗封顶），
   * 一处往上补的都没有 —— 于是 +500 最大生命的效果只是把血条的分母改大了，
   * 血量百分比反而下降，"加血上限"变成了"变相扣血"。
   *
   * 为什么放在 BuffSystem 而不是 AttributeCalculator：
   * calc() 是**纯查询**，一帧之内会被各系统调用几十次（还带缓存），
   * 在里面改实体状态会让"调用次数"决定"扣多少血"—— 那是最难查的一类 bug。
   * 这里每帧扫一遍、只做一次，是唯一权威的同步点。
   *
   * 对称性（用户定稿"对称扣且可致死"）：最大生命下降时当前生命同样扣，扣到 0 就死。
   * 这与「过载」把最大生命削到 0 来结束对局的设计一致（那条现在就能致死）。
   * 代价是"增益一掉就可能暴毙"，这是用户明确接受的表现。
   */
  _syncMaxHP(entity, effs) {
    const cfg = (CONFIG.gameRules && CONFIG.gameRules.maxHPSync) || {};
    if (cfg.enabled === false) return;
    const maxHP = AttributeCalculator.calc(entity, effs).maxHP;
    if (!Number.isFinite(maxHP)) return;
    const prev = entity._lastMaxHP;
    entity._lastMaxHP = maxHP;
    // 首次见到这个实体：只记基准，不补差。否则新生成的单位会凭空多/少一截血。
    if (prev === undefined) return;
    const delta = maxHP - prev;
    if (delta === 0) return;
    entity.currentHP = Math.min(maxHP, (entity.currentHP || 0) + delta);
    if (entity.currentHP <= 0 && entity.alive) {
      if (cfg.lethal === false) { entity.currentHP = 1; return; }
      entity.currentHP = 0;
      entity.alive = false;
      this.eventBus?.emit?.('entity:death', { entityId: entity.id });
    }
  }

  update(dt) {
    for (const entity of this.entities.getAll(true)) {
      const effs = this.effects.getEffects(entity.id);
      this._syncMaxHP(entity, effs);
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
            // v51.1：dotBasis:'currentHP' 的 DOT（蚀骨兵的环刃毒雾）按目标【当前】生命的
            // 百分比结算，不是固定数值——basisValue 逐帧读、随目标掉血自然衰减，这与
            // "每层攻击力1%"那类固定值 DOT（走 totalFlat）是两条不同的公式，谁也不该
            // 冒充谁。totalPercent 已经在 EffectRegistry.apply() 那一刻吃过一次技能增幅，
            // 这里只是把它套到"当前生命"这个每帧都在变的基数上，不是重新缩放。
            const dmg = eff.blueprint.dotBasis === 'currentHP'
              ? entity.currentHP * (eff.totalPercent || 0) / 100
              : (eff.totalFlat || 0);
            const type = eff.blueprint.damageType || 'magic';
            // Bug 修复：这里以前直接传 eff.sourceId ——sourceId 是 'dragonsoul_poison'
            // 这种字符串标签，从来查不到实体，效果等同于"这一下没有攻击者"，会让
            // DOT 杀死巨龙时算不进任何一方的击杀数。casterId 才是真正施加这份 DOT
            // 的实体 id（见 EffectRegistry.apply 的 casterId 选项）；没有的话（比如
            // 老存档、或者哪天真出现无来源的环境 DOT）才退回 0，保留原来的兜底。
            // v51：basicAttack:true——这份 DOT 的数值在 EffectRegistry.apply() 那一刻
            // 就已经吃过一次技能增幅了（casterId 触发的那条自动缩放），这里只是把
            // 预先算好的伤害逐帧兑现，不能再让 performAttackDirect 重复缩放一次。
            this.combat.performAttackDirect(eff.casterId ?? 0, entity.id, dmg, type, { basicAttack: true });
            // ==================== v50：带半径的 DOT（灼烧圈）====================
            // 用户（熔魂定稿）："灼烧效果是有半径的，可以对其他单位造成伤害"
            //                  + "跟着中毒目标走"。
            // 做成 **DOT 蓝图的一个通用字段**而不是熔魂专属代码：这里本来就是
            // "每 interval 秒结算一次这条 DOT"的唯一地方，圈的中心天然就是持有者的
            // 当前位置 —— "跟着目标走"不需要额外维护任何东西。
            // 以后任何 DOT 想变成范围 DOT，加一个 auraRadius 就行。
            const R = eff.blueprint.auraRadius || 0;
            if (R > 0 && entity.pos) {
              const caster = this.entities.get(eff.casterId);
              // 敌我按**施加者**算：圈是他放的，不该因为附着在谁身上而改变敌我。
              const probe = { id: entity.id, pos: entity.pos, alive: true,
                _mapFaction: caster?._mapFaction || caster?.faction || null,
                faction: caster?.faction || null };
              for (const other of enemyUnitsInRadius(this.entities, probe, R)) {
                // v51：半径 DOT 打到的"其他人"是群体命中，吸血按 vampGroup 折扣。
                this.combat.performAttackDirect(eff.casterId ?? 0, other.id, dmg, type,
                  { basicAttack: true, vampGroup: true });
              }
            }
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