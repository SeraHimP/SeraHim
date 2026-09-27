/**
 * shieldShell.js —— 防御塔有护盾时，塔身被一层护盾"包裹"的效果。
 *
 * 用户："防御塔（仅包含防御塔不包含其他单位）在有护盾（仅固定护盾/护盾，不包含临时护盾）的时候
 * 塔身有那种被护盾包裹的那种效果。"定稿（2026-09-27 三选）：
 *   · 贴身外壳：把塔身沿法线外扩一点点，半透明、越靠轮廓越亮（Fresnel），表面有缓慢上行的光纹；
 *   · 金白色；
 *   · 不随护盾厚薄变亮（"不要越厚越亮"），但被打时闪一下；护盾没了淡出。
 *
 * 外扩方向用"平滑法线"：塔身是平面着色的低多边形，每个面各自一份法线，沿它外扩会让相邻面
 * 在棱上裂开。这里把同一位置的顶点法线取平均再外扩，外壳是一整张不裂的皮。
 * 贴地的碎块、石台底部不包（uMinY 以下丢弃）——护盾包的是"塔身"。
 * 参数在 CONFIG.ui.towerShield。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const _geoCache = new WeakMap();

/** 只留位置 + 平滑法线的外壳几何（按源几何缓存；源几何是按 key 全局共享的，外壳跟着共享）。 */
export function shellGeometry(src) {
  let g = _geoCache.get(src);
  if (g) return g;
  const p = src.getAttribute('position'), n = src.getAttribute('normal');
  const acc = new Map();
  const key = (i) => `${Math.round(p.getX(i) * 50)}|${Math.round(p.getY(i) * 50)}|${Math.round(p.getZ(i) * 50)}`;
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let a = acc.get(k);
    if (!a) { a = [0, 0, 0]; acc.set(k, a); }
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
  }
  const pos = new Float32Array(p.count * 3), nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]);
    // 薄片（布条两面、贴合的零件）同一位置正反两个法线会抵消成 0 —— 退回这个面自己的法线。
    // 零向量进着色器 normalize 会出 NaN，辉光再把 NaN 糊成满屏黑块（第一次实拍就是这样）。
    if (l < 1e-3) { a = [n.getX(i), n.getY(i), n.getZ(i)]; l = Math.hypot(a[0], a[1], a[2]) || 1; }
    pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i);
    nrm[i * 3] = a[0] / l; nrm[i * 3 + 1] = a[1] / l; nrm[i * 3 + 2] = a[2] / l;
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  _geoCache.set(src, g);
  return g;
}

/** 每座塔一份材质（闪光/淡入淡出是逐塔的） */
export function shellMaterial(R) {
  const S = CONFIG.ui?.towerShield || {};
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAlpha: { value: 0 }, uFlash: { value: 0 },
      uInflate: { value: R * (S.inflate ?? 0.08) }, uMinY: { value: R * (S.minY ?? 0.35) },
      uColor: { value: new THREE.Color(S.color || '#ffd98a') }, uRimColor: { value: new THREE.Color(S.rimColor || '#fff8e6') },
      uBase: { value: S.base ?? 0.06 }, uRimPower: { value: S.rimPower ?? 2.2 }, uRim: { value: S.rimStrength ?? 1.1 },
      uSheen: { value: S.sheenStrength ?? 0.35 }, uSheenFreq: { value: (S.sheenFreq ?? 0.12) }, uSheenSpeed: { value: S.sheenSpeed ?? 22 },
      uFlashK: { value: S.flashStrength ?? 1.6 },
    },
    vertexShader: `
      uniform float uInflate;
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        vec3 p = position + normal * uInflate;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 nn = normalMatrix * normal;
        vN = dot(nn, nn) > 1e-8 ? normalize(nn) : vec3(0.0, 0.0, 1.0);
        vV = projectionMatrix[3][3] == 1.0 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);   // 正交相机视线恒定
        vY = position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTime, uAlpha, uFlash, uMinY, uBase, uRimPower, uRim, uSheen, uSheenFreq, uSheenSpeed, uFlashK;
      uniform vec3 uColor, uRimColor;
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        if (vY < uMinY) discard;
        vec3 N = dot(vN, vN) > 1e-8 ? normalize(vN) : vec3(0.0, 0.0, 1.0);
        float fres = pow(clamp(1.0 - abs(dot(N, normalize(vV))), 0.0, 1.0), uRimPower);
        float band = pow(0.5 + 0.5 * sin(vY * uSheenFreq - uTime * uSheenSpeed * uSheenFreq), 10.0);   // 缓慢上行的光纹
        float fadeIn = smoothstep(uMinY, uMinY + 6.0, vY);
        float a = (uBase + fres * uRim + band * uSheen) * (1.0 + uFlash * uFlashK) * uAlpha * fadeIn;
        vec3 c = mix(uColor, uRimColor, clamp(fres + uFlash * 0.5, 0.0, 1.0));
        gl_FragColor = vec4(c * (1.0 + uFlash), clamp(a, 0.0, 1.0));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
  });
}

/**
 * 逐帧推进一座塔的护盾外壳状态（纯函数，便于测试）。
 * @param {{alpha:number, flash:number, prev:number}} st 上一帧状态（会被改写）
 * @param {number} amount 这一帧的护盾量（固定护盾 + 护盾，不含临时护盾）
 * @param {number} dt 墙钟秒
 * @returns {boolean} 这一帧还要不要画
 */
export function stepShieldState(st, amount, dt) {
  const S = CONFIG.ui?.towerShield || {};
  const want = amount > 0;
  if (st.prev > 0 && amount < st.prev - 1e-6) st.flash = 1;              // 被打（含被打穿的那一下）
  st.prev = amount;
  st.flash = Math.max(0, st.flash - dt / Math.max(1e-3, S.flashDur ?? 0.25));
  const dur = want ? (S.fadeIn ?? 0.3) : (S.fadeOut ?? 0.45);
  st.alpha = Math.max(0, Math.min(1, st.alpha + (want ? 1 : -1) * dt / Math.max(1e-3, dur)));
  return want || st.alpha > 0;
}
