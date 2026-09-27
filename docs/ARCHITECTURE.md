# 架构地图

> 一页纸的"哪个文件管什么"。规则、坑位、测试与提交规范在 `docs/DEVELOPMENT.md`，
> 那份是权威；这里只放地图，二者冲突时以 DEVELOPMENT.md 为准。
> v60 重写：旧版描述的是 2D CanvasRenderer 与沙盒模式时代，已经不成立。

## 依赖方向

```
data  ←  core  ←  systems  ←  simulation.js  ←  main.js
                         ↖  presentation / ui（只读实体）
```

- `src/systems`、`src/core`、`src/data`、`src/simulation.js` **不许 import `presentation/` 或 `ui/`**
  （`tests/sim_layering.mjs` 守着）。
- 系统之间不互相 import，耦合走 EventBus、WorldState，或在 `simulation.js` 里接线。
- 逻辑层随机数一律走 `core/rng.js` 的 `random()`（可播种），不许直接 `Math.random()`
  （`tests/sim_determinism.mjs` 守着）；渲染层的纯装饰随机不受限。

## 两个入口

| 文件 | 职责 |
|---|---|
| `src/simulation.js` | **仿真唯一装配点**：`createSimulation({log})` 构造全部系统、工厂接线、换图时的仿真状态重置，并提供唯一的 `step(dt)`。游戏、三个平衡工具、全栈测试都从这里拿。 |
| `src/main.js` | 浏览器入口：界面、渲染器、计分板、按钮、游戏循环（每个固定步调 `sim.step(SIM_DT)`）。不再自己构造系统。 |

## 模块地图

| 层 | 模块 | 职责 |
|---|---|---|
| data | `Config.js` | 全部可调数值、调色板 `stylizedPalettes`、界面/渲染开关 `ui.*` |
| data | `maps/` | 地图注册表。`mapComposition.js` 把地形（TERRAIN_FIELDS）与玩法（CONFIG_FIELDS）拼成地图，未登记字段直接报错 |
| data | `schema/` | 字段注册表：编辑器与运行时的唯一取值口径 |
| data | `templateIO.js` | 存档导出/导入（导入时防原型链污染、去尖括号） |
| data | `landmarks.js` | 地标规划（坑、基地广场），纯数据 |
| data | `mapValidate.js` / `navOutline.js` / `navgrid.js` | 路/野区分级、navgrid 编解码与平滑轮廓 |
| core | `EntityContainer` | 实体仓库 + 空间网格 |
| core | `AttributeCalculator` | 属性合成（每步 tick 失效缓存） |
| core | `EffectRegistry` | 全部增益/减益/状态的唯一通道 |
| core | `SkillLibrary` / `skills/` / `skillParams.js` / `behaviorVM.js` | 技能定义、参数三层解析、自制技能解释器 |
| core | `factories.js` | 实体工厂（塔/建筑/小兵/巨龙），由 simulation.js 注入依赖 |
| core | `healing.js` | 唯一的回血入口（`_noHeal` 在这里拦） |
| core | `reviveState.js` | 塔损毁档的记录（仿真每步）与复活时的唯一清单 |
| core | `dayCycle.js` / `towerFacing.js` / `rng.js` | 昼夜相位、塔的静态朝向、可播种随机数 |
| systems | `CombatSystem` / `ProjectileSystem` / `BuffSystem` / `ManaSystem` | 战斗结算、弹道、增益、法力与主动技能 |
| systems | `LaneWaveSystem` / `LaneMovementSystem` / `CollisionSystem` / `FacingSystem` | 出兵、兵线移动、碰撞分离、朝向 |
| systems | `MapSystem` | 地图装载、可走判定（navgrid）、河道/高度场、建筑重生 |
| systems | `DragonSystem` / `NeutralCampSystem` | 巨龙与中立营地 |
| systems | `WeatherSystem` / `WorldState` / `EntropySystem` / `GroundTraceSystem` | 天气、昼夜/世界耦合、熵、地面痕迹 |
| systems | `DominionSystem` | 统治战场（水晶之痕）据点与水晶枢纽 |
| presentation | `ThreeRenderer` | Three.js r169 渲染器，管理下面各层的 build/update |
| presentation | `TerrainLayer` / `smoothLabels.js` | 地面底图烘焙（navgrid 图按原生网格平滑放大；挖空图按矢量轮廓） |
| presentation | `TerrainEdgeLayer` / `MapSkirtLayer` / `WaterLayer` | 崖壁与低一层地面、地图裙边、河道水面 |
| presentation | `VegetationLayer` / `BoundaryDecorLayer` / `LandmarkLayer` / `HowlingAbyssDecor` / `DominionPropsLayer` | 植被、边界装饰、地标、各图专属装饰 |
| presentation | `UnitLayer` / `UnitMeshFactory` / `EffectsLayer` / `PostFX` | 单位模型、特效、后处理（描边/SSAO/FXAA） |
| ui | `UIManager` / `WorldHud` / `SettingsDialog` / `ModeDialog` | HUD、设置、选图 |
| ui | `AttributeEditor` + `editor/` | 模板/属性编辑器 |
| ui | `MapEditorDialog` / `mapEditorSession.js` | 地图编辑器 |

## 工具

| 工具 | 用途 |
|---|---|
| `tools/balance_matrix.mjs` | 批量对局（兵线图）；`--sweep soul/power` 龙魂/巨龙之力扫描 |
| `tools/balance_dominion.mjs` | 统治战场专用；`--verbose` 单局全局实况 |
| `tools/balance_tower.mjs` | 防御塔武器强度对照 |
| `tools/run_balance_soul.mjs` | 本地多进程跑龙魂扫描 |

前三个都走 `createSimulation()`，与游戏同一套系统与步进顺序（`run_balance_soul` 调的是 `balance_matrix`）。结果落盘到 `.balance/`，
环境变量 `BALANCE_OUT_DIR` 可改目录（测试用它隔离）。

## 定标

一切几何 = 真实 LoL 坐标 × 0.24（塔射程 180 : LoL 750）。坐标系：canvas 标准（y 向下）；
渲染里世界 (x, y) 对应 Three.js 的 (x, 高度, y)。

## 技能文案规范（用户定稿 · Q3）

### 统一格式

所有技能的 `description` 与 `descTemplate` **一律**写成：

```
唯一被动——<技能名称>：<描述>
```

前缀在 `SkillLibrary.js` 的注册期统一补齐（已带前缀的原样不动），
所以新增技能不必手写前缀也不会写歪。**不要**在各技能文件里各自拼前缀。

### 文案不许手抄，必须从数据现拼

这一条是硬约束，来自一次真实事故：枢纽塔生命恢复从 5 调成 3 后，
`passive_hq_fortify` 的文案跟着变了，而身份技能 `core_tier_hq` 里那份
**手抄副本**还写着 5 —— 玩家看到"技能里写 5、状态里是 3"。
水晶塔 2→1 有同样的残留。

因此：

| 场景 | 做法 |
| --- | --- |
| 身份技能（`core_tier_*`）合并展示子技能 | `get description() { return mergedDescription(this.mergedSkills, false); }` |
| 光环被动（`makeAuraPassive`） | 文案由 `auraDescription()` 从 `effectsFn` 实际返回的 blueprint 描述拼出 |
| 普通被动 | 文案里的数值必须与 `onEquip/onFrame` 里 apply 的 `flatValue/percentValue` 同源（同一常量或同一生成器参数） |

结论：**改数值只改一处，文案自动跟随**。任何"在两个地方各写一遍同一个数字"的写法都视为 bug。

### 回归防线

`tests/sim_skilldesc.mjs` 对全部技能逐条检查：

1. 文案格式是否为「唯一被动——名称：描述」；
2. `onEquip` + 60 秒 `onFrame` 实际施加的效果数值，是否都能被文案里的数字解释
   （允许差值/乘积/百分比折算等派生形式）；
3. 效果 blueprint 自带的**状态描述**里的数值，同样要能被文案解释。

这条测试同时是"技能能不能跑"的冒烟测试——它抓出过 `weapon_corrosion`
引用未定义变量 `p4` 的真实 bug：`onFrame` 一遇到射程内的敌人就抛异常，
被 CombatSystem 的兜底 try-catch 静默吞掉，导致腐蚀武器的中毒/减速/减攻速
**全部长期失效**且无人察觉。
