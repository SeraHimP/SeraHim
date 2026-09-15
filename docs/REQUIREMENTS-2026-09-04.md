# 需求汇总 —— 2026-09-04

用户提出四项新需求，讨论范围/做法后拍板，按 3→4→1→2（先搭骨架/校正几何，
再叠更表层的编排/光环配置）顺序实施，每做完一块单独测试+提交。

---

## 一、中立阵营通用骨架（原第六节阶段6，重新立项）

### 用户原话
"出兵开关/中立单位开关（包含巨龙和未实现的野怪）中增加编辑每种单位的默认属性和
成长属性……现在就设计通用中立系统骨架，巨龙只是第一个实例。"

### 现状勘查
全仓库搜索确认：中立单位目前只有巨龙一种实现，"Baron 坑"（`map.pits.baron`）
一直只是个坐标，从来没有一个真正叫 baron 的可生成单位。巨龙的出生位置/路径
写死在 `factories.js createDragon()` 里一段内联的 `pitSide`/`getPit` 判定：
上坑（baron 坑位）走 top 路推蓝方（reverse）、下坑（dragon 坑位）走 bot 路
推红方（forward），`DragonSystem._nextPitSide` 每次交替。

巨龙自己的生成节奏（元素/远古轮换、龙魂阈值、杀数成长）是很深的一套机制
（`DragonSystem.js` 894 行），不是"中立营地"这个概念该泛化的东西——勉强
抽象成通用引擎反而会拆坏已经打磨好的机制。真正该泛化的是"出生地/出生路径"
这份**数据**。

### 落地
新增 `src/systems/NeutralCampSystem.js`（纯函数模块，同 `FactionSystem.js`
一个风格，没有 `update()`）：
- `neutralCampsOf(map)`：`map.neutralCamps` 未声明时按巨龙既定行为合成默认值
  （baron坑/top/reverse + dragon坑/bot/forward），现有三张地图不用改一个字。
- `campSpawnPoints(map, mapSystem, unitType)`：把 `pitRef` 换算成真实坐标、
  `laneMatch` 换算成真实存在的路 id，没有坑位可用时退到该路的路点中点——
  与改造前 `factories.js` 的判定逻辑逐位对应。
- `campTriggerDue(trigger, ...)`：通用触发判定骨架（首次延迟/周期/可选条件，
  条件复用出兵编排的 `WAVE_CONDITIONS`），巨龙不用它（巨龙自己的计时器更
  复杂，硬套会丢精度）——留给以后真的出现第二种中立单位时用，现在只有纯
  函数测试钉住行为。
- `NEUTRAL_UNIT_TYPES`：接了真正生成器的单位类型登记表，目前只有 `dragon`——
  编辑器"单位类型"下拉框的唯一来源，不会让用户选一个没有生成逻辑的死胡同类型。

`factories.js createDragon()` 改成向 `campSpawnPoints()` 查坑位/路/方向，
判定逻辑一处没搬，只是挪了地方——18+29 条测试逐位核对三张真实地图上巨龙的
出生行为改造前后完全一致。

`mapEditorCore.js` 新增中立营地编辑纯函数（`cloneNeutralCampsForEdit`/
`withCampSpawnPointFieldSet`/`Added`/`Removed`），统一编辑器"配置模式"新增
"中立营地"面板：每个出生点可改 X/Y 坐标、所在路、方向；新增/删除出生点
（至少保留一个）。

### 已知限制（诚实说明）
- 只有 dragon 一种单位类型有生成器，编辑器目前只能编"巨龙这个营地在哪出生"，
  不能新建一个全新的中立单位类型（没有生成逻辑，新建了也是摆设）。
- `campTriggerDue()` 骨架已就绪但没有任何真实系统在用它——巨龙保留自己的
  计时器，等以后有第二种中立单位再接进去验证。

---

## 二、召唤师峡谷兵线居中校正 + 编辑器自动对齐工具

用户："蓝方下路的兵线，在路上有些偏上，正常的下路兵线应该是在下路的路
中央。"——路点没有居中在地形走廊里的几何校正问题，不是终点连线方式的问题。

### 勘查方法
先用可行走 navgrid 位图 + 真实小地图底图叠加路点做了一次视觉核对，信号偏弱
（枢纽附近是开阔广场+丛林点缀，看不出明显的"路"边界）。改用定量方法：对每个
中间路点取路径切线的垂直方向，双向探墙量走廊宽度，算出该点离走廊几何中点的
偏移格数。结果证实了一个真实但偏细微的模式——贴边界的直线段路点确实一致偏
1~4 格；转角/枢纽端开阔地那几个点算出的"大偏移"是搜索半径不设上限时在开阔地
失真，不是真的偏了。这次定量分析直接决定了 `alignLaneToCorridor()` 要**限制
搜索半径**（默认15格）——两侧摸不到墙就跳过，让算法自己分辨"该修"和"不该碰"，
不用给转角手工打标记。

### 落地
`mapEditorCore.js` 新增 `alignLaneToCorridor(bits, n, world, waypoints, opts)`：
沿路径切线的垂直方向双向探墙找走廊边界，把路点吸附到边界中点；首尾路点（锚
定基地/水晶）永远不动；搜索半径内两侧摸不到墙（开阔地）原样跳过；路点自身
若恰好落在不可走格（贴边/取整误差），先双向找最近可走格作为参照原点再测走廊，
避免"起点本身在走廊外→双向探墙都从0开始→误判成已居中"的假阴性（写测试时
发现的真实算法 bug，已修）。

编辑器"路径编辑"模式新增「🎯 自动对齐到走廊中线」按钮，点选中的路后一键应用，
日志报告实际移动了几个路点。

### 召唤师峡谷实际数据校正
用该算法核实、并直接把结果写回 `summoners_rift.js`：top 路 6 个路点、bot 路
2 个路点被吸附回走廊中线（均为个位数~三十来个世界单位的小幅修正，转角/枢纽端
开阔地的点未动，其余已经居中的点未动）。这是用户反馈的具体案例（蓝方下路偏上）
在真实地图数据里的直接修正，不只是留一个工具等用户自己点。

（执行中，见下方状态）

---

## 四、老地图接入新框架（地形模板拆分 + 中立营地显式化）

### 用户原话
"还有把老地图都接入新的框架，包括地形，光环等等。"

### 与既有决定的冲突（先问清楚再动）
`mapComposition.js` 头注里记着一条此前拍板的决定："现有三张地图不迁移"——
不拆分成独立的地形/配置文件，理由是怕牵连它们身上大量的既有测试/平衡数据。
这次用户的新要求正好推翻这条决定，先确认过用户明确要推翻（接受返工风险），
才动手，没有静默覆盖一条已经写进代码注释里的历史决定。

### 落地
三张内置地图源码（`summoners_rift.js`/`twisted_treeline.js`/`howling_abyss.js`）
内部拆成 `XX_TERRAIN`（纯物理地形：world/useNavgrid/navgrid/walls/heightZones/
highground/obstacles）+ `XX_CONFIG`（阵营/塔位/兵线/数值覆写/出兵节奏等玩法
内容），末尾用 `composeMap({ terrain, config })` 拼回原来"一个对象揉在一起"
的导出形状——**对下游系统完全透明**：`MapSystem`/所有系统读的还是同一个
完整地图对象，只有这三个源文件内部怎么组织自己的数据变了。用脚本对三张图
分别做过深度比较（逐字段递归 JSON 比对，不受 key 顺序影响），确认拆分前后
除新增的 `neutralCamps` 字段外，其余每一个字段值逐位不变。

同时把中立营地（巨龙）从"没声明就靠 `NeutralCampSystem.neutralCampsOf()`
合成默认值"改成三张图各自显式声明——写的是同一份默认合成的数据形状
（baron/top/reverse + dragon/bot/forward），`campSpawnPoints()` 解析出来的
坑位/路/方向与显式化之前逐位一致（含嚎哭深渊"没有 top/bot，退化到 mid 路点
中点"那条既有的退化行为，也原样保留）。这张图自己现在能在编辑器"配置模式"
的中立营地面板里直接看到/改这份配置，不再是隐式黑盒。

光环（`globalAura`）本来就是显式字段（扭曲丛林/嚎哭深渊各自的光环定义早就
写在 config 里），这次拆分把它自然带进了 `XX_CONFIG`，不需要额外改动；
召唤师峡谷目前没有光环（第三节的三种数值模式做完后再决定要不要给它加）。

### 测试
`tests/sim_mapcomposition.mjs` 新增两节：④用源码正则钉住三个文件确实各自
`import { composeMap }` 并用 `XX_TERRAIN`/`XX_CONFIG` 拼出导出对象（防止
以后有人手滑改回整体字面量又不吱声）；⑤核对三张图的 `neutralCamps` 都是
显式声明（不再靠 `neutralCampsOf()` 合成）且解析行为与改动前逐位一致。
`tests/sim_neutralcamp.mjs` 的 25 号断言相应更新（见下方"改动的期望常量"）。
Playwright 实机验收：三张图依次在编辑器里切换、进配置模式，画面正常、
0 条真实控制台报错。

### 改动的期望常量
- `tests/sim_neutralcamp.mjs` 25 号断言从"`buildCustomMapPayload` 不传
  `neutralCamps` 时该字段是 `undefined`"改为"不传时保留 `baseMap` 声明的
  原值"。原因：这条断言测的是"`baseMap`（`summoners_rift_v1`）本来就没有
  `neutralCamps` 这个字段"这个前提——`buildCustomMapPayload` 对其它所有
  "不传"字段（buildings/lanes/factions 等）的既定规则统一是"保留
  `cloneMapForEdit(baseMap)` 克隆出来的原值"，`neutralCamps` 显式化之后，
  `baseMap` 真的有这个字段了，"不传就带出原值"是这条既定规则的自然结果，
  不是新 bug；旧断言的前提已经不存在，不是真正该守的不变量。

---

## 五、地图光环状态系统三种数值模式

用户拍板：光环只做"状态"（不做"技能"挂载），参照现有扭曲丛林/嚎哭深渊
`globalAura` 形状；数值模式固定值/线性渐进到目标值都好确定，"分阶段"用
事件触发换挡——复用出兵编排已有的 `WAVE_CONDITIONS` 条件系统判定换挡时机，
不新建一套条件表。

新增 `src/systems/AuraValueResolver.js`：纯函数 `resolveAuraEffectValue(effect, ctx)`
按效果对象上出现的字段推断模式（`stages` 数组→分阶段/`perMinute`→渐进/否则
固定值，与 `MapSystem._applyGlobalAura` 原有的"看字段推断"风格一致）。分阶段
模式按数组顺序判 `whenPasses`，最后一个满足条件的阶段生效。`MapSystem`
改为调用这个纯函数，固定值/渐进模式解析结果逐位不变。`mapEditorCore.js` 新增
光环编辑纯函数，编辑器"配置模式"新增"地图光环"面板（属性下拉复用"添加效果"
面板已有的 `EDITOR_PAGES_SKILLEFFECT._EFFECT_STAT_KEYS`）。

## 六、地图编辑器：非正方形地图画布变形（用户实机反馈）

用户："那个框应该根据地图的形状来自适应"——navgrid 内部缓冲永远是 n×n
正方形（两条轴各自独立归一化到 [0,n]），画布 CSS 显示尺寸此前写死正方形，
扭曲丛林（3008×1388）被硬挤成正方形显示。新增 `navgrid.js` 的
`canvasDisplaySize(worldW, worldH, maxPx)`：显示框长宽比按世界长宽比走，
世界→CSS px 缩放系数因此在两条轴上相等。主画布/出兵编排缩略图都改用这个
函数现算，不缓存。

## 七、中立营地出生点：并入"建筑摆放"画布可视化点选

用户："巨龙出生点等所有中立生物的出生点所有的都可以在地图上选点……显示
点位那里弄个过滤器，可以选择都显示什么，并且在右侧也有新增/移动/删除等
工具栏！"追问后拍板：并入现有"建筑摆放"编辑模式（不新建独立 tab），同一块
画布上同时画建筑标记和营地出生点。

落地：出生点在画布上画成金色菱形（与建筑的彩色圆点明显区分——不属于任何
阵营）；过滤器是按 `NEUTRAL_UNIT_TYPES` 键值的复选框列表（目前只有巨龙一项，
为以后新中立单位类型预留）；"新增出生点"是个模态开关（同折线造墙同款交互
心智），开着时点画布任意位置=给选中营地加一个新出生点；关着时（默认）点
已有出生点=选中并可直接拖动移动，命中判定复用建筑摆放同一个
`buildingHitRadiusPx`；"删除选中出生点"按钮走已有的
`withCampSpawnPointRemoved`（至少保留一个出生点的既定校验原样生效）。

## 八、出兵条件重做：阵营选择 + AND/OR/NOT 组合

（已完成，见下方执行状态）

用户拍板：①"本路水晶已陷落（旧写法）"重做成显式指定阵营 id（从
`map.factions` 下拉选）的条件，直接判定"XX阵营召唤水晶被摧毁"，不再依赖
ally/enemy 相对概念（3+阵营地图下 enemy 只能指向第一个非自己阵营，语义不成立）；
②出兵条件从单条件扩展为平铺列表+每条可取反(NOT)+整组 AND/OR，不做嵌套
表达式树。

**数据模型**（`src/data/waveComposition.js`）：新增两条条件
`faction.nexus_lane.destroyed`/`faction.nexus_lane.alive`，`arg: { type:
'faction', ... }` 是全文件唯一一处非数值参数标记；旧的 `nexusDown`/
`!nexusDown` 保留（老存档不失效），标签改注"建议改用……"。组合逻辑：
`rule.whenItems: [{token, arg, negate}]` + `rule.whenOp: 'and'|'or'`
是纯新增字段，`conditionItemsOf(rule)` 在没有 `whenItems` 时从旧的
`when`/`whenArg` 合成一个单元素数组兜底——旧规则的判定结果与改动前逐位
一致（单条件时 AND/OR 无意义、negate 恒为 false，退化成原来"直接返回
test() 结果"）。`AuraValueResolver.js` 的分阶段光环因为已经复用
`whenPasses(stage, ctx)`，这条组合能力零改动自动继承。

**消费方接线**：`arg.type==='faction'` 这个判据统一贯穿三处 UI——
`pagesWave.js`（全局模板编辑器出兵编排页，只做了这一处最小修复：数字
输入框换成阵营下拉，**没有**做完整多条件组合 UI，切换条件时新旧 arg
类型不一致会把 whenArg 重置成新默认值，避免残留一个类型不对的值）、
`MapEditorDialog.js` 的地图光环分阶段行（`renderAuraStageRow`，同样只
修了 arg 渲染，阶段判定仍是单条件，不做组合）、`MapEditorDialog.js` 的
出兵编排规则卡片（`renderRuleCard`，**唯一**做了完整平铺列表+NOT+整体
AND/OR 编辑 UI 的地方——用户拍板的范围就是"按地图编排的规则卡片"，全局
模板编辑器那张密集网格表和光环阶段行结构风险更高，这次不动）。
`mapEditorCore.js` 新增 `withRuleConditionsSet()`：整体替换某条规则的
条件组合并清掉旧的 when/whenArg 字段，不留两套写法互相打架。
`NeutralCampSystem.campTriggerDue` 调用的是旧的 `{when, whenArg}` 单条件
形状，`conditionItemsOf` 天然兼容，零改动。

---

## 执行状态

- [x] 第一节：中立阵营通用骨架——`NeutralCampSystem.js` + factories.js 接入 +
      mapEditorCore.js 编辑纯函数 + 统一编辑器"中立营地"面板。29+18 条
      pure-function/集成测试，Playwright 实机验收（改坐标/新增/删除出生点/
      保存全链路无误）。
- [x] 第二节：召唤师峡谷兵线居中校正 + 自动对齐工具——`alignLaneToCorridor()`
      纯函数 + 编辑器一键按钮 + 直接校正 top/bot 两条路的真实数据。10 条
      pure-function 测试（含真实数据核验、"路点落在走廊外"回归用例），
      Playwright 实机验收（bot 路 2 点被吸附、日志/画布同步、0 真实控制台报错）。
- [x] 第四节：老地图接入新框架（地形模板拆分 + 中立营地显式化）——三张内置
      地图源码内部拆成 `XX_TERRAIN`/`XX_CONFIG` 两块，用 `composeMap()` 拼回
      同一个导出对象（对下游透明，脚本深度比较过逐字段值不变）；`neutralCamps`
      从隐式默认合成改为三张图各自显式声明。`sim_mapcomposition.mjs` 新增
      ④⑤两节（17→34 条），`sim_neutralcamp.mjs` 更新 1 条断言，Playwright
      实机验收三张图切换/配置模式 0 真实控制台报错。
- [x] 第五节：地图光环状态系统三种数值模式——`AuraValueResolver.js` 纯函数 +
      `MapSystem` 接入 + 编辑器"地图光环"面板。35 条 pure-function/端到端测试，
      Playwright 实机验收（扭曲丛林5条真实光环效果正确回填/切模式/增删阶段）。
- [x] 第六节：非正方形地图画布变形修复——`canvasDisplaySize()` 纯函数，主画布/
      出兵编排缩略图接入。6 条测试，Playwright 实机验收（扭曲丛林画布从被
      硬挤的正方形变回正确长方形，长宽比误差<0.2%）。
- [x] 第七节：中立营地出生点并入"建筑摆放"画布可视化点选——金色菱形标记 +
      过滤器 + 新增/拖动/删除。7 条 DOM 接线断言，Playwright 实机验收
      （新增→拖动→删除全链路，0 真实控制台报错）。
- [x] 第八节：出兵条件重做（阵营选择 + AND/OR/NOT 组合）——`waveComposition.js`
      新增 `faction.nexus_lane.destroyed/.alive` + `whenItems`/`whenOp`
      组合（`conditionItemsOf` 对旧数据逐位兼容），`mapEditorCore.js` 新增
      `withRuleConditionsSet`。50 条 pure-function 测试
      （`sim_waveaction.mjs`）、8 条 pagesWave.js 阵营下拉渲染/写回测试
      （`sim_v51.mjs`）、10 条 MapEditorDialog.js DOM 接线断言
      （`sim_mapeditor.mjs`）。Playwright 实机验收（地图编辑器规则卡片
      加两条条件→出现 AND/OR 切换→切成阵营条件参数框变成
      `<select>`→勾选 NOT→删除条件，全程 0 真实控制台报错）。
