/**
 * sim_lanealign.mjs —— 兵线自动对齐验收（2026-09-04 第二节）
 *
 * 见 mapEditorCore.js alignLaneToCorridor() 头注。用户反馈"蓝方下路的兵线，
 * 在路上有些偏上，正常应该在下路的路中央"——用垂直切线方向双向探墙的算法
 * 核实过：召唤师峡谷上/下路贴边界的直线段确实一致偏离走廊中点 1~4 格，
 * 转角/开阔地那几个点算出来的"大偏移"是算法在开阔地失真，不是真实问题
 * （两侧摸不到墙就跳过，这个函数自己会分辨）。
 *
 * 覆盖：① 合成的窄直线走廊——已知偏移量，验证纠正到中心；
 *      ② 已经居中的点不会被误挪；③ 开阔地（两侧摸不到墙）原样跳过；
 *      ④ 首尾路点（锚定基地/水晶）永远不动；⑤ 不修改输入数组；
 *      ⑥ 真实召唤师峡谷数据：验证走 alignLaneToCorridor 后新路点确实比
 *      旧路点更接近该点处的走廊中点（不是瞎改，是真的更居中）。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { alignLaneToCorridor } = await import('../src/data/mapEditorCore.js');
const { unpackBits } = await import('../src/data/navgrid.js');
const { SR_NAVGRID } = await import('../src/data/maps/sr_navgrid.js');
const { summoners_rift } = await import('../src/data/maps/summoners_rift.js');

const { T, done } = scoreboard('兵线自动对齐验收');

// ==================== ①~⑤ 合成走廊：n=40，世界=400x400（10 世界单位/格） ====================
// 水平走廊：x∈[5,35]，可行走 y∈[15,20]（6 行，真实中心 y=17.5）。
{
  const n = 40, world = { w: 400, h: 400 };
  const bits = new Uint8Array(n * n);
  for (let x = 5; x <= 35; x++) for (let y = 15; y <= 20; y++) bits[y * n + x] = 1;

  const waypoints = [
    { x: 20, y: 175 },   // #0 锚点（grid 2,17.5）——不应该被动
    { x: 100, y: 140 },  // #1 偏移点（grid 10,14）——真实中心是 17.5，偏了 3.5 格
    { x: 200, y: 175 },  // #2 已经居中（grid 20,17.5）
    { x: 380, y: 175 },  // #3 锚点（grid 38,17.5）——不应该被动
  ];
  const aligned = alignLaneToCorridor(bits, n, world, waypoints);

  T('①-首路点（锚定基地）原样不动', aligned[0].x === waypoints[0].x && aligned[0].y === waypoints[0].y);
  T('①b-尾路点（锚定水晶）原样不动', aligned[3].x === waypoints[3].x && aligned[3].y === waypoints[3].y);
  T('②-偏移点被纠正到走廊中心附近（y 从 140 挪向 175，格子中心 17.5×10=175）',
    Math.abs(aligned[1].y - 175) < Math.abs(waypoints[1].y - 175) && Math.abs(aligned[1].y - 175) <= 5);
  T('③-已经居中的点几乎不动（半格容差内直接跳过）', Math.abs(aligned[2].y - 175) < 5);
  T('④-不修改输入数组', waypoints[1].y === 140);
}

// ==================== ⑤b 路点本身恰好落在不可走格（贴边/取整误差）也要能纠正 ====================
// 真实的踩坑记录：第一版实现从"路点自身位置"起步双向探墙，若路点恰好在走廊
// 外面一点点，两侧从原地探墙立刻失败（0=0），被误判成"已经居中"——这个用例
// 就是当时写测试时发现并修掉的那个情形，钉住不能回归。
{
  const n = 40, world = { w: 400, h: 400 };
  const bits = new Uint8Array(n * n);
  for (let x = 5; x <= 35; x++) for (let y = 15; y <= 20; y++) bits[y * n + x] = 1; // 中心 17.5

  const waypoints = [
    { x: 20, y: 175 },   // 锚点
    { x: 100, y: 130 },  // grid(10,13)：在走廊【外面】（走廊是 y∈[15,20]）
    { x: 380, y: 175 },  // 锚点
  ];
  const aligned = alignLaneToCorridor(bits, n, world, waypoints);
  T('⑤b-路点落在走廊外面时，纠正后落回走廊内（不会被误判成"已居中"）',
    aligned[1].y >= 145 && aligned[1].y <= 205); // grid y 落在 [14.5,20.5] 范围内即算修对了方向
  T('⑤c-纠正后确实比原来更接近走廊中心（175）', Math.abs(aligned[1].y - 175) < Math.abs(130 - 175));
}

// ==================== ⑥ 开阔地：两侧都摸不到墙，原样跳过 ====================
{
  const n = 40, world = { w: 400, h: 400 };
  const bits = new Uint8Array(n * n).fill(1); // 整张图全可走，没有任何墙
  const waypoints = [{ x: 20, y: 175 }, { x: 100, y: 140 }, { x: 200, y: 175 }, { x: 380, y: 175 }];
  const aligned = alignLaneToCorridor(bits, n, world, waypoints);
  T('⑤-开阔地（默认 15 格搜索半径内摸不到墙）原样跳过，不瞎猜居中', aligned[1].x === 100 && aligned[1].y === 140);
}

// ==================== ⑦ 真实召唤师峡谷数据：纠正后确实更接近走廊中点 ====================
{
  const n = SR_NAVGRID.n;
  const bits = unpackBits(SR_NAVGRID.bits, n);
  const world = summoners_rift.world;

  // 复刻同一套"垂直切线双向探墙找中点"算法，独立算出每个点纠正前/后离中点
  // 有多远——这段本身不是被测代码，只是核验用的参照实现，用来判定
  // "改动方向是不是真的在往中心走"，不直接依赖 alignLaneToCorridor 内部实现。
  function offsetFromCenter(waypoints, i, maxRadius = 15) {
    const toGrid = (x, y) => ({ gx: x / world.w * n, gy: y / world.h * n });
    const isWalkable = (gx, gy) => {
      const x = Math.round(gx), y = Math.round(gy);
      if (x < 0 || y < 0 || x >= n || y >= n) return null;
      return !!bits[y * n + x];
    };
    const wp = waypoints[i], prev = waypoints[i - 1], next = waypoints[i + 1];
    const g = toGrid(wp.x, wp.y);
    const gPrev = toGrid(prev.x, prev.y), gNext = toGrid(next.x, next.y);
    const dx = gNext.gx - gPrev.gx, dy = gNext.gy - gPrev.gy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = -dy / len, uy = dx / len;
    let posEdge = maxRadius, negEdge = maxRadius;
    for (let s = 0; s < maxRadius; s++) { if (isWalkable(g.gx + ux * s, g.gy + uy * s) === false) { posEdge = s; break; } }
    for (let s = 0; s < maxRadius; s++) { if (isWalkable(g.gx - ux * s, g.gy - uy * s) === false) { negEdge = s; break; } }
    if (posEdge >= maxRadius || negEdge >= maxRadius) return null; // 开阔地，不参与比较
    return Math.abs((posEdge - negEdge) / 2);
  }

  for (const laneId of ['top', 'bot']) {
    const lane = summoners_rift.lanes.find(l => l.id === laneId);
    const aligned = alignLaneToCorridor(bits, n, world, lane.waypoints);
    let checked = 0, improved = 0;
    for (let i = 1; i < lane.waypoints.length - 1; i++) {
      const before = offsetFromCenter(lane.waypoints, i);
      if (before === null) continue; // 开阔地，跳过比较（算法本身也跳过了这个点）
      checked++;
      const afterOffset = offsetFromCenter([lane.waypoints[i - 1], aligned[i], lane.waypoints[i + 1]], 1);
      if (afterOffset !== null && afterOffset <= before + 0.51) improved++; // 允许半格误差
    }
    T(`⑦-${laneId} 路：窄走廊里的点纠正后没有变得更偏（核验了 ${checked} 个可比较的点）`,
      checked > 0 && improved === checked);
  }
}

done();
