/**
 * dominionSites.js —— 统治战场各据点的场景物 / 旗摆在哪（纯数据，不依赖 three，无头测试可直接跑）。
 * 画面（world/WorldDominion.js）按这里的位置建模型；地形高度场（terrainField.js）按这里的位置把场景物脚下的地垫平；
 * 崖线上的岩块（world/WorldRocks.js）给场景物让位。三处读的是同一份数据，所以对得上。
 * 参数在 CONFIG.terrain.dominion。
 */
import { CONFIG } from './Config.js';

const cfg = () => CONFIG.terrain?.dominion || {};
/** 有专属场景物的据点 id（造型在 WorldDominion.SCENES；商栈 / 望塔沿用了历史 id blue_base / red_base）。 */
export const SCENE_IDS = ['windmill', 'drill', 'refinery', 'boneyard', 'quarry', 'blue_base', 'red_base'];

/**
 * 每个据点的场景物 / 旗摆在哪（纯数据，无头测试可直接跑）。
 * 场景物沿"背离地图中心"的方向推出去 propOffset，落在据点周围那圈空地的外沿、躲开环形走廊；旗贴着据点。
 * @returns { points: [{ id, name, x, y, ax, ay, px, py, fx, fy, scene }], nexus: [{ faction, x, y, flags: [[x, y], [x, y]] }] }
 */
export function dominionSites(map) {
  const D = cfg(), W = map.world, cx = W.w / 2, cy = W.h / 2;
  const points = [], nexus = [];
  for (const n of (map.dominionNodes || [])) {
    const dx = n.pos.x - cx, dy = n.pos.y - cy, l = Math.hypot(dx, dy) || 1, ax = dx / l, ay = dy / l;
    if (n.kind === 'point') {
      points.push({ id: n.id, name: n.name, x: n.pos.x, y: n.pos.y, ax, ay,
        px: n.pos.x + ax * (D.propOffset ?? 185), py: n.pos.y + ay * (D.propOffset ?? 185),
        // 旗在据点朝外偏左一点：不压着据点的塔，也不挡场景物
        fx: n.pos.x + ax * (D.flagOffset ?? 62) - ay * (D.flagSide ?? 58), fy: n.pos.y + ay * (D.flagOffset ?? 62) + ax * (D.flagSide ?? 58),
        scene: SCENE_IDS.includes(n.id) ? n.id : null });
    } else if (n.kind === 'nexus') {
      const s = D.nexusFlagSide ?? 96;
      nexus.push({ faction: n.faction?.id || n.faction, x: n.pos.x, y: n.pos.y, flags: [[n.pos.x - ay * s, n.pos.y + ax * s], [n.pos.x + ay * s, n.pos.y - ax * s]] });
    }
  }
  return { points, nexus };
}

/** 场景物占的地方（崖线上的岩块要让开）：[{ x, y, r }] */
export function dominionKeepOut(map) {
  if (!Array.isArray(map?.dominionNodes)) return [];
  const D = cfg(), r = (D.propClear ?? 62) * (D.propScale ?? 1);
  return dominionSites(map).points.filter((s) => s.scene).map((s) => ({ x: s.px, y: s.py, r }));
}

