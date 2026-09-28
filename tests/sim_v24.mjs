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

// ========== Q8: 无视防御连续增长至上限（v43 定稿 67%，历史：60% → 90% → 67%）==========
{
  const src=fs.readFileSync(new URL('../src/core/skills/weapons.js', import.meta.url),'utf8');
  // 数值已从模块级 const 搬进 defaultParams（软编码，编辑器可改），所以断言改钉参数值。
  T('Q8 无视防御上限 67%（v43 定稿，原 90%）',
    SkillLibrary.weapon_lightning.defaultParams.maxPenPct === 67);
  T('Q8 无视防御随充能连续（非满充阶跃）', src.includes('ignoreDefenseRatio: charge * P.maxPen'));
  T('Q8 数值不再写死在源码里（模块级 const 已删）',
    !src.includes('LIGHTNING_MAX_PEN') && !src.includes('LIGHTNING_MAX_MULT')
    && !src.includes('CHARGE_TIME_AT_AS1 ='));
  T('Q4 闪电杖伤害类型为魔法', src.includes("performAttackDirect(entity.id, target.id, tickDamage, 'magic'"));
}

// ========== Q7: 绝望反击 —— 技能已按用户定稿删除（此前长期不生效），本段测试随之移除 ==========

// ========== Q2/Q5/Q10/Q11/Q12: 代码结构断言 ==========
{
  const lws=fs.readFileSync(new URL('../src/systems/LaneWaveSystem.js', import.meta.url),'utf8');
  const map=fs.readFileSync(new URL('../src/systems/MapSystem.js', import.meta.url),'utf8');
  const cc=fs.readFileSync(new URL('../src/ui/CanvasController.js', import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  const settings=fs.readFileSync(new URL('../src/ui/SettingsDialog.js', import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../src/ui/UIManager.js', import.meta.url),'utf8');

  const wo = fs.readFileSync(new URL('../src/ui/editor/pagesWave.js', import.meta.url), 'utf8');
  T('Q2 重生前30秒停发超级兵', lws.includes('superMinionCutoffBeforeRespawn') && map.includes('getNexusRespawnRemain'));
  T('Q5 波次生成按阵营门控', lws.includes("__towerRuleFor('waveOn', faction)"));
  // 2026-08 用户定稿："设置窗口只留系统设置"——波次运行时控制（含这个去重过的
  // 间隔输入框）整体搬到"游戏性→出兵编排"（pagesWave.js），SettingsDialog 不再有它。
  T('v33 设置面板波次间隔已去重（现搬到"游戏性→出兵编排"，仅对战区一个控件）',
    wo.includes('woLaneWaveInterval') && !settings.includes('setWaveIntervalInput') && !settings.includes('setLaneWaveInterval'));
  // v43 P0-①：这三条原先钉的是 CanvasRenderer（旧 2D 渲染器，已作为死代码删除）。
  // 其中两条是"某段代码已删除"型断言——目标文件本身都没了，断言自然恒真，删掉；
  // LOD 那条在活的 ThreeRenderer 里有对应实现，改钉它。
  const three=fs.readFileSync(new URL('../src/presentation/ThreeRenderer.js', import.meta.url),'utf8');
  T('Q11 LOD 相对于全图缩放（不再写死绝对值）', three.includes('_fitZoom') && /rel\s*=\s*[^;]*fitZoom/.test(three));
  T('Q11 fitToWorld 记录并共享 fitZoom', cc.includes('this.renderer._fitZoom = this.zoom'));
  T('Q12 🎯 重置为全图视角', cc.includes('this.fitToWorld(map.world.w, map.world.h)'));
  T('Q12 性能面板移入设置（画布按钮已删）', !html.includes('id="perfBtn"') && settings.includes('setPerfBtn'));
  T('Q6 重生进度条无倒计时数字', !three.includes('_respawnRemain != null'));
  // 天气条现在是右上角【世界状态小窗】里的一行（与时间/昼夜、熵同窗分段显示）。
  T('Q9 天气段在世界状态小窗内', html.includes('id="worldHud"') && html.includes('id="whWeatherRow"'));
  T('Q9 属性面板有天气行（塔+小兵各一）',
    (ui.match(/class="weather-row"/g)||[]).length===2 && ui.includes('_updateWeatherRow'));
  // 熵修正也必须在属性面板里看得见（用户："在单位属性栏里也加上熵修正的描述"）
  T('属性面板有世界影响行（塔+小兵各一）',
    (ui.match(/class="world-row"/g)||[]).length===2 && ui.includes('_updateWorldRow'));
  T('Q9 天气行显示生效强度（经67%截断，经 getModifierBreakdown 间接调用）',
    ui.includes('getModifierBreakdown(entity)'));
}

console.log(`v24验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
