/**
 * reviveState.js —— 「一座建筑复活时要清掉哪些标记」的**唯一**一份清单
 *
 * 用户："我手动恢复损毁的塔，但是模型还是重度损毁的模型，修复。"
 *
 * ==================== 又是同一条规则实现了两遍 ====================
 * 塔的损毁档（_dmgStage）按定稿是**不可逆**的，只会往高走 ——
 * 所以它只有一个复位时机：**这座塔重新活过来**。
 * 而"重新活过来"在本仓库有两条路：
 *   ① MapSystem 的重生队列（召唤水晶到点重生、光魂原地复活）
 *   ② 编辑器运维面板的【设为存活】（_applyOps 的 'revive'）
 * v45 做损毁档时只在 ① 里写了 `delete corpse._dmgStage`，② 完全没跟上：
 * 手动复活的塔血是满的、废墟标记也清了，**只有模型还停在重度损毁**。
 *
 * 本仓库这个形状已经反复出现（攻城模式、重生规则、dragonPowerBuffs、_mapLaneIds……），
 * 每次的修法都一样：抽成一份、两边都调它。抄一份过去的话，
 * 下次再加第三条复活路径（比如将来的"投降重开"），又会漏。
 *
 * 放在 core 而不是 presentation：MapSystem 是系统层，让它去 import 一个
 * 依赖 THREE 的渲染模块，会把 THREE 拖进所有 headless 测试。
 * 这些标记本身只是实体上的普通字段，与渲染无关 —— 渲染层只是**读**它们。
 */

import { CONFIG } from '../data/Config.js';

/**
 * ==================== v45：建筑损毁档（0 完好 / 1 轻度 / 2 重度）====================
 * 用户定稿："每种塔有不同生命节点下的模型，以内塔举例（生命节点为 33/67/100），
 * 67-100 就是正常模型，33-67 为看起来轻度损毁，0-33 看起来重度损毁。"
 * 追加定稿："塔的模型损毁是**不可逆**的，只会从低损毁向高损毁转变。
 * 并且塔手动重生时要恢复零损毁的模型。"
 *
 * 不可逆意味着档位是**历史**，不是当前血量的函数，所以必须由仿真记录：
 * 以前这个"只增不减"写在渲染层（UnitMeshFactory 每画一帧顺手写 e._dmgStage），
 * 于是只有被画出来的帧才会推进档位——标签页在后台、或两帧之间掉血又被奶回，
 * 这座塔就永远不会进重度损毁；headless 下更是完全不存在。
 * 现在 simulation.step() 每步调 recordTowerDamage()，渲染层只读。
 */
function stageFromHp(hpFrac) {
  const c = CONFIG.ui?.towerDamage || {};
  if (c.enabled === false) return 0;
  const nodes = c.nodes || [33, 67];   // [重度上界, 轻度上界]，单位 %
  const pct = Math.max(0, Math.min(1, hpFrac)) * 100;
  return pct < nodes[0] ? 2 : pct < nodes[1] ? 1 : 0;
}

/** 按当前血量推进损毁档（只增不减），返回推进后的档位。仿真层调用。 */
export function towerDamageStage(e, hpFrac) {
  if ((CONFIG.ui?.towerDamage || {}).enabled === false) return 0;
  const prev = e._dmgStage || 0;
  const stage = Math.max(prev, stageFromHp(hpFrac));
  if (stage !== prev) e._dmgStage = stage;
  return stage;
}

/** 仿真每步对所有存活建筑调一次。 */
export function recordTowerDamage(towers) {
  for (const e of towers) towerDamageStage(e, (e.currentHP || 0) / (e.baseStats?.maxHP || 1));
}

/**
 * 渲染层读档位：不写实体。取 max(已记录, 当前血量) 是为了暂停时在编辑器里改血量
 * 也能立刻看到模型变化（仿真没在走，记录还没追上）。
 */
export function displayTowerDamageStage(e, hpFrac) {
  if ((CONFIG.ui?.towerDamage || {}).enabled === false) return 0;
  return Math.max(e._dmgStage || 0, stageFromHp(hpFrac));
}

/**
 * 清掉"这座建筑是坏的"这一类视觉标记。血量/护盾/技能不在此列 ——
 * 那几样各条复活路径的语义不同（重生 33%、手动复活满血），必须由调用方决定。
 *
 * @param e 实体（塔 / 水晶）。传 null 安全。
 */
export function clearDamageMarks(e) {
  if (!e) return;
  delete e._ruin;        // 损毁幽灵（等待重生的水晶用的半透明形态）
  delete e._dmgStage;    // 损毁档 0/1/2（单向递增，只在这里归零）
  // 渲染层不需要额外通知：它每帧按 displayTowerDamageStage(e, hpFrac) 读，
  // _dmgStage 一没了就自然回到 0 档，模型 key 变化触发换模型。
}
