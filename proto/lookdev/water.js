/**
 * water.js —— 阶段 0 原型的河面：平面反射 + 流动法线 + 菲涅尔 + 按深度变色 + 岸边泡沫。
 * 反射用镜像相机渲染到半分辨率 RT；深度用场景深度贴图比较（岸边泡沫、浅水透明）。
 */
import * as THREE from '../../vendor/three.module.js';

export class LookdevWater {
  constructor(renderer, scene, camera, region, level, normalTex, opt = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.level = level;
    const { x0, y0, x1, y1 } = region;
    this.reflRT = new THREE.WebGLRenderTarget(960, 600, { type: THREE.HalfFloatType });
    this.reflCam = camera.clone();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tRefl: { value: this.reflRT.texture }, tNormal: { value: normalTex }, tDepth: { value: null },
        uTime: { value: 0 }, uCamNear: { value: camera.near }, uCamFar: { value: camera.far },
        uRes: { value: new THREE.Vector2(1, 1) },
        uShallow: { value: new THREE.Color(opt.shallow || '#3f8f8c') }, uDeep: { value: new THREE.Color(opt.deep || '#0f3a44') },
        uSun: { value: new THREE.Vector3(0.5, 0.7, 0.3) }, uSunCol: { value: new THREE.Color(opt.sunCol || '#fff2d6') },
        uFog: { value: new THREE.Color(opt.fog || '#9fb3c4') }, uFogD: { value: opt.fogDensity ?? 0.0 },
        uLevel: { value: level },
      },
      vertexShader: `varying vec4 vClip; varying vec3 vW; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; vec4 cp = projectionMatrix * viewMatrix * wp; vClip = cp; gl_Position = cp; }`,
      fragmentShader: `
uniform sampler2D tRefl, tNormal, tDepth; uniform float uTime, uCamNear, uCamFar, uLevel, uFogD; uniform vec2 uRes;
uniform vec3 uShallow, uDeep, uSun, uSunCol, uFog;
varying vec4 vClip; varying vec3 vW;
float linDepth(float z){ float n = uCamNear, f = uCamFar; float zn = z * 2.0 - 1.0; return 2.0*n*f / (f + n - zn*(f-n)); }
void main(){
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec3 n1 = texture2D(tNormal, vW.xz * 0.012 + vec2(uTime*0.012, uTime*0.006)).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(tNormal, vW.xz * 0.031 - vec2(uTime*0.02, -uTime*0.011)).xyz * 2.0 - 1.0;
  vec3 nn = normalize(vec3(n1.x + n2.x * 0.6, 3.0, n1.y + n2.y * 0.6));
  // 深度：场景深度 - 水面深度 → 水深（视空间）
  float sceneZ = linDepth(texture2D(tDepth, suv).r);
  float waterZ = linDepth(gl_FragCoord.z);
  float depth = max(0.0, sceneZ - waterZ);
  float dk = 1.0 - exp(-depth * 0.06);
  vec3 cam = cameraPosition; vec3 V = normalize(cam - vW);
  float fres = pow(1.0 - max(0.0, dot(V, nn)), 3.0) * 0.85 + 0.08;
  vec2 ruv = vec2(suv.x, suv.y) + nn.xz * 0.035 * (0.3 + 0.7 * dk);
  vec3 refl = texture2D(tRefl, clamp(ruv, 0.002, 0.998)).rgb;
  vec3 body = mix(uShallow, uDeep, dk);
  vec3 H = normalize(V + normalize(uSun));
  float spec = pow(max(0.0, dot(nn, H)), 180.0) * 1.6;
  vec3 col = mix(body, refl, fres) + uSunCol * spec;
  // 岸边泡沫
  float foam = (1.0 - smoothstep(0.0, 6.0, depth)) * (0.35 + 0.65 * smoothstep(0.45, 0.7, texture2D(tNormal, vW.xz * 0.05 + uTime * 0.03).r));
  col = mix(col, vec3(0.9, 0.93, 0.95), foam * 0.6);
  float alpha = clamp(0.35 + dk * 0.65 + fres * 0.4 + foam, 0.0, 1.0);
  float fd = length(cam - vW); float fogK = 1.0 - exp(-fd * fd * uFogD * uFogD);
  col = mix(col, uFog, fogK);
  gl_FragColor = vec4(col, alpha);
}`,
      transparent: true, depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(x1 - x0, y1 - y0, 1, 1); geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.set((x0 + x1) / 2, level, (y0 + y1) / 2);
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }
  setDepthTexture(t, w, h) { this.mat.uniforms.tDepth.value = t; this.mat.uniforms.uRes.value.set(w, h); }
  setSun(dir, col) { this.mat.uniforms.uSun.value.copy(dir); if (col) this.mat.uniforms.uSunCol.value.set(col); }
  setFog(col, d) { this.mat.uniforms.uFog.value.set(col); this.mat.uniforms.uFogD.value = d; }
  /** 每帧：先把镜像视角渲进反射 RT（水面自己隐藏） */
  renderReflection(t) {
    this.mat.uniforms.uTime.value = t;
    const cam = this.camera, rc = this.reflCam;
    rc.copy(cam);
    rc.position.y = 2 * this.level - cam.position.y;
    const look = new THREE.Vector3(); cam.getWorldDirection(look);
    look.y = -look.y;
    rc.up.set(0, -1, 0);
    rc.lookAt(rc.position.clone().add(look));
    rc.up.set(0, 1, 0);
    rc.projectionMatrix.copy(cam.projectionMatrix);
    this.mesh.visible = false;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.reflRT);
    this.renderer.render(this.scene, rc);
    this.renderer.setRenderTarget(prev);
    this.mesh.visible = true;
  }
}

/** 流水法线贴图（程序化，可平铺） */
export function waterNormalTexture(N = 512) {
  const h = new Float32Array(N * N);
  const hs = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  const fd = (t) => t * t * (3 - 2 * t);
  const vn = (u, v, p, s) => { const x = u * p, y = v * p, x0 = Math.floor(x), y0 = Math.floor(y), fx = fd(x - x0), fy = fd(y - y0);
    const w = (i, j) => hs(((x0 + i) % p + p) % p, ((y0 + j) % p + p) % p, s); const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    h[y * N + x] = vn(u, v, 6, 1) * 0.5 + vn(u, v, 14, 2) * 0.3 + vn(u, v, 40, 3) * 0.2;
  }
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const L = h[y * N + ((x - 1 + N) % N)], R = h[y * N + ((x + 1) % N)], U = h[((y - 1 + N) % N) * N + x], D = h[((y + 1) % N) * N + x];
    let nx = (L - R) * 6, ny = (U - D) * 6, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * N + x) * 4; d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  return t;
}
