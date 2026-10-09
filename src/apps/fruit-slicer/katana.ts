import * as THREE from 'three';
import { add3, normalize3, scale3, sub3, type Vec2, type Vec3 } from '../../core/math';
import type { SceneManager } from '../../core/SceneManager';
import { createKatana } from '../../models/props';
import { customModel } from '../../models/library';
import { POSE } from '../../perception/landmarks';
import { planeHeight, projectOnPlane } from '../../perception/space/surface';
import type { HandState, PerceptionFrame } from '../../perception/types';
import type { Handedness } from '../../tracking/types';
import type { Sweep } from './logic';

const GRAB_RADIUS = 0.22; // m alrededor del mango
const GRAB_SCREEN = 0.07; // alturas de pantalla (respaldo si la profundidad es imprecisa)
const HANDLE_HEIGHT = 0.85; // altura del mango sobre el piso cuando está clavada

/**
 * Katana clavada en el piso al costado del jugador. Se agarra cerrando el puño sobre el
 * mango (con la mano lejos, basta acercar la muñeca y sostener medio segundo) y se suelta
 * con la palma abierta. Mientras se sostiene, devuelve el barrido de la hoja por frame.
 */
export class KatanaController {
  readonly group = new THREE.Group();
  private model: THREE.Object3D;
  private bladeBase: THREE.Vector3;
  private bladeTip: THREE.Vector3;
  holder: Handedness | null = null;
  private standPos = new THREE.Vector3(0.5, -0.4, -2.2);
  private standQuat = new THREE.Quaternion();
  private hoverSince = 0;
  private openSince = 0;
  private lostSince = 0;
  private prev: { base: Vec2; tip: Vec2 } | null = null;
  private time = 0;
  /** El usuario está cerca del mango (para mostrar ayuda). */
  hovering = false;

  constructor(private scene: SceneManager) {
    const k = createKatana();
    const custom = customModel('katana');
    this.model = custom ?? k.group;
    this.bladeBase = k.bladeBase;
    this.bladeTip = k.bladeTip;
    this.group.add(this.model);
    scene.scene.add(this.group);
  }

  get held() {
    return this.holder !== null;
  }

  /** Punto de agarre de una mano (m, cámara): palma si hay dedos, si no la muñeca de la pose. */
  private gripPoint(h: HandState, frame: PerceptionFrame): Vec3 | null {
    if (h.palm3 && h.source !== 'pose') return h.palm3;
    const body = frame.body?.camera;
    if (body) return body[h.handedness === 'Left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
    return h.palm3;
  }

  private closed(h: HandState) {
    return h.gesture === 'fist' || h.pinching || h.mpGesture?.name === 'Closed_Fist';
  }

  update(frame: PerceptionFrame | null, dt: number, aspect: number): Sweep | null {
    this.time += dt;
    if (!frame) return null;
    const floor = frame.space.surface;

    // Lugar de la katana clavada: a la derecha del jugador, sobre el piso.
    if (!this.held) {
      const body = frame.body?.camera;
      let anchor: Vec3 | null = null;
      if (body) {
        const hips = scale3(add3(body[POSE.LEFT_HIP], body[POSE.RIGHT_HIP]), 0.5);
        anchor = add3(hips, { x: 0.55, y: 0, z: -0.15 });
      }
      anchor ??= this.scene.worldToCam(this.scene.normToWorld({ x: 0.8, y: 0.6 }, 2.2));
      const onFloor = projectOnPlane(floor, anchor);
      const up = floor.normal; // hacia arriba (cámara: y negativa)
      const handle = add3(onFloor, scale3(up, HANDLE_HEIGHT));
      this.standPos.lerp(this.scene.camToWorld(handle), 0.1);
      // Hoja hacia abajo, levemente inclinada.
      const down = this.scene.camDirToWorld(scale3(up, -1)).normalize();
      this.standQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), down).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6));
      this.group.position.copy(this.standPos);
      this.group.quaternion.copy(this.standQuat);
      this.prev = null;

      // ¿Alguna mano agarra el mango?
      const handleCam = this.scene.worldToCam(this.standPos);
      const handleN = this.scene.camToNorm(handleCam);
      this.hovering = false;
      for (const h of frame.hands) {
        const g = this.gripPoint(h, frame);
        const near3 = g ? Math.hypot(g.x - handleCam.x, g.y - handleCam.y, g.z - handleCam.z) < GRAB_RADIUS : false;
        const near2 = Math.hypot((h.palmCenter.x - handleN.x) * aspect, h.palmCenter.y - handleN.y) < GRAB_SCREEN;
        if (!near3 && !near2) continue;
        this.hovering = true;
        if (h.source === 'pose') {
          this.hoverSince ||= this.time;
          if (this.time - this.hoverSince > 0.5) this.grab(h.handedness);
        } else if (this.closed(h)) this.grab(h.handedness);
      }
      if (!this.hovering) this.hoverSince = 0;
      return null;
    }

    // Sostenida: sigue a la mano.
    const hand = frame.hands.find((h) => h.handedness === this.holder);
    if (!hand) {
      this.lostSince ||= this.time;
      if (this.time - this.lostSince > 1) this.release();
      return null;
    }
    this.lostSince = 0;
    if (hand.source !== 'pose' && hand.gesture === 'open_palm') {
      this.openSince ||= this.time;
      if (this.time - this.openSince > 0.4) {
        this.release();
        return null;
      }
    } else this.openSince = 0;

    const grip = this.gripPoint(hand, frame);
    if (!grip) return null;
    const dir = this.bladeDirection(hand, frame);
    const yAxis = this.scene.camDirToWorld(dir).normalize();
    const target = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), yAxis);
    this.group.quaternion.slerp(target, 0.6);
    this.group.position.lerp(this.scene.camToWorld(grip), 0.7);
    this.group.updateMatrixWorld(true);

    const base = this.toScreen(this.bladeBase, aspect);
    const tip = this.toScreen(this.bladeTip, aspect);
    const sweep = this.prev ? { prevBase: this.prev.base, prevTip: this.prev.tip, base, tip, speed: Math.hypot(tip.x - this.prev.tip.x, tip.y - this.prev.tip.y) / Math.max(dt, 1e-3) } : null;
    this.prev = { base, tip };
    return sweep;
  }

  /** Dirección de la hoja: sale del lado del pulgar del puño, inclinada con el antebrazo. */
  private bladeDirection(hand: HandState, frame: PerceptionFrame): Vec3 {
    const body = frame.body?.camera;
    const side = hand.handedness === 'Left' ? { w: POSE.LEFT_WRIST, e: POSE.LEFT_ELBOW } : { w: POSE.RIGHT_WRIST, e: POSE.RIGHT_ELBOW };
    const forearm = body ? normalize3(sub3(body[side.w], body[side.e])) : null;
    const c = hand.camera;
    if (c && hand.source !== 'pose') {
      const thumbSide = normalize3(sub3(c[5], c[17]));
      return forearm ? normalize3(add3(scale3(thumbSide, 0.7), scale3(forearm, 0.3))) : thumbSide;
    }
    // Sin dedos: la hoja prolonga el antebrazo.
    return forearm ?? { x: 0, y: -1, z: 0 };
  }

  private toScreen(local: THREE.Vector3, aspect: number): Vec2 {
    const n = this.scene.worldToNorm(local.clone().applyMatrix4(this.group.matrixWorld));
    return { x: n.x * aspect, y: n.y };
  }

  private grab(hand: Handedness) {
    this.holder = hand;
    this.hoverSince = 0;
    this.openSince = 0;
    this.prev = null;
  }

  release() {
    this.holder = null;
    this.prev = null;
  }

  /** Altura de la punta sobre el piso (para efectos). */
  tipHeight(frame: PerceptionFrame) {
    const p = this.bladeTip.clone().applyMatrix4(this.group.matrixWorld);
    return planeHeight(frame.space.surface, this.scene.worldToCam(p));
  }

  dispose() {
    this.group.removeFromParent();
  }
}
