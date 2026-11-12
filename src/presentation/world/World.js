/**
 * World.js —— 地图的全部"景"：地形、水、植被、摆件、局部光、环境生物。
 *
 * 一张地图进来，这里按它的地形高度场（MapSystem.terrainField）和主题（CONFIG.terrain.themes）
 * 把整个世界建出来；换图 / 改位图时整体重建。各部分是独立模块，这里只负责编排和生命周期。
 * 渲染器每帧调一次 update（时间、天气、夜色、相机），其余时候不碰它。
 */
import * as THREE from '../../../vendor/three.module.js';
import { CONFIG } from '../../data/Config.js';
import { terrainThemeOf } from '../../data/terrainField.js';
import { buildWorldTerrain } from './WorldTerrain.js';
import { buildWorldRocks } from './WorldRocks.js';
import { buildWorldFoliage } from './WorldFoliage.js';
import { buildWorldWater } from './WorldWater.js';
import { buildWorldLights } from './WorldLights.js';
import { buildWorldGroundCover } from './WorldGroundCover.js';
import { getWorldTextureSet } from './worldTextures.js';
import { setWorldRect, setWorldWater, updateWorldShading } from './worldShading.js';

export class World {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group(); this.group.name = 'world';
    scene.add(this.group);
    this.parts = [];          // { group?, update?(ctx), dispose() }
    this.field = null; this._map = null;
    this.toggles = { foliage: true, water: true, ambient: true };
  }
  /** 这张图的世界已经【完整】建好（分帧建图做到一半时是 false，免得半成品被当成建好了而跳过后面几步）。 */
  builtFor(map) { return !!this.field && this._map === map && this._complete === true; }

  /** 一次性建完（地图编辑器笔刷等不需要加载界面的场合）。@param ms MapSystem  @param opts { anisotropy } */
  build(ms, opts = {}) {
    for (const st of this.buildSteps(ms, opts)) st.run();
  }

  /**
   * 拆成若干步的建图：返回 [{ label, run }]，调用方每帧执行一步，中间可以刷新加载界面。
   * 顺序与原来一次性建完时相同（高度场 → 地形 → 岩石 → 水 → 树），结果逐位一致。
   */
  buildSteps(ms, opts = {}) {
    const steps = [];
    let field = null, theme = null, tex = null;
    steps.push({ label: '计算地形高度场', run: () => {
      this.dispose();
      this._complete = false;
      const map = ms.currentMap; field = ms.terrainField();
      if (!field) return;
      theme = terrainThemeOf(map);
      this.field = field; this._map = map; this.theme = theme;
      setWorldRect(field.W, field.H);
      setWorldWater(field.waterLevel, theme.water?.tint);
    } });
    steps.push({ label: '生成地表', run: () => { if (field) this._add(buildWorldTerrain(field, theme, opts)); } });
    steps.push({ label: '堆砌岩壁', run: () => {
      if (!field) return;
      tex = getWorldTextureSet(theme.layers, CONFIG.terrain.textureSize ?? 512, opts.anisotropy ?? 8);
      this._add(buildWorldRocks(field, tex.rock, theme));
    } });
    steps.push({ label: '注水', run: () => { if (field && this.toggles.water) this._add(buildWorldWater(field, theme)); } });
    steps.push({ label: '种树', run: () => { if (field && this.toggles.foliage) this._add(buildWorldFoliage(field, theme)); } });
    steps.push({ label: '铺草种花', run: () => { if (field && this.toggles.foliage) this.cover = this._add(buildWorldGroundCover(field, theme)); } });
    steps.push({ label: '点亮火炬', run: () => { if (field) this.lights = this._add(buildWorldLights(field, theme)); this._complete = !!field; } });
    return steps;
  }
  _add(part) { if (!part) return null; this.parts.push(part); if (part.group) this.group.add(part.group); return part; }

  /** ctx = { time, dt, weather: weatherGroundState(), night, wind:{x,y,strength}, camera, deps } */
  update(ctx) {
    updateWorldShading(ctx.time, ctx.weather, ctx.night, ctx.wind);
    for (const p of this.parts) p.update?.(ctx);
  }
  dispose() {
    for (const p of this.parts) { if (p.group) this.group.remove(p.group); p.dispose?.(); }
    this.parts.length = 0; this.field = null; this._map = null; this._complete = false;
  }
  stats() { let meshes = 0; this.group.traverse((o) => { if (o.isMesh || o.isPoints) meshes++; }); return { meshes, parts: this.parts.length }; }
}
