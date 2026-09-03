/**
 * navgrid.js —— navgrid（可行走位图）的编解码 + 笔刷纯函数
 *
 * 地图编辑器阶段三（见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.2）的底层模块。
 * 全部是不依赖 DOM/canvas 的纯函数，可以在无头 Node 里直接跑单元测试——
 * 画布/笔刷交互是上面一层的事，这里只管"格子数据怎么读写"。
 *
 * ==================== 与现有格式的关系 ====================
 * `unpackBits` 与 `MapSystem._navgrid()` 原来内联的解码逻辑逐位相同（那段代码现在
 * 改成调用这里，不再自己写一份）——LSB 优先、按行、8 格一字节，
 * `src/data/maps/sr_navgrid.js` 里手工生产的三张图都是这个格式，不能改动这份逻辑，
 * 否则已有的三张地图会读出乱码地形。
 *
 * `packBits` 是 `unpackBits` 的逆运算：编辑器画完地形后用它序列化回同一种 base64
 * 字符串，格式上与 `map_navgrids.js` 头注描述的 Python 离线流程产出的数据完全兼容
 * ——今后要重新离线描图，或者把编辑器画好的地图倒出来给人工精修，两条路都能读同一份格式。
 */

/** base64 编解码：优先用浏览器全局 atob/btoa，退回 Node 的 Buffer。都没有就返回 null。 */
function b64decode(s) {
  if (typeof atob === 'function') return atob(s);
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('binary');
  return null;
}
function b64encode(s) {
  if (typeof btoa === 'function') return btoa(s);
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'binary').toString('base64');
  return null;
}

/**
 * base64 位图 → Uint8Array（每格 0/1，长度 n*n）。
 * 解不出来（缺 base64 支持）返回 null，调用方按"没有 navgrid"处理，不炸。
 */
export function unpackBits(base64, n) {
  const bin = b64decode(base64);
  if (bin == null) return null;
  const bits = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) bits[k] = (bin.charCodeAt(k >> 3) >> (k & 7)) & 1;
  return bits;
}

/**
 * Uint8Array（每格 0/1）→ base64 位图，`unpackBits` 的逆运算。
 * 输入长度不要求是 8 的倍数——末尾不足一字节的部分按 0 补齐（与"未声明=不可走"
 * 的默认语义一致，不会把边角意外读成可走）。
 */
export function packBits(bits) {
  const numBytes = Math.ceil(bits.length / 8);
  const bytes = new Uint8Array(numBytes);
  for (let k = 0; k < bits.length; k++) {
    if (bits[k]) bytes[k >> 3] |= (1 << (k & 7));
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return b64encode(bin);
}

/**
 * 新地图该用多大的 navgrid 分辨率（§3.2 已确认：自适应，不再固定 256）。
 * 按"每格代表的实际距离"这个软编码常量反算格子数，夹在 [minN, maxN]。
 * 已有的三张内置地图声明了自己的 navgrid（n=256），不受这条公式影响——
 * 这个函数只在【编辑器新建地图】时用，不会反过来改写手工指定的 navgrid。
 */
export function resolveGridN(worldW, worldH, cellSize, minN, maxN) {
  const cs = Math.max(1, cellSize || 14);
  const n = Math.round(Math.max(worldW, worldH) / cs);
  return Math.max(minN || 128, Math.min(maxN || 512, n));
}

/**
 * 笔刷：把 (cx, cy) 为圆心、半径 r（都是【格子】单位，不是世界单位——调用方按
 * cellSize 换算）的圆形区域整体设成 value（1=可走/0=不可走）。原地修改 bits，
 * 同时把它返回，方便链式调用。
 * 越界的格子自动裁掉，不用调用方先算好边界。
 */
export function paintCircle(bits, n, cx, cy, r, value) {
  const v = value ? 1 : 0;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(n - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(n - 1, Math.ceil(cy + r));
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const dx = gx + 0.5 - cx, dy = gy + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) bits[gy * n + gx] = v;
    }
  }
  return bits;
}

/**
 * 笔刷：折线模式（造墙用，见设计报告 §3.3）——沿一串路径点、按线宽展开成一条带状
 * 区域，整体设成 value。points 是【格子】坐标 `[{x,y}, ...]`（至少 2 个点），
 * halfWidth 同样是格子单位。实现上是逐段对线段做"到线段距离 ≤ halfWidth"判定，
 * 不是简单地把每个端点画个圆再连起来（那样在拐角处会有缺口或过粗的接缝）。
 */
export function paintPolyline(bits, n, points, halfWidth, value) {
  if (!points || points.length < 2) return bits;
  const v = value ? 1 : 0;
  const hw2 = halfWidth * halfWidth;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, ay = points[i].y, bx = points[i + 1].x, by = points[i + 1].y;
    const vx = bx - ax, vy = by - ay;
    const segLen2 = vx * vx + vy * vy || 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - halfWidth));
    const x1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx) + halfWidth));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - halfWidth));
    const y1 = Math.min(n - 1, Math.ceil(Math.max(ay, by) + halfWidth));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const px = gx + 0.5 - ax, py = gy + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / segLen2));
        const ddx = px - t * vx, ddy = py - t * vy;
        if (ddx * ddx + ddy * ddy <= hw2) bits[gy * n + gx] = v;
      }
    }
  }
  return bits;
}
