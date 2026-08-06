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

globalThis.window={gameTime:0,waveNumber:20,_uid:0}; // v35：炮兵指挥官第20波起生效，指挥官光环测试需要波次≥20
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {SkillLibrary}=await import('../src/core/SkillLibrary.js');
const {CONFIG}=await import('../src/data/Config.js');
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

// 1. 成长一致性:模拟 createMinion 的缩放逻辑(直接调真实文件不可行,验证公式源头)
const tpl=CONFIG.templates.melee;
T('屠戮数值 4/6/7（用户定稿）', SkillLibrary.passive_melee_rend.description.includes('4%') && SkillLibrary.passive_ranged_rend.description.includes('6%') && SkillLibrary.passive_siege_rend.description.includes('7%'));

// 2. 阵营覆写合并语义
CONFIG.factionOverrides.blue.melee={attackDamage:99};
const merged={...CONFIG.templates.melee,...CONFIG.factionOverrides.blue.melee};
T('蓝方覆写生效', merged.attackDamage===99);
T('红方/共享不受影响', CONFIG.templates.melee.attackDamage!==99 && !CONFIG.factionOverrides.red.melee);
delete CONFIG.factionOverrides.blue.melee;

// 3. 钢铁防线:onEquip 通过效果系统添加 300s +50 减伤
const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
const tower={id:1,type:'tower',alive:true,pos:{x:0,y:0},baseStats:{maxHP:100},currentHP:100,_skillInstances:[]};
ents.add(tower);
const inst={id:2,skillId:'passive_iron_line',state:{}};
SkillLibrary.passive_iron_line.onEquip(tower.id,inst,{entityContainer:ents,effectRegistry:fx,attrCalc:AttributeCalculator});
const eff=fx.getEffects(tower.id).find(e=>e.blueprint.name==='钢铁防线');
T('钢铁防线状态存在', !!eff);
T('减伤+33/时限300s（v39 节奏：50%/420s→33%/300s）', eff && eff.blueprint.flatValue===33 && Math.abs(eff.remainingTime-300)<1);
fx.update(299); T('299s仍在', fx.getEffects(tower.id).some(e=>e.blueprint.name==='钢铁防线'));
fx.update(2); T('421s脱落', !fx.getEffects(tower.id).some(e=>e.blueprint.name==='钢铁防线'));

// 4. 塔身三分
T('召唤水晶/枢纽塔身存在', !!SkillLibrary.core_nexus_lane && !!SkillLibrary.core_nexus_main);

// 5. 对战成长复利与炮车减半(读 main.js 文本验证公式,运行时函数在 DOM 环境)
import fs from 'fs';
const mainSrc=fs.readFileSync(new URL('../src/main.js', import.meta.url),'utf8');
// Q2：成长表搬到 CONFIG.battleGrowth，断言改读真值（仍是纯固定值/波，无复利项）。
T('成长为固定值表(Q2)',
  CONFIG.battleGrowth.melee.hp === 7 && CONFIG.battleGrowth.siege.hp === 10
  && Object.values(CONFIG.battleGrowth).every(g => ['hp','ad','res'].every(k => typeof g[k] === 'number')));
T('maxHP缩放修复', mainSrc.includes('entity.baseStats.maxHP = tpl.maxHP * hpScale'));
T('固定值走growthFlat通道', mainSrc.includes('growthFlat: battleGrowthFlat(type)'));
T('巨龙默认暂停', fs.readFileSync(new URL('../src/systems/DragonSystem.js', import.meta.url),'utf8').includes('this.paused = true'));
T('四塔成长技能注册', !!SkillLibrary.passive_growth_outer && !!SkillLibrary.passive_growth_inner && !!SkillLibrary.passive_growth_base && !!SkillLibrary.passive_growth_hq);
T('基地光环注册', !!SkillLibrary.passive_home_aura);
const {canTarget:ct}=await import('../src/systems/FactionSystem.js');
T('中立攻击红蓝(EQ2)', ct('neutral','blue') && ct('neutral','red') && !ct('neutral','neutral'));
T('红蓝攻击中立', ct('blue','neutral') && ct('red','neutral'));
// 指挥官光环不含自身（用户确认）
{
  const bus2=new EventBus(),ents2=new EntityContainer(bus2),fx2=new EffectRegistry(bus2);
  const ctx2={entityContainer:ents2,effectRegistry:fx2,attrCalc:AttributeCalculator,eventBus:bus2};
  const mkm=(type,x)=>{const tpl=CONFIG.templates[type];
    const e={id:++window._uid,type,alive:true,pos:{x,y:0},baseStats:{...tpl},currentHP:tpl.maxHP,
      _skillInstances:[],_mapFaction:'blue',_laneId:'mid',faction:'blue'};ents2.add(e);return e;};
  const siege=mkm('siege',0), ally=mkm('melee',30);
  const sup=mkm('super',60), ally2=mkm('melee',90);
  const i1={id:++window._uid,skillId:'passive_artillery_commander',state:{}};siege._skillInstances.push(i1);
  const i2={id:++window._uid,skillId:'passive_super_commander',state:{}};sup._skillInstances.push(i2);
  AttributeCalculator.tick();ents2.rebuildGridIfNeeded(AttributeCalculator._frame);
  SkillLibrary.passive_artillery_commander.onFrame(siege.id,1,i1,ctx2);
  SkillLibrary.passive_super_commander.onFrame(sup.id,1,i2,ctx2);
  const selfSiege=fx2.getEffects(siege.id).some(e=>e.blueprint.name==='炮兵指挥官');
  const allyBuffed=fx2.getEffects(ally.id).some(e=>e.blueprint.name==='炮兵指挥官');
  const selfSuper=fx2.getEffects(sup.id).some(e=>e.blueprint.name==='超级兵指挥官');
  const ally2Buffed=fx2.getEffects(ally2.id).some(e=>e.blueprint.name==='超级兵指挥官');
  T('炮兵指挥官不给自己加成', !selfSiege);
  T('炮兵指挥官给周围小兵加成', allyBuffed);
  T('超级兵指挥官不给自己加成(最新确认)', !selfSuper);
  T('超级兵指挥官给周围小兵加成', ally2Buffed);
}
// 穿透武器走效果系统（用户 Q2 方案B）+ 增幅武器配色统一（Q1）
{
  const bus3=new EventBus(),ents3=new EntityContainer(bus3),fx3=new EffectRegistry(bus3);
  const ctx3={entityContainer:ents3,effectRegistry:fx3,attrCalc:AttributeCalculator};
  const tw={id:++window._uid,type:'tower',alive:true,pos:{x:0,y:0},
    baseStats:{maxHP:1000,attackDamage:100,armorPenPercent:0,magicPenPercent:0},currentHP:1000,_skillInstances:[]};
  ents3.add(tw);
  const wi={id:++window._uid,skillId:'weapon_piercing',state:{}};tw._skillInstances.push(wi);
  SkillLibrary.weapon_piercing.onEquip(tw.id,wi,ctx3);
  const pen=fx3.getEffects(tw.id).filter(e=>e.blueprint.name==='穿透');
  const st3=AttributeCalculator.calc(tw,fx3.getEffects(tw.id));
  T('穿透30%走效果系统(面板可见)', pen.length===2 && st3.armorPenPercent===30 && st3.magicPenPercent===30);
  T('穿透状态为永久(不闪烁刷新)', pen.every(e=>e.remainingTime===Infinity));
  SkillLibrary.weapon_piercing.onUnequip(tw.id,wi,ctx3);
  const st4=AttributeCalculator.calc(tw,fx3.getEffects(tw.id));
  T('卸下武器后穿透脱落(不留缝合怪)', st4.armorPenPercent===0 && fx3.getEffects(tw.id).length===0);
  T('穿透描述为v36文案（升温=配对倍率）', SkillLibrary.weapon_piercing.description.includes('100%→130%→160%'));
  T('增幅型武器已删除（v33）', SkillLibrary.weapon_normal===undefined);
}
console.log(`批次3验收: ${pass} 通过 / ${fail} 失败`); process.exit(fail?1:0);
