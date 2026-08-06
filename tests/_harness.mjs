/**
 * _harness.mjs —— 全部 sim_*.mjs 共用的脚手架（v43 P1-⑥）
 *
 * ==================== 为什么要有它 ====================
 * 46 套用例里，每一套都在开头重复同样四件事：
 *   ① `globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 }`
 *   ② 自己写一遍 `let pass=0, fail=0; const T=(n,c)=>...`
 *   ③ 自己 import 一遍那七八个核心模块
 *   ④ 自己写一遍"读源码 + 剥注释"的辅助
 * 加起来上千行重复，而且 ④ 各写各的 —— **本仓库已经因此栽过五次**：
 * 断言里写 `!src.includes('xxx')`，结果匹配到了自己写在旁边的解释注释，
 * 于是"这个东西已经删掉了"永远为假。最近的两次就在 v43 这一轮
 *（tierExists、破甲），更早还有 getWeights、cooldown|冷却、isLargeMinion。
 *
 * 所以这里最重要的一条不是"省几行 import"，而是：
 *   **srcOf() 默认剥注释**。让正确的做法成为默认，想看注释得显式 srcRaw()。
 */
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../', import.meta.url).pathname;

/**
 * 装好测试用的全局环境。必须在**任何** import 之前调用 ——
 * 很多模块在模块级就读 window（如 CONFIG 的 getter、SkillLibrary 的注册期规范化）。
 */
export function setupWindow(extra = {}) {
  globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {}, ...extra };
  return globalThis.window;
}

/** 计分器。返回 { T, done }：T 记一条断言，done 打印小结并按失败数退出。 */
export function scoreboard(label) {
  let pass = 0, fail = 0;
  const T = (name, cond) => { cond ? pass++ : (fail++, console.log('✗', name)); };
  const done = () => {
    console.log(`${label}: ${pass} 通过 / ${fail} 失败`);
    if (fail > 0) process.exit(1);
  };
  return { T, done, get pass() { return pass; }, get fail() { return fail; } };
}

/**
 * 读源码做断言用。**默认剥掉注释**（块注释 + 行注释）。
 *
 * ⚠️ 这是本模块存在的首要理由。直接读原文做 `!src.includes('已删除的东西')`
 * 这类断言时，源码里"为什么删掉它"的那段说明本身就含有那个名字，
 * 断言于是永远为假 —— 本仓库栽过五次，两次就在 v43 这一轮。
 *
 * 真的需要连注释一起看（例如钉"注释里写清了根因"）时用 srcRaw()。
 */
export function srcOf(rel) {
  return stripComments(srcRaw(rel));
}

/**
 * 读源码原文（含注释）。
 * 路径按**仓库根**解析。历史上各套件是按 tests/ 相对写的（'../src/xxx.js'），
 * 所以这里容忍并剥掉开头的 '../' —— 迁移时不必逐条改路径字符串。
 */
export function srcRaw(rel) {
  return fs.readFileSync(path.join(ROOT, String(rel).replace(/^(\.\.\/)+/, '')), 'utf8');
}

/** 剥掉 JS 注释。字符串里的 // 会被误伤，但断言场景下够用且远比不剥安全。 */
export function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 搭一个最小世界：EventBus + EntityContainer + EffectRegistry + CombatSystem。
 * 需要地图/兵线的用例自己在这之上加，不在这里塞成一个什么都管的大工厂 ——
 * 那样每套用例都要为自己用不上的部分付启动成本。
 */
export async function makeWorld() {
  const { EventBus } = await import('../src/utils/EventBus.js');
  const { EntityContainer } = await import('../src/core/EntityContainer.js');
  const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
  const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
  const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
  const { CombatSystem } = await import('../src/systems/CombatSystem.js');
  const { CONFIG } = await import('../src/data/Config.js');
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
  return { bus, ents, fx, combat, attr: AttributeCalculator, SkillLibrary, CONFIG };
}

/** 造一个实体（模板 + 覆盖字段）。id 自增，自动加进容器。 */
export function mkEntity(ents, type, { faction = null, tier = null, lane = null,
                                       pos = { x: 0, y: 0 }, stats = {}, skills = [] } = {}, CONFIG) {
  const tpl = (CONFIG.templates[type] || CONFIG.templates.tower);
  const e = {
    id: ++window._uid, type, alive: true, pos: { ...pos },
    baseStats: { ...tpl, ...stats },
    currentHP: stats.maxHP ?? tpl.maxHP,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _inCombat: false, _attackerCount: 0,
  };
  if (faction) { e._mapFaction = faction; e.faction = faction; }
  if (tier) e._mapTier = tier;
  if (lane) e._laneId = lane;
  for (const s of skills) e._skillInstances.push({ id: ++window._uid, skillId: s, state: {} });
  ents.add(e);
  return e;
}
