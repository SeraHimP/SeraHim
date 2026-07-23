import { summoners_rift } from './summoners_rift.js';
import { summoners_rift_quick } from './summoners_rift_quick.js';
import { howling_abyss } from './howling_abyss.js';

/**
 * maps/index.js
 * 地图注册表：所有可用地图集中登记于此。
 * 以后新增地图：写好 mapXxx.js（参照 summoners_rift.js 的结构，必须声明 world: {w,h}，
 * 相机自适应和边界绘制都依赖它），在这里 import 并加入 MAPS。
 * UI 层（地图选择界面）读这个表枚举选项，不需要知道具体地图长什么样。
 *
 * 旧的 midlane_v1 已删除：其"几何规则生成"的坐标存在根本性错误
 * （外塔取 55% 弧长导致双方外塔越过中线互换半区），已被真实坐标缩放方案取代。
 */
export const MAPS = {
  [summoners_rift_quick.id]: summoners_rift_quick,
  [summoners_rift.id]: summoners_rift,
  [howling_abyss.id]: howling_abyss, // Q9：嚎哭深渊（单路）
};

export const DEFAULT_MAP_ID = summoners_rift.id;
