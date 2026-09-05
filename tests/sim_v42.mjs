// v42 验收：塔成长时序 / 结构保护按地图推导 / 扭曲丛林兵线净空 / 屠戮新基数 /
//            塔数值 / 残弹落点高度 / 删狙击型 / 天气可视化
//
// 这一套里有三条是"改动前就错着、只是没人看出来"的时序或口径 bug，
// 各自都配了**反证**（把修复摘掉，断言必须当场红）。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const attr = AttributeCalculator;

// 建一座塔（含身份技能与传入的被动），与 main.js 的 createBuilding 同口径
function mkWorld() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  const ms = new MapSystem(ents, bus); ms.setEffectRegistry(fx);
  ms.setCreateBuildingFn(({ faction, tier, laneId, isNexus, pos, weapon, stats, skills }) => {
    const tpl = CONFIG.templates.tower, s = { ...(stats || {}) };
    const e = { id: ++window._uid, type: 'tower', alive: true, pos: { x: pos.x, y: pos.y },
      baseStats: { ...tpl, ...s, attackRange: s.attackRange ?? tpl.attackRange },
      currentHP: s.maxHP ?? tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0,
      lastDamageTime: -Infinity, attackCooldown: 0, targetId: null, _skillInstances: [],
      _inCombat: false, _attackerCount: 0, _mapFaction: faction, _mapTier: tier,
      _laneId: laneId || null, faction };
    const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: bus, waveNumber: 0, attrCalc: attr };
    const growthByTier = { outer: 'passive_growth_outer', inner: 'passive_growth_inner',
                           base: 'passive_growth_base', hq_tower: 'passive_growth_hq' };
    const list = Array.isArray(skills) ? [...skills]
               : (!isNexus && growthByTier[tier] ? [growthByTier[tier]] : []);
    for (const k of list) {
      const inst = { id: ++window._uid, skillId: k, state: {} };
      e._skillInstances.push(inst);
      SkillLibrary[k]?.onEquip?.(e.id, inst, ctx);
    }
    ents.add(e); return e;
  });
  return { bus, ents, fx, combat, ms };
}

// ==================== 一、塔成长：时钟归零必须早于建筑创建 ====================
// 用户："目前所有地图的塔都不会正常成长！有技能但是无状态栏显示的属性加成
//        并且根本没有实际的加成！"
// 根因（量出来的）：成长被动在 onEquip 里记 `t0 = window.gameTime`，
// 而 `CTX.gameTime = 0` 原来只挂在 map:loaded —— 那是 loadMap 的**最后一行**，
// 建筑早就创建完了。玩家在沙盒/菜单里待了多久，成长就被推迟多久
// （elapsed = max(0, gameTime − t0)，要等时钟重新爬回 t0 才开始走）。
// 实测：载图时 gameTime=300，跑满 15 分钟只长到 9 层（正常 14 层）；
// 待得越久越像"完全不长"，切第二张图必中。
{
  const run = (preload, seconds, map = 'twisted_treeline_v1') => {
    const W = mkWorld();
    let zeroed = false;
    W.bus.on('map:loading', () => { window.gameTime = 0; zeroed = true; });
    window.gameTime = preload;
    W.ms.loadMap(map);
    const DT = 1 / 30;
    for (let i = 0; i < seconds / DT; i++) {
      window.gameTime = i * DT; W.combat.update(DT); W.fx.update(DT); attr.tick();
    }
    const t = W.ents.getAllTowers(true).find(x => x._mapTier === 'outer');
    return { ad: attr.calc(t, W.fx.getEffects(t.id)).attackDamage, zeroed };
  };
  T('MapSystem 在【创建建筑之前】发 map:loading',
    /this\.eventBus\.emit\('map:loading'[\s\S]{0,200}if \(this\.createBuildingFn\)/
      .test(fs.readFileSync('src/systems/MapSystem.js', 'utf8')));
  T('main.js 在 map:loading 里把时钟归零（而不是只在 map:loaded）',
    /eventBus\.on\('map:loading', \(\) => \{[\s\S]{0,200}CTX\.gameTime = 0;/
      .test(fs.readFileSync('src/main.js', 'utf8')));

  const fresh = run(0, 900);
  const dirty = run(300, 900);   // 复刻"玩家先待了 5 分钟再切图"
  T(`开局即载图：15 分钟后外塔 AD = ${fresh.ad.toFixed(0)}（152 + 14×9 = 278）`,
    Math.abs(fresh.ad - 278) < 1);
  T(`先待 300 秒再载图，成长结果**一模一样**（${dirty.ad.toFixed(0)}）—— 时序 bug 已修`,
    Math.abs(dirty.ad - fresh.ad) < 1e-6);

  // 自愈：即使有人绕开 map:loading 直接把时钟往回拨，成长也不该卡死
  T('成长被动带时钟回退自愈（t0 比现在还晚就重锚）',
    /if \(\(window\.gameTime \|\| 0\) < \(instance\.state\.t0 \|\| 0\)\)/
      .test(fs.readFileSync('src/core/skills/towerPassives.js', 'utf8')));
  {
    const W = mkWorld();
    window.gameTime = 600;
    W.ms.loadMap('twisted_treeline_v1');     // 故意不发 map:loading，t0 记成 600
    window.gameTime = 0;                      // 外部把时钟拨回去
    const DT = 1 / 30;
    for (let i = 0; i < 900 / DT; i++) { window.gameTime = i * DT; W.combat.update(DT); W.fx.update(DT); attr.tick(); }
    const t = W.ents.getAllTowers(true).find(x => x._mapTier === 'outer');
    const ad = attr.calc(t, W.fx.getEffects(t.id)).attackDamage;
    T(`时钟被外部拨回后仍正常成长（AD ${ad.toFixed(0)}，自愈生效）`, Math.abs(ad - 278) < 1);
  }
}

// ==================== 二、结构保护：按地图【实际存在】的层级推导 ====================
// 用户："扭曲丛林/嚎哭深渊中结构保护有错误，只有召唤水晶/枢纽塔/水晶枢纽生效，
//        外/内/水晶塔不生效。"
// 根因：原来的保护链是写死的一对一（水晶塔的保护者固定是"内塔"），
// 而这两张图**根本没有内塔** → 水晶塔从开局就是裸的。
{
  const src = fs.readFileSync('src/systems/FactionSystem.js', 'utf8');
  T('保护链是一张有序表，不是写死的 switch 分支', /const LANE_CHAIN = \['outer', 'inner', 'base', 'nexus_lane'\]/.test(src));
  // v43（Q3 定稿 B）：规则从"只看紧邻的那个存在的前置层"改成"任意前置层还活着即受保护"。
  // 于是 tierExists 这个辅助函数没了存在意义（缺层天然就是"一个活的都没有"），一并删除。
  // 这两条断言随之改口径：钉的是"往前扫全部层级、任意一层活着就 return true"。
  T('保护链往前扫【全部】前置层级，不是只看紧邻的一层',
    /for \(let i = idx - 1; i >= 0; i--\) \{\s*if \(aliveTier\(LANE_CHAIN\[i\], target\._laneId\)\) return true;/.test(src.replace(/\r\n/g, '\n')));
  // ⚠️ 不能直接 !src.includes('tierExists')：源码的说明注释里就写着这个名字，
  // 会把自己的解释文字当成"函数还在"（本仓库栽过好几次的自触发陷阱）。钉定义式。
  T('tierExists 辅助函数已删除（规则 B 下不再需要"这张图有没有这一层"这一步）',
    !/const tierExists\s*=/.test(src));

  const probe = (mapId) => {
    const W = mkWorld();
    W.ms.loadMap(mapId);
    const blue = W.ents.getAllTowers(false).filter(t => t._mapFaction === 'blue');
    const lane = blue.find(t => t._mapTier === 'outer')?._laneId;
    const of = (tier) => blue.find(t => t._mapTier === tier && (t._laneId === lane || t._laneId == null));
    return { W, of, tiers: new Set(blue.map(t => t._mapTier)) };
  };
  for (const mapId of ['twisted_treeline_v1', 'howling_abyss_v1']) {
    const p = probe(mapId);
    T(`[${mapId}] 确实没有内塔（这正是原实现踩空的地方）`, !p.tiers.has('inner'));
    T(`[${mapId}] 开局水晶塔受保护（改动前是裸的）`, isStructureProtected(p.W.ents, p.of('base')) === true);
    T(`[${mapId}] 开局外塔不受保护（最前排，本来就没保护者）`,
      isStructureProtected(p.W.ents, p.of('outer')) === false);
    p.of('outer').alive = false;
    T(`[${mapId}] 外塔一掉，水晶塔立刻暴露`, isStructureProtected(p.W.ents, p.of('base')) === false);
  }
  // 召唤师峡谷三层齐全 —— 行为必须与改动前逐位一致（内塔活着就由内塔保护）
  {
    const p = probe('summoners_rift_v1');
    T('[峡谷] 三层齐全', p.tiers.has('inner'));
    T('[峡谷] 水晶塔由【内塔】保护（不是跳到外塔）', isStructureProtected(p.W.ents, p.of('base')) === true);
    p.of('outer').alive = false;
    T('[峡谷] 只掉外塔时水晶塔仍受保护（内塔还在）', isStructureProtected(p.W.ents, p.of('base')) === true);
    p.of('inner').alive = false;
    T('[峡谷] 内塔也掉了才暴露', isStructureProtected(p.W.ents, p.of('base')) === false);
  }
}

// ==================== 三、扭曲丛林兵线：高地进出口不许贴着墙 ====================
// 用户："扭曲丛林中的小兵路线（高地那里贴地形太近了，特别容易卡小兵）"，并画了参考线。
// 量法：沿兵线密集采样，量每点到最近【不可走格】的距离（净空）。
// 改动前上路高地北口只有 36px、下路南口最窄 12px，而小兵半径 10、队形横向间距 20~30
// —— 12px 连一个兵都过不去。其余路段是 72~144px，也就是那两段只有别处的 1/3。
{
  const W = mkWorld();
  W.ms.loadMap('twisted_treeline_v1');
  const clear = (x, y) => {
    for (let r = 6; r <= 200; r += 6) {
      for (let k = 0; k < 20; k++) {
        const th = k / 20 * Math.PI * 2;
        if (!W.ms.isWalkable(x + Math.cos(th) * r, y + Math.sin(th) * r)) return r;
      }
    }
    return 200;
  };
  // 只看【高地那一段】—— 用户点名的就是那里。范围取高地圆（满高 420 + 坡 140 = 560），
  // 与 map.highground 同源，不另拍一个半径。中路段（x 700~1000）本来就是 60~90px，
  // 那是地形本身的宽度、本次没动，混进来只会把门限压到没有意义。
  const NEXUS = { x: 584, y: 676 };
  // 半径取高地的【满高半径】而不是满高+坡：坡外那一段（x 700~1000）的 60~90px
  // 是地形本身的宽度、本次一个点都没动，混进来只会把门限压到没有意义。
  const HG = MAPS['twisted_treeline_v1'].highground;
  const R = HG.blue.full || 420;
  for (const lane of MAPS['twisted_treeline_v1'].lanes) {
    let worst = 999, at = null;
    const w = lane.waypoints;
    for (let i = 0; i < w.length - 1; i++) {
      const a = w[i], b = w[i + 1];
      // 按【整段】取舍：段中点落在高地圆内就算基地段
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (Math.hypot(mx - NEXUS.x, my - NEXUS.y) > R) continue;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= L; t += 12) {
        const x = a.x + (b.x - a.x) * t / L, y = a.y + (b.y - a.y) * t / L;
        const c = clear(x, y);
        if (c < worst) { worst = c; at = { x: Math.round(x), y: Math.round(y) }; }
      }
    }
    T(`[扭曲丛林/${lane.id}] 高地段净空 ${worst}px @(${at?.x},${at?.y}) ≥ 80（旧值上路 36 / 下路 12）`,
      worst >= 80);
    // 顺带守一条回归：重描不许把【别处】弄得更窄。全线最小净空必须仍 ≥ 60
    //（60 是中路段地形本身的宽度，改动前后都是这个数）。
    let whole = 999;
    for (let i = 0; i < w.length - 1; i++) {
      const a = w[i], b = w[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= L; t += 12) whole = Math.min(whole, clear(a.x + (b.x - a.x) * t / L, a.y + (b.y - a.y) * t / L));
    }
    T(`[扭曲丛林/${lane.id}] 全线最小净空 ${whole}px ≥ 60（重描没把别处弄窄）`, whole >= 60);
  }
  // 兵线改了，但塔位不该跟着漂：外塔按弧长取点，弧长重锚过（1010 → 1106）
  const outers = MAPS['twisted_treeline_v1'].buildings.filter(b => b.tier === 'outer' && b.faction === 'blue');
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const top = outers.find(b => b.laneId === 'top'), bot = outers.find(b => b.laneId === 'bot');
  T(`外塔仍停在原处：上路(${top.pos.x},${top.pos.y}) 距旧位 ${near(top.pos, { x: 1085, y: 328 }).toFixed(0)}px < 5`,
    near(top.pos, { x: 1085, y: 328 }) < 5);
  T(`外塔仍停在原处：下路(${bot.pos.x},${bot.pos.y}) 距旧位 ${near(bot.pos, { x: 1128, y: 1117 }).toFixed(0)}px < 5`,
    near(bot.pos, { x: 1128, y: 1117 }) < 5);
  // 转角仍在可过范围内（sim_pathcorner 那条 70° 上限的同源约束）
  const maxTurn = Math.max(...MAPS['twisted_treeline_v1'].lanes.flatMap((l) => {
    const w = l.waypoints, out = [];
    for (let i = 1; i < w.length - 1; i++) {
      const a = { x: w[i].x - w[i - 1].x, y: w[i].y - w[i - 1].y };
      const b = { x: w[i + 1].x - w[i].x, y: w[i + 1].y - w[i].y };
      out.push(Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) * 180 / Math.PI);
    }
    return out;
  }));
  T(`重描后最大转角 ${maxTurn.toFixed(0)}° < 70°`, maxTurn < 70);
}

// ==================== 四、塔数值（用户本轮指定）====================
{
  const tt = MAPS['twisted_treeline_v1'].tierStats;
  T('[扭曲丛林] 水晶塔双抗 125', tt.base.armor === 125 && tt.base.magicResist === 125);
  T('[扭曲丛林] 枢纽塔双抗 200', tt.hq_tower.armor === 200 && tt.hq_tower.magicResist === 200);
  const ha = MAPS['howling_abyss_v1'].tierStats;
  T('[嚎哭深渊] 水晶塔 HP 5100', ha.base.maxHP === 5100);
  T('[嚎哭深渊] 枢纽塔 HP 4750', ha.hq_tower.maxHP === 4750);
}

// ==================== 五、屠戮：模板基础生命 × 当前血量比例 × XX% ====================
// 用户定稿："以当前生命值的百分比的基础生命值×XX%"。
// 这一版同时保住了两件事：基数用模板值 → 不随波次成长膨胀；比例用当前血量 → 残血打得软。
{
  const def = SkillLibrary.get('passive_melee_rend');
  const hit = (maxHP, curHP, params) => {
    const dealt = [];
    const A = { id: 1, type: 'melee', alive: true, pos: { x: 0, y: 0 },
                baseStats: { ...CONFIG.templates.melee, maxHP }, currentHP: curHP, _skillInstances: [] };
    const B = { ...A, id: 2 };
    def.onDealtDamage(1, 2, { state: {}, _params: params }, {
      entityContainer: { get: (i) => (i === 1 ? A : B) },
      combat: { performAttackDirect: (a, b, d) => dealt.push(d) },
    });
    return dealt[0] || 0;
  };
  const M = CONFIG.templates.melee.maxHP, P = CONFIG.rend.melee.pct;
  T('三个兵种的默认基数模式都是 templateByHpPct',
    ['melee', 'ranged', 'siege'].every(k => CONFIG.rend[k].base === 'templateByHpPct'));
  T(`满血：模板生命 × 100% × ${P * 100}% = ${M * P}`, Math.abs(hit(M, M) - M * P) < 1e-9);
  T(`半血：正好减半 = ${M * P / 2}`, Math.abs(hit(M, M / 2) - M * P / 2) < 1e-9);
  T('残血 10%：只剩一成', Math.abs(hit(M, M * 0.1) - M * P * 0.1) < 1e-9);
  T('波次成长（maxHP ×3）且满血 → 伤害不变（基数是模板值，不膨胀）',
    Math.abs(hit(M * 3, M * 3) - M * P) < 1e-9);
  T("旧模式 'template' 仍可按地图切回（满血时两者逐位相同）",
    Math.abs(hit(M, M / 2, { pct: P, base: 'template' }) - M * P) < 1e-9);
  T("旧模式 'current' 仍可按地图切回", Math.abs(hit(M, M / 2, { pct: P, base: 'current' }) - M / 2 * P) < 1e-9);
  T('文案与结算共用同一个基数函数（不许两边各写一套）',
    /function _rendBase\(entity, casterType, mode\)/.test(fs.readFileSync('src/core/skills/minionPassives.js', 'utf8')));

  // 所有地图小兵默认装备屠戮 —— 嚎哭深渊的排除开关连同整条传参链一起删了
  T('[嚎哭深渊] 不再有 minionNoRend', MAPS['howling_abyss_v1'].minionNoRend === undefined);
  T('main.js 里的 noRend 传参链也删干净了',
    !/noRend/.test(fs.readFileSync('src/main.js', 'utf8').replace(/^\s*\/\/.*$/gm, '')));
}

// ==================== 六、狙击型子弹已删除 ====================
{
  T('技能库里没有 weapon_sniper', !SkillLibrary.weapon_sniper && !SkillLibrary.get?.('weapon_sniper'));
  // v43 P1-4：编辑器已拆成 src/ui/editor/*，清单里要把整片列进来（否则残留会漏检）
  const _edFiles = fs.readdirSync('src/ui/editor').sort()
    .filter(f => f.endsWith('.js')).map(f => 'src/ui/editor/' + f);
  for (const f of ['src/core/skills/weapons.js', 'src/ui/AttributeEditor.js', ..._edFiles,
                   'src/ui/UnitAddDialog.js', 'src/presentation/SpriteFactory.js']) {
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    T(`${f} 里没有残留的狙击型条目`, !/weapon_sniper|sniper:/.test(src));
  }
}

// ==================== 七、残弹落点高度：目标死亡后冻结 ====================
// 用户："水晶塔被摧毁留下的弹道轨迹会突然变成平面的（水平的）"。
// 根因：刷新条件只判 `tgtE?.pos` 存在，而塔死了会变成【废墟】留在容器里（为了还能点选），
// pos 照样在 → 继续每帧刷新，可废墟模型矮一大截，落点高度当场塌下来，弹道读作水平。
{
  const src = fs.readFileSync('src/presentation/EffectsLayer.js', 'utf8');
  T('刷新条件必须带 tgtE.alive', /if \(tgtE\?\.pos && tgtE\.alive\) \{/.test(src));
  T('注释写清了根因（废墟仍在容器里、模型更矮）', /废墟/.test(src) && /贴着地面平飞/.test(src));

  // ⚠️ 收紧刷新条件的**另一面**：目标在这发子弹被画出来【之前】就死了的话，
  // 一次快照都取不到 → by 退化成常量炮口高度 → 子弹平着飞出去
  //（用户："塔在攻速快的时候…射出去的子弹就是不变的高度射直至消失"）。
  // 高攻速塔常见：开火与目标死亡落在同一个逻辑帧，中间没有渲染帧。
  // v43 P0-③：endHeightOf 的签名从 (id, x, z) 改成 (owner, entityId)——坐标参数没用了，
  // 因为按坐标查高度那条路整个删掉了。断言意图不变，只换匹配式。
  T('没有快照时用 ProjectileSystem 冻结的最后落点补一张（否则子弹平飞）',
    /else if \(!snap && p\.lastTx != null\) \{/.test(src)
    && /snap = \{ x: p\.lastTx, y: p\.lastTy, h: endHeightOf\(p, p\.targetId\) \};/.test(src));
  T('注释写清了为什么"目标活着时先记一笔"这条路走不通', /中间根本没轮到一次渲染帧/.test(src));
}

// ==================== 八、天气可视化 ====================
{
  const src = fs.readFileSync('src/presentation/WeatherLayer.js', 'utf8');
  const C = CONFIG.ui.weatherFx;
  T('参数全在 CONFIG.ui.weatherFx 里（软编码）',
    typeof C === 'object' && C.enabled === true && C.maxRain > 0 && C.maxSnow > 0);
  {
    // 只看代码（注释里当然会解释"为什么不用占比"）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    T('强度读【充能】而不是【占比】（占比会随 OU 抖，充能才有积累—消退的节奏）',
      /weather\.getCharge/.test(code) && !/getWeights/.test(code));
  }
  T('五种基础天气各有画法：雨/雪/雾/风/晴',
    /_updateRain/.test(src) && /_updateSnow/.test(src) && /_updateFog/.test(src)
    && /_updateDust/.test(src) && /wind \* \(C\.rainTiltWind/.test(src));
  T('晴也画东西（浮尘）—— 否则切到晴就像"天气关了"', /_updateDust\(clear, wind/.test(src));
  T('粒子只在跟着镜头走的盒子里撒（整图撒是纯浪费）', /_wrap\(v, c, h\)/.test(src) && /viewPad/.test(src));
  T('逐帧零分配（预分配 Float32Array，只改数字）',
    /new Float32Array/.test(src) && /needsUpdate = true/.test(src));
  T('用墙钟推进而不是 gameTime（暂停时雨该继续下）',
    /this\._lightDt \|\| 0\.016/.test(fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8')));
  T('雾不是 scene.fog（俯视下按距离的雾调不出"起雾了"）',
    /不用 scene\.fog/.test(src));
  T('渲染器接了这一层并给出可见范围（宽 = W/zoom，纵深按仰角还原）',
    /this\.weatherFx\.update\(window\.__weather \|\| null, this\._target,/
      .test(fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8')));
  T('设置面板里有开关（软编码必须可改）',
    /setWfxBtn/.test(fs.readFileSync('src/ui/SettingsDialog.js', 'utf8')));
}

console.log(`v42验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
