/**
 * SpriteFactory.js —— 单位纹理工厂（2.5D 迁移第 3 步）
 *
 * 从 CanvasRenderer 原样抽出 MINION_STYLE / _getSprite / _towerSprite / _minionSprite。
 * 抽离目的：Three 渲染器要把同一批离屏精灵画布做成 CanvasTexture 贴 Billboard，
 * 不能为此依赖 CanvasRenderer 实例；后续换 AI 素材只动本文件内部，两个渲染器同时生效。
 *
 * 【纪律】与 TerrainLayer 同款：绘制逻辑逐字符搬运，不许顺手优化。
 * 唯一差别：精灵缓存从实例字段提为模块级共享（两个渲染器共用一份，省一份烘焙）。
 *
 * dragonSprite / WEAPON_ICONS 是本次新增（原先龙是每帧过程式绘制、武器图标表是
 * render() 内的局部常量），归拢进工厂统一管素材。
 */
import { CONFIG, MINION_SIZES } from '../data/Config.js';

const _spriteCache = new Map();   // key -> { canvas, half, size }（half = 逻辑半宽，绘制时居中）

// 塔上的武器图标（原 CanvasRenderer.render() 内的局部常量 WEAPON_STYLE，逐字符同值）
export const WEAPON_ICONS = {
  weapon_piercing:  { icon: '🔷' },
  weapon_lightning: { icon: '⚡' },
  weapon_explosive: { icon: '💥' },
  weapon_corrosion: { icon: '🌿' },
};

// 小兵样式表（模块常量——原先每帧在 render() 里重建一次对象）
export const MINION_STYLE = {
  melee:   { color: '#f2795c', icon: '⚔️', size: MINION_SIZES.melee },
  ranged:  { color: '#e0c25b', icon: '🏹', size: MINION_SIZES.ranged },
  siege:   { color: '#b07cf0', icon: '💥', size: MINION_SIZES.siege },
  super:   { color: '#c0392b', icon: '🦾', size: MINION_SIZES.super },
  totem:   { color: '#bb86fc', icon: '🗿', size: MINION_SIZES.totem },
  shield:  { color: '#5b9bd5', icon: '🛡', size: MINION_SIZES.shield },
  warlock: { color: '#8e44ad', icon: '🧙', size: MINION_SIZES.warlock },
  corrupt: { color: '#6b8e23', icon: '🦇', size: MINION_SIZES.corrupt },
  // v40：补上攻城车——此前缺失导致渲染 fallback 到 { icon: '❓' }，画板上显示问号
  ram:     { color: '#7f8c8d', icon: '🛠️', size: MINION_SIZES.ram },
  // Q5：重装车——铁灰色呼应"重甲/龟壳"定位，与攻城车的深灰区分开（略偏冷蓝调）
  heavy:   { color: '#5d6d7e', icon: '🐢', size: MINION_SIZES.heavy },
  // Q5：治疗兵——粉色呼应"治疗"这个语义，与图腾兵的紫色辅助光环区分开
  healer:  { color: '#e07ab0', icon: '💗', size: MINION_SIZES.healer },
  // Q5：工程兵——工程黄，与治疗兵/图腾兵等其它支援型颜色区分开
  engineer: { color: '#e0a83c', icon: '🔧', size: MINION_SIZES.engineer },
  // Q5：唤灵兵——灵体紫，呼应"幻灵/灵魂"这个语义
  summoner: { color: '#8e7cc3', icon: '👻', size: MINION_SIZES.summoner },
  // 牧灵法阵幻兽——灵体青，与唤灵兵的灵体紫区分开（两者都是"灵"但来源不同）。
  // 注意：这是渲染专用的伪类型，entity.type 本身仍是 'melee'，见 minionRenderType()。
  shepherd_pet: { color: '#6fd6c8', icon: '🔮', size: MINION_SIZES.shepherd_pet },
  // 2026-09-20：唤灵兵的幻灵——用户反馈"这个模型改为召唤物的模型，用颜色区分"，
  // 复用牧灵法阵幻兽同一份"召唤物"造型（UnitMeshFactory.MINION_BUILDERS.summon_spirit
  // 直接是 shepherd_pet 的别名，同一个几何体），只用颜色把两者分开：浅紫呼应
  // 唤灵兵自己的灵体紫（summoner: '#8e7cc3'），但调淡一档，不会跟施法者本人撞色，
  // 也不会跟牧灵法阵幻兽的青色混淆。
  summon_spirit: { color: '#c9a6f0', icon: '👻', size: MINION_SIZES.summon_spirit },
};

/**
 * 渲染层专用：把实体路由到用来选样式/造型的"伪类型"，与 entity.type（战斗/属性模板
 * 用的真类型）分开。两个用例都是"entity.type 必须留着 'melee'（复用近战兵的属性
 * 模板/索敌/移动逻辑），但外观不能长得像小兵"：牧灵法阵幻兽（_petOwnerId）与
 * 唤灵兵的幻灵（_isSummoned 且没有 _petOwnerId——先判 _petOwnerId 是因为牧灵幻兽
 * 同时也挂 _isSummoned，顺序反了会被幻灵那条分支先接住）。UnitLayer._visualOf
 * 与 UnitInfo.minionSize 必须都走这个函数，不要在两处各自判标记字段——那是同一条
 * 规则的两份拷贝，迟早会漂移（其中一处忘了同步改）。
 */
export function minionRenderType(e) {
  if (e._petOwnerId) return 'shepherd_pet';
  if (e._isSummoned) return 'summon_spirit';
  return e.type;
}

/**
 * 兵种样式解析：内置查上表，**自制兵种取用户自己填的图标/颜色**。
 *
 * 上面 ram 那条注释记的就是漏了一种兵会怎样：fallback 到 { icon:'❓' }，
 * 画板上一排问号。自制兵种天生不在这张表里，如果各处继续直接下标访问，
 * 用户做出来的每一个兵都会是问号 —— 这个坑等着被踩第二次。
 * 所以统一走这个函数，各处不要再写 `MINION_STYLE[type] || {…}`。
 */
export function minionStyle(type, custom = null) {
  const st = MINION_STYLE[type];
  if (st) return st;
  // 直接读 CONFIG 而不是绕 window：Config.js 没有任何渲染依赖，导它是安全的；
  // 走 window.CTX 反而多一条"这个字段今天在不在"的不确定性。
  const c = custom || (CONFIG.customMinions && CONFIG.customMinions[type]) || null;
  return {
    color: c?.color || '#c0392b',
    icon: c?.icon || '⚔️',      // 未知兵种给通用兵刃而不是问号：问号看着像 bug
    size: c?.size || MINION_SIZES.melee || 10,
  };
}

// 离屏精灵：logicalSize 为世界坐标下的边长，内部以 SS 超采样烘焙保证放大后清晰
export function getSprite(key, logicalSize, drawFn) {
  let sp = _spriteCache.get(key);
  if (sp) return sp;
  const SS = 3; // 超采样倍率：世界缩放上限 3.0，烘焙 3 倍分辨率覆盖全部缩放档
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(logicalSize * SS);
  const g = c.getContext('2d');
  g.scale(SS, SS);
  drawFn(g, logicalSize / 2); // 以 (half, half) 为中心作画
  sp = { canvas: c, half: logicalSize / 2, size: logicalSize };
  _spriteCache.set(key, sp);
  return sp;
}

// 塔精灵：径向渐变光晕（替代每帧 shadowBlur）+ 双层圆 + 图标，烘焙一次。
// size = 本体半径（按建筑 tier 从 CONFIG.buildingSizes 取：枢纽 40 > 塔 28 > 召唤水晶 20），
// 光晕/内圆/字号全部按 28 基准等比缩放，精灵缓存 key 含尺寸。
export function towerSprite(color, icon, size = 28) {
  const k = size / 28;
  return getSprite('tower|' + color + '|' + (icon || '') + '|' + size, Math.ceil(100 * k), (g, c) => {
    const grad = g.createRadialGradient(c, c, 20 * k, c, c, 48 * k);
    grad.addColorStop(0, color + '4d');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, 48 * k, 0, 2 * Math.PI); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.arc(c, c, size, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#1b2a30';
    g.beginPath(); g.arc(c, c, 20 * k, 0, 2 * Math.PI); g.fill();
    if (icon) {
      g.fillStyle = '#fff';
      g.font = Math.round((icon === '💎' ? 18 : 16) * k) + 'px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(icon, c, c);
    }
  });
}

// 小兵精灵（v33 Q6 重做）：底色 = 阵营色；兵种靠【形状】区分（LoL 小地图思路的强化版）：
//   近战=圆 / 远程=三角 / 炮兵=方 / 超级兵=六边 / 图腾=菱形 / 术士=五边 / 蚀骨=倒三角。
//   白色细描边提升与地面的对比度；高缩放下形状上再叠 emoji 图标双保险。
export function minionSprite(type, faction, icon, size) {
  const color = faction === 'blue' ? '#5b9bd5' : faction === 'red' ? '#e0473f'
    : (MINION_STYLE[type]?.color || '#c0392b'); // 无阵营单位（理论上不会出现）沿用旧兵种色
  return getSprite('minion|' + type + '|' + (faction || 'none'), size * 2 + 8, (g, c) => {
    g.fillStyle = color;
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.4;
    const poly = (n, rot = -Math.PI / 2, r = size) => {
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath(); g.fill(); g.stroke();
    };
    switch (type) {
      case 'melee':   g.beginPath(); g.arc(c, c, size, 0, 2 * Math.PI); g.fill(); g.stroke(); break;
      case 'ranged':  poly(3, -Math.PI / 2, size * 1.15); break;               // 正三角
      case 'siege':   g.beginPath(); g.rect(c - size * 0.9, c - size * 0.9, size * 1.8, size * 1.8); g.fill(); g.stroke(); break;
      case 'super':   poly(6, 0, size * 1.1); break;                            // 六边形
      // v40：攻城车——横向长方形（比炮车的正方形更宽，一眼区分）
      case 'ram':     g.beginPath(); g.rect(c - size * 1.25, c - size * 0.75, size * 2.5, size * 1.5); g.fill(); g.stroke(); break;
      case 'totem':   poly(4, -Math.PI / 2, size * 1.15); break;                // 菱形
      case 'warlock': poly(5, -Math.PI / 2, size * 1.1); break;                 // 五边形
      case 'corrupt': poly(3, Math.PI / 2, size * 1.15); break;                 // 倒三角
      // Q5：重装车——八边形（厚重多角、跟近战兵的圆一眼区分开，呼应"龟甲/装甲"定位）
      case 'heavy':   poly(8, -Math.PI / 2, size * 1.05); break;
      // Q5：治疗兵——十字（医疗符号的通用形状，一眼区分于所有攻击型小兵的几何形）
      case 'healer': {
        const w = size * 0.4, l = size * 1.1;
        g.beginPath();
        g.rect(c - w, c - l, w * 2, l * 2);
        g.fill(); g.stroke();
        g.beginPath();
        g.rect(c - l, c - w, l * 2, w * 2);
        g.fill(); g.stroke();
        break;
      }
      // Q5：工程兵——五角星（扳手/工具类图标的通用简化形状，跟其它支援兵种的
      // 十字/菱形/五边形都不一样，一眼可区分）
      case 'engineer': {
        const rOuter = size * 1.15, rInner = size * 0.45;
        g.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? rOuter : rInner;
          const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
          const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath(); g.fill(); g.stroke();
        break;
      }
      // Q5：唤灵兵——六芒星（两个交叠三角形，呼应"召唤"的神秘学意象，跟工程兵的
      // 五角星区分开）
      case 'summoner': poly(3, -Math.PI / 2, size * 1.1); poly(3, Math.PI / 2, size * 1.1); break;
      default:        g.beginPath(); g.arc(c, c, size, 0, 2 * Math.PI); g.fill(); g.stroke();
    }
    if (icon) {
      g.fillStyle = '#fff';
      g.font = Math.max(8, size) + 'px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(icon, c, c);
    }
  });
}

// 龙 Billboard 纹理【3D 专用新增】：把 _drawDragon 的"渐变光环 + 本体 + 远古金环"烘焙成
// 静态精灵（2D 侧的光环脉动是每帧过程式画的，纹理里烘不进去；3D 侧用 sprite 整体缩放近似脉动）。
// logicalSize 覆盖 2.2 倍光环半径。
export function dragonSprite(color, isAncient) {
  const size = isAncient ? 30 : 24;
  const R = Math.ceil(size * 2.2);
  return getSprite('dragon|' + color + '|' + (isAncient ? 1 : 0), R * 2, (g, c) => {
    const grad = g.createRadialGradient(c, c, 0, c, c, R);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(1, color + '00');
    g.globalAlpha = 0.25;
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, R, 0, 2 * Math.PI); g.fill();
    g.globalAlpha = 1;
    g.fillStyle = color;
    g.beginPath(); g.arc(c, c, size, 0, 2 * Math.PI); g.fill();
    if (isAncient) {
      g.strokeStyle = '#f6c94a';
      g.lineWidth = 3;
      g.beginPath(); g.arc(c, c, size + 5, 0, 2 * Math.PI); g.stroke();
    }
  });
}
