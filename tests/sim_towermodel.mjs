// ==================== v52：塔模型（红蓝两套造型语言）验收 ====================
// 用户定稿（原话）：
//   "太丑了你给我好好做！可以完全推翻现有的设计！总之就是水晶+塔身+装饰的设计，
//    别糊弄！红/蓝方的设计风格应完全不同！"
//
// 这一套之前失败过三轮，每一轮的失败原因都一样：**红蓝共用一套几何，只换配色**。
// 那种做法在实机的俯视视距下等于没做 —— 玩家看到的是两座一样的塔刷了两种漆。
// 所以这份用例钉的不是"某个部件长什么样"，而是**两边必须在剪影层面就分得开**：
// 高宽比、体量、顶部零件数、水晶大小与位置，逐条拉开距离。
// 数值上一律用"倍数关系"而不是绝对值 —— 造型还会调，但"蓝细高红矮宽"这件事不能退。
import { CONFIG } from '../src/data/Config.js';

let pass = 0, fail = 0;
const T = (name, ok) => { if (ok) { pass++; console.log('✓ ' + name); } else { fail++; console.log('✗ ' + name); } };

const THREE = await import('../vendor/three.module.js').catch(() => null);
if (!THREE) { console.log('跳过：three.js 不可用'); process.exit(0); }
const { towerMesh, towerDamageStage } = await import('../src/presentation/UnitMeshFactory.js');

const R = 34;
const TIERS = ['outer', 'inner', 'base', 'hq_tower'];
const mk = (fac, tier, dmg = 0) =>
  towerMesh(`tm|${fac}|${tier}|${dmg}`, fac === 'red' ? '#e05b52' : '#5b9bd5',
            R, '', 'tower', false, false, tier, fac, dmg);

const box = (m) => { m.geo.computeBoundingBox(); return m.geo.boundingBox; };
const size = (m) => { const b = box(m); return { w: b.max.x - b.min.x, d: b.max.z - b.min.z, h: b.max.y - b.min.y }; };

// ---------- 一、红蓝剪影必须分得开 ----------
for (const tier of TIERS) {
  const B = mk('blue', tier), Rd = mk('red', tier);
  const sb = size(B), sr = size(Rd);
  const arB = sb.h / Math.max(sb.w, sb.d);      // 高宽比
  const arR = sr.h / Math.max(sr.w, sr.d);
  // 蓝方【霜之尖塔】细高、红方【熔火祭坛】矮宽。这是最顶层的分野，
  // 比"顶部换个零件"管用得多 —— 缩到实机视距只剩剪影时也还在。
  T(`形①-${tier}：蓝方比红方细高（高宽比 蓝 ${arB.toFixed(2)} > 红 ${arR.toFixed(2)}）`,
    arB > arR * 1.35);
  T(`形②-${tier}：红方比蓝方占地宽（红 ${Math.max(sr.w, sr.d).toFixed(0)} > 蓝 ${Math.max(sb.w, sb.d).toFixed(0)}）`,
    Math.max(sr.w, sr.d) > Math.max(sb.w, sb.d) * 1.08);
  T(`形③-${tier}：两边不是同一份几何（顶点数不同）`,
    B.geo.attributes.position.count !== Rd.geo.attributes.position.count);
}

// ---------- 二、水晶是主角 ----------
for (const fac of ['blue', 'red']) {
  for (const tier of TIERS) {
    const m = mk(fac, tier);
    T(`晶①-${fac}/${tier}：水晶存在且是炮口（muzzleY 由水晶算出）`,
      !!m.crystal && m.muzzleY > 0 && Math.abs(m.topY - (m.crystal.cy + m.crystal.r)) < 1e-6);
    // 水晶必须在最顶上那一层 —— 它是"水晶+塔身+装饰"里的那个"水晶"，被装饰盖住就白做了。
    // 允许装饰与它**齐平**（蓝方的小尖塔、红方的角都是"围/兜"着它的，齐平才成立），
    // 但不许高出它一个身位。所以判据是"不低于石身顶减去 15% 水晶半径"，
    // 不是"严格高于石身顶"—— 后者会把"兜住"这种正当造型一起判死。
    T(`晶②-${fac}/${tier}：水晶在最顶层（装饰至多与它齐平，不许盖过主角）`,
      m.topY >= box(m).max.y - m.crystal.r * 0.15);
    // 但也不许飘在半空：底面必须落在石身之内。
    T(`晶③-${fac}/${tier}：水晶底不高于石身顶（坐得住，不悬空）`,
      m.crystal.cy - m.crystal.r <= box(m).max.y + 1e-6);
    // 不许穿模：石件顶点不得进到水晶的内切球里。
    // 这个文件为"位置写死导致穿模"翻过一次车（v44 卫星碎晶），所以单独钉一条。
    const pos = m.geo.attributes.position, inner = m.crystal.r * 0.55;
    let deepest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i), dy = pos.getY(i) - m.crystal.cy, dz = pos.getZ(i);
      deepest = Math.min(deepest, Math.hypot(dx, dy, dz));
    }
    T(`晶④-${fac}/${tier}：没有石件插进水晶内部（最近顶点 ${deepest.toFixed(1)} ≥ ${inner.toFixed(1)}）`,
      deepest >= inner);
  }
}

// ---------- 三、档次递增 ----------
for (const fac of ['blue', 'red']) {
  for (let i = 1; i < TIERS.length; i++) {
    const a = mk(fac, TIERS[i - 1]), b = mk(fac, TIERS[i]);
    T(`档①-${fac}：${TIERS[i]} 比 ${TIERS[i - 1]} 高（等级越高越气派）`, b.topY > a.topY);
    T(`档②-${fac}：${TIERS[i]} 的水晶更大`, b.crystal.r > a.crystal.r);
  }
}

// ---------- 四、损毁三档 ----------
// 用户定稿："每种塔有三档模型（正常/轻度损毁/重度损毁）这个设计要保留，
// 不过为了减少目前工作量，每种就做正常模型就行了，剩下两个扔进清单以后再做。"
// 所以本轮损毁只做最低限度表达（掉块 + 崩几件 + 轻微做旧），但**不许三档一模一样**
// —— 那样玩家完全看不出塔挨打了，是功能倒退。
for (const fac of ['blue', 'red']) {
  for (const tier of TIERS) {
    const m = [0, 1, 2].map(d => mk(fac, tier, d));
    T(`损①-${fac}/${tier}：三档炮口高度一致（否则弹道像换了一把武器）`,
      Math.abs(m[0].muzzleY - m[1].muzzleY) < 1e-6 && Math.abs(m[0].muzzleY - m[2].muzzleY) < 1e-6);
    T(`损②-${fac}/${tier}：三档石身等高（损毁不许改主体尺寸）`,
      Math.abs(box(m[0]).max.y - box(m[2]).max.y) < 1e-6);
    const vc = m.map(x => x.geo.attributes.position.count);
    T(`损③-${fac}/${tier}：三档几何两两不同（看得出塔挨打了）`,
      vc[0] !== vc[1] && vc[1] !== vc[2] && vc[0] !== vc[2]);
  }
}

// 档位推进仍然单向（这条本来在 sim_v46，这里只做一次回归确认，防止重做时被顺手改掉）
{
  const e = {};
  towerDamageStage(e, 1.0); towerDamageStage(e, 0.2);
  T('损④-损毁不可逆（治疗回满血也不退档）', towerDamageStage(e, 1.0) === 2);
  T('损⑤-节点仍然软编码在 CONFIG.ui.towerDamage',
    Array.isArray(CONFIG.ui?.towerDamage?.nodes) && CONFIG.ui.towerDamage.nodes.length === 2);
}

// ---------- 五、正面标识 ----------
// 塔会按兵线转向（UnitLayer 的 needsFacing）。模型一律朝 +Z 建，
// 正面必须有一个看得出来的记号（蓝方拱门 / 红方熔口 + 斜撑），否则转了也白转。
// 判据不能用包围盒 —— 台基是对称的，包围盒对 ±Z 一样宽，正面记号（贴在表面的门洞/熔口）
// 根本不改变包围盒。所以改成**镜像比对**：把几何沿 Z 翻过来，顶点集合必须变得不一样。
for (const fac of ['blue', 'red']) {
  const m = mk(fac, 'base');
  const pos = m.geo.attributes.position;
  const q = (v) => Math.round(v * 100) / 100;
  const front = new Set(), mirror = new Set();
  for (let i = 0; i < pos.count; i++) {
    front.add(`${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`);
    mirror.add(`${q(pos.getX(i))},${q(pos.getY(i))},${q(-pos.getZ(i))}`);
  }
  let same = 0;
  for (const k of front) if (mirror.has(k)) same++;
  T(`向①-${fac}：正面(+Z)与背面(−Z)不对称（有正面记号，转向才有意义）`,
    same < front.size);
}

console.log(`塔模型验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
