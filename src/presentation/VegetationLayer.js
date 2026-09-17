/**
 * VegetationLayer.js —— 野区植被（P1 视觉优化）
 *
 * 零美术素材：程序化低多边形树/岩/灌木，按【不可行走的野区】散布，把原本空洞发黑的野区填满。
 * 全部用 InstancedMesh（每类一次 draw call，几百上千棵近乎零开销）。位置/缩放/旋转由坐标哈希
 * 决定——确定性，切图重建结果稳定，无逐帧开销。仅渲染，仿真不读，与玩法/回归无关。
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { WALL_H } from './WallLayer.js';
import { stylizedPaletteOf } from '../data/Config.js';
import { forestZoneAt } from '../data/mapValidate.js';
import { isInBaseWallRing } from '../data/baseCircle.js';
import { applyWindSway, updateWindSway, clearWindSwayRegistry } from './VegetationShaderPatch.js';

// v58：导出给 BoundaryDecorLayer 复用——野区内部（不可走的迷宫墙块）边界的
// "自然感"装饰要用同一套树/坐标哈希，不重新写一份几何生成逻辑。
export function withColor(geo, hex) {
  const c = new THREE.Color(hex), n = geo.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
// 树 = 棕色树干 + 两层绿色松冠，合并成一份带顶点色的几何（一次 draw call 靠 Instanced）
function treeGeo() {
  const trunk = withColor(new THREE.CylinderGeometry(3, 4.5, 15, 6).translate(0, 7.5, 0), '#6b5230');
  const c1 = withColor(new THREE.ConeGeometry(16, 32, 7).translate(0, 30, 0), '#5aa64e');
  const c2 = withColor(new THREE.ConeGeometry(11, 22, 7).translate(0, 44, 0), '#78c866');
  return mergeGeometries([trunk, c1, c2]);
}

// 2026-09-04：风格化 demo（见 Config.stylizedPalettes 头注）——树冠换成圆润的
// 球体团簇（参照实拍截图：Thronefall 的树是几个球挤在一起，不是锥形松树尖顶）。
// 材质在 place() 那边套 flatShading:true，硬切面的观感靠材质标记，不靠这里加细分。
//
// v59：新增 deep 参数——森林深度分级（forestZoneAt）里"深林"这一档用更暗更饱和
// 的树冠色（treeCrownDeepA/B），跟"普通森林"拉开一档，颜色随深度加深才读得出
// "越往里走越密越暗"的层次，不是所有树都长一个样。没声明这两个字段的调色板
// 退回普通树冠色，逐位不变。
export function stylizedTreeGeo(map, deep = false) {
  const SV = stylizedPaletteOf(map);
  // ⚠️ mergeGeometries 要求参与合并的几何"要么全带 index，要么全不带"（否则直接
  // 失败返回 null，下游 place() 拿到 null 几何再崩一次）。CylinderGeometry 默认带
  // index，IcosahedronGeometry（PolyhedronGeometry 系）默认不带——两者混着合并
  // 踩了这一条，这里统一 .toNonIndexed() 到"都不带"那一档。
  const trunk = withColor(new THREE.CylinderGeometry(3, 4, 13, 6).translate(0, 6.5, 0).toNonIndexed(), SV.treeTrunkColor || '#6b5230');
  const A = deep ? (SV.treeCrownDeepA || SV.treeCrownColorA || '#4f9a52') : (SV.treeCrownColorA || '#4f9a52');
  const B = deep ? (SV.treeCrownDeepB || SV.treeCrownColorB || '#6cbb5e') : (SV.treeCrownColorB || '#6cbb5e');
  const blobs = [
    [0, 32, 0, 16, A], [-10, 24, 6, 12, B], [10, 25, -5, 12, A],
    [0, 19, 10, 10, B], [-7, 40, -7, 11, A], [6, 41, 6, 10, B],
  ];
  const parts = [trunk, ...blobs.map(([x, y, z, r, hex]) => withColor(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z), hex))];
  return mergeGeometries(parts);
}
// 坐标哈希 → [0,1)，确定性伪随机
export function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967295;
}

export class VegetationLayer {
  constructor(scene) { this.scene = scene; this.meshes = []; this._mapId = null; }

  clear() {
    for (const m of this.meshes) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.meshes = [];
    // 换图/重建时把风摆动注册表也清空——VegetationShaderPatch 的登记表是模块级
    // 全局的（只有这个文件在用它），不清的话旧地图那批已经 dispose 掉的材质会
    // 一直留在里面被 updateWindSway() 白白遍历，是个真实的内存/CPU 泄漏。
    clearWindSwayRegistry();
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    if (!map || !map.world || !mapSystem.hasWalls || !mapSystem.hasWalls()) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.meshes.length) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;

    const stylized = map.visualStyle === 'stylized';
    // 2026-09-04：冰封版嚎哭深渊（见 docs/MAP-DESIGN-howling-abyss-frost.md 第 4.1
    // 节）——这张图的不可走区域是水/浮冰，不是森林，硬套下面这套"野区=树林"的
    // 散布逻辑会变成"水里长树"。调色板声明 vegetationMode:'none' 时整段跳过，
    // 水域装饰改由该图专用的 HowlingAbyssDecor.js 负责。default 调色板没有这个
    // 字段，三张老地图和 demo_stylized_v1 都不受影响。
    if (stylized && stylizedPaletteOf(map).vegetationMode === 'none') { this.clear(); this._mapId = map.id; return; }
    // v58：召唤师峡谷这类 LoL 式地图的野区本身可走（单位能在里面走、打野），
    // default/frost 那套"只在不可走区域长树"的判据对它没有意义。调色板声明
    // vegetationMode:'jungle' 时改走森林深度分级（见下方 v59 注释与 forestZoneAt）。
    const jungleMode = stylized && stylizedPaletteOf(map).vegetationMode === 'jungle';
    const { w: WW, h: WH } = map.world;
    const heightAt = mapSystem.heightAt ? (x, z) => mapSystem.heightAt(x, z) : () => 0;
    const walk = (x, y) => mapSystem.isWalkable(x, y);
    const trees = [], deepTrees = [], rocks = [], bushes = [];
    // navgrid 地形下墙块较窄（野区可走、只有墙块不可走），内部余量过大会几乎选不出点 → 放宽到 26。
    const STEP = 55, margin = 26, edge = 90;   // 采样步长 / 内部余量(不贴车道边，仅 default/frost 分支用) / 离图边余量
    for (let gx = edge; gx < WW - edge; gx += STEP) for (let gy = edge; gy < WH - edge; gy += STEP) {
      const x = gx + (hash(gx + 11, gy) - 0.5) * STEP * 0.8;
      const y = gy + (hash(gx, gy + 11) - 0.5) * STEP * 0.8;
      // v59.1：改按"能不能走"分层，不再是纯粹按离兵线距离铺密度。
      // 用户看了森林深度分级第一版截图反馈："依旧没有结构，糊成一团。野区的道路
      // 上应该是没有任何障碍物的"——根因是分级只按"离兵线多远"算密度，完全没看
      // walk(x,y)，于是野区里真正可走的路径/空地（navgrid 里那条"迷宫"实际走的
      // 通道）也被按同样密度铺满了树，整片野区看不出哪里是路、哪里是障碍物，
      // 读成了一坨糊在一起的绿色。
      // 现在：可走的野区路径/空地——保持接近通透（用户原话），只留很少量低矮
      // 点缀；不可走的野区内部障碍物——这才是"森林"的实体，按 forestZoneAt
      // （离兵线的距离）决定深浅/密度，越往深处越密越暗。
      // 基地高地围墙那一圈（isInBaseWallRing）单独摘出去：那本来就是不可走的
      // 墙体，但用户明确说"应该是围墙（石墙）"，不该长树——交给 BoundaryDecorLayer
      // 新增的围墙装饰负责，这里跳过，避免同一块地皮墙和树打架。
      let zone = 0, onPath = false;
      if (jungleMode) {
        zone = forestZoneAt(map, x, y);
        if (zone === 0) continue;   // 道路本身/基地开放广场核心，不摆
        if (isInBaseWallRing(map, x, y)) continue;   // 基地围墙那一圈交给 BoundaryDecorLayer
        onPath = walk(x, y);
        const skipRoll = hash(gx + 21, gy);
        const skipThresh = onPath ? 0.90 : (zone === 1 ? 0.30 : zone === 2 ? 0.10 : 0);
        if (skipRoll < skipThresh) continue;
      } else {
        if (walk(x, y)) continue;                                             // 只在野区(不可走)放
        if (walk(x + margin, y) || walk(x - margin, y) || walk(x, y + margin) || walk(x, y - margin)) continue; // 内部，不贴车道/高地边
      }
      const gh = heightAt(x, y);
      if (gh < -2) continue;                                                // 河床不放
      // ⚠️ 摆放高度是【墙顶】，不是地面高度。用户："你这做的植被都跑到了贴图底下，
      // 正常根本看不到。" 根因：植被只撒在【不可走】的格子上（野区/墙块），
      // 而 WallLayer 把不可走区整块拔高到 WALL_H(70) 画成台地 ——
      // 而这里取的 heightAt 是**地形高度场**，压根不含墙体那 70 单位。
      // 于是每一棵树都被埋在自己脚下那块墙体里，一棵也看不见。
      // 往下沉 1.5：树干底面正好咬进墙顶，不会看到悬空的接缝。
      // 风格化 demo（visualStyle==='stylized'）没有台地——WallLayer.rebuild() 对这种
      // 地图整个跳过，不可走区域的地面仍是普通地形高度，植被因此改按【地形高度】摆放，
      // 不是墙顶，否则会悬空在空气里（没有台地接住它）。
      const y0 = stylized ? gh : WALL_H - 1.5;
      const r = hash(gx, gy);
      const sc = 0.65, rot = hash(gx + 5, gy + 5) * 6.2832;
      if (jungleMode) {
        if (onPath) {
          // 可走的路径/空地：只留极少量低矮灌木/零星石头做点缀，不摆树——
          // 用户："野区的道路上应该是没有任何障碍物的"，保持通透好读路。
          if (r < 0.35) rocks.push([x, y0, y, sc + hash(gx + 3, gy) * 0.9, rot]);
          else bushes.push([x, y0, y, sc + hash(gx + 9, gy) * 0.8, rot]);
        } else if (zone <= 2) {
          // 普通森林（不可走的障碍物本体）：树为主体，灌木/石头点缀。
          if (r < 0.5) trees.push([x, y0, y, sc + hash(gx + 7, gy) * 0.7, rot]);
          else if (r < 0.75) bushes.push([x, y0, y, sc + hash(gx + 9, gy) * 0.8, rot]);
          else rocks.push([x, y0, y, sc + hash(gx + 3, gy) * 0.9, rot]);
        } else {
          // 深林（不可走障碍物，离兵线最远）：密度最高、体量略大，树用更暗的
          // 深色变体，读出"越往里走越密越暗"。
          const scBig = sc * 1.15;
          if (r < 0.6) deepTrees.push([x, y0, y, scBig + hash(gx + 7, gy) * 0.7, rot]);
          else if (r < 0.85) bushes.push([x, y0, y, scBig + hash(gx + 9, gy) * 0.6, rot]);
          else rocks.push([x, y0, y, scBig + hash(gx + 3, gy) * 0.7, rot]);
        }
      } else {
        if (r < 0.44) trees.push([x, y0, y, sc + hash(gx + 7, gy) * 0.7, rot]);
        else if (r < 0.70) rocks.push([x, y0, y, sc + hash(gx + 3, gy) * 0.9, rot]);
        else if (r < 0.88) bushes.push([x, y0, y, sc + hash(gx + 9, gy) * 0.8, rot]);
      }
    }

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(),
          S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
    // 本轮（Phase 2：风吹植被）：sway=true 的调用会额外给每个实例算一份"相位"
    // （按树的世界坐标哈希，不是数组下标——见 VegetationShaderPatch.js 头注为什么
    // 不能用下标），装成 InstancedBufferAttribute 喂给 applyWindSway。只对树/
    // 深林树传 true——灌木/岩石这一轮先不摆，等树的效果验证过手感自然再考虑扩展。
    const place = (geo, mat, arr, vary, sway) => {
      if (!arr.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, arr.length);
      inst.castShadow = true; inst.receiveShadow = true;
      const phase = sway ? new Float32Array(arr.length) : null;
      arr.forEach(([x, y, z, s, rot], i) => {
        Q.setFromAxisAngle(UP, rot); M.compose(P.set(x, y, z), Q, S.set(s, s, s)); inst.setMatrixAt(i, M);
        if (vary) { C.setHSL(vary.h + (hash(x + 1, z) - 0.5) * vary.dh, vary.s, vary.l + (hash(z + 1, x) - 0.5) * vary.dl); inst.setColorAt(i, C); }
        if (phase) phase[i] = hash(x * 7 + 3, z * 7 + 3) * Math.PI * 2;
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.frustumCulled = false;   // 实例包围盒默认在原点，整片会被误剔除
      inst.userData.baseColor = mat.color.clone();   // v59：setTint 要乘这个底色，不能直接覆盖掉（见 setTint 头注）
      if (phase) {
        inst.geometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(phase, 1));
        applyWindSway(inst.geometry, mat);
      }
      this.scene.add(inst); this.meshes.push(inst);
    };
    if (stylized) {
      // 风格化 demo：flatShading:true 给硬切面观感（参照截图里岩石/树冠都是平面
      // 色阶，不是平滑渐变），树/岩/灌木各自一个声明出来的纯色，不叠 HSL 随机抖动
      // ——克制色板是这条风格的核心，不是这里漏做了"多样性"。
      const SV = stylizedPaletteOf(map);
      place(stylizedTreeGeo(map, false), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), trees, null, true);
      // v59：深林树用更暗的深色变体（treeCrownDeepA/B），单独一个 InstancedMesh。
      place(stylizedTreeGeo(map, true), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), deepTrees, null, true);
      place(new THREE.IcosahedronGeometry(12, 0), new THREE.MeshLambertMaterial({ color: SV.rockColor || '#8a8f96', flatShading: true }), rocks, null);
      place(new THREE.IcosahedronGeometry(14, 0).scale(1, 0.6, 1), new THREE.MeshLambertMaterial({ color: SV.treeCrownColorB || '#6cbb5e', flatShading: true }), bushes, null);
    } else {
      place(treeGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), trees, null, true);
      place(new THREE.IcosahedronGeometry(12, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), rocks, { h: 0.08, s: 0.12, l: 0.52, dh: 0.03, dl: 0.10 });
      place(new THREE.IcosahedronGeometry(14, 0).scale(1, 0.55, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), bushes, { h: 0.27, s: 0.45, l: 0.40, dh: 0.05, dl: 0.08 });
    }
    if (this._tint) this.setTint(this._tint);   // 重建时把当前昼夜染色补回去（否则重建那一帧会闪回白天的颜色）
  }

  /**
   * v47：野区植被跟着昼夜一起变色，与单位走同一个染色值。
   *
   * 用户报的是"兵在黑暗中很突兀"，根因是反照率差（见 DayNight.unitTintOf）。
   * 植被里的石头与灌木用的是同一套高反照率白底 + instanceColor（石头 l=0.52），
   * **是同一个毛病的同一个位置** —— 夜里满野区发白的小点就是它们。
   * 只染单位不染植被的话，画面里仍然有一半东西不融入环境，
   * 而这两件事的成因、修法、参数完全一致，没有理由分开处理。
   *
   * ⚠️ 石头/灌木的 material.color 是白色**乘数**（真实颜色在 instanceColor 里），
   * 树是 vertexColors —— 三者都吃 material.color 的乘法，所以一句话全覆盖。
   *
   * v59 修正：上面这条注释只对"default/frost 那套白底+instanceColor"成立——
   * 风格化分支（stylized，见 build() 里的 SV.rockColor/treeCrownColorB 等）的
   * 石头/灌木/树没有 instanceColor，材质的 color 本身就是调色板声明的颜色，
   * 直接 `material.color.set(hex)` 会把这份颜色整个覆盖掉，变成"所有种类的
   * 装饰物同一个颜色"（森林深度分级要靠深林树冠用更暗的颜色才读得出层次，
   * 被昼夜染色直接吃掉就白做了）。改成"乘底色"而不是"替换底色"：place() 里把
   * 每个材质创建时的原始 color 存进 inst.userData.baseColor，这里用
   * 底色×tint 而不是 tint 本身——对 default/frost 那套本来就是白色底
   * （1×tint===tint），结果逐位不变；对 stylized 那套则保留了调色板颜色，
   * 只被昼夜的明暗/冷暖乘调，不会被昼夜颜色整个吃掉。
   */
  /**
   * 每帧调用：把风强度写进树/深林树的摆动 shader。dt 走墙钟（暂停时风也该继续
   * 吹，跟 WeatherLayer/WaterLayer 同口径），windStrength 是风的 charge（0~1）。
   */
  update(dt, windStrength) {
    updateWindSway(dt, Math.max(0, Math.min(1, windStrength || 0)));
  }

  setTint(hex) {
    this._tint = hex;
    const t = new THREE.Color(hex);
    for (const m of this.meshes) {
      if (!m.material?.color) continue;
      const base = m.userData.baseColor;
      if (base) m.material.color.copy(base).multiply(t);
      else m.material.color.set(hex);   // 兜底：没有记录底色的极端情况，保留旧行为
    }
  }
}
