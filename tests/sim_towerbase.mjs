/**
 * sim_towerbase.mjs —— 塔基（地面 → 石台 → 塔）验收
 *
 * 用户："目前的塔模型根本无法融入地形……最重要的就是塔/小兵和环境的割裂感！"
 * 外部评审同一结论："塔太像一个完全独立的建筑"，并明确指出**别把塔基做成
 * "地面色压暗一档"**——冰封图地面本来就亮，压暗一档得到的仍是一块深色贴片，
 * 等于把问题换个位置。
 *
 * 这一套钉的是**三层色阶关系**与**几何往下长**这两条，不钉具体色值：
 * 调色板会改，色值钉死等于每换一次配色都要来改断言（见 DEVELOPMENT.md §8.2）。
 */
import { CONFIG } from '../src/data/Config.js';
import { srcOf, scoreboard } from './_harness.mjs';

const { T, done } = scoreboard('塔基（地面 → 石台 → 塔）');

const hex2rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  if (!m) return null;
  const v = m[1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};
/** 与 UnitMeshFactory.mixHex 同一套线性插值（k=0 取 a，k=1 取 b）。 */
const mix = (a, b, k) => hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * k);
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

// ==================== 一、软编码（第 2 条铁律）====================
{
  const F = CONFIG.ui?.towerFoundation;
  T('基①-塔基参数在 CONFIG 里，不是散在源码里的魔数',
    !!F && typeof F.enabled === 'boolean'
    && Number.isFinite(F.height) && Number.isFinite(F.spread) && Number.isFinite(F.groundMix));
  T('基①b-默认开启', F.enabled === true);
  // 高而窄的台座在 45° 下只露侧面，而侧面吃不到光 —— 实测第一版（0.22 / 1.34）
  // 采样出来比塔身侧面还暗，等于又垫了一块黑砖。压扁加宽才露得出受光的顶面。
  T(`基②-塔基是"压扁加宽"而不是"又一个方块"（spread ${F.spread} > 1，且明显大于 height ${F.height}）`,
    F.spread > 1 && F.spread > F.height * 4);
}

// ==================== 二、三层色阶：地面(亮) → 塔基(中) → 塔身(暗) ====================
{
  const F = CONFIG.ui.towerFoundation;
  const frost = CONFIG.stylizedPalettes.frost;
  const ground = frost.corridorColor, stone = frost.towerStone;
  const base = mix(stone, ground, F.groundMix);
  const lg = lum(hex2rgb(ground)), ls = lum(hex2rgb(stone)), lb = lum(base);
  T(`色①-塔基明度落在地面与塔身之间（塔身 ${ls.toFixed(0)} < 塔基 ${lb.toFixed(0)} < 地面 ${lg.toFixed(0)}）`,
    ls < lb && lb < lg);
  // 这条是外部评审点名的失败模式：塔基如果比塔身还暗，就成了"地面上的一块黑贴片"。
  T('色②-塔基必须比塔身**亮**（不能做成"地面色压暗一档"）', lb > ls);
  // 也不能亮到跟地面分不开，否则台座的轮廓读不出来。
  T(`色③-塔基与地面仍有可读的明度差（${(lg - lb).toFixed(0)} ≥ 12）`, lg - lb >= 12);
}

// ==================== 三、几何往 y<0 长（pack 会把底面对齐回 0）====================
{
  const f = srcOf('src/presentation/UnitMeshFactory.js');
  T('几①-塔基几何加在 y<0 一侧（pack 会把底面对齐回 y=0，塔身因此整体上抬一个塔基高度）',
    /T\(0, -fh \+ fh \* 0\.21, 0\)/.test(f) && /T\(0, -fh \* 0\.58 \+ fh \* 0\.29, 0\)/.test(f));
  T('几②-pack 仍然把底面强制对齐到 y=0（塔基落地的前提）',
    /const dy = -geo\.boundingBox\.min\.y;/.test(f));
  // 废墟是"塔没了"，垫个完好的台座会读成"台座上摆了一堆碎石"。
  T('几③-废墟不加塔基', /if \(!ruin && pal && pal\.foundation\)/.test(f));
  T('几④-塔基色走中间色插值 mixHex，不是 shade（压暗）',
    /const fc = mixHex\(F\.stone, FD\.ground \|\| F\.stone, FD\.groundMix/.test(f));
  // 形状必须跟阵营的塔身走：蓝方方塔配六边形台座就是"设计语言不统一"。
  T('几⑤-塔基形状随阵营（蓝方方台 / 红方多棱台），不是一律拉圆柱',
    /const fRed = faction === 'red';/.test(f)
    && /fRed\s*\?\s*new THREE\.CylinderGeometry/.test(f)
    && /new THREE\.BoxGeometry\(r \* 1\.78, h, r \* 1\.78\)/.test(f));
}

// ==================== 四、地面色的来源分流 + 缓存 key ====================
{
  const ul = srcOf('src/presentation/UnitLayer.js');
  // ⚠️ 只有 visualStyle==='stylized' 的图才按调色板画地面，三张老地图的走廊是写死的
  //    #2b3647（见 TerrainLayer 的 navMode 分支）。一律读调色板的话，老地图的塔基
  //    会按一个画面上根本不存在的颜色去配，等于白配。
  T('源①-地面色按 visualStyle 分流（老地图不会拿调色板的颜色去配）',
    /visualStyle === 'stylized' \? \(pal\.corridorColor \|\| '#2b3647'\) : '#2b3647'/.test(ul));
  // 几何按 key 全局缓存：地面色随地图变，不进 key 就会命中上一张图的几何，
  // 而且**只在切图时复现**——本仓库已经在 paletteId 上踩过一次同样的坑。
  T('源②-地面色进了塔几何缓存 key', /\$\{foundation \? groundHex : 'nf'\}/.test(ul));
  T('源③-关掉开关就不传 foundation（一处开关能整体回退）',
    /fd\?\.enabled \? \{ \.\.\.fd, ground: groundHex \} : null/.test(ul));
}

done();
