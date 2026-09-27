// 弹道可视化重做（EffectsLayer + ProjectileMeshLayer）。
// 用户定稿："A 为主，塔弹用 B"（小兵低多边形实体弹、防御塔能量光弹）；巨龙"加纯视觉的吐息"；
// 命中效果做过一版后用户："命中特效太显眼了！！！……不要命中特效了"——已删，这里钉住不再出现。
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
  T('①参数都在 CONFIG.ui.projectileFx（塔弹 / 小兵弹 / 炮车 / 术士 / 吐息）',
    P.tower.trailLen > 0 && P.minion.afterimages > 0 && P.siege.kinds.includes('siege') && P.warlock.motes > 0 && P.breath.enabled === true);
  T('②塔弹拖尾比原来长（能量光弹，原来是 2.2 倍弹径）', P.tower.trailLen > 2.2);
  T('③旧的兵弹短拖尾配置已删', CONFIG.ui.bulletTrail === undefined);
}
{
  T('④开火时快照开火者的类型（子弹飞行中开火者死了也知道该画成什么）', /kind: attacker\.type,/.test(cs));
  T('⑤塔弹走能量光弹（光晕 + 核心 + 白芯），小兵弹走实体弹、炮车走抛物线石弹',
    /if \(isTower\) \{[\s\S]{0,400}Q\.sprite3/.test(fx) && /this\.pm\.minionBolt\(/.test(fx) && /this\.pm\.siegeStone\(/.test(fx));
  T('⑥炮车抛物线只是画面（伤害时机与落点不变）：抛高只加在画出来的高度上', /const head = \[x, by \+ arcAt\(done\), y\]/.test(fx));
  T('⑦没有命中效果（塔弹、小兵弹、吐息结尾都不放）',
    !/impact\(/.test(pmSrc) && !/sparks|shards/.test(pmSrc.replace(/\/\*[\s\S]*?\*\//, '')) && !/_hitTrack/.test(fx));
}
{
  // 用户："防御塔弹道的拖尾在命中敌人后要缓慢消失而不是直接消失，之前踩过坑"
  // 原来淡出 0.13 秒、曲线 k²：半程只剩 25%，肉眼看就是"一打中尾巴就没了"。
  const P = CONFIG.ui.projectileFx.tower, F = P.trailFade;
  T(`⑦b命中后拖尾余烬淡出时长在配置里、至少 0.35 秒（现 ${F}s）`, F >= 0.35);
  T('⑦c余烬从满开始、单调变淡、到时长收掉',
    trailEmberK(0) === 1 && trailEmberK(F * 0.25) > trailEmberK(F * 0.5) && trailEmberK(F * 0.5) > trailEmberK(F * 0.75) && trailEmberK(F) === 0);
  T(`⑦d"缓慢"：0.1 秒时还剩大半（${trailEmberK(0.1).toFixed(2)}），淡出一半的时刻不早于 0.2 秒`,
    trailEmberK(0.1) > 0.6 && trailEmberK(0.2) >= 0.5 - 1e-9);
  T('⑦e淡出队列在"本帧不在场"的子弹上启动（子弹消失那一帧不整条消失），且按墙钟推进',
    /if \(sn\.f === this\._fxFrame\) continue;/.test(fx) && /s\.t \+= dtWall;\s*const kk = trailEmberK\(s\.t\);/.test(fx));
}
{
  // 实例池：小兵弹 = 1 个弹头 + 若干残影；术士多三颗光点；吐息播完自动收掉
  const pm = new ProjectileMeshLayer(new THREE.Scene());
  const back = (d) => [d, 10, 0];
  pm.begin();
  pm.minionBolt('ranged', [0, 10, 0], { x: 1, y: 0, z: 0 }, 12, 0xe0473f, back);
  pm.end();
  const A = CONFIG.ui.projectileFx.minion.afterimages;
  T(`⑧远程兵弹：1 个实心弹头 + ${A} 颗残影`, pm.bolt.mesh.count === 1 && pm.ghost.mesh.count === A + 1);
  pm.begin();
  pm.minionBolt('warlock', [0, 10, 0], { x: 1, y: 0, z: 0 }, 12, 0xe0473f, back);
  pm.end();
  T('⑨术士弹多三颗绕转光点', pm.ghost.mesh.count === A + 1 + CONFIG.ui.projectileFx.warlock.motes);
  pm.begin(); pm.siegeStone([0, 30, 0], 12, 0xe0473f, back, 0.5); pm.end();
  T('⑩炮车石弹：一块石头 + 一串烟团', pm.stone.mesh.count === 1 && pm.puff.mesh.count === CONFIG.ui.projectileFx.siege.smoke);
  pm.breath([0, 20, 0], [40, 5, 0], 0xff8a3d, 15);
  T('⑪巨龙吐息登记成一段短动画', pm.fx.length === 1 && pm.fx[0].type === 'breath');
  pm.fx[0].t = 10;   // 播完
  pm.begin(); pm.end();
  T('⑫吐息播完就收掉，不留任何东西（没有结尾爆开）', pm.fx.length === 0);
  T('⑬巨龙吐息只看攻击冷却跳增（纯视觉，不改战斗）', /cd <= prev \+ 0\.02\) continue;/.test(fx) && /this\.pm\.breath\(/.test(fx));
}

done();
