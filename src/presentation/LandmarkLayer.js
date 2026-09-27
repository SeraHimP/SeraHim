/**
 * LandmarkLayer.js —— 地标的立体部分：坑沿立石圈。
 *
 * 摆放全部来自 data/landmarks.js 的 landmarkPlan()（纯数据、可测）；坑底与铺石广场
 * 画在地形底图上（TerrainLayer.drawLandmarks），这里只放需要高度的东西。
 * 只有声明了 map.landmarks 的地图才会建；其余地图 build() 直接清空返回。
 *
 * 低多面体 + MeshLambertMaterial flatShading，与 BoundaryDecorLayer 同一套语言；
 * 石头颜色取调色板 rockColor。
 */
import * as THREE from '../../vendor/three.module.js';
import { stylizedPaletteOf } from '../data/Config.js';
import { landmarkPlan } from '../data/landmarks.js';

export class LandmarkLayer {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._mapId = null;
    this.shadowLevel = 'off';
  }

  clear() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.scene.remove(this.group);
    this.group = null;
  }

  setShadowLevel(level) {
    this.shadowLevel = level;
    if (!this.group) return;
    const on = level !== 'off';
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = on; o.receiveShadow = on; } });
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    const plan = map ? landmarkPlan(map, (n) => mapSystem.getPit(n)) : null;
    if (!plan || !plan.pits.length) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.group) return;   // 同图已建，跳过
    this.clear(); this._mapId = map.id;

    const group = new THREE.Group();
    group.name = 'landmarks';
    const mat = new THREE.MeshLambertMaterial({ color: stylizedPaletteOf(map).rockColor || '#8f8879', flatShading: true });
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const heightAt = (x, y) => (mapSystem.heightAt ? mapSystem.heightAt(x, y) : 0) || 0;
    const on = this.shadowLevel !== 'off';
    for (const pit of plan.pits) {
      for (const s of pit.stones) {
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(s.size, s.height, s.size * 0.8);
        m.rotation.y = s.rot;
        m.position.set(s.x, heightAt(s.x, s.y) + s.height * 0.55, s.y);
        m.castShadow = on; m.receiveShadow = on;
        group.add(m);
      }
    }
    this.group = group;
    this.scene.add(group);
  }
}
