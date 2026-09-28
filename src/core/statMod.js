import { CONFIG } from '../data/Config.js';

/**
 * statMod.js —— 把配置里的「属性名: 数值」翻译成效果系统要的 { statKey, flat, percent }
 *
 * ==================== 这个文件是为了修一个静默 bug 才有的 ====================
 * 原来 dragonPowerBuffs（巨龙之力）与 soulStatBlueprints（龙魂常驻数值）**各写了一份**
 * 同样的约定：「键名以 Pct 结尾 → 按百分比，并把 Pct 去掉当属性名」。
 *
 * 这条约定对 `attackDamagePct`、`maxHPPct` 是对的（attackDamage / maxHP 是真属性，
 * Pct 表示"按它的百分比加"）。但对**本身就以 Pct 结尾的属性**是灾难：
 *     damageAmpPct → damageAmp     ← 不存在
 *     lifeStealPct → lifeSteal     ← 不存在
 *     bonusAttackSpeedPct → bonusAttackSpeed  ← 不存在
 *     healShieldPowerPct → healShieldPower    ← 不存在
 * 而 AttributeCalculator 对"baseStats 里没有的键"是**静默丢弃**的
 *（`if (stats[key] === undefined) continue;`），所以这四项一声不响地全没生效。
 *
 * 后果是实打实的：
 *   · **暗之力两项全丢 = 完全没有效果**。平衡对照里那一档与基线**逐字相同**
 *     （胜率/时长/推塔/推进度/熵一个字都不差）—— 和当年光魂那个死功能一模一样的形状。
 *   · **风魂的攻速加成从来没生效过** —— 而我上一轮正是围绕"攻速"重做的风，
 *     难怪测出来没改善。我当时把锅算在了设计方向上，其实是这一项根本没接上。
 *   · 潮龙的治疗与护盾强度、暗魂的常驻数值同样一直是空转。
 *
 * ==================== 正确的判据 ====================
 * 不看后缀，看**这个键本身是不是一个真属性**：
 *   ① key 本身是属性        → 按**固定值**加（damageAmpPct 就是这一类：
 *                              它是个"百分比数值的属性"，+2.5 表示增幅从 x% 变 (x+2.5)%）
 *   ② key 去掉 Pct 后是属性 → 按**百分比**加（attackDamagePct = 攻击力 +3%）
 *   ③ 两者都不是            → 原样当固定值返回，并在开发期打一条警告。
 *      静默丢弃是这次的病根，所以**不再静默** —— 拼错属性名必须能被发现。
 */

let _known = null;
/** 全部模板里出现过的属性名。取并集而不是只看 tower：各兵种模板字段不完全一样。 */
function knownStats() {
  if (_known) return _known;
  _known = new Set();
  for (const tpl of Object.values(CONFIG.templates || {})) {
    if (tpl && typeof tpl === 'object') for (const k of Object.keys(tpl)) _known.add(k);
  }
  return _known;
}
/** 测试/编辑器改过模板之后可以让它重算（正常运行时不需要调）。 */
export function resetStatKeyCache() { _known = null; }

const _warned = new Set();

/**
 * @param {string} key   配置里的键名
 * @param {number} value 数值
 * @returns {{ statKey: string, flat: number, percent: number }}
 */
export function statMod(key, value) {
  const known = knownStats();
  if (known.has(key)) return { statKey: key, flat: value, percent: 0 };
  if (key.endsWith('Pct')) {
    const base = key.slice(0, -3);
    if (known.has(base)) return { statKey: base, flat: 0, percent: value };
  }
  if (!_warned.has(key)) {
    _warned.add(key);
    console.warn(`[statMod] 未知属性名「${key}」—— 它不会被任何单位读到（拼错了？）。`
               + '静默丢弃正是暗之力整档失效的原因，所以这里必须出声。');
  }
  return { statKey: key, flat: value, percent: 0 };
}
