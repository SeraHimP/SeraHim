/**
 * CanvasRenderer.js - 渲染画布
 */

// v2.5D 第3步：MINION_STYLE 已抽到 ./SpriteFactory.js（Billboard 与 2D 共用同一套样式表）。
import { isStructureProtected } from '../systems/FactionSystem.js';
import { CONFIG } from '../data/Config.js';
import { buildTerrainLayer } from './TerrainLayer.js';
import { nextPlatingNode } from './UnitInfo.js';
import { getSprite, towerSprite, minionSprite, MINION_STYLE, minionStyle, WEAPON_ICONS } from './SpriteFactory.js';

export class CanvasRenderer {
  constructor(canvas, entityContainer, effectRegistry, attrCalc, projectileSystem) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.entities = entityContainer;
    this.effects = effectRegistry;
    this.attrCalc = attrCalc;
    this.projectiles = projectileSystem;

    this.viewOffsetX = 0;
    this.viewOffsetY = 0;
    this.viewZoom = 1.0;
    this.selectedId = null; // 点选面板当前选中的单位（绘制选中光圈）

    // ==================== 性能：预渲染精灵缓存 ====================
    // 卡顿根因之一：每帧对每个单位做 emoji fillText（字体光栅化极慢）和 shadowBlur
    // （CPU 逐次高斯模糊，2D canvas 最贵操作，30 座塔每帧模糊 30 次）。
    // 解法：每种"塔样式/兵种"只画一次到离屏 canvas（含光晕，用径向渐变替代 shadowBlur），
    // 之后每帧只 drawImage——快一个数量级以上。缓存按样式 key 惰性生成。
    this._spriteCache = new Map();   // key -> { canvas, half }（half = 逻辑半宽，绘制时居中）
    this._glowGradCache = new Map(); // 子弹光晕精灵：color -> canvas

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    this.canvas.width = width * window.devicePixelRatio;
    this.canvas.height = height * window.devicePixelRatio;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this.width = width;
    this.height = height;
  }

  // v2.5D 第3步：实现已抽到 ./SpriteFactory.js（缓存亦提为模块级共享），此处转调。
  _getSprite(key, logicalSize, drawFn) {
    return getSprite(key, logicalSize, drawFn);
  }

  _drawSprite(ctx, sp, x, y) {
    ctx.drawImage(sp.canvas, x - sp.half, y - sp.half, sp.size, sp.size);
  }

  // v2.5D 第3步：实现已抽到 ./SpriteFactory.js，此处转调。
  _towerSprite(color, icon, size = 28) {
    return towerSprite(color, icon, size);
  }

  // v2.5D 第3步：实现已抽到 ./SpriteFactory.js（Billboard 纹理复用同一套绘制），此处转调。
  _minionSprite(type, faction, icon, size) {
    return minionSprite(type, faction, icon, size);
  }

  // 子弹光晕精灵（替代每帧 createRadialGradient 分配）
  _glowSprite(color) {
    let c = this._glowGradCache.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 60;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(30, 30, 0, 30, 30, 30);
    grad.addColorStop(0, color + 'cc');
    grad.addColorStop(0.5, color + '66');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, 60, 60);
    this._glowGradCache.set(color, c);
    return c;
  }

  // 点选命中半径查询（CanvasController 用）
  getBuildingSize(t) {
    const bs = CONFIG.buildingSizes || {};
    return t._modelSize || bs[t._mapTier] || bs.default || 28; // v33 Q13：单塔覆写
  }
  getMinionSize(m) {
    return minionStyle(m.type).size || 10;
  }

  // 选中光圈（LoL 式绿色描边圈）
  _drawSelectionRing(ctx, x, y, r) {
    ctx.strokeStyle = '#7ef0a0';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = 'rgba(126,240,160,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 2 * Math.PI); ctx.stroke();
  }

  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w === 0 || h === 0) return;

    ctx.clearRect(0, 0, w, h);

    // 应用视口变换
    ctx.save();
    ctx.translate(this.viewOffsetX, this.viewOffsetY);
    ctx.scale(this.viewZoom, this.viewZoom);

    // 网格：只画当前可视的世界区域（按视口反算），且全部线段合并进一条 path、
    // 一次 stroke——旧写法每帧 230 次独立 beginPath/stroke 各跨 4600px，是渲染热点之一。
    {
      const STEP = 40, LIM_MIN = -500, LIM_MAX = 4100;
      const vx0 = Math.max(LIM_MIN, Math.floor(((-this.viewOffsetX) / this.viewZoom) / STEP) * STEP);
      const vy0 = Math.max(LIM_MIN, Math.floor(((-this.viewOffsetY) / this.viewZoom) / STEP) * STEP);
      const vx1 = Math.min(LIM_MAX, (w - this.viewOffsetX) / this.viewZoom + STEP);
      const vy1 = Math.min(LIM_MAX, (h - this.viewOffsetY) / this.viewZoom + STEP);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = vx0; x < vx1; x += STEP) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
      for (let y = vy0; y < vy1; y += STEP) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
      ctx.stroke();
    }

    // v33（Q8）：地图墙壁地形层——预渲染的"峡谷"底图（丛林=墙，走廊=可行走路面，河道装饰）
    if (this.mapSystem?.hasWalls?.() && this.mapSystem.currentMap?.world) {
      const { w: WW, h: WH } = this.mapSystem.currentMap.world;
      ctx.drawImage(this._terrainLayer(this.mapSystem.currentMap), 0, 0, WW, WH);
    }

    // 对战模式：世界边界框 + 双方基地高地区域（扇形），提供"这是峡谷"的空间参照
    if (this.mapSystem?.active && this.mapSystem.currentMap?.world) {
      const { w: WW, h: WH } = this.mapSystem.currentMap.world;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 4;
      ctx.strokeRect(0, 0, WW, WH);
      // 蓝方/红方高地扇形：半径 = 该方最远己方建筑距基地角点的距离 + 余量。
      // 原为写死的 WW*0.37（按峡谷比例调的），在小图（嚎哭深渊 1900）上会把圈画成半张地图。
      // 现按地图实际建筑布局计算，任何尺寸的地图都正确。
      // 基地圈 = 高地区域：覆盖到【水晶塔塔身】为止（用户指定）——即枢纽 + 枢纽塔 + 召唤水晶 + 水晶塔。
      // 外塔/内塔是前线塔，仍在圈外。半径由地图实际几何算出，任何尺寸的地图都正确
      // （原为写死的 WW×0.37，在小图上会把圈画成半张地图）。
      // v33（Q9）：基地圈半径改由 MapSystem 统一提供——基地光环与画布圈是同一份数据
      // 基地圈默认不画（CONFIG.tuning.showBaseCircle，设置里可开）。
      // 而且这里的圆心一直写死在世界角点上，对 baseCenters 不在角上的地图本来就画错位置。
      if (CONFIG.tuning?.showBaseCircle) {
      const baseR = this.mapSystem.getBaseCircleRadius?.('blue') || WW * 0.37;
      const baseR2 = this.mapSystem.getBaseCircleRadius?.('red') || baseR;
      ctx.fillStyle = 'rgba(91,155,213,0.07)';
      ctx.beginPath(); ctx.moveTo(0, WH); ctx.arc(0, WH, baseR, -Math.PI / 2, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(224,71,63,0.07)';
      ctx.beginPath(); ctx.moveTo(WW, 0); ctx.arc(WW, 0, baseR2, Math.PI / 2, Math.PI); ctx.closePath(); ctx.fill();
      }
      
      // EQ3：新增的参考线与原有兵线虚线叠加（虚线叠虚线），已回退，保留原有渲染。
      ctx.restore();
    }

    // 对战模式：绘制地图路径线（半透明虚线）。v33（Q18）：地图有墙壁时走廊本身就是
    // 可视路线，虚线默认隐藏，设置里"显示小兵轨迹"可开。无墙地图维持原行为（常显）。
    if (this.mapSystem?.active && this.mapSystem.currentMap &&
        (!this.mapSystem.hasWalls?.() || window.__showLanePaths)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(246,201,74,0.25)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      for (const lane of this.mapSystem.currentMap.lanes) {
        ctx.beginPath();
        lane.waypoints.forEach((wp, i) => {
          if (i === 0) ctx.moveTo(wp.x, wp.y);
          else ctx.lineTo(wp.x, wp.y);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 塔：塔身/射程圈颜色 = 阵营色（v33 Q6，原按武器着色）；塔上的【图标】仍随武器。
    const WEAPON_STYLE = WEAPON_ICONS; // v2.5D 第3步：表体挪进 SpriteFactory（两个渲染器共用），此处仅保留别名
    // Q5：等待重生的召唤水晶尸体——半透明幽灵渲染（可点选查看重生倒计时，不参与战斗）
    for (const corpse of this.entities.getAllTowers(false)) {
      if (corpse.alive || !corpse._respawnAt) continue;
      const cSizes = CONFIG.buildingSizes || {};
      const cSize = cSizes[corpse._mapTier] || cSizes.default || 28;
      const cColor = corpse._mapFaction === 'blue' ? '#5b9bd5' : '#e0473f';
      ctx.save();
      ctx.globalAlpha = 0.35;
      this._drawSprite(ctx, this._towerSprite(cColor, corpse._mapTier === 'nexus_lane' ? '🔮' : '💎', cSize), corpse.pos.x, corpse.pos.y);
      ctx.restore();

      // Q3：重生进度画在血条位置——灰色充能条，填满即重生（进度由 MapSystem 每帧写入）
      const prog = corpse._respawnProgress || 0;
      const bw = 80, bh = 6;
      const bx = corpse.pos.x - bw / 2, by = corpse.pos.y - cSize - 16;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#9aa3ae';                       // 灰色：区别于血条的红/绿
      ctx.fillRect(bx, by, bw * prog, bh);
      // Q6：进度条上方的倒计时数字已移除（进度条本身就够了）

      if (corpse.id === this.selectedId) this._drawSelectionRing(ctx, corpse.pos.x, corpse.pos.y, cSize + 8);
    }

    // LOD（细节层级）：低缩放下人眼不可辨的细节直接不画（LoL 小地图同款思路）。
    //
    // Q11：阈值必须【相对于"全图视角"的缩放】，不能写死绝对值。
    // 原因：不同地图世界尺寸不同（峡谷 3552、深渊 2325），"能看到整张图"所需的缩放
    // 本来就不一样——同一个绝对值 0.5 在两图上意义完全不同（在小图上可能还是特写，
    // 在大图上已经是全景）。以 fitZoom（刚好装下整张地图的缩放）为基准做相对判断，
    // 任何尺寸的地图行为都一致。
    const fitZoom = this._fitZoom || 1;
    const rel = this.viewZoom / fitZoom;   // 1.0 = 刚好全图视角；>1 放大；<1 缩得更小
    const lodBars = rel < 1.35;            // 档1：接近全图视角时隐藏小兵血条与塔范围圈
    const lodDots = rel < 1.02;            // 档2（v33 Q5）：🎯 全图视角（含）及更小 → 小兵退化为阵营色圆点
    const towers = this.entities.getAllTowers(true);
    for (const t of towers) {
      const x = t.pos.x, y = t.pos.y;
      const wInst = (t._skillInstances || []).find(s => s.skillId.startsWith('weapon_'));
      const hasWeapon = !!wInst;
      const style = (wInst && WEAPON_STYLE[wInst.skillId]) || { icon: '🏰' };
      const isNexus = t._mapTier === 'nexus_lane' || t._mapTier === 'nexus_main';
      // v33（Q6）：塔身与射程圈统一阵营色；沙盒中立塔灰白
      const color = t._mapFaction === 'blue' ? '#5b9bd5' : t._mapFaction === 'red' ? '#e0473f' : '#8a92a0';
      const range = this.attrCalc.calc(t, this.effects.getEffects(t.id)).attackRange || 250;

      // 无武器时不显示攻击范围圈；低缩放（<0.5）时全部隐藏（LOD）
      if (hasWeapon && !isNexus && !lodBars) {
        ctx.beginPath();
        ctx.arc(x, y, range, 0, 2 * Math.PI);
        ctx.fillStyle = color + '0f';
        ctx.fill();
        ctx.strokeStyle = color + '33';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 塔本体 + 光晕 + 图标：预渲染精灵一次 drawImage（原 shadowBlur 是最大渲染热点）。
      // 体积按 tier 区分（CONFIG.buildingSizes，模板编辑器可调）；沙盒塔无 tier 用 default。
      const bSizes = CONFIG.buildingSizes || {};
      const bSize = t._modelSize || bSizes[t._mapTier] || bSizes.default || 28; // v33 Q13：单塔可覆写模型大小
      // EQ5：图标与塔身技能一致——召唤水晶 🔮（core_nexus_lane）、水晶枢纽 💎（core_nexus_main）
      const towerIcon = t._mapTier === 'nexus_lane' ? '🔮' : (isNexus ? '💎' : (hasWeapon ? style.icon : ''));
      this._drawSprite(ctx, this._towerSprite(color, towerIcon, bSize), x, y);

      // EQ2：手动建造的对战塔（有阵营、无地图层级）画阵营归属环——中立为灰白色
      if (t._mapFaction && !t._mapTier) {
        ctx.strokeStyle = t._mapFaction === 'blue' ? '#5b9bd5' : (t._mapFaction === 'red' ? '#e0473f' : '#e8e8e8');
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, bSize + 4, 0, 2 * Math.PI); ctx.stroke();
      }

      // 结构保护标识（v36 Q3：统一到所有受保护塔，不再限 isNexus——外/内/水晶塔受保护时也画盾牌）
      if (isStructureProtected(this.entities, t)) {
        // v40 修复：盾牌此前直接沿用上游残留的 fillStyle/globalAlpha（血条那段会把它们改成
        // 半透明），于是普通防御塔上的盾牌看起来是"透明的"，而水晶/枢纽那条绘制路径恰好
        // 残留的是实色 → 两者观感不一致。现在用 save/restore 显式锁死不透明实色，
        // 所有受保护建筑的盾牌完全一致。
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.font = '15px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🛡️', x, y - bSize - 26); // 血条在 y - bSize - 16，盾牌再往上 10px 居中
        ctx.restore();
      }

      // 龙魂光环（有龙魂时外圈金环）
      const hasSoul = (t._skillInstances || []).some(s => s.skillId.startsWith('dragonsoul_'));
      if (hasSoul) {
        ctx.strokeStyle = '#f6c94a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 32, 0, 2 * Math.PI);
        ctx.stroke();
      }


      const maxHP = this.attrCalc.calc(t, this.effects.getEffects(t.id)).maxHP || 1;
      this.drawHealthBar(ctx, x, y - bSize - 16, 80, 6, t.currentHP, maxHP, t); // 建筑血条不参与 LOD，始终显示

      // v33（Q16）：装备"防御塔镀层"的塔，血条上用 | 标出【下一个镀层节点】（80/60/40/20%）
      const nextNode = this._nextPlatingNode(t);
      if (nextNode !== null) {
        const bw = 80, bh = 6, bx = x - bw / 2, by = y - bSize - 16;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx + bw * nextNode, by - 1.5);
        ctx.lineTo(bx + bw * nextNode, by + bh + 1.5);
        ctx.stroke();
      }

      // v35（Q4 定稿）：攻击指示红线——【前摇期间不显示】，锁定完成开火后才画。
      // 语义 = "这条线代表塔正在输出"，而不是"塔盯上了你"。线维持 0.5px 级细线。
      if (t.targetId && !((window.gameTime || 0) < (t._lockUntil || 0))) {
        const tgt = this.entities.get(t.targetId);
        if (tgt && tgt.alive && tgt.pos) {
          const AL = (CONFIG.ui && CONFIG.ui.aimLine) || {};
          ctx.strokeStyle = `rgba(255,60,60,${AL.alpha ?? 0.5})`;
          ctx.lineWidth = Math.max(AL.minWidth ?? 0.35, (AL.widthPx ?? 0.5) / this.viewZoom);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tgt.pos.x, tgt.pos.y); ctx.stroke();
        }
      }

      if (t.id === this.selectedId) this._drawSelectionRing(ctx, x, y, bSize + 8);
    }

    // 小兵 & 巨龙
    // LOD（细节层级）：缩放 < LOD_ZOOM 时小兵退化为纯色圆点、隐藏小兵血条与图标，
    // 建筑血条始终保留。低缩放下这些细节人眼本就不可辨（LoL 小地图上小兵也只是个点），
    // 省下的却是每帧几百次 drawImage/fillRect。
    const minions = this.entities.getAllMinions(true);
    for (const m of minions) {
      const x = m.pos.x, y = m.pos.y;

      if (m.type === 'dragon') {
        this._drawDragon(ctx, m);
        continue;
      }

      const st = minionStyle(m.type);   // 自制兵种取用户填的图标/颜色
      const color = st.color, size = st.size;

      // v40：攻城模式攻击指示红线——与防御塔同款（锁定建筑期间常驻，代表"正在攻城"）。
      // 判据用 _ramLockId：它只在装备了攻城武器被动、且锁定了活着的建筑时非空。
      if (m._ramLockId && !lodDots) {
        const lockTgt = this.entities.get(m._ramLockId);
        if (lockTgt && lockTgt.alive && lockTgt.pos) {
          ctx.save();
          // v43 Q4：与塔的红线完全一致（同一份 CONFIG.ui.aimLine），不再刻意画粗
          const AL = (CONFIG.ui && CONFIG.ui.aimLine) || {};
          ctx.strokeStyle = `rgba(255,60,60,${AL.alpha ?? 0.5})`;
          ctx.lineWidth = Math.max(AL.minWidth ?? 0.35, (AL.widthPx ?? 0.5) / this.viewZoom);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lockTgt.pos.x, lockTgt.pos.y); ctx.stroke();
          ctx.restore();
        }
      }

      if (lodDots) {
        // 档2：阵营色圆点，免 drawImage、免血条
        ctx.fillStyle = m._mapFaction === 'blue' ? '#5b9bd5' : (m._mapFaction === 'red' ? '#e0473f' : color);
        ctx.beginPath(); ctx.arc(x, y, Math.max(3, size * 0.8), 0, 2 * Math.PI); ctx.fill();
      } else {
        // 形状底 + emoji 预渲染精灵一次 drawImage（v33 Q6：底色按阵营、形状按兵种）
        this._drawSprite(ctx, this._minionSprite(m.type, m._mapFaction || m.faction, st.icon, size), x, y);
        if (!lodBars) {
          const maxHP = this.attrCalc.calc(m, this.effects.getEffects(m.id)).maxHP || 1;
          // v37：体积加大（7→10~14）后血条间距 10→6 收紧，消除"血条悬空错位"感
          this.drawHealthBar(ctx, x, y - size - 6, 40, 4, m.currentHP, maxHP, m);
        }
      }

      if (m.id === this.selectedId) this._drawSelectionRing(ctx, x, y, size + 5);
    }

    // 子弹（带发光拖尾）
    for (const p of this.projectiles.getProjectiles()) {
      const x = p.currentX !== undefined ? p.currentX : p.startX;
      const y = p.currentY !== undefined ? p.currentY : p.startY;
      const color = p.color || '#e8563f';

      // 发光光晕（渐变精灵缓存，避免每帧每弹分配 createRadialGradient）
      // v2.5D（Q1）：弹道统一到所有单位后，小兵/巨龙弹丸按 p.size 小一号（塔弹仍 20）
      const gsz = p.size || 20;
      ctx.drawImage(this._glowSprite(color), x - gsz / 2, y - gsz / 2, gsz, gsz);

      // 核心弹丸
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4 * gsz / 20, 0, 2 * Math.PI);
      ctx.fill();

      // 高光
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x - 1.5, y - 1.5, 1.5, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.restore();

    // 闪电杖光束（持久、全程全亮不闪）
    if (this.projectiles.getBeams) {
      for (const b of this.projectiles.getBeams()) {
        const charge = Math.max(0, Math.min(1, b.charge || 0));
        const lineWidth = 1.5 + charge * 3.5;

        ctx.save();
        ctx.translate(this.viewOffsetX, this.viewOffsetY);
        ctx.scale(this.viewZoom, this.viewZoom);

        // v36（Q2）：目标死亡/脱离后残留淡出——fadeT 存在时按剩余比例整体降 alpha。
        const fadeAlpha = (b.fadeT !== undefined && b.fadeMax) ? Math.max(0, b.fadeT / b.fadeMax) : 1;
        ctx.globalAlpha = fadeAlpha;
        const beamColor = b.color || '#f1c40f'; // 阵营色（闪电杖发射时已按阵营写入）
        const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
        const wallT = performance.now() / 1000;

        // ===== v36（Q2）：充能虚→实【连续过渡】=====
        // 旧实现 isFull 布尔突变（虚线→三层实线），临界点"啪"一下变。
        // 改为随 charge 连续插值三条量：
        //   ① 虚线间隙 gap：charge 0→1 时从"和实体等长"收缩到 0（→ 完全实线）；
        //   ② solidMix：实线成分权重，charge 高时叠加实线芯，避免虚线彻底消失前的突兀；
        //   ③ 白热核与辉光透明度随 charge 平滑淡入。满充只是这条连续曲线的终点，无突变。
        const dashLen = 5 + charge * 20;
        const gap = dashLen * (1 - charge) * 0.9 + (1 - charge) * 3; // charge→1 时 gap→0
        const flowSpeed = 60 + charge * 160;

        // 底层辉光（透明度随充能升）
        ctx.setLineDash([]);
        ctx.strokeStyle = beamColor + hex2(20 + charge * 90);
        ctx.lineWidth = lineWidth + 5 + charge * 9;
        ctx.beginPath(); ctx.moveTo(b.startX, b.startY); ctx.lineTo(b.endX, b.endY); ctx.stroke();

        // 主体：流动虚线（gap 随充能收缩 → 满充时 gap≈0 自然变实线）
        ctx.strokeStyle = beamColor;
        ctx.lineWidth = lineWidth;
        if (gap > 0.4) {
          ctx.setLineDash([dashLen, gap]);
          ctx.lineDashOffset = -((wallT * flowSpeed) % 100000);
        } else {
          ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.moveTo(b.startX, b.startY); ctx.lineTo(b.endX, b.endY); ctx.stroke();

        // 白热核：透明度随充能从 0 平滑升到 1（不再是满充才突然出现）
        const coreA = charge * charge; // 二次曲线，低充能几乎不可见，接近满充快速亮起
        if (coreA > 0.02) {
          ctx.setLineDash([]);
          ctx.strokeStyle = '#ffffff' + hex2(coreA * 255);
          const pulse = 1 + Math.sin(wallT * 10) * 0.15 * charge; // 脉冲幅度也随充能淡入
          ctx.lineWidth = Math.max(0.8, lineWidth * 0.35) * pulse;
          ctx.beginPath(); ctx.moveTo(b.startX, b.startY); ctx.lineTo(b.endX, b.endY); ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // v33：闪电链电弧（满充闪电杖的弹射特效）——锯齿折线，形状由种子决定（存活期内不变，不抖），
    // 随剩余寿命淡出。纯视觉，伤害在武器层早已结算。
    if (this.projectiles.getArcs) {
      const arcs = this.projectiles.getArcs();
      if (arcs.length) {
        ctx.save();
        ctx.translate(this.viewOffsetX, this.viewOffsetY);
        ctx.scale(this.viewZoom, this.viewZoom);
        for (const a of arcs) {
          const alpha = Math.max(0, a.ttl / a.maxTtl);
          const dx = a.endX - a.startX, dy = a.endY - a.startY;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len; // 法向
          const segs = Math.max(3, Math.min(6, Math.round(len / 30)));
          // 确定性抖动：同一条弧每帧形状一致
          let seed = a.seed;
          const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
          const pts = [{ x: a.startX, y: a.startY }];
          for (let i = 1; i < segs; i++) {
            const t = i / segs;
            const off = rnd() * Math.min(16, len * 0.18);
            pts.push({ x: a.startX + dx * t + nx * off, y: a.startY + dy * t + ny * off });
          }
          pts.push({ x: a.endX, y: a.endY });
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = a.color;
          ctx.lineWidth = 3.5;
          ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // Q10：画布左上角的调试文字（实体/弹道计数）已移除——同样的数据在 📊 性能面板里有
  }

  // ==================== v33（Q8）：地形层（墙壁）预渲染 ====================
  // 每张地图只烘焙一次（半分辨率离屏画布，绘制时放大）——运行时零开销。
  // 视觉编码：深色丛林 = 墙（不可行走），亮色走廊 = 兵线路面，斜向河道为装饰，
  // 走廊外沿一圈"墙缘"高光，读起来就是 LoL 小地图的结构。
  // v2.5D 第2步：实现已抽到 ./TerrainLayer.js（Three 地面贴图要复用同一张离屏画布，
  // 不能依赖 CanvasRenderer 实例）。此处保留方法名做转调，调用点与缓存行为不变。
  _terrainLayer(map) {
    return buildTerrainLayer(map);
  }

  // v33（Q16）：镀层节点。v2.5D 第 3.7 步：实现抽到 ./UnitInfo.js（3D 血条节点线复用），
  // 此处保留方法名转调，调用点不变。
  _nextPlatingNode(tower) { return nextPlatingNode(tower); }

  _drawDragon(ctx, d) {
    const x = d.pos.x, y = d.pos.y;
    const color = d._dragonColor || '#c0392b';
    const isAncient = d._isAncient;
    const size = isAncient ? 30 : 24;
    const t = (window.gameTime || 0);

    // 脉动光环
    const pulse = 1 + 0.12 * Math.sin(t * 3);
    ctx.save();
    ctx.globalAlpha = 0.25;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, size * 2.2 * pulse);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, size * 2.2 * pulse, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    // 本体
    // 龙只有一条，但 shadowBlur 单次也贵；本体渐变光晕已足够，去掉模糊
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isAncient) {
      ctx.strokeStyle = '#f6c94a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, size + 5, 0, 2 * Math.PI);
      ctx.stroke();
    }

    ctx.fillStyle = '#fff';
    ctx.font = (size + 8) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d._dragonIcon || '🐉', x, y);

    // 名称
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText((d.baseStats?.label || '巨龙'), x, y - size - 16);

    const maxHP = this.attrCalc.calc(d, this.effects.getEffects(d.id)).maxHP || 1;
    this.drawHealthBar(ctx, x, y - size - 10, 100, 7, d.currentHP, maxHP, d);
  }

  drawHealthBar(ctx, x, y, w, h, current, max, entity) {    if (max <= 0) return;
    const hpFrac = Math.max(0, Math.min(1, current / max));
    // v35（Q6）拖尾修复：改为跟踪【血量+护盾】总条宽。
    // 旧实现只跟踪血量，而护盾条画在血量右侧——恰好盖在拖尾露白的位置，
    // 有固定护盾的塔（水晶塔800盾）拖尾整段被护盾条吃掉，看起来"特效消失了"。
    // 跟踪总量后：掉血、掉盾都会在总条宽右侧留下残影，且残影画在最底层色带之上、
    // 血/盾条之下——它只出现在"总量缩水让出来的空位"，不会再被覆盖。
    const shieldTotalEarly = (entity.shieldFixedCurrent || 0) + (entity.tempShield || 0);
    const totalNow = Math.min(1, hpFrac + Math.max(0, Math.min(1, shieldTotalEarly / max)));
    if (entity._trailWidth === undefined) entity._trailWidth = totalNow;
    entity._trailWidth += (totalNow - entity._trailWidth) * 0.15;
    if (entity._trailWidth < totalNow) entity._trailWidth = totalNow; // 涨回来立即贴合，只对缩水做拖尾
    const trailFrac = Math.max(0, Math.min(1, entity._trailWidth));

    // 血条颜色按阵营区分（蓝方/红方），取代此前的"低血量变红"逻辑。
    // 沙盒模式单位（无 _mapFaction）保持原有默认色：塔默认蓝色（与卡片UI的 .tower-bar 一致），
    // 小兵/龙默认绿色——2D 画布必须和单位属性卡片的配色统一，不能塔在画布上是绿的、卡片上是蓝的。
    const faction = entity._mapFaction || entity.faction;
    const defaultColor = entity.type === 'tower' ? '#4a9eff' : '#4caf50';
    const hpColor = faction === 'blue' ? '#4a9eff' : faction === 'red' ? '#ff5a5a' : defaultColor;

    const shieldTotal = (entity.shieldFixedCurrent || 0) + (entity.tempShield || 0);
    const shieldFrac = Math.max(0, Math.min(1, shieldTotal / max));

    let totalFrac = hpFrac + shieldFrac;
    if (totalFrac > 1) {
      const scale = 1 / totalFrac;
      const hpDraw = hpFrac * scale;
      const shieldDraw = shieldFrac * scale;
      const fixedShare = shieldTotal > 0 ? (entity.shieldFixedCurrent || 0) / shieldTotal : 0;
      const tempShare = shieldTotal > 0 ? (entity.tempShield || 0) / shieldTotal : 0;
      const sfWidth = shieldDraw * fixedShare;
      const stWidth = shieldDraw * tempShare;

      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x - w / 2, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x - w / 2, y, w * trailFrac * scale, h);
      ctx.fillStyle = hpColor;
      ctx.fillRect(x - w / 2, y, w * hpDraw, h);
      if (sfWidth > 0.001) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(x - w / 2 + w * hpDraw, y, w * sfWidth, h);
      }
      if (stWidth > 0.001) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.fillRect(x - w / 2 + w * (hpDraw + sfWidth), y, w * stWidth, h);
      }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x - w / 2, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x - w / 2, y, w * trailFrac, h);
      ctx.fillStyle = hpColor;
      ctx.fillRect(x - w / 2, y, w * hpFrac, h);
      const fixedShare = shieldTotal > 0 ? (entity.shieldFixedCurrent || 0) / shieldTotal : 0;
      const tempShare = shieldTotal > 0 ? (entity.tempShield || 0) / shieldTotal : 0;
      const sfWidth = shieldFrac * fixedShare;
      const stWidth = shieldFrac * tempShare;
      if (sfWidth > 0.001) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(x - w / 2 + w * hpFrac, y, w * sfWidth, h);
      }
      if (stWidth > 0.001) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.fillRect(x - w / 2 + w * (hpFrac + sfWidth), y, w * stWidth, h);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x - w / 2, y, w, h);
  }
}