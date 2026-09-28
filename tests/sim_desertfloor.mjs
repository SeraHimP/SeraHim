// 水晶之痕"路以外全是虚空"的修复：路外是沙地（底面 + 沙丘），不再被裙边盖住；
// 预渲染尊重 alphaTest，挖空区不再是一块看不见却写深度的实心板。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { MapSkirtLayer } = await import('../src/presentation/MapSkirtLayer.js');
const { DominionPropsLayer } = await import('../src/presentation/DominionPropsLayer.js');
const { NormalDepthPrepass } = await import('../src/presentation/PostFX.js');
const { T, done } = scoreboard('水晶之痕沙地底面 / 预渲染 alphaTest');

const makeScene = () => ({ children: [], add(o) { this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } });
const lum = (hex) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

// ---- 一、裙边：挖空型地图不生成，其它地图照旧 ----
{
  const scene = makeScene();
  const skirt = new MapSkirtLayer(scene);
  skirt.build({ currentMap: { id: 'a', world: { w: 1000, h: 1000 }, terrainEdge: { waterY: -16 } } });
  T('①声明了 terrainEdge 的地图不生成裙边（底面本来就铺到 3 倍地图边长）', skirt.mesh === null && scene.children.length === 0);
  skirt.build({ currentMap: { id: 'b', world: { w: 1000, h: 1000 } } });
  T('②普通地图照旧有裙边', !!skirt.mesh && scene.children.includes(skirt.mesh));
}

// ---- 二、水晶之痕的底面是沙色，不是近黑的坑 ----
{
  const dom = MAPS.dominion_crystal_scar_v1;
  const te = dom.terrainEdge;
  const floor = new THREE.Color(te.abyssColor);
  const hsl = {}; floor.getHSL(hsl);
  T('③底面亮度与路面同一量级（不是深坑）', lum(te.abyssColor) > 0.6 * lum('#c9915a'));
  T('④底面是黄沙色相（暖黄，饱和度不为零）', hsl.h > 0.06 && hsl.h < 0.16 && hsl.s > 0.3);
  T('⑤斜坡比底面和路面都暗（读得出台地边缘）', lum(te.slopeColor) < lum(te.abyssColor) && lum(te.slopeColor) < lum('#c9915a'));
}

// ---- 三、沙丘只长在路外，而且不进描边预渲染 ----
{
  const ring = (x, y) => { const d = Math.hypot(x - 1100, y - 1100); return d > 750 && d < 1050; };
  const map = {
    id: 'dune_test', visualStyle: 'stylized', paletteId: 'desert', world: { w: 2200, h: 2200 },
    terrainEdge: { waterY: -16, abyssColor: '#d6ad6e', slopeColor: '#a4713f' },
    dominionNodes: [{ id: 'windmill', kind: 'point', pos: { x: 1100, y: 200 } }],
  };
  const layer = new DominionPropsLayer(makeScene());
  layer.setWalkableFn(ring);
  layer.build({ currentMap: map });
  const voidGroup = layer.group.children.find((c) => c.name === 'voidAccents');
  // 沙丘是被拉长的扁网格：长 ≥ 110、高 ≤ 16
  const dunes = voidGroup.children.filter((m) => m.scale && m.scale.x >= 110 && m.scale.y <= 16);
  T('⑥路外确实长出了沙丘', dunes.length > 0);
  T('⑦沙丘中心全部落在不可走区', dunes.every((d) => !ring(d.position.x, d.position.z)));
  const FX_LAYER_BIT = 1 << 2;
  T('⑧沙丘不参与描边/SSAO 预渲染（挪到 FX 层）', dunes.every((d) => (d.layers.mask & 1) === 0 && (d.layers.mask & FX_LAYER_BIT) !== 0));
  const sand = layer.group.children.find((c) => c.name === 'sandTexture');
  T('⑨路面沙纹同样不参与预渲染', sand.children.length > 0 && sand.children.every((m) => (m.layers.mask & 1) === 0));

  const noEdge = new DominionPropsLayer(makeScene());
  noEdge.setWalkableFn(ring);
  noEdge.build({ currentMap: { ...map, id: 'dune_test2', terrainEdge: undefined } });
  const vg2 = noEdge.group.children.find((c) => c.name === 'voidAccents');
  T('⑩没有 terrainEdge 的地图不生成沙丘', !vg2.children.some((m) => m.scale && m.scale.x >= 110 && m.scale.y <= 16));
}

// ---- 四、预渲染：带 alphaTest 的网格换成同样做 alphaTest 的法线材质 ----
{
  const prepass = new NormalDepthPrepass(makeScene(), new THREE.OrthographicCamera(), 4, 4);
  const tex = new THREE.Texture();
  const src = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  const a = prepass._alphaNormal(src);
  T('⑪换出来的是法线编码材质，并且带同一张贴图、同一个 alphaTest 阈值',
    a.userData.alphaNormal === true && a.uniforms.map.value === tex && a.uniforms.alphaTest.value === 0.5
    && /discard/.test(a.fragmentShader) && /\* 0\.5 \+ 0\.5/.test(a.fragmentShader));
  T('⑫同一张贴图复用同一个材质（不每帧新建）', prepass._alphaNormal(src) === a);
}

done();
