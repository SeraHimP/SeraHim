/**
 * sim_v46.mjs —— v45 第二批验收（朝向 / 巨龙口径 / 光照 / 天气 / 塔模型 / 分区贴图）
 *
 * 能钉行为的一律钉行为（朝向、损毁档、巨龙范围都是纯逻辑，可以真跑）。
 * 渲染那几条只能钉源码，钉的是**取值口径**而不是"某个名字存在" ——
 * 光魂那次的教训：钉定义等于没钉，代码搬个家断言照样绿。
 */
import { setupWindow, scoreboard, srcOf, srcRaw } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { CONFIG } = await import('../src/data/Config.js');
const { FacingSystem, canFire, facingExempt, facingParams, wrapPi, angleTo } =
  await import('../src/systems/FacingSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { DragonSystem } = await import('../src/systems/DragonSystem.js');

const { T, done } = scoreboard('v46验收');

const mkE = (ents, type, x, y, extra = {}) => {
  const e = { id: ++window._uid, type, alive: true, pos: { x, y },
    baseStats: { ...(CONFIG.templates[type] || CONFIG.templates.tower) }, currentHP: 1000,
    _skillInstances: [], targetId: null, ...extra };
  ents.add(e); return e;
};

// ==================== 一、朝向与转身 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const fs = new FacingSystem(ents);

  T('朝①-塔豁免（用户明说"除了塔"），其余单位都受约束',
    facingExempt({ type: 'tower' }) === true
    && ['melee', 'ranged', 'siege', 'ram', 'super', 'totem', 'warlock', 'corrupt', 'dragon']
       .every(t => facingExempt({ type: t }) === false));

  const p = facingParams();
  T('朝②-参数软编码在 CONFIG.tuning.facing（不是写死的行为）',
    typeof CONFIG.tuning.facing === 'object'
    && 'arcDeg' in CONFIG.tuning.facing && 'turnRateDeg' in CONFIG.tuning.facing
    && p.arcDeg === CONFIG.tuning.facing.arcDeg);
  T('朝③-每个模板可以单独覆写转速与扇形',
    facingParams({ baseStats: { attackArcDeg: 7, turnRateDeg: 11 } }).arcDeg === 7
    && facingParams({ baseStats: { attackArcDeg: 7, turnRateDeg: 11 } }).turnRateDeg === 11);

  // 背后的敌人：打不到 → 转到位 → 打得到
  const m = mkE(ents, 'melee', 0, 0);
  const foe = mkE(ents, 'melee', 0, -100);   // 正南（-Z 方向），单位朝 +Z
  m._facing = 0;                              // 面朝 +Z
  m.targetId = foe.id;
  T('朝④-目标在背后时开不了火', canFire(m, foe) === false);

  // 转身需要的时间 = 180° / 转速
  const need = 180 / CONFIG.tuning.facing.turnRateDeg;
  let t = 0;
  while (t < need * 1.5 && !canFire(m, foe)) { fs.update(0.02); t += 0.02; }
  T('朝⑤-转到位之后打得出去', canFire(m, foe) === true);
  T('朝⑥-转身耗时与转速对得上（不是瞬间也不是永远）',
    t > need * 0.4 && t < need * 1.4);

  // 扇形边界：刚好在 arc 内/外
  const m2 = mkE(ents, 'melee', 0, 0);
  m2._facing = 0;
  const arc = CONFIG.tuning.facing.arcDeg * Math.PI / 180;
  const inFoe = { pos: { x: Math.sin(arc * 0.9) * 100, y: Math.cos(arc * 0.9) * 100 } };
  const outFoe = { pos: { x: Math.sin(arc * 1.2) * 100, y: Math.cos(arc * 1.2) * 100 } };
  T('朝⑦-扇形内可以打、扇形外不行（判据就是 ±arcDeg）',
    canFire(m2, inFoe) === true && canFire(m2, outFoe) === false);

  // 走向即朝向：没有目标时朝移动方向转（用户确认：**不限制移动**）
  const w = mkE(ents, 'melee', 0, 0);
  fs.update(0.02);                    // 首帧记基准
  w.pos.x = 50;                       // 往 +X 走
  for (let i = 0; i < 60; i++) fs.update(0.02);
  T('朝⑧-没有目标时朝【移动方向】转（走向即朝向）',
    Math.abs(wrapPi(w._facing - Math.PI / 2)) < 0.2);

  // 有目标时朝目标，而不是朝移动方向 —— 否则"绕后"就没有意义了
  const k = mkE(ents, 'melee', 0, 0);
  const kt = mkE(ents, 'melee', -100, 0);
  k._facing = 0; k.targetId = kt.id;
  for (let i = 0; i < 80; i++) { k.pos.x += 1; fs.update(0.02); }   // 一边朝 +X 走一边打 -X 的敌人
  T('朝⑨-有目标时朝【目标】转（否则绕后毫无意义）',
    Math.abs(wrapPi(k._facing - angleTo(k.pos, kt.pos))) < 0.2);

  // 总开关
  const sav = CONFIG.tuning.facing.enabled;
  CONFIG.tuning.facing.enabled = false;
  T('朝⑩-总开关关掉后不再限制（软编码，可退回旧行为）', canFire(m2, outFoe) === true);
  CONFIG.tuning.facing.enabled = sav;

  // 两条攻击路径共用同一份实现 —— 攻城模式那次的教训
  const cs = srcOf('src/systems/CombatSystem.js');
  const lms = srcOf('src/systems/LaneMovementSystem.js');
  T('朝⑪-两条攻击路径都调 canFire（规则只有一份实现）',
    /canFire\(minion, nearestTower\)/.test(cs) && /canFire\(minion, target\)/.test(lms));
  T('朝⑫-两条路径都不自己算角差（自己算就是第二份实现）',
    !/Math\.atan2[^\n]*_facing/.test(cs) && !/Math\.atan2[^\n]*_facing/.test(lms));

  // 渲染层必须**读**模拟层的朝向，不能自己再算一份
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('朝⑬-渲染层读 e._facing，不再自己拿位置增量算朝向',
    /en\.faceT = e\._facing/.test(ul) && !/en\.faceT = Math\.atan2/.test(ul));
}

// ==================== 二、龙：模型朝向 ====================
{
  const umf = srcOf('src/presentation/UnitMeshFactory.js');
  T('龙模①-龙的几何被转正到全项目约定（正面 +Z）',
    /hit\.geo\.rotateY\(Math\.PI\)/.test(umf));
  T('龙模②-朝向白名单已删，判据与 FacingSystem 一致（除塔外全转）',
    /needsFacing\(type\) \{ return type !== 'tower'; \}/.test(umf) && !/FACING_TYPES/.test(umf));
}

// ==================== 三、巨龙规则口径 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);

  T('巨①-默认启用（用户："龙开关默认启用"）', ds.paused === false);
  T('巨②-力的范围 = 所有单位（含近战/远程），魂的范围 = 塔 + 大型小兵',
    ['melee', 'ranged'].every(t => DragonSystem.POWER_REWARD_OK({ type: t }) === true
                                && DragonSystem.SOUL_REWARD_OK({ type: t }) === false)
    && DragonSystem.POWER_REWARD_OK({ type: 'tower' }) === true);
  T('巨③-龙自己不在任何一个领受范围里（自带那份走另一条路）',
    DragonSystem.POWER_REWARD_OK({ type: 'dragon' }) === false
    && DragonSystem.SOUL_REWARD_OK({ type: 'dragon' }) === false);

  // 地图闸门
  T('巨④-没注入地图查找时不拦（沙盒照常）', ds.mapAllowsDragon() === true);
  ds.setMapLookup((id) => (id === 'yes' ? { dragon: { enabled: true } } : { }));
  bus.emit('map:loaded', { mapId: 'no' });
  T('巨⑤-地图没声明 dragon → 不生成', ds.mapAllowsDragon() === false);
  bus.emit('map:loaded', { mapId: 'yes' });
  T('巨⑥-地图声明了 dragon → 生成', ds.mapAllowsDragon() === true);

  // 换图重置
  ds.elementDragonSpawned = 4; ds.totalKills = 3; ds.soulUnlocked = true;
  ds.factionTotals.blue = 4;
  bus.emit('map:loaded', { mapId: 'yes' });
  T('巨⑦-换地图把局内进度整个清零（否则换图后可能直接出远古龙）',
    ds.elementDragonSpawned === 0 && ds.totalKills === 0
    && ds.soulUnlocked === false && ds.factionTotals.blue === 0);

  // 只有召唤师峡谷声明了
  const { MAPS } = await import('../src/data/maps/index.js');
  T('巨⑧-三张内置图里只有召唤师峡谷声明了 dragon',
    Object.values(MAPS).filter(m => m.dragon?.enabled === true)
      .every(m => /summoners_rift/.test(m.id)));
}

// 行为：击杀后近战兵也拿到力，但拿不到魂
{
  const bus = new EventBus(), ents = new EntityContainer(bus);
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const tw = mkE(ents, 'tower', 0, 0, { _mapFaction: 'blue', faction: 'blue' });
  const me = mkE(ents, 'melee', 10, 0, { _mapFaction: 'blue', faction: 'blue' });
  const d = mkE(ents, 'dragon', 50, 50, { _element: 'fire', _isAncient: false,
    _lastHitBy: tw.id, _lastHitFaction: 'blue' });
  d.alive = false;
  bus.emit('entity:death', { entityId: d.id });
  const hasPower = (e) => fx.getEffects(e.id).some(x => x.blueprint?.stackKey?.startsWith('dragon_fire'));
  T('巨⑨-击杀后近战兵**真的**拿到了力（不是只改了判据函数）', hasPower(me));
  T('巨⑩-但近战兵没有魂', !(me._skillInstances || []).some(s => s.skillId.startsWith('dragonsoul_')));
}

// ==================== 四、光照：黎明不再断电 ====================
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('光①-夜色包络抽成一个函数，塔灯与火炬共用（不是各算一份）',
    /_nightLevel\(\) \{/.test(tr)
    && (tr.match(/this\._nightLevel\(\)/g) || []).length >= 2);
  T('光②-包络不再用 `phase >= 0.5` 这个半开区间（它在相位 0 处断电）',
    !/phase >= 0\.5 \? Math\.sin/.test(tr));
  T('光③-改成以「离正午的角距」为准（天然跨零点连续）',
    /phase - 0\.25/.test(tr));
  T('光④-低阳段有地板（dawnFloor），软编码可关',
    /dawnFloor/.test(tr) && 'dawnFloor' in CONFIG.ui.towerLight);

  // 行为：夜色包络在相位 0 附近必须**连续**（这正是 bug 的形状）
  // 直接把公式抄一遍会变成"断言与实现同源"，所以这里钉的是**配置**与源码形状，
  // 数值连续性由下面这条纯数学检查兜底（同一个公式，两个相邻相位不该差一个数量级）。
  // ⚠️ 这里复刻了一份公式。通常"断言与实现同源"是要避免的，但这两条钉的是
  // **数学性质**（跨零点连续 / 正午必须是白天），不是"公式长什么样"——
  // 公式形状由上面几条正则断言守着，性质由这两条守着，两者独立。
  // 而且它当场抓到了实现里少写一个 `1 -` 导致的**昼夜完全颠倒**（正午灯全亮）。
  const env = (phase) => {
    const d = ((phase - 0.25) % 1 + 1) % 1;
    const away = 1 - Math.abs(d - 0.5) / 0.5;
    let n = Math.max(0, 1 - Math.cos(away * Math.PI / 2) ** 1.5);
    if (away > 0.45) n = Math.max(n, CONFIG.ui.towerLight.dawnFloor ?? 0.35);
    return n;
  };
  T('光⑤-相位跨零点时夜色连续（旧式在这里从 0.59 直接掉到 0）',
    Math.abs(env(0.999) - env(0.001)) < 0.02 && env(0.001) > 0.2);
  T('光⑥-正午仍然是白天（地板不能把白天也点亮）', env(0.25) < 0.05);

  T('光⑦-昼夜曲线的低阳三档整体抬亮，正午一档未动', (() => {
    const dn = srcRaw('src/presentation/DayNight.js');
    const mid = /p: 0\.25[^}]*elev: 82, exp: 1\.00, amb: 0\.30/.test(dn);
    const dawn = /p: 0\.00[^}]*elev: 16, exp: 0\.86, amb: 0\.52/.test(dn);
    const night = /p: 0\.75[^}]*elev: 14, exp: 0\.66, amb: 0\.68/.test(dn);
    return mid && dawn && night;
  })());
}

// ==================== 五、火炬 ====================
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('炬①-独立光池（与塔灯分开，否则野区那几盏永远抢不过一堆塔）',
    /this\.torchLights = \[\]/.test(tr) && /_syncTorchLights\(\)/.test(tr));
  T('炬②-布点：地图声明优先，否则程序化（用户定稿"两者都要"）',
    /Array\.isArray\(map\.torches\)/.test(tr) && /抖动网格/.test(srcRaw('src/presentation/ThreeRenderer.js')));
  T('炬③-数值全部软编码在 CONFIG.ui.torch',
    ['enabled', 'poolSize', 'spacing', 'radius', 'height', 'edgeLux', 'color']
      .every(k => k in CONFIG.ui.torch));
  T('炬④-火炬比塔灯暗（氛围补光不该抢塔的视觉重心）',
    CONFIG.ui.torch.edgeLux < CONFIG.ui.towerLight.edgeLux);
  T('炬⑤-切图时重算布点（不然换了图还亮在上一张图的位置）',
    /_torchPts = null/.test(tr));
}

// ==================== 六、天气盒深度 ====================
{
  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('天①-盒深补了 ceiling·cot(仰角) 的余量',
    /cotP/.test(tr) && /depthPad/.test(tr) && /\+ depthPad/.test(tr));
  T('天②-那个把盒深【算小】的 0.15 下限已去掉',
    !/Math\.max\(0\.15, Math\.sin\(this\.elevationDeg/.test(tr));

  // 纯数学：仰角越低，需要补的余量越大（这就是"下面缺一条带"的量）
  const pad = (deg) => {
    const s = Math.max(1e-3, Math.sin(deg * Math.PI / 180));
    return Math.min(520 * (Math.cos(deg * Math.PI / 180) / s), 520 * 12);
  };
  T('天③-仰角越低要补得越多（与"拉低视角才缺"完全一致）',
    pad(20) > pad(45) && pad(45) > pad(80) && pad(80) > 0);
}

// ==================== 七、塔模型 ====================
{
  const umf = srcOf('src/presentation/UnitMeshFactory.js');
  const ul = srcOf('src/presentation/UnitLayer.js');

  T('塔①-红蓝走各自的造型分支（不再只差颜色）',
    /const red = faction === 'red'/.test(umf));
  T('塔②-死字段已删（spikes 从 v44 起就没有任何部件读它）',
    !/spikes/.test(umf) && !/F\.pointy/.test(umf));
  T('塔③-基座那圈队伍色环已删（用户："水晶塔下面那个颜色的环不要"）',
    !/halo/.test(umf));
  T('塔④-召唤水晶与水晶枢纽不再共用一段代码（枢纽有高台+方碑+卫星碎晶）',
    /卫星碎晶/.test(srcRaw('src/presentation/UnitMeshFactory.js')));
  T('塔⑤-碎晶轨道半径由几何算出，不再写死（这是穿模的根因）',
    /const orbit = Math\.max\(colR \+ colHalf \+ shardR \+ gap/.test(umf));
}

// ==================== 八、损毁档（不可逆 + 重生清零）====================
{
  const { towerDamageStage } = await import('../src/presentation/UnitMeshFactory.js');
  const e = {};
  T('损①-满血 = 0 档', towerDamageStage(e, 1.0) === 0);
  T('损②-掉到 67 以下 = 轻度', towerDamageStage(e, 0.50) === 1);
  T('损③-掉到 33 以下 = 重度', towerDamageStage(e, 0.20) === 2);
  T('损④-**不可逆**：治疗回满血也不退档（用户定稿）', towerDamageStage(e, 1.0) === 2);
  const e2 = {};
  towerDamageStage(e2, 0.50);
  T('损⑤-中间档同样不可逆', towerDamageStage(e2, 0.99) === 1);
  T('损⑥-档位记在实体上（渲染层重建也不会丢）', e2._dmgStage === 1);

  T('损⑦-节点软编码在 CONFIG.ui.towerDamage',
    Array.isArray(CONFIG.ui.towerDamage.nodes) && CONFIG.ui.towerDamage.nodes.length === 2);
  const sav = CONFIG.ui.towerDamage.enabled;
  CONFIG.ui.towerDamage.enabled = false;
  T('损⑧-开关关掉后一律 0 档', towerDamageStage({}, 0.05) === 0);
  CONFIG.ui.towerDamage.enabled = sav;

  const ms = srcOf('src/systems/MapSystem.js');
  T('损⑨-重生时清零（用户："塔手动重生时要恢复零损毁的模型"）',
    /delete corpse\._dmgStage/.test(ms));
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('损⑩-损毁档进了几何缓存 key（不进则三档共用第一个被缓存的几何）',
    /\$\{dmg\}/.test(ul));
}

// ==================== 九、分区贴图管线 ====================
{
  const tm = srcOf('src/presentation/TerrainMaterial.js');
  const { ZONES, zoneGrid } = await import('../src/presentation/TerrainMaterial.js');
  T('区①-五个分区都在（高地/路径/野区/河道/基地 + 通用底）',
    ['ground', 'plateau', 'lane', 'jungle', 'river', 'base'].every(z => ZONES.includes(z)));
  T('区②-分区用与高地遮罩**同一份** walk 网格（否则边界会错开一格）',
    /zoneGrid\(map, gr\.walk, gr\.nx, gr\.ny/.test(srcOf('src/presentation/ThreeRenderer.js')));

  // 行为：优先级 base > river > lane > plateau > jungle
  const nx = 10, ny = 10, world = { w: 1000, h: 1000 };
  const walk = new Uint8Array(nx * ny).fill(1);
  walk[0] = 0;   // 左上角设为不可走 → 高地
  const map = {
    lanes: [{ waypoints: [{ x: 550, y: 550 }] }],
    buildings: [{ tier: 'nexus_main', pos: { x: 950, y: 950 } }],
    zoneRadii: { lane: 60, base: 80, river: 40 },
  };
  const zg = zoneGrid(map, walk, nx, ny, world);
  const at = (gx, gy) => ZONES[zg[gy * nx + gx]];
  T('区③-不可走格 = 高地', at(0, 0) === 'plateau');
  T('区④-兵线附近 = 路径', at(5, 5) === 'lane');
  T('区⑤-基地附近 = 基地（优先级高于路径）', at(9, 9) === 'base');
  T('区⑥-其余可走格 = 野区', at(2, 7) === 'jungle');

  T('区⑦-每张分区图都可缺失（缺了退回占位图，现有地图逐像素不变）',
    /placeholderTexture/.test(srcOf('src/presentation/ThreeRenderer.js'))
    && /zoneTex\[zn\] \|\|/.test(tm));
  T('区⑧-提示词文档在仓库里（用户要拿去让 ChatGPT 出图）', (() => {
    try { return srcRaw('docs/TEXTURE-PROMPTS.md').includes('seamless tileable'); }
    catch { return false; }
  })());
}

done();
