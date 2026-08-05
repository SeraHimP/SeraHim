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

/** 可被腐蚀叠层的敌方单位类型，与 weapon_corrosion.onFrame 的过滤表保持一致 */
const POISONABLE = ['melee', 'ranged', 'siege', 'super', 'totem', 'dragon', 'shield', 'warlock', 'corrupt'];

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

  _mkMesh(color, opacity) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this._geo, mat);
    m.renderOrder = cfg().renderOrder ?? 20;
    m.frustumCulled = false;   // 球心在塔上但半径很大，剔除盒容易误判
    this.scene.add(m);
    return m;
  }

  /**
   * @param deps { entities, attrCalc, effects }
   * @param dtWall 墙钟秒
   * @param weaponOf(tower) → 该塔当前武器技能 id（复用 EffectsLayer 的缓存版本）
   */
  update(deps, dtWall, weaponOf) {
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
      rec.dome.position.set(t.pos.x, c.domeLift ?? 0, t.pos.y);
      rec.dome.scale.setScalar(range);

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
            rec.waves.push({ mesh: this._mkMesh(color, waveAlpha), t: 0 });
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
