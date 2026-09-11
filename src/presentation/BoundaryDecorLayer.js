/**
 * BoundaryDecorLayer.js —— 森林风格地图·兵线/野区边界装饰（v58 新增，通用件）
 *
 * 背景：用户看了森林风格召唤师峡谷的截图后，发来带标注的截图追加两条要求：
 * 「粉色那里应该是城墙（墙壁）」——兵线与野区交界处要有一圈石头+金色的"城墙"；
 * 「至于野区的墙壁你就想想怎么实现吧，用自然的感觉（树、石头、等）」——野区内部
 * 迷宫状不可走障碍物的边缘，用户把"怎么做"完全交给我判断：这里选的是"加密
 * 灌木/岩簇"而不是另建一圈人工墙——那些障碍物本来就是野区里天然长的地形阻挡，
 * 围一圈人工建筑反而不像野区。
 *
 * v58.5：用户看完第一版反馈"看不出一点森林的样子……都是低矮的灌木丛和零星的
 * 石头"——召唤师峡谷的视觉方向从一开始就是用户定的"明亮草地+石头+金色"
 * （没有树），这里最初复用 VegetationLayer 的高大松树造型摆在障碍物边缘不合适，
 * 已改成矮扁的灌木团+岩石，不再用树。
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
import { withColor, hash } from './VegetationLayer.js';

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
// v58.5：灌木团+岩石，不用树——召唤师峡谷是"明亮草地+石头+金色"，没有树这个
// 元素（用户原话）。灌木用与 VegetationLayer 同款的压扁二十面体，坐标哈希复用
// VegetationLayer 导出的 hash，不重新写一份随机数生成。
const NAT_SPACING = 55;     // 比普通野区植被(VegetationLayer 的 STEP=62)略密，边缘要"看起来更挤"
const NAT_PROBE = 42;       // 比普通植被的 margin(26) 更大：要探到确实贴着障碍物才算数，不是随便挨着不可走区就算
const NAT_JITTER = 0.8;     // 与 VegetationLayer 同量级的散布抖动，避免整排等距显得死板

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

    const { w: WW, h: WH } = map.world;
    const walk = (x, y) => mapSystem.isWalkable(x, y);
    const heightAt = mapSystem.heightAt ? (x, z) => mapSystem.heightAt(x, z) : () => 0;
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
    const natBushes = [], natRocks = [];
    for (let gx = edge; gx < WW - edge; gx += NAT_SPACING) {
      for (let gy = edge; gy < WH - edge; gy += NAT_SPACING) {
        const x = gx + (hash(gx + 31, gy) - 0.5) * NAT_SPACING * NAT_JITTER;
        const y = gy + (hash(gx, gy + 31) - 0.5) * NAT_SPACING * NAT_JITTER;
        if (!walk(x, y)) continue;
        if (isLaneCell(map, x, y)) continue;   // 只加密野区一侧，路面不摆
        const surrounded = walk(x + NAT_PROBE, y) && walk(x - NAT_PROBE, y) && walk(x, y + NAT_PROBE) && walk(x, y - NAT_PROBE);
        if (surrounded) continue;              // 四周都可走，说明没贴着障碍物，跳过
        // v58.6：与 VegetationLayer 同一条权重修正——灌木为主、石头点缀。
        (hash(gx + 3, gy) < 0.8 ? natBushes : natRocks).push([x, y]);
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
    place(wallPostGeo(SV), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), posts, 1.0, 0.15);
    place(new THREE.IcosahedronGeometry(14, 0).scale(1, 0.6, 1), new THREE.MeshLambertMaterial({ color: SV.treeCrownColorB || '#6cbb5e', flatShading: true }), natBushes, 0.85, 0.5);
    place(new THREE.IcosahedronGeometry(12, 0), new THREE.MeshLambertMaterial({ color: SV.rockColor || '#8a8f96', flatShading: true }), natRocks, 0.8, 0.4);
  }
}
