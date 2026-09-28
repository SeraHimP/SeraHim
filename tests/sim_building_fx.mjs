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
  // 用户："塔损毁掉渣的动画是正常的，但是塔生命值掉光爆炸的动画没有，你是没做还是 bug"——是 bug：
  // ThreeRenderer 收到 entity:death 就 units.remove(id)，连带 bfx.forget，下一帧废墟被当成"第一次见到"，不播。
  const tr = src('presentation/ThreeRenderer.js');
  T('⑯死亡事件不摘塔的渲染条目（塔死后留成废墟，爆炸状态不能被忘掉）',
    /entity:death'[\s\S]{0,400}type === 'tower'\) return;\s*this\.units\.remove\(entityId\)/.test(tr));
  T('⑰刚死、还没打上 _ruin 的塔也按废墟同步（不断帧，兜底扫描不会删掉它）',
    /if \(c\._respawnAt\) this\._syncOne\(c, true[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*else this\._syncOne\(c, false, deps, lodHideBar, tNow, true\);/.test(ul));
}
{
  // 真的走一遍：活着见过 → 死了 → 认出爆炸（与 UnitLayer 在死亡前后连续调用 observe 的顺序一致）
  const prevT = CONFIG.ui.statueTower.style; CONFIG.ui.statueTower.style = 'statue';
  const fx = new BuildingFx(new THREE.Scene());
  const e = { id: 7, type: 'tower', _mapTier: 'outer', alive: true, currentHP: 100, baseStats: { maxHP: 100 } };
  fx.observe(e, false, false);
  e.alive = false; e.currentHP = 0;
  const m = fx.observe(e, false, true);
  T('⑱活着见过的塔一死就播爆炸（废墟从地下拱出）', fx.byId.get(7).events.some((ev) => ev.type === 'explode') && m.offsetY < 0);
  CONFIG.ui.statueTower.style = prevT;
  // 冲击波（用户："爆炸的时候塔应该产生可视化冲击波"）
  const SW = CONFIG.ui.buildingFx.explode.shock;
  const bf = src('presentation/buildingFx.js');
  T('⑲爆炸带冲击波：地面光环 + 尘浪 + 半球冲击波壳（边缘亮、不透明度封顶、不叠加混合），参数软编码',
    SW.domeR > 0 && SW.alpha <= 0.8 && SW.dustR > 0 && /const dome = new THREE\.Mesh/.test(bf) && /const dustRing = /.test(bf));
}
{
  // 用户："损毁爆炸的动画顶部中间会有一个大白方块出现"——闪白精灵没有贴图，画出来就是一整块正方形
  const bf = src('presentation/buildingFx.js');
  T('㉑爆炸闪白带圆形柔光贴图（不是白方块）', /_flashMat\(\) \{ return new THREE\.SpriteMaterial\(\{ map: dotTexture\(\)/.test(bf));
  // 用户："塔播放损毁动画的时候，游戏会突然卡一下"
  const ul = src('presentation/UnitLayer.js'), tr = src('presentation/ThreeRenderer.js');
  T('㉒卡顿①：特效材质在地图加载时预编译（且不释放，否则着色器程序被回收）',
    /this\.units\.bfx\.prewarm\(this\.gl, this\.camera\)/.test(tr) && /this\._warmKeep = /.test(bf) && !/for \(const m of mats\) if \(m !== unitMaterial\(false\)\) m\.dispose\(\)/.test(bf));
  T('㉓卡顿②：各损毁档塔身 / 掉块中间态 / 只含立着部分 / 废墟 / 碎片网格在空闲帧里分批预建',
    /_queueTowerWarm\(e\)/.test(ul) && /this\._runWarm\(\)/.test(ul) && /noRubbleFrom: d - 1/.test(ul) && /standing: true/.test(ul) && /warmPieces\(pb, b\.R\)/.test(ul));
  // 碎片几何缓存：同一块部件只合并一次，动画结束不释放
  const prevT = CONFIG.ui.statueTower.style; CONFIG.ui.statueTower.style = 'statue';
  const { buildingPiecesOf, towerStoneOf } = await import('../src/presentation/UnitMeshFactory.js');
  const fx = new BuildingFx(new THREE.Scene());
  const pb = buildingPiecesOf('tower', 32, 'outer', 'blue', towerStoneOf('blue'));
  fx.warmPieces(pb, 32);
  const id0 = pb.model.order[0];
  T('㉔碎片几何按部件缓存（预建后事件里直接取，不再现合并）', fx._pieceGeo(pb, id0) === fx._pieceGeo(pb, id0) && fx._pieceGeo(pb, id0).userData.shared === true);
  CONFIG.ui.statueTower.style = prevT;
}
{
  // 用户："塔已经损毁掉在地上的部分就不要再施加护盾特效了"
  const { towerMesh } = await import('../src/presentation/UnitMeshFactory.js');
  const prevT = CONFIG.ui.statueTower.style; CONFIG.ui.statueTower.style = 'statue';
  const full = towerMesh('shell|2', '#5b9bd5', 32, '', 'tower', false, false, 'outer', 'blue', 2, null);
  const stand = towerMesh('shell|2|st', '#5b9bd5', 32, '', 'tower', false, false, 'outer', 'blue', 2, { fx: { standing: true } });
  const ul = src('presentation/UnitLayer.js');
  T('㉕护盾外壳只包还立着的部分：重损塔的"只含立着部分"几何比完整几何少（地上的碎块不在里面），外壳用它',
    stand.geo.getAttribute('position').count < full.geo.getAttribute('position').count && /const src = en\.shellGeo \|\| en\.bodyGeo;/.test(ul));
  CONFIG.ui.statueTower.style = prevT;
}
{
  // 用户："塔攻击的时候附近新增那个光晕很丑，删掉。改为进一步加大水晶的亮度"
  const ul = src('presentation/UnitLayer.js');
  const AG = CONFIG.ui.crystal.attackGlow;
  T('⑳塔攻击的外部光晕已删，改为水晶自身更亮（充能加成 × chargeBoost、开火再加 emissivePulse）',
    !/crystalHalo/.test(ul) && CONFIG.ui.crystal.halo === undefined && AG.chargeBoost > 1 && AG.emissivePulse > 0.8
    && /chargeE \* \(HL\.chargeBoost/.test(ul));
}

done();
