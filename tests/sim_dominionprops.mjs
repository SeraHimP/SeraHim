/**
 * sim_dominionprops.mjs —— 统治战场·据点环境装饰第二轮验收
 *
 * 背景：用户反馈第一轮的据点装饰（DominionPropsLayer.js）虽然确实在建几何
 * （page.evaluate 数过 40 个子节点），但相对世界尺寸太小、跟背景色对比不够，
 * 实机截图里几乎看不出来。GPT 评估方案（用户认可）诊断为"没有建立视觉层级"，
 * 这一轮把 5 个据点的主题道具放大+补关联道具（读成"功能区"而不是孤立小
 * 模型）、新增据点归属旗（旗色跟随占领状态实时变化）、新增水晶枢纽两侧
 * 旗杆装饰、新增不可走区域的地形装饰（岩石/枯木/骨渣）。
 *
 * ==================== 为什么这里能直接跑真几何，不用像 HowlingAbyssDecor
 * 那样只做"源码接线核对" ====================
 * 试过 `node -e "import(...)"` 直接 import DominionPropsLayer.js 是能成功的——
 * vendor/three.module.js 的 Group/Mesh/Geometry 构造不依赖任何浏览器全局
 * （只有真正建 WebGLRenderer/Canvas 才需要），所以可以用一个假 scene
 * （{children, add, remove}）跑真实的 build()/update()，直接断言几何数量、
 * 旗帜颜色这些真实产出，而不是退化成正则找方法名存在与否——比源码接线核对
 * 强得多，能抓到真正的逻辑 bug（比如上一轮"确实建了但看不见"这种，光靠
 * 方法名匹配是抓不出来的）。
 */
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow();

const { DominionPropsLayer } = await import('../src/presentation/DominionPropsLayer.js');
const { RESOURCE_COLORS } = await import('../src/core/resourceBar.js');

function makeScene() {
  return {
    children: [],
    add(o) { this.children.push(o); },
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); },
  };
}

// 第三轮起，地形装饰（buildTerrainAccents/buildCanyonMonoliths）被挪进了一个
// 子分组（沉到深渊面那一层，见 DominionPropsLayer.js 的 voidGroup 头注）——
// `group.children.length` 只数得到顶层的直接子节点（含那个子分组本身，算 1
// 个），数不到子分组里面真正的网格数量。这个计数器递归数全部后代，
// 才是"这张图实际画了多少东西"的真实口径。
function countDescendants(node) {
  let n = node.children ? node.children.length : 0;
  for (const c of node.children || []) n += countDescendants(c);
  return n;
}

// 仿真环境半宽版的据点布局（不追求跟真图的具体坐标一致，只要结构对得上：
// 7 个 point + 2 个 nexus，其中 5 个 point 的 id 命中 BUILDERS）。
function makeNodes() {
  return [
    { id: 'windmill', name: '风车', kind: 'point', pos: { x: 1100, y: 320 } },
    { id: 'refinery', name: '精炼厂', kind: 'point', pos: { x: 1600, y: 600 } },
    { id: 'quarry', name: '采石场', kind: 'point', pos: { x: 600, y: 600 } },
    { id: 'boneyard', name: '兽骨场', kind: 'point', pos: { x: 600, y: 1600 } },
    { id: 'drill', name: '钻机', kind: 'point', pos: { x: 1600, y: 1600 } },
    { id: 'blue_base', name: '商栈', kind: 'point', pos: { x: 320, y: 1100 } },
    { id: 'red_base', name: '望塔', kind: 'point', pos: { x: 1880, y: 1100 } },
    { id: 'blue_nexus', name: '蓝方水晶枢纽', kind: 'nexus', faction: 'blue', pos: { x: 680, y: 1100 } },
    { id: 'red_nexus', name: '红方水晶枢纽', kind: 'nexus', faction: 'red', pos: { x: 1520, y: 1100 } },
  ];
}

// 环形可走区：以地图中心为圆心，半径落在 [750,1050] 之间才算可走——粗糙但
// 足够覆盖"节点在环上、中心和边角不可走"这个结构，供地形装饰的 isWalkable
// 门控测试用。
function ringIsWalkable(x, y) {
  const d = Math.hypot(x - 1100, y - 1100);
  return d > 750 && d < 1050;
}

const map = {
  id: 'dominion_test_v1', visualStyle: 'stylized', paletteId: 'desert',
  world: { w: 2200, h: 2200 }, dominionNodes: makeNodes(),
};
const points = map.dominionNodes.filter((n) => n.kind === 'point');
const nexuses = map.dominionNodes.filter((n) => n.kind === 'nexus');

const { T, done } = scoreboard('统治战场·据点环境装饰第二轮验收');

// ==================== 一、build() 基本产出 ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });

  T('①-build() 后 group 挂到了 scene 上', scene.children.includes(layer.group));
  T('②-建出了不少几何体（5 个功能区+7 面旗+2 处枢纽旗杆+沿途色阶+巨岩+地形装饰，量级应远超几十个）',
    countDescendants(layer.group) > 80);
  T('③-归属旗数量正好等于 point 节点数（含未登记主题的商栈/望塔占位据点，不能因为名字还没定稿就少一份反馈）',
    layer._flags.length === points.length);
  T('④-每面旗初始颜色都是中立色（还没跑 update() 之前，不能凭空猜归属）',
    layer._flags.every((f) => f.banner.material.color.getHexString() === RESOURCE_COLORS.capture_neutral.slice(1)));
}

// ==================== 二、同图跳过守卫（跟其它装饰层同一套约定） ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });
  const n1 = layer.group.children.length;
  layer.build({ currentMap: map });   // 同一个 map.id 再建一次
  T('⑤-同一张图重复调用 build() 不会重复叠加几何（同图跳过守卫生效）',
    layer.group.children.length === n1);
}

// ==================== 三、非统治战场地图/无 dominionNodes 时什么也不做 ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.build({ currentMap: { id: 'other_map', visualStyle: 'stylized', world: { w: 100, h: 100 } } });
  T('⑥-没有 dominionNodes 的地图不建任何东西', layer.group === null && scene.children.length === 0);

  layer.build({ currentMap: map });
  T('⑦-换回统治战场地图后正常建东西', layer.group !== null && layer.group.children.length > 0);
  layer.build({ currentMap: { id: 'other_map2', world: { w: 100, h: 100 } } });
  T('⑧-再切到无 dominionNodes 的图，之前的装饰被清空', layer.group === null && scene.children.length === 0);
}

// ==================== 四、归属旗跟随占领状态实时变色 ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });

  const windmillPos = points.find((n) => n.id === 'windmill').pos;
  const drillPos = points.find((n) => n.id === 'drill').pos;
  const entities = {
    getAllTowers: () => [
      { isCapturePoint: true, alive: true, pos: { ...windmillPos }, _captureOwner: 'blue' },
      { isCapturePoint: true, alive: true, pos: { ...drillPos }, _captureOwner: 'red' },
    ],
  };
  layer.update({ entities });

  const flagAt = (pos) => layer._flags.find((f) => f.pos.x === pos.x && f.pos.y === pos.y);
  T('⑨-风车据点被蓝方占领后，旗面变蓝',
    flagAt(windmillPos).banner.material.color.getHexString() === RESOURCE_COLORS.capture_blue.slice(1));
  T('⑩-钻机据点被红方占领后，旗面变红',
    flagAt(drillPos).banner.material.color.getHexString() === RESOURCE_COLORS.capture_red.slice(1));
  const untouched = points.find((n) => n.id === 'quarry').pos;
  T('⑪-没有对应实体的据点（本例的采石场）旗面保持中立色，不会被误染色',
    flagAt(untouched).banner.material.color.getHexString() === RESOURCE_COLORS.capture_neutral.slice(1));

  // 归属翻转：红方丢了钻机，变回中立。
  entities.getAllTowers = () => [
    { isCapturePoint: true, alive: true, pos: { ...windmillPos }, _captureOwner: 'blue' },
    { isCapturePoint: true, alive: true, pos: { ...drillPos }, _captureOwner: 'neutral' },
  ];
  layer.update({ entities });
  T('⑫-据点归属翻转后旗色跟着变（钻机红→中立）',
    flagAt(drillPos).banner.material.color.getHexString() === RESOURCE_COLORS.capture_neutral.slice(1));

  const n1 = layer.group.children.length;
  layer.update({ entities });
  layer.update({ entities });
  T('⑬-update() 只改材质颜色，不会重复建几何（多次调用不涨 children 数）',
    layer.group.children.length === n1);
}

// ==================== 五、水晶枢纽两侧旗杆用固定阵营色，不随 update() 变化 ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });
  T('⑭-水晶枢纽旗杆不计入 _flags（那是固定色装饰，不是需要跟随占领状态刷新的归属旗）',
    layer._flags.length === points.length);
}

// ==================== 六、地形装饰必须遵守 isWalkable 门控 ====================
{
  // ⚠️ 第三轮之后地图上有两套跟 isWalkable 门控方向【相反】的系统：
  //   · buildTerrainAccents/buildCanyonMonoliths（voidAccents 子分组）——
  //     只摆在【不可走】的地方；
  //   · buildSandTexture（sandTexture 子分组）——只摆在【可走】的地方。
  // "整张图全部可走" vs "环形可走区" 这种笼统对比不能再用顶层 children 总数
  // 判断（两套此消彼长，总数不一定沿哪个方向单调），必须分别按具名子分组
  // 精确核对各自的门控是否生效。
  const findGroup = (root, name) => root.children.find((c) => c.name === name);

  const alwaysWalkable = () => true;
  const scene1 = makeScene();
  const layer1 = new DominionPropsLayer(scene1);
  layer1.setWalkableFn(alwaysWalkable);
  layer1.build({ currentMap: { ...map, id: 'dominion_test_v1_walkableall' } });
  const voidAllWalkable = countDescendants(findGroup(layer1.group, 'voidAccents'));
  const sandAllWalkable = countDescendants(findGroup(layer1.group, 'sandTexture'));

  const neverWalkable = () => false;
  const scene2 = makeScene();
  const layer2 = new DominionPropsLayer(scene2);
  layer2.setWalkableFn(neverWalkable);
  layer2.build({ currentMap: { ...map, id: 'dominion_test_v1_walkablenone' } });
  const voidNoneWalkable = countDescendants(findGroup(layer2.group, 'voidAccents'));
  const sandNoneWalkable = countDescendants(findGroup(layer2.group, 'sandTexture'));

  T('⑮-地形装饰（岩石/枯木/骨渣/巨岩）只摆在不可走的地方：全图可走时它们的子分组几乎是空的，全图不可走时才铺满',
    voidAllWalkable === 0 && voidNoneWalkable > voidAllWalkable);
  T('⑮b-沿途色阶（沙丘高光/风蚀阴影）只摆在可走的地方：跟地形装饰刚好反过来',
    sandNoneWalkable === 0 && sandAllWalkable > sandNoneWalkable);

  const scene3 = makeScene();
  const layer3 = new DominionPropsLayer(scene3);
  // 不调用 setWalkableFn：没有可走判定时，两套系统都整段跳过（宁可不摆，不能摆错）。
  layer3.build({ currentMap: { ...map, id: 'dominion_test_v1_nowalkfn' } });
  T('⑯-没有注入 isWalkable 时，地形装饰与沿途色阶都整段跳过（跟 HowlingAbyssDecor 同一条底线）',
    countDescendants(findGroup(layer3.group, 'voidAccents')) === 0
    && countDescendants(findGroup(layer3.group, 'sandTexture')) === 0);
}

// 递归收集全部网格——第三轮把沿途色阶/地形装饰挪进了子分组
// （sandTexture/voidAccents），只查顶层 children 会漏掉里面真正的网格。
function collectMeshes(node, out = []) {
  for (const c of node.children || []) {
    if (c.isMesh) out.push(c);
    collectMeshes(c, out);
  }
  return out;
}

// ==================== 七、setShadowLevel / clear ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });
  layer.setShadowLevel('high');
  const meshes = collectMeshes(layer.group);
  T('⑰-setShadowLevel 打开阴影后，所有网格（含 sandTexture/voidAccents 子分组里的）都开启 castShadow/receiveShadow',
    meshes.length > 0 && meshes.every((m) => m.castShadow && m.receiveShadow));
  layer.setShadowLevel('off');
  T('⑱-setShadowLevel 关闭阴影后恢复', meshes.every((m) => !m.castShadow && !m.receiveShadow));

  layer.clear();
  T('⑲-clear() 之后 group 为空、旗列表清空、scene 上也没有残留',
    layer.group === null && layer._flags.length === 0 && scene.children.length === 0);
}

// ==================== 九、每个据点专属地面色 ====================
{
  const scene = makeScene();
  const layer = new DominionPropsLayer(scene);
  layer.setWalkableFn(ringIsWalkable);
  layer.build({ currentMap: map });
  const meshes = collectMeshes(layer.group);
  // buildNodeGroundPatch 用 CylinderGeometry(r, r*1.05, 1.2, 20)——只看高度
  // 1.2 不够唯一（钻机的油桶盖也用了同样的高度，见 buildDrill 的
  // barrelCapGeo），还要核对 radialSegments=20（油桶盖是 10）才唯一指向地面
  // 色块，不会跟油桶盖混计。
  const patchCandidates = meshes.filter((m) => m.geometry?.parameters?.height === 1.2
    && m.geometry.parameters.radialSegments === 20);
  const patchColors = new Set(patchCandidates.map((m) => m.material.color.getHexString()));
  T('㉓-5 个主题据点各有一块专属地面色块（几何特征匹配 buildNodeGroundPatch）',
    patchCandidates.length === 5);
  T('㉔-5 块地面色块的颜色不是同一个值（据点之间视觉上能分辨，不是复制粘贴）',
    patchColors.size >= 3);
}

// ==================== 十、中央峡谷大岩体沉到 terrainEdge.waterY 那一层 ====================
{
  const withEdge = { ...map, terrainEdge: { waterY: -22, slopeColor: '#976d44', abyssColor: '#201409' } };
  const scene1 = makeScene();
  const layer1 = new DominionPropsLayer(scene1);
  layer1.setWalkableFn(ringIsWalkable);
  layer1.build({ currentMap: withEdge });
  const voidGroupWithEdge = layer1.group.children.find((c) => c.name === 'voidAccents');
  T('㉕-声明了 terrainEdge 时，地形装饰的子分组整体下沉到 waterY',
    voidGroupWithEdge.position.y === -22);

  const scene2 = makeScene();
  const layer2 = new DominionPropsLayer(scene2);
  layer2.setWalkableFn(ringIsWalkable);
  layer2.build({ currentMap: { ...map, id: 'dominion_test_v1_noedge' } });   // 没有声明 terrainEdge
  const voidGroupNoEdge = layer2.group.children.find((c) => c.name === 'voidAccents');
  T('㉖-没有声明 terrainEdge 时，地形装饰子分组用 0 兜底（不会凭空往下沉）',
    voidGroupNoEdge.position.y === 0);
}

// ==================== 八、ThreeRenderer 接线核对（源码层面，跟 sim_frostbridge.mjs
// 对 HowlingAbyssDecor 的核对是同一套做法：这部分要真起一个 WebGL 环境才能
// 端到端验证，不划算，退化成"确实调用了正确的方法名"这个层面的核对）。
{
  const renderer = srcOf('src/presentation/ThreeRenderer.js');
  T('⑳-ThreeRenderer 给 dominionProps 注入了 isWalkable（地形装饰的门控依赖它）',
    /this\.dominionProps\.setWalkableFn\(/.test(renderer));
  T('㉑-ThreeRenderer 每帧调用 dominionProps.update（归属旗才能跟着占领状态实时变色）',
    /this\.dominionProps\.update\(this\.deps\)/.test(renderer));
  T('㉒-ThreeRenderer 仍然在地形重建时调用 dominionProps.build（第一轮就有的接线，不能被这轮改掉）',
    /this\.dominionProps\.build\(this\.mapSystem\)/.test(renderer));
}

done();
