// 体积雾质感（天气雾 + 腐蚀塔毒雾）。
// 用户："目前我觉得虽然体积雾做出来了，但是看起来很粗糙"；"腐蚀性塔的可视化弹道效果也改为体积雾的，
// 然后每波脉冲那个雾的效果也要做出来"。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { fogNoiseTexture } = await import('../src/presentation/fogNoise.js');
const { T, done } = scoreboard('体积雾质感');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

const tex = fogNoiseTexture();
const N = tex.image.width, d = tex.image.data;
const at = (x, y, c = 0) => d[(((y + N) % N) * N + ((x + N) % N)) * 4 + c];
let diff = 0, n = 0, seam = 0;
for (let y = 0; y < N; y += 3) for (let x = 0; x < N; x += 3) { diff += Math.abs(at(x, y) - at(x + 1, y)); n++; }
for (let y = 0; y < N; y++) seam = Math.max(seam, Math.abs(at(N - 1, y) - at(0, y)), Math.abs(at(y, N - 1) - at(y, 0)));
let lo = 255, hi = 0;
for (let i = 0; i < N * N; i++) { lo = Math.min(lo, d[i * 4]); hi = Math.max(hi, d[i * 4]); }
T(`①噪声贴图 ${N}²、平滑（相邻像素平均差 ${(diff / n).toFixed(1)}，纯随机约 85）`, N >= 256 && diff / n < 6);
T(`②可无缝平铺（左右 / 上下两边最大落差 ${seam}）`, seam < 12);
T(`③有明显的浓淡起伏（取值范围 ${lo}–${hi}），不是一片均匀灰`, hi - lo > 100);
T('④确定性：同一张贴图只生成一次（全场共用）', fogNoiseTexture() === tex);

const V = CONFIG.volumetricFog;
T('⑤雾团是大尺度（噪声频率比原来的 0.004 低得多），覆盖阈值留出淡区、域扭曲拉出丝缕，全部软编码',
  V.noiseScale < 0.002 && V.coverage[0] > 0.1 && V.coverage[1] < 0.95 && V.warpStrength > 0 && V.heightJitter > 0);
const pf = src('presentation/PostFX.js');
T('⑥雾着色器：域扭曲 + 两层反向流动 + 覆盖阈值 + 起伏雾顶 + 抖动去色带，旧的 64² 随机噪声已删',
  /vec2 warp = /.test(pf) && /smoothstep\(coverage\.x, coverage\.y, nRaw\)/.test(pf) && /n \* heightJitter/.test(pf)
  && /fogHash\(gl_FragCoord\.xy\)/.test(pf) && !/buildFogNoiseTexture/.test(pf) && /fogNoiseTexture\(\)/.test(pf));
const tr = src('presentation/ThreeRenderer.js');
T('⑦沙暴：沿风向拉长成沙带、流速按风走（参数软编码）',
  V.sandstormStretch > 1 && /sandstormCharge \* \(CONFIG\.volumetricFog\?\.sandstormStretch/.test(tr) && /sandstormCharge \* \(CONFIG\.volumetricFog\?\.sandstormFlow/.test(tr));

const C = CONFIG.ui.corrosionFx, cl = src('presentation/CorrosionLayer.js');
T('⑧腐蚀雾：体积雾着色器（视线穿过厚度 × 噪声浓度），与天气雾共用噪声贴图，地面以下不算',
  /1\.0 - exp\(-uDensity \* acc \* chord \/ uRadius\)/.test(cl) && /fogNoiseTexture\(\)/.test(cl) && /\(vWorld\.y - uGround\) \/ -d\.y/.test(cl));
T('⑨每波脉冲是一圈向外推的雾浪（空心壳，厚度 / 浓度软编码），发波节奏仍 = 攻速',
  C.waveShell > 0 && C.waveShell < 1 && C.waveDensity > 0 && /uShell > 0\.0/.test(cl) && /const interval = 1 \/ Math\.max\(0\.1, as\);/.test(cl));
T('⑩腐蚀雾拿到相机（视线方向）与地图（地面高度）', /this\.corrosionFx\.camera = this\.camera/.test(tr) && /this\.corrosionFx\.mapSystem = mapSystem/.test(tr));
const trs = src('presentation/ThreeRenderer.js');
T('⑪毒雾以塔杖顶的水晶为心（muzzleOffsetOf + muzzleYOf），水晶周围留空；毒圈判定仍按塔的坐标（这里只是画面）',
  /this\.corrosionFx\.update\([\s\S]{0,200}muzzleOffsetOf\(t\.id\)[\s\S]{0,80}muzzleYOf\(t\.id\)/.test(trs) && /if \(cp\) rec\.dome\.position\.set\(cp\.x, cp\.y, cp\.z\)/.test(cl)
  && C.coreClear > 0 && /smoothstep\(uCore, uCore \+ 0\.25, r\)/.test(cl));
done();
