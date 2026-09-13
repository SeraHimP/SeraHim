/**
 * barTrail.js —— 血条「掉血拖尾」的**唯一**一份实现
 *
 * 用户："画面中进度条的拖尾特效和属性栏进度条的拖尾特效并不统一，统一为画面中的拖尾特效。"
 *
 * ==================== 两份拖尾，两套参数 ====================
 * 画面里那条（UnitLayer._redrawBar，画在血条纹理上）与属性面板那条
 *（UIManager 的 .bar-hp-trail）各写了一份，于是三项参数全都对不上：
 *
 *              画面中（正确的那份）              属性面板（旧）
 *   颜色       rgba(255,150,150,0.6) 淡红        #a68a2e 暗黄
 *   缓动       disp += (real−disp)·min(1,dt·7)   disp += (real−disp)·(1−0.05^dt)
 *              时间常数 ≈0.14s                    时间常数 ≈0.33s，慢一倍多
 *   收敛       差值小于一个像素就贴齐、停动画     永不贴齐，无限逼近
 *   叠加       无                                 CSS 还额外套了 transition 0.45s
 *
 * 最后那条尤其糟：JS 每帧改一次 width、CSS 再对每次改动做 0.45s 缓动，
 * 两层缓动叠起来，属性面板的拖尾比画面里的慢了三四倍 —— 同一次掉血，
 * 画面里的残段已经收完了，面板里那截还挂着。
 *
 * ==================== 为什么抽成一个文件 ====================
 * 与 statMod / laneLabels / towerFacing 同一个理由，而且是同一个老毛病：
 * "同一件事实现了两遍"，先做的那份改对了、后做的那份没人想起来。
 * 抄一份过去的话，下次调手感仍然要记得改两处。现在参数只有这一处。
 */

/** 拖尾残段的颜色（画面中那份的取值，属性面板改用它）。 */
export const TRAIL_COLOR = 'rgba(255,150,150,0.6)';

/** 缓动系数：disp 每秒向 real 靠拢的比例基数（时间常数 ≈ 1/RATE ≈ 0.14s）。 */
export const TRAIL_RATE = 7;

/**
 * 推进一帧的显示血量。
 *
 * @param disp   上一帧的显示血量（0~1）；<0 表示"还没初始化"
 * @param real   本帧的真实血量（0~1）
 * @param dt     本帧时长（秒）。调用方自行夹取上限，避免卡顿后一帧跳完
 * @param snapEps 贴齐阈值：差值小于它就直接贴齐并结束动画。
 *                取"一个像素对应的血量比例"——画面里的条 64px 宽就传 1/64，
 *                面板里的条约 300px 宽就传 1/300。低于一个像素的差人眼看不见，
 *                却会让动画永远不结束（画面那份靠它停止重绘纹理，是性能相关的）。
 * @returns { disp, trailing }
 */
export function stepTrail(disp, real, dt, snapEps) {
  if (!(disp >= 0) || real >= disp) return { disp: real, trailing: false };
  const next = disp + (real - disp) * Math.min(1, dt * TRAIL_RATE);
  if (next - real < snapEps) return { disp: real, trailing: false };
  return { disp: next, trailing: true };
}

/**
 * ==================== v51.27（Q1）：撤销"双向缓动"，法力/充能条改回 stepTrail ====================
 * 这里原来有一个 stepEase（双向缓动版本），是更早一轮"画板法力条要有缓动"需求
 * 加的：让法力条主体本身平滑地滑向真实值，回蓝/消耗两个方向都缓动。
 *
 * 用户这一轮反过来定稿："进度条主体大幅削弱动画效果（几乎看不出来），用拖尾特效
 * 展示"——法力条主体在肉眼可见地滑动，跟血条"主体瞬时贴齐、只有掉的那段用拖尾
 * 表现"的观感不统一，等于是两种完全不同的动画语言。所以法力/充能条改回跟 HP
 * 同一形状：主体瞬时贴齐真实值，只在【减少】方向（消耗法力/充能重置）用
 * stepTrail 拖一段淡红残影——直接复用上面这个函数，不再需要对称版本。
 * stepEase 因此被删除：全仓库排查后确认没有第三处调用点，留着就是死代码。
 */

/**
 * ==================== v51.27（Q1）："增加特效"预告条 ====================
 * 用户："进度条主体大幅削弱动画效果（几乎看不出来），用拖尾特效展示。……如果某
 * 单位在固定时间内要增加一定数额的值，就会在进度条高位出出现'拖尾特效'同款的
 * 一个显示（但是不要长得一样要做区分），就是告诉这个单位要回这么多血或者是法力。"
 *
 * 预告的量 = 接下来 windowSec 秒内、按【当前实际每秒回复速率】能回到的份额，
 * 换算成条的宽度分数。画在真实值的高位一侧（拖尾画在掉血/掉法力那侧的低位，
 * 这个画在回复方向的高位，位置天然区分；调用方再配一个跟拖尾色不同的颜色，
 * 双重区分——见 CONFIG.ui.barIncreasePreview.color）。
 *
 * 不需要维护帧间状态：纯粹是"当前速率 × 固定窗口"的即时值，速率变了下一帧
 * 自然跟着变，不存在"追不追得上"的动画收尾问题（拖尾才有那个问题）。
 *
 * @param effRegenPerSec 实际每秒回复速率（已经乘过 regenMod/治疗强度等系数）；
 *                        <=0 时不预告（掉血/掉法力没有"即将增加"这回事）。
 * @param max 该资源的上限（生命上限/法力上限）；<=0 时无意义。
 * @param realFrac 当前真实占比（0~1），预告条不能超过 1（顶到满就截断）。
 * @param windowSec 预告的时间窗口（秒），来自 CONFIG.ui.barIncreasePreview.windowSec。
 * @returns 预告条的宽度分数（0~1，已经夹到 [0, 1-realFrac]）。
 */
export function previewFrac(effRegenPerSec, max, realFrac, windowSec) {
  if (!(effRegenPerSec > 0) || !(max > 0)) return 0;
  const raw = (effRegenPerSec * windowSec) / max;
  return Math.max(0, Math.min(1 - realFrac, raw));
}
