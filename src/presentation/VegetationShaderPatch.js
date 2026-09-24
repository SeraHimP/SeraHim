/**
 * VegetationShaderPatch.js —— 植被材质的统一 shader 注入点（Phase 2：风吹植被）
 *
 * ==================== 为什么要单开一个文件 ====================
 * 这个仓库的渲染层已经有好几处会碰材质/shader（SSAO、描边、天气、地形……），如果
 * "风吹树"这一条也直接在 VegetationLayer.js 里就地 onBeforeCompile 一次，以后
 * 任何人想再给植被材质加点什么（比如别的天气效果、别的动画）都会各自再插一次，
 * 最后没人敢动这份 shader。统一收在这一个文件里：谁要往植被材质里塞东西，从这里
 * 过，不允许散着写第二份。
 *
 * ==================== 怎么让树"看起来在被风吹" ====================
 * 只改 position，不搭真正的骨骼/矩阵旋转（用户的树是低多边形程序化几何，犯不上）：
 *   - 弯曲量正比于【局部高度】的平方（height²）——height 取 0~1（顶点 y ÷ 树高），
 *     平方是为了让根部（height 小）几乎不动、树冠顶部（height 接近1）摆得最明显，
 *     不是整棵树刚体平移。
 *   - 每棵树的相位（instancePhase）来自树的世界坐标哈希，不是实例数组下标——
 *     VegetationLayer.build() 按 (gx, gy) 网格扫描顺序把树推进数组，下标本身
 *     跟"从左到右、从上到下"的扫描顺序强相关，直接拿下标当相位会在画面上显出
 *     一条"按顺序摆动"的假规律（一波接一波地摆，像广播体操而不是森林被风吹）。
 *   - 法线做一个廉价的线性近似偏移（不是真的重新算旋转矩阵），让亮面跟着摆——
 *     没有这一步，flatShading 关闭的材质（本项目"默认"调色板分支用的就是这种）
 *     会出现"树在晃、亮面纹丝不动"的割裂感。flatShading 开启的材质（"风格化"
 *     调色板分支）本来就是从屏幕空间深度导数现算法线，position 一变法线自动跟着
 *     对，这一步对它是免费的、不会重复计算出错。
 *
 * ==================== 只碰 position（局部空间），不碰 instanceMatrix 之后的部分 ====
 * 注入点选在 <begin_vertex>/<beginnormal_vertex> 之后——这两个 chunk 之后紧跟着
 * 的 <instancing_vertex> 才会把 instanceMatrix 应用上去，所以这里改的还是【局部/
 * 物体空间】坐标，弯曲量算完之后自然跟着每棵树自己的位置/朝向/缩放一起被搬到
 * 世界空间，不用在这里操心每棵树的世界坐标是什么。
 * 两处注入各自独立从原始的 `position.y`（顶点属性本身，不依赖 chunk 执行顺序）
 * 算一遍高度比例——不共享中间变量，因为 <beginnormal_vertex> 和 <begin_vertex>
 * 谁先谁后属于 three.js 内部模板细节，不应该让这段代码依赖那个顺序。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';

const _cfg = () => (CONFIG.ui && CONFIG.ui.vegetationWindFx) || {};

// material -> { uWindTime, uWindStrength, uWindHeight, uWindMaxBend } 的登记表，
// 供 setWindStrength() 每帧统一回写，不用在每个调用点各自记住哪些材质被 patch 过。
const _registry = new Set();

/**
 * 给一个 InstancedMesh 的几何+材质注入风摆动。调用方需要先给 geometry 装好
 * 名为 instancePhase 的 InstancedBufferAttribute（一实例一个相位值，弧度）。
 * 只应该对"该摆的"几何/材质调用（树/深林树），灌木/岩石这一轮不摆——
 * 见 VegetationLayer.js 调用点的说明。
 */
export function applyWindSway(geometry, material) {
  geometry.computeBoundingBox();
  const height = Math.max(1, geometry.boundingBox?.max?.y || 50);
  const uniforms = {
    uWindTime: { value: 0 },
    uWindStrength: { value: 0 },
    uWindHeight: { value: height },
    uWindMaxBend: { value: _cfg().maxBendFactor ?? 6 },
  };
  const prevOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute float instancePhase;',
        'uniform float uWindTime;',
        'uniform float uWindStrength;',
        'uniform float uWindHeight;',
        'uniform float uWindMaxBend;',
      ].join('\n'))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float windH = clamp(position.y / uWindHeight, 0.0, 1.0);',
        'float windBend = uWindMaxBend * uWindStrength * windH * windH * sin(uWindTime + instancePhase);',
        'transformed.x += 0.82 * windBend;',
        'transformed.z += 0.57 * windBend;',
      ].join('\n'))
      .replace('#include <beginnormal_vertex>', [
        '#include <beginnormal_vertex>',
        'float windHN = clamp(position.y / uWindHeight, 0.0, 1.0);',
        'float windBendN = uWindStrength * windHN * sin(uWindTime + instancePhase);',
        'objectNormal.xz += vec2(0.82, 0.57) * windBendN * 0.6;',
        'objectNormal = normalize(objectNormal);',
      ].join('\n'));
  };
  // 角频率不写死在 GLSL 字面量里——uWindTime 由 updateWindSway() 按 dt×freq 累加，
  // shader 侧永远只是 sin(uWindTime + instancePhase)，频率完全交给 JS 侧的累加
  // 节奏决定，CONFIG 改 freq 立刻生效，不用重新编译 shader。
  material.needsUpdate = true;
  _registry.add({ material, uniforms });
}

/**
 * 每帧调用：把当前风强度写进所有已注册的植被材质。
 * @param dt      墙钟秒（暂停时风也该继续吹，跟 WeatherLayer 同口径）
 * @param strength 风的 charge（0~1）
 */
export function updateWindSway(dt, strength) {
  const freq = _cfg().freq ?? 1.6;
  for (const rec of _registry) {
    rec.uniforms.uWindTime.value += dt * freq;
    rec.uniforms.uWindStrength.value = strength;
  }
}

export function clearWindSwayRegistry() {
  _registry.clear();
}

/**
 * ==================== 积雪野区可见性修复：树/岩"落雪"（v55.1）====================
 * 用户报告野区看不到雪，根因是密密麻麻的树/岩 InstancedMesh 从俯视角度把贴地
 * 的雪盖平面挡住了（见 GroundTraceSystem.js/VegetationLayer.js 头注）。修法：
 * 让树冠/岩石按所在位置的局部雪深"落雪"——颜色朝白混一部分，不是刷成全白。
 *
 * 为什么不用 InstancedMesh 自带的 instanceColor：three.js 的内置 shader 对
 * instanceColor 的处理是【乘法】（`vColor.xyz *= instanceColor.xyz`，见
 * three.module.js 的 color_fragment chunk），乘法只能把颜色调暗，乘以白色
 * (1,1,1) 是恒等变换、乘以任何 <1 的值只会更暗——没有办法用它把一个深绿色
 * 树冠"混"向白色。往白混必须是【线性插值】（mix(color, white, t)），这不是
 * three.js 内置材质支持的组合方式，所以走跟风摆动同一条路：onBeforeCompile
 * 注入一个新的 per-instance 属性 + 一段插值。
 *
 * 与 applyWindSway 分开两个函数（不合并成一个"植被特效"大开关）：这是两条
 * 会各自演化的效果（风摆动 = 顶点位移，落雪 = 颜色混合），合并后调用点会
 * 传一堆参数去区分"这次要不要摆动/要不要落雪"，不如两个独立、按需调用的
 * 函数清楚——跟 DragonSystem.SOUL_REWARD_OK/POWER_REWARD_OK 分成两个方法而不是
 * 加布尔参数是同一个理由。
 *
 * 不用模块级注册表（跟 applyWindSway 的 _registry 不一样）：VegetationLayer 和
 * BoundaryDecorLayer 都会调这套函数，但两者各自独立 build/clear（比如设置面板
 * 单独开关"野区植被"只会调 VegetationLayer.clear()，不会碰 BoundaryDecorLayer
 * 已经建好的那批网格）——共用一个全局注册表的话，一层 clear() 会把另一层还在
 * 用的网格也从表里摘掉，之后再也不刷新，雪深就停在摘除那一刻的值，不报错但
 * 悄悄过期。改成调用方（各层的 place()）自己把 {positions} 记在
 * mesh.userData.snowPositions 上，updateSnowInstances 只对调用方明确传入的
 * 那份 mesh 列表生效，两层各管各的，互不影响。
 */
export function applySnowTint(geometry, material) {
  const prevOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute float instanceSnow;',
        'varying float vSnowAmt;',
      ].join('\n'))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vSnowAmt = instanceSnow;',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying float vSnowAmt;',
      ].join('\n'))
      // 放在 <color_fragment> 之后：先让内置的 vColor（顶点色/instanceColor 乘法）
      // 按原样跑完，落雪效果在它算出的最终 diffuseColor 基础上再往白混一层，
      // 两件事互不冲突、顺序也不影响结果（乘法与插值可以任意先后）。
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vSnowAmt);',
      ].join('\n'));
  };
  material.needsUpdate = true;
}

/**
 * 按节流间隔调用（不是每帧）：给一个已经 applySnowTint 过、且
 * mesh.userData.snowPositions 已经记好世界坐标的 InstancedMesh，把每个实例
 * 按它的坐标查一次局部雪深，写进 instanceSnow 属性（乘封顶混合比例
 * maxBlend——封顶本身发生在这里而不是 shader 里，数值软编码要能在一个地方
 * 改，不要 shader 和 JS 各存一份）。mesh 没有 snowPositions/instanceSnow 时
 * 直接跳过（不是所有网格都开了落雪效果，比如城墙石柱）。
 * @param {THREE.InstancedMesh} mesh
 * @param {(x:number, z:number) => number} sampleFn 传入世界坐标返回 0~1 局部雪深的函数
 * @param {number} maxBlend 封顶混合比例（雪深=1时的最终混合量）
 */
export function updateSnowInstances(mesh, sampleFn, maxBlend) {
  const positions = mesh?.userData?.snowPositions;
  const attr = mesh?.geometry?.getAttribute('instanceSnow');
  if (!positions || !attr) return;
  const arr = attr.array;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const depth = Math.max(0, Math.min(1, sampleFn(p.x, p.z)));
    arr[i] = depth * maxBlend;
  }
  attr.needsUpdate = true;
}
