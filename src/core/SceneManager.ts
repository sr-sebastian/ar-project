import * as THREE from 'three';
import type { Vec2, Vec3 } from './math';
import type { Plane } from '../perception/space/surface';
import { Viewport } from './Viewport';

/**
 * Escena Three.js superpuesta al video. La cámara 3D replica la cámara real: mismo FOV y
 * mismo recorte que el video en pantalla, así un punto 3D en "coordenadas de cámara"
 * (x derecha, y abajo, z adelante, como la visión por computadora) cae exactamente sobre
 * el píxel correcto del video.
 */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 200);
  readonly renderer: THREE.WebGLRenderer;
  readonly viewport = new Viewport();
  private hfov = 65;
  /** Copia de la cámara sin recorte: proyecta sobre el frame de video completo. */
  private fullCam = new THREE.PerspectiveCamera();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1, 3, 1);
    this.scene.add(sun);
  }

  setFov(hfov: number) {
    this.hfov = hfov;
  }

  resize(width: number, height: number, videoWidth: number, videoHeight: number) {
    this.viewport.update(width, height, videoWidth, videoHeight);
    const vp = this.viewport;
    const aspect = vp.videoAspect;
    const vfov = (2 * Math.atan(Math.tan((this.hfov * Math.PI) / 360) / aspect) * 180) / Math.PI;
    this.camera.fov = vfov;
    this.camera.aspect = aspect;
    // El canvas muestra sólo la ventana visible del video recortado (cover).
    this.camera.setViewOffset(vp.displayWidth, vp.displayHeight, -vp.offsetX, -vp.offsetY, width, height);
    this.camera.updateProjectionMatrix();
    this.fullCam.copy(this.camera);
    this.fullCam.clearViewOffset();
    this.fullCam.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Coordenadas de cámara (visión) → mundo Three (y arriba, -z adelante). */
  camToWorld(p: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(p.x, -p.y, -p.z);
  }

  camDirToWorld(d: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(d.x, -d.y, -d.z);
  }

  /** Punto 3D sobre el rayo de un pixel normalizado del video, a la profundidad `z` (unidades de escena). */
  normToWorld(p: Vec2, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    const ndc = new THREE.Vector3(p.x * 2 - 1, -(p.y * 2 - 1), 0.5);
    ndc.unproject(this.fullCam);
    const dir = ndc.normalize();
    return target.copy(dir).multiplyScalar(z / -dir.z);
  }

  /** Proyecta un punto del mundo a coordenadas normalizadas del video. */
  worldToNorm(v: THREE.Vector3): Vec2 {
    const p = v.clone().project(this.fullCam);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  /**
   * Matriz que apoya un objeto sobre un plano (piso o mesa): origen en la intersección del
   * rayo por `anchor` con el plano, eje Y = normal del plano, eje Z = hacia la cámara.
   * Devuelve también la distancia a la cámara para escalar el contenido.
   */
  surfaceTransform(plane: Plane, anchor: Vec2): { matrix: THREE.Matrix4; distance: number } | null {
    const origin = this.normToWorld(anchor, 1);
    const dir = origin.clone().normalize();
    const n = this.camDirToWorld(plane.normal).normalize();
    // Plano en coordenadas Three: n·p + d = 0, con n ya transformada (la transformación es ortonormal).
    const denom = n.dot(dir);
    if (Math.abs(denom) < 1e-5) return null;
    const t = -plane.d / denom;
    if (t <= 0) return null;
    const pos = dir.clone().multiplyScalar(t);
    // Normal apuntando hacia la cámara (la superficie "mira" hacia arriba/hacia nosotros).
    if (n.dot(pos) > 0) n.negate();
    const toCam = pos.clone().negate();
    const z = toCam.sub(n.clone().multiplyScalar(toCam.dot(n))).normalize();
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
    const x = new THREE.Vector3().crossVectors(n, z).normalize();
    const matrix = new THREE.Matrix4().makeBasis(x, n, z).setPosition(pos);
    return { matrix, distance: pos.length() };
  }

  /** Libera geometrías y materiales de un objeto y sus hijos. */
  static disposeObject(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    obj.removeFromParent();
  }
}
