/**
 * ThreeCameraController.js —— 3D 视角的输入换算（2.5D 迁移第 4 步）
 *
 * ===== 为什么不是"raycast 打精灵" =====
 * 计划原文写的是 raycasting 命中 sprite。读完 2D 的 _handleSelectClick 才发现方向错了：
 * 2D 的点选【根本不在屏幕空间做命中】——它先 screenToWorld，再在【世界坐标】里找
 * "距离 − 单位显示半径"最小且 ≤ slack 的实体。也就是说整套命中语义（缩放自适应容差、
 * 幽灵水晶单独扫描、最近者优先）全都写在世界空间里，与渲染器无关。
 *
 * 所以 3D 侧只需要替换【一个函数】：屏幕坐标 → 世界坐标。2D 用平面反算，3D 用
 * 射线打 y=0 地面平面。命中逻辑一行都不用重写，手感（slack 容差）天然一致，
 * 幽灵水晶可点选、点空地清除选中也全部自动继承。这比重写一套 raycast 命中
 * 少几十行代码，且不可能出现"3D 的手感和 2D 不一样"这类不可验收的偏差。
 *
 * Billboard 的中心正好放在 (pos.x, 0, pos.y)（UnitLayer 的位置约定），
 * 即精灵的视觉中心 == 它的地面点，所以"打地面"与"打精灵"在中心点上是同一件事。
 *
 * ===== 拖拽的纵向补偿 =====
 * 世界 Z 在屏幕上被压缩了 sin(仰角)（45° 时 ≈0.707）。若照搬 2D 的
 * offsetY += dy，画面只会跟手 70%，拖起来"发涩"。故 offsetY += dy / sin(仰角)，
 * 屏幕位移与鼠标位移严格 1:1。横向无压缩，X 保持原样。
 *
 * 视口状态仍然【单一来源】存在 CanvasController 的 zoom/offsetX/offsetY 里，
 * 本类不持有任何视图状态——这样 F9 来回切换时视野中心不跳，且第 5 步摘除 2D 后
 * 只需把这几个字段搬走，无需合并两套状态。
 */
import * as THREE from '../../vendor/three.module.js';

const DEG = Math.PI / 180;

export class ThreeCameraController {
  /**
   * @param {ThreeRenderer} renderer3d
   * @param {HTMLCanvasElement} glCanvas
   * @param {() => boolean} isActive  当前是否处于 3D 模式
   */
  constructor(renderer3d, glCanvas, isActive) {
    this.r3d = renderer3d;
    this.canvas = glCanvas;
    this._isActive = isActive;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0 地面
    this._ndc = new THREE.Vector2();
    this._hit = new THREE.Vector3();
  }

  active() {
    return !!(this._isActive && this._isActive() && this.r3d && this.canvas);
  }

  /** 纵向拖拽补偿系数 = 1 / sin(仰角)；仰角 90°（纯俯视）时为 1，与 2D 完全相同 */
  panScaleY() {
    const s = Math.sin((this.r3d.elevationDeg || 90) * DEG);
    return s > 1e-3 ? 1 / s : 1;
  }

  /**
   * 屏幕坐标 → 世界坐标（射线打 y=0 平面）。
   * 返回 {x, y}（y 即世界 Z，与 2D 的世界坐标系同名同义）；射线与地面平行时返回 null，
   * 调用方（CanvasController）据此回退到 2D 平面反算，绝不把 null 传进命中逻辑。
   */
  screenToWorld(clientX, clientY) {
    const cam = this.r3d.camera;
    if (!cam) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    // 相机矩阵每帧 render 时才更新；点击可能发生在两帧之间，这里显式刷新以防用到陈旧矩阵
    cam.updateMatrixWorld();

    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._ray.setFromCamera(this._ndc, cam);
    // C 组·台阶地形：优先射线打【起伏的地面网格】——高地/河床下点选不再有视差偏移；
    // 无地形网格（沙盒/无墙）或未命中时回退 y=0 平面，行为与原来一致。
    const terr = this.r3d._terrainMesh;
    if (terr) {
      const hits = this._ray.intersectObject(terr, false);
      if (hits.length) return { x: hits[0].point.x, y: hits[0].point.z };
    }
    const hit = this._ray.ray.intersectPlane(this._plane, this._hit);
    if (!hit) return null;
    return { x: hit.x, y: hit.z };
  }
}
