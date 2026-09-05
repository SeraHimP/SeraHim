/**
 * dialogShell.js —— 所有弹窗共用的**外壳**（v43 Q1）
 *
 * ==================== 为什么要有这个文件 ====================
 * 用户："所有窗口UI都统一为新版的模板编辑器样式（左侧栏那种的）。"
 * 改动前每个弹窗各自拼一套壳：设置面板是横排页签、天气面板是一长条滚动、
 * 添加单位是两层横排页签、详情框干脆只有一个 modal-box。同一个应用里四种导航语言，
 * "我现在在哪一页"每换一个窗口就要重新学一次。
 *
 * 模板编辑器那套（左侧纵向导航树 + 右侧单页内容）已经被验证是这堆内容里最清楚的，
 * 所以把它的骨架抽到这里，其余弹窗直接套用。**只抽骨架不抽内容** ——
 * 每个弹窗的正文渲染函数一行不动，改的只是"它被摆在哪个容器里"。
 *
 * ==================== 骨架长什么样 ====================
 *   .modal-overlay.open
 *     └ .modal-box
 *        └ .editor-container
 *           ├ h4          标题
 *           └ .tpl-layout
 *              ├ .tpl-nav    左侧导航（分组 → 条目）
 *              └ .tpl-pane   右侧内容（面包屑 + 正文 + 页脚）
 * 类名沿用模板编辑器已有的那几个（index.html 里已有样式），不新增 CSS ——
 * 新增一套并行样式就是下一次"两边慢慢长歪"。
 *
 * ==================== 不做什么 ====================
 * 不接管事件绑定：各弹窗的事件逻辑差异极大（有的即点即生效、有的要"应用"按钮），
 * 强行统一只会把 if 堆到这里。这里只提供 bindNav 这一个共性动作。
 */

/**
 * 只拼「左侧栏 + 右侧单页」这一块（.tpl-layout）。
 *
 * 为什么要单独有它：本项目的弹窗分两类 ——
 *   · 有的自带 overlay（详情框、天气面板），需要完整外框；
 *   · 有的是往 index.html 里那个共用的 `#modalBody` 里塞内容（设置、模式、添加单位），
 *     外框已经存在，只需要这一块。
 * 两类共用同一份导航渲染，样式才不会慢慢长歪。
 *
 * @param {Array}  o.groups     [{ title, items: [{ key, label, badge?, child? }] }]，空数组 = 不要左侧栏
 * @param {string} o.activeKey  当前选中的条目 key
 * @param {string} [o.crumb]    右侧面包屑（不传则取选中条目的 label）
 * @param {string} o.body       右侧正文 HTML
 * @param {string} [o.footer]   右侧底部区
 * @param {string} [o.note]     面包屑下面那行小字
 * @param {string} [o.navAttr]  导航按钮上的 data 属性名，默认 'shellnav'
 */
export function paneHtml({ groups = [], activeKey, crumb, body, footer = '', note = '', navAttr = 'shellnav' }) {
  let nav = '';
  let autoCrumb = '';
  for (const g of groups) {
    nav += `<div class="tpl-nav-group">${g.title ? `<div class="tpl-nav-title">${g.title}</div>` : ''}`;
    for (const it of (g.items || [])) {
      const on = it.key === activeKey;
      if (on) autoCrumb = it.label;
      nav += `<button class="tpl-nav-item${it.child ? ' child' : ''}${on ? ' active' : ''}" data-${navAttr}="${it.key}">`
           + `${it.label}${it.badge ? ` <span class="tpl-nav-badge">${it.badge}</span>` : ''}</button>`;
    }
    nav += `</div>`;
  }
  // 没有分组 = 单页弹窗（详情框）。只套用同一套外框与配色，**不摆一个只有一项的侧边栏**
  // —— 那种侧边栏是纯装饰，反而比没有更糟。
  const hasNav = groups.length > 0;
  const shown = crumb !== undefined ? crumb : autoCrumb;
  const pane = `<div class="tpl-pane">
      ${shown ? `<div class="tpl-pane-head"><span class="tpl-crumb">${shown}</span></div>` : ''}
      ${note ? `<div class="tpl-scope-note">${note}</div>` : ''}
      ${body}
      ${footer}
    </div>`;
  return hasNav ? `<div class="tpl-layout"><div class="tpl-nav">${nav}</div>${pane}</div>` : pane;
}

/**
 * 拼出**完整**弹窗外壳的 innerHTML（自带 overlay 的弹窗用）。
 * 参数同 paneHtml，另加 title / width。
 *
 * ==================== v51.6：无侧边栏的弹窗改成自适应内容宽高 ====================
 * 用户："点开的描述窗口可以自适应大小。但是要有最小尺寸。因为看图片，内容很少但是
 * 窗口很大。"——原来 .modal-box 写死 `width: 92%`，不管内容是一整套带侧边栏的
 * 编辑器页面、还是一句话的技能说明，都撑到（几乎）同一个宽度。
 *
 * 判据直接借用 paneHtml 已经算过的 hasNav：**没有侧边栏**（groups 为空，技能详情/
 * 效果详情/属性说明/天气详情/世界详情这类单页弹窗都是这个形状）就该"多少内容占多少
 * 宽"，加 .compact 类走自适应；**有侧边栏**（模板编辑器、单位编辑器那种左侧导航+
 * 右侧多页内容）版面本来就需要固定宽度撑开两栏布局，维持原样不动。
 * 不需要每个调用点各自传一个新参数——是不是"单页小弹窗"这件事，hasNav 已经知道。
 */
export function shellHtml(o) {
  const { title, width = '880px', groups = [] } = o;
  const compact = groups.length === 0 ? ' compact' : '';
  return `<div class="modal-box${compact}" style="max-width:${width};">
      <div class="editor-container">
        <h4>${title}</h4>
        ${paneHtml(o)}
      </div>
    </div>`;
}

/** 给左侧导航条目绑点击。onSelect(key) 由调用方负责重绘。 */
export function bindNav(root, onSelect) {
  root.querySelectorAll('[data-shellnav]').forEach(b =>
    b.addEventListener('click', () => onSelect(b.dataset.shellnav)));
}

/** 建一个（或复用）overlay 元素，套上统一 class。 */
export function ensureOverlay(id) {
  let el = document.getElementById(id);
  if (el) el.remove();
  el = document.createElement('div');
  el.id = id;
  el.className = 'modal-overlay open';
  return el;
}
