import { angleAt, clamp, dist2, mid2, mid3, type Vec2, type Vec3 } from '../core/math';
import type { Landmark } from '../tracking/types';
import { POSE } from './landmarks';

export interface JointAngles {
  leftElbow: number;
  rightElbow: number;
  leftShoulder: number;
  rightShoulder: number;
  leftKnee: number;
  rightKnee: number;
  leftHip: number;
  rightHip: number;
}

export interface BodyMetrics {
  /** Brazo levantado: la muñeca por encima de la cabeza (lado del usuario). */
  leftArmUp: boolean;
  rightArmUp: boolean;
  /** Inclinación lateral del torso: -1 (izquierda de la pantalla) … 1 (derecha). */
  lean: number;
  /** Centro de los hombros en coordenadas de pantalla. */
  torsoCenter: Vec2;
  /** Ancho de hombros normalizado: proxy de la distancia a la cámara. */
  shoulderWidth: number;
  angles: JointAngles;
  /** Qué tan visible está el cuerpo (0..1): cuántas articulaciones clave se ven. */
  visibility: number;
  /** Tobillos visibles → hay referencia del piso. */
  feetVisible: boolean;
  /** Altura de pantalla (y) del punto más bajo de los pies, si se ven. */
  floorY: number | null;
}

const vis = (l: Landmark | undefined) => l?.visibility ?? 0;

/**
 * Métricas instantáneas del cuerpo. Recibe landmarks normalizados de pantalla
 * (y hacia abajo) y, si están, los "world landmarks" en metros para los ángulos.
 */
export function computeBodyMetrics(lm: Landmark[], world: Landmark[]): BodyMetrics {
  const P = POSE;
  const lS = lm[P.LEFT_SHOULDER];
  const rS = lm[P.RIGHT_SHOULDER];
  const lH = lm[P.LEFT_HIP];
  const rH = lm[P.RIGHT_HIP];
  const nose = lm[P.NOSE];
  const shoulders = mid2(lS, rS);
  const hips = mid2(lH, rH);
  const shoulderWidth = dist2(lS, rS);
  const torsoLen = dist2(shoulders, hips) || shoulderWidth || 0.2;

  // Ángulos con coordenadas métricas si existen (no deformadas por la perspectiva).
  const w: Vec3[] = world.length === 33 ? world : lm;
  const angles: JointAngles = {
    leftElbow: angleAt(w[P.LEFT_SHOULDER], w[P.LEFT_ELBOW], w[P.LEFT_WRIST]),
    rightElbow: angleAt(w[P.RIGHT_SHOULDER], w[P.RIGHT_ELBOW], w[P.RIGHT_WRIST]),
    leftShoulder: angleAt(w[P.LEFT_ELBOW], w[P.LEFT_SHOULDER], w[P.LEFT_HIP]),
    rightShoulder: angleAt(w[P.RIGHT_ELBOW], w[P.RIGHT_SHOULDER], w[P.RIGHT_HIP]),
    leftKnee: angleAt(w[P.LEFT_HIP], w[P.LEFT_KNEE], w[P.LEFT_ANKLE]),
    rightKnee: angleAt(w[P.RIGHT_HIP], w[P.RIGHT_KNEE], w[P.RIGHT_ANKLE]),
    leftHip: angleAt(w[P.LEFT_SHOULDER], w[P.LEFT_HIP], w[P.LEFT_KNEE]),
    rightHip: angleAt(w[P.RIGHT_SHOULDER], w[P.RIGHT_HIP], w[P.RIGHT_KNEE]),
  };

  const armUp = (wrist: Landmark, elbow: Landmark, shoulder: Landmark) =>
    vis(wrist) > 0.5 && wrist.y < nose.y - torsoLen * 0.1 && elbow.y < shoulder.y + torsoLen * 0.2;

  // Lean: desplazamiento horizontal de hombros respecto a caderas, relativo al torso.
  const hipsVisible = vis(lH) > 0.5 && vis(rH) > 0.5;
  const lean = hipsVisible
    ? clamp(((shoulders.x - hips.x) / torsoLen) * 2.5, -1, 1)
    : clamp(((rS.y - lS.y) / (shoulderWidth || 1)) * 2, -1, 1);

  const keyJoints = [P.NOSE, P.LEFT_SHOULDER, P.RIGHT_SHOULDER, P.LEFT_HIP, P.RIGHT_HIP, P.LEFT_KNEE, P.RIGHT_KNEE, P.LEFT_ANKLE, P.RIGHT_ANKLE];
  const visibility = keyJoints.filter((i) => vis(lm[i]) > 0.5).length / keyJoints.length;
  const feet = [P.LEFT_HEEL, P.RIGHT_HEEL, P.LEFT_FOOT, P.RIGHT_FOOT].map((i) => lm[i]).filter((l) => vis(l) > 0.6);
  const feetVisible = feet.length >= 2;

  return {
    leftArmUp: armUp(lm[P.LEFT_WRIST], lm[P.LEFT_ELBOW], lS),
    rightArmUp: armUp(lm[P.RIGHT_WRIST], lm[P.RIGHT_ELBOW], rS),
    lean,
    torsoCenter: shoulders,
    shoulderWidth,
    angles,
    visibility,
    feetVisible,
    floorY: feetVisible ? Math.max(...feet.map((f) => f.y)) : null,
  };
}

/**
 * Detecta agacharse y saltar comparando la altura de los hombros con una línea base
 * que se adapta lentamente (así funciona sin calibrar y aunque el usuario se mueva).
 */
export class PostureTracker {
  private baseline: number | null = null;
  private torso = 0.25;
  private lastY = 0;
  private lastT = 0;
  crouching = false;
  jumping = false;

  update(lm: Landmark[], t: number): { crouching: boolean; jumping: boolean; verticalVelocity: number } {
    const shoulders = mid3(lm[POSE.LEFT_SHOULDER], lm[POSE.RIGHT_SHOULDER]);
    const hips = mid3(lm[POSE.LEFT_HIP], lm[POSE.RIGHT_HIP]);
    const y = shoulders.y;
    const torso = Math.abs(hips.y - shoulders.y);
    if (torso > 0.05) this.torso = this.torso * 0.95 + torso * 0.05;

    const dt = Math.max(t - this.lastT, 1e-3);
    const vy = this.lastT ? (y - this.lastY) / dt : 0;
    this.lastY = y;
    this.lastT = t;

    if (this.baseline === null) this.baseline = y;
    const delta = (y - this.baseline) / this.torso; // >0 = más abajo
    this.crouching = this.crouching ? delta > 0.25 : delta > 0.4;
    this.jumping = this.jumping ? delta < -0.1 : delta < -0.25 && vy < -0.5;
    // La línea base sólo se adapta si el usuario está en postura "normal".
    if (!this.crouching && !this.jumping) this.baseline = this.baseline * 0.98 + y * 0.02;

    return { crouching: this.crouching, jumping: this.jumping, verticalVelocity: vy };
  }

  reset() {
    this.baseline = null;
    this.lastT = 0;
  }
}
