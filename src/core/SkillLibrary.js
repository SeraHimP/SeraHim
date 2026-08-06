/**
 * SkillLibrary.js ? plugin-based skill registry.
 *
 * To add a new skill:
 *   1. Define it in the appropriate core/skills/ file.
 *   2. Register it with SkillLibrary.register(id, def).
 *   3. Done ? no other files need to change.
 *
 * Reading: SkillLibrary['weapon_piercing']  or  SkillLibrary.get('weapon_piercing')
 * Listing: Object.keys(SkillLibrary)
 */
import { renderSkillDescription, setSkillLookup } from './skills/_helpers.js';
import { core } from './skills/core.js';
import { weapons } from './skills/weapons.js';
import { towerPassives, TowerGrowthSkills, HomeAuraSkill } from './skills/towerPassives.js';
import { minionPassives } from './skills/minionPassives.js';
import { dragonSouls } from './skills/dragonSouls.js';

export const SkillLibrary = {
  _registry: new Map(),

  /**
   * @param {string} id @param {object} def
   * 覆盖同名时告警——内置技能重名基本都是笔误。但自制技能（def._isCustom）
   * 每次保存/导入存档都会重新注册一遍，那是**正常路径**，不该刷告警。
   */
  register(id, def) {
    if (this._registry.has(id) && !def?._isCustom) console.warn('SkillLibrary: overwriting "' + id + '"');
    this._registry.set(id, def);
    this[id] = def; // backward-compat property access
    return this;
  },
  get(id) { return this._registry.get(id); },
  has(id) { return this._registry.has(id); },
  ids() { return [...this._registry.keys()]; },
};

// Register all built-in skills
const allSkills = { ...core, ...weapons, ...towerPassives, ...TowerGrowthSkills,
  ...HomeAuraSkill, ...minionPassives, ...dragonSouls };
for (const [id, def] of Object.entries(allSkills)) {
  SkillLibrary.register(id, def);
}

// 身份技能的合并文案要现查子技能——此处回填延迟绑定的查表函数（直接 import 会成环）
setSkillLookup((id) => SkillLibrary.get(id));

// ==================== Q3：技能文案格式统一（用户定稿，同步写进设计文档）====================
// 统一格式：「唯一被动——名称：描述」。
// 在【注册这一处】统一补前缀，而不是去改四十来个字符串——后者只能保证"改的这一刻是齐的"，
// 以后任何人加技能都可能再写歪。这里做成注册期规范化，新技能自动合规。
// 已经带前缀的（含身份技能拼出来的合并文案）原样不动，避免叠成"唯一被动——X：唯一被动——Y："。
const _PREFIX = /^唯一被动——/;
for (const id of SkillLibrary.ids()) {
  const def = SkillLibrary.get(id);
  if (!def || !def.name) continue;
  for (const key of ['description', 'descTemplate']) {
    let raw;
    try { raw = def[key]; } catch (e) { continue; }
    const d = Object.getOwnPropertyDescriptor(def, key);
    // ==================== v43：getter 也要规范化 ====================
    // 这里原本是 `if (d && d.get) continue;`，理由写的是"getter 定义的（合并文案/
    // 光环文案）已经带前缀"。那个假设在 v43 当场失效：八条龙魂改成用 getter
    // 现读 CONFIG（这样编辑器改数值文案立刻跟上），而它们的 description 没带前缀，
    // 于是 9 条技能一起从格式检查里漏了出去 —— 注释宣称的"注册期规范化，新技能自动合规"
    // 对 getter 型技能根本不成立。
    // 改法：getter 就地包一层，**在读取时**判前缀。已经带前缀的（合并文案/光环文案）
    // 走进包装后原样返回，不会叠成"唯一被动——X：唯一被动——Y："。
    if (d && d.get) {
      const orig = d.get;
      Object.defineProperty(def, key, {
        configurable: true, enumerable: d.enumerable,
        get() {
          const v = orig.call(this);
          if (typeof v !== 'string' || !v || _PREFIX.test(v)) return v;
          return `唯一被动——${this.name}：${v}`;
        },
      });
      continue;
    }
    if (typeof raw !== 'string' || !raw || _PREFIX.test(raw)) continue;
    def[key] = `唯一被动——${def.name}：${raw}`;
  }
}

export { renderSkillDescription };
