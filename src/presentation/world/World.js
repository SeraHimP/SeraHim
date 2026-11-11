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
  builtFor(map) { return !!this.field && this._map === map; }

  /** @param ms MapSystem  @param opts { anisotropy } */
  build(ms, opts = {}) {
    this.dispose();
    const map = ms.currentMap, field = ms.terrainField();
    if (!field) return;
    const theme = terrainThemeOf(map);
    this.field = field; this._map = map; this.theme = theme;
    setWorldRect(field.W, field.H);
    setWorldWater(field.waterLevel, theme.water?.tint);
    this._add(buildWorldTerrain(field, theme, opts));
    const tex = getWorldTextureSet(theme.layers, CONFIG.terrain.textureSize ?? 512, opts.anisotropy ?? 8);
    this._add(buildWorldRocks(field, tex.rock, theme));
    if (this.toggles.water) this._add(buildWorldWater(field, theme));
    if (this.toggles.foliage) this._add(buildWorldFoliage(field, theme));
  }
  _add(part) { if (!part) return null; this.parts.push(part); if (part.group) this.group.add(part.group); return part; }

  /** ctx = { time, dt, weather: weatherGroundState(), night, wind:{x,y,strength}, camera, deps } */
  update(ctx) {
    updateWorldShading(ctx.time, ctx.weather, ctx.night, ctx.wind);
    for (const p of this.parts) p.update?.(ctx);
  }
  dispose() {
    for (const p of this.parts) { if (p.group) this.group.remove(p.group); p.dispose?.(); }
    this.parts.length = 0; this.field = null; this._map = null;
  }
  stats() { let meshes = 0; this.group.traverse((o) => { if (o.isMesh || o.isPoints) meshes++; }); return { meshes, parts: this.parts.length }; }
}
