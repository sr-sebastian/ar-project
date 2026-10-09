import * as THREE from 'three';
import type { Vec2, Vec3 } from '../../core/math';
import { createShadowCatcher, SceneManager } from '../../core/SceneManager';
import type { SpaceState } from '../../perception/types';

/**
 * Grupo Three.js apoyado sobre la superficie de juego (piso o mesa), en METROS.
 * Ejes locales: Y = normal de la superficie, Z = hacia la cámara, X = derecha (o el eje
 * del marcador impreso si hay uno). Incluye un "shadow catcher" para que los objetos
 * proyecten sombra sobre la superficie real, y enfoca el sol en la zona.
 *
 * La pose se suaviza para que el contenido no tiemble con el ruido de la estimación.
 */
export class SurfaceAnchor {
  readonly group = new THREE.Group();
  readonly shadow: THREE.Mesh;
  /** Si es true, la posición queda fija aunque cambie el centro sugerido. */
  locked = false;
  private target = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private initialized = false;
  private fixedPoint: Vec3 | null = null;

  constructor(
    private scene: SceneManager,
    /** Tamaño (m) del área de sombras. */
    public size = 1,
  ) {
    this.group.matrixAutoUpdate = false;
    this.shadow = createShadowCatcher(size);
    this.group.add(this.shadow);
    scene.scene.add(this.group);
  }

  /** Fija el centro en un punto (m, cámara) en vez de usar el centro sugerido. */
  setPoint(p: Vec3 | null) {
    this.fixedPoint = p;
  }

  update(space: SpaceState, smoothing = 0.2) {
    if (this.locked && this.initialized) return;
    const point = this.fixedPoint ?? space.center;
    this.target.copy(this.scene.surfaceMatrix(space.surface, point, space.axis));
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    this.target.decompose(p, q, s);
    if (!this.initialized) {
      this.pos.copy(p);
      this.quat.copy(q);
      this.initialized = true;
    } else {
      this.pos.lerp(p, smoothing);
      this.quat.slerp(q, smoothing);
    }
    this.group.matrix.compose(this.pos, this.quat, new THREE.Vector3(1, 1, 1));
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.scene.setShadowFocus(this.pos, up, this.size * 0.75);
  }

  /** Punto en coordenadas de cámara (m) → coordenadas locales del grupo. */
  camToLocal(p: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    this.scene.camToWorld(p, target);
    return this.group.worldToLocal(target);
  }

  /** Dirección de cámara → local. */
  camDirToLocal(d: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    this.scene.camDirToWorld(d, target);
    return target.applyQuaternion(this.quat.clone().invert());
  }

  localToWorld(local: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(local).applyMatrix4(this.group.matrixWorld);
  }

  /** Punto local → coordenadas normalizadas del video. */
  localToNorm(local: THREE.Vector3): Vec2 {
    return this.scene.worldToNorm(this.localToWorld(local));
  }

  dispose() {
    SceneManager.disposeObject(this.group);
  }
}

/** Grilla para visualizar la superficie detectada (metros). */
export function makeSurfaceGrid(size = 1, divisions = 10, color = 0x55ddff): THREE.Object3D {
  const grid = new THREE.GridHelper(size, divisions, color, color);
  const mat = grid.material as THREE.Material;
  mat.transparent = true;
  mat.opacity = 0.5;
  return grid;
}
