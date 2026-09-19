/**
 * run_bake_check.mjs —— 用 Playwright 在真实 Chromium 里验证 GLB 烘焙管线。
 *
 * 起一个静态服务器指向仓库根，打开 tests/browser/model_bake_test.html，
 * 等页面把结果写到 window.__result，断言全部检查通过、无控制台报错。
 *
 * 运行（Playwright 需可解析；浏览器用 /opt/pw-browsers 预装的 Chromium）：
 *   NODE_PATH=/path/to/node_modules node tests/browser/run_bake_check.mjs
 * 或 `npm i -D playwright@1.56.1 && node tests/browser/run_bake_check.mjs`
 * 页面亦可直接用任意浏览器打开（需经 http 服务仓库根），人工看 <pre> 报告。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png' };

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
const browser = await chromium.launch({
  executablePath: PW_CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('PAGEERR ' + e.message));

let result;
try {
  await page.goto(`http://localhost:${port}/tests/browser/model_bake_test.html`);
  await page.waitForFunction('window.__done === true', { timeout: 90000 });
  result = await page.evaluate('window.__result');
  await page.screenshot({ path: path.join(ROOT, 'tests/browser/_bake_shot.png') });
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify(result, null, 2));
if (errs.length) console.log('CONSOLE ERRORS:\n' + errs.join('\n'));
const ok = result && result.ok && errs.length === 0;
console.log(ok ? '\nBAKE CHECK: PASS' : '\nBAKE CHECK: FAIL');
process.exit(ok ? 0 : 1);
