import { AttributeCalculator } from '../core/AttributeCalculator.js';
import { CONFIG, MELEE_RANGE_THRESHOLD } from '../data/Config.js';
import { canTarget, isStructureProtected } from './FactionSystem.js';
import { healPowerOf, applyHeal, grantTempShield, effectiveFixedShieldMax } from '../core/healing.js';
import { resolveSkillParams } from '../core/skillParams.js';

// v40：攻城车规则辅助。**所有机制以"是否装备攻城武器被动"为闸门、数值从技能定义里读**——
// 拆掉被动，攻城车立刻退化成一辆普通车（用户要求：特殊机制必须由技能被动实现）。
const isStructureUnit = (e) => !!e && e.type === 'tower';   // 防御塔与水晶在本项目里都是 type='tower'
/** 取单位身上的攻城武器被动定义；没装备则返回 null */
export function getSiegeWeaponDef(e, skillLibrary) {
  if (!e || !e._skillInstances) return null;
  const has = e._skillInstances.some(i => i.skillId === 'passive_siege_weapon' && !i._disabled);
  return has ? (skillLibrary?.passive_siege_weapon || null) : null;
}
/** 近战单位 = 攻击距离 ≤ 阈值（近战30/超级兵/蚀骨兵 命中；炮车127.5/远程150/塔180 排除） */
const isMeleeUnit = (e) => !!e && (e.baseStats?.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD;
// v2.5D（Q1）：模板未声明 bulletSpeed 的远程单位取此默认弹速（与防御塔同值）。
// 想给某兵种单独手感，在 Config 模板里补 bulletSpeed 即可覆盖，此处无需再改。
const DEFAULT_BULLET_SPEED = 400;

export class CombatSystem {
  constructor(entityContainer, effectRegistry, eventBus, skillLibrary) {
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.eventBus = eventBus;
    this.skills = skillLibrary;
    this.attrCalc = AttributeCalculator;
    this.projectiles = null; // 通过 setProjectileSystem 注入，用于渲染观赏性弹道
  }

  setProjectileSystem(projectileSystem) {
    this.projectiles = projectileSystem;
  }

  update(dt) {
    const now = window.gameTime || 0;
    const shieldRegenDelay = CONFIG.gameRules.shieldRegenDelay ?? 8;

    // ---- 更新冷却与战斗计时器 ----
    for (const entity of this.entities.getAll(true)) {
      // v43 Q7：属性表提到循环顶部——攻速也要从这里取（见 calcAttackSpeedOf 的注释）。
      // attrCalc.calc 每帧带缓存，提前算不增加开销。
      const stats = this.attrCalc.calc(entity, this.effects.getEffects(entity.id));
      // 攻击冷却按"当前实时攻速"消耗：cooldownRemain 记剩余"攻击次数份额"，
      // 每帧减去 (当前攻速 × dt)。攻速中途变化（如减攻速）立即反映到冷却推进速度。
      if (entity.attackCooldown > 0) {
        const curAS = this.attrCalc.calcAttackSpeedOf(stats);
        // attackCooldown 存"剩余秒数"，但按当前攻速等比缩放推进：
        // 剩余秒数 -= dt × (当前攻速 / 设定冷却时的攻速)。用 _cdAS 记录设定时攻速。
        const refAS = entity._cdAS || curAS || 0.5;
        entity.attackCooldown -= dt * (curAS / (refAS || 0.5));
      }
      if (entity.attackCooldown < 0) entity.attackCooldown = 0;

      // 战斗计时器（持久化 _inCombat）
      if (entity._combatTimer !== undefined && entity._combatTimer > 0) {
        entity._combatTimer -= dt;
        if (entity._combatTimer <= 0) {
          entity._combatTimer = 0;
          entity._inCombat = false;
        }
      } else {
        entity._inCombat = false;
      }
      entity._attackerCount = 0;

      // ---- 生命恢复 / 护盾延迟回满 / 临时护盾衰减（此前未实现） ----
      const regen = stats.healthRegen || 0;
      const regenMod = entity.baseStats.baseHealthRegenMod ?? 1;
      // v39（Q7 修复）：负生命恢复此前被 `regen > 0` 直接跳过 → 手动把恢复调成负值不掉血。
      // 现在负恢复 = 字面扣血（不乘恢复系数、不吃节点封顶），可致死；
      // 结构保护/全局无敌照常免疫（与天气负恢复通道同规则）。
      if (regen < 0 && entity.currentHP > 0 && entity.alive) {
        const inv0 = entity.type === 'tower' && !!window.__towerRuleFor?.('invincible', entity._mapFaction);
        if (!inv0 && !isStructureProtected(this.entities, entity)) {
          entity.currentHP += regen * dt;   // regen 为负 → 扣血
          if (entity.currentHP <= 0) {
            entity.currentHP = 0; entity.alive = false;
            this.eventBus?.emit?.('entity:death', { entityId: entity.id });
          }
        }
      }
      if (regen > 0 && regenMod > 0 && entity.currentHP > 0) {
        // v35（Q5）：生命恢复封顶——"加固城防"类被动设置 _regenCapHP（当前血量所在
        // 区间的上界节点），恢复只能回到节点、不能越过；无被动时封顶=满血。
        // 治疗与护盾强度在这里生效（改动前不吃，光龙的 +8% 等于白买；见 core/healing.js）。
        applyHeal(entity, regen * regenMod * dt, healPowerOf(stats),
                  stats.maxHP || entity.currentHP, entity._regenCapHP);
      }
      // v36（Q1 修正）：天气负生命恢复 = 字面扣血（原值、无任何加成、不乘恢复系数），
      // 【可致死】（用户改口：扣到 0 正常死亡，不再保底 1HP）。
      // 结构保护/全局无敌 = 免疫一切伤害，环境扣血同样免疫。
      const drain = stats._weatherDrain || 0;
      if (drain > 0 && entity.currentHP > 0 && entity.alive) {
        const inv = entity.type === 'tower' && !!window.__towerRuleFor?.('invincible', entity._mapFaction);
        if (!inv && !isStructureProtected(this.entities, entity)) {
          entity.currentHP -= drain * dt;
          if (entity.currentHP <= 0) {
            entity.currentHP = 0; entity.alive = false;
            this.eventBus?.emit?.('entity:death', { entityId: entity.id });
          }
        }
      }

      // 固定护盾：强度作用在【上限】上。只乘"回满的那一下"会被下面那句夹回去，等于没乘。
      const shieldMax = effectiveFixedShieldMax(stats.shieldFixedMax || 0, healPowerOf(stats));
      if (shieldMax > 0) {
        const lastDamage = entity.lastDamageTime ?? -Infinity;
        if (now - lastDamage >= shieldRegenDelay && entity.shieldFixedCurrent < shieldMax) {
          entity.shieldFixedCurrent = shieldMax;
        }
      }
      // v35：护盾上限回落（钢铁烈阳护盾等光环脱落后，current 不得高于新 max）
      if (entity.shieldFixedCurrent > shieldMax) entity.shieldFixedCurrent = shieldMax;

      if (entity.tempShield > 0) {
        const decayPct = (stats.tempShieldDecayPct || 0) / 100;
        entity.tempShield -= entity.tempShield * decayPct * dt;
        if (entity.tempShield < 0.01) entity.tempShield = 0;
      }
    }

    const towers = this.entities.getAllTowers(true);
    const minions = this.entities.getAllMinions(true);

    // ---- 塔攻击敌人（小兵 + 巨龙） ----
    for (const tower of towers) {
      // Q5：按阵营停火。用 continue 而非 break —— break 会中断整个循环，
      // 导致"只停蓝方"时红方塔也跟着不打了（循环里第一个塔是蓝方就全断）。
      if (window.__towerRuleFor?.('attackOff', tower._mapFaction)) continue;
      // 眩晕：停止一切活动
      if (this.effects.isStunned(tower.id)) { tower.targetId = null; continue; }

      // 无武器：不攻击（"无武器"选项应使塔完全不输出，而非仍用基础攻击力打）
      const hasWeapon = (tower._skillInstances || []).some(s => this.skills[s.skillId]?.category === 'weapon');
      if (!hasWeapon) { tower.targetId = null; continue; }

      const range = this.attrCalc.calc(tower, this.effects.getEffects(tower.id)).attackRange || 250;

      // 索敌锁定：当前目标存活且仍在射程内则不重新索敌，否则重新索敌
      let target = tower.targetId ? this.entities.get(tower.targetId) : null;
      if (target && (!target.alive || target.type === 'tower')) target = null;
      if (target) {
        const dx0 = target.pos.x - tower.pos.x, dy0 = target.pos.y - tower.pos.y;
        if (dx0 * dx0 + dy0 * dy0 > range * range) target = null; // 脱离范围重新索敌
      }
      if (!target) target = this.selectTarget(tower, minions);

      if (target) {
        // v33（Q14）：锁定前摇——锁定【新目标】时 0.3s 不能开火（腐蚀型除外：无锁定概念，
        // 持续 AOE 不走单目标索敌）。锁定期间渲染器画细红线（模仿 LoL 锁定指示）。
        if (tower.targetId !== target.id) {
          const wid = (tower._skillInstances || []).find(s => s.skillId.startsWith('weapon_'))?.skillId;
          // 绝对时间戳（不是倒计时）：谁设置谁比较，仿真只跑部分系统时也正确
          tower._lockUntil = wid === 'weapon_corrosion' ? 0
            : (window.gameTime || 0) + (CONFIG.tuning?.lockOnWindup ?? 0.3);
        }
        tower.targetId = target.id;
        const dx = target.pos.x - tower.pos.x;
        const dy = target.pos.y - tower.pos.y;
        if (dx * dx + dy * dy <= range * range && tower.attackCooldown <= 0 && !((window.gameTime || 0) < (tower._lockUntil || 0))) {
          this.performAttack(tower, target);
          const finalAS = this.attrCalc.calcAttackSpeedOf(
            this.attrCalc.calc(tower, this.effects.getEffects(tower.id)));
          tower.attackCooldown = 1 / (finalAS || 0.5);
          tower._cdAS = finalAS;
        }
      } else {
        tower.targetId = null;
      }
    }

    // ---- 小兵移动 & 攻击塔（仅沙盒模式小兵；对战模式小兵由 LaneMovementSystem 接管） ----
    for (const minion of minions) {
      if (!minion.alive) continue;
      if (minion._laneId) continue; // 对战模式小兵，交给 LaneMovementSystem 处理，这里跳过避免重复移动/攻击
      if (!minion.pos || typeof minion.pos.x !== 'number') {
        console.warn('小兵 #' + minion.id + ' 位置无效，跳过');
        continue;
      }
      // 眩晕：停止一切活动
      if (this.effects.isStunned(minion.id)) continue;

      let nearestTower = null;
      let minDist = Infinity;
      for (const tower of towers) {
        if (!tower.alive || !tower.pos) continue;
        const dx = tower.pos.x - minion.pos.x;
        const dy = tower.pos.y - minion.pos.y;
        const d = dx * dx + dy * dy;
        if (d < minDist) {
          minDist = d;
          nearestTower = tower;
        }
      }

      if (!nearestTower) continue;

      // v43 Q2：沙盒路径同样走攻城锁定（此前这条路上一条攻城规则都没有 ——
      // 手动添加的攻城车因此既不显示红线、也没有攻城模式状态、攻速也不降）。
      // 锁定目标可能与"最近的塔"不同（锁死了就不换），所以下面一律用 nearestTower 这个变量。
      const lockedTgt = this.siegeAcquire(minion, nearestTower);
      if (lockedTgt && lockedTgt !== nearestTower) {
        nearestTower = lockedTgt;
        minDist = (nearestTower.pos.x - minion.pos.x) ** 2 + (nearestTower.pos.y - minion.pos.y) ** 2;
      }

      const range = this.attrCalc.calc(minion, this.effects.getEffects(minion.id)).attackRange || 20;
      const dist = Math.sqrt(minDist);

      if (minion.targetId !== nearestTower.id && dist <= range) {
        minion.targetId = nearestTower.id;
        minion._lockUntil = (window.gameTime || 0) + (CONFIG.tuning?.lockOnWindup ?? 0.3); // v33（Q14）：小兵同样有锁定前摇
      }
      if (dist <= range && minion.attackCooldown <= 0 && !((window.gameTime || 0) < (minion._lockUntil || 0))) {
        minion.targetId = nearestTower.id;
        this.performAttack(minion, nearestTower);
        // v43 Q2：与对战路径共用同一个攻城结算（攻速 -50% + 自损 20%）。
        const finalAS = this.finishAttack(minion, nearestTower, this.attrCalc.calcAttackSpeedOf(
          this.attrCalc.calc(minion, this.effects.getEffects(minion.id))));
        minion.attackCooldown = 1 / (finalAS || 0.5);
        minion._cdAS = finalAS;
      } else if (dist > range) {
        const angle = Math.atan2(nearestTower.pos.y - minion.pos.y, nearestTower.pos.x - minion.pos.x);
        const speed = this.attrCalc.calc(minion, this.effects.getEffects(minion.id)).moveSpeed || 30;
        minion.pos.x += Math.cos(angle) * speed * dt;
        minion.pos.y += Math.sin(angle) * speed * dt;
        minion.pos.x = Math.max(0, Math.min(900, minion.pos.x));
        minion.pos.y = Math.max(0, Math.min(700, minion.pos.y));
      }
    }

    // ---- 触发被动技能 onFrame（眩晕单位跳过；不兼容特殊武器的技能禁用） ----
    for (const entity of this.entities.getAll(true)) {
      if (this.effects.isStunned(entity.id)) continue;
      this._refreshSkillDisableState(entity);
      const instances = entity._skillInstances || [];
      for (const inst of instances) {
        if (inst._disabled) continue;
        const def = this.skills[inst.skillId];
        // v41: auto-initialize per-instance params from skill defaults
        // Q2 修复：这段原本嵌在 `if (def.onFrame)` 里，于是【只有 onFrame 技能】能拿到
        // 地图覆写。屠戮只有 onHit，它读的 instance._params.pct 因此永远是 undefined ——
        // "同一技能在不同地图上数值/机制不同"这条能力对它形同虚设。现在提到门外，
        // 任何技能（onHit/onBeingAttacked/…）都能被地图按 tier/type 覆写参数。
        // v43 P0-②：解析逻辑搬到 core/skillParams.js，装备那一刻就跑过一次了。
        // 这里每帧再跑一次，只为让**运行中改覆写**（编辑器调参、换地图）能立刻跟上；
        // 不再承担"第一次把参数灌进去"的职责 —— 那个时序已经咬过两次
        //（屠戮、加固城防的生命恢复），见 skillParams.js 的头注。
        if (def) resolveSkillParams(inst, entity, this.skills);
        if (def && def.onFrame) {
          // 兜底（框架体检 P2）：技能是可扩展点，单个技能 onFrame 抛错只记日志跳过，
          // 不能打死整个模拟步（否则一个坏技能会冻结全场战斗）。
          try {
            def.onFrame(entity.id, dt, inst, {
              entityContainer: this.entities,
              effectRegistry: this.effects,
              eventBus: this.eventBus,
              waveNumber: window.waveNumber || 0,
              attrCalc: this.attrCalc,
              combat: this,
            });
          } catch (err) {
            if (!inst._frameErrLogged) {
              inst._frameErrLogged = true; // 每个技能实例只刷一次，防止 30Hz 刷屏
              console.error(`技能 ${inst.skillId}#${inst.id} onFrame 异常（已跳过，后续帧继续尝试）:`, err);
            }
          }
        }
      }
    }

    this.entities.purgeDead();
  }

  // 刷新单位的技能禁用状态：装备了"特殊攻击方式"武器（闪电杖/腐蚀型）时，
  // 标注了 incompatibleWithSpecial 的技能被禁用（不工作，UI 中置灰）。
  _refreshSkillDisableState(entity) {
    const insts = entity._skillInstances || [];
    let hasSpecial = false;
    for (const inst of insts) {
      const def = this.skills[inst.skillId];
      if (def && def.specialAttack) { hasSpecial = true; break; }
    }
    for (const inst of insts) {
      const def = this.skills[inst.skillId];
      inst._disabled = !!(hasSpecial && def && def.incompatibleWithSpecial);
    }
  }

  // 新索敌逻辑
  selectTarget(tower, minions) {
    // ==================== v43 Q8：水晶的索敌闸门已删除 ====================
    // 这里原本是：
    //     if (tower._mapTier === 'nexus_lane' || tower._mapTier === 'nexus_main') return null;
    // 注释写的是"双重保险"，实际是**一道硬闸**：召唤水晶/水晶枢纽哪怕在编辑器里
    // 装上了武器，也永远索不到目标 —— 用户报的"水晶枢纽和召唤水晶在我手动设置后依旧无法攻击"。
    // createBuilding 那边早在 v36 就放开了"所有建筑都可以装武器"（默认 'none'），
    // 这里是最后一处没跟上的。
    // 真正的保险在调用方：CombatSystem.update 里的 hasWeapon 检查——没装武器的塔
    // 连索敌都不会进来。所以删掉这两行不会让默认无武器的水晶开火。

    const range = this.attrCalc.calc(tower, this.effects.getEffects(tower.id)).attackRange || 250;

    // 用空间网格局部查询代替"遍历全部小兵"，把索敌从 O(塔数×小兵数) 降到 O(塔数×局部单位数)。
    // 之前直接遍历传入的全量 minions 数组，对战模式塔更多、小兵更密集时是主要性能瓶颈
    // （实测：修复 LaneMovementSystem 的同类问题后，这里变成新的最大耗时来源，单帧10ms+）。
    const nearby = this.entities.findInRadius(tower.pos.x, tower.pos.y, range, null, true);
    const inRange = [];
    // 塔打塔（用户："塔之前也可以相互攻击（我方塔打敌方塔）"）。
    // 原来这里无条件 `continue` 掉所有塔，所以射程内的敌方塔是绝对安全的。
    // 现在允许，但必须尊重两条既有规则，否则会打出很怪的局面：
    //   ① 结构保护：外塔没掉就打内塔，等于跳过 LoL 的推进顺序；
    //   ② 优先级最低：塔是不会动的，永远打得到；若与小兵同优先级，
    //      塔会一直咬着对面塔而无视正在拆自己的小兵。
    const towerVsTower = CONFIG.gameRules.towerAttacksTower !== false;
    for (const m of nearby) {
      if (m.id === tower.id) continue;
      if (!m.pos) continue;
      if (m.type === 'tower') {
        if (!towerVsTower) continue;
        if (!tower._mapFaction || !m._mapFaction) continue;   // 沙盒塔无阵营，不互打
        if (!canTarget(tower._mapFaction, m._mapFaction)) continue;
        if (isStructureProtected(this.entities, m)) continue;
        inRange.push(m);
        continue;
      }
      // 对战模式：塔只能攻击敌对阵营的单位；沙盒模式塔（无 _mapFaction）行为不变，照打所有小兵
      if (tower._mapFaction && !canTarget(tower._mapFaction, m._mapFaction || m.faction || null) && m.type !== 'dragon') continue;
      inRange.push(m);
    }
    if (inRange.length === 0) return null;

    const getPriority = (m) => {
      if (m.type === 'dragon') return 5;
      if (m.type === 'hero') return 4;
      if (m.type === 'monster') return 3;
      if (m.type === 'super' || m.type === 'siege' || m.type === 'totem') return 2;
      // 塔【最低优先级】：它不会跑，什么时候打都来得及；排在小兵前面的话
      // 塔会一直咬着对面塔，对正在拆自己的小兵不闻不问。
      if (m.type === 'tower') return 0;
      return 1;
    };

    inRange.sort((a, b) => {
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pa !== pb) return pb - pa;
      const da = Math.hypot(a.pos.x - tower.pos.x, a.pos.y - tower.pos.y);
      const db = Math.hypot(b.pos.x - tower.pos.x, b.pos.y - tower.pos.y);
      return da - db;
    });
    return inRange[0];
  }

  /**
   * ==================== v43 Q2：攻城武器收归一份实现 ====================
   * 用户："攻城车攻击塔时并不显示红线和状态栏的攻城模式，而且对应的攻速并没有下降。"
   *
   * 三个症状读的是三条不同的代码（红线与状态栏读 `_ramLockId`，攻速读
   * LaneMovementSystem 里的 `target.type === 'tower'` 分支），却同时失效 ——
   * 共同上游只有一个：**攻城武器的三条规则只写在 LaneMovementSystem 那一条路上**。
   * 而 CombatSystem 的小兵循环开头有 `if (minion._laneId) continue;`：
   * 沙盒里的、以及玩家在编辑器里手动添加的单位**没有** `_laneId`，走的是这条路，
   * 那里一条攻城规则都没有。这也顺带解释了"攻城车优先攻击塔而不是小兵"——
   * 沙盒那条路里小兵只认 `nearestTower`，压根不扫小兵。
   *
   * 「同一件事在两处各实现一半」是本仓库反复出事的形状（见 MapSystem.beginNexusRespawn
   * 的头注释）。所以这次不在沙盒路径里再抄一份，而是把攻城的两件事收进下面两个方法，
   * 两条攻击路径都调它们 —— 攻城武器从此只有一份实现。
   */

  /**
   * 攻城锁定维护：装了攻城武器的单位锁定一座建筑后不再改目标。
   * 返回**实际应当攻击的目标**（锁定生效时即锁定目标，否则原样返回调用方的选择）。
   * `_ramLockId` 同时是红线（EffectsLayer）与「攻城模式」状态（被动 onFrame）的唯一依据，
   * 所以只要这里维护对了，那两处自动就对了 —— 不需要它们各自再判一次。
   */
  siegeAcquire(attacker, target) {
    if (!getSiegeWeaponDef(attacker, this.skills)) return target;
    const locked = attacker._ramLockId ? this.entities.get(attacker._ramLockId) : null;
    if (locked && locked.alive) return locked;         // 锁定期间无视一切其他目标
    attacker._ramLockId = null;
    if (target && isStructureUnit(target) && !isStructureProtected(this.entities, target)) {
      attacker._ramLockId = target.id;                 // 首次锁定
    }
    return target;
  }

  /**
   * 一次攻击**结算完之后**的攻城副作用：攻速倍率 + 自损。
   * 传入调用方已算好的攻速，返回应当写进 attackCooldown 的最终攻速。
   * 没装攻城武器、或打的不是建筑时，原样返回 —— 调用方不需要自己判断。
   */
  finishAttack(attacker, target, finalAS) {
    const def = getSiegeWeaponDef(attacker, this.skills);
    if (!def || !isStructureUnit(target)) return finalAS;
    const out = finalAS * (def.TOWER_ATKSPD_MULT ?? 0.5);
    const maxHP = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id)).maxHP
      || attacker.baseStats.maxHP || 1;
    attacker.currentHP -= maxHP * (def.SELF_DAMAGE_PCT ?? 0.2);
    if (attacker.currentHP <= 0 && attacker.alive) {
      attacker.currentHP = 0; attacker.alive = false;
      this.eventBus?.emit?.('entity:death', { entityId: attacker.id });
    }
    return out;
  }

  performAttack(attacker, target) {
    attacker._inCombat = true;
    attacker._combatTimer = 4;

    const weaponInst = attacker._skillInstances?.find(s => s.skillId.startsWith('weapon_'));
    const weaponDef = weaponInst ? this.skills[weaponInst.skillId] : null;

    // 闪电杖伤害完全独立于普通攻击节奏，由其自身 onFrame 每秒固定4次结算，
    // 这里直接跳过，避免普通攻击循环重复造成伤害。
    if (weaponDef && weaponDef.id === 'weapon_lightning') return;

    target._attackerCount = (target._attackerCount || 0) + 1;

    const atkStats = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id));

    // ---- 攻击方数值快照（开火时刻结算，防御方数值在命中时刻结算）----
    // （原"攻城武器"固定加伤已随该技能删除。）

    // ---- 武器 onBeforeAttack 钩子：可返回 { preDamageMult, skipProjectile } ----
    // 用于开火前就要定下的伤害修正（穿透型的升温倍率）、无弹道武器等特殊逻辑。
    //（原来这里举的例子是狙击型按距离调整伤害，那把武器已按用户定稿删除。）
    let preDamageMult = 1;
    let pierceHeat = 0;   // #10：穿透弹升温强度（0..1），仅作渲染提示挂到子弹上，不进伤害

    // v36（Q1）：穿透型升温倍率——【开火时刻】按"塔→当前目标"的已积层数结算。
    // 第1下打某目标 = 100%（0层），第2下 = 130%（1层）… 每层 +30%。切目标/目标变化时重置。
    if (weaponDef && weaponDef.id === 'weapon_piercing') {
      const st = weaponInst.state || (weaponInst.state = { heatTarget: null, heatStacks: 0 });
      if (st.heatTarget !== target.id) {
        // 换目标：本次是对新目标的第 1 下 → 倍率 100%，层数清 0（命中后 onHit 会置 1）
        st.heatTarget = null; st.heatStacks = 0;
        const old = this.effects.getEffectByName(attacker.id, '升温');
        if (old) this.effects.remove(old.id);
      }
      const per = weaponDef.HEAT_PER_STACK ?? 0.30;
      preDamageMult *= 1 + (st.heatStacks || 0) * per;
      pierceHeat = Math.min(1, (st.heatStacks || 0) / (weaponDef.HEAT_MAX_STACKS || 4));
    }

    if (weaponDef && weaponDef.onBeforeAttack) {
      const r = weaponDef.onBeforeAttack(attacker, target, weaponInst, {
        entityContainer: this.entities,
        effectRegistry: this.effects,
        attrCalc: this.attrCalc,
        combat: this,
      });
      if (r) {
        if (typeof r.preDamageMult === 'number') preDamageMult = r.preDamageMult;
        if (r.skipProjectile) return; // 武器自行处理了伤害（如腐蚀型群体中毒），不走普通命中
      }
    }

    const hitInfo = {
      attackerId: attacker.id,
      targetId: target.id,
      baseDamage: atkStats.attackDamage || 0,
      onHitFixed: atkStats.onHitDamage || 0,
      onHitPctBase: (atkStats.onHitPercentDamage || 0) / 100,
      dmgAmp: atkStats.damageAmpPct || 0,
      preDamageMult,
      attackType: atkStats.attackType || 'physical',
      weaponId: weaponDef ? weaponDef.id : null,
      weaponInstId: weaponInst ? weaponInst.id : null,
    };

    // ---- 弹道模型（v2.5D Q1）：所有单位统一 ----
    // 原先写死 attacker.type === 'tower'，小兵/巨龙一律瞬时结算、无可视弹道
    //（注释理由"防卡顿"属单文件时代遗留：实测 40 远程兵齐射峰值在飞弹仅 40 发）。
    //
    // 判据用【射程】而不是 bulletSpeed —— 关键：十个模板里只有防御塔(400)和术士兵(320)
    // 声明了 bulletSpeed，远程兵/炮兵/图腾兵/攻城车全是 undefined。若按 bulletSpeed>0 判，
    // 这几个"看着就该有子弹"的兵种会被静默排除（第一版正是栽在这里）。
    // isMeleeUnit 读 baseStats.attackRange ≤ MELEE_RANGE_THRESHOLD(60)，是本文件既有判据，
    // 且读【基础】射程——射程 buff 不该把近战兵变成远程兵。
    //
    // 统一后的模型：
    //   远程（射程 > 60）：可见弹道，飞行结束才结算伤害；模板缺 bulletSpeed 时用默认值
    //   近战（射程 ≤ 60）：视作"弹速无穷大的弹道"——不可见、瞬时生效（巨龙射程 0 亦属此列）
    // 注意这【改变伤害时序】：远程单位伤害晚 0.3~0.8s 落地，目标先死则该发伤害整个消失。
    if (this.projectiles && !isMeleeUnit(attacker) && attacker.pos && target.pos) {
      // v33（Q6）：子弹颜色 = 阵营色（原按武器着色）；沙盒中立塔沿用暖橙
      const bulletColor = attacker._mapFaction === 'blue' ? '#5b9bd5'
        : attacker._mapFaction === 'red' ? '#e0473f'
        : '#e8563f';
      this.projectiles.fire({
        startX: attacker.pos.x,
        startY: attacker.pos.y,
        attackerId: attacker.id,   // v43 P0-③：渲染层按 id 取炮口高度（坐标反查已删）
        targetId: target.id,
        speed: atkStats.bulletSpeed || DEFAULT_BULLET_SPEED,
        color: bulletColor,
        size: attacker.type === 'tower' ? 20 : 12, // 渲染尺寸：小兵/巨龙弹丸比塔弹小一号
        heat: pierceHeat,                           // #10：升温可视化（0..1），渲染层据此变热
        pendingHit: hitInfo,
      });
    } else {
      // 无子弹速度（近战/无武器）：视为瞬时命中
      this._resolveHit(hitInfo);
    }
  }

  // 命中结算：子弹到达目标（或近战瞬时）时才真正调用，
  // 防御方抗性/护盾使用命中那一刻的实时数值。
  _resolveHit(hitInfo) {
    const attacker = this.entities.get(hitInfo.attackerId);
    const target = this.entities.get(hitInfo.targetId);
    if (!attacker || !attacker.alive || !target || !target.alive) return;
    // Q7：全塔无敌开关（设置窗口）——建筑不再受到任何伤害
    if (target.type === 'tower' && window.__towerRuleFor?.('invincible', target._mapFaction)) return; // Q5：按阵营无敌

    const atkStats = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id));
    const defStats = this.attrCalc.calc(target, this.effects.getEffects(target.id));
    const weaponInst = (hitInfo.weaponInstId != null)
      ? attacker._skillInstances?.find(s => s.id === hitInfo.weaponInstId)
      : null;
    const weaponDef = hitInfo.weaponId ? this.skills[hitInfo.weaponId] : null;

    const onHitPct = hitInfo.onHitPctBase * target.currentHP;
    const preMult = hitInfo.preDamageMult ?? 1;
    let totalRaw = ((hitInfo.baseDamage + hitInfo.onHitFixed + onHitPct) * (1 + hitInfo.dmgAmp / 100)) * preMult;

    // ===== v40 攻城武器被动：伤害侧修正（装备了被动才生效，数值取自技能定义）=====
    // ① 打建筑 ×(1+TOWER_DAMAGE_MULT_PCT)——仅走这条主命中路径；溅射由 performAttackDirect
    //    结算，天然不含增幅（用户定稿："有溅射，不过只对塔有额外伤害增幅"）。
    // ② 打小兵 ×0.67（-33%）　③ 近战单位打它 ×2（+100%）
    const atkSiege = getSiegeWeaponDef(attacker, this.skills);
    if (atkSiege) {
      totalRaw *= isStructureUnit(target) ? atkSiege.TOWER_DAMAGE_MULT : atkSiege.VS_MINION_MULT;
    }
    const tgtSiege = getSiegeWeaponDef(target, this.skills);
    if (tgtSiege && isMeleeUnit(attacker)) totalRaw *= tgtSiege.MELEE_BONUS_MULT;

    // ---- 防御计算（支持护甲穿透和魔法穿透） ----
    const attackType = hitInfo.attackType;
    let resist = 0, penPercent = 0, penFlat = 0;
    if (attackType === 'physical') {
      resist = defStats.armor || 0;
      penPercent = atkStats.armorPenPercent || 0;
      penFlat = atkStats.armorPenFlat || 0;
    } else if (attackType === 'magic') {
      resist = defStats.magicResist || 0;
      penPercent = atkStats.magicPenPercent || 0;
      penFlat = atkStats.magicPenFlat || 0;
    }

    const effectiveResist = this.attrCalc.calcEffectiveArmor(resist, penPercent, penFlat);
    const multiplier = this.attrCalc.calcDamageMultiplier(effectiveResist);
    let damage = totalRaw * multiplier;

    // 结构保护（LoL"不可选中"）：受保护的水晶不吃任何伤害。
    // 正常流程索敌层已过滤，这里兜底（溅射/连锁/光束等间接伤害路径）。
    if (isStructureProtected(this.entities, target)) return 0;

    // 伤害减免 & 格挡
    const dmgReduction = defStats.damageReduction || 0;
    damage *= (1 - dmgReduction / 100);
    // ==================== v43：巨龙被动「宿怨」 ====================
    // 用户定稿："龙对某阵营所有单位获得 7%×该阵营击杀龙数量（不含远古龙）伤害减免
    //          和 11%×数量 伤害提升。"
    // 也就是说：**你杀的龙越多，下一条龙对你越硬、打你越疼**。
    // 这是个天然的橡皮筋，但不是"系统偷偷给弱方加数值"——它有叙事（龙记住了谁在杀它）、
    // 可观测（状态栏能看到层数）、可预期（抢第 4 条龙时你就知道它会更难打）。
    // 因为它依赖【攻击方/受击方的阵营】，stat 管线拿不到攻击者，必须在这里判。
    // v43 巨龙宿怨。_resolveHit 只有一个 damage 变量，但两半的**位置**仍有意义：
    // 这里已经过了双抗结算、正要进减免段，所以放这一句同时覆盖两个方向即可
    //（这条路径没有"无视防御"的分股，也没有真伤旁路 —— 真伤走的是 performAttackDirect）。
    damage *= this._dragonGrudge(attacker, target).k;
    // 防御护盾（唯一被动）：来自【防御塔】的伤害降低 30%。
    // v43（用户定稿："炮兵的被动防御护盾改为只对塔减伤30%"）：来源从
    // 塔 / 炮兵 / 超级兵 收窄到**只有塔**。
    // 原来那两个来源让炮兵在兵线互耗里也硬得离谱 —— 炮兵打炮兵、超级兵打炮兵都要吃 30% 减免，
    // 而它本来的设计意图只是"顶着塔往前推"。收窄之后它对塔仍然耐揍，兵线里恢复正常体量。
    // 条件减伤依赖攻击来源，stat 管线拿不到攻击者，必须在引擎结算处判断。
    if (attacker.type === 'tower' && this._hasSkill(target, 'passive_siege_shield')) {
      damage *= 0.7;
    }
    // 哀兵（条件加成，用户定稿）：每层 +4% 对敌方小兵伤害、+10% 减免来自敌方小兵的伤害。
    // 与防御护盾同理——依赖攻击来源类型，stat 管线拿不到，必须在结算处判断。
    damage = this._applyAvenger(damage, attacker, target, atkStats, defStats);
    const block = defStats.damageBlock || 0;
    damage = Math.max(0, damage - block);

    // ---- 护盾吸收 ----
    const shieldFactor = this.attrCalc.calcShieldAbsorbFactor(defStats.armor || 0, defStats.magicResist || 0);
    let tempShield = target.tempShield || 0;
    let fixedShield = target.shieldFixedCurrent || 0;
    let remainingDamage = damage;

    const effectiveTempShield = tempShield * shieldFactor;
    const absorbedByTemp = Math.min(remainingDamage, effectiveTempShield);
    const tempShieldConsumed = absorbedByTemp / shieldFactor;
    target.tempShield = Math.max(0, tempShield - tempShieldConsumed);
    remainingDamage -= absorbedByTemp;

    if (remainingDamage > 0 && fixedShield > 0) {
      const effectiveFixedShield = fixedShield * shieldFactor;
      const absorbedByFixed = Math.min(remainingDamage, effectiveFixedShield);
      const fixedShieldConsumed = absorbedByFixed / shieldFactor;
      target.shieldFixedCurrent = Math.max(0, fixedShield - fixedShieldConsumed);
      remainingDamage -= absorbedByFixed;
    }

    const finalDamage = Math.min(remainingDamage, target.currentHP);
    target.currentHP -= finalDamage;
    if (damage > 0) target.lastDamageTime = window.gameTime || 0;
    // 记录巨龙的伤害来源塔（每塔独立龙魂击杀统计用）
    if (target.type === 'dragon' && finalDamage > 0) {
      const atk = this.entities.get(hitInfo.attackerId);
      if (atk && atk.type === 'tower') {
        (target._damagers = target._damagers || new Set()).add(atk.id);
      }
      // v43：龙的奖励按【最后一击】归属（用户定稿），不再按参与者投票。
      // 记谁打的、以及它的阵营 —— 阵营要当场记下来：结算时那个单位可能已经死了。
      if (atk) { target._lastHitBy = atk.id; target._lastHitFaction = atk._mapFaction || atk.faction || null; }
    }
    const totalAbsorbed = damage - remainingDamage;

    // ---- 伤害转化（v33 Q10 重做：防御向） ----
    // 定义：转化的临时护盾值 = 【受击方】实际受到的伤害（仅扣血部分，护盾吸收不计）× 受击方伤害转化%。
    // 原实现挂在攻击方（打人回盾）——方向整个是反的，等于这条属性从没按设计工作过。
    this._applyDamageConversion(target, defStats, finalDamage);

    // ---- 生命偷取 ----
    const lifesteal = atkStats.lifeStealPct || 0;
    if (lifesteal > 0 && damage > 0) {
      const power = healPowerOf(atkStats);   // 被治疗方 = 攻击者本人
      const steal = damage * (lifesteal / 100);
      const maxHP = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id)).maxHP || 1;
      applyHeal(attacker, steal * 0.5, power, maxHP);
      grantTempShield(attacker, steal * 0.5, power);
    }

    // ---- 触发武器 onHit ----
    if (weaponDef && weaponDef.onHit && weaponInst) {
      weaponDef.onHit(attacker.id, target.id, weaponInst, {
        entityContainer: this.entities,
        effectRegistry: this.effects,
        eventBus: this.eventBus,
        waveNumber: window.waveNumber || 0,
        attrCalc: this.attrCalc,
        combat: this,
      });
    }

    // ---- 触发其他 onHit 被动 ----
    for (const inst of attacker._skillInstances || []) {
      if (inst === weaponInst) continue;
      const def = this.skills[inst.skillId];
      if (def && def.onHit) {
        def.onHit(attacker.id, target.id, inst, {
          entityContainer: this.entities,
          effectRegistry: this.effects,
          eventBus: this.eventBus,
          waveNumber: window.waveNumber || 0,
          attrCalc: this.attrCalc,
          combat: this,
        });
      }
    }

    // ---- 触发目标的 onBeingAttacked ----
    for (const inst of target._skillInstances || []) {
      const def = this.skills[inst.skillId];
      if (def && def.onBeingAttacked) {
        def.onBeingAttacked(target.id, attacker.id, inst, {
          entityContainer: this.entities,
          effectRegistry: this.effects,
          eventBus: this.eventBus,
          waveNumber: window.waveNumber || 0,
          attrCalc: this.attrCalc,
          combat: this,
        });
      }
    }

    // ---- 触发攻击方 onDealtDamage（造成伤害后，龙魂/过热/相位等使用） ----
    for (const inst of attacker._skillInstances || []) {
      const def = this.skills[inst.skillId];
      if (def && def.onDealtDamage && !inst._disabled) {
        def.onDealtDamage(attacker.id, target.id, inst, {
          entityContainer: this.entities,
          effectRegistry: this.effects,
          eventBus: this.eventBus,
          waveNumber: window.waveNumber || 0,
          attrCalc: this.attrCalc,
          combat: this,
          totalRaw,
          finalDamage,
          attackType,
        });
      }
    }

    // ---- 死亡检查 ----
    // v39 修复（历史 bug）：死亡判定必须带 alive 守卫。原来只看 currentHP<=0，
    // 已死单位在同帧再吃一次伤害（溅射/多攻击者/自损致死后的排队攻击）就会【重复发死亡事件】，
    // 污染复仇系统、超级兵触发、击杀计数等一切监听方（v39 冒烟实测：12 辆攻城车发出 20 次死亡）。
    if (target.currentHP <= 0 && target.alive) {
      target.currentHP = 0;
      target.alive = false;
      this.eventBus.emit('entity:death', { entityId: target.id });
    }

    this.eventBus.emit('damage:dealt', {
      sourceId: attacker.id,
      targetId: target.id,
      amount: finalDamage,
      type: attackType,
      raw: totalRaw,
      absorbed: totalAbsorbed,
      shieldFactor: shieldFactor,
    });

    // ---- 爆炸溅射 ----
    if (weaponDef && weaponDef.id === 'weapon_explosive') {
      this._applyExplosion(attacker, target, totalRaw, attackType);
    }
    // v39（Q4）：攻城车普攻自带溅射（半径取模板 splashRadius=60，爆炸弹的一半左右）。
    // 注意传入的基数是 totalRaw——若主目标是建筑，totalRaw 已含 ×9；为满足用户定稿
    //「只对塔有+800%」，这里把倍率除回去，使溅射永远按普通伤害结算。
    // v43：闸门从 `atkSiege &&` 放宽到"模板里写了 splashRadius 就溅射"。
    // 原来的写法把溅射和攻城武器被动绑死了 —— 于是**巨龙的溅射从来没生效过**：
    // createDragon 按用户定稿给龙写了 baseStats.splashRadius = 90，
    // 但龙没有 passive_siege_weapon，那一项就是个没人读的死配置。
    // 攻城车的"只对塔有额外增幅"仍然成立：下面那行只在装了被动时把倍率除回去。
    const splashR = attacker.baseStats?.splashRadius || 0;
    if (splashR > 0) {
      const base = (atkSiege && isStructureUnit(target)) ? totalRaw / atkSiege.TOWER_DAMAGE_MULT : totalRaw;
      this._applyExplosion(attacker, target, base, attackType, splashR);
    }
  }

  /**
   * ==================== v43 Q2b：残弹到达落点时的溅射结算 ====================
   * 用户："攻城车单位目标死亡后，发射出去的子弹就没有伤害了！只要子弹存在就应该有伤害！
   *        其他单位也是一样！""落点结算一次完整命中，如果目标已经死亡那么这个子弹照常
   *        走完流程但是不造成伤害，溅射给其他单位正常结算。"
   *
   * 这**推翻了 v43 之前的定稿**（那一版的原话是"这个子弹不造成任何伤害（包括爆炸型）"，
   * 当时还专门删掉了这条路径上的方法）。现在按新定稿恢复：主目标已死 → 直伤不结算，
   * 溅射照常对落点范围内的其他单位结算一次。
   *
   * 与 performAttackDirect 里那段溅射的差别只有两点，都是"目标已经不在了"逼出来的：
   *   ① onHitPct（攻击特效 %当前生命）按 0 算 —— 它的基数是目标当前生命，没有目标就没有基数；
   *   ② 不做 TOWER_DAMAGE_MULT 的除回操作 —— 这里的 totalRaw 从来没乘过它。
   */
  resolveSplashOnlyAt(hitInfo, x, y) {
    if (!hitInfo) return;
    const attacker = this.entities.get(hitInfo.attackerId);
    if (!attacker || !attacker.alive) return;
    const weaponDef = hitInfo.weaponId ? this.skills[hitInfo.weaponId] : null;
    const totalRaw = (hitInfo.baseDamage + hitInfo.onHitFixed)
      * (1 + hitInfo.dmgAmp / 100) * (hitInfo.preDamageMult ?? 1);
    if (!(totalRaw > 0)) return;
    const type = hitInfo.attackType;
    if (weaponDef && weaponDef.id === 'weapon_explosive') {
      this._applyExplosionAt(attacker, x, y, totalRaw, type, undefined, null);
    }
    const splashR = attacker.baseStats?.splashRadius || 0;
    if (splashR > 0) this._applyExplosionAt(attacker, x, y, totalRaw, type, splashR, null);
  }

  // 连锁伤害：从 origin 目标出发，向附近敌人依次弹射（供炎魂/雷魂等使用）
  connectChain(attackerId, originTarget, damage, attackType, bounces, radius = 180, color = '#e74c3c') {
    const attacker = this.entities.get(attackerId);
    if (!attacker) return;
    const hit = new Set([originTarget.id]);
    let current = originTarget;
    for (let i = 0; i < bounces; i++) {
      const nearby = this.entities.findInRadius(current.pos.x, current.pos.y, radius,
        ['melee', 'ranged', 'siege', 'super', 'totem', 'dragon', 'shield', 'warlock', 'corrupt'], true);
      let next = null, bestD = Infinity;
      for (const e of nearby) {
        if (hit.has(e.id) || !e.alive) continue;
        const d = Math.hypot(e.pos.x - current.pos.x, e.pos.y - current.pos.y);
        if (d < bestD) { bestD = d; next = e; }
      }
      if (!next) break;
      hit.add(next.id);
      // 视觉光束
      if (this.projectiles && this.projectiles.fireBeam) {
        this.projectiles.fireBeam({
          startX: current.pos.x, startY: current.pos.y,
          endX: next.pos.x, endY: next.pos.y,
          charge: 1, life: 0.12, color,
        });
      }
      this.performAttackDirect(attackerId, next.id, damage, attackType);
      current = next;
    }
  }

  /**
   * 巨龙被动「宿怨」：龙对某阵营的减伤/增伤，随该阵营已击杀的**元素龙**数量增长。
   * 两个方向都走这一个函数：
   *   · 龙**受到**某阵营的伤害 → 按该阵营的击杀数减伤；
   *   · 龙**打向**某阵营       → 按该阵营的击杀数增伤。
   * 击杀数由 DragonSystem 通过 setDragonKillCounts() 灌进来（远古龙不计入计数，
   * 但远古龙自己也吃这条被动 —— 用户定稿）。
   */
  _dragonGrudge(attacker, target) {
    const NONE = { k: 1, protective: false };
    const K = this._dragonKills;
    if (!K) return NONE;
    const p = (CONFIG.gameRules?.dragon?.passive) || {};
    const dr = p.damageReductionPerKill ?? 7, amp = p.damageAmpPerKill ?? 11;
    if (target?.type === 'dragon' && attacker) {
      const f = attacker._mapFaction || attacker.faction;
      const n = (f && K[f]) || 0;
      // 龙**受到**该阵营的伤害 → 减伤。纯保护性（k<1），所以只作用在"可被减免"的那一股。
      return n > 0 ? { k: Math.max(0, 1 - (dr * n) / 100), protective: true } : NONE;
    }
    if (attacker?.type === 'dragon' && target) {
      const f = target._mapFaction || target.faction;
      const n = (f && K[f]) || 0;
      // 龙**打向**该阵营 → 增伤。这是攻击方的属性（k>1），两股都吃
      //（与"哀兵"的增伤同口径：无视防御不该把攻击方的增益也一起无视掉）。
      return n > 0 ? { k: 1 + (amp * n) / 100, protective: false } : NONE;
    }
    return NONE;
  }

  /** DragonSystem 每次结算完击杀就灌一次：{ blue: n, red: n }（只数元素龙）。 */
  setDragonKillCounts(counts) { this._dragonKills = counts; }

  _applyExplosion(attacker, target, baseDamage, attackType, radiusOverride) {
    // 兼容旧调用：中心取目标坐标、排除主目标（主目标已单独结算直伤）。
    this._applyExplosionAt(attacker, target.pos.x, target.pos.y, baseDamage, attackType, radiusOverride, target.id);
  }

  // B2：溅射【依赖坐标】而非目标对象——目标中途死亡后子弹仍飞到原落点，在此结算溅射。
  _applyExplosionAt(attacker, centerX, centerY, baseDamage, attackType, radiusOverride, excludeId) {
    const radius = radiusOverride || 75;
    const targets = this.entities.findInRadius(centerX, centerY, radius, null, true);
    for (const t of targets) {
      if (excludeId != null && t.id === excludeId) continue;
      const dist = Math.hypot(t.pos.x - centerX, t.pos.y - centerY);
      if (dist > radius) continue;
      const splashFactor = 0.6 * Math.exp(-0.033 * dist);
      const splashDmg = baseDamage * splashFactor * 0.8;
      this.performAttackDirect(attacker.id, t.id, splashDmg, attackType);
    }
  }

  // （原 _resolveHitSplashOnly 已删除：主目标在途中死亡时，残弹现在飞到落点后
  //   **不造成任何伤害**，包括爆炸型的溅射。用户定稿，见 ProjectileSystem._hit。
  //   留着一个没人调的方法只会让下一个人以为"死了还会炸"。）

  // 哀兵条件加成：只在【小兵 打 小兵】时生效。
  //   攻击方带 avengerVsMinionAmpPct → 对敌方小兵伤害 ×(1+amp%)
  //   防御方带 avengerVsMinionRedPct → 来自敌方小兵的伤害 ×(1−red%)
  // 两者都由 LaneAvengerSystem 按层数（0~3）挂在单位身上；层数已折算进 stat 值。
  _applyAvenger(damage, attacker, target, atkStats, defStats) {
    if (!attacker || !target) return damage;
    const isMinion = (e) => e && e.type !== 'tower' && e.type !== 'dragon';
    if (!isMinion(attacker) || !isMinion(target)) return damage;
    const amp = (atkStats && atkStats.avengerVsMinionAmpPct) || 0;
    const red = (defStats && defStats.avengerVsMinionRedPct) || 0;
    if (amp) damage *= (1 + amp / 100);
    if (red) damage *= Math.max(0, 1 - red / 100);
    return damage;
  }

  _hasSkill(entity, skillId) {
    return (entity._skillInstances || []).some(i => i.skillId === skillId && !i._disabled);
  }

  /**
   * v33（Q10）：伤害转化 = 防御属性。
   * 受击方每受到 1 点【扣血伤害】，转化 (伤害转化% × 治疗护盾强度) 的临时护盾。
   * 只算扣血部分（用户定稿"仅扣血部分"）——护盾吸收掉的不再套娃转化，
   * 属性天然自限：护盾越厚转化越少，不会滚成永动机。
   */
  _applyDamageConversion(target, defStats, finalDamage) {
    const pct = defStats.damageConvertPct || 0;
    if (pct <= 0 || finalDamage <= 0 || !target.alive) return;
    grantTempShield(target, finalDamage * Math.min(pct / 100, 1), healPowerOf(defStats));
  }

  performAttackDirect(attackerId, targetId, baseDamage, attackType, options = {}) {
    { const _t = this.entities.get(targetId); if (_t && _t.type === 'tower' && window.__towerRuleFor?.('invincible', _t._mapFaction)) return 0; } // Q5：按阵营无敌
    const attacker = this.entities.get(attackerId);
    const target = this.entities.get(targetId);
    // 允许无攻击者的纯伤害来源（DOT、环境、龙魂等以字符串/0 为 source 的情况）
    if (!target || !target.alive) return 0;
    if (isStructureProtected(this.entities, target)) return 0; // 结构保护：真实伤害也无效

    if (attacker) {
      attacker._inCombat = true;
      attacker._combatTimer = 4;
    }

    const atkStats = attacker ? this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id)) : {};
    const defStats = this.attrCalc.calc(target, this.effects.getEffects(target.id));

    let damage = baseDamage;
    const dmgAmp = atkStats.damageAmpPct || 0;
    damage *= (1 + dmgAmp / 100);
    // ==================== v43 巨龙宿怨：增伤那一半 ====================
    // 拆开放置是有讲究的（见 _dragonGrudge 的注释）：
    //   · **增伤**（龙打向某阵营）是**攻击方**属性，与 damageAmpPct 同类 →
    //     放在这里，真实伤害也吃得到；
    //   · **减伤**（龙受到某阵营的伤害）是**防御方**属性，与 damageReduction 同类 →
    //     放在下面的减免块里，真实伤害照本项目既有口径**绕过**它。
    // 第一版我把两半都塞进减免块，结果龙的增伤对真伤完全不生效 —— 方向错了。
    const grudgeAmp = this._dragonGrudge(attacker, target);
    if (!grudgeAmp.protective && grudgeAmp.k !== 1) damage *= grudgeAmp.k;

    // 若目标当前持有护盾，额外造成一定比例伤害（如闪电杖破盾+7%）
    const shieldBeforeHit = (target.tempShield || 0) + (target.shieldFixedCurrent || 0);
    if (options.bonusVsShieldPct && shieldBeforeHit > 0) {
      damage *= (1 + options.bonusVsShieldPct / 100);
    }

    // 真实伤害：完全无视双抗/减伤/格挡，直接进入护盾吸收结算
    if (attackType === 'true') {
      // damage 保持不变（已含伤害增幅/破盾加成），直接跳到护盾吸收
    } else {
      let resist = 0, penPercent = 0, penFlat = 0;
      if (attackType === 'physical') {
        resist = defStats.armor || 0;
        penPercent = atkStats.armorPenPercent || 0;
        penFlat = atkStats.armorPenFlat || 0;
      } else if (attackType === 'magic') {
        resist = defStats.magicResist || 0;
        penPercent = atkStats.magicPenPercent || 0;
        penFlat = atkStats.magicPenFlat || 0;
      }
      if (options.armorPenPercent !== undefined) penPercent = options.armorPenPercent;
      if (options.armorPenFlat !== undefined) penFlat = options.armorPenFlat;

      // ==================== 无视防御比例 ====================
      // 这一部分伤害跳过双抗/伤害减免/格挡直接命中（仍受护盾吸收）。
      //
      // ⚠️ 只能无视【保护性】的那部分。用户指出的坑：目标的双抗/伤害减免/格挡
      // **是可以为负的**（编辑器下限 −100，天气/技能也能压到负），负值意味着
      // "受到的伤害更多" —— 那是给攻击方的增伤。如果"无视防御"把这一份也一起跳过，
      // 闪电杖满充 90% 打一个双抗 −50 的目标，反而比不无视还打得少，方向整个反了。
      //
      // 做法：被无视的那一股仍然吃【放大】的部分（乘子 > 1 / 负格挡），
      // 只跳过【削减】的部分（乘子 ≤ 1 / 正格挡）。
      // 于是当所有防御都 ≥ 0 时，keepAmp 恒为 1、blockNeg 恒为 0，
      // 结果与改动前**逐位一致**；只有出现负防御时行为才不同。
      const ignoreRatio = Math.max(0, Math.min(1, options.ignoreDefenseRatio || 0));
      const keepAmp = (m) => Math.max(1, m);   // 只保留放大，削减的部分交给 mitigated 那一股
      let ignoredDamage = damage * ignoreRatio;
      let mitigatedDamage = damage * (1 - ignoreRatio);

      const effectiveResist = this.attrCalc.calcEffectiveArmor(resist, penPercent, penFlat);
      const multiplier = this.attrCalc.calcDamageMultiplier(effectiveResist);
      mitigatedDamage *= multiplier;
      ignoredDamage *= keepAmp(multiplier);          // 双抗为负 → 增伤，保留

      const dmgReduction = defStats.damageReduction || 0;
      mitigatedDamage *= (1 - dmgReduction / 100);
      ignoredDamage *= keepAmp(1 - dmgReduction / 100);  // 减伤为负 → 增伤，保留
      // 防御护盾（唯一被动）：来自防御塔和超级兵的伤害降低30%（与 performAttack 路径一致，v33 含超级兵）
      // 0.7 恒 < 1（纯保护性），所以只作用在 mitigated 那一股 —— 与改动前一致。
      // v43 巨龙宿怨：**减伤**那一半（增伤已在上面处理，见那段注释）。
      // ⚠️ 这条路径把伤害拆成了 mitigated（可被减免）/ ignored（被"无视防御"跳过）两股，
      // 所以不能只写一句 `damage *= k` —— 那个 damage 变量在这里已经没有下游了
      //（我第一版就是这么写的，测出来伤害一点没变，等于这条被动完全没生效）。
      const grudge = this._dragonGrudge(attacker, target);
      if (grudge.protective && grudge.k !== 1) {
        mitigatedDamage *= grudge.k;
        ignoredDamage *= keepAmp(grudge.k);   // 保护性 → 只保留放大部分，与双抗/减伤同规则
      }
      // v43：同上，来源收窄到只有塔
      if (attacker && attacker.type === 'tower' && this._hasSkill(target, 'passive_siege_shield')) {
        mitigatedDamage *= 0.7;
      }
      // 哀兵条件加成（与 performAttack 路径一致）。它里面既有攻击方的增伤、
      // 也有防御方的减伤：增伤那半边属于攻击方的属性，不该被"无视防御"影响，
      // 所以被无视的那一股也照吃（同样用 keepAmp 保证只吃到放大的那部分）。
      const avengerFactor = this._applyAvenger(1, attacker, target, atkStats, defStats);
      mitigatedDamage *= avengerFactor;
      ignoredDamage *= keepAmp(avengerFactor);
      // 格挡是【平坦】值：正格挡 = 保护，只削减未被无视的那一股；
      // 负格挡 = 给攻击方的固定增伤，对整份伤害生效一次（分摊到两股会被算两遍）。
      const block = defStats.damageBlock || 0;
      mitigatedDamage = Math.max(0, mitigatedDamage - Math.max(0, block));

      damage = ignoredDamage + mitigatedDamage;
      damage = Math.max(0, damage - Math.min(0, block));
    }

    // 护盾吸收
    const shieldFactor = this.attrCalc.calcShieldAbsorbFactor(defStats.armor || 0, defStats.magicResist || 0);
    let tempShield = target.tempShield || 0;
    let fixedShield = target.shieldFixedCurrent || 0;
    let remainingDamage = damage;

    const effectiveTempShield = tempShield * shieldFactor;
    const absorbedByTemp = Math.min(remainingDamage, effectiveTempShield);
    const tempShieldConsumed = absorbedByTemp / shieldFactor;
    target.tempShield = Math.max(0, tempShield - tempShieldConsumed);
    remainingDamage -= absorbedByTemp;

    if (remainingDamage > 0 && fixedShield > 0) {
      const effectiveFixedShield = fixedShield * shieldFactor;
      const absorbedByFixed = Math.min(remainingDamage, effectiveFixedShield);
      const fixedShieldConsumed = absorbedByFixed / shieldFactor;
      target.shieldFixedCurrent = Math.max(0, fixedShield - fixedShieldConsumed);
      remainingDamage -= absorbedByFixed;
    }

    const finalDamage = Math.min(remainingDamage, target.currentHP);
    target.currentHP -= finalDamage;
    if (damage > 0) target.lastDamageTime = window.gameTime || 0;
    // 伤害转化（v33 Q10）：防御向，两条伤害路径（performAttack/Direct）行为一致
    this._applyDamageConversion(target, defStats, finalDamage);
    // 记录巨龙的伤害来源塔
    if (target.type === 'dragon' && finalDamage > 0 && attacker) {
      if (attacker.type === 'tower') (target._damagers = target._damagers || new Set()).add(attacker.id);
      // v43：最后一击归属（见 _resolveHit 里那条同样的注释）
      target._lastHitBy = attacker.id;
      target._lastHitFaction = attacker._mapFaction || attacker.faction || null;
    }
    // 使闪电杖、腐蚀型等通过 performAttackDirect 造成的伤害也能触发这些被动。
    if (attacker && !options._noProc && !this._procGuard) {
      this._procGuard = true;
      try {
        for (const inst of attacker._skillInstances || []) {
          const def = this.skills[inst.skillId];
          if (def && def.onDealtDamage && !inst._disabled) {
            def.onDealtDamage(attacker.id, target.id, inst, {
              entityContainer: this.entities, effectRegistry: this.effects, eventBus: this.eventBus,
              waveNumber: window.waveNumber || 0, attrCalc: this.attrCalc, combat: this,
              totalRaw: baseDamage, finalDamage, attackType,
            });
          }
        }
      } finally { this._procGuard = false; }
    }

    // v39 修复（历史 bug）：死亡判定必须带 alive 守卫。原来只看 currentHP<=0，
    // 已死单位在同帧再吃一次伤害（溅射/多攻击者/自损致死后的排队攻击）就会【重复发死亡事件】，
    // 污染复仇系统、超级兵触发、击杀计数等一切监听方（v39 冒烟实测：12 辆攻城车发出 20 次死亡）。
    if (target.currentHP <= 0 && target.alive) {
      target.currentHP = 0;
      target.alive = false;
      this.eventBus.emit('entity:death', { entityId: target.id });
    }

    return finalDamage;
  }
}
