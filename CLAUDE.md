# SeraHim —— 给 AI 协作者的必读

浏览器塔防（召唤师峡谷复刻），纯 JS + Three.js r169（2.5D），**无构建步骤**、
无 npm 依赖（Three.js 与后处理都已 vendored 到 `vendor/`）。直接开 `index.html` 就跑。

这份文件不是项目介绍，是**踩过的坑清单**。下面每一条都对应一个真实发生过、
且在代码里看不出来的事故。按顺序读，动手前至少扫一遍「零、硬约束」。

---

## 零、硬约束（违反其中任何一条，改动都算失败）

### 1. 行尾必须逐文件保持原样

`.gitattributes` 是 `* -text`：git **不做任何行尾转换**，仓库里存什么就是什么。
而本仓库的行尾是**混合**的：

| 文件 | 行尾 | 备注 |
|---|---|---|
| `src/main.js` | CRLF | **且带 BOM** |
| `src/ui/AttributeEditor.js` | CRLF | **且带 BOM** |
| `src/ui/SettingsDialog.js` | CRLF | 无 BOM |
| 其余绝大多数 | LF | |

用脚本改文件时**必须**同时保留行尾和 BOM：

```python
# 正确：newline='' 双向禁用换行转换；encoding='utf-8' 会把 BOM 当普通字符原样带过
s = io.open(p, encoding='utf-8', newline='').read()
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, new))
```

改完自查（`loneLF` 必须为 0，CRLF 文件的 BOM 必须还在）：

```bash
node -e "const b=require('fs').readFileSync(process.argv[1],'utf8');
console.log('CRLF='+(b.match(/\r\n/g)||[]).length,
            'loneLF='+(b.match(/(^|[^\r])\n/g)||[]).length,
            'BOM='+(b.charCodeAt(0)===0xFEFF))" src/main.js
```

**这不是洁癖。** 已经出过两次事故：
- 往 CRLF 文件里混进几行 LF，diff 变成整段重写，真实改动被埋掉；
- 一个测试用 `split('\n')` 切 CRLF 文件，残留的 `\r` 让 `/\/\/.*$/`
  永远匹配不到整行注释（`.` 不匹配 `\r`，`$` 锚在字符串末尾），
  于是"检查未使用变量"的用例报了 7 个假阳性，全是注释。

### 2. 交付前 `npm test` 必须全绿

```bash
node tests/run_all.mjs      # 约 5~8 分钟，32 套
```

不要用"失败集合没变"当通过标准（本项目曾长期带着 6 个失败用例，
后来查明 5 个是断言自己写错了，不是产品 bug）。**基线是 0 失败。**

新增行为**必须**配一套 `tests/sim_*.mjs` 并注册进 `tests/run_all.mjs` 的 `suites` 数组，
否则等于没做——没有断言守着的行为，下一个人改两行就没了。

### 3. 一切数值都必须软编码

用户的原话：「所有的都不要硬编码，都应该是可编辑的软编码」。
新数值一律进 `src/data/Config.js`，并在编辑器里给出可改入口。
源码里出现魔数就是待改的债。

另外注意用户提过的一条：**同一技能在不同地图上可能表现为数值/机制不同**，
所以技能参数要留地图级覆写的余地（见 `MapSystem` 的 `_params` 注入）。

### 4. 改了期望常量，必须在提交信息里逐项报告

用户明确要求：「随改更新被影响的期望常量，每项在提交里报告」。
提交信息里要写清**哪个常量、从什么改成什么、为什么**。没改也要写"本次未改动任何期望常量"。

---

## 一、架构速览

```
src/
  main.js              主循环 + 装配（唯一允许"认识所有系统"的地方）
  core/                无渲染依赖的纯逻辑
    EntityContainer.js   实体存储 + 空间哈希网格
    AttributeCalculator.js 属性合成（帧级缓存）
    EffectRegistry.js    效果/状态
    SkillLibrary.js      技能定义（含武器）
  systems/             玩法系统（互相之间禁止 import，见下）
  presentation/        渲染层（只读实体，禁止写实体，见下）
  data/
    Config.js            全部可调数值
    schema/index.js      字段注册表：编辑器与运行时的**唯一**取值口径
    templateIO.js        配置导出/导入（可 headless 测）
    maps/                地图模块（含 base64 编码的 256×256 navgrid）
  ui/                  编辑器与面板
tools/
  balance_matrix.mjs   headless 批量对局模拟（胜率/推进度矩阵）
tests/
  run_all.mjs          一键回归
```

### 数据流

```
CONFIG（+ 地图覆写 + 阵营覆写）
      ↓  schema/index.js 统一解析
   实体 baseStats
      ↓  + EffectRegistry 的效果  + WeatherSystem  + WorldState（昼夜/熵/龙魂）
   AttributeCalculator.calc()  →  最终属性（帧级缓存）
      ↓
   CombatSystem / LaneMovementSystem / …
      ↓
   presentation/*  （只读）
```

---

## 二、六条会静默出错的规则

这些违反了**不会报错**，只会让行为悄悄变样，所以格外危险。

### ① 渲染层不许往实体上写字段

渲染状态一律放渲染层自己的 `WeakMap`（见 `EffectsLayer` 的 `_beamEndY`/`_projTgt`）。
往实体上挂 `_renderXxx` 会让逻辑层的序列化、克隆、存档全部被污染，
而且沙盒/对战两套流程下生命周期不一致。

### ② 空间网格改了实体集合就要 `markDirty()`

`EntityContainer._grid` 是缓存。改了实体的存活/位置/增删而不失效它，
`findInRadius` 会返回过期结果。

**踩过的坑（很值得一读）**：塔废墟不阻挡敌人，我一开始判成"避障半径没乘可视缩放"。
真正的原因是**网格只索引存活实体**，所以 `findInRadius(..., aliveOnly=false)` 是一张空头支票，
废墟避障那段代码**从来没执行过**。诊断时不要只看调用点的参数，要确认数据源里真的有那些数据。

### ③ 系统之间禁止互相 import

耦合一律走 `EventBus`，或在 `WorldState.update()` 里**单向**求值。
需要跨系统联动时（例：水晶重建后补发龙魂），在 `main.js` 里监听事件来接，
不要让 `MapSystem` 去 import `DragonSystem`。

### ④ 世界级耦合默认全关

`CONFIG.world.couplings.*` 每一条都是独立开关且**默认 `false`**。
新增耦合必须保证：全关时属性与接入前**逐位一致**（`tests/sim_world.mjs`、
`tests/sim_entropy.mjs` 的第一条断言就是这个）。

### ⑤ 缓存键必须包含影响结果的一切

`AttributeCalculator` 有帧级缓存，键里含天气版本与世界状态。
新增任何会改属性的全局量，**必须**同时进缓存键，否则属性会停在旧值。
（曾经算出了 `sKey` 却忘了拼进 `cacheKey`，昼夜切换后属性纹丝不动。）

### ⑥ 动画相位用挂钟时间，逻辑用 `gameTime`

`gameTime` 会被暂停/倍速影响。渲染的呼吸/闪烁若用它，暂停时会僵住或跳变。

---

## 三、编辑器：改数值的唯一正确姿势

**症状"编辑器改了不生效"在本项目出现过多次，根因都是同一个：
编辑器写 A、运行时读 B。**

所以规矩是：**取值/写值只走 `src/data/schema/index.js`**。
它是唯一的解析顺序实现，`towerTierBase` / `towerTierEffective` / `towerTierSource`
都在那里。曾经这套顺序被抄了**四份**（`createBuilding` 一份、Schema 一份、
运维改层级一份、编辑器一份）——抄的时候都对，改的时候只改一处就错。

分层塔的叠加顺序（后者覆盖前者）：

```
CONFIG.templates.tower
  → 地图 tierStats[tier]
  → CONFIG.towerTierOverrides[tier]          （共享覆写）
  → CONFIG.factionOverrides[阵营].tower_<tier>（阵营覆写）
```

编辑器里每个字段都带**来源角标**（`towerTierSource`），
悬停能看到完整叠加链和被压住的层——排查"我改了怎么没变"先看这个。

新增可编辑分组时，记得把组名加进 `templateIO.js` 的 `IO_GROUPS`，
导出/导入/回归三边会自动跟上（**不要**在别处再抄一份键名列表）。

### 出兵编排

对战出兵**只**由 `CONFIG.gameRules.laneWaveComposition` 决定（数组顺序 = 出兵先后），
经 `src/data/waveComposition.js` 的 `buildWaveOrder()` 求值——编辑器预览与真实出兵
共用这一个函数，所以预览不会骗人。

`gameRules` 里的 `waveXxxCount` / `waveXxxInterval` 只影响**沙盒模式**。
`battleTotemFromWave` / `battleTotemInterval` 是**死配置**，全仓库无人读取
（`tests/sim_tplio.mjs` 有断言守着），保留仅为兼容旧存档，**不要新增读取点**。

---

## 四、调平衡：不要靠肉眼看一局

```bash
node tools/balance_matrix.mjs                          # 基线
node tools/balance_matrix.mjs --runs 20 --minutes 40   # 要下结论就用这个
node tools/balance_matrix.mjs --sweep dayNight         # 扫昼夜加成
node tools/balance_matrix.mjs --sweep entropyLive      # 扫熵（自演化，看雪球）
node tools/balance_matrix.mjs --json out.json          # 落盘便于前后对比
```

它跑的是**真实**的 `MapSystem`/`LaneWaveSystem`/`CombatSystem`，不是简化模型
（简化模型算出来的平衡没有意义）。同一命令可复现。

**判读要点**：基线对局 40 分钟内**基本打不出胜负**（双方各推掉 8~10 座塔就僵住），
所以主信号是**推进度差**而不是胜率——胜率那一列会是一片 0%，读不出任何差别。
推进度 = 已打掉的档位数（外1/内2/高地3/召唤水晶4/枢纽5）+ 最前线那座的掉血比例。

---

## 五、当前世界系统的真实状态

| 系统 | 状态 |
|---|---|
| 天气 | ✅ 完整（OU 随机过程 + softmax 权重），走自己的成熟通道，**没有**并进 WorldState |
| 昼夜 | ✅ 光照 + 数值化（相位在 `WorldState` 里算，`0=黎明 .25=正午 .5=黄昏 .75=午夜`，`phase>=0.5` 为夜） |
| 熵/三核 | ✅ 事件驱动 + 均值回复，见 `EntropySystem.js` 顶部注释（含正反馈风险与三道刹车） |
| 龙魂 | ✅ 阵营级规则：6 条元素龙，≥4 击杀成魂，都不到则**无魂**，之后出远古龙 |

熵的模型一句话：白核/黑核决定**方向**（谁压得狠世界就偏向谁），红核决定**幅度**
（打得越凶非对称越明显），三者都随时间衰减回中性。

---

## 六、地图

`navgrid` 是 256×256 的位图，base64 编码进地图模块。做地形笔刷编辑时注意
**要同时失效三样东西**：`MapSystem._nav` 缓存、`_laneField` 回流场缓存、
地形贴图与植被/水面。目前这三处的失效通知是分散的，动地形编辑器之前
应该先收敛成一个 `mapSystem.invalidate([...])`。

小兵寻路：走廊内用引导向量，卡住时用 BFS 回流场（`_laneField`）脱困。
**注意源半径是 50，不是走廊半宽 130**——用 130 会把偏离中线 70px 的凹角标成
距离 0（"你已经到家了"），回流场直接失效。这个坑让脱困成功率从 8/30 卡了很久。

---

## 七、提交习惯

- 提交信息用中文，把**为什么**写清楚，尤其是"原实现哪里错了"。
- 有期望常量变更就逐项列出。
- 诊断错了要如实说（本仓库的提交历史里有几处"我一开始判断错了，真正原因是……"，
  保留它们是有意的——后来的人省下重复排查的时间）。
