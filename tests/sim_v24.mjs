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

// v24 批次验收：闪电杖充能bug、绝望反击、超级兵截止、LOD相对化、UI迁移
globalThis.window={gameTime:0,_uid:0,
  __towerRules:{invincible:{blue:false,red:false},attackOff:{blue:false,red:false},waveOn:{blue:true,red:true}}};
window.__towerRuleFor=(k,f)=>{const r=window.__towerRules?.[k];if(!r)return false;if(!f)return r.blue||r.red;return !!r[f];};
const {EntityContainer}=await import('../src/core/EntityContainer.js');
const {EventBus}=await import('../src/utils/EventBus.js');
const {EffectRegistry}=await import('../src/core/EffectRegistry.js');
const {AttributeCalculator}=await import('../src/core/AttributeCalculator.js');
const {SkillLibrary}=await import('../src/core/SkillLibrary.js');
import fs from 'fs';
let pass=0,fail=0;const T=(n,c)=>{c?pass++:(fail++,console.log('✗',n))};

// ========== Q1: 充能速率必须随攻速变化（原 bug：模板攻速被约掉） ==========
{
  const bus=new EventBus(),ents=new EntityContainer(bus),fx=new EffectRegistry(bus);
  const mk=(as)=>{const e={id:++window._uid,type:'tower',alive:true,pos:{x:0,y:0},
    baseStats:{maxHP:3000,attackDamage:200,baseAttackSpeed:as,attackSpeedRatio:0.667,attackRange:180,armor:0,magicResist:0,moveSpeed:0,healthRegen:0,shieldFixedMax:0},
    currentHP:3000,_skillInstances:[],targetId:null};ents.add(e);return e;};
  const measure=(as)=>{
    const t=mk(as);
    const inst={id:++window._uid,skillId:'weapon_lightning',state:{charge:0,tickTimer:0}};
    t._skillInstances.push(inst);
    const target={id:++window._uid,type:'melee',alive:true,pos:{x:50,y:0},baseStats:{maxHP:99999,armor:0,magicResist:0},currentHP:99999,_skillInstances:[]};
    ents.add(target);t.targetId=target.id;
    const ctx={entityContainer:ents,effectRegistry:fx,attrCalc:AttributeCalculator,eventBus:bus,
      combat:{performAttackDirect:()=>{}}};
    let time=0;const DT=1/30;
    while(inst.state.charge<1 && time<60){AttributeCalculator.tick();
      SkillLibrary.weapon_lightning.onFrame(t.id,DT,inst,ctx);time+=DT;}
    return time;
  };
  const t0833=measure(0.833), t208=measure(2.08), t4=measure(4.0);
  console.log(`充能时间: 攻速0.833→${t0833.toFixed(1)}s | 2.08→${t208.toFixed(1)}s | 4.0→${t4.toFixed(1)}s`);
  T('Q1 攻速影响充能速度（bug已修）', t208 < t0833*0.6 && t4 < t208*0.6);
  T('Q1 满充时间 ≈ 12/攻速', Math.abs(t0833-12/0.833)<1.0 && Math.abs(t4-12/4)<0.5);
}

// ========== Q8: 无视防御连续增长至60% ==========
{
  const src=fs.readFileSync(new URL('../src/core/skills/weapons.js', import.meta.url),'utf8');
  T('Q8 无视防御上限60%', src.includes('LIGHTNING_MAX_PEN = 0.60'));
  T('Q8 无视防御随充能连续（非满充阶跃）', src.includes('ignoreDefenseRatio: charge * LIGHTNING_MAX_PEN'));
  T('Q4 闪电杖伤害类型为魔法', src.includes("performAttackDirect(entity.id, target.id, tickDamage, 'magic'"));
}

// ========== Q7: 绝望反击 —— 技能已按用户定稿删除（此前长期不生效），本段测试随之移除 ==========

// ========== Q2/Q5/Q10/Q11/Q12: 代码结构断言 ==========
{
  const lws=fs.readFileSync(new URL('../src/systems/LaneWaveSystem.js', import.meta.url),'utf8');
  const map=fs.readFileSync(new URL('../src/systems/MapSystem.js', import.meta.url),'utf8');
  const rend=fs.readFileSync(new URL('../src/presentation/CanvasRenderer.js', import.meta.url),'utf8');
  const cc=fs.readFileSync(new URL('../src/ui/CanvasController.js', import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  const settings=fs.readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url),'utf8');

  T('Q2 重生前30秒停发超级兵', lws.includes('superMinionCutoffBeforeRespawn') && map.includes('getNexusRespawnRemain'));
  T('Q5 波次生成按阵营门控', lws.includes("__towerRuleFor('waveOn', faction)"));
  T('v33 设置面板波次间隔已去重（仅对战区一个控件）', settings.includes('setLaneWaveInterval') && !settings.includes('setWaveIntervalInput'));
  T('Q10 画布调试文字已删除', !rend.includes('弹道: ${this.projectiles'));
  T('Q11 LOD 相对于全图缩放（不再写死绝对值）', rend.includes('this._fitZoom') && rend.includes('const rel = this.viewZoom / fitZoom'));
  T('Q11 fitToWorld 记录并共享 fitZoom', cc.includes('this.renderer._fitZoom = this.zoom'));
  T('Q12 🎯 重置为全图视角', cc.includes('this.fitToWorld(map.world.w, map.world.h)'));
  T('Q12 性能面板移入设置（画布按钮已删）', !html.includes('id="perfBtn"') && settings.includes('setPerfBtn'));
  T('Q6 重生进度条无倒计时数字', !rend.includes('_respawnRemain != null'));
  T('Q9 天气条在顶栏内', html.indexOf('id="weatherWrap"') > html.indexOf('<div id="topbar">')
    && html.indexOf('id="weatherWrap"') < html.indexOf('</div>', html.indexOf('<div id="topbar">')) + 2000);
  T('Q9 属性面板有天气行（塔+小兵各一）',
    (ui.match(/class="weather-row"/g)||[]).length===2 && ui.includes('_updateWeatherRow'));
  T('Q9 天气行显示生效强度（经67%截断，经 getModifierBreakdown 间接调用）',
    ui.includes('getModifierBreakdown(entity)'));
}

console.log(`v24验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
