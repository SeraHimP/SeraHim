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
 * ==================== v51.28（Q1返工）："增加特效"改为阈值触发 ====================
 * 用户否掉了 v51.27 那版："增加特效不好！增加特效应该是短时间内获得大量百分比
 * 才会触发！要不然太乱了看起来。" 举例："某状态是10秒内获得50%生命值，这个时候
 * 就要10秒一直显示即将获得生命值。"
 *
 * 旧版的问题：只要被动生命/法力恢复 >0 就常驻显示"未来固定 1 秒能回多少"——
 * 绝大多数单位一直挂着被动回复，等于绝大多数血条一直贴着这条特效，观感确实很乱，
 * 而且这条特效根本没有反映"多久之后能回满/回到多少"，只是一小段固定宽度。
 *
 * 新规则：只统计**临时性**（remainingTime 有限、不是 Infinity 的永久属性）、
 * 直接修正 healthRegen/manaRegen 这两个属性的效果实例（kind:'stat'，与
 * AttributeCalculator._calc 里聚合属性用的是同一份数据，参见该文件对
 * blueprint.statKey/totalFlat 的读法）——这类效果本来就是"限时内按某个速率
 * 回复"的形状，不需要新开一套"限时内定量恢复"的效果种类。
 * 对每个满足"限时"（remainingTime <= maxWindowSec，太长的不算"短时间"）的效果，
 * 把它剩余时间内还能回复的总量（flat 速率 × 剩余秒数）算出来，换算成占上限的
 * 比例；只有这个比例达到 thresholdFrac（默认 12%）才触发显示。
 *
 * 效果本身的 remainingTime 每帧都在减少，这个函数每帧都用当前 remainingTime
 * 重新算一遍，天然实现"10 秒内持续显示，随时间推移逐渐变窄，效果到期同时
 * 消失"——不需要额外维护帧间状态（跟旧版一样是纯函数，只是输入换成了效果表）。
 *
 * 只看 flat（totalFlat），不看 percentValue：healthRegen/manaRegen 本身是
 * 一个"每秒固定量"的属性，percent 类型的调整发生在别的乘法阶段，混进这里的
 * flat×剩余秒数换算会破坏"总量"这个语义，索性不纳入——如果以后需要百分比形式
 * 的临时恢复效果，需要另外的设计，不在这次返工范围内。
 *
 * @param effects 该实体当前的效果实例数组（EffectRegistry.getEffects(id)）。
 * @param statKey 'healthRegen' | 'manaRegen'。
 * @param mult 该资源的实际生效系数（baseHealthRegenMod × 治疗强度，或
 *             baseManaRegenMod × 法力获取加成），与聚合速率用同一份系数，
 *             保证"这份判定"和"面板上显示的实际回复速率"口径一致。
 * @param max 该资源上限；<=0 时不触发。
 * @param realFrac 当前真实占比（0~1）。
 * @param thresholdFrac 触发所需的最小总量占比（来自 CONFIG.ui.barIncreasePreview.thresholdFrac）。
 * @param maxWindowSec 效果剩余时间超过这个数就不算"短时间"，不触发。
 * @returns 预告条宽度分数（0~1，已夹到 [0, 1-realFrac]）；不满足阈值返回 0。
 */
export function bigRegenPreviewFrac(effects, statKey, mult, max, realFrac, thresholdFrac, maxWindowSec) {
  if (!(max > 0) || !Array.isArray(effects)) return 0;
  let total = 0;
  for (const eff of effects) {
    if (!eff || eff.blueprint?.kind !== 'stat' || eff.blueprint.statKey !== statKey) continue;
    const rt = eff.remainingTime;
    if (!(rt > 0) || !isFinite(rt) || rt > maxWindowSec) continue;
    const flat = (eff.totalFlat || 0) * mult;
    if (flat > 0) total += flat * rt;
  }
  if (total <= 0) return 0;
  const frac = total / max;
  if (frac < thresholdFrac) return 0;
  return Math.max(0, Math.min(1 - realFrac, frac));
}

/**
 * v51.28（Q1返工）："增加特效"颜色改为按该进度条自身颜色自适应——用户："而且
 * 颜色不要做成红色啊！做成和该进度条颜色的自适应颜色（要做出区分）。"
 * 把传入的基础色（HP 血条的阵营色 / 资源条的 RESOURCE_COLORS 色）转到 HSL，
 * 提亮 + 略微提高饱和度后转回来——同一色相，但比真实血量段明显更亮更淡，
 * 一眼能分清"这段是预告，不是真实血量"，同时颜色本身"属于这条血条"，不再是
 * 一个跟所有血条都无关的固定暖黄。
 *
 * @param baseColor 该条的真实颜色，支持 '#rgb'/'#rrggbb' 或 'rgba?(...)'。
 * @param lightenPct 提亮多少（HSL lightness 百分点），来自 CONFIG。
 * @param alpha 预告段的透明度，来自 CONFIG。
 */
export function deriveIncreaseColor(baseColor, lightenPct, alpha) {
  const [r, g, b] = _parseColor(baseColor);
  let [h, s, l] = _rgbToHsl(r, g, b);
  l = Math.min(0.96, l + lightenPct / 100);
  s = Math.min(1, s + 0.15);
  const [nr, ng, nb] = _hslToRgb(h, s, l);
  return `rgba(${nr}, ${ng}, ${nb}, ${alpha})`;
}

function _parseColor(c) {
  if (typeof c !== 'string') return [255, 255, 255];
  if (c[0] === '#') {
    const hex = c.slice(1);
    const n = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return [255, 255, 255];
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function _hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [Math.round(hue2rgb(p, q, h + 1 / 3) * 255), Math.round(hue2rgb(p, q, h) * 255), Math.round(hue2rgb(p, q, h - 1 / 3) * 255)];
}
