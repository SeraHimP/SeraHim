/**
 * behaviorVM.js —— 声明式技能行为解释器
 *
 * ============ 为什么需要它 ============
 * 目标是让用户**在界面上做出一件原本不存在的技能/武器**，而不只是改现有技能的数字。
 *
 * 最直接的想法是"让用户写代码，然后 eval 出来"。这条路不能走：
 *   · eval / new Function 把存档变成可执行代码，导入别人的配置就等于运行别人的程序；
 *   · 用户写的闭包无法序列化，存了盘读回来就没了；
 *   · 出错时抛在引擎深处，用户看到的是一堆看不懂的栈。
 *
 * 所以采用**声明式规格 + 解释器**：技能是一段纯 JSON（触发 → 条件 → 动作），
 * 由本模块编译成引擎认识的 `{ onHit, onFrame, onEquip, ... }` 形状。
 * JSON 能存档、能校验、能在界面上用表单编出来，且永远不会执行任意代码。
 * 这也是正经游戏的通行做法（技能不是代码，是数据行）。
 *
 * ============ 诚实的边界（必须说清）============
 * 用这套东西做出来的技能，**只能做原语覆盖到的事**。原语见下面 ACTIONS / CONDITIONS。
 * 想要"命中后在地面留一片持续伤害区域"这种目前没有的机制，还是得加一条新原语
 * （改一处 ACTIONS，所有已存的技能自动能用）——但那是加代码，不是在界面上点出来的。
 * 现有的 4 把内置武器里，爆炸/腐蚀这两把的行为可以完整用原语表达；
 * 闪电杖和穿透型依赖渲染层与充能状态机，属于原语之外。
 *
 * ============ 设计取舍 ============
 * 校验**在注册时一次做完**，而不是等运行时踩到。理由：技能是每帧跑几百次的东西，
 * 每次都校验既慢又会把同一条错误刷满日志；而且用户最需要的是"点保存的那一刻"
 * 就被告知哪里写错了，不是等到某个兵进入射程才发现技能是坏的。
 */
import { CONFIG } from '../data/Config.js';
import { applyHeal, grantTempShield, healPowerFor } from './healing.js';

// ==================== 原语表 ====================
// 加新原语只改这两张表；表本身也是"编辑器该显示哪些选项"的唯一来源，
// 不要在 UI 里再抄一份清单（抄第二份就是下一个"编辑器写 A 运行时读 B"）。

/** 触发时机。每项声明它需要哪些运行期入参，供校验与文档生成使用。 */
export const TRIGGERS = {
  hit:           { label: '命中时',     hasTarget: true },
  frame:         { label: '每隔一段时间', hasTarget: false, needs: ['every'] },
  equip:         { label: '装备时',     hasTarget: false },
  beingAttacked: { label: '被攻击时',   hasTarget: true },
  // v51.33：出兵编排"广播"升级（docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §5.1，
  // 用户定稿"打通"而不是另开一张 WAVE_ACTIONS 表）。与 equip 同形状（hasTarget:false，
  // self=被广播到的那个单位，没有 target），因为出兵编排广播的语义本来就是"作用于
  // 一批单位自身"（加状态/改属性/治疗自己），表达不了"对目标造成伤害"这类需要目标
  // 的动作——这条限制不是遗漏，是与 equip 触发共享同一条边界，写在这里免得以后
  // 有人往 broadcast 上加 damage/splash 这类需要目标的动作又得重新论证一遍。
  broadcast:     { label: '出兵编排广播时', hasTarget: false },
};

/** 条件。fn(c) → boolean，c 为求值上下文。 */
export const CONDITIONS = {
  targetType:  { label: '目标类型是',   arg: 'string', fn: (c, v) => c.target?.type === v },
  targetIsTower: { label: '目标是建筑', arg: 'none',  fn: (c) => c.target?.type === 'tower' },
  hpBelowPct:  { label: '目标生命低于%', arg: 'number', fn: (c, v) => c.target && c.targetHpPct < v },
  hpAbovePct:  { label: '目标生命高于%', arg: 'number', fn: (c, v) => c.target && c.targetHpPct > v },
  selfHpBelowPct: { label: '自身生命低于%', arg: 'number', fn: (c, v) => c.selfHpPct < v },
  hasShield:   { label: '目标有护盾',   arg: 'none',   fn: (c) => !!(c.target && ((c.target.shieldFixedCurrent || 0) + (c.target.tempShield || 0)) > 0) },
  distLt:      { label: '距离小于',     arg: 'number', fn: (c, v) => c.dist != null && c.dist < v },
  distGt:      { label: '距离大于',     arg: 'number', fn: (c, v) => c.dist != null && c.dist > v },
  chance:      { label: '概率%',        arg: 'number', fn: (c, v) => Math.random() * 100 < v },
};

/**
 * 动作。fn(c, a) 执行，a 为动作节点。
 * 约定：动作**不允许抛错**打断后续动作——一条规则里第 2 个动作坏了，
 * 第 1 个已经生效了，中断会让实体停在半改状态。统一 try 包住并记一次日志。
 */
export const ACTIONS = {
  damage: {
    label: '造成伤害',
    fields: ['amount', 'ofAttackPct', 'type', 'to'],
    fn: (c, a) => {
      const victim = a.to === 'self' ? c.self : c.target;
      if (!victim || !victim.alive) return;
      let dmg = num(c, a.amount, 0);
      if (a.ofAttackPct) dmg += (c.selfStats?.attackDamage || 0) * (num(c, a.ofAttackPct, 0) / 100);
      if (dmg <= 0) return;
      c.ctx.combat?.performAttackDirect?.(c.self.id, victim.id, dmg, a.type || 'physical');
    },
  },
  applyEffect: {
    label: '施加状态',
    fields: ['effect', 'to', 'duration', 'stacks'],
    fn: (c, a) => {
      const who = a.to === 'self' ? c.self : c.target;
      if (!who) return;
      const bp = resolveEffect(a.effect);
      if (!bp) return;
      const dur = a.duration != null ? num(c, a.duration, bp.duration) : bp.duration;
      c.ctx.effectRegistry?.apply(who.id, { ...bp, duration: dur }, `vm_${c.skillId}`);
    },
  },
  splash: {
    label: '范围溅射',
    fields: ['radius', 'ofAttackPct', 'type'],
    fn: (c, a) => {
      const combat = c.ctx.combat;
      const ents = c.ctx.entityContainer;
      if (!combat || !ents || !c.target?.pos) return;
      const radius = num(c, a.radius, 60);
      const base = (c.selfStats?.attackDamage || 0) * (num(c, a.ofAttackPct, 50) / 100);
      if (base <= 0 || radius <= 0) return;
      // 只打敌方、且跳过主目标（主目标已由 damage/普攻结算过，重复打一次是双倍伤害）
      for (const t of ents.getAll(true)) {
        if (t.id === c.target.id || t.id === c.self.id) continue;
        if (sameSide(t, c.self)) continue;
        if (!t.pos) continue;
        const dx = t.pos.x - c.target.pos.x, dy = t.pos.y - c.target.pos.y;
        if (Math.hypot(dx, dy) > radius) continue;
        combat.performAttackDirect(c.self.id, t.id, base, a.type || 'physical');
      }
    },
  },
  chain: {
    label: '链式弹射',
    fields: ['bounces', 'radius', 'ofAttackPct', 'type'],
    fn: (c, a) => {
      if (!c.ctx.combat?.connectChain || !c.target) return;
      const dmg = (c.selfStats?.attackDamage || 0) * (num(c, a.ofAttackPct, 40) / 100);
      if (dmg <= 0) return;
      c.ctx.combat.connectChain(c.self.id, c.target, dmg, a.type || 'magic',
        Math.max(1, num(c, a.bounces, 2)), num(c, a.radius, 180));
    },
  },
  heal: {
    label: '治疗',
    fields: ['amount', 'to'],
    fn: (c, a) => {
      const who = a.to === 'target' ? c.target : c.self;
      if (!who || !who.alive) return;
      const max = who.baseStats?.maxHP ?? who.currentHP;
      // 治疗与护盾强度取【被治疗方】的（统一口径，见 core/healing.js）
      applyHeal(who, num(c, a.amount, 0), healPowerFor(who, c.ctx), max);
    },
  },
  shield: {
    label: '给护盾',
    fields: ['amount', 'to'],
    fn: (c, a) => {
      const who = a.to === 'target' ? c.target : c.self;
      if (!who || !who.alive) return;
      grantTempShield(who, num(c, a.amount, 0), healPowerFor(who, c.ctx));
    },
  },
  modifyStat: {
    label: '改自身基础属性（装备时）',
    fields: ['stat', 'pct', 'flat'],
    // 只在 equip/unequip 触发里有意义：它改的是 baseStats，属于"装上这把武器
    // 就换了一套底子"。写在 hit 里会每次命中都改一遍、永久累积，所以校验会拦。
    fn: (c, a) => {
      const s = c.self?.baseStats;
      if (!s || !a.stat || s[a.stat] === undefined) return;
      c.self._vmStatBackup = c.self._vmStatBackup || {};
      if (c.self._vmStatBackup[a.stat] === undefined) c.self._vmStatBackup[a.stat] = s[a.stat];
      const base = c.self._vmStatBackup[a.stat];
      s[a.stat] = base * (1 + num(c, a.pct, 0) / 100) + num(c, a.flat, 0);
    },
  },
};

// ==================== 小工具 ====================

/** 数值取值：支持字面量与 { param: 'xxx' } 引用技能参数（参数可被全局/地图覆写）。 */
function num(c, v, dflt = 0) {
  if (v == null) return dflt;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.param) {
    const p = c.params?.[v.param];
    return typeof p === 'number' ? p : dflt;
  }
  const n = parseFloat(v);
  return isNaN(n) ? dflt : n;
}

function sameSide(a, b) {
  const fa = a._mapFaction || a.faction, fb = b._mapFaction || b.faction;
  return fa === fb;
}

/** 状态引用：可以是自定义状态 id，也可以直接内联一个 blueprint 对象。 */
function resolveEffect(ref) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref;
  const custom = CONFIG.customEffects && CONFIG.customEffects[ref];
  return custom || null;
}

// ==================== 校验 ====================

/**
 * 校验一份规格。返回 { ok, errors: [string] }。
 * 错误信息写给**用户**看，不是给开发者看 —— 所以要指出是第几条规则、哪个字段、
 * 以及合法取值是什么。"invalid spec" 这种提示等于没提示。
 */
export function validateSpec(spec) {
  const errors = [];
  const E = (m) => errors.push(m);

  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['规格不是一个对象'] };
  if (!spec.id || typeof spec.id !== 'string') E('缺少 id（技能的唯一标识，如 weapon_my_frost）');
  else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(spec.id)) E(`id「${spec.id}」不合法：只能用字母、数字、下划线，且以字母开头`);
  if (!spec.name) E('缺少 name（显示名称）');
  if (spec.category && !['weapon', 'passive'].includes(spec.category)) {
    E(`category「${spec.category}」不合法：只能是 weapon 或 passive`);
  }
  if (spec.params != null && (typeof spec.params !== 'object' || Array.isArray(spec.params))) {
    E('params 必须是一个对象（参数名 → 数值）');
  } else if (spec.params) {
    for (const [k, v] of Object.entries(spec.params)) {
      if (typeof v !== 'number') E(`参数「${k}」必须是数值（当前是 ${typeof v}）`);
    }
  }

  const rules = spec.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    E('至少要有一条规则（rules 数组）——没有规则的技能什么都不会做');
    return { ok: errors.length === 0, errors };
  }

  rules.forEach((r, i) => {
    const at = `第 ${i + 1} 条规则`;
    if (!r || typeof r !== 'object') { E(`${at}：不是一个对象`); return; }
    const trig = TRIGGERS[r.on];
    if (!trig) {
      E(`${at}：触发时机「${r.on}」不存在。可选：${Object.keys(TRIGGERS).join(' / ')}`);
      return;
    }
    if (r.on === 'frame' && !(num({}, r.every, 0) > 0)) {
      E(`${at}：「每隔一段时间」必须指定 every（秒，且 > 0）`);
    }
    // 条件
    for (const cond of (r.when || [])) {
      if (!cond || typeof cond !== 'object') { E(`${at}：条件项不是对象`); continue; }
      const keys = Object.keys(cond);
      if (keys.length !== 1) { E(`${at}：每个条件项只能写一个条件（当前 ${keys.length} 个）`); continue; }
      const [k] = keys;
      const meta = CONDITIONS[k];
      if (!meta) { E(`${at}：条件「${k}」不存在。可选：${Object.keys(CONDITIONS).join(' / ')}`); continue; }
      if (meta.arg === 'number' && typeof cond[k] !== 'number') E(`${at}：条件「${k}」需要一个数值`);
      if (!trig.hasTarget && /^(target|hp(Below|Above)Pct|hasShield|dist)/.test(k)) {
        E(`${at}：触发时机「${trig.label}」没有目标，用不了条件「${meta.label}」`);
      }
    }
    // 动作
    const acts = r.do;
    if (!Array.isArray(acts) || acts.length === 0) { E(`${at}：没有任何动作（do 数组为空）`); return; }
    acts.forEach((a, j) => {
      const aat = `${at} 的第 ${j + 1} 个动作`;
      if (!a || typeof a !== 'object') { E(`${aat}：不是一个对象`); return; }
      const meta = ACTIONS[a.act];
      if (!meta) { E(`${aat}：动作「${a.act}」不存在。可选：${Object.keys(ACTIONS).join(' / ')}`); return; }
      if (a.act === 'modifyStat' && r.on !== 'equip') {
        E(`${aat}：「改自身基础属性」只能用在「装备时」——` +
          `放在其它时机会每次触发都改一遍并永久累积。`);
      }
      if (!trig.hasTarget && (a.to === 'target' || (a.act === 'damage' && a.to !== 'self') ||
          a.act === 'splash' || a.act === 'chain')) {
        E(`${aat}：触发时机「${trig.label}」没有目标，动作「${meta.label}」需要目标`);
      }
      // 参数引用必须真的存在，否则运行时静默取默认值 —— 那正是"改了没反应"的来源
      for (const f of ['amount', 'ofAttackPct', 'radius', 'bounces', 'duration']) {
        const v = a[f];
        if (v && typeof v === 'object' && v.param && !(spec.params && v.param in spec.params)) {
          E(`${aat}：引用了不存在的参数「${v.param}」（请先在 params 里定义）`);
        }
      }
      if (a.act === 'applyEffect') {
        if (!a.effect) E(`${aat}：没有指定要施加哪个状态`);
        else if (typeof a.effect === 'string' && !resolveEffect(a.effect)) {
          E(`${aat}：状态「${a.effect}」不存在（先在「状态」里做出来，或直接内联一个状态对象）`);
        }
      }
      if (a.act === 'modifyStat') {
        if (!a.stat) E(`${aat}：没有指定要改哪个属性`);
        else if (CONFIG.templates.tower[a.stat] === undefined && CONFIG.templates.melee[a.stat] === undefined) {
          E(`${aat}：属性「${a.stat}」不是模板里的字段`);
        }
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

// ==================== 编译 ====================

function evalConditions(list, c) {
  for (const cond of (list || [])) {
    const [k] = Object.keys(cond);
    const meta = CONDITIONS[k];
    if (!meta) return false;
    if (!meta.fn(c, cond[k])) return false;
  }
  return true;
}

function runActions(acts, c, skillId) {
  for (const a of acts) {
    const meta = ACTIONS[a.act];
    if (!meta) continue;
    // 一个动作坏了不能打断后面的：前面的动作已经生效了，中断会让实体停在半改状态。
    try { meta.fn(c, a); }
    catch (e) { console.warn(`[behaviorVM] 技能「${skillId}」动作「${a.act}」执行出错：`, e?.message || e); }
  }
}

/** 组装求值上下文。集中一处，免得每个触发各算一遍还算得不一样。 */
function mkCtx(spec, selfId, targetId, instance, ctx) {
  const ents = ctx.entityContainer;
  const self = ents?.get(selfId) || null;
  const target = targetId != null ? (ents?.get(targetId) || null) : null;
  const selfStats = (self && ctx.attrCalc)
    ? ctx.attrCalc.calc(self, ctx.effectRegistry?.getEffects(self.id) || [])
    : self?.baseStats;
  const hpPct = (e) => (e && e.baseStats?.maxHP ? (e.currentHP / e.baseStats.maxHP) * 100 : 100);
  let dist = null;
  if (self?.pos && target?.pos) dist = Math.hypot(target.pos.x - self.pos.x, target.pos.y - self.pos.y);
  return {
    self, target, selfStats, ctx, dist, skillId: spec.id,
    selfHpPct: hpPct(self), targetHpPct: hpPct(target),
    // 参数走 instance._params —— 那是"出厂值 → 全局覆写 → 地图覆写"叠加后的结果，
    // 所以自制技能同样享有地图级覆写能力（用户明确要求过这条）。
    params: instance?._params || spec.params || {},
  };
}

/**
 * 把规格编译成引擎认识的技能定义。
 * 校验不通过则返回 null 并把错误交给调用方 —— **不注册半个坏技能**。
 */
export function compileSpec(spec, onError = null) {
  const v = validateSpec(spec);
  if (!v.ok) { if (onError) onError(v.errors); return null; }

  const byTrigger = {};
  for (const r of spec.rules) (byTrigger[r.on] = byTrigger[r.on] || []).push(r);

  const def = {
    id: spec.id,
    name: spec.name,
    icon: spec.icon || '✨',
    color: spec.color || '#8ab4f8',
    category: spec.category || 'passive',
    description: spec.description || '',
    descTemplate: spec.descTemplate || `唯一被动——${spec.name}：${spec.description || '自制技能。'}`,
    effects: [],
    defaultParams: { ...(spec.params || {}) },
    _vmSpec: spec,          // 留着：编辑器要能把技能读回表单继续改
    _isCustom: true,
  };

  if (byTrigger.hit) {
    // 引擎侧钩子统一改名为 onDealtDamage（原 onHit 已完全废弃，performAttackDirect
    // 那条路径从来不认 onHit——特殊攻击方式的武器/被动全靠这条路径接伤害，旧钩子名
    // 一直是"命中时"技能在这些武器上不生效的根因）。这里只改编译产物的属性名，
    // 编辑器里"命中时"这个触发时机的用户可见文案不用跟着改。
    // procMode 不开放给自定义技能选择，统一走默认的 'always'——和这条触发器原来
    // 挂在 onHit 上的行为完全一致（无节流、每次命中都跑），零行为变化。
    def.onDealtDamage = (selfId, targetId, instance, ctx) => {
      const c = mkCtx(spec, selfId, targetId, instance, ctx);
      for (const r of byTrigger.hit) {
        if (evalConditions(r.when, c)) runActions(r.do, c, spec.id);
      }
    };
  }
  if (byTrigger.beingAttacked) {
    def.onBeingAttacked = (selfId, attackerId, instance, ctx) => {
      // 语义：self = 被打的人，target = 打我的人（这样"对目标造成伤害"就是反伤）
      const c = mkCtx(spec, selfId, attackerId, instance, ctx);
      for (const r of byTrigger.beingAttacked) {
        if (evalConditions(r.when, c)) runActions(r.do, c, spec.id);
      }
    };
  }
  if (byTrigger.frame) {
    // 参数顺序必须是 (entityId, dt, instance, ctx) —— 这是 CombatSystem 的调用约定
    // （见 CombatSystem 里 def.onFrame(entity.id, dt, inst, {...})）。
    // 这里曾写成 (selfId, instance, ctx, dt)：于是 instance 收到的是数字 dt，
    // 给数字挂 _vmTimers 在 ESM 的严格模式下直接抛 TypeError —— 所有带"每隔一段时间"
    // 触发的自制技能【运行时必崩】。而单元测试当时按同一个错误顺序调用，所以全绿。
    // 教训：跨模块的回调签名要以【调用方】为准去核对，不能以自己写的测试为准。
    def.onFrame = (selfId, dt, instance, ctx) => {
      const c = mkCtx(spec, selfId, null, instance, ctx);
      instance._vmTimers = instance._vmTimers || {};
      for (let i = 0; i < byTrigger.frame.length; i++) {
        const r = byTrigger.frame[i];
        const every = num(c, r.every, 1);
        // 计时器按【规则下标】独立存：多条 frame 规则共用一个计时器的话，
        // 周期最短的那条会把其它条一起拖着跑。
        const t = (instance._vmTimers[i] || 0) + (dt || 0);
        // 两个坑，都踩过：
        // ① dt 是 1/30 这种无法用二进制精确表示的数，累加 30 次得到的是
        //    0.9999999999999999 而不是 1。用朴素的 `t < every` 判断会**每个周期
        //    都少触发一次**，"每秒一次"实际变成"每 1.03 秒一次"，而且越跑越偏。
        //    所以留一个极小的容差。
        // ② 触发后不能把计时器清 0，要**减掉一个周期保留余量**。清 0 会把
        //    这一帧超出的部分丢掉，同样造成长期漂移（帧率越低漂得越狠）。
        if (t < every - 1e-9) { instance._vmTimers[i] = t; continue; }
        instance._vmTimers[i] = t - every;
        if (evalConditions(r.when, c)) runActions(r.do, c, spec.id);
      }
    };
  }
  if (byTrigger.equip) {
    def.onEquip = (selfId, instance, ctx) => {
      const c = mkCtx(spec, selfId, null, instance, ctx);
      for (const r of byTrigger.equip) {
        if (evalConditions(r.when, c)) runActions(r.do, c, spec.id);
      }
    };
    // 卸下时把 modifyStat 改过的基础属性还原。
    // 不还原的话换一次武器就永久掉一截攻击力，换来换去越换越弱 ——
    // 内置的爆炸型武器就是靠 onUnequip 手写还原的，这里做成通用的。
    def.onUnequip = (selfId, instance, ctx) => {
      const self = ctx.entityContainer?.get(selfId);
      if (!self?._vmStatBackup) return;
      for (const [k, v] of Object.entries(self._vmStatBackup)) {
        if (self.baseStats[k] !== undefined) self.baseStats[k] = v;
      }
      delete self._vmStatBackup;
    };
  }
  if (byTrigger.broadcast) {
    // 照抄 onEquip 那段：mkCtx 组装、evalConditions/runActions 复用，零新增执行逻辑
    // ——这正是"打通"换来的好处（设计报告 §5.1）。调用方（出兵编排的广播调度）
    // 负责按 scope 枚举单位、逐个调用这个钩子，这里只管单个单位的求值与执行。
    def.onBroadcast = (selfId, instance, ctx) => {
      const c = mkCtx(spec, selfId, null, instance, ctx);
      for (const r of byTrigger.broadcast) {
        if (evalConditions(r.when, c)) runActions(r.do, c, spec.id);
      }
    };
  }
  return def;
}
