/**
 * run_game_shot.mjs —— 打开真正的 index.html，跑一会儿，截一张图。
 *
 * 为什么要有它：单元测试全绿 ≠ 游戏能跑。渲染层的改动（光照、天气盒、塔模型、
 * 分区贴图）在 headless 单测里根本不执行，只有真浏览器才会走到。
 * 本仓库交付过"测试全过但打开是黑屏"的东西，这个脚本就是为了不再发生。
 *
 *   node tests/browser/run_game_shot.mjs [输出路径] [跑多少秒]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'tests/browser/_game_shot.png');
const SECS = Number(process.argv[3] || 6);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p === '/') p = '/index.html';
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForTimeout(SECS * 1000);
await page.screenshot({ path: OUT });
console.log('截图已写入', OUT);
if (errs.length) {
  console.log(`⚠️ 控制台报错 ${errs.length} 条：`);
  for (const e of [...new Set(errs)].slice(0, 12)) console.log('  ', e.slice(0, 200));
}
await browser.close();
server.close();
process.exit(errs.length ? 1 : 0);
