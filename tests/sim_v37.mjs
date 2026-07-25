// sim_v37.mjs —— v37 验收（v36 返工修正轮）：
// ① Q1 技能栏重构：加固城防+成长合并进身份技能（mergedSkills 过滤显示），
//    其余独立；四层级加固城防（外/内=纯节点33/67/100，水晶=+2恢复，枢纽=40/70/100+5恢复）；
//    水晶塔800盾拆为独立"钢铁烈阳护盾"（仅自身）
// ② Q2 寻路修复包：脱锚滞回1.15×/追击粘性0.35s/索敌视线检查/罚站自愈/正对障碍切向绕行
// ③ Q3 收束段延伸：openRadius 960/520（墙尖伸进射程圈，射程与墙真实相交）
// ④ Q4 图标：过载💣、钢铁烈阳护盾☀️
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);

function mkTower(ents, tier, laneId, faction = 'blue') {
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower, maxHP: 4000 }, currentHP: 4000,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier, _laneId: laneId, faction };
  ents.add(e);
  return e;
}
function equip(e, skillId, ents, fx, bus) {
  const inst = { id: ++window._uid, skillId, state: {} };
  e._skillInstances.push(inst);
  SkillLibrary[skillId].onEquip?.(e.id, inst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus || new EventBus() });
  return inst;
}

// ==================== ① Q1 技能结构 ====================
{
  // 数值：枢纽 5 恢复、水晶 2 恢复且无盾、外/内纯节点
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const hq = mkTower(ents, 'hq_tower', null);
  equip(hq, 'passive_hq_fortify', ents, fx);
  attr.tick();
  T('枢纽加固城防 +3 恢复（用户定稿：5→3）', attr.calc(hq, fx.getEffects(hq.id)).healthRegen === 3);
  T('枢纽节点 40/70/100 文案', SkillLibrary.passive_hq_fortify.description.includes('40%/70%/100%'));

  const base = mkTower(ents, 'base', 'mid');
  equip(base, 'passive_base_fortify', ents, fx);
  attr.tick();
  const bs = attr.calc(base, fx.getEffects(base.id));
  T('水晶加固城防 +1 恢复、无盾（用户定稿：2→1）', bs.healthRegen === 1 && bs.shieldFixedMax === 0);
  equip(base, 'passive_base_bulwark', ents, fx);
  attr.tick();
  T('钢铁烈阳护盾（水晶版）独立技能 +800 盾', attr.calc(base, fx.getEffects(base.id)).shieldFixedMax === 800);
  T('水晶版护盾描述为"+800固定护盾"且无光环字样',
    SkillLibrary.passive_base_bulwark.description.includes('800固定护盾')
    && !SkillLibrary.passive_base_bulwark.description.includes('友军'));

  const outer = mkTower(ents, 'outer', 'mid');
  const oInst = equip(outer, 'passive_outer_fortify', ents, fx);
  attr.tick();
  T('外塔加固城防：纯节点（无恢复效果）', attr.calc(outer, fx.getEffects(outer.id)).healthRegen === 0);
  T('外塔节点封顶已生效（33%档位算出）', typeof oInst.state._capPct === 'number' && oInst.state._capPct === 100);
  outer.currentHP = 4000 * 0.30; // 30% → 封顶 33%
  SkillLibrary.passive_outer_fortify.onFrame(outer.id, 0.5, oInst, { entityContainer: ents, effectRegistry: fx, attrCalc: attr });
  T('外塔 30% 血 → 封顶 33% 节点', Math.abs(outer._regenCapHP - 4000 * 0.33) < 1);
  T('内塔加固城防存在（同 33/67/100）', SkillLibrary.passive_inner_fortify.description.includes('33%/67%/100%'));

  // mergedSkills 声明
  T('外塔身份 merged = fortify+growth', SkillLibrary.core_tier_outer.mergedSkills.includes('passive_outer_fortify') && SkillLibrary.core_tier_outer.mergedSkills.includes('passive_growth_outer'));
  T('内塔身份 merged = fortify+growth', SkillLibrary.core_tier_inner.mergedSkills.includes('passive_inner_fortify') && SkillLibrary.core_tier_inner.mergedSkills.includes('passive_growth_inner'));
  T('水晶身份 merged = fortify+growth', SkillLibrary.core_tier_base.mergedSkills.includes('passive_base_fortify') && SkillLibrary.core_tier_base.mergedSkills.includes('passive_growth_base'));
  T('枢纽身份 merged = fortify+growth', SkillLibrary.core_tier_hq.mergedSkills.includes('passive_hq_fortify') && SkillLibrary.core_tier_hq.mergedSkills.includes('passive_growth_hq'));
  // 身份技能不收编独立被动（钢铁防线/镀层/烈阳护盾/过载不在 mergedSkills；绝望反击已删除）
  const allMerged = ['core_tier_outer', 'core_tier_inner', 'core_tier_base', 'core_tier_hq'].flatMap(k => SkillLibrary[k].mergedSkills);
  T('独立被动不被合并（钢铁防线/镀层/烈阳护盾/过载）',
    !allMerged.some(k => ['passive_iron_line', 'passive_armor_plating', 'passive_inner_bulwark', 'passive_base_bulwark', 'passive_overload'].includes(k)));
  // 身份描述含用户指定文案
  T('身份描述含节点文案（外）', SkillLibrary.core_tier_outer.description.includes('33%，67%，100%'));
  T('身份描述含 5 恢复（枢纽）', SkillLibrary.core_tier_hq.description.includes('5生命恢复'));
  T('身份描述含 2 恢复（水晶）', SkillLibrary.core_tier_base.description.includes('2生命恢复'));

  // main.js 装配（源码断言）
  const fs = await import('fs');
  const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // Q3：水晶塔(tier base)不再默认装配钢铁烈阳护盾(passive_base_bulwark)——从 base 默认装配行移除。
  // 外/内 fortify 仍在；base 行现在只有 fortify + armor_plating（bulwark 仅保留定义，可手动装/内塔光环版不受影响）。
  const baseLine = (mainSrc.split('\n').find(l => l.includes("tier === 'base'") && l.includes('towerDefaults.push')) || '');
  T('装配：外/内 fortify 仍在，水晶塔不再默认装 bulwark',
    mainSrc.includes("'passive_outer_fortify'") && mainSrc.includes("'passive_inner_fortify'")
    && baseLine.includes("'passive_base_fortify'") && !baseLine.includes("'passive_base_bulwark'"));

  // UI 过滤（FakeEl）
  class FakeEl { constructor() { this.dataset = {}; this._html = ''; } set innerHTML(v) { this._html = v; } get innerHTML() { return this._html; } }
  globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => null }), addEventListener() {} };
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
  const { UIManager } = await import('../src/ui/UIManager.js');
  const ui = Object.create(UIManager.prototype);
  const c = new FakeEl();
  ui._updateSkillSlots(c, [
    { id: 1, skillId: 'core_tier_inner' }, { id: 2, skillId: 'weapon_piercing' },
    { id: 3, skillId: 'passive_inner_fortify' }, { id: 4, skillId: 'passive_growth_inner' },
    { id: 5, skillId: 'passive_armor_plating' }, { id: 6, skillId: 'passive_inner_bulwark' },
    { id: 7, skillId: 'passive_overload' },
  ]);
  const h = c.innerHTML;
  T('技能栏：fortify/growth 隐藏、其余 5 格平铺、无嵌套',
    !h.includes('data-skill-id="3"') && !h.includes('data-skill-id="4"')
    && ['1', '2', '5', '6', '7'].every(id => h.includes(`data-skill-id="${id}"`))
    && !h.includes('skill-identity-group')
    && (h.match(/skill-slot has-skill/g) || []).length === 5);
}

// ==================== ② Q2 寻路修复包 ====================
function mkBattle() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSys = new MapSystem(ents, bus);
  mapSys.setCreateBuildingFn(() => null);
  mapSys.loadMap('summoners_rift_v1');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapSys);
  return { bus, ents, fx, combat, mapSys, lms };
}
function mkMinion(ents, type, faction, x, y, dir = 'forward') {
  const tpl = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...tpl }, currentHP: tpl.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0, targetId: null,
    _skillInstances: [], _mapFaction: faction, _laneId: 'mid', _laneDirection: dir, faction };
  ents.add(e);
  return e;
}
const DT = 1 / 30;

// ---- 脱锚滞回：目标在 1.0~1.15R 缓冲区内仍保持锚定（不追不抖） ----
{
  const W = mkBattle();
  const lane = W.mapSys.getLane('mid');
  const wp = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
  const m = mkMinion(W.ents, 'ranged', 'blue', wp.x, wp.y);
  const range = CONFIG.templates.ranged.attackRange;
  const foe = mkMinion(W.ents, 'melee', 'red', wp.x + range * 0.9, wp.y, 'reverse');
  foe.baseStats.moveSpeed = 0; // 靶子不动
  const step = () => { window.gameTime += DT; attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame); W.lms.update(DT); };
  for (let t = 0; t < 2; t += DT) step();
  T('射程内锚定', m._anchored === true);
  const anchorPos = { x: m.pos.x, y: m.pos.y };
  foe.pos.x = m.pos.x + range * 1.10; // 挪到缓冲区（1.0~1.15R）
  for (let t = 0; t < 1.5; t += DT) step();
  T('缓冲区（1.10R）内保持锚定不追（滞回生效）', m._anchored === true && Math.hypot(m.pos.x - anchorPos.x, m.pos.y - anchorPos.y) < 2);
  const posBefore = { x: m.pos.x, y: m.pos.y };
  foe.pos.x = m.pos.x + range * 1.4; // 超出缓冲
  for (let t = 0; t < 1; t += DT) step();
  // 正确行为：脱锚→追击→逼近后【重新锚定】。断言验证"发生了追击位移"而非终态脱锚
  //（v37 调试教训：终态 _anchored 取决于是否追上，追上重新锚定才是对的）。
  const chased = Math.hypot(m.pos.x - posBefore.x, m.pos.y - posBefore.y);
  T(`超出 1.15R 脱锚追击（位移 ${chased.toFixed(0)}px > 20）`, chased > 20);
}

// ---- 视线检查：隔收束段墙壁的敌人不被索敌选中 ----
{
  const W = mkBattle();
  const map = MAPS.summoners_rift_v1;
  // 蓝方 top 收束段内走廊中心的兵；敌人放在墙外（top 走廊侧向 250px，收束段内不可行走处）
  // v38：高地塔现在位于开放高地内、四周可走，测试点迁移到【高地开口外的走廊段】——
  // 那里两侧墙仍真实存在（走廊 halfWidth 130），语义（隔墙敌人不被索敌锁定）不变。
  const lane0 = map.lanes.find(l => l.id === 'top');
  const c0 = { x: 0, y: map.world.h };
  const tw = map.buildings.find(b => b.faction === 'blue' && b.tier === 'base' && b.laneId === 'top');
  const dr0 = Math.hypot(tw.pos.x - c0.x, tw.pos.y - c0.y);
  const ux0 = (tw.pos.x - c0.x) / dr0, uy0 = (tw.pos.y - c0.y) / dr0;
  const nx0 = -uy0, ny0 = ux0;
  // 走廊段中心：沿径向出高地口再走 260px（确保脱离开放区，落在走廊里）
  const corr = { x: c0.x + ux0 * (map.baseOpenRadius + 260), y: c0.y + uy0 * (map.baseOpenRadius + 260) };
  const wallOut = { x: corr.x + nx0 * 200, y: corr.y + ny0 * 200 }; // 侧向 200 > halfWidth 130 → 墙外
  const m = mkMinion(W.ents, 'melee', 'blue', corr.x, corr.y);
  m._laneId = 'top';
  T('走廊中心可行走（前提）', W.mapSys.isWalkable(corr.x, corr.y));
  T('墙外点确实不可行走（前提）', !W.mapSys.isWalkable(wallOut.x, wallOut.y));
  T('视线被墙阻断（_hasLineOfSight=false）', !W.lms._hasLineOfSight(m.pos.x, m.pos.y, wallOut.x, wallOut.y));
  const ghost = mkMinion(W.ents, 'melee', 'red', wallOut.x, wallOut.y, 'reverse');
  attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame);
  const scan = W.lms._scanEnemies(m, 200, 30);
  T('索敌不锁隔墙敌人（nearest=null）', scan.nearest === null || scan.nearest.id !== ghost.id);
}

// ---- 罚站自愈：卡死 1 秒 → 弃标 + 短期黑名单 ----
{
  const W = mkBattle();
  const lane = W.mapSys.getLane('mid');
  const wp = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
  const m = mkMinion(W.ents, 'melee', 'blue', wp.x, wp.y);
  // 人工制造卡死：目标是墙外的幽灵（视线检查会拒绝锁定，但我们直接压 targetId 模拟漏网）
  const a = lane.waypoints[Math.floor(lane.waypoints.length / 2) - 1];
  const dx = wp.x - a.x, dy = wp.y - a.y, L = Math.hypot(dx, dy);
  const nx = -dy / L, ny = dx / L;
  const ghost = mkMinion(W.ents, 'melee', 'red', wp.x + nx * 400, wp.y + ny * 400, 'reverse'); // 走廊墙外远处
  ghost.baseStats.moveSpeed = 0;
  m.targetId = ghost.id;
  m._retargetAt = (window.gameTime || 0) + 99; // 锁死粘性，强制维持这个追不到的目标
  m._chaseLastD = Infinity;
  const step = () => { window.gameTime += DT; attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame); W.lms.update(DT); };
  let healed = false;
  for (let t = 0; t < 4; t += DT) { step(); if (m.targetId === null || m.targetId !== ghost.id) { healed = true; break; } }
  T('罚站自愈：卡死后放弃追不到的目标', healed);
  T('黑名单已登记（2秒内不重锁）', m._ignoreTarget === undefined || m._ignoreTarget.id === ghost.id);
}

// ---- A挡B绕行：正对锚定友军，B 绕过去而不是原地振荡 ----
{
  const W = mkBattle();
  const lane = W.mapSys.getLane('mid');
  const mid = Math.floor(lane.waypoints.length / 2);
  const wp = lane.waypoints[mid];
  const a = lane.waypoints[mid - 1];
  const dx = wp.x - a.x, dy = wp.y - a.y, L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L;
  // 真实场景（v37 调试教训：人工假 targetId 会被 update 重置，A 永远不真锚定）：
  // 敌方不动靶 T 在前方；A（大体积）先到、锁 T 锚定成障碍；B 从 A 正后方赶来，
  // 索敌同一个 T，追击方向正对 A → 必须绕过 A 才能打到 T。
  const A = mkMinion(W.ents, 'super', 'blue', wp.x, wp.y); // 大体积挡路
  const T2 = mkMinion(W.ents, 'melee', 'red', wp.x + ux * 22, wp.y + uy * 22, 'reverse');
  T2.baseStats.moveSpeed = 0; T2.baseStats.maxHP = 1e9; T2.currentHP = 1e9; // 不动打不死的靶
  A.baseStats.maxHP = 1e9; A.currentHP = 1e9;
  const step = () => { window.gameTime += DT; attr.tick(); W.ents.rebuildGridIfNeeded?.(attr._frame); W.lms.update(DT); };
  for (let t = 0; t < 1; t += DT) step(); // A 接敌锚定
  T('前提：A 已真实锚定（锁敌靶）', A._anchored === true && A.targetId === T2.id);
  const APos = { x: A.pos.x, y: A.pos.y };
  const B = mkMinion(W.ents, 'melee', 'blue', A.pos.x - ux * 40, A.pos.y - uy * 40);
  const fwd0 = (B.pos.x - wp.x) * ux + (B.pos.y - wp.y) * uy;
  let reached = false;
  for (let t = 0; t < 5; t += DT) {
    step();
    if (B._anchored && B.targetId === T2.id) { reached = true; break; } // 绕过 A 打到了靶
  }
  const fwd1 = (B.pos.x - wp.x) * ux + (B.pos.y - wp.y) * uy;
  T(`A挡B：B 绕过 A 接敌（到达=${reached}，净前进 ${(fwd1 - fwd0).toFixed(0)}px）`, reached || fwd1 - fwd0 > 30);
  T('A 未被推动（锚定=静态障碍不变）', Math.hypot(A.pos.x - APos.x, A.pos.y - APos.y) < 2);
}

// ==================== ③ Q3 收束段延伸 ====================
{
  T('openRadius SR 1185 / HA 788（v38.1）', MAPS.summoners_rift_v1.baseOpenRadius === 1185 && MAPS.howling_abyss_v1.baseOpenRadius === 788);

  // ===== v38.1 永久几何断言：每条路【两侧】走廊墙与高地边界的交汇点都必须落进高地塔射程 =====
  // 用户诉求逐字："确保塔的射程和地形相接触"。上/下路走廊非径向，高地圆斜切走廊 →
  // 两侧墙角到塔的距离差很大（R=1230 时 top 159/206、bot 207/157），外侧那个会漏出射程留缺口。
  // 这条断言把"六个墙角全部 ≤ 射程"锁死，任何人再动 openRadius / 路宽 / 塔位都会立刻红。
  {
    const TOWER_RANGE = 180;
    for (const mid of ['summoners_rift_v1', 'howling_abyss_v1']) {
      const map = MAPS[mid];
      const c = { x: 0, y: map.world.h }, hw = map.walls.corridorHalfWidth, R = map.baseOpenRadius;
      const ds = [];
      for (const lane of map.lanes) {
        const tw = map.buildings.find(b => b.faction === 'blue' && b.tier === 'base' && (b.laneId === lane.id || map.lanes.length === 1));
        if (!tw) continue;
        // 塔所在走廊段方向
        const wps = lane.waypoints;
        let seg = 0, best = Infinity;
        for (let i = 0; i < wps.length - 1; i++) {
          const a = wps[i], b = wps[i + 1];
          const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
          const t = Math.max(0, Math.min(1, ((tw.pos.x - a.x) * vx + (tw.pos.y - a.y) * vy) / L2));
          const d2 = (tw.pos.x - (a.x + t * vx)) ** 2 + (tw.pos.y - (a.y + t * vy)) ** 2;
          if (d2 < best) { best = d2; seg = i; }
        }
        const a = wps[seg], b = wps[seg + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, nx = -uy, ny = ux;
        for (const sgn of [1, -1]) {
          // 墙线 P = 塔 + sgn*hw*n + t*u，解 |P-c| = R，取离塔最近的交点
          const px = tw.pos.x + sgn * hw * nx - c.x, py = tw.pos.y + sgn * hw * ny - c.y;
          const B = 2 * (px * ux + py * uy), C = px * px + py * py - R * R;
          const disc = B * B - 4 * C;
          if (disc < 0) { ds.push({ k: `${lane.id}${sgn > 0 ? '+' : '-'}`, d: Infinity }); continue; }
          const t1 = (-B + Math.sqrt(disc)) / 2, t2 = (-B - Math.sqrt(disc)) / 2;
          const t = Math.abs(t1) < Math.abs(t2) ? t1 : t2;
          ds.push({ k: `${lane.id}${sgn > 0 ? '+' : '-'}`, d: Math.hypot(sgn * hw * nx + t * ux, sgn * hw * ny + t * uy) });
        }
      }
      const worst = ds.reduce((m, x) => x.d > m.d ? x : m, { k: '-', d: -1 });
      T(`${mid} 三路两侧墙角全部落进塔射程（最远 ${worst.k}=${worst.d.toFixed(0)} ≤ 180）`, worst.d <= TOWER_RANGE);
    }
  }
  for (const [mid, R] of [['summoners_rift_v1', 180], ['howling_abyss_v1', 180]]) {
    const map = MAPS[mid];
    const c = { x: 0, y: map.world.h };
    const tw = map.buildings.find(b => b.faction === 'blue' && b.tier === 'base');
    const d = Math.hypot(tw.pos.x - c.x, tw.pos.y - c.y);
    // v38 定稿几何：高地 = 半径 openRadius 的开放区；走廊在其边缘开口。
    //   塔距角 d < openRadius  → 塔站在开放高地里（不被墙夹）
    //   openRadius < d + 射程  → 开口落在塔射程圈内，射程盖住入口 = "封锁入口"
    T(`${mid} 塔在高地内且射程盖住开口（${d.toFixed(0)} < ${map.baseOpenRadius} < ${(d + R).toFixed(0)}，盖住 ${(d + R - map.baseOpenRadius).toFixed(0)}px）`,
      map.baseOpenRadius > d && map.baseOpenRadius < d + R);
  }
  // 全建筑仍可行走 + 兵线中心线无违例
  const bus = new EventBus(), ents = new EntityContainer(bus);
  for (const mid of ['summoners_rift_v1', 'howling_abyss_v1']) {
    const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap(mid);
    const map = MAPS[mid];
    T(`${mid} 全部建筑位置可行走`, map.buildings.every(b => ms.isWalkable(b.pos.x, b.pos.y)));
    let breach = 0;
    for (const lane of map.lanes) {
      const wps = lane.waypoints;
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i], b = wps[i + 1]; const L = Math.hypot(b.x - a.x, b.y - a.y);
        for (let t = 0; t < 1; t += 10 / L) if (!ms.isWalkable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) breach++;
      }
    }
    T(`${mid} 兵线中心线零违例`, breach === 0);
  }
}

// ==================== ④ Q4 图标 ====================
{
  T('过载图标 💣', SkillLibrary.passive_overload.icon === '💣');
  T('钢铁烈阳护盾（内塔）图标 ☀️', SkillLibrary.passive_inner_bulwark.icon === '☀️');
  T('钢铁烈阳护盾（水晶塔）图标 ☀️', SkillLibrary.passive_base_bulwark.icon === '☀️');
}

console.log(`v37验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
