// Auto-injected: minimal CTX shim for test environment.
if (typeof window !== "undefined" && !window.CTX) {
  window.CTX = {
    gameTime: 0, waveNumber: 0, gamePaused: false, _uid: 0,
    _nextWaveTime: 20, __gameSpeed: 1, __ffRemain: 0,
    __showLanePaths: false,
    __towerRules: {
      invincible: { blue: false, red: false },
      attackOff:  { blue: false, red: false },
      waveOn:     { blue: true,  red: true  },
    },
    __towerRuleFor(kind, faction) {
      const r = this.__towerRules?.[kind];
      if (!r) return false;
      if (!faction) return r.blue || r.red;
      return !!r[faction];
    },
    __app: null, __weather: null, __mapSystem: null,
    __uiManager: null, __weatherPanel: null, __entityContainer: null,
    __perf: null, __score: null, __gameLoop: null,
    createMinion: null, createTower: null,
  };
}

globalThis.window={gameTime:0,waveNumber:0,_uid:0};
import fs from 'fs';
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {SkillLibrary}=await import('../src/core/SkillLibrary.js');
const {MapSystem}=await import('../src/systems/MapSystem.js');
const {LaneWaveSystem}=await import('../src/systems/LaneWaveSystem.js');
const {CONFIG}=await import('../src/data/Config.js');
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

// ---- Q9 嚎哭深渊加载 ----
const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const mapSys=new MapSystem(ents,bus); mapSys.setEffectRegistry(fx);
const captured=[];
mapSys.setCreateBuildingFn((cfg)=>{captured.push(cfg);const e={id:++window._uid,type:'tower',alive:true,pos:cfg.pos,baseStats:{...cfg.stats},currentHP:cfg.stats.maxHP,_mapFaction:cfg.faction,_mapTier:cfg.tier,_laneId:cfg.laneId,_skillInstances:[]};ents.add(e);return e;});
mapSys.loadMap('howling_abyss_v1');
T('HA 12建筑', captured.length===12);
T('HA 单路', mapSys.currentMap.lanes.length===1);
const outer=captured.find(c=>c.tier==='outer'&&c.faction==='blue');
T('HA外塔数值覆写', outer && outer.stats.maxHP===2250 && outer.stats.attackDamage===152);
T('HA外塔技能=深渊成长', outer && Array.isArray(outer.skills) && outer.skills.includes('passive_growth_ha'));
const base=captured.find(c=>c.tier==='base'&&c.faction==='blue');
T('HA水晶塔穿透+永久钢铁防线', base && base.weapon==='piercing' && base.skills.includes('passive_iron_line_ha') && base.stats.maxHP===3750);
const hqs=captured.filter(c=>c.tier==='hq_tower'&&c.faction==='blue');
T('HA枢纽塔×2穿透(最新确认)', hqs.length===2 && hqs.every(h=>h.weapon==='piercing'&&h.stats.maxHP===2750));
T('HA所有塔攻速统一0.833(最新确认)', [outer,base,...hqs].every(t=>t.stats.baseAttackSpeed===0.833));

// ==================== 几何硬校验（用户确认的 LoL 复刻约束） ====================
const RANGE=180;
const HA=(await import('../src/data/maps/howling_abyss.js')).howling_abyss;
const Bd=HA.buildings.filter(b=>b.faction==='blue'), Rd=HA.buildings.filter(b=>b.faction==='red');
const get=(arr,tier)=>arr.filter(b=>b.tier===tier).map(b=>b.pos);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const bOuter=get(Bd,'outer')[0], rOuter=get(Rd,'outer')[0];
const bBase=get(Bd,'base')[0], bNL=get(Bd,'nexus_lane')[0], bHQ=get(Bd,'hq_tower');
const netZone=dist(bOuter,rOuter)-2*RANGE;
T('中间战斗区净空=543(4.5×射程的67%,±20)', Math.abs(netZone-543)<20);
T('外塔↔水晶塔 射程圈完全分开(>360)', dist(bBase,bOuter)>2*RANGE);
// 期望常量更新：枢纽塔↔水晶塔 由「衔接重叠 250~360」改为「完全分开 >360」（实测 460）。
// 原因不是实现变了，是布局按用户要求变了："高地那里水晶塔/召唤水晶往外一些"，
// 水晶塔沿线 428→580，于是它和枢纽塔之间恢复成本项目一贯的塔距规则（间距 > 2×射程），
// 和上面那条"外塔↔水晶塔"同一条规则。250~360 那版是水晶塔还贴在高地口时的产物。
T('枢纽塔↔水晶塔 射程圈完全分开(>360)', bHQ.every(h=>dist(h,bBase)>2*RANGE));
T('水晶塔↔召唤水晶 紧贴(塔圈护水晶,≤130)', dist(bBase,bNL)<=130);
T('v34 双枢纽塔间距≈115(与峡谷统一，可互相掩护)', Math.abs(dist(bHQ[0],bHQ[1])-115)<4 && dist(bHQ[0],bHQ[1])<180);
T('一塔可打到贴脸攻击另一塔的近战', dist(bHQ[0],bHQ[1])+35 < RANGE);
// 跨阵营攻击塔互不重叠
const atkB=[...bHQ,bBase,bOuter], atkR=[...get(Rd,'hq_tower'),get(Rd,'base')[0],rOuter];
let crossMin=1e9;
for(const a of atkB) for(const b of atkR) crossMin=Math.min(crossMin,dist(a,b));
T('敌我攻击塔射程无交集(>360)', crossMin>2*RANGE);
T('HA noRend 标记', mapSys.currentMap.minionNoRend===true);
// 建筑到兵线距离 ≤190
const wps=mapSys.currentMap.lanes[0].waypoints;
function distToLane(p){const a=wps[0],b=wps[1];const vx=b.x-a.x,vy=b.y-a.y,L2=vx*vx+vy*vy;const t=Math.max(0,Math.min(1,((p.x-a.x)*vx+(p.y-a.y)*vy)/L2));return Math.hypot(p.x-(a.x+t*vx),p.y-(a.y+t*vy));}
T('HA全建筑距兵线≤190', captured.every(c=>distToLane(c.pos)<=190));

// ---- Q3/Q9 波次构成 ----
const lw=new LaneWaveSystem(ents,bus,mapSys);
let spawned=[];
lw.setCreateMinion((type)=>{spawned.push(type);return {id:++window._uid,alive:true};});
lw.nextWaveTime=99999; lw.waveNumber=2; spawned=[]; lw._enqueueForFaction('blue',mapSys.currentMap.lanes[0],'forward');
for(let i=0;i<30;i++){lw.update(0.5);lw.nextWaveTime=99999;}
// 编排是用户可调的（这一轮特殊兵种的起始波整体前移了），所以不再把整条队列逐字写死 ——
// 只钉住这两条断言真正想说的事：骨架是"近战3 + 远程3"，且近战全部排在远程之前。
const _cnt=(a,t)=>a.filter(x=>x===t).length;
T(`普通波含近3+远3（实际 ${spawned.join('/')}）`, _cnt(spawned,'melee')===3 && _cnt(spawned,'ranged')===3);
T('近战全部排在远程之前', spawned.lastIndexOf('melee') < spawned.indexOf('ranged'));
lw.waveNumber=3; spawned=[]; lw._enqueueForFaction('blue',mapSys.currentMap.lanes[0],'forward');
for(let i=0;i<30;i++){lw.update(0.5);lw.nextWaveTime=99999;}
T(`炮兵波含炮兵1（实际 ${spawned.join('/')}）`, _cnt(spawned,'siege')===1);
T('炮兵夹在近战与远程之间（不在队首也不在队尾）',
  spawned.indexOf('siege') > spawned.lastIndexOf('melee')
  && spawned.indexOf('siege') < spawned.indexOf('ranged'));
mapSys.nexusDestroyed.red={mid:true}; // 蓝方打掉红方水晶→蓝方出超级兵
lw.waveNumber=6; spawned=[]; lw._enqueueForFaction('blue',mapSys.currentMap.lanes[0],'forward');
for(let i=0;i<30;i++){lw.update(0.5);lw.nextWaveTime=99999;}
// 用户重排了出兵编排（所有兵种默认生成、支援兵种错开波次），第 6 波起术士兵入场。
// 这条断言的本意是"水晶陷落后【超级兵取代炮兵】"，所以只钉这一点，
// 不再把整条队列逐字写死 —— 写死的话每次调编排都会假失败（这次就是）。
T('超级兵波：超级兵在队首、且不再出炮兵',
  spawned[0] === 'super' && !spawned.includes('siege'));
T('超级兵波仍保留近战/远程骨架',
  spawned.filter(t => t === 'melee').length === 3 && spawned.filter(t => t === 'ranged').length === 3);

// ---- Q2/Q1/Q6/Q7/Q10/Q11/Q5 静态与逻辑断言 ----
T('超级兵指挥官含自身(Q2)', fs.readFileSync(new URL('../src/core/skills/minionPassives.js', import.meta.url),'utf8').includes('includeSelf: true'));
T('闪电充能duration=100(Q1)', fs.readFileSync(new URL('../src/core/skills/weapons.js', import.meta.url),'utf8').includes("kind: 'custom', duration: 100"));
const mainSrc=fs.readFileSync(new URL('../src/main.js', import.meta.url),'utf8');
// 该分支现在还带一个"分层被动覆写生效时交给覆写清单决定"的守卫，
// 故只断言其仍在 isNexus 门之外、按 tier 独立装配这一原始意图。
T('光环装配移出isNexus门(Q5)', /if \(tier === 'nexus_main'/.test(mainSrc) && mainSrc.includes("skillLibrary['passive_home_aura']"));
T('Q5 无敌/停火改为按阵营分管', fs.readFileSync(new URL('../src/systems/CombatSystem.js', import.meta.url),'utf8').includes("__towerRuleFor?.('invincible'") && fs.readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url),'utf8').includes('data-rule'));
// Q2：成长表搬到 CONFIG.battleGrowth，断言改读真值。
T('小兵成长表(近战 ad0.3)', CONFIG.battleGrowth.melee.ad === 0.3);
T('Q3 炮车成长：降HP(18→10)、增双抗(0.13→0.30)',
  CONFIG.battleGrowth.siege.hp === 10 && CONFIG.battleGrowth.siege.ad === 0.9 && CONFIG.battleGrowth.siege.res === 0.30);
T('碰撞阻挡Q11', fs.readFileSync(new URL('../src/systems/CollisionSystem.js', import.meta.url),'utf8').includes('BLOCK_FACTOR'));
// 用户定稿：水晶塔(base)攻速 3.08 → 2.50
T('SR水晶塔攻速2.50', fs.readFileSync(new URL('../src/systems/MapSystem.js', import.meta.url),'utf8').includes('baseAttackSpeed: 2.50'));

// Q6:重甲联防只计攻击者
const twr={id:9001,type:'tower',alive:true,pos:{x:0,y:0},baseStats:{maxHP:1000,attackRange:180},currentHP:1000,_skillInstances:[]};ents.add(twr);
const mNear={id:9002,type:'melee',alive:true,pos:{x:20,y:0},baseStats:{attackRange:30},currentHP:100,targetId:9001,_skillInstances:[]};ents.add(mNear); // 在射程内且打塔
const mPass={id:9003,type:'melee',alive:true,pos:{x:40,y:0},baseStats:{attackRange:30},currentHP:100,targetId:9999,_skillInstances:[]};ents.add(mPass); // 路过
const mFar={id:9004,type:'melee',alive:true,pos:{x:120,y:0},baseStats:{attackRange:30},currentHP:100,targetId:9001,_skillInstances:[]};ents.add(mFar); // 目标是塔但没进射程
AttributeCalculator.tick();ents.rebuildGridIfNeeded(AttributeCalculator._frame);
const hd=SkillLibrary.passive_heavy_defense;
const val=hd.computeCurrent(twr,{entityContainer:ents,effectRegistry:fx,attrCalc:AttributeCalculator});
T('重甲联防只计实际攻击者(Q6): 1人=+5', val===5);
// HA成长技能:1分钟1层含护甲
window.gameTime=0;
const gi={id:9010,skillId:'passive_growth_ha',state:{}};twr._skillInstances.push(gi);
const G=SkillLibrary.passive_growth_ha; G.onEquip(twr.id,gi,{effectRegistry:fx,entityContainer:ents});
while(window.gameTime<65){window.gameTime+=0.5;fx.update(0.5);G.onFrame(twr.id,0.5,gi,{effectRegistry:fx,entityContainer:ents});}
const gAD=fx.getEffects(twr.id).find(e=>e.blueprint.name==='深渊塔成长');
const gRes=fx.getEffects(twr.id).filter(e=>e.blueprint.name==='深渊塔成长·双抗');
T('HA成长1层:+9AD/+1护甲/+1魔抗(Q2最新确认)', gAD?.blueprint.flatValue===9 && gAD?.stacks===1
  && gRes.length===2 && gRes.every(e=>e.blueprint.flatValue===1)
  && gRes.some(e=>e.blueprint.statKey==='armor') && gRes.some(e=>e.blueprint.statKey==='magicResist'));
console.log(`批次5验收: ${pass} 通过 / ${fail} 失败`);process.exit(fail?1:0);
