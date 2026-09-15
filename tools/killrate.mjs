#!/usr/bin/env node
/**
 * killrate.mjs —— 击杀率 / 三核演化 探针
 *
 * 为什么需要它：熵的三个标定参数（chargePerCore / chargeDecayPerSec / coreReturnSec）
 * 只有相对"真实对局的击杀率"才有意义。凭感觉给数会两头翻车 ——
 * 都实际发生过：
 *   · 衰减取 1.5/s（基准的 2.5 倍）→ 充能永远攒不满，10 分钟对局终局熵恒为 0.500，
 *     五个加成档位的推进度差一模一样，机制完全等于不存在，而且不报任何错；
 *   · 反过来给太松 → 用户反馈"红方占优太快"。
 * 所以标定必须先量。本脚本跑真实对局，每分钟打印一次击杀数与三核状态。
 *
 * 用法：node tools/killrate.mjs
 * 判读：稳态击杀率约 35 次/分钟/方（≈0.58/s）；三核应在 3~5 分钟出现第一次易手，
 *       镜像对局里两方核数应大致持平（熵在 0.5 附近小幅震荡）。
 */
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
window.__towerRules = { invincible: {blue:false,red:false}, attackOff: {blue:false,red:false}, waveOn: { blue: true, red: true } };
window.__towerRuleFor = (k,f)=>{const r=window.__towerRules[k];return f?!!r[f]:(r.blue||r.red);};
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { ProjectileSystem } = await import('../src/systems/ProjectileSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { CollisionSystem } = await import('../src/systems/CollisionSystem.js');
const { BuffSystem } = await import('../src/systems/BuffSystem.js');
const { CONFIG } = await import('../src/data/Config.js');
const { WorldState } = await import('../src/systems/WorldState.js');
CONFIG.world.couplings.entropyToUnits = true;
const bus=new EventBus(), ents=new EntityContainer(bus), fx=new EffectRegistry(bus);
const world=new WorldState({entities:ents,bus});
AttributeCalculator.setWorldState(world);
const combat=new CombatSystem(ents,fx,bus,SkillLibrary);
const proj=new ProjectileSystem(ents,bus,combat); combat.setProjectileSystem(proj);
const buffs=new BuffSystem(fx,ents,bus,combat);
const mapSys=new MapSystem(ents,bus); mapSys.setEffectRegistry(fx);
const move=new LaneMovementSystem(ents,fx,AttributeCalculator,combat,mapSys);
const coll=new CollisionSystem(ents,mapSys);
const waves=new LaneWaveSystem(ents,bus,mapSys);
const kills={blue:0,red:0};   // 击杀方计数
bus.on('entity:death',({entityId})=>{const e=ents.get(entityId);if(!e)return;const f=e._mapFaction||e.faction;if(f==='blue')kills.red++;else if(f==='red')kills.blue++;});
mapSys.setCreateBuildingFn(({faction,tier,laneId,isNexus,pos,weapon,stats})=>{
  const tpl=CONFIG.templates.tower; const s={...(stats||{})};
  const e={id:++window._uid,type:'tower',alive:true,pos:{x:pos.x,y:pos.y},
    baseStats:{...tpl,maxHP:s.maxHP??tpl.maxHP,armor:s.armor??tpl.armor,magicResist:s.magicResist??tpl.magicResist,
      attackDamage:s.attackDamage??tpl.attackDamage,baseAttackSpeed:s.baseAttackSpeed??tpl.baseAttackSpeed,
      healthRegen:s.healthRegen??tpl.healthRegen,attackRange:s.attackRange??tpl.attackRange,shieldFixedMax:s.shieldFixedMax??0},
    currentHP:0,shieldFixedCurrent:s.shieldFixedMax??0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
    _skillInstances:[],_mapFaction:faction,_mapTier:tier,_laneId:laneId||null,faction};
  e.currentHP=e.baseStats.maxHP;
  const wKey=CONFIG.towerTierWeapon?.[tier]!==undefined?CONFIG.towerTierWeapon[tier]:(isNexus?'none':weapon);
  if(wKey&&wKey!=='none') e._skillInstances.push({id:++window._uid,skillId:'weapon_'+wKey,state:{}});
  ents.add(e); return e;});
waves.setCreateMinion((type,x,y,faction,laneId,direction)=>{
  const tpl=CONFIG.templates[type]; if(!tpl) return null;
  const n=Math.max(0,(waves.waveNumber||1)-1); const G=CONFIG.battleGrowth||{};
  const f={...(G._default||{}),...(G[type]||{})};
  const e={id:++window._uid,type,alive:true,pos:{x,y},
    baseStats:{...tpl,maxHP:tpl.maxHP+f.hp*n,attackDamage:tpl.attackDamage+f.ad*n,armor:tpl.armor+f.res*n,magicResist:tpl.magicResist+f.res*n},
    currentHP:tpl.maxHP+f.hp*n,shieldFixedCurrent:0,tempShield:0,lastDamageTime:-Infinity,attackCooldown:0,targetId:null,
    _skillInstances:[],_mapFaction:faction,_laneId:laneId,_laneDirection:direction,faction};
  const rend={melee:'passive_melee_rend',ranged:'passive_ranged_rend',siege:'passive_siege_rend'}[type];
  if(rend) e._skillInstances.push({id:++window._uid,skillId:rend,state:{}});
  ents.add(e); return e;});
mapSys.loadMap('summoners_rift_v1');
const DT=1/30; let frame=0;
for(let t=0;t<600;t+=DT){frame++;window.gameTime=t;AttributeCalculator.tick();
  ents.rebuildGridIfNeeded(AttributeCalculator._frame);
  world.update(DT,t);waves.update(DT);move.update(DT);coll.update(DT);combat.update(DT);proj.update(DT);buffs.update(DT);fx.update(DT);mapSys.update(DT);ents.purgeDead();
  if(frame%(30*60)===0){const E=world.entropySystem;
    console.log(`${String(Math.round(t/60)).padStart(2)} 分: 击杀 蓝${String(kills.blue).padStart(3)}/红${String(kills.red).padStart(3)}  三核 白${E.white}·未${E.red}·黑${E.black}  熵 ${(E.value*100).toFixed(1)}%  充能 白${(E.chargeProgress('white')*100).toFixed(0)}%/黑${(E.chargeProgress('black')*100).toFixed(0)}%`);}
}
console.log(`\n10 分钟总计: 蓝 ${kills.blue} 红 ${kills.red}`);
console.log(`平均每分钟: 蓝 ${(kills.blue/10).toFixed(1)} 红 ${(kills.red/10).toFixed(1)}`);
console.log(`净差(蓝-红): ${kills.blue-kills.red}  → 每分钟净差 ${((kills.blue-kills.red)/10).toFixed(2)}`);
