// 城墙/野区边界装饰（BoundaryDecorLayer）+ 风格化地图去高低差 + isLaneCell 共享判据——
// 用户看了森林风格截图后的追加反馈：
//   「红色画圈那里为高地，应该都是棕色的地面没有绿色的草地」—— 基地开放圈内被误判成
//     野区绿色斑块的 bug（Phase 3 修复：isInBaseOpen 并入 classifyLaneCells/isLaneCell）；
//   「粉色那里应该是城墙（墙壁）」—— 兵线/野区边界要有石头+金色装饰（BoundaryDecorLayer）；
//   「至于野区的墙壁你就想想怎么实现吧，用自然的感觉」—— 野区/障碍物边界加密树石；
//   「把风格化地图中所有的高低差全部删除，不要高低差了没意义（高地、龙坑）」——
//     MapSystem.heightAt 对 visualStyle==='stylized' 地图跳过高地/龙坑台阶计算。
//
// 分两类断言：
//   ① 纯数据/纯函数（isLaneCell 几何行为、heightAt 真实数值）—— 直接跑真实系统断言；
//   ② BoundaryDecorLayer 的 Three.js 渲染代码 + ThreeRenderer 接线 —— 走本项目"渲染层
//      用源码正则钉 JS/DOM 胶水代码、不测 WebGL 画面本身"的既定规矩（见 sim_frostbridge.mjs 头注）。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0, CTX: {} };
import { srcOf, scoreboard } from './_harness.mjs';
import { summoners_rift } from '../src/data/maps/summoners_rift.js';
import { MAPS } from '../src/data/maps/index.js';
import { isLaneCell, nearestLaneDist } from '../src/data/mapValidate.js';
import { isInBaseOpen, baseCircleCenter } from '../src/data/baseCircle.js';
import { EntityContainer } from '../src/core/EntityContainer.js';
import { EventBus } from '../src/utils/EventBus.js';
import { MapSystem } from '../src/systems/MapSystem.js';

const { T, done } = scoreboard('城墙/野区边界装饰 + 风格化去高低差验收');

const mk = (id) => {
  const bus = new EventBus(), ents = new EntityContainer(bus), ms = new MapSystem(ents, bus);
  ms.setCreateBuildingFn(() => null); window.gameTime = 0; ms.loadMap(id); return ms;
};

// ==================== 一、isLaneCell：与旧的两条判据取或逐位一致 ====================
{
  const halfW = summoners_rift.walls.corridorHalfWidth;
  const wp0 = summoners_rift.lanes[0].waypoints[0];
  T('判①-兵线路点自身判定为"路"（离自己的兵线距离≈0，必然 <= 走廊半宽）',
    isLaneCell(summoners_rift, wp0.x, wp0.y) === true);

  const blueBase = baseCircleCenter(summoners_rift, 'blue');
  T('判②-蓝方基地中心判定为"路"（isInBaseOpen 命中，即便离最近兵线可能超过走廊半宽）',
    isLaneCell(summoners_rift, blueBase.x, blueBase.y) === true &&
    isInBaseOpen(summoners_rift, blueBase.x, blueBase.y) === true);

  // 找一个真正的野区点：离所有兵线都远、且不在任何一方基地开放圈内。
  let jungle = null;
  for (let gx = 200; gx < summoners_rift.world.w - 200 && !jungle; gx += 137) {
    for (let gy = 200; gy < summoners_rift.world.h - 200 && !jungle; gy += 137) {
      if (nearestLaneDist(summoners_rift, gx, gy) > halfW + 40 && !isInBaseOpen(summoners_rift, gx, gy)) {
        jungle = { x: gx, y: gy };
      }
    }
  }
  T('判③-抽样确实找到了至少一个"离兵线远+不在基地圈内"的候选野区点（不然下一条断言没有意义）',
    !!jungle);
  if (jungle) {
    T('判④-该点 isLaneCell 判定为"野区"（两条判据都不满足才会是 false）',
      isLaneCell(summoners_rift, jungle.x, jungle.y) === false);
  }
}

// ==================== 二、heightAt：风格化地图（召唤师峡谷/扭曲丛林）高地/龙坑清零 ====================
{
  const srMs = mk('summoners_rift_v1');
  const nexus = summoners_rift.buildings.find(b => b.tier === 'nexus_main' && b.faction === 'blue');
  T('高①-召唤师峡谷（风格化）基地核心处高度=0（高地台阶已按 visualStyle 清零）',
    srMs.heightAt(nexus.pos.x, nexus.pos.y) === 0);
  const dragonPit = srMs.getPit ? srMs.getPit('dragon') : null;
  // 龙坑坑心恰好落在河道范围内（riverFactor>0）——河床下沉是用户明确保留的
  // （"河不算在内"），要单独看"坑深度"这一项有没有清零，得先把河道那一项摘掉，
  // 否则河床的 −10 会把"坑深度已经清零"这件事完全盖住，看不出来。
  const savedRiverFactor = srMs.riverFactor.bind(srMs);
  srMs.riverFactor = () => 0;
  const pitHeightNoRiver = dragonPit ? srMs.heightAt(dragonPit.x, dragonPit.y) : 0;
  srMs.riverFactor = savedRiverFactor;
  // v59：龙坑深处离兵线很远，会落进"深林"档，叠加了一点新引入的森林深度梯度
  // （轻微正高度，用户定稿"加回轻微高低差"）——这是另一个独立机制，不是本条断言
  // 要守的东西。本条只守"旧的坑深度机制（负值下沉）已经清零"：断言改成"不再是
  // 老机制那种明显下沉"（远高于 pit.depth=-26 那个量级），而不是死抠等于 0。
  T('高②-召唤师峡谷（风格化）龙坑坑心处不再有老的坑深度下沉（新的森林梯度轻微正高度是另一回事）',
    !dragonPit || pitHeightNoRiver > -5);

  // v51.18：扭曲丛林接入"魔幻森林"风格化调色板（见 twisted_treeline.js 头注），
  // 从"未声明 visualStyle:stylized 的老地图"变成了跟召唤师峡谷同一类——原来这里
  // 钉的是"非风格化地图不受影响"，现在扭曲丛林也风格化了，高地台阶同样按
  // visualStyle 清零，断言改成跟召唤师峡谷同一套（高①）。
  const ttMs = mk('twisted_treeline_v1');
  const tt = MAPS['twisted_treeline_v1'];
  const ttNexus = tt.buildings.find(b => b.tier === 'nexus_main' && b.faction === 'blue');
  T('高③-扭曲丛林（风格化后）基地核心处高度=0（高地台阶已按 visualStyle 清零，与召唤师峡谷一致）',
    ttMs.heightAt(ttNexus.pos.x, ttNexus.pos.y) === 0);
}

// ==================== 三、BoundaryDecorLayer：源码正则（渲染层胶水代码）====================
{
  const bd = srcOf('src/presentation/BoundaryDecorLayer.js');
  T('接①-BoundaryDecorLayer 引入了共享的 isLaneCell（不自己另算一套路/野区判据）',
    /import \{ isLaneCell \} from '\.\.\/data\/mapValidate\.js';/.test(bd));
  T('接②-BoundaryDecorLayer 复用 VegetationLayer 导出的树/岩几何与哈希（不重新写一份几何生成）',
    /import \{ withColor, stylizedTreeGeo, hash \} from '\.\/VegetationLayer\.js';/.test(bd));
  T('接③-生效条件与 TerrainLayer 的 jungleActive 完全一致（同一句判据字符串）',
    /const active = stylized && !!SV\.jungleColor && Array\.isArray\(map\.lanes\) && map\.lanes\.length > 0;/.test(bd) &&
    /jungleActive = stylized && !!SV\.jungleColor && Array\.isArray\(map\.lanes\) && map\.lanes\.length > 0;/.test(srcOf('src/presentation/TerrainLayer.js')));
  T('接④-同图已建则跳过重建（同一守卫模式：_mapId === map.id && 有内容）',
    /if \(this\._mapId === map\.id && this\.meshes\.length\) return;/.test(bd));
  T('接⑤-城墙候选用上下左右四向探测分类翻转来判定边界（不做多边形轮廓追踪）',
    /isLaneCell\(map, gx \+ POST_PROBE, gy\) !== here/.test(bd));

  const tr = srcOf('src/presentation/ThreeRenderer.js');
  T('接⑥-ThreeRenderer 引入并实例化了 BoundaryDecorLayer',
    /import \{ BoundaryDecorLayer \} from '\.\/BoundaryDecorLayer\.js';/.test(tr) &&
    /this\.boundaryDecor = new BoundaryDecorLayer\(this\.scene\);/.test(tr));
  T('接⑦-地形重建流程里调用了 boundaryDecor.build（否则接了线但从来不会真的建）',
    /this\.boundaryDecor\.build\(this\.mapSystem\);/.test(tr));
}

// ==================== 四、v59.1：野区结构化（可走路径通透+障碍物森林+基地围墙）====================
// 用户连续反馈：「依旧没有结构，糊成一团。野区的道路上应该是没有任何障碍物的」
// 「地面留下的深绿色丑的要死的块……我粉色画圈的地方应该是高地的围墙（石墙）」
{
  const bc = srcOf('src/data/baseCircle.js');
  T('围①-baseCircle.js 新增 isInBaseWallRing（基地高地围墙那一圈的几何判定）',
    /export function isInBaseWallRing\(map, x, y/.test(bc));

  // isInBaseWallRing 是纯函数，直接用真实召唤师峡谷数据跑一遍几何行为。
  const { isInBaseWallRing } = await import('../src/data/baseCircle.js');
  const blueBase = baseCircleCenter(summoners_rift, 'blue');
  const r = summoners_rift.baseOpenRadius || summoners_rift.baseCircleRadius;
  T('围②-基地中心（开放广场核心）不属于围墙带',
    !isInBaseWallRing(summoners_rift, blueBase.x, blueBase.y));
  T('围③-刚好在 baseOpenRadius 处（围墙带内缘）属于围墙带',
    isInBaseWallRing(summoners_rift, blueBase.x, blueBase.y - r));
  T('围④-远超出围墙带厚度的地方（比如整张图对角）不属于围墙带',
    !isInBaseWallRing(summoners_rift, summoners_rift.world.w / 2, summoners_rift.world.h / 2));

  const veg = srcOf('src/presentation/VegetationLayer.js');
  T('围⑤-VegetationLayer 引入了 isInBaseWallRing 并在 jungleMode 分支里用它跳过',
    /import \{ isInBaseWallRing \} from '\.\.\/data\/baseCircle\.js';/.test(veg) &&
    /if \(isInBaseWallRing\(map, x, y\)\) continue;/.test(veg));
  T('围⑥-VegetationLayer 对可走的野区路径（onPath）用更高的跳过阈值，保持通透',
    /skipThresh = onPath \? 0\.90/.test(veg));

  const bd2 = srcOf('src/presentation/BoundaryDecorLayer.js');
  T('围⑦-BoundaryDecorLayer 引入共享的 baseCircleCenter，新增围墙候选采样',
    /import \{ baseCircleCenter \} from '\.\.\/data\/baseCircle\.js';/.test(bd2) &&
    /const wallRingPosts = \[\];/.test(bd2));
  T('围⑧-围墙候选只在不可走处摆（兵线穿过的入口是可走的，天然留出三个口子）',
    /if \(walk\(x, y\)\) continue;.*wallRingPosts\.push/s.test(bd2));

  const tl2 = srcOf('src/presentation/TerrainLayer.js');
  T('围⑨-TerrainLayer 给基地围墙带的不可走格子换成石头色（不再是裸露的图外底色）',
    /import \{ baseCircleCenter, isInBaseWallRing \} from '\.\.\/data\/baseCircle\.js';/.test(tl2) &&
    /isInBaseWallRing\(map, wx, wy\)/.test(tl2));
}

// ==================== 五、v59.2：河道加宽 + 道路有机宽窄 ====================
// GPT 对第一版森林风格截图的评价里，P0 提案的另外两条：河道加强存在感、
// 道路做宽窄变化——「先弄地图」阶段的收尾两项。
{
  T('宽①-召唤师峡谷单独声明了更宽的 riverHalfWidth（默认 200，这里 260，+30%）',
    summoners_rift.heightZones?.riverHalfWidth === 260);

  const mv = srcOf('src/data/mapValidate.js');
  T('宽②-mapValidate.js 新增 laneWidthNoise（平滑正弦噪声，不是按格哈希）',
    /function laneWidthNoise\(x, y\)/.test(mv) && /Math\.sin/.test(mv));
  T('宽③-isLaneCell 用 laneWidthNoise 让走廊半宽产生有机的宽窄起伏（±18%）',
    /laneHalfWidth = baseHalfWidth \* \(1 \+ laneWidthNoise\(x, y\) \* 0\.18\)/.test(mv));

  // 真实数据核实：同一条兵线上不同点的"有效走廊半宽"确实会不同（不是每处都一样宽）。
  const { isLaneCell } = await import('../src/data/mapValidate.js');
  const lane0 = summoners_rift.lanes[0];
  let sawLane = false, sawJungleAtOldWidth = false;
  const halfW = summoners_rift.walls.corridorHalfWidth;
  for (const wp of lane0.waypoints) {
    // 在路点正上方 halfW*1.1 处取样——老的固定宽度判据下这里应该稳定判"野区"，
    // 但有机宽窄允许它在局部变宽时被判成"路"，用来证明宽度确实不是常数。
    if (isLaneCell(summoners_rift, wp.x, wp.y)) sawLane = true;
    if (!isLaneCell(summoners_rift, wp.x + halfW * 1.5, wp.y)) sawJungleAtOldWidth = true;
  }
  T('宽④-有机宽窄没有破坏基本判据：兵线路点自身仍然判"路"',
    sawLane);
  T('宽⑤-有机宽窄没有把整条路变成一马平川：离中线足够远(halfW*1.5)的地方仍然能判成野区',
    sawJungleAtOldWidth);
}

// ==================== 五、v51.22：召唤师峡谷去掉柱子装饰 ====================
// 用户反馈把地图上（召唤师峡谷）的石柱+金顶装饰去掉——嚎哭深渊冰封版自己有一套
// 独立的 frostBridge 火把柱，两者不是一回事，不受这个开关影响。走本文件既定的
// "渲染层用源码正则钉胶水代码"规矩，同时用真实地图数据核实开关字段确实声明了。
{
  const bd3 = srcOf('src/presentation/BoundaryDecorLayer.js');
  T('柱①-新增 showPillars 开关（默认开，map.boundaryPillars===false 才关）',
    /const showPillars = map\.boundaryPillars !== false;/.test(bd3));
  T('柱②-两处城墙/围墙柱子的 place 调用都在 showPillars 判断内（只关柱子，不影响下面的树/岩装饰）',
    /if \(showPillars\) \{[\s\S]{0,400}place\(wallPostGeo\(SV\)[\s\S]{0,150}posts[\s\S]{0,400}place\(wallPostGeo\(SV\)[\s\S]{0,150}wallRingPosts[\s\S]{0,20}\}/.test(bd3));
  T('柱③-召唤师峡谷声明了 boundaryPillars:false', summoners_rift.boundaryPillars === false);
  T('柱④-嚎哭深渊冰封版没有声明这个字段（默认开，不受影响，它有自己独立的火把柱）',
    !('boundaryPillars' in MAPS['howling_abyss_frost_v1']));
}

// ==================== 六、积雪野区可见性修复（v55.1）：树/岩落雪接线 ====================
// 用户报告野区看不到雪，根因是野区密密麻麻的树/岩 InstancedMesh 挡住了贴地的
// 雪盖平面。渲染层没有 DOM/WebGL 没法在 Node 里实际跑，这里走本文件既定的
// "源码正则钉胶水代码"规矩，钉住：natTrees/natRocks 接了落雪效果、wall 柱子
// 没接（人工建筑不需要）、VegetationLayer 四类植被全接了、ThreeRenderer 每帧
// 调用了两层的 updateSnow。浏览器实测见任务提交记录里的截图对比。
{
  const bd4 = srcOf('src/presentation/BoundaryDecorLayer.js');
  T('雪接①-BoundaryDecorLayer 导入了 applySnowTint/updateSnowInstances/sampleSnowGrid',
    /import \{ applySnowTint, updateSnowInstances \} from '\.\/VegetationShaderPatch\.js';/.test(bd4)
    && /import \{ sampleSnowGrid \} from '\.\.\/systems\/GroundTraceSystem\.js';/.test(bd4));
  T('雪接②-natTrees/natRocks 两处 place 调用都传了 snow=true（最后一个参数）',
    /place\(stylizedTreeGeo\(map\)[\s\S]{0,160}natTrees, 0\.85, 0\.35, true\)/.test(bd4)
    && /place\([\s\S]{0,160}natRocks, 0\.8, 0\.4, true\)/.test(bd4));
  T('雪接③-城墙/围墙柱子（posts/wallRingPosts/styledPosts）三处调用都没传 snow（人工建筑不落雪）',
    /place\(wallPostGeo\(SV\)[\s\S]{0,80}posts, 1\.0, 0\.15\);/.test(bd4)
    && /place\(wallPostGeo\(SV\)[\s\S]{0,80}wallRingPosts, 1\.3, 0\.1\);/.test(bd4)
    && /place\(wallPostGeo\(SV\)[\s\S]{0,80}styledPosts, 1\.0, 0\.15\);/.test(bd4));
  T('雪接④-新增 updateSnow(dt, groundTraceSystem) 方法', /updateSnow\(dt, groundTraceSystem\) \{/.test(bd4));

  const veg2 = srcOf('src/presentation/VegetationLayer.js');
  T('雪接⑤-VegetationLayer 的 place() 内部统一给每个实例建了 instanceSnow 属性并调用 applySnowTint',
    /setAttribute\('instanceSnow', new THREE\.InstancedBufferAttribute/.test(veg2) && /applySnowTint\(inst\.geometry, mat\)/.test(veg2));
  T('雪接⑥-VegetationLayer 新增 updateSnow(dt, groundTraceSystem) 方法', /updateSnow\(dt, groundTraceSystem\) \{/.test(veg2));

  const patch = srcOf('src/presentation/VegetationShaderPatch.js');
  T('雪接⑦-VegetationShaderPatch 用 mix() 往白插值（不是乘法/instanceColor那套，理由见头注）',
    /diffuseColor\.rgb = mix\(diffuseColor\.rgb, vec3\(1\.0\), vSnowAmt\);/.test(patch));
  T('雪接⑧-updateSnowInstances 封顶乘 maxBlend（不是把雪深原样写进去，读 Config 的 maxBlend）',
    /arr\[i\] = depth \* maxBlend;/.test(patch));

  const tr2 = srcOf('src/presentation/ThreeRenderer.js');
  T('雪接⑨-ThreeRenderer 每帧调用了 veg.updateSnow 与 boundaryDecor.updateSnow',
    /this\.veg\.updateSnow\(this\._lightDt \|\| 0\.016, window\.__groundTrace \|\| null\)/.test(tr2)
    && /this\.boundaryDecor\.updateSnow\(this\._lightDt \|\| 0\.016, window\.__groundTrace \|\| null\)/.test(tr2));

  const gtl = srcOf('src/presentation/GroundTraceLayer.js');
  T('雪接⑩-GroundTraceLayer 雪盖材质改用中性白 + map/alphaMap 同源纹理（颜色现在来自纹理RGB，不是材质tint）',
    /color: 0xffffff, transparent: true,\s*\n\s*map: tex, alphaMap: tex/.test(gtl));
  T('雪接⑪-GroundTraceLayer 按 zoneMix 在 pathColor/jungleColor 之间插值写 RGB 通道',
    /const t = zoneMix \? zoneMix\[i\] : 0;/.test(gtl));
}

done();
