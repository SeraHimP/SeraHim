import { CONFIG } from '../data/Config.js';
import { dragonCfg, dragonStatsAt, dragonIntervalAt } from '../data/dragonCurve.js';

/**
 * DragonSystem.js
 *
 * 龙魂系统（参考 LoL 元素龙机制）：
 * - 每隔固定时间刷新一条元素龙，与普通波次同时存在
 * - 击杀元素龙给所有塔叠加对应永久增益
 * - 累计击杀达到门槛后，按击杀最多的元素解锁唯一龙魂（装备到所有塔）
 * - 解锁后只刷新远古巨龙，击杀提供额外远古增益并强化龙魂
 */

// 8 种元素龙定义：击杀后给所有塔叠加的增益（永久，可叠加同种）
/**
 * ==================== 元素龙清单（v44 重排）====================
 * 用户定稿："光龙直接删除吧" —— 元素与魂**一并**删除，剩七条。
 * 删的理由记在这里，免得下一个人以为是漏了：塔无限重生会把对局拖成平局；
 * 而且它在 v43 的对照里整档与基线逐位相同 —— 当时它根本没接上
 *（respawnRuleFor 从没被调用过）。
 *
 * `power` 不再在这里写死数值，改为指向 CONFIG.dragonPower 里的同名键 ——
 * 硬约束是"一切数值软编码"，写在这个 export const 里编辑器改不了。
 * 每个元素的属性**互不重复**（用户定稿："+最大生命值只是山龙的增益，其他的没有"），
 * sim_v44.mjs 里有一条断言盯着这件事。
 */
export const DRAGON_ELEMENTS = {
  fire:    { key: 'fire',    label: '炎龙', icon: '🔥', color: '#e74c3c', soul: 'dragonsoul_fire' },
  water:   { key: 'water',   label: '潮龙', icon: '🌊', color: '#3498db', soul: 'dragonsoul_water' },
  earth:   { key: 'earth',   label: '山龙', icon: '🗿', color: '#95a5a6', soul: 'dragonsoul_earth' },
  thunder: { key: 'thunder', label: '雷龙', icon: '⚡', color: '#f1c40f', soul: 'dragonsoul_thunder' },
  wind:    { key: 'wind',    label: '风龙', icon: '🌪', color: '#1abc9c', soul: 'dragonsoul_wind' },
  dark:    { key: 'dark',    label: '暗龙', icon: '🌑', color: '#8e44ad', soul: 'dragonsoul_dark' },
  poison:  { key: 'poison',  label: '毒龙', icon: '☠️', color: '#27ae60', soul: 'dragonsoul_poison' },
};

/**
 * 某元素的【巨龙之力】属性表（每层）。数值住在 CONFIG.dragonPower，可在编辑器里改。
 * 返回 [{ statKey, flat, percent }]；空数组表示该元素没有配置（不该发生，但不炸）。
 * 约定：键名以 `Pct` 结尾的算百分比，其余算固定值 —— 这样配置里只写一层对象，
 * 不必给每一项都套 { flat } / { percent } 的壳。
 */
export function dragonPowerBuffs(el) {
  const tbl = (CONFIG.dragonPower && CONFIG.dragonPower[el]) || null;
  if (!tbl) return [];
  return Object.entries(tbl).map(([k, v]) => (
    k.endsWith('Pct')
      ? { statKey: k.slice(0, -3), percent: v }
      : { statKey: k, flat: v }
  ));
}

export class DragonSystem {
  constructor(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.effects = effectRegistry;
    this.skills = skillLibrary;
    this.attrCalc = attrCalc;
    this.config = CONFIG.gameRules;

    this.nextDragonTime = dragonCfg().firstDelay; // 首条元素龙：开局60秒（软编码）
    this.paused = true; // 开局默认暂停巨龙生成（用户要求：巨龙系统待大改，先默认关闭；原开关照常可开启）
    this.createEntity = null;
    this.elementDragonSpawned = 0; // 已刷新的元素龙数
    this.ancientSpawned = 0;       // 已刷新的远古龙数

    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;

    // ==================== 阵营龙魂规则（用户定稿）====================
    // 「6 条龙 + ≥4 击杀才成魂、都不到 4 则无魂、之后出远古龙」
    //
    // 改这块之前的实现是**按塔**结算的：每座塔各记自己的击杀、各自到 4 条解锁
    // 自己的魂。那既不是 LoL 的口径也不是用户要的 —— 龙魂是**阵营级**的战利品，
    // 一方拿到全军受益，另一方什么都没有。按塔算的结果是双方都能慢慢攒够、
    // 龙魂从"争夺目标"退化成"时间到了就有"，整个争龙的博弈就没有了。
    //
    // 现在：元素龙总共 elementDragonTotal（默认 6）条。每条龙的击杀归属到阵营。
    // 6 条打完后结算一次：谁 ≥ soulThreshold（默认 4）谁成魂；都不到则**无魂**
    // （3:3 是合法结局，不是需要兜底的边界）。结算后转入远古龙阶段。
    this.factionKills = { blue: {}, red: {} };   // 阵营 → { 元素: 次数 }
    this.factionTotals = { blue: 0, red: 0 };
    this.souls = { blue: [], red: [] };          // 阵营 → 已获得的龙魂 id
    this.soulResolved = false;                   // 是否已结算过龙魂
    this.soulOwner = null;                       // 成魂阵营（null = 无魂）
    this._nextPitSide = 'top';                   // v43：上/下龙坑交替，首条从上坑出

    this._bindDeath();
  }

  /**
   * v43：把巨龙系统整个退回开局状态（供"重置本局"调用）。
   *
   * 刻意**不**动 this.paused、this.createEntity、以及 CONFIG 里的任何配置 ——
   * 前两个是"这局怎么跑"的接线，后者是玩家在编辑器里调过的设置。
   * 用户对重置的定义是"按照目前现有的地图+属性等从头重新来一局"，
   * 也就是说：局内进度清空，玩家的调参保留。
   */
  resetRun() {
    this.nextDragonTime = dragonCfg().firstDelay;
    this.elementDragonSpawned = 0;
    this.ancientSpawned = 0;
    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;
    this.factionKills = { blue: {}, red: {} };
    this.factionTotals = { blue: 0, red: 0 };
    this.souls = { blue: [], red: [] };
    this.soulResolved = false;
    this.soulOwner = null;
    this._nextPitSide = 'top';
  }

  /** 元素龙总数与成魂门槛（软编码）。 */
  get _soulRule() {
    const g = CONFIG.gameRules || {};
    return {
      total: g.elementDragonTotal ?? 6,
      threshold: g.dragonSoulThreshold ?? 4,
    };
  }

  /**
   * WorldState 读这个接口把龙魂并进世界状态层。
   * 此前**这个方法根本不存在** —— WorldState 里写的是 `this.dragons?.getSouls?.()`，
   * 可选调用把缺失静默吞掉了，于是"龙魂已接入 WorldState"其实一直是空转。
   */
  getSouls() {
    return { blue: [...this.souls.blue], red: [...this.souls.red] };
  }

  setCreateEntity(fn) { this.createEntity = fn; }

  _bindDeath() {
    this.eventBus.on('entity:death', ({ entityId }) => {
      const e = this.entities.get(entityId);
      if (e && e.type === 'dragon') this._onDragonKilled(e);
    });
  }

  // 下一条龙的刷新间隔（秒）——龙刷新后从此刻起重新计时。
  // 这里原先是一串写死的 300/600/7*60/8*60/9*60。数值本身没错，但"巨龙多久刷一条"
  // 是最该让用户调的东西之一，却只能改源码。现在读 CONFIG.gameRules.dragon，
  // 实现在 data/dragonCurve.js —— 与模板编辑器的预览是**同一个函数**。
  _nextInterval() {
    return dragonIntervalAt({
      soulUnlocked: this.soulUnlocked,
      elementSpawned: this.elementDragonSpawned,
      ancientSpawned: this.ancientSpawned,
    });
  }

  update(dt) {
    // v43：两个独立开关（用户定稿）。spawn 关掉 = 这局没有龙。
    // effect 那个开关不在这里 —— 龙照常刷、照常结算归属，只是不发放增益，
    // 这样才能量出"有龙但没魂"的平衡基线。
    this._expireAncient();   // v43：远古之力是限时的，到点摘掉
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.spawn === false) return;
    if (this.paused) return;
    const alive = this.entities.getByType('dragon', true);
    if (alive.length > 0) return;

    this.nextDragonTime -= dt;
    if (this.nextDragonTime <= 0) {
      this.spawnDragon();
      this.nextDragonTime = this._nextInterval();
    }
  }

  // 巨龙绝对属性曲线——按"这是第几条元素龙"（1~4），而非游戏波次驱动。
  // 之前的 bug：龙按固定时间表刷新，但公式用 window.waveNumber 计算，
  // 导致波次早已跑远时（如7分钟后刷第2条龙时波次可能已到10+），
  // 数值远超预期（双抗几百）。改为用龙的刷新序号，增长曲线可预期、可控。
  // 参考：第1→4条：生命 1200→3000，双抗 -40→200，攻击力 23→252。
  //
  // 三条曲线原先是六行写死的分段线性式。形状一样、只有系数不同，所以收敛成一条
  // 参数化曲线搬进 data/dragonCurve.js，系数进 CONFIG.gameRules.dragon.curve。
  // 默认值与原式**逐位相同**（tests/sim_tpleditor.mjs 有断言守着）。
  _dragonStats(dragonIndex, isAncient) {
    return dragonStatsAt(dragonIndex, isAncient);
  }

  /**
   * v43：奖励的领受范围 —— 全部塔 + 大型小兵（= 除近战/远程外的所有兵种）。
   * 用户重新规定过一次："除了近战兵和远程兵都是。"
   * 刻意**不读 isLargeMinion**：那个标记还被渲染体积等处用着，
   * 把"体型"和"够不够格拿龙魂"绑死在一个字段上，改一个必然误伤另一个。
   */
  static SOUL_REWARD_OK(e) {
    if (!e) return false;
    if (e.type === 'tower') return true;
    if (e.type === 'dragon') return false;
    return e.type !== 'melee' && e.type !== 'ranged';
  }

  spawnDragon() {
    const isAncient = this.soulUnlocked;

    // 元素龙用"第几条龙"（elementDragonSpawned+1）；远古龙用"第几条远古龙"，
    // 均与游戏波次解耦，避免龙按固定时间表刷新导致数值随波次失控增长。
    const dragonIndex = isAncient ? (this.ancientSpawned + 1) : (this.elementDragonSpawned + 1);
    const dstats = this._dragonStats(dragonIndex, isAncient);

    let element = null;
    if (!isAncient) {
      const keys = Object.keys(DRAGON_ELEMENTS);
      element = keys[Math.floor(Math.random() * keys.length)];
      this.elementDragonSpawned++;
    } else {
      this.ancientSpawned++;
    }

    // v43：上/下龙坑**交替**。上坑的走上路推**蓝方**基地，下坑的走下路推**红方**基地。
    // 交替而不是随机：随机会出现"连着三条都压同一方"，那不是压力是处刑。
    const pitSide = this._nextPitSide;
    this._nextPitSide = (pitSide === 'top') ? 'bot' : 'top';
    if (this.createEntity) {
      this.createEntity('dragon', { element, isAncient, absStats: dstats, pitSide });
    }

    const label = isAncient ? '🐲 远古巨龙' : `${DRAGON_ELEMENTS[element].icon} ${DRAGON_ELEMENTS[element].label}`;
    this.eventBus.emit('dragon:spawn', { element, isAncient, label });
  }

  /**
   * ==================== v43：击杀结算全部重写 ====================
   * 用户定稿："杀死（最后一击）的队伍全部塔 + 大型小兵（除了近战/远程之外）的兵获得增益效果。"
   *
   * 与改动前的三处关键差别：
   *   ① 归属从"参与塔投票"改成 **最后一击**（_lastHitFaction，由 CombatSystem 记录）。
   *      投票制的问题：一条龙被双方轮流打，谁塔多谁拿 —— 抢龙这件事就没有博弈了。
   *   ② 奖励对象从"参与的那几座塔"扩到 **该阵营全体塔 + 全体大型小兵**，
   *      而且**新生成的单位也要补发**（走 _grantAll / equipExistingSoul），
   *      否则奖励只对当时在场的生效，后面出的兵全是裸的。
   *   ③ 成魂时机从"6 条龙全部刷完再结算"改成 **拿满 4 条立即成魂**，
   *      之后元素龙停刷、只出远古龙（用户定稿）。紧迫感完全不同：
   *      旧规则下前 5 条龙谁拿都无所谓，反正最后一起算。
   */
  _onDragonKilled(dragon) {
    const owner = dragon._lastHitFaction || null;   // 最后一击的阵营（可能为 null=沙盒/环境击杀）

    if (dragon._isAncient) {
      this.ancientKills++;
      // 远古之力是**限时** 240 秒的处决（八条龙魂里唯一限时的一条）。
      if (owner) this._grantAncient(owner);
      this.eventBus.emit('dragon:killed', { ancient: true, ancientKills: this.ancientKills, owner });
      return;
    }

    const el = dragon._element;
    if (!el) return;
    this.killCounts[el] = (this.killCounts[el] || 0) + 1; // 全局统计（仅用于显示）
    this.totalKills++;

    if (owner === 'blue' || owner === 'red') {
      this.factionKills[owner][el] = (this.factionKills[owner][el] || 0) + 1;
      this.factionTotals[owner]++;
      // 巨龙之力：给该阵营**全体**（塔 + 大型小兵）叠一层该元素的永久增益
      this._grantAll(owner, (e) => this._applyElementBuff(e, el));
      // 把击杀数灌给 CombatSystem —— 龙的「宿怨」被动要按它算减伤/增伤
      this._pushKillCounts();
    }

    this.eventBus.emit('dragon:killed', {
      element: el, owner, totalKills: this.totalKills, killCounts: { ...this.killCounts },
      factionTotals: { ...this.factionTotals },
    });

    // ---- 拿满门槛 → **立即**成魂（v43：不再等 6 条全刷完）----
    if (!this.soulResolved && owner && this.factionTotals[owner] >= this._soulRule.threshold) {
      this._resolveSoul(owner);
    }
  }

  /** 把"各阵营已击杀的元素龙数"同步给 CombatSystem（龙的宿怨被动读它）。 */
  _pushKillCounts() {
    const combat = this._combat || (typeof window !== 'undefined' && window.CTX?.__app?.combatSystem);
    if (combat && combat.setDragonKillCounts) {
      combat.setDragonKillCounts({ blue: this.factionTotals.blue, red: this.factionTotals.red });
    }
  }
  /** main.js 注入，供上面那个函数用（不注入时退化为读 window，单测里两条都可缺省）。 */
  setCombatSystem(combat) { this._combat = combat; this._pushKillCounts(); }

  /**
   * 对某阵营的**全部**领受者（塔 + 大型小兵）执行 fn。
   * 领受范围判定走 SOUL_REWARD_OK —— 见那个函数的注释。
   */
  _grantAll(faction, fn) {
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return 0;
    let n = 0;
    for (const e of this.entities.getAll(true)) {
      if (!DragonSystem.SOUL_REWARD_OK(e)) continue;
      if ((e._mapFaction || e.faction) !== faction) continue;
      fn(e); n++;
    }
    return n;
  }

  /**
   * 新单位入场时补发本阵营已有的全部龙之奖励。
   * **这条不能省**：龙魂/巨龙之力都是永久的，只发给"当时在场"的话，
   * 后面每一波新兵都是裸的 —— 那等于奖励在几十秒后就自动失效了。
   * main.js 的 createBuilding / createMinion 在实体入场后调它。
   */
  equipExistingSoul(entity) {
    if (!DragonSystem.SOUL_REWARD_OK(entity)) return false;
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return false;
    const fac = entity?._mapFaction || entity?.faction;
    if (fac !== 'blue' && fac !== 'red') return false;
    let any = false;
    // ① 巨龙之力：按该阵营每种元素已击杀的条数逐层补
    for (const [el, cnt] of Object.entries(this.factionKills[fac] || {})) {
      for (let i = 0; i < cnt; i++) { this._applyElementBuff(entity, el); any = true; }
    }
    // ② 龙魂本体
    if (this.soulOwner === fac && this.souls[fac]?.[0]) {
      this._equipSoul(entity, this.souls[fac][0]); any = true;
    }
    return any;
  }

  /**
   * v43：**拿满门槛立即成魂**（用户定稿："某阵营拿满 4 条直接获得龙魂，
   * 然后不再生成元素龙而是一直生成远古龙"）。
   *
   * 旧规则是"6 条元素龙全部刷完再一次性结算，谁多谁拿、都不到 4 则无魂"。
   * 它的问题是紧迫感为零：前 5 条龙谁拿都无所谓，反正最后一起算。
   * 改成"先到先得"之后，第 4 条龙就是全局的胜负手 —— 而龙的「宿怨」被动
   *（杀得越多龙对你越硬）恰好让这第 4 条最难抢，两条规则是配套的。
   *
   * 魂的元素 = 该阵营击杀最多的那一种。
   */
  _resolveSoul(owner) {
    this.soulResolved = true;
    if (owner) {
      const kills = this.factionKills[owner];
      let best = null, bestCount = -1;
      for (const [el, cnt] of Object.entries(kills)) {
        if (cnt > bestCount) { bestCount = cnt; best = el; }
      }
      if (best) {
        const soulId = DRAGON_ELEMENTS[best].soul;
        this.soulOwner = owner;
        this.souls[owner] = [soulId];
        // 发给该阵营**全体**（塔 + 大型小兵）；之后新生成的由 equipExistingSoul 补发
        this._grantAll(owner, (e) => this._equipSoul(e, soulId));
        this.eventBus.emit('dragon:soulResolved', {
          owner, element: best, soulId, label: DRAGON_ELEMENTS[best].label,
          factionTotals: { ...this.factionTotals },
        });
      }
    } else {
      this.eventBus.emit('dragon:soulResolved', {
        owner: null, element: null, soulId: null,
        factionTotals: { ...this.factionTotals },
      });
    }

    // 成魂后元素龙停刷，改为一直刷远古龙（用户定稿）
    this.soulUnlocked = true;
    this._unlockWave = (typeof window !== 'undefined' && window.waveNumber) || 0;
    this.ancientSpawned = 0;
    this.nextDragonTime = dragonCfg().ancientFirstDelay;
  }

  // v43：给单个**领受者**（塔或大型小兵）叠加一层元素增益。
  // 改名去掉 ToTower：奖励范围已扩到大型小兵，名字里带 Tower 会误导下一个人。
  _applyElementBuff(tower, el) {
    const def = DRAGON_ELEMENTS[el];
    if (!def) return;
    // v44：属性表从 DRAGON_ELEMENTS[].buff（写死）改为读 CONFIG.dragonPower（可编辑）。
    // 层数上限也从 99 改成 CONFIG.dragonPower.maxStacks（默认 4）——
    // 满 4 条就成魂、元素龙停刷，99 是个永远到不了的虚数，写在那里只会误导。
    const buffs = dragonPowerBuffs(el);
    const cap = (CONFIG.dragonPower && CONFIG.dragonPower.maxStacks) || 4;
    for (let i = 0; i < buffs.length; i++) {
      const b = buffs[i];
      this.effects.apply(tower.id, {
        name: `${def.label}之力`, icon: def.icon, kind: 'stat', color: def.color,
        statKey: b.statKey,
        flatValue: b.flat || 0, percentValue: b.percent || 0,
        perStackFlat: b.flat || 0, perStackPercent: b.percent || 0,
        duration: Infinity, permanent: true,
        stackable: true, maxStacks: cap, stackPolicy: 'stack',
        stackKey: `dragon_${el}_${b.statKey}`,
        descTemplate: `唯一被动——${def.label}之力：击杀${def.label}获得的永久增益（{stacks}层）。`,
        description: `${def.label}增益（{stacks}层）`,
      }, `dragon_buff_${el}_${i}`);
    }
  }

  // 注：这里原有 _unlockSoulForTower(tower)（"每座塔各自攒够 4 条就解锁自己的魂"）。
  // 它与用户定稿的阵营级规则冲突 —— 按塔算的话双方都能慢慢攒够，龙魂从"争夺目标"
  // 退化成"时间到了就有"，而且"都不到 4 则无魂"这条永远不会发生（每座塔各算各的，
  // 总有塔能到 4）。现已由 _resolveSoul() 的一次性阵营结算取代，故删除，
  // 不留下一个语义相反的旁路入口。

  /**
   * v43：远古龙奖励 = **限时 240 秒的处决**（用户定稿：八条龙魂全部永久，只有它限时）。
   *
   * 旧实现是"给参与的塔永久 +10% 全属性、每条叠一层"——纯数值、永久、只给塔。
   * 现在改成阵营级的限时技能：成魂后元素龙停刷、只出远古龙，**双方都能抢**，
   * 于是它成了落后方唯一的翻盘工具。处决专治"最后 20% 特别难啃"，
   * 恰好克制山魂/光魂/潮魂这三条防守型龙魂 —— 这是防止"一方成魂另一方不用玩了"的关键。
   */
  _grantAncient(faction) {
    const p = (CONFIG.dragonSouls && CONFIG.dragonSouls.ancient) || {};
    const dur = p.durationSec ?? 240;
    const n = this._grantAll(faction, (e) => {
      this._equipSoul(e, 'dragonsoul_ancient');
      // 限时：到点由 EffectRegistry 移除显示状态，同时把技能实例摘掉。
      // 这里用一个 display 效果做"倒计时可见"，真正的到期回收在 update 里按 _ancientUntil 走。
      this.effects.apply(e.id, {
        name: '远古之力', icon: '🐲', kind: 'display', type: 'buff', color: '#e67e22',
        duration: dur, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
        stackKey: 'dragon_ancient',
        description: `处决：对生命低于 ${p.executeAtPct ?? 20}% 的敌人额外造成 ${p.executePct ?? 20}% 最大生命真实伤害`,
      }, 'dragon_ancient_buff');
      e._ancientUntil = ((typeof window !== 'undefined' && window.gameTime) || 0) + dur;
    });
    this._ancientFaction = faction;
    return n;
  }

  /** 远古之力到期回收：把技能实例摘掉（显示状态由 EffectRegistry 自己过期）。 */
  _expireAncient() {
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    for (const e of this.entities.getAll(true)) {
      if (!e._ancientUntil || now < e._ancientUntil) continue;
      e._ancientUntil = 0;
      const arr = e._skillInstances || [];
      const i = arr.findIndex(x => x.skillId === 'dragonsoul_ancient');
      if (i >= 0) arr.splice(i, 1);
    }
  }

  // 注：早期版本这里有 _applyElementBuff(el) 和 equipSoulToAllTowers(soulId) 两个
  // "不分塔、批量发给所有塔"的方法，属于"全局龙魂"的旧设计。改成"每塔独立"之后
  // 项目里已经没有任何地方调用它们了（纯死代码），但留着是个真实隐患——对战模式下
  // 如果未来不小心调用了它们，会不分敌我地把增益/龙魂发给红蓝双方所有塔。已删除。

  _equipSoul(tower, soulId) {
    // 移除已有龙魂 + 其展示效果
    const existing = (tower._skillInstances || []).filter(s => s.skillId.startsWith('dragonsoul_'));
    for (const inst of existing) {
      const def = this.skills[inst.skillId];
      if (def?.onUnequip) def.onUnequip(tower.id, inst, this._ctx());
      const disp = this.effects.getEffects(tower.id).find(e => e.sourceId === `soul_display_${inst.skillId}`);
      if (disp) this.effects.remove(disp.id);
      tower._skillInstances = tower._skillInstances.filter(s => s !== inst);
    }
    if (!soulId) return;
    const inst = { id: ++window._uid, skillId: soulId, state: { ancientBonus: this.ancientKills } };
    tower._skillInstances.push(inst);
    const def = this.skills[soulId];
    if (def?.onEquip) def.onEquip(tower.id, inst, this._ctx());
    if (def) {
      this.effects.apply(tower.id, {
        name: def.name, icon: def.icon, color: def.color, kind: 'display',
        duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: def.descTemplate, description: def.description || '龙魂',
      }, `soul_display_${soulId}`);
    }
  }

  // 多选叠加版：装备/卸下某个龙魂时不影响其他已装备的龙魂（供龙魂穿梭框手动多选使用）。
  // 与 _equipSoul（单一替换，供击杀自动解锁使用）是两套独立入口。
  _toggleSoul(tower, soulId) {
    const existing = (tower._skillInstances || []).find(s => s.skillId === soulId);
    if (existing) {
      const def = this.skills[soulId];
      if (def?.onUnequip) def.onUnequip(tower.id, existing, this._ctx());
      const disp = this.effects.getEffects(tower.id).find(e => e.sourceId === `soul_display_${soulId}`);
      if (disp) this.effects.remove(disp.id);
      tower._skillInstances = tower._skillInstances.filter(s => s !== existing);
      return false; // 已卸下
    }
    const inst = { id: ++window._uid, skillId: soulId, state: { ancientBonus: this.ancientKills } };
    tower._skillInstances.push(inst);
    const def = this.skills[soulId];
    if (def?.onEquip) def.onEquip(tower.id, inst, this._ctx());
    if (def) {
      this.effects.apply(tower.id, {
        name: def.name, icon: def.icon, color: def.color, kind: 'display',
        duration: Infinity, permanent: true, stackPolicy: 'refresh', uniquePassive: true,
        descTemplate: def.descTemplate, description: def.description || '龙魂',
      }, `soul_display_${soulId}`);
    }
    return true; // 已装备
  }

  _ctx() {
    return {
      entityContainer: this.entities,
      effectRegistry: this.effects,
      eventBus: this.eventBus,
      waveNumber: window.waveNumber || 0,
      attrCalc: this.attrCalc,
    };
  }

  // 注：早期还有一个 setSoulManual(soulId) 方法（"全局手动设置当前龙魂"），
  // 同属旧的"全局龙魂"设计，项目里同样没有任何调用点（现在的龙魂穿梭框 UI
  // 用的是 _toggleSoul，每塔独立、可多选叠加，完全不走这条路径）。一并清理，
  // 避免留下一个内部调用了已删除方法的坏函数。

  getState() {
    const { total, threshold } = this._soulRule;
    return {
      killCounts: { ...this.killCounts },
      totalKills: this.totalKills,
      soulUnlocked: this.soulUnlocked,
      ancientKills: this.ancientKills,
      nextDragonTime: this.nextDragonTime,
      // 阵营龙魂规则的可观测状态（UI 与验收都读这里）
      elementDragonSpawned: this.elementDragonSpawned,
      elementDragonTotal: total,
      soulThreshold: threshold,
      factionTotals: { ...this.factionTotals },
      soulResolved: this.soulResolved,
      soulOwner: this.soulOwner,
      souls: this.getSouls(),
    };
  }
}
