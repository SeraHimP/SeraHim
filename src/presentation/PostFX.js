/**
 * PostFX.js —— 后处理：场景 Pass（MSAA + 深度贴图）、SSAO、伪体积雾。
 *
 * SSAO 和体积雾都要"每个像素离相机多远"，用的是同一张深度贴图：ScenePass 主渲染的深度。
 * 视空间位置由深度经投影逆矩阵重建（透视 / 正交通用）；SSAO 需要的法线也由深度差分得到。
 * 每个效果都能独立开关（ThreeRenderer.setSSAO / setFog / setAA），关掉时对帧时间零影响。
 */
import * as THREE from '../../vendor/three.module.js';
import { fogNoiseTexture } from './fogNoise.js';
import { CONFIG } from '../data/Config.js';
import { Pass, FullScreenQuad } from '../../vendor/postprocessing/Pass.js';
import { ShaderPass } from '../../vendor/postprocessing/ShaderPass.js';

/**
 * 血条 / 护盾图标这类"永远画在最上层"的 HUD 精灵所在的层。
 * 主相机必须 `camera.layers.enable(HUD_SPRITE_LAYER)`，否则正式渲染里它们会消失
 * （layers 是掩码，`layers.set` 会清掉默认的 0 层）。
 * 这些精灵的材质必须 depthWrite=false：SSAO / 雾读的是主渲染深度，写了深度就会在血条周围算出一圈假遮蔽。
 */
export const HUD_SPRITE_LAYER = 1;

/** 粒子 / 薄纱（雨、雪、尘、雾片）所在的层。规则同上：主相机要 enable，材质不写深度。 */
export const FX_PARTICLE_LAYER = 2;

// ==================== 场景 Pass：MSAA 颜色 + 深度贴图 ====================
/**
 * 把场景画进一张多重采样的 HDR 渲染目标，并把深度解析成贴图给 SSAO / 体积雾用。
 *
 * 取代了原来的两样东西：
 *   ① vendor 的 RenderPass + FXAA。FXAA 是把整幅画面按亮度梯度抹一遍，贴图细节一起被抹掉
 *      （用户："画面看起来有些模糊"；实测关掉 FXAA 清晰度指标翻倍）。MSAA 只在几何边缘多采样，贴图不受影响。
 *   ② 法线 + 深度预渲染。那是把整个场景换材质再画一遍，中期约 400 次绘制调用纯属重复；
 *      深度直接用主渲染的，法线在 SSAO 里由深度重建。
 *
 * 血条 / 粒子这类不该参与遮蔽的东西：它们的材质不写深度（depthWrite=false），所以深度贴图里本来就没有它们。
 */
class ScenePass extends Pass {
  constructor(scene, camera, width, height, samples = 4) {
    super();
    this.scene = scene; this.camera = camera;
    this.needsSwap = true; this.clear = true;
    this.samples = samples;
    this.rt = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, samples,
      depthTexture: new THREE.DepthTexture(width, height),
    });
    this.rt.texture.name = 'ScenePass.color';
    // 拷出来的同时清掉坏值：半精度缓冲里超过 65504 的值会变成无穷大（低粗糙度水面正对太阳时的镜面高光就能到这个量级），
    // 计算出错的像素是 NaN。这两种值进了泛光，会在低分辨率层里被糊开成一大块黑——
    // 用户报"移动画面时偶发黑色大块闪一下，大概占屏幕 1/9"，关掉后处理就没有，正是这个形状。
    // 上限取 CONFIG.postfx.sceneMax：正常画面里的值远低于它，所以这一步对正常像素是空操作。
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.rt.texture }, uMax: { value: CONFIG.postfx?.sceneMax ?? 64 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uMax;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          c.rgb = any(isnan(c.rgb)) ? vec3(0.0) : clamp(c.rgb, 0.0, uMax);
          gl_FragColor = c;
        }`,
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.copyMat);
  }
  get depthTexture() { return this.rt.depthTexture; }
  setSize(width, height) {
    this.rt.setSize(width, height);
    this.rt.depthTexture.image.width = width; this.rt.depthTexture.image.height = height;
    this.rt.depthTexture.needsUpdate = true;
  }
  /** 改多重采样数（0 = 关抗锯齿）。渲染目标要重新分配，下一帧生效。 */
  setSamples(n) {
    n = Math.max(0, n | 0);
    if (n === this.samples) return;
    this.samples = n; this.rt.samples = n; this.rt.dispose();
  }
  render(renderer, writeBuffer /*, readBuffer */) {
    const prevAuto = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);
    renderer.autoClear = prevAuto;
  }
  dispose() { this.rt.dispose(); this.copyMat.dispose(); this.fsq.dispose(); }
}

// 两个 Pass 共用的相机重建 uniform。
//
// 陷阱：OrthographicCamera.left/right/top/bottom 是【视口像素】尺寸，不是实际生效的
// 视锥——three.js 的 updateProjectionMatrix()（见 vendor/three.module.js 对应实现）
// 会先按 camera.zoom 把这四个值缩放一遍才拿去建投影矩阵：
//   effLeft = cx - (right-left)/(2*zoom)，effRight = cx + (right-left)/(2*zoom)，
//   effTop  = cy + (top-bottom)/(2*zoom)，effBottom = cy - (top-bottom)/(2*zoom)
// （cx/cy 是 left/right/top/bottom 的中点）。SSAO/描边的深度→视空间坐标重建公式
// 必须用这个【缩放后】的有效视锥，否则玩家一缩放（ThreeRenderer.syncCameraFrom 里
// camera.zoom 随缩放实时变化）AO 半径和描边就会跟着算错——直接拿 camera.left 这些
// 原始字段会在 zoom≠1 时悄悄错开，缩放到某个比例才会看出来，排查会很麻烦，这里先
// 把陷阱写死在注释里。
function cameraUniforms(camera) {
  return {
    projectionMatrix: { value: camera.projectionMatrix.clone() },
    projectionMatrixInverse: { value: camera.projectionMatrixInverse.clone() },
  };
}
function syncCameraUniforms(uniforms, camera) {
  uniforms.projectionMatrix.value.copy(camera.projectionMatrix);
  uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
}

// 深度 → 视空间位置重建。透视相机（现在的主相机）与正交相机通用：直接用投影逆矩阵，
// 不再按正交视锥的 left/right/top/bottom 线性插值（那套只对正交成立，透视相机下 1/z 的双曲
// 关系必须经过透视除法）。
const RECONSTRUCT_GLSL = `
  uniform sampler2D tDepth;
  uniform mat4 projectionMatrix;
  uniform mat4 projectionMatrixInverse;

  vec3 reconstructViewPos(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 v = projectionMatrixInverse * clip;
    return v.xyz / v.w;
  }
  vec2 projectToUv(vec3 viewPos) {
    vec4 c = projectionMatrix * vec4(viewPos, 1.0);
    return c.xy / c.w * 0.5 + 0.5;
  }
`;

// ==================== SSAO ====================
// docs 第 2 节："低多边形场景对 AO 极其敏感"。半球核采样的标准做法：以每个像素的
// 视空间法线为轴撑出一个半球，采样几个邻近点，比较"采样点本该有的深度"与"那个
// 屏幕位置实际渲染出来的深度"——如果实际深度更靠近摄像机，说明采样点被挡住了，
// 累积遮蔽率。核数量给到 12（低多边形场景不需要电影级精度，12 个足够消除明显的
// 条纹感，同时对同屏两三百个单位的场景保留性能余量）。
const SSAO_KERNEL_SIZE = 12;
// 采样核和噪声图用固定种子生成。原来每次刷新页面都随机生成，AO 的颗粒次次不同，
// 而且谁先消耗了随机数会改变它——截图对比工具因此分不清"画面真的变了"还是"只是随机核换了"。
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function buildSSAOKernel() {
  const rnd = seededRandom(1013);
  const kernel = [];
  for (let i = 0; i < SSAO_KERNEL_SIZE; i++) {
    // 半球分布（z ∈ [0,1]，不是球面）+ 越靠近核心权重越大的加速插值——SSAO 的经典配方，
    // 让采样点更集中在离原点近的地方，减少大半径下的漏光。
    let v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd());
    v.normalize();
    let scale = i / SSAO_KERNEL_SIZE;
    scale = 0.1 + 0.9 * scale * scale; // lerp(0.1, 1.0, scale^2)
    v.multiplyScalar(scale);
    kernel.push(v);
  }
  return kernel;
}
// 4x4 噪声图：给每个像素的采样核一个随机旋转，把"固定核方向"产生的条带纹理打散成
// 高频噪点（后面 FXAA/降噪不需要专门处理，屏幕分辨率下人眼几乎看不出网格噪声）。
function buildNoiseTexture() {
  const size = 4;
  const data = new Float32Array(size * size * 4);
  const rnd = seededRandom(2027);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rnd() * 2 - 1;
    data[i * 4 + 1] = rnd() * 2 - 1;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const SSAO_AO_FRAG = `
    varying vec2 vUv;
    uniform vec2 texel;
    uniform sampler2D tNoise;
    uniform vec3 kernel[${SSAO_KERNEL_SIZE}];
    uniform vec2 noiseScale;
    uniform float radius;
    uniform float bias;
    uniform float power;
    ${RECONSTRUCT_GLSL}
    void main() {
      float depth = texture2D(tDepth, vUv).x;
      if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }
      vec3 viewPos = reconstructViewPos(vUv, depth);
      // 法线由深度重建：左右 / 上下各取离本像素更近（深度差更小）的那一侧做差分，避免跨物体边缘时法线翻掉
      vec3 pr = reconstructViewPos(vUv + vec2(texel.x, 0.0), texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x) - viewPos;
      vec3 pl = viewPos - reconstructViewPos(vUv - vec2(texel.x, 0.0), texture2D(tDepth, vUv - vec2(texel.x, 0.0)).x);
      vec3 pu = reconstructViewPos(vUv + vec2(0.0, texel.y), texture2D(tDepth, vUv + vec2(0.0, texel.y)).x) - viewPos;
      vec3 pd = viewPos - reconstructViewPos(vUv - vec2(0.0, texel.y), texture2D(tDepth, vUv - vec2(0.0, texel.y)).x);
      vec3 ddx = abs(pr.z) < abs(pl.z) ? pr : pl, ddy = abs(pu.z) < abs(pd.z) ? pu : pd;
      vec3 normal = normalize(cross(ddx, ddy));
      vec3 randomVec = normalize(vec3(texture2D(tNoise, vUv * noiseScale).xy, 0.0));
      vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
      vec3 bitangent = cross(normal, tangent);
      mat3 TBN = mat3(tangent, bitangent, normal);
      float occlusion = 0.0;
      for (int i = 0; i < ${SSAO_KERNEL_SIZE}; i++) {
        vec3 samplePos = viewPos + (TBN * kernel[i]) * radius;
        vec2 sampleUv = projectToUv(samplePos);
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
        float sceneViewZ = reconstructViewPos(sampleUv, texture2D(tDepth, sampleUv).x).z;
        float rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(viewPos.z - sceneViewZ), 0.0001));
        occlusion += (sceneViewZ >= samplePos.z + bias ? 1.0 : 0.0) * rangeCheck;
      }
      float ao = 1.0 - occlusion / float(${SSAO_KERNEL_SIZE});
      gl_FragColor = vec4(vec3(pow(ao, power)), 1.0);
    }
`;
const SSAO_BLUR_FRAG = `
    varying vec2 vUv; uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 dir;
    void main() {
      float w[5]; w[0]=0.227; w[1]=0.195; w[2]=0.122; w[3]=0.054; w[4]=0.016;
      float d0 = texture2D(tDepth, vUv).x;
      float s = texture2D(tAO, vUv).r * w[0], n = w[0];
      for (int i = 1; i < 5; i++) {
        vec2 o = dir * float(i);
        // 深度差太大的邻居不参与（不把前景的遮蔽糊到背景上）
        float d1 = texture2D(tDepth, vUv + o).x, d2 = texture2D(tDepth, vUv - o).x;
        float k1 = abs(d1 - d0) < 0.002 ? w[i] : 0.0, k2 = abs(d2 - d0) < 0.002 ? w[i] : 0.0;
        s += texture2D(tAO, vUv + o).r * k1 + texture2D(tAO, vUv - o).r * k2; n += k1 + k2;
      }
      gl_FragColor = vec4(vec3(s / n), 1.0);
    }
`;
const SSAO_COMP_FRAG = `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform sampler2D tAO; uniform float aoStrength;
    void main() { vec4 c = texture2D(tDiffuse, vUv); float ao = mix(1.0, texture2D(tAO, vUv).r, aoStrength); gl_FragColor = vec4(c.rgb * ao, c.a); }
`;
const FSQ_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * SSAO：半分辨率算遮蔽 → 深度感知的两向模糊 → 乘回主画面。
 * 深度来自 ScenePass 的主渲染，法线由深度重建（不再有单独的法线预渲染）。半径按世界单位给（CONFIG.postfx.ssao）。
 */
class SSAOPass extends Pass {
  constructor(scenePass, camera, width, height) {
    super();
    this.camera = camera; this.scenePass = scenePass;
    const c = CONFIG.postfx?.ssao || {};
    this.scaleDiv = c.halfRes === false ? 1 : 2;
    const hw = Math.max(1, Math.floor(width / this.scaleDiv)), hh = Math.max(1, Math.floor(height / this.scaleDiv));
    const rtOpt = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.aoRT = new THREE.WebGLRenderTarget(hw, hh, rtOpt);
    this.blurRT = new THREE.WebGLRenderTarget(hw, hh, rtOpt);
    this.aoMat = new THREE.ShaderMaterial({ uniforms: {
      texel: { value: new THREE.Vector2(1 / Math.max(1, width), 1 / Math.max(1, height)) }, tDepth: { value: scenePass.depthTexture },
      tNoise: { value: buildNoiseTexture() }, kernel: { value: buildSSAOKernel() },
      noiseScale: { value: new THREE.Vector2(hw / 4, hh / 4) },
      radius: { value: c.radius ?? 16 }, bias: { value: c.bias ?? 0.5 }, power: { value: c.power ?? 1.5 },
      ...cameraUniforms(camera),
    }, vertexShader: FSQ_VERT, fragmentShader: SSAO_AO_FRAG });
    this.blurMat = new THREE.ShaderMaterial({ uniforms: { tAO: { value: null }, tDepth: { value: scenePass.depthTexture }, dir: { value: new THREE.Vector2() } }, vertexShader: FSQ_VERT, fragmentShader: SSAO_BLUR_FRAG });
    this.compMat = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, tAO: { value: null }, aoStrength: { value: c.strength ?? 0.8 } }, vertexShader: FSQ_VERT, fragmentShader: SSAO_COMP_FRAG });
    this.fsq = new FullScreenQuad(this.aoMat);
    this.hw = hw; this.hh = hh;
    this.uniforms = this.aoMat.uniforms;   // 外部按 CONFIG 调参时走这个
  }
  _syncCamera() { syncCameraUniforms(this.aoMat.uniforms, this.camera); }
  setSize(w, h) {
    this.hw = Math.max(1, Math.floor(w / this.scaleDiv)); this.hh = Math.max(1, Math.floor(h / this.scaleDiv));
    this.aoRT.setSize(this.hw, this.hh); this.blurRT.setSize(this.hw, this.hh);
    this.aoMat.uniforms.noiseScale.value.set(this.hw / 4, this.hh / 4);
    this.aoMat.uniforms.texel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }
  render(renderer, writeBuffer, readBuffer) {
    this.fsq.material = this.aoMat; renderer.setRenderTarget(this.aoRT); this.fsq.render(renderer);
    this.fsq.material = this.blurMat;
    this.blurMat.uniforms.tAO.value = this.aoRT.texture; this.blurMat.uniforms.dir.value.set(1 / this.hw, 0); renderer.setRenderTarget(this.blurRT); this.fsq.render(renderer);
    this.blurMat.uniforms.tAO.value = this.blurRT.texture; this.blurMat.uniforms.dir.value.set(0, 1 / this.hh); renderer.setRenderTarget(this.aoRT); this.fsq.render(renderer);
    this.fsq.material = this.compMat; this.compMat.uniforms.tDiffuse.value = readBuffer.texture; this.compMat.uniforms.tAO.value = this.aoRT.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsq.render(renderer);
  }
}

export function createSSAOPass(scenePass, camera, width, height) {
  return new SSAOPass(scenePass, camera, width, height);
}

// ==================== Q4 天气重做：伪体积雾 ====================
// 任务 #178："高度雾 + 世界空间噪声 + 深度衰减"。三个词分别对应下面 shader 里的
// 三段乘法因子：
//   heightFactor —— 越贴近地面越浓，随世界坐标 Y 指数衰减（"高度雾"）；
//   distFactor   —— 看得越深（视空间 -z 越大）雾越厚，经典 Beer-Lambert 指数吸收；
//   noise        —— 用重建出的【世界坐标 XZ】去采样噪声图，不是屏幕 UV。
// 最后一点是关键：docs/Q4-WEATHER-REDESIGN.md 明确点过"screen-space 噪声会在镜头
// 平移/缩放时让雾团贴着屏幕滑，穿帮"——这里的噪声采样坐标是世界坐标，摄像机怎么移、
// 雾团都焊在世界里不动，只有 noiseOffset（按真实时间缓慢累加）会让雾自己缓慢"呼吸"，
// 和镜头运动无关。
//
// 深度用 ScenePass 的主渲染深度；世界坐标由 viewMatrixInverse（即 camera.matrixWorld）
// 把重建出的视空间坐标转回去。
// 噪声贴图见 fogNoise.js（可平铺的平滑分形噪声；原来的 64² 纯随机值噪声放大后是方块 + 细颗粒，看着粗糙）。

const FogShader = {
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNoise;
    uniform mat4 viewMatrixInverse;
    uniform vec3 fogColor;
    uniform float fogStrength;     // 0..1，外部按雾天充能每帧写入；<=0 时整个 pass 等于直通
    uniform float baseHeight;      // 世界 Y，雾"根部"高度
    uniform float heightFalloff;   // 越大雾层越薄越贴地
    uniform float density;         // 距离（视空间深度）衰减系数
    uniform float noiseScale;      // 世界空间噪声频率
    uniform float noiseStrength;   // 噪声对浓度的调制幅度，0=纯均匀雾
    uniform vec2 noiseOffset;      // 随真实时间缓慢累加，让雾团"呼吸"（与镜头运动无关）
    uniform vec2 noiseStretch;     // 世界空间噪声采样的各向异性拉伸（霾潮 Signature 用，默认(1,1)）
    uniform float uvWobble;        // >0 时对场景采样做轻微 UV 位移，热浪扭曲感（蜃景 Signature）
    uniform vec2 coverage;         // 噪声 → 浓度的阈值区间：低于 x 几乎无雾（留出淡区），高于 y 满浓
    uniform float warpStrength;    // 域扭曲强度：把雾团拉成丝缕
    uniform float heightJitter;    // 雾顶随噪声起伏的高度（世界单位），不再是一刀切的平顶
    uniform float litBoost;        // 浓处提亮（厚雾更亮一点，有体积感）
    ${RECONSTRUCT_GLSL}
    float fogHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      // 蜃景 Signature：用噪声纹理再采样一次，对场景采样做极轻微的 UV 位移，
      // 不是真实物理折射，只是让远景产生微弱波动——uvWobble<=0 时完全等同直采样。
      vec2 sampleUv = vUv;
      if (uvWobble > 0.0001) {
        vec2 wn = texture2D(tNoise, vUv * 6.0 + noiseOffset * 0.5).xy - 0.5;
        sampleUv += wn * uvWobble * 0.01;
      }
      vec4 base = texture2D(tDiffuse, sampleUv);
      if (fogStrength <= 0.0001) { gl_FragColor = base; return; }

      float depth = texture2D(tDepth, vUv).x;
      if (depth >= 1.0) { gl_FragColor = base; return; } // 天空不参与，天空自己的染色走 DayNight

      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec3 worldPos = (viewMatrixInverse * vec4(viewPos, 1.0)).xyz;

      // 世界空间分形噪声（fogNoise.js）：域扭曲 + 两层反向流动 + 高频细节。
      // 大雾团是几百个世界单位的尺度，中间留出淡区；丝缕随风慢慢流。
      vec2 p = worldPos.xz * noiseScale;
      vec2 warp = (texture2D(tNoise, p * 0.61 + noiseOffset * 0.7).gb - 0.5) * warpStrength;
      float n1 = texture2D(tNoise, (p + warp) * noiseStretch + noiseOffset).r;
      float n2 = texture2D(tNoise, (p * 2.07 - warp * 0.6) * noiseStretch - noiseOffset * 1.37 + vec2(0.37, 0.11)).r;
      float det = texture2D(tNoise, p * 7.0 + noiseOffset * 2.3).b;
      float nRaw = n1 * 0.62 + n2 * 0.38;
      float n = smoothstep(coverage.x, coverage.y, nRaw) * (0.82 + 0.36 * det);
      float noise = mix(1.0, n * 1.35, clamp(noiseStrength, 0.0, 1.0));

      // 雾顶随噪声起伏：浓的地方雾层更高
      float h = max(0.0, worldPos.y - baseHeight - n * heightJitter);
      float heightFactor = exp(-h * heightFalloff);

      float dist = max(0.0, -viewPos.z);
      float distFactor = 1.0 - exp(-dist * density);

      float amount = clamp(heightFactor * distFactor * noise * fogStrength, 0.0, 1.0);
      amount = clamp(amount + (fogHash(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0), 0.0, 1.0);   // 抖动，去色带
      vec3 fc = fogColor * (1.0 - litBoost * 0.5 + litBoost * n);
      vec3 col = mix(base.rgb, fc, amount);
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export function createFogPass(scenePass, camera, width, height) {
  const shader = {
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      tNoise: { value: null },
      viewMatrixInverse: { value: new THREE.Matrix4() },
      fogColor: { value: new THREE.Color(0xc9d4de) },
      fogStrength: { value: 0 },
      baseHeight: { value: 0 },
      heightFalloff: { value: 0.006 },
      density: { value: 0.00028 },
      noiseScale: { value: 0.004 },
      noiseStrength: { value: 0.5 },
      noiseOffset: { value: new THREE.Vector2(0, 0) },
      noiseStretch: { value: new THREE.Vector2(1, 1) },
      uvWobble: { value: 0 },
      coverage: { value: new THREE.Vector2(0.32, 0.72) },
      warpStrength: { value: 0.35 },
      heightJitter: { value: 40 },
      litBoost: { value: 0.18 },
      ...cameraUniforms(camera),
    },
    vertexShader: FogShader.vertexShader,
    fragmentShader: FogShader.fragmentShader,
  };
  const pass = new ShaderPass(shader);
  pass.uniforms.tDepth.value = scenePass.depthTexture;
  pass.uniforms.tNoise.value = fogNoiseTexture();
  // 观感参数全部走 CONFIG.volumetricFog（第 2 条铁律，与 CONFIG.outline 同级），
  // 改配置即可，不用动着色器。
  const c = CONFIG.volumetricFog || {};
  if (c.color !== undefined) pass.uniforms.fogColor.value.set(c.color);
  if (c.baseHeight !== undefined) pass.uniforms.baseHeight.value = c.baseHeight;
  if (c.heightFalloff !== undefined) pass.uniforms.heightFalloff.value = c.heightFalloff;
  if (c.density !== undefined) pass.uniforms.density.value = c.density;
  if (c.noiseScale !== undefined) pass.uniforms.noiseScale.value = c.noiseScale;
  if (c.noiseStrength !== undefined) pass.uniforms.noiseStrength.value = c.noiseStrength;
  if (c.coverage) pass.uniforms.coverage.value.set(c.coverage[0], c.coverage[1]);
  if (c.warpStrength !== undefined) pass.uniforms.warpStrength.value = c.warpStrength;
  if (c.heightJitter !== undefined) pass.uniforms.heightJitter.value = c.heightJitter;
  if (c.litBoost !== undefined) pass.uniforms.litBoost.value = c.litBoost;
  const maxStrength = c.maxStrength ?? 0.8;
  const noiseSpeed = c.noiseSpeed ?? 4;
  // v54 §9.3：雾-风联动——风越大流速越快。风目前只有强度没有方向，这轮做不了
  // 真正的定向雾带，只做"整体流速跟风充能走"。windBoostFactor=2 时满风充能约
  // 3 倍速（1 + 1*2）。
  const windBoostFactor = c.windBoostFactor ?? 2;
  const offsetAccum = new THREE.Vector2(0, 0);
  let extraStrengthMul = 1; // 浓雾 Signature：maxStrength 临时抬高的乘数
  // 相机是正交、无父节点的独立对象，updateMatrixWorld() 只是一次 4x4 矩阵乘法，
  // 显式调用一次确保这里读到的是【本帧】的相机变换，不依赖 composer 内部渲染顺序
  // 恰好已经刷新过它（那份先后关系容易被下一次管线调整悄悄打破）。
  pass._syncCamera = () => {
    syncCameraUniforms(pass.uniforms, camera);
    camera.updateMatrixWorld(true);
    pass.uniforms.viewMatrixInverse.value.copy(camera.matrixWorld);
  };
  pass._advanceNoise = (dt, windCharge = 0) => {
    const speed = noiseSpeed * (1 + Math.max(0, Math.min(1, windCharge)) * windBoostFactor);
    offsetAccum.x += speed * dt * 0.00037;
    offsetAccum.y += speed * dt * 0.00021;
    pass.uniforms.noiseOffset.value.copy(offsetAccum);
  };
  // 强度输入是 0..1（天气充能），乘 maxStrength 之后才是着色器实际吃的浓度系数——
  // 满充能也不该把整个画面糊死，maxStrength 就是这个视觉上限的软编码入口。
  pass.setStrength = (v) => { pass.uniforms.fogStrength.value = Math.max(0, Math.min(1, v || 0)) * maxStrength * extraStrengthMul; };
  // 浓雾 Signature（maxFogStrength）：临时把浓度上限抬高，超出日常水位。
  pass.setMaxStrengthMul = (mul) => { extraStrengthMul = mul || 1; };
  // 蜃景 Signature（fogUvWobble）：0..1，>0 时场景采样做轻微 UV 位移，热浪扭曲感。
  pass.setUvWobble = (v) => { pass.uniforms.uvWobble.value = Math.max(0, v || 0); };
  // 霾潮 Signature（directionalFog）：噪声在固定方向被拉伸，折中版"方向感"
  // （真实风向数据接入前的近似）。stretch<=1 时退回各向同性。
  pass.setNoiseStretch = (stretch) => {
    const s = Math.max(1, stretch || 1);
    // 沿流动方向（_advanceNoise 主要往 +x 推）拉长：x 方向频率降、z 方向频率升 → 横向的一股股流带。
    // 反过来拉（s, 1/s）会得到和流动方向垂直的竖条，像帘子不像被风吹。
    pass.uniforms.noiseStretch.value.set(1 / s, s);
  };
  // 沙暴 Signature（sandstormReversal）：雾通道复用成土黄色沙尘层——沙暴没有自己
  // 独立的体积渲染层，颜色可以随时切回默认雾色。
  pass.setColor = (hex) => { pass.uniforms.fogColor.value.set(hex); };
  pass.setSize = () => {}; // 世界空间效果的浓度/频率与像素分辨率无关，占位保持接口一致
  return pass;
}

export { ScenePass };
