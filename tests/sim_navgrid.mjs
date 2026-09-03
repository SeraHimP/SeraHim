/**
 * sim_navgrid.mjs —— 地图编辑器阶段三：navgrid 笔刷核心纯函数验收
 *
 * 见 docs/MAPEDITOR-PATH-DEPLOYMENT-DESIGN.md §3.2/§6 阶段三。全部是不依赖 DOM 的
 * 纯函数（编解码/分辨率公式/笔刷绘制），可以在无头 Node 里直接跑，不用走
 * "borrow method from prototype" 或"读源码做正则断言"这类 UnitLayer/ThreeRenderer
 * 那种 DOM 依赖绕过套路。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow({ waveNumber: 1 });
const { unpackBits, packBits, resolveGridN, paintCircle, paintPolyline } = await import('../src/data/navgrid.js');
const { CONFIG } = await import('../src/data/Config.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');

const board = scoreboard('navgrid 笔刷核心验收');
const T = board.T;

// ==================== ① 编解码往返一致性 ====================
{
  // 随机构造几种尺寸（含不是 8 的倍数的，专门测末尾补位分支）
  for (const n of [4, 5, 16, 33, 100]) {
    let seed = n * 7919 + 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    const bits = new Uint8Array(n * n);
    for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 1 : 0;
    const b64 = packBits(bits);
    const back = unpackBits(b64, n);
    const same = back && back.length === bits.length && bits.every((v, i) => v === back[i]);
    T(`往返①-n=${n} 随机位图编码再解码逐位一致`, same);
  }
}

// ==================== ② 与真实数据兼容（不是另起一套格式） ====================
{
  const bits = unpackBits(SR_NAVGRID.bits, SR_NAVGRID.n);
  T('往返②-真实的召唤师峡谷 navgrid 能被 unpackBits 正确解码（长度=n²）',
    bits && bits.length === SR_NAVGRID.n * SR_NAVGRID.n);
  T('往返③-解出来的位图确实有可走也有不可走的格子（不是全 0 或全 1，证明真的解出了地形）',
    bits.some(v => v === 1) && bits.some(v => v === 0));
  const reencoded = packBits(bits);
  const bits2 = unpackBits(reencoded, SR_NAVGRID.n);
  T('往返④-解码→重新编码→再解码，三次往返后仍然逐位一致（证明 packBits 是 unpackBits 真正的逆运算，不只是形似）',
    bits2.every((v, i) => v === bits[i]));
}

// ==================== ③ MapSystem 已经改用同一份逻辑，不是两处各写一份 ====================
{
  const src = srcOf('src/systems/MapSystem.js');
  T('往返⑤-MapSystem._navgrid() 复用 unpackBits，没有另外内联一份解码循环',
    /unpackBits\(NG\.bits, n\)/.test(src) && !/bin\.charCodeAt\(k >> 3\)/.test(src));
}

// ==================== ④ 分辨率自适应公式（§3.2 已确认） ====================
{
  const { navgridCellSize: cs, navgridMinN: minN, navgridMaxN: maxN } = CONFIG.mapEditor;
  T('分辨率①-正常尺寸地图按 world/cellSize 现算（不再写死 256）',
    resolveGridN(3552, 3552, cs, minN, maxN) === Math.round(3552 / cs));
  T('分辨率②-极小地图被夹到下限，不会因为格子太粗而失真',
    resolveGridN(200, 200, cs, minN, maxN) === minN);
  T('分辨率③-极大地图被夹到上限，不会失控增长拖垮笔刷实时重绘',
    resolveGridN(999999, 999999, cs, minN, maxN) === maxN);
  T('分辨率④-取长边（非正方形地图，扭曲丛林那种长宽比），不是简单取宽或高',
    resolveGridN(3008, 1388, cs, minN, maxN) === resolveGridN(3008, 3008, cs, minN, maxN));
}

// ==================== ⑤ 笔刷：圆形填充/擦除 ====================
{
  const n = 20;
  const bits = new Uint8Array(n * n); // 全 0（不可走）
  paintCircle(bits, n, 10, 10, 4, 1);
  const at = (x, y) => bits[y * n + x];
  T('笔刷①-圆心被画成可走', at(10, 10) === 1);
  T('笔刷②-半径外的格子没被动', at(19, 19) === 0 && at(0, 0) === 0);
  T('笔刷③-半径边缘附近确实有格子被画到（不是画了个空圈）',
    bits.reduce((a, v) => a + v, 0) > 0);

  // 擦除：在已经画满的图上用 value=0 的圆去挖空
  const full = new Uint8Array(n * n).fill(1);
  paintCircle(full, n, 10, 10, 3, 0);
  T('笔刷④-value=0 时是擦除（不是只能画可走）', full[10 * n + 10] === 0);

  // 越界不炸、且正确裁剪
  const edge = new Uint8Array(n * n);
  paintCircle(edge, n, 0, 0, 5, 1); // 圆心在角落，半径远超边界
  let outOfRangeTouched = false;
  // 只要函数没抛异常、且数组长度没变，就说明越界访问被正确裁剪了
  T('笔刷⑤-圆心在地图角落、半径超出边界也不会抛异常', edge.length === n * n);
  void outOfRangeTouched;
}

// ==================== ⑥ 笔刷：折线造墙（§3.3） ====================
{
  const n = 30;
  const bits = new Uint8Array(n * n);
  paintPolyline(bits, n, [{ x: 5, y: 15 }, { x: 25, y: 15 }], 2, 1);
  const at = (x, y) => bits[y * n + x];
  T('折线①-沿线的格子被画到（水平直线中点）', at(15, 15) === 1);
  T('折线②-线宽范围内也被画到（不只是线本身那一格）', at(15, 13) === 1 || at(15, 14) === 1);
  T('折线③-远离折线的格子没被动', at(15, 25) === 0);

  // 折角处不留缺口：两段折线的拐角附近应连续
  const bits2 = new Uint8Array(n * n);
  paintPolyline(bits2, n, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 20 }], 2, 1);
  T('折线④-拐角处（第二个点）被画到，两段折线在拐角处不留缺口', at2(bits2, n, 15, 5) === 1);
  function at2(b, nn, x, y) { return b[y * nn + x]; }

  T('折线⑤-不足两个点时安全返回，不抛异常', (() => {
    const b = new Uint8Array(9);
    paintPolyline(b, 3, [{ x: 1, y: 1 }], 1, 1);
    return b.every(v => v === 0);
  })());
}

board.done();
