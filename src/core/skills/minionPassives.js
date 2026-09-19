import { makeAuraPassive, AURA_THROTTLE } from './_helpers.js';
import { CONFIG } from '../../data/Config.js';
import { healPowerFor, applyHeal } from '../healing.js';
import { alliesInRadius } from '../../systems/FactionSystem.js';

// "小兵单位"判定：塔和巨龙不算，其余（含超级兵等大型兵）都算。
const isMinionUnit = (e) => e && e.type !== 'tower' && e.type !== 'dragon';

// 秒数→分钟数文案，去掉整分钟时多余的".0"（同 towerPassives.js 的 _fmtMin，
// 各自模块内一份小函数，没必要为这一行专门抽公共模块）。
function _fmtGrowMin(sec) {
  const m = sec / 60;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

/**
 * 屠戮的伤害【基数】。三种口径共用这一个函数 —— 文案（computeCurrent）与结算（onHit）
 * 必须读同一份，否则会出现"面板写 A、实际打 B"（ARCHITECTURE.md「技能文案规范」）。
 *
 *   'current'（v51.30 回调，现行默认）      = 攻击者自身当前生命
 *   'templateByHpPct'（v51.27~v51.29 曾用） = 模板基础生命 × (当前生命 / 最大生命)
 *   'template'                              = 模板基础生命
 *
 * 三种口径为什么会来回换、这次为什么又换回来：见 CONFIG.rend 的长注释（四段演变史）。
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
        return { pct: cfg.pct != null ? cfg.pct : pct, base: cfg.base || 'current' };
      },
      // 文案与结算共用同一份参数解析（_resolve），不许两边各写一套 —— 见 ARCHITECTURE.md
      //「技能文案规范」。基数模式变了，文案里的"自身当前生命 / 基础生命"也跟着变。
      _resolve: function(instance) {
        var cfg = (CONFIG.rend && CONFIG.rend[casterType]) || {};
        var p = (instance && instance._params && instance._params.pct != null) ? instance._params.pct
              : (cfg.pct != null ? cfg.pct : pct);
        var m = (instance && instance._params && instance._params.base) || cfg.base || 'current';
        return { pct: p, base: m };
      },
      _text: function(instance) {
        var r = this._resolve(instance);
        var disp = parseFloat((r.pct * 100).toFixed(2));
        var src = r.base === 'current' ? '自身当前生命'
                : r.base === 'template' ? '自身基础生命'
                : '自身基础生命×当前生命比例';
        return '唯一被动——' + name + '：攻击小兵单位额外造成（{val}=' + src + '×' + disp +
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
        // 伤害基数模式演变史见 CONFIG.rend 的长注释——v51.30 回调回 'current'
        // （攻击者自身当前生命 × pct），天然跟着 battleGrowth 一起涨，解决"后期一大批
        // 成长过的兵，屠戮伤害占比低到不痛不痒"这个问题；代价是可能重新出现"清波时间
        // 恒定、波次容易堆叠"的旧现象，用户已确认接受这个取舍。
        const cfg = (CONFIG.rend && CONFIG.rend[casterType]) || {};
        const effectivePct = instance._params?.pct ?? cfg.pct ?? pct;
        const mode = instance._params?.base ?? cfg.base ?? 'current';
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
      { name: '炮兵指挥官', icon: '📯', kind: 'stat', statKey: 'magicResist', flatValue: 20, description: '魔法抗性+20' },
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

  // ==================== Q5：超级兵早弱晚强（出生时按游戏时间快照）====================
  // 用户："超级兵弄成前期非常弱……防止极端情况下超级兵直接早期终结比赛（但实际上
  // 不太可能），让超级兵的基础数值随时间的流逝变得越来越强。" 起因：超级兵现在
  // 数值是常量，不随游戏时间变化，"水晶陷落后立刻满状态出场"是提前终结比赛的漏洞
  // （laneWaveComposition 里 super 的触发条件是 nexusDown，与游戏时间无关）。
  // 做法：在超级兵【出生那一刻】按当前 window.gameTime 快照一个 allStatsPct 修正
  // ——游戏时间越晚出生的超级兵越强，倍率在出生那一刻定死，不随这个单位之后存活
  // 多久变化（超级兵通常活不长，"随自身存活时间成长"没有意义，用户要的是"整局
  // 游戏进程"这个尺度）。倍率曲线：0分钟出生=40%基础数值，线性爬升到15分钟=100%
  // （即完全体），15分钟后继续缓慢增长，每分钟再+1.5%，封顶150%（防止后期无限
  // 膨胀）。全部软编码进 CONFIG.gameRules.superGrowth，占位起始值，下一轮平衡验证。
  passive_super_timescale: {
    id: 'passive_super_timescale', name: '战线洗礼', icon: '⏳', category: 'passive',
    applicableTypes: ['super'],
    get description() {
      const g = CONFIG.gameRules?.superGrowth || {};
      return `出生时按当前游戏时间快照全属性倍率：0分钟=${g.minMulPct ?? 40}%，`
        + `${_fmtGrowMin(g.fullAtSec ?? 900)}分钟起达到100%（完全体），之后每分钟再`
        + `+${g.lateGrowPerMinPct ?? 1.5}%，封顶${g.lateCapPct ?? 150}%（倍率出生时定死，不随自身存活时长变化）。`;
    },
    get descTemplate() { return this.description; },
    computeCurrent: (entity) => (entity?._timescaleMulPct != null ? Math.round(entity._timescaleMulPct) : 100),
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e) return;
      const g = CONFIG.gameRules?.superGrowth || {};
      const minMulPct = g.minMulPct ?? 40;
      const fullAtSec = g.fullAtSec ?? 900;
      const lateGrowPerMinPct = g.lateGrowPerMinPct ?? 1.5;
      const lateCapPct = g.lateCapPct ?? 150;
      const t = Math.max(0, (typeof window !== 'undefined' ? (window.gameTime || 0) : 0));
      let mulPct;
      if (t < fullAtSec) mulPct = minMulPct + (100 - minMulPct) * (t / fullAtSec);
      else mulPct = Math.min(lateCapPct, 100 + ((t - fullAtSec) / 60) * lateGrowPerMinPct);
      e._timescaleMulPct = mulPct;   // 供 computeCurrent 展示读取，不参与结算
      const delta = mulPct - 100;    // allStatsPct 是"相对基准的加成量"，基准=0
      ctx.effectRegistry.apply(entityId, {
        name: '战线洗礼', icon: '⏳', kind: 'stat', statKey: 'allStatsPct',
        flatValue: delta, duration: Infinity, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `全属性${delta >= 0 ? '+' : ''}${Math.round(delta)}%（出生时游戏时间定死）`,
      }, 'passive_super_timescale');
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) delete e._timescaleMulPct;
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '战线洗礼') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // ==================== Q5：重装车——对建筑额外伤害 ====================
  // 用户给的规格："攻击一般（对塔有额外伤害）。"数值刻意给得比攻城车（对塔+550%）
  // 温和很多——重装车的存在意义是"坦着挨打、吸引塔火力"，这条只是坦着打的副产物，
  // 不能抢攻城车"专职破塔"的定位。跟屠戮系被动同一个结算方式（onDealtDamage 里
  // 用这一下的原始伤害 ctx.totalRaw 算一笔额外伤害，走 performAttackDirect）。
  passive_heavy_vs_tower: {
    id: 'passive_heavy_vs_tower', name: '破城锤', icon: '🔨', category: 'passive',
    applicableTypes: ['heavy'],
    get defaultParams() {
      const c = CONFIG.gameRules.supportUnits?.heavy || {};
      return { bonusVsTowerPct: c.bonusVsTowerPct ?? 60 };
    },
    get description() {
      const p = this.defaultParams;
      return `对防御塔造成的伤害额外 +${p.bonusVsTowerPct}%。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive || target.type !== 'tower') return;
      const p = instance._params || minionPassives.passive_heavy_vs_tower.defaultParams;
      const bonus = (ctx.totalRaw || 0) * ((p.bonusVsTowerPct ?? 60) / 100);
      if (bonus <= 0 || !ctx.combat) return;
      ctx.combat.performAttackDirect(attackerId, targetId, bonus,
        ctx.attackType || 'physical', { basicAttack: false, _noProc: true });
    },
  },

  // ==================== Q5：治疗兵——"友方目标"底层架构落地的第一个消费者 ====================
  // 用户定稿："无对敌方攻击能力，但是每次攻击会对友军造成治疗效果（按攻速节奏、
  // 类似攻击的固定节奏脉冲，不是主动技能触发），每次治疗损失固定生命值+百分比当前
  // 生命值；脱战后拥有高额生命值回复。"
  //
  // 架构决策（2026-09-19，与用户对齐过）：治疗脉冲走【独立通道】而不是把索敌目标
  // 换成敌方攻击那套"索敌+追击+锁定+弹道飞行"的完整管线——后者要深改
  // LaneMovementSystem 的接敌AI 和 CombatSystem.performAttack 的伤害结算分支，
  // 工作量大、还可能牵连现有近战/远程兵的战斗手感。这里复用 passive_totem_mend
  // 已经验证过的"按帧节流的周期性效果"范式，只是：
  //   ① 找目标从 findInRadius 换成新增的 alliesInRadius（FactionSystem.js，
  //      与 enemyUnitsInRadius 对称，这就是用户要的"目标阵营"通用开关本体，
  //      以后的奶塔直接复用这一个函数，不是治疗兵的特例代码）；
  //   ② 节流间隔从固定的 AURA_THROTTLE 改成【按攻速算的攻击间隔】，才是"类似
  //      攻击的固定节奏"，不是图腾涌泉那种"持续常驻"的光环感；
  //   ③ 只打附近【最近的一个】友军（不比较血量高低——"单位不做决策，只机械
  //      触发"是这轮新兵种的共同前提，见 docs/Q5-BALANCE-UNITS-TOWERS-REDESIGN.md
  //      §三开头），不是智能优先救最缺血的那个；
  //   ④ 治疗兵自己也扣血（固定+百分比当前生命），且只有【真的回复到了】（目标
  //      没满血）才扣，不然站在一堆满状态友军旁边会被白白放血，很反直觉。
  // 弹道视觉：不经过 CombatSystem 的伤害/弹道管线，改走一个独立的 'heal:pulse'
  // 事件，渲染层订阅这个事件自己生成一条专属治疗弹道特效（GroundTraceLayer/
  // WeatherLayer 那种"系统算数据、渲染层订阅事件画特效"分层已经是本仓库的既有
  // 约定，这里照抄，不是新发明一层）。
  passive_healer_mend: {
    id: 'passive_healer_mend', name: '生命脉冲', icon: '💗', category: 'passive',
    applicableTypes: ['healer'], color: '#e07ab0',
    get description() {
      const c = CONFIG.gameRules.supportUnits?.healer || {};
      const r = c.range ?? 180, base = c.healBase ?? 15, ap = c.apScalePct ?? 30;
      const flat = c.selfCostFlat ?? 4, pct = c.selfCostPctCurrentHP ?? 3;
      const regen = c.outOfCombatRegenBonus ?? 8;
      return `按自身攻速节奏，向半径 ${r} 内最近的友军治疗（{val}=${base}+${ap}%×法术强度）点，`
        + `自身代价为 ${flat}+${pct}%当前生命值；脱战后额外获得 +${regen}/秒 生命回复。`;
    },
    get descTemplate() { return this.description; },
    computeCurrent: (entity, ctx) => {
      const c = CONFIG.gameRules.supportUnits?.healer || {};
      const base = c.healBase ?? 15, apPct = (c.apScalePct ?? 30) / 100;
      const stats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      return Math.round((base + apPct * (stats.abilityPower || 0)) * 10) / 10;
    },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return;
      const c = CONFIG.gameRules.supportUnits?.healer || {};

      // 脱战高额回复：与"这一帧是否正在治疗"完全独立判断，每帧都刷新/续期，
      // 不受下面的攻速节流影响——否则脱战判定会被治疗节奏带偏。
      if (!self._inCombat) {
        const bonus = c.outOfCombatRegenBonus ?? 8;
        if (bonus > 0) {
          ctx.effectRegistry.apply(entityId, {
            aura: true, auraGrace: 0.5, name: '静养', icon: '💤', kind: 'stat',
            statKey: 'healthRegen', flatValue: bonus,
            stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: `脱战恢复：生命回复 +${bonus}/秒`,
          }, 'passive_healer_mend_regen');
        }
      }

      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const finalAS = ctx.attrCalc.calcAttackSpeedOf(stats);
      if (!(finalAS > 0)) return;
      // ⚠️ 不能写成 `instance.state || (instance.state = { timer: 0 })`——技能实例
      // 创建时 state 通常已经是一个空对象 `{}`（真值，不会走到 `||` 的右边），
      // 于是 st.timer 是 undefined，`st.timer += dt` 算出 NaN，`NaN < interval`
      // 恒为 false，节流形同虚设（每帧都会触发）。必须显式判断 timer 是不是数字
      // （同 passive_totem_mend 的写法，同一个坑之前已经踩过一次）。
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      const st = instance.state;
      st.timer += dt;
      const interval = 1 / finalAS;
      if (st.timer < interval) return;
      st.timer -= interval;

      const range = c.range ?? 180;
      const allies = alliesInRadius(ctx.entityContainer, self, range);
      if (!allies.length) return; // 附近没有友军可治，这一脉冲空转，不扣自身血

      // 机械选择"最近"，不比较血量——符合本轮"不做决策"的设计前提。
      let target = null, bestD = Infinity;
      for (const a of allies) {
        const d = (a.pos.x - self.pos.x) ** 2 + (a.pos.y - self.pos.y) ** 2;
        if (d < bestD) { bestD = d; target = a; }
      }
      if (!target) return;

      const base = c.healBase ?? 15, apPct = (c.apScalePct ?? 30) / 100;
      const amount = base + apPct * (stats.abilityPower || 0);
      const healed = applyHeal(target, amount, healPowerFor(target, ctx),
        target.baseStats?.maxHP ?? target.currentHP, target._regenCapHP);
      if (!(healed > 0)) return; // 目标已满血：这次脉冲没有真的生效，不收自身代价

      const flat = c.selfCostFlat ?? 4, pct = (c.selfCostPctCurrentHP ?? 3) / 100;
      const cost = flat + pct * self.currentHP;
      self.currentHP -= cost;
      if (self.currentHP <= 0) {
        self.currentHP = 0; self.alive = false;
        ctx.eventBus?.emit?.('entity:death', { entityId: self.id });
      }

      self._inCombat = true;
      self._combatTimer = c.combatWindowSec ?? 4;

      ctx.eventBus?.emit?.('heal:pulse', { sourceId: self.id, targetId: target.id, amount: healed });
    },
  },

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

  // ==================== 炮兵：破城疾射（新增被动，打塔时加攻速）====================
  // 用户："新增被动技能：唯一被动：炮兵在攻击防御塔时，获得30%攻速。"
  // 与 passive_ram_cannon 的模式判定同一个思路——判据是【当前锁定/攻击的目标是不是
  // 防御塔】，不走 CombatSystem 的伤害结算钩子（那条路径是给"条件减伤"这类拿不到
  // 攻击来源信息的效果用的，这里只是给自己加一条 stat 效果，属于 stat 管线能处理的
  // 范畴），改在 onFrame 里每帧判一次目标类型、用【有没有已经挂上这条效果】做开关：
  // 目标是塔就补上（没有才补，避免每帧重复 apply 导致图标刷新/进度条跳动），
  // 目标不是塔就摘掉。数值放 CONFIG.gameRules.siege，不写死在技能对象上。
  passive_siege_vs_tower_haste: {
    id: 'passive_siege_vs_tower_haste', name: '破城疾射', icon: '💨', category: 'passive',
    applicableTypes: ['siege'], color: '#e8a23a',
    get description() {
      const pct = CONFIG.gameRules?.siege?.vsTowerHastePct ?? 30;
      return `唯一被动——破城疾射：攻击防御塔时，获得 ${pct}% 攻速。`;
    },
    get descTemplate() { return this.description; },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const pct = CONFIG.gameRules?.siege?.vsTowerHastePct ?? 30;
      const tgt = e.targetId ? ctx.entityContainer.get(e.targetId) : null;
      const targetingTower = !!(tgt && tgt.alive && tgt.type === 'tower');
      const has = ctx.effectRegistry.getEffects(entityId).some(x => x.blueprint.name === '破城疾射');
      if (targetingTower) {
        if (!has) {
          ctx.effectRegistry.apply(entityId, {
            name: '破城疾射', icon: '💨', kind: 'stat', statKey: 'bonusAttackSpeedPct',
            flatValue: pct, duration: Infinity, permanent: true,
            stackable: false, stackPolicy: 'refresh', uniquePassive: true,
            description: `破城疾射：攻速 +${pct}%`,
          }, 'passive_siege_vs_tower_haste');
        }
      } else if (has) {
        for (const eff of ctx.effectRegistry.getEffects(entityId)) {
          if (eff.blueprint.name === '破城疾射') ctx.effectRegistry.remove(eff.id);
        }
      }
    },
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
  // ==================== 本轮：屠戮扩展到全部兵种（攻城车/超级兵除外） ====================
  // 用户："除了攻城车/超级兵之外的所有兵种都要有屠戮，新加的的数值你自己定。"
  // 攻城车（ram）是专职破塔单位，不参与兵线互耗；超级兵（super）体量本就远超普通兵、
  // 又自带指挥官光环，这两类用户明确排除。剩下三个支援兵种（图腾/术士/蚀骨）此前一直
  // 没有屠戮——数值上沿用 melee(4%)/ranged(6%)/siege(7%) 那条"越不是纯输出、pct 越低；
  // 越偏输出specialist、pct 越高"的既有梯度类比着定：图腾兵是防御/辅助向（比照近战
  // 4%，给 5% 因为它血量本来就低，pct 稍高也打不出多少）、术士兵是法系消耗输出（比照
  // 远程 6%）、蚀骨兵是主动技能驱动的进攻单位（比照炮兵 7%）。这三个数字都没有做过
  // balance_matrix 验证，后续如需要可单独跑一轮再调。
  ..._makeRendPassive('totem',   '图腾屠戮', 0.05),
  ..._makeRendPassive('warlock', '术法屠戮', 0.06),
  ..._makeRendPassive('corrupt', '蚀骨屠戮', 0.07),

  // v51.5：passive_totem_guardian（图腾守护，老版：每10秒给附近友军300临时护盾）/
  // passive_totem_awaken（图腾觉醒，第15波强化自身）/passive_totem_nourish（图腾滋养，
  // 2%×波数治疗强度）三条已删除——用户："把过时的图腾兵技能删除。"
  // 这三条是图腾兵重做前的老设计，早就被下面这三件套取代（不再默认装配，
  // 但代码一直没删，编辑器里还能选到，选了会跟新三件套双份减伤/双份护盾叠加）。

  // ==================== 图腾兵（用户定稿重做）====================
  // 定位：续航 + 减伤。拆成各自单一职责的技能：
  //   passive_totem_aura     减伤 + 固定护盾光环（自身也吃）
  //   passive_totem_bulwark  自身高额固定护盾
  //   active_totem_mend      主动技能，法力攒满后群体治疗（见 actives.js）——
  //                          v51.6 从被动"每15秒按已损生命百分比回血"改成主动，
  //                          原来的被动 passive_totem_mend 与原主动"庇护波"
  //                          （临时护盾）一并删除，见 actives.js 头注。
  // targetTypes 传 null + minionsOnly：写死的类型数组【收不到自制兵种】，
  // 用户做出来的兵会拿不到光环，而这不报错、只是静默变弱。
  // v51.9 修复：用户"给周围友军加固定护盾这个应该改成护盾"——友军光环这份护盾原来
  // 走 kind:'stat'+statKey:'shieldFixedMax'，脱战一段时间会自动回满；光环每帧刷新，
  // 只要站在图腾兵附近就相当于不断续这份"自动回满"，与钢铁烈阳护盾此前踩的是
  // 同一个坑。改成 kind:'shield'（不衰减、不回复），友军离开光环范围过久才会
  // 重新拿到一份满值。
  // ==================== Q5：图腾兵收窄成"只做光环治疗"====================
  // 用户反馈"术士兵/图腾兵啥的各种属性堆一块太膨胀了"——原来图腾兵同时有
  // 减伤光环（passive_totem_aura）+ 护盾光环（同一条技能里）+ 主动蓄满一次性
  // 群体治疗（active_totem_mend），三条不同维度堆在一个兵身上。收窄成只留
  // "光环治疗"一件事：passive_totem_aura 整条删除（减伤/护盾两个维度都去掉），
  // active_totem_mend 从"法力攒满才触发一次性大额治疗"改成这条新的
  // passive_totem_mend——不吃法力槽，常驻对周围友军小额持续回复，"图腾涌泉"
  // 这个名字（泉水涌动）本来就比"蓄力爆发"更贴"持续"这个语义。数值上：old
  // 版本按法力槽120/回复2的节奏大约60秒一次70+15%AP，折算成"持续"的等效速率
  // 约为每秒1.17+0.25%AP，这里给的常驻速率比这个等效值略低（1+0.2%AP/秒），
  // 因为"随时都在回"比"攒满才有一下"少了博弈空间，故意给得更保守一些，避免
  // 收窄变成变相加强。自身900固定护盾（passive_totem_bulwark）不受这次收窄影响，
  // 那是"扛线"这个天然定位，不是光环。
  passive_totem_mend: {
    id: 'passive_totem_mend', name: '图腾涌泉', icon: '💧', category: 'passive',
    applicableTypes: ['totem'], color: '#bb86fc',
    get description() {
      const c = CONFIG.gameRules.supportUnits?.totem || {};
      const r = c.mendRange ?? 150, hps = c.mendHealPerSec ?? 1, ap = c.mendApScalePct ?? 0.2;
      return `持续为半径 ${r} 内的全部友军（含自身）各回复（{val}=${hps}+${ap}%×法术强度）点/秒生命值。`;
    },
    get descTemplate() { return this.description; },
    computeCurrent: (entity, ctx) => {
      const c = CONFIG.gameRules.supportUnits?.totem || {};
      const hps = c.mendHealPerSec ?? 1, apPct = (c.mendApScalePct ?? 0.2) / 100;
      const stats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      return Math.round((hps + apPct * (stats.abilityPower || 0)) * 10) / 10;
    },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      instance.state.timer += dt;
      if (instance.state.timer < AURA_THROTTLE) return;
      const elapsed = instance.state.timer;
      instance.state.timer = 0;
      const c = CONFIG.gameRules.supportUnits?.totem || {};
      const range = c.mendRange ?? 150;
      const hps = c.mendHealPerSec ?? 1, apPct = (c.mendApScalePct ?? 0.2) / 100;
      const stats = ctx.attrCalc.calc(self, ctx.effectRegistry.getEffects(self.id));
      const healPerSec = hps + apPct * (stats.abilityPower || 0);
      if (!(healPerSec > 0)) return;
      const nearby = ctx.entityContainer.findInRadius(self.pos.x, self.pos.y, range, null, true);
      const allies = nearby.filter(a => {
        if (a.id === self.id) return false;   // 自己单独 push 一次，避免网格里查到自己重复算
        const af = a._mapFaction || a.faction, ef = self._mapFaction || self.faction;
        return af === ef && a.type !== 'tower' && a.type !== 'dragon';
      });
      allies.push(self);
      const amt = healPerSec * elapsed;   // 按实际经过的时间结算，节流不改变总量
      for (const a of allies) {
        applyHeal(a, amt, healPowerFor(a, ctx), a.baseStats?.maxHP ?? a.currentHP);
      }
    },
  },

  // 自身高额护盾。
  // v51.6 修复：用户"图腾兵的固定护盾也改为护盾"——原来走 onEquip 直接改
  // baseStats.shieldFixedMax（"固定护盾"那一档，脱战 N 秒后自动回满），900 点满血
  // 回复型护盾等于图腾兵近乎打不死，这正是用户嫌它太强的根子。改成 kind:'shield'
  // （第三种"护盾"：不衰减、不回复，见 EffectRegistry._recalcEffectValues 的头注）
  // ——出场即满盾（900），打没了就没了，直到这条被动被卸下再重新装上才会再给一份。
  // 效果本身 permanent:true（只要还装着这条被动就一直"存在"，即使余量已经打空），
  // 与旧版"这个单位有多厚是固有属性、不该在面板上混一条状态"的顾虑不冲突——
  // 现在它本来就该在状态栏里看得见、看得出还剩多少，这才是"护盾"该有的可见性。
  // v51.9 修复：用户"图腾兵给自己加900护盾的技能，那个应该是固定护盾，你改错成
  // 护盾了"——把 v51.6 那次的 kind:'shield' 改回 kind:'stat'+statKey:'shieldFixedMax'。
  // 这是用户对自己 v51.6 那次明确决定（"图腾兵的固定护盾也改为护盾"）的直接反转，
  // 如实记录：不是我这次诊断出旧实现有问题，是用户重新定了主意，回到"固定护盾"
  // 那一档（脱战一段时间后自动回满）。
  passive_totem_bulwark: {
    id: 'passive_totem_bulwark',
    applicableTypes: ['totem'],
    name: '图腾壁垒',
    icon: '🛡️',
    color: '#bb86fc',
    category: 'passive',
    _cfg: () => CONFIG.gameRules.supportUnits?.totem || {},
    _text() { return `唯一被动——图腾壁垒：自身获得（{val}=${this._cfg().selfShieldFlat ?? 900}）点固定护盾，脱战一段时间后自动回满。`; },
    get description() { return this._text(); },
    get descTemplate() { return this._text(); },
    computeCurrent() { return this._cfg().selfShieldFlat ?? 900; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e) return;
      const v = (CONFIG.gameRules.supportUnits?.totem?.selfShieldFlat ?? 900) * healPowerFor(e, ctx);
      ctx.effectRegistry.apply(entityId, {
        name: '图腾壁垒', icon: '🛡️', color: '#bb86fc', kind: 'stat', statKey: 'shieldFixedMax',
        flatValue: v,
        duration: Infinity, permanent: true,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `固定护盾+${Math.round(v)}（脱战一段时间后自动回满）`,
      }, 'totem_bulwark');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '图腾壁垒') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // v51.5：passive_totem_sacrifice（图腾献祭：每次攻击扣自己2%当前生命、每秒再扣
  // 已损生命1%）已删除——用户："把过时的图腾兵技能删除。"审查时发现这条纯粹是
  // 自残：通篇没有任何补偿（不给伤害加成、不给友军增益），像是没写完的半成品，
  // 一起清掉。

  // ==================== 新大型小兵光环/被动 ====================
  // ==================== 术士兵（用户定稿重做）====================
  // 定位：增伤 + 破防。给友军双穿与伤害增幅，自身带高额双穿。
  //
  // 口径说明：用户写的是"13%固定双穿"/"70%固定双穿"，两个数都带 %，
  // 所以取【百分比穿透】（armorPenPercent / magicPenPercent），
  // 而不是固定穿透（armorPenFlat / magicPenFlat）—— 后者的单位是点数、不带 %。
  // 若本意是固定点数，改 CONFIG.gameRules.supportUnits.warlock 的 statKey 即可，
  // 数值本身已软编码。
  // v51.1：补上术士兵的主动技能被动伴侣——用户："被动技能：周围150码友军获得20法术强度。"
  // 这不是一个独立的新光环，是术士兵已有的光环（术法共鸣）多给一项属性——它本来就是
  // "周围友军"的光环，半径也正好是 AURA_RANGE=150，不用另起一条技能重复同一套判定。
  // ==================== Q5：术士兵收窄成"只做光环增伤"====================
  // 用户反馈："现在的术士兵/图腾兵啥的各种属性堆一块太膨胀了"——原来这条光环同时
  // 发双穿+增伤+法强三个维度，跟自身的术法贯通（自己的双穿）、主动技能（自己叠
  // 法强）加在一起，一个兵身上塞了五条不同的数值线。收窄成只留"光环增伤"一件事，
  // 光环双穿/光环法强两项整条删除（自身双穿走 passive_warlock_attune，是"自己的"，
  // 不算在这次收窄范围内）。auraDamageAmpPct 从4%略微补到6%——不是完全不削弱，
  // 是"少了两个维度、单一维度稍微顶上一点"，避免收窄变成纯削弱。
  passive_warlock_aura: makeAuraPassive({
    id: 'passive_warlock_aura', name: '术法共鸣', icon: '🧙',
    casterType: 'warlock', targetTypes: null, minionsOnly: true,
    effectsFn: () => {
      const c = CONFIG.gameRules.supportUnits?.warlock || {};
      const amp = c.auraDamageAmpPct ?? 6;
      return [
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
    _text() { return `唯一被动——术法贯通：自身获得（{val}=${this._cfg().selfPenPct ?? 70}%）护甲穿透与法术穿透。`; },
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
           + `叠加一层腐蚀，每层降低 ${c.resistPerStack ?? 1} 点护甲与魔法抗性，`
           + `最多 ${c.maxStacks ?? 30} 层（{val}=最高 -${(c.resistPerStack ?? 1) * (c.maxStacks ?? 30)} 双抗）；`
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
        if (tf === ef) continue;
        for (const [key, label] of [['armor', '护甲'], ['magicResist', '魔法抗性']]) {
          ctx.effectRegistry.apply(t.id, {
            name: '腐蚀', icon: '🦇', kind: 'stat', statKey: key, type: 'debuff', color: '#6b8e23',
            flatValue: -per, perStackFlat: -per,
            // 单层时长 > 叠加间隔：否则上一层在下一层叠上来之前就过期，永远停在 1 层。
            duration: dur,
            stackable: true, maxStacks: mx, stackPolicy: 'stack', uniquePassive: true,
            stackKey: `corrupt_${key}`,
            description: `${label}降低（{stacks}/${mx} 层，每层 -${per}）`,
            descTemplate: `唯一被动——蚀骨：${label}降低（{val}=-${per}×层数），最多 ${mx} 层。`,
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
