#!/usr/bin/env node
/**
 * look.mjs —— 调画面用的自由机位截图工具（shots.mjs 是成套验收 + 逐像素对比；这个是"看这里、这个时刻、这种天气"）。
 *
 * 用法：
 *   node tools/look.mjs --map summoners_rift_v1 --out /tmp/x --shots '[{"name":"mid","at":[1776,1776],"zoom":1.2,"phase":0.75}]'
 *   每个 shot：{ name, at:[x,y] | focus:"blueOuter|blueNexus|redNexus|blueInhib|center|pit", zoom, phase, elev, azim,
 *               weather:{rain:1}, eval:"页面里执行的一段 JS", settle:秒, w, h }
 *   可选：--shotsFile shots.json（代替 --shots） --advance 60（先快进多少秒游戏时间） --size 1280x800 --query "shadow=1" --dpr 1
 * 虚拟时钟同 shots.mjs：同样的输入出同样的图。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'shots/look'));
const MAP = arg('map', 'summoners_rift_v1');
const ADVANCE = +arg('advance', 45);
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const QUERY = arg('query', '');
const DPR = +arg('dpr', 1);
// --shotsFile 给一个 JSON 文件（eval 里有引号时命令行不好写）
const SHOTS = arg('shotsFile', '') ? JSON.parse(fs.readFileSync(arg('shotsFile', ''), 'utf8')) : JSON.parse(arg('shots', '[{"name":"overview","focus":"center","zoom":0}]'));
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

function installVirtualClock(seed) {
  let vt = 0; const q = new Map(); let nextId = 1;
  performance.now = () => vt;
  const D0 = 1767225600000; Date.now = () => D0 + vt;
  window.requestAnimationFrame = (cb) => { const id = nextId++; q.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { q.delete(id); };
  let s = seed >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__vt = { step(n = 1, dt = 1000 / 60) { for (let i = 0; i < n; i++) { vt += dt; const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(vt); } }, now: () => vt };
}

const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
page.setDefaultTimeout(900000);
page.on('pageerror', (e) => console.log('页面错误:', e.message.slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); if (!/GPU stall|Automatic fallback|GL Driver Message/.test(t)) console.log('[' + m.type() + ']', t.slice(0, 400)); } });
await page.addInitScript(installVirtualClock, 7);
await page.goto(`http://127.0.0.1:${server.address().port}/index.html${QUERY ? '?' + QUERY : ''}`);
await page.waitForFunction(() => !!(window.CTX && window.CTX.__three && window.CTX.__app));
await page.evaluate(() => window.__vt.step(3));

const info = await page.evaluate(async ([id, adv]) => {
  const C = window.CTX, r = C.__three;
  if (C.__weather) C.__weather.enabled = false;
  C.gamePaused = false;
  C.__app.mapSystem.loadMap(id);
  window.__vt.step(1);
  for (let i = 0; i < 2000 && r.isLoading?.(); i++) { window.__vt.step(1, 0); await new Promise((res) => setTimeout(res, 5)); }
  window.__vt.step(1);
  const realRender = r.render.bind(r); r.render = () => {};
  C.__gameSpeed = 8;
  const t0 = window.gameTime || 0;
  for (let i = 0; i < 6000 && (window.gameTime || 0) - t0 < adv; i++) window.__vt.step(1, 250);
  r.render = realRender; C.__gameSpeed = 1; C.gamePaused = true;
  const ms = C.__app.mapSystem, m = ms.currentMap;
  const B = (m.buildings || []);
  const find = (f, t) => { const b = B.find((b) => b.faction === f && (b.tier === t || b.type === t)); return b ? { x: (b.pos || b).x, y: (b.pos || b).y } : null; };
  const pit = ms.getPit?.('dragon');
  return { world: m.world, focus: {
    center: { x: m.world.w / 2, y: m.world.h / 2 },
    blueOuter: find('blue', 'outer'), redOuter: find('red', 'outer'),
    blueInner: find('blue', 'inner'), blueInhibTower: find('blue', 'inhibitor'),
    blueInhib: find('blue', 'nexus_lane'), redInhib: find('red', 'nexus_lane'),
    blueNexus: find('blue', 'nexus_main'), redNexus: find('red', 'nexus_main'),
    pit: pit ? { x: pit.x, y: pit.y } : null,
  }, tiers: [...new Set(B.map((b) => b.faction + ':' + (b.tier || b.type)))], gameTime: Math.round(window.gameTime || 0) };
}, [MAP, ADVANCE]);
console.log('地图', MAP, JSON.stringify(info.world), '建筑档位', info.tiers.join(' '), '第', info.gameTime, '秒');

for (const s of SHOTS) {
  if (s.w || s.h) await page.setViewportSize({ width: s.w || VW, height: s.h || VH });
  const dataUrl = await page.evaluate(async ([s, inf]) => {
    const C = window.CTX, r = C.__three, cv = r.gl.domElement;
    const W = cv.clientWidth, H = cv.clientHeight;
    const fit = 0.92 * Math.min(W / inf.world.w, H / inf.world.h);
    const p = s.at ? { x: s.at[0], y: s.at[1] } : (inf.focus[s.focus || 'center'] || inf.focus.center);
    C.__lookAt(p.x, p.y, s.zoom > 0 ? s.zoom : fit);
    if (s.elev != null) C.__setElevation(s.elev);
    if (s.azim != null) C.__setAzimuth(s.azim);
    C.__setDayPhase(s.phase ?? 0.25);
    const ws = C.__weather || window.__weather;
    if (s.weather && ws) { ws.enabled = true; r.setWeatherFx?.(true); for (const k in s.weather) { try { ws.debugSetCharge ? ws.debugSetCharge(k, s.weather[k]) : (ws._debugCharge = { ...(ws._debugCharge || {}), [k]: s.weather[k] }); } catch (e) { console.warn(e); } } }
    if (s.eval) { try { await (0, eval)('(async()=>{' + s.eval + '})()'); } catch (e) { console.error('eval 失败: ' + e.message); } }
    const settle = Math.round((s.settle ?? 0.15) * 60);
    window.__vt.step(Math.max(4, settle));
    window.__vt.step(1);
    return cv.toDataURL('image/png');
  }, [s, info]);
  const file = path.join(OUT, s.name + '.png');
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('截图', file);
}
await browser.close(); server.close();
