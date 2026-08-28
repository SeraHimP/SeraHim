import { AttributeCalculator } from '../core/AttributeCalculator.js';
import { CONFIG, MELEE_RANGE_THRESHOLD } from '../data/Config.js';
import { canTarget, isStructureProtected, enemyUnitsInRadius } from './FactionSystem.js';
import { chargeParamsFor } from '../core/skills/attackModes.js';
import { healPowerOf, applyHeal, grantTempShield, effectiveFixedShieldMax } from '../core/healing.js';
import { resolveSkillParams } from '../core/skillParams.js';
import { canFire } from './FacingSystem.js';

// v40：攻城车规则辅助。**所有机制以"是否装备攻城武器被动"为闸门、数值从技能定义里读**——
// 拆掉被动，攻城车立刻退化成一辆普通车（用户要求：特殊机制必须由技能被动实现）。
const isStructureUnit = (e) => !!e && e.type === 'tower';   // 防御塔与水晶在本项目里都是 type='tower'
/**
 * ==================== v49：攻城车重做后的闸门 ====================
 * 旧的 passive_siege_weapon 已整个删除（用户："攻城车原有的全部删除"）。
 * 现在的闸门是【攻城炮】—— 三条被动里常驻的那一条；数值全部读 CONFIG.gameRules.ram，
 * 不再挂在技能对象上（那违反"所有数值软编码进 Config"这条硬约束）。
 */
export function hasRamCannon(e) {
  return !!e && !!e._skillInstances
    && e._skillInstances.some(i => i.skillId === 'passive_ram_cannon' && !i._disabled);
}
/** 攻城车当前模式：打防御塔 = 'siege'，打别的 = 'normal'；没装攻城炮则 null。 */
export function ramModeOf(e, target) {
  if (!hasRamCannon(e)) return null;
  // 优先按**这一次攻击的目标**判，没有传目标时退回被动 onFrame 记下的 _ramMode。
  if (target) return isStructureUnit(target) ? 'siege' : 'normal';
  return e._ramMode || 'normal';
}
/** 攻城车该用多大的溅射半径（模板 splashRadius 已改 0，半径完全由模式给出）。 */
export function ramSplashRadius(e, target) {
  const mode = ramModeOf(e, target);
  if (!mode) return 0;
  const R = CONFIG.gameRules?.ram || {};
  return mode === 'siege' ? (R.siegeSplash ?? 75) : (R.normalSplash ?? 25);
}
/** 近战单位 = 攻击距离 ≤ 阈值（近战30/超级兵/蚀骨兵 命中；炮车127.5/远程150/塔180 排除） */
const isMeleeUnit = (e) => !!e && (e.baseStats?.attackRange ?? 999) <= MELEE_RANGE_THRESHOLD;
// v2.5D（Q1）：模板未声明 bulletSpeed 的远程单位取此默认弹速（与防御塔同值）。
// 想给某兵种单独手感，在 Config 模板里补 bulletSpeed 即可覆盖，此处无需再改。
const DEFAULT_BULLET_SPEED = 400;

/**
 * ==================== v48：最后一击归属 ====================
 * 用户："依旧存在龙死了但是没有记上数的。"
 *
 * 两条伤害路径（_resolveHit / performAttackDirect）都要记"谁打的最后一下"，
 * 原来各写一行一模一样的赋值 —— 本仓库最常见的那种"同一条规则实现了两遍"。
 * 合成一处，顺带修掉一个真实的丢分原因。
 *
 * ==================== 中立的一击不该抹掉红蓝的归属 ====================
 * 归属字段原来是**无条件覆盖**的：谁最后打了一下就记谁的阵营。
 * 而龙是 neutral，于是只要最后一下来自中立方，owner 就变成 'neutral'，
 * DragonSystem._onDragonKilled 里 `owner === 'blue' || owner === 'red'` 判不过，
 * 表现就是用户说的"龙死了但是没有记上数"。
 *
 * 中立方能打到龙的两条路（都真实存在）：
 *   ① 龙自己的溅射打到自己 —— v48 已修（见 _applyExplosionAt 的头注）。
 *      龙的溅射半径 90 > 射程 80，每次攻击都必然波及自己，这是最高频的一条。
 *   ② 一条龙的溅射打到另一条龙 —— 用户明确要求保留这个交互。
 * ② 保留着，就必须让归属**不被中立方顶掉**：否则一条龙可以把另一条龙的奖励
 * 从两个阵营手里一起抢走，而两边都没做错任何事。
 *
 * 所以：`_lastHitBy` 仍然如实记录**字面意义上的最后一击者**（屠龙者要用它，
 * 中立击杀就没有屠龙者，这是对的）；而 `_lastHitFaction`（决定阵营奖励归属）
 * **只由红蓝双方更新** —— 中立的伤害不清空、也不覆盖上一位红/蓝攻击者。
 */
/**
 * ==================== v50：真实伤害的唯一判据 ====================
 * 用户："真实伤害会跳过护盾以及所有防御手段直接对生命值造成伤害。"
 *
 * 抽成一个函数是因为两条伤害路径改动前的口径**不一样**（本仓库的老毛病）：
 *   · performAttackDirect：真伤跳过双抗/减伤/格挡，但**仍然被护盾吸收**；
 *   · _resolveHit：根本没有真伤分支 —— 只是因为 resist 取不到值而乘子恰好是 1，
 *     减伤、格挡、护盾统统照吃。
 * 现在两条都问这一个函数，跳过的东西也完全一致（含护盾）。
 */
function isTrueDamage(attackType) { return attackType === 'true'; }

/**
 * v51：一次攻击命中了几个目标——决定吸血按哪个效率算。
 * 用户："主单位+其他单位的溅射伤害，主单位吸血按100%算，其他单位的溅射伤害按20%算。
 *        如果是连锁，没有主目标，是直接的群体伤害，就全部按20%算。"
 * 不按"这次行动一共打了几个人"现算（那需要跨调用聚合，麻烦且脆弱），而是按【调用点的性质】
 * 分类：主命中路径（_resolveHit、大多数 performAttackDirect 调用）恒为主目标，溅射
 * （_applyExplosionAt）与连锁（connectChain）在各自的调用处显式标记 options.vampGroup。
 */
function vampEfficiency(options) {
  if (!options || !options.vampGroup) return 1;
  return Math.max(0, Math.min(1, (CONFIG.tuning?.vamp?.groupEffPct ?? 20) / 100));
}

/**
 * v51：统一吸血结算——物理/法术/全能三件套，两条伤害路径（_resolveHit/performAttackDirect）
 * 共用一份（本仓库"同一条规则两处各写一份"的教训，这次一开始就避开）。
 * 全能吸血（lifeStealPct）计入一切伤害类型（含真实伤害）；物理/法术只计入对应类型。
 * `vampEff`：群体命中（溅射/连锁）按 CONFIG.tuning.vamp.groupEffPct 打折，主目标 100%。
 */
function applyVamp(combat, attacker, damage, attackType, vampEff) {
  if (!attacker || !(damage > 0)) return;
  const atkStats = combat.attrCalc.calc(attacker, combat.effects.getEffects(attacker.id));
  let pct = atkStats.lifeStealPct || 0; // 全能吸血：什么类型的伤害都算
  if (attackType === 'physical') pct += atkStats.physicalVampPct || 0;
  else if (attackType === 'magic') pct += atkStats.spellVampPct || 0;
  if (pct <= 0) return;
  const power = healPowerOf(atkStats);
  const steal = damage * (pct / 100) * vampEff;
  const maxHP = atkStats.maxHP || 1;
  // ⚠️ 这两个比例原来在 _resolveHit 里是写死的 0.5/0.5——CONFIG.gameRules 里其实
  // 一直有 lifeStealToHealth/lifeStealToShield 这两个"死配置"（存在但没人读），
  // 默认值恰好都是 50，所以行为不变；现在把它们真正接上，以后想调回血/加盾的比例
  // 就不用再改代码了。
  const toHealth = (CONFIG.gameRules?.lifeStealToHealth ?? 50) / 100;
  const toShield = (CONFIG.gameRules?.lifeStealToShield ?? 50) / 100;
  applyHeal(attacker, steal * toHealth, power, maxHP);
  grantTempShield(attacker, steal * toShield, power);
}

function recordLastHit(target, attacker) {
  if (!target || !attacker) return;
  target._lastHitBy = attacker.id;
  const fac = attacker._mapFaction || attacker.faction || null;
  if (fac === 'blue' || fac === 'red') target._lastHitFaction = fac;
}

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
        // ==================== v49：攻速可以为 0 之后的解冻 ====================
        // 攻速 0 时 attackIntervalOf 给的是 Infinity（= 永不攻击，这是对的）。
        // 但 Infinity 减多少还是 Infinity，**攻速恢复之后也永远打不出来**了 ——
        // 攻城车在普通模式下会 1%/3s 地回攻速，回来了却是一辆永久哑火的车。
        // 所以这里补一条解冻：冷却是 Infinity 而当前攻速已经 > 0 → 按当前攻速重设。
        if (!Number.isFinite(entity.attackCooldown)) {
          if (curAS > 0) { entity.attackCooldown = 1 / curAS; entity._cdAS = curAS; }
        } else {
          // attackCooldown 存"剩余秒数"，但按当前攻速等比缩放推进：
          // 剩余秒数 -= dt × (当前攻速 / 设定冷却时的攻速)。用 _cdAS 记录设定时攻速。
          // curAS = 0 时这一项恰好是 0 —— 冷却原地冻住，语义正确，不用特判。
          const refAS = entity._cdAS || curAS || 0.5;
          entity.attackCooldown -= dt * (curAS / (refAS || 0.5));
        }
      }
      if (entity.attackCooldown < 0) entity.attackCooldown = 0;

      // ==================== v49：充能型攻击的通用推进 ====================
      // 用户："充能如果被打断了，每秒减少 10% 当前充能，
      //        **以后所有的充能型武器都是这样**，但是数可能会改。"
      // 所以这一段写成与"谁在充能"无关的通用逻辑：任何单位只要 chargeNeedOf() 说
      // 它此刻处于充能状态，就在这里推进/衰减。将来新增充能型武器只要接上那个判据。
      this._tickCharge(entity, stats, dt);

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
        // v51：缴械——能索敌、能瞄准，但打不出去（与眩晕的区别是眩晕连目标都不选）。
        if (dx * dx + dy * dy <= range * range && tower.attackCooldown <= 0
            && !((window.gameTime || 0) < (tower._lockUntil || 0)) && !this.effects.isDisarmed(tower.id)) {
          this.performAttack(tower, target);
          const finalAS = this.attrCalc.calcAttackSpeedOf(
            this.attrCalc.calc(tower, this.effects.getEffects(tower.id)));
          tower.attackCooldown = this.attrCalc.attackIntervalOf(finalAS);
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
      // v45：朝向门（与对战路径共用 canFire 这一份实现，不在这里再判一次角差）。
      // v49：充能型攻击（攻城车的攻城模式）没充满就不开火，见 chargeReady/_tickCharge。
      if (dist <= range && minion.attackCooldown <= 0 && this.chargeReady(minion, nearestTower)
          && !((window.gameTime || 0) < (minion._lockUntil || 0)) && !this.effects.isDisarmed(minion.id)
          && canFire(minion, nearestTower)) {
        minion.targetId = nearestTower.id;
        this.performAttack(minion, nearestTower);
        // v43 Q2：与对战路径共用同一个攻城结算（攻速 -50% + 自损 20%）。
        const finalAS = this.finishAttack(minion, nearestTower, this.attrCalc.calcAttackSpeedOf(
          this.attrCalc.calc(minion, this.effects.getEffects(minion.id))));
        minion.attackCooldown = this.attrCalc.attackIntervalOf(finalAS);
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
    if (!hasRamCannon(attacker)) return target;
    const locked = attacker._ramLockId ? this.entities.get(attacker._ramLockId) : null;
    if (locked && locked.alive) return locked;         // 锁定期间无视一切其他目标
    attacker._ramLockId = null;
    if (target && isStructureUnit(target) && !isStructureProtected(this.entities, target)) {
      attacker._ramLockId = target.id;                 // 首次锁定
    }
    return target;
  }

  /**
   * 一次攻击**结算完之后**的攻城副作用：攻速倍率 + 自损衰减 + 破甲重击。
   * 传入调用方已算好的攻速，返回应当写进 attackCooldown 的最终攻速。
   * 没装攻城武器、或打的不是建筑时，原样返回 —— 调用方不需要自己判断。
   *
   * 用户定稿（2026-08）改动两处：
   *  ① 自损从"每次攻击扣 20% 最大生命"改成"每次攻击叠一层 -25% 当前攻速，
   *     永久不衰减、无上限叠加"——不再是打塔打到自爆，而是打得越久车越慢，
   *     逼玩家取舍"继续磨这座塔"还是"换个目标/撤退"，不会自己把自己打死。
   *  ② 新增【破甲重击】：每次攻击命中某座塔，若这座塔不在自己的 900 秒冷却里，
   *     额外造成其当前生命 10%（50% 真实伤害 + 50% 攻城车自身伤害类型物理伤害）、
   *     随后把这座塔的冷却单独钉住 900 秒——冷却记在【塔]身上，不管哪辆攻城车
   *     打中都共用同一个冷却；但塔与塔之间完全独立，不会互相占用彼此的冷却。
   */
  /**
   * 这个单位此刻是否需要充能才能攻击 —— 返回 { need:true, secAt1AS } 或 null。
   *
   * 目前只有攻城车的【攻城模式】用到（对防御塔充能攻击）。
   * 独立成一个判据而不是把 ram 的逻辑散在各处，是为了让"以后所有的充能型武器"
   * 都只需要在这里加一个分支，推进/衰减/清零那套通用代码一行都不用动。
   */
  chargeNeedOf(entity, target) {
    // v49：不再认"是不是攻城车"，只认**装没装攻击方式技能**（用户："单独做成技能"）。
    // 目标类型的过滤在 chargeParamsFor 里按技能自己的 onlyVs 参数做。
    // 没传 target 时用当前目标 —— 每帧推进充能时调用方拿不到"这一次攻击的目标"。
    const tgt = target || (entity && entity.targetId ? this.entities.get(entity.targetId) : null);
    return chargeParamsFor(entity, tgt, this.skills);
  }

  /**
   * 充能推进 / 打断衰减。每帧对每个实体调一次（在冷却推进旁边）。
   *
   *   · 处于充能状态 → 按**当前攻速**充：1.0 攻速下用满 secAt1AS 秒，
   *     所以每秒推进 attackSpeed / secAt1AS。攻速被【攻城疲惫】压低时充能自然变慢，
   *     "攻速影响充能速度"这条就是这么落地的，不需要另写一份缩放。
   *   · 不在充能状态（被打断：切了目标 / 目标没了 / 退出攻城模式）
   *     → 每秒衰减**当前充能**的 decayPctPerSec%（等比，用户原话是"减少10%当前充能"）。
   */
  _tickCharge(entity, stats, dt) {
    const need = this.chargeNeedOf(entity);
    if (need) {
      const as = this.attrCalc.calcAttackSpeedOf(stats);
      const per = Math.max(0.01, need.secAt1AS);
      entity._charge = Math.min(1, (entity._charge || 0) + dt * as / per);
      entity._chargeDecay = need.decayPctPerSec;   // 记下来：打断之后按**这件武器**的衰减率走
      return;
    }
    const c = entity._charge || 0;
    if (c <= 0) { if (c !== 0) entity._charge = 0; return; }
    const pct = (entity._chargeDecay ?? CONFIG.tuning?.charge?.decayPctPerSec ?? 10) / 100;
    const next = c * Math.pow(1 - pct, dt);
    entity._charge = next < 1e-4 ? 0 : next;
  }

  /** 充能没满就不许开火（没有充能需求的单位恒为 true）。 */
  chargeReady(entity, target) {
    return !this.chargeNeedOf(entity, target) || (entity._charge || 0) >= 1;
  }

  finishAttack(attacker, target, finalAS) {
    // ==================== v50：清零充能与叠攻城疲惫是两件事 ====================
    // 用户："攻城车在攻击小兵时，充能满了之后不会清零，而是满充能后持续攻击。"
    // 根因是我上一版把"打出去 → 充能清零"写在了这个函数**里面**，而函数第一行是
    // `if (!hasRamCannon || !isStructureUnit(target)) return` —— 打小兵直接 return，
    // 清零那句根本走不到。充能改成 onlyVs:'any' 之后这个洞才暴露出来。
    //
    // 所以拆开：**任何充能攻击打出去都清零**（与打的是谁无关），
    // 攻城疲惫仍然只在打建筑时叠。
    if (attacker && (attacker._charge || 0) > 0 && this.chargeNeedOf(attacker, target)) {
      attacker._charge = 0;
    }
    if (!hasRamCannon(attacker) || !isStructureUnit(target)) return finalAS;
    const R = CONFIG.gameRules?.ram || {};
    // 攻城疲惫：每次**攻城**攻击叠 fatiguePerAttack 层，每层 fatigueLayerPct%。
    // 无上限（用户定稿 Q5："不用"封顶）；恢复只在普通模式下发生，
    // 由 passive_ram_cannon.onFrame 负责 —— 这里只管叠，别在两处各写一半。
    const layers = R.fatiguePerAttack ?? 7;
    const per = R.fatigueLayerPct ?? -1;
    const id = this.effects.apply(attacker.id, {
      name: '攻城疲惫', icon: '🐌', kind: 'stat', color: '#8d6e63', type: 'debuff',
      statKey: 'bonusAttackSpeedPct', flatValue: per, perStackFlat: per,
      duration: Infinity, permanent: true,
      stackable: true, maxStacks: 99999, stackPolicy: 'stack', uniquePassive: true,
      // EffectRegistry 只认 description 里的 {stacks}（descTemplate/{val} 是 SkillLibrary
      // 那条完全独立的渲染管线，这里不适用）——别抄错管线，写了也不会生效。
      description: `攻城疲惫（{stacks}层，每层攻速${per}%）`,
    }, 'passive_ram_fatigue');
    // apply 只叠 1 层，这里补足到 layers 层（7% = 7 层 × 1%，用户指定的做法）
    const eff = this.effects.getEffect(id);
    if (eff && layers > 1) {
      eff.stacks += (layers - 1);
      this.effects._recalcEffectValues(eff);
      this.effects._updateDescription(eff);
    }
    return finalAS;   // 攻城模式不再额外乘攻速倍率（旧的 -50% 已随旧被动删除）
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
      // v51：'adaptive' 在开火那一刻就解析成 physical/magic 并快照——与其它攻击方数值
      // 同一个时序（见下面那段关于四项穿透"完全不需要活着的攻击者"的注释）。
      attackType: this.attrCalc.resolveAttackType(atkStats) || 'physical',
      // v51：普攻默认能暴击（暴击率默认0，没有来源加成时恒不触发），在开火那一刻掷骰
      // 并快照——与其余攻击方数值同一时序，命中结算时不会因为攻击者已死而判不出来。
      isCrit: Math.random() * 100 < (atkStats.critChance || 0),
      critMult: (CONFIG.tuning?.crit?.baseCritDamagePct ?? 200) + (atkStats.critDamagePct || 0),
      // v49：穿透四项也在开火那一刻快照。
      // 用户："无论攻击单位是否死亡，只要发出去的子弹就造成伤害。"
      // 命中结算原来要拿**攻击者此刻的属性表**去读穿透，攻击者死了就读不到 ——
      // 那正是 _resolveHit 里 `!attacker.alive → return` 的理由之一。
      // 攻击侧的其余数值（攻击力/攻击特效/伤害增幅/伤害类型）本来就已经快照在这里了，
      // 补上这四项之后，命中结算**完全不需要活着的攻击者**。
      armorPenPercent: atkStats.armorPenPercent || 0,
      armorPenFlat: atkStats.armorPenFlat || 0,
      magicPenPercent: atkStats.magicPenPercent || 0,
      magicPenFlat: atkStats.magicPenFlat || 0,
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
    // v49：**攻击者死了不影响已经发出去的这一发**（用户定稿）。
    // 原来这里是 `!attacker || !attacker.alive || ...` —— 塔在自己的炮弹飞行途中被推掉，
    // 那一发就整个消失，哪怕目标还活得好好的。这就是用户报的"子弹没伤害"。
    // 攻击侧要用的数值全部在开火时快照进 hitInfo 了（含四项穿透），
    // 所以这里只需要攻击者**存在**（拿它的 id/阵营记归属、拿技能实例触发被动），不需要它活着。
    if (!attacker || !target || !target.alive) return;
    // Q7：全塔无敌开关（设置窗口）——建筑不再受到任何伤害
    if (target.type === 'tower' && window.__towerRuleFor?.('invincible', target._mapFaction)) return; // Q5：按阵营无敌

    const atkStats = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id));
    const defStats = this.attrCalc.calc(target, this.effects.getEffects(target.id));
    const weaponInst = (hitInfo.weaponInstId != null)
      ? attacker._skillInstances?.find(s => s.id === hitInfo.weaponInstId)
      : null;
    const weaponDef = hitInfo.weaponId ? this.skills[hitInfo.weaponId] : null;

    // v51：闪避——只对普通攻击生效（技能不可被闪避，这是本项目对"技能"与"普攻"
    // 唯一有意义的边界之一：普攻能被躲开，技能是判定命中之后的数值结算，不走这里）。
    // 掷骰放在命中结算这一刻（用目标此刻的闪避率），不在开火时快照——闪避是防御方属性，
    // 应该用命中那一刻的实时数值，与护甲/护盾同一口径。
    if (Math.random() * 100 < (defStats.evasionPct || 0)) {
      this.eventBus.emit('damage:evaded', { sourceId: attacker.id, targetId: target.id });
      return;
    }

    const onHitPct = hitInfo.onHitPctBase * target.currentHP;
    const preMult = hitInfo.preDamageMult ?? 1;
    let totalRaw = ((hitInfo.baseDamage + hitInfo.onHitFixed + onHitPct) * (1 + hitInfo.dmgAmp / 100)) * preMult;
    // v51：暴击——开火那一刻已经掷过骰、算好倍率（见 performAttack 里 hitInfo.isCrit
    // 的头注），这里只管乘。放在最前面，后续的攻城/巨龙/哀兵等乘子都在这个基础上叠加，
    // 与伤害增幅（dmgAmp）同一层级——暴击本来就该是"这一下打多疼"的一部分，不是特例。
    if (hitInfo.isCrit) totalRaw *= (hitInfo.critMult || 200) / 100;

    // ===== v40 攻城武器被动：伤害侧修正（装备了被动才生效，数值取自技能定义）=====
    // ① 打建筑 ×(1+TOWER_DAMAGE_MULT_PCT)——仅走这条主命中路径；溅射由 performAttackDirect
    //    结算，天然不含增幅（用户定稿："有溅射，不过只对塔有额外伤害增幅"）。
    // ② 打小兵 ×0.67（-33%）　③ 近战单位打它 ×2（+100%）
    // v49 攻城车：攻城模式对塔 ×siegeDamagePct%，普通模式对其余目标吃 normalDamageAmpPct。
    // 旧的"近战单位打攻城车 +100%"已按用户定稿删除，不再有 tgtSiege 这一段。
    // v49：高倍率那一半由**充能攻击技能**给（damagePct，可换武器/可编辑），
    // 低倍率那一半仍是攻城车【普通模式】自己的性格（normalDamageAmpPct）。
    // 两件事分开：换一件别的攻击方式时，普通模式的减伤不该跟着变。
    const chargeP = chargeParamsFor(attacker, target, this.skills);
    if (chargeP) totalRaw *= chargeP.damageMult;   // 充能武器自带的倍率（攻城车用中性 100）
    // 攻城车自己的两档：对建筑 siegeDamagePct%，对其余目标 normalDamageAmpPct。
    // v49b 起充能对所有目标生效，所以这两档不再与"要不要充能"绑在一起判 —— 只看目标是不是建筑。
    if (hasRamCannon(attacker)) {
      const R = CONFIG.gameRules?.ram || {};
      totalRaw *= isStructureUnit(target)
        ? (R.siegeDamagePct ?? 700) / 100
        : (1 + (R.normalDamageAmpPct ?? -33) / 100);
    }

    // ---- 防御计算（支持护甲穿透和魔法穿透） ----
    const attackType = hitInfo.attackType;
    let resist = 0, penPercent = 0, penFlat = 0;
    if (attackType === 'physical') {
      resist = defStats.armor || 0;
      penPercent = hitInfo.armorPenPercent ?? (atkStats.armorPenPercent || 0);
      penFlat = hitInfo.armorPenFlat ?? (atkStats.armorPenFlat || 0);
    } else if (attackType === 'magic') {
      resist = defStats.magicResist || 0;
      penPercent = hitInfo.magicPenPercent ?? (atkStats.magicPenPercent || 0);
      penFlat = hitInfo.magicPenFlat ?? (atkStats.magicPenFlat || 0);
    }

    // v50：真伤跳过一切防御手段（见 isTrueDamage 的头注）。两条路径共用同一个判据。
    const trueDmg = isTrueDamage(attackType);
    const effectiveResist = this.attrCalc.calcEffectiveArmor(resist, penPercent, penFlat);
    const multiplier = trueDmg ? 1 : this.attrCalc.calcDamageMultiplier(effectiveResist);
    let damage = totalRaw * multiplier;

    // 结构保护（LoL"不可选中"）：受保护的水晶不吃任何伤害。
    // 正常流程索敌层已过滤，这里兜底（溅射/连锁/光束等间接伤害路径）。
    if (isStructureProtected(this.entities, target)) return 0;

    // 伤害减免 & 格挡。真伤全部跳过。
    // ⚠️ 减伤**为负时是增伤**（用户："伤害减免等（不包括双抗）为负时叠加额外伤害"）——
    // `1 − (−20)/100 = 1.2` 这条乘法天然就是这个行为，不用特判；
    // 写下来是因为它看起来像"只会削减"，改的时候别顺手夹成 Math.min(1, …)。
    const dmgReduction = trueDmg ? 0 : (defStats.damageReduction || 0);
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
    damage *= this._dragonVsMinionBonus(attacker, target);
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
    // 格挡同样：真伤跳过；为负时是加伤（damage − (−5) = damage + 5）。
    const block = trueDmg ? 0 : (defStats.damageBlock || 0);
    damage = Math.max(0, damage - block);

    // ---- 护盾吸收 ----
    let remainingDamage = this._absorbByShields(target, damage, defStats, trueDmg);

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
      if (atk) recordLastHit(target, atk);
    }
    const totalAbsorbed = damage - remainingDamage;

    // ---- 伤害转化（v33 Q10 重做：防御向） ----
    // 定义：转化的临时护盾值 = 【受击方】实际受到的伤害（仅扣血部分，护盾吸收不计）× 受击方伤害转化%。
    // 原实现挂在攻击方（打人回盾）——方向整个是反的，等于这条属性从没按设计工作过。
    this._applyDamageConversion(target, defStats, finalDamage);

    // ---- 生命偷取（v51：物理/法术/全能三件套统一实现，见 applyVamp）----
    // 这是主命中路径，vampEff 恒为 1（100%）——溅射/连锁走各自调用点的 vampGroup 标记。
    applyVamp(this, attacker, damage, attackType, 1);

    // ---- 触发被动（普通攻击恒为一次完整攻击，attackShare=1）----
    // 具体节奏/累加逻辑统一在 _fireOnDealtDamage 里实现，两条伤害路径共用一份代码，
    // 不再各写一份（武器与其余被动过去分两段实现，现在统一走同一个 _skillInstances 循环）。
    this._fireOnDealtDamage(attacker, target, 1, { totalRaw, finalDamage, attackType });
    this._fireOnDamaged(target, attacker, finalDamage);   // 受击方的防御型被动（钢魂反弹等）

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
      // v50：护盾吸收合并进 _absorbByShields 之后这里不再有局部的 shieldFactor 变量。
      // 事件里保留这一项是为了不改监听方的形状，现算一次（与吸收时同一个公式）。
      shieldFactor: this.attrCalc.calcShieldAbsorbFactor(defStats.armor || 0, defStats.magicResist || 0),
    });

    // ---- 爆炸溅射 ----
    if (weaponDef && weaponDef.id === 'weapon_explosive') {
      this._applyExplosion(attacker, target, totalRaw, attackType);
    }
    // 普攻自带溅射。闸门是"模板里写了 splashRadius 就溅射"（v43 放宽的）——
    // 原来它与攻城武器被动绑死，于是**巨龙的溅射从来没生效过**：
    // createDragon 按用户定稿给龙写了 baseStats.splashRadius = 90，但龙没有那条被动。
    //
    // v49 攻城车：模板 splashRadius 已改 0，半径改由【攻城炮】按模式给出
    // （攻城 siegeSplash / 普通 normalSplash），所以这里要把两个来源取大的那个。
    // 溅射的基数把攻城模式那份增幅**除回去**：用户定稿的口径一直是
    // "额外增幅只对塔生效"，溅射打的是塔周围的别的单位，不该跟着吃。
    const R49 = CONFIG.gameRules?.ram || {};
    const ramR = ramSplashRadius(attacker, target);
    const splashR = Math.max(attacker.baseStats?.splashRadius || 0, ramR);
    if (splashR > 0) {
      // 溅射把"只对主目标生效"的那两档增幅除回去（口径一直是：额外增幅只作用于主目标）
      const siegeMult = (chargeP ? chargeP.damageMult : 1)
        * (hasRamCannon(attacker)
            ? (isStructureUnit(target) ? (R49.siegeDamagePct ?? 700) / 100
                                       : (1 + (R49.normalDamageAmpPct ?? -33) / 100))
            : 1);
      this._applyExplosion(attacker, target, totalRaw / siegeMult, attackType, splashR);
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
    // v49：同 _resolveHit —— 攻击者死了，已经发出去的这一发照样结算（用户定稿）。
    const attacker = this.entities.get(hitInfo.attackerId);
    if (!attacker) return;
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
      // v49：连锁同样走 enemyUnitsInRadius（与腐蚀是同一个坑：不认阵营 + 白名单漏 'ram'）。
      // 起点是 current，但"友军"要按**发起者**的阵营算 —— 连锁弹到谁身上，
      // 判敌我的都该是放技能的那一方，而不是被弹到的那个单位。
      // 查询点是 current（上一跳），但敌我要按**发起者 attacker** 的阵营算 ——
      // 连锁弹到谁身上，判敌我的都该是放技能的那一方。造一个只带位置与阵营的探针对象，
      // id 给 -1 保证 "排除自己" 这条不会误伤真实体。
      const probe = { id: -1, pos: current.pos, alive: true,
        _mapFaction: attacker._mapFaction || attacker.faction, faction: attacker.faction };
      const nearby = enemyUnitsInRadius(this.entities, probe, radius);
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
      // v51：连锁没有"主目标"（用户定稿），吸血按 vampGroup 折扣统一走 20%。
      this.performAttackDirect(attackerId, next.id, damage, attackType, { vampGroup: true });
      current = next;
    }
  }

  /**
   * 巨龙新增被动：对小兵单位造成额外 100% 伤害（用户定稿）。"小兵"= 除塔、龙之外的
   * 全部单位（近战/远程/炮兵/图腾/超级/术士/蚀骨/攻城车都算）。
   * 与"宿怨"同一挂载方式：纯攻击方增伤，不分保护/非保护，两个消耗真伤旁路的
   * 调用点都要吃到（_resolveHit 单点乘、performAttackDirect 拆开成
   * mitigated/ignored 两股都要乘）。
   */
  _dragonVsMinionBonus(attacker, target) {
    if (attacker?.type !== 'dragon' || !target) return 1;
    if (target.type === 'tower' || target.type === 'dragon') return 1;
    return 2; // +100%
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

  _applyExplosion(attacker, target, baseDamage, attackType, radiusOverride, opts) {
    // 兼容旧调用：中心取目标坐标、排除主目标（主目标已单独结算直伤）。
    this._applyExplosionAt(attacker, target.pos.x, target.pos.y, baseDamage, attackType, radiusOverride, target.id, opts);
  }

  // B2：溅射【依赖坐标】而非目标对象——目标中途死亡后子弹仍飞到原落点，在此结算溅射。
  /**
   * ==================== v48：溅射不再打到自己 ====================
   * 用户："暗龙的那个龙魂技能会对自己造成伤害，并且也会对其他龙造成伤害。
   *        现统一：无法对自己造成伤害，但是会对其他龙造成伤害。"
   *
   * 排查结论与用户的猜测不同，如实记下：**跟暗魂没有关系**。暗魂只叠抗性 debuff /
   * 自身 buff，全项目没有第三处引用，代码层面不可能直接造成伤害。
   * 真正的来源是**溅射**：这个函数拿 findInRadius 的结果直接开打，
   * 既不认阵营、也不认查询者自己 —— 而 findInRadius 一定会把站在圆心附近的
   * 攻击者本人返回回来。
   *
   * 为什么现在才暴露出来：龙的 splashRadius 是 90，而它的射程在 v47 从 200 改成了 80。
   * 200 > 90 时龙站在自己爆点之外，几乎不会波及自己；80 < 90 之后，
   * **龙每一次攻击都必然站在自己的爆炸范围里**。
   * 也就是说这是个一直存在的老 bug，被我上一轮的射程改动变成了每次必现 ——
   * 这一点要写清楚，免得后来的人以为是 v48 引入的。
   *
   * 修法与本项目既有的光环过滤同源（见 _helpers.js 那段"findInRadius 不认阵营
   * 也不认查询者"的注释）：那边早就踩过并修过同一个坑，这里补上。
   *
   * 打到**别的龙**是用户明确要保留的（"会对其他龙造成伤害"），所以这里
   * 只排除攻击者本人，不做任何阵营过滤。
   * 是否应当连友军一起排除，是另一个尚未定稿的问题 —— 留成 CONFIG 开关
   * `tuning.splash.hitAllies`，默认 true = 与改动前逐位一致，等用户拍板再翻。
   *
   * ==================== v51：这里溅射到的每一下算不算"技能增幅/技能暴击" ====================
   * 这个函数被两类完全不同的调用方共用：① 普攻自带的溅射（龙/攻城车，模板
   * splashRadius 或【攻城炮】给的半径）——这其实是普攻，只是多了一圈溅射；
   * ② 龙魂的主动溅射（炎魂，onDealtDamage 里显式调 combat._applyExplosion）——
   * 这是真正的技能效果。两者共用一份实现，但"算不算技能"必须分开标记，
   * 默认按①（更常见的调用方）算普攻，炎魂在自己的调用点显式传 { basicAttack:false }
   * 覆盖。溅射天然是【群体命中】，吸血固定按 vampGroup 的折扣走。
   */
  _applyExplosionAt(attacker, centerX, centerY, baseDamage, attackType, radiusOverride, excludeId, opts = {}) {
    const basicAttack = opts.basicAttack !== false; // 默认 true：普攻自带溅射
    const radius = radiusOverride || 75;
    const cfg = CONFIG.tuning?.splash || {};
    const atkFac = attacker ? (attacker._mapFaction || attacker.faction || null) : null;
    const targets = this.entities.findInRadius(centerX, centerY, radius, null, true);
    for (const t of targets) {
      if (excludeId != null && t.id === excludeId) continue;
      // 自己永远不吃自己的溅射（用户定稿）。
      if (attacker && t.id === attacker.id && cfg.hitSelf !== true) continue;
      // 友军是否吃溅射：默认吃（改动前的行为），开关见上面的头注。
      // 中立（龙）之间**不算友军**：龙互相是敌人，用户明确要求要能互相打到。
      if (cfg.hitAllies === false && attacker && atkFac && atkFac !== 'neutral') {
        const tf = t._mapFaction || t.faction || null;
        if (tf && tf === atkFac) continue;
      }
      const dist = Math.hypot(t.pos.x - centerX, t.pos.y - centerY);
      if (dist > radius) continue;
      const splashFactor = 0.6 * Math.exp(-0.033 * dist);
      const splashDmg = baseDamage * splashFactor * 0.8;
      this.performAttackDirect(attacker.id, t.id, splashDmg, attackType,
        { basicAttack, vampGroup: true });
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

  /**
   * ==================== v50：分裂弹（星魂）====================
   * 从 origin 目标出发，向半径内最近的 N 个**其他**敌人各发一枚小弹。
   *
   * 用户定稿："分裂子弹不触发任何技能/被动等，但是攻击特效%/攻击特效固定
   *            以 55% 的效率工作。"
   * 这两条正好对应 performAttackDirect 已有的两个开关：
   *   · `_noProc: true`        → 一个被动都不触发（否则毒/暗/蚀的叠层速度直接翻三倍）
   *   · `applyOnHitBonus` + `attackShare: 0.55` → 攻击特效按 55% 效率并入
   * 不需要为它新造任何机制。
   *
   * 走真实弹道而不是瞬时结算，是为了**看得见**（用户问"分裂后的小弹道怎么显示"）：
   * 小弹用比主弹更小的 size 与该元素的颜色，渲染层照原样画，不用改渲染代码。
   */
  splitShot(attacker, origin, damage, attackType, opt = {}) {
    if (!attacker || !origin || !this.projectiles) return 0;
    const radius = opt.radius ?? 260;
    const want = Math.max(0, opt.splits ?? 2);
    if (want === 0 || !(damage > 0)) return 0;
    const probe = { id: origin.id, pos: origin.pos, alive: true,
      _mapFaction: attacker._mapFaction || attacker.faction, faction: attacker.faction };
    const cands = enemyUnitsInRadius(this.entities, probe, radius, { includeBuildings: true })
      .filter(e => e.id !== origin.id && e.id !== attacker.id)
      .map(e => ({ e, d: Math.hypot(e.pos.x - origin.pos.x, e.pos.y - origin.pos.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, want);
    for (const { e } of cands) {
      this.projectiles.fire({
        attackerId: attacker.id, targetId: e.id,
        startX: origin.pos.x, startY: origin.pos.y,
        currentX: origin.pos.x, currentY: origin.pos.y,
        progress: 0, speed: 520,
        size: 7,                       // 比塔弹(20)/兵弹(12)都小 —— 一眼看出是分裂出来的
        color: opt.color || '#7c6cf5',
        directHit: {
          attackerId: attacker.id, damage, type: attackType,
          // v51：分裂弹是"次要目标"，吸血按 vampGroup 折扣（与溅射/连锁同口径）。
          options: { _noProc: true, applyOnHitBonus: true, vampGroup: true,
                     attackShare: Math.max(0, Math.min(1, (opt.onHitEffPct ?? 55) / 100)) },
        },
      });
    }
    return cands.length;
  }

  /**
   * ==================== v50：受击回调（防御向被动的唯一入口）====================
   * 与 _fireOnDealtDamage 互为镜像 —— 那个是"我打了别人"，这个是"我被打了"。
   * 引擎此前**没有**这个钩子，所以防御型被动（钢魂的反弹）无处可挂。
   * 同样只实现一次，两条伤害路径都调它。
   */
  _fireOnDamaged(target, attacker, amount) {
    if (!target || !attacker || !(amount > 0) || this._dmgGuard) return;
    this._dmgGuard = true;   // 反弹本身也是伤害，不加锁会无限互反
    try {
      for (const inst of target._skillInstances || []) {
        if (inst._disabled) continue;
        const def = this.skills[inst.skillId];
        if (!def || !def.onDamaged) continue;
        def.onDamaged(target.id, attacker.id, amount, {
          entityContainer: this.entities, effectRegistry: this.effects, eventBus: this.eventBus,
          attrCalc: this.attrCalc, combat: this, waveNumber: window.waveNumber || 0,
        });
      }
    } finally { this._dmgGuard = false; }
  }

  /**
   * ==================== v50：护盾吸收（唯一实现）====================
   * 这 18 行原来在 _resolveHit 与 performAttackDirect 里**逐字各写了一份**。
   * 本轮要给它加"真伤不吃护盾"这条，两份就得改两处 —— 而本仓库这个形状
   * 已经出过太多次事（改一处忘一处，症状只在其中一条路径上出现，极难查）。
   * 所以趁改动合成一份。
   *
   * @param trueDmg 真伤：完全不进护盾，直接返回原始伤害（用户 v50 定稿）。
   * @returns 穿过护盾之后**要打在生命值上**的伤害
   */
  _absorbByShields(target, damage, defStats, trueDmg) {
    if (trueDmg) return damage;
    const shieldFactor = this.attrCalc.calcShieldAbsorbFactor(defStats.armor || 0, defStats.magicResist || 0);
    const tempShield = target.tempShield || 0;
    const fixedShield = target.shieldFixedCurrent || 0;
    let remaining = damage;

    const absorbedByTemp = Math.min(remaining, tempShield * shieldFactor);
    target.tempShield = Math.max(0, tempShield - absorbedByTemp / shieldFactor);
    remaining -= absorbedByTemp;

    if (remaining > 0 && fixedShield > 0) {
      const absorbedByFixed = Math.min(remaining, fixedShield * shieldFactor);
      target.shieldFixedCurrent = Math.max(0, fixedShield - absorbedByFixed / shieldFactor);
      remaining -= absorbedByFixed;
    }
    return remaining;
  }

  /**
   * ==================== 被动触发的唯一入口：_fireOnDealtDamage ====================
   * performAttack（普通攻击）与 performAttackDirect（真伤/溅射/DOT/特殊攻击方式）
   * 两条伤害路径，"造成伤害后触发被动"这件事【只在这一个函数里实现一次】。
   * 历史上这里两条路径各写一份，先后出过至少 4 次同类 bug（远古之力/暗魂/毒魂
   * 在闪电杖上完全不生效——因为它们挂在只有 performAttack 认的 onHit 上；
   * 雷魂在闪电杖上被削弱到约 1/4——因为触发时只拿到最后一跳的伤害；炎魂在
   * 闪电杖上节奏被错误节流）。根子都是"两条路径独立实现、迟早漏改一处"，
   * 这次统一成一处，以后新增攻击方式不会再重犯。
   *
   * attackShare：这次伤害相当于【几分之几次标准攻击】。普通攻击恒为 1；
   * 特殊攻击方式（闪电杖每跳 0.25 等）按自己的节奏传分数；一次伤害不会
   * 代表超过一次攻击，调用方保证 attackShare ≤ 1（本函数会夹到这个范围内）。
   *
   * 每个技能/被动通过 def.procMode 声明自己怎么应对分数攻击（不声明 = 'always'）：
   *   'always'    —— 每次伤害都触发，用【这一下】自己的数值直接算。
   *                   适合"跟手"型效果（炎魂的溅射）：分数攻击各自独立结算，
   *                   累计起来自然等于一次完整攻击的量，天然正确、不用特殊处理。
   *   'perAttack' —— 攒够 attackShare 总和 = 1（相当于一次完整攻击）才触发一次，
   *                   且传给它的伤害基数是【这期间累计的总和】，不是某一跳的零头。
   *                   适合"有冷却 / 会叠层 / 一次性判定"型效果
   *                   （雷魂、潮魂、暗魂、毒魂、远古之力、穿透型的升温）：
   *                   频率上"当成攻速为 1 的武器"，数值上"按累计的一整次攻击算"。
   *
   * 累加状态记在【技能实例】自己身上（inst._procCredit 等），不记在攻击者身上：
   * 一座塔同时装着好几个 procMode='perAttack' 的被动时各自独立计数、互不干扰；
   * 换武器/换被动实例也不会背上别的技能攒了一半的信用。
   */
  _fireOnDealtDamage(attacker, target, attackShare, damageCtx, noProc = false) {
    if (!attacker || !target || noProc || this._procGuard) return;
    const share = Math.max(0, Math.min(1, attackShare)); // 单次调用按"不超过一次完整攻击"设计，见函数头注释
    this._procGuard = true;
    try {
      for (const inst of attacker._skillInstances || []) {
        if (inst._disabled) continue;
        const def = this.skills[inst.skillId];
        if (!def || !def.onDealtDamage) continue;
        const ctxBase = {
          entityContainer: this.entities, effectRegistry: this.effects, eventBus: this.eventBus,
          waveNumber: window.waveNumber || 0, attrCalc: this.attrCalc, combat: this,
        };
        const mode = def.procMode || 'always';
        if (mode !== 'perAttack' || share >= 1) {
          def.onDealtDamage(attacker.id, target.id, inst, { ...ctxBase, ...damageCtx, attackShare: share });
          continue;
        }
        // perAttack 且是分数攻击：攒份额，攒满 1 份再触发一次，伤害基数用累计总和
        inst._procCredit = (inst._procCredit || 0) + share;
        inst._procRawSum = (inst._procRawSum || 0) + (damageCtx.totalRaw || 0);
        inst._procFinalSum = (inst._procFinalSum || 0) + (damageCtx.finalDamage || 0);
        if (inst._procCredit >= 1) {
          inst._procCredit -= 1;
          const accCtx = {
            ...ctxBase, ...damageCtx,
            totalRaw: inst._procRawSum, finalDamage: inst._procFinalSum, attackShare: 1,
          };
          inst._procRawSum = 0; inst._procFinalSum = 0;
          def.onDealtDamage(attacker.id, target.id, inst, accCtx);
        }
      }
    } finally { this._procGuard = false; }
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
    // v51：'adaptive' 解析——这条路径的调用方（技能/DOT/溅射）比普攻路径更可能显式传
    // 'adaptive' 字面量（普攻路径在 performAttack 里已经在开火时解析过了）。
    if (attackType === 'adaptive') attackType = this.attrCalc.resolveAttackType(atkStats) || 'physical';

    // ==================== v45：攻击特效的"每跳修正" ====================
    // 用户定稿："由于闪电杖是固定每秒四次伤害，所以遇到攻击特效时应该每次伤害造成的
    // 攻击特效应该进行修正，每次 ×0.25。"
    //
    // 闪电杖的伤害不走 performAttack（那条路才带攻击特效），而是每秒 4 次直接调这里。
    // 于是它有两个方向相反的问题：
    //   ① 攻击特效的【数值部分】（onHitDamage / onHitPercentDamage）**一次都没生效过** ——
    //      这条路径压根不读那两项属性；
    //   ② 攻击特效的【被动部分】（onDealtDamage）却**每秒触发 4 次**，
    //      是 1.0 攻速单位的 4 倍（叠层类被动因此快 4 倍、自损类被动因此痛 4 倍）。
    // attackShare 只负责标记"这次伤害算几分之几次标准攻击"，用于下面
    // _fireOnDealtDamage 的节奏判定；攻击特效的数值部分是【另一件事】，
    // 由 options.applyOnHitBonus 单独开关——两者以前共用 onHitScale 一个开关，
    // 正是"改一个动两个、谁都说不清对方会不会被连带影响"的设计缺陷，这次分开。
    //
    // 默认不叠攻击特效数值：其余调用方（溅射、DOT、龙魂、环境伤害）行为逐位不变——
    // 它们本来就不该带攻击特效，溅射带的话等于一次攻击结算两遍。
    const attackShare = Math.max(0, options.attackShare ?? 1);
    let damage = baseDamage;
    if (options.applyOnHitBonus && attacker) {
      const flat = atkStats.onHitDamage || 0;
      const pct = (atkStats.onHitPercentDamage || 0) / 100 * (target.currentHP || 0);
      damage += (flat + pct) * attackShare;
    }
    const dmgAmp = atkStats.damageAmpPct || 0;
    damage *= (1 + dmgAmp / 100);

    // ==================== v51：技能增幅（自动生效）====================
    // 用户："技能增幅就是自动的。" 默认套用；`options.basicAttack` 是仅有的例外开关——
    // 只给引擎自己"这其实是普攻，只是技术上必须走这条路径"的那两三处用
    // （穿透型升温之外，闪电杖每跳伤害、攻城疲惫回收都属于这类），技能作者不需要
    // 知道这个字段的存在。真实伤害同样吃这一层——与伤害增幅（damageAmpPct）同口径。
    if (!options.basicAttack) {
      const skillAmp = atkStats.skillAmpPct || 0;
      if (skillAmp) damage *= (1 + skillAmp / 100);
    }

    // ==================== v51：技能暴击 ====================
    // 用户："拥有状态【技能暴击】的单位技能可以暴击，但暴击伤害降低，只适用于伤害性技能。"
    // "伤害性技能"＝这一次调用本身就是在造成伤害（走的正是这个函数），所以判据只需要
    // "不是普攻"（同一个 options.basicAttack）+ "持有【技能暴击】状态"，不需要额外的
    // "这个技能算不算伤害性"标记——凡是调了 performAttackDirect 就已经是在造成伤害了。
    if (!options.basicAttack && attacker && this.effects.isSkillCrit(attacker.id)) {
      if (Math.random() * 100 < (atkStats.critChance || 0)) {
        damage *= (CONFIG.tuning?.crit?.skillCritDamagePct ?? 150) / 100;
      }
    }
    // ==================== v43 巨龙宿怨：增伤那一半 ====================
    // 拆开放置是有讲究的（见 _dragonGrudge 的注释）：
    //   · **增伤**（龙打向某阵营）是**攻击方**属性，与 damageAmpPct 同类 →
    //     放在这里，真实伤害也吃得到；
    //   · **减伤**（龙受到某阵营的伤害）是**防御方**属性，与 damageReduction 同类 →
    //     放在下面的减免块里，真实伤害照本项目既有口径**绕过**它。
    // 第一版我把两半都塞进减免块，结果龙的增伤对真伤完全不生效 —— 方向错了。
    const grudgeAmp = this._dragonGrudge(attacker, target);
    if (!grudgeAmp.protective && grudgeAmp.k !== 1) damage *= grudgeAmp.k;
    damage *= this._dragonVsMinionBonus(attacker, target);

    // 若目标当前持有护盾，额外造成一定比例伤害（如闪电杖破盾+7%）
    const shieldBeforeHit = (target.tempShield || 0) + (target.shieldFixedCurrent || 0);
    if (options.bonusVsShieldPct && shieldBeforeHit > 0) {
      damage *= (1 + options.bonusVsShieldPct / 100);
    }

    // 真实伤害：无视双抗/减伤/格挡，**也不被护盾吸收**
    //（v50 用户定稿："跳过护盾以及所有防御手段直接对生命值造成伤害"）。
    // 护盾那一段由 _absorbByShields 按 trueDmg 直接放行。
    const trueDmg = isTrueDamage(attackType);
    if (trueDmg) {
      // damage 保持不变（已含伤害增幅/破盾加成），直接打生命值
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
    let remainingDamage = this._absorbByShields(target, damage, defStats, trueDmg);

    const finalDamage = Math.min(remainingDamage, target.currentHP);
    target.currentHP -= finalDamage;
    if (damage > 0) target.lastDamageTime = window.gameTime || 0;
    // 伤害转化（v33 Q10）：防御向，两条伤害路径（performAttack/Direct）行为一致
    this._applyDamageConversion(target, defStats, finalDamage);
    // v51：吸血——这条路径此前完全没有（生命偷取只接在 _resolveHit 上），现在补齐，
    // 与主命中路径共用同一份 applyVamp。基数用 damage（护盾吸收前的已结算伤害）而不是
    // finalDamage（HP 实扣量），与 _resolveHit 原有的口径一致——护盾扛住了这一下，
    // 攻击方依然按"打出去多少"回血，这是改动前就有的行为，不是这次新定的。
    // options.vampGroup 由调用点标记（溅射/连锁）。
    applyVamp(this, attacker, damage, attackType, vampEfficiency(options));
    // 记录巨龙的伤害来源塔
    if (target.type === 'dragon' && finalDamage > 0 && attacker) {
      if (attacker.type === 'tower') (target._damagers = target._damagers || new Set()).add(attacker.id);
      // v43：最后一击归属（见 _resolveHit 里那条同样的注释）
      recordLastHit(target, attacker);
    }
    // 使闪电杖、腐蚀型等通过 performAttackDirect 造成的伤害也能触发被动——
    // 具体节奏/累加逻辑统一在 _fireOnDealtDamage 里实现，两条伤害路径共用一份。
    this._fireOnDealtDamage(attacker, target, attackShare,
      { totalRaw: baseDamage, finalDamage, attackType }, options._noProc);
    if (!options._noProc) this._fireOnDamaged(target, attacker, finalDamage);

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
