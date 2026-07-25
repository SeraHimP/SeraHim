import { makeAuraPassive, AURA_THROTTLE, AURA_DURATION } from './_helpers.js';
import { CONFIG } from '../../data/Config.js';

// "小兵单位"判定：塔和巨龙不算，其余（含超级兵与沙盒大型兵）都算。
const isMinionUnit = (e) => e && e.type !== 'tower' && e.type !== 'dragon';

function _makeRendPassive(casterType, name, pct) {
  const id = `passive_${casterType}_rend`;
  return {
    [id]: {
      id, name, icon: '🩸', category: 'passive',
      // 有 defaultParams 才会被 CombatSystem 注入 map.skillOverrides —— 数值与机制都能按地图改
      defaultParams: { pct, base: 'template' },
      // 文案与结算共用同一份参数解析（_resolve），不许两边各写一套 —— 见 ARCHITECTURE.md
      //「技能文案规范」。基数模式变了，文案里的"自身当前生命 / 基础生命"也跟着变。
      _resolve: function(instance) {
        var cfg = (CONFIG.rend && CONFIG.rend[casterType]) || {};
        var p = (instance && instance._params && instance._params.pct != null) ? instance._params.pct
              : (cfg.pct != null ? cfg.pct : pct);
        var m = (instance && instance._params && instance._params.base) || cfg.base || 'template';
        return { pct: p, base: m };
      },
      _text: function(instance) {
        var r = this._resolve(instance);
        var disp = parseFloat((r.pct * 100).toFixed(2));
        var src = r.base === 'current' ? '自身当前生命' : '自身基础生命';
        return '唯一被动——' + name + '：攻击小兵单位额外造成（【{val}】=' + src + '×' + disp +
               '%）伤害（类型同自身普攻，对防御塔/巨龙无效）。';
      },
      get description() { return this._text(null); },
      get descTemplate() { return this._text(null); },
      computeCurrent: function(entity) {
        var inst = (entity._skillInstances || []).find(function(i) { return i.skillId === id; });
        var r = this._resolve(inst);
        var baseHP = r.base === 'current'
          ? (entity.currentHP || 0)
          : (((CONFIG.templates || {})[casterType] || {}).maxHP || (entity.baseStats || {}).maxHP || 0);
        return Math.round(baseHP * r.pct);
      },
      effects: [],
      // v42: dynamic descTemplate for per-map override（地图改了 pct/base，文案立刻跟着改）
      getDescTemplate: function(entity, instance) { return this._text(instance); },
      onHit: (attackerId, targetId, instance, ctx) => {
        const attacker = ctx.entityContainer.get(attackerId);
        const target = ctx.entityContainer.get(targetId);
        if (!attacker || !target || !target.alive) return;
        if (attacker.type !== casterType) return;   // 防止技能被错误装到其他兵种
        if (!isMinionUnit(target)) return;          // 只对小兵单位，不打塔/龙
        // 伤害基数（Q2 定稿，见 CONFIG.rend 的长注释）：
        //   'template' = 该兵种【模板基础生命】，不随波次成长膨胀 —— 现行默认
        //   'current'  = 攻击者当前生命（旧行为，地图可切回）
        // 改因：旧的 'current' 让屠戮与生命同步膨胀，兵杀兵所需时间永远恒定 14.4s，
        // 两波兵总在半个波次周期内互相清完、永远聚不起来，高地就永远推不动。
        // 取模板基础生命后，前期占比依旧很高（"加快前期互殴"的初衷保留），
        // 后期随生命成长自然稀释，波次开始堆叠，防御塔参与的时间也随之变长。
        const cfg = (CONFIG.rend && CONFIG.rend[casterType]) || {};
        const effectivePct = instance._params?.pct ?? cfg.pct ?? pct;
        const mode = instance._params?.base ?? cfg.base ?? 'template';
        const baseHP = mode === 'current'
          ? (attacker.currentHP || 0)
          : ((CONFIG.templates?.[casterType]?.maxHP) || attacker.baseStats?.maxHP || 0);
        const bonus = baseHP * effectivePct;
        if (bonus <= 0 || !ctx.combat) return;
        ctx.combat.performAttackDirect(attackerId, targetId, bonus,
          attacker.baseStats?.attackType || 'physical', { _noProc: true });
      },
    },
  };
}

export const minionPassives = {
  ...{}, // v39：攻城车被动在文件末尾定义后合并（见 ramPassive）
  passive_artillery_commander: makeAuraPassive({
    id: 'passive_artillery_commander', name: '炮兵指挥官', icon: '📯',
    casterType: 'siege', targetTypes: ['melee', 'ranged', 'siege', 'super', 'totem'],
    minWave: 20, // 默认装配门槛：炮车第20波起才【默认装备】此技能（20波前默认不装、不显示）；
                 // 光环本身不再按波次拦截——玩家手动装备的任何波次都生效。装配逻辑见 main.js createMinion。
    effectsFn: () => [
      { name: '炮兵指挥官', icon: '📯', kind: 'stat', statKey: 'armor', flatValue: 20, description: '护甲+20' },
      { name: '炮兵指挥官', icon: '📯', kind: 'stat', statKey: 'magicResist', flatValue: 20, description: '魔抗+20' },
    ],
  }),

  passive_super_commander: makeAuraPassive({
    id: 'passive_super_commander', name: '超级兵指挥官', icon: '📯',
    casterType: 'super', targetTypes: ['melee', 'ranged', 'siege', 'super', 'totem'],
    // 指挥官光环只惠及【周围的小兵】，不含自身（用户最新确认；此前 includeSelf:true 让
    // 超级兵自己也吃 17% 减伤+1 回复，等于凭空多一层自增益）。
    // 注意：另一个超级兵仍在其 targetTypes 内 —— 两个超级兵互相给对方加成是正常的，
    // 被排除的只有"给自己加"。炮兵指挥官走 makeAuraPassive 的默认 includeSelf=false，本就正确。
    includeSelf: false,
    effectsFn: () => [
      { name: '超级兵指挥官', icon: '📯', kind: 'stat', statKey: 'damageReduction', flatValue: 17, description: '伤害减免+17%' },
      { name: '超级兵指挥官', icon: '📯', kind: 'stat', statKey: 'healthRegen', flatValue: 1, description: '生命恢复+1' },
    ],
  }),

  passive_siege_shield: {
    id: 'passive_siege_shield',
    name: '防御护盾',
    icon: '🛡️',
    category: 'passive',
    description: '受防御塔/炮兵/超级兵的伤害降低30%。',
    descTemplate: '唯一被动——防御护盾：受到防御塔/炮兵/超级兵的伤害降低30%。（用户定稿：新增炮兵来源）',
    // 实现在 CombatSystem 的减免段（伤害来源需要判断攻击者类型，效果系统的
    // stat 管线只看防御方自身、拿不到攻击来源，所以这类"条件减伤"必须挂引擎钩子）。
    // CombatSystem 通过 _hasSkill(target, 'passive_siege_shield') 识别，此处仅作定义与展示。
    effects: [],
  },

  // ==================== 兵对兵百分比伤害被动（缩短兵线互耗，让塔更多参战）====================
  // 规则：只对"小兵单位"生效（塔与巨龙除外），伤害类型与攻击者的普攻类型一致，
  // 走正常减免管线（物理被护甲减免、魔法被魔抗减免）。
  // 时序说明：onHit 在主伤害结算之后触发，因此百分比基于"扣完主伤害后的当前生命"——
  // 略弱于先算被动再算主伤害的顺序，属可接受偏差，好处是不侵入主伤害公式。
  // _noProc 防止该额外伤害再次触发 onHit 造成递归。
  ..._makeRendPassive('melee',  '近战屠戮', 0.04),  // 用户定稿：近/远/炮 = 4/6/7
  ..._makeRendPassive('ranged', '远程屠戮', 0.06),  // 用户定稿：6%
  ..._makeRendPassive('siege',  '炮火屠戮', 0.07), // 用户定稿：7%

  passive_totem_guardian: {
    id: 'passive_totem_guardian',
    name: '图腾守护',
    icon: '🗿',
    category: 'passive',
    description: '每10秒对75内友军施加300临时护盾。',
    descTemplate: '唯一被动——图腾守护：每10秒对75范围内友军施加300临时护盾。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.cooldown = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive || entity.type !== 'totem') return;
      const state = instance.state;
      state.cooldown -= dt;
      if (state.cooldown <= 0) {
        state.cooldown = 10;
        const allies = ctx.entityContainer.findInRadius(entity.pos.x, entity.pos.y, 75,
          ['melee', 'ranged', 'siege', 'super', 'totem'], true);
        for (const ally of allies) {
          ctx.effectRegistry.apply(ally.id, {
            name: '图腾守护',
            icon: '🗿',
            kind: 'custom',
            duration: 10,
            stackable: false,
            stackPolicy: 'refresh',
            customData: { shieldAmount: 300 },
            description: '获得300临时护盾',
          }, `totem_guardian_${entityId}`);
        }
      }
    },
  },

  passive_totem_awaken: {
    id: 'passive_totem_awaken',
    name: '图腾觉醒',
    icon: '✨',
    category: 'passive',
    description: '第15波觉醒，获得觉醒状态。',
    descTemplate: '唯一被动——图腾觉醒：登场时永久强化自身。',
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive || entity.type !== 'totem') return;
      if (ctx.waveNumber >= 15 && !instance.state?.awakened) {
        instance.state = instance.state || {};
        instance.state.awakened = true;
        ctx.effectRegistry.apply(entityId, {
          name: '图腾觉醒',
          icon: '✨',
          kind: 'custom',
          duration: Infinity,
          permanent: true,
          stackable: false,
          customData: { awakened: true },
          description: '已觉醒',
        }, 'passive_totem_awaken');
      }
    },
  },

  passive_totem_nourish: {
    id: 'passive_totem_nourish',
    name: '图腾滋养',
    icon: '🌿',
    category: 'passive',
    description: '获得（2%×波数）治疗与护盾强度，上限100%。',
    descTemplate: '唯一被动——图腾滋养：为周围友军提供治疗与护盾强度光环。',
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive || entity.type !== 'totem') return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      instance.state.timer += dt;
      if (instance.state.timer < AURA_THROTTLE) return;
      instance.state.timer = 0;
      const bonus = Math.min((ctx.waveNumber || 0) * 2, 100);
      if (bonus > 0) {
        ctx.effectRegistry.apply(entityId, {
          name: '图腾滋养',
          icon: '🌿',
          kind: 'stat',
          statKey: 'healShieldPowerPct',
          flatValue: bonus,
          duration: AURA_DURATION,
          stackable: false,
          stackPolicy: 'refresh',
          uniquePassive: true,
          description: `治疗护盾强度+${bonus}%`,
        }, 'passive_totem_nourish');
      }
    },
  },

  passive_totem_aura: makeAuraPassive({
    id: 'passive_totem_aura', name: '图腾光环', icon: '🟣',
    casterType: 'totem', targetTypes: ['melee', 'ranged', 'siege', 'super', 'totem'],
    includeSelf: true,
    effectsFn: (ally, ctx, waveNumber) => {
      const list = [
        { name: '图腾光环', icon: '🟣', kind: 'stat', statKey: 'allStatsPct', flatValue: 3, description: '全属性+3%' },
      ];
      if (waveNumber >= 10) {
        list.push({ name: '图腾光环', icon: '🟣', kind: 'stat', statKey: 'attackRange', flatValue: 10, description: '射程+10' });
        list.push({ name: '图腾光环', icon: '🟣', kind: 'stat', statKey: 'damageReduction', flatValue: 33, description: '减伤+33%' });
      }
      return list;
    },
  }),

  passive_totem_sacrifice: {
    id: 'passive_totem_sacrifice',
    name: '图腾献祭',
    icon: '🩸',
    category: 'passive',
    description: '每次攻击消耗2%当前生命值；每秒额外损失已损生命值（最大生命-当前生命）的1%。',
    descTemplate: '唯一被动——图腾献祭：攻击消耗（【{val}】=当前生命×2%），每秒损失已损生命值×1%（残血越多掉血越快）。',
    computeCurrent: (entity, ctx) => Math.round((entity.currentHP || 0) * 0.02),
    effects: [],
    onEquip: (entityId, instance, ctx) => { if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 }; },
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const entity = ctx.entityContainer.get(attackerId);
      if (!entity || !entity.alive) return;
      const cost = entity.currentHP * 0.02;
      entity.currentHP = Math.max(0, entity.currentHP - cost);
      if (entity.currentHP <= 0) { entity.alive = false; ctx.eventBus.emit('entity:death', { entityId: attackerId }); }
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      instance.state.timer += dt;
      if (instance.state.timer < 1) return;
      instance.state.timer -= 1;
      const maxHP = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entityId)).maxHP || 1;
      const lostHP = Math.max(0, maxHP - entity.currentHP);
      const drain = lostHP * 0.01;
      if (drain > 0) {
        entity.currentHP = Math.max(0, entity.currentHP - drain);
        if (entity.currentHP <= 0) { entity.alive = false; ctx.eventBus.emit('entity:death', { entityId }); }
      }
    },
  },

  // ==================== 新大型小兵光环/被动 ====================
  passive_warlock_aura: makeAuraPassive({
    id: 'passive_warlock_aura', name: '术法光环', icon: '🧙',
    casterType: 'warlock', targetTypes: ['melee', 'ranged'],
    effectsFn: () => [
      { name: '术法光环', icon: '🧙', kind: 'stat', statKey: 'attackDamage', percentValue: 20, description: '攻击力+20%' },
      { name: '术法光环', icon: '🧙', kind: 'stat', statKey: 'magicPenFlat', flatValue: 15, description: '固定法穿+15' },
    ],
  }),

  passive_corrupt_strike: {
    id: 'passive_corrupt_strike',
    name: '蚀骨',
    icon: '🦇',
    color: '#6b8e23',
    category: 'passive',
    description: '蚀骨兵：攻击给塔叠加“腐蚀”，每层-2双抗，最多5层，持续5秒。',
    descTemplate: '唯一被动——蚀骨：攻击给塔叠加腐蚀，每层-2双抗，最多5层。',
    effects: [],
    onHit: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive || target.type !== 'tower') return;
      ctx.effectRegistry.apply(targetId, {
        name: '腐蚀', icon: '🦇', kind: 'stat', statKey: 'armor', type: 'debuff',
        flatValue: -2, perStackFlat: -2, duration: 5,
        stackable: true, maxStacks: 5, stackPolicy: 'stack', uniquePassive: true,
        descTemplate: '唯一被动——蚀骨：护甲降低（【{val}】=-2×层数），最多5层。',
        description: '护甲腐蚀（{stacks}/5层）',
      }, 'passive_corrupt_armor');
      ctx.effectRegistry.apply(targetId, {
        name: '腐蚀', icon: '🦇', kind: 'stat', statKey: 'magicResist', type: 'debuff',
        flatValue: -2, perStackFlat: -2, duration: 5,
        stackable: true, maxStacks: 5, stackPolicy: 'stack', uniquePassive: true,
        descTemplate: '唯一被动——蚀骨：魔抗降低（【{val}】=-2×层数），最多5层。',
        description: '魔抗腐蚀（{stacks}/5层）',
      }, 'passive_corrupt_mr');
    },
  },

};

// ============================================================================
// v39（Q4）：攻城车 · 唯一被动【攻城武器】
// 用户定稿规则全集：
//   ① 近战单位（射程 ≤ MELEE_RANGE_THRESHOLD=60）对攻城车伤害 +100%
//   ② 攻城车对小兵单位伤害 -33%
//   ③ 攻城车锁定某建筑后不再改目标，直到该建筑被摧毁或自己死亡
//   ④ 攻击建筑：攻速 -50%、对建筑伤害 +800%（=9倍）、每次攻击后自损 20% 最大生命
//   ⑤ 普攻带溅射（半径 60；溅射按普通伤害结算，不吃 +800%）
// 实现要点：①②④的伤害修正走 onIncoming/onOutgoing 钩子；③在 LaneMovementSystem 里
// 通过 _ramLockedTargetId 实现；④的攻速与自损在 CombatSystem 的攻城车分支处理。
// ============================================================================

const ramPassive = {
  passive_siege_weapon: {
    id: 'passive_siege_weapon', name: '攻城武器', icon: '🛠️', category: 'passive',
    color: '#7f8c8d',
    // v40：全部机制的【唯一】数值来源。CombatSystem / LaneMovementSystem 只在
    // 「单位装备了本被动」时才启用这些规则，并从这里读数——拆掉被动即退化为普通单位。
    TOWER_DAMAGE_MULT: 3.7,   // v40：对建筑 +270%（原 +800%）
    TOWER_ATKSPD_MULT: 0.5,   // 攻击建筑时攻速 -50%
    SELF_DAMAGE_PCT: 0.20,    // 每次攻击建筑自损 20% 最大生命
    VS_MINION_MULT: 0.67,     // 对小兵 -33%
    MELEE_BONUS_MULT: 2.0,    // 近战单位对它 +100%
    description: '唯一被动——攻城武器：锁定一座建筑后不再改变目标（直至其被摧毁或自身死亡），'
      + '锁定期间进入【攻城模式】；攻击建筑时攻速-50%、伤害+270%，但每次攻击自损20%最大生命。'
      + '对小兵伤害-33%，普攻带溅射。近战单位对攻城车的伤害+100%。',
    descTemplate: '唯一被动——攻城武器：锁定建筑后进入攻城模式（攻速-50%/对建筑伤害+270%/'
      + '每次攻击自损20%最大生命）；对小兵-33%；普攻溅射；受近战单位伤害+100%。',
    effects: [],
    onEquip: () => {},
    onUnequip: (entityId, instance, ctx) => {
      // 拆下被动：清掉攻城模式状态与锁定，单位立即退化为普通车
      const e = ctx.entityContainer.get(entityId);
      if (e) e._ramLockId = null;
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '攻城模式') ctx.effectRegistry.remove(eff.id);
      }
    },
    /**
     * 每帧维护【攻城模式】状态效果：锁定建筑期间常驻显示，脱离/死亡即消失。
     * 状态本身不改数值（数值在 CombatSystem 结算时按本被动的常量计算），
     * 它的职责是把"当前处于攻城模式、有哪些增减益"显式呈现在状态栏里。
     */
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const locked = e._ramLockId ? ctx.entityContainer.get(e._ramLockId) : null;
      const active = !!(locked && locked.alive);
      const has = ctx.effectRegistry.getEffects(entityId).some(x => x.blueprint.name === '攻城模式');
      if (active && !has) {
        ctx.effectRegistry.apply(entityId, {
          name: '攻城模式', icon: '🛠️', kind: 'display', type: 'buff',
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '已锁定建筑：攻速-50%、对建筑伤害+270%、每次攻击自损20%最大生命（目标不可更换）',
        }, 'passive_siege_weapon_mode');
      } else if (!active && has) {
        for (const eff of ctx.effectRegistry.getEffects(entityId)) {
          if (eff.blueprint.name === '攻城模式') ctx.effectRegistry.remove(eff.id);
        }
      }
    },
  },
};

Object.assign(minionPassives, ramPassive);
