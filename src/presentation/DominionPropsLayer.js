/**
 * DominionPropsLayer.js —— 统治战场·据点环境装饰（2026-09-26 新增）
 *
 * 背景：用户看完水晶之痕的实机截图反馈"剩下光秃秃的一片，可以按照据点的
 * 每个名称来做对应的环境装饰"。经 AskUserQuestion 向用户确认过两件事：
 *   ①装饰走"实体化具体场景物"（风车真的立一座风车、钻机放一台钻井机械、
 *     采石场堆石块矿坑、兽骨场散落骸骨、精炼厂放油罐管道），不是抽象的
 *     地表/氛围装饰；
 *   ②整体基调走"荒野竞技场"（干裂黄土、裸岩、枯草的荒原感，呼应地图本身
 *     的黄沙/工业风），沿用地图已声明的 paletteId:'desert' 调色板，不新开
 *     一套配色体系。
 * 具体到每个据点的内容方案（风车/钻机/采石场/兽骨场/精炼厂各自长什么样）
 * 同样经用户确认后才动手实现，方案与最终代码逐一对应，不是凭空猜的版本。
 *
 * ==================== 通用件，不是这一张图专属 ====================
 * 只要地图声明了 `dominionNodes`（kind:'point' 的节点），这一层就会给每个
 * 节点摆一套跟节点 id 对应的主题道具——以后任何复用统治战场机制的新图，
 * 只要据点 id 撞上下面 BUILDERS 里登记的名字，装饰自动跟着有，不用重写。
 * 没声明 dominionNodes 或不是 stylized 地图的，这一层什么也不做，不影响
 * 其它任何现有地图。
 *
 * ==================== 摆放位置为什么要偏移，不直接摆在 node.pos 上 ====================
 * node.pos 既是据点占领实体的坐标，也是环形兵线上的一个路点——道具如果摆在
 * 正中间，会跟据点本身的模型、以及经过的小兵撞在一起（视觉穿模+挡路）。
 * 这里把每一套道具沿"背离环心"的径向方向整体推出去一段（DOMINION_PROPS
 * .radialOffset），落在节点周围那圈额外撑开的空地（NODE_BULGE=230）靠外
 * 沿，同时躲开环形走廊本身（CORRIDOR_HALF=140）——纯几何计算，不依赖这张图
 * 具体是圆形，径向方向直接从 map.world 的几何中心算，换一张非圆形布局的图
 * 一样能用（退化成"从地图中心指向节点"的方向）。
 *
 * ==================== 风格：跟本项目已有装饰层同一套语言 ====================
 * 低多面体几何（Cylinder/Icosahedron/Box/Torus）+ MeshLambertMaterial
 * flatShading，不用贴图、不用粒子——跟 HowlingAbyssDecor.js/BoundaryDecorLayer
 * .js 是同一套"确定性伪随机摆放 + 简单几何体"的做法，颜色能走调色板的走
 * stylizedPaletteOf()，纯装饰性的局部配色（生锈金属/白骨/木头）跟那两个
 * 文件一样留作模块内命名常量，不是"硬编码的待改数值"——这条本项目已有先例
 * （见 HowlingAbyssDecor.js 的 bowlMat/flameMat 等），第二条铁律管的是玩法
 * 数值，不要求把每一根柱子的几何常量都塞进 CONFIG。
 */
import * as THREE from '../../vendor/three.module.js';
import { stylizedPaletteOf } from '../data/Config.js';
import { hash } from './VegetationLayer.js';

const toScene = (x, y, h = 0) => new THREE.Vector3(x, h, y);

// 道具整体沿径向推出去的距离：CORRIDOR_HALF(140) < 此值 < NODE_BULGE(230)，
// 稳稳落在节点周围的空地里、躲开环形走廊本身。
const RADIAL_OFFSET = 175;

// ==================== 通用材质色（跨主题共用，不随调色板变化）====================
const RUST_METAL = '#8a5a3a';       // 生锈金属主色（钻机/精炼厂）
const RUST_METAL_DARK = '#5f3d28';  // 生锈金属暗部
const BONE_COLOR = '#e8ddc0';       // 骸骨（兽骨场）
const WOOD_COLOR = '#6b4a30';       // 风车木结构

function mat(color) { return new THREE.MeshLambertMaterial({ color, flatShading: true }); }

// ==================== ① 风车（windmill）====================
// 石基木塔 + 顶部十字静态旋翼（用户确认不做旋转动画，成本更低且没有先例）。
function buildWindmill(group, pos, SV) {
  const stoneMat = mat(SV.rockColor || '#9c5a42');
  const woodMat = mat(WOOD_COLOR);
  const bladeMat = mat(SV.wallCapColor || '#d9b878');

  const towerH = 70;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(9, 15, towerH, 8), stoneMat);
  tower.position.copy(toScene(pos.x, pos.y, towerH / 2));
  group.add(tower);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(12, 16, 8), woodMat);
  roof.position.copy(toScene(pos.x, pos.y, towerH + 8));
  group.add(roof);

  // 旋翼平面朝径向外侧，让固定俯视角度下叶片不至于完全侧视消失。
  const facing = Math.atan2(pos.dirY, pos.dirX);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 4, 8), woodMat);
  hub.position.copy(toScene(pos.x, pos.y, towerH));
  hub.rotation.x = Math.PI / 2;
  hub.rotation.z = facing;
  group.add(hub);

  const bladeGeo = new THREE.BoxGeometry(30, 8, 1.5);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.copy(toScene(pos.x, pos.y, towerH));
    blade.rotation.y = facing;
    blade.rotation.x = (i * Math.PI) / 2;
    blade.translateX(15);
    group.add(blade);
  }
}

// ==================== ② 钻机（drill）====================
// 生锈井架（锥形塔身+顶部滑轮）+ 周边碎石堆。
function buildDrill(group, pos) {
  const metalMat = mat(RUST_METAL);
  const metalDarkMat = mat(RUST_METAL_DARK);
  const rockMat = mat('#6e6a60');

  const rigH = 62;
  const rig = new THREE.Mesh(new THREE.CylinderGeometry(3, 17, rigH, 4), metalMat);
  rig.position.copy(toScene(pos.x, pos.y, rigH / 2));
  rig.rotation.y = Math.PI / 4;
  group.add(rig);

  const mastH = 18;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, mastH, 6), metalDarkMat);
  mast.position.copy(toScene(pos.x, pos.y, rigH + mastH / 2));
  group.add(mast);

  const pulley = new THREE.Mesh(new THREE.TorusGeometry(4, 1.1, 6, 10), metalDarkMat);
  pulley.position.copy(toScene(pos.x, pos.y, rigH + mastH));
  group.add(pulley);

  // 卧倒管道，斜靠在井架一侧。
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 34, 6), metalMat);
  pipe.position.copy(toScene(pos.x + 12, pos.y + 6, 2));
  pipe.rotation.z = Math.PI / 2;
  pipe.rotation.y = hash(pos.x, pos.y) * 6.2832;
  group.add(pipe);

  const pileN = 3;
  for (let i = 0; i < pileN; i++) {
    const a = hash(pos.x + i * 13, pos.y - i * 7) * Math.PI * 2;
    const d = 22 + hash(pos.x - i * 5, pos.y + i * 3) * 14;
    const rx = pos.x + Math.cos(a) * d, ry = pos.y + Math.sin(a) * d;
    const s = 4 + hash(rx, ry) * 3;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), rockMat);
    rock.position.copy(toScene(rx, ry, s * 0.4));
    rock.scale.set(s, s * 0.7, s);
    rock.rotation.y = hash(rx + 3, ry + 3) * 6.2832;
    group.add(rock);
  }
}

// ==================== ③ 采石场（quarry）====================
// 凹陷矿坑（下沉圆盘）+ 堆叠矿石块 + 一个简易悬臂吊架。
function buildQuarry(group, pos, SV) {
  const pitMat = mat(new THREE.Color(SV.groundColor || '#3a2410').multiplyScalar(0.7).getHex());
  const oreMatA = mat(SV.rockColor || '#9c5a42');
  const oreMatB = mat('#7a6a55');
  const metalMat = mat(RUST_METAL_DARK);

  const pitR = 55;
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(pitR, pitR * 1.08, 6, 16), pitMat);
  pit.position.copy(toScene(pos.x, pos.y, -3));
  group.add(pit);

  const pileCount = 3;
  for (let p = 0; p < pileCount; p++) {
    const a = (p / pileCount) * Math.PI * 2 + hash(pos.x + p, pos.y) * 1.5;
    const d = pitR * 0.45;
    const cx = pos.x + Math.cos(a) * d, cy = pos.y + Math.sin(a) * d;
    const stack = 2 + Math.floor(hash(cx, cy) * 2);
    let stackH = 0;
    for (let i = 0; i < stack; i++) {
      const s = 12 + hash(cx + i * 5, cy - i * 3) * 10;
      const block = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), hash(cx + i, cy + i) < 0.5 ? oreMatA : oreMatB);
      block.position.copy(toScene(
        cx + (hash(cx + i * 9, cy) - 0.5) * 8,
        cy + (hash(cx, cy + i * 9) - 0.5) * 8,
        stackH + s * 0.5));
      block.scale.set(s, s * 0.8, s);
      block.rotation.y = hash(cx + i * 4, cy + i * 4) * 6.2832;
      group.add(block);
      stackH += s * 0.7;
    }
  }

  // 简易悬臂吊架：一根立柱 + 一根斜撑臂。
  const postH = 34;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.6, postH, 6), metalMat);
  post.position.copy(toScene(pos.x - pitR * 0.7, pos.y - pitR * 0.7, postH / 2));
  group.add(post);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 40, 6), metalMat);
  arm.position.copy(toScene(pos.x - pitR * 0.7 + 14, pos.y - pitR * 0.7 + 14, postH - 4));
  arm.rotation.z = Math.PI / 2;
  arm.rotation.y = -Math.PI / 4;
  group.add(arm);
}

// ==================== ④ 兽骨场（boneyard）====================
// 惨白肋骨拱（半环）+ 散落骸骨。
function buildBoneyard(group, pos) {
  const boneMat = mat(BONE_COLOR);

  const archCount = 3;
  for (let i = 0; i < archCount; i++) {
    const a = hash(pos.x + i * 17, pos.y - i * 5) * Math.PI * 2;
    const d = 14 + hash(pos.x - i, pos.y + i) * 20;
    const cx = pos.x + Math.cos(a) * d, cy = pos.y + Math.sin(a) * d;
    const r = 16 + hash(cx, cy) * 8;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(r, 1.6, 6, 10, Math.PI * 0.85), boneMat);
    arch.position.copy(toScene(cx, cy, 1));
    arch.rotation.x = Math.PI / 2;
    arch.rotation.z = a + Math.PI / 2;
    // 部分肋骨半倒塌，不是每一具都立得笔直——荒野里的骸骨该是散乱的。
    arch.rotation.y = (hash(cx + 3, cy + 3) - 0.5) * 0.6;
    group.add(arch);
  }

  const skullCount = 5;
  for (let i = 0; i < skullCount; i++) {
    const a = hash(pos.x + i * 23, pos.y + i * 11) * Math.PI * 2;
    const d = 10 + hash(pos.x - i * 3, pos.y + i * 7) * 26;
    const sx = pos.x + Math.cos(a) * d, sy = pos.y + Math.sin(a) * d;
    const s = 4.5 + hash(sx, sy) * 2;
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), boneMat);
    skull.position.copy(toScene(sx, sy, s * 0.5));
    skull.scale.set(s, s * 0.85, s * 1.1);
    skull.rotation.y = hash(sx + 5, sy + 5) * 6.2832;
    group.add(skull);
  }
}

// ==================== ⑤ 精炼厂（refinery）====================
// 2~3 个生锈金属油罐 + 连接管道。
function buildRefinery(group, pos) {
  const tankMat = mat(RUST_METAL);
  const tankMatDark = mat(RUST_METAL_DARK);
  const pipeMat = mat(RUST_METAL_DARK);

  const tanks = [
    { dx: -16, dy: 0, r: 16, h: 40 },
    { dx: 14, dy: 10, r: 12, h: 32 },
    { dx: 6, dy: -16, r: 10, h: 26 },
  ];
  const centers = [];
  tanks.forEach((t, i) => {
    const cx = pos.x + t.dx, cy = pos.y + t.dy;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(t.r, t.r, t.h, 12), tankMat);
    body.position.copy(toScene(cx, cy, t.h / 2));
    group.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 1.05, t.r * 1.05, 2, 12), tankMatDark);
    cap.position.copy(toScene(cx, cy, t.h + 1));
    group.add(cap);
    centers.push({ x: cx, y: cy, r: t.r, h: t.h });
  });

  // 相邻油罐之间连一根横向管道。
  for (let i = 0; i < centers.length - 1; i++) {
    const a = centers[i], b = centers[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const midH = Math.min(a.h, b.h) * 0.6;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, len, 6), pipeMat);
    pipe.position.copy(toScene((a.x + b.x) / 2, (a.y + b.y) / 2, midH));
    pipe.rotation.z = Math.PI / 2;
    pipe.rotation.y = -Math.atan2(dy, dx);
    group.add(pipe);
  }
}

const BUILDERS = {
  windmill: buildWindmill,
  drill: buildDrill,
  quarry: buildQuarry,
  boneyard: buildBoneyard,
  refinery: buildRefinery,
};

export class DominionPropsLayer {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
    this.shadowLevel = 'off';
  }

  clear() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.scene.remove(this.group);
    this.group = null;
  }

  setShadowLevel(level) {
    this.shadowLevel = level;
    if (!this.group) return;
    const on = level !== 'off';
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = on; o.receiveShadow = on; } });
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    const stylized = !!(map && map.visualStyle === 'stylized');
    const points = stylized && Array.isArray(map.dominionNodes)
      ? map.dominionNodes.filter((n) => n.kind === 'point' && BUILDERS[n.id])
      : [];
    if (!points.length) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.group) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;

    const SV = stylizedPaletteOf(map);
    const group = new THREE.Group();
    this.group = group;
    this.scene.add(group);

    const cx = map.world.w / 2, cy = map.world.h / 2;
    for (const node of points) {
      const dx = node.pos.x - cx, dy = node.pos.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const dirX = dx / dist, dirY = dy / dist;
      const pos = {
        x: node.pos.x + dirX * RADIAL_OFFSET,
        y: node.pos.y + dirY * RADIAL_OFFSET,
        dirX, dirY,
      };
      BUILDERS[node.id](group, pos, SV);
    }
    this.setShadowLevel(this.shadowLevel);
  }
}
