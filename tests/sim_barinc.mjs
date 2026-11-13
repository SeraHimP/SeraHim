/**
 * sim_barinc.mjs —— v51.28（Q1返工）"增加特效"验收
 *
 * 背景：用户否掉了 v51.27 那版实现（见 src/data/Config.js CONFIG.ui.barIncreasePreview
 * 头注）——旧版只要被动生命/法力恢复 >0（几乎所有单位一直如此）就常驻显示"未来
 * 固定1秒的回复量"，观感很乱，颜色也是固定暖黄，跟血条本身颜色无关。
 *
 * 新规则（barTrail.bigRegenPreviewFrac）：只统计【限时】的 healthRegen/manaRegen
 * 属性效果（remainingTime 有限），算出"剩余时间内一共能回多少"÷上限，达到阈值
 * 才触发；效果剩余时间超过 maxWindowSec 不算"短时间"。颜色由 deriveIncreaseColor
 * 按调用方传入的"该条真实颜色"提亮生成，不再是固定色。
 *
 * 每条断言钉行为形状，不钉具体数字（见 docs/DEVELOPMENT.md §8.2）。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
import { bigRegenPreviewFrac, deriveIncreaseColor } from '../src/presentation/barTrail.js';

setupWindow({ waveNumber: 1 });

const { T, done } = scoreboard('Q1返工-增加特效验收');

// ==================== 一、永久被动回复：不触发（这正是被否掉的旧行为） ====================
{
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: Infinity, totalFlat: 50 },
  ];
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.3, 0.12, 20);
  T('一①-永久生命恢复（remainingTime=Infinity）不触发预告', frac === 0);
}

// ==================== 二、限时但总量太小：不达阈值，不触发 ====================
{
  // 剩余5秒，每秒回5点，总共25点，占1000上限的2.5%，低于12%阈值
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 5, totalFlat: 5 },
  ];
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.3, 0.12, 20);
  T('二①-限时效果但总量占比过小，不触发', frac === 0);
}

// ==================== 三、限时时间太长：不算"短时间"，不触发 ====================
{
  // 剩余30秒（超过 maxWindowSec=20），每秒回50点，总量远超阈值，但时间跨度不算短
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 30, totalFlat: 50 },
  ];
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.3, 0.12, 20);
  T('三①-限时效果剩余时间超过 maxWindowSec，不算短时间，不触发', frac === 0);
}

// ==================== 四、用户举例：10秒内回50%生命值 → 触发，且宽度=50% ====================
{
  const maxHP = 1000;
  // flat=50/s × 10s = 500 = maxHP 的 50%
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 50 },
  ];
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, maxHP, 0.2, 0.12, 20);
  T('四①-10秒内回50%生命值：触发预告', frac > 0);
  T('四②-预告宽度约等于50%（用户举例的具体数字，这里按其原话钉一次）',
    Math.abs(frac - 0.5) < 0.01);

  // 随时间推移：remainingTime 减半时，总量与宽度也应跟着减半（自然收窄，不需要额外状态）
  const halfway = { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 5, totalFlat: 50 };
  const fracHalf = bigRegenPreviewFrac([halfway], 'healthRegen', 1, maxHP, 0.2, 0.12, 20);
  T('四③-剩余时间过半后，预告宽度也跟着收窄（用当前 remainingTime 重算，无需额外状态）',
    fracHalf < frac && fracHalf > 0);
}

// ==================== 五、预告宽度不会超过"到满"的剩余空间 ====================
{
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 200 },
  ];
  // 总量 2000 远超上限 1000，但当前已经 90% 满，预告条最多只能到"满"，即宽度<=0.1
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.9, 0.12, 20);
  T('五①-预告宽度夹到剩余空间以内，不会超过满值', frac <= 0.10001);
}

// ==================== 六、statKey 不匹配 / kind 不是 stat：不计入 ====================
{
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'manaRegen' }, remainingTime: 10, totalFlat: 500 },
    { blueprint: { kind: 'dot', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 500 },
  ];
  const frac = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.3, 0.12, 20);
  T('六①-statKey 不匹配或 kind 不是 stat 的效果不计入总量', frac === 0);
}

// ==================== 七、mult 系数（regenMod×治疗强度）会按比例影响判定 ====================
{
  const effects = [
    { blueprint: { kind: 'stat', statKey: 'healthRegen' }, remainingTime: 10, totalFlat: 50 },
  ];
  const fracNoBoost = bigRegenPreviewFrac(effects, 'healthRegen', 1, 1000, 0.2, 0.12, 20);
  const fracBoosted = bigRegenPreviewFrac(effects, 'healthRegen', 2, 1000, 0.2, 0.12, 20);
  T('七①-治疗强度/回复系数越高，预告的量越大', fracBoosted > fracNoBoost);
}

// ==================== 八、颜色自适应：基于传入的真实颜色生成，且与原色不同（做出区分） ====================
{
  const blue = deriveIncreaseColor('#4a9eff', 32, 0.8);
  const red = deriveIncreaseColor('#ff5a5a', 32, 0.8);
  T('八①-HP蓝色阵营生成的预告色不等于原色（要做出区分）', blue !== '#4a9eff' && !blue.includes('205, 90'));
  T('八②-不同的输入基础色应产出不同的预告色（颜色是"该条自身颜色的自适应"，不是固定色）',
    blue !== red);
  T('八③-不再是旧版固定的暖黄色', !blue.includes('255, 205, 90') && !red.includes('255, 205, 90'));

  // 颜色应保留原色的"色相方向"：蓝色变亮后 blue 分量仍应明显强于 red 分量
  const m = blue.match(/rgba\((\d+), (\d+), (\d+)/);
  T('八④-提亮后仍保留原色相（蓝色阵营预告色里蓝分量强于红分量）',
    !!m && Number(m[3]) > Number(m[1]));
}

// ==================== 九、'#rgb' 三位简写和 'rgba(...)' 输入都能正确解析 ====================
{
  const fromShort = deriveIncreaseColor('#f00', 20, 0.7);
  const fromRgba = deriveIncreaseColor('rgba(255, 0, 0, 1)', 20, 0.7);
  T('九①-三位简写hex与等价的rgba输入应解析出相同的颜色', fromShort === fromRgba);
}

done();
