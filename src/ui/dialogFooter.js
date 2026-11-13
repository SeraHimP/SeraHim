/**
 * dialogFooter.js —— 设置类窗口的统一页脚（用户定稿：**应用 / 确定 / 取消**）。
 *
 * 语义（三个按钮各自必须有明确的、不重叠的作用，否则等于摆着好看）：
 *   应用  提交当前改动，**窗口不关**。提交后基线前移 —— 之后点"取消"回到的是这一刻，
 *         而不是刚打开窗口那一刻。调参是"改一点看一眼"的循环，所以这个最常用。
 *   确定  提交 + 关闭。
 *   取消  丢弃**自上次提交以来**的所有改动 + 关闭。
 *
 * 为什么要有快照/回滚，而不是简单地"不提交"：
 * 本项目的画质类开关是**即时预览**的（阴影/泛光/水面点一下立刻能看到效果），
 * 那是它们的价值所在，不该改成"点了没反应、要按应用才生效"。
 * 于是"取消"必须靠快照回滚才有意义 —— 否则你点开设置、乱翻一通、点取消，
 * 改动全留在那儿，取消按钮就是个谎。
 *
 * 用法：窗口自己提供 snapshot()/restore(snap)（它最清楚自己动了哪些状态），
 * 这里只负责按钮、基线管理与事件。
 *
 * 不适用的窗口（刻意不套三按钮，写在这里以免以后有人"补齐"）：
 *   · 纯只读的详情窗（DetailModal）—— 没有可提交的东西，"应用"无意义；
 *   · 动作窗（添加单位）—— 页脚是"建造/加入清单 + 取消"，那是动作不是设置。
 * 判据：**这个窗口有没有"改了但还没生效"的中间态**。有 → 三按钮；没有 → 别硬套。
 */

/**
 * @param {string} containerId 放按钮的容器元素 id（一般是 'modalActions'）
 * @param {object} o
 *   @param {Function} o.snapshot   () => snap    捕获当前可回滚状态
 *   @param {Function} o.restore    (snap) => void 回滚到某个快照
 *   @param {Function} [o.commit]   () => void    提交时的额外动作（写盘/落库/刷新等）
 *   @param {Function} o.close      () => void    关闭窗口
 *   @param {Function} [o.rerender] () => void    回滚后重绘界面（否则界面还显示旧值）
 *   @param {string}  [o.applyLabel] 应用按钮的文字（建议写清提交到哪）
 * @returns {{ baseline: Function }} baseline() 手动把基线前移（例如窗口内部自己提交了）
 */
export function mountDialogFooter(containerId, o) {
  const host = document.getElementById(containerId);
  if (!host) return { baseline: () => {} };

  let base = o.snapshot();

  host.innerHTML = `
    <button id="dlgApplyBtn" title="提交改动，窗口保持打开">✅ ${o.applyLabel || '应用'}</button>
    <button id="dlgOkBtn" class="primary" title="提交改动并关闭">确定</button>
    <button id="dlgCancelBtn" title="放弃自上次提交以来的改动并关闭">取消</button>
  `;

  const commit = () => {
    if (o.commit) o.commit();
    // 基线前移：点过"应用"之后再点"取消"，回到的是这一刻而不是打开那一刻。
    // 不前移的话，"应用 → 再改坏 → 取消"会把已经确认过的那批改动一起吞掉。
    base = o.snapshot();
  };

  host.querySelector('#dlgApplyBtn').addEventListener('click', () => {
    commit();
    if (o.rerender) o.rerender();
  });
  host.querySelector('#dlgOkBtn').addEventListener('click', () => {
    commit();
    o.close();
  });
  host.querySelector('#dlgCancelBtn').addEventListener('click', () => {
    o.restore(base);
    if (o.rerender) o.rerender();
    o.close();
  });

  return { baseline: () => { base = o.snapshot(); } };
}

/**
 * 按"路径列表"自动做快照/回滚的小工具，省得每个窗口手写一遍取值/赋值。
 * 路径写法：'CONFIG.ui.towerLight.enabled' / 'window.__gridOn'。
 * 只做**浅拷贝到叶子**：叶子是对象时整体深拷一份（JSON 往返），因为设置项的叶子
 * 都是纯数据（数字/布尔/字符串/小对象），没有函数与循环引用。
 */
export function makeSnapshotter(roots, paths) {
  const walk = (path) => {
    const seg = path.split('.');
    let obj = roots[seg[0]];
    for (let i = 1; i < seg.length - 1; i++) {
      if (obj == null) return null;
      obj = obj[seg[i]];
    }
    return obj == null ? null : { obj, key: seg[seg.length - 1] };
  };
  return {
    snapshot() {
      const out = {};
      for (const p of paths) {
        const t = walk(p);
        if (!t) continue;
        const v = t.obj[t.key];
        out[p] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      }
      return out;
    },
    restore(snap) {
      for (const p of paths) {
        if (!(p in snap)) continue;
        const t = walk(p);
        if (!t) continue;
        const v = snap[p];
        t.obj[t.key] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      }
    },
  };
}
