// 召唤水晶幽灵/规则状态验收（用户 Q1-Q4）
globalThis.window={gameTime:0,waveNumber:0,_uid:0,
  __towerRules:{invincible:{blue:false,red:false},attackOff:{blue:false,red:false},waveOn:{blue:true,red:true}}};
window.__towerRuleFor=(kind,faction)=>{const r=window.__towerRules?.[kind];if(!r)return false;
  if(!faction)return r.blue||r.red;return !!r[faction];};
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {MapSystem}=await import('../src/systems/MapSystem.js');
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const mapSys=new MapSystem(ents,bus);
mapSys.setEffectRegistry(fx);
let uid=100;
mapSys.setCreateBuildingFn(({faction,tier,laneId,pos,stats})=>{
  const e={id:++uid,type:'tower',alive:true,pos:{...pos},baseStats:{...stats},currentHP:stats.maxHP,
    shieldFixedCurrent:stats.shieldFixedMax||0,tempShield:0,_skillInstances:[],
    _mapFaction:faction,_mapTier:tier,_laneId:laneId,faction};
  ents.add(e);return e;});
mapSys.loadMap('summoners_rift_v1');

// ---- Q1: 结构保护状态 ----
mapSys.update(0.1);
const nl=ents.getAllTowers(true).find(t=>t._mapTier==='nexus_lane'&&t._mapFaction==='blue'&&t._laneId==='mid');
T('Q1 受保护水晶挂"结构保护"状态', fx.getEffects(nl.id).some(e=>e.blueprint.name==='结构保护'));
// v43（Q3 定稿 B）：保护链改成"同路**任意**前置层还有活着的塔即受保护"，
// 所以只打掉水晶塔已经解不开保护了（外塔/内塔还在），必须把该路前置层全部打掉。
const midChain=['outer','inner','base'].map(tier=>
  ents.getAllTowers(true).find(t=>t._mapTier===tier&&t._mapFaction==='blue'&&t._laneId==='mid')).filter(Boolean);
midChain.find(t=>t._mapTier==='base').alive=false;
mapSys.update(0.1);
T('Q1 仅水晶塔倒下、外/内塔尚在 → 保护状态仍在（v43 规则B）',
  fx.getEffects(nl.id).some(e=>e.blueprint.name==='结构保护'));
midChain.forEach(t=>{t.alive=false;t.currentHP=0;});
mapSys.update(0.1);
T('Q1 同路前置层全灭后保护状态移除', !fx.getEffects(nl.id).some(e=>e.blueprint.name==='结构保护'));

// ---- Q1: 全局无敌/停火状态 ----
window.__towerRules.invincible.blue=true; window.__towerRules.attackOff.blue=true;
mapSys.update(0.1);
const anyTower=ents.getAllTowers(true).find(t=>t._mapTier==='outer');
T('Q1 无敌开关 → 塔挂"无敌"状态', fx.getEffects(anyTower.id).some(e=>e.blueprint.name==='无敌'));
T('Q1 停火开关 → 塔挂"停火"状态', fx.getEffects(anyTower.id).some(e=>e.blueprint.name==='停火'));
window.__towerRules.invincible.blue=false; window.__towerRules.attackOff.blue=false;
mapSys.update(0.1);
T('Q1 关闭开关 → 状态移除', !fx.getEffects(anyTower.id).some(e=>['无敌','停火'].includes(e.blueprint.name)));

// ---- Q3/Q4: 幽灵水晶 ----
nl.alive=false; nl.currentHP=0;
bus.emit('entity:death',{entityId:nl.id});
mapSys.update(0.1);
T('Q4 幽灵保留在实体表中(可点选的前提)', ents.get(nl.id) && !ents.get(nl.id).alive && ents.get(nl.id)._respawnAt);
T('Q3 幽灵有重生进度字段', typeof nl._respawnProgress==='number' && nl._respawnProgress>=0 && nl._respawnProgress<1);
T('Q3 幽灵有剩余秒数', typeof nl._respawnRemain==='number' && nl._respawnRemain>0);
// Q3 反转：幽灵/废墟现在【进】空间网格了。
// 旧断言（"确实不在网格中，故 UI 需单独扫描"）是把 bug 本身钉成了规格 ——
// 正因为不在网格里，findInRadius(..., aliveOnly=false) 一直是空头支票，
// LaneMovementSystem 里那段废墟避障从未执行过，小兵才会穿废墟。
// 现在网格索引静态障碍（废墟 + 待重生水晶），断言改为验证它【在】网格中，
// 且 aliveOnly=true 时仍然取不到（既有调用点行为不变）。
AttributeCalculator.tick(); ents.rebuildGridIfNeeded(AttributeCalculator._frame);
const inGrid=ents.findInRadius(nl.pos.x,nl.pos.y,50,null,false).some(e=>e.id===nl.id);
const inGridAlive=ents.findInRadius(nl.pos.x,nl.pos.y,50,null,true).some(e=>e.id===nl.id);
T('Q3 幽灵/废墟已进空间网格(aliveOnly=false 能取到)', inGrid);
T('Q3 aliveOnly=true 仍取不到幽灵(既有调用点不受影响)', !inGridAlive);
T('Q4 幽灵可经 getAllTowers(false) 取到', ents.getAllTowers(false).some(e=>e.id===nl.id&&e._respawnAt));
// 进度推进
mapSys.update(150);
T('Q3 进度随时间推进(约50%)', Math.abs(nl._respawnProgress-0.5)<0.05);

// ---- Q2: 切图不残留幽灵 ----
mapSys.loadMap('howling_abyss_v1');
const ghosts=ents.getAllTowers(false).filter(e=>!e.alive&&e._respawnAt);
T('Q2 切换地图后幽灵水晶被清除', ghosts.length===0);
T('Q2 切图后重生队列清空', mapSys._respawnQueue.length===0);
const oldMapLeft=ents.getAllTowers(false).some(e=>e.id===nl.id&&e.alive);
T('Q2 旧地图建筑未残留为活体', !oldMapLeft);

console.log(`水晶验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
