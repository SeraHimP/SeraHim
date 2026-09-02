// 无头仿真：加载召唤师峡谷 → 双方刷兵 → 行军 → 塔/兵交战，验证地图几何在真实系统下可玩
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };

const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { CombatSystem } = await import('../src/systems/CombatSystem.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { LaneWaveSystem } = await import('../src/systems/LaneWaveSystem.js');
const { LaneMovementSystem } = await import('../src/systems/LaneMovementSystem.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { CONFIG } = await import('../src/data/Config.js');
const { FACTIONS } = await import('../src/systems/FactionSystem.js');

const bus = new EventBus();
const ents = new EntityContainer(bus);
const fx = new EffectRegistry(bus);
const attr = AttributeCalculator;
const combat = new CombatSystem(ents, fx, bus, SkillLibrary);
const mapSys = new MapSystem(ents, bus);
const waveSys = new LaneWaveSystem(ents, bus, mapSys);
const moveSys = new LaneMovementSystem(ents, fx, attr, combat, mapSys);

function mkBuilding({ faction, tier, laneId, isNexus, pos, weapon, stats }) {
  const tpl = CONFIG.templates.tower, s = stats || {};
  const e = { id: ++window._uid, type: 'tower', alive: true, pos: { ...pos },
    baseStats: { ...tpl, maxHP: s.maxHP ?? tpl.maxHP, armor: s.armor ?? 0, magicResist: s.magicResist ?? 0,
      attackDamage: s.attackDamage ?? 0, baseAttackSpeed: s.baseAttackSpeed ?? 0, attackRange: tpl.attackRange },
    currentHP: 0, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _mapTier: tier, _laneId: laneId || null, faction };
  e.currentHP = e.baseStats.maxHP; ents.add(e);
  // v51.18：这个简化 stub 完全不装配技能/被动（加固城防、塔成长等都没有），
  // 但真实游戏里外塔靠"加固城防"技能（passive_outer_fortify）自带的开局限时双抗
  // 补足前期防御（v51.26：这条已经从地图级独立通路收进技能本身，见 towerPassives.js
  // _fortifyRecalc + summoners_rift.js 的 skillOverrides）——这个冒烟测试不接上的话，
  // 量出来的塔会比真实游戏里脆得多，"前期(240s)建筑无损"这条不变式在真实游戏里成立、
  // 在这里却会被误报成回归。这个 stub 本来就不装任何技能实例，跟下面的"钢铁防线"
  // 一样直接复刻效果本体（不经过 equipSkill/skillOverrides 解析那一层），数值跟
  // summoners_rift.js 里的覆写值（25/600）保持一致。
  if (tier === 'outer') {
    fx.apply(e.id, { name: '前期城防', icon: '🧱', kind: 'stat', statKey: 'armor', flatValue: 25,
      duration: 600, stackable: false, stackPolicy: 'refresh',
      description: '开局前10分钟：护甲+25' }, 'passive_outer_fortify_early_armor');
    fx.apply(e.id, { name: '前期城防', icon: '🧱', kind: 'stat', statKey: 'magicResist', flatValue: 25,
      duration: 600, stackable: false, stackPolicy: 'refresh',
      description: '开局前10分钟：魔法抗性+25' }, 'passive_outer_fortify_early_mr');
  }
  // v51.19：外塔在真实游戏里默认还装了"钢铁防线"（passive_iron_line：开局300秒
  // +33%伤害减免），这个 stub 同样从来没接过——加上 tierEffects 之后仍然偶发
  // 240s 内塔阵亡（约 1/5 概率），排查发现就是漏了这条：外塔本来就是靠双抗临时
  // 状态 + 钢铁防线两层一起扛过开局，只补一层还是不够。跟 tierEffects 一样直接
  // 复刻效果本体（不经过 equipSkill，省掉参数解析那一层，这个 stub 本来就不装
  // 任何技能实例）。
  if (tier === 'outer') {
    fx.apply(e.id, { name: '钢铁防线', icon: '🛡️', kind: 'stat', statKey: 'damageReduction', flatValue: 33,
      duration: 300, stackable: false, stackPolicy: 'refresh',
      description: '格挡33%即将到来的伤害（开局保护期）' }, 'passive_iron_line');
  }
  return e;
}
function mkMinion(type, x, y, faction, laneId, direction) {
  if (faction==='blue'&&laneId==='mid') spawnTimes.push(+window.gameTime.toFixed(2));
  const tpl = CONFIG.templates[type];
  const e = { id: ++window._uid, type, alive: true, pos: { x, y }, baseStats: { ...tpl },
    currentHP: tpl.maxHP, shieldFixedCurrent: 0, tempShield: 0, lastDamageTime: -Infinity, attackCooldown: 0,
    targetId: null, _skillInstances: [], _mapFaction: faction, _laneId: laneId, _laneDirection: direction, faction };
  const DEF={melee:['passive_melee_rend'],ranged:['passive_ranged_rend'],siege:['passive_artillery_commander','passive_siege_shield','passive_siege_rend'],super:['passive_super_commander']};
  for(const sk of DEF[type]||[]) e._skillInstances.push({id:++window._uid,skillId:sk,state:{}});
  ents.add(e); return e;
}
mapSys.setCreateBuildingFn(mkBuilding);
waveSys.setCreateMinion(mkMinion);
waveSys.waveInterval = 30; waveSys.nextWaveTime = 0.1;
const spawnTimes = [];

mapSys.loadMap();
const towers0 = ents.getAllTowers(true).length;
console.log('地图加载: 建筑数 =', towers0, '(期望 30)');

// 塔攻击逻辑在哪?检查 CombatSystem 是否处理塔索敌 —— 简化:手动让塔攻击范围内敌兵
const attrCalcTower = (t) => attr.calc(t, fx.getEffects(t.id));
function towersAttack(dt) {
  for (const t of ents.getAllTowers(true)) {
    if (!t.alive || !t._mapFaction || t.baseStats.attackDamage <= 0) continue;
    t.attackCooldown -= dt;
    if (t.attackCooldown > 0) continue;
    const st = attrCalcTower(t);
    const near = ents.findInRadius(t.pos.x, t.pos.y, st.attackRange, null, true)
      .filter(o => o.id !== t.id && o.alive && o._mapFaction && o._mapFaction !== t._mapFaction);
    if (near.length) { combat.performAttack(t, near[0]); t.attackCooldown = 1 / (st.baseAttackSpeed || 0.8); }
  }
}

const DT = 0.1;
let firstContact = null, firstTowerDamaged = null;
const t1blue = ents.getAllTowers(true).find(t => t._mapFaction === 'blue' && t._mapTier === 'outer' && t._laneId === 'mid');
for (let time = 0; time < 240; time += DT) {
  window.gameTime = time;
  waveSys.update(DT);
  moveSys.update(DT);
  for (const m of ents.getAllMinions(true)) for (const inst of m._skillInstances) {
    const d=SkillLibrary[inst.skillId]; if (d?.onFrame) d.onFrame(m.id,DT,inst,{entityContainer:ents,effectRegistry:fx,eventBus:bus,attrCalc:attr,combat,waveNumber:window.waveNumber});
  }
  fx.update?.(DT);
  towersAttack(DT);
  for (const m of ents.getAllMinions(true)) { m.attackCooldown -= DT; if (m.currentHP <= 0) m.alive = false; }
  for (const t of ents.getAllTowers(true)) { if (t.currentHP <= 0) t.alive = false; }
  ents.purgeDead?.();
  if (!firstContact) {
    const dead = window._uid; // proxy
    const minions = ents.getAllMinions(true);
    for (const m of minions) if (m.currentHP < m.baseStats.maxHP) { firstContact = time; break; }
  }
  if (!firstTowerDamaged && t1blue && t1blue.currentHP < t1blue.baseStats.maxHP) firstTowerDamaged = time;
}
const minions = ents.getAllMinions(true);
const spread = {};
for (const m of minions) { const k = m._mapFaction + '-' + m._laneId; spread[k] = (spread[k] || 0) + 1; }
console.log('240s 后存活小兵分布:', spread);
console.log('首次小兵受伤时间:', firstContact?.toFixed(1) + 's', '| 蓝中路外塔首次被打:', firstTowerDamaged ? firstTowerDamaged.toFixed(1) + 's' : '未被打(240s内)');
// 验证行军进度:取一个蓝方中路小兵,确认其路点索引在推进
const anyBlue = minions.find(m => m._mapFaction === 'blue' && m._laneId === 'mid');
console.log('样本蓝中路兵 路点索引:', anyBlue?._laneWaypointIndex, '/ 18, 位置:', anyBlue && `(${Math.round(anyBlue.pos.x)},${Math.round(anyBlue.pos.y)})`);
console.log('剩余建筑:', ents.getAllTowers(true).length);
console.log('蓝中路前8个出兵时刻(验证单列生成):', spawnTimes.slice(0,8).join(', '));

// ==================== 断言（技术债清偿） ====================
let fails=0;const A=(n,c)=>{if(!c){fails++;console.log('✗',n);}};
A('前期(240s)建筑无损=30', ents.getAllTowers(true).length===30);
A('双方兵线接敌(有小兵受伤)', firstContact!==null && firstContact<120);
A('单列出兵间隔≈0.55s', spawnTimes.length>=5 && Math.abs((spawnTimes[1]-spawnTimes[0])-0.55)<0.1);
A('样本兵存活且在路走廊内', anyBlue && anyBlue.alive && anyBlue.pos.x > 0 && anyBlue.pos.y > 0);
console.log(fails?`❌ 全栈冒烟 ${fails} 项失败`:'✅ 全栈冒烟全部通过');
process.exit(fails?1:0);
