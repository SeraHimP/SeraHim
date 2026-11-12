// 弹道可视化（EffectsLayer + ProjectileMeshLayer）。
// 画面写实化之后用户："所有单位的弹道显示效果都要进行优化（防御塔/兵），我觉得目前的可视化弹道已经不再适配目前写实的风格了"
// ——兵弹按"手里拿的是什么"画成受光的实物（石子 / 箭 / 弩矢 / 铁弹 / 石块），法术和塔弹是收敛的光核 / 水晶弹芯 + 彗尾。
// 仍然成立的老定稿：巨龙"加纯视觉的吐息"；"命中特效太显眼了！！！……不要命中特效了"——这里钉住不再出现。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { ProjectileMeshLayer } = await import('../src/presentation/ProjectileMeshLayer.js');
const { trailEmberK } = await import('../src/presentation/EffectsLayer.js');
const { T, done } = scoreboard('弹道可视化');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const fx = src('presentation/EffectsLayer.js'), pmSrc = src('presentation/ProjectileMeshLayer.js'), cs = src('systems/CombatSystem.js');

{
  const P = CONFIG.ui.projectileFx;
  T('①参数都在 CONFIG.ui.projectileFx（塔弹 / 兵弹 / 箭 / 石子 / 法术 / 炮车 / 术士 / 吐息）',
    P.tower.trailLen > 0 && P.tower.shardLen > 0 && P.minion.sizeK > 0 && P.arrow.len > 0 && P.sling.size > 0 && P.orb.core > 0
    && P.siege.smoke > 0 && P.warlock.motes > 0 && P.breath.enabled === true);
  // 每个会放弹道的兵种都登记了形状；远程三级各不相同（投石 / 长弓 / 弩），炮车三级都是铁弹，攻城车是石块
  const SH = P.shapes, KINDS = ['stone', 'arrow', 'quarrel', 'ball', 'boulder', 'orb'];
  const shooters = Object.entries(CONFIG.templates).filter(([, t]) => t.attackMode === 'projectile' && t.type !== 'tower').map(([, t]) => t.type);
  const tiered = ['ranged_t2', 'ranged_t3', 'siege_t2', 'siege_t3'];
  T(`①b弹道兵种都登记了形状（缺：${[...shooters, ...tiered].filter((k) => !KINDS.includes(SH[k])).join(',') || '无'}）`,
    [...shooters, ...tiered].every((k) => KINDS.includes(SH[k])));
  T('①c远程三级三种弹（石子 / 箭 / 弩矢）；炮车各级是铁弹、攻城车是石块；法师系是光弹',
    new Set([SH.ranged, SH.ranged_t2, SH.ranged_t3]).size === 3 && ['siege', 'siege_t2', 'siege_t3'].every((k) => SH[k] === 'ball')
    && SH.ram === 'boulder' && SH.warlock === 'orb');
  T('②塔弹拖尾比原来长（能量光弹，原来是 2.2 倍弹径）', P.tower.trailLen > 2.2);
  T('③旧的兵弹短拖尾配置已删', CONFIG.ui.bulletTrail === undefined);
}
{
  T('④开火时快照开火者的类型（子弹飞行中开火者死了也知道该画成什么）', /kind: attacker\.type,/.test(cs));
  T('⑤塔弹走水晶弹芯（towerBolt）+ 彗尾，兵弹走 minionBolt，铁弹 / 石块走 siegeStone；软边图元借 EffectsLayer 的批',
    /this\.pm\.towerBolt\(/.test(fx) && /this\._trail\(D, V, tx, ty, tz/.test(fx) && /this\.pm\.minionBolt\(/.test(fx) && /this\.pm\.siegeStone\(/.test(fx)
    && /this\.pm\.begin\(this\._pmDraw\)/.test(fx));
  T('⑥抛物线只是画面（伤害时机与落点不变）：抛高只加在画出来的高度上', /const head = \[x, by \+ arcAt\(done\), y\]/.test(fx));
  // 用户："炮车的子弹应该是直的，目前你做成抛物线了，改掉。攻城车的抛物线很好不用改"
  const PS = CONFIG.ui.projectileFx.siege;
  T('⑥b只有攻城车走抛物线，炮车直线；轻炮的弹比攻城车的石块小',
    PS.kinds.includes('ram') && !PS.kinds.some((k) => k.startsWith('siege')) && PS.stoneScale.siege < PS.stoneScale.ram && PS.stoneScale.ram < 1
    && /const arcH = lobbed \?/.test(fx));
  // 用户："所有小兵单位的子弹可视化弄小一点点"
  T('⑥c小兵实体弹比原来小一点（原 0.3 倍弹径）', CONFIG.ui.projectileFx.minion.sizeK < 0.3 && CONFIG.ui.projectileFx.minion.sizeK >= 0.2);
  // 用户："小兵攻击塔的时候……弹道是水平打到塔上的（攻城车的抛物线除外）龙的弹道也是。如果是塔打塔的话，就是瞄准塔的中心"
  T('⑥d小兵 / 龙（非抛射）的落点不高于自己的炮口；塔打塔瞄准中心；吐息同一规则',
    /if \(p\.kind && p\.kind !== 'tower' && !lobbed\) return Math\.min\(my, full \* 0\.6\)/.test(fx)
    && /p\.kind === 'tower' && tType === 'tower'\) return full \* \(PF\.towerOnTowerK/.test(fx) && CONFIG.ui.projectileFx.towerOnTowerK === 0.5
    && /Math\.min\(mouthY, \(MYOF\(tg\.id\)/.test(fx));
  T('⑦没有命中效果（塔弹、小兵弹、吐息结尾都不放）',
    !/impact\(/.test(pmSrc) && !/sparks|shards/.test(pmSrc.replace(/\/\*[\s\S]*?\*\//, '')) && !/_hitTrack/.test(fx));
}
{
  // 用户先说"拖尾在命中敌人后要缓慢消失而不是直接消失"（原来 0.13 秒、曲线 k²，半程只剩 25%），
  // 改成 0.5 秒线性后又说"子弹拖尾渐隐的时间回调为 0.15s，目前的 0.5s 太长了"。
  // 现在：0.15 秒、线性（不再 k²，所以不会头几帧就掉光）。
  const P = CONFIG.ui.projectileFx.tower, F = P.trailFade;
  T(`⑦b命中后拖尾余烬淡出 0.15 秒（现 ${F}s）、线性`, Math.abs(F - 0.15) < 1e-9 && P.trailFadePow === 1);
  T('⑦c余烬从满开始、单调变淡、到时长收掉',
    trailEmberK(0) === 1 && trailEmberK(F * 0.25) > trailEmberK(F * 0.5) && trailEmberK(F * 0.5) > trailEmberK(F * 0.75) && trailEmberK(F) === 0);
  T(`⑦d不是一下子消失：淡出过半时（${(F / 2).toFixed(3)}s）还剩一半（${trailEmberK(F / 2).toFixed(2)}）`,
    trailEmberK(F / 2) >= 0.5 - 1e-9 && trailEmberK(F / 4) > 0.7);
  T('⑦e淡出队列在"本帧不在场"的子弹上启动（子弹消失那一帧不整条消失），且按墙钟推进',
    /if \(sn\.f === this\._fxFrame\) continue;/.test(fx) && /s\.t \+= dtWall;\s*const kk = trailEmberK\(s\.t\);/.test(fx));
}
{
  // 实例池 + 借来的软边批：数一数每种弹各画了什么
  const pm = new ProjectileMeshLayer(new THREE.Scene());
  const back = (d) => [-d, 10, 0];
  const calls = { sprite: 0, soft: 0, taper: 0 };
  const draw = { sprite: () => { calls.sprite++; }, soft: () => { calls.soft++; }, taper: () => { calls.taper++; } };
  const shoot = (fn) => { calls.sprite = calls.soft = calls.taper = 0; pm.begin(draw); fn(); pm.end(); };
  const dir = { x: 1, y: 0, z: 0 };
  shoot(() => pm.minionBolt('ranged', [0, 10, 0], dir, 12, 0xe0473f, back));
  T('⑧投石手：一颗受光的石子 + 一道拖影，没有发光体', pm.stone.mesh.count === 1 && pm.arrow.mesh.count === 0 && pm.orb.mesh.count === 0 && calls.taper === 1 && calls.sprite === 0);
  shoot(() => pm.minionBolt('ranged_t2', [0, 10, 0], dir, 12, 0xe0473f, back));
  T('⑧b长弓手：一支箭（杆 + 镞）+ 阵营色尾羽 + 一道拖影', pm.arrow.mesh.count === 1 && pm.fletch.mesh.count === 1 && pm.stone.mesh.count === 0 && calls.taper === 1);
  {
    // 箭尖落在弹头位置上（不是箭的中点）：箭的中心在弹头后面半支箭处
    const m = new THREE.Matrix4(); pm.arrow.mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); m.decompose(pos, q, sc);
    T('⑧c箭尖在弹头位置、箭身在它后面', Math.abs(pos.x + sc.x * 0.5) < 1e-6 && sc.x > 0 && Math.abs(pos.y - 10) < 1e-6);
    shoot(() => pm.minionBolt('ranged_t3', [0, 10, 0], dir, 12, 0xe0473f, back));
    const m2 = new THREE.Matrix4(); pm.arrow.mesh.getMatrixAt(0, m2);
    const sc2 = new THREE.Vector3(); m2.decompose(pos, q, sc2);
    T('⑧d弩矢比箭短、比箭粗', pm.arrow.mesh.count === 1 && sc2.x < sc.x && sc2.y / sc2.x > sc.y / sc.x);
  }
  shoot(() => pm.minionBolt('totem', [0, 10, 0], dir, 12, 0xe0473f, back));
  const orbBase = pm.orb.mesh.count;
  T('⑨法术光弹：一颗光核 + 一圈柔光 + 光尾（两层）', orbBase === 1 && calls.sprite === 1 && calls.taper === 2 && pm.stone.mesh.count === 0 && pm.arrow.mesh.count === 0);
  shoot(() => pm.minionBolt('warlock', [0, 10, 0], dir, 12, 0xe0473f, back));
  T('⑨b术士弹多三颗绕转光点', pm.orb.mesh.count === orbBase + CONFIG.ui.projectileFx.warlock.motes);
  shoot(() => pm.minionBolt('自制兵种', [0, 10, 0], dir, 12, 0xe0473f, back));
  T('⑨c没登记形状的兵种按法术光弹画（自制单位不会画不出来）', pm.orb.mesh.count === 1);
  shoot(() => pm.siegeStone([0, 30, 0], 12, 0xe0473f, back, 0.5, 'siege'));
  T('⑩炮车：一颗铁弹 + 一串软边烟团', pm.ball.mesh.count === 1 && pm.stone.mesh.count === 0 && calls.sprite === CONFIG.ui.projectileFx.siege.smoke);
  shoot(() => pm.siegeStone([0, 30, 0], 12, 0xe0473f, back, 0.5, 'ram'));
  T('⑩b攻城车：一块石头 + 烟', pm.stone.mesh.count === 1 && pm.ball.mesh.count === 0 && calls.sprite === CONFIG.ui.projectileFx.siege.smoke);
  shoot(() => pm.towerBolt([0, 40, 0], dir, 20, 0x5b9bd5, 0));
  T('⑩c塔弹：一枚水晶弹芯 + 两层柔光（外圈 + 白芯），弹芯沿飞行方向拉长', pm.bolt.mesh.count === 1 && calls.sprite === 2
    && CONFIG.ui.projectileFx.tower.shardLen > CONFIG.ui.projectileFx.tower.shardWidth * 2);
  pm.begin(); pm.minionBolt('ranged_t2', [0, 10, 0], dir, 12, 0xe0473f, back); pm.towerBolt([0, 40, 0], dir, 20, 0x5b9bd5, 0); pm.siegeStone([0, 30, 0], 12, 0xe0473f, back, 0.5); pm.end();
  T('⑩d不给软边批也能画（无头 / 测试环境）：只画实体，不报错', pm.arrow.mesh.count === 1 && pm.bolt.mesh.count === 1 && pm.ball.mesh.count === 1);
  pm.breath([0, 20, 0], [40, 5, 0], 0xff8a3d, 15);
  T('⑪巨龙吐息登记成一段短动画', pm.fx.length === 1 && pm.fx[0].type === 'breath');
  pm.fx[0].t = 10;   // 播完
  pm.begin(); pm.end();
  T('⑫吐息播完就收掉，不留任何东西（没有结尾爆开）', pm.fx.length === 0);
  T('⑬巨龙吐息只看攻击冷却跳增（纯视觉，不改战斗）', /cd <= prev \+ 0\.02\) continue;/.test(fx) && /this\.pm\.breath\(/.test(fx));
}

done();
