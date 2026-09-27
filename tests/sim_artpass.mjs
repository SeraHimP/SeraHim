// 召唤师峡谷 / 扭曲丛林 / 冰封 的画面修正：对比度、障碍物颜色、边界柱、植被密度、阵营底色。
// 钉的是"形状"：对比度达标、字段存在且被读、默认值保持其它地图不变；不钉具体色值。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { CONFIG } = await import('../src/data/Config.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { T, done } = scoreboard('峡谷/扭曲丛林/冰封画面修正');

const P = CONFIG.stylizedPalettes;
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const sat = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const mx = Math.max(...c), mn = Math.min(...c), l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
};
const list = Array.isArray(MAPS) ? MAPS : Object.values(MAPS);
const tt = list.find((m) => m.id === 'twisted_treeline_v1');

{
  const mf = P.magicForest;
  const cr = contrast(mf.corridorColor, mf.jungleColor);
  T(`①扭曲丛林路:野区亮度对比 ≥ 4.5（现 ${cr.toFixed(2)}，改前 1.22）`, cr >= 4.5);
  T('②扭曲丛林仍是紫色相（路面 R、B 都高于 G）', (() => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(mf.corridorColor.slice(i, i + 2), 16));
    return r > g && b > g;
  })());
  // 原来的"障碍物换岩石色"已被用户否掉（"区分可走不可走不是改个颜色"），改成树冠盖满，见 sim_jungle_canopy。
  T('③扭曲丛林的野区障碍物走树冠布局（有东西挡着，不是换个颜色）',
    mf.jungleLayout === 'canopy' && !!mf.forestFloorColor && mf.obstacleColor === undefined);
  T('④扭曲丛林关掉了沿路等距排开的边界柱', tt.boundaryPillars === false);
}
{
  const f = P.forest;
  T(`⑦召唤师峡谷走廊降饱和（${sat(f.corridorColor).toFixed(2)}，改前 0.42）`, sat(f.corridorColor) < 0.35);
  T('⑧召唤师峡谷野区走树冠布局（代替上一轮的"更少、更大"）', f.jungleLayout === 'canopy' && f.vegetationStep === undefined);
  const fr = P.frost;
  T('⑨冰封的阵营底色收窄、减淡', fr.baseTintRadiusFrac < 0.30 && fr.baseTintAlpha < 0.20);
}
{
  const src = (f) => fs.readFileSync(new URL('../src/presentation/' + f, import.meta.url), 'utf8');
  const tl = src('TerrainLayer.js'), vg = src('VegetationLayer.js');
  T('⑩未声明新字段的调色板保持原值（阵营底色默认 0.30 / 0.20）',
    /SV\.baseTintRadiusFrac \?\? 0\.30/.test(tl) && /SV\.baseTintAlpha \?\? 0\.20/.test(tl));
  const others = Object.entries(P).filter(([k]) => !['forest', 'magicForest', 'frost'].includes(k));
  T('⑪其它调色板没有被顺手加上这些字段', others.every(([, v]) =>
    v.jungleLayout === undefined && v.baseTintAlpha === undefined));
}

done();
