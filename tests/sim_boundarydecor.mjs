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

// ==================== 二、heightAt：风格化地图（召唤师峡谷）高地/龙坑清零，非风格化地图不变 ====================
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
  T('高②-召唤师峡谷（风格化）龙坑坑心处高度=0（坑深度已按 visualStyle 清零，河床下沉另计不受影响）',
    !dragonPit || pitHeightNoRiver === 0);

  const ttMs = mk('twisted_treeline_v1');
  const tt = MAPS['twisted_treeline_v1'];
  const ttNexus = tt.buildings.find(b => b.tier === 'nexus_main' && b.faction === 'blue');
  T('高③-扭曲丛林（非风格化）基地核心处高度仍 > 0（v58 改动不影响未声明 visualStyle:stylized 的老地图）',
    ttMs.heightAt(ttNexus.pos.x, ttNexus.pos.y) > 0);
}

// ==================== 三、BoundaryDecorLayer：源码正则（渲染层胶水代码）====================
{
  const bd = srcOf('src/presentation/BoundaryDecorLayer.js');
  T('接①-BoundaryDecorLayer 引入了共享的 isLaneCell（不自己另算一套路/野区判据）',
    /import \{ isLaneCell \} from '\.\.\/data\/mapValidate\.js';/.test(bd));
  T('接②-BoundaryDecorLayer 复用 VegetationLayer 导出的坐标哈希（不重新写一份随机数生成）',
    /import \{ withColor, hash \} from '\.\/VegetationLayer\.js';/.test(bd));
  T('接②b-野区边缘装饰不用树（用户："召唤师峡谷……都是低矮的灌木丛和零星的石头"）',
    !/stylizedTreeGeo/.test(bd) && /natBushes/.test(bd) && /natRocks/.test(bd));
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

  // v58.5：用户反馈"看不出一点森林的样子……都是低矮的灌木丛和零星的石头"——
  // jungleMode（召唤师峡谷）不应该再摆树，只用灌木/岩石。
  const veg = srcOf('src/presentation/VegetationLayer.js');
  const rollStart = veg.indexOf('const sc = 0.65, rot = hash(gx + 5, gy + 5) * 6.2832;');
  const rollJmStart = veg.indexOf('if (jungleMode) {', rollStart);
  const rollJmEnd = veg.indexOf('} else {', rollJmStart);
  const rollSeg = veg.slice(rollJmStart, rollJmEnd);
  T('接⑧-VegetationLayer 主循环的摆放判据里，jungleMode 分支不摆树（trees.push），只出灌木/岩石',
    !/trees\.push/.test(rollSeg) && /rocks\.push/.test(rollSeg) && /bushes\.push/.test(rollSeg));
  const step2Start = veg.indexOf('const STEP2 = 30;');
  const step2End = veg.indexOf('\n    }\n', step2Start);
  const step2Seg = veg.slice(step2Start, step2End);
  T('接⑨-障碍物内部加密填充（STEP2）同样不摆树，只出灌木/岩石',
    step2Start >= 0 && !/trees\.push/.test(step2Seg) && /bushes\.push/.test(step2Seg) && /rocks\.push/.test(step2Seg));

  // v58.6：用户原话"都是低矮的灌木丛和零星的石头"——灌木是主体("丛")，石头是
  // "零星"点缀，第一版权重反过来了（石头占大头）。检查两趟采样都改成了灌木为主。
  T('接⑩-jungleMode 稀疏采样：灌木权重高于岩石（石头判据阈值 < 0.5，不是岩石占大头）',
    /if \(r < 0\.20\) rocks\.push/.test(rollSeg));
  T('接⑪-障碍物加密填充：灌木权重高于岩石（同上）',
    /if \(r2 < 0\.82\) bushes\.push/.test(step2Seg));

  // v58.6：用户反馈"看不出灌木/石头的区分，全是一片白/一片橙"——根因是 setTint
  // 直接用 material.color.set(hex) 整个覆盖掉风格化材质自带的颜色（石头/灌木/
  // 城墙都没有 instanceColor，颜色全靠 material.color 本身），到了昼夜染色那一刻
  // 所有装饰物被抹成同一个颜色。修法是存一份原始底色，染色时用"底色×tint"而不是
  // 直接替换。
  T('接⑫-place() 为每个材质记录了原始底色（setTint 要用它做乘法，不能直接覆盖）',
    /inst\.userData\.baseColor = mat\.color\.clone\(\);/.test(veg));
  T('接⑬-setTint 用"底色×tint"而不是直接 set(hex)（否则风格化石头/灌木的颜色会被昼夜染色整个吃掉）',
    /m\.material\.color\.copy\(base\)\.multiply\(t\);/.test(veg));
}

done();
