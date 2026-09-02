import { summoners_rift } from './summoners_rift.js';
import { howling_abyss } from './howling_abyss.js';
import { twisted_treeline } from './twisted_treeline.js';

/**
 * maps/index.js
 * 地图注册表：所有可用地图集中登记于此。
 * 以后新增地图：写好 mapXxx.js（参照 summoners_rift.js 的结构，必须声明 world: {w,h}，
 * 相机自适应和边界绘制都依赖它），在这里 import 并加入 MAPS。
 * UI 层（地图选择界面）读这个表枚举选项，不需要知道具体地图长什么样。
 *
 * 旧的 midlane_v1 已删除：其"几何规则生成"的坐标存在根本性错误
 * （外塔取 55% 弧长导致双方外塔越过中线互换半区），已被真实坐标缩放方案取代。
 *
 * v51.20：这里只登记"地图"这一个轴（框架）。"模式"（普通/经典）是另一条独立的轴，
 * 在框架之上做二次修正——原来的 summoners_rift_classic 是一张写死的独立地图，
 * 现在改成 modeTransforms.js 里的 applyClassicMode(baseMap) 变换函数，
 * 三张图都能套，不再单独注册一份。MapSystem.loadMap(mapId, mode) 按需现算。
 */
export const MAPS = {
  [summoners_rift.id]: summoners_rift,
  [howling_abyss.id]: howling_abyss,       // 嚎哭深渊（单路窄桥）
  [twisted_treeline.id]: twisted_treeline, // 扭曲丛林（双路）
};

export const DEFAULT_MAP_ID = summoners_rift.id;
