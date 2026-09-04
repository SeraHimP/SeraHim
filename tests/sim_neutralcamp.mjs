/**
 * sim_neutralcamp.mjs —— 中立阵营通用骨架验收（第四节 Part D）
 *
 * 见 src/systems/NeutralCampSystem.js 头注。这次改动把巨龙的坑位/路/方向这份
 * "在哪出生、走哪条路"的数据，从 factories.js createDragon 里一段内联的
 * pitSide/getPit 判定，搬进了一个以后新中立单位也能复用的纯函数模块——
 * 判定逻辑一处没改，只是挪了地方。CLAUDE.md 的铁律是"参数化前后必须逐位一致"，
 * 这里的重点断言就是"巨龙的出生行为在改造前后完全不变"，覆盖三张真实内置地图
 * （召唤师峡谷有龙坑、扭曲丛林/嚎哭深渊都没有）。
 */
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow({ waveNumber: 1 });

const { neutralCampsOf, campSpawnPoints, campTriggerDue, NEUTRAL_UNIT_TYPES } = await import('../src/systems/NeutralCampSystem.js');
const {
  cloneNeutralCampsForEdit, withCampSpawnPointFieldSet, withCampSpawnPointAdded, withCampSpawnPointRemoved,
  buildCustomMapPayload, decodeBaseBits,
} = await import('../src/data/mapEditorCore.js');
const { MAPS } = await import('../src/data/maps/index.js');
const { SR_PITS } = await import('../src/data/maps/sr_navgrid.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { EffectRegistry } = await import('../src/core/EffectRegistry.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const { AttributeCalculator } = await import('../src/core/AttributeCalculator.js');
const { DragonSystem } = await import('../src/systems/DragonSystem.js');
const { createFactories } = await import('../src/core/factories.js');

const { T, done } = scoreboard('中立阵营通用骨架验收');

// ==================== ① neutralCampsOf：没声明时按巨龙既定行为合成默认值 ====================
{
  const camps = neutralCampsOf({});
  T('①-没声明 map.neutralCamps 时合成一个巨龙营地', camps.length === 1 && camps[0].unitType === 'dragon');
  T('①b-默认营地两个出生点：baron/top/reverse + dragon/bot/forward',
    camps[0].spawnPoints[0].pitRef === 'baron' && camps[0].spawnPoints[0].laneMatch === 'top' && camps[0].spawnPoints[0].direction === 'reverse'
    && camps[0].spawnPoints[1].pitRef === 'dragon' && camps[0].spawnPoints[1].laneMatch === 'bot' && camps[0].spawnPoints[1].direction === 'forward');

  const declared = [{ id: 'x', unitType: 'wolf', spawnPoints: [] }];
  T('①c-声明了 map.neutralCamps 就原样用它（不再合成默认值）',
    neutralCampsOf({ neutralCamps: declared }) === declared);
}

// ==================== ② campSpawnPoints：三张真实地图上的行为核对 ====================
// 用一个只实现 getPit() 的轻量 mapSystem 桩，跟真实 MapSystem.getPit 同一套
// "CONFIG覆写→map.pits→null"顺序（这里没有 CONFIG 覆写，直接读 map.pits）。
function fakeMapSystem(map) {
  return { getPit: (name) => (map.pits && map.pits[name]) || null };
}
{
  const sr = MAPS.summoners_rift_v1;
  const ms = fakeMapSystem(sr);
  const pts = campSpawnPoints(sr, ms, 'dragon');
  T('②-召唤师峡谷：上坑(baron位)推蓝方(reverse)，走 top 路',
    pts[0].laneId === 'top' && pts[0].direction === 'reverse'
    && pts[0].pit.x === SR_PITS.baron.x && pts[0].pit.y === SR_PITS.baron.y);
  T('②b-召唤师峡谷：下坑(dragon位)推红方(forward)，走 bot 路',
    pts[1].laneId === 'bot' && pts[1].direction === 'forward'
    && pts[1].pit.x === SR_PITS.dragon.x && pts[1].pit.y === SR_PITS.dragon.y);

  const tt = MAPS.twisted_treeline_v1;
  const msT = fakeMapSystem(tt);
  const ptsT = campSpawnPoints(tt, msT, 'dragon');
  const topLaneTT = tt.lanes.find(l => l.id === 'top');
  const botLaneTT = tt.lanes.find(l => l.id === 'bot');
  const midOf = (wps) => wps[Math.floor(wps.length / 2)];
  T('③-扭曲丛林：没声明坑，退到 top/bot 各自兵线的路点中点',
    ptsT[0].laneId === 'top' && ptsT[0].pit.x === midOf(topLaneTT.waypoints).x && ptsT[0].pit.y === midOf(topLaneTT.waypoints).y
    && ptsT[1].laneId === 'bot' && ptsT[1].pit.x === midOf(botLaneTT.waypoints).x && ptsT[1].pit.y === midOf(botLaneTT.waypoints).y);

  const ha = MAPS.howling_abyss_v1;
  const msH = fakeMapSystem(ha);
  const ptsH = campSpawnPoints(ha, msH, 'dragon');
  const midLaneHA = ha.lanes.find(l => l.id === 'mid');
  T('④-嚎哭深渊：只有 mid 路，top/bot 都退到 mid（两个出生点方向不同，位置相同——与改造前逐位一致的既有行为）',
    ptsH[0].laneId === 'mid' && ptsH[1].laneId === 'mid'
    && ptsH[0].direction === 'reverse' && ptsH[1].direction === 'forward'
    && ptsH[0].pit.x === midOf(midLaneHA.waypoints).x && ptsH[1].pit.x === midOf(midLaneHA.waypoints).x);

  T('⑤-不认识的 unitType 返回空数组', campSpawnPoints(sr, ms, 'baron').length === 0);
}

// ==================== ⑥ campTriggerDue：骨架用的通用触发判定（巨龙不用，留给未来） ====================
{
  T('⑥-没到首次延迟不触发', campTriggerDue({ firstDelaySec: 100 }, 50, false) === false);
  T('⑦-到了首次延迟就触发', campTriggerDue({ firstDelaySec: 100 }, 100, false) === true);
  T('⑧-已经刷过一次后，看的是周期而不是首次延迟', campTriggerDue({ firstDelaySec: 100, intervalSec: 30 }, 40, true) === true);
  T('⑨-已经刷过一次但还没到周期', campTriggerDue({ firstDelaySec: 100, intervalSec: 30 }, 10, true) === false);
  T('⑩-带条件：条件不过就算到时间也不触发', campTriggerDue(
    { firstDelaySec: 0, when: 'time.after', whenArg: 600 }, 0, false, { gameTime: 100 }) === false);
  T('⑪-带条件：条件过了且到时间就触发', campTriggerDue(
    { firstDelaySec: 0, when: 'time.after', whenArg: 600 }, 0, false, { gameTime: 700 }) === true);
  T('⑫-没有 trigger 配置永远不触发（不是"永远触发"，避免误配出一个刷不停的骨架营地）',
    campTriggerDue(null, 99999, false) === false);
}

// ==================== ⑬ 端到端：真实 createDragon 在三张地图上的出生位置逐位一致 ====================
function dragonWorld(mapId) {
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const fx = new EffectRegistry(bus);
  const ds = new DragonSystem(ents, bus, fx, SkillLibrary, AttributeCalculator);
  const mapSystem = new MapSystem(ents, bus);
  mapSystem.loadMap(mapId);
  const F = createFactories({
    entityContainer: ents, effectRegistry: fx, eventBus: bus,
    skillLibrary: SkillLibrary, attrCalc: AttributeCalculator,
    mapSystem, dragonSystem: ds, uiManager: { log() {} },
  });
  ds.createEntity = (t, o) => F.createDragon(t, o);
  return { F };
}
{
  const { F } = dragonWorld('summoners_rift_v1');
  const dTop = F.createDragon('dragon', { element: 'earth', absStats: { maxHP: 100, armor: 0, magicResist: 0, attackDamage: 1 }, pitSide: 'top' });
  T('⑬-召唤师峡谷：pitSide=top 出生在 baron 坑位置，走 top 路，方向 reverse',
    dTop.pos.x === SR_PITS.baron.x && dTop.pos.y === SR_PITS.baron.y
    && dTop._laneId === 'top' && dTop._laneDirection === 'reverse');
  const dBot = F.createDragon('dragon', { element: 'earth', absStats: { maxHP: 100, armor: 0, magicResist: 0, attackDamage: 1 }, pitSide: 'bot' });
  T('⑭-召唤师峡谷：pitSide=bot 出生在 dragon 坑位置，走 bot 路，方向 forward',
    dBot.pos.x === SR_PITS.dragon.x && dBot.pos.y === SR_PITS.dragon.y
    && dBot._laneId === 'bot' && dBot._laneDirection === 'forward');
}
{
  const { F } = dragonWorld('howling_abyss_v1');
  const ha = MAPS.howling_abyss_v1;
  const midLaneHA = ha.lanes.find(l => l.id === 'mid');
  const mid = midLaneHA.waypoints[Math.floor(midLaneHA.waypoints.length / 2)];
  const dTop = F.createDragon('dragon', { element: 'earth', absStats: { maxHP: 100, armor: 0, magicResist: 0, attackDamage: 1 }, pitSide: 'top' });
  T('⑮-嚎哭深渊：pitSide=top 退到唯一的 mid 路，出生在路点中点，方向 reverse',
    dTop.pos.x === mid.x && dTop.pos.y === mid.y && dTop._laneId === 'mid' && dTop._laneDirection === 'reverse');
}

// ==================== ⑯ NEUTRAL_UNIT_TYPES：编辑器"单位类型"下拉框唯一来源 ====================
{
  T('⑯-NEUTRAL_UNIT_TYPES 目前只有巨龙（唯一接了真正生成器的中立单位）',
    Object.keys(NEUTRAL_UNIT_TYPES).length === 1 && NEUTRAL_UNIT_TYPES.dragon?.label === '巨龙');
}

// ==================== ⑰ mapEditorCore.js：中立营地编辑纯函数 ====================
{
  const camps = cloneNeutralCampsForEdit(MAPS.summoners_rift_v1);
  T('⑰-cloneNeutralCampsForEdit 从真实地图克隆出巨龙营地草稿', camps.length === 1 && camps[0].id === 'dragon');

  const moved = withCampSpawnPointFieldSet(camps, 'dragon', 0, 'x', 999);
  T('⑱-withCampSpawnPointFieldSet 改 x 坐标，不修改输入数组', moved[0].spawnPoints[0].pit.x === 999 && camps[0].spawnPoints[0].pitRef === 'baron');
  T('⑲-手动改过坐标后 pitRef 被摘掉（不然下次解析又被 pitRef 指向的坐标顶回去）',
    moved[0].spawnPoints[0].pitRef === undefined);
  const movedY = withCampSpawnPointFieldSet(moved, 'dragon', 0, 'y', 888);
  T('⑳-连续改 x 再改 y，两个坐标都保留（不是每次只留最后改的那个字段）',
    movedY[0].spawnPoints[0].pit.x === 999 && movedY[0].spawnPoints[0].pit.y === 888);

  const laneChanged = withCampSpawnPointFieldSet(camps, 'dragon', 0, 'laneMatch', 'bot');
  T('21-withCampSpawnPointFieldSet 也能改非坐标字段（laneMatch/direction），不摘 pitRef',
    laneChanged[0].spawnPoints[0].laneMatch === 'bot' && laneChanged[0].spawnPoints[0].pitRef === 'baron');

  const added = withCampSpawnPointAdded(camps, 'dragon', { pit: { x: 1, y: 2 }, laneMatch: 'mid', direction: 'forward' });
  T('22-withCampSpawnPointAdded 追加出生点，不修改输入数组', added[0].spawnPoints.length === 3 && camps[0].spawnPoints.length === 2);

  const removed = withCampSpawnPointRemoved(added, 'dragon', 2);
  T('23-withCampSpawnPointRemoved 删掉指定下标，不修改输入数组', removed[0].spawnPoints.length === 2 && added[0].spawnPoints.length === 3);

  let threw = false;
  const singlePoint = [{ id: 'dragon', unitType: 'dragon', spawnPoints: [{ pitRef: 'baron', laneMatch: 'top', direction: 'reverse' }] }];
  try { withCampSpawnPointRemoved(singlePoint, 'dragon', 0); } catch { threw = true; }
  T('24-withCampSpawnPointRemoved 拒绝删到零个出生点', threw);

  const { n: n0, bits: bits0 } = decodeBaseBits(MAPS.summoners_rift_v1);
  const p1 = buildCustomMapPayload(MAPS.summoners_rift_v1, { id: 'nc1', label: 'nc1', n: n0, bits: bits0 });
  T('25-buildCustomMapPayload 不传 neutralCamps 时不写这个字段', p1.neutralCamps === undefined);
  const p2 = buildCustomMapPayload(MAPS.summoners_rift_v1, { id: 'nc2', label: 'nc2', n: n0, bits: bits0, neutralCamps: removed });
  T('26-buildCustomMapPayload 传了就整体写入', JSON.stringify(p2.neutralCamps) === JSON.stringify(removed));
}

done();
