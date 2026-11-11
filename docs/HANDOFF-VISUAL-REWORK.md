# 画面重构 · 交接清单（2026-11-11）

这份文件给"临时接手的模型"和"回来继续做的模型"共用。**先读完再动手。**
用户的分工要求原话：「看得见的可视化效果我要求你（Fable）来做，而不是 Opus，让 Opus 完成非可视化效果的工作」。

## 一、现在做到哪了

已提交并推送（分支 `claude/game-model-pitfalls-tasks-1qwt22`）：

- 透视相机、天空环境光、新昼夜表、MSAA 场景 Pass（取代 FXAA 和法线深度预渲染）、SSAO 改读主深度。
- 地形高度场 `src/data/terrainField.js`：可走区是地面，不可走区隆起成岩壁（rise）或下沉成深渊（drop），地图之外延伸成山体。
  `MapSystem.heightAt` / `riverFactor` / `plateauHeightAt` / `terrainField()` 已接到它上面。河道改成贯穿全图的连续浅河，龙坑是河心石台。
- 新世界模块 `src/presentation/world/`：`World.js`（编排）、`WorldTerrain.js`（分块网格 + 五层混合材质）、
  `WorldRocks.js`（崖线巨石）、`WorldFoliage.js`（树）、`WorldWater.js`（河面）、`worldTextures.js`（程序化贴图）、`worldShading.js`（共享 uniform / 局部光 / 天气补丁）。
- `ThreeRenderer` 已不再创建旧地形层（见下面"待删文件"），32 盏点光源的灯池已删。

**风格基准**：用户认可的是 `docs/refs/lookdev/01-variant-a-dota.jpg`、`02-variant-b-lol.jpg` 那种——
明亮黄绿草地、暖棕土路、圆润巨石崖壁、阔叶树、青绿河水。用户原话：「按照这种风格弄！别跑偏了」。

**当前测试状态：红的。18 套失败**，全部是钉着"已删掉的旧表现层 / 旧后处理 / 旧高度公式"的断言，不是玩法回归：
`sim_visual sim_lightring sim_maps sim_deadcode sim_v44 sim_v46 sim_v51 sim_postfx sim_daynight sim_mapskirt
sim_frostbridge sim_navoutline sim_boundarydecor sim_dominionprops sim_desertfloor sim_landmarks sim_unit_models sim_weather_ground`

## 二、Opus 接手的部分（非可视化，约 60 分钟）

硬规矩：**不要改 `src/presentation/world/*` 里的着色器 / 配色 / 几何，不要改 `DayNight.js` 的关键帧、`CONFIG.terrain.themes` 的配色、任何模型代码。**
遇到"要让测试过就得做一个画面上的决定"的情况，不做，记到本文件末尾的"留给 Fable 的问题"里。
其余照 `CLAUDE.md` 四条硬约束办（提交信息中文、逐项报告期望常量、新行为配测试）。

1. **把测试修绿（最优先）。** 逐条看 18 套里的失败断言：
   - 钉的是已删的东西（描边、`NormalDepthPrepass`、FXAA、塔灯 / 火炬点光源池、`setTexturesEnabled`、旧 `heightAt` 的"河床 -10 / 龙坑 -26 / 森林分级 0/3/6/10"、"河被兵线切成两段"）→ 改成钉新行为的**形状**，或删掉并在提交信息里写明原因。
   - 钉的是旧层文件源码的正则 → 随文件一起删（见第 2 条）。
   - 不要为了让断言过去改画面代码。
2. **删死代码。** 确认无人 import 后删除：`TerrainLayer.js TerrainMaterial.js WallLayer.js VegetationLayer.js VegetationShaderPatch.js
   BoundaryDecorLayer.js DominionPropsLayer.js LandmarkLayer.js BaseWallLayer.js MapSkirtLayer.js TerrainEdgeLayer.js WaterLayer.js
   HowlingAbyssDecor.js torchPlacement.js`，以及只测它们的测试套（从 `tests/run_all.mjs` 的 `suites` 里摘掉）、只有它们读的 `CONFIG` 项和对应的编辑器入口。
   `sim_deadcode` 同步。`GroundTraceLayer.js`、`weatherGround.js`、`rainRipple.js`、`WeatherLayer.js` **先留着**（天气阶段 Fable 要改）。
3. **去掉"下雪时树和塔变白"的逻辑。** 用户原话：「删除我之前说的下雪的时候，树和塔就变白，这个太丑了并且不符合实际」。
   删 `InstancedBodyLayer` 的 `updateSnow` 及其调用、`applySnowTint` / `updateSnowInstances` 相关代码与配置、对应测试。新的积雪表现由 Fable 做（只落在地面）。
4. **给新模块补测试并注册进 `run_all.mjs`：**
   - `tests/sim_terrain_field.mjs`：可走区高度落在一个小范围内；rise 图的墙体高于相邻可走区、drop 图的墙体低于；河在三条兵线处不断流且水面高于渡口河床不超过"没过脚踝"的量；
     龙坑台面高于水面；地图外越远越高（没有边缘）；同一坐标两次查询结果一致；`heightAt` 与高度场双线性取值一致；七张图都能建场且耗时有上限。
   - `sim_postfx.mjs` 补 `ScenePass`（MSAA 采样数随像素比、`setAA` 开关、`_sizeComposer` 同步像素比）。
5. **编辑器入口。** `CONFIG.terrain.*`（field / ground / river / pit / cliff / drop / outer / paving / shading）、`CONFIG.postfx.aa`、`CONFIG.ui.camera`、`CONFIG.ui.sky`
   照现有页面的写法加可改入口（数值项即可；主题配色那一大块先不做界面）。
6. **性能基线工具。** 加 `tools/perf_probe.mjs`（无头 Chromium，跑到指定游戏时间，输出每段 CPU 耗时、绘制调用数、三角形数、纹理数），
   把现在的数字记进 `docs/VISUAL-REWORK-REPORT.md`。只量不改。已知线索：中期约 150 个血条各占一次绘制调用；`gl.info.memory.textures` 有 1500+，查清来源写进报告。
7. **文档。** `docs/DEVELOPMENT.md` 的架构 / 渲染层 / 地图章节按新结构更新；本文件第一节随进度更新。

## 三、Fable 回来做的部分（全部可视化）

1. 召唤师峡谷地表打磨：土路贴图（现在的石子太像圆点）、河滩、基地台地边缘与石墙、塔座铺石、野区草丛 / 灌木 / 花、巨石密度与大小。
2. 水：岸边泡沫、流向、瀑布、水雾；河流出地图后的峡谷。
3. 光：兵线两侧墙上的火炬 + 光照图、水晶常亮（塔本身不带光源）、夜晚整体观感、昼夜过渡。
4. 其余地图的主题落地：扭曲丛林、嚎哭深渊（冰桥 + 深渊）、统治战场（沙漠台地 + 据点归属旗）、蜿蜒版、汇流战场、演示图。
5. 塔 / 召唤水晶 / 水晶枢纽新模型（每方一套）+ 水晶着色器与粒子；损毁动画：同一批模块 掉块 → 爆炸 → 落地成废墟，不再从地下冒出废墟。
6. 小兵 / 巨龙写实模型。
7. 天气上画面：雨（地湿、水洼、河面涟漪）、雪（只积在地面）、雾、风、沙暴；环境生物（萤火、飞鸟、落叶）。
8. 性能收尾（血条合批、远景简化、画质档位）、各图昼夜截图验收、最终报告。

## 四、留给 Fable 的问题

（Opus 遇到需要画面决定的地方记在这里）
