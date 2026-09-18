/**
 * sim_dmgstats.mjs —— v51.29（Q3）伤害统计窗口数据模型验收
 *
 * 用户："应该分类统计每种不同的单位对该单位造成的伤害，比如红方远程兵XX，红方
 * 近战兵XX，巨龙XX等。并且需要添加，已回复的生命值/护盾值。已缓和的伤害（由于
 * 抗性/伤害减免等没有承受的生命值）。" 追加："如果攻击者已经死了，那也全做该
 * 类型小兵造成的伤害。"
 *
 * 排查发现的遗留 bug（本次顺带修复，见 CombatSystem._resolveHit 的头注）：
 * 小兵死亡后会被 EntityContainer.purgeDead() 立刻移出容器（塔留废墟不会），子弹
 * 飞行期间攻击者死亡+被移出容器时，原来的 `!attacker → return` guard 会把整发
 * 命中丢弃、不造成任何伤害——这与 v49 定稿的"攻击者死了不影响已经发出去的这
 * 一发"直接矛盾。这里一并验收：命中仍然生效，且分类落在 hitInfo 开火时快照的
 * 攻击者类别上（不会因为攻击者已经消失就退化成"环境/未知来源"）。
 *
 * 每条断言钉行为形状，不钉具体数字（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';
import { attackerCategoryOf, ENV_CATEGORY, FACTION_LABEL, TOWER_TIER_LABEL } from '../src/core/damageAttribution.js';
import { grantTempShield } from '../src/core/healing.js';

setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('Q3-伤害统计数据模型验收');

async function world() {
  const w = await makeWorld();
  w.fx.setStatSource(w.ents, w.attr);
  return w;
}

// ==================== 一、attackerCategoryOf 纯函数 ====================
{
  T('一①-无攻击者归为环境/未知来源', attackerCategoryOf(null, {}).key === ENV_CATEGORY.key);
  const minion = { type: 'ranged', _mapFaction: 'red' };
  const cat = attackerCategoryOf(minion, { ranged: { label: '远程兵' } });
  T('一②-小兵按阵营+兵种分类', cat.key === 'red:ranged' && cat.label === '红方远程兵');
  const tower = { type: 'tower', _mapFaction: 'blue', _mapTier: 'outer' };
  const tcat = attackerCategoryOf(tower, {});
  T('一③-塔按阵营+层级分类', tcat.key === 'blue:tower:outer' && tcat.label === `${FACTION_LABEL.blue}${TOWER_TIER_LABEL.outer}`);
  const dragon = { type: 'dragon', _mapFaction: 'neutral' };
  T('一④-巨龙统一归为"巨龙"（用户举例没有按元素细分）', attackerCategoryOf(dragon, {}).key === 'dragon'
    && attackerCategoryOf(dragon, {}).label === '巨龙');
  // 只读字段，不查容器——传一个已经"不在容器里"的裸对象也该正常工作
  const detached = { type: 'melee', _mapFaction: 'red' };
  T('一⑤-只读字段不查容器，传入脱离容器的快照对象也能正确分类',
    attackerCategoryOf(detached, { melee: { label: '近战兵' } }).label === '红方近战兵');
}

// ==================== 二、performAttackDirect 按分类累计伤害 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const atk = mkEntity(ents, 'ranged', { faction: 'red', stats: { attackDamage: 100, armor: 0, magicResist: 0 } }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  combat.performAttackDirect(atk.id, tgt.id, 100, 'physical', {});
  const byAtk = tgt._dmgByAttacker;
  T('二①-伤害按攻击者类别分桶记录', byAtk instanceof Map && byAtk.size === 1);
  const bucket = [...byAtk.values()][0];
  T('二②-分桶累计了正确的伤害量与命中次数', bucket.total > 90 && bucket.total < 110 && bucket.count === 1);
  T('二③-分桶标签是中文类别名（红方远程兵）', bucket.label.includes('红方') && bucket.label.includes('远程'));

  // 多次命中同一类别应该累加到同一个桶，不是各开一个
  combat.performAttackDirect(atk.id, tgt.id, 100, 'physical', {});
  T('二④-同一类别的多次命中累加到同一个桶', tgt._dmgByAttacker.size === 1 && [...tgt._dmgByAttacker.values()][0].count === 2);
}

// ==================== 三、攻击者已死（且已被移出容器）：伤害仍然生效，且分类不退化 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const atk = mkEntity(ents, 'ranged', { faction: 'red', stats: { attackDamage: 100, armor: 0, magicResist: 0 } }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  // 模拟"子弹已经在飞、攻击者随后死亡并被移出容器"：手工搭一份 hitInfo（开火那一刻
  // 会做的事——resolveAttackType/穿透四项/攻击者类别都已经快照好了），然后把攻击者
  // 杀死并从容器移除，再调用 _resolveHit（子弹落地时才会调用这个函数）。
  const hitInfo = {
    attackerId: atk.id, targetId: tgt.id,
    baseDamage: 100, onHitFixed: 0, onHitPctBase: 0, dmgAmp: 0, preDamageMult: 1,
    attackType: 'physical', isCrit: false, critMult: 200,
    armorPenPercent: 0, armorPenFlat: 0, magicPenPercent: 0, magicPenFlat: 0,
    weaponId: null, weaponInstId: null,
    attackerCategory: { key: 'red:ranged', label: '红方远程兵' },
  };
  atk.alive = false;
  ents.remove(atk.id);
  T('三①-前置条件：攻击者确实已经从容器里查不到了', ents.get(atk.id) === null);

  const hpBefore = tgt.currentHP;
  combat._resolveHit(hitInfo);
  T('三②-攻击者已死+已移出容器时，命中依然造成伤害（不再被整发丢弃）', tgt.currentHP < hpBefore);
  const byAtk = tgt._dmgByAttacker;
  T('三③-伤害正确归类到开火时快照的攻击者类别，没有退化成"环境/未知来源"',
    byAtk instanceof Map && byAtk.has('red:ranged') && !byAtk.has(ENV_CATEGORY.key));
}

// ==================== 四、EffectRegistry 的 casterCategory 快照：DOT 施法者死后仍归类正确 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const caster = mkEntity(ents, 'warlock', { faction: 'blue', stats: {} }, CONFIG);
  const tgt = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, maxHP: 100000 } }, CONFIG);

  fx.apply(caster.id, { kind: 'dot', name: '测试毒', statKey: null, flatValue: 20, duration: 5 }, 'test_poison', { casterId: caster.id });
  const eff = fx.getEffects(caster.id)[0];
  T('四①-施法者存活时，效果实例带上了 casterCategory 快照', !!eff.casterCategory && eff.casterCategory.key === 'blue:warlock');

  // 施法者死亡并移出容器（DOT 逐帧 tick 时施法者早就不在了是常见场景）
  caster.alive = false;
  ents.remove(caster.id);
  combat.performAttackDirect(eff.casterId ?? 0, tgt.id, 20, 'magic', { basicAttack: true, attackerCategory: eff.casterCategory });
  T('四②-DOT 施法者已死+已移出容器，伤害仍归类到快照的类别（术士兵），不退化成环境',
    tgt._dmgByAttacker?.has('blue:warlock') && !tgt._dmgByAttacker?.has(ENV_CATEGORY.key));
}

// ==================== 五、已缓和的伤害（不含护盾吸收） ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const atk = mkEntity(ents, 'ranged', { faction: 'red', stats: { attackDamage: 100 } }, CONFIG);
  const tgtNoDef = mkEntity(ents, 'tower', { stats: { armor: 0, magicResist: 0, damageReduction: 0, maxHP: 100000 } }, CONFIG);
  const tgtTanky = mkEntity(ents, 'tower', { stats: { armor: 100, magicResist: 0, damageReduction: 20, maxHP: 100000 } }, CONFIG);

  combat.performAttackDirect(atk.id, tgtNoDef.id, 100, 'physical', {});
  T('五①-无任何抗性/减伤时，已缓和的伤害应为 0（或接近 0）', !(tgtNoDef._dmgMitigatedTotal > 1));

  combat.performAttackDirect(atk.id, tgtTanky.id, 100, 'physical', {});
  T('五②-有护甲+伤害减免时，应记录到一笔正的已缓和伤害', tgtTanky._dmgMitigatedTotal > 0);

  // 真实伤害应无视抗性/减伤——不产生"已缓和"这个概念
  const tgtTrue = mkEntity(ents, 'tower', { stats: { armor: 100, magicResist: 100, damageReduction: 50, maxHP: 100000 } }, CONFIG);
  combat.performAttackDirect(atk.id, tgtTrue.id, 100, 'true', {});
  T('五③-真实伤害无视一切防御手段，已缓和的伤害恒为 0', !(tgtTrue._dmgMitigatedTotal > 0));
}

// ==================== 六、已获得护盾值累计 ====================
{
  const { ents, fx, combat, CONFIG } = await world();
  const e = mkEntity(ents, 'tower', { stats: { maxHP: 1000 } }, CONFIG);

  // ① 临时护盾（healing.js 唯一入口）
  grantTempShield(e, 50, 1);
  T('六①-临时护盾发放会累加到 _shieldGainedTotal', e._shieldGainedTotal === 50);
  grantTempShield(e, 30, 1);
  T('六②-多次发放累加而不是覆盖', e._shieldGainedTotal === 80);

  // ② kind:'shield' 效果：新增/叠层记为获得，效果到期消耗不算负的获得
  // perStackFlat 必须给一个非零值，否则叠层不会改变 totalFlat（delta=0），
  // 那种情况下"不记录获得"才是对的行为，不是这条断言想测的场景。
  fx.apply(e.id, { kind: 'shield', name: '测试护盾', flatValue: 100, perStackFlat: 100, duration: 10, stackPolicy: 'stack', maxStacks: 3 }, 'test_shield', {});
  T('六③-kind:shield 效果新增记为获得', e._shieldGainedTotal === 180);
  fx.apply(e.id, { kind: 'shield', name: '测试护盾', flatValue: 100, perStackFlat: 100, duration: 10, stackPolicy: 'stack', maxStacks: 3 }, 'test_shield', {});
  T('六④-kind:shield 效果叠层（增量）也记为获得', e._shieldGainedTotal === 280);
}

// ==================== 七、重新设计后的 HP 统计窗口：环状图 + 新增小节 ====================
// 用户："可以适当用图表（环状图等）实现。全是文字看着太累。" ——用最小的 FakeOverlay
// 模拟 DOM（跟 sim_qualitybatch.mjs 里 Q6 那套一致），只断言渲染出来的 HTML
// 里含不含预期的小节标题/数值，不测 CSS 像素级细节。
{
  const { UIManager } = await import('../src/ui/UIManager.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { ents, fx, CONFIG } = await world();

  class FakeOverlay {
    constructor() { this.id = ''; this.className = ''; this._html = ''; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    querySelector(sel) { return sel === '.stat-doc-close' ? { addEventListener() {} } : null; }
    remove() {}
  }
  let captured = null;
  globalThis.document = {
    getElementById: () => null,
    createElement: () => new FakeOverlay(),
    body: { appendChild: (el) => { captured = el; } },
  };
  const ui = Object.create(UIManager.prototype);
  ui.attrCalc = AttributeCalculator;
  ui.effects = fx;

  const e = mkEntity(ents, 'tower', { stats: { maxHP: 1000, armor: 0, magicResist: 0 } }, CONFIG);
  e.currentHP = 700;
  e._dmgTaken = { physical: 70, magic: 30, true: 5 };
  e._dmgByAttacker = new Map([
    ['red:ranged', { total: 60, count: 3, label: '红方远程兵' }],
    ['red:melee', { total: 40, count: 2, label: '红方近战兵' }],
    ['dragon', { total: 5, count: 1, label: '巨龙' }],
  ]);
  e._dmgMitigatedTotal = 42;
  e._shieldGainedTotal = 88;
  e._healReceivedTotal = 123;

  ui._showHpStatsModal(e);
  const html = captured._html;
  T('七①-新增"承伤 — 按来源"小节标题', /承伤 — 按来源/.test(html));
  T('七②-按来源小节列出了各分类的中文标签', html.includes('红方远程兵') && html.includes('红方近战兵') && html.includes('巨龙'));
  T('七③-新增"减免与格挡"小节，显示已缓和的伤害数值', /减免与格挡/.test(html) && />42</.test(html));
  T('七④-护盾构成小节新增"累计已获得护盾"一行', /累计已获得护盾[\s\S]{0,20}>88</.test(html));
  T('七⑤-环状图用 conic-gradient 画环、radial-gradient 遮罩抠洞（没有引入任何图表库）',
    /conic-gradient/.test(html) && /mask:radial-gradient/.test(html));

  // 没有任何按来源数据时，不应该崩溃，应该显示一个空白圆环占位（用户先否掉了图标
  // 占位——"我说用图表占位是指用进度为0的进度条占位，不是用个图表的图标占位"——
  // 后来又否掉了横条占位——"生命统计的窗口无数据的地方用进度条代替，应该是用
  // 同类型同大小的圆环空白进度条代替啊！你弄个横向的进度条是什么意思"，见
  // _emptyChartHtml：现在跟有数据时的环状图同一个尺寸/同一套 mask 挖洞手法，
  // 只是填灰色不画分段）。
  const empty = mkEntity(ents, 'tower', { stats: { maxHP: 1000 } }, CONFIG);
  ui._showHpStatsModal(empty);
  T('七⑥-没有按来源数据时优雅降级，不抛异常且用同尺寸的空白圆环占位（不是横条、不是图标、也不只是纯文字）',
    typeof captured._html === 'string' && /暂无数据/.test(captured._html)
    && /border-radius:50%;[\s\S]{0,60}background:var\(--panel-soft/.test(captured._html)
    && /width:84px;height:84px/.test(captured._html));
}

done();
