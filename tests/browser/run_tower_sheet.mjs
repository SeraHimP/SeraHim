/**
 * run_tower_sheet.mjs —— 把全部塔模型（阵营 × 层级 × 损毁档 + 两种水晶）
 * 渲染成一张对照图，供人眼检查。
 *
 * 为什么要有它：塔造型这类改动**断言检查不了好不好看** —— 源码断言最多能钉
 * "红蓝走了不同分支"，钉不了"看起来是不是真的不一样"。而这个环境是 headless，
 * 不出图就只能靠想象，那正是 v44 交付出"四档长得一样"的原因。
 *
 *   node tests/browser/run_tower_sheet.mjs [输出路径]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'tests/browser/_tower_sheet.png');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

const PW_CHROME = ['/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));

await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: PW_CHROME, args: ['--use-gl=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/tests/browser/tower_sheet.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
const data = await page.evaluate(() => window.__sheet);
fs.writeFileSync(OUT, Buffer.from(data.split(',')[1], 'base64'));
console.log('对照图已写入', OUT);
if (errs.length) { console.log('⚠️ 控制台报错：'); for (const e of errs) console.log('  ', e); }
await browser.close();
server.close();
process.exit(errs.length ? 1 : 0);
