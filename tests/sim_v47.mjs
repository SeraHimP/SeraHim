/**
 * sim_v47.mjs —— v47 验收
 *
 * 本轮六件事，各自钉住"行为形状"而不是数字/写法：
 *   ① 出生血量按**叠完增益之后**的最大生命补满（用户："第二波龙开始生成的不是满血的龙"）
 *   ② 龙的射程 200 → 80
 *   ③ 龙魂的常驻属性并进龙魂本体那一个状态图标（用户："状态栏显示的乱七八糟"）
 *   ④ 属性面板：攻速/移速/攻击距离跟着染色；展开更多按方面分组；塔多了射程、
 *      兵的移速位置在塔上显示子弹速度；攻速加成让位给生命恢复
 *   ⑤ 顶边栏拆左右两块 + 浮层玻璃参数收敛到唯一的 .hud-panel + 日志搬进设置
 *   ⑥ 掉血拖尾只剩 barTrail 一份实现（画面与属性面板同参数）
 *
 * 塔朝向（扭曲丛林回环路）与废墟模型的断言放在 sim_v46 与 sim_lightring 里 ——
 * 那两处已经有同题目的整段，拆开放会让"这条规则在哪儿钉着"更难找。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { CONFIG } = await import('../src/data/Config.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { DragonSystem } = await import('../src/systems/DragonSystem.js');
const { createFactories, effectiveMaxHP } = await import('../src/core/factories.js');

const { T, done } = scoreboard('v47验收');

/** 一套能真跑工厂的最小世界。 */
function world() {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mapSystem = { active: false, currentMap: null };
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem, dragonSystem: ds, uiManager: { log() {} },
  });
  ds.createEntity = (t, o) => F.createDragon(t, o);
  return { bus, ents, fx, ds, F };
}

// ==================== 一、出生即满血 ====================
// 用户："第二波龙开始生成的不是满血的龙。"（截图：山龙 HP 1800/1953）
//
// 根因是**顺序**：currentHP = baseStats.maxHP 写在装备龙魂/巨龙之力之前，
// 而那些增益带 maxHPPct。龙最明显是因为它自带的力层数 = 该元素已死数 + 1，
// 逐条递增 —— "从第二条开始越来越明显"与用户的观察完全对得上。
{
  const { fx, ds, F } = world();
  let allFull = true, sawGrowth = false;
  const seen = [];
  for (let i = 1; i <= 4; i++) {
    const st = ds._dragonStats(i, false);
    const d = F.createDragon('dragon', { element: 'earth', absStats: st });
    const eff = AttributeCalculator.calc(d, fx.getEffects(d.id)).maxHP;
    seen.push([Math.round(d.currentHP), Math.round(eff), Math.round(d.baseStats.maxHP)]);
    if (Math.abs(d.currentHP - eff) > 1e-6) allFull = false;
    if (eff > d.baseStats.maxHP + 1e-6) sawGrowth = true;   // 确认这条断言确实在测有增益的情形
    ds.killCounts.earth = (ds.killCounts.earth || 0) + 1;
  }
  T('生①-元素龙逐条出生都是满血（第 2 条起也是）', allFull);
  T('生①-前提成立：这几条龙的最大生命确实被增益抬高过（否则这条断言什么都没测）', sawGrowth);
  T('生①-抬高的是**最终**最大生命，baseStats 那个数没被改（增益仍走效果系统）',
    seen.every(([, eff, base]) => eff >= base));

  // 四个工厂都要走同一条路 —— 只修被报告的那一个，另外三处必然复发。
  const fac = srcOf('src/core/factories.js');
  const n = (fac.match(/spawnAtFullHP\(entity\);/g) || []).length;
  T('生②-四个工厂都调了 spawnAtFullHP（塔/对战建筑/小兵/龙）', n === 4);
  T('生②-补满的时机在"装完技能与龙之奖励之后"，不是在实体字面量里',
    /dragonSystem\.applyDragonSelfBuffs\(entity\);\n\s*spawnAtFullHP\(entity\);/.test(fac)
    && /dragonSystem\.equipExistingSoul\(entity\);\n\s*spawnAtFullHP\(entity\);/.test(fac));
  T('生③-重生也用同一个口径（否则持魂方的水晶"重生完不是满血"）',
    /effectiveMaxHP\(corpse\)/.test(srcOf('src/systems/MapSystem.js')));
  T('生③-沙盒里"套用档位数值"之后同样补满', /effectiveMaxHP\(tower\)/.test(srcOf('src/main.js')));
}

// 小兵这一侧单独验一次：它走的是另一条工厂路径（hpScale / growthFlat / equipExistingSoul）。
// （原来这里还测"里程碑成长"——沙盒模式专属的按波次数自动强化，
// 随沙盒模式一起删除了，见 factories.js 的 createMinion。改用 growthFlat 继续覆盖
// "出生血量按叠完增益之后的最大生命补满"这条规则，而不是白测一个没有增益的空转场景。）
{
  const { fx, F } = world();
  const baseTplHP = CONFIG.templates.siege.maxHP;
  const m = F.createMinion('siege', 100, 100, 1, 1,
    { faction: 'blue', laneId: 'mid', direction: 'forward', growthFlat: { hp: 500, ad: 20, res: 10, ap: 0 } });
  const eff = AttributeCalculator.calc(m, fx.getEffects(m.id)).maxHP;
  T('生④-小兵出生也是满血（growthFlat 抬高的最大生命也补满）', Math.abs(m.currentHP - eff) < 1e-6);
  T('生④-前提成立：这只兵的最大生命确实被 growthFlat 抬高过', eff > baseTplHP + 1e-6);
}

// ==================== 二、龙的射程 ====================
// 用户："龙的射程改为80。"
{
  const D = CONFIG.gameRules.dragon;
  T('龙①-射程 = 80（软编码在 gameRules.dragon.combat）', D.combat.attackRange === 80);
  T('龙②-比塔近：龙必须走进塔的射程里才够得着塔（原来 200 > 塔 180，能白嫖拆塔）',
    D.combat.attackRange < CONFIG.templates.tower.attackRange);
  // 两条兜底，防止将来有人把它一路调小
  T('龙③-仍然不是近战单位（>MELEE_RANGE_THRESHOLD，弹道/接敌逻辑不改变）', (async () => true)()
    && D.combat.attackRange > 60);
  T('龙④-真正生成出来的龙吃到这个值（不是只改了配置没接上）', (() => {
    const { F } = world();
    const d = F.createDragon('dragon', { element: 'fire', absStats: { maxHP: 100, armor: 0, magicResist: 0, attackDamage: 1 } });
    return d.baseStats.attackRange === 80;
  })());
}

// ==================== 三、龙魂在状态栏只占一格 ====================
// 用户："龙魂/巨龙之力在状态栏显示的乱七八糟。巨龙之力每个元素合并在1个状态显示
//        （几层+该元素总属性），龙魂还是技能+状态显示。"
//
// 状态栏是按 blueprint.name 聚合成图标的（UIManager._updateEffectIcons）。
// 巨龙之力本来就一元素一名字（`山龙之力`）——已经是一格；
// 出问题的是龙魂：常驻属性那几条叫 `山魂·加持`，与本体的 `山魂` **不同名**，
// 于是一条魂占了两格。改成同名即并进一格。
{
  const { ents, fx, ds } = world();
  const t = { id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 9000,
    _skillInstances: [], _mapFaction: 'blue', faction: 'blue', _mapTier: 'outer' };
  ents.add(t);
  ds._applyElementBuff(t, 'fire');
  ds._applyElementBuff(t, 'earth'); ds._applyElementBuff(t, 'earth');
  ds._toggleSoul(t, 'dragonsoul_earth');

  const names = new Map();
  for (const e of fx.getEffects(t.id)) {
    const k = e.blueprint.name;
    names.set(k, (names.get(k) || 0) + 1);
  }
  T('魂①-一条龙魂在状态栏只占一格（常驻属性并进本体，不再有单独的「·加持」）',
    names.has('山魂') && ![...names.keys()].some(n => /·加持$/.test(n)));
  T('魂①-并进去的那一格里，机制属性与常驻属性都在（信息一条没少）',
    names.get('山魂') >= 5);
  T('魂②-巨龙之力仍然是"每个元素一格"（山的三项属性合成一格，不是三格）',
    names.get('山龙之力') === 3 && names.get('炎龙之力') === 1
    && [...names.keys()].filter(n => /之力$/.test(n)).length === 2);
  T('魂③-层数读得出来（面板抬头显示"（N层）"，取组内最大）', (() => {
    const earth = fx.getEffects(t.id).filter(e => e.blueprint.name === '山龙之力');
    return earth.length > 0 && Math.max(...earth.map(e => e.stacks)) === 2;
  })());
  T('魂④-龙魂本体仍然占一个**技能**格（用户："龙魂还是技能+状态显示"）',
    (t._skillInstances || []).some(i => i.skillId === 'dragonsoul_earth'));
}

// ==================== 四、属性面板 ====================
{
  const { extAttrGroups, BASE_ATTR_ROWS, allPanelStatKeys } =
    await import('../src/ui/statPanelLayout.js');
  const { statDoc } = await import('../src/data/statDocs.js');
  const um = srcOf('src/ui/UIManager.js');
  const html = srcOf('index.html');

  const keysOf = (kind) => extAttrGroups(kind).flatMap(g => g.rows.map(r => r.key));
  T('板①-塔的展开更多里有攻击距离（用户："塔展开更多里新增射程显示"）',
    keysOf('tower').includes('attackRange'));
  // v51.6：用户改稿，推翻了"塔看子弹速度、兵看移速各显示各的"这条旧规则——
  // "子弹速度放在攻击力里，所有单位统一展开更多的最后一个格为移速（目前的塔为
  // 子弹速度）。"子弹速度搬进【进攻】组（只有塔会显示，小兵目前没有意义的弹速），
  // 机动那一格不再按 kind 分支，统一固定是移速。
  T('板②-所有单位类型"展开更多"的最后一格统一是移速（不再是塔专属子弹速度）',
    keysOf('minion').includes('moveSpeed') && keysOf('tower').includes('moveSpeed'));
  T('板②b-子弹速度搬进了【进攻】组，只有塔显示（小兵目前没有弹道飞行速度这回事）',
    keysOf('tower').includes('bulletSpeed') && !keysOf('minion').includes('bulletSpeed'));
  T('板③-塔与兵**共用同一张表**（差异只剩子弹速度这一项，移速两边都有了）', (() => {
    const a = keysOf('tower'), b = keysOf('minion');
    const diff = [...new Set([...a, ...b])].filter(k => a.includes(k) !== b.includes(k));
    return diff.length === 1 && diff.includes('bulletSpeed');
  })());
  T('板④-展开更多不再显示攻速加成，换成了生命恢复（用户定稿）',
    !keysOf('tower').includes('bonusAttackSpeedPct')
    && keysOf('tower').includes('healthRegen'));
  T('板④-攻速加成的说明没丢：仍挂在常驻区【攻速】那一格的 data-stat 上',
    BASE_ATTR_ROWS.some(r => r.key === 'bonusAttackSpeedPct' && r.label === '攻速'));
  T('板⑤-按方面分组，组内条目都归在同一组标题下（用户："一个方面放在一块"）', (() => {
    const g = extAttrGroups('tower');
    const byTitle = Object.fromEntries(g.map(x => [x.title, x.rows.map(r => r.key)]));
    return g.length >= 4
      && (byTitle['穿透'] || []).length === 4
      && ['armorPenFlat', 'armorPenPercent', 'magicPenFlat', 'magicPenPercent']
           .every(k => (byTitle['穿透'] || []).includes(k))
      && ['lifeStealPct', 'healShieldPowerPct', 'healthRegen']
           .every(k => (byTitle['续航'] || []).includes(k));
  })());
  T('板⑥-每一格都有说明（点了弹空窗比不能点更糟）',
    [...new Set([...allPanelStatKeys('tower'), ...allPanelStatKeys('minion')])]
      .every(k => !!statDoc(k)));
  T('板⑦-奇数格的组把最后一格拉通两列（否则下一组的第一格会被塞进上一组的空位里）',
    /cells\.length % 2 === 1/.test(um) && /\.attrs-ext \.a\.span2 \{ grid-column: 1 \/ -1; \}/.test(html));

  // 着色：排查结果是**三个格子根本没走 _statValueHtml**，所以永远默认色。
  // 用户报的是"攻速加成为负的时候，攻速并没有显示为红色"。
  T('板⑧-攻速这一格跟着染色（它是派生量，要按同一口径重算一次基础攻速）',
    /_attackSpeedHtml\(E, stats\)/.test(um)
    && /calcAttackSpeedOf\(bs\)/.test(um)
    && /d < -0\.005 \? 'stat-down'/.test(um));
  T('板⑧-展开区的每一格都走 _statValueHtml（移速/攻击距离不再是裸 Math.round）',
    /this\._statValueHtml\(key, E, stats, suffix\)/.test(um)
    && !/<label>移速<\/label><span>\$\{Math\.round/.test(um)
    && !/<label>攻击距离<\/label><span>\$\{Math\.round/.test(um));
  T('板⑨-正负两种修正各有各的类，CSS 里也都在', (() => {
    const { UIManager } = { UIManager: null };   // 不 import（需要 DOM），只验源码与样式
    return /clean > 0 \? 'stat-up' : clean < 0 \? 'stat-down'/.test(um)
      && /\.stat-up\s+\{ color: #f0a03c; \}/.test(html)
      && /\.stat-down \{ color: #ef6b6b; \}/.test(html) && UIManager === null;
  })());

  // 血条读数
  T('板⑩-血条读数去掉了 HP 前缀（条本身就是血条）', !/textContent = `HP \$\{Math\.round\(tower/.test(um));
  // v51.3：.bar-text 与 .bar-res-text（资源条读数）合并成同一份规则了——"血条还有
  // 技能条的文字，位置/样式/大小都不统一，都改为居中+右侧"，选择器不再是单独的
  // `.bar-text {`，下面几条正则跟着改成认这个合并后的选择器。
  T('板⑩-血量居中、护盾靠右：三列网格，不是 space-between（后者会随护盾字宽左右漂）',
    /\.bar-text,\s*\.bar-res-text\s*\{[^}]*grid-template-columns: 1fr auto 1fr/.test(html)
    && /\.bar-text > :first-child,\s*\.bar-res-text > :first-child \{ grid-column: 2; justify-self: center; \}/.test(html)
    && /\.bar-text \.shield-total,\s*\.bar-res-text \.bar-res-regen \{ grid-column: 3; justify-self: end;/.test(html));
  T('板⑩-上下居中是算出来的：读数行与血条**等高** + align-items:center', (() => {
    const bt = (html.match(/\.bar-text,\s*\.bar-res-text\s*\{([^}]*)\}/) || [])[1] || '';
    const br = (html.match(/\.bar-row \{([^}]*)\}/) || [])[1] || '';
    const h = (br.match(/height: (\d+)px/) || [])[1];
    return !!h && new RegExp(`height: ${h}px`).test(bt)
      && new RegExp(`margin: -${h}px`).test(bt) && /align-items: center/.test(bt);
  })());

  // 图标行铺满：面板 320 时行尾恒定空 38px（差 2px 就够第 7 个），第 7 个只能换行。
  T('板⑪-技能/状态图标行铺满整宽，零头摊进列间距而不是留在行尾', (() => {
    const grab = (sel) => (html.match(new RegExp(sel + ' \\{([^}]*)\\}')) || [])[1] || '';
    return ['\\.skill-slot-row', '\\.effect-row'].every(sel => {
      const b = grab(sel);
      return /grid-template-columns: repeat\(auto-fill, 34px\)/.test(b)
          && /justify-content: space-between/.test(b);
    });
  })());
  T('板⑪-面板加宽到能放下 7 个图标一行', (() => {
    const w = +((html.match(/#selectionPanel \{[^}]*width: (\d+)px/) || [])[1] || 0);
    const avail = w - 2 - 16 - 2 - 28;          // 面板边框 + #selectionCard 内边距 + .unit-card 边框与内边距
    return w > 0 && Math.floor((avail + 6) / 40) >= 7;
  })());
}

// ==================== 五、顶边栏 / 浮层 ====================
{
  const html = srcOf('index.html');
  const mj = srcOf('src/main.js');
  const sd = srcOf('src/ui/SettingsDialog.js');
  T('栏①-顶边栏拆成左右两块独立浮层（中间露出画布，不再是一条横贯全屏的玻璃条）',
    /id="topbarLeft" class="hud-panel"/.test(html)
    && /id="topbarRight" class="hud-panel"/.test(html)
    && !/<div id="topbar">/.test(html));
  T('栏①-左块贴左、右块贴右',
    /#topbarLeft {2}\{[^}]*left: 12px/.test(html) && /#topbarRight \{[^}]*right: 12px/.test(html));
  T('栏②-玻璃参数只有一处定义（.hud-panel），四块浮层共用', (() => {
    const b = (html.match(/\.hud-panel \{([^}]*)\}/) || [])[1] || '';
    const ok = /var\(--surface\)/.test(b) && /blur\(14px\)/.test(b)
            && /var\(--glass-border\)/.test(b) && /position: absolute/.test(b);
    return ok && ['topbarLeft', 'topbarRight', 'canvasControls']
      .every(id => new RegExp(`id="${id}" class="hud-panel"`).test(html));
  })());
  // 用户："主界面右上角，右下角的栏不好看。不行把天气时间条移动到左上角，宽度也降低一些。"
  T('栏②-世界状态条搬进左上角那一块，右上角只剩按钮（浮层从四块减到三块）',
    /<div id="topbarLeft"[\s\S]{0,3000}<div id="worldHud">/.test(html)
    && !/id="worldHud" class="hud-panel"/.test(html)
    && !/#worldHud \{[^}]*right: 12px/.test(html));
  // "宽度也降低一些"：改成胶囊之后不再有写死的三段宽度 ——
  // 标签/读数按内容排，色带宽度跟着胶囊走。所以断言改成"整块的高度与宽度都收住了"：
  // 三段并成一行（不再是三行），且色带不再是那条 150px 的粗色带。
  T('栏②-世界状态条整体收窄：三段并成一行，色带不再写死宽度',
    /#worldHud \{[^}]*flex-wrap: wrap/.test(html)
    && !/#worldHud \.wh-bar \{[^}]*width: \d+px/.test(html)
    && !/#worldHud \.wh-label \{[^}]*width: \d+px/.test(html));
  // 用户："别忘了点开单位属性栏可能出现遮挡的情况。"
  // 写死一个够大的 top 只能挡住想得到的那一种情形（熵段显隐、窄窗换行都会改高度），
  // 所以改成量：ResizeObserver 盯 #topbarLeft 的 offsetHeight，变了就把面板推下去。
  T('栏②-属性面板的位置由左上角那块的实测高度决定', (() => {
    const um2 = srcOf('src/ui/UIManager.js');
    return /_bindPanelOffset\(\)/.test(um2) && /new ResizeObserver\(apply\)/.test(um2)
      && /bar\.offsetHeight/.test(um2) && /style\.maxHeight/.test(um2);
  })());
  T('栏②-CSS 里仍有兜底 top（ResizeObserver 生效前的第一帧要有位置）',
    +((html.match(/#selectionPanel \{[^}]*top: (\d+)px/) || [])[1] || 0) >= 60);
  T('栏②-世界状态条重做成一行胶囊（三条彩色横杠 → 与读数同一套语言）',
    (html.match(/class="wh-chip"/g) || []).length === 3
    && /\.wh-chip \{[^}]*border-radius/.test(html)
    && /#worldHud \{[^}]*display: flex[^}]*\}/.test(html));
  T('栏②-色带缩成胶囊底边的细线，且画布宽度是算出来的（canvas 是替换元素，left+right 撑不开）',
    /\.wh-chip \.wh-bar \{[^}]*height: 3px/.test(html)
    && /\.wh-chip \.wh-bar \{[^}]*width: calc\(100% - 14px\)/.test(html));
  T('栏②-两条色带都有"细条模式"：3px 上不画边框/刻度/图标，否则糊成一团', (() => {
    const wh = srcOf('src/ui/WorldHud.js'), wp = srcOf('src/ui/WeatherPanel.js');
    return /_thin\(h\) \{ return h <= 6; \}/.test(wh)
      && /if \(this\._thin\(h\)\) return;/.test(wh)
      && /const thin = cssH <= 6;/.test(wp)
      && /\(thin \? \[\] : segments\)/.test(wp);
  })());
  T('栏②-那四块自己不再各抄一份玻璃参数', (() => {
    for (const sel of ['#canvasControls', '#worldHud']) {
      const b = (html.match(new RegExp(sel + ' \\{([^}]*)\\}')) || [])[1] || '';
      if (/backdrop-filter/.test(b) || /var\(--surface\)/.test(b)) return false;
    }
    return true;
  })());
  T('栏③-顶栏右侧简化为图标方钮，且与右下工具栏同一个 .icon-btn',
    /\.icon-btn \{[^}]*width: 30px/.test(html)
    && /class="icon-btn primary" id="addUnitBtn"/.test(html)
    && /class="icon-btn" id="resetViewBtn"/.test(html));
  T('栏③-模式钮保留文字（它显示的是**当前状态**，图标化会让人不知道点了会变成什么）',
    /id="modeBtn" class="dragon">🗺️ 游戏地图/.test(html));
  T('栏④-日志按钮已从顶栏删除，接线也一并删了（否则 null.addEventListener 会打断后面所有接线）',
    !/id="toggleLogBtn"/.test(html) && !/getElementById\('toggleLogBtn'\)/.test(mj));
  T('栏④-日志开关搬进设置，操作的还是同一个 #logArea',
    /id="setLogAreaBtn"/.test(sd) && /setLogAreaBtn.*\n(?:.*\n){0,4}.*getElementById\('logArea'\)/.test(sd));
  // v51.6：缩放行原来单独用 .ctl-grp 包一层（[−]值[+]和🎯分两段），三行统一样式
  // 之后这层包装已经不需要了——缩放现在和俯仰/方位同一种【图标−滑杆+读数】结构，
  // 不用再分两段。这条断言改成钉"确实还是三行分组"这件事本身，不再钉 .ctl-grp
  // 这个已经被统一掉的实现细节。
  T('栏⑤-右下工具栏按"缩放 / 复位 / 角度"分行分组（原来 8 个控件平铺一长条）',
    (html.match(/class="ctl-row"/g) || []).length >= 3);
  // 用户："右下角工具栏重做。"—— 上一版只是重排了版式，真正难看的是**默认外观的滑杆**
  //（Chrome 蓝轨白钮），与整套深色玻璃 UI 完全不是一套。这一版把滑杆自绘了。
  T('栏⑤-滑杆自绘（两套厂商前缀都要有：少一套那个浏览器就退回默认外观）',
    /#canvasControls input\[type=range\] \{[^}]*-webkit-appearance: none/.test(html)
    && /::-webkit-slider-runnable-track/.test(html) && /::-webkit-slider-thumb/.test(html)
    && /::-moz-range-track/.test(html) && /::-moz-range-thumb/.test(html));
  T('栏⑤-滑杆拇指用主题色，不是浏览器默认蓝',
    /::-webkit-slider-thumb \{[^}]*background: var\(--accent\)/.test(html));
  T('栏⑤-角度那两行改用图标标签（中文标签 + 默认滑杆是上一版难看的根源）',
    /<span class="ctl-name" title="视角俯仰角">⛰<\/span>/.test(html)
    && /<span class="ctl-name" title="视角方位">🧭<\/span>/.test(html));
  // v51.6：三行控件统一样式后，#zoomLabel（百分比读数）被删除了（用户定稿"视角
  // 大小不需要数值，放重置视角按钮"），换成 #zoomSlider；俯仰/方位两行新增了
  // −/+ 步进按钮。控件 id 列表跟着改，其余没变的 id（缩放/复位/俯仰/方位滑杆与
  // 读数）依旧一个没动。
  T('栏⑤-工具栏的控件 id 一个都没改（main.js 与 CanvasController 按 id 接线）',
    ['zoomInBtn', 'zoomOutBtn', 'resetViewBtn', 'zoomSlider', 'elevSlider', 'elevLabel',
     'elevDownBtn', 'elevUpBtn', 'azimSlider', 'azimLabel', 'azimDownBtn', 'azimUpBtn']
      .every(id => new RegExp(`id="${id}"`).test(html)));
  T('栏⑥-顶栏左侧的读数 id 一个都没改（UIManager 按 id 刷新）',
    ['waveNum', 'waveTimer', 'towerCount', 'minionCount', 'scoreBlue', 'scoreRed']
      .every(id => new RegExp(`id="${id}"`).test(html)));
}

// ==================== 六、掉血拖尾只有一份实现 ====================
{
  const { stepTrail, TRAIL_COLOR, TRAIL_RATE } = await import('../src/presentation/barTrail.js');
  const ul = srcOf('src/presentation/UnitLayer.js');
  const um = srcOf('src/ui/UIManager.js');
  const html = srcOf('index.html');

  T('尾①-首帧/回血直接贴齐，不走动画', (() => {
    const a = stepTrail(-1, 0.5, 0.016, 1 / 64);
    const b = stepTrail(0.4, 0.9, 0.016, 1 / 64);
    return a.disp === 0.5 && a.trailing === false && b.disp === 0.9 && b.trailing === false;
  })());
  T('尾①-掉血时残段留在旧值、逐帧追上来', (() => {
    const s1 = stepTrail(0.9, 0.4, 0.016, 1 / 64);
    return s1.trailing === true && s1.disp < 0.9 && s1.disp > 0.4;
  })());
  T('尾①-差值小于一个像素就贴齐并结束动画（不然动画永远不结束）', (() => {
    const s = stepTrail(0.4 + 1 / 300, 0.4, 0.016, 1 / 64);
    return s.trailing === false && s.disp === 0.4;
  })());
  // ⚠️ 这里**不能**断言"帧率无关"。画面里那份用的是线性近似 `min(1, dt·RATE)`，
  // 不是 `1 − e^(−dt·RATE)`，所以同样的总时长下步数越多收敛越慢
  //（10×0.01s 剩 0.93^10≈0.48，1×0.1s 剩 0.30）。我第一版按"帧率无关"写，
  // 断言当场红了 —— 是断言的前提错了，不是实现退化。
  // 本轮的任务是"面板统一到画面那一份"，不是改画面那份的手感，所以照原样保留，
  // 只钉住真正成立的两条：单调收敛、且 dt 越大追得越多（并且被 1 夹住不会过冲）。
  T('尾①-单调收敛：每一步都更接近真实血量，且永不越过', (() => {
    let d = 1.0, ok = true;
    for (let i = 0; i < 40; i++) {
      const n = stepTrail(d, 0.2, 0.016, 0).disp;
      if (!(n <= d && n >= 0.2)) ok = false;
      d = n;
    }
    return ok && d < 0.25;
  })());
  T('尾①-dt 越大追得越多，且一大步也不会冲过头（min(1, …) 夹住）', (() => {
    const slow = stepTrail(1, 0, 0.01, 0).disp;
    const fast = stepTrail(1, 0, 0.05, 0).disp;
    const huge = stepTrail(1, 0, 10, 0).disp;
    return fast < slow && huge === 0;
  })());

  T('尾②-两处都调同一个 stepTrail（不再各写一份缓动）',
    /stepTrail\(en\.dispFrac, realFrac, dt, 1 \/ BAR_W\)/.test(ul)
    && /stepTrail\(el\._frac, hpFrac, dt, 1 \/ 300\)/.test(um));
  T('尾②-旧的那份缓动公式已经删干净（0.05^dt 那条）',
    !/Math\.pow\(0\.05, dtSec\)/.test(um));
  T('尾③-颜色统一：画面里读常量，面板的 CSS 用同一个值',
    /fillStyle = TRAIL_COLOR/.test(ul)
    && TRAIL_COLOR === 'rgba(255,150,150,0.6)'
    && /\.bar-hp-trail \{[^}]*background: rgba\(255,150,150,0\.6\)/.test(html));
  T('尾③-面板那层多余的 CSS transition 已去掉（JS 每帧缓动 + CSS 再缓动 = 慢三四倍）',
    !/\.bar-hp-trail \{[^}]*transition:/.test(html));
  T('尾④-缓动系数是个具名常量，调手感只改一处', TRAIL_RATE === 7);
}

done();
