import { AttributeCalculator } from '../core/AttributeCalculator.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { CONFIG, MELEE_RANGE_THRESHOLD } from '../data/Config.js';
import { canTarget, isStructureProtected } from './FactionSystem.js';

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
      // 攻击冷却按"当前实时攻速"消耗：cooldownRemain 记剩余"攻击次数份额"，
      // 每帧减去 (当前攻速 × dt)。攻速中途变化（如减攻速）立即反映到冷却推进速度。
      if (entity.attackCooldown > 0) {
        const curAS = this.attrCalc.calcAttackSpeed(
          entity.baseStats.baseAttackSpeed,
          this.attrCalc.calc(entity, this.effects.getEffects(entity.id)).bonusAttackSpeedPct || 0,
          entity.baseStats.attackSpeedRatio || 0.667
        );
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
      const stats = this.attrCalc.calc(entity, this.effects.getEffects(entity.id));
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
        const cap = Math.min(stats.maxHP || entity.currentHP, entity._regenCapHP ?? Infinity);
        if (entity.currentHP < cap) {
          entity.currentHP = Math.min(cap, entity.currentHP + regen * regenMod * dt);
        }
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

      const shieldMax = stats.shieldFixedMax || 0;
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
          const finalAS = this.attrCalc.calcAttackSpeed(
            tower.baseStats.baseAttackSpeed,
            this.attrCalc.calc(tower, this.effects.getEffects(tower.id)).bonusAttackSpeedPct || 0,
            tower.baseStats.attackSpeedRatio || 0.667
          );
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

      const range = this.attrCalc.calc(minion, this.effects.getEffects(minion.id)).attackRange || 20;
      const dist = Math.sqrt(minDist);

      if (minion.targetId !== nearestTower.id && dist <= range) {
        minion.targetId = nearestTower.id;
        minion._lockUntil = (window.gameTime || 0) + (CONFIG.tuning?.lockOnWindup ?? 0.3); // v33（Q14）：小兵同样有锁定前摇
      }
      if (dist <= range && minion.attackCooldown <= 0 && !((window.gameTime || 0) < (minion._lockUntil || 0))) {
        minion.targetId = nearestTower.id;
        this.performAttack(minion, nearestTower);
        const finalAS = this.attrCalc.calcAttackSpeed(
          minion.baseStats.baseAttackSpeed,
          this.attrCalc.calc(minion, this.effects.getEffects(minion.id)).bonusAttackSpeedPct || 0,
          minion.baseStats.attackSpeedRatio || 0.667
        );
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
        if (def && def.onFrame) {
          // v41: auto-initialize per-instance params from skill defaults
          if (!inst._params && def.defaultParams) inst._params = { ...def.defaultParams };
          if (inst._params && SkillLibrary._mapOverrides) {
            const e2 = this.entities.get(entity.id);
            if (e2) {
              const tk = e2._mapTier ? 'tower:' + e2._mapTier : e2.type;
              const ov = SkillLibrary._mapOverrides[tk]?.[inst.skillId];
              if (ov) Object.assign(inst._params, ov);
            }
          }
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
    // 水晶不主动攻击（无武器已经在上层拦截了，这里双重保险）
    if (tower._mapTier === 'nexus_lane' || tower._mapTier === 'nexus_main') return null;

    const range = this.attrCalc.calc(tower, this.effects.getEffects(tower.id)).attackRange || 250;

    // 用空间网格局部查询代替"遍历全部小兵"，把索敌从 O(塔数×小兵数) 降到 O(塔数×局部单位数)。
    // 之前直接遍历传入的全量 minions 数组，对战模式塔更多、小兵更密集时是主要性能瓶颈
    // （实测：修复 LaneMovementSystem 的同类问题后，这里变成新的最大耗时来源，单帧10ms+）。
    const nearby = this.entities.findInRadius(tower.pos.x, tower.pos.y, range, null, true);
    const inRange = [];
    for (const m of nearby) {
      if (m.id === tower.id) continue;
      if (m.type === 'tower') continue; // findInRadius 不限类型，这里排除塔本身/其他塔
      if (!m.pos) continue;
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
    // 用于狙击型（按距离调整伤害）、无弹道武器等特殊逻辑。
    let preDamageMult = 1;

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
        targetId: target.id,
        speed: atkStats.bulletSpeed || DEFAULT_BULLET_SPEED,
        color: bulletColor,
        size: attacker.type === 'tower' ? 20 : 12, // 渲染尺寸：小兵/巨龙弹丸比塔弹小一号
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
    // 防御护盾（唯一被动）：来自【防御塔和超级兵】的伤害额外降低30%（v33 新增超级兵来源）——
    // 条件减伤依赖攻击来源，stat 管线拿不到攻击者，必须在引擎结算处判断。
    if ((attacker.type === 'tower' || attacker.type === 'super') && this._hasSkill(target, 'passive_siege_shield')) {
      damage *= 0.7;
    }
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
    }
    const totalAbsorbed = damage - remainingDamage;

    // ---- 伤害转化（v33 Q10 重做：防御向） ----
    // 定义：转化的临时护盾值 = 【受击方】实际受到的伤害（仅扣血部分，护盾吸收不计）× 受击方伤害转化%。
    // 原实现挂在攻击方（打人回盾）——方向整个是反的，等于这条属性从没按设计工作过。
    this._applyDamageConversion(target, defStats, finalDamage);

    // ---- 生命偷取 ----
    const lifesteal = atkStats.lifeStealPct || 0;
    if (lifesteal > 0 && damage > 0) {
      const healPower = 1 + (atkStats.healShieldPowerPct || 0) / 100;
      const steal = damage * (lifesteal / 100) * healPower;
      const maxHP = this.attrCalc.calc(attacker, this.effects.getEffects(attacker.id)).maxHP || 1;
      attacker.currentHP = Math.min(attacker.currentHP + steal * 0.5, maxHP);
      attacker.tempShield = (attacker.tempShield || 0) + steal * 0.5;
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
    const ramSplashR = attacker.baseStats?.splashRadius || 0;
    if (atkSiege && ramSplashR > 0) {
      const base = isStructureUnit(target) ? totalRaw / atkSiege.TOWER_DAMAGE_MULT : totalRaw;
      this._applyExplosion(attacker, target, base, attackType, ramSplashR);
    }
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

  _applyExplosion(attacker, target, baseDamage, attackType, radiusOverride) {
    const radius = radiusOverride || 75;
    const centerX = target.pos.x;
    const centerY = target.pos.y;
    const targets = this.entities.findInRadius(centerX, centerY, radius, null, true);
    for (const t of targets) {
      if (t.id === target.id) continue;
      const dist = Math.hypot(t.pos.x - centerX, t.pos.y - centerY);
      if (dist > radius) continue;
      const splashFactor = 0.6 * Math.exp(-0.033 * dist);
      const splashDmg = baseDamage * splashFactor * 0.8;
      this.performAttackDirect(attacker.id, t.id, splashDmg, attackType);
    }
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
    const healPower = 1 + (defStats.healShieldPowerPct || 0) / 100;
    target.tempShield = (target.tempShield || 0) + finalDamage * Math.min(pct / 100, 1) * healPower;
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

      // 无视防御比例：这一部分伤害完全跳过双抗/伤害减免/格挡，直接命中（仍受护盾吸收）
      const ignoreRatio = Math.max(0, Math.min(1, options.ignoreDefenseRatio || 0));
      const ignoredDamage = damage * ignoreRatio;
      let mitigatedDamage = damage * (1 - ignoreRatio);

      const effectiveResist = this.attrCalc.calcEffectiveArmor(resist, penPercent, penFlat);
      const multiplier = this.attrCalc.calcDamageMultiplier(effectiveResist);
      mitigatedDamage *= multiplier;

      const dmgReduction = defStats.damageReduction || 0;
      mitigatedDamage *= (1 - dmgReduction / 100);
      // 防御护盾（唯一被动）：来自防御塔和超级兵的伤害降低30%（与 performAttack 路径一致，v33 含超级兵）
      if (attacker && (attacker.type === 'tower' || attacker.type === 'super') && this._hasSkill(target, 'passive_siege_shield')) {
        mitigatedDamage *= 0.7;
      }
      const block = defStats.damageBlock || 0;
      mitigatedDamage = Math.max(0, mitigatedDamage - block);

      damage = ignoredDamage + mitigatedDamage;
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
    if (target.type === 'dragon' && finalDamage > 0 && attacker && attacker.type === 'tower') {
      (target._damagers = target._damagers || new Set()).add(attacker.id);
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
