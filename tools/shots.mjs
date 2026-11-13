#!/usr/bin/env node
/**
 * shots.mjs —— 全地图截图 + 逐像素对比。用来证明"优化没有改动画面"，也给调画面出前后对比图。
 *
 * 用法：
 *   node tools/shots.mjs --out shots/before                       # 出一组截图
 *   node tools/shots.mjs --out shots/after --compare shots/before # 出一组并和上一组逐像素比
 *   可选：--maps a,b  --phases 0.25,0.75  --views overview,close  --advance 45  --size 1280x800  --threshold 0  --seed 7  --query ssao=0
 *
 * 可复现：页面加载前接管 requestAnimationFrame / performance.now / Date.now / Math.random，
 * 由本工具一帧一帧推进虚拟时钟（固定帧长、固定随机种子）。同一份代码跑两次，截图逐像素一致；
 * 两版之间的差异就只来自代码改动。截图在渲染完那一帧直接读 WebGL 画布，界面面板不会混进来。
 *
 * 每张图：先在正常模式下快进 advance 秒游戏时间（让兵线上有兵），再暂停，切昼夜相位、摆相机、渲染、读像素。
 * 对比：每张图输出"变了的像素占比 / 最大单通道差 / 平均差"，并写一张差异图（变了的像素涂红）。有差异时退出码为 1。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodePNG, encodePNG, diffImages } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ALL_MAPS = ['summoners_rift_v1', 'twisted_treeline_v1', 'howling_abyss_frost_v1', 'dominion_crystal_scar_v1',
  'summoners_rift_organic_v1', 'confluence_v1', 'demo_stylized_v1'];
const OUT = path.resolve(arg('out', 'shots/latest'));
const MAPS = arg('maps', ALL_MAPS.join(',')).split(',').filter(Boolean);
const PHASES = arg('phases', '0.25,0.75').split(',').map(Number);
const VIEWS = arg('views', 'overview,close').split(',');
const ADVANCE = +arg('advance', 45);
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const THRESHOLD = +arg('threshold', 0);
const SEED = +arg('seed', 7);
const COMPARE = arg('compare', '');
const QUERY = arg('query', '');   // 给页面带网址开关，例如 ssao=0&shadow=0（见 main.js 的 applyDebugSwitches）

fs.mkdirSync(OUT, { recursive: true });
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** 虚拟时钟：页面脚本执行之前注入。 */
function installVirtualClock(seed) {
  let vt = 0; const q = new Map(); let nextId = 1;
  performance.now = () => vt;
  const D0 = 1767225600000; Date.now = () => D0 + vt;
  window.requestAnimationFrame = (cb) => { const id = nextId++; q.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { q.delete(id); };
  let s = seed >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__vt = {
    step(n = 1, dt = 1000 / 60) {
      for (let i = 0; i < n; i++) { vt += dt; const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(vt); }
    },
    now: () => vt,
  };
}

const manifest = [];
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
page.setDefaultTimeout(900000);
page.on('pageerror', (e) => console.log('页面错误:', e.message.slice(0, 300)));
await page.addInitScript(installVirtualClock, SEED);
await page.goto(`http://127.0.0.1:${server.address().port}/index.html${QUERY ? '?' + QUERY : ''}`);
await page.waitForFunction(() => !!(window.CTX && window.CTX.__three && window.CTX.__app));
await page.evaluate(() => window.__vt.step(3));

for (const mapId of MAPS) {
  // 切图 → 快进（渲染换成空函数，只推进仿真）→ 暂停
  const info = await page.evaluate(async ([id, adv]) => {
    const C = window.CTX, r = C.__three;
    if (C.__weather) C.__weather.enabled = false;
    C.gamePaused = false;
    C.__app.mapSystem.loadMap(id);
    window.__vt.step(1);
    // 等分帧建图 + 着色器异步编译完成。用 0 时长的帧推进：虚拟时钟不走，结果仍然可复现
    for (let i = 0; i < 2000 && r.isLoading?.(); i++) { window.__vt.step(1, 0); await new Promise((res) => setTimeout(res, 5)); }
    window.__vt.step(1);
    const realRender = r.render.bind(r); r.render = () => {};
    C.__gameSpeed = 8;
    const t0 = window.gameTime || 0;
    for (let i = 0; i < 4000 && (window.gameTime || 0) - t0 < adv; i++) window.__vt.step(1, 250);
    r.render = realRender; C.__gameSpeed = 1; C.gamePaused = true;
    const m = C.__app.mapSystem.currentMap;
    const outer = (m.buildings || []).find((b) => b.faction === 'blue' && b.tier === 'outer') || (m.buildings || []).find((b) => b.faction === 'blue');
    const p = outer ? (outer.pos || outer) : { x: m.world.w / 2, y: m.world.h / 2 };
    return { world: m.world, focus: { x: p.x, y: p.y }, gameTime: Math.round(window.gameTime || 0) };
  }, [mapId, ADVANCE]);
  for (const view of VIEWS) for (const phase of PHASES) {
    const dataUrl = await page.evaluate(([v, ph, inf]) => {
      const C = window.CTX, r = C.__three, cv = r.gl.domElement;
      const W = cv.clientWidth, H = cv.clientHeight;
      const fit = 0.92 * Math.min(W / inf.world.w, H / inf.world.h);
      if (v === 'overview') C.__lookAt(inf.world.w / 2, inf.world.h / 2, fit);
      else C.__lookAt(inf.focus.x, inf.focus.y, Math.max(fit * 2.6, 0.55));
      C.__setDayPhase(ph);
      window.__vt.step(4);                      // 天空 / 世界 / 阴影按新相位、新机位刷新
      window.__vt.step(1);                      // 这一帧渲染完立刻读（同一个任务里，绘制缓冲还没被清掉）
      return cv.toDataURL('image/png');
    }, [view, phase, info]);
    const name = `${mapId}__${view}__${phase === 0.25 ? 'day' : phase === 0.75 ? 'night' : 'p' + phase}`;
    const file = name + '.png';
    fs.writeFileSync(path.join(OUT, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    manifest.push({ name, file, map: mapId, view, phase, gameTime: info.gameTime });
    console.log('截图', name, `（第 ${info.gameTime} 秒）`);
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ seed: SEED, size: [VW, VH], advance: ADVANCE, shots: manifest }, null, 2));
await browser.close(); server.close();

if (COMPARE) {
  const base = path.resolve(COMPARE);
  const rows = []; let worst = 0;
  for (const s of manifest) {
    const fa = path.join(base, s.file);
    if (!fs.existsSync(fa)) { rows.push({ name: s.name, missing: true }); continue; }
    const d = diffImages(decodePNG(fs.readFileSync(fa)), decodePNG(fs.readFileSync(path.join(OUT, s.file))), THRESHOLD);
    if (d.diff && d.changed) fs.writeFileSync(path.join(OUT, 'diff__' + s.file), encodePNG(d.diff));
    rows.push({ name: s.name, changed: d.changed, ratio: d.ratio, maxDelta: d.maxDelta, meanDelta: d.meanDelta, sizeMismatch: !!d.sizeMismatch });
    worst = Math.max(worst, d.changed);
  }
  fs.writeFileSync(path.join(OUT, 'compare.json'), JSON.stringify({ baseline: base, threshold: THRESHOLD, rows }, null, 2));
  console.log(`\n与 ${base} 对比（单通道差 > ${THRESHOLD} 算变化）：`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ${r.name.padEnd(48)} 基线里没有这张`); continue; }
    console.log(`  ${r.name.padEnd(48)} ${r.changed ? '变了' : '一致'}  ${(r.ratio * 100).toFixed(3)}%  最大差 ${r.maxDelta}  平均差 ${r.meanDelta.toFixed(3)}`);
  }
  process.exitCode = worst > 0 ? 1 : 0;
}
