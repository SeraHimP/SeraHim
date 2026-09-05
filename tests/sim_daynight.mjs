// v51.26：太阳方位角随时段扫动 + 天气驱动的阴天压光。
// 用户报的两件事：①"光线的角度要模拟真实的，并且要和天气系统联动，如果有雨的话，
// 云层是不是就遮住阳光了" —— 对应 DayNight.js 新增的 azim 关键帧列 +
// weatherOvercastFactor/applyWeatherOvercast；main.js 渲染循环里把两者串起来调用。
import { srcOf, scoreboard } from './_harness.mjs';

globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };

const { dayNightAt, weatherOvercastFactor, applyWeatherOvercast }
  = await import('../src/presentation/DayNight.js');
const { WeatherSystem } = await import('../src/systems/WeatherSystem.js');
const { CONFIG } = await import('../src/data/Config.js');

const { T, done } = scoreboard('DayNight（太阳方位角 + 天气压光）');

// ==================== 源码形态：azim 列确实存在，main.js 确实接了 ====================
{
  const src = srcOf('src/presentation/DayNight.js');
  T('KEYS 表新增 azim 列', /azim:\s*105/.test(src) && /azim:\s*135/.test(src) && /azim:\s*165/.test(src));
  T('dayNightAt 返回值带 sunAzimuth', /sunAzimuth:\s*a\.azim/.test(src));
  T('weatherOvercastFactor 已导出', /export function weatherOvercastFactor/.test(src));
  T('applyWeatherOvercast 已导出', /export function applyWeatherOvercast/.test(src));
}
{
  const src = srcOf('src/main.js');
  T('main.js 导入了 applyWeatherOvercast', /applyWeatherOvercast/.test(src) && /from '\.\/presentation\/DayNight\.js'/.test(src));
  T('main.js 渲染循环里 setLighting 套了 applyWeatherOvercast', /setLighting\(applyWeatherOvercast\(dayNightAt\(/.test(src));
}
{
  const src = srcOf('src/presentation/ThreeRenderer.js');
  T('setLighting 接收 sunAzimuth 参数', /sunAzimuth/.test(src));
}
{
  const src = srcOf('src/data/Config.js');
  T('Config 里有 weatherLighting 软编码块', /weatherLighting:\s*\{/.test(src));
}

// ==================== dayNightAt：正午方位角与改动前逐位一致，昼夜之间平滑插值 ====================
{
  const noon = dayNightAt(120, 480); // p=0.25 → 正午关键帧
  T('正午 sunAzimuth = 135°（与改动前固定值一致）', Math.abs(noon.sunAzimuth - 135) < 0.01);

  const dawn = dayNightAt(0, 480);
  T('黎明 sunAzimuth = 105°', Math.abs(dawn.sunAzimuth - 105) < 0.01);

  const dusk = dayNightAt(240, 480); // p=0.50 → 黄昏关键帧
  T('黄昏 sunAzimuth = 165°', Math.abs(dusk.sunAzimuth - 165) < 0.01);

  const mid1 = dayNightAt(60, 480);  // p=0.125，介于黎明(105)与正午(135)之间
  T('黎明→正午之间的方位角单调过渡', mid1.sunAzimuth > 105 && mid1.sunAzimuth < 135);
}

// ==================== weatherOvercastFactor：只有雨/雾/雪算云，风/晴不算 ====================
{
  T('无天气系统 → 云量 0', weatherOvercastFactor(null) === 0);

  const wsOff = { enabled: false, getCharge: () => 1 };
  T('天气系统禁用 → 云量 0', weatherOvercastFactor(wsOff) === 0);

  const wsClear = { enabled: true, getCharge: (id) => 0 };
  T('全部充能为 0 → 云量 0', weatherOvercastFactor(wsClear) === 0);

  const wsRain = { enabled: true, getCharge: (id) => (id === 'rain' ? 0.5 : 0) };
  const W = CONFIG.ui.weatherLighting;
  T('纯雨：云量 = charge × rainWeight', Math.abs(weatherOvercastFactor(wsRain) - 0.5 * W.rainWeight) < 1e-9);

  const wsWind = { enabled: true, getCharge: (id) => (id === 'wind' ? 1 : 0) };
  T('风不参与遮光', weatherOvercastFactor(wsWind) === 0);

  const wsAll = { enabled: true, getCharge: (id) => 1 };
  T('多天气叠满时云量封顶在 1', weatherOvercastFactor(wsAll) === 1);
}

// ==================== applyWeatherOvercast：晴天不改参数，阴天三件套联动 ====================
{
  const base = dayNightAt(120, 480); // 正午
  const wsClear = { enabled: true, getCharge: () => 0 };
  const outClear = applyWeatherOvercast(base, wsClear);
  T('云量 0 时原样返回（同一对象）', outClear === base);

  const wsRain = { enabled: true, getCharge: (id) => (id === 'rain' ? 1 : 0) };
  const outRain = applyWeatherOvercast(base, wsRain);
  T('阴天：曝光下降', outRain.exposure < base.exposure);
  T('阴天：环境光占比上升', outRain.ambientShare > base.ambientShare);
  T('阴天：环境光占比不超过 maxAmbientShare', outRain.ambientShare <= CONFIG.ui.weatherLighting.maxAmbientShare + 1e-9);
  T('阴天：太阳色变了（往灰调拉）', outRain.sunColor !== base.sunColor);
  T('阴天：天空色变了（往灰调拉）', outRain.ambientSky !== base.ambientSky);
  T('阴天：unitTint 跟着重算（不再是原来那个白/亮色）', outRain.unitTint !== base.unitTint);
  T('阴天：其余字段（太阳仰角/方位角等）原样透传', outRain.sunElevation === base.sunElevation && outRain.sunAzimuth === base.sunAzimuth);

  // 云量越大，压光越狠（单调性）
  const wsRainLight = { enabled: true, getCharge: (id) => (id === 'rain' ? 0.2 : 0) };
  const outLight = applyWeatherOvercast(base, wsRainLight);
  T('云量越大曝光压得越低（单调）', outRain.exposure < outLight.exposure && outLight.exposure < base.exposure);
}

// ==================== 与真实 WeatherSystem 联动（不是靠假对象凭空过） ====================
{
  const ws = new WeatherSystem(null);
  ws.enabled = true;
  ws._charge.rain = 0.6;
  const base = dayNightAt(120, 480);
  const out = applyWeatherOvercast(base, ws);
  T('真实 WeatherSystem 实例接入同样生效', out.exposure < base.exposure);

  ws._charge.rain = 0;
  const outClear = applyWeatherOvercast(base, ws);
  T('真实 WeatherSystem 充能归零后恢复原参数', outClear === base);
}

// ==================== v54：光照软编码 + 太阳仰角上限 ====================
// 加这一组的理由：割裂感的根因之一是"影子几乎不存在"（正午仰角 82°，影子压在脚下）。
// 这个上限就是拉长影子的那根杠杆，必须有断言守着 —— 没有断言守的行为，
// 下一个人改两行就没了（CLAUDE.md 第 1 条）。
{
  const L = CONFIG.ui.lighting;
  T('光①-光照参数已软编码进 CONFIG.ui.lighting（不再是模块里写死的常量）',
    typeof L?.sunElevDeg === 'number' && typeof L?.ambientShare === 'number'
    && typeof L?.maxSunElevDeg === 'number' && typeof L?.shadowMapSize === 'number');

  const sav = L.maxSunElevDeg;
  // 上限调低 → 全天任意时刻的仰角都不超过它。钉的是"夹取真的生效"这个行为形状，
  // 不是某个具体角度（角度是会调的）。
  L.maxSunElevDeg = 30;
  let maxSeen = 0;
  for (let i = 0; i < 48; i++) maxSeen = Math.max(maxSeen, dayNightAt(i * 10, 480).sunElevation);
  T(`光②-仰角上限生效：全天最高仰角 ${maxSeen.toFixed(1)}° ≤ 30°`, maxSeen <= 30 + 1e-9);

  // 上限拉满 = 不夹。这条守的是"默认不改变行为"——参数化那一步必须是视觉空操作。
  L.maxSunElevDeg = 90;
  const noonFree = dayNightAt(120, 480).sunElevation;
  T(`光③-上限 90 时不夹取（正午仍是关键帧原值 ${noonFree.toFixed(1)}°）`, noonFree > 80);
  L.maxSunElevDeg = sav;
}

done();
