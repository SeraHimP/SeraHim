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
  // v45：布点已抽成 torchPlacement.js 的纯函数（理由见那个文件的头注：
  // 逻辑住在只有真浏览器才跑的地方 = 没有断言守着，那个"全图没灯"的 bug 就是这么漏的）。
  T('炬②-布点：地图声明优先，否则程序化（用户定稿"两者都要"）',
    /Array\.isArray\(map\.torches\)/.test(srcOf('src/presentation/torchPlacement.js'))
    && /抖动网格/.test(srcRaw('src/presentation/torchPlacement.js')));
  T('炬③-数值全部软编码在 CONFIG.ui.torch',
    ['enabled', 'poolSize', 'spacing', 'radius', 'height', 'edgeLux', 'color']
      .every(k => k in CONFIG.ui.torch));
  T('炬④-火炬比塔灯暗（氛围补光不该抢塔的视觉重心）',
    CONFIG.ui.torch.edgeLux < CONFIG.ui.towerLight.edgeLux);
  T('炬⑤-切图时重算布点（不然换了图还亮在上一张图的位置）',
    /_torchPts = null/.test(tr));

  // ==================== 布点必须真的撒得出点来 ====================
  // 用户："地图还是乌漆嘛黑的，环境中的灯在哪？？？"——第一版把世界尺寸写成
  // `map.width || 900`，而地图的世界尺寸在 `map.world.w`（召唤师峡谷 3552）。
  // `||` 把"字段不存在"静默变成了合法值，撒点范围被限死在左上角 900×700 的一小块，
  // 全图等于没有火炬。不报错、画面只是"有点暗"，这类错误最难查。
  //
  // 光钉源码是钉不住这种错的（写成什么字段名都"看起来对"），所以布点已抽成纯函数
  // torchPlacement.js，下面直接跑它。
  const { torchPoints } = await import('../src/presentation/torchPlacement.js');
  const { MAPS: M2 } = await import('../src/data/maps/index.js');
  for (const map of Object.values(M2)) {
    const pts = torchPoints(map, () => true, CONFIG.ui.torch);
    const W = map.world?.w || 0, H = map.world?.h || 0;
    T(`炬⑥-${map.id}：撒得出足够多的火炬点（至少够填满光池）`,
      pts.length >= CONFIG.ui.torch.poolSize);
    T(`炬⑦-${map.id}：点都落在世界范围内`,
      pts.every(p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H));
    // 覆盖面：点必须散布到地图**右下半区**，而不是全挤在左上角（那正是 bug 的形状）
    T(`炬⑧-${map.id}：右下半区也有点（不是全挤在左上角）`,
      pts.some(p => p.x > W * 0.6 && p.y > H * 0.6));
  }
  T('炬⑨-地图声明的 torches 优先于自动布点（用户定稿"两者都要"）', (() => {
    const fake = { world: { w: 1000, h: 1000 }, torches: [{ x: 5, y: 7 }] };
    const pts = torchPoints(fake, () => true, CONFIG.ui.torch);
    return pts.length === 1 && pts[0].x === 5 && pts[0].y === 7;
  })());
  T('炬⑩-不可走的地方不撒点', (() => {
    const fake = { world: { w: 2000, h: 2000 }, lanes: [] };
    return torchPoints(fake, () => false, CONFIG.ui.torch).length === 0;
  })());

  // ==================== 龙的朝向：钉在**链路**上，不是钉在定义上 ====================
  // 用户第二次报"龙的朝向问题依旧没有被修复"。我上一轮做了两件事（几何转正、删白名单），
  // 唯独漏了真正的开关：UnitLayer 的**龙分支从来没有返回 facing 字段**，
  // en.facing 恒为 false，那段旋转代码对龙一次都没执行过。
  // 我当时验证的是"needsFacing('dragon') 返回 true"——钉在了定义上，不是链路上。
  const ul2 = srcOf('src/presentation/UnitLayer.js');
  T('龙朝①-龙的 visual 里带 facing 字段（这才是真正的开关）', (() => {
    const i = ul2.indexOf("if (e.type === 'dragon')");
    const j = ul2.indexOf("const st = minionStyle", i);
    return i > 0 && j > i && /facing: needsFacing\(e\.type\)/.test(ul2.slice(i, j));
  })());
  T('龙朝②-塔的 visual 里**没有** facing（塔豁免，多给了反而会转）', (() => {
    const i = ul2.indexOf("if (e.type === 'tower')");
    const j = ul2.indexOf("if (e.type === 'dragon')", i);
    return i >= 0 && j > i && !/facing:/.test(ul2.slice(i, j));
  })());

  // ==================== 建筑尺寸 ====================
  T('尺①-四种塔一律 24、召唤水晶 28、水晶枢纽 40（用户定稿）',
    ['outer', 'inner', 'base', 'hq_tower'].every(k => CONFIG.buildingSizes[k] === 24)
    && CONFIG.buildingSizes.nexus_lane === 28 && CONFIG.buildingSizes.nexus_main === 40);
  T('尺②-渲染不再额外乘系数（"写多少就画多大"）',
    /const rSize = bSize;/.test(ul2));

  // ==================== 分区贴图默认退回原有贴图 ====================
  const tr2 = srcOf('src/presentation/ThreeRenderer.js');
  T('区⑨-缺分区图时回落到现有 ground/plateau，而不是彩色占位图（用户："先借用原有的贴图"）',
    CONFIG.ui.zoneTextures.usePlaceholder === false
    && tr2.includes('usePh ? placeholderTexture(zn) : null')
    && tr2.includes("zn === 'plateau' ? plateau : ground"));
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

  // ==================== 主体尺寸不随损毁变（用户当场推翻了我前两版）====================
  // 用户："损毁是指**在原有的模型上**损毁，你这损毁的模型主体甚至都跟原先不一样了！"
  // 我前两版用"塔身高度×0.74 / 跳过整段冠与雉堞"来表达损毁 —— 主体本身变了，
  // 读起来是另一种建筑。这两条钉的就是那个错误：三档的**塔顶高度与炮口高度必须一致**。
  // 炮口尤其重要：它随损毁上下跳的话，弹道会看起来像换了一把武器。
  const THREE = await import('../vendor/three.module.js').catch(() => null);
  if (THREE) {
    const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
    for (const fac of ['blue', 'red']) {
      for (const tier of ['outer', 'inner', 'base', 'hq_tower']) {
        const m = [0, 1, 2].map(d =>
          towerMesh(`v46|${fac}|${tier}|${d}`, '#5b9bd5', 34, '', 'tower', false, false, tier, fac, d));
        T(`损⑪-${fac}/${tier}：三档塔顶高度一致（主体不变）`,
          Math.abs(m[0].topY - m[1].topY) < 1e-6 && Math.abs(m[0].topY - m[2].topY) < 1e-6);
        T(`损⑫-${fac}/${tier}：三档炮口高度一致（否则弹道像换了武器）`,
          Math.abs(m[0].muzzleY - m[1].muzzleY) < 1e-6 && Math.abs(m[0].muzzleY - m[2].muzzleY) < 1e-6);
        T(`损⑬-${fac}/${tier}：损毁档确实换了几何（不是什么都没做）`,
          m[0].geo !== m[1].geo && m[1].geo !== m[2].geo
          && m[0].geo.attributes.position.count !== m[2].geo.attributes.position.count);
      }
    }
  }
  const umf2 = srcOf('src/presentation/UnitMeshFactory.js');
  T('损⑭-塔身高度不再随损毁缩水（shaftK 恒为 1）',
    /const shaftK = 1;/.test(umf2));
  // 用户："我看你做的重度损毁甚至和其他模型颜色都不同！这是不对的！"
  // 损毁只做很轻的做旧，可读性靠形状（掉块/缺口/碎石）。这条钉住"别再变成另一种材质"。
  T('损⑮-损毁只做轻度做旧，不换材质（重损压暗不超过 20%）',
    /const wear  = dmg === 0 \? 1 : dmg === 1 \? 0\.9\d : 0\.8\d;/.test(umf2));
  T('损⑯-掉块函数存在，且基座/塔身/冠都调了它（"塔身等所有地方"）',
    /const chip = \(cy, rad, n, seed/.test(umf2)
    && (umf2.match(/\bchip\(/g) || []).length >= 4);
  // v45d：冠的做法又改了一次，理由是用户"红方的塔顶部，正常和损毁的样式甚至都对应不上"。
  // 上一版完好画整块、损毁改画扇形环 —— 两者轮廓根本不是同一个东西。
  // 现在**三档一律整块**，损毁只是在冠沿嵌几块 char 色的缺口。
  // 所以这条从"完好是整块"改成"三档都是整块（冠体只 add 一次）"。
  T('损⑰-冠的做法三档一致（同一个零件坏掉，不是换了个零件）', (() => {
    const seg = umf2.slice(umf2.indexOf('const nSec = red'), umf2.indexOf('const crownTopY'));
    // 冠体本身只画一次，且不在任何 dmg 分支里
    return (seg.match(/new THREE\.CylinderGeometry\(R \* 0\.72, R \* 0\.86, crownH/g) || []).length === 1
        && !/if \(dmg === 0\)/.test(seg);
  })());
  T('损⑱b-顶部已精简：悬浮件与尖塔都删了（用户："顶部元素别整的太多了"）',
    !/orbs/.test(umf2) && !/SP\.spire/.test(umf2) && /topScale/.test(umf2));

  // 用户说的是"**每种**塔"，召唤水晶/水晶枢纽也算。它们与防御塔用同一套损毁词汇：
  // 主体尺寸不动、护柱断成残根（不整根消失）、加掉块与碎石。
  if (THREE) {
    const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
    for (const kind of ['orb', 'gem']) {
      const m = [0, 1, 2].map(d =>
        towerMesh(`v46c|${kind}|${d}`, '#5b9bd5', 34, '', kind, false, false, 'nexus_main', 'blue', d));
      T(`损⑲-${kind}：三档炮口高度一致（水晶就是炮口）`,
        Math.abs(m[0].muzzleY - m[1].muzzleY) < 1e-6 && Math.abs(m[0].muzzleY - m[2].muzzleY) < 1e-6);
      T(`损⑳-${kind}：损毁确实换了几何`,
        m[0].geo.attributes.position.count !== m[2].geo.attributes.position.count);
    }
  }
  T('损⑱-角楼架在冠顶（crownTopY），不是架在雉堞推进后的高度上（那样会悬空）',
    /const crownTopY = y;/.test(umf2) && /T\(tx, crownTopY \+ th \/ 2, tz\)/.test(umf2));

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

// ==================== 十、脚手架自身的一个真 bug ====================
// 排查"区⑨怎么都匹配不上"时挖出来的：stripComments **先剥块注释、后剥行注释**，
// 于是行注释里出现的 `/*`（ThreeRenderer.js 里就有一处：`default/*.png`）
// 会被当成块注释的开始，一路吃到后面第一个 `*​/` —— 实测吞掉 1981 个字符的真代码。
//
// 后果不是报错，是**断言凭空失效**：对那段代码的 srcOf 断言永远为假、
// 否定断言则永远为真，而且看起来完全像"我正则写错了"。
// 这正是 _harness 当初被造出来要防的那一类问题，只是方向反了过来。
// 已改成先行后块。下面两条钉住它，免得哪天有人"顺手"把顺序调回去。
{
  const { stripComments } = await import('./_harness.mjs');
  const sample = [
    '// 说明里提到了 assets/textures/default/*.png 这个路径',
    'const KEEP_ME = 1;',
    '/* 真的块注释 DROP_ME */',
    'const ALSO_KEEP = 2;',
  ].join('\n');
  const out = stripComments(sample);
  T('架①-行注释里的 /* 不会吞掉后面的真代码', /KEEP_ME/.test(out) && /ALSO_KEEP/.test(out));
  T('架②-真的块注释仍然被剥掉', !/DROP_ME/.test(out));
  T('架③-真实文件上验一遍（ThreeRenderer 就是踩到的那个）', (() => {
    const st = srcOf('src/presentation/ThreeRenderer.js');
    // 这一句在被吞掉的那 1981 字符里
    return st.includes('const pick = async (name)');
  })());
}

// ==================== 十一、闪电杖的攻击特效每跳修正 ====================
// 用户定稿："由于闪电杖是固定每秒四次伤害，所以遇到攻击特效时应该每次伤害造成的
// 攻击特效应该进行修正，每次 ×0.25。"
{
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');

  const mkWorld = () => {
    const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
    const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
    return { bus, ents, fx, combat };
  };
  const mkPair = (ents, onHitFlat = 100) => {
    const a = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
      baseStats: { ...CONFIG.templates.tower, onHitDamage: onHitFlat, onHitPercentDamage: 0,
                   attackDamage: 0, damageAmpPct: 0 },
      currentHP: 9999, shieldFixedCurrent: 0, tempShield: 0, _skillInstances: [],
      _mapFaction: 'blue', faction: 'blue' };
    const t = { id: ++window._uid, type: 'melee', alive: true, pos: { x: 10, y: 0 },
      baseStats: { ...CONFIG.templates.melee, armor: 0, magicResist: 0, damageReduction: 0, damageBlock: 0 },
      currentHP: 1e7, shieldFixedCurrent: 0, tempShield: 0, _skillInstances: [],
      _mapFaction: 'red', faction: 'red' };
    ents.add(a); ents.add(t); return { a, t };
  };

  // ① 数值部分：按系数并入
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 100);
    const hp0 = t.currentHP;
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic', { onHitScale: 0.25 });
    const dealt = hp0 - t.currentHP;
    T('特①-攻击特效的固定伤害按 ×0.25 并入（100 → 25）', Math.abs(dealt - 25) < 0.5);
  }
  // ② 不传系数时**逐位不变**：溅射/DOT 那些调用方不该带攻击特效
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 100);
    const hp0 = t.currentHP;
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic');
    T('特②-不传系数的调用方一点攻击特效都不带（溅射不该结算两遍）',
      Math.abs(hp0 - t.currentHP) < 1e-9);
  }
  // ③ 百分比攻击特效同样按系数走
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 0);
    a.baseStats.onHitPercentDamage = 1;      // 1% 当前生命
    const hp0 = t.currentHP;
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic', { onHitScale: 0.25 });
    T('特③-百分比攻击特效同样 ×0.25（1% × 0.25 = 0.25%）',
      Math.abs((hp0 - t.currentHP) - hp0 * 0.0025) < hp0 * 1e-6);
  }
  // ④ 被动限流：4 跳只触发 1 次
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 0);
    let procs = 0;
    SkillLibrary.__test_proc = { id: '__test_proc', name: 'T', category: 'passive',
      onDealtDamage: () => { procs++; } };
    a._skillInstances.push({ id: ++window._uid, skillId: '__test_proc', state: {} });
    for (let i = 0; i < 12; i++) w.combat.performAttackDirect(a.id, t.id, 1, 'magic', { onHitScale: 0.25 });
    T('特④-被动限流：12 跳只触发 3 次（= 每秒 1 次，与 1.0 攻速同节奏）', procs === 3);

    procs = 0;
    for (let i = 0; i < 5; i++) w.combat.performAttackDirect(a.id, t.id, 1, 'magic');
    T('特⑤-不传系数时被动每次都触发（其余路径行为不变）', procs === 5);
    delete SkillLibrary.__test_proc;
  }
  // ⑤ 系数由跳数派生，不写死
  {
    const wp = srcOf('src/core/skills/weapons.js');
    T('特⑥-系数默认取 1/tickPerSec，不是写死的 0.25（改跳数时自动跟上）',
      /onHitScale: P\.onHitScale \?\? \(1 \/ Math\.max\(1, P\.tickPerSec \|\| 4\)\)/.test(wp));
    T('特⑦-系数是软编码的，编辑器里可改', 'onHitScale' in SkillLibrary.weapon_lightning.defaultParams);
  }
}

done();