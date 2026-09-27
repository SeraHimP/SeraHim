// 地图列表与地图拼装的防呆：隐藏图不进选图列表；composeMap 遇到未登记字段直接报错。
import { setupWindow, scoreboard } from './_harness.mjs';

setupWindow({ waveNumber: 1 });
const { T, done } = scoreboard('地图列表 / composeMap 防呆');

const { MAPS } = await import('../src/data/maps/index.js');
const { MapSystem } = await import('../src/systems/MapSystem.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
const { composeMap } = await import('../src/data/mapComposition.js');

{
  const ms = new MapSystem(new EntityContainer(new EventBus()), new EventBus());
  const listed = ms.getAvailableMaps().map(m => m.id);
  const hidden = Object.values(MAPS).filter(m => m.hiddenFromPicker).map(m => m.id);
  T('①至少有一张图被标成隐藏', hidden.length > 0);
  T('②隐藏图一张都不在选图列表里', hidden.every(id => !listed.includes(id)));
  T('③没被隐藏的普通地图都在列表里（统治战场专属图除外，它从"选择模式"进）',
    Object.values(MAPS).filter(m => !m.hiddenFromPicker && !m.dominionNodes).every(m => listed.includes(m.id)));
  T('④隐藏图仍能按 id 加载（代码与测试保留）', hidden.every(id => ms.getMapById(id) === MAPS[id]));
  T('⑤旧版嚎哭深渊已删除', !('howling_abyss_v1' in MAPS));
}

{
  const terrain = { world: { w: 100, h: 100 } };
  let err = null;
  try { composeMap({ terrain, config: { id: 't', lanes: [], notARealField: 1 } }); } catch (e) { err = e; }
  T('⑥config 里有未登记字段 → 抛错，而且报出字段名', !!err && /notARealField/.test(err.message));
  err = null;
  try { composeMap({ terrain: { ...terrain, lanes: [] }, config: { id: 't' } }); } catch (e) { err = e; }
  T('⑦玩法字段放错到 terrain 里 → 同样抛错', !!err && /terrain\.lanes/.test(err.message));
  const ok = composeMap({ terrain, config: { id: 't', label: 'x', lanes: [], hiddenFromPicker: true } });
  T('⑧合法字段照常拼出来', ok.id === 't' && ok.label === 'x' && ok.world.w === 100 && ok.hiddenFromPicker === true);
}

done();
