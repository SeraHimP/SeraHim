// Auto-injected: minimal CTX shim for test environment.
if (typeof window !== "undefined" && !window.CTX) {
  window.CTX = {
    gameTime: 0, waveNumber: 0, gamePaused: false, _uid: 0,
    _nextWaveTime: 20, __gameSpeed: 1, __ffRemain: 0,
    __showLanePaths: false,
    __towerRules: {
      invincible: { blue: false, red: false },
      attackOff:  { blue: false, red: false },
      waveOn:     { blue: true,  red: true  },
    },
    __towerRuleFor(kind, faction) {
      const r = this.__towerRules?.[kind];
      if (!r) return false;
      if (!faction) return r.blue || r.red;
      return !!r[faction];
    },
    __app: null, __weather: null, __mapSystem: null,
    __uiManager: null, __weatherPanel: null, __entityContainer: null,
    __perf: null, __score: null, __gameLoop: null,
    createMinion: null, createTower: null,
  };
}

// 天气系统验收
globalThis.window={gameTime:0,_uid:0};
const {WeatherSystem}=await import('../src/systems/WeatherSystem.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {BASE_WEATHERS,EXTREME_WEATHERS}=await import('../src/data/Weather.js');
const {CONFIG}=await import('../src/data/Config.js');
const CONFIG_T=CONFIG.tuning||{};
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

const ws=new WeatherSystem(null);
AttributeCalculator.setWeatherSystem(ws);

// ---- 关闭时零影响 ----
const mkTower=(w)=>({id:++window._uid,type:'tower',baseStats:{maxHP:3000,attackDamage:200,magicPenFlat:0,
  armor:50,magicResist:50,moveSpeed:0,baseAttackSpeed:0.833,attackRange:180,healthRegen:0,shieldFixedMax:0},
  currentHP:3000,_skillInstances:w?[{skillId:w}]:[]});
const t0=mkTower(null);
AttributeCalculator.tick();
const base=AttributeCalculator.calc(t0,[]);
T('天气关闭时属性不受影响', base.attackDamage===200 && base.magicPenFlat===0);
// 用户定稿：天气【默认开启】（昼夜默认跟随天气开关，所以这一行同时决定开局有没有昼夜循环）
T('天气默认开启（用户定稿）', ws.enabled === true);

ws.setEnabled(true);

// ---- 权重归一化 ----
for(let i=0;i<50;i++) ws.update(1);
const w=ws.getWeights();
const sum=Object.values(w).reduce((a,b)=>a+b,0);
T('权重归一化(和=1)', Math.abs(sum-1)<1e-9);
T('权重全部非负', Object.values(w).every(v=>v>=0));
T('包含全部5种基础天气', Object.keys(w).length===Object.keys(BASE_WEATHERS).length);

// ---- 连续性（时间线模型） ----
// Q3 修复后：整条天气时间线在 reset 时一次性预生成，运行时只是在这条【已确定的曲线】
// 上按时钟插值。所以连续性的判据变了：
//   · 不再是"步长减半→跳变按√dt缩小"（那是实时随机游走的特征，现已不适用——
//     任意 dt 都是在同一条曲线上采样，跳变只取决于走过的时间跨度）
//   · 而是"同一时刻的权重恒定"（可重入）+ "沿时间线平滑"（相邻时刻差异有界）
{
  const w2=new WeatherSystem(null); w2.setEnabled(true); w2.reset(20240613);
  // 平滑性：沿时间线每秒的变化有界
  let mx=0, prev=w2.getWeights();
  for(let i=0;i<600;i++){ w2.update(1); const cur=w2.getWeights();
    for(const id of Object.keys(cur)) mx=Math.max(mx,Math.abs(cur[id]-prev[id]));
    prev=cur; }
  T('权重沿时间线平滑演化(单秒变化<35%)', mx<0.35);

  // 可重入：不同步长走到同一时刻，权重必须完全一致（时间线是确定的）
  const wa=new WeatherSystem(null); wa.setEnabled(true); wa.reset(777);
  const wb=new WeatherSystem(null); wb.setEnabled(true); wb.reset(777);
  for(let i=0;i<120;i++) wa.update(1);      // 120 步 × 1s
  for(let i=0;i<480;i++) wb.update(0.25);   // 480 步 × 0.25s —— 同样走到 t=120
  const A=wa.getWeights(), B=wb.getWeights();
  const same=Object.keys(A).every(id=>Math.abs(A[id]-B[id])<1e-6);
  T('时间线确定性：不同步长走到同一时刻，权重完全一致', same);
}

// ==================== Q1 重构：四档强度 + 充能条 + 渐进消散 ====================
{
  const {INTENSITY_TIERS, tierOf}=await import('../src/data/Weather.js');
  T('Q1 四档定义完整（无/轻微/有限/中等/严重）', INTENSITY_TIERS.length===5);
  T('Q1 档位系数为 25/50/75/100%',
    INTENSITY_TIERS.filter(t=>t.scale>0).map(t=>t.scale).join(',')==='0.25,0.5,0.75,1');
  T('Q1 进度格为 0/1/2/3（不是 0-100 数值）',
    INTENSITY_TIERS.filter(t=>t.scale>0).map(t=>t.pips).join(',')==='0,1,2,3');

  // 注意：update() 每帧从时间线重采样 _x，所以不能手动设 _x 后调 update（会被覆盖）。
  // 直接驱动充能引擎测试：伪造一个恒定的权重读数。
  const wc=new WeatherSystem(null); wc.setEnabled(true); wc.reset(2024);
  const forceWeights=(w)=>{ wc.getWeights=()=>w; };

  // 纯雨天：充能应逐步爬升，档位逐级提高
  forceWeights({clear:0,rain:1,fog:0,wind:0,snow:0});
  const seen=new Set();
  for(let t=0;t<200;t++){ wc._updateCharges(1); seen.add(wc.getTier('rain').id); }
  T('Q1 充能逐级爬升（经历过多个档位，不是瞬间满档）', seen.size>=4);
  T('Q1 持续高占比 → 达到高档位', ['moderate','severe'].includes(wc.getTier('rain').id));

  // 天气回落 → 影响【渐进消散】而非立即消失
  const beforeCharge=wc.getCharge('rain');
  forceWeights({clear:1,rain:0,fog:0,wind:0,snow:0});
  wc._updateCharges(1);
  const afterOneSec=wc.getCharge('rain');
  T('Q1 天气回落后充能不瞬间归零（渐进消散）',
    afterOneSec > beforeCharge*0.8 && afterOneSec < beforeCharge);
  let drained=0;
  for(let t=1;t<=400;t++){ wc._updateCharges(1); if(wc.getCharge('rain')<0.02){ drained=t; break; } }
  T('Q1 消散需要时间（不是一帧掉光，实测 >20s）', drained>20);
  T('Q1 消散比积累慢（drainSec > fullSec）',
    (CONFIG_T.weatherDrainSec ?? 30) > (CONFIG_T.weatherChargeFullSec ?? 20));

  // 效果强度 = 档位系数（离散，不是连续数值）
  const strengths=new Set();
  const wc2=new WeatherSystem(null); wc2.setEnabled(true); wc2.reset(88);
  for(let t=0;t<600;t++){ wc2.update(1);
    for(const v of Object.values(wc2.getEffectiveStrengths())) strengths.add(v); }
  T('Q1 生效强度只有四档（离散，不再是连续数值）',
    [...strengths].every(v=>[0.25,0.5,0.75,1].includes(v)));
}

// ==================== Q4：雨天主题重做 + 无用属性清除 ====================
{
  const {BASE_WEATHERS, EXTREME_WEATHERS}=await import('../src/data/Weather.js');
  const all=[...Object.values(BASE_WEATHERS), ...Object.values(EXTREME_WEATHERS)];
  const keys=new Set(all.flatMap(d=>d.effects.map(e=>e.statKey)));
  T('Q4 已移除小兵生命偷取（小兵用不到）', !keys.has('lifeStealPct'));
  T('v33 雷暴给塔通用双穿（雷电击穿）',
    EXTREME_WEATHERS.thunderstorm.effects.some(e=>e.targets==='towers'&&e.statKey==='armorPenPercent'&&e.flat>0)
    && EXTREME_WEATHERS.thunderstorm.effects.some(e=>e.targets==='towers'&&e.statKey==='magicPenPercent'&&e.flat>0));

  const rain=BASE_WEATHERS.rain.effects;
  const has=(t,k)=>rain.some(e=>e.targets===t && e.statKey===k);
  T('v33 雨天：塔 +4 生命恢复', rain.some(e=>e.targets==='towers'&&e.statKey==='healthRegen'&&e.flat===4));
  T('Q4 雨天：塔 +33% 治疗护盾强度',
    rain.some(e=>e.targets==='towers'&&e.statKey==='healShieldPowerPct'&&e.flat===33));
  T('v33 雨天：小兵 减移速、减双抗（塔优势）',
    rain.some(e=>e.targets==='minions'&&e.statKey==='moveSpeed'&&e.percent<0)
    && rain.some(e=>e.targets==='minions'&&e.statKey==='armor'&&e.flat<0));

  const ts=EXTREME_WEATHERS.thunderstorm.effects;
  T('Q4 雷暴：塔攻速提升、小兵双抗与攻速下降',
    ts.some(e=>e.targets==='towers'&&e.statKey==='bonusAttackSpeedPct'&&e.flat>0)
    && ts.some(e=>e.targets==='minions'&&e.statKey==='armor'&&e.flat<0)
    && ts.some(e=>e.targets==='minions'&&e.statKey==='bonusAttackSpeedPct'&&e.flat<0));
  T('Q4 暴雨存在且同款主题', !!EXTREME_WEATHERS.downpour);
}

// ==================== v33 追加：单基础极端天气（5 种） ====================
{
  const {EXTREME_WEATHERS}=await import('../src/data/Weather.js');
  const singles=Object.values(EXTREME_WEATHERS).filter(d=>Object.keys(d.trigger).length===1);
  const pairs=Object.values(EXTREME_WEATHERS).filter(d=>Object.keys(d.trigger).length===2);
  T('极端天气共 15 种（10 组合 + 5 单基础）', Object.keys(EXTREME_WEATHERS).length===15 && singles.length===5 && pairs.length===10);
  T('每种基础天气各有一个单基础极端', ['clear','rain','fog','wind','snow'].every(b=>singles.some(d=>d.trigger[b]!==undefined)));
  T('单基础极端阈值(0.62)显著高于组合单边阈值(0.26)', singles.every(d=>Object.values(d.trigger)[0]>=0.6) && pairs.every(d=>Object.values(d.trigger).every(v=>v<=0.3)));

  // 行为：纯雨独大 → 洪涝触发（可达极端档），组合极端不触发；晴雨均分 → 太阳雨触发，单基础不触发
  const wsA=new WeatherSystem(null); wsA.setEnabled(true); wsA.reset(901);
  wsA.getWeights=()=>({clear:0,rain:1,fog:0,wind:0,snow:0});
  for(let t=0;t<600;t++) wsA._updateCharges(1);
  T('雨独大 → 单基础极端【洪涝】涌现并达第5档', wsA.getCharge('flood')>0.88 && wsA.getTier('flood').isExtremeTier===true);
  T('雨独大 → 组合极端不误触发', wsA.getCharge('sunshower')<0.05 && wsA.getCharge('downpour')<0.05);
  const wsB=new WeatherSystem(null); wsB.setEnabled(true); wsB.reset(902);
  wsB.getWeights=()=>({clear:0.5,rain:0.5,fog:0,wind:0,snow:0});
  for(let t=0;t<600;t++) wsB._updateCharges(1);
  T('晴雨均分 → 组合极端【太阳雨】涌现', wsB.getCharge('sunshower')>0.4);
  T('晴雨均分 → 单基础极端不误触发（两边都到不了0.62）', wsB.getCharge('flood')<0.05 && wsB.getCharge('scorch')<0.05);
}

// ==================== Q3（v51.6 改写）：极端天气不再有逐条可调权重 ====================
// 用户："极端天气不是有固定生成条件吗？极端天气的权重到底有没有实际意义？如果没有的话
// 可以直接删除极端天气的权重。" —— getExtremeWeight/setExtremeWeight 整个删掉了，
// 极端天气现在只由固定 trigger + 全局难度旋钮 weatherExtremeThresholdScale 决定，
// 关闭走 setWeatherDisabled。这里把原来那三条"权重可调"的断言换成验证新形状：
// 方法真的不存在了、全局旋钮仍然生效、EXTREME_WEATHERS 数据里也没有残留的 weight 字段。
{
  const wq=new WeatherSystem(null); wq.setEnabled(true); wq.reset(31);
  T('Q3① getExtremeWeight/setExtremeWeight 已整体删除，不再是可调项',
    typeof wq.getExtremeWeight === 'undefined' && typeof wq.setExtremeWeight === 'undefined');
  T('Q3② EXTREME_WEATHERS 数据里不再有 weight 字段（曾经的逐条权重来源）',
    Object.values(EXTREME_WEATHERS).every(def => !('weight' in def)));
  // 全局难度旋钮仍然生效：scale 越大，阈值越高（越难触发）——这条没变，只是不再叠加权重项。
  const T1 = CONFIG.tuning || (CONFIG.tuning = {});
  const origScale = T1.weatherExtremeThresholdScale;
  T1.weatherExtremeThresholdScale = 1;
  const thAt1 = wq._extremeThreshold('thunderstorm', 0.5);
  T1.weatherExtremeThresholdScale = 2;
  const thAt2 = wq._extremeThreshold('thunderstorm', 0.5);
  T1.weatherExtremeThresholdScale = origScale;
  T('Q3③ 全局难度旋钮仍然生效（scale 越大阈值越高，越难触发）', thAt2 > thAt1);
  T('Q3④ 关闭极端天气只剩 setWeatherDisabled 这一条真开关',
    typeof wq.setWeatherDisabled === 'function' && typeof wq.isWeatherDisabled === 'function');
}

// ---- 缓存随天气失效 + 禁用天气 ----
{
  const wk=new WeatherSystem(null); wk.setEnabled(true); wk.reset(4444);
  AttributeCalculator.setWeatherSystem(wk);
  const tw={id:++window._uid,type:'tower',
    baseStats:{maxHP:4000,attackDamage:200,armor:70,magicResist:70,moveSpeed:0,
      baseAttackSpeed:1,attackRange:180,healthRegen:0,shieldFixedMax:0,healShieldPowerPct:0},
    currentHP:4000,_skillInstances:[]};

  // 强制纯雨天并充满能（雨天给塔 +4 生命恢复 / +33% 治疗护盾强度）。
  // v33：纯雨独大会连带触发单基础极端【洪涝】（这正是新机制的语义），
  // 此处要隔离验证的是雨天本体的数值管线 → 先禁用洪涝。
  wk.setWeatherDisabled('flood', true);
  wk.getWeights=()=>({clear:0,rain:1,fog:0,wind:0,snow:0});
  for(let t=0;t<300;t++) wk._updateCharges(1);
  AttributeCalculator.tick();
  const rainy=AttributeCalculator.calc(tw,[]);
  T('雨天满档：塔生命恢复 +4', Math.abs(rainy.healthRegen-4)<0.1);
  T('雨天满档：塔治疗护盾强度 +33%', Math.abs(rainy.healShieldPowerPct-33)<0.5);

  // 天气切走并放空 → 属性回落（验证缓存随天气失效）。
  // v33：切到【风】——晴天新表给全员 +2 恢复，会污染"回落到 0"的判定；风天无恢复词条。
  wk.getWeights=()=>({clear:0,rain:0,fog:0,wind:1,snow:0});
  for(let t=0;t<400;t++) wk._updateCharges(1);
  AttributeCalculator.tick();
  const dry=AttributeCalculator.calc(tw,[]);
  T('天气消散后属性回落（缓存随天气正确失效）', dry.healthRegen<0.5);

  // 禁用某天气 → 其充能与效果归零
  wk.setWeatherDisabled('rain', true);
  wk.getWeights=()=>({clear:0,rain:1,fog:0,wind:0,snow:0});
  for(let t=0;t<300;t++) wk._updateCharges(1);
  T('禁用的天气不充能（效果为零）', wk.getCharge('rain')<0.02);
  AttributeCalculator.tick();
  T('禁用的天气不产生属性修正', AttributeCalculator.calc(tw,[]).healthRegen<0.5);
  wk.setWeatherDisabled('rain', false);
  AttributeCalculator.setWeatherSystem(ws);
}

// ---- 预报 ----// ---- 预报 ----
const fc=ws.getForecast();
T('预报队列非空', fc.length>10);
T('预报时间递增且指向未来', fc[0].t<=ws.clock+0.1 && fc[fc.length-1].t>ws.clock+100);
T('预报每点权重也归一化', fc.every(f=>Math.abs(Object.values(f.weights).reduce((a,b)=>a+b,0)-1)<1e-6));

// ---- 每局随机 ----
const durs=new Set();
for(let i=0;i<20;i++){const w2=new WeatherSystem(null);w2.reset(i*991);durs.add(w2.averageDuration);}
T('每次reset天气性格随机(θ不同)', durs.size>15);
const inRange=[...durs].every(d=>d>=60&&d<=600);
T('主导时长落在60~600秒区间', inRange);

// ==================== 入口可达性（v21 事故：开关把自己藏起来了） ====================
// 教训：天气入口原本只做在天气预报条上，而预报条在天气【关闭时是隐藏的】——
// 于是"开启天气"的按钮藏在"天气开启后才出现"的容器里，用户根本无从开启。
// 任何功能的开关，都必须放在【与该功能状态无关】的、永远可达的位置。
import fs from 'fs';
{
  const settings = fs.readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  T('天气开关在设置面板里(永远可达)', settings.includes('setWeatherToggleBtn'));
  T('天气配置入口在设置面板里', settings.includes('setWeatherCfgBtn'));
  T('设置按钮本身永远可见(不在任何条件容器内)', html.includes('id="settingsBtn"'));
  // 挂载改走 CTX（GameContext 的 SYNC_KEYS 会同步到 window.__weatherPanel），
  // 断言跟着改成认 CTX 写法 —— 测的是"设置面板拿得到入口"，不是某个字面量。
  T('WeatherPanel 已挂到 window 供设置面板调用', /CTX\.__weatherPanel\s*=/.test(main));
  T('WeatherSystem 已挂到 window 供设置面板调用', /CTX\.__weather\s*=/.test(main));
  T('天气条每帧更新(主循环里有 WeatherPanel.update)', main.includes('WeatherPanel.update()'));
}

// ==================== Q3：预报必须是真的、且永不刷新 ====================
// 事故：原实现把"OU 是马尔可夫过程"误当成"能推演未来"，但未来的随机数还没生成——
// 于是另开一条随机序列去猜，猜的不准（t=0 预报 t=60 是 40.9%，实际 14.3%），
// 而且每 8 秒重推、每次种子不同 → 同一未来时刻的预报值来回变
//   → 用户看到的"天气突然刷新、不连续"。
// 修复：整条时间线开局即确定，预报读的就是真实的未来。
{
  const w3=new WeatherSystem(null); w3.setEnabled(true); w3.reset(20260101);
  const pred=w3.getForecast().find(f=>Math.abs(f.t-60)<1.5);
  const predRain=pred.weights.rain;
  const pred100=w3.getForecast().find(f=>Math.abs(f.t-100)<1.5).weights.rain;
  for(let i=0;i<60;i++) w3.update(1);
  T('Q3 预报准确：t=0 对 t=60 的预报 = 实际走到 t=60 的值',
    Math.abs(predRain - w3.getWeights().rain) < 1e-6);
  const pred100b=w3.getForecast().find(f=>Math.abs(f.t-100)<1.5).weights.rain;
  T('Q3 预报稳定：时间推进后，对同一未来时刻的预报不变（永不刷新）',
    Math.abs(pred100 - pred100b) < 1e-6);
  // 禁用某天气不应"洗牌"未来
  const before=w3.getForecast().find(f=>Math.abs(f.t-w3.clock-80)<1.5).weights.wind;
  w3.setWeatherDisabled('fog', true);
  w3.setWeatherDisabled('fog', false);
  const after=w3.getForecast().find(f=>Math.abs(f.t-w3.clock-80)<1.5).weights.wind;
  T('Q3 开关天气不重算时间线（未来不被洗牌）', Math.abs(before-after)<1e-6);
}

// ==================== v26 事故：预报采样点必须对齐网格（否则右端闪烁） ====================
{
  const w4=new WeatherSystem(null); w4.setEnabled(true); w4.reset(4321);
  const snap=[];
  for(let i=0;i<6;i++){ w4.update(1/30); snap.push(w4.getForecast().map(f=>f.t).slice(0,4).join(',')); }
  T('v26 预报采样点对齐固定网格（连续帧内不抖 → 天气条右端不闪）',
    new Set(snap).size===1);
  const f=w4.getForecast();
  T('v26 预报覆盖到窗口之外（两端各多一格，边缘不露白）',
    f[0].t <= w4.clock && f[f.length-1].t >= w4.clock+180);
}

// ==================== v26 事故：UI 传错变量导致每帧崩溃 ====================
{
  const ui=fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url),'utf8');
  T('v26 天气行调用传对了变量（tower/minion 各自的参数名）',
    ui.includes('this._updateWeatherRow(card, tower);') && ui.includes('this._updateWeatherRow(card, minion);')
    && !ui.includes('this._updateWeatherRow(card, e);'));
  T('v26 天气行有空值防御（调用方传错也不拖垮游戏循环）',
    ui.includes('if (!entity || !def?.effects) return false;'));
}

// ==================== mu 可调 + 气候模板（v27） ====================
{
  const {CLIMATE_TEMPLATES}=await import('../src/data/Weather.js');
  const w5=new WeatherSystem(null); w5.setEnabled(true); w5.reset(555);
  for(let i=0;i<200;i++) w5.update(1);

  // 调 mu：当下不跳变，未来按新规则演化
  const before=w5.getWeights().rain;
  const t0=performance.now();
  w5.setMu('rain', 1.0);
  const cost=performance.now()-t0;
  const after=w5.getWeights().rain;
  T('v27 调 mu 后当下权重不跳变（从当前时刻接续）', Math.abs(before-after)<0.005);
  // v38.1：原为墙钟阈值断言（cost<30ms），在 CI/打包等 I/O 争用场景会随机红（实测与 zip
  // 并发时失败、单跑 7 次全绿）。性能护栏改为【只在明显异常时报警】的宽松阈值 500ms，
  // 真正的正确性由"当下权重不跳变"那条保证；顺带打印实测耗时供人工观察。
  console.log(`  （setMu 重算耗时 ${cost.toFixed(1)}ms）`);
  T('v27 调 mu 的重算无病态开销（<500ms；精确性能看上面打印值）', cost<500);
  // mu 的效果体现在【长期均值】上（它是 OU 的均值回归目标），不是几百秒内的瞬时值。
  let sum=0; const N=1800;
  for(let i=0;i<N;i++){ w5.update(1); sum+=w5.getWeights().rain; }
  T('v27 调高 mu 后该天气的长期占比显著上升（滑条真的有效）', sum/N > before + 0.15);
  T('v27 mu 被钳制在 -1~+1', (w5.setMu('fog', 5), w5.getMu('fog')===1) && (w5.setMu('fog',-5), w5.getMu('fog')===-1));

  // 气候模板：每个模板的主导天气必须符合其气候
  const expect={ desert:'clear', rainforest:'rain', polar:'snow', oceanic:'fog', steppe:'wind' };
  for(const [tplId, wantTop] of Object.entries(expect)){
    const agg={};
    for(let seed=1;seed<=3;seed++){
      const wt=new WeatherSystem(null); wt.setEnabled(true);
      wt._template=tplId; wt.reset(seed*313);
      for(let t=0;t<1200;t++){ wt.update(1);
        for(const [k,v] of Object.entries(wt.getWeights())) agg[k]=(agg[k]||0)+v; }
    }
    const top=Object.entries(agg).sort((a,b)=>b[1]-a[1])[0][0];
    T(`v27 气候模板「${CLIMATE_TEMPLATES[tplId].name}」主导天气为 ${wantTop}`, top===wantTop);
  }
  T('v27 全随机模板存在且为默认', CLIMATE_TEMPLATES.random && CLIMATE_TEMPLATES.random.mu===null);
}

// ==================== 天气条布局（v27） ====================
{
  const panel=fs.readFileSync(new URL('../src/ui/WeatherPanel.js', import.meta.url),'utf8');
  T('v27 游标在 20% 处（左侧显示过去、右侧未来）', panel.includes('CURSOR_RATIO = 0.20'));
  T('v27 刻度只有 4 条（20/40/60/80%）', panel.includes('[0.2, 0.4, 0.6, 0.8]'));
  // v47：条被缩成 3px 的细线之后，刻度/游标的线宽改成按高度分支
  //（细条上 3px 的游标会把条整个盖住）。断言随之钉"粗细两档都在"，不再钉字面量。
  T('v27 刻度加粗（2px）、游标更粗（3px，细条模式下降为 2px）',
    panel.includes('ctx.lineWidth = 2;') && panel.includes('ctx.lineWidth = thin ? 2 : 3;'));
  T('v27 密集的层间分隔线已移除', !panel.includes('层间分隔线'));
  const wsSrc=fs.readFileSync(new URL('../src/systems/WeatherSystem.js', import.meta.url),'utf8');
  T('v27 预报覆盖过去（游标左侧不露白）', wsSrc.includes('const PAST = 40;'));
}

// ==================== v28：模板要有"倾向"而非"独裁" ====================
{
  const stats = (tpl) => {
    let clearSec=0, exSec=0, varietySec=0; const dom={};
    for(let seed=1;seed<=3;seed++){
      const w=new WeatherSystem(null); w.setEnabled(true); w._template=tpl; w.reset(seed*77);
      for(let t=0;t<3600;t++){ w.update(1);
        const wt=w.getWeights();
        if(wt.clear>0.25) clearSec++;
        if(w.getActiveExtremes().length) exSec++;
        const sorted=Object.entries(wt).sort((a,b)=>b[1]-a[1]);
        if(sorted[1][1]>0.25) varietySec++;
        const d=w.getDominant().id; dom[d]=(dom[d]||0)+1;
      }
    }
    const top=Object.entries(dom).sort((a,b)=>b[1]-a[1])[0];
    return { clear: clearSec/10800, extreme: exSec/10800, variety: varietySec/10800,
             top: top[0], topRatio: top[1]/10800 };
  };
  const polar = stats('polar');
  T('v28 极地仍以雪为主导（模板性格保持）', polar.top==='snow' && polar.topRatio>0.35);
  T('v28 极地会偶尔放晴（不再是"永远极端天气"）', polar.clear > 0.05);
  T('v28 极地天气有变化（次要天气也常有存在感）', polar.variety > 0.30);
  const desert = stats('desert');
  T('v28 沙漠仍以晴为主导', desert.top==='clear' && desert.topRatio>0.4);
  T('v28 沙漠也有非晴天气（不是一片死晴）', desert.variety > 0.20);
}

// ==================== 天气条渲染（无接缝、无闪烁） ====================
{
  const panel=fs.readFileSync(new URL('../src/ui/WeatherPanel.js', import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  const wsSrc=fs.readFileSync(new URL('../src/systems/WeatherSystem.js', import.meta.url),'utf8');
  T('色带整条路径 fill（无接缝竖线、无闪烁）',
    panel.includes('每层画成【一条连续路径】'));
  // 天气条已并入右上角的【世界状态小窗】（时间/昼夜 · 天气 · 熵 三段一窗），
  // 不再是独立浮窗 #weatherWrap。这里改为钉住"天气是小窗里的一行"。
  // v47：世界状态小窗搬到了左上角、并进 #topbarLeft（用户："把天气时间条移动到左上角"）。
  // 所以判据从"在画布层之后"改成"在 #topbarLeft 里"——钉的仍是"天气是小窗里的一段"。
  T('天气段在世界状态小窗内，而小窗在左上角那块面板里',
    html.indexOf('id="worldHud"') > html.indexOf('id="topbarLeft"')
    && html.indexOf('id="whWeatherRow"') > html.indexOf('id="worldHud"'));
  // 天气名不再靠写死宽度稳住 —— 胶囊里名字与读数各自按内容排，
  // 色带是胶囊底边的绝对定位细线，本来就不受名字长短影响（这是比定宽更强的保证）。
  T('色带不随天气名长短左右跳（绝对定位，不参与胶囊内的横向排布）',
    /\.wh-chip \.wh-bar \{[^}]*position: absolute/.test(html));
  T('游标在 20%（左=过去，右=未来）', panel.includes('CURSOR_RATIO = 0.20'));
  T('刻度只有 4 条', panel.includes('[0.2, 0.4, 0.6, 0.8]'));
  T('极端天气图标按【时长】判断绘制（不随滚动抖动）',
    panel.includes('MIN_SEG_SECONDS') && panel.includes('edgeFade'));
  T('预报采样点对齐网格（右端不闪）', wsSrc.includes('const PAST = 40;'));
  T('预报覆盖过去（游标左侧不露白）', wsSrc.includes('gridStart'));
}

// ==================== Q2：三角形图标 + 3 格进度 + 点击弹窗 ====================
{
  const ui=fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  T('Q2 天气图标为三角形（SVG polygon）', ui.includes('<polygon points="17,3 32,27 2,27"'));
  // v33（Q2 重做）：下方 3 格进度删除，档位改为【外边框分段点亮】（逆时针 右→底→左）
  T('v33 档位=外边框分段点亮（3条边路径）',
    ui.includes("'M17,3 L32,27'") && ui.includes("'M32,27 L2,27'") && ui.includes("'M2,27 L17,3'"));
  T('v33 下方3格进度已删除', !html.includes('.wx-pips') && !ui.includes('wx-pips'));
  T('v33 极端天气辉光 + 第5档重辉光', html.includes('.wx-tri.extreme') && html.includes('.wx-tri.tier-extreme'));
  T('Q2 数值修正改为点击弹窗（不再常驻显示）',
    ui.includes('_showWeatherDetail') && !ui.includes('class="wx-effs"'));
  T('Q2 脏检查只看档位（防止 hover/点击被每帧重建打断）',
    ui.includes("const key = rows.map(r => r.def.id + ':' + r.tier.id).join('|');"));
  T('Q2 天气行节流 0.5s', ui.includes('box._nextAt = nowMs + 500;'));
}

// ==================== v51.6：极端天气 UI 简化（Q3+Q5）====================
// 用户："极端天气的权重到底有没有实际意义？如果没有的话可以直接删除。并且把
// 极端天气的UI简化并且美化一下。"——面板里的权重滑条（data-exw）整个删掉，
// 换成只读的实时充能进度条；基础天气那边的滑条（data-mu）不受影响。
{
  const panel = fs.readFileSync(new URL('../src/ui/WeatherPanel.js', import.meta.url), 'utf8');
  T('UI① 极端天气权重滑条（data-exw）已删除', !panel.includes('data-exw'));
  // v51.24：出现倾向（mu）的编辑控件从原生 <input type=range data-mu> 换成了 MIUI
  // 风格胶囊（data-pill，见下面那段），data-mu 这个属性名本身已经不存在了——
  // 断言随之改成"ws.setMu 仍然从这个控件被调用"，钉的是行为（还能编辑出现倾向），
  // 不是钉一个已经作废的具体属性名。
  T('UI②-出现倾向的编辑控件换成了胶囊（data-pill），原生滑条（data-mu）已删除',
    panel.includes('data-pill=') && !panel.includes('data-mu'));
  T('UI②b-胶囊仍然调 ws.setMu(id, v) 提交出现倾向，编辑能力没有跟着控件一起丢',
    /ws\.setMu\(id, v\)/.test(panel));
  T('UI③ 极端天气行改用只读的实时充能进度条（ws.getCharge）', /getCharge\(def\.id\)/.test(panel));
}

// ==================== v51.24：天气面板重做（Q3）====================
// 用户三条：① 基础天气行里那个静止的"当前XX%"文字与上方【实时与预报】重复，删掉；
// ② 基础天气的滑块条整体大改成 MIUI 风格胶囊，进度条在胶囊里填充且可滑动，
//    文字（图标+百分比）都显示在胶囊里；③【实时预报】下面的极端天气摘要，把
//    "有充能但还没生效"的也列进去、灰显，生效后正常显示。
// 这个面板高度依赖真实 DOM/canvas（document.createElement、requestAnimationFrame、
// 2D context），本文件里已有的其它 WeatherPanel UI 断言（UI①-③）走的都是"读源码
// 正则"这条路，不是真的渲染+交互——这里延续同一套办法，不额外搭一个和这个文件
// 惯例不一致的假 DOM 全量渲染。
{
  const panel = fs.readFileSync(new URL('../src/ui/WeatherPanel.js', import.meta.url), 'utf8');

  // ① 重复的静态"当前XX%"文字删掉了（旧版这一行的字面模式）
  T('胶①-基础天气行不再有旧版那句"· 当前 XX%"静态文字（与上方实时列表重复的那句）',
    !panel.includes("' · 当前 '"));

  // ② 胶囊：填充比例与文字都来自同一个 mu，点/拖任意位置直接跳值（无独立把手）
  T('胶②-基础天气行是一颗 data-pill 胶囊：填充层(.wx-pill-fill)+文字层同时存在',
    /class="wx-pill"/.test(panel) && panel.includes('wx-pill-fill') && panel.includes('wx-pill-label'));
  T('胶③-填充比例把 mu(-1~+1) 映射到 0~100%（(mu+1)/2），不是另算一套数',
    /Math\.round\(\(\(mu \+ 1\) \/ 2\) \* 100\)/.test(panel));
  T('胶④-胶囊里的文字就是这个映射出来的百分比（带符号），图标+百分比一起显示，没有中文名',
    /const label = \(mu >= 0 \? '\+' : ''\) \+ Math\.round\(mu \* 100\) \+ '%'/.test(panel));
  T('胶⑤-交互是 pointerdown 起手、pointermove 跟手、pointerup/cancel 收手——不是只认一次点击',
    panel.includes("addEventListener('pointerdown'") && panel.includes("addEventListener('pointermove'")
    && panel.includes("addEventListener('pointerup'") && panel.includes("addEventListener('pointercancel'"));
  T('胶⑥-点/拖【任意位置】直接跳值：按指针相对胶囊的位置算比例，不是只挪一个把手',
    /rect\.width \? Math\.max\(0, Math\.min\(1, \(clientX - rect\.left\) \/ rect\.width\)\) : 0/.test(panel));
  T('胶⑦-拖动仍然走原有的 120ms 防抖再提交 ws.setMu，没有丢掉"松手才重算时间线"这条性能保护',
    /muTimer = setTimeout\(\(\) => \{\s*ws\.setMu\(id, v\);/.test(panel));
  T('胶⑧-禁用某天气时胶囊整体调暗（opacity 0.45），但不再是 pointer-events:none 那种整体锁死',
    panel.includes("off ? 'opacity:0.45;'") && !/off \? 'opacity:0\.4;pointer-events:none;'/.test(panel));

  // ==================== v51.25：胶囊改小、禁用按钮并进胶囊里 ====================
  // 用户对 v51.24 的追加反馈："天气胶囊也太大了，做成小巧的（宽度大幅减少），
  // 禁用按钮最好也集成到胶囊里，目前的胶囊也太丑了。"
  T('胶⑨-胶囊改成按内容自适应宽度（inline-flex），不再是撑满一整行的 flex:1',
    panel.includes("display:inline-flex") && !panel.includes('flex:1;height:28px'));
  T('胶⑩-多颗胶囊用 flex-wrap 挤在一起（标签流布局），不再一行一个天气各占一整行',
    panel.includes('flex-wrap:wrap;gap:6px'));
  T('胶⑪-高度收窄到 22px（原来是 28px），确实变小了不是只改了说法',
    panel.includes('height:22px') && !panel.includes('height:28px'));
  // 注：极端天气区块（renderExtreme）仍然合法地保留着独立的 <button data-wx>——那部分
  // 这次没有要求改，只钉"基础天气区块（wxBase 那段模板里）不再输出这种 <button>"。
  const baseTplStart = panel.indexOf("baseBox.innerHTML");
  const baseTplEnd = panel.indexOf('}).join', baseTplStart);
  const baseTpl = panel.slice(baseTplStart, baseTplEnd);
  T('胶⑫-禁用开关是嵌在胶囊里的一颗小圆点（.wx-pill-power），基础天气这段模板里不再输出独立 <button>',
    baseTpl.includes('wx-pill-power') && !baseTpl.includes('<button'));
  T('胶⑬-圆点自己的 pointerdown 会 stopPropagation，不会被胶囊的拖拽逻辑先一步当成"拖到这个位置"',
    /dot\.addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\)/.test(panel));
  T('胶⑭-圆点的 click 才是真正切换禁用状态的地方，且同样 stopPropagation',
    /dot\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);\s*const id = dot\.dataset\.wx;\s*ws\.setWeatherDisabled/.test(panel));
  T('胶⑮-禁用某天气后，那颗圆点本身不会被一起锁死——不然禁用了就永远点不回来',
    (() => {
      const m = panel.match(/<span class="wx-pill-power"[\s\S]*?<\/span>\s*<\/div>`;/);
      return !!m && !m[0].includes('pointer-events:none');
    })());

  // ③ 极端天气摘要：充能中但未生效的也列出来，灰显；生效的正常显示
  T('极①-实时摘要不再只看 getActiveExtremes，逐个 EXTREME_WEATHERS 判断"有没有充能"',
    /Object\.values\(EXTREME_WEATHERS\)\s*\n\s*\.map\(def => \{\s*\n\s*const act = activeEx\.get\(def\.id\);/.test(panel));
  T('极②-未生效但有充能的行整体调暗（opacity 0.45），生效的不受影响',
    panel.includes("act ? '' : 'opacity:0.45;'"));
  T('极③-未生效行显示"充能 XX%"，生效行显示"强度 XX%"，不是同一句话',
    panel.includes("act ? '强度 ' : '充能 '"));
  T('极④-完全没充能（0%）且没生效的天气不占地方——不是把 15 种全部铺出来',
    panel.includes('if (!act && chargePct <= 0) return null;'));
}

// ==================== v51.26：占比/强度读出按帧缓存一次 ====================
// 用户报"开天气之后更卡"——getWeights()/getEffectiveStrengths()/getExtremeStrengths()
// 跟单位无关、是全局状态，本应整局每步只算一次，却被 AttributeCalculator 每个实体每帧
// 各调一次。这里钉的不是数值而是【缓存行为的形状】：同一步内重复调用拿到同一个对象引用
// （命中缓存，没有重新 new 一个），真正会让读数变化的入口调用后引用必须换掉（缓存失效）。
{
  const wc = new WeatherSystem(null);
  wc.setEnabled(true);
  wc.reset(2026);

  const w1 = wc.getWeights();
  const w2 = wc.getWeights();
  T('缓①-同一步内重复调用 getWeights() 命中缓存（同一个对象引用）', w1 === w2);

  const e1 = wc.getEffectiveStrengths();
  const e2 = wc.getEffectiveStrengths();
  T('缓②-同一步内重复调用 getEffectiveStrengths() 命中缓存', e1 === e2);

  const x1 = wc.getExtremeStrengths();
  const x2 = wc.getExtremeStrengths();
  T('缓③-同一步内重复调用 getExtremeStrengths() 命中缓存', x1 === x2);

  wc.update(1 / 30);
  const w3 = wc.getWeights();
  T('缓④-update() 推进一步后 getWeights() 换成新引用（不是拿着上一步的老值）', w3 !== w1);

  const e3 = wc.getEffectiveStrengths();
  T('缓⑤-update() 推进一步后 getEffectiveStrengths() 也换成新引用', e3 !== e1);

  // 直接调 _updateCharges（不经 update()）也要让 effStr/extStr 缓存失效——
  // 这条测的正是刚才修的那个坑：只在 update() 里失效覆盖不到直接调 _updateCharges 的调用方。
  const e4 = wc.getEffectiveStrengths();
  wc._updateCharges(1);
  const e5 = wc.getEffectiveStrengths();
  T('缓⑥-绕开 update() 直接调 _updateCharges() 同样让 getEffectiveStrengths() 缓存失效', e4 !== e5);

  wc.setMu('rain', 0.5);
  const w4 = wc.getWeights();
  T('缓⑦-setMu 之后 getWeights() 缓存失效换新引用', w4 !== w3);

  wc.setWeatherDisabled('rain', true);
  const e6 = wc.getEffectiveStrengths();
  T('缓⑧-setWeatherDisabled 之后 getEffectiveStrengths() 缓存失效换新引用', e6 !== e5 && e6 !== e4);
  wc.setWeatherDisabled('rain', false);

  wc.reset(1);
  const w5 = wc.getWeights();
  T('缓⑨-reset() 之后 getWeights() 缓存失效换新引用', w5 !== w4);
}

console.log(`天气验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
