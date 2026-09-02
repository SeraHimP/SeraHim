/**
 * sim_classic.mjs —— 经典模式验收（v51.20 改版：模式 × 地图两条独立轴）
 *
 * v51.20 用户定稿：地图是框架，模式在框架上做二次修正。经典模式不再是
 * 一张独立注册的地图（原 summoners_rift_classic.js 已下线），改成
 * modeTransforms.js 的 applyClassicMode(baseMap) 变换，三张图都能套。
 * 召唤师峡谷经典模式沿用用户当年给的精确定稿数值；嚎哭深渊/扭曲丛林经典模式
 * 目前是按"召唤师峡谷经典/召唤师峡谷普通"比例套算的近似值（用户原话：
 * "你先弄个差不多的数，后期我填"），这里断言的是"确实按比例缩小了"这个
 * 行为形状，不钉未定稿的具体数字。
 *
 * 这一套仍然刻意**把地图真的载进去、把兵真的生出来**再检查，不只读地图数据。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
window.__towerRules = { invincible: { blue: false, red: false },
                        attackOff: { blue: false, red: false },
                        waveOn: { blue: true, red: true } };
window.__towerRuleFor = (kind, fac) => {
  const r = window.__towerRules[kind];
  return fac ? !!r[fac] : (r.blue || r.red);
};

const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { MODES, applyClassicMode } = await import('../src/data/maps/modeTransforms.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { DragonSystem } = await import('../src/systems/DragonSystem.js');
const { buildWaveOrder } = await import('../src/data/waveComposition.js');

const { T, done } = scoreboard('经典模式验收（模式×地图）');

// ==================== 一、Quick Mode 确实删干净了（沿用旧断言）====================
{
  T('删①-地图列表里没有 Quick Mode 了',
    !Object.keys(MAPS).some(k => /quick/i.test(k))
    && !Object.values(MAPS).some(m => /quick/i.test(m.label || '')));
  T('删②-源码里不再引用它（留着 import 会直接炸）',
    !/summoners_rift_quick/.test(srcOf('src/data/maps/index.js')));
  T('删③-渲染层的主题剥离规则不再提 _quick',
    !/_quick/.test(srcOf('src/presentation/ThreeRenderer.js')));
}

// ==================== 二、地图注册表回到只有三张"真地图"====================
{
  T('注①-summoners_rift_classic 不再单独注册（经典模式不是第四张地图）',
    !('summoners_rift_classic_v1' in MAPS) && Object.keys(MAPS).length === 3);
  T('注②-MapSystem 认得 __/_classic 后缀，能反查回经典模式版本',
    !!(new MapSystem(new EntityContainer(new EventBus()), new EventBus())
      .getMapById('summoners_rift_v1_classic')));
}

// ==================== 三、召唤师峡谷经典模式：精确定稿数值原样保留 ====================
{
  const sr = MAPS.summoners_rift_v1;
  const map = applyClassicMode(sr);
  T('图①-经典模式标签正确', map.label === '召唤师峡谷（经典）');
  T('图②-不生成龙（不声明 dragon 字段，与另两张图同一口径）',
    !map.dragon || map.dragon.enabled !== true);
  const want = {
    outer:    { maxHP: 2250, armor: 70,  magicResist: 70 },
    inner:    { maxHP: 1750, armor: 80,  magicResist: 80 },
    base:     { maxHP: 3150, armor: 90,  magicResist: 90 },
    hq_tower: { maxHP: 2550, armor: 100, magicResist: 100 },
  };
  for (const [tier, w] of Object.entries(want)) {
    const g = map.tierStats[tier];
    T(`图③-${tier} 数值与定稿一致（${w.maxHP}/${w.armor}/${w.magicResist}/1.083）`,
      g.maxHP === w.maxHP && g.armor === w.armor && g.magicResist === w.magicResist
      && g.baseAttackSpeed === 1.083);
  }
  T('图④-塔的攻击力沿用召唤师峡谷原值（用户定稿：没提到的不动）',
    ['outer', 'inner', 'base', 'hq_tower']
      .every(t => map.tierStats[t].attackDamage === sr.tierStats[t].attackDamage));
  T('图⑤-召唤水晶/水晶枢纽血量也沿用原值',
    map.tierStats.nexus_lane.maxHP === sr.tierStats.nexus_lane.maxHP
    && map.tierStats.nexus_main.maxHP === sr.tierStats.nexus_main.maxHP);
  T('图⑥-布局（建筑数量与坐标）与普通模式完全一致（经典模式不改地图几何）',
    map.buildings.length === sr.buildings.length
    && map.buildings.every((b, i) => b.pos.x === sr.buildings[i].pos.x
                                  && b.pos.y === sr.buildings[i].pos.y
                                  && b.tier === sr.buildings[i].tier));
}

// ==================== 四、嚎哭深渊/扭曲丛林经典模式：近似值行为形状 ====================
{
  for (const baseId of ['howling_abyss_v1', 'twisted_treeline_v1']) {
    const base = MAPS[baseId];
    const map = applyClassicMode(base);
    T(`近①-${baseId} 经典模式标签带"（经典）"后缀`, map.label === `${base.label}（经典）`);
    T(`近②-${baseId} 经典模式不生成龙`, !map.dragon || map.dragon.enabled !== true);
    // 行为形状：经典模式的每一层塔耐打面（HP/双抗）都应该比普通模式明显低——
    // 沿用召唤师峡谷经典模式"耐打面砍"这条方向，具体倍数未定稿，只钉方向。
    // 攻速不钉方向：套的是"召唤师峡谷经典/召唤师峡谷普通"这个比例，而 SR 自己
    // 三层塔的比例本来就有正有负（outer 提速、base/hq_tower 降速——因为 v51.18
    // 把 base/hq_tower 的普通攻速改成了 4.00，比经典模式定稿时的 1.083 快很多），
    // 套到 HA/TT 上自然也是有正有负，不是"未定稿数值算错了"。
    let allShrunk = true;
    for (const tier of ['outer', 'base', 'hq_tower']) {
      const n = base.tierStats[tier], c = map.tierStats[tier];
      if (!(c.maxHP < n.maxHP && c.armor < n.armor && c.magicResist < n.magicResist)) allShrunk = false;
    }
    T(`近③-${baseId} 各层塔耐打面（HP/双抗）都比普通模式低（方向正确，数值待定稿）`, allShrunk);
    T(`近④-${baseId} 攻击力沿用该图普通模式原值（未定稿数值不碰这项）`,
      ['outer', 'base', 'hq_tower'].every(t => map.tierStats[t].attackDamage === base.tierStats[t].attackDamage));
    T(`近⑤-${baseId} 召唤水晶/水晶枢纽血量沿用原值（经典模式不改这一层）`,
      map.tierStats.nexus_lane.maxHP === base.tierStats.nexus_lane.maxHP
      && map.tierStats.nexus_main.maxHP === base.tierStats.nexus_main.maxHP);
  }
}

// ==================== 五、载入地图之后：塔（以召唤师峡谷经典模式为样本）====================
const bus = new EventBus();
const ents = new EntityContainer(bus);
const fx = new EffectRegistry(bus);
const ms = new MapSystem(ents, bus);
ms.setEffectRegistry(fx);

// 用与 main.js 同源的装配路径：显式 skills → createBuilding 仍会补回 fortify
const fortifyByTier = {
  outer: 'passive_outer_fortify', inner: 'passive_inner_fortify',
  base: 'passive_base_fortify', hq_tower: 'passive_hq_fortify',
};
ms.setCreateBuildingFn(({ faction, tier, laneId, isNexus, pos, weapon, stats, skills }) => {
  const tpl = CONFIG.templates.tower;
  let list = Array.isArray(skills) ? [...skills] : [];
  if (!isNexus && fortifyByTier[tier] && !list.includes(fortifyByTier[tier])) {
    list.unshift(fortifyByTier[tier]);
  }
  const e = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
    baseStats: { ...tpl, ...(stats || {}) },
    currentHP: (stats && stats.maxHP) ?? tpl.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _inCombat: false, _attackerCount: 0,
    _mapFaction: faction, faction, _mapTier: tier, _laneId: laneId,
  };
  if (weapon) e._skillInstances.push({ id: ++window._uid, skillId: 'weapon_' + weapon, state: {} });
  for (const s of list) e._skillInstances.push({ id: ++window._uid, skillId: s, state: {} });
  ents.add(e);
  return e;
});
// 先选模式再选地图：loadMap(mapId, mode) 是新签名，等价于 UI 里先点"经典模式"卡片
// 再点"召唤师峡谷"卡片。
ms.loadMap('summoners_rift_v1', MODES.classic.id);

{
  T('模①-currentMode/currentBaseMapId 记录正确（UI 高亮靠这两个）',
    ms.currentMode === 'classic' && ms.currentBaseMapId === 'summoners_rift_v1');
  T('模②-currentMap.id 带经典后缀', ms.currentMap.id === 'summoners_rift_v1_classic');

  const towers = ents.getAllTowers(true);
  T('塔①-地图真的载进来了', towers.length > 0);

  const weapons = new Set();
  for (const t of towers) {
    for (const s of t._skillInstances) if (s.skillId.startsWith('weapon_')) weapons.add(s.skillId);
  }
  T('塔②-所有带武器的塔都是穿透型（原图水晶塔/枢纽塔是闪电杖）',
    weapons.size === 1 && weapons.has('weapon_piercing'));

  // 技能只有加固城防
  const nonWeapon = (t) => t._skillInstances.map(s => s.skillId).filter(k => !k.startsWith('weapon_'));
  const bad = [];
  for (const t of towers) {
    const want = fortifyByTier[t._mapTier];
    const got = nonWeapon(t);
    const ok = want ? (got.length === 1 && got[0] === want) : got.length === 0;
    if (!ok) bad.push(`${t._mapTier}:[${got.join(',')}]`);
  }
  if (bad.length) console.log('    不合规的塔：', [...new Set(bad)].join('  '));
  T('塔③-每座塔的技能**只有**自己那层的加固城防（成长/过载/钢铁防线/镀层全没了）',
    bad.length === 0);
  T('塔④-召唤水晶/水晶枢纽一个技能都没有',
    towers.filter(t => t._mapTier === 'nexus_lane' || t._mapTier === 'nexus_main')
          .every(t => t._skillInstances.length === 0));

  // 生命恢复：水晶 1、枢纽 3 —— 由加固城防自带，不用另做
  T('塔⑤-水晶塔的加固城防自带 1 生命恢复（用户说的"通过状态实现"就是它）',
    SkillLibrary.passive_base_fortify.defaultParams.regen === 1);
  T('塔⑥-枢纽塔的加固城防自带 3 生命恢复', SkillLibrary.passive_hq_fortify.defaultParams.regen === 3);
  T('塔⑦-外塔/内塔的加固城防不带恢复（只有生命节点封顶）',
    SkillLibrary.passive_outer_fortify.defaultParams.regen === 0
    && SkillLibrary.passive_inner_fortify.defaultParams.regen === 0);

  // 属性真的落到实体上了
  const pick = (tier) => towers.find(t => t._mapTier === tier);
  for (const [tier, hp] of [['outer', 2250], ['inner', 1750], ['base', 3150], ['hq_tower', 2550]]) {
    const t = pick(tier);
    const st = AttributeCalculator.calc(t, fx.getEffects(t.id));
    T(`塔⑧-${tier} 实体上的血量/攻速真的是 ${hp}/1.083`,
      st.maxHP === hp && Math.abs(st.baseAttackSpeed - 1.083) < 1e-9);
  }
}

// ==================== 六、小兵 ====================
{
  const map = ms.currentMap;
  const passives = map.minionDefaultPassives;
  T('兵①-八个兵种的默认被动全部置空（不只是用得上的四种）',
    ['melee', 'ranged', 'siege', 'super', 'totem', 'warlock', 'corrupt', 'ram']
      .every(t => Array.isArray(passives[t]) && passives[t].length === 0));

  const mt = map.minionTemplates;
  T('兵②-攻击力按定稿抬高：近战 20 / 远程 40 / 炮兵 70',
    mt.melee.attackDamage === 20 && mt.ranged.attackDamage === 40 && mt.siege.attackDamage === 70);
  T('兵③-只改攻击力，血量/移速没顺手动',
    Object.values(mt).every(v => Object.keys(v).length === 1 && 'attackDamage' in v));
  T('兵④-超级兵不改（它本来就没有屠戮，不存在要补偿的问题）',
    !mt.super);

  // 炮兵"中期到 100"：靠既有的波次成长，不需要任何技能
  const g = CONFIG.gameRules;
  const scaleAt = (n) => (1 + (g.attrFixedPerWave || 0) / 100 * n) * Math.pow(1 + (g.attrCompPctPerWave || 0) / 100, n);
  const siegeAt10 = 70 * scaleAt(10);
  T(`兵⑤-炮兵第 10 波约 ${Math.round(siegeAt10)}（用户："中期甚至可以达到 100"），靠波次成长而非技能`,
    siegeAt10 > 90 && siegeAt10 < 115);
}

// ==================== 七、出兵种类 ====================
{
  const map = ms.currentMap;
  const rules = { ...CONFIG.gameRules,
                  spawnEnabled: { ...(CONFIG.gameRules.spawnEnabled || {}), ...map.spawnEnabled } };
  const seen = new Set();
  for (let w = 1; w <= 40; w++) {
    for (const nd of [false, true]) {
      for (const t of buildWaveOrder(w, nd, rules, 'blue', { laneId: 'mid' })) seen.add(t);
    }
  }
  T('出①-40 波内只出现 近战/远程/炮兵/超级兵',
    [...seen].every(t => ['melee', 'ranged', 'siege', 'super'].includes(t)));
  T('出②-四种确实都出现过（不是被一起关掉了）',
    ['melee', 'ranged', 'siege', 'super'].every(t => seen.has(t)));
  T('出③-图腾/术士/蚀骨/攻城车一个都没有',
    !['totem', 'warlock', 'corrupt', 'ram'].some(t => seen.has(t)));

  // 不覆写时行为逐位不变 —— 这条守的是"加通道没改别人"
  const seen2 = new Set();
  for (let w = 1; w <= 40; w++) {
    for (const t of buildWaveOrder(w, false, CONFIG.gameRules, 'blue', { laneId: 'mid' })) seen2.add(t);
  }
  T('出④-没有地图覆写时仍按 CONFIG.gameRules 出兵（其余地图行为不变）',
    seen2.size > 4);
}

// ==================== 八、龙 ====================
{
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  ds.setMapLookup((id) => ms.getMapById(id));
  bus.emit('map:loaded', { mapId: 'summoners_rift_v1_classic' });
  T('龙①-经典模式不自动生成龙', ds.mapAllowsDragon() === false);
  bus.emit('map:loaded', { mapId: 'summoners_rift_v1' });
  T('龙②-换回召唤师峡谷普通模式仍然生成（闸门是按图判的，不是全局关掉）',
    ds.mapAllowsDragon() === true);
}

// ==================== 九、分路选择要跟着地图走（模式不影响分路，沿用普通模式布局）====================
{
  const { mapLaneIds, laneLabel, laneShort, clampLaneId } = await import('../src/ui/laneLabels.js');
  const app = { mapSystem: { currentMap: null } };
  window.__app = app;

  const setMap = (id) => { app.mapSystem.currentMap = MAPS[id]; };

  setMap('summoners_rift_v1');
  T('路①-召唤师峡谷三路', mapLaneIds().join(',') === 'top,mid,bot');
  setMap('twisted_treeline_v1');
  T('路②-扭曲丛林只有两路，**没有中路**（用户报的就是这个）',
    mapLaneIds().join(',') === 'top,bot' && !mapLaneIds().includes('mid'));
  setMap('howling_abyss_v1');
  T('路③-嚎哭深渊只有一路', mapLaneIds().join(',') === 'mid');
  app.mapSystem.currentMap = applyClassicMode(MAPS.summoners_rift_v1);
  T('路④-经典模式三路（沿用召唤师峡谷布局，模式变换不改地图几何）',
    mapLaneIds().join(',') === 'top,mid,bot');

  app.mapSystem.currentMap = null;
  T('路⑤-取不到地图时退回三路（未载入，与改动前默认一致）',
    mapLaneIds().join(',') === 'top,mid,bot');

  // clampLaneId：这是这个 bug **看不见的那一半**
  setMap('twisted_treeline_v1');
  T('路⑥-在峡谷选了"中路"再切扭曲丛林 → 夹回该图第一条路', clampLaneId('mid') === 'top');
  T('路⑦-本图有的路原样保留', clampLaneId('bot') === 'bot');
  setMap('howling_abyss_v1');
  T('路⑧-嚎哭深渊把 top/bot 都夹到 mid',
    clampLaneId('top') === 'mid' && clampLaneId('bot') === 'mid');

  T('路⑨-标签认得出三条路，未登记的自制路 id 原样显示',
    laneLabel('top').includes('上路') && laneShort('mid') === '中路' && laneLabel('jungle') === 'jungle');

  // 两处界面共用同一份实现（原来添加单位窗口写死、出兵编排面板读地图 —— 一处对一处错）
  const uad = srcOf('src/ui/UnitAddDialog.js');
  const pw = srcOf('src/ui/editor/pagesWave.js');
  T('路⑩-添加单位窗口按地图渲染分路，不再写死 top/mid/bot',
    /mapLaneIds\(\)/.test(uad)
    && !/lBtn\('top', '上路'\)/.test(uad)
    && !/\{ top: '上', mid: '中', bot: '下' \}/.test(uad));
  T('路⑪-两处界面都调同一份实现（不是各抄一份）',
    /from '\.\/laneLabels\.js'/.test(uad) && /from '\.\.\/laneLabels\.js'/.test(pw));
  T('路⑫-添加单位窗口在入队时也夹一次（否则会带着不存在的 laneId 生成兵）',
    /clampLaneId\(st\.laneId\)/.test(uad));

  delete window.__app;
}

// ==================== 十、重载当前图（main.js __resetRun 的调用形状）====================
{
  // main.js __resetRun 是 mapSystem.loadMap(mapSystem.currentMap.id) 这种"原样重载"调法——
  // 经典模式下 currentMap.id 带后缀，loadMap 必须自己认出后缀、推出 mode，不能要求
  // 调用方多传参数（main.js 那处调用点故意不改，见 MapSystem.loadMap 头注）。
  ms.loadMap(ms.currentMap.id);
  T('重①-用 currentMap.id 原样重载后模式不丢（还是经典模式）', ms.currentMode === 'classic');
  T('重②-塔属性还是经典模式的数值', ents.getAllTowers(true).find(t => t._mapTier === 'outer').baseStats.maxHP === 2250);

  ms.loadMap('summoners_rift_v1');
  T('重③-显式传普通模式 id（不带 mode 参数）能切回普通模式', ms.currentMode === 'normal');
  ms.loadMap(ms.currentMap.id);
  T('重④-普通模式下原样重载 currentMap.id 也不会误判成经典模式', ms.currentMode === 'normal');
}

done();
