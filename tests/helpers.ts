import type { Vec3 } from '../src/core/math';

export interface HandPose {
  thumb?: 'out' | 'in' | 'up' | 'down' | 'pinch';
  index?: boolean;
  middle?: boolean;
  ring?: boolean;
  pinky?: boolean;
}

/**
 * Mano sintética (21 landmarks, y hacia abajo) con la palma vertical.
 * Tamaño de palma (muñeca → base del medio) = 0.1.
 */
export function makeHand(pose: HandPose): Vec3[] {
  const p = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
  const lm: Vec3[] = new Array(21);
  lm[0] = p(0.5, 0.8);
  const fingers: [number, number, boolean | undefined][] = [
    [5, 0.47, pose.index],
    [9, 0.5, pose.middle],
    [13, 0.53, pose.ring],
    [17, 0.56, pose.pinky],
  ];
  for (const [base, x, extended] of fingers) {
    lm[base] = p(x, 0.7);
    lm[base + 1] = p(x, 0.66);
    lm[base + 2] = extended ? p(x, 0.63) : p(x, 0.68);
    lm[base + 3] = extended ? p(x, 0.6) : p(x, 0.71);
  }
  lm[1] = p(0.45, 0.77);
  switch (pose.thumb ?? 'in') {
    case 'out':
      lm[2] = p(0.42, 0.74); lm[3] = p(0.4, 0.71); lm[4] = p(0.37, 0.68);
      break;
    case 'up':
      lm[2] = p(0.45, 0.74); lm[3] = p(0.45, 0.68); lm[4] = p(0.45, 0.62);
      break;
    case 'down':
      lm[2] = p(0.45, 0.74); lm[3] = p(0.45, 0.8); lm[4] = p(0.45, 0.86);
      break;
    case 'pinch':
      lm[2] = p(0.43, 0.72); lm[3] = p(0.44, 0.66); lm[4] = { ...lm[8], x: lm[8].x - 0.01 };
      break;
    case 'in':
      lm[2] = p(0.46, 0.75); lm[3] = p(0.47, 0.73); lm[4] = p(0.47, 0.72);
      break;
  }
  return lm;
}

/** Rota los puntos alrededor de la muñeca. */
export function rotate(lm: Vec3[], deg: number): Vec3[] {
  const a = (deg * Math.PI) / 180;
  const c = lm[0];
  return lm.map((q) => ({
    x: c.x + (q.x - c.x) * Math.cos(a) - (q.y - c.y) * Math.sin(a),
    y: c.y + (q.x - c.x) * Math.sin(a) + (q.y - c.y) * Math.cos(a),
    z: q.z,
  }));
}
