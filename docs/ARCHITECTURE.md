# 架构地图与工程纪律

> 本文件是项目的"账本"。上下文/会话丢失后，先读这里再动代码。

## 模块地图（依赖方向：data ← core ← systems ← presentation/ui，无循环）

| 层 | 模块 | 职责 |
|---|---|---|
| data | `Config.js` | 模板、阵营覆写层 `factionOverrides`、建筑体积、**对战调参表 `tuning`**（调平衡改这里，别翻系统源码） |
| data | `maps/` | 地图注册表（`index.js`）。地图自带：`world` 尺寸、`lanes` 路点、`buildings`、可选 `tierStats` 覆写、可选 `skills`（建筑默认技能覆写）、可选 `minionNoRend` |
| core | `EntityContainer` | 实体仓库 + 空间网格（GRID_CELL=100）。`findInRadius` 是全部索敌/光环/碰撞的地基。`purgeDead` 豁免 `_respawnAt` 尸体 |
| core | `AttributeCalculator` | 属性合成（基础+效果）。**每模拟步 tick 一次使缓存失效**；渲染复用最后一步的缓存（不许在渲染帧 tick，见 main.js 注释） |
| core | `EffectRegistry` | 全部增益/减益/成长/状态的唯一通道。UI 的进度环 = remaining/duration；`alwaysShowStacks` 让层数徽标从第 1 层显示 |
| core | `skills/` | 技能库（45+）。onFrame 有 try-catch 兜底（单技能抛错只跳过不冻结）。塔成长为阶梯制（层变化才 apply，层间直写 remainingTime，防闪烁） |
| systems | `LaneMovementSystem` | 对战小兵 AI。核心规则（血泪换来，别乱动）：射程内必停下打；追击目标每步重估为最近敌（等速追击不朝你走的目标**永远追不上**，粘性远追会形成永不相遇的轨道）；脱战回归按最近线段投影重定位 |
| systems | `CollisionSystem` | 锚定阻尼分离（攻击中单位近似不可推动），治"围攻血球膨胀" |
| systems | `MapSystem` | 地图装载/水晶重生（尸体原地复活）/守家圈。TIER_STATS 为峡谷默认，地图可覆写 |
| systems | `CombatSystem` | 攻击结算、技能 onFrame 驱动、伤害管线（damageReduction/穿透/护盾次序在此） |
| presentation | `CanvasRenderer` | 固定步长下的 60fps 渲染：精灵缓存、两档 LOD（<0.5 藏小兵血条，<0.35 圆点）、闪电光束用渲染墙钟（不用 30Hz gameTime，否则流动卡顿） |
| data | `Weather.js` | 天气定义（5 基础 + 12 极端），完全数据驱动：加天气 = 加配置对象 |
| systems | `WeatherSystem` | OU 过程 + Softmax 的连续权重场。极端天气按阈值涌现，强度 = (占比−阈值)/(1−阈值)。天气 buff 走 AttributeCalculator 修正层（O(1)），**不进 EffectRegistry**（每帧给上千单位 apply 会闪且慢） |
| ui | `WeatherPanel` | 滚动预报条（堆叠面积图，左=现在右=未来）+ 配置面板（总开关 + 每种天气独立开关） |
| ui | `UIManager` | 点选面板（O(1)/帧）+ 顶栏脏检查。`AttributeEditor`（1335 行，**挂账待拆**） |

## 定标法
一切几何 = 真实 LoL 坐标 × 0.24（塔射程 180 : LoL 750）。地图坐标系：canvas 标准（y 向下），蓝方左下、红方右上，红方 = 蓝方绕中心 180° 旋转。

## 工程纪律（违者返工）
0. **`tests/sim_runtime.mjs` 是最重要的一道关**：用 DOM 桩把【真实的游戏循环】跑起来
   （沙盒 200 帧 + 对战 200 帧 + 天气开启 + 按阵营开关 + 深渊图）。
   v25 事故：CombatSystem 里把循环变量 `tower` 误写成 `entity`，每帧 ReferenceError、
   游戏完全卡死——而当时 12 套仿真【全绿】，因为它们都只 import 子系统做单元测试，
   **从没有任何测试真正跑过游戏循环本体**。单元测试再多也挡不住这个。
   （静态作用域分析试过：手写正则误报率太高，误报比漏报更有害。放弃。）
0b. **`tests/sim_boot.mjs`**：全部源文件语法检查 + main.js 作用域引用体检。
   v10 事故教训：基地光环补丁被贴进了 `createTower`（该函数没有 `tier`），开机 ReferenceError、
   界面全黑，而当时 6 套仿真全绿——因为它们都直接 import 各系统，**从不加载 main.js**，
   组合根整个漏在测试之外。任何跨函数的补丁，务必确认贴对了函数。
1. **任何改动交付前 `npm test` 全绿**（7 套、120+ 断言，含能失败的冒烟与启动体检）。新机制必须带新断言。
2. **补丁必须带断言**（Python replace 必须 assert 命中）——v5 曾因带 `\r` 的模式静默失败导致整批修复没落盘。全仓已统一 LF，保持。
3. 数值平衡改动走仿真校准（参照 tests/ 里的校准脚本模式），不拍脑袋。
4. 用户工作流：动手前确认到零疑问；数值委托 Claude、架构用户有否决权。

## 挂账债务（按批清偿，勿混入功能批）
- AttributeEditor 按 tab 拆分（需用户过拆法 + 实机测试窗口）
- EntityFactory 从 main.js 抽离（main 回归纯组合根）
- window.* 全局收编 GameState（gameTime/waveNumber/_uid；影响全部测试脚手架）
- 选中卡技能槽每帧 innerHTML 重建（若实测 tooltip 闪烁，凶手是它）
- getEffects 每调用分配新数组（实测 1043 单位 5.35ms 不疼，账记着）
- PixiJS：仅当渲染项在目标规模逼近 8ms 才考虑（现渲染 2.73ms，远未到）


---

## Changelog [DeepSeek]









### 2026-07-19 #8 ? Quick Mode map (Summoner's Rift 15-min) [DeepSeek]
### 2026-07-19 #8 ? Quick Mode map (Summoner's Rift, 15-min) [DeepSeek]
- Added: src/data/maps/summoners_rift_quick.js ? inherits classic layout, adds quickModeSettings { waveInterval:15, hpMult:0.7, adMult:1.4, growthMult:1.5, spawnGap:0.3, nexusRespawnTime:150 }
- Modified: src/data/maps/index.js ? registered summoners_rift_quick
- Modified: src/systems/LaneWaveSystem.js ? reads quickModeSettings on first update to accelerate waves
- Modified: src/main.js ? LaneWaveSystem createMinion wrapper applies HP/AD multipliers for quick mode
### 2026-07-19 #7 ? AttributeEditor section dividers [DeepSeek]
- Modified: src/ui/AttributeEditor.js ? added 4 SECTION comment dividers for navigability
- Status: All P0-P3 tasks complete. TODO list cleared.
### 2026-07-19 #6 ? AI system separation [DeepSeek]
- Added: src/systems/AISystem.js ? stateless target acquisition + line-of-sight (extracted from LaneMovementSystem)
- Modified: src/systems/LaneMovementSystem.js ? delegates scanEnemies/hasLineOfSight to AISystem
- Modified: src/main.js ? removed AISystem.setRefs (stateless, no init needed)
### 2026-07-19 #5 ? Complete JSON template migration [DeepSeek]
- Added: src/data/templates/ ? all 9 unit types as JSON (tower, melee, ranged, siege, super, totem, warlock, corrupt, ram)
- Added: src/data/templates/index.js ? async loader with loadTemplates()
### 2026-07-19 #4 ? Event System + Dev Guide + JSON Templates
- Added: src/core/GameEvents.js ? 14 canonical event type constants
- Added: src/data/templates/ ? tower.json / melee.json / ranged.json
- Modified: Role comments on 6 core files (EntityContainer, EffectRegistry, AttributeCalculator, CombatSystem, LaneMovementSystem, CollisionSystem)

### 2026-07-19 #3 ? Entity JSDoc typedef
- Modified: src/core/EntityFactory.js ? full @typedef {object} Entity (20+ _-prefixed properties)

### 2026-07-19 #2 ? GameContext + SkillLibrary plugin
- Added: src/core/GameContext.js ? centralized state, CTX.* <-> window.* sync
- Modified: src/core/SkillLibrary.js ? register()/get()/has()/ids()
- Modified: src/main.js ? window.* init -> CTX.*
- Modified: src/systems/LaneMovementSystem.js ? removed _findAnchorSlot teleport
- Modified: src/systems/CollisionSystem.js ? OVERLAP_ALLOW 0.85 -> 1.0

### 2026-07-19 #1 ? Ram unit + spawn optimization
- Modified: src/data/Config.js ? waveRamInterval/ramMinWave; spawnGap 0.35 -> 0.55
- Modified: src/systems/LaneWaveSystem.js ? ram from hardcoded to CONFIG
- Modified: src/ui/UnitAddDialog.js ? MINION_TYPES includes ram
- Modified: src/ui/AttributeEditor.js ? all _TPL_* include ram
- Modified: src/data/UnitTemplates.js ? added warlock/corrupt/ram

---

## New Architecture Rules [DeepSeek]

- Always full backup before changes (.backups/ dir, timestamped)
- Update this file after every change session
- All new events MUST use GameEvents.js constants (no bare strings)
- All runtime _-prefixed entity props documented in EntityFactory.js @typedef
- New skills use SkillLibrary.register() ? never mutate SkillLibrary directly

---

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
