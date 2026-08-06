// sim_v40.mjs —— v40 验收：
// ① 三路出兵点分离（且在枢纽塔身后，红蓝对称）
// ② 攻城车全部机制由【攻城武器被动】驱动（拆掉被动即退化）+ 攻城模式状态
// ③ 攻城车数值调整：AD60 / 对建筑 +270% / 射程 +20%
// ④ 超级兵射程修复（体型大导致够不着）
// ⑤ 渲染：攻城车不再是 ❓；结构保护盾牌不透明
// ⑥ 编辑器：模板编辑器 + 添加单位 都有攻城车
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG, MINION_SIZES, MELEE_RANGE_THRESHOLD } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');
const fs = await import('fs');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;
attr.setWeatherSystem?.(null);
const DT = 1 / 30;

function mkUnit(ents, type, faction, x, y, skills = []) {
  const t = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...t },
    currentHP: t.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: skills.map(k => ({ id: ++window._uid, skillId: k, state: {} })),
    _mapFaction: faction, faction, _laneId: 'mid', _laneDirection: 'forward' };
  ents.add(e);
  return e;
}

// ==================== ① 出兵点分离 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  for (const mid of ['summoners_rift_v1', 'howling_abyss_v1']) {
    const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap(mid);
    const lws = new LaneWaveSystem(ents, bus, ms);
    const map = MAPS[mid];
    for (const f of ['blue', 'red']) {
      const c = f === 'blue' ? { x: 0, y: map.world.h } : { x: map.world.w, y: 0 };
      const hqR = Math.min(...map.buildings.filter(b => b.faction === f && b.tier === 'hq_tower')
        .map(b => Math.hypot(b.pos.x - c.x, b.pos.y - c.y)));
      const pts = map.lanes.map(l => {
        const p = lws._laneSpawnPoint(l, f === 'blue' ? 'forward' : 'reverse');
        return { id: l.id, p, r: Math.hypot(p.x - c.x, p.y - c.y) };
      });
      T(`${mid}/${f} 出兵点都在枢纽塔身后（径向 < ${hqR.toFixed(0)}）`, pts.every(q => q.r < hqR));
      T(`${mid}/${f} 出兵点都可行走`, pts.every(q => ms.isWalkable(q.p.x, q.p.y)));
      if (pts.length > 1) {
        let minGap = Infinity;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
          minGap = Math.min(minGap, Math.hypot(pts[i].p.x - pts[j].p.x, pts[i].p.y - pts[j].p.y));
        T(`${mid}/${f} 三路出兵点互相分开（最小间距 ${minGap.toFixed(0)}px > 50）`, minGap > 50);
      }
    }
  }
  // 红蓝对称：同名路的径向应一致
  const map = MAPS.summoners_rift_v1;
  const ms = new MapSystem(ents, bus); ms.setCreateBuildingFn(() => null); ms.loadMap('summoners_rift_v1');
  const lws = new LaneWaveSystem(ents, bus, ms);
  const rOf = (laneId, f) => {
    const c = f === 'blue' ? { x: 0, y: map.world.h } : { x: map.world.w, y: 0 };
    const p = lws._laneSpawnPoint(map.lanes.find(l => l.id === laneId), f === 'blue' ? 'forward' : 'reverse');
    return Math.hypot(p.x - c.x, p.y - c.y);
  };
  T('红蓝对称（同名路径向一致）',
    map.lanes.every(l => Math.abs(rOf(l.id, 'blue') - rOf(l.id, 'red')) < 1));
  // 实际出兵：同一波三路的落点不再重合
  const spawnPts = [];
  lws.setCreateMinion((type, x, y, f, laneId) => { spawnPts.push({ laneId, f, x, y }); return mkUnit(ents, type, f, x, y); });
  for (let t = 0; t < 40; t += DT) lws.update(DT);
  const blueFirst = {};
  for (const s of spawnPts.filter(s => s.f === 'blue')) if (!blueFirst[s.laneId]) blueFirst[s.laneId] = s;
  const ids = Object.keys(blueFirst);
  let ok = ids.length >= 3;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const A = blueFirst[ids[i]], B = blueFirst[ids[j]];
    if (Math.hypot(A.x - B.x, A.y - B.y) < 50) ok = false;
  }
  T('实际出兵：三路首兵落点互不重合（>50px）', ok);
}

// ==================== ② 攻城车机制全部由被动驱动 ====================
{
  const def = SkillLibrary.passive_siege_weapon;
  T('攻城武器被动存在且持有全部数值',
    !!def && def.TOWER_DAMAGE_MULT === 3.7 && def.TOWER_ATKSPD_MULT === 0.5
    && def.SELF_DAMAGE_PCT === 0.20 && def.VS_MINION_MULT === 0.67 && def.MELEE_BONUS_MULT === 2.0);
  T('被动图标 🛠️', def.icon === '🛠️');

  // v43 P1-4：小兵工厂已搬到 src/core/factories.js，读组合根两份
  const mainSrc = ['../src/main.js','../src/core/factories.js']
    .map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  T('main.js 已把被动装配给攻城车（此前遗漏 → 技能栏空白）',
    /'ram':\s*\['passive_siege_weapon'\]/.test(mainSrc));

  const csSrc = fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url), 'utf8');
  T('伤害规则以被动为闸门（不再按 type==="ram" 硬编码）',
    csSrc.includes('getSiegeWeaponDef') && !csSrc.includes("const isRam = (e)"));
  const lmsSrc = fs.readFileSync(new URL('../src/systems/LaneMovementSystem.js', import.meta.url), 'utf8');
  // v43 Q2：攻城的锁定/攻速/自损从 LaneMovementSystem 搬进 CombatSystem，两条攻击路径共用。
  // 这条断言原来钉的是"这些常量出现在 LaneMovementSystem 里"，那等于把
  // **实现位置**写死进了测试；而这次的 bug 恰恰是"实现只在其中一条路径上"。
  // 所以改成钉两件事：① 规则只有一份（只在 CombatSystem 里读那三个常量）；
  // ② 两条路径都调那一份。
  T('攻城规则只有一份（只在 CombatSystem 里读常量，LaneMovementSystem 不再自己抄）',
    csSrc.includes('TOWER_ATKSPD_MULT') && csSrc.includes('SELF_DAMAGE_PCT')
    && !lmsSrc.includes('TOWER_ATKSPD_MULT') && !lmsSrc.includes('SELF_DAMAGE_PCT'));
  T('两条攻击路径都调同一份（对战 = LaneMovementSystem，沙盒 = CombatSystem 小兵循环）',
    lmsSrc.includes('this.combat.siegeAcquire(') && lmsSrc.includes('this.combat.finishAttack(')
    && csSrc.includes('this.siegeAcquire(minion, nearestTower)')
    && csSrc.includes('this.finishAttack(minion, nearestTower'));
  T('闸门仍然是被动（拆掉被动即退化为普通车）',
    /siegeAcquire\(attacker, target\) \{\s*if \(!getSiegeWeaponDef/.test(csSrc)
    && /finishAttack\(attacker, target, finalAS\) \{\s*const def = getSiegeWeaponDef/.test(csSrc));

  // 攻城模式状态：锁定建筑时出现，解除时消失
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const ram = mkUnit(ents, 'ram', 'blue', 0, 0, ['passive_siege_weapon']);
  const ctx = { entityContainer: ents, effectRegistry: fx, attrCalc: attr, eventBus: bus };
  const inst = ram._skillInstances[0];
  def.onFrame(ram.id, DT, inst, ctx);
  T('未锁定时无攻城模式状态', !fx.getEffectByName(ram.id, '攻城模式'));
  const tw = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 100, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 4000, shieldFixedCurrent: 0, tempShield: 0,
    lastDamageTime: -Infinity, _skillInstances: [], _mapFaction: 'red', _mapTier: 'outer', faction: 'red' };
  ents.add(tw);
  ram._ramLockId = tw.id;
  def.onFrame(ram.id, DT, inst, ctx);
  const mode = fx.getEffectByName(ram.id, '攻城模式');
  T('锁定建筑 → 状态栏出现【攻城模式】', !!mode && mode.blueprint.description.includes('攻速-50%'));
  tw.alive = false;
  def.onFrame(ram.id, DT, inst, ctx);
  T('目标摧毁 → 攻城模式消失', !fx.getEffectByName(ram.id, '攻城模式'));

  // 拆掉被动 → 状态与锁定一并清除
  ram._ramLockId = tw.id; tw.alive = true;
  def.onFrame(ram.id, DT, inst, ctx);
  def.onUnequip(ram.id, inst, ctx);
  T('拆掉被动 → 锁定与攻城模式一并清除（退化为普通车）',
    !ram._ramLockId && !fx.getEffectByName(ram.id, '攻城模式'));
}

// ==================== ③ 数值调整 ====================
{
  const ram = CONFIG.templates.ram;
  T('AD 60（远高于炮兵 17.5）', ram.attackDamage === 60 && ram.attackDamage > CONFIG.templates.siege.attackDamage);
  T('射程 312（260 +20%，仍远超塔的 180）', ram.attackRange === 312 && ram.attackRange > CONFIG.templates.tower.attackRange);
  const perHit = 60 * 3.7 * (100 / 140);
  T(`打外塔单发 ≈ ${perHit.toFixed(0)}，五发自毁前共 ${(perHit * 5).toFixed(0)}（外塔 4000 的 ${(perHit * 5 / 40).toFixed(0)}%）`,
    Math.abs(perHit - 158.6) < 1);
}

// ==================== ④ 超级兵射程修复 ====================
{
  const sup = CONFIG.templates.super;
  const rSum = MINION_SIZES.super + MINION_SIZES.melee;
  T(`超级兵射程 ${sup.attackRange} > 体型和 ${rSum}（此前 20 < ${rSum} → 判定上永远够不着）`, sup.attackRange > rSum);
  T('超级兵仍算近战单位（≤ 阈值 60，攻城车克制关系不变）', sup.attackRange <= MELEE_RANGE_THRESHOLD);

  // 行为：超级兵能真正打到贴身的敌人
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const mapSys = new MapSystem(ents, bus); mapSys.setCreateBuildingFn(() => null); mapSys.loadMap('summoners_rift_v1');
  const lms = new LaneMovementSystem(ents, fx, attr, combat, mapSys);
  const lane = mapSys.getLane('mid');
  let si = 0, sl = 0;
  for (let i = 0; i < lane.waypoints.length - 1; i++) {
    const P = lane.waypoints[i], Q = lane.waypoints[i + 1];
    const l = Math.hypot(Q.x - P.x, Q.y - P.y);
    if (l > sl) { sl = l; si = i; }
  }
  const P = lane.waypoints[si], Q = lane.waypoints[si + 1];
  const M = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  const foe = mkUnit(ents, 'melee', 'red', M.x, M.y);
  foe.baseStats.moveSpeed = 0; foe.baseStats.maxHP = 1e9; foe.currentHP = 1e9;
  const sup2 = mkUnit(ents, 'super', 'blue', M.x - 60, M.y);
  sup2.baseStats.maxHP = 1e9; sup2.currentHP = 1e9;
  const hp0 = foe.currentHP;
  for (let t = 0; t < 6; t += DT) { window.gameTime += DT; attr.tick(); ents.rebuildGridIfNeeded?.(attr._frame); lms.update(DT); }
  T(`超级兵能打到贴身敌人（造成 ${Math.round(hp0 - foe.currentHP)} 伤害 > 0）`, foe.currentHP < hp0);
}

// ==================== ⑤ 渲染 ====================
{
  // v2.5D 第3步：MINION_STYLE 与 _minionSprite 抽到了 SpriteFactory.js（Billboard 复用同一套绘制）。
  // 断言意图不变（攻城车有样式条目 + 独立形状分支），改为在"渲染源码 = 两文件之和"里找。
  // v43 P0-①：CanvasRenderer.js 已删（零引用的旧 2D 渲染器）。
  // 攻城车的样式与形状分支本来就在 SpriteFactory 里，断言意图不变，只是不再拼那个死文件。
  const src = fs.readFileSync(new URL('../src/presentation/SpriteFactory.js', import.meta.url), 'utf8');
  T('攻城车有渲染样式（不再 fallback 到 ❓）', /ram:\s*\{ color: '#7f8c8d', icon: '🛠️'/.test(src));
  T('攻城车有独立形状分支（横向长方形）', src.includes("case 'ram':"));
  // 盾牌只钉**活的**渲染路径（UnitLayer）：旧断言还拼着 CanvasRenderer 里那半，
  // 而那个渲染器从 2.5D 迁移完成起就没人调了 —— 钉死代码的行为等于什么都没钉。
  const ulSrc = fs.readFileSync(new URL('../src/presentation/UnitLayer.js', import.meta.url), 'utf8');
  T('结构保护盾牌显式锁定不透明实色（修"透明"问题）',
    /fillStyle = '#ffffff'/.test(ulSrc) && /depthTest: false, depthWrite: false/.test(ulSrc));
  // v43 Q4：红线样式收敛到 CONFIG.ui.aimLine，塔与攻城车共用同一份（用户要求两者一致）。
  // 原断言钉的是攻城车那条独有的 rgba(255,60,60,0.55)——那正是"两处各写各的"的痕迹，
  // 现在改为钉"两处都从 aimLine 取值"。
  // 红线画在 EffectsLayer（活的渲染路径），不在 SpriteFactory 里 —— 分开读。
  const fxSrc = fs.readFileSync(new URL('../src/presentation/EffectsLayer.js', import.meta.url), 'utf8');
  T('攻城模式攻击指示红线（与塔同款）',
    fxSrc.includes('m._ramLockId') && fxSrc.includes('CONFIG.ui.aimLine')
    && !fxSrc.includes('rgba(255,60,60,0.55)'));
}

// ==================== ⑥ 编辑器 ====================
{
  // v43 P1-4：编辑器已拆成 src/ui/editor/* 七块，断言要读整片 ——
  // 只读 AttributeEditor.js 会让否定断言因为「搬到隔壁文件」而假通过。
  const ae = [process.cwd() + '/src/ui/AttributeEditor.js',
    ...fs.readdirSync(process.cwd() + '/src/ui/editor').sort()
      .filter(f => f.endsWith('.js')).map(f => process.cwd() + '/src/ui/editor/' + f)]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
  T('模板编辑器有攻城车', ae.includes("ram: '攻城车'"));
  const ua = fs.readFileSync(new URL('../src/ui/UnitAddDialog.js', import.meta.url), 'utf8');
  T('添加单位对话框有攻城车', /ram:\s*\{ label: '攻城车'/.test(ua));
}

console.log(`v40验收: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
