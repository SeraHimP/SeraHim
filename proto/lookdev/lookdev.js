/**
 * lookdev.js —— 阶段 0 "看图定方向"原型：召唤师峡谷中路一段（蓝方外塔 + 河道 + 野区岩壁），
 * 用新的相机 / 光照 / 材质 / 地形 / 水 / 树 / 后处理渲染。
 *
 * 不是正式代码：目的只是让用户拍板风格（docs/VISUAL-REWORK-REPORT.md §6 阶段 0）。
 * URL 参数：?variant=a（偏 Dota2：低太阳、暖光、重雾、偏暗）| b（偏 LoL：高太阳、明亮饱和）
 *          &w=1600&h=1000（渲染尺寸）
 */
import * as THREE from '../../vendor/three.module.js';
import { EntityContainer } from '../../src/core/EntityContainer.js';
import { EventBus } from '../../src/utils/EventBus.js';
import { MapSystem } from '../../src/systems/MapSystem.js';
import { towerMesh } from '../../src/presentation/UnitMeshFactory.js';
import { grassTexture, dirtTexture, rockTexture, mossTexture, barkTexture, leafClusterTexture, skyEquirect } from './texgen.js';
import { makeHeightSampler, buildTerrain, buildCliffRocks } from './terrain.js';
import { LookdevWater, waterNormalTexture } from './water.js';
import { buildPost } from './post.js';
import { buildTrees, placeTrees } from './trees.js';

const q = new URLSearchParams(location.search);
const VARIANT = q.get('variant') || 'a';
const W = +(q.get('w') || 1600), H = +(q.get('h') || 1000);

const VARIANTS = {
  // 偏 Dota2：太阳低、暖、影子长；天空偏青；雾重；曝光略低
  a: { sunEl: 34, sunAz: 215, sunCol: '#ffd9a8', sunI: 4.6, skyGain: 0.85, zenith: [0.22, 0.36, 0.62], horizon: [0.74, 0.74, 0.76],
       fog: '#9aa6ad', fogD: 0.00026, exposure: 1.0, bloom: 0.22, shallow: '#2f6f6c', deep: '#0a2630', aoPower: 1.4 },
  // 偏 LoL：太阳高、白、影子短；天空蓝；雾轻；曝光略高
  b: { sunEl: 52, sunAz: 205, sunCol: '#fff4e0', sunI: 4.8, skyGain: 1.1, zenith: [0.30, 0.50, 0.85], horizon: [0.82, 0.86, 0.92],
       fog: '#b7c6d4', fogD: 0.00018, exposure: 1.08, bloom: 0.28, shallow: '#3e948e', deep: '#0f3f4c', aoPower: 1.3 },
};
const V = VARIANTS[VARIANT] || VARIANTS.a;
const DEG = Math.PI / 180;

window.__ready = false;
const canvas = document.getElementById('c'); canvas.width = W; canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = V.exposure;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---- 地图数据：真实的召唤师峡谷布局（可走 / 河道 / 兵线）----
const eb = new EventBus(), ec = new EntityContainer(eb);
const ms = new MapSystem(ec, eb);
ms.loadMap('summoners_rift_v1');
ms.active = true;
// 切片：蓝方中路外塔 (1403,2017) 附近，含河道交叉和两侧野区岩壁
const PLAY = { x0: 1000, y0: 1500, x1: 2000, y1: 2400 };
const EXT = 700;   // 延伸世界：切片外再铺这么宽，升成山壁后被雾吃掉
const REGION = { x0: PLAY.x0 - EXT, y0: PLAY.y0 - EXT, x1: PLAY.x1 + EXT, y1: PLAY.y1 + EXT };
const sampler = makeHeightSampler(ms, PLAY);

const scene = new THREE.Scene();
// ---- 天空 / IBL ----
const sky = skyEquirect(1024, 512, { sunAz: V.sunAz * DEG, sunEl: V.sunEl * DEG, zenith: V.zenith, horizon: V.horizon, gain: V.skyGain });
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(sky).texture;
scene.background = sky;
scene.fog = new THREE.FogExp2(new THREE.Color(V.fog), V.fogD);

// ---- 太阳 ----
const sun = new THREE.DirectionalLight(new THREE.Color(V.sunCol), V.sunI);
const sdir = new THREE.Vector3(Math.cos(V.sunEl * DEG) * Math.cos(V.sunAz * DEG), Math.sin(V.sunEl * DEG), Math.cos(V.sunEl * DEG) * Math.sin(V.sunAz * DEG));
const center = new THREE.Vector3((PLAY.x0 + PLAY.x1) / 2, 0, (PLAY.y0 + PLAY.y1) / 2);
sun.position.copy(center).addScaledVector(sdir, 1500); sun.target.position.copy(center); scene.add(sun.target);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera; sc.left = -900; sc.right = 900; sc.top = 900; sc.bottom = -900; sc.near = 200; sc.far = 3400;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 1.2; sun.shadow.radius = 2;
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.05));

// ---- 相机：透视，俯仰 57°，从南侧看 ----
const camera = new THREE.PerspectiveCamera(45, W / H, 20, 9000);
const PITCH = 57 * DEG, DIST = 820;
const target = new THREE.Vector3(1690, 0, 1810);   // 河道与中路交叉口在画面中偏右上，蓝方外塔在左下
camera.position.set(target.x, Math.sin(PITCH) * DIST, target.z + Math.cos(PITCH) * DIST);
camera.lookAt(target);
camera.updateProjectionMatrix();

// ---- 贴图 ----
const tex = { grass: grassTexture(1024), dirt: dirtTexture(1024), rock: rockTexture(1024), moss: mossTexture(1024) };
const bark = barkTexture(512), leaf = leafClusterTexture(512, 2);

// ---- 地形 / 岩块 / 水 / 树 ----
const terrain = buildTerrain(sampler, REGION, 7, tex); scene.add(terrain);
const rocks = buildCliffRocks(sampler, PLAY, tex, 1700); scene.add(rocks);
const waterTex = waterNormalTexture(512);
const water = new LookdevWater(renderer, scene, camera, PLAY, -9, waterTex, { shallow: V.shallow, deep: V.deep, sunCol: V.sunCol, fog: V.fog, fogDensity: V.fogD });
water.setSun(sdir, V.sunCol);
const trees = buildTrees(sampler, REGION, placeTrees(sampler, REGION, 1400, 3), bark, leaf, 1); scene.add(trees);

// ---- 一座塔（现有模型几何，换 PBR 石材 + 发光水晶）----
{
  const m = towerMesh('lookdev|tower', '#5b9bd5', 40, '', 'tower', false, false, 'outer', 'blue', 0, { fx: { standing: true } });
  const stone = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.rock.map, normalMap: tex.rock.normalMap, roughness: 0.85, metalness: 0.05 });
  stone.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vOP; varying vec3 vON;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vOP = position; vON = normal;');
    sh.fragmentShader = `varying vec3 vOP; varying vec3 vON;
vec3 tri3(sampler2D t, vec3 p, vec3 n, float s){ vec3 w = abs(n); w = w*w; w /= (w.x+w.y+w.z); return texture2D(t, p.yz*s).rgb*w.x + texture2D(t, p.xz*s).rgb*w.y + texture2D(t, p.xy*s).rgb*w.z; }
` + sh.fragmentShader.replace('#include <map_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), tri3(map, vOP, normalize(vON), 0.06), 0.85) * 1.15;')
      .replace('#include <normal_fragment_maps>', '');
  };
  stone.customProgramCacheKey = () => 'lookdev-tower-1';
  const tower = new THREE.Mesh(m.geo, stone);
  const tp = { x: 1403, y: 2017 };
  tower.position.set(tp.x, sampler.h(tp.x, tp.y) + 1, tp.y);
  tower.castShadow = tower.receiveShadow = true;
  scene.add(tower);
  if (m.crystal?.geo) {
    const cm = new THREE.MeshStandardMaterial({ color: 0x9fd6ff, emissive: 0x4aa8ff, emissiveIntensity: 3.5, roughness: 0.15, metalness: 0 });
    const cr = new THREE.Mesh(m.crystal.geo, cm); cr.position.copy(tower.position); scene.add(cr);
    const pl = new THREE.PointLight(0x5fb6ff, 60, 260, 2); pl.position.set(tp.x + (m.crystal.cx || 0), tower.position.y + m.crystal.cy, tp.y + (m.crystal.cz || 0)); scene.add(pl);
  }
}

// ---- 后处理 ----
const post = buildPost(renderer, scene, camera, W, H, { ssao: { radius: 16, bias: 0.5, power: V.aoPower }, bloomStrength: V.bloom, bloomThreshold: 1.0, bloomRadius: 0.55 });
water.setDepthTexture(post.depthRT.depthTexture, W, H);

let t = 0;
renderer.info.autoReset = false;
function frame() {
  t += 1 / 30;
  renderer.info.reset();
  post.renderDepth([water.mesh]);          // 不透明场景深度：水面与 SSAO 共用
  water.renderReflection(t);               // 镜像视角 → 反射 RT
  post.composer.render();
  window.__info = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, tex: renderer.info.memory.textures, geo: renderer.info.memory.geometries };
  window.__ready = true;
}
frame();
if (!q.has('once')) setInterval(frame, 1000 / 30);
window.__lookdev = { scene, camera, renderer, sampler, frame };
