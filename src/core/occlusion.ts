import * as THREE from 'three';
import type { Vec3 } from './math';
import { HAND_CONNECTIONS, POSE } from '../perception/landmarks';
import type { PerceptionFrame } from '../perception/types';
import type { SceneManager } from './SceneManager';

export interface OcclusionOptions {
  hands: boolean;
  body: boolean;
}

const MAX_BONES = 128;
const MAX_JOINTS = 128;

const BODY_BONES: [number, number, number][] = [
  // [a, b, radio en m]
  [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW, 0.055],
  [POSE.LEFT_ELBOW, POSE.LEFT_WRIST, 0.045],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW, 0.055],
  [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST, 0.045],
  [POSE.LEFT_HIP, POSE.LEFT_KNEE, 0.08],
  [POSE.LEFT_KNEE, POSE.LEFT_ANKLE, 0.06],
  [POSE.RIGHT_HIP, POSE.RIGHT_KNEE, 0.08],
  [POSE.RIGHT_KNEE, POSE.RIGHT_ANKLE, 0.06],
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, 0.08],
  [POSE.LEFT_HIP, POSE.RIGHT_HIP, 0.1],
];

/**
 * Oclusión por profundidad: cilindros y esferas en las posiciones MÉTRICAS de las manos y
 * el cuerpo que se dibujan sólo en el depth buffer (sin color). Así, si la mano está más
 * cerca de la cámara que un objeto virtual, lo tapa (se ve el video), y si el objeto está
 * delante de la mano, se dibuja encima. Se dibujan antes que todo (renderOrder -10).
 */
export class Occluders {
  private bones: THREE.InstancedMesh;
  private joints: THREE.InstancedMesh;
  /** Silueta: un quad a la profundidad del torso que sólo escribe profundidad donde hay persona. */
  private silhouette: THREE.Mesh;
  private maskTexture: THREE.DataTexture | null = null;
  private maskBytes: Uint8Array | null = null;
  private lastMaskT = -1;
  private tmp = new THREE.Object3D();
  private up = new THREE.Vector3(0, 1, 0);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  options: OcclusionOptions = { hands: false, body: false };
  /** Muestra los oclusores en color (depuración). */
  debug = false;

  constructor(private scene: SceneManager) {
    const material = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1), material, MAX_BONES);
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), material, MAX_JOINTS);
    for (const m of [this.bones, this.joints]) {
      m.renderOrder = -10;
      m.frustumCulled = false;
      m.count = 0;
      scene.scene.add(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    // uv = coordenadas normalizadas de la vista (v hacia abajo, igual que las filas de la máscara).
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 3, 1, 1, 3, 2]);
    this.silhouette = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { mask: { value: null }, debug: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform sampler2D mask; uniform float debug; varying vec2 vUv; void main(){ float p = texture2D(mask, vUv).r; if (p < 0.5) discard; gl_FragColor = vec4(1.0, 0.3, 0.8, 0.3 * debug); }',
        colorWrite: false,
        transparent: false,
        side: THREE.DoubleSide,
      }),
    );
    this.silhouette.renderOrder = -10;
    this.silhouette.frustumCulled = false;
    this.silhouette.visible = false;
    scene.scene.add(this.silhouette);
  }

  /** Actualiza el quad de silueta con la máscara de personas, a la profundidad del jugador. */
  private updateSilhouette(frame: PerceptionFrame | null) {
    const mask = frame?.personMask;
    const cam = frame?.body?.camera;
    if (!this.options.body || !mask || !cam || !frame?.body) {
      this.silhouette.visible = false;
      return;
    }
    if (mask.t !== this.lastMaskT) {
      this.lastMaskT = mask.t;
      const n = mask.width * mask.height;
      if (!this.maskBytes || this.maskBytes.length !== n || !this.maskTexture || this.maskTexture.image.width !== mask.width) {
        this.maskBytes = new Uint8Array(n);
        this.maskTexture?.dispose();
        this.maskTexture = new THREE.DataTexture(this.maskBytes, mask.width, mask.height, THREE.RedFormat, THREE.UnsignedByteType);
        this.maskTexture.magFilter = this.maskTexture.minFilter = THREE.LinearFilter;
        (this.silhouette.material as THREE.ShaderMaterial).uniforms.mask.value = this.maskTexture;
      }
      for (let i = 0; i < n; i++) this.maskBytes[i] = mask.data[i] * 255;
      this.maskTexture.needsUpdate = true;
    }
    // Profundidad: promedio del torso (hombros y caderas).
    const ids = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP];
    const z = ids.reduce((s, i) => s + cam[i].z, 0) / ids.length;
    const pos = this.silhouette.geometry.getAttribute('position') as THREE.BufferAttribute;
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
      const p = this.scene.normToWorld({ x: u, y: v }, z);
      pos.setXYZ(i, p.x, p.y, p.z);
    });
    pos.needsUpdate = true;
    this.silhouette.visible = true;
  }

  setDebug(on: boolean) {
    this.debug = on;
    const sm = this.silhouette.material as THREE.ShaderMaterial;
    sm.colorWrite = on;
    sm.transparent = on;
    sm.uniforms.debug.value = on ? 1 : 0;
    const mat = this.bones.material as THREE.MeshBasicMaterial;
    mat.colorWrite = on;
    mat.color.set(0x00e5ff);
    mat.transparent = on;
    mat.opacity = 0.35;
  }

  update(frame: PerceptionFrame | null) {
    let nb = 0;
    let nj = 0;
    const bone = (p: Vec3, q: Vec3, r: number) => {
      if (nb >= MAX_BONES) return;
      this.scene.camToWorld(p, this.a);
      this.scene.camToWorld(q, this.b);
      const len = this.a.distanceTo(this.b);
      if (len < 1e-4) return;
      this.tmp.position.copy(this.a).add(this.b).multiplyScalar(0.5);
      this.tmp.quaternion.setFromUnitVectors(this.up, this.b.sub(this.a).normalize());
      this.tmp.scale.set(r, len, r);
      this.tmp.updateMatrix();
      this.bones.setMatrixAt(nb++, this.tmp.matrix);
    };
    const joint = (p: Vec3, r: number, flatten?: { normal: Vec3; factor: number }) => {
      if (nj >= MAX_JOINTS) return;
      this.scene.camToWorld(p, this.tmp.position);
      if (flatten) {
        this.tmp.quaternion.setFromUnitVectors(this.up, this.scene.camDirToWorld(flatten.normal).normalize());
        this.tmp.scale.set(r, r * flatten.factor, r);
      } else {
        this.tmp.quaternion.identity();
        this.tmp.scale.setScalar(r);
      }
      this.tmp.updateMatrix();
      this.joints.setMatrixAt(nj++, this.tmp.matrix);
    };

    if (frame && this.options.hands) {
      for (const h of frame.hands) {
        const c = h.camera;
        if (!c || h.source === 'pose') continue;
        for (const [i, j] of HAND_CONNECTIONS) bone(c[i], c[j], i === 0 || j === 0 ? 0.012 : 0.0085);
        for (const p of c) joint(p, 0.0085);
        // Palma: disco aplastado en el plano de la mano.
        if (h.palm3 && h.normal3) joint(h.palm3, 0.04, { normal: h.normal3, factor: 0.35 });
      }
    }

    const body = frame?.body;
    if (body?.camera && this.options.body) {
      const c = body.camera;
      const vis = (i: number) => body.landmarks[i]?.visibility ?? 0;
      for (const [i, j, r] of BODY_BONES) if (vis(i) > 0.5 && vis(j) > 0.5) bone(c[i], c[j], r);
      // Torso y cabeza.
      const mid = (i: number, j: number) => ({ x: (c[i].x + c[j].x) / 2, y: (c[i].y + c[j].y) / 2, z: (c[i].z + c[j].z) / 2 });
      if (vis(POSE.LEFT_SHOULDER) > 0.5 && vis(POSE.LEFT_HIP) > 0.5) bone(mid(POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER), mid(POSE.LEFT_HIP, POSE.RIGHT_HIP), 0.15);
      if (vis(POSE.NOSE) > 0.5) joint(mid(POSE.LEFT_EAR, POSE.RIGHT_EAR), 0.11);
      for (const i of [POSE.LEFT_ELBOW, POSE.RIGHT_ELBOW, POSE.LEFT_KNEE, POSE.RIGHT_KNEE, POSE.LEFT_WRIST, POSE.RIGHT_WRIST]) if (vis(i) > 0.5) joint(c[i], 0.05);
      // Sin manos detalladas, una esfera por mano desde la pose.
      if (!frame!.hands.some((h) => h.camera && h.source !== 'pose')) {
        for (const i of [POSE.LEFT_WRIST, POSE.RIGHT_WRIST]) if (vis(i) > 0.5) joint(c[i], 0.07);
      }
    }

    this.updateSilhouette(frame);
    this.bones.count = nb;
    this.joints.count = nj;
    this.bones.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.bones.removeFromParent();
    this.joints.removeFromParent();
    this.silhouette.removeFromParent();
    this.maskTexture?.dispose();
    this.bones.dispose();
    this.joints.dispose();
  }
}
