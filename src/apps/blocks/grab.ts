import { dist3, dot3, sub3, type Vec3 } from '../../core/math';

/**
 * Lógica pura de agarre de bloques (en coordenadas locales de la superficie, metros).
 *
 * - Una mano: la mano "cerrada" (puño o pellizco) dentro del bloque o a menos de `margin`
 *   de su superficie (aproximada por su radio envolvente).
 * - Dos manos / dos brazos: las dos manos a los lados OPUESTOS del bloque, ambas a la
 *   distancia de su borde (abrazo/apretón). No hace falta cerrar las manos.
 * - Soltar a dos manos: cuando se separan más de 1.3× el ancho del bloque.
 */
export interface GrabHand {
  id: 'Left' | 'Right';
  pos: Vec3;
  closed: boolean;
}

export interface GrabBlock {
  id: number;
  center: Vec3;
  /** Radio envolvente aproximado (media diagonal del bloque). */
  radius: number;
  /** Medio ancho mínimo (para saber si la mano está "adentro"). */
  inner: number;
}

export function findOneHandGrab(hand: GrabHand, blocks: GrabBlock[], margin: number): number | null {
  if (!hand.closed) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (const b of blocks) {
    const d = dist3(hand.pos, b.center);
    if (d < b.radius + margin && d < bestD) {
      best = b.id;
      bestD = d;
    }
  }
  return best;
}

export function findTwoHandGrab(left: GrabHand, right: GrabHand, blocks: GrabBlock[], margin: number): number | null {
  for (const b of blocks) {
    const dl = dist3(left.pos, b.center);
    const dr = dist3(right.pos, b.center);
    // Cada mano junto al borde del bloque (no lejos, no hundida en el centro).
    const nearL = dl < b.radius + margin && dl > b.inner * 0.5;
    const nearR = dr < b.radius + margin && dr > b.inner * 0.5;
    if (!nearL || !nearR) continue;
    // Lados opuestos: los vectores centro→mano apuntan en sentidos contrarios.
    const opposite = dot3(sub3(left.pos, b.center), sub3(right.pos, b.center)) < -0.3 * dl * dr;
    if (opposite) return b.id;
  }
  return null;
}

export function twoHandReleased(left: Vec3, right: Vec3, blockWidth: number): boolean {
  return dist3(left, right) > blockWidth * 1.3 + 0.05;
}

/** Velocidad de lanzamiento: la de la mano, limitada para que no salga disparado por ruido. */
export function throwVelocity(v: Vec3, max = 5): Vec3 {
  const s = Math.hypot(v.x, v.y, v.z);
  if (s < 0.15) return { x: 0, y: 0, z: 0 };
  const k = s > max ? max / s : 1;
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}
