/**
 * AuraValueResolver.js —— 地图全局光环单条效果的数值解析（三种数值模式）
 *
 * ==================== 背景 ====================
 * 用户："新增一个设置添加地图级光环的选项……状态可以设置固定增加某个值/
 * 逐渐增加到某个值/分阶段设置值。" 追问澄清："分阶段"具体是什么力学时，
 * 用户选了"事件触发换挡（推荐）"——复用出兵编排已有的 WAVE_CONDITIONS
 * 条件系统判定换挡时机，不新建一套条件表。
 *
 * 三种模式对应 `map.globalAura.effects[]` 单条效果对象里出现的字段（沿用
 * MapSystem._applyGlobalAura 原有的"看字段推断模式"风格，不加显式 mode 字段）：
 *   ① 固定值：只有 `flat`/`percent`（改动前就有的行为，原样保留）。
 *   ② 渐进到目标值：有 `perMinute`（+ 可选 `max` 封顶）（改动前就有，原样保留）。
 *   ③ 分阶段（新增）：有 `stages` 数组，每项 `{ when, whenArg, flat, percent }`——
 *      按数组顺序把 `whenPasses(stage, ctx)` 挨个判一遍，**最后一个满足条件的
 *      阶段生效**（不是第一个）。这样阶段按"越靠后越进阶"的顺序排列时，
 *      随时间/事件推进自然覆盖前一阶段——例如 `time.after` 类条件是单调的
 *      （一旦满足就一直满足），后面阶段一旦也满足，就该以它为准。
 *      建议第一条永远放一个 `when:''`（永远成立）的兜底阶段，否则条件都
 *      不满足时会退回 flat:0（不报错，但也不生效，等于"光环还没开始"）。
 *
 * ==================== 为什么单独抽出来、为什么是纯函数 ====================
 * 与本次改动里 NeutralCampSystem.js/towerFacing.js 同一个理由：不能测试的逻辑
 * 迟早会漏 bug。`whenPasses()` 已经是纯函数，这里只是在它之上包一层"选哪个
 * 阶段/算哪个数值"，同样不该埋进 MapSystem 类方法里让 headless 测试够不着。
 *
 * ==================== ctx 的诚实限制 ====================
 * 地图全局光环对**所有阵营**生效，不像出兵编排的 wctx 天然有一个"我方/敌方"
 * 视角——所以这里的 ctx 不带 faction/enemy，`WAVE_CONDITIONS` 里 ally./enemy.
 * 前缀那批条件因为拿不到 census/faction 会走"拿不到就放行"的既定口径（见
 * waveComposition.js 头注），对分阶段光环恒为 true，不是 bug。真正对分阶段
 * 光环有意义的主要是 `time.after`/`time.before`（以及不依赖 faction 的
 * `weather.extreme`/`daynight.isNight`/`daynight.isDay`，但 MapSystem 目前
 * 没有接 WorldState，这两条同样会放行）——诚实地说，这次只把"按游戏时长换挡"
 * 这个最常见的用法打通了，其余条件类型技术上可选但暂不保证真的按预期换挡。
 */
import { whenPasses } from '../data/waveComposition.js';

/**
 * 解析地图光环单条效果在当前 ctx 下的数值。
 * @param {object} effect 一条 `globalAura.effects[]`
 * @param {{gameTime?: number}} ctx 世界快照（至少要有 gameTime，其它字段
 *   缺省即代表"这类条件对地图光环不可用"，交给 whenPasses 的既定放行口径处理）
 * @returns {{flat: number, percent: (number|undefined)}}
 */
export function resolveAuraEffectValue(effect, ctx = {}) {
  if (!effect) return { flat: 0, percent: undefined };

  if (Array.isArray(effect.stages) && effect.stages.length) {
    let chosen = null;
    for (const stage of effect.stages) {
      if (whenPasses(stage, ctx)) chosen = stage;
    }
    if (!chosen) return { flat: 0, percent: undefined };
    return { flat: chosen.flat ?? 0, percent: chosen.percent };
  }

  if (typeof effect.perMinute === 'number') {
    const minutes = (ctx.gameTime || 0) / 60;
    let flat = Math.min(effect.max ?? Infinity, effect.perMinute * minutes);
    flat = Math.round(flat * 100) / 100;   // 面板上别出现 7.333333%
    return { flat, percent: effect.percent };
  }

  return { flat: effect.flat ?? 0, percent: effect.percent };
}
