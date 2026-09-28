globalThis.window={gameTime:0,waveNumber:0,_uid:0};
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {SkillLibrary}=await import('../src/core/SkillLibrary.js');
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};
const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const ctx={entityContainer:ents,effectRegistry:fx,attrCalc:AttributeCalculator,eventBus:bus,waveNumber:0};

// Q2 阶梯成长:外塔
const tw={id:1,type:'tower',alive:true,pos:{x:0,y:0},baseStats:{maxHP:4000,attackDamage:152},currentHP:4000,_skillInstances:[]};
ents.add(tw);
const gi={id:2,skillId:'passive_growth_outer',state:{}};tw._skillInstances.push(gi);
const G=SkillLibrary.passive_growth_outer;
G.onEquip(1,gi,ctx);
function tick(to){while(window.gameTime<to){window.gameTime+=0.5;fx.update(0.5);G.onFrame(1,0.5,gi,ctx);}}
tick(50);
T('40s时0层无效果', !fx.getEffects(1).some(e=>e.blueprint.name==='外塔成长'));
tick(105); // elapsed 105,起算40s → 1层于100s
let eff=fx.getEffects(1).find(e=>e.blueprint.name==='外塔成长');
T('第1层+9', eff && eff.blueprint.flatValue===9 && eff.stacks===1);
T('层间倒计时环(remaining≈55)', eff && eff.remainingTime>50 && eff.remainingTime<=60);
tick(170); eff=fx.getEffects(1).find(e=>e.blueprint.name==='外塔成长');
T('第2层+18', eff && eff.blueprint.flatValue===18 && eff.stacks===2);
tick(40+14*60+5); eff=fx.getEffects(1).find(e=>e.blueprint.name==='外塔成长');
T('封顶14层+126常驻', eff && eff.blueprint.flatValue===126 && eff.stacks===14 && eff.remainingTime===Infinity);
const st=AttributeCalculator.calc(tw,fx.getEffects(1));
T('封顶AD=278', Math.abs(st.attackDamage-278)<0.01);
tick(window.gameTime+120); eff=fx.getEffects(1).find(e=>e.blueprint.name==='外塔成长');
T('封顶后不过期不闪', eff && eff.remainingTime===Infinity && eff.stacks===14);
console.log(`批次4验收: ${pass} 通过 / ${fail} 失败`);process.exit(fail?1:0);
