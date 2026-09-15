/**
 * NeutralCampSystem.js —— 中立阵营通用骨架（用户定稿："以后要支持中立野怪阵营
 * 泛化，巨龙只是其中一种：出生地、出生路径、出生条件都要能在地图编辑器里配"）
 *
 * ==================== 为什么是纯函数模块，不是一个带 update() 的类 ====================
 * 跟 FactionSystem.js 同一个理由：这里要泛化的是"一张地图声明了哪些中立营地、
 * 每个营地在哪/走哪条路"这件**数据**，不是每帧要跑的逻辑——真正的生成节奏/属性
 * 成长/被击杀奖励，巨龙已经有一整套很深的机制（元素轮换/远古龙/龙魂/杀数成长，
 * 见 DragonSystem.js），这些不是"中立营地"这个概念该泛化的东西，勉强抽象成
 * 一套通用引擎反而会把巨龙这套已经打磨好的机制拆坏。这个文件只管"这个营地在
 * 地图上的哪个位置、出生之后走哪条路、往哪个方向"——纯查询，没有状态、没有
 * 每帧驱动，配 FactionSystem.js 同款的纯函数风格。
 *
 * ==================== 现状：只有巨龙一种中立单位 ====================
 * 全仓库搜过，"Baron 坑"（map.pits.baron）一直只是一个坐标，从来没有一个真正
 * 叫 baron 的可生成单位——中立单位目前只有巨龙这一种实现。这个文件把巨龙的
 * 出生位置/路径选择这部分**数据**接进新的 map.neutralCamps 骨架，巨龙自己的
 * 生成节奏（DragonSystem.update() 的计时器/元素轮换）完全不动——它只是改成向
 * 这个文件查"出生点在哪"，不再自己内联算 pitSide/getPit。
 *
 * campTriggerDue() 是为"以后真的出现第二种中立单位"准备的通用触发判定
 * （首次延迟区间 + 周期区间 + 可选条件），巨龙不用它（巨龙自己的计时器更复杂，
 * 元素/远古交替、龙魂阈值这些语义硬套进一个通用触发器只会丢精度）——现在没有
 * 第二种中立单位去验证它，所以只用纯函数测试钉住行为，不接进任何真实系统。
 */
import { whenPasses } from '../data/waveComposition.js';

/**
 * 一张地图声明的中立营地列表。未声明 map.neutralCamps 时，按"巨龙从 baron/dragon
 * 两个坑交替出生"这条既有行为合成一份等价的默认值——现有三张内置地图完全不用改
 * 一个字，行为逐位不变（对应改造前 factories.js createDragon 里那段写死的
 * pitSide/getPit 逻辑）。
 * @param {object} map
 * @returns {Array<{id:string, unitType:string, label?:string, spawnPoints:Array<{pit?:{x,y,r?,depth?}, pitRef?:string, laneMatch:string, direction:string}>, trigger?:object}>}
 */
export function neutralCampsOf(map) {
  if (Array.isArray(map?.neutralCamps)) return map.neutralCamps;
  return [{
    id: 'dragon', unitType: 'dragon', label: '巨龙',
    spawnPoints: [
      { pitRef: 'baron', laneMatch: 'top', direction: 'reverse' },
      { pitRef: 'dragon', laneMatch: 'bot', direction: 'forward' },
    ],
  }];
}

/**
 * 解析某个中立单位类型在当前地图上的全部出生点——已经把 pitRef 换算成真实坐标
 * （走 mapSystem.getPit()，保留"CONFIG 覆写优先于 map.pits"的既定顺序，唯一实现
 * 不重复），把 laneMatch 换算成真实存在的路 id（同名优先，否则退 mid，否则退
 * 唯一/第一条路——与改造前 factories.js 的路选择逻辑逐位一致）；没有坐标可用时
 * （地图没声明这个坑）退到该路的路点中点，同样与改造前逐位一致。
 * @param {object} map
 * @param {{getPit:(name:string)=>({x,y,r?,depth?}|null)}} mapSystem
 * @param {string} unitType
 * @returns {Array<{pit:{x,y}|null, laneId:string|null, direction:string}>}
 */
export function campSpawnPoints(map, mapSystem, unitType) {
  const camp = neutralCampsOf(map).find(c => c.unitType === unitType);
  if (!camp) return [];
  const lanes = map?.lanes || [];
  return (camp.spawnPoints || []).map((sp) => {
    const laneId = lanes.some(l => l.id === sp.laneMatch) ? sp.laneMatch
      : (lanes.find(l => l.id === 'mid') ? 'mid' : (lanes[0] && lanes[0].id));
    const lane = lanes.find(l => l.id === laneId);
    let pit = sp.pit || (sp.pitRef ? mapSystem?.getPit?.(sp.pitRef) : null);
    if (!pit && lane && lane.waypoints?.length) {
      const mid = lane.waypoints[Math.floor(lane.waypoints.length / 2)];
      pit = { x: mid.x, y: mid.y };
    }
    return { pit: pit || null, laneId: lane ? lane.id : null, direction: sp.direction || 'forward' };
  });
}

/**
 * 通用触发判定（骨架，巨龙不用）：首次延迟区间→周期区间→可选条件，全部命中
 * 才算"这一次该刷"。跟出兵编排的 WAVE_CONDITIONS 复用同一套条件表/判定函数
 * （whenPasses），不新造一套条件系统——分阶段光环（第四节另一项）也复用它，
 * 三处共用同一份条件语义，不会出现"这里的条件和那里的条件长得像但判法不一样"。
 * @param {{firstDelaySec?:number, intervalSec?:number, when?:string, whenArg?:number}} trigger
 * @param {number} elapsedSec 距离"上一次刷新（或对局开始，如果还没刷过）"过了多久
 * @param {boolean} hasSpawnedBefore 这个营地对局里是不是已经刷过至少一次
 * @param {object} [ctx] 传给 whenPasses 的条件判定快照
 * @returns {boolean}
 */
export function campTriggerDue(trigger, elapsedSec, hasSpawnedBefore, ctx) {
  if (!trigger) return false;
  const threshold = hasSpawnedBefore ? (trigger.intervalSec ?? Infinity) : (trigger.firstDelaySec ?? 0);
  if (elapsedSec < threshold) return false;
  if (trigger.when && !whenPasses({ when: trigger.when, whenArg: trigger.whenArg }, ctx)) return false;
  return true;
}

/**
 * 已经接了真正生成器（spawner）的中立单位类型——目前只有巨龙。地图编辑器的
 * "新增营地"用它做单位类型下拉框的唯一来源，不会在界面上让用户选一个还没有
 * 任何生成逻辑的类型（选了也不会真的刷出东西，是个死胡同）。以后接入新的
 * 中立单位（比如某种野怪）时，只需要在这里加一条，编辑器自动跟着多一个选项，
 * 不用去改编辑器代码本身。
 */
export const NEUTRAL_UNIT_TYPES = {
  dragon: { label: '巨龙' },
};
