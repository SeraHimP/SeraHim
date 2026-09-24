import { CONFIG } from '../../data/Config.js';

/**
 * Q6：重甲联防计层口径——"正在攻击本塔"的敌人：以本塔为目标（targetId 匹配）
 * 且本塔已进入该敌人的攻击射程（即它已停下开打或下一步就开打）。
 * 路过的、在射程外追击别人的敌人不再计层。
 */
function _countTowerAttackers(entity, ctx) {
  // 2026-09-19：这张白名单原来漏了 'ram'（攻城车）——正是最该被联防计层记住的
  // 那类贴脸打塔单位——补上时一并加上新增的 'heavy'（重装车，塔攻击优先级
  // 最高，天然是这条被动最该盯防的对象，漏掉它这条被动等于形同虚设）。
  const nearby = ctx.entityContainer.findInRadius(entity.pos.x, entity.pos.y, 260,
    ['melee', 'ranged', 'siege', 'super', 'totem', 'shield', 'warlock', 'corrupt', 'ram', 'heavy', 'summoner', 'dragon'], true);
  let n = 0;
  for (const m of nearby) {
    if (m.targetId !== entity.id) continue;
    const r = (m.baseStats && m.baseStats.attackRange) || 20;
    const dx = m.pos.x - entity.pos.x, dy = m.pos.y - entity.pos.y;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

// v35（Q5）："加固城防"节点封顶——恢复只能回到当前血量所在区间的上界节点。
// 节点 [0.4,0.67,1.0]：血量 35% → 封顶 40%；55% → 67%；80% → 满血。恰好在节点上 = 停在节点。
// 实现：被动 onFrame 节流更新 entity._regenCapHP，CombatSystem 恢复结算读它。
// v36 Q1：节点封顶重算（onEquip 与 onFrame 共用；修"getDisplayValue 初始显示0"的 bug）
function _fortifyRecalc(entityId, instance, ctx, nodes, meta) {
  const e = ctx.entityContainer.get(entityId);
  if (!e || !e.alive) return;
  const maxHP = ctx.attrCalc.calc(e, ctx.effectRegistry.getEffects(e.id)).maxHP || e.baseStats.maxHP || 1;
  const p = e.currentHP / maxHP;
  let node = nodes[nodes.length - 1];
  for (const n of nodes) { if (p <= n + 1e-6) { node = n; break; } }
  e._regenCapHP = node * maxHP;
  instance.state._capPct = Math.round(node * 100);

  // ==================== 生命恢复也在这里刷，不在 onEquip ====================
  // 用户定稿把恢复数值挪到了地图层（"扭曲丛林水晶塔1.5，枢纽塔10；嚎哭深渊所有塔无生命恢复"），
  // 靠 map.skillOverrides 覆写 defaultParams.regen 实现。而 _params 是 **CombatSystem 在
  // 第一帧才注入**的 —— onEquip 那会儿还读不到，写死在闭包里的 regen 会赢。
  // 所以恢复效果跟着 onFrame 刷（0.3s 一次，refresh 策略会同步 flatValue，幂等）。
  if (!meta) return;
  const regen = (instance._params && typeof instance._params.regen === 'number')
    ? instance._params.regen : meta.regen;
  const id = meta.id;
  if (regen > 0) {
    ctx.effectRegistry.apply(entityId, {
      name: meta.name, icon: meta.icon, kind: 'stat', statKey: 'healthRegen', flatValue: regen,
      duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
      description: `生命恢复+${regen}（恢复不超过生命值节点 ${meta.nodesTxt}）`,
    }, id + '_regen');
  } else {
    // 覆写成 0（嚎哭深渊）时要把已经挂上的那条摘掉，否则出厂值会一直留在身上
    for (const eff of ctx.effectRegistry.getEffects(entityId)) {
      if (eff.blueprint.name === meta.name && eff.blueprint.statKey === 'healthRegen') {
        ctx.effectRegistry.remove(eff.id);
      }
    }
  }

  // ==================== v51.26：前期城防（开局限时护甲/魔抗）收进技能本身 ====================
  // 原来是召唤师峡谷地图数据里一条独立的 tierEffects.outer，只要这张图的外塔一生成
  // 就无条件糊上，跟这座塔到底有没有装"加固城防"技能完全无关——哪怕编辑器把外塔的
  // 加固城防拆了，这层前期加成照样在。用户定稿："前期城防整个到技能里面，不再默认
  // 装配在地图上，只有加固城防的技能的塔才会有这个开局加成"。
  // 数值走跟 regen 同一套 defaultParams + map.skillOverrides 覆写通道（召唤师峡谷在
  // summoners_rift.js 里把 earlyDefenseBonus/earlyDefenseDuration 覆写成 25/600，
  // 其它地图/其它层级维持出厂默认 0 = 不生效）。
  //
  // 跟 regen 不一样的地方：这是个**限时**buff（到点就该真的消失，不是一直续满），
  // 不能像 regen 那样每 0.3s 都 apply 一次——effectRegistry 的 stackPolicy:'refresh'
  // 会把每次 apply 都当成"续满剩余时间"，0.3s 刷一次等于永远续满、事实上变成永久。
  // 所以只在【第一次算出覆写值】时 apply 一次（instance.state 记一次性标记），
  // 之后交给 duration 自己倒计时到期——跟 onEquip 不能直接做这件事的原因一样：
  // onEquip 那一刻 instance._params 还没被 CombatSystem 注入地图覆写值，写死在
  // 闭包里的出厂默认（0）会赢，读不到召唤师峡谷的 25/600。
  if (!instance.state._earlyDefenseApplied) {
    instance.state._earlyDefenseApplied = true;
    const bonus = (instance._params && typeof instance._params.earlyDefenseBonus === 'number')
      ? instance._params.earlyDefenseBonus : meta.earlyDefenseBonus;
    const dur = (instance._params && typeof instance._params.earlyDefenseDuration === 'number')
      ? instance._params.earlyDefenseDuration : meta.earlyDefenseDuration;
    if (bonus > 0) {
      const mins = Math.round(dur / 60);
      ctx.effectRegistry.apply(entityId, {
        name: '前期城防', icon: '🧱', kind: 'stat', statKey: 'armor', flatValue: bonus,
        duration: dur, stackable: false, stackPolicy: 'refresh',
        description: `开局前${mins}分钟：护甲+${bonus}`,
      }, id + '_early_armor');
      ctx.effectRegistry.apply(entityId, {
        name: '前期城防', icon: '🧱', kind: 'stat', statKey: 'magicResist', flatValue: bonus,
        duration: dur, stackable: false, stackPolicy: 'refresh',
        description: `开局前${mins}分钟：魔法抗性+${bonus}`,
      }, id + '_early_mr');
    }
  }
}

function _makeFortify({ id, name, icon, regen, shield = 0, damageBlock = 0, nodes, tierLabel, earlyDefenseBonus = 0, earlyDefenseDuration = 600 }) {
  const nodesTxt = nodes.map(n => Math.round(n * 100) + '%').join('/');
  // v37：regen 可为 0（外/内塔版加固城防：只有节点封顶，不提供恢复数值）
  // v51.27：damageBlock 可为 0（原来枢纽塔的+7格挡是无条件塔身固有属性，用户定稿
  // "移植到枢纽防御塔加固城防里"——挂上这条技能才有，跟 shield/regen 走同一套
  // "defaultParams 声明成员 0 = 不生效"的口径，只有枢纽版调用处传了 7）。
  const blockTxt = damageBlock > 0 ? `、${damageBlock}伤害格挡` : '';
  const regenTxt = regen > 0 ? `${tierLabel}获得${regen}生命恢复${shield ? `和${shield}固定护盾` : ''}${blockTxt}，` : `${tierLabel}拥有三个生命节点${blockTxt}，`;
  const meta = { id, name, icon, regen, nodesTxt, earlyDefenseBonus, earlyDefenseDuration };
  // v51.26：前期城防文案片段——出厂默认 earlyDefenseBonus=0 时不出现这句，
  // 只有地图覆写把它调大于 0（目前只有召唤师峡谷外塔）才会加上这句。
  const earlyTxt = (bonus, dur) => bonus > 0 ? `开局前${Math.round(dur / 60)}分钟额外获得${bonus}护甲和${bonus}魔法抗性，` : '';
  return {
    id, name, icon,
    category: 'passive',
    // 加固城防固定四个塔层各一份变体，永远只装在塔身上。
    applicableTypes: ['tower'],
    // 恢复数值可按地图覆写（map.skillOverrides['tower:base'].passive_base_fortify = { regen: 1.5 }）。
    // earlyDefenseBonus/earlyDefenseDuration 同理（召唤师峡谷外塔覆写成 25/600）。
    // 声明 defaultParams 才会被 CombatSystem 注入覆写 —— 见 _fortifyRecalc 里那段说明。
    defaultParams: { regen, earlyDefenseBonus, earlyDefenseDuration },
    // 文案跟着实际生效的 regen/earlyDefenseBonus 走，不写死出厂值（地图改了覆写值，面板必须跟着变）
    getDescTemplate: (entity, instance) => {
      const p = (instance && instance._params) || {};
      const r = typeof p.regen === 'number' ? p.regen : regen;
      const b = typeof p.earlyDefenseBonus === 'number' ? p.earlyDefenseBonus : earlyDefenseBonus;
      const d = typeof p.earlyDefenseDuration === 'number' ? p.earlyDefenseDuration : earlyDefenseDuration;
      const t = r > 0 ? `${tierLabel}获得${r}生命恢复${shield ? `和${shield}固定护盾` : ''}${blockTxt}，` : `${tierLabel}拥有三个生命节点${blockTxt}，`;
      return `唯一被动——${name}：${earlyTxt(b, d)}${t}生命恢复不超过生命值节点（{val}为当前封顶节点）。`;
    },
    description: `${earlyTxt(earlyDefenseBonus, earlyDefenseDuration)}${regenTxt}生命恢复不超过生命值节点（${nodesTxt}）。`,
    descTemplate: `唯一被动——${name}：${earlyTxt(earlyDefenseBonus, earlyDefenseDuration)}${regenTxt}生命恢复不超过生命值节点（{val}为当前封顶节点）。`,
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      // 这里挂的是**出厂值**（_params 要等 CombatSystem 第一帧才注入，读不到地图覆写），
      // 下一次 onFrame（≤0.3s）会用覆写值刷新它 —— 见 _fortifyRecalc 里那段说明。
      // 之所以仍然在 onEquip 挂一次：装备即生效，不留"第一帧没有恢复"的空窗。
      if (shield) {
        ctx.effectRegistry.apply(entityId, {
          name, icon, kind: 'stat', statKey: 'shieldFixedMax', flatValue: shield,
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `固定护盾+${shield}`,
        }, id + '_shield');
      }
      // v51.27：枢纽塔的+7格挡从"塔身固有属性"移植成这条技能自带的效果——装了
      // 才有，卸了就没有（onUnequip 靠同一个 name 一并摘除，见下方那段）。
      if (damageBlock) {
        ctx.effectRegistry.apply(entityId, {
          name, icon, kind: 'stat', statKey: 'damageBlock', flatValue: damageBlock,
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `伤害格挡+${damageBlock}`,
        }, id + '_block');
      }
      _fortifyRecalc(entityId, instance, ctx, nodes, meta); // v36 Q1：装备即算初始节点（修显示 0 的 bug）
    },
    onFrame: (entityId, dt, instance, ctx) => {
      instance.state.t = (instance.state.t || 0) + dt;
      if (instance.state.t < 0.3) return;
      instance.state.t = 0;
      _fortifyRecalc(entityId, instance, ctx, nodes, meta);
    },
    onUnequip: (entityId, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (e) delete e._regenCapHP; // 卸下即解除封顶
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        // 前期城防（'前期城防'）跟这个变体自己的名字（如"外塔加固城防"）不是同一个
        // blueprint.name，卸下技能时要一起摘掉，不然拆了技能这层加成还留在身上。
        if (eff.blueprint.name === name || eff.blueprint.name === '前期城防') ctx.effectRegistry.remove(eff.id);
      }
    },
    getDisplayValue: (instance) => (instance.state?._capPct ?? 100) + '%',
  };
}

export const towerPassives = {
  // ==================== v35（Q5）：建筑默认被动 ====================
  // 背景：所有塔的地图默认 固定护盾/生命恢复 清零，改由下列可卸被动提供——
  // 数值进被动而不是裸 stats，面板可见、编辑器可拆、语义可扩展。

  // 水晶枢纽/召唤水晶：+10 恢复（名字"水晶再生"为实现补充，效果按用户字面）
  passive_nexus_regen: {
    id: 'passive_nexus_regen', name: '水晶再生', icon: '💠',
    applicableTypes: ['tower'],
    category: 'passive',
    description: '水晶枢纽/召唤水晶获得10生命恢复。',
    descTemplate: '唯一被动——水晶再生：水晶枢纽/召唤水晶获得10生命恢复。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      ctx.effectRegistry.apply(entityId, {
        name: '水晶再生', icon: '💠', kind: 'stat', statKey: 'healthRegen', flatValue: 10,
        duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: '生命恢复+10',
      }, 'passive_nexus_regen');
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '水晶再生') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  // v37（Q1）：外/内塔加固城防——纯节点封顶（33/67/100%），不提供恢复数值。
  // 塔本身默认 0 恢复，节点约束的是玩家外挂的恢复来源（编辑器加的恢复/光环等）。
  passive_outer_fortify: _makeFortify({
    id: 'passive_outer_fortify', name: '外塔加固城防', icon: '🏯',
    regen: 0, nodes: [0.33, 0.67, 1.0], tierLabel: '外塔',
  }),
  passive_inner_fortify: _makeFortify({
    id: 'passive_inner_fortify', name: '内塔加固城防', icon: '🏯',
    regen: 0, nodes: [0.33, 0.67, 1.0], tierLabel: '内塔',
  }),

  // 枢纽塔：+5 恢复，节点 40/70/100%
  // v51.27：+7伤害格挡从塔身固有属性（tierStats.hq_tower.damageBlock）移植过来
  // ——用户定稿"枢纽防御塔固有属性+7伤害格挡删除，移植到枢纽防御塔加固城防里"。
  passive_hq_fortify: _makeFortify({
    id: 'passive_hq_fortify', name: '枢纽防御塔加固城防', icon: '🏯',
    regen: 3, damageBlock: 7, nodes: [0.40, 0.70, 1.0], tierLabel: '枢纽防御塔', // 用户定稿：5→3
  }),

  // 水晶塔：+2 恢复 + 800 固定护盾，节点 33/67/100%
  passive_base_fortify: _makeFortify({
    id: 'passive_base_fortify', name: '水晶防御塔加固城防', icon: '🏯',
    regen: 1, nodes: [0.33, 0.67, 1.0], tierLabel: '水晶防御塔', // 用户定稿：2→1（800盾早前已拆为独立技能）
  }),

  // v51.4：passive_base_bulwark（水晶塔版"钢铁烈阳护盾"，+800 固定护盾、仅自身）
  // 已删除。用户："塔的烈阳钢铁护盾等，这个我记得有俩，把其中那个+800固定护盾的
  // 删除。"——同名技能只留 passive_inner_bulwark（300 范围光环、+50，自己及友军）
  // 这一份，不再有两条同名不同效果的"钢铁烈阳护盾"。

  // 内塔：钢铁烈阳护盾——300 范围光环，自己及友军 +50 护盾，离开范围脱落
  // v51.6 修复：用户"钢铁烈阳护盾的固定护盾改为护盾"——原来挂的是 kind:'stat'
  // + statKey:'shieldFixedMax'，走的是【固定护盾】那一档（脱战 N 秒后自动回满）。
  // 光环每 0.3 秒重新 apply 一次，只要站在范围内就相当于不断刷新回满，等于变相
  // 白嫖了一份"永远满盾"，这正是用户嫌它太强的根子。改成 kind:'shield'（第三种
  // "护盾"：不衰减、不回复，见 EffectRegistry._recalcEffectValues 的头注）之后，
  // 光环持续照常刷新"还在范围内"这件事（duration 不断续），但 shieldRemaining
  // 不会被刷新顶满——真的被打没了就没了，只有【先离开范围超过宽限期、效果消失，
  // 再重新进入】才会拿到一份新的满值护盾。
  passive_inner_bulwark: {
    id: 'passive_inner_bulwark', name: '钢铁烈阳护盾', icon: '☀️',
    applicableTypes: ['tower'],
    category: 'passive',
    // 追加需求 Q4 修正：用户之前"召唤师峡谷内塔默认+800护盾"我理解错了——不是把
    // 整条光环（自身+友军共用同一个数）从 50 拉到 800，而是塔自己单独多领两笔
    // （+800护盾、+50固定护盾），分享给友军的那部分仍然是原来的 +50护盾，不变。
    // 用户原话："正确的应该是：内塔+800护盾，+50固定护盾。给周围友军单位+50护盾。"
    // 三个数字分成三个 defaultParams，才能各自被地图级 skillOverrides 覆写——
    // 召唤师峡谷在 summoners_rift.js 里把 selfPlainValue/selfFixedValue 覆写成
    // 800/50，allyPlainValue 留着默认 50 不动；其它地图的内塔三项都还是出厂默认，
    // 不受影响。沿用 passive_*_fortify 那套"声明 defaultParams 才会被注入覆写"的
    // 既有机制，不新造属性、不新造机制。
    defaultParams: { selfPlainValue: 50, selfFixedValue: 0, allyPlainValue: 50 },
    description: '为自己提供护盾（可能还有固定护盾），并对附近（300范围）友军提供护盾，友军离开防御塔过远护盾消失。',
    descTemplate: '唯一被动——钢铁烈阳护盾：自身护盾+50，对附近（300范围）友军提供50护盾，离开范围后护盾消失。',
    getDescTemplate: (entity, instance) => {
      const p = (instance && instance._params) || {};
      const selfPlain = typeof p.selfPlainValue === 'number' ? p.selfPlainValue : 50;
      const selfFixed = typeof p.selfFixedValue === 'number' ? p.selfFixedValue : 0;
      const allyPlain = typeof p.allyPlainValue === 'number' ? p.allyPlainValue : 50;
      const selfTxt = selfFixed > 0 ? `自身护盾+${selfPlain}、固定护盾+${selfFixed}` : `自身护盾+${selfPlain}`;
      return `唯一被动——钢铁烈阳护盾：${selfTxt}，对附近（300范围）友军提供${allyPlain}护盾，离开范围后护盾消失。`;
    },
    effects: [],
    onFrame: (entityId, dt, instance, ctx) => {
      instance.state.t = (instance.state.t || 0) + dt;
      if (instance.state.t < 0.3) return;
      instance.state.t = 0;
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return;
      const p = instance._params || {};
      const selfPlain = typeof p.selfPlainValue === 'number' ? p.selfPlainValue : 50;
      const selfFixed = typeof p.selfFixedValue === 'number' ? p.selfFixedValue : 0;
      const allyPlain = typeof p.allyPlainValue === 'number' ? p.allyPlainValue : 50;

      // 自身：护盾（不衰减不回复）——永久效果（自己不存在"离开自己范围"这回事），
      // 每 0.3s 重新 apply 一次只是让数值随地图覆写实时跟上，refresh 策略下
      // shieldRemaining 不会被顶满（EffectRegistry._recalcEffectValues 的 delta
      // 更新逻辑，见该函数头注），"不会自动回复"这条不受影响。
      ctx.effectRegistry.apply(self.id, {
        name: '钢铁烈阳护盾', icon: '☀️', kind: 'shield', flatValue: selfPlain,
        duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `护盾+${selfPlain}（自身）`,
      }, 'inner_bulwark_self_plain');
      // 自身：固定护盾（脱战一段时间后自动回满）——只有配了 selfFixedValue>0 才挂，
      // 避免所有没配这项的地图/塔白挂一条 flatValue:0 的空效果占状态栏格子。
      if (selfFixed > 0) {
        ctx.effectRegistry.apply(self.id, {
          name: '钢铁烈阳护盾', icon: '☀️', kind: 'stat', statKey: 'shieldFixedMax', flatValue: selfFixed,
          duration: 0, permanent: true, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `固定护盾+${selfFixed}（自身，脱战一段时间后自动回满）`,
        }, 'inner_bulwark_self_fixed');
      }
      // 友军：300 范围光环，护盾（不衰减不回复），离开范围超过宽限期后消失。
      for (const ally of ctx.entityContainer.findInRadius(self.pos.x, self.pos.y, 300, null, true)) {
        if (ally.id === self.id || !ally.alive) continue;
        if ((ally._mapFaction || ally.faction) !== self._mapFaction) continue;
        ctx.effectRegistry.apply(ally.id, {
          name: '钢铁烈阳护盾', icon: '☀️', kind: 'shield', flatValue: allyPlain,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: `护盾+${allyPlain}（内塔光环）`,
        }, 'inner_bulwark_ally');
      }
    },
  },

  // ==================== v51.27：枢纽塔版"钢铁烈阳护盾"（脱战定期回盾）====================
  // 用户："召唤师峡谷，枢纽他新增钢铁烈阳护盾技能，但是和内塔的不同，枢纽塔的为：
  //        脱离战斗状态后，每15秒获得70护盾（最高350）。"
  // 与内塔那份（300范围光环+固定护盾）机制完全不同——这条是"自身定期回盾"。
  // "脱离战斗状态"的判据**不用** entity._inCombat/_combatTimer——那个只在这座塔
  // 自己主动攻击时才置真（performAttack/performAttackDirect 只标记 attacker），
  // 塔被打但没还手（比如没目标、正在换目标）时不会置真，语义是"攻击者视角"。
  // 这里要的是"防御方视角"的脱战：跟已有的固定护盾回满机制
  // （CombatSystem 里 entity.lastDamageTime + CONFIG.gameRules.shieldRegenDelay，
  // 见 performAttack/performAttackDirect 结算处 `target.lastDamageTime = ...` 和
  // 上面 `shieldMax > 0` 那段）完全同一个判据——只要有段时间没挨打就算脱战，
  // 不管这座塔自己有没有在还手，两条"脱战回X"机制口径统一。
  // 护盾用 kind:'shield'（不衰减不回复，见 EffectRegistry._recalcEffectValues 的
  // 头注）——**靠框架原生的 stackPolicy:'stack' + perStackFlat 叠层机制**攒护盾
  // 上限，每 15s 脱战就在同一个 sourceId 上叠一层（flatValue/perStackFlat 都固定
  // 是 perTick，永不改变；层数上限 maxStacks=cap/perTick），totalFlat（=当前护盾
  // 上限）由 EffectRegistry 自己按层数算，不用像"直接改写 flatValue 到累计值"那样
  // 自己维护一个会无限增长的数字。
  // 这不只是少写代码——sim_skilldesc.mjs 会抓"技能实际施加的每个数值"去反查能不能从
  // 静态文案里解释出来，如果 flatValue 直接写成累计值（70→140→210→…），文案就得
  // 把每一个可能出现的中间值都列出来，根本不可能维护。用叠层，施加的 flatValue
  // 永远只有 perTick 这一个数字（=70，文案里现成写着），累计值是引擎内部算出来的
  // 派生量，不需要在文案里单独解释——跟 passive_growth_*/passive_frost_plating
  // 这些"会成长"的被动是同一个道理，见它们 perStackFlat 的用法。
  // 脱战计时器一旦被打断（挨打）立刻清零重算（不是"暂停"，用户原话是"脱离战斗
  // 状态后每15秒"，没打断才计这 15 秒）。已经攒到手的护盾不会因为重新挨打而消失
  // （已叠的层数不会因为战斗状态变化而掉层，只是不再新增层）。
  passive_hq_bulwark: {
    id: 'passive_hq_bulwark', name: '钢铁烈阳护盾', icon: '☀️',
    applicableTypes: ['tower'],
    category: 'passive',
    defaultParams: { perTick: 70, cap: 350, tickInterval: 15 },
    description: '脱离战斗状态后，每15秒获得70护盾（不衰减不回复，最高叠加至350）。',
    descTemplate: '唯一被动——钢铁烈阳护盾：脱离战斗状态后，每15秒获得70护盾（{val}为当前护盾上限，最高350）。',
    getDescTemplate: (entity, instance) => {
      const p = (instance && instance._params) || {};
      const perTick = typeof p.perTick === 'number' ? p.perTick : 70;
      const cap = typeof p.cap === 'number' ? p.cap : 350;
      const interval = typeof p.tickInterval === 'number' ? p.tickInterval : 15;
      return `唯一被动——钢铁烈阳护盾：脱离战斗状态后，每${interval}秒获得${perTick}护盾（{val}为当前护盾上限，最高${cap}）。`;
    },
    computeCurrent: (entity, ctx) => {
      const eff = ctx.effectRegistry?.getEffects(entity.id).find(e => e.sourceId === 'passive_hq_bulwark');
      return Math.round(eff?.totalFlat || 0);
    },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.timer = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive) return;
      const p = instance._params || {};
      const perTick = typeof p.perTick === 'number' ? p.perTick : 70;
      const cap = typeof p.cap === 'number' ? p.cap : 350;
      const interval = typeof p.tickInterval === 'number' ? p.tickInterval : 15;
      const maxStacks = Math.max(1, Math.floor(cap / perTick));
      // v51.20：`instance.state || (instance.state = {...})` 是危险写法，见
      // weapons.js weapon_corrosion 头注同一条说明；换成本文件 passive_heavy_defense
      // 已经在用的正确判据，onEquip 已经真初始化过 timer，这里不会实际触发。
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      const state = instance.state;
      // 脱战判据跟固定护盾回满共用同一套（lastDamageTime + shieldRegenDelay），
      // 见上方大段注释——挨打就清零重算，不管这座塔自己有没有在还手。
      const now = window.gameTime || 0;
      const lastDamage = self.lastDamageTime ?? -Infinity;
      const regenDelay = CONFIG.gameRules?.shieldRegenDelay ?? 8;
      if (now - lastDamage < regenDelay) { state.timer = 0; return; }
      // bug 修复：用户报"层数满了之后，护盾被打没了也不会再恢复"。根因是原来的
      // 判据用【层数】（curStacks() >= maxStacks）当"护盾已满"的替身——层数只是
      // EffectRegistry 用来推导护盾【上限】（totalFlat）的记账方式，层数封顶后
      // totalFlat 就不再变化，_recalcEffectValues 的 shield delta 机制（护盾余量
      // 按 totalFlat 的变化量增减）从此再也不会被触发，于是层数封顶之后哪怕护盾
      // 被打光了，也永远等不到"层数变化"这个唯一能让余量回涨的时机——这就是"层数
      // 满了就再也不回复"的真根因，不是脱战判定的问题。
      // 改法：判据从"层数是否封顶"换成"当前护盾余量是否已经到 cap"。层数没封顶时
      // 走法照旧（apply() 叠层，delta 机制自动把新增量并进余量）；层数已经封顶、
      // 但余量被打低于 cap 时，直接把余量按 perTick 顶回去（封顶 cap）——这种情况
      // totalFlat 已经不会再变，只能直接改 shieldRemaining，没有绕开的办法。
      const curEff = () => ctx.effectRegistry.getEffects(entityId).find(e => e.sourceId === 'passive_hq_bulwark');
      if ((curEff()?.shieldRemaining || 0) >= cap) return;
      state.timer = (state.timer || 0) + dt;
      // while 而不是单次 if：dt 偶尔会很大（掉帧、长时间没挨打后一次性补齐），
      // 用 if 只扣一次会悄悄漏掉本该到账的那几跳（对比 passive_overload 同类做法）。
      while (state.timer >= interval && (curEff()?.shieldRemaining || 0) < cap) {
        state.timer -= interval;
        const existing = curEff();
        if (!existing || existing.stacks < maxStacks) {
          // 还没建立过效果，或层数没封顶：正常走叠层，delta 机制自动把新增量
          // 并入护盾余量（与改动前完全一样的路径，未封顶阶段行为不变）。
          ctx.effectRegistry.apply(entityId, {
            name: '钢铁烈阳护盾', icon: '☀️', kind: 'shield', flatValue: perTick, perStackFlat: perTick,
            duration: 0, permanent: true, stackable: true, maxStacks, stackPolicy: 'stack', uniquePassive: true,
            description: `护盾（脱战每${interval}秒+${perTick}，最高${cap}）`,
          }, 'passive_hq_bulwark');
        } else {
          // 层数已封顶（totalFlat=cap 不会再变）但余量被打低了——直接顶余量。
          existing.shieldRemaining = Math.min(cap, (existing.shieldRemaining || 0) + perTick);
        }
      }
    },
    onUnequip: (entityId, instance, ctx) => {
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '钢铁烈阳护盾' && eff.sourceId === 'passive_hq_bulwark') ctx.effectRegistry.remove(eff.id);
      }
    },
  },

  passive_heavy_defense: {
    id: 'passive_heavy_defense',
    applicableTypes: ['tower'],
    name: '重甲联防',
    icon: '🤝',
    category: 'passive',
    // v51.5：新增韧性联动（用户："重甲联防加韧性"，"可以"）——被围攻时不只扛得住
    // 输出，也该更扛得住控制（否则双抗再高也架不住一个眩晕连招）。系数与双抗那条
    // 同一个"×攻击者数"节奏，但封顶低得多（40% 而不是 100%）：韧性是按比例
    // 缩短控制时长，拉到 100% 就等于控制免疫，太强；具体数字后续按对局观感再调。
    descTemplate: '唯一被动——重甲联防：每个正在攻击本塔的敌人提供（{val}=+5×攻击者数）双抗，上限100；同时获得（+2×攻击者数）韧性，上限40%。',
    computeCurrent: (entity, ctx) => {
      return Math.min(_countTowerAttackers(entity, ctx) * 5, 100);
    },
    description: '每个正在攻击本塔的敌人+5双抗（上限100）、+2%韧性（上限40%）（Q6：仅统计以本塔为目标且已进入其攻击射程的敌人）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      // v51.20：与上方 onEquip 用同一条正确判据（原来这里另写了一份危险的
      // `instance.state || (instance.state = {...})`，见 weapon_corrosion 头注）。
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0 };
      const state = instance.state;
      state.timer = (state.timer || 0) + dt;
      if (state.timer < 0.2) return; // 轻量节流：每0.2秒检查一次即可，视觉上无感知差异
      state.timer = 0;

      const attackers = _countTowerAttackers(entity, ctx);
      const bonus = Math.min(attackers * 5, 100);

      if (bonus > 0) {
        const enemyCount = Math.min(attackers, 20);
        // 条件持续效果：conditional:true → 不倒计时、常驻显示；每帧刷新数值。
        // stackable:true 仅用于让右下角徽标显示"层数"（=附近敌人数），非真实叠层机制。
        const armorId = ctx.effectRegistry.apply(entityId, {
          name: '重甲联防', icon: '🤝', kind: 'stat', statKey: 'armor',
          flatValue: bonus, duration: Infinity, permanent: true, conditional: true,
          stackable: true, maxStacks: 20, stackPolicy: 'refresh', uniquePassive: true,
          descTemplate: '唯一被动——重甲联防：附近敌人提供（{val}=+5×敌人数）双抗，上限100。',
          description: `护甲+${bonus}`,
        }, 'passive_heavy_defense_armor');
        const armorEff = ctx.effectRegistry.getEffect(armorId);
        if (armorEff) armorEff.stacks = enemyCount;

        const mrId = ctx.effectRegistry.apply(entityId, {
          name: '重甲联防', icon: '🤝', kind: 'stat', statKey: 'magicResist',
          flatValue: bonus, duration: Infinity, permanent: true, conditional: true,
          stackable: true, maxStacks: 20, stackPolicy: 'refresh', uniquePassive: true,
          description: `魔法抗性+${bonus}`,
        }, 'passive_heavy_defense_mr');
        const mrEff = ctx.effectRegistry.getEffect(mrId);
        if (mrEff) mrEff.stacks = enemyCount;

        const tenBonus = Math.min(attackers * 2, 40);
        const tenId = ctx.effectRegistry.apply(entityId, {
          name: '重甲联防', icon: '🤝', kind: 'stat', statKey: 'tenacityPct',
          flatValue: tenBonus, duration: Infinity, permanent: true, conditional: true,
          stackable: true, maxStacks: 20, stackPolicy: 'refresh', uniquePassive: true,
          description: `韧性+${tenBonus}%`,
        }, 'passive_heavy_defense_tenacity');
        const tenEff = ctx.effectRegistry.getEffect(tenId);
        if (tenEff) tenEff.stacks = enemyCount;
      } else {
        // 条件不满足（没有敌人）→ 移除效果
        for (const src of ['passive_heavy_defense_armor', 'passive_heavy_defense_mr', 'passive_heavy_defense_tenacity']) {
          const eff = ctx.effectRegistry.getEffects(entityId).find(e => e.sourceId === src);
          if (eff) ctx.effectRegistry.remove(eff.id);
        }
      }
    },
  },

  passive_thorns: {
    id: 'passive_thorns',
    applicableTypes: ['tower'],
    name: '荆棘反击',
    icon: '⚔️',
    category: 'passive',
    // v51.5：新增法术强度联动（用户："荆棘反击加法术强度联动"，"可以"）——
    // 反弹伤害本身是魔法伤害，让法术强度这条以前对塔完全没用武之地的属性
    // （只能靠龙魂/冰霜镀层拿到）也能在这条被动上体现出来。系数 0.5 取中庸值：
    // 具体数字不是这次要锁死的，后续按对局观感再调。
    descTemplate: '唯一被动——荆棘反击：被攻击时反弹（{val}=3+护甲×7%+法术强度×50%）魔法伤害。',
    computeCurrent: (entity, ctx) => {
      const s = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      return Math.round(3 + (s.armor || 0) * 0.07 + (s.abilityPower || 0) * 0.5);
    },
    description: '被攻击时反弹（3+护甲×7%+法术强度×50%）魔法伤害。',
    effects: [],
    onBeingAttacked: (targetId, attackerId, instance, ctx) => {
      const target = ctx.entityContainer.get(targetId);
      const attacker = ctx.entityContainer.get(attackerId);
      if (!target || !attacker || !target.alive || !attacker.alive) return;
      const atkStats = ctx.attrCalc.calc(target, ctx.effectRegistry.getEffects(target.id));
      const reflectDmg = 3 + (atkStats.armor || 0) * 0.07 + (atkStats.abilityPower || 0) * 0.5;
      if (ctx.combat) {
        ctx.combat.performAttackDirect(targetId, attackerId, reflectDmg, 'magic', { _noProc: true });
      }
    },
  },

  passive_frost_plating: {
    id: 'passive_frost_plating',
    applicableTypes: ['tower'],
    name: '冰霜镀层',
    icon: '❄️',
    category: 'passive',
    // v51.5：新增法术强度——用户定稿"+3法术强度……注意不是百分比，是数值"，
    // 与其余四项（%攻击/护甲/魔抗/生命恢复）不同，是每层固定加 3 点，不是百分比。
    description: '每60秒叠1层，最多18层。每层+5%攻击、+2%双抗、+1.5%生命恢复、+3法术强度。',
    descTemplate: '唯一被动——冰霜镀层：防御塔每分钟获得额外属性（当前{val}层，最多18层），每层+5%攻击、+2%双抗、+1.5%生命恢复、+3法术强度。',
    computeCurrent: (entity, ctx) => { const e = ctx.effectRegistry.getEffectByName(entity.id, '冰霜镀层'); return e ? e.stacks : 0; },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.stacks = 0;
      instance.state.timer = 0;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state;
      state.timer += dt;
      if (state.timer >= 60 && state.stacks < 18) {
        state.timer -= 60;
        state.stacks++;
        const s = state.stacks;
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'attackDamage',
          percentValue: 5,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 5,
          stackPolicy: 'stack',
          permanent: true,
          description: `攻击力+${s*5}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'armor',
          percentValue: 2,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 2,
          stackPolicy: 'stack',
          permanent: true,
          description: `护甲+${s*2}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'magicResist',
          percentValue: 2,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 2,
          stackPolicy: 'stack',
          permanent: true,
          description: `魔法抗性+${s*2}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'healthRegen',
          percentValue: 1.5,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackPercent: 1.5,
          stackPolicy: 'stack',
          permanent: true,
          description: `生命恢复+${(s*1.5).toFixed(1)}%`,
        }, 'passive_frost_plating');
        ctx.effectRegistry.apply(entityId, {
          name: '冰霜镀层',
          icon: '❄️',
          kind: 'stat',
          statKey: 'abilityPower',
          flatValue: 3,
          duration: Infinity,
          stackable: true,
          maxStacks: 18,
          perStackFlat: 3,
          stackPolicy: 'stack',
          permanent: true,
          description: `法术强度+${s*3}`,
        }, 'passive_frost_plating');
      }
    },
  },

  passive_armor_plating: {
    id: 'passive_armor_plating',
    applicableTypes: ['tower'],
    name: '防御塔镀层',
    icon: '🛡️',
    category: 'passive',
    // v51.5：爆发重做（用户："防御塔镀层爆发重做，改为+33%伤害减免，持续10秒，
    // 不可叠加"）。原来是四项数值各自 20 秒、且四次破裂各开一份互相叠加
    // （最多同时挂 4 份 +70双抗/+70魔抗/+100%攻速/远程减伤17%），越到后期越离谱。
    // 现在收成一条纯粹的伤害减免、10 秒、不可叠加——用同一个 sourceId + refresh
    // 策略实现"不可叠加"：再破一层只是把剩余时间刷新回 10 秒，数值不会累加。
    // 永久那部分（生命跌破阈值各 +25 双抗，最多4层）不受影响，逐位保留。
    description: '生命值跌破80%/60%/40%/20%时破裂，永久+25双抗；同时触发10秒的+33%伤害减免（不可叠加，再次触发只刷新剩余时间）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.broken = [false, false, false, false];
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const entity = ctx.entityContainer.get(entityId);
      if (!entity || !entity.alive) return;
      const state = instance.state;
      const thresholds = [0.8, 0.6, 0.4, 0.2];
      const finalStats = ctx.attrCalc.calc(entity, ctx.effectRegistry.getEffects(entity.id));
      const maxHP = finalStats.maxHP;
      const hpRatio = entity.currentHP / maxHP;

      for (let i = 0; i < thresholds.length; i++) {
        if (!state.broken[i] && hpRatio <= thresholds[i]) {
          state.broken[i] = true;
          const brokenCount = state.broken.filter(Boolean).length;
          // 唯一被动：护甲/魔抗各只一个图标，层数=已破裂数（stackKey 固定 + uniquePassive）
          const armorEff = ctx.effectRegistry.apply(entityId, {
            name: '镀层破裂', icon: '🔰', kind: 'stat', statKey: 'armor',
            flatValue: 25, perStackFlat: 25, duration: Infinity, permanent: true,
            stackable: true, maxStacks: 4, stackPolicy: 'stack', uniquePassive: true,
            descTemplate: '唯一被动——镀层破裂：生命跌破阈值永久获得（{val}=+25×破裂数）护甲。',
            description: '永久护甲提升（{stacks}/4层）',
          }, 'passive_armor_plating_perm_armor');
          const ae = ctx.effectRegistry.getEffect(armorEff);
          if (ae) { ae.stacks = brokenCount; ctx.effectRegistry._recalcEffectValues(ae); ctx.effectRegistry._updateDescription(ae); }

          const mrEff = ctx.effectRegistry.apply(entityId, {
            name: '镀层破裂', icon: '🔰', kind: 'stat', statKey: 'magicResist',
            flatValue: 25, perStackFlat: 25, duration: Infinity, permanent: true,
            stackable: true, maxStacks: 4, stackPolicy: 'stack', uniquePassive: true,
            descTemplate: '唯一被动——镀层破裂：生命跌破阈值永久获得（{val}=+25×破裂数）魔法抗性。',
            description: '永久魔法抗性提升（{stacks}/4层）',
          }, 'passive_armor_plating_perm_mr');
          const me = ctx.effectRegistry.getEffect(mrEff);
          if (me) { me.stacks = brokenCount; ctx.effectRegistry._recalcEffectValues(me); ctx.effectRegistry._updateDescription(me); }

          // v51.5：爆发重做为单一效果，固定 sourceId + refresh 策略 = 不可叠加，
          // 再次破裂只刷新剩余时间到 10 秒，不会像旧版四项数值那样越破越离谱。
          ctx.effectRegistry.apply(entityId, {
            name: '镀层爆发', icon: '💥', kind: 'stat', statKey: 'damageReduction',
            flatValue: 33, duration: 10, stackable: false, stackPolicy: 'refresh',
            uniquePassive: true, description: '伤害减免+33%（10秒）',
          }, 'passive_armor_plating_burst');
        }
      }
    },
  },

  // v51.5：passive_overheat（过热核心）/passive_vampire（吸血鬼）/passive_phase
  // （相位领域）已删除——用户："过热核心删除。吸血鬼删除。相位领域删除。"
  // 这三条都是纯硬编码数值、完全没接入 v51 系列的属性框架（法术强度/技能增幅/
  // 暴击/统一吸血等），已经过时；结合现在的框架重新设计的新技能后续再补。

  // ==================== v51.5：钢铁防线（限时/永久二合一）====================
  // 用户："钢铁防线这种的，有永久的有持续多少秒的。都进行合并。就是技能的量化
  // （可视化）是在状态栏上显示的，可以设置这个技能持续多久或者是永久持续（类似
  // 直接添加状态那种）。"
  // 原来是两条几乎一样的技能：passive_iron_line（开局300秒内+33%减伤，到期自动
  // 脱落）与 passive_iron_line_ha（嚎哭深渊水晶塔专属，同样+33%但改成永久不过期，
  // 唯一区别就是"限时 vs 永久"这一个开关）。现在合并成一条，靠 defaultParams 里的
  // durationSec 决定——<=0 表示永久，正数表示限时秒数。durationSec 声明在
  // defaultParams 里，天然被"技能数值编辑器"（src/ui/editor/open.js 的
  // _skillsWithParams，逐条扫 SkillLibrary 里声明了 defaultParams 的技能）自动收录，
  // 不用再单独接一次 UI；地图想要"这张图上这条魂是永久的"，跟加固城防的 regen
  // 走同一套 map.skillOverrides 覆写机制即可（嚎哭深渊的水晶塔就是这么接的，
  // 见 src/data/maps/howling_abyss.js）。
  passive_iron_line: {
    id: 'passive_iron_line',
    applicableTypes: ['tower'],
    name: '钢铁防线',
    icon: '🛡️',
    category: 'passive',
    defaultParams: { durationSec: 300 },   // v39（节奏）：420→300s；<=0 表示永久
    getDescTemplate: (entity, instance) => {
      const sec = (instance && instance._params && typeof instance._params.durationSec === 'number')
        ? instance._params.durationSec : 300;
      return sec > 0
        ? `唯一被动——钢铁防线：开局${sec}秒内+33%伤害减免（效果面板显示剩余时间）。`
        : '唯一被动——钢铁防线：永久+33%伤害减免（常驻状态，不会过期）。';
    },
    description: '唯一被动——钢铁防线：开局300秒内格挡33%即将到来的伤害（+33%伤害减免状态，走效果系统，到期自动消失）。',
    descTemplate: '唯一被动——钢铁防线：开局300秒内+33%伤害减免（效果面板显示剩余时间）。',
    effects: [],
    // equipSkill()（core/skillParams.js）保证 onEquip 跑之前 instance._params 已经
    // 按"出厂值→全局覆写→地图覆写"三层解析完毕，这里可以直接读，不需要像老版
    // 加固城防那样再等一次 onFrame。
    onEquip: (entityId, instance, ctx) => {
      const sec = (instance._params && typeof instance._params.durationSec === 'number')
        ? instance._params.durationSec : 300;
      const permanent = sec <= 0;
      ctx.effectRegistry.apply(entityId, {
        name: '钢铁防线', icon: '🛡️', kind: 'stat', statKey: 'damageReduction', flatValue: 33,
        duration: permanent ? Infinity : sec, permanent,
        stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: permanent ? '格挡33%即将到来的伤害（永久）' : '格挡33%即将到来的伤害（开局保护期）',
      }, 'passive_iron_line');
    },
  },

  // ==================== v36（Q2）：过载 ====================
  // 两阶段自毁被动，起始时间按层级递增（外20/内30/水晶45/枢纽60 分钟）。
  //   第一阶段（X 分钟起）：每 30s 损失一次双抗，每次损失量递增（越往后掉得越狠）。
  //   第二阶段（X+5 分钟起）：额外每 30s 损失一次最大生命（当前血超上限一起削，可致死）。
  // 外侧塔损失系数更大（外>内>水晶>枢纽）。状态栏：进入过载后显示"过载"状态+距下次30s倒计时；
  // 未过载时只在技能栏显示本条被动。
  passive_overload: {
    id: 'passive_overload', name: '过载', icon: '💣',
    applicableTypes: ['tower'],
    category: 'passive',
    description: '唯一被动——过载：达到时限后每30秒损失固定双抗（外3/内2.5/水晶2/枢纽1.5）；再过5分钟后额外每30秒损失最大生命值（该项逐次递增）。越外侧的塔损失越多。',
    descTemplate: '唯一被动——过载：外塔20/内塔30/水晶塔45/枢纽塔60分钟起，每30秒损失双抗；再5分钟后额外损失最大生命值。当前 {val}。',
    // v42: dynamic descTemplate that respects per-map inst._params overrides
    getDescTemplate: function(entity, instance) {
      var def = towerPassives.passive_overload;
      var cfg = def._TIER_CFG[entity._mapTier];
      if (!cfg) return null;
      var p = instance?._params || {};
      var startMin = p.startMin ?? cfg.startMin;
      var phase2Delay = p.PHASE2_DELAY ?? def.PHASE2_DELAY;
      var resistBase = p.resistBase ?? cfg.resistBase;
      var phase2Min = startMin + (phase2Delay / 60);
      return '唯一被动——过载：' + startMin + '分钟起每30秒损失' + resistBase + '双抗；' + Math.round(phase2Min) + '分钟起额外损失最大生命值。当前 {val}。';
    },
    // 各层级：起始分钟 + 双抗每次基数 + 最大生命每次基数（占 maxHP 比例）
    _TIER_CFG: {
      outer:    { startMin: 20, resistBase: 3.0, hpPctBase: 0.015 },
      inner:    { startMin: 30, resistBase: 2.5, hpPctBase: 0.012 },
      base:     { startMin: 45, resistBase: 2.0, hpPctBase: 0.010 },
      hq_tower: { startMin: 60, resistBase: 1.5, hpPctBase: 0.008 },
    },
    RESIST_GROWTH: 1.15, // 每次双抗损失 ×1.15 递增
    HP_GROWTH: 1.12,     // 每次最大生命损失 ×1.12 递增
    INTERVAL: 30,        // 每 30 秒一跳
    PHASE2_DELAY: 300,   // 第二阶段延后 5 分钟（300s）
    // v42: empty defaultParams enables CombatSystem to inject per-map overrides into inst._params
    defaultParams: {},
    // 追加需求："过载状态里面添加最大生命值损失了多少。"——原来技能栏这条只写
    // "已过载（含最大生命损失）"，光看这行看不出具体扣了多少；实际数值
    // （st.hpLostTotal）其实已经在 onFrame 挂的那条【过载】状态效果描述里算出来了
    // （见下面 ctx.effectRegistry.apply 那段的 description），这里补上，两处口径
    // 一致，不是另算一份。
    computeCurrent: (entity, ctx) => {
      const inst = (entity._skillInstances || []).find(i => i.skillId === 'passive_overload');
      const st = inst?.state;
      if (!st || !st.phase1Started) return '未过载';
      if (!st.phase2Started) return '已过载';
      return `已过载（最大生命已损失 ${Math.round(st.hpLostTotal || 0)}）`;
    },
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.armorLost = 0;
      instance.state.mrLost = 0;
      instance.state.resistTicks = 0;
      instance.state.hpTicks = 0;
      instance.state.phase1Started = false;
      instance.state.phase2Started = false;
      instance.state.lastTickAt = 0;
    },
    onUnequip: (entityId, instance, ctx) => {
      // 移除已施加的双抗损失效果（最大生命是直接改 maxHP 基线，不撤销——已过载的塔卸下被动不回血）
      for (const eff of ctx.effectRegistry.getEffects(entityId)) {
        if (eff.blueprint.name === '过载') ctx.effectRegistry.remove(eff.id);
      }
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const e = ctx.entityContainer.get(entityId);
      if (!e || !e.alive) return;
      const def = towerPassives.passive_overload;
      const cfg = def._TIER_CFG[e._mapTier];
      // v42: per-map overload override via inst._params (flat params, set by CombatSystem from map skillOverrides)
      const pOver = instance._params || {};
      const tierCfg = { startMin: (pOver.startMin ?? cfg?.startMin ?? 99), resistBase: (pOver.resistBase ?? cfg?.resistBase ?? 0), hpPctBase: (pOver.hpPctBase ?? cfg?.hpPctBase ?? 0) };
      const ov_INTERVAL = pOver.INTERVAL ?? def.INTERVAL;
      const ov_PHASE2_DELAY = pOver.PHASE2_DELAY ?? def.PHASE2_DELAY;
      const ov_HP_GROWTH = pOver.HP_GROWTH ?? def.HP_GROWTH;
      if (!cfg) return; // 非分层塔（手动建的塔，没有 _mapTier）不过载

      const now = window.gameTime || 0;
      const startSec = tierCfg.startMin * 60;
      const st = instance.state;

      // 未到时限：只在技能栏显示，不做任何事，也不建状态
      if (now < startSec) return;

      if (!st.phase1Started) { st.phase1Started = true; st.lastTickAt = startSec - ov_INTERVAL; }
      const phase2At = startSec + ov_PHASE2_DELAY;
      if (!st.phase2Started && now >= phase2At) st.phase2Started = true;

      // 每 30s 一跳
      while (now - st.lastTickAt >= ov_INTERVAL) {
        st.lastTickAt += ov_INTERVAL;
        // v39（用户定稿）：双抗损失【固定不递增】，各层级保留自己的基数
        //（外3.0/内2.5/水晶2.0/枢纽1.5）。生命损失仍按原样递增（用户："过载还是扣最大生命上限"）。
        const rLoss = tierCfg.resistBase;
        st.resistTicks++;
        st.armorLost += rLoss;
        st.mrLost += rLoss;
        // 第二阶段：最大生命损失（递增，当前血超上限一起削→可致死）
        if (st.phase2Started) {
          // 损失量基于【原始】最大生命（st.maxHP0），不用当前正在缩水的 maxHP——
          // 否则 hpLoss 会随 maxHP 一起指数衰减，永远削不到 0（旧 bug：卡在 maxHP=1 不死）。
          if (st.maxHP0 === undefined) st.maxHP0 = e.baseStats.maxHP || 1;
          const hpLoss = st.maxHP0 * tierCfg.hpPctBase * Math.pow(ov_HP_GROWTH, st.hpTicks);
          st.hpTicks++;
          e.baseStats.maxHP = (e.baseStats.maxHP || st.maxHP0) - hpLoss;
          st.hpLostTotal = (st.hpLostTotal || 0) + hpLoss;
          if (e.currentHP > e.baseStats.maxHP) e.currentHP = e.baseStats.maxHP; // 削肉可致死
          if (e.baseStats.maxHP <= 0 || e.currentHP <= 0) {
            e.baseStats.maxHP = Math.max(0, e.baseStats.maxHP);
            if (e.alive) {
              e.alive = false; e.currentHP = 0;
              ctx.eventBus?.emit?.('entity:death', { entityId: e.id });
            }
          }
        }
      }

      // v39（用户定稿）：不再有独立的"过载中"条目。状态栏只保留一条【过载】，
      // 它自己的持续时间进度条 = 距下次过载跳动的 30s 倒计时（duration 设为剩余秒数，
      // 每帧刷新 → 进度环自然走完一圈再重置），说明文案全部集中到这一条。
      const nextIn = Math.max(0.1, ov_INTERVAL - (now - st.lastTickAt));

      // 施加双抗损失（负 flat 状态效果）。v39：主条目【过载】带 30s 倒计时进度条，
      // 说明集中于此；魔抗条 hidden 不单独占状态栏格子（数值照常生效）。
      const p2 = st.phase2Started;
      const cfgTxt = `每30秒 -${tierCfg.resistBase} 双抗`;
      ctx.effectRegistry.apply(entityId, {
        name: '过载', icon: '💣', kind: 'stat', statKey: 'armor', flatValue: -st.armorLost,
        duration: nextIn, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `过载（${cfgTxt}${p2 ? ' + 最大生命流失' : ''}）：已损双抗 -${Math.round(st.armorLost)}`
          + `${p2 ? `，已损最大生命 -${Math.round(st.hpLostTotal || 0)}` : ''}`
          + `　│　下次过载 ${Math.ceil(nextIn)}s`,
      }, 'passive_overload_armor');
      ctx.effectRegistry.apply(entityId, {
        name: '过载', icon: '💣', kind: 'stat', statKey: 'magicResist', flatValue: -st.mrLost,
        duration: nextIn, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        description: `过载：魔法抗性 -${Math.round(st.mrLost)}`, // 与 armor 条同名 → UI 自动合并为一个图标
      }, 'passive_overload_mr');

    },
  },
};

// ==================== Q2：防御塔成长（LoL 对齐，按建筑层级分技能） ====================
// 攻击力从 startT 起以 +9/分钟 线性推进至 capAD 封顶；内塔额外从 16:00 起双抗 +1/分钟（不封顶）。
// 全部走效果系统（stat 效果、每秒刷新、面板可见），基准时刻取 onEquip 时的游戏时间（即建筑创建/地图加载时刻）。
// 秒数→分钟数文案，去掉整分钟时多余的".0"（10:00 而不是 10.0:00）。
function _fmtMin(sec) {
  const m = sec / 60;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}
// 本轮 Q2：法术强度成长不再 1:1 镜像攻击力成长，改成按比例打折（用户定稿"暂定
// 66.7%，非固定比例"）——结算（onFrame 的 AP 效果）与文案（description/
// getDescTemplate）共用这一个函数，不许各写一份。
function _towerApStepFor(stepAD) {
  const ratio = CONFIG.tuning?.towerGrowth?.apRatioOfAd ?? 0.667;
  return Math.round(stepAD * ratio);
}
function _makeTowerGrowth({ id, name, startAD, capAD, adStartT, resistGrowthStartT, fixedSteps, armorPerStep = 0, stepAD = 9 }) {
  const totalSteps = fixedSteps || Math.round((capAD - startAD) / stepAD);
  return {
    id, name,
    icon: '📈',
    // 塔的成长曲线只按 id 分层（外/内/水晶/枢纽/深渊变体），永远只装在塔身上。
    applicableTypes: ['tower'],
    // v42: defaultParams enables CombatSystem to inject per-map overrides into inst._params
    defaultParams: { adStartT: adStartT, stepAD, totalSteps: totalSteps, armorPerStep: armorPerStep ?? 0, resistGrowthStartT: resistGrowthStartT ?? 0 },
    category: 'passive',
    // v51.18 修复：这三处原来把双抗成长的起算时间写成字面量"16分钟/16:00"，
    // 只有 passive_growth_inner（唯一传了 resistGrowthStartT 的调用点，当时是
    // 960 秒=16 分钟）凑巧数字对得上；改内塔的 resistGrowthStartT（960→600，
    // 见下面调用处）之后这三处文案就会跟实际生效时间对不上——同一类"文案写死、
    // 数值走参数"的口径不一致，改成从 resistGrowthStartT 动态换算分钟数。
    // 本轮 Q2：用户报"塔也会成长法强了，但加固城防（成长这条被动合并进去展示的）
    // 里完全没提法强"——排查发现 a1d31f8 那轮只改了 onFrame 的结算（补了一条法强
    // 成长效果），文案这三处（description/descTemplate/getDescTemplate）从来没跟着
    // 改，玩家点开面板只看到"攻击力阶梯成长"，法强涨到多少全靠猜。这里把法强步进
    // 值（_towerApStepFor(stepAD)）也写进文案，与 onFrame 实际结算共用同一个函数。
    description: `唯一被动——${name}：从${_fmtMin(adStartT)}分钟起每分钟攻击力+${stepAD}、法术强度+${_towerApStepFor(stepAD)}` +
      `（法强成长为攻击力成长的${Math.round((CONFIG.tuning?.towerGrowth?.apRatioOfAd ?? 0.667) * 1000) / 10}%，共${totalSteps}层至${capAD}封顶）` +
      (resistGrowthStartT ? `；${_fmtMin(resistGrowthStartT)}分钟起双抗每分钟+1（不封顶）` : '') + '。',
    descTemplate: `唯一被动——${name}：攻击力阶梯成长（当前加成{val}）、法术强度阶梯成长（当前加成{apVal}），` +
     `每分钟+${stepAD}/+${_towerApStepFor(stepAD)}共${totalSteps}层至 ${capAD} 封顶` +
     (resistGrowthStartT ? `；${_fmtMin(resistGrowthStartT)}:00 起双抗 +1/分钟` : '') + '。',
   // v42: dynamic descTemplate that respects per-map inst._params overrides
   getDescTemplate: function(entity, instance) {
     var sv = this; // this === def
     var p = instance && instance._params || {};
     var stepAD = p.stepAD || 9;
     var stepAP = _towerApStepFor(stepAD);
     var steps = p.totalSteps || totalSteps;
     var resistT = p.resistGrowthStartT ?? resistGrowthStartT;
     return '唯一被动——' + name + '：攻击力阶梯成长（当前加成{val}）、法术强度阶梯成长（当前加成{apVal}），每分钟+' + stepAD + '/+' + stepAP + '共' + steps + '层至 ' + capAD + ' 封顶' + (resistT ? '；' + _fmtMin(resistT) + ':00起双抗+1/分钟' : '') + '。';
   },
   computeCurrent: (entity, ctx) => {
      const inst = (entity._skillInstances || []).find(i => i.skillId === id);
      const t0 = inst?.state?.t0 || 0;
      const elapsed = Math.max(0, (window.gameTime || 0) - t0);
      const steps = Math.min(Math.max(0, Math.floor((elapsed - (inst?._params?.adStartT ?? adStartT)) / 60)), totalSteps);
      return { val: steps * stepAD, apVal: steps * _towerApStepFor(stepAD) };
    },
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.t0 = window.gameTime || 0;
      instance.state.timer = 0;
      instance.state.adSteps = -1;   // -1 = 尚未挂出效果
      instance.state.resSteps = -1;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      // Q2 展示重做：成长改为【阶梯制】，效果只在"层数变化"时 apply 一次（不再每秒刷新，
      // 根治进度环不断重置的闪烁）；层与层之间只直写 remainingTime = 距下一层的剩余秒数，
      // 进度环即"下一次成长倒计时"，右下角层数徽标 = 当前层数；封顶后转常驻（无进度环）。
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0, t0: window.gameTime || 0, adSteps: -1, resSteps: -1 };
      // 时钟回退自愈：起算点 t0 是装备那一刻的 gameTime，可只要时钟被重置（换地图、
      // 重开一局），t0 就成了一个【未来】的时间戳，elapsed 恒为 0 —— 成长看起来完全不长。
      // 这正是用户报的"所有地图的塔都不会正常成长"的根因之一（另一半是 map:loaded
      // 归零晚于建筑创建，已在 MapSystem/main.js 侧修好）。这里再兜一层：
      // 只要发现"现在比起算点还早"，就把起算点重锚到现在，层数一并清零重来。
      if ((window.gameTime || 0) < (instance.state.t0 || 0)) {
        instance.state.t0 = window.gameTime || 0;
        instance.state.adSteps = -1;
        instance.state.resSteps = -1;
      }
      instance.state.timer += dt;
      if (instance.state.timer < 0.25) return;
      instance.state.timer = 0;
      const st = instance.state;
      const elapsed = Math.max(0, (window.gameTime || 0) - (st.t0 || 0));
      // v42: per-map growth override via inst._params (set by CombatSystem from map skillOverrides)
      const pGrow = instance._params || {};
      const effectiveStartT = pGrow.adStartT ?? adStartT;
      const effectiveStepAD = pGrow.stepAD ?? 9;
      const effectiveTotalSteps = pGrow.totalSteps ?? totalSteps;
      const effectiveArmorPerStep = pGrow.armorPerStep ?? armorPerStep;
      const effectiveResistStartT = pGrow.resistGrowthStartT ?? resistGrowthStartT;

      // ---- 攻击力阶梯 ----
      const rawSteps = Math.floor((elapsed - effectiveStartT) / 60); // 起算点后每满一分钟一层
      const steps = Math.min(Math.max(0, rawSteps), effectiveTotalSteps);
      const capped = steps >= effectiveTotalSteps;
      // 本轮追加：用户"把塔成长的各种属性的状态合并到一块显示，不要显示一堆状态
      // 出来"——原来 AD/双抗/法强 三条成长各起一个独立的 blueprint.name，状态栏
      // 就是三个并排的图标。UIManager._updateEffectIcons 本来就有"同名效果合并成
      // 一个图标"的机制（Q1，供同一技能的多条属性修正共用），这里不用发明新机制，
      // 只要让这四条效果（AD/AP/护甲/魔抗）全部共用同一个 blueprint.name（裸的
      // `name`，不再拼 '·双抗'/'·法强' 后缀），加上统一的图标，就会自动合并成一个
      // 状态格；点开/悬浮时 effectGroupBreakdown 也会把同名的多条 kind:'stat' 效果
      // 汇总进同一张属性表格里，天然就是"合并展示"，不用再另写一份汇总逻辑。
      if (steps !== st.adSteps) {
        st.adSteps = steps;
        if (steps > 0) {
          if (effectiveArmorPerStep > 0) {
            // Q2 修正（最新确认）：护甲与魔抗一块成长，每层各 +armorPerStep
            for (const [rk, rl] of [['armor', '护甲'], ['magicResist', '魔法抗性']]) {
              ctx.effectRegistry.apply(entityId, {
                name, icon: '📈', kind: 'stat', statKey: rk, flatValue: steps * effectiveArmorPerStep,
                duration: capped ? Infinity : 60, permanent: capped,
                stackable: true, maxStacks: effectiveTotalSteps, stackPolicy: 'refresh',
                alwaysShowStacks: true, uniquePassive: true,
                description: `${rl}+${steps * effectiveArmorPerStep}（第 ${steps}/${effectiveTotalSteps} 层）`,
              }, id + '_step_' + rk);
            }
          }
          ctx.effectRegistry.apply(entityId, {
            name, icon: '📈', kind: 'stat', statKey: 'attackDamage', flatValue: steps * effectiveStepAD,
            duration: capped ? Infinity : 60, permanent: capped,
            stackable: true, maxStacks: effectiveTotalSteps, stackPolicy: 'refresh',
            alwaysShowStacks: true, uniquePassive: true,
            description: capped
              ? `攻击力+${steps * effectiveStepAD}（已封顶 ${steps}/${effectiveTotalSteps} 层）`
              : `攻击力+${steps * effectiveStepAD}（第 ${steps}/${effectiveTotalSteps} 层，进度环=下一层倒计时）`,
          }, id + '_ad', );
          // Q3：塔默认改自适应伤害（不再强制魔法），成长也从"只涨攻击力"改成
          // "物理攻击、法术强度同步涨"。本轮追加：法强步进不再 1:1 镜像攻击力
          // 步进，改成按 CONFIG.tuning.towerGrowth.apRatioOfAd 打折（_towerApStepFor，
          // 用户定稿"暂定66.7%"）；哪支武器实际吃 AD 还是 AP，由武器自身的伤害
          // 类型决定，这里只管把两条数值都涨起来。
          const stepAP = _towerApStepFor(effectiveStepAD);
          ctx.effectRegistry.apply(entityId, {
            name, icon: '📈', kind: 'stat', statKey: 'abilityPower', flatValue: steps * stepAP,
            duration: capped ? Infinity : 60, permanent: capped,
            stackable: true, maxStacks: effectiveTotalSteps, stackPolicy: 'refresh',
            alwaysShowStacks: true, uniquePassive: true,
            description: capped
              ? `法术强度+${steps * stepAP}（已封顶 ${steps}/${effectiveTotalSteps} 层）`
              : `法术强度+${steps * stepAP}（第 ${steps}/${effectiveTotalSteps} 层，进度环=下一层倒计时）`,
          }, id + '_ap', );
          // 四条效果现在共用同一个 blueprint.name（纯粹为了状态栏合并成一个图标），
          // 但 AD/AP 这条节奏（adStartT 起算、steps 封顶）与下面内塔双抗那条节奏
          // （resistGrowthStartT 起算、rSteps 不封顶）各走各的计时器——如果同步
          // stacks/remainingTime 时只按 blueprint.name 一把抓，会把这条刚算出来的
          // steps 错误地写进内塔双抗那两条效果里（反之亦然）。改按 sourceId 精确
          // 匹配【这一次 apply 的这几条】，不牵连另一条节奏上的效果。
          const adApSourceIds = [id + '_ad', id + '_ap', id + '_step_armor', id + '_step_magicResist'];
          for (const e2 of ctx.effectRegistry.getEffects(entityId)) {
            if (adApSourceIds.includes(e2.sourceId)) e2.stacks = steps;
          }
        }
      }
      if (!capped) {
        // 层间：直写剩余时间 = 距下一层秒数（不 apply，环平滑倒数不闪）
        const remain = Math.max(0.5, 60 - ((elapsed - effectiveStartT) % 60));
        const adApSourceIds = [id + '_ad', id + '_ap', id + '_step_armor', id + '_step_magicResist'];
        for (const eff of ctx.effectRegistry.getEffects(entityId)) {
          if (adApSourceIds.includes(eff.sourceId) && steps > 0) eff.remainingTime = remain;
        }
      }

      // ---- 内塔双抗阶梯（不封顶，逻辑同上，同样合并进同一个 name）----
      if (effectiveResistStartT) {
        const rSteps = Math.max(0, Math.floor((elapsed - effectiveResistStartT) / 60));
        if (rSteps !== st.resSteps) {
          st.resSteps = rSteps;
          if (rSteps > 0) {
            for (const [key, label] of [['armor', '护甲'], ['magicResist', '魔法抗性']]) {
              ctx.effectRegistry.apply(entityId, {
                name, icon: '📈', kind: 'stat', statKey: key, flatValue: rSteps,
                duration: 60, stackable: true, maxStacks: 999, stackPolicy: 'refresh',
                alwaysShowStacks: true, uniquePassive: true,
                description: `${label}+${rSteps}（第 ${rSteps} 层，每分钟+1不封顶）`,
              }, id + '_' + key);
            }
            // 同上：只精确同步这一条节奏自己的两个 sourceId，不碰 AD/AP 那条。
            const resistSourceIds = [id + '_armor', id + '_magicResist'];
            for (const e2 of ctx.effectRegistry.getEffects(entityId)) {
              if (resistSourceIds.includes(e2.sourceId)) e2.stacks = Math.min(rSteps, 999);
            }
          }
        }
        if (rSteps > 0) {
          const resistSourceIds = [id + '_armor', id + '_magicResist'];
          for (const eff of ctx.effectRegistry.getEffects(entityId)) {
            if (resistSourceIds.includes(eff.sourceId)) eff.remainingTime = Math.max(0.5, 60 - ((elapsed - effectiveResistStartT) % 60));
          }
        }
      }
    },
  };
}

// ==================== Q5(前批)：基地光环（水晶枢纽默认被动） ====================
// 防守圈内（圆心=枢纽自身，半径=枢纽到己方最远枢纽塔距离+塔射程，与守家圈一致）的
// 己方【小兵】获得 +7%攻速/+3%移速/+1%伤害增幅。走效果系统：入圈上状态、离圈自动脱落。
export const HomeAuraSkill = {
  passive_home_aura: {
    id: 'passive_home_aura',
    applicableTypes: ['tower'],
    name: '基地光环',
    icon: '🏠',
    category: 'passive',
    // v51.6 用户定稿："水晶枢纽的基地光环修改为：+2生命恢复，+2法力恢复，+5%移速，
    // +20%伤害转化。"（原 +5%移速/+3生命恢复 被取代，移速数值不变、生命恢复从
    // +3 降到 +2，新增法力恢复与伤害转化两项）。
    description: '唯一被动——基地光环：防守圈内的己方小兵获得+2生命恢复/+2法力恢复/+5%移速/+20%伤害转化。',
    descTemplate: '唯一被动——基地光环：防守圈内己方小兵 +2生命恢复/+2法力恢复/+5%移速/+20%伤害转化（离圈自动失效）。',
    effects: [],
    onEquip: (entityId, instance, ctx) => {
      instance.state = instance.state || {};
      instance.state.timer = 0;
      instance.state.radius = null;
    },
    onFrame: (entityId, dt, instance, ctx) => {
      const self = ctx.entityContainer.get(entityId);
      if (!self || !self.alive || !self._mapFaction) return;
      if (typeof instance.state?.timer !== 'number') instance.state = { ...(instance.state || {}), timer: 0, radius: null };
      instance.state.timer += dt;
      if (instance.state.timer < 0.5) return;
      instance.state.timer = 0;

      if (instance.state.radius === null) {
        // v33（Q9）：半径 = 画布上红/蓝基地圈（高地区域）的半径——两处共用 MapSystem
        // 的同一数据源，图上看到多大圈，光环就罩多大。MapSystem 不可用时退回旧算法。
        const mapSys = ctx.mapSystem || (window.CTX?.__app || window.__app)?.mapSystem;
        const r = mapSys?.getBaseCircleRadius?.(self._mapFaction);
        if (r) {
          instance.state.radius = r;
        } else {
          let maxD = 0;
          for (const e of ctx.entityContainer.getAllTowers(true)) {
            if (e._mapTier === 'hq_tower' && e._mapFaction === self._mapFaction) {
              maxD = Math.max(maxD, Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y));
            }
          }
          instance.state.radius = (maxD || 180) + 180;
        }
        instance.state.center = null; // 圆心：基地角点（MapSystem 提供），否则用自身位置
        if (mapSys?.getBaseCircleCenter) instance.state.center = mapSys.getBaseCircleCenter(self._mapFaction);
      }

      const r = instance.state.radius;
      const cx = instance.state.center?.x ?? self.pos.x;
      const cy = instance.state.center?.y ?? self.pos.y;
      for (const ally of ctx.entityContainer.findInRadius(cx, cy, r, null, true)) {
        if (ally.id === entityId || ally.type === 'tower') continue;
        if ((ally._mapFaction || ally.faction) !== self._mapFaction) continue;
        if (!ally._laneId) continue;
        // v51.6 用户定稿：基地光环 = +2生命恢复 / +2法力恢复 / +5%移速 / +20%伤害转化
        // （原 +5%移速/+3生命恢复 已取代；+7%攻速/+3%移速/+1%增幅 那版更早就取消了）。
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'moveSpeed', percentValue: 5,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '移速+5%（基地防守圈）',
        }, 'home_aura_ms_' + entityId);
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'healthRegen', flatValue: 2,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '生命恢复+2（基地防守圈）',
        }, 'home_aura_hp5_' + entityId);
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'manaRegen', flatValue: 2,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '法力恢复+2（基地防守圈）',
        }, 'home_aura_mana_' + entityId);
        ctx.effectRegistry.apply(ally.id, {
          name: '基地光环', icon: '🏠', kind: 'stat', statKey: 'damageConvertPct', flatValue: 20,
          aura: true, auraGrace: 1.0, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
          description: '伤害转化+20%（基地防守圈）',
        }, 'home_aura_dmgconv_' + entityId);
      }
    },
  },
};


export const TowerGrowthSkills = {
  // Q9：嚎哭深渊统一塔成长——每分钟 +9攻击力/+1护甲，封顶14层（首层于 1:00）
  passive_growth_ha: _makeTowerGrowth({ id: 'passive_growth_ha', name: '深渊塔成长', startAD: 0, capAD: 126, adStartT: 0, fixedSteps: 14, armorPerStep: 1 }), // 每分钟+9攻/+1护甲/+1魔抗，开局起算，14层封顶（Q1/Q2最新确认）
  passive_growth_outer: _makeTowerGrowth({ id: 'passive_growth_outer', name: '外塔成长', startAD: 152, capAD: 278, adStartT: 40 }),
  // v51.18：双抗成长起算时间 16:00→10:00（用户定稿，简单平衡性调整）。
  // 本轮：用户"高地塔/枢纽塔的成长可以做的强一点点（就只有一点点）"——只动这两条，
  // 外塔/水晶塔（枢纽以外的基地塔）不变。杠杆选每分钟的攻击力步进（stepAD，默认9）：
  // 内塔/枢纽塔 9→10，总层数（15层）不变，capAD 按 startAD+步进×层数 同步抬高
  // （170+10×15=320，150+10×15=300），涨幅约 +5%——"一点点"，不是重做整条曲线。
  passive_growth_inner: _makeTowerGrowth({ id: 'passive_growth_inner', name: '内塔成长', startAD: 170, capAD: 320, adStartT: 180, resistGrowthStartT: 600, stepAD: 10 }),
  passive_growth_base:  _makeTowerGrowth({ id: 'passive_growth_base',  name: '水晶塔成长', startAD: 170, capAD: 305, adStartT: 180 }),
  passive_growth_hq:    _makeTowerGrowth({ id: 'passive_growth_hq',    name: '枢纽塔成长', startAD: 150, capAD: 300, adStartT: 180, stepAD: 10 }),

};
