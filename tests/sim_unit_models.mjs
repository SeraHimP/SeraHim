// 小兵 / 巨龙造型重做 + 四肢动画（unitModels.js / dragonModel.js / unitRig.js）。
// 用户（2026-09-27）："重做目前所有小兵/巨龙模型。小兵的模型参照不同阵营的风格来做，近战兵拿刀盾，
// 远程兵拿法杖，超级兵是机甲风格……龙的话不需要每种都做一个模型，就是通过装饰 + 龙的颜色区分龙的不同类型。
// 最好也能把小兵攻击行走的动画做出来"。定稿：跟塔同一套阵营风格、全部重做、每种元素一套装饰、模型 + 基础动画直接接入。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG, MINION_SIZES } = await import('../src/data/Config.js');
const { buildMinion, MINION_MODEL_TYPES } = await import('../src/presentation/unitModels.js');
const { buildDragon, DRAGON_DECOR_KEYS } = await import('../src/presentation/dragonModel.js');
const { BONE, animMaterials, stepAnimState, liveAnimBodies } = await import('../src/presentation/unitRig.js');
const { DRAGON_ELEMENTS } = await import('../src/systems/DragonSystem.js');
const { setUnitTint } = await import('../src/presentation/UnitMeshFactory.js');
const { BodyInstancer } = await import('../src/presentation/InstancedBodyLayer.js');
const { T, done } = scoreboard('小兵/巨龙造型与动画');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

const U = CONFIG.ui.unitModels;
T('①配色、龙装饰点缀色、动画幅度都在 CONFIG.ui.unitModels（软编码）',
  !!U.order.armor && !!U.chaos.armor && Object.keys(U.dragonAccent).length >= 14
  && U.anim.legSwing > 0 && U.anim.windup > 0 && U.anim.attackDur > 0 && U.anim.wingFlap > 0);

// ---- 小兵 ----
const bonesOf = (geo) => { const b = geo.getAttribute('aBone'); const set = new Set(); for (let i = 0; i < b.count; i++) set.add(Math.round(b.getX(i))); return set; };
const sizeOf = (t) => MINION_SIZES[t] ?? 10;
const builtin = [...Object.keys(CONFIG.gameRules.spawnEnabled), 'shepherd_pet', 'summon_spirit'];
T(`②内置兵种全部有专属造型（${builtin.length} 种）`, builtin.every((t) => MINION_MODEL_TYPES.includes(t)));

let shapeOk = true, bonesOk = true, factionDiff = true;
const bad = [];
for (const t of builtin) {
  const S = sizeOf(t);
  const b = buildMinion(t, '#5b9bd5', S, 'blue'), r = buildMinion(t, '#e0473f', S, 'red');
  for (const m of [b, r]) {
    const bb = m.geo.boundingBox;
    const rad = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z);
    // 贴地、高度合理、占地与兵种尺寸同量级（碰撞半径就是这个尺寸）
    if (Math.abs(bb.min.y) > 1e-4 || m.topY < S * 1.0 || m.topY > S * 2.8 || rad > S * 1.15) { shapeOk = false; bad.push(`${t}:h${(m.topY / S).toFixed(2)} r${(rad / S).toFixed(2)}`); }
    if (!m.geo.getAttribute('aBone') || !m.geo.getAttribute('aPivot') || !m.geo.userData.animated) bonesOk = false;
  }
  if (t !== 'summon_spirit' && t !== 'shepherd_pet') {
    // 两个阵营造型不同：顶点数或包围盒至少有一项不同
    const same = b.geo.getAttribute('position').count === r.geo.getAttribute('position').count
      && Math.abs(b.topY - r.topY) < 1e-6;
    if (same) factionDiff = false;
  }
}
T(`③所有造型贴地、高度与占地和兵种尺寸同量级${bad.length ? '（' + bad.join(' ') + '）' : ''}`, shapeOk);
T('④几何带骨骼属性（aBone / aPivot），标记为可动画', bonesOk);
T('⑤同一兵种蓝红两方造型不同（蓝方庄重沉稳、红方混沌尖锐，不只是换色）', factionDiff);

const has = (t, ...bs) => { const s = bonesOf(buildMinion(t, '#5b9bd5', sizeOf(t), 'blue').geo); return bs.every((x) => s.has(x)); };
const hasNot = (t, ...bs) => { const s = bonesOf(buildMinion(t, '#5b9bd5', sizeOf(t), 'blue').geo); return bs.every((x) => !s.has(x)); };
T('⑥人形兵走路会摆腿、主手能挥动（近战 / 远程 / 治疗 / 工程 / 唤灵 / 超级兵）',
  ['melee', 'ranged', 'healer', 'engineer', 'summoner', 'super'].every((t) => has(t, BONE.LEG_L, BONE.LEG_R)) &&
  ['melee', 'ranged', 'healer', 'engineer'].every((t) => has(t, BONE.ARM_MAIN)));
T('⑦近战兵：主手刀、副手盾，各挂一根骨', has('melee', BONE.ARM_MAIN, BONE.ARM_OFF));
T('⑧载具：炮车 / 投石车 / 重装车有车轮骨；炮车炮管后坐、投石车抛臂推击、超级兵出拳',
  ['siege', 'ram', 'heavy'].every((t) => has(t, BONE.WHEEL)) && has('siege', BONE.RECOIL) && has('ram', BONE.THRUST) && has('super', BONE.THRUST));
T('⑨非人形辅助单位（图腾 / 术士 / 蚀骨 / 召唤物）没有腿，改为悬浮 / 环绕件',
  ['totem', 'warlock', 'corrupt', 'shepherd_pet'].every((t) => hasNot(t, BONE.LEG_L, BONE.LEG_R))
  && has('totem', BONE.BOB, BONE.SPIN) && has('warlock', BONE.SPIN) && has('corrupt', BONE.WING));
T('⑩重装车是低矮的载具（比人形兵矮）', buildMinion('heavy', '#5b9bd5', 13, 'blue').topY < buildMinion('melee', '#5b9bd5', 13, 'blue').topY);

// 用户："小兵的模型重做弄得精细一些！！！目前兵的轮廓就是一个圆 + 一个圆台，太丑了！！完全重做！！！"
// 钉行为形状：人形兵宽肩窄腰（V 形），四肢分开（腿骨上的顶点左右分成两团），不是一根圆柱身子
{
  // 只量躯干（骨号 0）：这个高度上还有前臂和手，算进去就不是"腰"了
  const widthAt = (geo, y0, y1) => { const p = geo.getAttribute('position'), b = geo.getAttribute('aBone'); let w = 0;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (Math.round(b.getX(i)) === 0 && y >= y0 && y <= y1) w = Math.max(w, Math.abs(p.getX(i))); } return w; };
  let vOk = true;
  const vBad = [];
  for (const t of ['melee', 'engineer', '__custom__']) for (const f of ['blue', 'red']) {
    const S = 10, g = buildMinion(t, f === 'blue' ? '#5b9bd5' : '#e0473f', S, f).geo;
    const sh = widthAt(g, S * 1.12, S * 1.3), waist = widthAt(g, S * 0.8, S * 0.9);
    if (!(sh > waist * 1.3)) { vOk = false; vBad.push(`${t}/${f} 肩${sh.toFixed(1)} 腰${waist.toFixed(1)}`); }
  }
  T(`㉕人形兵宽肩窄腰（肩宽 > 腰宽 × 1.3）${vBad.length ? '（' + vBad.join(' ') + '）' : ''}`, vOk);
  const legSplit = (geo) => { const b = geo.getAttribute('aBone'), p = geo.getAttribute('position'); let l = 0, rr = 0;
    for (let i = 0; i < b.count; i++) { const k = Math.round(b.getX(i)); if (k === BONE.LEG_L) l += p.getX(i) > 0 ? 1 : 0; if (k === BONE.LEG_R) rr += p.getX(i) < 0 ? 1 : 0; } return l > 0 && rr > 0; };
  T('㉖两条腿分开建（左腿骨在 +X、右腿骨在 -X），不是一整个袍筒', ['melee', 'engineer'].every((t) => legSplit(buildMinion(t, '#5b9bd5', 10, 'blue').geo)));
  const warl = bonesOf(buildMinion('warlock', '#5b9bd5', 10, 'blue').geo);
  T('㉗术士兵不再是一整个圆锥：有两只袖子（主手 / 副手骨）', warl.has(BONE.ARM_MAIN) && warl.has(BONE.ARM_OFF));
}

// ---- 巨龙 ----
const els = Object.keys(DRAGON_ELEMENTS);
T(`⑪每种元素（${els.length} 种）+ 远古龙都有一套专属装饰`, els.every((e) => DRAGON_DECOR_KEYS.includes(e)) && DRAGON_DECOR_KEYS.includes('ancient'));
const dg = els.map((e) => buildDragon(DRAGON_ELEMENTS[e].color, e, false, 34));
const counts = new Set(dg.map((d) => d.geo.getAttribute('position').count));
T(`⑫元素龙之间装饰不同（${els.length} 种里顶点数互不相同的有 ${counts.size} 种）`, counts.size >= els.length - 2);
const anc = buildDragon('#e67e22', null, true, 44);
T('⑬远古龙更大', anc.topY > dg[0].topY);
const db = bonesOf(dg[0].geo);
T('⑭巨龙：对角两组腿、双翼扇动、颈头扑咬、尾巴摆', [BONE.LEG_L, BONE.LEG_R, BONE.WING, BONE.BITE, BONE.TAIL].every((b) => db.has(b)));

// ---- 动画状态 ----
{
  const st = { walk: 0, atk: -1 };
  stepAnimState(st, true, false, 1 / 60);
  const w1 = st.walk;
  for (let i = 0; i < 60; i++) stepAnimState(st, true, false, 1 / 60);
  const w2 = st.walk;
  stepAnimState(st, false, false, 1 / 60);
  const w3 = st.walk;
  for (let i = 0; i < 120; i++) stepAnimState(st, false, false, 1 / 60);
  T('⑮走路幅度：起步平滑升到 1，停下平滑降到 0（不是一帧跳变）', w1 > 0 && w1 < 0.5 && w2 === 1 && w3 < 1 && w3 > 0.5 && st.walk === 0);
  stepAnimState(st, false, true, 1 / 60);
  const a0 = st.atk;
  let n = 0;
  while (st.atk >= 0 && n < 1000) { stepAnimState(st, false, false, 1 / 60); n++; }
  const dur = n / 60;
  T(`⑯攻击：打出一次就从 0 开始，走完一个攻击动作（${dur.toFixed(2)}s，配置 ${U.anim.attackDur}s）后结束`, a0 === 0 && Math.abs(dur - U.anim.attackDur) < 0.05);
}

// 用户："小兵移动的时候有腿的单位腿并不会动，看起来就像是平移一样"——根因：渲染帧比仿真步密，
// 位置没变的那几帧把走路相位 × 0.9 往 0 拉，腿几乎不摆。模拟 120Hz 渲染、60Hz 移动（隔一帧才动一次）：
{
  const { UnitLayer } = await import('../src/presentation/UnitLayer.js');
  const pose = UnitLayer.prototype._updatePose;
  const e = { pos: { x: 0, y: 0 }, attackCooldown: 0 };
  const en = { lastX: null, lastZ: null, bodySize: 10 };
  const phases = [];
  for (let f = 0; f < 240; f++) {
    if (f % 2 === 0) e.pos.x += 55 / 60;            // 移速 55，仿真 60Hz
    pose.call({}, e, en, f / 120);
    phases.push(en.poseWalkPhase || 0);
  }
  const mono = phases.every((p, i) => i === 0 || p >= phases[i - 1] - 1e-9);
  const cycles = (phases[239] - phases[0]) / (Math.PI * 2);
  T(`㉘高刷屏上隔帧移动：走路相位一直前进（2 秒迈了 ${cycles.toFixed(1)} 整步）、走路幅度保持在 1（${en.anim.walk.toFixed(2)}）`,
    mono && cycles > 1.2 && cycles < 6 && en.anim.walk > 0.95);
  for (let f = 240; f < 360; f++) pose.call({}, e, en, f / 120);   // 停下 1 秒
  T('㉙停下后走路幅度平滑降到 0（腿收回），相位不再被拉回 0', en.anim.walk < 0.05 && en.poseWalkPhase === phases[239]);
}
T('㉚走路时主手（连同武器）小幅摆动，幅度软编码', U.anim.mainArmWalk > 0.6 && animMaterials(true).userData.animUniforms.uAnimK3.value.z === U.anim.mainArmWalk);

// ---- 材质 / 着色器 ----
{
  const m = animMaterials(true);
  const fake = { uniforms: {}, vertexShader: '#include <common>\nvoid main(){\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}', fragmentShader: '' };
  m.onBeforeCompile(fake);
  const d = { uniforms: {}, vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}', fragmentShader: '' };
  m.userData.depthMaterial.onBeforeCompile(d);
  T('⑰动画注入：本体同时改法线与位置；合批版读实例属性 aAnim；幅度走 uniform（可随配置刷新）',
    /UNIT_ANIM_INST/.test(fake.vertexShader) && /unitAnim\(uaP, objectNormal\)/.test(fake.vertexShader) && /unitAnim\(transformed, uaN\)/.test(fake.vertexShader)
    && fake.uniforms.uAnimK && fake.uniforms.uAnimK.value.x === U.anim.legSwing);
  T('⑱阴影深度材质、描边预渲染材质走同一套变形（否则影子 / 描边是静止姿势）',
    /unitAnim\(transformed/.test(d.vertexShader) && !!m.userData.prepassMaterial && m.userData.prepassMaterial.isMeshNormalMaterial);
  const u = animMaterials(false);
  T('⑲单体版（巨龙）本体 / 描边 / 阴影共用同一个姿势 uniform',
    u.userData.prepassMaterial.userData.uAnim === u.userData.uAnim && u.userData.depthMaterial.userData.uAnim === u.userData.uAnim);
  setUnitTint('#445566');
  T('⑳昼夜染色同样染到动画材质', liveAnimBodies().every((x) => '#' + x.color.getHexString() === '#445566'));
  setUnitTint('#ffffff');
}

// ---- 合批接线 ----
{
  const scene = new THREE.Scene();
  const inst = new BodyInstancer(scene);
  const g = buildMinion('melee', '#5b9bd5', 10, 'blue');
  const slots = [];
  for (let i = 0; i < 30; i++) slots.push(inst.alloc('test|melee', g.geo, new THREE.MeshStandardMaterial(), false));
  const b = slots[0].bucket;
  b.setAnim(slots[3].index, 1.5, 1, 0.25, 7);
  const a = g.geo.getAttribute('aAnim');
  T('㉑小兵桶：换动画材质、每个实例一组 aAnim、扩容后已写的值不丢',
    b.animated && b.mat.userData.isUnitAnim && a.count >= 30 && a.getX(slots[3].index) === 1.5 && a.getZ(slots[3].index) === 0.25
    && b.mesh.customDepthMaterial === b.mat.userData.depthMaterial && b.mesh.userData.prepassMaterial === b.mat.userData.prepassMaterial);
  const tg = new THREE.BoxGeometry(1, 1, 1);
  const ts = inst.alloc('test|tower', tg, new THREE.MeshStandardMaterial(), true);
  T('㉒塔桶不受影响（没有 aAnim，材质照旧）', !ts.bucket.animated && !ts.bucket.geo.getAttribute('aAnim'));
  inst.dispose();
}
{
  const ul = src('presentation/UnitLayer.js'), fx = src('presentation/PostFX.js');
  T('㉓渲染层每帧写动画参数（走路相位 / 幅度 / 攻击进度 / 时间），巨龙按元素建模',
    /en\.unit\.setAnim\(walkPhase, an\.walk, an\.atk, tt\)/.test(ul) && /uAnim\.value\.set\(walkPhase, an\.walk, an\.atk, tt\)/.test(ul)
    && /dragonMesh\(key, color, anc, size, el\)/.test(ul));
  T('㉔描边预渲染优先用物体自带的动画法线材质', /prepassMaterial/.test(fx));
}

done();
