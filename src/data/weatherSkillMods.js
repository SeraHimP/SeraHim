/**
 * weatherSkillMods.js —— 天气对"特定单位·特定技能"的定向修正（框架，v1 表为空）
 *
 * 用户："可以做某个天气在原有基础的修正外，对某单位的某个技能做额外修正。比如说
 * 雾天对攻城车的攻城模式额外降低-50%攻速（仅举例）。" ——举的例子本身不是定稿
 * 数值，本轮只落地框架：数据结构 + 读出机制（WeatherSystem.getSkillParamMod），
 * 不往任何真实技能里接这条修正，也不往这张表里塞这个例子。见
 * docs/Q4-WEATHER-REDESIGN.md §六。
 *
 * ==================== 为什么需要单开一张表 ====================
 * Weather.js 已有两张表：
 *   - effects：改一个 statKey（走 AttributeCalculator 的通用合并管线），对"一整类
 *     单位"生效（如 minion_ranged_siege）。
 *   - structural：改索敌半径/转身速度这类不是 statKey、但仍是"全局杠杆"的机制。
 * 这张要修正的是"某一个具体技能定义（src/core/skills/*.js）里的某个
 * defaultParams 参数"，两张现表都够不到——技能参数不是 entity 的 stat，也不是
 * 全局杠杆，是"这个技能实例自己的一个数字"。
 *
 * ==================== 条目形状 ====================
 * { weatherId, skillId, paramKey, flat?, percent? }
 *   weatherId：Weather.js 里任意一个基础/极端天气 id。
 *   skillId：src/core/skills/*.js 里任意一个技能定义的 id。
 *   paramKey：该技能 defaultParams 里的某个键。
 *   flat/percent：满档时的修正值，与 effects/structural 同一套"档位系数缩放"
 *     语义（由 WeatherSystem.getSkillParamMod 读出，档位系数取自
 *     getEffectiveStrengths()/getExtremeStrengths()，与其它两张表完全同源）。
 *
 * 当前为空——用户确认要不要真的做某条具体内容之后再填。
 */
export const WEATHER_SKILL_MODS = [];
