/**
 * LoadingScreen.js —— 进地图时的加载界面。
 *
 * 进一张图要算地形高度场、建地形 / 岩石 / 水 / 树、在显卡上编译着色器，原来全挤在第一帧里同步做完，
 * 画面会卡住好几秒（用户："进地图需要卡一会"）。现在渲染器把这些拆成若干步、每帧做一步，
 * 这里只负责显示：地图名、当前步骤、进度条。界面样式先沿用现有的暗色面板，等 UI 重构时统一。
 */
const ID = 'loadingScreen';

function el() {
  if (typeof document === 'undefined') return null;
  let box = document.getElementById(ID);
  if (!box) {
    box = document.createElement('div');
    box.id = ID;
    box.style.cssText = 'position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;'
      + 'background:radial-gradient(ellipse at center, #1b222c 0%, #0a0d12 75%);color:#e6e9ee;font-family:system-ui,sans-serif;'
      + 'transition:opacity .25s ease;';
    box.innerHTML = `
      <div style="width:min(420px,80vw);text-align:center;">
        <div data-k="title" style="font-size:22px;letter-spacing:2px;margin-bottom:18px;"></div>
        <div style="height:6px;border-radius:3px;background:#262e3a;overflow:hidden;">
          <div data-k="bar" style="height:100%;width:0%;background:linear-gradient(90deg,#3a8fd6,#7cc4ff);transition:width .15s ease;"></div>
        </div>
        <div data-k="step" style="margin-top:10px;font-size:13px;color:#9aa6b4;min-height:1.6em;"></div>
      </div>`;
    document.body.appendChild(box);
  }
  return box;
}

export const LoadingScreen = {
  /** 显示（已显示时只更新标题）。 */
  show(title) {
    const box = el(); if (!box) return;
    box.querySelector('[data-k="title"]').textContent = title || '正在加载地图';
    box.querySelector('[data-k="bar"]').style.width = '0%';
    box.querySelector('[data-k="step"]').textContent = '';
    box.style.display = 'flex'; box.style.opacity = '1';
  },
  /** 进度：frac 0..1，text 当前步骤。 */
  progress(frac, text) {
    const box = el(); if (!box || box.style.display === 'none') return;
    box.querySelector('[data-k="bar"]').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (text !== undefined) box.querySelector('[data-k="step"]').textContent = text;
  },
  hide() {
    const box = el(); if (!box) return;
    box.style.opacity = '0';
    setTimeout(() => { if (box.style.opacity === '0') box.style.display = 'none'; }, 260);
  },
  isVisible() { const box = typeof document !== 'undefined' ? document.getElementById(ID) : null; return !!box && box.style.display !== 'none'; },
};
