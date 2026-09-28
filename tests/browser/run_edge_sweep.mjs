/**
 * run_edge_sweep.mjs —— 地形边缘（TerrainEdgeLayer）的参数 A/B 对照图
 *
 * 为什么要有它：「落差 12 够不够」「外扩 8 还是 14」这类问题**在屏幕空间里才有答案**，
 * 靠推理会一直吵下去。45° 正交下落差 h 的屏幕位移是 h·sin45°，还要乘视图缩放 ——
 * 全图视角实测约 0.34 像素/世界单位，落差 24 也只有 5.9 像素。所以必须按三档镜头各截一张。
 *
 *   node tests/browser/run_edge_sweep.mjs [输出目录]
 *
 * 每组参数 × 三档缩放，文件名 edge_<组名>_z<缩放>.png。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OUTDIR = process.argv[2] || path.join(ROOT, 'tests/browser');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

// 组名 → 覆写到 map.terrainEdge 上的字段
const CASES = {
  E: { waterY: -22, slopeRun: 10, slopeDepth: 14, edgeDepth: 0,
       slopeColor: '#a8c2d4' },                       // 单段斜坡 + 地面压暗色
  F: { waterY: -22, slopeRun: 10, slopeDepth: 10, edgeDepth: 4,
       slopeColor: '#a8c2d4', edgeColor: '#5f7d94' }, // GPT 的两段式
  G: { waterY: -22, slopeRun: 16, slopeDepth: 14, edgeDepth: 0,
       slopeColor: '#a8c2d4' },                       // 更宽的坡
};
const ZOOMS = [0, 1.4, 2.6];   // 0 = 全图不动镜头

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
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.evaluate(async () => {
  const ms = window.CTX?.__app?.mapSystem;
  if (ms?.loadMap) await ms.loadMap('howling_abyss_frost_v1');
});
await page.waitForTimeout(1500);

for (const [name, over] of Object.entries(CASES)) {
  await page.evaluate((o) => {
    const map = window.CTX?.__app?.mapSystem?.currentMap;
    Object.assign(map.terrainEdge, o);
    // 强制重建：本层自带"同图跳过"守卫，先 dispose 把 _mapId 清掉
    window.CTX?.__three?.terrainEdge?.dispose?.();
    window.CTX?.__three?.invalidateTerrain?.();
  }, over);
  await page.waitForTimeout(1200);
  for (const z of ZOOMS) {
    if (z > 0) {
      await page.evaluate((zz) => {
        const ents = window.CTX?.__app?.entityContainer;
        const towers = ents?.getAllTowers ? ents.getAllTowers(true) : [];
        const t = [...towers].find(e => e._mapTier && e._mapTier !== 'nexus_main');
        if (t && window.CTX.__lookAt) window.CTX.__lookAt(t.pos.x, t.pos.y, Number(zz));
      }, z);
    } else {
      await page.evaluate(() => window.CTX?.__app?.canvasController?.fitToWorld?.());
    }
    await page.waitForTimeout(700);
    const out = path.join(OUTDIR, `edge_${name}_z${z}.png`);
    await page.screenshot({ path: out });
    console.log('写入', out);
  }
}
if (errs.length) { console.log('⚠️ 报错：'); for (const e of [...new Set(errs)].slice(0, 8)) console.log('  ', e.slice(0, 200)); }
await browser.close();
server.close();
process.exit(0);
