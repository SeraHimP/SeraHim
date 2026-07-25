import { CONFIG } from './Config.js';

/**
 * waveComposition.js
 * 对战模式「出兵编排」的唯一真源。
 *
 * 编排规则本身存在 CONFIG.gameRules.laneWaveComposition（数组顺序 = 出兵顺序），
 * 这里只放"把规则展开成一波的兵种序列"的那段纯函数逻辑。
 *
 * 为什么单独抽出来：模板编辑器的「出兵顺序」面板要做实时预览（"第 N 波会出什么"），
 * 如果在 UI 里另抄一份同样的筛选逻辑，两份实现迟早会漂移，预览就会骗人。
 * LaneWaveSystem 与编辑器共用本函数，预览与真实出兵天然一致。
 */

/** 单条规则的字段说明（供 UI 生成表单，避免 UI 里再硬编码一份字段表） */
export const RULE_FIELDS = {
  count:    { label: '数量',       min: 0, step: 1, def: 1 },
  fromWave: { label: '起始波次',   min: 0, step: 1, def: 0 },
  everyN:   { label: '每几波一次', min: 1, step: 1, def: 1 },
};

/** when 字段的取值：不填 = 总是 */
export const WHEN_OPTIONS = [
  { value: '',            label: '总是' },
  { value: 'nexusDown',   label: '仅本路水晶已陷落' },
  { value: '!nexusDown',  label: '仅本路水晶未陷落' },
];

/**
 * 展开某一波的出兵序列。
 * @param {number} waveNumber 当前波次
 * @param {boolean} nexusDown 该路水晶是否已被摧毁
 * @param {object} [rules] 覆盖用的 gameRules（默认读 CONFIG.gameRules），编辑器预览未应用的改动时会传
 * @returns {string[]} 兵种类型按出场先后排列
 */
export function buildWaveOrder(waveNumber, nexusDown, rules = CONFIG.gameRules) {
  const EN = rules.spawnEnabled || {};
  const on = (t) => EN[t] !== false;
  const order = [];
  for (const rule of (rules.laneWaveComposition || [])) {
    if (!rule || !rule.type || !on(rule.type)) continue;
    if (rule.when === 'nexusDown' && !nexusDown) continue;
    if (rule.when === '!nexusDown' && nexusDown) continue;
    const from = rule.fromWave ?? 0, every = Math.max(1, rule.everyN ?? 1);
    if (waveNumber < from) continue;
    if ((waveNumber - from) % every !== 0) continue;
    const n = Math.max(0, Math.floor(rule.count ?? 1));
    for (let k = 0; k < n; k++) order.push(rule.type);
  }
  return order;
}
