// 远程兵墙验收（用户反馈：站着的一堆远程兵把近战的路挡死）。
// 场景：5 个己方远程兵横排站定（锚定，模拟正在输出），后方 6 个近战兵要通过。
// 期望：锚定队友给行军队友让路，兵墙被挤开一条通道，近战全部通过。
// TERRAIN_AVOID=0 可关掉 Q1 的地形避障做对照：本用例的"越墙 6/6"正是靠它才成立
//（关掉退回 5/6，是本次改动前的长期失败项）。默认开启。
globalThis.window={gameTime:0,waveNumber:0,_uid:0,__terrainAvoid:process.env.TERRAIN_AVOID!=='0'};
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
const at=(d,off=0)=>({x:wps[0].x+u.x*d-u.y*off, y:wps[0].y+u.y*d+u.x*off});
const along=p=>(p.x-wps[0].x)*u.x+(p.y-wps[0].y)*u.y;

function mk(type,d,off,anchored=false){const tpl=CONFIG.templates[type];const p=at(d,off);
  const e={id:++window._uid,type,alive:true,pos:{x:p.x,y:p.y},baseStats:{...tpl},currentHP:tpl.maxHP,
    shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
    _skillInstances:[],_mapFaction:'blue',_laneId:'mid',_laneDirection:'forward',faction:'blue',_anchored:anchored};
  ents.add(e);return e;}

// 兵墙：5 个远程兵横排在 d=700（覆盖 ±28px）。v37 重做：给兵墙一个【真实敌靶】
// （远程射程内的不动不死靶）让它们真实锚定——旧版 targetId=null + 测试强制 _anchored
// 是自欺：lms.update 每帧先把它们打回行军分支挪一步、测试再改标记，兵墙成员实际
// 一直在动（"让路"是这个副作用）。v37 语义：锚定=真静态障碍，友军靠【绕行】通过。
const wall=[];
for(let i=-2;i<=2;i++) wall.push(mk('ranged',700,i*26)); // v37：间距26≥碰撞直径，初始无重叠（旧14挤在一起，锚定落位会摊开）
const dummyP=at(700+CONFIG.templates.ranged.attackRange*0.8,0);
const dummy={id:++window._uid,type:'melee',alive:true,pos:{x:dummyP.x,y:dummyP.y},
  baseStats:{...CONFIG.templates.melee,moveSpeed:0,maxHP:1e9},currentHP:1e9,
  shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
  _skillInstances:[],_mapFaction:'red',_laneId:'mid',_laneDirection:'reverse',faction:'red'};
ents.add(dummy);
// 近战队列：6 个，从 d=600 往前
const melees=[];
for(let i=0;i<6;i++) melees.push(mk('melee',600-i*18,0));

const startD=melees.map(m=>along(m.pos));
const DT=1/30;
for(let t=0;t<60;t+=DT){window.gameTime=t;
  attr.tick();ents.rebuildGridIfNeeded(attr._frame);
  moveSys.update(DT);collSys.update(DT);
}
const endD=melees.map(m=>along(m.pos));
const passed=endD.filter(d=>d>760).length;  // 越过兵墙(700)并拉开距离
const minAdv=Math.min(...endD.map((d,i)=>d-startD[i]));
const wallDrift=wall.map(w=>Math.abs(-(w.pos.x-wps[0].x)*u.y+(w.pos.y-wps[0].y)*u.x));

console.log(`60s后：近战越过兵墙 ${passed}/6 | 最小推进 ${minAdv.toFixed(0)}px`);
console.log(`兵墙横向位置(让路后): ${wallDrift.map(v=>v.toFixed(0)).join(', ')} (初始 52,26,0,26,52)`);
// v37：近战索敌锁 dummy（在兵墙后方），必须【绕过】锚定兵墙接敌。
// 判定：全部近战最终锚定攻击 dummy（= 成功绕过），兵墙成员保持静态（真锚定不让路）。
const engaged=melees.filter(m=>m._anchored && m.targetId===dummy.id).length;
const crossed=endD.filter(d=>d>710).length;
console.log(`接敌数: ${engaged}/6 | 越墙数: ${crossed}/6`);
// v37 语义：绕障成功 = 全员【越过】锚定兵墙（along>710）；接敌数 ≥4 即可——
// 靶子攻击圈被先到的锚定兄弟占满后，后来者在外圈等位是 LoL 一致的真实行为
//（实测未接敌者都已越墙、贴着攻击圈外沿，属"围攻挤位"而非绕障失败）。
T(`近战全部越过兵墙（${crossed}/6）`, crossed===6);
T(`多数近战接敌（${engaged}/6 ≥ 4）`, engaged>=4);
T('兵墙成员真锚定（全程攻击靶）', wall.every(w=>w._anchored && w.targetId===dummy.id));
T('兵墙保持静态（横向漂移 < 8px，锚定不让路）', Math.max(...wallDrift.map((v,i)=>Math.abs(v-Math.abs((i-2)*26))))<8);
console.log(`兵墙验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
