/**
 * BaseWallLayer.js —— 召唤师峡谷基地高地的城墙。
 *
 * 用户："召唤师峡谷的高地塔（召唤水晶塔）前方不可走的区域应该是有石墙挡着的，
 * 而不是换了个颜色，实际上地表还是空着的。"
 * 定稿（2026-09-27，用户看了实机截图二选一）：**城墙**——错缝石砖垒三层、墙顶
 * 石色压顶线、隔一块一个垛口、每截墙两端一座墩台；金色只在墩台顶上。
 * 第一版把整条不可走带（45~60 宽、两头圆）直接挤出成一整块实心体，用户原话
 * "像一块光秃秃的不知道啥玩意"——墙带多宽不等于墙多厚，墙要站在墙带中线上、
 * 比墙带窄，才读得出是"墙"。
 *
 * 墙的位置来自 baseWallMask（哪些格是墙）→ baseWallRuns（每截墙的中线），
 * 与碰撞同源；只在地图声明了 baseWalls 的图上建。尺寸在 CONFIG.ui.baseWall，
 * 墙石取调色板 rockColor，墩台顶取 wallCapColor。
 */
import * as THREE from '../../vendor/three.module.js';
import { CONFIG, stylizedPaletteOf } from '../data/Config.js';
import { baseWallMask, baseWallRuns } from '../data/baseCircle.js';
import { unpackBits, navgridOf } from '../data/navgrid.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { withColor, hash } from './VegetationLayer.js';

export class BaseWallLayer {
  constructor(scene) { this.scene = scene; this.mesh = null; this._mapId = null; this.shadowLevel = 'off'; }

  clear() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.mesh = null;
  }

  setShadowLevel(level) {
    this.shadowLevel = level;
    if (!this.mesh) return;
    const on = level !== 'off';
    this.mesh.castShadow = on; this.mesh.receiveShadow = on;
  }

  build(mapSystem) {
    const map = mapSystem && mapSystem.currentMap;
    const SV = map && map.visualStyle === 'stylized' ? stylizedPaletteOf(map) : null;
    if (!SV || !map.baseWalls || !map.useNavgrid) { this.clear(); this._mapId = null; return; }
    if (this._mapId === map.id && this.mesh) return;
    this.clear(); this._mapId = map.id;

    const NG = navgridOf(map);
    const bits = NG && unpackBits(NG.bits, NG.n);
    if (!bits) return;
    const W = CONFIG.ui?.baseWall || {};
    const mask = baseWallMask(map, bits, NG.n, W.wallFraction ?? 0.5);
    const block = W.blockLength ?? 18;
    const runs = baseWallRuns(map, mask, NG.n, block);
    if (!runs.length) return;

    const H = W.height ?? 34, courses = Math.max(1, W.courses ?? 3), courseH = H / courses;
    const coping = W.copingHeight ?? 2.6, merlonH = W.merlonHeight ?? 8;
    const pillar = W.pillarSize ?? 30, pillarExtra = W.pillarExtraHeight ?? 18;
    const stone = new THREE.Color(SV.rockColor || '#8f8879');
    const shade = (k, amp) => { const c = stone.clone(); c.offsetHSL(0, 0, (hash(k, 7) - 0.5) * amp); return '#' + c.getHexString(); };
    const copingHex = W.copingColor || '#a9a293';
    const goldHex = SV.wallCapColor || '#c9a24a';
    const heightAt = (x, y) => (mapSystem.heightAt ? mapSystem.heightAt(x, y) : 0) || 0;

    const parts = [];
    const box = (w, h, d, x, y, z, rotY, hex) => {
      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      g.rotateY(rotY); g.translate(x, y, z);
      parts.push(withColor(g, hex));
    };
    let seq = 0;
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) {
        const p = run[i], k = seq++;
        const rotY = -(p.ang + Math.PI / 2);                  // 沿基地圈切线
        const tx = Math.cos(p.ang + Math.PI / 2), ty = Math.sin(p.ang + Math.PI / 2);
        const base = heightAt(p.x, p.y);
        const T = Math.min(W.thicknessMax ?? 24, Math.max(W.thicknessMin ?? 14, p.width * 0.5));
        for (let c = 0; c < courses; c++) {
          const off = (c % 2) * block / 2;                    // 错缝：奇数层半块偏移
          box(block - 1.6, courseH - 1.2, T, p.x + tx * off, base + courseH * (c + 0.5), p.y + ty * off, rotY, shade(k * 3 + c, 0.14));
        }
        box(block, coping, T + 3, p.x, base + H + coping / 2, p.y, rotY, copingHex);
        if (i % 2 === 0) box(block * 0.55, merlonH, T * 0.85, p.x, base + H + coping + merlonH / 2, p.y, rotY, shade(k + 99, 0.1));
        if (i === 0 || i === run.length - 1) {
          box(pillar, H + pillarExtra, pillar, p.x, base + (H + pillarExtra) / 2, p.y, rotY, shade(k + 555, 0.08));
          box(pillar + 4, 3, pillar + 4, p.x, base + H + pillarExtra + 1.5, p.y, rotY, goldHex);
        }
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const on = this.shadowLevel !== 'off';
    mesh.castShadow = on; mesh.receiveShadow = on;
    mesh.name = 'baseWalls';
    this.mesh = mesh;
    this.scene.add(mesh);
  }
}
