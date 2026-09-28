/**
 * CorrosionLayer.js —— 腐蚀型武器的**立体**表现（v43 Q8 重做）
 *
 * ==================== 为什么推翻上一版 ====================
 * 上一版画的是一圈圈贴地的**同心圆环**（EffectsLayer 的 C3 段，用三角批画 2D 环）。
 * 用户定稿否掉了："射程球（立体3D，半径最大射程）常驻显示，显示为半透明类似雾那种效果，
 * 然后塔攻击（施加中毒效果时），显示为一波波向外扩散的雾（3D，遵循攻速），不要做成2D的，
 * 并且只有范围内有兵的时候在显示一波波的雾，否则只显示较淡的常驻雾区。"
 *
 * 三条语义，逐条对应到实现：
 *   ① **射程球常驻**   → 每座腐蚀塔一个半径 = 有效射程的球，低透明度长亮。
 *   ② **有兵才发波**   → 射程内有可中毒的敌人时才生成扩散波；没兵时只剩常驻球，而且更淡。
 *   ③ **遵循攻速**     → 发波间隔 = 1 / 当前攻速，与 weapon_corrosion 的叠层节奏同源
 *                        （那边也是 interval = 1/finalAS），于是"看到一波 = 叠了一层"。
 *
 * ==================== 怎么让球看起来像雾而不是塑料 ====================
 * 关键是**不写深度、双面渲染、低透明度**：
 *   · depthWrite:false —— 球不遮挡后面的东西，也不互相打架（多座塔的球会重叠）；
 *   · side:DoubleSide  —— 前后两层面都画，视线穿过球心时叠了两层 alpha，
 *                          边缘（掠射）叠得更多 → 天然的"边缘更浓"，这就是体积感的来源；
 *   · 低多边形（segments 少）+ flatShading 关掉 —— 要的是团雾不是宝石。
 * 用 MeshBasicMaterial 而不是标准材质：雾不该被光照/阴影影响，夜里也该是那个绿。
 *
 * ==================== 性能 ====================
 * 几何**全局共享**一份单位球（半径 1），每个实例只改 scale —— 加一座塔不增加几何内存。
 * 网格按需创建、按 tick 标记回收（与 UnitLayer 的 seen 机制同款），塔没了就还回池子。
 * 波的数量有硬上限（每塔 maxWaves），极端攻速下不会无限堆网格。
 *
 * 所有数值在 CONFIG.ui.corrosionFx 里，源码不留魔数。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG } from '../data/Config.js';
import { fogNoiseTexture } from './fogNoise.js';

/**
 * ==================== 2026-09-27：体积雾着色 ====================
 * 用户："腐蚀性塔的可视化弹道效果也改为体积雾的，然后每波脉冲那个雾的效果也要做出来"。
 * 上面那套（常驻射程球 / 有兵才发波 / 发波间隔 = 攻速）语义不变，换的是【质感】：
 * 球不再是一层均匀的半透明壳，而是按"视线穿过球体的厚度"累积浓度的体积雾——
 * 从球面进入点沿视线方向（正交相机，方向恒定）在球内取几点，查世界空间分形噪声（fogNoise.js，
 * 与天气雾同一张）算平均浓度，alpha = 1 - exp(-厚度 × 浓度)。于是中间厚、边缘柔、带流动的雾丝；
 * 地面以下的那段不算（视线打到地面就截断）。
 * 脉冲波用同一个着色器的"空心壳"模式：浓度只集中在一层向外扩张的壳里（uShell > 0），
 * 读起来是一圈翻涌着推出去的毒雾浪，越往外越淡。
 */
const FOG_VS = `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const FOG_FS = `
  uniform vec3 uColor; uniform float uAlpha; uniform float uDensity;
  uniform vec3 uCenter; uniform float uRadius; uniform float uGround;
  uniform vec3 uViewDir; uniform float uTime; uniform float uNoiseScale; uniform float uShell; uniform float uLow; uniform float uCore;
  uniform sampler2D tNoise;
  varying vec3 vWorld;
  float dens(vec3 q) {
    vec2 p = q.xz * uNoiseScale + vec2(q.y * 0.004, -q.y * 0.003);
    vec2 wp = (texture2D(tNoise, p * 0.7 + vec2(uTime * 0.013, uTime * 0.009)).gb - 0.5) * 0.45;
    float n = texture2D(tNoise, p + wp + vec2(-uTime * 0.021, uTime * 0.017)).r * 0.65
            + texture2D(tNoise, p * 2.3 - wp + vec2(uTime * 0.03, -uTime * 0.02)).r * 0.35;
    float d = smoothstep(0.25, 0.75, n);
    float r = length(q - uCenter) / uRadius;                      // 以水晶为心的球：雾从水晶向四周散开
    if (uLow > 0.0) d *= exp(-max(0.0, q.y - uGround) / (uRadius * uLow));   // 可选：越贴地越浓（lowK = 0 关掉）
    if (uShell > 0.0) d *= smoothstep(1.0 - uShell, 1.0 - uShell * 0.4, r) * (1.0 - smoothstep(0.92, 1.0, r));   // 雾浪：一圈外扩的环
    else d *= smoothstep(uCore, uCore + 0.25, r) * (1.0 - smoothstep(0.8, 1.0, r));   // 常驻：水晶周围一圈留空（塔身看得清），到射程边缘才淡出
    return d;
  }
  void main() {
    vec3 d = normalize(uViewDir);
    float chord = max(0.0, 2.0 * dot(uCenter - vWorld, d));
    if (d.y < -0.0001) chord = min(chord, max(0.0, (vWorld.y - uGround) / -d.y));   // 地面以下不算
    float acc = 0.0;
    for (int i = 0; i < 4; i++) acc += dens(vWorld + d * chord * (float(i) + 0.5) / 4.0);
    acc /= 4.0;
    float a = (1.0 - exp(-uDensity * acc * chord / uRadius)) * uAlpha;
    gl_FragColor = vec4(uColor * (0.85 + 0.3 * acc), a);
  }
`;

/**
 * 可被腐蚀叠层的敌方单位类型，供雾特效判断"附近有没有中毒目标"用。
 * ⚠️ 头注原话是"与 weapon_corrosion.onFrame 的过滤表保持一致"，但 v49 之后
 * 真实机制已经改走 enemyUnitsInRadius（不认白名单，只看"不是建筑"），这份表
 * 从那次改动起就已经落后了——2026-09-19 排查重装车接线时发现这份表漏了
 * 'ram'（攻城车），补上时一并补上新增的 'heavy'（重装车）。这类硬编码白名单
 * 每加一个新兵种就要回来改一次，漏了不会报错，只会表现成"毒素在扣血但雾特效
 * 没跟着亮"——跟 FactionSystem.js 头注记录的那个坑是同一个形状。
 */
const POISONABLE = ['melee', 'ranged', 'siege', 'super', 'totem', 'dragon', 'shield', 'warlock', 'corrupt', 'ram', 'heavy', 'healer', 'engineer', 'summoner'];

const cfg = () => (CONFIG.ui && CONFIG.ui.corrosionFx) || {};

export class CorrosionLayer {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    // 一份共享的单位球几何。段数走配置：默认 20×14 足够圆、面数只有 ~500。
    const c = cfg();
    this._geo = new THREE.SphereGeometry(1, c.segW ?? 20, c.segH ?? 14);
    this._per = new Map();   // 塔 id -> { dome, waves:[{mesh, t}], nextAt, seen }
    this._tick = 0;
    this._t = 0;             // 墙钟累计（暂停时雾也该继续飘 —— 与 WeatherLayer 同口径）
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) for (const rec of this._per.values()) this._hide(rec);
  }

  _hide(rec) {
    rec.dome.visible = false;
    for (const w of rec.waves) w.mesh.visible = false;
  }

  _mkMesh(color, opacity, shell = 0) {
    const c = cfg();
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) }, uAlpha: { value: opacity }, uDensity: { value: shell ? (c.waveDensity ?? 6) : (c.fogDensity ?? 4) },
        uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 }, uGround: { value: 0 },
        uViewDir: { value: new THREE.Vector3(0, -1, 0) }, uTime: { value: 0 },
        uNoiseScale: { value: c.noiseScale ?? 0.006 }, uShell: { value: shell }, tNoise: { value: fogNoiseTexture() },
        uLow: { value: c.lowK ?? 0 }, uCore: { value: c.coreClear ?? 0.12 },
      },
      vertexShader: FOG_VS, fragmentShader: FOG_FS,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    // 兼容老接口：opacity 读写转到 uAlpha（下面发波 / 常驻球的浓淡仍按 material.opacity 写）
    Object.defineProperty(mat, 'opacity', { get: () => mat.uniforms.uAlpha.value, set: (v) => { if (mat.uniforms) mat.uniforms.uAlpha.value = v; }, configurable: true });
    const m = new THREE.Mesh(this._geo, mat);
    m.renderOrder = cfg().renderOrder ?? 20;
    m.frustumCulled = false;   // 球心在塔上但半径很大，剔除盒容易误判
    this.scene.add(m);
    return m;
  }

  /** 体积雾着色器每帧要的量：球心 / 半径 / 地面高度 / 视线方向 / 时间 */
  _sync(mesh, radius, ground) {
    const u = mesh.material.uniforms;
    if (!u) return;
    u.uCenter.value.copy(mesh.position); u.uRadius.value = Math.max(1, radius); u.uGround.value = ground;
    if (this.camera) this.camera.getWorldDirection(u.uViewDir.value);
    u.uTime.value = this._t;
  }

  /**
   * @param deps { entities, attrCalc, effects }
   * @param dtWall 墙钟秒
   * @param weaponOf(tower) → 该塔当前武器技能 id（复用 EffectsLayer 的缓存版本）
   */
  update(deps, dtWall, weaponOf, crystalOf = null) {
    if (!this.enabled || !deps || !deps.entities) return;
    const c = cfg();
    if (c.enabled === false) { for (const rec of this._per.values()) this._hide(rec); return; }
    const { entities, attrCalc, effects } = deps;
    this._t += Math.min(0.1, Math.max(0, dtWall || 0));
    const tick = ++this._tick;

    const color = new THREE.Color(c.color || '#7bc96f');
    const domeIdle = c.domeAlphaIdle ?? 0.045;   // 射程内没兵：更淡的常驻雾
    const domeBusy = c.domeAlphaBusy ?? 0.085;   // 有兵：略浓（读作"正在起效"）
    const domeLerp = c.domeLerp ?? 3.0;          // 浓淡切换速率（每秒）
    const maxWaves = Math.max(1, c.maxWaves ?? 4);
    const waveLife = c.waveLife ?? 1.1;          // 一波从塔心扩到射程边缘要几秒
    const waveAlpha = c.waveAlpha ?? 0.22;
    const waveStartK = c.waveStartK ?? 0.08;     // 起始半径占射程的比例

    for (const t of entities.getAllTowers(true)) {
      if (!t.pos) continue;
      if (weaponOf(t) !== 'weapon_corrosion') continue;

      const range = (attrCalc && effects)
        ? (attrCalc.calc(t, effects.getEffects(t.id)).attackRange || 250)
        : (t.baseStats?.attackRange || 250);

      let rec = this._per.get(t.id);
      if (!rec) {
        rec = { dome: this._mkMesh(color, domeIdle), waves: [], nextAt: 0, alpha: domeIdle };
        this._per.set(t.id, rec);
      }
      rec.seen = tick;

      // ---- ① 常驻射程球 ----
      rec.dome.visible = true;
      // 圆心：塔杖顶的水晶（拿不到时退回塔脚）。雾从水晶向四周散开、脉冲从水晶往外推；
      // 半径仍是有效射程，毒圈生效范围不变（那由 weapon_corrosion 按塔的坐标判定，这里只是画面）。
      const cp = crystalOf ? crystalOf(t) : null;
      const gY = this.mapSystem?.heightAt ? this.mapSystem.heightAt(t.pos.x, t.pos.y) : 0;
      if (cp) rec.dome.position.set(cp.x, cp.y, cp.z);
      else rec.dome.position.set(t.pos.x, c.domeLift ?? 0, t.pos.y);
      rec.dome.scale.setScalar(range);
      this._sync(rec.dome, range, gY);

      // ---- ② 射程内有没有可中毒的敌人 ----
      // 判据与 weapon_corrosion.onFrame 完全同源：同一张类型表、同一个半径、同一个阵营过滤。
      // 不同源的话会出现"雾在扩但没人中毒"或反过来，那种不一致比没有特效更糟。
      let hasFoe = false;
      const near = entities.findInRadius(t.pos.x, t.pos.y, range, POISONABLE, true);
      for (const e of near) {
        if (!e.alive) continue;
        const ef = e._mapFaction || e.faction;
        if (t._mapFaction && ef && ef === t._mapFaction) continue;   // 自己人不算
        hasFoe = true; break;
      }

      // 浓淡走一阶平滑，避免最后一个兵死掉时雾"啪"地变淡
      const want = hasFoe ? domeBusy : domeIdle;
      const k = Math.min(1, domeLerp * Math.min(0.1, Math.max(0, dtWall || 0)));
      rec.alpha += (want - rec.alpha) * k;
      rec.dome.material.opacity = rec.alpha;

      // ---- ③ 有兵才发波，节奏 = 攻速 ----
      if (hasFoe) {
        const as = (attrCalc && effects)
          ? attrCalc.calcAttackSpeedOf(attrCalc.calc(t, effects.getEffects(t.id)))
          : (t.baseStats?.baseAttackSpeed || 1);
        const interval = 1 / Math.max(0.1, as);
        if (this._t >= rec.nextAt) {
          rec.nextAt = this._t + interval;
          if (rec.waves.length < maxWaves) {
            rec.waves.push({ mesh: this._mkMesh(color.clone().lerp(new THREE.Color('#ffffff'), c.waveLighten ?? 0.25), waveAlpha, c.waveShell ?? 0.35), t: 0 });
          } else {
            // 池满：回收最老的那一波重新出发（不再 new，网格数封顶）
            let oldest = rec.waves[0];
            for (const w of rec.waves) if (w.t > oldest.t) oldest = w;
            oldest.t = 0;
          }
        }
      } else {
        rec.nextAt = 0;   // 脱战：下次有兵时立刻来一波，不用等冷却
      }

      // ---- ④ 推进已有的波 ----
      for (const w of rec.waves) {
        w.t += Math.min(0.1, dtWall || 0);
        const p = w.t / waveLife;
        if (p >= 1) { w.mesh.visible = false; continue; }
        w.mesh.visible = true;
        w.mesh.position.copy(rec.dome.position);
        w.mesh.scale.setScalar(range * (waveStartK + (1 - waveStartK) * p));
        this._sync(w.mesh, range * (waveStartK + (1 - waveStartK) * p), rec.dome.material.uniforms.uGround.value);
        // 越往外越淡（平方衰减：靠近塔身时厚、到边缘几乎化开）
        w.mesh.material.opacity = waveAlpha * (1 - p) * (1 - p);
      }
    }

    // ---- ⑤ 回收：塔没了 / 换了武器 → 连球带波一起拆掉 ----
    for (const [id, rec] of this._per) {
      if (rec.seen === tick) continue;
      this.scene.remove(rec.dome); rec.dome.material.dispose();
      for (const w of rec.waves) { this.scene.remove(w.mesh); w.mesh.material.dispose(); }
      this._per.delete(id);
    }
  }

  dispose() {
    for (const rec of this._per.values()) {
      this.scene.remove(rec.dome); rec.dome.material.dispose();
      for (const w of rec.waves) { this.scene.remove(w.mesh); w.mesh.material.dispose(); }
    }
    this._per.clear();
    this._geo.dispose();
  }
}
