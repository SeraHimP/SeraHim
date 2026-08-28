// 模板编辑器重做 + 巨龙软编码 + 多召唤水晶 + 出兵条件 验收。
//
// 挑测什么：这四块的共同点是【结构性断言可测】—— 面板长什么样由一张注册表推导、
// 曲线由一份配置驱动、条件由一张表生成。所以测的是"表和实现有没有对上"，
// 而不是渲染出来的像素。纯视觉的部分靠浏览器冒烟核对，不在这里凑断言充数。
globalThis.window = {
  gameTime: 0, waveNumber: 1, _uid: 0, CTX: {},
  __towerRules: { invincible: { blue: false, red: false }, attackOff: { blue: false, red: false }, waveOn: { blue: true, red: true } },
};
window.__towerRuleFor = (kind, faction) => {
  const r = window.__towerRules?.[kind]; if (!r) return false;
  return faction ? !!r[faction] : (r.blue || r.red);
};
import fs from 'fs';
const { CONFIG } = await import('../src/data/Config.js');
const { AttributeEditor } = await import('../src/ui/AttributeEditor.js');
const WC = await import('../src/data/waveComposition.js');
const DC = await import('../src/data/dragonCurve.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
// v43 P1-4：编辑器已拆成 src/ui/editor/* 七块，断言要读整片 ——
// 只读 AttributeEditor.js 会让否定断言因为「搬到隔壁文件」而假通过。
const AE_SRC = ['.' + '/src/ui/AttributeEditor.js',
  ...fs.readdirSync('.' + '/src/ui/editor').sort()
    .filter(f => f.endsWith('.js')).map(f => '.' + '/src/ui/editor/' + f)]
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');

// ==================== 一、页面注册表 = 面板结构的唯一来源 ====================
{
  const P = AttributeEditor._TPL_PAGES;
  T('页面注册表存在且每页都声明了 faction/apply/action',
    Object.values(P).every(d => typeof d.faction === 'boolean'
      && typeof d.apply === 'boolean' && ['apply', 'instant', 'none'].includes(d.action)));

  // 这是本次重做的核心断言：**声明的作用域必须和实现真读的一致**。
  // 一页声明 apply=true 却不读 _applyScope（或反过来），面板上就会出现
  // "切了但不起作用"的控件 —— 那正是改版前建筑体积/龙魂/成长几页的毛病。
  // 窗口放到 3000：武器页的阵营筛选发生在它调用的 _applyToFieldWeapon 里
  const readsFaction = (fn) => new RegExp(`_apply${fn}[\\s\\S]{0,3000}?_factionScope`).test(AE_SRC);
  const readsApply = (fn) => new RegExp(`_apply${fn}[\\s\\S]{0,3000}?_applyScope`).test(AE_SRC);
  const IMPL = {
    attr: 'TemplateAttrChanges', weapon: 'TemplateWeaponChanges',
    skill: 'TemplateSkillChanges', effect: 'TemplateEffectChanges',
  };
  for (const [page, fn] of Object.entries(IMPL)) {
    T(`「${P[page].label}」声明读阵营，实现里确实读了 _factionScope`, P[page].faction && readsFaction(fn));
    T(`「${P[page].label}」声明读应用范围，实现里确实读了 _applyScope`, P[page].apply && readsApply(fn));
  }
  for (const page of ['growth', 'bsize', 'soul', 'dragonrule', 'sandbox']) {
    T(`「${P[page].label}」不声明作用域（它对双方共同生效）`, !P[page].faction && !P[page].apply);
  }
  T('「龙魂」标为即点即生效（改版前它和"改完点应用"的页长得一模一样）',
    P.soul.action === 'instant');
  T('作用域条只在页面声明时才画', /P\.faction \? this\._renderFactionScopeBar/.test(AE_SRC)
    && /P\.apply \? this\._renderApplyScopeBar/.test(AE_SRC));
  T('说明行只描述该页真读的维度', /_pageScopeNote\(P\)/.test(AE_SRC));
  T('【应用】按钮印出写入目标（用户不必猜）', /应用 → \$\{this\._nodeLabel\(\)\}·\$\{P\.writes\}/.test(AE_SRC));
  T('只读页不画【应用】按钮', /P\.action === 'apply'/.test(AE_SRC));
}

// ==================== 二、导航树：选中 → 页面校正 ====================
{
  const AE = AttributeEditor;
  AE._tplState = { category: 'tower', type: 'tower', tier: 'outer', tab: 'weapon' };
  T('塔节点键含层级', AE._curNodeKey() === 'tower:outer');
  AE._selectNode('tower:hq_tower');
  T('切层级只换 tier', AE._tplState.tier === 'hq_tower' && AE._tplState.category === 'tower');
  T('塔有"武器"页，切层级后停留页不变', AE._tplState.tab === 'weapon');

  // 关键：小兵没有"武器"页。不校正的话 tab 会指向不存在的页，右侧一片空白。
  AE._selectNode('minion:ranged');
  T('切到小兵时把不存在的页校正回第一页',
    AE._tplState.category === 'minion' && AE._tplState.type === 'ranged'
    && AE._pagesOf('minion').includes(AE._tplState.tab));
  T('小兵节点键含兵种', AE._curNodeKey() === 'minion:ranged');

  AE._selectNode('wave');
  T('出兵编排是【顶层】节点，不再挂在某个兵种底下',
    AE._curNodeKey() === 'wave' && AE._pagesOf('wave').join() === 'wave');
  T('沙盒节奏仍然逐兵种（在兵种节点下）', AE._pagesOf('minion').includes('sandbox'));
  T('沙盒节奏与全局编排不再同屏', !AE._pagesOf('wave').includes('sandbox'));

  AE._selectNode('minion');
  T('点父节点"小兵"回到具体兵种而不是空白', AE._tplState.category === 'minion'
    && AE._tplState.type !== 'tower' && AE._tplState.type !== 'dragon');
  AE._selectNode('dragon');
  T('巨龙有实际内容（属性 + 刷新与强度），不再是一句"暂无"',
    AE._pagesOf('dragon').join() === 'attr,dragonrule');
  T('巨龙的属性页不画阵营条（中立野怪不分阵营）',
    AE._effPage('attr', 'dragon').faction === false && AE._TPL_PAGES.attr.faction === true);

  T('沙盒的"编辑生成规则"按钮直达沙盒节奏页',
    /openTemplateEditor\(type, uiManager\.log\.bind\(uiManager\), returnCallback, 'sandbox'\)/
      .test(fs.readFileSync('src/main.js', 'utf8')));
  T('渲染/绑定/应用各只有一处分发（改版前首屏与切页两条路径各写一份）',
    (AE_SRC.match(/_renderPage\(page, type\)/g) || []).length >= 1
    && /_applyPage\(page, overlay, type, logFn\)/.test(AE_SRC));
}

// ==================== 三、巨龙：软编码且与旧写死值逐位一致 ====================
{
  // 旧实现（从 DragonSystem 改版前的源码原样抄来，base 三项按 2026-08 用户定稿的
  // "上调前期龙强度"改到位：maxHP 1200→1600、resist -40→-15、
  // attackDamage 按 3 个校准点(第1/4/8条=102/270/500)反解 base=102/step=56/lateStep=57.5）
  const oldStats = (w, anc) => {
    let hp, res, ad;
    if (w <= 4) hp = 1600 + (w - 1) * 600; else hp = 3400 + (w - 4) * 500;
    if (w <= 4) res = -15 + (w - 1) * (240 / 3); else res = Math.min(225 + (w - 4) * 30, 500);
    if (w <= 4) ad = 102 + (w - 1) * 56; else ad = 270 + (w - 4) * 57.5;
    if (anc) { hp *= 1.15; res += 40; ad *= 1.1; }
    return { maxHP: Math.round(hp), armor: Math.round(res), magicResist: Math.round(res), attackDamage: Math.round(ad) };
  };
  let same = true;
  for (let w = 1; w <= 20; w++) for (const anc of [false, true]) {
    if (JSON.stringify(oldStats(w, anc)) !== JSON.stringify(DC.dragonStatsAt(w, anc))) same = false;
  }
  T('曲线搬进配置后与原写死公式逐位一致（前 20 条 × 元素/远古）', same);
  // v43（用户定稿）："龙改为每5分钟一条。第一条龙1分钟就刷。"
  // 元素龙间隔 [420,480,540] → [300]；远古龙 600 → 300。
  // 远古龙也提到 300 的理由：成魂方顶着**永久**龙魂，而远古龙的处决 buff 是落后方
  // 唯一的翻盘工具 —— 10 分钟才有一次机会的话"另一方不用玩了"依然成立。
  T('刷新节奏：首条 60s，之后一律 5 分钟',
    DC.dragonCfg().firstDelay === 60
    && DC.dragonIntervalAt({ soulUnlocked: false, elementSpawned: 1 }) === 300
    && DC.dragonIntervalAt({ soulUnlocked: false, elementSpawned: 2 }) === 300
    && DC.dragonIntervalAt({ soulUnlocked: false, elementSpawned: 3 }) === 300);
  T('元素龙间隔越界沿用最后一项（不会返回 undefined 让计时变 NaN）',
    DC.dragonIntervalAt({ soulUnlocked: false, elementSpawned: 99 }) === 300);
  T('远古龙：首条与之后都是 5 分钟',
    DC.dragonIntervalAt({ soulUnlocked: true, ancientSpawned: 1 }) === 300
    && DC.dragonIntervalAt({ soulUnlocked: true, ancientSpawned: 2 }) === 300);

  // 真的读配置，不是摆设
  const bak = JSON.parse(JSON.stringify(CONFIG.gameRules.dragon));
  CONFIG.gameRules.dragon.curve.maxHP.base = 5000;
  CONFIG.gameRules.dragon.firstDelay = 30;
  T('改配置立刻改结果（不是"改了没反应"）',
    DC.dragonStatsAt(1, false).maxHP === 5000 && DC.dragonCfg().firstDelay === 30);
  CONFIG.gameRules.dragon.curve.resist.cap = 100;
  T('上限生效', DC.dragonStatsAt(20, false).armor === 100);
  CONFIG.gameRules.dragon = bak;
  T('恢复后回到出厂值', DC.dragonStatsAt(1, false).maxHP === 1600);

  // 那七个死键必须真的没了 —— 留着它们就等于在编辑器里摆一排"改了没反应"的框
  for (const dead of ['dragonFirstDelay', 'dragonInterval', 'dragonHpScale',
                      'dragonAttrScale', 'dragonKillsToUnlock', 'ancientDragonHpScale', 'ancientDragonAttrScale']) {
    T(`死配置 ${dead} 已从 gameRules 移除`, !(dead in CONFIG.gameRules));
  }
  T('取而代之的 gameRules.dragon 真的存在且被引擎读取', !!CONFIG.gameRules.dragon);
  const dsSrc = fs.readFileSync('src/systems/DragonSystem.js', 'utf8');
  T('DragonSystem 与编辑器预览共用同一份曲线实现（不许各抄一份）',
    /from '\.\.\/data\/dragonCurve\.js'/.test(dsSrc)
    && /dragonStatsAt|dragonIntervalAt/.test(AE_SRC));
  T('DragonSystem 里不再有写死的刷新时间表', !/7 \* 60|8 \* 60|9 \* 60/.test(dsSrc));
  T('DragonSystem 里不再有写死的曲线系数', !/1200 \+ \(w - 1\) \* 600/.test(dsSrc));
}

// ==================== 四、出兵条件 ====================
{
  const gr = { spawnEnabled: { melee: true, super: true, siege: true },
               laneWaveComposition: [
                 { type: 'super', count: 1, when: 'nexusDown' },
                 { type: 'melee', count: 2 },
                 { type: 'siege', count: 1, when: '!nexusDown' }] };
  T('旧 token 仍然生效（老存档不失效）',
    WC.buildWaveOrder(1, false, gr).join() === 'melee,melee,siege'
    && WC.buildWaveOrder(1, true, gr).join() === 'super,melee,melee');

  const groups = WC.whenOptionGroups();
  T('条件按组归类，供下拉框直接渲染 optgroup', groups.length >= 4 && groups.every(g => g.items.length));
  T('条件数量远多于原来的 3 条', Object.keys(WC.WAVE_CONDITIONS).length >= 40);
  T('我方/敌方 × 六档 × 三种成色都在表里',
    ['ally', 'enemy'].every(s => WC.STRUCT_TIERS.every(t =>
      ['allDown', 'anyDown', 'allAlive'].every(k => WC.WAVE_CONDITIONS[`${s}.${t.key}.${k}`]))));
  T('下拉选项由这张表生成，UI 里没有第二份清单',
    /whenOptionGroups\(\)/.test(AE_SRC) && !/WHEN_OPTIONS/.test(AE_SRC));

  const census = {
    blue: { all: { hq_tower: { total: 2, alive: 2 } }, lanes: { top: { inner: { total: 2, alive: 1 } } } },
    red: { all: { hq_tower: { total: 2, alive: 0 } }, lanes: { top: { inner: { total: 2, alive: 0 } } } },
  };
  const g2 = { spawnEnabled: { melee: true, super: true },
               laneWaveComposition: [{ type: 'super', count: 1, when: 'enemy.inner.allDown' }, { type: 'melee', count: 1 }] };
  T('敌方本路内塔全灭 → 条件成立',
    WC.buildWaveOrder(1, false, g2, 'blue', { laneId: 'top', census }).join() === 'super,melee');
  T('反过来（红方看蓝方内塔还剩一座）→ 不成立',
    WC.buildWaveOrder(1, false, g2, 'red', { laneId: 'top', census }).join() === 'melee');
  const g3 = { spawnEnabled: { melee: true, super: true },
               laneWaveComposition: [{ type: 'super', count: 1, when: 'enemy.inner.anyDown' }, { type: 'melee', count: 1 }] };
  T('"至少一座被摧毁"比"全部"宽松',
    WC.buildWaveOrder(1, false, g3, 'red', { laneId: 'top', census }).join() === 'super,melee');
  const g4 = { spawnEnabled: { melee: true, super: true },
               laneWaveComposition: [{ type: 'super', count: 1, when: 'enemy.hq_tower.allDown' }, { type: 'melee', count: 1 }] };
  T('枢纽塔不分路，按全场算',
    WC.buildWaveOrder(1, false, g4, 'blue', { laneId: 'top', census }).join() === 'super,melee'
    && WC.buildWaveOrder(1, false, g4, 'red', { laneId: 'top', census }).join() === 'melee');

  const g5 = { spawnEnabled: { melee: true }, laneWaveComposition: [{ type: 'melee', count: 1, when: 'time.after', whenArg: 600 }] };
  T('时间条件读 whenArg',
    WC.buildWaveOrder(1, false, g5, 'blue', { gameTime: 599 }).length === 0
    && WC.buildWaveOrder(1, false, g5, 'blue', { gameTime: 600 }).length === 1);
  T('不带 ctx 时依赖建筑/时间的条件一律放行（宁可多出兵，不要静默漏兵）',
    WC.buildWaveOrder(1, false, g5, 'blue').length === 1
    && WC.buildWaveOrder(1, false, g2, 'blue').length === 2);
  T('未知 token 也放行，不会让整条规则静默消失',
    WC.buildWaveOrder(1, false, { spawnEnabled: { melee: true }, laneWaveComposition: [{ type: 'melee', count: 1, when: 'no.such.cond' }] }).length === 1);

  const lw = fs.readFileSync('src/systems/LaneWaveSystem.js', 'utf8');
  T('出兵系统真的把世界快照传进去', /census: this\._census/.test(lw) && /laneId: lane\.id, gameTime/.test(lw));
  T('建筑普查每波只做一次（不是每条规则各查一遍）', /this\._census = this\.mapSystem\.structureCensus/.test(lw));

  // 预览也必须带快照。不带的话新条件在预览里一律"放行"，预览会报出实战不会出现的兵 ——
  // 这个面板当初存在的理由就是"预览不许骗人"，加了条件却不给预览快照等于把它废掉。
  T('编辑器预览也带世界快照（时间 + 本路 + 建筑普查）',
    /gameTime: _pvTime, laneId: this\._waveOrderPreviewLane, census: _census/.test(AE_SRC));
  T('预览的时间按"首波延迟 + (N−1)×波间隔"推算，与出兵系统读同两个键',
    /_first \+ Math\.max\(0, w - 1\) \* _every/.test(AE_SRC)
    && /_wi\?\.firstWaveDelay/.test(AE_SRC) && /_wi\?\.waveInterval/.test(AE_SRC));
  T('LaneWaveSystem 单独留了 firstWaveDelay（nextWaveTime 是每帧递减的倒计时，读它没意义）',
    /this\.firstWaveDelay = 30;/.test(lw)
    && /if \(m\.firstWaveDelay\) \{ this\.nextWaveTime = m\.firstWaveDelay; this\.firstWaveDelay = m\.firstWaveDelay; \}/.test(lw));
  T('构造函数里 nextWaveTime 不再被重复赋值两遍',
    (lw.match(/this\.nextWaveTime = 30;/g) || []).length === 1);
  T('不在对战中时预览如实说明"依赖建筑的条件按成立算"',
    /当前不在对战中.*?读不到建筑存活情况/s.test(AE_SRC));
  T('预览可以选看哪一路（分路条件的"本路"要有着落）',
    /_waveOrderPreviewLane/.test(AE_SRC) && /woPreviewLane/.test(AE_SRC));
  // 参数默认值必须**真的写进规则**。只当 placeholder 显示的话，框里灰着 600、
  // 实际按 0 判定 —— "满 10 分钟才出的兵"第 1 波就冒出来，而面板看着毫无异常。
  T('选中吃参数的条件时把默认值写进规则，而不是只当 placeholder 显示',
    /else if \(r\.whenArg == null\) r\.whenArg = arg\.def/.test(AE_SRC));
  T('清空参数框回到该条件的默认值，而不是变成"没门槛"',
    /if \(f === 'whenArg' && arg\) r\.whenArg = arg\.def/.test(AE_SRC));
  T('条件声明了默认值', WC.WAVE_CONDITIONS['time.after'].arg.def === 600);
}

// ==================== 五、召唤水晶：一路多座 + 手动击杀/复活 ====================
{
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(fx);
  let uid = 5000;
  ms.setCreateBuildingFn(({ faction, tier, laneId, pos, stats }) => {
    const e = { id: ++uid, type: 'tower', alive: true, pos: { ...pos }, baseStats: { ...stats },
                currentHP: stats.maxHP, shieldFixedCurrent: stats.shieldFixedMax || 0, tempShield: 0,
                _skillInstances: [], _mapFaction: faction, _mapTier: tier, _laneId: laneId, faction };
    ents.add(e); return e;
  });
  ms.loadMap('summoners_rift_v1');
  ms.update(0.1);

  // ---- 手动击杀（编辑器路径）应当开始倒计时 ----
  const nx = ents.getAll(true).find(e => e._mapTier === 'nexus_lane' && e._mapFaction === 'blue' && e._laneId === 'mid');
  T('地图里有召唤水晶', !!nx);
  nx.alive = false; nx.currentHP = 0;                    // 编辑器的"击杀"就是这两行，不发 entity:death
  T('只置死不做别的，确实不会自己进倒计时（改版前的现象）', !nx._respawnAt);
  T('beginNexusRespawn 让它进入倒计时', ms.beginNexusRespawn(nx) === true && nx._respawnAt > 0);
  T('挂上了⏳「重生中」状态', !!fx.getEffectByName(nx.id, '重生中'));
  T('本路只有一座水晶时，拆掉即算这一路陷落', ms.isNexusDestroyed('blue', 'mid'));
  T('重生剩余时间可查', ms.getNexusRespawnRemain('blue', 'mid') > 0);
  T('重复调用不会二次入队', ms.beginNexusRespawn(nx) === false
    && ms._respawnQueue.filter(q => q.corpseId === nx.id).length === 1);

  // ---- 手动复活应当把倒计时【和状态】一起撤掉 ----
  ms.cancelNexusRespawn(nx.id);
  nx.alive = true; nx.currentHP = nx.baseStats.maxHP;
  T('复活后队列项已撤（否则时间一到会凭空多一座）',
    ms._respawnQueue.filter(q => q.corpseId === nx.id).length === 0);
  T('复活后 _respawnAt 已清', !nx._respawnAt);
  T('复活后⏳「重生中」状态也摘掉了（改版前它会一直挂着继续读秒）',
    !fx.getEffectByName(nx.id, '重生中'));
  ms._refreshLaneNexusFlag('blue', 'mid');
  T('复活后这一路不再算陷落', !ms.isNexusDestroyed('blue', 'mid'));

  // ---- 一路多座：必须全灭才算陷落 ----
  // 再往这一路塞一座（模拟以后的新地图），验证判定是按"全灭"而不是"第一座"。
  const extra = { id: ++uid, type: 'tower', alive: true, pos: { x: nx.pos.x + 40, y: nx.pos.y + 40 },
                  baseStats: { ...nx.baseStats }, currentHP: nx.baseStats.maxHP, shieldFixedCurrent: 0,
                  tempShield: 0, _skillInstances: [], _mapFaction: 'blue', _mapTier: 'nexus_lane',
                  _laneId: 'mid', faction: 'blue' };
  ents.add(extra); ms._buildingIds.push(extra.id);
  T('这一路现在有两座召唤水晶', ms.laneNexuses('blue', 'mid').length === 2);

  nx.alive = false; nx.currentHP = 0; ms.beginNexusRespawn(nx);
  T('拆掉其中一座 → 这一路【还不算】陷落（改版前拆一座就算，多水晶地图会提前发超级兵）',
    !ms.isNexusDestroyed('blue', 'mid'));
  T('但被拆的那座照常进入自己的重生倒计时', nx._respawnAt > 0);

  extra.alive = false; extra.currentHP = 0; ms.beginNexusRespawn(extra);
  T('两座都拆掉 → 这一路才算陷落', ms.isNexusDestroyed('blue', 'mid'));

  // 任意一座回来，这一路就不再陷落（超级兵红利应当立刻停）
  ms.cancelNexusRespawn(extra.id);
  extra.alive = true; extra.currentHP = extra.baseStats.maxHP;
  ms._refreshLaneNexusFlag('blue', 'mid');
  T('回来一座即解除陷落（不必等全部回来）', !ms.isNexusDestroyed('blue', 'mid'));
  T('剩余重生时间取最早的那座', ms.getNexusRespawnRemain('blue', 'mid') === Math.max(0, nx._respawnAt - ms._clock));

  // ---- 普查供出兵条件使用 ----
  const cs = ms.structureCensus();
  T('普查按阵营/档位统计', cs.blue.all.outer.total > 0 && cs.red.all.outer.total > 0);
  T('分路档位按 laneId 再分一层', !!cs.blue.lanes.mid && !!cs.blue.lanes.mid.nexus_lane);
  T('枢纽塔不分路（laneId 为 null，只进 all）',
    cs.blue.all.hq_tower.total > 0 && !(cs.blue.lanes.mid || {}).hq_tower);
  T('普查如实反映刚拆掉的那座', cs.blue.lanes.mid.nexus_lane.alive === 1
    && cs.blue.lanes.mid.nexus_lane.total === 2);

  const msSrc = fs.readFileSync('src/systems/MapSystem.js', 'utf8');
  T('自然死亡与编辑器击杀走同一个入口',
    /_onEntityDeath\(entityId\)[\s\S]{0,900}this\.beginNexusRespawn\(e\)/.test(msSrc));
  T('编辑器复活走 cancelNexusRespawn 而不是自己清一半',
    /if \(ms\?\.cancelNexusRespawn\) ms\.cancelNexusRespawn\(e\.id\)/.test(AE_SRC));
  T('编辑器击杀会给召唤水晶开倒计时',
    /_mapTier === 'nexus_lane' && app\?\.mapSystem\?\.beginNexusRespawn/.test(AE_SRC));
}

// ==================== 六、出兵编排面板的排版 ====================
{
  const css = fs.readFileSync('index.html', 'utf8');
  T('表头与数据行共用一套 grid 列宽（原来两边各写一串 px，列标题整体左偏）',
    /\.wo-row \{[\s\S]{0,200}grid-template-columns/.test(css));
  T('表头只是加了个 class，不再自己排一遍', /wo-row wo-head/.test(AE_SRC));
  T('条件列的参数框只在该条件需要参数时出现', /cond\.arg[\s\S]{0,200}wo-arg/.test(AE_SRC));
  T('换成不吃参数的条件时会清掉 whenArg',
    /const arg = WAVE_CONDITIONS\[el\.value\]\?\.arg;[\s\S]{0,320}?if \(!arg\) delete r\.whenArg/.test(AE_SRC));
  T('左树布局有专属样式', /\.tpl-layout/.test(css) && /\.tpl-nav-item/.test(css));
  T('即时生效角标有专属样式', /\.tpl-instant/.test(css));
}

console.log(`模板编辑器/巨龙/水晶/出兵条件 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
