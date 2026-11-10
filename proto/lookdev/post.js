/**
 * post.js —— 阶段 0 原型的后处理链：SSAO（透视相机、半分辨率、模糊）→ 泛光 → 色调映射 → FXAA。
 * 现有 PostFX.js 的 SSAO 是按正交相机写的位置重建公式，这里为透视相机单独写一版，正式做时合并。
 */
import * as THREE from '../../vendor/three.module.js';
import { EffectComposer } from '../../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/postprocessing/RenderPass.js';
import { ShaderPass } from '../../vendor/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from '../../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from '../../vendor/postprocessing/Pass.js';
import { FXAAShader } from '../../vendor/shaders/FXAAShader.js';

const AO_FRAG = /* glsl */`
uniform sampler2D tDepth, tNoise; uniform mat4 uProj, uInvProj; uniform vec2 uRes; uniform float uRadius, uBias, uPower;
uniform vec3 uKernel[16];
varying vec2 vUv;
vec3 viewPos(vec2 uv){ float z = texture2D(tDepth, uv).r; vec4 c = vec4(uv*2.0-1.0, z*2.0-1.0, 1.0); vec4 v = uInvProj * c; return v.xyz / v.w; }
void main(){
  vec3 P = viewPos(vUv);
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  vec3 rnd = texture2D(tNoise, vUv * uRes / 4.0).xyz * 2.0 - 1.0;
  vec3 T = normalize(rnd - N * dot(rnd, N)); vec3 B = cross(N, T); mat3 TBN = mat3(T, B, N);
  float occ = 0.0;
  for (int i = 0; i < 16; i++) {
    vec3 s = P + TBN * uKernel[i] * uRadius;
    vec4 o = uProj * vec4(s, 1.0); o.xyz /= o.w; vec2 suv = o.xy * 0.5 + 0.5;
    float sz = viewPos(suv).z;
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / abs(P.z - sz));
    occ += (sz >= s.z + uBias ? 1.0 : 0.0) * rangeCheck;
  }
  float ao = 1.0 - occ / 16.0;
  gl_FragColor = vec4(vec3(pow(ao, uPower)), 1.0);
}`;
const BLUR_FRAG = /* glsl */`
uniform sampler2D tAO; uniform vec2 uDir; varying vec2 vUv;
void main(){ float s = 0.0; float w[5]; w[0]=0.227; w[1]=0.195; w[2]=0.122; w[3]=0.054; w[4]=0.016;
  s += texture2D(tAO, vUv).r * w[0]; for (int i = 1; i < 5; i++) { s += texture2D(tAO, vUv + uDir * float(i)).r * w[i]; s += texture2D(tAO, vUv - uDir * float(i)).r * w[i]; }
  gl_FragColor = vec4(vec3(s), 1.0); }`;
const COMP_FRAG = /* glsl */`
uniform sampler2D tDiffuse, tAO; varying vec2 vUv;
void main(){ vec4 c = texture2D(tDiffuse, vUv); float ao = texture2D(tAO, vUv).r; gl_FragColor = vec4(c.rgb * ao, c.a); }`;
const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class SSAOPass extends Pass {
  constructor(camera, depthTex, w, h, opt = {}) {
    super();
    this.camera = camera;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.aoRT = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.blurRT = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const kernel = [];
    for (let i = 0; i < 16; i++) {
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()).normalize();
      let s = i / 16; s = 0.1 + 0.9 * s * s; v.multiplyScalar(Math.random() * s); kernel.push(v);
    }
    const nd = new Uint8Array(16 * 4); for (let i = 0; i < 16; i++) { nd[i * 4] = Math.random() * 255; nd[i * 4 + 1] = Math.random() * 255; nd[i * 4 + 2] = 0; nd[i * 4 + 3] = 255; }
    const noise = new THREE.DataTexture(nd, 4, 4); noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.needsUpdate = true;
    this.aoMat = new THREE.ShaderMaterial({ uniforms: {
      tDepth: { value: depthTex }, tNoise: { value: noise }, uProj: { value: camera.projectionMatrix }, uInvProj: { value: camera.projectionMatrixInverse },
      uRes: { value: new THREE.Vector2(hw, hh) }, uRadius: { value: opt.radius ?? 14 }, uBias: { value: opt.bias ?? 0.4 }, uPower: { value: opt.power ?? 1.6 }, uKernel: { value: kernel },
    }, vertexShader: VERT, fragmentShader: AO_FRAG });
    this.blurMat = new THREE.ShaderMaterial({ uniforms: { tAO: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: VERT, fragmentShader: BLUR_FRAG });
    this.compMat = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, tAO: { value: null } }, vertexShader: VERT, fragmentShader: COMP_FRAG });
    this.fsq = new FullScreenQuad(this.aoMat);
    this.hw = hw; this.hh = hh;
  }
  render(renderer, writeBuffer, readBuffer) {
    this.aoMat.uniforms.uProj.value = this.camera.projectionMatrix; this.aoMat.uniforms.uInvProj.value = this.camera.projectionMatrixInverse;
    this.fsq.material = this.aoMat; renderer.setRenderTarget(this.aoRT); this.fsq.render(renderer);
    this.fsq.material = this.blurMat;
    this.blurMat.uniforms.tAO.value = this.aoRT.texture; this.blurMat.uniforms.uDir.value.set(1 / this.hw, 0); renderer.setRenderTarget(this.blurRT); this.fsq.render(renderer);
    this.blurMat.uniforms.tAO.value = this.blurRT.texture; this.blurMat.uniforms.uDir.value.set(0, 1 / this.hh); renderer.setRenderTarget(this.aoRT); this.fsq.render(renderer);
    this.fsq.material = this.compMat; this.compMat.uniforms.tDiffuse.value = readBuffer.texture; this.compMat.uniforms.tAO.value = this.aoRT.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.fsq.render(renderer);
  }
  setSize() {}
}

/**
 * @returns { composer, depthRT, render(dt) }  depthRT：不透明场景的深度预渲染（水面和 SSAO 共用）
 */
export function buildPost(renderer, scene, camera, w, h, opt = {}) {
  const depthRT = new THREE.WebGLRenderTarget(w, h);
  depthRT.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 }));
  composer.addPass(new RenderPass(scene, camera));
  const ssao = new SSAOPass(camera, depthRT.depthTexture, w, h, opt.ssao);
  if (opt.ssao !== false) composer.addPass(ssao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), opt.bloomStrength ?? 0.25, opt.bloomRadius ?? 0.6, opt.bloomThreshold ?? 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader); fxaa.uniforms.resolution.value.set(1 / w, 1 / h); composer.addPass(fxaa);
  return {
    composer, depthRT, ssao, bloom,
    renderDepth(hide = []) {
      for (const o of hide) o.visible = false;
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(depthRT); renderer.render(scene, camera); renderer.setRenderTarget(prev);
      for (const o of hide) o.visible = true;
    },
  };
}
