#!/usr/bin/env node
/**
 * modelshot.mjs —— 给模型预览页（proto/modelview）截图。调模型用，几秒一张，不用进图。
 *   node tools/modelshot.mjs --out /tmp/a.png --query "set=buildings&faction=both" [--size 1400x900]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'shots/model.png')), QUERY = arg('query', 'set=buildings');
const [VW, VH] = arg('size', '1400x900').split('x').map(Number);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('页面错误:', e.message.slice(0, 600)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 600)); });
await page.goto(`http://127.0.0.1:${server.address().port}/proto/modelview/index.html?${QUERY}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForTimeout(+arg('wait', 900));
await page.screenshot({ path: OUT });
console.log('截图', OUT);
await browser.close(); server.close();
