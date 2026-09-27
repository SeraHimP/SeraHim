// 水晶旁的悬浮光点 + 防御塔护盾外壳。
// 用户："在水晶旁边悬浮一些细小的粒子（不要原来常驻一成不变的粒子然后旋转）"；
// "防御塔（仅包含防御塔不包含其他单位）在有护盾（仅固定护盾/护盾，不包含临时护盾）的时候
//  塔身有那种被护盾包裹的那种效果"——贴身外壳、金白色、"不要越厚越亮，但是要做出被打时候闪一下"。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { crystalParticles, towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
const { shellGeometry, shellMaterial, stepShieldState } = await import('../src/presentation/shieldShell.js');
const { T, done } = scoreboard('水晶光点 + 护盾外壳');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const ul = src('presentation/UnitLayer.js');

{
  const M = CONFIG.ui.crystal.motes;
  T('①光点参数都在 CONFIG.ui.crystal.motes（软编码）',
    M.count > 0 && M.radius.length === 2 && M.speed.length === 2 && M.rise > 0 && M.size > 0 && M.maxPx > 0);
  const pts = crystalParticles('#5b9bd5', 10);
  const u = pts.material.uniforms;
  T('②光点在着色器里按时间运动（有 uTime、每颗带随机种子），颗数跟配置走',
    !!u && 'uTime' in u && pts.geometry.getAttribute('seed').count === M.count);
  T('③光点不再跟着水晶一起转（每帧抵消掉父级水晶的自转）', /en\.crystalPts\.rotation\.y = -en\.crystal\.rotation\.y/.test(ul));
  T('④旧的"绕水晶公转"配置已删（particleSpin 没人读了）', CONFIG.ui.crystal.particleSpin === undefined && !/particleSpin/.test(ul));
}

{
  const S = CONFIG.ui.towerShield;
  T('⑤护盾外壳参数都在 CONFIG.ui.towerShield（软编码）', S.enabled === true && S.inflate > 0 && S.color && S.flashDur > 0 && S.fadeIn > 0 && S.fadeOut > 0);
  // 状态推进：出现淡入、被打闪一下、没了淡出；亮度与护盾厚薄无关
  const run = (seq) => { const st = { alpha: 0, flash: 0, prev: 0 }; const out = []; for (const a of seq) { stepShieldState(st, a, 0.05); out.push({ ...st }); } return out; };
  const thin = run(Array(20).fill(50)), thick = run(Array(20).fill(5000));
  T('⑥有护盾时淡入到满，满了以后亮度与护盾多少无关（"不要越厚越亮"）',
    thin[0].alpha > 0 && thin[0].alpha < 1 && thin[19].alpha === 1 && thick[19].alpha === thin[19].alpha);
  const hit = run([...Array(10).fill(500), 400, 400, 400, 400, 400, 400, 400]);
  T('⑦被打（护盾值下降）闪一下，随后衰减回 0', hit[10].flash === 1 - 0.05 / S.flashDur && hit[16].flash === 0);
  // 用户："塔护盾受击这个光快把我晃瞎了"——连续受击不能一直闪，也不能亮到辉光阈值
  const spam = run(Array.from({ length: 40 }, (_, i) => 5000 - i * 10));
  const flashes = spam.filter((f, i) => i > 0 && f.flash > spam[i - 1].flash).length;
  T(`⑦b连续受击（2 秒里每帧掉血）最多每 ${S.flashCooldown}s 闪一次（实际 ${flashes} 次）`, flashes <= Math.ceil(2 / S.flashCooldown) + 1);
  const mm = shellMaterial(32);
  T('⑦c外壳不用叠加混合、透明度有上限（颜色到不了辉光阈值）', mm.blending === THREE.NormalBlending && mm.uniforms.uMaxA.value <= 0.8);
  const brk = run([...Array(10).fill(500), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  T('⑧被打穿：闪一下然后淡出消失', brk[10].flash > 0 && brk[10].alpha < 1 && brk[20].alpha === 0);
  T('⑨只算固定护盾 + 护盾，不算临时护盾', /\(e\.shieldFixedCurrent \|\| 0\) \+ \(e\.plainShield \|\| 0\)/.test(ul.slice(ul.indexOf('_syncShieldShell(e, en, dead, y)'))) && !/tempShield/.test(ul.slice(ul.indexOf('_syncShieldShell(e, en, dead, y)'), ul.indexOf('_disposeShieldShell(en) {'))));
  T('⑩只包防御塔：召唤水晶、水晶枢纽、据点不包', /e\._mapTier !== 'nexus_lane' && e\._mapTier !== 'nexus_main' && !e\.isCapturePoint/.test(ul));
  // 外壳几何：平滑法线、没有零向量（零法线会让着色器出 NaN，辉光把它糊成满屏黑块）
  const m = towerMesh('fx-test', '#5b9bd5', 32, '', 'tower', false, false, 'outer', 'blue', 0, null);
  const g = shellGeometry(m.geo), n = g.getAttribute('normal');
  let zero = 0;
  for (let i = 0; i < n.count; i++) if (Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) < 0.5) zero++;
  T(`⑪外壳几何与塔身同顶点数、法线全部是单位向量（零法线 ${zero} 个）`, g.getAttribute('position').count === m.geo.getAttribute('position').count && zero === 0);
  T('⑫外壳几何按塔身几何缓存（同一份塔身只算一次）', shellGeometry(m.geo) === g);
  const mat = shellMaterial(32);
  T('⑬外壳是不写深度的透明材质，贴地碎块/石台底部不包（uMinY > 0）',
    mat.transparent && mat.depthWrite === false && mat.uniforms.uMinY.value > 0);
}

done();
