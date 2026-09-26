/**
 * DominionPropsLayer.js —— 统治战场·据点环境装饰（2026-09-26 新增，同日追加第二轮）
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
 * ==================== 第二轮：用户反馈"整张图还是光秃秃" ====================
 * 用户拿实机截图找 GPT 做视觉评估，GPT 的诊断（用户认可）是"不是细节太少，
 * 是没有建立视觉层级"——第一轮的 5 个据点道具虽然存在（构建时确实生成了
 * 网格，用 page.evaluate 数过 40 个子节点），但相对于 2200×2200 的世界尺寸
 * 和默认缩放下的相机距离，个头太小、跟背景色对比不够，实际画面里几乎看不出来。
 * 这一轮不是"从零做"，是在同一批建造函数基础上：
 *   ①整体放大约 1.4~1.8 倍，并给每个据点补 1~2 件关联道具，让它读成一个
 *     "功能区"而不是一个孤立小模型（用户认可的 GPT 方案里"每个据点应该是
 *     一个场景，不是一个图标"）；
 *   ②新增据点归属旗（据点旁一根旗杆+旗面，旗面颜色跟随 `_captureOwner`
 *     实时变化）——用户在澄清问答里选了"要做（推荐，呼应参考图）"；
 *   ③新增水晶枢纽两侧的旗杆装饰，用固定阵营色，呼应"基地应该比据点更有
 *     视觉分量"这条反馈，但不重做枢纽水晶本体（那是 UnitLayer 的塔模型，
 *     不归这一层管，重做水晶模型是另一件事，这次不做）；
 *   ④新增地形装饰：中央不可走区域（两个枢纽"眼睛"之间的颈部+外圈不可走
 *     边角）撒一批低模岩石/枯木/骨渣，把"这里没做完"的空白感变成"这里
 *     本来就是荒芜地貌"——判据只看 navgrid 的 isWalkable，绝不会撒在小兵
 *     能走的地方（跟 HowlingAbyssDecor.js 的浮冰/瓦砾摆放同一条底线）。
 * 颜色/密度这类纯装饰性数值继续按 HowlingAbyssDecor.js 已有先例留作模块内
 * 命名常量，不算 CLAUDE.md 第二条铁律要盯的"玩法数值硬编码"。
 *
 * ==================== 第三轮：用户转述 GPT 的评估——"撒石头填空白不是设计地形" ====================
 * 用户原话："这版最大的问题不是'做得不好看'，而是根本没理解你要解决的视觉
 * 问题……它把'不可行走区域'做成了一个巨大的黑洞……完全没利用'沙漠峡谷'这个
 * 主题……没有视觉层级"。这轮不再是"加更多同类型的小道具"，是三处结构性补课：
 *   ①**"黑洞"变真峡谷**：地图文件新增 `terrainEdge` 声明（复用
 *     `TerrainEdgeLayer.js`——设计文档写明"这一层是通用件，不是冰封图专用"，
 *     `howling_abyss_frost.js` 已经在用同一套机制）。不可走区域从"一块纯色
 *     背景"变成"下沉的深渊面 + 沿边界的斜坡崖壁"，陆地因此第一次有了真实的
 *     高度落差，不再是一整块平面——这条最便宜也最关键，零新渲染代码，只是
 *     给地图数据补一个已有机制的声明。
 *   ②**大尺度地貌，不是撒石头**：新增 `buildCanyonMonoliths`——中央峡谷/
 *     外圈放几座真正大的岩体（比原来的碎石簇高一个数量级，40~90 高），沉到
 *     `terrainEdge.waterY` 那个深度，读成"峡谷里立着的巨岩"而不是"平地上的
 *     鹅卵石"。原来那批小岩石簇/骨渣/枯木降级成这些巨岩周围的"碎屑"（第三层
 *     细节），不再独立铺满整张图当主角。
 *   ③**沿途色阶**：新增 `buildSandTexture`——沿整条环形走廊（不只是据点周围）
 *     撒浅色沙丘高光块+深色风蚀阴影块，两者都是同一个暖沙色系里的明暗变体
 *     （不引入新色相），让路面本身有肉眼可辨的明暗层次，而不是一整圈同一个
 *     纯色。
 *   ④**每个据点一块专属地面色**：新增 `buildNodeGroundPatch`——5 个主题据点
 *     各自的功能区底下垫一块跟主题呼应的地面色块（采石场偏灰岩、兽骨场偏
 *     骨白、精炼厂/钻机偏油渍暗褐、风车维持亮沙色），据点之间因此不再是
 *     "同一片地上摆了不同道具"，而是"几片视觉上能分辨的场地"。
 * 用到的六档颜色全部从现有调色板的 corridorColor/groundColor/rockColor 用
 * multiplyScalar/lerp 派生（同一色相家族深浅分层），不是新起一套配色——
 * 这是用户转述 GPT 方案里明确要求的做法（"不要增加彩虹颜色……同一个沙漠色系
 * 里建立5~7个明度/饱和度层级"），派生规则见下面 `deriveDesertRamp()`。
 *
 * ==================== 通用件，不是这一张图专属 ====================
 * 只要地图声明了 `dominionNodes`，这一层就会给每个 kind:'point' 节点摆一套
 * 跟节点 id 对应的主题道具+归属旗、给每个 kind:'nexus' 节点摆旗杆装饰、给
 * 整张图的不可走区域撒地形装饰——以后任何复用统治战场机制的新图，只要据点
 * id 撞上下面 BUILDERS 里登记的名字，装饰自动跟着有，不用重写；没声明这些
 * id 的据点会跳过主题道具，但仍然会有归属旗（旗是通用件，不挂主题）。
 * 没声明 dominionNodes 或不是 stylized 地图的，这一层什么也不做，不影响
 * 其它任何现有地图。
 *
 * ==================== 摆放位置为什么要偏移，不直接摆在 node.pos 上 ====================
 * node.pos 既是据点占领实体的坐标，也是环形兵线上的一个路点——主题道具如果
 * 摆在正中间，会跟据点本身的模型、以及经过的小兵撞在一起（视觉穿模+挡路）。
 * 这里把每一套主题道具沿"背离环心"的径向方向整体推出去一段
 * （DOMINION_PROPS.radialOffset），落在节点周围那圈额外撑开的空地
 * （NODE_BULGE=230）靠外沿，同时躲开环形走廊本身（CORRIDOR_HALF=140）——
 * 纯几何计算，不依赖这张图具体是圆形，径向方向直接从 map.world 的几何中心
 * 算，换一张非圆形布局的图一样能用（退化成"从地图中心指向节点"的方向）。
 * 归属旗只需要"贴着据点本身"这一个效果，径向推出量因此小得多（FLAG_OFFSET），
 * 落在据点塔模型与主题道具功能区之间，视觉上不会撞到任何一边。
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
import { RESOURCE_COLORS } from '../core/resourceBar.js';

const toScene = (x, y, h = 0) => new THREE.Vector3(x, h, y);

// 主题道具整体沿径向推出去的距离：CORRIDOR_HALF(140) < 此值 < NODE_BULGE(230)，
// 稳稳落在节点周围的空地里、躲开环形走廊本身。第二轮整体放大后维持不变——
// 这条边界是几何约束（躲开走廊/不越出空地），不是"看着还行"的美术值。
const RADIAL_OFFSET = 175;
// 归属旗贴着据点本身：比主题道具近得多，落在塔模型与主题功能区之间的空档。
const FLAG_OFFSET = 32;

// ==================== 通用材质色（跨主题共用，不随调色板变化）====================
const RUST_METAL = '#8a5a3a';       // 生锈金属主色（钻机/精炼厂）
const RUST_METAL_DARK = '#5f3d28';  // 生锈金属暗部
const BONE_COLOR = '#e8ddc0';       // 骸骨（兽骨场）
const WOOD_COLOR = '#6b4a30';       // 风车木结构/旗杆

function mat(color) { return new THREE.MeshLambertMaterial({ color, flatShading: true }); }

/**
 * 从调色板的 corridorColor/groundColor/rockColor 派生一套同色相家族的深浅
 * 阶梯——第三轮用户转述的 GPT 方案原话"不要增加彩虹颜色……同一个沙漠色系
 * 里建立5~7个明度/饱和度层级"。全部用 THREE.Color 的 lerp/multiplyScalar
 * （HSL 明度方向的简化实现，足够低模风格用），不手写第二套色值表。
 * @returns {{lightSand:number, windShadow:number, deepRock:number, abyss:number, slope:number}}
 *   （返回十六进制整数，THREE.Color/材质直接吃）
 */
function deriveDesertRamp(SV) {
  const corridor = new THREE.Color(SV.corridorColor || '#c9915a');
  const ground = new THREE.Color(SV.groundColor || '#3a2410');
  const rock = new THREE.Color(SV.rockColor || '#9c5a42');
  return {
    // 浅沙丘高光：主沙色往白里拉一点。
    lightSand: corridor.clone().lerp(new THREE.Color('#ffffff'), 0.22).getHex(),
    // 风蚀阴影：主沙色压暗，还在"路"这个明度量级里，不是深阴影。
    windShadow: corridor.clone().multiplyScalar(0.82).getHex(),
    // 深褐岩壁：岩石色再压暗，给大岩体用，比据点道具的 rockColor 更暗一档。
    deepRock: rock.clone().multiplyScalar(0.68).getHex(),
    // 峡谷阴影（深渊面/大岩体阴面）：环外虚空色再压暗，整张图最暗的一档。
    abyss: ground.clone().multiplyScalar(0.56).getHex(),
    // 崖壁斜坡：TerrainEdgeLayer 的既有约定"必须取地面色压暗一档，不能取石色"
    // （见该文件 DEF.slopeColor 头注），这里用同一条规则从 corridorColor 派生。
    slope: corridor.clone().multiplyScalar(0.75).getHex(),
  };
}

// ==================== ① 风车（windmill）====================
// 石基木塔 + 顶部十字静态旋翼（用户确认不做旋转动画，成本更低且没有先例）+
// 第二轮补：木栅栏残段 + 2 个沙丘状土包，让风车读成"一处风车遗址"而不是
// 孤零零一座塔。
function buildWindmill(group, pos, SV) {
  const stoneMat = mat(SV.rockColor || '#9c5a42');
  const woodMat = mat(WOOD_COLOR);
  const bladeMat = mat(SV.wallCapColor || '#d9b878');
  const sandMat = mat(new THREE.Color(SV.corridorColor || '#c9915a').multiplyScalar(0.88).getHex());

  const towerH = 95;   // 70→95（第二轮放大，见文件头注①）
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(12, 20, towerH, 8), stoneMat);
  tower.position.copy(toScene(pos.x, pos.y, towerH / 2));
  group.add(tower);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(16, 20, 8), woodMat);
  roof.position.copy(toScene(pos.x, pos.y, towerH + 10));
  group.add(roof);

  // 旋翼平面朝径向外侧，让固定俯视角度下叶片不至于完全侧视消失。
  const facing = Math.atan2(pos.dirY, pos.dirX);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 5, 8), woodMat);
  hub.position.copy(toScene(pos.x, pos.y, towerH));
  hub.rotation.x = Math.PI / 2;
  hub.rotation.z = facing;
  group.add(hub);

  const bladeGeo = new THREE.BoxGeometry(42, 11, 2);   // 30x8→42x11（放大）
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.copy(toScene(pos.x, pos.y, towerH));
    blade.rotation.y = facing;
    blade.rotation.x = (i * Math.PI) / 2;
    blade.translateX(21);
    group.add(blade);
  }

  // 沙丘：压扁的二十面体，纯视觉起伏，不改导航网格。
  for (let i = 0; i < 2; i++) {
    const a = hash(pos.x + i * 19, pos.y - i * 13) * Math.PI * 2;
    const d = 30 + hash(pos.x - i * 7, pos.y + i * 5) * 22;
    const dx = pos.x + Math.cos(a) * d, dy = pos.y + Math.sin(a) * d;
    const r = 16 + hash(dx, dy) * 10;
    const dune = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), sandMat);
    dune.position.copy(toScene(dx, dy, r * 0.22));
    dune.scale.set(r, r * 0.4, r * (0.8 + hash(dx, dy) * 0.4));
    dune.rotation.y = hash(dx + 3, dy + 3) * 6.2832;
    group.add(dune);
  }

  // 木栅栏残段：3~4 根倾斜木桩，围出"遗址边界"的暗示。
  const postGeo = new THREE.CylinderGeometry(1.4, 1.6, 20, 5);
  const fenceN = 4;
  for (let i = 0; i < fenceN; i++) {
    const a = (i / fenceN) * Math.PI * 1.1 + hash(pos.x + i, pos.y) * 0.4;
    const d = 34;
    const fx = pos.x + Math.cos(a) * d, fy = pos.y + Math.sin(a) * d;
    const post = new THREE.Mesh(postGeo, woodMat);
    post.position.copy(toScene(fx, fy, 9));
    post.rotation.z = (hash(fx, fy) - 0.5) * 0.5;   // 半倒的残桩
    post.rotation.y = hash(fx + 2, fy + 2) * 6.2832;
    group.add(post);
  }
}

// ==================== ② 钻机（drill）====================
// 生锈井架（锥形塔身+顶部滑轮）+ 周边碎石堆 + 第二轮补：油桶堆（3 个叠放
// 生锈圆桶）+ 一段管线阵列，让钻机读成"一处开采点"而不是一根孤立铁塔。
function buildDrill(group, pos) {
  const metalMat = mat(RUST_METAL);
  const metalDarkMat = mat(RUST_METAL_DARK);
  const rockMat = mat('#6e6a60');
  const barrelMat = mat('#7a4a2a');
  const barrelCapMat = mat('#4a3320');

  const rigH = 88;   // 62→88（放大）
  const rig = new THREE.Mesh(new THREE.CylinderGeometry(4, 24, rigH, 4), metalMat);
  rig.position.copy(toScene(pos.x, pos.y, rigH / 2));
  rig.rotation.y = Math.PI / 4;
  group.add(rig);

  const mastH = 25;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.6, mastH, 6), metalDarkMat);
  mast.position.copy(toScene(pos.x, pos.y, rigH + mastH / 2));
  group.add(mast);

  const pulley = new THREE.Mesh(new THREE.TorusGeometry(5.6, 1.5, 6, 10), metalDarkMat);
  pulley.position.copy(toScene(pos.x, pos.y, rigH + mastH));
  group.add(pulley);

  // 卧倒管道，斜靠在井架一侧。
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 48, 6), metalMat);
  pipe.position.copy(toScene(pos.x + 17, pos.y + 8, 3));
  pipe.rotation.z = Math.PI / 2;
  pipe.rotation.y = hash(pos.x, pos.y) * 6.2832;
  group.add(pipe);

  const pileN = 3;
  for (let i = 0; i < pileN; i++) {
    const a = hash(pos.x + i * 13, pos.y - i * 7) * Math.PI * 2;
    const d = 30 + hash(pos.x - i * 5, pos.y + i * 3) * 18;
    const rx = pos.x + Math.cos(a) * d, ry = pos.y + Math.sin(a) * d;
    const s = 5.5 + hash(rx, ry) * 4;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), rockMat);
    rock.position.copy(toScene(rx, ry, s * 0.4));
    rock.scale.set(s, s * 0.7, s);
    rock.rotation.y = hash(rx + 3, ry + 3) * 6.2832;
    group.add(rock);
  }

  // 油桶堆：一组 3 个生锈圆桶，紧挨着井架另一侧。
  const barrelGeo = new THREE.CylinderGeometry(6.5, 6.5, 12, 10);
  const barrelCapGeo = new THREE.CylinderGeometry(6.8, 6.8, 1.2, 10);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI * 0.6 + i * 0.5;
    const d = 26;
    const bx = pos.x + Math.cos(a) * d, by = pos.y + Math.sin(a) * d;
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.copy(toScene(bx, by, 6));
    group.add(barrel);
    const cap = new THREE.Mesh(barrelCapGeo, barrelCapMat);
    cap.position.copy(toScene(bx, by, 12.6));
    group.add(cap);
  }
}

// ==================== ③ 采石场（quarry）====================
// 凹陷矿坑（下沉圆盘）+ 堆叠矿石块 + 一个简易悬臂吊架 + 第二轮补：环绕矿坑
// 边缘的低矮岩壁（呼应参考图"岩壁矿坑"的意象，也是最容易读出"地形被挖开
// 一块"的据点，GPT 的方案里明确点名优先做这个）。
function buildQuarry(group, pos, SV) {
  const pitMat = mat(new THREE.Color(SV.groundColor || '#3a2410').multiplyScalar(0.7).getHex());
  const oreMatA = mat(SV.rockColor || '#9c5a42');
  const oreMatB = mat('#7a6a55');
  const metalMat = mat(RUST_METAL_DARK);
  const rimMat = mat(new THREE.Color(SV.rockColor || '#9c5a42').multiplyScalar(0.82).getHex());

  const pitR = 72;   // 55→72（放大）
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(pitR, pitR * 1.08, 8, 16), pitMat);
  pit.position.copy(toScene(pos.x, pos.y, -4));
  group.add(pit);

  // 矿坑边缘的低矮岩壁：一圈不完整的岩块，缺口处留给出入口，读出"被挖开的
  // 边界"而不是一个光滑的碗。
  const rimGeo = new THREE.IcosahedronGeometry(1, 0);
  const rimN = 10;
  for (let i = 0; i < rimN; i++) {
    if (hash(pos.x + i * 31, pos.y - i * 17) < 0.22) continue;   // 留几处缺口
    const a = (i / rimN) * Math.PI * 2;
    const rx = pos.x + Math.cos(a) * pitR * 1.02, ry = pos.y + Math.sin(a) * pitR * 1.02;
    const s = 7 + hash(rx, ry) * 5;
    const chunk = new THREE.Mesh(rimGeo, rimMat);
    chunk.position.copy(toScene(rx, ry, s * 0.35));
    chunk.scale.set(s, s * 0.65, s);
    chunk.rotation.y = hash(rx + 4, ry + 4) * 6.2832;
    group.add(chunk);
  }

  const pileCount = 3;
  for (let p = 0; p < pileCount; p++) {
    const a = (p / pileCount) * Math.PI * 2 + hash(pos.x + p, pos.y) * 1.5;
    const d = pitR * 0.45;
    const cx = pos.x + Math.cos(a) * d, cy = pos.y + Math.sin(a) * d;
    const stack = 2 + Math.floor(hash(cx, cy) * 2);
    let stackH = 0;
    for (let i = 0; i < stack; i++) {
      const s = 15 + hash(cx + i * 5, cy - i * 3) * 12;
      const block = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), hash(cx + i, cy + i) < 0.5 ? oreMatA : oreMatB);
      block.position.copy(toScene(
        cx + (hash(cx + i * 9, cy) - 0.5) * 10,
        cy + (hash(cx, cy + i * 9) - 0.5) * 10,
        stackH + s * 0.5));
      block.scale.set(s, s * 0.8, s);
      block.rotation.y = hash(cx + i * 4, cy + i * 4) * 6.2832;
      group.add(block);
      stackH += s * 0.7;
    }
  }

  // 简易悬臂吊架：一根立柱 + 一根斜撑臂。
  const postH = 44;   // 34→44（放大）
  const post = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, postH, 6), metalMat);
  post.position.copy(toScene(pos.x - pitR * 0.7, pos.y - pitR * 0.7, postH / 2));
  group.add(post);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 52, 6), metalMat);
  arm.position.copy(toScene(pos.x - pitR * 0.7 + 18, pos.y - pitR * 0.7 + 18, postH - 5));
  arm.rotation.z = Math.PI / 2;
  arm.rotation.y = -Math.PI / 4;
  group.add(arm);
}

// ==================== ④ 兽骨场（boneyard）====================
// 第二轮改法：一具压倒性的巨大主肋骨拱（用户认可的 GPT 方案"一具巨大沙漠
// 巨兽骨架，而不是几十个小骨头"），周围伴 2 具倒塌的小肋骨 + 散落骸骨。
function buildBoneyard(group, pos) {
  const boneMat = mat(BONE_COLOR);
  const boneDarkMat = mat(new THREE.Color(BONE_COLOR).multiplyScalar(0.82).getHex());

  // 主肋骨拱：明显大一档，居中，立得笔直——这是整个据点的视觉锚点。
  const mainR = 40;
  const mainArch = new THREE.Mesh(new THREE.TorusGeometry(mainR, 3.2, 8, 12, Math.PI * 0.92), boneMat);
  mainArch.position.copy(toScene(pos.x, pos.y, 2));
  mainArch.rotation.x = Math.PI / 2;
  mainArch.rotation.z = Math.atan2(pos.dirY, pos.dirX) + Math.PI / 2;
  group.add(mainArch);
  // 主拱旁边配一根竖立的脊椎骨（细长圆柱堆叠感，用几个渐缩的圆柱代替）。
  const spineSegs = 4;
  for (let i = 0; i < spineSegs; i++) {
    const s = 5 - i * 0.7;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(s, s * 0.85, 7, 6), boneDarkMat);
    seg.position.copy(toScene(pos.x - mainR * 0.55, pos.y + mainR * 0.15, 3.5 + i * 6.5));
    seg.rotation.z = 0.12;
    group.add(seg);
  }

  // 两具倒塌的小肋骨：明显比主拱矮小、歪斜，衬出主拱的"巨大"。
  const smallCount = 2;
  for (let i = 0; i < smallCount; i++) {
    const a = hash(pos.x + i * 17, pos.y - i * 5) * Math.PI * 2;
    const d = 26 + hash(pos.x - i, pos.y + i) * 20;
    const cx = pos.x + Math.cos(a) * d, cy = pos.y + Math.sin(a) * d;
    const r = 13 + hash(cx, cy) * 6;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(r, 1.6, 6, 10, Math.PI * 0.85), boneMat);
    arch.position.copy(toScene(cx, cy, 1));
    arch.rotation.x = Math.PI / 2;
    arch.rotation.z = a + Math.PI / 2;
    arch.rotation.y = 0.5 + hash(cx + 3, cy + 3) * 0.5;   // 明显倒塌，跟主拱拉开姿态差
    group.add(arch);
  }

  const skullCount = 6;
  for (let i = 0; i < skullCount; i++) {
    const a = hash(pos.x + i * 23, pos.y + i * 11) * Math.PI * 2;
    const d = 12 + hash(pos.x - i * 3, pos.y + i * 7) * 34;
    const sx = pos.x + Math.cos(a) * d, sy = pos.y + Math.sin(a) * d;
    const s = 5 + hash(sx, sy) * 2.4;
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), boneMat);
    skull.position.copy(toScene(sx, sy, s * 0.5));
    skull.scale.set(s, s * 0.85, s * 1.1);
    skull.rotation.y = hash(sx + 5, sy + 5) * 6.2832;
    group.add(skull);
  }
}

// ==================== ⑤ 精炼厂（refinery）====================
// 2~3 个生锈金属油罐 + 连接管道 + 第二轮补：一个小型木箱堆（呼应"废弃工业
// 遗迹"的仓储感），整体放大一档。
function buildRefinery(group, pos) {
  const tankMat = mat(RUST_METAL);
  const tankMatDark = mat(RUST_METAL_DARK);
  const pipeMat = mat(RUST_METAL_DARK);
  const crateMat = mat(WOOD_COLOR);

  const tanks = [
    { dx: -20, dy: 0, r: 20, h: 50 },
    { dx: 17, dy: 12, r: 15, h: 40 },
    { dx: 7, dy: -20, r: 12, h: 32 },
  ];
  const centers = [];
  tanks.forEach((t) => {
    const cx = pos.x + t.dx, cy = pos.y + t.dy;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(t.r, t.r, t.h, 12), tankMat);
    body.position.copy(toScene(cx, cy, t.h / 2));
    group.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 1.05, t.r * 1.05, 2.4, 12), tankMatDark);
    cap.position.copy(toScene(cx, cy, t.h + 1.2));
    group.add(cap);
    centers.push({ x: cx, y: cy, r: t.r, h: t.h });
  });

  // 相邻油罐之间连一根横向管道。
  for (let i = 0; i < centers.length - 1; i++) {
    const a = centers[i], b = centers[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const midH = Math.min(a.h, b.h) * 0.6;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, len, 6), pipeMat);
    pipe.position.copy(toScene((a.x + b.x) / 2, (a.y + b.y) / 2, midH));
    pipe.rotation.z = Math.PI / 2;
    pipe.rotation.y = -Math.atan2(dy, dx);
    group.add(pipe);
  }

  // 木箱堆：3 个错落方箱，摆在离油罐群稍远一点的地方，暗示"仓储角落"。
  const crateGeo = new THREE.BoxGeometry(11, 11, 11);
  for (let i = 0; i < 3; i++) {
    const a = Math.PI * 0.75 + i * 0.35;
    const d = 34 + i * 3;
    const cx = pos.x + Math.cos(a) * d, cy = pos.y + Math.sin(a) * d;
    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.copy(toScene(cx, cy, 5.5));
    crate.rotation.y = hash(cx, cy) * 6.2832;
    group.add(crate);
  }
}

const BUILDERS = {
  windmill: buildWindmill,
  drill: buildDrill,
  quarry: buildQuarry,
  boneyard: buildBoneyard,
  refinery: buildRefinery,
};

// ==================== 归属旗：据点旁一根旗杆+旗面，颜色跟随占领状态 ====================
// 用户在澄清问答里选了"要做（推荐，呼应参考图）"——参考图里每个据点旁边都
// 立着一根带彩旗的小塔，旗色随归属变蓝/红/中立。现有的头顶占领进度条已经
// 是同一份信息的一种表达（见 UnitLayer.js），这根旗是同一份状态在场景里的
// 第二种表达，两者不冲突、互相加强，不是重复造轮子。
// 旗面用 PlaneGeometry 双面渲染（旗子很薄，单面在某些视角会完全消失）。
function buildFlag(group, x, y, initialColorHex) {
  const poleMat = mat(WOOD_COLOR);
  const poleH = 30;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, poleH, 6), poleMat);
  pole.position.copy(toScene(x, y, poleH / 2));
  group.add(pole);

  const bannerMat = new THREE.MeshLambertMaterial({
    color: initialColorHex, flatShading: true, side: THREE.DoubleSide,
  });
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(11, 7), bannerMat);
  banner.position.copy(toScene(x, y, poleH - 5));
  banner.translateX(5.5);
  group.add(banner);
  return banner;
}

// ==================== 水晶枢纽两侧旗杆：呼应"基地应该比据点更有分量" ====================
// 不重做枢纽水晶本体（那是 UnitLayer 的塔模型职责），只在两侧各加一根固定
// 阵营色的旗杆，视觉上把枢纽的"地盘"撑大一圈。
function buildNexusFlank(group, pos, colorHex) {
  const perp = { x: -pos.dirY, y: pos.dirX };   // 垂直于径向方向的切线，用来左右分开两根旗杆
  for (const side of [-1, 1]) {
    const fx = pos.x + perp.x * 36 * side, fy = pos.y + perp.y * 36 * side;
    buildFlag(group, fx, fy, colorHex);
  }
}

// ==================== 沿途色阶：整条环形走廊撒浅色沙丘高光/深色风蚀阴影 ====================
// 第三轮新增——用户转述的 GPT 方案"路面本身要有明暗层次，不是一整圈同一个
// 纯色"。只在【可走】区域撒（这是路面本身的色阶，不是不可走区域的地形装饰，
// 跟下面 buildTerrainAccents 的判据刚好相反），扁平低矮的团块状网格贴着地面，
// 不影响小兵通行（没有碰撞体，只是渲染）。两种色块都从 deriveDesertRamp()
// 派生，跟主沙色同一色相家族，只是明暗不同。
const SAND_TEXTURE_STEP = 95;
const SAND_TEXTURE_CHANCE = 0.3;
function buildSandTexture(group, map, SV, isWalkable, ramp) {
  if (!isWalkable) return;
  const lightMat = mat(ramp.lightSand);
  const shadowMat = mat(ramp.windShadow);
  const blobGeo = new THREE.IcosahedronGeometry(1, 1);
  const { w: WW, h: WH } = map.world;

  for (let gx = 0; gx < WW; gx += SAND_TEXTURE_STEP) {
    for (let gy = 0; gy < WH; gy += SAND_TEXTURE_STEP) {
      const x = gx + (hash(gx + 11, gy) - 0.5) * SAND_TEXTURE_STEP * 0.7;
      const y = gy + (hash(gx, gy + 11) - 0.5) * SAND_TEXTURE_STEP * 0.7;
      if (!isWalkable(x, y)) continue;                 // 只画在路面上
      if (hash(gx + 13, gy + 13) > SAND_TEXTURE_CHANCE) continue;
      const light = hash(x + 6, y + 6) < 0.5;
      const r = 22 + hash(x, y) * 26;
      const blob = new THREE.Mesh(blobGeo, light ? lightMat : shadowMat);
      // 极低矮的扁团块，贴着地面——是"色块"不是"土堆"，高度只用来避免 z-fight。
      blob.position.copy(toScene(x, y, 0.4));
      const ex = 0.7 + hash(x + 3, y) * 0.7, ez = 0.7 + hash(x, y + 3) * 0.7;
      blob.scale.set(r * ex, 1.6, r * ez);
      blob.rotation.y = hash(x + 5, y + 5) * 6.2832;
      group.add(blob);
    }
  }
}

// ==================== 每个据点一块专属地面色 ====================
// 第三轮新增——用户转述的 GPT 方案"五个据点应该有五种视觉语言"。给已登记
// 主题的据点在功能区脚下垫一块跟主题呼应的扁平色块（比如采石场偏灰岩），
// 半径覆盖节点本身 + RADIAL_OFFSET 那圈功能区，让"这一片是同一个场地"读
// 得出来，不是"同一片沙地上摆了不同道具"。颜色同样只在暖色系内部变化
// （灰岩/骨白都是把主沙色的饱和度往下调，不是换色相），跟 deriveDesertRamp()
// 的"同色系分层"原则一致。
const NODE_GROUND_TINTS = {
  quarry: (SV) => new THREE.Color(SV.rockColor || '#9c5a42').lerp(new THREE.Color('#8a8478'), 0.5).getHex(),
  boneyard: (SV) => new THREE.Color(BONE_COLOR).lerp(new THREE.Color(SV.corridorColor || '#c9915a'), 0.35).getHex(),
  refinery: (SV) => new THREE.Color(SV.corridorColor || '#c9915a').multiplyScalar(0.6).getHex(),
  drill: (SV) => new THREE.Color(SV.corridorColor || '#c9915a').multiplyScalar(0.58).getHex(),
  windmill: (SV) => new THREE.Color(SV.corridorColor || '#c9915a').lerp(new THREE.Color('#ffffff'), 0.12).getHex(),
};
function buildNodeGroundPatch(group, node, pos, SV) {
  const tintFn = NODE_GROUND_TINTS[node.id];
  if (!tintFn) return;
  const patchMat = mat(tintFn(SV));
  const midX = (node.pos.x + pos.x) / 2, midY = (node.pos.y + pos.y) / 2;
  const r = RADIAL_OFFSET * 0.95;
  const patch = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, 1.2, 20), patchMat);
  patch.position.copy(toScene(midX, midY, 0.15));
  group.add(patch);
}

// ==================== 中央峡谷/外圈的大岩体 ====================
// 第三轮新增——用户转述的 GPT 方案"小石头只能是第三层细节，不能承担大尺度
// 构图"。这批岩体比 buildTerrainAccents 里的碎石簇高一个数量级（40~90），
// 沉到 `map.terrainEdge.waterY` 那个深度（跟 HowlingAbyssDecor.js 的水域
// 装饰同一条规则："陆地有厚度之后，水域装饰要整体沉到深渊面那一层"），读成
// "峡谷里立着的巨岩"而不是"平地上的鹅卵石"。位置沿几个固定角度扇区取
// isWalkable 为假的点，数量克制（不到 10 座），量少但个头大，撑住构图。
const MONOLITH_ANGLES = [30, 95, 160, 210, 275, 330];   // 度，围绕地图中心分布
function buildCanyonMonoliths(group, map, SV, isWalkable, nodePositions, ramp) {
  if (!isWalkable) return;
  const rockMat = mat(ramp.deepRock);
  const rockLightMat = mat(new THREE.Color(ramp.deepRock).lerp(new THREE.Color('#ffffff'), 0.18).getHex());
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  const cx = map.world.w / 2, cy = map.world.h / 2;
  const maxR = Math.max(map.world.w, map.world.h) * 0.42;
  const EXCLUDE_R = 250;
  const nearAnyNode = (x, y) => nodePositions.some((p) => Math.hypot(x - p.x, y - p.y) < EXCLUDE_R);

  for (const angleDeg of MONOLITH_ANGLES) {
    const a = (angleDeg * Math.PI) / 180;
    // 沿这个方向从内向外找一个真正不可走、且不挨着任何据点功能区的点。
    let placed = false;
    for (let r = 120; r <= maxR && !placed; r += 40) {
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (isWalkable(x, y) || nearAnyNode(x, y)) continue;
      const h = 40 + hash(x, y) * 50;
      const baseR = 22 + hash(x + 1, y + 1) * 20;
      const monolith = new THREE.Mesh(rockGeo, hash(x + 2, y + 2) < 0.6 ? rockMat : rockLightMat);
      monolith.position.copy(toScene(x, y, h * 0.42));
      monolith.scale.set(baseR, h, baseR * (0.75 + hash(x, y) * 0.4));
      monolith.rotation.y = hash(x + 3, y + 3) * 6.2832;
      group.add(monolith);
      // 岩体底部的碎屑：3~4 块小石头，读成"从大岩体上崩落的碎渣"而不是
      // 独立的装饰——呼应"小石头只能当第三层细节"这条要求。
      const debrisN = 3 + Math.floor(hash(x + 4, y + 4) * 2);
      for (let i = 0; i < debrisN; i++) {
        const da = hash(x + i * 9, y - i * 5) * Math.PI * 2;
        const dd = baseR * (1.1 + hash(x - i, y + i) * 0.6);
        const dx = x + Math.cos(da) * dd, dy = y + Math.sin(da) * dd;
        if (isWalkable(dx, dy)) continue;
        const s = 5 + hash(dx, dy) * 6;
        const debris = new THREE.Mesh(rockGeo, rockMat);
        debris.position.copy(toScene(dx, dy, s * 0.4));
        debris.scale.set(s, s * 0.7, s);
        debris.rotation.y = hash(dx + 2, dy + 2) * 6.2832;
        group.add(debris);
      }
      placed = true;
    }
  }
}

// ==================== 地形装饰：不可走区域撒岩石/枯木/骨渣（第三层细节）====================
// 只看 isWalkable，绝不会撒在小兵能走的地方（跟 HowlingAbyssDecor.js 的浮冰/
// 瓦砾摆放同一条底线）。同时要避开每个节点周围的主题道具区（NODE_BULGE 范围
// 内已经有专门设计的功能区，这里再撒东西会互相打架），用 minDist 排除。
// 第三轮：密度调低（0.46→0.3）——这批小碎石现在是巨岩（buildCanyonMonoliths）
// 和地面色阶之外的补充细节，不再是撑起整张图空间感的主角，用户转述的 GPT
// 方案原话"小石头只能作为第三层细节，不能承担大尺度构图职责"。
const TERRAIN_ACCENT_STEP = 130;   // 扫描格距——比据点间距小得多，保证中央颈部/外圈都能覆盖到
const TERRAIN_ACCENT_CHANCE = 0.3;
function buildTerrainAccents(group, map, SV, isWalkable, nodePositions) {
  if (!isWalkable) return;
  const rockMat = mat(SV.rockColor || '#9c5a42');
  const rockDarkMat = mat(new THREE.Color(SV.rockColor || '#9c5a42').multiplyScalar(0.72).getHex());
  const boneMat = mat(BONE_COLOR);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const { w: WW, h: WH } = map.world;
  const EXCLUDE_R = 250;   // 略大于 NODE_BULGE(230)，留一点缓冲

  const nearAnyNode = (x, y) => nodePositions.some((p) => Math.hypot(x - p.x, y - p.y) < EXCLUDE_R);

  for (let gx = 0; gx < WW; gx += TERRAIN_ACCENT_STEP) {
    for (let gy = 0; gy < WH; gy += TERRAIN_ACCENT_STEP) {
      const x = gx + (hash(gx + 3, gy) - 0.5) * TERRAIN_ACCENT_STEP * 0.6;
      const y = gy + (hash(gx, gy + 3) - 0.5) * TERRAIN_ACCENT_STEP * 0.6;
      if (isWalkable(x, y)) continue;                 // 硬底线：能走的地方绝不摆
      if (nearAnyNode(x, y)) continue;                 // 避开各据点的专属功能区
      if (hash(gx + 9, gy + 9) > TERRAIN_ACCENT_CHANCE) continue;

      const roll = hash(x + 1, y + 1);
      if (roll < 0.6) {
        // 岩石簇：2~3 块低模石头，越靠地图中心/边角越可能出现更大的"巨岩"。
        const n = 2 + Math.floor(hash(x, y) * 2);
        for (let i = 0; i < n; i++) {
          const a = hash(x + i * 7, y - i * 3) * Math.PI * 2;
          const d = hash(x - i * 5, y + i * 11) * 22;
          const rx = x + Math.cos(a) * d, ry = y + Math.sin(a) * d;
          if (isWalkable(rx, ry)) continue;
          const s = 8 + hash(rx, ry) * 16;
          const rock = new THREE.Mesh(rockGeo, hash(rx + 2, ry + 2) < 0.5 ? rockMat : rockDarkMat);
          rock.position.copy(toScene(rx, ry, s * 0.42));
          rock.scale.set(s, s * (0.6 + hash(rx, ry) * 0.5), s);
          rock.rotation.y = hash(rx + 3, ry + 3) * 6.2832;
          group.add(rock);
        }
      } else if (roll < 0.82) {
        // 枯木：几根细长圆柱交错，呈现"干裂枯枝"的剪影。
        const branchN = 3 + Math.floor(hash(x, y) * 2);
        for (let i = 0; i < branchN; i++) {
          const len = 10 + hash(x + i, y - i) * 12;
          const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, len, 5), rockDarkMat);
          branch.position.copy(toScene(x, y, len * 0.4));
          branch.rotation.z = Math.PI / 2.4 + hash(x + i * 3, y) * 0.6;
          branch.rotation.y = hash(x + i * 5, y + i * 5) * 6.2832;
          group.add(branch);
        }
      } else {
        // 骨渣：呼应兽骨场主题，散落在整张图的荒地上，不只是兽骨场那一处。
        const s = 3 + hash(x, y) * 2.4;
        const shard = new THREE.Mesh(rockGeo, boneMat);
        shard.position.copy(toScene(x, y, s * 0.4));
        shard.scale.set(s, s * 0.7, s * 1.3);
        shard.rotation.y = hash(x + 4, y + 4) * 6.2832;
        group.add(shard);
      }
    }
  }
}

export class DominionPropsLayer {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
    this.shadowLevel = 'off';
    this._flags = [];        // [{ banner, pos }] —— 供 update() 按占领状态刷色
    this._isWalkable = null;
  }

  /** ThreeRenderer 注入的 isWalkable 判定（地形装饰摆放要避开小兵能走的地方）。 */
  setWalkableFn(fn) { this._isWalkable = fn; }

  clear() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.scene.remove(this.group);
    this.group = null;
    this._flags = [];
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
    const nodes = stylized && Array.isArray(map.dominionNodes) ? map.dominionNodes : [];
    if (!nodes.length) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.group) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;

    const SV = stylizedPaletteOf(map);
    const group = new THREE.Group();
    this.group = group;
    this.scene.add(group);

    const cx = map.world.w / 2, cy = map.world.h / 2;
    const dirOf = (node) => {
      const dx = node.pos.x - cx, dy = node.pos.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      return { dirX: dx / dist, dirY: dy / dist };
    };

    const points = nodes.filter((n) => n.kind === 'point');
    const nexuses = nodes.filter((n) => n.kind === 'nexus');
    const allPositions = nodes.map((n) => ({ x: n.pos.x, y: n.pos.y }));

    const ramp = deriveDesertRamp(SV);

    // 第三轮：沿途色阶要垫在所有据点道具/旗帜**之下**，所以先画（画的顺序
    // 就是 THREE.Group 的 z 序无所谓——都是不透明平面几何——但先建更符合
    // "先有地面色阶，再往上面摆东西"的阅读顺序，也方便以后要挖洞规避时改）。
    // 单独起一个具名子分组（不是散落进顶层 group）——sim_dominionprops.mjs
    // 靠这个名字精确数"沿途色阶到底铺了多少"，不会跟同一张图里其它内容混在
    // 一起数（两套系统一个只认可走、一个只认不可走，笼统数顶层 children 在
    // "整张图全可走"这种极端场景下会失真，见该测试文件⑮⑯两条断言的头注）。
    const sandGroup = new THREE.Group();
    sandGroup.name = 'sandTexture';
    group.add(sandGroup);
    buildSandTexture(sandGroup, map, SV, this._isWalkable, ramp);

    for (const node of points) {
      const { dirX, dirY } = dirOf(node);
      // ① 主题功能区（仅登记过的 id 有）。
      if (BUILDERS[node.id]) {
        const pos = {
          x: node.pos.x + dirX * RADIAL_OFFSET,
          y: node.pos.y + dirY * RADIAL_OFFSET,
          dirX, dirY,
        };
        // 第三轮：专属地面色垫在主题道具下面，让"据点+功能区"读成同一片场地。
        buildNodeGroundPatch(group, node, pos, SV);
        BUILDERS[node.id](group, pos, SV);
      }
      // ② 归属旗：所有据点通用，不管有没有登记主题（据点占位名"商栈"/"望塔"
      // 同样需要归属旗——不能因为名字还没定稿就少一份视觉反馈）。
      const fx = node.pos.x + dirX * FLAG_OFFSET, fy = node.pos.y + dirY * FLAG_OFFSET;
      const banner = buildFlag(group, fx, fy, RESOURCE_COLORS.capture_neutral);
      this._flags.push({ banner, pos: { x: node.pos.x, y: node.pos.y } });
    }

    for (const node of nexuses) {
      const { dirX, dirY } = dirOf(node);
      const colorHex = node.faction === 'blue' ? RESOURCE_COLORS.capture_blue
        : node.faction === 'red' ? RESOURCE_COLORS.capture_red : RESOURCE_COLORS.capture_neutral;
      buildNexusFlank(group, { x: node.pos.x, y: node.pos.y, dirX, dirY }, colorHex);
    }

    // ==================== 第三轮：不可走区域的装饰整体沉到深渊面那一层 ====================
    // 跟 HowlingAbyssDecor.js 的水域装饰同一条规则头注："陆地有厚度之后，
    // 水域装饰要整体沉到深渊面那一层"——地图一旦声明了 `terrainEdge`，
    // 不可走区域就不再是跟陆地同高的一块平面，而是下沉的深渊面
    // （TerrainEdgeLayer.js 的 waterY）。这里的巨岩/碎石/枯木/骨渣全部长在
    // 不可走区域里，因此也要整体沉下去，否则会悬浮在半空。没声明 terrainEdge
    // 的地图（比如还没接入这套机制的旧版本）用 0 兜底，行为不变。
    const voidGroup = new THREE.Group();
    voidGroup.name = 'voidAccents';
    voidGroup.position.y = map.terrainEdge?.waterY ?? 0;
    group.add(voidGroup);
    buildCanyonMonoliths(voidGroup, map, SV, this._isWalkable, allPositions, ramp);
    buildTerrainAccents(voidGroup, map, SV, this._isWalkable, allPositions);

    this.setShadowLevel(this.shadowLevel);
  }

  /**
   * 每帧调用：把据点归属旗的颜色同步到 DominionSystem 的实时占领状态。
   * 不重建几何——只改材质颜色，代价极小。
   * 归属状态镜像在据点实体的 `_captureOwner` 字段（DominionSystem._syncCaptureDisplay
   * 每帧写入），实体与节点用坐标匹配（据点实体创建时 `pos` 直接复制自
   * `node.pos`，同一张图内不会变）。
   *
   * ⚠️ 故意不跨帧缓存 entityRef——`getAllTowers(false)` 本身就是按类型分桶的
   * O(塔数量) 查询，一帧被 CombatSystem/LaneMovementSystem 等约 10 处各调一次
   * （见 EntityContainer.js 的 getAllMinions 头注），这里再调一次量级完全一样。
   * 缓存引用反而会在"实体被替换成新对象"时读到陈旧值——本模块的测试用例就
   * 踩过这一种（sim_dominionprops.mjs ⑫），正确性优先于省这一点点查表开销。
   */
  update(deps) {
    if (!this._flags.length || !deps || !deps.entities) return;
    const towers = deps.entities.getAllTowers(false);
    for (const f of this._flags) {
      const entity = towers.find((t) => t.isCapturePoint && t.pos.x === f.pos.x && t.pos.y === f.pos.y);
      const owner = entity ? entity._captureOwner : null;
      const colorHex = owner === 'blue' ? RESOURCE_COLORS.capture_blue
        : owner === 'red' ? RESOURCE_COLORS.capture_red : RESOURCE_COLORS.capture_neutral;
      if (f.banner.material.color.getHexString() !== new THREE.Color(colorHex).getHexString()) {
        f.banner.material.color.set(colorHex);
      }
    }
  }
}
