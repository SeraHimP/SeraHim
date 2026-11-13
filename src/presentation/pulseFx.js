/**
 * pulseFx.js —— 一次性的小特效池：地面上扩开的光环、施法时身上闪的一下。
 *
 * 用在两处（都是"逻辑层只留一个时间戳，画面看到时间戳变了就播一次"）：
 *   · 范围攻击（attackMode = 'area' 的通用实现）：每次出手从脚下扩开一圈光环到射程边缘——
 *     用户定的四种攻击方式里"范围型伤害……有范围光环"；
 *   · 术士兵三连咒击的第三下：身上一道竖起来的符文环 + 一团闪光（"第三个块是其他颜色并且攻击时触发特效"）。
 * 网格和材质放在池子里循环用，播完收回，不会越播越多。参数在 CONFIG.ui.pulseFx。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { dotTexture } from './UnitMeshFactory.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';

const easeOut = (x) => 1 - (1 - x) * (1 - x);

export class PulseFx {
  constructor(scene) {
    this.scene = scene; this.live = []; this.pool = { ring: [], flash: [] };
    this._ringGeo = null; this._last = (typeof performance !== 'undefined' ? performance.now() : 0);
  }
  _ring() {
    let m = this.pool.ring.pop();
    if (!m) {
      if (!this._ringGeo) this._ringGeo = new THREE.RingGeometry(0.86, 1, 56);
      m = new THREE.Mesh(this._ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.layers.set(FX_PARTICLE_LAYER); m.renderOrder = 6;
    }
    this.scene.add(m); return m;
  }
  _flash() {
    let s = this.pool.flash.pop();
    if (!s) { s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); s.layers.set(FX_PARTICLE_LAYER); }
    this.scene.add(s); return s;
  }
  /** 地面光环：从 r0 扩到 r1，边扩边淡。 */
  ground({ x, y, z, r0 = 4, r1, color, dur, gain }) {
    const P = CONFIG.ui?.pulseFx?.area || {};
    const m = this._ring();
    m.rotation.set(-Math.PI / 2, 0, 0); m.position.set(x, y, z); m.material.color.set(color);
    this.live.push({ kind: 'ring', obj: m, t: 0, dur: dur ?? P.dur ?? 0.45, r0, r1, gain: gain ?? P.gain ?? 0.85 });
  }
  /** 施法：一道竖着的环从腰间升到头顶并扩开 + 一团闪光。h = 单位身高。 */
  cast({ x, y, z, h, color }) {
    const P = CONFIG.ui?.pulseFx?.cast || {};
    const dur = P.dur ?? 0.5;
    for (let i = 0; i < (P.rings ?? 2); i++) {
      const m = this._ring();
      m.rotation.set(-Math.PI / 2, 0, 0); m.position.set(x, y + h * 0.3, z); m.material.color.set(color);
      this.live.push({ kind: 'rise', obj: m, t: -i * dur * 0.22, dur, r0: h * 0.25, r1: h * (P.radiusK ?? 0.9), y0: y + h * 0.25, y1: y + h * (1.1 + i * 0.25), gain: P.gain ?? 1.6 });
    }
    const s = this._flash();
    s.position.set(x, y + h * 0.95, z); s.material.color.set(color);
    this.live.push({ kind: 'flash', obj: s, t: 0, dur: dur * 0.7, size: h * (P.flashK ?? 1.6), gain: P.flashGain ?? 1.4 });
  }
  update() {
    const now = performance.now(), dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const a = this.live[i]; a.t += dt;
      const x = a.t / a.dur;
      if (x >= 1) { this.scene.remove(a.obj); this.pool[a.kind === 'flash' ? 'flash' : 'ring'].push(a.obj); this.live.splice(i, 1); continue; }
      a.obj.visible = x >= 0;
      if (x < 0) continue;
      if (a.kind === 'flash') { const s = a.size * (0.4 + 0.6 * easeOut(x)); a.obj.scale.set(s, s, 1); a.obj.material.opacity = Math.sin(Math.PI * Math.min(1, x * 1.15)) * a.gain; continue; }
      const r = a.r0 + (a.r1 - a.r0) * easeOut(x);
      a.obj.scale.set(r, r, 1);
      a.obj.material.opacity = (1 - x) * Math.min(1, x * 8) * a.gain;
      if (a.kind === 'rise') a.obj.position.y = a.y0 + (a.y1 - a.y0) * easeOut(x);
    }
  }
  clear() { for (const a of this.live) this.scene.remove(a.obj); this.live.length = 0; }
  dispose() { this.clear(); for (const k of ['ring', 'flash']) for (const o of this.pool[k]) o.material.dispose(); this._ringGeo?.dispose(); }
}

/**
 * 这一帧要不要为这个单位播特效（纯函数，便于测试）：时间戳变了、而且是刚发生的（切图 / 读档带进来的旧时间戳不播）。
 * @param seen  画面上一次看到的时间戳  @param stamp 逻辑层现在的时间戳  @param now 当前游戏时间
 */
export function pulseDue(seen, stamp, now, fresh = 0.6) {
  return stamp != null && stamp !== seen && (now - stamp) >= 0 && (now - stamp) < fresh;
}
