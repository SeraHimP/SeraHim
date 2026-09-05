// 穿越复现:双方各5近战兵在中路对冲,追踪(1)接敌时双方最小间距 (2)穿越事件(敌对对间距<15且尚未互殴)
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
const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const attr=AttributeCalculator,combat=new CombatSystem(ents,fx,bus,{});
const mapSys=new MapSystem(ents,bus),moveSys=new LaneMovementSystem(ents,fx,attr,combat,mapSys);
const collSys=new CollisionSystem(ents,mapSys);
mapSys.setCreateBuildingFn(()=>null); mapSys.loadMap();
function mk(x,y,faction,dir){const tpl=CONFIG.templates.melee;
 const e={id:++window._uid,type:'melee',alive:true,pos:{x,y},baseStats:{...tpl},currentHP:tpl.maxHP,shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,_skillInstances:[],_mapFaction:faction,_laneId:'mid',_laneDirection:dir,faction};ents.add(e);return e;}
// 中路直线,两队相向:蓝在(1500,2050)附近向前,红在(2050,1500)附近向后,间距约780
const blues=[],reds=[];
for(let i=0;i<5;i++){blues.push(mk(1500-19*i,2052+19*i,'blue','forward'));reds.push(mk(2052+19*i,1500-19*i,'red','reverse'));}
const DT=1/30;
let firstAtkT=null,minPairAtFirstAtk=null,crossEvents=0,attacked=new Set();
bus.on?.('x',()=>{});
const origPerform=combat.performAttack.bind(combat);
combat.performAttack=(a,t)=>{attacked.add(a.id);if(firstAtkT===null){firstAtkT=window.gameTime;
  let mind=1e9;for(const b of blues)for(const r of reds){const d=Math.hypot(b.pos.x-r.pos.x,b.pos.y-r.pos.y);if(d<mind)mind=d;}
  minPairAtFirstAtk=mind;}return origPerform(a,t);};
// v34：仿真窗口 40→100s。近战 HP 350→500（v33）后，裸模板互殴（AD9、无屠戮被动）
// 单挑 TTK≈47s；v34 体积加大后站位分散、伤害不再天然集中，40s 窗口打不死人。
for(let t=0;t<100;t+=DT){window.gameTime=t;attr.tick();ents.rebuildGridIfNeeded(attr._frame);
  moveSys.update(DT);collSys.update(DT);
  for(const m of ents.getAllMinions(true))m.attackCooldown-=DT;
  // 穿越检测:蓝兵沿行进方向的投影超过某红兵且两者都还没攻击过
  for(const b of blues){if(!b.alive)continue;for(const r of reds){if(!r.alive)continue;
    const proj=(b.pos.x-b.pos.y)-(r.pos.x-r.pos.y); // 中路方向≈(1,-1),投影差>0即蓝越过红
    if(proj>30&&!attacked.has(b.id)&&!attacked.has(r.id))crossEvents++;}}
}
console.log('首次攻击时间:',firstAtkT?.toFixed(2),'s | 首击时敌对最小间距:',minPairAtFirstAtk?.toFixed(1));
console.log('未接敌穿越事件帧计数:',crossEvents);
// 锁定分布:各蓝兵最终目标
console.log('蓝方目标分布:',blues.map(b=>b.targetId));
console.log('存活: 蓝',blues.filter(b=>b.alive).length,'红',reds.filter(r=>r.alive).length);
const cx=blues.concat(reds).filter(e=>e.alive);
let maxR=0,mx=0,my=0;for(const e of cx){mx+=e.pos.x;my+=e.pos.y}mx/=cx.length;my/=cx.length;
for(const e of cx)maxR=Math.max(maxR,Math.hypot(e.pos.x-mx,e.pos.y-my));
console.log('100s后混战团半径:',maxR.toFixed(1));

// ==================== 断言（技术债清偿：此前只打印指标、永远绿灯） ====================
// 阈值取自修复后的稳态实测（首击4.8s/间距29.3/穿越0/半径18.7），留合理余量。
let fails=0;const A=(n,c)=>{if(!c){fails++;console.log('✗',n);}};
A('必须发生接敌(10s内首次攻击)', firstAtkT!==null && firstAtkT<10);
A('接敌距离≈近战射程(≤35)', minPairAtFirstAtk!==null && minPairAtFirstAtk<=35);
A('零未接敌穿越', crossEvents===0);
A('必须有死亡(战斗真实发生)', blues.filter(b=>b.alive).length + reds.filter(r=>r.alive).length < 10);
A('混战团半径受控(<60,防血球回归)', maxR<60);
console.log(fails?`❌ 穿越回归 ${fails} 项失败`:'✅ 穿越回归全部通过');
process.exit(fails?1:0);
