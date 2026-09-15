// 队形验收：一波兵按 LoL 节奏依次出生行军，应当保持"前后纵队"（横向散布小），
// 而不是炸开成一团（v13 只做避让时的症状）。同时保留绕开静止障碍的能力。
globalThis.window={gameTime:0,waveNumber:0,_uid:0};
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {CombatSystem}=await import('../src/systems/CombatSystem.js');
const {MapSystem}=await import('../src/systems/MapSystem.js');
const {LaneMovementSystem}=await import('../src/systems/LaneMovementSystem.js');
const {CollisionSystem}=await import('../src/systems/CollisionSystem.js');
const {CONFIG}=await import('../src/data/Config.js');
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const attr=AttributeCalculator,combat=new CombatSystem(ents,fx,bus,{});
const mapSys=new MapSystem(ents,bus),moveSys=new LaneMovementSystem(ents,fx,attr,combat,mapSys);
const collSys=new CollisionSystem(ents,mapSys);
mapSys.setCreateBuildingFn(()=>null); mapSys.loadMap('summoners_rift_v1');
const lane=mapSys.getLane('mid'), wps=lane.waypoints;
const u={x:wps[1].x-wps[0].x,y:wps[1].y-wps[0].y};
const L=Math.hypot(u.x,u.y);u.x/=L;u.y/=L;
const lat=p=>-(p.x-wps[0].x)*u.y+(p.y-wps[0].y)*u.x;   // 横向偏移（正负=左右）
const along=p=>(p.x-wps[0].x)*u.x+(p.y-wps[0].y)*u.y;  // 沿线推进

function mk(type='melee'){const tpl=CONFIG.templates[type];
  const e={id:++window._uid,type,alive:true,pos:{x:wps[0].x,y:wps[0].y},baseStats:{...tpl},currentHP:tpl.maxHP,
    shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
    _skillInstances:[],_mapFaction:'blue',_laneId:'mid',_laneDirection:'forward',faction:'blue'};
  ents.add(e);return e;}

// 一波 6 兵（近战×3 远程×2 炮车×1），按 0.35s 间隔依次出生 —— 复刻真实出兵
const wave=[],DT=1/30;
const plan=[['melee',0],['melee',0.35],['melee',0.7],['ranged',1.05],['ranged',1.4],['siege',1.75]];
let pi=0;
for(let t=0;t<40;t+=DT){window.gameTime=t;
  while(pi<plan.length && t>=plan[pi][1]){wave.push(mk(plan[pi][0]));pi++;}
  attr.tick();ents.rebuildGridIfNeeded(attr._frame);
  moveSys.update(DT);collSys.update(DT);
}
const lats=wave.map(m=>Math.abs(lat(m.pos)));
const alongs=wave.map(m=>along(m.pos));
const maxLat=Math.max(...lats);
console.log('40s后 横向散布(px):',lats.map(v=>v.toFixed(0)).join(', '));
console.log('        沿线推进(px):',alongs.map(v=>v.toFixed(0)).join(', '));
T('队形保持纵队（横向散布 < 45px）', maxLat<45);
T('全员在推进（最慢 > 2000px）', Math.min(...alongs)>2000);
// 纵队序：先出生的应当在前（允许炮车慢些，但不该乱序穿插）
const meleeAlong=alongs.slice(0,3);
T('同兵种保持出生顺序（前兵领先后兵）', meleeAlong[0]>meleeAlong[1] && meleeAlong[1]>meleeAlong[2]);

// 绕行能力仍在：塞一个锚定障碍在队伍正前方
const blocker=mk('melee');
const bp={x:wps[0].x+u.x*(along(wave[0].pos)+60), y:wps[0].y+u.y*(along(wave[0].pos)+60)};
blocker.pos={x:bp.x,y:bp.y};blocker._anchored=true;
const before=along(wave[0].pos);
for(let t=40;t<52;t+=DT){window.gameTime=t;blocker._anchored=true;
  attr.tick();ents.rebuildGridIfNeeded(attr._frame);moveSys.update(DT);collSys.update(DT);}
T('仍能绕开静止障碍（领头兵越过障碍）', along(wave[0].pos)>before+120);
console.log(`队形验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
