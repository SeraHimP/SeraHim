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
 * ==================== 追加：资源/充能条的缓动（双向）====================
 * 用户："画板上显示的的法力条/充能条没有缓动效果。增加缓动效果。画板上进度条和
 * 属性窗口进度条的缓动效果是统一的。"
 *
 * 不能直接复用上面的 stepTrail——那个函数专为"掉血拖尾"设计，语义故意不对称
 * （`real >= disp` 时立刻贴齐、只在【减少】方向才拖尾），这是 HP 场景要的行为
 * （回血/首帧不该有拖尾残影）。法力/充能条是双向都要缓动的资源量（回蓝要有
 * 平滑上升的手感，消耗也要平滑下降），套用 stepTrail 的话回蓝这半永远是瞬间
 * 贴齐、只有消耗那半才缓动，观感是错的。
 *
 * 所以这里单开一个对称版本，但**复用同一个 TRAIL_RATE**——这正是"统一缓动效果"
 * 要求落地的地方：不是随手起一个新的速度，是同一份时间常数在两种语义下各自
 * 用对方向。画板（UnitLayer）与属性窗口（UIManager）的法力/充能条都改走这个
 * 函数，两处从此不会再出现"两套参数各调各的"的情况。
 */
export function stepEase(disp, real, dt, snapEps) {
  if (!(disp >= 0) || Math.abs(real - disp) < snapEps) return { disp: real, easing: false };
  const next = disp + (real - disp) * Math.min(1, dt * TRAIL_RATE);
  return { disp: next, easing: true };
}
