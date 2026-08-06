/**
 * sim_lightsoul.mjs —— ☀️ 光魂：外/内/枢纽塔重生（v43）
 *
 * ==================== 为什么单独开一套 ====================
 * 光魂在龙魂重做那一版里**整整一版什么也没做**：技能定义里写了
 * `respawnRuleFor(tier, usedCount)`，注释还写着"触发点在 MapSystem._onEntityDeath"，
 * 但那个调用从来没被写出来。当时 sim_v43 里那条"魂⑨"是绿的 —— 它匹配的是
 * 方法**定义**本身，不是调用点。又一次自证式断言。
 *
 * 抓出它的不是测试，是龙魂平衡对照：九档里唯独 light 那一档与基线**逐位相同**
 *（推塔 蓝6.2/红5.4、推进度差 +0.86、终局熵 0.47，一个数都不差）。
 * 两个完全独立的随机对局跑出一模一样的数，只可能是那一档什么都没改。
 *
 * 所以这一套钉的全部是**行为**，不是源码文本：死了→排队→到点→活了→血量对。
 * 源码断言那条路已经证明过它抓不住这个 bug。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { EventBus } = await import('../src/utils/EventBus.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('光魂重生验收');

const P = CONFIG.dragonSouls.light;
const SEC = P.respawnSec;

function world() {
  const bus = new EventBus(), ents = new EntityContainer(bus), fx = new EffectRegistry(bus);
  const ms = new MapSystem(ents, bus);
  ms.setEffectRegistry(fx);
  ms.loadMap('summoners_rift_v1');
  ms.active = true;
  return { bus, ents, fx, ms };
}
function tower(ents, tier, souls, maxHP = 4000) {
  const e = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 100, y: 100 },
    baseStats: { maxHP }, currentHP: maxHP, shieldFixedCurrent: 0, tempShield: 0,
    _mapFaction: 'blue', faction: 'blue', _mapTier: tier, _laneId: 'mid',
    _skillInstances: souls.map(s => ({ id: ++window._uid, skillId: s, state: {} })),
  };
  ents.add(e);
  return e;
}
const kill = (bus, e) => { e.alive = false; e.currentHP = 0; bus.emit('entity:death', { entityId: e.id }); };

// ==================== 一、没有光魂就不该重生 ====================
// 这一条是整套的地基：如果不装光魂的塔也会重生，那"光魂生效了"就什么也证明不了。
{
  const { bus, ents, ms } = world();
  const t = tower(ents, 'outer', []);
  kill(bus, t);
  T('①-不带光魂的外塔不进重生队列', !t._respawnAt);
  ms.update(SEC + 1);
  T('①-不带光魂的外塔到点也不会活过来', t.alive === false);
}

// ==================== 二、外塔：重生一次，33% 生命 ====================
{
  const { bus, ents, ms } = world();
  const t = tower(ents, 'outer', ['dragonsoul_light']);
  kill(bus, t);
  T('②-带光魂的外塔进了重生队列', !!t._respawnAt);
  T('②-被摧毁后先变成损毁幽灵（与召唤水晶同一套）', t._ruin === true);

  ms.update(SEC - 5);
  T('②-没到点之前不会提前复活', t.alive === false);
  T('②-倒计时期间有重生进度可供 UI 读', t._respawnProgress > 0.9 && t._respawnProgress < 1);

  ms.update(10);
  T('②-到点复活', t.alive === true);
  T('②-复活血量 = 最大生命 × ' + P.outerInnerHpPct + '%',
    t.currentHP === Math.round(4000 * P.outerInnerHpPct / 100));
  T('②-复活后不再是损毁幽灵', !t._ruin);
  T('②-复活后重生标记清干净（否则第二次死亡会被当成"已在倒计时"）',
    !t._respawnAt && t._respawnProgress === undefined && t._respawnRemain === undefined);
}

// ==================== 三、外/内塔各限一次 ====================
{
  const { bus, ents, ms } = world();
  for (const tier of ['outer', 'inner']) {
    const t = tower(ents, tier, ['dragonsoul_light']);
    kill(bus, t); ms.update(SEC + 1);
    T(`③-${tier} 第一次重生成功`, t.alive === true);
    kill(bus, t); ms.update(SEC + 1);
    T(`③-${tier} 第二次不再重生（限 ${P.outerInnerLimit} 次）`, t.alive === false);
  }
}

// ==================== 四、枢纽塔无限次，40% 生命 ====================
// 用户定稿："枢纽塔无限重生"。当时我担心这会让对局打不完，用户的原话是
// "有过载不用担心打不完，因为过载可以把最大生命值减到0" —— 我判断错了，记在这里。
{
  const { bus, ents, ms } = world();
  const t = tower(ents, 'hq_tower', ['dragonsoul_light'], 4750);
  const want = Math.round(4750 * P.hqHpPct / 100);
  for (let i = 1; i <= 3; i++) {
    kill(bus, t); ms.update(SEC + 1);
    T(`④-枢纽塔第 ${i} 次重生（无限次）`, t.alive === true && t.currentHP === want);
  }
}

// ==================== 五、水晶塔/召唤水晶/水晶枢纽不在光魂范围 ====================
// 召唤水晶本来就有自己的重生规则（NEXUS_RESPAWN_TIME、满血），不能被光魂改口径。
{
  const { bus, ents, ms } = world();
  for (const tier of ['base', 'nexus_main']) {
    const t = tower(ents, tier, ['dragonsoul_light']);
    kill(bus, t); ms.update(SEC + 1);
    T(`⑤-${tier} 不吃光魂重生`, t.alive === false);
  }
  // 召唤水晶：走它自己那条路，满血回来，与光魂的 33/40% 无关
  const nx = tower(ents, 'nexus_lane', ['dragonsoul_light'], 4000);
  kill(bus, nx);
  ms.update(ms.NEXUS_RESPAWN_TIME + 1);
  T('⑤-召唤水晶仍按自己的规则满血重生（没被光魂的百分比顶掉）',
    nx.alive === true && nx.currentHP === 4000);
}

// ==================== 六、重生血量按【当前】最大生命算，不是按初始表 ====================
// 塔身上带着成长/编辑器覆写时，用 tierStats 的原始值会把它打回"刚开局的样子"，
// "重生 33% 生命"就成了别的意思。
{
  const { bus, ents, ms } = world();
  const t = tower(ents, 'outer', ['dragonsoul_light']);
  t.baseStats.maxHP = 9000;             // 假装它长了一倍多
  kill(bus, t); ms.update(SEC + 1);
  T('⑥-复活血量跟随当前最大生命（9000×33%），不是 tierStats 的 4000',
    t.currentHP === Math.round(9000 * P.outerInnerHpPct / 100));
}

// ==================== 七、队列必须按到点时间排序 ====================
// 光魂进来之前队列里只有召唤水晶、时长恒定，入队顺序天然就是时间顺序
//（MapSystem 里原来就写着那句注释）。两种时长混在一起之后不再成立：
// 出队用的是 `while (queue[0].at <= clock)`，短的排在长的后面就会被永远堵住。
{
  const { bus, ents, ms } = world();
  const long = 1000;
  const saved = ms.NEXUS_RESPAWN_TIME;
  ms.NEXUS_RESPAWN_TIME = long;         // 让召唤水晶比光魂慢很多
  const nx = tower(ents, 'nexus_lane', []);
  kill(bus, nx);                        // 先入队：at = 1000
  const t = tower(ents, 'outer', ['dragonsoul_light']);
  kill(bus, t);                         // 后入队：at = 300
  T('⑦-队列按到点时间排序（后入队但更早的排在前面）',
    ms._respawnQueue.length === 2 && ms._respawnQueue[0].at < ms._respawnQueue[1].at);
  ms.update(SEC + 1);
  T('⑦-短的那个准时出队，没有被长的堵住', t.alive === true);
  T('⑦-长的那个还在队列里等着', nx.alive === false && ms._respawnQueue.length === 1);
  ms.NEXUS_RESPAWN_TIME = saved;
}

// ==================== 八、进度条分母用各自的时长 ====================
{
  const { bus, ents, ms } = world();
  const t = tower(ents, 'outer', ['dragonsoul_light']);
  kill(bus, t);
  ms.update(SEC / 2);
  T('⑧-走到一半时进度约 0.5（分母是光魂自己的 respawnSec，不是水晶的）',
    Math.abs(t._respawnProgress - 0.5) < 0.05);
}

done();
