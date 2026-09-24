/**
 * BoundaryDecorLayer.js —— 森林风格地图·兵线/野区边界装饰（v58 新增，通用件）
 *
 * 背景：用户看了森林风格召唤师峡谷的截图后，发来带标注的截图追加两条要求：
 * 「粉色那里应该是城墙（墙壁）」——兵线与野区交界处要有一圈石头+金色的"城墙"；
 * 「至于野区的墙壁你就想想怎么实现吧，用自然的感觉（树、石头、等）」——野区内部
 * 迷宫状不可走障碍物的边缘，用户把"怎么做"完全交给我判断：这里选的是"加密
 * 树/岩簇"而不是另建一圈人工墙——那些障碍物本来就是野区里天然长的地形阻挡，
 * 围一圈人工建筑反而不像野区。
 *
 * 设计上明确不采用多边形轮廓追踪（navOutline/traceLoops，见 docs/MAP-DESIGN-
 * howling-abyss-frost.md §12）——那套方案要正确算出每一段边界的切线方向才能把
 * 墙段摆正朝向，森林风格用不上那么精确的贴合。改用更简单的网格采样：在候选
 * 网格点上下左右各探一步，看分类（路/野区，或可走/不可走）有没有翻转，翻转了
 * 就是边界，摆一个【旋转对称】的装饰体（石柱/树丛都绕竖直轴对称）——天然不
 * 需要知道边界朝哪个方向，省掉了轮廓追踪最麻烦的那部分。
 *
 * 通用件，不是召唤师峡谷专属：只要地图是 visualStyle:'stylized' 且调色板声明了
 * jungleColor（= TerrainLayer 判定 jungleActive 的同一条件，见该文件），这一层
 * 就会生效——以后其它森林风格地图复用同一份调色板资产，城墙/野区装饰自动跟着有，
 * 不用每张图各写一份。
 *
 * 仅渲染，不改变任何占位判定——navgrid/兵线几何逐位不变，这一层只是加在上面看
 * 的东西。路/野区的分类判据取自共享函数 isLaneCell（mapValidate.js），与
 * TerrainLayer 地面着色、sim_foreststyle.mjs 钉的分类结果是同一份实现，不在这里
 * 另算一套（否则以后改一条判据只改了一处，围墙会摆在跟地面颜色不一致的地方）。
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { stylizedPaletteOf } from '../data/Config.js';
import { isLaneCell } from '../data/mapValidate.js';
import { baseCircleCenter } from '../data/baseCircle.js';
import { withColor, stylizedTreeGeo, hash } from './VegetationLayer.js';

// ==================== 城墙（柱子）====================
// 用户标注的"粉色"是墙，但不做真的墙体嵌板（做嵌板需要算切线方向摆正朝向，
// 见头注）——改用旋转对称的石柱+金顶，柱子本身不分朝向，摆在哪个角度看着都一样，
// 一整排柱子沿边界排开，同样读得出"城墙"的意思。
const POST_SPACING = 150;   // 候选网格间距，同时也是最终柱间大致间距——直接靠网格稀疏来控制密度，不用额外做去重
const POST_PROBE = 70;      // 探测半径：太小摸不到旁边地块判不出翻转，太大又会把整条路面都判成"贴边"
const POST_R_BOT = 10, POST_R_TOP = 8, POST_H = 30;   // 柱身：六棱柱，梯形收分，不是死板圆柱
const CAP_R = 11, CAP_H = 6;                          // 金色压顶——"石头+金色"里的金色

function wallPostGeo(SV) {
  const stone = withColor(new THREE.CylinderGeometry(POST_R_TOP, POST_R_BOT, POST_H, 6).translate(0, POST_H / 2, 0), SV.rockColor || '#8f8879');
  const cap = withColor(new THREE.CylinderGeometry(CAP_R, CAP_R * 0.8, CAP_H, 6).translate(0, POST_H + CAP_H / 2, 0), SV.wallCapColor || '#c9a24a');
  return mergeGeometries([stone, cap]);
}

// ==================== 野区内部障碍物边缘（自然感）====================
// 复用 VegetationLayer 已经导出的树/岩几何与坐标哈希，不重新写一份——用户原话
// 里"树、石头"两样东西这套几何已经有了，缺的只是"往障碍物边上多撒一点"的判据。
const NAT_SPACING = 55;     // 比普通野区植被(VegetationLayer 的 STEP=62)略密，边缘要"看起来更挤"
const NAT_PROBE = 42;       // 比普通植被的 margin(26) 更大：要探到确实贴着障碍物才算数，不是随便挨着不可走区就算
const NAT_JITTER = 0.8;     // 与 VegetationLayer 同量级的散布抖动，避免整排等距显得死板

// ==================== v59.1：基地高地围墙 ====================
// 用户看截图标注反馈："地面留下的深绿色丑的要死的块……我粉色画圈的地方应该是
// 高地的围墙（石墙）"——sr_navgrid.js 描过这一圈几何："在基地圈半径处筑一圈
// 厚 45 的墙，兵线走廊穿过处不筑，留三个口子"。这圈墙体的不可走格子之前被
// VegetationLayer 的"基地开放圈内不用管"判据（isInBaseOpen）连带跳过了，
// 裸露着图外底色；现在改成这一圈单独摆真正的墙体（复用同一套石柱+金顶几何，
// 跟"粉色=城墙"的既有装饰语言统一），VegetationLayer 那边对应跳过
// （isInBaseWallRing），两处不会在同一块地皮上打架。
const WALL_RING_ARC_SPACING = 130;   // 沿环形弧长的柱间距，跟城墙柱大致同一密度
const WALL_RING_OFFSET = 25;         // 环带厚度(~45~60)取中点附近，柱子稳稳落在墙体里

export class BoundaryDecorLayer {
  constructor(scene) { this.scene = scene; this.meshes = []; this._mapId = null; }

  clear() {
    for (const m of this.meshes) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = [];
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    const stylized = !!(map && map.visualStyle === 'stylized');
    const SV = stylized ? stylizedPaletteOf(map) : null;
    // 与 TerrainLayer 的 jungleActive 判据完全一致：调色板声明 jungleColor 且地图
    // 真有 lanes 才谈得上"路/野区"二分，否则这一层没有意义（HA-frost/demo 都不满足，逐位不变）。
    const active = stylized && !!SV.jungleColor && Array.isArray(map.lanes) && map.lanes.length > 0;
    if (!active) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.meshes.length) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;
    // v51.22：石柱+金顶的城墙/围墙装饰默认开——地图可以显式声明 boundaryPillars:false
    // 关掉（用户反馈召唤师峡谷上这批柱子要去掉，嚎哭深渊冰封版自己另有一套
    // frostBridge 火把柱，两者不是一回事，不受这个开关影响，默认值不动）。
    // 只关柱子这一类装饰，下面野区树/岩的自然边缘装饰不受影响。
    const showPillars = map.boundaryPillars !== false;

    const { w: WW, h: WH } = map.world;
    const walk = (x, y) => mapSystem.isWalkable(x, y);
    const heightAt = mapSystem.heightAt ? (x, z) => mapSystem.heightAt(x, z) : () => 0;
    // 高地石墙笔刷（素材库，v51.33）：笔刷在某格不可走区域显式画了"石墙"风格时
    // （wallStyleAt 返回 2），这格附近该摆石柱而不是自然树石丛——见下方自然边缘
    // 候选那段的用法。没有覆写网格/不是 navgrid 地图时恒返回 0（自动），行为
    // 逐位不变，不影响任何已有地图。
    const wallStyleAt = mapSystem.wallStyleAt ? (x, y) => mapSystem.wallStyleAt(x, y) : () => 0;
    const edge = 90;   // 与 VegetationLayer 同一个"离图边留白"

    // ---- 城墙候选：路/野区分类在探测半径内发生翻转的网格点 ----
    const posts = [];
    for (let gx = edge; gx < WW - edge; gx += POST_SPACING) {
      for (let gy = edge; gy < WH - edge; gy += POST_SPACING) {
        if (!walk(gx, gy)) continue;
        const here = isLaneCell(map, gx, gy);
        const flip = isLaneCell(map, gx + POST_PROBE, gy) !== here ||
                     isLaneCell(map, gx - POST_PROBE, gy) !== here ||
                     isLaneCell(map, gx, gy + POST_PROBE) !== here ||
                     isLaneCell(map, gx, gy - POST_PROBE) !== here;
        if (!flip) continue;
        posts.push([gx, gy]);
      }
    }

    // ---- 自然边缘候选：野区里"可走但贴着不可走障碍物"的网格点 ----
    const natTrees = [], natRocks = [], styledPosts = [];
    for (let gx = edge; gx < WW - edge; gx += NAT_SPACING) {
      for (let gy = edge; gy < WH - edge; gy += NAT_SPACING) {
        const x = gx + (hash(gx + 31, gy) - 0.5) * NAT_SPACING * NAT_JITTER;
        const y = gy + (hash(gx, gy + 31) - 0.5) * NAT_SPACING * NAT_JITTER;
        if (!walk(x, y)) continue;
        if (isLaneCell(map, x, y)) continue;   // 只加密野区一侧，路面不摆
        const probes = [[x + NAT_PROBE, y], [x - NAT_PROBE, y], [x, y + NAT_PROBE], [x, y - NAT_PROBE]];
        const surrounded = probes.every(([px, py]) => walk(px, py));
        if (surrounded) continue;              // 四周都可走，说明没贴着障碍物，跳过
        // 高地石墙笔刷：贴着的不可走格子里，只要有一个被笔刷显式画成"石墙"风格
        // （wallStyleAt===2），这个候选点就改摆石柱围墙，不摆自然树石——这是
        // 素材库笔刷唯一要改的行为，其余（没画过/画的是"自然"风格）逐位不变。
        const stoneNearby = probes.some(([px, py]) => !walk(px, py) && wallStyleAt(px, py) === 2);
        if (stoneNearby) { styledPosts.push([x, y]); continue; }
        (hash(gx + 3, gy) < 0.6 ? natTrees : natRocks).push([x, y]);
      }
    }

    // ---- 基地高地围墙候选：沿 baseOpenRadius 环形采样，只在不可走的墙体格子上摆 ----
    const wallRingPosts = [];
    for (const f of ['blue', 'red']) {
      const c = baseCircleCenter(map, f);
      const r = map.baseOpenRadius || map.baseCircleRadius;
      if (!c || !r) continue;
      const ringR = r + WALL_RING_OFFSET;
      const steps = Math.max(8, Math.round((2 * Math.PI * ringR) / WALL_RING_ARC_SPACING));
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const x = c.x + Math.cos(ang) * ringR, y = c.y + Math.sin(ang) * ringR;
        if (x < edge || x > WW - edge || y < edge || y > WH - edge) continue;
        if (walk(x, y)) continue;   // 兵线穿过处是可走的入口，天然跳过——sr_navgrid.js 定的"只有三座高地塔那里开口"
        wallRingPosts.push([x, y]);
      }
    }

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(),
          S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
    const place = (geo, mat, arr, scaleBase, scaleVary) => {
      if (!arr.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, arr.length);
      inst.castShadow = true; inst.receiveShadow = true;
      arr.forEach(([x, y], i) => {
        const gh = heightAt(x, y);
        const s = scaleBase + hash(x + 3, y) * scaleVary;
        const rot = hash(x + 5, y + 5) * 6.2832;
        Q.setFromAxisAngle(UP, rot); M.compose(P.set(x, gh, y), Q, S.set(s, s, s)); inst.setMatrixAt(i, M);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;   // 实例包围盒默认在原点，整片会被误剔除（见 VegetationLayer 同一注释）
      this.scene.add(inst); this.meshes.push(inst);
    };
    if (showPillars) {
      place(wallPostGeo(SV), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), posts, 1.0, 0.15);
      // 围墙用同一套柱子几何，尺寸略大一档——高地围墙是防御工事，视觉分量应该
      // 比兵线/野区边界那圈装饰性城墙更重一些。
      place(wallPostGeo(SV), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), wallRingPosts, 1.3, 0.1);
    }
    place(stylizedTreeGeo(map), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), natTrees, 0.85, 0.35);
    place(new THREE.IcosahedronGeometry(12, 0), new THREE.MeshLambertMaterial({ color: SV.rockColor || '#8a8f96', flatShading: true }), natRocks, 0.8, 0.4);
    // 高地石墙笔刷（素材库）：笔刷显式画的石墙，不受 showPillars 这个地图级默认
    // 开关约束——召唤师峡谷把默认城墙柱子关掉是"这张图整体不要柱子"这条全局
    // 偏好，但作者在野区某一段显式选了"石墙"风格是更具体的信号，应该覆盖它。
    place(wallPostGeo(SV), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), styledPosts, 1.0, 0.15);
  }
}
