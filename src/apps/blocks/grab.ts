import type { Vec3 } from '../../core/math';

/**
 * Lógica pura de agarre de bloques. El agarre se decide EN PANTALLA, donde la detección
 * de la mano es precisa; la profundidad (ruidosa) sólo descarta manos claramente delante
 * o detrás del bloque.
 * - Una mano: mano cerrada (puño/pellizco) sobre la caja del bloque en pantalla.
 * - Dos manos / dos brazos: una mano a cada costado del bloque (abrazo/apretón).
 */

/** Velocidad de lanzamiento: la de la mano, limitada para que no salga disparado por ruido. */
export function throwVelocity(v: Vec3, max = 5): Vec3 {
  const s = Math.hypot(v.x, v.y, v.z);
  if (s < 0.15) return { x: 0, y: 0, z: 0 };
  const k = s > max ? max / s : 1;
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

// ───────────── Agarre decidido en pantalla (preciso) ─────────────

export interface ScreenBox {
  id: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Profundidad del bloque (m), para descartar manos claramente delante/detrás. */
  depth: number;
}

export interface ScreenHand {
  x: number;
  y: number;
  depth: number;
}

const inside = (p: ScreenHand, b: ScreenBox, m: number) => p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m;

/** Bloque bajo la mano en pantalla (el de centro más cercano), con un filtro de profundidad tolerante. */
export function screenHover(hand: ScreenHand, boxes: ScreenBox[], margin: number, depthTolerance: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const b of boxes) {
    if (!inside(hand, b, margin) || Math.abs(hand.depth - b.depth) > depthTolerance) continue;
    const d = Math.hypot(hand.x - (b.x0 + b.x1) / 2, hand.y - (b.y0 + b.y1) / 2);
    if (d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
}

/** Abrazo/apretón en pantalla: una mano a cada lado (izquierdo y derecho) del bloque. */
export function screenTwoHandGrab(a: ScreenHand, b: ScreenHand, boxes: ScreenBox[], margin: number, depthTolerance: number): number | null {
  const [l, r] = a.x < b.x ? [a, b] : [b, a];
  for (const box of boxes) {
    const cx = (box.x0 + box.x1) / 2;
    const w = box.x1 - box.x0;
    const sides = l.x < cx - w * 0.15 && r.x > cx + w * 0.15;
    const near = inside(l, box, margin) && inside(r, box, margin);
    const depthOk = Math.abs(l.depth - box.depth) < depthTolerance && Math.abs(r.depth - box.depth) < depthTolerance;
    if (sides && near && depthOk) return box.id;
  }
  return null;
}
