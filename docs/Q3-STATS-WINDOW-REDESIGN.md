# Q3：HP/法力统计窗口重新设计（设计报告，未写任何实现代码）

用户原话："HP/法力的统计窗口不强大，应该分类统计每种不同的单位对该单位造成的伤害，
比如红方远程兵XX，红方近战兵XX，巨龙XX等。反正那个窗口需要重新设计。并且需要添加，
已回复的生命值/护盾值。已缓和的伤害（由于抗性/伤害减免等没有承受的生命值）。总之Q3
我要详细的统计窗口，包括但不限于这些！Q3先仔细思考出报告，先别做。"

按 CLAUDE.md 第四条铁律，这里只出方案、不动代码——三点新增需求逐条给数据模型和
接线方案，最后附一份"不在这三点之内、但同一个窗口里顺手能做"的补充清单（用户原话
"包括但不限于这些"），供你挑要不要一起做。

---

## 一、现状（v51.27 Q6 已实现的部分，作为改动基线）

`UIManager._showHpStatsModal(entity)` 目前显示：
1. 当前/上限 HP。
2. 对物理伤害/对魔法伤害的等效生命值（`calcDamageMultiplier(resist)` 换算）。
3. 护盾三段构成（临时护盾 / 固定护盾 / "护盾"类型）——**只显示当前余量**，不是累计值。
4. 承伤统计——按**伤害类型**分类的三个累计桶：物理/魔法/真实
   （`CombatSystem.trackDamageTaken(target, attackType, finalDamage)`，
   写入 `target._dmgTaken = { physical, magic, true }`，在 `_resolveHit` 和
   `performAttackDirect` 两处、`target.currentHP -= finalDamage` 之后各调用一次）。
5. 累计已回复生命值（`healing.js` 的 `applyHeal` 里 `entity._healReceivedTotal`）
   + `baseHealthRegenMod`%。

`UIManager._showManaStatsModal(entity)` 显示当前/上限 + 四个法力系数
（`manaRegen`/`baseManaRegenMod`/`manaGainPct`/…），`kind !== 'mana'` 时退化成
纯进度展示。法力这条本身没有"谁打的/谁给的"这个概念，下面三点新增需求基本只影响
HP 窗口，法力窗口维持现状即可（除非你觉得也要给法力加"消耗来源统计"，见第四节）。

用户这次的评价是"不强大"——不是"算错了"，是"维度不够"：只按伤害类型分、只看
护盾余量、不知道伤害被减免掉了多少。下面按三条新增需求逐条设计。

---

## 二、需求①：按攻击者分类的伤害统计

### 1. 数据模型

在 `target` 实体上新增一个 Map/对象：`target._dmgByAttacker`，键是"攻击者类别"，
值是 `{ total, count, label }`（total=累计伤害，count=命中次数，label=展示用的
中文名，例如"红方远程兵"/"蓝方巨龙"）。

类别键怎么取，按攻击者类型分三种情况：

| 攻击者类型 | 类别键 | label 例子 |
|---|---|---|
| 小兵（melee/ranged/siege/totem/super/warlock/corrupt/ram） | `${faction}:${type}` | "红方远程兵"（`faction` 中文名 + `CONFIG.templates[type].label`） |
| 塔 | `${faction}:tower:${tier}` | "蓝方外塔"（塔的 `_mapTier` 决定外/内/水晶/枢纽） |
| 巨龙 | `dragon:${element}` | "巨龙（烈焰）"（`DragonSystem.DRAGON_ELEMENTS` 查元素名，巨龙是中立，不分阵营） |
| 无攻击者（DOT 环境伤害、attacker 已死亡查不到实体等） | `env` | "环境/未知来源" |

这张映射表建议单独抽成一个纯函数 `attackerCategoryOf(attacker)`（放
`src/core/resourceBar.js` 或新开一个 `src/core/damageAttribution.js`，参考
`resourceBar.js` 头注"两处都要画同一件事，写两遍必然某天只改对一处"的教训），
因为将来伤害播报/战斗日志等功能大概率也要用同一份归类逻辑。

### 2. 接线位置

`trackDamageTaken` 签名要多接一个参数：

```
function trackDamageTaken(target, attacker, attackType, finalDamage) {
  ...原来的按类型累加...
  const key = attackerCategoryOf(attacker);   // attacker 可能是 null/undefined
  const bucket = target._dmgByAttacker ??= new Map();
  const b = bucket.get(key) ?? { total: 0, count: 0, label: labelOf(key, attacker) };
  b.total += finalDamage; b.count += 1;
  bucket.set(key, b);
}
```

两个调用点（`_resolveHit` 里那次、`performAttackDirect` 里那次）都已经拿得到
`attacker`（前者是 `this.entities.get(hitInfo.attackerId)`，后者是形参
`attacker`），改起来是纯粹的"多传一个参数"，不涉及找不到攻击者时的新逻辑
（`attacker` 为空时 `attackerCategoryOf` 返回 `'env'`，跟现有"无攻击者时的
攻击结算照样放行"的既有行为一致，不新增边界分支）。

### 3. 展示

按 `total` 降序列出所有出现过的类别，格式参考用户举例："红方远程兵 1234
（32%）"——百分比 = 该类别 total / 三种伤害类型总和（用现有的 `_dmgTaken` 三桶
求和当分母，两套统计对同一批伤害各自累加，理论上应该始终一致，可以顺手拿来做
一致性断言）。类别多的话考虑"只展示前 6 名 + 其余合并成'其它'"，具体阈值走
`CONFIG.ui`（沿用铁律②"一切数值都要软编码"）。

---

## 三、需求②：已回复的生命值 / 已获得的护盾值

已回复生命值这部分**已经做了**（`_healReceivedTotal`），只是要在重新设计的窗口
里更显眼地摆出来，不需要新接线。

已获得护盾值目前完全没有累计——护盾有三条独立的"获得"路径，需要分别打点：

| 护盾类型 | 获得的代码位置 | 打点方式 |
|---|---|---|
| 临时护盾（`tempShield`） | `healing.js` 的 `grantTempShield(entity, amount, power)` | 函数内部 `entity._shieldGainedTotal = (entity._shieldGainedTotal||0) + applied`，跟 `applyHeal` 现有的写法完全同构——这是所有临时护盾发放的唯一入口（吸血转护盾、图腾兵主动技能等都走它），一处打点全覆盖 |
| 固定护盾（`shieldFixedCurrent`） | `CombatSystem.js:246-252`，"距离上次受击超过 `shieldRegenDelay` 后回满" | 回满那一刻是 `shieldMax - entity.shieldFixedCurrent`（只在这个值 >0 时累加，回满到同样的值不算"又获得了一次") |
| `kind:'shield'` 效果 | `EffectRegistry._recalcEffectValues`，`effect.shieldRemaining = Math.max(0, ...+ (totalFlat - prevFlat))` | 只在 `totalFlat - prevFlat > 0`（新增/叠层，不是效果到期或被消耗）时把这个正向 delta 累加到 `effect` 所属实体的 `_shieldGainedTotal` |

三条路径最终都写向同一个字段 `entity._shieldGainedTotal`，窗口里直接读这一个
数就够。**不要**把"护盾自然衰减"（`tempShieldDecayPct`）算成负的"获得"——
那是消耗，不是获得的反面，这条统计只增不减，跟 `_healReceivedTotal` 的语义
（生命值也会因为伤害掉，但 `_healReceivedTotal` 从不因为掉血而减少）保持一致。

---

## 四、需求③：已缓和的伤害（抗性/伤害减免，不含护盾吸收）

用户明确把这条和护盾吸收分开："由于抗性/伤害减免等没有承受的生命值"——护盾
吸收已经有自己的三段展示，这条统计的是"如果没有护甲/魔抗/伤害减免/格挡，
本来会扣多少血，减免之后少扣了多少"，在**护盾吸收之前**的那一步。

### 1. 结算管线里的位置

两条伤害结算路径（`_resolveHit`/`performAttackDirect`）都是这个顺序：

```
totalRaw（未经任何减免的原始伤害）
  → × calcDamageMultiplier(抗性)          ← 抗性减免
  → − damageReduction（真实伤害跳过这步）  ← 减伤
  → − damageBlock（真实伤害跳过这步）      ← 格挡
  = 减免后、护盾吸收前的伤害
  → _absorbByShields(...)                 ← 护盾吸收（已有自己的统计）
  = finalDamage（真正扣的血）
```

"已缓和的伤害" = `totalRaw`（或对真实伤害来说就是它本身，因为真实伤害不吃
抗性/减伤/格挡三项里的任何一项——`isTrueDamage` 分支已经把这仨都跳过了）减去
"减免后、护盾吸收前的伤害"。真实伤害这一路径这个差值恒为 0，天然不需要特判。

### 2. 接线

`trackDamageTaken` 顺手再加一个参数（或者干脆把"计算减免量"放在调用
`trackDamageTaken` 之前，两处调用点各自算好了传进来）：

```
const mitigated = Math.max(0, totalRaw - afterMitigationBeforeShield);
trackDamageTaken(target, attacker, attackType, finalDamage, mitigated);
```

累加到 `target._dmgMitigatedTotal`。展示时可以顺带算一个"减免率" =
`_dmgMitigatedTotal / (_dmgMitigatedTotal + 三类型伤害之和)`，让"抗性堆得值不值"
这件事有个直观数字。

---

## 五、窗口整体布局建议

HP 统计窗口（`_showHpStatsModal`）按这个顺序重排，每段都给一个小标题
（复用现有 `_statsRowHtml` 的行渲染，标题参考天气/状态窗口那一套毛玻璃分段样式）：

1. **基础**：当前/上限 HP，对物理/魔法伤害的等效生命值（原样保留）。
2. **承伤 — 按类型**：物理/魔法/真实三个累计桶（原样保留）。
3. **承伤 — 按来源**（新增，需求①）：按攻击者类别降序列出，带百分比。
4. **减免与格挡**（新增，需求③）：已缓和的伤害总量 + 减免率。
5. **护盾**：当前三段构成（原样保留）+ 已获得护盾总量（新增，需求②）。
6. **治疗**：已回复生命值总量（原样保留，只是挪到独立分段）+ `baseHealthRegenMod`%。

法力窗口维持现状不动（除非采纳下面第六节里法力相关的补充项）。

---

## 六、补充清单（不在这三条明确需求之内，"包括但不限于"的候选项）

这些不是本报告要拍板的内容，只是同一个窗口顺手能加、列出来供你挑：

- **承受伤害中的暴击占比**：命中次数/累计伤害里，有多少来自对方暴击（需要
  `hitInfo.isCrit` 在 `trackDamageTaken` 这一层也能拿到，目前只在结算内部用，
  没有随伤害记录流出来，需要多传一个布尔）。
- **单次最大伤害峰值**：`target._maxSingleHit`，一行 `Math.max` 就行，用户
  常见的"这一下差点没扛住"的直觉。
- **最近 N 次受击明细**（时间/来源/类型/数值的滚动列表）：信息量最大但实现
  成本也最高（需要环形缓冲区，且要控制窗口渲染时的 DOM 开销），建议作为
  "如果这次做完还想要更细"的下一步，不建议跟前三条一起做。
- **法力窗口**：法力消耗统计（技能施放次数/总耗蓝）、法力溢出浪费量（满蓝时
  被动回复空转掉的部分）——如果你觉得法力窗口也该"变强大"，这是类比 HP 那边
  "承伤统计"的对应物（"耗蓝统计"），但目前法力这条完全没有基础设施
  （没有"记录每次扣蓝"的钩子），成本比 HP 这三条都高，需要单独排期。

---

## 七、实现成本与风险小结

- 三条需求都是"在已有的伤害/治疗/护盾结算函数里多打一两行统计点 + 多存几个
  字段"，不改变任何结算数值本身，风险集中在"新写的统计代码本身有没有 bug"，
  不涉及平衡改动。
- 需求①的攻击者类别打点要求两处调用点都能拿到 `attacker` 实体——已确认两处
  都能拿到，不需要改传参链路上更早的环节。
- 需求②的固定护盾"回满"是一次性事件（跳变到 `shieldMax`），不是逐帧线性增长，
  打点要放在"从不足 shieldMax 变成等于 shieldMax"的那一刻，不能算"每帧都在
  回复"，否则会把同一次回满重复计入很多次。
- 每个实体新增的字段（`_dmgByAttacker` Map、`_shieldGainedTotal`、
  `_dmgMitigatedTotal`）量级很小（几个数字/一个小 Map），不构成性能问题；
  巨龙/塔常驻整局，Map 会跟着整局累积键值对，但类别数上限是"阵营数×兵种数"
  这个量级（几十个），不会无界增长。
- 需要新增一套 `tests/sim_*.mjs`（或扩展 `sim_qualitybatch.mjs`）钉住：
  ① 同一批伤害分别按类型/按来源两套桶累加，两边求和应相等（一致性断言）；
  ② 攻击者死亡/查不到实体时正确归入"环境/未知来源"而不是报错；
  ③ 固定护盾回满只在"从不足变成等于上限"那一刻计一次，不会被同一次回满
  重复计数；④ 真实伤害的"已缓和伤害"恒为 0。
