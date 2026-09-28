/**
 * unitRig.js —— 小兵 / 巨龙的"部件骨骼"：合并几何时给每个顶点记下它属于哪根骨、绕哪个点转，
 * 顶点着色器按"走路相位 / 走路幅度 / 攻击进度 / 时间"四个数把四肢摆起来。
 *
 * 用户（2026-09-27）："最好也能把小兵攻击行走的动画做出来"，定稿"模型加基础动画，直接接入"。
 *
 * 为什么不用 SkinnedMesh：小兵走 InstancedMesh 合批（同屏上百个，一种兵一个 draw call），
 * 蒙皮骨骼没法合批。这里每个部件整体属于一根骨（刚体摆动），骨号与支点写进顶点属性，
 * 每个实例只多 4 个浮点（aAnim），上百个兵同屏开销可以忽略。
 *
 * 描边预渲染（PostFX 的法线/深度预渲染）和阴影深度也必须走同一套变形，否则描边与
 * 阴影画的是静止姿势，和身体对不上——所以同一段注入代码同时装进三种材质。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

/** 骨号。0 = 不动（跟着整个单位走）。 */
export const BONE = {
  NONE: 0,
  LEG_L: 1, LEG_R: 2,       // 腿：绕髋（支点）前后摆，左右反相
  ARM_OFF: 3,               // 副手（盾 / 书）：走路时反向摆
  ARM_MAIN: 4,              // 主手：走路摆 + 攻击挥动（先抬 windup、再劈 strike，× k；k = -1 为举过头顶再向前劈，k > 0 为杖头前倾）
  WHEEL: 5,                 // 车轮：绕轴转，转速 × k（≈ 1 / 轮半径）
  RECOIL: 6,                // 炮管：攻击时沿 -Z 后坐 k 个单位
  BOB: 7,                   // 悬浮件：上下浮动 k 个单位
  SPIN: 8,                  // 环绕件：绕支点的竖轴转，k = 弧度/秒
  WING: 9,                  // 龙翼：绕支点的 Z 轴扇动，k = ±1（左右翼镜像）
  BITE: 10,                 // 龙头：攻击时向前下方扑咬
  TAIL: 11,                 // 龙尾：左右摆
  THRUST: 12,               // 推击：先小幅后撤、再大幅前推（超级兵出拳、投石车甩臂），幅度 × k
};

const cfgA = () => CONFIG.ui?.unitModels?.anim || {};

// ---------------------------------------------------------------------------
// 合并：[{ geo, matrix, color, bone, pivot:[x,y,z], k }] → 一份带顶点色 + 骨骼属性的几何
// ---------------------------------------------------------------------------
const AO_MIN = 0.74, AO_CURVE = 0.6;
export function rigMerge(parts) {
  let n = 0;
  const prepped = parts.map((p) => {
    const g = p.geo.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    if (!ng.getAttribute('normal')) ng.computeVertexNormals();
    n += ng.getAttribute('position').count;
    return { g: ng, c: new THREE.Color(p.color), b: p.bone || 0, k: p.k ?? 1, pv: p.pivot || [0, 0, 0] };
  });
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const bone = new Float32Array(n * 2), piv = new Float32Array(n * 3);
  let o = 0;
  for (const { g, c, b, k, pv } of prepped) {
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++, o++) {
      pos[o * 3] = P.getX(i); pos[o * 3 + 1] = P.getY(i); pos[o * 3 + 2] = P.getZ(i);
      nrm[o * 3] = N.getX(i); nrm[o * 3 + 1] = N.getY(i); nrm[o * 3 + 2] = N.getZ(i);
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
      bone[o * 2] = b; bone[o * 2 + 1] = k;
      piv[o * 3] = pv[0]; piv[o * 3 + 1] = pv[1]; piv[o * 3 + 2] = pv[2];
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aBone', new THREE.BufferAttribute(bone, 2));
  out.setAttribute('aPivot', new THREE.BufferAttribute(piv, 3));
  out.computeBoundingBox();
  // 贴地假 AO（与 UnitMeshFactory.mergeParts 同一做法）：越靠底越暗一点
  const minY = out.boundingBox.min.y, span = Math.max(out.boundingBox.max.y - minY, 1e-6);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (pos[i * 3 + 1] - minY) / span));
    const f = AO_MIN + (1 - AO_MIN) * Math.pow(t, AO_CURVE);
    col[i * 3] *= f; col[i * 3 + 1] *= f; col[i * 3 + 2] *= f;
  }
  return out;
}

/** 合并 + 贴地（底面对齐 y = 0，支点一起平移）。返回 { geo, topY, animated: true } */
export function rigPack(parts) {
  const geo = rigMerge(parts);
  const dy = -geo.boundingBox.min.y;
  if (Math.abs(dy) > 1e-6) {
    geo.translate(0, dy, 0);
    const pv = geo.getAttribute('aPivot');
    for (let i = 0; i < pv.count; i++) pv.setY(i, pv.getY(i) + dy);
    geo.computeBoundingBox();
  }
  geo.userData.animated = true;
  return { geo, topY: geo.boundingBox.max.y, animated: true };
}

// ---------------------------------------------------------------------------
// 着色器注入
// ---------------------------------------------------------------------------
const GLSL_HEAD = /* glsl */`
attribute vec2 aBone;
attribute vec3 aPivot;
#ifdef UNIT_ANIM_INST
attribute vec4 aAnim;
#define UA aAnim
#else
uniform vec4 uAnim;
#define UA uAnim
#endif
uniform vec4 uAnimK;   // 腿摆幅, 臂摆幅, 攻击抬手, 攻击劈下
uniform vec4 uAnimK2;  // 翼扇动幅度, 翼扇动频率, 扑咬幅度, 尾摆幅度
uniform vec3 uAnimK3;  // 攻击抬手占攻击时长的比例, 劈下占的比例, 走路时主手（连同武器）摆幅相对臂摆幅的倍数
mat3 uaRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 uaRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 uaRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
// 攻击挥动：先抬手（0 → +抬手），再劈下（→ -劈下），最后回到 0。t < 0 = 没在攻击。
float uaSwing(float t) {
  if (t < 0.0 || t > 1.0) return 0.0;
  float a = uAnimK3.x, b = uAnimK3.x + uAnimK3.y;
  if (t < a) return uAnimK.z * smoothstep(0.0, a, t);
  if (t < b) return mix(uAnimK.z, -uAnimK.w, smoothstep(a, b, t));
  return -uAnimK.w * (1.0 - smoothstep(b, 1.0, t));
}
// 推击：先往回收一点（-0.3），再大幅推出去（1），然后收回。
float uaThrust(float t) {
  if (t < 0.0 || t > 1.0) return 0.0;
  float a = uAnimK3.x, b = uAnimK3.x + uAnimK3.y;
  if (t < a) return -0.3 * smoothstep(0.0, a, t);
  if (t < b) return mix(-0.3, 1.0, smoothstep(a, b, t));
  return 1.0 - smoothstep(b, 1.0, t);
}
float uaPulse(float t) { return (t < 0.0 || t > 1.0) ? 0.0 : sin(3.14159265 * t); }
void unitAnim(inout vec3 p, inout vec3 n) {
  float ph = UA.x, walk = UA.y, at = UA.z, tm = UA.w;
  int b = int(aBone.x + 0.5);
  float k = aBone.y;
  if (b == 0) return;
  mat3 R = mat3(1.0);
  vec3 off = vec3(0.0);
  if (b == 1) R = uaRotX(sin(ph) * uAnimK.x * walk * k);
  else if (b == 2) R = uaRotX(-sin(ph) * uAnimK.x * walk * k);
  else if (b == 3) R = uaRotX(-sin(ph) * uAnimK.y * walk * k * 0.6);
  else if (b == 4) R = uaRotX(sin(ph) * uAnimK.y * walk * uAnimK3.z + uaSwing(at) * k);
  else if (b == 5) R = uaRotX(ph * k);
  else if (b == 6) off = vec3(0.0, 0.0, -uaPulse(at) * k);
  else if (b == 7) off = vec3(0.0, sin(tm * 2.1 + aPivot.x * 0.37 + aPivot.z * 0.23) * k, 0.0);
  else if (b == 8) R = uaRotY(tm * k);
  else if (b == 9) R = uaRotZ(k * (sin(tm * uAnimK2.y) * uAnimK2.x + uaPulse(at) * uAnimK2.x * 1.6));
  else if (b == 10) R = uaRotX(uaPulse(at) * uAnimK2.z * k);
  else if (b == 11) R = uaRotY((sin(tm * 1.7) * 0.5 + sin(ph) * walk * 0.5) * uAnimK2.w * k);
  else if (b == 12) R = uaRotX(sin(ph) * uAnimK.y * walk * uAnimK3.z * 0.6 + uaThrust(at) * k);
  p = R * (p - aPivot) + aPivot + off;
  n = R * n;
}
`;

function uniformsFromConfig() {
  const A = cfgA();
  return {
    uAnimK: { value: new THREE.Vector4(A.legSwing ?? 0.55, A.armSwing ?? 0.35, A.windup ?? 2.0, A.strike ?? 0.6) },
    uAnimK2: { value: new THREE.Vector4(A.wingFlap ?? 0.22, A.wingFreq ?? 2.4, A.bite ?? 0.45, A.tailSway ?? 0.25) },
    uAnimK3: { value: new THREE.Vector3(A.windupFrac ?? 0.4, A.strikeFrac ?? 0.2, A.mainArmWalk ?? 0.9) },
  };
}

/** 把动画注入装进一个内置材质（Standard / Normal / Depth 都行）。inst = 走实例属性 aAnim，否则走 uniform uAnim。 */
function injectAnim(mat, inst, tag) {
  const u = uniformsFromConfig();
  const uAnim = { value: new THREE.Vector4(0, 0, -1, 0) };
  mat.userData.uAnim = uAnim;
  mat.userData.animUniforms = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    if (!inst) sh.uniforms.uAnim = uAnim;
    sh.vertexShader = (inst ? '#define UNIT_ANIM_INST\n' : '') + sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_HEAD);
    if (sh.vertexShader.includes('#include <beginnormal_vertex>')) {
      sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n{ vec3 uaP = position; unitAnim(uaP, objectNormal); }');
    }
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n{ vec3 uaN = vec3(0.0, 1.0, 0.0); unitAnim(transformed, uaN); }');
  };
  mat.customProgramCacheKey = () => `unitAnim|${tag}|${inst ? 'i' : 'u'}`;
  return mat;
}

/** 配置改了（编辑器里调幅度）时，把新值推给所有已经建好的动画材质。 */
const _live = new Set();
export function refreshAnimUniforms() {
  const fresh = uniformsFromConfig();
  for (const m of _live) {
    const u = m.userData.animUniforms;
    if (!u) continue;
    u.uAnimK.value.copy(fresh.uAnimK.value); u.uAnimK2.value.copy(fresh.uAnimK2.value); u.uAnimK3.value.copy(fresh.uAnimK3.value);
  }
}

/**
 * 一套动画材质：本体（受光、顶点色，与 unitMaterial 同参数）+ 描边预渲染用的法线材质 + 阴影深度材质。
 * inst = true：合批（小兵），每个实例的 aAnim 由 InstancedBodyLayer 写；
 * inst = false：单体（巨龙），每条龙一套，UnitLayer 每帧写 userData.uAnim。
 */
export function animMaterials(inst) {
  const body = injectAnim(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0, color: 0xffffff,
  }), inst, 'body');
  const normal = injectAnim(new THREE.MeshNormalMaterial(), inst, 'normal');
  const depth = injectAnim(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), inst, 'depth');
  // 单体版三者共用同一个 uAnim（本体、描边、阴影同一姿势）
  if (!inst) { normal.userData.uAnim = depth.userData.uAnim = body.userData.uAnim; relinkUniform(normal, body); relinkUniform(depth, body); }
  body.userData.prepassMaterial = normal;
  body.userData.depthMaterial = depth;
  body.userData.isUnitAnim = true;
  for (const m of [body, normal, depth]) _live.add(m);
  return body;
}
function relinkUniform(m, src) {
  const cb = m.onBeforeCompile;
  m.onBeforeCompile = (sh) => { cb(sh); sh.uniforms.uAnim = src.userData.uAnim; };
}

export function disposeAnimMaterials(body) {
  if (!body) return;
  for (const m of [body, body.userData.prepassMaterial, body.userData.depthMaterial]) {
    if (!m) continue;
    _live.delete(m);
    m.dispose();
  }
}

/** 所有活着的动画本体材质（昼夜染色要一并染）。 */
export function liveAnimBodies() { return [..._live].filter((m) => m.userData.isUnitAnim); }

// ---------------------------------------------------------------------------
// 动画状态（纯函数，测试直接算）
// ---------------------------------------------------------------------------
/**
 * 推进一个单位的动画状态。
 * @param {object} st  { walk, atk }：walk = 走路幅度 0..1（平滑），atk = 攻击进度 0..1，-1 = 没在攻击
 * @param {boolean} moving  这一帧挪动了
 * @param {boolean} fired   这一帧刚打出一次攻击（attackCooldown 跳增）
 * @param {number} dt
 */
export function stepAnimState(st, moving, fired, dt) {
  const A = cfgA();
  const rate = A.walkBlend ?? 8;               // 起步 / 停下的过渡快慢（1/秒）
  const target = moving ? 1 : 0;
  st.walk = st.walk + (target - st.walk) * Math.min(1, dt * rate);
  if (Math.abs(st.walk - target) < 1e-3) st.walk = target;
  if (fired) st.atk = 0;
  else if (st.atk >= 0) {
    st.atk += dt / Math.max(0.05, A.attackDur ?? 0.45);
    if (st.atk > 1) st.atk = -1;
  }
  return st;
}
