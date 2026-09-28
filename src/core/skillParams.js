/**
 * skillParams.js —— 技能参数（`instance._params`）的**唯一**解析口（v43 P0-②）
 *
 * ==================== 为什么要抽出来 ====================
 * 这份解析逻辑原本长在 `CombatSystem.update` 的 onFrame 循环里，也就是说
 * **参数是在这个实例的第一帧才被灌进去的**。任何在 `onEquip` 里读参数的技能，
 * 拿到的都是 `undefined` 或技能的出厂值。
 *
 * 这个时序已经咬过两次，两次都花了很久才找到：
 *   ① 屠戮（`passive_*_rend`）：用户报"技能介绍还是没变"。它只有 onHit，
 *      而旧代码把参数解析嵌在 `if (def.onFrame)` 里面 —— 没有 onFrame 的技能
 *      **永远拿不到覆写**。表面症状是"改了地图配置没反应"。
 *   ② 加固城防的生命恢复：onEquip 里读 `instance._params.regen`，
 *      拿到的是工厂默认值，地图级覆写要等到第一帧才生效 —— 于是塔出生后的
 *      第一帧内按错误的恢复值跑，且如果那个技能压根没有 onFrame 就永远是错的。
 *
 * 两次的根因是同一个：**参数解析的时机比"技能开始工作"的时机晚**。
 * 现在改成：装备的那一刻就解析一次（`resolveSkillParams`），onFrame 每帧只做
 * "覆写层变了就跟上"的刷新。onEquip 因此总能读到正确的值。
 *
 * ==================== 叠加顺序（后者覆盖前者）====================
 *   ① def.defaultParams              技能出厂值
 *   ② CONFIG.skillOverrides[id]      **全局**用户覆写（编辑器可改、可存档）
 *   ③ 地图 skillOverrides[键][id]    地图级覆写（最具体，压过全局）
 * ②③ 的分工对应用户提的那条："同一技能在不同地图上可能表现为数值/机制不同"
 * —— 全局定基准，地图按需改写。
 *
 * 地图级的"键"按实体形态取：建筑用 `tower:<层级>`，其余用实体 type。
 */
import { CONFIG } from '../data/Config.js';
import { SkillLibrary } from './SkillLibrary.js';

/** 地图级覆写的查找键：建筑按层级、其余按类型。 */
export function mapOverrideKey(entity) {
  if (!entity) return null;
  return entity._mapTier ? 'tower:' + entity._mapTier : entity.type;
}

/**
 * 把三层覆写解析进 `inst._params`（就地改，返回同一个 inst）。
 *
 * @param {object} inst    技能实例 { skillId, state, _params? }
 * @param {object} entity  持有者（用于取地图级覆写的键）
 * @param {object} [lib]   技能库，缺省用全局 SkillLibrary（单测可注入）
 */
export function resolveSkillParams(inst, entity, lib = SkillLibrary) {
  if (!inst || !inst.skillId) return inst;
  const def = lib && lib[inst.skillId];
  if (!def) return inst;

  const globalOv = CONFIG.skillOverrides && CONFIG.skillOverrides[inst.skillId];
  // 注意：不能写成"只有 def.defaultParams 存在时才建 _params"。
  // 那样一来没声明 defaultParams 的技能永远拿不到覆写（改了没反应）——
  // 只要任一覆写层有东西，就得把 _params 建出来。
  if (!inst._params && (def.defaultParams || globalOv)) {
    inst._params = { ...(def.defaultParams || {}) };
  }
  if (!inst._params) return inst;

  if (globalOv) Object.assign(inst._params, globalOv);
  const mapOv = lib && lib._mapOverrides;
  if (mapOv) {
    const key = mapOverrideKey(entity);
    const ov = key && mapOv[key] && mapOv[key][inst.skillId];
    if (ov) Object.assign(inst._params, ov);
  }
  return inst;
}

/**
 * 装备一个技能的**唯一**入口：建实例 → 解析参数 → 调 onEquip。
 * 顺序是这个函数存在的全部理由 —— onEquip 必须在参数解析【之后】跑。
 *
 * @returns {object} 新建的技能实例（已 push 进 entity._skillInstances）
 */
export function equipSkill(entity, skillId, ctx, lib = SkillLibrary) {
  if (!entity) return null;
  entity._skillInstances = entity._skillInstances || [];
  const inst = { id: nextInstId(), skillId, state: {} };
  entity._skillInstances.push(inst);
  resolveSkillParams(inst, entity, lib);          // ← 必须在 onEquip 之前
  const def = lib && lib[skillId];
  if (def && def.onEquip) def.onEquip(entity.id, inst, ctx);
  return inst;
}

// 实例 id：优先沿用全局计数器（main.js 的 CTX._uid），拿不到就自己数。
// 单测里没有 window.CTX，走本地计数器即可 —— id 只要在一局内唯一。
let _local = 0;
function nextInstId() {
  const ctx = (typeof window !== 'undefined') && window.CTX;
  if (ctx && typeof ctx._uid === 'number') return ++ctx._uid;
  return --_local;   // 负数，与全局计数器天然不撞
}
