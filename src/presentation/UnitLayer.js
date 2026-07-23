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
import { MINION_STYLE } from './SpriteFactory.js';   // 第 6.3 步：本体改网格后不再需要精灵工厂
import { CONFIG } from '../data/Config.js';
import { isStructureProtected } from '../systems/FactionSystem.js';
import { nextPlatingNode } from './UnitInfo.js';
import { towerMesh, minionMesh, dragonMesh, unitMaterial, needsFacing } from './UnitMeshFactory.js';

const ORDER_UNIT = 10, ORDER_BAR = 20;
const ORDER_RING = 5, ORDER_SHIELD = 21; // 贴地环垫在单位下；盾牌浮于血条上
const _EMPTY_GEO = new THREE.BufferGeometry();  // Mesh 首帧占位，随即被 _visualOf 的共享几何替换
const RING_LIFT = 0.6;   // 贴地环离地高度，避开与地面平面 z-fighting（与 EffectsLayer 同值）
const ORDER_SEL = 6;                     // 选中光圈压在射程圈之上、单位之下

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
    this.infoObjs = 0;             // E 组场景对象计数（sceneStats 用：children = 2×tracked + infoObjs + fx）
  }


  // ============ 单位外观（key + 贴图）：与 CanvasRenderer 渲染循环同口径 ============
  // 返回 { key, sp, size, barW, barH, barD, alpha, pulse }
  //   key 变（换武器/换阵营/改模型大小/水晶转幽灵）→ 换贴图；size = 精灵世界边长。
  _visualOf(e, ghost) {
    if (e.type === 'tower') {
      const bSizes = CONFIG.buildingSizes || {};
      const bSize = e._modelSize || bSizes[e._mapTier] || bSizes.default || 28;
      const isNexus = e._mapTier === 'nexus_lane' || e._mapTier === 'nexus_main';
      const color = ghost
        ? (e._mapFaction === 'blue' ? '#5b9bd5' : '#e0473f')
        : (e._mapFaction === 'blue' ? '#5b9bd5' : e._mapFaction === 'red' ? '#e0473f' : '#8a92a0');
      const wInst = ghost ? null : (e._skillInstances || []).find(s => s.skillId.startsWith('weapon_'));
      // 第 6.3 步：纸片人 → 程序化三维几何。key 语义不变（换武器/阵营/尺寸/转幽灵才换模型），
      // 只是 key 现在索引的是几何而不是贴图，共享策略与缓存生命周期完全照旧。
      const kind = e._mapTier === 'nexus_lane' ? 'orb' : (isNexus ? 'gem' : 'tower');
      const wid = wInst ? wInst.skillId : '';
      const key = `t|${color}|${wid}|${kind}|${bSize}|${ghost ? 'g' : ''}`;
      const m = towerMesh(key, color, bSize, wid, kind, ghost);
      return { key, geo: m.geo, mat: m.mat, topY: m.topY, size: bSize,
               barW: 80, barH: 6, barD: 10, alpha: ghost ? 0.35 : 1, pulse: false,
               ringR: bSize + 8 };   // F1 选中光圈半径：与 2D 的 _drawSelectionRing 同值
    }
    if (e.type === 'dragon') {
      const color = e._dragonColor || '#c0392b';
      const anc = !!e._isAncient;
      const size = anc ? 30 : 24;
      const key = `d|${color}|${anc ? 1 : 0}`;
      const m = dragonMesh(key, color, anc);
      return { key, geo: m.geo, mat: m.mat, topY: m.topY, size,
               barW: 100, barH: 7, barD: 12, alpha: 1, pulse: true,
               ringR: size + 5 };
    }
    const st = MINION_STYLE[e.type] || { color: '#c0392b', icon: '❓', size: 10 };
    const faction = e._mapFaction || e.faction;
    // 阵营色优先于兵种色：立体化后兵种靠【造型】区分，颜色让位给敌我识别
    const color = faction === 'blue' ? '#5b9bd5' : faction === 'red' ? '#e0473f' : st.color;
    const key = `m|${e.type}|${faction || 'none'}`;
    const m = minionMesh(key, color, st.size, e.type);
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
    const entry = { unit, bar, barCanvas, barTex, visKey: '', barKey: '', seen: 0, topY: 0, isTower: false, faceA: 0, lastX: null, lastZ: null, facing: false,
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
  muzzleY(x, z, r = 26) {
    let best = 0, bestD = r * r;
    for (const [id, en] of this.map) {
      const dx = en.unit.position.x - x, dz = en.unit.position.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = en.topY || 0; }
    }
    return best;
  }

  setShadowLevel(level) {
    this.shadowLevel = level;
    // 已在场的单位立即生效：visKey 未变不会重走装配分支，故这里直接刷一遍
    for (const en of this.map.values()) {
      en.unit.castShadow = level === 'all' || (level === 'static' && en.isTower);
      en.unit.receiveShadow = level !== 'off';
    }
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
    en.selCore.position.set(e.pos.x, RING_LIFT, e.pos.y);
    en.selGlow.position.set(e.pos.x, RING_LIFT, e.pos.y);
  }

  _clearInfo(en) {
    this._clearSel(en);
    en.rangeFill = this._removeFlat(en.rangeFill);
    en.rangeEdge = this._removeFlat(en.rangeEdge);
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

  // ============ E 组同步（仅活体塔；幽灵与非塔一律清空） ============
  _syncTowerInfo(e, en, ctxDeps, lodHideBar) {
    const { attrCalc, effects, entities } = ctxDeps;
    const bSizes = CONFIG.buildingSizes || {};
    const bSize = e._modelSize || bSizes[e._mapTier] || bSizes.default || 28;
    const isNexus = e._mapTier === 'nexus_lane' || e._mapTier === 'nexus_main';
    const color = e._mapFaction === 'blue' ? '#5b9bd5' : e._mapFaction === 'red' ? '#e0473f' : '#8a92a0';
    const x = e.pos.x, z = e.pos.y;

    // --- E3 射程圈：hasWeapon && !isNexus && !lodBars（与 2D 逐字同条件） ---
    // 半径每帧读 attrCalc（buff/天气可变），量化 4px 步长做几何缓存 key（见头注刻意差异）。
    // attrCalc.calc 与血条处各调一次：≤30 塔的重复计算换第 3 步已验收路径零改动。
    const hasWeapon = (e._skillInstances || []).some(sk => sk.skillId.startsWith('weapon_'));
    if (hasWeapon && !isNexus && !lodHideBar) {
      const range = attrCalc.calc(e, effects.getEffects(e.id)).attackRange || 250;
      const r = Math.round(range / 4) * 4;
      const rk = r + '|' + color;
      if (en.rangeKey !== rk) {
        en.rangeKey = rk;
        en.rangeFill = this._removeFlat(en.rangeFill);
        en.rangeEdge = this._removeFlat(en.rangeEdge);
        en.rangeFill = this._flatMesh(this._flatGeo('disc', r), this._flatMat(color, 0x0f / 255));
        en.rangeEdge = this._flatMesh(this._flatGeo('ring', r, 1), this._flatMat(color, 0x33 / 255));
      }
      en.rangeFill.position.set(x, RING_LIFT, z);
      en.rangeEdge.position.set(x, RING_LIFT, z);
    } else if (en.rangeFill) {
      en.rangeFill = this._removeFlat(en.rangeFill);
      en.rangeEdge = this._removeFlat(en.rangeEdge);
      en.rangeKey = '';
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
      en.own.position.set(x, RING_LIFT, z);
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
      en.soul.position.set(x, RING_LIFT, z);
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
      en.shield.position.set(x, en.topY || 0, z);
    } else if (en.shield) {
      this.scene.remove(en.shield); this.infoObjs--;
      en.shield.material.dispose();
      en.shield = null; en.shieldOn = false;
    }
  }

  // ============ 血条重绘（复刻 drawHealthBar 的配色与布局，去拖尾） ============
  _redrawBar(g, e, ghost, maxHP) {
    g.clearRect(0, 0, BAR_W, BAR_H);
    if (ghost) {
      const prog = Math.max(0, Math.min(1, e._respawnProgress || 0));
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, BAR_W, BAR_H);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, 0, BAR_W, BAR_H);
      g.fillStyle = '#9aa3ae'; g.fillRect(0, 0, BAR_W * prog, BAR_H);
      return;
    }
    if (maxHP <= 0) return;
    const hpFrac = Math.max(0, Math.min(1, e.currentHP / maxHP));
    const faction = e._mapFaction || e.faction;
    const defaultColor = e.type === 'tower' ? '#4a9eff' : '#4caf50';
    const hpColor = faction === 'blue' ? '#4a9eff' : faction === 'red' ? '#ff5a5a' : defaultColor;
    const shieldTotal = (e.shieldFixedCurrent || 0) + (e.tempShield || 0);
    const shieldFrac = Math.max(0, Math.min(1, shieldTotal / maxHP));
    const total = hpFrac + shieldFrac;
    const scale = total > 1 ? 1 / total : 1;
    const hpDraw = hpFrac * scale;
    const fixedShare = shieldTotal > 0 ? (e.shieldFixedCurrent || 0) / shieldTotal : 0;
    const tempShare = shieldTotal > 0 ? (e.tempShield || 0) / shieldTotal : 0;
    const sfW = shieldFrac * scale * fixedShare;
    const stW = shieldFrac * scale * tempShare;

    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, BAR_W, BAR_H);
    g.fillStyle = hpColor; g.fillRect(0, 0, BAR_W * hpDraw, BAR_H);
    if (sfW > 0.001) { g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(BAR_W * hpDraw, 0, BAR_W * sfW, BAR_H); }
    if (stW > 0.001) { g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(BAR_W * (hpDraw + sfW), 0, BAR_W * stW, BAR_H); }
    g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, BAR_W - 1, BAR_H - 1);

    // E1 镀层节点线：2D 是 1.5px 白线上下各溢出 1.5px；纹理内画 2px 竖线不出条（头注记档）
    if (e.type === 'tower') {
      const node = nextPlatingNode(e);
      if (node !== null) {
        g.fillStyle = '#ffffff';
        g.fillRect(Math.round(BAR_W * node) - 1, 0, 2, BAR_H);
      }
    }
  }

  _syncOne(e, ghost, ctxDeps, lodHideBar, tNow) {
    const { attrCalc, effects } = ctxDeps;
    let en = this.map.get(e.id);
    if (!en) en = this._makeEntry(e.id);
    en.seen = this._frame;

    const vis = this._visualOf(e, ghost);
    if (en.visKey !== vis.key) {
      en.visKey = vis.key;
      en.unit.geometry = vis.geo;      // 共享几何，直接换引用（旧的属于缓存，不释放）
      en.unit.material = vis.mat;
      en.topY = vis.topY;
      en.isTower = e.type === 'tower';   // 阴影档位判据：读实体类型，不靠模型高度猜
      en.facing = !!vis.facing;
      en.unit.castShadow = this.shadowLevel === 'all'
        || (this.shadowLevel === 'static' && en.isTower);
      en.unit.receiveShadow = this.shadowLevel !== 'off';
      en.bar.scale.set(vis.barW, vis.barH, 1);
      // 血条现在浮在【模型顶端】的世界高度上，再用 center 做一点屏幕空间余量。
      // 纸片人时代 barD 要补出整个贴图高度，立体化后模型自己有高度，余量因此小得多。
      en.bar.center.set(0.5, 0.5 - vis.barD / vis.barH);
    }
    // 脉动（巨龙）改为整体缩放模型本身，与纸片人时代同一近似
    const s = vis.pulse ? (1 + 0.12 * Math.sin(tNow * 3)) : 1;
    en.unit.scale.set(s, s, s);
    en.unit.position.set(e.pos.x, 0, e.pos.y);

    // 朝向：由【位置增量】自己算，逻辑层不需要提供 facing 字段。
    // 模拟跑 30Hz、渲染跑 60Hz，因此有一半的帧位移为 0——那时保持上一次朝向，不要清零。
    // 角度做最短弧插值（跨 ±π 时不绕远路），避免掉头瞬间原地转一圈。
    if (en.facing) {
      if (en.lastX !== null) {
        const dx = e.pos.x - en.lastX, dz = e.pos.y - en.lastZ;
        if (dx * dx + dz * dz > 0.25) en.faceT = Math.atan2(dx, dz);   // 模型一律朝 +Z 建
      }
      en.lastX = e.pos.x; en.lastZ = e.pos.y;
      if (en.faceT !== undefined) {
        let d = en.faceT - en.faceA;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        en.faceA += d * 0.18;   // 转向平滑系数：掉头约 20 帧转完，快而不生硬
        en.unit.rotation.y = en.faceA;
      }
    }
    en.bar.position.set(e.pos.x, (en.topY || 0) * s, e.pos.y);

    // 血条：塔/龙/幽灵始终显示；小兵条受 LOD 档1 控制（与 2D 的 lodBars 同口径）
    const showBar = ghost || e.type === 'tower' || e.type === 'dragon' || !lodHideBar;
    en.bar.visible = showBar;
    if (showBar) {
      let barKey, maxHP = 1;
      if (ghost) {
        barKey = 'g|' + Math.round((e._respawnProgress || 0) * BAR_W);
      } else {
        maxHP = attrCalc.calc(e, effects.getEffects(e.id)).maxHP || 1;
        const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * BAR_W);
        barKey = q(e.currentHP / maxHP) + '|' + q((e.shieldFixedCurrent || 0) / maxHP) + '|'
               + q((e.tempShield || 0) / maxHP) + '|' + (e._mapFaction || e.faction || '')
               + '|p' + (e.type === 'tower' ? nextPlatingNode(e) : '');  // E1：节点值入脏 key，破节点才重绘
      }
      if (en.barKey !== barKey) {
        en.barKey = barKey;
        this._redrawBar(en.barCanvas.getContext('2d'), e, ghost, maxHP);
        en.barTex.needsUpdate = true;   // 脏标记：只有走到这里才触发纹理上传
      }
    }

    // E 组（第 3.7 步）：活体塔挂附属信息；塔转幽灵（水晶陷落）同一 entry 复用，必须清干净
    if (e.type === 'tower' && !ghost) this._syncTowerInfo(e, en, ctxDeps, lodHideBar);
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
    // 幽灵水晶（alive=false + _respawnAt）：与 2D 同款半透明 + 灰色重生条。
    // 必须全量扫描——空间网格只索引活体（见 CanvasController 同处注释）。
    for (const c of entities.getAllTowers(false)) {
      if (!c.alive && c._respawnAt) this._syncOne(c, true, deps, lodHideBar, tNow);
    }

    // 兜底扫描：本帧没被遍历到的一律删（死亡事件漏发/purgeDead/切图/测试直改容器全覆盖）
    for (const [id, en] of this.map) {
      if (en.seen !== this._frame) this.remove(id);
    }
  }
}
