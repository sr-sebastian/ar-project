import * as THREE from 'three';
import type { Vec2 } from '../../core/math';
import { SceneManager } from '../../core/SceneManager';
import type { SpaceState } from '../../perception/types';

/**
 * Grupo Three.js "apoyado" sobre la superficie de juego (piso o mesa).
 * Ejes locales: Y = normal de la superficie, Z = hacia la cámara, X = derecha.
 * La escala local es proporcional a la distancia, así 1 unidad local ≈ mismo tamaño
 * aparente sin importar lo lejos que esté la superficie.
 */
export class SurfaceAnchor {
  readonly group = new THREE.Group();
  valid = false;
  distance = 1;

  constructor(
    private scene: SceneManager,
    public anchor: Vec2,
  ) {
    this.group.matrixAutoUpdate = false;
    scene.scene.add(this.group);
  }

  update(space: SpaceState) {
    const t = this.scene.surfaceTransform(space.surface, this.anchor);
    this.valid = !!t;
    this.group.visible = this.valid;
    if (!t) return;
    this.distance = t.distance;
    const s = t.distance;
    this.group.matrix.copy(t.matrix).multiply(new THREE.Matrix4().makeScale(s, s, s));
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** Proyecta un punto local del grupo a coordenadas normalizadas del video. */
  localToNorm(local: THREE.Vector3): Vec2 {
    this.group.updateMatrixWorld();
    return this.scene.worldToNorm(local.clone().applyMatrix4(this.group.matrixWorld));
  }

  dispose() {
    SceneManager.disposeObject(this.group);
  }
}

/** Grilla para visualizar la superficie detectada. */
export function makeSurfaceGrid(size = 1, divisions = 10, color = 0x55ddff): THREE.Object3D {
  const grid = new THREE.GridHelper(size, divisions, color, color);
  const mat = grid.material as THREE.Material;
  mat.transparent = true;
  mat.opacity = 0.5;
  return grid;
}
