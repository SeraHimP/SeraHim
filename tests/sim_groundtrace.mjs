/**
 * sim_groundtrace.mjs —— 地面痕迹层（水洼/雪盖，v54 第二轮重做）验收
 *
 * 用户对雨的水洼提的硬约束（逐条照抄，见 docs/Q4-WEATHER-REDESIGN.md）：
 *   "随机在地面生成小水洼，单位在水洼里会有常驻减速效果，雨下越大水洼越多，
 *   水洼可以连接到一块。但是特别注意！只有雨下了一段时间或者是下的特别大时
 *   才会出现！如果一直保持小雨则不会出现！"
 *
 * v54：实机验收发现水洼太少太弱（全图随机撒点大多落在看不到的野区、生成节奏
 * 太慢、单个水洼相对地图尺度太小），这轮改成"70~80%权重沿兵线附近撒点"+
 * 加大尺寸+提速；雪的机制整个反过来——不再是"脚印瞬间加速"，改成"雪盖网格
 * 随强度/时长整体积累雪深，站进去减速，单位经过会局部踩低雪深留下小径，
 * 小径减速幅度比周围雪盖小但不会被踩成 0"。
 *
 * 每条断言钉"行为形状"（触发与否、方向、相对大小关系），不钉具体数字——
 * 生成位置带随机性，钉死坐标必然偶发抖动失败（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';

setupWindow({ gameTime: 0, waveNumber: 1 });
const { T, done } = scoreboard('地面痕迹层（水洼/雪盖）验收');

const { WeatherSystem } = await import('../src/systems/WeatherSystem.js');
const { GroundTraceSystem } = await import('../src/systems/GroundTraceSystem.js');
const { CONFIG } = await import('../src/data/Config.js');

const mkMapSystem = (w = 2000, h = 2000) => ({ isWalkable: () => true, currentMap: { world: { w, h } } });
const setCharge = (ws, id, v) => { ws._charge[id] = v; ws._invalidateWeatherReadout(); };
const mkWeather = () => { const ws = new WeatherSystem(null); ws.setEnabled(true); return ws; };

// ==================== 一、水洼：触发门槛（用户硬约束） ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);

  // 小雨（轻微档）持续很久也不该出现水洼——"如果一直保持小雨则不会出现"。
  setCharge(ws, 'rain', 0.2); // 轻微档（<0.75 的 sustainedThresholdScale）
  for (let i = 0; i < 60; i++) gts.update(1);
  T('水①-持续小雨60秒不触发水洼（用户硬约束："一直保持小雨则不会出现"）',
    gts.puddles.length === 0);
}
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);

  // 中雨以上持续够久 → 触发。charge=0.5 落在"中等档（scale=0.75，够格计时）但
  // 又低于 instantChargeThreshold(0.75)"这个区间，才能干净地只测持续路径，
  // 不会被瞬时路径提前触发污染这条断言。
  setCharge(ws, 'rain', 0.5);
  const need = (CONFIG.groundTrace?.puddle?.sustainedSeconds ?? 12);
  for (let i = 0; i < need - 1; i++) gts.update(1);
  T('水②-未满 sustainedSeconds 之前不触发', gts.puddles.length === 0);
  for (let i = 0; i < 30; i++) gts.update(1); // 补到并超过阈值 + 给几个 respawn 周期
  T('水③-持续够久后触发，出现至少一个水洼', gts.puddles.length > 0);
}
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);

  // 瞬时强度够猛：不需要等 sustainedSeconds，直接触发。
  setCharge(ws, 'rain', 0.95);
  for (let i = 0; i < 5; i++) gts.update(1); // 远小于 sustainedSeconds
  T('水④-瞬时强度达到 instantChargeThreshold 时不用等持续时间直接触发',
    gts.puddles.length > 0);
}

// ==================== 二、水洼：数量随雨强度增多 + 合并 ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(3000, 3000), ws);
  setCharge(ws, 'rain', 0.5); // 有限/中等档之间——让它先满足瞬时阈值？不，0.5<0.75，走持续路径
  setCharge(ws, 'rain', 0.78); // 刚过 sustainedThresholdScale 的档位系数门槛
  for (let i = 0; i < 200; i++) gts.update(1); // 给足时间让数量逼近目标上限
  const lowCount = gts.puddles.length;

  const { ents: ents2, fx: fx2 } = await makeWorld();
  const ws2 = mkWeather();
  const gts2 = new GroundTraceSystem(ents2, fx2, mkMapSystem(3000, 3000), ws2);
  setCharge(ws2, 'rain', 0.99); // 严重档，强度拉满
  for (let i = 0; i < 200; i++) gts2.update(1);
  const highCount = gts2.puddles.length;

  T('水⑤-雨下得越大，水洼数量越多（高强度长期跑批数量 ≥ 低强度）', highCount >= lowCount);
  T('水⑥-数量落在 CONFIG.groundTrace.puddle 定义的区间内',
    gts.puddles.every(p => p.subOffsets.length > 0) &&
    highCount <= (CONFIG.groundTrace?.puddle?.maxPatches ?? 20) + 1); // +1 容忍合并边界
}
{
  // 合并：把地图缩到很小，逼着新水洼必然落在旧水洼的 mergeDistance 内。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const mergeDist = CONFIG.groundTrace?.puddle?.mergeDistance ?? 90;
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(mergeDist * 0.5, mergeDist * 0.5), ws);
  setCharge(ws, 'rain', 0.95);
  for (let i = 0; i < 100; i++) gts.update(1);
  T('水⑦-地图小于合并距离时，新水洼全部并入同一片（不会各自独立出现一堆水洼）',
    gts.puddles.length === 1 && gts.puddles[0].subOffsets.length > 3);
}

// ==================== 三、水洼：进去减速，效果随强度打折 ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'rain', 0.95);
  for (let i = 0; i < 30; i++) gts.update(1);
  const p = gts.puddles[0];
  const inside = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: p.x + p.subOffsets[0].dx, y: p.y + p.subOffsets[0].dy } }, CONFIG);
  const outside = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: p.x + 99999, y: p.y + 99999 } }, CONFIG);
  gts._applyEffects();
  const insideEff = fx.getEffects(inside.id).find(e => e.blueprint.name === '水洼');
  const outsideEff = fx.getEffects(outside.id).find(e => e.blueprint.name === '水洼');
  T('水⑧-站在水洼里的单位获得负向移速修正（减速）', insideEff && insideEff.blueprint.percent < 0);
  T('水⑨-远离水洼的单位不受影响', !outsideEff);
}

// ==================== 四、水洼：雨停后逐渐消退，不是瞬间消失 ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'rain', 0.95);
  for (let i = 0; i < 30; i++) gts.update(1);
  T('消①-触发后确实有水洼', gts.puddles.length > 0);
  setCharge(ws, 'rain', 0);
  gts.update(1); // 雨停后立刻推进一小步
  T('消②-雨停不是瞬间清空（下一帧水洼仍在，只是开始衰减）', gts.puddles.length > 0);
  for (let i = 0; i < 200; i++) gts.update(1);
  T('消③-充分等待后水洼逐渐干涸消失', gts.puddles.length === 0);
}

// ==================== 五、水洼：沿兵线权重撒点（v54 §9.4） ====================
{
  const mkLaneMap = (w = 3000, h = 3000) => ({
    isWalkable: () => true,
    currentMap: { world: { w, h }, lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: w, y: h }] }] },
  });
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkLaneMap(), ws);
  setCharge(ws, 'rain', 0.99);
  for (let i = 0; i < 200; i++) gts.update(1);
  const laneSpread = CONFIG.groundTrace?.puddle?.laneSpread ?? 220;
  // 对角线 x=y 上任意点到直线的垂距 = |x-y|/√2。
  const distToLane = (x, y) => Math.abs(x - y) / Math.SQRT2;
  const near = gts.puddles.filter(p => distToLane(p.x, p.y) <= laneSpread * 1.5).length;
  T('沿①-有兵线数据时，大部分水洼落在兵线附近（不是纯全图随机撒点）',
    gts.puddles.length > 0 && near / gts.puddles.length > 0.5);
}
{
  // 没有兵线数据（老地图/测试桩）时优雅退回全图随机撒点，不抛异常、不为空。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(3000, 3000), ws);
  setCharge(ws, 'rain', 0.99);
  for (let i = 0; i < 60; i++) gts.update(1);
  T('沿②-没有 lanes 数据时退回全图随机撒点，仍能正常触发（不因缺字段而崩溃）',
    gts.puddles.length > 0);
}

// ==================== 六、雪盖：全新设计（v54，取代旧的"脚印瞬间加速"） ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.8); // 严重档，远高于 minChargeToGrow
  for (let i = 0; i < 400; i++) gts.update(1); // 给够时间让全局目标涨起来
  T('雪①-持续足够强的雪天，雪盖全局目标深度会从 0 涨起来', gts.snowGlobalTarget > 0.05);
  const cover = gts.getSnowCover();
  T('雪②-getSnowCover() 返回网格快照，data 里至少有格子深度 >0', cover
    && Array.from(cover.data).some(v => v > 0.01));
}
{
  // 2026-09-19：钉住"渐变而不是突变"——用真实帧长（1/30秒）而不是上面测试用的
  // dt=1 大步长快进，量真实对局节奏下地面从"看不见"到"接近全白"要多久。
  // 用户反馈的根因不是代码里有阶跃函数，是渐变的时间常数太短（改前只要 15~20
  // 秒），玩家在这么短的窗口里分辨不出连续渐变和一次性突变——这条测试直接把
  // "20秒内不该已经接近全白"和"持续几分钟后确实会接近全白"两头都钉住，防止
  // 以后有人为了"让雪看起来更快出现"又把参数调回秒级。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 1.0); // 满强度雪天，最不利情况（涨得最快）也不该秒白
  const REAL_DT = 1 / 30;
  for (let i = 0; i < 30 * 20; i++) gts.update(REAL_DT); // 20 秒
  const at20s = gts.snowGlobalTarget;
  T('雪⑨-满强度雪天持续20秒（真实帧长），雪盖远未铺满（不是"到阈值秒白"）',
    at20s < 0.5);
  for (let i = 0; i < 30 * 60 * 3; i++) gts.update(REAL_DT); // 再等3分钟
  T('雪⑩-持续几分钟后雪盖确实积到接近全白（渐变最终有明确终点，不是永远长不满）',
    gts.snowGlobalTarget > 0.9);
}
{
  // 雪太弱（低于 minChargeToGrow）不积雪——"下到一定程度后才缓缓显出积雪"。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.05); // 远低于 minChargeToGrow
  for (let i = 0; i < 200; i++) gts.update(1);
  T('雪③-雪弱到 minChargeToGrow 以下时雪盖不积（不是任何雪天都会有积雪）',
    gts.snowGlobalTarget < 0.02);
}
{
  // 站在雪盖里减速。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.9);
  for (let i = 0; i < 400; i++) gts.update(1);
  const inside = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 1000, y: 1000 } }, CONFIG);
  gts._applyEffects();
  const eff = fx.getEffects(inside.id).find(e => e.blueprint.name === '积雪');
  T('雪④-站在雪盖里的单位获得负向移速修正（减速，不是旧机制的加速）',
    eff && eff.blueprint.percent < 0);
}
{
  // 小径：被踩过的格子局部雪深低于周围未踩过的格子，但不会被踩到 0（pathFloor）。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.9);
  for (let i = 0; i < 400; i++) gts.update(1); // 先让雪盖长满，不踩踏
  const target = gts.snowGlobalTarget;
  const untouched = gts._snowDepthAt(1900, 1900); // 远离下面要踩的点，代表"周围雪盖"
  const walker = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 1000, y: 1000 } }, CONFIG);
  for (let i = 0; i < 60; i++) gts.update(1); // 单位固定站在同一点，持续踩踏
  const trodden = gts._snowDepthAt(1000, 1000);
  const pathFloor = CONFIG.groundTrace?.snowCover?.pathFloor ?? 0.3;
  T('雪⑤-被踩过的格子雪深明显低于未踩过的周围雪盖（踩出了一条小径）', trodden < untouched * 0.9);
  T('雪⑥-小径不会被踩成完全 0（下限 = pathFloor × 全局目标，仍有一定减速）',
    trodden >= pathFloor * target * 0.9);
}
{
  // 雪停后全局目标逐渐消退（不是瞬间清空），跟水洼的"消①-③"同一节奏语义。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.9);
  for (let i = 0; i < 400; i++) gts.update(1);
  const before = gts.snowGlobalTarget;
  T('雪⑦-持续降雪后全局目标深度确实涨起来了', before > 0.1);
  setCharge(ws, 'snow', 0);
  for (let i = 0; i < 400; i++) gts.update(1);
  T('雪⑧-雪停后全局目标深度逐渐消退（不是瞬间归零，也不会停在原值不动）',
    gts.snowGlobalTarget < before * 0.5);
}

// ==================== 七、天气关闭/无地图系统时安全降级 ====================
{
  const { ents, fx } = await makeWorld();
  const gts = new GroundTraceSystem(ents, fx, null, null); // 无 mapSystem、无 weatherSystem
  for (let i = 0; i < 50; i++) gts.update(1); // 不应抛异常
  T('降①-mapSystem/weatherSystem 都缺失时不抛异常、不生成任何痕迹',
    gts.puddles.length === 0 && gts.getSnowCover() === null);
}

done();
