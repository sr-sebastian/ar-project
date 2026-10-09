import { dist2, type Vec2 } from '../core/math';
import { POSE } from './landmarks';
import type { PerceptionFrame } from './types';

const cross2 = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** ¿Se cruzan los segmentos p1-p2 y q1-q2? */
export function segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = cross2(q1, q2, p1);
  const d2 = cross2(q1, q2, p2);
  const d3 = cross2(p1, p2, q1);
  const d4 = cross2(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Brazos cruzados en X (gesto de "volver"):
 * - Con esqueleto: los antebrazos (codo→muñeca) se cruzan en pantalla, delante del torso
 *   (entre la nariz y las caderas).
 * - Sólo con manos (p. ej. modo mesa): las dos manos con las muñecas cerca y cada una del
 *   lado "contrario" (la izquierda a la derecha de la derecha, según el espejado).
 */
export function armsCrossed(frame: PerceptionFrame): boolean {
  const body = frame.body;
  if (body) {
    const lm = body.landmarks;
    const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.5;
    if ([POSE.LEFT_ELBOW, POSE.LEFT_WRIST, POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST].every(vis)) {
      const crossed = segmentsIntersect(lm[POSE.LEFT_ELBOW], lm[POSE.LEFT_WRIST], lm[POSE.RIGHT_ELBOW], lm[POSE.RIGHT_WRIST]);
      const top = lm[POSE.NOSE].y;
      const bottom = (lm[POSE.LEFT_HIP].y + lm[POSE.RIGHT_HIP].y) / 2;
      const wristsY = (lm[POSE.LEFT_WRIST].y + lm[POSE.RIGHT_WRIST].y) / 2;
      if (crossed && wristsY > top - 0.05 && wristsY < bottom) return true;
    }
  }
  const left = frame.hands.find((h) => h.handedness === 'Left' && h.source !== 'pose');
  const right = frame.hands.find((h) => h.handedness === 'Right' && h.source !== 'pose');
  if (!left || !right) return false;
  const lw = left.landmarks[0];
  const rw = right.landmarks[0];
  // Sin cruzar, con la imagen espejada la mano izquierda queda a la izquierda.
  const swapped = frame.mirrored ? left.palmCenter.x > right.palmCenter.x + 0.02 : left.palmCenter.x < right.palmCenter.x - 0.02;
  return swapped && dist2({ x: lw.x * frame.aspect, y: lw.y }, { x: rw.x * frame.aspect, y: rw.y }) < 0.3;
}
