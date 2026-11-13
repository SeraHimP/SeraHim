/**
 * soulEmblem.js —— 龙魂标识：脚下一枚元素色的魔法阵地纹（慢转、呼吸），建筑外加一圈往上飘的元素光点。
 *
 * 用户（2026-09-27）："龙魂环的显示效果太 low 了，想一个其他显示的方式，能让我知道该单位已经获取了龙魂……
 * 所有问题你自己做决定"。原来是一道单色细环，和选中光圈、射程圈是同一种东西，读不出"拿到了龙魂"。
 * 现在：两圈环 + 一圈符文刻痕 + 中间一枚六芒星的地纹，叠加发光、边缘柔和；颜色 = 龙魂元素色。
 * 大小仍按模型外轮廓（UnitLayer._syncSoulRing 里算好的半径），不被建筑挡住。
 * 参数（转速、呼吸、亮度、光点数）在 CONFIG.ui.soulRing。
 */
import * as THREE from '../../vendor/three.module.js';

let _tex = null;
/** 白色地纹贴图（颜色由材质乘上去），全场共用一张 */
export function soulGlyphTexture() {
  if (_tex) return _tex;
  const N = 256, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const cx = N / 2, R = N / 2 - 6;
  g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff';
  g.shadowColor = '#ffffff'; g.shadowBlur = 8;
  const ring = (r, w, a = 1) => { g.globalAlpha = a; g.lineWidth = w; g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.stroke(); };
  ring(R * 0.97, 5);            // 外圈
  ring(R * 0.84, 2, 0.8);       // 内圈
  // 两圈之间的符文刻痕：长短交替 + 每 60° 一枚菱形符文
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2, long = i % 4 === 0;
    const r0 = R * 0.86, r1 = R * (long ? 0.95 : 0.91);
    g.globalAlpha = long ? 0.95 : 0.6; g.lineWidth = long ? 3 : 2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1); g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + Math.PI / 12, r = R * 0.905, s = R * 0.05;
    g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r + s), cx + Math.sin(a) * (r + s));
    g.lineTo(cx + Math.cos(a + 0.06) * r, cx + Math.sin(a + 0.06) * r);
    g.lineTo(cx + Math.cos(a) * (r - s), cx + Math.sin(a) * (r - s));
    g.lineTo(cx + Math.cos(a - 0.06) * r, cx + Math.sin(a - 0.06) * r);
    g.closePath(); g.fill();
  }
  // 中间：淡淡的六芒星 + 一圈细环，让地纹里面不是空的
  g.globalAlpha = 0.45; g.lineWidth = 2;
  for (const off of [0, Math.PI / 3]) {
    g.beginPath();
    for (let k = 0; k <= 3; k++) {
      const a = off + k / 3 * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * R * 0.7, y = cx + Math.sin(a) * R * 0.7;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  ring(R * 0.36, 1.5, 0.4);
  // 整体一层从外往里淡的底光，边缘柔和
  g.globalAlpha = 1; g.shadowBlur = 0;
  const grd = g.createRadialGradient(cx, cx, R * 0.4, cx, cx, R);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.85, 'rgba(255,255,255,0.12)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2); g.fill();
  _tex = new THREE.CanvasTexture(c);
  _tex.colorSpace = THREE.SRGBColorSpace;
  return _tex;
}

const _mats = new Map();
/** 按元素色缓存的地纹材质（叠加发光、不写深度；不透明度每帧由调用方按呼吸曲线写） */
export function soulEmblemMaterial(color) {
  let m = _mats.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: soulGlyphTexture(), color, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true });
    _mats.set(color, m);
  }
  return m;
}

const _geos = new Map();
/** 平躺的方形面片，边长 = 2r（贴图四角是透明的） */
export function soulEmblemGeometry(r) {
  const k = Math.round(r * 10) / 10;
  let g = _geos.get(k);
  if (!g) { g = new THREE.PlaneGeometry(k * 2, k * 2); g.rotateX(-Math.PI / 2); _geos.set(k, g); }
  return g;
}

/** 呼吸：0..1 之间缓慢起伏（按时间，所有同色标识同步呼吸） */
export function soulPulse(t, speed) { return 0.5 + 0.5 * Math.sin(t * speed); }
