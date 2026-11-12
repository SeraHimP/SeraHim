/**
 * WorldLights.js —— 局部光：路边火炬（摆件 + 火焰）和水晶的光。
 *
 * 用户："路的两边自带光源（墙上的火炬），然后塔目前就不要自带光源了，但是水晶在任何时候都要发光……
 *        夜晚的光线效果非常烂。"
 * 做法：不用真的点光源（几十盏点光源 = 每个片元循环几十次）。所有局部光画进一张俯视的光照图
 * （2D 画布上一个个叠加的径向渐变），地形 / 岩石 / 树 / 单位的材质按世界坐标查一次（worldShading.wLocalLight）。
 * 火炬是静态的；水晶的光跟着建筑的死活走——清单变了才重画这张图。
 * 火焰本身是一批朝向相机的实例化面片，着色器里用滚动噪声烧出来，亮度超过 1 让泛光抓到。
 */
import * as THREE from '../../../vendor/three.module.js';
import { mergeGeometries } from '../../../vendor/BufferGeometryUtils.js';
import { CONFIG } from '../../data/Config.js';
import { placeTorches, localLightList } from '../../data/torchSites.js';
import { patchWorldMaterial, worldUniforms, setWorldLightMap } from './worldShading.js';

const cfg = () => CONFIG.terrain?.lights || {};

// 火炬摆件的造型尺寸（世界单位）：石墩 + 木杆 + 铁篮。纯装饰几何，具名常量即可。
const POST_H = 30, POST_R = 1.5, FOOT_R = 4.6, FOOT_H = 3.2, BASKET_R = 3.6, BASKET_H = 4.4;

function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo, c = new THREE.Color(hex), n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
function torchGeometry(pal) {
  const parts = [];
  const foot = new THREE.CylinderGeometry(FOOT_R * 0.8, FOOT_R, FOOT_H, 7); foot.translate(0, FOOT_H / 2, 0); parts.push(colored(foot, pal.stone));
  const post = new THREE.CylinderGeometry(POST_R * 0.8, POST_R, POST_H, 6); post.translate(0, FOOT_H + POST_H / 2, 0); parts.push(colored(post, pal.wood));
  for (const y of [FOOT_H + POST_H * 0.3, FOOT_H + POST_H * 0.92]) { const band = new THREE.CylinderGeometry(POST_R * 1.25, POST_R * 1.25, 1.1, 6); band.translate(0, y, 0); parts.push(colored(band, pal.iron)); }
  const top = FOOT_H + POST_H;
  const cup = new THREE.CylinderGeometry(BASKET_R, BASKET_R * 0.55, BASKET_H, 8, 1, true); cup.translate(0, top + BASKET_H / 2, 0); parts.push(colored(cup, pal.iron));
  const rim = new THREE.TorusGeometry(BASKET_R, 0.45, 4, 10); rim.rotateX(Math.PI / 2); rim.translate(0, top + BASKET_H, 0); parts.push(colored(rim, pal.iron));
  const coal = new THREE.SphereGeometry(BASKET_R * 0.78, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2); coal.translate(0, top + BASKET_H * 0.55, 0); parts.push(colored(coal, pal.coal));
  return { geo: mergeGeometries(parts, false), flameY: top + BASKET_H * 0.8 };
}

function flameMaterial(col) {
  const U = worldUniforms();
  return new THREE.ShaderMaterial({
    uniforms: { uWTime: U.uWTime, tWNoise: U.tWNoise, uWWind: U.uWWind,
      uCore: { value: new THREE.Color(col.core) }, uMid: { value: new THREE.Color(col.mid) }, uEdge: { value: new THREE.Color(col.edge) },
      uGain: { value: 1 }, uGlow: { value: 0 }, uLean: { value: new THREE.Vector2(...(cfg().flameLean ?? [0.1, 0.45])) } },
    vertexShader: /* glsl */`
      uniform float uWTime; uniform vec3 uWWind; uniform vec2 uLean;
      attribute vec4 aFlame;            // xyz = 火焰根部的世界坐标，w = 相位
      attribute float aKind;            // 0 = 火焰，1 = 光晕
      varying vec2 vUv; varying float vPh; varying float vKind;
      void main() {
        vUv = uv; vPh = aFlame.w; vKind = aKind;
        vec2 p = position.xy;
        vec4 mv;
        if (aKind > 0.5) {
          // 光晕是一团没有方向的柔光，正对相机就行
          mv = viewMatrix * vec4(aFlame.xyz, 1.0);
          mv.xy += p;
        } else {
          // 火苗永远朝世界的"上"：面片只绕竖轴转过来对着相机，不跟着相机的俯仰走。
          // 整张面片贴在屏幕上的话，"上"是屏幕的上，镜头一转火就跟着歪——火焰的方向不该由视角决定。
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 right = normalize(vec3(camR.x, 0.0, camR.z) + vec3(1e-5, 0.0, 0.0));
          // 火苗顶端跟着风歪一点（世界里的风向，同样与视角无关）
          float lean = uv.y * uv.y * (uLean.x + uLean.y * uWWind.z) * max(p.y, 0.0);
          vec3 wp = aFlame.xyz + right * p.x + vec3(0.0, p.y, 0.0) + vec3(uWWind.x, 0.0, uWWind.y) * lean;
          mv = viewMatrix * vec4(wp, 1.0);
        }
        mv.z += 2.0;                    // 往相机方向挪一点，免得和铁篮穿插
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tWNoise; uniform float uWTime, uGain, uGlow; uniform vec3 uCore, uMid, uEdge;
      varying vec2 vUv; varying float vPh; varying float vKind;
      void main() {
        if (vKind > 0.5) {              // 光晕：一团柔光，夜里才明显
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(max(0.0, 1.0 - d), 2.2) * uGlow * (0.9 + 0.1 * sin(uWTime * 11.0 + vPh * 40.0));
          gl_FragColor = vec4(uMid * a, 1.0);
          return;
        }
        vec2 uv = vUv; float y = uv.y;
        float t = uWTime * 1.35 + vPh * 7.0;
        float n1 = texture2D(tWNoise, vec2(uv.x * 0.55 + vPh, y * 0.5 - t * 0.55)).r;
        float n2 = texture2D(tWNoise, vec2(uv.x * 1.3 - vPh, y * 1.1 - t * 0.95)).g;
        float x = (uv.x - 0.5) * 2.0 + (n1 - 0.5) * 0.6 * y;
        // 水滴形的火舌：根部收一点、腰最宽、往上收尖，边缘被噪声啃掉
        float w = 0.66 * pow(1.0 - y, 0.72) * (0.5 + 0.5 * smoothstep(0.0, 0.2, y)) * (0.78 + 0.5 * n2);
        float body = 1.0 - smoothstep(w * 0.25, w, abs(x));
        float f = body * smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.5, 1.0, y + (n2 - 0.5) * 0.6));
        f *= 0.65 + 0.7 * n2;
        if (f < 0.02) discard;
        vec3 c = mix(uEdge, uMid, smoothstep(0.1, 0.5, f));
        c = mix(c, uCore, smoothstep(0.55, 0.95, f) * (1.0 - y * 0.6));
        gl_FragColor = vec4(c * f * uGain, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

/** 光照图：存的是 sqrt（材质里平方回去），暗部才不断层。 */
class LightMap {
  constructor(W, H, size) {
    this.W = W; this.H = H; this.N = size;
    this.cv = document.createElement('canvas'); this.cv.width = this.cv.height = size;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.NoColorSpace; this.tex.generateMipmaps = false;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this._c = new THREE.Color();
    this.falloff = cfg().falloff || [[0, 1], [0.18, 0.56], [0.4, 0.22], [0.65, 0.07], [0.85, 0.015], [1, 0]];
  }
  draw(lights) {
    const g = this.ctx, N = this.N, sx = N / this.W, sy = N / this.H;
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      const x = l.x * sx, y = l.y * sy, r = l.r * sx;
      const c = this._c.set(l.color), R = Math.round(c.r * 255), G = Math.round(c.g * 255), B = Math.round(c.b * 255);   // 线性色
      const grd = g.createRadialGradient(x, y, 0, x, y, r), k = Math.min(1, l.k ?? 1);
      // 衰减曲线（存的是 sqrt，材质里平方）：falloff = 各处还剩几成亮度。头一版 1/4 半径处就只剩不到四成、
      // 六成半径处只剩 4%，火炬只照亮脚下一小圈，路面是黑的（用户："路两侧的火炬是要有真正的照明效果的"）。
      const F = this.falloff;
      for (const [t, v] of F) grd.addColorStop(t, `rgba(${R},${G},${B},${k * Math.sqrt(Math.max(0, v))})`);
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); }
}

function kindOf(e) { const t = e._mapTier; return t === 'nexus_main' ? 'gem' : t === 'nexus_lane' ? 'orb' : 'tower'; }

/** @returns { group, torches, update(ctx), dispose() } */
export function buildWorldLights(field, theme) {
  const C = cfg(), T = theme.torch || {};
  const group = new THREE.Group(); group.name = 'worldLights';
  const torches = placeTorches(field, field.map);
  const disposables = [];
  let flameMat = null;
  if (torches.length) {
    const tg = torchGeometry({ stone: T.stone || '#8a8378', wood: T.wood || '#5a4630', iron: T.iron || '#3a3d44', coal: T.coal || '#3a1a0c' });
    const mat = patchWorldMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 }), { light: false });
    const inst = new THREE.InstancedMesh(tg.geo, mat, torches.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
    const k = C.torchScale ?? 1;
    torches.forEach((t, i) => {
      // 贴墙的火炬朝路的方向微微前倾，像是插在崖脚的石缝里
      const lean = t.wall ? 0.16 : 0.03, a = Math.atan2(t.dx, t.dy);
      E.set(lean, a, 0, 'YXZ'); Q.setFromEuler(E); S.setScalar(k); P.set(t.x, t.h - 0.6, t.y);
      M.compose(P, Q, S); inst.setMatrixAt(i, M);
    });
    inst.castShadow = true; inst.receiveShadow = true; inst.matrixAutoUpdate = false; inst.computeBoundingSphere();
    group.add(inst); disposables.push(tg.geo, mat);

    // 火焰 + 光晕：同一个实例化网格里各一份面片
    const fw = (C.flameSize?.[0] ?? 13) * k, fh = (C.flameSize?.[1] ?? 24) * k, gw = (C.glowSize ?? 70) * k;
    const quad = new THREE.PlaneGeometry(1, 1);
    const n = torches.length, vpi = 4, pos = new Float32Array(n * 2 * vpi * 3), uv = new Float32Array(n * 2 * vpi * 2);
    const fl = new Float32Array(n * 2 * vpi * 4), kd = new Float32Array(n * 2 * vpi), idx = [];
    const qp = quad.attributes.position, qu = quad.attributes.uv;
    const put = (slot, t, i, w, h, kind, y0) => {
      const tilt = t.wall ? Math.sin(0.16) : 0;
      const bx = t.x + t.dx * tg.flameY * tilt * k, bz = t.y + t.dy * tg.flameY * tilt * k, by = t.h + tg.flameY * k;
      for (let v = 0; v < vpi; v++) {
        const o = slot * vpi + v;
        pos[o * 3] = qp.getX(v) * w; pos[o * 3 + 1] = (qp.getY(v) + y0) * h; pos[o * 3 + 2] = 0;
        uv[o * 2] = qu.getX(v); uv[o * 2 + 1] = qu.getY(v);
        fl[o * 4] = bx; fl[o * 4 + 1] = by; fl[o * 4 + 2] = bz; fl[o * 4 + 3] = (i * 0.618) % 1;
        kd[o] = kind;
      }
      const b = slot * vpi; idx.push(b, b + 2, b + 1, b + 2, b + 3, b + 1);
    };
    torches.forEach((t, i) => { put(i, t, i, gw, gw, 1, 0.12); });                       // 光晕先画
    torches.forEach((t, i) => { put(n + i, t, i, fw, fh, 0, 0.42); });
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); fg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    fg.setAttribute('aFlame', new THREE.BufferAttribute(fl, 4)); fg.setAttribute('aKind', new THREE.BufferAttribute(kd, 1));
    fg.setIndex(idx);
    fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(field.W / 2, 0, field.H / 2), Math.hypot(field.W, field.H));
    flameMat = flameMaterial({ core: T.flameCore || '#fff3c4', mid: T.flame || '#ff9a2e', edge: T.flameEdge || '#d8320a' });
    const fm = new THREE.Mesh(fg, flameMat); fm.frustumCulled = false; fm.renderOrder = 6; fm.matrixAutoUpdate = false;
    group.add(fm); disposables.push(fg, flameMat, quad);
  }

  const lm = (typeof document !== 'undefined') ? new LightMap(field.W, field.H, C.mapSize ?? 512) : null;
  let sig = null, acc = 1e9;
  const redraw = (crystals) => { if (!lm) return; lm.draw(localLightList(torches, crystals, theme)); setWorldLightMap(lm.tex); };
  redraw([]);

  return {
    group, torches,
    update(ctx) {
      if (flameMat) {
        const n = Math.max(0, Math.min(1, ctx.night || 0));
        flameMat.uniforms.uGain.value = (C.flameGainDay ?? 1.5) + ((C.flameGainNight ?? 2.6) - (C.flameGainDay ?? 1.5)) * n;
        flameMat.uniforms.uGlow.value = (C.glowDay ?? 0.05) + ((C.glowNight ?? 0.42) - (C.glowDay ?? 0.05)) * n;
      }
      // 水晶的光跟着建筑死活走：每隔一小会儿对一次清单，变了才重画
      acc += ctx.dt || 0.016;
      if (acc < (C.crystalPollSec ?? 0.3) || !ctx.deps?.entities?.getAllTowers) return;
      acc = 0;
      const list = [];
      let s = '';
      for (const e of ctx.deps.entities.getAllTowers(true)) {
        if (!e.alive || !e.pos) continue;
        list.push({ x: e.pos.x, y: e.pos.y, faction: e._mapFaction || e.faction, kind: kindOf(e) });
        s += e.id + ',';
      }
      if (s !== sig) { sig = s; redraw(list); }
    },
    dispose() { for (const d of disposables) d.dispose(); lm?.dispose(); setWorldLightMap(null); },
  };
}
