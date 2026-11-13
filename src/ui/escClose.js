/**
 * escClose.js —— 按 Esc 关闭最上层的弹窗。
 *
 * Q1 UI 审查发现：所有弹窗都只能点按钮关，Esc 没有任何反应。
 * 做法不是给每个弹窗各接一份键盘事件（那样新弹窗又会漏），而是统一找"最上层那个打开着的
 * .modal-overlay"，点它自己的取消/关闭按钮——走的是弹窗原有的关闭逻辑（含设置窗口的快照回滚），
 * 不另写一条关闭路径。
 */
// 按优先级：先找子对话框（JSON 框、导入框、画线）自己的取消，再找整个窗口的取消/关闭
const CLOSE_SELECTORS = [
  '#jsonBoxCancel', '#mapEditorImgImportCancelBtn', '#mapEditorPolylineCancel',
  '.stat-doc-close', '.wx-detail-close', '.wd-detail-close', '#detailCloseBtn',
  '#dlgCancelBtn', '#uadCancelBtn', '#templateCloseBtn', '#editorCloseBtn', '#modeCloseBtn',
  '#mapEditorCloseBtn', '#mbtClose',
];

const visible = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';

/** 最上层的打开着的弹窗遮罩（z-index 最高；相同时取 DOM 里靠后的）。 */
export function topOverlay(doc = document) {
  let best = null, bestZ = -Infinity;
  for (const o of doc.querySelectorAll('.modal-overlay')) {
    if (!o.classList.contains('open') || !visible(o.firstElementChild || o)) continue;
    const z = parseInt(getComputedStyle(o).zIndex, 10) || 0;
    if (z >= bestZ) { best = o; bestZ = z; }
  }
  return best;
}

/** 在指定遮罩里找关闭按钮。 */
export function closeButtonIn(overlay) {
  for (const sel of CLOSE_SELECTORS) {
    const b = overlay.querySelector(sel);
    if (b && visible(b)) return b;
  }
  return null;
}

export function installEscClose(doc = document) {
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const ov = topOverlay(doc);
    if (!ov) return;
    const btn = closeButtonIn(ov);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });
}
