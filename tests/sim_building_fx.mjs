// 建筑动画（buildingFx.js）：掉档掉块、被摧毁爆炸、召唤水晶重生拼回。
// 用户定稿："按这个做"（掉档约 0.8 秒、摧毁约 1.5 秒、重生约 1.5 秒；碎块落地后留在脚下）。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const THREE = await import('../vendor/three.module.js');
const { CONFIG } = await import('../src/data/Config.js');
const { fallPose, modeOf, BuildingFx } = await import('../src/presentation/buildingFx.js');
const { statueTower } = await import('../src/presentation/towerStatue.js');
const { T, done } = scoreboard('建筑动画');
const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

const R = 32, F = { stone: '#b9c6d6', trim: '#eaf2fd' };
{
  const B = CONFIG.ui.buildingFx;
  T('①三段动画的时长与区间都在 CONFIG.ui.buildingFx（软编码），时长接近定稿（0.8 / 1.5 / 1.5 秒）',
    B.enabled === true && Math.abs(B.chunkFall.dur - 0.8) < 0.3 && Math.abs(B.explode.dur - 1.5) < 0.5 && Math.abs(B.respawn.dur - 1.5) < 0.5);
}
{
  // 掉落轨迹：起点是原位（抖动幅度内），终点逐位等于静态碎块位置（落地那一刻与碎石重合、不跳）
  const st = statueTower(R, 'outer', 'blue', F);
  let startOk = true, endOk = true, midHigh = true;
  for (const id of st.stages[2]) {
    const rp = st.model.rubbleParams(id);
    const probe = rp.c.clone();
    const p0 = probe.clone().applyMatrix4(fallPose(rp, 0, R));
    const p1 = probe.clone().applyMatrix4(fallPose(rp, 1, R));
    const ref = probe.clone().applyMatrix4(st.model.rubbleMatrix(id));
    if (p0.distanceTo(rp.c) > R * 0.05) startOk = false;
    if (p1.distanceTo(ref) > 1e-3) endOk = false;
    const pm = probe.clone().applyMatrix4(fallPose(rp, 0.4, R));
    if (pm.y < ref.y - 1e-3) midHigh = false;   // 半路上不会钻到地下
  }
  T('②掉落从原位开始（只有小幅抖动）', startOk);
  T('③掉落终点与静态碎块位置逐位重合（播完换成静态模型不跳）', endOk);
  T('④半路上不钻地', midHigh);
}
{
  // 画法：掉档中不画新碎块；爆炸中废墟从地下拱出来；重生中只画主体、主体从地下升起、水晶最后长出来
  const m1 = modeOf([{ type: 'chunk', t: 0.2, dur: 0.8, from: 0, to: 1 }]);
  T('⑤掉档动画中：新掉的部件先不画碎块（noRubbleFrom = 原档）', m1.noRubbleFrom === 0);
  T('⑥掉档播完：恢复正常画法', modeOf([{ type: 'chunk', t: 0.8, dur: 0.8, from: 0, to: 1 }]).noRubbleFrom === null);
  const e0 = modeOf([{ type: 'explode', t: 0, dur: 1.5 }]), e1 = modeOf([{ type: 'explode', t: 1.49, dur: 1.5 }]);
  T('⑦爆炸：废墟一开始在地下、播完回到地面', e0.offsetY <= -0.99 && Math.abs(e1.offsetY) < 1e-3);
  const r0 = modeOf([{ type: 'respawn', t: 0.01, dur: 1.5 }]), r9 = modeOf([{ type: 'respawn', t: 1.49, dur: 1.5 }]);
  T('⑧重生：开头只画主体、主体在地下、水晶没长出来；结尾全部归位、水晶长满',
    r0.assemble && r0.offsetY < -0.9 && r0.crystalK === 0 && !r9.assemble && Math.abs(r9.offsetY) < 1e-3 && r9.crystalK > 0.99);
}
{
  // 事件识别：第一次见到不播；掉档 / 死 / 活 各认出一次
  const prevT = CONFIG.ui.statueTower.style; CONFIG.ui.statueTower.style = 'statue';
  const prevS = CONFIG.ui.crystalShrine.style; CONFIG.ui.crystalShrine.style = 'statue';
  const fx = new BuildingFx(new THREE.Scene());
  const e = { id: 1, type: 'tower', _mapTier: 'outer', alive: true, currentHP: 100, baseStats: { maxHP: 100 } };
  fx.observe(e, false, false);
  const types = () => fx.byId.get(1).events.map((ev) => ev.type).join(',');
  T('⑨第一次见到这座塔不播任何动画（开局/切图不会满地掉块）', types() === '');
  e.currentHP = 50; fx.observe(e, false, false);
  T('⑩血量跌过 67%：认出一次掉档', types() === 'chunk' && fx.byId.get(1).events[0].from === 0 && fx.byId.get(1).events[0].to === 1);
  e.alive = false; e.currentHP = 0; fx.observe(e, false, true);
  T('⑪被摧毁：认出一次爆炸', types().endsWith('explode'));
  e.alive = true; e.currentHP = 100; e._dmgStage = 0; fx.observe(e, false, false);
  T('⑫复活：认出一次重生，并收掉还没播完的爆炸', types().endsWith('respawn') && !types().includes('explode'));
  const inh = { id: 2, type: 'tower', _mapTier: 'nexus_lane', alive: true, currentHP: 100, baseStats: { maxHP: 100 } };
  CONFIG.ui.crystalShrine.style = 'classic';
  T('⑬旧造型（classic）不播动画（没有部件可掉）', fx.observe(inh, false, false) === null);
  CONFIG.ui.statueTower.style = prevT; CONFIG.ui.crystalShrine.style = prevS;
}
{
  const ul = src('presentation/UnitLayer.js'), um = src('presentation/UnitMeshFactory.js');
  T('⑭动画中间态进了几何缓存 key（不会命中别的状态的几何）', /fxKey/.test(ul) && /\|asm/.test(ul) && /\|nr\$\{fxMode\.noRubbleFrom\}/.test(ul));
  T('⑮动画里飞的部件与模型同一份（buildingPiecesOf 缓存）', /export function buildingPiecesOf/.test(um) && /buildingPiecesOf\(kind, R, tier, faction, F\)/.test(um));
}

done();
