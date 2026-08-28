import { makeAuraPassive, AURA_THROTTLE, AURA_DURATION, AURA_RANGE } from './_helpers.js';
import { applyHeal, healPowerFor } from '../healing.js';
import { CONFIG } from '../../data/Config.js';

// "小兵单位"判定：塔和巨龙不算，其余（含超级兵与沙盒大型兵）都算。
const isMinionUnit = (e) => e && e.type !== 'tower' && e.type !== 'dragon';

/**
 * 屠戮的伤害【基数】。三种口径共用这一个函数 —— 文案（computeCurrent）与结算（onHit）
 * 必须读同一份，否则会出现"面板写 A、实际打 B"（ARCHITECTURE.md「技能文案规范」）。
 *
 *   'templateByHpPct'（用户定稿，现行默认）= 模板基础生命 × (当前生命 / 最大生命)
 *   'template'                             = 模板基础生命
 *   'current'                              = 自身当前生命
 *
 * 为什么是"模板基础生命 × 血量比例"而不是"当前生命"：见 CONFIG.rend 的长注释。
 * 一句话——基数用模板值所以不随波次成长膨胀，比例用当前血量所以残血兵打得软。
 * 满血时与 'template' 逐位相同。
 */
function _rendBase(entity, casterType, mode) {
  const tplHP = (CONFIG.templates?.[casterType]?.maxHP) || entity?.baseStats?.maxHP || 0;
  if (mode === 'current') return entity?.currentHP || 0;
  if (mode === 'template') return tplHP;
  const maxHP = entity?.baseStats?.maxHP || tplHP || 1;
  const frac = Math.max(0, Math.min(1, (entity?.currentHP || 0) / (maxHP || 1)));
  return tplHP * frac;
}

function _makeRendPassive(casterType, name, pct) {
  const id = `passive_${casterType}_rend`;
  return {
    [id]: {
      id, name, icon: '🩸', category: 'passive',
      // 屠戮技能是按施法者类型动态生成的（melee/ranged/siege 各一份），
      // applicableTypes 直接用 casterType——不用像别处那样手写三次。
      applicableTypes: [casterType],
      // 有 defaultParams 才会被 CombatSystem 注入 map.skillOverrides —— 数值与机制都能按地图改。
      //
      // ⚠️ 必须是 **getter**，从 CONFIG.rend 现取，不能写死一份副本。
      // 用户："屠戮的改动你实装了吗？为啥我看技能介绍还是没变？" —— 就是写死那份副本的锅：
      // CombatSystem 会把 defaultParams 整份拷进 inst._params，而 _resolve 里
      // `instance._params.base` 的优先级**高于** CONFIG.rend。于是把 CONFIG.rend 的
      // base 改成 templateByHpPct 之后，运行时读到的仍是这份副本里的 'template' ——
      // 数值配置改了、实际结算和面板文案都不跟着变。
      // 现在 CONFIG.rend 是唯一来源，编辑器改它（它就写这里）立刻贯通到出厂值这一层。
      get defaultParams() {
        const cfg = (CONFIG.rend && CONFIG.rend[casterType]) || {};
        return { pct: cfg.pct != null ? cfg.pct : pct, base: cfg.base || 'templateByHpPct' };
      },
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
        var src = r.base === 'current' ? '自身当前生命'
                : r.base === 'template' ? '自身基础生命'
                : '自身基础生命×当前生命比例';
        return '唯一被动——' + name + '：攻击小兵单位额外造成（【{val}】=' + src + '×' + disp +
               '%）伤害（类型同自身普攻，对防御塔/巨龙无效）。';
      },
      get description() { return this._text(null); },
      get descTemplate() { return this._text(null); },
      computeCurrent: function(entity) {
        var inst = (entity._skillInstances || []).find(function(i) { return i.skillId === id; });
        var r = this._resolve(inst);
        return Math.round(_rendBase(entity, casterType, r.base) * r.pct);
      },
      effects: [],
      // v42: dynamic descTemplate for per-map override（地图改了 pct/base，文案立刻跟着改）
      getDescTemplate: function(entity, instance) { return this._text(instance); },
      // procMode 用默认 'always'：屠戮自己独立算伤害基数（模板生命/当前生命），
      // 不读 ctx.totalRaw，且施放者都是普通兵种、恒为一次完整攻击，'always' 与
      // 'perAttack' 在这里表现完全相同——用默认值，不需要专门声明。
      onDealtDamage: (attackerId, targetId, instance, ctx) => {
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
        const mode = instance._params?.base ?? cfg.base ?? 'templateByHpPct';
        const bonus = _rendBase(attacker, casterType, mode) * effectivePct;
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
    applicableTypes: ['super'],
    casterType: 'super', targetTypes: ['melee', 'ranged', 'siege', 'super', 'totem'],
    // v43：改为**也对自己生效**（用户："所有光环类的效果也对自己生效，要不然太乱了逻辑"）。
    // 这里此前显式写了 includeSelf:false —— 那是更早一轮的定稿（"指挥官光环只惠及周围的小兵"）。
    // 现在统一口径，删掉这行、跟随 makeAuraPassive 的新默认值 true。
    effectsFn: () => [
      { name: '超级兵指挥官', icon: '📯', kind: 'stat', statKey: 'damageReduction', flatValue: 17, description: '伤害减免+17%' },
      { name: '超级兵指挥官', icon: '📯', kind: 'stat', statKey: 'healthRegen', flatValue: 1, description: '生命恢复+1' },
    ],
  }),

  passive_siege_shield: {
    id: 'passive_siege_shield',
    applicableTypes: ['siege'],
    name: '防御护盾',
    icon: '🛡️',
    category: 'passive',
    description: '受防御塔的伤害降低30%。',
    descTemplate: '唯一被动——防御护盾：受到【防御塔】的伤害降低30%。',
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
    applicableTypes: ['totem'],
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
    applicableTypes: ['totem'],
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
    applicableTypes: ['totem'],
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

  // ==================== 图腾兵（用户定稿重做）====================
  // 定位：续航 + 减伤。三件事拆成三个技能，各自单一职责：
  //   passive_totem_aura     减伤 + 固定护盾光环（自身也吃）
  //   passive_totem_mend     每 15 秒治疗自身与附近友军【已损生命】的 3%
  //   passive_totem_bulwark  自身高额固定护盾
  // targetTypes 传 null + minionsOnly：写死的类型数组【收不到自制兵种】，
  // 用户做出来的兵会拿不到光环，而这不报错、只是静默变弱。
  passive_totem_aura: makeAuraPassive({
    id: 'passive_totem_aura', name: '图腾守护', icon: '🟣',
    casterType: 'totem', targetTypes: null, minionsOnly: true,
    includeSelf: true,   // 与 v43 后的默认值一致，保留只为显式
    effectsFn: () => {
      const c = CONFIG.gameRules.supportUnits?.totem || {};
      const dr = c.auraDamageReduction ?? 10, sh = c.auraShieldFlat ?? 25;
      return [
        { name: '图腾守护', icon: '🟣', kind: 'stat', statKey: 'damageReduction',
          flatValue: dr, description: `伤害减免+${dr}%` },
        { name: '图腾守护', icon: '🟣', kind: 'stat', statKey: 'shieldFixedMax',
          flatValue: sh, description: `固定护盾+${sh}` },
      ];
    },
  }),

  // 治疗【已损生命】而不是最大生命：满血单位不会浪费掉一次治疗，
  // 残血单位越危险回得越多 —— 与 LoL 同类效果同口径。
  passive_totem_mend: {
    id: 'passive_totem_mend',
    applicableTypes: ['totem'],
    name: '图腾涌泉',
    icon: '💧',
    color: '#bb86fc',
    category: 'passive',
    _cfg: () => CONFIG.gameRules.supportUnits?.totem || {},
    _text() {
      const c = this._cfg();
      return `唯一被动——图腾涌泉：每 ${c.healIntervalSec ?? 15} 秒，为自身与 ${AURA_RANGE} 范围内的友军`
           + `恢复（【{val}】=各自【已损生命】×${c.healMissingPct ?? 3}%）生命。`;
    },
    get description() { return this._text(); },
    get descTemplate() { return this._text(); },
    computeCurrent(entity) {
      const c = this._cfg();
      const max = entity?.baseStats?.maxHP || 0;
      const missing = Math.max(0, max - (entity?.currentHP || 0));
      return Math.round(missing * (c.healMissingPct ?? 3) / 100);
    },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive || e.type !== 'totem') return;
      const c = CONFIG.gameRules.supportUnits?.totem || {};
      const every = c.healIntervalSec ?? 15;
      if (typeof instance.state?.mendT !== 'number') instance.state = { ...(instance.state || {}), mendT: 0 };
      instance.state.mendT += dt;
      // 容差 + 减掉一个周期保留余量：dt 是 1/30 这种二进制不精确的数，
      // 朴素的 `< every` 每个周期都会少触发一次，清 0 又会持续漂移（behaviorVM 里踩过）。
      if (instance.state.mendT < every - 1e-9) return;
      instance.state.mendT -= every;

      const pct = (c.healMissingPct ?? 3) / 100;
      const targets = ctx.entityContainer.findInRadius(e.pos.x, e.pos.y, AURA_RANGE, null, true);
      const ef = e._mapFaction || e.faction;
      let selfHealed = false;
      for (const a of targets) {
        if (a.type === 'tower' || a.type === 'dragon') continue;
        const af = a._mapFaction || a.faction;
        if (ef && af !== ef) continue;          // 沙盒无阵营则视为友方（与其它光环同口径）
        const max = a.baseStats?.maxHP || 0;
        const missing = Math.max(0, max - (a.currentHP || 0));
        if (missing <= 0) continue;             // 满血的不浪费
        // 强度取【被治疗方】的（见 core/healing.js 头注）：奶量不该由奶妈的属性决定，
        // 而且这样重伤才压得住"别人给我的治疗"。
        applyHeal(a, missing * pct, healPowerFor(a, ctx), max);
        if (a.id === e.id) selfHealed = true;
      }
      // 自身单独补一次：findInRadius 是否返回半径 0 处的查询者本身不该被依赖。
      // 用 selfHealed 去重，避免自己被治疗两次。
      if (!selfHealed) {
        const selfMax = e.baseStats?.maxHP || 0;
        const selfMissing = Math.max(0, selfMax - (e.currentHP || 0));
        applyHeal(e, selfMissing * pct, healPowerFor(e, ctx), selfMax);
      }
    },
  },

  // 自身高额固定护盾。走 onEquip 改 baseStats.shieldFixedMax 而不是挂一个 stat 效果：
  // 护盾上限是"这个单位有多厚"的固有属性，不是临时 buff；挂效果会在面板上
  // 混进一条永久状态，还会被治疗强化之类的百分比修正二次缩放。
  passive_totem_bulwark: {
    id: 'passive_totem_bulwark',
    applicableTypes: ['totem'],
    name: '图腾壁垒',
    icon: '🛡️',
    color: '#bb86fc',
    category: 'passive',
    _cfg: () => CONFIG.gameRules.supportUnits?.totem || {},
    _text() { return `唯一被动——图腾壁垒：自身获得（【{val}】=${this._cfg().selfShieldFlat ?? 900}）点固定护盾。`; },
    get description() { return this._text(); },
    get descTemplate() { return this._text(); },
    computeCurrent() { return this._cfg().selfShieldFlat ?? 900; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.baseStats) return;
      const v = CONFIG.gameRules.supportUnits?.totem?.selfShieldFlat ?? 900;
      instance.state = { ...(instance.state || {}), prevShield: e.baseStats.shieldFixedMax || 0 };
      e.baseStats.shieldFixedMax = (e.baseStats.shieldFixedMax || 0) + v;
      e.shieldFixedCurrent = e.baseStats.shieldFixedMax;   // 出场即满盾
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.baseStats) return;
      // 还原到装备前的值而不是"减掉 v"：v 可能在装备期间被改过，
      // 减法会留下残差（换一次技能就多/少一点盾，越换越偏）。
      if (typeof instance.state?.prevShield === 'number') {
        e.baseStats.shieldFixedMax = instance.state.prevShield;
        e.shieldFixedCurrent = Math.min(e.shieldFixedCurrent || 0, e.baseStats.shieldFixedMax);
      }
    },
  },

  passive_totem_sacrifice: {
    id: 'passive_totem_sacrifice',
    applicableTypes: ['totem'],
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
  // ==================== 术士兵（用户定稿重做）====================
  // 定位：增伤 + 破防。给友军双穿与伤害增幅，自身带高额双穿。
  //
  // 口径说明：用户写的是"13%固定双穿"/"70%固定双穿"，两个数都带 %，
  // 所以取【百分比穿透】（armorPenPercent / magicPenPercent），
  // 而不是固定穿透（armorPenFlat / magicPenFlat）—— 后者的单位是点数、不带 %。
  // 若本意是固定点数，改 CONFIG.gameRules.supportUnits.warlock 的 statKey 即可，
  // 数值本身已软编码。
  passive_warlock_aura: makeAuraPassive({
    id: 'passive_warlock_aura', name: '术法共鸣', icon: '🧙',
    casterType: 'warlock', targetTypes: null, minionsOnly: true,
    effectsFn: () => {
      const c = CONFIG.gameRules.supportUnits?.warlock || {};
      const pen = c.auraPenPct ?? 13, amp = c.auraDamageAmpPct ?? 7;
      return [
        { name: '术法共鸣', icon: '🧙', kind: 'stat', statKey: 'armorPenPercent',
          flatValue: pen, description: `护甲穿透+${pen}%` },
        { name: '术法共鸣', icon: '🧙', kind: 'stat', statKey: 'magicPenPercent',
          flatValue: pen, description: `法术穿透+${pen}%` },
        { name: '术法共鸣', icon: '🧙', kind: 'stat', statKey: 'damageAmpPct',
          flatValue: amp, description: `伤害增幅+${amp}%` },
      ];
    },
  }),

  // 自身双穿走【状态】而不是改 baseStats：用户明确说"自身拥有70%固定双穿（状态）"，
  // 而且做成状态后在属性面板里看得见，符合"所有修正都要可解释"这条。
  passive_warlock_attune: {
    id: 'passive_warlock_attune',
    applicableTypes: ['warlock'],
    name: '术法贯通',
    icon: '🔮',
    color: '#8e44ad',
    category: 'passive',
    _cfg: () => CONFIG.gameRules.supportUnits?.warlock || {},
    _text() { return `唯一被动——术法贯通：自身获得（【{val}】=${this._cfg().selfPenPct ?? 70}%）护甲穿透与法术穿透。`; },
    get description() { return this._text(); },
    get descTemplate() { return this._text(); },
    computeCurrent() { return this._cfg().selfPenPct ?? 70; },
    effects: [],
    // 用 aura 机制常驻（无倒计时环、不会闪），每帧节流刷新一次即可。
    // 不用 permanent 效果是因为改了配置要能立刻跟上，permanent 只在装备那一刻算一次。
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive || e.type !== 'warlock') return;
      if (typeof instance.state?.t !== 'number') instance.state = { ...(instance.state || {}), t: 0 };
      instance.state.t += dt;
      if (instance.state.t < AURA_THROTTLE) return;
      instance.state.t = 0;
      const pen = CONFIG.gameRules.supportUnits?.warlock?.selfPenPct ?? 70;
      for (const key of ['armorPenPercent', 'magicPenPercent']) {
        ctx.effectRegistry.apply(entityId, {
          name: '术法贯通', icon: '🔮', kind: 'stat', statKey: key,
          flatValue: pen, aura: true, auraGrace: 1.0,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `${key === 'armorPenPercent' ? '护甲' : '法术'}穿透+${pen}%`,
          descTemplate: `唯一被动——术法贯通：${key === 'armorPenPercent' ? '护甲' : '法术'}穿透+${pen}%。`,
        }, 'passive_warlock_attune_' + key);
      }
    },
  },

  // ==================== 蚀骨兵（用户定稿重做）====================
  // 改为【近战】、血量高于普通近战（数值在 CONFIG.templates.corrupt），
  // 并对小范围内所有敌人施加双抗削弱 —— 且"叠层直满层"：一次施加即满层，
  // 不用靠平A慢慢叠。做成敌对光环而不是 onHit，因为它的语义是"站在附近就被腐蚀"，
  // 与"打到才叠"完全不同（原实现是 onHit 且只对塔生效）。
  passive_corrupt_strike: {
    id: 'passive_corrupt_strike',
    applicableTypes: ['corrupt'],
    name: '蚀骨',
    icon: '🦇',
    color: '#6b8e23',
    category: 'passive',
    _cfg: () => CONFIG.gameRules.supportUnits?.corrupt || {},
    _text() {
      const c = this._cfg();
      return `唯一被动——蚀骨：${c.radius ?? 110} 范围内的所有敌人每 ${c.stackIntervalSec ?? 1} 秒`
           + `叠加一层腐蚀，每层降低 ${c.resistPerStack ?? 1} 点护甲与魔抗，`
           + `最多 ${c.maxStacks ?? 30} 层（【{val}】=最高 -${(c.resistPerStack ?? 1) * (c.maxStacks ?? 30)} 双抗）；`
           + `离开范围后逐层消退。`;
    },
    get description() { return this._text(); },
    get descTemplate() { return this._text(); },
    computeCurrent() {
      const c = this._cfg();
      return (c.resistPerStack ?? 1) * (c.maxStacks ?? 30);
    },
    effects: [],
    // 为什么不用 makeAuraPassive：
    // 光环是"在范围内常驻、离开即脱落"的**存在型**效果（aura:true 会把时长设为 Infinity
    // 并靠宽限期移除），而这里要的是【逐秒累积、离开后逐层过期】—— 层数必须能自然衰减。
    // 两者的时长语义相反，硬套 aura 就会变成"进范围瞬间满层、出范围瞬间清零"。
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive || e.type !== 'corrupt') return;
      const c = CONFIG.gameRules.supportUnits?.corrupt || {};
      const every = c.stackIntervalSec ?? 1;
      if (typeof instance.state?.tick !== 'number') instance.state = { ...(instance.state || {}), tick: 0 };
      instance.state.tick += dt;
      // 容差 + 减掉一个周期保留余量：dt 是 1/30 这种二进制不精确的数，
      // 朴素的 `< every` 每个周期都少触发一次，清 0 又会持续漂移（behaviorVM 里踩过）。
      if (instance.state.tick < every - 1e-9) return;
      instance.state.tick -= every;

      const per = c.resistPerStack ?? 1;
      const mx = c.maxStacks ?? 30;
      const dur = c.stackDurationSec ?? 3;
      const ef = e._mapFaction || e.faction;
      const foes = ctx.entityContainer.findInRadius(e.pos.x, e.pos.y, c.radius ?? 110, null, true);
      for (const t of foes) {
        if (t.id === e.id || t.type === 'dragon') continue;
        const tf = t._mapFaction || t.faction;
        // 沙盒模式没有阵营：一个 debuff 都不发（给"所有人"上 debuff 显然不是本意）
        if (!ef || !tf || tf === ef) continue;
        for (const [key, label] of [['armor', '护甲'], ['magicResist', '魔抗']]) {
          ctx.effectRegistry.apply(t.id, {
            name: '腐蚀', icon: '🦇', kind: 'stat', statKey: key, type: 'debuff', color: '#6b8e23',
            flatValue: -per, perStackFlat: -per,
            // 单层时长 > 叠加间隔：否则上一层在下一层叠上来之前就过期，永远停在 1 层。
            duration: dur,
            stackable: true, maxStacks: mx, stackPolicy: 'stack', uniquePassive: true,
            stackKey: `corrupt_${key}`,
            description: `${label}降低（{stacks}/${mx} 层，每层 -${per}）`,
            descTemplate: `唯一被动——蚀骨：${label}降低（【{val}】=-${per}×层数），最多 ${mx} 层。`,
          }, 'passive_corrupt_' + key);
        }
      }
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
  // ==================== v49：攻城车重做（旧 passive_siege_weapon 已整个删除）====================
  // 用户定稿："攻城车原有的全部删除，按照我新的来做。"
  //
  // 删掉的是：对建筑 +270% / 攻速 -50% / 对小兵 -33%（旧写法）/ 近战对它 +100% /
  //          攻城疲惫 -25% 每层 / 破甲重击 10% 当前生命 900 秒冷却。
  // 一条都不保留 —— 这几项的常量原来还挂在技能对象上，违反"数值必须软编码进 Config"，
  // 新的三条被动全部从 CONFIG.gameRules.ram 读数。
  //
  // 保留的只有**接线**（用户单独确认过）：锁定一座建筑后不改目标、索敌优先塔。
  // 那两件事是红线与状态栏显示的唯一依据，删了会连带把显示一起弄没。
  //
  // 为什么拆成三个技能而不是一个：用户就是按三条描述的，技能栏也该显示三格。
  // 【攻城炮】是常驻闸门（判模式、给溅射半径），另外两条是两个模式各自的效果。

  // ---- 被动 1：攻城炮 ----
  passive_ram_cannon: {
    id: 'passive_ram_cannon', name: '攻城炮', icon: '🎯', category: 'passive',
    applicableTypes: ['ram'], color: '#7f8c8d',
    get description() {
      const R = CONFIG.gameRules?.ram || {};
      return `唯一被动——攻城炮：攻击带溅射（攻城模式半径 ${R.siegeSplash ?? 75}，普通模式半径 ${R.normalSplash ?? 25}）。`
        + '攻击防御塔时进入【攻城模式】，攻击其他单位时进入【普通模式】；锁定一座建筑后不再改变目标，索敌优先防御塔。';
    },
    get descTemplate() { return this.description; },
    effects: [],
    onUnequip: (entityId, instance, ctx) => {
      // 拆下闸门 = 退化成普通车：锁定、模式状态、充能、疲惫层全部清掉
      const e = ctx.entityContainer.get(entityId);
      if (e) { e._ramLockId = null; e._ramMode = null; e._charge = 0; }
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        const n = eff.blueprint.name;
        if (n === '攻城模式' || n === '普通模式' || n === '攻城疲惫' || n === '轻装行军' || n === '充能') ctx.effectRegistry.remove(eff.id);
      }
    },
    /**
     * 每帧维护三件事：模式判定 → 状态栏显示 → 普通模式下的攻速恢复。
     *
     * 模式的唯一判据是【当前锁定/攻击的目标是不是防御塔】。
     * 用户定稿："攻城车在攻击防御塔时进入攻城模式。攻击其他单位时进入普通模式。"
     */
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const R = CONFIG.gameRules?.ram || {};
      const locked = e._ramLockId ? ctx.entityContainer.get(e._ramLockId) : null;
      const tgt = (locked && locked.alive) ? locked
                : (e.targetId ? ctx.entityContainer.get(e.targetId) : null);
      const siege = !!(tgt && tgt.alive && tgt.type === 'tower');
      e._ramMode = siege ? 'siege' : 'normal';

      // ---- 状态栏：两个模式都要显示（用户："别忘了在状态栏里要显示攻城模式/普通模式"）----
      const want = siege ? '攻城模式' : '普通模式';
      const gone = siege ? '普通模式' : '攻城模式';
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === gone) ctx.effectRegistry.remove(eff.id);
      }
      const has = ctx.effectRegistry.getEffects(entityId).some(x => x.blueprint.name === want);
      if (!has) {
        ctx.effectRegistry.apply(entityId, siege ? {
          name: '攻城模式', icon: '🏰', kind: 'display', type: 'buff', color: '#e67e22',
          duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
          // ⚠️ 这里**不重复具体数值**。数值写在【攻城模式】那条被动的描述里（技能栏可见），
          // 状态栏这一格只说"现在处于哪个模式、会发生什么"。
          // 状态描述里出现的每个数字都要能在**本技能**的文案里找到（sim_skilldesc 的规矩），
          // 而这些数字属于另外两条被动 —— 写在这儿只会让那条断言红，且信息是重复的。
          description: '正在攻击防御塔：对塔改为充能攻击、溅射范围更大；攻城疲惫持续累积且本模式下不恢复',
        } : {
          name: '普通模式', icon: '🚚', kind: 'display', type: 'buff', color: '#7f8c8d',
          duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
          description: '正在攻击非建筑目标：普通攻击、溅射范围较小、伤害降低；攻城疲惫逐步恢复',
        }, 'passive_ram_cannon_mode');
      }

      // ---- 充能进度状态（用户："状态栏里应该有个带进度的状态表示充能进度"）----
      // 装了任何【攻击方式】技能（目前只有充能）才挂这一格；
      // 进度由 progressOf 现算，不往效果里写数 —— 效果系统没有"每帧刷新一个数值"的通道，
      // 硬写会变成每帧 apply 一次（图标闪烁 + 点不中，本项目踩过）。
      const charging = (e._skillInstances || []).some(i => i.skillId === 'atkmode_charge' && !i._disabled);
      const hasChg = ctx.effectRegistry.getEffects(entityId).some(x => x.blueprint.name === '充能');
      if (charging && !hasChg) {
        ctx.effectRegistry.apply(entityId, {
          name: '充能', icon: '🔋', kind: 'display', type: 'buff', color: '#f6c94a',
          duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
          description: '蓄力中：充满才打出一发；被打断时逐秒衰减',
          // 状态栏的进度环读它（UIManager._updateEffectIcons）。
          progressOf: (u) => (u && u._charge) || 0,
        }, 'passive_ram_cannon_charge');
      } else if (!charging && hasChg) {
        for (const eff of ctx.effectRegistry.getEffects(entityId)) {
          if (eff.blueprint.name === '充能') ctx.effectRegistry.remove(eff.id);
        }
      }

      // ---- 攻速恢复：**只在普通模式下**（用户特别强调过）----
      if (siege) { instance.state = instance.state || {}; instance.state.recT = 0; return; }
      instance.state = instance.state || {};
      instance.state.recT = (instance.state.recT || 0) + dt;
      const per = R.recoverSec ?? 3;
      while (instance.state.recT >= per) {
        instance.state.recT -= per;
        const eff = ctx.effectRegistry.getEffects(entityId).find(x => x.blueprint.name === '攻城疲惫');
        if (!eff) { instance.state.recT = 0; break; }
        eff.stacks -= (R.recoverLayers ?? 1);
        if (eff.stacks <= 0) ctx.effectRegistry.remove(eff.id);
        else { ctx.effectRegistry._recalcEffectValues(eff); ctx.effectRegistry._updateDescription(eff); }
      }
    },
  },

  // ---- 被动 2：攻城模式 ----
  passive_ram_siege: {
    id: 'passive_ram_siege', name: '攻城模式', icon: '🏰', category: 'passive',
    applicableTypes: ['ram'], color: '#e67e22',
    get description() {
      const R = CONFIG.gameRules?.ram || {};
      return `唯一被动——攻城模式：对防御塔造成 ${R.siegeDamagePct ?? 700}% 伤害。`
        + `每次攻击叠 ${R.fatiguePerAttack ?? 7} 层`
        + `【攻城疲惫】（每层攻速 ${R.fatigueLayerPct ?? -1}%，无上限叠加），攻城模式下**不恢复**。`
        + `充能被打断时每秒衰减当前充能的 ${CONFIG.tuning?.charge?.decayPctPerSec ?? 10}%。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
  },

  // ---- 被动 3：普通模式 ----
  passive_ram_normal: {
    id: 'passive_ram_normal', name: '普通模式', icon: '🚚', category: 'passive',
    applicableTypes: ['ram'], color: '#7f8c8d',
    get description() {
      const R = CONFIG.gameRules?.ram || {};
      return `唯一被动——普通模式：攻击非建筑目标时溅射半径 ${R.normalSplash ?? 25}、`
        + `伤害增幅 ${R.normalDamageAmpPct ?? -33}%、攻速 +${R.normalAtkSpeedPct ?? 33}%；`
        + `每 ${R.recoverSec ?? 3} 秒恢复 ${R.recoverLayers ?? 1} 层【攻城疲惫】。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    /**
     * 普通模式的 +33% 攻速。挂在**本条被动自己**身上而不是【攻城炮】里：
     * sim_skilldesc 的规矩是"状态里出现的数字必须能在**本技能**的文案里找到"，
     * 而 33 属于这一条 —— 写在攻城炮里就成了"别人的效果挂着我的数字"。
     * 模式由攻城炮判定并写在 e._ramMode 上，这里只读不判，避免两处各判一次。
     *
     * ⚠️ 走 baseAttackSpeed 的百分比而不是 bonusAttackSpeedPct：攻城车的攻速收益率是 0.05，
     * 正向加成要打 5% 的折（33% 只剩 1.65%），那样这条加成基本等于没有。
     * baseAttackSpeed 不过收益率，+33% 就是实打实的 +33%。
     */
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const R = CONFIG.gameRules?.ram || {};
      const normal = (e._ramMode || 'normal') !== 'siege';
      const cur = ctx.effectRegistry.getEffects(entityId).find(x => x.blueprint.name === '轻装行军');
      if (normal && !cur) {
        ctx.effectRegistry.apply(entityId, {
          name: '轻装行军', icon: '💨', kind: 'stat', color: '#7f8c8d', type: 'buff',
          statKey: 'baseAttackSpeed', percentValue: R.normalAtkSpeedPct ?? 33,
          duration: Infinity, permanent: true,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `普通模式：攻速 +${R.normalAtkSpeedPct ?? 33}%`,
        }, 'passive_ram_normal_as');
      } else if (!normal && cur) {
        ctx.effectRegistry.remove(cur.id);
      }
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '轻装行军') ctx.effectRegistry.remove(eff.id);
      }
    },
  },
};

Object.assign(minionPassives, ramPassive);
