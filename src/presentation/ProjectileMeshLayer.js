/**
 * ProjectileMeshLayer.js —— 弹道的三维部分：小兵的低多边形实体弹、巨龙吐息。
 *
 * 用户定稿（2026-09-27 三选）：
 *   · "A 为主，塔弹用 B"：小兵弹是低多边形实体弹（晶体弹头 + 残影；炮车是抛物线石弹 + 烟团；
 *     术士弹带三颗绕转的小光点），防御塔弹仍是能量光弹（在 EffectsLayer 里画，拖尾加长）；
 *   · 巨龙"加纯视觉的吐息"：攻击时朝目标吐一团元素色的翻滚碎块，伤害与时机完全不变；
 *   · 没有命中效果：第一版做了（塔弹放射火花 + 闪光，小兵弹碎晶 + 地面光环），用户实机看后
 *     "命中特效太显眼了……不要命中特效了"，整段删掉。
 *
 * 全部走 InstancedMesh 池：每帧 begin() 清零、各处往池里写实例、end() 提交数量。
 * 同屏上百发兵弹也只是几个 draw call。参数在 CONFIG.ui.projectileFx。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';

const cfg = () => CONFIG.ui?.projectileFx || {};
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color(), _x = new THREE.Vector3(1, 0, 0), _d = new THREE.Vector3();
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

export class ProjectileMeshLayer {
  constructor(scene) {
    this.scene = scene;
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    this.bolt = new Pool(scene, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(), 400);          // 实体弹头
    this.ghost = new Pool(scene, new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(add), 1600);     // 残影 / 小光点
    this.stone = new Pool(scene, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), 120, false);
    this.puff = new Pool(scene, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0.45, depthWrite: false }), 600);
    this.pools = [this.bolt, this.ghost, this.stone, this.puff];
    this.fx = [];          // 巨龙吐息：{ type, t, dur, ... }
    this._last = performance.now();
  }

  begin() { for (const p of this.pools) p.begin(); }

  /** 小兵实体弹：头 (x, y, z)，朝向 dir（单位向量），走过的线上往回取残影位置用 back(dist) → [x, y, z] */
  minionBolt(kind, head, dir, size, color, back) {
    const C = cfg().minion || {};
    const s = size * (C.sizeK ?? 0.3);
    _q.setFromUnitVectors(_x, _d.copy(dir).normalize());
    const len = C.boltLen ?? 1.9, wid = C.boltWidth ?? 0.65;
    // 弹头：实心、偏白一点的队伍色
    _c.set(color).lerp(new THREE.Color('#ffffff'), C.headWhite ?? 0.3);
    this.bolt.push(_p.set(head[0], head[1], head[2]), _q, _s.set(s * len, s * wid, s * wid), '#' + _c.getHexString());
    // 残影：沿来路往回几颗，越远越小越淡（叠加发光，淡 = 颜色变暗）
    const n = C.afterimages ?? 4, gap = s * (C.spacing ?? 1.6);
    for (let i = 1; i <= n; i++) {
      const b = back(gap * i);
      if (!b) break;
      const k = 1 - i / (n + 1);
      this.ghost.push(_p.set(b[0], b[1], b[2]), _q, _s.set(s * len * (0.4 + 0.6 * k), s * wid * k, s * wid * k), color, 0.7 * k);
    }
    if (kind === 'warlock') {   // 术士弹：三颗绕着弹头转的小光点
      const W = cfg().warlock || {};
      const t = performance.now() / 1000 * (W.spin ?? 8);
      const r = s * (W.radius ?? 2.2);
      for (let i = 0; i < (W.motes ?? 3); i++) {
        const a = t + i / (W.motes ?? 3) * Math.PI * 2;
        this.ghost.push(_p.set(head[0] + Math.cos(a) * r, head[1] + Math.sin(a) * r * 0.7, head[2] + Math.sin(a) * r), _q.identity(), _s.setScalar(s * 0.45), W.moteColor || '#e0b0ff', 1);
      }
    }
    // 弹头一圈淡淡的光
    this.ghost.push(_p.set(head[0], head[1], head[2]), _q.identity(), _s.setScalar(s * 1.1), color, 0.25);
  }

  /** 炮车石弹：深色低多边形石块（翻滚），后面拖几团烟 */
  siegeStone(head, size, color, back, spin) {
    const C = cfg().siege || {};
    const s = size * (C.stoneK ?? 0.42);
    _q.setFromEuler(new THREE.Euler(spin * 5, spin * 3, 0));
    this.stone.push(_p.set(head[0], head[1], head[2]), _q, _s.setScalar(s), C.stoneColor || '#3c3a38');
    this.ghost.push(_p.set(head[0], head[1], head[2]), _q.identity(), _s.setScalar(s * 1.2), color, 0.3);
    const n = C.smoke ?? 6;
    for (let i = 1; i <= n; i++) {
      const b = back(s * 1.6 * i);
      if (!b) break;
      const k = 1 - i / (n + 1);
      this.puff.push(_p.set(b[0], b[1] + i * 0.6, b[2]), _q.identity(), _s.setScalar(s * (0.35 + (1 - k) * 0.6)), C.smokeColor || '#a89a86');
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
