#!/usr/bin/env node
/**
 * perf_probe.mjs —— 渲染性能基线：无头 Chromium 跑一局，快进到指定游戏时间，量一段时间的渲染开销。只量不改。
 *
 * 用法：
 *   node tools/perf_probe.mjs [--map summoners_rift_v1] [--time 600] [--seconds 6] [--width 1280] [--height 800] [--json out.json]
 *
 * 输出：
 *   · 每帧平均 CPU 耗时，按 render() 内部各段拆开（单位更新 / 特效 / 天气 / 世界 / 各后处理 pass）
 *   · 每个后处理 pass 的绘制调用数、全帧三角形数
 *   · GPU 资源计数（纹理 / 几何 / 着色器程序）与纹理按来源归类
 *   · 场景里可见物体按类别归并后的数量（哪一类东西在吃绘制调用）
 *
 * 注意：无头环境用的是软件渲染（swiftshader），GPU 段的毫秒数比真显卡慢一个数量级，只能看相对占比；
 * 绘制调用数、三角形数、资源计数与真机一致，可以直接比较。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MAP = arg('map', 'summoners_rift_v1'), TARGET = +arg('time', 600), SECONDS = +arg('seconds', 6);
const W = +arg('width', 1280), H = +arg('height', 800), JSON_OUT = arg('json', '');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(900000);
page.on('pageerror', (e) => console.log('页面错误:', e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForTimeout(2500);
await page.click('#modeBtn'); await page.waitForTimeout(300);
if (await page.evaluate(() => window.CTX.__app.mapSystem.currentBaseMapId) !== MAP) await page.click(`[data-map-id="${MAP}"]`);
await page.waitForTimeout(300); await page.click('#modeOkBtn'); await page.waitForTimeout(3000);

// 先等进图加载（分帧建地形 + 编译着色器）完成：加载期间仿真是暂停的，而加载靠渲染推进
await page.waitForFunction(() => !window.CTX.__three.isLoading?.(), null, { timeout: 300000 });
// 快进：暂时把渲染换成空函数，只推进仿真，到目标时间再恢复
await page.evaluate(() => { const r = window.CTX.__three; window.__probeRender = r.render.bind(r); r.render = () => {}; window.CTX.__gameSpeed = 8; });
for (let i = 0; i < 900; i++) { if ((await page.evaluate(() => window.gameTime || 0)) >= TARGET) break; await page.waitForTimeout(1000); }
const state = await page.evaluate(() => {
  const r = window.CTX.__three; r.render = window.__probeRender; window.CTX.__gameSpeed = 1;
  const ec = window.CTX.__entityContainer;
  return { gameTime: Math.round(window.gameTime), minions: ec.getAllMinions ? ec.getAllMinions(true).length : null, towers: ec.getAllTowers ? ec.getAllTowers(true).length : null };
});
await page.waitForTimeout(2000);
// 等塔的"损毁档模型预热"队列跑完：快进时渲染是空的，单位一次都没同步过，恢复渲染后全部塔会同时排队预热，
// 不等它跑完就量，量到的是一次性的预热开销而不是稳态（之前报告里 units.update 15.8 ms 就是这么来的）
await page.waitForFunction(() => !(window.CTX.__three.units._warmQ?.length), null, { timeout: 600000 });
await page.waitForTimeout(1000);

const result = await page.evaluate(async (SEC) => {
  const r = window.CTX.__three, gl = r.gl, T = {}, calls = {};
  const add = (k, v) => { T[k] = (T[k] || 0) + v; };
  const wrap = (obj, name, key) => { if (!obj || typeof obj[name] !== 'function') return; const f = obj[name].bind(obj); obj[name] = (...a) => { const t0 = performance.now(); const v = f(...a); add(key, performance.now() - t0); return v; }; };
  wrap(r.units, 'update', '单位更新'); wrap(r.fx, 'update', '特效'); wrap(r.weatherFx, 'update', '天气粒子');
  wrap(r.corrosionFx, 'update', '腐蚀雾'); wrap(r.groundTrace, 'update', '水洼积雪'); wrap(r.world, 'update', '世界');
  wrap(r, '_fitShadowToView', '阴影视锥');
  gl.info.autoReset = false;
  if (!r.composer) r._buildComposer();
  for (const p of r.composer.passes) {
    const nm = 'pass:' + p.constructor.name, f = p.render.bind(p);
    p.render = (...a) => { const c0 = gl.info.render.calls, t0 = performance.now(); const v = f(...a); add(nm, performance.now() - t0); calls[nm] = (calls[nm] || 0) + (gl.info.render.calls - c0); return v; };
  }
  wrap(r, 'render', '整帧');
  let n = 0, tris = 0; const t0 = performance.now();
  await new Promise((res) => { const tick = () => { n++; tris += gl.info.render.triangles; gl.info.reset(); if (performance.now() - t0 > SEC * 1000) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const ms = {}; for (const k in T) ms[k] = +(T[k] / n).toFixed(2);
  const dc = {}; for (const k in calls) dc[k] = Math.round(calls[k] / n);
  // 可见物体按类别归并
  const groups = {};
  const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  r.scene.traverse((o) => {
    if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine) || !visible(o)) return;
    let top = o; while (top.parent && top.parent !== r.scene) top = top.parent;
    const k = [o.isInstancedMesh ? 'Instanced' : o.type, Array.isArray(o.material) ? 'multi' : (o.material?.type || ''), o.material?.transparent ? '透明' : '', '顶层=' + (top.name || top.type)].filter(Boolean).join(' | ');
    groups[k] = (groups[k] || 0) + 1;
  });
  const byGroup = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 25);
  // 纹理来源：遍历场景材质上挂的贴图，按名字 / 类型归类（gl.info 只给总数）
  const texSeen = new Set(), texKinds = {};
  const kindOf = (t) => t.isRenderTargetTexture ? '渲染目标' : t.isCanvasTexture ? 'Canvas' : t.isDataTexture ? 'Data' : t.isCompressedTexture ? '压缩' : (t.image?.src ? '图片文件' : '其它');
  r.scene.traverse((o) => {
    const ms2 = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms2) for (const key in m) { const t = m[key]; if (t && t.isTexture && !texSeen.has(t)) { texSeen.add(t); const k = kindOf(t); texKinds[k] = (texKinds[k] || 0) + 1; } }
  });
  return { frames: n, fps: +(n / SEC).toFixed(1), ms, drawCalls: dc, trianglesPerFrame: Math.round(tris / n),
    gpu: { textures: gl.info.memory.textures, geometries: gl.info.memory.geometries, programs: gl.info.programs?.length ?? null },
    sceneTextures: { distinctOnMaterials: texSeen.size, byKind: texKinds }, sceneChildren: r.scene.children.length, byGroup };
}, SECONDS);

const out = { map: MAP, viewport: [W, H], ...state, ...result };
console.log(`\n=== ${MAP} @ ${state.gameTime}s（小兵 ${state.minions}，建筑 ${state.towers}），采样 ${result.frames} 帧 ===`);
console.log('\n每帧 CPU 耗时（毫秒）：'); for (const [k, v] of Object.entries(result.ms).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log('\n每帧绘制调用：'); for (const [k, v] of Object.entries(result.drawCalls)) console.log(`  ${k.padEnd(28)} ${v}`);
console.log(`\n每帧三角形 ${result.trianglesPerFrame}；GPU 纹理 ${result.gpu.textures}，几何 ${result.gpu.geometries}，着色器程序 ${result.gpu.programs}`);
console.log(`场景材质上挂的不同纹理 ${result.sceneTextures.distinctOnMaterials}：`, JSON.stringify(result.sceneTextures.byKind));
console.log('\n可见物体按类别（数量最多的 25 类）：'); for (const [k, v] of result.byGroup) console.log(`  ${String(v).padStart(5)}  ${k}`);
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log('\n已写入', JSON_OUT); }
await browser.close(); server.close();
