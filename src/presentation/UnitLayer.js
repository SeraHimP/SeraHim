/**
 * UnitLayer.js —— 单位 Billboard + 血条（2.5D 迁移第 3 步）
 *
 * 铁律：
 *   ① 渲染态【全部】在本层内部的 Map<entityId, entry> 里，禁止往实体对象挂任何字段。
 *      （2D 的 drawHealthBar 会写 entity._trailWidth，那是历史欠账；本层零写入。）
 *   ② 清理双保险：entity:death 事件即时删 + 每帧帧戳兜底扫描（凡本帧没被遍历到的 id 一律删）。
 *      兜底覆盖事件漏发的一切情形：purgeDead 直清、切图清场、测试脚手架直接改容器。
 *   ③ 血条脏标记：把决定条形外观的全部输入折成一个字符串 key（HP/护盾按 1/64 条宽量化、
 *      阵营、重生进度同理），key 不变绝不重绘纹理、不置 needsUpdate。
 *   ④ 单位纹理全部来自 SpriteFactory（与 2D 同一套离屏画布）；共享纹理只建一次、
 *      不随单位销毁——per-entity 的只有血条纹理与两个 material。
 *
 * 位置约定：Billboard 中心放在 (pos.x, 0, pos.y)——与 2D 的绘制中心严格同点，
 *   ProjectionCheck 因此对单位同样成立。material.depthTest=false + renderOrder 保证
 *   贴地的下半张不会被地面平面深度裁掉（塔防没有"钻到地下"的语义，地面永不遮挡单位）。
 *   血条不用世界坐标抬高（那会随仰角改变屏幕间距），用 sprite.center 做【屏幕空间锚点偏移】：
 *   偏移量以自身条宽为单位 = d / scale.y，任何仰角下条与单位的屏幕间距都与 2D 逐像素一致。
 *
 * 血条与 2D 的刻意差异（均已裁定记档）：
 *   - 无掉血白色拖尾残影（拖尾是逐帧动画，与"HP 变化才重绘"直接冲突）；
 *   - 镀层节点线画在血条纹理内，上下不出条（2D 上下各溢出 1.5px；纹理无法出界）；
 *   - 射程圈半径量化到 4px 步长（几何体缓存需要有界 key；250px 圈上 1px 描边不可辨）。
 *
 * 第 3.7 步（E 组）：E1 节点线入血条纹理（脏 key 加节点值）；E2 盾牌 = 共享纹理的
 *   第三 sprite，屏幕空间锚点悬于血条上方（与 2D 的 y-bSize-26 同距）；E3/E4/E5 =
 *   贴地圆环网格（RingGeometry/CircleGeometry 平躺，renderOrder=5 垫在单位下），
 *   几何体与材质按量化 key 全局共享，创建后零分配。条件分支与 2D 逐条同口径：
 *   射程圈 hasWeapon && !isNexus && !lodBars；归属环 _mapFaction && !_mapTier；
 *   龙魂金环 dragonsoul_ 前缀技能；盾牌 isStructureProtected。幽灵水晶不参与 E 组。
 */
import * as THREE from '../../vendor/three.module.js';
import { MINION_STYLE, minionStyle } from './SpriteFactory.js';   // 第 6.3 步：本体改网格后不再需要精灵工厂
import { CONFIG } from '../data/Config.js';
import { towerModelKind, towerModelTier } from '../data/towerModels.js';
import { isStructureProtected } from '../systems/FactionSystem.js';
import { nextPlatingNode } from './UnitInfo.js';
import { towerMesh, minionMesh, dragonMesh, unitMaterial, crystalMaterial, crystalParticles, needsFacing, towerDamageStage } from './UnitMeshFactory.js';
import { towerFacingRad } from './towerFacing.js';
import { stepTrail, TRAIL_COLOR } from './barTrail.js';
import { SkillLibrary } from '../core/SkillLibrary.js';
import { resourceInfoOf, RESOURCE_COLORS } from '../core/resourceBar.js';

const ORDER_UNIT = 10, ORDER_BAR = 20;
const ORDER_RING = 5, ORDER_SHIELD = 21; // 贴地环垫在单位下；盾牌浮于血条上
const _EMPTY_GEO = new THREE.BufferGeometry();  // Mesh 首帧占位，随即被 _visualOf 的共享几何替换
// Q3：程序化塔/水晶的视觉放大系数（纯表现；不动 CONFIG.buildingSizes，故 GLB/碰撞/玩法都不受影响）。
// Q4：系数搬到 CONFIG.towerVizScale，与 LaneMovementSystem 的避障半径同源 ——
// 两边各写一份就会出现"画得比挡得大"，那正是废墟穿模的成因。
const _VZ = () => CONFIG.towerVizScale || {};
const TOWER_VIZ = {
  get tower() { return _VZ().default ?? 1.25; },
  get orb() { return _VZ().nexus_lane ?? 1.10; },
  get gem() { return _VZ().nexus_main ?? 1.10; },
};
const towerVizScale = (tier) => _VZ()[tier] ?? _VZ().default ?? 1.25;
// Q6：水晶慢转角速度(rad/s)与攻击辉光参数（自发光基准/峰值/衰减速率）。
// 水晶本体转速（弧度/秒）。粒子的转速在 CONFIG.ui.crystal 里单独给 —— 见下面的说明。
const CRYSTAL_SPIN = 0.6, CRYSTAL_EMI_BASE = 0.7, CRYSTAL_EMI_PEAK = 1.6, CRYSTAL_GLOW_DECAY = 2.6;
const CRYSTAL_PT_MAX_PX = 9;   // 粒子屏幕尺寸上限（像素），近距离不至于过大
// Q3：小水晶随【充能】变亮（仅穿透型/闪电杖）。全部是渲染侧派生量，逻辑层零改动。
// 用户定稿：不要涨大、不要开火弹跳；闪电杖读武器实例的持续充能，穿透型按冷却反推。
const CRYSTAL_CHARGE_POW = 2.6;    // 蓄力曲线指数：越大越集中在临射前才亮起来
const CRYSTAL_CHARGE_GAIN = 1.1;   // 蓄力对自发光的最大增量
const CRYSTAL_RISE = 6.0;          // 充能亮度的上升速率（每秒），跟得上充能即可
const CRYSTAL_FADE = 1.6;          // 失去目标后亮度滑回基准的速率（每秒）——过渡不突兀
const CRYSTAL_WINDUP = 0.3;        // 锁定前摇时长（与 CONFIG.tuning.lockOnWindup 同值）
const RING_LIFT = 0.6;   // 贴地环离地高度，避开与地面平面 z-fighting（与 EffectsLayer 同值）
const ORDER_SEL = 6;                     // 选中光圈压在射程圈之上、单位之下
// GLB 塔模型的"正面"轴相对 +Z 的偏移（弧度）。LoL 塔系模型朝向一致，故一个全局常量即可；
// 由渲染观测标定：正面朝 +X（模型建向）→ 需 -90° 让其对齐 +Z 的定向基准。

// 血条画布分辨率：宽 64 = 量化粒度（1/64 条宽 ≈ 2D 的 80px 条上 1.25px，人眼阈值之下）
const BAR_W = 64, BAR_H = 8;

export class UnitLayer {
  constructor(scene) {
    this.scene = scene;
    this.map = new Map();          // entityId -> entry
    this._texCache = new Map();    // 精灵离屏画布 -> THREE.CanvasTexture（共享，不随单位销毁）
    this._geoCache = new Map();    // 'ring|r|w' / 'disc|r' -> 平躺几何体（共享，dispose 时统一释放）
    this._matCache = new Map();    // 'color|opacity' -> MeshBasicMaterial（共享）
    this._shieldTex = null;        // 🛡️ 共享纹理（懒建）
    this._frame = 0;
    this.shadowLevel = 'off';      // 第 6.1 步：由 ThreeRenderer.setShadowLevel 注入
    this.mapSystem = null;         // A：塔按兵线朝敌方定向用（读车道 waypoints + 敌方基地中心）
    this.infoObjs = 0;             // E 组场景对象计数（sceneStats 用：children = 2×tracked + infoObjs + fx）
    this.pxPerUnit = 1;            // 像素/世界单位（每帧由 ThreeRenderer 注入；正交相机 = zoom×DPR）
    this.particlesOn = true;       // 水晶粒子开关（设置面板）
  }


  // ============ 单位外观（key + 贴图）：与 CanvasRenderer 渲染循环同口径 ============
  // 返回 { key, sp, size, barW, barH, barD, alpha, pulse }
  //   key 变（换武器/换阵营/改模型大小/水晶转幽灵）→ 换贴图；size = 精灵世界边长。
  /** 取塔当前武器技能 id（按技能实例数组身份缓存，不必每帧遍历） */
  _weaponIdOf(e) {
    const arr = e._skillInstances;
    if (!arr) return null;
    this._wCache = this._wCache || new WeakMap();
    const c = this._wCache.get(e);
    if (c && c.arr === arr && c.len === arr.length) return c.id;
    let id = null;
    for (const i of arr) if (i.skillId && i.skillId.startsWith('weapon_')) { id = i.skillId; break; }
    this._wCache.set(e, { arr, len: arr.length, id });
    return id;
  }

  _visualOf(e, ghost, ruin) {
    if (e.type === 'tower') {
      const bSizes = CONFIG.buildingSizes || {};
      const bSize = e._modelSize || bSizes[e._mapTier] || bSizes.default || 28;
      const isNexus = e._mapTier === 'nexus_lane' || e._mapTier === 'nexus_main';
      // v44：GLB 路径整个删掉（用户定稿："全部程序化，删 GLB"）。
      // 理由见 UnitMeshFactory.towerMesh 的头注释：GLB 那条路是
      // `_mapTier → tower.glb`，四个档次共用一个文件，做不出"等级越高越牛逼"；
      // 而我在这个环境里也做不出新的 GLB。两套造型语言并存本身也是"看着乱"的原因之一。
      const roleKind = towerModelKind(e._modelRole);
      const isLaneCrystal = roleKind ? roleKind === 'orb' : e._mapTier === 'nexus_lane';
      // 补充：召唤水晶重生中(ghost)＝显示【损毁模型】(破损底座+碎水晶)、不透明，靠灰色重生条示意重生中
      //（不再是"变灰的活体水晶"）。其余幽灵(若有)仍半透明；损毁(ruin)一律不透明。
      const showRuin = ruin || (ghost && isLaneCrystal);
      const transparent = ghost && !isLaneCrystal;
      const color = e._mapFaction === 'blue' ? '#5b9bd5' : e._mapFaction === 'red' ? '#e0473f' : '#8a92a0';
      const wInst = (ghost || ruin) ? null : (e._skillInstances || []).find(s => s.skillId.startsWith('weapon_'));
      // 第 6.3 步：纸片人 → 程序化三维几何。key 语义不变（换武器/阵营/尺寸/转幽灵/损毁才换模型）。
      const kind = roleKind || (isLaneCrystal ? 'orb' : (isNexus ? 'gem' : 'tower'));
      // v45：**渲染系数去掉**。用户定稿"最终大小，去掉系数"——
      // 以后 CONFIG.buildingSizes 里写多少就是画多大，不再有"写 28 实际画 35"这种错位。
      // towerVizScale 仍然保留给避障半径用（那边要的是"画得多大就挡多大"），
      // 但显示尺寸不再乘它 —— 两个用途本来就该分开，混用才是错位的来源。
      const rSize = bSize;
      const wid = wInst ? wInst.skillId : '';
      // v44：tier 与 faction 进 key —— 造型现在由这两项决定，不进 key 的话
      // 四个档次会共用第一个被缓存的那个几何（这正是"四档长得一样"的另一半原因）。
      const vTier = towerModelTier(e._modelRole) || e._mapTier || 'outer';
      const vFac = e._mapFaction || 'neutral';
      // v45：损毁档进 key。不进 key 的话三档会共用第一个被缓存的几何 ——
      // 与 v44「四个档次长得一样」是同一个坑（那次是 tier/faction 没进 key）。
      // 已经是废墟(showRuin)时不再分档：废墟有自己一套造型，再叠损毁没有意义。
      const hpMax = e.baseStats?.maxHP || 1;
      const dmg = showRuin ? 0 : towerDamageStage(e, (e.currentHP || 0) / hpMax);
      const key = `t|${color}|${wid}|${kind}|${vTier}|${vFac}|${rSize}|${dmg}|${transparent ? 'g' : ''}${showRuin ? 'r' : ''}`;
      const m = towerMesh(key, color, rSize, wid, kind, transparent, showRuin, vTier, vFac, dmg);
      // Q6：活体塔/水晶带独立水晶件(会转/发光)；损毁与重生态无水晶(m.crystal=null → 普通单 Mesh)。
      return { key, geo: m.geo, mat: m.mat, topY: m.topY, muzzleY: m.muzzleY != null ? m.muzzleY : m.topY, size: rSize,
               barW: 80, barH: 6, barD: 10, alpha: transparent ? 0.35 : 1, pulse: false,
               ringR: rSize + 8, crystal: m.crystal, crystalColor: color };   // F1 选中光圈半径：与 2D 的 _drawSelectionRing 同值
    }
    if (e.type === 'dragon') {
      const color = e._dragonColor || '#c0392b';
      const anc = !!e._isAncient;
      // v45：尺寸收到 CONFIG.dragonSizes（原来这里和 UnitMeshFactory 各写死一份 30/24，
      // 两处一旦不同步，血条与选中圈就会和模型对不上）。key 带上尺寸，改了立刻重建几何。
      const ds = CONFIG.dragonSizes || {};
      const size = anc ? (ds.ancient ?? 30) : (ds.element ?? 24);
      const key = `d|${color}|${anc ? 1 : 0}|${size}`;
      const m = dragonMesh(key, color, anc, size);
      return { key, geo: m.geo, mat: m.mat, topY: m.topY, size,
               // v44：pulse 关掉。用户："不要一会大一会小那种效果。"
               // 全场只有龙设了这一项，它每帧把整个模型缩放 1±12%（3rad/s）——
               // 那是纸片人时代用来"让龙有存在感"的补偿，立体化之后纯属抖动。
               barW: 100, barH: 7, barD: 12, alpha: 1, pulse: false,
               // ⚠️ v45：**这一行是龙朝向的真正开关**，上一轮漏了。
               // 用户第二次报"龙的朝向问题依旧没有被修复"——我上一轮做了两件事
               //（把几何转正到 +Z、把 needsFacing 的白名单删掉），但**龙分支从来就没有
               // 返回 facing 字段**，于是 en.facing 恒为 false，那段旋转代码对龙一次都没跑过。
               // 教训：改一个开关之前先确认那个开关**被读到了**。
               // 我当时验证的是"needsFacing('dragon') 现在返回 true"，
               // 却没验证"龙的 visual 里有没有 facing" —— 断言钉在了定义上，不是钉在链路上。
               facing: needsFacing(e.type),
               ringR: size + 5 };
    }
    const st = minionStyle(e.type);   // 自制兵种取用户填的图标/颜色，见 SpriteFactory.minionStyle
    const faction = e._mapFaction || e.faction;
    // v44：GLB 路径删除。原来只有 melee/ranged/super/siege 四种有 GLB，
    // 其余（图腾/术士/蚀骨/攻城车）落到程序化 —— 同一批小兵里两种造型语言，
    // 而且"哪个兵有 GLB"是隐性知识。现在全部走 minionMesh 一条路。
    // 阵营色优先于兵种色：立体化后兵种靠【造型】区分，颜色让位给敌我识别
    const color = faction === 'blue' ? '#5b9bd5' : faction === 'red' ? '#e0473f' : st.color;
    const key = `m|${e.type}|${faction || 'none'}`;
    const m = minionMesh(key, color, st.size, e.type, faction);
    return { key, geo: m.geo, mat: m.mat, topY: m.topY, size: st.size,
             barW: 40, barH: 4, barD: 6, alpha: 1, pulse: false,
             ringR: st.size + 5, facing: needsFacing(e.type) };
  }

  // ============ E 组共享资源（几何/材质/盾牌纹理全局复用，暖机后零分配） ============
  _flatMat(color, opacity) {
    const k = color + '|' + opacity;
    let m = this._matCache.get(k);
    if (!m) {
      // depthTest 开启：射程圈/归属环/选中光圈都是【地面贴花】，被抬高的墙体挡住才是对的。
      // 关掉的话它们会浮在高地之上，让墙看起来是透明的。
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
                                        depthTest: true, depthWrite: false });
      this._matCache.set(k, m);
    }
    return m;
  }

  /**
   * 射程圈的**随地形起伏**几何（"披"在地形上，而不是一张平面片）。
   *
   * 用户："塔的射程圈只要出现了高低差就会被吞掉一部分，修复问题，让射程浮在地形上。"
   * 根因：圈是一张【平的】面片，整片按塔脚那一点的高度摆。地形一有高低差，
   * 高的那半边地面就比面片高，depthTest 直接把它剪掉 —— 看起来就是"被吞掉一块"。
   *
   * 这里逐顶点按 heightAt 抬沉，让圈贴着坡爬上去。两处细节都是必须的：
   *   · 高度取【邻域最大值】（probe）。地面网格是 24px 一段的线性插值，而 heightAt 在
   *     台阶处是阶跃的 —— 只取本点，台阶低侧那一圈顶点会被插值出来的地面盖住，
   *     等于没修。取邻域最大值相当于让圈在台阶边缘提前抬起来。
   *   · 几何依赖【圆心的世界坐标】，所以**不能进 _geoCache 共享**，只能挂在 entry 上，
   *     换半径/换位置时自己 dispose（塔不会移动，所以实际只在建塔时构建一次）。
   */
  _drapeGeo(kind, r, w, cx, cz) {
    const d = (CONFIG.ui && CONFIG.ui.rangeRing && CONFIG.ui.rangeRing.drape) || {};
    const SEG = Math.max(8, d.segments ?? 72);
    const probe = d.probe ?? 12;
    const raw = (x, z) => this.mapSystem.heightAt(x, z);
    const hAt = (x, z) => {
      let h = raw(x, z);
      if (probe > 0) {
        h = Math.max(h, raw(x + probe, z), raw(x - probe, z), raw(x, z + probe), raw(x, z - probe));
      }
      return h;
    };
    const h0 = raw(cx, cz);          // 网格摆在 groundY 上，顶点存的是相对高度
    const steps = Math.max(1, d.radialSteps ?? 10);
    const radii = kind === 'ring'
      ? [Math.max(0.1, r - w / 2), r + w / 2]
      : Array.from({ length: steps + 1 }, (_, i) => (r * i) / steps);
    const pos = [], idx = [];
    for (const rad of radii) {
      for (let a = 0; a <= SEG; a++) {
        const th = (a / SEG) * Math.PI * 2;
        const dx = Math.cos(th) * rad, dz = Math.sin(th) * rad;
        pos.push(dx, hAt(cx + dx, cz + dz) - h0, dz);
      }
    }
    const row = SEG + 1;
    for (let ri = 0; ri < radii.length - 1; ri++) {
      for (let a = 0; a < SEG; a++) {
        const p0 = ri * row + a, p1 = p0 + 1, p2 = p0 + row, p3 = p2 + 1;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  /**
   * 射程圈的材质是**每座塔独有**的（不进 _matCache）。
   * 共享材质在这里是错的：渐显靠逐帧改 .opacity，而一个阵营十几座塔共用一份材质时，
   * 最后写进去的那座说了算，各塔的渐显互相踩。距离渐显时代这条就错着
   *（当时各塔强度差不多，看不太出来），改成逐塔独立的渐显/渐隐后必须分开。
   */
  _rangeMat(color, opacity) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
                                         depthTest: true, depthWrite: false,
                                         side: THREE.DoubleSide });
  }

  // 射程圈专用清理：贴合地形的几何与逐塔材质都是**这座塔独有**的，必须真 dispose
  //（不像共享几何/材质那样只摘出场景）。
  _clearRange(en) {
    en.rangeFill = this._removeFlat(en.rangeFill);
    en.rangeEdge = this._removeFlat(en.rangeEdge);
    if (en.rangeGeo) { for (const g of en.rangeGeo) g.dispose(); en.rangeGeo = null; }
    if (en.rangeMat) { for (const m of en.rangeMat) m.dispose(); en.rangeMat = null; }
    en.rangeKey = '';
  }

  _flatGeo(kind, r, w = 0) {
    const k = kind + '|' + r + '|' + w;
    let g = this._geoCache.get(k);
    if (!g) {
      g = kind === 'ring'
        ? new THREE.RingGeometry(Math.max(0.1, r - w / 2), r + w / 2, 48)
        : new THREE.CircleGeometry(r, 48);
      g.rotateX(-Math.PI / 2);   // 平躺到 XZ（与地面同向）
      this._geoCache.set(k, g);
    }
    return g;
  }

  _flatMesh(geo, mat) {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = ORDER_RING;
    this.scene.add(m); this.infoObjs++;
    return m;
  }

  _removeFlat(mesh) {   // 共享几何/材质不 dispose，只摘出场景
    if (!mesh) return null;
    this.scene.remove(mesh); this.infoObjs--;
    return null;
  }

  // A：切换单位本体对象（程序化 Mesh ↔ GLB 模型 Group）。旧对象摘出场景；
  // 几何/材质均为共享资源（程序化按 key 缓存、模型按模板 clone 共享），此处一律不 dispose。
  _installUnit(en, obj) {
    if (en.unit) this.scene.remove(en.unit);
    obj.renderOrder = ORDER_UNIT;
    this.scene.add(obj);
    en.unit = obj;
  }

  // Q6：水晶件的材质是【逐塔独立】的（攻击辉光要单独调），切换外观/移除时必须释放。
  // 水晶几何是共享缓存（不释放）；子物体粒子（Points）的几何/材质逐塔独立（释放）。软圆点贴图全局共享（不释放）。
  _disposeCrystal(en) {
    if (!en.crystal) return;
    if (en.crystal.material) en.crystal.material.dispose();
    en.crystal.traverse(o => { if (o.isPoints) { o.geometry.dispose(); o.material.dispose(); } });
    en.crystal = null; en.crystalPts = null;
  }

  // 阴影档位下发：对 Mesh 与 Group（模型）一视同仁地遍历子网格设置。
  _applyUnitShadow(en) {
    const cast = this.shadowLevel === 'all' || (this.shadowLevel === 'static' && en.isTower);
    const recv = this.shadowLevel !== 'off';
    en.unit.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = recv; } });
  }

  _shieldTexture() {
    if (this._shieldTex) return this._shieldTex;
    const c = document.createElement('canvas');
    c.width = 22; c.height = 22;
    const g = c.getContext('2d');
    g.font = '15px sans-serif';                       // 与 2D 同字号
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText('🛡️', 11, 11);
    this._shieldTex = new THREE.CanvasTexture(c);
    this._shieldTex.colorSpace = THREE.SRGBColorSpace;
    return this._shieldTex;
  }

  _makeEntry(id) {
    const barCanvas = document.createElement('canvas');
    barCanvas.width = BAR_W; barCanvas.height = BAR_H;
    const barTex = new THREE.CanvasTexture(barCanvas);
    barTex.colorSpace = THREE.SRGBColorSpace;
    barTex.magFilter = THREE.NearestFilter;   // 4~7px 高的条，线性过滤只会糊
    barTex.minFilter = THREE.LinearFilter;
    barTex.generateMipmaps = false;

    // 第 6.3 步：单位本体由 Sprite 改为 Mesh。几何与材质都是共享资源（按 key 缓存在
    // UnitMeshFactory 里），entry 只持引用，故这里先挂一个空壳，首次 sync 时按 key 装配。
    // 注意 depthTest 必须【开启】——立体单位要与墙体、彼此正确遮挡，这和纸片人时代
    // 靠 renderOrder 强行排序的做法相反。
    const unit = new THREE.Mesh(_EMPTY_GEO, unitMaterial(false));
    unit.renderOrder = ORDER_UNIT;

    const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false, depthWrite: false });
    const bar = new THREE.Sprite(barMat);
    bar.renderOrder = ORDER_BAR;

    this.scene.add(unit); this.scene.add(bar);
    const entry = { unit, bar, barCanvas, barTex, visKey: '', barKey: '', seen: 0, topY: 0, muzzleY: 0, unitIsModel: false, crystal: null, crystalPts: null, isTower: false, faceFixed: null, faceA: 0, lastX: null, lastZ: null, facing: false, groundY: 0, dispFrac: -1, trailing: false, _lastT: 0,
                    rangeFill: null, rangeEdge: null, soul: null, own: null, shield: null,
                    rangeKey: '', soulKey: '', ownKey: '', shieldOn: false,
                    selCore: null, selGlow: null, selKey: '' };
    this.map.set(id, entry);
    return entry;
  }

  remove(id) {
    const en = this.map.get(id);
    if (!en) return;
    this.scene.remove(en.unit); this.scene.remove(en.bar);
    // 单位的几何与材质由 UnitMeshFactory 按 key 全局共享，此处【不得】dispose——
    // 释放它会连带弄坏所有同 key 的其他单位。共享资源随 disposeMeshCache 统一释放。
    this._disposeCrystal(en);     // Q6：水晶材质逐塔独立，需释放
    en.bar.material.dispose();
    en.barTex.dispose();          // per-entity 纹理；共享单位纹理不在此释放
    this._clearInfo(en);          // E 组对象（几何/材质共享，摘场景即可；盾牌 material 独立需释放）
    this.map.delete(id);
  }

  clear() { for (const id of [...this.map.keys()]) this.remove(id); }

  dispose() {
    this.clear();
    for (const t of this._texCache.values()) t.dispose();
    this._texCache.clear();
    for (const g of this._geoCache.values()) g.dispose();
    this._geoCache.clear();
    for (const m of this._matCache.values()) m.dispose();
    this._matCache.clear();
    if (this._shieldTex) { this._shieldTex.dispose(); this._shieldTex = null; }
  }

  // 第 6.1 步：接收阴影档位。当前单位仍是 Sprite（Sprite 不参与阴影），故这里只是存档；
  // 第 6.3 步单位换成真网格后，建网格时读 this.shadowLevel 决定 castShadow。
  /**
   * 炮口高度查询（第 6.3 步）：给 EffectsLayer 用，让弹道从模型顶端出膛而不是从地面。
   * 按【位置就近】命中而不是按 id —— 因为 ProjectileSystem 的子弹/电弧并不携带攻击者 id，
   * 而按位置查是纯渲染侧的推断，逻辑层一行都不用改。塔不动，命中是精确的；
   * 小兵会移动，故调用方（子弹）只在出膛那一刻解析一次并缓存。
   */
  /**
   * Q1：按【实体 id】取炮口高度 —— 这才是调用方真正想问的问题。
   * v43 P0-③：这里曾经还有一个 muzzleY(x, z) —— 按【坐标】就近搜索（半径 26）最近单位的
   * 炮口高度。那是个错误的抽象，光"轨迹突然躺平"一个症状就制造了四次 bug：
   * 目标一死就搜不到 → 返回 0 → 末端塌到地面；混战时还会搜到旁边另一个单位身上。
   * 已整个删除，渲染层只剩这一条按 id 取高的路。
   * 查不到返回 null，由调用方决定回落策略（用死亡瞬间的快照，而不是 0）。
   */
  muzzleYOf(entityId) {
    const en = this.map.get(entityId);
    if (!en) return null;
    return (en.groundY || 0) + (en.muzzleY || en.topY || 0);
  }

  setShadowLevel(level) {
    this.shadowLevel = level;
    // 已在场的单位立即生效：visKey 未变不会重走装配分支，故这里直接刷一遍
    for (const en of this.map.values()) this._applyUnitShadow(en);
  }

  // A：防御塔朝向 = 沿本路兵线【朝敌方来兵方向】。取最近车道段的切向，按"指向敌方基地中心"
  // 定号；无车道（如中央枢纽）退化为直指敌方基地。返回世界 yaw（模型 +Z 为定向基准）。
  _towerYaw(e) {
    const ms = this.mapSystem;
    if (!ms || !e._mapFaction || !e.pos) return 0;
    const enemy = e._mapFaction === 'red' ? 'blue' : 'red';
    const eb = ms.getBaseCircleCenter ? ms.getBaseCircleCenter(enemy) : null;
    const lane = (e._laneId && ms.getLane) ? ms.getLane(e._laneId) : null;
    const wps = lane && lane.waypoints;
    if (wps && wps.length >= 2) {
      let best = Infinity, tx = 0, ty = 0;
      for (let i = 0; i < wps.length - 1; i++) {
        const ax = wps[i].x, ay = wps[i].y, dx = wps[i + 1].x - ax, dy = wps[i + 1].y - ay;
        const L2 = dx * dx + dy * dy || 1;
        let t = ((e.pos.x - ax) * dx + (e.pos.y - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx, py = ay + t * dy, d = (e.pos.x - px) ** 2 + (e.pos.y - py) ** 2;
        if (d < best) { best = d; tx = dx; ty = dy; }
      }
      if (eb && (tx * (eb.x - e.pos.x) + ty * (eb.y - e.pos.y)) < 0) { tx = -tx; ty = -ty; }
      return Math.atan2(tx, ty);
    }
    if (eb) return Math.atan2(eb.x - e.pos.x, eb.y - e.pos.y);
    return 0;
  }

  _clearSel(en) {
    en.selCore = this._removeFlat(en.selCore);
    en.selGlow = this._removeFlat(en.selGlow);
    en.selKey = '';
  }

  // F1 选中光圈（第4步）：与 2D 同款双层绿环——实色 2.5px + 半透明 6px 外扩 3px。
  // 幽灵水晶同样可选中（2D 亦然），故不受 E 组"仅活体塔"的限制，单独一条路径。
  _syncSelection(e, en, vis, selectedId) {
    if (e.id !== selectedId) { if (en.selCore) this._clearSel(en); return; }
    const r = vis.ringR || 12;
    const k = String(r);
    if (en.selKey !== k) {
      this._clearSel(en);
      en.selKey = k;
      en.selCore = this._flatMesh(this._flatGeo('ring', r, 2.5), this._flatMat('#7ef0a0', 1));
      en.selGlow = this._flatMesh(this._flatGeo('ring', r + 3, 6), this._flatMat('#7ef0a0', 0.35));
      en.selCore.renderOrder = ORDER_SEL; en.selGlow.renderOrder = ORDER_SEL;
    }
    en.selCore.position.set(e.pos.x, RING_LIFT + en.groundY, e.pos.y);
    en.selGlow.position.set(e.pos.x, RING_LIFT + en.groundY, e.pos.y);
  }

  _clearInfo(en) {
    this._clearSel(en);
    this._clearRange(en);
    en.soul = this._removeFlat(en.soul);
    en.own = this._removeFlat(en.own);
    if (en.shield) {
      this.scene.remove(en.shield); this.infoObjs--;
      en.shield.material.dispose();   // SpriteMaterial per-entity；共享 map 纹理不释放
      en.shield = null;
    }
    en.rangeKey = en.soulKey = en.ownKey = '';
    en.shieldOn = false;
  }

  /**
   * 夜间自发光加成。每帧被几十座塔调用，所以按帧缓存一次 ——
   * 读 WorldState 本身不贵，但重复读几十次纯属浪费。
   */
  _nightEmi() {
    const f = this._emiFrame;
    const now = window.gameTime || 0;
    if (f === now) return this._emiVal || 0;
    this._emiFrame = now;
    const c = (CONFIG.ui && CONFIG.ui.towerLight) || {};
    const peak = c.emissiveNight ?? 0;
    if (!peak || c.enabled === false) return (this._emiVal = 0);
    const ws = (typeof window !== 'undefined') ? window.CTX?.__world : null;
    const p = (ws && ws.enabled && Number.isFinite(ws.daynight?.phase)) ? ws.daynight.phase : null;
    // 与塔灯同一条夜晚曲线：黄昏/黎明渐入渐出，天一黑不会"啪"一下全亮
    const night = (p !== null && p >= 0.5) ? Math.sin((p - 0.5) / 0.5 * Math.PI) : 0;
    return (this._emiVal = peak * (c.nightOnly === false ? 1 : night));
  }

  /**
   * 射程圈的**显示强度**（0=完全不画，1=完全显示）。
   *
   * ==================== 用户定稿（本次改版）====================
   * 「设置这个必须按照渐显渐隐的方式，而不再是根据单位的距离了，
   *   只要出现目标或者是点了，就渐显，消失了就渐隐。」
   *
   * 也就是说：**强度不再是距离的函数**。目标的有无是一个布尔量，
   * 平滑完全交给时间上的渐显/渐隐（fadeIn / fadeOut 两个时间常数）。
   *
   * 上一版是按距离插值的（敌人进到"射程+220"开始渐显、"射程+30"完全显示）。
   * 那套的毛病：圈的亮度跟着敌人走位一直抖，而且【敌人在射程外老远就把圈点亮】—— 
   * 一个 250 射程的塔，220 的渐显带意味着 470px 外就开始亮，满地图都是半亮的圈。
   * 现在只认"射程内有没有敌人"，圈亮 = 这座塔真的能打到人，信息量回来了。
   *
   * 三个保留下来的设计：
   *   ① **节流**：敌人探测每 probeInterval 秒做一次（44 座塔每帧各查一次空间网格纯属白烧；
   *      "晚 0.25 秒亮起"看不出来，而且渐显本身就有 fadeIn 那么长）。
   *   ② 探测结果记在渲染层自己的 entry 上（en.*），**不往实体上写字段**。
   *   ③ findInRadius 的 aliveOnly=true：死了的敌人不该让圈继续亮着。
   *
   * 返回 0..1。
   */
  _rangeRingStrength(e, en, ctxDeps, selectedId) {
    const cfg = (CONFIG.ui && CONFIG.ui.rangeRing) || {};
    const mode = cfg.mode || 'auto';
    if (mode === 'always') return 1;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    // 目标强度是**布尔**的：选中 ‖ 射程内有敌人。
    let want;
    if (e.id === selectedId) want = 1;          // 点了就亮（也走渐显，不是啪一下）
    else if (mode === 'selected') want = 0;
    else {
      const every = cfg.probeInterval ?? 0.25;
      if (en.ringAt === undefined || now - en.ringAt >= every) {
        en.ringAt = now;
        const ents = ctxDeps.entities;
        const base = ctxDeps.attrCalc.calc(e, ctxDeps.effects.getEffects(e.id)).attackRange || 250;
        let hit = false;
        if (ents && ents.findInRadius) {
          const fac = e._mapFaction || e.faction;
          for (const o of ents.findInRadius(e.pos.x, e.pos.y, base, null, true)) {
            if (o.id === e.id || o.type === 'tower' || !o.pos) continue;
            const of = o._mapFaction || o.faction;
            if (of === fac) continue;
            if (Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) <= base) { hit = true; break; }
          }
        }
        en.ringWant = hit ? 1 : 0;
      }
      want = en.ringWant ?? 0;
    }

    // 渐显 / 渐隐：两个方向各一个时间常数（淡出慢一点，目标死了圈不会"啪"地消失）
    const cur = en.ringHot ?? 0;
    const tau = Math.max(0.01, (want > cur ? (cfg.fadeIn ?? cfg.fade) : (cfg.fadeOut ?? cfg.fade)) ?? 0.18);
    const dt = Math.min(0.1, Math.max(0, now - (en.ringLerpAt ?? now)));
    en.ringLerpAt = now;
    en.ringHot = cur + (want - cur) * Math.min(1, dt / tau);
    if (en.ringHot < 0.004) en.ringHot = 0;
    if (en.ringHot > 0.996) en.ringHot = 1;
    return en.ringHot;
  }

  // ============ E 组同步（仅活体塔；幽灵与非塔一律清空） ============
  _syncTowerInfo(e, en, ctxDeps, lodHideBar, selectedId) {
    const { attrCalc, effects, entities } = ctxDeps;
    const bSizes = CONFIG.buildingSizes || {};
    // Q3：与 _visualOf 同步放大——归属环等随放大后的模型走（纯表现）。
    const bSize = (e._modelSize || bSizes[e._mapTier] || bSizes.default || 28) * towerVizScale(e._mapTier);
    const isNexus = e._mapTier === 'nexus_lane' || e._mapTier === 'nexus_main';
    const color = e._mapFaction === 'blue' ? '#5b9bd5' : e._mapFaction === 'red' ? '#e0473f' : '#8a92a0';
    const x = e.pos.x, z = e.pos.y;

    // --- E3 射程圈：hasWeapon && !isNexus && !lodBars（与 2D 逐字同条件） ---
    // 半径每帧读 attrCalc（buff/天气可变），量化 4px 步长做几何缓存 key（见头注刻意差异）。
    // attrCalc.calc 与血条处各调一次：≤30 塔的重复计算换第 3 步已验收路径零改动。
    const hasWeapon = (e._skillInstances || []).some(sk => sk.skillId.startsWith('weapon_'));
    // 用户定稿：射程圈【只在选中 或 半径内有敌人时】显示。
    // 常显是画面最大的噪音源 —— 22 座塔 ×2 阵营的圈全亮着，地图上全是同心圆。
    const ringK = (hasWeapon && !isNexus && !lodHideBar)
      ? this._rangeRingStrength(e, en, ctxDeps, selectedId) : 0;
    if (ringK > 0) {
      const range = attrCalc.calc(e, effects.getEffects(e.id)).attackRange || 250;
      const r = Math.round(range / 4) * 4;
      const cfg0 = (CONFIG.ui && CONFIG.ui.rangeRing) || {};
      // 贴合地形的几何依赖圆心坐标，所以 key 里必须带上位置（塔不动，实际只建一次）
      const drape = (cfg0.drape?.enabled !== false) && !!(this.mapSystem && this.mapSystem.heightAt);
      const rk = r + '|' + color + (drape ? `|${Math.round(x)},${Math.round(z)}` : '');
      if (en.rangeKey !== rk) {
        this._clearRange(en);
        en.rangeKey = rk;
        en.rangeMat = [this._rangeMat(color, 0x0f / 255), this._rangeMat(color, 0x33 / 255)];
        if (drape) {
          en.rangeGeo = [this._drapeGeo('disc', r, 0, x, z), this._drapeGeo('ring', r, 1, x, z)];
          en.rangeFill = this._flatMesh(en.rangeGeo[0], en.rangeMat[0]);
          en.rangeEdge = this._flatMesh(en.rangeGeo[1], en.rangeMat[1]);
        } else {
          en.rangeFill = this._flatMesh(this._flatGeo('disc', r), en.rangeMat[0]);
          en.rangeEdge = this._flatMesh(this._flatGeo('ring', r, 1), en.rangeMat[1]);
        }
      }
      // 渐显靠改材质不透明度而不是重建网格：重建会在每一档强度上生成一份新材质，
      // 渐变过程有几十帧，等于每次淡入都造几十个材质再丢掉。
      // 材质是逐塔独有的（见 _rangeMat 的注释），所以这里改 .opacity 只影响自己。
      const cfg = (CONFIG.ui && CONFIG.ui.rangeRing) || {};
      en.rangeFill.material.opacity = (cfg.fillAlpha ?? (0x0f / 255)) * ringK;
      en.rangeEdge.material.opacity = (cfg.edgeAlpha ?? (0x33 / 255)) * ringK;
      en.rangeFill.position.set(x, RING_LIFT + en.groundY, z);
      en.rangeEdge.position.set(x, RING_LIFT + en.groundY, z);
    } else if (en.rangeFill) {
      this._clearRange(en);
    }

    // --- E5 归属环：手动建造对战塔（_mapFaction && !_mapTier），中立灰白，宽 3 ---
    if (e._mapFaction && !e._mapTier) {
      const oc = e._mapFaction === 'blue' ? '#5b9bd5' : (e._mapFaction === 'red' ? '#e0473f' : '#e8e8e8');
      const ok = (bSize + 4) + '|' + oc;
      if (en.ownKey !== ok) {
        en.ownKey = ok;
        en.own = this._removeFlat(en.own);
        en.own = this._flatMesh(this._flatGeo('ring', bSize + 4, 3), this._flatMat(oc, 1));
      }
      en.own.position.set(x, RING_LIFT + en.groundY, z);
    } else if (en.own) {
      en.own = this._removeFlat(en.own); en.ownKey = '';
    }

    // --- E4 龙魂金环：dragonsoul_ 前缀技能，半径 32 宽 2 金色 ---
    const hasSoul = (e._skillInstances || []).some(sk => sk.skillId.startsWith('dragonsoul_'));
    if (hasSoul) {
      if (en.soulKey !== '1') {
        en.soulKey = '1';
        en.soul = this._flatMesh(this._flatGeo('ring', 32, 2), this._flatMat('#f6c94a', 1));
      }
      en.soul.position.set(x, RING_LIFT + en.groundY, z);
    } else if (en.soul) {
      en.soul = this._removeFlat(en.soul); en.soulKey = '';
    }

    // --- E2 结构保护盾牌：共享纹理 sprite，屏幕空间悬于血条上方（2D: y - bSize - 26 居中） ---
    if (isStructureProtected(entities, e)) {
      if (!en.shield) {
        const mat = new THREE.SpriteMaterial({ map: this._shieldTexture(),
                                               depthTest: false, depthWrite: false });
        en.shield = new THREE.Sprite(mat);
        en.shield.renderOrder = ORDER_SHIELD;
        en.shield.scale.set(16, 16, 1);
        en.shield.center.set(0.5, 0.5 - 22 / 16); // 立体化后模型自带高度，屏幕余量只留血条上方一点
        this.scene.add(en.shield); this.infoObjs++;
        en.shieldOn = true;
      }
      en.shield.position.set(x, (en.topY || 0) + en.groundY, z);
    } else if (en.shield) {
      this.scene.remove(en.shield); this.infoObjs--;
      en.shield.material.dispose();
      en.shield = null; en.shieldOn = false;
    }
  }

  // ============ 血条重绘（复刻 drawHealthBar 的配色与布局 + 掉血拖尾） ============
  // trailFrac = 显示血量（>真实血量时画一段淡红拖尾）；0 表示无拖尾。
  // resInfo = { frac, label } | null（v51）——世界空间的资源条，画在血条正下方那一细条；
  // 没有资源可显示时（大多数单位）整个条高度都归 HP，行为与改动前逐位一致。
  _redrawBar(g, e, ghost, maxHP, trailFrac = 0, resInfo = null) {
    g.clearRect(0, 0, BAR_W, BAR_H);
    if (ghost) {
      const prog = Math.max(0, Math.min(1, e._respawnProgress || 0));
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, BAR_W, BAR_H);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, 0, BAR_W, BAR_H);
      g.fillStyle = '#9aa3ae'; g.fillRect(0, 0, BAR_W * prog, BAR_H);
      return;
    }
    if (maxHP <= 0) return;
    // 资源条占底部 2px，HP 条让出这 2px——BAR_H 只有 8px，硬加一整条会让贴图翻倍、
    // 世界尺寸也要跟着改（vis.barH 是按 BAR_W/BAR_H 比例算的），blast radius 太大；
    // 用现成的高度里挤出一细条是最小改动，且没有资源时（绝大多数单位）行为逐位不变。
    const hpH = resInfo ? BAR_H - 2 : BAR_H;
    const hpFrac = Math.max(0, Math.min(1, e.currentHP / maxHP));
    const faction = e._mapFaction || e.faction;
    // v43：血条颜色只看**阵营**，不再按 type 分叉。
    // 用户："中立单位的血条是绿色的。并且我新建了中立防御塔，血条是蓝色的。"
    // 原写法 `defaultColor = e.type === 'tower' ? 蓝 : 绿` 是早期版本的遗留：
    // 那时塔一定是自己人（蓝）、小兵一定是敌人（绿），颜色实际编码的是敌我而不是阵营。
    // 加入中立阵营之后这个假设就塌了 —— 中立**塔**掉进蓝色分支，看起来像己方建筑。
    // 现在：蓝=蓝方、红=红方、绿=中立。
    const hpColor = faction === 'blue' ? '#4a9eff'
                  : faction === 'red' ? '#ff5a5a'
                  : '#4caf50';                                     // 中立一律绿色
    const shieldTotal = (e.shieldFixedCurrent || 0) + (e.tempShield || 0);
    const shieldFrac = Math.max(0, Math.min(1, shieldTotal / maxHP));
    const total = hpFrac + shieldFrac;
    const scale = total > 1 ? 1 / total : 1;
    const hpDraw = hpFrac * scale;
    const fixedShare = shieldTotal > 0 ? (e.shieldFixedCurrent || 0) / shieldTotal : 0;
    const tempShare = shieldTotal > 0 ? (e.tempShield || 0) / shieldTotal : 0;
    const sfW = shieldFrac * scale * fixedShare;
    const stW = shieldFrac * scale * tempShare;

    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, BAR_W, hpH);
    g.fillStyle = hpColor; g.fillRect(0, 0, BAR_W * hpDraw, hpH);
    // 掉血拖尾：真实血量→显示血量之间的淡红残段（有界动画，追平即消失）。护盾在其后绘制会覆盖。
    if (trailFrac > hpFrac) {
      const tEnd = Math.min(1, trailFrac) * scale;
      g.fillStyle = TRAIL_COLOR;
      g.fillRect(BAR_W * hpDraw, 0, BAR_W * (tEnd - hpDraw), hpH);
    }
    if (sfW > 0.001) { g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(BAR_W * hpDraw, 0, BAR_W * sfW, hpH); }
    if (stW > 0.001) { g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(BAR_W * (hpDraw + sfW), 0, BAR_W * stW, hpH); }
    g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, BAR_W - 1, hpH - 1);

    // v51：资源条——紧贴在 HP 条下方的 2px 细条，颜色与面板资源条同一色系。
    if (resInfo) {
      g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, hpH, BAR_W, BAR_H - hpH);
      g.fillStyle = RESOURCE_COLORS[resInfo.kind] || RESOURCE_COLORS.mana;
      g.fillRect(0, hpH, BAR_W * resInfo.frac, BAR_H - hpH);
    }

    // E1 镀层节点线：2D 是 1.5px 白线上下各溢出 1.5px；纹理内画 2px 竖线不出条（头注记档）
    if (e.type === 'tower') {
      const node = nextPlatingNode(e);
      if (node !== null) {
        g.fillStyle = '#ffffff';
        g.fillRect(Math.round(BAR_W * node) - 1, 0, 2, hpH);
      }
    }
  }

  _syncOne(e, ghost, ctxDeps, lodHideBar, tNow, ruin) {
    const { attrCalc, effects, entities } = ctxDeps;
    let en = this.map.get(e.id);
    if (!en) en = this._makeEntry(e.id);
    en.seen = this._frame;

    const vis = this._visualOf(e, ghost, ruin);
    if (en.visKey !== vis.key) {
      en.visKey = vis.key;
      en.isTower = e.type === 'tower';   // 阴影档位判据：读实体类型，不靠模型高度猜
      en.facing = !!vis.facing;
      en.topY = vis.topY;
      en.muzzleY = vis.muzzleY != null ? vis.muzzleY : vis.topY;
      if (vis.crystal) {
        // Q6：程序化塔/水晶 + 独立水晶件 → Group(石身 Mesh + 会转/发光的水晶 Mesh)。
        this._disposeCrystal(en);
        const g = new THREE.Group();
        g.add(new THREE.Mesh(vis.geo, vis.mat));               // 石身：共享几何/材质
        const cm = new THREE.Mesh(vis.crystal.geo, crystalMaterial(vis.crystalColor)); // 水晶：共享几何 + 逐塔材质
        cm.position.set(0, vis.crystal.cy, 0);
        const pts = crystalParticles(vis.crystalColor, vis.crystal.r || 8);  // Q6：绕水晶公转的发光粒子（随水晶慢转）
        cm.add(pts); en.crystalPts = pts;
        g.add(cm);
        this._installUnit(en, g);
        en.crystal = cm; en.unitIsModel = false;
      } else {
        // 单 Mesh（小兵/龙/废墟/重生水晶）：从 Group（模型/水晶塔）切回时重建 Mesh 壳，否则换共享几何/材质引用。
        this._disposeCrystal(en);
        if (!en.unit || !en.unit.isMesh) { this._installUnit(en, new THREE.Mesh(vis.geo, vis.mat)); en.unitIsModel = false; }
        else { en.unit.geometry = vis.geo; en.unit.material = vis.mat; }
      }
      this._applyUnitShadow(en);
      en.bar.scale.set(vis.barW, vis.barH, 1);
      // 血条现在浮在【模型顶端】的世界高度上，再用 center 做一点屏幕空间余量。
      // 纸片人时代 barD 要补出整个贴图高度，立体化后模型自己有高度，余量因此小得多。
      en.bar.center.set(0.5, 0.5 - vis.barD / vis.barH);
    }
    // 脉动（巨龙）改为整体缩放模型本身，与纸片人时代同一近似
    const s = vis.pulse ? (1 + 0.12 * Math.sin(tNow * 3)) : 1;
    en.unit.scale.set(s, s, s);
    // C 组·台阶地形：单位坐到地面高度（高地/河床）。贴地贴花、血条、盾牌一并抬沉。
    const gy = (this.mapSystem && this.mapSystem.heightAt) ? this.mapSystem.heightAt(e.pos.x, e.pos.y) : 0;
    en.groundY = gy;
    en.unit.position.set(e.pos.x, gy, e.pos.y);

    // Q6：水晶慢转 + 攻击辉光。塔刚开火（attackCooldown 跳增）→ 自发光冲高、随后衰减（类 LoL）。
    if (en.crystal) {
      const cc = CONFIG.ui?.crystal || {};
      const spin = cc.spin ?? CRYSTAL_SPIN;
      en.crystal.rotation.y = tNow * spin;
      // 粒子尺寸：正交相机下 gl_PointSize 是【像素】且不随缩放变，必须自己按 像素/世界单位 换算，
      // 否则缩小看全图时粒子把塔糊成一团。上限 CRYSTAL_PT_MAX_PX 防近距离过大。
      if (en.crystalPts) {
        en.crystalPts.visible = this.particlesOn;
        if (this.particlesOn) {
          const px = (en.crystalPts.userData.worldSize || 4) * this.pxPerUnit;
          en.crystalPts.material.size = Math.max(1, Math.min(CRYSTAL_PT_MAX_PX, px));
        }
        // ==================== 粒子与水晶【转速不同】（用户要求）====================
        // 粒子是水晶 Mesh 的**子节点**（crystalParticles 被 cm.add 进去了），
        // 所以它默认继承水晶的旋转 —— 两者严丝合缝地一起转，看起来像焊死在一块儿的。
        // 想让它们相对转动，就得给子节点一个**相对**角速度：
        //   子节点世界角速度 = 水晶角速度 + 子节点自身角速度
        // 所以要达到目标世界角速度 ptsSpin，自身要转 (ptsSpin − spin)。
        // 直接把 pts.rotation.y 设成 tNow * ptsSpin 是错的 —— 那样它的世界转速会变成
        // spin + ptsSpin，两个数一起调时永远对不上你想要的效果。
        const ptsSpin = cc.particleSpin ?? -0.42;   // 负号 = 反向转，反向比同向异速更容易看出来
        en.crystalPts.rotation.y = tNow * (ptsSpin - spin);
      }
      // ---- Q3：水晶随「充能」变亮（只有穿透型 / 闪电杖两种武器有这个表现）----
      // 上一版做成了"蓄力涨大 + 粒子收拢 + 开火弹跳"，两处不对：
      //   ① 用户明确不要涨大（scale 已去掉，水晶恒定 1）；
      //   ② 那套是"攒一发打出去"的语义，只对【发射子弹】的武器成立。
      //      闪电杖是持续照射，没有"一炮"可言，套上去就不对味。
      // 现在按武器分两条来源，最终都只驱动【自发光亮度】这一个量：
      //   · 闪电杖  → 直接读武器实例的充能 state.charge（0→1 持续攒），照射期间越来越亮
      //   · 穿透型  → 由 attackCooldown 反推距离下一发的接近度（临射前亮起来）
      //   · 其它武器 → 不参与，保持基准亮度
      // 失去目标时不瞬间归零，而是按 CRYSTAL_FADE 速率平滑滑回基准（用户要求的过渡）。
      const gdt = Math.max(0, Math.min(0.1, tNow - (en._glowT || tNow))); en._glowT = tNow;
      const cd = e.attackCooldown || 0;
      if (cd > (en._lastCd || 0) + 0.05) en._cdMax = cd;   // 冷却跳增 = 刚开了一炮，记下本轮周期
      en._lastCd = cd;

      const wid = this._weaponIdOf(e);
      let target = 0;                                      // 本帧"应该"达到的充能亮度 0..1
      if (e.targetId) {
        if (wid === 'weapon_lightning') {
          const inst = (e._skillInstances || []).find(i => i.skillId === 'weapon_lightning');
          target = Math.max(0, Math.min(1, inst?.state?.charge || 0));
        } else if (wid === 'weapon_piercing') {
          const period = en._cdMax || 0;
          target = period > 0.05 ? 1 - Math.max(0, Math.min(1, cd / period)) : 1;
          const lockLeft = (e._lockUntil || 0) - (window.gameTime || 0);
          if (lockLeft > 0) target = Math.min(target, 1 - Math.min(1, lockLeft / CRYSTAL_WINDUP));
          target = Math.max(0, target);
        }
      }
      // 单向平滑：上升可以快（跟得上充能），回落走固定速率 → 切目标/脱战是"暗下去"而不是"啪一下灭"
      const cur = en._charge || 0;
      en._charge = target > cur
        ? Math.min(target, cur + gdt * CRYSTAL_RISE)
        : Math.max(target, cur - gdt * CRYSTAL_FADE);
      const chargeE = Math.pow(en._charge, CRYSTAL_CHARGE_POW) * CRYSTAL_CHARGE_GAIN;
      // 夜间把自发光顶到 >1（默认 1.8）。这不只是"晚上亮一点"：
      // Bloom 跑在【线性 HDR 缓冲】上、阈值是 1.0，场景里如果没有任何东西超过 1.0，
      // 辉光就永远抓不到东西 —— 这正是"管线是 HDR 但看着不像 HDR"的原因。
      // 塔顶水晶是全场最适合当高光源的东西，夜里让它真的过曝。
      en.crystal.material.emissiveIntensity = CRYSTAL_EMI_BASE + chargeE + this._nightEmi();
      // 粒子随充能变亮（不再收拢/外弹——那也是"攒一发"的语义）
      if (en.crystalPts && this.particlesOn) {
        en.crystalPts.material.opacity = Math.max(0, Math.min(1, 0.45 + chargeE * 0.45));
      }
    }

    // ==================== 朝向（v45：改为读模拟层）====================
    // 这里原来自己拿位置增量 atan2 出朝向。那份角度**只存在于渲染层**，
    // 模拟层看不见，于是"必须转过来才能打"根本没法按它判 ——
    // 而且无头模式（tests / balance_matrix）里连这段代码都不跑，规则会在
    // 最需要它的地方（平衡测量）静默消失。
    // 现在朝向由 FacingSystem 维护在 entity._facing 上，渲染层**只读**。
    // 一个量一个来源：本仓库反复出事的形状就是同一个量两处各算一份。
    //
    // 仍然保留渲染侧的平滑插值：模拟 30Hz、渲染 60Hz，直接贴 _facing 会有台阶感。
    // 塔没有 _facing（豁免），en.facing 为 false，整段跳过。
    // ==================== 塔：沿兵线朝向敌方（v45，静态）====================
    // 用户："路径上塔的朝向也需要修改……另一阵营同理。"
    // 塔**不参与**上面那套动态转向（战斗规则里塔是豁免的），它只是摆放角度不同：
    // 每座塔面朝自己这一路的敌人来向，红蓝镜像。算一次就固定，不随帧变。
    //
    // en.faceFixed 这个字段**本来就在 entry 里**，声明了却从没被读写过 —— 是个死字段，
    // 显然当初想做这件事没做完。现在把它做实，而不是再加一个新字段。
    if (en.isTower && this.mapSystem?.currentMap) {
      if (en.faceFixed === null) en.faceFixed = towerFacingRad(e, this.mapSystem.currentMap);
      // ⚠️ 每帧**都要赋**，不能只在算出来那一次赋。
      // 换模型时（损毁档跳变、变废墟、幽灵态）_installUnit 会把 en.unit 整个换掉，
      // 新对象的 rotation 是 0 —— 只赋一次的话，塔一掉血就会"啪"地转回正北。
      // 赋值本身是一次浮点写入，比记一个"要不要重赋"的脏标记还便宜。
      if (en.faceFixed !== null) en.unit.rotation.y = en.faceFixed;
    }
    if (en.facing) {
      if (e._facing !== undefined) en.faceT = e._facing;
      if (en.faceT !== undefined) {
        let d = en.faceT - en.faceA;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        en.faceA += d * 0.18;   // 转向平滑系数：掉头约 20 帧转完，快而不生硬
        // Q3：GLB 小兵模型的正面轴与塔同一套偏移；程序化几何朝 +Z 建，偏移为 0。
        en.unit.rotation.y = en.faceA;   // v44：GLB 删除后不再有朝向偏置（程序化模型一律朝 +Z 建）
      }
    }
    en.bar.position.set(e.pos.x, gy + (en.topY || 0) * s, e.pos.y);

    // 血条显示（Q4）：废墟不显示；建筑若【结构保护 && 满血】不显示（掉血或已解除保护才显示）；
    // 龙/小兵照旧（幽灵水晶显示灰色重生条——那不是血条，保留）。
    let showBar;
    if (ruin) {
      showBar = false;
    } else if (e.type === 'tower' && !ghost) {
      const mHP = attrCalc.calc(e, effects.getEffects(e.id)).maxHP || 1;
      const full = e.currentHP >= mHP - 1e-6;
      showBar = !(full && isStructureProtected(entities, e));
    } else {
      showBar = ghost || e.type === 'dragon' || !lodHideBar;
    }
    en.bar.visible = showBar;
    if (showBar) {
      let barKey, maxHP = 1;
      if (ghost) {
        barKey = 'g|' + Math.round((e._respawnProgress || 0) * BAR_W);
      } else {
        maxHP = attrCalc.calc(e, effects.getEffects(e.id)).maxHP || 1;
        const realFrac = Math.max(0, Math.min(1, e.currentHP / maxHP));
        // 掉血拖尾：显示血量 dispFrac 向真实血量插值。仅掉血启动；回血/首帧直接贴齐。
        // 动画期内 dispFrac 量化值入 barKey → 每帧重绘；追平后去掉该项 → 停重绘（有界，非每帧）。
        // v47：缓动/贴齐搬进 barTrail.stepTrail —— 属性面板那条拖尾要用**同一份**参数
        // （用户："统一为画面中的拖尾特效"）。行为与改动前逐位一致：同样的 dt*7、同样的 1/BAR_W。
        const dt = Math.max(0, Math.min(0.05, tNow - (en._lastT || tNow))); en._lastT = tNow;
        const tr = stepTrail(en.dispFrac, realFrac, dt, 1 / BAR_W);
        en.dispFrac = tr.disp; en.trailing = tr.trailing;
        const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * BAR_W);
        // v51：资源条（法力/升温/闪电充能/攻城充能）跟着血条同一张纹理画——脏 key 必须
        // 把资源分数也算进去，否则只有资源在变、血量不变时永远不会触发重绘（见下面 _redrawBar）。
        var resInfo = resourceInfoOf(e, { skillLibrary: SkillLibrary, attrCalc, effects });
        barKey = q(realFrac) + '|' + q((e.shieldFixedCurrent || 0) / maxHP) + '|'
               + q((e.tempShield || 0) / maxHP) + '|' + (e._mapFaction || e.faction || '')
               + '|p' + (e.type === 'tower' ? nextPlatingNode(e) : '')  // E1：节点值入脏 key，破节点才重绘
               + (en.trailing ? '|t' + q(en.dispFrac) : '')
               + (resInfo ? '|r' + q(resInfo.frac) + resInfo.kind : '');
      }
      if (en.barKey !== barKey) {
        en.barKey = barKey;
        this._redrawBar(en.barCanvas.getContext('2d'), e, ghost, maxHP, (!ghost && en.trailing) ? en.dispFrac : 0, resInfo);
        en.barTex.needsUpdate = true;   // 脏标记：只有走到这里才触发纹理上传
      }
    }

    // E 组（第 3.7 步）：仅活体塔挂附属信息；幽灵（重生中）与损毁塔一律清干净（同 entry 复用）
    if (e.type === 'tower' && !ghost && !ruin) {
      this._syncTowerInfo(e, en, ctxDeps, lodHideBar,
                          ctxDeps.getSelectedId ? ctxDeps.getSelectedId() : null);
    }
    else if (en.rangeFill || en.own || en.soul || en.shield) this._clearInfo(en);

    // F1 选中光圈（第4步）：所有类型都可选中，含幽灵水晶
    this._syncSelection(e, en, vis, ctxDeps.getSelectedId ? ctxDeps.getSelectedId() : null);
  }

  /**
   * 每帧同步。deps = { entities, attrCalc, effects }；rel = 当前缩放/全图缩放（LOD 用）。
   */
  update(deps, rel, tNow) {
    this._frame++;
    const lodHideBar = rel < 1.35;   // 与 2D 的 lodBars 阈值同值
    const { entities } = deps;

    for (const t of entities.getAllTowers(true)) this._syncOne(t, false, deps, lodHideBar, tNow);
    for (const m of entities.getAllMinions(true)) this._syncOne(m, false, deps, lodHideBar, tNow);
    // 死亡结构全量扫描（空间网格只索引活体，见 CanvasController 同处注释）：
    //   ① 重生中的分路水晶（_respawnAt）→ 半透明幽灵 + 灰色重生条（原样）；
    //   ② A1 损毁塔/水晶（_ruin）→ 不透明损毁模型，不再半透明、不挂附属信息。
    for (const c of entities.getAllTowers(false)) {
      if (c.alive) continue;
      if (c._respawnAt) this._syncOne(c, true, deps, lodHideBar, tNow, false);
      else if (c._ruin) this._syncOne(c, false, deps, lodHideBar, tNow, true);
    }

    // 兜底扫描：本帧没被遍历到的一律删（死亡事件漏发/purgeDead/切图/测试直改容器全覆盖）
    for (const [id, en] of this.map) {
      if (en.seen !== this._frame) this.remove(id);
    }
  }
}
