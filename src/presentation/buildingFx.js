/**
 * buildingFx.js —— 防御塔 / 召唤水晶 / 水晶枢纽的三段动画。
 *
 * 用户定稿（2026-09-27，原话"按这个做"）：
 *   ① 掉档：要掉的部件先抖一下，然后翻滚着掉到塔脚、落地弹一下扬起一小团灰尘（约 0.8 秒），在地上停 2 秒后沉进地里消失
 *      （用户："为了看起来不那么杂乱，塔损毁的掉在地上的块部分不再常驻显示，而是2秒后消失"）；
 *   ② 被摧毁：水晶闪白后炸开成碎片，还在的部件向外飞散并翻滚，伴随一圈冲击波和烟尘，然后碎石堆出现（约 1.5 秒）；
 *      用户后来嫌它"太单调了，看不出来是塔/水晶爆炸的效果"，所以水晶炸开那一下另有：放射光芒、冲天光柱、阵营色能量球、
 *      一把火花、更多更亮的晶片；之后废墟中间升起一柱黑烟，持续几秒。枢纽炸得更大一档；
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
import { buildingPiecesOf, buildingStyleOf, mergeParts, unitMaterial, makeUnitMaterial, currentUnitTint, dotTexture } from './UnitMeshFactory.js';
import { hash01, partsBox } from './towerStatue.js';
import { gem } from './modelKit.js';
import { FX_PARTICLE_LAYER } from './PostFX.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

let _smokeTex = null;
/** 柔边云团贴图：几个大小不一的柔光圆叠成一团不规则的烟（无头环境返回 null）。 */
function smokeTexture() {
  if (_smokeTex) return _smokeTex;
  if (typeof document === 'undefined') return null;
  const N = 96, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4, r0 = i === 0 ? 0 : N * (0.1 + hash01(i, 7) * 0.14), x = N / 2 + Math.cos(a) * r0, y = N / 2 + Math.sin(a) * r0, r = N * (0.2 + hash01(i, 9) * 0.12);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.5)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.22)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, N, N);
  }
  _smokeTex = new THREE.CanvasTexture(c); _smokeTex.colorSpace = THREE.SRGBColorSpace;
  return _smokeTex;
}
let _shardGeo = null;
/** 水晶碎片：细长的小晶柱（单位大小，共享；用的时候按 r 缩放）。 */
function shardGeo(r) { if (!_shardGeo) { _shardGeo = gem(1, 4, 1.6, 0.4, 1.1); _shardGeo.userData.shared = true; } const g = _shardGeo.clone(); g.scale(r, r, r); return g; }
const seg = (t, a, b) => clamp01((t - a) / Math.max(1e-6, b - a));
const easeIn = (x) => x * x;
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const smooth = (x) => x * x * (3 - 2 * x);
const cfg = () => CONFIG.ui?.buildingFx || {};
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

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

/**
 * 倒塌中的部件在 u（0..1，这块自己的进度）时刻的变换（模型坐标，左乘到部件零件上）。
 * 先被震得一抖，再被掀起来一点、翻滚着落向它在废墟里的位置，落地弹一下。
 * u = 0 时是原位（单位矩阵），u = 1 时正好等于 PieceModel.ruinMatrix —— 所以落定那一刻换成静态废墟网格不会跳。
 * @param rp   PieceModel.ruinParams(id)
 * @param seed 每块不同的数（决定翻滚轴、被掀起多高）
 */
export function collapsePose(rp, u, R, seed = 0) {
  const C = cfg().collapse || {};
  const shakeEnd = C.shake ?? 0.1, fallEnd = C.fallEnd ?? 0.86;
  const m = new THREE.Matrix4();
  if (u <= 0) return m;
  if (u < shakeEnd) {
    const a = (C.shakeAmp ?? 0.035) * R * Math.sin(u * 140 + seed * 3.1);
    return m.makeTranslation(a, 0, a * 0.7);
  }
  const f = seg(u, shakeEnd, fallEnd);
  const h1 = hash01(Math.round(seed * 97), 301), h2 = hash01(Math.round(seed * 97), 302), h3 = hash01(Math.round(seed * 97), 303);
  const pos = new THREE.Vector3().lerpVectors(rp.c, rp.dest, easeOut(f) * 0.35 + f * 0.65);
  const drop = Math.max(0, rp.c.y - rp.dest.y);
  // 竖直：自由落体（f²）+ 爆炸掀起的一下（越高的部件掀得越高）
  pos.y = rp.c.y + (rp.dest.y - rp.c.y) * f * f + (C.pop ?? 0.5) * R * (0.25 + 0.75 * h1) * Math.min(1, drop / (R * 1.2)) * Math.sin(Math.PI * Math.min(1, f * 1.6)) * (1 - f);
  // 朝向：转到落地姿态，途中多翻几圈（两头都是 0，所以起止姿态不受影响）
  const q = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), rp.q, smooth(f));
  const axis = new THREE.Vector3(h2 - 0.5, (h3 - 0.5) * 0.4, h1 - 0.5).normalize();
  q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, (C.tumble ?? 5) * (0.5 + h2) * f * (1 - f) * (1 - f) * 2.5));
  const s = 1 + (rp.s - 1) * f;
  if (u > fallEnd) {
    const b = seg(u, fallEnd, 1);
    pos.y = rp.dest.y + (C.bounce ?? 0.05) * R * Math.sin(Math.PI * b) * (1 - b);
  }
  return m.compose(pos, q, new THREE.Vector3(s, s, s)).multiply(new THREE.Matrix4().makeTranslation(-rp.c.x, -rp.c.y, -rp.c.z));
}

/** 这一帧该怎么画（纯函数，便于测试）。events: 这座建筑正在播的动画 [{type, t, dur, from}] */
export function modeOf(events, continuous = false) {
  const mode = { noRubbleFrom: null, assemble: false, offsetY: 0, scaleY: 1, crystalK: 1, hidden: false };
  for (const ev of events) {
    const x = ev.t / ev.dur;
    if (ev.type === 'chunk' && x < 1) mode.noRubbleFrom = mode.noRubbleFrom == null ? ev.from : Math.min(mode.noRubbleFrom, ev.from);
    // 连贯倒塌（写实造型）：废墟就是塌下来的部件本身——动画播完之前静态的废墟网格不画，由动画里的部件接力；
    // 重生时基座原地不动，部件从废墟里飞回原位，最后水晶长出来。没有"从地里升起 / 沉下去"这回事。
    if (continuous && ev.type === 'explode') { mode.hidden = x < 1; continue; }
    if (continuous && ev.type === 'respawn') {
      const E = cfg().respawn || {};
      const [c, d] = E.crystal || [0.75, 1.0];
      mode.assemble = x < (E.fly?.[1] ?? 0.8);
      mode.crystalK = easeOut(seg(x, c, d));
      continue;
    }
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
    const st = buildingStyleOf(kind);
    return st === 'statue' || st === 'citadel';
  }

  /** 认出事件、返回这一帧塔身的画法。ghost / ruin 与 UnitLayer._syncOne 的同名参数一致。 */
  observe(e, ghost, ruin) {
    if (cfg().enabled === false || !this.enabledFor(e)) return null;
    const dead = !!(ghost || ruin || !e.alive);
    const stage = dead ? -1 : displayTowerDamageStage(e, (e.currentHP || 0) / (e.baseStats?.maxHP || 1));
    let st = this.byId.get(e.id);
    const t = e._mapTier;
    const cont = buildingStyleOf(t === 'nexus_main' ? 'gem' : t === 'nexus_lane' ? 'orb' : 'tower') === 'citadel';
    if (!st) { st = { stage, dead, events: [], pending: [], cont }; this.byId.set(e.id, st); return modeOf(st.events, cont); }
    st.cont = cont;
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
    else if (!dead && stage > st.stage) {
      // 事件时长 = 掉落 + 在地上停留 + 沉没消失；掉落本身的时长另记在 fall 上
      const CF = C.chunkFall || {}, fall = CF.dur ?? 0.8;
      this._push(st, { type: 'chunk', dur: fall + (CF.linger ?? 2) + (CF.fade ?? 0.5), fall, from: st.stage, to: stage });
    }
    st.stage = stage; st.dead = dead;
    return modeOf(st.events, cont);
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
      else if (ev.type === 'explode') (pb.continuous ? this._spawnCollapse(ev, pb, info) : this._spawnExplosion(ev, pb, info));
      else if (ev.type === 'respawn') (pb.continuous ? this._spawnReassemble(ev, pb, info) : this._spawnRespawn(ev, pb, info));
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
  /**
   * 部件网格。同一座塔的同一块部件几何只合并一次（缓存在 pieces 对象上），动画结束不释放——
   * 事件发生那一刻临时合并几十块部件是损毁 / 爆炸时卡一下的来源之一，UnitLayer 在空闲帧里预先合并好。
   */
  _pieceGeo(pb, id) {
    const c = pb._geoCache || (pb._geoCache = new Map());
    let g = c.get(id);
    if (!g) {
      const parts = id === '__ruin' ? pb.ruin : id === '__mound' ? pb.ruinKit.mound : id === '__stump' ? pb.ruinKit.stump : pb.model.pieceParts(id);
      g = mergeParts(parts, false); g.userData.shared = true; c.set(id, g);
    }
    return g;
  }
  /** 主体按高度切成"石台"与"石台以上"两截（爆炸时石台留下、上半截倒下），两截几何同样缓存 */
  _baseSplit(pb, low) {
    const key = '__split' + low.toFixed(3);
    const c = pb._geoCache || (pb._geoCache = new Map());
    if (!c.has(key)) {
      const lo = pb.model.base.filter((p) => partsBox([p]).max.y <= low), hi = pb.model.base.filter((p) => partsBox([p]).max.y > low);
      const g1 = mergeParts(lo, false); g1.userData.shared = true; c.set(key + 'lo', g1);
      if (hi.length) { const g2 = mergeParts(hi, false); g2.userData.shared = true; c.set(key + 'hi', g2); }
      c.set(key, true);
    }
    return { plinth: key + 'lo', upper: c.has(key + 'hi') ? key + 'hi' : null };
  }
  /** 预先合并一座建筑的所有部件几何（空闲帧里调用） */
  warmPieces(pb, R) {
    for (const id of pb.model.order) this._pieceGeo(pb, id);
    if (pb.ruin) this._pieceGeo(pb, '__ruin');
    if (pb.ruinKit) { this._pieceGeo(pb, '__mound'); if (pb.ruinKit.stump.length) this._pieceGeo(pb, '__stump'); }
    if (R) this._baseSplit(pb, R * (cfg().explode?.plinthBelow ?? 0.5));
  }
  _pieceMesh(parts, pb = null, id = null) {
    const mesh = new THREE.Mesh(pb ? this._pieceGeo(pb, id) : mergeParts(parts, false), unitMaterial(false));
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    return mesh;
  }
  // ---------- 特效材质：播放与预热走同一组工厂，参数一致，预热编译好的着色器程序才能被复用 ----------
  // 烟尘：朝向镜头的柔边云团贴图（原来是半透明的多面体，近看就是一颗颗灰色的塑料球）
  _puffMat(hex, opacity) {
    const c = new THREE.Color(hex), t = currentUnitTint();
    if (t) c.multiply(new THREE.Color(t));          // 精灵不受光：按当前昼夜色调压一下，夜里不发白
    return new THREE.SpriteMaterial({ map: smokeTexture(), color: c, transparent: true, opacity, depthWrite: false });
  }
  /** 一团烟：size = 这团烟的基准半径（世界单位）。之后用 _puffScale 设大小。 */
  _puff(size, hex) {
    const sp = new THREE.Sprite(this._puffMat(hex, 0));
    sp.userData.size = size * 2.6; sp.layers.set(FX_PARTICLE_LAYER);
    sp.material.rotation = hash01(Math.round(size * 977), this.anims.length + 3) * 6.28;
    return sp;
  }
  _puffScale(sp, s, sy = s) { sp.scale.set(s * sp.userData.size, sy * sp.userData.size, 1); }
  _shardMat(hex) { return new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 1 }); }
  _ringMat(hex) { return new THREE.MeshBasicMaterial({ color: hex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }); }
  _dustRingMat(hex) { return new THREE.MeshBasicMaterial({ color: hex, transparent: true, depthWrite: false, side: THREE.DoubleSide }); }
  // 闪白必须带圆形柔光贴图：没贴图的精灵就是一整块正方形（用户："顶部中间会有一个大白方块"）
  _flashMat() { return new THREE.SpriteMaterial({ map: dotTexture(), color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }); }
  /** 加色混合的光：放射光芒、能量球外壳用 */
  _rayMat(hex) { return new THREE.SpriteMaterial({ map: dotTexture(), color: hex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }); }
  /** 冲天光柱：圆柱侧面，越往上越淡，加色混合 */
  _pillarMat(hex) {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(hex) }, uAlpha: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv; void main(){ float k = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.08, vUv.y); gl_FragColor = vec4(uColor * k * uAlpha, 1.0); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
  }
  /** 能量球：只有边缘亮的球壳，加色混合 */
  _orbMat(hex) {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(hex) }, uAlpha: { value: 0 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vV; void main(){ float r = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.8); gl_FragColor = vec4(uColor * (0.25 + 0.75 * r) * uAlpha, 1.0); }',
      transparent: true, depthWrite: false, side: THREE.FrontSide, blending: THREE.AdditiveBlending,
    });
  }
  _sparkMat(hex, size) { return new THREE.PointsMaterial({ map: dotTexture(), color: hex, size, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 }); }
  _domeMat(SW) {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(SW.color || '#fff4dc') }, uAlpha: { value: 0 }, uRim: { value: SW.rim ?? 2.2 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; uniform float uRim; varying vec3 vN; varying vec3 vV; void main(){ float r = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), uRim); gl_FragColor = vec4(uColor, r * uAlpha); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /**
   * 预热：把掉块 / 爆炸 / 重生用到的每种特效材质先编译一遍（地图加载时调一次）。
   * 用户："塔播放损毁动画的时候，游戏会突然卡一下"——这些材质都是事件那一刻才第一次出现，
   * 着色器首次编译链接在真实显卡上要几十到几百毫秒，就卡在那一帧。
   */
  prewarm(renderer, camera) {
    if (!renderer?.compile) return;
    // 材质/网格只建一次；场景状态（雾、后处理、阴影）变了由渲染器再调一次，只重新编译
    if (!this._warmKeep) {
      const g = new THREE.Group(), geo = new THREE.BoxGeometry(1, 1, 1);
      const SW = cfg().explode?.shock || {};
      const mats = [this._shardMat('#88aaff'), this._ringMat('#ffffff'), this._dustRingMat('#b9ab93'), this._domeMat(SW), this._pillarMat('#88aaff'), this._orbMat('#88aaff'), unitMaterial(false)];
      for (const m of mats) {
        const mesh = new THREE.Mesh(geo, m);
        if (m === mats[mats.length - 1]) { mesh.castShadow = true; mesh.receiveShadow = true; }   // 同碎块（_pieceMesh）
        g.add(mesh);
      }
      const sp = new THREE.Sprite(this._flashMat()); sp.layers.set(FX_PARTICLE_LAYER); g.add(sp);
      const sp2 = new THREE.Sprite(this._puffMat('#888888', 0.5)); sp2.layers.set(FX_PARTICLE_LAYER); g.add(sp2);
      const sp3 = new THREE.Sprite(this._rayMat('#88aaff')); sp3.layers.set(FX_PARTICLE_LAYER); g.add(sp3);
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const pts = new THREE.Points(pg, this._sparkMat('#88aaff', 2)); pts.layers.set(FX_PARTICLE_LAYER); g.add(pts);
      g.position.set(0, -9999, 0);
      // 材质不释放：three 按引用计数回收着色器程序，释放了预热就白做了（留着的只有七个小对象）
      this._warmKeep = { g, geo, mats, sp };
    }
    const g = this._warmKeep.g;
    this.scene.add(g);
    // 着色器程序的签名里带着"画到哪"：直接上屏是 sRGB 输出 + 色调映射，后处理管线是先画进离屏缓冲
    //（线性输出、不做色调映射）。原来只在上屏状态下编译了一遍，开着后处理时真正播放用的是另一份，
    // 预热等于白做，摧毁那一刻照样现编译六个程序（实测）。两种目标各编译一遍。
    try {
      renderer.compile(this.scene, camera);
      const prevRT = renderer.getRenderTarget();
      const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
      renderer.setRenderTarget(rt);
      renderer.compile(this.scene, camera);
      renderer.setRenderTarget(prevRT);
      rt.dispose();
    } catch (e) { /* 预热失败不影响游戏，照常在首次播放时编译 */ }
    this.scene.remove(g);
  }

  // ---------- ① 掉档 ----------
  _spawnChunks(ev, pb, info) {
    const R = info.build.R;
    const old = new Set(pb.stages[ev.from] || []);
    const ids = pb.stages[ev.to].filter((id) => !old.has(id));
    const root = this._root(info);
    const items = ids.map((id, i) => {
      const mesh = this._pieceMesh(null, pb, id);
      root.add(mesh);
      return { mesh, rp: pb.model.rubbleParams(id), seed: i * 1.7, delay: hash01(i, 71) * (cfg().chunkFall?.stagger ?? 0.12) };
    });
    const dust = [];
    const DUST = cfg().chunkFall?.dust ?? 3;
    for (const it of items) {
      for (let k = 0; k < DUST; k++) {
        const p = this._puff(R * 0.08, info.dustColor || '#b9ab93');
        p.position.copy(it.rp.dest); p.position.y = R * 0.05;
        p.userData.dir = new THREE.Vector3(Math.cos(k * 2.1 + it.seed), 0.4, Math.sin(k * 2.1 + it.seed));
        root.add(p); dust.push({ p, it });
      }
    }
    const CF = cfg().chunkFall || {};
    const fall = ev.fall ?? ev.dur, linger = CF.linger ?? 2, fade = CF.fade ?? 0.5;
    this.anims.push({ id: this._curId, ev, root, update: (x) => {
      const land = CF.fallEnd ?? 0.8;
      const sec = x * ev.dur, xf = Math.min(1, sec / fall);
      // 落地停 linger 秒后，碎块一边缩小一边沉进地里（不是凭空消失）
      const f = smooth(seg(sec, fall + linger, fall + linger + fade));
      for (const it of items) {
        const t = clamp01((xf - it.delay) / (1 - it.delay));
        it.mesh.matrix.copy(fallPose(it.rp, t, R, it.seed));
        if (f > 0) {
          const k = Math.max(0.001, 1 - f), d = it.rp.dest;
          it.mesh.matrix.premultiply(_m1.makeTranslation(-d.x, -d.y, -d.z)).premultiply(_m2.makeScale(k, k, k)).premultiply(_m1.makeTranslation(d.x, d.y - f * R * 0.08, d.z));
        }
        it.mesh.visible = f < 0.999;
        it.t = t;
      }
      for (const d of dust) {   // 落地那一刻扬起的一小团灰
        const u = seg(d.it.t, land, 1);
        d.p.visible = u > 0 && u < 1;
        d.p.material.opacity = 0.55 * (1 - u);
        const s = 0.6 + u * 1.6;
        this._puffScale(d.p, s);
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
      const mesh = this._pieceMesh(null, pb, id);
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
    const split = this._baseSplit(pb, low);
    const plinth = this._pieceMesh(null, pb, split.plinth);
    const body = split.upper ? this._pieceMesh(null, pb, split.upper) : null;
    root.add(plinth); plinth.matrix.identity();
    if (body) root.add(body);
    const H = info.topY || R * 3;
    const tipA = hash01(Math.round(info.x), Math.round(info.z)) * Math.PI * 2;
    const tipAxis = new THREE.Vector3(Math.cos(tipA + Math.PI / 2), 0, Math.sin(tipA + Math.PI / 2));
    const blast = this._blastFx(root, info, R, H);
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
      blast(x, dt);
    } });
    this._smokeColumn(info, R);
  }

  /**
   * 爆炸的光与烟：水晶位置闪白 + 水晶碎片四溅、地面一圈光环、半球冲击波壳、尘浪、往上翻的烟团。
   * 返回每帧的更新函数 (x: 0..1 整段进度, dt: 秒)。
   */
  _blastFx(root, info, R, H) {
    const E = cfg().explode || {};
    // 枢纽炸得更大：所有半径 / 数量按 big 放大
    const big = info.build?.kind === 'gem' ? (E.nexusScale ?? 1.35) : 1;
    R = R * big;
    // 闪白 + 水晶碎片（从水晶所在位置炸开）
    const cp = info.crystal ? new THREE.Vector3(info.crystal.lx, info.crystal.ly, info.crystal.lz) : new THREE.Vector3(0, H * 0.8, 0);
    const flash = new THREE.Sprite(this._flashMat());
    flash.layers.set(FX_PARTICLE_LAYER);
    flash.position.copy(cp); root.add(flash);
    const shards = [];
    const nS = Math.round((E.shards ?? 18) * big), cr = info.crystal?.r || R * 0.3;
    const teamHot0 = '#' + new THREE.Color(info.color || '#9cc8ff').lerp(new THREE.Color('#ffffff'), 0.45).getHexString();
    for (let i = 0; i < nS; i++) {
      const sh = new THREE.Mesh(shardGeo(cr * (0.12 + hash01(i, 92) * 0.14) * big), this._shardMat(i % 3 ? info.color : teamHot0));
      const a = i / nS * Math.PI * 2 + hash01(i, 93) * 0.4, el = (hash01(i, 91) - 0.3) * 1.2;
      sh.userData.v = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el) + 0.4, Math.sin(a) * Math.cos(el)).multiplyScalar(R * (E.shardSpeed ?? 3.2));
      sh.position.copy(cp); root.add(sh); shards.push(sh);
    }
    // 冲击波：地面上一圈往外扩的光环 + 一圈更慢的尘浪 + 一层向外膨胀的半球冲击波壳
    // 用户："爆炸的时候塔应该产生可视化冲击波"。壳只有边缘亮（视线掠过的地方），中间透明，
    // 普通混合 + 不透明度封顶，不会像护盾受击那次一样晃眼。
    const SW = E.shock || {};
    const ring = new THREE.Mesh(new THREE.RingGeometry(SW.ringInner ?? 0.55, 1, 48), this._ringMat(E.ringColor || '#fff2d6'));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.6; root.add(ring);
    const dustRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48), this._dustRingMat(SW.dustColor || '#b9ab93'));
    dustRing.rotation.x = -Math.PI / 2; dustRing.position.y = 0.4; root.add(dustRing);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), this._domeMat(SW));
    dome.layers.set(FX_PARTICLE_LAYER); root.add(dome);
    // 烟尘：一圈灰团往外、往上扩散后淡掉
    const puffs = [];
    const nP = E.smoke ?? 9;
    for (let i = 0; i < nP; i++) {
      const pf = this._puff(R * 0.3, E.smokeColor || '#8d8579');
      const a = i / nP * Math.PI * 2 + hash01(i, 95);
      pf.userData.d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      pf.userData.k = 0.6 + hash01(i, 96) * 0.8;
      root.add(pf); puffs.push(pf);
    }
    // ---- 水晶炸开的读点（用户："目前的塔被摧毁/水晶爆炸动画太单调了，看不出来是塔/水晶爆炸的效果"）----
    const team = info.color || '#9cc8ff', teamHot = '#' + new THREE.Color(team).lerp(new THREE.Color('#ffffff'), 0.45).getHexString();
    // ① 引爆那一下：一圈放射光芒（屏幕空间的细长光条，从水晶往外刺出去）
    const RY_ = E.rays || {};
    const rays = [];
    for (let i = 0; i < (RY_.n ?? 9); i++) {
      const sp = new THREE.Sprite(this._rayMat(teamHot)); sp.layers.set(FX_PARTICLE_LAYER);
      sp.material.rotation = i / (RY_.n ?? 9) * Math.PI * 2 + hash01(i, 41) * 0.5;
      sp.userData.len = (0.6 + hash01(i, 42) * 0.8);
      sp.position.copy(cp); root.add(sp); rays.push(sp);
    }
    // ② 冲天光柱：一粗一细两层，从水晶处直冲上去
    const PL = E.pillar || {};
    const pillars = [[PL.r ?? 0.32, team], [(PL.r ?? 0.32) * 0.4, '#ffffff']].map(([r, hex]) => {
      const geo = new THREE.CylinderGeometry(R * r, R * r * 1.4, 1, 20, 1, true); geo.translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(geo, this._pillarMat(hex)); mesh.layers.set(FX_PARTICLE_LAYER); mesh.position.set(cp.x, cp.y - R * 0.3, cp.z); root.add(mesh); return mesh;
    });
    // ③ 能量球：阵营色的球壳从水晶处鼓出去
    const SP = E.sphere || {};
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), this._orbMat(team));
    orb.layers.set(FX_PARTICLE_LAYER); orb.position.copy(cp); root.add(orb);
    // ④ 火花：一把加色的光点，被炸飞后受重力落下、渐暗
    const SK = E.sparks || {};
    const nK = Math.round((SK.n ?? 70) * big), kp = new Float32Array(nK * 3), kv = [];
    for (let i = 0; i < nK; i++) {
      kp[i * 3] = cp.x; kp[i * 3 + 1] = cp.y; kp[i * 3 + 2] = cp.z;
      const a = hash01(i, 43) * Math.PI * 2, el = (hash01(i, 44) - 0.25) * 1.5, sp = R * (SK.speed ?? 4.5) * (0.35 + hash01(i, 45) * 0.9);
      kv.push(new THREE.Vector3(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp + R * 1.2, Math.sin(a) * Math.cos(el) * sp));
    }
    const kg = new THREE.BufferGeometry(); kg.setAttribute('position', new THREE.BufferAttribute(kp, 3));
    const sparks = new THREE.Points(kg, this._sparkMat(teamHot, R * (SK.size ?? 0.09))); sparks.layers.set(FX_PARTICLE_LAYER); sparks.frustumCulled = false; root.add(sparks);
    const g = R * (E.gravity ?? 9);
    return (x, dt) => {
      const ru0 = seg(x, 0, RY_.end ?? 0.2);
      for (const sp of rays) {
        const k = Math.sin(Math.PI * ru0);
        sp.visible = ru0 > 0 && ru0 < 1;
        sp.material.opacity = k * (RY_.alpha ?? 0.9);
        sp.scale.set(R * 0.07, R * (RY_.len ?? 2.6) * sp.userData.len * (0.3 + 0.7 * easeOut(ru0)), 1);
      }
      const [pa, pb_] = PL.span || [0.03, 0.6];
      const pu = seg(x, pa, pb_);
      for (const [i, mesh] of pillars.entries()) {
        mesh.visible = pu > 0 && pu < 1;
        mesh.scale.set(1 + pu * (i ? 0.2 : 0.6), R * (PL.h ?? 6) * easeOut(Math.min(1, pu * 2.2)), 1 + pu * (i ? 0.2 : 0.6));
        mesh.material.uniforms.uAlpha.value = (PL.alpha ?? 1.1) * (1 - smooth(pu)) * Math.min(1, pu * 8);
      }
      const [sa, sb] = SP.span || [0.02, 0.38];
      const su = seg(x, sa, sb);
      const sr = R * (SP.r ?? 1.7) * easeOut(su) + 0.1;
      orb.scale.set(sr, sr, sr);
      orb.visible = su > 0 && su < 1;
      orb.material.uniforms.uAlpha.value = (SP.alpha ?? 0.9) * (1 - su) * Math.min(1, su * 10);
      const ka = sparks.geometry.attributes.position;
      for (let i = 0; i < nK; i++) {
        const v = kv[i];
        v.y -= g * 0.55 * dt; v.multiplyScalar(Math.max(0, 1 - dt * 0.8));
        let y = ka.array[i * 3 + 1] + v.y * dt;
        if (y < R * 0.02) { y = R * 0.02; v.y = Math.abs(v.y) * 0.25; }
        ka.array[i * 3] += v.x * dt; ka.array[i * 3 + 1] = y; ka.array[i * 3 + 2] += v.z * dt;
      }
      ka.needsUpdate = true;
      sparks.material.opacity = 1 - smooth(seg(x, 0.35, 0.95));
      sparks.visible = sparks.material.opacity > 0.01;
      const fu = seg(x, 0, E.flash ?? 0.22);
      flash.material.opacity = Math.sin(Math.PI * fu) * (E.flashAlpha ?? 0.9);
      const fs = cr * (1 + fu * 5) * big;
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
        this._puffScale(pf, s2);
        pf.position.set(pf.userData.d.x * R * (0.4 + pu * 1.1), R * (0.2 + pu * 0.9) * pf.userData.k, pf.userData.d.z * R * (0.4 + pu * 1.1));
        pf.material.opacity = 0.7 * Math.sin(Math.PI * Math.min(1, pu * 1.1));
      }
    };
  }

  /**
   * 爆炸之后从废墟中间升起的一柱黑烟：比爆炸本身长（几秒），慢慢往上翻、被风带偏、散掉。
   * 它有自己的时钟（一个 type: 'smoke' 的事件，modeOf 不认它，不影响塔身画法）。
   */
  _smokeColumn(info, R) {
    const E = cfg().explode?.smokeColumn || {};
    const st = this.byId.get(this._curId);
    if (E.enabled === false || !st) return;
    R *= info.build?.kind === 'gem' ? (cfg().explode?.nexusScale ?? 1.35) : 1;
    const ev = { type: 'smoke', t: 0, dur: E.dur ?? 4 };
    st.events.push(ev);
    const root = this._root(info);
    const n = E.n ?? 9, puffs = [];
    for (let i = 0; i < n; i++) {
      const pf = this._puff(R * (E.size ?? 0.42), i % 3 ? (E.color || '#3d3833') : (E.colorLight || '#6a625a'));
      pf.userData.d0 = i / n * (E.stagger ?? 0.5);
      pf.userData.a = hash01(i, 131) * Math.PI * 2;
      pf.userData.k = 0.7 + hash01(i, 132) * 0.6;
      root.add(pf); puffs.push(pf);
    }
    const drift = E.drift ?? 0.6, rise = E.rise ?? 3.4, life = E.life ?? 0.55;
    this.anims.push({ id: this._curId, ev, root, update: (x) => {
      for (const pf of puffs) {
        const u = seg(x, pf.userData.d0, Math.min(1, pf.userData.d0 + life));   // 最后一团也在事件结束前散完
        pf.visible = u > 0 && u < 1;
        if (!pf.visible) continue;
        const k = pf.userData.k, a = pf.userData.a;
        this._puffScale(pf, (0.5 + easeOut(u) * 1.8) * k);
        pf.position.set(Math.cos(a) * R * 0.25 * (1 - u) + u * R * drift, R * (0.3 + easeOut(u) * rise * k), Math.sin(a) * R * 0.25 * (1 - u) + u * R * drift * 0.4);
        pf.material.opacity = (E.alpha ?? 0.6) * Math.sin(Math.PI * Math.min(1, u * 1.2)) * (1 - u * 0.3);
        pf.visible = pf.material.opacity > 0.005;
      }
    } });
  }

  // ---------- ②′ 被摧毁（连贯倒塌）：部件原地塌成废墟 ----------
  // 用户："目前一个最大问题是塔爆炸之后原有的塔模块消失了，取而代之的是从地下冒出来的废墟模型，很丑我不要这样的，
  //        我要求塔/塔掉落的块/废墟的模型的动画是相互关联的，并且召唤水晶/水晶枢纽爆炸同理。"
  // 这里没有"换模型"：基座留在原地；掉档时已经落在塔脚的部件不动；其余每一块从原位翻滚着落到它在废墟里的位置。
  // 播完那一刻，静态的废墟网格（同一批部件、同一组位置）接手。
  _spawnCollapse(ev, pb, info) {
    const K = cfg().collapse || {};
    const R = info.build.R, H = info.topY || R * 3;
    const root = this._root(info);
    const gone = new Set(pb.stages[Math.max(0, ev.fromStage ?? 0)] || []);
    // 这场倒塌专用的一份材质：边塌边压暗（烧过），播完时与废墟的顶点色对上
    const mat = makeUnitMaterial();
    const tint0 = new THREE.Color(currentUnitTint() || '#ffffff'), ruinTint = CONFIG.ui?.citadel?.ruin?.tint ?? 0.78;
    mat.color.copy(tint0);
    const mk = (id) => { const mesh = new THREE.Mesh(this._pieceGeo(pb, id), mat); mesh.matrixAutoUpdate = false; mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh; };
    const split = this._baseSplit(pb, pb.keepBelow ?? R * 0.3);
    mk(split.plinth).matrix.identity();
    if (split.upper) mk(split.upper).matrix.identity();   // 写实造型的主体全在基座里，这一份一般不存在
    let yMax = 1e-6;
    const items = [];
    for (const id of pb.model.order) {
      const parts = pb.model.pieceParts(id); if (!parts.length) continue;
      if (gone.has(id)) continue;   // 掉档时掉下去的部件早就消失了（掉档动画里落地 2 秒后沉没）
      const mesh = mk(id), rp = pb.model.ruinParams(id);
      yMax = Math.max(yMax, rp.c.y);
      // vanish：半路碎成渣的大块（芯、腰箍……），落到一半在烟尘里缩没，废墟里没有它
      const pc = pb.model.pieces.get(id);
      items.push({ mesh, rp, seed: items.length * 1.37 + 0.5, vanish: !!(pc.vanish || pc.cloth) });   // 旗在爆炸里烧没，同碎成渣的大块一样半路缩没
    }
    // 碎石丘：随着部件落地一点点堆起来（不是从地里冒出来的整块）；断桩一直在原地（倒塌前被塔身包着）
    const kit = pb.ruinKit, my = kit?.moundY || 0;
    const moundMesh = kit ? mk('__mound') : null;
    if (kit?.stump.length) mk('__stump').matrix.identity();
    const [mg0, mg1] = K.moundGrow || [0.3, 0.9];
    // 从上往下依次松动：离水晶近的先被炸开，底下的随后垮
    const [d0, d1] = K.delay || [0.02, 0.3], span = K.span ?? 0.62;
    for (const it of items) it.delay = d0 + (d1 - d0) * (1 - it.rp.c.y / yMax) + hash01(Math.round(it.seed * 31), 77) * (K.jitter ?? 0.08);
    // 落地扬尘：每块落地时在落点冒一小团灰
    const dust = [];
    const nDust = Math.min(items.length, K.dust ?? 14);
    for (let i = 0; i < nDust; i++) {
      const it = items[Math.floor(i * items.length / nDust)];
      const p = this._puff(R * 0.16, info.dustColor || '#a89f90');
      root.add(p); dust.push({ p, it, a: hash01(i, 91) * 6.28 });
    }
    const blast = this._blastFx(root, info, R, H);
    const land = K.fallEnd ?? 0.86;
    let last = 0;
    this.anims.push({ id: this._curId, ev, root, mats: [mat], update: (x) => {
      const dt = (x - last) * ev.dur; last = x;
      for (const it of items) {
        it.u = clamp01((x - it.delay) / span);
        it.mesh.matrix.copy(collapsePose(it.rp, it.u, R, it.seed));
        if (it.vanish) {
          const k = 1 - smooth(seg(it.u, K.vanish?.[0] ?? 0.4, K.vanish?.[1] ?? 0.8));
          it.mesh.visible = k > 0.01;
          if (k < 1) { const c = it.rp.c; it.mesh.matrix.multiply(_m1.makeTranslation(c.x, c.y, c.z)).multiply(_m2.makeScale(k, k, k)).multiply(_m1.makeTranslation(-c.x, -c.y, -c.z)); }
        }
      }
      if (moundMesh) {
        const g = smooth(seg(x, mg0, mg1));
        moundMesh.visible = g > 0.01;
        moundMesh.matrix.makeTranslation(0, my, 0).multiply(_m2.makeScale(0.45 + 0.55 * g, Math.max(0.02, g), 0.45 + 0.55 * g)).multiply(_m1.makeTranslation(0, -my, 0));
      }
      for (const d of dust) {
        const u = seg(d.it.u ?? 0, land, 1) * 0.6 + seg(x, d.it.delay + span, 1) * 0.4;
        d.p.visible = u > 0 && u < 1;
        d.p.material.opacity = 0.5 * Math.sin(Math.PI * Math.min(1, u * 1.15));
        const s2 = 0.7 + u * 1.9;
        this._puffScale(d.p, s2, s2 * 0.8);
        d.p.position.set(d.it.rp.dest.x + Math.cos(d.a) * u * R * 0.35, R * 0.1 + u * R * 0.3, d.it.rp.dest.z + Math.sin(d.a) * u * R * 0.35);
      }
      const k = 1 - (1 - ruinTint) * smooth(seg(x, 0.25, 0.95));
      mat.color.copy(tint0).multiplyScalar(k);
      blast(x, dt);
    } });
    this._smokeColumn(info, R);
  }

  // ---------- ③′ 召唤水晶重生（连贯）：部件从废墟里飞回原位 ----------
  _spawnReassemble(ev, pb, info) {
    const E = cfg().respawn || {};
    const R = info.build.R;
    const root = this._root(info);
    const mat = makeUnitMaterial();
    const tint0 = new THREE.Color(currentUnitTint() || '#ffffff'), ruinTint = CONFIG.ui?.citadel?.ruin?.tint ?? 0.78;
    const items = [];
    let i = 0;
    for (const id of pb.model.order) {
      if (!pb.model.pieceParts(id).length) continue;
      const mesh = new THREE.Mesh(this._pieceGeo(pb, id), mat); mesh.matrixAutoUpdate = false; mesh.castShadow = true; root.add(mesh);
      const rp = pb.model.ruinParams(id);
      // 废墟里没有的部件（会碎成渣的大块、掉档时就已经消失的部件）：不从地上飞回来，在原位重新长出来
      const pc = pb.model.pieces.get(id);
      const absent = !!(pc.vanish || pc.cloth) || !!pb.model._fallen?.has(id);
      items.push({ mesh, rp, seed: i * 1.37 + 0.5, delay: hash01(i, 61) * 0.3 + 0.25 * (rp.c.y / (info.topY || R * 3)), vanish: absent, absent: !!pb.model._fallen?.has(id) });   // 低处的先归位
      i++;
    }
    const kit = pb.ruinKit, my = kit?.moundY || 0;
    const extra = [];
    if (kit) for (const id of ['__mound', '__stump']) {
      if (id === '__stump' && !kit.stump.length) continue;
      const mesh = new THREE.Mesh(this._pieceGeo(pb, id), mat); mesh.matrixAutoUpdate = false; root.add(mesh); extra.push(mesh);
    }
    const [f0, f1] = E.fly || [0.1, 0.8];
    this.anims.push({ id: this._curId, ev, root, mats: [mat], update: (x) => {
      for (const it of items) {
        const t = seg(x, f0 + it.delay * (f1 - f0) * 0.6, f1);
        it.mesh.matrix.copy(it.absent ? _m1.identity() : collapsePose(it.rp, 1 - smooth(t), R, it.seed));
        it.mesh.visible = x < f1 + 0.02;
        if (it.vanish) {   // 碎掉的大块：归位途中重新长出来
          const k = smooth(seg(t, 0.2, 0.7)), c = it.rp.c;
          it.mesh.visible = it.mesh.visible && k > 0.01;
          if (k < 1) it.mesh.matrix.multiply(_m1.makeTranslation(c.x, c.y, c.z)).multiply(_m2.makeScale(k, k, k)).multiply(_m1.makeTranslation(-c.x, -c.y, -c.z));
        }
      }
      const g = 1 - smooth(seg(x, f0, f0 + (f1 - f0) * 0.7));
      for (const mesh of extra) {
        mesh.visible = g > 0.01;
        mesh.matrix.makeTranslation(0, my, 0).multiply(_m2.makeScale(0.45 + 0.55 * g, Math.max(0.02, g), 0.45 + 0.55 * g)).multiply(_m1.makeTranslation(0, -my, 0));
      }
      mat.color.copy(tint0).multiplyScalar(ruinTint + (1 - ruinTint) * smooth(seg(x, f0, f1)));
    } });
  }

  // ---------- ③ 召唤水晶重生 ----------
  _spawnRespawn(ev, pb, info) {
    const E = cfg().respawn || {};
    const R = info.build.R;
    const root = this._root(info);
    // 碎石堆：沉下去
    const pile = this._pieceMesh(null, pb, '__ruin');
    root.add(pile);
    // 部件：从各自的碎块位置倒着飞回原位（掉档动画倒放）
    const items = pb.model.order.map((id, i) => {
      const mesh = this._pieceMesh(null, pb, id);
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
        if (!o.geometry?.userData?.shared) o.geometry?.dispose?.();
        if (o.material && o.material !== unitMaterial(false) && !(a.mats && a.mats.includes(o.material))) o.material.dispose();
      }
    });
    if (a.mats) for (const m of a.mats) m.dispose();
  }

  clear() {
    for (const a of this.anims) this._dispose(a);
    this.anims = [];
    this.byId.clear();
  }

  forget(id) { this.byId.delete(id); }
}
