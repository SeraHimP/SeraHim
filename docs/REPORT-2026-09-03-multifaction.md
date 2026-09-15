# 多阵营架构 + 中立营地泛化 —— 设计报告

> 交付形式说明：本文档**只是设计，不是实现**。用户原话（讨论第六节时）："不直接改代码——
> 先写一份设计报告"。里面没有一行改动过 `src/`。所有"现状"描述都标了具体文件/行号，
> 可以直接去核对；"新做"部分给候选方案和取舍理由，不直接替用户拍板。
>
> 背景：`docs/REQUIREMENTS-2026-09-03.md` 第六节。用户原话："我要求还可以加/减阵营。
> 然后某一方出兵的前提是水晶枢纽存活，如果某一方水晶枢纽被摧毁，那么该方以及攻击该方
> 的路径就不再生成小兵了……可能存在多阵营线路汇聚等复杂情况……可能以后还会添加像巨龙
> 一类的中立野怪（出生地/路径/出生条件都可编辑）"。三个已拍板的设计决定（见需求文档）：
> 淘汰后塔保留仍可被攻击、阵营增减是地图作者时间的事不支持对局中动态加入、汇合处自然
> 交战不需要额外规则。

## 0. 结论先行

**"27 个文件写死两阵营"这个数字吓人，但真正需要"重新设计"的只有 5 处。** 逐个读过
之后可以分三档：

- **本来就通用，不用动**（§1.1）：阵营关系表、索敌/可打判定、`baseCircleCenter` 的
  声明覆写路径——这几处底层机制早就是"读 faction 参数"而不是"读 blue/red 字面量"，
  之前几次改动顺手做对了。
- **写死但是"浅层"**（§1.2）：`for (const f of ['blue','red'])` 这种循环、
  `faction==='blue'?'red':'blue'` 这种"另一个"三元——把这些改成"遍历
  `map.factions`"或者"查 `lane.targetFactions`"，是机械替换，不涉及设计决策。
  这类占了 27 个文件里的大多数。
- **写死且需要专门设计**（§1.3）：巨龙/龙魂结算（`DragonSystem.js`）、死亡计分板
  （`main.js`）、秩序-混乱系统（`EntropySystem.js`/`WorldState.js`）、塔朝向
  （`towerFacing.js`）——这几处不是"多循环一次"就能扩展，因为它们的**玩法概念本身
  是二元对抗**（"谁杀的算谁的魂"、"红=混乱其余=秩序"），N 阵营下这些机制该长什么样
  需要用户先拍板，不是我能替着改的技术问题。

真正的地基缺口只有一个：**`lane.waypoints` 现在只是一串坐标，不知道"这条路是谁的、
打谁的"**（`src/data/maps/summoners_rift.js:154` 起的 `lanes` 数组只有
`{id, waypoints}`）。`_enqueueForFaction`（`LaneWaveSystem.js:109`）靠"现算另一个
阵营"顶着这个缺口，这行为在只有两个阵营时刚好蒙对，三阵营起就没有唯一解——"这条路
该打谁"必须是数据里存的，不能靠代码猜。**这是整个多阵营改造要先钉的一块地基**，
其余大部分文件的改法都要等它定下来才能跟着定。

优先级建议：**先做地基（§3 数据模型 + §4 出兵链路），再做校验放开（§5），UI 入口
和结算类专项（§6/§7）最后做**——理由见 §8 分阶段路线图。

---

## 1. 现状盘点

### 1.1 已经通用，不用动

- **`src/systems/FactionSystem.js`**（全文件）—— `ENEMY_PAIRS` 是任意 "a|b" 对
  的 `Set`，`declareEnemies(factionA, factionB)` 已导出但没人调用（专门留给"以后
  第三方阵营"的口子）；`isEnemyFaction`/`canTarget` 都是查表，不写死具体阵营值。
- **`src/systems/LaneMovementSystem.js:110`** 的 `canTarget(minion._mapFaction,
  target._mapFaction)`、`src/systems/MapSystem.js` 的 `isStructureProtected`——
  索敌/保护判定走的都是这套通用查表，不受阵营数量限制。
- **`src/data/baseCircle.js:18-24`**（`baseCircleCenter`）—— **这一处比想象中好**：
  已经支持 `map.baseCenters[faction]` 声明覆写（任意 key，不限 blue/red），**只有
  "地图没声明该阵营基地圈"这一种情况才会落进 `faction==='blue'?左下:右上` 的兜底**。
  也就是说：只要新地图给每个阵营都显式填 `baseCenters`，这个函数本身**不用改一行**。
  下面 §1.2 里但凡属于"有声明覆写、只有兜底二元"这种模式的文件，都归进"浅层"档——
  真正要做的是"新地图必须显式声明，不能依赖兜底"，不是重写算法。

### 1.2 写死但浅层——机械替换，不涉及设计决策

**出兵链路（真正的地基缺口，最优先）**
- `src/systems/LaneWaveSystem.js:104-105`（`spawnWave`）——
  `this._enqueueForFaction(FACTIONS.BLUE, lane, 'forward'); ...RED, lane,
  'reverse')`：对每条路假设恰好蓝红两条方向相反的出兵流。需要改成遍历
  `lane`自己声明的"归属阵营+方向"列表。
- `src/systems/LaneWaveSystem.js:112`（`_enqueueForFaction`）—— `const enemy =
  faction === FACTIONS.BLUE ? FACTIONS.RED : FACTIONS.BLUE;`：需要改成读
  `lane.targetFactions`（见 §3.2），逐个查 `isNexusDestroyed`，不再"现算另一个"。
- `src/data/waveComposition.js`（`buildWaveOrder` 的规则求值里，`enemy:` 字段计算处）
  —— 同样的 `faction==='blue'?'red':(faction==='red'?'blue':null)` 模式，供"敌方
  内塔全灭"这类出兵条件判定用，要跟 `LaneWaveSystem.js` 同步改。

**地图数据**
- `src/data/maps/summoners_rift.js`（及 `twisted_treeline.js`/`howling_abyss.js`）
  的 `lanes: [{id, waypoints}]`——**当前完全没有 faction/target 字段**，这是 §3
  要新增的地方。`buildings` 数组本身已经按 `faction:` 字段声明归属，不用改，只是
  三张地图目前都只填了 `blue`/`red` 两份对称建筑。

**编辑器校验（不放开这几处，编辑器永远存不出合法的 N 阵营地图）**
- `src/data/mapValidate.js:146`（`buildingCountsSymmetric`）、`:168`
  （`isMirroredAcrossAxis`）—— 校验"蓝红建筑数量对称/镜像对称"，`mapEditorCore.js`
  把 `symmetric` 结果直接接进编辑器的 `ok` 总闸，非对称的三阵营地图会被判"不合规"。
  N 阵营下"对称"这个概念本身就该失效或改成可选项，不是修复 bug，是改校验规则的
  适用范围。
- `src/data/mapValidate.js:231`（`attackTowerSpacingOk` 里 `for (const f of
  ['blue','red'])`）、`:255-259`（`crossFactionTowerSpacingOk`，只算 blue↔red
  两组塔的最短间距）—— 第三阵营的塔目前完全不参与间距校验，需要改成遍历
  `map.factions`（前者）、遍历所有阵营两两配对（后者）。

**编辑器 UI（没有阵营增删入口，是 UI 层的字面缺失，不是逻辑 bug）**
- `src/ui/MapEditorBoardTool.js:59`（`_faction:'blue'` 默认值）、`:293-294`/
  `:307-308`（写死的 🔵/🔴 两个按钮）—— 确认没有任何"新增/选择第三阵营"入口。
- `src/ui/MapEditorDialog.js:63`（`FAC_COLOR={blue,red}`）、`:186`/`:378`
  （`for (const fac of ['blue','red'])`、阵营标签三元）—— 同样没有阵营增删 UI。
  **这块跟第二节"两入口合并"直接相关**，见 §8 的排期理由。
- `src/ui/editor/pagesEntity.js:272-273`/`:374`/`:378`（实体阵营 tab 只有蓝/红/
  中立三个按钮，非法值直接 `return`）——添加/编辑单位面板同样锁死三个固定阵营值。

**面板/规则覆写（同一种模式：固定两个 chip/tab，改成按 `map.factions` 生成）**
- `src/data/schema/index.js:176,192`（`scopes: ['shared','blue','red']` 写死三值）
  —— 是 `src/ui/editor/shell.js`/`events.js` 里"仅蓝/仅红"模板覆写 tab 的数据根。
- `src/ui/editor/shell.js:38-39,72-76`（`_factionLabel`/`_renderFactionScopeBar`）、
  `src/ui/editor/pagesGameplayWorld.js:134`（`_DG_FACTIONS:['blue','red']`，
  注释里已经自己写了"以后加阵营"）。
- `src/ui/UnitAddDialog.js:198,217`（添加单位对话框阵营 tab 固定蓝/红，部分含中立）。
- `src/ui/SettingsDialog.js:28-29,429`（塔无敌/停火/兵线开关面板只有两个 chip）——
  这是 `CTX.__towerRules` 的 UI 层，下面单独说。
- **`src/main.js:122-131`（`CTX.__towerRules`）**——
  `{invincible:{blue,red}, attackOff:{blue,red}, waveOn:{blue:true,red:true}}`，
  `__towerRuleFor` 用 `!!r[faction]` 读取。**这一处要特别小心**：未声明的第三阵营
  key **不存在**，读回来一律 `false`——包括 `waveOn`，也就是说新阵营如果不显式初始化
  这几张表，会**默认不生成任何兵**（"关掉"而不是"忘了开"，容易被误判成 bug）。
  改法：初始化时按 `map.factions` 动态生成这几张表，而不是硬编码两个 key。

**表现层（视觉，量最大，但都是同一种"三元判色"模式，可以批量处理）**
- `src/presentation/UnitMeshFactory.js:207-208`（`FACTION_STYLE={blue,red}`）+
  全文件约 30 处 `const red = faction==='red'` 决定塔建模分支——第三阵营的塔会落进
  `red===false` 分支，跟蓝方共用一套外观（不报错，纯视觉问题，容易漏掉）。
- `src/presentation/UnitLayer.js:168,224,527,728,780,839-840`、
  `src/presentation/SpriteFactory.js:104`、`src/presentation/ThreeRenderer.js:1114`、
  `src/core/skills/weapons.js:238`——血条/描边/光束颜色的三元判色；
  `UnitLayer.js:527` 的 `enemy = e._mapFaction==='red'?'blue':'red'` 还牵涉指示线，
  跟 `LaneWaveSystem` 那处是同一种"现算另一个"模式。
- `src/presentation/EffectsLayer.js:443-444`、`src/presentation/TerrainLayer.js:
  126,164-165`——基地光环特效/地形层只画 `baseCircleCenter(map,'blue')` 和
  `('red')` 两圈，第三阵营的基地没有对应特效（这处依赖 §1.1 提到的"必须显式声明
  baseCenters"前提）。

### 1.3 写死且需要专门设计——玩法概念本身是二元的

这几处**不建议在"多阵营支持"这一批里顺手改掉**，因为改法本身是一次独立的玩法设计
决策，不是把"blue/red"换成"遍历 map.factions"就完事：

- **`src/systems/DragonSystem.js`**：`factionKills`/`factionTotals`/`souls =
  {blue:{},red:{}}`（约 111-113/182-184/205 行）、`owner==='blue'||owner==='red'`
  （约 354 行）、`equipExistingSoul` 里非蓝红直接 `return false`（约 528 行）——
  **龙魂/巨龙之力结算整套都是按两方分别记账**。第三阵营击杀巨龙目前**不结算任何
  奖励**，其新出生单位也永远补不到已有的龙魂/巨龙之力。这是本节里最重的一处二元
  写死，改法需要先回答："三个阵营抢同一条龙，魂怎么分？是击杀方独享还是按参团贡献
  分摊？"——这是玩法问题，不是技术问题。
- **`src/main.js:350`**：`const scorer = e._mapFaction === 'blue' ? 'red' :
  'blue';`（死亡计分板归属）—— 第三阵营单位死亡会被错记到蓝或红头上。需要先确定
  计分板本身在 N 阵营下要不要还是"两栏比分"，还是要改成每阵营一栏。
- **`src/systems/CombatSystem.js:122`**：`if (fac === 'blue' || fac === 'red')
  target._lastHitFaction = fac;`——第三阵营的最后一击不会被记录，直接影响上面
  龙魂结算能不能拿到"是谁打死的"这个前提数据，两处要一起改。
- **`src/systems/EntropySystem.js:108-109`、`src/systems/WorldState.js:169,214`**：
  `sign = fac==='red'?k:-k`——秩序-混乱系统把"红=混乱侧、其余一律=秩序侧"直接写死。
  **这套机制概念上就是一根二元对抗轴**（一端加成红方另一端加成蓝方），N 阵营下
  "秩序-混乱"这个隐喻还成不成立，需要用户先决定——继续只对固定两大阵营生效？
  改成每阵营独立的熵值？还是干脆在有 3+ 阵营的地图上禁用这套机制？三条路线技术上
  都能做，但选哪条是设计问题。
- **`src/presentation/towerFacing.js:76`**：`if (fac!=='blue'&&fac!=='red')
  return null;`——塔朝向计算完全绑死两阵营，第三阵营塔的朝向直接返回 null（退化成
  默认朝向，不报错但看着呆板）。相对上面几条，这条**其实偏"浅层"**（逻辑是"面朝
  敌方水晶枢纽的方向"，只要能确定"该塔面朝哪个阵营的枢纽"就能泛化），单独列在这里
  是因为"多阵营汇合时塔该朝哪"本身需要一个规则（朝最近的敌方枢纽？朝声明的主要
  防守方向？），也算半个设计问题。
- **`src/systems/LaneAvengerSystem.js:68`**：`for (const faction of
  ['blue','red'])` 收集哀兵层数——第三阵营的哀兵状态不会被计算，静默降级（不报错，
  只是少一层机制），改法本身简单（遍历 `map.factions`），归在这里只是提醒"哀兵"
  这个机制本来的叙事是"落后方绝地反击"，三方混战里"谁落后"怎么定义要想一下。

### 1.4 中立营地现状

`DragonSystem.js` 是当前**唯一**的中立单位实例，从上到下都是巨龙专用硬编码：
- 出生点：`getPit(pitSide==='top'?'baron':'dragon')`（`factories.js:531` 一带）——
  固定读名字叫 `'dragon'`/`'baron'` 的两个坑位，不是"某个中立营地的出生点"这种
  通用字段。
- 路径：固定绑定 `top`/`bot` 两条 lane、方向 `forward`/`reverse`，跟蓝红推线方向
  耦合在一起（`DragonSystem.js:312-317` 一带的 `pitSide`/`_nextPitSide` 逻辑）。
- 生成条件：元素轮换、成魂门槛全部写死在 `DragonSystem` 内部逻辑里，不经过任何
  数据表——地图编辑器现在也没有"巨龙生成规则"这一层可编辑的东西（有的是巨龙的
  强度/元素池数值，见 `docs/DEVELOPMENT.md`，跟"出生地/路径/条件"不是一回事）。

**不存在通用的"中立营地"抽象**。用户设想的"巨龙只是中立营地系统的一个实例，
出生点/路径/条件都可编辑"目前完全没有骨架，需要单独立项（见 §7）。

---

## 2. 好消息：管道已经搭了一半

- `MapSystem.js`（约 369 行）在 `nexus_main` 档位建筑被摧毁时已经发
  `map:mainNexusDestroyed` 事件，代码注释写得很清楚是"理论上是游戏结束的触发点，
  按之前确认暂不做终局判定，这里只发一个独立事件供以后接入"——**现在没有任何监听者**，
  这正是"某阵营淘汰后停止出兵"要挂的地方。
- `CTX.__towerRules.waveOn` 已经是按阵营独立的开关（见 §1.2），`LaneWaveSystem._spawn`
  已经在读它（`window.__towerRuleFor('waveOn', faction)`）——"某阵营停止出兵"这半件事
  的**管道**是现成的，缺的是"谁在什么时候把它设成 false"，也就是 §4 要接的监听器。

---

## 3. 数据模型设计

### 3.1 阵营声明：`map.factions`

新增地图顶层字段 `factions: string[]`（如 `['blue','red']`，三阵营地图写
`['blue','red','green']`）。**地图作者时间声明，对局中固定不变**（已拍板决定）。

- 未声明时（现有三张地图）默认 `['blue','red']`，逐位不变——这是"加开关不许改
  行为"的老规矩（`docs/DEVELOPMENT.md` §8.3），现有地图不用改一行就能继续跑。
- 所有"遍历所有阵营"的地方（`CTX.__towerRules` 初始化、`LaneWaveSystem.spawnWave`、
  `mapValidate.js` 的间距校验……）改成读 `map.factions ?? ['blue','red']`，
  不再硬编码两个值。
- `map.baseCenters[faction]`（已存在，见 §1.1）对新增阵营**必须显式声明**，不能
  依赖二元兜底——地图编辑器保存 N 阵营地图时应该校验"每个声明的阵营都有
  baseCenters"，缺了就是编辑器该拦的一条新校验规则，不是运行时兜底的事。

### 3.2 兵线归属：`lane.targetFactions`

这是本次改造真正的地基，有两个候选方案：

**方案 A（推荐）：单条 lane 声明"归属阵营列表"+"每个阵营打谁"**

```js
{
  id: 'mid',
  waypoints: [...],
  // 每个元素 = 这条路上有一股从某阵营出发、打向某些阵营的兵线
  spawns: [
    { faction: 'blue',  direction: 'forward', targetFactions: ['red'] },
    { faction: 'red',   direction: 'reverse', targetFactions: ['blue'] },
  ],
}
```

- 现有两阵营地图迁移：每条 lane 自动生成两条 `spawns`（跟现在 `_enqueueForFaction`
  对每条 lane 各调一次 BLUE/RED 完全对应），**行为逐位不变**。
- 三阵营汇合路径（比如一条路同时通向两个敌对基地）可以在同一条 lane 上声明多个
  `spawns` 项，`targetFactions` 是数组，天然支持"这一路打两个阵营"。
- `LaneWaveSystem._enqueueForFaction` 的改法：不再"现算 enemy"，改成遍历
  `spawns[i].targetFactions`，对每个目标阵营查 `isNexusDestroyed`，**全部**目标
  阵营都被淘汰时这条 spawn 才停止出兵（对应用户"该方及攻击该方的路径停止出兵"，
  不是"只要有一个目标被淘汰就整条路停"——多目标时其余目标还活着，这条路仍然
  该对活着的那个继续出兵，具体规则见 §4）。

**方案 B：把 lane 拆成单向 link（对称的两条路径变成两条记录）**

```js
{ id: 'mid_blue_to_red', waypoints: [...], faction: 'blue', targetFactions: ['red'] },
{ id: 'mid_red_to_blue', waypoints: [...reverse(...)], faction: 'red', targetFactions: ['blue'] },
```

- 更彻底地把"一条路"和"一股兵线"拆开，理论上更灵活（同一条物理路径可以有
  不对称的正反向属性），但**下游依赖 lane.id 的代码全部要改**——路径编辑器
  （阶段六刚做完的路点增删拖拽）、出兵编排 UI 里"选中某条路"的交互、
  `mapValidate.js` 里按 `lane.id` 分组的校验……改动面明显比方案 A 大，且现在
  三张地图的路径数据（`lane.waypoints` 数组）本身不需要拆分，只是"用途"要分裂成
  两份，方案 B 相当于把数据结构和实际需求错位了一层。

**建议**：方案 A。理由是它只在现有 `lane` 对象上加一个字段，不改变 `lane.id` 这个
被大量代码依赖的锚点，改动面最小；方案 B 的"路径本身可以不对称"这个额外灵活性
目前没有具体需求支撑（三阵营汇合的路径两端物理上仍然是同一条折线，只是"谁在这条
路上出兵、打谁"需要声明，不是折线本身要分裂）。

---

## 4. 淘汰 → 停止出兵 链路设计

1. **监听**：新增一个订阅者（挂在哪个系统合适待定，候选：`LaneWaveSystem` 自己在
   构造时订阅，或者 `MapSystem` 内部直接维护一份"已淘汰阵营"集合供其他系统查询——
   后者更符合"谁产生数据谁维护"，建议选后者）监听 `map:mainNexusDestroyed`，记录
   "哪个阵营的主水晶枢纽没了"。
2. **判定**：`LaneWaveSystem._enqueueForFaction` 改成——
   - 若**出兵方**自己的阵营已被淘汰 → 这条 spawn 直接不出兵（对应"该方停止出兵"）。
   - 否则遍历 `spawns[i].targetFactions`，若**全部**目标阵营都已被淘汰 → 这条
     spawn 也停止出兵（"攻击该方的路径不再生成小兵"，多目标时只有全灭才停，
     还有一个目标活着就继续按原规则出兵，只是不再针对已死的那个目标——目标阵营
     只影响"打谁"的语义，不影响"出不出"这个开关，`targetFactions` 里还有活的
     就还是要出兵）。
   - `waveOn` 开关（`CTX.__towerRules`）在这条链路上定位是**手动覆写**（编辑器/
     测试用的强制开关），跟"淘汰"是两套独立机制，不要合并——`waveOn=false` 是
     "我不管淘汰没淘汰，反正不让出兵"，淘汰判定是"游戏规则自动算出来的"，两者
     应该是 `AND` 关系（手动关掉 OR 被淘汰，任一条件命中就不出兵）。
3. **既有超级兵/水晶重生窗口逻辑不受影响**：现有 `remain <= cutoff` 那段"水晶
   重生前 45 秒停发超级兵"的逻辑，是"临时的、会恢复的"停兵；这次新增的是"永久
   淘汰、不会恢复"的停兵——两者判定顺序上，淘汰判定应该在超级兵窗口判定**之前**
   短路（已经淘汰的阵营不需要再费劲判断超级兵窗口）。

---

## 5. 编辑器校验放开

`mapValidate.js` 的对称性校验（`buildingCountsSymmetric`/`isMirroredAcrossAxis`）
在 N 阵营地图上语义本身就不成立（"跟谁对称"？三方地图没有唯一答案）。建议：

- 这两个函数改成**只在 `map.factions.length === 2` 时生效**，3+ 阵营的地图直接
  跳过对称性检查——不是删掉这条规则，是它的适用范围本来就只覆盖两阵营对称设计
  （这也是现有三张地图的设计初衷，不应该动）。
- `attackTowerSpacingOk`/`crossFactionTowerSpacingOk` 改成遍历 `map.factions`
  两两配对，对每一对都跑一次原来的间距逻辑——这条校验的意义（"敌对双方塔的射程圈
  不要重叠"）在 N 阵营下依然成立，只是要检查所有两两组合，不是只查 blue/red 这
  一对。

---

## 6. 编辑器 UI：阵营增删入口

**这一块建议放在第二节"两入口合并"（`docs/REQUIREMENTS-2026-09-03.md` 第二节
4/5）完成之后再做**，理由：现在 `MapEditorBoardTool.js`/`MapEditorDialog.js` 两处
都各自有一份"🔵/🔴 两个按钮"的阵营选择器，用户已经拍板"两入口不应该分开"，如果
现在先在两份各自独立的实现上分别加"新增阵营"入口，入口合并时这块 UI 大概率要
推倒重做一遍——先完成入口合并，阵营选择器只用做一份。

阵营增删 UI 需要覆盖：新增阵营（给个 id/显示名/配色）、删除阵营（要连带处理已经
用这个阵营的建筑/lane spawn——直接拒绝删除还是级联清理，需要用户在做这块时确认）、
每个阵营的 `baseCenters`/建筑列表编辑（复用现有"建筑摆放"模式，只是阵营列表从
写死两个变成读 `map.factions`）。

---

## 7. 中立营地泛化（独立后续项目，本次不做）

目标形态：一个通用 `NeutralCampSystem`，每个营地实例是一条数据记录——

```js
{
  id: 'dragon_pit',
  spawnPos: {x, y},           // 或复用现有 pits.dragon/pits.baron 坑位声明
  path: [...waypoints],        // 中立生物被拉出巢穴后走的路径（巨龙现在是走 top/bot lane）
  spawnCondition: {...},       // 元素轮换/成魂门槛/复活间隔——现在硬编码在 DragonSystem 里
  entityType: 'dragon',        // 未来可以是别的中立生物类型
}
```

`DragonSystem.js` 收编成这套系统的一份**配置**（`entityType:'dragon'` 的实例），
而不是继续保留一个专用系统。**工作量评估：不小于本次多阵营改造本身**——现在巨龙的
元素轮换/魂系统/成长曲线（`docs/DEVELOPMENT.md` 里龙魂平衡那几轮改动）全部跟
"巨龙"这个具体类型强绑定，泛化成"任意中立生物都能有类似的强度成长曲线"需要重新
设计一套通用的"营地强度模型"，不是简单加字段。

**建议**：不在这次多阵营改造里顺带做，等 §3~§6 的多阵营地基完成、有实际的
第三方地图需求验证过数据模型可用之后，再单独立项设计中立营地系统。

---

## 8. 分阶段实施顺序

1. **数据模型**（§3）：`map.factions` + `lane.spawns[].targetFactions`，含现有
   三张地图的自动迁移（不显式声明时按两阵营解读，逐位不变）。这是所有后续步骤的
   前提，先做。
2. **出兵链路**（§4）：`LaneWaveSystem`/`waveComposition.js` 改读新数据模型 + 接
   `map:mainNexusDestroyed` 监听，实现"淘汰阵营停止出兵"。这是用户需求里唯一明确
   要求"这次要做出来"的行为（不只是"支持编辑"），且是地基改完后改动量最小、验证
   最直接的一步（有现成的 `sim_*.mjs` 仿真测试套路可以照抄）。
3. **编辑器校验放开**（§5）：不放开这道闸，编辑器永远存不出合法的 N 阵营地图，
   但这一步不涉及新 UI，纯逻辑改动，可以在 UI 之前先做完并测试。
4. **编辑器 UI：阵营增删入口**（§6）：放在第二节"两入口合并"之后，避免两次实现
   同一块 UI。
5. **结算类专项**（§1.3 提到的 `DragonSystem`/计分板/`EntropySystem`/
   `towerFacing`）：这几处每一处都需要用户先对"N 阵营下这个机制该怎么变"给出
   设计决定（§9 待确认问题），不建议在没有明确规则的情况下自己拍板实现，容易
   做出跟用户设想不一样的东西返工。
6. **中立营地泛化**（§7）：独立立项，不在本次多阵营改造范围内。

每个阶段完成后单独测试+提交，不攒成一次性大改动——跟本仓库一贯的交付节奏一致。

---

## 9. 待确认问题（留给用户拍板，不是技术问题）

1. **`lane` 数据模型选 §3.2 的方案 A 还是方案 B**？（推荐 A）
2. **龙魂/巨龙之力结算**（`DragonSystem.js`）在三方混战抢同一条龙时怎么分——
   击杀方独享，还是按参团贡献分摊？
3. **死亡计分板**（`main.js:350`）在 N 阵营下要不要还是"两栏比分"的呈现形式，
   还是每阵营各一栏？
4. **`EntropySystem` 的秩序-混乱二元轴**在 3+ 阵营地图上：继续只对固定两大阵营
   生效、改成每阵营独立熵值，还是在这类地图上直接禁用这套机制？
5. **删除一个已经声明的阵营时**，如果地图上已经有这个阵营的建筑/兵线声明，是
   拒绝删除（提示先清理），还是级联删掉相关数据？
