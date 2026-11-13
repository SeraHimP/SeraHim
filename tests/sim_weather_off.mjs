// 关掉天气后，天气可视化一并关掉（用户："目前我手动关闭天气后，天气可视化效果依旧会残留"）。
// 根因两处：① WeatherSystem 关掉后不再推进，充能停在关掉那一刻，渲染层（雷光、风摆、雾）直接读它；
//          ② 地面的水洼 / 积雪是累积量，关掉后只会慢慢退，树上/塔上/地上的雪还挂着。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation } = await import('../src/simulation.js');
const { T, done } = scoreboard('关闭天气');

const sim = createSimulation();
sim.mapSystem.loadMap('howling_abyss_frost_v1');
const ws = sim.weatherSystem, gts = sim.groundTraceSystem;
// 造一个"正在下雨下雪"的现场
ws._charge.rain = 0.9; ws._charge.snow = 0.8; ws._charge.fog = 0.6;
gts._ensureSnowGrid(sim.mapSystem.currentMap.world);
gts.snowGrid.fill(0.7); gts.snowGlobalTarget = 0.7;
gts.puddles.push({ id: 1, x: 100, y: 100, r: 20, strength: 1, subOffsets: [] });
T('①开着天气时读得到充能', ws.getCharge('rain') > 0.5);

ws.setEnabled(false);
T('②关掉天气：所有充能读 0（雷光/风摆/雾不再按旧天气画）', ['rain', 'snow', 'fog', 'wind', 'thunderstorm', 'hurricane'].every((id) => ws.getCharge(id) === 0));
gts.update(0.016);
T('③关掉天气后的下一帧：水洼清空', gts.getPuddles().length === 0);
T('④关掉天气后的下一帧：地面积雪清零（树上、塔上、边界装饰的雪都读它）',
  gts.getSnowCover().data.every((v) => v === 0) && gts.getSnowTarget().globalTarget === 0);

ws.setEnabled(true);
T('⑤重新打开：充能恢复原值（关掉不是清空天气进程）', ws.getCharge('rain') > 0.5);

done();
