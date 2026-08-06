/**
 * AttributeEditor —— 属性/模板编辑器的**装配点**（v43 P1-4 起只剩这一件事）
 *
 * ==================== 为什么拆 ====================
 * 这个文件曾经 2919 行、上百个方法，从"点开一座塔看属性"到"编排对战出兵"
 * 到"导入导出模板 JSON"全在一个对象字面量里。找一个方法要靠搜索，
 * 改一页的渲染要在一个跟另外十页混在一起的文件里改。
 *
 * ==================== 拆法 ====================
 * 整个编辑器本来就是**一个对象字面量**，而任意一段连续的顶层条目本身就是
 * 合法的对象字面量体。所以按文件里已有的分节把它切成 7 块，各块方法体
 * 逐字未动、缩进未动，这里用 Object.assign 合回同一个对象。
 *
 * 关键点：合并后仍然是**一个对象**，所以跨块的 `this._renderPage(...)`、
 * `this._applyScope` 这类调用与拆分前完全一致 —— 没有引入任何模块边界。
 * 也正因为如此，各块之间**不允许有重复键**（后合并的会静默覆盖先合并的）；
 * sim_v43 里有一条断言钉住这件事。
 *
 * 合并顺序 = 原文件里的出现顺序，方便与拆分前的源码对照。
 */
import { EDITOR_OPEN } from './editor/open.js';
import { EDITOR_SHELL } from './editor/shell.js';
import { EDITOR_PAGES_CONFIG } from './editor/pagesConfig.js';
import { EDITOR_PAGES_WAVE } from './editor/pagesWave.js';
import { EDITOR_PAGES_ENTITY } from './editor/pagesEntity.js';
import { EDITOR_PAGES_SKILLEFFECT } from './editor/pagesSkillEffect.js';
import { EDITOR_EVENTS } from './editor/events.js';

export const AttributeEditor = Object.assign(
  {},
  EDITOR_OPEN,
  EDITOR_SHELL,
  EDITOR_PAGES_CONFIG,
  EDITOR_PAGES_WAVE,
  EDITOR_PAGES_ENTITY,
  EDITOR_PAGES_SKILLEFFECT,
  EDITOR_EVENTS,
);
