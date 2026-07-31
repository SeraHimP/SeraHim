// 地图几何验收：所有地图共用同一套结构性检查。
//
// 为什么值得单开一套：地图是**纯数据**，错了不会抛异常，只会让对局悄悄变得莫名其妙。
// 本项目已经吃过一次：旧的 midlane_v1 用几何规则算外塔位置算错了，
// 双方外塔越过中线互换了半区 —— 肉眼看画面完全正常，是跑仿真才发现的。
// 所以这里钉的是"一张地图要成立必须满足的几何约束"，新地图加进 MAPS 就自动被检查。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
const { MAPS } = await import('../src/data/maps/index.js');
const { baseCircleCenter } = await import('../src/data/baseCircle.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const TOWER_RANGE = 180;          // TIER_STATS 默认射程
const ATTACK_TIERS = ['outer', 'inner', 'base', 'hq_tower'];

const len = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
/** 点到折线的最短距离（与 MapSystem._nearestOnLane 同一算法） */
function distToLane(wp, x, y) {
  let best = Infinity;
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i], b = wp[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L2));
    best = Math.min(best, Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy)));
  }
  return best;
}
/** 沿折线的弧长位置（取最近投影点处的累计长度） */
function arcAt(wp, x, y) {
  let acc = 0, best = Infinity, bestS = 0;
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i], b = wp[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const L = Math.hypot(vx, vy) || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (L * L)));
    const d = Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy));
    if (d < best) { best = d; bestS = acc + t * L; }
    acc += L;
  }
  return bestS;
}

for (const map of Object.values(MAPS)) {
  const tag = `[${map.label}]`;
  T(`${tag} 声明了 world（相机自适应与边界绘制都依赖它）`,
    map.world && map.world.w > 0 && map.world.h > 0);
  T(`${tag} 至少一条兵线，且每条至少两个路点`,
    map.lanes?.length > 0 && map.lanes.every(l => l.waypoints?.length >= 2));
  T(`${tag} 有建筑`, map.buildings?.length > 0);

  // ---- 双方必须对称：同 tier 同 lane 的建筑数一致 ----
  const count = (f) => {
    const m = {};
    for (const b of map.buildings) if (b.faction === f) m[b.tier + '|' + (b.laneId || '-')] = (m[b.tier + '|' + (b.laneId || '-')] || 0) + 1;
    return m;
  };
  const cb = count('blue'), cr = count('red');
  T(`${tag} 蓝红两方建筑构成完全对称`,
    JSON.stringify(Object.entries(cb).sort()) === JSON.stringify(Object.entries(cr).sort()));
  T(`${tag} 每方恰好一个水晶枢纽`,
    map.buildings.filter(b => b.tier === 'nexus_main' && b.faction === 'blue').length === 1
    && map.buildings.filter(b => b.tier === 'nexus_main' && b.faction === 'red').length === 1);

  // ---- 基地圈必须罩住这一方的水晶枢纽 ----
  // 圆心默认取世界角点，那只是峡谷/深渊的巧合。扭曲丛林的基地在左右两侧【中点】，
  // 不声明 baseCenters 的话基地圈会被甩到地图角落的空地上：光环画错地方、
  // 高地地形长在空地上、基地自己反倒没有开阔地 —— 而且不会抛任何异常。
  // 只对【走廊模型】地图成立：navgrid 地图（嚎哭深渊/扭曲丛林）没有基地圈这个概念。
  if (!map.useNavgrid) {
    for (const f of ['blue', 'red']) {
      const c = baseCircleCenter(map, f);
      const nx = map.buildings.find(b => b.tier === 'nexus_main' && b.faction === f);
      const R = map.baseOpenRadius ?? map.baseCircleRadius ?? 0;
      T(`${tag} ${f} 基地圈罩住自家水晶枢纽（圈心距枢纽 ${len(c, nx.pos).toFixed(0)} < ${R}）`,
        len(c, nx.pos) < R);
    }
  }

  // ---- 所有建筑必须在世界范围内 ----
  T(`${tag} 所有建筑都在世界范围内`,
    map.buildings.every(b => b.pos.x >= 0 && b.pos.x <= map.world.w && b.pos.y >= 0 && b.pos.y <= map.world.h));

  // ---- 分路建筑必须真的在它那条路上（走廊半宽之内）----
  // 不满足的话塔会立在墙里：小兵打不到它、它却能打小兵，而且画面上看不出异常。
  const hw = map.walls?.corridorHalfWidth;
  if (hw && !map.useNavgrid) {
    let offLane = [];
    for (const b of map.buildings) {
      if (!b.laneId) continue;
      const lane = map.lanes.find(l => l.id === b.laneId);
      if (!lane) { offLane.push(`${b.tier}(找不到路 ${b.laneId})`); continue; }
      const d = distToLane(lane.waypoints, b.pos.x, b.pos.y);
      // 基地圈内的建筑（枢纽塔等）本来就可以离兵线远，走廊之外由基地圈兜底
      const nx = map.buildings.find(x => x.tier === 'nexus_main' && x.faction === b.faction);
      const inBase = nx && len(nx.pos, b.pos) <= (map.baseOpenRadius ?? 0);
      if (d > hw && !inBase) offLane.push(`${b.faction}/${b.tier}/${b.laneId} 离线 ${d.toFixed(0)} > ${hw}`);
    }
    T(`${tag} 分路建筑都在走廊或基地圈内（不会立在墙里）${offLane.length ? '：' + offLane.join('；') : ''}`,
      offLane.length === 0);
  }

  // ---- 同一方同一路上，相邻【攻击塔】的射程圈不重叠 ----
  // 本项目一贯要求（见各地图注释）：间距 > 2×射程，否则两塔一起打同一个点，
  // 推进节奏会突然变得极难，而且看起来只是"这里怎么这么难推"。
  for (const lane of map.lanes) {
    for (const f of ['blue', 'red']) {
      const ts = map.buildings
        .filter(b => b.faction === f && b.laneId === lane.id && ATTACK_TIERS.includes(b.tier))
        .map(b => ({ tier: b.tier, s: arcAt(lane.waypoints, b.pos.x, b.pos.y), pos: b.pos }))
        .sort((a, b2) => a.s - b2.s);
      for (let i = 0; i + 1 < ts.length; i++) {
        // 同档位的两座塔是**刻意成对**的（枢纽双塔各在兵线一侧护水晶），
        // 峡谷的注释里明写着"双塔间距≈115 < 射程180（贴打一塔另一塔够得着）"——
        // 那是设计，不是缺陷。间距规则只管【不同档位之间】。
        if (ts[i].tier === ts[i + 1].tier) continue;
        const gap = len(ts[i].pos, ts[i + 1].pos);
        T(`${tag} ${f}/${lane.id} ${ts[i].tier}→${ts[i + 1].tier} 射程圈不重叠（实距 ${gap.toFixed(0)} > ${2 * TOWER_RANGE}）`,
          gap > 2 * TOWER_RANGE);
      }
    }
  }

  // ---- 双方外塔不能越过中线（旧 midlane_v1 就死在这条上）----
  for (const lane of map.lanes) {
    const total = lane.waypoints.reduce((s, p, i) => i ? s + len(lane.waypoints[i - 1], p) : 0, 0);
    const bo = map.buildings.find(b => b.faction === 'blue' && b.laneId === lane.id && b.tier === 'outer');
    const ro = map.buildings.find(b => b.faction === 'red' && b.laneId === lane.id && b.tier === 'outer');
    if (bo && ro) {
      const sb = arcAt(lane.waypoints, bo.pos.x, bo.pos.y);
      const sr = arcAt(lane.waypoints, ro.pos.x, ro.pos.y);
      T(`${tag} ${lane.id} 双方外塔各在自己半区（蓝 ${sb.toFixed(0)} < 红 ${sr.toFixed(0)}，全长 ${total.toFixed(0)}）`,
        sb < total / 2 && sr > total / 2);
      T(`${tag} ${lane.id} 中间留有战斗区（双方外塔净空 ${(sr - sb).toFixed(0)} > 400）`, sr - sb > 400);
    }
  }
}

// ==================== 两张新/重做的图，各自的专项 ====================
{
  const ha = MAPS['howling_abyss_v1'];
  T('[嚎哭深渊] 是单路', ha.lanes.length === 1);
  // 地形按标准小地图逐像素重描（navgrid）。用户原话：
  // "真正的嚎哭深渊两端有那个圆吗？？难道不是变成更宽的桥了吗？？"
  // ——**没有圆**。走廊模型（折线+半宽+基地圆）结构上就画不出"等宽直桥+两端变宽"。
  T('[嚎哭深渊] 用 navgrid 描图，不再有走廊/基地圈',
    ha.useNavgrid && !!ha.navgrid && ha.walls?.corridorHalfWidth === undefined
    && ha.baseCircleRadius === undefined && ha.baseOpenRadius === undefined);
  T('[嚎哭深渊] 世界是正方形（采样矩形 510×510，长宽比不一致就会整张图拉伸）',
    ha.world.w === ha.world.h);
  T('[嚎哭深渊] 桥两侧声明了缺口障碍', (ha.obstacles || []).length >= 20);
  {
    // 桥必须是笔直的一条：所有建筑都落在同一条反对角线 x+y=2325 附近
    const off = ha.buildings.map(b => Math.abs(b.pos.x + b.pos.y - 2325));
    T(`[嚎哭深渊] 建筑都贴在桥心线 x+y=2325 上（最大偏离 ${Math.max(...off).toFixed(0)} < 90）`,
      Math.max(...off) < 90);
  }

  const tt = MAPS['twisted_treeline_v1'];
  // 真实可走判定（navgrid），供下面的地形厚度断言使用
  const { EntityContainer: _EC } = await import('../src/core/EntityContainer.js');
  const { EventBus: _EB } = await import('../src/utils/EventBus.js');
  const { MapSystem: _MS } = await import('../src/systems/MapSystem.js');
  const _bus = new _EB(), _ents = new _EC(_bus), _ms = new _MS(_ents, _bus);
  _ms.setCreateBuildingFn(() => null); _ms.loadMap('twisted_treeline_v1');
  const walkTT = (x, y) => _ms.isWalkable(x, y);
  T('[扭曲丛林] 是双路（上/下）', tt.lanes.length === 2
    && tt.lanes.map(l => l.id).sort().join() === 'bot,top');
  // 用户确认的塔位：每路 2 塔 + 每路 1 召唤水晶 + 1 枢纽塔 + 水晶枢纽
  const bb = tt.buildings.filter(b => b.faction === 'blue');
  T('[扭曲丛林] 每方 5 座会攻击的建筑（上下路各 2 + 枢纽塔 1）',
    bb.filter(b => ATTACK_TIERS.includes(b.tier)).length === 5);
  T('[扭曲丛林] 每路各 2 塔',
    ['top', 'bot'].every(l => bb.filter(b => b.laneId === l && ATTACK_TIERS.includes(b.tier)).length === 2));
  T('[扭曲丛林] 每路各 1 个召唤水晶',
    ['top', 'bot'].every(l => bb.filter(b => b.laneId === l && b.tier === 'nexus_lane').length === 1));
  T('[扭曲丛林] 恰好 1 座枢纽塔', bb.filter(b => b.tier === 'hq_tower').length === 1);
  // 本图是【左右镜像】而不是中心对称 —— 写错的话红方整个上下颠倒，且不会报错
  const mirrorOk = bb.every(b => tt.buildings.some(r =>
    r.faction === 'red' && r.tier === b.tier && r.laneId === b.laneId
    && Math.abs(r.pos.x - (tt.world.w - b.pos.x)) < 2 && Math.abs(r.pos.y - b.pos.y) < 2));
  T('[扭曲丛林] 红方是蓝方的【左右镜像】（不是 180° 旋转）', mirrorOk);
  // 形状：**花生/沙漏**——两端（基地叶）宽、腰部（地图中间）窄。
  // 第一版做反了，写成了"从基地鼓出、中间最宽"的柳叶眼形：中间本该是狭窄的遭遇战区，
  // 结果成了全图最开阔的地方，整张图的推进节奏全错，而画面上只是"看着不太像"。
  {
    const wpTop = tt.lanes.find(l => l.id === 'top').waypoints;
    const cy = tt.world.h / 2;
    const offAt = (x) => {   // 兵线在给定 x 处到中轴的距离
      let best = Infinity, bo = 0;
      for (const p of wpTop) if (Math.abs(p.x - x) < best) { best = Math.abs(p.x - x); bo = Math.abs(cy - p.y); }
      return bo;
    };
    // 花生形改钉【地形本身】而不是兵线：兵线要绕开中间那块大草丛，
    // 已经不能代表地图轮廓了（改 navgrid 后上路在腰部被顶到很上面）。
    // 这里直接量可走区的上下厚度：基地端应当明显厚于腰部。
    // 量【外轮廓高度】（第一行到最后一行可走），不是可走格计数 ——
    // 计数会把中间那些草丛的面积一起扣掉，腰部和基地端就都被扣，差异被抹平。
    const thick = (wx) => {
      let lo = -1, hi = -1;
      for (let wy = 0; wy < tt.world.h; wy += 2) if (walkTT(wx, wy)) { if (lo < 0) lo = wy; hi = wy; }
      return lo < 0 ? 0 : hi - lo;
    };
    const nearBase = thick(700), waist = thick(tt.world.w / 2);
    T(`[扭曲丛林] 腰部比基地端窄（花生形：基地端 ${nearBase} > 腰部 ${waist}）`,
      nearBase > waist * 1.10);
    T('[扭曲丛林] 长宽比接近小地图的 2.14（不是方形）',
      Math.abs(tt.world.w / tt.world.h - 2.14) < 0.15);
    T('[扭曲丛林] 用 navgrid 描图（走廊模型画不出野区草丛）',
      tt.useNavgrid && !!tt.navgrid && tt.walls?.corridorHalfWidth === undefined);
    T('[扭曲丛林] 长宽比 = 采样矩形 752×347（不拉伸）',
      Math.abs(tt.world.w / tt.world.h - 752 / 347) < 0.01);
    const hq = bb.find(b => b.tier === 'hq_tower'), nxm = bb.find(b => b.tier === 'nexus_main');
    T(`[扭曲丛林] 唯一的枢纽塔护得住水晶枢纽（间距 ${len(hq.pos, nxm.pos).toFixed(0)} < 射程 ${TOWER_RANGE}）`,
      len(hq.pos, nxm.pos) < TOWER_RANGE);
    // 用户："枢纽塔的位置靠着水晶枢纽（蓝方在左，红方在右）"——从小地图上直接读的像素位置。
    T(`[扭曲丛林] 蓝方枢纽塔在水晶枢纽【左】侧（${hq.pos.x} < ${nxm.pos.x}）`, hq.pos.x < nxm.pos.x);
    const rHq = tt.buildings.find(b => b.faction === 'red' && b.tier === 'hq_tower');
    const rNx = tt.buildings.find(b => b.faction === 'red' && b.tier === 'nexus_main');
    T(`[扭曲丛林] 红方枢纽塔在水晶枢纽【右】侧（${rHq.pos.x} > ${rNx.pos.x}）`, rHq.pos.x > rNx.pos.x);
  }
}

// ==================== 塔数值与成长（不能只看地图数据，要看战斗里真的读到了） ====================
// 「地图声明了覆写但战斗里没生效」是本项目反复出现的症状（编辑器写 A、运行时读 B）。
// 扭曲丛林要求"只有攻击力成长、从开局起算"，靠的是 skillOverrides 把峡谷成长技能的
// adStartT 覆写成 0。光断言地图里写了 0 没用 —— 得让塔真的跑一段时间，看攻击力有没有涨。
{
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');

  const tt = MAPS['twisted_treeline_v1'];
  // 用户指定的数值（改了这里就要同步改地图，反之亦然）
  const WANT = {
    outer:      { maxHP: 1750, armor: 100, magicResist: 100, baseAttackSpeed: 0.833, healthRegen: 0 },
    base:       { maxHP: 2250, armor: 100, magicResist: 100, baseAttackSpeed: 1.25,  healthRegen: 0 },
    hq_tower:   { maxHP: 3750, armor: 100, magicResist: 100, baseAttackSpeed: 2.50,  healthRegen: 10 },
    nexus_lane: { maxHP: 4000, armor: 20,  magicResist: 0,   healthRegen: 10 },
    nexus_main: { maxHP: 5500, armor: 0,   magicResist: 0,   healthRegen: 10 },
  };
  for (const [tier, want] of Object.entries(WANT)) {
    const got = tt.tierStats[tier] || {};
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${got[k]}≠${v}`);
    T(`[扭曲丛林] ${tier} 数值符合指定${bad.length ? '：' + bad.join('，') : ''}`, bad.length === 0);
  }
  // 召唤水晶/水晶枢纽两张新图共用同一组数值
  const ha = MAPS['howling_abyss_v1'];
  for (const tier of ['nexus_lane', 'nexus_main']) {
    T(`[两张新图] ${tier} 数值一致（共享属性）`,
      ['maxHP', 'armor', 'magicResist', 'healthRegen'].every(k => ha.tierStats[tier][k] === tt.tierStats[tier][k]));
  }
  T('[两张新图] 所有会攻击的建筑都是穿透型子弹',
    [ha, tt].every(m => m.buildings.filter(b => b.weapon !== null).every(b => b.weapon === 'piercing')));

  // ---- 成长：跑真实战斗，看攻击力有没有在第 1 分钟就涨 ----
  // 判别点选得刻意：峡谷外塔的 adStartT=40，跑到 90s 只有 floor((90-40)/60)=0 层；
  // 覆写成 0 之后是 floor(90/60)=1 层（+9）。所以"90 秒后涨了 9 点"能唯一区分覆写有没有生效。
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus);
  // 简化版建筑工厂：只做 main.js createBuilding 里与本条断言相关的那部分——
  // 按地图声明的 skills 挂技能实例并 onEquip。武器/身份技能等与成长无关，不复制。
  ms.setCreateBuildingFn((b) => {
    const e = {
      id: ++window._uid, type: 'tower', alive: true, pos: { ...b.pos },
      baseStats: { ...CONFIG.templates.tower, ...b.stats }, currentHP: b.stats.maxHP,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, faction: b.faction,
      _mapFaction: b.faction, _mapTier: b.tier, _laneId: b.laneId,
      _skillInstances: [], _skills: b.skills,
    };
    const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: bus, waveNumber: 0 };
    for (const sid of (b.skills || [])) {
      const inst = { id: ++window._uid, skillId: sid, state: {} };
      e._skillInstances.push(inst);
      SkillLibrary[sid]?.onEquip?.(e.id, inst, ctx);
    }
    ents.add(e); return e;
  });
  window.gameTime = 0;
  ms.loadMap('twisted_treeline_v1');
  const tower = ents.getAll(true).find(e => e._mapTier === 'outer' && e._mapFaction === 'blue');
  T('[扭曲丛林] 外塔挂上了成长技能', !!tower && (tower._skills || []).includes('passive_growth_outer'));
  const ad0 = tower.baseStats.attackDamage;
  const dt = 1 / 30;
  for (let t = 0; t < 90; t += dt) { window.gameTime = t; combat.update(dt); }
  window.gameTime = 90; combat.update(dt);
  const gain = fx.getEffects(tower.id)
    .filter(e => e.blueprint?.statKey === 'attackDamage')
    .reduce((s, e) => s + (e.blueprint.flatValue || 0), 0);
  T(`[扭曲丛林] 成长从开局起算：90 秒时攻击力已 +${gain}（峡谷原设定此时还是 +0）`, gain === 9);
  T('[扭曲丛林] 成长只长攻击力，不长双抗（用户指定）',
    fx.getEffects(tower.id).every(e => !['armor', 'magicResist'].includes(e.blueprint?.statKey)));
  T(`[扭曲丛林] 起步攻击力与峡谷同档一致（${ad0}）`, ad0 === 152);
}

// ==================== 切地图必须把上一张图的建筑真删掉 ====================
// 用户报的"切换地图后会残余其他地图的防御塔废墟"。
// 根因不在地图数据，在实体生命周期：purgeDead 为了满足"死亡的塔也应该能被选中"，
// 改成了【任何塔死后都留成废墟(_ruin)而不删除】。而 clearCurrentMap 一直沿用
// "alive=false 然后 purgeDead()"这套老写法收尸 —— 于是切图时一座塔都删不掉。
// 实测峡谷→扭曲丛林：容器里 46 座塔而不是 16 座，8 座旧废墟落在新图可视范围内。
// 同一个坑此前以 _respawnAt 的形态出过一次，_ruin 是第二扇门 —— 所以这里钉死它。
{
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { MapSystem } = await import('../src/systems/MapSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');
  const ids = Object.keys(MAPS);
  for (let i = 0; i < ids.length; i++) {
    const from = ids[i], to = ids[(i + 1) % ids.length];
    if (from === to) continue;
    const bus = new EventBus(), ents = new EntityContainer(bus);
    const ms = new MapSystem(ents, bus);
    ms.setCreateBuildingFn(({ faction, tier, laneId, pos, stats }) => {
      const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
        baseStats: { ...CONFIG.templates.tower, ...(stats || {}) }, currentHP: 1,
        shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
        targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier,
        _laneId: laneId || null, faction };
      ents.add(e); return e;
    });
    window.gameTime = 0;
    ms.loadMap(from);
    ms.loadMap(to);
    const towers = ents.getAllTowers(false);   // false = 连废墟一起数
    const want = MAPS[to].buildings.length;
    T(`${from} → ${to} 切图后只剩新图的建筑（${towers.length} 座，应为 ${want}）`, towers.length === want);
    T(`${from} → ${to} 没有残留废墟`, towers.every(t => !t._ruin && t.alive));
  }
}

console.log(`地图几何验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
