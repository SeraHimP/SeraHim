// 自制内容验收：用户"自己做一件原本不存在的东西"。
//
// 这套用例的立场是**端到端**：不验证"表单能不能填"，而验证
// 「做一个状态 → 做一把用这个状态的武器 → 装到塔上 → 打一下 → 目标真的中了状态」
// 这条链条整条走通。中间任何一环是空转，最后一条断言就会挂。
//
// 另外重点钉住两件容易做成花架子的事：
//   ① 校验必须在**保存时**就报错，而不是运行时静默失效（"改了没反应"的根源）；
//   ② 自制内容必须能存档往返 —— 那是用户的作品，丢了等于白做。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { validateSpec, compileSpec, ACTIONS, CONDITIONS, TRIGGERS } = await import('../src/core/behaviorVM.js');
const CC = await import('../src/data/customContent.js');
const { exportTemplates, importTemplates } = await import('../src/data/templateIO.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const clean = () => { CONFIG.customEffects = {}; CONFIG.customSkills = {}; CONFIG.customMinions = {}; };
clean();

// ==================== 一、做一个状态 ====================
T('状态：合法蓝图保存成功', CC.saveEffect({
  id: 'custom_frostbite', name: '霜咬', icon: '❄️', kind: 'stat',
  statKey: 'moveSpeed', percentValue: -30, duration: 2.5,
}).ok);
T('状态：存进 CONFIG.customEffects', !!CONFIG.customEffects.custom_frostbite);
T('状态：自动补上 stackPolicy 等必要默认值',
  CONFIG.customEffects.custom_frostbite.stackPolicy === 'refresh');

// 校验必须在保存时挡住，而不是等运行时静默失效
T('状态：kind=stat 但没写 statKey → 保存时报错',
  CC.saveEffect({ id: 'bad1', name: 'x', kind: 'stat', duration: 1 }).ok === false);
T('状态：statKey 不是模板字段 → 报错',
  CC.saveEffect({ id: 'bad2', name: 'x', kind: 'stat', statKey: '不存在的属性', flatValue: 1, duration: 1 }).ok === false);
T('状态：flat 与 percent 都为空 → 报错（这个状态什么都不做）',
  CC.saveEffect({ id: 'bad3', name: 'x', kind: 'stat', statKey: 'armor', duration: 1 }).ok === false);
T('状态：没有 duration 也没有 permanent → 报错',
  CC.saveEffect({ id: 'bad4', name: 'x', kind: 'stat', statKey: 'armor', flatValue: 5 }).ok === false);
T('状态：id 不合法 → 报错',
  CC.saveEffect({ id: '3-坏id', name: 'x', kind: 'stat', statKey: 'armor', flatValue: 5, duration: 1 }).ok === false);
T('状态：报错信息说得出问题在哪（不是"invalid"）', (() => {
  const r = CC.saveEffect({ id: 'bad5', name: 'x', kind: 'stat', duration: 1 });
  return r.errors.some(e => e.includes('statKey'));
})());

// ==================== 二、做一把用这个状态的武器 ====================
const SPEC = {
  id: 'weapon_custom_frost', name: '霜冻炮', icon: '❄️', category: 'weapon',
  description: '命中造成魔法伤害并使目标减速。',
  params: { dmg: 40, splashR: 70 },
  rules: [
    { on: 'hit', do: [
      { act: 'damage', amount: { param: 'dmg' }, type: 'magic' },
      { act: 'applyEffect', effect: 'custom_frostbite', to: 'target' },
    ] },
    { on: 'hit', when: [{ targetIsTower: true }], do: [
      { act: 'splash', radius: { param: 'splashR' }, ofAttackPct: 40, type: 'magic' },
    ] },
    { on: 'equip', do: [{ act: 'modifyStat', stat: 'attackDamage', pct: -20 }] },
  ],
};
T('技能：规格通过校验', validateSpec(SPEC).ok);
T('技能：保存并注册进 SkillLibrary',
  CC.saveSkill(SPEC).ok && SkillLibrary.has('weapon_custom_frost'));
const def = SkillLibrary.get('weapon_custom_frost');
T('技能：编译出 onHit / onEquip', typeof def.onHit === 'function' && typeof def.onEquip === 'function');
T('技能：params 变成 defaultParams（因此能被全局/地图覆写）',
  def.defaultParams.dmg === 40 && def.defaultParams.splashR === 70);
T('技能：保留 _vmSpec 供编辑器读回表单继续改', !!def._vmSpec);

// 校验：写错的规格一律在保存时挡住
const bad = (spec, why) => T(`技能：${why}`, validateSpec(spec).ok === false);
bad({ ...SPEC, rules: [] }, '没有任何规则 → 报错');
bad({ ...SPEC, rules: [{ on: '不存在的时机', do: [{ act: 'damage' }] }] }, '触发时机不存在 → 报错');
bad({ ...SPEC, rules: [{ on: 'hit', do: [{ act: '不存在的动作' }] }] }, '动作不存在 → 报错');
bad({ ...SPEC, rules: [{ on: 'hit', do: [] }] }, '规则里没有动作 → 报错');
bad({ ...SPEC, rules: [{ on: 'frame', do: [{ act: 'heal', amount: 1 }] }] }, 'frame 缺 every → 报错');
bad({ ...SPEC, rules: [{ on: 'frame', every: 1, do: [{ act: 'splash', radius: 50 }] }] },
  'frame（无目标）里用需要目标的动作 → 报错');
bad({ ...SPEC, rules: [{ on: 'frame', every: 1, when: [{ hasShield: true }], do: [{ act: 'heal', amount: 1 }] }] },
  'frame（无目标）里用目标相关条件 → 报错');
bad({ ...SPEC, rules: [{ on: 'hit', do: [{ act: 'modifyStat', stat: 'attackDamage', pct: -10 }] }] },
  'modifyStat 放在 hit 里 → 报错（会每次命中都改并永久累积）');
bad({ ...SPEC, rules: [{ on: 'hit', do: [{ act: 'damage', amount: { param: '不存在的参数' } }] }] },
  '引用了不存在的参数 → 报错（否则运行时静默取默认值）');
bad({ ...SPEC, rules: [{ on: 'hit', do: [{ act: 'applyEffect', effect: '不存在的状态' }] }] },
  '施加不存在的状态 → 报错');
bad({ ...SPEC, id: '坏 id' }, 'id 不合法 → 报错');
T('技能：校验失败时不注册半个坏技能',
  compileSpec({ id: 'nope', name: 'x', rules: [] }) === null && !SkillLibrary.has('nope'));

// ==================== 三、端到端：装上去真的打出效果 ====================
{
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const combat = new CombatSystem(ents, fx, bus, SkillLibrary);

  const inst = { id: ++window._uid, skillId: 'weapon_custom_frost', state: {} };
  const tower = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 0, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 3000,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [inst],
    _mapFaction: 'blue', faction: 'blue', _mapTier: 'outer',
  };
  const mkEnemy = (x, y) => {
    const e = {
      id: ++window._uid, type: 'melee', alive: true, pos: { x, y },
      baseStats: { ...CONFIG.templates.melee }, currentHP: 100000,
      shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
      attackCooldown: 0, targetId: null, _skillInstances: [],
      _mapFaction: 'red', faction: 'red',
    };
    ents.add(e);
    return e;
  };
  ents.add(tower);
  const victim = mkEnemy(30, 0);

  // onEquip：基础攻击力应下调 20%
  const ad0 = CONFIG.templates.tower.attackDamage;
  def.onEquip(tower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T(`端到端：装备时 modifyStat 生效（${ad0} → ${tower.baseStats.attackDamage.toFixed(1)}）`,
    Math.abs(tower.baseStats.attackDamage - ad0 * 0.8) < 1e-6);

  // onHit：伤害 + 状态
  const hp0 = victim.currentHP;
  AttributeCalculator.tick();
  def.onHit(tower.id, victim.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T(`端到端：命中造成了伤害（${hp0} → ${victim.currentHP}）`, victim.currentHP < hp0);
  const effs = fx.getEffects(victim.id);
  T('端到端：目标真的中了自制状态', effs.some(e => e.blueprint?.id === 'custom_frostbite'));
  T('端到端：状态真的改了属性（移速下降）', (() => {
    AttributeCalculator.tick();
    const s = AttributeCalculator.calc(victim, fx.getEffects(victim.id));
    return s.moveSpeed < CONFIG.templates.melee.moveSpeed;
  })());

  // 条件：目标不是建筑，所以 splash 那条规则不该触发
  const bystander = mkEnemy(45, 0);
  const bhp = bystander.currentHP;
  AttributeCalculator.tick();
  def.onHit(tower.id, victim.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T('端到端：条件不满足时该规则不触发（目标非建筑 → 无溅射）', bystander.currentHP === bhp);

  // 条件满足时 splash 要真的打到旁边的人
  const enemyTower = {
    id: ++window._uid, type: 'tower', alive: true, pos: { x: 30, y: 0 },
    baseStats: { ...CONFIG.templates.tower }, currentHP: 99999,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'red', faction: 'red', _mapTier: 'outer',
  };
  ents.add(enemyTower);
  const b2 = bystander.currentHP;
  AttributeCalculator.tick();
  def.onHit(tower.id, enemyTower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T('端到端：条件满足时溅射打到范围内的敌人', bystander.currentHP < b2);

  // 溅射不能打到自己人
  const ally = {
    id: ++window._uid, type: 'melee', alive: true, pos: { x: 32, y: 0 },
    baseStats: { ...CONFIG.templates.melee }, currentHP: 5000,
    shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity,
    attackCooldown: 0, targetId: null, _skillInstances: [],
    _mapFaction: 'blue', faction: 'blue',
  };
  ents.add(ally);
  const a0 = ally.currentHP;
  AttributeCalculator.tick();
  def.onHit(tower.id, enemyTower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T('端到端：溅射不打自己人', ally.currentHP === a0);

  // onUnequip 必须还原 modifyStat，否则换来换去越换越弱
  def.onUnequip(tower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T('端到端：卸下时还原基础属性（否则换武器会永久掉攻击力）',
    Math.abs(tower.baseStats.attackDamage - ad0) < 1e-6);
  def.onEquip(tower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  def.onEquip(tower.id, inst, { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator, combat });
  T('端到端：重复装备不叠加（幂等，基于备份值而非当前值）',
    Math.abs(tower.baseStats.attackDamage - ad0 * 0.8) < 1e-6);
}

// ==================== 四、frame 触发的独立计时器 ====================
{
  const spec = {
    id: 'passive_custom_tick', name: '双周期', category: 'passive',
    params: { h: 5 },
    rules: [
      { on: 'frame', every: 1, do: [{ act: 'heal', amount: { param: 'h' } }] },
      { on: 'frame', every: 10, do: [{ act: 'shield', amount: 100 }] },
    ],
  };
  const d = compileSpec(spec);
  T('frame：编译出 onFrame', typeof d.onFrame === 'function');
  const bus = new EventBus(); const ents = new EntityContainer(bus); const fx = new EffectRegistry(bus);
  const inst = { id: 1, skillId: spec.id, state: {}, _params: { h: 5 } };
  const e = { id: 99, type: 'tower', alive: true, pos: { x: 0, y: 0 },
              baseStats: { ...CONFIG.templates.tower }, currentHP: 100, tempShield: 0, _skillInstances: [inst] };
  ents.add(e);
  const ctx = { entityContainer: ents, effectRegistry: fx, eventBus: bus, attrCalc: AttributeCalculator };
  // 跑 3 秒：1 秒周期应触发 3 次（+15），10 秒周期一次都不该触发
  // 参数顺序必须与 CombatSystem 的调用一致：(entityId, dt, instance, ctx)。
  // 这条测试原先按 (id, inst, ctx, dt) 调用 —— 与被测代码同错，所以两边都错却全绿。
  // 跨模块回调的签名要以【调用方】为准核对，不能以自己写的测试为准。
  for (let i = 0; i < 90; i++) d.onFrame(e.id, 1 / 30, inst, ctx);
  T(`frame：短周期按 every 触发（生命 100 → ${e.currentHP}）`, e.currentHP === 115);
  T('frame：长周期未到点不触发（两条规则计时器互相独立）', e.tempShield === 0);
  for (let i = 0; i < 210; i++) d.onFrame(e.id, 1 / 30, inst, ctx);
  T(`frame：长周期到点后触发（护盾 ${e.tempShield}）`, e.tempShield === 100);
}

// ==================== 五、做一个兵种 ====================
T('兵种：保存成功', CC.saveMinion({
  id: 'frostling', name: '霜灵', icon: '❄️',
  stats: { maxHP: 420, attackDamage: 31, armor: 5, moveSpeed: 62, attackRange: 90 },
  growth: { hp: 6, ad: 0.4, res: 0.3 },
}).ok);
T('兵种：展开进 CONFIG.templates（其余读模板处无需知道"自制"这回事）',
  CONFIG.templates.frostling?.maxHP === 420);
T('兵种：缺的字段从近战兵兜底（模板有几十个字段，不可能全填）',
  CONFIG.templates.frostling.magicResist === CONFIG.templates.melee.magicResist);
T('兵种：成长表一起建好', CONFIG.battleGrowth.frostling?.hp === 6);
T('兵种：进入全类型列表', CC.allMinionTypes().includes('frostling'));
T('兵种：显示名/图标取用户填的', CC.minionLabel('frostling') === '霜灵' && CC.minionIcon('frostling') === '❄️');
T('兵种：id 与内置冲突 → 报错', CC.saveMinion({ id: 'melee', name: 'x', stats: { maxHP: 1, attackDamage: 1 } }).ok === false);
T('兵种：生命/攻击非正 → 报错', CC.saveMinion({ id: 'zz', name: 'x', stats: { maxHP: 0, attackDamage: 1 } }).ok === false);

// 自制兵种要能真的出兵
{
  const { buildWaveOrder } = await import('../src/data/waveComposition.js');
  const saved = CONFIG.gameRules.laneWaveComposition;
  CONFIG.gameRules.laneWaveComposition = [{ type: 'frostling', count: 2 }];
  CONFIG.gameRules.spawnEnabled = {};
  T('兵种：可以排进出兵编排并真的出兵',
    buildWaveOrder(1, false, CONFIG.gameRules).filter(t => t === 'frostling').length === 2);
  CONFIG.gameRules.laneWaveComposition = saved;
}

// ==================== 六、删除的连带清理 ====================
T('删除：被技能引用的状态不能直接删（否则技能静默空转）',
  CC.deleteEffect('custom_frostbite').ok === false);
T('删除：报错信息点名是哪个技能在用',
  CC.deleteEffect('custom_frostbite').errors[0].includes('霜冻炮'));
CC.deleteSkill('weapon_custom_frost');
T('删除技能：从 SkillLibrary 摘掉（不留配置里已不存在却还在跑的幽灵）',
  !SkillLibrary.has('weapon_custom_frost') && SkillLibrary.weapon_custom_frost === undefined);
T('删除：技能没了之后状态就能删了', CC.deleteEffect('custom_frostbite').ok);
{
  CONFIG.gameRules.laneWaveComposition = [{ type: 'frostling', count: 2 }, { type: 'melee', count: 3 }];
  CC.deleteMinion('frostling');
  T('删除兵种：出兵编排里引用它的规则一起清掉（否则那一波会静默少兵）',
    CONFIG.gameRules.laneWaveComposition.every(r => r.type !== 'frostling'));
  T('删除兵种：模板一起清掉', CONFIG.templates.frostling === undefined);
}

// ==================== 七、存档往返：用户的作品不能丢 ====================
{
  clean();
  CC.saveEffect({ id: 'custom_burn', name: '灼烧', kind: 'dot', duration: 3, tickDamage: 8, tickInterval: 1 });
  CC.saveSkill({ id: 'weapon_custom_fire', name: '火炮', category: 'weapon', params: { d: 10 },
    rules: [{ on: 'hit', do: [{ act: 'damage', amount: { param: 'd' }, type: 'magic' },
                              { act: 'applyEffect', effect: 'custom_burn' }] }] });
  CC.saveMinion({ id: 'emberling', name: '烬灵', stats: { maxHP: 300, attackDamage: 20 } });

  const snap = exportTemplates(CONFIG);
  T('存档：三类自制内容都在导出里',
    !!snap.customEffects.custom_burn && !!snap.customSkills.weapon_custom_fire && !!snap.customMinions.emberling);

  // 模拟"新开一局再导入存档"
  clean();
  SkillLibrary._registry.delete('weapon_custom_fire');
  delete SkillLibrary.weapon_custom_fire;
  delete CONFIG.templates.emberling;
  T('存档：清空后技能确实不在了', !SkillLibrary.has('weapon_custom_fire'));

  importTemplates(CONFIG, JSON.parse(JSON.stringify(snap)));
  const r = CC.syncAll();
  T(`存档：导入 + syncAll 后全部复活（技能 ${r.skills} / 兵种 ${r.minions} / 状态 ${r.effects}）`,
    r.errors.length === 0 && SkillLibrary.has('weapon_custom_fire')
    && CONFIG.templates.emberling?.maxHP === 300 && !!CONFIG.customEffects.custom_burn);
  T('存档：复活的技能行为完整（onHit 在）', typeof SkillLibrary.get('weapon_custom_fire').onHit === 'function');
  const r2 = CC.syncAll();
  T('syncAll 幂等（导入存档会重复调用）', r2.errors.length === 0 && r2.skills === r.skills);
  T('往返后内容逐位一致',
    JSON.stringify(exportTemplates(CONFIG).customSkills) === JSON.stringify(snap.customSkills));
}

// ==================== 八、坏存档不能把游戏搞挂 ====================
{
  clean();
  CONFIG.customSkills.broken = { id: 'broken', name: '坏技能', rules: [{ on: '瞎写的', do: [] }] };
  const r = CC.syncAll();
  T('坏存档：损坏的技能不注册，但如实报错', r.errors.length === 1 && !SkillLibrary.has('broken'));
  T('坏存档：报错信息带技能名，用户找得到是哪个', r.errors[0].includes('坏技能'));
  T('坏存档：不影响其它内容照常载入', (() => {
    CC.saveEffect({ id: 'ok_eff', name: '好状态', kind: 'stat', statKey: 'armor', flatValue: 3, duration: 2 });
    return CC.syncAll().effects === 1;
  })());
  clean();
}

// ==================== 九、原语表是 UI 的唯一来源 ====================
T('原语表已导出（UI 不该再抄一份清单）',
  Object.keys(TRIGGERS).length >= 4 && Object.keys(CONDITIONS).length >= 8 && Object.keys(ACTIONS).length >= 7);
T('每个动作都声明了字段（供 UI 生成表单）',
  Object.values(ACTIONS).every(a => Array.isArray(a.fields) && typeof a.fn === 'function'));
T('每个条件都声明了 arg 类型', Object.values(CONDITIONS).every(c => ['none', 'number', 'string'].includes(c.arg)));

// ==================== 十、自制兵种的外观不能是问号 ====================
// SpriteFactory 里 ram 那条注释记着：漏了一种兵，渲染就 fallback 到 { icon:'❓' }，
// 画板上一排问号。自制兵种天生不在 MINION_STYLE 表里，这个坑等着被踩第二次。
{
  clean();
  const { MINION_STYLE, minionStyle } = await import('../src/presentation/SpriteFactory.js');
  T('内置兵种仍走原样式表', minionStyle('melee') === MINION_STYLE.melee);
  CC.saveMinion({ id: 'frostling', name: '霜灵', icon: '❄️', color: '#7fd8ff',
                  stats: { maxHP: 400, attackDamage: 30 } });
  const st = minionStyle('frostling');
  T(`自制兵种取用户填的图标（${st.icon}）与颜色（${st.color}）`,
    st.icon === '❄️' && st.color === '#7fd8ff');
  T('自制兵种有可用的 size（否则渲染尺寸为 0 = 看不见）', st.size > 0);
  T('完全未知的类型也不返回问号（问号看着像 bug）',
    minionStyle('压根不存在的兵').icon !== '❓');
  T('各处不再直接下标访问 MINION_STYLE（统一走 minionStyle）', (() => {
    // v43 P0-①：CanvasRenderer.js（旧 2D 渲染器）已作为死代码删除，从清单里摘掉。
    // v43 P0-①：CanvasRenderer.js（旧 2D 渲染器）已作为死代码删除，从清单里摘掉。
    // SpriteFactory 不能进清单——MINION_STYLE 就定义在它里面，下标访问是它的本职。
    const files = ['src/presentation/UnitLayer.js', 'src/presentation/UnitInfo.js'];
    return files.every(f => !/MINION_STYLE\[/.test(fs.readFileSync(f, 'utf8')));
  })());
  // 自制兵种要能真的建出实体来（模板展开是否完整）
  const { EntityContainer: EC } = await import('../src/core/EntityContainer.js');
  const ents = new EC(new EventBus());
  const tpl = CONFIG.templates.frostling;
  const e = { id: 1, type: 'frostling', alive: true, pos: { x: 0, y: 0 },
              baseStats: { ...tpl }, currentHP: tpl.maxHP, _skillInstances: [] };
  ents.add(e);
  AttributeCalculator.tick();
  const s2 = AttributeCalculator.calc(e, []);
  T(`自制兵种能参与属性合成（生命 ${s2.maxHP} / 攻击 ${s2.attackDamage}）`,
    s2.maxHP === 400 && s2.attackDamage === 30);
  T('自制兵种继承了近战兵的其余字段（不会因缺字段而行为异常）',
    s2.moveSpeed > 0 && s2.attackRange > 0 && s2.baseAttackSpeed > 0);
}

clean();
// ---- 十一、onFrame 签名必须与引擎的调用约定一致 ----
// 这里直接读 CombatSystem 的源码核对调用顺序 —— 光靠"我的测试通过了"证明不了
// 签名是对的（本项目已经因此漏过一次：两边同错，全绿，运行时必崩）。
T('CombatSystem 以 (entityId, dt, inst, ctx) 调用 onFrame', (() => {
  const src2 = fs.readFileSync('src/systems/CombatSystem.js', 'utf8');
  return /def\.onFrame\(entity\.id,\s*dt,\s*inst,/.test(src2);
})());
T('behaviorVM 编译出的 onFrame 采用同一顺序', (() => {
  const src3 = fs.readFileSync('src/core/behaviorVM.js', 'utf8');
  return /def\.onFrame = \(selfId, dt, instance, ctx\)/.test(src3);
})());

console.log(`自制内容验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
