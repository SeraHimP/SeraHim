/**
 * 模型预览页（开发用，不接进游戏）：把建筑 / 小兵 / 巨龙的模型排成一排，在和游戏相同的光照、色调映射下看。
 * 调模型时不用每次进图等地形建完。
 *   ?set=buildings|minions|dragons  &faction=blue|red|both  &dmg=0|1|2  &ruin=1  &elev=57  &zoom=1  &night=1  &only=tower,orb,gem / 兵种名
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG, MINION_SIZES } from '../../src/data/Config.js';
import { towerMesh, minionMesh, dragonMesh, crystalMaterial } from '../../src/presentation/UnitMeshFactory.js';
import { animMaterials } from '../../src/presentation/unitRig.js';
import { MINION_MODEL_TYPES } from '../../src/presentation/unitModels.js';
import { SkyLight } from '../../src/presentation/skyLight.js';
import { worldUniforms } from '../../src/presentation/world/worldShading.js';

const q = new URLSearchParams(location.search);
if (q.get('style')) { CONFIG.ui.statueTower.style = q.get('style'); CONFIG.ui.crystalShrine.style = q.get('style'); }   // statue = 上一版雕像造型，对照用
const set = q.get('set') || 'buildings', fac = q.get('faction') || 'both';
const night = q.get('night') === '1';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const sunDir = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();
const sun = new THREE.DirectionalLight(night ? '#a9bfee' : '#fff4e0', night ? 1.6 : 3.4);
sun.position.copy(sunDir).multiplyScalar(900); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 2400 }); sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);
scene.add(new THREE.HemisphereLight(night ? '#2b3a66' : '#95bced', night ? '#232a3a' : '#5f6b55', night ? 0.5 : 0.8));
const sky = new SkyLight(renderer, scene);
sky.update({ sunDir, skyZenith: night ? '#2b3a66' : '#95bced', skyHorizon: night ? '#111a30' : '#dfe8f3', ground: '#5f6b55', sunColor: night ? '#a9bfee' : '#fff4e0', gain: 1, intensity: night ? 0.6 : 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: q.get('ground') || '#72804a', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const items = [];   // { obj, x, z, r }
const only = (q.get('only') || '').split(',').filter(Boolean);
const facs = fac === 'both' ? ['blue', 'red'] : [fac];
const colorOf = (f) => (f === 'blue' ? '#5b9bd5' : '#e0473f');
const crystals = [];
if (set === 'buildings') {
  const dmg = +(q.get('dmg') || 0), ruin = q.get('ruin') === '1';
  const defs = [['tower', 'outer', CONFIG.buildingSizes.outer], ['orb', 'nexus_lane', CONFIG.buildingSizes.nexus_lane], ['gem', 'nexus_main', CONFIG.buildingSizes.nexus_main]]
    .filter((d) => !only.length || only.includes(d[0]));
  let z = 0, x = 0;
  for (const f of facs) {
    for (const [kind, tier, R] of defs) {
      const key = `mv|${kind}|${f}|${dmg}|${ruin}`;
      const m = towerMesh(key, colorOf(f), R, '', kind, false, ruin, tier, f, dmg, {});
      const mesh = new THREE.Mesh(m.geo, m.mat); mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.set(x, 0, z); scene.add(mesh);
      if (m.crystal) {
        const cm = new THREE.Mesh(m.crystal.geo, crystalMaterial(colorOf(f))); cm.material.emissiveIntensity = (CONFIG.ui.crystal.emissiveBase ?? 0.7) + (night ? CONFIG.ui.towerLight.emissiveNight : 0);
        cm.position.set(x + (m.crystal.cx || 0), m.crystal.cy, z + (m.crystal.cz || 0)); scene.add(cm); crystals.push(cm);
      }
      items.push({ x, z, r: R }); x += R * 2 + 80;
    }
  }
} else if (set === 'minions') {
  const types = (only.length ? only : MINION_MODEL_TYPES);
  let z = 0;
  for (const f of facs) {
    let x = 0, i = 0;
    for (const t of types) {
      const size = MINION_SIZES[t] || 12;
      const m = minionMesh(`mv|${t}|${f}`, colorOf(f), size, t, f);
      const mat = animMaterials(false); mat.userData.uAnim.value.set(i * 0.9, q.get('walk') === '0' ? 0 : 1, q.get('atk') ? +q.get('atk') : -1, 1.3);
      const mesh = new THREE.Mesh(m.geo, mat); mesh.castShadow = mesh.receiveShadow = true; mesh.customDepthMaterial = mat.userData.depthMaterial;
      mesh.position.set(x, 0, z); mesh.rotation.y = +(q.get('rot') || 0.5); scene.add(mesh);
      items.push({ x, z, r: size }); x += 46; i++;
      if (i % (+(q.get('cols') || 9)) === 0) { x = 0; z += 60; }
    }
    z += 64; if (x) { x = 0; }
  }
} else {
  const els = only.length ? only : [null, 'fire', 'water', 'frost', 'thunder'];
  let x = 0;
  for (const el of els) {
    const anc = el === 'ancient';
    const m = dragonMesh(`mv|d|${el}`, anc ? '#8a5cc8' : '#c0392b', anc, anc ? CONFIG.dragonSizes.ancient : CONFIG.dragonSizes.element, anc ? null : el);
    const mat = animMaterials(false); mat.userData.uAnim.value.set(0.6, 0, -1, 1.3);
    const mesh = new THREE.Mesh(m.geo, mat); mesh.castShadow = mesh.receiveShadow = true; mesh.customDepthMaterial = mat.userData.depthMaterial;
    mesh.position.set(x, 0, 0); mesh.rotation.y = 0.6; scene.add(mesh);
    items.push({ x, z: 0, r: 40 }); x += 150;
  }
}
// 相机：对准全部模型的中心，俯仰角同游戏
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const it of items) { minX = Math.min(minX, it.x - it.r); maxX = Math.max(maxX, it.x + it.r); minZ = Math.min(minZ, it.z - it.r); maxZ = Math.max(maxZ, it.z + it.r); }
const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, span = Math.max(maxX - minX, (maxZ - minZ) * 1.6, 60);
const elev = (+(q.get('elev') || 57)) * Math.PI / 180, zoom = +(q.get('zoom') || 1);
const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 5, 9000);
// 机位距离按"游戏里的缩放"给：gz = 每世界单位占多少像素（游戏里拉近看塔大约 2.5）
const D = (innerHeight / 2) / ((+(q.get('gz') || 2.5)) * Math.tan(22.5 * Math.PI / 180));
const ty = +(q.get('ty') || (set === 'buildings' ? 45 : 10));
cam.position.set(cx + (+(q.get('ox') || 0)), ty + D * Math.sin(elev), cz + D * Math.cos(elev)); cam.lookAt(cx + (+(q.get('ox') || 0)), ty, cz);
sun.target.position.set(cx, 0, cz); sun.position.set(cx, 0, cz).addScaledVector(sunDir, 900); scene.add(sun.target);
const U = worldUniforms();
let t = 0;
function frame() {
  t += 1 / 60; U.uWTime.value = t;
  for (const c of crystals) c.rotation.y = t * 0.6;
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}
frame();
window.__ready = true;
