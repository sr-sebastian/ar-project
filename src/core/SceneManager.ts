import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { cross3, dot3, normalize3, sub3, scale3, type Vec2, type Vec3 } from './math';
import { projectOnPlane, type Plane } from '../perception/space/surface';
import { Viewport } from './Viewport';

/**
 * Escena 3D en realidad aumentada. El video de la cámara se dibuja DENTRO de WebGL como
 * fondo, y la cámara 3D replica a la real (mismo FOV, mismo recorte), en METROS:
 * un punto en coordenadas de cámara (x derecha, y abajo, z adelante) cae sobre su píxel.
 *
 * Integración visual:
 * - Entorno PBR (RoomEnvironment) para reflejos realistas.
 * - Sol con sombras enfocado en la zona de juego (`setShadowFocus`) + "shadow catchers".
 * - Estimación de luz: el brillo/color promedio del video ajusta la iluminación.
 * - Oclusores (ver occlusion.ts) escriben sólo profundidad para que manos y cuerpo tapen
 *   a los objetos virtuales.
 */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.02, 60);
  readonly renderer: THREE.WebGLRenderer;
  readonly viewport = new Viewport();
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 0.9);
  private hfov = 65;
  private fullCam = new THREE.PerspectiveCamera();
  // Fondo de video
  private bgScene = new THREE.Scene();
  private bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bgMaterial: THREE.ShaderMaterial;
  private videoTexture: THREE.VideoTexture | null = null;
  // Estimación de luz
  private lightCanvas = Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  private lastLightSample = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.localClippingEnabled = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    pmrem.dispose();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.01;
    this.sun.shadow.radius = 4;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.setShadowFocus(new THREE.Vector3(0, -1, -2), new THREE.Vector3(0, 1, 0), 1.5);

    // Quad de fondo: muestrea el video con el mismo recorte (cover) y espejado que la vista.
    this.bgMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        uMin: { value: new THREE.Vector2(0, 0) },
        uMax: { value: new THREE.Vector2(1, 1) },
        mirrored: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec2 uMin; uniform vec2 uMax; uniform float mirrored;
        varying vec2 vUv;
        void main() {
          // vUv: pantalla (0,0 abajo-izq). Coordenadas normalizadas de la vista (y hacia abajo):
          vec2 view = vec2(mix(uMin.x, uMax.x, vUv.x), mix(uMin.y, uMax.y, 1.0 - vUv.y));
          vec2 tex = vec2(mirrored > 0.5 ? 1.0 - view.x : view.x, 1.0 - view.y);
          gl_FragColor = texture2D(map, tex);
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMaterial));
  }

  setVideo(video: HTMLVideoElement) {
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.bgMaterial.uniforms.map.value = this.videoTexture;
  }

  setMirrored(mirrored: boolean) {
    this.bgMaterial.uniforms.mirrored.value = mirrored ? 1 : 0;
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
    const b = vp.visibleBounds();
    this.bgMaterial.uniforms.uMin.value.set(b.minX, b.minY);
    this.bgMaterial.uniforms.uMax.value.set(b.maxX, b.maxY);
  }

  /** Ajusta la luz al brillo y color promedio del video (cada ~0.5 s). */
  estimateLighting(video: HTMLVideoElement) {
    const now = performance.now();
    if (now - this.lastLightSample < 500 || video.videoWidth === 0) return;
    this.lastLightSample = now;
    const c = this.lightCanvas.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(video, 0, 0, 8, 8);
    const d = c.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    r /= n * 255;
    g /= n * 255;
    b /= n * 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const max = Math.max(r, g, b, 1e-3);
    const tint = new THREE.Color(0.5 + (0.5 * r) / max, 0.5 + (0.5 * g) / max, 0.5 + (0.5 * b) / max);
    const k = 0.85; // suavizado
    this.hemi.intensity = this.hemi.intensity * k + (0.4 + lum * 1.6) * (1 - k);
    this.sun.intensity = this.sun.intensity * k + (0.9 + lum * 2.4) * (1 - k);
    this.hemi.color.lerp(tint, 1 - k);
    this.sun.color.lerp(tint, 1 - k);
    this.scene.environmentIntensity = this.scene.environmentIntensity * k + (0.35 + lum * 0.8) * (1 - k);
  }

  /** Orienta el sol para que proyecte sombras sobre la zona de juego (coordenadas Three). */
  setShadowFocus(center: THREE.Vector3, up: THREE.Vector3, radius: number) {
    const towardCam = center.clone().negate().normalize();
    const pos = center.clone().addScaledVector(up, radius * 3).addScaledVector(towardCam, radius * 0.8).add(new THREE.Vector3(radius * 0.6, 0, 0));
    this.sun.position.copy(pos);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.01;
    cam.far = radius * 8;
    cam.updateProjectionMatrix();
  }

  render() {
    this.renderer.clear();
    if (this.videoTexture) this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  /** Coordenadas de cámara (visión, metros) → mundo Three (y arriba, -z adelante). */
  camToWorld(p: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(p.x, -p.y, -p.z);
  }

  camDirToWorld(d: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(d.x, -d.y, -d.z);
  }

  worldToCam(v: THREE.Vector3): Vec3 {
    return { x: v.x, y: -v.y, z: -v.z };
  }

  /** Punto 3D sobre el rayo de un pixel normalizado del video, a la profundidad `z` (m). */
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

  /** Proyecta un punto de cámara (m) a coordenadas normalizadas del video. */
  camToNorm(p: Vec3): Vec2 {
    return this.worldToNorm(this.camToWorld(p));
  }

  /**
   * Matriz que apoya contenido sobre un plano: origen en `point` proyectado al plano, eje Y
   * = normal, eje X = `axis` (si se da, p. ej. el del marcador) o perpendicular a la
   * dirección de la cámara, eje Z = hacia la cámara.
   */
  surfaceMatrix(plane: Plane, point: Vec3, axis?: Vec3 | null): THREE.Matrix4 {
    const origin = projectOnPlane(plane, point);
    const n = normalize3(plane.normal);
    let x: Vec3;
    if (axis) {
      x = normalize3(sub3(axis, scale3(n, dot3(axis, n))));
    } else {
      const toCam = scale3(origin, -1);
      const z = normalize3(sub3(toCam, scale3(n, dot3(toCam, n))));
      x = cross3(n, z);
      // cross en coordenadas de cámara (mano izquierda en Three): se corrige al convertir.
    }
    const Y = this.camDirToWorld(n).normalize();
    let X = this.camDirToWorld(x).normalize();
    let Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    // Z debe apuntar hacia la cámara (el origen Three está en la cámara).
    const pos = this.camToWorld(origin);
    if (Z.dot(pos.clone().negate()) < 0) {
      X = X.negate();
      Z = Z.negate();
    }
    return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(pos);
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

/** Plano invisible que sólo recibe sombras (para "apoyar" objetos sobre la superficie real). */
export function createShadowCatcher(size: number, opacity = 0.35): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity }));
  mesh.receiveShadow = true;
  mesh.renderOrder = -2;
  return mesh;
}
