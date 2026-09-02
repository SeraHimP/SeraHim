/**
 * PostFX.js —— 轮廓描边 + SSAO（Week2·Day8-10）
 *
 * docs/Q4-RENDERING-REDESIGN.md 第 2 节判断依据：低多边形场景对描边/AO 极其敏感，
 * 这两样是"从塑料感变成有实体感"的关键两步。两个效果都要知道"哪里是边缘/哪里被
 * 遮挡"，靠的是同一份【视空间法线 + 深度】数据，所以共用同一个预渲染 Pass
 * （NormalDepthPrepass）：拿场景的 overrideMaterial 换成法线材质，额外渲染一遍到
 * 独立的渲染目标，不进 EffectComposer 的主色彩链（needsSwap=false，纯粹产出一份
 * 供后面两个 Pass 采样的纹理）。
 *
 * 摄像机是正交（ThreeRenderer 用 OrthographicCamera），深度和视空间坐标的重建比
 * 透视相机简单得多——正交投影下深度是【线性】的，且同一像素的视空间 X/Y 与深度
 * 无关（不需要透视除法），这里的重建公式全按正交推的，不能照抄透视相机那一套。
 *
 * 跟随现有 setBloom/setFXAA/setShadowLevel 的先例：两个效果都做成可独立开关的档位，
 * 关掉时对帧时间零影响（NormalDepthPrepass 也会跟着两个开关一起短路，不白渲染）。
 */
import * as THREE from '../../vendor/three.module.js';
import { Pass } from '../../vendor/postprocessing/Pass.js';
import { ShaderPass } from '../../vendor/postprocessing/ShaderPass.js';

// ==================== 法线+深度预渲染 Pass ====================
class NormalDepthPrepass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false; // 只产出纹理供后面的 Pass 采样，不参与主色彩链的读写交换
    this.clear = false;
    this._normalMaterial = new THREE.MeshNormalMaterial(); // 编码的是【视空间】法线，SSAO/描边都要这个口径
    this.renderTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(width, height),
    });
    this.renderTarget.texture.name = 'NormalDepthPrepass.normal';
  }

  setSize(width, height) {
    this.renderTarget.setSize(width, height);
    this.renderTarget.depthTexture.image.width = width;
    this.renderTarget.depthTexture.image.height = height;
  }

  render(renderer /*, writeBuffer, readBuffer */) {
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const prevBackground = this.scene.background;
    this.scene.overrideMaterial = this._normalMaterial;
    this.scene.background = null; // 背景色不该被当成"某个物体的法线"参与边缘/遮蔽判定
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.renderTarget.dispose();
    this._normalMaterial.dispose();
  }
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
function effectiveOrthoBounds(camera) {
  const cx = (camera.right + camera.left) / 2, cy = (camera.top + camera.bottom) / 2;
  const dx = (camera.right - camera.left) / (2 * camera.zoom);
  const dy = (camera.top - camera.bottom) / (2 * camera.zoom);
  return { left: cx - dx, right: cx + dx, top: cy + dy, bottom: cy - dy };
}
function cameraUniforms(camera) {
  const b = effectiveOrthoBounds(camera);
  return {
    cameraNear: { value: camera.near },
    cameraFar: { value: camera.far },
    orthoLeft: { value: b.left },
    orthoRight: { value: b.right },
    orthoTop: { value: b.top },
    orthoBottom: { value: b.bottom },
  };
}
function syncCameraUniforms(uniforms, camera) {
  const b = effectiveOrthoBounds(camera);
  uniforms.cameraNear.value = camera.near;
  uniforms.cameraFar.value = camera.far;
  uniforms.orthoLeft.value = b.left;
  uniforms.orthoRight.value = b.right;
  uniforms.orthoTop.value = b.top;
  uniforms.orthoBottom.value = b.bottom;
}

// 正交相机深度/位置重建——两个 shader 都要用，写成 GLSL 片段字符串直接拼进各自的
// fragmentShader 里（GLSL 没有跨文件 import，这是本仓库其它 vendor shader 一贯的
// 做法：需要复用的函数体作为字符串拼接）。
const ORTHO_RECONSTRUCT_GLSL = `
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float orthoLeft;
  uniform float orthoRight;
  uniform float orthoTop;
  uniform float orthoBottom;

  // 正交投影下深度是线性的：depth=0 是近裁面，depth=1 是远裁面，直接线性插值，
  // 不像透视相机那样需要处理 1/z 的双曲线关系。
  float viewZFromDepth(float depth) {
    return -(cameraNear + depth * (cameraFar - cameraNear));
  }

  // 正交投影下同一像素的视空间 X/Y 与深度无关（所有光线互相平行），
  // 直接由 UV 在视锥宽高上线性插值即可，不需要透视除法。
  vec3 reconstructViewPos(vec2 uv, float depth) {
    float x = mix(orthoLeft, orthoRight, uv.x);
    float y = mix(orthoBottom, orthoTop, uv.y);
    return vec3(x, y, viewZFromDepth(depth));
  }
`;

// ==================== SSAO ====================
// docs 第 2 节："低多边形场景对 AO 极其敏感"。半球核采样的标准做法：以每个像素的
// 视空间法线为轴撑出一个半球，采样几个邻近点，比较"采样点本该有的深度"与"那个
// 屏幕位置实际渲染出来的深度"——如果实际深度更靠近摄像机，说明采样点被挡住了，
// 累积遮蔽率。核数量给到 12（低多边形场景不需要电影级精度，12 个足够消除明显的
// 条纹感，同时对同屏两三百个单位的场景保留性能余量）。
const SSAO_KERNEL_SIZE = 12;
function buildSSAOKernel() {
  const kernel = [];
  for (let i = 0; i < SSAO_KERNEL_SIZE; i++) {
    // 半球分布（z ∈ [0,1]，不是球面）+ 越靠近核心权重越大的加速插值——SSAO 的经典配方，
    // 让采样点更集中在离原点近的地方，减少大半径下的漏光。
    let v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random());
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
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.random() * 2 - 1;
    data[i * 4 + 1] = Math.random() * 2 - 1;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// 只保存 shader 源码，uniforms 的默认值由 createSSAOPass() 按传入的相机/尺寸现建
// （半径/容差/强度这几个默认值写在那边，跟这里不重复维护一份）。
const SSAOShader = {
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
    uniform sampler2D tNormal;
    uniform sampler2D tNoise;
    uniform vec3 kernel[${SSAO_KERNEL_SIZE}];
    uniform vec2 noiseScale;
    uniform float radius;
    uniform float bias;
    uniform float aoStrength;
    ${ORTHO_RECONSTRUCT_GLSL}

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).x;
      if (depth >= 1.0) { gl_FragColor = base; return; } // 天空/背景不参与

      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
      vec3 randomVec = normalize(vec3(texture2D(tNoise, vUv * noiseScale).xy, 0.0));

      vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
      vec3 bitangent = cross(normal, tangent);
      mat3 TBN = mat3(tangent, bitangent, normal);

      float occlusion = 0.0;
      for (int i = 0; i < ${SSAO_KERNEL_SIZE}; i++) {
        vec3 samplePos = viewPos + (TBN * kernel[i]) * radius;
        // 正交投影：视空间点 → UV 是纯线性映射，不需要透视除法。
        vec2 sampleUv = vec2(
          (samplePos.x - orthoLeft) / (orthoRight - orthoLeft),
          (samplePos.y - orthoBottom) / (orthoTop - orthoBottom)
        );
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
        float sampleDepth = texture2D(tDepth, sampleUv).x;
        float sceneViewZ = viewZFromDepth(sampleDepth);
        // sceneViewZ 更靠近 0（更靠近摄像机）说明那个屏幕位置真正渲染出来的东西
        // 比采样点更近——采样点被挡住了。rangeCheck 避免"远处不相关的物体"误判。
        float rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(viewPos.z - sceneViewZ), 0.0001));
        occlusion += (sceneViewZ >= samplePos.z + bias ? 1.0 : 0.0) * rangeCheck;
      }
      occlusion = 1.0 - (occlusion / float(${SSAO_KERNEL_SIZE}));
      occlusion = mix(1.0, occlusion, aoStrength);
      gl_FragColor = vec4(base.rgb * occlusion, base.a);
    }
  `,
};

export function createSSAOPass(prepass, camera, width, height) {
  // ShaderPass 构造时会自己 UniformsUtils.clone 一遍这份 uniforms（含 kernel 这个
  // Vector3 数组——clone 对有 .clone() 方法的元素会逐个深拷贝），这里不用重复克隆。
  const shader = {
    uniforms: {
      tDiffuse: { value: null },
      tNormal: { value: null },
      tDepth: { value: null },
      tNoise: { value: null },
      kernel: { value: buildSSAOKernel() },
      noiseScale: { value: new THREE.Vector2(width / 4, height / 4) },
      radius: { value: 60 },
      bias: { value: 2 },
      aoStrength: { value: 0.65 },
      ...cameraUniforms(camera),
    },
    vertexShader: SSAOShader.vertexShader,
    fragmentShader: SSAOShader.fragmentShader,
  };
  const pass = new ShaderPass(shader);
  pass.uniforms.tNormal.value = prepass.renderTarget.texture;
  pass.uniforms.tDepth.value = prepass.renderTarget.depthTexture;
  pass.uniforms.tNoise.value = buildNoiseTexture();
  pass.uniforms.noiseScale.value.set(width / 4, height / 4);
  pass._syncCamera = () => syncCameraUniforms(pass.uniforms, camera);
  pass.setSize = (w, h) => { pass.uniforms.noiseScale.value.set(w / 4, h / 4); };
  return pass;
}

// ==================== 轮廓描边 ====================
// 深度 + 法线双路 Sobel 边缘检测：深度突变抓外轮廓（单位与背景/地形的分界），
// 法线突变抓内部折角（塔身的棱、雉堞冠的转角）——只用深度会漏掉同一个物体内部
// 该有描边的硬拐角，只用法线会漏掉两个深度接近但确实前后叠着的物体的分界。
const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    outlineColor: { value: new THREE.Color(0x1a1410) }, // 暖黑（呼应现有塔灯暖光调性，不用冷纯黑）
    // depthBias 踩过一个坑：相机 near=1/far=60000（见 ThreeRenderer.syncCameraFrom），
    // 但场景内容实际只占其中很小一段（近似几千个世界单位内），深度缓冲的精度被
    // 这段"浪费在空气里"的巨大 far 挤占——调低这个阈值想多抓边缘，结果在完全平坦
    // 的地面上也测出大量深度量化噪声（一片小黑点/十字紊纹）。这里调回更保守的值，
    // 平坦地面的深度噪声压不过阈值、真正的轮廓（大深度跳变）仍然稳稳过线；内部折角
    // 主要靠下面法线检测抓，法线不受深度精度问题影响。
    depthBias: { value: 0.003 },
    normalBias: { value: 0.35 },
    outlineStrength: { value: 0.85 },
    lineWidth: { value: 1.6 }, // 采样偏移的像素倍数——1.0 太细，2.5D 缩小视角下几乎看不见
  },
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
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform vec3 outlineColor;
    uniform float depthBias;
    uniform float normalBias;
    uniform float outlineStrength;
    uniform float lineWidth;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 texel = (1.0 / resolution) * lineWidth;

      float d0 = texture2D(tDepth, vUv).x;
      float dx = texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x - texture2D(tDepth, vUv - vec2(texel.x, 0.0)).x;
      float dy = texture2D(tDepth, vUv + vec2(0.0, texel.y)).x - texture2D(tDepth, vUv - vec2(0.0, texel.y)).x;
      float depthEdge = step(depthBias, length(vec2(dx, dy)));

      vec3 n0 = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
      vec3 nx = normalize(texture2D(tNormal, vUv + vec2(texel.x, 0.0)).xyz * 2.0 - 1.0);
      vec3 ny = normalize(texture2D(tNormal, vUv + vec2(0.0, texel.y)).xyz * 2.0 - 1.0);
      float normalEdge = step(normalBias, (1.0 - dot(n0, nx)) + (1.0 - dot(n0, ny)));

      // 天空/背景（depth≈1）不描边，否则整个地平线会被画一圈线。
      float sky = step(0.999, d0);
      float edge = max(depthEdge, normalEdge) * (1.0 - sky);

      vec3 col = mix(base.rgb, outlineColor, edge * outlineStrength);
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export function createOutlinePass(prepass, width, height) {
  const pass = new ShaderPass(OutlineShader);
  pass.uniforms.tNormal.value = prepass.renderTarget.texture;
  pass.uniforms.tDepth.value = prepass.renderTarget.depthTexture;
  pass.uniforms.resolution.value.set(width, height);
  pass.setSize = (w, h) => { pass.uniforms.resolution.value.set(w, h); };
  return pass;
}

export { NormalDepthPrepass };
