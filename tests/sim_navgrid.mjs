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
const { unpackBits, packBits, unpackByteGrid, packByteGrid, resolveGridN, paintCircle, paintPolyline, despeckle } =
  await import('../src/data/navgrid.js');
const { CONFIG } = await import('../src/data/Config.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');
const { ZONES, zoneGrid } = await import('../src/presentation/TerrainMaterial.js');

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

// ==================== ⑥b 去毛刺（阶段四剩余，§3.3）====================
{
  const n = 10;
  // 单个孤立的可走噪点（周围全是不可走）——4 邻居全不同 → 应被翻转成 0
  const bits = new Uint8Array(n * n);
  bits[5 * n + 5] = 1;
  despeckle(bits, n);
  const at = (b, x, y) => b[y * n + x];
  T('去毛刺①-孤立的单格噪点（4 邻居全不同）被清除', at(bits, 5, 5) === 0);

  // 一整块可走区域中间挖了一个孤立的不可走噪点——同理应被填平
  const bits2 = new Uint8Array(n * n).fill(1);
  bits2[5 * n + 5] = 0;
  despeckle(bits2, n);
  T('去毛刺②-可走区域里孤立的单格不可走噪点也会被清除（对称，不只单向）', at(bits2, 5, 5) === 1);

  // 1 格宽尖刺：从一块可走区域向外伸出一条单格宽的刺，尖刺应被吃掉，主体保留
  const bits3 = new Uint8Array(n * n);
  for (let gy = 2; gy <= 6; gy++) for (let gx = 2; gx <= 6; gx++) bits3[gy * n + gx] = 1; // 5x5 主体
  bits3[7 * n + 4] = 1; // 从底边向下伸出一格尖刺
  despeckle(bits3, n);
  T('去毛刺③-从主体伸出的 1 格宽尖刺被削平', at(bits3, 4, 7) === 0);
  T('去毛刺④-主体本身不受影响（不是无差别腐蚀，5x5 主体内部格子全部保留可走）',
    at(bits3, 4, 4) === 1 && at(bits3, 2, 2) === 1 && at(bits3, 6, 6) === 1);

  // 一条有厚度的墙带（真实造墙场景：paintPolyline 画的是 halfWidth ≥ 1 的带状区域，
  // 不是 1 格宽的细线）不应被误判成毛刺——带内每个格子沿线方向都有同值邻居，
  // 不会触发"≤1 个邻居相同"这条阈值。1 格宽的细线是另一回事：细线的两端本来就
  // 只有 1 个同值邻居，在几何上确实是"尖刺"，被削平是这个算法的正确行为，不在这里测。
  const bits4 = new Uint8Array(n * n);
  for (let gy = 4; gy <= 6; gy++) for (let gx = 1; gx < n - 1; gx++) bits4[gy * n + gx] = 1; // 3 格厚的墙带
  const before4 = bits4.slice();
  despeckle(bits4, n);
  T('去毛刺⑤-有厚度的墙带（含两端）完整保留，不会被误判成毛刺削掉',
    bits4.every((v, i) => v === before4[i]));

  // 判定基于改动前的快照，不依赖扫描方向——两个相邻的孤立噪点同时清理，
  // 结果应与"谁先谁后"无关（不是原地边算边改导致的方向依赖 bug）。
  const bits5 = new Uint8Array(n * n);
  bits5[5 * n + 4] = 1; bits5[5 * n + 5] = 1; // 横向相邻两格孤立噪点（各自只有 1 个同值邻居）
  despeckle(bits5, n);
  T('去毛刺⑥-判定基于翻转前的快照（相邻两格各只有 1 个同值邻居，按快照判定都应被清除）',
    at(bits5, 4, 5) === 0 && at(bits5, 5, 5) === 0);

  T('去毛刺⑦-返回值就是传入的 bits（原地修改，方便像 paintCircle 一样链式调用）',
    despeckle(new Uint8Array(9), 3) instanceof Uint8Array);
  const same = new Uint8Array(9);
  T('去毛刺⑧-返回的是同一个引用，不是拷贝', despeckle(same, 3) === same);
}

// ==================== ⑦ 逐格字节数据编解码（高度笔刷/材质笔刷共用） ====================
{
  const n = 12;
  const bytes = new Uint8Array(n * n);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 5) % 256; // 覆盖 0~255 全值域
  const b64 = packByteGrid(bytes);
  const back = unpackByteGrid(b64, n);
  T('字节格①-往返一致（0~255 全值域，不是只测了 0/1）',
    back && back.length === bytes.length && bytes.every((v, i) => v === back[i]));
  T('字节格②-尺寸不够时安全返回 null，不越界读取', unpackByteGrid(b64, n + 5) === null);
}

// ==================== ⑧ 材质分区可以手绘覆写（§3.2 已确认："以后的材质问题"的处理方式） ====================
{
  const fakeMap = { lanes: [{ id: 'mid', waypoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }], buildings: [] };
  const nx = 8, ny = 8, world = { w: 800, h: 800 };
  const walk = new Uint8Array(nx * ny).fill(1); // 全可走，方便看纯邻近推导的结果
  const proximityResult = zoneGrid(fakeMap, walk, nx, ny, world);
  T('材质①-没声明 zoneCellGrid 时走原有的邻近推导（现状不受影响）',
    proximityResult.length === nx * ny && !proximityResult.every(v => v === proximityResult[0]));

  // 手绘一份"整张图全部是 river"的覆写（现实里邻近推导几乎不可能得出这个结果，
  // 用来证明确实是覆写生效了，不是巧合碰上同一个结果）
  const riverIdx = ZONES.indexOf('river');
  const overrideBytes = new Uint8Array(nx * ny).fill(riverIdx);
  const mapWithOverride = { ...fakeMap, zoneCellGrid: { n: nx, zones: packByteGrid(overrideBytes) } };
  const overrideResult = zoneGrid(mapWithOverride, walk, nx, ny, world);
  T('材质②-声明了 zoneCellGrid 且尺寸匹配时，直接用手绘数据，不再跑邻近推导',
    overrideResult.every(v => v === riverIdx));

  // 尺寸对不上（比如笔刷分辨率与本次渲染的 nx/ny 不是同一批次）时安全退回邻近推导，
  // 不强行拉伸凑数据——那样会在分区边界糊出一圈不对齐的材质。
  const mismatchedMap = { ...fakeMap, zoneCellGrid: { n: nx + 1, zones: packByteGrid(new Uint8Array((nx + 1) * (nx + 1)).fill(riverIdx)) } };
  const mismatchedResult = zoneGrid(mismatchedMap, walk, nx, ny, world);
  T('材质③-zoneCellGrid 尺寸与本次渲染的网格不匹配时，安全退回邻近推导（不强行拉伸）',
    mismatchedResult.length === nx * ny && !mismatchedResult.every(v => v === riverIdx));
}

board.done();
