import { CONFIG } from '../data/Config.js';
import { dragonCfg, dragonStatsAt, dragonIntervalAt, rollInRange, rollDragonInterval } from '../data/dragonCurve.js';
import { statMod } from '../core/statMod.js';

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
  // ==================== v50：六条新元素（用户定稿）====================
  // 加元素**不需要改成魂规则**：门槛数的是"任意 4 条龙"，成魂时取该阵营击杀最多的元素
  //（并列随机）。这正是用户选的那条口径，代码本来就是这么写的。
  frost:   { key: 'frost',   label: '霜龙', icon: '🧊', color: '#7fd3f7', soul: 'dragonsoul_frost' },
  steel:   { key: 'steel',   label: '铁龙', icon: '🛡', color: '#b0bec5', soul: 'dragonsoul_steel' },
  blood:   { key: 'blood',   label: '血龙', icon: '🩸', color: '#c0392b', soul: 'dragonsoul_blood' },
  magma:   { key: 'magma',   label: '熔龙', icon: '🌋', color: '#d35400', soul: 'dragonsoul_magma' },
  astral:  { key: 'astral',  label: '星龙', icon: '🌌', color: '#7c6cf5', soul: 'dragonsoul_astral' },
  rift:    { key: 'rift',    label: '蚀龙', icon: '☄️', color: '#5d6d7e', soul: 'dragonsoul_rift' },
};

/**
 * 某元素的【巨龙之力】属性表（每层）。数值住在 CONFIG.dragonPower，可在编辑器里改。
 * 返回 [{ statKey, flat, percent }]；空数组表示该元素没有配置（不该发生，但不炸）。
 *
 * ⚠️ 「固定值还是百分比」的判据**不是看后缀**（那条旧约定错了，见 core/statMod.js），
 * 而是看这个键本身是不是一个真属性：是 → 固定值；去掉 Pct 之后才是 → 百分比。
 */
export function dragonPowerBuffs(el) {
  const tbl = (CONFIG.dragonPower && CONFIG.dragonPower[el]) || null;
  if (!tbl) return [];
  // v45：翻译交给 core/statMod.js。原来这里写的是"键名以 Pct 结尾就剥掉后缀按百分比"，
  // 对 damageAmpPct / lifeStealPct 这种**本身就以 Pct 结尾的属性**是错的 ——
  // 剥完变成不存在的属性，被 AttributeCalculator 静默丢弃，**暗之力整档因此完全没效果**
  //（平衡对照里那一档与基线逐字相同）。详见 statMod.js 的头注。
  return Object.entries(tbl).map(([k, v]) => {
    const m = statMod(k, v);
    return { statKey: m.statKey, flat: m.flat, percent: m.percent };
  });
}

export class DragonSystem {
  constructor(entityContainer, eventBus, effectRegistry, skillLibrary, attrCalc) {
    this.entities = entityContainer;
    this.eventBus = eventBus;
    this.effects = effectRegistry;
    this.skills = skillLibrary;
    this.attrCalc = attrCalc;
    this.config = CONFIG.gameRules;

    // v51.9：首条元素龙的出现时间改成每局随机（用户定稿 60~480 秒区间），
    // 在这里（构造时）掷一次骰子，整局固定下来，不是每帧重新随机。
    this.nextDragonTime = rollInRange(dragonCfg().firstDelay);
    // v45：默认**启用**（用户定稿："龙开关默认启用"）。
    // 此前默认 true（暂停），理由是"巨龙系统待大改，先默认关闭"——那一轮大改已经做完了。
    this.paused = false;
    // v45：这张图有没有龙。用户定稿："只有在召唤师峡谷中才有龙的生成！其他地图没有！"
    // 判据是**地图自己声明** `dragon.enabled`（与龙坑 v44 改成地图自有是同一个口径），
    // 不是在 Config 里维护一张 id 白名单 —— 那样自制地图想要龙还得去改引擎配置。
    // 默认 null = 还没载入任何地图，此时不拦（手动生成龙照常可用）。
    this._mapDragon = null;
    this.createEntity = null;
    this.elementDragonSpawned = 0; // 已刷新的元素龙数
    this.ancientSpawned = 0;       // 已刷新的远古龙数

    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;
    // v51.6：远古之力——每杀一条远古龙，该阵营全体单位永久 +5%全属性（逐层叠加）。
    // 与元素之力不同，远古龙没有元素归属，层数按阵营单独计数，不走 DRAGON_ELEMENTS
    // 那套按元素查表的通路。见 _applyAncientPower / _grantAncient。
    this.ancientPowerStacks = {};

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
    // v51.9 修复：用户报"蓝方一直在输，从未赢过"排查出的一条——首条龙坑此前
    // **硬编码**从 'top' 出，而 top 坑走上路、reverse 方向，直逼的正是【蓝方】基地
    // （见 createDragon 的注释："上坑→上路→reverse（推蓝方）"）。虽然坑位之后确实
    // 会交替，但"每一局的第一条龙固定先威胁蓝方"这件事本身就是个不对称——红方
    // 永远先手拿到"抢第一条龙、顺势推蓝方"的地理优势，蓝方永远没有。改成每局开局
    // 随机决定首条从哪个坑出，之后的交替逻辑不变（组内仍然公平轮流）。
    this._nextPitSide = Math.random() < 0.5 ? 'top' : 'bot';

    this._bindDeath();
    this._bindMap();
  }

  /**
   * v45：换地图时同步两件事（用户定稿："重新载入地图龙的波次等也应该重置！"）。
   *   ① 局内进度整个清零 —— 否则换图后第一条龙可能直接是第 5 条的属性，
   *      甚至因为 soulUnlocked 还留着而直接出远古龙。
   *   ② 记下这张图允不允许生成龙。
   * 挂在 map:loaded 上而不是让 main.js 去调：这条规则属于巨龙系统自己，
   * 放在外面就会出现"某个新的载图入口忘了调"——本仓库刚因为同类问题
   *（龙的两条出生路径）踩过一次。
   */
  _bindMap() {
    this.eventBus.on('map:loaded', ({ mapId }) => {
      this.resetRun();
      const m = this._mapOf ? this._mapOf(mapId) : null;
      this._mapDragon = m ? (m.dragon?.enabled === true) : null;
    });
  }
  /** main.js 注入"按 id 取地图数据"的函数（不注入时退化为不拦，单测里可缺省）。 */
  setMapLookup(fn) { this._mapOf = fn; }

  /** 这张图现在允不允许**自动生成**龙。null（尚未载入地图/未注入）一律放行。 */
  mapAllowsDragon() {
    return this._mapDragon === null ? true : this._mapDragon;
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
    this.nextDragonTime = rollInRange(dragonCfg().firstDelay);   // 重开一局也要重新掷一次骰子
    this.elementDragonSpawned = 0;
    this.ancientSpawned = 0;
    this.killCounts = {};
    this.totalKills = 0;
    this.soulUnlocked = false;
    this.ancientKills = 0;
    this.ancientPowerStacks = {};
    this.factionKills = { blue: {}, red: {} };
    this.factionTotals = { blue: 0, red: 0 };
    this.souls = { blue: [], red: [] };
    this.soulResolved = false;
    this.soulOwner = null;
    this._nextPitSide = Math.random() < 0.5 ? 'top' : 'bot';   // 同上：重开一局也要重新随机首条龙坑
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
    // v51.9：真正驱动游戏节奏，要用会掷骰子的 rollDragonInterval，不是给编辑器
    // 预览用的 dragonIntervalAt（那个返回区间中点，是个稳定值，不该拿来定时器）。
    return rollDragonInterval({
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
    this._expireSlayers();   // v45：屠龙者的 60s 魂到点摘掉
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.spawn === false) return;
    if (this.paused) return;
    if (!this.mapAllowsDragon()) return;   // v45：这张图没有龙（只有召唤师峡谷声明了 dragon.enabled）
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

  /**
   * v45：**巨龙之力**的领受范围 —— 全部单位（塔 + 所有小兵，含近战/远程）。
   * 用户定稿："巨龙之力现在作用于所有单位（包含普通小兵），只有龙魂作用于大型小兵+塔。"
   * 追加确认：小兵拿到的层数与大型兵**完全一样**，不打折。
   *
   * 与 SOUL_REWARD_OK 分成两个函数而不是加一个布尔参数：这是两条会各自演化的
   * 设计规则（"力"给谁、"魂"给谁），共用一个带开关的函数迟早变成一堆嵌套 if，
   * 而且调用点看不出自己问的到底是哪一条。
   * 龙自己不在领受范围内 —— 它自带的那份走 applyDragonSelfBuffs，是另一回事。
   */
  static POWER_REWARD_OK(e) {
    if (!e) return false;
    return e.type !== 'dragon';
  }

  spawnDragon() {
    const isAncient = this.soulUnlocked;

    // 元素龙与远古龙**共用同一条连续序号**（第几条龙，不分类型），只与游戏波次解耦——
    // 这是 dragonCurveAt 曲线本身的设计前提（见 dragonCurve.js 顶部注释）。
    // 之前这里给远古龙单独起了一份"第几条远古龙"的序号（从 1 开始），后果是龙魂解锁后
    // 刷的第一条远古龙必然拿到曲线起点的数值——表现为"远古龙比之前的元素龙还弱"。
    const dragonIndex = this.elementDragonSpawned + this.ancientSpawned + 1;
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
    // 注：自带的魂/力**不在这里**发放。龙有两条出生路径（计时刷新 + 设置里的手动生成），
    // 挂在这一条上会让手动生成的龙是裸的 —— 已实测踩到。现在挂在 createDragon()
    // 里（实体真正诞生的唯一一处），任何新的生成入口都自动覆盖。
    if (this.createEntity) this.createEntity('dragon', { element, isAncient, absStats: dstats, pitSide });

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
    const owner = dragon._lastHitFaction || null;   // 最后一击的阵营（可能为 null=环境击杀，无法归属）
    this._grantSlayer(dragon);                      // v45：屠龙者（给出最后一击的**那一个单位**）

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
      this._grantAll(owner, (e) => this._applyElementBuff(e, el), DragonSystem.POWER_REWARD_OK);
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

  /**
   * ==================== v45：屠龙者 ====================
   * 用户定稿："击杀龙的单位（唯一一个给予最后一击的）获得额外的 buff 屠龙者：
   *            获得该龙对应的龙魂，持续 60s。比如击杀了雷龙就获得 60s 的雷魂。"
   *
   * 两条与"阵营级永久奖励"的区别，都要写清楚，否则很容易被误认为同一件事：
   *   ① 领受者是**那一个单位**，不是全阵营；
   *   ② **不受 SOUL_REWARD_OK 限制**（用户定稿"谁最后一击就给谁"）——
   *      近战兵抢到人头也能拿。限制领受者的话它会在最常见的情形下静默失效：
   *      兵线上近战兵最多，最可能补到尾刀。
   * 与阵营已有的永久魂**并存**（用户定稿）：走 _toggleSoul 这条多选叠加的入口，
   * 而不是 _equipSoul（那条是"单一替换"，会把永久魂顶掉）。
   *
   * 到期靠 state.slayerUntil + 每帧的 _expireSlayers 摘除 —— 不用效果系统的
   * duration，因为要摘的是【技能实例】而不是一条 stat 效果。
   */
  _grantSlayer(dragon) {
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return null;
    const cfg = (CONFIG.gameRules?.dragon?.slayer) || {};
    if (cfg.enabled === false) return null;
    const sec = cfg.durationSec ?? 60;
    const killerId = dragon._lastHitBy;
    if (killerId == null) return null;
    const killer = this.entities.get(killerId);
    if (!killer || !killer.alive) return null;
    const soulId = dragon._isAncient
      ? 'dragonsoul_ancient'
      : (DRAGON_ELEMENTS[dragon._element] || {}).soul;
    if (!soulId || !this.skills[soulId]) return null;

    // 已经有这条魂（阵营永久魂或上一次屠龙）→ 只续期，不重复装
    const existing = (killer._skillInstances || []).find(i => i.skillId === soulId);
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    if (!existing) this._toggleSoul(killer, soulId);
    const inst = (killer._skillInstances || []).find(i => i.skillId === soulId);
    if (!inst) return null;
    inst.state = inst.state || {};
    // 阵营永久魂不该被 60 秒后摘掉 —— 只给"本来没有这条魂"的实例打限时标记。
    // ⚠️ 这里最初写成 `else inst.state.slayerUntil = Math.max(slayerUntil||0, now+sec)`，
    // 与上面那句注释**自相矛盾**：永久魂的 slayerUntil 本来是 undefined，
    // Math.max(0, now+sec) 会给它盖上一个到期时间，60 秒后 _expireSlayers 就把
    // 玩家辛苦拿到的阵营永久魂摘了 —— 而且症状只会在"已成魂的一方再补一刀"时出现，
    // 极难复现。判据是 slayerUntil 本身存不存在，不是 existing 存不存在。
    if (!existing) inst.state.slayerUntil = now + sec;
    else if (inst.state.slayerUntil) inst.state.slayerUntil = Math.max(inst.state.slayerUntil, now + sec);
    // else：这条是永久魂，本来就常驻，不打任何限时标记。
    this._slayerWatch = this._slayerWatch || new Set();
    this._slayerWatch.add(killer.id);

    // ==================== v51.1：不再另起一个"屠龙者"徽标 ====================
    // 用户："不要杀死龙后获得屠龙者，直接获得XX秒的临时龙魂，在临时龙魂状态上显示
    //        倒计时。" 原来这里另外 apply 了一条独立的"屠龙者"展示效果，专门用来
    //        显示倒计时——因为 _toggleSoul() 给龙魂本体挂的那个展示效果永远是
    //        duration:Infinity（永久魂用的），没有倒计时环。于是同一个人身上挂两个
    //        图标：龙魂本体（没有倒计时）+"屠龙者"（有倒计时但看着像另一条独立效果）。
    // 现在反过来：直接把龙魂本体那个展示效果的剩余时间改成真实的 sec 秒——
    // 倒计时环长在龙魂图标自己身上，不再需要一个多余的"屠龙者"标签。
    // 只在【本来没有这条魂】时才改（!existing）：已经是阵营永久魂的情况完全不碰，
    // 否则会把玩家辛苦拿到的永久魂在界面上显示成"会过期"。
    if (!existing) {
      const disp = this.effects.getEffects(killer.id).find(e => e.sourceId === `soul_display_${soulId}`);
      if (disp) {
        disp.remainingTime = sec;
        disp.maxDuration = sec;
        disp.permanent = false;
        disp.blueprint.permanent = false;
      }
    }
    this.eventBus.emit('dragon:slayer', { entityId: killer.id, soulId, sec });
    return killer.id;
  }

  /** 屠龙者到期：把限时那条魂摘掉（阵营永久魂没有 slayerUntil，不受影响）。 */
  _expireSlayers() {
    if (!this._slayerWatch || !this._slayerWatch.size) return;
    const now = (typeof window !== 'undefined' && window.gameTime) || 0;
    for (const id of [...this._slayerWatch]) {
      const e = this.entities.get(id);
      if (!e || !e.alive) { this._slayerWatch.delete(id); continue; }
      let left = 0;
      for (const inst of [...(e._skillInstances || [])]) {
        const until = inst.state && inst.state.slayerUntil;
        if (!until) continue;
        if (now >= until) this._toggleSoul(e, inst.skillId);   // 同一个入口卸下，onUnequip 会收尾
        else left++;
      }
      if (!left) this._slayerWatch.delete(id);
    }
  }

  /**
   * ==================== v45：元素龙自带对应的力与魂 ====================
   * 用户定稿："不同的元素龙自带对应种类的巨龙之力和龙魂，巨龙之力的层数为
   *            死亡的该种的龙数量+1。龙魂为1层。"
   * 例：已死 2 雷 + 1 火 + 1 山，第 5 条若是雷龙 → 自带 1 雷魂 + 3 雷之力（2+1）。
   *
   * 效果是"越往后的龙越难打"，而且**难在你放走过的那一种**上 —— 这比单纯按序号
   * 加数值有叙事：一直不去打雷龙，雷龙就一直在变强。
   * 计数用 this.killCounts（全局按元素计数，不分阵营）——"该种的龙死了几条"
   * 与谁杀的无关。
   */
  applyDragonSelfBuffs(dragon) {
    if (!dragon) return;
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return;
    if (dragon._isAncient) {
      // 远古龙没有元素，自带远古之力（层数概念不适用）
      if (this.skills.dragonsoul_ancient) this._toggleSoul(dragon, 'dragonsoul_ancient');
      return;
    }
    const el = dragon._element;
    const def = DRAGON_ELEMENTS[el];
    if (!def) return;
    if (this.skills[def.soul]) this._toggleSoul(dragon, def.soul);   // 龙魂 1 层
    const stacks = (this.killCounts[el] || 0) + 1;                   // 力 = 该元素已死数 + 1
    for (let i = 0; i < stacks; i++) this._applyElementBuff(dragon, el);
    dragon._selfPowerStacks = stacks;   // 供 UI / 验收读，不参与结算
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
   * 对某阵营的全部领受者执行 fn。
   * v45：范围**由调用方指定**——龙魂给 SOUL_REWARD_OK（塔 + 大型小兵），
   * 巨龙之力给 POWER_REWARD_OK（所有单位）。默认值保持龙魂那条，
   * 这样漏传参数时是"更保守的范围"而不是"意外发给所有人"。
   */
  _grantAll(faction, fn, okFn = DragonSystem.SOUL_REWARD_OK) {
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return 0;
    let n = 0;
    for (const e of this.entities.getAll(true)) {
      if (!okFn(e)) continue;
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
    if (CONFIG.dragonToggles && CONFIG.dragonToggles.effect === false) return false;
    const fac = entity?._mapFaction || entity?.faction;
    if (fac !== 'blue' && fac !== 'red') return false;
    let any = false;
    // ① 巨龙之力：按该阵营每种元素已击杀的条数逐层补 —— **所有单位**都补（v45）。
    // 这个门原来写在函数开头，是一句 SOUL_REWARD_OK 管两件事；力的范围放宽之后
    // 必须拆开，否则新出的近战/远程兵永远补不到力（只有开局那一刻在场的能拿到，
    // 而击杀时的 _grantAll 已经放宽了 —— 两处范围不一致比两处都窄更难查）。
    if (DragonSystem.POWER_REWARD_OK(entity)) {
      for (const [el, cnt] of Object.entries(this.factionKills[fac] || {})) {
        for (let i = 0; i < cnt; i++) { this._applyElementBuff(entity, el); any = true; }
      }
      // v51.6：远古之力同样要给新出生的单位补层，否则和元素之力一样会出现
      // "旧的一批死绝，新出生的一批全都拿不到"（equipExistingSoul 本来就是为了
      // 修这一类问题才存在的，见上面 factionKills 那段的注释）。
      const ancientStacks = this.ancientPowerStacks[fac] || 0;
      for (let i = 0; i < ancientStacks; i++) { this._applyAncientPower(entity); any = true; }
    }
    // ② 龙魂本体：仍然只给塔 + 大型小兵
    if (DragonSystem.SOUL_REWARD_OK(entity) && this.soulOwner === fac && this.souls[fac]?.[0]) {
      this._equipSoul(entity, this.souls[fac][0]); any = true;
    }
    // ③ v51 修复：远古之力是限时的，广播那一刻不在场的单位（大型小兵频繁死亡重生，
    // 塔几乎不会）会漏掉——这里补上，窗口期内新入场的塔/大型小兵按剩余时间补发。
    // 顺序放在②之后：与"广播那一刻正好在场"的单位一致（远古之力会顶掉常驻魂，
    // 这是 _grantAncientTo 内部 _equipSoul 早就有的行为，不是这次新引入的）。
    const until = this._ancientUntilByFaction?.[fac];
    if (DragonSystem.SOUL_REWARD_OK(entity) && until
        && until > ((typeof window !== 'undefined' && window.gameTime) || 0)) {
      this._grantAncientTo(entity, until); any = true;
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
      // 用户定稿：并列时随机决定，不再固定偏向 Object.entries 的遍历顺序
      // （改之前永远是 DRAGON_ELEMENTS 里排最前的那个元素赢，等于没随机过）。
      let best = null, bestCount = -1, ties = [];
      for (const [el, cnt] of Object.entries(kills)) {
        if (cnt > bestCount) { bestCount = cnt; best = el; ties = [el]; }
        else if (cnt === bestCount && cnt > 0) { ties.push(el); }
      }
      if (ties.length > 1) best = ties[Math.floor(Math.random() * ties.length)];
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
    this.nextDragonTime = rollInRange(dragonCfg().ancientFirstDelay);
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
      // v51.9：铁龙之力（dragonPower.steel.shieldFixedMax）用户先定稿"改为护盾，
      // 要不然太超标了"，之后又补充定稿具体分配："对塔+45固定护盾。对其余单位
      // +45护盾。"——塔是钉死原地不移动的机械单位，固定护盾会自动回满对它没那么
      // 离谱（只有城防塔本来就有的那点护甲/血量在撑），真正"变相永远满盾"的问题
      // 出在会走位、会脱离战斗自然回满的大型小兵身上，所以只对塔保留固定护盾，
      // 其余（大型小兵）改用不会自动回复的护盾。
      if (b.statKey === 'shieldFixedMax') {
        if (tower.type === 'tower') {
          this.effects.apply(tower.id, {
            name: `${def.label}之力`, icon: def.icon, kind: 'stat', color: def.color,
            statKey: 'shieldFixedMax',
            flatValue: b.flat || 0, perStackFlat: b.flat || 0,
            duration: Infinity, permanent: true,
            stackable: true, maxStacks: cap, stackPolicy: 'stack',
            stackKey: `dragon_${el}_${b.statKey}`,
            descTemplate: `唯一被动——${def.label}之力：击杀${def.label}获得的永久固定护盾（{stacks}层）。`,
            description: `${def.label}固定护盾（{stacks}层）`,
          }, `dragon_buff_${el}_${i}`);
        } else {
          this.effects.apply(tower.id, {
            name: `${def.label}之力`, icon: def.icon, kind: 'shield', color: def.color,
            flatValue: b.flat || 0,
            duration: Infinity, permanent: true,
            stackable: true, maxStacks: cap, stackPolicy: 'stack',
            stackKey: `dragon_${el}_${b.statKey}`,
            descTemplate: `唯一被动——${def.label}之力：击杀${def.label}获得的永久护盾（{stacks}层）。`,
            description: `${def.label}护盾（{stacks}层）`,
          }, `dragon_buff_${el}_${i}`);
        }
        continue;
      }
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
  /**
   * 给单个单位授予远古之力（限时到 untilTime）。抽出来是因为它现在有**两处**调用：
   * ① 击杀远古龙那一刻，广播给当时在场的全部塔+大型小兵；
   * ② 见下面 equipExistingSoul 里新补的那段——240 秒窗口期内新出生的塔/大型小兵。
   * 两处若各写一份，"新兵没有远古之力"这种"同一条规则实现了两遍"的坑迟早复发。
   */
  _grantAncientTo(e, untilTime) {
    const p = (CONFIG.dragonSouls && CONFIG.dragonSouls.ancient) || {};
    const remain = untilTime - ((typeof window !== 'undefined' && window.gameTime) || 0);
    if (remain <= 0) return;
    this._equipSoul(e, 'dragonsoul_ancient');
    // v51.6：这条限时处决效果的展示名从"远古之力"改成"远古处决"——新增的永久
    // 全属性加成（_applyAncientPower）现在才是真正叫"远古之力"的那个东西（用户
    // 明确要求区分"龙魂"与"力"这两个概念），两个效果如果同名会在同一个单位的
    // 状态栏里混在一起，没法区分哪个是限时的哪个是永久的。
    this.effects.apply(e.id, {
      name: '远古处决', icon: '🐲', kind: 'display', type: 'buff', color: '#e67e22',
      duration: remain, stackable: false, stackPolicy: 'refresh', uniquePassive: true,
      stackKey: 'dragon_ancient',
      description: `处决：对生命低于 ${p.executeAtPct ?? 20}% 的敌人额外造成 ${p.executePct ?? 20}% 最大生命真实伤害`,
    }, 'dragon_ancient_buff');
    e._ancientUntil = untilTime;
  }

  /**
   * v43：远古龙奖励 = **限时 240 秒的处决**（用户定稿：八条龙魂全部永久，只有它限时）。
   *
   * 旧实现是"给参与的塔永久 +10% 全属性、每条叠一层"——纯数值、永久、只给塔。
   * 现在改成阵营级的限时技能：成魂后元素龙停刷、只出远古龙，**双方都能抢**，
   * 于是它成了落后方唯一的翻盘工具。处决专治"最后 20% 特别难啃"，
   * 恰好克制山魂/光魂/潮魂这三条防守型龙魂 —— 这是防止"一方成魂另一方不用玩了"的关键。
   *
   * ==================== v51 bug 修复：大型小兵拿不到远古之力 ====================
   * 用户报告："远古龙魂对大型小兵目前不生效，只对塔生效。"
   * 排查结论与用户的猜测不同：**不是装备时按单位类型过滤掉了**——`dragonsoul_ancient`
   * 的 onDealtDamage 完全不看攻击者类型，`_grantAll` 用的 SOUL_REWARD_OK 也同样
   * 包含大型小兵，这次广播本身对塔和大型小兵一视同仁。
   * 真正的缺口在**新单位入场**那条路：`equipExistingSoul()` 只会给新兵补发【永久】
   * 的龙魂（this.souls[fac]），远古之力是限时的、走的是这里的一次性广播，从没有人
   * 告诉 equipExistingSoul "现在阵营 X 正顶着一份远古之力，窗口到几点"。塔几乎不会
   * 中途"重新出生"（对局里数量恒定），而大型小兵每隔几十秒就整批死亡再刷新——
   * 限时窗口期内，旧的那一批很快死绝，新出生的一批全都拿不到，观感上就是
   * "远古龙魂只对塔有效"。修法：把这份窗口期状态记成阵营级的 `_ancientUntilByFaction`，
   * equipExistingSoul 里补发时一并检查、按剩余时间补上。
   */
  _grantAncient(faction) {
    const p = (CONFIG.dragonSouls && CONFIG.dragonSouls.ancient) || {};
    const dur = p.durationSec ?? 300;
    const until = ((typeof window !== 'undefined' && window.gameTime) || 0) + dur;
    this._ancientUntilByFaction = this._ancientUntilByFaction || {};
    this._ancientUntilByFaction[faction] = until;
    const n = this._grantAll(faction, (e) => this._grantAncientTo(e, until));
    this._ancientFaction = faction;
    // v51.6：远古之力——与龙魂那份限时执行效果分开广播，永久、覆盖全部单位
    // （POWER_REWARD_OK，不是 SOUL_REWARD_OK 那条窄范围），逐层叠加不设上限
    // （远古龙可以反复刷、反复杀，层数天然随"这一路谁一直在赢远古龙"增长）。
    this.ancientPowerStacks[faction] = (this.ancientPowerStacks[faction] || 0) + 1;
    this._grantAll(faction, (e) => this._applyAncientPower(e), DragonSystem.POWER_REWARD_OK);
    return n;
  }

  /**
   * 给单个单位叠一层远古之力（永久 +CONFIG.dragonPower.ancient.coreStatsPct% 核心属性）。
   * 单独成一条 stat 效果、独立 sourceId，不与 _grantAncientTo 的限时处决效果混在一起——
   * 一个永久叠层、一个到点回收，生命周期完全不同，合在一条效果里没法同时满足两边。
   * 数值放在 CONFIG.dragonPower（不是 CONFIG.dragonSouls）——这是"力"不是"魂"，
   * 与其余七个元素的力同一张表，只是没有元素归属，单独存一个 'ancient' 键。
   *
   * v51.9：statKey 从 allStatsPct 改为 coreStatsPct——用户实测"4力+雷魂的蓝方打不过
   * 0力+远古龙魂的红方"，全属性加成覆盖面太宽，改成只放大六项核心战斗属性的
   * 核心属性加成，数值同时从 5%/层砍到 2.5%/层。见 Config.js 里 dragonPower.ancient
   * 的头注与 AttributeCalculator.js 的 v51.9 部分。
   */
  _applyAncientPower(entity) {
    const p = (CONFIG.dragonPower && CONFIG.dragonPower.ancient) || {};
    const pct = p.coreStatsPct ?? 2.5;
    this.effects.apply(entity.id, {
      name: '远古之力', icon: '🐲', kind: 'stat', color: '#e67e22',
      statKey: 'coreStatsPct', flatValue: pct, perStackFlat: pct,
      duration: Infinity, permanent: true, stackable: true, maxStacks: 999, stackPolicy: 'stack',
      descTemplate: `唯一被动——远古之力：击杀远古巨龙获得的永久核心属性加成（{stacks}层，每层+${pct}%）。`,
      description: `远古之力（{stacks}层，每层+${pct}%核心属性）`,
    }, 'dragon_ancient_power_0');
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
    // Bug 修复（用户定稿）："远古之力的倒计时圆环没显示，状态栏（效果栏）里看不到"。
    // 根因：这里对**所有**龙魂都无条件补一份 duration:Infinity/permanent:true 的展示效果，
    // 而 dragonsoul_ancient 的调用方 _grantAncient 紧接着**又**单独 apply 了一份同名
    // （都叫"远古之力"）、duration:240 的展示效果。UI 按效果名分组合并同名效果时
    // remainingTime 取组内最大值——Infinity 和 240 取最大还是 Infinity，等于把限时的
    // 那份直接盖成了永久，圆环因此从不出现（表现为"图标在、圆环没有"）。
    // 8 条龙魂里只有这条是限时的，其余 7 条确实应该走这条通用的永久展示；
    // 跳过的不是"给这条魂开小灶"，是不再对它重复 apply 同名效果——展示本身
    // 仍然统一走 EffectRegistry 的同一套倒计时机制，由 _grantAncient 那份负责。
    if (def && soulId !== 'dragonsoul_ancient') {
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
