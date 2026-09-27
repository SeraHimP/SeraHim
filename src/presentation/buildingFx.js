/**
 * buildingFx.js —— 防御塔 / 召唤水晶 / 水晶枢纽的三段动画。
 *
 * 用户定稿（2026-09-27，原话"按这个做"）：
 *   ① 掉档：要掉的部件先抖一下，然后翻滚着掉到塔脚、落地弹一下扬起一小团灰尘，停下后留作碎石（约 0.8 秒）；
 *   ② 被摧毁：水晶闪白后炸开成碎片，还在的部件向外飞散并翻滚，伴随一圈冲击波和烟尘，然后碎石堆出现（约 1.5 秒）；
 *   ③ 召唤水晶重生：碎石堆里的部件倒放着飞回原位拼好，最后水晶从中间升起、亮起来（约 1.5 秒）。
 *
 * 分工：
 *   - observe()：UnitLayer 每帧对每座建筑调用一次，比较上一帧的状态（损毁档 / 死 / 活）认出事件，
 *     并告诉 UnitLayer 这一帧塔身该怎么画（mode）：
 *       noRubbleFrom  掉档动画中：新掉的部件还在半空，塔身先不画它们的碎块（towerMesh 按它出几何）
 *       assemble      重生拼装中：塔身只画主体，部件由动画飞回来
 *       offsetY / scaleY / crystalK  塔身下沉/升起、废墟长出来、水晶长出来
 *   - realize()：拿到这一帧的外观（vis.build）后，给新事件建动画用的网格（部件就是模型上那块，
 *     落点就是模型给的碎块位置，所以动画落地那一刻与静态碎石逐位重合）。
 *   - update()：墙钟推进所有动画，播完的收掉。
 * 时间与幅度在 CONFIG.ui.buildingFx。部件的几何取 buildingPiecesOf（与 towerMesh 同一份缓存）。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { displayTowerDamageStage } from '../core/reviveState.js';
import { buildingPiecesOf, mergeParts, unitMaterial } from './UnitMeshFactory.js';
import { hash01, partsBox } from './towerStatue.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (t, a, b) => clamp01((t - a) / Math.max(1e-6, b - a));
const easeIn = (x) => x * x;
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const smooth = (x) => x * x * (3 - 2 * x);
const cfg = () => CONFIG.ui?.buildingFx || {};

/**
 * 掉落中的部件在 t（0..1，整段掉档动画）时刻的变换（模型坐标，左乘到部件零件上）。
 * 抖 → 掉（下落加速、翻滚）→ 落地弹一下。t = 1 时正好等于 rubbleMatrix。
 */
export function fallPose(rp, t, R, seed = 0) {
  const C = cfg().chunkFall || {};
  const shakeEnd = C.shake ?? 0.18, fallEnd = C.fallEnd ?? 0.8;
  const m = new THREE.Matrix4();
  if (t < shakeEnd) {                                   // 抖：原位小幅高频晃动
    const a = (C.shakeAmp ?? 0.03) * R * Math.sin(t * 90 + seed) * (1 - t / shakeEnd * 0.3);
    return m.makeTranslation(a, 0, a * 0.6);
  }
  const u = seg(t, shakeEnd, fallEnd);                   // 掉：水平匀速、竖直加速，边掉边转
  const q = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), rp.q, easeOut(u));
  const s = 1 + (rp.s - 1) * u;
  const pos = new THREE.Vector3().lerpVectors(rp.c, rp.dest, u);
  pos.y = rp.c.y + (rp.dest.y - rp.c.y) * easeIn(u) + (C.hop ?? 0.12) * R * Math.sin(Math.PI * Math.min(1, u * 2)) * (1 - u);
  if (t > fallEnd) {                                     // 落地弹一下
    const b = seg(t, fallEnd, 1);
    pos.y = rp.dest.y + (C.bounce ?? 0.08) * R * Math.sin(Math.PI * b) * (1 - b);
  }
  return m.compose(pos, q, new THREE.Vector3(s, s, s)).multiply(new THREE.Matrix4().makeTranslation(-rp.c.x, -rp.c.y, -rp.c.z));
}

/** 这一帧该怎么画（纯函数，便于测试）。events: 这座建筑正在播的动画 [{type, t, dur, from}] */
export function modeOf(events) {
  const mode = { noRubbleFrom: null, assemble: false, offsetY: 0, scaleY: 1, crystalK: 1 };
  for (const ev of events) {
    const x = ev.t / ev.dur;
    if (ev.type === 'chunk' && x < 1) mode.noRubbleFrom = mode.noRubbleFrom == null ? ev.from : Math.min(mode.noRubbleFrom, ev.from);
    if (ev.type === 'explode') {
      const [a, b] = cfg().explode?.rubbleRise || [0.35, 0.85];
      mode.offsetY = -(1 - smooth(seg(x, a, b)));             // 废墟从地里拱出来（× 塔身高度，由调用方乘）
    }
    if (ev.type === 'respawn') {
      const E = cfg().respawn || {};
      const [a, b] = E.baseRise || [0, 0.45];
      const [c, d] = E.crystal || [0.75, 1.0];
      mode.assemble = x < (E.fly?.[1] ?? 0.8);
      mode.offsetY = -(1 - easeOut(seg(x, a, b)));           // × 塔身高度，由调用方乘
      mode.crystalK = easeOut(seg(x, c, d));
    }
  }
  return mode;
}

export class BuildingFx {
  constructor(scene) {
    this.scene = scene;
    this.byId = new Map();     // id → { stage, dead, events: [] }
    this.anims = [];           // 正在播的网格动画
    this._last = performance.now();
  }

  enabledFor(e) {
    const t = e._mapTier;
    const kind = t === 'nexus_main' ? 'gem' : t === 'nexus_lane' ? 'orb' : 'tower';
    return kind === 'tower' ? CONFIG.ui?.statueTower?.style === 'statue' : CONFIG.ui?.crystalShrine?.style === 'statue';
  }

  /** 认出事件、返回这一帧塔身的画法。ghost / ruin 与 UnitLayer._syncOne 的同名参数一致。 */
  observe(e, ghost, ruin) {
    if (cfg().enabled === false || !this.enabledFor(e)) return null;
    const dead = !!(ghost || ruin || !e.alive);
    const stage = dead ? -1 : displayTowerDamageStage(e, (e.currentHP || 0) / (e.baseStats?.maxHP || 1));
    let st = this.byId.get(e.id);
    if (!st) { st = { stage, dead, events: [], pending: [] }; this.byId.set(e.id, st); return modeOf(st.events); }
    const C = cfg();
    if (!st.dead && dead) this._push(st, { type: 'explode', dur: C.explode?.dur ?? 1.5, fromStage: st.stage });
    else if (st.dead && !dead) {
      // 重生时如果爆炸还没播完（重生时间被改得很短、或者卡顿），先把爆炸收掉，不能两段叠着播
      st.events = st.events.filter((ev) => ev.type !== 'explode');
      for (let i = this.anims.length - 1; i >= 0; i--) {
        if (this.anims[i].id === e.id && this.anims[i].ev.type === 'explode') { this._dispose(this.anims[i]); this.anims.splice(i, 1); }
      }
      this._push(st, { type: 'respawn', dur: C.respawn?.dur ?? 1.5 });
    }
    else if (!dead && stage > st.stage) this._push(st, { type: 'chunk', dur: C.chunkFall?.dur ?? 0.8, from: st.stage, to: stage });
    st.stage = stage; st.dead = dead;
    return modeOf(st.events);
  }

  _push(st, ev) { ev.t = 0; st.events.push(ev); st.pending.push(ev); }

  /** 给还没建网格的新事件建网格。info: { build: {kind,R,tier,faction,F}, x, y(地面), z, rotY, topY, color, crystal:{x,y,z,r}|null } */
  realize(e, info) {
    const st = this.byId.get(e.id);
    if (!st || !st.pending.length || !info?.build) return;
    const b = info.build;
    const pb = buildingPiecesOf(b.kind, b.R, b.tier, b.faction, b.F);
    if (!pb) { st.pending.length = 0; return; }
    this._curId = e.id;
    for (const ev of st.pending) {
      if (ev.type === 'chunk') this._spawnChunks(ev, pb, info);
      else if (ev.type === 'explode') this._spawnExplosion(ev, pb, info);
      else if (ev.type === 'respawn') this._spawnRespawn(ev, pb, info);
    }
    st.pending.length = 0;
  }

  // ---------- 网格工具 ----------
  _root(info) {
    const g = new THREE.Group();
    g.position.set(info.x, info.y, info.z);
    g.rotation.y = info.rotY || 0;
    this.scene.add(g);
    return g;
  }
  _pieceMesh(parts) {
    const mesh = new THREE.Mesh(mergeParts(parts, false), unitMaterial(false));
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    return mesh;
  }
  _puffMat(hex, opacity) { return new THREE.MeshLambertMaterial({ color: hex, transparent: true, opacity, depthWrite: false, flatShading: true }); }

  // ---------- ① 掉档 ----------
  _spawnChunks(ev, pb, info) {
    const R = info.build.R;
    const old = new Set(pb.stages[ev.from] || []);
    const ids = pb.stages[ev.to].filter((id) => !old.has(id));
    const root = this._root(info);
    const items = ids.map((id, i) => {
      const mesh = this._pieceMesh(pb.model.pieceParts(id));
      root.add(mesh);
      return { mesh, rp: pb.model.rubbleParams(id), seed: i * 1.7, delay: hash01(i, 71) * (cfg().chunkFall?.stagger ?? 0.12) };
    });
    const dust = [];
    const DUST = cfg().chunkFall?.dust ?? 3;
    for (const it of items) {
      for (let k = 0; k < DUST; k++) {
        const p = new THREE.Mesh(new THREE.IcosahedronGeometry(R * 0.08, 0), this._puffMat(info.dustColor || '#b9ab93', 0));
        p.position.copy(it.rp.dest); p.position.y = R * 0.05;
        p.userData.dir = new THREE.Vector3(Math.cos(k * 2.1 + it.seed), 0.4, Math.sin(k * 2.1 + it.seed));
        root.add(p); dust.push({ p, it });
      }
    }
    this.anims.push({ id: this._curId, ev, root, update: (x) => {
      const land = cfg().chunkFall?.fallEnd ?? 0.8;
      for (const it of items) {
        const t = clamp01((x - it.delay) / (1 - it.delay));
        it.mesh.matrix.copy(fallPose(it.rp, t, R, it.seed));
        it.t = t;
      }
      for (const d of dust) {   // 落地那一刻扬起的一小团灰
        const u = seg(d.it.t, land, 1);
        d.p.visible = u > 0 && u < 1;
        d.p.material.opacity = 0.55 * (1 - u);
        const s = 0.6 + u * 1.6;
        d.p.scale.set(s, s, s);
        d.p.position.set(d.it.rp.dest.x + d.p.userData.dir.x * u * R * 0.3, R * 0.05 + u * R * 0.12, d.it.rp.dest.z + d.p.userData.dir.z * u * R * 0.3);
      }
    } });
  }

  // ---------- ② 被摧毁 ----------
  _spawnExplosion(ev, pb, info) {
    const E = cfg().explode || {};
    const R = info.build.R;
    const root = this._root(info);
    const gone = new Set(pb.stages[Math.max(0, ev.fromStage ?? 0)] || []);
    const [ra, rb] = E.rubbleRise || [0.35, 0.85];
    // 还在的部件：向外飞散、翻滚、落地停住，最后缩没（碎石堆接手）
    const flying = pb.model.order.filter((id) => !gone.has(id)).map((id, i) => {
      const mesh = this._pieceMesh(pb.model.pieceParts(id));
      root.add(mesh);
      const c0 = new THREE.Vector3(); partsBox(pb.model.pieceParts(id)).getCenter(c0);
      const dir = new THREE.Vector3(c0.x, 0, c0.z);
      if (dir.lengthSq() < 1e-6) dir.set(Math.cos(i * 2.4), 0, Math.sin(i * 2.4));
      dir.normalize();
      const sp = R * (E.speed ?? 2.4) * (0.6 + hash01(i, 81) * 0.8);
      return { mesh, c0, c: c0.clone(), rot: new THREE.Euler(),
               v: new THREE.Vector3(dir.x * sp, R * (E.up ?? 2.2) * (0.5 + hash01(i, 82)), dir.z * sp),
               spin: new THREE.Vector3(hash01(i, 83) - 0.5, hash01(i, 84) - 0.5, hash01(i, 85) - 0.5).multiplyScalar(E.spin ?? 9) };
    });
    // 主体：石台留在原地；石台以上（立柱 + 雕像身体）整截朝一个方向倒下、陷进地里
    const low = R * (E.plinthBelow ?? 0.5);
    const plinth = this._pieceMesh(pb.model.base.filter((p) => partsBox([p]).max.y <= low));
    const upper = pb.model.base.filter((p) => partsBox([p]).max.y > low);
    const body = upper.length ? this._pieceMesh(upper) : null;
    root.add(plinth); plinth.matrix.identity();
    if (body) root.add(body);
    const H = info.topY || R * 3;
    const tipA = hash01(Math.round(info.x), Math.round(info.z)) * Math.PI * 2;
    const tipAxis = new THREE.Vector3(Math.cos(tipA + Math.PI / 2), 0, Math.sin(tipA + Math.PI / 2));
    // 闪白 + 水晶碎片（从水晶所在位置炸开）
    const cp = info.crystal ? new THREE.Vector3(info.crystal.lx, info.crystal.ly, info.crystal.lz) : new THREE.Vector3(0, H * 0.8, 0);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    flash.position.copy(cp); root.add(flash);
    const shards = [];
    const nS = E.shards ?? 10, cr = info.crystal?.r || R * 0.3;
    for (let i = 0; i < nS; i++) {
      const sh = new THREE.Mesh(new THREE.OctahedronGeometry(cr * 0.28, 0), new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 1 }));
      const a = i / nS * Math.PI * 2, el = (hash01(i, 91) - 0.3) * 1.2;
      sh.userData.v = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el) + 0.4, Math.sin(a) * Math.cos(el)).multiplyScalar(R * (E.shardSpeed ?? 3.2));
      sh.position.copy(cp); root.add(sh); shards.push(sh);
    }
    // 冲击波：地面上一圈往外扩的光环 + 一圈更慢的尘浪 + 一层向外膨胀的半球冲击波壳
    // 用户："爆炸的时候塔应该产生可视化冲击波"。壳只有边缘亮（视线掠过的地方），中间透明，
    // 普通混合 + 不透明度封顶，不会像护盾受击那次一样晃眼。
    const SW = E.shock || {};
    const ring = new THREE.Mesh(new THREE.RingGeometry(SW.ringInner ?? 0.55, 1, 48), new THREE.MeshBasicMaterial({ color: E.ringColor || '#fff2d6', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.6; root.add(ring);
    const dustRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48), new THREE.MeshBasicMaterial({ color: SW.dustColor || '#b9ab93', transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    dustRing.rotation.x = -Math.PI / 2; dustRing.position.y = 0.4; root.add(dustRing);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(SW.color || '#fff4dc') }, uAlpha: { value: 0 }, uRim: { value: SW.rim ?? 2.2 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; uniform float uRim; varying vec3 vN; varying vec3 vV; void main(){ float r = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uRim); gl_FragColor = vec4(uColor, r * uAlpha); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    dome.layers.set(FX_PARTICLE_LAYER); root.add(dome);
    // 烟尘：一圈灰团往外、往上扩散后淡掉
    const puffs = [];
    const nP = E.smoke ?? 9;
    for (let i = 0; i < nP; i++) {
      const pf = new THREE.Mesh(new THREE.IcosahedronGeometry(R * 0.3, 0), this._puffMat(E.smokeColor || '#8d8579', 0));
      const a = i / nP * Math.PI * 2 + hash01(i, 95);
      pf.userData.d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      pf.userData.k = 0.6 + hash01(i, 96) * 0.8;
      root.add(pf); puffs.push(pf);
    }
    const g = R * (E.gravity ?? 9);
    const one = new THREE.Vector3(1, 1, 1), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let last = 0;
    this.anims.push({ id: this._curId, ev, root, update: (x) => {
      const dt = (x - last) * ev.dur; last = x;
      for (const f of flying) {
        if (!f.landed) {
          f.v.y -= g * dt;
          f.c.addScaledVector(f.v, dt);
          if (f.c.y < R * 0.1) { f.c.y = R * 0.1; f.landed = true; }
          f.rot.x += f.spin.x * dt; f.rot.y += f.spin.y * dt; f.rot.z += f.spin.z * dt;
        }
        const k = Math.max(0.001, 1 - smooth(seg(x, rb - 0.1, 1)));
        f.mesh.matrix.compose(f.c, q.setFromEuler(f.rot), sc.copy(one).multiplyScalar(k))
          .multiply(new THREE.Matrix4().makeTranslation(-f.c0.x, -f.c0.y, -f.c0.z));
      }
      if (body) {
        const [ta, tb] = E.topple || [0.08, 0.7];
        body.matrix.makeTranslation(0, -H * smooth(seg(x, 0.3, 0.9)), 0)
          .multiply(new THREE.Matrix4().makeRotationAxis(tipAxis, easeIn(seg(x, ta, tb)) * 1.35));
        body.visible = x < 0.9;
      }
      plinth.visible = x < rb;   // 碎石堆（含开裂的石台）升到位之后换它接手
      const fu = seg(x, 0, E.flash ?? 0.22);
      flash.material.opacity = Math.sin(Math.PI * fu);
      const fs = cr * (1 + fu * 5);
      flash.scale.set(fs, fs, fs);
      for (const sh of shards) {
        sh.userData.v.y -= g * 0.6 * dt;
        sh.position.addScaledVector(sh.userData.v, dt);
        sh.rotation.x += dt * 8; sh.rotation.y += dt * 6;
        sh.material.opacity = 1 - seg(x, 0.3, 0.75);
        sh.visible = sh.material.opacity > 0.01;
      }
      const ru = seg(x, 0.03, E.ring ?? 0.45);
      const rr = R * (E.ringR ?? 2.6) * easeOut(ru) + 0.1;
      ring.scale.set(rr, rr, rr);
      ring.material.opacity = (1 - ru) * 0.9;
      ring.visible = ru < 1;
      const [da, db] = SW.dome || [0.02, 0.5];
      const du = seg(x, da, db);
      const dr = R * (SW.domeR ?? 2.4) * easeOut(du) + 0.1;
      dome.scale.set(dr, dr * (SW.domeFlat ?? 0.7), dr);
      dome.material.uniforms.uAlpha.value = (SW.alpha ?? 0.75) * (1 - du) * Math.min(1, du * 6);
      dome.visible = du > 0 && du < 1;
      const [ea, eb] = SW.dust || [0.08, 0.8];
      const eu = seg(x, ea, eb);
      const er = R * (SW.dustR ?? 3.3) * easeOut(eu) + 0.1;
      dustRing.scale.set(er, er, er);
      dustRing.material.opacity = 0.55 * (1 - eu) * Math.min(1, eu * 5);
      dustRing.visible = eu > 0 && eu < 1;
      for (const pf of puffs) {
        const pu = seg(x, 0.05, 1);
        const s2 = (0.4 + easeOut(pu) * 1.4) * pf.userData.k;
        pf.scale.set(s2, s2, s2);
        pf.position.set(pf.userData.d.x * R * (0.4 + pu * 1.1), R * (0.2 + pu * 0.9) * pf.userData.k, pf.userData.d.z * R * (0.4 + pu * 1.1));
        pf.material.opacity = 0.7 * Math.sin(Math.PI * Math.min(1, pu * 1.1));
      }
    } });
  }

  // ---------- ③ 召唤水晶重生 ----------
  _spawnRespawn(ev, pb, info) {
    const E = cfg().respawn || {};
    const R = info.build.R;
    const root = this._root(info);
    // 碎石堆：沉下去
    const pile = this._pieceMesh(pb.ruin);
    root.add(pile);
    // 部件：从各自的碎块位置倒着飞回原位（掉档动画倒放）
    const items = pb.model.order.map((id, i) => {
      const mesh = this._pieceMesh(pb.model.pieceParts(id));
      root.add(mesh);
      return { mesh, rp: pb.model.rubbleParams(id), seed: i * 1.3, delay: hash01(i, 61) * 0.15 };
    });
    const [f0, f1] = E.fly || [0.1, 0.8];
    const [s0, s1] = E.pileSink || [0, 0.5];
    this.anims.push({ id: this._curId, ev, root, update: (x) => {
      const k = 1 - smooth(seg(x, s0, s1));
      pile.matrix.makeScale(1, Math.max(0.001, k), 1);
      pile.visible = k > 0.001;
      for (const it of items) {
        const t = seg(x, f0 + it.delay * (f1 - f0), f1);
        // 倒放掉落轨迹：t=0 在地上的碎块位置，t=1 回到原位（跳过"抖"那一段）
        const shakeEnd = cfg().chunkFall?.shake ?? 0.18;
        it.mesh.matrix.copy(fallPose(it.rp, shakeEnd + (1 - t) * (1 - shakeEnd), R, it.seed));
        it.mesh.visible = x < (E.fly?.[1] ?? 0.8) + 0.02;
      }
    } });
  }

  /** 墙钟推进；播完的收掉 */
  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    for (const st of this.byId.values()) {
      for (const ev of st.events) ev.t += dt;
      st.events = st.events.filter((ev) => ev.t < ev.dur);
    }
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      const x = Math.min(1, a.ev.t / a.ev.dur);
      if (a.ev.t >= a.ev.dur) { this._dispose(a); this.anims.splice(i, 1); continue; }
      a.update(x);
    }
  }

  _dispose(a) {
    this.scene.remove(a.root);
    a.root.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose?.();
        if (o.material && o.material !== unitMaterial(false)) o.material.dispose();
      }
    });
  }

  clear() {
    for (const a of this.anims) this._dispose(a);
    this.anims = [];
    this.byId.clear();
  }

  forget(id) { this.byId.delete(id); }
}
