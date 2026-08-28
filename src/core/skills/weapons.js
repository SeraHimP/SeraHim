import { CONFIG } from '../../data/Config.js';
import { enemyUnitsInRadius } from '../../systems/FactionSystem.js';

// ==================== 闪电杖的数值全部搬进 defaultParams（软编码）====================
// 原来这几个是模块级 const（写死在源码里），编辑器改不了；而 weapon_lightning 的
// defaultParams 里躺着 { damage, bounces, interval } 三个**根本没人读**的键 ——
// 面板上摆着三个改了没反应的滑块。现在两边合一：面板列什么，代码就读什么。
//
// 充能时间保持 12s 基准不变（用户定稿："充能时间不要改，就用现在的"）：
// 充能速度本就与攻速挂钩，攻速 4.0 的枢纽塔约 3 秒充满，再缩短基准等于取消充能。

export const weapons = {
  weapon_piercing: {
    id: 'weapon_piercing',
    applicableTypes: ['tower'],
    name: '穿透型子弹',
    icon: '🔷',
    category: 'weapon',
    // v36 重做（用户 Q1）：升温不再叠塔的"伤害增幅"（那会污染塔对所有目标的输出，
    // 且有数值 bug）。改为【塔→特定目标】的独立伤害倍率：连续命中同一目标，
    //   第1下 100%（原始）、第2下 130%、第3下 160%…每层 +30%，最多累进到某上限。
    // 切换目标（含目标死亡）从头计。倍率在【开火时刻】结算进 hitInfo.preDamageMult，
    // 命中时乘入——不进塔的属性系统。状态栏只显示"升温 N 层"（纯计数，无属性）。
    //   穿透：30% 护甲穿透 + 30% 法术穿透（永久状态）；命中削目标 3 双抗最多 -12（原有）。
    description: '唯一被动——升温：连续攻击同一目标，伤害逐次提升（100%→130%→160%…每层+30%，最高+120%），切换目标或目标死亡重置；唯一被动——穿透：固定30%护甲穿透与30%法术穿透。',
    descTemplate: '唯一被动——升温：对当前目标连续命中的伤害倍率（【{val}%】=100%+30%×层数），切换目标重置；唯一被动——穿透：固定30%双穿。',
    computeCurrent: (entity, ctx) => { const e = ctx.effectRegistry.getEffectByName(entity.id, '升温'); return 100 + 30 * (e ? e.stacks : 0); },
    HEAT_MAX_STACKS: 4,          // 最多 4 层（+120% → 220% 上限），与旧上限一致
    HEAT_PER_STACK: 0.30,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.heatTarget = null;   // 当前升温针对的目标 id
      instance.state.heatStacks = 0;      // 已累积层数（第 N 下命中后 = N-1，因为第1下是原始）
      for (const [key, label] of [['armorPenPercent', '护甲穿透'], ['magicPenPercent', '法术穿透']]) {
        ctx.effectRegistry.apply(entityId, {
          name: '穿透', icon: '🔷', kind: 'stat', statKey: key, flatValue: 30,
          duration: Infinity, permanent: true,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `${label}+30%`,
        }, 'weapon_piercing_' + entityId);
      }
    },
    onUnequip: (entityId, instance, ctx) => {
      // 卸下武器：移除穿透与升温状态（v43 起不再有破甲 debuff）
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '穿透' || eff.blueprint.name === '升温') ctx.effectRegistry.remove(eff.id);
      }
    },
    // procMode：'perAttack'——升温本该按"完整一次攻击"叠层，不该按分数攻击的
    // 每一小份都叠。穿透型自己没有特殊攻击节奏（attackShare 恒为1），这里声明
    // 只是为了语义正确、以防以后有人给它接上特殊攻击方式。
    procMode: 'perAttack',
    onDealtDamage: (attackerId, targetId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      if (!target || !target.alive) return;

      // ---- 升温（命中后叠层，供【下一次】对同一目标的攻击提升伤害） ----
      // 注意：本次命中用的倍率已在 performAttack 开火时刻算好（读的是命中前的层数）；
      // 这里在命中后 +1 层，作用于下一次。切换目标由 performAttack 侧重置（见 CombatSystem）。
      instance.state = instance.state || { heatTarget: null, heatStacks: 0 };
      const maxS = weapons.weapon_piercing.HEAT_MAX_STACKS;
      if (instance.state.heatTarget === targetId) {
        instance.state.heatStacks = Math.min(maxS, (instance.state.heatStacks || 0) + 1);
      } else {
        instance.state.heatTarget = targetId;
        instance.state.heatStacks = 1; // 第一次命中该目标后 → 下一下是第2下（+30%）
      }
      // 展示效果：纯计数，不含任何属性（statKey 用一个不存在于 stats 的 key，绝不影响数值）
      const st = instance.state.heatStacks;
      // 展示效果：纯计数。用 alwaysShowStacks + initialStacks 让状态栏直接显示层数徽标，
      // kind:'display' + 无 statKey → 绝不进属性合成管线（不影响任何数值）。
      ctx.effectRegistry.apply(attackerId, {
        name: '升温', icon: '🔥', kind: 'display',
        duration: 6, stackable: true, maxStacks: maxS, stackPolicy: 'refresh',
        alwaysShowStacks: true, uniquePassive: true,
        descTemplate: `唯一被动——升温：对当前目标下次伤害倍率 ${100 + 30 * st}%（升温 ${st} 层）。`,
        description: `升温 ${st} 层 → 下次 ${100 + 30 * st}% 伤害`,
      }, 'weapon_piercing_heat', { initialStacks: st });

      // ---- v43 Q10：破甲已删除 ----
      // 用户："穿透型太强了……直接改为固定+30%双穿和原来的升温。剩下的都不要了。"
      // 这里原本还会给目标叠一层"破甲"：命中削 3 点双抗、最多 4 层（-12/-12），持续 4 秒。
      // 它与固定 30% 双穿是**乘上加**的关系（先按百分比削、再减固定值），
      // 对低抗性的小兵等于把有效抗性直接打穿到 0 —— 这是穿透型过强的主要来源之一。
      // 现在整条移除：穿透型 = 30% 双穿（永久） + 升温（连续命中同目标的伤害倍率），仅此两项。
    },
  },

  weapon_lightning: {
    // 单位统一用"百分数写百分数、秒写秒"，面板上直接可读。
    defaultParams: {
      chargeTimeAtAS1: 12,    // 攻速 1.0 时充满需要几秒（实际 = 本值 / 最终攻速）
      tickPct: 20,            // 每跳伤害 = 攻击力 × 本值%
      tickPerSec: 4,          // 每秒跳几次（独立于攻速）
      // 攻击特效的每跳修正系数（现在叫 attackShare——见 CombatSystem._fireOnDealtDamage
      // 的说明：这个值同时决定"这一下算几分之几次标准攻击"）。
      // 留空(null)时自动取 1/tickPerSec；显式填一个数可以让攻击特效相对普通攻击
      // 更强/更弱（软编码，编辑器里可改）。
      attackShare: null,
      maxMult: 180,           // 满充能伤害倍率（%）
      // v43 Q10：90 → 67（用户定稿："闪电杖改为满充能无视67%防御，剩下不改"）。
      // 与穿透型的削弱同批，避免穿透被砍之后闪电杖独大。
      maxPenPct: 67,          // 满充能无视防御（%）——只无视【保护性】防御，见 CombatSystem
      bonusVsShieldPct: 7,    // 目标持盾时的额外伤害（%）
      slowPct: 15,            // 麻痹：移速 −%
      ampDownPct: 15,         // 麻痹：伤害增幅 −%
      asDownPct: 20,          // 麻痹：攻速 −%
      grievousPct: 40,        // 重伤：满充能时减少目标治疗与护盾强度 −%
    },
    id: 'weapon_lightning',
    applicableTypes: ['tower'],
    name: '闪电杖 (魔法)',
    icon: '⚡',
    category: 'weapon',
    description: '魔法伤害，每秒固定跳4次伤害（各20%攻击力），完全独立于攻速；充能随攻速加快（攻速1.0约12秒充满，切换目标严格归零），伤害倍率随充能升至1.8倍、无视防御升至67%；满充能时对目标施加重伤（治疗与护盾强度-40%）；被动对当前目标-15%移速/-15%伤害增幅/-20%攻速（唯一被动）；目标有护盾额外+7%伤害。',
    descTemplate: '唯一被动——闪电杖：每秒固定4次魔法伤害（各（【{val}】=20%攻击力×充能倍率）），倍率随充能1.0→1.8、无视防御0→67%（攻速1.0约12秒充满）；满充能对目标施加40%重伤（治疗与护盾强度-40%）；被动对目标-15%移速/-15%伤害增幅/-20%攻速；目标有护盾额外+7%伤害。',
    computeCurrent: (entity, ctx) => { const s = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id)); return Math.round((s.attackDamage||0)*0.15); },
    specialAttack: true,
    effects: [],
    // 参数取值：实例覆写（全局/地图级）→ 出厂值。所有数值都从这里过一遍，
    // 源码里不再出现第二份字面量。
    _p(instance) {
      const d = weapons.weapon_lightning.defaultParams;
      const o = (instance && instance._params) || {};
      const g = (k) => (typeof o[k] === 'number' ? o[k] : d[k]);
      return {
        chargeTime: Math.max(0.01, g('chargeTimeAtAS1')),
        tickPct: g('tickPct') / 100,
        tickInterval: 1 / Math.max(0.01, g('tickPerSec')),
        maxMult: g('maxMult') / 100,
        maxPen: g('maxPenPct') / 100,
        bonusVsShieldPct: g('bonusVsShieldPct'),
        slowPct: g('slowPct'), ampDownPct: g('ampDownPct'), asDownPct: g('asDownPct'),
        grievousPct: g('grievousPct'),
      };
    },
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.charge = 0;
      instance.state.tickTimer = 0;
      instance.state.lastTargetId = null;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      if (typeof instance.state?.charge !== 'number') instance.state = { ...(instance.state || {}), charge: 0, tickTimer: 0, lastTargetId: null };

      const targetId = entity.targetId;
      const target = targetId ? ctx.entityContainer.get(targetId) : null;

      // Q7：全塔停火——闪电杖伤害独立于普攻循环，需单独设门（充能保留，仅停止输出）
      if (window.__towersAttackOff) return;
      if (!target || !target.alive) {
        // 无有效目标：充能归零，计时器清空，充能状态即刻脱落
        instance.state.charge = 0;
        instance.state.tickTimer = 0;
        instance.state.lastTargetId = null;
        const chEff = ctx.effectRegistry.getEffects(entityId).find(x => x.blueprint.name === '闪电充能');
        if (chEff) chEff.remainingTime = 0.01;
        return;
      }

      // 切换目标：充能归零重新开始
      if (instance.state.lastTargetId !== targetId) {
        instance.state.charge = 0;
        instance.state.lastTargetId = targetId;
      }

      // v33（Q14）：锁定前摇——CombatSystem 给塔设置的 _lockUntil 之前既不充能也不放电
      //（普攻武器在 performAttack 处被同一时间戳拦截；闪电杖伤害独立于普攻循环，须单独设门）
      if ((window.gameTime || 0) < (entity._lockUntil || 0)) return;

      const atkStats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entityId));

      // 充能速度：攻速越快充能越快。基准：攻速 1.0 → 12s 充满（用户定稿：满充时间维持 12s 保平衡，
      // 高攻速塔自然快——枢纽塔攻速 4.0 时约 3s 充满）。
      const finalAS = ctx.attrCalc.calcAttackSpeedOf(atkStats);   // v43 Q7：走属性表，不读原始模板值
      // Q1 BUG 修复：原式 asRatio = finalAS / baseAS 把【模板攻速约掉了】——
      // 分子分母同时随模板攻速变化，比值恒为 1。实测：塔攻速 0.833 与 4.0 的满充时间
      // 一模一样（都是 10.9s），"攻速影响充能"完全没生效。
      // 正确：充能速率正比于【最终攻速的绝对值】，以攻速 1.0 为基准。
      //   满充时间 = CHARGE_TIME_AT_AS1 / finalAS
      //   → 攻速 1.0：12s；攻速 2.0：6s；攻速 4.0：3s。攻速加成同样直接生效。
      const P = weapons.weapon_lightning._p(instance);
      instance.state.charge = Math.min(1, (instance.state.charge || 0) + (dt * finalAS) / P.chargeTime);

      // EQ4：充能以【状态】形式展示——挂一个"闪电充能"效果，用效果栏自带的倒计时环当进度条
      // （环的已消耗比例 = 充能比例），描述实时显示百分比；掉目标后停止刷新即自动脱落。
      instance.state._fxTimer = (instance.state._fxTimer || 0) + dt;
      if (instance.state._fxTimer >= 0.1) {
        instance.state._fxTimer = 0;
        const ch = instance.state.charge;
        // Q1 修复：进度环跳动 = 效果系统每帧递减 remainingTime 与我们 0.1s 一次的回写打架。
        // duration 从 1 放大到 100：两次回写之间的自然递减只占环的 0.1%，肉眼不可见；
        // 回写仍是权威值（环 = 充能比例），根治跳动。
        ctx.effectRegistry.apply(entityId, {
          name: '闪电充能', icon: '⚡', kind: 'custom', duration: 100,
          stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          customData: { charge: ch },
          description: `充能 ${(ch * 100).toFixed(0)}%`,
        }, 'lightning_charge_' + entityId);
        const chEff = ctx.effectRegistry.getEffects(entityId).find(x => x.blueprint.name === '闪电充能');
        if (chEff) {
          chEff.remainingTime = Math.max((1 - ch) * 100, 0.5); // 环的已消耗部分 = 充能比例
          chEff.blueprint.description = `充能 ${(ch * 100).toFixed(0)}%（满充能：${P.maxMult.toFixed(1)}倍伤害、${(P.maxPen * 100) | 0}%无视防御、施加${P.grievousPct}%重伤）`;
        }
      }

      // 固定 4 次/秒 tick（伤害结算），完全独立于攻速
      instance.state.tickTimer = (instance.state.tickTimer || 0) + dt;
      const tickInterval = P.tickInterval;
      let safety = 0;
      while (instance.state.tickTimer >= tickInterval && safety < 8) {
        instance.state.tickTimer -= tickInterval;
        safety++;
        weapons.weapon_lightning._doTick(entity, target, instance, ctx);
      }

      // 每帧刷新光束端点（平滑跟随移动的塔/目标，不受 0.25s tick 间隔影响）
      // v36（Q2）：光束颜色 = 塔阵营色；目标死亡时不再刷新 → 由 ProjectileSystem
      // 的 ttl 让最后一段轨迹残留淡出（fadeOut 标记触发淡出渲染）。
      if (ctx.combat && ctx.combat.projectiles && entity.pos && target.pos) {
        // v39（Q8）：切换目标时立刻清掉旧光束——否则旧那条会留在原地走完 0.35s 淡出，
        // 视觉上是"指着空气的残影"。目标【死亡】时不走这里（无新目标），残留淡出保留。
        if (instance.state.beamTargetId !== target.id) {
          ctx.combat.projectiles.clearBeam?.(entity.id);
          instance.state.beamTargetId = target.id;
        }
        const fac = entity._mapFaction;
        const beamColor = fac === 'blue' ? '#5b9bd5' : fac === 'red' ? '#e0473f' : '#f1c40f';
        ctx.combat.projectiles.fireBeam({
          attackerId: entity.id,
          startX: entity.pos.x, startY: entity.pos.y,
          endX: target.pos.x, endY: target.pos.y,
          charge: instance.state.charge || 0, life: 0.4, color: beamColor, targetId: target.id,
        });
      }
    },
    // 独立的伤害结算逻辑，不经过普通攻击（performAttack）
    _doTick(entity, target, instance, ctx) {
      if (!entity.alive || !target.alive) return;
      entity._inCombat = true;
      entity._combatTimer = 4;

      const atkStats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      const charge = instance.state.charge || 0;
      const P = weapons.weapon_lightning._p(instance);
      // 每跳 tickPct × AD × 充能倍率（1.0 ~ maxMult）
      const chargeMultiplier = 1 + charge * (P.maxMult - 1);
      const tickDamage = P.tickPct * (atkStats.attackDamage || 0) * chargeMultiplier;

      if (ctx.combat && typeof ctx.combat.performAttackDirect === 'function') {
        // 无视防御随充能【连续】增长至 maxPen（v43 定稿 67%，原 90%）；伤害类型固定魔法。
        // ⚠️ "无视防御"只无视【保护性】的那部分：目标双抗/减伤/格挡若是负值，
        // 那是给攻击方的增伤，不能被一起抹掉 —— 这条在 CombatSystem 里实现，
        // 见 performAttackDirect 里 `keepAmp` 那段（用户指出的坑）。
        // v45：攻击特效按"每跳 × attackShare"修正（用户定稿）。
        // 默认 0.25 = 1 / tickPerSec：4 跳合起来正好等于一个 1.0 攻速单位打一下。
        // 写成 `1 / tickPerSec` 而不是写死 0.25 —— 以后谁调了跳数，修正系数自动跟上；
        // 写死的话改跳数就会**静默**把攻击特效放大或缩小，而且没人会想到来改这里。
        // applyOnHitBonus:true —— 闪电杖是目前唯一需要"攻击特效数值部分按份额并入"
        // 的调用方（溅射/DOT/龙魂等都不该带，见 CombatSystem.performAttackDirect
        // 里 applyOnHitBonus 那段说明）。attackShare 同时决定被动判定的节奏，
        // 两件事分开在 CombatSystem 里处理，这里只管传值，不用关心内部怎么拆。
        ctx.combat.performAttackDirect(entity.id, target.id, tickDamage, 'magic', {
          ignoreDefenseRatio: charge * P.maxPen,
          bonusVsShieldPct: P.bonusVsShieldPct,
          attackShare: P.attackShare ?? (1 / Math.max(1, P.tickPerSec || 4)),
          applyOnHitBonus: true,
        });
        // （v35：满充闪电链弹射已按方案B删除——纯单体，无 AOE）
      }

      // ==================== 重伤（满充能才施加）====================
      // 用户定稿："改为满充无视90%防御并且对攻击目标施加40%重伤
      //（状态：减少目标40%治疗与护盾强度）" + "把重伤改成满充能后才会施加"。
      // 走光环机制（aura:true）与麻痹同规格：照射期间常驻、停照 0.6s 自动脱落，
      // 于是"切目标 → 充能归零 → 重伤自然掉"不需要额外的清理代码。
      // 治疗与护盾强度是【被治疗方】的属性（见 core/healing.js 头注），所以减它
      // 能压住这个目标身上【所有】来源的回血与护盾，包括别人给他的。
      if (charge >= 1 && P.grievousPct > 0) {
        ctx.effectRegistry.apply(target.id, {
          name: '重伤', icon: '💔', kind: 'stat', statKey: 'healShieldPowerPct',
          flatValue: -P.grievousPct, aura: true, stackPolicy: 'refresh', uniquePassive: true,
          descTemplate: `唯一被动——重伤：治疗与护盾强度-${P.grievousPct}%。`,
          description: `治疗与护盾强度-${P.grievousPct}%`,
        }, 'weapon_lightning_grievous');
      }

      // 被动：减速 / 减伤害增幅 / 减攻速——唯一被动，多个闪电杖塔打同一目标只生效一份。
      // v33（Q12）：走【光环机制】（aura:true）——照射期间常驻显示（无倒计时环反复重置的闪烁），
      // 停止照射后由 EffectRegistry 的光环宽限期（0.6s）自动脱落。
      ctx.effectRegistry.apply(target.id, {
        name: '闪电麻痹', icon: '⚡', kind: 'stat', statKey: 'moveSpeed',
        flatValue: -P.slowPct, aura: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: `唯一被动——闪电麻痹：移速-${P.slowPct}%。`, description: `移速-${P.slowPct}%`,
      }, 'weapon_lightning_slow');
      ctx.effectRegistry.apply(target.id, {
        name: '闪电麻痹', icon: '⚡', kind: 'stat', statKey: 'damageAmpPct',
        flatValue: -P.ampDownPct, aura: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: `唯一被动——闪电麻痹：伤害增幅-${P.ampDownPct}%。`, description: `伤害增幅-${P.ampDownPct}%`,
      }, 'weapon_lightning_amp');
      ctx.effectRegistry.apply(target.id, {
        name: '闪电麻痹', icon: '⚡', kind: 'stat', statKey: 'bonusAttackSpeedPct',
        flatValue: -P.asDownPct, aura: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: `唯一被动——闪电麻痹：攻速-${P.asDownPct}%。`, description: `攻速-${P.asDownPct}%`,
      }, 'weapon_lightning_as');
    },
  },

  weapon_explosive: {
    defaultParams: { splashDmg: 80, radius: 50 },
    id: 'weapon_explosive',
    applicableTypes: ['tower'],
    name: '爆炸型子弹',
    icon: '💥',
    category: 'weapon',
    description: '攻击力-20%，溅射半径75，伤害随距离指数衰减（中心60%，边缘约5%）。',
    descTemplate: '唯一被动——爆炸：攻击力-20%，命中造成半径75的溅射伤害（中心60%，边缘5%指数衰减）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (entity) {
        entity.baseStats.attackDamage = CONFIG.templates.tower.attackDamage * 0.8;
      }
    },
    onUnequip: (entityId, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (entity) {
        entity.baseStats.attackDamage = CONFIG.templates.tower.attackDamage;
      }
    },
  },

  // （原 weapon_sniper「狙击型」已按用户定稿删除：攻速-33%、伤害随距离 ×0.6~×1.6、
  //   命中 0.5s 眩晕。整块删掉而不是留着置灰 —— 留着编辑器里就会有人选，
  //   选了之后所有关于它的平衡结论都得重新算一遍。）

  weapon_corrosion: {
    defaultParams: { tickDamage: 5, tickInterval: 1, maxStacks: 5 },
    id: 'weapon_corrosion',
    applicableTypes: ['tower'],
    name: '腐蚀型',
    icon: '🌿',
    color: '#7bc96f',
    category: 'weapon',
    attackType: 'magic', // 可选伤害类型（默认魔法），另50%固定为真实
    description: '无弹道。持续对射程内所有敌人叠加中毒、减速与减攻速。',
    descTemplate: '唯一被动——腐蚀：持续对射程内所有敌人叠加两种中毒（可选类型50%+真实50%，各每层攻击力1%/秒，最多50层）；叠层速度随攻速；额外施加减速（每层7%，上限35%）与减攻速（每层2.5%，上限75%）。',
    specialAttack: true,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.timer = 0;
    },
    onBeforeAttack: (attacker, target, instance, ctx) => {
      return { skipProjectile: true };
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const st = instance.state || (instance.state = { timer: 0 });

      const stats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      // 叠层速度基于攻速：每秒叠 (攻速) 层
      const finalAS = ctx.attrCalc.calcAttackSpeedOf(stats);   // v43 Q7：走属性表，不读原始模板值
      st.timer += dt;
      const interval = 1 / Math.max(0.1, finalAS); // 按攻速决定叠层间隔
      if (st.timer < interval) return;
      st.timer -= interval;

      const range = stats.attackRange || 250;
      // v49：改走 enemyUnitsInRadius —— 原来这行直接用 findInRadius 的结果，
      // 既不认阵营（自己人也中毒）、白名单里又漏了 'ram'（攻城车对腐蚀免疫）。
      // 用户同时报了这两个症状，它们是同一行代码造成的。详见该函数的头注。
      const enemies = enemyUnitsInRadius(ctx.entityContainer, entity, range);
      if (enemies.length > 0) { entity._inCombat = true; entity._combatTimer = 4; }

      const perStackDmg = Math.max(0.5, (stats.attackDamage || 0) * 0.01); // 每层每秒 = 攻击力1%
      const chosenType = stats.attackType || 'magic'; // 可选的那 50% 伤害类型

      for (const enemy of enemies) {
        if (!enemy.alive) continue;

        // 中毒A：可选伤害类型（默认魔法），最多50层
        ctx.effectRegistry.apply(enemy.id, {
          name: '腐蚀·毒素', icon: '🧪', kind: 'dot', color: '#7bc96f', type: 'debuff',
          damageType: chosenType,
          flatValue: perStackDmg, perStackFlat: perStackDmg,
          tickInterval: 1, duration: 5,
          stackable: true, maxStacks: 50, stackPolicy: 'stack', uniquePassive: true,
          descTemplate: `唯一被动——腐蚀·毒素：每秒（【{val}】=攻击力1%×层数）${chosenType==='magic'?'魔法':chosenType==='physical'?'物理':'真实'}伤害，最多50层。`,
          description: '毒素（{stacks}/50层）',
        }, 'weapon_corrosion_poisonA', { casterId: entityId });

        // 中毒B：固定真实伤害，最多50层
        ctx.effectRegistry.apply(enemy.id, {
          name: '腐蚀·剧毒', icon: '☠️', kind: 'dot', color: '#8e6b2a', type: 'debuff',
          damageType: 'true',
          flatValue: perStackDmg, perStackFlat: perStackDmg,
          tickInterval: 1, duration: 5,
          stackable: true, maxStacks: 50, stackPolicy: 'stack', uniquePassive: true,
          descTemplate: '唯一被动——腐蚀·剧毒：每秒（【{val}】=攻击力1%×层数）真实伤害，最多50层。',
          description: '剧毒（{stacks}/50层）',
        }, 'weapon_corrosion_poisonB', { casterId: entityId });

        // 减速（每层7%，上限35% = 5层）—— 独立效果
        ctx.effectRegistry.apply(enemy.id, {
          name: '腐蚀·迟缓', icon: '🐌', kind: 'stat', color: '#7bc96f', type: 'debuff',
          statKey: 'moveSpeed', percentValue: -7, perStackPercent: -7,
          duration: 5, stackable: true, maxStacks: 5, stackPolicy: 'stack', uniquePassive: true,
          descTemplate: '唯一被动——腐蚀·迟缓：移速降低（【{val}%】=-7%×层数），上限-35%。',
          description: '减速（{stacks}/5层）',
        }, 'weapon_corrosion_slow');

        // 减攻速（每层2.5%，上限75% = 30层）—— 独立效果，负值不受收益率影响
        ctx.effectRegistry.apply(enemy.id, {
          name: '腐蚀·衰弱', icon: '🌿', kind: 'stat', color: '#7bc96f', type: 'debuff',
          statKey: 'bonusAttackSpeedPct', flatValue: -2.5, perStackFlat: -2.5,
          duration: 5, stackable: true, maxStacks: 30, stackPolicy: 'stack', uniquePassive: true,
          descTemplate: '唯一被动——腐蚀·衰弱：攻速降低（【{val}%】=-2.5%×层数），上限-75%。',
          description: '衰弱（{stacks}/30层）',
        }, 'weapon_corrosion_atkslow');
      }
    },
  },
};
