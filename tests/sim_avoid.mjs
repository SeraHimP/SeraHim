// 己方绕行验收：20 兵纵队行军，前排被"钉死"的己方单位挡住，检验后排能否绕过去。
// 对照旧行为：无绕行时后排会被永久堵在障碍后（位移趋零）。
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

function mk(x,y,f='blue',anchored=false){const tpl=CONFIG.templates.melee;
  const e={id:++window._uid,type:'melee',alive:true,pos:{x,y},baseStats:{...tpl},currentHP:tpl.maxHP,
    shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
    _skillInstances:[],_mapFaction:f,_laneId:'mid',_laneDirection:'forward',faction:f,_anchored:anchored};
  ents.add(e);return e;}

// 场景：中路上一个"钉死"的己方兵（模拟正在攻击、不动的前排），后面 20 兵纵队要过去
const lane=mapSys.getLane('mid');
const wps=lane.waypoints;
const u={x:wps[1].x-wps[0].x,y:wps[1].y-wps[0].y};
const L=Math.hypot(u.x,u.y);u.x/=L;u.y/=L;
const at=(d,off=0)=>({x:wps[0].x+u.x*d-u.y*off, y:wps[0].y+u.y*d+u.x*off});

// 障碍：3 个并排锚定的己方兵（宽度约 40px，形成一道墙）
const blockers=[];
for(let i=-1;i<=1;i++){const p=at(600,i*18);const b=mk(p.x,p.y);b._anchored=true;b._pinned=true;blockers.push(b);}
// 队列：20 兵在障碍后方排队
const queue=[];
for(let i=0;i<20;i++){const p=at(520-i*16,(i%3-1)*10);queue.push(mk(p.x,p.y));}

const startD=queue.map(m=>(m.pos.x-wps[0].x)*u.x+(m.pos.y-wps[0].y)*u.y);
const DT=1/30;
for(let t=0;t<25;t+=DT){window.gameTime=t;attr.tick();ents.rebuildGridIfNeeded(attr._frame);
  moveSys.update(DT);collSys.update(DT);
  for(const b of blockers){b._anchored=true;} // 保持钉死（模拟持续交战）
}
// 沿线推进距离
const endD=queue.map(m=>(m.pos.x-wps[0].x)*u.x+(m.pos.y-wps[0].y)*u.y);
const advanced=endD.map((d,i)=>d-startD[i]);
const passed=endD.filter(d=>d>640).length; // 越过障碍(600)且拉开距离
const minAdv=Math.min(...advanced), avgAdv=advanced.reduce((a,b)=>a+b,0)/advanced.length;

console.log(`25s后：越过障碍 ${passed}/20 兵 | 平均推进 ${avgAdv.toFixed(0)}px | 最小推进 ${minAdv.toFixed(0)}px`);
// 理论：78px/s × 25s = 1950px（无阻挡）；绕行有损耗，但绝不该被堵死
T('无人被堵死（最小推进 > 300px）', minAdv>300);
T('绝大多数越过障碍（≥18/20）', passed>=18);
T('平均推进达无阻挡的 70% 以上', avgAdv > 78*25*0.7);
// 侧向散布：绕行必然产生横向偏移，但不该炸开
const lat=queue.map(m=>Math.abs(-(m.pos.x-wps[0].x)*u.y+(m.pos.y-wps[0].y)*u.x));
T('横向散布受控（最大 < 120px）', Math.max(...lat)<120);
console.log(`绕行验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
