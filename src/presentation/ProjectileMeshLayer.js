/**
 * ProjectileMeshLayer.js —— 弹道的三维部分：兵弹、塔弹的弹芯、巨龙吐息。
 *
 * 用户（画面写实化之后）："所有单位的弹道显示效果都要进行优化（防御塔/兵），我觉得目前的可视化弹道已经不再
 * 适配目前写实的风格了。"——原来是低多边形的晶体弹 + 一串叠加发光的八面体残影，放在写实的兵和地形上像贴纸。
 * 现在按"这个单位手里拿的是什么"来画：
 *   · 投石手：一颗受光的石子；长弓手：一支箭（木杆、铁镞、阵营色的尾羽）；弩手：短而粗的弩矢；
 *   · 炮车：一颗铁弹，后面拖着真正的烟（软边烟团，不是一串多面体）；攻城车：翻滚的石块（抛物线）；
 *   · 术士 / 图腾 / 唤灵（法术）：一颗小而亮的光核 + 一圈柔光 + 细长的光尾；
 *   · 防御塔：一枚沿飞行方向拉长的水晶弹芯（亮到能被泛光抓到）+ 彗尾（EffectsLayer 画），不再是一大团光球。
 *   实物弹（石 / 箭 / 铁弹）吃场景光照、参加描边；身后一道很淡的阵营色拖影，保证混战里还看得出是谁的。
 * 仍然没有命中效果（用户："命中特效太显眼了……不要命中特效了"）。
 * 巨龙吐息不变："加纯视觉的吐息"，伤害与时机完全不变。
 *
 * 全部走 InstancedMesh 池：每帧 begin() 清零、各处往池里写实例、end() 提交数量。软边的光 / 烟 / 拖影
 * 借 EffectsLayer 的批（begin(draw) 传进来的 sprite / soft / taper），不另开 draw call。
 * 参数在 CONFIG.ui.projectileFx。
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { CONFIG } from '../data/Config.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';

const cfg = () => CONFIG.ui?.projectileFx || {};
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color(), _x = new THREE.Vector3(1, 0, 0), _d = new THREE.Vector3(), _e = new THREE.Euler();
const WHITE = new THREE.Color('#ffffff');
const hash = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };

class Pool {
  constructor(scene, geo, mat, max, layer = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    if (layer) this.mesh.layers.set(FX_PARTICLE_LAYER);   // 不进法线深度预渲染（描边不勾它们）
    this.max = max; this.n = 0;
    scene.add(this.mesh);
  }
  push(pos, quat, scale, color, k = 1) {
    if (this.n >= this.max) return;
    _m.compose(pos, quat, scale);
    this.mesh.setMatrixAt(this.n, _m);
    _c.set(color).multiplyScalar(k);
    this.mesh.setColorAt(this.n, _c);
    this.n++;
  }
  begin() { this.n = 0; }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  dispose(scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/** 给几何刷一个顶点色（合并前用） */
function tint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo, c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
/**
 * 一支箭（朝 +x 飞，全长 1，箭头在 +0.5）：木杆 + 铁镞。尾羽单独一份几何（另一个池，染阵营色）。
 * 粗细是夸张过的：按真实比例，游戏机位下一支箭连一个像素都不到。
 */
function arrowGeometry() {
  const A = cfg().arrow || {};
  const shaftR = A.shaftR ?? 0.042, headR = A.headR ?? 0.085, headL = A.headL ?? 0.24;
  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, 1 - headL, 5); shaft.rotateZ(-Math.PI / 2); shaft.translate(-headL / 2, 0, 0);
  const head = new THREE.ConeGeometry(headR, headL, 4); head.rotateZ(-Math.PI / 2); head.translate(0.5 - headL / 2, 0, 0);
  return mergeGeometries([tint(shaft, A.wood || '#8a6a44'), tint(head, A.steel || '#c9ced6')], false);
}
function fletchGeometry() {
  const A = cfg().arrow || {};
  const w = A.fletchW ?? 0.11, l = A.fletchL ?? 0.26, parts = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.BufferGeometry();
    // 一片三角形的羽：贴着箭杆，往后越来越宽
    f.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5 + l, 0, 0, -0.5, 0, 0, -0.5 - l * 0.15, w, 0]), 3));
    f.computeVertexNormals();
    f.rotateX(i / 3 * Math.PI * 2);
    parts.push(f);
  }
  return mergeGeometries(parts, false);
}
/** 一块石头：二十面体，顶点抖一下，硬棱 */
function rockGeometry(seed, jitter = 0.22) {
  const g = new THREE.IcosahedronGeometry(1, 0), p = g.attributes.position;   // 多面体几何本来就不带索引
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 7) * 31 + Math.round(p.getY(i) * 11) * 17 + Math.round(p.getZ(i) * 13);
    const s = 1 + (hash(k, seed) - 0.5) * 2 * jitter;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.85, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

export class ProjectileMeshLayer {
  constructor(scene) {
    this.scene = scene;
    const lit = (o = {}) => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8, metalness: 0.05, ...o });
    // 实物弹：吃光照、进描边预渲染（layer = false）
    this.arrow = new Pool(scene, arrowGeometry(), lit({ vertexColors: true, roughness: 0.6 }), 400, false);
    this.fletch = new Pool(scene, fletchGeometry(), lit({ side: THREE.DoubleSide, roughness: 0.9 }), 400, false);
    this.stone = new Pool(scene, rockGeometry(3), lit({ roughness: 0.92 }), 500, false);
    this.ball = new Pool(scene, new THREE.IcosahedronGeometry(1, 1), lit({ flatShading: false, roughness: 0.42, metalness: 0.75 }), 160, false);
    // 发光的弹芯：不吃光照，颜色可以超过 1（被泛光抓到）
    this.bolt = new Pool(scene, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(), 400);
    this.orb = new Pool(scene, new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial(), 500);
    this.ghost = new Pool(scene, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 600);   // 吐息的外焰
    this.pools = [this.arrow, this.fletch, this.stone, this.ball, this.bolt, this.orb, this.ghost];
    this.fx = [];          // 巨龙吐息：{ type, t, dur, ... }
    this._draw = null;     // EffectsLayer 这一帧借给我们的批：{ sprite, soft, taper }
    this._last = performance.now();
  }

  /** @param draw { sprite(x,y,z,size,color,alpha), soft(a[3],b[3],width,color,alpha), taper(a[3],b[3],wA,wB,color,aA,aB) }，无头测试可以不传 */
  begin(draw = null) { this._draw = draw; for (const p of this.pools) p.begin(); }

  /** 这个兵种的弹是什么形状（CONFIG.ui.projectileFx.shapes；没登记的一律当法术光弹） */
  shapeOf(kind) { return (cfg().shapes || {})[kind] || 'orb'; }

  /** 身后那道很淡的拖影：实物弹自己不发光，靠它在混战里认出是哪一方的 */
  _streak(head, back, len, width, color, alpha) {
    const D = this._draw; if (!D || !(alpha > 0)) return;
    const b = back(len); if (!b) return;
    D.taper(b, head, width * 0.2, width, _c2.set(color), 0, alpha);
  }

  /**
   * 兵弹。头在 head = [x, y, z]，朝 dir（单位向量）飞；back(dist) → 沿来路往回 dist 处的 [x, y, z]（没有就返回 null）。
   * size = 逻辑层给的弹丸尺寸；color = 阵营 / 技能色（十六进制数）。
   */
  minionBolt(kind, head, dir, size, color, back) {
    const C = cfg().minion || {}, D = this._draw;
    const s = size * (C.sizeK ?? 0.26);
    const shape = this.shapeOf(kind);
    _q.setFromUnitVectors(_x, _d.set(dir.x, dir.y, dir.z).normalize());
    _p.set(head[0], head[1], head[2]);
    if (shape === 'arrow' || shape === 'quarrel') {
      const A = cfg().arrow || {};
      const L = s * (shape === 'quarrel' ? (A.quarrelLen ?? 3.0) : (A.len ?? 4.2)), W = L * (shape === 'quarrel' ? (A.quarrelThick ?? 1.9) : 1);
      // 箭头在 head：几何的箭尖在 +0.5，所以中心往回退半支箭
      _p.set(head[0] - _d.x * L * 0.5, head[1] - _d.y * L * 0.5, head[2] - _d.z * L * 0.5);
      this.arrow.push(_p, _q, _s.set(L, W, W), '#ffffff');
      this.fletch.push(_p, _q, _s.set(L, W, W), color, A.fletchTint ?? 0.9);
      this._streak(head, back, L * (A.streakLen ?? 2.2), s * (A.streakW ?? 0.42), color, A.streakAlpha ?? 0.3);
      return;
    }
    if (shape === 'stone') {
      const R = cfg().sling || {};
      const t = performance.now() / 1000 * (R.spin ?? 9);
      this.stone.push(_p, _q.setFromEuler(_e.set(t, t * 0.7, 0)), _s.setScalar(s * (R.size ?? 0.62)), R.color || '#8f897e');
      this._streak(head, back, s * (R.streakLen ?? 4.5), s * (R.streakW ?? 0.5), color, R.streakAlpha ?? 0.26);
      return;
    }
    // 法术光弹：亮核（偏白的技能色）+ 柔光 + 细长光尾
    const O = cfg().orb || {};
    const r = s * (O.core ?? 0.5);
    _c2.set(color).lerp(WHITE, O.coreWhite ?? 0.55);
    this.orb.push(_p, _q.identity(), _s.setScalar(r), '#' + _c2.getHexString(), O.coreGain ?? 1.5);
    if (D) {
      D.sprite(head[0], head[1], head[2], s * (O.halo ?? 2.6), _c2.set(color), O.haloAlpha ?? 0.5);
      const b = back(s * (O.tailLen ?? 6));
      if (b) {
        D.taper(b, head, 0, r * 1.5, _c2.set(color), 0, O.tailAlpha ?? 0.55);
        D.taper(b, head, 0, r * 0.5, WHITE, 0, (O.tailAlpha ?? 0.55) * 0.8);
      }
    }
    if (kind === 'warlock') {   // 术士弹：三颗绕着弹头转的小光点
      const W = cfg().warlock || {};
      const t = performance.now() / 1000 * (W.spin ?? 8);
      const rr = s * (W.radius ?? 2.2);
      for (let i = 0; i < (W.motes ?? 3); i++) {
        const a = t + i / (W.motes ?? 3) * Math.PI * 2;
        this.orb.push(_p.set(head[0] + Math.cos(a) * rr, head[1] + Math.sin(a) * rr * 0.7, head[2] + Math.sin(a) * rr), _q.identity(), _s.setScalar(s * (W.moteSize ?? 0.2)), W.moteColor || '#e0b0ff', 1.4);
      }
    }
  }

  /**
   * 炮车的铁弹 / 攻城车的石块，后面拖烟。kind 决定是铁弹还是石头（shapes：ball / boulder）。
   * spin = 飞行进度（0..1），用来让石块翻滚、让烟团各不相同。
   */
  siegeStone(head, size, color, back, spin, kind = 'siege') {
    const C = cfg().siege || {}, D = this._draw;
    const s = size * (C.stoneK ?? 0.42);
    _p.set(head[0], head[1], head[2]);
    if (this.shapeOf(kind) === 'boulder') this.stone.push(_p, _q.setFromEuler(_e.set(spin * 5, spin * 3, 0)), _s.setScalar(s * (C.boulderK ?? 1.1)), C.stoneColor || '#6a655e');
    else this.ball.push(_p, _q.identity(), _s.setScalar(s * (C.ballK ?? 0.8)), C.ballColor || '#3a3b40');
    if (!D) return;
    // 烟：沿来路几团软边的灰烟，越往后越大越淡，慢慢往上飘
    const n = C.smoke ?? 6, sc = _c2.set(C.smokeColor || '#a89a86');
    for (let i = 1; i <= n; i++) {
      const b = back(s * (C.smokeGap ?? 1.5) * i);
      if (!b) break;
      const k = 1 - i / (n + 1), j = hash(i, Math.floor(spin * 7));
      D.sprite(b[0] + (j - 0.5) * s * 0.5, b[1] + i * (C.smokeRise ?? 0.7), b[2] + (hash(i, 3) - 0.5) * s * 0.5, s * (1.3 + (1 - k) * (C.smokeGrow ?? 2.4)), sc, (C.smokeAlpha ?? 0.46) * k);
    }
    this._streak(head, back, s * 3, s * 0.5, color, C.streakAlpha ?? 0.22);
  }

  /**
   * 防御塔弹的弹芯：一枚沿飞行方向拉长的水晶（阵营色偏白，亮到进泛光）+ 一小圈柔光。彗尾由 EffectsLayer 画。
   * heat = 穿透弹的升温（0..1）：越热越白、略大。
   */
  towerBolt(head, dir, size, color, heat = 0) {
    const T = cfg().tower || {}, D = this._draw;
    _q.setFromUnitVectors(_x, _d.set(dir.x, dir.y, dir.z).normalize());
    _p.set(head[0], head[1], head[2]);
    const L = size * (T.shardLen ?? 0.62), W = size * (T.shardWidth ?? 0.2);
    _c2.set(color).lerp(WHITE, (T.shardWhite ?? 0.45) + heat * 0.3);
    this.bolt.push(_p, _q, _s.set(L, W, W), '#' + _c2.getHexString(), T.shardGain ?? 1.7);
    if (D) {
      D.sprite(head[0], head[1], head[2], size * (T.haloK ?? 0.9), _c2.set(color), T.haloAlpha ?? 0.55);
      D.sprite(head[0], head[1], head[2], size * (T.coreK ?? 0.3), WHITE, 0.9);
    }
  }

  /** 巨龙吐息：从嘴边到目标一团翻滚的元素色碎块（纯视觉） */
  breath(from, to, color, size) {
    const B = cfg().breath || {};
    // 时长与伤害结算同一个值（CombatSystem 按它延迟巨龙的命中），画面落地 = 伤害落地
    this.fx.push({ type: 'breath', t: 0, dur: CONFIG.gameRules?.dragon?.combat?.breathTravelSec ?? B.dur ?? 0.32, from: from.slice(), to: to.slice(), color, size, seed: Math.random() * 1000 });
  }

  /** 推进吐息，写进池里 */
  _updateFx(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const x = f.t / f.dur;
      if (x >= 1) { this.fx.splice(i, 1); continue; }
      if (f.type === 'breath') {
        const B = cfg().breath || {};
        const n = B.chunks ?? 7;
        for (let j = 0; j < n; j++) {
          const lag = j / n * (B.lag ?? 0.45);
          const u = Math.max(0, Math.min(1, (x - lag) / (1 - lag)));
          if (u <= 0) continue;
          const sp = f.size * (B.spread ?? 0.25) * u;
          const px = f.from[0] + (f.to[0] - f.from[0]) * u + (hash(j, f.seed) - 0.5) * sp * 2;
          const py = f.from[1] + (f.to[1] - f.from[1]) * u + (hash(j, f.seed + 1) - 0.5) * sp;
          const pz = f.from[2] + (f.to[2] - f.from[2]) * u + (hash(j, f.seed + 2) - 0.5) * sp * 2;
          const s = f.size * (B.size ?? 0.5) * (1 - j / n * 0.5) * (0.6 + u * 0.6);
          _q.setFromEuler(new THREE.Euler(j + u * 8, j * 2 + u * 5, 0));
          const hot = j < 2;
          this.bolt.push(_p.set(px, py, pz), _q, _s.setScalar(s * 0.55), hot ? (B.coreColor || '#fff0c0') : f.color);
          this.ghost.push(_p.set(px, py, pz), _q, _s.setScalar(s), f.color, 0.55 * (1 - u * 0.5));
        }
      }
    }
  }

  end() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this._updateFx(dt);
    for (const p of this.pools) p.end();
  }

  clear() { this.fx = []; for (const p of this.pools) { p.begin(); p.end(); } }
  dispose() { for (const p of this.pools) p.dispose(this.scene); }
}
