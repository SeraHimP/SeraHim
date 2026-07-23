// 第二批机制验收套件:几何/保护/重生/守家/光环/屠戮
globalThis.window = { gameTime: 0, waveNumber: 20, _uid: 0 }; // v35：炮兵指挥官第20波起生效
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { isStructureProtected } = await import('../src/systems/FactionSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { summoners_rift } = await import('../src/data/maps/summoners_rift.js');

let pass=0, fail=0;
const T=(name,cond)=>{ if(cond){pass++;} else {fail++; console.log('  ✗ FAIL:',name);} };

// ---------- 0. 几何:所有分路建筑在所属路径 190px 内(索敌半径200带余量) ----------
const dseg=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y;if(!dx&&!dy)return Math.hypot(p.x-a.x,p.y-a.y);
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));};
const dpath=(p,wps)=>Math.min(...wps.slice(0,-1).map((a,i)=>dseg(p,a,wps[i+1])));
for(const b of summoners_rift.buildings){
  const lanes = b.laneId ? [summoners_rift.lanes.find(l=>l.id===b.laneId)] : summoners_rift.lanes;
  const d=Math.min(...lanes.map(l=>dpath(b.pos,l.waypoints)));
  T(`几何 ${b.faction}/${b.laneId||'共用'}/${b.tier} 距路径${d.toFixed(0)}px ≤190`, d<=190);
}

// ---------- 引擎装配 ----------
const bus=new EventBus(), ents=new EntityContainer(bus), fx=new EffectRegistry(bus);
const attr=AttributeCalculator, combat=new CombatSystem(ents,fx,bus,SkillLibrary);
const mapSys=new MapSystem(ents,bus), moveSys=new LaneMovementSystem(ents,fx,attr,combat,mapSys);
const ctxOf=()=>({entityContainer:ents,effectRegistry:fx,eventBus:bus,attrCalc:attr,combat,waveNumber:window.waveNumber});
function mkBuilding({faction,tier,laneId,pos,stats}){const tpl=CONFIG.templates.tower,s=stats||{};
  const e={id:++window._uid,type:'tower',alive:true,pos:{...pos},baseStats:{...tpl,maxHP:s.maxHP??tpl.maxHP,armor:0,magicResist:0,attackDamage:s.attackDamage??0,baseAttackSpeed:s.baseAttackSpeed??0,attackRange:tpl.attackRange},
  currentHP:0,shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,_skillInstances:[],_mapFaction:faction,_mapTier:tier,_laneId:laneId||null,faction};
  e.currentHP=e.baseStats.maxHP;ents.add(e);return e;}
function mkMinion(type,x,y,faction,laneId,direction,skills=[]){const tpl=CONFIG.templates[type];
  const e={id:++window._uid,type,alive:true,pos:{x,y},baseStats:{...tpl},currentHP:tpl.maxHP,shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,_skillInstances:[],_mapFaction:faction,_laneId:laneId,_laneDirection:direction,faction};
  for(const sk of skills) e._skillInstances.push({id:++window._uid,skillId:sk,state:{}});
  ents.add(e);return e;}
mapSys.setCreateBuildingFn(mkBuilding);
mapSys.loadMap();
const find=(f,tier,lane)=>ents.getAllTowers(true).find(t=>t._mapFaction===f&&t._mapTier===tier&&(!lane||t._laneId===lane));

// ---------- 1. 结构保护 ----------
const redMidInhib=find('red','nexus_lane','mid'), redMidBase=find('red','base','mid');
const redNexus=find('red','nexus_main'), redHqs=ents.getAllTowers(true).filter(t=>t._mapFaction==='red'&&t._mapTier==='hq_tower');
T('高地塔存活→召唤水晶受保护', isStructureProtected(ents,redMidInhib));
const hp0=redMidInhib.currentHP;
combat.performAttackDirect(mkMinion('melee',redMidInhib.pos.x,redMidInhib.pos.y,'blue','mid','forward').id, redMidInhib.id, 500, 'physical');
T('受保护水晶零伤害', redMidInhib.currentHP===hp0);
redMidBase.alive=false; redMidBase.currentHP=0;
T('高地塔死后水晶解除保护', !isStructureProtected(ents,redMidInhib));
T('枢纽双塔存活→水晶枢纽受保护', isStructureProtected(ents,redNexus));
redHqs[0].alive=false;
T('单塔死亡→枢纽仍受保护(需双塔全灭)', isStructureProtected(ents,redNexus));
redHqs[1].alive=false;
T('双塔全灭→枢纽解除保护', !isStructureProtected(ents,redNexus));
redHqs.forEach(t=>{t.alive=true;t.currentHP=t.baseStats.maxHP;});

// ---------- 2. 水晶重生(300s)与超级兵停止 ----------
redMidInhib.alive=false; redMidInhib.currentHP=0; mapSys._onEntityDeath(redMidInhib.id); ents.purgeDead();
T('摧毁后标记生效', mapSys.isNexusDestroyed('red','mid'));
for(let t=0;t<301;t+=1) mapSys.update(1);
const respawned=find('red','nexus_lane','mid');
T('300s后水晶重生', !!respawned && respawned.alive);
T('重生后超级兵标记清除', !mapSys.isNexusDestroyed('red','mid'));
T('重生水晶因高地塔已死→直接可选中', !isStructureProtected(ents,respawned));

// ---------- 3. 守家优先 ----------
const zone=mapSys.getDefenseZone('blue');
T('防守圈存在且半径合理(300~420)', zone && zone.r>300 && zone.r<420);
const intruder=mkMinion('melee', zone.x+120, zone.y-80, 'red', 'top', 'reverse');
const defender=mkMinion('melee', zone.x+10, zone.y, 'blue', 'bot', 'forward');
moveSys.update(0.1);
T('圈内守军锁定入侵者(优先级覆盖推线)', defender.targetId===intruder.id);
intruder.alive=false; ents.purgeDead(); defender.targetId=null;
moveSys.update(0.1);
T('圈清空后恢复推线(目标为空)', defender.targetId===null);
defender.alive=false;

// ---------- 4. 光环:阵营过滤+不含自身 ----------
const siegeB=mkMinion('siege',1700,1700,'blue','mid','forward',['passive_artillery_commander']);
const allyM=mkMinion('melee',1750,1700,'blue','mid','forward');
const enemyM=mkMinion('melee',1650,1700,'red','mid','reverse');
ents.rebuildGrid ? ents.rebuildGrid() : (ents.rebuildGridIfNeeded && ents.rebuildGridIfNeeded());
const inst=siegeB._skillInstances[0];
const def=SkillLibrary.passive_artillery_commander;
def.onFrame(siegeB.id,0.4,inst,ctxOf()); // 超过节流阈值触发一次
const hasAura=(id)=>fx.getEffects(id).some(e=>(e.blueprint?.name||e.name)==='炮兵指挥官');
T('光环覆盖友方小兵', hasAura(allyM.id));
T('光环不给敌方', !hasAura(enemyM.id));
T('光环不含自身', !hasAura(siegeB.id));

// ---------- 5. 屠戮:自身当前生命基数、只对小兵 ----------
const meleeAtk=mkMinion('melee',1800,1800,'blue','mid','forward',['passive_melee_rend']);
const victim=mkMinion('super',1810,1800,'red','mid','reverse');
victim.baseStats.armor=0; victim.baseStats.magicResist=0;
const vHP0=victim.currentHP;
combat.performAttack(meleeAtk,victim);
const meleeStats=attr.calc(meleeAtk,fx.getEffects(meleeAtk.id));
const expectBonus=meleeAtk.currentHP*0.025; // v33：近战屠戮 1.5%→2.5%
const totalDealt=vHP0-victim.currentHP;
T(`屠戮生效且量级≈AD+自身HP×2.5%(实际${totalDealt.toFixed(1)},期望≈${(meleeStats.attackDamage+expectBonus).toFixed(1)})`,
  Math.abs(totalDealt-(meleeStats.attackDamage+expectBonus))<3);
const towerV=find('red','outer','mid') || find('red','inner','mid');
const tHP0=towerV.currentHP; meleeAtk.pos={...towerV.pos};
combat.performAttack(meleeAtk,towerV);
const towerDealt=tHP0-towerV.currentHP;
T(`屠戮对塔无效(对塔伤害${towerDealt.toFixed(1)}≈纯AD${meleeStats.attackDamage})`, Math.abs(towerDealt-meleeStats.attackDamage)<3);

// ==================== 两图统一几何约束（用户确认） ====================
{
  const RANGE=180, REACH=35; // 近战贴脸攻击建筑时与塔心的距离
  const dd=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  for (const name of ['summoners_rift','howling_abyss']) {
    const mp=(await import('../src/data/maps/'+name+'.js'))[name];
    for (const fac of ['blue','red']) {
      const Bs=mp.buildings.filter(b=>b.faction===fac);
      const hq=Bs.filter(b=>b.tier==='hq_tower').map(b=>b.pos);
      // v34（Q1）：枢纽建筑 ×0.82 收角（用户：往里调一些）→ 间距 140→115，仍 < 射程180 可互相掩护
      T(`${name}/${fac} 双枢纽塔间距≈115且互相掩护(<射程180)`, Math.abs(dd(hq[0],hq[1])-115)<4 && dd(hq[0],hq[1])<180);
      T(`${name}/${fac} 一塔可掩护另一塔(贴脸近战在射程内)`, dd(hq[0],hq[1])+REACH<RANGE);
      for (const nl of Bs.filter(b=>b.tier==='nexus_lane')) {
        const base=Bs.find(b=>b.tier==='base'&&b.laneId===nl.laneId);
        if (base) T(`${name}/${fac}/${nl.laneId} 召唤水晶距水晶塔110`, Math.abs(dd(nl.pos,base.pos)-110)<3);
      }
    }
  }
}
console.log(`\n验收结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
