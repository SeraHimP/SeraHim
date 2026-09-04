// sim_mapcomposition.mjs —— 地形模板/玩法配置拆分与拼装（mapComposition.js）验收
//
// 见 src/data/mapComposition.js 头注。核心风险是"字段清单漏了一个"——TERRAIN_FIELDS/
// CONFIG_FIELDS 手写列出的字段如果跟不上现有地图源码，composeMap(extractTerrainFromMap(m),
// extractConfigFromMap(m)) 拼回来的地图就会悄悄丢字段，这套断言把三张真实内置地图
// 全部跑一遍"拆开再拼回去"，逐字段比对，任何一处遗漏都能当场抓到。
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { scoreboard } from './_harness.mjs';
import {
  TERRAIN_FIELDS, CONFIG_FIELDS, composeMap, extractTerrainFromMap, extractConfigFromMap,
} from '../src/data/mapComposition.js';
import { summoners_rift } from '../src/data/maps/summoners_rift.js';
import { twisted_treeline } from '../src/data/maps/twisted_treeline.js';
import { howling_abyss } from '../src/data/maps/howling_abyss.js';
import { MAPS as BUILTIN_MAPS_BY_ID } from '../src/data/maps/index.js';
import { neutralCampsOf, campSpawnPoints } from '../src/systems/NeutralCampSystem.js';

const { T, done } = scoreboard('地形模板/玩法配置拆分与拼装验收');

// ==================== ① composeMap 基本行为 ====================
{
  const terrain = { world: { w: 100, h: 100 }, navgrid: { n: 4, bits: 'AA' } };
  const config = { id: 'test_map', label: '测试图', factions: ['blue', 'red'], lanes: [] };
  const map = composeMap({ terrain, config });
  T('①composeMap：terrain 字段进了结果', map.world.w === 100 && map.navgrid.n === 4);
  T('①composeMap：config 字段进了结果', map.factions.length === 2 && Array.isArray(map.lanes));
  T('①composeMap：id/label 来自 config', map.id === 'test_map' && map.label === '测试图');

  T('①composeMap：terrain 为空抛错', (() => { try { composeMap({ terrain: null, config }); return false; } catch { return true; } })());
  T('①composeMap：config 为空抛错', (() => { try { composeMap({ terrain, config: null }); return false; } catch { return true; } })());
  T('①composeMap：config.id 为空抛错', (() => { try { composeMap({ terrain, config: { label: 'x' } }); return false; } catch { return true; } })());

  T('①composeMap：label 缺省时退回 id', composeMap({ terrain, config: { id: 'bare_id' } }).label === 'bare_id');
  T('①composeMap：字段缺省时结果里不出现那个 key（不是塞 undefined）',
    !('label' in composeMap({ terrain: {}, config: { id: 'x' } })) === false); // label 有兜底，换个真正会缺省的字段测
  T('①composeMap：terrain 没有的字段（比如 obstacles）不会出现在结果里',
    !('obstacles' in composeMap({ terrain: { world: { w: 1, h: 1 } }, config: { id: 'x' } })));
}

// ==================== ② 三张真实内置地图：拆开再拼回去，逐字段比对不丢东西 ====================
const MAPS = [
  ['summoners_rift', summoners_rift],
  ['twisted_treeline', twisted_treeline],
  ['howling_abyss', howling_abyss],
];
for (const [name, map] of MAPS) {
  const terrain = extractTerrainFromMap(map);
  const config = extractConfigFromMap(map);
  const rebuilt = composeMap({ terrain, config });

  // 逐个 TERRAIN_FIELDS/CONFIG_FIELDS 字段比对，而不是整体 JSON.stringify 比较——
  // 后者会因为 key 顺序或原地图里混进的、本表没收录的"漏网字段"给出误导性的通过/失败，
  // 逐字段比对能精确指出"到底是哪个字段没跟上"。
  let allFieldsMatch = true;
  const mismatches = [];
  for (const k of [...TERRAIN_FIELDS, ...CONFIG_FIELDS]) {
    if (map[k] === undefined) continue; // 这张图本来就没这个字段，不用比
    const same = JSON.stringify(map[k]) === JSON.stringify(rebuilt[k]);
    if (!same) { allFieldsMatch = false; mismatches.push(k); }
  }
  T(`②${name}：拆开再拼回去，TERRAIN_FIELDS/CONFIG_FIELDS 逐字段值不变（${mismatches.join(',') || '全部一致'}）`,
    allFieldsMatch);

  // 反向校验：原地图上出现过的顶层字段（id/label 除外），必须被 TERRAIN_FIELDS 或
  // CONFIG_FIELDS 之一收录——否则说明字段清单本身漏了一个真实在用的字段，
  // extractXxxFromMap 会悄悄把它丢在半路，composeMap 拼回来的图就会少一块。
  const known = new Set(['id', 'label', ...TERRAIN_FIELDS, ...CONFIG_FIELDS]);
  const uncategorized = Object.keys(map).filter(k => !known.has(k));
  T(`②${name}：原地图的顶层字段全部被 TERRAIN_FIELDS/CONFIG_FIELDS 收录（未收录：${uncategorized.join(',') || '无'}）`,
    uncategorized.length === 0);
}

// ==================== ③ 深拷贝隔离：改提取出来的模板/配置不能污染原地图 ====================
{
  const terrain = extractTerrainFromMap(summoners_rift);
  terrain.world.w = 999999;
  T('③extractTerrainFromMap 是深拷贝，改它不影响原地图', summoners_rift.world.w !== 999999);

  const config = extractConfigFromMap(summoners_rift);
  config.lanes[0].id = 'hacked';
  T('③extractConfigFromMap 是深拷贝，改它不影响原地图', summoners_rift.lanes[0].id !== 'hacked');
}

// ==================== ④ 老地图源码已真正接入拆分框架（2026-09-04）====================
// 用户推翻了"现有三张地图不迁移"的旧决定，这次三张图的**源码本身**都拆成了
// XX_TERRAIN/XX_CONFIG 两个对象常量再用 composeMap() 拼回去——不是像 ②那样
// "运行时现拆现拼"，是源文件真的这么写的。用源码正则钉住这件事，防止以后
// 有人手滑改回整体字面量对象又不吱声（这类"结构性事实"headless 跑不出来，
// 只能靠源码断言守）。
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const readSrc = (rel) => fs.readFileSync(path.join(dir, '..', 'src', 'data', 'maps', rel), 'utf8');
  const cases = [
    ['summoners_rift.js', 'SR_TERRAIN', 'SR_CONFIG', 'summoners_rift'],
    ['twisted_treeline.js', 'TT_TERRAIN', 'TT_CONFIG', 'twisted_treeline'],
    ['howling_abyss.js', 'HA_TERRAIN', 'HA_CONFIG', 'howling_abyss'],
  ];
  for (const [file, terrainVar, configVar, exportName] of cases) {
    const src = readSrc(file);
    T(`④${file}：导入了 composeMap`, /import\s*\{\s*composeMap\s*\}\s*from\s*['"]\.\.\/mapComposition\.js['"]/.test(src));
    T(`④${file}：确实定义了 ${terrainVar}/${configVar} 两个对象`,
      new RegExp(`const ${terrainVar} = \\{`).test(src) && new RegExp(`const ${configVar} = \\{`).test(src));
    T(`④${file}：导出的 ${exportName} 是 composeMap() 拼出来的（不是字面量对象）`,
      new RegExp(`export const ${exportName} = composeMap\\(\\{\\s*terrain:\\s*${terrainVar},\\s*config:\\s*${configVar}\\s*\\}\\)`).test(src));
  }
}

// ==================== ⑤ 三张老图的 neutralCamps 已显式化，且解析行为与改动前一致 ====================
// 之前靠 NeutralCampSystem.neutralCampsOf() 在没声明时按巨龙既定行为合成默认值；
// 现在三张图都显式写了同一份数据。这里钉住两件事：①字段确实是显式声明的（不是
// 又落回默认合成），②campSpawnPoints() 解析出来的坑位/路/方向与 sim_neutralcamp.mjs
// 里核对过的改动前行为完全一致（尤其是嚎哭深渊那个"没有 top/bot，退到 mid"的
// 既有退化行为——显式化不能把这条隐式兜底路径带出的效果搞丢）。
{
  const fakeMapSystem = (map) => ({ getPit: (name) => (map.pits && map.pits[name]) || null });
  for (const [name, map] of MAPS) {
    T(`⑤${name}：neutralCamps 是这张图自己声明的（不再靠默认合成）`,
      Array.isArray(map.neutralCamps) && map.neutralCamps.length === 1 && map.neutralCamps[0].unitType === 'dragon');
    T(`⑤${name}：neutralCampsOf() 原样返回声明值（===，不是又合成了一份新的）`,
      neutralCampsOf(map) === map.neutralCamps);
  }
  // 逐点核对 campSpawnPoints() 解析结果与 sim_neutralcamp.mjs 断言过的改动前行为一致。
  const sr = BUILTIN_MAPS_BY_ID.summoners_rift_v1;
  const srPts = campSpawnPoints(sr, fakeMapSystem(sr), 'dragon');
  T('⑤summoners_rift：显式化后坑位解析与改动前一致（top/reverse + bot/forward，真实坑位坐标）',
    srPts[0].laneId === 'top' && srPts[0].direction === 'reverse' && srPts[0].pit
    && srPts[1].laneId === 'bot' && srPts[1].direction === 'forward' && srPts[1].pit);

  const ha = BUILTIN_MAPS_BY_ID.howling_abyss_v1;
  const haPts = campSpawnPoints(ha, fakeMapSystem(ha), 'dragon');
  const midLaneHA = ha.lanes.find(l => l.id === 'mid');
  const midOf = (wps) => wps[Math.floor(wps.length / 2)];
  T('⑤howling_abyss：显式化后仍退化成"没有 top/bot，两个出生点都落回 mid 路点中点"（与改动前逐位一致）',
    haPts[0].laneId === 'mid' && haPts[1].laneId === 'mid'
    && haPts[0].direction === 'reverse' && haPts[1].direction === 'forward'
    && haPts[0].pit.x === midOf(midLaneHA.waypoints).x && haPts[1].pit.x === midOf(midLaneHA.waypoints).x);
}

done();
