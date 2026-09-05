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

  // ==================== 优先级：在走就朝着走的方向（v45b 推翻了第一版）====================
  // 第一版这条断言写的是"有目标时朝目标，否则绕后就没意义了" —— 听起来有道理，
  // **实际是错的**，而且直接造成了用户报的"兵原地漂移/转圈"：
  // 一个已锁定目标但还在移动的兵（追击、落位、被挤开、绕障）会一边朝目标一边往别处走，
  // 看起来就是横着滑/倒着滑。无头探针量出来：318 个兵里 **71 个**持续错向 > 0.9 秒。
  // 改成"在走就朝着走的方向、站定才朝目标"之后降到 15 个（剩下的是站桩被碰撞推着走，
  // 那种情况面朝目标本来就是对的）。
  //
  // "绕后有意义"这件事**并没有丢**：兵停下来打人的那一刻就会转向目标，转到位才开火，
  // 被从背后贴脸时照样要先转过来。丢的只是"一边跑一边把脸拧向目标"那个不自然的姿态。
  {
    const k = mkE(ents, 'melee', 0, 0);
    const kt = mkE(ents, 'melee', -100, 0);
    k._facing = 0; k.targetId = kt.id;
    for (let i = 0; i < 80; i++) { k.pos.x += 1; fs.update(0.02); }   // 一边朝 +X 走一边"打" -X 的敌人
    T('朝⑨-在移动时朝【移动方向】，不朝目标（否则就是横着走 = 用户报的漂移）',
      Math.abs(wrapPi(k._facing - Math.PI / 2)) < 0.25);

    // 站定之后才转向目标 —— "必须转过来才能打"这条规则靠的是这一段
    for (let i = 0; i < 200; i++) fs.update(0.02);                    // 不再推位置
    T('朝⑩-站定后转向目标（转到位才开得了火）',
      Math.abs(wrapPi(k._facing - angleTo(k.pos, kt.pos))) < 0.2);

    // 碰撞抖动不该让站桩的兵乱转：每帧随机推 ±1px，平滑后应仍朝着目标
    const j = mkE(ents, 'melee', 0, 0);
    const jt = mkE(ents, 'melee', 0, 200, {});
    j.targetId = jt.id; j._facing = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < 300; i++) { j.pos.x += rnd() * 2; j.pos.y += rnd() * 2; fs.update(0.02); }
    T('朝⑪-碰撞抖动不会让站桩单位乱转（判"在不在走"用的是平滑速度，不是单帧位移）',
      Math.abs(wrapPi(j._facing - angleTo(j.pos, jt.pos))) < 0.35);
  }

  // 总开关
  const sav = CONFIG.tuning.facing.enabled;
  CONFIG.tuning.facing.enabled = false;
  T('朝⑫-总开关关掉后不再限制（软编码，可退回旧行为）', canFire(m2, outFoe) === true);
  CONFIG.tuning.facing.enabled = sav;

  // 唯一的攻击路径（沙盒模式的第二条已随沙盒模式删除）调朝向门这份共用实现 —— 攻城模式那次的教训
  const cs = srcOf('src/systems/CombatSystem.js');
  const lms = srcOf('src/systems/LaneMovementSystem.js');
  T('朝⑬-攻击路径调 canFire（规则只有一份实现）', /canFire\(minion, target\)/.test(lms));
  T('朝⑭-不自己算角差（自己算就是第二份实现）',
    !/Math\.atan2[^\n]*_facing/.test(cs) && !/Math\.atan2[^\n]*_facing/.test(lms));

  // ==================== 平衡工具必须跑同一套系统 ====================
  // 我之前跟用户说"朝向改成严苛档，v44 那轮 sweep 数据作废" —— **那句话是错的**：
  // balance_matrix 压根没接 FacingSystem，_facing 恒为 undefined，
  // canFire 走"没跑过一帧就不卡第一下"的兜底一律返回 true，
  // 于是这条规则在平衡测量里**整个不存在**。数据没被作废，是工具没在量它。
  //
  // 这正是 FacingSystem 头注里写的那件事（规则留在渲染层 = 无头模式里规则消失），
  // 我把规则下沉到模拟层却忘了接工具，绕一圈踩回同一个坑。已接上并钉住。
  {
    const bm = srcOf('tools/balance_matrix.mjs');
    T('工①-平衡工具接了 FacingSystem（否则测的不是游戏里的规则）',
      /new FacingSystem\(/.test(bm) && /facing\.update\(SIM_DT\)/.test(bm));
    T('工②-更新顺序与 main.js 的 stepSimulation 一致（移动/碰撞之后）', (() => {
      const i = ['coll.update', 'facing.update', 'combat.update'].map(n => bm.indexOf(n));
      return i.every(x => x >= 0) && i[0] < i[1] && i[1] < i[2];
    })());
  }

  // 渲染层必须**读**模拟层的朝向，不能自己再算一份
  const ul = srcOf('src/presentation/UnitLayer.js');
  T('朝⑮-渲染层读 e._facing，不再自己拿位置增量算朝向',
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
  T('巨④-没注入地图查找时不拦（尚未载入地图数据，默认放行）', ds.mapAllowsDragon() === true);
  ds.setMapLookup((id) => (id === 'yes' ? { dragon: { enabled: true } } : { }));
  // v51.23：DragonSystem 换成挂 map:loading（不再是 map:loaded）——resetRun 必须在
  // 建塔之前触发，见 DragonSystem.js 那段修复注释。测试用的信号跟着改用真实事件名。
  bus.emit('map:loading', { mapId: 'no' });
  T('巨⑤-地图没声明 dragon → 不生成', ds.mapAllowsDragon() === false);
  bus.emit('map:loading', { mapId: 'yes' });
  T('巨⑥-地图声明了 dragon → 生成', ds.mapAllowsDragon() === true);

  // 换图重置
  ds.elementDragonSpawned = 4; ds.totalKills = 3; ds.soulUnlocked = true;
  ds.factionTotals.blue = 4;
  bus.emit('map:loading', { mapId: 'yes' });
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
    // v51.26 新增了 azim（太阳方位角）列，插在 elev 和 exp 之间——
    // 这里放宽成 elev 和 exp 之间允许任意非 } 字符，不再要求两者字面相邻。
    const dn = srcRaw('src/presentation/DayNight.js');
    const mid = /p: 0\.25[^}]*elev: 82,[^}]*exp: 1\.00, amb: 0\.30/.test(dn);
    const dawn = /p: 0\.00[^}]*elev: 16,[^}]*exp: 0\.86, amb: 0\.52/.test(dn);
    const night = /p: 0\.75[^}]*elev: 14,[^}]*exp: 0\.66, amb: 0\.68/.test(dn);
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
    // 覆盖面：点必须散布到地图**右下半区**，而不是全挤在左上角（那正是 bug 的形状）——
    // 但这条只对**走程序化撒点**的地图有意义。声明了 `map.torches` 的地图（比如
    // howling_abyss_frost_v1：26 个点精确对应桥两侧的石柱，见 HowlingAbyssDecor.js）
    // 是作者钦定的位置，天然不需要"覆盖全图象限"——嚎哭深渊的桥本来就是从左下到
    // 右上的反对角线，任何贴着这条线的点都不可能同时 x>0.6W 且 y>0.6H（这两个
    // 条件在反对角线上互斥），这不是 bug，是这条对角线的几何形状决定的。
    if (!Array.isArray(map.torches) || !map.torches.length) {
      T(`炬⑧-${map.id}：右下半区也有点（不是全挤在左上角）`,
        pts.some(p => p.x > W * 0.6 && p.y > H * 0.6));
    }
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
  // v45：数值改过一轮。用户看图后："塔模型太小了，改为和之前差不多那种。32 左右。
  // 召唤水晶也大一些。"——改动前的实际显示尺寸是 28×1.25 = 35，所以 32 落在"差不多"上。
  // 断言钉的是**形状**（四种塔同尺寸、召唤水晶 < 水晶枢纽、都在合理区间），不钉死具体数字：
  // 这几个值明摆着还会被调，钉死等于每调一次就要来改一次断言。
  T('尺①-四种塔尺寸一致（层级差异靠造型不靠体积）', (() => {
    const b = CONFIG.buildingSizes;
    return new Set(['outer', 'inner', 'base', 'hq_tower'].map(k => b[k])).size === 1;
  })());
  T('尺②-塔在 30~36 之间（用户定稿"32 左右"）',
    CONFIG.buildingSizes.outer >= 30 && CONFIG.buildingSizes.outer <= 36);
  T('尺③-召唤水晶比塔大、又比水晶枢纽小',
    CONFIG.buildingSizes.nexus_lane > CONFIG.buildingSizes.outer
    && CONFIG.buildingSizes.nexus_lane < CONFIG.buildingSizes.nexus_main);
  T('尺④-渲染不再额外乘系数（"写多少就画多大"）',
    /const rSize = bSize;/.test(ul2));

  // 龙的尺寸：软编码，且**两处读同一个来源**（原来 UnitLayer 与 UnitMeshFactory 各写死一份，
  // 不同步的话血条/选中圈会与模型对不上 —— 又是"同一个量两处各写一份"）。
  T('尺⑤-龙的尺寸在 CONFIG.dragonSizes 里（不再写死）',
    typeof CONFIG.dragonSizes === 'object'
    && CONFIG.dragonSizes.element > 0 && CONFIG.dragonSizes.ancient > CONFIG.dragonSizes.element);
  T('尺⑥-两处都读它，不再各写死一份 30/24',
    !/const size = anc \? 30 : 24/.test(ul2)
    && !/const S = ancient \? 30 : 24/.test(srcOf('src/presentation/UnitMeshFactory.js')));
  T('尺⑦-龙比改动前大（用户："龙的模型大一些"）', CONFIG.dragonSizes.element > 24);
  const THREE_SZ = await import('../vendor/three.module.js').catch(() => null);
  if (THREE_SZ) {
    const { dragonMesh } = await import('../src/presentation/UnitMeshFactory.js');
    const small = dragonMesh('sz|s', '#c0392b', false, 20);
    const big = dragonMesh('sz|b', '#c0392b', false, 40);
    T('尺⑧-尺寸真的驱动几何（不是只改了数字）', big.topY > small.topY * 1.5);
  }

  // 火炬：用户看到"光跟着视角走"后要求去掉。实现整套保留，只是默认关。
  T('炬⑪-默认关闭（用户："这个莫名其妙的灯……不要这个"）',
    CONFIG.ui.torch.enabled === false);
  T('炬⑫-实现仍在（改 enabled 即可复现，不是把功能删了）',
    /_syncTorchLights\(\)/.test(srcOf('src/presentation/ThreeRenderer.js')));

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
    // v54：切片终点原来用 'const crownTopY'，那是角楼的锚点变量，角楼已随
    // "去掉塔顶那堆小装饰"一并删除（用户："尤其是蓝方上面那一堆小块块，看的我头疼"）。
    // 改用顶盖那段的第一行代码当终点 —— 它是冠之后紧接着的下一段，范围与原来等价。
    // ⚠️ 终点必须是**代码 token**，不能用注释：srcOf() 会先 stripComments()，
    //    拿注释当锚点会 indexOf 得到 -1，切出一段完全错误的范围（本轮踩到过）。
    const seg = umf2.slice(umf2.indexOf('const nSec = red'), umf2.indexOf('const topH = '));
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
  // v54：这条改过两次，过程本身值得留着 ——
  //   ① 用户："去除那些莫名其妙并且丑的小装饰，尤其是蓝方上面那一堆小块块。"
  //      我据此把雉堞与角楼**整段删了**，断言也跟着改成"必须已删"。
  //   ② 用户随即纠正："小块块和角楼**不要全部清掉**啊。"
  //      —— 问题从来不是"有没有"，是"**太多太碎**"（外塔原本一圈 10 块小方齿）。
  // 所以现在钉的是**数量上限**，不是有无：顶部装饰最多四个，且角楼仍然保留。
  // 这样既挡住"又堆回一圈噪点"，也挡住"下次又一刀全删"。
  T('损⑱-塔顶装饰是"减量保留"：最多四个，角楼仍在', (() => {
    const alive = umf2.slice(umf2.indexOf('const SP = TIER_SPEC[tier] || TIER_FALLBACK;'),
                             umf2.indexOf('void weaponId;'));
    const m = alive.match(/const nDeco = (\d+);/);
    return !!m && Number(m[1]) <= 4 && /SP\.turrets/.test(alive) && /crownTopY/.test(alive);
  })());
  if (THREE) {
    const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
    for (const fac of ['blue', 'red']) {
      for (const tier of ['outer', 'inner', 'base', 'hq_tower']) {
        const m = towerMesh(`v54|${fac}|${tier}`, '#5b9bd5', 34, '', 'tower', false, false, tier, fac, 0);
        m.geo.computeBoundingBox();
        T(`损⑱b-${fac}/${tier}：水晶坐在石身上（底面不高于石身顶面，不悬空）`,
          m.crystal.cy - m.crystal.r <= m.geo.boundingBox.max.y + 1e-6);
      }
    }
  }

  // v47：清零改走 core/reviveState.clearDamageMarks 这一份唯一清单。
  // 用户："我手动恢复损毁的塔，但是模型还是重度损毁的模型。"
  // 根因是**复活有两条路**（重生队列 / 编辑器的【设为存活】），v45 只在前一条里
  // 写了 `delete corpse._dmgStage`，后一条只清了 _ruin。断言随之从"某处有那句 delete"
  // 改成"两条路都调同一份清单"——钉的是那条会漏的**链接**，不是某一处的写法。
  const ms = srcOf('src/systems/MapSystem.js');
  const pe = srcOf('src/ui/editor/pagesEntity.js');
  const rs = srcOf('src/core/reviveState.js');
  T('损⑨-复活时清零（用户："塔手动重生时要恢复零损毁的模型"）',
    /delete e\._dmgStage;/.test(rs) && /delete e\._ruin;/.test(rs));
  T('损⑨-两条复活路径都调同一份清单（重生队列 + 编辑器的「设为存活」）',
    /clearDamageMarks\(corpse\)/.test(ms) && /clearDamageMarks\(e\)/.test(pe));
  T('损⑨-两处都不再各自 delete（各清各的就是当年漏掉一处的原因）',
    !/delete corpse\._dmgStage/.test(ms) && !/delete e\._ruin;/.test(pe));
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
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic', { attackShare: 0.25, applyOnHitBonus: true });
    const dealt = hp0 - t.currentHP;
    T('特①-攻击特效的固定伤害按 ×0.25 并入（100 → 25）', Math.abs(dealt - 25) < 0.5);
  }
  // ② 不传 applyOnHitBonus 时**逐位不变**：溅射/DOT 那些调用方不该带攻击特效
  //   （即使传了 attackShare，没开 applyOnHitBonus 也不会叠数值——两件事已经分开）
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 100);
    const hp0 = t.currentHP;
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic');
    T('特②-不开 applyOnHitBonus 的调用方一点攻击特效都不带（溅射不该结算两遍）',
      Math.abs(hp0 - t.currentHP) < 1e-9);
  }
  // ③ 百分比攻击特效同样按系数走
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 0);
    a.baseStats.onHitPercentDamage = 1;      // 1% 当前生命
    const hp0 = t.currentHP;
    w.combat.performAttackDirect(a.id, t.id, 0, 'magic', { attackShare: 0.25, applyOnHitBonus: true });
    T('特③-百分比攻击特效同样 ×0.25（1% × 0.25 = 0.25%）',
      Math.abs((hp0 - t.currentHP) - hp0 * 0.0025) < hp0 * 1e-6);
  }
  // ④ 被动限流：procMode='perAttack' 的被动，4 跳只触发 1 次
  {
    const w = mkWorld(); const { a, t } = mkPair(w.ents, 0);
    let procs = 0;
    SkillLibrary.__test_proc = { id: '__test_proc', name: 'T', category: 'passive',
      procMode: 'perAttack', onDealtDamage: () => { procs++; } };
    a._skillInstances.push({ id: ++window._uid, skillId: '__test_proc', state: {} });
    for (let i = 0; i < 12; i++) w.combat.performAttackDirect(a.id, t.id, 1, 'magic', { attackShare: 0.25 });
    T('特④-被动限流：12 跳只触发 3 次（= 每秒 1 次，与 1.0 攻速同节奏）', procs === 3);

    procs = 0;
    for (let i = 0; i < 5; i++) w.combat.performAttackDirect(a.id, t.id, 1, 'magic');
    T('特⑤-不传 attackShare 时视为一次完整攻击，每次都触发（其余路径行为不变）', procs === 5);
    delete SkillLibrary.__test_proc;
  }
  // ⑤ 系数由跳数派生，不写死
  {
    const wp = srcOf('src/core/skills/weapons.js');
    T('特⑥-系数默认取 1/tickPerSec，不是写死的 0.25（改跳数时自动跟上）',
      /attackShare: P\.attackShare \?\? \(1 \/ Math\.max\(1, P\.tickPerSec \|\| 4\)\)/.test(wp));
    T('特⑦-系数是软编码的，编辑器里可改', 'attackShare' in SkillLibrary.weapon_lightning.defaultParams);
  }
}

// ==================== 十二、塔的静态朝向（沿兵线朝敌方）====================
// 用户："路径上塔的朝向也需要修改，看图……另一阵营同理。"
//        "枢纽塔那里注意看一下，两侧的看向对角线但是略微朝两侧一些。"
{
  const { towerFacingRad } = await import('../src/presentation/towerFacing.js');
  const { MAPS: M3 } = await import('../src/data/maps/index.js');
  const map = M3.summoners_rift_v1;
  const deg = (r) => (r === null ? null : Math.round(r * 180 / Math.PI));
  const of = (b) => deg(towerFacingRad(
    { pos: b.pos, _mapFaction: b.faction, _laneId: b.laneId, _mapTier: b.tier }, map));
  const pick = (f, lane, tier) => map.buildings.find(
    b => b.faction === f && b.laneId === lane && b.tier === tier);

  // ① 每座塔都朝**敌方半场**（红蓝各自成立）。
  //
  // ⚠️ 这一条我第一版写成了"同一路同一档，红蓝朝向必须差 180°"，**前提就是错的**：
  // 上路是条折线（蓝方那几座在左侧竖直段、红方那几座在顶部水平段），
  // 各自贴着自己所在那一段的切线，本来就不该是 180° 互补。中/下路同理。
  // 真正该守的不变量是"朝向敌方"，与路的形状无关 —— 钉错不变量比不钉更糟：
  // 它会逼着后来的人去"修"一个本来就对的实现。
  for (const f of ['blue', 'red']) {
    const foe = map.buildings.find(b => b.tier === 'nexus_main' && b.faction !== f && b.pos);
    for (const lane of ['top', 'mid', 'bot']) {
      for (const tier of ['outer', 'inner', 'base']) {
        const b = pick(f, lane, tier);
        if (!b) continue;
        const a = towerFacingRad(
          { pos: b.pos, _mapFaction: f, _laneId: lane, _mapTier: tier }, map);
        // 朝向单位向量 · 指向敌方水晶的向量 > 0 → 朝着敌方半场
        const dot = Math.sin(a) * (foe.pos.x - b.pos.x) + Math.cos(a) * (foe.pos.y - b.pos.y);
        T(`向①-${f}/${lane}/${tier}：朝向敌方半场`, dot > 0);
      }
    }
  }
  // ② 同一路同一阵营的塔朝向大体一致（它们在同一段路上）
  //
  // 2026-09-04：原来是 new Set(angs).size===1 的**逐度**相等，能成立纯粹是因为
  // 当时召唤师峡谷上路靠近蓝方基地那几个路点恰好共线（不同塔各自最近的路点段
  // 切线方向凑巧四舍五入到同一个整数度）。跑过 mapEditorCore.js 的
  // alignLaneToCorridor() 把上路路点吸附回走廊中线后（修正用户反馈的"下路兵线
  // 偏上"那类问题），这份共线性被打破——上路 outer/inner/base 三座塔的朝向
  // 变成 -179.98°/-179.98°/-178.83°，肉眼分辨不出的 ~1.15° 差异。
  // 逐度相等本来就是在钉"当时数据恰好共线"这个偶然结果，不是真正该守的不变量
  // ——真正该守的是"同一路的塔看起来朝向一致"，改成允许小容差（同一路内两两
  // 角度差 ≤ 3°），既保住设计意图，又不会把"路点几何被合理校正"的真实改进
  // 錯判成 bug。
  for (const lane of ['top', 'mid', 'bot']) {
    const angs = ['outer', 'inner', 'base'].map(t => pick('blue', lane, t)).filter(Boolean).map(of)
      .filter(a => a !== null);
    const maxDiff = angs.length < 2 ? 0 : Math.max(...angs.flatMap((a, i) =>
      angs.slice(i + 1).map(b => { let d = Math.abs(a - b); if (d > 180) d = 360 - d; return d; })));
    T(`向②-${lane}：蓝方同路各档朝向大体一致（角度：${angs.join('/')}，最大两两差 ${maxDiff.toFixed(2)}° ≤ 3°）`,
      maxDiff <= 3);
  }
  // ③ 三条路的朝向互不相同（不是全都朝同一个方向 —— 那正是改动前的样子）
  T('向③-三条路朝向各不相同（改动前是所有塔一个朝向）',
    new Set(['top', 'mid', 'bot'].map(l => of(pick('blue', l, 'outer')))).size === 3);
  // ⑤ 枢纽塔：在对角线基础上**各自向外**张开
  {
    for (const f of ['blue', 'red']) {
      const hs = map.buildings.filter(b => b.tier === 'hq_tower' && b.faction === f);
      const nx = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const base = deg(towerFacingRad({ pos: nx.pos, _mapFaction: f, _mapTier: 'nexus_main' }, map));
      const angs = hs.map(b => deg(towerFacingRad(
        { pos: b.pos, _mapFaction: f, _laneId: null, _mapTier: 'hq_tower' }, map)));
      T(`向⑤-${f} 两座枢纽塔朝向不同（不是两个复制品）`, angs[0] !== angs[1]);
      T(`向⑥-${f} 两座各自偏在对角线两侧`, (() => {
        const d = angs.map(a => { let x = a - base; while (x > 180) x -= 360; while (x <= -180) x += 360; return x; });
        return Math.sign(d[0]) !== Math.sign(d[1]) && d.every(x => Math.abs(x) > 5);
      })());
      T(`向⑦-${f} 张开角度取自配置 hqSpreadDeg`, (() => {
        const d = angs.map(a => { let x = a - base; while (x > 180) x -= 360; while (x <= -180) x += 360; return Math.abs(x); });
        return d.every(x => Math.abs(x - CONFIG.ui.towerFacing.hqSpreadDeg) <= 1);
      })());
    }
  }
  // ⑥ 开关与翻转（图示方向有歧义，留了一个值可整体翻转）
  T('向⑧-总开关关掉后不定向（返回 null = 保持默认朝向）',
    towerFacingRad({ pos: { x: 0, y: 0 }, _mapFaction: 'blue', _laneId: 'mid' }, map,
                   { enabled: false }) === null);
  T('向⑨-flip 能整体翻转 180°（万一图上的箭头我读反了）', (() => {
    const e = { pos: pick('blue', 'mid', 'outer').pos, _mapFaction: 'blue', _laneId: 'mid', _mapTier: 'outer' };
    const a = deg(towerFacingRad(e, map, { hqSpreadDeg: 25 }));
    const b = deg(towerFacingRad(e, map, { flip: true, hqSpreadDeg: 25 }));
    return Math.abs(Math.abs(((a - b) % 360 + 540) % 360 - 180) - 180) < 1 || Math.abs(a - b) === 180;
  })());
  // ⑦ 非对战单位不定向
  T('向⑩-无阵营塔（正常游戏里不会出现）不定向',
    towerFacingRad({ pos: { x: 0, y: 0 }, _mapFaction: null }, map) === null);

  // ==================== ⑧ 回环路：切线指反时必须退回"朝敌方枢纽" ====================
  // 用户："扭曲丛林的朝向不对，另一阵营同理。"
  //
  // 扭曲丛林两条路的起点和终点是**同一个点**（都是 (584,676)→(2424,676)），
  // 路是绕出去再绕回来的回环。靠近自家基地那几座塔，切线指的是"路在此处的走向"
  // （上/下），跟"敌人在哪边"（右）差了近 90°，屏幕上就是一排塔集体扭着头。
  //
  // 断言钉的是**行为形状**（每座塔都朝敌方半场），不是具体角度 ——
  // 角度会随地图微调而变，"朝向敌人"这条不会。
  // v51.20：summoners_rift_classic_v1 已下线（经典模式改成套在任意地图上的变换，
  // 不再单独注册），而且经典模式对召唤师峡谷不改建筑坐标/朝向——几何断言用
  // summoners_rift_v1 测（第651行 map 常量）已经够了，这里去掉这个 id 不算漏测。
  for (const mid of ['twisted_treeline_v1', 'howling_abyss_v1']) {
    const mm = M3[mid];
    if (!mm) { T(`向⑧-${mid} 地图存在`, false); continue; }
    let bad = 0, n = 0;
    for (const b of mm.buildings || []) {
      if (b.tier === 'nexus_main' || !b.pos) continue;
      const foe2 = (mm.buildings || []).find(x => x.tier === 'nexus_main' && x.faction !== b.faction && x.pos);
      if (!foe2) continue;
      const a = towerFacingRad(
        { pos: b.pos, _mapFaction: b.faction, _laneId: b.laneId, _mapTier: b.tier }, mm);
      if (a === null) continue;
      n++;
      const dot = Math.sin(a) * (foe2.pos.x - b.pos.x) + Math.cos(a) * (foe2.pos.y - b.pos.y);
      if (!(dot > 0)) bad++;
    }
    T(`向⑧-${mid}：全部 ${n} 座塔都朝敌方半场（回环路不再扭头）`, n > 0 && bad === 0);
  }
  // ⑨ 红蓝镜像：扭曲丛林是左右对称图，同路同档两方的角度应互为镜像（x 取反 → 角度取反）
  {
    const tt = M3.twisted_treeline_v1;
    const fa = (b) => towerFacingRad(
      { pos: b.pos, _mapFaction: b.faction, _laneId: b.laneId, _mapTier: b.tier }, tt);
    let checked = 0, ok = true;
    for (const lane of ['top', 'bot']) {
      for (const tier of ['outer', 'base', 'nexus_lane']) {
        const bb = (tt.buildings || []).find(b => b.faction === 'blue' && b.laneId === lane && b.tier === tier);
        const rb = (tt.buildings || []).find(b => b.faction === 'red' && b.laneId === lane && b.tier === tier);
        if (!bb || !rb) continue;
        checked++;
        // 镜像轴是竖直的（x 翻转），朝向角 = atan2(dx, dy) → dx 取反即角度取反
        const d = Math.abs(deg(fa(bb)) + deg(fa(rb)));
        if (d > 1) ok = false;
      }
    }
    T(`向⑨-扭曲丛林红蓝朝向互为镜像（"另一阵营同理"，${checked} 对）`, checked >= 4 && ok);
  }
  // ⑩ 每方只有一座枢纽塔时不张开（对着孤零零一座塔偏 25°，看上去只是"这塔歪了"）
  T('向⑩-单座枢纽塔不张开（张开的意义是两座别摆成一模一样）', (() => {
    const tt = M3.twisted_treeline_v1;
    const hq = (tt.buildings || []).find(b => b.tier === 'hq_tower' && b.faction === 'blue');
    if (!hq) return false;
    const cnt = (tt.buildings || []).filter(b => b.tier === 'hq_tower' && b.faction === 'blue').length;
    if (cnt !== 1) return false;   // 前提变了就该重看这条，而不是让它默默通过
    const foe2 = (tt.buildings || []).find(b => b.tier === 'nexus_main' && b.faction === 'red');
    const want = deg(Math.atan2(foe2.pos.x - hq.pos.x, foe2.pos.y - hq.pos.y));
    const got = deg(towerFacingRad(
      { pos: hq.pos, _mapFaction: 'blue', _laneId: hq.laneId, _mapTier: 'hq_tower' }, tt));
    return Math.abs(got - want) <= 1;
  })());
  // ⑪ 召唤师峡谷**一个角度都不能变**（切线判据只该拦回环路，不该动正常路）
  T('向⑪-召唤师峡谷三路角度不受回环判据影响（top/mid/bot 仍各不相同）', (() => {
    const a = ['top', 'mid', 'bot'].map(l => of(pick('blue', l, 'outer')));
    return new Set(a).size === 3 && a.every(x => x !== null);
  })());

  // 渲染层接线：换模型时必须重赋，否则塔一掉血就转回正北
  const ul3 = srcOf('src/presentation/UnitLayer.js');
  T('向⑪-渲染层每帧都赋朝向（换模型会重置 rotation，只赋一次会转回正北）',
    /if \(en\.faceFixed !== null\) en\.unit\.rotation\.y = en\.faceFixed;/.test(ul3));
  T('向⑫-复用了原有的 faceFixed 字段（它本来是个死字段）',
    /en\.faceFixed = towerFacingRad/.test(ul3));
}

// ==================== 十三、Pct 后缀把四个属性静默丢掉了 ====================
// 平衡对照里"蓝方满 dark 之力"那一档与基线**逐字相同**（胜率/时长/推塔/推进度/熵
// 一个字都不差）—— 与当年光魂那个死功能一模一样的形状，于是顺着查了下去。
//
// 根因：dragonPowerBuffs 与 soulStatBlueprints **各写了一份**同样的约定
//「键名以 Pct 结尾 → 剥掉后缀、按百分比」。这对 attackDamagePct / maxHPPct 是对的，
// 但对**本身就以 Pct 结尾的属性**是灾难：
//     damageAmpPct → damageAmp，lifeStealPct → lifeSteal，
//     bonusAttackSpeedPct → bonusAttackSpeed，healShieldPowerPct → healShieldPower
// 全都不存在，而 AttributeCalculator 对未知键是**静默丢弃**的。
// 后果：暗之力/暗魂的常驻数值整个没生效、风魂的攻速加成没生效、潮龙的治疗强度没生效。
// 尤其讽刺的是我上一轮正是围绕"攻速"重做的风 —— 难怪测不出改善。
{
  const { dragonPowerBuffs } = await import('../src/systems/DragonSystem.js');
  const { soulStatBlueprints } = await import('../src/core/skills/dragonSouls.js');
  const { statMod, resetStatKeyCache } = await import('../src/core/statMod.js');
  resetStatKeyCache();

  // 全部模板属性名的并集 —— 判"这个 statKey 到底存不存在"的权威来源
  const known = new Set();
  for (const tpl of Object.values(CONFIG.templates || {})) {
    if (tpl && typeof tpl === 'object') for (const k of Object.keys(tpl)) known.add(k);
  }
  const ELS = ['fire', 'water', 'earth', 'thunder', 'wind', 'dark', 'poison'];

  T('Pct①-每个元素的【力】里没有一项 statKey 是不存在的属性', (() => {
    const bad = [];
    for (const el of ELS) for (const b of dragonPowerBuffs(el)) if (!known.has(b.statKey)) bad.push(el + '/' + b.statKey);
    if (bad.length) console.log('    未知属性：', bad.join(', '));
    return bad.length === 0;
  })());
  T('Pct②-每个元素的【魂常驻数值】里也没有', (() => {
    const bad = [];
    for (const el of ELS) for (const b of soulStatBlueprints(el)) if (!known.has(b.statKey)) bad.push(el + '/' + b.statKey);
    if (bad.length) console.log('    未知属性：', bad.join(', '));
    return bad.length === 0;
  })());

  // 判据本身：键是真属性 → 固定值；去掉 Pct 才是真属性 → 百分比
  T('Pct③-本身就是属性的键按【固定值】走（damageAmpPct 是个"百分比数值的属性"）',
    statMod('damageAmpPct', 2.5).statKey === 'damageAmpPct'
    && statMod('damageAmpPct', 2.5).flat === 2.5
    && statMod('damageAmpPct', 2.5).percent === 0);
  T('Pct④-去掉 Pct 之后才是属性的键按【百分比】走（attackDamagePct = 攻击力 +x%）',
    statMod('attackDamagePct', 3).statKey === 'attackDamage'
    && statMod('attackDamagePct', 3).percent === 3
    && statMod('attackDamagePct', 3).flat === 0);
  T('Pct⑤-两处共用同一份翻译（原来各写一份，于是同一个错犯了两遍）',
    /statMod\(/.test(srcOf('src/systems/DragonSystem.js'))
    && /statMod\(/.test(srcOf('src/core/skills/dragonSouls.js')));

  // 行为：暗之力装上去之后，伤害增幅**真的**变了（这正是此前一点效果都没有的那一项）
  {
    const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
    const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
    const bus2 = new EventBus(), ents2 = new EntityContainer(bus2), fx2 = new EffectRegistry(bus2);
    const t = mkE(ents2, 'tower', 0, 0, { _mapFaction: 'blue', faction: 'blue' });
    const before = AttributeCalculator.calc(t, fx2.getEffects(t.id));
    for (const b of dragonPowerBuffs('dark')) {
      fx2.apply(t.id, { name: '暗之力', icon: '🌑', kind: 'stat', statKey: b.statKey,
        flatValue: b.flat || 0, percentValue: b.percent || 0,
        duration: Infinity, permanent: true, stackable: false, stackPolicy: 'refresh',
        stackKey: 'test_dark_' + b.statKey }, 'test_dark_' + b.statKey);
    }
    const after = AttributeCalculator.calc(t, fx2.getEffects(t.id));
    T('Pct⑥-暗之力装上后【伤害增幅】真的变了（此前整档与基线逐字相同 = 完全没生效）',
      after.damageAmpPct > before.damageAmpPct);
    T('Pct⑦-暗之力的【生命偷取】同样真的变了',
      after.lifeStealPct > before.lifeStealPct);
  }
}

done();