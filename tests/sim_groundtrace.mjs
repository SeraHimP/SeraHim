/**
 * sim_groundtrace.mjs —— 地面痕迹层（水洼/雪痕）验收
 *
 * 用户对雨的水洼提的硬约束（逐条照抄，见 docs/Q4-WEATHER-REDESIGN.md）：
 *   "随机在地面生成小水洼，单位在水洼里会有常驻减速效果，雨下越大水洼越多，
 *   水洼可以连接到一块。但是特别注意！只有雨下了一段时间或者是下的特别大时
 *   才会出现！如果一直保持小雨则不会出现！"
 * 雪的破雪留痕复用同一套骨架，语义相反（进去加速而不是减速）。
 *
 * 每条断言钉"行为形状"（触发与否、方向、相对大小关系），不钉具体数字——
 * 生成位置带随机性，钉死坐标必然偶发抖动失败（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';

setupWindow({ gameTime: 0, waveNumber: 1 });
const { T, done } = scoreboard('地面痕迹层（水洼/雪痕）验收');

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

// ==================== 五、雪痕：单位移动留痕 + 加速 + 消退 ====================
{
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.6);
  const leader = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 500, y: 500 } }, CONFIG);
  for (let i = 0; i < 20; i++) { leader.pos.x += 10; gts.update(0.5); }
  T('雪①-雪天单位移动会留下痕迹点', gts.trails.length > 0);

  const t0 = gts.trails[0];
  const follower = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: t0.x, y: t0.y } }, CONFIG);
  gts._applyEffects();
  const followerEff = fx.getEffects(follower.id).find(e => e.blueprint.name === '雪痕');
  T('雪②-踩在雪痕上的单位获得正向移速修正（加速）', followerEff && followerEff.blueprint.percent > 0);

  for (let i = 0; i < 15; i++) gts.update(1); // 超过 lifetimeSec（默认10s）
  T('雪③-痕迹点会自然过期消失（不是永久通道）', gts.trails.length === 0);
}
{
  // 雪太弱（低于 minTierScale）不留痕。
  const { ents, fx } = await makeWorld();
  const ws = mkWeather();
  const gts = new GroundTraceSystem(ents, fx, mkMapSystem(), ws);
  setCharge(ws, 'snow', 0.05); // 远低于 minTierScale
  const leader = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 500, y: 500 } }, CONFIG);
  for (let i = 0; i < 20; i++) { leader.pos.x += 10; gts.update(0.5); }
  T('雪④-雪弱到轻微档以下时不留痕（不是任何雪天都会有雪痕）', gts.trails.length === 0);
}

// ==================== 六、天气关闭/无地图系统时安全降级 ====================
{
  const { ents, fx } = await makeWorld();
  const gts = new GroundTraceSystem(ents, fx, null, null); // 无 mapSystem、无 weatherSystem
  for (let i = 0; i < 50; i++) gts.update(1); // 不应抛异常
  T('降①-mapSystem/weatherSystem 都缺失时不抛异常、不生成任何痕迹',
    gts.puddles.length === 0 && gts.trails.length === 0);
}

done();
